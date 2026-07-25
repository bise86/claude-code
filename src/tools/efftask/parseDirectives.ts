// src/tools/efftask/parseDirectives.ts
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { Caps, EffTaskConfig, PhaseName, RoleBinding } from './types.js'
import { extractJsonBlock } from './parseOutput.js'

export type ModelJsonFn = (prompt: string) => Promise<string>

const EXTRACT_PROMPT = `你是配置解析器。把下面的"高效任务"指令抽成 JSON,只输出一个 json 代码块,字段:
{ "parallelism": number, "phaseRoles": { "plan"?: string[], "review"?: string[], "execute"?: string[], "accept"?: string[], "observer"?: string[] },
  "caps": { "maxDepth"?: number, "maxNodes"?: number, "maxIterations"?: number } }
phaseRoles 的值是角色名数组。未提及的字段省略。指令:\n`

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

export async function parseDirectives(
  rawPrompt: string,
  opts: { modelJson?: ModelJsonFn; knownRoles: string[] },
): Promise<EffTaskConfig> {
  const base: EffTaskConfig = {
    goalPrompt: rawPrompt.trim(),
    parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS },
  }
  if (!opts.modelJson) return base
  let obj: Record<string, unknown> | null = null
  try {
    obj = extractJsonBlock(await opts.modelJson(EXTRACT_PROMPT + rawPrompt)) as Record<string, unknown> | null
  } catch {
    return base
  }
  if (!obj) return base

  if (obj.parallelism !== undefined) base.parallelism = clampInt(obj.parallelism, 1, 64, DEFAULT_PARALLELISM)

  const known = new Set(opts.knownRoles)
  const pr = (obj.phaseRoles ?? {}) as Record<string, unknown>
  for (const phase of PHASE_NAMES as PhaseName[]) {
    const raw = pr[phase]
    if (!Array.isArray(raw)) continue
    const bindings: RoleBinding[] = raw
      .map(r => (typeof r === 'string' ? r.trim() : ''))
      .filter(name => name.length > 0 && known.has(name))
      .map(name => ({ roleName: name }))
    base.phaseRoles[phase] = bindings
  }

  const caps = (obj.caps ?? {}) as Record<string, unknown>
  const c: Caps = { ...base.caps }
  if (caps.maxDepth !== undefined) c.maxDepth = clampInt(caps.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth)
  if (caps.maxNodes !== undefined) c.maxNodes = clampInt(caps.maxNodes, 1, 5000, DEFAULT_CAPS.maxNodes)
  if (caps.maxIterations !== undefined) c.maxIterations = clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations)
  base.caps = c
  return base
}
