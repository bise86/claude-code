import { DEFAULT_MAX_SEATS_PER_PHASE, PHASE_NAMES } from './types.js'
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

const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

// The ACTUAL roster (spec gate-1 角色名册): each phase → its bound role names, or 主模型
// when the phase has no bindings. Shared by the terminal card AND the Feishu card so the
// two surfaces can never disagree about who is on the panel.
/**
 * Truncate to `max` CODE POINTS. A raw .slice() counts UTF-16 units and can cut an emoji
 * in half, emitting a lone surrogate into a card payload and the terminal.
 */
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
    const lockedPrefix = locked.length > 0 ? `〔角色定义:${locked.join('、')}〕` : ''
    const seats = MULTI_ROLE_PHASES.has(p) ? '' : '(单选)'
    if (available.length === 0) {
      // Say WHY rather than render an empty row: with no roles available there is nothing to
      // edit, and a blank line reads as a broken editor.
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
    return `${i === phaseIdx ? '▶' : ' '} ${label}${seats}${empty}: ${lockedPrefix}${cells.join(' ')}${more ? ' ' + more : ''}`
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

export function rosterLines(config: EffTaskConfig): string[] {
  return PHASE_NAMES.map(p => {
    // Scoring is OPT-IN: with no observer role nothing scores, and it does NOT fall back to
    // the main model the way the other phases do. Saying 主模型 here would promise a scorer
    // that never runs.
    if (p === 'observer' && config.phaseRoles.observer.length === 0) {
      return `${PHASE_LABEL[p]}: (未配置,不评分)`
    }
    // Show the bound model too: this gate exists to let the user see exactly who is on the
    // panel, and "coder" alone hides which model that role actually runs on.
    const names = config.phaseRoles[p].map(r => {
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
    return `${PHASE_LABEL[p]}: ${clip(names.length > 0 ? names.join('、') : bare)}`
  })
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

/** Hard bounds for the confirmation gate's parallelism editor; mirrors parseDirectives' clamp. */
export const MIN_PARALLELISM = 1
export const MAX_PARALLELISM = 64
export const clampParallelism = (n: number): number =>
  Math.min(MAX_PARALLELISM, Math.max(MIN_PARALLELISM, Math.trunc(n) || MIN_PARALLELISM))

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
  const scope = opts.isolation === 'worktree'
    ? '各阶段并行,执行任务在各自的 git worktree 中隔离'
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
  const score = c.scoreThreshold === undefined
    ? '评分不触发返工'
    : `评分低于 ${c.scoreThreshold} 触发一轮返工`
  // 全票是默认;不是全票就必须说出来,这条直接改变「什么算通过」。
  // 「圆桌 60% 通过」至少有三种读法(需 60% 席位赞成 / 圆桌有 60% 概率通过 / 60% 的
  // 圆桌会通过)。文案里必须出现「席位」和「赞成」把语义锁死。
  const parts: string[] = []
  if (c.quorum !== undefined && c.quorum < 100) parts.push(`需 ${c.quorum}% 席位赞成`)
  if (c.quorumSeats !== undefined) parts.push(`需至少 ${c.quorumSeats} 席赞成`)
  const quorum = parts.length > 0 ? ` · 圆桌${parts.join('、')}` : ''
  return `安全阀: 深度${c.maxDepth} / 节点${c.maxNodes} / 迭代${c.maxIterations} · ${score}${quorum}`
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
export function costLine(config: EffTaskConfig): string {
  const c = config.caps
  const seats = (p: PhaseName) => config.phaseRoles[p].length
  const It = Math.max(1, c.maxIterations)
  // 方案阶段是**顺序精化**:每一席都是一次串行调用(runPlanRefinement)。写死 1 的话,
  // 配 4 个方案员工在关口上是免费的 —— 而那正是精化要用户知道的代价。
  const P = Math.max(1, seats('plan'))
  const R = Math.max(1, seats('review'))
  const A = Math.max(1, seats('accept'))
  // 圆桌**自己**还有一层 infra 重试循环(roundtableWithInfraRetry 最多跑 maxIterations 桌),
  // 所以是 It 的平方,不是一次方。漏掉它会低估约 2.5 倍 —— 实测 1 评审席 + 2 验收席、
  // It=3 时真实 23 次而关口承诺 15 次。低估比高估糟:用户按一个偏小的数批准。
  const planPhase = It * (P + It * R)
  // 打分在**每一次验收通过后**都跑,而返工循环可以让验收通过多次。
  const execPhase = It * (1 + It * A + seats('observer'))
  const perNode = planPhase + execPhase
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
    canInitGit
      ? '想要隔离并行执行,可以按 g 在当前目录初始化 git 仓库(会建一个空提交)后重试。'
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
      PHASE_NAMES.map(p => [p, phaseRoles[p].map(r => ({ ...r }))]),
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
}): string {
  const verb = args.resumed ? '续跑' : ''
  const path = args.withPath ? ` · .claude/efftask/${args.runId}/run.md` : ''
  const where = args.handoff ? '\n' + handoffLines(args.handoff, args.runId).join('\n') : ''
  return `高效任务 ${args.runId} ${verb}${args.how}${path}${where}`
}

export function handoffLines(h: HandoffSummary, runId?: string): string[] {
  const out = [
    h.commits > 0
      ? `本次改动已合并到分支 ${h.branch}(${h.commits} 个提交),你的工作区未被改动`
      : `本次没有产生任何改动;分支 ${h.branch} 与起点相同`,
  ]
  if (h.commits > 0) {
    // 现在收口是一个**关口**,不是一串要用户自己敲的命令 —— 但那几行命令仍然保留:
    // 用户可能按 Esc 跳过关口,也可能想手工来。关口是新增的路,不是把旧路拆了。
    if (runId) out.push(`稍后收口: /et --resume ${runId} 会重新弹出「合并/推送/保留/丢弃」`)
    out.push(`查看: git log ${h.branch}   合并: git merge ${h.branch}`)
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
