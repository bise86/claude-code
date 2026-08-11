/**
 * 修复一个**损毁的任务节点** —— 详情页 `g` 键的判据那一半(纯函数)。
 *
 * 用户原话:「这些损毁的任务必须恢复回来,可以通过某个键触发,主模型协助来完全正确的恢复。」
 *
 * ## 三级恢复,主模型是**最后**一级
 *
 *  1. **状态账**(`state.jsonl`,只增不改)—— 每一关提交过的结果和状态都在里面,最可信;
 *  2. **半截 node.md 的 frontmatter 前缀** —— 救得回身份,救不回断点之后的字段;
 *  3. **主模型** —— 只在前两级都补不齐时才请,而且**只许它补描述性的字段**。
 *
 * 1 和 2 在 `loadRun` 里就自动做完了(`mergeSalvage`)。这个模块管的是第 3 级:
 * 还缺什么、能不能问、问什么、答回来允许改哪些字段。
 *
 * ## 为什么主模型**不许**碰判决和终态
 *
 * 这是整个功能唯一真正危险的地方。一个 `acceptLog` 里的「通过」是**追责依据**;
 * 让模型「根据上下文推断这个节点应该是通过了的」,产出的是一条署名了却从未发生过的判决 ——
 * 和这个仓库为「强制通过」定下的规矩逐字相反(见第十轮:没有判决可以强制,写一条署名
 * 「人工强制通过」的记录 = 凭空捏造的往事)。
 *
 * 同理 `status`:推成 `ACCEPTED` 会把没做过的活报成完成,而那份产出并不在集成分支上。
 * 所以状态**不问模型**,由 `conservativeStatus` 按「宁可重跑一遍,不可谎报完成」定死。
 *
 * 模型能帮上忙的是另一半:标题、目标、类型、方案正文、验收点 —— 这些是**描述**,
 * 写错了下一关会当场发现(评审/验收都会读它们),而且原文往往就躺在残骸的正文里。
 */
import { LEGAL_STATUS } from './resumeCore.js'
import { NODE_STATUSES, type NodeStatus, type TaskNode } from './types.js'

/**
 * 允许主模型改写的字段。**白名单,不是黑名单。**
 *
 * 黑名单在这个仓库里已经被证伪过一次(`updateUsage` 的自定义字段被静默丢掉):
 * 新增一个字段时,忘记把它加进黑名单的后果是「模型可以改它」,而那正是最坏的默认值。
 */
export const REPAIRABLE_FIELDS = ['title', 'goal', 'kind', 'solution', 'acceptance'] as const
export type RepairableField = (typeof REPAIRABLE_FIELDS)[number]

/**
 * 一个节点**哪里坏了**。
 *
 * `blocking` = 少了它这个节点没法参与调度(身份/类型/状态);
 * `soft` = 缺了不影响跑,但用户会看到一个没有标题、没有方案的任务。
 */
export interface Damage {
  blocking: string[]
  soft: string[]
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function damageOf(node: Partial<TaskNode>): Damage {
  const blocking: string[] = []
  const soft: string[] = []
  if (!isStr(node.id)) blocking.push('没有 id(连它是哪个任务都确定不了)')
  if (node.kind !== 'executable' && node.kind !== 'decompose') {
    // `unknown` 是 createNode 的合法初值(还没分析过的节点),不算损坏。
    if (node.kind !== 'unknown') blocking.push(`类型非法(${String(node.kind)})`)
  }
  if (!isStr(node.status) || !LEGAL_STATUS.has(node.status)) {
    blocking.push(`状态非法或缺失(${String(node.status)})`)
  }
  if (!Array.isArray(node.childIds)) blocking.push('子任务列表丢了')
  if (!Array.isArray(node.deps)) blocking.push('依赖列表丢了')
  if (!isStr(node.title)) soft.push('没有标题')
  if (!isStr(node.goal)) soft.push('没有目标')
  if (node.kind === 'executable' && !isStr(node.plan?.solution)) soft.push('没有方案正文')
  if (node.kind === 'executable' && !isStr(node.plan?.acceptance)) soft.push('没有验收点')
  return { blocking, soft }
}

export function isDamaged(node: Partial<TaskNode>): boolean {
  const d = damageOf(node)
  return d.blocking.length > 0 || d.soft.length > 0
}

/**
 * 状态**不问模型**,按「宁可重跑一遍,不可谎报完成」定。
 *
 * 判据只看**证据**,不看推测:
 *  - 账或残骸里留着一个合法状态 → 就用它(那是真的提交过的);
 *  - 什么都没留下 → `CREATED`。它会让这个节点从头再跑一遍,代价是重复劳动;
 *    而反过来猜一个 `ACCEPTED`,代价是一份**根本不存在的产出**被当成已完成,
 *    父任务据此收口、集成分支据此推进 —— 那是不可逆的。
 */
export function conservativeStatus(node: Partial<TaskNode>): NodeStatus {
  const s = node.status
  if (typeof s === 'string' && (NODE_STATUSES as string[]).includes(s)) return s as NodeStatus
  return 'CREATED'
}

/** 修复补丁 —— 主模型答回来的东西,过完白名单之后的样子。 */
export type RepairPatch = Partial<Record<RepairableField, string>>

/**
 * 把模型的回答收成一份补丁。
 *
 * **只收白名单里的键,只收非空字符串,而且只填「本来就缺」的那些。**
 * 最后那一条是关键:一个字段如果账里有真值,模型给的版本一律不采纳 —— 账是事实,
 * 模型是推测,让推测盖掉事实就是在用更差的信息换更好的。
 */
export function sanitizeRepair(
  raw: unknown, node: Partial<TaskNode>,
): { patch: RepairPatch; rejected: string[] } {
  const patch: RepairPatch = {}
  const rejected: string[] = []
  if (raw === null || typeof raw !== 'object') return { patch, rejected: ['回答不是一个对象'] }
  const obj = raw as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (!(REPAIRABLE_FIELDS as readonly string[]).includes(k)) {
      rejected.push(`${k}(不在可修复字段里)`)
      continue
    }
    if (!isStr(v)) { rejected.push(`${k}(空值)`); continue }
    const already = existing(node, k as RepairableField)
    if (already !== undefined) { rejected.push(`${k}(盘上已有真值,不采纳模型的版本)`); continue }
    if (k === 'kind' && v !== 'executable' && v !== 'decompose') {
      rejected.push(`kind(${v} 不是合法类型)`)
      continue
    }
    patch[k as RepairableField] = v.trim()
  }
  return { patch, rejected }
}

function existing(node: Partial<TaskNode>, f: RepairableField): string | undefined {
  if (f === 'solution') return isStr(node.plan?.solution) ? node.plan!.solution : undefined
  if (f === 'acceptance') return isStr(node.plan?.acceptance) ? node.plan!.acceptance : undefined
  if (f === 'kind') return node.kind === 'executable' || node.kind === 'decompose' ? node.kind : undefined
  const v = (node as Record<string, unknown>)[f]
  return isStr(v) ? v : undefined
}

/**
 * 把补丁落到节点上,并**把结构性的洞补齐**。
 *
 * 结构性的那几项(childIds / deps / iteration / phaseRoles / status)**不经模型**:
 * 它们要么在账里,要么按安全默认值补。空数组是安全的 —— 一个没有依赖的节点会被
 * 立刻调度,而 `validateLoadedNodes` 还会从子节点的 parentId 把 childIds 反向补回来。
 */
export function applyRepair(
  node: Partial<TaskNode>, patch: RepairPatch, phaseRoles: TaskNode['phaseRoles'],
): TaskNode {
  const out = { ...node } as TaskNode
  if (patch.title !== undefined) out.title = patch.title
  if (patch.goal !== undefined) out.goal = patch.goal
  if (patch.kind !== undefined) out.kind = patch.kind as TaskNode['kind']
  if (patch.solution !== undefined || patch.acceptance !== undefined) {
    out.plan = {
      ...(out.plan ?? { solution: '', keyPoints: '', risks: '', acceptance: '' }),
      ...(patch.solution !== undefined ? { solution: patch.solution } : {}),
      ...(patch.acceptance !== undefined ? { acceptance: patch.acceptance } : {}),
    }
  }
  out.status = conservativeStatus(node)
  if (!isStr(out.title)) out.title = out.id?.split('/').pop() ?? '(标题已丢失)'
  if (!isStr(out.goal)) out.goal = out.title
  if (out.kind !== 'executable' && out.kind !== 'decompose') out.kind = 'unknown'
  if (!Array.isArray(out.childIds)) out.childIds = []
  if (!Array.isArray(out.deps)) out.deps = []
  if (!out.plan) out.plan = { solution: '', keyPoints: '', risks: '', acceptance: '' }
  if (!out.phaseRoles) out.phaseRoles = phaseRoles
  if (!out.iteration) out.iteration = { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 }
  if (!Array.isArray(out.reviewLog)) out.reviewLog = []
  if (!Array.isArray(out.acceptLog)) out.acceptLog = []
  if (typeof out.execStatus !== 'string') out.execStatus = ''
  if (typeof out.blockedReason !== 'string') out.blockedReason = ''
  if (!out.score) out.score = {}
  if (typeof out.depth !== 'number') out.depth = Math.max(0, (out.id ?? '').split('/').length - 1)
  return out
}

/** 夹一段文本进提示词。截断要**说出来**,否则模型会把半句话当成全部事实。 */
function clip(s: string, max: number): string {
  const a = Array.from(s)
  return a.length <= max ? s : `${a.slice(0, max).join('')}\n…(还有 ${a.length - max} 字未展示)`
}

/**
 * 围栏中和 —— 和 pipeline 的 `quote()`、depsRecalcRun 的 `neutralize()` 同因。
 *
 * 铺进提示词的是**从坏文件里读出来的原始字节**,里面几乎必然有三反引号(方案正文本来
 * 就带代码块)。不中和的话它会当场把我们自己的代码块劈开 —— 这个仓库为逐字相同的事故
 * 烧穿过一整棵树的迭代预算(见 [[prompt-teaches-the-bug]])。
 */
function neutralize(s: string): string {
  return s.replace(/`/g, "'")
}

export interface RepairContext {
  /** 坏掉的那个节点此刻的样子(账 + 残骸合并之后)。 */
  node: Partial<TaskNode>
  /** node.md 的残骸原文(可能是半截)。没有就不给。 */
  raw?: string
  /** 父任务的标题与目标 —— 判断这个子任务该干什么最有用的上下文。 */
  parent?: { title: string; goal: string; solution?: string }
  /** 兄弟任务的标题,按序。用来判断这一项在整体里的位置。 */
  siblings?: string[]
  /** 这个节点自己的子任务标题 —— 它们本身就是「这个父任务要做什么」的最强证据。 */
  children?: string[]
}

export const REPAIR_TAG = 'repairfix'

/**
 * 提示词。**四条约束,每一条都对应一种已经发生过的坏结果。**
 */
export function repairPrompt(ctx: RepairContext, damage: Damage): string {
  const missing = [...damage.blocking, ...damage.soft]
  const lines: string[] = []
  lines.push('一个任务节点的磁盘文件被写坏了(写到一半被打断),现在要把它恢复回来。')
  lines.push('')
  lines.push('## 已经确定的部分(这些是事实,不要改)')
  lines.push(`- id: ${ctx.node.id ?? '(丢失)'}`)
  if (isStr(ctx.node.title)) lines.push(`- 标题: ${ctx.node.title}`)
  if (isStr(ctx.node.goal)) lines.push(`- 目标: ${clip(ctx.node.goal, 600)}`)
  if (ctx.node.kind === 'executable' || ctx.node.kind === 'decompose') lines.push(`- 类型: ${ctx.node.kind}`)
  if (ctx.children && ctx.children.length > 0) {
    lines.push(`- 它自己的子任务(${ctx.children.length} 个): ${ctx.children.map(c => `「${c}」`).join('、')}`)
  }
  lines.push('')
  lines.push('## 缺失或损坏的部分(要你补的就是这些)')
  for (const m of missing) lines.push(`- ${m}`)
  lines.push('')
  if (ctx.parent) {
    lines.push('## 上级任务')
    lines.push(`标题: ${ctx.parent.title}`)
    lines.push(`目标: ${clip(neutralize(ctx.parent.goal), 800)}`)
    if (isStr(ctx.parent.solution)) lines.push(`上级方案要点: ${clip(neutralize(ctx.parent.solution), 1200)}`)
    lines.push('')
  }
  if (ctx.siblings && ctx.siblings.length > 0) {
    lines.push('## 同级任务(按顺序)')
    for (const s of ctx.siblings) lines.push(`- ${neutralize(s)}`)
    lines.push('')
  }
  if (isStr(ctx.raw)) {
    lines.push('## 损坏文件里还能读出来的原文')
    lines.push('(它在某个位置被硬生生截断,最后一段很可能是半句话)')
    lines.push('')
    lines.push(clip(neutralize(ctx.raw), 6000))
    lines.push('')
  }
  lines.push('## 你要遵守的四条')
  lines.push([
    '1. **只从上面给出的材料里恢复**。原文里写着什么就还原什么;材料里没有的,',
    '   宁可留空也不要编 —— 一个编出来的目标会让接下来的执行者去做一件没人要求过的事。',
  ].join('\n'))
  lines.push([
    '2. **不要判断这个任务做完了没有,也不要给出任何评审、验收结论。**',
    '   那些记录是追责依据,而你没有任何证据能证明某一轮判决发生过。',
    '   任务的状态由程序按「宁可重跑一遍,不可谎报完成」自己定,不用你管。',
  ].join('\n'))
  lines.push([
    '3. **已经确定的部分不要重写**。上面「已经确定」那一节里出现过的字段,',
    '   你给出的同名字段会被直接丢弃 —— 写了也是白写。',
  ].join('\n'))
  lines.push([
    '4. 如果材料实在不足以判断某一项,**就不要输出那一项**。缺一项比错一项好。',
  ].join('\n'))
  lines.push('')
  lines.push('## 输出格式')
  lines.push(`把结果放进一个代码块,语言标记(fence info string)写成 ${REPAIR_TAG},内容是 JSON:`)
  lines.push('')
  lines.push([
    '{',
    '  "title": "任务标题(一句话)",',
    '  "goal": "这个任务要达成什么",',
    '  "kind": "executable 或 decompose",',
    '  "solution": "方案正文(只在原文里真的有的时候给)",',
    '  "acceptance": "验收点(只在原文里真的有的时候给)"',
    '}',
  ].join('\n'))
  lines.push('')
  lines.push('只输出你有把握的键,没把握的整个不要出现。')
  return lines.join('\n')
}
