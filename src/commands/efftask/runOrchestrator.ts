import type { RunControl } from '../../tools/efftask/control.js'
import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import type { PipelineCtx } from '../../tools/efftask/pipeline.js'
import { writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { logError } from '../../utils/log.js'
import type { WorktreePool } from '../../tools/efftask/worktreePool.js'
import type { HandoffSummary } from '../../tools/efftask/startupConfirm.js'
import type { GitFn, HandoffResult } from '../../tools/efftask/handoffActions.js'
import { finishHandoff } from '../../tools/efftask/finishHandoff.js'
import { makeHandoffConflictResolver } from '../../tools/efftask/handoffResolve.js'
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
  // 'confirmForcePass' 是跳过的兄弟岔路:同样让节点越过一个判决环节,但**留下一条署名
  // 「人工强制通过」的裁决**。和上面两个不同的是它**也能从 running 进来** —— 运行中的
  // 预先批准不重启编排,只往 RunControl 上记一笔,确认完直接回运行视图。
  | 'confirmForcePass'
  // 'confirmCleanup' 是详情页的 `c` 键:回收这棵子树里**已验收**任务的隔离工作区。
  // 和上面几条一样是一条岔路而不是运行阶段,但它**既不重启编排、也不动任务树** ——
  // 它唯一改变的是磁盘上那些目录还在不在,所以确认之后原样回到来时那一屏。
  | 'confirmCleanup'
  // 'confirmRecalc' 是详情页的 `d` 键:让主模型把这个任务的粗依赖换成被依赖任务子树里
  // 更细的几项。**只在运行中有**(它要 hold 住节点、还要叫醒调度),也只在**真的要发起
  // 模型调用**时才切到这一屏 —— 准入被拒时不切屏,理由渲染在详情页里(切屏会把任务树
  // 连同详情页整棵卸载,而「什么都没发生」不该长成「你的阅读位置没了」)。
  | 'confirmRecalc'

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
     * 运行中重做 (用户原话:「不需要整体返回失败才能重做任务或阶段,在其它任务还在运行时
     * 就可以重做」)。**调用两次**:开跑时给出这一轮的编排器,收尾时给 `undefined`。
     *
     * 第二次不能省 —— 界面拿它判「现在还有没有人在听」。留着一个已经跑完的编排器,
     * 用户按下的重做会被并进一棵没人再调度的树:屏幕说重做了,而一个调用都不会发生。
     * (`applyLive` 自己还有一道 `finished` 守卫兜底,但那时话已经说出去了。)
     */
    onOrchestrator?: (orch: EffTaskOrchestrator | undefined) => void
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
    /**
     * 收口用的 git 执行器。**给了才会自动把集成分支合回当前目录**(见 finishHandoff)。
     *
     * 可缺省,而缺省时行为与这个功能不存在时逐字相同 —— 既有测试和任何拿不到 git 的
     * 调用点都走那条路。
     */
    git?: GitFn
    /** 收口结果:合成了没有、没合是为什么。UI 拿它写 done 视图那句话。 */
    /**
     * 收口结果:合成了没有、没合是为什么、**推送发生了没有**。
     *
     * `push` 必须在这个类型里:少了它,接线方(efftask.tsx)里那条把推送结果并进
     * followUps 的分支在类型上就是死的 —— 而这个仓库没有 typecheck,死的接线不会有人报错。
     */
    onHandoffResult?: (r: { merged: boolean; result?: HandoffResult; push?: { ok: boolean; message: string } }) => void
  },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: Phase) => void,
  onHandoff?: (h: HandoffSummary) => void,
): Promise<void> {
  /**
   * run.md 的写入队列 —— **串行 + 合并**。
   *
   * 串行是为了不写坏文件:`onUpdate` 每一次状态迁移都会来一次,不排队的话并发 writeFile
   * 会把同一个路径写成交错的半份 manifest。
   *
   * **合并**是为了让大树跑得动,而这一条是量出来的:`renderTreeSnapshot` 整棵树重画一遍,
   * 5000 个节点 ≈ 390 KB / 3.5 ms,20000 个节点 ≈ 1.5 MB / 13 ms(实测)。一个节点一生
   * 至少六次状态迁移,于是「每次迁移都完整写一遍」在 20000 节点上是 12 万次 × 1.5 MB
   * ≈ 180 GB 的写入和二十几分钟的纯渲染 —— 而其中除了最后一次,每一份都在下一次迁移
   * 到来时就作废了。
   *
   * 合并规则:排队时只保留**最新那一份**。一次写入在飞的时候来了 100 次更新,落盘的是
   * 第 100 份,而不是 100 次写。这不丢信息 —— run.md 是一份**快照**,不是日志。
   *
   * `result` 是**粘性**的:最终那一次带着 {status, reason} 进来,而它之后可能还有普通更新
   * (收口那条路就会再写一次)。不粘住的话,那些后续写入会把状态抹回空 —— 而 run.md 的
   * 状态行正是 `--resume` 和事后追责第一眼要看的东西。
   */
  let manifestQueue: Promise<void> = Promise.resolve()
  let pendingSnapshot: TaskNode[] | null = null
  let stickyResult: Outcome | undefined
  let flushing = false
  const flushManifest = async (): Promise<void> => {
    while (pendingSnapshot !== null) {
      const nodes = pendingSnapshot
      pendingSnapshot = null
      await writeRunManifest(args.fs, args.runDir, args.config, nodes, stickyResult).catch(logError)
    }
    flushing = false
  }
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
    /**
     * 运行中调过的严格度同样要落进 run.md,理由与上面并发度**逐字相同** ——
     * `--resume` 的档位是从 run.md 读回来的(readRunManifest → caps.strictness),不同步的话
     * 「我把它降到初级」在下一次恢复时静默变回关口批准的那一档,而屏幕上从没说过这件事。
     */
    const liveStrictness = args.control?.strictness()
    if (liveStrictness !== undefined) args.config.caps.strictness = liveStrictness
    pendingSnapshot = nodes
    if (result !== undefined) stickyResult = result
    if (!flushing) {
      flushing = true
      manifestQueue = manifestQueue.then(flushManifest).catch(logError)
    }
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
  /** 这一趟已经落在用户当前分支上的提交数(reclaim 里从 handoff 读,handoff 从 git 现算)。 */
  let trunkLanded = 0
  const reclaim = async (nodes: TaskNode[]): Promise<void> => {
    if (ran || !args.worktrees) return
    ran = true
    try {
      // dispose FIRST: it reclaims what is provably safe, so handoff then reports only the
      // worktrees that genuinely still hold something. Reporting before reclaiming would list
      // directories that are about to disappear.
      await args.worktrees.dispose(nodes)
      const h = await args.worktrees.handoff(nodes)
      // 逐任务合并已经送进用户分支几次 —— 收口那一步靠它决定「没有待收口 ≠ 什么都没发生」
      // (自动推送在这条正常路径上必须照样发生)。
      trunkLanded = h.trunkLanded ?? 0
      onHandoff?.(h)
      // 挂到 config 上 → 下一次 queueManifest 把它写进 run.md。**独立于 status**:
      // status 先写下 completed 而集成分支还没处置,用户直接关终端就再也没人管那条分支
      // 了(reseat 只捞活动态节点,根节点已 ACCEPTED)。
      //
      // commits === 0 时不留 —— 没有任何改动就没什么可收口的,留下它只会让下次 --resume
      // 弹一个四选一去处置一条空分支。
      if (h.commits > 0) {
        // 降级放行的节点数一起带上 —— `planFinish` 靠它决定「跑完了但没通过判决,
        // 不自动合进用户的检出」。少了它,一次全靠降级放行推完的运行会以 completed
        // 的身份触发自动 merge(见 PendingHandoff.degradedNodes)。
        const degradedNodes = nodes.filter(n => (n.degraded ?? []).length > 0).length
        args.config.pendingHandoff = {
          branch: h.branch, commits: h.commits, integrationPath: h.integrationPath,
          kept: h.kept, salvage: h.salvage,
          outcome: pendingOutcome.status, ...(pendingOutcome.reason ? { reason: pendingOutcome.reason } : {}),
          ...(degradedNodes > 0 ? { degradedNodes } : {}),
          // 收口关口/飞书收口卡那句「你的工作区未被改动」按它改口 —— 中途合成功过的
          // 那些提交早就在用户目录里了。
          ...(trunkLanded > 0 ? { trunkLanded } : {}),
        }
      }
    } catch (e) {
      logError(e instanceof Error ? e : new Error(String(e)))
    }
  }
  /**
   * 把集成分支合回**当前目录**(spec §8 的收口,自动那一半)。
   *
   * ## 为什么排在 `reclaim` 之后、`settle`/最后一次 `queueManifest` 之前
   *
   * 这个位置是**唯一**一个能让三样东西同时说真话的位置:
   *  - `reclaim` 刚把 `config.pendingHandoff` 挂上(它是「还没人处置这条分支」的唯一真相);
   *  - 合并成功后这里把它**清掉**,于是紧随其后的 `queueManifest(nodes, result)` 写出去的
   *    run.md 里就没有它了 —— 下一次 `--resume` 不会再为一条已经合进当前分支的分支弹
   *    四选一(而「丢弃」会对着它跑 `branch -D`)。清完之后自己**不**重写 run.md 是不行的:
   *    happy path 那次 `queueManifest` 在这之后才跑,而 finally 里那次是 `if (pendingHandoff)`
   *    —— 清掉之后它恰好不再触发,盘上那份原样留着。所以顺序必须是「清 → 让后面那次写」;
   *  - `settle(result)` 把 `!!config.pendingHandoff` 交给面板,决定 `/tasks` 那一行是不是
   *    「待收口(/et --resume …)」。排在合并之后,面板才不会去教用户敲一条已经没有关口的命令。
   *
   * 幂等:`handoffDone` 让异常路径上的第二次调用变成空转。永不抛(finishHandoff 自己包了
   * try/catch)—— 这个 finally 里每一句都是被保护的,一个逃出去的异常会让
   * `setPhase('done')` 永不执行,界面永久停在「运行中」而 Esc 毫无反应。
   */
  const onHandoffResult = args.onHandoffResult
  let handoffDone = false
  const handOff = async (): Promise<void> => {
    if (handoffDone || !args.git) return
    handoffDone = true
    /**
     * 收口撞上冲突时派模型去解(用户明确要求:「这个应该要模型自动解决冲突问题」)。
     *
     * 根节点是这一趟的目标本身,拿它当 `RunAgentFn` 的节点 —— 见 makeHandoffConflictResolver。
     * `liveNodes` 在这里已经被编排器填过了(handOff 排在 run 之后),真拿不到根节点就不接线,
     * 收口退回「留下冲突现场」的老行为。
     */
    const root = liveNodes.find(n => n.id === 'root')
    const out = await finishHandoff({
      handoff: args.config.pendingHandoff,
      git: args.git,
      cwd: args.cwd ?? process.cwd(),
      resolveConflict: root
        ? makeHandoffConflictResolver({ runAgent: args.runAgent, node: root, signal: args.signal })
        : undefined,
      // 关口上打开的自动推送。**从 config 读**(不是另开一个参数):它已经被
      // `applyStartupDecision` 写进去、被 run.md 落盘、也被 `--resume` 读回,多一条传递路径
      // 就多一处会漂移的地方。
      autoPush: args.config.autoPush,
      // 逐任务合并已经把产出送进用户分支了 → 没有待收口不等于「什么都没发生」,该推还是要推。
      trunkLanded,
      // 没跑完就不推:推送是对外的、不可撤销的动作,而「合过一次就推」会让一次
      // 被阻断的 run 也把半成品推到远程(这条早退是最常见的路径,原来一个前提都不查)。
      outcome: pendingOutcome.status,
    })
    if (out.merged) args.config.pendingHandoff = undefined
    /**
     * `out.push` 也要能到 UI —— **这道闸原来只认 `out.result`**。
     *
     * 逐任务合并之后最常见的结局是「没有待收口的东西」,那条早退返回的正是
     * `{ merged: false, push }`(没有 `result`)。于是推送**发生了**、推送**失败**也
     * 发生了,而用户被告知零个字;`efftask.tsx` 里那条专门为它写的 `else if (out.push)`
     * 成了不可达代码。验收拿真 runOrchestrator + 桩 git 实跑出来的:
     * `push 跑过吗 = true / onHandoffResult 次数 = 0`。
     */
    if (out.result || out.push) {
      try { onHandoffResult?.(out) } catch { /* UI only —— 合并已经发生了,不能被一个 UI 回调带走 */ }
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
    // 运行中重做要够得着这一轮的编排器。**在 run() 之前交出去** —— 交在后面就等于
    // 「跑完才给」,而这个功能的全部意义是在跑的过程中用它。
    args.onOrchestrator?.(orch)
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    void queueManifest(orch.nodes()) // run.md exists from the first frame, not just at the end
    liveNodes = orch.nodes()
    const result = await orch.run() // { status, reason }
    liveNodes = orch.nodes()
    pendingOutcome = result
    await reclaim(orch.nodes())
    await handOff()
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
    // 编排器不再听了。**必须在 finally 里** —— happy path 和异常路径都要收回这个把手,
    // 而漏掉异常路径的表现是:一个已经炸掉的 run 上,重做看起来是成功的。
    try { args.onOrchestrator?.(undefined) } catch { /* UI only */ }
    // The reclaim the happy path may not have reached. A no-op when it did.
    await reclaim(liveNodes)
    /**
     * 收口同理:异常路径上 happy path 那一句根本没跑到。空转当且仅当上面已经跑过。
     *
     * 这条路上 `pendingOutcome.status` 必然是 `blocked`,所以它只会**报告为什么不合**,
     * 不会真去合一棵没跑完的树(判据在 planFinish 里,而不是靠这里排除)。
     */
    await handOff()
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
