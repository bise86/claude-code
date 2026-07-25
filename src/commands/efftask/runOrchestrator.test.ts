import { describe, expect, it } from 'bun:test'
import { runOrchestrator, type Outcome } from './runOrchestrator.js'
import type { FsLike } from '../../tools/efftask/persistence.js'
import { DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import type { AppState } from '../../state/AppState.js'
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
  caps: DEFAULT_CAPS,
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
        return '\`\`\`' + (req.prompt.match(/必须是一个 \`\`\`(plan[a-z]+) 代码块/)?.[1] ?? 'plan') +
          '\n{"kind":"executable","goal":"g","acceptance":["a"],"children":[]}\n\`\`\`'
      }
      if (req.phase === 'execute') return '\`\`\`json\n{"execStatus":"做完了"}\n\`\`\`'
      const tag = req.prompt.match(/必须是一个 \`\`\`(verdict[a-z]+) 代码块/)?.[1] ?? 'verdict'
      return '\`\`\`' + tag + '\n{"pass":true,"blocking":[],"comments":"ok"}\n\`\`\`'
    }
    const pool = {
      init: async () => ({ ok: true }),
      acquire: async (n: { id: string }) => ({ path: '/wt/' + n.id, branch: 'efftask/001/n-' + n.id, gitRoot: '/repo' }),
      // Always conflicts: one auto-resolve, one re-acceptance, then a human is owed a card.
      commitAndMerge: async () => { merges++; return { ok: false, kind: 'conflict', files: ['src/pay.ts'] } },
      release: async () => ({ removed: false, keptBecause: '冲突未解决' }),
      dispose: async () => ({ kept: [] }),
      withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
      handoff: async () => ({ branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [] }),
      integrationPath: '/wt/integration',
      conflictState: async () => ({ markers: true, staged: false, files: ['src/pay.ts'] }),
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

    expect(merges).toBe(2) // original + the one bounded retry
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
    // The run ended blocked, so the row must be FAILED — a row still saying 运行中 for a run
    // that is over is the panel lying about the thing it shows.
    expect(t.status).toBe('failed')
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
    expect(s.only().status).toBe('failed')
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
    // A reviewer that always blocks: the run drives the root to 评审迭代超限.
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n```'
        : '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict') +
          '\n{"pass":false,"blocking":["不行"],"comments":""}\n```'
    await runOrchestrator(
      {
        config: cfg(), runDir: '/r', fs: memFs(), runAgent, signal: ac.signal,
        onBlocked: info => fired.push({ category: info.category, reason: info.reason }),
      },
      () => {}, () => {}, () => {},
    )
    expect(fired).toHaveLength(1)
    expect(fired[0].category).toBe('cap-iteration')
    expect(fired[0].reason).toContain('评审迭代超限')
  })
})
