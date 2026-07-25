import { PHASE_NAMES } from './types.js'
import type { EffTaskConfig, PhaseName } from './types.js'

export interface StartupDecision { parallelism: number; approved: boolean }

const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

// The ACTUAL roster (spec gate-1 角色名册): each phase → its bound role names, or 主模型
// when the phase has no bindings. Shared by the terminal card AND the Feishu card so the
// two surfaces can never disagree about who is on the panel.
export function rosterLines(config: EffTaskConfig): string[] {
  return PHASE_NAMES.map(p => {
    // Show the bound model too: this gate exists to let the user see exactly who is on the
    // panel, and "coder" alone hides which model that role actually runs on.
    const names = config.phaseRoles[p].map(r => (r.model ? `${r.roleName}(${r.model})` : r.roleName))
    const joined = names.length > 0 ? names.join('、') : '主模型'
    // Same 80-char budget the goal line uses, so one long roster can't wreck the layout.
    const clipped = Array.from(joined).length > 80 ? `${Array.from(joined).slice(0, 79).join('')}…` : joined
    return `${PHASE_LABEL[p]}: ${clipped}`
  })
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
  const claim = (winner: ConfirmWinner, decision: StartupDecision) => { once.claim({ winner, decision }) }
  const collect = (fn: SurfaceTeardown) => { teardowns.push(fn) }

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
    for (const t of teardowns) { try { t(result.winner, result.decision) } catch { /* ignore */ } }
    return result
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
