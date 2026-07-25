/**
 * Mounts through the VENDORED renderer (src/ink.ts), not npm ink.
 *
 * This exists because of a real bug: these components originally imported `ink` directly.
 * Rendering looked perfect — both renderers emit identical frames — but `useInput`
 * subscribed to npm ink's StdinContext, which this app never mounts, so every key handler
 * was dead: the confirm gate could not be answered OR cancelled, and because
 * useCancelRequest disables Esc/Ctrl+C while a local-jsx dialog is up, the session wedged.
 * A test that renders with the wrong renderer cannot see this, so this one must always use
 * the app's own `render`.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { DEFAULT_CAPS, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from '../../tools/efftask/types.js'

const config: EffTaskConfig = {
  goalPrompt: '把 README 翻译成英文',
  parallelism: 3,
  phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'arch' }] } as Record<PhaseName, RoleBinding[]>,
  caps: { ...DEFAULT_CAPS },
  notices: [],
}

function fakeTty() {
  // The vendored renderer subscribes to 'readable' and pulls with read() — NOT 'data'.
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    read: () => { const v = pending; pending = null; return v },
    setEncoding() {},
    unref() {},
    ref() {},
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  // The renderer positions text with cursor-move escapes rather than spaces, so raw frames
  // read as "把[1CREADME". Strip control sequences before asserting on content.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ')
  return { stdin, stdout, lastFrame: plain }
}

describe('ConfirmStartup (vendored renderer)', () => {
  it('renders the roster and answers real keypresses', async () => {
    const decisions: Array<{ approved: boolean }> = []
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmStartup, { config, onDecision: d => decisions.push(d) }),
      // biome-ignore lint/suspicious/noExplicitAny: fake TTY streams for a headless render
      { stdin: stdin as any, stdout: stdout as any, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))

    const frame = lastFrame()
    expect(frame).toContain('高效任务模式')
    expect(frame).toContain('翻译成英文') // the goal, via the shared goalLine()
    expect(frame).toContain('arch') // the REAL roster, not a placeholder
    expect(frame).toContain('主模型') // phases with no binding fall back to the main model

    // A key must actually reach useInput. If these components ever import npm ink again,
    // this stays empty and the gate becomes unanswerable in the real REPL.
    stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    // The decision now carries the roster too (spec §2 第一关 "名册可编辑后确认"); an
    // unedited gate sends back exactly what it was given.
    expect(decisions[0]).toMatchObject({ parallelism: 3, approved: true })
    expect(decisions[0].phaseRoles).toBeDefined()

    stdin.press('n')
    await new Promise(r => setTimeout(r, 20))
    // A CANCEL carries no roster — there is nothing to apply.
    expect(decisions[1]).toEqual({ parallelism: 3, approved: false })

    app.unmount()
  })
})

describe('启动关口的角色名册真的能改 (spec §2 第一关)', () => {
  const cfg2 = () => ({
    goalPrompt: '打通登录接口', parallelism: 3, notices: [], mainModel: 'claude-opus-5',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600000 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  })
  const mount2 = async (over: Record<string, unknown> = {}) => {
    const { stdin, stdout, lastFrame } = fakeTty()
    const decisions: { parallelism: number; approved: boolean; phaseRoles?: Record<string, { roleName: string }[]> }[] = []
    const app = await render(
      React.createElement(ConfirmStartup as never, {
        config: cfg2(), availableRoles: ['architect', 'security', 'qa'],
        onDecision: (d: never) => decisions.push(d), ...over,
      } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    return { stdin, lastFrame, decisions, app }
  }
  const press = async (m: { stdin: { press: (s: string) => void } }, s: string) => {
    m.stdin.press(s); await new Promise(r => setTimeout(r, 20))
  }
  const DOWN2 = String.fromCharCode(27) + '[B'
  const RIGHT2 = String.fromCharCode(27) + '[C'

  it('r 打开编辑器,空格把角色加到当前阶段,回车带着新名册确认', async () => {
    // spec §2: "名册可编辑后确认". It was rendered read-only, so a user who wanted a
    // different panel had to cancel, reword the prompt and start the whole thing over.
    const m = await mount2()
    await press(m, 'r')
    expect(m.lastFrame()).toContain('编辑中')
    await press(m, DOWN2)     // plan → review
    await press(m, RIGHT2)    // architect → security
    await press(m, ' ')       // bind it
    await press(m, '\r')
    expect(m.decisions).toHaveLength(1)
    expect(m.decisions[0].approved).toBe(true)
    expect(m.decisions[0].phaseRoles?.review.map(r => r.roleName)).toEqual(['security'])
    m.app.unmount()
  })

  it('编辑器里的 Esc 只退出编辑,不取消整个 run', async () => {
    // Cancelling from inside an editor the user just opened would lose the edits AND the gate
    // in one keystroke.
    const m = await mount2()
    await press(m, 'r')
    await press(m, ' ')       // bind architect to plan
    await press(m, String.fromCharCode(27))
    await new Promise(r => setTimeout(r, 250))
    expect(m.decisions).toEqual([])           // NOT cancelled
    await press(m, '\r')
    expect(m.decisions[0].phaseRoles?.plan.map(r => r.roleName)).toEqual(['architect']) // edit kept
    m.app.unmount()
  })

  it('名册显示的是编辑后的样子,不是传进来的那份', async () => {
    // A gate that shows one panel and starts another is the failure this gate exists to prevent.
    const m = await mount2()
    await press(m, 'r')
    await press(m, ' ')
    await press(m, String.fromCharCode(27))
    await new Promise(r => setTimeout(r, 250))
    // A DISCRIMINATING substring. Plain 'architect' is printed by the EDITOR too (it lists
    // every candidate), and the frame buffer accumulates — so that assertion passed whether
    // or not the read-only roster reflected the edit. Only rosterLines produces this shape.
    expect(m.lastFrame()).toContain('方案: architect')
    m.app.unmount()
  })

  it('没有可用角色时说明原因,而不是画一张空表', async () => {
    const m = await mount2({ availableRoles: [] })
    await press(m, 'r')
    expect(m.lastFrame()).toContain('没有可用角色')
    // …and it must still be answerable.
    await press(m, '\r')
    expect(m.decisions[0].approved).toBe(true)
    m.app.unmount()
  })

  it('不编辑时,←/→ 仍然调并行数', async () => {
    const m = await mount2()
    await press(m, RIGHT2)
    await press(m, '\r')
    expect(m.decisions[0].parallelism).toBe(4)
    m.app.unmount()
  })
})

describe('一次 chunk 里到达多个键(按住方向键、ssh/tmux 合并输入)', () => {
  const cfg3 = () => ({
    goalPrompt: 'g', parallelism: 3, notices: [], mainModel: 'claude-opus-5',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600000 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  })
  const mount3 = async () => {
    const { stdin, stdout, lastFrame } = fakeTty()
    const decisions: { parallelism: number; approved: boolean; phaseRoles?: Record<string, { roleName: string }[]> }[] = []
    const app = await render(
      React.createElement(ConfirmStartup as never, {
        config: cfg3(), availableRoles: ['architect', 'security', 'qa'],
        onDecision: (d: never) => decisions.push(d),
      } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    return { stdin, lastFrame, decisions, app }
  }
  const ESC3 = String.fromCharCode(27)

  it('↓ 和 空格 一起到达时,角色绑到光标所在的阶段', async () => {
    // The renderer splits one stdin chunk into several InputEvents and dispatches them
    // SYNCHRONOUSLY, while useInput only swaps its handler in a post-commit layout effect —
    // so the second key ran the previous render's closure. Measured: the role landed on 方案
    // while ▶ was rendered on 评审, and the read-only roster then showed the wrong panel,
    // which the user confirmed.
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[B ')       // ↓ and space in ONE chunk
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.review.map(r => r.roleName)).toEqual(['architect'])
    expect(m.decisions[0].phaseRoles?.plan).toEqual([])
    m.app.unmount()
  })

  it('↓↓ 和 空格 一起到达时也一样', async () => {
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[B' + ESC3 + '[B ')
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.execute.map(r => r.roleName)).toEqual(['architect'])
    m.app.unmount()
  })

  it('→ 和 空格 一起到达时,绑的是光标所在的角色', async () => {
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[C ')
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.plan.map(r => r.roleName)).toEqual(['security'])
    m.app.unmount()
  })

  it('→ 和 回车 一起到达时,确认的是屏幕上那个并行数', async () => {
    // Same class, and it predates the roster editor: onDecision read `parallelism` from the
    // closure, so the screen said 4 and the decision carried 3.
    const m = await mount3()
    m.stdin.press(ESC3 + '[C\r')
    await new Promise(r => setTimeout(r, 30))
    expect(m.decisions[0].parallelism).toBe(4)
    m.app.unmount()
  })
})
