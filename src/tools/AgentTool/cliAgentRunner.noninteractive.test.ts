import { describe, it, expect } from 'bun:test'
import { runCliAgent, makeResultMessage, parseCliUsage } from './cliAgentRunner.js'
import { isEstimatedUsage } from '../../services/api/tokenEstimate.js'

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
    // 输入侧没给提示词就没得估 —— 那时候 0 是实话。
    expect(msg.message.usage.input_tokens).toBe(0)
    // 输出侧**不再是 0**:那是一句假话(用户报的正是「CLI 档的 token 统计没有」)。
    expect(msg.message.usage.output_tokens).toBeGreaterThan(0)
  })

  /**
   * 用户原话:「token 统计…不管 CLI 还是 API 都要准确」。
   *
   * CLI 档是另一个进程,外面只看得见文本 —— 除非它自己报。所以两档:它报就采信,
   * 它不报就估、并且**标明是估的**(界面上带 ≈)。硬编码 0 让一个跑二十分钟、
   * 烧几十万 token 的外部 CLI 在统计里恒等于免费。
   */
  it('CLI 自己报了用量就采信它,而且不标成估算', () => {
    const msg = makeResultMessage('hi', { usage: { input: 1234, output: 56 }, promptForEstimate: '很长的提示词'.repeat(50) }) as any
    expect(msg.message.usage.input_tokens).toBe(1234)
    expect(msg.message.usage.output_tokens).toBe(56)
    expect(isEstimatedUsage(msg.requestId)).toBe(false)
  })

  it('没报就按提示词和正文估,并登记成估算', () => {
    const msg = makeResultMessage('输出的正文', { promptForEstimate: '一段中文提示词,大约这么长' }) as any
    expect(msg.message.usage.input_tokens).toBeGreaterThan(0)
    expect(msg.message.usage.output_tokens).toBeGreaterThan(0)
    // 标记挂在 requestId 上 —— 它此前是 undefined,而那个字段是这次调用的身份。
    expect(typeof msg.requestId).toBe('string')
    expect(isEstimatedUsage(msg.requestId)).toBe(true)
  })

  it('两次调用不共用身份 —— 否则用量表会把它们去重成一次', () => {
    const a = makeResultMessage('x', { promptForEstimate: 'p' }) as any
    const b = makeResultMessage('y', { promptForEstimate: 'p' }) as any
    expect(a.requestId).not.toBe(b.requestId)
  })
})

describe('parseCliUsage', () => {
  it('两套字段名都收 —— 外部 CLI 是别人写的', () => {
    expect(parseCliUsage({ input_tokens: 10, output_tokens: 20 })).toEqual({ input: 10, output: 20 })
    expect(parseCliUsage({ prompt_tokens: 10, completion_tokens: 20 })).toEqual({ input: 10, output: 20 })
  })

  it('第一个键是 0 时不许短路 —— 那种形状真实存在', () => {
    // 某些 CLI 两套字段都写,只有一套是真的。0 在这里的含义是「这一档没报」,不是「零」。
    expect(parseCliUsage({ input_tokens: 0, prompt_tokens: 500, output_tokens: 7 })).toEqual({ input: 500, output: 7 })
    expect(parseCliUsage({ output_tokens: 0, completion_tokens: 42 })).toEqual({ input: 0, output: 42 })
  })

  it('没有可用数字时返回 undefined —— 那时候该走估算,而不是记成 0', () => {
    expect(parseCliUsage(undefined)).toBeUndefined()
    expect(parseCliUsage({})).toBeUndefined()
    expect(parseCliUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
    expect(parseCliUsage({ input_tokens: -5 })).toBeUndefined()
    expect(parseCliUsage('nope')).toBeUndefined()
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

  describe('提示词按声明的窗口封顶', () => {
    /** 抓住真正写进 stdin 的那一段 —— 判据只能是这个,不是函数的返回值。 */
    const capture = (): { spawn: any; get: () => string } => {
      let stdin = ''
      return {
        get: () => stdin,
        spawn: () => ({
          stdin: { write: (d: string) => { stdin += d }, end: () => {} },
          stdout: (async function* () { yield Buffer.from('ok') })(),
          stderr: (async function* () {})(),
          kill: () => {}, exited: Promise.resolve(0),
        }),
      }
    }
    const run = async (agentDef: any, prompt: string, spawn: any): Promise<void> => {
      for await (const _ of runCliAgent(
        agentDef, { prompt, description: 'd' },
        { options: {} } as any, (async () => ({ behavior: 'allow' })) as any, {} as any,
        { spawn } as any,
      )) { /* drain */ }
    }

    it('没声明窗口时一个字节都不动 —— 外部 CLI 自己带上下文管理', async () => {
      const c = capture()
      const long = 'x'.repeat(2_000_000)
      await run({ execMode: 'cli', interactive: false, command: 'x' }, long, c.spawn)
      expect(c.get()).toBe(long)
    })

    it('声明了窗口、而且真的超了,才截 —— 通知在最前面', async () => {
      const c = capture()
      await run({ execMode: 'cli', interactive: false, command: 'x', contextWindow: 32_000 }, 'x'.repeat(2_000_000), c.spawn)
      expect(c.get().length).toBeLessThan(2_000_000)
      expect(c.get().startsWith('〔提示词过长已被截断〕')).toBe(true)
    })

    it('声明了窗口但装得下时,仍然逐字原样', async () => {
      const c = capture()
      await run({ execMode: 'cli', interactive: false, command: 'x', contextWindow: 32_000 }, 'the exact prompt', c.spawn)
      expect(c.get()).toBe('the exact prompt')
    })
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
