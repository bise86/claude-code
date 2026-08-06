import { describe, expect, it } from 'bun:test'
import { runOrchestrator, type Outcome } from './runOrchestrator.js'
import type { FsLike } from '../../tools/efftask/persistence.js'
import { DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import type { AppState } from '../../state/AppState.js'
import { createRunControl } from '../../tools/efftask/control.js'
import { PhaseTimeoutError } from '../../tools/efftask/runAgentAdapter.js'
import type { EffTaskTaskState } from '../../tasks/EffTaskTask/EffTaskTask.js'

function memFs(): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readFile: async p => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    writeFile: async (p, d) => { files.set(p, d) },
    mkdir: async () => {},
    mkdirExclusive: async () => true,
    unlink: async p => { files.delete(p) },
    rmdir: async () => {},
    readdir: async () => [],
    exists: async p => files.has(p),
  }
}

const cfg = (): EffTaskConfig => ({
  goalPrompt: '把登录接口打通',
  parallelism: 5,
  phaseRoles: emptyPhaseRoles(),
  // **拷贝,不是引用。** `queueManifest` 里把运行中调过的档位同步回 `config.caps` 是全
  // 仓库唯一一处原地改 caps;生产路径上 config.caps 一律是 `{...DEFAULT_CAPS}`,而这里
  // 拿引用的话,任何一条给它 setStrictness 的用例都会把模块级常量写脏 —— 跨文件、静默、
  // 只在测试顺序变化时才显形。今天还没有那样的用例,所以这一行是**在它出现之前**堵上。
  caps: { ...DEFAULT_CAPS },
  notices: [],
})

describe('runOrchestrator reports the run it just drove', () => {
  it('hands the outcome back and records it in the final manifest', async () => {
    // REGRESSION: this function once called an identifier that only existed inside the React
    // component it was extracted from. Every run therefore ended in a ReferenceError thrown
    // from the success path, thrown AGAIN from the catch that was supposed to absorb it, and
    // finally surfaced as an unhandled rejection. Visible damage: a run that completed was
    // announced to the user as '已取消', and run.md never received its {status, reason}
    // frontmatter — the file resume is meant to read.
    const fs = memFs()
    const ac = new AbortController()
    ac.abort() // shortest path to a terminal outcome; the reporting seam is identical
    const outcomes: Outcome[] = []
    const phases: string[] = []
    const runAgent: RunAgentFn = async () => { throw new Error('模型不应被调用') }

    await runOrchestrator(
      { config: cfg(), runDir: '/run/001', fs, runAgent, signal: ac.signal },
      () => {},
      o => outcomes.push(o),
      p => phases.push(p),
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toEqual({ status: 'blocked', reason: '已中断' })
    expect(phases).toEqual(['done'])
    const manifest = fs.files.get('/run/001/run.md') ?? ''
    expect(manifest).toContain('status: blocked')
    expect(manifest).toContain('已中断')
  })

  it('delivers a conflict escalation THROUGH the real orchestrator to the real callback', async () => {
    // REGRESSION, and the same shape as the one above: onEscalate existed on PipelineCtx and
    // on runOrchestrator's args, but OrchestratorDeps and ctx() never carried it — so
    // ctx.onEscalate was undefined in every real run. The node blocked correctly and the
    // human was simply never told. Five pipeline tests passed because each one hand-built a
    // ctx and injected the callback itself, testing the function while the WIRE was cut.
    //
    // This test therefore refuses to construct a PipelineCtx. It goes in at runOrchestrator
    // and asserts at the callback the product actually registers.
    const memfs = memFs()
    const escalations: { branch: string; path: string; files: string[] }[] = []
    let merges = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return '\`\`\`' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","goal":"g","acceptance":["a"],"children":[]}\n\`\`\`'
      }
      if (req.phase === 'execute') return '\`\`\`json\n{"execStatus":"做完了"}\n\`\`\`'
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '\`\`\`' + tag + '\n{"pass":true,"blocking":[],"comments":"ok"}\n\`\`\`'
    }
    const pool = {
      init: async () => ({ ok: true }),
      acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'efftask/001/n-' + n.id, gitRoot: '/repo' }),
      // Always conflicts: caps.mergeResolveAttempts 次自动解决(每次都重跑验收),额度用完才欠人一张卡。
      commitAndMerge: async () => { merges++; return { ok: false, kind: 'conflict', files: ['src/pay.ts'] } },
      release: async () => ({ removed: false, keptBecause: '冲突未解决' }),
      dispose: async () => ({ kept: [] }),
      withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
      handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
      integrationPath: '/wt/integration',
      conflictState: async () => ({ markers: true, staged: false, stale: false, files: ['src/pay.ts'] }),
      refreshFromIntegration: async () => ({ ok: true, updated: false }),
      mergeIntegrationIntoNode: async () => ({ ok: true, conflicted: true, files: ['src/pay.ts'] }),
    integrationBranchName: 'efftask/001/integration',
    }
    const outcomes: Outcome[] = []

    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/001', fs: memfs, runAgent, signal: new AbortController().signal,
        worktrees: pool as never,
        onEscalate: e => { escalations.push({ branch: e.branch, path: e.path, files: e.files }) },
      },
      () => {},
      o => outcomes.push(o),
      () => {},
    )

    expect(merges).toBe(DEFAULT_CAPS.mergeResolveAttempts! + 1) // original + 每次自动解决之后的一次重试
    expect(escalations).toEqual([{ branch: 'efftask/001/n-root', path: '/wt/root', files: ['src/pay.ts'] }])
    expect(outcomes[0]?.status).toBe('blocked')
  })

  it('an orchestrator that rejects still yields an outcome and reaches the done view', async () => {
    // The catch arm is the one that ran INSIDE a throw last time; if it is broken the UI
    // wedges on 'running' with no key that can free it.
    const fs = memFs()
    fs.writeFile = async () => { throw new Error('磁盘满') } // make the manifest path hostile too
    const outcomes: Outcome[] = []
    const phases: string[] = []
    const runAgent: RunAgentFn = async () => ''

    await runOrchestrator(
      // A null runDir forces writeNode/writeRunManifest to fail; nothing may escape.
      { config: cfg(), runDir: '/run/002', fs, runAgent, signal: new AbortController().signal },
      () => { throw new Error('渲染崩溃') }, // a crashing renderer must not eat the outcome
      o => outcomes.push(o),
      p => phases.push(p),
    )

    expect(outcomes).toHaveLength(1)
    expect(phases).toEqual(['done'])
  })

  it('即使 run() 抛了,worktree 也要回收、收口信息也要给到用户', async () => {
    // 收口原本坐在 `await orch.run()` **之后**、try 块**里面**,所以上面那条 catch 会把它
    // 整个跳过。而那条 catch 存在的理由,正是 run() 可能会抛(尽管它自己说不会)。真走到
    // 那条路时用户拿到的是最坏的组合:每个节点的 worktree 都泄漏、集成工作区无人回收、
    // 而且**一条收口信息都没有** —— done 视图直接出现,连"改动在哪个分支"都不告诉他。
    // 上面那条用例走的就是这条路,却对回收一个字都没断言。合规审计发现的。
    const fs = memFs()
    fs.writeFile = async () => { throw new Error('磁盘满') }
    let disposed = 0
    let handedOff = 0
    const pool = {
      init: async () => ({ ok: true }),
      acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'b', gitRoot: '/repo' }),
      commitAndMerge: async () => ({ ok: true, merged: true }),
      release: async () => ({ removed: true }),
      dispose: async () => { disposed++; return { kept: [] } },
      handoff: async () => { handedOff++; return { branch: 'efftask/002/integration', commits: 3, kept: [], salvage: [], integrationPath: '/wt/integration' } },
      withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
      integrationPath: '/wt/integration',
      integrationBranchName: 'efftask/002/integration',
    }
    const handoffs: { branch: string }[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/002', fs, runAgent: (async () => '') as RunAgentFn,
        signal: new AbortController().signal, worktrees: pool as never,
      },
      () => { throw new Error('渲染崩溃') },
      () => {},
      () => {},
      h => handoffs.push(h),
    )
    expect(disposed).toBe(1)
    expect(handedOff).toBe(1)
    expect(handoffs[0]?.branch).toBe('efftask/002/integration')
  })

  it('正常收尾时不会重复回收', async () => {
    // finally 里那次是兜底,不能让顺利跑完的 run 把 dispose/handoff 做两遍 —— dispose 真的
    // 会删 worktree,做两次意味着第二次对着已经不存在的路径跑 git。
    let disposed = 0
    const pool = {
      init: async () => ({ ok: true }),
      acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'b', gitRoot: '/repo' }),
      commitAndMerge: async () => ({ ok: true, merged: true }),
      release: async () => ({ removed: true }),
      dispose: async () => { disposed++; return { kept: [] } },
      handoff: async () => ({ branch: 'b', commits: 0, kept: [], salvage: [], integrationPath: '/wt/integration' }),
      withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
      integrationPath: '/wt/integration',
      integrationBranchName: 'b',
    }
    const runAgent = (async (req: { phase: string; prompt: string }) => {
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') return '```json\n{"execStatus":"做完了"}\n```'
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict'
      return '```' + tag + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as RunAgentFn
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/003', fs: memFs(), runAgent,
        signal: new AbortController().signal, worktrees: pool as never,
      },
      () => {}, () => {}, () => {},
    )
    expect(disposed).toBe(1)
  })
})

/**
 * 跑完之后把集成分支合回**当前目录**(spec §8 的自动那一半)。
 *
 * 这里必须在 runOrchestrator 这一层断言,而不是只测 finishHandoff:这个功能的全部风险
 * 都在**接线的顺序**上 —— 合并要排在 `reclaim` 之后(那时 pendingHandoff 才存在)、
 * 排在 `settle` 和最后一次 `queueManifest` 之前(否则 `/tasks` 那一行和盘上的 run.md
 * 会一起去教用户敲一条已经没有关口的 `--resume`)。
 */
describe('收口:跑完就把产出送回当前目录', () => {
  /** root 直接给成 ACCEPTED —— run() 第一句就返回 completed,收口那一段才是被测对象。 */
  const doneSeed = () => [{
    id: 'root', title: '根任务', goal: 'g', parentId: null, childIds: [], deps: [],
    kind: 'executable' as const, status: 'ACCEPTED' as const,
    phaseRoles: emptyPhaseRoles(),
    plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    execStatus: '做完了', blockedReason: '', reviewLog: [], acceptLog: [], score: {},
    iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    depth: 0, createdAt: 'T0', updatedAt: 'T0',
  }]
  const poolWithCommits = (commits: number, trunkLanded = 0) => ({
    init: async () => ({ ok: true }),
    acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'b', gitRoot: '/repo' }),
    commitAndMerge: async () => ({ ok: true, merged: true }),
    release: async () => ({ removed: true }),
    dispose: async () => ({ kept: [] }),
    handoff: async () => ({
      branch: 'efftask/004/integration', commits, kept: [], salvage: [], integrationPath: '/wt/integration',
      // 逐任务合并这一路:`trunkLanded` 是「已经在用户分支上」的提交数,收口那一步靠它
      // 决定「没有待收口 ≠ 什么都没发生」。桩 pool 不给这个字段的话,那条路一次也跑不到。
      trunkLanded,
    }),
    withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
    integrationPath: '/wt/integration',
    integrationBranchName: 'efftask/004/integration',
  })
  const git = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) => {
    const calls: string[][] = []
    /** 每条命令的 cwd —— 跑错目录时 merge 会回答 Already up to date. 而屏幕报「已合并」。 */
    const cwds: (string | undefined)[] = []
    return {
      calls,
      cwds,
      ran: (p: string) => calls.some(c => c.join(' ').startsWith(p)),
      fn: async (args: string[], cwd?: string) => {
        calls.push(args)
        cwds.push(cwd)
        const hit = Object.entries(answers).find(([k]) => args.join(' ').startsWith(k))
        return { code: hit?.[1].code ?? 0, stdout: hit?.[1].stdout ?? '', stderr: hit?.[1].stderr ?? '' }
      },
    }
  }
  const run = async (over: {
    commits?: number
    trunkLanded?: number
    autoPush?: boolean
    answers?: Record<string, { code?: number; stdout?: string; stderr?: string }>
    withGit?: boolean
    /** 收口撞上冲突时被派去解冲突的那一位。默认什么都不回答(这条路上没人调用它)。 */
    runAgent?: RunAgentFn
  } = {}) => {
    const fs = memFs()
    const g = git(over.answers)
    const results: { merged: boolean; result?: { ok: boolean; message: string }; push?: { ok: boolean; message: string } }[] = []
    const config = { ...cfg(), ...(over.autoPush === undefined ? {} : { autoPush: over.autoPush }) }
    const phases: string[] = []
    /**
     * `settle` 那一刻 pendingHandoff 还在不在 —— 顺序的观测口。
     *
     * setOutcome 紧挨着 settle(中间只有一句 setNodes),所以在这个回调里读 config 就是
     * settle 看到的那份。这比去桩一个 AppState store 轻,而它要钉的正是**顺序**。
     */
    const settledWithHandoff: boolean[] = []
    await runOrchestrator(
      {
        config, runDir: '/run/004', fs, runAgent: over.runAgent ?? ((async () => '') as RunAgentFn),
        signal: new AbortController().signal,
        worktrees: poolWithCommits(over.commits ?? 3, over.trunkLanded ?? 0) as never,
        seed: doneSeed() as never, cwd: '/repo',
        ...(over.withGit === false ? {} : { git: g.fn as never }),
        onHandoffResult: r => results.push(r as never),
      },
      () => {},
      () => { settledWithHandoff.push(config.pendingHandoff !== undefined) },
      p => phases.push(p),
    )
    return { fs, g, results, config, phases, settledWithHandoff, manifest: fs.files.get('/run/004/run.md') ?? '' }
  }

  it('干净的检出 + 跑完 → 真的 git merge,而且 run.md 里不再留待收口', async () => {
    const r = await run()
    expect(r.g.ran('merge --no-edit efftask/004/integration')).toBe(true)
    expect(r.results[0]?.merged).toBe(true)
    // 清掉了,而且**落盘了** —— 只清内存的话下一次 --resume 会为一条已经合过的分支
    // 再弹一次四选一,而「丢弃」会对着它跑 branch -D。
    expect(r.config.pendingHandoff).toBeUndefined()
    expect(r.manifest).not.toContain('pendingHandoff')
    expect(r.phases).toEqual(['done'])
  })

  it('工作区脏 → 不合、不清,run.md 留着待收口', async () => {
    // 判据是 `git diff --quiet`(1 = 有差异),**不看未跟踪文件** —— 见 trackedChanges:
    // `/et` 自己写的 `.claude/efftask/` 会让 `status --porcelain` 永远非空。
    const r = await run({ answers: { 'diff --quiet': { code: 1 }, 'status --porcelain': { stdout: ' M src/app.ts\n' } } })
    expect(r.g.ran('merge')).toBe(false)
    expect(r.results[0]?.merged).toBe(false)
    expect(r.config.pendingHandoff?.branch).toBe('efftask/004/integration')
    expect(r.manifest).toContain('pendingHandoff')
  })

  /**
   * 中途合成功过、但收口时还剩东西没合(那一刻工作区脏)——**待收口记录必须带上已经落地的
   * 那几笔**。收口关口和飞书收口卡都拿它决定那句话是「你的工作区未被改动」还是「另有 N 个
   * 提交已经在你的分支上」;写不出去的话,关口会对着一份已经在用户目录里的产出说没动过。
   */
  it('待收口记录带上 trunkLanded,并且落盘', async () => {
    const r = await run({
      commits: 2, trunkLanded: 5,
      answers: { 'diff --quiet': { code: 1 }, 'status --porcelain': { stdout: ' M src/app.ts\n' } },
    })
    expect(r.config.pendingHandoff?.trunkLanded).toBe(5)
    expect(r.manifest).toContain('trunkLanded')
  })

  it('零提交 → 一条 git 都不跑,也不报告', async () => {
    const r = await run({ commits: 0 })
    expect(r.g.calls).toEqual([])
    expect(r.results).toEqual([])
  })

  /**
   * **推送的结果必须跨过这道接缝。**
   *
   * 逐任务合并之后最常见的结局是 `commits === 0`(每个子任务完成时就合过了),而
   * `finishHandoff` 在那条早退上返回的是 `{ merged:false, push }` —— **没有 `result`**。
   * 这里原来的闸是 `if (out.result)`,于是推送发生了、推送失败也发生了,而用户被告知
   * 零个字;界面里那条专门为它写的 `else if (out.push)` 成了不可达代码。
   *
   * 验收是拿真 runOrchestrator + 桩 git 跑出来的:`push 跑过 = true / 报告次数 = 0`。
   * 两边各自都绿着 —— 桩 pool 的 handoff 当时根本不返回 trunkLanded,这条路一次也没被驱动过。
   */
  it('没有待收口但逐任务合过 + 开了推送 → 推,而且结果要真的到达界面', async () => {
    const r = await run({
      commits: 0, trunkLanded: 3, autoPush: true,
      answers: { 'symbolic-ref': { stdout: 'feature/x\n' } },
    })
    expect(r.g.ran('push -u origin feature/x')).toBe(true)
    expect(r.results).toHaveLength(1)
    expect(r.results[0]?.push?.ok).toBe(true)
  })

  it('推送失败尤其要说 —— 那正是用户要自己去补的一步', async () => {
    const r = await run({
      commits: 0, trunkLanded: 3, autoPush: true,
      answers: {
        'symbolic-ref': { stdout: 'feature/x\n' },
        'push': { code: 1, stderr: "fatal: 'origin' does not appear to be a git repository" },
      },
    })
    expect(r.results).toHaveLength(1)
    expect(r.results[0]?.push?.ok).toBe(false)
    expect(r.results[0]?.push?.message).toContain('origin')
  })

  it('不注入 git → 行为与这个功能不存在时逐字相同', async () => {
    // headless / 拿不到 git 的调用点走这条路:待收口原样留在盘上,交给 --resume 的关口。
    const r = await run({ withGit: false })
    expect(r.results).toEqual([])
    expect(r.manifest).toContain('pendingHandoff')
    expect(r.phases).toEqual(['done'])
  })

  it('每一条 git 都跑在**用户的** cwd 上,而不是集成工作区', async () => {
    // 跑错目录时 `git merge` 会回答 `Already up to date.`(那里已经在集成分支上)→
    // code 0 → 屏幕报「已合并」,而用户目录里一个文件都没有。
    const r = await run()
    expect(r.g.calls.length).toBeGreaterThan(0)
    for (const c of r.g.cwds) expect(c).toBe('/repo')
  })

  it('收口排在 settle 之前 —— 否则 /tasks 那一行会教用户敲一条没有关口的命令', async () => {
    /**
     * `settle()` 把 `!!config.pendingHandoff` 交给面板,决定 `/tasks` 那一行是不是
     * 「待收口(/et --resume …)」。排在合并之后,面板才不会去教用户敲一条已经没有关口
     * 的命令(合并成功时 pendingHandoff 已经被清掉)。
     */
    const r = await run()
    // 合并发生在 settle 之前:settle 看到的 pendingHandoff 已经是 undefined。
    expect(r.settledWithHandoff).toEqual([false])
  })

  it('顺利跑完时收口**只发生一次** —— finally 里那次是兜底,不是第二次', async () => {
    /**
     * 变异测试实测存活:把 `handoffDone` 那道幂等闩删掉之后,原来那条用例照样绿 ——
     * 它走的是**异常**路径(happy path 根本没跑到),所以两次调用里只有一次会发生。
     *
     * 而顺利跑完时两处都会跑:后果是对一个**已经合过**的分支再跑一次 `git merge`
     * (第二次拿到 `Already up to date.` → code 0 → 又报一次「已合并」),而屏幕上会
     * 出现两条收口结果。
     */
    const r = await run()
    expect(r.results).toHaveLength(1)
    expect(r.g.calls.filter(c => c[0] === 'merge')).toHaveLength(1)
  })

  it('**没合成功**时也只报告一次 —— 这才是那道闩真正承重的地方', async () => {
    /**
     * 复验实测:上面那条杀不掉「删掉 handoffDone」。原因是合成功之后 `pendingHandoff`
     * 已经被清掉,finally 里那第二次调用于是走 `action: 'none'`(不报告、不跑 git)——
     * 闩在这条路上是**冗余**的。
     *
     * 真正需要它的是**没清掉**的那些路:脏树 / 没跑完 / 合并失败。那时 `pendingHandoff`
     * 还在,第二次调用会把同一份诊断再探一遍、再报一遍 —— 屏幕上出现两条收口结果,
     * 而 `git status` 也白跑一次。
     */
    const r = await run({ answers: { 'diff --quiet': { code: 1 }, 'status --porcelain': { stdout: ' M a.ts\n' } } })
    expect(r.results).toHaveLength(1)
    expect(r.config.pendingHandoff).toBeDefined()
    // 判据也只探一次(两次的话这里是 4:diff/diff --cached/status × 2)。
    expect(r.g.calls.filter(c => c[0] === 'diff')).toHaveLength(2)
  })

  it('异常路径上收口照样跑一次(而且只跑一次)', async () => {
    /**
     * happy path 那一句在 run() 抛出时根本到不了。而 finally 里那次是兜底 ——
     * 幂等靠 `handoffDone`:做两遍意味着对一个已经合过的分支再跑一次 merge。
     */
    const fs = memFs()
    const g = git()
    const results: unknown[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/006', fs, runAgent: (async () => '') as RunAgentFn,
        signal: new AbortController().signal, worktrees: poolWithCommits(2) as never,
        seed: doneSeed() as never, cwd: '/repo', git: g.fn as never,
        onHandoffResult: x => results.push(x),
      },
      () => { throw new Error('渲染崩溃') }, // setNodes 抛 → 走 catch → finally
      () => {}, () => {},
    )
    // 被阻断的结局 → 只报告不合并;而报告本身必须发生(否则屏幕上一个字都没有)。
    expect(results).toHaveLength(1)
    expect(g.ran('merge')).toBe(false)
    // 只跑过一次收口:status 那一步都没跑(blocked 不探脏),更不会跑两遍 merge。
    expect(g.calls.filter(c => c[0] === 'merge')).toHaveLength(0)
  })

  it('git 抛异常也照样到达 done 视图', async () => {
    /**
     * 收口跑在 finally 里,而那一段的每一句都是被保护的:一个逃出去的异常会让
     * `setPhase('done')` 永不执行 —— 界面永久停在「运行中」,Esc 毫无反应,而外层
     * catch 早就跑完了救不了。
     */
    const fs = memFs()
    const phases: string[] = []
    const results: { merged: boolean }[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/005', fs, runAgent: (async () => '') as RunAgentFn,
        signal: new AbortController().signal, worktrees: poolWithCommits(2) as never,
        seed: doneSeed() as never, cwd: '/repo',
        git: (async () => { throw new Error('spawn EAGAIN') }) as never,
        onHandoffResult: r => results.push(r as never),
      },
      () => {}, () => {}, p => phases.push(p),
    )
    expect(phases).toEqual(['done'])
    expect(results[0]?.merged).toBe(false)
  })
})

describe('后台任务条目 (spec §10) 真的被接上', () => {
  /** Minimal AppState double: registerTask/updateTaskState only touch `tasks`. */
  function store() {
    let state = { tasks: {} } as unknown as AppState
    return {
      setAppState: (f: (prev: AppState) => AppState) => { state = f(state) },
      only: () => Object.values(state.tasks as Record<string, EffTaskTaskState>)[0],
      count: () => Object.keys(state.tasks as Record<string, unknown>).length,
    }
  }

  it('registers the run in AppState.tasks and settles it when the run ends', async () => {
    // THE wire. Everything below it is unit-tested in EffTaskTask.test.ts; what this asserts
    // is that a real run reaches it at all. The previous two features wired only inside
    // efftask.tsx were dead in production while their own unit tests passed.
    const s = store()
    const ac = new AbortController()
    ac.abort()
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/003', fs: memFs(), runAgent: async () => '', signal: ac.signal,
        taskEntry: { runId: '003', runDir: '/run/003', setAppState: s.setAppState, abortController: ac },
      },
      () => {}, () => {}, () => {},
    )
    expect(s.count()).toBe(1)
    const t = s.only()
    expect(t.type).toBe('efftask')
    expect(t.runId).toBe('003')
    expect(t.runDir).toBe('/run/003')
    // The run ended without finishing, so the row must be TERMINAL — a row still saying 运行中
    // for a run that is over is the panel lying about the thing it shows. This fixture aborts,
    // and a run the user stopped is 'killed', not 'failed': Esc in the /et view and `x` in
    // /tasks are two ways to do the same thing and must not be written up differently.
    expect(t.status).toBe('killed')
    expect(t.reason).toBe('已中断')
  })

  it('carries the RUN\'s controller, so `x` in /tasks stops the real thing', async () => {
    const s = store()
    const ac = new AbortController()
    ac.abort()
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent: async () => '', signal: ac.signal,
        taskEntry: { runId: '1', runDir: '/r', setAppState: s.setAppState, abortController: ac },
      },
      () => {}, () => {}, () => {},
    )
    // finishEffTaskRun clears it on the terminal path; what matters is that the controller
    // handed in was the run's own, which the abort above proves by construction.
    expect(ac.signal.aborted).toBe(true)
  })

  it('registers NOTHING when no task entry is supplied', async () => {
    const s = store()
    const ac = new AbortController()
    ac.abort()
    await runOrchestrator(
      { config: cfg(), runDir: '/r', fs: memFs(), runAgent: async () => '', signal: ac.signal },
      () => {}, () => {}, () => {},
    )
    expect(s.count()).toBe(0)
  })

  it('settles the row even when the run throws out of the success path', async () => {
    // The catch below run() is the ONE path with no other route to a terminal status: a row
    // left at 运行中 forever survives the run, the view and the session.
    const s = store()
    const ac = new AbortController()
    ac.abort()
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent: async () => '', signal: ac.signal,
        taskEntry: { runId: '1', runDir: '/r', setAppState: s.setAppState, abortController: ac },
      },
      // setNodes runs unguarded inside the try, so this is the reachable route into the
      // catch — the one exit the success path's settle() never covers.
      () => { throw new Error('渲染器炸了') }, () => {}, () => {},
    )
    // TERMINAL is the property. This fixture aborts the signal, so the user-stop reading is
    // correct; what must never happen is the row staying at 运行中 for a run that is over.
    expect(['killed', 'failed']).toContain(s.only().status)
    expect(s.only().endTime).toBeGreaterThan(0)
  })

  it('a crashing store never takes the run down with it', async () => {
    const ac = new AbortController()
    ac.abort()
    const outcomes: Outcome[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent: async () => '', signal: ac.signal,
        taskEntry: {
          runId: '1', runDir: '/r', abortController: ac,
          setAppState: () => { throw new Error('store 炸了') },
        },
      },
      () => {}, o => outcomes.push(o), () => {},
    )
    // registerEffTaskRun throwing would abort the whole run before its first step. It does
    // not: the run still reports its outcome.
    expect(outcomes).toEqual([{ status: 'blocked', reason: '已中断' }])
  })
})

describe('触阀升级 (spec §9/§11) 真的被接上', () => {
  it('a valve trip inside the run reaches the caller\'s onBlocked', async () => {
    // THE wire. onEscalate was added to PipelineCtx and to this function but NOT to
    // OrchestratorDeps/ctx(), so it was undefined in every real run while five unit tests
    // passed over a hand-built ctx. This asserts the same wire for onBlocked at the level
    // that owns it.
    const fired: { category: string; reason: string }[] = []
    const ac = new AbortController()
    // 验收永远不过:run 把根节点推到「验收迭代超限」的降级放行 —— 这一档同样要喊人。
    // (换掉的是「评审迭代超限」:质疑修复不再判决,那一档已经不会发生。)
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
        : req.phase === 'execute'
          ? '```json\n{"execStatus":"改了 foo.ts"}\n```'
          : '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
            '\n{"pass":false,"blocking":["不行"],"comments":""}\n```'
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent, signal: ac.signal,
        onBlocked: info => fired.push({ category: info.category, reason: info.reason }),
      },
      () => {}, () => {}, () => {},
    )
    expect(fired).toHaveLength(1)
    expect(fired[0].category).toBe('degrade')
    expect(fired[0].reason).toContain('验收迭代超限')
  })
})

describe('实时计数这条线也得是通的', () => {
  function store2() {
    let state = { tasks: {} } as unknown as AppState
    return {
      setAppState: (f: (prev: AppState) => AppState) => { state = f(state) },
      only: () => Object.values(state.tasks as Record<string, EffTaskTaskState>)[0],
    }
  }

  it('节点状态变化会更新 /tasks 那一行的计数', async () => {
    // Mutation-proved gap: deleting `touch(nodes)` from runOrchestrator left the whole suite
    // green. registerEffTaskRun and finishEffTaskRun each had a real wire test; the update in
    // between did not, so the row would have sat at its initial counts forever.
    const s = store2()
    const ac = new AbortController()
    // A run that actually advances: plan → review passes → executable leaf → execute →
    // accept passes → ACCEPTED. The root ends accepted, so counts must move off 0.
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (exec[a-z]+)/)?.[1] ?? 'exec') + '\n{"execStatus":"做完了"}\n```'
      }
      return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
        '\n{"pass":true,"blocking":[],"comments":""}\n```'
    }
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent, signal: ac.signal,
        taskEntry: { runId: '009', runDir: '/r', setAppState: s.setAppState, abortController: ac },
      },
      () => {}, () => {}, () => {},
    )
    const t = s.only()
    expect(t.status).toBe('completed')
    expect(t.counts.accepted).toBe(1)
    expect(t.counts.total).toBe(1)
    // The description is what the /tasks row and the footer pill actually render.
    expect(t.description).toContain('已完成 1/1')
  })

  it('阻断原因里带上真实的 run id,而不是占位符', async () => {
    // run.md is where suppressed escalations have to stay actionable, so blockedReason must
    // name the command that really works. The id reaches the pipeline through this wire.
    const fs2 = memFs()
    const ac = new AbortController()
    // 真的阻断一个节点:执行调用打不通(「评审一直不过」那条路已经不存在了)。
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
      }
      // 超时:它带 category(timeout),而 `--retry-blocked` 那句提示只挂在**带分类**的
      // 阻断上 —— 一个没有分类的裸错误捞不回节点,也就不该给这句话。
      if (req.phase === 'execute') throw new PhaseTimeoutError(600_000)
      return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
        '\n{"pass":false,"blocking":["不行"],"comments":""}\n```'
    }
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: fs2, runAgent, signal: ac.signal,
        taskEntry: { runId: '011', runDir: '/r', setAppState: () => {}, abortController: ac },
      },
      () => {}, () => {}, () => {},
    )
    const manifest = fs2.files.get('/r/run.md') ?? ''
    expect(manifest).toContain('/et --resume 011 --retry-blocked')
  })
})

describe('/tasks 行的"用户停的"判定必须来自信号', () => {
  function store3() {
    let state = { tasks: {} } as unknown as AppState
    return {
      setAppState: (f: (prev: AppState) => AppState) => { state = f(state) },
      only: () => Object.values(state.tasks as Record<string, EffTaskTaskState>)[0],
    }
  }

  it('没人按停、但理由恰好是"已中断"的运行,记成失败', async () => {
    // '已中断' can survive on disk from a PREVIOUS session's Esc: validateLoadedNodes keeps
    // root.blockedReason (`|| why`) and the orchestrator reports the root's reason as the
    // run's. Matching that text would relabel a real failure as the user's own stop, and
    // notified:true then evicts it silently.
    const s = store3()
    const ac = new AbortController() // NEVER aborted
    const fs2 = memFs()
    // A root with a dangling dep can never advance → run ends blocked, reason from the root.
    const seed = [{
      ...(await import('../../tools/efftask/types.js')).createNode({
        id: 'root', title: 'r', parentId: null, deps: [], depth: 0,
        phaseRoles: (await import('../../tools/efftask/types.js')).emptyPhaseRoles(), now: 'x',
      }),
      status: 'BLOCKED' as const, blockedReason: '已中断',
    }]
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: fs2, runAgent: async () => '', signal: ac.signal, seed,
        taskEntry: { runId: '1', runDir: '/r', setAppState: s.setAppState, abortController: ac },
      },
      () => {}, () => {}, () => {},
    )
    expect(ac.signal.aborted).toBe(false)
    expect(s.only().status).toBe('failed') // NOT killed
  })
})

describe('子 agent 实时输出 (spec §10.2) 真的被接上', () => {
  it('每个阶段的输出都带着节点 id 流到调用方', async () => {
    // THE wire, and it is the THIRD callback to travel this exact path. onEscalate and
    // onBlocked were each declared on PipelineCtx and on runOrchestrator but missed on
    // OrchestratorDeps/ctx(), and were dead in every real run while their unit tests passed
    // over the cut. `onChunk` had it worse: RunAgentFn has accepted one since P1 and the
    // adapter implements and tests it, but NOTHING in production ever passed one — so spec
    // §10.2's live output pane had nothing to show.
    const seen: { nodeId: string; phaseLabel: string; label: string; text: string }[] = []
    const ac = new AbortController()
    const runAgent: RunAgentFn = async req => {
      // 真实适配层在 resolve 之前会把每条消息拆成事件推进窗口。
      req.stream?.push({ kind: 'text', text: `${req.phase} 在干活` })
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (exec[a-z]+)/)?.[1] ?? 'exec') + '\n{"execStatus":"做完了"}\n```'
      }
      return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
        '\n{"pass":true,"blocking":[],"comments":""}\n```'
    }
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent, signal: ac.signal,
        openStream: meta => ({
          push: (e: { kind: string; text?: string }) =>
            seen.push({ nodeId: meta.nodeId, phaseLabel: meta.phaseLabel, label: meta.label, text: e.text ?? '' }),
          end: () => {},
        }),
      },
      () => {}, () => {}, () => {},
    )
    expect(seen.length).toBeGreaterThan(0)
    // 挂在正确的节点上,否则详情视图分不清这是谁的流。
    expect(seen.every(s => s.nodeId === 'root')).toBe(true)
    // 两条调用路径都要接:runPhase(分析/执行)和 runRoundtable(评审/验收)是两套代码,
    // 各接各的。
    const texts = seen.map(s => s.text)
    expect(texts).toContain('plan 在干活')
    expect(texts).toContain('execute 在干活')
    expect(texts.some(t => t.startsWith('review') || t.startsWith('accept'))).toBe(true)
    // 而且每条流带得出**中文环节名和署名** —— 表头全靠它,拿 phase 原样顶上去的话,
    // 集成验收会被标成「验收」。
    expect(seen.some(s => s.phaseLabel === '分析')).toBe(true)
    expect(seen.some(s => s.phaseLabel === '执行')).toBe(true)
    expect(seen.every(s => s.label.length > 0)).toBe(true)
  })

  it('每一次模型调用开一条**自己**的流,不是全节点共用一条', async () => {
    // 这是取代 chunkBuffer 的全部理由:此前 N 个席位共用一个 onChunk,几个人的话逐句
    // 交错地并进同一个桶,而且没有署名。
    const opened: { phaseLabel: string; round?: number }[] = []
    const ac = new AbortController()
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (exec[a-z]+)/)?.[1] ?? 'exec') + '\n{"execStatus":"做完了"}\n```'
      }
      return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
        '\n{"pass":true,"blocking":[],"comments":""}\n```'
    }
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent, signal: ac.signal,
        openStream: meta => { opened.push({ phaseLabel: meta.phaseLabel, round: meta.round }); return { push: () => {}, end: () => {} } },
      },
      () => {}, () => {}, () => {},
    )
    // 分析、质疑修复、执行、验收 —— 一个环节一条(或多条),不是一条包打天下。
    expect(opened.length).toBeGreaterThanOrEqual(4)
    expect(new Set(opened.map(o => o.phaseLabel)).size).toBeGreaterThanOrEqual(4)
  })
})


describe('并行占用的 reader 真的被交出去了', () => {
  it('onPool 恰好被调用一次,给出的 reader 能读到真实占用', async () => {
    // Mutation-proved gap: deleting the onPool call left the suite green.
    const readers: (() => { inUse: number; limit: number })[] = []
    const ac = new AbortController()
    ac.abort()
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent: async () => '', signal: ac.signal,
        onPool: read => readers.push(read),
      },
      () => {}, () => {}, () => {},
    )
    expect(readers).toHaveLength(1)
    const u = readers[0]()
    expect(u.limit).toBe(5)          // the run's configured parallelism
    expect(u.inUse).toBe(0)          // settled after the run
  })
})

describe('跑完之后的待收口状态要落盘(§8 收口)', () => {
  // 为什么必须持久:run.md 的 status 只在最后一次写入时带上,所以盘上会先出现
  // status: completed 而集成分支还没处置。用户此时**直接关终端**(不是按 Esc)→
  // --resume 的 reseat 只捞活动态节点、根节点已 ACCEPTED → 什么都不会重开,
  // 那条分支永远留在那没人管。
  const poolWith = (commits: number) => ({
    init: async () => {},
    acquire: async () => undefined,
    release: async () => {},
    dispose: async () => {},
    integrationBranchName: 'efftask/001/integration',
    handoff: async () => ({
      branch: 'efftask/001/integration', commits,
      kept: [], salvage: [], integrationPath: '/repo/.wt/int',
    }),
  })

  const drive = async (commits: number) => {
    const fs = memFs()
    const ac = new AbortController()
    ac.abort() // 最短路径到终态;收口那一跳的接缝是一样的
    const config = cfg()
    await runOrchestrator(
      // biome-ignore lint/suspicious/noExplicitAny: partial worktree pool double
      { config, runDir: '/run', fs, runAgent: (async () => '') as RunAgentFn, signal: ac.signal, worktrees: poolWith(commits) as any },
      () => {}, () => {}, () => {},
    )
    return { config, manifest: fs.files.get('/run/run.md') ?? '' }
  }

  it('有提交时写进 run.md,并带上 run 的结局', async () => {
    const { config, manifest } = await drive(3)
    expect(config.pendingHandoff?.branch).toBe('efftask/001/integration')
    expect(config.pendingHandoff?.commits).toBe(3)
    expect(config.pendingHandoff?.outcome).toBe('blocked') // 这次是被中断的
    expect(manifest).toContain('pendingHandoff')
    expect(manifest).toContain('efftask/001/integration')
  })

  it('零提交时不留待收口 —— 别为一条空分支弹四选一', async () => {
    const { config, manifest } = await drive(0)
    expect(config.pendingHandoff).toBeUndefined()
    expect(manifest).not.toContain('pendingHandoff')
  })
})

describe('异常路径上待收口状态同样要落盘', () => {
  it('happy path 的那次 manifest 写入没跑到时,finally 里补写', async () => {
    // reclaim 在 try 里、queueManifest 在它后面。两者之间任何一步抛出,就会跳到 catch,
    // 于是 pendingHandoff 被设进 config、一次也没写出去 —— 集成分支再没人处置,而这
    // 恰恰是「跑完先还终端、回头再收口」整条路赖以存在的那条记录。
    const fs = memFs()
    const ac = new AbortController()
    ac.abort()
    const config = cfg()
    let calls = 0
    await runOrchestrator(
      {
        config, runDir: '/run', fs, runAgent: (async () => '') as RunAgentFn, signal: ac.signal,
        // biome-ignore lint/suspicious/noExplicitAny: partial worktree pool double
        worktrees: {
          init: async () => {}, acquire: async () => undefined, release: async () => {},
          dispose: async () => {}, integrationBranchName: 'b',
          // 先让排队中的 manifest 写入排干。否则更早那次 queueManifest 会在 pendingHandoff
          // 被设上之后才真正执行(它是惰性读 config 的),顺手把字段带出去 —— 于是这条
          // 测试会因为一个**竞态**而通过,而不是因为 finally 里那次补写。
          handoff: async () => {
            await new Promise(r => setTimeout(r, 10))
            return { branch: 'b', commits: 2, kept: [], salvage: [], integrationPath: '/p' }
          },
        } as any,
      },
      // 精确打在 reclaim **之后**、queueManifest **之前**的那一步。按调用序号数是错的:
      // setNodes 还会被 orch 的 onUpdate 调用(而那里的抛出被吞掉),实测调了 3 次。
      // 按「pendingHandoff 已经被设上」判定,才是那一步。
      () => { calls++; if (config.pendingHandoff) throw new Error('store 炸了') },
      () => {}, () => {},
    )
    expect(config.pendingHandoff?.branch).toBe('b')
    expect(fs.files.get('/run/run.md') ?? '').toContain('pendingHandoff')
  })
})

describe('运行中调过的并发度要落进 run.md', () => {
  it('写出去的是**现在这个数**,不是关口批准的那个', async () => {
    /**
     * `--resume` 的并发上限是从 run.md 读回来的(readRunManifest → config.parallelism),
     * 所以不同步的话「我把它从 5 调到 10」在下一次恢复时静默变回 5,而屏幕上从没说过这件事。
     * run.md 同时也是事后唯一能回答「这一趟到底是按几并发跑的」的地方。
     */
    const fs = memFs()
    const ac = new AbortController()
    ac.abort() // 最短路径就够:这条接缝在 queueManifest 里,和跑不跑节点无关
    const control = createRunControl()
    control.setParallelism(11)
    const config = cfg()
    expect(config.parallelism).toBe(5)

    await runOrchestrator(
      {
        config, runDir: '/run/007', fs, control,
        runAgent: (async () => { throw new Error('模型不应被调用') }) as RunAgentFn,
        signal: ac.signal,
      },
      () => {}, () => {}, () => {},
    )

    expect(fs.files.get('/run/007/run.md') ?? '').toContain('parallelism: 11')
    // config 也被同步了 —— 关口之后这份快照就是「这一趟实际怎么跑的」。
    expect(config.parallelism).toBe(11)
  })

  it('没调过时一个字都不改 —— 关口批准的那个数原样落盘', async () => {
    const fs = memFs()
    const ac = new AbortController()
    ac.abort()
    const config = cfg()
    await runOrchestrator(
      {
        config, runDir: '/run/008', fs, control: createRunControl(),
        runAgent: (async () => { throw new Error('模型不应被调用') }) as RunAgentFn,
        signal: ac.signal,
      },
      () => {}, () => {}, () => {},
    )
    expect(fs.files.get('/run/008/run.md') ?? '').toContain('parallelism: 5')
    expect(config.parallelism).toBe(5)
  })
})

describe('收口撞上冲突:模型先解一次(用户要求的那件事)', () => {
  /**
   * 这一跳只能在 runOrchestrator 这一层断:`makeHandoffConflictResolver` 要一个根节点,
   * 而根节点是 `liveNodes` 里的 —— 那份数组由编排器在 run 之后填,收口读的就是它。
   * 断在 finishHandoff 那一层只能证明「传下去的东西会被用」,证明不了这里传了东西。
   */
  it('冲突 → 真的派出一次带写工具的模型调用,解完复核通过就提交', async () => {
    const fs = memFs()
    const calls: string[][] = []
    let statuses = 0
    const git = async (args: string[]) => {
      calls.push(args)
      const [a, b] = args
      if (a === 'diff') return { code: 0, stdout: '', stderr: '' }
      if (a === 'symbolic-ref') return { code: 0, stdout: 'refs/heads/main\n', stderr: '' }
      if (a === 'rev-parse') return { code: 0, stdout: 'cafe123\n', stderr: '' }
      if (a === 'merge' && b === '--abort') return { code: 0, stdout: '', stderr: '' }
      if (a === 'merge') return { code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in pay.ts' }
      // 第一次问是合并之后(有冲突),之后是模型解完之后(干净)。
      if (a === 'status') return { code: 0, stdout: statuses++ === 0 ? 'UU pay.ts\n' : '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const dispatched: { phase: string; cwd?: string; prompt: string; nodeId: string }[] = []
    const runAgent: RunAgentFn = async req => {
      dispatched.push({ phase: req.phase, cwd: req.cwd, prompt: req.prompt, nodeId: req.node.id })
      return ''
    }
    const results: { merged: boolean; result?: { ok: boolean; message: string } }[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/005', fs, runAgent,
        signal: new AbortController().signal,
        worktrees: {
          init: async () => ({ ok: true }),
          acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'b', gitRoot: '/repo' }),
          commitAndMerge: async () => ({ ok: true, merged: true }),
          release: async () => ({ removed: true }),
          dispose: async () => ({ kept: [] }),
          handoff: async () => ({ branch: 'efftask/005/integration', commits: 3, kept: [], salvage: [], integrationPath: '/wt/integration' }),
          withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
          integrationPath: '/wt/integration',
          integrationBranchName: 'efftask/005/integration',
        } as never,
        seed: [{
          id: 'root', title: '根任务', goal: 'g', parentId: null, childIds: [], deps: [],
          kind: 'executable' as const, status: 'ACCEPTED' as const,
          phaseRoles: emptyPhaseRoles(),
          plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
          execStatus: '做完了', blockedReason: '', reviewLog: [], acceptLog: [], score: {},
          iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
          depth: 0, createdAt: 'T0', updatedAt: 'T0',
        }] as never,
        cwd: '/repo', git: git as never,
        onHandoffResult: r => results.push(r as never),
      },
      () => {}, () => {}, () => {},
    )
    expect(dispatched.length).toBe(1)
    // execute 才带写工具;跑在**用户的检出**里,不是隔离工作区 —— 冲突现场在那儿。
    expect(dispatched[0]!.phase).toBe('execute')
    expect(dispatched[0]!.cwd).toBe('/repo')
    expect(dispatched[0]!.nodeId).toBe('root')
    expect(dispatched[0]!.prompt).toContain('pay.ts')
    expect(dispatched[0]!.prompt).toContain('efftask/005/integration')
    // 解完了才提交,而且屏幕上说的是实话。
    expect(calls.some(c => c[0] === 'commit')).toBe(true)
    expect(results[0]?.merged).toBe(true)
    expect(results[0]?.result?.message).toContain('已自动解决')
  })
})

/**
 * run.md 的写入要**合并**,否则大树跑不动。
 *
 * `onUpdate` 每一次状态迁移都来一次,而每一次都把整棵树重画进 run.md。实测:
 * 5000 节点 ≈ 390 KB / 3.5 ms,20000 节点 ≈ 1.5 MB / 13 ms。一个节点一生至少六次迁移,
 * 于是「每次都完整写一遍」在 20000 节点上是十几万次 × 1.5 MB —— 而其中除了最后一次,
 * 每一份都在下一次迁移到来时就作废了。
 *
 * 合并不丢信息:run.md 是**快照**,不是日志。
 */
describe('run.md 写入合并:只落最新那一份', () => {
  it('一次写入在飞时来的多次更新,合并成一次,而且落的是最后那一份', async () => {
    const fs2 = memFs()
    const ac = new AbortController()
    let writes = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slowFs: FsLike = {
      ...fs2,
      writeFile: async (p, d) => {
        if (p.endsWith('run.md')) { writes++; await gate }
        await fs2.writeFile(p, d)
      },
    }
    let seen = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test"}\n```'
      }
      if (req.phase === 'execute') { seen++; return '```json\n{"execStatus":"改了 foo.ts"}\n```' }
      if (req.phase === 'review') {
        return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z]+)/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","solution":"s2","keyPoints":"k","risks":"r","acceptance":"跑 bun test"}\n```'
      }
      return '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') +
        '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    // 第一次写卡住 → 期间的每一次状态迁移都只更新「待写的那一份」。
    setTimeout(release, 30)
    await runOrchestrator(
      { config: cfg(), runDir: '/r', fs: slowFs, runAgent, signal: ac.signal },
      () => {}, () => {}, () => {},
    )
    expect(seen).toBe(1)
    // 一个节点一生六次以上迁移,而写入次数必须**远少于**它。
    expect(writes).toBeLessThan(5)
    // 而最终那一份是完整的:状态行和树都在。
    const md = fs2.files.get('/r/run.md') ?? ''
    expect(md).toContain('status: completed')
    expect(md).toContain('(ACCEPTED)')
  })
})
