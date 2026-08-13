import { describe, expect, it } from 'bun:test'
import {
  backtrackLines, backtrackScope, composeRedos, levelFor, markBacktracked, outputMissing,
  NO_CONTRIBUTION_NOTE,
} from './backtrack.js'
import { parseNodeFile, serializeNode } from './persistence.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-13T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const integrateFail = (why = '子任务合起来没覆盖导出接口', remedy: string[] = []): TaskNode['acceptLog'][number] => ({
  round: 1,
  step: 'integrate',
  verdicts: remedy.length > 0
    ? [{ role: 'r', pass: false, blocking: [why], comments: '', remedy: remedy.map(t => ({ title: t, deps: [] })) } as never]
    : [],
  synthesized: { pass: false, blockingSummary: why },
})

describe('范围:只收集成验收不过的和产出丢了的', () => {
  const tree = (): TaskNode[] => [
    mk('root', { childIds: ['root/00-a', 'root/01-b', 'root/02-c'], status: 'WAITING_CHILDREN' }),
    mk('root/00-a', { parentId: 'root', status: 'BLOCKED', acceptLog: [integrateFail()] }),
    // 叶子验收失败 —— 不归这个键(有 r/R)。
    mk('root/01-b', {
      parentId: 'root', status: 'BLOCKED',
      acceptLog: [{ round: 1, step: 'accept', verdicts: [], synthesized: { pass: false, blockingSummary: '测试没跑' } }],
    }),
    // 产出丢了:判了通过,而集成分支一个字节都没多。
    mk('root/02-c', { parentId: 'root', status: 'ACCEPTED', execStatus: `做完了\n(注:该节点${NO_CONTRIBUTION_NOTE})` }),
  ]

  it('集成验收不过的收,叶子验收不过的不收', () => {
    const { targets } = backtrackScope(tree(), 'root')
    const ids = targets.map(t => t.node.id).sort()
    expect(ids).toContain('root/00-a')
    expect(ids).toContain('root/02-c')
    expect(ids).not.toContain('root/01-b')
  })

  it('产出丢了那条判据认的是 mergeAndRelease 自己写下的注记', () => {
    expect(outputMissing(mk('x', { status: 'ACCEPTED', execStatus: `(注:该节点${NO_CONTRIBUTION_NOTE})` }))).toBe(true)
    // 还没验收通过的不算 —— 它本来就还没轮到贡献。
    expect(outputMissing(mk('x', { status: 'EXECUTING', execStatus: NO_CONTRIBUTION_NOTE }))).toBe(false)
    expect(outputMissing(mk('x', { status: 'ACCEPTED', execStatus: '一切正常' }))).toBe(false)
  })

  /**
   * `step` 缺席的老记录**谁的历史都不算** —— acceptLog 是测试修复/验收/集成验收共用的,
   * 把一条没有 step 的记录当成集成验收,会把回溯指到错的节点上。
   */
  it('没有 step 的老记录不算集成验收', () => {
    const n = mk('x', {
      status: 'BLOCKED',
      acceptLog: [{ round: 1, verdicts: [], synthesized: { pass: false, blockingSummary: '不行' } }],
    })
    expect(backtrackScope([n], 'x').targets).toEqual([])
  })

  it('把集成验收已经写下来的意见和补救提案带出来 —— 不重新问', () => {
    const n = mk('x', { status: 'BLOCKED', acceptLog: [integrateFail('缺了 API 层', ['补一个 API 层', '补集成测试'])] })
    const t = backtrackScope([n], 'x').targets[0]!
    expect(t.blocking).toBe('缺了 API 层')
    expect(t.remedy).toEqual(['补一个 API 层', '补集成测试'])
  })

  /**
   * 保守名单**不收「已验收但工作区已不在」** —— 那正是按过 `c` 键之后的正常状态,
   * 收进来会把一大片健康的子树重执行一遍。
   */
  it('保守名单只收没验收通过的和产出丢了的子任务', () => {
    const nodes = [
      mk('p', { childIds: ['p/a', 'p/b', 'p/c'], status: 'BLOCKED', acceptLog: [integrateFail()] }),
      mk('p/a', { parentId: 'p', status: 'BLOCKED' }),
      mk('p/b', { parentId: 'p', status: 'ACCEPTED' }),              // 健康,工作区清过了
      mk('p/c', { parentId: 'p', status: 'ACCEPTED', execStatus: NO_CONTRIBUTION_NOTE }),
    ]
    expect(backtrackScope(nodes, 'p').targets[0]!.suspects.sort()).toEqual(['p/a', 'p/c'])
  })
})

describe('阶梯', () => {
  it('没回溯过 → 第 1 级;回溯过 → 第 2 级', () => {
    expect(levelFor(mk('x'))).toBe(1)
    expect(levelFor(mk('x', { backtrack: { rounds: 1, at: NOW } }))).toBe(2)
    expect(levelFor(mk('x', { backtrack: { rounds: 5, at: NOW } }))).toBe(2)
  })

  /**
   * **轮次计数必须能被 `--resume` 读回。**
   *
   * 这个仓库为「只写不读的字段在第一次恢复时清零」付过三次账。这里清零的后果是阶梯
   * **悄悄退回第 1 级**,而屏幕上写着第 2 级 —— 用户会以为已经用过最贵的手段了。
   */
  it('落盘再读回来,轮次还在', () => {
    const n = mk('x', { backtrack: { rounds: 2, at: NOW } })
    const back = parseNodeFile(serializeNode(n))
    expect(back.backtrack).toEqual({ rounds: 2, at: NOW })
    expect(levelFor(back)).toBe(2)
  })

  it('markBacktracked 累加轮次', () => {
    const n = mk('x', { backtrack: { rounds: 1, at: '早先' } })
    const plan = { nodes: [n], deleted: [], dependencyRewrites: [], worktreesToRelease: [], seatedAt: 'READY' as const, reopenedAncestors: [], warnings: [] }
    markBacktracked(plan, [{ node: n, level: 2, blocking: '', remedy: [], suspects: [] }], NOW)
    expect(n.backtrack).toEqual({ rounds: 2, at: NOW })
  })

  /**
   * 第 2 级要**解开 `revised` 闩** —— 它默认「每个节点一辈子只补救一次」,而这个闩正是
   * 这次人工干预要解开的东西:让编排器自己那条已经测过的 `reviseDecomposition` 能在下一轮
   * 集成验收里用真 ctx 把补救子任务长出来。
   */
  it('第 2 级重新武装补救拆分,第 1 级不动它', () => {
    const a = mk('a', { revised: true })
    const b = mk('b', { revised: true })
    const plan = { nodes: [a, b], deleted: [], dependencyRewrites: [], worktreesToRelease: [], seatedAt: 'READY' as const, reopenedAncestors: [], warnings: [] }
    const { rearmed } = markBacktracked(plan, [
      { node: a, level: 2, blocking: '', remedy: [], suspects: [] },
      { node: b, level: 1, blocking: '', remedy: [], suspects: [] },
    ], NOW)
    expect(rearmed).toEqual(['a'])
    expect(a.revised).toBe(false)
    expect(b.revised).toBe(true)
  })
})

/**
 * **N 个节点合成一个 RedoPlan** —— 评审说这里最可能错,而且两种错法全套测试都能绿。
 */
describe('composeRedos', () => {
  /**
   * 祖先是 **ACCEPTED**,而不是 WAITING_CHILDREN —— 这是真实场景:一整趟跑完了、
   * root 已验收,用户在结束屏上按 `b`。
   *
   * 这个区别不是摆设:`reopenAncestor` 对非 BLOCKED 非 ACCEPTED 的祖先**早退**,
   * 所以拿 WAITING_CHILDREN 当夹具时 `reopenedAncestors` 恒空 —— 下面那条并集断言
   * 就变成了一条证明不了任何事的用例(第一版就是这么写的)。
   */
  const tree = (): TaskNode[] => [
    mk('root', { childIds: ['root/00-a', 'root/01-b'], status: 'ACCEPTED', kind: 'decompose' }),
    mk('root/00-a', {
      parentId: 'root', status: 'ACCEPTED', kind: 'executable',
      worktree: { branch: 'b-a', path: '/wt/a' },
    }),
    mk('root/01-b', {
      parentId: 'root', status: 'ACCEPTED', kind: 'executable',
      worktree: { branch: 'b-b', path: '/wt/b' },
    }),
  ]

  /**
   * **错法一:对同一份 nodes 调 N 次 → 只回溯了一个。**
   * 这一条断言两个节点在**同一棵**返回的树上都被重置了。
   */
  it('两个节点都真的被重置了(不是只有最后一个)', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: 'root/01-b', entry: 'execute' },
    ], NOW)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    for (const id of ['root/00-a', 'root/01-b']) {
      const n = r.nodes.find(x => x.id === id)!
      expect(n.status).not.toBe('ACCEPTED')
    }
  })

  /**
   * **错法二:串起来喂 → side-lists 只剩最后一次的。**
   *
   * `resetForExecute` 把 worktree 推进的是**本次调用的** `worktreesToRelease`,而真正删目录
   * 的人照着的正是那张表 —— 少了并集,N-1 个工作区一个都不删,而用户第 2、4 条要的
   * 「删 target、重新同步」对它们静默不发生。
   */
  it('worktreesToRelease 取并集 —— 每个节点的工作区都要在表里', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: 'root/01-b', entry: 'execute' },
    ], NOW)
    if ('error' in r) throw new Error(r.error)
    expect(r.worktreesToRelease.map(w => w.nodeId).sort()).toEqual(['root/00-a', 'root/01-b'])
  })

  /**
   * `reopenAncestor` 对非 BLOCKED 非 ACCEPTED 早退 → 第 2..N 次的 `reopenedAncestors`
   * **恒空**。取并集才能保住第一次那条 —— 而扣押集少了共同祖先,调度循环当场可以把它
   * 派去集成验收。
   */
  it('reopenedAncestors 取并集 —— 第一次放开的祖先不会被后面几次丢掉', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: 'root/01-b', entry: 'execute' },
    ], NOW)
    if ('error' in r) throw new Error(r.error)
    expect(r.reopenedAncestors).toContain('root')
  })

  /**
   * **定序。** 顺序来自模型返回的数组,而 `reopenPropagatedBlocks` 是全树不动点 ——
   * 同一份名单换个顺序会得到不同的树,那是不可测的。
   */
  it('名单顺序不影响结果', () => {
    const a = composeRedos(tree(), [
      { nodeId: 'root/01-b', entry: 'execute' },
      { nodeId: 'root/00-a', entry: 'execute' },
    ], NOW)
    const b = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: 'root/01-b', entry: 'execute' },
    ], NOW)
    if ('error' in a || 'error' in b) throw new Error('unexpected')
    expect(a.worktreesToRelease.map(w => w.nodeId)).toEqual(b.worktreesToRelease.map(w => w.nodeId))
    expect(a.reopenedAncestors).toEqual(b.reopenedAncestors)
    expect(a.nodes.map(n => `${n.id}:${n.status}`)).toEqual(b.nodes.map(n => `${n.id}:${n.status}`))
  })

  /**
   * **任何一次算不出来,整条不做。**
   *
   * 做半套的后果是一棵**部分回溯**的树落了盘,而屏幕上那份清单说的是全部 ——
   * 用户没有任何办法知道少了哪几个。
   */
  it('其中一个节点不存在 → 整条返回 error,不返回半套', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: '不存在', entry: 'execute' },
    ], NOW)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('不存在')
  })

  it('补充提示词写在对应节点的执行环节上', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute', guidance: '缺了 API 层,这次补上' },
    ], NOW)
    if ('error' in r) throw new Error(r.error)
    const n = r.nodes.find(x => x.id === 'root/00-a')!
    expect(JSON.stringify(n.guidance ?? {})).toContain('缺了 API 层')
  })

  it('空名单 → 原样返回,不报错', () => {
    const r = composeRedos(tree(), [], NOW)
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.worktreesToRelease).toEqual([])
  })
})

describe('确认屏', () => {
  it('两级分开说,而且第 2 级要写出会删几个子任务', () => {
    const a = mk('a', { title: '甲', childIds: ['a/1', 'a/2'], backtrack: { rounds: 1, at: NOW } })
    const b = mk('b', { title: '乙' })
    const lines = backtrackLines([
      { node: a, level: 2, blocking: '缺 API', remedy: ['补 API 层'], suspects: [] },
      { node: b, level: 1, blocking: '测试不全', remedy: [], suspects: [] },
    ], [{ nodeId: 'a', entry: 'plan' }, { nodeId: 'b', entry: 'execute' }])
    const text = lines.join('\n')
    expect(text).toContain('重新执行')
    expect(text).toContain('完全重做')
    /**
     * **第 2 级点的是子任务,不是这个父任务。** 上一版按父节点渲染并印它的 childIds 数 ——
     * 而执行时真正送去 `planRedo(entry:'plan')` 的是 suspects。验收实测:屏幕说
     * 「删 root 的 3 个子任务」,实际删的是 c1 的 2 个。
     */
    expect(text).toContain('下的 1 个子任务')
    expect(text).not.toContain('删除 2 个子任务')
    // 这个数是估的,必须说出口:执行时主模型会重新圈一遍。
    expect(text).toContain('可能和上面这份不同')
    expect(text).toContain('补 API 层')
    // 这个键和 r 最不一样的地方:它不开圆桌。
    expect(text).toContain('不会开新的圆桌')
  })

  it('一个都没有时说清楚,不印空标题', () => {
    expect(backtrackLines([], [])[0]).toContain('没有需要回溯的任务')
  })
})
