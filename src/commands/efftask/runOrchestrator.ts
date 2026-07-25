import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { logError } from '../../utils/log.js'

export type Outcome = { status: 'completed' | 'blocked'; reason?: string }

/**
 * Drive one run to completion and report it.
 *
 * Lives outside efftask.tsx (which is JSX + React) because it is neither: it is the seam
 * between the orchestrator and the two things the UI owes the user afterwards — the outcome
 * and the final run.md. Both were once lost to a single unbound identifier here, so this
 * module is deliberately importable and directly testable without mounting anything.
 */
export async function runOrchestrator(
  args: { config: EffTaskConfig; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: 'parsing' | 'confirm' | 'running' | 'done') => void,
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
        onUpdate: nodes => {
          setNodes([...nodes])
          void queueManifest(nodes)
        },
      },
      args.signal,
    )
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    void queueManifest(orch.nodes()) // run.md exists from the first frame, not just at the end
    const result = await orch.run() // { status, reason }
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
