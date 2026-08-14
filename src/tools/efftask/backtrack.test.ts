import { describe, expect, it } from 'bun:test'
import {
  backtrackLines, backtrackScope, composeRedos, conservativeEntries, entryFor, integrateFeedback, staleRound,
  levelFor, markBacktracked, outputMissing, selfReportedUndone, undoneOf,
  NO_CONTRIBUTION_NOTE, RESCUE_STRANDED_NOTE, backtrackCanClaim, rescueStranded, strandedRefsOf,
  type BacktrackTarget,
} from './backtrack.js'
import { PROTOCOL_AMBIGUOUS, PROTOCOL_NO_BLOCK } from './parseOutput.js'
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
   * **交付过的不算,哪怕盘上留着那句注记。**
   *
   * 旧版 `pipeline` 在 `!res.merged` 时**无条件**追加那句注记,于是一个此前交付过、
   * 只是本轮没有新东西可合的节点,盘上同时有 `contributed: true` 和那句话。
   * 跑机实测 14 个正是这形状 —— 少了这条判据,`b` 会把它们一起点中重跑,
   * 而它们的产出早就在集成分支上。
   */
  it('contributed 为真时不算「产出丢了」—— 那句注记在这种节点上是旧版留下的假话', () => {
    const noted = { status: 'ACCEPTED' as const, execStatus: `(注:该节点${NO_CONTRIBUTION_NOTE})` }
    expect(outputMissing(mk('x', { ...noted, contributed: true }))).toBe(false)
    // 缺席必须落到「没交付过」那一侧 —— 宁可多重跑一次,不可放过一个真没交付的。
    expect(outputMissing(mk('x', { ...noted, contributed: undefined }))).toBe(true)
    expect(outputMissing(mk('x', { ...noted, contributed: false }))).toBe(true)
    // 阻断原因那一路同样要认(BLOCKED 是这道闸现在的主路径)。
    expect(outputMissing(mk('x', {
      status: 'BLOCKED', blockedReason: `该节点${NO_CONTRIBUTION_NOTE}`, contributed: true,
    }))).toBe(false)
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
   * **解开 `revised` 闩的判据是「有没有子任务」,不是「第几级」。**
   *
   * 它默认「每个节点一辈子只补救一次」,而这个闩正是人工干预要解开的东西 —— 让
   * `reviseDecomposition` 能在下一轮集成验收里用真 ctx 把补救子任务长出来,也就是用户
   * 说的「加新任务」。绑在第 2 级上的话,加新任务要按**两次** `b` 才可能发生,而第 1 级
   * 本来就要重新走一次集成验收,那正是它该被允许长出补救子任务的时刻。
   *
   * 没有子任务的节点不解:`reviseDecomposition` 只在 `stepIntegrate` 里调用,而它根本
   * 不走那一关 —— 解了也是一次没有意义的字段写入。
   */
  it('有子任务的目标一律重新武装补救拆分,叶子不动它', () => {
    const a = mk('a', { revised: true, childIds: ['a/00-x'] })
    const b = mk('b', { revised: true, childIds: ['b/00-y'] })
    const leaf = mk('c', { revised: true })
    const plan = { nodes: [a, b, leaf], deleted: [], dependencyRewrites: [], worktreesToRelease: [], seatedAt: 'READY' as const, reopenedAncestors: [], warnings: [] }
    const { rearmed } = markBacktracked(plan, [
      { node: a, level: 2, blocking: '', remedy: [], suspects: [] },
      { node: b, level: 1, blocking: '', remedy: [], suspects: [] },
      { node: leaf, level: 1, blocking: '', remedy: [], suspects: [] },
    ], NOW)
    expect(rearmed.sort()).toEqual(['a', 'b'])
    expect(a.revised).toBe(false)
    expect(b.revised).toBe(false)
    expect(leaf.revised).toBe(true)
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
   * **算不出来的那一条跳过,其余照做 —— 但必须说出来。**
   *
   * 老规矩是「任何一次出错整条不做」,它的理由(不许让用户对着一份说全做了的清单)成立,
   * 而它要的是**说出来**,不是全盘放弃:跑机上 34 个「集成验收没通过、子任务却全绿」的
   * 拆分节点里只要有一个落进这一批,同一批里所有真正该重跑的节点一个都不会动。
   */
  it('其中一个节点不存在 → 跳过它,其余照做,并逐条记进 warnings/skipped', () => {
    const r = composeRedos(tree(), [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: '不存在', entry: 'execute' },
    ], NOW)
    if ('error' in r) throw new Error(r.error)
    // 好的那条真的做了:工作区被交回去、节点回到 READY。
    expect(r.worktreesToRelease.map(w => w.nodeId)).toEqual(['root/00-a'])
    expect(r.nodes.find(n => n.id === 'root/00-a')!.status).toBe('READY')
    // 坏的那条两处都留了痕:给人看的 warnings,和给 `reran` 闸用的结构化 skipped。
    expect(r.skipped.map(s => s.nodeId)).toEqual(['不存在'])
    expect(r.warnings.join('\n')).toContain('不存在')
  })

  /**
   * **一条都没算成 = 错误。** 这一格不是理论上的:名单里全是拆分型节点(跑机上 34 个)
   * 时就会走到。返回一份空 plan 的话,调用方会照常落盘、上屏、重启编排器,
   * 而屏幕上写着「已重跑 N 个」。
   */
  it('给了名单、一条都没算成 → error(不是一次成功的空回溯)', () => {
    const r = composeRedos(tree(), [
      { nodeId: '不存在', entry: 'execute' },
      { nodeId: 'root', entry: 'execute' }, // 拆分型:没有执行环节
    ], NOW)
    expect('error' in r).toBe(true)
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
    /**
     * **「加新任务」到底是什么,要在按下之前说清。**
     *
     * 验收判它是一次曲解:用户说的是「完全重做任务**和**加新任务」,而落地的是
     * 「重新开放一次补救拆分,由之后那次集成验收决定加不加」。实现有理由,
     * 但理由不能替代告知 —— 此前只有**按完之后**的结果屏提到它。
     */
    expect(text).toContain('重新开放一次「补救拆分」')
    expect(text).toContain('由那一轮决定')
    // 这个键和 r 最不一样的地方:它不开圆桌。
    expect(text).toContain('不会开新的圆桌')
  })

  /**
   * **「凭什么是第 2 级」要印出来。**
   *
   * 用户真的问过这一句:屏幕上只有「N 个任务要完全重做」,而他没有任何办法知道这个级别
   * 是怎么来的(来自 `backtrack.rounds >= 1`,也就是此前按过一次 `b`)。第 2 级会删整片
   * 子树、重新拆分 —— 要用户按下它,判据必须摆在眼前。
   */
  it('第 2 级要印出依据(上一次回溯是什么时候)', () => {
    const a = mk('a', {
      title: '甲', childIds: ['a/1'],
      backtrack: { rounds: 1, at: '2026-08-13T10:49:50.354Z' },
      updatedAt: '2026-08-14T02:00:00.000Z',   // 那次之后动过 = 第 1 级真的跑了
    })
    const text = backtrackLines(
      [{ node: a, level: 2, blocking: '', remedy: [], suspects: [] }],
      [{ nodeId: 'a', entry: 'plan' }],
    ).join('\n')
    expect(text).toContain('第 2 级的依据')
    expect(text).toContain('2026-08-13T10:49:50.354Z')
    // 真跑过的**不许**报空推警告 —— 那会让用户去清一个有依据的标记。
    expect(text).not.toContain('空推')
  })

  /**
   * **空推上去的那一级要单独警告。**
   *
   * 跑机 .30 实测:217 个带 `rounds: 1` 的节点(全是同一个时间戳,一次按下打的一批)里
   * **183 个的 `updatedAt` 比那个标记还早** —— 那一轮从来没真的重跑过它们,而这一次按 `b`
   * 会把它们直接推到「完全重做」。用户按下的是这套东西里最贵、最不可逆的一步。
   */
  it('标记之后再没被写过 → 警告这一级是空推上去的', () => {
    const a = mk('a', {
      title: '甲', childIds: ['a/1'],
      backtrack: { rounds: 1, at: '2026-08-13T10:49:50.354Z' },
      updatedAt: '2026-08-12T15:55:38.914Z',   // 比标记还早
    })
    const text = backtrackLines(
      [{ node: a, level: 2, blocking: '', remedy: [], suspects: [] }],
      [{ nodeId: 'a', entry: 'plan' }],
    ).join('\n')
    expect(text).toContain('再没有被写过一次')
    expect(text).toContain('空推')
    // 要给得出能照做的下一步。
    expect(text).toContain('先清掉它的 backtrack 记录')
  })

  /**
   * **第 2 级但拿不到时间戳时,那一行整个不印 —— 不许印出 `undefined`。**
   *
   * 形态是真的:node.md 可以被手工编辑(`backtrack:` 只剩 `rounds`),而调用方也能
   * 直接传 `level: 2`。变异测试实测:把守卫改成恒真,屏幕上会出现
   * 「第 2 级的依据:此前回溯过一次(undefined)」—— 一句用户完全没法据以动手的话,
   * 而它出现在一个不可逆按键的确认屏上。
   */
  it('第 2 级但没有 backtrack.at → 不印那一行,更不许印 undefined', () => {
    const a = mk('a', { title: '甲', childIds: ['a/1'] })   // 完全没有 backtrack 字段
    const text = backtrackLines(
      [{ node: a, level: 2, blocking: '', remedy: [], suspects: [] }],
      [{ nodeId: 'a', entry: 'plan' }],
    ).join('\n')
    expect(text).toContain('完全重做')        // 这一段照常渲染
    expect(text).not.toContain('第 2 级的依据')
    expect(text).not.toContain('undefined')
  })

  /** 时间戳解析不出来就**一个字都不说** —— 少说一句永远比说错一句便宜。 */
  it('时间戳坏了就不报空推(宁可不说)', () => {
    expect(staleRound(mk('a', { backtrack: { rounds: 1, at: '不是时间' }, updatedAt: 'T0' }))).toBe(false)
    // `updatedAt` 缺席(老 node.md)同样是「算不出来」——**不是**「没动过」。
    expect(staleRound(mk('a', {
      backtrack: { rounds: 1, at: '2026-08-13T10:49:50.354Z' }, updatedAt: '' as never,
    }))).toBe(false)
    // 没有 backtrack 的节点根本谈不上这件事。
    expect(staleRound(mk('a', { updatedAt: '2026-08-12T00:00:00.000Z' }))).toBe(false)
    // 正反两面都要钉:早于 → true,晚于 → false。
    expect(staleRound(mk('a', {
      backtrack: { rounds: 1, at: '2026-08-13T10:00:00.000Z' }, updatedAt: '2026-08-12T10:00:00.000Z',
    }))).toBe(true)
    expect(staleRound(mk('a', {
      backtrack: { rounds: 1, at: '2026-08-13T10:00:00.000Z' }, updatedAt: '2026-08-14T10:00:00.000Z',
    }))).toBe(false)
  })

  it('一个都没有时说清楚,不印空标题', () => {
    expect(backtrackLines([], [])[0]).toContain('没有需要回溯的任务')
  })
})

/**
 * **没有隔离工作区的那两档,这一屏不许承诺删目录和重新同步。**
 *
 * 实测:共享目录下它无条件印「它们的隔离工作区会被删掉并从集成分支最新状态重建」——
 * 那里既没有工作区也没有集成分支,而启动关口自己刚说过「b(回溯)的重新同步……不适用」。
 * 而且这不只是文案:第 2 级「完全重做」在隔离档下靠 `discard()` 换来干净重编,共享档下
 * `worktreesToRelease` 恒为空,上一轮写进用户目录的文件原样留着,重跑面对的是脏现场 ——
 * 用户在按下这个**不可逆**动作之前读到的是相反的承诺。
 */
describe('确认屏 · 没有隔离工作区时', () => {
  const targets = (): BacktrackTarget[] => [
    { node: mk('b', { title: '乙' }), level: 1, blocking: '测试不全', remedy: [], suspects: [] },
  ]
  const entries = [{ nodeId: 'b', entry: 'execute' }]

  it('不承诺删工作区,而且说清上一轮的文件原样留着', () => {
    const text = backtrackLines(targets(), entries, false).join('\n')
    expect(text).not.toContain('隔离工作区会被删掉')
    expect(text).not.toContain('从集成分支最新状态重建')
    expect(text).toContain('原样留着')
  })

  it('有隔离时照旧说清会删会重建 —— 那是这个键最贵的一半', () => {
    const text = backtrackLines(targets(), entries, true).join('\n')
    expect(text).toContain('隔离工作区会被删掉并从集成分支最新状态重建')
  })

  /** 不传 = 当成有隔离(既有调用点的语义不变)。 */
  it('缺省当成有隔离', () => {
    expect(backtrackLines(targets(), entries).join('\n')).toContain('隔离工作区会被删掉')
  })
})

/**
 * **第三格:`m` 三级都试过、还是没捞回来的产出。**
 *
 * 用户 2026-08-13:「如果实在捞不回来,会在回溯里检查不。」此前这一段是**断的** ——
 * `m` 判 hold 是一条 ref 的事,而这里认的是节点级信号,中间没有任何东西。
 */
describe('捞不回来的产出要能被 b 认领', () => {
  const stranded = (id: string, over: Partial<TaskNode> = {}): TaskNode => mk(id, {
    status: 'ACCEPTED',
    // 执行型 —— 只有它才有执行环节可重跑(unknown / decompose 那两格 planRedo 判 disabled)。
    kind: 'executable',
    execStatus: `做完了\n${RESCUE_STRANDED_NOTE}(${NOW}:efftask/1/salvage/ab12cd34,还差 2 处)`,
    rescueStranded: [{ ref: 'efftask/1/salvage/ab12cd34', why: '两边都有而内容不同', at: NOW, remaining: 2 }],
    ...over,
  })

  it('叶子节点上的痕迹会被收进回溯范围,并且带着能注入的理由', () => {
    const nodes = [mk('root', { childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }), stranded('root/00-a', { parentId: 'root' })]
    const { targets } = backtrackScope(nodes, 'root')
    expect(targets.map(t => t.node.id)).toEqual(['root/00-a'])
    /**
     * **注入的话不许说「集成验收没通过」** —— 这一格根本没有集成验收意见。
     * 送一句假前提给执行者,正是这个仓库记过的那类事故。
     */
    expect(targets[0]!.blocking).toContain('没能全部捞回集成分支')
    expect(targets[0]!.blocking).toContain('efftask/1/salvage/ab12cd34')
    expect(targets[0]!.blocking).not.toContain('集成验收')
  })

  /**
   * **拆分型节点上的痕迹不立 target。**
   *
   * 立了的话:它子树全绿 → suspects 为空 → 回溯它自己 → `planRedo(execute)` 对拆分任务
   * 判 disabled → `composeRedos` 一错**整条不做** → 连真正集成验收没过的节点一起,
   * 一个都不重跑。一条挂错地方的 ref 能让整次回溯变成空操作。
   */
  it('拆分型节点上的痕迹不立 target,而且不会拖垮同一次回溯里的别人', () => {
    const nodes = [
      mk('root', {
        childIds: ['root/00-a'], status: 'WAITING_CHILDREN', kind: 'decompose',
        execStatus: `${RESCUE_STRANDED_NOTE}(${NOW}:efftask/1/salvage/zz,还差 1 处)`,
      }),
      mk('root/00-a', { parentId: 'root', status: 'BLOCKED', acceptLog: [integrateFail()] }),
    ]
    const { targets } = backtrackScope(nodes, 'root')
    expect(targets.map(t => t.node.id)).toEqual(['root/00-a'])
  })

  /**
   * **还没有方案的节点(kind: unknown)也不许立 target。**
   *
   * 第一版判据写的是 `kind !== 'decompose'`,而 `planRedo(execute)` 对 unknown 同样判
   * disabled(「本节点还没有方案」)—— 后果和拆分型一模一样:`composeRedos` 一错整条不做。
   */
  it('还没有方案的节点不立 target', () => {
    const nodes = [
      mk('root', { childIds: ['root/00-a'], status: 'WAITING_CHILDREN', kind: 'decompose' }),
      stranded('root/00-a', { parentId: 'root', kind: 'unknown' }),
    ]
    expect(backtrackScope(nodes, 'root').targets).toEqual([])
  })

  /**
   * **只因为捞不回来进来的,恒走第 1 级。**
   *
   * `levelFor` 读的是终身回溯计数 —— 一个此前因为别的原因回溯过一次的节点,这次只是
   * 有条 ref 没捞回,却会直接跳到「完全重做 + 删整片子树」。用户定的阶梯是
   * 「优先重新执行……如果不行,才完全重做」,而「不行」说的是这件事试过一遍。
   */
  it('捞不回来这一格不吃终身回溯计数,恒走第 1 级', () => {
    const n = stranded('root', { backtrack: { rounds: 3, at: NOW } })
    expect(levelFor(n)).toBe(2)
    expect(backtrackScope([n], 'root').targets[0]!.level).toBe(1)
  })

  /** 集成验收也没过的话,阶梯照常升级 —— 上面那条不能把正常的升级一起关掉。 */
  it('同时还有集成验收没过时,阶梯照常升级', () => {
    const n = stranded('root', { backtrack: { rounds: 1, at: NOW }, status: 'BLOCKED', acceptLog: [integrateFail()] })
    expect(backtrackScope([n], 'root').targets[0]!.level).toBe(2)
  })

  /**
   * **痕迹要被这一次回溯消费掉。**
   *
   * `planRedo` 是 structuredClone、`resetForExecute` 只追加不清空 —— 不清的话这个节点
   * 从此每次按 `b` 都被判进来,永远重跑。
   */
  it('回溯落地时把痕迹和载荷一起清掉', () => {
    const n = stranded('root')
    const plan = composeRedos([n], [{ nodeId: 'root', entry: 'execute' }], NOW)
    expect('error' in plan).toBe(false)
    if ('error' in plan) return
    markBacktracked(plan, backtrackScope([n], 'root').targets, NOW)
    const after = plan.nodes.find(x => x.id === 'root')!
    expect(after.execStatus).not.toContain(RESCUE_STRANDED_NOTE)
    expect(after.rescueStranded).toBeUndefined()
    // 清掉之后就不该再被认领 —— 否则「永远重跑」只是换了个地方发生。
    expect(backtrackScope([after], 'root').targets).toEqual([])
  })

  /** 载荷被写坏时只丢明细,不许把恢复链路带崩、也不许让判据失灵。 */
  it('载荷写坏了照样认领,只是没有明细', () => {
    const n = stranded('root')
    ;(n as unknown as { rescueStranded: unknown }).rescueStranded = 'boom'
    expect(strandedRefsOf(n)).toEqual([])
    const { targets } = backtrackScope([n], 'root')
    expect(targets).toHaveLength(1)
    expect(targets[0]!.blocking).toContain('明细已经不在节点上了')
  })

  it('屏幕上要把这一类和「集成验收没通过」分开说', () => {
    const nodes = [stranded('root')]
    const text = backtrackLines(backtrackScope(nodes, 'root').targets, [{ nodeId: 'root', entry: 'execute' }]).join('\n')
    expect(text).toContain('产出没能捞回来')
    expect(text).toContain('efftask/1/salvage/ab12cd34')
    // 那条分支照样留着 —— 「捞是加法,不删任何东西」这条铁律要在屏幕上兑现。
    expect(text).toContain('照样留着')
  })

  /** 顶层字段必须能落盘、能读回 —— 只写不读的字段在第一次 --resume 时清零,这个仓库付过三次账。 */
  it('痕迹和载荷都能被 --resume 读回来', () => {
    const n = stranded('root')
    const back = parseNodeFile(serializeNode(n))
    expect(back?.execStatus).toContain(RESCUE_STRANDED_NOTE)
    expect(strandedRefsOf(back!)).toHaveLength(1)
    expect(strandedRefsOf(back!)[0]!.remaining).toBe(2)
  })
})

/**
 * 验收席实测推翻的那两条:写痕迹和读痕迹用同一把尺;没重跑过的证据不许被抹。
 */
describe('痕迹的写读对称与消费时机', () => {
  const withNote = (id: string, over: Partial<TaskNode> = {}): TaskNode => mk(id, {
    status: 'ACCEPTED', kind: 'executable',
    execStatus: `做完了\n${RESCUE_STRANDED_NOTE}(${NOW}:r1,还差 1 处)`,
    rescueStranded: [{ ref: 'r1', why: '两边都有而内容不同', at: NOW, remaining: 1 }],
    ...over,
  })

  /**
   * **写痕迹的一侧和读痕迹的一侧必须问同一个问题。**
   *
   * 各判各的后果是实测出来的:痕迹落在拆分型 / `kind: 'unknown'` / 有子任务的节点上时,
   * `m` 的结果屏说「已经记在它们身上,按 b 回溯会把这些内容重新做出来」,而 `b` 那一屏说
   * 「这棵子树里没有需要回溯的任务……m 也没有留下捞不回来的东西」。两块屏说反话。
   */
  it('backtrackCanClaim 就是 backtrackScope 的那条判据', () => {
    const cases: [string, Partial<TaskNode>, boolean][] = [
      ['执行型叶子', {}, true],
      ['拆分型', { kind: 'decompose' }, false],
      ['还没出方案', { kind: 'unknown' }, false],
      ['有子任务', { childIds: ['x'] }, false],
    ]
    for (const [name, over, claim] of cases) {
      const n = withNote('root', over)
      expect(`${name}: ${backtrackCanClaim(n)}`).toBe(`${name}: ${claim}`)
      expect(`${name} 进不进 targets: ${backtrackScope([n], 'root').targets.length > 0}`)
        .toBe(`${name} 进不进 targets: ${claim}`)
    }
  })

  /**
   * **没被重跑就不许清证据。**
   *
   * 主模型只点了别的子任务时,那个「捞不回来」的叶子一次都没重跑,而上一版把它的注记
   * 抹掉、载荷 delete —— 下一次按 b 再也找不到它,那条 ref 就此彻底失联。
   */
  it('这一趟没重跑的节点,证据原样留着', () => {
    const a = withNote('root/00-a', { parentId: 'root' })
    const b = mk('root/01-b', { parentId: 'root', status: 'BLOCKED', kind: 'executable' })
    const root = mk('root', { childIds: ['root/00-a', 'root/01-b'], kind: 'decompose', status: 'WAITING_CHILDREN' })
    const nodes = [root, a, b]
    const plan = composeRedos(nodes, [{ nodeId: 'root/01-b', entry: 'execute' }], NOW)
    if ('error' in plan) throw new Error(plan.error)
    markBacktracked(plan, backtrackScope(nodes, 'root').targets, NOW, new Set(['root/01-b']))
    const after = plan.nodes.find(n => n.id === 'root/00-a')!
    expect(rescueStranded(after)).toBe(true)
    expect(strandedRefsOf(after)).toHaveLength(1)
    // 而真的重跑了的那一次,证据照旧被消费掉(否则永远重跑)。
    const plan2 = composeRedos(nodes, [{ nodeId: 'root/00-a', entry: 'execute' }], NOW)
    if ('error' in plan2) throw new Error(plan2.error)
    markBacktracked(plan2, backtrackScope(nodes, 'root').targets, NOW, new Set(['root/00-a']))
    expect(rescueStranded(plan2.nodes.find(n => n.id === 'root/00-a')!)).toBe(false)
  })

  /**
   * **注入的那句话要跟着真实成因走,而且不许把他推去 merge 那条分支。**
   *
   * 「被后来的版本取代」那一格两级都没试过,上一版却无条件写「合并、加法补录都试过了」——
   * 执行者拿到的是一句自相矛盾的话。而顺手 merge 一条被取代的抢救分支,
   * 正是这条链最想避免的结局。
   */
  it('被取代那一格的注入语不许说「都试过了」,而且明说不要 merge', () => {
    const n = mk('root', {
      status: 'ACCEPTED', kind: 'executable',
      execStatus: `${RESCUE_STRANDED_NOTE}(${NOW}:r9,还差 2 处)`,
      rescueStranded: [{ ref: 'r9', why: '分诊拿不准,而这一版已经被后来的版本取代,没有补录', at: NOW, remaining: 2 }],
    })
    const blocking = backtrackScope([n], 'root').targets[0]!.blocking
    expect(blocking).toContain('已经被后来的版本取代')
    expect(blocking).not.toContain('都试过了')
    expect(blocking).toContain('不要去 git merge')
  })
})

/**
 * **datum 那一格** —— 跑机 .13 qianbase-xtp run 001 上真实存在的形状,而且它此前对
 * 回溯**完全不可见**:
 *
 *  - 子任务 `status: ACCEPTED`(这一趟按用户要求关掉了验收环节,`acceptLog` 是空的);
 *  - 它改过一行 `Cargo.toml`,所以 `mergeAndRelease` 的字节级判据认为它「有贡献」——
 *    `outputMissing` 为假;
 *  - 而它自己的 execStatus 写着「本轮未做:创建 datum.rs」—— 任务的全部内容;
 *  - 父任务的集成验收连着三轮点名 datum.rs 不在集成工作区,最后按迭代上限降级放行。
 *
 * 三条判据(没通过 / 产出丢了 / 捞不回来)一条都认不出它。
 */
describe('自陈未做的子任务:datum 那一格', () => {
  const NOTE = NO_CONTRIBUTION_NOTE
  const tree = (): TaskNode[] => [
    mk('P', {
      kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01', 'P/02', 'P/03'],
      acceptLog: [{
        round: 3, step: 'integrate',
        verdicts: [{ role: '测试', pass: false, blocking: ['datum.rs 不在集成工作区'], comments: '' }],
        synthesized: { pass: false, blockingSummary: 'datum.rs 不在集成工作区' },
      }],
    }),
    // 干干净净做完的兄弟。
    mk('P/01', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    // 真凶:有贡献、已验收、自己说没做。
    mk('P/02', {
      parentId: 'P', kind: 'executable', status: 'ACCEPTED',
      execStatus: '已登记依赖。\n本轮未做:创建 datum.rs(原因:被限制为纯文本回复)',
      undone: ['创建 datum.rs(原因:被限制为纯文本回复)'],
    }),
    // 老判据认得出的那种。
    mk('P/03', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: `(注:该节点${NOTE})` }),
  ]

  it('保守名单收得到它 —— 而 status/贡献两条判据都认不出', () => {
    const { targets } = backtrackScope(tree(), 'P')
    const t = targets.find(x => x.node.id === 'P')!
    expect(outputMissing(tree()[2])).toBe(false)
    expect(t.suspects).toContain('P/02')
    expect(t.suspects).toContain('P/03')
    expect(t.suspects).not.toContain('P/01')
  })

  it('自陈未做本身不立 target —— 全 run 610 个节点自陈未做,升格会把健康子树一起重跑', () => {
    // 同一个节点,父任务的集成验收**通过**时:自陈未做的 P/02 不该被这个键认领,
    // 而带着零贡献注记的 P/03 照旧认(那是它自己的判据)。
    const ok = tree().map(n => (n.id === 'P' ? { ...n, acceptLog: [] } : n))
    const ids = backtrackScope(ok, 'P').targets.map(t => t.node.id)
    expect(ids).not.toContain('P/02')
    expect(ids).not.toContain('P')
    expect(ids).toEqual(['P/03'])
  })

  it('undoneOf 只认长得对的 —— 手改坏的 node.md 不许抛在恢复链路里', () => {
    expect(undoneOf(mk('x', { undone: ['a', '', 'b'] }))).toEqual(['a', 'b'])
    expect(undoneOf(mk('x', { undone: 'boom' as never }))).toEqual([])
    expect(undoneOf(mk('x', { undone: [1, { a: 2 }] as never }))).toEqual([])
    expect(selfReportedUndone(mk('x'))).toBe(false)
  })
})

/**
 * **从哪一关重来,按节点形态定。**
 *
 * 写死 `execute` 时,一个「集成验收没通过、子任务却全绿」的拆分节点会让 `planRedo` 判
 * disabled —— 跑机上有 34 个这种节点,而当时的规矩是「一条错整条不做」。
 */
describe('entryFor', () => {
  it('执行型叶子 → execute', () => {
    expect(entryFor(mk('x', { kind: 'executable' }), 1)).toBe('execute')
  })
  it('拆分型(有子任务)→ integrate:它自己没有执行环节,能重来的只有那次裁决', () => {
    expect(entryFor(mk('x', { kind: 'decompose', childIds: ['x/1'] }), 1)).toBe('integrate')
  })
  it('长了子任务的执行型 → 同样是 integrate(redoOptions 的 isDecomposed 判据一致)', () => {
    expect(entryFor(mk('x', { kind: 'executable', childIds: ['x/1'] }), 1)).toBe('integrate')
  })
  it('kind 还是 unknown 的叶子 → plan(execute/integrate 两条都被禁用)', () => {
    expect(entryFor(mk('x', { kind: 'unknown' }), 1)).toBe('plan')
  })
  it('第 2 级恒走 plan', () => {
    expect(entryFor(mk('x', { kind: 'executable' }), 2)).toBe('plan')
    expect(entryFor(mk('x', { kind: 'decompose', childIds: ['x/1'] }), 2)).toBe('plan')
  })
})

/**
 * **注入执行提示词的那段意见,不能是一句关于回复格式的抱怨。**
 */
describe('integrateFeedback', () => {
  const protocolRound = {
    round: 3, step: 'integrate' as const,
    verdicts: [{ role: '测试', pass: false, blocking: [PROTOCOL_NO_BLOCK], comments: '' }],
    synthesized: { pass: false, blockingSummary: PROTOCOL_NO_BLOCK },
  }
  const realRound = {
    round: 1, step: 'integrate' as const,
    verdicts: [{
      role: '测试', pass: false,
      blocking: ['datum.rs 不在集成工作区', 'cargo check 126 errors'],
      comments: '', advice: ['先补 sem/tree/datum.rs 并接进 mod.rs'],
    }],
    synthesized: { pass: false, blockingSummary: '两条' },
  }

  it('最后一轮是协议失败时,取前几轮的真意见', () => {
    const s = integrateFeedback(mk('x', { acceptLog: [realRound, protocolRound] }))
    expect(s).toContain('datum.rs 不在集成工作区')
    expect(s).toContain('cargo check 126 errors')
    expect(s).toContain('先补 sem/tree/datum.rs')
    expect(s).not.toContain('裁决代码块')
  })

  it('降级放行时随节点带下去的建议也算', () => {
    const s = integrateFeedback(mk('x', {
      acceptLog: [protocolRound],
      degraded: [{ phase: 'integrate', round: 3, reason: '集成验收迭代超限(3)', advice: ['完成并接线 datum.rs'], at: NOW }],
    }))
    expect(s).toContain('完成并接线 datum.rs')
  })

  it('别的环节的降级建议不算 —— 闩要闩住的是集成验收那一关', () => {
    const s = integrateFeedback(mk('x', {
      acceptLog: [protocolRound],
      degraded: [{ phase: 'review', round: 3, reason: '方案评审迭代超限(3)', advice: ['方案要写验收点'], at: NOW }],
    }))
    expect(s).not.toContain('方案要写验收点')
  })

  /**
   * 一条真意见都凑不出来时,给的既不是空串(屏幕承诺「注入意见」而注入了空气),
   * 也不是那句格式抱怨(执行者手上根本没有那份回复,无法照做)。
   */
  it('一条真意见都没有时,给一句他能照做的,而不是格式抱怨', () => {
    const s = integrateFeedback(mk('x', { acceptLog: [protocolRound] }))
    expect(s).not.toContain('裁决代码块;按不通过处理')
    expect(s.length).toBeGreaterThan(20)
    expect(s).toContain('验收点')
  })

  it('去重,而且不会把同一条印两遍', () => {
    const dup = { ...realRound, round: 2 }
    const s = integrateFeedback(mk('x', { acceptLog: [realRound, dup] }))
    expect(s.split('\n').filter(l => l.includes('cargo check 126 errors'))).toHaveLength(1)
  })
})

/**
 * **确认屏和执行侧共用同一份名单**。各算一次的话,用户是照着一份按的确认,跑的是另一份。
 */
describe('conservativeEntries', () => {
  const nodes = (): TaskNode[] => [
    mk('P', { kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01'], acceptLog: [integrateFail()] }),
    mk('P/01', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    mk('Q', { kind: 'decompose', status: 'ACCEPTED', childIds: ['Q/01'], acceptLog: [integrateFail()] }),
    mk('Q/01', { parentId: 'Q', kind: 'executable', status: 'BLOCKED' }),
  ]
  it('子任务全绿的目标 → 它自己走 integrate;有问题子任务的目标 → 子任务走 execute', () => {
    const list = nodes()
    const byId = new Map(list.map(n => [n.id, n]))
    const { targets } = backtrackScope(list, 'P')
    expect(conservativeEntries(targets, byId)).toEqual([{ nodeId: 'P', entry: 'integrate', level: 1 }])
    const q = backtrackScope(list, 'Q')
    expect(conservativeEntries(q.targets, byId)).toEqual([{ nodeId: 'Q/01', entry: 'execute', level: 1 }])
  })
})

/**
 * **N 条 entry ≠ N 次全树深拷贝。**
 *
 * `planRedo` 第一行是 `input.map(structuredClone)`,而 .13 那个 run 的 node.md 合计
 * 86 MiB / 2215 个节点、符合回溯条件的有 834 个 —— 在 root 上按一次 `b` 就是几百次
 * 全树深拷贝,同步跑在按键处理里。串接时第 2 条起复用上一条刚交出来的那棵树。
 *
 * 但**对调用方的承诺一个字不能变**:传进去的那份数组和里面的节点对象都不许被改。
 */
describe('composeRedos 的拷贝纪律', () => {
  const t = (): TaskNode[] => [
    mk('root', { childIds: ['root/00-a', 'root/01-b'], status: 'ACCEPTED', kind: 'decompose' }),
    mk('root/00-a', { parentId: 'root', status: 'ACCEPTED', kind: 'executable', worktree: { branch: 'ba', path: '/wt/a' } }),
    mk('root/01-b', { parentId: 'root', status: 'ACCEPTED', kind: 'executable', worktree: { branch: 'bb', path: '/wt/b' } }),
  ]

  it('两条 entry 之后,传进去的那棵树一个字节都没变', () => {
    const before = t()
    const snapshot = JSON.stringify(before)
    const r = composeRedos(before, [
      { nodeId: 'root/00-a', entry: 'execute' },
      { nodeId: 'root/01-b', entry: 'execute' },
    ], NOW)
    if ('error' in r) throw new Error(r.error)
    // 这一条是 `commitRedo(plan, before)` 的前提:`before` 要如实描述回溯**之前**的状态。
    expect(JSON.stringify(before)).toBe(snapshot)
    // 而返回的那棵树两个节点都真的被重置了(串接生效)。
    expect(r.nodes.filter(n => n.status === 'READY').map(n => n.id).sort())
      .toEqual(['root/00-a', 'root/01-b'])
    expect(r.worktreesToRelease.map(w => w.nodeId).sort()).toEqual(['root/00-a', 'root/01-b'])
  })

  it('返回的节点对象和传进去的不是同一批', () => {
    const before = t()
    const r = composeRedos(before, [{ nodeId: 'root/00-a', entry: 'execute' }], NOW)
    if ('error' in r) throw new Error(r.error)
    expect(r.nodes.find(n => n.id === 'root/00-a')).not.toBe(before[1])
  })
})

/**
 * 变异测试补上的四条 —— 每一条都是「我原来的探针没打在点上」。
 */
describe('变异测试补漏', () => {
  /**
   * `isProtocolBlocking` 必须按**包含**判:`synthesizeVerdicts` 合成的摘要带席位抬头
   * (跑机上逐字是 `[测试] 未按要求输出本轮的裁决代码块;按不通过处理`)。
   * 按相等判的话,这个函数对**真实数据里最常见的那一条**恒为假。
   */
  it('带席位抬头的协议失败也要认出来(跑机上就是这个形状)', () => {
    const prefixed = `[测试] ${PROTOCOL_NO_BLOCK}`
    const n = mk('x', {
      status: 'ACCEPTED',
      acceptLog: [{
        round: 3, step: 'integrate',
        verdicts: [{ role: '测试', pass: false, blocking: [prefixed], comments: '' }],
        synthesized: { pass: false, blockingSummary: prefixed },
      }],
    })
    const s = integrateFeedback(n)
    expect(s).not.toContain('裁决代码块')
    expect(s).toContain('验收点')
  })

  /**
   * **意见是从 `integrateFeedback` 来的,不是从最后一条 `blockingSummary` 来的。**
   * 这一条钉的是**接线**:上面那些用例只测了函数本身,而 `backtrackScope` 完全可以
   * 绕过它去读 `rec.synthesized.blockingSummary`(变异测试实测存活)。
   */
  it('target.blocking 走跨轮汇总 —— 最后一轮是协议失败时不许把它交给执行者', () => {
    const prefixed = `[集成官] ${PROTOCOL_NO_BLOCK}`
    const n = mk('x', {
      status: 'ACCEPTED', kind: 'executable',
      acceptLog: [
        {
          round: 1, step: 'integrate',
          verdicts: [{ role: '集成官', pass: false, blocking: ['datum.rs 不在集成工作区'], comments: '' }],
          synthesized: { pass: false, blockingSummary: '[集成官] datum.rs 不在集成工作区' },
        },
        {
          round: 3, step: 'integrate',
          verdicts: [{ role: '集成官', pass: false, blocking: [prefixed], comments: '' }],
          synthesized: { pass: false, blockingSummary: prefixed },
        },
      ],
    })
    const t = backtrackScope([n], 'x').targets[0]!
    expect(t.blocking).toContain('datum.rs 不在集成工作区')
    expect(t.blocking).not.toContain('裁决代码块')
  })

  /**
   * **补充提示词写在哪个键上跟着入口走。** 一个走 `integrate` 的拆分节点自己不跑执行环节,
   * 把意见写到 `execute` 键上 = 那句整改要求谁也读不到(变异测试实测存活)。
   */
  it('integrate 入口的意见写在 integrate 键上,plan 入口写在 all 上', () => {
    const nodes = [
      mk('P', { kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01'] }),
      mk('P/01', { parentId: 'P', kind: 'executable', status: 'ACCEPTED' }),
    ]
    const a = composeRedos(nodes, [{ nodeId: 'P', entry: 'integrate', guidance: '重点看 datum.rs' }], NOW)
    if ('error' in a) throw new Error(a.error)
    expect(a.nodes.find(n => n.id === 'P')!.guidance?.integrate).toContain('datum.rs')
    expect(a.nodes.find(n => n.id === 'P')!.guidance?.execute).toBeUndefined()

    const b = composeRedos(nodes, [{ nodeId: 'P/01', entry: 'plan', guidance: '整个重做' }], NOW)
    if ('error' in b) throw new Error(b.error)
    expect(b.nodes.find(n => n.id === 'P/01')!.guidance?.all).toContain('整个重做')
  })

  /**
   * **N 条 entry 只克隆一次全树。**
   *
   * 这是一条纯代价的变异(行为不变),所以只能量它:数 `structuredClone` 的调用次数。
   * 少了串接复用,.13 那个 run(2215 节点 / 86 MiB / 834 个符合条件)按一次 `b`
   * 就是几百次全树深拷贝,同步跑在按键处理里 —— 界面僵住几分钟。
   */
  it('三条 entry 的全树深拷贝次数 = 一棵树的节点数,不是三倍', () => {
    const nodes = [
      mk('root', { childIds: ['root/00-a', 'root/01-b', 'root/02-c'], status: 'ACCEPTED', kind: 'decompose' }),
      mk('root/00-a', { parentId: 'root', status: 'ACCEPTED', kind: 'executable' }),
      mk('root/01-b', { parentId: 'root', status: 'ACCEPTED', kind: 'executable' }),
      mk('root/02-c', { parentId: 'root', status: 'ACCEPTED', kind: 'executable' }),
    ]
    const real = globalThis.structuredClone
    let calls = 0
    globalThis.structuredClone = ((v: unknown) => { calls++; return real(v) }) as typeof structuredClone
    try {
      const r = composeRedos(nodes, [
        { nodeId: 'root/00-a', entry: 'execute' },
        { nodeId: 'root/01-b', entry: 'execute' },
        { nodeId: 'root/02-c', entry: 'execute' },
      ], NOW)
      if ('error' in r) throw new Error(r.error)
      // 三条都真的做了(别让这条用例在一次空回溯上「省」出好成绩)。
      expect(r.nodes.filter(n => n.status === 'READY')).toHaveLength(3)
    } finally {
      globalThis.structuredClone = real
    }
    expect(calls).toBe(nodes.length)
  })
})

/**
 * 规范席验收提出的三条,各自钉住。
 */
describe('规范席验收补漏', () => {
  /**
   * **确认屏点名的必须是真的会被重跑的那个。** 第 1 级真正送去 planRedo 的是 suspects,
   * 而上一版按 `t.node.title` 渲染 —— datum 场景下屏幕写「· P:datum.rs 不在集成工作区」,
   * 而 P 是拆分型节点,一个执行者都不会被派给它。
   */
  it('第 1 级印的是子任务(而且能印标题)', () => {
    const t: BacktrackTarget = {
      node: mk('P', { title: '父任务', childIds: ['P/01', 'P/02'] }),
      level: 1, blocking: 'datum.rs 不在集成工作区', remedy: [], suspects: ['P/02'],
    }
    const lines = backtrackLines([t], [{ nodeId: 'P/02', entry: 'execute' }], true,
      id => (id === 'P/02' ? '完整迁移 datum.go' : undefined)).join('\n')
    expect(lines).toContain('完整迁移 datum.go')
    expect(lines).toContain('1 个子任务')
    // 没有 titleOf 时退回印 id,而不是印成 undefined。
    const noTitle = backtrackLines([t], [{ nodeId: 'P/02', entry: 'execute' }], true).join('\n')
    expect(noTitle).toContain('P/02')
    expect(noTitle).not.toContain('undefined')
  })

  /**
   * **一条都没派出去的目标不许推进阶梯。** 第 2 级是不可逆的(删整片子树),
   * 而「跳过算不出来的那一条」造出了这条新路径。
   */
  it('这个目标名下一条都没派出去 → 轮次不加、闩不解', () => {
    const a = mk('a', { revised: true, childIds: ['a/00-x'] })
    const b = mk('b', { revised: true, childIds: ['b/00-y'] })
    const plan = { nodes: [a, b], deleted: [], dependencyRewrites: [], worktreesToRelease: [], seatedAt: 'READY' as const, reopenedAncestors: [], warnings: [] }
    const { rearmed } = markBacktracked(plan, [
      { node: a, level: 1, blocking: '', remedy: [], suspects: ['a/00-x'] },
      { node: b, level: 1, blocking: '', remedy: [], suspects: ['b/00-y'] },
    ], NOW, new Set(['a/00-x']))   // 只有 a 名下那个真的被派出去了
    expect(a.backtrack).toEqual({ rounds: 1, at: NOW })
    expect(b.backtrack).toBeUndefined()
    expect(rearmed).toEqual(['a'])
    expect(b.revised).toBe(true)
  })

  it('目标自己被派出去(叶子)也算', () => {
    const leaf = mk('c', { kind: 'executable' })
    const plan = { nodes: [leaf], deleted: [], dependencyRewrites: [], worktreesToRelease: [], seatedAt: 'READY' as const, reopenedAncestors: [], warnings: [] }
    markBacktracked(plan, [{ node: leaf, level: 1, blocking: '', remedy: [], suspects: [] }], NOW, new Set(['c']))
    expect(leaf.backtrack).toEqual({ rounds: 1, at: NOW })
  })
})

/**
 * 接缝席验收补漏:同一件事两处判据不一致,是这个仓库的固定病灶。
 */
describe('接缝席验收补漏', () => {
  const protocolRound = {
    round: 3, step: 'integrate' as const,
    verdicts: [{ role: '集成官', pass: false, blocking: [PROTOCOL_NO_BLOCK], comments: '' }],
    synthesized: { pass: false, blockingSummary: `[集成官] ${PROTOCOL_NO_BLOCK}` },
  }
  const realRound = {
    round: 1, step: 'integrate' as const,
    verdicts: [{
      role: '集成官', pass: false, blocking: ['datum.rs 不在集成工作区'], comments: '',
      remedy: [{ title: '补齐 sem/tree/datum.rs', deps: [] }],
    }],
    synthesized: { pass: false, blockingSummary: 'datum.rs 不在集成工作区' },
  }

  it('补救提案也跨轮取 —— 意见跨轮了而它没跨,就是两处判据不一致', () => {
    const n = mk('x', { status: 'ACCEPTED', kind: 'executable', acceptLog: [realRound, protocolRound] })
    const t = backtrackScope([n], 'x').targets[0]!
    expect(t.remedy).toEqual(['补齐 sem/tree/datum.rs'])
    expect(t.blocking).toContain('datum.rs 不在集成工作区')
  })

  /**
   * **同一屏两个数字不许打架。** 抬头按 target 数、末尾那行按 entry 数 ——
   * 一个「子任务全绿」的父任务会被抬头算进「走重新执行」,而它买到的是「只重新裁决」。
   */
  it('抬头的数字和末尾那行对得上', () => {
    const judgeOnly: BacktrackTarget = {
      node: mk('P', { title: '父任务', childIds: ['P/01'] }),
      level: 1, blocking: '缺 x', remedy: [], suspects: [],
    }
    const rerun: BacktrackTarget = {
      node: mk('Q', { title: '另一个', childIds: ['Q/01'] }),
      level: 1, blocking: '缺 y', remedy: [], suspects: ['Q/01'],
    }
    const lines = backtrackLines([judgeOnly, rerun], [
      { nodeId: 'P', entry: 'integrate' }, { nodeId: 'Q/01', entry: 'execute' },
    ]).join('\n')
    expect(lines).toContain('1 个任务走**重新执行**')
    expect(lines).toContain('1 个任务重跑执行阶段')
    expect(lines).toContain('1 个只重新裁决集成验收')
    expect(lines).not.toContain('2 个任务走**重新执行**')
  })
})


/**
 * **对抗席补的七条** —— `integrateFeedback` 的顺序和两个上限此前**一条探针都没有**,
 * 而这段文本是逐字塞进执行提示词的。
 */
describe('对抗席验收补漏', () => {
  const round = (r: number, blocking: string[], advice?: string[]): TaskNode['acceptLog'][number] => ({
    round: r, step: 'integrate',
    verdicts: [{ role: '测试', pass: false, blocking, comments: '', ...(advice ? { advice } : {}) }],
    synthesized: { pass: false, blockingSummary: blocking[0] ?? '' },
  })

  it('「多个裁决块」也不会被注入执行提示词', () => {
    const n = mk('x', { acceptLog: [round(1, [PROTOCOL_AMBIGUOUS])] })
    expect(integrateFeedback(n)).not.toContain('多个裁决块')
  })

  it('新的在前:最后一轮的意见排在前几轮之前', () => {
    expect(integrateFeedback(mk('x', { acceptLog: [round(1, ['旧意见']), round(2, ['新意见'])] })).split('\n'))
      .toEqual(['新意见', '旧意见'])
  })

  it('先具体后概括:同一轮里 blocking 全部排在 advice 之前', () => {
    expect(integrateFeedback(mk('x', { acceptLog: [round(1, ['阻断A'], ['建议A'])] })).split('\n'))
      .toEqual(['阻断A', '建议A'])
  })

  it('最多 12 条 —— 它会被逐字塞进执行提示词', () => {
    const s = integrateFeedback(mk('x', { acceptLog: [round(1, Array.from({ length: 30 }, (_, i) => `阻断${i}`))] }))
    expect(s.split('\n')).toHaveLength(12)
    expect(s).toContain('阻断0')
    expect(s).not.toContain('阻断12')
  })

  it('每条最多 600 字,超了截断并留省略号', () => {
    const s = integrateFeedback(mk('x', { acceptLog: [round(1, ['X'.repeat(1200)])] }))
    expect(s.length).toBe(601)
    expect(s.endsWith('…')).toBe(true)
  })

  it('没有子任务的叶子目标不算「只重新裁决 + 重新开放补救拆分」', () => {
    const leaf = mk('L', { kind: 'executable', childIds: [] })
    const targets: BacktrackTarget[] = [{ node: leaf, level: 1, blocking: '没过', remedy: [], suspects: [] }]
    expect(backtrackLines(targets, [{ nodeId: 'L', entry: 'execute' }], true).join('\n'))
      .not.toContain('重新开放补救拆分')
  })

  it('保守名单去重:同一个节点被两个目标同时点到,只出现一次', () => {
    const shared = mk('S', { kind: 'executable', status: 'BLOCKED' })
    const a = mk('A', { kind: 'decompose', childIds: ['S'] })
    const b = mk('B', { kind: 'decompose', childIds: ['S'] })
    const byId = new Map([a, b, shared].map(n => [n.id, n]))
    expect(conservativeEntries([
      { node: a, level: 1, blocking: '', remedy: [], suspects: ['S'] },
      { node: b, level: 1, blocking: '', remedy: [], suspects: ['S'] },
    ], byId).map(e => e.nodeId)).toEqual(['S'])
  })
})
