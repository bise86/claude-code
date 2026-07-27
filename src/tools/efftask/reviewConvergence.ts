/**
 * 让方案评审循环收敛 (spec 2026-07-27 §10)。
 *
 * 用户实际撞到的:
 *
 *   评审迭代超限(3): [main] 评分等级(A/B/C/D)与具体分数的映射规则未定义;
 *                    [main] 维度内多个检查点的分数汇总逻辑缺失;
 *                    [main] 验收标准表述存在逻辑矛盾…
 *
 * 三轮烧完,根节点阻断,整个运行结束 —— 一行代码都还没写。代码层面的成因有两个,都在
 * 这个模块里治:
 *
 *  1. **反馈只带最后一轮**(pipeline 里 `feedback = rec.synthesized.blockingSummary` 每轮
 *     覆盖)。方案作者从来没同时看到过三轮意见,它每次都在打地鼠 —— 第 1 轮的意见在第 2 轮
 *     被改跑偏,第 3 轮又提回来。
 *  2. **评审员单边失明**:reviewPrompt 只吃 `node.plan`,没有 reviewLog、没有轮次号、没有
 *     上一版方案,而 `node.reviewLog` 就挂在同一个对象上。方案作者那边反而有历史。所以
 *     评审员**不可能知道自己在重复**。
 *
 * 全纯函数。数据从已经落盘的 `node.reviewLog` 里读,不新增任何状态。
 */
import type { RoundtableRecord } from './types.js'
import { capText, MAX_SUMMARY_CHARS } from './parseOutput.js'

export interface FeedbackItem {
  /** 意见原文(取自结构化的 verdict.blocking,不是拼接后的字符串)。 */
  text: string
  role: string
  /** 出现在哪几轮,升序。 */
  rounds: number[]
}

/**
 * 判定「同一条意见」的相似度阈值(字符二元组 Jaccard)。
 *
 * 实测数字(归一 + 二元组 Jaccard,见 similarItem 的注释):
 *
 *   同一条改写      0.526   ← **应该**判重复
 *   同模板换语义    0.786   ← **不应该**判重复
 *   同模板换序号    0.733   ← **不应该**判重复
 *   两条不同的意见  0.000 / 0.063
 *
 * 也就是说:该判重复的那条分数**更低**。没有任何阈值能把这两类分开 —— 那需要语义。
 * 0.5 是「能接住真实重复」的位置;代价是同模板换内容也会被判成重复。这个代价之所以
 * 可以接受,唯一的原因是**下游的措辞被写成了「误判也无害」的形状**(见 similarItem
 * 与 reviewRepeatNotice)。改这个值之前先读那两段。
 */
export const SIMILAR_THRESHOLD = 0.5

/** 走「互相包含」这条捷径的最短长度与最小长度比。太短的串包含谁都不算数。 */
export const CONTAIN_MIN_LEN = 8
export const CONTAIN_MIN_RATIO = 0.6

/** 归一:去空白、去中英标点、小写、全角转半角。 */
export function normalizeItem(s: string): string {
  if (typeof s !== 'string') return ''
  return s
    // 全角 → 半角(含全角空格)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .toLowerCase()
    // 中英标点与空白一律丢掉:措辞的差别常常只在这些字符上
    .replace(/[\s`~!@#$%^&*()\-_=+[\]{}\\|;:'",.<>/?·—…、。《》【】「」『』〈〉（）？！：；，]/g, '')
}

function bigrams(s: string): Set<string> {
  const cps = Array.from(s)
  if (cps.length <= 1) return new Set(cps)
  const out = new Set<string>()
  for (let i = 0; i < cps.length - 1; i++) out.add(cps[i]! + cps[i + 1]!)
  return out
}

/**
 * 两条阻断意见是不是同一条。
 *
 * **诚实的边界:字符 n-gram 分不开下面这两种情况。** 实测(归一 + 二元组 Jaccard):
 *
 *   「评分等级与分数的映射规则未定义」 vs 「评分等级到分数的映射规则没有定义」  → 0.53
 *
 * **注意这里用的是简写版。** 用户真实那条带着 `(A/B/C/D)`,把它和上面右边那句比是
 * **判不重复的** —— 也就是说这份文档的招牌例子本身就接不住。调阈值的人别照着这张表推,
 * 它说明的是「该判的分数更低」这个方向,不是「0.5 刚好够用」。
 *   「…返回**超时**时的重试策略与退避算法」 vs 「…返回**错误**时的重试策略与退避算法」 → 0.79
 *
 * 前者是同一条换了说法(**应该**判重复),后者是两条不同的意见(**不应该**判重复),
 * 而后者的相似度反而更高。没有任何阈值能把这两个分开 —— 那需要语义,这里没有。
 *
 * 所以做两件事:
 *  1. 阈值往漏判一侧偏;
 *  2. **下游的措辞被写成「误判也无害」的形状** —— 评审提示词不说「已经提过,若已回应请
 *     判通过」(那是在推着评审员放行),只说「出现过类似表述,请说明它在哪里被回应了,
 *     或者指出方案的哪一句没回应它」。触顶话术两个分支给的也都是「先确认」而不是相反的
 *     指令。这样一次误判最多是多一句废话,不会改变裁决。
 */
interface Prepared { norm: string; grams: Set<string> }

/** 归一 + 建二元组,**一条只做一次**。见 similarItem 上面那段关于 O(n²) 的说明。 */
function prepare(text: string): Prepared {
  const norm = normalizeItem(text)
  return { norm, grams: bigrams(norm) }
}

function similarPrepared(a: Prepared, b: Prepared): boolean {
  const x = a.norm
  const y = b.norm
  // 归一后为空的条目**不参与比较,也不被匹配**。parseOutput 只滤空串,`"   "` 和 `"……"`
  // 活得下来;而空串是任何字符串的子串 —— 不挡的话,一条纯标点的阻断项会把全部意见
  // 合并成一组「连续 N 轮未解决」。
  if (x.length === 0 || y.length === 0) return false
  if (x === y) return true
  // 互相包含:要有长度下限,否则「缺少回滚方案」会把「缺少回滚方案的验证步骤,且回滚
  // 脚本未提供」整条吞掉 —— 那是两条。
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  if (long.includes(short) && short.length >= CONTAIN_MIN_LEN && short.length / long.length >= CONTAIN_MIN_RATIO) {
    return true
  }
  const A = a.grams
  const B = b.grams
  // 便宜的预筛:交集不可能超过较小的那个集合,所以 Jaccard <= min/max。差得太远就不用
  // 遍历了。真实数据里绝大多数比较在这里就结束 —— 而这条函数跑在 O(n²) 的循环里。
  const lo = Math.min(A.size, B.size)
  const hi = Math.max(A.size, B.size)
  if (hi === 0 || lo / hi < SIMILAR_THRESHOLD) return false
  // 遍历小的那个集合,查大的 —— Set.has 是 O(1),但少遍历一半就是少一半的调用。
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  let inter = 0
  for (const g of small) if (big.has(g)) inter++
  const union = A.size + B.size - inter
  return union > 0 && inter / union >= SIMILAR_THRESHOLD
}

/**
 * 两条阻断意见是不是同一条(字符串入口)。
 *
 * **这个函数每调一次都要重建两边的二元组集合。** 放进 O(n²) 的合并循环里实测过:
 * 5 席 × 3 轮 × 20 条,单次 feedbackItems 要 752 ms,而 reviewPrompt 把它放在函数体里
 * → 每个席位各算一遍完全相同的结果 → 一轮 15 次 = **11.3 秒的主线程同步阻塞**,
 * 期间整个界面(含别的节点正在跑的日志窗)不刷新。
 *
 * 所以内部走 prepare/similarPrepared:每条只归一、只建集合一次。这个字符串入口保留给
 * 测试和零星调用。
 */
export function similarItem(a: string, b: string): boolean {
  return similarPrepared(prepare(a), prepare(b))
}

/**
 * 把整份评审记录压成「一条意见 + 它出现在哪几轮」。
 *
 * **从结构化的 verdicts 取,不拆 `blockingSummary`。** synthesizeVerdicts 用 `'; '` 把所有
 * 条目拼成一个字符串,反过来按 `'; '` 切是有损的 —— 意见正文本身就可能含分号(用户这次
 * 撞到的第三条就含冒号和引号)。`reviewLog[].verdicts[].blocking[]` 是已经落盘的结构化
 * 数据,直接读它,零歧义。
 */
export function feedbackItems(log: readonly RoundtableRecord[]): FeedbackItem[] {
  const items: FeedbackItem[] = []
  // 与 items 平行的预处理数组。合并是 O(n²) 的比较,不预处理的话每次比较都要把**两边**
  // 重新归一 + 重建二元组集合 —— 那正是 752 ms 的来源。
  const prep: Prepared[] = []
  for (const rec of log ?? []) {
    if (!rec || !Array.isArray(rec.verdicts)) continue
    for (const v of rec.verdicts) {
      // infra 失败不是意见:那一席根本没有对方案做出任何判断。把「角色调用失败」混进
      // 反馈里,方案作者会去「修」一个网络问题。
      if (v?.infra === true) continue
      for (const raw of v?.blocking ?? []) {
        if (typeof raw !== 'string') continue
        const text = raw.trim()
        const p = prepare(text)
        if (p.norm.length === 0) continue
        const at = prep.findIndex(q => similarPrepared(q, p))
        if (at >= 0) {
          const hit = items[at]!
          if (!hit.rounds.includes(rec.round)) hit.rounds.push(rec.round)
          continue
        }
        items.push({ text, role: v.role ?? 'main', rounds: [rec.round] })
        prep.push(p)
      }
    }
  }
  for (const it of items) it.rounds.sort((a, b) => a - b)
  return items
}

/**
 * 在**不止一轮**里出现过的意见 —— 「方案一直没回应」的那些。
 *
 * 名字里没有「连续」,输出里也不该有。第一版把它叫「连续 N 轮未解决」,而这里数的是
 * **出现次数**:rounds=[1,3](第 2 轮没提)会被报成「连续 2 轮」。给方案作者的提示词里
 * 说假话,和这个仓库反复在修的那一类是同一件事。真要说「连续」就得算最长连续段,
 * 而那个数对作者没有额外价值 —— 他要知道的是「这条你被提了几次、分别在第几轮」。
 */
export function stuckItems(items: readonly FeedbackItem[], minRounds = 2): FeedbackItem[] {
  return items.filter(it => it.rounds.length >= Math.max(2, minRounds))
}

/**
 * 一次最多列多少条,以及整段的字符预算。
 *
 * 这两个上限不是保险丝,是**必需**的。单条阻断意见的上限是 2000 字(parseOutput 的
 * MAX_BLOCKING_CHARS),每席最多 20 条,5 席 × 3 轮 = 300 条 —— 不设上限的话,这一段能把
 * 方案提示词顶到 600 KB。原来的 `blockingSummary` 走的是 synthesizeVerdicts 里的
 * capText(…, MAX_SUMMARY_CHARS),换成累积反馈时如果不接上同一个预算,就是**绕过**了它。
 *
 * 裁剪时**老账优先**:那几条才是作者一直没回应的东西,新增的下一轮还会再提。
 * 丢了多少要说出来 —— 这个仓库反复在修的就是「残缺的视图看起来完完整整」。
 */
export const MAX_FEEDBACK_ITEMS = 20

/**
 * 单条意见在这一段里的字符预算。
 *
 * 光有条数上限不够:单条阻断意见本身可以有 2000 字(MAX_BLOCKING_CHARS),20 条就是
 * 40000 字,整段的 capText 会在第二条就把后面全砍掉 —— 连「另有 N 条未列出」那句话
 * 一起砍掉。于是用户看到的是一份**看起来完整**的两条清单。每条各自先缩,20 条才装得进
 * 一段预算里,而且是**均匀**地缩,不是砍掉后 18 条。
 *
 * 原文一个字都没丢:它在 node.md 的评审记录里,提示语也是这么写的。
 */
export const MAX_ITEM_CHARS = 160

const bullet = (it: FeedbackItem, i: number): string =>
  `  ${i + 1}. [${it.role}] (第 ${it.rounds.join('、')} 轮) ${capText(it.text, MAX_ITEM_CHARS)}`

/** 按「老账优先」裁到 MAX_FEEDBACK_ITEMS,返回被裁掉的条数。 */
function trim(stuck: FeedbackItem[], fresh: FeedbackItem[]): { stuck: FeedbackItem[]; fresh: FeedbackItem[]; dropped: number } {
  const total = stuck.length + fresh.length
  if (total <= MAX_FEEDBACK_ITEMS) return { stuck, fresh, dropped: 0 }
  const keepStuck = stuck.slice(0, MAX_FEEDBACK_ITEMS)
  const keepFresh = fresh.slice(0, Math.max(0, MAX_FEEDBACK_ITEMS - keepStuck.length))
  return { stuck: keepStuck, fresh: keepFresh, dropped: total - keepStuck.length - keepFresh.length }
}

/**
 * 给**方案作者**的累积反馈。
 *
 * 取代「只带最后一轮的拼接串」。分成两组是关键:作者要能一眼看出哪几条是它连着几轮没
 * 回应的老账 —— 那正是它一直在打地鼠的原因。
 */
export function planFeedbackPrompt(items: readonly FeedbackItem[]): string {
  if (items.length === 0) return ''
  const rounds = Math.max(...items.flatMap(i => i.rounds), 0)
  const allStuck = stuckItems(items)
  const cut = trim(allStuck, items.filter(it => !allStuck.includes(it)))
  const parts: string[] = [
    `前 ${rounds} 轮评审共提出 ${items.length} 条阻断意见,按轮次汇总如下` +
      (cut.dropped > 0 ? `(只列其中 ${MAX_FEEDBACK_ITEMS} 条,另有 ${cut.dropped} 条未列出,全文见 node.md 的评审记录)` : '') +
      '。',
  ]
  if (cut.stuck.length > 0) {
    parts.push(
      `【被提过不止一轮,至今没有被回应】` +
        '必须逐条明确回应:要么在方案里解决,要么写明为什么不适用。',
      ...cut.stuck.map(bullet),
    )
  }
  if (cut.fresh.length > 0) {
    // 不是「本轮新增」:fresh 的判据是「只出现过一轮」,那一轮可能是第 1 轮。第 4 轮
    // 构造提示词时,三条分别只在第 1/2/3 轮出现过的意见会被全部标成「本轮新增」。
    parts.push('【只被提过一轮】', ...cut.fresh.map(bullet))
  }
  return capText(parts.join('\n'), MAX_SUMMARY_CHARS)
}

/**
 * 给**评审员**的重复提示。
 *
 * 措辞是刻意中立的。写成「以下意见已经提过,若新方案已回应请判通过」会直接推着评审员
 * 放行 —— 而相似度判定**会误判**(见 similarItem),把一条第一次提出的意见谎报成老账,
 * 那就是在用一句假话换一个通过。这里只要求它**说清楚**,不替它下结论。
 */
export function reviewRepeatNotice(items: readonly FeedbackItem[], round: number): string {
  if (round <= 1 || items.length === 0) return ''
  const seen = items.filter(it => it.rounds.length > 0)
  if (seen.length === 0) return ''
  // 同一个预算,理由同 planFeedbackPrompt:这一段进的是**每一个评审席位**的提示词,
  // 5 席就是 5 份。
  const shown = seen.slice(0, MAX_FEEDBACK_ITEMS)
  const dropped = seen.length - shown.length
  return capText([
    `本轮是第 ${round} 轮评审。前几轮已经提出过下面这些意见` +
      (dropped > 0 ? `(只列 ${MAX_FEEDBACK_ITEMS} 条,另有 ${dropped} 条未列出)` : '') +
      '(按出现轮次标注):',
    ...shown.map((it, i) => `  ${i + 1}. [${it.role}] (第 ${it.rounds.join('、')} 轮) ${capText(it.text, MAX_ITEM_CHARS)}`),
    '对其中每一条:若新方案已经回应了它,请指出是方案的哪一句回应的;若仍未回应,请指出',
    '方案缺了什么。不要仅因为措辞眼熟就放行,也不要把同一条换个说法再提一遍。',
  ].join('\n'), MAX_SUMMARY_CHARS)
}

/**
 * 触顶时写进 blockedReason 的那句话。
 *
 * 原来是把最后一轮的拼接串原样贴上。它答不了用户真正的问题 —— **哪几条是一直没解决的**。
 */
export function exhaustionReason(items: readonly FeedbackItem[], max: number): string {
  const head = `评审迭代超限(${max})`
  if (items.length === 0) return head
  const allStuck = stuckItems(items)
  const cut = trim(allStuck, items.filter(it => !allStuck.includes(it)))
  const seg: string[] = []
  if (cut.dropped > 0) seg.push(`共 ${items.length} 条,以下只列 ${MAX_FEEDBACK_ITEMS} 条`)
  if (cut.stuck.length > 0) {
    seg.push(`被提过不止一轮、至今未解决 ${allStuck.length} 条 —— ` +
      cut.stuck.map(it => `[${it.role}] (第 ${it.rounds.join('、')} 轮) ${capText(it.text, MAX_ITEM_CHARS)}`).join('; '))
  }
  if (cut.fresh.length > 0) {
    seg.push(`只被提过一轮 ${items.length - allStuck.length} 条 —— ` +
      cut.fresh.map(it => `[${it.role}] ${capText(it.text, MAX_ITEM_CHARS)}`).join('; '))
  }
  // 这句会原样进 node.blockedReason,而 blockedReason 又会被卡片和树引用 —— 它是
  // node.md 体积的第二大来源,预算和 blockingSummary 用同一个。
  return capText(`${head}: ${seg.join(';')}`, MAX_SUMMARY_CHARS)
}

/**
 * 触顶时给的下一步。按**事实**分叉,而不是一句放之四海皆准的话。
 *
 * 两个分支给的都是「先确认…再决定」而不是相反的指令 —— 因为相似度判定会误判(见
 * similarItem),而在运行刚被打死那一刻给出方向相反的行动建议,比不给建议更糟。
 */
export function exhaustionRemedy(items: readonly FeedbackItem[]): string {
  const stuck = stuckItems(items)
  if (stuck.length === 0) {
    return '每一轮的意见都不一样,说明评审在持续扩大范围。可以提高 run.md 里的 caps.maxIterations 让它多谈几轮,' +
      '或者收紧验收点、缩小这一节点的范围后重试。'
  }
  return `有 ${stuck.length} 条意见被提过不止一轮。先确认方案是不是真的回应了它们:` +
    '若确已回应而评审没看见,提高 run.md 里的 caps.maxIterations 让评审继续;' +
    '若确实没回应,单纯加轮次大概率还是同样的结论 —— 先把这几条写进需求或补充说明,再用 ' +
    '`/et --resume <运行ID> --retry-blocked <补充说明>` 重试。'
}
