import { describe, expect, it } from 'bun:test'
import {
  allowsMultipleSeats, applyRoleDefsToPhases, applyStaffDeclarations, mergeRoleDefs,
  MULTI_SEAT_PHASES, parseRoleDefs, PHASE_SEATING, roleBriefFor,
  seatsFor,
  type RoleDef,
} from './roleDefs.js'
import { MAIN_STAFF, PHASE_LABEL, PHASE_NAMES } from './types.js'
import type { RoleBinding } from './types.js'

const KNOWN = new Set(['opus-架构', 'ds-安全', 'gpt-前端'])
const P = (raw: unknown, extra?: { unsupportedStaff?: Set<string> }) =>
  parseRoleDefs(raw, { knownStaff: KNOWN, source: '配置文件', ...extra })

const full = (o: Partial<RoleDef> & { name: string }) => ({
  stage: 'review', output: '裁决与阻断项', purpose: '把关可维护性', ...o,
})

describe('parseRoleDefs:「必须描述清楚」是强制的', () => {
  it('四项齐全 → 生效', () => {
    const { defs, notices } = P([full({ name: '架构师', staff: ['opus-架构'] })])
    expect(defs).toEqual([{ name: '架构师', stage: 'review', output: '裁决与阻断项', purpose: '把关可维护性', staff: ['opus-架构'] }])
    expect(notices).toEqual([])
  })

  it.each([
    ['output', { output: '' }, 'output(产出什么)'],
    ['purpose', { purpose: '' }, 'purpose(起什么作用)'],
  ])('缺 %s → 不生效,并说明为什么', (_label, patch, want) => {
    const { defs, notices } = P([full({ name: '架构师', ...patch })])
    expect(defs).toEqual([])
    expect(notices.join('\n')).toContain(want)
    expect(notices.join('\n')).toContain('该角色不生效')
  })

  it('缺 stage → 不生效', () => {
    const { defs, notices } = P([{ name: '架构师', output: 'o', purpose: 'p' }])
    expect(defs).toEqual([])
    expect(notices.join('\n')).toContain('没有写 step')
  })

  it('自由阶段名 → 不生效,而不是配置得进去永远不跑', () => {
    // 自由阶段名不是「不执行」那么轻:resumeCore / startupConfirm 都用
    // Object.fromEntries(PHASE_NAMES.map(…)) 重建 phaseRoles,未知键第一次 --resume 就没了;
    // 而 makeRunAgentFn 按 phase === 'execute' 决定给不给写工具,自由阶段永远只有只读工具。
    const { defs, notices } = P([full({ name: '安全审计员', stage: '安全审计' as never })])
    expect(defs).toEqual([])
    expect(notices.join('\n')).toContain('安全审计')
    expect(notices.join('\n')).toContain('不生效')
  })

  it('没写 staff → 主模型兼任,不报错也不静默丢角色', () => {
    const { defs, notices } = P([full({ name: '架构师' })])
    expect(defs[0].staff).toEqual([])
    expect(notices).toEqual([])
  })

  it('写了 staff 但一个都找不到 ≠ 没写 staff —— 必须说出来', () => {
    // 两种情形最终都由主模型跑,但前者是用户的意图没被满足。默默当成「没指定」,
    // 关口就会显示一份和用户所写不同的名册 —— 关口撒谎是这个功能最不能出的错。
    const { defs, notices } = P([full({ name: '架构师', staff: ['不存在的员工'] })])
    expect(defs[0].staff).toEqual([])
    expect(notices.join('\n')).toContain('找不到员工 不存在的员工')
    expect(notices.join('\n')).toContain('改由主模型兼任')
  })

  it('部分员工找不到 → 剩下的仍然担当,措辞不能说成回落主模型', () => {
    const { defs, notices } = P([full({ name: '架构师', staff: ['opus-架构', '幽灵'] })])
    expect(defs[0].staff).toEqual(['opus-架构'])
    expect(notices.join('\n')).toContain('仍由 opus-架构 担当')
    expect(notices.join('\n')).not.toContain('改由主模型兼任')
  })

  it('CLI 模式的员工被剔除并说明', () => {
    const { defs, notices } = P(
      [full({ name: '架构师', staff: ['opus-架构', 'ds-安全'] })],
      { unsupportedStaff: new Set(['ds-安全']) },
    )
    expect(defs[0].staff).toEqual(['opus-架构'])
    expect(notices.join('\n')).toContain('CLI 模式')
  })

  it('同阶段重名 → 只留一份,不静默占两席', () => {
    const { defs, notices } = P([
      full({ name: '架构师', staff: ['opus-架构'] }),
      full({ name: '架构师', staff: ['ds-安全'] }),
    ])
    expect(defs).toHaveLength(1)
    expect(defs[0].staff).toEqual(['ds-安全'])
    expect(notices.join('\n')).toContain('采用后一份定义')
  })

  it('同名但不同阶段 → 两个角色,互不影响', () => {
    const { defs } = P([
      full({ name: '架构师', stage: 'review', staff: ['opus-架构'] }),
      full({ name: '架构师', stage: 'accept', staff: ['ds-安全'] }),
    ])
    expect(defs).toHaveLength(2)
  })

  it('不是数组 → 全忽略并说明', () => {
    expect(P({ name: 'x' }).notices.join('\n')).toContain('不是数组')
  })
})

describe('seatsFor:(角色 × 员工) 展平', () => {
  const defs: RoleDef[] = [
    { name: '架构师', stage: 'review', output: 'o1', purpose: 'p1', staff: ['opus-架构', 'ds-安全'] },
    { name: '安全', stage: 'review', output: 'o2', purpose: 'p2', staff: ['ds-安全'] },
    { name: '验收官', stage: 'accept', output: 'o3', purpose: 'p3', staff: [] },
  ]

  it('一个角色多个员工 → 多席,每席带角色标签', () => {
    expect(seatsFor(defs, 'review')).toEqual([
      { roleName: 'opus-架构', roleTag: '架构师' },
      { roleName: 'ds-安全', roleTag: '架构师' },
      { roleName: 'ds-安全', roleTag: '安全' },
    ])
  })

  it('去重键是 (角色, 员工) 而不是员工 —— 同一员工兼两角占两席', () => {
    // 只按员工名去重的话 ds-安全 会被吞掉一席,而它在两个角色里拿到的是两份不同的
    // 职责简报,应当分别作答。
    const seats = seatsFor(defs, 'review')
    expect(seats.filter(s => s.roleName === 'ds-安全')).toHaveLength(2)
    expect(seats.filter(s => s.roleName === 'ds-安全').map(s => s.roleTag)).toEqual(['架构师', '安全'])
  })

  it('同一角色里重复写同一个员工 → 一席', () => {
    const dup: RoleDef[] = [{ name: 'r', stage: 'review', output: 'o', purpose: 'p', staff: ['a', 'a'] }]
    expect(seatsFor(dup, 'review')).toHaveLength(1)
  })

  it('没指定员工 → 一席主模型;roleName 是空串而不是角色名', () => {
    // 往 roleName 里写角色名会让 pickAgentDefinition 找不到 → 回落主模型,而
    // effectiveModel 也回落主模型,于是关口渲染出「验收官(主模型)」—— 看起来是绑好的
    // 员工,实际是主模型披了个名字。空串是唯一诚实的表示。
    const seats = seatsFor(defs, 'accept')
    expect(seats).toEqual([{ roleName: MAIN_STAFF, roleTag: '验收官' }])
    expect(seats[0].roleName).not.toBe('验收官')
  })

  it('别的阶段的角色不会串台', () => {
    expect(seatsFor(defs, 'execute')).toEqual([])
    expect(seatsFor(defs, 'plan')).toEqual([])
  })
})

describe('roleBriefFor:职责说明到达模型的那一段', () => {
  const defs: RoleDef[] = [
    { name: '架构师', stage: 'review', output: '通过/阻断裁决与具体阻断项', purpose: '把关可维护性与回滚路径', staff: ['opus-架构'] },
  ]

  it('带 roleTag 的席位拿到自己的产出与作用', () => {
    const brief = roleBriefFor(defs, { roleName: 'opus-架构', roleTag: '架构师' }, 'review')
    expect(brief).toContain('把关可维护性与回滚路径')
    expect(brief).toContain('通过/阻断裁决与具体阻断项')
    expect(brief).toContain('opus-架构')
  })

  it('主模型兼任的席位说「主模型兼任」,不说一个空员工名', () => {
    const brief = roleBriefFor(defs, { roleName: MAIN_STAFF, roleTag: '架构师' }, 'review')
    expect(brief).toContain('主模型兼任')
    expect(brief).toContain('把关可维护性与回滚路径')
  })

  it('没有 roleTag(关口上手勾的员工、老 run.md)→ 空串,退回今天的提示词', () => {
    expect(roleBriefFor(defs, { roleName: 'opus-架构' }, 'review')).toBe('')
    expect(roleBriefFor(defs, null, 'review')).toBe('')
  })

  it('阶段对不上 → 空串,不会把评审角色的简报发给验收席位', () => {
    expect(roleBriefFor(defs, { roleName: 'opus-架构', roleTag: '架构师' }, 'accept')).toBe('')
  })
})

describe('mergeRoleDefs / applyStaffDeclarations:双向配置', () => {
  const base: RoleDef[] = [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构'] }]

  it('默认(配置文件内部)员工取并集 —— 角色侧与员工侧是同一层的两个方向', () => {
    const { defs, notices } = mergeRoleDefs(base, [
      { name: '架构师', stage: 'review', output: '新产出', purpose: '新作用', staff: ['ds-安全'] },
    ])
    expect(defs).toHaveLength(1)
    expect(defs[0].output).toBe('新产出')
    expect(defs[0].staff).toEqual(['opus-架构', 'ds-安全'])
    expect(notices.join('\n')).toContain('由两处共同指定')
  })

  it('提示词新增的角色被追加', () => {
    const { defs } = mergeRoleDefs(base, [{ name: '性能', stage: 'review', output: 'o', purpose: 'p', staff: [] }])
    expect(defs.map(d => d.name)).toEqual(['架构师', '性能'])
  })

  it('不改动传入的 base(它是 React state)', () => {
    mergeRoleDefs(base, [{ name: '架构师', stage: 'review', output: 'x', purpose: 'y', staff: ['ds-安全'] }])
    expect(base[0].staff).toEqual(['opus-架构'])
    expect(base[0].output).toBe('o')
  })

  it('员工侧声明「我能当架构师」→ 加进那个角色', () => {
    const { defs, notices } = applyStaffDeclarations(base, [{ staff: 'ds-安全', roles: ['架构师'] }])
    expect(defs[0].staff).toEqual(['opus-架构', 'ds-安全'])
    expect(notices).toEqual([])
  })

  it('员工声明一个没人定义过的角色 → 忽略并说明,不凭空造一个没有职责的角色', () => {
    // 员工侧只知道角色名,不知道阶段/产出/作用。凭空造出来的角色三项皆空,而三项皆空
    // 正是上面判定「不生效」的条件 —— 造它出来只会让关口多一行永远不跑的名字。
    const { defs, notices } = applyStaffDeclarations(base, [{ staff: 'ds-安全', roles: ['不存在的角色'] }])
    expect(defs).toEqual(base)
    expect(notices.join('\n')).toContain('不存在的角色')
    expect(notices.join('\n')).toContain('已忽略')
  })

  it('重复声明不会让同一个员工在一个角色里占两席', () => {
    const { defs } = applyStaffDeclarations(base, [{ staff: 'opus-架构', roles: ['架构师'] }])
    expect(defs[0].staff).toEqual(['opus-架构'])
  })
})


describe('applyRoleDefsToPhases:配置了角色 → 真的会被派发', () => {
  const defs: RoleDef[] = [
    { name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构'] },
    { name: '验收官', stage: 'accept', output: 'o', purpose: 'p', staff: [] },
  ]
  const empty = (): Record<string, RoleBinding[]> =>
    ({ plan: [], review: [], execute: [], accept: [], observer: [] })

  it('角色的席位进了对应阶段的名册', () => {
    const { phaseRoles } = applyRoleDefsToPhases(empty() as never, defs)
    expect(phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(phaseRoles.accept).toEqual([{ roleName: MAIN_STAFF, roleTag: '验收官' }])
    expect(phaseRoles.execute).toEqual([])
  })

  it('按名字直接指定的员工保留,和角色席位共存', () => {
    const base = { ...empty(), review: [{ roleName: 'gpt-前端' }] }
    const { phaseRoles } = applyRoleDefsToPhases(base as never, defs)
    expect(phaseRoles.review).toEqual([
      { roleName: 'gpt-前端' },
      { roleName: 'opus-架构', roleTag: '架构师' },
    ])
  })

  it('同一员工两边都写 → 只留带角色标签的那席,并说明', () => {
    // 留两席等于给同一个员工两票(全票门槛下直接抬高了阻断率),而关口上会出现两个
    // 一模一样的名字 —— 用户没法分辨那是配置生效了还是一个 bug。
    const base = { ...empty(), review: [{ roleName: 'opus-架构' }] }
    const { phaseRoles, notices } = applyRoleDefsToPhases(base as never, defs)
    expect(phaseRoles.review).toEqual([{ roleName: 'opus-架构', roleTag: '架构师' }])
    expect(notices.join('\n')).toContain('不再额外占一席')
  })

  it('同一员工担两角 → 两席都留下,这不是重复', () => {
    const two: RoleDef[] = [
      { name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构'] },
      { name: '安全', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构'] },
    ]
    const { phaseRoles } = applyRoleDefsToPhases(empty() as never, two)
    expect(phaseRoles.review).toHaveLength(2)
    expect(phaseRoles.review.map(s => s.roleTag)).toEqual(['架构师', '安全'])
  })

  it('没有角色定义 → 名册原样不动', () => {
    const base = { ...empty(), review: [{ roleName: 'gpt-前端' }] }
    const { phaseRoles, notices } = applyRoleDefsToPhases(base as never, [])
    expect(phaseRoles.review).toEqual([{ roleName: 'gpt-前端' }])
    expect(notices).toEqual([])
  })
})

describe('单席位阶段:名册上不能出现永远不跑的名字', () => {
  // pipeline 用 firstRole() 取第 [0] 席,plan/execute/observer 多出来的席位一次都不会被
  // 派发。按名字直接指定那条路径(parseDirectives)一直有这道裁剪 + 提醒;角色定义这条
  // 新入口曾经完全没有,于是关口列出两个执行者、只跑一个、零提示。
  const empty = (): Record<string, RoleBinding[]> =>
    ({ plan: [], review: [], execute: [], accept: [], observer: [] })
  const role = (name: string, stage: string, staff: string[]): RoleDef =>
    ({ name, stage, output: 'o', purpose: 'p', staff }) as RoleDef

  it.each(['execute'])('%s:一个角色两个员工 → 一席,并点名被忽略的是谁', stage => {
    const { phaseRoles, notices } = applyRoleDefsToPhases(
      empty() as never, [role('主设计', stage, ['opus-架构', 'ds-安全'])],
    )
    expect(phaseRoles[stage as 'plan']).toHaveLength(1)
    expect(phaseRoles[stage as 'plan'][0].roleName).toBe('opus-架构')
    const joined = notices.join('\n')
    expect(joined).toContain('仅 主设计(opus-架构) 生效')
    expect(joined).toContain('已忽略 主设计(ds-安全)')
  })

  it.each(['execute'])('%s:同阶段两个角色 → 一席,点名被忽略的那个角色', stage => {
    const { phaseRoles, notices } = applyRoleDefsToPhases(
      empty() as never, [role('前端实现', stage, ['gpt-前端']), role('后端实现', stage, ['opus-架构'])],
    )
    expect(phaseRoles[stage as 'plan']).toHaveLength(1)
    expect(notices.join('\n')).toContain('已忽略 后端实现(opus-架构)')
  })

  it.each(['review', 'accept', 'verify', 'integrate', 'observer'])('%s 是圆桌阶段,多席位不能被误伤', stage => {
    const { phaseRoles, notices } = applyRoleDefsToPhases(
      empty() as never, [role('架构师', stage, ['opus-架构', 'ds-安全'])],
    )
    expect(phaseRoles[stage as 'review']).toHaveLength(2)
    expect(notices.join('\n')).not.toContain('仅')
  })

  it('单席位阶段:角色席位赢过按名字直接指定的员工', () => {
    // 评审实测的那个「复现 C」:角色席位被追加在后面 → 第 [0] 席是按名字点的那个 →
    // 角色整体死掉,而真正跑的那一席连职责简报都没有。这个组合完全普通,不需要多员工。
    const base = { ...empty(), execute: [{ roleName: 'gpt-前端' }] }
    const { phaseRoles, notices } = applyRoleDefsToPhases(base as never, [role('写手', 'execute', ['opus-架构'])])
    expect(phaseRoles.execute).toEqual([{ roleName: 'opus-架构', roleTag: '写手' }])
    expect(notices.join('\n')).toContain('已忽略 gpt-前端')
  })

  it('圆桌阶段不重排 —— 按名字指定的员工仍在前面', () => {
    const base = { ...empty(), review: [{ roleName: 'gpt-前端' }] }
    const { phaseRoles } = applyRoleDefsToPhases(base as never, [role('架构师', 'review', ['opus-架构'])])
    expect(phaseRoles.review.map(s => s.roleName)).toEqual(['gpt-前端', 'opus-架构'])
  })

  it('主模型兼任的席位被忽略时也称呼得出来', () => {
    const { notices } = applyRoleDefsToPhases(
      empty() as never, [role('甲', 'execute', ['opus-架构']), role('乙', 'execute', [])],
    )
    expect(notices.join('\n')).toContain('已忽略 乙(主模型)')
  })

  it('正好一席时不说废话', () => {
    const { notices } = applyRoleDefsToPhases(empty() as never, [role('写手', 'execute', ['opus-架构'])])
    expect(notices).toEqual([])
  })

  it('plan 不在裁剪之列 —— 它走顺序精化,多员工是支持的形态', () => {
    // 第一位起草,后面每一位在前一稿上修订,全程只有一份稿子,「只有一个产出」成立。
    const { phaseRoles, notices } = applyRoleDefsToPhases(
      empty() as never, [role('主设计', 'plan', ['opus-架构', 'ds-安全'])])
    expect(phaseRoles.plan).toHaveLength(2)
    expect(notices).toEqual([])
  })
})

describe('mergeRoleDefs 的替换语义(提示词覆盖配置文件那一跳)', () => {
  const base: RoleDef[] = [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构', 'gpt-前端'] }]

  it('overlay 写了 staff → 换掉,并说明换前换后', () => {
    const { defs, notices } = mergeRoleDefs(
      base, [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['ds-安全'] }], true)
    expect(defs[0].staff).toEqual(['ds-安全'])
    expect(notices.join('\n')).toContain('已按提示词改为 ds-安全')
    expect(notices.join('\n')).toContain('原为 opus-架构、gpt-前端')
  })

  it('overlay 没写 staff → 沿用,不清空', () => {
    // 只想改产出/作用的时候不该顺手把人清空 —— 那是一次用户没要求的静默降级。
    const { defs, notices } = mergeRoleDefs(
      base, [{ name: '架构师', stage: 'review', output: '新产出', purpose: 'p', staff: [] }], true)
    expect(defs[0].staff).toEqual(['opus-架构', 'gpt-前端'])
    expect(defs[0].output).toBe('新产出')
    expect(notices).toEqual([])
  })

  it('替换成同一批人 → 不说废话', () => {
    const { notices } = mergeRoleDefs(
      base, [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['opus-架构', 'gpt-前端'] }], true)
    expect(notices).toEqual([])
  })

  it('不开替换时仍是并集 —— 配置文件内部两个方向的写法都算数', () => {
    const { defs } = mergeRoleDefs(
      base, [{ name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['ds-安全'] }])
    expect(defs[0].staff).toEqual(['opus-架构', 'gpt-前端', 'ds-安全'])
  })
})

describe('席位上限(caps.maxSeatsPerPhase)', () => {
  const empty = (): Record<string, RoleBinding[]> =>
    ({ plan: [], review: [], execute: [], accept: [], observer: [] })
  const many = (n: number): RoleDef[] =>
    [{ name: '评审团', stage: 'review', output: 'o', purpose: 'p', staff: Array.from({ length: n }, (_, i) => `s${i}`) }] as RoleDef[]

  it('默认上限 5', () => {
    const { phaseRoles, notices } = applyRoleDefsToPhases(empty() as never, many(8))
    expect(phaseRoles.review).toHaveLength(5)
    expect(notices.join('\n')).toContain('席位上限 5')
  })

  it('剔除的席位被点名,不是静默截断', () => {
    // 静默截断会让关口显示的名册和真正跑的不一致 —— 而关口存在的意义就是别撒谎。
    const { notices } = applyRoleDefsToPhases(empty() as never, many(7), 5)
    expect(notices.join('\n')).toContain('评审团(s5)')
    expect(notices.join('\n')).toContain('评审团(s6)')
    // 关口不能指向一个用户找不到的地方:settings.json 里根本没有 caps 这个键。
    expect(notices.join('\n')).toContain('在任务提示词里说明')
  })

  it('自定义上限生效', () => {
    expect(applyRoleDefsToPhases(empty() as never, many(8), 2).phaseRoles.review).toHaveLength(2)
  })

  it('没超上限时不说废话', () => {
    expect(applyRoleDefsToPhases(empty() as never, many(3), 5).notices).toEqual([])
  })

  it('上限 0 被夹到 1 —— 不能把一个阶段清空成没人跑', () => {
    expect(applyRoleDefsToPhases(empty() as never, many(3), 0).phaseRoles.review).toHaveLength(1)
  })

  it('单席位阶段不会为同一件事报两遍', () => {
    const defs = [{ name: '写手', stage: 'execute', output: 'o', purpose: 'p', staff: ['a', 'b', 'c'] }] as RoleDef[]
    const { phaseRoles, notices } = applyRoleDefsToPhases(empty() as never, defs, 5)
    expect(phaseRoles.execute).toHaveLength(1)
    expect(notices.filter(n => n.includes('已忽略'))).toHaveLength(1)
    expect(notices.join('\n')).not.toContain('席位上限')
  })
})

describe('环节名可以写中文,写错了要能自己改对', () => {
  const K = new Set(['opus-架构'])
  const P2 = (raw: unknown) => parseRoleDefs(raw, { knownStaff: K, source: '配置文件' })
  const def = (o: object) => ({ name: '架构师', output: 'o', purpose: 'p', staff: ['opus-架构'], ...o })

  it('中文环节名归一到内部 phase 名 —— 落盘只有一种写法', () => {
    // 两边都当 canonical 会让 run.md 里出现两种写法,而读回那侧(resumeCore)只认一种。
    expect(P2([def({ step: '质疑修复' })]).defs[0].stage).toBe('review')
    expect(P2([def({ step: '测试修复' })]).defs[0].stage).toBe('verify')
    expect(P2([def({ step: '集成验收' })]).defs[0].stage).toBe('integrate')
    expect(P2([def({ step: '分析' })]).defs[0].stage).toBe('plan')
  })

  it('内部 phase 名照旧收下', () => {
    expect(P2([def({ step: 'review' })]).defs[0].stage).toBe('review')
  })

  it('旧键名 stage 仍然读得进来 —— 老 run.md 和已发布的文档不能一夜作废', () => {
    expect(P2([def({ stage: 'review' })]).defs[0].stage).toBe('review')
    expect(P2([def({ stage: '评审' })]).defs[0].stage).toBe('review')
  })

  it('step 优先于 stage', () => {
    expect(P2([def({ step: '验收', stage: 'review' })]).defs[0].stage).toBe('accept')
  })

  it('写错时列**中文**合法值 —— 列内部名等于让用户自己做中英对照', () => {
    const n = P2([def({ step: '测试' })]).notices.join('\n')
    expect(n).toContain('分析/质疑修复/执行/测试修复/验收/集成验收/观察')
    expect(n).not.toContain('plan/review/execute')
  })

  it('并且猜一个最接近的', () => {
    expect(P2([def({ step: '测试' })]).notices.join('\n')).toContain('是不是想写「测试修复」')
    expect(P2([def({ step: '集成' })]).notices.join('\n')).toContain('是不是想写「集成验收」')
  })

  it('猜不出来就不猜 —— 一个猜错的建议比没有建议更糟', () => {
    const n = P2([def({ step: '安全审计' })]).notices.join('\n')
    expect(n).toContain('不生效')
    expect(n).not.toContain('是不是想写')
  })

  it('错误信息不超过关口的截断长度,否则结论会被截掉', () => {
    // notices 在关口上走 clip(n, 100)。超了会把句尾的「该角色不生效」截没,
    // 只剩一串合法值 —— 结论没了。
    for (const bad of ['测试', '安全审计', 'reviews']) {
      const line = P2([def({ step: bad })]).notices[0]
      expect(`${bad}:${[...line].length <= 100}`).toBe(`${bad}:true`)
    }
  })
})

describe('席位规则那份唯一真相要被直接钉住', () => {
  // 上面那条参数化的「%s 是圆桌阶段,多席位不能被误伤」**杀不掉** PHASE_SEATING 的变异:
  // 裁剪到一席需要 allowsMultipleSeats(p) 为假**且** SINGLE_SEAT_REASON[p] 有值,而后者
  // 只剩 execute。于是 verify/integrate 的 toHaveLength(2) 是被「没有裁剪理由」满足的,
  // 和 PHASE_SEATING 的取值毫无关系 —— 实测把它们双双改成 'single',整套测试全绿。
  // 而关口的 (单选) 标记与 toggleRole 的替换语义都走 allowsMultipleSeats。
  it('每个环节的容纳方式是明确写死的', () => {
    expect(PHASE_SEATING).toEqual({
      plan: 'sequential', review: 'roundtable', execute: 'single',
      verify: 'roundtable', accept: 'roundtable', integrate: 'roundtable',
      observer: 'roundtable',
    })
  })

  it('只有执行不允许多席位', () => {
    for (const p of PHASE_NAMES) {
      expect(`${p}:${allowsMultipleSeats(p)}`).toBe(`${p}:${p !== 'execute'}`)
    }
  })

  it('圆桌集合就是那五个 —— 顺序精化不算圆桌', () => {
    expect([...MULTI_SEAT_PHASES].sort()).toEqual(['accept', 'integrate', 'observer', 'review', 'verify'])
  })
})

describe('环节改名之后,旧名不能一夜作废', () => {
  const K = new Set(['a'])
  const P = (step: string) => parseRoleDefs(
    [{ name: 'r', step, output: 'o', purpose: 'p', staff: ['a'] }], { knownStaff: K, source: 'doc' })

  it('「集成提交」是旧名,仍然收下并归一到 integrate', () => {
    // 改名的理由是它不做任何合并 —— 合并早在每个执行型子节点自己通过验收时就发生了,
    // 这一关判的是「子任务的结果合起来达没达成父目标」。但已经按旧名写过配置的人
    // 不该因为一次改名就全部失效。
    expect(P('集成提交').defs[0].stage).toBe('integrate')
    expect(P('集成提交').notices).toEqual([])
  })

  it('新名是「集成验收」', () => {
    expect(P('集成验收').defs[0].stage).toBe('integrate')
    expect(PHASE_LABEL.integrate).toBe('集成验收')
  })

  it('关口和错误信息用的是新名', () => {
    // 旧名只是入口别名,不该再出现在给用户看的文案里 —— 否则用户会以为有两个环节。
    expect(P('不存在的环节').notices.join()).toContain('集成验收')
    expect(P('不存在的环节').notices.join()).not.toContain('集成提交')
  })
})
