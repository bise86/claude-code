// src/tools/efftask/parseOutput.ts
import type { NodeKind, NodePlan, Verdict } from './types.js'

/**
 * Fence tag each phase must wrap ITS ANSWER in. Generic ```json is reserved for
 * quoted context, so an answer is distinguishable from a recap of one.
 *
 * Selecting a block by "parses as JSON" or "is the newest" is not safe on its own.
 * Models echo the prompt before answering AND recap context after answering, and a
 * recap of a previous verdict has the same shape as this one's — so shape and
 * recency both mis-select it, silently turning a fail into a pass. The tag is what
 * actually separates answer from quotation.
 */
export const ANSWER_TAGS = { plan: 'plan', verdict: 'verdict', exec: 'exec' } as const
export type AnswerTag = (typeof ANSWER_TAGS)[keyof typeof ANSWER_TAGS]

type Candidate = { obj: Record<string, unknown>; tagged: boolean }

/** Every fenced block plus the bare-brace slice, parsed; unparseable ones dropped. */
function collectCandidates(text: string, preferTag?: AnswerTag): Candidate[] {
  const tagged: string[] = []
  const generic: string[] = []
  for (const m of text.matchAll(/```([A-Za-z]+)?[ \t]*\r?\n?([\s\S]*?)```/g)) {
    const tag = (m[1] ?? '').toLowerCase()
    if (preferTag && tag === preferTag) tagged.push(m[2])
    else generic.push(m[2])
  }
  const out: Candidate[] = []
  const seen = new Set<string>()
  const tryPush = (raw: string, isTagged: boolean): void => {
    let parsed: unknown
    try { parsed = JSON.parse(raw.trim()) } catch { return } // not JSON; skip
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const key = `${isTagged}:${raw.trim()}`
    if (seen.has(key)) return // the bare-brace slice often re-captures a fence
    seen.add(key)
    out.push({ obj: parsed as Record<string, unknown>, tagged: isTagged })
  }
  // Newest first within each group: a correction supersedes an earlier draft.
  for (let i = tagged.length - 1; i >= 0; i--) tryPush(tagged[i], true)
  for (let i = generic.length - 1; i >= 0; i--) tryPush(generic[i], false)
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) tryPush(text.slice(first, last + 1), false)
  return out
}

/** Best-effort object extraction with no shape or tag requirement. */
export function extractJsonBlock(text: string): unknown | null {
  return collectCandidates(text)[0]?.obj ?? null
}

/**
 * Answer selection: prefer the properly tagged answer; fall back to any block of
 * the right shape. Returns `ambiguous` when the fallback cannot tell two same-shaped
 * blocks apart, so safety-critical callers can fail closed instead of guessing.
 */
function pickAnswer(
  text: string,
  tag: AnswerTag,
  matches: (o: Record<string, unknown>) => boolean,
): { obj: Record<string, unknown> | null; ambiguous: boolean } {
  const candidates = collectCandidates(text, tag).filter(c => matches(c.obj))
  const tagged = candidates.filter(c => c.tagged)
  if (tagged.length > 0) return { obj: tagged[0].obj, ambiguous: false }
  if (candidates.length === 0) return { obj: null, ambiguous: false }
  // Untagged: the model ignored the output contract. One block is unambiguous;
  // several of the same shape are not — we cannot tell the answer from a recap.
  return { obj: candidates[0].obj, ambiguous: candidates.length > 1 }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  // A plan carries at least one plan-ish key; a bare echo of the goal has none.
  // Ambiguity is tolerated here: a wrong plan is caught by the review roundtable.
  const { obj } = pickAnswer(text, ANSWER_TAGS.plan, o => 'solution' in o || 'kind' in o || 'children' in o)
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
  // FAIL CLOSED. A verdict is the one output where guessing wrong in the "pass"
  // direction lets unfinished work through, so anything short of one unmistakable
  // verdict — none found, or two same-shaped blocks we cannot rank — is a rejection.
  // Costing an iteration is recoverable; silently accepting a stale pass is not.
  const { obj, ambiguous } = pickAnswer(text, ANSWER_TAGS.verdict, o => typeof o.pass === 'boolean')
  if (!obj) {
    return { role, pass: false, blocking: ['无法解析该角色的裁决输出;按不通过处理'], comments: text.trim().slice(0, 2000) }
  }
  if (ambiguous) {
    return {
      role,
      pass: false,
      blocking: [`回复中有多个未标记的裁决块,无法判定哪个是本轮结论;请只输出一个 \`\`\`${ANSWER_TAGS.verdict} 块`],
      comments: text.trim().slice(0, 2000),
    }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string): { execStatus: string } {
  const { obj } = pickAnswer(text, ANSWER_TAGS.exec, o => typeof o.execStatus === 'string')
  if (obj) return { execStatus: str(obj.execStatus) }
  return { execStatus: text.trim() }
}
