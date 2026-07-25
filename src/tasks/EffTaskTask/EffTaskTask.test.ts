import { describe, expect, it } from 'bun:test'
import {
  EffTaskTask, effTaskDescription, finishEffTaskRun, isEffTaskTask,
  registerEffTaskRun, updateEffTaskRun, type EffTaskTaskState,
} from './EffTaskTask.js'
import { isBackgroundTask } from '../types.js'
import { getTaskByType } from '../../tasks.js'
import type { AppState } from '../../state/AppState.js'

/** Minimal AppState double: registerTask/updateTaskState only touch `tasks`. */
function store() {
  let state = { tasks: {} } as unknown as AppState
  return {
    setAppState: (f: (prev: AppState) => AppState) => { state = f(state) },
    task: (id: string) => (state.tasks as Record<string, EffTaskTaskState>)[id],
    all: () => state.tasks as Record<string, EffTaskTaskState>,
  }
}
const counts = (over: Partial<EffTaskTaskState['counts']> = {}) => ({ accepted: 0, blocked: 0, pending: 3, total: 3, ...over })

describe('高效任务的后台任务条目 (spec §10)', () => {
  it('lands in AppState.tasks and counts as a background task', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, {
      runId: '003', runDir: '/repo/.claude/efftask/003', counts: counts(), abortController: new AbortController(),
    })
    const t = s.task(id)
    expect(t).toBeDefined()
    expect(t.type).toBe('efftask')
    expect(t.status).toBe('running')
    // isBackgroundTask gates the footer pill and the /tasks list — but it only looks at
    // `status`, so asserting it on a freshly-registered task restates the line above. What it
    // DOES pin is the terminal direction: a finished run must drop off both surfaces.
    expect(isBackgroundTask(t)).toBe(true)
    finishEffTaskRun(id, s.setAppState, { status: 'completed' })
    expect(isBackgroundTask(s.task(id))).toBe(false)
    expect(isEffTaskTask(t)).toBe(true)
  })

  it('names the task after the RUN, so the panel and /et --resume agree', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, {
      runId: '007', runDir: '/d', counts: counts(), abortController: new AbortController(),
    })
    expect(id).toContain('007')
    expect(s.task(id).runId).toBe('007')
    expect(s.task(id).runDir).toBe('/d')
  })

  it('the description says what the run is DOING, not just that it exists', () => {
    expect(effTaskDescription('003', counts({ accepted: 2, pending: 1 }))).toBe('高效任务 003 · 已完成 2/3')
    // A blocked node is the reason a user opens this panel — it must be on the one line
    // they can see without opening anything.
    expect(effTaskDescription('003', counts({ accepted: 1, blocked: 1, pending: 1 }))).toContain('阻断 1')
  })

  it('tracks live counts as the tree advances', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: new AbortController() })
    updateEffTaskRun(id, s.setAppState, counts({ accepted: 2, pending: 1 }))
    expect(s.task(id).counts.accepted).toBe(2)
    expect(s.task(id).description).toContain('已完成 2/3')
  })

  it('does not churn the panel when nothing moved', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: new AbortController() })
    const before = s.task(id)
    updateEffTaskRun(id, s.setAppState, counts())
    // Same reference ⇒ updateTaskState skipped the spread ⇒ no subscriber re-render. onUpdate
    // fires on EVERY node transition, so an unconditional copy would repaint constantly.
    expect(s.task(id)).toBe(before)
  })

  it('completes on a completed run', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: new AbortController() })
    finishEffTaskRun(id, s.setAppState, { status: 'completed' })
    expect(s.task(id).status).toBe('completed')
    expect(s.task(id).endTime).toBeGreaterThan(0)
    expect(isBackgroundTask(s.task(id))).toBe(false) // terminal ⇒ off the pill
  })

  it('a BLOCKED run fails — it must never read as completed', () => {
    const s = store()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: new AbortController() })
    finishEffTaskRun(id, s.setAppState, { status: 'blocked', reason: '验收迭代超限(3)' })
    expect(s.task(id).status).toBe('failed')
    // The reason is what tells the user whether to resume or to fix; dropping it leaves a
    // red row with no explanation anywhere in this surface.
    expect(s.task(id).reason).toBe('验收迭代超限(3)')
  })

  it('kill aborts the RUN, not a private controller', async () => {
    const s = store()
    const ac = new AbortController()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: ac })
    await EffTaskTask.kill(id, s.setAppState)
    // THE property: the orchestrator actually stops. A task marked 'killed' whose run keeps
    // making write-capable calls is the panel lying about the thing it is showing.
    expect(ac.signal.aborted).toBe(true)
    expect(s.task(id).status).toBe('killed')
    expect(s.task(id).reason).toBe('已中断')
  })

  it('the abort that follows a kill does not relabel it as a failure', () => {
    const s = store()
    const ac = new AbortController()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: ac })
    void EffTaskTask.kill(id, s.setAppState)
    // The run observes the abort and reports blocked/已中断 a moment later. That is the
    // user's own stop arriving back — not a new fact about the work.
    finishEffTaskRun(id, s.setAppState, { status: 'blocked', reason: '已中断' })
    expect(s.task(id).status).toBe('killed')
  })

  it('kill on an already-finished run is a no-op', async () => {
    const s = store()
    const ac = new AbortController()
    const id = registerEffTaskRun(s.setAppState, { runId: '1', runDir: '/d', counts: counts(), abortController: ac })
    finishEffTaskRun(id, s.setAppState, { status: 'completed' })
    await EffTaskTask.kill(id, s.setAppState)
    expect(s.task(id).status).toBe('completed')
    expect(ac.signal.aborted).toBe(false) // never abort a run that already finished
  })

  it('is reachable through the task registry, which is what /tasks and TaskStop dispatch on', () => {
    // Without this the type exists, renders, and cannot be stopped: stopTask throws
    // 'Unsupported task type' and the panel's `x` does nothing.
    expect(getTaskByType('efftask')).toBe(EffTaskTask)
  })
})
