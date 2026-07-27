import { describe, expect, it } from 'bun:test'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { clip, createResolveOnce, goalLine, raceConfirm, rosterLines, type ConfirmSurface, resumeSummarySections , capsLine, parallelismLine, handoffLines, relativeTime, applyRosterToNodes, isolationChoiceLines, rosterEquals, exitReportLine, toggleRole, rosterEditorLines, applyStartupDecision, dispatchableRoles, costLine, skipConflictLines, skipConsequenceLines } from './startupConfirm.js'
import { applyRoleDefsToPhases } from './roleDefs.js'

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
    // 一个环节一行 —— 用 PHASE_NAMES.length 而不是写死的数字,这个列表会增长。
    expect(lines).toHaveLength(PHASE_NAMES.length)
    expect(lines).toContain('质疑讨论: arch、sec(opus)') // the bound model is visible on the gate
    expect(lines).toContain('分析: 主模型')
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
    expect(lines[1]).toContain('▶')             // the focused phase (phaseIdx=1)
    expect(lines[1]).toContain('>[x]security')  // focused role, and it IS bound
    expect(lines[1]).toContain(' [ ]architect') // unfocused, unbound
    expect(lines[0]).not.toContain('▶')
  })

  it('单座位阶段是单选 —— 运行只派第 0 个,名册上第二个名字就是空头', () => {
    // parseDirectives already trims plan/execute/observer to one and pushes a notice, because
    // firstRole() dispatches index 0 and nothing else. An editor that appends re-opens that
    // hole by hand: measured 观察: w1、w2 on the roster with only w1 ever dispatched, and no
    // notice anywhere.
    // observer 现在是圆桌:多员工各自打分,取最低分收敛,其余理由挂在 others 上。
    // 真正的单席位只剩 execute —— 那是物理约束(pathFor 不含员工维度)。
    let r = toggleRole(empty() as never, 'observer', 'w1')
    r = toggleRole(r, 'observer', 'w2')
    expect(r.observer.map(x => x.roleName)).toEqual(['w1', 'w2'])
    // plan 不在此列:它走顺序精化(第一位起草,后面每一位在前一稿上修订),多员工是
    // 支持的形态。这条断言曾经写的是 ['a2'] —— 那是关口和流水线漂移出来的 bug:
    // 用户连点两个方案员工,第二个把第一个顶掉且毫无提示。
    let p = toggleRole(empty() as never, 'plan', 'a1')
    p = toggleRole(p, 'plan', 'a2')
    expect(p.plan.map(x => x.roleName)).toEqual(['a1', 'a2'])
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
    // 按标签找,不按下标 —— 环节列表会增长,下标断言到时会静默错位到别的行。
    const row = (label: string) => lines.find(l => l.includes(label))!
    expect(row('分析')).not.toContain('(单选)')     // 顺序精化,可多员工
    expect(row('质疑讨论')).not.toContain('(单选)') // 圆桌
    expect(row('执行')).toContain('(单选)')         // 物理约束,只能一个
    expect(row('观察')).not.toContain('(单选)')     // 圆桌:取最低分收敛
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
    const row = (label: string) => lines.find(l => l.includes(label))!
    expect(row('分析')).toContain('(主模型)')
    expect(row('观察')).toContain('(不评分)')
  })

  it('says why the table is empty when settings has no roles at all', () => {
    // A blank row reads as a broken editor.
    expect(rosterEditorLines(empty() as never, [], 0, 0)[0]).toContain('没有可用角色')
  })
})

describe('spec §17.1:恢复选择器要显示最后更新时间', () => {
  const T = Date.parse('2026-07-26T12:00:00.000Z')
  it('按量级给出相对时间', () => {
    expect(relativeTime('2026-07-26T11:59:30.000Z', T)).toBe('刚刚')
    expect(relativeTime('2026-07-26T11:40:00.000Z', T)).toBe('20 分钟前')
    expect(relativeTime('2026-07-26T09:00:00.000Z', T)).toBe('3 小时前')
    expect(relativeTime('2026-07-21T12:00:00.000Z', T)).toBe('5 天前')
  })

  it('时间戳不可用时返回空串,而不是编一个', () => {
    // listRuns 的累加器从 '' 起步,只有节点带 STRING 时间戳才会被替换 —— 所以每个 node.md
    // 都被写坏的 run 到这里就是空的。而 Date.parse 会强制转换不会抛,`updatedAt: 123`
    // 曾经因此渲染出一个 1970 年的年龄。
    expect(relativeTime('', T)).toBe('')
    expect(relativeTime('不是时间', T)).toBe('')
    expect(relativeTime(123 as never, T)).toBe('')
  })

  it('时钟偏差不能渲染成负数', () => {
    // 另一台机器写的 run.md 可能比本机时钟略新。
    expect(relativeTime('2026-07-26T12:05:00.000Z', T)).toBe('刚刚')
  })
})

describe('spec §17.3:关口改出来的名册必须落到节点上,否则编辑器是摆设', () => {
  const node = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-26T00:00:00Z' }),
    ...over,
  })
  const roster = { ...emptyPhaseRoles(), plan: [{ roleName: 'architect' }], review: [{ roleName: 'qa' }] }

  it('未完成的节点换成新名册', () => {
    // 派发只读 node.phaseRoles:firstRole 走它,圆桌走它,createChildren 还把父节点那份
    // 抄给每一个新子节点。config.phaseRoles 进入树只有 makeRootNode 一条路,而带 seed 的
    // (也就是恢复的)run 永远不走那条路 —— 所以改出来的名册此前被任何代码读到过。
    const n = node({ status: 'READY', phaseRoles: { ...emptyPhaseRoles(), plan: [{ roleName: 'ghost-已不存在' }] } })
    expect(applyRosterToNodes([n], roster).changed).toBe(1)
    expect(n.phaseRoles.plan).toEqual([{ roleName: 'architect' }])
    expect(n.phaseRoles.review).toEqual([{ roleName: 'qa' }])
  })

  it('已 ACCEPTED 的节点不动 —— 它的评审记录是旧班子做的', () => {
    // §17.5 的既有立场:恢复「不修改已 ACCEPTED 的节点」。改掉它的名册等于把已完成的工作
    // 归到一个从没参与过的角色名下。
    const done = node({ id: 'root/01-a', status: 'ACCEPTED', phaseRoles: { ...emptyPhaseRoles(), plan: [{ roleName: 'old' }] } })
    const live = node({ id: 'root/02-b', status: 'READY' })
    expect(applyRosterToNodes([done, live], roster).changed).toBe(1)
    expect(done.phaseRoles.plan).toEqual([{ roleName: 'old' }])
    expect(live.phaseRoles.plan).toEqual([{ roleName: 'architect' }])
  })

  it('BLOCKED 的节点要换 —— --retry-blocked 重开的正是它们', () => {
    const n = node({ status: 'BLOCKED', capBlocked: true })
    applyRosterToNodes([n], roster)
    expect(n.phaseRoles.plan).toEqual([{ roleName: 'architect' }])
  })

  it('每个节点拿到的是各自的副本,不是共享的同一个数组', () => {
    // §4.2 允许每节点覆写名册;共享数组会让一次覆写改掉整棵树。
    const a = node({ id: 'a', status: 'READY' })
    const b = node({ id: 'b', status: 'READY' })
    applyRosterToNodes([a, b], roster)
    a.phaseRoles.plan.push({ roleName: 'extra' })
    expect(b.phaseRoles.plan).toEqual([{ roleName: 'architect' }])
    expect(a.phaseRoles.plan).not.toBe(roster.plan)
  })
})

describe('spec §8:非 git 仓库要给用户一个选择,而不是自动降级', () => {
  // §8:「若当前目录非 git 仓库 → 提示用户……并允许**选择**『改用共享工作目录串行执行』
  // 降级(**或初始化 git**)」。实现只做了自动降级 —— 一行字塞进 notices,和解析提示词
  // 产生的提醒混在「以下请求不会生效」这个标题下面。那个标题讲的是"你的请求没生效",
  // 而这里发生的是"整个 run 的执行方式变了"。
  it('说清降级之后到底会怎么跑,而不是只说"不可用"', () => {
    const lines = isolationChoiceLines('当前目录不是 git 仓库', true)
    const text = lines.join('\n')
    expect(text).toContain('当前目录不是 git 仓库')
    expect(text).toContain('共享')
    expect(text).toContain('串行')     // 这是真的:orchestrator 的 serialiseExecute
    expect(text).toContain('方案/评审') // 而这些阶段仍然并行 —— 别把降级说得比实际严重
  })

  it('能初始化 git 时才提 g 键', () => {
    const t = isolationChoiceLines('r', true).join('\n')
    expect(t).toContain('按 g')
    // 并且说清 g 会做什么:它会建一个空提交,而那是隔离能跑起来的前提 —— 实测全新仓库
    // `git rev-parse HEAD` 直接 fatal,worktreePool.init 第一行就挂。
    expect(t).toContain('空提交')
  })

  it('不能初始化时不宣传那个键,改说怎么办', () => {
    // 宣传一个按不动的键,正是这个仓库反复在修的那类问题。
    const text = isolationChoiceLines('r', false).join('\n')
    expect(text).not.toContain('按 g')
    // 而且不能叫一个**已经在仓库里**的人去"找个 git 仓库":除 notARepo 之外的每一种失败,
    // 目录本来就是仓库(没有提交 / 分支名冲突 / worktree 被别处占用),真正可操作的是
    // 上面那条原因本身。
    expect(text).not.toContain('git 仓库里运行')
    expect(text).toContain('先解决上面这条原因')
  })
})

describe('名册只在用户真改了的时候才写回节点', () => {
  const R = (over: Partial<Record<string, { roleName: string }[]>> = {}) =>
    ({ ...emptyPhaseRoles(), ...over }) as never

  it('一模一样就认作没改', () => {
    expect(rosterEquals(R({ plan: [{ roleName: 'a' }] }), R({ plan: [{ roleName: 'a' }] }))).toBe(true)
    expect(rosterEquals(emptyPhaseRoles(), emptyPhaseRoles())).toBe(true)
  })

  it('增删、换名、换模型都算改了', () => {
    expect(rosterEquals(R({ plan: [{ roleName: 'a' }] }), R())).toBe(false)
    expect(rosterEquals(R({ plan: [{ roleName: 'a' }] }), R({ plan: [{ roleName: 'b' }] }))).toBe(false)
    expect(rosterEquals(
      R({ plan: [{ roleName: 'a' }] }),
      R({ plan: [{ roleName: 'a', model: 'opus' } as never] }),
    )).toBe(false)
    // 顺序也算 —— 单席位阶段取的是 index 0,换顺序就是换人。
    expect(rosterEquals(
      R({ review: [{ roleName: 'a' }, { roleName: 'b' }] }),
      R({ review: [{ roleName: 'b' }, { roleName: 'a' }] }),
    )).toBe(false)
  })

  it('run.md 损坏时,不能拿空名册去抹掉 node.md 里还活着的角色', () => {
    // readRunManifest 读不出 run.md 时回退成 emptyPhaseRoles() 并标 degraded。无条件写回
    // 就会把每个 node.md 里真实、可派发的角色全部清成主模型 —— 而 node.md 才是幸存的真相,
    // readRunManifest 自己的注释就写着 every node.md is still on disk。
    // 用户没改任何东西 ⇒ 两份名册相等 ⇒ 调用点不会调 applyRosterToNodes。
    expect(rosterEquals(emptyPhaseRoles(), emptyPhaseRoles())).toBe(true)
  })
})

describe('关口名册要如实说出角色与员工', () => {
  const cfg = (phaseRoles: Partial<Record<PhaseName, RoleBinding[]>>, mainModel?: string): EffTaskConfig =>
    ({ goalPrompt: 'g', parallelism: 2, caps: { ...DEFAULT_CAPS }, notices: [], mainModel,
       phaseRoles: { ...emptyPhaseRoles(), ...phaseRoles } })

  it('带角色标签的席位:角色和员工都说出来', () => {
    const line = rosterLines(cfg({ review: [{ roleName: 'opus-架构', model: 'claude-opus-4-8', roleTag: '架构师' }] }))
      .find(l => l.startsWith('质疑讨论'))!
    expect(line).toContain('架构师')
    expect(line).toContain('opus-架构')
    expect(line).toContain('claude-opus-4-8')
  })

  it('主模型兼任的席位不会渲染成一个光秃秃的括号', () => {
    // roleName 是空串。直接插值曾经产出 `验收: 验收官←(claude-opus-4-8)` —— 一个没有
    // 名字的括号,读起来像是配置坏了。
    const line = rosterLines(cfg({ accept: [{ roleName: '', roleTag: '验收官' }] }, 'claude-opus-4-8'))
      .find(l => l.startsWith('验收'))!
    expect(line).toContain('验收官')
    expect(line).toContain('主模型')
    expect(line).not.toMatch(/←\(/)
    expect(line).not.toMatch(/^验收: \(/)
  })

  it('没有角色标签的席位照旧只显示员工与模型', () => {
    const line = rosterLines(cfg({ review: [{ roleName: 'opus-架构', model: 'm' }] })).find(l => l.startsWith('质疑讨论'))!
    expect(line).toBe('质疑讨论: opus-架构(m)')
  })

  it('同一员工兼两角 → 名册上两席都点名各自的角色', () => {
    const line = rosterLines(cfg({
      review: [
        { roleName: 'ds-安全', model: 'm', roleTag: '架构师' },
        { roleName: 'ds-安全', model: 'm', roleTag: '安全' },
      ],
    })).find(l => l.startsWith('质疑讨论'))!
    // 不点名角色的话用户会看到两个一模一样的 `ds-安全(m)`,分不清是配置生效了还是 bug。
    expect(line).toContain('架构师')
    expect(line).toContain('安全')
  })
})

describe('rosterEquals 必须把角色归属算进去', () => {
  it('员工与模型都一样、只有角色不同 → 不算相等', () => {
    // 判成相等,applyRosterToNodes 就被跳过,节点上留着旧的角色标签,每一席收到的
    // 职责简报是上一次那份 —— 名册看起来变了,模型收到的没变。
    const a = { ...emptyPhaseRoles(), review: [{ roleName: 'opus-架构', model: 'm', roleTag: '架构师' }] }
    const b = { ...emptyPhaseRoles(), review: [{ roleName: 'opus-架构', model: 'm', roleTag: '安全' }] }
    expect(rosterEquals(a, b)).toBe(false)
  })

  it('完全一样 → 相等(否则每次恢复都白写一遍 node.md)', () => {
    const a = { ...emptyPhaseRoles(), review: [{ roleName: 'opus-架构', model: 'm', roleTag: '架构师' }] }
    const b = { ...emptyPhaseRoles(), review: [{ roleName: 'opus-架构', model: 'm', roleTag: '架构师' }] }
    expect(rosterEquals(a, b)).toBe(true)
  })
})

describe('关口编辑器与角色席位', () => {
  const R = (over: Partial<Record<PhaseName, RoleBinding[]>>) => ({ ...emptyPhaseRoles(), ...over })

  it('勾掉一个员工不会连带删掉它的角色席位', () => {
    // 实测过按 roleName 匹配的后果:同一个员工兼两角时,一次按键把**两席**一起删掉;
    // 再按一次只回来一席,而且没有 roleTag —— 职责简报永久丢失,用户还以为自己撤销了。
    const before = R({ review: [
      { roleName: 'ds-安全', roleTag: '架构师' },
      { roleName: 'ds-安全', roleTag: '安全' },
      { roleName: 'ds-安全' },
    ] })
    const after = toggleRole(before, 'review', 'ds-安全')
    expect(after.review).toEqual([
      { roleName: 'ds-安全', roleTag: '架构师' },
      { roleName: 'ds-安全', roleTag: '安全' },
    ])
  })

  it('角色席位不参与打勾判定 —— 否则用户以为按一下就能取消', () => {
    const roster = R({ review: [{ roleName: 'opus-架构', roleTag: '架构师' }] })
    // 没有自由席位 → 这次按键是「加一席」,不是「取消」。
    const after = toggleRole(roster, 'review', 'opus-架构')
    expect(after.review).toHaveLength(2)
    expect(after.review.filter(r => r.roleTag)).toHaveLength(1)
  })

  it('单席位阶段已被角色定义占满 → 编辑器改不动,名册原样返回', () => {
    // 硬加一席只会让名册多一个永远不跑的名字(pipeline 取第 [0] 席)。
    const roster = R({ execute: [{ roleName: 'opus-架构', roleTag: '写手' }] })
    expect(toggleRole(roster, 'execute', 'ds-安全')).toBe(roster)
  })

  it('没有角色席位时单席位阶段照旧是替换', () => {
    const roster = R({ execute: [{ roleName: 'opus-架构' }] })
    expect(toggleRole(roster, 'execute', 'ds-安全').execute).toEqual([{ roleName: 'ds-安全' }])
  })

  it('编辑器行把角色定义排的席位显示出来', () => {
    // 此前它们对这一行完全不可见:主模型兼任的席位 roleName 是空串,bound 成了 Set{''},
    // size !== 0 让「(主模型)」也不显示 —— 只读名册说「验收: 验收官←主模型」,同一个
    // 关口的编辑器行却说什么都没选。
    const line = rosterEditorLines(
      R({ accept: [{ roleName: '', roleTag: '验收官' }] }), ['opus-架构', 'ds-安全'], 0, 0,
    ).find(l => l.includes('验收'))!
    expect(line).toContain('验收官')
    expect(line).toContain('主模型')
  })

  it('角色席位不打勾,自由席位才打勾', () => {
    const lines = rosterEditorLines(
      R({ review: [{ roleName: 'opus-架构', roleTag: '架构师' }, { roleName: 'ds-安全' }] }),
      ['opus-架构', 'ds-安全'], 1, 0,
    )
    const line = lines.find(l => l.includes('质疑讨论'))!
    expect(line).toContain('[ ]opus-架构')
    expect(line).toContain('[x]ds-安全')
    expect(line).toContain('架构师')
  })

  it('有角色席位时不说「(主模型)」', () => {
    const line = rosterEditorLines(
      R({ plan: [{ roleName: '', roleTag: '主设计' }] }), ['opus-架构'], 3, 0,
    ).find(l => l.includes('分析'))!
    expect(line).not.toContain('(主模型):')
    expect(line).toContain('主设计')
  })
})

describe('关口要说出多对多的代价', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], ...over,
  })

  it('席位变多,预估调用数跟着变多', () => {
    // 多对多把调用数**乘**起来,而关口此前只字未提 —— 用户批准的是一份自己看不出代价
    // 的配置。
    const one = costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'a' }] } }))
    const three = costLine(mk({ phaseRoles: { ...emptyPhaseRoles(),
      review: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] } }))
    const n = (s: string) => Number(s.match(/预估上限 (\d+) 次/)![1])
    expect(n(three)).toBeGreaterThan(n(one))
  })

  it('**不**把它说成并发 —— 并发上限是 parallelism,和这个数无关', () => {
    // 把排队总量说成在飞数,用户会以为自己要同时开几十个连接,从而去调一个不解决问题
    // 的旋钮。
    const line = costLine(mk({ parallelism: 5 }))
    expect(line).toContain('次模型调用')
    expect(line).toContain('并发上限仍是 5')
    expect(line).not.toMatch(/预估上限 \d+ 个?并发/)
  })

  it('空名册也给得出一个数(每阶段至少主模型一次)', () => {
    expect(costLine(mk())).toMatch(/预估上限 \d+ 次模型调用/)
  })

  it('不是全票时安全阀行必须说出来', () => {
    // 这条直接改变「什么算通过」,藏起来就是关口在撒谎。
    // 「圆桌 60% 通过」读法太多,文案必须点明是「席位赞成」。
    expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, quorum: 60 } }))).toContain('需 60% 席位赞成')
  })

  it('全票是默认,不啰嗦', () => {
    expect(capsLine(mk())).not.toContain('席位赞成')
    expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, quorum: 100 } }))).not.toContain('席位赞成')
  })
})

describe('成本预估必须对得上真实调用数', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], ...over,
  })
  const n = (s: string) => Number(s.match(/每节点最多 (\d+) 次/)![1])

  it('算上圆桌自己的 infra 重试层 —— 那是 maxIterations 的平方,不是一次方', () => {
    // 漏掉它会低估约 2.5 倍:实测 1 评审席 + 2 验收席、迭代 3 时真实 23 次而旧公式
    // 承诺 15 次。低估比高估糟 —— 用户按一个偏小的数批准。
    // 精确值,不用比值:比值断言会被**另一个**阶段的平方项满足 —— 实测把方案阶段的
    // 平方拆掉,验收阶段的平方仍让比值达标,测试照旧全绿。
    // 默认 It=3,方案/评审/验收各 1 席,观察 0 席:
    //   方案阶段 = 3 × (1 + 3×1) = 12;执行阶段 = 3 × (1 + 3×1 + 0) = 12;合计 24。
    // 任一处平方被拆成一次方都会掉到 18。
    expect(n(costLine(mk()))).toBe(24)
    const it2 = n(costLine(mk({ caps: { ...DEFAULT_CAPS, maxIterations: 2 } })))
    const it4 = n(costLine(mk({ caps: { ...DEFAULT_CAPS, maxIterations: 4 } })))
    expect(it4 / it2).toBeGreaterThan(2.5)
  })

  it('算上方案席位 —— 顺序精化每一席都是一次串行调用', () => {
    // 写死 1 的话,配 4 个方案员工在关口上是免费的,而那正是精化要用户知道的代价。
    const one = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), plan: [{ roleName: 'a' }] } })))
    const four = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(),
      plan: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }, { roleName: 'd' }] } })))
    expect(four).toBeGreaterThan(one)
  })

  it('算上观察席 —— 每次验收通过都打一次分,返工可让验收通过多次', () => {
    const without = n(costLine(mk()))
    const with1 = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), observer: [{ roleName: 'o' }] } })))
    expect(with1 - without).toBe(DEFAULT_CAPS.maxIterations)
  })

  it('措辞是上界,并说明实际通常远低于此', () => {
    // maxNodes 默认 100 是硬上限而非预期值,一个只想翻译 README 的用户会看到一个
    // 高出两个数量级的数。不说清口径,用户就学会永远忽略这一行。
    const line = costLine(mk())
    expect(line).toContain('预估上限')
    expect(line).toContain('实际通常远低于此')
  })
})

describe('两条夹取路径与 NaN', () => {
  it('席位上限是 NaN 时退回默认值,不是静默放行', () => {
    // NaN 会让 `seats.length > cap` 恒为假 —— 12 席全部放行且没有任何 notice。
    const defs = [{ name: 'r', stage: 'review', output: 'o', purpose: 'p',
      staff: Array.from({ length: 12 }, (_, i) => `s${i}`) }]
    const { phaseRoles, notices } = applyRoleDefsToPhases(
      emptyPhaseRoles() as never, defs as never, Number.NaN)
    expect(phaseRoles.review).toHaveLength(5)
    expect(notices.join('\n')).toContain('席位上限')
  })

  it('关口编辑器的上限是 NaN 时同样退回默认值', () => {
    let roster: Record<PhaseName, RoleBinding[]> = emptyPhaseRoles()
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      roster = toggleRole(roster, 'review', name, undefined, Number.NaN)
    }
    expect(roster.review).toHaveLength(5)
  })
})

describe('新环节的成本必须计入,而默认配置的数字不能动', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], ...over,
  })
  const n = (s: string) => Number(s.match(/每节点最多 (\d+) 次/)![1])

  it('默认配置仍然是 24 —— 两个新环节都是 opt-in', () => {
    // 照抄 accept 的 Math.max(1, seats) 写法会让这个数凭空涨一截,而实际一次调用都不会
    // 发生。关口高估同样是撒谎,只是方向相反:用户会去调一个根本不需要调的旋钮。
    expect(n(costLine(mk()))).toBe(24)
  })

  it('配了测试验证 → 数字涨,而且带 infra 重试层(平方项)', () => {
    const one = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'v' }] } })))
    const two = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'v' }, { roleName: 'w' }] } })))
    expect(one).toBeGreaterThan(24)
    // It=3:一席 +9,两席 +18。一次方的话是 +3/+6。
    expect(one - 24).toBe(9)
    expect(two - one).toBe(9)
  })

  it('配了集成验收 → 数字涨', () => {
    const withInt = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), integrate: [{ roleName: 'i' }] } })))
    expect(withInt - 24).toBe(9)
  })

  it('两个都配 → 两份都算上', () => {
    const both = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(),
      verify: [{ roleName: 'v' }], integrate: [{ roleName: 'i' }] } })))
    expect(both).toBe(24 + 9 + 9)
  })
})

describe('关口不能对没配角色的环节撒谎', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], mainModel: 'm', ...over,
  })
  const row = (c: EffTaskConfig, label: string) => rosterLines(c).find(l => l.startsWith(label))!

  it('测试验证 0 席 → 说这一步不发生,不说「主模型」', () => {
    // 它是 opt-in:0 席 = 一次调用都不会有。说「主模型」就是承诺一件不会发生的事。
    const line = row(mk(), '测试验证')
    expect(line).not.toContain('主模型')
    expect(line).toContain('不做验证')
  })

  it('集成验收 0 席 → 说它回落到验收席位,不说「主模型」', () => {
    // 0 席时用的是验收的人。说「主模型」会让用户以为是另一批人在跑。
    const line = row(mk({ phaseRoles: { ...emptyPhaseRoles(), accept: [{ roleName: 'qa' }] } }), '集成验收')
    expect(line).not.toMatch(/主模型\(/)
    expect(line).toContain('验收席位')
  })

  it('观察 0 席仍然说不评分', () => {
    expect(row(mk(), '观察')).toContain('不评分')
  })

  it('配了席位就照常显示那些人', () => {
    const line = row(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'tester', model: 'm2' }] } }), '测试验证')
    expect(line).toContain('tester')
    expect(line).not.toContain('不做验证')
  })

  it('其余环节 0 席照旧回落主模型 —— 那三条特判不能扩大化', () => {
    for (const label of ['分析', '质疑讨论', '执行', '验收']) {
      expect(`${label}:${row(mk(), label).includes('主模型')}`).toBe(`${label}:true`)
    }
  })
})

describe('关口:跳过要说出后果,组合要拦住', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], mainModel: 'm', ...over,
  })
  const row = (c: EffTaskConfig, label: string) => rosterLines(c).find(l => l.startsWith(label))!

  it('每个被跳过的环节都写出后果,不是只写「已跳过」', () => {
    for (const [ph, label, must] of [
      ['plan', '分析', '不主动拆子任务'], ['review', '质疑讨论', '不会在这里被拦下'],
      ['execute', '执行', '不会产生任何提交'], ['verify', '测试验证', '读执行者的自述'],
      ['accept', '验收', '未经判断就合进集成分支'], ['integrate', '集成验收', '拆漏了'],
      ['observer', '观察', '不打分'],
    ] as const) {
      const line = row(mk({ skipSteps: [ph] as never }), label)
      expect(`${ph}:${line.includes('已跳过')}`).toBe(`${ph}:true`)
      expect(`${ph}:${line.includes(must)}`).toBe(`${ph}:true`)
    }
  })

  it('跳过的环节不再显示「主模型」—— 那是承诺一件不会发生的事', () => {
    expect(row(mk({ skipSteps: ['accept'] as never }), '验收')).not.toContain('主模型(')
  })

  it('没跳过时名册照旧', () => {
    expect(row(mk(), '验收')).toContain('主模型')
  })

  it('跳过执行不跳验收 → 拦住,并说清验收会去核对一个空产出', () => {
    // 断**整句**,不断片段。断片段时把这句话改成意思完全相反的
    // 「这个组合完全没问题…验收根本跑不到也不影响结果,无需处理」照样绿 —— 实测过。
    // 这条警告的全部价值就在它的祈使部分,而祈使部分正是被片段断言漏掉的那半句。
    const lines = skipConflictLines(mk({ skipSteps: ['execute'] as never }))
    expect(lines).toContain("跳过了执行但没跳验收:本次不会有任何代码改动,验收席位仍会照常开会,去核对一个空产出。判通过 = 给一个什么都没做的节点盖章并合进集成分支;判不通过 = 烧完验收迭代后阻断。要么一并跳过验收,要么别跳执行。")
    // 上一版这里写的是「验收根本跑不到」—— 一句假话:跳过执行是在空产出闸门**之前**
    // 整块早退的,闸门不触发,验收照跑。实测一次调用就把空节点判成了 ACCEPTED。
    expect(lines.join('\n')).not.toContain('验收根本跑不到')
  })

  it('跳过分析不跳质疑讨论 → 拦住', () => {
    expect(skipConflictLines(mk({ skipSteps: ['plan'] as never })).join('\n')).toContain('评一份空方案')
  })

  it('七个全跳 → 说清是空跑', () => {
    const all = ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer']
    expect(skipConflictLines(mk({ skipSteps: all as never })).join('\n')).toContain('不会有任何模型调用')
  })

  it('**没全跳时绝不能说全跳** —— 只有正向断言时阈值可以从 7 改成 1 而无人发现', () => {
    // 实测:把 `skip.size >= PHASE_NAMES.length` 改成 `>= 1`,141 条全绿。用户只跳一个
    // 验收,关口就红字弹「七个环节全部跳过:本次不会有任何模型调用」—— 一句彻头彻尾的
    // 假话,还是在**要求他批准**的界面上。1..6 这段中间地带原先一条断言都没有。
    const all = ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer']
    for (let n = 0; n < all.length; n++) {
      const t = skipConflictLines(mk({ skipSteps: all.slice(0, n) as never })).join('\n')
      expect(`跳 ${n} 个时误报全跳: ${t.includes('全部跳过')}`).toBe(`跳 ${n} 个时误报全跳: false`)
    }
  })

  it('连带后果和「跑不完」是两个块 —— 标题必须配得上内容', () => {
    // 「跳过分析 = 不主动拆子任务」是**跑得完**的连带后果,挂在「会让任务跑不完」标题
    // 下面就是标题说 A 内容说 B —— 和把隔离降级塞进「不会生效」块是同一个错。
    const conflict = skipConflictLines(mk({ skipSteps: ['plan', 'review'] as never })).join('\n')
    const conseq = skipConsequenceLines(mk({ skipSteps: ['plan', 'review'] as never })).join('\n')
    expect(conflict).not.toContain('任务树基本只有根节点')
    expect(conseq).toContain('任务树基本只有根节点')
    // 跳过集成验收会连带关掉所有拆分型节点的评分,这条以前一个字都没说。
    expect(skipConsequenceLines(mk({ skipSteps: ['integrate'] as never })).join('\n')).toContain('不再评分')
    expect(skipConsequenceLines(mk({ skipSteps: [] as never }))).toEqual([])
  })

  it('两个都跳时不再报那条组合警告', () => {
    expect(skipConflictLines(mk({ skipSteps: ['execute', 'accept'] as never }))).not.toContain("跳过了执行但没跳验收:本次不会有任何代码改动,验收席位仍会照常开会,去核对一个空产出。判通过 = 给一个什么都没做的节点盖章并合进集成分支;判不通过 = 烧完验收迭代后阻断。要么一并跳过验收,要么别跳执行。")
  })

  it('什么都不跳 → 没有警告', () => {
    expect(skipConflictLines(mk())).toEqual([])
  })

  it('跳过观察时,安全阀行不再承诺一个不会发生的返工', () => {
    const line = capsLine(mk({ skipSteps: ['observer'] as never, caps: { ...DEFAULT_CAPS, scoreThreshold: 60 } }))
    expect(line).not.toContain('触发一轮返工')
    expect(line).toContain('观察已跳过')
  })

  it('成本:被跳过的环节归零', () => {
    const n = (c: EffTaskConfig) => Number(costLine(c).match(/每节点最多 (\d+) 次/)![1])
    expect(n(mk())).toBe(24)
    expect(n(mk({ skipSteps: ['review'] as never }))).toBeLessThan(24)
    expect(n(mk({ skipSteps: ['execute'] as never }))).toBeLessThan(24)
    // 七个全跳 = 一次调用都没有。
    const all = ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer']
    expect(n(mk({ skipSteps: all as never }))).toBe(0)
  })

  it('成本:圆桌模式在 ≥2 席时多一次融合,单席位不变', () => {
    const n = (c: EffTaskConfig) => Number(costLine(c).match(/每节点最多 (\d+) 次/)![1])
    const three = { ...emptyPhaseRoles(), plan: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] }
    const refine = n(mk({ phaseRoles: three }))
    const table = n(mk({ phaseRoles: three, caps: { ...DEFAULT_CAPS, planConverge: '圆桌' } }))
    expect(table - refine).toBe(DEFAULT_CAPS.maxIterations)
    // 单席位两种模式相同 —— 没有第二份稿可融合。
    expect(n(mk({ caps: { ...DEFAULT_CAPS, planConverge: '圆桌' } }))).toBe(24)
  })
})

describe('编辑器要标出被跳过的环节', () => {
  it('被跳过的那一行说明勾选即恢复', () => {
    // 不标的话那一行的复选框就是「配得进去、永远不生效」:用户勾了人,什么都不会发生。
    const lines = rosterEditorLines(emptyPhaseRoles() as never, ['a'], 0, 0, undefined, ['review'])
    const row = lines.find(l => l.includes('质疑讨论'))!
    expect(row).toContain('已跳过')
    expect(row).toContain('勾选任一员工即恢复')
  })

  it('没跳过的行不加这个标记', () => {
    const lines = rosterEditorLines(emptyPhaseRoles() as never, ['a'], 0, 0, undefined, ['review'])
    expect(lines.find(l => l.includes('分析'))!).not.toContain('已跳过')
  })

  it('不传 skipped 时行为不变', () => {
    const lines = rosterEditorLines(emptyPhaseRoles() as never, ['a'], 0, 0)
    expect(lines.join('\n')).not.toContain('已跳过')
  })
})
