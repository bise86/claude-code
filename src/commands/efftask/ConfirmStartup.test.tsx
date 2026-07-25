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
    expect(decisions).toEqual([{ parallelism: 3, approved: true }])

    stdin.press('n')
    await new Promise(r => setTimeout(r, 20))
    expect(decisions[1]).toEqual({ parallelism: 3, approved: false })

    app.unmount()
  })
})
