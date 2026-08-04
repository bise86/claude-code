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
import type { PhaseName, RoundtableRecord } from './types.js'
import { STRICTNESS_LEVELS, type Strictness } from './strictness.js'
import { capText, MAX_BLOCKING_CHARS, MAX_SUMMARY_CHARS } from './parseOutput.js'

export interface FeedbackItem {
  /** 意见原文(取自结构化的 verdict.blocking,不是拼接后的字符串)。 */
  text: string
  role: string
  /** 出现在哪几轮,升序。 */
  rounds: number[]
  /**
   * 这条意见被提出时所处的**最严**那一档(跨轮取最严)。没设档位的记录不参与。
   *
   * 为什么必须有:档位可以在运行中调,而这一段历史会被原样铺进后续每一轮的提示词,
   * 后面跟着一条**无条件的追责指令**(「若仍未回应,请指出缺了什么」)。降档之后,它会
   * 逼着中级档的评审员把一条只在专家档下才算阻断的意见重新提成 blocking —— 降档等于
   * 没降,而且是静默的。取**最严**而不是最后一次:要提醒的是「这条当初的门槛比现在高」。
   */
  strictness?: Strictness
}

/** 档位的严格度序。`undefined`(没设档)不参与比较 —— 见 `strictness.ts` 对它的说明。 */
function stricterOf(a: Strictness | undefined, b: Strictness | undefined): Strictness | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return STRICTNESS_LEVELS.indexOf(a) >= STRICTNESS_LEVELS.indexOf(b) ? a : b
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
 * 5 席 × 3 轮 × 20 条,单次 feedbackItems 在**没有预处理**的那一版要 752 ms(现在
 * 是 8~92 ms,见下面 prepare 的注释),而 reviewPrompt 把它放在函数体里
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
  // 重新归一 + 重建二元组集合 —— 那正是 752 ms 的来源。预处理之后同一份输入是
  // **8~92 ms**(200 字 / 2000 字两档,评审复测)。O(n²) 还在,只是常数被压掉了一个量级;
  // 「一轮算一次而不是一席算一次」那条规矩仍然成立,但它现在防的是浪费,不是卡死。
  const prep: Prepared[] = []
  /**
   * 本次日志里所有**被撤回**的意见,连同撤回发生在第几轮(见 `Verdict.retracted`)。
   *
   * 为什么带轮次:撤回只对**撤回之前**提出的那些成立。一条在第 2 轮被撤回、第 3 轮由另一位
   * 席位重新提出的意见,是一条**新的**意见 —— 它带着新的证据。不比轮次的话,第 2 轮那次
   * 撤回会把它永久压掉,而「永久」正是撤回不该有的力度:那等于给了任何一席一票否决全部
   * 后续同类意见的权力。
   *
   * **必须是独立的一趟前置扫描,不能和下面那趟合起来。** 撤回按定义发生在被撤那条**之后**
   * 的某一轮,所以边走边收集时,第 1 轮的条目是在第 2 轮的撤回被读到之前就建好的 —— 判据
   * 恒为假,整个字段静默失效。第一版就是这么写的,三条用例同时红。
   */
  const retractions: { prep: Prepared; round: number; step?: PhaseName }[] = []
  for (const rec of log ?? []) {
    if (!rec || !Array.isArray(rec.verdicts)) continue
    for (const v of rec.verdicts) {
      // infra 那一席什么都没判过,它的 retracted 不可能有内容;和下面滤 blocking 同一条理由。
      if (v?.infra === true) continue
      for (const raw of v?.retracted ?? []) {
        if (typeof raw !== 'string') continue
        const p = prepare(raw.trim())
        if (p.norm.length === 0) continue
        // step 要跟着走,理由与 `crossSeatNotice` 的分组键逐字相同 —— 见下面那条判据。
        retractions.push({ prep: p, round: rec.round, step: rec.step })
      }
    }
  }
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
        /**
         * 被**后来某一轮**撤回的这一次提出,整条跳过。
         *
         * 判据落在「这一次提出」而不是「这条意见」上,是拿一条测试换来的:同一条意见在
         * 第 1 轮提出、第 2 轮被撤回、第 3 轮由另一席带着新证据重新提出时,`items` 会把
         * 三次合并成一条。按「整条」判的话,那条的 `rounds` 会是 `[1、3]` —— 于是它落进
         * `stuckItems`,被报成「被提过不止一轮,至今没有被回应」,而第 1 轮那次**已经作废了**。
         * 一条撤回过的账重新变成老账,正是撤回要治的那件事。
         *
         * 轮次比较不能省:撤回只对**撤回之前**提出的成立。不比的话,第 2 轮那次撤回会把
         * 第 3 轮重新提出的同一条永久压掉 —— 那等于给任何一席一票否决全部后续同类意见。
         */
        /**
         * 判据里的 `r.step === rec.step` 和轮次比较**同等必要**,而这是拿一条验收换来的。
         *
         * 测试验证与验收共用 `acceptLog`、两关各自计数(`gateRound` 按 step 过滤后 +1),
         * 所以只比 `round` 时会发生两件都不该发生的事:
         *  - **跨关撤回**:verify 第 2 轮的一次撤回,把 accept 第 1 轮提的意见压掉 ——
         *    一个测试验证席位撤掉了验收关的账,而它从来没看过那一关的判据;
         *  - **撤未来的账**:verify 已经跑到第 3 轮时,accept 第 1 轮**刚提出**的意见
         *    因为 1 < 3 当场消失,而它在时间上是最新的。
         * 两条都实测复现过。`crossSeatNotice` 那边的分组键是同一个理由。
         */
        if (retractions.some(r => r.step === rec.step && r.round > rec.round && similarPrepared(r.prep, p))) continue
        const at = prep.findIndex(q => similarPrepared(q, p))
        if (at >= 0) {
          const hit = items[at]!
          if (!hit.rounds.includes(rec.round)) hit.rounds.push(rec.round)
          // 同一条意见跨轮跨档时取**最严**的那一档,理由见 FeedbackItem.strictness。
          const s = stricterOf(hit.strictness, rec.strictness)
          if (s !== undefined) hit.strictness = s
          continue
        }
        items.push({
          text, role: v.role ?? 'main', rounds: [rec.round],
          ...(rec.strictness !== undefined ? { strictness: rec.strictness } : {}),
        })
        prep.push(p)
      }
    }
  }
  for (const it of items) it.rounds.sort((a, b) => a - b)
  return items
}

/**
 * 「本轮不止一个席位提了意见,而它们之间没有经过统一」—— 给**方案作者 / 执行者**的提醒。
 *
 * ## 它治的是什么
 *
 * 用户实测到的那次运行:第 1 轮两位评审各自提出一条阻断意见,而**两条要求互斥**——
 * 一位要求把某个数字改成 7,另一位要求改成 13,而正确答案是 14。作者照着其中一条改了
 * (那在系统看来完全是「响应了阻断意见」),于是第 2 轮整轮被用来修评审员自己造的错数。
 * 三轮的迭代上限,两轮花在这上面。
 *
 * 圆桌的席位是**并行**的,互相看不见彼此的裁决(见 `runRoundtable`),`synthesizeVerdicts`
 * 也只是把各席的 blocking 用 `'; '` 拼起来 —— 全流程没有任何一处会发现两条要求互斥。
 * 作者拿到的是一串并列的要求,而最省力的路径就是挑一条照做。
 *
 * ## 为什么不做自动检测
 *
 * 试过,砍掉了。用「祈使词 + 数字」正则加 ASCII 标识符锚点做配对,评审实测 **5 组正常
 * 意见 5 组全部误报**(「子任务改为 3 个」vs「超时改为 30 秒」、版本号、行号、quorum vs
 * 席位数、日期 vs 迭代上限)—— 因为锚点靠的是 `api`/`proto`/`pipeline.ts` 这类在单一项目里
 * 几乎必然共现的 token。而漏报另有四类(无祈使词的断言式、中文数字、无 ASCII 锚点的纯
 * 中文冲突、版本号在小数点处截断)。命中面窄、误报面宽,方向是反的。
 *
 * 靠既有的相似度归组也不行:那两条真实意见的二元组 Jaccard 实测 **0.1471**,而
 * `SIMILAR_THRESHOLD` 是 0.5;把阈值降到 0.15 **仍然接不住**(0.1471 < 0.15),要降到 0.147
 * 以下 —— 那等于把 `feedbackItems` 的合并判据整个废掉。
 *
 * (这个数是对**未截断的完整原文**算的,原文在事故那台机器的 node.md 里、不在本仓库。
 * `factEvidence.test.ts` 里那两个常量是**摘首句**,拿它们复算得到的是 0.1215 —— 两个数
 * 都真,量的不是同一份输入。验收核对时踩过这一脚,所以写在这里。)
 *
 * 所以这里只报**事实**(有几席各自提了意见),把「哪两条互斥」留给读得懂内容的那一方。
 * 一句无条件的提醒接得住全部形态,而且没有误报可言。
 */
export function crossSeatNotice(log: readonly RoundtableRecord[]): string {
  const recs = (log ?? []).filter(r => r && Array.isArray(r.verdicts))
  const last = recs[recs.length - 1]
  if (!last) return ''
  /**
   * 只看**最后一条记录所属的那一组**,而分组键是 `(step, round)` 不是 `round`。
   *
   * 单独用 `round` 在执行侧的调用点上是错的:测试验证与验收**共用 `acceptLog`**,而两关
   * 各自计数(`gateRound` 按 step 过滤后 +1),所以同一个 `round` 数会同时出现在两关的记录上。
   * 只按 round 分组时,verify 第 2 轮和 accept 第 2 轮会被当成同一场圆桌 —— 而它们是两个
   * 关口、两批不同的席位,两边的要求本来就都该做。那会凭空造出一句「本轮有 2 个席位各自
   * 提了意见,它们没有经过统一」,而这句话是假的。
   *
   * 取「最后一条记录」而不是「round 最大的那一组」,同样是因为两关的编号互不可比:
   * verify 跑到第 3 轮而 accept 才第 1 轮时,时间上最新的是 accept 那条。日志是追加写的,
   * 最后一条就是最新的那一场。
   */
  const seats = new Set<string>()
  for (const rec of recs) {
    if (rec.round !== last.round || rec.step !== last.step) continue
    for (const v of rec.verdicts) {
      // infra = 这一席的调用没打通,它没有对工作做出任何判断 —— 不算一个「提了意见的席位」。
      if (v?.infra === true) continue
      if ((v?.blocking ?? []).some(b => typeof b === 'string' && b.trim().length > 0)) {
        seats.add(v.role ?? 'main')
      }
    }
  }
  if (seats.size < 2) return ''
  return `本轮有 ${seats.size} 个席位各自提了阻断意见,它们之间**没有经过统一**,可能互相矛盾。\n` +
    `先通读全部条目再动手:两条要求把同一处改成不同的样子时,**不要挑一条照做** ——\n` +
    `自己取证,按核实结果改,并写明你跑了什么、为什么另一条不成立。`
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

/**
 * 这一段实际能给**每条**多少字 —— 按条数**均分**,不是写死 160。
 *
 * ## 为什么必须动态
 *
 * 验收实测,而且实测的正是这次事故本身。事故第 1 轮那两条阻断意见分别是 406 字和 276 字,
 * 而它们互斥的落点(「将 E 改为 13 个」「统一修正为实际值 7」)都在**尾部**。按 160 字砍完,
 * 作者真正拿到的是:
 *
 *   1. [总监] proto 归属与计数矛盾:api/ 下实际只有 7 个 .proto…(已截断,原文 406 字)
 *   2. [架构] proto 数量事实错误且与验收E冲突。但实测 /home/…(已截断,原文 276 字)
 *
 * 两条要求的**数字一个都没进来**。于是 `crossSeatNotice` 那句「两条要求把同一处改成不同的
 * 样子时不要挑一条照做」指着一份**看不出矛盾**的清单说话 —— 正文里唯一残存的诉求还都指向 7。
 * 提醒在场、依据被截掉,那不是修好了,那是把病换了个位置。
 *
 * ## 为什么均分是对的
 *
 * `MAX_ITEM_CHARS = 160` 从来不是「一条意见需要多少字」的判断,它是「20 条塞进 4000 字预算」
 * 的算术下界(见那个常量原来的注释:「而且是**均匀**地缩,不是砍掉后 18 条」)。条数少的时候
 * 按下界发钱,等于把预算白白扔掉:2 条时每条能给 1800 字,两条原文都装得下。
 *
 * 上界是 `MAX_BLOCKING_CHARS`(单条阻断意见本身的上限),再多也没有内容可发。
 * 下界保持 `MAX_ITEM_CHARS`,所以 20 条满载时的行为与改动前一致。
 */
export function itemBudget(n: number): number {
  // 预留给抬头、分组标题、以及「另有 N 条未列出」那句 —— 不预留的话满载时正文会挤掉它们。
  const RESERVE = 600
  const share = Math.floor((MAX_SUMMARY_CHARS - RESERVE) / Math.max(1, n))
  return Math.min(MAX_BLOCKING_CHARS, Math.max(MAX_ITEM_CHARS, share))
}

const bullet = (budget: number) => (it: FeedbackItem, i: number): string =>
  `  ${i + 1}. [${it.role}] (第 ${it.rounds.join('、')} 轮) ${capText(it.text, budget)}`

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
export function planFeedbackPrompt(
  items: readonly FeedbackItem[],
  /**
   * 这些意见是**哪一关**提的。默认「评审」——方案圆桌,这个模块最初的唯一调用方。
   *
   * 参数化而不是复制一份:执行返工循环(测试验证 / 验收)撞的是**同一个病**,而且是
   * 更贵的那一份 —— 那一侧每一轮都要付一次带写工具的执行调用。而「打地鼠」的成因逐字
   * 相同:反馈只带最后一轮,于是第 1 轮的意见在第 2 轮被改跑偏,第 3 轮又被提回来。
   * 两份实现意味着第二次踩同一组坑,而这里唯一真正不同的只有这个名词。
   */
  label = '评审',
  /**
   * 排在条目清单**前面**的一段提醒(目前只有 `crossSeatNotice`)。
   *
   * **它在 `capText` 之外,并且从条目的额度里扣掉自己的长度。** 这不是讲究,是实测:
   * 满载 20 条时这个函数的输出是 **4016 字**,而 `MAX_SUMMARY_CHARS` 是 4000 —— 余量是
   * **负的**。把提醒拼进 `parts` 再一起截,截掉的就是清单**末尾的真实意见**,而抬头那句
   * 「只列其中 20 条,另有 N 条未列出」是在裁剪之前算的,于是它会谎报仍列着 20 条。
   * 这个仓库反复在修的就是「残缺的视图看起来完完整整」。
   */
  notice = '',
): string {
  if (items.length === 0) return ''
  const rounds = Math.max(...items.flatMap(i => i.rounds), 0)
  const allStuck = stuckItems(items)
  const cut = trim(allStuck, items.filter(it => !allStuck.includes(it)))
  // 每条能给多少字,按**实际列出的条数**均分 —— 见 `itemBudget`。写死 160 时,事故里那两条
  // 互斥要求的落点全在被截掉的尾巴里,而这一整段正是为了让作者看出它们互斥。
  const line = bullet(itemBudget(cut.stuck.length + cut.fresh.length))
  const parts: string[] = [
    `前 ${rounds} 轮${label}共提出 ${items.length} 条阻断意见,按轮次汇总如下` +
      (cut.dropped > 0 ? `(只列其中 ${MAX_FEEDBACK_ITEMS} 条,另有 ${cut.dropped} 条未列出,全文见 node.md 的评审记录)` : '') +
      '。',
  ]
  if (cut.stuck.length > 0) {
    parts.push(
      `【被提过不止一轮,至今没有被回应】` +
        '必须逐条明确回应:要么在方案里解决,要么写明为什么不适用,' +
        /**
         * 第三个出口。**没有它,一条错误的意见就只剩「照做」这一条路。**
         *
         * 用户实测那次:第 1 轮两位评审要求把同一个数字分别改成 7 和 13(正确值是 14)。
         * 作者手上只有「解决」和「不适用」两个选项,而「不适用」答的是「这条不适用于本方案」,
         * 不是「这条本身是错的」。于是它挑了一条照做 —— 完全服从了阻断意见,却把方案改错了。
         *
         * 要求附**范围**而不只是命令与输出,是拿一条评审意见换来的:一个只跑了
         * `find api/ -name '*.proto'` 的作者附上命令和输出都属实,而它的结论(全仓总数是 7)
         * 仍然是错的 —— 错就错在命令覆盖的范围够不着它要否定的那句话。裁决侧核的正是这一维
         * (见 pipeline.ts 的 `REBUTTAL_RULE`),这里必须把它要出来。
         */
        '要么**举证指出这一条的事实前提有误**(附你跑的命令与原始输出,以及命令覆盖的范围)。',
      ...cut.stuck.map(line),
    )
  }
  if (cut.fresh.length > 0) {
    // 不是「本轮新增」:fresh 的判据是「只出现过一轮」,那一轮可能是第 1 轮。第 4 轮
    // 构造提示词时,三条分别只在第 1/2/3 轮出现过的意见会被全部标成「本轮新增」。
    /**
     * 措辞要和老账那组**一样硬**,而这是拿一条验收换来的。
     *
     * 原来这里只有一句压缩的「(同样是三选一…)」,不要求附命令、输出、范围。而事故里那两条
     * 互斥的错误意见**都是第 1 轮提出的** —— 也就是说它们走的正是这一组:举证要求最该落地的
     * 地方,措辞最松。
     */
    parts.push(
      '【只被提过一轮】同样逐条回应,三选一:在方案里解决 / 写明为什么不适用 / ' +
        '**举证指出这一条的事实前提有误**(附命令与原始输出,以及命令覆盖的范围)。',
      ...cut.fresh.map(line),
    )
  }
  // 提醒在截断之外,条目在截断之内,而且条目的额度要把提醒的长度扣掉 —— 见 `notice` 的注释。
  // 下限 1 而不是 0:`capText(s, 0)` 会退化成一个只剩标记的字符串,那比截断更难读。
  const head = notice ? notice + '\n' : ''
  return head + capText(parts.join('\n'), Math.max(1, MAX_SUMMARY_CHARS - head.length))
}

/**
 * 给**评审员**的重复提示。
 *
 * 措辞是刻意中立的。写成「以下意见已经提过,若新方案已回应请判通过」会直接推着评审员
 * 放行 —— 而相似度判定**会误判**(见 similarItem),把一条第一次提出的意见谎报成老账,
 * 那就是在用一句假话换一个通过。这里只要求它**说清楚**,不替它下结论。
 */
export function reviewRepeatNotice(
  items: readonly FeedbackItem[],
  round: number,
  /**
   * 这是哪一关的圆桌。默认「评审」(方案圆桌)。
   *
   * 测试验证 / 验收 / 集成验收三关此前**一条历史都看不到**:每一轮都拿着同一份产出
   * 从零开一次会,于是最容易发生的事就是每轮换一批新要求 —— 执行者改完上一轮的,
   * 这一轮又被别的理由挡回去,直到迭代耗尽。方案那一侧早就治过这个病(见文件头),
   * 这里只是把同一份药给另外三关。
   */
  label = '评审',
  /**
   * 这一关判的是**什么东西**。默认「方案」;执行侧那三关判的是这一版产出。
   *
   * 必须跟着 label 一起换,否则测试验证员会读到「若新**方案**已经回应了它,请指出是
   * 方案的哪一句回应的」—— 而它手上根本没有方案要评,它在跑测试。一句和场景对不上的
   * 指令,模型要么忽略它(白花 token),要么真的去评方案(那一关就废了)。
   */
  subject = '方案',
  /**
   * 本轮的严格度。历史条目里档位与它**不同**的会被标注,并追加一段限定语。
   *
   * 省略 = 没设档位 = **跨档限定语那一段**不渲染。
   *
   * (原来这里写的是「与引入档位之前逐字相同的输出」。那句话现在是假的:本函数后来又加了
   * 两段与档位无关的文字 —— 举证反驳的限定语、以及跨席位互斥的提醒。逐字相同这条承诺只在
   * `strictness.ts` 的那几个函数上成立,不在这里。)
   */
  now?: Strictness,
): string {
  if (round <= 1 || items.length === 0) return ''
  const seen = items.filter(it => it.rounds.length > 0)
  if (seen.length === 0) return ''
  // 同一个预算,理由同 planFeedbackPrompt:这一段进的是**每一个评审席位**的提示词,
  // 5 席就是 5 份。
  const shown = seen.slice(0, MAX_FEEDBACK_ITEMS)
  const dropped = seen.length - shown.length
  /**
   * 只在与本轮**不同**时标 —— 相同就是噪声,而这一段是 per-seat 计费的。
   *
   * 两边都得有值才比:`undefined` 是「没设档位」,它和任何一档都不构成「跨档」——
   * 那是引入本特性之前的全部历史,给它扣一顶「/undefined 档」的帽子只会让模型困惑。
   */
  const mark = (it: FeedbackItem): string =>
    it.strictness !== undefined && now !== undefined && it.strictness !== now ? ` /${it.strictness}档` : ''
  const crossed = shown.some(it => mark(it).length > 0)
  return capText([
    `本轮是第 ${round} 轮${label}。前几轮已经提出过下面这些意见` +
      (dropped > 0 ? `(只列 ${MAX_FEEDBACK_ITEMS} 条,另有 ${dropped} 条未列出)` : '') +
      '(按出现轮次标注):',
    // 同样按条数均分,理由见 `itemBudget` —— 而这一段尤其不能截:下面 3c 那句要求裁决员
    // 「找出两条来自不同席位、对同一处给出不同值的意见」,写死 160 字时那些值正好在尾巴里。
    ...shown.map((it, i) => `  ${i + 1}. [${it.role}] (第 ${it.rounds.join('、')} 轮${mark(it)}) ${capText(it.text, itemBudget(shown.length))}`),
    `对其中每一条:若新${subject}已经回应了它,请指出是${subject}的哪一处回应的;若仍未回应,请指出`,
    `${subject}缺了什么。不要仅因为措辞眼熟就放行,也不要把同一条换个说法再提一遍。`,
    /**
     * 对上面那句无条件追责的**第一条限定**:作者举证反驳掉的那些不算「未回应」。
     *
     * 排在它后面,和下面的跨档限定语同一条规矩(见那一段) —— 这是对它的限定,不是并列的新规则。
     *
     * 为什么必须有:第三个出口(见 `planFeedbackPrompt` 里那句「举证指出这一条的事实前提
     * 有误」)只有在裁决侧被接住才成立。作者举证的那一轮,这条意见**还在**历史清单里
     * (`retracted` 要等这一轮的裁决写下来才生效),而它后面跟着的正是那句无条件的
     * 「若仍未回应,请指出缺了什么」—— 不限定的话,一个照着读的裁决员会把「作者反驳了我」
     * 直接读成「作者没回应」,第三个出口当场作废。
     *
     * 措辞仍然**不推着放行**:说的是「按结论核」,不是「作者说错了就算错了」。
     */
    `其中若${subject === '方案' ? '作者' : '执行者'}举证说某一条的**事实前提有误**,不要把它当成「未回应」——` +
      `按它给的命令与覆盖范围核那条结论成不成立,核出来是你(或同僚)那条错了,就写进 "retracted"。`,
    /**
     * 跨档限定语。
     *
     * 上面那句「若仍未回应,请指出缺了什么」是**无条件**的,所以降档之后它会逼着评审员
     * 把一条只在更严档位下才算阻断的意见重新提成 blocking。这一段是对它的限定,不是
     * 一条并列的新规则 —— 所以必须排在它**后面**。
     *
     * 升档方向一并覆盖:那一半同样需要说清,否则「档位提高了所以我这次要求更多」看起来
     * 就是「换一个角度再挑一遍」,而后者正是上面那句话禁止的事。
     */
    ...(crossed
      ? [
        `上面标了档位的那几条,是在与本轮不同的严格度下提出的;本轮是**${now}**档。对它们:`,
        `先按**本轮**判据重新掂量 —— 仍然落在本轮 blocking 范围内的,照旧要求${subject}回应;`,
        `只有在更严的档位下才算阻断的,写进 comments 并注明「按本轮档位不阻断」。反过来,本轮`,
        `档位更严时可以就同一处提出更高的要求,但要写明是因为档位提高了。`,
        `**不要因为它出现过就沿用上一轮的结论,也不要因为降了档就当它没出现过。**`,
      ]
      : []),
    /**
     * **让裁决员看见自己和同僚互斥** —— 这是那次事故真正的病根,而修它几乎不要钱。
     *
     * 上面那份清单早就带着 `[role]` 标签把**全部席位**的历史意见铺给每一席了,数据一直在场;
     * 缺的只是一句「看到了之后该怎么办」。用户实测那次:第 1 轮两位评审要求把同一个数字
     * 分别改成 7 和 13(正确值 14),而圆桌的席位是并行的、互相看不见 —— 所以最早能发现
     * 互斥的时刻**就是第 2 轮**,也就是这一段渲染的时刻。第 2 轮真的有一位评审自己发现了
     * (「上一版方案的 14 恰好是正确的全仓总数」),但那是碰运气,没有任何一句话要求它去看。
     *
     * 只在条目跨 ≥2 个席位时出现:单席位的历史里不存在「不同席位互斥」这回事,那时这一段
     * 是纯噪声 —— 而它进的是**每一个**席位的提示词。
     *
     * 排在最后,不打断上面两条限定语与那句无条件追责的相邻关系:它是一条**并列的**新指令
     * (讲的是清单内部的矛盾),不是对那句话的限定。
     */
    ...(new Set(shown.map(it => it.role)).size >= 2
      ? [
        `上面若有两条来自**不同席位**、对同一处给出了不同的值或不同的改法,先把它解决掉再判本轮:`,
        `自己取证确定哪个对(**两个都可能是错的**)。`,
        /**
         * 落点必须点名 blocking / retracted,**不能是 comments**,而这是拿一条验收换来的。
         *
         * 草案这里写的是「在 comments 里写明你核的结果」。验收拿事故日志实证了那是一条死路:
         * `synthesizeVerdicts` 只在「pass 为 false 且 blocking 为空」时才回落到 comments,
         * 而 `feedbackItems` **只读 `v.blocking`** —— 一个判 pass 的裁决员把核出来的正确值
         * 写进 comments,作者永远看不到。
         *
         * 事故里这一幕真的发生过:第 2 轮架构席 `pass:true, blocking:[]`,而「上一版方案的
         * 14 恰好是正确的全仓总数」就躺在它的 comments 里;作者第 3 轮的输入完全来自总监
         * 写进 blocking 的那句。把裁决员往 comments 上推,等于把唯一能救回这轮的信息埋掉。
         */
        `核出来同僚那条是错的:把那条摘进 "retracted",并把**正确的值**写进你自己的 blocking ——`,
        `只写进 comments 的话它到不了${subject === '方案' ? '方案作者' : '执行者'}那里。`,
      ]
      : []),
  ].join('\n'), MAX_SUMMARY_CHARS)
}

/**
 * 触顶时写进 blockedReason 的那句话。
 *
 * 原来是把最后一轮的拼接串原样贴上。它答不了用户真正的问题 —— **哪几条是一直没解决的**。
 */
export function retractedCount(log: readonly RoundtableRecord[]): number {
  let n = 0
  for (const rec of log ?? []) {
    for (const v of rec?.verdicts ?? []) {
      if (v?.infra === true) continue
      n += (v?.retracted ?? []).filter(s => typeof s === 'string' && s.trim().length > 0).length
    }
  }
  return n
}

export function exhaustionReason(
  items: readonly FeedbackItem[], max: number,
  /**
   * 过程中被撤回了几条(`retractedCount`)。
   *
   * **必须说出来。** 撤回是这套里唯一能让一条真实提出过的意见在下游全线消失的机制:它不进
   * `items`,所以既不在「至今未解决」里,也不在「只被提过一轮」里。而这句话正是运行被打死
   * 那一刻用户唯一会读的东西 —— 少了这个数,一次误撤或滥撤在这里和「从没有人提过」完全
   * 一样。给的是**指路**而不是正文:原文在 node.md 的评审记录里(那一侧也渲染了)。
   */
  retracted = 0,
): string {
  const head = `评审迭代超限(${max})`
  const tail = retracted > 0 ? `;另有 ${retracted} 条意见在过程中被撤回(见 node.md 评审记录的「↩ 本轮撤回」)` : ''
  if (items.length === 0) return head + tail
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
  return capText(`${head}: ${seg.join(';')}${tail}`, MAX_SUMMARY_CHARS)
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
