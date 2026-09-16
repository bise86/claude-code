import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'
import { generateTaskId } from './generateTaskId.js'
import { parseTaskIdOutput } from './parseOutput.js'
import { makeRootNode } from './rootPlan.js'
import { createChildren, type PipelineCtx } from './pipeline.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import { addTaskScope } from './addTask.js'
import { runAddTask, type AddTaskRunDeps } from './addTaskRun.js'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig, type TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-09-15T00:00:00Z'
const RULE = '使用任务实际处理的文件相对于项目根目录的路径'
const cfg = (): EffTaskConfig => ({
  goalPrompt: '检查 src/a.ts 和 src/b.ts,按文件拆分任务', taskIdRule: RULE,
  taskDeduplication: true, parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [],
})
const tagOf = (prompt: string) => prompt.match(/语言标记\(fence info string\)写成 ([a-z]+)/)?.[1]
const reply = (prompt: string, data: unknown) => '```' + tagOf(prompt) + '\n' + JSON.stringify(data) + '\n```'
const plan = { solution: '按实际文件修复问题', keyPoints: '每个文件分别修改', risks: '保持兼容性', acceptance: '执行测试确认通过' }

function addHarness() {
  const root = makeRootNode(cfg(), NOW)
  root.status = 'ACCEPTED'
  const byId = new Map([[root.id, root]])
  const scope = addTaskScope(root, byId, { caps: DEFAULT_CAPS, nodeCount: 1 })
  if (!scope.ok) throw new Error(scope.reason)
  const events: string[] = []
  const deps: AddTaskRunDeps = {
    taskIdRule: RULE, taskDeduplication: true,
    byId: () => byId, now: () => NOW,
    hold: () => { events.push('hold'); return { ok: true, release() {} } },
    reserve: () => { events.push('reserve'); return { release() {} } },
    persist: async n => { events.push(`persist:${n.taskId}`) },
    onNodes: nodes => { events.push('publish'); for (const n of nodes) byId.set(n.id, n) },
    onProblems: p => { if (p.length > 0) events.push('problem') },
    onDone: () => { events.push('done') },
  }
  return { root, byId, scope, deps, events }
}

describe('任务 ID 生成规则', () => {
  it('“任务ID:相对路径”解析为规则,具体根 ID 由任务对象推导', async () => {
    const config = await parseDirectives('任务ID:相对路径\n修复 src/a.ts', {
      knownRoles: [], modelJson: async p => {
        expect(p).toContain('不是给所有任务设置同一个固定值')
        return JSON.stringify({ taskIdRule: RULE, rootTaskId: 'src/a.ts', taskId: '相对路径' })
      },
    })
    expect(config.taskIdRule).toBe(RULE)
    expect(config).not.toHaveProperty('taskId')
    expect(makeRootNode(config, NOW).taskId).toBe('src/a.ts')
  })

  it('不再识别固定 ID 配置,没有规则就用 UUID', async () => {
    const config = await parseDirectives('taskId: fixed-value', {
      knownRoles: [], modelJson: async () => '{"taskId":"fixed-value","rootTaskId":"fixed-value"}',
    })
    expect(config.taskIdRule).toBeUndefined()
    expect(config.rootTaskId).toBeUndefined()
    expect(makeRootNode(config, NOW).taskId).toMatch(/^[\da-f-]{36}$/)
  })

  it('生成器收到规则和具体任务,按不同对象得到不同 ID', async () => {
    const modelJson = async (p: string) => {
      expect(p).toContain(RULE)
      expect(p).toContain('不要把规则的文字当成 ID')
      expect(p).toContain('同一任务在不同轮次、不同父任务下')
      expect(p).toContain('本次只生成 ID,不要执行任务')
      const content = JSON.parse(p.match(/任务内容:(.+)\n/)![1]!) as string
      return reply(p, { taskId: content.match(/src\/[ab]\.ts/)![0] })
    }
    expect(await generateTaskId({ rule: RULE, title: '修复文件', prompt: '检查 src/a.ts', modelJson })).toBe('src/a.ts')
    expect(await generateTaskId({ rule: RULE, title: '修复文件', prompt: '检查 src/b.ts', modelJson })).toBe('src/b.ts')
    expect(await generateTaskId({ rule: RULE, title: '换个标题再次检查', prompt: '再检查 src/a.ts', modelJson })).toBe('src/a.ts')
  })

  it('无法生成具体 ID 或把规则原样当 ID 时不放行', async () => {
    for (const id of [null, 123, '', RULE]) {
      await expect(generateTaskId({ rule: RULE, title: '任务', prompt: '做这件事', modelJson: async p => reply(p, { taskId: id }) })).rejects.toThrow('无法根据任务 ID 规则')
    }
    expect(parseTaskIdOutput('```json\n{"taskId":"quoted-context"}\n```', 'identityabc')).toBeUndefined()
    expect(parseTaskIdOutput('```identityabc\n{"taskId":"a"}\n```\n```identityabc\n{"taskId":"b"}\n```', 'identityabc')).toBeUndefined()
  })

  it('拆分、质疑修复、执行、集成验收都收到同一规则;相同文件只派发一次', async () => {
    const config = cfg()
    const phases = new Set<string>(), executed: string[] = []
    const specs = ['a', 'b'].map(name => ({ taskId: `src/${name}.ts`, title: `修复 ${name}`, deps: [] }))
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan' || req.phase === 'review' || req.phase === 'execute' || req.node.id === 'root') {
        expect(req.prompt).toContain(RULE)
        phases.add(req.node.id === 'root' && req.phase === 'accept' ? 'integrate' : req.phase)
      }
      if (req.phase === 'plan' || req.phase === 'review') {
        return reply(req.prompt, { ...plan, kind: req.node.id === 'root' ? 'decompose' : 'executable', children: req.node.id === 'root' ? specs : [] })
      }
      if (req.phase === 'execute') {
        executed.push(req.node.taskId)
        return reply(req.prompt, { execStatus: '已修复对应文件,测试全部通过', newChildren: [{ taskId: 'src/b.ts', title: '另一个名字的 B 文件任务', parent: 'root', deps: [] }] })
      }
      return reply(req.prompt, { pass: true, blocking: [], comments: '通过' })
    }
    const orch = new EffTaskOrchestrator(config, { runAgent, persist: async () => {}, now: () => NOW, onUpdate() {}, sharedParallel: true }, new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(executed.sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(orch.nodes()).toHaveLength(3)
    expect([...phases].sort()).toEqual(['execute', 'integrate', 'plan', 'review'])
  })

  it('规则存在但模型漏掉子任务 ID 时,在占额度和落盘之前要求重新生成', async () => {
    const config = cfg(), root = makeRootNode(config, NOW)
    const forbidden = () => { throw new Error('不应占用额度或落盘') }
    const context = {
      config, byId: new Map([[root.id, root]]), reserveNodes: forbidden, persist: forbidden,
    } as unknown as PipelineCtx
    const result = await createChildren(root, [{ title: '修复 src/a.ts', deps: [] }], context)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.retryable).toBe(true)
    expect(root.childIds).toEqual([])
  })
})

describe('手工新增按任务生成 ID', () => {
  it('先生成再占名额和落盘,换标题重复新增同一对象也能查重', async () => {
    const h = addHarness()
    h.deps.modelJson = async p => { h.events.push('generate'); return reply(p, { taskId: 'src/a.ts' }) }
    const first = await runAddTask(h.scope, { title: '修复 A', prompt: '修复 src/a.ts' }, h.deps, () => undefined)
    expect(first.ok && 'node' in first ? first.node.taskId : '').toBe('src/a.ts')
    expect(h.events[0]).toBe('generate')
    expect(h.events.indexOf('hold')).toBeGreaterThan(0)
    h.events.length = 0
    expect(await runAddTask(h.scope, { title: '再次修复', prompt: '检查 src/a.ts' }, h.deps, () => { throw new Error('重复任务不复核树') })).toEqual({ ok: true, skipped: true, taskId: 'src/a.ts' })
    expect(h.events).toEqual(['generate', 'done'])
    expect(h.root.childIds).toHaveLength(1)
  })

  it('生成失败不创建任务,保留父节点状态', async () => {
    const h = addHarness()
    h.deps.modelJson = async () => { throw new Error('生成器不可用') }
    const before = structuredClone(h.root)
    const result = await runAddTask(h.scope, { title: '修复 A', prompt: '修复 src/a.ts' }, h.deps, () => undefined)
    expect(result.ok).toBe(false)
    expect(h.events).toEqual(['problem', 'done'])
    expect(h.root).toEqual(before)
  })

  it('没有规则不调用生成器,旧固定 ID 写法也不会被当成 ID', async () => {
    const h = addHarness()
    delete h.deps.taskIdRule
    h.deps.modelJson = async () => { throw new Error('不应该调用生成器') }
    const result = await runAddTask(h.scope, { title: '任务', prompt: 'taskId: fixed-value\n修复 src/a.ts' }, h.deps, () => undefined)
    expect(result.ok && 'node' in result ? result.node.taskId : '').toMatch(/^[\da-f-]{36}$/)
  })
})
