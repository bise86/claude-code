import { PHASE_NAMES } from './types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from './types.js'

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
 * Toggle one role on a phase, returning a NEW roster.
 *
 * Pure so the gate's edit logic is testable without mounting anything — the gate itself is
 * keyboard plumbing around this.
 *
 * `observer` is deliberately allowed to be empty and everything else is too: an empty phase
 * means 主模型 (and, for observer, "no scoring at all"), which rosterLines already renders
 * correctly. Refusing to empty a phase would make the editor unable to undo its own additions.
 */
/**
 * Phases that run a ROUNDTABLE — every bound role is dispatched, in parallel, and all must
 * pass. Everything else runs `firstRole`, i.e. index 0 and nothing else.
 *
 * parseDirectives already trims the single-seat phases to one and pushes a notice, with the
 * reason in its own comment: "listing extra seats there would put names on the confirmation
 * roster that never get called — the gate must show who actually runs". The editor has to
 * honour the same invariant or it re-opens exactly that hole by hand.
 */
export const MULTI_ROLE_PHASES: ReadonlySet<PhaseName> = new Set<PhaseName>(['review', 'accept'])

export function toggleRole(
  roster: Record<PhaseName, RoleBinding[]>, phase: PhaseName, roleName: string, model?: string,
): Record<PhaseName, RoleBinding[]> {
  const cur = roster[phase] ?? []
  const has = cur.some(r => r.roleName === roleName)
  // Copy every phase's ARRAY, not just the outer record: TaskNode.createNode copies these per
  // node, and a shared array instance would let one edit reach the whole tree.
  const next = Object.fromEntries(
    PHASE_NAMES.map(p => [p, [...(roster[p] ?? [])]]),
  ) as Record<PhaseName, RoleBinding[]>
  const binding: RoleBinding = model ? { roleName, model } : { roleName }
  next[phase] = has
    ? cur.filter(r => r.roleName !== roleName)
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
    const bound = new Set((roster[p] ?? []).map(r => r.roleName))
    const label = PHASE_LABEL[p]
    const empty = bound.size === 0 ? (p === 'observer' ? ' (不评分)' : ' (主模型)') : ''
    const seats = MULTI_ROLE_PHASES.has(p) ? '' : '(单选)'
    if (available.length === 0) {
      // Say WHY rather than render an empty row: with no roles available there is nothing to
      // edit, and a blank line reads as a broken editor.
      return `${i === phaseIdx ? '▶' : ' '} ${label}${empty}: (没有可用角色,本阶段用主模型)`
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
    return `${i === phaseIdx ? '▶' : ' '} ${label}${seats}${empty}: ${cells.join(' ')}${more ? ' ' + more : ''}`
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
    const names = config.phaseRoles[p].map(r => (r.model ? `${r.roleName}(${r.model})` : r.roleName))
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
    out.push({ heading: `${s.loadErrors.length} 个节点文件无法读取`, lines: s.loadErrors.slice(0, 5).map(l => clip(l, 100)), tone: 'warn' })
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
  return `安全阀: 深度${c.maxDepth} / 节点${c.maxNodes} / 迭代${c.maxIterations} · ${score}`
}

export interface HandoffSummary {
  branch: string
  commits: number
  kept: { path: string; why: string }[]
  salvage: string[]
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
  const where = args.handoff ? '\n' + handoffLines(args.handoff).join('\n') : ''
  return `高效任务 ${args.runId} ${verb}${args.how}${path}${where}`
}

export function handoffLines(h: HandoffSummary): string[] {
  const out = [
    h.commits > 0
      ? `本次改动已合并到分支 ${h.branch}(${h.commits} 个提交),你的工作区未被改动`
      : `本次没有产生任何改动;分支 ${h.branch} 与起点相同`,
  ]
  if (h.commits > 0) {
    out.push(`查看: git log ${h.branch}   合并: git merge ${h.branch}   丢弃: git branch -D ${h.branch}`)
  }
  for (const k of h.kept) out.push(`保留的工作区(${k.why}): ${k.path}`)
  for (const s of h.salvage) out.push(`中断时抢救出的提交: ${s}`)
  return out
}
