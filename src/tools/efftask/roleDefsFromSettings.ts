// src/tools/efftask/roleDefsFromSettings.ts
//
// 配置文件那一层:从 settings.json 读出角色定义(角色侧)和员工的角色声明(员工侧)。
//
// 和 roleDefs.ts 分开,是因为那个文件是纯函数、不碰任何全局状态,整套解析/合并/展平逻辑
// 都能不搭环境地测。这里只做「去哪儿拿原始数据」。
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { applyStaffDeclarations, guessStep, mergeRoleDefs, parseRoleDefs, type RoleDef } from './roleDefs.js'
import { applyCapsPatch } from './parseDirectives.js'
import { DEFAULT_CAPS, PHASE_LABEL, PHASE_NAMES, STEP_ALIASES, type Caps, type PhaseName } from './types.js'

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

/**
 * settings.json 里配的「要跳过的环节」。
 *
 * 和 collectRoleDefs 同一批来源、同一个优先级顺序 —— 它们是同一层的两个方向:
 * efftaskRoles 说「这个环节谁来干」,efftaskSkipSteps 说「这个环节干不干」。
 *
 * 归一到内部 phase 名;不认识的项给 notice 并猜一个最接近的,和角色定义里 step 写错时
 * 同一套待遇。
 */
export function collectSkipSteps(opts?: {
  read?: (source: (typeof SOURCES)[number]) => { efftaskSkipSteps?: unknown } | undefined
}): { steps: PhaseName[]; notices: string[] } {
  const read = opts?.read ?? ((s: (typeof SOURCES)[number]) =>
    getSettingsForSource(s) as { efftaskSkipSteps?: unknown } | undefined)
  const notices: string[] = []
  const steps: PhaseName[] = []
  for (const src of SOURCES) {
    let raw: unknown
    try { raw = read(src)?.efftaskSkipSteps } catch { continue }
    if (raw === undefined || raw === null) continue
    if (!Array.isArray(raw)) {
      notices.push(`${SOURCE_LABEL[src]}:efftaskSkipSteps 不是数组,已忽略(相关环节会照常运行)`)
      continue
    }
    for (const item of raw) {
      const t = typeof item === 'string' ? item.trim() : ''
      if (!t) continue
      const v = STEP_ALIASES[t] ?? t
      if ((PHASE_NAMES as string[]).includes(v)) {
        if (!steps.includes(v as PhaseName)) steps.push(v as PhaseName)
      } else {
        const legal = PHASE_NAMES.map(x => PHASE_LABEL[x]).join('/')
        const guess = guessStep(t)
        notices.push(
          `${SOURCE_LABEL[src]}:要跳过的环节「${t}」不是 ${legal} 之一,该环节会照常运行`
          + (guess ? `。是不是想写「${guess}」?` : ''),
        )
      }
    }
  }
  return { steps, notices }
}

/**
 * 两条录入口的跳过环节怎么合。
 *
 * **并集,不是覆盖。** 配置文件说「一直跳质疑讨论」、提示词说「这次也跳验收」,两句都
 * 该生效。角色定义那边是覆盖语义(提示词点名了就换人),因为「谁来干」是单选;跳过是
 * 「干不干」的开关,叠加才符合两句话都说过的直觉。
 *
 * 抽成函数而不是在组件里内联,是因为组件那一层的测试驱动不了抽取模型:内联的话这条
 * 语义就只能靠「读源码」来验,而读源码的闸门在这个项目里已经放过一次死代码了。
 *
 * 想在某一次 run 里**取消**配置文件里的跳过,走关口的名册编辑器(给那个环节勾一个员工),
 * 提示词做不到 —— 并集没有减法。
 */
export function mergeSkipSteps(fromSettings: PhaseName[], fromPrompt: PhaseName[] | undefined): PhaseName[] | undefined {
  const all = [...new Set([...fromSettings, ...(fromPrompt ?? [])])]
  // 一个都没有时返回 undefined 而不是 []:下游用 `?? []` 判缺省,空数组会让
  // 「没说过跳过」和「说了但一个都不合法」在 run.md 上长得不一样。
  return all.length > 0 ? all : undefined
}

/**
 * settings.json 里配的**安全阀**(`efftaskCaps`)——「我根据项目来设置」的那条路。
 *
 * 用户原话:「把上限改成 20000,至于我用多少,我根据项目来设置。」在这个字段之前,caps 只有
 * 两个入口:每次在提示词里说一遍,或者手改 run.md 再 `--resume`。一个翻译项目要 20000 个
 * 节点、一个文档项目要 50 个,而这件事**每次运行都不会变** —— 让用户每次重打一遍,他迟早
 * 有一次忘了打,而忘了的那次不会有任何提示(默认值本身是合法的)。
 *
 * 和 `collectRoleDefs` / `collectSkipSteps` 同一批来源、同一个优先级:后一个来源覆盖前一个,
 * **逐字段**覆盖(项目配置只写 maxNodes 时,用户配置里的 maxIterations 留着)。
 *
 * 校验共用 `applyCapsPatch` —— 范围表只有一份。各写一份的话,同一个数会在两条录入口上被
 * 解释成两个值,而那正是 `maxNodes` 上限刚刚踩过的那个坑。
 */
export function collectCaps(opts?: {
  read?: (source: (typeof SOURCES)[number]) => { efftaskCaps?: unknown } | undefined
}): { caps: Caps; notices: string[] } {
  const read = opts?.read ?? ((s: (typeof SOURCES)[number]) =>
    getSettingsForSource(s) as { efftaskCaps?: unknown } | undefined)
  const notices: string[] = []
  let caps: Caps = { ...DEFAULT_CAPS }
  for (const src of SOURCES) {
    let raw: unknown
    try { raw = read(src)?.efftaskCaps } catch { continue }
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      notices.push(`${SOURCE_LABEL[src]}:efftaskCaps 不是一个对象,已忽略(本次按默认安全阀跑)`)
      continue
    }
    caps = applyCapsPatch(caps, raw as Record<string, unknown>, `${SOURCE_LABEL[src]}:`, notices)
  }
  return { caps, notices }
}
