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
    const names = config.phaseRoles[p].map(r => r.roleName)
    return `${PHASE_LABEL[p]}: ${names.length > 0 ? names.join('、') : '主模型'}`
  })
}

export function createResolveOnce<T>(): { claim(): boolean; resolve(v: T): void; promise: Promise<T> } {
  let claimed = false
  let resolveFn!: (v: T) => void
  const promise = new Promise<T>(res => { resolveFn = res })
  return {
    claim() { if (claimed) return false; claimed = true; return true },
    resolve(v) { resolveFn(v) },
    promise,
  }
}

export async function raceConfirm(
  surfaces: Array<(claimAndResolve: (d: StartupDecision) => void) => () => void>,
): Promise<StartupDecision> {
  const once = createResolveOnce<StartupDecision>()
  const teardowns: Array<() => void> = []
  const claimAndResolve = (d: StartupDecision) => { if (once.claim()) once.resolve(d) }
  for (const surface of surfaces) {
    // A surface that throws while constructing (e.g. Feishu send blows up) must NOT kill
    // the race — the other surfaces can still win. Only successful ones get a teardown.
    try { teardowns.push(surface(claimAndResolve)) } catch { /* skip this surface */ }
  }
  const decision = await once.promise
  for (const t of teardowns) { try { t() } catch { /* ignore */ } }
  return decision
}
