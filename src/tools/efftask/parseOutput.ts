// src/tools/efftask/parseOutput.ts
import type { NodeKind, NodePlan, Verdict } from './types.js'

/**
 * Candidate JSON objects found in a phase transcript, best-first.
 *
 * A phase transcript is multi-turn and messy. Models ECHO the prompt (which itself
 * contains a JSON plan/verdict) before answering, and just as often RECAP context
 * AFTER answering. So "the last thing that happens to parse as JSON" is not a safe
 * selector on its own: picking a trailing recap over the real verdict silently
 * flips a fail into a pass. Callers therefore ask for the newest candidate that
 * MATCHES THE SHAPE THEY EXPECT (see pickShaped) rather than taking whatever parses.
 *
 * Ordering: json-tagged fences newest-first, then untagged fences newest-first,
 * then the bare first-brace..last-brace slice as a last resort. An explicitly
 * ```json-tagged block is a stronger signal of "this is my answer" than a stray
 * ```ts/```bash block that happens to contain parseable JSON.
 */
export function extractJsonCandidates(text: string): unknown[] {
  const tagged: string[] = []
  const untagged: string[] = []
  for (const m of text.matchAll(/```(json)?[ \t]*\r?\n?([\s\S]*?)```/gi)) {
    ;(m[1] ? tagged : untagged).push(m[2])
  }
  const out: unknown[] = []
  const tryPush = (raw: string): void => {
    try { out.push(JSON.parse(raw.trim())) } catch { /* not JSON; skip this candidate */ }
  }
  for (let i = tagged.length - 1; i >= 0; i--) tryPush(tagged[i])
  for (let i = untagged.length - 1; i >= 0; i--) tryPush(untagged[i])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) tryPush(text.slice(first, last + 1))
  return out
}

/** The best candidate with no shape requirement. Prefer pickShaped when you know the shape. */
export function extractJsonBlock(text: string): unknown | null {
  return extractJsonCandidates(text)[0] ?? null
}

/**
 * Newest candidate that looks like the object the caller is asking for. Without the
 * shape guard, a trailing echo of the *goal* would be accepted as a *plan*, and a
 * recap of a *previous* verdict would be accepted as *this* verdict.
 */
function pickShaped(text: string, matches: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  for (const c of extractJsonCandidates(text)) {
    if (c && typeof c === 'object' && !Array.isArray(c) && matches(c as Record<string, unknown>)) {
      return c as Record<string, unknown>
    }
  }
  return null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  // A plan must carry at least one plan-ish key; a bare echo of the goal has none.
  const obj = pickShaped(text, o => 'solution' in o || 'kind' in o || 'children' in o)
  const plan: NodePlan = {
    solution: str(obj?.solution, text.trim()),
    keyPoints: str(obj?.keyPoints),
    risks: str(obj?.risks),
    acceptance: str(obj?.acceptance),
  }
  const rawChildren = Array.isArray(obj?.children) ? (obj!.children as unknown[]) : []
  const children = rawChildren
    .map(c => {
      const co = c as Record<string, unknown>
      return { title: str(co?.title).trim(), deps: Array.isArray(co?.deps) ? (co!.deps as unknown[]).map(d => str(d)).filter(Boolean) : [] }
    })
    .filter(c => c.title.length > 0)
  const kind: NodeKind = obj?.kind === 'decompose' && children.length > 0 ? 'decompose' : 'executable'
  return { kind, plan, children }
}

export function parseVerdict(text: string, role: string): Verdict {
  // Only an object with a boolean `pass` is a verdict. Anything else (an echoed
  // plan, a restated goal) must NOT be read as one — falling through to the
  // unparseable branch fails closed instead of inventing a pass.
  const obj = pickShaped(text, o => typeof o.pass === 'boolean')
  if (!obj) {
    return { role, pass: false, blocking: ['无法解析该角色的裁决输出;按不通过处理'], comments: text.trim().slice(0, 2000) }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string): { execStatus: string } {
  const obj = pickShaped(text, o => typeof o.execStatus === 'string')
  if (obj) return { execStatus: str(obj.execStatus) }
  return { execStatus: text.trim() }
}
