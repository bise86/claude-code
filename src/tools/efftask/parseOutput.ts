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

/**
 * A per-call answer tag: the base tag plus random letters, e.g. `verdictqxrtplbz`.
 *
 * Defence in depth against a planted verdict. Evidence shown to a reviewer is written by
 * another agent, so a plain `verdict` tag is guessable and forgeable: an executor can embed
 * a ```verdict block claiming pass:true, and if the reviewer answers in prose that planted
 * block is the only tagged verdict in the reply. An agent cannot plant a tag it has never
 * seen. (Fences are also neutralised on the way in — see quote() in pipeline.ts — so this
 * is the second lock, not the only one.)
 *
 * Letters only: FENCE_RE captures `[A-Za-z]+`.
 */
export function answerTag(base: AnswerTag): string {
  // Crypto randomness, not Math.random: this tag is the control the whole
  // forged-verdict defence rests on, and a predictable PRNG stream would make it guessable.
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  let n = ''
  for (const b of bytes) n += String.fromCharCode(97 + (b % 26))
  return `${base}${n}`
}

type Candidate = { obj: Record<string, unknown>; tagged: boolean }

/** Every fenced block plus the bare-brace slice, parsed; unparseable ones dropped. */
/**
 * Fenced blocks, anchored to line starts.
 *
 * Without the anchor, ANY stray ``` run earlier in the reply pairs with the answer's own
 * opening fence and swallows it. A reviewer that mentions the tag inline before answering —
 * which is a normal thing to do — then looks like it produced no block at all, and since
 * verdicts have no fallback (see pickAnswer's requireTag) that reads as "no verdict" and
 * blocks a node whose reviewer actually passed it.
 */
const FENCE_RE = /(?:^|\n)[ \t]*```([A-Za-z]+)?[ \t]*\r?\n([\s\S]*?)\n[ \t]*```/g

/**
 * First balanced `{...}` that is NOT nested inside an array, or null.
 *
 * Naive first-`{`..last-`}` slicing cannot see brackets, so on prose like
 * `这是配置: [{"pass":true}]` it happily lifts an element out of a JSON array and
 * hands it back as the model's answer — which is how a rejected verdict became an
 * accepted one. Tracking bracket depth (and string literals, so a brace inside a
 * quoted value doesn't confuse the scan) is what makes the repair safe.
 */
function sliceTopLevelObject(t: string): string | null {
  let inStr = false
  let esc = false
  let bracket = 0
  let brace = 0
  let start = -1
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    else if (ch === '[') bracket++
    else if (ch === ']') { if (bracket > 0) bracket-- }
    else if (ch === '{') {
      if (brace === 0 && bracket === 0) start = i
      brace++
    } else if (ch === '}') {
      if (brace > 0) brace--
      if (brace === 0 && start !== -1) return t.slice(start, i + 1)
    }
  }
  return null
}

function collectCandidates(text: string, preferTag?: string): Candidate[] {
  const tagged: string[] = []
  const generic: string[] = []
  for (const m of text.matchAll(FENCE_RE)) {
    const tag = (m[1] ?? '').toLowerCase()
    if (preferTag && tag === preferTag) tagged.push(m[2])
    else generic.push(m[2])
  }
  const out: Candidate[] = []
  const seen = new Set<string>()
  const consider = (raw: string, isTagged: boolean): void => {
    const t = raw.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      // Unparseable: try to salvage an object out of surrounding prose. This is a
      // REPAIR for broken text, never a way to reach inside valid JSON — it only
      // runs when the source failed to parse at all, and it refuses objects that
      // sit inside an array.
      const slice = sliceTopLevelObject(t)
      if (slice === null) return
      try { parsed = JSON.parse(slice) } catch { return }
    }
    // Valid JSON that isn't a plain object (an array, a number, a string) is not
    // an answer. Disqualify the whole source rather than digging into it: an
    // object inside an array is an element, not the model's reply.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const key = `${isTagged}:${JSON.stringify(parsed)}`
    if (seen.has(key)) return // the whole-text pass often re-captures a fence
    seen.add(key)
    out.push({ obj: parsed as Record<string, unknown>, tagged: isTagged })
  }
  // Newest first within each group: a correction supersedes an earlier draft.
  for (let i = tagged.length - 1; i >= 0; i--) consider(tagged[i], true)
  for (let i = generic.length - 1; i >= 0; i--) consider(generic[i], false)
  // Finally, prose OUTSIDE every fence — a model that answered without any fence.
  // Fenced regions are stripped first: their contents were already judged above on
  // their own terms, and re-slicing across them would mine an object out of a fence
  // whose real content is an array (an element is not an answer).
  consider(text.replace(FENCE_RE, ' '), false)
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
  tag: string,
  matches: (o: Record<string, unknown>) => boolean,
  // When true, ONLY a block carrying `tag` counts. Used for verdicts, where the prompt
  // hands the model an unguessable per-call tag: anything else in the reply is quoted
  // context, and quoted context is attacker-controlled (a node's execStatus is written by
  // another agent and shown to the reviewer as evidence). Falling back to "any object of
  // the right shape anywhere in the reply" lets that evidence BE the verdict.
  requireTag = false,
): { obj: Record<string, unknown> | null; ambiguous: boolean } {
  const candidates = collectCandidates(text, tag).filter(c => matches(c.obj))
  const tagged = candidates.filter(c => c.tagged)
  if (requireTag) return { obj: tagged[0]?.obj ?? null, ambiguous: tagged.length > 1 }
  // Duplicates are ambiguous in BOTH groups. The tag says "this is my answer", so
  // two of them is still two answers — a model that re-tags a recap of a stale
  // verdict would otherwise win on recency, which is the exact failure this tag
  // was introduced to stop. Never let "it's tagged" substitute for "it's the only one".
  if (tagged.length > 0) return { obj: tagged[0].obj, ambiguous: tagged.length > 1 }
  if (candidates.length === 0) return { obj: null, ambiguous: false }
  // Untagged: the model ignored the output contract. One block is unambiguous;
  // several of the same shape are not — we cannot tell the answer from a recap.
  // A malformed (unparseable) tagged block lands here too: it never became a
  // candidate, so an honest typo degrades to the same tolerance as no tag at all.
  return { obj: candidates[0].obj, ambiguous: candidates.length > 1 }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string, tag: string = ANSWER_TAGS.plan): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  // A plan carries at least one plan-ish key; a bare echo of the goal has none.
  // Ambiguity is tolerated here: a wrong plan is caught by the review roundtable.
  const { obj } = pickAnswer(text, tag, o => 'solution' in o || 'kind' in o || 'children' in o)
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

export function parseVerdict(text: string, role: string, tag?: string): Verdict {
  // FAIL CLOSED. A verdict is the one output where guessing wrong in the "pass"
  // direction lets unfinished work through, so anything short of one unmistakable
  // verdict — none found, or two same-shaped blocks we cannot rank — is a rejection.
  // Costing an iteration is recoverable; silently accepting a stale pass is not.
  //
  // When the caller supplied a per-call tag, the prompt told the reviewer that exact,
  // unguessable string, so ONLY a block carrying it is this reviewer's answer. Everything
  // else in the reply is quoted context — and context is attacker-controlled: a node's
  // execStatus is written by another agent and shown to the reviewer as evidence, so a
  // planted `{"pass":true}` there would otherwise be read as the verdict itself.
  const expected = tag ?? ANSWER_TAGS.verdict
  const { obj, ambiguous } = pickAnswer(text, expected, o => typeof o.pass === 'boolean', tag !== undefined)
  if (!obj) {
    return {
      role,
      pass: false,
      // Do NOT name the tag here: this string becomes blockingSummary, which the rework
      // prompt shows the EXECUTOR. Handing it a live tag is handing it the forgery key.
      blocking: ['未按要求输出本轮的裁决代码块;按不通过处理'],
      comments: text.trim().slice(0, 2000),
    }
  }
  if (ambiguous) {
    return {
      role,
      pass: false,
      blocking: ['回复中有多个裁决块,无法判定哪个是本轮结论;请只输出一个本轮要求的裁决块'],
      comments: text.trim().slice(0, 2000),
    }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string, tag: string = ANSWER_TAGS.exec): { execStatus: string } {
  const { obj } = pickAnswer(text, tag, o => typeof o.execStatus === 'string')
  if (obj) return { execStatus: str(obj.execStatus) }
  return { execStatus: text.trim() }
}
