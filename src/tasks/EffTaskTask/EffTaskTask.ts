// Background-task entry for a `/et` run — spec §10:
//   "Orchestrator 注册为后台任务(src/tasks/ LocalAgent 风格:registerAsyncAgent 生命周期),
//    在 /tasks 可见,AppState.tasks 里有条目。"
//
// The orchestrator itself is untouched by this file. What it buys is that a run stops being
// invisible to the rest of the app: it shows in the footer pill and in the Shift+Down /
// `/tasks` dialog with live counts, it emits the same task_started / task lifecycle events
// every other task does, and `x` there — or TaskStop, or the session's cleanup handler —
// aborts it through the SAME AbortController the run's own Esc uses.
//
// HONEST SCOPE: `/et` renders a modal local-jsx view, and unmounting that view aborts the
// run (an orphaned orchestrator would keep burning tokens into a tree nobody is watching).
// So this entry does NOT make a run detachable — it makes a RUNNING run visible and
// stoppable from the places every other background task is. Anything more would require
// lifting the orchestrator out of the command's React tree, which is not what §10 asks for.
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type EffTaskCounts = {
  accepted: number
  blocked: number
  pending: number
  total: number
}

export type EffTaskTaskState = TaskStateBase & {
  type: 'efftask'
  /** The run id — `.claude/efftask/<runId>/`. Also this task's id, so the two never diverge. */
  runId: string
  /** Where run.md lives. The one durable artifact a user can still read after the view is gone. */
  runDir: string
  counts: EffTaskCounts
  /** Why the run ended, when it ended badly. Empty while running. */
  reason?: string
  /**
   * The run's OWN controller, not a fresh one.
   *
   * `kill` must stop the actual orchestrator; a private controller here would flip the task
   * to 'killed' in the UI while the run kept issuing write-capable model calls — the panel
   * telling the user something untrue about the thing it is showing them.
   */
  abortController?: AbortController
}

export function isEffTaskTask(task: unknown): task is EffTaskTaskState {
  return (
    typeof task === 'object' && task !== null && 'type' in task && task.type === 'efftask'
  )
}

/** One line for the list and the pill: what this run is doing right now. */
export function effTaskDescription(runId: string, counts: EffTaskCounts): string {
  const parts = [`已完成 ${counts.accepted}/${counts.total}`]
  if (counts.blocked > 0) parts.push(`阻断 ${counts.blocked}`)
  return `高效任务 ${runId} · ${parts.join(' · ')}`
}

export function registerEffTaskRun(
  setAppState: SetAppState,
  opts: { runId: string; runDir: string; counts: EffTaskCounts; abortController: AbortController },
): string {
  // Task id = run id. A `/et` run already HAS a stable identity that outlives the process and
  // that the user sees everywhere else (`/et --resume 003`, `.claude/efftask/003/`); minting
  // a second random one would make the panel and the transcript name the same run differently.
  const id = `efftask-${opts.runId}`
  const task: EffTaskTaskState = {
    ...createTaskStateBase(id, 'efftask', effTaskDescription(opts.runId, opts.counts)),
    type: 'efftask',
    status: 'running',
    runId: opts.runId,
    runDir: opts.runDir,
    counts: opts.counts,
    abortController: opts.abortController,
  }
  registerTask(task, setAppState)
  return id
}

export function updateEffTaskRun(
  taskId: string,
  setAppState: SetAppState,
  counts: EffTaskCounts,
): void {
  updateTaskState<EffTaskTaskState>(taskId, setAppState, task => {
    // Identity return when nothing moved — updateTaskState skips the spread, so subscribers
    // do not re-render. onUpdate fires on EVERY node transition, so this matters.
    if (
      task.counts.accepted === counts.accepted &&
      task.counts.blocked === counts.blocked &&
      task.counts.total === counts.total
    ) {
      return task
    }
    return { ...task, counts, description: effTaskDescription(task.runId, counts) }
  })
}

/**
 * The run ended on its own. `blocked` is a FAILED task, not a completed one: the run stopped
 * without finishing the work, and reporting it as completed is the one thing this panel must
 * not do.
 */
export function finishEffTaskRun(
  taskId: string,
  setAppState: SetAppState,
  outcome: { status: 'completed' | 'blocked'; reason?: string },
): void {
  updateTaskState<EffTaskTaskState>(taskId, setAppState, task => {
    // A killed run must stay killed: `kill` already aborted it, and the abort then surfaces
    // as {status:'blocked', reason:'已中断'} here. Overwriting would relabel the user's own
    // stop as a failure.
    if (task.status !== 'running') return task
    // The user's own stop is not a failure. `x` in /tasks goes through kill() and lands here
    // already 'killed', which the guard above protects — but Esc in the /et view aborts the
    // controller directly, so the run reports {blocked, '已中断'} with the task still
    // 'running' and it was written up as 失败. Two ways to stop the same run, two different
    // words for it, one of them wrong.
    const cancelled = outcome.status === 'blocked' && outcome.reason === '已中断'
    return {
      ...task,
      status: outcome.status === 'completed' ? 'completed' : cancelled ? 'killed' : 'failed',
      reason: outcome.reason,
      endTime: Date.now(),
      // The run's own transcript line IS the user-facing notification (see efftask.tsx's
      // onExit), so there is no model-facing message to wait for. Eviction requires
      // terminal + notified.
      notified: true,
      abortController: undefined,
    }
  })
}

export const EffTaskTask: Task = {
  name: 'EffTaskTask',
  type: 'efftask',

  async kill(taskId, setAppState) {
    updateTaskState<EffTaskTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      // The run's own controller: the orchestrator observes this signal at every step and
      // ends with {status:'blocked', reason:'已中断'}, persisting the tree on the way out.
      task.abortController?.abort()
      return {
        ...task,
        status: 'killed',
        reason: '已中断',
        endTime: Date.now(),
        notified: true,
        abortController: undefined,
      }
    })
  },
}
