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
})
