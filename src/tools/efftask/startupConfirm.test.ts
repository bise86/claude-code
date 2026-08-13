import { describe, expect, it } from 'bun:test'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { clip, createResolveOnce, goalLine, raceConfirm, rosterLines, type ConfirmSurface, resumeSummarySections , capsLine, parallelismLine, handoffLines, undeliveredCommits, relativeTime, applyRosterToNodes, isolationChoice, type IsolationChoice, ISOLATION_DEGRADE_PREFIX, ISOLATION_REASON_PREFIX, ISOLATION_RECORD_PREFIX, reconcileIsolationNotices, splitNotices, isSharedTree, isolationChoiceLines, parallelismIsolation, poolDisposition, rosterEquals, exitReportLine, toggleRole, rosterEditorLines, applyStartupDecision, dispatchableRoles, costLine, COST_RATE_LIMIT_ATTEMPTS, skipConflictLines, skipConsequenceLines, proxyNoticeLines, runSpanLine, contextWindowNoticeLines, gitChoiceLines , type HandoffSummary } from './startupConfirm.js'
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
    expect(lines).toContain('质疑修复: arch、sec(opus)') // the bound model is visible on the gate
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
    // 夹掉了就必须说藏了几席 —— 只留一个「…」等于把「谁在干活」这个问题答了一半。
    // 数目要**准**:role-1 是 role-15 的子串,子串法数出来的会少报。40 席、装下 k 席,
    // 藏起来的就是 40-k,一个不多一个不少。
    const m = /\(另 (\d+) 席未显示\)$/.exec(line)
    expect(`提示: ${m === null ? '没有' : m[1]}`).not.toBe('提示: 没有')
    // 剥掉标签和提示再按「、」切 —— 用「名字两侧是分隔符」的正则数会少报两个:
    // 第一个名字左边是 ': ' 不是 '、',最后一个右边是提示的 '('。
    const shownPart = line.replace(/^验收: /, '').replace(/\(另 \d+ 席未显示\)$/, '')
    const visible = shownPart.split('、').filter(n => /^role-\d+$/.test(n)).length
    expect(`藏起来的: ${m![1]}`).toBe(`藏起来的: ${40 - visible}`)
  })

  it('藏起来的席位数不许用子串法数 —— 短名字是长名字的子串', () => {
    /**
     * 上一条用 role-0…role-39,可见的恰好是 role-0…role-9,而被藏起来的 role-10…role-39
     * 都**不是**可见那段的子串 —— 方向正好反了,于是子串法在那组数据上碰巧也对。
     * 变异实测:把计数改成 `shown.includes(n)` 能在那一条下活下来。
     *
     * 这一组把短名字排在后面(必然被藏),而它们是前面长名字的子串:seat-1 和 seat-10
     * 都出现在 seat-100 里面。子串法会把它们当成「显示出来了」,于是**少报**藏了几席 ——
     * 而这行字存在的全部意义就是把那个数说准。
     */
    const roleNames = [
      ...Array.from({ length: 30 }, (_, i) => `seat-${100 + i}`),
      'seat-1',
      'seat-10',
    ]
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 5, caps: { ...DEFAULT_CAPS },
      phaseRoles: { ...emptyPhaseRoles(), accept: roleNames.map(roleName => ({ roleName })) },
    }
    const line = rosterLines(cfg).find(l => l.startsWith('验收: '))!
    const m = /\(另 (\d+) 席未显示\)$/.exec(line)
    expect(`提示: ${m === null ? '没有' : m[1]}`).not.toBe('提示: 没有')
    const shownPart = line.replace(/^验收: /, '').replace(/\(另 \d+ 席未显示\)$/, '')
    const visible = shownPart.split('、').filter(n => /^seat-\d+$/.test(n)).length
    expect(`藏起来的: ${m![1]}`).toBe(`藏起来的: ${roleNames.length - visible}`)
    // 前提:这组数据真的能触发子串误判,否则这条用例只是重复上一条。
    expect(shownPart.includes('seat-1') && !shownPart.split('、').includes('seat-1')).toBe(true)
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
    expect(line).toContain('方案/质疑修复阶段并行')
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

  /**
   * `commits === 0` 有两种**完全相反**的成因,而主干开发把第二种变成了正常结局:
   * 每个子任务完成时就合回当前分支了,收口时当然没有待合的提交。对着 20 次真实合并
   * 印「本次没有产生任何改动」是一句用户会照着做决定的假话。
   */
  it('commits === 0 但逐任务合过 → 说的是「已逐一合并回你当前的分支」,不是「什么都没发生」', () => {
    const text = handoffLines({ branch: 'b', commits: 0, kept: [], salvage: [], trunkLanded: 20 }).join('\n')
    expect(text).toContain('20 个提交')
    expect(text).toContain('产出就在当前目录里')
    expect(text).not.toContain('没有产生任何改动')
    // 还能查:这一趟的提交都在集成分支上。
    expect(text).toContain('git log b')
  })

  it('有东西没送到用户目录时,原因要印出来 —— 否则他的目录和产出对不上而他不知道', () => {
    const text = handoffLines({
      branch: 'b', commits: 2, kept: [], salvage: [], trunkLanded: 1,
      trunkSkips: ['你的工作区有未提交的改动(已跟踪文件),没有把产出合回你的目录 —— 你的改动不该被一次合并卷进来'],
    }).join('\n')
    expect(text).toContain('⚠')
    expect(text).toContain('未提交的改动')
    /**
     * 而**第一句**也要跟着改口:「你的工作区未被改动」在中途合成功过的运行上逐字为假 ——
     * 那 1 个提交早就在他的目录里了。三处渲染器(这里、收口关口、飞书收口卡)都印过这句话。
     */
    expect(text).not.toContain('你的工作区未被改动')
    expect(text).toContain('还有 2 个提交没合进来')
    expect(text).toContain('1 个提交已在跑的过程中合进了你当前的分支')
  })

  it('一次都没合过 → 那句「你的工作区未被改动」原样保留(它这时候是真的)', () => {
    const text = handoffLines({ branch: 'b', commits: 2, kept: [], salvage: [] }).join('\n')
    expect(text).toContain('你的工作区未被改动')
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

  it('已经自动合并回当前分支之后,那两句话必须改口', () => {
    /**
     * 跑完会自动把集成分支合回当前分支(见 finishHandoff)。这一屏原来的两句话在那之后
     * 都是**可照做的假话**:
     *  - 「你的工作区未被改动」—— 它刚刚被改动了,而那正是用户要的那件事;
     *  - 「稍后收口: /et --resume … 会重新弹出四选一」—— 合并成功后 pendingHandoff 已经
     *    从 run.md 上清掉了,那条命令进来什么都不会弹。
     * 而「合并: git merge …」同样不该再印:再跑一次只会得到 Already up to date.,
     * 一条什么都不做的命令摆在那里会让人以为合并还没发生。
     */
    const text = handoffLines(
      { branch: 'efftask/001/integration', commits: 7, kept: [], salvage: [] }, '001', 'merged',
    ).join('\n')
    expect(text).toContain('已合并回你当前的分支')
    expect(text).toContain('产出就在当前目录里')
    expect(text).not.toContain('你的工作区未被改动')
    expect(text).not.toContain('会重新弹出')
    expect(text).not.toContain('合并: git merge')
    // 分支保留这件事仍然要说 —— 它是回滚的唯一凭据,而「丢弃」的两条命令照旧给。
    expect(text).toContain('git log efftask/001/integration')
    expect(text).toContain('git branch -D efftask/001/integration')
  })

  it('没合并时(默认)那两句一个字都不变', () => {
    const text = handoffLines(
      { branch: 'efftask/001/integration', commits: 7, kept: [], salvage: [] }, '001',
    ).join('\n')
    expect(text).toContain('你的工作区未被改动')
    expect(text).toContain('稍后收口: /et --resume 001')
    expect(text).toContain('合并: git merge efftask/001/integration')
  })
})

describe('退出报告里的收口那几行', () => {
  /**
   * 这行字进的是**对话记录**,比 done 视图活得久 —— 面板关掉之后用户能回看的只剩它。
   * 变异测试实测存活:`exitReportLine` 不把 `handoffState` 往下传,全套照绿 ——
   * 于是自动合并成功之后,记录里仍然写着「你的工作区未被改动」和
   * 「稍后收口: /et --resume … 会重新弹出四选一」,而两句都已经不成立。
   */
  const h = { branch: 'efftask/009/integration', commits: 4, kept: [], salvage: [] }
  const line = (state?: 'merged' | 'conflicted'): string =>
    exitReportLine({ runId: '009', how: '完成', resumed: false, withPath: true, handoff: h, handoffState: state })

  it('合成功 → 说产出在当前分支,不再说「工作区未被改动」', () => {
    const t = line('merged')
    expect(t).toContain('已合并回你当前的分支')
    expect(t).not.toContain('你的工作区未被改动')
    expect(t).not.toContain('会重新弹出')
  })

  it('没传结局(默认)→ 和这个功能不存在时逐字相同', () => {
    const t = line()
    expect(t).toContain('你的工作区未被改动')
    expect(t).toContain('稍后收口: /et --resume 009')
  })

  it('撞冲突 → 记录里也要说清工作区里留着一次未完成的合并', () => {
    expect(line('conflicted')).toContain('未完成的合并')
  })
})

describe('静默超时要在关口上说出来', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], mainModel: 'm', ...over,
  })

  it('调过就印出来 —— 它是唯一会中止一次正在正常干活的调用的那个阀', () => {
    // 此前这一行一个字都没提它:「一次调用最多可以多久没动静」只能在被咬之后从阻断
    // 理由里知道,而阻断卡点名让用户去调的正是它。
    const line = capsLine(mk({ caps: { ...DEFAULT_CAPS, nodeTimeoutMs: 1_200_000 } }))
    expect(line).toContain('静默超时 20 分钟')
  })

  it('默认值不印 —— 这一行本来就在跟宽度打架', () => {
    expect(capsLine(mk())).not.toContain('静默超时')
  })

  it('**调小**也要印 —— 判据是「不等于默认」,不是「大于默认」', () => {
    /**
     * 写成 `<= 默认` 就不印,而调小恰恰是最危险的方向:抽取最可能犯的错是刻度
     * (「20 分钟」被写成 20 而不是 1200000),夹取**静默**把它抬成 1000ms —— 每次调用
     * 一秒内必死,而关口一个字都不说。这一行的全部意义就是拦这件事。
     */
    const line = capsLine(mk({ caps: { ...DEFAULT_CAPS, nodeTimeoutMs: 60_000 } }))
    expect(line).toContain('静默超时 1 分钟')
  })

  it('不足一分钟印秒 —— 「0 分钟」读起来是「没有超时」', () => {
    // 1000 是两处夹取的**下限**(不是被拒的值),所以 1s–59s 是合法可达区间。
    for (const [ms, want] of [[1000, '静默超时 1 秒'], [5000, '静默超时 5 秒'], [29_999, '静默超时 30 秒']] as const) {
      expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, nodeTimeoutMs: ms } }))).toContain(want)
    }
    expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, nodeTimeoutMs: 1000 } }))).not.toContain('0 分钟')
  })

  it('分钟按四舍五入,不是截断 —— 90 秒是「2 分钟」而不是「1 分钟」', () => {
    // 截断会让 119 秒印成「1 分钟」,而用户配的是接近两分钟。
    expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, nodeTimeoutMs: 90_000 } }))).toContain('静默超时 2 分钟')
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

  /**
   * 用户原话:「worktree 的代码合并到主干,才算任务完成吧。」
   *
   * 这行字进对话记录、比面板活得久 —— 一句光秃秃的「高效任务 007 完成」会让人以为代码
   * 已经在手上了(底下 handoffLines 说的是反话,但结论在第一行)。
   */
  it('产出还没到你的分支时,「完成」要被限定', () => {
    const l = exitReportLine({ runId: '007', how: '完成', resumed: false, withPath: true, handoff: h, completed: true })
    expect(l).toContain('完成(产出还没到你的分支:3 个提交待收口)')
  })

  it('合成功之后不加那个尾巴', () => {
    const l = exitReportLine({
      runId: '007', how: '完成', resumed: false, withPath: true, handoff: h,
      handoffState: 'merged', completed: true,
    })
    expect(l).not.toContain('还没到你的分支')
    expect(l).toContain('高效任务 007 完成')
  })

  it('被阻断 / 已取消不叠这句 —— 那一行本来就没在声称成功', () => {
    const l = exitReportLine({
      runId: '007', how: '被阻断(连续返工超限)', resumed: false, withPath: true, handoff: h, completed: false,
    })
    expect(l).not.toContain('还没到你的分支')
  })

  it('不传 completed 时逐字回到这个功能之前的样子', () => {
    const l = exitReportLine({ runId: '007', how: '完成', resumed: false, withPath: true, handoff: h })
    expect(l).not.toContain('还没到你的分支')
  })
})

/**
 * 「投递了没有」的唯一判据。done 视图的结论行、退出报告都读它 —— 两处各判一次的话,
 * 同一个 run 在面板上和对话记录里会有两个结局。
 */
describe('undeliveredCommits', () => {
  const h = (commits: number) => ({ branch: 'b', commits, kept: [], salvage: [] })

  it('合成功 = 都到了,不管合并**之前**量到的是多少', () => {
    // `commits` 是 handoff() 在 finishHandoff 之前量的(HEAD..集成分支),合完它就不成立了。
    expect(undeliveredCommits(h(7), 'merged')).toBe(0)
  })

  it('没合 / 撞冲突 = 还有那么多没到', () => {
    expect(undeliveredCommits(h(7))).toBe(7)
    expect(undeliveredCommits(h(7), 'conflicted')).toBe(7)
  })

  it('没有产出、或者根本没有隔离运行 = 0', () => {
    expect(undeliveredCommits(h(0))).toBe(0)
    expect(undeliveredCommits(null)).toBe(0)
    expect(undeliveredCommits(undefined)).toBe(0)
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
    expect(row('质疑修复')).not.toContain('(单选)') // 圆桌
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
    expect(text).toContain('方案/质疑修复') // 而这些阶段仍然并行 —— 别把降级说得比实际严重
  })

  it('能初始化 git 时才提 g 键', () => {
    const t = isolationChoiceLines('r', true).join('\n')
    expect(t).toContain('按 g')
    // 并且说清 g 会做什么:它会建一个空提交,而那是隔离能跑起来的前提 —— 实测全新仓库
    // `git rev-parse HEAD` 直接 fatal,worktreePool.init 第一行就挂。
    expect(t).toContain('空提交')
  })

  it('「是仓库但没提交」要说人话 —— 别叫一个已经在仓库里的人去初始化仓库', () => {
    // 用户实测:「本身就是一个 git 目录仓库,但还是没有并行起来」。这一种以前是死胡同:
    // notARepo 是 false,于是 g 键根本不出现,而修法和 g 做的事一模一样(补个空提交)。
    const t = isolationChoiceLines('这个 git 仓库还没有任何提交,建不出集成分支', true).join('\n')
    expect(t).toContain('按 g')
    expect(t).toContain('空提交')
    expect(t).toContain('仓库已经有了')
    // 对着一个已经在仓库里的人说「初始化 git 仓库」,他会以为工具没认出他的仓库,
    // 从而不敢按 —— 那这个入口等于没有。
    expect(t).not.toContain('初始化 git 仓库')
  })

  it('不是仓库那一种仍然说初始化', () => {
    const t = isolationChoiceLines('当前目录不是 git 仓库', true).join('\n')
    expect(t).toContain('初始化 git 仓库')
    expect(t).not.toContain('仓库已经有了')
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
      .find(l => l.startsWith('质疑修复'))!
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
    const line = rosterLines(cfg({ review: [{ roleName: 'opus-架构', model: 'm' }] })).find(l => l.startsWith('质疑修复'))!
    expect(line).toBe('质疑修复: opus-架构(m)')
  })

  it('同一员工兼两角 → 名册上两席都点名各自的角色', () => {
    const line = rosterLines(cfg({
      review: [
        { roleName: 'ds-安全', model: 'm', roleTag: '架构师' },
        { roleName: 'ds-安全', model: 'm', roleTag: '安全' },
      ],
    })).find(l => l.startsWith('质疑修复'))!
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
    const line = lines.find(l => l.includes('质疑修复'))!
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

  it('自动解冲突改过默认值就要印出来,0 印的是后果而不是那个数', () => {
    // 「自动解冲突 0 次」读起来像笔误;它真正的含义是「一撞上冲突就停下来等人」——
    // 那是用户在关口上唯一需要确认的那件事。
    expect(capsLine(mk({ caps: { ...DEFAULT_CAPS, mergeResolveAttempts: 10 } }))).toContain('自动解冲突 10 次/节点')
    const off = capsLine(mk({ caps: { ...DEFAULT_CAPS, mergeResolveAttempts: 0 } }))
    expect(off).toContain('合并冲突不自动解决(直接等人工)')
    expect(off).not.toContain('0 次')
    // 默认值不印 —— 这一行已经在跟宽度打架(和静默超时同一条规矩)。
    expect(capsLine(mk())).not.toContain('自动解冲突')
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
    // 默认 It=3,方案/质疑修复/验收各 1 席,观察 0 席,单点调用的限流重试 T=3:
    //   方案阶段 = 3 × (1×T + 3×1) = 18;执行阶段 = 3 × (1 + 3×1 + 0) = 12;合计 30。
    // 任一处平方被拆成一次方都会掉下来;T 漏掉会掉到 24。
    expect(n(costLine(mk()))).toBe(30)
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

  it('默认配置是 30 —— 两个新环节都是 opt-in,而单点调用带限流重试', () => {
    // 照抄 accept 的 Math.max(1, seats) 写法会让这个数凭空涨一截,而实际一次调用都不会
    // 发生。关口高估同样是撒谎,只是方向相反:用户会去调一个根本不需要调的旋钮。
    //
    // 24 → 30 是 `runPhase` 的限流重试(T=3,只作用在分析席位和融合席上)。它是**上限
    // 口径**:不限流时一次都不会多跑。低估比高估糟 —— 用户按一个偏小的数批准,而这个
    // 数字在关口上就是他批的那个。
    expect(n(costLine(mk()))).toBe(30)
  })

  it('配了测试修复 → 数字涨,而且带 infra 重试层(平方项)', () => {
    const one = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'v' }] } })))
    const two = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'v' }, { roleName: 'w' }] } })))
    expect(one).toBeGreaterThan(30)
    // It=3:一席 +9,两席 +18。一次方的话是 +3/+6。
    expect(one - 30).toBe(9)
    expect(two - one).toBe(9)
  })

  it('配了集成验收 → 数字涨', () => {
    const withInt = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(), integrate: [{ roleName: 'i' }] } })))
    expect(withInt - 30).toBe(9)
  })

  it('两个都配 → 两份都算上', () => {
    const both = n(costLine(mk({ phaseRoles: { ...emptyPhaseRoles(),
      verify: [{ roleName: 'v' }], integrate: [{ roleName: 'i' }] } })))
    expect(both).toBe(30 + 9 + 9)
  })
})

describe('关口不能对没配角色的环节撒谎', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], mainModel: 'm', ...over,
  })
  const row = (c: EffTaskConfig, label: string) => rosterLines(c).find(l => l.startsWith(label))!

  it('测试修复 0 席 → 说这一步不发生,不说「主模型」', () => {
    // 它是 opt-in:0 席 = 一次调用都不会有。说「主模型」就是承诺一件不会发生的事。
    const line = row(mk(), '测试修复')
    expect(line).not.toContain('主模型')
    expect(line).toContain('不跑测试也不修')
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
    const line = row(mk({ phaseRoles: { ...emptyPhaseRoles(), verify: [{ roleName: 'tester', model: 'm2' }] } }), '测试修复')
    expect(line).toContain('tester')
    expect(line).not.toContain('不做验证')
  })

  it('其余环节 0 席照旧回落主模型 —— 那三条特判不能扩大化', () => {
    for (const label of ['分析', '质疑修复', '执行', '验收']) {
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
      ['plan', '分析', '不主动拆子任务'], ['review', '质疑修复', '不会在这里被拦下'],
      ['execute', '执行', '不会产生任何提交'], ['verify', '测试修复', '读执行者的自述'],
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

  it('跳过分析不跳质疑修复 → 拦住', () => {
    expect(skipConflictLines(mk({ skipSteps: ['plan'] as never })).join('\n')).toContain('拿到一份空方案')
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
    expect(n(mk())).toBe(30)
    expect(n(mk({ skipSteps: ['review'] as never }))).toBeLessThan(30)
    expect(n(mk({ skipSteps: ['execute'] as never }))).toBeLessThan(30)
    // 七个全跳 = 一次调用都没有。
    const all = ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer']
    expect(n(mk({ skipSteps: all as never }))).toBe(0)
  })

  it('成本:圆桌模式在 ≥2 席时多一次融合,单席位不变', () => {
    const n = (c: EffTaskConfig) => Number(costLine(c).match(/每节点最多 (\d+) 次/)![1])
    const three = { ...emptyPhaseRoles(), plan: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] }
    const refine = n(mk({ phaseRoles: three }))
    const table = n(mk({ phaseRoles: three, caps: { ...DEFAULT_CAPS, planConverge: '圆桌' } }))
    // 融合那一席也是单点调用,所以它也带限流重试的 T 倍(It × T = 3 × 3)。
    expect(table - refine).toBe(DEFAULT_CAPS.maxIterations * COST_RATE_LIMIT_ATTEMPTS)
    // 单席位两种模式相同 —— 没有第二份稿可融合。
    expect(n(mk({ caps: { ...DEFAULT_CAPS, planConverge: '圆桌' } }))).toBe(30)
  })
})

describe('编辑器要标出被跳过的环节', () => {
  it('被跳过的那一行说明勾选即恢复', () => {
    // 不标的话那一行的复选框就是「配得进去、永远不生效」:用户勾了人,什么都不会发生。
    const lines = rosterEditorLines(emptyPhaseRoles() as never, ['a'], 0, 0, undefined, ['review'])
    const row = lines.find(l => l.includes('质疑修复'))!
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

describe('分析的收敛方式必须在关口上看得见', () => {
  const mk = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], ...over,
  })
  // 圆桌和精化此前在关口上**逐字相同**,只有成本数字差一点,而没有任何一句话解释那点
  // 差额是什么。用户说了「分析用圆桌」,关口上找不到任何证据说明它生效了。
  const withPlan = (n: number, planConverge?: '圆桌' | '精化') => mk({
    caps: { ...DEFAULT_CAPS, ...(planConverge ? { planConverge } : {}) } as never,
    phaseRoles: { ...emptyPhaseRoles(), plan: Array.from({ length: n }, (_, i) => ({ roleName: `p${i}` })) } as never,
  })

  it('圆桌 + 多席 → 说清是谁在融合、多花一次调用', () => {
    const line = capsLine(withPlan(3, '圆桌'))
    expect(line).toContain('分析用圆桌')
    expect(line).toContain('3 人')
    expect(line).toContain('多 1 次调用')
  })

  it('精化(默认)不说 —— 默认值说出来就是噪音', () => {
    expect(capsLine(withPlan(3, '精化'))).not.toContain('圆桌(')
    expect(capsLine(withPlan(3))).not.toContain('圆桌(')
  })

  it('**只有一席时不说** —— 那时圆桌和精化完全等价,说了就是又一句不实承诺', () => {
    expect(capsLine(withPlan(1, '圆桌'))).not.toContain('分析用圆桌')
    expect(capsLine(withPlan(0, '圆桌'))).not.toContain('分析用圆桌')
  })
})

describe('proxyNoticeLines —— 出网路线', () => {
  it('没配代理时一个字都不说', () => {
    expect(proxyNoticeLines(['http://192.168.1.7:8000/v1'], {})).toEqual([])
  })

  it('有代理时点名代理,并把内网端点和公网端点分开列', () => {
    const lines = proxyNoticeLines(
      ['http://192.168.1.7:8000/v1', 'https://api.openai.com/v1', undefined, 'http://192.168.1.7:9000/v1'],
      { HTTPS_PROXY: 'http://corp-proxy:8080' },
    )
    expect(lines[0]).toContain('corp-proxy:8080')
    // 内网那条要说清是「绕过代理」——「为什么这次能连上了」的答案
    expect(lines.some(l => l.includes('192.168.1.7') && l.includes('绕过代理'))).toBe(true)
    // 公网那条要说清仍走代理 —— 剩下那半个答案
    expect(lines.some(l => l.includes('api.openai.com') && l.includes('仍走代理'))).toBe(true)
    // 同一个主机的两个端口只列一次
    expect(lines.filter(l => l.includes('192.168.1.7')).length).toBe(1)
  })

  it('没有任何 api 员工时只报代理本身 —— 主模型也可能被它挡住', () => {
    expect(proxyNoticeLines([], { HTTP_PROXY: 'http://p:1' })).toEqual(['检测到全局代理 http://p:1'])
  })
})

/**
 * 整趟运行的时间窗口 —— 结束屏那一句。
 *
 * 用户原话:「任务运行和阶段运行,都要有具体的运行时间点,现在只有一个运行了多长时间。」
 * 节点和阶段各自的时刻在详情页里,run 这一级此前一个时间都没有。
 */
describe('runSpanLine', () => {
  const N = (over: Record<string, unknown>) => over as never
  const NOW = Date.parse('2026-07-31T10:00:00.000Z')

  it('都结束了就给起、止、总时长', () => {
    const line = runSpanLine([
      N({ createdAt: '2026-07-31T09:00:00.000Z', finishedAt: '2026-07-31T09:20:00.000Z', status: 'ACCEPTED' }),
      N({ createdAt: '2026-07-31T09:05:00.000Z', finishedAt: '2026-07-31T09:30:00.000Z', status: 'ACCEPTED' }),
    ], NOW)
    expect(line).toContain('起 ')
    expect(line).toContain('止 ')
    expect(line).toContain('共 30m0s')
  })

  it('还有节点没结论时说「进行中」,不拿此刻冒充结束时刻', () => {
    // 拿 now 当终点会让一个卡死的 run 看起来「刚刚才结束」。
    const line = runSpanLine([
      N({ createdAt: '2026-07-31T09:00:00.000Z', finishedAt: '2026-07-31T09:20:00.000Z', status: 'ACCEPTED' }),
      N({ createdAt: '2026-07-31T09:05:00.000Z', status: 'EXECUTING' }),
    ], NOW)
    expect(line).toContain('进行中')
    expect(line).not.toContain('止 ')
  })

  it('时间串全是垃圾时整行不画 —— node.md 可以手工编辑', () => {
    expect(runSpanLine([N({ createdAt: '前天', status: 'ACCEPTED' })], NOW)).toBe('')
    expect(runSpanLine([], NOW)).toBe('')
  })

  it('起点取最早的一个 —— 重做会新建节点,只看 root 会算错', () => {
    const line = runSpanLine([
      N({ createdAt: '2026-07-31T09:30:00.000Z', finishedAt: '2026-07-31T09:40:00.000Z', status: 'ACCEPTED' }),
      N({ createdAt: '2026-07-31T09:00:00.000Z', finishedAt: '2026-07-31T09:10:00.000Z', status: 'ACCEPTED' }),
    ], NOW)
    expect(line).toContain('共 40m0s')
  })
})

/**
 * 老 node.md 一个 `finishedAt` 都没有 —— 复验点名这条路没有测试。
 *
 * 触发面是**任何一个老 run 的 --resume / 仅查看**,以及整个 run 被 propagateBlocked
 * 扫成 BLOCKED 的那一路(那条不经过 commit,不写 finishedAt)。退回之前的写法会在
 * 「✓ 高效任务完成」下面第一行印「进行中(至今 744h)」。
 */
describe('runSpanLine 的老数据回落', () => {
  const NOW2 = Date.parse('2026-07-31T10:00:00.000Z')
  const N = (over: Record<string, unknown>) => over as never

  it('全树终态但都没有 finishedAt → 退回最后一次落盘时刻', () => {
    const line = runSpanLine([
      N({ createdAt: '2026-07-29T09:00:00.000Z', updatedAt: '2026-07-29T10:00:00.000Z', status: 'ACCEPTED' }),
      N({ createdAt: '2026-07-29T09:10:00.000Z', updatedAt: '2026-07-29T11:00:00.000Z', status: 'BLOCKED' }),
    ], NOW2)
    expect(line).toContain('止 ')
    expect(line).not.toContain('进行中')
    expect(line).toContain('共 2h0m')
  })

  it('有 finishedAt 时优先用它 —— 落盘时刻只是兜底', () => {
    const line = runSpanLine([
      N({ createdAt: '2026-07-29T09:00:00.000Z', finishedAt: '2026-07-29T09:30:00.000Z', updatedAt: '2026-07-29T23:00:00.000Z', status: 'ACCEPTED' }),
    ], NOW2)
    expect(line).toContain('共 30m0s')
  })
})

describe('contextWindowNoticeLines —— 自动压缩按哪个窗口触发', () => {
  it('全都声明过时一个字都不说 —— 复述用户自己写的数是噪音', () => {
    expect(contextWindowNoticeLines([
      { name: 'a', window: 32_000, assumed: false },
      { name: 'b' },
    ])).toEqual([])
  })

  it('估出来的那些要点名,并且带上估的是多少', () => {
    const lines = contextWindowNoticeLines([{ name: 'K3', window: 128_000, assumed: true }])
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]).toContain('K3')
    expect(lines[0]).toContain('128k')
    // 必须给出可照做的那一句 —— 只说「估的」等于把问题丢回给用户。
    expect(lines.join(' ')).toContain('contextWindow')
  })

  it('同名只列一次', () => {
    const lines = contextWindowNoticeLines([
      { name: 'K3', window: 128_000, assumed: true },
      { name: 'K3', window: 128_000, assumed: true },
    ])
    expect(lines[0]!.split('K3').length - 1).toBe(1)
  })

  it('assumed 但没有窗口值的不算 —— 那种条目说不出任何有用的话', () => {
    expect(contextWindowNoticeLines([{ name: 'x', assumed: true }])).toEqual([])
  })
})

describe('git 两个开关 —— 关口上要说出代价(收口方式已不是开关,只有主干开发)', () => {
  const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
    notices: [], ...over,
  })

  it('默认 = worktree 隔离 + 主干开发 + 不推送', () => {
    const l = gitChoiceLines(cfg()).join('\n')
    expect(l).toContain('worktree 隔离')
    // 收口那一行现在说的是「会发生什么」,不是「你选了什么」—— 而它要说清是**逐任务**合。
    expect(l).toContain('主干开发')
    expect(l).toContain('每个子任务完成时')
    expect(l).not.toContain('(m 切换)')
    expect(l).toContain('自动推送: 关')
  })

  it('共享工作树要写明两条代价:改你的目录、而且串行', () => {
    const l = gitChoiceLines(cfg({ isolation: 'shared' })).join('\n')
    expect(l).toContain('你当前目录')
    expect(l).toContain('串行')
  })

  it('共享工作树下不谈收口方式 —— 那时候压根没有集成分支', () => {
    const l = gitChoiceLines(cfg({ isolation: 'shared' })).join('\n')
    expect(l).not.toContain('收口方式')
    // 推送同理:没有池子就没有任何一次提交,给一个开关是承诺一件不会发生的事。
    expect(l).toContain('不适用')
  })

  it('推送开着时要说清推的是哪一条 —— 只有当前分支这一种', () => {
    expect(gitChoiceLines(cfg({ autoPush: true })).join('\n')).toContain('当前分支')
  })

  /**
   * **隔离不可用时 `w` 键仍然要在** —— 这一条推翻了它的上一版。
   *
   * 上一版断言「不画键位」,理由是「那时候这不是一个选择」。而第三档(共享目录 + 并发)
   * 恰恰在这一格最有用:不是 git 仓库、也不需要 git,而用户要的正是速度。
   * 用户原话:「w 显示选择」「如果显示选择了,是允许的」。
   *
   * 变的只是**选项集合**:worktree 那一档确实用不了,而 shared ⇄ shared-parallel 之间
   * 照样可以切。
   */
  it('隔离不可用时说明「不是你选的」,但 w 键仍然可以在两档共享之间切', () => {
    const l = gitChoiceLines(cfg(), { unavailable: '当前目录不是 git 仓库' }).join('\n')
    expect(l).toContain('不是你选的')
    expect(l).toContain('不是 git 仓库')
    expect(l).toContain('(w 切换)')
  })

  it('隔离不可用、而用户已经显式选了并发 → 不许再说「不是你选的」', () => {
    const l = gitChoiceLines(
      { ...cfg(), isolation: 'shared-parallel' },
      { unavailable: '当前目录不是 git 仓库' },
    ).join('\n')
    expect(l).toContain('你选的')
    expect(l).not.toContain('不是你选的')
  })

  it('editable: false 时不画键位 —— 编辑名册时 w/p 归编辑器', () => {
    expect(gitChoiceLines(cfg(), { editable: false }).join('\n')).not.toContain('切换')
  })
})

describe('applyStartupDecision 对两个开关的「缺省 = 不变」', () => {
  const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
    notices: [], ...over,
  })

  it('决策里带了就按决策来', () => {
    const out = applyStartupDecision(cfg(), {
      parallelism: 3, approved: true, isolation: 'shared', autoPush: true,
    })
    expect(out.isolation).toBe('shared')
    expect(out.autoPush).toBe(true)
  })

  it('决策里没带 → 保留 config 上的值,**不能**读成关掉', () => {
    // 飞书那张卡没有这三个开关,而它能赢下这场竞速 —— 读成默认值等于让一次飞书批准
    // 静默推翻用户刚在终端上按过的选择。
    const out = applyStartupDecision(cfg({ isolation: 'shared', autoPush: true }), {
      parallelism: 3, approved: true,
    })
    expect(out.isolation).toBe('shared')
    expect(out.autoPush).toBe(true)
  })
})

/**
 * **「任务完成即回收构建产物」必须印在关口上,而且印的是「开」那一档。**
 *
 * 这一条故意违反本文件其余各行「只印非默认值」的惯例。惯例的目的是少印噪声,而这一格
 * 不是噪声:它是一次**自动的、不可逆的删除**,默认发生,而用户在关口上唯一需要确认的
 * 就是「我按下回车之后,谁会在什么时候删我盘上的东西」。
 */
describe('完成即回收(caps.wipeOnAccept)', () => {
  const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], isolation: 'worktree', ...over,
  })

  it('默认(开)也要印,而且要同时说出代价', () => {
    const lines = gitChoiceLines(cfg())
    const line = lines.find(l => l.includes('完成即回收'))
    expect(line).toBeDefined()
    expect(line).toContain('开')
    // 收益和代价必须在同一句里 —— 只说腾出空间是拿半句真话换一次按键。
    expect(line).toContain('全量重编')
    expect(line).toContain('.gitignore')
  })

  it('关掉时要说清东西留在哪、谁来处理', () => {
    const line = gitChoiceLines(cfg({ caps: { ...DEFAULT_CAPS, wipeOnAccept: false } }))
      .find(l => l.includes('完成即回收'))
    expect(line).toContain('关')
    expect(line).toContain('c 键')
  })

  /**
   * 共享工作树下**根本没有隔离工作区**,也就没有「它的构建产物」这回事 ——
   * 印出来就是承诺一件不会发生的事(自动推送那一行为同一件事分过支)。
   */
  it('共享工作树下一个字都不印', () => {
    expect(gitChoiceLines(cfg({ isolation: 'shared' })).some(l => l.includes('完成即回收'))).toBe(false)
    expect(gitChoiceLines(cfg(), { unavailable: '不是 git 仓库' }).some(l => l.includes('完成即回收'))).toBe(false)
  })
})

/**
 * **第三档:共享目录 + 并发。**
 *
 * 用户原话:「基于 worktree 的开发模式是否可以关闭,直接在当前目录下,也不要 git,
 * 而且支持并发任务。当任务是按照生成文件来划分的,就可以这种,而且速度很快。」
 * 后续补充:「w 显示选择」——**不做任何情况下的默认值**。
 */
describe('隔离方式第三档', () => {
  const c = (iso: 'worktree' | 'shared' | 'shared-parallel'): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, notices: [], isolation: iso,
  })

  it('选了第三档:说清是并发,而且逐条摆出代价', () => {
    const l = gitChoiceLines(c('shared-parallel')).join('\n')
    expect(l).toContain('并发')
    // 唯一一条没有任何安全网的模式 —— 这句不许省。
    expect(l).toContain('没有任何机制能挡住两个任务改同一个文件')
    expect(l).toContain('按产出文件划分')
    // 这一整轮做的那几个键在这一档下全都不适用,不说的话空清单读起来像「都送到了」。
    expect(l).toContain('m(合并)')
    expect(l).toContain('c(回收工作区)')
  })

  /** 零提交的模式里不许给「自动推送」开关 —— 那是承诺一件不会发生的事。 */
  it('两档共享都不给自动推送开关', () => {
    for (const iso of ['shared', 'shared-parallel'] as const) {
      expect(gitChoiceLines(c(iso)).join('\n')).toContain('自动推送: 不适用')
    }
  })

  /** 「完成即回收」只在有隔离工作区时才有意义。 */
  /**
   * 「完成即回收」是**隔离运行**才有的设置行(它清的是节点的隔离工作区)。
   * 判据要锚到那一行本身,不能只搜四个字 —— 上面那句代价说明里也含着它
   * (「…完成即回收 都不适用」),按四个字断言等于什么都没断言。
   */
  it('第三档不印「完成即回收」那一行设置', () => {
    const l = gitChoiceLines(c('shared-parallel')).join('\n')
    expect(l).not.toContain('完成即回收: 开')
    expect(l).not.toContain('完成即回收: 关')
  })

  it('isolationChoice 认得出三档,isSharedTree 把两档共享归到一起', () => {
    expect(isolationChoice(c('shared-parallel'))).toBe('shared-parallel')
    expect(isSharedTree('shared-parallel')).toBe(true)
    expect(isSharedTree('shared')).toBe(true)
    expect(isSharedTree('worktree')).toBe(false)
  })

  /** 降级说明要把第三档指出来,而且不能再无条件说「强制串行」。 */
  it('隔离不可用那一屏要把「并发」列成一条出路', () => {
    const l = isolationChoiceLines('当前目录不是 git 仓库', false).join('\n')
    expect(l).toContain('按 w 选')
    expect(l).toContain('并发')
    expect(l).toContain('默认继续')
  })
})

/**
 * **降级说明整块要跟着用户的选择换,不是加个「默认」了事。**
 *
 * 实测:按 `w` 选到第三档之后,顶上那行已经改口成「共享目录 + 并发(你选的)」,而这一
 * 整块逐字不动 —— 里面「会被强制串行(一次只有一个节点在改代码)」「不会出现两个执行
 * agent 同时改同一份文件」两句直接是反话,而「按 w 选『共享目录 + 并发』」指的还是他
 * 已经在的那一档。用户从上往下读,最后一眼落在「强制串行」上。
 */
describe('隔离不可用那一块跟着选择走', () => {
  const txt = (chosen?: IsolationChoice): string =>
    isolationChoiceLines('当前目录不是 git 仓库', true, chosen).join('\n')

  it('选了第三档 → 不许再说串行、不许再说「不会同时改同一份文件」', () => {
    const t = txt('shared-parallel')
    expect(t).not.toContain('强制串行')
    expect(t).not.toContain('不会出现两个执行 agent 同时改同一份文件')
    // 说的必须是他选的这一档真正会发生的事。
    expect(t).toContain('执行阶段**同时**在你当前的工作目录里跑')
    expect(t).toContain('后写的直接盖掉先写的')
  })

  it('选了第三档 → 指的出路是「切回串行」,不是他已经在的那一档', () => {
    const t = txt('shared-parallel')
    expect(t).toContain('按 w 切回')
    expect(t).not.toContain('按 w 选「共享目录 + 并发」')
  })

  it('还在默认那一档 → 照旧说串行,并把并发指出来', () => {
    for (const c of [undefined, 'shared' as const]) {
      const t = txt(c)
      expect(t).toContain('强制串行')
      expect(t).toContain('按 w 选「共享目录 + 并发」')
      expect(t).not.toContain('按 w 切回')
    }
  })

  /** 原因和 `g` 那条出路两档都不能丢 —— 它们和选哪一档无关。 */
  it('原因和 g 那条出路两档都在', () => {
    for (const c of ['shared' as const, 'shared-parallel' as const]) {
      const t = txt(c)
      expect(t).toContain('隔离不可用:当前目录不是 git 仓库')
      expect(t).toContain('按 g')
    }
  })
})

/**
 * **`parallelismIsolation`:两个事实必须在这里合流。**
 *
 * 只读「选了什么」→ 没有池子却承诺 worktree 隔离和自动合并;
 * 只读「池子在不在」→ 第三档被印成串行,而那是更糟的方向(用户据此以为有互斥)。
 */
describe('parallelismIsolation 的真值表', () => {
  it('第三档永远是第三档 —— 池子在不在都一样', () => {
    expect(parallelismIsolation('shared-parallel', true)).toBe('shared-parallel')
    expect(parallelismIsolation('shared-parallel', false)).toBe('shared-parallel')
  })

  it('worktree 要和「池子真的在」取交集', () => {
    expect(parallelismIsolation('worktree', true)).toBe('worktree')
    expect(parallelismIsolation('worktree', false)).toBe('none')
  })

  it('串行那一档不受池子影响', () => {
    expect(parallelismIsolation('shared', true)).toBe('none')
    expect(parallelismIsolation('shared', false)).toBe('none')
  })
})

/**
 * **关口之前推的降级说明,关口之后就过期了。**
 *
 * 它是在池子建失败那一刻推进 `notices` 的,措辞是「默认…并串行(关口按 w 可改成并发)」,
 * 而用户随后可能正好按了 w。这条会原样落进 run.md:同一份文件里一句说串行、一个字段写
 * `isolation: shared-parallel`,而真相是后者。
 */
describe('关口之后把降级说明改写成记录', () => {
  const degrade = `${ISOLATION_DEGRADE_PREFIX}当前目录不是 git 仓库`

  it('选了第三档 → 那句「默认…并串行」不许留在 run.md 里', () => {
    const out = reconcileIsolationNotices([degrade], 'shared-parallel') ?? []
    expect(out.join('\n')).not.toContain('并串行')
    expect(out.join('\n')).not.toContain('关口按 w')
    // 原因是事实,是用户唯一能据此动手的东西 —— 必须留着。
    expect(out.join('\n')).toContain('隔离不可用: 当前目录不是 git 仓库')
    expect(out.join('\n')).toContain('多个执行任务同时改你当前的工作目录')
  })

  it('选了串行那一档 → 记的是串行', () => {
    const out = (reconcileIsolationNotices([degrade], 'shared') ?? []).join('\n')
    expect(out).toContain('共享目录 + 串行')
    expect(out).not.toContain('并发')
  })

  /** 池子可用而用户仍然显式选了共享 —— 此前 run.md 上一个字都没有(只有一个 frontmatter 键)。 */
  it('没有降级原因也要留下记录(用户在正常仓库里自己选的那一趟)', () => {
    const out = (reconcileIsolationNotices([], 'shared-parallel') ?? []).join('\n')
    expect(out).toContain('关口显式选的')
  })

  it('默认那一档不记 —— 它就是「什么都没变」', () => {
    expect(reconcileIsolationNotices([], 'worktree')).toEqual([])
    expect(reconcileIsolationNotices(undefined, 'worktree')).toBeUndefined()
    // 但降级原因照旧要留(池子建失败而用户仍选 worktree:这一趟其实没有隔离)。
    expect((reconcileIsolationNotices([degrade], 'worktree') ?? []).join('\n'))
      .toContain('隔离不可用: 当前目录不是 git 仓库')
  })

  it('别人的 notice 一条都不能丢', () => {
    const out = reconcileIsolationNotices(['角色 xxx 未配置', degrade], 'shared') ?? []
    expect(out).toContain('角色 xxx 未配置')
  })

  /** 反复批准(终端改完再从飞书批一次)不许把记录叠成一堆。 */
  it('幂等:再走一次关口不会累积记录', () => {
    const once = reconcileIsolationNotices([degrade], 'shared-parallel') ?? []
    const twice = reconcileIsolationNotices(once, 'shared-parallel') ?? []
    expect(twice).toEqual(once)
  })

  it('改主意了:第二次选串行,第一次那条并发记录要被换掉', () => {
    const once = reconcileIsolationNotices([degrade], 'shared-parallel') ?? []
    const twice = (reconcileIsolationNotices(once, 'shared') ?? []).join('\n')
    expect(twice).toContain('共享目录 + 串行')
    expect(twice).not.toContain('共享目录 + 并发')
  })

  it('applyStartupDecision 真的调了它(两条批准路径都必经这里)', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 3, phaseRoles: emptyPhaseRoles(),
      caps: { ...DEFAULT_CAPS }, notices: [degrade],
    }
    const out = applyStartupDecision(cfg, { approved: true, parallelism: 3, isolation: 'shared-parallel' })
    expect((out.notices ?? []).join('\n')).toContain('关口显式选的')
    expect((out.notices ?? []).join('\n')).not.toContain('关口按 w')
  })

  /** 记录不是「你的请求没生效」—— 渲染侧要能把它分出去。 */
  it('splitNotices 把记录和没生效的请求分开', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
      notices: reconcileIsolationNotices(['角色 xxx 未配置', degrade], 'shared-parallel'),
    }
    const { records, requests } = splitNotices(cfg)
    expect(records).toHaveLength(1)
    expect(records[0]).toContain('共享目录 + 并发')
    expect(requests).toContain('角色 xxx 未配置')
    expect(requests.join('\n')).toContain('隔离不可用')
  })
})

/**
 * **`undefined` 是默认档 worktree,不是「别的档」。**
 *
 * 裸比较 `config.isolation !== 'worktree'` 造成过一次真回归(实测):每一次 `--resume`
 * 和每一次飞书批准都会静默放下池子 —— 那两个决策生产者根本不带这个字段,而
 * `persistence` 的写条件是「不等于默认值才写」,所以普通隔离 run 的 run.md 里压根没有
 * `isolation:` 这一行。屏幕上刚承诺完「各自的 worktree 中隔离、完成时自动合并回当前
 * 分支」,恢复之后执行者直接写用户的检出、不产生提交,而且降级会再次落盘。
 */
describe('poolDisposition', () => {
  const c = (iso?: string): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [],
    ...(iso ? { isolation: iso as never } : {}),
  })

  it('没写 isolation(--resume / 飞书批准送来的那一份)→ 池子留着', () => {
    expect(poolDisposition(c())).toEqual({ keepPool: true, sharedParallel: false })
  })

  it('显式 worktree → 池子留着', () => {
    expect(poolDisposition(c('worktree'))).toEqual({ keepPool: true, sharedParallel: false })
  })

  it('共享串行 → 放下池子,互斥照旧', () => {
    expect(poolDisposition(c('shared'))).toEqual({ keepPool: false, sharedParallel: false })
  })

  /**
   * 第三档必须**同时**满足两条。分开的后果是「池子留着 + 互斥解开」——
   * 那恰好是关口承诺的反面(产出跑去 .efftask-worktrees/,而且开始产生提交)。
   */
  it('第三档 → 放下池子,而且解开互斥', () => {
    expect(poolDisposition(c('shared-parallel'))).toEqual({ keepPool: false, sharedParallel: true })
  })
})

/**
 * 第三档下「什么不适用」要列全 —— 不说的话用户跑完按 `m` 只会看到一屏空清单,
 * 而那读起来像「东西都送到了」。
 */
describe('第三档的不适用清单', () => {
  const t = (): string => gitChoiceLines(
    { goalPrompt: 'g', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [], isolation: 'shared-parallel' },
    { editable: false },
  ).join('\n')

  it('m / c / b 的重新同步 / 收口合并 / 完成即回收 都点了名', () => {
    for (const k of ['m(合并)', 'c(回收工作区)', 'b(回溯)的重新同步', '收口合并', '完成即回收']) {
      expect(t()).toContain(k)
    }
  })

  /** 跑机实测 23 GB 就出在这里,而这一档下 `c` 键整个不存在(deps 建不出来)。 */
  it('系统临时目录里的残留也说清没人回收', () => {
    expect(t()).toContain('系统临时目录')
    expect(t()).toContain('没有 c 键')
  })
})

/**
 * **每 `--resume` 一次就多一条重复原因 —— 实测三趟堆了 3 条。**
 *
 * 改写之后那条原因如果不带可识别前缀,下一趟又会被推一条新的降级说明、再改写一次,
 * 而旧的留在 `rest` 里。后果不只是 run.md 变长:恢复关口用 `key={l}` 渲染这一列,
 * React 当场报 duplicate key,屏幕上同一行印三次。
 */
describe('降级原因不许随 --resume 累积', () => {
  const degrade = `${ISOLATION_DEGRADE_PREFIX}fatal: integration already exists`

  it('连着三趟只留一条原因', () => {
    let out = reconcileIsolationNotices([degrade], 'shared-parallel') ?? []
    for (let i = 0; i < 2; i++) {
      // 下一趟:命令层在关口之前又推了一条(池子照样建不起来)。
      out = reconcileIsolationNotices([...out, degrade], 'shared-parallel') ?? []
    }
    expect(out.filter(n => n.startsWith(ISOLATION_REASON_PREFIX))).toHaveLength(1)
    expect(out.filter(n => n.startsWith(ISOLATION_RECORD_PREFIX))).toHaveLength(1)
    // 渲染侧靠整行做 key,所以整份清单必须没有重复行。
    expect(new Set(out).size).toBe(out.length)
  })

  it('两个不同的原因都留着(它们不是同一件事)', () => {
    const other = `${ISOLATION_DEGRADE_PREFIX}当前目录不是 git 仓库`
    const out = reconcileIsolationNotices([degrade, other], 'shared') ?? []
    expect(out.filter(n => n.startsWith(ISOLATION_REASON_PREFIX))).toHaveLength(2)
  })

  /**
   * 认不出的档**不编一句**。前两个新判据落到 else 是往安全方向倒,这一个落到 else
   * 是说了一句假话(手改 run.md 写出的怪值会被印成「每个执行任务在自己的工作区里跑,
   * 完成时合并回你当前的分支」)。
   */
  it('怪值不编记录', () => {
    const out = reconcileIsolationNotices([degrade], 'bogus' as never) ?? []
    expect(out.filter(n => n.startsWith(ISOLATION_RECORD_PREFIX))).toHaveLength(0)
    expect(out.join('\n')).not.toContain('worktree 隔离')
    // 原因照旧留着 —— 它和档位无关。
    expect(out.join('\n')).toContain(ISOLATION_REASON_PREFIX)
  })
})

/**
 * **「不产生任何提交」不等于「盘上什么都没留下」。**
 *
 * 池子是在关口**打开之前**建的,选了共享之后它只是被放下(不删,下一趟接着用),于是
 * 每跑一趟就留下一条 `efftask/<runId>/integration` 分支和一个常驻的
 * `.efftask-worktrees/integration` 检出 —— 实测同一个仓库连跑两趟后 `git branch -a` 里
 * 两条都在。而回收它们的 `c` / `m` 两个键恰恰因为池子被放下而整个消失。
 */
describe('共享档留在盘上的那两样', () => {
  const t = (iso: string, unavailable?: string): string => gitChoiceLines(
    { goalPrompt: 'g', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [], isolation: iso as never },
    { editable: false, unavailable },
  ).join('\n')

  it('隔离本来可用时,两档共享都要说清它们留着,并给出清理命令', () => {
    for (const iso of ['shared', 'shared-parallel']) {
      expect(t(iso)).toContain('.efftask-worktrees/integration')
      expect(t(iso)).toContain('git worktree remove')
      expect(t(iso)).toContain('git branch -D')
    }
  })

  /** 隔离用不了的那一趟池子根本没建起来 —— 盘上什么都没有,说了就是噪声。 */
  it('隔离用不了时不说', () => {
    expect(t('shared-parallel', '当前目录不是 git 仓库')).not.toContain('git worktree remove')
  })

  it('worktree 档不说 —— 那一档它们本来就是正常工作的一部分', () => {
    expect(t('worktree')).not.toContain('git worktree remove')
  })
})

/**
 * **`git merge <集成分支>` 捞不到 salvage 和保留工作区 —— 屏幕不能把用户指上这条路。**
 *
 * 进 `kept` / `salvage` 的前提就是「不在集成分支里」。而这一屏同时印着「合并: git merge …」
 * 那条建议命令,它只覆盖四类里的一类。跑机实测(run 001)那一屏上是 607 个提交 + 7 条
 * salvage + 3 个保留工作区,而唯一的建议命令对后两类一件都捞不到。
 */
describe('handoffLines 对 salvage / 保留工作区说实话', () => {
  const h = (over: Partial<HandoffSummary> = {}): HandoffSummary => ({
    branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [], ...over,
  }) as HandoffSummary

  it('有 salvage / kept → 明说 git merge 捞不到,并给出两条能照做的路', () => {
    const t = handoffLines(h({ salvage: ['efftask/001/salvage/a'], kept: [{ path: '/wt/x', why: '未回收' }] }), '001').join('\n')
    expect(t).toContain('不在集成分支上')
    expect(t).toContain('捞不到它们')
    expect(t).toContain('按 m')
    // 逐条那条路必须也在 —— 这几行会进对话记录,那时面板已经关了,「按 m」按不到。
    expect(t).toContain('逐条 git merge')
  })

  /** 最危险的一屏:逐任务合并全部落地(commits === 0),那里根本没有「合并:」那行命令可改。 */
  it('commits === 0 时也要说 —— 那一屏没有别的命令可改', () => {
    const t = handoffLines(h({ commits: 0, salvage: ['efftask/001/salvage/a'] }), '001').join('\n')
    expect(t).toContain('捞不到它们')
  })

  it('两类都没有时一个字都不多说', () => {
    expect(handoffLines(h({ commits: 3 }), '001').join('\n')).not.toContain('捞不到它们')
  })
})

/**
 * **「本次没有产生任何改动」只在盘上真的什么都没剩时才成立。**
 *
 * 验收实测:`commits === 0` + 7 条 salvage + 3 个保留工作区那一屏,结论行写着「还有 10 处
 * 产出没送到」,而这一行紧接着说「本次没有产生任何改动」—— 三行互相矛盾,而用户读的是
 * 第一行。
 */
describe('commits === 0 时那一句不许和结论行打架', () => {
  const h = (over: Partial<HandoffSummary> = {}): HandoffSummary => ({
    branch: 'efftask/001/integration', commits: 0, kept: [], salvage: [], ...over,
  }) as HandoffSummary

  it('盘上还剩东西 → 不许说「没有产生任何改动」', () => {
    const t = handoffLines(h({ salvage: ['a'], kept: [{ path: '/wt/x', why: '未回收' }] }), '001').join('\n')
    expect(t).not.toContain('本次没有产生任何改动')
    expect(t).toContain('没有待合的提交,但下面还有没送到的产出')
  })

  it('盘上真的干净 → 照旧那句', () => {
    expect(handoffLines(h(), '001').join('\n')).toContain('本次没有产生任何改动')
  })
})
