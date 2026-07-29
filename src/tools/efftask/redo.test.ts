import { describe, expect, it } from 'bun:test'

import {
  descendantsOf, phaseChainText, phaseRuns, phasesOf, planRedo, redoContextOf, redoOptions,
  redoSummary, redoUnavailableReason, type RedoPlan,
} from './redo.js'
import { PHASE_NAMES, type NodeKind, type NodeStatus, type TaskNode } from './types.js'

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id, title: id, goal: `目标 ${id}`, parentId: null, childIds: [], deps: [],
    kind: 'executable' as NodeKind, status: 'CREATED' as NodeStatus,
    phaseRoles: Object.fromEntries(PHASE_NAMES.map(p => [p, []])) as TaskNode['phaseRoles'],
    plan: { solution: '', keyPoints: '', risks: '', acceptance: '' },
    execStatus: '', blockedReason: '', reviewLog: [], acceptLog: [], score: {},
    iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    depth: 0, createdAt: 'T0', updatedAt: 'T0',
    ...over,
  }
}

/** root ─┬─ a ─── a1     b 依赖 a1 */
function tree(): TaskNode[] {
  return [
    node('root', { kind: 'decompose', childIds: ['a', 'b'], status: 'WAITING_CHILDREN' }),
    node('a', { parentId: 'root', kind: 'decompose', childIds: ['a1'], status: 'WAITING_CHILDREN', depth: 1 }),
    node('a1', { parentId: 'a', status: 'ACCEPTED', depth: 2, worktree: { branch: 'br-a1', path: '/wt/a1' } }),
    node('b', { parentId: 'root', deps: ['a1'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
  ]
}

const ok = (r: RedoPlan | { error: string }): RedoPlan => {
  if ('error' in r) throw new Error(`期望成功,拿到错误: ${r.error}`)
  return r
}

describe('任务重做要认被删子树的账', () => {
  /**
   * 用户按 `r` 的那一刻,正是他最想知道「我为这个错误付了多少」的时刻。而任务重做把整棵
   * 子树从内存和盘上一起删掉,`runUsage` 逐个累加还活着的节点 —— 验收实测一次重做让表头
   * 的总数当场掉了 83%,当着他的面倒退,而 README 写的是「重做不清零,钱花掉了就是花掉了」。
   *
   * 少报的**正好是被丢弃的那部分工作**,也就是他最该看见的那个数。
   */
  const u = (calls: number, input: number) => ({ calls, input, output: 0, cacheRead: 0, cacheWrite: 0 })
  /** 每个节点都花过钱的那棵树。 */
  function paid(): TaskNode[] {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    byId.get('root')!.usage = u(4, 1000)
    byId.get('a')!.usage = u(6, 2000)
    byId.get('a1')!.usage = u(10, 5000)
    byId.get('b')!.usage = u(3, 500)
    return t
  }
  const runTotal = (nodes: TaskNode[]): number =>
    nodes.reduce((n, x) => n + (x.usage?.calls ?? 0) + (x.discardedUsage?.calls ?? 0), 0)

  it('删掉的子树记进重做目标的 discardedUsage,整趟合计不倒退', () => {
    const before = paid()
    expect(runTotal(before)).toBe(23)
    const r = ok(planRedo(before, 'a', 'plan', 'T1'))
    expect(r.deleted).toEqual(['a1'])
    const after = r.nodes
    const target = after.find(n => n.id === 'a')!
    // a1 那 10 次调用记到了 a 头上,而不是凭空消失。
    expect(target.discardedUsage?.calls).toBe(10)
    expect(target.discardedUsage?.input).toBe(5000)
    // 节点自己那一份**不清零** —— 钱是真花过的。
    expect(target.usage?.calls).toBe(6)
    expect(runTotal(after)).toBe(23)
  })

  it('阶段重做什么都不删,自然也不记 —— 两者代价差着数量级', () => {
    const r = ok(planRedo(paid(), 'a1', 'execute', 'T1'))
    expect(r.deleted).toEqual([])
    expect(r.nodes.find(n => n.id === 'a1')!.discardedUsage).toBeUndefined()
  })

  it('重做两次,第二次把第一次的欠账一起往上带', () => {
    // 不带的话,一棵被重做过的子树再被上层重做时,前一轮的账会在这一步丢掉。
    const t = paid()
    const byId = new Map(t.map(n => [n.id, n]))
    byId.get('a')!.discardedUsage = u(7, 300)
    const r = ok(planRedo(t, 'root', 'plan', 'T1'))
    const target = r.nodes.find(n => n.id === 'root')!
    // a 自己的 6 + a 已欠的 7 + a1 的 10 + b 的 3 = 26
    expect(target.discardedUsage?.calls).toBe(26)
  })
})

describe('redoOptions', () => {
  it('七个环节永远都在,不可用的带原因 —— 菜单不能忽隐忽现', () => {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const opts = redoOptions(byId.get('a')!, byId)
    // 次序和 PHASE_NAMES 一致:屏幕上的次序,和用户在名册、跳过设置、节点详情的
    // 环节耗时里看到的次序,必须是同一个。
    expect(opts.map(o => o.entry)).toEqual(PHASE_NAMES)
  })

  it('分析归第一级(任务重做),其余六条归第二级(阶段重做)', () => {
    // 任务重做会删整棵子树,而阶段重做只重跑一个环节 —— 代价差着数量级,
    // 并排放在同一张单子上时选错一行的后果完全不同。
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const opts = redoOptions(byId.get('a')!, byId)
    expect(opts.filter(o => o.scope === 'task').map(o => o.entry)).toEqual(['plan'])
    expect(opts.filter(o => o.scope === 'phase').map(o => o.entry))
      .toEqual(['review', 'execute', 'verify', 'accept', 'integrate', 'observer'])
  })

  it('测试验证 / 验收 / 观察永远禁用,而且给出能照做的下一步', () => {
    // 它们跑在别的 step 内部,没有自己的入口。只说「不可用」是半句话 ——
    // 用户想重跑的那件事通常还是做得到的,只是入口在别处。
    const n = node('x', { kind: 'executable', childIds: [] })
    const opts = redoOptions(n, new Map([['x', n]]), { seatCount: { verify: 3, observer: 3 } })
    for (const entry of ['verify', 'accept', 'observer'] as const) {
      const o = opts.find(x => x.entry === entry)!
      expect(`${entry}:${o.disabled ? 'disabled' : 'ENABLED'}`).toBe(`${entry}:disabled`)
      expect(o.disabled).toContain('从执行重做')
    }
  })

  it('禁用理由指的那一条,在同一个节点上必须是**按得动的**', () => {
    /**
     * 第一版无条件写「请选『从执行重做』」,而拆分任务上那一条本身就是禁用的 ——
     * 用户被指到一行按不动的字上,而且「验收跑在执行环节内部」对拆分任务本来就是错的:
     * 它自己的裁决是集成验收。
     */
    const dec = node('p', { kind: 'decompose', childIds: ['p/00-a'] })
    const kid = node('p/00-a', { parentId: 'p' })
    const byId = new Map([[dec.id, dec], [kid.id, kid]])
    const opts = redoOptions(dec, byId)
    const enabled = new Set(opts.filter(o => !o.disabled).map(o => o.label))
    for (const entry of ['verify', 'accept', 'observer'] as const) {
      const why = opts.find(x => x.entry === entry)!.disabled!
      // 理由里点名的那个条目(如果点名了),必须在这个节点上是可用的。
      const named = [...enabled].find(l => why.includes(l))
      const namedAny = opts.map(o => o.label).find(l => why.includes(l))
      expect(`${entry}: 点名了「${namedAny ?? '(没点名)'}」,它可用吗 = ${named !== undefined || namedAny === undefined}`)
        .toBe(`${entry}: 点名了「${namedAny ?? '(没点名)'}」,它可用吗 = true`)
    }
  })

  it('质疑讨论重做:没有方案就按不动', () => {
    // 空方案上重跑评审 = 让评审员对着空白发表意见。
    const empty = node('x', { kind: 'executable' })
    expect(redoOptions(empty, new Map([['x', empty]])).find(o => o.entry === 'review')!.disabled)
      .toContain('还没有方案')
    const planned = node('y', { kind: 'executable', plan: { solution: '这么干', keyPoints: '', risks: '', acceptance: '' } })
    expect(redoOptions(planned, new Map([['y', planned]])).find(o => o.entry === 'review')!.disabled)
      .toBeUndefined()
  })

  it('入口环节自己被跳过时,从它重做按不动', () => {
    /**
     * 只看「整条链是不是空的」不够:跳过质疑讨论之后,「从质疑讨论重做」的链上还剩
     * 执行那一段 —— 链非空、条目可用,而用户按下去得到的是一次执行重做。
     * 条目叫什么名字,那个环节就必须发生。
     */
    const planned = node('y', { kind: 'executable', plan: { solution: '这么干', keyPoints: '', risks: '', acceptance: '' } })
    const o = redoOptions(planned, new Map([['y', planned]]), { skipSteps: ['review'] }).find(x => x.entry === 'review')!
    expect(o.disabled).toContain('本次配置跳过了质疑讨论')
  })

  it('拆分任务不给「执行重做」—— 它自己没有执行环节', () => {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const exec = redoOptions(byId.get('a')!, byId).find(o => o.entry === 'execute')!
    expect(exec.disabled).toContain('拆分任务')
  })

  it('叶子不给「集成验收重做」', () => {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const integ = redoOptions(byId.get('a1')!, byId).find(o => o.entry === 'integrate')!
    expect(integ.disabled).toContain('没有子任务')
  })

  it('kind 说自己是 decompose 但还没有子任务,也算拆分任务', () => {
    // stepStart 在评审**之前**就写 kind。一个自称 decompose、评审被打回、childIds 还空着
    // 的节点,如果按 childIds.length 判,就会拿到「执行重做」并被交给带写工具的执行者。
    const n = node('x', { kind: 'decompose' })
    const exec = redoOptions(n, new Map([['x', n]])).find(o => o.entry === 'execute')!
    expect(exec.disabled).toBeTruthy()
  })

  it('删除数量和已验收数量都写进说明 —— 这是唯一不可逆的动作', () => {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const plan = redoOptions(byId.get('a')!, byId).find(o => o.entry === 'plan')!
    expect(plan.detail).toContain('1 个子任务')
    expect(plan.detail).toContain('1 个已验收')
  })
})

describe('descendantsOf', () => {
  it('递归收集,不止一层', () => {
    const t = [
      node('r', { childIds: ['a'] }),
      node('a', { parentId: 'r', childIds: ['b'] }),
      node('b', { parentId: 'a', childIds: ['c'] }),
      node('c', { parentId: 'b' }),
    ]
    const byId = new Map(t.map(n => [n.id, n]))
    expect(descendantsOf(byId.get('r')!, byId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('childIds 成环时不死循环 —— 这段跑在按键处理里', () => {
    const t = [node('a', { childIds: ['b'] }), node('b', { parentId: 'a', childIds: ['a'] })]
    const byId = new Map(t.map(n => [n.id, n]))
    expect(descendantsOf(byId.get('a')!, byId)).toEqual(['b'])
  })
})

describe('planRedo:方案重做', () => {
  it('删掉整棵子树,父节点退回 CREATED 且 kind 归零', () => {
    const r = ok(planRedo(tree(), 'a', 'plan', 'T1'))
    expect(r.deleted).toEqual(['a1'])
    expect(r.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'root'])
    const a = r.nodes.find(n => n.id === 'a')!
    expect(a.status).toBe('CREATED')
    expect(a.childIds).toEqual([])
    // kind 留着 decompose 的话,advanceableKind 会照旧路由;留着 executable 更糟 ——
    // 一个原本要拆分的节点被直接交给带写工具的执行者。
    expect(a.kind).toBe('unknown')
  })

  it('子树外的依赖改指到被重做的节点,而不是被删掉', () => {
    const r = ok(planRedo(tree(), 'a', 'plan', 'T1'))
    const b = r.nodes.find(n => n.id === 'b')!
    // 直接删依赖的话 b 会立刻起跑,而它要的东西所在的子树还没重建出来。
    expect(b.deps).toEqual(['a'])
    expect(r.dependencyRewrites).toEqual([{ nodeId: 'b', from: 'a1', to: 'a' }])
  })

  it('已合入集成分支的子任务:说清楚删任务不等于回滚提交', () => {
    const r = ok(planRedo(tree(), 'a', 'plan', 'T1'))
    expect(r.warnings.join()).toContain('不会回滚')
  })

  it('被删子任务的隔离工作区要交回给调用方释放', () => {
    const r = ok(planRedo(tree(), 'a', 'plan', 'T1'))
    expect(r.worktreesToRelease).toEqual([{ nodeId: 'a1', branch: 'br-a1', path: '/wt/a1' }])
  })

  it('上一轮确认过的子任务清单必须清掉,否则重新拆分会照抄它', () => {
    const t = tree()
    t[1]!.confirmedDraft = { children: [{ title: '老子任务', deps: [] }] }
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.confirmedDraft).toBeUndefined()
  })

  it('迭代预算全部清零 —— 退回 CREATED 的节点要重走 方案→评审→执行→验收', () => {
    const t = tree()
    t[1]!.iteration = { planReview: 3, acceptance: 3, integration: 3, scoring: 3, mergeResolve: 3 }
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.iteration)
      .toEqual({ planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 })
  })

  it('目标节点自己依赖某个后代时,那条依赖是删掉而不是变成自依赖', () => {
    const t = tree()
    t[1]!.deps = ['a1']
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    // 自依赖不是依赖,是死锁 —— 调度器会永远等它自己。
    expect(r.nodes.find(n => n.id === 'a')!.deps).toEqual([])
  })

  it('改指会成环时,那条依赖是删掉 —— 死锁比早起跑严重得多', () => {
    // 构造:P(=a)自己依赖 Y(=b),而 Y 依赖 P 的子节点 a1。
    // 天真地把 Y 的 a1 改指到 a,就得到 a↔b 互指 —— pickBatch 从此返回空,
    // 而重做**之前** b 是能跑的。这是重做自己造出来的死锁。
    const t = tree()
    t[1]!.deps = ['b']
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    const b = r.nodes.find(n => n.id === 'b')!
    expect(b.deps).toEqual([])
    expect(r.warnings.join()).toContain('成环')
    expect(r.dependencyRewrites[0]!.to).toContain('成环')
  })

  it('隔着一跳的环也要认出来', () => {
    // a → x → b,而 b 依赖 a 的子节点 a1。只看一跳的话这个环认不出来,
    // 改指后 a→x→b→a 闭合,pickBatch 返回空,整棵树死在那儿。
    const t = tree()
    t[1]!.deps = ['x']
    t.push(node('x', { parentId: 'root', deps: ['b'], depth: 1 }))
    t[0]!.childIds = ['a', 'b', 'x']
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.nodes.find(n => n.id === 'b')!.deps).toEqual([])
    expect(r.warnings.join()).toContain('成环')
  })
  it('不成环时照常改指,别为了保险把所有依赖都删了', () => {
    const r = ok(planRedo(tree(), 'a', 'plan', 'T1'))
    expect(r.nodes.find(n => n.id === 'b')!.deps).toEqual(['a'])
    expect(r.warnings.join()).not.toContain('成环')
  })
  it('没有子任务的叶子也能从方案重做', () => {
    const r = ok(planRedo(tree(), 'a1', 'plan', 'T1'))
    expect(r.deleted).toEqual([])
    expect(r.nodes.find(n => n.id === 'a1')!.status).toBe('CREATED')
  })

  it('根任务也能重做 —— 整棵树重来', () => {
    const r = ok(planRedo(tree(), 'root', 'plan', 'T1'))
    expect(r.nodes.map(n => n.id)).toEqual(['root'])
    expect(r.deleted.sort()).toEqual(['a', 'a1', 'b'])
  })
})

describe('planRedo:执行重做', () => {
  it('退回 READY,方案原样保留', () => {
    const t = tree()
    t[2]!.plan = { ...t[2]!.plan, solution: '原方案' }
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    const a1 = r.nodes.find(n => n.id === 'a1')!
    expect(a1.status).toBe('READY')
    expect(a1.plan.solution).toBe('原方案')
  })

  it('验收记录保留 —— 它是返工提示词的反馈来源', () => {
    const t = tree()
    t[2]!.acceptLog = [{ round: 1 } as never]
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    // 清掉等于让执行者从零开始猜,那是**提高**恢复成本。
    expect(r.nodes.find(n => n.id === 'a1')!.acceptLog).toHaveLength(1)
  })

  it('execStatus 上补一句「工作区已重置」', () => {
    const t = tree()
    t[2]!.execStatus = '我实现了 feature.ts'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    // 不加这句,执行者会去找一个已经不在那儿的文件。
    expect(r.nodes.find(n => n.id === 'a1')!.execStatus).toContain('重置为集成分支最新状态')
  })

  it('那句注记不重复叠加', () => {
    const t = tree()
    t[2]!.execStatus = '产出'
    const once = ok(planRedo(t, 'a1', 'execute', 'T1'))
    const twice = ok(planRedo(once.nodes, 'a1', 'execute', 'T2'))
    const s = twice.nodes.find(n => n.id === 'a1')!.execStatus
    expect(s.split('重置为集成分支最新状态')).toHaveLength(2)
  })

  it('execStatus 本来是空的就不凭空造一行', () => {
    const r = ok(planRedo(tree(), 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'a1')!.execStatus).toBe('')
  })

  it('验收预算清零 —— 不清的话节点会立刻被「预算已耗尽」再挡回去', () => {
    const t = tree()
    t[2]!.iteration = { planReview: 2, acceptance: 3, integration: 0, scoring: 3, mergeResolve: 2 }
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    // 方案预算**不动**:这次重做没打算重新分析,那一格的花费是真花过的。
    expect(r.nodes.find(n => n.id === 'a1')!.iteration)
      .toEqual({ planReview: 2, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 })
  })

  it('拆分任务拒绝执行重做', () => {
    const r = planRedo(tree(), 'a', 'execute', 'T1')
    expect('error' in r && r.error).toContain('拆分任务')
  })

  it('子任务一个都不动', () => {
    const r = ok(planRedo(tree(), 'a1', 'execute', 'T1'))
    expect(r.deleted).toEqual([])
    expect(r.nodes).toHaveLength(4)
  })
})

describe('planRedo:集成验收重做', () => {
  it('退回 WAITING_CHILDREN,子任务全部保留', () => {
    const r = ok(planRedo(tree(), 'a', 'integrate', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.status).toBe('WAITING_CHILDREN')
    expect(r.deleted).toEqual([])
    expect(r.nodes).toHaveLength(4)
  })

  it('只清集成和评分预算,不动方案/验收预算', () => {
    const t = tree()
    t[1]!.iteration = { planReview: 2, acceptance: 2, integration: 3, scoring: 3, mergeResolve: 1 }
    const r = ok(planRedo(t, 'a', 'integrate', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.iteration)
      .toEqual({ planReview: 2, acceptance: 2, integration: 0, scoring: 0, mergeResolve: 1 })
  })

  it('还有子任务没验收通过时,说明这次裁决不会立刻发生', () => {
    const t = tree()
    t[2]!.status = 'READY'
    const r = ok(planRedo(t, 'a', 'integrate', 'T1'))
    expect(r.warnings.join()).toContain('没有验收通过')
  })

  it('叶子拒绝集成验收重做', () => {
    const r = planRedo(tree(), 'a1', 'integrate', 'T1')
    expect('error' in r && r.error).toContain('没有子任务')
  })
})

describe('planRedo:共通清理', () => {
  it('阻断痕迹全部清干净,否则树上照旧渲染成失败', () => {
    const t = tree()
    Object.assign(t[2]!, {
      status: 'BLOCKED', blockedReason: '连续返工超限', interrupted: true,
      capBlocked: true, capCategory: 'rework', mergeConflict: true, startedAt: 'T-old',
    })
    const a1 = ok(planRedo(t, 'a1', 'execute', 'T1')).nodes.find(n => n.id === 'a1')!
    expect(a1.blockedReason).toBe('')
    expect(a1.interrupted).toBe(false)
    expect(a1.capBlocked).toBe(false)
    expect(a1.capCategory).toBeUndefined()
    expect(a1.mergeConflict).toBe(false)
    // 留着 startedAt 的话,面板会拿它减出跨越终端关闭那整段时间的耗时。
    expect(a1.startedAt).toBeUndefined()
  })

  it('祖先链上被牵连的阻断要一并解开,否则这个座位够不到', () => {
    const t = tree()
    t[0]!.status = 'BLOCKED'; t[0]!.blockedReason = '子节点阻断'
    t[1]!.status = 'BLOCKED'; t[1]!.blockedReason = '子节点阻断'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    // 调度器拒绝挑选任何祖先被阻断的节点 —— 不解开这条链,重做一次模型调用都不会发生。
    expect(r.nodes.find(n => n.id === 'root')!.status).toBe('WAITING_CHILDREN')
    expect(r.nodes.find(n => n.id === 'a')!.status).toBe('WAITING_CHILDREN')
  })

  it('自身有判决的祖先也要重开 —— 不然这次重做够不到座位', () => {
    // 这条原来断言的是相反的行为(「自身有判决的祖先不动」),那个假设是错的:
    // 调度器拒绝挑选任何祖先被阻断的节点,所以留着 = 重做一次模型调用都不会发生。
    // 祖先那条判决本来也是对**旧子树**下的,子任务重做之后它不再成立。
    const t = tree()
    t[1]!.status = 'BLOCKED'; t[1]!.blockedReason = '连续返工超限'
    t[1]!.iteration = { ...t[1]!.iteration, integration: 3 }
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    const a = r.nodes.find(n => n.id === 'a')!
    expect(a.status).toBe('WAITING_CHILDREN')
    // 集成预算也要给回去,否则一重开就立刻再耗尽 = 等于没重开。
    expect(a.iteration.integration).toBe(0)
    expect(r.reopenedAncestors).toContain('a')
  })

  it('已验收的祖先也要重开 —— 这是这个功能最常见的失效场景', () => {
    // orchestrator.run() 的**第一句**是 `if (root.status === 'ACCEPTED') return completed`。
    // 跑成功的 run 上重做任何非 root 节点:子树已经从盘上删了,而重启的编排器立刻返回,
    // 模型调用 0 次,界面闪回「✓ 高效任务完成」。实测过,而且 --resume / --retry-blocked
    // 都救不回来 —— 它们只碰 BLOCKED 节点。
    const t = tree()
    t[0]!.status = 'ACCEPTED'
    t[1]!.status = 'ACCEPTED'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'root')!.status).toBe('WAITING_CHILDREN')
    expect(r.reopenedAncestors.sort()).toEqual(['a', 'root'])
    // 而且要说出来:每个被重开的祖先都会再花一次集成验收的模型调用。
    expect(r.warnings.join()).toContain('重新做一次集成验收')
  })

  it('结构性损坏的祖先**不能**重开', () => {
    // 「依赖节点缺失 / 子节点缺失 / 依赖成环」不是「某个环节失败了」,是这棵树自己对不上。
    // 重开只会让一批上游无法核实的工作跑起来,而运行报告成功。--retry-blocked 同样拒绝。
    const t = tree()
    t[1]!.status = 'BLOCKED'; t[1]!.blockedReason = '子节点缺失(a2)'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.status).toBe('BLOCKED')
    expect(r.reopenedAncestors).toEqual([])
  })

  it('已经在可推进状态的祖先原样不动 —— 别顺手清掉它的预算', () => {
    const t = tree()
    t[1]!.iteration = { ...t[1]!.iteration, integration: 2 }
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    const a = r.nodes.find(n => n.id === 'a')!
    expect(a.status).toBe('WAITING_CHILDREN')
    expect(a.iteration.integration).toBe(2)
    expect(r.reopenedAncestors).toEqual([])
  })

  it('等着它的兄弟也解开', () => {
    // b 因为 a1 挂了而被 propagateBlocked 写成「依赖阻断」;a1 重做后这条理由就不成立了。
    const r = ok(planRedo(tree(), 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'b')!.status).not.toBe('BLOCKED')
  })

  it('parentId 成环时不死循环', () => {
    const t = [
      node('a', { parentId: 'b', status: 'BLOCKED', blockedReason: '子节点阻断' }),
      node('b', { parentId: 'a', status: 'BLOCKED', blockedReason: '子节点阻断' }),
    ]
    expect(ok(planRedo(t, 'a', 'execute', 'T1')).nodes).toHaveLength(2)
  })

  it('不改传进来的数组', () => {
    const t = tree()
    const before = JSON.stringify(t)
    planRedo(t, 'a', 'plan', 'T1')
    // 关口要先把摘要渲染给用户看再决定执行 —— 计算过程改了原树的话,取消就取消不掉了。
    expect(JSON.stringify(t)).toBe(before)
  })

  it('节点不存在时给错误而不是抛异常', () => {
    const r = planRedo(tree(), '不存在', 'plan', 'T1')
    expect('error' in r && r.error).toContain('不存在')
  })
})

describe('目标节点自己的隔离工作区', () => {
  it('执行重做要释放它,并且把 node.worktree 清掉', () => {
    /**
     * 不清的话屏幕说了一件不真的事:execStatus 刚被补上「隔离工作区已重置为集成分支
     * 最新状态」,而 stepExecute 的 `ctx.worktrees && !node.worktree` 因为 worktree
     * 还在而**短路** —— 执行者在上一轮留下的**脏工作区**里重跑,池里同时泄漏一个。
     */
    const r = ok(planRedo(tree(), 'a1', 'execute', 'T1'))
    expect(r.worktreesToRelease).toEqual([{ nodeId: 'a1', branch: 'br-a1', path: '/wt/a1' }])
    expect(r.nodes.find(n => n.id === 'a1')!.worktree).toBeUndefined()
  })

  it('方案重做也一样 —— 叶子从方案重来时同样要放掉', () => {
    // 原来只有「被删子任务」的工作区被覆盖到,目标节点自己那个没人守。
    const r = ok(planRedo(tree(), 'a1', 'plan', 'T1'))
    expect(r.worktreesToRelease.map(w => w.nodeId)).toEqual(['a1'])
    expect(r.nodes.find(n => n.id === 'a1')!.worktree).toBeUndefined()
  })

  it('本来就没有工作区时不凭空造一条释放请求', () => {
    const t = tree()
    t[2]!.worktree = undefined
    expect(ok(planRedo(t, 'a1', 'execute', 'T1')).worktreesToRelease).toEqual([])
  })
})

describe('方案重做要归还的一次性额度', () => {
  it('revised 清掉 —— 否则补救拆分那次机会拿不回来', () => {
    // pipeline.ts 的 `if (node.revised === true) return {kind:'no'}` 是一次性的。
    // 方案重做后再撞上 planReview 上限时,本该重新给的补救拆分直接没有了,节点阻断。
    const t = tree()
    t[1]!.revised = true
    expect(ok(planRedo(t, 'a', 'plan', 'T1')).nodes.find(n => n.id === 'a')!.revised).toBeUndefined()
  })
})

describe('被牵连的三种阻断理由,一个都不能少', () => {
  /**
   * PROPAGATED 现在只管**下游**那一侧(祖先走 reopenAncestor,它不看理由)。
   *
   * 三个字符串里原来只有一个被测到。少任何一个的后果都一样:那个在等目标节点的
   * 下游任务留在 BLOCKED 上,而它的阻断理由说的是**别人**的失败 —— 目标重做完之后
   * 它永远等不到调度,树上一直渲染着一条早就不成立的「✗」。
   */
  for (const reason of ['子节点阻断', '上级任务阻断', '依赖阻断']) {
    it(`等着它的下游写着「${reason}」时要解开`, () => {
      const t = tree()
      t[3]!.status = 'BLOCKED'
      t[3]!.blockedReason = reason
      const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
      expect(r.nodes.find(n => n.id === 'b')!.status).not.toBe('BLOCKED')
    })
  }

  it('下游自己有判决时不动它 —— 那不是被牵连', () => {
    const t = tree()
    t[3]!.status = 'BLOCKED'
    t[3]!.blockedReason = '连续返工超限'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'b')!.status).toBe('BLOCKED')
  })
})

describe('验收查出来的计数与判据', () => {
  it('已验收子节点即使 worktree 已经清掉,也要警告代码已经落进代码', () => {
    // 原判据是 `ACCEPTED && worktree !== undefined`,方向反的:干净合并之后
    // stepExecute 就把 worktree 置回 undefined,--resume 每次也清它。于是这条警告
    // 只在「release 拒绝删的脏工作区」时出现 —— 那恰恰是**没有**干净合并的那一类。
    const t = tree()
    t[2]!.worktree = undefined // 干净合并后的真实形态
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.warnings.join()).toContain('已经落进代码')
  })

  it('childIds 里指向不存在节点的条目不计入「要删掉的子任务」', () => {
    // 这个数字是用户判断这次不可逆操作值不值得的唯一依据,不能虚高。
    const t = tree()
    t[1]!.childIds = ['a1', '幽灵']
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.deleted).toEqual(['a1'])
  })

  it('重复的依赖只算一条改写', () => {
    const t = tree()
    t[3]!.deps = ['a1', 'a1']
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    expect(r.dependencyRewrites).toHaveLength(1)
    expect(r.nodes.find(n => n.id === 'b')!.deps).toEqual(['a'])
  })

  it('摘要把「改写」和「移除」分开说 —— 两者后果不同', () => {
    // 改写 = 下游继续等;移除 = 下游可能提前起跑。混成一句「N 条依赖被改写为指向
    // 本节点」的话,被移除的那些也被算成改写,而用户据此以为下游还会等。
    const t = tree()
    t[1]!.deps = ['a1'] // 目标自己依赖后代 → 会被移除
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    const lines = redoSummary(r, t[1]!, 'plan').join('\n')
    expect(lines).toContain('1 条依赖被改写为指向本节点') // b → a
    expect(lines).toContain('1 条依赖被移除')
  })

  it('kind 停在 executable 但已经有子任务的节点,不给「执行重做」', () => {
    // isDecomposed 的 `childIds.length > 0` 这半个条件删掉后全套照绿(变异验证过),
    // 而实测后果是:一个挂着子任务、kind 还停在 executable 的节点会被摆到 READY,
    // 交给带写工具的执行者 —— 正是这个模块开头点名要防的那件事。
    const n = node('p', { kind: 'executable', childIds: ['p/00-x'] })
    const exec = redoOptions(n, new Map([['p', n]])).find(o => o.entry === 'execute')!
    expect(exec.disabled).toContain('拆分任务')
  })
})

describe('环节实况:屏幕上那句话必须是真的', () => {
  it('默认配置(没配验证角色)下,测试验证根本不跑 —— 就不能写它会跑', () => {
    // 测试验证是 opt-in(phaseRoles.verify.length > 0),而 emptyPhaseRoles() 给的默认是
    // 0 席。大多数用户不配角色,所以原来那句无条件的「执行 → 测试验证 → 验收」
    // 对大多数用户就是假的。
    expect(phaseChainText('execute', {})).toBe('执行 → 验收;不跑:测试验证、观察(未配置角色,这些环节不存在)')
  })

  it('配了验证角色就三步都写', () => {
    expect(phaseChainText('execute', { seatCount: { verify: 2, observer: 1 } })).toBe('执行 → 测试验证 → 验收 → 观察')
  })

  it('skipSteps 跳过的环节,原因和「没配角色」要分开说', () => {
    // 两种原因的补救办法完全不同:一个是去配角色,一个是去掉 skipSteps。
    const t = phaseChainText('execute', { seatCount: { verify: 1, observer: 1 }, skipSteps: ['accept'] })
    expect(t).toContain('验收(本次配置跳过)')
    expect(t).not.toContain('未配置角色')
  })

  it('全被跳光时说清楚没有任何环节会跑', () => {
    const t = phaseChainText('execute', { skipSteps: ['execute', 'accept'] })
    expect(t).toContain('没有任何环节会跑')
  })

  it('accept 没配席位不算不存在 —— 它会回落到别的席位,照样发生', () => {
    // 把「0 席 = 不发生」写成通用规则的话,没配验收角色的 run 会被告知不做验收,
    // 而它其实是做的。只有 verify 有「没配就整个不存在」这个性质。
    expect(phaseChainText('execute', { seatCount: { accept: 0, verify: 1, observer: 1 } })).toBe('执行 → 测试验证 → 验收 → 观察')
  })

  it('方案重做的链条也照实算', () => {
    expect(phasesOf('plan', { seatCount: { verify: 1 } }))
      .toEqual(['plan', 'review', 'execute', 'verify', 'accept'])
    expect(phasesOf('plan', {})).toEqual(['plan', 'review', 'execute', 'accept'])
  })

  it('集成验收就一个环节', () => {
    expect(phasesOf('integrate', {})).toEqual(['integrate'])
  })

  it('观察和测试验证一样是 opt-in —— 没配席位就整个不存在', () => {
    // scoreNode 的第一句判据就是 seats.length === 0 → return false。把「0 席 = 不发生」
    // 写成通用规则的话,没配验收角色的 run 会被告知不做验收,而它其实是做的。
    expect(phaseRuns('observer', {})).toBe(false)
    expect(phaseRuns('observer', { seatCount: { observer: 1 } })).toBe(true)
    expect(phaseRuns('accept', {})).toBe(true)
  })

  it('两种「不跑」的理由分组写,不是一个环节一个括号', () => {
    // 链从 3 条长到 6 条之后逐条写就是同一句理由印两遍,而这一行本来就已经在 80 列上折行。
    const t = phaseChainText('plan', { skipSteps: ['review'] })
    expect(t).toContain('质疑讨论(本次配置跳过)')
    expect(t).toContain('测试验证、观察(未配置角色,这些环节不存在)')
  })

  it('质疑讨论重做**不止**跑一个环节 —— 通过之后还会往下走', () => {
    /**
     * 第一版把这条链写成 `['review']`,而那是一句假话:stepStart 的 reviewOnly 分支
     * 通过之后走的是普通路由 —— 执行型节点 commit(READY),调度器接着分派 stepExecute。
     * 实测真实链条是质疑讨论 → 执行 → 验收(→ 测试验证/观察,配了席位的话)。
     * 代价少报一个数量级。
     */
    const leaf = node('x', { kind: 'executable' })
    expect(phasesOf('review', {}, leaf)).toEqual(['review', 'execute', 'accept'])
    // 拆分型节点通过之后是「等子任务」→ 集成验收,不碰代码。
    const dec = node('p', { kind: 'decompose', childIds: ['p/00-a'] })
    expect(phasesOf('review', {}, dec)).toEqual(['review', 'integrate'])
  })

  it('不传节点时按**更贵**的那一条算 —— 宁可高报不可低报', () => {
    expect(phasesOf('review', {})).toEqual(['review', 'execute', 'accept'])
  })

  it('不能单独重入的三个,链是空的', () => {
    for (const p of ['verify', 'accept', 'observer'] as const) {
      expect(`${p}:${phasesOf(p, { seatCount: { verify: 9, observer: 9 } }).join()}`).toBe(`${p}:`)
    }
  })
})

describe('redoUnavailableReason', () => {
  it('没中断就没理由', () => {
    expect(redoUnavailableReason({ aborted: false, runId: '004' })).toBeUndefined()
  })

  it('中断过的 run 给出能照做的下一步,并带上 run id', () => {
    // 不挡的话:按 r → 选环节 → 看后果 → 确认 → 编排器在第一个循环里就走中断分支,
    // 返回同一屏同一句「已中断」,一次模型调用都没有,也没有任何东西解释为什么。
    const why = redoUnavailableReason({ aborted: true, runId: '004' })!
    expect(why).toContain('/et --resume 004')
  })

  it('没有 run id 时给占位符而不是 undefined 拼进命令里', () => {
    expect(redoUnavailableReason({ aborted: true })).toContain('<run id>')
    expect(redoUnavailableReason({ aborted: true, runId: '' })).toContain('<run id>')
  })
})

describe('redoSummary', () => {
  it('把删除、依赖改写、工作区释放和警告全摊开', () => {
    const t = tree()
    const r = ok(planRedo(t, 'a', 'plan', 'T1'))
    const lines = redoSummary(r, t[1]!, 'plan').join('\n')
    expect(lines).toContain('删除 1 个子任务')
    expect(lines).toContain('1 条依赖')
    expect(lines).toContain('释放 1 个隔离工作区')
    expect(lines).toContain('⚠')
  })

  it('没发生的事不渲染成条目', () => {
    const t = tree()
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    const lines = redoSummary(r, t[2]!, 'execute', { seatCount: { verify: 1 } }).join('\n')
    expect(lines).toContain('执行 → 测试验证 → 验收')
    // 执行重做不删任何东西、不动任何依赖 —— 摘要里就不该出现这两句。
    expect(lines).not.toContain('删除')
    expect(lines).not.toContain('依赖')
    expect(lines).not.toContain('⚠')
  })
})

/**
 * 席位来源。
 *
 * 这一段是崩溃那条的正面:`Object.fromEntries(PHASE_NAMES.map(…))` 原来就地长在
 * efftask.tsx 的 JSX 里,而 `PHASE_NAMES` **没有被导入** —— 仓库没有 typecheck,
 * 于是它一路过了打包,按下 r 就是一屏 ReferenceError。搬进来不只是为了修那一行,
 * 更是为了让「席位从哪儿取」这件事有接缝可测 —— 而它取错了地方。
 */
describe('redoContextOf', () => {
  it('席位从**目标节点**上取,不是从 run 配置上取', () => {
    /**
     * applyRosterToNodes 的第一句是 `if (n.status === 'ACCEPTED') continue`,而重做目标
     * 绝大多数正是 ACCEPTED 节点。resume 时新加一个测试验证席位:run 配置上有了,
     * 那个节点上没有 —— 而真正决定环节跑不跑的是 pipeline 里读的 node.phaseRoles.verify。
     * 拿 config 去算的话,关口会承诺一个这个节点上根本不存在的环节。
     */
    const n = node('x', {
      status: 'ACCEPTED',
      phaseRoles: { ...Object.fromEntries(PHASE_NAMES.map(p => [p, []])), verify: [] } as TaskNode['phaseRoles'],
    })
    expect(redoContextOf(n).seatCount?.verify).toBe(0)
    expect(phaseChainText('execute', redoContextOf(n))).toContain('测试验证')
    expect(phaseChainText('execute', redoContextOf(n))).toContain('未配置角色')
  })

  it('节点上真的有席位时就照实算', () => {
    const seat = { roleTag: 'v', roleName: '测试员' } as unknown as TaskNode['phaseRoles']['verify'][number]
    const n = node('x', {
      phaseRoles: { ...Object.fromEntries(PHASE_NAMES.map(p => [p, []])), verify: [seat] } as TaskNode['phaseRoles'],
    })
    expect(redoContextOf(n).seatCount?.verify).toBe(1)
    expect(phaseChainText('execute', redoContextOf(n))).toContain('执行 → 测试验证 → 验收')
  })

  it('skipSteps 从 run 配置来 —— 那本来就是 run 级的', () => {
    const n = node('x')
    expect(redoContextOf(n, { skipSteps: ['accept'] }).skipSteps).toEqual(['accept'])
  })

  it('phaseRoles 整个缺失(手改过的 node.md)也不抛', () => {
    const broken = { ...node('x'), phaseRoles: undefined } as unknown as TaskNode
    expect(redoContextOf(broken).seatCount?.execute).toBe(0)
  })
})

describe('从「质疑讨论」重做', () => {
  const planned = (over: Partial<TaskNode> = {}): TaskNode => node('x', {
    plan: { solution: '这么干', keyPoints: '', risks: '', acceptance: '' },
    status: 'ACCEPTED', ...over,
  })

  it('写下一次性的重入标记 —— CREATED 这一个座位对应两个起点,光靠 status 分不开', () => {
    const p = ok(planRedo([planned()], 'x', 'review', 'T1'))
    const t = p.nodes.find(n => n.id === 'x')!
    expect(t.redoFrom).toBe('review')
    expect(t.status).toBe('CREATED')
  })

  it('拆分型节点上,方案、子任务、工作区一律不动 —— 这一条不碰代码', () => {
    const parent = planned({ kind: 'decompose', childIds: ['x/00-k'], worktree: { branch: 'b', path: '/wt/x' } })
    const kid = node('x/00-k', { parentId: 'x', status: 'ACCEPTED' })
    const p = ok(planRedo([parent, kid], 'x', 'review', 'T1'))
    const t = p.nodes.find(n => n.id === 'x')!
    expect(t.plan.solution).toBe('这么干')
    expect(t.childIds).toEqual(['x/00-k'])
    expect(t.worktree).toEqual({ branch: 'b', path: '/wt/x' })
    expect(p.deleted).toEqual([])
    expect(p.worktreesToRelease).toEqual([])
  })

  it('**拆分型**节点不写重做注记 —— 它通过之后走集成验收,不碰代码', () => {
    const dec = planned({ kind: 'decompose', childIds: ['x/00-k'], execStatus: '我改了 a.ts' })
    const kid = node('x/00-k', { parentId: 'x', status: 'ACCEPTED' })
    const p = ok(planRedo([dec, kid], 'x', 'review', 'T1'))
    expect(p.nodes.find(n => n.id === 'x')!.execStatus).toBe('我改了 a.ts')
    expect(p.worktreesToRelease).toEqual([])
  })

  it('**执行型**节点要写重做注记、要放工作区 —— 它通过之后会被交给执行者重跑', () => {
    /**
     * stepStart 的 reviewOnly 分支通过之后 commit(READY),调度器接着分派 stepExecute:
     * 工作区被重新 acquire、执行者重跑。不做这套重置的话 execStatus 里还写着
     * 「我实现了 feature.ts」而没有任何注记,执行者会在一棵已经有产出的树上从零重做。
     */
    const leaf = planned({ kind: 'executable', execStatus: '我改了 a.ts', worktree: { branch: 'b', path: '/wt/x' } })
    const p = ok(planRedo([leaf], 'x', 'review', 'T1'))
    const t = p.nodes.find(n => n.id === 'x')!
    expect(t.execStatus).toContain('本节点被手工重做')
    expect(t.worktree).toBeUndefined()
    expect(p.worktreesToRelease).toEqual([{ nodeId: 'x', branch: 'b', path: '/wt/x' }])
  })

  it('清掉启动关口的确认稿 —— 用户要重判的是**现在这份**方案', () => {
    const p = ok(planRedo([planned({ confirmedDraft: { children: [{ title: '旧', deps: [] }] } })], 'x', 'review', 'T1'))
    expect(p.nodes.find(n => n.id === 'x')!.confirmedDraft).toBeUndefined()
  })

  it('评审轮次清零,别的预算不动', () => {
    const p = ok(planRedo([planned({ iteration: { planReview: 3, acceptance: 2, integration: 1, scoring: 1, mergeResolve: 1 } })], 'x', 'review', 'T1'))
    const t = p.nodes.find(n => n.id === 'x')!
    expect(t.iteration).toEqual({ planReview: 0, acceptance: 2, integration: 1, scoring: 1, mergeResolve: 1 })
  })

  it('别的入口会把上一次留下的标记**清掉**', () => {
    // 不清的话,这次「任务重做」会跳过分析 —— 那正是它唯一要做的事。
    const p = ok(planRedo([planned({ redoFrom: 'review' })], 'x', 'execute', 'T1'))
    expect(p.nodes.find(n => n.id === 'x')!.redoFrom).toBeUndefined()
  })
})

describe('重做注记按产出去哪儿了分两种', () => {
  const leaf = (over: Partial<TaskNode> = {}) => node('x', { execStatus: '我实现了 feature.ts', ...over })

  it('已验收的节点:产出已合进集成分支,新工作区里**能看到**它', () => {
    // 原来无条件写「产出在当前工作区里不存在」,而这对 ACCEPTED 节点是假的:
    // 通过验收那一刻 mergeAndRelease 已经把它合进集成分支,而重做后重新 acquire 的
    // 工作区正是基于集成分支 tip 建的。执行者被告知从零开始,却在树里找到自己上一轮的产出。
    const p = ok(planRedo([leaf({ status: 'ACCEPTED' })], 'x', 'execute', 'T1'))
    const s = p.nodes.find(n => n.id === 'x')!.execStatus
    expect(s).toContain('能看到')
    expect(s).toContain('不要从零重做')
  })

  it('没走到验收的节点:产出确实不在了', () => {
    const p = ok(planRedo([leaf({ status: 'BLOCKED', blockedReason: '返工上限' })], 'x', 'execute', 'T1'))
    expect(p.nodes.find(n => n.id === 'x')!.execStatus).toContain('不在')
  })

  it('两种注记只写一次 —— 重做两轮不会叠', () => {
    const once = ok(planRedo([leaf({ status: 'ACCEPTED' })], 'x', 'execute', 'T1'))
    const twice = ok(planRedo(once.nodes, 'x', 'execute', 'T2'))
    const s = twice.nodes.find(n => n.id === 'x')!.execStatus
    expect(s.split('本节点被手工重做')).toHaveLength(2)
  })
})

describe('确认屏要摊开的后果', () => {
  it('已验收的节点会退出终态 —— 本次运行不再算完成', () => {
    // seatedAt 一直算出来了、也一直在返回值里,但一行都没渲染过。用户是在
    // 「✓ 高效任务完成」那一屏上按的 r,他有理由以为这只是加跑一轮。
    const t = node('x', { status: 'ACCEPTED' })
    const p = ok(planRedo([t], 'x', 'execute', 'T1'))
    const lines = redoSummary(p, t, 'execute')
    expect(lines.some(l => l.includes('不再算完成'))).toBe(true)
  })

  it('还没验收的节点不说这句 —— 它本来就没算完成', () => {
    const t = node('x', { status: 'BLOCKED', blockedReason: '返工上限' })
    const p = ok(planRedo([t], 'x', 'execute', 'T1'))
    expect(redoSummary(p, t, 'execute').some(l => l.includes('不再算完成'))).toBe(false)
  })

  it('「释放工作区」要说清脏改动会被固化到 salvage 分支 —— 那不是清理', () => {
    // release 在工作区仍有未提交文件时拒删,下一次 acquire 走复用分支:add -A →
    // commit --no-verify → branch -f efftask/<run>/salvage/… → checkout -B。
    // 用户手改的东西被提交进一条他从没听说过的分支,目录被重置。
    const t = node('x', { status: 'ACCEPTED', worktree: { branch: 'b', path: '/wt/x' } })
    const p = ok(planRedo([t], 'x', 'execute', 'T1'))
    const line = redoSummary(p, t, 'execute').find(l => l.includes('释放'))!
    expect(line).toContain('salvage')
    expect(line).toContain('未提交')
  })

  it('返工额度会重新给 —— 这是这次重做的直接成本', () => {
    const t = node('x')
    const p = ok(planRedo([t], 'x', 'execute', 'T1'))
    expect(redoSummary(p, t, 'execute').some(l => l.includes('返工计数清零'))).toBe(true)
  })
})
