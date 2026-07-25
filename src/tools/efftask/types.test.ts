// src/tools/efftask/types.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, PHASE_NAMES } from './types.js'

describe('createNode', () => {
  it('creates a node with sane defaults', () => {
    const n = createNode({ id: 'root', title: '根目标', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-25T00:00:00Z' })
    expect(n.id).toBe('root')
    expect(n.goal).toBe(n.title) // goal defaults to title when not provided
    expect(n.status).toBe('CREATED')
    expect(n.kind).toBe('unknown')
    expect(n.childIds).toEqual([])
    expect(n.iteration).toEqual({ planReview: 0, acceptance: 0 })
    expect(n.plan.solution).toBe('')
    expect(n.blockedReason).toBe('') // blocking reason lives in its own field, not execStatus
    expect(n.createdAt).toBe('2026-07-25T00:00:00Z')
    expect(n.updatedAt).toBe('2026-07-25T00:00:00Z')
  })
  it('does not alias the phaseRoles object across nodes', () => {
    const roles = emptyPhaseRoles()
    const a = createNode({ id: 'a', title: 'a', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    const b = createNode({ id: 'b', title: 'b', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    a.phaseRoles.review = [{ roleName: 'arch' }]
    expect(b.phaseRoles.review).toEqual([]) // shallow copy: mutating one node never leaks to another
  })
  it('DEFAULT_CAPS and PHASE_NAMES are stable', () => {
    expect(DEFAULT_CAPS.maxDepth).toBe(5)
    expect(DEFAULT_CAPS.maxNodes).toBe(100)
    expect(DEFAULT_CAPS.maxIterations).toBe(3)
    expect(PHASE_NAMES).toEqual(['plan','review','execute','accept','observer'])
  })
})
