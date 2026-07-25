// src/tools/efftask/parseDirectives.test.ts
import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'
import { DEFAULT_CAPS } from './types.js'

describe('parseDirectives', () => {
  it('no modelJson => all defaults', async () => {
    const cfg = await parseDirectives('随便做点事', { knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(5)
    expect(cfg.goalPrompt).toBe('随便做点事')
  })
  it('applies parsed roles filtered by knownRoles', async () => {
    const modelJson = async () => JSON.stringify({
      parallelism: 3,
      phaseRoles: { review: ['architect', 'ghost'], execute: ['coder'] },
      caps: { maxDepth: 4 },
    })
    const cfg = await parseDirectives('做需求 X', { modelJson, knownRoles: ['architect', 'coder'] })
    expect(cfg.parallelism).toBe(3)
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'architect' }]) // ghost dropped
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'coder' }])
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(4)
    expect(cfg.caps.maxNodes).toBe(100) // untouched default
  })
  it('modelJson throws => defaults', async () => {
    const modelJson = async () => { throw new Error('boom') }
    const cfg = await parseDirectives('x', { modelJson, knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('modelJson returns garbage => defaults', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => 'not json', knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('clamps out-of-range parallelism', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => JSON.stringify({ parallelism: 0 }), knownRoles: [] })
    expect(cfg.parallelism).toBe(1)
  })

  const withModel = (o: unknown, knownRoles: string[] = []) =>
    parseDirectives('x', { modelJson: async () => JSON.stringify(o), knownRoles })

  it('safety caps can never be disabled, only clamped into range', async () => {
    const low = await withModel({ caps: { maxDepth: 0, maxNodes: -1, maxIterations: 0 } })
    expect(low.caps).toMatchObject({ maxDepth: 1, maxNodes: 1, maxIterations: 1 })
    const high = await withModel({ caps: { maxDepth: 9999, maxNodes: 1e9, maxIterations: 999 } })
    expect(high.caps).toMatchObject({ maxDepth: 20, maxNodes: 5000, maxIterations: 20 })
    const junk = await withModel({ caps: { maxDepth: 'deep', maxNodes: null, maxIterations: 'many' } })
    expect(junk.caps).toMatchObject({ maxDepth: 5, maxNodes: 100, maxIterations: 3 }) // untouched defaults
  })
  it('coerces or rejects non-numeric parallelism instead of trusting it', async () => {
    expect((await withModel({ parallelism: '3' })).parallelism).toBe(5) // string => default
    expect((await withModel({ parallelism: null })).parallelism).toBe(5)
    expect((await withModel({ parallelism: 3.7 })).parallelism).toBe(4) // rounded
    expect((await withModel({ parallelism: -5 })).parallelism).toBe(1)
    expect((await withModel({ parallelism: 1e9 })).parallelism).toBe(64)
  })
  it('survives hostile phaseRoles shapes without throwing', async () => {
    expect((await withModel({ phaseRoles: 'architect' }, ['architect'])).phaseRoles.review).toEqual([])
    expect((await withModel({ phaseRoles: { review: 'architect' } }, ['architect'])).phaseRoles.review).toEqual([])
    const messy = await withModel({ phaseRoles: { review: [null, '', '  ', 7, { n: 1 }, 'architect'], deploy: ['architect'] } }, ['architect'])
    expect(messy.phaseRoles.review).toEqual([{ roleName: 'architect' }]) // junk entries dropped
    expect(messy.phaseRoles.plan).toEqual([]) // unknown phase key ignored, no crash
  })
  it('dedupes repeated role names — one entry is one seat at the roundtable', async () => {
    const cfg = await withModel({ phaseRoles: { review: ['architect', 'architect', 'sec', 'architect'] } }, ['architect', 'sec'])
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'architect' }, { roleName: 'sec' }])
  })
  it('a top-level array or primitive degrades to defaults', async () => {
    for (const junk of ['[{"parallelism":99}]', '42', '"nope"', '[]', '', '   ']) {
      const cfg = await parseDirectives('x', { modelJson: async () => junk, knownRoles: [] })
      expect(cfg.parallelism).toBe(5)
      expect(cfg.caps.maxNodes).toBe(100)
    }
  })
  it('returns fresh objects — mutating one config never touches the next or the defaults', async () => {
    const a = await parseDirectives('x', { knownRoles: [] })
    const b = await parseDirectives('x', { knownRoles: [] })
    a.caps.maxDepth = 99
    a.phaseRoles.review.push({ roleName: 'leaked' })
    expect(b.caps.maxDepth).toBe(5)
    expect(b.phaseRoles.review).toEqual([])
    expect(DEFAULT_CAPS.maxDepth).toBe(5)
  })
})

describe('the roster must not promise what will not run', () => {
  const withRoles = (phaseRoles: unknown, opts: { knownRoles: string[]; unsupportedRoles?: string[] }) =>
    parseDirectives('x', { ...opts, modelJson: async () => JSON.stringify({ phaseRoles }) })

  it('reports unknown role names instead of silently dropping them', async () => {
    const cfg = await withRoles({ review: ['arch', 'ghost'] }, { knownRoles: ['arch'] })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'arch' }])
    expect(cfg.notices.join(' ')).toContain('ghost')
    expect(cfg.notices.join(' ')).toContain('未找到')
  })

  it('reports a CLI-mode role rather than downgrading it to the main model behind the name', async () => {
    // runAgent has no cli branch — the role's command/args would be ignored and the main
    // model would answer while the roster still displayed the role's name.
    const cfg = await withRoles({ accept: ['codex', 'sec'] }, { knownRoles: ['codex', 'sec'], unsupportedRoles: ['codex'] })
    expect(cfg.phaseRoles.accept).toEqual([{ roleName: 'sec' }])
    expect(cfg.notices.join(' ')).toContain('codex')
    expect(cfg.notices.join(' ')).toContain('CLI')
  })

  it('keeps only the plan/execute role that actually runs, and says so', async () => {
    // Only review and accept fan out; plan and execute run a single agent.
    const cfg = await withRoles(
      { plan: ['p1', 'p2'], execute: ['e1', 'e2'], review: ['r1', 'r2'] },
      { knownRoles: ['p1', 'p2', 'e1', 'e2', 'r1', 'r2'] },
    )
    expect(cfg.phaseRoles.plan).toEqual([{ roleName: 'p1' }])
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'e1' }])
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'r1' }, { roleName: 'r2' }]) // roundtable keeps all
    expect(cfg.notices.join(' ')).toContain('p2')
    expect(cfg.notices.join(' ')).toContain('e2')
  })

  it('does not seat an observer that P1 never calls', async () => {
    const cfg = await withRoles({ observer: ['watcher'] }, { knownRoles: ['watcher'] })
    expect(cfg.phaseRoles.observer).toEqual([])
    expect(cfg.notices.join(' ')).toContain('watcher')
    expect(cfg.notices.join(' ')).toContain('P3')
  })
})
