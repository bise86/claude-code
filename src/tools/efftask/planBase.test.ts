/**
 * 跨分支依赖调度的另一半:**分析与质疑修复也要站在集成分支的当前状态上。**
 *
 * 用户报的问题:「某个任务依赖另外一个任务时,要先从主干同步过来」。执行环节一直是对的
 * (`acquire` 基于集成分支 tip 落基线,返工轮再 `refreshFromIntegration`),漏掉的是它
 * 前面那两关 —— 它们从来没有 cwd,读的是用户的主检出,而隔离运行下那棵树从 run 开始到
 * 结束一个字节都不会变(所有产出都在集成分支上)。于是一个依赖别人的节点,方案是对着
 * 「依赖还没做」的代码写出来的。
 *
 * 最后一个用例走**真 git**:这条链上唯一会说谎的接缝就是 cwd,而假 pool 里的
 * `/wt/<id>` 不是一个真目录 —— 只有真仓库能证明「方案席确实读得到依赖的产出」。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap } from './stateMachine.js'
import { PipelineCtx, stepStart, stepExecute } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'
import { createWorktreePool, type GitRunner } from './worktreePool.js'

const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict')
const NOW = '2026-08-05T00:00:00Z'
const cfg: EffTaskConfig = { goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
const PLAN_OK = '```json\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'

const node = (id = 'root', title = 'r'): TaskNode =>
  createNode({ id, title, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn, over: Partial<PipelineCtx> = {}): PipelineCtx {
  return {
    config: cfg, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
    ...over,
  }
}

/** 记录每一次 acquire / release,好证明「借了就还」和「执行时再借一次」。 */
function spyPool(over: Record<string, unknown> = {}) {
  const acquired: string[] = []
  const released: string[] = []
  return {
    acquired, released,
    pool: {
      acquire: async (n: TaskNode) => { acquired.push(n.id); return { path: `/wt/${n.id}`, branch: `efftask/001/${n.id}`, gitRoot: '/repo' } },
      release: async (n: TaskNode) => { released.push(n.id); return { removed: true } },
      commitAndMerge: async () => ({ ok: true, merged: true }),
      dispose: async () => ({ kept: [] }),
      init: async () => ({ ok: true }),
      withIntegrationRead: <T,>(fn: () => Promise<T>) => fn(),
      withIntegrationReview: <T,>(fn: (p: string) => Promise<T>) => fn('/wt/integration-review-0'),
      refreshFromIntegration: async () => ({ ok: true, updated: false }),
      integrationPath: '/wt/integration',
      integrationBranchName: 'efftask/001/integration',
      ...over,
    } as never,
  }
}

describe('分析/质疑修复的基线', () => {
  it('两关都在节点自己的隔离工作区里跑,而不是用户的主检出', async () => {
    const n = node()
    const cwds = new Map<string, string | undefined>()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string; cwd?: string }) => {
      cwds.set(req.phase, req.cwd)
      return req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const { pool } = spyPool()
    await stepStart(n, ctxFor([n], agent, { worktrees: pool }))
    expect(n.status).toBe('READY')
    expect(cwds.get('plan')).toBe('/wt/root')
    expect(cwds.get('review')).toBe('/wt/root')
  })

  it('借了就还:stepStart 返回时不挂工作区,执行环节照旧自己再借一次', async () => {
    // 这条是执行侧一整套判据的前提。留给执行环节的话:①acquire 被跳过,执行就从**分析时**
    // 的基线开始(陈旧只是被推迟);②`enterAtJudge` 判的正是 `node.worktree !== undefined`,
    // 一个没人执行过的空工作区会让「跳过验收」把它合进集成分支并判 ACCEPTED。
    const n = node()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string }) =>
      req.phase === 'plan' ? PLAN_OK
        : req.phase === 'execute' ? '```json\n{"execStatus":"改了 a.ts"}\n```'
          : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const { pool, acquired } = spyPool()
    const ctx = ctxFor([n], agent, { worktrees: pool })
    await stepStart(n, ctx)
    expect(n.worktree).toBeUndefined()
    expect(acquired).toEqual(['root'])
    await stepExecute(n, ctx)
    // 第二次 —— 落在集成分支**那时**的状态上,而不是方案写完那一刻的。
    expect(acquired).toEqual(['root', 'root'])
    expect(n.status).toBe('ACCEPTED')
  })

  it('还的时候:decompose 节点回收磁盘,executable 节点留着目录给执行环节复用', async () => {
    // release 一个马上要在同一个目录上重新 acquire 的节点 = 白付一次 git worktree add。
    const leaf = node()
    const agentLeaf: RunAgentFn = async (req: { phase: string; prompt: string }) =>
      req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const a = spyPool()
    await stepStart(leaf, ctxFor([leaf], agentLeaf, { worktrees: a.pool }))
    expect(leaf.kind).toBe('executable')
    expect(a.released).toEqual([])

    const parent = node()
    const agentParent: RunAgentFn = async (req: { phase: string; prompt: string }) =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a","children":[{"title":"AA","deps":[]}]}\n```'
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const b = spyPool()
    await stepStart(parent, ctxFor([parent], agentParent, { worktrees: b.pool }))
    expect(parent.status).toBe('WAITING_CHILDREN')
    expect(b.released).toEqual(['root'])
    expect(parent.worktree).toBeUndefined()
  })

  it('拿不到工作区**不阻断**,退回主检出并在 node.md 上说清它看不到什么', async () => {
    // 执行环节那条是硬闸(带写工具的执行者绝不能落进用户检出)。这两关不是:为了一次
    // 读不到最新代码就杀掉整个节点,代价远大于病。
    const n = node()
    const cwds = new Map<string, string | undefined>()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string; cwd?: string }) => {
      cwds.set(req.phase, req.cwd)
      return req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const { pool } = spyPool({ acquire: async () => ({ error: '磁盘满' }) })
    await stepStart(n, ctxFor([n], agent, { worktrees: pool }))
    expect(n.status).toBe('READY')
    expect(cwds.get('plan')).toBeUndefined()
    expect(n.execStatus).toContain('磁盘满')
    expect(n.execStatus).toContain('主工作树')
  })

  it('acquire 抛异常同样只降级,不让整个节点陪葬', async () => {
    const n = node()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string }) =>
      req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const { pool } = spyPool({ acquire: async () => { throw new Error('git 炸了') } })
    await stepStart(n, ctxFor([n], agent, { worktrees: pool }))
    expect(n.status).toBe('READY')
    expect(n.execStatus).toContain('git 炸了')
  })

  it('共享工作树(没开隔离)一切照旧:不借、不还、没有 cwd', async () => {
    const n = node()
    const cwds = new Map<string, string | undefined>()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string; cwd?: string }) => {
      cwds.set(req.phase, req.cwd)
      return req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    await stepStart(n, ctxFor([n], agent))
    expect(n.status).toBe('READY')
    expect(cwds.get('plan')).toBeUndefined()
    expect(cwds.get('review')).toBeUndefined()
    // execStatus 里只允许有编排器注记(这份桩机让质疑修复答成了裁决形状,它会留一句
    // 「未采用」)—— 判据是**没有执行者写的东西**,不是空串。
    expect(n.execStatus.split('\n').filter(Boolean).every(l => l.startsWith('(注:'))).toBe(true)
  })

  it('别人的工作区不还 —— 冲突待人工处理的节点带着现场进来', async () => {
    // resumeCore 显式为这种节点保留 worktree 路径(那是人工解决冲突的现场)。
    // 「还」的对象只能是自己借的那一份。
    const n = node()
    n.worktree = { branch: 'efftask/001/root', path: '/human/root' }
    const agent: RunAgentFn = async (req: { phase: string; prompt: string }) =>
      req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const { pool, acquired, released } = spyPool()
    await stepStart(n, ctxFor([n], agent, { worktrees: pool }))
    expect(acquired).toEqual([])
    expect(released).toEqual([])
    expect(n.worktree).toEqual({ branch: 'efftask/001/root', path: '/human/root' })
  })
})

// ---------------------------------------------------------------------------
// 真 git:依赖的产出必须真的出现在方案席脚下的那个目录里。
// ---------------------------------------------------------------------------

const git: GitRunner = (args, cwd) =>
  new Promise(resolve => {
    const p = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += String(d) })
    p.stderr.on('data', d => { stderr += String(d) })
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    p.on('error', e => resolve({ code: -1, stdout: '', stderr: String(e) }))
  })

describe('真 git:依赖已合入集成分支的产出,方案席读得到', () => {
  const roots: string[] = []
  let gitRoot = ''
  let worktreeRoot = ''

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'efftask-planbase-'))
    roots.push(base)
    gitRoot = join(base, 'repo')
    worktreeRoot = join(base, 'wt')
    await mkdir(gitRoot, { recursive: true })
    await mkdir(worktreeRoot, { recursive: true })
    await git(['init', '-q', '-b', 'main', '.'], gitRoot)
    await git(['config', 'user.email', 's@s'], gitRoot)
    await git(['config', 'user.name', 's'], gitRoot)
    await writeFile(join(gitRoot, 'base.txt'), 'base\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'base'], gitRoot)
  })
  afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

  it('方案席和评审席在自己的工作区里都能读到依赖 A 的文件(主检出里没有)', async () => {
    const pool = createWorktreePool({ runId: '001', gitRoot, git, worktreeRoot })
    expect(await pool.init()).toEqual({ ok: true })
    // 任务 A 已验收 = 它的产出已经合进集成分支。主检出(gitRoot)里一个字都没有。
    await writeFile(join(pool.integrationPath, 'from-a.rs'), 'pub fn a() {}\n')
    await git(['add', '-A'], pool.integrationPath)
    await git(['commit', '-qm', 'A 的产出'], pool.integrationPath)
    expect(await readFile(join(gitRoot, 'from-a.rs'), 'utf-8').catch(() => null)).toBeNull()

    const b = node('root/02-b', 'B 依赖 A')
    const seen = new Map<string, string | null>()
    const agent: RunAgentFn = async (req: { phase: string; prompt: string; cwd?: string }) => {
      // 模型能看到什么,取决于它脚下是哪个目录 —— 这就是这条链上唯一会说谎的接缝。
      seen.set(req.phase, req.cwd ? await readFile(join(req.cwd, 'from-a.rs'), 'utf-8').catch(() => null) : null)
      return req.phase === 'plan' ? PLAN_OK : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    await stepStart(b, ctxFor([b], agent, { worktrees: pool as never }))

    expect(b.status).toBe('READY')
    expect(seen.get('plan')).toContain('pub fn a()')
    expect(seen.get('review')).toContain('pub fn a()')
    // 借了就还:目录留着给执行环节复用,但引用已经交回去了。
    expect(b.worktree).toBeUndefined()
  })
})
