import { describe, expect, it } from 'bun:test'

import { descendantsOf, planRedo, redoOptions, redoSummary, redoUnavailableReason, type RedoPlan } from './redo.js'
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

describe('redoOptions', () => {
  it('三条永远都在,不可用的带原因 —— 菜单不能忽隐忽现', () => {
    const t = tree()
    const byId = new Map(t.map(n => [n.id, n]))
    const opts = redoOptions(byId.get('a')!, byId)
    expect(opts.map(o => o.entry)).toEqual(['plan', 'execute', 'integrate'])
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

  it('只解开「被牵连」的阻断,自身有判决的祖先不动', () => {
    const t = tree()
    t[1]!.status = 'BLOCKED'; t[1]!.blockedReason = '连续返工超限'
    const r = ok(planRedo(t, 'a1', 'execute', 'T1'))
    expect(r.nodes.find(n => n.id === 'a')!.status).toBe('BLOCKED')
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
    const lines = redoSummary(r, t[2]!, 'execute').join('\n')
    expect(lines).toContain('重新执行')
    // 执行重做不删任何东西、不动任何依赖 —— 摘要里就不该出现这两句。
    expect(lines).not.toContain('删除')
    expect(lines).not.toContain('依赖')
    expect(lines).not.toContain('⚠')
  })
})
