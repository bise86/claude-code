import { describe, it, expect } from 'bun:test'
import { parseJsonLines, runInteractive } from './cliAgentRunner.js'

describe('parseJsonLines', () => {
  it('buffers partial lines across chunks', () => {
    const buf = { rest: '' }
    expect(parseJsonLines('{"type":"log","message":"a"}\n{"ty', buf)).toEqual([
      { type: 'log', message: 'a' },
    ])
    expect(parseJsonLines('pe":"result","content":"done"}\n', buf)).toEqual([
      { type: 'result', content: 'done' },
    ])
  })

  it('skips malformed lines without throwing', () => {
    const buf = { rest: '' }
    const out = parseJsonLines('not json\n{"type":"result","content":"ok"}\n', buf)
    expect(out).toEqual([{ type: 'result', content: 'ok' }])
  })
})

describe('runInteractive', () => {
  it('permission_request → calls parent canUseTool and writes back permission_response; result ends', async () => {
    const stdinLines: string[] = []
    const proc = {
      stdin: { write: (d: string) => stdinLines.push(d), end: () => {} },
      stdout: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            type: 'permission_request',
            id: 'p1',
            tool: 'Bash',
            input: { cmd: 'ls' },
          }) + '\n',
        )
        // Let the parent's canUseTool + write-back settle before the child
        // emits its result line, so the response ordering in the assertion
        // below is deterministic.
        await Promise.resolve()
        yield Buffer.from(JSON.stringify({ type: 'result', content: 'ok' }) + '\n')
      })(),
      stderr: (async function* () {})(),
      kill: () => {},
      exited: Promise.resolve(0),
    }
    // Strengthened fake (MIN#13): rather than ignoring its args, assert the
    // exact shape/order canUseTool is invoked with — (tool, input,
    // toolUseContext, assistantMessage, toolUseID) per CanUseToolFn — so an
    // arg-order regression (e.g. swapping toolUseContext/assistantMessage,
    // or passing the wrong request id) fails this test instead of silently
    // passing.
    const fakeToolUseContext = { options: {} }
    const canUseToolCalls: any[] = []
    const canUseTool = async (
      tool: any,
      input: any,
      toolUseContext: any,
      assistantMessage: any,
      toolUseID: any,
    ) => {
      canUseToolCalls.push({ tool, input, toolUseContext, assistantMessage, toolUseID })
      return { behavior: 'allow' }
    }
    const msgs: any[] = []
    for await (const m of runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      fakeToolUseContext as any,
      canUseTool as any,
    ))
      msgs.push(m)
    expect(canUseToolCalls).toHaveLength(1)
    const call = canUseToolCalls[0]
    // tool: a Tool-like object (createToolStub) named after the protocol's `tool` field
    expect(call.tool).toMatchObject({ name: 'Bash' })
    expect(typeof call.tool.renderToolUseMessage).toBe('function')
    // input: exactly the permission_request's `input`, not e.g. the whole message
    expect(call.input).toEqual({ cmd: 'ls' })
    // toolUseContext: passed through unchanged (same reference)
    expect(call.toolUseContext).toBe(fakeToolUseContext)
    // assistantMessage: a synthetic AssistantMessage embedding the same tool_use
    expect(call.assistantMessage.type).toBe('assistant')
    expect(call.assistantMessage.message.content[0]).toMatchObject({
      type: 'tool_use', name: 'Bash', input: { cmd: 'ls' }, id: 'p1',
    })
    // toolUseID (5th arg): the permission_request's own id, not undefined/misordered
    expect(call.toolUseID).toBe('p1')
    expect(stdinLines.join('')).toContain('"type":"permission_response"')
    expect(stdinLines.join('')).toContain('"behavior":"allow"')
    expect(JSON.stringify(msgs[msgs.length - 1].message.content)).toContain('ok')
  })

  it('deny decision is written back verbatim and yields exactly one final message', async () => {
    const stdinLines: string[] = []
    const proc = {
      stdin: { write: (d: string) => stdinLines.push(d), end: () => {} },
      stdout: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            type: 'permission_request',
            id: 'p2',
            tool: 'Bash',
            input: { cmd: 'rm -rf /' },
          }) + '\n',
        )
        await Promise.resolve()
        yield Buffer.from(JSON.stringify({ type: 'result', content: 'stopped' }) + '\n')
      })(),
      stderr: (async function* () {})(),
      kill: () => {},
      exited: Promise.resolve(0),
    }
    const canUseTool = async () => ({ behavior: 'deny', message: 'nope' })
    const msgs: any[] = []
    for await (const m of runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {} } as any,
      canUseTool as any,
    ))
      msgs.push(m)
    expect(stdinLines.join('')).toContain('"behavior":"deny"')
    expect(msgs.length).toBe(1)
  })

  it('a {"type":"result"} line with no content yields an empty string, not the literal ""', async () => {
    const proc = {
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from(JSON.stringify({ type: 'result' }) + '\n')
      })(),
      stderr: (async function* () {})(),
      kill: () => {},
      exited: Promise.resolve(0),
    }
    const canUseTool = async () => ({ behavior: 'allow' })
    const msgs: any[] = []
    for await (const m of runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {} } as any,
      canUseTool as any,
    ))
      msgs.push(m)
    const text = (msgs[msgs.length - 1] as any).message.content[0].text
    expect(text).toBe('')
    expect(text).not.toBe('""')
  })

  it('an already-aborted toolUseContext signal kills the child immediately (no real pid → falls back to proc.kill)', async () => {
    let killed = false
    const controller = new AbortController()
    controller.abort()
    const proc = {
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      kill: () => { killed = true },
      exited: Promise.resolve(0),
    }
    const msgs: any[] = []
    for await (const m of runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {}, abortController: controller } as any,
      (async () => ({ behavior: 'allow' })) as any,
    ))
      msgs.push(m)
    expect(killed).toBe(true)
  })

  it('aborting mid-run kills the child (no real pid → falls back to proc.kill)', async () => {
    let killed = false
    const controller = new AbortController()
    const proc = {
      stdin: { write: () => {}, end: () => {} },
      // Never yields/resolves — parks the run so we can abort mid-flight.
      stdout: (async function* () {
        await new Promise<void>(() => {})
      })(),
      stderr: (async function* () {})(),
      kill: () => { killed = true },
      exited: new Promise<number>(() => {}),
    }
    const gen = runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {}, abortController: controller } as any,
      (async () => ({ behavior: 'allow' })) as any,
    )
    // Advance the generator to its parked `for await (proc.stdout)` point.
    // Everything before that point (including registering the abort
    // listener) runs synchronously, so this schedules but does not need to
    // be awaited before triggering the abort below.
    void gen.next()
    controller.abort()
    expect(killed).toBe(true)
  })

  it('kill-on-dispose: disposing the generator early after receiving its one message kills a still-running (not-yet-exited) child', async () => {
    let killed = false
    const proc = {
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from(JSON.stringify({ type: 'result', content: 'ok' }) + '\n')
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true
      },
      // Never resolves: simulates a child whose stdout has already been
      // fully drained but that hasn't actually exited yet.
      exited: new Promise<number>(() => {}),
    }
    const gen = runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
    )
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(killed).toBe(false)
    await gen.return(undefined)
    expect(killed).toBe(true)
  })

  it('does NOT kill an already-exited child on normal completion (fully drained via for-await)', async () => {
    let killed = false
    const proc = {
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from(JSON.stringify({ type: 'result', content: 'ok' }) + '\n')
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true
      },
      exited: Promise.resolve(0),
    }
    const msgs: any[] = []
    for await (const m of runInteractive(
      proc as any,
      { command: 'x' } as any,
      { prompt: 'go', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
    ))
      msgs.push(m)
    expect(killed).toBe(false)
  })
})
