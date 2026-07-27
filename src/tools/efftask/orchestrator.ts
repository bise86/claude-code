// src/tools/efftask/orchestrator.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap, isTerminal } from './stateMachine.js'
import { createStallTracker, pickBatch, type Advanceable } from './scheduler.js'
import { stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
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
  runAgent: RunAgentFn
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
   * 并行占用 (spec §10.1's 顶部状态条). Live, because it changes many times per second and
   * mirroring it into React state would repaint the tree on every reviewer.
   *
   * This is the POOL's occupancy, not a count of running nodes: a roundtable's reviewers hold
   * slots too, and that is precisely the number the confirmation gate promised to cap.
   */
  slotUsage(): { inUse: number; limit: number } {
    return { inUse: this.slots.inUse(), limit: Math.max(1, this.cfg.parallelism) }
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
  private slots = createSlotPool(() => Math.max(1, this.cfg.parallelism))

  private ctx(): PipelineCtx {
    return {
      config: this.cfg,
      reserveNodes: this.reserveNodes,
      worktrees: this.deps.worktrees,
      onEscalate: this.deps.onEscalate,
      onBlocked: this.deps.onBlocked,
      runId: this.deps.runId,
      openStream: this.deps.openStream,
      slots: this.slots,
      byId: this.byId,
      runAgent: this.deps.runAgent,
      persist: this.deps.persist,
      now: this.deps.now,
      signal: this.signal,
      onUpdate: () => this.deps.onUpdate(this.nodes()),
    }
  }

  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    const stalls = createStallTracker()
    /**
     * node id → its pending task. Used ONLY for dedup: a queued-but-not-started execute is
     * in here too, so pickBatch will not hand out the same node twice.
     */
    const inFlight = new Map<string, Promise<void>>()
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
      return task.finally(() => { inFlight.delete(n.id) })
    }

    for (;;) {
      const root = this.byId.get('root')!
      // Completion wins over abort: a tree that finished before the signal fired IS done,
      // and reporting 'blocked' would contradict what was persisted.
      if (root.status === 'ACCEPTED') { await this.settleAll(inFlight); return { status: 'completed' } }
      if (this.signal.aborted) {
        // Settle FIRST. propagateBlocked sweeps and returns; a step still running would
        // commit AFTER the sweep, leaving a non-terminal node in a tree we already declared
        // finished. (It also establishes propagateBlocked's live-iterator invariant.)
        await this.settleAll(inFlight)
        if (this.byId.get('root')!.status === 'ACCEPTED') return { status: 'completed' }
        await this.propagateBlocked(true)
        return { status: 'blocked', reason: '已中断' }
      }

      const budget = Math.max(1, this.cfg.parallelism) - running()
      // NO await between pickBatch and the dispatch loop — that is what makes the dependency
      // check atomic (see pickBatch's contract).
      const batch = pickBatch(this.nodes(), this.byId, new Set(inFlight.keys()), budget)
      for (const { node, kind } of batch) inFlight.set(node.id, launch(node, kind))

      if (inFlight.size === 0) {
        // Nothing running and nothing pickable → the tree cannot move. Surface WHY by
        // propagating BLOCKED upward before returning.
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      // Wake on the FIRST completion, then rescan and top the pool back up.
      await Promise.race([...inFlight.values()]).catch(() => {})
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
