// src/tools/efftask/roleDefs.ts
//
// 角色(任务里的一个职能)与员工(可派发的身份)是两件事,这个文件是前者。
//
// 员工 = settings.json 的 `roles[]` / `.claude/agents/*.md` / 内置 agent —— 任何可派发的
// agentType,带自己的模型、apiUrl、工具集。角色 = 「架构师」「安全」,在某个阶段做某件事,
// 由零个或多个员工担当。多对多:一个员工可以出现在多个角色里,一个角色可以有多个员工。
import { PHASE_NAMES } from './types.js'
import { MAIN_STAFF } from './types.js'
import type { PhaseName, RoleBinding } from './types.js'

export interface RoleDef {
  /** 角色名,任意取。「架构师」「安全」「前端」。 */
  name: string
  /** 在任务的哪个阶段使用。必须是五个阶段之一 —— 见 parseRoleDefs 里的理由。 */
  stage: PhaseName
  /** 产出什么。 */
  output: string
  /** 起什么作用。 */
  purpose: string
  /**
   * 由哪些员工担当。**空数组 = 主模型兼任**,这是磁盘上唯一合法的「没指定员工」表示。
   *
   * 绝不能写成 `[角色名]` 兜底:找不到的名字在全链路都静默回落主模型
   * (pickAgentDefinition → mainModelDefault,effectiveModel → mainModel),于是关口会
   * 渲染出「架构师(claude-opus-4)」—— 看起来是绑好的员工,实际是主模型披了个名字。
   */
  staff: string[]
}

const PHASE_SET = new Set<string>(PHASE_NAMES)
const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

/** 只有 review / accept 会开圆桌;其余阶段只跑一个 agent。 */
export const MULTI_SEAT_PHASES: PhaseName[] = ['review', 'accept']

/** 复合键分隔符。用 NUL 是因为角色名和员工名都可能含空格/冒号,而 NUL 不可能出现在里面。 */
const KEY_SEP = '\u0000'

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 把任意来源(settings.json 的 efftaskRoles、提示词抽取出来的 JSON)解析成角色定义。
 *
 * 「必须描述清楚在什么阶段使用、产出什么、起什么作用」是用户的硬要求,所以这四项缺任何
 * 一项 → 该角色不生效,并在 notices 里说明为什么。不静默丢弃(§11)。
 */
export function parseRoleDefs(
  raw: unknown,
  opts: {
    /** 可派发的员工名全集(activeAgents 的 agentType)。 */
    knownStaff: Set<string>
    /** 存在但 P1 派发不了的员工(execMode 'cli' 走 AgentTool,不走 runAgent)。 */
    unsupportedStaff?: Set<string>
    /** 出现在 notices 里,让用户知道是配置文件还是提示词里的那份定义出了问题。 */
    source: string
  },
): { defs: RoleDef[]; notices: string[] } {
  const notices: string[] = []
  const defs: RoleDef[] = []
  if (raw == null) return { defs, notices }
  if (!Array.isArray(raw)) {
    notices.push(`${opts.source}:角色定义不是数组,已全部忽略`)
    return { defs, notices }
  }
  const unsupported = opts.unsupportedStaff ?? new Set<string>()
  const seen = new Map<string, number>()

  raw.forEach((item, i) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const name = str(o.name)
    const label = name || `第 ${i + 1} 项`
    if (!name) {
      notices.push(`${opts.source}:${label} 没有 name,该角色不生效`)
      return
    }
    const stage = str(o.stage)
    const output = str(o.output)
    const purpose = str(o.purpose)
    // 阶段必须固定为五个之一,而且原因比「配置得进去、永远不执行」更严重:自由阶段名会被
    // **删掉** —— resumeCore 和 startupConfirm 都用 Object.fromEntries(PHASE_NAMES.map(…))
    // 重建 phaseRoles,未知键第一次 --resume 就没了;而 makeRunAgentFn 按 phase === 'execute'
    // 决定给不给写工具,自由阶段名永远只拿到只读工具集。
    if (!stage) {
      notices.push(`${opts.source}:角色「${name}」没有写 stage(在什么阶段使用),该角色不生效`)
      return
    }
    if (!PHASE_SET.has(stage)) {
      notices.push(`${opts.source}:角色「${name}」的 stage「${stage}」不是 ${PHASE_NAMES.join('/')} 之一,该角色不生效`)
      return
    }
    const missing: string[] = []
    if (!output) missing.push('output(产出什么)')
    if (!purpose) missing.push('purpose(起什么作用)')
    if (missing.length > 0) {
      notices.push(`${opts.source}:角色「${name}」缺少 ${missing.join('、')},该角色不生效`)
      return
    }

    const askedStaff = Array.isArray(o.staff)
      ? [...new Set(o.staff.map(str).filter(s => s.length > 0))]
      : []
    const unknown = askedStaff.filter(s => !opts.knownStaff.has(s))
    const cliOnly = askedStaff.filter(s => opts.knownStaff.has(s) && unsupported.has(s))
    const usable = askedStaff.filter(s => opts.knownStaff.has(s) && !unsupported.has(s))
    // 指定了员工但一个都用不了 ≠ 没指定员工。两者最终都由主模型跑,但前者是用户的意图
    // 没被满足,必须说出来 —— 关口撒谎是这个功能最不能出的错。
    const tail = usable.length === 0 ? '该角色改由主模型兼任' : `该角色仍由 ${usable.join('、')} 担当`
    if (unknown.length > 0) notices.push(`${opts.source}:角色「${name}」找不到员工 ${unknown.join('、')},${tail}`)
    if (cliOnly.length > 0) notices.push(`${opts.source}:角色「${name}」的员工 ${cliOnly.join('、')} 是 CLI 模式,P1 尚不支持,${tail}`)

    const def: RoleDef = { name, stage: stage as PhaseName, output, purpose, staff: usable }
    const prev = seen.get(`${stage}${KEY_SEP}${name}`)
    if (prev !== undefined) {
      // 同一来源里重名 → 后者覆盖前者,并说明。静默保留两份会让同一个角色在圆桌上占两席。
      notices.push(`${opts.source}:${PHASE_LABEL[def.stage]}阶段有两个角色都叫「${name}」,采用后一份定义`)
      defs[prev] = def
      return
    }
    seen.set(`${stage}${KEY_SEP}${name}`, defs.length)
    defs.push(def)
  })
  return { defs, notices }
}

/**
 * 合并两层角色定义。同 (阶段, 角色名) 时 overlay 覆盖 base 的 output/purpose,员工取**并集**。
 *
 * 并集而不是覆盖:员工侧的 `efftaskRoles`(员工自己声明「我能当架构师」)和角色侧的
 * `staff`(角色声明「架构师由谁担当」)说的是同一件事的两个方向,用户两边都写了的时候
 * 意图是「都算上」,不是「后写的赢」。
 */
export function mergeRoleDefs(base: RoleDef[], overlay: RoleDef[]): { defs: RoleDef[]; notices: string[] } {
  const notices: string[] = []
  const out: RoleDef[] = base.map(d => ({ ...d, staff: [...d.staff] }))
  const index = new Map(out.map((d, i) => [`${d.stage}${KEY_SEP}${d.name}`, i]))
  for (const d of overlay) {
    const key = `${d.stage}${KEY_SEP}${d.name}`
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, out.length)
      out.push({ ...d, staff: [...d.staff] })
      continue
    }
    const prev = out[at]
    const merged = [...new Set([...prev.staff, ...d.staff])]
    const added = merged.filter(s => !prev.staff.includes(s))
    if (added.length > 0 && prev.staff.length > 0) {
      notices.push(`角色「${d.name}」的员工由两处共同指定,已合并:${merged.join('、')}`)
    }
    out[at] = { ...d, staff: merged }
  }
  return { defs: out, notices }
}

/**
 * 员工侧声明的角色 → 角色定义。
 *
 * 用户要的是双向配置:既能在角色上写「由谁担当」,也能在员工上写「我能当哪些角色」。
 * 员工侧只知道角色**名**,不知道阶段/产出/作用 —— 那三项只有角色侧有。所以这里返回的是
 * 「把这个员工加到那个已存在的角色里」的意图,匹配不到已有角色定义的名字会被丢弃并说明。
 */
export function applyStaffDeclarations(
  defs: RoleDef[],
  declarations: { staff: string; roles: string[] }[],
): { defs: RoleDef[]; notices: string[] } {
  const notices: string[] = []
  const out = defs.map(d => ({ ...d, staff: [...d.staff] }))
  for (const { staff, roles } of declarations) {
    for (const roleName of roles) {
      const targets = out.filter(d => d.name === roleName)
      if (targets.length === 0) {
        notices.push(`员工「${staff}」声明担任角色「${roleName}」,但没有任何地方定义过这个角色(缺 stage/output/purpose),已忽略`)
        continue
      }
      for (const t of targets) if (!t.staff.includes(staff)) t.staff.push(staff)
    }
  }
  return { defs: out, notices }
}

/**
 * (角色 × 员工) 展平成一份席位列表。
 *
 * 为什么展平而不是做两层圆桌:`synthesizeVerdicts` 的语义是全体 AND,而 AND 满足结合律,
 * 所以 AND_over_roles(AND_over_staff(v)) ≡ AND_over_all_pairs(v)。展平之后零新增聚合、
 * 零嵌套、infra 重试语义原样成立,并发溢出也回到今天的水平(嵌套会让 slotPool 的防自旋
 * 兜底按 1+角色数 相乘)。
 *
 * 去重键是 **(角色名, 员工名)**,不是员工名:同一个员工在两个角色里拿到两份不同的职责
 * 说明,应当两席。关口那边要把这件事说清楚,否则用户看到同一个名字出现两次会以为是 bug。
 */
export function seatsFor(defs: RoleDef[], phase: PhaseName): RoleBinding[] {
  const seats: RoleBinding[] = []
  const seen = new Set<string>()
  for (const d of defs) {
    if (d.stage !== phase) continue
    // 空 staff = 主模型兼任,占一席。MAIN_STAFF 是空串,没有对应的 agentType,于是
    // pickAgentDefinition / effectiveModel 的回落链正好把这一席交给主模型。
    const staff = d.staff.length > 0 ? d.staff : [MAIN_STAFF]
    for (const s of staff) {
      const key = `${d.name}${KEY_SEP}${s}`
      if (seen.has(key)) continue
      seen.add(key)
      seats.push({ roleName: s, roleTag: d.name })
    }
  }
  return seats
}

/**
 * 一个席位的职责简报 —— 角色的「产出什么、起什么作用」到达模型的唯一通道。
 *
 * 没有 roleTag(手动在关口上勾的员工、老 run.md 里的席位)→ 空串,提示词退回今天的样子。
 */
export function roleBriefFor(defs: RoleDef[], seat: RoleBinding | null, phase: PhaseName): string {
  const tag = seat?.roleTag
  if (!tag) return ''
  const def = defs.find(d => d.name === tag && d.stage === phase)
  if (!def) return ''
  const who = seat?.roleName ? `员工「${seat.roleName}」` : '主模型兼任'
  return [
    `## 你的角色:${def.name}(${who})`,
    `- 起什么作用:${def.purpose}`,
    `- 你要产出什么:${def.output}`,
    '按这个角色的职责作答;裁决格式仍按下面的要求。',
  ].join('\n')
}

/** 关口上把「谁占了几席、分别演什么角色」说清楚。 */
export function seatSummaryLines(defs: RoleDef[]): string[] {
  const byStaff = new Map<string, string[]>()
  for (const d of defs) {
    for (const s of d.staff.length > 0 ? d.staff : ['主模型']) {
      const list = byStaff.get(s) ?? []
      if (!list.includes(d.name)) list.push(d.name)
      byStaff.set(s, list)
    }
  }
  return [...byStaff.entries()]
    .filter(([, roles]) => roles.length > 1)
    .map(([staff, roles]) => `${staff} 占 ${roles.length} 席:${roles.join('、')}`)
}
