// src/tools/efftask/parseDirectives.test.ts
import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'
import type { RoleDef } from './roleDefs.js'
import { PHASE_NAMES } from './types.js'
import { DEFAULT_CAPS } from './types.js'

describe('parseDirectives', () => {
  it('no modelJson => all defaults', async () => {
    const cfg = await parseDirectives('随便做点事', { knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(5)
    expect(cfg.goalPrompt).toBe('随便做点事')
  })
  it('applies parsed roles filtered by knownRoles', async () => {
    const modelJson = async () => JSON.stringify({
      parallelism: 3,
      phaseRoles: { review: ['architect', 'ghost'], execute: ['coder'] },
      caps: { maxDepth: 4 },
    })
    const cfg = await parseDirectives('做需求 X', { modelJson, knownRoles: ['architect', 'coder'] })
    expect(cfg.parallelism).toBe(3)
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'architect' }]) // ghost dropped
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'coder' }])
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(4)
    expect(cfg.caps.maxNodes).toBe(100) // untouched default
  })
  it('modelJson throws => defaults', async () => {
    const modelJson = async () => { throw new Error('boom') }
    const cfg = await parseDirectives('x', { modelJson, knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('modelJson returns garbage => defaults', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => 'not json', knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('clamps out-of-range parallelism', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => JSON.stringify({ parallelism: 0 }), knownRoles: [] })
    expect(cfg.parallelism).toBe(1)
  })

  const withModel = (o: unknown, knownRoles: string[] = []) =>
    parseDirectives('x', { modelJson: async () => JSON.stringify(o), knownRoles })

  it('safety caps can never be disabled, only clamped into range', async () => {
    const low = await withModel({ caps: { maxDepth: 0, maxNodes: -1, maxIterations: 0 } })
    expect(low.caps).toMatchObject({ maxDepth: 1, maxNodes: 1, maxIterations: 1 })
    const high = await withModel({ caps: { maxDepth: 9999, maxNodes: 1e9, maxIterations: 999 } })
    expect(high.caps).toMatchObject({ maxDepth: 20, maxNodes: 5000, maxIterations: 20 })
    const junk = await withModel({ caps: { maxDepth: 'deep', maxNodes: null, maxIterations: 'many' } })
    expect(junk.caps).toMatchObject({ maxDepth: 5, maxNodes: 100, maxIterations: 3 }) // untouched defaults
  })
  it('coerces or rejects non-numeric parallelism instead of trusting it', async () => {
    expect((await withModel({ parallelism: '3' })).parallelism).toBe(5) // string => default
    expect((await withModel({ parallelism: null })).parallelism).toBe(5)
    expect((await withModel({ parallelism: 3.7 })).parallelism).toBe(4) // rounded
    expect((await withModel({ parallelism: -5 })).parallelism).toBe(1)
    expect((await withModel({ parallelism: 1e9 })).parallelism).toBe(64)
  })
  it('survives hostile phaseRoles shapes without throwing', async () => {
    expect((await withModel({ phaseRoles: 'architect' }, ['architect'])).phaseRoles.review).toEqual([])
    expect((await withModel({ phaseRoles: { review: 'architect' } }, ['architect'])).phaseRoles.review).toEqual([])
    const messy = await withModel({ phaseRoles: { review: [null, '', '  ', 7, { n: 1 }, 'architect'], deploy: ['architect'] } }, ['architect'])
    expect(messy.phaseRoles.review).toEqual([{ roleName: 'architect' }]) // junk entries dropped
    expect(messy.phaseRoles.plan).toEqual([]) // unknown phase key ignored, no crash
  })
  it('dedupes repeated role names — one entry is one seat at the roundtable', async () => {
    const cfg = await withModel({ phaseRoles: { review: ['architect', 'architect', 'sec', 'architect'] } }, ['architect', 'sec'])
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'architect' }, { roleName: 'sec' }])
  })
  it('a top-level array or primitive degrades to defaults', async () => {
    for (const junk of ['[{"parallelism":99}]', '42', '"nope"', '[]', '', '   ']) {
      const cfg = await parseDirectives('x', { modelJson: async () => junk, knownRoles: [] })
      expect(cfg.parallelism).toBe(5)
      expect(cfg.caps.maxNodes).toBe(100)
    }
  })
  it('returns fresh objects — mutating one config never touches the next or the defaults', async () => {
    const a = await parseDirectives('x', { knownRoles: [] })
    const b = await parseDirectives('x', { knownRoles: [] })
    a.caps.maxDepth = 99
    a.phaseRoles.review.push({ roleName: 'leaked' })
    expect(b.caps.maxDepth).toBe(5)
    expect(b.phaseRoles.review).toEqual([])
    expect(DEFAULT_CAPS.maxDepth).toBe(5)
  })
})

describe('the roster must not promise what will not run', () => {
  const withRoles = (phaseRoles: unknown, opts: { knownRoles: string[]; unsupportedRoles?: string[] }) =>
    parseDirectives('x', { ...opts, modelJson: async () => JSON.stringify({ phaseRoles }) })

  it('reports unknown role names instead of silently dropping them', async () => {
    const cfg = await withRoles({ review: ['arch', 'ghost'] }, { knownRoles: ['arch'] })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'arch' }])
    expect(cfg.notices.join(' ')).toContain('ghost')
    expect(cfg.notices.join(' ')).toContain('未找到')
  })

  it('reports a CLI-mode role rather than downgrading it to the main model behind the name', async () => {
    // runAgent has no cli branch — the role's command/args would be ignored and the main
    // model would answer while the roster still displayed the role's name.
    const cfg = await withRoles({ accept: ['codex', 'sec'] }, { knownRoles: ['codex', 'sec'], unsupportedRoles: ['codex'] })
    expect(cfg.phaseRoles.accept).toEqual([{ roleName: 'sec' }])
    expect(cfg.notices.join(' ')).toContain('codex')
    expect(cfg.notices.join(' ')).toContain('CLI')
  })

  it('keeps only the execute role that actually runs, and says so', async () => {
    // execute 只跑一个 agent,而且那是**物理约束**:pathFor(node) 不含员工维度,两个
    // 员工会拿到同一个 worktree 路径。plan 不再裁剪 —— 见下一条。
    const cfg = await withRoles(
      { plan: ['p1', 'p2'], execute: ['e1', 'e2'], review: ['r1', 'r2'] },
      { knownRoles: ['p1', 'p2', 'e1', 'e2', 'r1', 'r2'] },
    )
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'e1' }])
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'r1' }, { roleName: 'r2' }]) // roundtable keeps all
    expect(cfg.notices.join(' ')).toContain('e2')
    expect(cfg.notices.join(' ')).not.toContain('p2')
  })

  it('plan 保留多个员工 —— 它走顺序精化,不是「多出来的名字永远不跑」', async () => {
    // 第一位起草,后面每一位在前一稿上修订。全程只有一份稿子在走,所以用户要的
    // 「只有一个结论方案或产出」是结构保证的。
    const cfg = await withRoles({ plan: ['p1', 'p2'] }, { knownRoles: ['p1', 'p2'] })
    expect(cfg.phaseRoles.plan).toEqual([{ roleName: 'p1' }, { roleName: 'p2' }])
    expect(cfg.notices.join(' ')).not.toContain('p2')
  })

  it('seats the observer now that scoring actually runs', async () => {
    // This assertion used to be the opposite: while scoring was unimplemented the roster
    // dropped every observer and said so, because naming a scorer that never scores is the
    // untrue-gate failure these notices exist to prevent. Scoring is implemented now, so the
    // seat is real — and the test flips with the behaviour rather than being deleted.
    const cfg = await withRoles({ observer: ['watcher'] }, { knownRoles: ['watcher'] })
    expect(cfg.phaseRoles.observer).toEqual([{ roleName: 'watcher' }])
    expect(cfg.notices.join(' ')).not.toContain('watcher')
  })

  it('观察保留多个员工 —— 各自打分,取最低分收敛,其余理由挂 others', async () => {
    // 这条曾经断言只留第一个。裁剪留着的话,关口会说一句关于系统能力的**假话**,
    // 而且和 PHASE_SEATING/allowsMultipleSeats 直接矛盾。
    const cfg = await withRoles({ observer: ['w1', 'w2'] }, { knownRoles: ['w1', 'w2'] })
    expect(cfg.phaseRoles.observer).toEqual([{ roleName: 'w1' }, { roleName: 'w2' }])
    expect(cfg.notices.join(' ')).not.toContain('仅首个角色')
  })

  it('an unknown observer does NOT fall back to the main model — scoring is opt-in', async () => {
    // Every other phase falls back to 主模型. Scoring must not: silently promoting the main
    // model into a scorer nobody asked for would spend real calls on an advisory number.
    const cfg = await withRoles({ observer: ['ghost'] }, { knownRoles: ['arch'] })
    expect(cfg.phaseRoles.observer).toEqual([])
    expect(cfg.notices.join(' ')).toContain('不评分')
    expect(cfg.notices.join(' ')).not.toContain('改用主模型')
  })
})

describe('a notice must not describe a fallback that never happens', () => {
  const json = (o: unknown) => async () => JSON.stringify(o)

  it('says who still holds the seat when one of several names was dropped', async () => {
    // 方案 runs planner1; planner2 is unknown and merely dropped. Announcing "改用主模型"
    // here would tell the user the plan phase fell back to the main model while the roster
    // simultaneously shows planner1 — the gate contradicting itself.
    const cfg = await parseDirectives('方案用 planner1 和 planner2', {
      knownRoles: ['planner1'],
      modelJson: json({ phaseRoles: { plan: ['planner1', 'planner2'] } }),
    })
    const n = cfg.notices.join(' ')
    expect(n).toContain('未找到角色 planner2')
    expect(n).toContain('仍由 planner1 承担')
    expect(n).not.toContain('改用主模型')
    expect(cfg.phaseRoles.plan.map(r => r.roleName)).toEqual(['planner1'])
  })

  it('still says 改用主模型 when the phase really is left with nobody', async () => {
    const cfg = await parseDirectives('评审用 ghost', {
      knownRoles: ['arch'],
      modelJson: json({ phaseRoles: { review: ['ghost'] } }),
    })
    expect(cfg.notices.join(' ')).toContain('改用主模型')
    expect(cfg.phaseRoles.review).toEqual([])
  })

  it('a dropped reviewer names the reviewers that remain, so the panel size is honest', async () => {
    const cfg = await parseDirectives('评审用 arch、sec、ghost', {
      knownRoles: ['arch', 'sec'],
      modelJson: json({ phaseRoles: { review: ['arch', 'sec', 'ghost'] } }),
    })
    expect(cfg.notices.join(' ')).toContain('仍由 arch、sec 承担')
    expect(cfg.phaseRoles.review.map(r => r.roleName)).toEqual(['arch', 'sec'])
  })

  it('a cli-mode role that empties the phase reports the fallback, not a bare 已忽略', async () => {
    const cfg = await parseDirectives('验收用 codex-reviewer', {
      knownRoles: ['codex-reviewer'],
      unsupportedRoles: ['codex-reviewer'],
      modelJson: json({ phaseRoles: { accept: ['codex-reviewer'] } }),
    })
    const n = cfg.notices.join(' ')
    expect(n).toContain('CLI 模式')
    expect(n).toContain('改用主模型')
    expect(cfg.phaseRoles.accept).toEqual([])
  })

  it('the observer phase never claims a fallback — nothing runs there at all', async () => {
    const cfg = await parseDirectives('观察用 ghost', {
      knownRoles: ['arch'],
      modelJson: json({ phaseRoles: { observer: ['ghost'] } }),
    })
    expect(cfg.notices.join(' ')).not.toContain('改用主模型')
    expect(cfg.phaseRoles.observer).toEqual([])
  })
})

describe('提示词里可以定义角色,也可以改配置文件里的角色', () => {
  const known = ['opus-架构', 'ds-安全']
  const json = (o: unknown) => async () => '```json\n' + JSON.stringify(o) + '\n```'
  const arch = (o: object = {}): RoleDef =>
    ({ name: '架构师', stage: 'review', output: '裁决与阻断项', purpose: '把关可维护性', staff: [], ...o }) as RoleDef

  it('提示词里定义的角色变成真席位,并带上角色标签', async () => {
    const cfg = await parseDirectives('评审由架构师把关', {
      knownRoles: known,
      modelJson: json({ roles: [{ name: '架构师', stage: 'review', output: '裁决', purpose: '把关可维护性', staff: ['opus-架构'] }] }),
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(cfg.roleDefs?.[0].purpose).toBe('把关可维护性')
  })

  it('没写 staff 的角色 → 主模型兼任的一席,roleName 不是角色名', async () => {
    const cfg = await parseDirectives('评审由架构师把关', {
      knownRoles: known,
      modelJson: json({ roles: [{ name: '架构师', stage: 'review', output: '裁决', purpose: '把关' }] }),
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: '', roleTag: '架构师' }])
  })

  it('提示词说「改由 X 担任」是真的改,不是再加一个', async () => {
    // 「任务需求提示词可更新改变这种配置」。取并集的话,「架构师这次改由 ds-安全 担任」
    // 会得到 opus-架构 + ds-安全 ——「改由」变成了「再加一个」,用户要换人就换不掉。
    const cfg = await parseDirectives('架构师这次改由 ds-安全 担任,重点看回滚', {
      knownRoles: known,
      baseRoleDefs: [arch({ staff: ['opus-架构'] })],
      modelJson: json({ roles: [{ name: '架构师', stage: 'review', output: '裁决', purpose: '重点看回滚路径', staff: ['ds-安全'] }] }),
    })
    expect(cfg.roleDefs?.[0].purpose).toBe('重点看回滚路径')
    expect(cfg.phaseRoles.review.map(s => s.roleName)).toEqual(['ds-安全'])
    expect(cfg.notices.join('\n')).toContain('已按提示词改为 ds-安全')
    expect(cfg.notices.join('\n')).toContain('原为 opus-架构')
  })

  it('提示词只改产出/作用、没提员工 → 不清空配置文件里的人', async () => {
    const cfg = await parseDirectives('架构师这次重点看回滚', {
      knownRoles: known,
      baseRoleDefs: [arch({ staff: ['opus-架构'] })],
      modelJson: json({ roles: [{ name: '架构师', stage: 'review', output: '裁决', purpose: '重点看回滚路径' }] }),
    })
    expect(cfg.roleDefs?.[0].purpose).toBe('重点看回滚路径')
    expect(cfg.phaseRoles.review.map(s => s.roleName)).toEqual(['opus-架构'])
  })

  it('配置文件里的角色在提示词没提它时照样生效', async () => {
    const cfg = await parseDirectives('随便做点什么', {
      knownRoles: known,
      baseRoleDefs: [arch({ staff: ['opus-架构'] })],
      modelJson: json({ parallelism: 3 }),
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(cfg.parallelism).toBe(3)
  })

  it('抽取模型答了但没吐出 json 块 → 配置文件里的角色仍然生效', async () => {
    // 第三条退化路径(另两条是抛异常、根本没有抽取模型)。此前无人守:把 `if (!obj)`
    // 改回 `return base`,整个 efftask 目录全绿。
    const cfg = await parseDirectives('随便做点什么', {
      knownRoles: known,
      baseRoleDefs: [arch({ staff: ['opus-架构'] })],
      modelJson: async () => '模型只说了句人话,没有代码块',
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
  })

  it('抽取模型挂了 → 配置文件里的角色仍然生效', async () => {
    // 这条最要紧:抽取失败是最常走到的退化路径,而「在配置文件里配好角色」不该只在
    // 抽取成功时才通。
    const cfg = await parseDirectives('随便做点什么', {
      knownRoles: known,
      baseRoleDefs: [arch({ staff: ['opus-架构'] })],
      modelJson: async () => { throw new Error('provider down') },
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
  })

  it('根本没有抽取模型时也一样', async () => {
    const cfg = await parseDirectives('x', { knownRoles: known, baseRoleDefs: [arch({ staff: ['opus-架构'] })] })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
  })

  it('缺 output/purpose 的角色不生效,并说明为什么', async () => {
    const cfg = await parseDirectives('加个安全角色', {
      knownRoles: known,
      modelJson: json({ roles: [{ name: '安全', stage: 'review', staff: ['ds-安全'] }] }),
    })
    expect(cfg.phaseRoles.review).toEqual([])
    expect(cfg.notices.join('\n')).toContain('安全')
    expect(cfg.notices.join('\n')).toContain('不生效')
  })

  it('按名字指定的员工 + 同一员工的角色定义 → 一席,不是两席', async () => {
    const cfg = await parseDirectives('评审用 opus-架构,架构师由 opus-架构 担当', {
      knownRoles: known,
      modelJson: json({
        phaseRoles: { review: ['opus-架构'] },
        roles: [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构'] }],
      }),
    })
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(cfg.notices.join('\n')).toContain('不再额外占一席')
  })

  it('没有任何角色定义时 roleDefs 不写进配置 —— 老 run.md 的形状不变', async () => {
    const cfg = await parseDirectives('x', { knownRoles: known, modelJson: json({ parallelism: 2 }) })
    expect(cfg.roleDefs).toBeUndefined()
  })
})

describe('caps 里两个新旋钮要有正常入口', () => {
  const json = (o: unknown) => async () => '```json\n' + JSON.stringify(o) + '\n```'
  it('抽取出来的 caps 能落到配置上并被夹取(modelJson 是桩,不验证抽取本身)', async () => {
    // 名字要说实话:modelJson 是个忽略入参、直接吐固定 JSON 的桩,所以这条**验不了**
    // 「那句中文能不能被抽出来」—— 决定那件事的是 EXTRACT_PROMPT 的文字,而它曾经
    // 把「三分之二」教成 67(2/3 = 66.67 < 67,教科书场景直接不通过)。
    // 这条只保证:JSON 到了 → 夹取 → 落到 caps 上。
    const cfg = await parseDirectives('过半通过就行,每阶段最多 3 席', {
      knownRoles: [], modelJson: json({ caps: { quorum: 50, maxSeatsPerPhase: 3 } }),
    })
    expect(cfg.caps.quorum).toBe(50)
    expect(cfg.caps.maxSeatsPerPhase).toBe(3)
  })
  it('越界值被夹住', async () => {
    const cfg = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { quorum: 500, maxSeatsPerPhase: 99 } }) })
    expect(cfg.caps.quorum).toBe(100)
    expect(cfg.caps.maxSeatsPerPhase).toBe(20)
  })
  it('静默超时可以用一句话调 —— 此前只能手改 run.md', async () => {
    /**
     * 它是阻断卡唯一会点名让用户去调的旋钮(「提高 run.md 里 caps.nodeTimeoutMs」),
     * 而正常路径上到不了它 —— 和 maxSeatsPerPhase / quorum 当初的处境逐字相同。
     *
     * 用户报的场景:一个思考很久的模型配成员工老是「超时」,而同一个模型当主模型正常。
     * 那条时钟本身已经修好(流式增量算进展),但真的需要更长静默预算时,他得有个入口。
     */
    const cfg = await parseDirectives('这个模型慢,阶段超时给 20 分钟', {
      knownRoles: [], modelJson: json({ caps: { nodeTimeoutMs: 1_200_000 } }),
    })
    expect(cfg.caps.nodeTimeoutMs).toBe(1_200_000)
  })

  it('静默超时的夹取范围和 resumeCore 读回时那一份相同(1s–2h)', async () => {
    // 两处不一致的话,同一个数在启动时被接受、在恢复时被改写,而屏幕上没有任何东西
    // 解释它为什么变了。
    const tiny = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { nodeTimeoutMs: 5 } }) })
    expect(tiny.caps.nodeTimeoutMs).toBe(1000)
    const huge = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { nodeTimeoutMs: 99_999_999 } }) })
    expect(huge.caps.nodeTimeoutMs).toBe(7_200_000)
  })

  it('自动解冲突的次数可以用一句话调,0 = 关掉', async () => {
    // 用户原话:「合并冲突解决次数不止 2 次,可以默认 6 次,然后还可以更改。」没有这个
    // 入口的话,「还可以更改」只能靠手改 run.md 再 --resume —— 和 nodeTimeoutMs 当初
    // 的处境逐字相同。
    const many = await parseDirectives('解冲突给 10 次机会', {
      knownRoles: [], modelJson: json({ caps: { mergeResolveAttempts: 10 } }),
    })
    expect(many.caps.mergeResolveAttempts).toBe(10)
    const off = await parseDirectives('冲突别自动解,直接叫我', {
      knownRoles: [], modelJson: json({ caps: { mergeResolveAttempts: 0 } }),
    })
    expect(off.caps.mergeResolveAttempts).toBe(0)
    // 没说就是默认 6。
    const dflt = await parseDirectives('x', { knownRoles: [], modelJson: json({}) })
    expect(dflt.caps.mergeResolveAttempts).toBe(6)
  })

  it('自动解冲突次数的夹取和 resumeCore 读回时那一份相同(0–20),坏值回落到默认', async () => {
    const huge = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { mergeResolveAttempts: 999 } }) })
    expect(huge.caps.mergeResolveAttempts).toBe(20)
    const neg = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { mergeResolveAttempts: -3 } }) })
    expect(neg.caps.mergeResolveAttempts).toBe(0)
    /**
     * **坏值不能回落到 0。** 0 在这里是一个真实的意思(关掉自动解决),所以把一个
     * 解析不出来的值静默解释成 0,等于用一个「写坏了」换来「功能被关掉」,而用户
     * 写它的意图恰恰相反。
     */
    const junk = await parseDirectives('x', { knownRoles: [], modelJson: json({ caps: { mergeResolveAttempts: '六次' } }) })
    expect(junk.caps.mergeResolveAttempts).toBe(6)
  })

  it('maxSeatsPerPhase 真的作用到席位上,不只是存进 caps', async () => {
    // 只断言 caps 里的数值,等于只验证「配置被记下来了」;剪断传给 applyRoleDefsToPhases
    // 的那一跳,数值还在、席位照旧超编。
    const cfg = await parseDirectives('评审用四个人,但每阶段最多 2 席', {
      knownRoles: ['a', 'b', 'c', 'd'],
      modelJson: json({
        caps: { maxSeatsPerPhase: 2 },
        roles: [{ name: '评审团', stage: 'review', output: 'o', purpose: 'p', staff: ['a', 'b', 'c', 'd'] }],
      }),
    })
    expect(cfg.phaseRoles.review).toHaveLength(2)
    expect(cfg.notices.join('\n')).toContain('席位上限 2')
  })

  it('不提就不设,老配置形状不变', async () => {
    const cfg = await parseDirectives('x', { knownRoles: [], modelJson: json({ parallelism: 2 }) })
    expect(cfg.caps.quorum).toBeUndefined()
    expect(cfg.caps.maxSeatsPerPhase).toBeUndefined()
  })
})

describe('抽取提示词必须覆盖全部环节', () => {
  // 它此前停在五个:用户在 /et 指令里写「测试验证由 X 跑」,抽取模型被明确告知只能从
  // 那五个里选 —— 而文档同时承诺「任务提示词里也可以定义或覆盖任务角色」。
  const promptText = async (): Promise<string> => {
    let seen = ''
    await parseDirectives('随便', { knownRoles: [], modelJson: async p => { seen = p; return '' } })
    return seen
  }

  it('七个内部环节名都在', async () => {
    const t = await promptText()
    for (const p of PHASE_NAMES) expect(`${p}:${t.includes(p)}`).toBe(`${p}:true`)
  })

  it('中文环节名的对应关系也给了模型', async () => {
    const t = await promptText()
    for (const label of ['测试修复', '集成验收', '质疑修复']) {
      expect(`${label}:${t.includes(label)}`).toBe(`${label}:true`)
    }
  })

  it('不再宣称「那五个之一」', async () => {
    expect(await promptText()).not.toContain('那五个之一')
  })
})

/**
 * 提示词那条录入口的解析。
 *
 * 这一整块之前是**零覆盖**的,代价是:`STEP_ALIASES` 没写进这个文件的 import,于是抽取
 * 模型只要返回任何非空 `skipSteps` 就抛 `ReferenceError`。efftask.tsx 的 `.catch` 把它
 * 兜住,回落到「不带抽取模型」那条路 —— 那条路直接返回一份纯默认 config。用户说的
 * 并行数、门槛、席位、角色定义**全部消失**,notices 是空的,关口一个字都不解释。
 * 全量 1384 条测试当时是全绿的。
 */
describe('parseDirectives:跳过环节(唯一的提示词入口)', () => {
  const P = (skipSteps: unknown, extra: Record<string, unknown> = {}) =>
    parseDirectives('干活', { knownRoles: [], modelJson: async () => JSON.stringify({ skipSteps, ...extra }) })

  it('中文环节名归一成内部名', async () => {
    expect((await P(['质疑讨论', '验收'])).skipSteps).toEqual(['review', 'accept'])
  })
  it('英文名直接收下,大小写敏感', async () => {
    expect((await P(['review', 'observer'])).skipSteps).toEqual(['review', 'observer'])
  })
  it('旧名「集成提交」仍然认', async () => {
    expect((await P(['集成提交'])).skipSteps).toEqual(['integrate'])
  })
  it('七个环节每一个都跳得掉 —— 没有哪个是特殊的', async () => {
    for (const p of PHASE_NAMES) expect((await P([p])).skipSteps).toEqual([p])
  })
  it('去重,且空串/非字符串被忽略', async () => {
    expect((await P(['验收', 'accept', '', '  ', 42, null])).skipSteps).toEqual(['accept'])
  })
  it('环节名写错 → 不跳,给 notice 并猜一个最接近的', async () => {
    const cfg = await P(['测试'])
    expect(cfg.skipSteps).toBeUndefined()
    expect(cfg.notices.join('\n')).toContain('是不是想写「测试修复」')
  })
  it('没说跳过时 skipSteps 不出现,也不报噪音', async () => {
    const cfg = await parseDirectives('干活', { knownRoles: [], modelJson: async () => '{"parallelism":3}' })
    expect(cfg.skipSteps).toBeUndefined()
    expect(cfg.notices).toEqual([])
  })
  it('**跳过解析不能拖垮整份配置** —— 同一份 JSON 里的其它指令必须都活着', async () => {
    // 这正是 STEP_ALIASES 那个 ReferenceError 的实际杀伤方式:它不是「跳过没生效」,
    // 而是**整条提示词的所有指令一起消失**。
    const cfg = await parseDirectives('干活', {
      knownRoles: ['arch'],
      modelJson: async () => JSON.stringify({
        skipSteps: ['质疑讨论'], parallelism: 8,
        phaseRoles: { plan: ['arch'] }, caps: { maxIterations: 5, planConverge: '圆桌' },
      }),
    })
    expect(cfg.skipSteps).toEqual(['review'])
    expect(cfg.parallelism).toBe(8)
    expect(cfg.phaseRoles.plan).toEqual([{ roleName: 'arch' }])
    expect(cfg.caps.maxIterations).toBe(5)
    expect(cfg.caps.planConverge).toBe('圆桌')
  })
})

/** 分析环节的收敛方式 —— 删掉这个夹取,整个方案融合特性在生产上不可达,而它的十条测试一条不红。 */
describe('parseDirectives:planConverge', () => {
  const C = (planConverge: unknown) =>
    parseDirectives('干活', { knownRoles: [], modelJson: async () => JSON.stringify({ caps: { planConverge } }) })

  it('圆桌 / 精化 都收下', async () => {
    expect((await C('圆桌')).caps.planConverge).toBe('圆桌')
    expect((await C('精化')).caps.planConverge).toBe('精化')
  })
  it('不认识的值回落 undefined(= 默认精化),并且**说出来**', async () => {
    // 静默回落最糟:用户说了「分析用 roundtable」,系统跑精化,关口和 notices 都不吭声,
    // 没有任何界面能让他发现。
    const cfg = await C('roundtable')
    expect(cfg.caps.planConverge).toBeUndefined()
    expect(cfg.notices.join('\n')).toContain('planConverge')
  })
})

/**
 * 「这段话不会生效」的提示本身说了假话。
 *
 * 实测(跑机 run 001 的 run.md):notices 里印着「你对『测试验证』提的那段要求不会生效:
 * 没给这个环节配角色,它这次不会发生」,而同一份 run.md 的 `phaseRoles.verify` 挂着测试官,
 * 测试验证这一关实跑了 3 轮。原因是这条判断跑在 `applyDefs` **之前** —— 那时候席位还只在
 * roleDefs 里(`stage: verify`),还没被落到名册上。
 */
describe('parseDirectives:「没配角色」这条提示要在名册定下来之后才判', () => {
  const known = ['gpt-测试']
  const json = (o: unknown) => async () => '```json\n' + JSON.stringify(o) + '\n```'
  const tester = (): RoleDef =>
    ({ name: '测试官', stage: 'verify', output: '命令与原始输出', purpose: '真的把测试跑起来', staff: ['gpt-测试'] }) as RoleDef

  it('roleDefs 里有 verify 角色时,不许再说「没给这个环节配角色」', async () => {
    const cfg = await parseDirectives('测试验证时主要看能不能编译过', {
      knownRoles: known,
      baseRoleDefs: [tester()],
      modelJson: json({ phaseGuidance: { verify: '主要看能不能编译过' } }),
    })
    expect(cfg.phaseRoles.verify.length).toBeGreaterThan(0)
    expect(cfg.phaseGuidance?.verify).toContain('编译')
    expect(cfg.notices.join('\n')).not.toContain('没给这个环节配角色')
  })

  it('真的没人配 verify 时,照旧要说出来 —— 这条提示不是被删掉了', async () => {
    const cfg = await parseDirectives('测试验证时跑 bun test', {
      knownRoles: known,
      modelJson: json({ phaseGuidance: { verify: '跑 bun test' } }),
    })
    expect(cfg.phaseRoles.verify).toEqual([])
    expect(cfg.notices.join('\n')).toContain('没给这个环节配角色')
  })
})

/**
 * 抽取失败**不许静默** —— 这一条是拿一次真实跑机换来的。
 *
 * 跑机日志(qianbase-xtp,2026-08-06):用户在提示词里写了「不需要质疑讨论阶段、验收阶段、
 * 测试验证阶段、观察阶段」「安全阀 20 层 5000 节点」和一整套角色定向,而承载这些的那一次
 * 抽取调用被上游 403 顶回来(Kimi 账期额度用尽)。老代码 `catch {}` 直接返回默认配置,
 * **一条 notice 都不留** —— 关口于是显示一份七个环节俱全、什么都没跳过的「正常」配置。
 * 用户看到的结论是「要求去掉某些阶段,也没有去掉」,而真因一个字都没上屏。
 */
describe('需求解析失败要说出来,不能静默退回默认配置', () => {
  const opts = { knownRoles: [] as string[] }

  it('抽取调用抛错 → notice 说清「一条都没生效」并带上原因', async () => {
    const cfg = await parseDirectives('把 X 翻译成 Rust。不需要质疑修复阶段、验收阶段。', {
      ...opts,
      modelJson: async () => { throw new Error('API Error: 403 permission_error usage limit') },
    })
    const n = cfg.notices.join('\n')
    expect(n).toContain('需求解析那次调用**失败**了')
    expect(n).toContain('一条都没生效')
    expect(n).toContain('403')
    // 而且真的没生效 —— 这半句必须一起断言,否则 notice 可能在说谎。
    expect(cfg.skipSteps ?? []).toEqual([])
  })

  it('抽取回了东西但解析不出 JSON → 同样有 notice', async () => {
    const cfg = await parseDirectives('把 X 翻译成 Rust。跳过验收。', {
      ...opts,
      modelJson: async () => '我觉得这个需求挺好的,不过我不打算输出 JSON。',
    })
    expect(cfg.notices.join('\n')).toContain('没有返回可解析的 JSON')
    expect(cfg.skipSteps ?? []).toEqual([])
  })

  it('抽取成功时一个字都不多说 —— 上面那两条不是恒真的', async () => {
    const cfg = await parseDirectives('把 X 翻译成 Rust。跳过验收。', {
      ...opts,
      modelJson: async () => '```json\n{"skipSteps":["验收"]}\n```',
    })
    expect(cfg.notices.join('\n')).not.toContain('需求解析')
    expect(cfg.skipSteps).toEqual(['accept'])
  })
})
