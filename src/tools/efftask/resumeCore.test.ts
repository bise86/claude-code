import { describe, expect, it } from 'bun:test'
import { depCycleMembers, validateLoadedNodes } from './resumeCore.js'
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
import { DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
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
    expect(config.phaseRoles.plan[0]).toEqual({ roleName: 'planner', model: 'm1' })
    expect(config.caps.maxDepth).toBe(4)
    // scoreThreshold must survive: rebuilding caps field-by-field silently dropped it, so a
    // run configured with a threshold lost it on resume.
    expect(config.caps.scoreThreshold).toBe(7)
    expect(config.notices).toEqual(['观察:已忽略'])
    expect(config.mainModel).toBe('claude-opus-4-8')
    expect(config.resumeGuidance).toBe('先从简')
    expect(degraded).toEqual([])
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
})
