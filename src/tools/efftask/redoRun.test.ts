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
import type { RedoPlan } from './redo.js'
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
