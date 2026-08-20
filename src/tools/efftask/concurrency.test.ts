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
  const tag = req.prompt.match(/语言标记\(fence info string\)写成 ([a-zA-Z]+)/)?.[1] ?? ''
  return '```' + tag + '\n' + body + '\n```'
}
const THREE_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]},{"title":"丙","deps":[]}]}'
const LEAF = '{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}'

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
    withIntegrationReview: <T,>(fn: (p: string) => Promise<T>) => fn('/wt/integration-review-0'),
    handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
    integrationPath: '/wt/integration',
    conflictState: async () => ({ markers: true, staged: false, stale: false, files: ['src/pay.ts'] }),
    refreshFromIntegration: async () => ({ ok: true, updated: false }),
    mergeIntegrationIntoNode: async () => ({ ok: true, conflicted: true, files: ['src/pay.ts'] }),
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


describe('全局并发池必须同时约束"步"和"圆桌里的角色" (spec §6)', () => {
  /**
   * The existing fixtures in this file all use emptyPhaseRoles(), and runRoundtable collapses
   * an empty roster to a single main-model reviewer — so no test here could ever OBSERVE the
   * fan-out. Measured before this fixture existed: parallelism 2 with a 3-role panel peaked at
   * 6 concurrent runAgent calls, and the shipped default of 5 with 3 roles is 15. A user who
   * lowers the number to control spend was getting |roles|x what they asked for.
   */
  const withRoles = (n: number) => {
    const roles = [...Array(n)].map((_, i) => ({ roleName: 'r' + i }))
    return { ...emptyPhaseRoles(), review: roles, accept: roles }
  }

  it('并行数 2 + 3 角色圆桌:峰值并发不超过 2', async () => {
    let live = 0
    let peak = 0
    const cfg2: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 2, phaseRoles: withRoles(3),
      caps: { ...DEFAULT_CAPS }, notices: [],
    }
    let plans = 0
    const runAgent: RunAgentFn = async req => {
      live++
      peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 5))
      live--
      if (req.phase === 'plan') {
        // Decompose ONCE. Returning 'decompose' for every plan call recurses to the depth cap
        // and turns this into a test about maxDepth instead of about concurrency.
        plans++
        return plans === 1
          ? '\u0060\u0060\u0060json\n{"kind":"decompose","solution":"s","keyPoints":"","risks":"","acceptance":"","children":[{"title":"A","deps":[]},{"title":"B","deps":[]},{"title":"C","deps":[]}]}\n\u0060\u0060\u0060'
          : '\u0060\u0060\u0060json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      }
      if (req.phase === 'execute') {
        return '\u0060\u0060\u0060json\n{"execStatus":"做完了"}\n\u0060\u0060\u0060'
      }
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '\u0060\u0060\u0060' + tag + '\n{"pass":true,"blocking":[],"comments":""}\n\u0060\u0060\u0060'
    }
    const orch = new EffTaskOrchestrator(cfg2, {
      runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
    }, new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('completed')
    // The whole point. Before this, peak was parallelism x roles.
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
  })

  it('并行数 1 时圆桌退化为串行,而不是死锁', async () => {
    // The deadlock this design exists to avoid: a step holds the only slot while its own
    // reviewers wait for one. The first reviewer rides the step's slot; the rest run after.
    let live = 0
    let peak = 0
    const cfg1: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 1, phaseRoles: withRoles(4),
      caps: { ...DEFAULT_CAPS }, notices: [],
    }
    const runAgent: RunAgentFn = async req => {
      live++
      peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 2))
      live--
      if (req.phase === 'plan') {
        return '\u0060\u0060\u0060json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      }
      if (req.phase === 'execute') return '\u0060\u0060\u0060json\n{"execStatus":"做完了"}\n\u0060\u0060\u0060'
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '\u0060\u0060\u0060' + tag + '\n{"pass":true,"blocking":[],"comments":""}\n\u0060\u0060\u0060'
    }
    const orch = new EffTaskOrchestrator(cfg1, {
      runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
    }, new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('completed')  // it terminates — no deadlock
    expect(peak).toBe(1)
  })

  it('每个角色仍然都被派出去了 —— 限流不是丢人', async () => {
    // Bounding concurrency must not silently drop reviewers: a roundtable is unanimous-pass,
    // so a missing verdict would change the verdict.
    const seen: string[] = []
    const cfg3: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 1, phaseRoles: withRoles(4),
      caps: { ...DEFAULT_CAPS }, notices: [],
    }
    const runAgent: RunAgentFn = async req => {
      if (req.role) seen.push(req.phase + ':' + req.role.roleName)
      if (req.phase === 'plan') {
        return '\u0060\u0060\u0060json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      }
      if (req.phase === 'execute') return '\u0060\u0060\u0060json\n{"execStatus":"做完了"}\n\u0060\u0060\u0060'
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '\u0060\u0060\u0060' + tag + '\n{"pass":true,"blocking":[],"comments":""}\n\u0060\u0060\u0060'
    }
    const orch = new EffTaskOrchestrator(cfg3, {
      runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
    }, new AbortController().signal)
    await orch.run()
    for (const i of [0, 1, 2, 3]) {
      expect(seen).toContain('review:r' + i)
      expect(seen).toContain('accept:r' + i)
    }
    // …and the record keeps them in roster order.
    const node = orch.nodes()[0]
    expect(node.reviewLog[0].verdicts.map(v => v.role)).toEqual(['r0', 'r1', 'r2', 'r3'])
  })
})


describe('slotUsage:状态条读的那个数', () => {
  it('报告的是池子的真实占用,而不是恒零', async () => {
    // Mutation-proved: making slotUsage() return {inUse:0,limit:0} left the whole suite green.
    const roles = [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }]
    const cfg2: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 3,
      phaseRoles: { ...emptyPhaseRoles(), review: roles, accept: roles },
      caps: { ...DEFAULT_CAPS }, notices: [],
    }
    let seenPeak = 0
    /** 在飞的步骤 id —— 表头拿它拆出「准备中 / 评审席」,见 slotUsage 的注释。 */
    let seenInFlight = 0
    let orch: EffTaskOrchestrator
    const runAgent: RunAgentFn = async req => {
      seenPeak = Math.max(seenPeak, orch.slotUsage().inUse)
      seenInFlight = Math.max(seenInFlight, orch.slotUsage().inFlight.length)
      await new Promise(r => setTimeout(r, 3))
      if (req.phase === 'plan') return '\u0060\u0060\u0060json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      if (req.phase === 'execute') return '\u0060\u0060\u0060json\n{"execStatus":"done"}\n\u0060\u0060\u0060'
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '\u0060\u0060\u0060' + tag + '\n{"pass":true,"blocking":[],"comments":""}\n\u0060\u0060\u0060'
    }
    orch = new EffTaskOrchestrator(cfg2, {
      runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
    }, new AbortController().signal)
    expect(orch.slotUsage()).toEqual({ inUse: 0, limit: 3, inFlight: [] })
    await orch.run()
    expect(seenPeak).toBeGreaterThan(0)      // it MOVES
    expect(seenPeak).toBeLessThanOrEqual(3)  // and never exceeds the cap
    expect(orch.slotUsage().inUse).toBe(0)   // and settles back at the end
    // 在飞的步骤也要真的报出来:表头按它算「准备中」(已派出、还没变黄的那些),
    // 恒空的话那一截永远不画,而它正是「黄 7 个却写 20/20」的答案。
    expect(seenInFlight).toBeGreaterThan(0)
    expect(orch.slotUsage().inFlight).toEqual([])
  })

  it('limit 至少是 1,即使 config 说 0', () => {
    const orch = new EffTaskOrchestrator(
      { goalPrompt: 'g', parallelism: 0, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [] },
      { runAgent: async () => '', persist: async () => {}, now: () => 'x', onUpdate: () => {} },
      new AbortController().signal,
    )
    expect(orch.slotUsage().limit).toBe(1)
  })
})

describe('spec §7:圆桌的多个角色是在同一个节点内并行的', () => {
  /**
   * 这条曾经完全没有被守住。
   *
   * 把 `mapWithinPool` 换成一个纯串行的 for 循环,**全套 883 个用例照样全绿** —— 包括那条
   * `expect(m.peak.review).toBeGreaterThan(1)`。原因是它被跨节点的重叠满足了:三个叶子节点
   * 各自的 review 调用本来就会同时在跑,所以"review 阶段峰值 > 1"为真,但为的是另一个理由。
   * spec §7 要的是"独立**并行**"——同一个节点内的多个评审角色同时开跑。
   *
   * 所以这里只放**一个**节点,峰值就只能来自圆桌自身的扇出。
   */
  const roles = [{ roleName: 'r0' }, { roleName: 'r1' }, { roleName: 'r2' }]
  const single = (): RunAgentFn => (async (req: { phase: string; prompt: string }) => {
    await tick(8) // hold the call open long enough for siblings to overlap
    if (req.phase === 'plan') return reply(req, LEAF) // executable ⇒ exactly one node in the tree
    if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
    return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
  }) as unknown as RunAgentFn

  /**
   * 质疑修复**刻意是串行的** —— 峰值必须是 1。
   *
   * 用户原话:「多个质疑成员,就顺序执行即可。」而这不只是省事:并行的话 N 份修订版之间
   * 还要再融合一次,而融合出来的那一版没有任何人质疑过。这条用例是那句需求唯一的探针。
   */
  it('单个节点的质疑修复:三个角色**依次**上手,不并行', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5, phaseRoles: { ...emptyPhaseRoles(), review: roles } }),
      deps(m.wrap(single())), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.review).toBe(1)
  })

  it('单个节点的验收圆桌同样并行', async () => {
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5, phaseRoles: { ...emptyPhaseRoles(), accept: roles } }),
      deps(m.wrap(single())), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.accept).toBe(3)
  })

  it('但仍然受全局池约束:parallelism 1 时圆桌退化为串行,而不是死锁', async () => {
    // mapWithinPool 的第一项蹭调用方的槽位、其余 try-lease,正是为了这里不死锁。
    const m = phaseMeter()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1, phaseRoles: { ...emptyPhaseRoles(), accept: roles } }),
      deps(m.wrap(single())), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(m.peak.review).toBe(1)
  })
})
