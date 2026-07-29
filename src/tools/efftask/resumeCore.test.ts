import { describe, expect, it } from 'bun:test'
import { depCycleMembers, LEGAL_STATUS, readRunManifest, validateLoadedNodes } from './resumeCore.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, type TaskNode } from './types.js'
import { reseatTransientNodes } from './reseat.js'

const NOW = '2026-07-25T00:00:00.000Z'
const OPTS = { goal: '打通登录接口', phaseRoles: emptyPhaseRoles(), now: NOW }
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('validateLoadedNodes keeps illegal disk state out of the state machine', () => {
  it('an unknown status becomes BLOCKED instead of reaching the dependency gate', () => {
    // node.md is hand-editable text. An unrecognised status satisfies no gate and no
    // terminal check, so the orchestrator neither runs it nor stops for it — and any node
    // depending on it waits forever, stalling a whole subtree with no explanation.
    const root = mk({ childIds: ['root/01-x'] })
    const bad = mk({ id: 'root/01-x', parentId: 'root', status: 'RUNNING' as never })
    const out = validateLoadedNodes([root, bad], OPTS)
    const got = out.nodes.find(n => n.id === 'root/01-x')!
    expect(got.status).toBe('BLOCKED')
    expect(got.blockedReason).toContain('RUNNING')
    expect(got.interrupted).toBeFalsy() // must NOT be reopened by reseat
    expect(out.repairs.join(' ')).toContain('root/01-x')
  })

  it('normalises the remaining scalar fields without inventing budget', () => {
    const n = mk({
      kind: 'weird' as never, depth: Number.NaN,
      iteration: { planReview: 2 } as never,
      execStatus: undefined as never, plan: undefined as never,
      reviewLog: undefined as never, phaseRoles: { accept: ['pm'] } as never,
    })
    const got = validateLoadedNodes([n], OPTS).nodes[0]
    expect(got.kind).toBe('unknown')
    expect(got.depth).toBe(0)
    // A missing counter reads as 0, never as "no limit" — undefined + 1 is NaN, which never
    // satisfies >= maxIterations and turns a bounded retry loop into an unbounded one.
    expect(got.iteration).toEqual({ planReview: 2, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 })
    expect(got.execStatus).toBe('')
    expect(got.plan.solution).toBe('')
    expect(got.reviewLog).toEqual([])
    // Elements matter, not just the array: a bare string reaches runRoundtable and
    // role.roleName is undefined in the runAgent request.
    expect(got.phaseRoles.accept).toEqual([])
  })

  it('drops a node record with no usable id rather than indexing it', () => {
    const out = validateLoadedNodes([mk(), { id: '' } as never, null as never], OPTS)
    expect(out.nodes.map(n => n.id)).toEqual(['root'])
    expect(out.repairs.join(' ')).toContain('没有 id')
  })

  it('keeps the first of two files claiming the same id', () => {
    const a = mk({ title: '先读到的' })
    const b = mk({ title: '后读到的' })
    const out = validateLoadedNodes([a, b], OPTS)
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].title).toBe('先读到的')
    expect(out.repairs.join(' ')).toContain('重复节点')
  })
})

describe('a repair must never turn a detected failure into a silent success', () => {
  it('blocks the referrer instead of deleting a dangling dep', () => {
    // P1 already handles this shape: propagateBlocked blocks on depDangling ('依赖节点缺失')
    // precisely because loadRun returns partial trees. Deleting the edge makes
    // depsSatisfied() trivially true, so the node PLANS AND EXECUTES with write tools on
    // the premise that upstream work it cannot verify succeeded — and the run reports
    // completed. That is the '半完成冒充已完成' the constraints forbid.
    const root = mk({ childIds: ['root/01-b'] })
    const b = mk({ id: 'root/01-b', parentId: 'root', deps: ['root/00-gone'], status: 'CREATED' })
    const out = validateLoadedNodes([root, b], OPTS)
    const got = out.nodes.find(n => n.id === 'root/01-b')!
    expect(got.status).toBe('BLOCKED')
    expect(got.blockedReason).toContain('依赖节点缺失')
    expect(got.deps).toContain('root/00-gone') // the edge is EVIDENCE; it stays
  })

  it('blocks a parent whose child file was lost', () => {
    const root = mk({ childIds: ['root/01-lost'], status: 'WAITING_CHILDREN', kind: 'decompose' })
    const out = validateLoadedNodes([root], OPTS)
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.nodes[0].blockedReason).toContain('子节点缺失')
  })

  it('drops only a self-dependency, and says so', () => {
    const n = mk({ deps: ['root'] })
    const out = validateLoadedNodes([n], OPTS)
    expect(out.nodes[0].deps).toEqual([])
    expect(out.repairs.join(' ')).toContain('自依赖')
  })

  it('adopts an orphan rather than leaving it dangling outside the tree', () => {
    const root = mk()
    const orphan = mk({ id: 'x', parentId: 'ghost' })
    const out = validateLoadedNodes([root, orphan], OPTS)
    expect(out.nodes.find(n => n.id === 'x')!.parentId).toBe('root')
    expect(out.nodes.find(n => n.id === 'root')!.childIds).toContain('x')
  })

  it('rebuilds both directions of the parent/child link', () => {
    // childIds is authoritative for structure, parentId for the blocked-ancestor walk.
    // A tree where only one direction survived renders and gates wrong.
    const root = mk({ childIds: ['root/01-a'] })
    const a = mk({ id: 'root/01-a', parentId: null })
    const out = validateLoadedNodes([root, a], OPTS)
    expect(out.nodes.find(n => n.id === 'root/01-a')!.parentId).toBe('root')
  })
})

describe('cycles on disk must be reported, not left to deadlock silently', () => {
  it('depCycleMembers names every node in a dependency cycle', () => {
    const a = mk({ id: 'a', deps: ['b'] })
    const b = mk({ id: 'b', deps: ['a'] })
    const c = mk({ id: 'c', deps: [] })
    expect([...depCycleMembers([a, b, c])].sort()).toEqual(['a', 'b'])
  })

  it('blocks every member so the run explains itself instead of ending 存在无法推进的阻断节点', () => {
    // Today a mutual dep makes nothing advanceable while NO propagateBlocked rule fires
    // (the deps exist and are not BLOCKED), so run() returns blocked with nothing marked —
    // permanently unresumable and identical on every retry.
    const root = mk({ childIds: ['root/01-a', 'root/02-b'], status: 'WAITING_CHILDREN', kind: 'decompose' })
    const a = mk({ id: 'root/01-a', parentId: 'root', deps: ['root/02-b'] })
    const b = mk({ id: 'root/02-b', parentId: 'root', deps: ['root/01-a'] })
    const out = validateLoadedNodes([root, a, b], OPTS)
    for (const id of ['root/01-a', 'root/02-b']) {
      const n = out.nodes.find(x => x.id === id)!
      expect(n.status).toBe('BLOCKED')
      expect(n.blockedReason).toContain('依赖成环')
    }
  })

  it('a childIds cycle does not get promoted into a parentId cycle', () => {
    // The bidirectional rebuild assigns child.parentId unconditionally; on a cyclic
    // childIds graph that MANUFACTURES a parent cycle, after which no node has
    // parentId === null and the tree can never render or walk ancestors.
    const a = mk({ id: 'a', parentId: null, childIds: ['b'] })
    const b = mk({ id: 'b', parentId: null, childIds: ['a'] })
    const out = validateLoadedNodes([a, b], OPTS)
    expect(out.nodes.some(n => n.parentId === null)).toBe(true)
  })
})

describe('validateLoadedNodes guarantees the invariant run() asserts', () => {
  it('synthesises a root from the RECOVERED GOAL, not a placeholder', () => {
    // run() does `this.byId.get('root')!` every iteration, so a truncated root file would
    // crash the one case resume exists for. But the synthesized root is also what
    // integratePrompt judges the whole tree against — giving it a placeholder goal means the
    // final acceptance of the entire run is decided on a meaningless question whose PASS
    // marks the run 完成.
    const orphan = mk({ id: 'a', parentId: null, title: '孤儿', status: 'ACCEPTED' })
    const out = validateLoadedNodes([orphan], OPTS)
    const root = out.nodes.find(n => n.id === 'root')!
    expect(root.goal).toBe('打通登录接口')
    expect(root.childIds).toContain('a')
    expect(out.nodes.find(n => n.id === 'a')!.parentId).toBe('root')
    expect(root.createdAt).toBe(NOW) // injected clock, not ''
  })

  it('a synthesised root with no children is BLOCKED, not left to deadlock', () => {
    // WAITING_CHILDREN + childIds: [] is deliberately NOT advanceable and not terminal, so
    // run() would return the opaque '存在无法推进的阻断节点' with nothing explaining why.
    const out = validateLoadedNodes([], OPTS)
    const root = out.nodes.find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('没有恢复到任何节点')
  })

  it('a synthesised root whose goal is also lost cannot judge the run complete', () => {
    // With the manifest gone too there is no objective to accept against; letting it reach
    // INTEGRATION_ACCEPT would decide the whole run on an empty question.
    const out = validateLoadedNodes([mk({ id: 'a', parentId: null })], { ...OPTS, goal: '' })
    const root = out.nodes.find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('原始目标')
  })

  it('a synthesised root carries the run roster, not an empty one', () => {
    // runRoundtable turns an empty roster into a single main-model reviewer, so an empty
    // phaseRoles would judge the whole run on a panel the gate never showed the user.
    const roles = { ...emptyPhaseRoles(), accept: [{ roleName: 'qa' }] }
    const out = validateLoadedNodes([mk({ id: 'a', parentId: null })], { ...OPTS, phaseRoles: roles })
    expect(out.nodes.find(n => n.id === 'root')!.phaseRoles.accept).toEqual([{ roleName: 'qa' }])
  })

  it('leaves an intact tree completely alone', () => {
    const out = validateLoadedNodes([mk()], OPTS)
    expect(out.nodes).toHaveLength(1)
    expect(out.repairs).toEqual([])
  })
})

import { readRunManifest } from './resumeCore.js'
import { writeRunManifest } from './persistence.js'
import { roleBriefFor, type RoleDef } from './roleDefs.js'
import { createNode, DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, NODE_STATUSES } from './types.js'
import type { TaskNode } from './types.js'
import type { EffTaskConfig } from './types.js'
import type { FsLike } from './persistence.js'

const fsWith = (files: Record<string, string>): FsLike => ({
  readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
  writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
  unlink: async () => {}, rmdir: async () => {},
  readdir: async () => [], exists: async (p: string) => p in files,
})

describe('readRunManifest recovers the config the run was started with', () => {
  it('reads parallelism, roster, caps, goal, notices and guidance back', async () => {
    const md = [
      '---',
      `createdAt: '${NOW}'`,
      'parallelism: 3',
      'phaseRoles:',
      '  plan:',
      '    - roleName: planner',
      '      model: m1',
      '  review: []',
      '  execute: []',
      '  accept: []',
      '  observer: []',
      'caps:',
      '  maxDepth: 4',
      '  maxNodes: 50',
      '  maxIterations: 2',
      '  nodeTimeoutMs: 120000',
      '  scoreThreshold: 7',
      'goalPrompt: 打通登录',
      'notices:',
      '  - 观察:已忽略',
      'mainModel: claude-opus-4-8',
      'resumeGuidance: 先从简',
      '---',
      '',
      '# tree',
    ].join('\n')
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.parallelism).toBe(3)
    expect(config.goalPrompt).toBe('打通登录')
    // model **故意不读回** —— 它是 annotateRoleModels 每次按当前 settings 重算的显示值,
    // 读回来会让恢复关口显示上一次运行的旧模型(员工换了模型、甚至被删掉都照旧显示)。
    // roleName / roleTag 才是恢复的输入。
    expect(config.phaseRoles.plan[0]).toEqual({ roleName: 'planner' })
    expect(config.caps.maxDepth).toBe(4)
    // scoreThreshold must survive: rebuilding caps field-by-field silently dropped it, so a
    // run configured with a threshold lost it on resume.
    expect(config.caps.scoreThreshold).toBe(7)
    expect(config.notices).toEqual(['观察:已忽略'])
    expect(config.mainModel).toBe('claude-opus-4-8')
    expect(config.resumeGuidance).toBe('先从简')
    expect(degraded).toEqual([])
  })


  it('两个时钟各自的钳位:静默上限 2 小时,人工等待按 run.md 里写的来', async () => {
    // 「接口超时可以设置 2 个小时,用户回答响应超时设置 7 天」是用户给的数值。
    //
    // 静默这条原来钳到 1 小时,于是写 7200000 会被**静默钳成 3600000** —— 用户在
    // run.md 里写的数字不生效,而且没有任何提示。(clampInt 是钳位:
    // `Math.min(hi, Math.max(lo, n))`,dflt 只在非数字时才用到。这句话上一版写成
    // 「回落到默认值」是错的,后果被说得比实际更严重,而真实后果已经足够坏。)
    //
    // 人工那条填的**必须是非默认值**:填 7 天(604800000)的话,这条断言无法区分
    // 「从 run.md 读到并钳住了」和「根本没读、直接用了 DEFAULT_CAPS」—— 把整条钳位
    // 换成常量默认值,用例照样绿。实测过。
    const md = [
      '---', 'runId: 001', 'parallelism: 3', 'phaseRoles:', '  plan: []',
      'caps:', '  nodeTimeoutMs: 7200000', '  humanTimeoutMs: 259200000',
      'goalPrompt: 目标', '---', '',
    ].join('\n')
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.caps.nodeTimeoutMs).toBe(7_200_000)
    expect(config.caps.humanTimeoutMs).toBe(3 * 24 * 60 * 60 * 1000)
  })

  it('两端都要钉住 —— 只钉一个点的话范围可以随便挪', async () => {
    // 只有「2 小时能配上」这一个点被守时,把上限抬到 24 小时或把下限放到 0 都照样绿。
    // 上限管的是「多久没吐东西算挂死」,下限管的是「别把它配成一个必然误杀的数」。
    const md = (caps: string[]) => ['---', 'runId: 001', 'parallelism: 3', 'phaseRoles:', '  plan: []', 'caps:', ...caps, 'goalPrompt: 目标', '---', ''].join('\n')
    const over = await readRunManifest(fsWith({ '/r/run.md': md(['  nodeTimeoutMs: 86400000']) }), '/r')
    expect(over.config.caps.nodeTimeoutMs).toBe(7_200_000)
    const under = await readRunManifest(fsWith({ '/r/run.md': md(['  nodeTimeoutMs: 0']) }), '/r')
    expect(under.config.caps.nodeTimeoutMs).toBe(1000)
  })
  it('a missing or corrupt manifest degrades to defaults instead of throwing', async () => {
    // The manifest is ONE file. Losing it must not cost the user the whole tree — every
    // node.md is still there, and the roster is re-confirmable at the gate.
    for (const files of [{}, { '/r/run.md': 'not yaml at all' }, { '/r/run.md': '---\n[[[\n---\n' }]) {
      const { config, degraded } = await readRunManifest(fsWith(files), '/r')
      expect(config.parallelism).toBe(DEFAULT_PARALLELISM)
      expect(config.caps).toEqual(DEFAULT_CAPS)
      expect(degraded.length).toBeGreaterThan(0)
    }
  })

  it('clamps hostile numbers instead of trusting the file', async () => {
    const md = '---\nparallelism: 9999\ncaps:\n  maxNodes: -5\n  maxDepth: 999\ngoalPrompt: x\n---\n'
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.parallelism).toBeLessThanOrEqual(64)
    expect(config.parallelism).toBeGreaterThanOrEqual(1)
    expect(config.caps.maxNodes).toBeGreaterThanOrEqual(1)
    expect(config.caps.maxDepth).toBeLessThanOrEqual(20)
  })

  it('filters junk out of the roster rather than passing it to the roundtable', async () => {
    const md = '---\ngoalPrompt: x\nphaseRoles:\n  accept:\n    - pm\n    - roleName: qa\n    - {}\n---\n'
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.phaseRoles.accept).toEqual([{ roleName: 'qa' }])
  })

  it('reports a manifest with no goal instead of silently running an empty objective', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': '---\nparallelism: 2\n---\n' }), '/r')
    expect(config.goalPrompt).toBe('')
    expect(degraded.join(' ')).toContain('goalPrompt')
  })
})

describe('恢复:根方案确认记录', () => {
  const base = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const opts = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('keeps a well-formed confirmation so the user does not re-approve the same plan', () => {
    const n = base({ confirmedDraft: { children: [{ title: 'AA', deps: [] }, { title: 'BB', deps: ['AA'] }] } })
    const { nodes } = validateLoadedNodes([n], opts)
    expect(nodes[0].confirmedDraft?.children.map(c => c.title)).toEqual(['AA', 'BB'])
    expect(nodes[0].confirmedDraft?.children[1].deps).toEqual(['AA'])
  })

  it('drops a malformed one rather than sending an EMPTY plan into review', () => {
    // confirmedDraft is the one field that skips the plan phase. A hand-edited run.md /
    // half-written node.md must degrade to "the plan role drafts it", never to
    // "an empty plan was approved".
    const n = base({ confirmedDraft: 'oops' as never })
    const { nodes, repairs } = validateLoadedNodes([n], opts)
    expect(nodes[0].confirmedDraft).toBeUndefined()
    expect(repairs.some(r => r.includes('根方案确认记录已损坏'))).toBe(true)
  })

  it('drops child entries with no title instead of creating nameless nodes', () => {
    const n = base({ confirmedDraft: { children: [{ title: 'AA', deps: ['x', 5 as never] }, { deps: [] } as never] } })
    const { nodes } = validateLoadedNodes([n], opts)
    expect(nodes[0].confirmedDraft?.children).toEqual([{ title: 'AA', deps: ['x'] }])
  })
})

describe('恢复:两扇必须关严的门', () => {
  const base2 = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const opts2 = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('children 是数组但每一项都畸形 → 丢掉草稿,不要留成一棵空树', () => {
    // clean === [] is NOT "no children", it is "we lost them". Kept, stepStart skipped the
    // plan call and approved an EMPTY decomposition: the node parked at WAITING_CHILDREN with
    // childIds [], advanceableKind returned null, and the run ended
    // '存在无法推进的阻断节点' with a grey root and no reason — on every later resume.
    const n = base2({ confirmedDraft: { children: [{ deps: [] }, { titel: '打错了' }] } as never })
    const { nodes, repairs } = validateLoadedNodes([n], opts2)
    expect(nodes[0].confirmedDraft).toBeUndefined()
    expect(repairs.some(r => r.includes('根方案确认记录已损坏'))).toBe(true)
  })

  it('一个空 children 列表本身是合法的(不拆分),不该被当成损坏', () => {
    const n = base2({ confirmedDraft: { children: [] } })
    expect(validateLoadedNodes([n], opts2).nodes[0].confirmedDraft).toEqual({ children: [] })
  })

  it('因磁盘状态不可用而阻断的节点,capBlocked 必须被关掉', () => {
    // Otherwise a node that had legitimately tripped a valve keeps capBlocked === true, and a
    // later --retry-blocked reopens it even though THIS pass blocked it for an unrecoverable
    // reason. The resume gate then reports 重开 1 个节点 for a node that re-blocks with zero
    // model calls — exactly the failure --retry-blocked exists to fix.
    const parent = base2({ id: 'root', childIds: ['root/01-gone'], capBlocked: true, kind: 'decompose' })
    const { nodes } = validateLoadedNodes([parent], opts2)
    const back = nodes.find(x => x.id === 'root')!
    expect(back.status).toBe('BLOCKED')
    expect(back.blockedReason).toContain('子节点缺失')
    expect(back.capBlocked).toBe(false)
    // …and the retry must genuinely refuse it now.
    const r = reseatTransientNodes(nodes, NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(r.retried).toEqual([])
    expect(back.status).toBe('BLOCKED')
  })
})


describe('恢复:capCategory 也必须校验', () => {
  const b = (over = {}) => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const o = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('认识的类别原样保留', () => {
    expect(validateLoadedNodes([b({ capBlocked: true, capCategory: 'rework' })], o).nodes[0].capCategory).toBe('rework')
  })

  it('不认识的类别被清掉并记一笔 —— reseat 用它决定重进哪个阶段', () => {
    // node.md is hand-editable and this string picks the PHASE a retried node re-enters. A
    // garbage value silently took the executable seat, which is the review-bypass the field
    // exists to prevent. Dropping it falls back to the derived check.
    const { nodes, repairs } = validateLoadedNodes([b({ capBlocked: true, capCategory: 'lol-whatever' })], o)
    expect(nodes[0].capCategory).toBeUndefined()
    expect(repairs.some(r => r.includes('安全阀类别'))).toBe(true)
  })

  it('非字符串也被清掉', () => {
    expect(validateLoadedNodes([b({ capBlocked: true, capCategory: true })], o).nodes[0].capCategory).toBeUndefined()
  })

  /**
   * 手工重做的重入点。和 capCategory 完全同因:node.md 是可手工编辑的(升级卡片就在叫
   * 用户去改它),而这个字段决定节点**从哪个环节重入**。落盘是白拿的(serializeNode
   * 整节点倾倒,没有白名单),所以唯一的缺口正是在读回这一侧 —— 实测垃圾值原样穿过。
   */
  it('合法环节名原样保留', () => {
    expect(validateLoadedNodes([b({ redoFrom: 'review' })], o).nodes[0].redoFrom).toBe('review')
  })

  it('不是环节名的重入点被清掉并记一笔', () => {
    const { nodes, repairs } = validateLoadedNodes([b({ redoFrom: '随便写的' })], o)
    expect(nodes[0].redoFrom).toBeUndefined()
    expect(repairs.some(r => r.includes('重做入口'))).toBe(true)
  })

  it('非字符串的重入点也被清掉', () => {
    expect(validateLoadedNodes([b({ redoFrom: 42 })], o).nodes[0].redoFrom).toBeUndefined()
  })

  it('旧盘上没有这个字段时不误报修复 —— 兼容不能靠运气', () => {
    expect(validateLoadedNodes([b({})], o).repairs.some(r => r.includes('重做入口'))).toBe(false)
  })
})


describe('恢复:mergeConflict 也是一把不需要 flag 的钥匙', () => {
  const b2 = (over = {}) => ({
    ...createNode({ id: 'root/01-a', title: 'a', parentId: null, deps: ['root/99-gone'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })

  it('因磁盘状态不可用而阻断时,mergeConflict 必须被关掉', () => {
    // reseat reopens ANY blocked node carrying mergeConflict, with no flag required — so this
    // door had to close alongside capBlocked. Measured: a conflict node this pass then blocked
    // for a missing dependency was still reseated to READY, the gate said "重新排队 1 个节点",
    // the run made zero model calls, and blockedReason was cleared on the way — erasing both
    // the conflict diagnosis and the 依赖节点缺失 that replaced it.
    const n = b2({ status: 'BLOCKED', mergeConflict: true, worktree: { branch: 'b', path: '/wt/a' } })
    const { nodes } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW })
    const back = nodes.find(x => x.id === 'root/01-a')
    expect(back.blockedReason).toContain('依赖节点缺失')
    expect(back.mergeConflict).toBe(false)
    const r = reseatTransientNodes(nodes, NOW, DEFAULT_CAPS, { retryBlocked: true })
    expect(r.reseated).toEqual([])
    expect(back.status).toBe('BLOCKED')
  })
})


describe('半截的 reviewLog 不能把整个 Run 打死', () => {
  const mkn = (over = {}) => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const o = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('缺 verdicts 的记录被补齐,serializeNode 不再抛', async () => {
    // serializeNode's body walks r.verdicts and v.blocking. A half-written entry — exactly what
    // a crash leaves behind — made EVERY persist throw; commit() caught it and blocked the node
    // with a raw JS TypeError as its reason, and because each commit reproduced it, every later
    // --resume died the same way. Measured:
    // '状态持久化失败: undefined is not an object (evaluating r.verdicts.map)'.
    const { serializeNode } = await import('./persistence.js')
    const n = mkn({ reviewLog: [{ round: 1, synthesized: { pass: false, blockingSummary: 'x' } }] })
    const { nodes } = validateLoadedNodes([n], o)
    expect(nodes[0].reviewLog[0].verdicts).toEqual([])
    expect(() => serializeNode(nodes[0])).not.toThrow()
  })

  it('缺 blocking 的裁决也被补齐', async () => {
    const { serializeNode } = await import('./persistence.js')
    const n = mkn({ reviewLog: [{ round: 1, verdicts: [{ role: 'a', pass: false }], synthesized: { pass: false, blockingSummary: '' } }] })
    const { nodes } = validateLoadedNodes([n], o)
    expect(nodes[0].reviewLog[0].verdicts[0].blocking).toEqual([])
    expect(() => serializeNode(nodes[0])).not.toThrow()
  })

  it('verdicts 不是数组、synthesized 整个缺失,都收得住', async () => {
    const { serializeNode } = await import('./persistence.js')
    const n = mkn({ reviewLog: [{ round: 'x', verdicts: 'nope' }, null, 42], acceptLog: 'nope' })
    const { nodes } = validateLoadedNodes([n], o)
    expect(nodes[0].reviewLog).toHaveLength(1)
    expect(nodes[0].reviewLog[0].synthesized.pass).toBe(false)
    expect(nodes[0].acceptLog).toEqual([])
    expect(() => serializeNode(nodes[0])).not.toThrow()
  })

  it('完好的记录原样保留,包括 infra 标记', () => {
    const n = mkn({ reviewLog: [{
      round: 2,
      verdicts: [{ role: 'qa', pass: false, blocking: ['缺测试'], comments: 'c', infra: true }],
      synthesized: { pass: false, blockingSummary: '[qa] 缺测试' },
    }] })
    const back = validateLoadedNodes([n], o).nodes[0].reviewLog[0]
    expect(back.round).toBe(2)
    expect(back.verdicts[0]).toMatchObject({ role: 'qa', pass: false, blocking: ['缺测试'], comments: 'c', infra: true })
    expect(back.synthesized.blockingSummary).toBe('[qa] 缺测试')
  })

  it('即便校验器被绕过,writer 自己也不该炸', async () => {
    // Belt AND braces: this runs on every commit, and a body section is never worth a dead run.
    const { serializeNode } = await import('./persistence.js')
    const raw = mkn({ reviewLog: [{ round: 1 }] })
    expect(() => serializeNode(raw)).not.toThrow()
  })
})


describe('恢复:读者比校验器挖得深的那一类洞,全量收口', () => {
  const mk2 = (over = {}) => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const o2 = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('score.rationale 不是字符串时 serializeNode 也不能抛', async () => {
    // The SAME bug as reviewLog, eight lines below it, and MORE reachable: YAML types values
    // automatically, so an unquoted `rationale: 90` in a hand-edited node.md is a number and
    // stripControl calls .replace on it.
    const { serializeNode } = await import('./persistence.js')
    for (const bad of [90, true, ['a', 'b'], { x: 1 }]) {
      const n = mk2({ score: { plan: { role: 'r', score: 1, rationale: bad } } })
      const { nodes } = validateLoadedNodes([n], o2)
      expect(() => serializeNode(nodes[0])).not.toThrow()
      // STRINGIFIED, not dropped. The first version of this fix answered "YAML types
      // `rationale: 90` as a number" by deleting the reviewer's actual comment — String()
      // neither throws nor loses it.
      expect(typeof nodes[0].score.plan!.rationale).toBe('string')
    }
    const kept = validateLoadedNodes([mk2({ score: { plan: { role: 'r', score: 1, rationale: 90 } } })], o2).nodes[0]
    expect(kept.score.plan!.rationale).toBe('90')
  })

  it('score 里整条记录不是对象时被丢掉,而不是留着炸', async () => {
    const { serializeNode } = await import('./persistence.js')
    const n = mk2({ score: { plan: 'nope', exec: null } })
    const { nodes } = validateLoadedNodes([n], o2)
    expect(nodes[0].score.plan).toBeUndefined()
    expect(() => serializeNode(nodes[0])).not.toThrow()
  })

  it('confirmedDraft 是 null 时,不能把整场恢复带走', () => {
    // `!== undefined` let null through and the dereference threw out of validateLoadedNodes
    // entirely — efftask.tsx catches that as 恢复失败, so ONE malformed child node cost the
    // user every node in the run. YAML's `confirmedDraft:` (empty) IS null.
    const bad = mk2({ id: 'root/01-a', parentId: 'root', depth: 1, confirmedDraft: null })
    const good = mk2({ id: 'root', childIds: ['root/01-a'] })
    const { nodes, repairs } = validateLoadedNodes([good, bad], o2)
    expect(nodes).toHaveLength(2)                       // the healthy node survives
    expect(nodes.find(n => n.id === 'root/01-a').confirmedDraft).toBeUndefined()
    expect(repairs.some(r => r.includes('根方案确认记录已损坏'))).toBe(true)
  })

  it('worktree 是 null + mergeConflict 时,也不能把整场恢复带走', () => {
    const bad = mk2({ id: 'root/01-a', parentId: 'root', depth: 1, worktree: null, mergeConflict: true })
    const good = mk2({ id: 'root', childIds: ['root/01-a'] })
    const { nodes, repairs } = validateLoadedNodes([good, bad], o2)
    expect(nodes).toHaveLength(2)
    expect(repairs.some(r => r.includes('隔离工作区记录无法识别'))).toBe(true)
  })

  it('形状不对的 worktree 会被清掉 —— 否则隔离闸门被它绕过', () => {
    // stepExecute's isolation gate is `!node.worktree`, so a truthy-but-malformed value made
    // it PASS: measured, acquire() was never called, the acceptance roundtable ran with
    // cwd: undefined (i.e. in the user's real checkout), and the node reached ACCEPTED. The
    // repair line shown to the user read 保留冲突工作区 undefined.
    for (const bad of [{ branch: 'b' }, { path: '/p' }, 'a string', { branch: '', path: '' }]) {
      const n = mk2({ worktree: bad, mergeConflict: true })
      const { nodes } = validateLoadedNodes([n], o2)
      expect(nodes[0].worktree).toBeUndefined()
      // mergeConflict is KEPT. It is the only key that reopens a conflict block — interrupted
      // is false (a conflict is a verdict) and capBlocked is false (no valve tripped) — so
      // clearing it left a node NEITHER `--resume` NOR `--retry-blocked` could touch, while
      // its own blockedReason still told the user to resume. Clearing the worktree alone is
      // enough: stepExecute's gate is `!node.worktree`, so it re-acquires.
      expect(nodes[0].mergeConflict).toBe(true)
    }
    // …and the node really is reopenable again.
    const n2 = mk2({ status: 'BLOCKED', worktree: null as never, mergeConflict: true })
    const fixed = validateLoadedNodes([n2], o2).nodes
    expect(reseatTransientNodes(fixed, NOW, DEFAULT_CAPS).reseated).toEqual(['root'])
  })

  it('形状完好的冲突工作区仍然保留', () => {
    const n = mk2({ worktree: { branch: 'b', path: '/wt/a' }, mergeConflict: true })
    const { nodes } = validateLoadedNodes([n], o2)
    expect(nodes[0].worktree).toEqual({ branch: 'b', path: '/wt/a' })
    expect(nodes[0].mergeConflict).toBe(true)
  })

  it('interrupted / mergeConflict 的真值也要收敛成布尔', () => {
    // capBlocked already had this. A truthy non-boolean matches neither reseat's `=== true`
    // nor --retry-blocked's capBlocked, so the node could never be reopened by anything.
    const n = mk2({ interrupted: 'yes', mergeConflict: 1, status: 'BLOCKED' })
    const { nodes } = validateLoadedNodes([n], o2)
    expect(nodes[0].interrupted).toBe(false)
    expect(nodes[0].mergeConflict).toBe(false)
  })

  it('丢弃损坏的评审记录时要报一条修复,不能静默', () => {
    const n = mk2({ reviewLog: [{ round: 1, verdicts: 'nope', synthesized: { pass: true, blockingSummary: '' } }, null] })
    const { repairs } = validateLoadedNodes([n], o2)
    expect(repairs.some(r => r.includes('评审/验收记录已损坏'))).toBe(true)
  })

  it('从盘上读回来的 blocking 也受同样的上限', () => {
    const many = [...Array(50)].map((_, i) => 'x'.repeat(5000) + i)
    const n = mk2({ reviewLog: [{ round: 1, verdicts: [{ role: 'a', pass: false, blocking: many, comments: '' }], synthesized: { pass: false, blockingSummary: '' } }] })
    const { nodes } = validateLoadedNodes([n], o2)
    const back = nodes[0].reviewLog[0].verdicts[0].blocking
    // 20 kept + the marker. The resume path used to slice to exactly 20, which deleted the
    // very marker parseVerdict had appended — a user saw a full 20 with no sign of a cut.
    expect(back.length).toBe(21)
    expect(back[back.length - 1]).toContain('未记录')
    expect(Array.from(back[0]).length).toBeLessThan(2100)
  })
})

describe('run.md 里的 scoreThreshold 不是数字时,关口不能说假话', () => {
  const memfs = (runMd: string) => ({
    readFile: async (p: string) => { if (p.endsWith('run.md')) return runMd; throw new Error('ENOENT') },
    writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
    unlink: async () => {}, rmdir: async () => {}, readdir: async () => [], exists: async () => true,
  })

  it('非数字被忽略,并且明确告诉用户"评分不会触发返工"', async () => {
    // clampInt turned a non-number into 0 silently, and `worst < 0` never holds — so the gate
    // rendered "评分低于 0 触发一轮返工" while rework could never fire. Same function pushes a
    // degraded line when goalPrompt is missing; the numeric fields pushed none.
    const { config, degraded } = await readRunManifest(
      memfs('---\ngoalPrompt: g\ncaps:\n  scoreThreshold: abc\n---\n\n') as never, '/r',
    )
    expect(config.caps.scoreThreshold).toBeUndefined()
    expect(degraded.some(d => d.includes('scoreThreshold'))).toBe(true)
    expect(degraded.some(d => d.includes('不触发返工'))).toBe(true)
  })

  it('真的数字照常生效', async () => {
    const { config, degraded } = await readRunManifest(
      memfs('---\ngoalPrompt: g\ncaps:\n  scoreThreshold: 80\n---\n\n') as never, '/r',
    )
    expect(config.caps.scoreThreshold).toBe(80)
    expect(degraded).toEqual([])
  })
})


describe('剩下五条守卫也要有测试', () => {
  const mk3 = (over = {}) => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const o3 = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('score 夹到 0-100 —— 负分会白烧一轮返工', () => {
    // parseScoreOutput clamps; a hand-edited node.md did not go through it, and -50 sits below
    // any scoreThreshold.
    expect(validateLoadedNodes([mk3({ score: { plan: { role: 'o', score: -50, rationale: '' } } })], o3)
      .nodes[0].score.plan!.score).toBe(0)
    expect(validateLoadedNodes([mk3({ score: { exec: { role: 'o', score: 999, rationale: '' } } })], o3)
      .nodes[0].score.exec!.score).toBe(100)
  })

  it('单个裁决里丢掉的意见也要报修复,不只是整轮', () => {
    // Reporting only whole rounds meant a verdict whose 30 entries became 20, or whose entire
    // blocking list was a string, vanished without a line anywhere — §17.2 wants them shown.
    const tooMany = mk3({ reviewLog: [{ round: 1, verdicts: [{ role: 'a', pass: false, blocking: [...Array(30)].map((_, i) => 'b' + i, ), comments: '' }], synthesized: { pass: false, blockingSummary: '' } }] })
    expect(validateLoadedNodes([tooMany], o3).repairs.some(r => r.includes('评审/验收记录已损坏'))).toBe(true)
    const notArray = mk3({ reviewLog: [{ round: 1, verdicts: [{ role: 'a', pass: false, blocking: '一整段', comments: '' }], synthesized: { pass: false, blockingSummary: '' } }] })
    expect(validateLoadedNodes([notArray], o3).repairs.some(r => r.includes('评审/验收记录已损坏'))).toBe(true)
  })

  it('scoreThreshold 超出 0-100 也要说,而不是静默归零', async () => {
    // clampInt turned -5 into 0, and `worst < 0` never holds — the same "the gate promises a
    // rework that can never fire" the non-number branch exists to prevent.
    const memfs = (runMd) => ({
      readFile: async (p) => { if (p.endsWith('run.md')) return runMd; throw new Error('ENOENT') },
      writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
      unlink: async () => {}, rmdir: async () => {}, readdir: async () => [], exists: async () => true,
    })
    const { config, degraded } = await readRunManifest(memfs('---\ngoalPrompt: g\ncaps:\n  scoreThreshold: -5\n---\n\n'), '/r')
    expect(config.caps.scoreThreshold).toBeUndefined()
    expect(degraded.some(d => d.includes('超出 0-100'))).toBe(true)
  })

  it('提示语里的值加了引号 —— 免得 "80" 读成 "80 不是数字"', async () => {
    const memfs = (runMd) => ({
      readFile: async (p) => { if (p.endsWith('run.md')) return runMd; throw new Error('ENOENT') },
      writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
      unlink: async () => {}, rmdir: async () => {}, readdir: async () => [], exists: async () => true,
    })
    const { degraded } = await readRunManifest(memfs('---\ngoalPrompt: g\ncaps:\n  scoreThreshold: "80"\n---\n\n'), '/r')
    expect(degraded[0]).toContain('"80"')
  })
})

describe('revised 的归一化(补救拆分只做一次的那把锁)', () => {
  const base3 = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })
  const opts3 = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('手改成 "yes" 之类的真值会被打成 false —— 否则能买到第二棵补救子树', () => {
    // node.md 是设计上可手工编辑的。`revised: "yes"` 不是 `=== true`,而
    // reviseDecomposition 的守卫是 `node.revised === true` —— 于是这个节点会再修一次,
    // 而"每节点只修一次"正是整个成本论证唯一的上界。
    expect(validateLoadedNodes([base3({ revised: 'yes' as never })], opts3).nodes[0].revised).toBe(false)
    expect(validateLoadedNodes([base3({ revised: 1 as never })], opts3).nodes[0].revised).toBe(false)
  })

  it('真正的 true 保留,未设置的保持未设置', () => {
    expect(validateLoadedNodes([base3({ revised: true })], opts3).nodes[0].revised).toBe(true)
    expect(validateLoadedNodes([base3()], opts3).nodes[0].revised).toBeUndefined()
  })
})

describe('角色定义必须能从 run.md 原样回来', () => {
  // 这一组防的是这个仓库反复在修的那类失败:字段写进磁盘、没人读回来。
  // writeRunManifest 整文件重写 run.md,所以「只写不读」不是慢性退化,是第一次 --resume
  // 立刻清零 —— 而且清得毫无声响:席位数量、员工名、模型全对,只有职责简报没了。
  const write = async (cfg: Partial<EffTaskConfig>) => {
    const files: Record<string, string> = {}
    const fs: FsLike = {
      ...fsWith(files),
      readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
      writeFile: async (p: string, c: string) => { files[p] = c },
    }
    await writeRunManifest(fs, '/r', {
      goalPrompt: 'g', parallelism: 2, phaseRoles: emptyPhaseRoles(),
      caps: { ...DEFAULT_CAPS }, notices: [], ...cfg,
    } as EffTaskConfig, [])
    return { fs, text: files['/r/run.md'] }
  }

  const arch: RoleDef = { name: '架构师', stage: 'review', output: '裁决与阻断项', purpose: '把关可维护性', staff: ['opus-架构'] }

  it('写进去 → 读回来,一字不差', async () => {
    const { fs } = await write({ roleDefs: [arch] })
    const { config } = await readRunManifest(fs, '/r')
    expect(config.roleDefs).toEqual([arch])
  })

  it('主模型兼任(空 staff)也原样回来,不会变成 undefined', async () => {
    const solo: RoleDef = { ...arch, staff: [] }
    const { fs } = await write({ roleDefs: [solo] })
    const { config } = await readRunManifest(fs, '/r')
    expect(config.roleDefs).toEqual([solo])
  })

  it('席位的 roleTag 熬过一次 resume —— 否则简报静默消失', async () => {
    // roleTag 是席位与角色定义的唯一关联。roleArray 曾经只保留 roleName/model,
    // 那样恢复出来的名册和原来长得完全一样,只是每一席都不再知道自己演谁。
    const { fs } = await write({
      roleDefs: [arch],
      phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'opus-架构', model: 'm', roleTag: '架构师' }] },
    })
    const { config } = await readRunManifest(fs, '/r')
    expect(config.phaseRoles.review[0].roleTag).toBe('架构师')
    expect(roleBriefFor(config.roleDefs ?? [], config.phaseRoles.review[0], 'review')).toContain('把关可维护性')
  })

  it('手改 run.md 塞进不完整的角色 → 剔除并说明,不能绕开校验', async () => {
    const md = [
      '---', 'goalPrompt: g', 'roleDefs:',
      '  - name: 架构师', '    stage: review', '    output: o', '    purpose: p',
      '  - name: 半成品', '    stage: review', '    output: o',
      '  - name: 自由阶段', '    stage: 安全审计', '    output: o', '    purpose: p',
      '---', '',
    ].join('\n')
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.roleDefs?.map(d => d.name)).toEqual(['架构师'])
    expect(degraded.filter(d => d.includes('角色定义不完整'))).toHaveLength(2)
  })

  it('没有角色定义的老 run.md 照常恢复', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': '---\ngoalPrompt: g\n---\n\n' }), '/r')
    expect(config.roleDefs).toBeUndefined()
    expect(degraded.filter(d => d.includes('角色'))).toEqual([])
  })
})

describe('新 caps 旋钮的读回与再校验', () => {
  it('quorum 与 maxSeatsPerPhase 从 run.md 读回', async () => {
    const md = '---\ngoalPrompt: g\ncaps:\n  quorum: 60\n  maxSeatsPerPhase: 3\n---\n\n'
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.caps.quorum).toBe(60)
    expect(config.caps.maxSeatsPerPhase).toBe(3)
  })

  it('手改 run.md 塞越界值 → 夹住,而不是绕开校验', async () => {
    // readRunManifest 此前没有等价于 parseDirectives 的夹取,手改 run.md 是一条绕过
    // 全部校验的路。quorum: 0 会让「零票也通过」。
    const md = '---\ngoalPrompt: g\ncaps:\n  quorum: 0\n  maxSeatsPerPhase: 999\n---\n\n'
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md }), '/r')
    expect(config.caps.quorum).toBe(1)
    expect(config.caps.maxSeatsPerPhase).toBe(20)
  })

  it('老 run.md 没有这两项 → 保持 undefined(全票、默认上限)', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': '---\ngoalPrompt: g\n---\n\n' }), '/r')
    expect(config.caps.quorum).toBeUndefined()
    expect(config.caps.maxSeatsPerPhase).toBeUndefined()
  })
})

describe('待收口状态必须能从 run.md 读回', () => {
  const md = (extra: string) => `---\ngoalPrompt: g\npendingHandoff:\n${extra}---\n\n`

  it('读回分支、提交数、路径、结局', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  branch: efftask/001/integration\n  commits: 3\n  integrationPath: /repo/.wt/int\n' +
      '  kept: []\n  salvage: [efftask/001/salvage]\n  outcome: completed\n') }), '/r')
    expect(config.pendingHandoff).toEqual({
      branch: 'efftask/001/integration', commits: 3, integrationPath: '/repo/.wt/int',
      kept: [], salvage: ['efftask/001/salvage'], outcome: 'completed',
    })
  })

  it('被阻断的 run 的结局照样读回 —— 别邀请用户合并一棵没做完的树', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  branch: b\n  commits: 1\n  outcome: blocked\n  reason: 连续返工超限\n') }), '/r')
    expect(config.pendingHandoff?.outcome).toBe('blocked')
    expect(config.pendingHandoff?.reason).toBe('连续返工超限')
  })

  it('缺分支名 → 忽略并说明,不留一条没法执行的收口记录', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md('  commits: 3\n') }), '/r')
    expect(config.pendingHandoff).toBeUndefined()
    expect(degraded.join('\n')).toContain('缺少分支名')
  })

  it('没有待收口的老 run.md 照常恢复', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': '---\ngoalPrompt: g\n---\n\n' }), '/r')
    expect(config.pendingHandoff).toBeUndefined()
    expect(degraded.filter(d => d.includes('收口'))).toEqual([])
  })
})

describe('LEGAL_STATUS 必须覆盖每一个状态,否则节点会被永久判死', () => {
  // 这份集合曾经是和 NodeStatus 类型完全脱钩的硬编码字面量。没有 typecheck,漏掉一个
  // 新状态不会有任何东西报错 —— 而 validateLoadedNodes 对不认识的状态调 block(),
  // block() 把 interrupted / capBlocked / mergeConflict 三个复活开关全部清零。
  // 后果:进程在该状态期间被杀 → 下次 --resume 节点永久死亡,--retry-blocked 也救不回。
  it('每个 NodeStatus 都是合法状态', () => {
    for (const st of NODE_STATUSES) {
      expect(`${st}:${LEGAL_STATUS.has(st)}`).toBe(`${st}:true`)
    }
  })

  it('落盘在 VERIFYING 的节点能被恢复,而不是被判死', () => {
    const now = '2026-07-26T00:00:00Z'
    const n = createNode({ id: 'n1', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now })
    n.status = 'VERIFYING'
    n.interrupted = true
    const { nodes, repairs } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now })
    expect(repairs.join('\n')).not.toContain('非法状态')
    expect(nodes[0].status).toBe('VERIFYING')
    // 复活开关没被清掉 —— 这是 --retry-blocked / reseat 能把它捞回来的前提。
    expect(nodes[0].interrupted).toBe(true)
  })

  it('真正的非法状态仍然被拦住', () => {
    const now = '2026-07-26T00:00:00Z'
    const n = createNode({ id: 'n1', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now })
    n.status = 'TOTALLY_MADE_UP' as never
    const { repairs } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now })
    expect(repairs.join('\n')).toContain('非法状态')
  })
})

describe('角色定义读回要认新环节与新键名', () => {
  const md = (body: string) => `---\ngoalPrompt: g\nroleDefs:\n${body}---\n\n`

  it('新环节 verify / integrate 读得回来', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  - name: 测试官\n    step: verify\n    output: o\n    purpose: p\n' +
      '  - name: 集成官\n    step: integrate\n    output: o\n    purpose: p\n') }), '/r')
    expect(config.roleDefs?.map(d => d.stage)).toEqual(['verify', 'integrate'])
    expect(degraded).toEqual([])
  })

  it('旧键名 stage 仍然读得回来 —— 老 run.md 不能一夜作废', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  - name: 架构师\n    stage: review\n    output: o\n    purpose: p\n') }), '/r')
    expect(config.roleDefs?.[0].stage).toBe('review')
  })

  it('手改 run.md 写中文环节名 → 归一,而不是判成「不完整」', async () => {
    // 用户照着文档写的就是中文。归一之前先校验的话,一份合法的手改配置会被判死。
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  - name: 测试官\n    step: 测试验证\n    output: o\n    purpose: p\n') }), '/r')
    expect(config.roleDefs?.[0].stage).toBe('verify')
    expect(degraded).toEqual([])
  })

  it('真正的非法环节名仍然被剔除', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md(
      '  - name: 安全审计员\n    step: 安全审计\n    output: o\n    purpose: p\n') }), '/r')
    expect(config.roleDefs).toBeUndefined()
    expect(degraded.join('\n')).toContain('不完整')
  })
})

describe('评分的其余席位理由要熬过 resume', () => {
  it('others 从盘上读得回来', async () => {
    // 逐字段重建时漏掉它 = 一次 --resume 就丢;而 serializeNode 整对象落盘,恢复后的
    // 第一次 commit 会把盘上那份也抹掉 —— 永久丢失。取最低分是对的,丢掉其余理由是
    // 静默截断。
    const now = '2026-07-26T00:00:00Z'
    const n = createNode({ id: 'n1', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now })
    n.status = 'ACCEPTED'
    n.score = {
      plan: { role: 'low', score: 40, rationale: '差', others: [{ role: 'hi', score: 95, rationale: '好' }] },
      exec: { role: 'low', score: 50, rationale: '一般' },
    }
    const { nodes } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now })
    expect(nodes[0].score?.plan?.others).toEqual([{ role: 'hi', score: 95, rationale: '好' }])
    // 单席位那一维不该凭空多出这个字段
    expect('others' in (nodes[0].score!.exec!)).toBe(false)
  })

  it('写坏的 others 条目被剔除,而不是让整份评分作废', async () => {
    const now = '2026-07-26T00:00:00Z'
    const n = createNode({ id: 'n1', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now })
    n.status = 'ACCEPTED'
    n.score = { plan: { role: 'a', score: 40, rationale: 'r', others: [{ role: 'ok', score: 9, rationale: 'y' }, { bad: 1 }] as never } }
    const { nodes } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now })
    expect(nodes[0].score?.plan?.others).toEqual([{ role: 'ok', score: 9, rationale: 'y' }])
  })
})

describe('每个状态都要能真的从盘上恢复(不是同义反复)', () => {
  // 上一版那条测试遍历 NODE_STATUSES 断言 LEGAL_STATUS.has(...) —— 两边同源,所以它
  // 杀不掉自己注释里描述的那个缺陷。实证:从 NODE_STATUSES 里删掉 'MERGE',全套测试
  // 全绿,而一个在 MERGE 期间被杀的节点从此永久判死。改成对**每个 NodeStatus 造一个
  // 落盘节点**跑 validateLoadedNodes,断言没有「非法状态」修复。
  // **写死**这份清单,不遍历 NODE_STATUSES —— 遍历它自己是同义反复:从 NODE_STATUSES
  // 里删掉一项,这条测试只是少测一项,照样全绿(实测删 'MERGE' 全绿),而一个在该状态
  // 期间被杀的节点从此永久判死。写死才能抓住「类型加了新状态、数组忘了同步」。
  const EVERY_STATUS: TaskNode['status'][] = [
    'CREATED', 'PLANNING', 'PLAN_REVIEW', 'READY', 'EXECUTING', 'EXECUTED', 'ACCEPTANCE',
    'REWORK', 'WAITING_CHILDREN', 'INTEGRATION_ACCEPT', 'VERIFYING', 'SCORING', 'MERGE',
    'ACCEPTED', 'BLOCKED',
  ]

  it('写死的这份清单和 NODE_STATUSES 一样长 —— 加了新状态两边都要动', () => {
    expect(EVERY_STATUS.length).toBe(NODE_STATUSES.length)
  })

  it.each(EVERY_STATUS)('%s 落盘后能被恢复,不被判成非法状态', st => {
    const now = '2026-07-26T00:00:00Z'
    const n = createNode({ id: 'n1', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now })
    n.status = st
    n.interrupted = true
    const { nodes, repairs } = validateLoadedNodes([n], { goal: 'g', phaseRoles: emptyPhaseRoles(), now })
    expect(`${st}:${repairs.join('|').includes('非法状态')}`).toBe(`${st}:false`)
    expect(`${st}:${nodes[0].status}`).toBe(`${st}:${st}`)
  })
})

describe('跳过的环节必须能从 run.md 读回', () => {
  const md = (body: string) => `---\ngoalPrompt: g\n${body}---\n\n`

  it('读回并归一', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': md('skipSteps:\n  - review\n  - 观察\n') }), '/r')
    expect(config.skipSteps).toEqual(['review', 'observer'])
  })

  it('手改 run.md 写了非法环节名 → 丢弃并说明它会照常运行', async () => {
    // 只加读回不加校验的话,一个拼错的名字会静默变成「没跳过」—— 用户以为跳了,系统照跑。
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': md('skipSteps:\n  - 安全审计\n') }), '/r')
    expect(config.skipSteps).toBeUndefined()
    expect(degraded.join('')).toContain('会照常运行')
    // 反话也含这四个字:「…但它会照常运行,所以你不用管」。措辞失守时行为断言还在
    // (skipSteps 被丢弃),但关口说给用户的那句话会变成一句「别管」。
    expect(degraded.join('')).not.toContain('不用管')
  })

  it('老 run.md 没有这个键 → undefined,不报噪音', async () => {
    const { config, degraded } = await readRunManifest(fsWith({ '/r/run.md': '---\ngoalPrompt: g\n---\n\n' }), '/r')
    expect(config.skipSteps).toBeUndefined()
    expect(degraded.filter(d => d.includes('跳过'))).toEqual([])
  })

  it('写进去 → 读回来(writeRunManifest 是白名单,漏了它恢复后跳过全失效)', async () => {
    const files: Record<string, string> = {}
    const fs2: FsLike = {
      ...fsWith(files),
      readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v },
      writeFile: async (p: string, c: string) => { files[p] = c },
    }
    await writeRunManifest(fs2, '/r', {
      goalPrompt: 'g', parallelism: 2, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
      notices: [], skipSteps: ['review', 'accept'],
    } as EffTaskConfig, [])
    const { config } = await readRunManifest(fs2, '/r')
    expect(config.skipSteps).toEqual(['review', 'accept'])
  })
})

describe('落选稿从盘上读回来时要逐条校验', () => {
  // alternatives 是 validateLoadedNodes 唯一不就地补字段的 plan 字段,所以坏数据能
  // 原样穿过去,而 serializeNode 会把它渲染进 body:一条 {staff:1} 就是 [object Object]。
  // node.md 是手改得动的文本,崩溃残留也长这样。
  const withPlan = (alternatives: unknown) =>
    mk({ plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a', alternatives } as never })

  it('不是数组 → 整个丢掉并记进 repairs', () => {
    const out = validateLoadedNodes([withPlan('boom')], OPTS)
    expect((out.nodes[0].plan as { alternatives?: unknown }).alternatives).toBeUndefined()
    expect(out.repairs.join(' ')).toContain('备选方案')
  })

  it('数组里的坏条目被剔除,好的留下', () => {
    const out = validateLoadedNodes([withPlan([
      { staff: 'a', solution: '好的' },
      { staff: 1, solution: '坏的' },
      null,
      { staff: 'b' },
    ])], OPTS)
    const alts = (out.nodes[0].plan as { alternatives?: { staff: string }[] }).alternatives
    expect(alts).toEqual([{ staff: 'a', solution: '好的' }])
    expect(out.repairs.join(' ')).toContain('3 条格式非法')
  })

  it('全是坏的 → 字段整个消失,而不是留一个空数组', () => {
    const out = validateLoadedNodes([withPlan([{ staff: 1 }])], OPTS)
    expect('alternatives' in (out.nodes[0].plan as object)).toBe(false)
  })

  it('合法的原样留着,不报噪音', () => {
    const good = [{ staff: 'a', solution: 'A' }, { staff: 'b', solution: 'B' }]
    const out = validateLoadedNodes([withPlan(good)], OPTS)
    expect((out.nodes[0].plan as { alternatives?: unknown }).alternatives).toEqual(good)
    expect(out.repairs.join(' ')).not.toContain('备选方案')
  })
})

describe('--resume 之后收敛方式不能变', () => {
  // 这个夹取删掉后全量一条不红,而后果是同一个 run 前后两种形态:第一段用圆桌,
  // 恢复之后静默退回精化,用户毫不知情。
  const manifest = (planConverge: string) => [
    '---', 'goalPrompt: 干活', 'parallelism: 3',
    'caps:', '  maxDepth: 5', '  maxNodes: 100', '  maxIterations: 3',
    '  nodeTimeoutMs: 600000', `  planConverge: ${planConverge}`,
    'phaseRoles:', '  plan: []',
    '---', '', '# tree',
  ].join('\n')

  it('run.md 里写的圆桌,读回来还是圆桌', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': manifest('圆桌') }), '/r')
    expect(config.caps.planConverge).toBe('圆桌')
  })

  it('run.md 被手改成不认识的值 → 回落默认,不原样带进 run', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': manifest('roundtable') }), '/r')
    expect(config.caps.planConverge).toBeUndefined()
  })
})

describe('用量:盘上的垃圾值不许上屏', () => {
  /**
   * 变异测试发现:把 `sanitizeUsage(n.usage)` 整条删掉,全量 2400+ 条一条不红 ——
   * `hostileDisk` 那份生成式扫描只保证「不抛」,而这一档的错法是**渲染出一个假数字**
   * (`NaN 次调用 · NaNk tokens`、`-5 次调用`),不是抛异常。node.md 是可手工编辑的。
   */
  const load = (usage: unknown, discarded?: unknown): TaskNode =>
    validateLoadedNodes([mk({ usage: usage as never, discardedUsage: discarded as never })], OPTS).nodes[0]!

  it('NaN / 负数 / 字符串 / 数组 一律被清成 undefined', () => {
    for (const bad of [
      { calls: NaN, input: NaN },
      { calls: -5, input: -1, output: -1, cacheRead: -1, cacheWrite: -1 },
      { calls: 'many', input: '100' },
      [1, 2, 3],
      'nope',
      42,
    ]) {
      expect(`${JSON.stringify(bad)} → ${JSON.stringify(load(bad).usage)}`)
        .toBe(`${JSON.stringify(bad)} → undefined`)
    }
  })

  it('部分合法的保留合法那部分,非法字段归零', () => {
    expect(load({ calls: 3, input: NaN, output: 7 }).usage)
      .toEqual({ calls: 3, input: 0, output: 7, cacheRead: 0, cacheWrite: 0 })
  })

  it('Infinity 不许穿过去 —— 四项相加会溢出,总量反而显示成 0', () => {
    // `1e308` 通过了「有限且非负」,四项一加就是 Infinity,而 formatTokens(Infinity) 是 '0'
    // —— 屏幕上于是印出「1e+308 次调用 · 0 tokens」,两个数互相打脸。
    // Infinity 本身被 num() 当非法读成 0(而不是穿过去当一个天文数字)。
    expect(load({ calls: Infinity, input: 1 }).usage?.calls).toBe(0)
    const huge = load({ calls: 1e308, input: 1e308, output: 1e308, cacheRead: 1e308, cacheWrite: 1e308 }).usage!
    expect(Number.isFinite(huge.calls + huge.input + huge.output + huge.cacheRead + huge.cacheWrite)).toBe(true)
  })

  it('discardedUsage 走同一道校验', () => {
    expect(load(undefined, { calls: NaN }).discardedUsage).toBeUndefined()
    expect(load(undefined, { calls: 9, input: 5 }).discardedUsage)
      .toEqual({ calls: 9, input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

