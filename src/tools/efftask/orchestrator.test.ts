// src/tools/efftask/orchestrator.test.ts
import { describe, expect, it } from 'bun:test'
import { emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig } from './types.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({ goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over })
const deps = (runAgent: RunAgentFn) => ({ runAgent, persist: async () => {}, now: () => NOW, onUpdate: () => {} })

describe('EffTaskOrchestrator (serial)', () => {
  it('single executable root: plan->review->execute->accept => completed', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
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
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
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
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') { execOrder.push(req.node.id); return '```json\n{"execStatus":"done"}\n```' }
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    await orch.run()
    expect(execOrder).toEqual(['root/01-first', 'root/02-second'])
  })

  it('blocked plan (review always fails) => run returns blocked', async () => {
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan' ? '```json\n{"kind":"executable","solution":"weak"}\n```' : '```json\n{"pass":false,"blocking":["no"],"comments":""}\n```'
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    expect((await orch.run()).status).toBe('blocked')
  })

  it('BLOCKED propagates: a child that always fails acceptance => root ends BLOCKED, run returns blocked', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"only","deps":[]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'review') return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' // plans pass review
      if (req.phase === 'execute') return '```json\n{"execStatus":"did"}\n```'
      return '```json\n{"pass":false,"blocking":["永远不过"],"comments":""}\n```' // child acceptance always fails → BLOCKED after maxIterations
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
    if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
    if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
    return '```verdict\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
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
        return '```plan\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
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

  it('terminates on a bounded number of model calls when acceptance never passes', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      calls++
      if (calls > 200) throw new Error('runaway loop')
      if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
      if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
      if (req.phase === 'review') return '```verdict\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
      return '```verdict\n{"pass":false,"blocking":["永远不过"],"comments":""}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('超限')
    expect(calls).toBeLessThan(200)
  })
})
