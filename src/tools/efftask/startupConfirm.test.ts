import { describe, expect, it } from 'bun:test'
import { DEFAULT_CAPS, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig } from './types.js'
import { clip, createResolveOnce, goalLine, raceConfirm, rosterLines, type ConfirmSurface, resumeSummarySections , capsLine, parallelismLine, handoffLines, exitReportLine } from './startupConfirm.js'

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
