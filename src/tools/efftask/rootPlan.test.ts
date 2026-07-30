import { describe, expect, it } from 'bun:test'
import { applyRootDraft, buildRootPlanNoticeCard, childLines, draftBlockers, planGaps, isBetterDraft, draftRootPlan, makeRootNode, rootTitle, type RootDraft } from './rootPlan.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import { PipelineCtx, stepStart } from './pipeline.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, emptyPlan, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '做一个支付回调', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})

function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn, config = cfg()): PipelineCtx {
  const byId = byIdMap(nodes)
  return {
    config, byId, runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
  }
}

const PLAN_REPLY =
  '```json\n{"kind":"decompose","solution":"三步走:先设计接口,再实现服务,最后补集成测试并接上回调验签","keyPoints":"要点","risks":"风险","acceptance":"验收点",' +
  '"children":[{"title":"设计接口","deps":[]},{"title":"实现服务","deps":["设计接口"]}]}\n```'

describe('根方案关口 · 起草', () => {
  it('drafts the root plan and the FIRST level only', async () => {
    const c = cfg()
    const root = makeRootNode(c, NOW)
    const res = await draftRootPlan({ root, config: c, runAgent: async () => PLAN_REPLY, signal: new AbortController().signal })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.draft.kind).toBe('decompose')
    expect(res.draft.plan.solution).toContain('三步走')
    expect(res.draft.plan.acceptance).toBe('验收点')
    expect(res.draft.children.map(c2 => c2.title)).toEqual(['设计接口', '实现服务'])
    // Only the first level: nothing here creates grandchildren.
    expect(res.draft.children.every(c2 => Object.keys(c2).sort().join() === 'deps,title')).toBe(true)
  })

  it('asks the plan role the SAME question the run would have asked', async () => {
    // The gate exists so the user approves the run's own plan. A bespoke prompt here would
    // make them approve an answer to a different question — visible only after the gate.
    const c = cfg({ caps: { ...DEFAULT_CAPS, maxDepth: 4 } })
    const root = makeRootNode(c, NOW)
    let seen = ''
    await draftRootPlan({ root, config: c, runAgent: async req => { seen = req.prompt; return PLAN_REPLY }, signal: new AbortController().signal })
    expect(seen).toContain('做一个支付回调')          // the goal, in full
    expect(seen).toContain('当前深度 0/上限 4')        // the same depth budget the run states
    expect(seen).toContain('"kind":"decompose"|"executable"') // the same output contract
  })

  it('threads 修改意见 through the revision channel, showing the previous plan', async () => {
    const c = cfg()
    const root = makeRootNode(c, NOW)
    root.plan = { solution: '上一版方案文本', keyPoints: '', risks: '', acceptance: '' }
    let seen = ''
    await draftRootPlan({
      root, config: c, runAgent: async req => { if (!seen) seen = req.prompt; return PLAN_REPLY },
      signal: new AbortController().signal, feedback: '拆成三步,把测试单独拆出来',
    })
    expect(seen).toContain('拆成三步,把测试单独拆出来')
    expect(seen).toContain('上一版方案文本') // revise, don't restart
  })

  it('reports a failed draft instead of throwing', async () => {
    const res = await draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(),
      runAgent: async () => { throw new Error('provider down') },
      signal: new AbortController().signal,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('provider down')
  })

  it('does not present a plan for a run the user just cancelled', async () => {
    const ac = new AbortController()
    const res = await draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(),
      runAgent: async () => { ac.abort(); return PLAN_REPLY },
      signal: ac.signal,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('已中断')
  })
})

describe('根方案关口 · 与运行时同一棵树', () => {
  it('mints the SAME root the orchestrator would mint', async () => {
    // The gate hands its root to the orchestrator as the seed. If the two constructions ever
    // diverge — id, goal, depth, roster — every child id derived from it diverges too.
    const c = cfg({ phaseRoles: { ...emptyPhaseRoles(), plan: [{ roleName: 'architect' }] } })
    const orch = new EffTaskOrchestrator(c, {
      runAgent: async () => '', persist: async () => {}, now: () => NOW, onUpdate: () => {},
    }, new AbortController().signal)
    const fromRun = orch.nodes()[0]
    const fromGate = makeRootNode(c, NOW)
    expect(fromGate.id).toBe(fromRun.id)
    expect(fromGate.title).toBe(fromRun.title)
    expect(fromGate.goal).toBe(fromRun.goal)
    expect(fromGate.depth).toBe(fromRun.depth)
    expect(fromGate.phaseRoles.plan).toEqual(fromRun.phaseRoles.plan)
  })

  it('rootTitle takes the first NON-EMPTY line and clips by code points', () => {
    expect(rootTitle('\n\n  真正的目标  \n更多')).toBe('真正的目标')
    expect(rootTitle('')).toBe('根任务')
    expect(Array.from(rootTitle('🙂'.repeat(200))).length).toBe(80)
  })
})

describe('根方案关口 · 确认后真的生效', () => {
  const draft: RootDraft = {
    kind: 'decompose',
    plan: { solution: '用户改过的方案', keyPoints: 'K', risks: 'R', acceptance: 'A' },
    children: [{ title: '设计接口', deps: [] }, { title: '实现服务', deps: ['设计接口'] }],
  }

  it('applyRootDraft seals the plan AND the tree, not just the text', () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, '2026-07-26T00:00:00Z')
    expect(root.plan.solution).toBe('用户改过的方案')
    expect(root.kind).toBe('decompose')
    // The children are what makes the approval bind; without them stepStart would re-plan.
    expect(root.confirmedDraft?.children.map(c => c.title)).toEqual(['设计接口', '实现服务'])
    expect(root.updatedAt).toBe('2026-07-26T00:00:00Z')
  })

  it('applyRootDraft copies, so later edits to the draft cannot reach the sealed node', () => {
    const root = makeRootNode(cfg(), NOW)
    const mutable: RootDraft = { ...draft, children: [{ title: 'AA', deps: ['x'] }] }
    applyRootDraft(root, mutable, NOW)
    mutable.children[0].title = 'BB'
    mutable.children[0].deps.push('y')
    expect(root.confirmedDraft?.children[0].title).toBe('AA')
    expect(root.confirmedDraft?.children[0].deps).toEqual(['x'])
  })

  it('stepStart uses the confirmed plan and makes NO plan call', async () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, NOW)
    const calls: string[] = []
    const ctx = ctxFor([root], async req => {
      calls.push(req.phase)
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    // THE property: the plan role is never consulted, so the user's text is what runs.
    expect(calls).not.toContain('plan')
    expect(root.plan.solution).toBe('用户改过的方案')
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(root.childIds).toEqual(['root/01-设计接口', 'root/02-实现服务'])
    expect(ctx.byId.get('root/02-实现服务')!.deps).toEqual(['root/01-设计接口'])
  })

  it('the confirmed plan still faces the review roundtable', async () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, NOW)
    const phases: string[] = []
    const ctx = ctxFor([root], async req => {
      phases.push(req.phase)
      return vtag(req) + '\n{"pass":false,"blocking":["缺少回滚方案"],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    // 每个方案经多角色圆桌评审 — human approval is an input to the process, not an exemption
    // from it. The FIRST call after confirmation is the review.
    expect(phases[0]).toBe('review')
    expect(root.reviewLog[0].synthesized.pass).toBe(false)
    // …and a plan the roundtable keeps blocking still exhausts its budget rather than
    // riding the user's approval into execution.
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('评审迭代超限')
  })

  it('a rejected confirmed plan is REVISED by the plan role, not re-confirmed forever', async () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, NOW)
    let reviews = 0
    const planPrompts: string[] = []
    const ctx = ctxFor([root], async req => {
      if (req.phase === 'plan') { planPrompts.push(req.prompt); return PLAN_REPLY }
      reviews++
      return reviews === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["缺少回滚方案"],"comments":""}\n```'
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    // Round 2 DOES call the plan role — the draft is single-use, and the reviewer's blockers
    // reach it. Re-using the confirmed draft here would loop on a plan nobody can fix.
    expect(planPrompts).toHaveLength(1)
    expect(planPrompts[0]).toContain('缺少回滚方案')
    expect(planPrompts[0]).toContain('用户改过的方案') // revising the user's plan, not ignoring it
    expect(root.confirmedDraft).toBeUndefined()
    expect(root.status).toBe('WAITING_CHILDREN')
  })

  it('clears confirmedDraft in the SAME commit that enters review, so a crash cannot re-apply it', async () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, NOW)
    const persisted: { status: string; hasDraft: boolean }[] = []
    const ctx = ctxFor([root], async req => vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```')
    ctx.persist = async n => { persisted.push({ status: n.status, hasDraft: n.confirmedDraft !== undefined }) }
    await stepStart(root, ctx)
    const review = persisted.find(p => p.status === 'PLAN_REVIEW')
    expect(review).toBeDefined()
    expect(review!.hasDraft).toBe(false)
  })

  it('an executable confirmed root goes READY with no children', async () => {
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, { kind: 'executable', plan: { ...emptyPlan(), solution: '直接做' }, children: [] }, NOW)
    const calls: string[] = []
    const ctx = ctxFor([root], async req => {
      calls.push(req.phase)
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    expect(calls).not.toContain('plan') // an empty child list is still a CONFIRMED decision
    expect(root.status).toBe('READY')
    expect(root.childIds).toEqual([])
  })

  it('the sealed draft survives a node.md round trip', async () => {
    // The gate's approval is durable state: a run interrupted before its first step must
    // resume with the plan the user confirmed, not re-draft one behind their back.
    const { serializeNode, parseNodeFile } = await import('./persistence.js')
    const root = makeRootNode(cfg(), NOW)
    applyRootDraft(root, draft, NOW)
    const back = parseNodeFile(serializeNode(root))
    expect(back.confirmedDraft?.children.map(c => c.title)).toEqual(['设计接口', '实现服务'])
    expect(back.confirmedDraft?.children[1].deps).toEqual(['设计接口'])
  })
})

describe('根方案关口 · 任务树渲染', () => {
  it('names each child and its sibling dependencies', () => {
    const lines = childLines({ kind: 'decompose', plan: fullPlan(), children: [
      { title: '设计接口', deps: [] }, { title: '实现服务', deps: ['设计接口'] },
    ] })
    expect(lines[0]).toContain('1. 设计接口')
    expect(lines[0]).toContain('无依赖')
    expect(lines[1]).toContain('依赖: 设计接口')
  })

  it('flags a dependency that names no sibling, because the run will DROP it', () => {
    // createChildren silently discards a dep whose title matches no sibling. This gate is
    // the only place a human can see the ordering they think they approved is not real.
    const lines = childLines({ kind: 'decompose', plan: fullPlan(), children: [
      { title: 'A', deps: ['不存在的任务'] }, { title: 'B', deps: ['B'] },
    ] })
    expect(lines[0]).toContain('无效依赖(将被忽略): 不存在的任务')
    expect(lines[1]).toContain('无效依赖(将被忽略): B') // self-dependency is dropped too
  })

  it('says so when the plan does not decompose at all', () => {
    expect(childLines({ kind: 'executable', plan: fullPlan(), children: [] })).toEqual(['(不拆分,根任务直接执行)'])
  })
})

describe('根方案确认记录:不能变成"批准了一棵空树"', () => {
  it('stepStart 拒绝一个说要拆分却没有子任务的确认草稿', async () => {
    // Reachable from a half-written node.md. Honoured, it made stepStart skip the plan call
    // and approve an EMPTY decomposition: the node parked at WAITING_CHILDREN with childIds
    // [], advanceableKind returned null, propagateBlocked had nothing to blame, and the run
    // ended '存在无法推进的阻断节点' showing a grey root with no reason — on every resume.
    const root = makeRootNode(cfg(), NOW)
    root.kind = 'decompose'
    root.confirmedDraft = { children: [] }
    const calls: string[] = []
    const ctx = ctxFor([root], async req => {
      calls.push(req.phase)
      return req.phase === 'plan'
        ? PLAN_REPLY
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    // Degrades to "the plan role drafts it" — what the run did before this gate existed.
    expect(calls[0]).toBe('plan')
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(root.childIds.length).toBeGreaterThan(0)
  })

  it('stepStart 拒绝一个已经有子节点的节点身上的确认草稿', async () => {
    // The WAITING_CHILDREN guard further down returns before lastChildren is used, so the
    // approved first level was consumed and silently dropped — no children, no log, no refusal.
    const root = makeRootNode(cfg(), NOW)
    root.childIds = ['root/01-已有']
    root.confirmedDraft = { children: [{ title: '甲', deps: [] }, { title: '乙', deps: [] }] }
    const existing = createNode({ id: 'root/01-已有', title: '已有', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    const calls: string[] = []
    const ctx = ctxFor([root, existing], async req => {
      calls.push(req.phase)
      return req.phase === 'plan'
        ? PLAN_REPLY
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    })
    await stepStart(root, ctx)
    expect(calls[0]).toBe('plan') // not silently skipped
    expect(root.confirmedDraft).toBeUndefined()
  })
})

/** 一份**填满了**的方案。此前这些用例用 emptyPlan(),而空方案现在自己就是一条告警。 */
const fullPlan = () => ({
  solution: '分三步:先读 src/ 下的入口文件理清模块边界,再逐个模块看错误处理与边界条件,最后汇总成一份问题清单',
  keyPoints: '不要只看命名',
  risks: '可能漏掉动态加载的模块',
  acceptance: '产出一份带文件行号的问题清单,且每条都能复现',
})

describe('draftBlockers:整批被退回的两种草稿', () => {
  it('标题重复', () => {
    const b = draftBlockers({ kind: 'decompose', plan: fullPlan(), children: [
      { title: 'A', deps: [] }, { title: 'A', deps: [] }, { title: 'B', deps: [] },
    ] })
    expect(b.join()).toContain('子任务标题重复(A)')
  })
  it('依赖成环', () => {
    const b = draftBlockers({ kind: 'decompose', plan: fullPlan(), children: [
      { title: 'A', deps: ['B'] }, { title: 'B', deps: ['C'] }, { title: 'C', deps: ['A'] },
    ] })
    expect(b.join()).toContain('依赖成环')
  })
  it('正常的树没有告警', () => {
    expect(draftBlockers({ kind: 'decompose', plan: fullPlan(), children: [
      { title: 'A', deps: [] }, { title: 'B', deps: ['A'] },
    ] })).toEqual([])
  })
  it('自依赖不算环 —— createChildren 只是把那条边丢掉', () => {
    // childLines already flags it as 无效依赖; calling it a cycle would double-report and
    // over-state the consequence (an edge is lost, not the whole batch).
    expect(draftBlockers({ kind: 'decompose', plan: fullPlan(), children: [{ title: 'A', deps: ['A'] }] })).toEqual([])
  })
  it('起草失败时任务树那一段不假装做过决定', () => {
    expect(childLines({ kind: 'unknown', plan: fullPlan(), children: [] }, false))
      .toEqual(['(未能起草,运行时由 plan 角色重新拆分)'])
  })
})

describe('第三关的飞书通知卡', () => {
  const d: RootDraft = {
    kind: 'decompose',
    plan: { solution: '分三步走', keyPoints: 'K', risks: 'R', acceptance: '有集成测试' },
    children: [{ title: '设计接口', deps: [] }, { title: '实现服务', deps: ['设计接口'] }],
  }
  const body = (over: Partial<Parameters<typeof buildRootPlanNoticeCard>[0]> = {}) => {
    const card = buildRootPlanNoticeCard({ goalPrompt: '做一个支付回调', draft: d, drafted: true, runId: '007', ...over }) as {
      header: { template: string; title: { content: string } }
      elements: { text: { content: string } }[]
    }
    return { card, text: card.elements[0].text.content }
  }

  it('carries the plan and the tree the terminal is showing', () => {
    // A user who approved gates 1 and 2 FROM FEISHU used to receive nothing further, and the
    // run sat at this gate waiting for a keystroke nobody was present to press.
    const { text } = body()
    expect(text).toContain('做一个支付回调')
    expect(text).toContain('分三步走')
    expect(text).toContain('有集成测试')
    expect(text).toContain('设计接口')
    expect(text).toContain('实现服务')
  })

  it('says out loud that it cannot be answered here', () => {
    // The decisive line. A card that merely showed the plan would leave the reader waiting
    // for buttons that are never coming.
    const { text } = body()
    expect(text).toContain('只能在终端确认')
    expect(text).toContain('回到终端')
  })

  it('does not look like the startup card, which IS answerable from Feishu', () => {
    expect(body().card.header.template).toBe('blue')
    expect(body().card.header.title.content).toContain('待确认')
    expect(body().card.header.title.content).toContain('007')
  })

  it('a failed draft says so instead of showing an empty plan as if it were one', () => {
    const { text } = body({ draft: { kind: 'unknown', plan: fullPlan(), children: [] }, drafted: false })
    expect(text).toContain('未能起草根方案')
    expect(text).toContain('未能起草,运行时由 plan 角色重新拆分')
    expect(text).not.toContain('不拆分,根任务直接执行')
  })
})


describe('确认草稿的另一半对称情况', () => {
  it('kind 是 executable 却带着子任务的草稿,也要回落到 plan 调用', async () => {
    // The mirror image of the empty-decompose case. stepStart's executable branch commits
    // READY and returns before lastChildren is used, so the approved children were consumed
    // and dropped: measured phases ["review"], childIds [], one node in the whole tree — the
    // user approved a two-task first level and got none of it.
    const root = makeRootNode(cfg(), NOW)
    root.kind = 'executable'
    root.confirmedDraft = { children: [{ title: '甲', deps: [] }, { title: '乙', deps: [] }] }
    const calls = []
    const ctx = ctxFor([root], async req => {
      calls.push(req.phase)
      return req.phase === 'plan'
        ? PLAN_REPLY
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n' + "```"
    })
    await stepStart(root, ctx)
    expect(calls[0]).toBe('plan')            // not silently skipped
    expect(root.confirmedDraft).toBeUndefined()
    // …and the re-plan really does build a tree.
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(root.childIds.length).toBeGreaterThan(0)
  })
})


describe('确认草稿守卫的第三档', () => {
  it('kind 是 unknown 却带着子任务的草稿,同样回落到 plan 调用', async () => {
    // validateLoadedNodes resets an illegal kind to 'unknown', so this is the same shape as
    // the executable case through a different door: measured 0 plan calls, root left
    // READY/unknown with an empty blockedReason, run ended 存在无法推进的阻断节点.
    const root = makeRootNode(cfg(), NOW)
    root.kind = 'unknown'
    root.confirmedDraft = { children: [{ title: '甲', deps: [] }] }
    const calls = []
    const ctx = ctxFor([root], async req => {
      calls.push(req.phase)
      return req.phase === 'plan'
        ? PLAN_REPLY
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n' + "```"
    })
    await stepStart(root, ctx)
    expect(calls[0]).toBe('plan')
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(root.childIds.length).toBeGreaterThan(0)
  })
})

describe('第三关起草时要用和 run 一样的隔离规则', () => {
  it('有隔离池时,起草提示词里带着 §16 的冲突告知', async () => {
    // 否则关口上给用户看的那棵树,是在**没有**这条约束的情况下拆出来的,而 run 随后按
    // 有约束的规则跑 —— 用户批准的拆分和实际执行的规则不是一回事。
    const prompts: string[] = []
    const runAgent = (async (req: { prompt: string }) => {
      prompts.push(req.prompt)
      const tag = req.prompt.match(/必须是一个 ```([a-zA-Z]+) 代码块/)?.[1] ?? ''
      return '```' + tag + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
    }) as never
    const root = makeRootNode(cfg(), NOW)
    await draftRootPlan({
      root, config: cfg(), runAgent, signal: new AbortController().signal,
      worktrees: { integrationPath: '/wt/integration' } as never,
    })
    expect(prompts[0]).toContain('合并冲突')
  })

  it('没有隔离池时不带 —— 共享工作目录下执行是串行的,那个风险不存在', async () => {
    const prompts: string[] = []
    const runAgent = (async (req: { prompt: string }) => {
      prompts.push(req.prompt)
      const tag = req.prompt.match(/必须是一个 ```([a-zA-Z]+) 代码块/)?.[1] ?? ''
      return '```' + tag + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
    }) as never
    const root = makeRootNode(cfg(), NOW)
    await draftRootPlan({ root, config: cfg(), runAgent, signal: new AbortController().signal })
    expect(prompts[0]).not.toContain('合并冲突')
  })
})

describe('空方案不能被当成方案端给用户', () => {
  const plan = (over: Record<string, string> = {}) => ({
    solution: '分三步:先读 src/ 下的入口文件理清模块边界,再逐个模块看错误处理,最后汇总问题清单',
    keyPoints: '不要只看命名', risks: '可能漏掉动态加载的模块', acceptance: '产出带行号的问题清单',
    ...over,
  })

  it('填满的方案没有告警', () => {
    expect(planGaps(plan())).toEqual([])
  })

  it('四个字段各自空着都要报', () => {
    expect(planGaps(plan({ solution: '' })).join()).toContain('完整方案是空的')
    expect(planGaps(plan({ keyPoints: '  ' })).join()).toContain('重点是空的')
    expect(planGaps(plan({ risks: '' })).join()).toContain('风险点是空的')
    // 验收点要说清后果:验收环节拿它当判据。
    expect(planGaps(plan({ acceptance: '' })).join()).toContain('验收环节拿它当判据')
  })

  it('一句复述目标的「方案」也算空', () => {
    // 实测产出:「对 X 项目进行全面的代码审查,涵盖架构、安全、性能……」—— 一句正确的
    // 废话,长度刚好不为零,而三个字段全空。只判空串挡不住它。
    const g = planGaps(plan({ solution: '全面审查代码' }))
    expect(g.join()).toContain('基本等于复述目标')
    // 反向:小任务的合理短方案不该被拦。阈值从 20 降到 12 就是为这个 ——
    // 中文码点密度约是英文的 1.6 倍,20 会把它误伤,而同义英文却放行。
    expect(planGaps(plan({ solution: '把 README 第一行标题改成 X' }))).toEqual([])
  })

  it('用户实测那一版会被整条报出来', () => {
    const g = planGaps({
      solution: '对 3d-print-web 项目进行全面的代码审查,涵盖架构设计、安全性、性能优化、代码质量、最佳实践等多个维度',
      keyPoints: '', risks: '', acceptance: '',
    })
    expect(g).toHaveLength(3)          // solution 够长,其余三个空
    expect(g.join()).toContain('重点')
    expect(g.join()).toContain('风险点')
    expect(g.join()).toContain('验收点')
  })

  it('第三关会把这些当阻断项列出来', () => {
    const b = draftBlockers({ kind: 'executable', plan: { solution: '', keyPoints: '', risks: '', acceptance: '' }, children: [] })
    expect(b.length).toBeGreaterThanOrEqual(4)
  })
})

describe('空方案自动重拟一次', () => {
  const EMPTY = '```json\n{"kind":"executable","solution":"对项目做全面审查","keyPoints":"","risks":"","acceptance":""}\n```'
  const FULL = '```json\n{"kind":"executable","solution":"分三步:先读 src 入口理清模块边界,再逐模块看错误处理,最后汇总清单",' +
    '"keyPoints":"别只看命名","risks":"可能漏掉动态加载","acceptance":"产出带行号的清单"}\n```'

  it('第一版是空的就自己再要一次,不把「(空)」端给用户', async () => {
    const root = makeRootNode(cfg(), NOW)
    const prompts: string[] = []
    const res = await draftRootPlan({
      root, config: cfg(), signal: new AbortController().signal,
      runAgent: async req => { prompts.push(req.prompt); return prompts.length === 1 ? EMPTY : FULL },
    })
    expect(prompts).toHaveLength(2)
    // 第二次要带着「哪里不合格」,否则模型没有理由写得不一样
    expect(prompts[1]).toContain('上一版方案不合格')
    expect(prompts[1]).toContain('重点是空的')
    expect(res.ok && res.draft.plan.keyPoints).toBe('别只看命名')
  })

  it('只重拟一次 —— 再空也不再烧钱', async () => {
    const root = makeRootNode(cfg(), NOW)
    let calls = 0
    const res = await draftRootPlan({
      root, config: cfg(), signal: new AbortController().signal,
      runAgent: async () => { calls++; return EMPTY },
    })
    expect(calls).toBe(2)
    // 如实端出去,关口会把空字段逐条列清楚
    expect(res.ok && planGaps(res.draft.plan).length).toBeGreaterThan(0)
  })

  it('重拟更差就保留第一版', async () => {
    const root = makeRootNode(cfg(), NOW)
    const WORSE = '```json\n{"kind":"executable","solution":"","keyPoints":"","risks":"","acceptance":""}\n```'
    let n = 0
    const res = await draftRootPlan({
      root, config: cfg(), signal: new AbortController().signal,
      runAgent: async () => { n++; return n === 1 ? EMPTY : WORSE },
    })
    expect(res.ok && res.draft.plan.solution).toBe('对项目做全面审查')
  })

  it('方案已经填满时不多花一次调用', async () => {
    const root = makeRootNode(cfg(), NOW)
    let calls = 0
    await draftRootPlan({
      root, config: cfg(), signal: new AbortController().signal,
      runAgent: async () => { calls++; return FULL },
    })
    expect(calls).toBe(1)
  })

  it('提示词里写清了工作目录 —— 「当前目录下的代码」得知道是哪个目录', async () => {
    const root = makeRootNode(cfg(), NOW)
    let seen = ''
    await draftRootPlan({
      root, config: cfg(), signal: new AbortController().signal, cwd: '/home/me/3d-print-web',
      runAgent: async req => { if (!seen) seen = req.prompt; return FULL },
    })
    expect(seen).toContain('/home/me/3d-print-web')
    expect(seen).toContain('先真的去看代码')
  })
})

describe('自动重拟不许把好方案换成坏的', () => {
  const wrap = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```'
  const GOOD = wrap({
    kind: 'decompose',
    solution: '分五步:先读 src/a.ts 与 src/b.ts 理清模块边界,再逐个模块看错误处理,最后汇总',
    keyPoints: '别只看命名', risks: '', acceptance: '',
    children: [{ title: '看 a', deps: [] }, { title: '看 b', deps: [] }, { title: '汇总', deps: ['看 a', '看 b'] }],
  })
  // 空字段更少(只缺 risks),但方案更浅、子任务全没了 —— 只比个数的话它会赢
  const SHALLOWER = wrap({
    kind: 'executable',
    solution: '看一下代码然后改一改就行了大概是这样子的吧',
    keyPoints: '注意点', risks: '', acceptance: '验收点',
  })

  it('子任务从 3 个变 0 个的「改进」要拒掉 —— 这正是用户抱怨的那一行', () => {
    // 用户截图:「初始任务树 · 第一层(0 个) (不拆分,根任务直接执行)」。
    // 整体替换会连子任务一起换掉,验收实跑复现过。
    let n = 0
    return draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(), signal: new AbortController().signal,
      runAgent: async () => { n++; return n === 1 ? GOOD : SHALLOWER },
    }).then(res => {
      expect(n).toBe(2)                                   // 确实重拟了
      expect(res.ok && res.draft.children).toHaveLength(3) // 但没被换掉
      expect(res.ok && res.draft.kind).toBe('decompose')
    })
  })

  it('isBetterDraft 三条判据各自都要卡住', () => {
    const prev = { kind: 'decompose' as const, plan: { solution: 's', keyPoints: '', risks: '', acceptance: '' }, children: [{ title: 'a', deps: [] }] }
    const full = { solution: '分三步做完这件事,先读代码再改再跑测试验证', keyPoints: '别只看命名', risks: '可能漏掉动态加载', acceptance: '产出带行号的清单' }
    // 空字段没少
    expect(isBetterDraft({ kind: 'decompose', plan: prev.plan, children: prev.children }, prev, 3)).toBe(false)
    // 子任务变少
    expect(isBetterDraft({ kind: 'decompose', plan: full, children: [] }, prev, 3)).toBe(false)
    // 从「要拆」退回「不拆」
    expect(isBetterDraft({ kind: 'executable', plan: full, children: prev.children }, prev, 3)).toBe(false)
    // 三条都过才算更好
    expect(isBetterDraft({ kind: 'decompose', plan: full, children: prev.children }, prev, 3)).toBe(true)
  })

  it('重拟要带上用户在第三关输入的修改意见', async () => {
    // 不带的话,用户亲手写的那句话被丢了,而关口底部还写着「已按你的意见重拟」。
    const prompts: string[] = []
    await draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(), signal: new AbortController().signal,
      feedback: '把测试单独拆成一个子任务',
      runAgent: async req => { prompts.push(req.prompt); return prompts.length === 1 ? SHALLOWER : GOOD },
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('把测试单独拆成一个子任务')
  })

  it('重拟要让模型看见自己刚写的那一版,不是四个空串', async () => {
    // planPrompt 读的是 node.plan,而 root 的 plan 要等 draftRootPlan 返回之后才写。
    // 直接传 root,模型看到的「上一版方案」是 {"solution":"",…} —— 它根本不知道自己
    // 刚写了什么,「针对性修订」这条通道第一轮就不成立。
    const prompts: string[] = []
    await draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(), signal: new AbortController().signal,
      runAgent: async req => { prompts.push(req.prompt); return prompts.length === 1 ? SHALLOWER : GOOD },
    })
    expect(prompts[1]).toContain('看一下代码然后改一改')
    expect(prompts[1]).not.toContain('{"solution":"","keyPoints":"","risks":"","acceptance":""}')
  })
})

describe('planGaps 要挡住「写了字但等于没写」', () => {
  const base = {
    solution: '分三步:先读 src 入口理清模块边界,再逐模块看错误处理,最后汇总清单',
    keyPoints: '别只看命名', risks: '可能漏掉动态加载', acceptance: '产出带行号的清单',
  }
  it('三个「无」不算填了 —— 只判空白的话模型写三个字就全绕过', () => {
    // 这个函数的立意是挡「模型偷懒」。验收实测:'无'/'无'/'无' 一条都不报,连自动重拟
    // 都不会触发。
    for (const junk of ['无', '暂无', '没有', '略', 'N/A', 'TODO', '-', '。', '…']) {
      const g = planGaps({ ...base, keyPoints: junk })
      expect(`${junk} 被当成填了: ${g.length === 0}`).toBe(`${junk} 被当成填了: false`)
    }
  })
  it('单字符也算占位', () => {
    expect(planGaps({ ...base, risks: 'a' }).length).toBeGreaterThan(0)
    expect(planGaps({ ...base, acceptance: '好' }).length).toBeGreaterThan(0)
  })
  it('正常内容不误伤', () => {
    expect(planGaps(base)).toEqual([])
    expect(planGaps({ ...base, risks: '并发写冲突' })).toEqual([])
  })
  it('plan 本身是 null / 非对象也不抛', () => {
    // 它是 export 的,唯一调用链之外没人保证传得进对象。
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(() => planGaps(bad as never)).not.toThrow()
      expect(planGaps(bad as never).length).toBeGreaterThan(0)
    }
  })
})

describe('重拟途中被中断', () => {
  it('报中断,不端出半成品 —— 和第一次调用后中断的语义保持一致', async () => {
    const EMPTY = '```json\n{"kind":"executable","solution":"对项目做全面审查看看","keyPoints":"","risks":"","acceptance":""}\n```'
    const ac = new AbortController()
    let n = 0
    const res = await draftRootPlan({
      root: makeRootNode(cfg(), NOW), config: cfg(), signal: ac.signal,
      runAgent: async () => { n++; if (n === 2) ac.abort(); return EMPTY },
    })
    expect(res.ok).toBe(false)
  })
})

describe('根方案这条通道也要收到前言(角色简报 + 定向注入)', () => {
  /**
   * 这是**正常路径下根节点唯一的一次分析调用**:用户在第三关批准之后,`stepStart` 会消费
   * `confirmedDraft` 并跳过它自己那次 plan 调用。所以这里省掉前言的后果不是「少一段」,
   * 是整棵树的第一份方案什么都收不到 —— 而角色简报这一条比定向注入更早就断着。
   */
  const guided = (over: Partial<EffTaskConfig> = {}) => cfg({
    phaseGuidance: { plan: '先按文件边界切,别跨模块' },
    roleGuidance: [{ name: '架构师', text: '每个子任务都要写清回滚步骤' }],
    ...over,
  })

  /**
   * **收全部提示词,断言第一个。**
   *
   * 第一版写的是 `seen = req.prompt`(后一次覆盖前一次),而 draftRootPlan 在方案有空字段时
   * 会**自动重拟一次** —— 实测这个夹具下就是 2 次调用。于是断言打中的是重拟那一次,
   * 而「第一次起草不带前言」这条变异**存活**了:探针在它要守的那一次调用上是瞎的。
   */
  const draftPrompts = async (c: EffTaskConfig): Promise<string[]> => {
    const root = makeRootNode(c, NOW)
    const prompts: string[] = []
    await draftRootPlan({
      root, config: c, signal: new AbortController().signal,
      runAgent: async req => { prompts.push(req.prompt); return PLAN_REPLY },
    })
    expect(prompts.length).toBeGreaterThan(0)
    return prompts
  }

  it('点名给分析环节的话进了根方案的**第一次**起草', async () => {
    const prompts = await draftPrompts(guided())
    expect(prompts[0]).toContain('先按文件边界切,别跨模块')
  })

  it('点名给这一席的话也进了 —— 按角色名和员工名都认', async () => {
    const roles = emptyPhaseRoles()
    roles.plan = [{ roleName: '甲', roleTag: '架构师' }]
    const prompts = await draftPrompts(guided({ phaseRoles: roles }))
    expect(prompts[0]).toContain('每个子任务都要写清回滚步骤')
  })

  it('空方案重拟那一次也带着前言 —— 它的任务是补齐,不该比第一次知道得更少', async () => {
    const c = guided()
    const root = makeRootNode(c, NOW)
    const seen: string[] = []
    const EMPTY = '```json\n{"kind":"executable","solution":"一句话","keyPoints":"","risks":"","acceptance":""}\n```'
    await draftRootPlan({
      root, config: c, signal: new AbortController().signal,
      // 第一次回一份空方案(触发自动重拟),第二次回完整的。
      runAgent: async req => { seen.push(req.prompt); return seen.length === 1 ? EMPTY : PLAN_REPLY },
    })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('先按文件边界切,别跨模块')
  })
})
