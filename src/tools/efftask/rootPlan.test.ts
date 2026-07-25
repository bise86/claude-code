import { describe, expect, it } from 'bun:test'
import { applyRootDraft, buildRootPlanNoticeCard, childLines, draftBlockers, draftRootPlan, makeRootNode, rootTitle, type RootDraft } from './rootPlan.js'
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
  '```json\n{"kind":"decompose","solution":"三步走","keyPoints":"要点","risks":"风险","acceptance":"验收点",' +
  '"children":[{"title":"设计接口","deps":[]},{"title":"实现服务","deps":["设计接口"]}]}\n```'

describe('根方案关口 · 起草', () => {
  it('drafts the root plan and the FIRST level only', async () => {
    const c = cfg()
    const root = makeRootNode(c, NOW)
    const res = await draftRootPlan({ root, config: c, runAgent: async () => PLAN_REPLY, signal: new AbortController().signal })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.draft.kind).toBe('decompose')
    expect(res.draft.plan.solution).toBe('三步走')
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
      root, config: c, runAgent: async req => { seen = req.prompt; return PLAN_REPLY },
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
    const lines = childLines({ kind: 'decompose', plan: emptyPlan(), children: [
      { title: '设计接口', deps: [] }, { title: '实现服务', deps: ['设计接口'] },
    ] })
    expect(lines[0]).toContain('1. 设计接口')
    expect(lines[0]).toContain('无依赖')
    expect(lines[1]).toContain('依赖: 设计接口')
  })

  it('flags a dependency that names no sibling, because the run will DROP it', () => {
    // createChildren silently discards a dep whose title matches no sibling. This gate is
    // the only place a human can see the ordering they think they approved is not real.
    const lines = childLines({ kind: 'decompose', plan: emptyPlan(), children: [
      { title: 'A', deps: ['不存在的任务'] }, { title: 'B', deps: ['B'] },
    ] })
    expect(lines[0]).toContain('无效依赖(将被忽略): 不存在的任务')
    expect(lines[1]).toContain('无效依赖(将被忽略): B') // self-dependency is dropped too
  })

  it('says so when the plan does not decompose at all', () => {
    expect(childLines({ kind: 'executable', plan: emptyPlan(), children: [] })).toEqual(['(不拆分,根任务直接执行)'])
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

describe('draftBlockers:整批被退回的两种草稿', () => {
  it('标题重复', () => {
    const b = draftBlockers({ kind: 'decompose', plan: emptyPlan(), children: [
      { title: 'A', deps: [] }, { title: 'A', deps: [] }, { title: 'B', deps: [] },
    ] })
    expect(b.join()).toContain('子任务标题重复(A)')
  })
  it('依赖成环', () => {
    const b = draftBlockers({ kind: 'decompose', plan: emptyPlan(), children: [
      { title: 'A', deps: ['B'] }, { title: 'B', deps: ['C'] }, { title: 'C', deps: ['A'] },
    ] })
    expect(b.join()).toContain('依赖成环')
  })
  it('正常的树没有告警', () => {
    expect(draftBlockers({ kind: 'decompose', plan: emptyPlan(), children: [
      { title: 'A', deps: [] }, { title: 'B', deps: ['A'] },
    ] })).toEqual([])
  })
  it('自依赖不算环 —— createChildren 只是把那条边丢掉', () => {
    // childLines already flags it as 无效依赖; calling it a cycle would double-report and
    // over-state the consequence (an edge is lost, not the whole batch).
    expect(draftBlockers({ kind: 'decompose', plan: emptyPlan(), children: [{ title: 'A', deps: ['A'] }] })).toEqual([])
  })
  it('起草失败时任务树那一段不假装做过决定', () => {
    expect(childLines({ kind: 'unknown', plan: emptyPlan(), children: [] }, false))
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
    const { text } = body({ draft: { kind: 'unknown', plan: emptyPlan(), children: [] }, drafted: false })
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
