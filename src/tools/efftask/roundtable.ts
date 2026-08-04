// src/tools/efftask/roundtable.ts
import type { PhaseName, RoleBinding, RoundtableRecord, TaskNode, Verdict } from './types.js'
import type { StreamHandle, StreamMeta } from './agentStream.js'
import { PhaseTimeoutError, ProviderApiError } from './runAgentAdapter.js'
import { mapWithinPool, type SlotPool } from './slotPool.js'
import { capText, MAX_SUMMARY_CHARS, parseVerdict } from './parseOutput.js'

export type RunAgentFn = (req: {
  phase: PhaseName
  node: TaskNode
  role: RoleBinding | null
  system: string
  prompt: string
  cwd?: string
  signal: AbortSignal
  /**
   * 这次调用的实时窗口 (spec 2026-07-27)。
   *
   * 由**调用点**开出来(它才知道这是哪个环节、第几轮、哪位员工),由 `makeRunAgentFn` 的
   * finally 收口(那是唯一一个所有调用必经的点)。一次调用一个句柄,所以不存在 key 碰撞
   * —— 此前按 `nodeId#phase#round#seat` 拼 key 的设计有四处真实碰撞:infra 重试三桌共用
   * 同一个 round、执行返工的轮次 runPhase 看不见、冲突自动解决与主执行同键、集成验收与
   * 叶子验收同键。
   */
  stream?: StreamHandle
}) => Promise<string>

export function synthesizeVerdicts(
  verdicts: Verdict[],
  /**
   * 通过所需的赞成比例(1-100)。省略 = 100 = 全票,行为与加这个参数之前逐字节相同。
   *
   * 分母**不含 infra 失败**:调用没打通不是一票反对。把它算进分母会让「3 席里 1 席
   * 网络挂了」直接吃掉 33% 的赞成率,而那一席根本没有对工作做出任何判断 —— 那种情形
   * 该走 isInfraOnlyFailure 的重试,不该被算成反对票。
   */
  quorum?: number,
  /** 通过所需的赞成**席位数**。与 quorum 并用时取更严的那个。 */
  quorumSeats?: number,
): { pass: boolean; blockingSummary: string } {
  const failing = verdicts.filter(v => !v.pass || v.blocking.length > 0)
  // 判决过的席位(排除 infra)。全都是 infra → 分母为 0 → 不通过,交给重试逻辑。
  const judged = verdicts.filter(v => !v.infra)
  const approving = judged.filter(v => v.pass && v.blocking.length === 0).length
  // NaN 要退回全票,不能让它穿过去:Math.round(NaN) 是 NaN,而下面两个分支对 NaN
  // 都为假 —— 结果是**全票赞成的面板也不通过**,一个永远过不去的圆桌。
  const rawNeed = Math.round(quorum ?? 100)
  const need = Number.isFinite(rawNeed) ? Math.min(100, Math.max(1, rawNeed)) : 100
  // judged.length > 0 是**显式**的,而不是靠 0/0 = NaN 在下面的比较里恰好为假 —— 全是
  // infra 时必须不通过,好让 isInfraOnlyFailure 去重试。
  // 整数比较,不走浮点:2/3 在 (2*100)/3 >= 67 下是 66.666… < 67,而用户说「三分之二」
  // 想的就是这个场景。乘法形式让「刚好达到」在数学上可判定。
  // 只写了 quorumSeats(「至少 2 人通过」)时,比例这一维**不设限** —— 那句话的意思是
  // 把门槛换成 2 席,不是「2 席**并且**全票」。两个都写才两个都要满足(取更严的)。
  const seatsOnly = quorum === undefined && quorumSeats !== undefined
  const byRatio = seatsOnly ? true
    : need >= 100
      // 全票走原来那条路径,与引入本旋钮之前逐字节相同(包括「有 infra 就不通过 → 重试」)。
      ? failing.length === 0
      : approving * 100 >= need * judged.length
  const rawSeats = Math.round(quorumSeats ?? 0)
  const bySeats = quorumSeats === undefined || !Number.isFinite(rawSeats)
    || approving >= Math.max(1, rawSeats)
  const pass = verdicts.length > 0 && judged.length > 0 && byRatio && bySeats
  const blockingSummary = failing
    .flatMap(v =>
      // A verdict can fail (pass:false) with an EMPTY blocking list. Falling back to its
      // comments keeps blockingSummary non-empty — otherwise the revision loop re-prompts
      // with identical text and deterministically burns every iteration for nothing.
      v.blocking.length > 0
        ? v.blocking.map(b => `[${v.role}] ${b}`)
        : v.comments.trim()
          ? [`[${v.role}] ${v.comments.trim()}`]
          : [`[${v.role}] 未通过但未给出具体阻断项`],
    )
    .join('; ')
  // CAPPED. This is the single biggest contributor to node.md: it concatenates every
  // reviewer's every blocking entry, so 5 roles x 21 entries x 2000 chars is ~200 KB per
  // round — and it is copied again into blockedReason. Measured 2.5 MB per node before this.
  return { pass, blockingSummary: capText(blockingSummary, MAX_SUMMARY_CHARS) }
}

export async function runRoundtable(args: {
  /**
   * 这三关都从**同一个**工具池取工具 —— 按环节分档早就取消了(见 `makeRunAgentFn` 里
   * `const tools: Tools = deps.availableTools` 那一段的注释)。这里原来写的是
   * 「'verify' 有自己的工具档位…评审/验收只读」,那句话现在是反的:评审席位一样拿得到 Bash。
   *
   * 这件事**是被依赖的**,不只是历史遗留:四个裁决提示词都要求「写进 blocking 的事实断言
   * 必须附上你实际跑过的命令(或 文件:行号)与关键输出」(见 pipeline.ts 的 `EVIDENCE_RULE`),
   * 而那条要求只有在评审席位真的能跑命令时才不是一句空话。
   *
   * 「或 文件:行号」那个并列出口不能省:`runAgent` 那侧没传 `useExactTools`,最终工具还要过
   * `resolveAgentTools` —— 一个把 `tools:` 限成只读的自定义员工仍然拿不到 Bash。
   */
  phase: 'review' | 'accept' | 'verify'
  node: TaskNode
  roles: RoleBinding[]
  round: number
  system: string
  /**
   * The prompt for ONE seat — a function, not a string.
   *
   * It used to be a single string sent verbatim to every seat, and that is exactly what made a
   * task ROLE (「架构师」, carrying its own 产出什么 / 起什么作用) impossible to express: the
   * roster could name three different reviewers and all three received byte-identical
   * instructions, so the only thing distinguishing them was which model answered. A role
   * definition would have been parsed, validated, rendered at the gate — and then reached no
   * model call at all. That is the dead-config shape this codebase keeps paying for, and here
   * it would have sat in the middle of the feature.
   *
   * Taking the seat lets the caller append that seat's own brief. Callers with nothing
   * seat-specific to say ignore the argument.
   */
  prompt: (seat: RoleBinding | null) => string
  runAgent: RunAgentFn
  signal: AbortSignal
  // Per-call answer tag the prompt demanded; verdicts are only trusted under THIS tag.
  answerTag?: string
  /** 通过所需赞成比例(caps.quorum);省略 = 全票。 */
  quorum?: number
  /**
   * Working directory for every reviewer in this roundtable.
   *
   * Without it the accept roundtable reads the MAIN working tree while the work it is judging
   * lives only in the node's worktree — reviewers can then do nothing but rubber-stamp the
   * executor's own prose. A reviewer that cannot see the change is not a reviewer.
   */
  cwd?: string
  /**
   * 每个席位开一个自己的窗口 (spec 2026-07-27 §5/§6)。
   *
   * 此前是**一个** onChunk 被全部席位共用,于是 N 个评审员的话逐句交错地并进同一个桶,
   * 而且没有任何署名 —— 读不出哪句是谁说的。这正是取代 chunkBuffer 的全部理由。
   */
  openStream?: (meta: StreamMeta) => StreamHandle
  /** 窗口表头上的环节名。省略时用 phase。集成验收走的是 phase:'accept',必须由调用点纠正。 */
  phaseLabel?: string
  /**
   * 全局并发池 (spec §6). Reviewers beyond the first take a slot from it.
   *
   * Absent = unbounded fan-out, which is what shipped: parallelism 2 with a 3-role panel
   * measured a peak of 6 concurrent runAgent calls, and the default 5 with 3 roles is 15.
   */
  slots?: SlotPool
  /**
   * 只派**这几个**席位(roster 下标)。省略 = 全席位,与这个参数不存在时逐字相同。
   *
   * 为什么需要它:infra 重试原来重开的是**整桌**,包括已经出过裁决的席位。3 席里 1 席
   * 打不通时,第二桌付 3 次调用而只有 1 次是必要的;`maxIterations=3` + 席位上限 5 下,
   * 一个圆桌最坏 15 次调用换 ≤5 次有效裁决 —— 而这一切发生在上游正在限流的时候。
   *
   * 收**下标**而不是「一份子集 roster」:第 143 行是
   * `args.roles.length > 0 ? args.roles : [null]`,传一个**空**子集会静默变成
   * 「主模型单席评审」,而它的裁决会被合并回下标 0。下标形式让这道门根本不存在。
   *
   * 返回的 `verdicts` 只含这几席,顺序与 `only` 一致 —— 合并由调用方按同一份下标做
   * (见 pipeline 的 roundtableWithInfraRetry)。
   */
  only?: number[]
}): Promise<RoundtableRecord> {
  // Already aborted → don't burn a real model call; synthesize a failing record instead.
  if (args.signal.aborted) {
    const verdicts: Verdict[] = [{ role: 'main', pass: false, blocking: ['已中断'], comments: '' }]
    // 不传 quorum:中断是无条件的失败,不该因为法定人数放宽就变成通过。
    return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
  }
  // Empty roster => a single main-model reviewer (role=null). Independent & parallel.
  const roster: (RoleBinding | null)[] = args.roles.length > 0 ? args.roles : [null]
  /**
   * 这一桌真的要派哪几席。
   *
   * `only` 里越界或重复的下标一律丢掉:它是调用方按上一桌的 verdicts 算出来的,而
   * 席位数在两桌之间理论上可变(重做会重排名册)。全被丢掉时退回全席位 —— 派 0 席会让
   * `verdicts` 为空,而 `synthesizeVerdicts` 对空数组判不通过,于是一个「其实没人反对」
   * 的圆桌会以「未能取得任何裁决」阻断。
   */
  const picked = (() => {
    if (!args.only) return roster.map((_, i) => i)
    const seen = new Set<number>()
    const out = args.only.filter(i => Number.isInteger(i) && i >= 0 && i < roster.length && !seen.has(i) && seen.add(i))
    return out.length > 0 ? out : roster.map((_, i) => i)
  })()
  // Promise.allSettled so a single reviewer's runAgent REJECTION does not throw out
  // of the whole roundtable. Fulfilled path is identical (parseVerdict); a rejected
  // reviewer is synthesized into a failing verdict instead.
  const settled = await mapWithinPool(
    picked.map(i => roster[i]!),
    role =>
      // cwd goes to EVERY reviewer: the work under review lives in the node's worktree, and a
      // reviewer reading the main tree can only rubber-stamp the executor's own prose.
      args.runAgent({
        phase: args.phase, node: args.node, role, system: args.system,
        prompt: args.prompt(role), signal: args.signal, cwd: args.cwd,
        stream: args.openStream?.({
          nodeId: args.node.id,
          phaseLabel: args.phaseLabel ?? args.phase,
          round: args.round,
          // 署名的取值顺序与 verdict 那边逐字一致(见下面 :roleName 的注释):`||` 不是 `??`
          // —— MAIN_STAFF(「主模型兼任」的员工名)是**空串**,而空串是一个 truthy 对象上的
          // falsy 字段。用 `??` 会渲染出 `▾ 质疑讨论 ·  (opus)`,而「没有署名」正是要治的病。
          label: (role?.roleName || role?.roleTag) || '主模型',
          model: role?.model,
        }),
      }),
    args.slots,
  )
  const verdicts: Verdict[] = settled.map((res, k) => {
    // `picked[k]`,不是 `k` —— 部分重派时署名/roleTag 必须跟着**原来那一席**走。
    const role = roster[picked[k]!]
    // 署名的取值顺序:员工名 → 角色名 → 'main'。
    //
    // `role ? role.roleName : 'main'` 曾经在「主模型兼任」的席位上产出**空串** —— 那个
    // 席位是一个 truthy 对象,而它的 roleName 是 MAIN_STAFF(空串)。于是 blockingSummary
    // 变成 `[] 缺回滚方案`,而 blockingSummary 会被原样送进返工提示词交给执行者,模型
    // 收到的字面就是那对空方括号。
    const roleName = (role?.roleName || role?.roleTag) ?? 'main'
    // roleTag 必须落到裁决上,不能只留在内存里的 roster[i]:node.md 存的是 verdicts[],
    // 一次 --resume 之后「这几条裁决属于同一个角色的几个员工」就无从恢复,而按角色分组
    // 正是「一个角色多员工要收敛成一个结论」的前提。
    const tag = role?.roleTag ? { roleTag: role.roleTag } : {}
    if (res.status === 'fulfilled') return { ...parseVerdict(res.value, roleName || 'main', args.answerTag), ...tag }
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason)
    // infra: the reviewer never judged anything, the CALL failed. Flagged so the caller
    // retries the review instead of reading it as a rejection and redoing real work.
    // A DEADLINE is still infra (nobody judged anything), but it is a different fact from
    // an unreachable provider and needs different advice on the escalation card.
    const timedOut = res.reason instanceof PhaseTimeoutError
    /**
     * **限流也要跟着走**,和 `timeoutKind` 逐字同因。
     *
     * 丢掉它的后果实测过:圆桌耗尽时 `exhaustionRemedyFor` 拿不到任何能分辨限流的信息,
     * 于是 3 席评审里有一席持续 429 的节点被阻断时,建议是「先确认角色模型/网络可用
     * (角色配置在 .claude/settings.json 的 roles 里)」—— 而上游是**通的**,照那句去查
     * 什么都查不出来。而多角色圆桌正是用户报 429 的那个场景。
     */
    const rateLimited = res.reason instanceof ProviderApiError && res.reason.kind === 'rate_limit'
    // kind 必须跟着走。丢掉它 = 圆桌里所有超时都被当成静默超时,而「没人来点确认」
    // 这一种拿到的建议是「提高 nodeTimeoutMs 或把节点拆小」—— 和病因完全无关。
    return {
      role: roleName || 'main', ...tag, pass: false,
      blocking: ['角色调用失败: ' + reason], comments: '', infra: true,
      ...(timedOut ? { timeout: true, timeoutKind: res.reason.kind } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
    }
  })
  // 阻断项**照样全部汇总**,即使已经达到法定人数 —— 少数派的意见不因为没挡住就消失。
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts, args.quorum, args.quorumSeats) }
}
