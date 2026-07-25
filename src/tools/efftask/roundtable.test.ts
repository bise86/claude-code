// src/tools/efftask/roundtable.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { synthesizeVerdicts, runRoundtable, RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const node = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('roundtable', () => {
  it('synthesizeVerdicts unanimous pass', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: true, blocking: [], comments: '' }])
    expect(s.pass).toBe(true)
  })
  it('synthesizeVerdicts any fail => fail with summary', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: false, blocking: ['X 缺失'], comments: '' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('X 缺失')
  })
  it('synthesizeVerdicts: fail with NO blocking items falls back to comments (never empty)', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '方案太粗,缺落地步骤' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('方案太粗') // empty feedback => identical re-prompt => burned iterations
    const s2 = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '   ' }])
    expect(s2.blockingSummary.length).toBeGreaterThan(0) // still non-empty even without comments
  })
  it('runRoundtable with empty roles uses a single main reviewer', async () => {
    const calls: (string | null)[] = []
    const runAgent: RunAgentFn = async req => { calls.push(req.role ? req.role.roleName : null); return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [], round: 1, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(calls).toEqual([null])
    expect(rec.verdicts).toHaveLength(1)
    expect(rec.synthesized.pass).toBe(true)
  })
  it('runRoundtable multiple roles: any blocking fails', async () => {
    const runAgent: RunAgentFn = async req =>
      req.role?.roleName === 'sec'
        ? '```json\n{"pass":false,"blocking":["注入风险"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'sec' }], round: 2, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(rec.round).toBe(2)
    expect(rec.verdicts).toHaveLength(2)
    expect(rec.synthesized.pass).toBe(false)
    expect(rec.synthesized.blockingSummary).toContain('注入风险')
  })
  it('runRoundtable: a rejected role becomes a synthesized failing verdict, does NOT throw', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.role?.roleName === 'boom') throw new Error('调用崩溃')
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'boom' }], round: 1, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(rec.verdicts).toHaveLength(2)
    const boom = rec.verdicts.find(v => v.role === 'boom')!
    expect(boom.pass).toBe(false)
    expect(boom.blocking[0]).toContain('角色调用失败')
    expect(rec.synthesized.pass).toBe(false) // synthesized reflects the failing reviewer
  })
  it('an already-aborted signal dispatches nothing and fails closed', async () => {
    // First-party logic in the acceptance gate: without it, aborting would still spend a
    // whole roundtable of model calls and could synthesize a PASS from partial output.
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; return '```json\n{"pass":true,"blocking":[]}\n```' }
    const ac = new AbortController()
    ac.abort()
    const rec = await runRoundtable({ phase: 'accept', node: node(), roles: [{ roleName: 'a' }, { roleName: 'b' }], round: 2, system: 's', prompt: 'p', runAgent, signal: ac.signal })
    expect(calls).toBe(0)
    expect(rec.round).toBe(2)
    expect(rec.synthesized.pass).toBe(false)
    expect(rec.synthesized.blockingSummary).toContain('已中断')
  })
})
