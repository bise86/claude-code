import { DEFAULT_CAPS, DEFAULT_MAX_SEATS_PER_PHASE, PHASE_NAMES, PHASE_LABEL } from './types.js'
import { stripControl } from './persistence.js'
import { allowsMultipleSeats } from './roleDefs.js'
import type { EffTaskConfig, PhaseName, RoleBinding, TaskNode } from './types.js'

export interface StartupDecision {
  parallelism: number
  approved: boolean
  /**
   * 名册可编辑后确认 (spec §2 第一关) — the roster as the user left it.
   *
   * OPTIONAL because only the terminal surface can edit it: the Feishu card carries
   * approve/deny plus a parallelism number and has no channel for a five-phase role table.
   * Absent means "unchanged", so a Feishu approval keeps exactly the roster its card showed.
   */
  phaseRoles?: Record<PhaseName, RoleBinding[]>
  /**
   * 名册编辑器里改过的「要跳过的环节」(spec §7.5)。
   *
   * 和 phaseRoles 同样是 OPTIONAL / 同样是「缺省 = 不变」:飞书卡上没有这个开关。
   *
   * 缺了这个字段的后果实测过:编辑器那一行写着「(已跳过,勾选任一员工即恢复)」,用户
   * 勾了人,那一行的「已跳过」标记当场消失 —— 而决策 payload 里根本没有这个字段,run
   * 照样整个跳过该环节,名册里坐着一个永远不会被派发的员工。同一个关口的两屏还互相
   * 矛盾:编辑器说恢复了,退出编辑器后的只读名册说已跳过。
   */
  skipSteps?: PhaseName[]
  /**
   * 仅查看后退出 (spec §17.3) — a THIRD answer at the resume gate, not a synonym for cancel.
   *
   * It was implemented as a synonym: `v` sent the byte-identical
   * `{ parallelism, approved: false }` that Esc sends, so a key labelled 「仅查看后退出」
   * exited without ever showing anything. The recovered tree was already in memory at that
   * moment — the gate renders its counts — and the user who ran `--resume` specifically to
   * inspect a crashed run got a bare 已取消.
   *
   * Only meaningful on the resume gate; the startup gate has no tree to show yet.
   */
  viewOnly?: boolean
}


// The ACTUAL roster (spec gate-1 角色名册): each phase → its bound role names, or 主模型
// when the phase has no bindings. Shared by the terminal card AND the Feishu card so the
// two surfaces can never disagree about who is on the panel.
/**
 * Truncate to `max` CODE POINTS. A raw .slice() counts UTF-16 units and can cut an emoji
 * in half, emitting a lone surrogate into a card payload and the terminal.
 */
/** 名册行的码点预算。夹取、预留提示位置、测试的上限断言必须用同一个数。 */
export const ROSTER_BUDGET = 80

export function clip(s: string, max = 80): string {
  const cps = Array.from(s)
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s
}

/**
 * Phases that run a ROUNDTABLE — every bound role is dispatched, in parallel, and all must
 * pass. Everything else runs `firstRole`, i.e. index 0 and nothing else.
 *
 * parseDirectives already trims the single-seat phases to one and pushes a notice, with the
 * reason in its own comment: "listing extra seats there would put names on the confirmation
 * roster that never get called — the gate must show who actually runs". The editor has to
 * honour the same invariant or it re-opens exactly that hole by hand.
 */
/**
 * 关口能不能给这个阶段追加席位 —— 从 roleDefs 的**唯一**那份规则推导,不再自己维护。
 *
 * 自己维护的那份和 roleDefs 漂移过:plan 支持顺序精化多员工(SINGLE_SEAT_REASON 明确
 * 不含它),却不在这个集合里,于是 toggleRole 走「替换」分支 —— 用户在关口上连点两个
 * 方案员工,第二个把第一个顶掉,而且一声不响。实测:toggle('plan','a') 再
 * toggle('plan','b') 得到 [{roleName:'b'}]。
 */
export const MULTI_ROLE_PHASES: ReadonlySet<PhaseName> =
  new Set<PhaseName>(PHASE_NAMES.filter(allowsMultipleSeats))

/**
 * Toggle one role on a phase, returning a NEW roster.
 *
 * Pure so the gate's edit logic is testable without mounting anything — the gate itself is
 * keyboard plumbing around this.
 *
 * `observer` is deliberately allowed to be empty and everything else is too: an empty phase
 * means 主模型 (and, for observer, "no scoring at all"), which rosterLines already renders
 * correctly. Refusing to empty a phase would make the editor unable to undo its own additions.
 */
export function toggleRole(
  roster: Record<PhaseName, RoleBinding[]>, phase: PhaseName, roleName: string, model?: string,
  /**
   * 席位上限(caps.maxSeatsPerPhase)。省略 = 默认值。
   *
   * 关口是第三条能往名册里加人的路径,此前它完全不夹取 —— 用户在这里勾到 8 席,
   * 上限是 3,没有任何提示。旋钮只在三条路径中的一条上转得动等于没有旋钮。
   */
  maxSeats: number = DEFAULT_MAX_SEATS_PER_PHASE,
): Record<PhaseName, RoleBinding[]> {
  const cur = roster[phase] ?? []
  // 只对**没有角色标签**的席位生效。带标签的席位来自角色定义(settings.json 或提示词),
  // 它携带 stage/output/purpose,而这个编辑器是一个按员工名打勾的列表 —— 它没有地方
  // 放这些信息,也就无法把一个被勾掉的角色席位再放回来。
  //
  // 实测过按 roleName 匹配的后果:同一个员工兼两个角色时,一次按键把**两席**一起删掉;
  // 再按一次只回来一席,而且没有 roleTag —— 职责简报永久丢失,名册也不再显示角色名,
  // 用户还以为自己撤销了。
  const tagged = cur.filter(r => r.roleTag)
  const free = cur.filter(r => !r.roleTag)
  const has = free.some(r => r.roleName === roleName)
  // Copy every phase's ARRAY, not just the outer record: TaskNode.createNode copies these per
  // node, and a shared array instance would let one edit reach the whole tree.
  const next = Object.fromEntries(
    PHASE_NAMES.map(p => [p, [...(roster[p] ?? [])]]),
  ) as Record<PhaseName, RoleBinding[]>
  const binding: RoleBinding = model ? { roleName, model } : { roleName }
  // 单席位阶段已经被角色定义占满 → 这里无从下手。硬加一席只会让名册多一个永远不跑的
  // 名字(pipeline 取第 [0] 席),而那正是这个关口存在的意义所要防的。
  if (!MULTI_ROLE_PHASES.has(phase) && tagged.length > 0) return roster
  // 加席时不能越过上限。拒绝而不是悄悄截断:用户按了键却什么都没发生,总好过名册上
  // 多一个不会跑的名字 —— 而截断的那一席正是他刚刚亲手点的那个。
  const rounded = Math.round(maxSeats)
  const cap = Number.isFinite(rounded) ? Math.max(1, rounded) : DEFAULT_MAX_SEATS_PER_PHASE
  if (!has && MULTI_ROLE_PHASES.has(phase) && cur.length >= cap) return roster
  next[phase] = has
    ? [...tagged, ...free.filter(r => r.roleName !== roleName)]
    // SINGLE-SEAT phases replace rather than append: the run would dispatch only the first
    // one, so a second name on the roster is a seat that never gets called.
    : MULTI_ROLE_PHASES.has(phase) ? [...cur, binding] : [binding]
  return next
}

/** How many candidate roles one editor row shows before it starts windowing. */
export const ROSTER_WINDOW = 6

/**
 * One line per phase for the EDITOR: the candidate roles, with the bound ones marked.
 *
 * WINDOWED around the cursor. `available` is every dispatchable agent — built-ins, plugin
 * agents and `.claude/agents/*.md`, not just settings `roles` — so a dozen candidates is
 * ordinary. Measured unwindowed at 40: one row was 1281 characters and the box grew to 32
 * lines on a 100-column terminal, pushing the goal and the caps line off screen. rosterLines
 * has clipped for exactly this reason since P1; this path had nothing.
 */
export function rosterEditorLines(
  roster: Record<PhaseName, RoleBinding[]>, available: string[], phaseIdx: number, roleIdx: number,
  window = ROSTER_WINDOW,
  /** 被跳过的环节 —— 编辑器要标出来,否则勾了人什么都不会发生。 */
  skipped?: PhaseName[],
): string[] {
  return PHASE_NAMES.map((p, i) => {
    const seatsHere = roster[p] ?? []
    // 打勾只反映**没有角色标签**的席位 —— 带标签的那些在这个编辑器里改不了(见 toggleRole),
    // 给它们打勾会让用户以为按一下就能取消。
    const bound = new Set(seatsHere.filter(r => !r.roleTag).map(r => r.roleName))
    // 角色定义排上的席位,单独列出来。此前它们对这一行完全不可见:主模型兼任的席位
    // roleName 是空串,`bound` 成了 Set{''},于是 size !== 0 让「(主模型)」也不显示 ——
    // 只读名册说「验收: 验收官←主模型」,同一个关口的编辑器行却说什么都没选。
    const locked = seatsHere.filter(r => r.roleTag)
      .map(r => `${clip(r.roleTag!, 12)}←${clip(r.roleName || '主模型', 14)}`)
    const label = PHASE_LABEL[p]
    const empty = seatsHere.length === 0 ? (p === 'observer' ? ' (不评分)' : ' (主模型)') : ''
    // 被跳过的环节照常显示复选框会是又一处「配得进去、永远不生效」:用户勾了人,
    // 什么都不会发生。标出来,并说明勾选即恢复(命令侧据此把它移出 skipSteps)。
    const skipMark = (skipped ?? []).includes(p) ? '(已跳过,勾选任一员工即恢复)' : ''
    const lockedPrefix = locked.length > 0 ? `〔角色定义:${locked.join('、')}〕` : ''
    const seats = MULTI_ROLE_PHASES.has(p) ? '' : '(单选)'
    if (available.length === 0) {
      // Say WHY rather than render an empty row: with no roles available there is nothing to
      // edit, and a blank line reads as a broken editor.
      //
      // 被跳过的环节在这里**不能说「本阶段用主模型」** —— 那是承诺一件不会发生的事
      // (该环节一次调用都没有),而同一个关口的只读名册说的是「已跳过」,两屏自相矛盾。
      // 而且取消跳过的唯一途径是勾一个具名员工,没有可用角色时根本做不到,所以这里
      // 要顺带说清「这一步撤不掉」,别让用户在编辑器里白找。
      if ((skipped ?? []).includes(p)) {
        return `${i === phaseIdx ? '▶' : ' '} ${label}: (已跳过;本会话没有可派发的员工,无法在这里取消 —— 去掉 settings.json 的 efftaskSkipSteps 或改提示词)`
      }
      return `${i === phaseIdx ? '▶' : ' '} ${label}${empty}: ${lockedPrefix || '(没有可用角色,本阶段用主模型)'}`
    }
    // Keep the cursor inside the window, and keep bound roles visible on rows the cursor is
    // not on — otherwise a user cannot see what they already selected.
    const start = i === phaseIdx
      ? Math.max(0, Math.min(roleIdx - Math.floor(window / 2), available.length - window))
      : 0
    const from = Math.max(0, start)
    const shown = available.slice(from, from + window)
    const cells = shown.map((name, j) => {
      const k = from + j
      const mark = bound.has(name) ? '[x]' : '[ ]'
      const cursor = i === phaseIdx && k === roleIdx ? '>' : ' '
      return `${cursor}${mark}${clip(name, 20)}`
    })
    const hiddenBefore = from
    const hiddenAfter = available.length - (from + shown.length)
    // Count what is off-screen. A window that silently shows a slice looks like the whole list.
    const more = [hiddenBefore > 0 ? `←${hiddenBefore}` : '', hiddenAfter > 0 ? `→${hiddenAfter}` : ''].filter(Boolean).join(' ')
    return `${i === phaseIdx ? '▶' : ' '} ${label}${seats}${empty}${skipMark}: ${lockedPrefix}${cells.join(' ')}${more ? ' ' + more : ''}`
  })
}

/**
 * Apply a confirmed gate decision to the run's config.
 *
 * A named, testable function because `efftask.tsx` has no tests: replacing this expression
 * with `phaseRoles: config.phaseRoles` — i.e. making the whole editable-roster feature dead
 * in production — left the entire suite green.
 */
export function applyStartupDecision(config: EffTaskConfig, decision: StartupDecision): EffTaskConfig {
  return {
    ...config,
    parallelism: decision.parallelism,
    // Absent means UNCHANGED, which is what a Feishu approval sends: that card has no channel
    // for a five-phase role table, so it must keep exactly the roster it displayed.
    phaseRoles: decision.phaseRoles ?? config.phaseRoles,
    // 同样的「缺省 = 不变」语义:飞书那条路没有这个开关,不能把它当成「清空跳过」。
    skipSteps: decision.skipSteps ?? config.skipSteps,
  }
}

/**
 * Role names this session can actually dispatch.
 *
 * The same filter parseDirectives applies (`known && !unsupported`), named once so the gate
 * cannot drift from it. An execMode:'cli' role is dispatched by AgentTool, not by this run's
 * runAgent seam — offering it would put a seat on the roster that silently becomes the main
 * model.
 */
export function dispatchableRoles(known: string[], unsupported: string[]): string[] {
  const bad = new Set(unsupported)
  return known.filter(r => !bad.has(r))
}

/** 每个环节被跳过之后**实际会发生什么**。写后果,不写「已跳过」。 */
const SKIP_CONSEQUENCE: Record<PhaseName, string> = {
  plan: '(已跳过 —— 不出方案、不主动拆子任务,节点直接照目标开工)',
  review: '(已跳过 —— 方案没人质疑就进执行,漏项和隐藏依赖不会在这里被拦下)',
  execute: '(已跳过 —— 没有人改代码,本次不会产生任何提交)',
  verify: '(已跳过 —— 不实跑测试,验收只能读执行者的自述)',
  accept: '(已跳过 —— 没人核对验收点,产出未经判断就合进集成分支)',
  integrate: '(已跳过 —— 子任务各自通过就算父任务达成,当初拆漏了不会再有人发现)',
  observer: '(已跳过 —— 不打分,低分触发的那一轮返工不会发生)',
}

/**
 * 跳过带来的**连带后果**:要么让任务跑不完,要么让某个环节评一个它评不了的东西。
 *
 * 单独一个块,不塞进 notices —— 那个块的标题是「你的请求中有以下部分**不会生效**」,
 * 而跳过是**生效了**的。把一个降质动作塞进那个标题下面,和把隔离降级塞进去是同一个错。
 *
 * 这里的每一句话都必须**实测**过。上一版第一条写的是「节点会在执行环节连报 3 轮空产出
 * 后阻断,验收根本跑不到。请一并跳过验收」——三句全错:跳过执行是在空产出闸门**之前**
 * 整块早退的,闸门根本不触发,验收照跑(实测一次调用就把一个什么都没做的节点判成
 * ACCEPTED)。而最后那句建议尤其糟:它让用户去掉唯一还在跑的那道检查。
 */
export function skipConflictLines(config: EffTaskConfig): string[] {
  const skip = new Set(config.skipSteps ?? [])
  const out: string[] = []
  if (skip.has('execute') && !skip.has('accept')) {
    out.push('跳过了执行但没跳验收:本次不会有任何代码改动,验收席位仍会照常开会,去核对一个空产出。'
      + '判通过 = 给一个什么都没做的节点盖章并合进集成分支;判不通过 = 烧完验收迭代后阻断。'
      + '要么一并跳过验收,要么别跳执行。')
  }
  if (skip.has('plan') && !skip.has('review')) {
    out.push('跳过了分析但没跳质疑讨论:评审席位会去评一份空方案,大概率判不通过并烧完迭代。建议一并跳过质疑讨论。')
  }
  if (skip.size >= PHASE_NAMES.length) {
    out.push('七个环节全部跳过:本次不会有任何模型调用,也不会有任何代码改动。确认要空跑吗?')
  }
  return out
}

/**
 * 跳过之后**照常发生、但和你原本预期不同**的事。
 *
 * 和上面那个函数分开,因为它们的标题不一样:上面是「会跑不完」,这里是「跑得完,但
 * 有个连带后果你得知道」。把后者塞进前者的标题下,就是 spec §7.5 批评 notices 块
 * 「标题说 A、内容说 B」的同一个错,只是换了个块。
 */
/**
 * MCP 在这次 run 里的边界。
 *
 * 必须说,因为它同时是**能力**和**风险**,而两者用户都看不见:
 *  - 能力:2026-07 起所有环节都拿得到 MCP(此前只有执行环节有,而关口一个字没提,
 *    用户配了查文档的 server 却以为评审员在用它);
 *  - 风险:内建写工具挡得住,**会写的 MCP 挡不住** —— 没有可靠办法从 `mcp__x__y`
 *    这个名字判断它是否只读。所以评审席位上的角色如果带着写能力 MCP,它能自己把
 *    问题改了再判通过。这是用户要自己决定的事,不是可以替他咽下去的事。
 *
 * 没有 MCP 工具时返回空 —— 说一件不存在的事同样是噪音。
 */
export function mcpNoticeLines(mcpToolNames: string[]): string[] {
  if (mcpToolNames.length === 0) return []
  const shown = mcpToolNames.slice(0, 3).map(n => clip(n, 28)).join('、')
  const more = mcpToolNames.length > 3 ? ` 等 ${mcpToolNames.length} 个` : ''
  return [
    `本次所有环节(不只是执行)都能用 MCP:${shown}${more}`,
    '内建写工具(Edit/Write/NotebookEdit/Bash)仍然只有执行环节有;但**会写的 MCP 挡不住** —— 给评审/验收席位配带写能力 MCP 的角色时,它可以自己改完再判通过。',
  ]
}

export function skipConsequenceLines(config: EffTaskConfig): string[] {
  const skip = new Set(config.skipSteps ?? [])
  const out: string[] = []
  if (skip.has('plan')) {
    out.push('跳过分析 = 本次不主动拆子任务,任务树基本只有根节点(执行者仍可动态加),深度与节点数上限因此失去意义。')
  }
  if (skip.has('integrate')) {
    out.push('跳过集成验收 = 所有**拆分型**节点(含根节点,如果它被拆了)不再评分;执行型节点照常评分。')
  }
  return out
}

export function rosterLines(config: EffTaskConfig): string[] {
  return PHASE_NAMES.map(p => {
    // Scoring is OPT-IN: with no observer role nothing scores, and it does NOT fall back to
    // the main model the way the other phases do. Saying 主模型 here would promise a scorer
    // that never runs.
    // 跳过要写出**后果**,不只是「已跳过」。这是降低质量保证的动作,而关口存在的意义
    // 就是让用户在批准前知道自己批准了什么。
    if ((config.skipSteps ?? []).includes(p)) return `${PHASE_LABEL[p]}: ${SKIP_CONSEQUENCE[p]}`
    // 三个环节在**没配角色**时不会回落到主模型,说「主模型」就是承诺一件不会发生的事。
    // 这三条各自的真实行为不同,所以文案也不同 —— 统一说「未配置」同样是含糊其辞。
    if ((config.phaseRoles[p] ?? []).length === 0) {
      if (p === 'observer') return `${PHASE_LABEL[p]}: (未配置,不评分)`
      // 测试验证是 opt-in:0 席 = 这一步整个不发生,一次调用都不会有。
      if (p === 'verify') return `${PHASE_LABEL[p]}: (未配置,本次不做验证;验收只能读执行者的自述)`
      // 集成提交 0 席时回落到验收席位 —— 说「主模型」会让用户以为是另一批人在跑。
      if (p === 'integrate') {
        const fallback = (config.phaseRoles.accept ?? []).length > 0 ? '由验收席位承担' : '由验收席位承担(即主模型)'
        return `${PHASE_LABEL[p]}: (未配置,${fallback})`
      }
    }
    // Show the bound model too: this gate exists to let the user see exactly who is on the
    // panel, and "coder" alone hides which model that role actually runs on.
    const names = (config.phaseRoles[p] ?? []).map(r => {
      // 「主模型兼任」的席位 roleName 是空串,直接插值会渲染出一个光秃秃的 `(模型名)`。
      // 而带角色标签的席位要把角色说出来 —— 用户配的是「架构师」,只看到员工名的话,
      // 关口就没回答「有多少角色、承担什么」里的前半个问题。
      const who = r.roleName || (config.mainModel ? `主模型(${config.mainModel})` : '主模型')
      const withModel = r.roleName && r.model ? `${r.roleName}(${r.model})` : who
      return r.roleTag ? `${r.roleTag}←${withModel}` : withModel
    })
    // An un-roled phase runs on the session's main model — name it. "主模型" alone is the
    // same omission as a bare role name: it says a model was chosen without saying which.
    const bare = config.mainModel ? `主模型(${config.mainModel})` : '主模型'
    // Same 80-code-point budget as the goal line, so one long roster can't wreck the layout.
    const body = names.length > 0 ? names.join('、') : bare
    if (names.length === 0 || Array.from(body).length <= ROSTER_BUDGET) {
      return `${PHASE_LABEL[p]}: ${clip(body, ROSTER_BUDGET)}`
    }
    /**
     * 藏了几席,必须说出来 —— 而且这句话的位置要从**名字**里扣,不能从版面扣。
     *
     * 默认每环节席位上限就是 5(README 把它写成正常配置),而 80 码点大约只放得下 3 个
     * `角色←员工(模型)`。原来夹完只剩一个「…」:关口存在的全部意义是「谁在什么环节
     * 干活」,而它把这个问题答了一半,还不说自己只答了一半。
     *
     * 两处不能偷懒:
     *  - 提示**不进 clip**。塞进被夹的那一段里,它自己就是最先被夹掉的东西。
     *  - 数「装下了几个」要**按码点走**,不能用 `shown.includes(n)` —— `role-1` 是
     *    `role-15` 的子串,子串法会把藏起来的席位数少报。
     * 预算按 names.length 的位数预留(hidden ≤ names.length),所以整行不会超。
     */
    const budget = ROSTER_BUDGET - Array.from(`(另 ${names.length} 席未显示)`).length
    let used = 0
    let visible = 0
    for (const n of names) {
      const add = (visible === 0 ? 0 : 1) + Array.from(n).length // 1 = 「、」
      if (used + add > budget) break
      used += add
      visible++
    }
    // 一个名字就超预算时仍然露出它的头部(带…),比只剩一句「另 N 席未显示」有用。
    const shown = clip(visible > 0 ? names.slice(0, visible).join('、') : names[0]!, budget)
    const hidden = names.length - Math.max(visible, 1)
    return `${PHASE_LABEL[p]}: ${shown}${hidden > 0 ? `(另 ${hidden} 席未显示)` : ''}`
  })
}

/**
 * 定向注入(§定向注入)—— 哪几句话会被送进哪个环节 / 哪一席。
 *
 * **必须上关口。** 这一步是一次抽取模型的判断:它决定「评审时重点看并发安全」这句话到底
 * 进了评审的提示词,还是被当成整体目标留在了根节点上。抽错了的话运行会照常跑完,而用户
 * 唯一能发现的方式是事后翻 node.md —— 而关口存在的全部意义正是「批准之前看见自己批准了
 * 什么」。抽对了同样要显示:那是他确认自己那句话被听懂了的唯一机会。
 *
 * 每条夹到 80 码点(和名册、目标同一份预算),原文在 run.md 里。
 */
export function guidanceLines(config: EffTaskConfig): string[] {
  const out: string[] = []
  for (const p of PHASE_NAMES) {
    const t = config.phaseGuidance?.[p]
    if (t && t.trim().length > 0) out.push(`→「${PHASE_LABEL[p]}」环节: ${clip(t.replace(/\s+/g, ' '), ROSTER_BUDGET)}`)
  }
  for (const g of config.roleGuidance ?? []) {
    if (g.text.trim().length === 0) continue
    /**
     * **名字也要夹、也要剥控制符。**
     *
     * 原来只夹了正文,名字原样插进去 —— 评审用真渲染量到:400 个汉字的名字**全部进帧**,
     * 在 80 列的关口框里折成 9 行,把后面的段落和页脚顶出屏幕;`ESC[41m` 之类也活着进了帧
     * (`\s+ → ' '` 那一步不匹配 U+001B)。
     *
     * `stripControl` 是仓库里现成的那一份 —— `serializeNode` 为一模一样的理由用它。
     */
    out.push(`→ 角色/员工「${clip(stripControl(g.name), ROSTER_BUDGET)}」: ${clip(stripControl(g.text).replace(/\s+/g, ' '), ROSTER_BUDGET)}`)
  }
  return out
}

/**
 * What the user asked for that will NOT happen. Rendered next to the roster on BOTH
 * surfaces: the roster says who runs, this says whose request was dropped and why.
 */
export function noticeLines(config: EffTaskConfig): string[] {
  // Tolerate a config without the field: a run.md written before it existed is read back
  // by the resume path, and a missing notice list must not crash the confirmation view.
  return (config.notices ?? []).map(n => clip(n, 100))
}

/** First non-empty line of the goal, clipped — what both surfaces show as the objective. */
export function goalLine(goalPrompt: string): string {
  return clip(goalPrompt.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '')
}

/** Who answered first. Surfaces use it to render an accurate resolved state. */
export type ConfirmWinner = 'terminal' | 'feishu' | 'cancelled'

/** Told to every surface once the race ends, so each can show WHO decided and WHAT. */
export type SurfaceTeardown = (winner: ConfirmWinner, decision: StartupDecision) => void

/**
 * A surface receives `claim` and a `onTeardown` collector.
 *
 * The collector exists so a surface can register cleanup INCREMENTALLY: if the factory
 * throws halfway through, whatever it already registered (e.g. an entry in the shared
 * Feishu callbacks registry) still gets unwound. Returning a teardown only at the end
 * would leak those registrations into a registry the permission bridge also uses.
 */
export type ConfirmSurface = (
  claim: (winner: ConfirmWinner, d: StartupDecision) => void,
  onTeardown: (fn: SurfaceTeardown) => void,
) => void

// Single-shot claim. claim() both wins the race and delivers the value, so there is no
// way to resolve without having claimed.
export function createResolveOnce<T>(): { claim(v: T): boolean; promise: Promise<T> } {
  let claimed = false
  let resolveFn!: (v: T) => void
  const promise = new Promise<T>(res => { resolveFn = res })
  return {
    claim(v) { if (claimed) return false; claimed = true; resolveFn(v); return true },
    promise,
  }
}

export async function raceConfirm(
  surfaces: ConfirmSurface[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ winner: ConfirmWinner; decision: StartupDecision }> {
  const once = createResolveOnce<{ winner: ConfirmWinner; decision: StartupDecision }>()
  const teardowns: SurfaceTeardown[] = []
  let settled: { winner: ConfirmWinner; decision: StartupDecision } | undefined
  const claim = (winner: ConfirmWinner, decision: StartupDecision) => { once.claim({ winner, decision }) }
  // A surface that registers cleanup asynchronously (in a .then) could otherwise register
  // AFTER the race ended and never be torn down at all — run it immediately instead.
  const collect = (fn: SurfaceTeardown) => {
    if (settled) { try { fn(settled.winner, settled.decision) } catch { /* ignore */ } return }
    teardowns.push(fn)
  }

  let started = 0
  for (const surface of surfaces) {
    // A surface that throws while constructing (e.g. the Feishu send blows up) must NOT
    // kill the race — the others can still win. Anything it already registered via the
    // collector is still torn down below.
    try { surface(claim, collect); started++ } catch { /* skip this surface */ }
  }

  // Nothing is listening, so nothing can ever answer. Fail fast instead of awaiting a
  // promise that no one can settle — raceConfirm is the only place that knows this.
  if (started === 0) claim('cancelled', { parallelism: 0, approved: false })

  const onAbort = () => claim('cancelled', { parallelism: 0, approved: false })
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const result = await once.promise
    settled = result
    // Snapshot before iterating: a teardown that registers another one would otherwise
    // extend the array being walked and loop forever.
    for (const t of teardowns.splice(0)) { try { t(result.winner, result.decision) } catch { /* ignore */ } }
    return result
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Everything the resume gate must disclose, gathered from the four channels the recovery
 * pipeline produces. §17.2 requires the validation summary be shown to the user.
 *
 * It is ONE shape shared by the terminal view and the Feishu card for the same reason
 * `rosterLines` is shared: a Feishu approver who sanctions a resume without seeing what was
 * repaired is approving something different from what the terminal describes.
 */
export interface ResumeSummary {
  runId: string
  counts: { accepted: number; blocked: number; pending: number; total: number }
  /** validateLoadedNodes: what was repaired or blocked. */
  repairs: string[]
  /** reseatTransientNodes: ids returned to a runnable state. */
  reseated: string[]
  /** reseatTransientNodes: ids blocked because the phase they would re-enter has no budget. */
  exhausted: string[]
  /** reseatTransientNodes: ids reopened by `--retry-blocked` (触阀后的人工重试). */
  retried?: string[]
  /** readRunManifest: config that could not be recovered. */
  degraded: string[]
  /** loadRun: node files that could not be parsed. */
  loadErrors: string[]
  /** Guidance carried over from a previous resume, when this invocation supplied none. */
  inheritedGuidance?: string
}

export interface SummarySection { heading: string; lines: string[]; tone: 'info' | 'warn' }

/** Sections for both surfaces. Empty channels are omitted rather than rendered as headings with nothing under them. */
export function resumeSummarySections(s: ResumeSummary): SummarySection[] {
  const out: SummarySection[] = []
  out.push({
    heading: '恢复自 run ' + s.runId,
    lines: [`已验收 ${s.counts.accepted} · 已阻断 ${s.counts.blocked} · 待处理 ${s.counts.pending} · 共 ${s.counts.total}`],
    tone: 'info',
  })
  if (s.reseated.length > 0) {
    out.push({ heading: `重新排队 ${s.reseated.length} 个节点`, lines: s.reseated.slice(0, 8).map(x => clip(x)), tone: 'info' })
  }
  if (s.retried && s.retried.length > 0) {
    // Loud, and its own section. This is the one resume action that re-arms a safety valve —
    // it spends budget the run had already refused to spend, so the gate must not let it
    // slide by inside the ordinary 重新排队 count.
    out.push({
      heading: `--retry-blocked:重开 ${s.retried.length} 个被安全阀停下的节点(该阶段预算已重置)`,
      lines: s.retried.slice(0, 8).map(x => clip(x)), tone: 'warn',
    })
  }
  if (s.exhausted.length > 0) {
    out.push({ heading: `${s.exhausted.length} 个节点预算已耗尽,不再重试`, lines: s.exhausted.slice(0, 8).map(x => clip(x)), tone: 'warn' })
  }
  if (s.repairs.length > 0) {
    out.push({ heading: `校验修复 ${s.repairs.length} 处`, lines: s.repairs.slice(0, 8).map(l => clip(l, 100)), tone: 'warn' })
  }
  if (s.loadErrors.length > 0) {
    // NOT "无法读取": loadRun reports id/directory mismatches through the same channel, and
    // those files read perfectly well. One heading for two different facts sent users looking
    // for a corrupt file that is not corrupt.
    out.push({ heading: `${s.loadErrors.length} 个节点文件有问题(无法读取或 id 与目录不符)`, lines: s.loadErrors.slice(0, 5).map(l => clip(l, 100)), tone: 'warn' })
  }
  if (s.degraded.length > 0) {
    out.push({ heading: '配置未能完整恢复', lines: s.degraded.map(l => clip(l, 100)), tone: 'warn' })
  }
  if (s.inheritedGuidance) {
    // Say it out loud: guidance persists in run.md, so a later `--resume` with no guidance
    // silently re-applies the previous one to everything still unfinished.
    out.push({ heading: '沿用上次的续跑指引', lines: [clip(s.inheritedGuidance, 100)], tone: 'info' })
  }
  return out
}

/**
 * 关口那个并行数编辑器的合法区间 —— **从 types.ts 转出来的,不是自己一份**。
 *
 * 原来这里是三行独立实现,注释写着「mirrors parseDirectives' clamp」——「镜像」两个字
 * 就是漂移的自白:那边写的是 `clampInt(v, 1, 64, DEFAULT_PARALLELISM)`,这边是
 * `Math.trunc(n) || 1`,NaN 时一个给 5 一个给 1。运行中调并发度是**第三条**写入路径,
 * 再抄一遍就有三份。两个消费者(ConfirmStartup / ConfirmResume)的导入路径不动,
 * 所以这里保留转出。
 */
export { MIN_PARALLELISM, MAX_PARALLELISM, clampParallelism } from './types.js'

/**
 * The one place that describes what `parallelism` currently BUYS.
 *
 * Shared by both terminal gates and the Feishu card for the same reason `rosterLines` is:
 * the three surfaces previously carried three separately-worded hardcoded strings, two of
 * which still said "P1 串行执行,此值 P2 生效" after the pool shipped. A gate that describes
 * the run wrongly is the one failure this gate exists to prevent.
 */
export function parallelismLine(
  config: EffTaskConfig,
  opts: { editable: boolean; isolation?: 'worktree' | 'none' },
): string {
  // What this run will ACTUALLY do. Isolation decides whether the execute phase can run in
  // parallel at all, so a fixed sentence is right for one kind of run and a lie for the
  // other — and this line is the one place the user is told.
  //
  // The phase names are this product's own (方案/评审/执行/验收/观察, see PHASE_LABEL). An
  // earlier wording said "读取…阶段并行": 读取 is not a phase here at all — it was a
  // mistranslation of "read-only phases" — and it also claimed 验收 was parallel, which is
  // false for every executable leaf, whose acceptance lives inside stepExecute's
  // execute→accept→rework loop.
  /**
   * 隔离运行还要**先说合并**。
   *
   * 用户批准的是他看到的东西,而这一趟结束时我们会在他的检出里跑一次 `git merge`
   * (工作区干净且正常跑完时)。这句话此前一个字都没有 —— 而在这之前的行为恰恰相反
   * (产出只留在集成分支上,合并要他自己敲),所以不说就是让一次真实的、改动他工作区的
   * 操作凭空出现。
   */
  const scope = opts.isolation === 'worktree'
    ? '各阶段并行,执行任务在各自的 git worktree 中隔离;跑完自动合并回当前分支(工作区不干净或未跑完时改为提示手工合并)'
    : '方案/评审阶段并行;执行与叶子验收串行(未启用隔离)'
  const hint = opts.editable ? ' · ←/→ 调整' : ''
  return `并行数: ${config.parallelism}（${scope}）${hint}`
}

/**
 * 安全阀 line. scoreThreshold is included because it CHANGES BEHAVIOUR: a prompt saying
 * "打分严格些" can turn 观察评分 from record-only into "低分返工一轮", and the gate said
 * nothing about it. A gate that hides a behaviour switch is the failure this gate exists to
 * prevent.
 */
export function capsLine(config: EffTaskConfig): string {
  const c = config.caps
  // 跳过观察时,评分整个不发生 —— 再说「评分低于 N 触发返工」就是承诺一件不会发生的事。
  const scoringOff = (config.skipSteps ?? []).includes('observer')
  const score = scoringOff ? '观察已跳过,不评分'
    : c.scoreThreshold === undefined
    ? '评分不触发返工'
    : `评分低于 ${c.scoreThreshold} 触发一轮返工`
  // 全票是默认;不是全票就必须说出来,这条直接改变「什么算通过」。
  // 「圆桌 60% 通过」至少有三种读法(需 60% 席位赞成 / 圆桌有 60% 概率通过 / 60% 的
  // 圆桌会通过)。文案里必须出现「席位」和「赞成」把语义锁死。
  const parts: string[] = []
  if (c.quorum !== undefined && c.quorum < 100) parts.push(`需 ${c.quorum}% 席位赞成`)
  if (c.quorumSeats !== undefined) parts.push(`需至少 ${c.quorumSeats} 席赞成`)
  const quorum = parts.length > 0 ? ` · 圆桌${parts.join('、')}` : ''
  // 分析的收敛方式同时改变**形态**和**成本**,却在关口上一个字都没有:圆桌和精化两种
  // 配置下这一行此前逐字相同,只有成本数字差一点,而没有任何一句话解释那点差额是什么。
  // 判据和 quorum 一样 —— 改变行为的开关必须说出来,藏起来正是这个关口存在要防的失败。
  // 只在真的会生效时说(≥2 席才有第二稿可融),否则就成了另一种不实承诺。
  const planSeats = (config.phaseRoles?.plan ?? []).length
  const converge = c.planConverge === '圆桌' && planSeats > 1
    ? ` · 分析用圆桌(${planSeats} 人各自起草,末席融合,多 1 次调用)`
    : ''
  /**
   * 静默超时要**上关口**。
   *
   * 它是这一组阀里唯一会让一次**正在正常干活**的调用被中止的那个(其余几个都是
   * 「不再往下走」),也是阻断卡唯一点名让用户去调的那个。此前这一行一个字都没提它 ——
   * 于是「一次调用最多可以多久没动静」这件事,用户只能在被它咬了之后从阻断理由里知道。
   *
   * 只在**不是默认值**时印:默认 10 分钟印出来只是噪声,而这一行已经在跟宽度打架。
   */
  /**
   * **不足一分钟要印秒。**
   *
   * 夹取下限是 1000ms(parseDirectives / resumeCore 两处都是),也就是 1s–59s 是合法可达
   * 区间 —— 而抽取最可能犯的错正是刻度:「阶段超时 20 分钟」被写成 20 而不是 1200000,
   * 夹取**静默**把它抬成 1000。按分钟取整的话关口印的是「静默超时 0 分钟」,而「0 分钟」
   * 读起来是「没有超时」,真相是每次调用一秒内必死。为拦这件事新加的这一行,不能用一个
   * 把它藏起来的数字来汇报它。
   */
  const silence = c.nodeTimeoutMs === DEFAULT_CAPS.nodeTimeoutMs
    ? ''
    : c.nodeTimeoutMs < 60_000
      ? ` · 静默超时 ${Math.round(c.nodeTimeoutMs / 1000)} 秒`
      : ` · 静默超时 ${Math.round(c.nodeTimeoutMs / 60000)} 分钟`
  return `安全阀: 深度${c.maxDepth} / 节点${c.maxNodes} / 迭代${c.maxIterations} · ${score}${quorum}${converge}${silence}`
}

/**
 * 一次 run 最坏情况下要打多少次模型调用。
 *
 * 多对多把调用数**乘**起来,而关口此前只字未提:一个 review 角色配 3 个员工、再加一个
 * accept 角色配 3 个,每个节点每轮就是 6 次而不是 2 次,乘上迭代上限和节点数。用户在
 * 关口上批准的是一份自己看不出代价的配置。
 *
 * **刻意不叫「并发」。** 并发上限是 parallelism,和这个数无关 —— 把排队总量说成在飞数
 * 会让用户以为自己要同时开 30 个连接,从而去调一个不解决问题的旋钮。
 */
/**
 * 单次调用被上游限流时最多重试几次 —— 和 `pipeline.RATE_LIMIT_ATTEMPTS` **必须是同一个数**。
 *
 * 没有从 pipeline 导:那个模块 import 这个模块(startupConfirm)会成环。所以这里放一份
 * 常量,并由 docsAccuracy 里一条断言把两处钉在一起 —— 一份数字两个地方,漂移就是关口
 * 在对用户撒谎。
 */
export const COST_RATE_LIMIT_ATTEMPTS = 3

export function costLine(config: EffTaskConfig): string {
  const c = config.caps
  const seats = (p: PhaseName) => (config.phaseRoles[p] ?? []).length
  // 被跳过的环节一次调用都没有。Math.max(1, seats) 的语义是「没配角色也跑一次主模型」,
  // 跳过时必须绕过它 —— 不绕的话关口高估,用户会去调一个根本不需要调的旋钮。
  const skip = new Set(config.skipSteps ?? [])
  const on = (ph: PhaseName, n: number) => (skip.has(ph) ? 0 : n)
  const It = Math.max(1, c.maxIterations)
  // 方案阶段是**顺序精化**:每一席都是一次串行调用(runPlanRefinement)。写死 1 的话,
  // 配 4 个方案员工在关口上是免费的 —— 而那正是精化要用户知道的代价。
  // 圆桌模式多一次融合调用(只在 ≥2 席时)。
  const planSeats = Math.max(1, seats('plan'))
  const P = on('plan', c.planConverge === '圆桌' && seats('plan') > 1 ? planSeats + 1 : planSeats)
  const R = on('review', Math.max(1, seats('review')))
  const A = on('accept', Math.max(1, seats('accept')))
  // 圆桌**自己**还有一层 infra 重试循环(roundtableWithInfraRetry 最多跑 maxIterations 桌),
  // 所以是 It 的平方,不是一次方。漏掉它会低估约 2.5 倍 —— 实测 1 评审席 + 2 验收席、
  // It=3 时真实 23 次而关口承诺 15 次。低估比高估糟:用户按一个偏小的数批准。
  /**
   * 单点调用(分析席位 + 融合席)自己还有一层**限流重试**:`runPhase` 对 429/529 最多
   * 试 `RATE_LIMIT_ATTEMPTS` 次。圆桌那几席不吃这个乘子(它们直接调 runAgent,由
   * roundtableWithInfraRetry 管),执行和观察也不吃(那两个明确 attempts=1)。
   *
   * 漏掉它的后果和上面那条 It² 逐字同类:实测 3 分析席圆桌 + 3 评审席、每次调用头两遍
   * 429 第三遍成功 → 真实 45 次,而不带这个乘子的式子给出 39。**低估比高估糟**:
   * 用户按一个偏小的数批准。
   */
  const planPhase = It * (P * COST_RATE_LIMIT_ATTEMPTS + It * R)
  // 测试验证是 **opt-in**:没配这个环节的角色,这一步整个不发生。所以用 seats() 原值
  // 而不是 Math.max(1, …) —— 照抄 accept 的写法会让默认配置的关口数字凭空涨一截,
  // 而实际一次调用都不会有。关口高估同样是撒谎,只是方向相反(用户会去调一个根本不
  // 需要调的旋钮)。
  const V = on('verify', seats('verify'))
  // 打分在**每一次验收通过后**都跑,而返工循环可以让验收通过多次。
  const execPhase = It * (on('execute', 1) + (V > 0 ? It * V : 0) + It * A + on('observer', seats('observer')))
  // 集成提交:拆分型节点在子任务全部完成后的那一场,同样有自己的 infra 重试层。
  // 没配就回落到验收席位,不额外计数。
  const integratePhase = on('integrate', It * It * seats('integrate'))
  const perNode = planPhase + execPhase + integratePhase
  const worst = perNode * c.maxNodes
  return `预估上限 ${worst} 次模型调用(每节点最多 ${perNode} 次 × 节点上限 ${c.maxNodes};实际通常远低于此);并发上限仍是 ${config.parallelism}`
}

/**
 * 「最后更新时间」for the resume picker — spec §17.1 lists it as one of the four things the
 * chooser must show (编号、目标首行、状态计数、最后更新时间). `listRuns` already computes it
 * (the max node `updatedAt`), but it was only ever used to sort, never rendered: with several
 * runs the user picked between `003` and `007` on goal text alone, with nothing to say which
 * one they were working on an hour ago.
 *
 * Relative, not absolute, because that is the question being asked — "which one is the one I
 * was just on" — and an ISO timestamp makes the reader do the subtraction.
 *
 * Returns '' for a missing or unparseable value rather than inventing one. `listRuns` starts
 * its accumulator at '' and only replaces it when a node carries a STRING timestamp, so a run
 * whose node.md files were all hand-mangled reaches here empty; and `Date.parse` coerces
 * rather than throwing, which is how a `updatedAt: 123` once rendered a year-1970 age.
 */
export function relativeTime(iso: string, nowMs: number): string {
  if (typeof iso !== 'string' || iso.length === 0) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = Math.round((nowMs - t) / 1000)
  // A clock skew (or a run written by a machine slightly ahead) must not render "-30 分钟前".
  if (secs < 60) return '刚刚'
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`
  return `${Math.floor(secs / 86400)} 天前`
}

/**
 * 非 git 仓库/隔离不可用时,摆在用户面前的**选择** —— spec §8.
 *
 * 「若当前目录非 git 仓库 → 提示用户……并允许选择『改用共享工作目录串行执行』降级
 * (或初始化 git)」。实现只做了自动降级:一行文字被塞进 `notices`,和解析提示词产生的
 * 那些提醒混在同一个「以下请求不会生效」标题下面 —— 那个标题讲的是"你的请求没生效",
 * 而这里发生的是"整个 run 的执行方式变了"。用户能做的只有接受或取消。
 *
 * 返回的是描述这次降级**意味着什么**的几行,而不是一句结论:共享工作目录下执行阶段会被
 * 串行化(orchestrator 的 serialiseExecute),所以慢,但不会有两个 executor 同时改同一份
 * 代码;而 §16 那条最大风险(worktree 合并冲突)在这种模式下根本不存在。
 */
export function isolationChoiceLines(reason: string, canInitGit: boolean): string[] {
  return [
    `隔离不可用:${reason}`,
    '继续的话,执行阶段会共享你当前的工作目录,并被强制串行(一次只有一个节点在改代码)。',
    '方案/评审阶段仍然并行;不会出现两个执行 agent 同时改同一份文件。',
    // The `g` offer appears ONLY when the directory is not a repo at all. Every other pool
    // failure happens after that check passed — no commits yet, a branch-name clash, a
    // worktree already checked out — so the directory IS a repo, and `git init` there would
    // create a NESTED one that shadows it (measured: `git init` in /repo/sub makes
    // `rev-parse --show-toplevel` answer /repo/sub, and nothing here ever cleans that up).
    // In those cases the reason above is the actionable thing, so point at it instead of
    // telling someone already inside a repo to find one.
    // 「不是仓库」和「是仓库但没提交」要说不同的话:对着一个已经在仓库里的人说
    // 「初始化 git 仓库」,他会以为工具没认出他的仓库,从而不敢按。
    canInitGit
      ? (reason.includes('还没有任何提交')
          ? '想要隔离并行执行,可以按 g 建一个空提交(仓库已经有了,只差第一个提交)后重试。'
          : '想要隔离并行执行,可以按 g 在当前目录初始化 git 仓库(会建一个空提交)后重试。')
      : '想要隔离并行执行,需要先解决上面这条原因;也可以取消,处理好之后重新运行 /et。',
  ]
}

/**
 * Did the user actually change the roster at the gate?
 *
 * The gate for `applyRosterToNodes` below. Order counts as a change too: the single-seat
 * phases dispatch `firstRole`, i.e. index 0 and nothing else, so reordering IS reassigning.
 */
export function rosterEquals(
  a: Record<PhaseName, RoleBinding[]>, b: Record<PhaseName, RoleBinding[]>,
): boolean {
  return PHASE_NAMES.every(p => {
    const x = a[p] ?? []
    const y = b[p] ?? []
    // roleTag 也要比:两份名册可以员工名、模型完全相同而角色归属不同(把「架构师」改配
    // 给同一个员工的另一个角色)。漏掉它,rosterEquals 会判定「一样」→ applyRosterToNodes
    // 被跳过 → 节点上留着旧标签 → 每一席收到的职责简报是上一次的。
    return x.length === y.length
      && x.every((r, i) => r.roleName === y[i].roleName && r.model === y[i].model && r.roleTag === y[i].roleTag)
  })
}

/**
 * Push a confirmed roster onto the nodes that will actually dispatch with it.
 *
 * Called ONLY when `rosterEquals` says the user changed something — an unconditional write
 * wiped the live roles off every node.md whenever run.md was unreadable (readRunManifest
 * falls back to an empty roster, while the node files are the surviving truth), and flattened
 * §4.2's per-node override on every resume even when nothing was edited.
 *
 * WITHOUT this the resume gate's roster editor is decorative. Every dispatch site reads
 * `node.phaseRoles`, never `config.phaseRoles`: `firstRole()` for plan/execute/observer, the
 * roundtables for review/accept, and `createChildren`, which copies the parent's roster onto
 * every child it mints. `config.phaseRoles` reaches the tree in exactly one place —
 * `makeRootNode(cfg)` — and that runs only when the orchestrator gets NO seed. A resume always
 * passes a seed, so the edited roster was read by nothing at all.
 *
 * It was worse than inert. `writeRunManifest` persists `cfg.phaseRoles`, so run.md recorded the
 * edit while every node.md kept the old one, and the NEXT resume read that manifest back and
 * showed the user a roster no node was using. An acceptance reviewer reproduced the whole
 * chain: gate edited to `architect`/`qa`, dispatch went to the ghost role the edit was meant
 * to replace.
 *
 * ACCEPTED nodes are left alone, per §17.5's existing stance that a resume 「不修改已 ACCEPTED
 * 的节点」: their review and acceptance records were produced BY the old panel, and rewriting
 * the roster there would misattribute finished work. BLOCKED nodes are updated — they are
 * precisely what `--retry-blocked` reopens, and a retry should use the roster the user just
 * confirmed.
 */
export function applyRosterToNodes(
  nodes: TaskNode[],
  phaseRoles: Record<PhaseName, RoleBinding[]>,
): { changed: number } {
  let changed = 0
  for (const n of nodes) {
    if (n.status === 'ACCEPTED') continue
    // Fresh copies per node: sharing one array would make a later per-node override (§4.2)
    // silently edit every other node's roster.
    n.phaseRoles = Object.fromEntries(
      PHASE_NAMES.map(p => [p, (phaseRoles[p] ?? []).map(r => ({ ...r }))]),
    ) as Record<PhaseName, RoleBinding[]>
    changed++
  }
  return { changed }
}

export interface HandoffSummary {
  branch: string
  commits: number
  kept: { path: string; why: string }[]
  salvage: string[]
  /**
   * Where the integration branch is checked out — and why the user has to be told.
   *
   * The integration worktree is deliberately never reclaimed (`dispose()` only walks the
   * NODES it is handed, and the next run re-adopts this one instead of paying to rebuild it).
   * A checked-out branch cannot be deleted, so the `丢弃:` line below handed the user a
   * command that FAILS — measured against real git:
   *   error: cannot delete branch 'efftask/001/integration' used by worktree at '…'
   * They were also never told this directory exists at all.
   */
  integrationPath?: string
}

/**
 * Where the run's work ended up — spec §8's 收口.
 *
 * A run writes every change to an integration branch and, when something could not be
 * reclaimed, leaves worktrees and salvage refs behind. None of that is anywhere the user
 * looks unless it is said out loud: preserved-and-invisible is indistinguishable from lost.
 *
 * Deliberately does NOT touch the user's checkout. The branch is handed over; what to do
 * with it is theirs to decide.
 */
/**
 * The transcript line `/et` leaves behind when it exits.
 *
 * Extracted from the command's onExit closure because that closure referenced `handoffRef` —
 * an identifier declared inside the React component, NOT inside `call()`. It therefore threw
 * `ReferenceError: handoffRef is not defined` on EVERY exit that had a run id, from inside a
 * `.then()`, so `onDone` was never called and processSlashCommand's promise stayed pending
 * forever — the exact deadlock that file's own comments warn about. Nothing caught it: the
 * file has no tests, and a bare identifier is valid syntax so the parse gate passes it.
 *
 * A pure function with a test is the fix that stays fixed.
 */
export function exitReportLine(args: {
  runId: string
  /** '完成' / '被阻断(…)' / '已取消' / '因界面重建而中断' */
  how: string
  resumed: boolean
  /** False only when the run directory was an unused reservation we just removed. */
  withPath: boolean
  handoff: HandoffSummary | null
  /**
   * 收口的结局。**必须传** —— 这行字进的是对话记录,比 done 视图活得久:面板关掉之后
   * 用户能回看的只剩它。不传的话自动合并成功之后这里仍然写着「你的工作区未被改动」
   * 和「稍后收口: /et --resume … 会重新弹出四选一」,而两句都已经不成立。
   */
  handoffState?: HandoffState
}): string {
  const verb = args.resumed ? '续跑' : ''
  const path = args.withPath ? ` · .claude/efftask/${args.runId}/run.md` : ''
  const where = args.handoff
    ? '\n' + handoffLines(args.handoff, args.runId, args.handoffState).join('\n')
    : ''
  return `高效任务 ${args.runId} ${verb}${args.how}${path}${where}`
}

/**
 * 自动收口这一趟的结局 —— done 视图和退出报告都按它写那句话。
 *
 *  - `'merged'`:产出已经在当前目录里;
 *  - `'conflicted'`:自动合并撞了冲突,**用户的工作区被留在半合并状态**(git 不回滚);
 *  - 省略:没合(脏树 / 没跑完 / 没启用隔离),工作区确实没被动过。
 */
export type HandoffState = 'merged' | 'conflicted'

export function handoffLines(
  h: HandoffSummary,
  runId?: string,
  /**
   * 这一趟收口的结局。
   *
   * 必须影响这一屏的**两句话**,否则它们双双变成可照做的假话:
   *  - 「你的工作区未被改动」—— 合成功时它刚刚被改动了(这正是用户要的那件事);
   *    而**撞冲突时更糟**:工作区里留着冲突标记和 `MERGE_HEAD`,而这一路是自动发生的,
   *    用户没按任何键就被丢进了冲突态;
   *  - 「稍后收口: /et --resume … 会重新弹出四选一」—— 合并成功后 `pendingHandoff` 已经
   *    从 run.md 上清掉了,那条命令进来什么都不会弹。
   */
  state?: HandoffState,
): string[] {
  const merged = state === 'merged'
  const out = [
    h.commits > 0
      ? merged
        ? `本次改动(${h.commits} 个提交)已合并回你当前的分支 —— 产出就在当前目录里;分支 ${h.branch} 保留着`
        : state === 'conflicted'
          ? `自动合并 ${h.branch}(${h.commits} 个提交)撞了冲突,**你的工作区里留着一次未完成的合并**(见上面)`
          : `本次改动已合并到分支 ${h.branch}(${h.commits} 个提交),你的工作区未被改动`
      : `本次没有产生任何改动;分支 ${h.branch} 与起点相同`,
  ]
  if (h.commits > 0) {
    // 现在收口是一个**关口**,不是一串要用户自己敲的命令 —— 但那几行命令仍然保留:
    // 用户可能按 Esc 跳过关口,也可能想手工来。关口是新增的路,不是把旧路拆了。
    if (runId && !merged) out.push(`稍后收口: /et --resume ${runId} 会重新弹出「合并/推送/保留/丢弃」`)
    // 已经合过之后不再印「合并:」—— 再跑一次会得到 `Already up to date.`,而一条什么都
    // 不做的命令摆在这里会让人以为合并还没发生。
    out.push(merged
      ? `查看这一趟的提交: git log ${h.branch}`
      : `查看: git log ${h.branch}   合并: git merge ${h.branch}`)
    // 丢弃 gets its own line because it needs TWO commands. The branch is checked out in the
    // integration worktree, and git refuses to delete a checked-out branch — so the old
    // one-liner `git branch -D <branch>` printed here always failed. Verified against real
    // git: "error: cannot delete branch … used by worktree at …". Printing a command that
    // cannot work is worse than printing none: the user reads it as the supported way out.
    out.push(h.integrationPath
      ? `丢弃: git worktree remove ${h.integrationPath} && git branch -D ${h.branch}`
      : `丢弃: git branch -D ${h.branch}(若提示分支被 worktree 占用,先 git worktree remove 该路径)`)
  }
  // Said out loud even when there is nothing to discard: this directory is created inside the
  // user's repo and outlives every run, and nothing else ever mentions it.
  if (h.integrationPath) out.push(`集成工作区(下次运行会复用): ${h.integrationPath}`)
  for (const k of h.kept) out.push(`保留的工作区(${k.why}): ${k.path}`)
  for (const s of h.salvage) out.push(`中断时抢救出的提交: ${s}`)
  return out
}
