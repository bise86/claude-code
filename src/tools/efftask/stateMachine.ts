// src/tools/efftask/stateMachine.ts
import type { TaskNode, NodeStatus } from './types.js'

export function byIdMap(nodes: TaskNode[]): Map<string, TaskNode> {
  return new Map(nodes.map(n => [n.id, n]))
}

export function depsSatisfied(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  return node.deps.every(id => byId.get(id)?.status === 'ACCEPTED')
}

export function childrenAllAccepted(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  if (node.childIds.length === 0) return true
  return node.childIds.every(id => byId.get(id)?.status === 'ACCEPTED')
}

export function isTerminal(status: NodeStatus): boolean {
  return status === 'ACCEPTED' || status === 'BLOCKED'
}

export type AdvanceKind = 'start' | 'execute' | 'integrate' | null
export function advanceableKind(node: TaskNode, byId: Map<string, TaskNode>): AdvanceKind {
  if (node.status === 'CREATED' && depsSatisfied(node, byId)) return 'start'
  if (node.status === 'READY' && node.kind === 'executable' && depsSatisfied(node, byId)) return 'execute'
  // WAITING_CHILDREN with ZERO children has nothing to integrate — returning 'integrate'
  // would spin the orchestrator on an empty roundtable. Treat it as not advanceable.
  // depsSatisfied applies HERE too. It used to be checked only on the CREATED/READY paths,
  // so a node that reached WAITING_CHILDREN by another route — dynamic growth grafting
  // children onto it — could integrate while its own dependencies were still unfinished,
  // silently widening the one gate the whole tree is built on.
  if (node.status === 'WAITING_CHILDREN' && node.childIds.length > 0 && depsSatisfied(node, byId) && childrenAllAccepted(node, byId)) return 'integrate'
  return null
}

export type UiStatus = 'done' | 'running' | 'queued' | 'failed'
export function uiStatus(status: NodeStatus): UiStatus {
  if (status === 'ACCEPTED') return 'done'
  if (status === 'BLOCKED') return 'failed'
  if (status === 'CREATED' || status === 'READY' || status === 'WAITING_CHILDREN') return 'queued'
  return 'running'
}

// Cycle detection over the given node set. Only edges whose dep target is also
// in the set count (used by pipeline to check a freshly-created sibling group).
// Kahn's algorithm: if not every node can be topologically removed, a cycle exists.
export function hasCycle(nodes: TaskNode[]): boolean {
  const ids = new Set(nodes.map(n => n.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>() // dep id -> nodes that depend on it
  for (const n of nodes) { indeg.set(n.id, 0); dependents.set(n.id, []) }
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) continue // ignore edges to nodes outside the set
      dependents.get(d)!.push(n.id)
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
    }
  }
  const queue = [...ids].filter(id => (indeg.get(id) ?? 0) === 0)
  let removed = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    removed++
    for (const m of dependents.get(id) ?? []) {
      const next = (indeg.get(m) ?? 0) - 1
      indeg.set(m, next)
      if (next === 0) queue.push(m)
    }
  }
  return removed !== ids.size
}
