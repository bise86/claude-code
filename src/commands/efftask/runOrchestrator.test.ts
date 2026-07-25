import { describe, expect, it } from 'bun:test'
import { runOrchestrator, type Outcome } from './runOrchestrator.js'
import type { FsLike } from '../../tools/efftask/persistence.js'
import { DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'

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
