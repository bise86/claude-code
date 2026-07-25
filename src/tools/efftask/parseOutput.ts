// src/tools/efftask/parseOutput.ts
import type { NodeKind, NodePlan, Verdict } from './types.js'

// LAST-FENCE RULE: a phase transcript is multi-turn and the model routinely ECHOES the
// prompt (which itself contains a JSON plan/verdict) before answering. The phase's actual
// answer is therefore the LAST fenced block, not the first. Scan every fence and try them
// from last to first; only if no fence parses do we fall back to the bare
// first-brace..last-brace slice.
export function extractJsonBlock(text: string): unknown | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1])
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i].trim()) } catch { /* try the previous fence */ }
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1).trim()) } catch { /* fall through */ }
  }
  return null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
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
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
  if (!obj || typeof obj.pass !== 'boolean') {
    return { role, pass: false, blocking: ['无法解析该角色的裁决输出;按不通过处理'], comments: text.trim().slice(0, 2000) }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string): { execStatus: string } {
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
  if (obj && typeof obj.execStatus === 'string') return { execStatus: obj.execStatus }
  return { execStatus: text.trim() }
}
