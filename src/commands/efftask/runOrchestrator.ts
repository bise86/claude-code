import type { RunControl } from '../../tools/efftask/control.js'
import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import type { PipelineCtx } from '../../tools/efftask/pipeline.js'
import { writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { logError } from '../../utils/log.js'
import type { WorktreePool } from '../../tools/efftask/worktreePool.js'
import type { HandoffSummary } from '../../tools/efftask/startupConfirm.js'
import { countStatuses } from '../../tools/efftask/stateMachine.js'
import { finishEffTaskRun, markEffTaskPendingHandoff, registerEffTaskRun, updateEffTaskRun } from '../../tasks/EffTaskTask/EffTaskTask.js'
import type { SetAppState } from '../../Task.js'

export type Outcome = { status: 'completed' | 'blocked'; reason?: string }

/**
 * The runner view's phases. Declared HERE rather than in efftask.tsx because runOrchestrator
 * takes a setPhase callback and efftask.tsx imports this module — one definition, no cycle.
 * A second copy silently drifts the moment a phase is added.
 */
export type Phase =
  | 'parsing' | 'picking' | 'recovering'
  // 'drafting'/'confirmRoot' are 启动关口第三关 (spec §2): the root plan + first-level tree is
  // drafted, then shown for confirmation/modification BEFORE autonomous execution begins.
  // 'handoff' 是收口关口(spec §8):run 早已跑完、终端也早还给用户了,
  // `/et --resume` 进来发现 run.md 里还有 pendingHandoff,就先渲染它。
  // 'confirmRedo' 是重做关口:从 done 视图按 r 进来,确认后**重新启动一次编排**
  // (startRun 带着改过的树当 seed)。不是一个新的运行阶段,是 done 的一个岔路。
  | 'confirm' | 'drafting' | 'confirmRoot' | 'confirmResume' | 'handoff' | 'running' | 'done' | 'fatal'
  | 'confirmRedo'
  // 'confirmSkip' 是重做的兄弟岔路:跳过失败的那个环节继续往下走。同样不是一个新的运行
  // 阶段,而是 done 的一条分支 —— 确认之后 startRun 带着改过的树重新起跑。
  | 'confirmSkip'

/**
 * Drive one run to completion and report it.
 *
 * Lives outside efftask.tsx (which is JSX + React) because it is neither: it is the seam
 * between the orchestrator and the two things the UI owes the user afterwards — the outcome
 * and the final run.md. Both were once lost to a single unbound identifier here, so this
 * module is deliberately importable and directly testable without mounting anything.
 */
export async function runOrchestrator(
  args: {
    config: EffTaskConfig
    runDir: string
    fs: FsLike
    runAgent: RunAgentFn
    signal: AbortSignal
    seed?: TaskNode[]
    /** 运行中的人工干预面 —— 暂停 / 追加指令 / 取消单个节点。 */
    control?: RunControl
    worktrees?: WorktreePool
    /** 升级人工 (spec §8): a conflict the node could not resolve itself. */
    onEscalate?: PipelineCtx['onEscalate']
    /** 触阀升级 (spec §9/§11): a node stopped by a safety valve or a rework limit. */
    onBlocked?: PipelineCtx['onBlocked']
    /** 子 agent 实时输出 (spec §10.2): streamed per node, for the detail view. */
    openStream?: PipelineCtx['openStream']
    cwd?: PipelineCtx['cwd']
    /** 并行占用 (spec §10.1): called ONCE with a live reader for the status bar. */
    onPool?: (read: () => { inUse: number; limit: number }) => void
    /**
     * 后台任务登记 (spec §10): make this run visible in `/tasks` and the footer pill, with
     * live counts, and stoppable from there through the run's OWN controller.
     *
     * Lives here rather than in the command's React tree for the reason this whole module
     * exists: the .tsx is not importable by a test (it renders Ink and touches the real
     * store), and the last two features wired there were dead in production while every
     * test passed over the severed wire.
     */
    taskEntry?: {
      runId: string
      runDir: string
      setAppState: SetAppState
      /** The RUN's controller. A private one would mark the task killed and stop nothing. */
      abortController: AbortController
    }
  },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: Phase) => void,
  onHandoff?: (h: HandoffSummary) => void,
): Promise<void> {
  // Serialize run.md writes. onUpdate fires on EVERY state transition; firing writeFile
  // unawaited each time lets concurrent writes to the same path interleave into a corrupt
  // manifest. One promise queue ⇒ strictly ordered, last-write-wins.
  let manifestQueue: Promise<void> = Promise.resolve()
  const queueManifest = (nodes: TaskNode[], result?: Outcome): Promise<void> => {
    /**
     * 运行中调过的并发度要落进 run.md。
     *
     * `--resume` 的并发上限是从 run.md 读回来的(readRunManifest → config.parallelism),
     * 所以不同步的话「我把它从 5 调到 10」在下一次恢复时静默变回 5,而屏幕上从没说过这件事。
     * run.md 同时也是事后唯一能回答「这一趟到底是按几并发跑的」的地方。
     *
     * 写在这里而不是在按键处理里:这是**落盘**这一侧的事,而这个函数是 run.md 的唯一
     * 写入点。按键那侧只改 control(唯一真相),两处各写一份的话它们迟早不一致。
     */
    const liveParallelism = args.control?.parallelism()
    if (liveParallelism !== undefined) args.config.parallelism = liveParallelism
    manifestQueue = manifestQueue
      .then(() => writeRunManifest(args.fs, args.runDir, args.config, nodes, result))
      .catch(logError)
    return manifestQueue
  }
  const entry = args.taskEntry
  // Registered before the first step and ONLY here, so a run abandoned at a confirmation
  // gate never shows up as something the user can stop.
  //
  // GUARDED like every other store touch below it. Unguarded, a failing store setter threw
  // straight out of runOrchestrator before the run's first step — a cosmetic panel entry
  // taking down the work it was supposed to describe.
  let taskId: string | null = null
  if (entry) {
    try {
      taskId = registerEffTaskRun(entry.setAppState, {
        runId: entry.runId, runDir: entry.runDir,
        counts: countStatuses(args.seed ?? []),
        abortController: entry.abortController,
      })
    } catch { /* panel only — the run is what matters */ }
  }
  // A crashing store must not take the run down with it — same discipline as safeUpdate.
  const touch = (nodes: TaskNode[]): void => {
    if (!taskId || !entry) return
    try { updateEffTaskRun(taskId, entry.setAppState, countStatuses(nodes)) } catch { /* panel only */ }
  }
  const settle = (o: Outcome): void => {
    if (!taskId || !entry) return
    // The SIGNAL decides whether this was a user stop — not the reason text, which can be the
    // literal '已中断' recovered from a previous session's node.md while nobody touched this run.
    // settle 可能在 reclaim **之前**跑(异常路径),所以这里读的是「此刻 config 上有没有」。
    try { finishEffTaskRun(taskId, entry.setAppState, o, args.signal.aborted, !!args.config.pendingHandoff) } catch { /* panel only */ }
  }
  /**
   * 收口 (spec §8): reclaim the worktrees and tell the user where their work landed.
   *
   * Hoisted out of the happy path and into `finally`, because it used to sit AFTER
   * `await orch.run()` inside the try — so the `catch` below skipped it entirely. That catch
   * exists precisely because run() might reject despite its own claim not to, and on that
   * path the user got the worst possible outcome: every node worktree leaked, the integration
   * worktree unreclaimed, and NO handoff at all — the done view appeared without even naming
   * the branch holding their commits. Reported by a compliance audit; `runOrchestrator.test.ts`
   * already drove that exact path and asserted nothing about disposal.
   *
   * Idempotent by construction: `ran` makes it a no-op the second time, so the finally block
   * cannot double-dispose after the happy path already did it.
   */
  let ran = false
  // run 的结局,收口关口要带上它 —— 别邀请用户合并一棵没做完的树。reclaim 可能在
  // orch.run() 返回前(异常路径)就跑,所以默认按「被阻断」算,拿到真结果再覆盖。
  let pendingOutcome: Outcome = { status: 'blocked', reason: '未知' }
  const reclaim = async (nodes: TaskNode[]): Promise<void> => {
    if (ran || !args.worktrees) return
    ran = true
    try {
      // dispose FIRST: it reclaims what is provably safe, so handoff then reports only the
      // worktrees that genuinely still hold something. Reporting before reclaiming would list
      // directories that are about to disappear.
      await args.worktrees.dispose(nodes)
      const h = await args.worktrees.handoff(nodes)
      onHandoff?.(h)
      // 挂到 config 上 → 下一次 queueManifest 把它写进 run.md。**独立于 status**:
      // status 先写下 completed 而集成分支还没处置,用户直接关终端就再也没人管那条分支
      // 了(reseat 只捞活动态节点,根节点已 ACCEPTED)。
      //
      // commits === 0 时不留 —— 没有任何改动就没什么可收口的,留下它只会让下次 --resume
      // 弹一个四选一去处置一条空分支。
      if (h.commits > 0) {
        args.config.pendingHandoff = {
          branch: h.branch, commits: h.commits, integrationPath: h.integrationPath,
          kept: h.kept, salvage: h.salvage,
          outcome: pendingOutcome.status, ...(pendingOutcome.reason ? { reason: pendingOutcome.reason } : {}),
        }
      }
    } catch (e) {
      logError(e instanceof Error ? e : new Error(String(e)))
    }
  }
  let liveNodes: TaskNode[] = []
  try {
    const persist = (n: TaskNode) => writeNode(args.fs, args.runDir, n)
    const now = () => new Date().toISOString()
    const orch = new EffTaskOrchestrator(
      args.config,
      {
        runAgent: args.runAgent,
        persist,
        now,
        worktrees: args.worktrees,
        control: args.control,
        // So blockWithReason can write the REAL retry command into blockedReason (run.md is
        // where suppressed escalations have to remain actionable).
        runId: args.taskEntry?.runId,
        onEscalate: args.onEscalate,
        onBlocked: args.onBlocked,
        openStream: args.openStream,
        cwd: args.cwd,
        onUpdate: nodes => {
          setNodes([...nodes])
          touch(nodes)
          void queueManifest(nodes)
        },
      },
      args.signal,
      args.seed, // resume: adopt the recovered tree instead of minting a fresh root
    )
    // 并行占用 (spec §10.1): hand the panel a LIVE reader, once. A per-tick callback would
    // fire many times a second for a number that only the header shows.
    args.onPool?.(() => orch.slotUsage())
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    void queueManifest(orch.nodes()) // run.md exists from the first frame, not just at the end
    liveNodes = orch.nodes()
    const result = await orch.run() // { status, reason }
    liveNodes = orch.nodes()
    pendingOutcome = result
    await reclaim(orch.nodes())
    setNodes([...orch.nodes()])
    setOutcome(result)
    settle(result)
    await queueManifest(orch.nodes(), result) // final manifest records {status, reason}
  } catch (e) {
    // run() is not supposed to reject (the orchestrator catches per-step), but if it ever
    // does, the UI must NOT wedge on 'running' with no way out.
    const failed: Outcome = { status: 'blocked', reason: e instanceof Error ? e.message : String(e) }
    pendingOutcome = failed
    setOutcome(failed)
    // …and the /tasks row must not sit at 运行中 forever for a run that is over. This path
    // is the one that leaves a task with no other way to reach a terminal status.
    settle(failed)
  } finally {
    // The reclaim the happy path may not have reached. A no-op when it did.
    await reclaim(liveNodes)
    // 待收口状态必须落盘,而异常路径上 happy path 的那次 queueManifest 根本没跑到 ——
    // 于是 pendingHandoff 被设进 config、一次也没写出去,集成分支再没人处置。
    // 幂等:happy path 已经写过时这只是再写一遍同样的内容。
    if (args.config.pendingHandoff) await queueManifest(liveNodes, pendingOutcome)
    // 面板同理:异常路径上 settle() 已经在 catch 里跑过了(那时 reclaim 还没发生),
    // 所以「待收口」得在这里补一次。终态任务只改描述,不动 status。
    if (args.config.pendingHandoff && taskId && entry) {
      try { markEffTaskPendingHandoff(taskId, entry.setAppState) } catch { /* panel only */ }
    }
    setPhase('done') // the done view is ALWAYS reached
  }
}
