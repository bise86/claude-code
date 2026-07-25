/**
 * Mounts the resume views through the VENDORED renderer (src/ink.ts), not npm ink.
 *
 * Same reason as ConfirmStartup.test.tsx: both renderers emit identical frames, but
 * `useInput` only works against the app's own StdinContext. A gate that paints correctly and
 * ignores every key is indistinguishable from a working one on screen — and because
 * useCancelRequest disables Esc/Ctrl+C while a local-jsx dialog is mounted, an unanswerable
 * gate wedges the whole session.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ResumePicker } from './ResumePicker.js'
import { ConfirmResume } from './ConfirmResume.js'
import { DEFAULT_CAPS, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import type { ResumeSummary } from '../../tools/efftask/startupConfirm.js'
import type { RunSummary } from '../../tools/efftask/runRegistry.js'

function fakeTty() {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  // Cursor-move sequences ARE the spacing, so they become a space; the bare ESC byte
  // that precedes them must then be removed or it lands between every pair of words.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

const ESC = String.fromCharCode(27)
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 10))
// A lone ESC is buffered by the tokenizer until it can rule out an escape sequence, so an
// Esc assertion has to outwait that window — this is the renderer behaving correctly.
const tickEsc = (): Promise<void> => new Promise(r => setTimeout(r, 250))

const runs: RunSummary[] = [
  { runId: '003', goalLine: '重构支付', updatedAt: 'b', counts: { accepted: 1, blocked: 0, pending: 2, total: 3 }, degraded: false },
  { runId: '001', goalLine: '打通登录', updatedAt: 'a', counts: { accepted: 4, blocked: 1, pending: 0, total: 5 }, degraded: true },
]

describe('ResumePicker (vendored renderer)', () => {
  it('lists the recoverable runs and answers real keypresses', async () => {
    const picked: string[] = []
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: id => picked.push(id), onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('003')
    expect(frame).toContain('重构支付')
    expect(frame).toContain('配置不完整') // the degraded run is flagged, not silently listed

    stdin.press('\r') // Enter picks the run under the cursor
    await tick()
    expect(picked).toEqual(['003'])
    app.unmount()
  })

  it('moves the cursor before picking', async () => {
    const picked: string[] = []
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: id => picked.push(id), onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press('j') // down
    await tick()
    stdin.press('\r')
    await tick()
    expect(picked).toEqual(['001'])
    app.unmount()
  })

  it('cancels on Esc rather than trapping the session', async () => {
    let cancelled = false
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: () => {}, onCancel: () => { cancelled = true } }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press(ESC)
    await tickEsc()
    expect(cancelled).toBe(true)
    app.unmount()
  })

  it('an empty list says so and is still dismissible', async () => {
    let cancelled = false
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: [], onPick: () => {}, onCancel: () => { cancelled = true } }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(lastFrame()).toContain('没有可恢复的 run')
    stdin.press('q')
    await tick()
    expect(cancelled).toBe(true)
    app.unmount()
  })
})

const config: EffTaskConfig = {
  goalPrompt: '打通登录接口',
  parallelism: 3,
  phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS },
  notices: [],
  mainModel: 'claude-opus-4-8',
}

const summary: ResumeSummary = {
  runId: '003',
  counts: { accepted: 2, blocked: 1, pending: 3, total: 6 },
  repairs: ['节点 root/02-b:依赖节点缺失(root/01-a)'],
  reseated: ['root/03-c'],
  exhausted: ['root/04-d'],
  degraded: [],
  loadErrors: [],
  inheritedGuidance: '先从简',
}

describe('ConfirmResume (vendored renderer)', () => {
  it('shows what recovery actually did before asking for approval', async () => {
    // §17.2 requires the validation summary reach the user. Approving a resume without
    // seeing what was repaired or re-queued is approving something you were not shown.
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, onDecision: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('恢复确认')
    expect(frame).toContain('已验收 2')
    expect(frame).toContain('依赖节点缺失')
    expect(frame).toContain('预算已耗尽')
    expect(frame).toContain('沿用') // inherited guidance is disclosed, not applied silently
    expect(frame).toContain('主模型(claude-opus-4-8)') // the roster still names its models
    app.unmount()
  })

  it('approves on Enter and refuses on Esc', async () => {
    const decisions: { approved: boolean }[] = []
    for (const [key, approved] of [['\r', true], [ESC, false]] as const) {
      const { stdin, stdout } = fakeTty()
      const app = await render(
        React.createElement(ConfirmResume, { config, summary, onDecision: d => decisions.push(d) }),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      stdin.press(key)
      await (key === ESC ? tickEsc() : tick())
      expect(decisions[decisions.length - 1]?.approved).toBe(approved)
      app.unmount()
    }
  })

  it('"v" is view-only: it declines without being a cancellation the user did not intend', async () => {
    const decisions: { approved: boolean }[] = []
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, onDecision: d => decisions.push(d) }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press('v')
    await tick()
    expect(decisions).toEqual([{ parallelism: 3, approved: false }])
    app.unmount()
  })
})


import { ConfirmStartup } from './ConfirmStartup.js'

const RIGHT = ESC + '[C'
const LEFT = ESC + '[D'

describe('the gate lets the user CHANGE the parallelism (用户第四句)', () => {
  // "各任务执行可以并行,默认5个,需求提示词可指定,可跟用户确认修改" — the fourth clause.
  // Both branches used to echo props.config.parallelism, so the number was display-only, and
  // the Feishu card's own comment said "the card has no inline editor in P1".
  const propsFor = (name: string, onDecision: (d: { parallelism: number; approved: boolean }) => void) =>
    (name === 'ConfirmResume' ? { config, summary, onDecision } : { config, onDecision }) as never

  for (const [name, Comp] of [
    ['ConfirmStartup', ConfirmStartup],
    ['ConfirmResume', ConfirmResume],
  ] as [string, (p: never) => React.ReactElement][]) {
    it(name + ': arrows change it and the decision carries the NEW value', async () => {
      const decisions: { parallelism: number; approved: boolean }[] = []
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, d => decisions.push(d))),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      expect(lastFrame()).toContain('并行数: 3')
      stdin.press(RIGHT)
      await tick()
      stdin.press('+')
      await tick()
      // The renderer repaints only the CHANGED line, so the accumulated buffer holds a bare
      // "5" rather than the whole label — assert the contract (what onDecision carries),
      // not the intermediate frame.
      expect(lastFrame()).toMatch(/\n\s*5\r?\n/)
      stdin.press('\r')
      await tick()
      expect(decisions[0]).toMatchObject({ parallelism: 5, approved: true })
      app.unmount()
    })

    it(name + ': cannot be pushed below 1', async () => {
      const decisions: { parallelism: number; approved: boolean }[] = []
      const { stdin, stdout } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, d => decisions.push(d))),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      for (let i = 0; i < 6; i++) { stdin.press(LEFT); await tick() }
      stdin.press('\r')
      await tick()
      expect(decisions[0].parallelism).toBe(1)
      app.unmount()
    })

    it(name + ': describes what parallelism actually buys today', async () => {
      // Three surfaces once carried three separately-worded hardcoded strings, two of which
      // still claimed "P1 串行执行" after the concurrent pool shipped.
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, () => {})),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const frame = lastFrame()
      expect(frame).toContain('方案/评审阶段并行')
      expect(frame).toContain('执行与叶子验收串行')
      expect(frame).not.toContain('P1 串行执行')
      // 读取 is not one of this product's phases; naming it here once put a row on the gate
      // that has no counterpart in the roster three lines below.
      expect(frame).not.toContain('读取')
      app.unmount()
    })
  }
})

describe('关口渲染出来的那句话必须随隔离状态变化', () => {
  // A review found parallelismLine could say two things while NO call site ever passed
  // `isolation` — every gate rendered "未启用隔离" including runs whose measured execute
  // concurrency was 4. Testing the function alone could not see that: the gap was the wiring.
  const propsFor = (name: string, isolation?: 'worktree' | 'none') =>
    (name === 'ConfirmResume'
      ? { config, summary, isolation, onDecision: () => {} }
      : { config, isolation, onDecision: () => {} }) as never

  for (const [name, Comp] of [
    ['ConfirmStartup', ConfirmStartup],
    ['ConfirmResume', ConfirmResume],
  ] as [string, (p: never) => React.ReactElement][]) {
    it(name + ': says isolated when the run IS isolated', async () => {
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, 'worktree')),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = lastFrame()
      expect(f).toContain('各阶段并行')
      expect(f).toContain('worktree')
      expect(f).not.toContain('未启用隔离')
      app.unmount()
    })

    it(name + ': says serial when it is NOT isolated', async () => {
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, 'none')),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      expect(lastFrame()).toContain('未启用隔离')
      app.unmount()
    })
  }
})

describe('spec §17.1:选择器上要看得见最后更新时间', () => {
  it('渲染相对时间 —— listRuns 一直算着它,却只用来排序', async () => {
    // The pure formatter having tests does not prove the picker calls it: this repo has cut
    // exactly this wire before (a chunk store passed to a view that never forwarded it).
    // §17.1 lists 最后更新时间 as one of four required columns; with several runs the user
    // was choosing between 003 and 007 on goal text alone.
    const now = Date.now()
    const withTimes: RunSummary[] = [
      { runId: '003', goalLine: '重构支付', updatedAt: new Date(now - 20 * 60_000).toISOString(),
        counts: { accepted: 1, blocked: 0, pending: 2, total: 3 }, degraded: false },
      { runId: '001', goalLine: '打通登录', updatedAt: new Date(now - 3 * 3600_000).toISOString(),
        counts: { accepted: 4, blocked: 1, pending: 0, total: 5 }, degraded: false },
    ]
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: withTimes, onPick: () => {}, onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('20 分钟前')
    expect(frame).toContain('3 小时前')
    app.unmount()
  })

  it('时间戳坏掉的 run 不渲染占位符,也不炸', async () => {
    // listRuns 的累加器从 '' 起步,所以 node.md 全被写坏的 run 到这里就是空串。
    const broken: RunSummary[] = [
      { runId: '004', goalLine: '坏掉的', updatedAt: '',
        counts: { accepted: 0, blocked: 0, pending: 1, total: 1 }, degraded: false },
    ]
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: broken, onPick: () => {}, onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(lastFrame()).toContain('坏掉的')
    expect(lastFrame()).not.toContain('前')
    app.unmount()
  })
})
