// src/tools/efftask/stateMachine.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { byIdMap, depsSatisfied, childrenAllAccepted, advanceableKind, isTerminal, uiStatus, hasCycle } from './stateMachine.js'

const NOW = '2026-07-25T00:00:00Z'
const mk = (id: string, over: Partial<ReturnType<typeof createNode>> = {}) =>
  ({ ...createNode({ id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }), ...over })

describe('stateMachine', () => {
  it('depsSatisfied requires all deps ACCEPTED', () => {
    const a = mk('a', { status: 'ACCEPTED' })
    const b = mk('b', { status: 'EXECUTING' })
    const c = mk('c', { deps: ['a', 'b'] })
    const byId = byIdMap([a, b, c])
    expect(depsSatisfied(c, byId)).toBe(false)
    b.status = 'ACCEPTED'
    expect(depsSatisfied(c, byId)).toBe(true)
  })
  it('advanceableKind: CREATED+deps satisfied => start; else null', () => {
    const a = mk('a', { status: 'ACCEPTED' })
    const c = mk('c', { deps: ['a'], status: 'CREATED' })
    const byId = byIdMap([a, c])
    expect(advanceableKind(c, byId)).toBe('start')
    const d = mk('d', { deps: ['x-missing-not-accepted'], status: 'CREATED' })
    expect(advanceableKind(d, byIdMap([d]))).toBe(null)
  })
  it('advanceableKind: READY executable => execute', () => {
    const n = mk('n', { status: 'READY', kind: 'executable' })
    expect(advanceableKind(n, byIdMap([n]))).toBe('execute')
  })
  it('advanceableKind: WAITING_CHILDREN with all children ACCEPTED => integrate', () => {
    const p = mk('p', { status: 'WAITING_CHILDREN', childIds: ['p/01-x'] })
    const child = mk('p/01-x', { status: 'ACCEPTED', parentId: 'p' })
    expect(advanceableKind(p, byIdMap([p, child]))).toBe('integrate')
    child.status = 'EXECUTING'
    expect(advanceableKind(p, byIdMap([p, child]))).toBe(null)
  })
  it('advanceableKind: WAITING_CHILDREN with ZERO children => null (nothing to integrate)', () => {
    const p = mk('p', { status: 'WAITING_CHILDREN', childIds: [] })
    expect(advanceableKind(p, byIdMap([p]))).toBe(null)
  })
  it('uiStatus maps statuses to 4 buckets', () => {
    expect(uiStatus('ACCEPTED')).toBe('done')
    expect(uiStatus('EXECUTING')).toBe('running')
    expect(uiStatus('CREATED')).toBe('queued')
    expect(uiStatus('READY')).toBe('queued')
    expect(uiStatus('BLOCKED')).toBe('failed')
  })
  it('isTerminal true only for ACCEPTED/BLOCKED', () => {
    expect(isTerminal('ACCEPTED')).toBe(true)
    expect(isTerminal('BLOCKED')).toBe(true)
    expect(isTerminal('EXECUTING')).toBe(false)
  })
  it('hasCycle detects sibling dependency cycles', () => {
    const a = mk('a', { deps: ['b'] })
    const b = mk('b', { deps: ['a'] })
    expect(hasCycle([a, b])).toBe(true)
    const c = mk('c', { deps: [] })
    const d = mk('d', { deps: ['c'] })
    expect(hasCycle([c, d])).toBe(false) // acyclic chain
    const e = mk('e', { deps: ['nonexistent'] })
    expect(hasCycle([e])).toBe(false) // edge to node outside the set is ignored
  })
  it('hasCycle handles self-loops and duplicate dep edges', () => {
    // A child that lists itself as a dependency can never satisfy deps, so it must
    // be reported as a cycle rather than silently deadlocking the scheduler.
    expect(hasCycle([mk('a', { deps: ['a'] })])).toBe(true)
    // Duplicate edges must not double-count in-degree: Kahn increments and
    // decrements them in lock-step, so an acyclic group stays acyclic. A false
    // positive here would block a healthy sibling group.
    const c = mk('c', { deps: [] })
    const d = mk('d', { deps: ['c', 'c'] })
    expect(hasCycle([c, d])).toBe(false)
  })
})
