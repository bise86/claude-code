import { describe, expect, it } from 'bun:test'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig, type NodeStatus, type TaskNode } from './types.js'
import { createChildren, stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
import { taskIdRuleFromPrompt, taskIdOf, taskExists } from './taskIdentity.js'
import { parseDirectives } from './parseDirectives.js'
import { parseNewChildren, parsePlanOutput, parseRemedy } from './parseOutput.js'
import { applyRootDraft, makeRootNode } from './rootPlan.js'
import { parseNodeFile, serializeNode, writeRunManifest, type FsLike } from './persistence.js'
import { readRunManifest, validateLoadedNodes } from './resumeCore.js'
import { collectTaskDeduplication } from './roleDefsFromSettings.js'
import { runAddTask } from './addTaskRun.js'
import { addTaskScope } from './addTask.js'
import { EffTaskOrchestrator } from './orchestrator.js'

const NOW = '2026-09-15T00:00:00Z'
const mk = (id = 'root', extra: Partial<TaskNode> = {}) => ({
  ...createNode({ id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...extra,
})
function config(enabled = true): EffTaskConfig {
  return { goalPrompt: '目标', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [], taskDeduplication: enabled }
}
function context(nodes: TaskNode[], enabled = true): PipelineCtx & { calls: string[]; writes: string[] } {
  const cfg = config(enabled)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const calls: string[] = [], writes: string[] = []
  let reserved = 0
  return {
    config: cfg, byId, calls, writes, now: () => NOW, signal: new AbortController().signal, onUpdate() {},
    persist: async n => { writes.push(n.id) },
    runAgent: async req => {
      calls.push(req.phase)
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 ([a-z]+)/)?.[1]
      const out = req.phase === 'plan'
        ? { kind: 'executable', solution: '修改文件并跑测试', keyPoints: '具体改动', risks: '回归风险', acceptance: '跑 bun test 全绿' }
        : req.phase === 'execute' ? { execStatus: '实现完成并通过全部测试' }
          : { pass: true, blocking: [], comments: '检查通过' }
      return '```' + tag + '\n' + JSON.stringify(out) + '\n```'
    },
    reserveNodes: count => {
      if (byId.size + reserved + count > cfg.caps.maxNodes) return null
      reserved += count
      return { release: () => { reserved -= count } }
    },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

const identityReply = (prompt: string, taskId: string) => {
  const tag = prompt.match(/语言标记\(fence info string\)写成 ([a-z]+)/)?.[1]
  return '```' + tag + '\n' + JSON.stringify({ taskId }) + '\n```'
}

describe('任务 ID 录入与持久化', () => {
  it('run.md 往返保留开关和根 ID,旧记录默认关闭', async () => {
    const files = new Map<string, string>()
    const fs = {
      mkdir: async () => {},
      writeFile: async (p: string, d: string) => { files.set(p, d) },
      rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
      readFile: async (p: string) => files.get(p)!,
    } as FsLike
    const cfg = { ...config(), taskIdRule: '实际处理的文件相对路径', rootTaskId: 'src/a.ts' }
    await writeRunManifest(fs, '/run', cfg, [makeRootNode(cfg, NOW)])
    const out = await readRunManifest(fs, '/run')
    expect(out.config.taskDeduplication).toBe(true)
    expect(out.config.taskIdRule).toBe(cfg.taskIdRule)
    expect(out.config.rootTaskId).toBe('src/a.ts')
    files.set('/run/run.md', '---\n{"goalPrompt":"旧任务"}\n---\n')
    expect((await readRunManifest(fs, '/run')).config.taskDeduplication).toBe(false)
  })
  it('缺省 UUID,显式字符串逐字保留,不作为内部路径', () => {
    const a = mk(), b = mk()
    expect(a.taskId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(a.taskId).not.toBe(b.taskId)
    const taskId = '../中文任务/Case "A"'
    const n = createNode({ ...a, taskId, now: NOW })
    expect(n.taskId).toBe(taskId)
    expect(n.id).toBe('root')
    expect(parseNodeFile(serializeNode(n)).taskId).toBe(taskId)
    expect(taskIdOf(123)).toBeUndefined()
    expect(taskIdOf('  ')).toBeUndefined()
  })

  it('规则可明确写出或由自然语言抽取,根 ID 根据实际任务推导', async () => {
    expect(taskIdRuleFromPrompt('任务ID规则：实际处理的文件相对路径\n修复文件')).toBe('实际处理的文件相对路径')
    expect(taskIdRuleFromPrompt('taskId: 固定值')).toBeUndefined()
    expect(taskIdRuleFromPrompt('taskIdRule:\n下一行是任务内容')).toBeUndefined()
    const exact = await parseDirectives('taskIdRule: 相对路径\n修复文件', { knownRoles: [] })
    expect(exact.taskIdRule).toBe('相对路径')
    expect(exact.taskDeduplication).toBe(false)
    const parsed = await parseDirectives('修复 src/a.ts,任务id是相对路径', {
      knownRoles: [], taskDeduplication: true,
      modelJson: async p => { expect(p).toContain('"taskIdRule"'); return '{"taskIdRule":"相对路径","rootTaskId":"src/a.ts","taskDeduplication":false}' },
    })
    expect(parsed.taskIdRule).toBe('相对路径')
    expect(parsed.taskDeduplication).toBe(true)
    expect(makeRootNode(parsed, NOW).taskId).toBe('src/a.ts')
  })

  it('配置默认关闭,项目/本地的显式 false 覆盖用户 true', () => {
    expect(collectTaskDeduplication({ read: () => undefined })).toBe(false)
    expect(collectTaskDeduplication({ read: () => ({ efftaskTaskDeduplication: 'true' }) })).toBe(false)
    expect(collectTaskDeduplication({ read: s => s === 'userSettings' ? { efftaskTaskDeduplication: true } : undefined })).toBe(true)
    expect(collectTaskDeduplication({ read: s => ({ efftaskTaskDeduplication: s === 'userSettings' }) })).toBe(false)
  })

  it('拆分、动态新增、补救和根方案确认保留子任务 ID', () => {
    const child = { taskId: '同一业务操作', title: '子任务', deps: [] }
    const parsed = parsePlanOutput(JSON.stringify({ kind: 'decompose', children: [child] }))
    expect(parsed.children).toEqual([child])
    expect(parseNewChildren({ newChildren: [child] })[0]?.taskId).toBe(child.taskId)
    expect(parseRemedy({ remedy: [child] })[0]?.taskId).toBe(child.taskId)
    const n = mk()
    applyRootDraft(n, parsed, NOW)
    const restored = validateLoadedNodes([parseNodeFile(serializeNode(n))], { goal: '目标', phaseRoles: emptyPhaseRoles(), now: NOW }).nodes[0]!
    expect(restored.taskId).toBe(n.taskId)
    expect(restored.confirmedDraft?.children[0]?.taskId).toBe(child.taskId)
    const legacy = { ...n, taskId: undefined } as unknown as TaskNode
    expect(validateLoadedNodes([legacy], { goal: '目标', phaseRoles: emptyPhaseRoles(), now: NOW }).nodes[0]?.taskId).toMatch(/^[\da-f-]{36}$/)
  })
})

describe('派发去重', () => {
  it('动态新增重复项不重开终态目标,也不改变当前执行节点的类型', async () => {
    const original = mk('old', { taskId: 'done', status: 'BLOCKED' })
    const root = mk('root', { kind: 'executable', status: 'READY' }), ctx = context([root, original])
    const run = ctx.runAgent
    ctx.runAgent = async req => {
      if (req.phase !== 'execute') return run(req)
      ctx.calls.push('execute')
      const tag = req.prompt.match(/语言标记\(fence info string\)写成 ([a-z]+)/)?.[1]
      return '```' + tag + '\n' + JSON.stringify({ execStatus: '执行成功并已通过测试', newChildren: [{ taskId: 'done', parent: 'old', title: '重复', deps: [] }] }) + '\n```'
    }
    await stepExecute(root, ctx)
    expect(root.status).toBe('ACCEPTED')
    expect(root.kind).toBe('executable')
    expect(root.childIds).toEqual([])
    expect(original.status).toBe('BLOCKED')
    expect(original.childIds).toEqual([])
    expect(root.execStatus).toContain('已跳过派发')
  })
  for (const status of ['CREATED', 'READY', 'EXECUTING', 'ACCEPTED', 'BLOCKED'] as NodeStatus[]) {
    it(`${status} 对应 ID 已存在时不落盘、不占名额、不添加子节点`, async () => {
      const root = mk(), original = mk('existing', { taskId: 'order:1', status })
      const ctx = context([root, original])
      ctx.reserveNodes = () => { throw new Error('重复任务不应进入额度检查') }
      const before = structuredClone(original)
      const result = await createChildren(root, [{ taskId: 'order:1', title: '不同标题', deps: [] }], ctx)
      expect(result).toEqual({ ok: true, added: 0, skipped: ['order:1'] })
      expect(root.childIds).toEqual([])
      expect(ctx.byId.size).toBe(2)
      expect(ctx.writes).toEqual([])
      expect(original).toEqual(before)
    })
  }

  it('关闭时同 ID 仍派发;无 ID 每次使用新的 UUID', async () => {
    const root = mk(), ctx = context([root], false)
    for (let i = 0; i < 2; i++) await createChildren(root, [{ taskId: 'same', title: '同名', deps: [] }], ctx)
    expect(root.childIds).toHaveLength(2)
    const auto = mk(), enabled = context([auto])
    for (let i = 0; i < 2; i++) await createChildren(auto, [{ title: '同名', deps: [] }], enabled)
    expect(new Set([...enabled.byId.values()].map(n => n.taskId)).size).toBe(3)
  })

  it('同批次只创建首个 ID,混合批次只对新节点计数且保留其依赖', async () => {
    const root = mk(), old = mk('old', { taskId: 'old' }), ctx = context([root, old])
    ctx.config.caps.maxNodes = 4
    const out = await createChildren(root, [
      { taskId: 'old', title: '旧', deps: [] },
      { taskId: 'a', title: 'A', deps: [] },
      { taskId: 'a', title: 'A', deps: [] },
      { taskId: 'b', title: 'B', deps: ['A', '旧'] },
    ], ctx)
    expect(out.ok).toBe(true)
    expect(root.childIds).toHaveLength(2)
    expect(ctx.byId.get(root.childIds[1]!)?.deps).toEqual([root.childIds[0]!])
  })

  it('第一次仍在落盘时并发派发相同 ID,只有一次创建', async () => {
    const root = mk(), ctx = context([root]), blocked = deferred(), entered = deferred()
    ctx.persist = async () => { entered.resolve(); await blocked.promise }
    const spec = [{ taskId: 'atomic', title: '唯一任务', deps: [] }]
    const first = createChildren(root, spec, ctx)
    await entered.promise
    expect(await createChildren(root, spec, ctx)).toEqual({ ok: true, added: 0, skipped: ['atomic'] })
    blocked.resolve()
    expect((await first).ok).toBe(true)
    expect(root.childIds).toHaveLength(1)
  })

  it('落盘失败或额度回调抛错后释放 ID 预留,重试仍可派发', async () => {
    for (const where of ['persist', 'reserve'] as const) {
      const root = mk(), ctx = context([root]), spec = [{ taskId: 'retry', title: '任务', deps: [] }]
      const restore = ctx[where === 'persist' ? 'persist' : 'reserveNodes']
      if (where === 'persist') ctx.persist = async () => { throw new Error('disk full') }
      else ctx.reserveNodes = () => { throw new Error('reserve failed') }
      await createChildren(root, spec, ctx).catch(() => {})
      expect(taskExists(ctx.byId, 'retry')).toBe(false)
      if (where === 'persist') ctx.persist = restore as PipelineCtx['persist']
      else ctx.reserveNodes = restore as PipelineCtx['reserveNodes']
      expect((await createChildren(root, spec, ctx)).ok).toBe(true)
    }
  })

  it('整份拆分均重复时直接成功,不会停在没有子节点的 WAITING_CHILDREN', async () => {
    const root = mk()
    const original = mk('old', { taskId: 'done', status: 'ACCEPTED' })
    root.kind = 'decompose'
    root.confirmedDraft = { children: [{ taskId: 'done', title: '已存在', deps: [] }] }
    const ctx = context([root, original])
    ctx.config.skipSteps = ['review']
    await stepStart(root, ctx)
    expect(root.status).toBe('ACCEPTED')
    expect(root.childIds).toEqual([])
    expect(ctx.calls).toEqual([])
  })
})

describe('执行去重', () => {
  it('拆分任务的集成入口同样跳过已有 ID 的重复任务', async () => {
    const original = mk('old', { taskId: 'same', status: 'BLOCKED' })
    const root = mk('root', { taskId: 'same', kind: 'decompose', status: 'WAITING_CHILDREN' })
    const ctx = context([root, original])
    await stepIntegrate(root, ctx)
    expect(root.status).toBe('ACCEPTED')
    expect(ctx.calls).toEqual([])
    expect(original.status).toBe('BLOCKED')
  })
  for (const status of ['EXECUTING', 'ACCEPTED', 'BLOCKED'] as NodeStatus[]) {
    it(`同 ID 原任务为 ${status}:新任务成功,原任务和子树保持原样`, async () => {
      const original = mk('original', { taskId: 'same', status, execStatus: '原任务结果', blockedReason: status === 'BLOCKED' ? '原失败' : '' })
      const duplicate = mk('root', { taskId: 'same', kind: 'executable', status: 'READY' })
      const ctx = context([original, duplicate]), before = structuredClone(original)
      await stepExecute(duplicate, ctx)
      expect(ctx.calls).toEqual([])
      expect(duplicate.status).toBe('ACCEPTED')
      expect(duplicate.taskDuplicateOf).toBe('original')
      expect(original).toEqual(before)
    })
  }

  it('关闭时执行照常进行', async () => {
    const original = mk('original', { taskId: 'same', status: 'BLOCKED' })
    const n = mk('root', { taskId: 'same', kind: 'executable', status: 'READY' }), ctx = context([original, n], false)
    await stepExecute(n, ctx)
    expect(ctx.calls).toContain('execute')
  })

  it('原任务被重做放回待运行状态时,仍然按保存的历史识别重复 ID', async () => {
    const original = mk('old', { taskId: 'same', status: 'CREATED', taskExecutionStarted: true })
    const root = mk('root', { taskId: 'same', status: 'READY', kind: 'executable' }), ctx = context([root, original])
    await stepExecute(root, ctx)
    expect(root.status).toBe('ACCEPTED')
    expect(ctx.calls).toEqual([])
    expect(original.status).toBe('CREATED')
  })

  it('关闭时也记录历史,以后开启能去重;再次关闭则允许执行', async () => {
    const root = mk(), ctx = context([root], false)
    await stepStart(root, ctx)
    await stepExecute(root, ctx)
    expect(root.taskPlanningStarted).toBe(true)
    expect(root.taskExecutionStarted).toBe(true)
    root.status = 'CREATED'
    ctx.config.taskDeduplication = true
    ctx.calls.length = 0
    await stepStart(root, ctx)
    expect(root.status).toBe('ACCEPTED')
    expect(ctx.calls).toEqual([])
    ctx.config.taskDeduplication = false
    root.status = 'READY'
    await stepExecute(root, ctx)
    expect(ctx.calls.filter(p => p === 'execute')).toHaveLength(1)
  })

  it('相同对象并发重入直接返回,不会提前完成或中断原任务', async () => {
    const n = mk('root', { kind: 'executable', status: 'READY' }), ctx = context([n])
    const gate = deferred(), entered = deferred(), run = ctx.runAgent
    ctx.runAgent = async req => {
      if (req.phase === 'execute') { entered.resolve(); await gate.promise }
      return run(req)
    }
    const first = stepExecute(n, ctx)
    await entered.promise
    await stepExecute(n, { ...ctx, byId: new Map(ctx.byId) })
    expect(n.status).toBe('EXECUTING')
    gate.resolve()
    await first
    expect(ctx.calls.filter(x => x === 'execute')).toHaveLength(1)
    expect(n.status).toBe('ACCEPTED')
  })

  it('已有执行标记随节点保存,重新进入时不再调用执行者', async () => {
    const n = parseNodeFile(serializeNode(mk('root', { kind: 'executable', status: 'READY', taskExecutionStarted: true })))
    const ctx = context([n])
    await stepExecute(n, ctx)
    expect(ctx.calls).toEqual([])
    expect(n.status).toBe('ACCEPTED')
  })

  it('分析入口的认领同样持久化,重新进入已开始的任务不再分析或拆分', async () => {
    const n = parseNodeFile(serializeNode(mk('root', { taskPlanningStarted: true })))
    const ctx = context([n])
    await stepStart(n, ctx)
    expect(ctx.calls).toEqual([])
    expect(n.status).toBe('ACCEPTED')
    expect(n.childIds).toEqual([])
  })

  it('编排器全过程只执行一个 ID,首个执行者不会被重复节点的成功回执误伤', async () => {
    const root = mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['a', 'b'] })
    const a = mk('a', { taskId: 'same', parentId: 'root', depth: 1 })
    const b = mk('b', { taskId: 'same', parentId: 'root', depth: 1 })
    const ctx = context([root, a, b])
    const orch = new EffTaskOrchestrator(ctx.config, { ...ctx, onUpdate() {}, sharedParallel: true }, ctx.signal, [root, a, b])
    expect((await orch.run()).status).toBe('completed')
    expect(ctx.calls.filter(p => p === 'execute')).toHaveLength(1)
    expect(orch.nodes().filter(n => n.taskDuplicateOf)).toHaveLength(1)
  })
})

describe('手工新增去重', () => {
  it('手工新增与模型派发共享预留,即使手工入口每次返回新的 Map', async () => {
    const root = mk('root', { status: 'ACCEPTED' }), ctx = context([root])
    const scope = addTaskScope(root, ctx.byId, { caps: DEFAULT_CAPS, nodeCount: 1 })
    if (!scope.ok) throw new Error(scope.reason)
    const gate = deferred(), entered = deferred()
    const pending = runAddTask(scope, { title: '唯一任务', prompt: '干活' }, {
      taskDeduplication: true, byId: () => new Map(ctx.byId), now: () => NOW,
      taskIdRule: '按实际任务的名称生成', modelJson: async p => identityReply(p, 'one'),
      persist: async () => { entered.resolve(); await gate.promise },
      onNodes() {}, onProblems() {}, onDone() {},
    }, () => undefined)
    await entered.promise
    expect(await createChildren(root, [{ taskId: 'one', title: '模型也要派', deps: [] }], ctx)).toEqual({ ok: true, added: 0, skipped: ['one'] })
    gate.resolve()
    expect((await pending).ok).toBe(true)
    expect(root.childIds).toHaveLength(1)
  })
  it('重复 ID 在复核、重开父节点、落盘、发布、启动之前返回成功', async () => {
    const root = mk('root', { status: 'ACCEPTED', taskId: 'exists' }), byId = new Map([[root.id, root]])
    const scope = addTaskScope(root, byId, { caps: DEFAULT_CAPS, nodeCount: 1 })
    if (!scope.ok) throw new Error(scope.reason)
    const before = structuredClone(root), forbidden = () => { throw new Error('重复派发不应触发副作用') }
    let done = 0
    const result = await runAddTask(scope, { title: '再来一遍', prompt: '处理之前那个任务' }, {
      taskDeduplication: true, byId: () => byId, now: forbidden, hold: forbidden, reserve: forbidden,
      taskIdRule: '按实际任务的名称生成', modelJson: async p => identityReply(p, 'exists'),
      persist: forbidden, onNodes: forbidden, taskAdded: forbidden, start: forbidden,
      onProblems: p => expect(p).toEqual([]), onDone: () => { done++ },
    }, forbidden)
    expect(result).toEqual({ ok: true, skipped: true, taskId: 'exists' })
    expect(root).toEqual(before)
    expect(done).toBe(1)
  })
})
