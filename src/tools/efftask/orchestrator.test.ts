// src/tools/efftask/orchestrator.test.ts
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig } from './types.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import type { RunAgentFn } from './roundtable.js'

// Verdict prompts carry a per-call random tag; a cooperative reviewer answers under THAT tag.
// Anything else in the reply is quoted context, which parseVerdict deliberately refuses.
const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const NOW = '2026-07-25T00:00:00Z'
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({ goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over })
const deps = (runAgent: RunAgentFn) => ({ runAgent, persist: async () => {}, now: () => NOW, onUpdate: () => {} })

describe('EffTaskOrchestrator (serial)', () => {
  it('single executable root: plan->review->execute->accept => completed', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('completed')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('ACCEPTED')
  })

  it('decompose root with two children (dep chain) all accepted => completed', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"first","deps":[]},{"title":"second","deps":["first"]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"跑 bun test 全绿"}\n```'
      }
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('completed')
    const ids = orch.nodes().map(n => n.id).sort()
    expect(ids).toContain('root/01-first')
    expect(ids).toContain('root/02-second')
    expect(orch.nodes().every(n => n.status === 'ACCEPTED')).toBe(true)
  })

  it('dependency gating: second child not executed before first accepted', async () => {
    const execOrder: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"first","deps":[]},{"title":"second","deps":["first"]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"跑 bun test 全绿"}\n```'
      }
      if (req.phase === 'execute') { execOrder.push(req.node.id); return '```json\n{"execStatus":"done"}\n```' }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    await orch.run()
    expect(execOrder).toEqual(['root/01-first', 'root/02-second'])
  })

  it('blocked plan (review always fails) => run returns blocked', async () => {
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan' ? '```json\n{"kind":"executable","solution":"weak"}\n```' : vtag(req) + '\n{"pass":false,"blocking":["no"],"comments":""}\n```'
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    expect((await orch.run()).status).toBe('blocked')
  })

  it('BLOCKED propagates: a child that always fails acceptance => root ends BLOCKED, run returns blocked', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"only","deps":[]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"跑 bun test 全绿"}\n```'
      }
      if (req.phase === 'review') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```' // plans pass review
      if (req.phase === 'execute') return '```json\n{"execStatus":"did"}\n```'
      return vtag(req) + '\n{"pass":false,"blocking":["永远不过"],"comments":""}\n```' // child acceptance always fails → BLOCKED after maxIterations
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    const child = orch.nodes().find(n => n.id === 'root/01-only')!
    expect(child.status).toBe('BLOCKED')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED') // propagated up from the BLOCKED child
  })

  // ---- failure-path coverage: the driver is the only thing that can hang a whole run ----

  const allPass: RunAgentFn = async req => {
    if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
    if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
    return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
  }

  it('a pre-aborted run resolves as blocked without dispatching anything', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; return '' }
    const ac = new AbortController(); ac.abort()
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), ac.signal)
    expect(await orch.run()).toEqual({ status: 'blocked', reason: '已中断' })
    expect(calls).toBe(0)
    expect(orch.nodes()[0].status).toBe('BLOCKED') // no phantom "running" row left behind
  })

  it('aborting mid-run stops promptly and sweeps every non-terminal node', async () => {
    const ac = new AbortController()
    let calls = 0
    const runAgent: RunAgentFn = async req => { calls++; if (calls === 2) ac.abort(); return allPass(req) }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), ac.signal)
    expect((await orch.run()).status).toBe('blocked')
    expect(orch.nodes().every(n => n.status === 'ACCEPTED' || n.status === 'BLOCKED')).toBe(true)
  })

  it('a persist failure resolves as blocked instead of throwing or spinning', async () => {
    const orch = new EffTaskOrchestrator(
      cfg(),
      { runAgent: allPass, persist: async () => { throw new Error('磁盘已满') }, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    expect(orch.nodes()[0].blockedReason).toContain('持久化失败')
  })

  it('a crashing renderer never takes the run down', async () => {
    const orch = new EffTaskOrchestrator(
      cfg(),
      { runAgent: allPass, persist: async () => {}, now: () => NOW, onUpdate: () => { throw new Error('渲染崩溃') } },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
  })

  it('maxNodes counts the WHOLE tree, so a later branch is refused outright', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```plan\n{"kind":"decompose","solution":"s","children":[{"title":"A","deps":[]},{"title":"B","deps":[]}]}\n```'
        if (req.node.id === 'root/01-a') return '```plan\n{"kind":"decompose","solution":"s","children":[{"title":"A1","deps":[]},{"title":"A2","deps":[]}]}\n```'
        if (req.node.id === 'root/02-b') return '```plan\n{"kind":"decompose","solution":"s","children":[{"title":"B1","deps":[]},{"title":"B2","deps":[]}]}\n```'
        return '```plan\n{"kind":"executable","solution":"leaf","acceptance":"跑 bun test 全绿"}\n```'
      }
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(cfg({ caps: { ...DEFAULT_CAPS, maxNodes: 5 } }), deps(runAgent), new AbortController().signal)
    expect((await orch.run()).status).toBe('blocked')
    const b = orch.nodes().find(n => n.id === 'root/02-b')!
    expect(b.childIds).toEqual([]) // refused outright, never partially created
    expect(b.blockedReason).toContain('节点数超过上限')
    expect(orch.nodes().length).toBeLessThanOrEqual(5)
  })

  it('is deterministic: identical inputs give an identical advancement order', async () => {
    const trace = async (): Promise<string[]> => {
      const order: string[] = []
      const runAgent: RunAgentFn = async req => { order.push(`${req.node.id}:${req.phase}`); return allPass(req) }
      await new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal).run()
      return order
    }
    const a = await trace()
    const b = await trace()
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('the no-progress guard also holds under an ADVANCING clock, not just a frozen one', async () => {
    // Every commit refreshes updatedAt, so a fingerprint that included it would differ on
    // each re-pick and the guard would only ever fire under the frozen clock the other
    // tests use — i.e. nowhere real. Drive a stalling step with a real advancing clock.
    let t = Date.parse('2026-07-25T00:00:00Z')
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; if (calls > 60) throw new Error('runaway'); return '' }
    const orch = new EffTaskOrchestrator(
      cfg(),
      { runAgent, persist: async () => {}, now: () => new Date((t += 1000)).toISOString(), onUpdate: () => {} },
      new AbortController().signal,
    )
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    expect(calls).toBeLessThan(60) // did not hot-loop
  })

  it('a dead subtree is marked BLOCKED, not left rendering as queued', async () => {
    // The scheduler refuses to run nodes under a BLOCKED ancestor; without a downward
    // sweep those descendants would keep a queued status forever in the tree view.
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan' && req.node.id === 'root') {
        return '```plan\n{"kind":"decompose","solution":"s","children":[{"title":"A","deps":[]},{"title":"B","deps":[]}]}\n```'
      }
      if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"leaf","acceptance":"跑 bun test 全绿"}\n```'
      if (req.phase === 'review') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
      if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
      return vtag(req) + '\n{"pass":false,"blocking":["不过"],"comments":""}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    // no node may be left in a non-terminal (grey/queued or running) state
    expect(orch.nodes().filter(n => n.status !== 'ACCEPTED' && n.status !== 'BLOCKED')).toEqual([])
  })

  it('terminates on a bounded number of model calls when acceptance never passes', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      calls++
      if (calls > 200) throw new Error('runaway loop')
      if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
      if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
      if (req.phase === 'review') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
      return vtag(req) + '\n{"pass":false,"blocking":["永远不过"],"comments":""}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('超限')
    expect(calls).toBeLessThan(200)
  })
})

describe('an interrupted run is distinguishable from a failed one', () => {
  it('marks swept nodes as interrupted, and leaves genuinely blocked ones unmarked', async () => {
    // propagateBlocked(aborted) sweeps EVERY non-terminal node to BLOCKED. Resume must be
    // able to tell "we killed this mid-flight" from "this really failed", and it must not do
    // so by string-matching blockedReason: a genuine reason could equal that literal, and two
    // unrelated modules agreeing on a string is not an interface.
    // Without this distinction a resumed run advances NOTHING — verified empirically:
    // interrupt, resume, zero model calls, immediate {status:'blocked'}.
    const ac = new AbortController()
    let calls = 0
    const runAgent = (async () => {
      calls++
      if (calls >= 2) ac.abort()
      return '```json\n{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿","children":[{"title":"子一","deps":[]}]}\n```'
    }) as unknown as RunAgentFn
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), ac.signal)
    expect(await orch.run()).toEqual({ status: 'blocked', reason: '已中断' })
    for (const n of orch.nodes()) {
      expect(n.status).toBe('BLOCKED')
      expect(n.interrupted).toBe(true)
    }
  })

  it('a node blocked by a real failure is never marked interrupted', async () => {
    // A node that exhausted its review budget must NOT come back to life on resume.
    const runAgent = (async () => 'no fence at all, ever') as unknown as RunAgentFn
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('blocked')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.interrupted).toBeFalsy()
  })
})

describe('自动解冲突的预算按「一次运行」计', () => {
  const conflictPool = () => ({
    acquire: async (n: { id: string }) => ({ path: `/wt/${n.id}`, branch: `worktree-${n.id}`, gitRoot: '/repo' }),
    // 永远冲突 —— 这个池子模拟的是「解不动的那种冲突」。
    commitAndMerge: async () => ({ ok: false, kind: 'conflict', files: ['src/a.ts'] }),
    mergeIntegrationIntoNode: async () => ({ ok: true, conflicted: true, files: ['src/a.ts'] }),
    conflictState: async () => ({ markers: true, staged: false, stale: false, files: ['src/a.ts'] }),
    refreshFromIntegration: async () => ({ ok: true, updated: false }),
    release: async () => ({ removed: true }),
    dispose: async () => ({ kept: [] }),
    init: async () => ({ ok: true }),
    withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
    handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
    integrationPath: '/wt/integration',
    integrationBranchName: 'efftask/001/integration',
  })

  const cooperative = (): RunAgentFn => (async req => {
    if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
    if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
    return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
  }) as RunAgentFn

  it('跑真编排器时预算是 caps.mergeResolveAttempts,用完才升级人工', async () => {
    // 走的是**真的** ctx() —— 那个函数每次调用都新建一个对象,预算状态挂在它上面等于
    // 每一步都回满。这条用例连着下面那条结构闸门一起,钉住「状态住在实例上」。
    const orch = new EffTaskOrchestrator(
      cfg(), { ...deps(cooperative()), worktrees: conflictPool() as never },
      new AbortController().signal,
    )
    const res = await orch.run()
    expect(res.status).toBe('blocked')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.iteration.mergeResolve).toBe(DEFAULT_CAPS.mergeResolveAttempts)
    expect(root.mergeConflict).toBe(true)
  })

  it('第二次运行(= --resume)重新拿到满额预算', async () => {
    // 用户按升级卡的指示 `--resume` 回来,卡上写的是「恢复后会重跑验收再合并」。预算若是
    // 终身制,那句话是假的:回来的节点一次自动解决都不会再发生,直接又是一张同样的卡。
    const first = new EffTaskOrchestrator(
      cfg(), { ...deps(cooperative()), worktrees: conflictPool() as never },
      new AbortController().signal,
    )
    await first.run()
    const carried = first.nodes()
    expect(carried.find(n => n.id === 'root')!.iteration.mergeResolve).toBe(DEFAULT_CAPS.mergeResolveAttempts)
    // 恢复:照 reseat 对「等人工解冲突」节点的处置来摆位 —— READY + 保留 mergeConflict,
    // 由 stepExecute 那条「人工解决冲突后的续跑」分支重跑验收,验收过了再重试合并。
    for (const n of carried) {
      if (n.id === 'root') { n.status = 'READY'; n.mergeConflict = true; n.blockedReason = undefined }
    }
    const second = new EffTaskOrchestrator(
      cfg(), { ...deps(cooperative()), worktrees: conflictPool() as never },
      new AbortController().signal, carried,
    )
    await second.run()
    // 又用掉一整份额度 —— 累计翻倍。若预算是终身制,这个数会停在第一次运行用掉的那些。
    expect(second.nodes().find(n => n.id === 'root')!.iteration.mergeResolve)
      .toBe(DEFAULT_CAPS.mergeResolveAttempts! * 2)
  })

  it('结构闸门:预算 Map 住在实例上,并且真的接进了 ctx()', () => {
    // 剪断 `mergeResolveThisRun: this.mergeResolveThisRun` 这一行,pipeline 会就地建一个
    // 新 Map —— 每一次进 mergeAndRelease 都回满,「一次运行两次」退回成没有上限。上面两条
    // 行为用例挡不住它(单次调用链里那个就地建的 Map 同样有效),所以这一跳只能这么钉。
    const src = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8')
    expect(src).toContain('private mergeResolveThisRun = new Map<string, number>()')
    expect(src).toContain('mergeResolveThisRun: this.mergeResolveThisRun')
  })
})

describe('运行中重做:别的任务照跑,失败的那个当场重开', () => {
  /**
   * 用户原话:「任务失败了,不需要整体返回失败才能重做任务或阶段,在其它任务还在运行时
   * 就可以重做。」
   *
   * 这一组断的是编排器这一侧的三件事:换进来的树真的会被调度、正在跑的节点不许被动、
   * 扣住期间不许把 run 判成「走不动」。界面那一侧(按键 → 关口 → redoDeps)由
   * wiringCoverage 与 redoRun.test.ts 各自守着。
   */
  const leafPlan = '```json\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'

  /**
   * 一棵根 + 两个并行子任务:「慢」那个挂在验收里不返回(模拟一个还在跑的兄弟任务),
   * 「快」那个的验收一直不通过、返工额度用尽后阻断 —— 那就是用户说的「任务失败了」,
   * 而此刻别的任务还在跑。
   *
   * 挂着的那个必须**认 abort**:不认的话 `settleAll` 会等一个永不落地的 promise,
   * 测试收尾时挂死(实测 5s 超时),而那和被测的东西毫无关系。
   */
  const twoChildren = (opts: {
    passQuickAfter?: () => boolean
    /** 给了就多一个「第三」子任务,它的验收挂到这个 promise 兑现为止 —— 用来在**扣住期间**
     * 精确地制造一次调度重扫(见「扣住的节点不许被派」)。 */
    thirdGate?: Promise<void>
  } = {}): RunAgentFn => {
    return (async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') {
          const kids = opts.thirdGate
            ? '[{"title":"慢","deps":[]},{"title":"快","deps":[]},{"title":"第三","deps":[]}]'
            : '[{"title":"慢","deps":[]},{"title":"快","deps":[]}]'
          return '```json\n{"kind":"decompose","solution":"s","children":' + kids + '}\n```'
        }
        return leafPlan
      }
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      /**
       * 「慢」挂在**验收**里,不是挂在执行里。
       *
       * 非隔离运行的执行环节是**串行**的(execute mutex:同一棵工作树里两个执行者会互相
       * 覆盖),所以让它挂在执行里会连带把「快」的执行也堵死 —— 测出来的就不再是「别的
       * 任务还在跑的时候能不能重做」,而是那把锁本身。
       */
      if (req.phase === 'accept' && req.node.title === '第三' && opts.thirdGate) {
        await opts.thirdGate
        return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
      }
      if (req.phase === 'accept' && req.node.title === '慢') {
        return new Promise<string>((_, reject) => {
          req.signal.addEventListener('abort', () => reject(new Error('已中断')), { once: true })
        })
      }
      // **只让验收不过**,不碰质疑讨论:方案环节被打回的节点重开时要回 CREATED 重新拟方案
      // (planRedo 的 'plan' 入口),而这一组测的是「执行/验收那一档」的重开 —— 把两件事
      // 混在一个夹具里,重开之后节点会带着一份从没被批准过的方案进执行。
      if (req.phase === 'accept' && req.node.title === '快' && opts.passQuickAfter?.() !== true) {
        return vtag(req) + '\n{"pass":false,"blocking":["还不行"],"comments":""}\n```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as RunAgentFn
  }

  /**
   * 一个**能成功合并**的隔离池。
   *
   * 必须给:非隔离运行的 execute 是**串行**的(execute mutex,同一棵工作树里两个执行者会
   * 互相覆盖),而那把锁锁的是整个 `stepExecute` —— 包括它后面的验收圆桌。于是「慢」那个
   * 挂在验收里的节点会把「快」的执行也一起堵死,测出来的就成了那把锁,而不是本功能。
   * 真实运行里 `/et` 默认就是隔离的,所以给池子也更贴近实况。
   */
  const okPool = () => ({
    init: async () => ({ ok: true }),
    acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'b-' + n.id, gitRoot: '/repo' }),
    commitAndMerge: async () => ({ ok: true, merged: true }),
    release: async () => ({ removed: true }),
    dispose: async () => ({ kept: [] }),
    withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
    handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
    refreshFromIntegration: async () => ({ ok: true, updated: false }),
    conflictState: async () => ({ markers: false, staged: false, stale: false, files: [] }),
    mergeIntegrationIntoNode: async () => ({ ok: true, conflicted: false }),
    integrationPath: '/wt/integration',
    integrationBranchName: 'efftask/001/integration',
  })

  const until = async (cond: () => boolean, ms = 2000): Promise<boolean> => {
    const started = performance.now()
    while (performance.now() - started < ms) {
      if (cond()) return true
      await new Promise(r => setTimeout(r, 5))
    }
    return cond()
  }

  it('换进来的树立刻被调度 —— 不等别的任务跑完', async () => {
    const ac = new AbortController()
    /** 重做之后才让「快」通过验收 —— 否则它会再一次走到同一个阻断上。 */
    let redone = false
    const orch = new EffTaskOrchestrator(cfg(), { ...deps(twoChildren({ passQuickAfter: () => redone })), worktrees: okPool() as never }, ac.signal)
    const done = orch.run()
    // 「快」真的失败了(验收三轮不过 → 阻断),而「慢」还挂在执行里 —— 这就是用户描述的
    // 那一刻:一个任务失败了,别的任务还在运行。
    const failed = await until(() => {
      const q = orch.nodes().find(n => n.title === '快')
      return q?.status === 'BLOCKED' && orch.runningNodeIds().some(id => id.includes('慢'))
    })
    expect(failed).toBe(true)
    const fast = orch.nodes().find(n => n.title === '快')!
    // planRedo 干的事在这里手工做一遍:放回可推进状态、清掉阻断、返工计数归零。
    redone = true
    const reopened = orch.nodes().map(n => (n.id === fast.id
      ? { ...n, status: 'READY' as const, blockedReason: '', failedAt: undefined,
          iteration: { ...n.iteration, acceptance: 0 }, acceptLog: [] }
      : n))
    const applied = orch.applyLive(reopened, [fast.id])
    expect(applied).toEqual({ ok: true })
    // 它真的又跑起来并跑完了 —— 而「慢」那个还挂在那里,一次都没被打断。
    expect(await until(() => orch.nodes().find(n => n.title === '快')?.status === 'ACCEPTED')).toBe(true)
    expect(orch.runningNodeIds().some(id => id.includes('慢'))).toBe(true)
    ac.abort()
    await done
  })

  it('要动的节点正在跑就拒绝,而且什么都不改', async () => {
    // 那个节点的 step 手里攥着**旧对象**:换树之后它的 commit 会落进一个已经不在树里的
    // 节点 —— 产出看着跑完了,树上却什么都没有,而且没有任何一处会报错。
    const ac = new AbortController()
    const orch = new EffTaskOrchestrator(cfg(), { ...deps(twoChildren()), worktrees: okPool() as never }, ac.signal)
    const done = orch.run()
    expect(await until(() => orch.runningNodeIds().some(id => id.includes('慢')))).toBe(true)
    const slowId = orch.runningNodeIds().find(id => id.includes('慢'))!
    const before = orch.nodes().find(n => n.id === slowId)
    const held = orch.hold([slowId])
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toContain('正在运行')
    /**
     * 换树的那一份**仍然包含**这个节点,只是把它重置了 —— 真实的重做长这样。
     *
     * 早一版这里传的是「把它删掉的那棵树」,而那种输入会被第二道守卫(在飞节点必须仍在
     * 新树里)拦下 —— 于是把第一道守卫整个删掉,测试照绿。变异测试实测存活过一次。
     */
    const reset = orch.nodes().map(n => (n.id === slowId
      ? { ...n, status: 'READY' as const, acceptLog: [], blockedReason: '' }
      : n))
    const applied = orch.applyLive(reset, [slowId])
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.reason).toContain('正在运行的任务')
    // 树一个字节都没动:被拒绝的换树不许留下半个状态。
    expect(orch.nodes().find(n => n.id === slowId)).toBe(before!)
    expect(orch.nodes().find(n => n.id === slowId)?.status).toBe('ACCEPTANCE')
    ac.abort()
    await done
  })

  it('扣住的节点不许被派;放开之后立刻被派', async () => {
    /**
     * `hold` 是运行中重做唯一 airtight 的那道闸门:算完新树和落盘之间隔着一次 await,
     * 而调度循环完全可能在那期间把其中一个节点派出去(最真实的是被放回的祖先——别的
     * 子任务恰好这时跑完)。等到换树那一刻才发现就晚了:盘上已经写完,磁盘是新树、
     * 内存是旧树,而屏幕说重做成功。
     */
    const ac = new AbortController()
    let redone = false
    const dispatched: string[] = []
    /**
     * 「第三」那个子任务是**用来制造一次重扫**的:光把节点扣住然后等一会儿证明不了什么 ——
     * 调度循环那会儿正睡着,谁都不会被派。必须让它在扣住期间**真的醒来扫一遍**,那时
     * 「扣住的节点不许出现在批次里」才是一句可证伪的话。变异测试实测:少了这一手,
     * 把 pickBatch 里的 held 过滤整个删掉,这条用例照绿。
     */
    let openThird = (): void => {}
    const thirdGate = new Promise<void>(res => { openThird = () => res() })
    const base = twoChildren({ passQuickAfter: () => redone, thirdGate })
    const spy: RunAgentFn = async req => { dispatched.push(`${req.node.id}:${req.phase}`); return base(req) }
    const orch = new EffTaskOrchestrator(cfg(), { ...deps(spy), worktrees: okPool() as never }, ac.signal)
    const done = orch.run()
    expect(await until(() => orch.nodes().find(n => n.title === '快')?.status === 'BLOCKED')).toBe(true)
    const fastId = orch.nodes().find(n => n.title === '快')!.id
    const held = orch.hold([fastId])
    expect(held.ok).toBe(true)
    // 扣住期间把它放回可推进状态 —— 调度器**不许**碰它。
    redone = true
    for (const n of orch.nodes()) {
      if (n.id === fastId) { n.status = 'READY'; n.iteration = { ...n.iteration, acceptance: 0 }; n.acceptLog = [] }
    }
    const countBefore = dispatched.filter(d => d.startsWith(fastId)).length
    // 放「第三」过关 → 它跑完 → 循环醒来重扫。这一扫里**不许**出现被扣住的那个节点。
    openThird()
    expect(await until(() => orch.nodes().find(n => n.title === '第三')?.status === 'ACCEPTED')).toBe(true)
    await new Promise(r => setTimeout(r, 30))
    expect(dispatched.filter(d => d.startsWith(fastId)).length).toBe(countBefore)
    // 放开 —— 这一下也要**叫醒**循环,否则它会睡到另一个节点跑完(而那个节点挂着不返回)。
    if (held.ok) held.release()
    expect(await until(() => dispatched.filter(d => d.startsWith(fastId)).length > countBefore)).toBe(true)
    ac.abort()
    await done
  })

  it('扣住期间不把 run 判成「走不动」', async () => {
    /**
     * hold 是「算完新树、正在落盘」那一段。少了这道守卫,一个「只剩这一个失败节点、
     * 别的都跑完了」的树会在用户按下确认的那一瞬被判成 blocked 收尾,而重做正落在半空中:
     * 盘上写完了,却再没有编排器去跑它。
     */
    const ac = new AbortController()
    const runAgent = (async req => {
      if (req.phase === 'plan') return leafPlan
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      // 验收不通过 → 返工额度用尽 → 节点阻断,树上再没有可推进的东西。
      return vtag(req) + '\n{"pass":false,"blocking":["不行"],"comments":""}\n```'
    }) as RunAgentFn
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), ac.signal)
    const done = orch.run()
    expect(await until(() => orch.nodes().find(n => n.id === 'root')?.status === 'BLOCKED')).toBe(true)
    // run() 已经收尾了 —— 这一刻的重做该走结束屏那条路,而 hold 要说得出口。
    await done
    const held = orch.hold(['root'])
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toContain('已经结束')
  })

  it('编排器跑完之后 applyLive 一律拒绝 —— 不能悄悄改一棵没人再看的树', async () => {
    const orch = new EffTaskOrchestrator(cfg(), deps((async req => {
      if (req.phase === 'plan') return leafPlan
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as RunAgentFn), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    const applied = orch.applyLive(orch.nodes(), ['root'])
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.reason).toContain('结束屏')
  })
})
