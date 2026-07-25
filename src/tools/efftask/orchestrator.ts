// src/tools/efftask/orchestrator.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode } from './types.js'
import { advanceableKind, byIdMap, isTerminal } from './stateMachine.js'
import { stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

export interface OrchestratorDeps {
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  onUpdate: (nodes: TaskNode[]) => void
}

function rootTitle(goal: string): string {
  // First NON-EMPTY line: a goal that opens with a blank line still has a real title.
  const line = goal.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  // Slice CODE POINTS, matching persistence.slugify — a UTF-16 slice can strand a lone
  // surrogate, and this title is rendered into run.md and into prompts.
  return Array.from(line).slice(0, 80).join('') || '根任务'
}

export class EffTaskOrchestrator {
  private byId: Map<string, TaskNode>
  constructor(private cfg: EffTaskConfig, private deps: OrchestratorDeps, private signal: AbortSignal) {
    // root goal = the FULL goalPrompt (title is only a truncated display label); ctxGoal
    // reads node.goal, so the plan prompt must see the whole objective, not the truncation.
    const root = createNode({ id: 'root', title: rootTitle(cfg.goalPrompt), goal: cfg.goalPrompt, parentId: null, deps: [], depth: 0, phaseRoles: cfg.phaseRoles, now: deps.now() })
    this.byId = byIdMap([root])
  }

  nodes(): TaskNode[] { return [...this.byId.values()] }

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
  private nowSafe(): string {
    try { return this.deps.now() } catch { return '' }
  }

  private ctx(): PipelineCtx {
    return {
      config: this.cfg,
      byId: this.byId,
      runAgent: this.deps.runAgent,
      persist: this.deps.persist,
      now: this.deps.now,
      signal: this.signal,
      onUpdate: () => this.deps.onUpdate(this.nodes()),
    }
  }

  // A node under a BLOCKED ancestor can no longer contribute: its parent will never be
  // accepted, so running it spends real model calls and mutates the repo for a result
  // nothing will consume.
  private hasBlockedAncestor(node: TaskNode): boolean {
    const seen = new Set<string>()
    let cur = node.parentId ? this.byId.get(node.parentId) : undefined
    while (cur && !seen.has(cur.id)) {
      if (cur.status === 'BLOCKED') return true
      seen.add(cur.id)
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined
    }
    return false
  }

  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    // No-progress guard: if the same node is selected twice with an identical
    // (status, updatedAt) it did not move, and re-picking it forever would be a hot loop
    // issuing real model calls. Cheap insurance against a future step that returns without
    // advancing — the scheduler must never be the thing that runs away.
    let lastPick = ''
    let stalls = 0
    for (;;) {
      const root = this.byId.get('root')!
      // Completion wins over abort: a tree that finished before the signal fired IS done,
      // and reporting 'blocked' would contradict what was persisted.
      if (root.status === 'ACCEPTED') return { status: 'completed' }
      if (this.signal.aborted) { await this.propagateBlocked(true); return { status: 'blocked', reason: '已中断' } }
      // pick the first advanceable node (serial). Deterministic order by id — a plain
      // codepoint compare, NOT localeCompare (which is locale/ICU-dependent).
      const ordered = [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      let kind: ReturnType<typeof advanceableKind> = null
      const next = ordered.find(n => {
        if (this.hasBlockedAncestor(n)) return false
        kind = advanceableKind(n, this.byId)
        return kind !== null
      })
      if (!next) {
        // deadlock: nothing advanceable and root not accepted. Surface WHY the tree is
        // dead by propagating BLOCKED upward before returning.
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      const fingerprint = `${next.id}|${next.status}|${next.updatedAt}`
      stalls = fingerprint === lastPick ? stalls + 1 : 0
      lastPick = fingerprint
      if (stalls >= 2) {
        next.status = 'BLOCKED'
        next.blockedReason = next.blockedReason || '节点未能推进(状态未变化),已阻断以避免空转'
        next.updatedAt = this.nowSafe()
        await this.safePersist(next)
        this.safeUpdate()
        continue
      }
      const ctx = this.ctx()
      try {
        if (kind === 'start') await stepStart(next, ctx)
        else if (kind === 'execute') await stepExecute(next, ctx)
        else if (kind === 'integrate') await stepIntegrate(next, ctx)
        else throw new Error(`efftask: unhandled advance kind ${String(kind)}`)
      } catch (e) {
        // A step should not normally throw (pipeline catches runAgent and persist errors),
        // but if one does, keep the run alive and drive this node to a terminal state.
        // Reachable in practice only via a transient deps.now() failure inside commit().
        const message = e instanceof Error ? e.message : String(e)
        // Do NOT clobber a parent whose subtree is still alive — BLOCKing it would strand
        // children that are still advanceable. Keep WAITING_CHILDREN only while at least
        // one child is non-terminal; otherwise this node would be re-picked forever.
        const subtreeAlive =
          next.status === 'WAITING_CHILDREN' &&
          next.childIds.length > 0 &&
          next.childIds.some(id => { const c = this.byId.get(id); return c !== undefined && !isTerminal(c.status) })
        // Only record a reason when we actually block; otherwise a recovered node would
        // carry a stale blockedReason into an ACCEPTED state.
        if (!subtreeAlive) {
          next.status = 'BLOCKED'
          next.blockedReason = message
        }
        next.updatedAt = this.nowSafe()
        await this.safePersist(next)
        this.safeUpdate()
      }
    }
  }

  // Fixpoint BLOCKED propagation: a non-terminal node with any BLOCKED child, any MISSING
  // child, any BLOCKED dep, or any DANGLING dep becomes BLOCKED. Repeat until stable so
  // death propagates up the tree. `aborted` additionally sweeps every non-terminal node so
  // the final tree shows no phantom "running" rows after an interrupt.
  private async propagateBlocked(aborted: boolean): Promise<void> {
    if (aborted) {
      // Sweep on !isTerminal rather than a status whitelist: every non-terminal status
      // renders as running/queued, and a whitelist silently misses PLAN_REVIEW, ACCEPTANCE,
      // INTEGRATION_ACCEPT, REWORK… (and any status added later).
      for (const n of this.byId.values()) {
        if (isTerminal(n.status)) continue
        n.status = 'BLOCKED'
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
        const childBlocked = n.childIds.some(id => this.byId.get(id)?.status === 'BLOCKED')
        // A child id MISSING from byId can never be accepted, so childrenAllAccepted will
        // never be true and the parent would sit WAITING_CHILDREN (rendered as grey/queued)
        // forever. loadRun deliberately returns partial trees, so resume produces this shape.
        const childMissing = n.childIds.some(id => !this.byId.has(id))
        // A dep id MISSING from byId is a dangling edge that can never resolve — treat it
        // like a blocked dep instead of leaving the node queued forever.
        const depDangling = n.deps.some(id => !this.byId.has(id))
        const depBlocked = n.deps.some(id => this.byId.get(id)?.status === 'BLOCKED')
        if (childBlocked || childMissing || depBlocked || depDangling) {
          n.status = 'BLOCKED'
          if (!n.blockedReason) {
            n.blockedReason = childBlocked ? '子节点阻断' : childMissing ? '子节点缺失' : depDangling ? '依赖节点缺失' : '依赖阻断'
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
