// src/tools/efftask/roundtable.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, MAIN_STAFF } from './types.js'
import type { RoleBinding, Verdict } from './types.js'
import { synthesizeVerdicts, runRoundtable, RunAgentFn } from './roundtable.js'
import { MAX_SUMMARY_CHARS } from './parseOutput.js'

const NOW = '2026-07-25T00:00:00Z'
const node = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('roundtable', () => {
  it('synthesizeVerdicts unanimous pass', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: true, blocking: [], comments: '' }])
    expect(s.pass).toBe(true)
  })
  it('synthesizeVerdicts any fail => fail with summary', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: false, blocking: ['X 缺失'], comments: '' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('X 缺失')
  })
  it('synthesizeVerdicts: fail with NO blocking items falls back to comments (never empty)', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '方案太粗,缺落地步骤' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('方案太粗') // empty feedback => identical re-prompt => burned iterations
    const s2 = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '   ' }])
    expect(s2.blockingSummary.length).toBeGreaterThan(0) // still non-empty even without comments
  })
  it('runRoundtable with empty roles uses a single main reviewer', async () => {
    const calls: (string | null)[] = []
    const runAgent: RunAgentFn = async req => { calls.push(req.role ? req.role.roleName : null); return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [], round: 1, system: 's', prompt: () => 'p', runAgent, signal: new AbortController().signal })
    expect(calls).toEqual([null])
    expect(rec.verdicts).toHaveLength(1)
    expect(rec.synthesized.pass).toBe(true)
  })
  it('runRoundtable multiple roles: any blocking fails', async () => {
    const runAgent: RunAgentFn = async req =>
      req.role?.roleName === 'sec'
        ? '```json\n{"pass":false,"blocking":["注入风险"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'sec' }], round: 2, system: 's', prompt: () => 'p', runAgent, signal: new AbortController().signal })
    expect(rec.round).toBe(2)
    expect(rec.verdicts).toHaveLength(2)
    expect(rec.synthesized.pass).toBe(false)
    expect(rec.synthesized.blockingSummary).toContain('注入风险')
  })
  it('runRoundtable: a rejected role becomes a synthesized failing verdict, does NOT throw', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.role?.roleName === 'boom') throw new Error('调用崩溃')
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'boom' }], round: 1, system: 's', prompt: () => 'p', runAgent, signal: new AbortController().signal })
    expect(rec.verdicts).toHaveLength(2)
    const boom = rec.verdicts.find(v => v.role === 'boom')!
    expect(boom.pass).toBe(false)
    expect(boom.blocking[0]).toContain('角色调用失败')
    expect(rec.synthesized.pass).toBe(false) // synthesized reflects the failing reviewer
  })
  it('an already-aborted signal dispatches nothing and fails closed', async () => {
    // First-party logic in the acceptance gate: without it, aborting would still spend a
    // whole roundtable of model calls and could synthesize a PASS from partial output.
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; return '```json\n{"pass":true,"blocking":[]}\n```' }
    const ac = new AbortController()
    ac.abort()
    const rec = await runRoundtable({ phase: 'accept', node: node(), roles: [{ roleName: 'a' }, { roleName: 'b' }], round: 2, system: 's', prompt: () => 'p', runAgent, signal: ac.signal })
    expect(calls).toBe(0)
    expect(rec.round).toBe(2)
    expect(rec.synthesized.pass).toBe(false)
    expect(rec.synthesized.blockingSummary).toContain('已中断')
  })
})


describe('合成裁决也要封顶 —— 它是 node.md 体积最大的贡献者', () => {
  it('blockingSummary 拼接后按上限截断', () => {
    // It concatenates every reviewer's every blocking entry: 5 roles x 21 entries x 2000
    // chars is ~200 KB per round, and it is copied again into blockedReason. Measured 2.5 MB
    // per node before this.
    const verdicts = [...Array(5)].map((_, i) => ({
      role: 'r' + i, pass: false,
      blocking: [...Array(21)].map(() => 'x'.repeat(2000)),
      comments: '',
    }))
    const out = synthesizeVerdicts(verdicts)
    expect(out.pass).toBe(false)
    expect(Array.from(out.blockingSummary).length).toBeLessThan(MAX_SUMMARY_CHARS + 100)
    expect(out.blockingSummary).toContain('已截断')
  })

  it('正常长度的意见一个字都不动', () => {
    const out = synthesizeVerdicts([{ role: 'a', pass: false, blocking: ['缺测试'], comments: '' }])
    expect(out.blockingSummary).toBe('[a] 缺测试')
  })
})

describe('每个席位可以拿到自己的提示词 —— 角色职责说明的唯一通道', () => {
  it('不同席位收到不同的提示词', async () => {
    // 改这条之前,`prompt` 是一个字符串,原样发给名册里每一个人。于是名册可以写三个不同的
    // 评审员,而三个人收到的指令**逐字节相同** —— 区分他们的只有"哪个模型在答"。
    // 用户要的「角色必须描述清楚产出什么、起什么作用」在那种结构下,会被解析、被校验、
    // 在关口上显示,然后一次模型调用都影响不到。那正是这个仓库反复在修的死配置形状。
    const seen: { role: string | null; prompt: string }[] = []
    const runAgent = (async (req: { role: { roleName: string } | null; prompt: string }) => {
      seen.push({ role: req.role?.roleName ?? null, prompt: req.prompt })
      return '```verdict\n{"pass":true,"blocking":[],"comments":""}\n```'
    }) as never
    await runRoundtable({
      phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'sec' }],
      round: 1, system: 's',
      prompt: seat => `基础指令。你的职责:${seat?.roleName === 'arch' ? '把关可维护性' : '把关安全边界'}`,
      runAgent, signal: new AbortController().signal,
    })
    expect(seen).toHaveLength(2)
    expect(seen.find(x => x.role === 'arch')!.prompt).toContain('把关可维护性')
    expect(seen.find(x => x.role === 'sec')!.prompt).toContain('把关安全边界')
    // 而且两份提示词确实不同 —— 否则上面两条可能都被同一段共享文本满足。
    expect(seen[0].prompt).not.toBe(seen[1].prompt)
  })

  it('空名册时那个主模型席位拿到的 seat 是 null,不是崩溃', async () => {
    let got: unknown = 'unset'
    const runAgent = (async () => '```verdict\n{"pass":true,"blocking":[],"comments":""}\n```') as never
    await runRoundtable({
      phase: 'review', node: node(), roles: [], round: 1, system: 's',
      prompt: seat => { got = seat; return 'p' },
      runAgent, signal: new AbortController().signal,
    })
    expect(got).toBeNull()
  })
})

describe('裁决的署名与角色归属', () => {
  const run = (roles: RoleBinding[], reply?: (r: unknown) => Promise<string>) =>
    runRoundtable({
      phase: 'review', node: node(), roles, round: 1, system: 's', prompt: () => 'p',
      runAgent: (reply ?? (async () => '```verdict\n{"pass":false,"blocking":["缺回滚方案"],"comments":""}\n```')) as never,
      signal: new AbortController().signal, answerTag: 'verdict',
    })

  it('主模型兼任的席位署角色名,不是一对空方括号', async () => {
    // `role ? role.roleName : 'main'` 在这个席位上产出空串 —— 席位是个 truthy 对象,
    // 而它的 roleName 是 MAIN_STAFF。blockingSummary 于是成了 `[] 缺回滚方案`,而它
    // 会被原样送进返工提示词,模型收到的字面就是那对空方括号。
    const rec = await run([{ roleName: MAIN_STAFF, roleTag: '架构师' }])
    expect(rec.verdicts[0].role).toBe('架构师')
    expect(rec.synthesized.blockingSummary).toBe('[架构师] 缺回滚方案')
    expect(rec.synthesized.blockingSummary).not.toContain('[]')
  })

  it('有员工时仍然署员工名', async () => {
    const rec = await run([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(rec.verdicts[0].role).toBe('opus-架构')
  })

  it('既无员工也无角色 → main', async () => {
    const rec = await run([{ roleName: MAIN_STAFF }])
    expect(rec.verdicts[0].role).toBe('main')
    expect(rec.synthesized.blockingSummary).toBe('[main] 缺回滚方案')
  })

  it('角色归属落在裁决上,不是只留在内存的名册里', async () => {
    // node.md 存的是 verdicts[]。归属只存在 roster[i] 的话,一次 --resume 之后
    // 「这几条裁决属于同一个角色的几个员工」就无从恢复 —— 而按角色分组正是
    // 「一个角色多员工要收敛成一个结论」的前提。
    const rec = await run([
      { roleName: 'ds-安全', roleTag: '架构师' },
      { roleName: 'ds-安全', roleTag: '安全' },
    ])
    expect(rec.verdicts.map(v => v.roleTag)).toEqual(['架构师', '安全'])
    // 两条裁决的 role 完全相同,所以 roleTag 是唯一能把它们分开的东西。
    expect(rec.verdicts[0].role).toBe(rec.verdicts[1].role)
  })

  it('调用失败的席位同样带上角色归属和一个非空署名', async () => {
    const rec = await run([{ roleName: MAIN_STAFF, roleTag: '架构师' }], async () => { throw new Error('boom') })
    expect(rec.verdicts[0].role).toBe('架构师')
    expect(rec.verdicts[0].roleTag).toBe('架构师')
    expect(rec.verdicts[0].infra).toBe(true)
  })

  it('没有角色标签的席位不会凭空多出一个 roleTag 字段', async () => {
    const rec = await run([{ roleName: 'opus-架构' }])
    expect('roleTag' in rec.verdicts[0]).toBe(false)
  })
})

describe('法定人数(caps.quorum)', () => {
  const v = (role: string, pass: boolean, extra: Partial<Verdict> = {}): Verdict =>
    ({ role, pass, blocking: pass ? [] : ['不行'], comments: '', ...extra })

  it('不传 quorum → 全票,和加这个参数之前逐字节相同', () => {
    expect(synthesizeVerdicts([v('a', true), v('b', false)]).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', true), v('b', true)]).pass).toBe(true)
    expect(synthesizeVerdicts([]).pass).toBe(false)
  })

  it('quorum=100 与不传等价', () => {
    expect(synthesizeVerdicts([v('a', true), v('b', false)], 100).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', true), v('b', true)], 100).pass).toBe(true)
  })

  it('三席里两席赞成:quorum=60 通过,全票不通过', () => {
    // 纯 AND 下加席位只能把通过变成不通过。每席独立 80% 的话,9 席全票通过只有 13%,
    // 三轮用尽约 65% —— 不给这个旋钮,「一个角色多个员工」就是自我拆台。
    const three = [v('a', true), v('b', true), v('c', false)]
    expect(synthesizeVerdicts(three, 60).pass).toBe(true)
    expect(synthesizeVerdicts(three).pass).toBe(false)
  })

  it('刚好卡在门槛上算通过', () => {
    expect(synthesizeVerdicts([v('a', true), v('b', false)], 50).pass).toBe(true)
  })

  it('差一点就不通过', () => {
    expect(synthesizeVerdicts([v('a', true), v('b', false)], 51).pass).toBe(false)
  })

  it('全票档:infra 仍然不通过 —— 否则 isInfraOnlyFailure 的重试永远不会触发', () => {
    // 默认档必须和加 quorum 之前逐字节相同:一席没打通就重试,拿回完整的评审面板。
    const withInfra = [v('a', true), v('b', true), v('c', false, { infra: true })]
    expect(synthesizeVerdicts(withInfra, 100).pass).toBe(false)
    expect(synthesizeVerdicts(withInfra).pass).toBe(false)
  })

  it('放宽档:infra 不进分母 —— 真阻断项按「判决过的席位」来量', () => {
    // 这是放宽 quorum 真正要解决的浪费:混合失败(1 个真阻断 + N 个调用失败)在
    // isInfraOnlyFailure 眼里不算基础设施失败(它要求**所有** failing 都是 infra),
    // 于是被当成真阻断,烧掉一整轮真返工。席位越多,混合概率越高。
    const mixed = [v('a', true), v('b', true), v('c', false), v('d', false, { infra: true })]
    // 判决过的 3 席里 2 席赞成 = 67%。把 infra 算进分母则是 50%,会误判成不通过。
    expect(synthesizeVerdicts(mixed, 60).pass).toBe(true)
    expect(synthesizeVerdicts(mixed, 70).pass).toBe(false)
  })

  it('放宽档下带 infra 通过 = 面板不完整仍然放行,这是选用 quorum<100 的已知代价', () => {
    const withInfra = [v('a', true), v('b', true), v('c', false, { infra: true })]
    expect(synthesizeVerdicts(withInfra, 60).pass).toBe(true)
  })

  it('全是 infra → 不通过(分母为 0),交给重试而不是当成全票通过', () => {
    expect(synthesizeVerdicts([v('a', false, { infra: true })], 60).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', false, { infra: true })], 100).pass).toBe(false)
  })

  it('达到法定人数时,少数派的阻断项照样全部汇总', () => {
    // 没挡住 ≠ 不存在。静默丢弃少数派意见就是「不静默截断」要防的那件事。
    const s = synthesizeVerdicts([v('a', true), v('b', true), v('c', false)], 60)
    expect(s.pass).toBe(true)
    expect(s.blockingSummary).toContain('[c] 不行')
  })

  it('越界的 quorum 被夹住,不会产生「零票也通过」', () => {
    expect(synthesizeVerdicts([v('a', false)], 0).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', false)], -5).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', true)], 999).pass).toBe(true)
  })
})

describe('法定人数一路接到圆桌上', () => {
  // 上面那组直接调 synthesizeVerdicts,证明的是算法;这一组证明 runRoundtable 真的把
  // quorum 传了下去 —— 少了那一跳,配置在 caps 里躺着,圆桌照旧全票。
  const panel = async (quorum?: number) => runRoundtable({
    phase: 'review', node: node(),
    roles: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }],
    round: 1, system: 's', prompt: () => 'p',
    runAgent: (async (req: { role: { roleName: string } }) =>
      req.role.roleName === 'c'
        ? '```verdict\n{"pass":false,"blocking":["不行"],"comments":""}\n```'
        : '```verdict\n{"pass":true,"blocking":[],"comments":""}\n```') as never,
    signal: new AbortController().signal, answerTag: 'verdict', quorum,
  })

  it('三席两赞成:quorum=60 通过', async () => {
    expect((await panel(60)).synthesized.pass).toBe(true)
  })

  it('同一批裁决在默认全票下不通过', async () => {
    expect((await panel()).synthesized.pass).toBe(false)
  })
})

describe('quorumSeats:人数说法有自己的字段', () => {
  const v = (role: string, pass: boolean, extra: Partial<Verdict> = {}): Verdict =>
    ({ role, pass, blocking: pass ? [] : ['不行'], comments: '', ...extra })

  it('「至少 2 席赞成」就是 2 席,不是 2%', () => {
    // 把「至少 2 人」抽成 quorum=2 的含义是 2%,等于 1 票就放行 —— 用户想收紧,实得
    // 几乎没有门槛,而且错在**放宽**方向。
    expect(synthesizeVerdicts([v('a', true), v('b', false), v('c', false)], undefined, 2).pass).toBe(false)
    expect(synthesizeVerdicts([v('a', true), v('b', true), v('c', false)], undefined, 2).pass).toBe(true)
  })

  it('与百分比并用时取更严的那个', () => {
    const four = [v('a', true), v('b', true), v('c', true), v('d', false)]
    // 比例够(75% ≥ 60)但席位不够(3 < 4)→ 不通过。
    expect(synthesizeVerdicts(four, 60, 4).pass).toBe(false)
    // 席位够(3 ≥ 3)但比例不够(75% < 80)→ 不通过。
    expect(synthesizeVerdicts(four, 80, 3).pass).toBe(false)
    expect(synthesizeVerdicts(four, 60, 3).pass).toBe(true)
  })

  it('比例判定用整数乘法 —— 三分之二不该被浮点判负', () => {
    // (2*100)/3 = 66.666… ,和 66 比较时浮点没问题,但乘法形式让「刚好达到」在数学上
    // 可判定,不依赖十进制舍入。
    expect(synthesizeVerdicts([v('a', true), v('b', true), v('c', false)], 66).pass).toBe(true)
    expect(synthesizeVerdicts([v('a', true), v('b', true), v('c', false)], 67).pass).toBe(false)
  })

  it('NaN 退回全票,而不是让一个全票赞成的面板也不通过', () => {
    // Math.round(NaN) 是 NaN,两个比较分支对 NaN 都为假 → 永远过不去的圆桌。
    expect(synthesizeVerdicts([v('a', true), v('b', true)], Number.NaN).pass).toBe(true)
    expect(synthesizeVerdicts([v('a', true), v('b', false)], Number.NaN).pass).toBe(false)
  })

  it('quorumSeats 是 NaN 时不参与判定', () => {
    expect(synthesizeVerdicts([v('a', true), v('b', true)], undefined, Number.NaN).pass).toBe(true)
  })
})
