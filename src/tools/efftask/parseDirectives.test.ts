// src/tools/efftask/parseDirectives.test.ts
import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'
import type { RoleDef } from './roleDefs.js'
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

  it('keeps only the plan/execute role that actually runs, and says so', async () => {
    // Only review and accept fan out; plan and execute run a single agent.
    const cfg = await withRoles(
      { plan: ['p1', 'p2'], execute: ['e1', 'e2'], review: ['r1', 'r2'] },
      { knownRoles: ['p1', 'p2', 'e1', 'e2', 'r1', 'r2'] },
    )
    expect(cfg.phaseRoles.plan).toEqual([{ roleName: 'p1' }])
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'e1' }])
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'r1' }, { roleName: 'r2' }]) // roundtable keeps all
    expect(cfg.notices.join(' ')).toContain('p2')
    expect(cfg.notices.join(' ')).toContain('e2')
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

  it('seats only the FIRST observer — node.score holds one record per dimension', async () => {
    const cfg = await withRoles({ observer: ['w1', 'w2'] }, { knownRoles: ['w1', 'w2'] })
    expect(cfg.phaseRoles.observer).toEqual([{ roleName: 'w1' }])
    expect(cfg.notices.join(' ')).toContain('w2')
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
  it('quorum 与 maxSeatsPerPhase 能从提示词抽出来并夹取', async () => {
    // 只有 readRunManifest 读回而没人写进去的话,它们只能靠手改 run.md 再 --resume
    // 才生效 —— 那就是又一处「配置得进去、正常路径上到不了」。
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
