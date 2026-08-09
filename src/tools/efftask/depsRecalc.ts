// src/tools/efftask/depsRecalc.ts
//
// **依赖重算**:把一个还没开始分析、正被依赖挡着的任务的**粗依赖**,换成被依赖任务
// 子树里更细的若干节点,让它提前起跑。
//
// 用户原话:「当被依赖的任务被拆细后,其依赖其的任务可以通过手动触发重算其依赖任务……
// 不要等被依赖任务一定要完成,其完成了下级子任务拆分就可以……既要细粒度依赖,也不要
// 导致依赖任务数过多。」
//
// ## 这个文件里唯一重要的一句话
//
// **精度由代码兑现,不由提示词兑现。** 模型只做一件事:对着一份清单逐项回答「本任务要用到
// 它的产出吗」。合并、去冗余、数量控制、环检测、安全兜底全在这里,而且全是纯函数 ——
// 因为模型侧的每一次「顺手帮我们合并一下」都是**有损**的:它把「到底哪几项」当场销毁,
// 而代码再也展不开。反过来,模型多列几项对代码是无损的(压回去就行)。
//
// ## 为什么上卷是**按需**的,不是「能卷就卷」
//
// `advanceableKind` 的 integrate 分支要 `childrenAllAccepted`,**之后还要过一整场集成验收
// 圆桌**才 ACCEPTED。所以「依赖 {c1,c2,c3}」解锁的时刻**必然不晚于**「依赖它们的父 X」,
// 通常严格更早 —— 上卷是**纯代价**,它买到的唯一东西是「依赖条数不膨胀」。而那是数量闸的
// 职责。无条件上卷 + 模型倾向于列全 = 每次都卷回原依赖,输出恒等于「没有变化」。
//
// 用户的原话也正是这个口径:「**可以**写依赖其子任务中一项」「**没有必要**写出所有孙子任务」
// —— 那是允许减少条数,不是要求合并。
import { childrenAllAccepted, depsSatisfied, isTerminal } from './stateMachine.js'
import { hasBlockedAncestor } from './scheduler.js'
import { depCycleMembers } from './resumeCore.js'
import { capText, MAX_RECALC_WHY_CHARS, type RecalcAnswer, type RecalcNeed } from './parseOutput.js'
import type { TaskNode } from './types.js'

/** 单个依赖细化后最多留几项。 */
export const MAX_DEPS_PER_DEP = 8
/** 本节点细化后依赖总数最多几项(下界是原依赖的去重条数,见 `applyCountGates`)。 */
export const MAX_DEPS_TOTAL = 16
/** 发给模型的**软**上限。和上面两个不是一回事,也和解析层的 `MAX_RECALC_NEEDS` 不是一回事。 */
export const RECALC_SOFT_LIMIT = 8
/**
 * 整份子树清单(**全部依赖合计**)最多几个码点。
 *
 * 这是这一节唯一的硬数,其余(每个依赖列几个节点、要不要附方案摘要)全部由它推导。
 * 取 12000 是为了给整份提示词留出 `PROMPT_SHRINK_WORTH_IT`(20000)以下的净空:
 * 一旦越过那条线,`shrinkPrompt` 会**掐中间留两头** —— schema 和 answer tag 在尾巴上活下来,
 * 被吃掉的正好是清单本身,也就是这次调用**唯一的信息**;而它塞进去的那句「省掉的部分你
 * 自己去读文件」在这条**零工具**的缝上物理不可能做到。
 */
export const RECALC_LIST_BUDGET = 12000
/** 清单之外(四条规则 + schema + answerRule)的预算。两个加起来仍要低于 20000。 */
export const RECALC_CHROME_BUDGET = 3000

const cp = (s: string): number => Array.from(s).length

/**
 * **围栏中和** —— 和 `pipeline.ts` 的 `quote()` 同因、同写法。
 *
 * 这一节铺进提示词的每一个字段(节点标题、本任务目标、上级方案要点)都是**别的 agent
 * 写的**,而它们和我们自己的 schema 代码块共处一份提示词。一个三反引号就能当场把那个
 * 代码块关掉:run 001 上一次 `` ` `` 的非法转义让整份方案回退成散文、验收点变空,
 * 五个席位里两个逐字同因烧穿了迭代上限,一行代码没写。
 *
 * 这个函数**掉过一次**:`recalcPrompt` 的注释和方案里都写着「过 quote()」,而落地时
 * 三处都只过了 `capText`。验收席用一个标题为三反引号的子任务复现:提示词里的围栏数
 * 从 2 变成 3。
 */
function quoteField(s: string): string {
  return s.replace(/`/g, "'")
}

// ---------------------------------------------------------------- 血缘工具

/** `id` 是不是 `ancestorId` 或它的后代。顺 parentId 上溯,带环保护(childIds/parentId 可手工编辑)。 */
export function inSubtreeOf(id: string, ancestorId: string, byId: ReadonlyMap<string, TaskNode>): boolean {
  const seen = new Set<string>()
  let cur: string | undefined = id
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = byId.get(cur)?.parentId ?? undefined
  }
  return false
}

/** `root` 自己 + 全部**真实存在**的后代,按 id 升序。顺 childIds 走,带环保护。 */
export function subtreeIds(rootId: string, byId: ReadonlyMap<string, TaskNode>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = byId.get(id)
    if (!n) continue
    out.push(id)
    for (const c of n.childIds) stack.push(c)
  }
  return out.sort()
}

/**
 * 这个节点**声称**已验收,而它底下真的全验收了吗。
 *
 * 「祖先 ACCEPTED ⇒ 全部后代 ACCEPTED」**不是不变式,只是调度纪律**:唯一支撑它的是
 * `advanceableKind` 的 `childrenAllAccepted`,而 `stepIntegrate` 从头到尾没有再核过一次。
 * 真实交错:`growTree` 在 `await createChildren` 期间,编排器可以把那个 WAITING_CHILDREN 的
 * 父节点挑去做集成验收(此刻它确实 childrenAllAccepted,新孩子还没挂上);圆桌是分钟级的,
 * 回来后 `commit(ACCEPTED)` 会覆盖 `growTree` 写回的 WAITING_CHILDREN。父 ACCEPTED、新子 CREATED。
 *
 * 所以这里**测量**,不假设 —— 复用 `childrenAllAccepted`(它对缺失子节点自动 fail-closed),
 * 递归带 `seen`(childIds 可手工编辑,自指条目会死循环,而这段跑在按键处理里)。
 *
 * **它只关掉「此刻已经破」的那一半。** 「重算之后才被那条交错弄破」的那一半关不掉,
 * 由「细化过头」那条残余风险承担 —— 不写清楚的话,下一个人会以为祖先吃后代和上卷是
 * 无条件安全的。
 */
export function subtreeFullyAccepted(
  id: string, byId: ReadonlyMap<string, TaskNode>, seen = new Set<string>(),
): boolean {
  if (seen.has(id)) return true // 环:已经在上层判过了,这里不重复也不否定
  seen.add(id)
  const n = byId.get(id)
  if (!n) return false
  if (n.status !== 'ACCEPTED') return false
  if (!childrenAllAccepted(n, byId as Map<string, TaskNode>)) return false
  return n.childIds.every(c => subtreeFullyAccepted(c, byId, seen))
}

/**
 * 一条依赖在屏幕/提示词里叫什么。
 *
 * 依赖从此**可能不是兄弟**,而依赖段、方案 schema、子任务解析全是按「兄弟标题」这套坐标系
 * 写的 —— 一个孙节点的裸标题在那套坐标系里读起来像「依赖了一个不存在的兄弟」。
 * 非兄弟时给两级路径;`self` 是发起方的 parentId(用来判「是不是兄弟」)。
 */
export function depLabel(
  id: string, byId: ReadonlyMap<string, TaskNode>, fromParentId?: string | null,
): string {
  const n = byId.get(id)
  if (!n) return `${id}(节点缺失)`
  const sameParent = fromParentId !== undefined && n.parentId === fromParentId
  if (sameParent || n.parentId === null) return n.title
  const p = byId.get(n.parentId)
  return p ? `${p.title} / ${n.title}` : n.title
}

// ---------------------------------------------------------------- 准入

export interface DepGroup {
  dep: string
  /** `dep` 自己 + 它全部真实存在的后代,按 id 升序。 */
  ids: string[]
}
export interface KeptDep { dep: string; why: string }
export type RecalcRefusal = { ok: false; reason: string; details: string[] }
export type RecalcScope = { ok: true; groups: DepGroup[]; kept: KeptDep[] }

/**
 * 这一刻能不能对这个节点重算,以及哪几条依赖有得细化。
 *
 * **全部是同步内存读、零 await** —— 关口正是靠这一点做到「准入被拒时根本不切屏」:
 * 切屏会把详情页整棵卸载,而用户展开到哪一段、读到第几行全住在那些组件自己的 state 里。
 * 「什么都没发生」不该长成「你的阅读位置没了」。
 */
export function recalcScope(
  node: TaskNode,
  byId: Map<string, TaskNode>,
  opts: {
    /** 此刻在飞的节点(编排器把被扣住的也折在这一个集合里)。 */
    running?: ReadonlySet<string>
    /** `control.wasCancelled(node.id)`。 */
    cancelled?: boolean
    /** 编排器已经跑完了吗。 */
    finished?: boolean
  } = {},
): RecalcScope | RecalcRefusal {
  const no = (reason: string, details: string[] = []): RecalcRefusal => ({ ok: false, reason, details })

  if (opts.finished === true) {
    return no('本次编排已经结束,依赖重算需要编排器还在跑。' +
      '`/et --resume` 继续这一趟之后,这个键就回来了。')
  }
  if (opts.running?.has(node.id) === true) {
    // 不许复用下面那条「已经开始分析」的文案:`CREATED` + 正在运行写成
    // 「已经开始分析(当前 CREATED)」是一句当场自相矛盾的话。
    return no('这个任务此刻正在被调度器执行 —— 先在树上选中它按 x 取消,再来重算。')
  }
  if (isTerminal(node.status)) {
    return no(`这个任务已经结束了(${node.status})。依赖重算只对**还没开始分析**的任务有意义。`)
  }
  if (node.status !== 'CREATED') {
    return no(
      `这个任务已经开始分析了(当前 ${node.status})—— 它的方案已经站在旧依赖上写出来了,` +
      `改依赖不会改方案。`,
    )
  }
  if (opts.cancelled === true) {
    return no(
      '这个任务你按 x 取消过。重算不会把它放回队列(那等于替你改主意)—— 要跑它请先重做。',
    )
  }
  /**
   * 方案已经写过就不许改依赖 —— 但判据是**两条**。
   *
   * `CREATED` 不等于「没写过方案」:`planRedo` 的「从质疑修复重做」把节点坐回 CREATED 却
   * **不重出方案**;而「任务重做」那一支把 `kind` 打回 `'unknown'`、**却不清 `plan`**
   * (`stepStart` 随后会整份覆盖它)。只判「方案全空」会把后者一起挡掉 —— 而那恰恰是
   * 「马上要按新依赖重新分析」的最理想场景,拒绝文案「改依赖不会改方案」在那条路上
   * 逐字为假(下一秒就会被重写)。
   */
  const planWritten =
    node.kind !== 'unknown' &&
    [node.plan.solution, node.plan.keyPoints, node.plan.risks, node.plan.acceptance]
      .some(s => typeof s === 'string' && s.trim().length > 0)
  if (node.redoFrom !== undefined || planWritten) {
    return no(
      '这个任务已经有一份方案(或正从质疑修复重入)—— 那份方案是站在旧依赖上写的,' +
      '改依赖不会改方案。',
    )
  }
  if (hasBlockedAncestor(node, byId)) {
    return no(
      '它的上级任务已经阻断 —— 整棵子树都不会再被调度,细化依赖不会让它跑起来。' +
      '要救它得先处理那个阻断的上级任务。',
    )
  }
  if (node.deps.length === 0) {
    return no('本任务没有依赖,所以没有可细化的东西 —— 它不会因为重算更早起跑。')
  }
  if (depsSatisfied(node, byId)) {
    return no('本任务的依赖此刻都已满足,它马上就会被调度 —— 重算买不到任何并发。')
  }

  const groups: DepGroup[] = []
  const kept: KeptDep[] = []
  const seenDep = new Set<string>()
  for (const id of node.deps) {
    if (seenDep.has(id)) continue
    seenDep.add(id)
    const d = byId.get(id)
    if (!d) {
      kept.push({
        dep: id,
        why: `在这棵树里找不到 —— 这条依赖永远不会满足,本任务会一直被挡住(重算不碰它)。` +
          `要动它得走重做或跳过。`,
      })
      continue
    }
    if (d.status === 'ACCEPTED') {
      kept.push({ dep: id, why: '已经完成,细化它不会让本任务更早起跑' })
      continue
    }
    if (d.childIds.length === 0) {
      kept.push({ dep: id, why: '还没拆分出子任务,无从细化' })
      continue
    }
    groups.push({ dep: id, ids: subtreeIds(id, byId) })
  }
  if (groups.length === 0) {
    return no(
      '这次一条都没动,任务树逐字未变 —— 没有任何一条依赖可以细化:',
      kept.map(k => `${depLabel(k.dep, byId, node.parentId)}:${k.why}`),
    )
  }
  return { ok: true, groups, kept }
}

// ---------------------------------------------------------------- 提示词

const STATUS_WORD: Record<string, string> = {
  CREATED: '未开始', READY: '待执行', WAITING_CHILDREN: '等子任务', BLOCKED: '已阻断', ACCEPTED: '已完成',
}
const statusOf = (n: TaskNode): string => STATUS_WORD[n.status] ?? n.status

/**
 * 一个节点在清单里占一行(第一趟:只有身份)。
 *
 * id 用**真 id**,不另造代号:代号要维护一张映射表,而模型答错代号会静默命中一个
 * **真实存在但不对**的节点;真 id 答错至少能自证「不在子树里」。
 */
function listLine(n: TaskNode): string {
  const kids = n.childIds.length > 0 ? `已拆 ${n.childIds.length} 个子任务` : '叶子'
  return `- ${n.id} | ${quoteField(capText(n.title, 200))} | ${statusOf(n)} | ${kids}`
}

function summaryLine(n: TaskNode): string {
  const k = quoteField(capText((n.plan.keyPoints || '').trim(), 300))
  const a = quoteField(capText((n.plan.acceptance || '').trim(), 300))
  if (!k && !a) return ''
  return `    ${[k && `要点:${k}`, a && `验收:${a}`].filter(Boolean).join(' / ')}`
}

export interface RecalcListing { text: string; tooBig: string[] }

/**
 * 依赖子树清单 —— **分两趟**,总量夹在 `RECALC_LIST_BUDGET` 之内。
 *
 * 第一趟只写身份(每节点约 150~350 码点),装得下多少写多少;第二趟在预算有余时才补
 * 方案摘要。节点条数是**算出来**的,不是写死的:一棵 `maxDepth 20` 的树上单个 id 就有
 * 884 码点,同一个预算只装得下十几个。
 *
 * 「还有 N 个未列出」写在**每一组的最前面**,不是后面 —— 提示词一旦越过压缩线,
 * `shrinkPrompt` 掐的是中间,写在后面的那一行会先被吃掉,而它正是解释这份清单不完整的
 * 唯一一句话。
 */
export function buildRecalcListing(
  groups: readonly DepGroup[], byId: ReadonlyMap<string, TaskNode>,
  budget = RECALC_LIST_BUDGET,
): RecalcListing {
  const tooBig: string[] = []
  // 第一趟:每组先把身份行铺开,按预算均分(组间等分,余量留给后面的组)。
  const blocks: { dep: string; head: string; lines: string[]; total: number; shown: number }[] = []
  let used = 0
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const remainingGroups = groups.length - gi
    const share = Math.max(0, Math.floor((budget - used) / remainingGroups))
    const nodes = g.ids.map(id => byId.get(id)).filter((n): n is TaskNode => n !== undefined)
    const lines: string[] = []
    let spent = 0
    for (const n of nodes) {
      const line = listLine(n)
      if (spent + cp(line) + 1 > share) break
      lines.push(line)
      spent += cp(line) + 1
    }
    if (lines.length === 0) {
      // 连身份行都装不下 —— 这一条依赖没法参与这次重算,如实说,不发一次注定被掐的调用。
      tooBig.push(g.dep)
      continue
    }
    const head = lines.length < nodes.length
      ? `依赖 ${g.dep} 的子树共 ${nodes.length} 个节点,下面列出其中 ${lines.length} 个` +
        `(其余 ${nodes.length - lines.length} 个未列出,不要引用没列出来的节点):`
      : `依赖 ${g.dep} 的子树(共 ${nodes.length} 个节点):`
    blocks.push({ dep: g.dep, head, lines, total: nodes.length, shown: lines.length })
    used += spent + cp(head) + 1
  }
  // 第二趟:预算有余才补方案摘要,按原顺序补,补到用完为止。
  // 组间分隔符也要算进去 —— 不算的话「总量 ≤ budget」这句话在多组时就是假的。
  let left = budget - used - Math.max(0, blocks.length - 1) * 2
  const withSummaries = blocks.map(b => {
    const out: string[] = [b.head]
    for (const line of b.lines) {
      out.push(line)
      const id = line.slice(2).split(' | ')[0]
      const n = byId.get(id)
      if (!n) continue
      const s = summaryLine(n)
      if (s && cp(s) + 1 <= left) { out.push(s); left -= cp(s) + 1 }
    }
    return out.join('\n')
  })
  /**
   * **最后一道硬夹**,按整行切。
   *
   * 上面那套逐行结算已经很小心了,但它是**加法**:头行、分隔符、第二趟的摘要各自减一次,
   * 少算一处就是超一点点 —— 而这一节的全部理由是「不许越过压缩线」,超 60 个码点和超 6000
   * 个码点在 `shrinkPrompt` 眼里没有区别。按行切而不是按码点切:切在半行上会造出一个
   * **看起来像 id 的残片**,而模型会照抄它。
   *
   * 「还有 N 个未列出」写在每组最前面,所以它一定活得过这一刀。
   */
  let text = withSummaries.join('\n\n')
  if (cp(text) > budget) {
    const lines = text.split('\n')
    while (lines.length > 1 && cp(lines.join('\n')) > budget) lines.pop()
    text = lines.join('\n')
  }
  return { text, tooBig }
}

/**
 * 重算提示词。
 *
 * 规则里**没有**「全部子任务都要就写父任务」那一条,而且是故意的:模型侧的合并是有损的
 * (「到底哪几项」当场销毁,代码再也展不开),模型侧的枚举是无损的(代码压得回去)。
 * 合并只发生在这个文件的数量闸上。**也不要在提示词里讲上卷机制** —— 讲了模型会去迎合机制,
 * 而不是回答问题。
 *
 * schema 里**一个具体 id 都不给**,用尖括号占位;整份提示词里**一个反引号都没有**。
 * 这个仓库有过「提示词里的示范被模型照抄回来、正好劈开自己的代码块」的事故;而这里照抄
 * 一个示例 id 的最坏结果更糟 —— 树里**真有** root/01-… 的时候,那是一条通过域约束的、
 * 真实的、错的依赖。
 */
export function recalcPrompt(args: {
  node: TaskNode
  byId: ReadonlyMap<string, TaskNode>
  listing: string
  tag: string
  parentPlan?: string
  /** 上一轮被丢掉的 id —— 重拟时逐条回给模型(引用前必须由调用方 quote 过)。 */
  feedback?: string
}): string {
  const { node } = args
  return (
    '你在做一次**依赖细化**。下面这个任务原本依赖若干个粗粒度的任务,而那些任务现在已经\n' +
    '拆出了自己的子任务。请判断:它到底要用到哪几个更小的任务的产出。\n\n' +
    `本任务:${quoteField(capText(node.title, 200))}\n` +
    `本任务的目标:\n${quoteField(capText(node.goal, 1200))}\n` +
    (args.parentPlan ? `上级方案要点:\n${quoteField(capText(args.parentPlan, 800))}\n` : '') +
    '\n以下是每个依赖任务的子树。\n\n' +
    args.listing +
    '\n\n判断规则:\n' +
    '1. 对上面清单里的每一项,只问一个问题:**本任务要用到它的产出吗?** 要就写,不要就别写。\n' +
    '2. 只能从**同一个依赖自己的子树**里挑(含那个依赖本身),不要跨到别的依赖上去。\n' +
    `3. 一个依赖通常 1~3 项就够,超过 ${RECALC_SOFT_LIMIT} 项请回头确认是不是每一项都真用得上;` +
    '但确实需要更多就都写出来,**不要为了少写几项而改写成它们的父任务**。\n' +
    '4. 拿不准就写那个依赖任务自己的 id(意思是保持原样)。每个依赖**至少给出一项**。\n' +
    '5. 每一项都要写一句 why(不超过 40 字):本任务的哪一步要用到它。\n' +
    (args.feedback ? `\n上一轮的问题:\n${quoteField(args.feedback)}\n` : '') +
    '\n输出(只输出一个代码块,最外层是一个对象;id 从上面清单里**逐字复制**):\n' +
    `\`\`\`${args.tag}\n` +
    '{"deps":[{"dep":"<上面某个依赖任务的 id>","needs":[' +
    '{"id":"<从上面清单里逐字复制的节点 id>","title":"<那个节点的标题>","why":"<一句话>"}]}]}\n' +
    '```\n'
  )
}

// ---------------------------------------------------------------- 归一化

export interface PerDepResult {
  dep: string
  needs: { id: string; why: string }[]
  dropped: string[]
  rolledUp: string[]
  /** 非空 = 这一条整条退回了原依赖,值就是原因。 */
  keptCoarse?: string
}
export interface RecalcPlan {
  nodeId: string
  before: string[]
  after: string[]
  perDep: PerDepResult[]
  warnings: string[]
  unchanged: boolean
  outcome: 'refined' | 'no-finer' | 'rolled-back' | 'all-dropped' | 'unparsed'
}

/** 归一化后的字符串:去掉两侧装饰、全角转半角。零歧义,不做任何相似度猜测。 */
export function normalizeRef(s: string): string {
  let t = s.trim()
  // 全角 → 半角(只动 ASCII 可见区那一段,不碰中文)
  t = t.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  t = t.replace(/^[-*]\s+/, '')
  t = t.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '')
  t = t.replace(/\/+$/, '')
  return t.trim()
}

/**
 * 后缀匹配 —— **必须按 `/` 分段对齐**。
 *
 * 裸 `endsWith` 下 'root/12-y'.endsWith('2-y') 为真、'root/01-x'.endsWith('1-x') 为真,
 * 而「序号形态写错」(1- 而不是 01-)恰恰是最常见的抄错之一 —— 于是它会被匹配成一个
 * **别的真实节点**,而这正是本节立意要挡的「相似度匹配」从后门进来。
 */
function suffixMatches(id: string, ref: string): boolean {
  if (id === ref) return true
  return id.endsWith(`/${ref}`)
}

/** 模型给的示例占位符长什么样 —— 认出来要单独报,补救方式和「不在子树里」不同。 */
const PLACEHOLDER = /^<.*>$/

export interface ResolveOutcome {
  id?: string
  /** 没解析出来时的原因(直接进 `dropped`)。 */
  problem?: string
}

/**
 * 把模型给的一项解析成一个真实节点 id。
 *
 * 顺序是**先分别解析、再对账、最后才接受**。把对账放到最后一步(先按 id 收下、再看 title)
 * 是错的:后缀匹配已经把一个与 title 矛盾的 id 收下了。
 */
export function resolveNeed(
  need: RecalcNeed, scope: readonly string[], byId: ReadonlyMap<string, TaskNode>,
): ResolveOutcome {
  const rawId = normalizeRef(need.id ?? '')
  const rawTitle = normalizeRef(need.title ?? '')
  if (PLACEHOLDER.test(rawId)) {
    return { problem: `${need.id}(模型把示例占位符原样抄了回来)` }
  }
  // --- id 一侧:精确 or 唯一后缀 ---
  let byIdHit: string | undefined
  let idAmbiguous = false
  if (rawId.length > 0) {
    const hits = scope.filter(s => suffixMatches(s, rawId))
    if (hits.length === 1) byIdHit = hits[0]
    else if (hits.length > 1) idAmbiguous = true
  }
  // --- title 一侧:唯一标题 ---
  // 比较双方走**同一次变换**:清单里的标题过了 capText(200),模型只能照抄变换后的那一份,
  // 拿它去和原始 title 比会恒不相等。
  let byTitleHit: string | undefined
  let titleAmbiguous = false
  if (rawTitle.length > 0) {
    const hits = scope.filter(s => {
      const n = byId.get(s)
      return n !== undefined && normalizeRef(capText(n.title, 200)) === rawTitle
    })
    if (hits.length === 1) byTitleHit = hits[0]
    else if (hits.length > 1) titleAmbiguous = true
  }
  // --- 对账 ---
  if (byIdHit && byTitleHit) {
    if (byIdHit === byTitleHit) return { id: byIdHit }
    return { problem: `${need.id}(id 指向 ${byIdHit},标题却指向 ${byTitleHit},互相矛盾)` }
  }
  if (byIdHit) return { id: byIdHit }
  if (byTitleHit) return { id: byTitleHit }
  if (idAmbiguous) return { problem: `${need.id}(这个写法能对上子树里的多个节点,认不出是哪一个)` }
  if (titleAmbiguous) return { problem: `${need.id || need.title}(子树里有多个同名节点,认不出是哪一个)` }
  return { problem: `${need.id || need.title || '(空)'}(不在这个依赖的子树里)` }
}

/** 集合里有没有别的成员是它的祖先。 */
function hasSelectedAncestor(id: string, set: ReadonlySet<string>, byId: ReadonlyMap<string, TaskNode>): boolean {
  for (const other of set) {
    if (other !== id && inSubtreeOf(id, other, byId)) return true
  }
  return false
}

/**
 * 数量闸:**只有超了才上卷**,卷到刚好装下就停。
 *
 * 两级定序都必须确定,否则关口预演和真正执行会卷出不同的形状:先卷哪个依赖(候选组成员
 * 最多者,同数按 dep id 升序)、组内先卷哪一组(同规则,按父 id 升序)。
 *
 * **必须有显式出口**:本轮没有任何可卷的组就跳出。总数的下界是原依赖的**去重**条数
 * (每个依赖至少贡献一项),它可以大于任何硬上限 —— 写成 `while (超限) 上卷()` 就是死循环,
 * 而这段跑在按键处理里,死循环等于终端整个卡死。
 */
function collapseOnce(
  sel: Set<string>, scopeRoot: string, byId: ReadonlyMap<string, TaskNode>,
  /**
   * 这一步最多允许**减少**几条。`undefined` = 不限。
   *
   * 存在的理由是验收席实测出来的一道悬崖:一个有 12 个子任务的依赖,模型要 8 项 →
   * 保住 8 条;要 **9** 项 → 唯一的候选组是父节点本身(9 个被选中的孩子 ≥2),一步卷回
   * 粗依赖,屏幕上写「依赖**没有变化**」。而同样是 9 项,如果它们分属不同父节点就卷不动,
   * 代码保留 9 项只发警告 —— **同一个数字两种结果**,而且坏的那一种恰好落在并发收益
   * 最大的那类节点上(拆分型任务常常拆出 8 个以上子任务)。
   *
   * 所以非全覆盖的组只有在「卷完不会掉到上限以下」时才允许卷;卷不动就停下来发警告,
   * 和「没有任何可卷的组」那条出口合流。**全覆盖的组不受这条限制** —— 那是用户点名的
   * 规则,而且它不会让本任务多等任何一个用不上的兄弟。
   */
  maxReduction?: number,
): { parent: string; children: string[] } | undefined {
  // 候选:选中项的父节点,且父节点仍在这个依赖的子树里(不许卷到子树外面去 ——
  // 那可能是本节点的祖先,会让整次重算被最终安全闸判废,而用户只看到一句莫名其妙的放弃)
  const byParent = new Map<string, string[]>()
  for (const id of sel) {
    const p = byId.get(id)?.parentId
    if (!p) continue
    if (!inSubtreeOf(p, scopeRoot, byId)) continue
    byParent.set(p, [...(byParent.get(p) ?? []), id])
  }
  /**
   * 「这个父节点的**全部**子任务都被选中了吗」—— 用户点名的那一条:
   * 「如依赖其子任务中某个的所有子任务,就可以写依赖其子任务中一项」。
   *
   * 它是**优先级**,不是准入条件:必须减少条数的时候,一个只覆盖了一半的父节点照样得卷
   * (否则闸门根本关不上)。但全覆盖那种严格更好 —— 卷它不会多等任何一个**用不上**的兄弟。
   *
   * 缺失的 childId 一律算「没覆盖」(fail-closed):`childIds` 可以指向不存在的节点,
   * 而那种节点永远不会 ACCEPTED —— 把它当成「已经在集合里」等于凭空放宽。
   */
  const covered = (p: string): boolean => {
    const kids = byId.get(p)?.childIds ?? []
    return kids.length > 0 && kids.every(c => byId.has(c) && sel.has(c))
  }
  const cands = [...byParent.entries()]
    // **严格减少条数**才算一次上卷:一个只有独生子的父节点卷完还是 1 项,
    // 而外层是 `while (超限)` —— 那就是一个不推进的循环,跑在按键处理里等于终端卡死。
    .filter(([, kids]) => kids.length >= 2)
    // 非全覆盖的组不许**过度**上卷(见 maxReduction)。全覆盖的不受限。
    .filter(([p, kids]) => covered(p) || maxReduction === undefined || kids.length - 1 <= maxReduction)
    .sort((a, b) =>
      (Number(covered(b[0])) - Number(covered(a[0])))
      || (b[1].length - a[1].length)
      || (a[0] < b[0] ? -1 : 1))
  const top = cands[0]
  if (!top) return undefined
  return { parent: top[0], children: top[1] }
}

export interface NormalizeOpts {
  /** 单依赖上限。默认 `MAX_DEPS_PER_DEP`。 */
  perDep?: number
  /** 总上限。默认 `MAX_DEPS_TOTAL`。 */
  total?: number
  /** 因为子树太大而**没被列进清单**的依赖 —— 它们不是「模型没答」,是我们没问。 */
  notAsked?: readonly string[]
}

/**
 * 模型的回答 → 一份可以给人看、也可以直接应用的计划。**纯函数。**
 */
export function normalizeRecalc(
  node: TaskNode,
  byId: Map<string, TaskNode>,
  scope: RecalcScope,
  answer: RecalcAnswer | null,
  opts: NormalizeOpts = {},
): RecalcPlan {
  const perDepCap = opts.perDep ?? MAX_DEPS_PER_DEP
  const totalCap = opts.total ?? MAX_DEPS_TOTAL
  const warnings: string[] = []
  const before = [...node.deps]
  const perDep: PerDepResult[] = []

  if (!answer) {
    return {
      nodeId: node.id, before, after: before, perDep: [], warnings,
      unchanged: true, outcome: 'unparsed',
    }
  }

  const answerByDep = new Map<string, RecalcNeed[]>()
  for (const d of answer.deps) {
    // 模型给的 dep 名也可能带装饰;按同一套后缀规则对回一个真实的原依赖。
    const raw = normalizeRef(d.dep)
    const hit = scope.groups.find(g => suffixMatches(g.dep, raw))
    if (!hit) continue
    answerByDep.set(hit.dep, [...(answerByDep.get(hit.dep) ?? []), ...d.needs])
  }

  let anyModelFiner = false
  let anyDropped = false
  let anyGiven = false

  for (const g of scope.groups) {
    const needs = answerByDep.get(g.dep) ?? []
    if (needs.length > 0) anyGiven = true
    const dropped: string[] = []
    const whyOf = new Map<string, string>()
    const sel = new Set<string>()
    for (const nd of needs) {
      const r = resolveNeed(nd, g.ids, byId)
      if (r.id === undefined) { dropped.push(r.problem ?? '(未知)'); anyDropped = true; continue }
      sel.add(r.id)
      if (!whyOf.has(r.id)) whyOf.set(r.id, capText(nd.why ?? '', MAX_RECALC_WHY_CHARS))
    }
    if (sel.size === 0) {
      // 兜底:每个依赖至少一项。**规则 4 在代码里成立,不在提示词里成立。**
      perDep.push({
        dep: g.dep, needs: [{ id: g.dep, why: '' }], dropped, rolledUp: [],
        /**
         * 三种成因,三句话。**「没问过」不许说成「它没答」** —— 子树装不下预算时这条依赖
         * 根本没进清单(见 buildRecalcListing 的 tooBig),而模型对一个它从没见过的依赖
         * 当然给不出项;报成「模型没有给出」是把我们自己的限制记在它头上,而用户据此
         * 得出的结论(「再按一次说不定就好了」)是错的。
         */
        keptCoarse: opts.notAsked?.includes(g.dep) === true
          ? '子树太大,没能列进这次调用 —— 模型没被问过这一条'
          : needs.length > 0 ? '模型给的项一条都没对上' : '模型没有给出这一条依赖',
      })
      continue
    }
    if (!(sel.size === 1 && sel.has(g.dep))) anyModelFiner = true

    // ---- 祖先吃后代(**急切**,因为无损:模型明确要了 X,等 X 本来就要发生) ----
    for (const id of [...sel]) {
      if (hasSelectedAncestor(id, sel, byId)) sel.delete(id)
    }

    // ---- 假 ACCEPTED 防线(测量,不假设) ----
    const fake = [...sel].filter(id => byId.get(id)?.status === 'ACCEPTED' && !subtreeFullyAccepted(id, byId))
    if (fake.length > 0) {
      warnings.push(
        `⚠ ${depLabel(g.dep, byId, node.parentId)}:候选里有 ${fake.length} 个节点自称已完成、` +
        `底下却还有没完成的子任务 —— 这一条整条保持原样(细化它会让本任务在半成品上起跑)。`,
      )
      perDep.push({ dep: g.dep, needs: [{ id: g.dep, why: '' }], dropped, rolledUp: [], keptCoarse: '候选里有「自称已完成、底下没完成」的节点' })
      continue
    }

    // ---- 单依赖数量闸:按需上卷 ----
    const rolledUp: string[] = []
    while (sel.size > perDepCap) {
      const c = collapseOnce(sel, g.dep, byId, sel.size - perDepCap)
      if (!c) break
      for (const k of c.children) sel.delete(k)
      sel.add(c.parent)
      rolledUp.push(c.parent)
    }
    if (sel.size > perDepCap) {
      warnings.push(
        `⚠ ${depLabel(g.dep, byId, node.parentId)}:细化后仍有 ${sel.size} 项、已经卷不动了` +
        `(它们没有共同的父任务),超过单条上限 ${perDepCap}。`,
      )
    }
    perDep.push({
      dep: g.dep,
      needs: [...sel].sort().map(id => ({ id, why: whyOf.get(id) ?? '' })),
      dropped, rolledUp,
    })
  }

  // ---- 总闸 ----
  const gate = applyCountGates(perDep, before, byId, totalCap, warnings)

  // ---- 汇总 ----
  const kept = scope.kept.map(k => k.dep)
  const after = [...new Set([...gate.flatMap(p => p.needs.map(n => n.id)), ...kept])].sort()

  // ---- 最终安全闸 ----
  const guard = finalGuard(node, byId, before, after)
  if (guard) {
    warnings.push(`⚠ ${guard}`)
    return { nodeId: node.id, before, after: before, perDep: gate, warnings, unchanged: true, outcome: 'rolled-back' }
  }

  const unchanged = sameSet(before, after)
  const outcome: RecalcPlan['outcome'] =
    !unchanged ? 'refined'
      : !anyGiven ? 'no-finer'
        : anyDropped && !anyModelFiner ? 'all-dropped'
          : anyModelFiner ? 'rolled-back'
            : 'no-finer'
  return { nodeId: node.id, before, after, perDep: gate, warnings, unchanged, outcome }
}

/**
 * 总数闸。判据是 `after.length > max(硬上限, 原依赖去重条数)`。
 *
 * `before` 必须**去重**再比:`node.deps` 可以含重复(重做那条路为「deps: [a, a] 会被记成
 * 两条改写」专门去过重),而 `after` 是去重的 —— 拿去重后的和没去重的比,重复项会凭空
 * 放大额度。
 */
function applyCountGates(
  perDep: PerDepResult[], before: readonly string[], byId: ReadonlyMap<string, TaskNode>,
  totalCap: number, warnings: string[],
): PerDepResult[] {
  const floor = new Set(before).size
  const cap = Math.max(totalCap, floor)
  const count = (): number => perDep.reduce((s, p) => s + p.needs.length, 0)
  while (count() > cap) {
    // 先卷成员最多的那一条依赖,同数按 dep id 升序 —— 关口预演和真正执行必须逐字相同。
    const ordered = [...perDep].sort((a, b) => (b.needs.length - a.needs.length) || (a.dep < b.dep ? -1 : 1))
    let progressed = false
    for (const p of ordered) {
      const sel = new Set(p.needs.map(n => n.id))
      const c = collapseOnce(sel, p.dep, byId, count() - cap)
      if (!c) continue
      for (const k of c.children) sel.delete(k)
      sel.add(c.parent)
      p.needs = [...sel].sort().map(id => ({ id, why: p.needs.find(n => n.id === id)?.why ?? '' }))
      p.rolledUp.push(c.parent)
      progressed = true
      break
    }
    // **显式出口。** 没有出口就是死循环 —— 而下界是原依赖条数,它可以大于任何硬上限。
    if (!progressed) {
      warnings.push(
        `⚠ 细化后共 ${count()} 条依赖、已经卷不动了(上限 ${cap})—— ` +
        `这是原依赖条数决定的下界,不是这次重算多加的。`,
      )
      break
    }
  }
  return perDep
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a), y = new Set(b)
  if (x.size !== y.size) return false
  for (const v of x) if (!y.has(v)) return false
  return true
}

/**
 * 最终安全闸。返回非空字符串 = **整次放弃**(不做部分应用)。
 *
 * 环检测是**比较 before / after 两个集合**的,不是直接看 after:`depCycleMembers` 用的是
 * Kahn,而 Kahn 的集合含「环的**下游**」—— 直接用会把「本节点本来就在某个既有环的下游」
 * 误报成「这次重算成了环」,然后给用户一句不对症的解释。
 */
export function finalGuard(
  node: TaskNode, byId: Map<string, TaskNode>, before: readonly string[], after: readonly string[],
): string | undefined {
  for (const id of after) {
    if (id === node.id) return '算出来的依赖里有它自己,已整次放弃'
    if (inSubtreeOf(node.id, id, byId)) return `算出来的依赖里有本任务的上级(${id})—— 父子门与依赖门会互相等待,已整次放弃`
    if (inSubtreeOf(id, node.id, byId)) return `算出来的依赖里有本任务自己的子任务(${id}),已整次放弃`
  }
  const nodes = [...byId.values()]
  const cycleBefore = depCycleMembers(nodes.map(n => (n.id === node.id ? { ...n, deps: [...before] } : n)))
  const cycleAfter = depCycleMembers(nodes.map(n => (n.id === node.id ? { ...n, deps: [...after] } : n)))
  for (const id of cycleAfter) {
    // 措辞要同时盖住两种读法:真的成了环,以及「指进了一条本来就推不动的依赖链」。
    // Kahn 的集合含环的下游,两者在这里分不开 —— 而对用户来说下一步是同一件事。
    if (!cycleBefore.has(id)) {
      return '算出来的新依赖会落进一条成环 / 推不动的依赖链,已整次放弃(依赖保持原样)'
    }
  }
  return undefined
}

/**
 * 关口要印的那几行。
 *
 * **按行造,不按段造**:折行是按显示宽度切的,一条长行会在 `root/01-x/02-y` 中间断开。
 *
 * **三句知情同意排在最前面**:关口那套夹取是**从尾部**夹的,而这三句正是用户按下确认前
 * 唯一能知道代价的地方 —— 排在后面等于终端一矮就先被吃掉。per-item 的理由行会随项数
 * 线性增长,更要让它们排在后面。
 */
export function recalcLines(plan: RecalcPlan, byId: ReadonlyMap<string, TaskNode>, parentId: string | null): string[] {
  const strip = (s: string): string =>
    // 这些字符串直接来自模型的回答(why / 被丢弃的 id / 警告里嵌的标题)。node.md、run.md、
    // 详情页三处都过了 stripControl,唯独关口这一屏没过 —— 一个 ESC[2J 在这里就是清屏。
    // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
    s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const out: string[] = [
    '这次重算只看任务树上的标题 / 目标 / 方案,**不读代码**。',
    '细化之后,本任务起跑时被依赖任务的其它子任务可能还没合进来 —— 工作区里看不到它们的代码;',
    '  本任务的产出也会在它们完成之前就合进你当前的分支;那一层的集成验收也还没开,',
    '  它可能返工、甚至补救拆分出新的子任务(那些节点此刻还不存在,新依赖不会覆盖它们)。',
    /**
     * **「为什么保留了 3 个孙子任务而不是 1 个子任务」必须在这里说。**
     *
     * 规范验收席的原话:用户唯一读得到的那一屏,关于上卷只有一句「条数超上限时会卷成
     * 父任务」—— 描述的正是**没有发生**的那种情况。他看到细项被保留时,屏幕上没有一个字
     * 说这是故意的、而且它比写父任务解锁得更早。理由只写在 README 和方案里等于没写。
     */
    '没超条数上限时**保留更细的那一份**:依赖一组子任务解锁必然不晚于依赖它们的父任务',
    '  (父任务还要多过一整场集成验收),所以细的严格更优。超了才会卷,并且优先卷',
    '  「全部子任务都被选中」的那一组。',
    '',
  ]
  /**
   * **警告排在明细之前。**
   *
   * 关口那套夹取是**从尾部**夹的(`redoSummaryLines`)。最终安全闸触发时,「已整次放弃
   * (依赖保持原样)」**只存在于这些警告里** —— 排在最后的话,30 行终端上它第一个被吃掉,
   * 而用户看到的是一屏细化明细加一个「回车 返回」的页脚。
   */
  for (const w of plan.warnings) out.push(strip(w))
  if (plan.warnings.length > 0) out.push('')
  for (const p of plan.perDep) {
    out.push(`依赖:${depLabel(p.dep, byId, parentId)}`)
    if (p.keptCoarse) {
      out.push(`  → 保持原样(${p.keptCoarse})`)
    } else {
      for (const n of p.needs) {
        out.push(strip(`  → ${depLabel(n.id, byId, parentId)}  ${n.id}`))
        if (n.why) out.push(strip(`     因为:${n.why}`))
      }
    }
    if (p.rolledUp.length > 0) out.push(`  · 已上卷 ${p.rolledUp.length} 处(条数超上限)`)
    for (const d of p.dropped) out.push(strip(`  · 丢弃:${d}`))
  }
  if (plan.unchanged) out.push('', '结果:依赖**没有变化**。')
  // before 去重再数:node.deps 可以含重复,而 after 是去重的 —— 拿没去重的报数,
  // 一次把 [乙,乙] 细化成一条会被说成「从 2 条变成 1 条」,而真相是从 1 条变成 1 条。
  else out.push('', `结果:依赖从 ${new Set(plan.before).size} 条变成 ${plan.after.length} 条。`)
  return out
}

/**
 * 应用那一刻的重新校验 —— **和扫描时逐字同一份判据**。
 *
 * 模型调用是分钟级的,期间别的节点完全可以把这个节点的依赖改了(重做的
 * `dependencyRewrites` 就会),树的形状也会变。
 */
export function revalidateRecalc(
  node: TaskNode, byId: Map<string, TaskNode>, plan: RecalcPlan,
  opts: Parameters<typeof recalcScope>[2] = {},
): string | undefined {
  const scope: RecalcScope | RecalcRefusal = recalcScope(node, byId, opts)
  if (scope.ok !== true) return `树在这期间变了:${scope.reason}`
  if (!sameSet(node.deps, plan.before)) return '树在这期间变了:本任务的依赖已经被别的操作改过,请重新按 d'
  for (const id of plan.after) {
    /**
     * **本来就悬空的那一条不算「树变了」。**
     *
     * `recalcScope` 专门为「依赖在树里找不到」写了一条 kept(措辞是「重算不碰它」),
     * 于是那个 id 原样进 `after`;而这里再无条件要求每个 id 都在树里,同一个文件里
     * 两条判据互相否定 —— 树一个字节没变,用户却被告知「树在这期间变了,请重新按 d」,
     * 而重新按多少次结果都一样。判据改成「**这次新加进来的** id 必须还在」。
     */
    if (!byId.has(id) && !plan.before.includes(id)) {
      return `树在这期间变了:${id} 已经不在树里,请重新按 d`
    }
    if (byId.get(id)?.status === 'ACCEPTED' && !subtreeFullyAccepted(id, byId)) {
      return `树在这期间变了:${id} 自称已完成、底下却还有没完成的子任务,请重新按 d`
    }
  }
  return finalGuard(node, byId, plan.before, plan.after)
}
