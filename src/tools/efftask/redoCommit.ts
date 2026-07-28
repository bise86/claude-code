import { removeNodeDirs, writeNode, writeRunManifest, type FsLike } from './persistence.js'
import type { RedoPlan } from './redo.js'
import type { EffTaskConfig, TaskNode } from './types.js'

/**
 * 把一次算好的重做**落到盘上**。
 *
 * 这段本来长在 efftask.tsx 的 useCallback 里,搬出来的理由和 runOrchestrator 当初搬出来
 * 的一样:那个文件挂不起来,于是唯一守得住它的手段是「断言源码里有这行字」——
 * 而源码文本闸门证明不了**顺序和可达性**。实测:把删子树那段整个停用(`if (false)`),
 * 文本还在、顺序还对,闸门照绿。搬到这里之后,顺序变成一条能真的跑出来的断言。
 *
 * 三步的顺序每一步都能单独毁掉这次重做:
 *
 *  1. **先放隔离工作区** —— release 要拿原节点算路径和分支,而下一步就把它们删了;
 *     并且 release 对**脏的或者没合入的**工作区会拒绝删除,那正是想要的:重做不该顺手
 *     毁掉用户还没合并的产出。
 *  2. **再删盘上的子树** —— loadRun 是照着目录树走的,留下的 node.md 会在下一次
 *     \`--resume\` 时原样复活,而内存里的父节点 childIds 已经不认它们了;用户拿到一批
 *     永远等不到的幽灵兄弟,childrenAllAccepted 永久卡住。
 *  3. **最后落盘剩下的节点** —— 依赖被改写过的那些必须写下去,否则重启后读回旧依赖。
 *
 * 返回的 `problems` 全是**这次重做没做成的事**。它们不写日志、直接上屏:一个删不掉的
 * node.md 是会自己长回来的东西,而用户是唯一能处理它的人。
 */
export interface RedoCommitDeps {
  fs: FsLike
  runDir: string
  config: EffTaskConfig
  /** 隔离工作区池。没有隔离时是 undefined —— 那就没有工作区要放。 */
  pool?: { release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }> }
  /** 重做**之前**的节点,release 要用它们算路径。 */
  before: readonly TaskNode[]
  /** 每一步的日志出口(落盘失败不阻断重做,但不能无声无息)。 */
  onError?: (e: Error) => void
}

export async function commitRedo(deps: RedoCommitDeps, plan: RedoPlan): Promise<{ problems: string[] }> {
  const problems: string[] = []
  const byId = new Map(deps.before.map(n => [n.id, n]))

  for (const w of plan.worktreesToRelease) {
    const original = byId.get(w.nodeId)
    if (!original) continue
    try {
      const r = await deps.pool?.release(original)
      // 池不存在时 r 是 undefined —— 那不是失败,是这次 run 本来就没隔离。
      if (r && !r.removed) {
        problems.push(`${w.nodeId} 的工作区保留在 ${w.path}:${r.keptBecause ?? '未知原因'}`)
      }
    } catch (e) {
      problems.push(`${w.nodeId} 的工作区未能释放: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (plan.deleted.length > 0) {
    try {
      const { failed } = await removeNodeDirs(deps.fs, deps.runDir, plan.deleted)
      for (const f of failed) {
        problems.push(`${f.id} 的记录没删掉(下次恢复会复活它): ${f.message}`)
      }
    } catch (e) {
      problems.push(`删除子任务记录失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const n of plan.nodes) {
    try {
      await writeNode(deps.fs, deps.runDir, n)
    } catch (e) {
      // 落盘失败不该拦住重做本身(内存里的树是对的,run 照跑),但**必须说** ——
      // 否则这次重做在下一次 --resume 时会整个消失。
      problems.push(`${n.id} 没能写回盘上(下次恢复会读到旧状态): ${e instanceof Error ? e.message : String(e)}`)
      deps.onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }

  try {
    await writeRunManifest(deps.fs, deps.runDir, deps.config, plan.nodes)
  } catch (e) {
    deps.onError?.(e instanceof Error ? e : new Error(String(e)))
  }

  return { problems }
}
