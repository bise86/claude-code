/**
 * 节点修复的**不纯那一半**:读残骸、发那一次主模型调用、解析、落盘。
 *
 * 判据全在 `nodeRepair.ts`(纯函数,可测);这里只负责顺序、失败的说法,以及
 * **「能不问就不问」** —— 前两级(状态账 / frontmatter 残骸)在 `loadRun` 里已经做过一遍,
 * 走到这里如果已经补齐了,就不该再烧一次模型调用。
 */
import { answerTag, parseRepair } from './parseOutput.js'
import { nodeMdPath, writeNode, type FsLike } from './persistence.js'
import { readNodeJournal, type NodeJournal } from './nodeJournal.js'
import {
  applyRepair, damageOf, repairPrompt, sanitizeRepair,
  type RepairContext, type RepairPatch,
} from './nodeRepair.js'
import type { StreamHandle } from './agentStream.js'
import type { TaskNode } from './types.js'

export interface RepairDeps {
  fs: FsLike
  runDir: string
  /** 主模型、零工具那条缝。和依赖重算共用同一个形状。 */
  runAgent: (args: { node: TaskNode; prompt: string; signal: AbortSignal; stream?: StreamHandle }) => Promise<string>
  byId: () => Map<string, TaskNode>
  openStream?: () => StreamHandle
  journal?: NodeJournal
}

export type RepairOutcome =
  | { ok: true; node: TaskNode; patch: RepairPatch; asked: boolean; rejected: string[]; note?: string }
  | { ok: false; kind: 'not-damaged' | 'aborted' | 'call-failed' | 'unparsed' | 'write-failed'; reason: string }

/**
 * 扫一个节点还缺什么 —— 关口打开时先跑它,把「要不要发调用」摆给用户看。
 *
 * **读盘,不读内存**:内存里那份已经被 `validateLoadedNodes` 补过一轮默认值了
 * (空数组、CREATED),照着它扫会得出「什么都不缺」,而盘上那份仍然是坏的。
 */
export async function scanRepair(
  node: TaskNode, deps: RepairDeps,
): Promise<{ damage: ReturnType<typeof damageOf>; raw?: string; journalRecords: number }> {
  let raw: string | undefined
  try { raw = await deps.fs.readFile(nodeMdPath(deps.runDir, node.id)) } catch { /* 没有就没有 */ }
  const j = await readNodeJournal(deps.fs, deps.runDir, node.id)
  return { damage: damageOf(node), raw, journalRecords: j?.records ?? 0 }
}

/**
 * **这个函数收到的节点按定义是坏的。**
 *
 * 它的每一个字段都可能不在 —— `childIds` 丢了正是 `damageOf` 列出来的损伤之一。
 * 第一版直接写 `node.childIds.length`,于是「修复」功能在**它唯一要处理的那种输入**上
 * 当场抛异常(三条用例同时红)。这里所有的字段访问都必须先判形状。
 */
function contextFor(node: TaskNode, raw: string | undefined, byId: Map<string, TaskNode>): RepairContext {
  const parent = typeof node.parentId === 'string' ? byId.get(node.parentId) : undefined
  const kids = Array.isArray(node.childIds) ? node.childIds : []
  const sibs = parent && Array.isArray(parent.childIds) ? parent.childIds : []
  return {
    node,
    ...(raw === undefined ? {} : { raw }),
    ...(parent
      ? {
          parent: {
            title: parent.title, goal: parent.goal,
            ...(parent.plan?.solution ? { solution: parent.plan.solution } : {}),
          },
        }
      : {}),
    // 兄弟里**排除自己** —— 把自己的标题混在「同级任务」里,等于把「要你补的东西」
    // 当成已知事实喂回去,模型会照抄一个可能本来就是坏的值。
    ...(sibs.length > 0
      ? { siblings: sibs.filter(c => c !== node.id).map(c => byId.get(c)?.title).filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(kids.length > 0
      ? { children: kids.map(c => byId.get(c)?.title).filter((t): t is string => typeof t === 'string') }
      : {}),
  }
}

/**
 * 修一个节点。
 *
 * 顺序上有两条是硬的:
 *  1. **调用回来先判 `signal.aborted` 再解析** —— 适配层在已 abort 时**返回空串、不抛**,
 *     而空串解析出来和「模型没答」逐字相同,会把一次用户取消报成「模型没按格式答」。
 *     (这条判据是从 `askRecalc` 逐字搬过来的,同一个适配层、同一个坑。)
 *  2. **落盘失败要说出来,而且不能只改内存** —— 这个功能的全部目的就是让盘上那份变好;
 *     内存改了盘上没改,下一次 `--resume` 会把同一个坏节点原样端回来,而用户以为修好了。
 */
export async function repairNode(
  node: TaskNode, deps: RepairDeps, signal: AbortSignal,
  opts?: { skipModel?: boolean },
): Promise<RepairOutcome> {
  const scan = await scanRepair(node, deps)
  const damage = scan.damage
  if (damage.blocking.length === 0 && damage.soft.length === 0) {
    return { ok: false, kind: 'not-damaged', reason: '这个任务的状态是完整的,没有需要修复的地方。' }
  }

  let patch: RepairPatch = {}
  let rejected: string[] = []
  let asked = false
  let note: string | undefined

  if (opts?.skipModel !== true) {
    asked = true
    const tag = answerTag('repair')
    const prompt = repairPrompt(contextFor(node, scan.raw, deps.byId()), damage)
      // 提示词里那句「语言标记写成 X」必须带上真 tag —— repairPrompt 写的是常量,
      // 而每次调用要用一次性的随机 tag(见 answerTag:防止把铺进去的旧块当成本轮回答)。
      .replace(/repairfix/g, tag)
    let reply: string
    try {
      reply = await deps.runAgent({ node, prompt, signal, ...(deps.openStream ? { stream: deps.openStream() } : {}) })
    } catch (e) {
      return { ok: false, kind: 'call-failed', reason: `修复调用没成功: ${e instanceof Error ? e.message : String(e)}` }
    }
    // 见函数头第 1 条:**先判中止**。
    if (signal.aborted) return { ok: false, kind: 'aborted', reason: '已中止,没有改动任何东西。' }
    const parsed = parseRepair(reply, tag)
    if (!parsed.answer) {
      const why = parsed.ambiguous
        ? '模型给了不止一个修复块,分不清哪个是答案'
        : parsed.broken
          ? '模型的修复块解析不出来'
          : '模型没有给出带标记的修复块'
      // **不当成失败退出**:确定性的那部分(账 + 残骸)已经在 loadRun 里合好了,
      // 结构性的洞下面还会补齐。模型没帮上忙 ≠ 这次修复没意义。
      note = `${why} —— 只按盘上已有的信息恢复。`
    } else {
      const s = sanitizeRepair(parsed.answer, node)
      patch = s.patch
      rejected = s.rejected
    }
  }

  const repaired = applyRepair(node, patch, node.phaseRoles)
  try {
    await writeNode(deps.fs, deps.runDir, repaired, deps.journal)
  } catch (e) {
    return { ok: false, kind: 'write-failed', reason: `修好了但没能写回盘上: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, node: repaired, patch, asked, rejected, ...(note === undefined ? {} : { note }) }
}
