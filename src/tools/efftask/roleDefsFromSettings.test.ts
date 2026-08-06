import { describe, expect, it } from 'bun:test'
import { collectRoleDefs, collectSkipSteps, mergeSkipSteps } from './roleDefsFromSettings.js'

const KNOWN = new Set(['opus-架构', 'ds-安全', 'gpt-前端'])
const arch = { name: '架构师', stage: 'review', output: '裁决与阻断项', purpose: '把关可维护性' }

const collect = (
  bySource: Partial<Record<'userSettings' | 'projectSettings' | 'localSettings', unknown>>,
  extra?: { unsupportedStaff?: Set<string> },
) => collectRoleDefs({
  knownStaff: KNOWN, ...extra,
  read: s => bySource[s] as { efftaskRoles?: unknown; roles?: unknown } | undefined,
})

describe('collectRoleDefs:配置文件里能配角色', () => {
  it('用户配置里的角色被读出来', () => {
    const { defs, notices } = collect({ userSettings: { efftaskRoles: [{ ...arch, staff: ['opus-架构'] }] } })
    expect(defs).toEqual([{ ...arch, stage: 'review', staff: ['opus-架构'] }])
    expect(notices).toEqual([])
  })

  it('项目配置覆盖用户配置的产出/作用,员工取并集', () => {
    const { defs } = collect({
      userSettings: { efftaskRoles: [{ ...arch, staff: ['opus-架构'] }] },
      projectSettings: { efftaskRoles: [{ ...arch, purpose: '项目自己的说法', staff: ['ds-安全'] }] },
    })
    expect(defs).toHaveLength(1)
    expect(defs[0].purpose).toBe('项目自己的说法')
    expect(defs[0].staff).toEqual(['opus-架构', 'ds-安全'])
  })

  it('三份配置都没有 → 空,而且不报噪音', () => {
    expect(collect({})).toEqual({ defs: [], notices: [] })
  })

  it('一份 settings 读不出来 → 说出来,而不是当作空的', () => {
    const { defs, notices } = collectRoleDefs({
      knownStaff: KNOWN,
      read: s => {
        if (s === 'projectSettings') throw new Error('EACCES')
        return { efftaskRoles: [{ ...arch, staff: ['opus-架构'] }] }
      },
    })
    expect(defs).toHaveLength(1)
    expect(notices.join('\n')).toContain('项目配置')
    expect(notices.join('\n')).toContain('未生效')
  })

  it('配置里写错的角色被逐条剔除并说明,不拖垮同一份里的好角色', () => {
    const { defs, notices } = collect({
      userSettings: { efftaskRoles: [{ name: '半成品', stage: 'review' }, { ...arch, staff: ['opus-架构'] }] },
    })
    expect(defs.map(d => d.name)).toEqual(['架构师'])
    expect(notices.join('\n')).toContain('半成品')
    // 来源标签也要钉住:三份 settings 都可能出问题,只说「角色定义有误」用户不知道
    // 该去改哪个文件。
    expect(notices.join('\n')).toContain('用户配置')
  })
})

describe('collectRoleDefs:员工侧也能声明自己担任哪些角色', () => {
  it('员工的 efftaskRoles 把自己加进那个角色', () => {
    const { defs } = collect({
      userSettings: {
        efftaskRoles: [{ ...arch, staff: ['opus-架构'] }],
        roles: [{ name: 'ds-安全', efftaskRoles: ['架构师'] }],
      },
    })
    expect(defs[0].staff).toEqual(['opus-架构', 'ds-安全'])
  })

  it('员工声明的角色没人定义过 → 忽略并说明,不造一个没有职责的角色', () => {
    const { defs, notices } = collect({
      userSettings: {
        efftaskRoles: [{ ...arch, staff: ['opus-架构'] }],
        roles: [{ name: 'ds-安全', efftaskRoles: ['不存在的角色'] }],
      },
    })
    expect(defs[0].staff).toEqual(['opus-架构'])
    expect(notices.join('\n')).toContain('不存在的角色')
  })

  it('声明者本身不是一个可派发的员工 → 不加进去', () => {
    // parseRoles 已经因为别的原因跳过了这条员工(比如 api 模式缺 apiToken)。把它加进
    // 角色里会让关口显示一个永远派发不出去的名字。
    const { defs } = collect({
      userSettings: {
        efftaskRoles: [{ ...arch, staff: ['opus-架构'] }],
        roles: [{ name: '没被收下的员工', efftaskRoles: ['架构师'] }],
      },
    })
    expect(defs[0].staff).toEqual(['opus-架构'])
  })

  it('跨来源:角色定义在用户配置,员工声明在项目配置', () => {
    const { defs } = collect({
      userSettings: { efftaskRoles: [{ ...arch, staff: [] }] },
      projectSettings: { roles: [{ name: 'gpt-前端', efftaskRoles: ['架构师'] }] },
    })
    expect(defs[0].staff).toEqual(['gpt-前端'])
  })

  it('CLI 模式的员工在角色侧被剔除,员工侧不能绕过这一条', () => {
    // 两条录入路径必须同样受约束,否则「换个地方写」就成了绕开校验的后门。
    const viaRole = collect(
      { userSettings: { efftaskRoles: [{ ...arch, staff: ['ds-安全'] }] } },
      { unsupportedStaff: new Set(['ds-安全']) },
    )
    expect(viaRole.defs[0].staff).toEqual([])
    expect(viaRole.notices.join('\n')).toContain('CLI 模式')

    // 员工侧那道门实测**曾经**能绕过去:ds-安全 会被排上席位,而 P1 派发不了它。
    const viaStaff = collect(
      {
        userSettings: {
          efftaskRoles: [{ ...arch, staff: ['opus-架构'] }],
          roles: [{ name: 'ds-安全', efftaskRoles: ['架构师'] }],
        },
      },
      { unsupportedStaff: new Set(['ds-安全']) },
    )
    expect(viaStaff.defs[0].staff).toEqual(['opus-架构'])
    expect(viaStaff.notices.join('\n')).toContain('CLI 模式')
  })
})

describe('collectSkipSteps:配置文件里指定跳过的环节', () => {
  const C = (bySource: Record<string, unknown>) =>
    collectSkipSteps({ read: s => bySource[s] as { efftaskSkipSteps?: unknown } | undefined })

  it('中文环节名归一到内部名', () => {
    expect(C({ userSettings: { efftaskSkipSteps: ['质疑修复', '观察'] } }).steps).toEqual(['review', 'observer'])
  })

  it('英文内部名也收', () => {
    expect(C({ userSettings: { efftaskSkipSteps: ['review', 'verify'] } }).steps).toEqual(['review', 'verify'])
  })

  it('跨来源合并且去重', () => {
    const r = C({ userSettings: { efftaskSkipSteps: ['质疑修复'] }, projectSettings: { efftaskSkipSteps: ['质疑修复', '验收'] } })
    expect(r.steps).toEqual(['review', 'accept'])
  })

  it('写错的环节名 → 说清它会照常运行,并猜一个', () => {
    // 静默忽略最糟:用户以为跳过了,系统照跑,他为此付了钱还不知道。
    const n = C({ userSettings: { efftaskSkipSteps: ['测试'] } }).notices.join('\n')
    expect(n).toContain('该环节会照常运行')
    expect(n).toContain('是不是想写「测试修复」')
  })

  it('不是数组 → 说明,而不是让整份配置作废', () => {
    const r = C({ userSettings: { efftaskSkipSteps: '质疑修复' } })
    expect(r.steps).toEqual([])
    expect(r.notices.join('')).toContain('不是数组')
  })

  it('没配 → 空,不报噪音', () => {
    expect(C({})).toEqual({ steps: [], notices: [] })
  })
})

describe('mergeSkipSteps:两条录入口取并集', () => {
  // README 和 roles-setup 的头条语义,此前零测试 —— 把并集改成覆盖,全量一条不红。
  it('配置文件说的和提示词说的都生效', () => {
    expect(mergeSkipSteps(['review'], ['accept'])).toEqual(['review', 'accept'])
  })
  it('**不是覆盖** —— 提示词说了不代表配置文件那条作废', () => {
    const out = mergeSkipSteps(['review'], ['accept'])!
    expect(`配置文件那条还在: ${out.includes('review')}`).toBe('配置文件那条还在: true')
  })
  it('重合的只算一次', () => {
    expect(mergeSkipSteps(['review', 'accept'], ['accept'])).toEqual(['review', 'accept'])
  })
  it('提示词没说时,配置文件那条照样生效', () => {
    expect(mergeSkipSteps(['review'], undefined)).toEqual(['review'])
  })
  it('两边都空 → undefined,不是空数组', () => {
    // 下游用 `?? []` 判缺省;空数组会让「没说过跳过」和「说了但一个都不合法」在
    // run.md 上长得不一样,而它们该是同一件事。
    expect(mergeSkipSteps([], undefined)).toBeUndefined()
    expect(mergeSkipSteps([], [])).toBeUndefined()
  })
})
