/**
 * 重做一个失败节点时,**多级**被牵连的阻断要一起解开。
 *
 * 用户原话:「某个任务失败掉,其依赖任务变成失败,包括多级依赖。但是将这个任务恢复重做,
 * 其多级依赖任务还是失败状态,没有恢复正常状态。」
 *
 * 阻断是 `orchestrator.propagateBlocked` 的不动点扫出来的(父→子、子→父、依赖→依赖方,
 * 反复扫到稳定),而恢复原来只有一句「谁的 deps 里有 target 就解开谁」。这个文件里的每一棵
 * 树都是照 `propagateBlocked` 的规则手推出来的**阻断后**形态,断言的是「重做之后谁回队列、
 * 谁必须继续留红」。
 *
 * 每一条测试都各自解释它守的是哪一种写错法 —— 因为这里最容易写出的两个错误方向正好相反:
 * 放得太少(用户报的那个现象),和放得太多(把一个上游还挂着 / 孩子真死了的节点也放回队列,
 * 白烧调用,而树上写着「排队中」)。
 */
import { describe, expect, it } from 'bun:test'

import { planForcePass, planRedo, planSkip, reopenPropagatedBlocks, type RedoPlan } from './redo.js'
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

/** 一个「方案被评审员放行过」的节点 —— 决定它重开后落在 READY 还是 CREATED。 */
const reviewed = (id: string, over: Partial<TaskNode> = {}): TaskNode => node(id, {
  reviewLog: [{ round: 1, verdicts: [], synthesized: { pass: true, blockingSummary: '' } }],
  ...over,
})

const ok = (r: RedoPlan | { error: string }): RedoPlan => {
  if ('error' in r) throw new Error(`期望成功,拿到错误: ${r.error}`)
  return r
}
const byId = (nodes: readonly TaskNode[]): Map<string, TaskNode> => new Map(nodes.map(n => [n.id, n]))
const at = (plan: RedoPlan, id: string): TaskNode => {
  const n = plan.nodes.find(x => x.id === id)
  if (!n) throw new Error(`节点不见了: ${id}`)
  return n
}

/**
 * A 真失败,B 依赖 A,C 依赖 B,B 还有一棵子树。
 *
 * `propagateBlocked` 扫完就是这个样子:root「子节点阻断」、B/C「依赖阻断」、
 * B1「上级任务阻断」。
 */
function chain(): TaskNode[] {
  return [
    node('root', { kind: 'decompose', childIds: ['A', 'B', 'C'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
    reviewed('A', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败: 上游报错', failedAt: 'EXECUTING', depth: 1 }),
    reviewed('B', {
      parentId: 'root', deps: ['A'], kind: 'decompose', childIds: ['B1'],
      status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1,
    }),
    reviewed('B1', { parentId: 'B', status: 'BLOCKED', blockedReason: '上级任务阻断', depth: 2 }),
    reviewed('C', { parentId: 'root', deps: ['B'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
  ]
}

describe('重做失败节点 → 多级被牵连的阻断一起恢复', () => {
  it('A←B←C 三级 + B 的子树,全部回到可推进状态', () => {
    /**
     * 这条就是用户报的那个现象。原来的一级循环只会解开 B(它的 deps 里有 A),
     * C 和 B1 留在 BLOCKED —— 而调度器拒绝挑选任何祖先被阻断的节点,所以重做完
     * **一次模型调用都不会发生**。
     */
    const t = chain()
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'A').status).not.toBe('BLOCKED')
    for (const id of ['B', 'B1', 'C']) {
      expect(at(plan, id).status).not.toBe('BLOCKED')
      expect(at(plan, id).blockedReason).toBe('')
    }
    // 落点按形态定:有子任务的等孩子,叶子回 READY(方案已被放行过)。
    expect(at(plan, 'B').status).toBe('WAITING_CHILDREN')
    expect(at(plan, 'B1').status).toBe('READY')
    expect(at(plan, 'C').status).toBe('READY')
  })

  it('父子互撑的那棵树也能恢复 —— 「把现有阻断往回侵蚀」在这里会一个都放不出来', () => {
    /**
     * 评审用脚本跑过这条:`parentBlocked` 和 `childBlocked` 互为逆命题,只要链上出现
     * 任何一组父子,「重算一遍还成不成立」的判据就让两者互相支撑,`reopened` 恒为空。
     * 而「依赖任务被拆成子任务」是这个功能的常态形态。
     */
    const t = [
      node('root', { kind: 'decompose', childIds: ['P1', 'P2'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
      node('P1', { parentId: 'root', kind: 'decompose', childIds: ['A'], status: 'BLOCKED', blockedReason: '子节点阻断', depth: 1 }),
      reviewed('A', { parentId: 'P1', status: 'BLOCKED', blockedReason: '验收未通过', failedAt: 'ACCEPTANCE', depth: 2 }),
      node('P2', { parentId: 'root', kind: 'decompose', childIds: ['B'], status: 'BLOCKED', blockedReason: '子节点阻断', depth: 1 }),
      reviewed('B', { parentId: 'P2', deps: ['A'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 2 }),
    ]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'B').status).toBe('READY')
    expect(at(plan, 'P2').status).toBe('WAITING_CHILDREN')
  })

  it('上游还真的挂着的,**继续挡住**下游', () => {
    /**
     * 不动点最容易写错的另一半。D 是它**自己**失败的(理由不是被牵连的那三种),
     * E 在等 D —— 重做另一条链上的 A 不该把 E 放回队列,否则一个上游产出根本不存在的
     * 节点会带着写工具跑起来,而树上写着「排队中」。
     */
    const t = [
      ...chain(),
      reviewed('D', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败: 编译不过', failedAt: 'EXECUTING', depth: 1 }),
      reviewed('E', { parentId: 'root', deps: ['D'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
    ]
    t[0]!.childIds = ['A', 'B', 'C', 'D', 'E']
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'B').status).toBe('WAITING_CHILDREN')
    // D 自己的判决不动,E 跟着继续挡住。
    expect(at(plan, 'D').status).toBe('BLOCKED')
    expect(at(plan, 'D').blockedReason).toBe('执行失败: 编译不过')
    expect(at(plan, 'E').status).toBe('BLOCKED')
    expect(at(plan, 'E').blockedReason).toBe('依赖阻断')
  })

  it('一个孩子真死了的父节点,以及它下面被牵连的兄弟,留红', () => {
    /**
     * P 的孩子 C1 是自己失败的 → P 永远达不成 `childrenAllAccepted`。把 P 放回
     * WAITING_CHILDREN、把它的另一个孩子 C2 放回队列,只会白烧一轮调用,而屏幕上
     * 那棵子树看起来「在跑」。所以死亡沿子→父也要传一层。
     */
    const t = [
      node('root', { kind: 'decompose', childIds: ['A', 'P'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
      reviewed('A', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败', failedAt: 'EXECUTING', depth: 1 }),
      node('P', { parentId: 'root', kind: 'decompose', childIds: ['C1', 'C2'], status: 'BLOCKED', blockedReason: '子节点阻断', depth: 1 }),
      reviewed('C1', { parentId: 'P', status: 'BLOCKED', blockedReason: '方案评审未通过', failedAt: 'PLAN_REVIEW', depth: 2 }),
      reviewed('C2', { parentId: 'P', status: 'BLOCKED', blockedReason: '上级任务阻断', depth: 2 }),
    ]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'P').status).toBe('BLOCKED')
    expect(at(plan, 'C2').status).toBe('BLOCKED')
  })

  it('结构性阻断不被复活', () => {
    // 「这棵树自己对不上」不是「某个环节失败了」。复活它只会让一批上游无法核实的工作跑起来。
    const t = [
      node('root', { kind: 'decompose', childIds: ['A', 'X'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
      reviewed('A', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败', failedAt: 'EXECUTING', depth: 1 }),
      reviewed('X', { parentId: 'root', deps: ['ghost'], status: 'BLOCKED', blockedReason: '依赖节点缺失', depth: 1 }),
    ]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'X').status).toBe('BLOCKED')
    expect(at(plan, 'X').blockedReason).toBe('依赖节点缺失')
  })

  it('理由被写成「依赖阻断」但依赖已经不在盘上的,也不放 —— 它永远推不动', () => {
    /**
     * `propagateBlocked` 的 `if (!n.blockedReason)` 意味着一个先被写成「依赖阻断」、
     * 之后那个依赖才从盘上消失的节点,理由会停在「依赖阻断」上。只看理由的话它长得
     * 像「被牵连」,而 `depsSatisfied` 对一个不存在的依赖永远为假。
     */
    const t = [
      node('root', { kind: 'decompose', childIds: ['A', 'Y'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
      reviewed('A', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败', failedAt: 'EXECUTING', depth: 1 }),
      reviewed('Y', { parentId: 'root', deps: ['ghost'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
    ]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'Y').status).toBe('BLOCKED')
  })

  it('放开时把过期的痕迹一起清掉 —— failedAt / interrupted / capBlocked / startedAt', () => {
    /**
     * 每一个都实测过后果:过期的 `failedAt` 让 `R`/`s` 在一个「其实是别人挂了」的节点上
     * 放行;留着 `startedAt` 的节点在树上显示 `172800s` 并每秒往上跳;带着 `capBlocked`
     * 的节点会拿到一条不对症的补救建议。
     */
    const t = chain()
    const b = t.find(n => n.id === 'B')!
    b.failedAt = 'EXECUTING'
    b.interrupted = true
    b.capBlocked = true
    b.capCategory = 'infra'
    b.startedAt = 'T-2days'
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    const after = at(plan, 'B')
    expect(after.failedAt).toBeUndefined()
    expect(after.interrupted).toBe(false)
    expect(after.capBlocked).toBe(false)
    expect(after.capCategory).toBeUndefined()
    expect(after.startedAt).toBeUndefined()
    expect(after.updatedAt).toBe('T1')
  })

  it('方案从来没被放行过、又没干过活的叶子回 CREATED,不回 READY', () => {
    /**
     * `stepStart` 在评审圆桌**之前**就把 kind 写成 executable(评审是为了打回它),
     * 所以「方案三次被否」或者「跳过质疑讨论后坐回 CREATED」的节点身上 kind 已经是
     * executable。放到 READY = 带写工具的执行者去跑一份没有任何评审员看过的方案。
     */
    const t = chain()
    const c = t.find(n => n.id === 'C')!
    c.reviewLog = []
    expect(c.execStatus).toBe('')
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'C').status).toBe('CREATED')
  })

  it('方案**被否过三次**的节点回 CREATED —— 判据是「有一轮通过过」,不是「有记录」', () => {
    /**
     * 这是 `seatForPropagated` docstring 点名要挡的那一类,而它此前**没有探针**:
     * 上一条用例给的是 `reviewLog = []`(空),而把判据从
     * `some(r => r.synthesized.pass)` 换成 `reviewLog.length > 0` 之后它照样绿 ——
     * 变异测试实测存活。
     *
     * 真正危险的形态正是这一种:`stepStart` 在评审圆桌**之前**就把 kind 写成 executable,
     * 所以一个「方案三次被评审员一致否掉」的节点身上 reviewLog 非空、kind 已是 executable。
     * 落到 READY = `advanceableKind` 判 'execute' = 带写工具的执行者去跑一份评审员刚刚
     * 一致否掉的方案。
     */
    const t = chain()
    const c = t.find(n => n.id === 'C')!
    c.reviewLog = [1, 2, 3].map(round => ({
      round, verdicts: [], synthesized: { pass: false, blockingSummary: '缺回滚方案' },
    }))
    expect(c.execStatus).toBe('')
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'C').status).toBe('CREATED')
  })

  it('质疑讨论被跳过、但已经干过一轮活的节点仍然回 READY', () => {
    /**
     * 判据不能只看 `reviewLog`:整个 run 可以跳过质疑讨论(`skipSteps`),`s` 也能跳过
     * 一次 —— 那种节点的 reviewLog 是空的,而它确确实实执行过。只看 reviewLog 会把它
     * 打回 CREATED 重新分析,白烧一次调用,还把它已经写下的方案覆盖掉。
     */
    const t = chain()
    const c = t.find(n => n.id === 'C')!
    c.reviewLog = []
    c.execStatus = '改了 src/login.ts'
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'C').status).toBe('READY')
  })

  it('跳过失败环节 / 强制通过 两条路同样会连带恢复', () => {
    // 三条路共用 reseatForRerun,漏掉任何一条的后果都是「操作完了一次模型调用都不会发生」。
    const skipTree = chain()
    skipTree.find(n => n.id === 'A')!.failedAt = 'ACCEPTANCE'
    const skipped = ok(planSkip(skipTree, 'A', 'T1'))
    expect(skipped.nodes.find(n => n.id === 'C')!.status).toBe('READY')

    const passTree = chain()
    passTree.find(n => n.id === 'A')!.failedAt = 'ACCEPTANCE'
    const passed = ok(planForcePass(passTree, 'A', 'T1'))
    expect(passed.nodes.find(n => n.id === 'C')!.status).toBe('READY')
  })

  it('子节点已经不在盘上的父节点不放 —— 它永远达不成 childrenAllAccepted', () => {
    /**
     * `propagateBlocked` 的理由优先级里 `childBlocked` 赢过 `childMissing`,所以一个
     * 「既有被阻断的孩子、又有丢失的孩子」的父节点理由会停在「子节点阻断」上 ——
     * 看起来像被牵连。放开它只会让它在下一轮死锁扫描里再阻断一次。
     */
    const t = [
      node('root', { kind: 'decompose', childIds: ['A', 'P'], status: 'BLOCKED', blockedReason: '子节点阻断' }),
      reviewed('A', { parentId: 'root', status: 'BLOCKED', blockedReason: '执行失败', failedAt: 'EXECUTING', depth: 1 }),
      node('P', {
        parentId: 'root', kind: 'decompose', childIds: ['ghost'],
        status: 'BLOCKED', blockedReason: '子节点阻断', depth: 1,
      }),
    ]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'P').status).toBe('BLOCKED')
  })

  it('验收开过会的节点也算「过了方案这道门」', () => {
    // 判据是三条 or:reviewLog 通过过 / 执行过 / 验收开过会。第三条此前没有探针。
    const t = chain()
    const c = t.find(n => n.id === 'C')!
    c.reviewLog = []
    c.acceptLog = [{ round: 1, verdicts: [], synthesized: { pass: false, blockingSummary: '缺用例' } }]
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    expect(at(plan, 'C').status).toBe('READY')
  })

  it('一次性的手工标记不许跨过一次阻断活下来', () => {
    /**
     * `blockWithReason` 对节点**自己的**每一次失败都清 `skipPhase`(理由记在那里:
     * 按 s 跳过验收 → 打回 → 中断 → 恢复后 `enterAtJudge` 再一次为真 → 执行环节一次都
     * 不跑,半成品被判「已验收」)。而被牵连的阻断走 `propagateBlocked`,**不经过**
     * blockWithReason —— 这三个标记会原样活到下一次重开,而一个带着 `redoFrom='review'`
     * 被恢复到 CREATED 的节点会跳过分析,屏幕上什么都没说。
     */
    const t = chain()
    const c = t.find(n => n.id === 'C')!
    c.skipPhase = 'accept'
    c.forcePass = 'verify'
    c.redoFrom = 'review'
    const plan = ok(planRedo(t, 'A', 'execute', 'T1'))
    const after = at(plan, 'C')
    expect(after.skipPhase).toBeUndefined()
    expect(after.forcePass).toBeUndefined()
    expect(after.redoFrom).toBeUndefined()
  })

  it('警告里说出连带了几个 —— 用户看不见的连带效果不能不说', () => {
    const plan = ok(planRedo(chain(), 'A', 'execute', 'T1'))
    expect(plan.warnings.some(w => w.includes('连带恢复了 3 个'))).toBe(true)
  })
})

describe('reopenPropagatedBlocks(纯函数)', () => {
  it('没有任何真失败时,全部被牵连的阻断都放开', () => {
    const nodes = [
      node('root', { kind: 'decompose', childIds: ['a', 'b'], status: 'WAITING_CHILDREN' }),
      reviewed('a', { parentId: 'root', status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
      reviewed('b', { parentId: 'root', deps: ['a'], status: 'BLOCKED', blockedReason: '依赖阻断', depth: 1 }),
    ]
    expect(reopenPropagatedBlocks(byId(nodes), 'T9').sort()).toEqual(['a', 'b'])
  })

  it('不碰非 BLOCKED 的节点,也不碰 ACCEPTED', () => {
    const nodes = [
      node('root', { kind: 'decompose', childIds: ['a'], status: 'ACCEPTED' }),
      reviewed('a', { parentId: 'root', status: 'ACCEPTED', depth: 1 }),
    ]
    expect(reopenPropagatedBlocks(byId(nodes), 'T9')).toEqual([])
    expect(nodes[0]!.status).toBe('ACCEPTED')
  })

  it('中止扫描留下的「已中断」不算被牵连 —— 那是 --resume 的地盘', () => {
    /**
     * `propagateBlocked(aborted)` 把每一个非终态节点扫成 BLOCKED + `已中断`,而
     * 「哪些节点该被重开」在那条路上是 `reseat` 按 `interrupted` 标记决定的。
     * 在这里顺手复活它们会绕过 reseat 的耗尽检查和落点三条规则。
     */
    const nodes = [
      node('root', { kind: 'decompose', childIds: ['a'], status: 'BLOCKED', blockedReason: '已中断', interrupted: true }),
      reviewed('a', { parentId: 'root', status: 'BLOCKED', blockedReason: '已中断', interrupted: true, depth: 1 }),
    ]
    expect(reopenPropagatedBlocks(byId(nodes), 'T9')).toEqual([])
  })

  it('依赖成环也不会让它转不出来', () => {
    // 盘上的 deps 是可手工编辑的,一个自指/成环的图不能让这个函数死循环 ——
    // 它跑在按键处理里,死循环 = 终端整个卡死。
    const nodes = [
      reviewed('a', { deps: ['b'], status: 'BLOCKED', blockedReason: '依赖阻断' }),
      reviewed('b', { deps: ['a'], status: 'BLOCKED', blockedReason: '依赖阻断' }),
    ]
    expect(reopenPropagatedBlocks(byId(nodes), 'T9').sort()).toEqual(['a', 'b'])
  })
})
