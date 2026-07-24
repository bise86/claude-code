import { describe, it, expect } from 'bun:test'
import { runCliAgent, makeResultMessage } from './cliAgentRunner.js'

function fakeSpawn(stdoutText: string) {
  return (_c: string, _a: string[]) => {
    let stdinData = ''
    return {
      stdin: {
        write: (d: string) => {
          stdinData += d
        },
        end: () => {},
      },
      stdout: (async function* () {
        yield Buffer.from(stdoutText)
      })(),
      stderr: (async function* () {})(),
      kill: () => {},
      exited: Promise.resolve(0),
      _getStdin: () => stdinData,
    }
  }
}

describe('makeResultMessage', () => {
  it('constructs a valid assistant Message with the given text', () => {
    const msg = makeResultMessage('hello world') as any
    expect(msg.type).toBe('assistant')
    expect(typeof msg.uuid).toBe('string')
    expect(typeof msg.timestamp).toBe('string')
    expect(msg.message.role).toBe('assistant')
    expect(msg.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(msg.message.usage.input_tokens).toBe(0)
    expect(msg.message.usage.output_tokens).toBe(0)
  })
})

describe('runCliAgent non-interactive', () => {
  it('pipes prompt to stdin and yields stdout as final assistant message', async () => {
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn: fakeSpawn('the answer') } as any,
    ))
      msgs.push(m)
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('assistant')
    expect(JSON.stringify(last.message.content)).toContain('the answer')
  })

  it('writes task.prompt verbatim to stdin and ends it', async () => {
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    let capturedStdin = ''
    const spawn = (_c: string, _a: string[]) => {
      const proc = {
        stdin: {
          write: (d: string) => {
            capturedStdin += d
          },
          end: () => {},
        },
        stdout: (async function* () {
          yield Buffer.from('ok')
        })(),
        stderr: (async function* () {})(),
        kill: () => {},
        exited: Promise.resolve(0),
      }
      return proc
    }
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'the exact prompt', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn } as any,
    ))
      msgs.push(m)
    expect(capturedStdin).toBe('the exact prompt')
  })

  it('trims trailing whitespace/newlines from stdout', async () => {
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn: fakeSpawn('  the answer\n\n') } as any,
    ))
      msgs.push(m)
    const last = msgs[msgs.length - 1]
    expect(last.message.content[0].text).toBe('the answer')
  })

  it('yields exactly one message for the non-interactive tier', async () => {
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn: fakeSpawn('the answer') } as any,
    ))
      msgs.push(m)
    expect(msgs.length).toBe(1)
  })

  it('an already-aborted toolUseContext signal kills the child immediately (no real pid → falls back to proc.kill)', async () => {
    let killed = false
    const controller = new AbortController()
    controller.abort()
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const spawn = (_c: string, _a: string[]) => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from('out')
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true
      },
      exited: Promise.resolve(0),
    })
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {}, abortController: controller } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn } as any,
    ))
      msgs.push(m)
    expect(killed).toBe(true)
  })

  it('kill-on-dispose: disposing the generator early after receiving its one message kills a still-running (not-yet-exited) child', async () => {
    let killed = false
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const spawn = (_c: string, _a: string[]) => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from('out')
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true
      },
      // Never resolves: simulates a child whose stdout has already been
      // fully drained but that hasn't actually exited yet.
      exited: new Promise<number>(() => {}),
    })
    const gen = runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn } as any,
    )
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(killed).toBe(false)
    await gen.return(undefined)
    expect(killed).toBe(true)
  })

  it('does NOT kill an already-exited child on normal completion (fully drained via for-await)', async () => {
    let killed = false
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const spawn = (_c: string, _a: string[]) => ({
      stdin: { write: () => {}, end: () => {} },
      stdout: (async function* () {
        yield Buffer.from('out')
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true
      },
      exited: Promise.resolve(0),
    })
    const msgs: any[] = []
    for await (const m of runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {} } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn } as any,
    ))
      msgs.push(m)
    expect(killed).toBe(false)
  })

  it('aborting mid-run kills the child (no real pid → falls back to proc.kill)', async () => {
    let killed = false
    const controller = new AbortController()
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const spawn = (_c: string, _a: string[]) => ({
      stdin: { write: () => {}, end: () => {} },
      // Never yields/resolves — parks the run so we can abort mid-flight.
      stdout: (async function* () {
        await new Promise<void>(() => {})
      })(),
      stderr: (async function* () {
        await new Promise<void>(() => {})
      })(),
      kill: () => {
        killed = true
      },
      exited: new Promise<number>(() => {}),
    })
    const gen = runCliAgent(
      agentDef,
      { prompt: 'do it', description: 'd' },
      { options: {}, abortController: controller } as any,
      (async () => ({ behavior: 'allow' })) as any,
      {} as any,
      { spawn } as any,
    )
    // Advance the generator to its parked `Promise.all([readAll(stdout), ...])`
    // point. The abort listener registration happens synchronously before
    // that, so this schedules but does not need to be awaited before
    // triggering the abort below.
    void gen.next()
    controller.abort()
    expect(killed).toBe(true)
  })
})
