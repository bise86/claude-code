import type { Caps, NodeStatus, TaskNode } from './types.js'

/**
 * Statuses that mean "a phase was in flight". A process kill leaves these on disk while
 * nothing is actually running any more.
 *
 * `EXECUTED`, `SCORING` and `MERGE` are in the NodeStatus union but are NEVER committed by
 * any code path (grep-verified against pipeline.ts), so writing rules for them would be
 * writing logic for dead states. If a later phase starts using them, add them here WITH a
 * test that drives the real transition.
 */
const ACTIVE: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'ACCEPTANCE', 'REWORK', 'INTEGRATION_ACCEPT',
])

const ANNOTATION = '(注:上次运行在此处中断,已重新排队)'

export interface ReseatResult {
  nodes: TaskNode[]
  /** Ids returned to a runnable state. */
  reseated: string[]
  /** Ids blocked because the phase they would re-enter has no budget left. */
  exhausted: string[]
}

/**
 * Return nodes that were mid-phase when the process died to a state the orchestrator can
 * safely re-enter.
 *
 * Two inputs qualify: the active statuses above, and `BLOCKED` nodes carrying
 * `interrupted === true`. The second set is the one that actually dominates in practice —
 * `propagateBlocked(aborted)` sweeps EVERY non-terminal node to BLOCKED, and Esc, Ctrl+C and
 * view teardown all go through it. Skipping them makes resume a no-op: verified against P1,
 * an interrupted-then-resumed run issues zero model calls.
 *
 * The target is chosen by three rules, in this order — the order is load-bearing:
 *
 *  1. **Already has children → `WAITING_CHILDREN`.** `createChildren` persists the children
 *     BEFORE committing the parent, so a kill in that window leaves a parent still claiming
 *     PLAN_REVIEW next to children that exist. Sending it to CREATED would replan and build a
 *     SECOND set: identical titles yield identical ids and overwrite the recovered (possibly
 *     ACCEPTED) children; different titles leave ghost siblings that `childrenAllAccepted`
 *     then waits on forever.
 *  2. **`kind === 'executable'` → `READY`.** That is the state before the interrupted
 *     execute/accept phase.
 *  3. **Otherwise → `CREATED`,** so `stepStart` re-derives the kind. This is why the rule
 *     cannot be a flat status→status map: `advanceableKind` only advances READY when the
 *     kind is executable, so READY on an `unknown` node is neither advanceable nor terminal —
 *     the run dies with no reason attached and every later `--resume` reproduces it exactly.
 *
 * Re-entry means the interrupted step runs again, possibly repeating a model call. That is
 * the deliberate trade: redo work rather than let half-finished work pass as finished.
 */
export function reseatTransientNodes(nodes: TaskNode[], now: string, caps: Caps): ReseatResult {
  const reseated: string[] = []
  const exhausted: string[] = []
  for (const n of nodes) {
    const wasInterrupted = n.status === 'BLOCKED' && n.interrupted === true
    if (!ACTIVE.has(n.status) && !wasInterrupted) continue

    const target: NodeStatus =
      n.childIds.length > 0 ? 'WAITING_CHILDREN'
      : n.kind === 'executable' ? 'READY'
      : 'CREATED'

    // Charge the budget of the phase this node will ACTUALLY re-enter, not a fixed one:
    // a node going back to CREATED re-enters plan→review, so planReview is what binds.
    // Without this the resume spends a real write-capable execute call and a full acceptance
    // roundtable before discovering the cap — paying for a repo mutation nothing will consume.
    const spent =
      target === 'READY' ? n.iteration.acceptance
      : target === 'CREATED' ? n.iteration.planReview
      : n.iteration.integration
    if (spent >= caps.maxIterations) {
      n.status = 'BLOCKED'
      n.blockedReason = `恢复时该阶段预算已耗尽(${spent}/${caps.maxIterations}),不再重试`
      n.interrupted = false // a later resume must not reopen it again
      n.updatedAt = now
      exhausted.push(n.id)
      continue
    }

    n.status = target
    n.interrupted = false
    // It is no longer blocked, so the reason must not linger — it would render in the tree
    // and be read as a live failure.
    n.blockedReason = ''
    // Annotate only where there IS execution evidence, and only once: repeated crash/resume
    // cycles would otherwise stack these lines into the text acceptPrompt shows the reviewer,
    // and a decompose node that never executed would gain an execStatus out of nowhere.
    // NOTE this is a breadcrumb, not evidence preservation — stepExecute overwrites
    // execStatus wholesale on the next run.
    if (n.execStatus.length > 0 && !n.execStatus.includes(ANNOTATION)) {
      n.execStatus = `${n.execStatus}\n${ANNOTATION}`
    }
    n.updatedAt = now
    reseated.push(n.id)
  }
  return { nodes, reseated, exhausted }
}
