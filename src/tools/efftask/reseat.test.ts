import { describe, expect, it } from 'bun:test'
import { reseatTransientNodes } from './reseat.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, PHASE_NAMES, type TaskNode } from './types.js'

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
    /**
     * **CREATED,不是 READY** —— 这个节点身上没有任何「方案被放行过」的痕迹
     * (reviewLog 空、execStatus 空),而 `stepStart` 在评审圆桌**之前**就把 kind 写成
     * executable。放到 READY 等于让带写工具的执行者去跑一份没有任何评审员看过的方案
     * (`advanceableKind` 直接判 'execute')。这条判据和重做那边共用一份
     * (redo.seatForPropagated),而 reseat 这一侧原来没有它。
     */
    expect(dependent.status).toBe('CREATED')
    expect(dependent.blockedReason).toBe('')
  })

  it('干过活的下游回 READY(不用重新分析),而且多级依赖一起放开', () => {
    /**
     * 这一条守的是「不动点」那一半:阻断是 propagateBlocked 的不动点扫出来的
     * (父→子 / 子→父 / 依赖→依赖方),而 reseat 这里原来只有一句
     * `other.deps.includes(n.id)` 的**一级**循环。实测后果:A←B←C 的链上人工解完
     * 合并冲突再 --resume,B 被放开而 **C 和 B 的子树留在 BLOCKED** —— 而 B 的子树红着
     * 会让 propagateBlocked 立刻把刚放开的 B 再阻断一次,也就是「resume 之后一次模型
     * 调用都不会发生」的那个老失败,只是从另一扇门进。
     */
    const root = mk({ id: 'root', childIds: ['root/01', 'root/02', 'root/03'], kind: 'decompose', status: 'BLOCKED', blockedReason: '子节点阻断' })
    const conflict = mk({
      id: 'root/01', parentId: 'root', depth: 1, kind: 'executable', status: 'BLOCKED',
      blockedReason: '合并冲突', mergeConflict: true, worktree: { branch: 'b', path: '/wt/1' },
    })
    const b = mk({
      id: 'root/02', parentId: 'root', depth: 1, kind: 'decompose', childIds: ['root/02/01'],
      deps: ['root/01'], status: 'BLOCKED', blockedReason: '依赖阻断',
    })
    const b1 = mk({
      id: 'root/02/01', parentId: 'root/02', depth: 2, kind: 'executable',
      status: 'BLOCKED', blockedReason: '上级任务阻断', execStatus: '改过 src/a.ts',
      // 两天前跑过 —— startedAt 留着的话树上会显示 172800s 并每秒往上跳。
      startedAt: '2026-07-28T00:00:00.000Z', failedAt: 'EXECUTING',
    })
    const c = mk({
      id: 'root/03', parentId: 'root', depth: 1, kind: 'executable', deps: ['root/02'],
      status: 'BLOCKED', blockedReason: '依赖阻断', execStatus: '干过一轮',
    })
    reseatTransientNodes([root, conflict, b, b1, c], NOW, DEFAULT_CAPS)
    expect(b.status).toBe('WAITING_CHILDREN')
    expect(b1.status).toBe('READY') // 干过活 → 不用重新分析
    expect(c.status).toBe('READY')
    // 过期的痕迹一起清掉(这两条各自实测过后果)。
    expect(b1.startedAt).toBeUndefined()
    expect(b1.failedAt).toBeUndefined()
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


describe('动态生长的节点撞上合并冲突', () => {
  it('有子节点也要回 READY —— 只有 stepExecute 会解冲突', () => {
    // Measured: a node that grew children and then failed to merge came back from every later
    // --resume having made ZERO model calls and zero git operations, forever. The only code
    // that clears mergeConflict, re-runs acceptance and retries the merge lives in
    // stepExecute; WAITING_CHILDREN routes to stepIntegrate instead, so rule 1 winning here
    // made the escalation card's instruction permanently false.
    const n = mk({
      id: 'root', kind: 'decompose', status: 'BLOCKED', mergeConflict: true,
      childIds: ['root/01-a'], blockedReason: '合并冲突,已保留工作区待人工处理',
      worktree: { branch: 'b', path: '/wt/root' },
    })
    const kid = mk({ id: 'root/01-a', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable' })
    const r = reseatTransientNodes([n, kid], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('READY')
    expect(n.mergeConflict).toBe(true)   // still the flag stepExecute selects on
    expect(r.reseated).toContain('root')
  })

  it('没有冲突的 WAITING_CHILDREN 节点仍然按规则 1 落座', () => {
    const n = mk({
      id: 'root', kind: 'decompose', status: 'BLOCKED', interrupted: true,
      childIds: ['root/01-a'], blockedReason: '已中断',
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('WAITING_CHILDREN')
  })
})


describe('--retry-blocked 重开时要说明工作区被重置了', () => {
  it('把提示追加进 execStatus,否则返工提示词会指向一个已经不存在的文件', () => {
    // The re-acquire that follows does `checkout -B <branch> <integration>`, parking the old
    // output on a salvage ref. Measured: the REWORK prompt still said "上一轮执行状态: 我实现
    // 了 feature.ts" while that file was gone from the worktree the executor re-entered.
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'rework',
      execStatus: '我实现了 feature.ts 里的令牌桶',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.execStatus).toContain('我实现了 feature.ts')
    expect(n.execStatus).toContain('隔离工作区已重置')
    expect(n.execStatus).toContain('salvage')
  })

  it('重复重开不会把提示叠成一摞', () => {
    const n = mk({
      id: 'root', kind: 'executable', status: 'BLOCKED', capBlocked: true, capCategory: 'rework',
      execStatus: '做了一半',
      iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    n.status = 'BLOCKED'; n.capBlocked = true; n.capCategory = 'rework'
    n.iteration.acceptance = 3
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.execStatus.split('隔离工作区已重置').length - 1).toBe(1)
  })

  it('从没执行过的节点不会凭空多出一段执行状态', () => {
    const n = mk({
      id: 'root', kind: 'unknown', status: 'BLOCKED', capBlocked: true, capCategory: 'cap-iteration',
      iteration: { planReview: 3, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(n.execStatus).toBe('')
  })
})


describe('SCORING / MERGE 现在是真会写盘的状态', () => {
  for (const st of ['SCORING', 'MERGE']) {
    it(st + ' 被杀掉后能重新排队,而不是永远灰在那里', () => {
      // These two were in NodeStatus and never committed, so reseat's ACTIVE set left them
      // out on purpose. They ARE committed now (the panel showed both as ACCEPTANCE until
      // then), and a status this set does not know is one advanceableKind also refuses —
      // the node would sit grey forever and every later resume would reproduce it.
      const n = mk({ id: 'root', kind: 'executable', status: st })
      const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
      expect(n.status).toBe('READY')
      expect(r.reseated).toEqual(['root'])
    })
  }
})

describe('spec §17.2:归位注记要说清中断在哪个阶段', () => {
  // 「每个被归位的节点在 execStatus 追加一行"上次运行在 <阶段> 中断,已重新排队"」。
  // 阶段名原本被丢掉了:注记是固定串,而唯一知道它停在哪的东西(节点原来的 status)就在
  // 手上、归位时被覆盖。差别是实打实的 —— 被杀在 EXECUTING 的节点会重跑一次带写工具的
  // 执行调用,被杀在 MERGE 的只会重试一次合并。用户看到的两句话原本一模一样。
  const cases: [string, string][] = [
    ['EXECUTING', '执行'],
    ['MERGE', '合并回集成分支'],
    ['PLAN_REVIEW', '方案评审'],
    ['SCORING', '观察评分'],
  ]
  for (const [status, phase] of cases) {
    it(`${status} → 注记里写着「${phase}」`, () => {
      const n = mk({ id: 'root', kind: 'executable', status, execStatus: '改了一半' })
      reseatTransientNodes([n], NOW, DEFAULT_CAPS)
      expect(n.execStatus).toContain(`上次运行在${phase}中断`)
    })
  }

  it('连着崩两次也只追加一行,不会越堆越长', () => {
    // 注记按前缀去重,不按整行 —— 现在整行随阶段变化,按整行查会把两次都堆进去,而这段
    // 文本会原样进到 acceptPrompt 给评审看。
    const n = mk({ id: 'root', kind: 'executable', status: 'EXECUTING', execStatus: '改了一半' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    n.status = 'MERGE' // 第二次运行又被杀在另一个阶段
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.execStatus.match(/上次运行在/g)).toHaveLength(1)
  })

  it('被中断扫成 BLOCKED 的节点已经不知道自己停在哪,就别硬编一个', () => {
    // interrupted 的节点在被杀时已经被扫成 BLOCKED,原阶段就丢了。诚实地说"某个阶段",
    // 好过随便点一个名。
    const n = mk({ id: 'root', kind: 'executable', status: 'BLOCKED', interrupted: true, execStatus: '改了一半' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.execStatus).toContain('上次运行在某个阶段中断')
  })
})

describe('spec §10.1:归位要把 startedAt 清掉,否则耗时把宕机时间算进去', () => {
  it('被杀在执行中的节点,归位后耗时重新计时', () => {
    // startedAt 随 node.md 落盘,而归位原本只改 status。于是恢复之后 elapsed 算的是
    // `now - startedAt`,把**终端关着的那段时间**整个算成节点耗时。实测:两天前被杀的 run,
    // 一个灰色 ○「排队中」的节点旁边写着 172800s,真实值是崩溃前几十秒;而且面板把非终态
    // 节点当作在跑,数字还一秒一跳。
    //
    // 这在树只在运行时出现的年代影响有限;恢复关口开始渲染任务树之后,它变成了用户决定
    // "要不要继续花钱"时看到的第一个数字。也正是 elapsed 自己注释里记着修过一次的同一个
    // 缺陷(「一个从没跑过的节点在树建好一小时后显示 3600s」)。
    const n = mk({ id: 'root', kind: 'executable', status: 'EXECUTING', startedAt: '2026-07-24T00:00:00.000Z' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('READY')
    expect(n.startedAt).toBeUndefined()
  })

  it('同一棵树里已完成的节点不受影响 —— 它们的耗时是真的', () => {
    // 反向守卫:不能靠"把整棵树的 startedAt 全清掉"来满足上一条。ACCEPTED 的节点没有被
    // 归位,它那段耗时是真跑出来的,清掉等于把已经完成的工作说成没跑过。
    //
    // 两个节点必须放在**同一个数组**里:第一版只放了一个 ACCEPTED 节点,而它压根进不了
    // 归位循环(开头就 continue),所以"全清"那个变异根本执行不到那一行,用例照样绿 ——
    // 是变异跑出来的。得有一个真被归位的节点把循环带起来。
    const done = mk({ id: 'root/01-a', status: 'ACCEPTED', startedAt: '2026-07-24T00:00:00.000Z' })
    const killed = mk({ id: 'root/02-b', kind: 'executable', status: 'EXECUTING', startedAt: '2026-07-24T00:00:00.000Z' })
    const r = reseatTransientNodes([done, killed], NOW, DEFAULT_CAPS)
    expect(r.reseated).toEqual(['root/02-b']) // 循环确实跑起来了
    expect(killed.startedAt).toBeUndefined()
    expect(done.startedAt).toBe('2026-07-24T00:00:00.000Z')
  })
})

describe('被杀在评审阶段的节点,不能跳过评审直接去执行', () => {
  // stepStart 在评审圆桌**之前**就把 kind 从 plan 输出里写好了。所以进程恰好死在这两步
  // 之间时,盘上留下的是 `kind: 'executable'` + 空的 reviewLog —— 而结构规则会把它座到
  // READY,advanceableKind 随即回答 'execute',一个**没有任何评审员看过**的方案就交给了
  // 带写工具的执行器。实测:status READY,advanceableKind 'execute',reviewLog 0 轮。
  //
  // 这和 reviewExhausted 挡的是同一个洞的两扇门:那条守 --retry-blocked(capBlocked),
  // 而被杀的节点带的是 interrupted,两边都不匹配。
  for (const killedIn of ['PLANNING', 'PLAN_REVIEW'] as const) {
    it(`${killedIn} 期间被杀 → 回到 CREATED 重新走方案和评审`, () => {
      const n = mk({ id: 'root', kind: 'executable', status: killedIn, reviewLog: [] })
      reseatTransientNodes([n], NOW, DEFAULT_CAPS)
      expect(n.status).toBe('CREATED')
    })
  }

  it('已经通过评审、被杀在执行中的节点仍然回 READY —— 它的方案是批过的', () => {
    // 反向守卫:不能靠"所有 executable 都回 CREATED"来满足上面两条。那会让每次中断都
    // 重跑一遍方案和评审,把 §17.5"恢复不重置预算"的克制变成每次续跑都重新烧钱。
    const n = mk({ id: 'root', kind: 'executable', status: 'EXECUTING', execStatus: '改了一半' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('READY')
  })

  it('被杀在验收中的节点也回 READY,不回 CREATED', () => {
    const n = mk({ id: 'root', kind: 'executable', status: 'ACCEPTANCE', execStatus: '做完了' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(n.status).toBe('READY')
  })
})

describe('三张状态表必须覆盖同一批「进行中」状态', () => {
  // 这个仓库已经为两个 ACTIVE 列表漂移付过一次代价(38% 的阶段耗时无处可归)。新增状态时
  // 漏掉任一张都不会有东西报错:漏 reseat.ACTIVE → 崩溃后节点不再入座;漏 PHASE_OF →
  // 恢复摘要说不出它停在哪(退化成「某个阶段」)。
  const RUNNING: TaskNode['status'][] = [
    'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'VERIFYING', 'ACCEPTANCE', 'REWORK',
    'INTEGRATION_ACCEPT', 'SCORING', 'MERGE',
  ]

  it.each(RUNNING)('%s 崩溃后会被重新入座', st => {
    const n = mk({ id: 'n1', kind: 'executable', status: st })
    const r = reseatTransientNodes([n], NOW, DEFAULT_CAPS, {})
    expect(`${st}:${r.reseated.length}`).toBe(`${st}:1`)
  })

  it.each(RUNNING)('%s 的恢复注记说得出它停在哪 —— 不能漏给用户内部枚举名', st => {
    // execStatus 必须非空:注记只在已有内容后面追加(reseat.ts:313)。空着的话下面两条
    // 断言对任何状态都成立 —— 那是一条什么也没验的测试,我第一版就是这么写的。
    const n = mk({ id: 'n1', kind: 'executable', status: st, execStatus: '干了一半' })
    reseatTransientNodes([n], NOW, DEFAULT_CAPS, {})
    expect(`${st}:${n.execStatus.includes('上次运行在')}`).toBe(`${st}:true`)
    expect(`${st}:${n.execStatus.includes('某个阶段')}`).toBe(`${st}:false`)
    expect(`${st}:${n.execStatus.includes(st)}`).toBe(`${st}:false`)
  })
})

/**
 * 「预算耗尽」那条**早退**分支同样要清那三个字段 —— 评审点名的两条存活变异。
 *
 * 它绕过下面整段归位清理:留着 `startedAt`/`finishedAt` 会让详情页一边写「已终止」、
 * 一边把耗时算成跨过整个关机时间;而留着的 `cancelled` 是一个跨 run 存活的摁住位,
 * 这条分支恰好是「活干完了、判的人没预算了」那一类 —— 最可能被后续一次重做碰到的节点。
 */
describe('恢复时预算已耗尽的那条早退分支', () => {
  const node = (over: Record<string, unknown> = {}) => ({
    id: 'n', title: 't', goal: 'g', parentId: null, childIds: [], deps: [],
    kind: 'executable', status: 'ACCEPTANCE',
    phaseRoles: Object.fromEntries(PHASE_NAMES.map(p => [p, []])),
    plan: { solution: '', keyPoints: '', risks: '', acceptance: '' },
    execStatus: '干完了', blockedReason: '', reviewLog: [], acceptLog: [], score: {},
    iteration: { planReview: 0, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 0 },
    depth: 0, createdAt: 'T0', updatedAt: 'T0',
    startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T01:00:00.000Z',
    cancelled: true,
    ...over,
  }) as never as TaskNode

  it('清掉 startedAt / cancelled,并给一个结束时刻', () => {
    const n = node()
    const out = reseatTransientNodes([n], 'T9', { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out.exhausted).toEqual(['n'])
    expect(n.status).toBe('BLOCKED')
    // 留着旧的开始时刻 → 详情页把关机的那几十小时算成耗时(这个仓库付过三次学费)
    expect(n.startedAt).toBeUndefined()
    // 已终止就要有结束时刻,否则渲染层只能靠猜
    expect(n.finishedAt).toBe('T9')
    // 跨 run 存活的摁住位:留着它,下一次重做会把这个节点当成「用户不想跑」
    expect(n.cancelled).toBe(false)
    // 失败点仍然要记(这条分支原来就有,别被顺手改掉)
    expect(n.failedAt).toBe('ACCEPTANCE')
  })
})
