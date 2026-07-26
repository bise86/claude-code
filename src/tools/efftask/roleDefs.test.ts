import { describe, expect, it } from 'bun:test'
import {
  applyRoleDefsToPhases, applyStaffDeclarations, mergeRoleDefs, parseRoleDefs, roleBriefFor,
  seatsFor, seatSummaryLines,
  type RoleDef,
} from './roleDefs.js'
import { MAIN_STAFF } from './types.js'
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
    expect(notices.join('\n')).toContain('没有写 stage')
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

  it('提示词里的同名角色覆盖产出/作用,员工取并集', () => {
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

describe('seatSummaryLines:一人多席要在关口说清楚', () => {
  it('同一员工占多席时点名', () => {
    const lines = seatSummaryLines([
      { name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['ds-安全'] },
      { name: '安全', stage: 'review', output: 'o', purpose: 'p', staff: ['ds-安全'] },
    ])
    expect(lines.join('\n')).toContain('ds-安全 占 2 席')
    expect(lines.join('\n')).toContain('架构师')
    expect(lines.join('\n')).toContain('安全')
  })

  it('各就各位时不说废话', () => {
    expect(seatSummaryLines([
      { name: '架构师', stage: 'review', output: 'o', purpose: 'p', staff: ['a'] },
      { name: '安全', stage: 'review', output: 'o', purpose: 'p', staff: ['b'] },
    ])).toEqual([])
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
