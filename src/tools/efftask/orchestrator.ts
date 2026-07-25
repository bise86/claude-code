// src/tools/efftask/orchestrator.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode, emptyPhaseRoles } from './types.js'
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
  const firstLine = goal.split('\n')[0].trim()
  return firstLine.slice(0, 80) || '根任务'
}

export class EffTaskOrchestrator {
  private byId: Map<string, TaskNode>
  constructor(private cfg: EffTaskConfig, private deps: OrchestratorDeps, private signal: AbortSignal) {
    // root goal = the FULL goalPrompt (title is only a truncated display label); ctxGoal
    // reads node.goal, so the plan prompt must see the whole objective, not the truncation.
    const root = createNode({ id: 'root', title: rootTitle(cfg.goalPrompt), goal: cfg.goalPrompt, parentId: null, deps: [], depth: 0, phaseRoles: cfg.phaseRoles ?? emptyPhaseRoles(), now: deps.now() })
    this.byId = byIdMap([root])
  }

  nodes(): TaskNode[] { return [...this.byId.values()] }

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

  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    for (;;) {
      if (this.signal.aborted) { await this.propagateBlocked(true); return { status: 'blocked', reason: '已中断' } }
      const root = this.byId.get('root')!
      if (root.status === 'ACCEPTED') return { status: 'completed' }
      // pick the first advanceable node (serial). Deterministic order by id — a plain
      // codepoint compare, NOT localeCompare (which is locale/ICU-dependent).
      const ordered = [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const next = ordered.find(n => advanceableKind(n, this.byId) !== null)
      if (!next) {
        // deadlock: nothing advanceable and root not accepted. Surface WHY the tree is
        // dead by propagating BLOCKED upward before returning.
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      const kind = advanceableKind(next, this.byId)
      const ctx = this.ctx()
      try {
        if (kind === 'start') await stepStart(next, ctx)
        else if (kind === 'execute') await stepExecute(next, ctx)
        else if (kind === 'integrate') await stepIntegrate(next, ctx)
      } catch (e) {
        // A step should not normally throw (pipeline catches runAgent errors), but if one
        // does (e.g. persist failure), record the reason and keep the run alive.
        next.blockedReason = e instanceof Error ? e.message : String(e)
        // Do NOT clobber a parent whose subtree is still alive — BLOCKing it would strand
        // children that are still advanceable. Keep WAITING_CHILDREN only while at least
        // one child is non-terminal; otherwise this node would be re-picked forever.
        const subtreeAlive =
          next.status === 'WAITING_CHILDREN' &&
          next.childIds.length > 0 &&
          next.childIds.some(id => { const c = this.byId.get(id); return c !== undefined && !isTerminal(c.status) })
        if (!subtreeAlive) next.status = 'BLOCKED'
        next.updatedAt = this.deps.now()
        await this.deps.persist(next)
        this.deps.onUpdate(this.nodes())
      }
    }
  }

  // Fixpoint BLOCKED propagation: a non-terminal node with any BLOCKED child
  // (WAITING_CHILDREN ancestor), any BLOCKED dep, or any DANGLING dep (CREATED node that
  // can never start) becomes BLOCKED. Repeat until stable so death propagates up the tree.
  // `aborted` additionally sweeps mid-flight nodes so the final tree shows no phantom
  // "running" rows after an interrupt.
  private async propagateBlocked(aborted: boolean): Promise<void> {
    if (aborted) {
      for (const n of this.byId.values()) {
        if (n.status === 'PLANNING' || n.status === 'EXECUTING' || n.status === 'READY' || n.status === 'CREATED') {
          n.status = 'BLOCKED'
          if (!n.blockedReason) n.blockedReason = '已中断'
          n.updatedAt = this.deps.now()
          await this.deps.persist(n)
        }
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const n of this.byId.values()) {
        if (n.status === 'ACCEPTED' || n.status === 'BLOCKED') continue
        const childBlocked = n.childIds.some(id => this.byId.get(id)?.status === 'BLOCKED')
        // A dep id MISSING from byId is a dangling edge that can never resolve — treat it
        // like a blocked dep instead of leaving the node queued forever.
        const depDangling = n.deps.some(id => !this.byId.has(id))
        const depBlocked = n.deps.some(id => this.byId.get(id)?.status === 'BLOCKED')
        if (childBlocked || depBlocked || depDangling) {
          n.status = 'BLOCKED'
          if (!n.blockedReason) n.blockedReason = childBlocked ? '子节点阻断' : depDangling ? '依赖节点缺失' : '依赖阻断'
          n.updatedAt = this.deps.now()
          await this.deps.persist(n)
          changed = true
        }
      }
    }
    this.deps.onUpdate(this.nodes())
  }
}
