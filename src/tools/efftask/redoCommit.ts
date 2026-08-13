import { removeNodeDirs, writeNode, writeRunManifest, type FsLike } from './persistence.js'
import { createNodeJournal } from './nodeJournal.js'
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
  /**
   * 隔离工作区池。没有隔离时是 undefined —— 那就没有工作区要放。
   *
   * **走 `discard` 而不是 `release`**(用户第 2、4 条):release 的判据是「干净(带
   * `--ignored`)+ 已合入」,而 `target/` 的存在必然让它拒绝 —— 于是重做在真实运行里
   * 一个工作区都放不掉,而执行者读到的 `REDO_NOTE_*` 逐字写着「隔离工作区已重置为集成
   * 分支最新状态」。discard 先把未提交的固化+抢救,再把目录整个删掉,下一次 `acquire`
   * 从集成分支 tip 重建 = 用户要的「删除其 target,要重新同步」。
   *
   * 老形状(只有 `release`)仍然收:测试和别处的调用方给的是它,而那时行为退回从前。
   */
  pool?: {
    discard?(node: TaskNode): Promise<{
      removed: boolean; keptBecause?: string; salvaged?: string; branchKept?: string
    }>
    release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }>
  }
  /** 重做**之前**的节点,release 要用它们算路径。 */
  before: readonly TaskNode[]
  /** 每一步的日志出口(落盘失败不阻断重做,但不能无声无息)。 */
  onError?: (e: Error) => void
}

export async function commitRedo(deps: RedoCommitDeps, plan: RedoPlan): Promise<{ problems: string[] }> {
  const problems: string[] = []
  const journal = createNodeJournal({ fs: deps.fs, runDir: deps.runDir })
  const byId = new Map(deps.before.map(n => [n.id, n]))

  for (const w of plan.worktreesToRelease) {
    const original = byId.get(w.nodeId)
    if (!original) continue
    try {
      /**
       * `discard` 优先(见 `RedoCommitDeps.pool`)。它做的是用户第 4 条要的那件事:
       * 先把未提交的固化并抢救成一条唯一命名的 ref,再把目录**整个**删掉 ——
       * 包括被 `.gitignore` 忽略的构建产物,而那正是第 2 条要的「重新编译」。
       */
      const r = deps.pool?.discard
        ? await deps.pool.discard(original)
        : await deps.pool?.release(original)
      // 池不存在时 r 是 undefined —— 那不是失败,是这次 run 本来就没隔离。
      if (r && !r.removed) {
        problems.push(`${w.nodeId} 的工作区保留在 ${w.path}:${r.keptBecause ?? '未知原因'}`)
      }
      /**
       * 抢救出来的那条 ref **必须念给用户听**。
       *
       * 它是「这次重做把上一版产出放哪儿了」的唯一答案,而重做本身是用户主动按下的
       * 不可逆动作 —— 静默保留和静默删除是同一类毛病的两面。
       */
      const salvaged = (r as { salvaged?: string } | undefined)?.salvaged
      if (salvaged) {
        problems.push(`${w.nodeId} 重做前的产出已抢救到分支 ${salvaged}(没有丢失,可用 git show 查看)`)
      }
      const branchKept = (r as { branchKept?: string } | undefined)?.branchKept
      if (branchKept) {
        problems.push(`${w.nodeId} 的工作区已删除,但分支 ${branchKept} 没删掉 —— 它会一直留在 git branch 里`)
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

  let writeFailed = 0
  /** 写失败、而且盘上那份还指着**已被删掉的**节点的:见下面那条修法。 */
  const danglingDeps: { id: string; deps: string[] }[] = []
  const deletedSet = new Set(plan.deleted)
  for (const n of plan.nodes) {
    try {
      /**
       * **状态账要一起写。** `writeNode` 的 journal 参数在生产路径上是必须的
       * (persistence 那边逐字写着):`node.md` 是覆盖写,磁盘满的那一刻盘上留着的是
       * **上一次**的完整文件 —— 这次重做/回溯的全部状态变化就此不存在。而账是只增不改的,
       * 七十 KB 写不下去时它往往还写得下。
       */
      await writeNode(deps.fs, deps.runDir, n, journal)
    } catch (e) {
      // 落盘失败不该拦住重做本身(内存里的树是对的,run 照跑),但**必须说** ——
      // 否则这次重做在下一次 --resume 时会整个消失。
      writeFailed++
      problems.push(`${n.id} 没能写回盘上(下次恢复会读到旧状态): ${e instanceof Error ? e.message : String(e)}`)
      const stale = (deps.before.find(b => b.id === n.id)?.deps ?? []).filter(d => deletedSet.has(d))
      if (stale.length > 0) danglingDeps.push({ id: n.id, deps: stale })
      deps.onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }
  /**
   * **写失败 + 盘上那份还指着被删掉的节点 = 永久死节点。** 这条话必须点名到 id。
   *
   * 以前这里只讲 `childIds` 那一种,而那时是完备的:`deps` 恒为兄弟,所以「一个活下来的
   * 节点的 dep 落在被删子树里」结构上不可达。**依赖重算让这条死路第一次通电** —— 甲依赖
   * 乙的某个子任务,用户重做乙,那个子任务被删,而甲的 node.md 没写回去。
   *
   * 后果比「子节点缺失」更硬:下一次 `--resume` 会以「依赖节点缺失」阻断,而
   * `validateLoadedNodes` 的 `block()` 把 `interrupted` / `capBlocked` / `mergeConflict`
   * 三个复活开关**全部清零** —— `--retry-blocked` 和重做都救不回来,只能手改 node.md。
   * 所以这句话必须自带修法(和上面那条同规矩)。
   */
  for (const d of danglingDeps) {
    // 改成什么,由这次重做自己算出来的改写表回答(它把被删的 dep 改指到重做目标)。
    const to = [...new Set(
      plan.dependencyRewrites.filter(r => r.nodeId === d.id && d.deps.includes(r.from)).map(r => r.to),
    )].join('、')
    problems.push(
      `${d.id} 没写回去,而盘上那份还依赖着已经被删掉的 ${d.deps.join('、')} —— ` +
      `下次 --resume 会以「依赖节点缺失」阻断,而且 --retry-blocked 也救不回来(那条路会把复活开关一起清掉)。` +
      `修法:手工把 ${deps.runDir}/${d.id}/node.md 里 deps 中的这几项改成 ${to || '重做目标本身'}`,
    )
  }
  if (writeFailed > 0 && plan.deleted.length > 0) {
    /**
     * 「读到旧状态」这句话在**删过子树**的情况下是不完整的,而不完整的部分正是要命的:
     * 子树的 node.md 已经删掉了,父节点却没能写回去 —— 盘上于是留着一个 childIds 指向
     * 一批不存在节点的父节点。下一次 `--resume` 会以「子节点缺失」阻断,而用户按这句话
     * 的字面意思以为只是「回到重做之前」。
     *
     * 顺序改不掉这个问题,只能换一种失败:先写后删的话,一次失败的删除会留下一批
     * node.md 齐全、看起来很新的幽灵。至少「子节点缺失」是 resumeCore **会检测出来并
     * 明说**的一种,所以保持这个顺序,把话讲全。
     */
    problems.push(
      `${plan.deleted.length} 个子任务已经从盘上删掉,但父节点没写回去 —— ` +
      `下次 --resume 会以「子节点缺失」阻断。修法:手工把 ${deps.runDir} 里那个父节点 ` +
      `node.md 的 childIds 清空`,
    )
  }

  try {
    await writeRunManifest(deps.fs, deps.runDir, deps.config, plan.nodes)
  } catch (e) {
    deps.onError?.(e instanceof Error ? e : new Error(String(e)))
  }

  return { problems }
}
