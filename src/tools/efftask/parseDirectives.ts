// src/tools/efftask/parseDirectives.ts
import { DEFAULT_CAPS, DEFAULT_MAX_SEATS_PER_PHASE, DEFAULT_PARALLELISM, emptyPhaseRoles, PHASE_NAMES, PHASE_LABEL, STEP_ALIASES } from './types.js'
import type { Caps, EffTaskConfig, PhaseName } from './types.js'
import { extractJsonBlock } from './parseOutput.js'
import { applyRoleDefsToPhases, guessStep, mergeRoleDefs, parseRoleDefs, type RoleDef } from './roleDefs.js'

export type ModelJsonFn = (prompt: string) => Promise<string>


const EXTRACT_PROMPT = `你是配置解析器。把下面的"高效任务"指令抽成 JSON,只输出一个 json 代码块,字段:
{ "parallelism": number, "phaseRoles": { ${PHASE_NAMES.map(x => `"${x}"?: string[]`).join(', ')} },
  "skipSteps": ["要整个跳过的环节名"],
  "caps": { "maxDepth"?: number, "maxNodes"?: number, "maxIterations"?: number, "scoreThreshold"?: number, "maxSeatsPerPhase"?: number, "quorum"?: number, "quorumSeats"?: number, "planConverge"?: "圆桌"|"精化" },
  "roles": [{ "name": "角色名", "step": "${PHASE_NAMES.join('|')}", "output": "产出什么", "purpose": "起什么作用", "staff"?: ["员工名"] }] }
phaseRoles 的值是**员工名**数组(可派发的身份)。
圆桌通过门槛有两个字段,按用户的说法二选一:
- 用户说**比例**(「过半」「三分之二」「八成」)→ caps.quorum,整数百分比 1-100。「过半通过」= 51(50 会让平票也通过),「三分之二」= 66(67 会让 2/3 恰好不通过),「八成」= 80。默认 100 = 全票。
- 用户说**人数**(「至少 2 个人通过」「要 3 票」)→ caps.quorumSeats,就是那个人数。**不要**把人数写进 quorum:「至少 2 人」写成 quorum=2 的含义是 2%,等于 1 票就放行,和用户的意思正好相反。
caps.maxSeatsPerPhase 是每个阶段最多几席。
skipSteps:用户说「跳过X」「不做X」「X就不用了」时,把那个环节名放进来。没说就省略。
caps.planConverge:分析环节多员工时怎么收敛 ——「各自出稿再融合」=圆桌,「一稿传下去改」=精化(默认)。
roles 是**任务角色**定义 —— 指令里凡是描述了「某个角色在哪个阶段、产出什么、起什么作用、由谁担当」的,抽到这里。
角色名可以任意(架构师、安全、前端);step 必须是那几个之一 —— 用户说的中文环节名对应关系:${PHASE_NAMES.map(x => `${PHASE_LABEL[x]}=${x}`).join('、')};staff 填员工名,没说由谁担当就省略。
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
    // **无条件**跑一遍,即使没有任何角色定义。此前这里是 `if (defs.length === 0) return cfg`,
    // 于是「用户直接点名员工」这条最常见的路径完全绕开了席位上限:说了「每阶段最多 3 席」
    // 却拿到 8 席,而 notices 是空的 —— 静默的不是截断,是**没有**截断。
    const applied = applyRoleDefsToPhases(cfg.phaseRoles, defs, cfg.caps.maxSeatsPerPhase)
    cfg.phaseRoles = applied.phaseRoles
    cfg.notices.push(...applied.notices)
    if (defs.length > 0) cfg.roleDefs = defs
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
    // plan 不再裁剪:它走顺序精化(第一位起草,后面每一位在前一稿上修订),多员工是
    // 支持的形态,不是配置错误。execute 仍然只能一个 —— 那是物理约束:pathFor(node)
    // 不含员工维度,两个员工会拿到同一个 worktree 路径。
    if (phase === 'execute' && usable.length > 1) {
      trimNotices.push(`${PHASE_LABEL[phase]}:仅首个角色 ${usable[0]} 生效,已忽略 ${usable.slice(1).join('、')}`)
      usable = usable.slice(0, 1)
    }
    // observer 不再裁剪:它现在是多席位(各自打分,取最低分收敛,其余理由挂
    // ScoreRecord.others)。留着这段会让关口说一句关于系统能力的**假话** ——
    // 而且和 PHASE_SEATING/allowsMultipleSeats 直接矛盾。

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

  // 跳过的环节。归一到内部 phase 名,不认识的给 notice + 猜一个最接近的 —— 和角色定义
  // 里 step 写错时同一套待遇。
  if (Array.isArray(obj.skipSteps)) {
    const kept: PhaseName[] = []
    for (const raw of obj.skipSteps) {
      const t = typeof raw === 'string' ? raw.trim() : ''
      if (!t) continue
      const v = STEP_ALIASES[t] ?? t
      if ((PHASE_NAMES as string[]).includes(v)) { if (!kept.includes(v as PhaseName)) kept.push(v as PhaseName) }
      else {
        const legal = PHASE_NAMES.map(x => PHASE_LABEL[x]).join('/')
        const guess = guessStep(t)
        base.notices.push(`要跳过的环节「${t}」不是 ${legal} 之一,该环节会照常运行` + (guess ? `。是不是想写「${guess}」?` : ''))
      }
    }
    if (kept.length > 0) base.skipSteps = kept
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
  // 这两条同样需要入口:只有 readRunManifest 读回而没人写进去的话,它们只能靠手改
  // run.md 再 --resume 才生效 —— 那就是又一处「配置得进去、正常路径上到不了」。
  if (caps.maxSeatsPerPhase !== undefined) c.maxSeatsPerPhase = clampInt(caps.maxSeatsPerPhase, 1, 20, DEFAULT_MAX_SEATS_PER_PHASE)
  if (caps.quorum !== undefined) c.quorum = clampInt(caps.quorum, 1, 100, 100)
  if (caps.quorumSeats !== undefined) c.quorumSeats = clampInt(caps.quorumSeats, 1, 20, 1)
  // 只收这两个值,别的写法(roundtable/refine/乱写)一律回落默认的精化 —— 但**必须说出来**。
  // 静默回落是这里最坏的形态:用户说了「分析用 roundtable」,系统跑精化,关口在两种模式下
  // 逐字相同,notices 是空的,没有任何界面能让他发现自己要的模式没生效。
  if (caps.planConverge === '圆桌' || caps.planConverge === '精化') c.planConverge = caps.planConverge
  else if (caps.planConverge !== undefined) {
    base.notices.push(`分析环节的收敛方式(planConverge)「${String(caps.planConverge)}」不是 圆桌/精化 之一,本次按默认的顺序精化跑`)
  }
  base.caps = c

  // 提示词里定义的角色,合并到配置文件那一层之上。放在 phaseRoles 解析**之后**,因为
  // applyRoleDefsToPhases 要在已有名册的基础上并席位、并去掉重复派发的员工。
  const fromPrompt = parseRoleDefs(obj.roles, {
    knownStaff: known, unsupportedStaff: unsupported, source: '任务提示词',
  })
  base.notices.push(...fromPrompt.notices)
  // true:提示词是覆盖配置文件的那一层,「改由 X 担任」必须真的是「改」。
  const merged = mergeRoleDefs(opts.baseRoleDefs ?? [], fromPrompt.defs, true)
  base.notices.push(...merged.notices)
  return applyDefs(base, merged.defs)
}
