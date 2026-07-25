import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { logError } from '../../utils/log.js'
import type { WorktreePool } from '../../tools/efftask/worktreePool.js'
import type { HandoffSummary } from '../../tools/efftask/startupConfirm.js'

export type Outcome = { status: 'completed' | 'blocked'; reason?: string }

/**
 * The runner view's phases. Declared HERE rather than in efftask.tsx because runOrchestrator
 * takes a setPhase callback and efftask.tsx imports this module — one definition, no cycle.
 * A second copy silently drifts the moment a phase is added.
 */
export type Phase =
  | 'parsing' | 'picking' | 'recovering'
  | 'confirm' | 'confirmResume' | 'running' | 'done' | 'fatal'

/**
 * Drive one run to completion and report it.
 *
 * Lives outside efftask.tsx (which is JSX + React) because it is neither: it is the seam
 * between the orchestrator and the two things the UI owes the user afterwards — the outcome
 * and the final run.md. Both were once lost to a single unbound identifier here, so this
 * module is deliberately importable and directly testable without mounting anything.
 */
export async function runOrchestrator(
  args: { config: EffTaskConfig; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal; seed?: TaskNode[]; worktrees?: WorktreePool },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: Phase) => void,
  onHandoff?: (h: HandoffSummary) => void,
): Promise<void> {
  // Serialize run.md writes. onUpdate fires on EVERY state transition; firing writeFile
  // unawaited each time lets concurrent writes to the same path interleave into a corrupt
  // manifest. One promise queue ⇒ strictly ordered, last-write-wins.
  let manifestQueue: Promise<void> = Promise.resolve()
  const queueManifest = (nodes: TaskNode[], result?: Outcome): Promise<void> => {
    manifestQueue = manifestQueue
      .then(() => writeRunManifest(args.fs, args.runDir, args.config, nodes, result))
      .catch(logError)
    return manifestQueue
  }
  try {
    const persist = (n: TaskNode) => writeNode(args.fs, args.runDir, n)
    const now = () => new Date().toISOString()
    const orch = new EffTaskOrchestrator(
      args.config,
      {
        runAgent: args.runAgent,
        persist,
        now,
        worktrees: args.worktrees,
        onUpdate: nodes => {
          setNodes([...nodes])
          void queueManifest(nodes)
        },
      },
      args.signal,
      args.seed, // resume: adopt the recovered tree instead of minting a fresh root
    )
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    void queueManifest(orch.nodes()) // run.md exists from the first frame, not just at the end
    const result = await orch.run() // { status, reason }
    // 收口: ask the pool where everything landed, while its worktrees still exist.
    if (args.worktrees) {
      try {
        // dispose FIRST: it reclaims what is provably safe, so handoff then reports only the
        // worktrees that genuinely still hold something. Reporting before reclaiming would
        // list directories that are about to disappear.
        await args.worktrees.dispose(orch.nodes())
        const h = await args.worktrees.handoff(orch.nodes())
        onHandoff?.(h)
      } catch (e) {
        logError(e instanceof Error ? e : new Error(String(e)))
      }
    }
    setNodes([...orch.nodes()])
    setOutcome(result)
    await queueManifest(orch.nodes(), result) // final manifest records {status, reason}
  } catch (e) {
    // run() is not supposed to reject (the orchestrator catches per-step), but if it ever
    // does, the UI must NOT wedge on 'running' with no way out.
    setOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
  } finally {
    setPhase('done') // the done view is ALWAYS reached
  }
}
