/**
 * Two structural gates for the background-task surfaces.
 *
 * Both encode defects that shipped in this repo: a new task type was added to `Task.ts`,
 * `tasks.ts`, `tasks/types.ts`, `pillLabel.ts` and `BackgroundTasksDialog.tsx` — and missed
 * the two places below. Neither miss threw, and neither was visible to any existing test:
 *
 *  - `BackgroundTask`'s switch has no `default`, so an unhandled type returns `undefined`.
 *    React 19 renders that as nothing, so `/tasks` showed a group heading with a BLANK row
 *    under it. Nothing crashed.
 *  - The dialog's `x` key handler and its `x → stop` hint are two separate lists. The hint
 *    listed the new type; the handler did not. The hint was simply false.
 *
 * Mounted through the VENDORED renderer (src/ink.ts): BackgroundTask is React-compiler output
 * and calls `_c()`, which needs a live dispatcher — calling it as a plain function throws.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { BackgroundTask } from './BackgroundTask.js'
import type { BackgroundTaskState } from '../../tasks/types.js'

function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => null,
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 120, rows: 40,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, '').replace(//g, '')
  return { stdin, stdout, lastFrame: plain }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))

const base = {
  status: 'running' as const,
  description: '高效任务 003 · 已完成 1/3',
  startTime: 0,
  outputFile: '',
  outputOffset: 0,
  notified: false,
}

/** One minimal fixture per BackgroundTaskState variant. */
const FIXTURES: Record<string, BackgroundTaskState> = {
  local_bash: { ...base, id: 'b1', type: 'local_bash', command: 'ls -la', kind: 'bash' },
  local_agent: { ...base, id: 'a1', type: 'local_agent', agentId: 'a1', prompt: 'p', agentType: 'general-purpose' },
  remote_agent: { ...base, id: 'r1', type: 'remote_agent', title: '远端会话', sessionId: 's' },
  in_process_teammate: { ...base, id: 't1', type: 'in_process_teammate', identity: { agentName: 'bob', teamName: 'x', color: 'blue' } },
  dream: { ...base, id: 'd1', type: 'dream', phase: 'starting', sessionsReviewing: 2, filesTouched: [], turns: [], priorMtime: 0 },
  efftask: { ...base, id: 'efftask-003', type: 'efftask', runId: '003', runDir: '/d', counts: { accepted: 1, blocked: 0, pending: 2, total: 3 } },
} as unknown as Record<string, BackgroundTaskState>

async function frameFor(task: BackgroundTaskState): Promise<string> {
  const t = fakeTty()
  const app = await render(
    React.createElement(BackgroundTask as never, { task } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  const out = t.lastFrame()
  app.unmount()
  return out
}

describe('每一种后台任务在 /tasks 列表里都得渲染出东西来', () => {
  for (const [type, task] of Object.entries(FIXTURES)) {
    it(`${type} 渲染出内容,而不是一行空白`, async () => {
      // The switch has no `default`, so a missing case returns undefined — which React
      // renders as nothing at all. The row goes blank and nothing throws.
      const frame = await frameFor(task)
      expect(frame.replace(/\s/g, '').length).toBeGreaterThan(0)
    })
  }

  it('高效任务那一行说得出它是谁、进度多少', async () => {
    // A BLANK row was the actual bug, so assert the CONTENT, not merely that something
    // rendered: the description is the only place the run id and its counts appear.
    // Whitespace-insensitive: the renderer's cursor-move sequences ARE the spacing, and
    // stripping them (above) collapses the gaps. The words are what matter here.
    const frame = (await frameFor(FIXTURES.efftask)).replace(/\s/g, '')
    expect(frame).toContain('高效任务003')
    expect(frame).toContain('已完成1/3')
    expect(frame).toContain('running') // and the status, which is the other half of the row
  })
})

describe('/tasks 的 x 提示不能是空头支票', () => {
  it('提示条里列出的每一种任务,x 处理器都真的处理', () => {
    const src = readFileSync('src/components/tasks/BackgroundTasksDialog.tsx', 'utf8')
    // The hint: `...((currentSelection?.type === 'a' || …) && currentSelection.status === 'running' ? [<KeyboardShortcutHint … action="stop" />]`
    const hint = src.match(/\(\((currentSelection\?\.type === '[\s\S]*?)\) && currentSelection\.status === 'running'/)
    expect(hint).not.toBeNull()
    const advertised = [...hint![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    // Fixture sanity: a regex that silently matched nothing would make this test vacuous.
    expect(advertised.length).toBeGreaterThan(5)

    const start = src.indexOf("if (e.key === 'x')")
    expect(start).toBeGreaterThan(0)
    const handler = src.slice(start, start + 2000)
    const handled = new Set([...handler.matchAll(/type === '([a-z_]+)'/g)].map(m => m[1]))

    const lying = advertised.filter(t => !handled.has(t))
    expect(lying).toEqual([])
  })
})
