import { describe, expect, it } from 'bun:test'
import { getPillLabel } from './pillLabel.js'
import type { BackgroundTaskState } from './types.js'

const effTask = (id: string): BackgroundTaskState =>
  ({
    id, type: 'efftask', status: 'running', description: `高效任务 ${id}`,
    startTime: 0, outputFile: '', outputOffset: 0, notified: false,
    runId: id, runDir: `/d/${id}`,
    counts: { accepted: 0, blocked: 0, pending: 1, total: 1 },
  }) as BackgroundTaskState

describe('footer pill · 高效任务', () => {
  it('names the run type rather than falling through to "background task"', () => {
    // The switch has no default: an unhandled type silently lands on the generic
    // "N background tasks", so the pill would never say what is actually running.
    expect(getPillLabel([effTask('003')])).toBe('1 高效任务')
    expect(getPillLabel([effTask('003'), effTask('004')])).toBe('2 个高效任务')
  })

  it('still degrades to the generic label when types are mixed', () => {
    const shell = { id: 'b1', type: 'local_bash', status: 'running' } as unknown as BackgroundTaskState
    expect(getPillLabel([effTask('003'), shell])).toBe('2 background tasks')
  })
})
