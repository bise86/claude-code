import { describe, expect, it } from 'bun:test'
import { reseatTransientNodes } from './reseat.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('reseatTransientNodes returns killed-mid-phase nodes to a re-enterable state', () => {
  it('reopens nodes the abort sweep blocked — otherwise resume advances nothing at all', () => {
    // propagateBlocked(aborted) sweeps EVERY non-terminal node to BLOCKED, and Esc, Ctrl+C
    // and view teardown all go through it, so this is the dominant real-world resume input.
    // Verified against P1: without this, a resumed run makes ZERO model calls.
    const n = mk({ status: 'BLOCKED', interrupted: true, kind: 'executable', blockedReason: '已中断' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('READY')
    expect(out.nodes[0].interrupted).toBeFalsy()
    expect(out.nodes[0].blockedReason).toBe('') // it is no longer blocked; the reason must go
    expect(out.reseated).toContain('n')
  })

  it('does NOT reopen a node that really failed', () => {
    const n = mk({ status: 'BLOCKED', kind: 'executable', blockedReason: '验收迭代超限(3): 缺测试' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.reseated).toEqual([])
  })

  it('a node that already has children never reseats to CREATED', () => {
    // createChildren persists children BEFORE committing the parent, so a kill in that
    // window leaves PLAN_REVIEW + children on disk. CREATED would replan and build a second
    // set: same titles overwrite the recovered (possibly ACCEPTED) children; different
    // titles leave ghost siblings that childrenAllAccepted then waits on forever.
    const n = mk({ status: 'PLAN_REVIEW', kind: 'decompose', childIds: ['n/01-a'] })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status).toBe('WAITING_CHILDREN')
  })

  it('a non-executable kind reseats to CREATED, never to READY', () => {
    // advanceableKind only advances READY when kind === 'executable'; READY + unknown is
    // neither advanceable nor terminal, so the run dies with no reason and every later
    // --resume reproduces it byte for byte.
    for (const kind of ['unknown', 'decompose'] as const) {
      const n = mk({ status: 'EXECUTING', kind, childIds: [] })
      expect(`${kind}:${reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status}`).toBe(`${kind}:CREATED`)
    }
  })

  it('maps each active status through the same three rules', () => {
    const cases: [TaskNode['status'], TaskNode['kind'], string[], string][] = [
      ['PLANNING', 'unknown', [], 'CREATED'],
      ['PLAN_REVIEW', 'unknown', [], 'CREATED'],
      ['EXECUTING', 'executable', [], 'READY'],
      ['ACCEPTANCE', 'executable', [], 'READY'],
      ['REWORK', 'executable', [], 'READY'],
      ['INTEGRATION_ACCEPT', 'decompose', ['n/01-a'], 'WAITING_CHILDREN'],
    ]
    for (const [from, kind, childIds, to] of cases) {
      const out = reseatTransientNodes([mk({ status: from, kind, childIds })], NOW, DEFAULT_CAPS)
      expect(`${from}->${out.nodes[0].status}`).toBe(`${from}->${to}`)
    }
  })

  it('leaves settled statuses untouched', () => {
    for (const s of ['CREATED', 'READY', 'WAITING_CHILDREN', 'ACCEPTED'] as const) {
      const out = reseatTransientNodes([mk({ status: s })], NOW, DEFAULT_CAPS)
      expect(out.nodes[0].status).toBe(s)
      expect(out.reseated).toEqual([])
    }
  })

  it('does not touch iteration counters — restart must not refresh the budget', () => {
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 2, acceptance: 1, integration: 0 } })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].iteration)
      .toEqual({ planReview: 2, acceptance: 1, integration: 0 })
  })

  it('blocks a node whose budget for the phase it would re-enter is already spent', () => {
    // Otherwise resume spends a real WRITE-CAPABLE execute call plus a full acceptance
    // roundtable, and only THEN blocks on 验收迭代超限 — paying for a repo mutation that
    // nothing will consume.
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 0, acceptance: 3, integration: 0 } })
    const out = reseatTransientNodes([n], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.nodes[0].blockedReason).toContain('预算已耗尽')
    expect(out.exhausted).toContain('n')
    expect(out.nodes[0].interrupted).toBeFalsy() // must not be reopened by the next resume
  })

  it('applies the budget guard to the phase the node would ACTUALLY re-enter', () => {
    // A node going back to CREATED re-enters plan→review, so the planReview budget is the
    // one that matters; charging it the acceptance budget would block work that can still run.
    const planSpent = mk({ status: 'PLANNING', kind: 'unknown', iteration: { planReview: 3, acceptance: 0, integration: 0 } })
    const out1 = reseatTransientNodes([planSpent], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out1.nodes[0].status).toBe('BLOCKED')

    const acceptSpentButReplanning = mk({ status: 'PLANNING', kind: 'unknown', iteration: { planReview: 0, acceptance: 3, integration: 0 } })
    const out2 = reseatTransientNodes([acceptSpentButReplanning], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out2.nodes[0].status).toBe('CREATED')
  })

  it('annotates the interruption once, not once per crash cycle', () => {
    // Repeated crash/resume cycles would otherwise stack '(注:…)' lines into the evidence
    // acceptPrompt shows the reviewer.
    let n = mk({ status: 'EXECUTING', kind: 'executable', execStatus: '已改 src/a.ts' })
    for (let i = 0; i < 3; i++) {
      n = reseatTransientNodes([{ ...n, status: 'EXECUTING' }], NOW, DEFAULT_CAPS).nodes[0]
    }
    expect(n.execStatus).toContain('已改 src/a.ts')
    expect(n.execStatus.match(/中断/g)?.length).toBe(1)
  })

  it('does not annotate a node that never executed', () => {
    const n = mk({ status: 'PLANNING', kind: 'unknown', execStatus: '' })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].execStatus).toBe('')
  })

  it('stamps updatedAt from the injected clock so elapsed time still renders', () => {
    const out = reseatTransientNodes([mk({ status: 'EXECUTING', kind: 'executable', updatedAt: 'old' })], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].updatedAt).toBe(NOW)
  })
})
