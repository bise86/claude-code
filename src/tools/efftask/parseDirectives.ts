// src/tools/efftask/parseDirectives.ts
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { Caps, EffTaskConfig, PhaseName } from './types.js'
import { extractJsonBlock } from './parseOutput.js'
import { applyRoleDefsToPhases, mergeRoleDefs, parseRoleDefs, type RoleDef } from './roleDefs.js'

export type ModelJsonFn = (prompt: string) => Promise<string>

const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

const EXTRACT_PROMPT = `你是配置解析器。把下面的"高效任务"指令抽成 JSON,只输出一个 json 代码块,字段:
{ "parallelism": number, "phaseRoles": { "plan"?: string[], "review"?: string[], "execute"?: string[], "accept"?: string[], "observer"?: string[] },
  "caps": { "maxDepth"?: number, "maxNodes"?: number, "maxIterations"?: number, "scoreThreshold"?: number },
  "roles": [{ "name": "角色名", "stage": "plan|review|execute|accept|observer", "output": "产出什么", "purpose": "起什么作用", "staff"?: ["员工名"] }] }
phaseRoles 的值是**员工名**数组(可派发的身份)。
roles 是**任务角色**定义 —— 指令里凡是描述了「某个角色在哪个阶段、产出什么、起什么作用、由谁担当」的,抽到这里。
角色名可以任意(架构师、安全、前端);stage 必须是那五个之一;staff 填员工名,没说由谁担当就省略。
只抽指令里真的写了的,不要替用户补 output/purpose —— 缺项的角色会被明确地判为不生效。未提及的字段省略。指令:\n`

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

export async function parseDirectives(
  rawPrompt: string,
  opts: {
    modelJson?: ModelJsonFn
    /** 可派发的**员工**名(agentType)。历史名字,语义就是员工。 */
    knownRoles: string[]
    /** Roles that exist but P1 cannot dispatch (execMode 'cli' goes through AgentTool, not runAgent). */
    unsupportedRoles?: string[]
    /**
     * 配置文件里已有的角色定义。提示词里的同名角色覆盖它的产出/作用,员工取并集
     * ——「任务需求提示词可更新改变这种配置」。
     */
    baseRoleDefs?: RoleDef[]
  },
): Promise<EffTaskConfig> {
  const base: EffTaskConfig = {
    goalPrompt: rawPrompt.trim(),
    parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS },
    notices: [],
  }
  // 没有抽取模型时也要把配置文件里的角色接上 —— 否则「在配置文件里配好角色」这条路
  // 只在抽取成功时才通,而抽取失败正是最常走到的退化路径。
  const applyDefs = (cfg: EffTaskConfig, defs: RoleDef[]): EffTaskConfig => {
    if (defs.length === 0) return cfg
    const applied = applyRoleDefsToPhases(cfg.phaseRoles, defs)
    cfg.phaseRoles = applied.phaseRoles
    cfg.notices.push(...applied.notices)
    cfg.roleDefs = defs
    return cfg
  }
  if (!opts.modelJson) return applyDefs(base, opts.baseRoleDefs ?? [])
  let obj: Record<string, unknown> | null = null
  try {
    obj = extractJsonBlock(await opts.modelJson(EXTRACT_PROMPT + rawPrompt)) as Record<string, unknown> | null
  } catch {
    return applyDefs(base, opts.baseRoleDefs ?? [])
  }
  if (!obj) return applyDefs(base, opts.baseRoleDefs ?? [])

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
    // Scoring runs ONE observer, like plan and execute — node.score holds a single record
    // per dimension, so listing more would put names on the roster that never get called.
    if (phase === 'observer' && usable.length > 1) {
      trimNotices.push(`观察:仅首个角色 ${usable[0]} 生效,已忽略 ${usable.slice(1).join('、')}`)
      usable = usable.slice(0, 1)
    }

    // "改用主模型" is only TRUE when the phase ends up with nobody. Saying it while another
    // role still holds the seat describes a fallback that never happens — the same class of
    // untrue gate line these notices exist to prevent. When someone remains, name them, so
    // the notice and the roster agree. The observer phase never runs at all in P1, so no
    // fallback occurs there either.
    const tail =
      // An un-roled observer phase does not fall back to the main model — scoring is opt-in
      // and simply does not happen.
      phase === 'observer' && usable.length === 0 ? '已忽略(未配置观察角色时不评分)'
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
  // Without an entry point here the THRESHOLD had none at all: only readRunManifest read it
  // back, so the "低分触发一次返工" half of 观察评分 was dead code on the normal path —
  // reachable only by hand-editing run.md and resuming.
  if (caps.scoreThreshold !== undefined) c.scoreThreshold = clampInt(caps.scoreThreshold, 0, 100, 0)
  base.caps = c

  // 提示词里定义的角色,合并到配置文件那一层之上。放在 phaseRoles 解析**之后**,因为
  // applyRoleDefsToPhases 要在已有名册的基础上并席位、并去掉重复派发的员工。
  const fromPrompt = parseRoleDefs(obj.roles, {
    knownStaff: known, unsupportedStaff: unsupported, source: '任务提示词',
  })
  base.notices.push(...fromPrompt.notices)
  const merged = mergeRoleDefs(opts.baseRoleDefs ?? [], fromPrompt.defs)
  base.notices.push(...merged.notices)
  return applyDefs(base, merged.defs)
}
