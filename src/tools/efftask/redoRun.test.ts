/**
 * 「按下确认之后到底发生了什么」—— 每一步都真的调一次,断言顺序和参数。
 *
 * 这一档是回归验收逼出来的:同样的逻辑长在 efftask.tsx 里时,唯一的防线是六条
 * `SRC.toContain(...)` 源码文本断言。验收把每一个被断言的字符串**原样留着**,造了
 * 14 条变异,**全部存活** —— 每一条的后果都是「按下确认之后界面纹丝不动 / 树没落盘 /
 * 工作区一个不放」,而全套测试绿。
 */
import { describe, expect, it } from 'bun:test'

import { runRedo, type RedoRunDeps } from './redoRun.js'
import { phasesOf, type RedoPlan } from './redo.js'
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

const TREE = (): TaskNode[] => [
  node('root', { kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
  node('root/00-a', {
    parentId: 'root', depth: 1, status: 'ACCEPTED',
    worktree: { branch: 'br-a', path: '/wt/a' },
  }),
]

/** 记录每一步**发生了没有、按什么顺序、拿到了什么**。 */
function spy(over: Partial<RedoRunDeps> = {}) {
  const log: string[] = []
  const seen: {
    commitPlan?: RedoPlan; commitBefore?: readonly TaskNode[]
    problems?: string[]; nodes?: TaskNode[]; started?: TaskNode[]
  } = {}
  const deps: RedoRunDeps = {
    async commit(plan, before) {
      log.push('commit')
      seen.commitPlan = plan
      seen.commitBefore = before
      return { problems: [] }
    },
    onProblems(p) { log.push('problems'); seen.problems = p },
    onNodes(n) { log.push('nodes'); seen.nodes = n },
    start(n) { log.push('start'); seen.started = n },
    onDone() { log.push('done') },
    ...over,
  }
  return { deps, log, seen }
}

describe('一次成功的重做', () => {
  it('四步全都发生,而且顺序是 落盘 → 上屏 → 进 state → 重启', async () => {
    const { deps, log } = spy()
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    // 重启排在落盘之后:反过来的话编排器会在一棵还没写下去的树上开跑。
    expect(log).toEqual(['commit', 'problems', 'nodes', 'start'])
  })

  it('交给落盘的 before 是**重做前**的节点', async () => {
    const before = TREE()
    const { deps, seen } = spy()
    await runRedo(before, 'root', 'plan', 'T1', deps)
    // 传成 computed.nodes 的话,被删的 root/00-a 已经不在里面 —— 它的隔离工作区
    // 一个都放不掉,而且不会有任何报错。
    expect(seen.commitBefore?.map(n => n.id)).toEqual(['root', 'root/00-a'])
    expect(seen.commitPlan?.deleted).toEqual(['root/00-a'])
  })

  it('进 state 的和交给编排器的是**同一棵**树', async () => {
    const { deps, seen } = spy()
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    expect(seen.nodes).toBe(seen.started!)
    // 而且是重做**之后**那棵 —— 子树已经不在了。
    expect(seen.started?.map(n => n.id)).toEqual(['root'])
  })

  it('落盘报出来的问题原样上屏', async () => {
    const { deps, seen } = spy({
      async commit() { return { problems: ['甲 的工作区保留在 /wt/a:仍有未合入的提交'] } },
    })
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    expect(seen.problems).toEqual(['甲 的工作区保留在 /wt/a:仍有未合入的提交'])
  })

  it('没有问题时也要交一次空数组 —— 否则上一次的警告一直挂着', async () => {
    const { deps, seen, log } = spy()
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    expect(seen.problems).toEqual([])
    expect(log.filter(l => l === 'problems')).toHaveLength(1)
  })

  it('成功路径上不回 done —— 界面要翻到运行视图', async () => {
    const { deps, log } = spy()
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    expect(log).not.toContain('done')
  })
})

describe('算不出来的时候', () => {
  const badEntry = async (over: Partial<RedoRunDeps> = {}) => {
    const s = spy(over)
    // 叶子没有子任务 → 集成验收重做会被 planRedo 拒绝。
    await runRedo(TREE(), 'root/00-a', 'integrate', 'T1', s.deps)
    return s
  }

  it('盘上一个字节都不动,也不重启编排', async () => {
    const { log } = await badEntry()
    // planRedo 是纯函数,到这一步什么都没发生过 —— 落盘和重启都不能碰。
    expect(log).not.toContain('commit')
    expect(log).not.toContain('start')
    expect(log).not.toContain('nodes')
  })

  it('把原因显示出来,并且回到 done', async () => {
    const { log, seen } = await badEntry()
    expect(seen.problems?.join()).toContain('重做未执行')
    expect(seen.problems?.join()).toContain('没有子任务')
    // 不回 done 的话界面卡在关口上,而关口刚说了这条不可用。
    expect(log).toEqual(['problems', 'done'])
  })

  it('节点不存在时同样只是报错,不是崩溃', async () => {
    const { deps, log, seen } = spy()
    await runRedo(TREE(), '不存在的节点', 'plan', 'T1', deps)
    expect(seen.problems?.join()).toContain('重做未执行')
    expect(log).toEqual(['problems', 'done'])
  })
})

/**
 * 「关口算给你看的」和「真正执行的」必须是**同一次计算**。
 *
 * 验收在这一条上跑出四条**全部存活**的变异:runRedo 不把 ctx 传给 planRedo、applyRedo 不传
 * ctx 给 runRedo、关口的 phases 换回 run 配置、关口干脆不传 phases —— 后两条就是把这次修的
 * bug 原样放回去,而 89 条测试照绿。也就是说这次改动最核心的那条不变量,一条测试都没有。
 */
describe('预演与执行用同一份环节实况', () => {
  const leaf = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...node('x'), kind: 'executable', status: 'ACCEPTED',
    plan: { solution: '干', keyPoints: '', risks: '', acceptance: '' }, ...over,
  })

  it('ctx 真的被传到 planRedo —— 不传的话链条文案会变', async () => {
    // 判据挑的是**看得见的产出差异**:配了测试验证席位时链里有它,不配就没有。
    // ctx 丢在半路的话,执行出来的树和关口预演的那次算的不是一回事。
    const seen: string[][] = []
    const deps = (): RedoRunDeps => ({
      commit: async () => ({ problems: [] }),
      onProblems: () => {}, onNodes: () => {}, start: () => {}, onDone: () => {},
    })
    for (const ctx of [undefined, { seatCount: { verify: 2 as number } }]) {
      const nodes = [leaf()]
      await runRedo(nodes, 'x', 'execute', 'T1', deps(), ctx)
      seen.push(phasesOf('execute', ctx, nodes[0]))
    }
    // 两次 ctx 不同 → 两条链不同。若 runRedo 把 ctx 吞了,下面这条断言仍然成立,
    // 所以真正的判据在下一个用例里。
    expect(seen[0]).not.toEqual(seen[1])
  })

  it('ctx 决定的 disabled 判据,planRedo 也照着拒绝 —— 不是只有屏幕拒绝', async () => {
    /**
     * 这才是「同一份 ctx」真正要防的东西:屏幕上禁用而 planRedo 放行 = 两个真相源。
     * 跳过质疑讨论之后,「从质疑讨论重做」在菜单上是禁用的;planRedo 必须也拒绝。
     */
    const problems: string[][] = []
    const deps: RedoRunDeps = {
      commit: async () => ({ problems: [] }),
      onProblems: p => problems.push(p), onNodes: () => {}, start: () => {}, onDone: () => {},
    }
    await runRedo([leaf()], 'x', 'review', 'T1', deps, { skipSteps: ['review'] })
    expect(problems.flat().join()).toContain('重做未执行')
    expect(problems.flat().join()).toContain('本次配置跳过了质疑讨论')
  })

  it('不传 ctx 时同一次重做是放行的 —— 排除「这条恒拒绝」', async () => {
    let started = 0
    const deps: RedoRunDeps = {
      commit: async () => ({ problems: [] }),
      onProblems: () => {}, onNodes: () => {}, start: () => { started++ }, onDone: () => {},
    }
    await runRedo([leaf()], 'x', 'review', 'T1', deps)
    expect(started).toBe(1)
  })
})

/**
 * 被删掉的子树的**历史运行记录**也要一起走。
 *
 * 用户报的现象:「重做其父任务,但是其子任务的历史运行记录还有,未完全删除掉。」
 * 而它比「屏幕上多几行旧东西」更糟:`childId` 由「父id + 序号 + 标题 slug」算出,
 * 重新拆一次同一个父节点,新子节点的 id 常常和被删的那个**逐字相同** —— 上一轮的输出
 * 会原样挂到新节点的详情页上,而表头写着这一轮的状态。
 */
describe('删掉的节点带走它的实时输出', () => {
  it('拿到的是 plan.deleted,而且发生在换树之前', async () => {
    const dropped: string[][] = []
    const { deps, log } = spy({
      onDropStreams(ids) { log.push('dropStreams'); dropped.push([...ids]) },
    })
    await runRedo(TREE(), 'root', 'plan', 'T1', deps)
    expect(dropped).toEqual([['root/00-a']])
    // 先删流、后换树:反过来的话中间那一帧里,新节点会显示上一轮同名节点的输出。
    expect(log.indexOf('dropStreams')).toBeLessThan(log.indexOf('nodes'))
    // 而且必须在落盘之后 —— 落盘失败时那些记录还有用(problems 会让用户自己去看)。
    expect(log.indexOf('commit')).toBeLessThan(log.indexOf('dropStreams'))
  })

  it('一个节点都没删的重做不去碰它', async () => {
    const { deps, log } = spy({ onDropStreams() { log.push('dropStreams') } })
    // 「重做执行环节」不删任何子节点
    await runRedo(TREE(), 'root/00-a', 'execute', 'T1', deps)
    expect(log).not.toContain('dropStreams')
  })
})
