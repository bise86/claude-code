// src/tools/efftask/types.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM, PHASE_NAMES } from './types.js'

describe('createNode', () => {
  it('creates a node with sane defaults', () => {
    const n = createNode({ id: 'root', title: '根目标', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-25T00:00:00Z' })
    expect(n.id).toBe('root')
    expect(n.goal).toBe(n.title) // goal defaults to title when not provided
    expect(n.status).toBe('CREATED')
    expect(n.kind).toBe('unknown')
    expect(n.childIds).toEqual([])
    expect(n.iteration).toEqual({ planReview: 0, acceptance: 0, integration: 0, scoring: 0 })
    expect(n.plan).toEqual({ solution: '', keyPoints: '', risks: '', acceptance: '' })
    expect(n.blockedReason).toBe('') // blocking reason lives in its own field, not execStatus
    expect(n.createdAt).toBe('2026-07-25T00:00:00Z')
    expect(n.updatedAt).toBe('2026-07-25T00:00:00Z')
  })
  it('does not alias the phaseRoles object across nodes', () => {
    const roles = emptyPhaseRoles()
    const a = createNode({ id: 'a', title: 'a', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    const b = createNode({ id: 'b', title: 'b', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    a.phaseRoles.review = [{ roleName: 'arch' }]
    expect(b.phaseRoles.review).toEqual([]) // reassigning a key never leaks
  })
  it('does not alias the per-phase role ARRAYS across nodes or back to the source', () => {
    // The real hazard: children are created with the parent's phaseRoles object,
    // so an in-place push must not travel across the tree.
    const roles = emptyPhaseRoles()
    const a = createNode({ id: 'a', title: 'a', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    const b = createNode({ id: 'b', title: 'b', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    a.phaseRoles.plan.push({ roleName: 'arch' })
    expect(b.phaseRoles.plan).toEqual([])
    expect(roles.plan).toEqual([]) // and never back into the caller's config
  })
  it('does not alias the deps array back to the caller', () => {
    const deps = ['x']
    const n = createNode({ id: 'a', title: 'a', parentId: null, deps, depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-25T00:00:00Z' })
    n.deps.push('y')
    expect(deps).toEqual(['x'])
  })
  it('DEFAULT_CAPS, DEFAULT_PARALLELISM and PHASE_NAMES are stable', () => {
    expect(DEFAULT_CAPS.maxDepth).toBe(5)
    expect(DEFAULT_CAPS.maxNodes).toBe(100)
    expect(DEFAULT_CAPS.maxIterations).toBe(3)
    expect(DEFAULT_PARALLELISM).toBe(5)
    expect(PHASE_NAMES).toEqual(['plan','review','execute','accept','observer'])
  })
})
