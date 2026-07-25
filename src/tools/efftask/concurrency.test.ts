/**
 * Concurrency assertions that observe TIME, not just final state.
 *
 * Written after a review built the proposed pool verbatim and found all 16 existing
 * orchestrator tests green at parallelism 5 against an implementation that simultaneously
 * (a) failed to serialise execute, (b) hung the process on a rejected step, and (c) leaked
 * node-count budget. "The old tests still pass" is NOT evidence of concurrency correctness.
 * Every assertion here measures peak simultaneity or event ordering.
 */
import { describe, expect, it } from 'bun:test'
import { EffTaskOrchestrator } from './orchestrator.js'
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const tick = (ms = 5): Promise<void> => new Promise(r => setTimeout(r, ms))

const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '目标', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})
const deps = (runAgent: RunAgentFn) => ({
  runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
})

// Every phase prompt ends with a per-call nonce tag; a reply that omits it is rejected
// fail-closed, so a stub must echo it back or nothing ever passes.
const reply = (req: { prompt: string }, body: string): string => {
  const tag = req.prompt.match(/必须是一个 ```([a-zA-Z]+) 代码块/)?.[1] ?? ''
  return '```' + tag + '\n' + body + '\n```'
}
const THREE_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]},{"title":"丙","deps":[]}]}'
const LEAF = '{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}'

/** Root decomposes into three independent leaves; everything after that passes. */
function cooperative(opts: { delay?: number; onPhase?: (phase: string) => void } = {}) {
  let planned = false
  return (async (req: { phase: string; prompt: string }) => {
    opts.onPhase?.(req.phase)
    if (opts.delay) await tick(opts.delay)
    if (req.phase === 'plan') {
      const first = !planned
      planned = true
      return reply(req, first ? THREE_LEAVES : LEAF)
    }
    if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
    return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
  }) as unknown as RunAgentFn
}

/** Records peak simultaneous calls per phase — the only thing that can see a broken mutex. */
function phaseMeter() {
  const cur: Record<string, number> = {}
  const peak: Record<string, number> = {}
  let peakAny = 0
  let curAny = 0
  return {
    peak,
    peakAny: () => peakAny,
    wrap(inner: RunAgentFn): RunAgentFn {
      return (async (req: { phase: string }) => {
        cur[req.phase] = (cur[req.phase] ?? 0) + 1
        curAny++
        peak[req.phase] = Math.max(peak[req.phase] ?? 0, cur[req.phase])
        peakAny = Math.max(peakAny, curAny)
        try { return await (inner as (r: unknown) => Promise<string>)(req) }
        finally { cur[req.phase]--; curAny-- }
      }) as unknown as RunAgentFn
    },
  }
}

describe('the pool parallelises the read-only phases', () => {
  it('plans several sibling nodes at the same time', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5 }), deps(m.wrap(cooperative({ delay: 8 }))), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.plan).toBeGreaterThan(1)
  })

  it('NEVER runs two executors at once — that would overwrite work in one tree', async () => {
    // THE assertion of this phase. execute is the only phase with write-capable tools; two
    // executors editing one working tree overwrite each other while BOTH report success to
    // their own acceptance roundtables. A mutex that chains an already-started promise
    // measures 3 here — it serialises only the waiting.
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5 }), deps(m.wrap(cooperative({ delay: 12 }))), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.execute).toBe(1)
  })

  // NOT COVERED BY A TEST, and deliberately so — recorded rather than faked.
  //
  // The pool charges its budget against STARTED steps (`running`), not against `inFlight`,
  // so a queued-not-started execute holds no slot. That is the correct accounting, but no
  // end-to-end assertion here can discriminate it: the loop dispatches one batch per wake and
  // then awaits a completion, so the two accountings diverge by at most one slot and only
  // while `inFlight > parallelism` — a state a small fixture tree does not reach. Three
  // fixture shapes were tried; all three produced identical numbers under both versions.
  //
  // A test that passes under the broken version while claiming to guard the property is
  // worse than no test: it is exactly the false assurance that let a mutex which never
  // serialised anything ship green through 16 existing tests.

  it('never exceeds the configured limit', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }), deps(m.wrap(cooperative({ delay: 6 }))), new AbortController().signal)
    await orch.run()
    expect(m.peakAny()).toBeLessThanOrEqual(2)
  })
})

describe('a failing step must not take the run down with it', () => {
  it('a step that throws past the pipeline still lands on its node', async () => {
    // runStep must absorb its own errors and drive the node terminal, as the serial loop's
    // try/catch did. A rejection escaping it loses the terminal-drive AND poisons the
    // execute chain.
    //
    // Reaching that catch takes care: runPhase already swallows a throwing runAgent and
    // turns it into blockWithReason, so a failing MODEL never exercises runStep at all.
    // The reachable path is a transient clock failure inside commit().
    let calls = 0
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 2 }), {
      runAgent: cooperative({ delay: 2 }),
      persist: async () => {},
      now: () => { if (++calls === 3) throw new Error('clock died'); return new Date().toISOString() },
      onUpdate: () => {},
    }, new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('blocked')
    for (const node of orch.nodes()) expect(['ACCEPTED', 'BLOCKED']).toContain(node.status)
    expect(orch.nodes().map(x => x.blockedReason).join(' | ')).toContain('clock died')
  })

  it('a rejecting step does not poison the execute chain into a busy-loop', async () => {
    // A rejected task can permanently poison the execute chain: every later link rejects
    // immediately, so Promise.race resolves within a microtask and the loop spins forever.
    // Measured on the broken form: 200,000 iterations while a pending 30 ms timer NEVER
    // fired — no I/O, no timers, the process hung.
    //
    // The detector is the HANG itself, raced against a wall clock. A "did this timer fire"
    // check is not a detector: a healthy run finishes in well under the timer's delay, so
    // it reports failure on correct code and says nothing about starvation.
    let n = 0
    const inner = cooperative({ delay: 3 })
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), deps((async (req: { phase: string }) => {
      if (req.phase === 'execute' && ++n === 1) throw new Error('boom')
      return (inner as (r: unknown) => Promise<string>)(req)
    }) as unknown as RunAgentFn), new AbortController().signal)
    const outcome = await Promise.race([
      orch.run().then(r => r.status),
      tick(2000).then(() => 'HUNG' as const),
    ])
    expect(outcome).not.toBe('HUNG')
  })
})

describe('an interrupt must not declare a verdict while work is still landing', () => {
  it('nothing is persisted after run() has already answered', async () => {
    // propagateBlocked(true) sweeps and returns. A step still running would commit AFTER
    // the verdict, leaving the persisted tree contradicting what run() reported.
    //
    // What is NOT observable: "persists after the sweep started". A sibling interrupted
    // mid-step goes through blockWithReason, which ALSO sets interrupted — indistinguishable
    // from a sweep write. The clean boundary is run() returning: nothing may land after it.
    const ac = new AbortController()
    let returned = false
    const late: string[] = []
    let planned = false
    let leaf = 0
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), {
      runAgent: (async (req: { phase: string; prompt: string }) => {
        if (req.phase === 'plan' && !planned) { planned = true; await tick(2); return reply(req, THREE_LEAVES) }
        if (req.phase === 'plan') {
          // First leaf aborts at once; its SIBLINGS stay mid-plan for another 60 ms.
          if (++leaf === 1) { ac.abort(); return reply(req, LEAF) }
          await tick(60)
          return reply(req, LEAF)
        }
        if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
        return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
      }) as unknown as RunAgentFn,
      persist: async (n: TaskNode) => { if (returned) late.push(`${n.id}:${n.status}`) },
      now: () => new Date().toISOString(),
      onUpdate: () => {},
    }, ac.signal)
    const res = await orch.run()
    returned = true
    expect(res).toEqual({ status: 'blocked', reason: '已中断' })
    await tick(120) // outlast the slow siblings
    expect(late).toEqual([])
    for (const n of orch.nodes()) expect(n.status).toBe('BLOCKED')
  })
})

describe('parallelism = 1 reproduces the serial implementation exactly', () => {
  it('advances one node at a time', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1 }), deps(m.wrap(cooperative({ delay: 4 }))), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peakAny()).toBe(1)
  })
})
