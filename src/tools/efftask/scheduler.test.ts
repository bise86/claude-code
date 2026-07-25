import { describe, expect, it } from 'bun:test'
import { createStallTracker, pickBatch } from './scheduler.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
const tree = (...nodes: TaskNode[]) => ({ nodes, byId: byIdMap(nodes) })

describe('pickBatch selects everything that can move, up to the limit', () => {
  it('returns independent siblings together', () => {
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/a', 'root/b'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
      mk({ id: 'root/b', parentId: 'root', status: 'READY', kind: 'executable' }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5).map(x => x.node.id)).toEqual(['root/a', 'root/b'])
  })

  it('never picks a node whose dependency has not been ACCEPTED', () => {
    // The dependency gate is the point of the tree; concurrency must not widen it.
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/a', 'root/b'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
      mk({ id: 'root/b', parentId: 'root', status: 'READY', kind: 'executable', deps: ['root/a'] }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5).map(x => x.node.id)).toEqual(['root/a'])
  })

  it('never re-picks a node that is already in flight', () => {
    // Two concurrent steps on ONE node would double its iteration spend and interleave two
    // writes to the same node.md.
    const a = mk({ id: 'a', status: 'READY', kind: 'executable' })
    expect(pickBatch([a], byIdMap([a]), new Set(['a']), 5)).toEqual([])
  })

  it('honours the limit and is deterministic about who goes first', () => {
    const kids = ['root/a', 'root/b', 'root/c'].map(id =>
      mk({ id, parentId: 'root', status: 'READY', kind: 'executable' }))
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids.map(k => k.id) }), ...kids)
    expect(pickBatch(nodes, byId, new Set(), 2).map(x => x.node.id)).toEqual(['root/a', 'root/b'])
    expect(pickBatch(nodes, byId, new Set(), 0)).toEqual([])
    expect(pickBatch(nodes, byId, new Set(), -1)).toEqual([])
  })

  it('skips a node under a BLOCKED ancestor', () => {
    // KNOWN LIMITATION, stated so this test does not imply more than it proves:
    // propagateBlocked only runs at deadlock/abort, so a failed sibling does NOT make the
    // parent BLOCKED mid-run — sibling nodes keep spending real model calls on a doomed
    // subtree. This covers the post-propagation shape only.
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'BLOCKED', kind: 'decompose', childIds: ['root/a'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5)).toEqual([])
  })

  it('does not hang on a parent/child cycle recovered from disk', () => {
    const { nodes, byId } = tree(
      mk({ id: 'a', parentId: 'b', status: 'READY', kind: 'executable' }),
      mk({ id: 'b', parentId: 'a', status: 'READY', kind: 'executable' }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5).map(x => x.node.id)).toEqual(['a', 'b'])
  })
})

describe('the no-progress guard must be PER NODE once work overlaps', () => {
  it('is not reset by another node making progress in between', () => {
    // The serial guard used ONE global "last picked" fingerprint. With N in flight, any
    // other node finishing resets it, so a genuinely stuck node spins forever issuing real
    // model calls — the guard becomes decorative exactly when it is needed.
    const t = createStallTracker()
    expect(t.note('a', 'READY')).toBe(1)
    t.note('b', 'CREATED')
    expect(t.note('a', 'READY')).toBe(2)
  })

  it('resets when the node actually moves', () => {
    const t = createStallTracker()
    t.note('a', 'READY')
    expect(t.note('a', 'EXECUTING')).toBe(1)
  })

  it('clear() forgets a node entirely', () => {
    const t = createStallTracker()
    t.note('a', 'READY')
    t.clear('a')
    expect(t.note('a', 'READY')).toBe(1)
  })
})
