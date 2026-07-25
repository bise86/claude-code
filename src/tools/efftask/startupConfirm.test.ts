import { describe, expect, it } from 'bun:test'
import { DEFAULT_CAPS, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig } from './types.js'
import { createResolveOnce, raceConfirm, rosterLines } from './startupConfirm.js'

describe('startupConfirm racer', () => {
  it('createResolveOnce: only first claim wins', async () => {
    const r = createResolveOnce<number>()
    expect(r.claim()).toBe(true)
    expect(r.claim()).toBe(false)
    r.resolve(7)
    expect(await r.promise).toBe(7)
  })
  it('raceConfirm: first surface to resolve wins, others torn down', async () => {
    const torn: string[] = []
    const decision = await raceConfirm([
      (car) => { setTimeout(() => car({ parallelism: 5, approved: true }), 1); return () => torn.push('A') },
      (_car) => { return () => torn.push('B') },
    ])
    expect(decision.approved).toBe(true)
    expect(torn).toContain('B') // loser torn down
  })
  it('raceConfirm: a THROWING surface does not kill the race', async () => {
    const torn: string[] = []
    const decision = await raceConfirm([
      () => { throw new Error('飞书 surface 构造失败') },
      (car) => { setTimeout(() => car({ parallelism: 3, approved: true }), 1); return () => torn.push('B') },
    ])
    expect(decision.parallelism).toBe(3) // the surviving surface still wins
    expect(torn).toEqual(['B']) // only the surfaces that constructed successfully are torn down
  })
  it('rosterLines renders the REAL roster, 主模型 for phases with no bindings', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 5, caps: { ...DEFAULT_CAPS },
      phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'arch' }, { roleName: 'sec' }] },
    }
    const lines = rosterLines(cfg)
    expect(lines).toHaveLength(5) // one line per PHASE_NAMES entry
    expect(lines).toContain('评审: arch、sec')
    expect(lines).toContain('方案: 主模型')
  })
})
