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

  it('a QUEUED execute holds no pool slot: read-only work keeps flowing behind the mutex', async () => {
    // The pool charges its budget against STARTED steps (`running`), not against `inFlight`,
    // so a queued-not-started execute holds no slot. Get that wrong —
    // `budget = parallelism - inFlight.size` — and the executes waiting on the serial chain
    // eat the whole pool, so every other phase starves behind them. Against a one-line mutant
    // of that expression the broken pool dispatches NOTHING for the entire window.
    //
    // The fixture must satisfy THREE conditions at once or the two accountings agree and the
    // assertion is vacuous — three earlier fixture shapes failed on exactly this, and an
    // earlier version of this file wrongly concluded no end-to-end assertion could exist:
    //   1. several executable leaves become READY together, so >=2 executes sit in `inFlight`
    //      while the mutex lets only one run (traced: inFlight 11 vs running 3);
    //   2. a DEEP supply of purely read-only work that stays available throughout — a shallow
    //      read-only fan-out is exhausted before the window opens and measures nothing;
    //   3. the window is "the FIRST execute holds the tree", NOT "any execute is running".
    //      execute is serial, so the latter is true for nearly the whole run and the count
    //      degenerates into "how many read-only steps does this tree have" — a property of
    //      the fixture, identical under both accountings.
    //
    // Divergence begins at `inFlight.size > running` (at parallelism 3 that is inFlight 2),
    // not at `inFlight > parallelism`, and the gap reaches 3 slots rather than 1.
    const CHAIN_DEPTH = 5
    const decompose = (titles: string[]): string => JSON.stringify({
      kind: 'decompose', solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a',
      children: titles.map(t => ({ title: t, deps: [] })),
    })
    const kids = [
      ...Array.from({ length: 4 }, (_, i) => `E${i + 1}`),   // queue on the execute chain
      ...Array.from({ length: 8 }, (_, i) => `P${i + 1}`),   // pure read-only chains
    ]

    const TARGET = 12
    let readOnlyInWindow = 0
    let windowOpen = false
    let windowClosed = false
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })

    // Every status change goes through persist, so it is a complete observation channel.
    // A queued execute is still READY — commit('EXECUTING') happens when its step STARTS —
    // so "executable leaves at READY while one executes" is exactly the state under test.
    const seen = new Map<string, { title: string; status: string }>()
    let peakReadyExecutables = 0

    const orch = new EffTaskOrchestrator(cfg({
      parallelism: 3,
      caps: { maxDepth: 8, maxNodes: 400, maxIterations: 2, nodeTimeoutMs: 600_000 },
    }), {
      runAgent: (async (req: { phase: string; node: TaskNode; prompt: string }) => {
        if (windowOpen && !windowClosed && (req.phase === 'plan' || req.phase === 'review')) {
          if (++readOnlyInWindow >= TARGET) release()
        }
        if (req.phase === 'plan') {
          await tick(2)
          if (req.node.id === 'root') return reply(req, decompose(kids))
          if (req.node.title.startsWith('E')) return reply(req, LEAF)
          // Each chain node plans into exactly ONE child: a long-lived read-only supply.
          if (req.node.depth < CHAIN_DEPTH) return reply(req, decompose([req.node.title + '-']))
          return reply(req, LEAF)
        }
        if (req.phase === 'execute' && req.node.title.startsWith('E') && !windowOpen) {
          windowOpen = true
          // Hold the tree open until the pool has DISPATCHED enough read-only work. The timer
          // is only a safety net so a regression fails instead of hanging: the pass criterion
          // is the COUNT, never elapsed time.
          await Promise.race([gate, tick(2000)])
          windowClosed = true
          return reply(req, '{"execStatus":"done"}')
        }
        if (req.phase === 'execute') { await tick(2); return reply(req, '{"execStatus":"done"}') }
        await tick(2)
        return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
      }) as unknown as RunAgentFn,
      persist: async (n: TaskNode) => {
        seen.set(n.id, { title: n.title, status: n.status })
        if (!windowOpen || windowClosed) return
        let ready = 0
        for (const v of seen.values()) if (v.status === 'READY' && v.title.startsWith('E')) ready++
        peakReadyExecutables = Math.max(peakReadyExecutables, ready)
      },
      now: () => new Date().toISOString(),
      onUpdate: () => {},
    }, new AbortController().signal)

    expect((await orch.run()).status).toBe('completed')
    // Fixture-rot guard: without an executable parked at READY behind the one the mutex is
    // running, nothing is queued, the two accountings agree, and the count below would pass
    // vacuously. Holds under both implementations — it is a property of the tree.
    expect(peakReadyExecutables).toBeGreaterThanOrEqual(1)
    // Gate trips at 12; the mutant dispatches 0 for the whole window.
    expect(readOnlyInWindow).toBeGreaterThanOrEqual(8)
  }, 20_000)

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

  // NOT COVERED BY A TEST, and recorded rather than faked — same standard as the budget
  // note above.
  //
  // `executeChain.then(step, step)` uses the same handler on both settle paths so one
  // rejection cannot poison every later link. A poisoned chain makes Promise.race resolve in
  // a microtask forever (a review measured 200k iterations with a pending 30 ms timer never
  // firing). But it is UNREACHABLE defence: runStep catches everything, so no step can
  // reject, so the chain cannot be poisoned. Mutating the second handler away leaves the
  // suite green — correctly, because nothing can exercise it.
  //
  // The previous test here claimed to guard this and could not fail: it fed a throwing
  // runAgent, which runPhase swallows inside the pipeline (see the clock-failure test above
  // for the only path that actually reaches runStep's catch). Keep the second handler as
  // belt-and-braces; do not pretend it is tested.

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

describe('what is and is not parallel — pinned, because the gate tells the user', () => {
  it('leaf acceptance is SERIAL *when un-isolated*: it lives inside the execute loop', async () => {
    // The acceptance roundtable for an executable leaf runs inside stepExecute's
    // execute→accept→rework for(;;) loop, and that whole loop is what goes on the serial
    // chain. So the globally-serialised region is not one execute call — it is execute plus
    // leaf acceptance plus every rework round, up to maxIterations.
    //
    // This is pinned because the confirmation gate makes a claim about it to the user, and
    // an earlier wording said 验收阶段并行, which is false.
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 20 }), deps(m.wrap(cooperative({ delay: 10 }))), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.plan).toBeGreaterThan(1)   // 方案 fans out
    expect(m.peak.review).toBeGreaterThan(1) // 评审 fans out
    expect(m.peak.execute).toBe(1)           // 执行 does not
    expect(m.peak.accept).toBe(1)            // …and neither does leaf 验收
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

describe('隔离可用时才解除 execute 串行(用户第一句的后半)', () => {
  // A previous phase pinned `peak.execute === 1` unconditionally. That was true THEN, and
  // keeping it would have quietly capped the feature at half — so these assertions replace it
  // with the real rule: serial without isolation, parallel with it.
  const fakePool = {
    init: async () => ({ ok: true as const }),
    acquire: async (n: TaskNode) => ({ path: `/wt/${n.id}`, branch: `worktree-${n.id}`, gitRoot: '/repo' }),
    commitAndMerge: async () => ({ ok: true as const, merged: true }),
    release: async () => ({ removed: true }),
    dispose: async () => ({ kept: [] }),
    withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
    handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
    integrationPath: '/wt/integration',
    integrationBranchName: 'efftask/001/integration',
  }

  it('WITHOUT isolation, execute stays strictly serial', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5 }), deps(m.wrap(cooperative({ delay: 12 }))), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.execute).toBe(1)
  })

  it('WITH isolation, executors really do run at the same time', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5 }),
      { ...deps(m.wrap(cooperative({ delay: 12 }))), worktrees: fakePool as never },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.execute).toBeGreaterThan(1)
  })

  it('isolation does not let the pool exceed the configured limit', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }),
      { ...deps(m.wrap(cooperative({ delay: 8 }))), worktrees: fakePool as never },
      new AbortController().signal,
    )
    await orch.run()
    expect(m.peakAny()).toBeLessThanOrEqual(2)
  })
})
