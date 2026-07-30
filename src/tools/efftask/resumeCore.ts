import { parse as yamlParse } from 'yaml'
import { clampParallelism, createNode, emptyPhaseRoles, emptyPlan, BLOCK_CATEGORIES, DEFAULT_CAPS, MAX_GUIDANCE_CHARS, SKIPPABLE_PHASES, DEFAULT_MAX_SEATS_PER_PHASE, DEFAULT_PARALLELISM, NODE_STATUSES, PHASE_NAMES, STEP_ALIASES } from './types.js'
import type { Caps, EffTaskConfig, NodeKind, PhaseName, ResumeRecord, RoleBinding, RoundtableRecord, TaskNode, ScoreRecord } from './types.js'
import type { FsLike } from './persistence.js'
import type { RoleDef } from './roleDefs.js'
import { capBlockingList, capText, MAX_BLOCKING_CHARS, MAX_BLOCKING_ITEMS } from './parseOutput.js'
import { sanitizeUsage } from './usage.js'

// Exported because they ARE the post-condition: whatever this module hands back, every reader
// downstream may assume is one of these. hostileDisk.test.ts asserts against them rather than
// keeping a second copy that could drift the day a status is added.
/**
 * 这份集合曾经和 `NodeStatus` 类型**完全脱钩**,而这个仓库没有 typecheck —— 类型里加了
 * 新状态却漏了这里,不会有任何东西报错。后果实测过:进程在该状态期间被杀 → 落盘 →
 * 下次恢复走 validateLoadedNodes 的 block(),而它把 interrupted / capBlocked /
 * mergeConflict 三个复活开关全部清零 → **节点永久死亡,连 --retry-blocked 都救不回**。
 *
 * 所以改成由 NODE_STATUSES 派生,不再手写字面量。
 */
export const LEGAL_STATUS = new Set<string>(NODE_STATUSES)
export const LEGAL_KIND = new Set<string>(['decompose', 'executable', 'unknown'])

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

// Filter ELEMENTS, not just the array: a node.md carrying `accept: ['pm']` would otherwise
// reach runRoundtable with role.roleName undefined in the runAgent request.
const roleArray = (v: unknown): RoleBinding[] =>
  Array.isArray(v)
    ? v
        .filter((r): r is { roleName: string; model?: unknown } =>
          !!r && typeof r === 'object' && typeof (r as { roleName?: unknown }).roleName === 'string')
        // roleTag 必须保留:它是席位与角色定义的唯一关联(同一员工可兼两角,按员工名反查
        // 是二义的)。丢掉它 → 恢复后席位数量、名字、模型全对,只有职责简报静默消失。
        .map(r => ({
          roleName: r.roleName,
          // model **故意不读回**。
          //
          // 它是 annotateRoleModels 算出来的**显示值**(员工现在跑在哪个模型上),不是
          // 用户的选择 —— parseDirectives 从不给它赋值。读回来的后果是 annotateRoleModels
          // 的 `r.model ?? …` 被盘上的旧值短路,于是:员工在 settings 里换了模型、甚至被
          // 整个删掉,--resume 的关口照旧显示 `架构师←架构(MiniMax-M2)`,而实际跑的是主
          // 模型兜底,一条 ⚠ 都没有。日志流的「(模型)」标注同源,一起错。
          //
          // efftask.tsx 恢复分支的注释承诺过不许这样:「a role recorded on disk may no
          // longer exist, and pickAgentDefinition would silently fall back to the main
          // model while the gate still displayed the old name」。丢掉这一行,那句承诺才成立。
          // run.md 里仍然写着它 —— 那是给人读的历史记录,不是下一次运行的输入。
          ...(typeof (r as { roleTag?: unknown }).roleTag === 'string' ? { roleTag: (r as { roleTag: string }).roleTag } : {}),
        }))
    : []

/**
 * Ids that sit on a dependency cycle.
 *
 * `hasCycle` in stateMachine.ts answers yes/no, which is enough for the live path (reject
 * the proposed child group) but not for resume: a cycle already on disk must have its exact
 * members BLOCKED. Otherwise nothing is advanceable, no propagateBlocked rule fires — the
 * deps all exist and none is BLOCKED — and run() ends with the opaque
 * '存在无法推进的阻断节点' while no node carries a reason, a state every later resume
 * reproduces byte for byte.
 *
 * Kahn's algorithm: whatever never reaches in-degree zero is on, or downstream of, a cycle.
 */
export function depCycleMembers(nodes: TaskNode[]): Set<string> {
  const ids = new Set(nodes.map(n => n.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const n of nodes) {
    // Only in-set, non-self edges: a dangling dep is a different failure (handled by the
    // referential-integrity pass) and counting it here would report a false cycle.
    const deps = n.deps.filter(d => ids.has(d) && d !== n.id)
    indeg.set(n.id, deps.length)
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id])
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const settled = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    settled.add(id)
    for (const dep of dependents.get(id) ?? []) {
      const left = (indeg.get(dep) ?? 0) - 1
      indeg.set(dep, left)
      if (left === 0) queue.push(dep)
    }
  }
  return new Set([...ids].filter(id => !settled.has(id)))
}

/**
 * A score record with every field a writer dereferences.
 *
 * `validateLoadedNodes` checked only `typeof n.score === 'object'`, one level up. YAML types
 * values automatically, so an unquoted `rationale: 90` in a hand-edited node.md is a NUMBER —
 * and `stripControl` calls `.replace` on it. Measured: every persist throws, the node blocks
 * with a raw TypeError, and the disk still holds the old reason so every later --resume
 * reproduces it exactly.
 */
function scoreRecord(v: unknown): ScoreRecord | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  return {
    role: typeof r.role === 'string' ? r.role : 'unknown',
    // Clamped like parseScoreOutput does. An out-of-range -50 from a hand-edited file would
    // otherwise sit below any scoreThreshold and burn a rework round for nothing.
    score: Number.isFinite(r.score) ? Math.min(100, Math.max(0, Math.trunc(r.score as number))) : 0,
    // STRINGIFIED, not dropped. The whole premise was "YAML types `rationale: 90` as a
    // number" — and the first fix answered that by deleting the reviewer's actual comment.
    // String() neither throws nor loses it.
    rationale: typeof r.rationale === 'string' ? r.rationale : r.rationale === undefined || r.rationale === null ? '' : String(r.rationale),
    ...(Array.isArray((v as { others?: unknown }).others)
    // 多员工评分时,落选席位的分数与理由挂在这里。逐字段重建时漏掉它 = 一次 --resume
    // 就丢,而 serializeNode 整对象落盘,恢复后的第一次 commit 会把盘上那份也抹掉 ——
    // 永久丢失。取最低分是对的,丢掉其余理由是静默截断。
    ? { others: ((v as { others: unknown[] }).others)
        .map(o => (o && typeof o === 'object' ? o : {}) as Record<string, unknown>)
        .filter(o => typeof o.role === 'string' && typeof o.score === 'number' && typeof o.rationale === 'string')
        .map(o => ({ role: o.role as string, score: o.score as number, rationale: o.rationale as string })) }
    : {}),
}
}

/**
 * A worktree reference, or nothing.
 *
 * The mergeConflict branch below KEEPS this field without checking its shape, and the
 * isolation gate in stepExecute is `!node.worktree` — so a truthy-but-malformed value made
 * the gate PASS: measured, acquire() was never called, the acceptance roundtable ran with
 * `cwd: undefined` (i.e. in the user's real checkout rather than the node's worktree), and the
 * node reached ACCEPTED. The repair line shown to the user read "保留冲突工作区 undefined".
 * That is the exact failure this function's own comment warns about, through a door it left open.
 */
function worktreeRef(v: unknown): { branch: string; path: string } | undefined {
  if (!v || typeof v !== 'object') return undefined
  const w = v as Record<string, unknown>
  if (typeof w.branch !== 'string' || w.branch.length === 0) return undefined
  if (typeof w.path !== 'string' || w.path.length === 0) return undefined
  return { branch: w.branch, path: w.path }
}

/**
 * The verdicts of one round.
 *
 * A plain function, not the comma-operator ternary it replaced: that expression's condition
 * was ALWAYS false (the comma operator returns its right operand), so its `? []` branch was
 * unreachable and its only effect was smuggling in a side effect. Deleting the whole thing
 * left the suite green.
 */
function verdictArray(v: unknown, onDrop?: () => void): RoundtableRecord['verdicts'] {
  if (!Array.isArray(v)) {
    if (v !== undefined) onDrop?.()
    return []
  }
  return v
    .filter((x): x is Record<string, unknown> => {
      const ok = !!x && typeof x === 'object'
      if (!ok) onDrop?.()
      return ok
    })
    .map(x => {
      const blocking = strArray(x.blocking)
      // Report a DROP at the level it happens. Reporting only whole rounds meant a verdict
      // whose entire blocking list was a string, or whose 30 entries became 20, vanished
      // without a line anywhere — and §17.2 wants the repairs shown to the user.
      if (x.blocking !== undefined && !Array.isArray(x.blocking)) onDrop?.()
      if (blocking.length > MAX_BLOCKING_ITEMS) onDrop?.()
      return {
        role: typeof x.role === 'string' ? x.role : 'unknown',
        pass: x.pass === true,
        // Same caps as the parse boundary: node.md is hand-editable, and this is the other
        // door into the same field.
        blocking: capBlockingList(blocking),
        comments: typeof x.comments === 'string' ? capText(x.comments, MAX_BLOCKING_CHARS) : '',
        ...(x.infra === true ? { infra: true as const } : {}),
        ...(x.timeout === true ? { timeout: true as const } : {}),
      }
    })
}

/** One roundtable record, with every field the writers dereference guaranteed present. */
function roundArray(v: unknown, onDrop?: () => void): RoundtableRecord[] {
  if (!Array.isArray(v)) { if (v !== undefined) onDrop?.(); return [] }
  return v
    .filter((r): r is Record<string, unknown> => {
      const ok = !!r && typeof r === 'object'
      if (!ok) onDrop?.()
      return ok
    })
    .map(r => ({
      round: Number.isFinite(r.round) ? (r.round as number) : 0,
      verdicts: verdictArray(r.verdicts, onDrop),
      synthesized: {
        pass: (r.synthesized as { pass?: unknown } | undefined)?.pass === true,
        blockingSummary: typeof (r.synthesized as { blockingSummary?: unknown } | undefined)?.blockingSummary === 'string'
          ? ((r.synthesized as { blockingSummary: string }).blockingSummary)
          : '',
      },
    }))
}

export interface ValidateResult { nodes: TaskNode[]; repairs: string[] }

/**
 * Turn whatever `loadRun` scraped off disk into something the state machine may safely see.
 *
 * The governing rule is BLOCK, NEVER SILENTLY DROP. Every edge that points at a node we
 * could not recover is evidence that the tree is incomplete, and P1's orchestrator already
 * blocks on exactly those two conditions (`子节点缺失` / `依赖节点缺失`, orchestrator.ts).
 * Erasing the edge would delete the evidence AND disable that rule, so a node would execute
 * with write tools on the premise that upstream work it cannot verify succeeded — and the
 * run would report completed. That is the one outcome this feature must never produce.
 *
 * `opts.goal` and `opts.phaseRoles` come from the recovered manifest: a synthesized root
 * needs the REAL objective and the REAL roster, because it is what the integration
 * roundtable judges the entire run against.
 */
export function validateLoadedNodes(
  nodes: TaskNode[],
  opts: { goal: string; phaseRoles: Record<PhaseName, RoleBinding[]>; now: string },
): ValidateResult {
  const repairs: string[] = []
  const kept = nodes.filter(n => {
    const ok = !!n && typeof n.id === 'string' && n.id.length > 0
    if (!ok) repairs.push('丢弃一个没有 id 的节点记录')
    return ok
  })
  const byId = new Map<string, TaskNode>()
  for (const n of kept) {
    if (byId.has(n.id)) { repairs.push(`重复节点 ${n.id},保留先读到的一份`); continue }
    byId.set(n.id, n)
  }

  const block = (n: TaskNode, why: string): void => {
    n.status = 'BLOCKED'
    n.blockedReason = n.blockedReason || why
    // NEVER interrupted: reseat reopens interrupted nodes, and a node blocked because its
    // own disk state is unusable must stay blocked.
    n.interrupted = false
    // 手工跳过的一次性标记也要清。这条路阻断的理由是「这棵树自己对不上」(子节点缺失、
    // 依赖成环……),而一个带着 `skipPhase` 的节点一旦被别的路复活,会跳过一关**它自己
    // 都还没走到**的判决。同一个函数里 capBlocked 正是为这一类硬清的。
    n.skipPhase = undefined
    // Same door, and it was left open: a node that had legitimately tripped a valve keeps
    // capBlocked === true, so a later --retry-blocked reopened it even though this pass has
    // since blocked it for an UNRECOVERABLE reason (a missing child/dep, a cycle). The resume
    // gate then reported "重开 1 个节点" for a node that re-blocks with zero model calls —
    // exactly the failure --retry-blocked exists to fix — and n.blockedReason = '' erased the
    // original diagnosis on the way.
    n.capBlocked = false
    // …and the same for mergeConflict, which is an EQUIVALENT key and needs no flag at all:
    // reseat reopens any BLOCKED node carrying it. Measured: a conflict node that this pass
    // then blocked for a missing dependency was still reseated to READY, the gate reported
    // "重新排队 1 个节点", the run made zero model calls, and blockedReason was cleared on the
    // way — erasing both the conflict diagnosis and the 依赖节点缺失 that replaced it.
    n.mergeConflict = false
    repairs.push(`节点 ${n.id}:${why}`)
  }

  for (const n of byId.values()) {
    if (!LEGAL_STATUS.has(n.status as string)) block(n, `恢复时发现非法状态 ${String(n.status)},无法安全重入`)
    if (!LEGAL_KIND.has(n.kind as string)) { repairs.push(`节点 ${n.id} 的 kind 非法,重置为 unknown`); n.kind = 'unknown' as NodeKind }
    n.deps = strArray(n.deps)
    n.childIds = strArray(n.childIds)
    // NEGATIVE counts as illegal, not just NaN. renderTreeSnapshot indents orphans with
    // `'  '.repeat(n.depth)` — and orphans are precisely a resume artefact — so a hand-edited
    // `depth: -1` throws RangeError out of the run.md writer on every commit. It also buys
    // extra decomposition levels: the cap is `node.depth + 1 > caps.maxDepth`.
    if (typeof n.depth !== 'number' || !Number.isFinite(n.depth) || n.depth < 0) {
      repairs.push(`节点 ${n.id} 的 depth 非法,重置为 0`)
      n.depth = 0
    } else n.depth = Math.trunc(n.depth)
    const it = (n.iteration ?? {}) as Partial<TaskNode['iteration']>
    // A missing counter reads as 0, never as "no limit": undefined + 1 is NaN, which never
    // satisfies >= maxIterations and would turn a bounded retry loop into an unbounded one.
    //
    // FLOORED AT ZERO for the same reason, through the other door. Every budget check is
    // `spent >= caps.maxIterations`, so a hand-edited `planReview: -5` buys 8 rounds where the
    // caps say 3 — and the caps are exactly what the escalation card invites the user to edit,
    // in the same file, one key away. NaN was covered; a negative number was not.
    const count = (v: unknown): number => (Number.isFinite(v) ? Math.max(0, Math.trunc(v as number)) : 0)
    n.iteration = {
      planReview: count(it.planReview),
      acceptance: count(it.acceptance),
      integration: count(it.integration),
      scoring: count(it.scoring),
      mergeResolve: count(it.mergeResolve),
    }
    if (typeof n.execStatus !== 'string') n.execStatus = ''
    if (typeof n.blockedReason !== 'string') n.blockedReason = ''
    // The two timestamps were the only persisted fields this pass never touched. Both feed
    // `Date.parse`, which COERCES rather than throwing — `updatedAt: 123` renders a terminal
    // node's 耗时 as 0s, and every reader that survives it today does so by carrying its own
    // `typeof` guard (TaskTreePanel, runRegistry). Two guards in two modules is not an
    // invariant, it is a record of who got bitten. Normalise once, here.
    for (const k of ['createdAt', 'updatedAt'] as const) {
      if (typeof n[k] !== 'string' || n[k].length === 0) {
        repairs.push(`节点 ${n.id} 的 ${k} 非法,已重置为恢复时刻`)
        n[k] = opts.now
      }
    }
    // startedAt is optional, so a bad value is DROPPED rather than invented: reseat stamps it
    // on the next active phase, and pretending the node started now would report a duration
    // that never happened.
    if (n.startedAt !== undefined && (typeof n.startedAt !== 'string' || n.startedAt.length === 0)) {
      repairs.push(`节点 ${n.id} 的 startedAt 非法,已清除(耗时将从恢复后的首个活动阶段重新计时)`)
      n.startedAt = undefined
    }
    if (!n.plan || typeof n.plan !== 'object') n.plan = emptyPlan()
    else for (const k of ['solution', 'keyPoints', 'risks', 'acceptance'] as const) {
      if (typeof n.plan[k] !== 'string') n.plan[k] = ''
    }
    // alternatives 是 validateLoadedNodes 唯一不碰的 plan 字段 —— 它就地补字段,所以
    // `alternatives: 'boom'` 能原样穿过去,而 serializeNode 会把它渲染进 body,一条
    // {staff:1} 会渲染成 [object Object]。逐条校验,坏的丢掉并记进 repairs。
    const rawAlts = (n.plan as { alternatives?: unknown }).alternatives
    if (rawAlts !== undefined) {
      const arr = Array.isArray(rawAlts) ? rawAlts : []
      const kept = arr.filter((x): x is { staff: string; solution: string } =>
        !!x && typeof x === 'object'
        && typeof (x as { staff?: unknown }).staff === 'string'
        && typeof (x as { solution?: unknown }).solution === 'string')
      const dropped = (Array.isArray(rawAlts) ? arr.length : 1) - kept.length
      if (dropped > 0) repairs.push(`节点 ${n.id} 的备选方案有 ${dropped} 条格式非法,已剔除`)
      if (kept.length > 0) n.plan.alternatives = kept
      else delete (n.plan as { alternatives?: unknown }).alternatives
    }
    // Entries, not just the array. serializeNode's body now walks `r.verdicts` and
    // `v.blocking`, so a half-written entry — exactly what a crash leaves behind — makes
    // every persist THROW. commit() catches it and blocks the node with a bare JS TypeError
    // as its reason, and because each commit reproduces it, every later --resume dies the
    // same way. Measured: '状态持久化失败: undefined is not an object (evaluating
    // r.verdicts.map)'. This function already normalises iteration/plan/phaseRoles for the
    // same reason; the logs were the gap.
    // §17.2 wants the validation summary shown to the user, and these three previously
    // dropped whole rounds of role opinions in silence.
    let lostRounds = 0
    n.reviewLog = roundArray(n.reviewLog, () => { lostRounds++ })
    n.acceptLog = roundArray(n.acceptLog, () => { lostRounds++ })
    if (lostRounds > 0) repairs.push(`节点 ${n.id}:${lostRounds} 处评审/验收记录已损坏,已丢弃(不影响后续执行)`)
    // Per-FIELD, not just "is it an object": serializeNode reads score.plan.rationale on every
    // commit. Same lesson as reviewLog — a reader that dereferences deeper than the validator
    // checks is a run that dies on disk state a human can produce by hand.
    const rawScore = (n.score ?? {}) as { plan?: unknown; exec?: unknown }
    n.score = {
      ...(scoreRecord(rawScore.plan) ? { plan: scoreRecord(rawScore.plan) } : {}),
      ...(scoreRecord(rawScore.exec) ? { exec: scoreRecord(rawScore.exec) } : {}),
    }
    // The same `!== true → false` discipline capBlocked already had. A truthy non-boolean
    // `interrupted: "yes"` matches neither reseat's `=== true` nor --retry-blocked's
    // capBlocked, so the node could never be reopened by anything — measured: every resume
    // stopped at BLOCKED 已中断 forever.
    if (n.interrupted !== undefined && n.interrupted !== true) n.interrupted = false
    if (n.mergeConflict !== undefined && n.mergeConflict !== true) n.mergeConflict = false
    // Same `!== true → false` discipline, and for a sharper reason than the others: this flag
    // is what stops 补救拆分 happening twice. A truthy non-boolean (`revised: "yes"` from a
    // hand-edited node.md) is not `=== true`, so the node would buy a SECOND corrective
    // subtree — which is the one bound the whole cost argument rests on.
    if (n.revised !== undefined && n.revised !== true) n.revised = false
    // 各阶段耗时: a plain number map off disk, so every value needs the same treatment the
    // iteration counters get. NaN would render as "NaNs" and a negative would render a phase
    // that finished before it began; both are reachable by hand-editing node.md, and the
    // renderer divides by 1000 rather than guarding.
    if (n.phaseMs !== undefined) {
      const raw = (n.phaseMs ?? {}) as Record<string, unknown>
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (LEGAL_STATUS.has(k) && Number.isFinite(v) && (v as number) >= 0) clean[k] = Math.trunc(v as number)
      }
      n.phaseMs = clean as TaskNode['phaseMs']
    }
    /**
     * 用量:和 phaseMs 同一个道理,而且更容易看出错来 —— 它会被渲染成
     * `NaN 次 · NaNk`,还会被子树合计一路传染到根节点那一行。盘上的 node.md 按设计
     * 可以手工编辑,所以每个字段都当敌意输入过一遍。
     */
    if (n.usage !== undefined) n.usage = sanitizeUsage(n.usage)
    if (n.discardedUsage !== undefined) n.discardedUsage = sanitizeUsage(n.discardedUsage)
    const pr = (n.phaseRoles ?? {}) as Record<string, unknown>
    n.phaseRoles = Object.fromEntries(PHASE_NAMES.map(p => [p, roleArray(pr[p])])) as Record<PhaseName, RoleBinding[]>
    if (typeof n.title !== 'string' || n.title.length === 0) n.title = n.id
    if (typeof n.goal !== 'string' || n.goal.length === 0) n.goal = n.title
    // `--retry-blocked` keys on this EXACT boolean. run.md and node.md are hand-editable, and
    // a truthy non-boolean (`capBlocked: "yes"`) would let the retry path reopen a node no
    // valve ever stopped. Only a real `true` counts; everything else means "not a valve".
    if (n.capBlocked !== undefined && n.capBlocked !== true) n.capBlocked = false
    // Same discipline as capBlocked one line up, and it was missing: node.md is hand-editable,
    // and reseat chooses which PHASE a retried node re-enters from this string. A garbage or
    // non-string value silently took the executable seat — the review-bypass this field exists
    // to prevent. Unknown values are dropped, which falls back to the derived check.
    if (n.capCategory !== undefined && !BLOCK_CATEGORIES.has(n.capCategory as string)) {
      repairs.push(`节点 ${n.id}:安全阀类别 ${String(n.capCategory)} 无法识别,已清除`)
      n.capCategory = undefined
    }
    // 手工重做的重入点。和上面 capCategory 完全同因:node.md 是可手工编辑的(升级卡片
    // 就在叫用户去改它),而这个字段决定节点**从哪个环节重入**。落盘是白拿的
    // (serializeNode 整节点倾倒,没有白名单),所以唯一的缺口正是在这一侧 ——
    // 实测垃圾值原样穿过。不认识的一律清掉,退化成「从分析重来」,而不是一个未定义的入口。
    if (n.redoFrom !== undefined && !(PHASE_NAMES as string[]).includes(n.redoFrom as string)) {
      repairs.push(`节点 ${n.id}:重做入口 ${String(n.redoFrom)} 不是合法环节名,已清除`)
      n.redoFrom = undefined
    }
    // 失败点。和 capCategory / redoFrom 同因:node.md 可手工编辑,而这个字段决定
    // 「快速重做失败环节」和「跳过失败环节」这两个键**做什么**。垃圾值清掉之后退化成
    // 「看不出是哪一步失败的」,那时界面会照实说,而不是按一个不存在的状态去派发。
    if (n.failedAt !== undefined && !LEGAL_STATUS.has(n.failedAt as string)) {
      repairs.push(`节点 ${n.id}:失败点 ${String(n.failedAt)} 不是合法状态名,已清除`)
      n.failedAt = undefined
    }
    /**
     * 手工跳过的那一个环节。**白名单比 PHASE_NAMES 更窄**,而这不是洁癖:
     * `skipPhase: 'execute'` 会让这个节点一行代码都不写就走到验收,
     * `skipPhase: 'plan'` 会让它带着空方案进评审 —— 两者都是「跳过 ≠ 放弃」那条界线的另一侧,
     * 而这个字段只有一条来路(用户在跳过关口上按的那一下),那条来路只产出这四个值。
     */
    if (n.skipPhase !== undefined && !SKIPPABLE_PHASES.has(n.skipPhase as string)) {
      repairs.push(`节点 ${n.id}:要跳过的环节 ${String(n.skipPhase)} 不在可跳过之列,已清除`)
      n.skipPhase = undefined
    }
    /**
     * 光校验**值**不够 —— 还要校验这个节点**有没有活可跳**。
     *
     * 评审实跑出来的那一条:手写一个 `status: READY, kind: executable, skipPhase: accept`
     * 的 node.md(空 plan、空 execStatus)→ 校验一句 repair 都不出 → stepExecute 从判决段
     * 进来 → **ACCEPTED,零次模型调用**,唯一留痕是 execStatus 上一句**假话**
     * 「用户在阻断后按了跳过」。这正是「不谎报完成」那条底线。
     *
     * 判据是**证据**,不是 `failedAt`:合法的跳过(planSkip)恰好会把 failedAt 清掉,
     * 拿它当判据会把用户真按过的那一次跳过在恢复时静默撤销。而证据是查得到的 ——
     * 跳过验收/测试验证意味着「执行者已经交过东西」,跳过质疑讨论意味着「有一份方案」,
     * 跳过集成验收意味着「有子任务」。同一个函数里 `confirmedDraft` 正是为这一类硬挡的。
     */
    if (n.skipPhase !== undefined) {
      const hasWork =
        n.skipPhase === 'accept' || n.skipPhase === 'verify'
          ? typeof n.execStatus === 'string' && n.execStatus.trim().length > 0
          : n.skipPhase === 'review'
            ? `${n.plan?.solution ?? ''}${n.plan?.keyPoints ?? ''}${n.plan?.acceptance ?? ''}`.trim().length > 0
            : (n.childIds ?? []).length > 0
      if (!hasWork) {
        repairs.push(
          `节点 ${n.id}:盘上写着要跳过${String(n.skipPhase)},但这个节点还没有可被跳过的产出` +
          `(执行自述/方案/子任务都是空的),已清除 —— 否则它会零调用地判为已验收`,
        )
        n.skipPhase = undefined
      }
    }
    /**
     * 补充指引。它**会被原样拼进提示词**,所以这里逐条过:键必须是合法环节名或 `all`,
     * 值必须是非空字符串,并按码点夹到上限。
     *
     * 不校验的后果不是崩,是更糟的那种:`guidance: {execute: {a: 1}}` 会被
     * `String(obj)` 变成「[object Object]」发给执行者,而屏幕上那一段看起来像一句正常的
     * 补充指引。按 UTF-16 截同样不行 —— 会把 emoji 劈成半个代理对原样进提示词。
     */
    if (n.guidance !== undefined) {
      const raw = (n.guidance && typeof n.guidance === 'object' ? n.guidance : {}) as Record<string, unknown>
      const clean: Record<string, string> = {}
      let dropped = 0
      for (const [k, v] of Object.entries(raw)) {
        const legal = k === 'all' || (PHASE_NAMES as string[]).includes(k)
        if (!legal || typeof v !== 'string' || v.trim().length === 0) { dropped++; continue }
        clean[k] = Array.from(v.trim()).slice(0, MAX_GUIDANCE_CHARS).join('')
      }
      if (dropped > 0) repairs.push(`节点 ${n.id}:${dropped} 条补充指引的环节名或内容不合法,已清除`)
      n.guidance = Object.keys(clean).length > 0 ? (clean as TaskNode['guidance']) : undefined
    }
    // 根方案关口 (spec §2 第三关) 的确认结果。Reachable on disk when the run was aborted
    // before the root's first commit consumed it, so it must survive — but it is also the one
    // field that SKIPS the plan phase, and a malformed one would send an empty plan straight
    // into review. Anything that is not the exact shape is dropped, which degrades to
    // "the plan role drafts it", never to "an empty plan is approved".
    // `!== undefined` let `null` through, and YAML's `confirmedDraft:` (empty) IS null. The
    // dereference below then threw out of validateLoadedNodes entirely — which efftask.tsx
    // catches as 恢复失败, so ONE malformed child node cost the user every node in the run.
    if (n.confirmedDraft !== undefined && (!n.confirmedDraft || typeof n.confirmedDraft !== 'object')) {
      repairs.push(`节点 ${n.id}:根方案确认记录已损坏,恢复后将由 plan 角色重新起草`)
      n.confirmedDraft = undefined
    }
    if (n.confirmedDraft !== undefined) {
      const kids = (n.confirmedDraft as { children?: unknown }).children
      const clean = Array.isArray(kids)
        ? kids
            .filter((c): c is { title: string; deps?: unknown } =>
              !!c && typeof c === 'object' && typeof (c as { title?: unknown }).title === 'string' && (c as { title: string }).title.length > 0)
            .map(c => ({ title: c.title, deps: strArray(c.deps) }))
        : null
      // An array whose every entry is malformed cleans to [] — which is NOT "no children",
      // it is "we lost them". Kept, it made stepStart skip the plan call and approve an EMPTY
      // decomposition: root went to WAITING_CHILDREN with childIds: [], advanceableKind
      // returned null, propagateBlocked had nothing to blame, and the run ended
      // '存在无法推进的阻断节点' with a grey root and no explanation — reproducibly, on every
      // later resume. Measured: planCalls = 0.
      //
      // `kids.length > 0` is what separates that from a LITERAL `children: []`, which is
      // legal and must survive: `applyRootDraft` writes exactly that for an EXECUTABLE root —
      // "presence of the field is the signal, not its length" — so an empty list means the
      // user confirmed "one task, no decomposition". Dropping it would silently discard a
      // gate decision they made and pay for a re-draft. (Tried it; `resumeCore.test.ts`'s
      // 一个空 children 列表本身是合法的 went red, correctly.)
      //
      // The genuinely dangerous shape — an empty list on a node that is NOT executable — is
      // refused one layer down, in stepStart's `confirmed` guard, because only there is
      // `node.kind` meaningful. A reader of `children[0]` must therefore handle empty; that
      // is a property of the field, not a hole in this validator.
      const lostChildren = clean !== null && clean.length === 0 && Array.isArray(kids) && kids.length > 0
      if (clean === null || lostChildren) {
        repairs.push(`节点 ${n.id}:根方案确认记录已损坏,恢复后将由 plan 角色重新起草`)
        n.confirmedDraft = undefined
      } else {
        n.confirmedDraft = { children: clean }
      }
    }
    // A worktree reference is a DISK path, and disk paths do not survive. serializeNode
    // round-trips it, so a resumed node arrives still claiming a worktree that dispose or gc
    // may have removed — and because the isolation gate is "no worktree yet", that stale
    // value makes the gate PASS: acquire is never called again and the executor runs against
    // a dead path, or against a base that never saw its dependencies' merges. Clearing it
    // forces a fresh acquire, which is also what re-bases the worktree.
    // Shape-checked BEFORE either branch reads it. `worktree: null` (YAML's empty value)
    // threw out of this function on the mergeConflict path — again costing the whole run — and
    // a malformed-but-truthy value slipped past stepExecute's isolation gate.
    if (n.worktree !== undefined && worktreeRef(n.worktree) === undefined) {
      repairs.push(`节点 ${n.id}:隔离工作区记录无法识别,已清除,恢复时将重新分配`)
      n.worktree = undefined
      // mergeConflict is DELIBERATELY kept. It is the only key that reopens a conflict block
      // (interrupted is false — a conflict is a verdict — and capBlocked is false — no valve
      // tripped), so clearing it left a node that NEITHER `--resume` NOR `--retry-blocked`
      // could touch, while its own blockedReason still told the user to run `/et --resume`.
      // That traded a loud failure (the previous version threw) for a silent one.
      // Clearing the worktree alone is safe and sufficient: stepExecute's isolation gate is
      // `!node.worktree`, so the node re-acquires a fresh one — measured, it then completes.
    }
    if (n.worktree !== undefined) {
      // EXCEPT for a conflict block. There the path is not stale bookkeeping — it is where
      // the human was told to go and fix things. Clearing it forces a fresh acquire(), whose
      // `checkout -B <branch> <integration>` resets the node branch and parks the human's
      // commit on a salvage ref: measured, the fix left the tree entirely and was never
      // merged. Keeping the reference is also what lets handoff() report the worktree.
      if (n.mergeConflict === true) {
        repairs.push(`节点 ${n.id}:保留冲突工作区 ${n.worktree.path},恢复后将重跑验收并重试合并`)
      } else {
        repairs.push(`节点 ${n.id}:清除陈旧的隔离工作区引用,恢复时将重新分配`)
        n.worktree = undefined
      }
    }
  }

  // ---- referential integrity: block the referrer, keep the edge ----
  for (const n of byId.values()) {
    if (n.deps.some(d => d === n.id)) {
      repairs.push(`节点 ${n.id}:丢弃自依赖(自依赖必然死锁)`)
      n.deps = n.deps.filter(d => d !== n.id)
    }
    const missingDeps = n.deps.filter(d => !byId.has(d))
    if (missingDeps.length > 0) block(n, `依赖节点缺失(${missingDeps.join('、')})`)
    const missingKids = n.childIds.filter(c => !byId.has(c))
    if (missingKids.length > 0) block(n, `子节点缺失(${missingKids.join('、')})`)
    if (n.parentId !== null && !byId.has(n.parentId)) {
      repairs.push(`节点 ${n.id} 的父节点 ${n.parentId} 不存在,改挂为根级`)
      n.parentId = null
    }
  }

  for (const id of depCycleMembers([...byId.values()])) {
    const n = byId.get(id)!
    if (n.status !== 'BLOCKED') block(n, '依赖成环,无法确定执行顺序')
  }

  // ---- rebuild both link directions ----
  for (const n of byId.values()) {
    for (const cid of n.childIds) {
      const child = byId.get(cid)
      // Do NOT overwrite unconditionally. On a cyclic childIds graph that manufactures a
      // parentId cycle, after which NO node has parentId === null and the tree can neither
      // render nor walk ancestors. Only fill in a parent that is genuinely absent.
      if (child && child.parentId === null && child.id !== n.id) {
        repairs.push(`修正 ${cid} 的父指针为 ${n.id}`)
        child.parentId = n.id
      }
    }
  }
  for (const n of byId.values()) {
    if (n.parentId === null) continue
    const parent = byId.get(n.parentId)
    if (parent && !parent.childIds.includes(n.id)) {
      repairs.push(`把 ${n.id} 补回父节点 ${parent.id} 的子列表`)
      parent.childIds.push(n.id)
    }
  }
  // Last resort: if the link repair left the graph with no root-level node at all (a
  // childIds cycle among every node), free the lowest id so the tree has somewhere to start.
  if (byId.size > 0 && ![...byId.values()].some(n => n.parentId === null)) {
    const first = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))[0]
    repairs.push(`所有节点都声称有父节点(父子关系成环),已把 ${first.id} 提为根级`)
    first.parentId = null
  }

  // ---- guarantee the invariant run() asserts on every iteration ----
  const root = byId.get('root')
  if (!root) {
    repairs.push('恢复的树里没有根节点,已合成一个根并挂上所有根级节点')
    const orphans = [...byId.values()].filter(n => n.parentId === null)
    const synthesized = createNode({
      id: 'root',
      title: opts.goal.split('\n').map(l => l.trim()).find(l => l.length > 0) || '根任务(恢复时合成)',
      goal: opts.goal,
      parentId: null, deps: [], depth: 0,
      // The REAL roster: runRoundtable turns an empty one into a single main-model reviewer,
      // so an empty roster here would judge the whole run on a panel the gate never showed.
      phaseRoles: opts.phaseRoles,
      now: opts.now,
    })
    if (orphans.length === 0) {
      synthesized.status = 'BLOCKED'
      synthesized.blockedReason = '恢复时没有恢复到任何节点,run 目录可能是空的或已损坏'
      synthesized.interrupted = false
    } else if (opts.goal.trim().length === 0) {
      // No manifest either → no objective to accept against. Letting this root reach
      // INTEGRATION_ACCEPT would decide the entire run on an empty question.
      synthesized.kind = 'decompose'
      synthesized.status = 'BLOCKED'
      synthesized.blockedReason = '原始目标已丢失(run.md 不可读),无法判定整体验收'
      synthesized.interrupted = false
      synthesized.childIds = orphans.map(o => o.id)
      for (const o of orphans) o.parentId = 'root'
    } else {
      synthesized.kind = 'decompose'
      synthesized.status = 'WAITING_CHILDREN'
      synthesized.childIds = orphans.map(o => o.id)
      for (const o of orphans) o.parentId = 'root'
    }
    byId.set('root', synthesized)
  } else {
    // A recovered orphan that is not the root belongs somewhere, or it will run and never
    // count towards anything.
    for (const n of byId.values()) {
      if (n.id === 'root' || n.parentId !== null) continue
      repairs.push(`节点 ${n.id} 没有父节点,已挂到根节点下`)
      n.parentId = 'root'
      if (!root.childIds.includes(n.id)) root.childIds.push(n.id)
    }
  }

  return { nodes: [...byId.values()], repairs }
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  // Math.round,与 parseDirectives 的同名函数一致。两路对小数取整不同(60.5 → 60 vs 61)
  // 就意味着「手改 run.md」和「说给抽取模型听」会得到不同的值,而这两条路必须等价 ——
  // 否则 resume 会静默改掉一个用户从没改过的门槛。
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

export interface ManifestResult { config: EffTaskConfig; degraded: string[] }

/**
 * Rebuild the run's config from `run.md`'s frontmatter — the parallelism, roster, safety
 * caps and original objective the run was started with.
 *
 * Same rule as `loadRun`: ONE damaged file must not cost the user the recovered tree. A
 * missing or unparseable manifest degrades to defaults and says so in `degraded`, which the
 * resume gate shows; every node.md is still on disk and the roster is re-confirmable there.
 *
 * Every number is clamped rather than trusted: this file is as hand-editable as node.md, and
 * a `parallelism: 99999` read straight into the pool would be a self-inflicted fork bomb.
 */
export async function readRunManifest(fs: FsLike, runDir: string): Promise<ManifestResult> {
  const degraded: string[] = []
  const base: EffTaskConfig = {
    goalPrompt: '', parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [],
  }
  let fm: Record<string, unknown>
  try {
    const text = await fs.readFile(`${runDir}/run.md`)
    const m = text.match(/^---\n([\s\S]*?)\n---/)
    if (!m) throw new Error('run.md 缺少 frontmatter')
    const parsed = yamlParse(m[1])
    if (!parsed || typeof parsed !== 'object') throw new Error('run.md frontmatter 不是一个映射')
    fm = parsed as Record<string, unknown>
  } catch (e) {
    degraded.push(`run.md 无法读取或解析(${e instanceof Error ? e.message : String(e)}),配置回退默认值`)
    return { config: base, degraded }
  }

  if (typeof fm.goalPrompt === 'string' && fm.goalPrompt.length > 0) base.goalPrompt = fm.goalPrompt
  else degraded.push('run.md 缺少 goalPrompt(原始目标),整体验收将无法判定')
  base.parallelism = clampParallelism(fm.parallelism)

  const caps = (fm.caps ?? {}) as Record<string, unknown>
  const rebuilt: Caps = {
    maxDepth: clampInt(caps.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth),
    maxNodes: clampInt(caps.maxNodes, 1, 5000, DEFAULT_CAPS.maxNodes),
    maxIterations: clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations),
    // 上限 2 小时。原来是 1 小时,而这条阀量的已经是**静默时长**不是总时长了 ——
    // 「两个小时一条消息都没吐」在任何 provider 上都只可能是挂死,所以让它可配到 2 小时
    // 不会削弱它,只是把「我这台机器网络就是烂」这种情况留给用户自己定。
    nodeTimeoutMs: clampInt(caps.nodeTimeoutMs, 1000, 7_200_000, DEFAULT_CAPS.nodeTimeoutMs),
    // 上限 30 天:这条阀挡的是「永远没人回答」,不是「回答得慢」。
    humanTimeoutMs: clampInt(caps.humanTimeoutMs, 1000, 30 * 24 * 60 * 60 * 1000, DEFAULT_CAPS.humanTimeoutMs),
  }
  // Rebuilding field-by-field silently dropped scoreThreshold, so a run configured with one
  // lost it on resume. Carry it when present.
  if (caps.scoreThreshold !== undefined) {
    // A non-number silently became 0, and `worst < 0` never holds — so the gate said
    // "评分低于 0 触发一轮返工" while rework could never trigger. Say so instead.
    const t = caps.scoreThreshold
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      // Quoted, so `"80"` does not read as "80 is not a number".
      degraded.push(`run.md 里的 caps.scoreThreshold 不是数字(写的是 ${JSON.stringify(t)}),已忽略:评分将只记录、不触发返工`)
    } else if (t < 0 || t > 100) {
      // clampInt turned -5 into 0, and `worst < 0` never holds — the same "the gate promises
      // a rework that can never fire" this branch exists to prevent, through the other door.
      degraded.push(`run.md 里的 caps.scoreThreshold 超出 0-100(写的是 ${t}),已忽略:评分将只记录、不触发返工`)
    } else {
      rebuilt.scoreThreshold = Math.trunc(t)
    }
  }
  // 手改 run.md 是一条绕开 parseDirectives 全部校验的路,所以这里重做同样的夹取。
  if (caps.maxSeatsPerPhase !== undefined) rebuilt.maxSeatsPerPhase = clampInt(caps.maxSeatsPerPhase, 1, 20, DEFAULT_MAX_SEATS_PER_PHASE)
  if (caps.quorum !== undefined) rebuilt.quorum = clampInt(caps.quorum, 1, 100, 100)
  if (caps.quorumSeats !== undefined) rebuilt.quorumSeats = clampInt(caps.quorumSeats, 1, 20, 1)
  if (caps.planConverge === '圆桌' || caps.planConverge === '精化') rebuilt.planConverge = caps.planConverge
  base.caps = rebuilt

  const pr = (fm.phaseRoles ?? {}) as Record<string, unknown>
  base.phaseRoles = Object.fromEntries(
    PHASE_NAMES.map(p => [p, roleArray(pr[p])]),
  ) as Record<PhaseName, RoleBinding[]>

  // 角色定义读回。**必须**读回:writeRunManifest 整文件重写 run.md,只写不读的字段第一次
  // --resume 就清零 —— 席位还在,职责简报没了,名册长得一模一样而模型收到的东西变了。
  // 校验在这里重做一遍,因为手改 run.md 是一条绕开 parseRoleDefs 全部校验的路。
  const rawDefs = fm.roleDefs
  if (Array.isArray(rawDefs)) {
    const kept: RoleDef[] = []
    for (const d of rawDefs) {
      const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
      // `step` 是新键名,`stage` 是旧的;中文别名也收 —— 手改 run.md 的人会照着文档写
      // 中文。归一到内部 phase 名之后再校验,否则一份合法的手改配置会被判成「不完整」。
      const rawStep = typeof o.step === 'string' && o.step.length > 0
        ? o.step
        : (typeof o.stage === 'string' ? o.stage : '')
      const step = STEP_ALIASES[rawStep] ?? rawStep
      const ok = typeof o.name === 'string' && o.name.length > 0
        && (PHASE_NAMES as string[]).includes(step)
        && typeof o.output === 'string' && o.output.length > 0
        && typeof o.purpose === 'string' && o.purpose.length > 0
      if (!ok) {
        degraded.push(`run.md 里有一条角色定义不完整(需要 name/step/output/purpose),已忽略`)
        continue
      }
      kept.push({
        name: o.name as string, stage: step as PhaseName,
        output: o.output as string, purpose: o.purpose as string,
        staff: Array.isArray(o.staff) ? o.staff.filter((s): s is string => typeof s === 'string' && s.length > 0) : [],
      })
    }
    if (kept.length > 0) base.roleDefs = kept
  }

  // 待收口状态读回。只写不读的话,「跑完先还终端、回头再收口」整条路都不存在。
  const ph = fm.pendingHandoff
  if (ph && typeof ph === 'object') {
    const o = ph as Record<string, unknown>
    const commits = typeof o.commits === 'number' && Number.isFinite(o.commits) ? Math.max(0, Math.trunc(o.commits)) : 0
    if (typeof o.branch === 'string' && o.branch.length > 0) {
      base.pendingHandoff = {
        branch: o.branch,
        commits,
        ...(typeof o.integrationPath === 'string' ? { integrationPath: o.integrationPath } : {}),
        kept: Array.isArray(o.kept)
          ? o.kept.filter((k): k is { path: string; why: string } =>
              !!k && typeof k === 'object'
              && typeof (k as { path?: unknown }).path === 'string'
              && typeof (k as { why?: unknown }).why === 'string')
          : [],
        salvage: Array.isArray(o.salvage) ? o.salvage.filter((x): x is string => typeof x === 'string') : [],
        outcome: o.outcome === 'blocked' ? 'blocked' : 'completed',
        ...(typeof o.reason === 'string' && o.reason.length > 0 ? { reason: o.reason } : {}),
      }
    } else {
      degraded.push('run.md 里的待收口记录缺少分支名,已忽略:集成分支需要你自己处置')
    }
  }

  // 跳过的环节。手改 run.md 是一条绕开 parseDirectives 全部校验的路,所以归一和白名单
  // 都要在这里重做一遍;不认识的项丢弃并记进 degraded,而不是让一个拼错的环节名静默
  // 变成「没跳过」。
  if (Array.isArray(fm.skipSteps)) {
    const kept: PhaseName[] = []
    for (const raw of fm.skipSteps) {
      const v = typeof raw === 'string' ? (STEP_ALIASES[raw] ?? raw) : ''
      if ((PHASE_NAMES as string[]).includes(v)) { if (!kept.includes(v as PhaseName)) kept.push(v as PhaseName) }
      else degraded.push(`run.md 里的跳过环节「${String(raw)}」不是合法环节名,已忽略(该环节会照常运行)`)
    }
    if (kept.length > 0) base.skipSteps = kept
  }

  /**
   * 定向注入(§定向注入)。**必须读回** —— writeRunManifest 整文件重写 run.md,一个只写不读的
   * 字段会在第一次 `--resume` 时清零:恢复后的名册一模一样,而模型收到的东西变了,
   * 而界面上没有任何地方能让用户发现。`roleDefs` 和 `resumes` 都为这条注释付过学费。
   *
   * 手改 run.md 是一条绕开 parseDirectives 全部校验的路,所以归一 + 白名单 + 夹取都要
   * 在这里重做一遍。这两个字段会被**原样拼进提示词**,所以类型也要逐个过:
   * `phaseGuidance: {review: 12}` 会以「12」的形状发给评审员,而屏幕上看不出来。
   */
  if (fm.phaseGuidance && typeof fm.phaseGuidance === 'object' && !Array.isArray(fm.phaseGuidance)) {
    const kept: Partial<Record<PhaseName, string>> = {}
    for (const [rawKey, rawVal] of Object.entries(fm.phaseGuidance as Record<string, unknown>)) {
      const v = STEP_ALIASES[rawKey] ?? rawKey
      const text = typeof rawVal === 'string' ? rawVal.trim() : ''
      if (!(PHASE_NAMES as string[]).includes(v) || text.length === 0) {
        degraded.push(`run.md 里给「${String(rawKey)}」的那段定向要求不合法,已忽略(它不会进任何提示词)`)
        continue
      }
      kept[v as PhaseName] = Array.from(text).slice(0, MAX_GUIDANCE_CHARS).join('')
    }
    if (Object.keys(kept).length > 0) base.phaseGuidance = kept
  }
  if (Array.isArray(fm.roleGuidance)) {
    const kept: { name: string; text: string }[] = []
    for (const raw of fm.roleGuidance) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const name = typeof r.name === 'string' ? r.name.trim() : ''
      const text = typeof r.text === 'string' ? r.text.trim() : ''
      if (name.length === 0 || text.length === 0) {
        degraded.push('run.md 里有一条定向要求缺角色名或内容,已忽略')
        continue
      }
      kept.push({ name, text: Array.from(text).slice(0, MAX_GUIDANCE_CHARS).join('') })
    }
    if (kept.length > 0) base.roleGuidance = kept
  }

  base.notices = Array.isArray(fm.notices) ? fm.notices.filter((n): n is string => typeof n === 'string') : []
  if (typeof fm.mainModel === 'string') base.mainModel = fm.mainModel
  if (typeof fm.resumeGuidance === 'string') base.resumeGuidance = fm.resumeGuidance
  // Re-emitted verbatim on every later manifest write, so the resume history accumulates
  // instead of being flattened by the next full-file rewrite.
  if (Array.isArray(fm.resumes)) {
    base.resumes = fm.resumes
      .filter((r): r is ResumeRecord => !!r && typeof r === 'object' && typeof (r as { at?: unknown }).at === 'string')
      .map(r => ({
        at: r.at,
        reseated: Number.isFinite(r.reseated) ? r.reseated : 0,
        exhausted: Number.isFinite(r.exhausted) ? r.exhausted : 0,
        ...(Number.isFinite((r as { retried?: number }).retried) ? { retried: (r as { retried: number }).retried } : {}),
        repairs: Array.isArray(r.repairs) ? r.repairs.filter((x): x is string => typeof x === 'string') : [],
      }))
  }
  return { config: base, degraded }
}
