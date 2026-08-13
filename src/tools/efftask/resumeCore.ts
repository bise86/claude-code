import { parse as yamlParse } from 'yaml'
// 「零贡献」那句注记的措辞和 pipeline / 回溯共用一份 —— 各写一份的话,哪天改了措辞,
// 这次回填就会把真的零贡献节点也放行。
import { NO_CONTRIBUTION_NOTE } from './backtrack.js'
import { MAX_DEPS_RECALC_RECORDS, MAX_NODES_CEILING, clampParallelism, createNode, emptyPhaseRoles, emptyPlan, BLOCK_CATEGORIES, DEGRADABLE_PHASES, DEFAULT_CAPS, MAX_GUIDANCE_CHARS, SKIPPABLE_PHASES, DEFAULT_MAX_SEATS_PER_PHASE, DEFAULT_PARALLELISM, MAX_MERGE_RESOLVE, MIN_MERGE_RESOLVE, MIN_TRUNK_RESOLVE, MAX_TRUNK_RESOLVE, DEFAULT_TRUNK_RESOLVE, NODE_STATUSES, PHASE_NAMES, STEP_ALIASES, ACTIVE_STATUSES } from './types.js'
import type { Caps, DegradeRecord, DepsRecalcRecord, EffTaskConfig, NodeKind, NodePlan, PhaseName, ResumeRecord, RoleBinding, RoundtableRecord, TaskNode, ScoreRecord } from './types.js'
import type { FsLike } from './persistence.js'
import type { RoleDef } from './roleDefs.js'
import { isStrictness } from './strictness.js'
import { capBlockingList, capText, MAX_BLOCKING_CHARS, MAX_BLOCKING_ITEMS, MAX_FIELD_CHARS, MAX_SUMMARY_CHARS } from './parseOutput.js'
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
        /**
         * **和 `parseVerdict` 同一条不变式**(`parseOutput.ts`:`obj.pass === true &&
         * blocking.length === 0`)。这里此前只判 `x.pass === true`,于是这道门是全仓库
         * 唯一能产出「pass:true 且 blocking 非空」的地方 —— 一个解析器按定义排除掉的形状。
         *
         * 后果不是理论上的:`synthesizeVerdicts` 把这种裁决算作 failing 且不计入 approving
         * (即它照样否决圆桌),而 `feedbackItems` 照收它的 blocking。两边合起来,一份手工
         * 编辑过、或老版本写下的 node.md 会带着一个自相矛盾的裁决穿过整条恢复链路,而
         * node.md 上没有任何一处说得出「这一席到底是通过还是没通过」。
         *
         * 口径对齐之后这个状态在盘上就不存在了,所以下游不需要再为它写任何分支。
         */
        pass: x.pass === true && capBlockingList(blocking).length === 0,
        // Same caps as the parse boundary: node.md is hand-editable, and this is the other
        // door into the same field.
        blocking: capBlockingList(blocking),
        comments: typeof x.comments === 'string' ? capText(x.comments, MAX_BLOCKING_CHARS) : '',
        ...(x.infra === true ? { infra: true as const } : {}),
        ...(x.timeout === true ? { timeout: true as const } : {}),
        /**
         * 下面这四个字段此前**读不回来**,而每一个丢掉都有具体后果:
         *
         *  - `manual`:一条**人工强制通过**读回来之后会渲染成和一位真评审员点头
         *    **逐字相同**的「通过」(persistence.roundtableBody 和详情页都按它分叉)——
         *    而那个区别正是强制通过这一整套存在的理由;
         *  - `roleTag`:「这几条裁决属于同一个角色的几个员工」无从恢复,而按角色分组
         *    正是「一个角色多员工收敛成一个结论」的前提(这条理由写在 Verdict.roleTag 上);
         *  - `rateLimited`:圆桌耗尽时的补救建议靠它分叉,丢了就退回「去查角色模型和网络」;
         *  - `timeoutKind`:两种超时的处理方式**相反**(见 Verdict.timeoutKind)。
         *
         * 都走保守校验:只认严格相等的字面量,手改成别的值一律当没有。
         */
        ...(x.manual === true ? { manual: true as const } : {}),
        ...(typeof x.roleTag === 'string' && x.roleTag !== '' ? { roleTag: capText(x.roleTag, 200) } : {}),
        ...(x.rateLimited === true ? { rateLimited: true as const } : {}),
        /**
         * `retracted` —— **本轮撤回的历史意见**,和上面那四个死在同一行上的字段是同一类。
         *
         * 三份独立验收各自实跑到同一条路径:`serializeNode` 写得进 frontmatter、
         * `parseNodeFile` 读得出来,而这个函数是**逐字段重建**的,字段清单里没有它 ——
         * 于是每一次 `--resume` 都把撤回记录抹掉,而下一次 persist 又把抹掉的结果写回盘。
         * 后果不是「少一个字段」:被作者举证反驳掉、裁决员已经核实撤回的那条意见会**复活**,
         * 重新进 `feedbackItems`、重新被 `reviewRepeatNotice` 追着要回应、重新被
         * `stuckItems` 报成「至今未解决」。`Verdict.retracted` 上写着「不落到数据上,
         * 作废就只是提示词里的一句话」—— 少了这一行,那句话对任何 resume 过的运行都为真。
         *
         * 走 `blocking` 的同一对上限:node.md 可以手工编辑,而这是进入这个字段的另一道门。
         */
        ...(Array.isArray(x.retracted) && strArray(x.retracted).length > 0
          ? { retracted: capBlockingList(strArray(x.retracted), '撤回项') }
          : {}),
        /**
         * `advice` —— **修改建议**,和 `retracted` 死在同一行上的那一类,一并在这里读回来。
         *
         * 它是「触顶不失败,把意见带给下一个环节」这整套东西唯一有价值的载荷:降级记录里的
         * `advice`、执行/验收提示词里的「累积修改建议」都从它取。逐字段重建里漏掉它,
         * 一次 `--resume` 之后所有降级节点带下去的建议全部变空,而 node.md 上看不出来 ——
         * 提示词还在照常渲染那一段标题,底下什么都没有。
         */
        ...(Array.isArray(x.advice) && strArray(x.advice).length > 0
          ? { advice: capBlockingList(strArray(x.advice), '修改建议') }
          : {}),
        ...(x.timeoutKind === 'human' || x.timeoutKind === 'stall' || x.timeoutKind === 'total'
          ? { timeoutKind: x.timeoutKind }
          : {}),
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
      /**
       * `step` 一直在这里被静默丢掉 —— 逐字段重建只列了上面三个键,而 `serializeNode` 是
       * `{...node}` 全量倾倒,所以它**写得出去、读不回来**。后果不是少一个字段:
       *
       *  - `stepOfRound()` 对每条历史记录返回 undefined → `judgeNotice` 的
       *    `filter(r => stepOfRound(r) === step)` 恒为空 → **每一次 `--resume` 之后,测试
       *    验证/验收/集成验收三关的「你前几轮提过什么」全部失效**,退回 reviewConvergence
       *    整个文件专门治的那个病(每轮换一批新理由,直到迭代耗尽);
       *  - `stepExecute` 里 `acceptLog.filter(r => r.step !== 'integrate')` 恢复后不再过滤
       *    任何东西 → 一条集成验收意见会被当成「上一轮**验收**未通过」喂给执行者。
       *
       * 新加的 `strictness` 会一模一样地死在这里,所以两条一起修。校验按 `verdictArray`
       * 里 `manual`/`roleTag` 的规矩来:只认严格合法值 —— 手改 node.md 是一条绕开全部
       * 上游校验的路。
       */
      ...(typeof r.step === 'string' && (PHASE_NAMES as readonly string[]).includes(r.step)
        ? { step: r.step as PhaseName } : {}),
      ...(isStrictness(r.strictness) ? { strictness: r.strictness } : {}),
      /**
       * `voided` 会死在**同一行**上,理由和上面 step / strictness 逐字相同。
       *
       * 它的后果是三个里最刺眼的一种:一条**已作废**的裁决恢复之后重新长得和真裁决一模一样
       * ——「node.md 上读得出哪一轮不算数」这个承诺只活到下一次 `--resume`。
       * 校验按同一条规矩:只认非空字符串(手改 node.md 是一条绕开全部上游校验的路)。
       */
      ...(typeof r.voided === 'string' && r.voided.length > 0 ? { voided: r.voided } : {}),
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
/**
 * 这个节点**有没有可被跳过 / 可被放行的产出** —— 跳过和强制通过共用的那道证据校验。
 *
 * 判据是**证据**,不是 `failedAt`:合法的跳过/强制通过恰好会把 failedAt 清掉(见
 * reseatForRerun),拿它当判据会把用户真按过的那一次在恢复时静默撤销。而证据是查得到的
 * —— 放行验收/测试验证意味着「执行者已经交过东西」,放行质疑讨论意味着「有一份方案」,
 * 放行集成验收意味着「有子任务」。
 *
 * 一份实现,两个消费者:各写一份的话最松的那一份就是实际生效的那一份,而这两条的后果
 * (零调用判 ACCEPTED)一模一样。
 */
function hasWorkToSkip(n: Partial<TaskNode>, phase: string): boolean {
  if (phase === 'accept' || phase === 'verify') {
    return typeof n.execStatus === 'string' && n.execStatus.trim().length > 0
  }
  if (phase === 'review') {
    return `${n.plan?.solution ?? ''}${n.plan?.keyPoints ?? ''}${n.plan?.acceptance ?? ''}`.trim().length > 0
  }
  return (n.childIds ?? []).length > 0
}

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
      // 测试验证有了自己的一维(理由见 TaskNode.iteration)。老 node.md 里没有这个键,
      // `count(undefined)` 读成 0 —— 那正是「这个节点还没跑过测试验证」的正确含义。
      verification: count(it.verification),
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
    /**
     * 上一版方案。和 `n.plan` 对称的兜底,而**理由不是兼容,是这个文件的通例**:每一个
     * 模型产出的字段在这里都有一道校验,因为 node.md 是手工可编辑的。
     *
     * 缺席合法(第 1 轮、或方案从没重出过),所以非对象一律 `delete` 而不是补 `emptyPlan()`
     * —— 补一份四个空串的假上一版,会让 `prevPlanSection` 把整份方案算成「全都改动过」,
     * 恰好把重复率推到最大。alternatives / responses 也一并剥掉:存进去时就该没有,盘上
     * 出现说明被手改过,而它们会跟着进评审提示词。
     */
    const rawPrev = (n as { prevPlan?: unknown }).prevPlan
    if (rawPrev !== undefined) {
      if (!rawPrev || typeof rawPrev !== 'object' || Array.isArray(rawPrev)) {
        repairs.push(`节点 ${n.id} 的上一版方案格式非法,已清除(本轮评审将不做版本对照)`)
        delete n.prevPlan
      } else {
        const p = rawPrev as Record<string, unknown>
        let bad = 0
        for (const k of ['solution', 'keyPoints', 'risks', 'acceptance'] as const) {
          // 坏字段要**记进 repairs**。原来这里静默补空串,于是 `prevPlan.solution: 123` 会
          // 无声无息地变成一份「上一版这里是空的」,而 §17.2 要求修补对用户可见。
          if (typeof p[k] !== 'string') { p[k] = ''; bad++ }
          // 长度上限。`MAX_FIELD_CHARS` 只管模型产出那一侧,盘上手改的一路不设防 —— 实测
          // 四字段各 200 万字时评审提示词 24 MB、node.md 24 MB,不抛不卡,直接进模型调用。
          // 这一维对 `n.plan` 是既有敞口(上面那一段也只查 typeof),prevPlan 会把它翻倍。
          else if ((p[k] as string).length > MAX_FIELD_CHARS) {
            p[k] = capText(p[k] as string, MAX_FIELD_CHARS)
            bad++
          }
        }
        if (bad > 0) repairs.push(`节点 ${n.id} 的上一版方案有 ${bad} 个字段格式非法或超长,已修正`)
        delete p.alternatives
        delete p.responses
        /**
         * **四个字段全空 = 没有对照物,和「非对象」是同一件事。**
         *
         * 上面那句注释说「非对象一律 delete 而不是补 emptyPlan(),补一份四个空串的假上一版会
         * 把重复率推到最大」—— 而逐字段兜底在四个字段**都坏或都缺**时造出的东西**逐字相同**。
         * 最短复现:node.md 里手写 `prevPlan: {}`。验收把提示词打出来才看见:四个字段全被判成
         * 「改动过」、「逐字未变」那一行整个不出现,评审员收到「上一版是空白的,请找出这一版
         * 新引入的缺陷」—— 整份方案都成了新引入。声明了绝不造的形状,由校验器自己造了出来。
         *
         * `prevPlanSection` 那边还有一道 `usable` 兜底(不拿空串冒充原文),两道都要:这一道
         * 让盘上不留这种脏数据,那一道让运行中产生的同形数据也不至于渲染出来。
         */
        if (['solution', 'keyPoints', 'risks', 'acceptance'].every(k => p[k] === '')) {
          repairs.push(`节点 ${n.id} 的上一版方案四个字段全为空,已清除(空白的上一版会让整份方案都被当成新引入)`)
          delete n.prevPlan
        } else {
          n.prevPlan = p as unknown as NodePlan
        }
      }
    }
    /**
     * 当前方案被判坏、重置成空的时候,上一版也跟着走。
     *
     * 一份空的当前方案配一份完整的上一版,`prevPlanSection` 会把四个字段全算成「改动过」,
     * 于是整份上一版原文被灌回提示词,而当前方案那一段是空的 —— 没有任何对照价值,只有成本。
     * (顺带记一笔:`n.plan = emptyPlan()` 那一支**一句 repair 都不记**,而它抹掉的是整份方案。
     * 那是既有行为,不在这次的改动面里,但两条口径不一致在同一个文件里读起来很刺眼。)
     */
    if (n.prevPlan && ['solution', 'keyPoints', 'risks', 'acceptance'].every(k => n.plan[k as keyof NodePlan] === '')) {
      repairs.push(`节点 ${n.id} 的当前方案为空,上一版方案一并清除(没有可对照的东西)`)
      delete n.prevPlan
    }
    /**
     * 轮次戳。没有它,`prevPlan` 就和 `iteration.planReview` 脱钩 —— 见 `TaskNode.prevPlanRound`。
     * 盘上戳坏了 / 缺了,退化成「没有上一版」,而不是让渲染门去信一个坏数。
     */
    if (n.prevPlan) {
      const r = (n as { prevPlanRound?: unknown }).prevPlanRound
      if (!Number.isFinite(r) || (r as number) < 1) {
        repairs.push(`节点 ${n.id} 的上一版方案缺少有效轮次号,已清除(无法确认它是哪一轮判过的)`)
        delete n.prevPlan
        delete n.prevPlanRound
      }
    } else {
      delete n.prevPlanRound
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
    /**
     * 两份「逐条处置」。和 alternatives 同一条理由,而后果更直接:这两个字段会**原样进
     * 裁决提示词**(reviewPrompt 整份 stringify、`execResponsesSection` 逐条渲染),
     * 一条 `{a:1}` 会在评审员眼里变成一条内容为 `[object Object]` 的「回应」,而它旁边
     * 写着「作者说他解决了第 3 条」。非字符串项和空白项一律丢掉,丢了要记进 repairs。
     */
    const fixResponses = (get: () => unknown, set: (v: string[] | undefined) => void, what: string): void => {
      const raw = get()
      if (raw === undefined) return
      const arr = Array.isArray(raw) ? raw : []
      const kept = arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      const dropped = (Array.isArray(raw) ? arr.length : 1) - kept.length
      if (dropped > 0) repairs.push(`节点 ${n.id} 的${what}有 ${dropped} 条格式非法,已剔除`)
      /**
       * **在恢复边界上也要重新夹一次上限**,不能只滤类型。
       *
       * `capBlockingList` 自己的注释写着它「Shared by the parse boundary and the resume
       * boundary, because they disagreed」—— 而这两个新字段当初只接了解析那一侧。node.md
       * 是手工可编辑的文本,崩溃残留也长这样;验收实测:盘上放 5000 条 × 508 字,恢复之后
       * **一条没夹**原样回到内存,再落盘就是 9.5 MB 的 node.md,而 `commit()` 每次阶段跳转
       * 都全量重写它。旁边 `verdict.blocking` 走同一条恢复路径,它是夹了的。
       *
       * `capBlockingList` 幂等,所以对已经夹过的值重跑无害(那正是它幂等的原因)。
       */
      set(kept.length > 0 ? capBlockingList(kept, '回应') : undefined)
    }
    fixResponses(
      () => (n.plan as { responses?: unknown }).responses,
      v => { if (v) n.plan.responses = v; else delete (n.plan as { responses?: unknown }).responses },
      '方案逐条处置',
    )
    fixResponses(
      () => (n as { execResponses?: unknown }).execResponses,
      v => { if (v) n.execResponses = v; else delete (n as { execResponses?: unknown }).execResponses },
      '执行逐条处置',
    )
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
    /**
     * 降级放行记录,**逐字段校验**,理由和 `roundArray` / `scoreRecord` 逐字相同。
     *
     * `serializeNode` 是 `{...node}` 全量倾倒,所以 `degraded` 本身**能**穿过 --resume ——
     * 但它是**未经校验**地穿过去的。node.md 按设计可以手工编辑,崩在半路也会留下半份记录,
     * 而下游会 `d.advice.join()`、`degraded.length`:一个 `degraded: 'boom'` 或者一条缺
     * `advice` 的记录会在 `commit()` 里抛 TypeError,把节点以一句原始 TypeError 阻断 ——
     * 而且每一次 resume 都重演一遍。这正是 roundArray 当年被写出来的那个失败。
     *
     * 形状不对的**整条丢掉**并计进修复清单(§17.2 要把校验结果讲给用户听),不静默留半条:
     * 半条降级记录会让渲染层说「这个节点降级放行过」却给不出降级的是哪一关。
     */
    if (n.degraded !== undefined) {
      const before = Array.isArray(n.degraded) ? n.degraded.length : 1
      const kept = (Array.isArray(n.degraded) ? n.degraded : [])
        .filter((d): d is DegradeRecord =>
          !!d && typeof d === 'object'
          && (DEGRADABLE_PHASES as readonly string[]).includes((d as DegradeRecord).phase)
          && Array.isArray((d as DegradeRecord).advice))
        .map(d => ({
          phase: d.phase,
          round: Number.isFinite(d.round) ? Math.max(0, Math.trunc(d.round)) : 0,
          reason: typeof d.reason === 'string' ? capText(d.reason, MAX_SUMMARY_CHARS) : '',
          advice: capBlockingList(strArray(d.advice), '修改建议'),
          at: typeof d.at === 'string' ? d.at : '',
        }))
      if (kept.length > 0) n.degraded = kept
      else delete n.degraded
      if (before !== kept.length) repairs.push(`节点 ${n.id}:${before - kept.length} 条降级放行记录已损坏,已丢弃`)
    }
    /**
     * 依赖重算的账。**逐字段重建**,模板是同一个文件里的 `degraded` —— 四条属性一条不差:
     * 可选字段、整条丢坏的、内层数组走 `capBlockingList`、丢了记一条带条数的 repair、空了 delete。
     * (不抄 `roundArray`:那个非可选、恒返回数组、repairs 走一个跨两个 log 共享的计数器。)
     *
     * **守卫必须是 `Array.isArray`,不能是 `!== undefined`**:YAML 的 `depsRecalc:`(空值)
     * 是 `null`,而 `confirmedDraft` 正是栽在这一行上 —— 一个畸形子节点让 `validateLoadedNodes`
     * 整个抛出,而 efftask.tsx 把它当「恢复失败」,于是一个坏节点赔上了整个 run 的全部节点。
     *
     * 逐字段夹长度不是洁癖:这个文件下面那段注释记着实测 —— 盘上 5000 条 × 508 字恢复后
     * **一条没夹**原样回到内存,再落盘就是 9.5 MB 的 node.md,而 `commit()` 每次状态迁移
     * 都全量重写它。
     */
    if (n.depsRecalc !== undefined) {
      const raw = n.depsRecalc as unknown
      const arr = Array.isArray(raw) ? raw : []
      const kept = arr
        .filter((r): r is DepsRecalcRecord =>
          !!r && typeof r === 'object' && !Array.isArray(r)
          && Array.isArray((r as DepsRecalcRecord).from) && Array.isArray((r as DepsRecalcRecord).to))
        .map(r => ({
          at: typeof r.at === 'string' ? r.at : '',
          from: capBlockingList(strArray(r.from), '依赖'),
          to: capBlockingList(strArray(r.to), '依赖'),
          ...(typeof r.note === 'string' && r.note.length > 0
            ? { note: capText(r.note, MAX_SUMMARY_CHARS) } : {}),
        }))
      const badShapes = (Array.isArray(raw) ? arr.length : 1) - kept.length
      if (badShapes > 0) repairs.push(`节点 ${n.id}:${badShapes} 条依赖重算记录已损坏,已丢弃`)
      /**
       * 条数夹取:**保留最老 1 条 + 最新 N-1 条**。
       *
       * 最老那一条的 `from` 是这条链的起点 —— 丢了它,剩下的读起来像是从半空中开始的。
       * 「最老」按**位置**取(`[0]`,插入序),**不按 `at` 排序**:`at` 只做 typeof 校验、
       * 不解析,拿一个手改过的时间串去排会把锚点排到别处。
       *
       * **幂等**:`length <= N` 时原样返回,不重算任何东西(和 `capBlockingList` 同一条
       * 理由 —— 它幂等正是为了让写侧和恢复侧能共用一份实现)。
       */
      let clipped = kept
      let clippedCount = 0
      if (kept.length > MAX_DEPS_RECALC_RECORDS) {
        clippedCount = kept.length - MAX_DEPS_RECALC_RECORDS
        clipped = [kept[0], ...kept.slice(kept.length - (MAX_DEPS_RECALC_RECORDS - 1))]
      }
      if (clipped.length > 0) n.depsRecalc = clipped
      else delete n.depsRecalc
      /**
       * 丢弃计数**落进节点自己**,而且**累加**。
       *
       * 只写进 `repairs` 是不够的:那份清单进 run.md 时走 `slice(0, MAX_RECORDED_REPAIRS)`,
       * 一趟有 ≥5 条别的修复,这行字整条不落盘 —— 截断提示必须活在被截断的东西**之外**。
       * 而累加(不是覆盖)是因为第二次恢复又丢 3 条时必须是 7+3=10:覆盖写出来的是一个
       * 「描述本趟而非真实损失」的数字,`capBlockingList` 的注释为同一件事记过一笔。
       */
      const prevDropped = Number.isFinite(n.depsRecalcDropped)
        ? Math.max(0, Math.trunc(n.depsRecalcDropped as number)) : 0
      const dropped = prevDropped + clippedCount
      if (dropped > 0) {
        n.depsRecalcDropped = dropped
        if (clippedCount > 0) {
          repairs.push(`节点 ${n.id}:依赖重算记录超过 ${MAX_DEPS_RECALC_RECORDS} 条,已保留最早 1 条和最近 ${MAX_DEPS_RECALC_RECORDS - 1} 条(累计未逐条保留 ${dropped} 次)`)
        }
      } else delete n.depsRecalcDropped
    } else if (n.depsRecalcDropped !== undefined) {
      /**
       * **计数**在没有记录时仍然留着 —— 它是真信息:这个节点确实被手工重算过 N 次,
       * 只是那些记录已经在更早的恢复边界上被夹掉了(或整批坏掉被丢弃)。删掉它等于
       * 抹掉「有人动过这个节点的依赖」这件事本身,而那正是 run.md 上 ⟲ 存在的理由。
       *
       * 代价是「⟲ ×7 而一条记录都读不到」这个态是可达的,所以 **node.md 那一节必须
       * 自己说清楚**(见 persistence 的 depsRecalcBody:零记录时不许写「另有 N 次」,
       * 那句话暗示还有别的可读)。这里只把垃圾值归一化。
       */
      const d = Number.isFinite(n.depsRecalcDropped) ? Math.max(0, Math.trunc(n.depsRecalcDropped as number)) : 0
      if (d > 0) n.depsRecalcDropped = d
      else delete n.depsRecalcDropped
    }
    // The same `!== true → false` discipline capBlocked already had. A truthy non-boolean
    // `interrupted: "yes"` matches neither reseat's `=== true` nor --retry-blocked's
    // capBlocked, so the node could never be reopened by anything — measured: every resume
    // stopped at BLOCKED 已中断 forever.
    if (n.interrupted !== undefined && n.interrupted !== true) n.interrupted = false
    if (n.mergeConflict !== undefined && n.mergeConflict !== true) n.mergeConflict = false
    /**
     * 同一条 `!== true → false` 的规矩,而这一个的方向要说清楚:
     * `cancelled` 是**摁住**用的(重做时不连带放开被点名取消的节点),所以一个真值非布尔
     * (手改出来的 `cancelled: "yes"`)归到 false 是**放宽**——那个节点会跟着中断的那一批
     * 一起被放开,最坏是多跑一次用户本来不想跑的任务;反过来把任意真值当成 true,则是让
     * 一个手抖写下的字符串永久摁死一条依赖链,而屏幕上没有任何解释。
     */
    if (n.cancelled !== undefined && n.cancelled !== true) n.cancelled = false
    // Same `!== true → false` discipline, and for a sharper reason than the others: this flag
    // is what stops 补救拆分 happening twice. A truthy non-boolean (`revised: "yes"` from a
    // hand-edited node.md) is not `=== true`, so the node would buy a SECOND corrective
    // subtree — which is the one bound the whole cost argument rests on.
    if (n.revised !== undefined && n.revised !== true) n.revised = false
    /**
     * **`contributed`:同样的 `!== true → false` 纪律,外加一次给老 run 的回填。**
     *
     * 这个标记是「没有合并提交就不算完成」那道闸用来区分两种「这一次没合」的东西:
     * 从来没贡献过(拦下来)vs 此前贡献过、这一次只是没有新东西(放行)。
     *
     * 而它是本轮才引入的 —— **本轮之前跑完的 run,盘上一个节点都没有它**。恢复那种 run 再
     * `--retry-blocked`:节点重跑、没有新产出 → `isMerged` 为真 → `{merged:false}` →
     * 判 `contributed !== true` → **BLOCKED**,理由逐字是「该节点没有向集成分支贡献任何
     * 改动」,而它当初真的贡献过。一次纯粹由升级造成的误杀。
     *
     * 回填判据:**已验收、而且 execStatus 上没有那句「零贡献」的注记**。那句注记正是
     * `mergeAndRelease` 在 `merged === false` 时写下的,所以「没有它」= 当初合成功过。
     * 判据窄到不会把真的零贡献节点也回填进去 —— 那种节点带着注记,回填不到它头上。
     */
    if (n.contributed !== undefined && n.contributed !== true) n.contributed = false
    else if (n.contributed === undefined && n.status === 'ACCEPTED' && !n.execStatus.includes(NO_CONTRIBUTION_NOTE)) {
      n.contributed = true
    }
    // 各阶段耗时: a plain number map off disk, so every value needs the same treatment the
    // iteration counters get. NaN would render as "NaNs" and a negative would render a phase
    // that finished before it began; both are reachable by hand-editing node.md, and the
    // renderer divides by 1000 rather than guarding.
    if (n.phaseMs !== undefined) {
      const raw = (n.phaseMs ?? {}) as Record<string, unknown>
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) {
        // 键限定在**活动状态**:生产里 commit() 只给这几个记账,而一个手改的
        // `ACCEPTED: 5000` 会在详情页渲染成一行没有中文标签的原始枚举名。
        if (ACTIVE_STATUSES.has(k as never) && Number.isFinite(v) && (v as number) >= 0) clean[k] = Math.trunc(v as number)
      }
      n.phaseMs = clean as TaskNode['phaseMs']
    }
    /**
     * 各阶段的时间点。同一条规矩,只是值是**时间串**:
     *  - 键必须是合法状态(手写的 `EXECUTNG` 会在详情页渲成一行没人认识的东西);
     *  - `first` 必须是能解析的时间,否则渲染层的 `Date.parse` 会给出 `NaN`,
     *    而那一行会印成 `Invalid Date`;
     *  - `last` 允许缺席 —— 那是「进了还没出来」的**正常**形态(正在跑,或者进程被杀在
     *    这一步),不是坏数据。解析不了的 `last` 当缺席处理:少说一句永远比说错一句好。
     */
    if (n.phaseAt !== undefined) {
      const raw = (n.phaseAt ?? {}) as Record<string, unknown>
      const clean: Record<string, { first: string; last?: string }> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (!ACTIVE_STATUSES.has(k as never) || v === null || typeof v !== 'object') continue
        const at = v as { first?: unknown; last?: unknown }
        if (typeof at.first !== 'string' || !Number.isFinite(Date.parse(at.first))) continue
        const last = typeof at.last === 'string' && Number.isFinite(Date.parse(at.last)) ? at.last : undefined
        clean[k] = last === undefined ? { first: at.first } : { first: at.first, last }
      }
      n.phaseAt = clean as TaskNode['phaseAt']
    }
    // 结束时刻:解析不了就当没有。留着一个垃圾串会让详情页印出 `Invalid Date`,
    // 而这个字段同时是「这个节点有没有结论」的显示判据。
    if (n.finishedAt !== undefined && (typeof n.finishedAt !== 'string' || !Number.isFinite(Date.parse(n.finishedAt)))) {
      n.finishedAt = undefined
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
    // 同一条纪律。这个标志决定「补验收点那一次重拟还欠不欠」,一个真值非布尔
    // (`planRetried: "yes"`)会让恢复回来的节点**永远**补不了那一次;写坏成 false 则相反,
    // 每一次恢复都多烧一次方案调用。只有真的 true 算已经补过。
    if (n.planRetried !== undefined && n.planRetried !== true) n.planRetried = false
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
    if (n.skipPhase !== undefined && !hasWorkToSkip(n, n.skipPhase)) {
      repairs.push(
        `节点 ${n.id}:盘上写着要跳过${String(n.skipPhase)},但这个节点还没有可被跳过的产出` +
        `(执行自述/方案/子任务都是空的),已清除 —— 否则它会零调用地判为已验收`,
      )
      n.skipPhase = undefined
    }
    /**
     * 强制通过的那一个环节。两道校验和 `skipPhase` **逐字相同**,而且更要紧。
     *
     * 同因:落盘白拿(serializeNode 整节点倾倒),所以缺口只在读回这一侧,而这个字段决定
     * 一个节点会不会零调用地走完一个判决环节。
     *
     * 更要紧的地方在于**后果多一层**:一个手写的 `skipPhase` 只是让节点零调用判 ACCEPTED,
     * 留痕是 execStatus 上一句假话;而一个手写的 `forcePass` 在此之上还会往
     * reviewLog/acceptLog 里塞一条署名「人工强制通过」的 PASS —— 那是伪造一份**有人放行过**
     * 的记录,而那一节正是事后追责唯一的依据。
     */
    if (n.forcePass !== undefined && !SKIPPABLE_PHASES.has(n.forcePass as string)) {
      repairs.push(`节点 ${n.id}:要强制通过的环节 ${String(n.forcePass)} 不在可强制通过之列,已清除`)
      n.forcePass = undefined
    }
    if (n.forcePass !== undefined && !hasWorkToSkip(n, n.forcePass)) {
      repairs.push(
        `节点 ${n.id}:盘上写着要强制通过${String(n.forcePass)},但这个节点还没有可被放行的产出` +
        `(执行自述/方案/子任务都是空的),已清除 —— 否则它会零调用地判为已验收,并留下一条假的通过记录`,
      )
      n.forcePass = undefined
    }
    /**
     * **两个都写着不算坏数据,所以这里一个字都不改。**
     *
     * 正常路径产生不了这种组合(reseatForRerun 把两个字段一起无条件写,一个必为 undefined),
     * 所以它只可能来自手工编辑。而 `pipeline` 那四处已经把它处理干净了:强制通过的分支赢,
     * 两个标记**都**被消费掉,没有一个会留到下一轮。
     *
     * 不在这里判的理由是**别造第二份判据**:一条「已清除跳过标记」的修复消息要和
     * `isForcePassed` 的优先级永远同向,而那是两个文件里的两句话。让消费点自己兜住,
     * 这里就不存在漂移的余地。
     */
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
    maxNodes: clampInt(caps.maxNodes, 1, MAX_NODES_CEILING, DEFAULT_CAPS.maxNodes),
    maxIterations: clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations),
    // 上限 2 小时。原来是 1 小时,而这条阀量的已经是**静默时长**不是总时长了 ——
    // 「两个小时一条消息都没吐」在任何 provider 上都只可能是挂死,所以让它可配到 2 小时
    // 不会削弱它,只是把「我这台机器网络就是烂」这种情况留给用户自己定。
    nodeTimeoutMs: clampInt(caps.nodeTimeoutMs, 1000, 7_200_000, DEFAULT_CAPS.nodeTimeoutMs),
    // 上限 30 天:这条阀挡的是「永远没人回答」,不是「回答得慢」。
    humanTimeoutMs: clampInt(caps.humanTimeoutMs, 1000, 30 * 24 * 60 * 60 * 1000, DEFAULT_CAPS.humanTimeoutMs),
    /**
     * 自动解冲突的次数。**逐字段重建的这一份必须带上它**,否则一个配了「冲突试 12 次」的
     * run 一恢复就悄悄退回默认 —— 而恢复恰恰是这个旋钮最要紧的时刻(用户是被升级卡叫回来的)。
     *
     * 缺省(老 run.md 里没有这个字段)回落到默认 6,不是 0:0 的含义是「关掉自动解决」,
     * 把「没写」解释成「关掉」就是一次只在恢复路径上发生的静默功能退化。
     */
    mergeResolveAttempts: clampInt(
      caps.mergeResolveAttempts, MIN_MERGE_RESOLVE, MAX_MERGE_RESOLVE,
      DEFAULT_CAPS.mergeResolveAttempts ?? 6,
    ),
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
  /**
   * **「完成即回收构建产物」必须读得回来。**
   *
   * 它默认**开**,而它做的是一次自动的、不可逆的删除。逐字段重建的这一份漏掉它的后果是
   * 单向的、而且方向朝坏:一个明确把它**关掉**的用户,第一次 `--resume` 就悄悄被打开 ——
   * 而他关掉它多半正是因为不想让构建产物被删。反过来(开着的被关掉)只是少腾点空间。
   *
   * **只认真正的布尔**:run.md 是手工可编辑的,而字符串 `'false'` 是 truthy ——
   * 误开一次就是一次真的删除(`autoPush` 为同一件事定过这条规矩)。
   */
  if (typeof caps.wipeOnAccept === 'boolean') rebuilt.wipeOnAccept = caps.wipeOnAccept
  else if (caps.wipeOnAccept !== undefined) {
    degraded.push(
      `run.md 里的 caps.wipeOnAccept 不是布尔值(写的是 ${JSON.stringify(caps.wipeOnAccept)}),已忽略 —— ` +
      `这一趟按默认走:任务合并完成后会立即清掉它工作区里被 .gitignore 忽略的构建产物`,
    )
  }
  /**
   * 手动合并的解冲突轮数。同样必须读得回来 —— 一个配了「冲突别自动解、直接叫我」
   * (0)的用户,恢复之后会重新开始派模型改他的代码。
   */
  if (caps.trunkResolveRounds !== undefined) {
    rebuilt.trunkResolveRounds = clampInt(
      caps.trunkResolveRounds, MIN_TRUNK_RESOLVE, MAX_TRUNK_RESOLVE, DEFAULT_TRUNK_RESOLVE,
    )
  }
  /**
   * 严格度档位。照 `planConverge` 那一行的保守规矩:只认严格相等的四个字面量。
   *
   * **缺席一律回落 `undefined`(= 现状 = 全票 + 判据空白),绝不给具名默认档。** 老 run.md
   * 里没有这个字段,而默认成「高级」会让一个原本全票跑的旧 run 恢复之后变成 quorum 80 ——
   * 5 席下是 4/5,也就是**恢复之后变松了**,而屏幕上没有任何东西会说这件事。
   */
  if (isStrictness(caps.strictness)) rebuilt.strictness = caps.strictness
  else if (caps.strictness !== undefined) {
    // 照 scoreThreshold 那一支的规矩:回落要**说出来**。三条入口里 parseDirectives 会
    // notice、scoreThreshold 会 degraded,只有手改 run.md 这条不说 —— 而它正是恢复路径。
    degraded.push(
      `run.md 里的 caps.strictness 不是合法档位(写的是 ${JSON.stringify(caps.strictness)}),` +
      `已忽略:本次按不设档运行(圆桌全票、判据由各评审员自己把握)`,
    )
  }
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
        // 必须读回来:`writeRunManifest` 整份重写 run.md,而这个字段是「别自动合并」的
        // 唯一判据 —— 写得出去读不回来的话,`--resume` 之后那道门就消失了。
        ...(Number.isFinite(o.degradedNodes) && (o.degradedNodes as number) > 0
          ? { degradedNodes: Math.trunc(o.degradedNodes as number) } : {}),
        // 同上,同一条规矩:收口关口那句「你的工作区未被改动」按它改口。写得出去读不回来
        // 的话,`--resume` 进来的关口会对着一份已经在用户目录里的产出说没动过他的工作区。
        ...(Number.isFinite(o.trunkLanded) && (o.trunkLanded as number) > 0
          ? { trunkLanded: Math.trunc(o.trunkLanded as number) } : {}),
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
   * 两个 git 开关。**必须读回** —— 恢复关口拿读回来的 config 当初值渲染,读不回来的话,
   * 用户上一趟选的「共享工作树」会在恢复时静默变回「worktree 隔离」,而他多半是直接回车的。
   *
   * 手改 run.md 绕开一切校验,所以取值也要在这里过一遍白名单:一个写成 `isolation: yes`
   * 的值不能被当成 'shared'(那会让整趟运行的执行方式变掉,而屏幕上写的是另一件事)。
   */
  if (fm.isolation !== undefined) {
    if (fm.isolation === 'worktree' || fm.isolation === 'shared') base.isolation = fm.isolation
    else degraded.push(`run.md 里的 isolation「${String(fm.isolation)}」不是合法取值(worktree / shared),已忽略,按 worktree 走`)
  }
  /**
   * `finish`(收口方式)这个开关**已经不存在了** —— 只有主干开发。
   *
   * 旧 run.md 里还会有它,而恢复一个旧 run 不该因为一个已经取消的开关失败。选了
   * 「保留分支」的那些尤其要**说一句**:这一趟的行为和上一趟不一样了(现在每个子任务
   * 完成时就会合回当前分支),静默改掉是这个仓库反复在修的那类事。
   */
  if (fm.finish !== undefined) {
    degraded.push(fm.finish === 'keep'
      ? 'run.md 里的 finish: keep(分支开发)已不再支持:本次按主干开发走 —— 每个子任务完成时就合回你当前的分支'
      : 'run.md 里的 finish 已不再是一个开关(只有主干开发),已忽略')
  }
  if (fm.autoPush !== undefined) {
    // 只有**真正的 true** 才算开。字符串 'false' 是 truthy,而这个开关的方向是不对称的:
    // 误开一次就是一次不该发生的对外推送。
    if (typeof fm.autoPush === 'boolean') base.autoPush = fm.autoPush
    else degraded.push(`run.md 里的 autoPush「${String(fm.autoPush)}」不是 true/false,已忽略(按关处理)`)
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
