// src/tools/efftask/roundtable.ts
import type { PhaseName, RoleBinding, RoundtableRecord, TaskNode, Verdict } from './types.js'
import { PhaseTimeoutError } from './runAgentAdapter.js'
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
  onChunk?: (t: string) => void
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
  // 'verify' 有自己的工具档位(见 runAgentAdapter):它要能跑命令,而评审/验收只读。
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
  /** 子 agent 实时输出 (spec §10.2). Every reviewer in the roundtable streams into it. */
  onChunk?: (t: string) => void
  /**
   * 全局并发池 (spec §6). Reviewers beyond the first take a slot from it.
   *
   * Absent = unbounded fan-out, which is what shipped: parallelism 2 with a 3-role panel
   * measured a peak of 6 concurrent runAgent calls, and the default 5 with 3 roles is 15.
   */
  slots?: SlotPool
}): Promise<RoundtableRecord> {
  // Already aborted → don't burn a real model call; synthesize a failing record instead.
  if (args.signal.aborted) {
    const verdicts: Verdict[] = [{ role: 'main', pass: false, blocking: ['已中断'], comments: '' }]
    // 不传 quorum:中断是无条件的失败,不该因为法定人数放宽就变成通过。
    return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
  }
  // Empty roster => a single main-model reviewer (role=null). Independent & parallel.
  const roster: (RoleBinding | null)[] = args.roles.length > 0 ? args.roles : [null]
  // Promise.allSettled so a single reviewer's runAgent REJECTION does not throw out
  // of the whole roundtable. Fulfilled path is identical (parseVerdict); a rejected
  // reviewer is synthesized into a failing verdict instead.
  const settled = await mapWithinPool(
    roster,
    role =>
      // cwd goes to EVERY reviewer: the work under review lives in the node's worktree, and a
      // reviewer reading the main tree can only rubber-stamp the executor's own prose.
      args.runAgent({ phase: args.phase, node: args.node, role, system: args.system, prompt: args.prompt(role), signal: args.signal, cwd: args.cwd, onChunk: args.onChunk }),
    args.slots,
  )
  const verdicts: Verdict[] = settled.map((res, i) => {
    const role = roster[i]
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
    return { role: roleName || 'main', ...tag, pass: false, blocking: ['角色调用失败: ' + reason], comments: '', infra: true, ...(timedOut ? { timeout: true } : {}) }
  })
  // 阻断项**照样全部汇总**,即使已经达到法定人数 —— 少数派的意见不因为没挡住就消失。
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts, args.quorum, args.quorumSeats) }
}
