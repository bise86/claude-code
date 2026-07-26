// src/tools/efftask/roleDefsFromSettings.ts
//
// 配置文件那一层:从 settings.json 读出角色定义(角色侧)和员工的角色声明(员工侧)。
//
// 和 roleDefs.ts 分开,是因为那个文件是纯函数、不碰任何全局状态,整套解析/合并/展平逻辑
// 都能不搭环境地测。这里只做「去哪儿拿原始数据」。
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { applyStaffDeclarations, mergeRoleDefs, parseRoleDefs, type RoleDef } from './roleDefs.js'

/** 和 collectRoleAgents 用同一组来源、同一个优先级顺序。 */
const SOURCES = ['userSettings', 'projectSettings', 'localSettings'] as const
const SOURCE_LABEL: Record<(typeof SOURCES)[number], string> = {
  userSettings: '用户配置', projectSettings: '项目配置', localSettings: '本地配置',
}

/**
 * settings.json 里配置的角色 + 员工侧声明,合并成一份角色定义。
 *
 * 后一个来源覆盖前一个的产出/作用,员工取并集 —— 和 mergeRoleDefs 的语义一致。
 */
export function collectRoleDefs(opts: {
  knownStaff: Set<string>
  unsupportedStaff?: Set<string>
  /** 注入点,给测试用;省略时读真实 settings。 */
  read?: (source: (typeof SOURCES)[number]) => { efftaskRoles?: unknown; roles?: unknown } | undefined
}): { defs: RoleDef[]; notices: string[] } {
  const read = opts.read ?? ((s: (typeof SOURCES)[number]) => getSettingsForSource(s) as { efftaskRoles?: unknown; roles?: unknown } | undefined)
  const notices: string[] = []
  let defs: RoleDef[] = []

  for (const s of SOURCES) {
    let settings: { efftaskRoles?: unknown; roles?: unknown } | undefined
    try {
      settings = read(s)
    } catch (e) {
      // 一份读不出来的 settings 不该让 /et 起不来 —— 但也不能装作它是空的。
      notices.push(`${SOURCE_LABEL[s]}:读取失败(${e instanceof Error ? e.message : String(e)}),其中的角色定义未生效`)
      continue
    }
    if (!settings) continue
    const parsed = parseRoleDefs(settings.efftaskRoles, {
      knownStaff: opts.knownStaff,
      unsupportedStaff: opts.unsupportedStaff,
      source: SOURCE_LABEL[s],
    })
    notices.push(...parsed.notices)
    const merged = mergeRoleDefs(defs, parsed.defs)
    defs = merged.defs
    notices.push(...merged.notices)
  }

  // 员工侧:「我能当架构师」。放在最后,因为它只能往**已存在**的角色里加人 —— 员工侧
  // 不知道阶段/产出/作用,凭空造出来的角色那三项皆空,而三项皆空正是判定「不生效」的
  // 条件,造它出来只会让关口多一行永远不跑的名字。
  const declarations: { staff: string; roles: string[] }[] = []
  for (const s of SOURCES) {
    let raw: unknown
    try {
      raw = read(s)?.roles
    } catch {
      continue // 上面已经就这个来源报过一次了,不重复
    }
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      if (!name || !Array.isArray(o.efftaskRoles)) continue
      if (!opts.knownStaff.has(name)) continue // 这个员工本身就没被 parseRoles 收下
      // 员工侧这道门必须和角色侧受同样的约束,否则「换个地方写」就是一条绕开校验的后门:
      // 一个 CLI 模式的员工会被排上席位,而 P1 派发不了它 —— 关口上多一个永远不跑的名字。
      if (opts.unsupportedStaff?.has(name)) {
        notices.push(`${SOURCE_LABEL[s]}:员工「${name}」是 CLI 模式,P1 尚不支持,它声明担任的角色未生效`)
        continue
      }
      const roles = o.efftaskRoles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map(r => r.trim())
      if (roles.length > 0) declarations.push({ staff: name, roles })
    }
  }
  if (declarations.length > 0) {
    const applied = applyStaffDeclarations(defs, declarations)
    defs = applied.defs
    notices.push(...applied.notices)
  }

  return { defs, notices }
}
