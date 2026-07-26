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

export function synthesizeVerdicts(verdicts: Verdict[]): { pass: boolean; blockingSummary: string } {
  const failing = verdicts.filter(v => !v.pass || v.blocking.length > 0)
  const pass = verdicts.length > 0 && failing.length === 0
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
  phase: 'review' | 'accept'
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
    const roleName = role ? role.roleName : 'main'
    if (res.status === 'fulfilled') return parseVerdict(res.value, roleName, args.answerTag)
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason)
    // infra: the reviewer never judged anything, the CALL failed. Flagged so the caller
    // retries the review instead of reading it as a rejection and redoing real work.
    // A DEADLINE is still infra (nobody judged anything), but it is a different fact from
    // an unreachable provider and needs different advice on the escalation card.
    const timedOut = res.reason instanceof PhaseTimeoutError
    return { role: roleName, pass: false, blocking: ['角色调用失败: ' + reason], comments: '', infra: true, ...(timedOut ? { timeout: true } : {}) }
  })
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
}
