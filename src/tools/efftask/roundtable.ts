// src/tools/efftask/roundtable.ts
import type { PhaseName, RoleBinding, RoundtableRecord, TaskNode, Verdict } from './types.js'
import { parseVerdict } from './parseOutput.js'

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
  return { pass, blockingSummary }
}

export async function runRoundtable(args: {
  phase: 'review' | 'accept'
  node: TaskNode
  roles: RoleBinding[]
  round: number
  system: string
  prompt: string
  runAgent: RunAgentFn
  signal: AbortSignal
  // Per-call answer tag the prompt demanded; verdicts are only trusted under THIS tag.
  answerTag?: string
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
  const settled = await Promise.allSettled(
    roster.map(role =>
      args.runAgent({ phase: args.phase, node: args.node, role, system: args.system, prompt: args.prompt, signal: args.signal }),
    ),
  )
  const verdicts: Verdict[] = settled.map((res, i) => {
    const role = roster[i]
    const roleName = role ? role.roleName : 'main'
    if (res.status === 'fulfilled') return parseVerdict(res.value, roleName, args.answerTag)
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason)
    // infra: the reviewer never judged anything, the CALL failed. Flagged so the caller
    // retries the review instead of reading it as a rejection and redoing real work.
    return { role: roleName, pass: false, blocking: ['角色调用失败: ' + reason], comments: '', infra: true }
  })
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
}
