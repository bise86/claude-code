import { advanceableKind, isTerminal } from './stateMachine.js'
import type { TaskNode } from './types.js'

export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }

/**
 * Per-node no-progress counter.
 *
 * The serial orchestrator used ONE global fingerprint ("was the same node picked twice in a
 * row?"). That is meaningful only while exactly one node moves at a time: with N steps in
 * flight, any other node completing resets it, so a node that cannot progress spins forever
 * issuing real model calls — the guard becomes decorative exactly when it is needed. Keyed
 * per node, it means the same thing under any concurrency.
 *
 * NOTE this is defence in depth: no current state-machine path can actually trigger it
 * (every step leaves its node terminal, or at READY/WAITING_CHILDREN, neither re-pickable in
 * the same status). Don't over-invest — but DO keep it reachable on the failure path, which
 * is the one way it could ever be needed.
 */
export function createStallTracker(): StallTracker {
  const seen = new Map<string, { fingerprint: string; count: number }>()
  return {
    note(id, status) {
      const prev = seen.get(id)
      const next = prev && prev.fingerprint === status ? prev.count + 1 : 1
      seen.set(id, { fingerprint: status, count: next })
      return next
    },
    clear(id) { seen.delete(id) },
  }
}

function hasBlockedAncestor(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  // `seen` is not defensive dressing: a parent/child cycle really can come back from disk,
  // and without it this walk never terminates.
  const seen = new Set<string>()
  let cur = node.parentId ? byId.get(node.parentId) : undefined
  while (cur && !seen.has(cur.id)) {
    if (cur.status === 'BLOCKED') return true
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return false
}

export type Advanceable = { node: TaskNode; kind: 'start' | 'execute' | 'integrate' }

/**
 * Everything that can move right now, capped at `limit`.
 *
 * MUST be called and its results dispatched with NO await in between: JavaScript is
 * single-threaded, so an uninterrupted scan-then-dispatch makes the dependency check atomic
 * by construction. Put an await there and a sibling can BLOCK a dependency between the check
 * and the launch, and the node would run against a dead dependency.
 *
 * The return type deliberately excludes `null` so the caller's dispatch cannot fall through
 * to a runtime "unhandled kind" branch.
 */
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): Advanceable[] {
  if (limit <= 0) return []
  const out: Advanceable[] = []
  // Deterministic order by id — a plain codepoint compare, NOT localeCompare (locale/ICU
  // dependent). KNOWN LIMITATION: with real providers, which node FINISHES first is
  // latency-dependent, so the order of advancement — and hence which node loses a maxNodes
  // race — is not reproducible run to run even though this scan is.
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const n of ordered) {
    if (out.length >= limit) break
    if (inFlight.has(n.id)) continue // one step per node: two would double-spend its budget
    if (isTerminal(n.status)) continue
    if (hasBlockedAncestor(n, byId)) continue
    const kind = advanceableKind(n, byId)
    if (kind !== null) out.push({ node: n, kind })
  }
  return out
}
