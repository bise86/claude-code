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
})
