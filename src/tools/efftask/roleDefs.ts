// src/tools/efftask/roleDefs.ts
//
// 角色(任务里的一个职能)与员工(可派发的身份)是两件事,这个文件是前者。
//
// 员工 = settings.json 的 `roles[]` / `.claude/agents/*.md` / 内置 agent —— 任何可派发的
// agentType,带自己的模型、apiUrl、工具集。角色 = 「架构师」「安全」,在某个阶段做某件事,
// 由零个或多个员工担当。多对多:一个员工可以出现在多个角色里,一个角色可以有多个员工。
import { PHASE_NAMES, PHASE_LABEL, STEP_ALIASES } from './types.js'
import { DEFAULT_MAX_SEATS_PER_PHASE, MAIN_STAFF } from './types.js'
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

/**
 * 每个阶段能坐几个人、以什么方式坐 —— **唯一的一份**。
 *
 * 此前这条规则散在四处(本文件的 MULTI_SEAT_PHASES 与 SINGLE_SEAT_REASON、
 * startupConfirm 的 MULTI_ROLE_PHASES、parseDirectives 的逐阶段裁剪),而且它们**已经
 * 漂移了**:plan 支持顺序精化多员工,却不在任何一个 multi 集合里,于是关口的 toggleRole
 * 走「替换」分支 —— 用户连点两个方案员工,第二个把第一个顶掉,一声不响。
 * (这个仓库已经为两个 ACTIVE 列表漂移付过一次代价:38% 的阶段耗时无处可归。)
 *
 * - roundtable:并行独立出裁决,再按全票/法定人数合成(review / accept)
 * - sequential:顺序精化,一份稿子从第一位传到最后一位(plan)
 * - single:只跑一个 agent,多出来的席位永远不会被派发(execute / observer)
 */
export const PHASE_SEATING: Record<PhaseName, 'roundtable' | 'sequential' | 'single'> = {
  // plan 的形态由 caps.planConverge 决定:'精化' 是顺序,'圆桌' 是并行+合成。两者都允许
  // 多席位,所以这里记 'sequential' 只是「不是圆桌合成裁决」的意思 —— allowsMultipleSeats
  // 才是这张表真正被消费的地方,两种模式下它都必须是 true。
  plan: 'sequential', review: 'roundtable', execute: 'single',
  verify: 'roundtable', accept: 'roundtable', integrate: 'roundtable',
  // 观察也是多席位:各自独立打分,取最低分收敛成一个结论,其余理由挂在 ScoreRecord.others
  // 上 —— 「一个角色多个员工必须只有一个产出」在这里就是这样满足的。
  observer: 'roundtable',
}

/** 这个阶段允许多个席位吗?圆桌与顺序精化都允许,只有 single 不允许。 */
export function allowsMultipleSeats(p: PhaseName): boolean {
  return PHASE_SEATING[p] !== 'single'
}

/** 只有这些阶段会开圆桌(并行独立裁决 + 合成)。 */
export const MULTI_SEAT_PHASES: ReadonlySet<PhaseName> =
  new Set<PhaseName>((Object.keys(PHASE_SEATING) as PhaseName[]).filter(p => PHASE_SEATING[p] === 'roundtable'))

/**
 * 单席位阶段为什么只能有一席 —— 每条都是物理约束,不是策略。
 *
 * 这些阶段 pipeline 用 `firstRole()` 取第 [0] 席,多出来的席位一次都不会被派发。把它们
 * 留在名册上,关口就会列出永远不跑的名字 —— 而关口存在的唯一意义就是别撒谎。
 */
const SINGLE_SEAT_REASON: Partial<Record<PhaseName, string>> = {
  // plan 不在这里:它支持**顺序精化**(第一位起草,后面每一位在前一稿上修订),
  // 全程只有一份稿子,所以「只有一个产出」成立。见 pipeline.runPlanRefinement。
  execute: '执行阶段只跑一个 agent(两个带写工具的执行器会落在同一个 worktree 上)',

}

/** 名册/提醒里怎么称呼一席。 */
function describeSeat(s: RoleBinding): string {
  const who = s.roleName || '主模型'
  return s.roleTag ? `${s.roleTag}(${who})` : who
}

/** 复合键分隔符。用 NUL 是因为角色名和员工名都可能含空格/冒号,而 NUL 不可能出现在里面。 */
const KEY_SEP = '\u0000'

/**
 * 猜用户想写的那个环节名。
 *
 * 只做前缀/包含匹配,不做编辑距离 —— 一个猜错的建议比没有建议更糟,而中文环节名之间
 * 的字面距离很近(「验收」vs「集成提交」)。宁可不猜。
 */
function guessStep(raw: string): string | undefined {
  if (!raw) return undefined
  for (const p of PHASE_NAMES) {
    const label = PHASE_LABEL[p]
    if (label.includes(raw) || raw.includes(label) || p.startsWith(raw.toLowerCase())) return label
  }
  return undefined
}

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
    // `step` 是新键名,`stage` 是旧的 —— 读时都收,**写时只写内部 phase 名**。
    // 两边都当 canonical 会让 run.md 里出现两种写法,而读回那侧只认一种。
    const rawStep = str(o.step) || str(o.stage)
    const stage = STEP_ALIASES[rawStep] ?? rawStep
    const output = str(o.output)
    const purpose = str(o.purpose)
    // 阶段必须固定为五个之一,而且原因比「配置得进去、永远不执行」更严重:自由阶段名会被
    // **删掉** —— resumeCore 和 startupConfirm 都用 Object.fromEntries(PHASE_NAMES.map(…))
    // 重建 phaseRoles,未知键第一次 --resume 就没了;而 makeRunAgentFn 按 phase === 'execute'
    // 决定给不给写工具,自由阶段名永远只拿到只读工具集。
    if (!stage) {
      notices.push(`${opts.source}:角色「${name}」没有写 step(在哪个环节使用),该角色不生效`)
      return
    }
    if (!PHASE_SET.has(stage)) {
      // 列**中文**合法值:文档和关口给用户看的就是中文,列内部 phase 名等于让他自己
      // 做一次中英对照。再猜一个最接近的 —— 把「够不够让他改对」提到「不用想」。
      const legal = PHASE_NAMES.map(x => PHASE_LABEL[x]).join('/')
      const guess = guessStep(rawStep)
      notices.push(
        `${opts.source}:角色「${name}」的环节「${rawStep}」不是 ${legal} 之一,该角色不生效` +
        (guess ? `。是不是想写「${guess}」?` : ''),
      )
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
export function mergeRoleDefs(
  base: RoleDef[],
  overlay: RoleDef[],
  /**
   * overlay 明确写了 staff 时,**换掉**而不是并上 base 的员工。
   *
   * 用在提示词覆盖配置文件那一跳:那是两个不同的层,而提示词是更晚、更具体的意图。
   * 用户说「架构师这次改由 ds-安全 担任」,并集会得到 opus-架构 + ds-安全 —— 「改由」
   * 变成了「再加一个」,而这正是「任务需求提示词可更新改变这种配置」要的能力。
   *
   * 配置文件内部三份来源之间仍然取并集:角色侧的 staff 和员工侧的 efftaskRoles 是同一层
   * 配置的两个方向,两边都写的时候意图是「都算上」。
   */
  overlayReplacesStaff = false,
): { defs: RoleDef[]; notices: string[] } {
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
    // overlay 没写 staff 就沿用 base 的 —— 只想改产出/作用的时候不该顺手把人清空。
    const replacing = overlayReplacesStaff && d.staff.length > 0
    const merged = replacing ? [...d.staff] : [...new Set([...prev.staff, ...d.staff])]
    if (replacing && prev.staff.some(s => !merged.includes(s))) {
      notices.push(`角色「${d.name}」的员工已按提示词改为 ${merged.join('、')}(原为 ${prev.staff.join('、')})`)
    } else if (!replacing && merged.some(s => !prev.staff.includes(s)) && prev.staff.length > 0) {
      notices.push(`角色「${d.name}」的员工由两处共同指定,已合并:${merged.join('、')}`)
    }
    out[at] = { ...d, staff: merged.length > 0 ? merged : [...prev.staff] }
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


/**
 * 把角色展平出来的席位并进「按名字直接指定的员工」那份名册。
 *
 * 两条配置路径可以同时存在:`评审用 opus-架构 和 ds-安全`(只给名字)和角色定义(给职责)。
 * 同一个员工两边都出现时**只保留带角色标签的那一席** —— 否则它会被派发两次,在全票
 * 门槛下等于给同一个员工两票,而关口上会看到两个一模一样的名字。
 */
export function mergeSeats(
  existing: RoleBinding[],
  fromDefs: RoleBinding[],
  phaseLabel: string,
  /**
   * 单席位阶段:把角色席位排在前面。
   *
   * 这些阶段只有第 [0] 席会被派发,而角色席位是追加在后面的 —— 于是「配置文件里配了一个
   * 带职责的角色 + 提示词里按名字点了一个员工」这种再普通不过的组合,会让角色整体死掉,
   * 真正跑的那一席连简报都没有。带职责说明的那一席信息更全,它该赢。
   */
  roleSeatsFirst = false,
): { seats: RoleBinding[]; notices: string[] } {
  const notices: string[] = []
  const tagged = new Set(fromDefs.map(s => s.roleName))
  const kept = existing.filter(e => {
    if (!e.roleTag && tagged.has(e.roleName)) {
      notices.push(`${phaseLabel}:员工 ${e.roleName} 已由角色定义安排,不再额外占一席`)
      return false
    }
    return true
  })
  const seen = new Set(kept.map(s => `${s.roleTag ?? ''}${KEY_SEP}${s.roleName}`))
  const added = fromDefs.filter(s => {
    const k = `${s.roleTag ?? ''}${KEY_SEP}${s.roleName}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { seats: roleSeatsFirst ? [...added, ...kept] : [...kept, ...added], notices }
}

/**
 * 角色定义 → 五个阶段的席位表,并进已有名册。
 *
 * 这是「配置了角色」和「真的会被派发」之间的那根线。少了它,roleDefs 就只是一份被解析、
 * 被校验、被渲染在关口上的数据。
 */
export function applyRoleDefsToPhases(
  phaseRoles: Record<PhaseName, RoleBinding[]>,
  defs: RoleDef[],
  /**
   * 一个阶段最多几席(caps.maxSeatsPerPhase),省略 = 默认值。
   *
   * 多对多把调用数乘起来:R 个角色 × 每角色 S 个员工 = R×S 次调用,每轮评审付一遍。
   * 超出的席位**剔除并点名** —— 静默截断会让关口显示的名册和真正跑的不一致。
   */
  maxSeats: number = DEFAULT_MAX_SEATS_PER_PHASE,
): { phaseRoles: Record<PhaseName, RoleBinding[]>; notices: string[] } {
  const notices: string[] = []
  const out = {} as Record<PhaseName, RoleBinding[]>
  for (const p of PHASE_NAMES) {
    const merged = mergeSeats(phaseRoles[p] ?? [], seatsFor(defs, p), PHASE_LABEL[p], !allowsMultipleSeats(p))
    notices.push(...merged.notices)
    let seats = merged.seats
    const reason = allowsMultipleSeats(p) ? undefined : SINGLE_SEAT_REASON[p]
    // 裁剪放在合并**之后**:先合并再截断。反过来的话,按名字直接指定的员工会把角色
    // 席位挤掉,用户看到的是自己配的角色凭空消失,而且一声不响。
    if (reason && seats.length > 1) {
      notices.push(`${PHASE_LABEL[p]}:${reason},仅 ${describeSeat(seats[0])} 生效,已忽略 ${seats.slice(1).map(describeSeat).join('、')}`)
      seats = seats.slice(0, 1)
    }
    // 席位上限。放在单席位裁剪之后,免得对 plan/execute/observer 报两遍同一件事。
    // NaN 会让 `seats.length > cap` 恒为假 —— 上限**静默失效**,12 席全部放行且没有
    // 任何 notice。退回默认值而不是放行。
    const rounded = Math.round(maxSeats)
    const cap = Number.isFinite(rounded) ? Math.max(1, rounded) : DEFAULT_MAX_SEATS_PER_PHASE
    if (seats.length > cap) {
      notices.push(`${PHASE_LABEL[p]}:席位上限 ${cap},已忽略 ${seats.slice(cap).map(describeSeat).join('、')}(如需更多,在任务提示词里说明「每阶段最多 N 席」)`)
      seats = seats.slice(0, cap)
    }
    out[p] = seats
  }
  return { phaseRoles: out, notices }
}
