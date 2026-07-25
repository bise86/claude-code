import { PHASE_NAMES } from './types.js'
import type { EffTaskConfig, PhaseName } from './types.js'

export interface StartupDecision { parallelism: number; approved: boolean }

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
export function parallelismLine(config: EffTaskConfig, opts: { editable: boolean }): string {
  const hint = opts.editable ? ' · ←/→ 调整' : ''
  // Name the phases THIS product has (方案/评审/执行/验收/观察 — see PHASE_LABEL above), and
  // only the ones measurably parallel:
  //   方案 / 评审  → stepStart, dispatched straight into the pool                → parallel
  //   执行 / 验收  → BOTH live in stepExecute's execute→accept→rework for(;;) loop,
  //                  and that whole loop is what goes on the serial chain          → serial
  //   集成验收     → stepIntegrate, in the pool, but only for decompose nodes
  // An earlier wording said "读取…验收阶段并行". 读取 is not a phase of this product at all
  // (it was a mistranslation of "read-only phases"), and 验收 is serial for every executable
  // leaf — measured peak accept concurrency 1 at parallelism 20.
  return `并行数: ${config.parallelism}（方案/评审阶段并行;执行与叶子验收串行,隔离见 P2b 计划）${hint}`
}
