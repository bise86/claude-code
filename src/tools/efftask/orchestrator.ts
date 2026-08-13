// src/tools/efftask/orchestrator.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap, isTerminal } from './stateMachine.js'
import { createStallTracker, pickBatch, type Advanceable } from './scheduler.js'
import type { RunControl } from './control.js'
import { stepExecute, stepIntegrate, stepStart, type MergeResolveSpend, type PipelineCtx } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'
import type { WorktreePool } from './worktreePool.js'
import { makeRootNode } from './rootPlan.js'
import { createSlotPool } from './slotPool.js'

export interface OrchestratorDeps {
  /**
   * Per-node git isolation, or undefined for a shared-tree run.
   *
   * Threaded all the way to PipelineCtx because its PRESENCE is the switch: with a pool, a
   * node that cannot get a worktree is blocked rather than executed. Without this wiring the
   * pool existed but nothing ever constructed or passed it, so every executor ran in the
   * user's real checkout while the code claimed otherwise.
   */
  worktrees?: WorktreePool
  /**
   * 升级人工 (spec §8) — forwarded to PipelineCtx, and the forwarding is the whole feature.
   *
   * It was added to PipelineCtx and to runOrchestrator but NOT to this interface or to
   * ctx() below, so `ctx.onEscalate` was undefined in every real run: the conflict blocked,
   * the reason was written, and the human was never told. Excess-property checking would
   * have caught the runOrchestrator call; this repo has no typecheck. Every test asserting
   * escalation injected it into a hand-built ctx and so passed over a severed wire.
   */
  onEscalate?: PipelineCtx['onEscalate']
  /**
   * 触阀升级 (spec §9/§11). Same wire, same warning as onEscalate above: it must be declared
   * HERE and copied in ctx() below, or the callback is undefined in every real run and the
   * whole feature is dead while its unit tests pass over a hand-built ctx.
   */
  onBlocked?: PipelineCtx['onBlocked']
  /**
   * 合并完成即清构建产物的**统计出口**。见 `PipelineCtx.onBuildWipe`。
   *
   * 这一路是自动的、不可逆的删除,而它**刻意不写 `execStatus`**(那个字段会被喂进之后
   * 每一次验收提示词)。少了这条线,一次真实的删除对用户就是完全不可见的 ——
   * 而「静默清理和静默截断是同一类毛病」是这个仓库反复在修的那一条。
   */
  onBuildWipe?: PipelineCtx['onBuildWipe']
  /** Run id, used only to write an actionable retry command into `blockedReason`. */
  runId?: string
  /**
   * 子 agent 实时输出 (spec §10.2) — forwarded to PipelineCtx.
   *
   * THIRD callback to travel this exact path. The first two (onEscalate, onBlocked) were each
   * declared on PipelineCtx and on runOrchestrator but missed HERE and in ctx() below, and
   * were therefore dead in every real run while their unit tests passed over the cut wire.
   */
  openStream?: PipelineCtx['openStream']
  cwd?: PipelineCtx['cwd']
  runAgent: RunAgentFn
  /** 运行中的人工干预面。给了才有暂停 / 追加指令 / 单节点取消。 */
  control?: RunControl
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  onUpdate: (nodes: TaskNode[]) => void
}

export class EffTaskOrchestrator {
  private byId: Map<string, TaskNode>
  constructor(
    private cfg: EffTaskConfig,
    private deps: OrchestratorDeps,
    private signal: AbortSignal,
    /**
     * Resume: the recovered tree IS the state, so adopt it instead of minting a fresh root.
     * The caller must have run it through `validateLoadedNodes`, which guarantees the two
     * things run() assumes on every iteration — a node with id 'root' exists, and every
     * dep/childId reference resolves.
     */
    seed?: TaskNode[],
  ) {
    if (seed !== undefined) {
      // An EMPTY seed is a caller bug, not an empty run: falling through would silently mint
      // a fresh root from cfg.goalPrompt and turn a resume into a brand-new run writing into
      // the old run's directory.
      if (seed.length === 0) throw new Error('efftask: 恢复失败,没有可恢复的节点')
      this.byId = byIdMap(seed)
      return
    }
    // Shared with the 根方案关口 (rootPlan.makeRootNode), which mints the SAME root, drafts a
    // plan into it and hands it back as `seed`. Two copies of this construction would let the
    // gate's tree and the run's tree disagree about the id every child id derives from.
    this.byId = byIdMap([makeRootNode(cfg, this.nowSafe())])
  }

  nodes(): TaskNode[] { return [...this.byId.values()] }

  /**
   * 此刻真的在跑的节点 id。
   *
   * 存在的理由只有一个:**运行中重做**要判「这次重做碰到的节点里有没有正在跑的」。
   * 那张表原来是 `run()` 里的一个局部量,而这个判断必须由外面(界面按下 r 的那一刻)问得到。
   */
  private inFlightIds = new Set<string>()
  runningNodeIds(): readonly string[] { return [...this.inFlightIds] }

  /**
   * 编排器在「等某个节点跑完」时的额外唤醒口。
   *
   * 运行中就地换树之后必须立刻重扫:不叫醒的话,新放回可推进状态的那个节点要等到
   * **另一个**节点跑完才被看见 —— 而「其它任务还在跑一个二十分钟的执行环节」正是用户
   * 按下重做的那一刻。和 `waitForParallelism` 同一个理由、同一个形状。
   */
  private wakeup: { promise: Promise<void>; wake: () => void } = makeWakeup()
  private nudge(): void {
    const w = this.wakeup
    this.wakeup = makeWakeup()
    w.wake()
  }

  /**
   * 清掉某个节点的「原地打转」记账 —— 见 run() 里的 stalls。
   *
   * 重做把节点放回可推进状态时必须清:那个计数器记的是「同一个状态连着交出两次」,
   * 而重做后的第一步正好又会落在同一个状态上,于是节点会被判成空转、强制阻断,
   * 理由还是一句和重做完全无关的「节点未能推进」。
   */
  private clearStall: (id: string) => void = () => {}

  /** `run()` 已经返回了吗。见 applyLive 的第一道守卫。 */
  private finished = false

  /**
   * 被**扣住**、暂时不许调度的节点 id。
   *
   * 运行中重做的第二道闸门,而且是唯一airtight的那道:算新树和落盘之间隔着一次 `await`,
   * 而调度循环在那期间完全可能把其中一个节点派出去 —— 最真实的是被放回的祖先(别的子任务
   * 恰好在这时跑完,它就进了集成验收)。等到换树那一刻才发现,盘上已经写完了,于是磁盘上
   * 是新树、内存里是旧树,而屏幕说重做成功。
   *
   * 所以顺序是:扣住 → 落盘 → 换树(换完自动释放)。扣住这一步是同步的,和「这一刻谁在飞」
   * 的判断在同一个回合里,中间挤不进任何东西。
   */
  private held = new Set<string>()

  /**
   * 运行中重做的第一步:把这些节点从调度里扣下来。
   *
   * 失败(有节点正在跑)时**什么都没发生** —— 调用方还没落过盘,可以原样告诉用户。
   */
  hold(ids: readonly string[]): { ok: true; release: () => void } | { ok: false; reason: string } {
    if (this.finished) return { ok: false, reason: '本次编排已经结束(最后一个任务刚跑完),这次重做要走结束屏那条路' }
    const busy = ids.filter(id => this.inFlightIds.has(id))
    if (busy.length > 0) {
      const names = busy.map(id => this.byId.get(id)?.title ?? id)
      return {
        ok: false,
        reason: `这次重做会动到正在运行的任务(${names.join('、')})—— 请先在树上选中它按 x 取消,再重做。` +
          `直接换树的话,它此刻在飞的调用会把结果写进一个已经不在树里的节点。`,
      }
    }
    for (const id of ids) this.held.add(id)
    let released = false
    // 释放要**叫醒循环**:上面那条「扣住时不判走不动」的分支正睡在 wakeup 上,而一次
    // 失败的重做(算得出新树、落盘却失败了)只会释放、不会换树 —— 不叫醒的话它睡到天荒地老。
    return { ok: true, release: () => { if (released) return; released = true; for (const id of ids) this.held.delete(id); this.nudge() } }
  }

  /**
   * 运行中就地换树 (用户原话:「不需要整体返回失败才能重做任务或阶段,在其它任务还在
   * 运行时就可以重做」)。
   *
   * **不重启编排器。** 重启的语义是「把这一轮作废、重新开一轮」,而此刻别的节点正在跑 ——
   * 它们的在飞调用会变成孤儿:老编排器仍持有它们、仍会 commit 进一棵没人再看的树,
   * 而新编排器会把同一批节点再派一遍。所以这里是把新树**并进正在跑的那一棵**。
   *
   * 拒绝的唯一条件是「这次重做碰到的节点里有正在跑的」:那个节点的 step 手里攥着**旧对象**
   * 的引用,换树之后它的 commit 会落进一个已经不在树里的对象 —— 产出看着跑完了,树上却
   * 什么都没有。让用户先取消它(x)再重做,比替他做这个决定要诚实。
   *
   * 没被碰到的在飞节点**保留原对象**(不取新树里那份克隆):它们的 step 正拿着旧引用,
   * 换成克隆等于把它们这一轮的进展扔掉。
   */
  applyLive(
    next: readonly TaskNode[],
    /** 这次重做碰过的节点 id(目标、被删的子树、被放回的祖先、被改写依赖的)。 */
    affected: readonly string[],
  ): { ok: true } | { ok: false; reason: string } {
    /**
     * 循环已经走完了 —— 换树也没有人再去调度它。
     *
     * 真实可达:用户在最后一个节点跑完的那一瞬按下 r。此时该走结束屏那条路(重启编排器),
     * 而不是悄悄改一棵没人再看的树 —— 那会让屏幕显示「已重做」而实际一个调用都不会发生。
     */
    if (this.finished) return { ok: false, reason: '本次编排已经结束(最后一个任务刚跑完),这次重做要走结束屏那条路' }
    const busy = affected.filter(id => this.inFlightIds.has(id))
    if (busy.length > 0) {
      const names = busy.map(id => this.byId.get(id)?.title ?? id)
      return {
        ok: false,
        reason: `这次重做会动到正在运行的任务(${names.join('、')})—— 请先在树上选中它按 x 取消,再重做。` +
          `直接换树的话,它此刻在飞的调用会把结果写进一个已经不在树里的节点。`,
      }
    }
    const byId = new Map<string, TaskNode>()
    for (const n of next) byId.set(n.id, this.inFlightIds.has(n.id) ? (this.byId.get(n.id) ?? n) : n)
    // 在飞的节点必须仍在新树里。deleted ⊆ affected,所以这一条到不了 —— 但它挡的是
    // 「以后某条路开始删节点却忘了报进 affected」,那时的表现是一个跑完的节点凭空消失。
    for (const id of this.inFlightIds) {
      if (!byId.has(id)) return { ok: false, reason: `新树里没有正在运行的节点 ${id},已放弃这次重做` }
    }
    if (!byId.has('root')) return { ok: false, reason: '新树里没有根节点,已放弃这次重做' }
    /**
     * **原地改这个 Map,不换对象。** `ctx()` 把 `this.byId` 直接交给每一个在跑的 step,
     * 换成新 Map 的话它们手里那份永远停在换树之前 —— 一个在飞的拆分节点会把新子任务
     * 建进一棵没人再看的树里。
     */
    this.byId.clear()
    for (const [id, n] of byId) this.byId.set(id, n)
    for (const id of affected) {
      this.clearStall(id)
      // 用户取消过、又决定重做的节点:不清的话 registerCall 一登记就发现它在 cancelled 里,
      // 立刻 abort → 又是一次 NodeCancelledError。startRun 那条路靠 clearAllCancels 解决,
      // 这里只清被碰到的这几个 —— 别的节点正在跑,它们的取消标记不该被顺手抹掉。
      this.deps.control?.clearCancel(id)
    }
    this.safeUpdate()
    this.nudge()
    return { ok: true }
  }

  /**
   * **把此刻的状态同步到盘上** —— 运行中改过的那些**只活在内存里**的设置用它。
   *
   * `+/-` 并发、`<>` 严格度、`i` 追加指令改的都是 `RunControl`(纯内存),而它们进 run.md
   * 的**唯一**通道是 `queueManifest` 里那两句 `args.config.parallelism = control.parallelism()`
   * —— 而 `queueManifest` 只在 `onUpdate` 时被调用,也就是**某个节点提交状态**的时候。
   * 一个执行环节可以跑几分钟不提交:这期间调过的并发/严格度,退出时就只在内存里,
   * 而 `--resume` 是从 run.md 读回它们的。用户报的正是这个:
   * 「退出时有些任务状态还在内存里没有及时存储到文件」。
   *
   * 走 `safeUpdate()` 而不是自己写盘:run.md 的唯一写入点是 `runOrchestrator` 里那条
   * **串行 + 合并**的队列,从别处直调 `writeRunManifest` 会和它并发写同一个文件。
   */
  syncToDisk(): void {
    this.safeUpdate()
  }

  /**
   * **依赖被就地改过了** —— 叫醒调度、上屏。依赖重算走这条,不走 `applyLive`。
   *
   * ## 为什么不复用 `applyLive`
   *
   * 对这个功能它几乎是空操作(传进去的是 `nodes()`,同一批对象,`byId` 重建是恒等),
   * 真正起作用的只有 `clearStall` / `clearCancel` / `safeUpdate` / `nudge` —— 而
   * **`clearCancel` 是有害的**:一个被用户按 `x` 取消过的 CREATED 节点永远不会被
   * `pickBatch` 选中(它的依赖没满足),于是那个取消标记就一直挂着;`applyLive` 顺手抹掉它,
   * 节点起跑、跑完、`commitAndMerge` 合进集成分支、`intoTrunk` 再合进用户当前分支 ——
   * **用户明确拒绝过的任务,产出落进了他自己的分支**,而屏幕上只说「依赖已重算」。
   *
   * ## `safeUpdate()` 不只是上屏
   *
   * 它走 `onUpdate` → `runOrchestrator` 的 `queueManifest`,也就是 run.md 的**唯一写入点**
   * (那是一条串行 + 合并的队列)。所以重算的 run.md 标记是白拿的,而且走对了队列 ——
   * 从按键处理里直调 `writeRunManifest` 会和它并发写同一个文件,还会绕过运行中调过的
   * 并发度/严格度同步。
   *
   * `finished` 这一支**唯一可达的路是 `signal.aborted`**:`runLoop` 保证有 held 节点时不判
   * 「走不动」,而「root 已 ACCEPTED」与「本节点是它的后代且还是 CREATED」互斥。所以
   * 调用方的错误文案该说「整个运行已被中止」,不是「没能叫醒调度」。
   */
  depsChanged(id: string): { ok: true } | { ok: false; reason: string } {
    if (this.finished) {
      return { ok: false, reason: this.signal.aborted ? 'aborted' : 'finished' }
    }
    if (this.inFlightIds.has(id)) {
      return { ok: false, reason: 'running' }
    }
    this.clearStall(id)
    this.safeUpdate()
    this.nudge()
    return { ok: true }
  }

  /**
   * 并行占用 (spec §10.1's 顶部状态条). Live, because it changes many times per second and
   * mirroring it into React state would repaint the tree on every reviewer.
   *
   * This is the POOL's occupancy, not a count of running nodes: a roundtable's reviewers hold
   * slots too, and that is precisely the number the confirmation gate promised to cap.
   */
  /**
   * `inFlight` —— **此刻真的有一步在跑的那些节点 id**,和 `runningNodeIds()` 同一份。
   *
   * 交出去是为了让表头能把 `inUse` 拆开说。用户报的原话:「顶端黄色显示 7 个任务在运行,
   * 为什么并行那里写的是 20/20」。两个数各自都没算错,量的却是两件事:
   *
   *  - 黄色那个数按**节点状态**算(`uiStatus`),而 CREATED / READY / WAITING_CHILDREN 都是灰的;
   *  - `inUse` 是**槽**,而槽在步骤被派出去的那一刻就拿走了(`launch` 里的 `slots.take()`)。
   *
   * 中间那道缝是实打实的:一个节点被派出去之后,要到它自己那一步跑到第一次 `commit(...)`
   * 才变黄,而执行那条路在 `commit(EXECUTING)` 之前要先 `worktrees.acquire(node)` —— 那件事
   * 被池子的**全局互斥锁**串起来(5 个并发 `git worktree add` 会把 `.git/config` 锁坏)。
   * 于是排在锁后面的节点:槽占着、颜色是灰的、屏幕上没有任何东西解释这 13 个去哪了。
   *
   * 只给 id、不在这里算「准备中几个」:什么叫「黄」是渲染层的定义(`uiStatus`),在这里
   * 再判一次就是第二份判据,而这个仓库为「同一条判据的第二份」反复付过账。
   */
  slotUsage(): { inUse: number; limit: number; inFlight: readonly string[] } {
    return { inUse: this.slots.inUse(), limit: this.limit(), inFlight: this.runningNodeIds() }
  }

  /**
   * 此刻的并发上限 —— **每次现读**,不缓存。
   *
   * 用户在运行中改过的那个数优先(`control.setParallelism`),没改过就用关口批准的那个。
   * 现读是这个功能成立的全部条件:缓存一次的话,调整只会在下一次 run 生效。
   *
   * 三个消费者共用它 —— 池子的上限、调度循环的预算、表头那个 `并行 n/N`。分开算过一次
   * 的代价这个文件已经付过(池子只数 step、圆桌的席位不计数,于是 3 席评审团把用户的
   * 数字乘了三倍)。
   */
  private limit(): number {
    return Math.max(1, this.deps.control?.parallelism() ?? this.cfg.parallelism)
  }

  // run() must always RESOLVE with an outcome. Its failure handlers do I/O of their own, so
  // an ordinary disk error or a crashing renderer would otherwise reject the whole run —
  // and worst of all on the abort path, exactly when the user is bailing out of a broken
  // run and most needs a clean answer. Mirrors pipeline.ts's safeUpdate discipline.
  private async safePersist(n: TaskNode): Promise<void> {
    try { await this.deps.persist(n) } catch { /* durability lost; the in-memory status still stands */ }
  }
  private safeUpdate(): void {
    try { this.deps.onUpdate(this.nodes()) } catch { /* a crashing renderer is not a run failure */ }
  }
  // Last timestamp the injected clock actually produced. A failing clock falls back to it
  // rather than to '', which would land NaN in updatedAt and break elapsed-time rendering.
  private lastNow = ''
  private nowSafe(): string {
    try {
      this.lastNow = this.deps.now()
    } catch { /* keep the previous good value */ }
    return this.lastNow
  }

  /**
   * Node-count budget held by decompositions that have been authorised but whose children
   * are not yet in `byId`. Counted alongside byId.size so the cap holds across concurrent
   * decompositions — the old inline check compared against byId.size and then awaited.
   */
  private reserved = 0
  /** Test/diagnostic view of the outstanding reservation; must return to 0 on every path. */
  reservedCount(): number { return this.reserved }
  private reserveNodes = (count: number): { release: () => void } | null => {
    if (this.byId.size + this.reserved + count > this.cfg.caps.maxNodes) return null
    this.reserved += count
    // Single-shot: a double release would UNDER-enforce maxNodes, and clamping at zero
    // would hide the bug rather than surface it.
    let released = false
    return { release: () => { if (released) return; released = true; this.reserved -= count } }
  }

  /**
   * 全局并发池 (spec §6). Held by the orchestrator so BOTH the scheduler's steps and the
   * roundtables inside them draw from one budget — the second half of that clause was missing
   * and a 3-role panel multiplied the user's number by three.
   */
  private slots = createSlotPool(() => this.limit())

  /**
   * 自动解冲突的**本次运行**预算(node id → 已用次数)。见 PipelineCtx.mergeResolveThisRun。
   *
   * 住在**实例**上,不是住在 `ctx()` 里 —— `ctx()` 每次调用都新建一个对象,挂在那上面
   * 等于每一步都回满,预算形同虚设。一次运行一个 orchestrator,所以「每次运行两次、
   * `--resume` 回满」这句话由这个字段的生命周期直接兑现。
   */
  private mergeResolveThisRun = new Map<string, MergeResolveSpend>()

  private ctx(): PipelineCtx {
    return {
      config: this.cfg,
      mergeResolveThisRun: this.mergeResolveThisRun,
      reserveNodes: this.reserveNodes,
      worktrees: this.deps.worktrees,
      onEscalate: this.deps.onEscalate,
      onBlocked: this.deps.onBlocked,
      onBuildWipe: this.deps.onBuildWipe,
      runId: this.deps.runId,
      openStream: this.deps.openStream,
      cwd: this.deps.cwd,
      slots: this.slots,
      byId: this.byId,
      runAgent: this.deps.runAgent,
      control: this.deps.control,
      persist: this.deps.persist,
      now: this.deps.now,
      signal: this.signal,
      onUpdate: () => this.deps.onUpdate(this.nodes()),
    }
  }

  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    // finally,不是在每一个 return 前面各写一句:那个循环有五个出口,而漏掉任何一个的
    // 表现是「重做说成功了,却什么都没跑」。
    try { return await this.runLoop() } finally { this.finished = true }
  }

  private async runLoop(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    const stalls = createStallTracker()
    // 让 applyLive 够得着(重做把节点放回可推进状态时要清掉它的空转记账)。
    this.clearStall = id => stalls.clear(id)
    /**
     * node id → its pending task. Used ONLY for dedup: a queued-but-not-started execute is
     * in here too, so pickBatch will not hand out the same node twice.
     */
    const inFlight = new Map<string, Promise<void>>()
    /**
     * `inFlightIds` 是这张表的**镜像**,给外面(运行中重做)问「谁正在跑」。
     *
     * 镜像而不是让外面直接读 inFlight:这张表里存的是 promise,而外面只该知道 id ——
     * 交出去的话,一个 UI 回调可以 await 它,而它 resolve 的时机是编排器的内部细节。
     */
    this.inFlightIds.clear()
    /**
     * Steps that have actually STARTED. The pool budget is charged against this, NOT against
     * inFlight: a queued execute holds no resource, and charging it would let a tree with
     * more ready executables than `parallelism` starve every other phase.
     */
    // Occupancy is now the POOL's, not a private counter: a reviewer holding a slot has to
    // shrink the scheduler's budget too, or the two halves would each honour the cap alone
    // and together exceed it.
    const running = (): number => this.slots.inUse()
    /**
     * execute is STRICTLY serial in P2a. It is the only phase with write-capable tools, and
     * two executors in one working tree overwrite each other's edits while BOTH report
     * success to their own acceptance roundtables. Lifted only once every executable node
     * has its own worktree (P2b).
     *
     * The step is STARTED inside the chain. Chaining an already-started promise
     * (`chain.then(() => task)`) serialises only the waiting — measured peak 3.
     */
    let executeChain: Promise<void> = Promise.resolve()

    const launch = (n: TaskNode, kind: Advanceable['kind']): Promise<void> => {
      const before = n.status
      const step = async (): Promise<void> => {
        // Unconditional: pickBatch already budgeted for this step against the same pool.
        const slot = this.slots.take()
        try {
          await this.runStep(n, kind) // never rejects — see runStep
        } finally {
          slot.release()
        }
        // Bookkeeping runs on the failure path too, because runStep absorbs its own errors.
        // Hanging it off .then(onFulfilled) alone would skip it exactly when a step fails,
        // which is the one situation the stall guard could ever be needed for.
        if (n.status !== before) { stalls.clear(n.id); return }
        // The fingerprint is status PLUS child count, not status alone.
        //
        // 补救拆分 (spec §4.1) is the first path that legitimately re-enters a node in the
        // status it was picked in: a decompose node picked at WAITING_CHILDREN grows
        // corrective children and returns to WAITING_CHILDREN. Keyed on status alone, the
        // counter survives across rounds — nothing clears it while the children run — so a
        // SECOND such return force-BLOCKED the node with 「节点未能推进(状态未变化)」: a
        // reason unrelated to what happened, on a node that had just grown a subtree. That
        // block sets neither `interrupted` nor `capBlocked`, so no resume path can reopen it;
        // on root it becomes the run's final word to the user.
        //
        // NOT REACHABLE TODAY, and not covered — stated plainly rather than implied. A
        // revision happens at most once per node (TaskNode.revised), so the count reaches 1
        // and never 2, and a mutation reverting this line leaves the whole suite green. It is
        // kept because the ONLY thing making it unreachable is that once-per-node bound, which
        // is a policy knob someone could plausibly relax to "allow two"; leaving a landmine
        // under a knob is worse than a one-line fingerprint. Do not read it as tested.
        if (stalls.note(n.id, `${n.status}:${n.childIds.length}`) >= 2) {
          // 失败点。这一条不经过 commit(),所以得自己记 —— 见 TaskNode.failedAt。
          if (n.status !== 'BLOCKED') n.failedAt = n.status
          n.status = 'BLOCKED'
          n.blockedReason = n.blockedReason || '节点未能推进(状态未变化),已阻断以避免空转'
          // Mark it interrupted when the run is aborting, or resume refuses to reopen it.
          n.interrupted = this.signal.aborted
          n.updatedAt = this.nowSafe()
          await this.safePersist(n)
          this.safeUpdate()
        }
      }
      // `.then(step, step)` — the same handler on BOTH settle paths absorbs a rejection so
      // one failure cannot poison every later link. A poisoned chain makes Promise.race
      // resolve within a microtask forever: measured 200k iterations with a pending 30 ms
      // timer never firing, i.e. the process hangs with no I/O and no timers.
      // The execute mutex exists ONLY because un-isolated executors share one working tree.
      // With a worktree per node that reason is gone, and serialising would throw away the
      // parallelism the user asked for ("各任务执行可以并行,默认5个").
      //
      // Keyed on the POOL, not on config: a config flag could say "isolated" while every
      // acquire failed. With a pool present, stepExecute refuses to run any node it cannot
      // isolate, so "pool exists" really does mean "no two executors share a tree".
      const serialiseExecute = kind === 'execute' && this.deps.worktrees === undefined
      const task = serialiseExecute ? (executeChain = executeChain.then(step, step)) : step()
      return task.finally(() => { inFlight.delete(n.id); this.inFlightIds.delete(n.id) })
    }

    for (;;) {
      const root = this.byId.get('root')!
      // Completion wins over abort: a tree that finished before the signal fired IS done,
      // and reporting 'blocked' would contradict what was persisted.
      if (root.status === 'ACCEPTED') { await this.settleAll(inFlight); return { status: 'completed' } }
      /**
       * 暂停。**排在「没有在飞的就算走不动」之前** —— 否则一次暂停会被当成
       * 「树推不动了」,run 直接以 blocked 收尾,而用户只是想插一句话。
       *
       * 在飞的调用不打断:暂停的语义是「先别派新的」,不是「把正在干的活炸掉」。
       * 所以这里同时等「恢复」和「任一在飞的完成」——后者让 inFlight 表保持收敛,
       * 不然暂停期间一个已完成的节点会一直挂在表里。
       */
      /**
       * **中止排在暂停之前。**
       *
       * 反过来的话:用户按 p 暂停、想了想不跑了、按 Esc —— abort 信号不在下面那个 race 里,
       * 而 `if (this.signal.aborted)` 又排在暂停分支后面,于是在飞的调用排空之后 waits
       * 就只剩 waitForResume() 一项,run() **永远不返回**。而 setPhase('done') 只挂在
       * runOrchestrator 的收尾上 —— 界面就永久停在运行视图,Esc 毫无反应,屏幕上也不会
       * 有任何东西告诉他要先按 p 恢复。实测过(暂停后 abort,700ms 预算内不返回)。
       */
      if (this.signal.aborted) {
        // Settle FIRST. propagateBlocked sweeps and returns; a step still running would
        // commit AFTER the sweep, leaving a non-terminal node in a tree we already declared
        // finished. (It also establishes propagateBlocked's live-iterator invariant.)
        await this.settleAll(inFlight)
        if (this.byId.get('root')!.status === 'ACCEPTED') return { status: 'completed' }
        await this.propagateBlocked(true)
        return { status: 'blocked', reason: '已中断' }
      }

      /**
       * 暂停:不挑新批次,也不把「没有在飞的」当成走不动。
       *
       * 在飞的调用不打断 —— 暂停的语义是「先别派新的」。所以这里同时等三件事:
       * 恢复、任一在飞的完成、以及**中止**。少了最后一项就是上面那条注释里的永久挂死;
       * 这里带上它是第二道保险(上面那个早退是第一道),因为 abort 可能正好发生在
       * 我们已经进入 await 之后。
       */
      if (this.deps.control?.isPaused() === true) {
        const waits: Promise<unknown>[] = [this.deps.control.waitForResume(), abortSignalPromise(this.signal)]
        if (inFlight.size > 0) waits.push(Promise.race([...inFlight.values()]).catch(() => {}))
        await Promise.race(waits)
        continue
      }

      /**
       * 并发上限的代数,**和这一轮扫描在同一个同步回合里读**。
       *
       * 要紧的是它读在上一次 `await` **之后**:代表的必须是「我这一轮扫描时看到的那个
       * 上限」,这样睡下之后到来的每一次调整都会把我叫醒。把它提到循环外面就成了
       * 「run 开始那一刻的代数」——第一次调整之后 `waitForParallelism` 会立刻兑现,
       * 循环从此空转。
       *
       * 放在 `pickBatch` 之前还是之后**没有区别**,如实记下来而不是假装这里有个窗口:
       * 从上一次 await 到下面那个 await 之间一个 await 都没有,而 JS 是单线程的 ——
       * 一次按键根本挤不进来。变异测试把这两句对调,全套照绿,那是构造上等价。
       */
      const limitGen = this.deps.control?.parallelismGeneration() ?? 0
      const budget = this.limit() - running()
      // NO await between pickBatch and the dispatch loop — that is what makes the dependency
      // check atomic (see pickBatch's contract).
      // 扣住的节点算作「此刻不可派」——和在飞的走同一个口子(见 hold)。
      const batch = pickBatch(this.nodes(), this.byId, new Set([...inFlight.keys(), ...this.held]), budget)
      for (const { node, kind } of batch) {
        // 镜像**先于** launch 建立:launch 里第一件事就是 await(拿槽位),而运行中重做
        // 的判断可能落在那之后 —— 后设的话会有一个「已经在跑、但外面看不见」的窗口。
        this.inFlightIds.add(node.id)
        inFlight.set(node.id, launch(node, kind))
      }

      /**
       * **扣住的时候不许判「走不动」。**
       *
       * hold 期间(算完新树、正在落盘)那几个节点是故意不可派的。少了这一条,一个「只剩
       * 这一个失败节点、别的都跑完了」的树会在用户按下确认的那一瞬被判成 blocked 收尾,
       * 而重做正落在半空中:盘上写完了,却再没有编排器去跑它。等换树(或者 hold 被释放)
       * 把这一觉叫醒。
       */
      if (inFlight.size === 0 && this.held.size > 0) {
        await Promise.race([this.wakeup.promise, abortSignalPromise(this.signal)])
        continue
      }
      if (inFlight.size === 0) {
        /**
         * 一个都没在跑、也一个都挑不出来。
         *
         * **调低并发度不会走到这里**:`pickBatch` 在 `limit <= 0` 时返回空批次,而
         * `inFlight.size === 0` 蕴含 `running() === 0`,于是 `budget = limit() >= 1` ——
         * 上限最低是 1(见 MIN_PARALLELISM 的注释:0 会让这里把「用户调小了」误判成
         * 「树走不动了」,然后以 blocked 收尾)。
         */
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      // Wake on the FIRST completion, then rescan and top the pool back up.
      //
      // …**或者**在用户调整并发上限时立刻醒。少了后者,「把 5 调到 10」要等到某个节点跑完
      // 才有第 6 个节点起跑 —— 一个二十分钟的执行环节就是二十分钟的「按了没反应」。
      // 调低同样会唤醒,那一觉起来预算是负的、批次为空,于是再睡回去:多一次空转换来的是
      // 一份**只有一条**的唤醒规则。
      const wakeups: Promise<unknown>[] = [Promise.race([...inFlight.values()]).catch(() => {})]
      if (this.deps.control) wakeups.push(this.deps.control.waitForParallelism(limitGen))
      // …**或者**运行中就地换了树(applyLive)。少了这一项,重做出来的节点要等到另一个
      // 节点跑完才被看见 —— 而「别的任务还在跑一个二十分钟的执行环节」正是用户按下重做
      // 的那一刻。读的是**当前**那个 wakeup(nudge 会把它换掉再兑现),所以这一轮之后
      // 到来的每一次换树都会把这一觉叫醒。
      wakeups.push(this.wakeup.promise)
      await Promise.race(wakeups)
    }
  }

  private async settleAll(inFlight: Map<string, Promise<void>>): Promise<void> {
    await Promise.allSettled([...inFlight.values()])
  }

  /**
   * One advancement step. NEVER REJECTS: it absorbs its own errors and drives the node to a
   * terminal state, exactly as the serial loop's try/catch did. A rejection escaping here
   * would lose that terminal-drive AND poison the execute chain.
   */
  private async runStep(next: TaskNode, kind: Advanceable['kind']): Promise<void> {
    const ctx = this.ctx()
    try {
      if (kind === 'start') await stepStart(next, ctx)
      else if (kind === 'execute') await stepExecute(next, ctx)
      else await stepIntegrate(next, ctx)
    } catch (e) {
      // A step should not normally throw (pipeline catches runAgent and persist errors).
      // Reachable in practice via a transient deps.now() failure inside commit().
      const message = e instanceof Error ? e.message : String(e)
      // Do NOT clobber a parent whose subtree is still alive — BLOCKing it would strand
      // children that are still advanceable.
      const subtreeAlive =
        next.status === 'WAITING_CHILDREN' &&
        next.childIds.length > 0 &&
        next.childIds.some(id => { const c = this.byId.get(id); return c !== undefined && !isTerminal(c.status) })
      // Only record a reason when we actually block; otherwise a recovered node would carry
      // a stale blockedReason into an ACCEPTED state.
      if (!subtreeAlive) {
        // 失败点。这一条也不经过 commit() —— 见 TaskNode.failedAt。
        if (next.status !== 'BLOCKED') next.failedAt = next.status
        next.status = 'BLOCKED'
        next.blockedReason = message
        next.interrupted = this.signal.aborted
      }
      next.updatedAt = this.nowSafe()
      await this.safePersist(next)
      this.safeUpdate()
    }
  }

  // Fixpoint BLOCKED propagation: a non-terminal node with any BLOCKED child, any MISSING
  // child, any BLOCKED dep, or any DANGLING dep becomes BLOCKED. Repeat until stable so
  // death propagates up the tree. `aborted` additionally sweeps every non-terminal node so
  // the final tree shows no phantom "running" rows after an interrupt.
  //
  // 这条路**清掉 failedAt**,而不只是不记它:这里的每一次阻断都不是该节点自己的失败
  // (子节点阻断 / 上级任务阻断 / 依赖阻断 / 整轮被中止),而节点上可能还留着**上一辈子**
  // 那次真失败的记录。留着的后果是「快速重做失败环节」和「跳过失败环节」在一个其实是
  // 它孩子挂了的父节点上放行 —— 评审实跑出来的 P0,而落下的一次性标记很久以后才生效。
  // 见 TaskNode.failedAt。
  // INVARIANT: every in-flight step must be settled before calling this. It awaits inside
  // a LIVE `for (const n of this.byId.values())` iterator, so a concurrent createChildren
  // inserting mid-sweep would be visited — or not — unpredictably.
  private async propagateBlocked(aborted: boolean): Promise<void> {
    if (aborted) {
      // Sweep on !isTerminal rather than a status whitelist: every non-terminal status
      // renders as running/queued, and a whitelist silently misses PLAN_REVIEW, ACCEPTANCE,
      // INTEGRATION_ACCEPT, REWORK… (and any status added later).
      for (const n of this.byId.values()) {
        if (isTerminal(n.status)) continue
        // 失败点:这条路**清掉**它,而不只是「不记」。留着一个上一辈子的失败点,
        // 会让「快速重做失败环节」和「跳过失败环节」在一个其实是被牵连的节点上放行 ——
        // 评审实跑出来的 P0(见 redo.ts reopenAncestor 那一段)。
        n.failedAt = undefined
        n.status = 'BLOCKED'
        // Mark WHY it is blocked, structurally. Resume must reopen the nodes this sweep
        // killed while leaving genuinely failed ones dead, and it cannot tell them apart
        // from the reason text — see TaskNode.interrupted. isTerminal skips nodes that were
        // already BLOCKED, so a real failure never picks the flag up here; the nodes the
        // pipeline blocked during this same abort are covered by blockWithReason.
        n.interrupted = true
        if (!n.blockedReason) n.blockedReason = '已中断'
        n.updatedAt = this.nowSafe()
        await this.safePersist(n)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const n of this.byId.values()) {
        if (isTerminal(n.status)) continue
        // Downward too: once an ancestor is BLOCKED its descendants can never contribute,
        // and the scheduler already refuses to run them. Leaving them CREATED/READY would
        // render the dead subtree as grey "queued" forever — the same complaint that the
        // abort sweep and the missing-child rule exist to answer.
        const parentBlocked = n.parentId !== null && this.byId.get(n.parentId)?.status === 'BLOCKED'
        const childBlocked = n.childIds.some(id => this.byId.get(id)?.status === 'BLOCKED')
        // A child id MISSING from byId can never be accepted, so childrenAllAccepted will
        // never be true and the parent would sit WAITING_CHILDREN (rendered as grey/queued)
        // forever. loadRun deliberately returns partial trees, so resume produces this shape.
        const childMissing = n.childIds.some(id => !this.byId.has(id))
        // A dep id MISSING from byId is a dangling edge that can never resolve — treat it
        // like a blocked dep instead of leaving the node queued forever.
        const depDangling = n.deps.some(id => !this.byId.has(id))
        const depBlocked = n.deps.some(id => this.byId.get(id)?.status === 'BLOCKED')
        if (parentBlocked || childBlocked || childMissing || depBlocked || depDangling) {
          // 同上:被牵连的阻断要**清掉**过期的失败点,否则 R/s 会在这个节点上给出一个
          // 属于它上一次失败的动作,而真正该动的节点在别处。
          n.failedAt = undefined
          n.status = 'BLOCKED'
          if (!n.blockedReason) {
            n.blockedReason = childBlocked ? '子节点阻断'
              : childMissing ? '子节点缺失'
                : depDangling ? '依赖节点缺失'
                  : depBlocked ? '依赖阻断'
                    : '上级任务阻断'
          }
          n.updatedAt = this.nowSafe()
          await this.safePersist(n)
          changed = true
        }
      }
    }
    this.safeUpdate()
  }
}

/**
 * 一个在 signal 中止时兑现的 promise。
 *
 * 暂停分支要同时等「恢复」和「中止」。没有它的话,一个在 await 之后才到达的 abort
 * 会等到下一次恢复才被看见 —— 而用户可能永远不会再按 p。
 *
 * 监听器用 `once: true`:暂停/恢复可以来回很多次,每次都挂一个不摘的监听器会在
 * 一次长跑里堆起来(AbortSignal 上超过 10 个监听器 node 还会打警告)。
 */
/** 一个可以从外面兑现的 promise。和 control.ts 里的 `deferred` 同形状、同理由。 */
function makeWakeup(): { promise: Promise<void>; wake: () => void } {
  let wake = (): void => {}
  const promise = new Promise<void>(res => { wake = res })
  return { promise, wake }
}

function abortSignalPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(res => {
    signal.addEventListener('abort', () => res(), { once: true })
  })
}
