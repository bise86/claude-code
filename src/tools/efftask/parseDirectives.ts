// src/tools/efftask/parseDirectives.ts
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { Caps, EffTaskConfig, PhaseName } from './types.js'
import { extractJsonBlock } from './parseOutput.js'

export type ModelJsonFn = (prompt: string) => Promise<string>

const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

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
  opts: {
    modelJson?: ModelJsonFn
    knownRoles: string[]
    /** Roles that exist but P1 cannot dispatch (execMode 'cli' goes through AgentTool, not runAgent). */
    unsupportedRoles?: string[]
  },
): Promise<EffTaskConfig> {
  const base: EffTaskConfig = {
    goalPrompt: rawPrompt.trim(),
    parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS },
    notices: [],
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
  const unsupported = new Set(opts.unsupportedRoles ?? [])
  const pr = (obj.phaseRoles ?? {}) as Record<string, unknown>
  for (const phase of PHASE_NAMES) {
    const raw = pr[phase]
    if (!Array.isArray(raw)) continue
    // Dedupe: each entry is one seat at the roundtable, so a repeated name (an easy
    // thing for an extraction model to emit) would run that role twice and give its
    // verdict double weight.
    const asked = [...new Set(raw.map(r => (typeof r === 'string' ? r.trim() : '')).filter(n => n.length > 0))]
    const missing = asked.filter(n => !known.has(n))
    const cliOnly = asked.filter(n => known.has(n) && unsupported.has(n))
    let usable = asked.filter(n => known.has(n) && !unsupported.has(n))

    // The trim notices are collected first but PUSHED LAST, because the consequence clause
    // of the missing/cli notices below can only be written once the roster is final.
    const trimNotices: string[] = []
    // Only review and accept fan out into a roundtable. plan and execute run ONE agent, so
    // listing extra seats there would put names on the confirmation roster that never get
    // called — the gate must show who actually runs.
    if ((phase === 'plan' || phase === 'execute') && usable.length > 1) {
      trimNotices.push(`${PHASE_LABEL[phase]}:仅首个角色 ${usable[0]} 生效,已忽略 ${usable.slice(1).join('、')}`)
      usable = usable.slice(0, 1)
    }
    // The observer phase is P3; nothing consults it yet. Showing it on the roster would
    // promise a scorer that never scores.
    if (phase === 'observer' && usable.length > 0) {
      trimNotices.push(`观察:评分角色 ${usable.join('、')} 属 P3,本期不会被调用,已忽略`)
      usable = []
    }

    // "改用主模型" is only TRUE when the phase ends up with nobody. Saying it while another
    // role still holds the seat describes a fallback that never happens — the same class of
    // untrue gate line these notices exist to prevent. When someone remains, name them, so
    // the notice and the roster agree. The observer phase never runs at all in P1, so no
    // fallback occurs there either.
    const tail =
      phase === 'observer' ? '已忽略'
      : usable.length === 0 ? '改用主模型'
      : `已忽略(${PHASE_LABEL[phase]}仍由 ${usable.join('、')} 承担)`
    if (missing.length > 0) base.notices.push(`${PHASE_LABEL[phase]}:未找到角色 ${missing.join('、')},${tail}`)
    if (cliOnly.length > 0) base.notices.push(`${PHASE_LABEL[phase]}:角色 ${cliOnly.join('、')} 是 CLI 模式,P1 尚不支持,${tail}`)
    base.notices.push(...trimNotices)

    base.phaseRoles[phase] = usable.map(name => ({ roleName: name }))
  }

  const caps = (obj.caps ?? {}) as Record<string, unknown>
  const c: Caps = { ...base.caps }
  if (caps.maxDepth !== undefined) c.maxDepth = clampInt(caps.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth)
  if (caps.maxNodes !== undefined) c.maxNodes = clampInt(caps.maxNodes, 1, 5000, DEFAULT_CAPS.maxNodes)
  if (caps.maxIterations !== undefined) c.maxIterations = clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations)
  base.caps = c
  return base
}
