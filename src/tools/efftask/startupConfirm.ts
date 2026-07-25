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
    // The observer phase is P3: nothing consults it, so naming ANY occupant — a role or
    // "主模型" — would put a seat on the panel that never speaks. Say it plainly instead.
    if (p === 'observer') return `${PHASE_LABEL[p]}: (评分本期未启用)`
    // Show the bound model too: this gate exists to let the user see exactly who is on the
    // panel, and "coder" alone hides which model that role actually runs on.
    const names = config.phaseRoles[p].map(r => (r.model ? `${r.roleName}(${r.model})` : r.roleName))
    // Same 80-code-point budget as the goal line, so one long roster can't wreck the layout.
    return `${PHASE_LABEL[p]}: ${clip(names.length > 0 ? names.join('、') : '主模型')}`
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
