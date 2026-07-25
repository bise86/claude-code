// src/tools/efftask/pipeline.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap } from './stateMachine.js'
import { PipelineCtx, stepStart, stepExecute, stepIntegrate } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg: EffTaskConfig = { goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
function ctxFor(
  nodes: TaskNode[],
  runAgent: RunAgentFn,
  config: EffTaskConfig = cfg,
  signal: AbortSignal = new AbortController().signal,
): PipelineCtx {
  return { config, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW, signal, onUpdate: () => {} }
}
const root = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('pipeline', () => {
  it('stepStart executable => plan passes review => READY', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"do it","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.kind).toBe('executable')
    expect(n.status).toBe('READY')
    expect(n.plan.solution).toBe('do it')
    expect(n.reviewLog).toHaveLength(1)
  })

  it('stepStart decompose => creates children with mapped deps => WAITING_CHILDREN', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","keyPoints":"","risks":"","acceptance":"","children":[{"title":"AA","deps":[]},{"title":"BB","deps":["AA"]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('WAITING_CHILDREN')
    expect(n.childIds).toEqual(['root/01-aa', 'root/02-bb'])
    const bb = ctx.byId.get('root/02-bb')!
    expect(bb.deps).toEqual(['root/01-aa']) // sibling title mapped to sibling id
    expect(bb.depth).toBe(1)
  })

  it('createChildren: child goal composes the PARENT goal, not just the child title', async () => {
    const n = createNode({ id: 'root', title: 'r', goal: '交付高效任务模式骨架', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","keyPoints":"要点K","risks":"","acceptance":"","children":[{"title":"AA","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    const aa = ctx.byId.get('root/01-aa')!
    expect(aa.goal).toContain('交付高效任务模式骨架') // parent goal inherited, not lost
    expect(aa.goal).toContain('要点K') // parent plan key points carried down
    expect(aa.goal).toContain('AA') // plus this child's own slice
  })

  it('stepStart review fails until iterations exhausted => BLOCKED with a reason', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"weak"}\n```'
        : '```json\n{"pass":false,"blocking":["缺验收点"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.planReview).toBe(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('评审迭代超限') // reason recorded, execStatus untouched
    expect(n.blockedReason).toContain('缺验收点')
    expect(n.execStatus).toBe('')
  })

  it('stepExecute executable => execute + accept pass => ACCEPTED', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const runAgent: RunAgentFn = async req =>
      req.phase === 'execute'
        ? '```json\n{"execStatus":"changed files"}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"good"}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.execStatus).toBe('changed files')
    expect(n.status).toBe('ACCEPTED')
    expect(n.acceptLog).toHaveLength(1)
  })

  it('stepExecute accept fails until exhausted => BLOCKED, execStatus evidence preserved', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const runAgent: RunAgentFn = async req =>
      req.phase === 'execute' ? '```json\n{"execStatus":"改了 foo.ts"}\n```' : '```json\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.acceptance).toBe(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('验收迭代超限')
    expect(n.execStatus).toBe('改了 foo.ts') // completed-work evidence NOT clobbered by the block
  })

  it('stepStart: runAgent throws in plan phase => node BLOCKED with recorded reason', async () => {
    const n = root()
    const runAgent: RunAgentFn = async () => { throw new Error('模型调用失败') }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('模型调用失败')
  })

  it('stepStart: pre-aborted signal => BLOCKED with the abort reason, no model call', async () => {
    const n = root()
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; return '' }
    const ctx = ctxFor([n], runAgent, cfg, ac.signal)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toBe('已中断')
    expect(calls).toBe(0) // aborted before spending a single token
  })

  it('stepStart: node-count cap => parent BLOCKED with 节点数超过上限, no children created', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const capped: EffTaskConfig = { ...cfg, caps: { ...DEFAULT_CAPS, maxNodes: 1 } } // 1 (root) + 1 child > 1
    const ctx = ctxFor([n], runAgent, capped)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('节点数超过上限')
    expect(n.childIds).toEqual([])
    expect(ctx.byId.size).toBe(1) // never silently truncate: zero partial children
  })

  it('stepStart: depth cap forces decompose→executable, child titles survive into plan.solution', async () => {
    const n = root() // depth 0
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":[]},{"title":"BB","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const capped: EffTaskConfig = { ...cfg, caps: { ...DEFAULT_CAPS, maxDepth: 0 } } // depth+1 (=1) > 0
    const ctx = ctxFor([n], runAgent, capped)
    await stepStart(n, ctx)
    expect(n.kind).toBe('executable')
    expect(n.status).toBe('READY')
    expect(n.childIds).toEqual([]) // no children created past the cap
    expect(n.plan.solution).toContain('已达最大深度') // work folded in, not silently dropped
    expect(n.plan.solution).toContain('AA')
    expect(n.plan.solution).toContain('BB')
  })

  it('stepStart: sibling dependency cycle replans (bounded), exhausted => parent BLOCKED, zero children', async () => {
    const n = root()
    const planPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'plan') return '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
      planPrompts.push(req.prompt)
      return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":["BB"]},{"title":"BB","deps":["AA"]}]}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.planReview).toBe(DEFAULT_CAPS.maxIterations) // replanned until the cap
    expect(n.blockedReason).toContain('依赖成环')
    expect(n.childIds).toEqual([])
    expect(ctx.byId.size).toBe(1) // NO partial children left behind on a rejected group
    expect(planPrompts[1]).toContain('成环') // the cycle was fed back as revision feedback
  })

  it('stepStart: review fails once then passes => READY, revision prompt shows the previous plan', async () => {
    const n = root()
    let reviewCalls = 0
    const planPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { planPrompts.push(req.prompt); return '```json\n{"kind":"executable","solution":"写入 hello.txt","acceptance":"a"}\n```' }
      reviewCalls++
      return reviewCalls === 1
        ? '```json\n{"pass":false,"blocking":["补充验收点"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('READY')
    expect(n.iteration.planReview).toBe(1) // one failed round before passing
    expect(n.reviewLog).toHaveLength(2)
    expect(planPrompts[1]).toContain('补充验收点') // blocking feedback threaded in
    expect(planPrompts[1]).toContain('写入 hello.txt') // ...alongside the plan being revised
  })

  it('stepExecute: accept fails once (REWORK) then passes => ACCEPTED, rework prompt carries feedback + prior execStatus', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let acceptCalls = 0
    const execPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') { execPrompts.push(req.prompt); return '```json\n{"execStatus":"改了 foo.ts"}\n```' }
      acceptCalls++
      return acceptCalls === 1
        ? '```json\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    expect(n.iteration.acceptance).toBe(1) // one REWORK round before acceptance
    expect(n.acceptLog).toHaveLength(2)
    expect(execPrompts[1]).toContain('回归失败') // rework knows WHAT to fix
    expect(execPrompts[1]).toContain('改了 foo.ts') // ...and what was already done
  })

  it('stepIntegrate: sees child evidence and passes => ACCEPTED', async () => {
    const n = root(); n.status = 'WAITING_CHILDREN'; n.childIds = ['root/01-aa']
    n.plan.acceptance = '父验收点X'
    const child = createNode({ id: 'root/01-aa', title: 'AA', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    child.status = 'ACCEPTED'; child.execStatus = '子任务产出Y'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' }
    const ctx = ctxFor([n, child], runAgent)
    await stepIntegrate(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    expect(n.acceptLog).toHaveLength(1)
    expect(prompts[0]).toContain('AA') // integratePrompt renders each child…
    expect(prompts[0]).toContain('子任务产出Y') // …with its execStatus evidence
    expect(prompts[0]).toContain('父验收点X') // …against the parent's acceptance criteria
  })

  it('stepIntegrate: integration acceptance fails until iterations exhausted => BLOCKED', async () => {
    const n = root(); n.status = 'WAITING_CHILDREN'; n.childIds = ['root/01-aa']
    const child = createNode({ id: 'root/01-aa', title: 'AA', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    child.status = 'ACCEPTED'; child.execStatus = '子任务产出Y'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return '```json\n{"pass":false,"blocking":["子结果未达成父目标"],"comments":""}\n```' }
    const ctx = ctxFor([n, child], runAgent)
    await stepIntegrate(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.acceptance).toBe(DEFAULT_CAPS.maxIterations) // retried, not one-shot
    expect(n.acceptLog).toHaveLength(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('集成验收迭代超限')
    expect(prompts[1]).toContain('子结果未达成父目标') // failure feedback appended on retry
  })
})
