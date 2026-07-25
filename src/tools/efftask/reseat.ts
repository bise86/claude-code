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
  /**
   * Ids reopened by `--retry-blocked` — nodes a safety valve had stopped.
   *
   * Reported separately because the resume gate must SAY it: re-arming a valve is the one
   * thing on this path that spends budget the run had already refused to spend, and a user
   * who typed the flag from a card needs to see how many nodes it actually reached.
   */
  retried: string[]
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
export function reseatTransientNodes(
  nodes: TaskNode[], now: string, caps: Caps,
  /**
   * `--retry-blocked` (spec §9/§11): ALSO reopen nodes a safety valve stopped, and give each
   * a fresh budget for the phase it re-enters.
   *
   * Opt-in, and gated on the structural `capBlocked` flag rather than on reason text, so it
   * can never resurrect a node blocked by 依赖节点缺失 / 子节点缺失 / 依赖成环 — those are
   * unusable disk states, and re-running them would execute work whose upstream cannot be
   * verified while the run reported success.
   *
   * The budget RESET is the point: without it the node is reseated and instantly re-exhausted
   * by the check below, so the flag would be inert and the escalation card that names it
   * would be describing a command that does nothing.
   */
  opts: { retryBlocked?: boolean } = {},
): ReseatResult {
  // A node blocked ONLY because something below it failed. propagateBlocked writes this
  // reason on the way up and — unlike the abort path — never sets `interrupted`, so the
  // ancestors of a reopened node stayed BLOCKED. The scheduler then refuses to pick any node
  // with a blocked ancestor, so the reopened child was unreachable and the run immediately
  // re-blocked it as 上级任务阻断: measured, a resume that reopened the right node still made
  // ZERO model calls and the human's merge fix never landed.
  // All three are written BY propagateBlocked about someone else's failure — none is a
  // verdict on the node itself, and nothing anywhere else ever clears a blockedReason. Leaving
  // 依赖阻断 out meant a sibling stayed BLOCKED forever after the node it waited on reached
  // ACCEPTED, still rendering "✗ 依赖阻断" in the tree.
  const PROPAGATED = new Set(['子节点阻断', '上级任务阻断', '依赖阻断'])
  const byId = new Map(nodes.map(n => [n.id, n]))
  const reopenAncestors = (n: TaskNode): void => {
    let p = n.parentId === null ? undefined : byId.get(n.parentId)
    while (p && p.status === 'BLOCKED' && PROPAGATED.has(p.blockedReason)) {
      p.status = p.childIds.length > 0 ? 'WAITING_CHILDREN' : 'READY'
      p.blockedReason = ''
      p.updatedAt = now
      p = p.parentId === null ? undefined : byId.get(p.parentId)
    }
  }

  const reseated: string[] = []
  const exhausted: string[] = []
  const retried: string[] = []
  for (const n of nodes) {
    const wasInterrupted = n.status === 'BLOCKED' && n.interrupted === true
    // 触阀后的人工重试. Only with the explicit flag, and only for nodes a VALVE stopped.
    const retryValve = opts.retryBlocked === true && n.status === 'BLOCKED' && n.capBlocked === true
    // A conflict block is a VERDICT, so interrupted is false — yet it is the one blocked
    // state the user is explicitly invited to resume, because the card tells them to fix the
    // conflict and re-run. Without this the invitation was false: reseat skipped it and the
    // resumed run reported the identical block having made zero model calls.
    const awaitingHumanMerge = n.status === 'BLOCKED' && n.mergeConflict === true
    if (!ACTIVE.has(n.status) && !wasInterrupted && !awaitingHumanMerge && !retryValve) continue
    // Re-entry for this node is the ACCEPTANCE+merge path in stepExecute, which the flag
    // itself selects; the READY seat below is only how the scheduler picks it up again.

    /**
     * A valve retry must re-enter the phase that FAILED, not the phase the node's shape
     * suggests.
     *
     * `stepStart` writes `node.kind` from the plan output BEFORE the review roundtable runs,
     * so a plan that called itself `executable` and was then rejected three times sits at
     * BLOCKED with kind === 'executable'. The structural rule below would seat it at READY —
     * and `--retry-blocked` would hand a plan the reviewers unanimously refused straight to a
     * write-capable executor, with zero plan calls and zero reviews. Measured: phases called
     * were ["execute", "accept"] and the node reached ACCEPTED with planReview still at 3.
     *
     * If the exhausted budget was planReview, the node goes back to CREATED and re-plans.
     */
    // Rule 1 still wins. A node that ALREADY has children must never go to CREATED — that is
    // what builds a SECOND set (see the rules above), and no amount of "the review failed"
    // justifies duplicating a subtree. Believed unreachable today (a node that passed review
    // has planReview < cap, and growTree refuses PLAN_REVIEW targets), but the ordering is
    // what makes that a guarantee rather than an observation.
    //
    // Keyed on the RECORDED category, not on a fresh comparison against caps: the escalation
    // card tells the user to raise caps.maxIterations, run.md is where that lands, and reseat
    // reads run.md — so a derived check evaluated false exactly for the user who followed the
    // advice, and handed a thrice-rejected plan to a write-capable executor.
    const reviewExhausted =
      retryValve && n.childIds.length === 0 && n.capCategory === 'cap-iteration'
    const target: NodeStatus =
      n.childIds.length > 0 ? 'WAITING_CHILDREN'
      : reviewExhausted ? 'CREATED'
      : n.kind === 'executable' ? 'READY'
      : 'CREATED'

    // Charge the budget of the phase this node will ACTUALLY re-enter, not a fixed one:
    // a node going back to CREATED re-enters plan→review, so planReview is what binds.
    // Without this the resume spends a real write-capable execute call and a full acceptance
    // roundtable before discovering the cap — paying for a repo mutation nothing will consume.
    // The retry the human explicitly asked for BUYS a fresh budget for the phase this node
    // re-enters. Reseating without the reset would trip the exhausted check one line below —
    // the flag would be inert and the card naming it would describe a no-op.
    if (retryValve) {
      if (target === 'READY') n.iteration.acceptance = 0
      else if (target === 'CREATED') {
        // ALL of them. A node sent back to CREATED replays plan → review → execute → accept,
        // so leaving `acceptance` at the cap made the resume spend a real write-capable
        // execute call and a full acceptance roundtable and THEN discover it had no budget —
        // paying for a repo mutation nothing would consume. That is the exact waste the
        // budget check below was written to prevent.
        n.iteration.planReview = 0
        n.iteration.acceptance = 0
      } else n.iteration.integration = 0
      // Cleared so the NEXT valve trip is a fresh decision, and so a later plain `--resume`
      // does not silently keep offering a retry the user did not ask for again.
      n.capBlocked = false
      retried.push(n.id)
    }
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
    // Reopen the chain above too, or this seat is unreachable.
    reopenAncestors(n)
    // …and anything that was only waiting on this node. Same reason: the block was never
    // about them.
    for (const other of nodes) {
      if (other.status === 'BLOCKED' && PROPAGATED.has(other.blockedReason) && other.deps.includes(n.id)) {
        other.status = other.childIds.length > 0 ? 'WAITING_CHILDREN' : other.kind === 'executable' ? 'READY' : 'CREATED'
        other.blockedReason = ''
        other.updatedAt = now
      }
    }
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
    // Counted ONCE. A valve retry already has its own (louder) section at the resume gate;
    // pushing it here as well made "重开 1 个节点" render alongside "重新排队 1 个节点" with
    // the same id in both lists, reading as two nodes.
    if (!retryValve) reseated.push(n.id)
  }
  return { nodes, reseated, exhausted, retried }
}
