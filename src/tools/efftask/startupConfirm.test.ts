import { describe, expect, it } from 'bun:test'
import { DEFAULT_CAPS, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig } from './types.js'
import { clip, createResolveOnce, goalLine, raceConfirm, rosterLines, type ConfirmSurface, resumeSummarySections , capsLine, parallelismLine, handoffLines, exitReportLine, toggleRole, rosterEditorLines, applyStartupDecision, dispatchableRoles } from './startupConfirm.js'

const later = (fn: () => void) => setTimeout(fn, 1)

describe('startupConfirm racer', () => {
  it('createResolveOnce: only the first claim wins and it carries the value', async () => {
    const r = createResolveOnce<number>()
    expect(r.claim(7)).toBe(true)
    expect(r.claim(9)).toBe(false) // no way to resolve without claiming
    expect(await r.promise).toBe(7)
  })

  it('raceConfirm: first surface to answer wins, and EVERY surface is torn down', async () => {
    const torn: string[] = []
    const { winner, decision } = await raceConfirm([
      (claim, onTeardown) => { later(() => claim('terminal', { parallelism: 5, approved: true })); onTeardown(() => torn.push('A')) },
      (_claim, onTeardown) => { onTeardown(() => torn.push('B')) },
    ])
    expect(decision.approved).toBe(true)
    expect(winner).toBe('terminal')
    // the WINNER is torn down too — its surface must also render a resolved state
    expect(torn.sort()).toEqual(['A', 'B'])
  })

  it('raceConfirm: every teardown learns who won and what was decided', async () => {
    const seen: Array<[string, boolean]> = []
    await raceConfirm([
      (claim, onTeardown) => { later(() => claim('feishu', { parallelism: 2, approved: false })); onTeardown((w, d) => seen.push([w, d.approved])) },
      (_claim, onTeardown) => { onTeardown((w, d) => seen.push([w, d.approved])) },
    ])
    expect(seen).toEqual([['feishu', false], ['feishu', false]])
  })

  it('raceConfirm: a THROWING surface does not kill the race, and its partial cleanup still runs', async () => {
    const torn: string[] = []
    const { decision } = await raceConfirm([
      (_claim, onTeardown) => { onTeardown(() => torn.push('partial')); throw new Error('飞书 surface 构造失败') },
      (claim, onTeardown) => { later(() => claim('terminal', { parallelism: 3, approved: true })); onTeardown(() => torn.push('B')) },
    ])
    expect(decision.parallelism).toBe(3) // the surviving surface still wins
    // cleanup registered BEFORE the throw is still unwound — otherwise a half-built Feishu
    // surface would leave a live entry in the registry the permission bridge shares.
    expect(torn.sort()).toEqual(['B', 'partial'])
  })

  it('raceConfirm: a throwing teardown does not stop the others', async () => {
    const torn: string[] = []
    await raceConfirm([
      (claim, onTeardown) => { later(() => claim('terminal', { parallelism: 1, approved: true })); onTeardown(() => { throw new Error('boom') }) },
      (_claim, onTeardown) => { onTeardown(() => torn.push('B')) },
    ])
    expect(torn).toEqual(['B'])
  })

  it('raceConfirm: with no surviving surface it fails fast instead of hanging', async () => {
    const { winner, decision } = await raceConfirm([
      () => { throw new Error('构造失败') },
    ])
    expect(winner).toBe('cancelled')
    expect(decision.approved).toBe(false)
    expect((await raceConfirm([])).winner).toBe('cancelled')
  })

  it('raceConfirm: an abort settles the gate instead of leaving it pending', async () => {
    const ac = new AbortController()
    const torn: string[] = []
    const surface: ConfirmSurface = (_claim, onTeardown) => { onTeardown(w => torn.push(w)) }
    later(() => ac.abort())
    const { winner, decision } = await raceConfirm([surface], { signal: ac.signal })
    expect(winner).toBe('cancelled')
    expect(decision.approved).toBe(false)
    expect(torn).toEqual(['cancelled']) // surfaces are told, so the card stops looking live
    // already-aborted signal settles immediately too
    expect((await raceConfirm([surface], { signal: ac.signal })).winner).toBe('cancelled')
  })

  it('rosterLines renders the REAL roster, 主模型 for phases with no bindings', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 5, caps: { ...DEFAULT_CAPS },
      phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'arch' }, { roleName: 'sec', model: 'opus' }] },
    }
    const lines = rosterLines(cfg)
    expect(lines).toHaveLength(5) // one line per PHASE_NAMES entry
    expect(lines).toContain('评审: arch、sec(opus)') // the bound model is visible on the gate
    expect(lines).toContain('方案: 主模型')
  })

  it('clip/goalLine never emit a lone surrogate and skip leading blank lines', () => {
    // A raw .slice() counts UTF-16 units, so an emoji at the boundary is cut in half and a
    // lone surrogate reaches the card payload and the terminal.
    const out = goalLine('x'.repeat(79) + '🎉尾部')
    expect(out.isWellFormed()).toBe(true)
    expect(Array.from(out).length).toBe(80)
    expect(goalLine('\n\n  真正的目标  ')).toBe('真正的目标')
    expect(clip('短')).toBe('短') // untouched when under budget
  })

  it('a teardown registered after the race settled still runs', async () => {
    // A surface registering cleanup in a .then would otherwise never be torn down.
    const late: string[] = []
    let collect!: (fn: (w: string) => void) => void
    await raceConfirm([
      (claim, onTeardown) => { collect = onTeardown as never; later(() => claim('terminal', { parallelism: 1, approved: true })); onTeardown(() => {}) },
    ])
    collect(w => late.push(w))
    expect(late).toEqual(['terminal'])
  })

  it('rosterLines clips a runaway roster so it cannot wreck the layout', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 5, caps: { ...DEFAULT_CAPS },
      phaseRoles: { ...emptyPhaseRoles(), accept: Array.from({ length: 40 }, (_, i) => ({ roleName: `role-${i}` })) },
    }
    const line = rosterLines(cfg).find(l => l.startsWith('验收: '))!
    expect(Array.from(line).length).toBeLessThanOrEqual(84) // label + 80 budget
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('resumeSummarySections tells the user what recovery actually did', () => {
  const base = {
    runId: '003',
    counts: { accepted: 2, blocked: 1, pending: 3, total: 6 },
    repairs: [], reseated: [], exhausted: [], degraded: [], loadErrors: [],
  }
  it('always leads with where it is resuming from and the counts', () => {
    const s = resumeSummarySections(base)
    expect(s[0].heading).toContain('003')
    expect(s[0].lines[0]).toContain('已验收 2')
    expect(s[0].lines[0]).toContain('共 6')
  })
  it('omits channels that have nothing in them', () => {
    expect(resumeSummarySections(base)).toHaveLength(1)
  })
  it('surfaces all four recovery channels when they are non-empty', () => {
    // §17.2 requires the validation summary reach the user; dropping any of these means
    // approving a resume without seeing what it silently changed.
    const s = resumeSummarySections({
      ...base,
      reseated: ['root/01-a'], exhausted: ['root/02-b'],
      repairs: ['节点 x:依赖节点缺失'], loadErrors: ['root/03/node.md: 解析失败'],
      degraded: ['run.md 无法读取'],
    })
    const text = s.map(x => `${x.heading} ${x.lines.join(' ')}`).join(' | ')
    expect(text).toContain('root/01-a')
    expect(text).toContain('预算已耗尽')
    expect(text).toContain('依赖节点缺失')
    expect(text).toContain('无法读取')
    expect(s.filter(x => x.tone === 'warn').length).toBeGreaterThanOrEqual(4)
  })
  it('announces guidance inherited from a previous resume', () => {
    const s = resumeSummarySections({ ...base, inheritedGuidance: '先从简' })
    expect(s.map(x => x.heading).join(' ')).toContain('沿用')
  })
})

describe('capsLine discloses the scoring threshold, which CHANGES behaviour', () => {
  const base: EffTaskConfig = {
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [],
  }
  it('says scoring will not rework when no threshold is set', () => {
    expect(capsLine(base)).toContain('评分不触发返工')
  })
  it('names the threshold when one is set', () => {
    // A prompt saying 打分严格些 can flip 观察评分 from record-only to "低分返工一轮".
    // A gate that hides a behaviour switch is the failure this gate exists to prevent.
    expect(capsLine({ ...base, caps: { ...DEFAULT_CAPS, scoreThreshold: 80 } }))
      .toContain('评分低于 80 触发一轮返工')
  })
  it('still shows the other valves', () => {
    expect(capsLine(base)).toContain('深度5')
    expect(capsLine(base)).toContain('节点100')
    expect(capsLine(base)).toContain('迭代3')
  })
})

describe('parallelismLine 必须描述 THIS run,而不是一句固定话', () => {
  const base: EffTaskConfig = {
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [],
  }
  it('un-isolated: says execute and leaf acceptance are serial', () => {
    const line = parallelismLine(base, { editable: false, isolation: 'none' })
    expect(line).toContain('方案/评审阶段并行')
    expect(line).toContain('执行与叶子验收串行')
    expect(line).toContain('未启用隔离')
  })
  it('isolated: says every phase runs in parallel, in its own worktree', () => {
    // The same sentence for both would be right for one kind of run and a lie for the other —
    // and this line is the ONLY place the user is told.
    const line = parallelismLine(base, { editable: false, isolation: 'worktree' })
    expect(line).toContain('各阶段并行')
    expect(line).toContain('worktree')
    expect(line).not.toContain('串行')
  })
  it('defaults to the honest, conservative description when isolation is unknown', () => {
    expect(parallelismLine(base, { editable: false })).toContain('串行')
  })
})

describe('handoffLines 告诉用户工作在哪,以及怎么处置', () => {
  it('names the branch and the exact commands, and says the tree is untouched', () => {
    const lines = handoffLines({ branch: 'efftask/001/integration', commits: 7, kept: [], salvage: [] })
    const text = lines.join('\n')
    expect(text).toContain('efftask/001/integration')
    expect(text).toContain('7 个提交')
    expect(text).toContain('你的工作区未被改动') // we deliberately did not touch it
    expect(text).toContain('git merge efftask/001/integration')
    expect(text).toContain('git branch -D efftask/001/integration')
  })

  it('does not offer merge commands for a run that produced nothing', () => {
    const text = handoffLines({ branch: 'b', commits: 0, kept: [], salvage: [] }).join('\n')
    expect(text).toContain('没有产生任何改动')
    expect(text).not.toContain('git merge')
  })

  it('surfaces kept worktrees and salvage refs — the things nobody would find otherwise', () => {
    const text = handoffLines({
      branch: 'b', commits: 1,
      kept: [{ path: '/wt/efftask-001-abc', why: '仍有未合入的内容' }],
      salvage: ['efftask/001/salvage/efftask-001-abc'],
    }).join('\n')
    expect(text).toContain('/wt/efftask-001-abc')
    expect(text).toContain('仍有未合入的内容')
    expect(text).toContain('salvage')
  })

  it('丢弃命令必须先移除集成工作区,否则 git 会拒绝', () => {
    // Verified against real git, not assumed: the integration branch is CHECKED OUT in the
    // integration worktree, which nothing ever reclaims (dispose() walks only the nodes it is
    // handed, and the next run re-adopts this one). git therefore refuses:
    //   error: cannot delete branch 'efftask/001/integration' used by worktree at '…'
    // So the one-liner this used to print could never work. Printing a command that always
    // fails is worse than printing none — the user reads it as the supported way out.
    const text = handoffLines({
      branch: 'efftask/001/integration', commits: 7, kept: [], salvage: [],
      integrationPath: '/repo/.efftask-worktrees/integration',
    }).join('\n')
    expect(text).toContain('git worktree remove /repo/.efftask-worktrees/integration')
    // …and in that exact order, before the branch delete.
    expect(text).toMatch(/git worktree remove \S+ && git branch -D efftask\/001\/integration/)
  })

  it('集成工作区的存在本身要说出来 —— 它建在用户仓库里,而且比 run 活得久', () => {
    const text = handoffLines({
      branch: 'b', commits: 0, kept: [], salvage: [],
      integrationPath: '/repo/.efftask-worktrees/integration',
    }).join('\n')
    // Even with nothing to discard: this directory is created inside the user's repo, is
    // reused by the next run, and nothing anywhere else ever mentions it.
    expect(text).toContain('/repo/.efftask-worktrees/integration')
  })

  it('没有集成工作区路径时,丢弃命令要自己说清可能会被拒', () => {
    // handoff() always supplies it now, but the field is optional and a resumed/degraded run
    // can reach here without one. Silently printing the old broken one-liner would put us
    // back exactly where we started.
    const text = handoffLines({ branch: 'b', commits: 3, kept: [], salvage: [] }).join('\n')
    expect(text).toContain('git branch -D b')
    expect(text).toContain('worktree')
  })
})

describe('resumeSummarySections 对 --retry-blocked 要说清楚', () => {
  const base = {
    runId: '003',
    counts: { accepted: 2, blocked: 1, pending: 3, total: 6 },
    repairs: [], reseated: [], exhausted: [], degraded: [], loadErrors: [],
  }
  it('gives the valve retry its OWN loud section, not a line inside 重新排队', () => {
    // This is the one resume action that re-arms a safety valve: it spends budget the run
    // already refused to spend. Folding it into the ordinary reseat count would let it pass
    // the gate unread.
    const s = resumeSummarySections({ ...base, retried: ['root/01-a', 'root/02-b'] })
    const sec = s.find(x => x.heading.includes('--retry-blocked'))
    expect(sec).toBeDefined()
    expect(sec!.heading).toContain('2 个')
    expect(sec!.heading).toContain('预算已重置')
    expect(sec!.tone).toBe('warn')
    expect(sec!.lines).toEqual(['root/01-a', 'root/02-b'])
  })
  it('says nothing when the flag was not used', () => {
    expect(resumeSummarySections({ ...base, retried: [] }).some(x => x.heading.includes('retry'))).toBe(false)
    expect(resumeSummarySections(base).some(x => x.heading.includes('retry'))).toBe(false)
  })
})

describe('exitReportLine:退出时留在 transcript 里的那一行', () => {
  const h = { branch: 'efftask/007/integration', commits: 3, kept: [], salvage: [] }

  it('names the run, how it ended, and where run.md is', () => {
    // This line replaced a closure that referenced `handoffRef` — an identifier declared
    // inside the React component, NOT inside call(). Every exit with a run id therefore threw
    // ReferenceError from inside a .then(), onDone was never called, and
    // processSlashCommand's promise stayed pending forever. A bare identifier is valid
    // syntax, so the parse gate could not see it and the file has no other tests.
    const l = exitReportLine({ runId: '007', how: '完成', resumed: false, withPath: true, handoff: null })
    expect(l).toContain('高效任务 007')
    expect(l).toContain('完成')
    expect(l).toContain('.claude/efftask/007/run.md')
  })

  it('says 续跑 for a resumed run', () => {
    expect(exitReportLine({ runId: '007', how: '完成', resumed: true, withPath: true, handoff: null })).toContain('续跑')
  })

  it('omits the path when the run directory was an unused reservation', () => {
    const l = exitReportLine({ runId: '007', how: '已取消', resumed: false, withPath: false, handoff: null })
    expect(l).not.toContain('run.md')
  })

  it('appends the handoff, which is the only place the branch is named', () => {
    const l = exitReportLine({ runId: '007', how: '完成', resumed: false, withPath: true, handoff: h })
    expect(l).toContain('efftask/007/integration')
    expect(l).toContain('3 个提交')
  })
})

describe('名册可编辑 (spec §2 第一关)', () => {
  const empty = (): Record<string, { roleName: string }[]> =>
    ({ plan: [], review: [], execute: [], accept: [], observer: [] })

  it('toggleRole adds and removes', () => {
    const a = toggleRole(empty() as never, 'review', 'architect')
    expect(a.review.map(r => r.roleName)).toEqual(['architect'])
    const b = toggleRole(a, 'review', 'security')
    expect(b.review.map(r => r.roleName)).toEqual(['architect', 'security'])
    const c = toggleRole(b, 'review', 'architect')
    expect(c.review.map(r => r.roleName)).toEqual(['security'])
  })

  it('returns a NEW roster and shares no array with the old one', () => {
    // createNode copies phaseRoles per node; a shared array instance would let one edit at the
    // gate reach every node in the tree.
    const a = toggleRole(empty() as never, 'review', 'architect')
    const b = toggleRole(a, 'accept', 'qa')
    expect(a.accept).toEqual([])          // the earlier roster is untouched
    expect(b.review).not.toBe(a.review)   // and no array is shared
  })

  it('lets a phase be emptied — otherwise the editor cannot undo its own additions', () => {
    const a = toggleRole(empty() as never, 'plan', 'architect')
    expect(toggleRole(a, 'plan', 'architect').plan).toEqual([])
  })

  it('rosterEditorLines marks what is bound and where the cursor is', () => {
    const r = toggleRole(empty() as never, 'review', 'security')
    const lines = rosterEditorLines(r, ['architect', 'security'], 1, 1)
    expect(lines[1]).toContain('▶')             // the focused phase
    expect(lines[1]).toContain('>[x]security')  // focused role, and it IS bound
    expect(lines[1]).toContain(' [ ]architect') // unfocused, unbound
    expect(lines[0]).not.toContain('▶')
  })

  it('单座位阶段是单选 —— 运行只派第 0 个,名册上第二个名字就是空头', () => {
    // parseDirectives already trims plan/execute/observer to one and pushes a notice, because
    // firstRole() dispatches index 0 and nothing else. An editor that appends re-opens that
    // hole by hand: measured 观察: w1、w2 on the roster with only w1 ever dispatched, and no
    // notice anywhere.
    let r = toggleRole(empty() as never, 'observer', 'w1')
    r = toggleRole(r, 'observer', 'w2')
    expect(r.observer.map(x => x.roleName)).toEqual(['w2'])
    let p = toggleRole(empty() as never, 'plan', 'a1')
    p = toggleRole(p, 'plan', 'a2')
    expect(p.plan.map(x => x.roleName)).toEqual(['a2'])
    let e = toggleRole(empty() as never, 'execute', 'c1')
    e = toggleRole(e, 'execute', 'c2')
    expect(e.execute.map(x => x.roleName)).toEqual(['c2'])
  })

  it('圆桌阶段仍然可以多选 —— 那才是"多角色"的意思', () => {
    let r = toggleRole(empty() as never, 'review', 'a')
    r = toggleRole(r, 'review', 'b')
    r = toggleRole(r, 'accept', 'c')
    r = toggleRole(r, 'accept', 'd')
    expect(r.review.map(x => x.roleName)).toEqual(['a', 'b'])
    expect(r.accept.map(x => x.roleName)).toEqual(['c', 'd'])
  })

  it('单座位阶段的行上写明它是单选', () => {
    const lines = rosterEditorLines(empty() as never, ['a'], 0, 0)
    expect(lines[0]).toContain('(单选)')  // 方案
    expect(lines[1]).not.toContain('(单选)') // 评审
  })

  it('toggleRole 记住模型,否则只读名册会掉回裸名字', () => {
    const r = toggleRole(empty() as never, 'review', 'security', 'claude-opus-5')
    expect(r.review[0]).toEqual({ roleName: 'security', model: 'claude-opus-5' })
  })

  it('候选很多时按窗口显示,并说明有多少在窗口外', () => {
    // available is every dispatchable agent, not just settings roles — a dozen is ordinary.
    // Measured unwindowed at 40: one row was 1281 chars and the box grew to 32 lines,
    // pushing the goal and the caps line off screen.
    const many = [...Array(40)].map((_, i) => `role${i}`)
    const lines = rosterEditorLines(empty() as never, many, 0, 20)
    expect(lines[0].length).toBeLessThan(200)
    expect(lines[0]).toContain('>[ ]role20') // the cursor stays inside the window
    expect(lines[0]).toMatch(/←\d+/)          // and the count off-screen is stated
    expect(lines[0]).toMatch(/→\d+/)
  })

  it('applyStartupDecision:缺省的名册表示"没改"', () => {
    const cfg = {
      goalPrompt: 'g', parallelism: 3, notices: [], caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
      phaseRoles: { plan: [{ roleName: 'a' }], review: [], execute: [], accept: [], observer: [] },
    } as never
    // A Feishu approval carries no roster; it must keep exactly the one its card displayed.
    expect(applyStartupDecision(cfg, { parallelism: 7, approved: true }).phaseRoles.plan).toEqual([{ roleName: 'a' }])
    expect(applyStartupDecision(cfg, { parallelism: 7, approved: true }).parallelism).toBe(7)
    // A terminal approval carries the edited one.
    const edited = { plan: [{ roleName: 'z' }], review: [], execute: [], accept: [], observer: [] }
    expect(applyStartupDecision(cfg, { parallelism: 2, approved: true, phaseRoles: edited as never }).phaseRoles.plan)
      .toEqual([{ roleName: 'z' }])
  })

  it('dispatchableRoles 滤掉这次会话派不出去的角色', () => {
    // An execMode:'cli' role is dispatched by AgentTool, not by this run's runAgent seam.
    // Offering it would put a seat on the roster that silently becomes the main model.
    expect(dispatchableRoles(['architect', 'legacy-cli', 'qa'], ['legacy-cli'])).toEqual(['architect', 'qa'])
    expect(dispatchableRoles([], ['x'])).toEqual([])
  })

  it('names what an empty phase actually means, per phase', () => {
    // 观察 is opt-in and does NOT fall back to the main model; saying 主模型 there would
    // promise a scorer that never runs — the same distinction rosterLines already makes.
    const lines = rosterEditorLines(empty() as never, ['a'], 0, 0)
    expect(lines[0]).toContain('(主模型)')
    expect(lines[4]).toContain('(不评分)')
  })

  it('says why the table is empty when settings has no roles at all', () => {
    // A blank row reads as a broken editor.
    expect(rosterEditorLines(empty() as never, [], 0, 0)[0]).toContain('没有可用角色')
  })
})
