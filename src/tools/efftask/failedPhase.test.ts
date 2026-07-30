/**
 * 失败节点的两个快捷键 —— **快速重做失败的那个环节**、**跳过它继续往下走**。
 *
 * 用户的原话:「对于失败的任务,有键可以快速重做失败的阶段或跳过失败的阶段,继续往下走。
 * 重做失败的阶段,可以塞新的提示词给这个阶段」。
 *
 * 两个键都必须先回答同一个问题:**哪个阶段失败了**。这个文件从三个层次钉它:
 *
 *  1. `failedAt` 真的被记下来了(由 `commit()`,那是每一次 BLOCKED 的必经之路);
 *  2. 从它翻出来的环节、以及那个环节对应的**可重入入口**是对的;
 *  3. 跳过之后流水线真的**不重跑执行者**,而且真的跳过了那一关。
 *
 * 第 3 条只能跑真的 step 才看得见:`planSkip` 算出来的树在「跳过」和「什么都没做」之间
 * 长得几乎一样,差别全在 pipeline 认不认那个标记。
 */
import { describe, expect, it } from 'bun:test'
import {
  attachGuidance, failedPhaseOf, failedRedoTarget, guidanceScopeFor, planRedo, planSkip,
  skipFailedPhaseReason, skipSummary,
} from './redo.js'
import { commitForTest, stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
import { byIdMap } from './stateMachine.js'
import { reseatTransientNodes } from './reseat.js'
import { createRunControl } from './control.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM, MAX_GUIDANCE_CHARS } from './types.js'
import type { EffTaskConfig, NodeStatus, PhaseName, TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-30T00:00:00Z'
const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
function ctxFor(
  nodes: TaskNode[], runAgent: RunAgentFn, config: EffTaskConfig = cfg(),
  extra: Partial<PipelineCtx> = {},
): PipelineCtx {
  const byId = byIdMap(nodes)
  return {
    config, byId, runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
    ...extra,
  }
}

describe('失败点由 commit() 记下,不反推', () => {
  it('阻断时记下上一个状态;任何非阻断的推进都把它清掉', async () => {
    // 和 capCategory 逐字同因(见 TaskNode.failedAt):反推被卡片自己的建议打败过 ——
    // 卡片说「提高 maxIterations 后再重试」,用户照做,比较当场变假。
    const n = mk({ status: 'ACCEPTANCE' })
    const ctx = ctxFor([n], (async () => '') as unknown as RunAgentFn)
    await commitForTest(n, 'BLOCKED', ctx)
    expect(n.failedAt).toBe('ACCEPTANCE')
    await commitForTest(n, 'READY', ctx)
    expect(n.failedAt).toBeUndefined()
  })

  it('已经阻断的节点再被阻断一次,失败点不许被抹成 BLOCKED', async () => {
    // 抹掉的话,`failedPhaseOf` 拿到的是一个没有环节含义的状态,两个键当场失效 ——
    // 而这条路很常见:propagateBlocked 会对一个已经 BLOCKED 的节点再写一次理由。
    const n = mk({ status: 'VERIFYING' })
    const ctx = ctxFor([n], (async () => '') as unknown as RunAgentFn)
    await commitForTest(n, 'BLOCKED', ctx)
    await commitForTest(n, 'BLOCKED', ctx)
    expect(n.failedAt).toBe('VERIFYING')
  })

  it('落盘失败那条路记的是**正要进入**的那个环节', async () => {
    // 那一支把 status 改成 BLOCKED 并写下「状态持久化失败」,而它发生在进入 status 的路上。
    // 记 prev 的话,重做会重跑一个已经成功过的环节。
    const n = mk({ status: 'READY' })
    const ctx = ctxFor([n], (async () => '') as unknown as RunAgentFn, cfg(), {
      persist: async () => { throw new Error('盘满了') },
    })
    expect(await commitForTest(n, 'EXECUTING', ctx)).toBe(false)
    expect(n.status).toBe('BLOCKED')
    expect(n.failedAt).toBe('EXECUTING')
  })
})

describe('哪个环节失败了', () => {
  const at = (s: NodeStatus, over: Partial<TaskNode> = {}) =>
    mk({ status: 'BLOCKED', failedAt: s, ...over })

  it('十五个状态各自映到一个环节', () => {
    expect(failedPhaseOf(at('PLANNING'))).toBe('plan')
    expect(failedPhaseOf(at('CREATED'))).toBe('plan')
    expect(failedPhaseOf(at('PLAN_REVIEW'))).toBe('review')
    // stepExecute 是一个整体:READY 进,中途 EXECUTED/REWORK/MERGE 都在它里面。
    for (const s of ['READY', 'EXECUTING', 'EXECUTED', 'REWORK', 'MERGE'] as NodeStatus[]) {
      expect(failedPhaseOf(at(s))).toBe('execute')
    }
    expect(failedPhaseOf(at('VERIFYING'))).toBe('verify')
    expect(failedPhaseOf(at('ACCEPTANCE'))).toBe('accept')
    expect(failedPhaseOf(at('WAITING_CHILDREN'))).toBe('integrate')
    expect(failedPhaseOf(at('INTEGRATION_ACCEPT'))).toBe('integrate')
    expect(failedPhaseOf(at('SCORING'))).toBe('observer')
  })

  it('没阻断的节点没有失败环节 —— 哪怕盘上留着一个失败点', () => {
    // failedAt 是持久化的,而一个被重做过的节点可能还带着它(commit 会清,但纯函数层
    // 不能依赖那个顺序)。判据必须同时看 status。
    expect(failedPhaseOf(mk({ status: 'ACCEPTED', failedAt: 'ACCEPTANCE' }))).toBeUndefined()
    expect(failedPhaseOf(mk({ status: 'BLOCKED' }))).toBeUndefined()
  })
})

describe('快速重做:失败环节 → 可重入的入口', () => {
  const tree = (over: Partial<TaskNode> = {}): TaskNode[] => [mk({ kind: 'executable', ...over })]
  const target = (nodes: TaskNode[]) => failedRedoTarget(nodes[0]!, byIdMap(nodes))

  it('评审失败 → 从质疑讨论重做', () => {
    const r = target(tree({
      status: 'BLOCKED', failedAt: 'PLAN_REVIEW',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    }))
    expect(r).toEqual({ entry: 'review', phase: 'review' })
  })

  it('验收 / 测试验证 / 观察失败 → 从执行重做(它们跑在 stepExecute 内部)', () => {
    for (const [st, phase] of [['ACCEPTANCE', 'accept'], ['VERIFYING', 'verify'], ['SCORING', 'observer']] as const) {
      const r = target(tree({ status: 'BLOCKED', failedAt: st, kind: 'executable' }))
      expect(r).toEqual({ entry: 'execute', phase })
    }
  })

  it('拆分节点的同一批失败 → 从集成验收重做(它自己没有执行环节)', () => {
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'BLOCKED', failedAt: 'INTEGRATION_ACCEPT' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
    ]
    expect(failedRedoTarget(nodes[0]!, byIdMap(nodes))).toEqual({ entry: 'integrate', phase: 'integrate' })
  })

  it('拆分节点在**观察**环节失败 → 也去集成验收,不是执行', () => {
    /**
     * 观察评分跟在集成验收通过之后跑,所以一个拆分节点的评分环节失败时,重入点是集成验收。
     * 判成「从执行重做」的话,菜单上那一条对拆分任务是**禁用**的(它自己没有执行环节)——
     * 用户按 R 得到的是一句「不可用」,而真正走得通的那条就在旁边。
     *
     * 这是 `entryForPhase` 最后那一行 isDecomposed 分支唯一的可达入口:INTEGRATION_ACCEPT
     * 在它之前就被拦下了,所以只有这条路能证明那一行是活的(变异验证过)。
     */
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'BLOCKED', failedAt: 'SCORING' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
    ]
    expect(failedRedoTarget(nodes[0]!, byIdMap(nodes))).toEqual({ entry: 'integrate', phase: 'observer' })
  })

  it('没失败的节点:说清它没失败,并指向 r', () => {
    const r = target(tree({ status: 'ACCEPTED' }))
    expect('error' in r && r.error).toContain('没有失败')
    expect('error' in r && r.error).toContain('按 r')
  })

  it('不是自己失败的节点:指向真正该动的那个,而不是给一个动作', () => {
    /**
     * 这一条是 `failedAt` 只在节点自己失败时记的**全部理由**。`propagateBlocked` 写的
     * 「子节点阻断」如果也记失败点,这个父节点会拿到一个「重做集成验收」的动作 ——
     * 而真正挂掉的是它的孩子,重做父节点只会再一次等在同一个地方。
     */
    const r = target(tree({ status: 'BLOCKED', blockedReason: '子节点阻断' }))
    expect('error' in r && r.error).toContain('子任务')
  })

  it('树自己坏了(依赖成环之类):说清这不是某个环节失败', () => {
    const r = target(tree({ status: 'BLOCKED', blockedReason: '依赖成环' }))
    expect('error' in r && r.error).toContain('这棵树自己对不上')
  })

  it('入口在菜单上是禁用的时候,原因照抄菜单那一份', () => {
    // 授权判据只有一份(redoOptions)—— 屏幕上按不动的东西不许从快捷键这道旁门进去。
    // 一个 kind 还是 unknown 的节点坐不回执行环节的座位。
    const r = target(tree({ status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'unknown' }))
    expect('error' in r && r.error).toContain('还没有方案')
  })
})

describe('跳过失败环节:能不能跳', () => {
  const blocked = (over: Partial<TaskNode>): TaskNode =>
    mk({ status: 'BLOCKED', kind: 'executable', ...over })

  it('四个「判的人不放行」的环节可以跳', () => {
    expect(skipFailedPhaseReason(blocked({ failedAt: 'PLAN_REVIEW' }))).toBeUndefined()
    expect(skipFailedPhaseReason(blocked({ failedAt: 'VERIFYING' }))).toBeUndefined()
    expect(skipFailedPhaseReason(blocked({ failedAt: 'ACCEPTANCE' }))).toBeUndefined()
    expect(skipFailedPhaseReason(blocked({ failedAt: 'INTEGRATION_ACCEPT', childIds: ['x'] }))).toBeUndefined()
  })

  it('分析和执行**不能跳**,而且说清那叫放弃、以及去哪儿', () => {
    /**
     * 跳过分析 = 带着空方案进评审;跳过执行 = 一行代码都不写就去验收。给它们一个「跳过」
     * 按钮就是把「放弃这个节点」伪装成一次跳过 —— 而放弃有它自己的入口(启动关口的
     * skipSteps,那里会摆明后果让用户批准)。
     */
    const p = skipFailedPhaseReason(blocked({ failedAt: 'PLANNING' }))
    expect(p).toContain('空方案')
    expect(p).toContain('skipSteps')
    const e = skipFailedPhaseReason(blocked({ failedAt: 'EXECUTING' }))
    expect(e).toContain('什么都没做')
    expect(e).toContain('从执行重做')
  })

  it('隔离运行 + 工作区引用丢了 → 不许跳过验收', () => {
    /**
     * 跳过验收会走到合并,而 `mergeAndRelease` 在 `!node.worktree` 时直接 `return true` ——
     * 节点被判「已验收」,产出一行都没进集成分支。这正是「不谎报完成」那一条。
     */
    const why = skipFailedPhaseReason(blocked({ failedAt: 'ACCEPTANCE' }), { isolated: true })
    expect(why).toContain('空工作区')
    // 工作区还在:放行。
    expect(skipFailedPhaseReason(
      blocked({ failedAt: 'ACCEPTANCE', worktree: { branch: 'b', path: '/wt' } }), { isolated: true },
    )).toBeUndefined()
    // 非隔离运行:执行者直接写在用户的检出里,产出已经在那儿了。
    expect(skipFailedPhaseReason(blocked({ failedAt: 'ACCEPTANCE' }), { isolated: false })).toBeUndefined()
  })

  it('kind 还不是执行型时不许坐回执行座位', () => {
    // advanceableKind 对 READY + unknown 返回 null —— 节点既不可推进也不是终态,
    // run 以「存在无法推进的阻断节点」结束而节点上没有任何理由。
    expect(skipFailedPhaseReason(blocked({ failedAt: 'ACCEPTANCE', kind: 'unknown' }))).toContain('执行型')
  })

  it('没有子任务的节点不存在集成验收', () => {
    expect(skipFailedPhaseReason(blocked({ failedAt: 'INTEGRATION_ACCEPT' }))).toContain('没有子任务')
  })
})

describe('planSkip 算出来的树', () => {
  const ok = (r: ReturnType<typeof planSkip>) => {
    if ('error' in r) throw new Error(`planSkip 失败: ${r.error}`)
    return r
  }

  it('跳过评审:座位回到 CREATED + redoFrom=review + skipPhase=review', () => {
    const nodes = [mk({
      status: 'BLOCKED', failedAt: 'PLAN_REVIEW', kind: 'executable', capBlocked: true, capCategory: 'rework',
      blockedReason: '方案评审迭代超限(3)',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })]
    const r = ok(planSkip(nodes, 'root', NOW))
    const t = r.nodes.find(n => n.id === 'root')!
    expect(t.status).toBe('CREATED')
    expect(t.redoFrom).toBe('review')
    expect(t.skipPhase).toBe('review')
    // 阻断态的每一个开关都要解开 —— 少任何一个,重做出来的座位是够不到的。
    expect(t.blockedReason).toBe('')
    expect(t.capBlocked).toBe(false)
    expect(t.capCategory).toBeUndefined()
    expect(t.failedAt).toBeUndefined()
    expect(t.startedAt).toBeUndefined()
    // 方案一个字不动 —— 跳过的是「有没有人质疑它」。
    expect(t.plan.solution).toBe('s')
  })

  it('跳过验收:座位 READY,验收/评分预算清零', () => {
    const nodes = [mk({
      status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'executable',
      iteration: { planReview: 1, acceptance: 3, integration: 0, scoring: 2, mergeResolve: 1 },
    })]
    const t = ok(planSkip(nodes, 'root', NOW)).nodes.find(n => n.id === 'root')!
    expect(t.status).toBe('READY')
    expect(t.skipPhase).toBe('accept')
    expect(t.iteration.acceptance).toBe(0)
    expect(t.iteration.scoring).toBe(0)
    // 方案评审那份预算不动:这次跳过没打算让它重新出方案。
    expect(t.iteration.planReview).toBe(1)
  })

  it('跳过测试验证:同样清零 —— 它的失败也记在 acceptance 上', () => {
    /**
     * 测试验证失败走的是 `iteration.acceptance++`(和验收共用一份预算)。不清零的话,
     * 跳过测试验证之后那一桌验收只要不通过就当场再次阻断,一次返工机会都没有 ——
     * 而用户按这个键的意思是「让它继续往下走」。
     */
    const nodes = [mk({
      status: 'BLOCKED', failedAt: 'VERIFYING', kind: 'executable',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })]
    const t = ok(planSkip(nodes, 'root', NOW)).nodes.find(n => n.id === 'root')!
    expect(t.skipPhase).toBe('verify')
    expect(t.iteration.acceptance).toBe(0)
  })

  it('跳过集成验收:座位回到等子任务,子任务一个不动', () => {
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'BLOCKED', failedAt: 'INTEGRATION_ACCEPT' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
    ]
    const r = ok(planSkip(nodes, 'root', NOW))
    expect(r.nodes.find(n => n.id === 'root')!.status).toBe('WAITING_CHILDREN')
    expect(r.nodes.find(n => n.id === 'root')!.skipPhase).toBe('integrate')
    expect(r.deleted).toEqual([])
    expect(r.nodes.find(n => n.id === 'root/01-a')!.status).toBe('ACCEPTED')
  })

  it('祖先被一并解开 —— 否则这次跳过一次模型调用都不会发生', () => {
    /**
     * `orchestrator.run()` 的第一句是 `if (root.status === 'ACCEPTED') return completed`。
     * 一个跑成功的 run,root 必然 ACCEPTED —— 不解开祖先,用户按下确认之后界面闪一下就
     * 回到同一屏。这是 reseat.ts 实测过的失败,不是推理。
     */
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'ACCEPTED' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED', failedAt: 'ACCEPTANCE' }),
    ]
    const r = ok(planSkip(nodes, 'root/01-a', NOW))
    expect(r.reopenedAncestors).toEqual(['root'])
    expect(r.nodes.find(n => n.id === 'root')!.status).toBe('WAITING_CHILDREN')
    expect(r.warnings.some(w => w.includes('集成验收'))).toBe(true)
  })

  it('重做会清掉上一次的手工跳过标记', () => {
    /**
     * 一次性的标记留着的话:用户跳过了验收,产出合进了集成分支;后来他按 r 重跑执行环节,
     * 新产出会**再一次**不经验收就合进去 —— 而这次他什么都没同意,屏幕上也什么都没说。
     * 重做是用户重新做的选择,上一次的跳过不该跟着走。
     */
    const nodes = [mk({
      status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'executable', skipPhase: 'accept',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })]
    const r = planRedo(nodes, 'root', 'execute', NOW)
    if ('error' in r) throw new Error(r.error)
    expect(r.nodes.find(n => n.id === 'root')!.skipPhase).toBeUndefined()
  })

  it('不能跳的时候返回原因,而且和屏幕上那一份是同一句', () => {
    const nodes = [mk({ status: 'BLOCKED', failedAt: 'EXECUTING', kind: 'executable' })]
    const r = planSkip(nodes, 'root', NOW)
    expect('error' in r).toBe(true)
    expect('error' in r && r.error).toBe(skipFailedPhaseReason(nodes[0]!))
  })

  it('摘要照实说「之后会跑什么」——**这一轮真的不跑的一个都不许出现**', () => {
    /**
     * 三份评审各自独立报了同一条:「之后会跑: 执行」紧跟着「执行环节不重跑」,两行同屏
     * 自相矛盾。而默认配置(测试验证/观察 0 席)下 `rest` **只有** execute,那一行 100% 假。
     *
     * 第一版的断言只写了 `not.toContain('测试验证')`,对「执行」一个字没说 —— 验收造了一条
     * **反向**变异(把 execute 正确剔掉)结果 SURVIVED:对着那条测试,写对和写错是同一件事。
     */
    const nodes = [mk({ status: 'BLOCKED', failedAt: 'VERIFYING', kind: 'executable' })]
    const r = ok(planSkip(nodes, 'root', NOW))
    const lines = skipSummary(r, nodes[0]!, 'verify', { seatCount: { verify: 1 } })
    expect(lines[0]).toContain('测试验证')
    const after = lines.find(l => l.startsWith('之后会跑'))!
    expect(after).toContain('验收')
    expect(after).not.toContain('测试验证')
    // 执行环节这一轮不跑(尾部入口),所以不许写进「之后会跑」。
    expect(after).not.toContain('执行')
    // 这次跳过最容易被误解的地方:它**不重跑执行者**。
    expect(lines.some(l => l.includes('执行环节不重跑'))).toBe(true)
  })

  it('跳过验收:默认配置下之后一个环节都不跑,那就说那句话', () => {
    // 跳过 accept 时 execute 和 verify 都不跑(verify 在上一轮已经过了),而默认配置下
    // observer 是 0 席 —— 于是 rest 是空的,该印的是同一个函数里已经写好的另一支。
    const nodes = [mk({ status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'executable' })]
    const r = ok(planSkip(nodes, 'root', NOW))
    const lines = skipSummary(r, nodes[0]!, 'accept', {})
    expect(lines.some(l => l.includes('之后没有别的环节了,本节点会直接判为已验收'))).toBe(true)
    expect(lines.some(l => l.startsWith('之后会跑'))).toBe(false)
    // 而且要说清测试验证也不重跑 —— 否则用户会以为它还会再验一遍。
    expect(lines.some(l => l.includes('本轮测试验证也不重跑'))).toBe(true)
  })

  it('跳过质疑讨论时**不许**说「返工计数清零」—— 那一支一个计数都没清', () => {
    // 评审实测:planSkip 的 review 分支不重置任何 iteration(planReview 3→3, acceptance 3→3),
    // 而这句话原来是无条件印的。关口上一句一半时候为假的承诺。
    const nodes = [mk({
      status: 'BLOCKED', failedAt: 'PLAN_REVIEW', kind: 'executable',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
      iteration: { planReview: 3, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })]
    const r = ok(planSkip(nodes, 'root', NOW))
    const t = r.nodes.find(n => n.id === 'root')!
    expect([t.iteration.planReview, t.iteration.acceptance]).toEqual([3, 3])
    expect(skipSummary(r, nodes[0]!, 'review', {}).some(l => l.includes('返工计数清零'))).toBe(false)
    // 反向:真的清了的那两跳照说。
    const acc = [mk({ status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'executable' })]
    const ra = ok(planSkip(acc, 'root', NOW))
    expect(skipSummary(ra, acc[0]!, 'accept', {}).some(l => l.includes('返工计数清零'))).toBe(true)
  })
})

describe('流水线真的认这个标记', () => {
  it('跳过评审:一次评审调用都不发,方案原样往下走', async () => {
    const n = mk({
      status: 'CREATED', kind: 'executable', redoFrom: 'review', skipPhase: 'review',
      plan: { solution: '原方案', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    const ctx = ctxFor([n], (async (req: { phase: string }) => {
      phases.push(req.phase)
      throw new Error('不该有任何调用')
    }) as unknown as RunAgentFn)
    await stepStart(n, ctx)
    expect(phases).toEqual([])
    expect(n.status).toBe('READY')
    expect(n.plan.solution).toBe('原方案')
    expect(n.reviewLog).toHaveLength(0) // 跳过 ≠ 通过
    expect(n.execStatus).toContain('手工跳过')
    // 一次性:消费掉了。
    expect(n.skipPhase).toBeUndefined()
  })

  it('跳过验收:**不重跑执行者**,直接合并收工', async () => {
    /**
     * 这是整个「跳过」里最要紧的一条。用户要跳过的是**判决**,不是重做工作 —— 少了
     * `enterAtJudge` 那一支,跳过验收会先派一次执行者:多花一次最贵的调用,而且它会改动
     * 代码,把用户刚刚亲自看过、决定放行的那份产出换成另一份没人看过的。
     */
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'accept',
      execStatus: '我改了 src/a.ts',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    const ctx = ctxFor([n], (async (req: { phase: string }) => {
      phases.push(req.phase)
      throw new Error('不该有任何调用')
    }) as unknown as RunAgentFn)
    await stepExecute(n, ctx)
    expect(phases).toEqual([])
    expect(n.status).toBe('ACCEPTED')
    // 上一轮的产出原样保留 —— 它就是这次放行的东西。
    expect(n.execStatus).toContain('我改了 src/a.ts')
    expect(n.execStatus).toContain('手工跳过')
    expect(n.acceptLog).toHaveLength(0)
    expect(n.skipPhase).toBeUndefined()
  })

  it('跳过测试验证:执行者不重跑,但验收照开', async () => {
    const roles = emptyPhaseRoles()
    roles.verify = [{ roleName: '测试官' }]
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'verify', phaseRoles: roles,
      execStatus: '我改了 src/a.ts',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg({ phaseRoles: roles }))
    await stepExecute(n, ctx)
    // 只有验收那一桌。执行和测试验证都没发生。
    expect(phases).toEqual(['accept'])
    expect(n.status).toBe('ACCEPTED')
    expect(n.execStatus).toContain('测试验证环节被手工跳过')
    expect(n.skipPhase).toBeUndefined()
  })

  it('跳过集成验收:一次调用都不发,父节点直接判过', async () => {
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'WAITING_CHILDREN', skipPhase: 'integrate' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
    ]
    const phases: string[] = []
    const ctx = ctxFor(nodes, (async (req: { phase: string }) => {
      phases.push(req.phase)
      throw new Error('不该有任何调用')
    }) as unknown as RunAgentFn)
    await stepIntegrate(nodes[0]!, ctx)
    expect(phases).toEqual([])
    expect(nodes[0]!.status).toBe('ACCEPTED')
    expect(nodes[0]!.execStatus).toContain('集成验收被手工跳过')
    expect(nodes[0]!.skipPhase).toBeUndefined()
  })

  it('返工轮**照常从执行者开始** —— 豁免只作用于第一轮', async () => {
    /**
     * 跳过测试验证之后那一桌验收如果不通过,节点走返工。那一轮必须真的派执行者去改代码,
     * 否则它会在同一份产出上反复挨同一个验收判决,烧完预算再阻断 —— 而每一轮都零产出。
     */
    const roles = emptyPhaseRoles()
    roles.verify = [{ roleName: '测试官' }]
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'verify', phaseRoles: roles,
      execStatus: '第一版', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    let accepts = 0
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      if (req.phase === 'execute') return '```json\n{"execStatus":"第二版"}\n```'
      if (req.phase === 'accept') {
        accepts++
        // 第一次不通过 → 返工;第二次通过。
        //
        // 通过那次 `blocking` 必须是**空的**:合成规则把「有 blocking」也算作反对
        // (见 isInfraOnlyFailure 的判据),留一条在里面会让 pass:true 照样被判不通过 ——
        // 第一版这么写,三轮全灭、节点以「验收迭代超限」阻断。
        return accepts > 1
          ? vtag(req) + '\n{"pass":true,"blocking":[],"comments":"c"}\n```'
          : vtag(req) + '\n{"pass":false,"blocking":["还差点"],"comments":"c"}\n```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg({ phaseRoles: roles }))
    await stepExecute(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    // 第一轮:只有验收(执行被豁免)。第二轮:执行 → 测试验证 → 验收。
    expect(phases).toEqual(['accept', 'execute', 'verify', 'accept'])
  })

  it('隔离运行里工作区引用丢了 → 退化成正常跑一轮,并且说出来', async () => {
    /**
     * 纵深防御。关口那侧(skipFailedPhaseReason)已经用同一条判据挡在前面了,但盘上的
     * node.md 可以手工编辑 —— 一个带着 `skipPhase: accept` 而没有 worktree 的节点,
     * 硬着头皮跳过去的后果是把一个空工作区合进集成分支并判「已验收」。
     */
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'accept',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      if (req.phase === 'execute') return '```json\n{"execStatus":"重做了一遍"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg(), {
      // biome-ignore lint/suspicious/noExplicitAny: 只需要 acquire / commitAndMerge 两个方法
      worktrees: {
        acquire: async () => ({ branch: 'b', path: '/wt', gitRoot: '/g' }),
        commitAndMerge: async () => ({ ok: true, merged: true }),
        release: async () => ({ removed: true }),
        integrationBranchName: 'int',
      } as any,
    })
    await stepExecute(n, ctx)
    // 执行环节真的跑了 —— 没有硬着头皮跳。
    expect(phases[0]).toBe('execute')
    expect(n.execStatus).toContain('隔离工作区引用已经不在了')
  })
})

describe('补一句提示词给这个节点', () => {
  it('按环节存,同一处再写一次是替换', () => {
    // 用户的说法是「塞**新的**提示词」:追加会让两条互相打架,而模型看不出哪句更新。
    const n = mk()
    attachGuidance(n, 'execute', '别动 src/legacy')
    attachGuidance(n, 'review', '重点看并发')
    expect(n.guidance).toEqual({ execute: '别动 src/legacy', review: '重点看并发' })
    attachGuidance(n, 'execute', '改用 zod')
    expect(n.guidance!.execute).toBe('改用 zod')
  })

  it('空串是清掉那一条;清完最后一条就整个不留', () => {
    const n = mk()
    attachGuidance(n, 'all', '注意兼容')
    attachGuidance(n, 'all', '   ')
    expect(n.guidance).toBeUndefined()
  })

  it('按**码点**夹取,不许把 emoji 劈成半个代理对', () => {
    // `.slice` 会留下一个孤立的高代理,而它会原样进提示词(control.addDirective 踩过
    // 同一个坑)。
    const n = mk()
    attachGuidance(n, 'all', '😀'.repeat(MAX_GUIDANCE_CHARS + 50))
    const kept = n.guidance!.all!
    expect(Array.from(kept)).toHaveLength(MAX_GUIDANCE_CHARS)
    expect(kept).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('任务重做给整个节点,阶段重做只给那个环节', () => {
    // 用户的两句原话分别对应这两个去处,写死一个会让另一句失效。
    expect(guidanceScopeFor('plan', 'task')).toBe('all')
    expect(guidanceScopeFor('execute', 'phase')).toBe('execute')
    expect(guidanceScopeFor('review', 'phase')).toBe('review')
  })
})

describe('三份评审查出来的那几条', () => {
  /**
   * 每一条都带着评审的复现路径。它们的共同形状是:一个**一次性**的决定或一个**过期**的
   * 记录活过了它该活的那一刻,然后在很久以后静默生效。
   */

  it('P0:一次性的手工跳过不许跨过一次阻断活下来', async () => {
    /**
     * 评审实跑:按 `s` 跳过验收 → 第一轮测试验证打回 → 第二轮执行者在飞时 Esc →
     * 节点 BLOCKED 而 `skipPhase='accept'` 原样留在盘上 → `--resume` 归位 READY →
     * `enterAtJudge` 再一次为真 → **执行环节一次都不跑**,半成品被判「已验收」。
     *
     * 非隔离运行必然走这条:`ctx.worktrees === undefined` 让 `enterAtJudge` 恒真,
     * `node.worktree` 那道纵深防御失效。
     */
    const n = mk({
      status: 'EXECUTING', kind: 'executable', skipPhase: 'accept',
      execStatus: '我改了一半', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const ac = new AbortController()
    ac.abort()
    const ctx = ctxFor([n], (async () => { throw new Error('不该被调用') }) as unknown as RunAgentFn, cfg(), { signal: ac.signal })
    await stepExecute(n, ctx)
    expect(n.status).toBe('BLOCKED')
    // 阻断的那一刻标记就作废了 —— 恢复之后验收照常开会,这是诚实的退化。
    expect(n.skipPhase).toBeUndefined()
  })

  it('P0:被牵连的阻断要**清掉**过期的失败点,不只是不记', () => {
    /**
     * 评审实跑:root 真在集成验收超限 → 用户在某个子任务上按 R(完全合理)→ root 被重开
     * 而 failedAt 留着 → 那个子任务又挂 → propagateBlocked 写「子节点阻断」而失败点仍是旧的
     * → **`s` 在 root 上放行** → 落下 skipPhase='integrate' → 用户后来修好子任务 →
     * 整棵树的最终裁决**一次都没发生**,acceptLog 空,run 报 completed。
     */
    const nodes = [
      mk({
        id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'BLOCKED',
        failedAt: 'INTEGRATION_ACCEPT', capBlocked: true, capCategory: 'cap-iteration',
      }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED', failedAt: 'ACCEPTANCE' }),
    ]
    const r = planRedo(nodes, 'root/01-a', 'execute', NOW)
    if ('error' in r) throw new Error(r.error)
    const root = r.nodes.find(n => n.id === 'root')!
    // 祖先被重开 —— 而它的失败点必须跟着 capBlocked 一起清掉。
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(root.capBlocked).toBe(false)
    expect(root.failedAt).toBeUndefined()
    // 于是 s 在它上面**不再放行**:它此刻不是一个「自己失败了」的节点。
    expect(skipFailedPhaseReason(root)).toBeDefined()
  })

  it('P1:恢复时「预算已耗尽」的阻断要记下失败点 —— 那是最需要 s 的一类节点', () => {
    // 活干完了、判的人没预算了。不记的话 R 回「这条记录来自更早的版本」、s 回「看不出」,
    // 两个新键在它身上全废。
    const n = mk({
      status: 'ACCEPTANCE', kind: 'executable', interrupted: true, execStatus: '干完了',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('预算已耗尽')
    expect(n.failedAt).toBe('ACCEPTANCE')
    // 而且 s 现在放行(有产出可跳)。
    expect(skipFailedPhaseReason(n)).toBeUndefined()
  })

  it('归位一个节点时,失败点和手工跳过标记都作废', () => {
    const n = mk({
      status: 'EXECUTING', kind: 'executable', interrupted: true,
      failedAt: 'ACCEPTANCE', skipPhase: 'accept', execStatus: '干了一半',
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('READY')
    expect(n.failedAt).toBeUndefined()
    expect(n.skipPhase).toBeUndefined()
  })

  it('落盘失败在**进入已验收**的路上时,记的是上一个环节而不是 ACCEPTED', async () => {
    // ACCEPTED 没有环节含义(STATUS_PHASE 里没有它),记上去的话 R 会说
    // 「看不出是哪个环节失败的(被手工改过)」—— 把一次磁盘错误说成用户改过文件。
    const n = mk({ status: 'MERGE', kind: 'executable' })
    const ctx = ctxFor([n], (async () => '') as unknown as RunAgentFn, cfg(), {
      persist: async () => { throw new Error('磁盘满') },
    })
    expect(await commitForTest(n, 'ACCEPTED', ctx)).toBe(false)
    expect(n.failedAt).toBe('MERGE')
    expect(failedPhaseOf(n)).toBe('execute')
  })

  it('跳过验收时**这一轮的测试验证也不跑** —— 它在上一轮已经过了', async () => {
    /**
     * 评审实跑:尾部入口落在判决段**开头**而测试验证在段内,于是「跳过验收」换来的是
     * 2 次测试验证调用;让它判不通过更糟 —— 5 次调用 + 一个换了环节的阻断
     * (「测试验证迭代超限」),而关口那张表写的是「之后只有评分」。
     */
    const roles = emptyPhaseRoles()
    roles.verify = [{ roleName: '测试官' }]
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'accept', phaseRoles: roles,
      execStatus: '干完了', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg({ phaseRoles: roles }))
    await stepExecute(n, ctx)
    expect(phases).toEqual([])   // 执行、测试验证、验收 —— 一次调用都没有
    expect(n.status).toBe('ACCEPTED')
    expect(n.execStatus).toContain('本轮测试验证未重跑')
  })

  it('但返工轮的测试验证照跑 —— 那时工作区里是新产出', async () => {
    const roles = emptyPhaseRoles()
    roles.verify = [{ roleName: '测试官' }]
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'verify', phaseRoles: roles,
      execStatus: '第一版', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    let accepts = 0
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      if (req.phase === 'execute') return '```json\n{"execStatus":"第二版"}\n```'
      if (req.phase === 'accept') {
        accepts++
        return accepts > 1
          ? vtag(req) + '\n{"pass":true,"blocking":[],"comments":"c"}\n```'
          : vtag(req) + '\n{"pass":false,"blocking":["还差点"],"comments":"c"}\n```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg({ phaseRoles: roles }))
    await stepExecute(n, ctx)
    expect(phases).toEqual(['accept', 'execute', 'verify', 'accept'])
  })
})

describe('那条测试验证豁免只活一轮 —— 低分返工是它唯一的可达证明', () => {
  it('跳过验收 + 观察打低分返工 → 第二轮的测试验证**照跑**', async () => {
    /**
     * 「跳过验收」通常一轮就收工(合并 → 已验收),所以那句 `skipVerifyThisRound = false`
     * 唯一的可达路径是**评分触发的返工**:跳过验收之后 `scoreNode` 仍然会跑,低于
     * `caps.scoreThreshold` 时节点回 REWORK 再来一轮 —— 那一轮工作区里是新产出,
     * 测试验证必须真的再验一遍。
     *
     * 不清掉的话第二轮的测试验证也被跳过,而那时的产出**从来没有人验过**。
     * (变异验证:去掉那一行,只有这条用例会红。)
     */
    const roles = emptyPhaseRoles()
    roles.verify = [{ roleName: '测试官' }]
    roles.observer = [{ roleName: '观察员' }]
    const n = mk({
      status: 'READY', kind: 'executable', skipPhase: 'accept', phaseRoles: roles,
      execStatus: '第一版', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    })
    const phases: string[] = []
    let scores = 0
    const ctx = ctxFor([n], (async (req: { phase: string; prompt: string }) => {
      phases.push(req.phase)
      if (req.phase === 'execute') return '```json\n{"execStatus":"第二版"}\n```'
      if (req.phase === 'observer') {
        scores++
        const s = scores === 1 ? 10 : 95
        const tag = req.prompt.match(/```(score[a-z]+)/)?.[1] ?? 'score'
        return '```' + tag + `\n{"plan":{"score":${s},"rationale":"r"},"exec":{"score":${s},"rationale":"r"}}\n` + '```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn, cfg({ phaseRoles: roles, caps: { ...DEFAULT_CAPS, scoreThreshold: 80 } }))
    await stepExecute(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    // 第一轮:执行/测试验证/验收全跳过,只有观察(打了 10 分)→ 返工。
    // 第二轮:执行 → 测试验证 → 验收 → 观察(95 分)→ 通过。
    expect(phases).toEqual(['observer', 'execute', 'verify', 'accept', 'observer'])
  })
})

describe('下游兄弟被解开时,过期的失败点也要清', () => {
  it('依赖阻断解开之后,s 不许照一个上辈子的失败点放行', () => {
    /**
     * 和 `reopenAncestor` 那一条同因,只是走的是另一扇门:B 依赖 A,A 被重做 →
     * B 那条「依赖阻断」被解开。B 身上可能还留着**它自己上一次**失败的记录,而它此刻
     * 正要重新起跑 —— 留着的话 `s` 会在一个刚被放回队列的节点上提供「跳过验收」,
     * 而它这一轮连执行都还没跑。
     */
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a', 'root/02-b'], status: 'WAITING_CHILDREN' }),
      mk({
        id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
        failedAt: 'ACCEPTANCE', execStatus: '干过一轮',
      }),
      mk({
        id: 'root/02-b', parentId: 'root', depth: 1, kind: 'executable', deps: ['root/01-a'],
        status: 'BLOCKED', blockedReason: '依赖阻断', failedAt: 'ACCEPTANCE', execStatus: '也干过一轮',
      }),
    ]
    const r = planRedo(nodes, 'root/01-a', 'execute', NOW)
    if ('error' in r) throw new Error(r.error)
    const b = r.nodes.find(n => n.id === 'root/02-b')!
    // 被解开了 —— 而且失败点作废。
    expect(b.status).toBe('READY')
    expect(b.blockedReason).toBe('')
    expect(b.failedAt).toBeUndefined()
    // 于是 s 在它上面不再放行(它此刻根本不是一个失败节点)。
    expect(skipFailedPhaseReason(b)).toContain('没有失败')
  })
})

describe('验收员 C 查出来的那几条', () => {
  it('propagateBlocked 真的清掉过期的失败点 —— 不是靠注释', async () => {
    /**
     * 原来唯一的护栏是对 orchestrator.ts 里一句**注释**的 grep,而验收指出:把清理那一行
     * 删掉、注释留着,断言照样绿。所以这条改成真跑编排器:让子节点失败,父节点被
     * propagateBlocked 扫成 BLOCKED,然后看它身上那个**上一辈子**的失败点在不在。
     */
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'WAITING_CHILDREN', failedAt: 'INTEGRATION_ACCEPT' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED', blockedReason: '执行失败' }),
    ]
    const orch = new EffTaskOrchestrator(
      cfg(),
      {
        runAgent: (async () => { throw new Error('不该被调用') }) as unknown as RunAgentFn,
        persist: async () => {}, now: () => NOW, onUpdate: () => {},
      },
      new AbortController().signal,
      nodes,
    )
    const out = await orch.run()
    expect(out.status).toBe('blocked')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toBe('子节点阻断')
    // 过期的失败点被清掉了 —— 于是 R/s 在它上面照实说「这个节点不是自己失败的」。
    expect(root.failedAt).toBeUndefined()
    expect(skipFailedPhaseReason(root)).toContain('子任务')
  })

  it('调并发度**不碰**已登记的在飞调用 —— 一个都不 abort', () => {
    /**
     * 「在跑的任务不受影响」这条,编排器那一档的测试注入的是假 runAgent,而
     * `registerCall` 只接在 `runAgentAdapter` 里 —— 于是「让 setParallelism abort 掉所有在飞
     * 控制器」这条变异**存活**(验收实测)。这里直接在 RunControl 这一层验:登记几个真的
     * AbortController,反复调整上限,一个都不许被 abort。
     */
    const c = createRunControl()
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const offs = controllers.map((ac, i) => c.registerCall(`n${i}`, ac))
    for (const n of [1, 8, 2, 64, 1, 5]) c.setParallelism(n)
    expect(controllers.map(ac => ac.signal.aborted)).toEqual([false, false, false])
    // 对照:cancelNode 才是那个会 abort 的动作 —— 探针因此不是空的。
    c.cancelNode('n1')
    expect(controllers.map(ac => ac.signal.aborted)).toEqual([false, true, false])
    for (const off of offs) off()
  })
})

describe('四跳的 ⚠ 一个都不许空', () => {
  it('每一种跳过都至少有一条 ⚠ 说清换掉了什么质量保证', () => {
    /**
     * 关口用 ⚠ 标「这一跳换掉了什么」,而那些 ⚠ 全部来自 `plan.warnings` —— 验收实测:
     * 跳过质疑讨论和跳过测试验证的 ⚠ 条数**都是 0**,而这两个恰恰是最明显的两个
     * (方案没人质疑就往下走、一个测试都不实跑)。README 承诺这一屏会用 ⚠ 标出来。
     */
    const cases: { phase: PhaseName; nodes: TaskNode[] }[] = [
      {
        phase: 'review',
        nodes: [mk({
          status: 'BLOCKED', failedAt: 'PLAN_REVIEW', kind: 'executable',
          plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
        })],
      },
      { phase: 'verify', nodes: [mk({ status: 'BLOCKED', failedAt: 'VERIFYING', kind: 'executable', execStatus: '干完了' })] },
      { phase: 'accept', nodes: [mk({ status: 'BLOCKED', failedAt: 'ACCEPTANCE', kind: 'executable', execStatus: '干完了' })] },
      {
        phase: 'integrate',
        nodes: [
          mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'BLOCKED', failedAt: 'INTEGRATION_ACCEPT' }),
          mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
        ],
      },
    ]
    for (const { phase, nodes } of cases) {
      const r = planSkip(nodes, 'root', NOW)
      if ('error' in r) throw new Error(`${phase}: ${r.error}`)
      const warned = skipSummary(r, nodes[0]!, phase, {}).filter(l => l.startsWith('⚠'))
      expect(`${phase} 的 ⚠ 条数: ${warned.length}`).not.toBe(`${phase} 的 ⚠ 条数: 0`)
    }
  })
})
