// src/tools/efftask/parseDirectives.ts
import { MAX_NODES_CEILING, clampParallelism, DEFAULT_CAPS, DEFAULT_MAX_SEATS_PER_PHASE, MAX_MERGE_RESOLVE, MIN_MERGE_RESOLVE, DEFAULT_PARALLELISM, emptyPhaseRoles, MAX_GUIDANCE_CHARS, MAX_ROLE_GUIDANCE, PHASE_NAMES, PHASE_LABEL, STEP_ALIASES } from './types.js'
import type { Caps, EffTaskConfig, PhaseName } from './types.js'
import { isStrictness, STRICTNESS_LEVELS } from './strictness.js'
import { extractJsonBlock } from './parseOutput.js'
import { applyRoleDefsToPhases, guessStep, mergeRoleDefs, parseRoleDefs, type RoleDef } from './roleDefs.js'

export type ModelJsonFn = (prompt: string) => Promise<string>


const EXTRACT_PROMPT = `你是配置解析器。把下面的"高效任务"指令抽成 JSON,只输出一个 json 代码块,字段:
{ "parallelism": number, "phaseRoles": { ${PHASE_NAMES.map(x => `"${x}"?: string[]`).join(', ')} },
  "skipSteps": ["要整个跳过的环节名"],
  "caps": { "maxDepth"?: number, "maxNodes"?: number, "maxIterations"?: number, "scoreThreshold"?: number, "maxSeatsPerPhase"?: number, "quorum"?: number, "quorumSeats"?: number, "planConverge"?: "圆桌"|"精化", "nodeTimeoutMs"?: number, "mergeResolveAttempts"?: number, "strictness"?: ${STRICTNESS_LEVELS.map(s => `"${s}"`).join('|')} },
  "roles": [{ "name": "角色名", "step": "${PHASE_NAMES.join('|')}", "output": "产出什么", "purpose": "起什么作用", "staff"?: ["员工名"] }],
  "phaseGuidance": { "环节名": "指令里点名给这个环节的那几句话" },
  "roleGuidance": [{ "name": "角色名或员工名", "text": "指令里点名给这个人的那几句话" }] }
phaseRoles 的值是**员工名**数组(可派发的身份)。
圆桌通过门槛有两个字段,按用户的说法二选一:
- 用户说**比例**(「过半」「三分之二」「八成」)→ caps.quorum,整数百分比 1-100。「过半通过」= 51(50 会让平票也通过),「三分之二」= 66(67 会让 2/3 恰好不通过),「八成」= 80。默认 100 = 全票。
- 用户说**人数**(「至少 2 个人通过」「要 3 票」)→ caps.quorumSeats,就是那个人数。**不要**把人数写进 quorum:「至少 2 人」写成 quorum=2 的含义是 2%,等于 1 票就放行,和用户的意思正好相反。
caps.maxDepth 是**任务树最多分几层**,caps.maxNodes 是**整棵树最多几个任务**。用户说「安全阀里允许最多 20 层、最多 20000 个节点」「别拆太深,三层就够」「任务别超过 200 个」→ 填这两个。取值范围分别是 1~20 和 1~20000,超出会被夹到边界(关口会说)。
caps.maxSeatsPerPhase 是每个阶段最多几席。
caps.mergeResolveAttempts 是**一个节点的合并冲突最多让模型自动解几次**(每次解完都会重跑验收)。用户说「冲突多试几次」「解冲突给 10 次机会」「冲突别自动解、直接叫我」→ 填这里(最后那句 = 0)。默认 6。
caps.nodeTimeoutMs 是**一次调用最多可以多久没有任何输出**(毫秒)。用户说「阶段超时 20 分钟」「每步最多等半小时」「模型慢,超时给久一点」→ 换算成毫秒填这里(20 分钟 = 1200000)。他说的是「多久没动静算卡死」,不是「一个节点最多跑多久」—— 一直在吐字就永远不算超时。
skipSteps:用户说「跳过X」「不做X」「X就不用了」时,把那个环节名放进来。没说就省略。
caps.planConverge:分析环节多员工时怎么收敛 ——「各自出稿再融合」=圆桌,「一稿传下去改」=精化(默认)。
caps.strictness 是**严格度档位** —— 「多好才算够」的尺子:验收/集成验收两关的判据,以及分析/质疑修复/执行/测试修复四关「要做到什么程度」。用户描述的是**标准高低**而不是次数或人数时填这里:
- 「随便跑跑」「先能用就行」「demo 而已」「别太较真」→ 初级
- 「正常标准」「按验收点来就行」→ 中级
- 「严格一点」「要处理边界」「不能有回归」→ 高级
- 「按最高标准」「生产级」「要考虑并发和失败恢复」「挑剔一点」→ 专家
没提标准高低就**省略**(省略 = 保持现有行为:验收全票通过、判据由各验收员自己把握)。注意和另外两件事分开:说「多试几轮」是 maxIterations,说「几个人通过」是 quorum/quorumSeats,都不是这个字段。
roles 是**任务角色**定义 —— 指令里凡是描述了「某个角色在哪个阶段、产出什么、起什么作用、由谁担当」的,抽到这里。
角色名可以任意(架构师、安全、前端);step 必须是那几个之一 —— 用户说的中文环节名对应关系:${PHASE_NAMES.map(x => `${PHASE_LABEL[x]}=${x}`).join('、')};staff 填员工名,没说由谁担当就省略。
phaseGuidance / roleGuidance 是**定向注入**:指令里凡是「某个环节该怎么做」「某个人要注意什么」的话,原文抄进去,它会被拼进那个环节/那一席的提示词。
- 判据是这句话**冲着谁说的**,不是它讲什么。「质疑修复时重点看并发安全」→ phaseGuidance.review;「架构师要给出回滚方案」→ roleGuidance(name=架构师)。
- 只抽**点了名**的。整体目标(「把登录改成 JWT」)不属于任何环节,留在目标里,不要抄进来 —— 抄进来等于让同一句话在每个环节的提示词里再出现一遍,白付钱。
- 一句话同时点了环节和人(「让架构师在评审时看并发」)→ 放 roleGuidance,更具体的那个赢;不要两边都放。
- 原文照抄,不要改写、不要补充、不要翻译。
只抽指令里真的写了的,不要替用户补 output/purpose —— 缺项的角色会被明确地判为不生效。未提及的字段省略。指令:\n`

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 夹一个数值上限,**夹动了就说一声**。
 *
 * `clampInt` 是静默的,而这些数全都是用户在提示词里**明确说过**的:「安全阀 20 层、
 * 最多 5000 个节点」「返工给 10 轮」。要的数超出范围时静默改掉,屏幕上只剩一个他没说过
 * 的数字,而关口那一行(安全阀: 深度X / 节点Y)看起来完全正常 —— 他唯一能得出的结论是
 * 「我说了,没生效」。这个仓库把静默降级当缺陷,这一处是同一类。
 *
 * 认不出的写法(`"六次"`)也要说:回落到默认值本身是对的,但不说就等于替他做了决定。
 */
function clampNoted(
  raw: unknown, min: number, max: number, fallback: number, label: string, notices: string[],
): number {
  const ok = typeof raw === 'number' && Number.isFinite(raw)
  const n = ok ? Math.round(raw) : fallback
  const v = Math.min(max, Math.max(min, n))
  if (!ok) notices.push(`${label}「${String(raw)}」认不出是个数,本次按默认 ${fallback} 跑`)
  else if (v !== n) notices.push(`${label}你要的是 ${n},而它的取值范围是 ${min}~${max},本次按 ${v} 跑`)
  return v
}


/**
 * 把一份 caps 补丁**校验着**并进现有 caps —— 抽取模型给的那一份和 settings.json 里那一份
 * 共用它。
 *
 * 抽出来只有一个理由,而它刚刚被真实地踩过一次:**夹取范围各写一份,同一个数就会在两条
 * 路上被解释成两个值**。`maxNodes` 的上限在启动侧和恢复侧不一致时,用户会看到自己写的
 * 20000 在 `--resume` 之后变成别的数,而屏幕上没有任何东西解释它为什么变了。配置文件这条
 * 新录入口只要自己写一遍范围,同一个坑就会立刻再出现一次。
 *
 * @param label 这份补丁**是谁给的**,进 notice 的抬头(''=提示词,'项目配置:'=settings.json)。
 *   夹动了要说清是哪一份配置被夹的 —— 两条路都能配同一个字段,不说来源就无从改起。
 */
export function applyCapsPatch(
  base: Caps, patch: Record<string, unknown>, label: string, notices: string[],
): Caps {
  const out: Caps = { ...base }
  const tag = (t: string): string => `${label}${t}`
  if (patch.maxDepth !== undefined) out.maxDepth = clampNoted(patch.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth, tag('树的最大深度:'), notices)
  if (patch.maxNodes !== undefined) out.maxNodes = clampNoted(patch.maxNodes, 1, MAX_NODES_CEILING, DEFAULT_CAPS.maxNodes, tag('任务节点上限:'), notices)
  if (patch.maxIterations !== undefined) out.maxIterations = clampNoted(patch.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations, tag('每一关的返工轮数:'), notices)
  // Without an entry point here the THRESHOLD had none at all: only readRunManifest read it
  // back, so the "低分触发一次返工" half of 观察评分 was dead code on the normal path —
  // reachable only by hand-editing run.md and resuming.
  if (patch.scoreThreshold !== undefined) out.scoreThreshold = clampInt(patch.scoreThreshold, 0, 100, 0)
  // 这两条同样需要入口:只有 readRunManifest 读回而没人写进去的话,它们只能靠手改
  // run.md 再 --resume 才生效 —— 那就是又一处「配置得进去、正常路径上到不了」。
  if (patch.maxSeatsPerPhase !== undefined) out.maxSeatsPerPhase = clampNoted(patch.maxSeatsPerPhase, 1, 20, DEFAULT_MAX_SEATS_PER_PHASE, tag('每个环节的席位数:'), notices)
  /**
   * 自动解冲突的次数。**下限是 0**,而 0 在这里是一个真实的意思(「别自动解,直接叫我」)——
   * 所以 clampInt 的 fallback 不能是 0:那样一个写坏的值(`"六次"`)会被静默解释成关掉功能,
   * 而用户写它的意图恰恰相反。回落到默认 6。
   */
  if (patch.mergeResolveAttempts !== undefined) {
    out.mergeResolveAttempts = clampNoted(
      patch.mergeResolveAttempts, MIN_MERGE_RESOLVE, MAX_MERGE_RESOLVE,
      DEFAULT_CAPS.mergeResolveAttempts ?? 6, tag('自动解冲突的次数:'), notices,
    )
  }
  /**
   * 静默超时:此前**只能手改 run.md**。
   *
   * 而它恰恰是阻断卡唯一会点名让用户去调的那个旋钮 ——「提高 run.md 里 caps.nodeTimeoutMs」。
   * 一个只能靠编辑 md 文件再 --resume 才转得动的旋钮,和上面 maxSeatsPerPhase / quorum
   * 当初的处境逐字相同(「配置得进去、正常路径上到不了」)。
   *
   * 夹取范围与 `resumeCore` 读回时那一份**必须相同**(1s–2h):两处不一致的话,同一个数
   * 在启动时被接受、在恢复时被改写,而屏幕上没有任何东西解释它为什么变了。
   */
  if (patch.nodeTimeoutMs !== undefined) {
    out.nodeTimeoutMs = clampInt(patch.nodeTimeoutMs, 1000, 7_200_000, DEFAULT_CAPS.nodeTimeoutMs)
  }
  if (patch.quorum !== undefined) out.quorum = clampInt(patch.quorum, 1, 100, 100)
  if (patch.quorumSeats !== undefined) out.quorumSeats = clampInt(patch.quorumSeats, 1, 20, 1)
  // 只收这两个值,别的写法(roundtable/refine/乱写)一律回落默认的精化 —— 但**必须说出来**。
  // 静默回落是这里最坏的形态:用户说了「分析用 roundtable」,系统跑精化,关口在两种模式下
  // 逐字相同,notices 是空的,没有任何界面能让他发现自己要的模式没生效。
  /**
   * 严格度档位。和 planConverge 逐字同规矩:只收合法值,**回落必须说出来**。
   *
   * 静默回落在这里格外坏:用户说了「按最高标准做」,系统按现状跑(全票 + 判据空白),
   * 而关口在两种情况下印的东西不一样但他不知道该找什么 —— 他会以为那句话生效了。
   */
  if (isStrictness(patch.strictness)) out.strictness = patch.strictness
  else if (patch.strictness !== undefined) {
    notices.push(
      tag('') + `严格度档位「${String(patch.strictness)}」不是 ${STRICTNESS_LEVELS.join('/')} 之一,` +
      `本次不设档位(判据由各评审员自己把握、圆桌全票通过)`,
    )
  }
  if (patch.planConverge === '圆桌' || patch.planConverge === '精化') out.planConverge = patch.planConverge
  else if (patch.planConverge !== undefined) {
    notices.push(tag('') + `分析环节的收敛方式(planConverge)「${String(patch.planConverge)}」不是 圆桌/精化 之一,本次按默认的顺序精化跑`)
  }

  return out
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
    /**
     * settings.json(`efftaskCaps`)定下的安全阀 —— 这一次运行的**起点**。
     *
     * 提示词里说的那一份逐字段覆盖它:项目配置说「这个项目 20000 个节点」,而某一次
     * 「这次只跑个小的,200 个节点就行」应该赢。两者都没说的字段留在 DEFAULT_CAPS 上。
     */
    baseCaps?: Caps
  },
): Promise<EffTaskConfig> {
  const base: EffTaskConfig = {
    goalPrompt: rawPrompt.trim(),
    parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS, ...(opts.baseCaps ?? {}) },
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
  /**
   * **抽取失败必须说出来。**
   *
   * 这两条早退原来都是静默的:`catch {}` 直接返回默认配置,一条 notice 都不留。而这一次
   * 调用承载的是提示词里**全部**的配置 —— 跳过哪些环节、并行数、安全阀、角色定义、定向
   * 注入。它一失败,用户写的那一整段就整个蒸发,而关口显示的是一份「看起来正常」的默认
   * 配置:七个环节都在、没有任何环节被跳过。
   *
   * 用户报的正是这个形状:「要求去掉某些阶段,也没有去掉。」跑机上那次的真因是上游
   * 403(额度用尽),而屏幕上没有任何一个字提到过它 —— 于是它看起来像编排器的 bug。
   *
   * 静默降级是这个仓库反复在修的那一类缺陷:**行为退化了,而屏幕上的一切照旧**。
   */
  try {
    obj = extractJsonBlock(await opts.modelJson(EXTRACT_PROMPT + rawPrompt)) as Record<string, unknown> | null
  } catch (e) {
    base.notices.push(
      '需求解析那次调用**失败**了:提示词里写的配置(跳过哪些环节、并行数、安全阀、' +
      '角色、定向注入)这次**一条都没生效**,本次按默认配置跑。原因: ' +
      (e instanceof Error ? e.message : String(e)),
    )
    return applyDefs(base, opts.baseRoleDefs ?? [])
  }
  if (!obj) {
    base.notices.push(
      '需求解析没有返回可解析的 JSON:提示词里写的配置(跳过哪些环节、并行数、安全阀、' +
      '角色、定向注入)这次**一条都没生效**,本次按默认配置跑。',
    )
    return applyDefs(base, opts.baseRoleDefs ?? [])
  }

  if (obj.parallelism !== undefined) base.parallelism = clampParallelism(obj.parallelism)

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

  /**
   * 定向注入(§定向注入)—— 提示词里点名给某个环节 / 某个人的那几句话。
   *
   * 归一到内部 phase 名,和 skipSteps 同一条规矩(落盘永远是内部名,中文只是输入别名)。
   * 认不出来的环节名**说出来并猜一个**:静默丢弃的话,用户明明写了「评审时重点看并发安全」,
   * 而评审员一个字都收不到,而且界面上没有任何地方能让他发现这件事。
   */
  const guide = (obj.phaseGuidance ?? {}) as Record<string, unknown>
  if (guide && typeof guide === 'object' && !Array.isArray(guide)) {
    const kept: Partial<Record<PhaseName, string>> = {}
    for (const [rawKey, rawVal] of Object.entries(guide)) {
      const text = typeof rawVal === 'string' ? rawVal.trim() : ''
      if (text.length === 0) continue
      const key = rawKey.trim()
      const v = STEP_ALIASES[key] ?? key
      if (!(PHASE_NAMES as string[]).includes(v)) {
        const guess = guessStep(key)
        base.notices.push(
          `你对「${key}」提的那段要求没有对应的环节(合法值:${PHASE_NAMES.map(x => PHASE_LABEL[x]).join('/')}),` +
          `这段话不会进任何提示词` + (guess ? `。是不是想写「${guess}」?` : ''),
        )
        continue
      }
      const phase = v as PhaseName
      // 同一个环节被点两次就接起来 —— 覆盖会静默丢掉前一条,而两条都是用户亲手写的。
      const prev = kept[phase]
      const joined = prev ? `${prev}\n${text}` : text
      /**
       * **在这里夹取,不只在读回那一侧夹。**
       *
       * 评审量出来的:`resumeCore` 是夹的,而这条**主入口**一个上限都没有 —— 实测抽取模型
       * 回一段 50000 码点的指引,它原样出口;40 条角色指引合计 80190 码点,评审那一席
       * 单次前言 181446 码点(Haiku 4.5 的 200K 窗口占 91%)。而拼接那一步会让它翻倍。
       *
       * 按**码点**截(`.slice` 会把 emoji 劈成半个代理对),而且**说出来** —— 静默截断
       * 用户亲手写的话是这个仓库反复付过代价的那一类。
       */
      const cp = Array.from(joined)
      if (cp.length > MAX_GUIDANCE_CHARS) {
        base.notices.push(
          `你给「${PHASE_LABEL[phase]}」的那段要求有 ${cp.length} 字,超过 ${MAX_GUIDANCE_CHARS} 的上限,` +
          `已截断到前 ${MAX_GUIDANCE_CHARS} 字(整段提示词是要按字数付钱的)`,
        )
      }
      kept[phase] = cp.slice(0, MAX_GUIDANCE_CHARS).join('')
    }
    /**
     * 点给一个**这次不会跑**的环节:说出来。
     *
     * 「测试验证时要跑 bun test」+ 没配 verify 角色 = 这段话永远不会被任何人读到,
     * 而用户以为自己已经安排好了。判据和 phaseRuns 一致(只有 verify/observer 是
     * 「没配角色就整个不存在」),skipSteps 那一侧也一起判。
     */
    for (const phase of Object.keys(kept) as PhaseName[]) {
      if ((base.skipSteps ?? []).includes(phase)) {
        base.notices.push(`你对「${PHASE_LABEL[phase]}」提的那段要求不会生效:这次运行整个跳过了这个环节`)
      }
      // 「没配角色」那一条**不在这里判** —— 席位要到下面 `applyDefs` 那一步才从 roleDefs
      // 落进 `phaseRoles`。见函数末尾。
    }
    if (Object.keys(kept).length > 0) base.phaseGuidance = kept
  }
  if (Array.isArray(obj.roleGuidance)) {
    const kept: { name: string; text: string }[] = []
    /**
     * 名字对不上任何一个席位时**说出来并列出真名**。
     *
     * 席位来源是本次真实名册(`base.phaseRoles`)+ 角色定义 —— 也就是 `seatMatchesName`
     * 那侧真正会比的两个字段。对不上就是这段话谁也读不到,而这正是「配得进去、永远不生效」
     * 那一类。角色定义还没合并进来(在下面),所以这里只拿名册比,合并后的角色名在
     * `applyDefs` 之后已经落到席位的 roleTag 上 —— 见下面那一段。
     */
    let dropped = 0
    for (const raw of obj.roleGuidance) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name.trim() : ''
      const text = typeof r.text === 'string' ? r.text.trim() : ''
      if (name.length === 0 || text.length === 0) continue
      /**
       * 条数和长度都有上限 —— 理由和 phaseGuidance 那一段逐字相同(评审实测 40 条合计
       * 80190 码点),而且这里的乘子更大:每一条都要和**每一个**名字对得上的席位见面。
       *
       * 名字也夹:它会被拼进提示词的**标题**里,而一个 400 字的名字实测能把关口顶出屏幕。
       */
      if (kept.length >= MAX_ROLE_GUIDANCE) { dropped++; continue }
      kept.push({
        name: Array.from(name).slice(0, MAX_GUIDANCE_CHARS).join(''),
        text: Array.from(text).slice(0, MAX_GUIDANCE_CHARS).join(''),
      })
    }
    if (dropped > 0) {
      base.notices.push(
        `点名给某个角色/员工的额外要求最多 ${MAX_ROLE_GUIDANCE} 条,多出的 ${dropped} 条不会生效` +
        `(每一条都要和名字对得上的每一席见面,条数是会乘起来的)`,
      )
    }
    if (kept.length > 0) base.roleGuidance = kept
  }

  const caps = (obj.caps ?? {}) as Record<string, unknown>
  base.caps = applyCapsPatch(base.caps, caps, '', base.notices)

  // 提示词里定义的角色,合并到配置文件那一层之上。放在 phaseRoles 解析**之后**,因为
  // applyRoleDefsToPhases 要在已有名册的基础上并席位、并去掉重复派发的员工。
  const fromPrompt = parseRoleDefs(obj.roles, {
    knownStaff: known, unsupportedStaff: unsupported, source: '任务提示词',
  })
  base.notices.push(...fromPrompt.notices)
  // true:提示词是覆盖配置文件的那一层,「改由 X 担任」必须真的是「改」。
  const merged = mergeRoleDefs(opts.baseRoleDefs ?? [], fromPrompt.defs, true)
  base.notices.push(...merged.notices)
  const cfg = applyDefs(base, merged.defs)
  /**
   * 点名给某个角色/员工的那段话,**名字对不上任何一席就说出来**。
   *
   * 判在 applyDefs **之后**:角色名是在那一步落到席位的 `roleTag` 上的,提前判会把每一个
   * 按角色名点的人都误报成「找不到」。比的两个字段和 `pipeline.seatMatchesName` 逐字一致
   * (roleTag / roleName),否则屏幕说找得到而提示词里没有,或者反过来。
   *
   * 不静默丢弃的理由和别处一样,但这一条尤其容易发生:用户写的是「架构师注意回滚」,
   * 而他的名册里那个角色叫「架构评审」—— 没有这条 notice,那段话谁也读不到,
   * 而关口上一切正常。
   */
  /**
   * 点给一个**这次不会跑**的环节:说出来。判在 `applyDefs` 之后,理由和下面那条逐字相同。
   *
   * 实测说过一次假话:run.md 里印着「你对『测试验证』提的那段要求不会生效:没给这个环节配
   * 角色,它这次不会发生」,而同一份 run.md 的 `phaseRoles.verify` 挂着测试官,这一关实跑了
   * 3 轮。原因就是判早了 —— 那时候席位还只在 `roleDefs` 里(`stage: verify`),
   * 还没被 `applyDefs` 落到名册上。
   *
   * 判据仍和 `phaseRuns` 一致:只有 verify / observer 是「没配角色就整个不存在」。
   */
  for (const phase of Object.keys(cfg.phaseGuidance ?? {}) as PhaseName[]) {
    if ((cfg.skipSteps ?? []).includes(phase)) continue // 上面已经按「整个跳过」报过了
    if (phase !== 'verify' && phase !== 'observer') continue
    if (cfg.phaseRoles[phase].length > 0) continue
    cfg.notices.push(`你对「${PHASE_LABEL[phase]}」提的那段要求不会生效:没给这个环节配角色,它这次不会发生`)
  }
  const seatNames = new Set<string>()
  for (const seats of Object.values(cfg.phaseRoles)) {
    for (const s of seats) {
      if (s.roleTag) seatNames.add(s.roleTag.trim().toLowerCase())
      if (s.roleName) seatNames.add(s.roleName.trim().toLowerCase())
    }
  }
  const unmatched = (cfg.roleGuidance ?? []).filter(g => !seatNames.has(g.name.trim().toLowerCase()))
  for (const g of unmatched) {
    cfg.notices.push(
      `你点名给「${g.name}」的那段要求不会生效:本次名册里没有这个角色或员工` +
      (seatNames.size > 0 ? `(名册上是:${[...seatNames].join('、')})` : '(本次名册为空,所有环节都由主模型兼任)'),
    )
  }
  return cfg
}
