/**
 * 手工新增的任务**真的会被跑**。
 *
 * 这一份刻意不断言 `nudge()` 被调过 —— 那种断言在一个 `byId.set` 漏掉的实现上照样绿。
 * 这里真的 `run()` 一趟编排器,然后看那个节点有没有走完自己的七个环节。
 * (这个仓库的教训:「读不等于跑」,以及「真组件真帧 ≠ 真断言」。)
 */
import { describe, expect, it } from 'bun:test'

import { EffTaskOrchestrator } from './orchestrator.js'
import { addTaskScope } from './addTask.js'
import { runAddTask } from './addTaskRun.js'
import { createNode, DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const tick = (ms = 5): Promise<void> => new Promise(r => setTimeout(r, ms))

const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '目标', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})

// 每一份提示词末尾都有一个本次调用的 nonce 标记,回复不带它一律 fail-closed。
const reply = (req: { prompt: string }, body: string): string => {
  const tag = req.prompt.match(/语言标记\(fence info string\)写成 ([a-zA-Z]+)/)?.[1] ?? ''
  return '```' + tag + '\n' + body + '\n```'
}
const LEAF = '{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}'
const TWO_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]}]}'

/**
 * 一个能跑通的假上游,并且**把每一次执行调用的节点 id 记下来** ——
 * 「新任务真的被执行过」只能靠这个观察到。
 */
function upstream(opts: {
  delay?: number
  executed?: string[]
  /**
   * 只有 root 会拆分,别的一律是执行型叶子。
   *
   * **判据按节点走,不按「第几次调用」**:按次序的话,一次「运行中新增」会让新任务
   * 恰好成为第一次 plan 调用,于是它被拆成两个子任务,而断言「它自己被执行过」当场变红 ——
   * 那是夹具的形状,不是功能的行为(实测踩过)。
   */
  leafOnly?: boolean
} = {}) {
  return (async (req: { phase: string; prompt: string; node?: TaskNode }) => {
    if (opts.delay) await tick(opts.delay)
    if (req.phase === 'plan') {
      const decompose = opts.leafOnly !== true && req.node?.id === 'root'
      return reply(req, decompose ? TWO_LEAVES : LEAF)
    }
    if (req.phase === 'execute') {
      if (req.node) opts.executed?.push(req.node.id)
      return reply(req, '{"execStatus":"done"}')
    }
    return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
  }) as unknown as RunAgentFn
}

const mkNode = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: new Date().toISOString(),
  }),
  ...over,
})

describe('taskAdded 之后编排器真的会去跑它', () => {
  it('别的任务还在跑的时候加进来的任务,一样走完执行并 ACCEPTED', async () => {
    const executed: string[] = []
    let nodesNow: TaskNode[] = []
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }),
      {
        runAgent: upstream({ delay: 6, executed }),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: ns => { nodesNow = ns },
      },
      new AbortController().signal,
    )
    const done = orch.run()

    // 等到树长出来、并且至少有一个节点在飞 —— 这就是「运行中」那个场景。
    for (let i = 0; i < 200 && orch.nodes().length < 3; i++) await tick(5)
    expect(orch.nodes().length).toBeGreaterThanOrEqual(3)

    const byId = new Map(orch.nodes().map(n => [n.id, n] as [string, TaskNode]))
    const root = byId.get('root')!
    const scope = addTaskScope(root, byId, {
      caps: DEFAULT_CAPS,
      nodeCount: byId.size,
      inFlight: new Set(orch.runningNodeIds()),
    })
    // root 此刻是 WAITING_CHILDREN(它已经拆完),所以这一次新增必须被接受。
    expect(scope.ok).toBe(true)
    if (scope.ok !== true) return

    const out = await runAddTask(
      scope,
      { title: '临时加的活', prompt: '把 README 里的链接修一下' },
      {
        byId: () => new Map(orch.nodes().map(n => [n.id, n] as [string, TaskNode])),
        now: () => new Date().toISOString(),
        hold: ids => orch.hold(ids),
        reserve: () => orch.reserveOne(),
        persist: async () => {},
        taskAdded: (n, affected) => orch.taskAdded(n, affected),
        onNodes: () => {},
        onProblems: () => {},
        onDone: () => {},
      },
      () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return

    expect((await done).status).toBe('completed')
    // **真的被执行过**,而不是「在树上出现了」。
    expect(executed).toContain(out.node.id)
    const final = orch.nodes().find(n => n.id === out.node.id)
    expect(final?.status).toBe('ACCEPTED')
    // 它的目标就是用户那段话,一个字不拼。
    expect(final?.goal).toBe('把 README 里的链接修一下')
    // 上屏那条路也要真的把它推出去过。
    expect(nodesNow.some(n => n.id === out.node.id)).toBe(true)
  })

  it('root 已经 ACCEPTED 的树上加任务:祖先被重开,新任务照样跑完', async () => {
    const executed: string[] = []
    const root = mkNode('root', {
      title: '根任务', status: 'ACCEPTED', kind: 'decompose', childIds: ['root/01-a'],
    })
    const a = mkNode('root/01-a', {
      title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable',
      execStatus: '干完了',
    })
    const seed = [root, a]
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }),
      {
        runAgent: upstream({ leafOnly: true, executed }),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
      seed,
    )
    const byId = new Map(seed.map(n => [n.id, n] as [string, TaskNode]))
    const scope = addTaskScope(a, byId, { caps: DEFAULT_CAPS, nodeCount: seed.length })
    expect(scope.ok).toBe(true)
    if (scope.ok !== true) return
    // 甲是已验收的执行叶子 → 它自己就是 anchor,而 root 要被重开。
    expect(scope.anchor.id).toBe('root/01-a')
    expect(scope.reopen.map(r => r.id)).toEqual(['root'])

    const out = await runAddTask(
      scope,
      { title: '补一件事', prompt: '补一条超时的测试' },
      {
        byId: () => byId,
        now: () => new Date().toISOString(),
        persist: async () => {},
        onNodes: () => {},
        onProblems: () => {},
        onDone: () => {},
      },
      () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    // 编排器还没起跑 —— 这是结束屏那条路:改完树再 run 一次(startRun 的等价物)。
    const orch2 = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }),
      {
        runAgent: upstream({ leafOnly: true, executed }),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
      [...byId.values(), out.node],
    )
    expect((await orch2.run()).status).toBe('completed')
    expect(executed).toContain(out.node.id)
    void orch
  })

  /**
   * **「不必等别的节点跑完」这条性质本身。**
   *
   * 场景是「没有任何别的东西会完成」:一个卡死在执行环节的节点 + 一个刚加进来的任务。
   * 上一条用例(最终 ACCEPTED)在这件事上说明不了什么 —— 那棵树里别的节点几毫秒就跑完了,
   * 调度循环被那次完成唤醒,顺手把新节点也挑走。这一条把那条捷径堵死。
   *
   * ⚠ **如实记下来:这条用例杀不掉「`taskAdded` 里那句 `nudge()`」的变异**,因为唤醒
   * 今天由 `hold(...).release()` 自带的那一次送达(见 `orchestrator.taskAdded` 的注释:
   * 今天等价、为什么仍然留着)。它钉住的是**用户看得见的那条性质**,不是某一句实现。
   * 别把它读成「nudge 有覆盖」。
   */
  it('别的节点卡着不动时,新任务照样立刻被派出去', async () => {
    let openGate = (): void => {}
    const gate = new Promise<void>(res => { openGate = res })
    const planned: string[] = []
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 3 }),
      {
        runAgent: (async (req: { phase: string; prompt: string; node?: TaskNode }) => {
          if (req.phase === 'plan') {
            planned.push(req.node?.id ?? '?')
            const decompose = req.node?.id === 'root'
            return reply(req, decompose ? TWO_LEAVES : LEAF)
          }
          // 执行环节整个卡住 —— 在 gate 打开之前,树上不会有任何一步完成。
          if (req.phase === 'execute') { await gate; return reply(req, '{"execStatus":"done"}') }
          return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
        }) as unknown as RunAgentFn,
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
    )
    const done = orch.run()
    // 等到有节点真的卡在执行上(那时调度循环正睡在 inFlight 的 race 上)。
    for (let i = 0; i < 400 && !orch.nodes().some(n => n.status === 'EXECUTING'); i++) await tick(5)
    expect(orch.nodes().some(n => n.status === 'EXECUTING')).toBe(true)

    const byId = new Map(orch.nodes().map(n => [n.id, n] as [string, TaskNode]))
    const scope = addTaskScope(byId.get('root')!, byId, {
      caps: DEFAULT_CAPS, nodeCount: byId.size, inFlight: new Set(orch.runningNodeIds()),
    })
    expect(scope.ok).toBe(true)
    if (scope.ok !== true) return
    const out = await runAddTask(
      scope,
      { title: '插进来的活', prompt: '插进来的活' },
      {
        byId: () => new Map(orch.nodes().map(n => [n.id, n] as [string, TaskNode])),
        now: () => new Date().toISOString(),
        hold: ids => orch.hold(ids),
        reserve: () => orch.reserveOne(),
        persist: async () => {},
        taskAdded: (n, affected) => orch.taskAdded(n, affected),
        onNodes: () => {},
        onProblems: () => {},
        onDone: () => {},
      },
      () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return

    // **gate 还关着**,树上一步都没完成过。有 nudge 的话新节点这时已经被派去分析了。
    for (let i = 0; i < 60 && !planned.includes(out.node.id); i++) await tick(5)
    expect(planned).toContain(out.node.id)

    openGate()
    expect((await done).status).toBe('completed')
  })

  it('编排器已经结束时:节点仍然进树、仍然上屏,只是这一轮不再调度它', async () => {
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1 }),
      {
        runAgent: upstream({}),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    const n = mkNode('root/99-late', { parentId: 'root', depth: 1 })
    const r = orch.taskAdded(n, ['root/99-late', 'root'])
    // 落盘已经发生了 —— 早退返回「编排已结束」而不进树,会让这个任务在盘上有、内存里没有。
    expect(r.ok).toBe(false)
    expect(orch.nodes().some(x => x.id === 'root/99-late')).toBe(true)
  })

  it('reserveOne 和 createChildren 共用同一份 maxNodes 预算', async () => {
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1, caps: { ...DEFAULT_CAPS, maxNodes: 1 } }),
      {
        runAgent: upstream({}),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
    )
    // 树上只有 root,而上限是 1 → 一个名额都不该给。
    expect(orch.reserveOne()).toBeNull()
    expect(orch.reservedCount()).toBe(0)
  })

  it('拿到的名额释放之后,预留计数要回到 0', () => {
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1, caps: { ...DEFAULT_CAPS, maxNodes: 10 } }),
      {
        runAgent: upstream({}),
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
    )
    const slot = orch.reserveOne()
    expect(slot).not.toBeNull()
    expect(orch.reservedCount()).toBe(1)
    slot!.release()
    expect(orch.reservedCount()).toBe(0)
  })
})

/**
 * 手工新增的子任务要在**集成验收的证据里**自报家门。
 *
 * 这一关问的是「这些子任务合起来达成父目标了吗」,而用户中途加的那个**不在父节点的方案里**。
 * 不说的话双向都坏:要么父节点因为一个自己从没承诺过的子任务被判不通过,要么圆桌把它当成
 * 父目标的一部分从而放宽判据。
 *
 * ⚠ 这一段此前**全仓零覆盖** —— 剪掉那一行 4269 条全绿(接缝席剪线实测)。
 * 所以这里真的跑一次 integrate,把提示词原文捞出来看。
 */
describe('集成验收的证据', () => {
  it('手工新增的子任务那一行真的会被渲染进提示词', async () => {
    const prompts: string[] = []
    const root = mkNode('root', {
      title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-a', 'root/02-b'],
    })
    const a = mkNode('root/01-a', {
      title: '模型拆的甲', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable',
      execStatus: '干完了',
    })
    const b = mkNode('root/02-b', {
      title: '人加的乙', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable',
      execStatus: '也干完了', manualAdd: { at: '2026-08-17T00:00:00Z', anchorId: 'root' },
    })
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1 }),
      {
        runAgent: (async (req: { phase: string; prompt: string }) => {
          // 集成验收**借用 accept 席位**派发(phase 就是 'accept'),所以判据只能按内容认:
          // 那份提示词里会逐条摆出每个子节点。按 phase==='integrate' 找的话一条都捞不到。
          if (req.prompt.includes('人加的乙')) prompts.push(req.prompt)
          return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
        }) as unknown as RunAgentFn,
        persist: async () => {},
        now: () => new Date().toISOString(),
        onUpdate: () => {},
      },
      new AbortController().signal,
      [root, a, b],
    )
    expect((await orch.run()).status).toBe('completed')
    expect(prompts.length).toBeGreaterThan(0)
    const p = prompts.join('\n')
    expect(p).toContain('人加的乙')
    expect(p).toContain('用户在运行中手工新增')
    // 模型拆出来的那个**不许**带这句话 —— 否则这条证据就没有区分力了。
    const forA = p.slice(p.indexOf('模型拆的甲'), p.indexOf('人加的乙'))
    expect(forA).not.toContain('手工新增')
  })
})
