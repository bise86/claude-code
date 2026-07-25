import { describe, expect, it } from 'bun:test'
import { reseatTransientNodes } from './reseat.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('重开一个节点,却把它的上级留在阻断状态,等于什么也没重开', () => {
  // Measured end to end before this existed: a decomposed run whose child hit a merge conflict
  // reopened the child correctly on --resume, and then made ZERO model calls. propagateBlocked
  // had marked the ancestors 子节点阻断 — a non-abort path that never sets `interrupted` — so
  // reseat skipped them, the scheduler refuses any node with a blocked ancestor, and the run
  // immediately re-blocked the child as 上级任务阻断. The human's merge fix never landed.
  //
  // The suite could not see it because its only conflict fixture put the conflict on ROOT,
  // a shape that cannot occur once the tree decomposes — i.e. the normal shape.
  const tree = (): TaskNode[] => {
    const root = mk({ id: 'root', childIds: ['root/01', 'root/02'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const ok = mk({ id: 'root/01', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' })
    const bad = mk({
      id: 'root/02', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      blockedReason: '合并冲突,已保留工作区待人工处理。', mergeConflict: true,
      worktree: { branch: 'efftask/001/n-02', path: '/wt/02' },
    })
    return [root, ok, bad]
  }

  it('reopens the whole ancestor chain of a conflict node', () => {
    const nodes = tree()
    const { reseated } = reseatTransientNodes(nodes, NOW, DEFAULT_CAPS)
    expect(reseated).toContain('root/02')
    const root = nodes.find(n => n.id === 'root')!
    expect(root.status).toBe('WAITING_CHILDREN') // it has children, so this is its seat
    expect(root.blockedReason).toBe('')          // a stale reason renders as a live failure
    expect(nodes.find(n => n.id === 'root/01')!.status).toBe('ACCEPTED') // untouched
  })

  it('does NOT reopen an ancestor that failed on its own account', () => {
    // Only 子节点阻断 / 上级任务阻断 are propagation artefacts. A parent blocked because ITS
    // OWN plan review failed must stay blocked — clearing that would resume a tree on a plan
    // no reviewer ever passed.
    const nodes = tree()
    const root = nodes.find(n => n.id === 'root')!
    root.blockedReason = '方案评审迭代超限(3): [arch] 缺少回滚设计'
    reseatTransientNodes(nodes, NOW, DEFAULT_CAPS)
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('缺少回滚设计')
  })

  it('also reopens siblings that were only waiting on this node', () => {
    // propagateBlocked writes 依赖阻断 on dependents, and NOTHING anywhere else ever clears a
    // blockedReason. So after the human's fix merged and the conflict node reached ACCEPTED,
    // the tree kept rendering "✗ 依赖阻断" for a node whose only dependency was now done.
    const root = mk({ id: 'root', childIds: ['root/01', 'root/02'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const conflict = mk({
      id: 'root/01', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      blockedReason: '合并冲突', mergeConflict: true, worktree: { branch: 'b', path: '/wt/1' },
    })
    const dependent = mk({ id: 'root/02', parentId: 'root', depth: 1, kind: 'executable', deps: ['root/01'], status: 'BLOCKED', blockedReason: '依赖阻断' })
    reseatTransientNodes([root, conflict, dependent], NOW, DEFAULT_CAPS)
    expect(dependent.status).toBe('READY')
    expect(dependent.blockedReason).toBe('')
  })

  it('leaves a dependent alone when it failed on its own account', () => {
    const root = mk({ id: 'root', childIds: ['root/01', 'root/02'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const conflict = mk({ id: 'root/01', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED', blockedReason: '合并冲突', mergeConflict: true, worktree: { branch: 'b', path: '/wt/1' } })
    const dependent = mk({ id: 'root/02', parentId: 'root', depth: 1, kind: 'executable', deps: ['root/01'], status: 'BLOCKED', blockedReason: '验收迭代超限(3): [qa] 无用例' })
    reseatTransientNodes([root, conflict, dependent], NOW, DEFAULT_CAPS)
    expect(dependent.status).toBe('BLOCKED')
    expect(dependent.blockedReason).toContain('无用例')
  })

  it('walks the chain more than one level up', () => {
    const root = mk({ id: 'root', childIds: ['root/01'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const mid = mk({ id: 'root/01', parentId: 'root', depth: 1, childIds: ['root/01/01'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const leaf = mk({
      id: 'root/01/01', parentId: 'root/01', depth: 2, kind: 'executable', status: 'BLOCKED',
      blockedReason: '合并冲突', mergeConflict: true, worktree: { branch: 'b', path: '/wt/x' },
    })
    reseatTransientNodes([root, mid, leaf], NOW, DEFAULT_CAPS)
    expect(root.status).toBe('WAITING_CHILDREN')
    expect(mid.status).toBe('WAITING_CHILDREN')
    expect(leaf.status).toBe('READY')
  })
})

describe('reseatTransientNodes returns killed-mid-phase nodes to a re-enterable state', () => {
  it('reopens nodes the abort sweep blocked — otherwise resume advances nothing at all', () => {
    // propagateBlocked(aborted) sweeps EVERY non-terminal node to BLOCKED, and Esc, Ctrl+C
    // and view teardown all go through it, so this is the dominant real-world resume input.
    // Verified against P1: without this, a resumed run makes ZERO model calls.
    const n = mk({ status: 'BLOCKED', interrupted: true, kind: 'executable', blockedReason: '已中断' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('READY')
    expect(out.nodes[0].interrupted).toBeFalsy()
    expect(out.nodes[0].blockedReason).toBe('') // it is no longer blocked; the reason must go
    expect(out.reseated).toContain('n')
  })

  it('does NOT reopen a node that really failed', () => {
    const n = mk({ status: 'BLOCKED', kind: 'executable', blockedReason: '验收迭代超限(3): 缺测试' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.reseated).toEqual([])
  })

  it('a node that already has children never reseats to CREATED', () => {
    // createChildren persists children BEFORE committing the parent, so a kill in that
    // window leaves PLAN_REVIEW + children on disk. CREATED would replan and build a second
    // set: same titles overwrite the recovered (possibly ACCEPTED) children; different
    // titles leave ghost siblings that childrenAllAccepted then waits on forever.
    const n = mk({ status: 'PLAN_REVIEW', kind: 'decompose', childIds: ['n/01-a'] })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status).toBe('WAITING_CHILDREN')
  })

  it('a non-executable kind reseats to CREATED, never to READY', () => {
    // advanceableKind only advances READY when kind === 'executable'; READY + unknown is
    // neither advanceable nor terminal, so the run dies with no reason and every later
    // --resume reproduces it byte for byte.
    for (const kind of ['unknown', 'decompose'] as const) {
      const n = mk({ status: 'EXECUTING', kind, childIds: [] })
      expect(`${kind}:${reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status}`).toBe(`${kind}:CREATED`)
    }
  })

  it('maps each active status through the same three rules', () => {
    const cases: [TaskNode['status'], TaskNode['kind'], string[], string][] = [
      ['PLANNING', 'unknown', [], 'CREATED'],
      ['PLAN_REVIEW', 'unknown', [], 'CREATED'],
      ['EXECUTING', 'executable', [], 'READY'],
      ['ACCEPTANCE', 'executable', [], 'READY'],
      ['REWORK', 'executable', [], 'READY'],
      ['INTEGRATION_ACCEPT', 'decompose', ['n/01-a'], 'WAITING_CHILDREN'],
    ]
    for (const [from, kind, childIds, to] of cases) {
      const out = reseatTransientNodes([mk({ status: from, kind, childIds })], NOW, DEFAULT_CAPS)
      expect(`${from}->${out.nodes[0].status}`).toBe(`${from}->${to}`)
    }
  })

  it('leaves settled statuses untouched', () => {
    for (const s of ['CREATED', 'READY', 'WAITING_CHILDREN', 'ACCEPTED'] as const) {
      const out = reseatTransientNodes([mk({ status: s })], NOW, DEFAULT_CAPS)
      expect(out.nodes[0].status).toBe(s)
      expect(out.reseated).toEqual([])
    }
  })

  it('does not touch iteration counters — restart must not refresh the budget', () => {
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 2, acceptance: 1, integration: 0 } })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].iteration)
      .toEqual({ planReview: 2, acceptance: 1, integration: 0 })
  })

  it('blocks a node whose budget for the phase it would re-enter is already spent', () => {
    // Otherwise resume spends a real WRITE-CAPABLE execute call plus a full acceptance
    // roundtable, and only THEN blocks on 验收迭代超限 — paying for a repo mutation that
    // nothing will consume.
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 0, acceptance: 3, integration: 0 } })
    const out = reseatTransientNodes([n], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.nodes[0].blockedReason).toContain('预算已耗尽')
    expect(out.exhausted).toContain('n')
    expect(out.nodes[0].interrupted).toBeFalsy() // must not be reopened by the next resume
  })

  it('applies the budget guard to the phase the node would ACTUALLY re-enter', () => {
    // A node going back to CREATED re-enters plan→review, so the planReview budget is the
    // one that matters; charging it the acceptance budget would block work that can still run.
    const planSpent = mk({ status: 'PLANNING', kind: 'unknown', iteration: { planReview: 3, acceptance: 0, integration: 0 } })
    const out1 = reseatTransientNodes([planSpent], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out1.nodes[0].status).toBe('BLOCKED')

    const acceptSpentButReplanning = mk({ status: 'PLANNING', kind: 'unknown', iteration: { planReview: 0, acceptance: 3, integration: 0 } })
    const out2 = reseatTransientNodes([acceptSpentButReplanning], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out2.nodes[0].status).toBe('CREATED')
  })

  it('annotates the interruption once, not once per crash cycle', () => {
    // Repeated crash/resume cycles would otherwise stack '(注:…)' lines into the evidence
    // acceptPrompt shows the reviewer.
    let n = mk({ status: 'EXECUTING', kind: 'executable', execStatus: '已改 src/a.ts' })
    for (let i = 0; i < 3; i++) {
      n = reseatTransientNodes([{ ...n, status: 'EXECUTING' }], NOW, DEFAULT_CAPS).nodes[0]
    }
    expect(n.execStatus).toContain('已改 src/a.ts')
    expect(n.execStatus.match(/中断/g)?.length).toBe(1)
  })

  it('does not annotate a node that never executed', () => {
    const n = mk({ status: 'PLANNING', kind: 'unknown', execStatus: '' })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].execStatus).toBe('')
  })

  it('stamps updatedAt from the injected clock so elapsed time still renders', () => {
    const out = reseatTransientNodes([mk({ status: 'EXECUTING', kind: 'executable', updatedAt: 'old' })], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].updatedAt).toBe(NOW)
  })
})

describe('--retry-blocked:触阀后的人工重试', () => {
  const capped = (over: Partial<TaskNode> = {}): TaskNode => mk({
    id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable',
    status: 'BLOCKED', blockedReason: '验收迭代超限(3): 缺测试', capBlocked: true,
    iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    ...over,
  })

  it('does NOTHING without the flag — a valve must not re-arm itself', () => {
    const n = capped()
    const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('BLOCKED')
    expect(r.retried).toEqual([])
  })

  it('reopens the node AND resets the budget of the phase it re-enters', () => {
    // Without the reset the node is reseated and instantly re-exhausted by the budget check —
    // the flag would be inert and the card naming it would describe a no-op.
    const n = capped()
    const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('READY')
    expect(n.iteration.acceptance).toBe(0)
    expect(n.blockedReason).toBe('')
    expect(r.retried).toEqual(['root/01-a'])
    expect(r.exhausted).toEqual([])
  })

  it('resets the RIGHT counter for the phase the node actually re-enters', () => {
    const planning = capped({ kind: 'unknown', iteration: { planReview: 3, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 } })
    reseatTransientNodes([planning], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(planning.status).toBe('CREATED')
    expect(planning.iteration.planReview).toBe(0)

    const integrating = capped({ childIds: ['root/01-a/01-x'], iteration: { planReview: 0, acceptance: 0, integration: 3, scoring: 0, mergeResolve: 0 } })
    reseatTransientNodes([integrating], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(integrating.status).toBe('WAITING_CHILDREN')
    expect(integrating.iteration.integration).toBe(0)
  })

  it('clears the marker, so a LATER plain resume does not keep re-arming it', () => {
    const n = capped()
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.capBlocked).toBe(false)
  })

  it('reopens the propagated-blocked chain above it, or the seat is unreachable', () => {
    // The scheduler refuses any node with a BLOCKED ancestor, so reopening the leaf alone
    // makes the flag look like it worked while the run issues zero model calls.
    const parent = mk({ id: 'root', status: 'BLOCKED', blockedReason: '子节点阻断', childIds: ['root/01-a'], kind: 'decompose' })
    const n = capped()
    reseatTransientNodes([parent, n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(parent.status).toBe('WAITING_CHILDREN')
    expect(parent.blockedReason).toBe('')
  })

  it('NEVER resurrects a node blocked because its disk state is unusable', () => {
    // validateLoadedNodes writes these with capBlocked untouched. Re-running them would
    // execute work whose upstream cannot be verified while the run reported success.
    const broken = mk({
      id: 'root/01-a', parentId: 'root', depth: 1, status: 'BLOCKED',
      blockedReason: '依赖节点缺失(root/09-x)', interrupted: false,
    })
    const cyc = mk({ id: 'root/02-b', parentId: 'root', depth: 1, status: 'BLOCKED', blockedReason: '依赖成环,无法确定执行顺序' })
    const r = reseatTransientNodes([broken, cyc], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(broken.status).toBe('BLOCKED')
    expect(cyc.status).toBe('BLOCKED')
    expect(r.retried).toEqual([])
  })

  it('does not touch a merge-conflict block, which has its own path and its own card', () => {
    const conflicted = mk({
      id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      mergeConflict: true, blockedReason: '合并冲突,已保留工作区待人工处理',
      iteration: { planReview: 0, acceptance: 2, integration: 0, scoring: 0, mergeResolve: 1 },
    })
    const r = reseatTransientNodes([conflicted], NOW, DEFAULT_CAPS, { retryBlocked: true })
    // It IS reopened (that path always was), but as a merge resume — not as a budget reset.
    expect(r.retried).toEqual([])
    expect(conflicted.iteration.acceptance).toBe(2)
    expect(conflicted.mergeConflict).toBe(true)
  })
})

describe('--retry-blocked 不能让被否掉的方案绕过评审', () => {
  it('评审超限的节点回到 CREATED 重做方案,而不是直接进执行器', async () => {
    // THE bug: stepStart writes node.kind from the plan output BEFORE the review roundtable
    // runs. A plan that called itself `executable` and was then rejected three times sits at
    // BLOCKED with kind === 'executable', so the structural seat rule sent it to READY —
    // and --retry-blocked handed a unanimously-refused plan straight to a write-capable
    // executor with zero plan calls and zero reviews.
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'cap-iteration',
      blockedReason: '评审迭代超限(3): 方案不可行',
      iteration: { planReview: 3, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('CREATED')      // → stepStart → plan → review
    expect(n.iteration.planReview).toBe(0) // and with a fresh review budget
    expect(r.retried).toEqual(['root'])

    // Prove the seat really re-runs the plan phase, not the executor.
    const { stepStart } = await import('./pipeline.js')
    const { byIdMap } = await import('./stateMachine.js')
    const phases: string[] = []
    const byId = byIdMap([n])
    await stepStart(n, {
      config: { goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS, notices: [] },
      byId, persist: async () => {}, now: () => NOW, signal: new AbortController().signal,
      onUpdate: () => {}, reserveNodes: () => ({ release: () => {} }),
      runAgent: async req => {
        phases.push(req.phase)
        return req.phase === 'plan'
          ? '```json\n{"kind":"executable","solution":"改好的方案","keyPoints":"","risks":"","acceptance":"a"}\n```'
          : '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict') + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      },
    })
    expect(phases[0]).toBe('plan')   // the plan is REDONE
    expect(phases).toContain('review') // and re-reviewed
  })

  it('验收超限的可执行节点仍然回到 READY —— 它的方案是过了评审的', () => {
    // The distinction that matters: this node's PLAN was approved; only its execution kept
    // failing. Sending it back to CREATED would discard a reviewed plan for no reason.
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'rework',
      blockedReason: '验收迭代超限(3): 缺测试',
      iteration: { planReview: 1, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('READY')
    expect(n.iteration.acceptance).toBe(0)
  })

  it('一个节点只被算一次,不会同时出现在"重新排队"和"重开"里', () => {
    const n = mk({
      id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      capBlocked: true, blockedReason: '验收迭代超限(3)',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(r.retried).toEqual(['root/01-a'])
    expect(r.reseated).toEqual([]) // the resume gate renders both counts; this read as 2 nodes
  })
})

describe('--retry-blocked 的边界:不能凭"评审失败"复制一整棵子树', () => {
  it('已经有子节点的节点仍然回 WAITING_CHILDREN,即使 planReview 也到顶', () => {
    // Rule 1 of this module: a node that already has children must NEVER go to CREATED —
    // that is what builds a SECOND set. The review-exhausted branch must not override it.
    const parent = mk({
      id: 'root', kind: 'decompose', status: 'BLOCKED', capBlocked: true,
      childIds: ['root/01-a'], blockedReason: '集成验收迭代超限(3)',
      iteration: { planReview: 3, acceptance: 0, integration: 3, scoring: 0, mergeResolve: 0 },
    })
    const kid = mk({ id: 'root/01-a', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable' })
    reseatTransientNodes([parent, kid], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(parent.status).toBe('WAITING_CHILDREN')
    expect(parent.childIds).toEqual(['root/01-a']) // no second set
    expect(parent.iteration.integration).toBe(0)   // the budget that actually binds here
  })

  it('两个计数都到顶的无子节点则回 CREATED —— 方案是根源', () => {
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'cap-iteration',
      blockedReason: '评审迭代超限(3)',
      iteration: { planReview: 3, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('CREATED')
    expect(n.iteration.planReview).toBe(0)
    // ALL of them. A node re-entering at CREATED replays plan → review → execute → accept, so
    // leaving acceptance at the cap made the resume spend a real write-capable execute call
    // and a full acceptance roundtable and THEN discover it had no budget — exactly the waste
    // the budget check exists to prevent.
    expect(n.iteration.acceptance).toBe(0)
  })

  it('用户照卡片提高了 caps.maxIterations,守卫依然成立', () => {
    // THE regression. The card says "提高 caps.maxIterations 后再重试"; run.md is where that
    // lands; reseat reads run.md. A guard derived as `planReview >= caps.maxIterations`
    // therefore evaluated FALSE for precisely the user who followed the advice, and handed a
    // thrice-rejected plan to a write-capable executor. Keyed on the recorded category, the
    // cap value cannot reach it.
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'cap-iteration',
      blockedReason: '评审迭代超限(3)',
      iteration: { planReview: 3, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, { ...DEFAULT_CAPS, maxIterations: 5 }, { retryBlocked: true })
    expect(n.status).toBe('CREATED')
  })
})

describe('阻断原因的字符串耦合', () => {
  it('传播理由是精确匹配的,而带处置办法的理由绝不会污染它们', () => {
    // reseat matches PROPAGATED with FULL EQUALITY (.has(n.blockedReason)). blockWithReason now
    // decorates its reason with the remedy and the retry command, so if those two ever met,
    // the ancestor-reopening walk would silently stop working. They cannot: the propagated
    // literals are written only by propagateBlocked (orchestrator.ts), which does not go
    // through blockWithReason. This test is the tripwire if that ever changes.
    const parent = mk({ id: 'root', status: 'BLOCKED', blockedReason: '子节点阻断', childIds: ['root/01-a'], kind: 'decompose' })
    const child = mk({
      id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      capBlocked: true,
      // A DECORATED reason, exactly as blockWithReason writes it now.
      blockedReason: '验收迭代超限(3): 缺测试 · 先看该节点的验收记录… · 重试: /et --resume 007 --retry-blocked',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([parent, child], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(child.status).toBe('READY')
    expect(parent.status).toBe('WAITING_CHILDREN') // the exact-match walk still fires
    expect(parent.blockedReason).toBe('')
  })
})


describe('capCategory:落盘、校验、和旧版本 node.md 的兼容', () => {
  it('端到端:pipeline 写下的类别,reseat 真的读得到', async () => {
    // Mutation-proved gap: deleting `node.capCategory = category` from blockWithReason left
    // the whole suite green — every reseat fixture set the field by hand, so nothing walked
    // the real path from a valve trip to the retry seat.
    const { stepStart } = await import('./pipeline.js')
    const { byIdMap } = await import('./stateMachine.js')
    const n = mk({ id: 'root', kind: 'unknown', status: 'CREATED' })
    await stepStart(n, {
      config: { goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS, notices: [] },
      byId: byIdMap([n]), persist: async () => {}, now: () => NOW,
      signal: new AbortController().signal, onUpdate: () => {},
      reserveNodes: () => ({ release: () => {} }),
      runAgent: async req =>
        req.phase === 'plan'
          ? '\u0060\u0060\u0060json\n{"kind":"executable","solution":"s","keyPoints":"","risks":"","acceptance":"a"}\n\u0060\u0060\u0060'
          : '\u0060\u0060\u0060' + (req.prompt.match(/\u0060\u0060\u0060(verdict[a-z]+)/)?.[1] ?? 'verdict') + '\n{"pass":false,"blocking":["不行"],"comments":""}\n\u0060\u0060\u0060',
    })
    // The valve tripped on REVIEW, and stepStart had already written kind='executable'.
    expect(n.status).toBe('BLOCKED')
    expect(n.kind).toBe('executable')
    expect(n.capCategory).toBe('cap-iteration')
    // …so the retry must send it back to re-plan, not to the executor.
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('CREATED')
  })

  it('旧版本写的 node.md 没有 capCategory,也不能绕过评审', () => {
    // The previous build already wrote capBlocked but not capCategory. Keying the guard on the
    // category alone made every such node take the READY seat — measured end to end: phases
    // ["execute","accept"], 0 plan calls, 0 reviews, ACCEPTED. The trigger is exactly what the
    // escalation card tells users to do: upgrade, then --retry-blocked.
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, // NO capCategory
      blockedReason: '评审迭代超限(3)',
      iteration: { planReview: 3, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('CREATED')
    expect(n.iteration.planReview).toBe(0)
  })

  it('旧 node.md 里预算没到顶的,仍然回 READY', () => {
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true,
      blockedReason: '验收迭代超限(3)',
      iteration: { planReview: 1, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.status).toBe('READY')
  })
})
