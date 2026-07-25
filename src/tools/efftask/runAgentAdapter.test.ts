import { describe, expect, it } from 'bun:test'
import { collectText, pickAgentDefinition, makeRunAgentFn } from './runAgentAdapter.js'
import { pwd } from '../../utils/cwd.js'

describe('runAgentAdapter helpers', () => {
  it('collectText concatenates assistant text blocks', () => {
    const messages: any[] = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use', name: 'x', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } },
      { type: 'user', message: { content: [] } },
    ]
    expect(collectText(messages)).toBe('hello world')
  })
  it('pickAgentDefinition returns main default for null role', () => {
    const main = { agentType: 'main', whenToUse: '', tools: undefined } as any
    expect(pickAgentDefinition(null, [], main)).toBe(main)
  })
  it('pickAgentDefinition finds role by agentType, falls back to main', () => {
    const main = { agentType: 'main' } as any
    const coder = { agentType: 'coder' } as any
    expect(pickAgentDefinition({ roleName: 'coder' }, [coder], main)).toBe(coder)
    expect(pickAgentDefinition({ roleName: 'ghost' }, [coder], main)).toBe(main)
  })

  it('makeRunAgentFn concatenates assistant text from an injected runAgentImpl', async () => {
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'part1 ' }] } }
      yield { type: 'user', message: { content: [] } } // non-assistant ignored
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'part2' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any, // fixture only: the injected runAgentImpl ignores tools
      readOnlyTools: [] as any, // (real wiring passes Read/Glob/Grep — see Task 11)
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fakeRun as any,
    })
    const text = await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })
    expect(text).toBe('part1 part2')
  })

  it('makeRunAgentFn does not dispatch at all when the signal is ALREADY aborted', async () => {
    // An abort racing the next phase call must not launch a real, tool-bearing sub-agent —
    // in the execute phase that pool is write-capable.
    const ac = new AbortController()
    ac.abort()
    let dispatched = false
    async function* fakeRun(): AsyncGenerator<any> {
      dispatched = true
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any, // fixture only: the injected runAgentImpl ignores tools
      readOnlyTools: [] as any, // (real wiring passes Read/Glob/Grep — see Task 11)
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fakeRun as any,
    })
    const text = await fn({ phase: 'execute', node: {} as any, role: null, system: 's', prompt: 'p', signal: ac.signal })
    expect(dispatched).toBe(false)
    expect(text).toBe('')
  })

  it('makeRunAgentFn stops consuming once the signal aborts mid-stream', async () => {
    const ac = new AbortController()
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any,
      readOnlyTools: [] as any,
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fakeRun as any,
    })
    // Cancel from outside once the first message lands — the real timing of a user hitting
    // Esc, rather than the generator cancelling itself between yields.
    const text = await fn({
      phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p',
      signal: ac.signal, onChunk: () => ac.abort(),
    })
    expect(text).toBe('first') // 'second' is never consumed
  })

  const baseDeps = (runAgentImpl: unknown) => ({
    toolUseContext: {} as any,
    canUseTool: (async () => ({ behavior: 'allow' })) as any,
    availableTools: [{ name: 'Write' }] as any,
    readOnlyTools: [{ name: 'Read' }] as any,
    activeAgents: [],
    mainModelDefault: { agentType: 'main' } as any,
    runAgentImpl: runAgentImpl as any,
  })
  const req = (over: Record<string, unknown>) => ({
    node: {} as any, role: null, system: 's', prompt: 'p',
    signal: new AbortController().signal, ...over,
  }) as any

  it('only the execute phase receives the write-capable tool pool', async () => {
    const seen: Record<string, string[]> = {}
    for (const phase of ['plan', 'review', 'execute', 'accept', 'observer'] as const) {
      async function* fakeRun(args: any): AsyncGenerator<any> {
        seen[phase] = (args.availableTools as { name: string }[]).map(t => t.name)
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }
      }
      await makeRunAgentFn(baseDeps(fakeRun))(req({ phase }))
    }
    expect(seen.execute).toEqual(['Write'])
    for (const phase of ['plan', 'review', 'accept', 'observer']) {
      expect(seen[phase]).toEqual(['Read']) // may read the repo, may never write to it
    }
  })

  it('forwards cancellation INTO the sub-agent, not just between messages', async () => {
    // Polling alone leaves an abort invisible until the next yield, so a stall before the
    // first message is never noticed and a cancelled run keeps a live agent working.
    let innerAborted = false
    const ac = new AbortController()
    async function* fakeRun(args: any): AsyncGenerator<any> {
      args.override.abortController.signal.addEventListener('abort', () => { innerAborted = true })
      ac.abort()
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
    }
    await makeRunAgentFn(baseDeps(fakeRun))(req({ phase: 'execute', signal: ac.signal }))
    expect(innerAborted).toBe(true)
  })

  it('passes cwd as worktreePath AND actually switches the working directory', async () => {
    // worktreePath is metadata only — without the cwd override a worktree executor would
    // record the right tree and write its changes into the wrong one.
    let observedCwd = ''
    let observedWorktreePath: string | undefined
    async function* fakeRun(args: any): AsyncGenerator<any> {
      observedWorktreePath = args.worktreePath
      observedCwd = pwd()
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
    }
    await makeRunAgentFn(baseDeps(fakeRun))(req({ phase: 'execute', cwd: '/tmp/some-worktree' }))
    expect(observedWorktreePath).toBe('/tmp/some-worktree')
    expect(observedCwd).toBe('/tmp/some-worktree')
  })

  it('collectText handles string content, multiple blocks and interleaved block types', async () => {
    // `content` as a plain string is a real variant in this codebase; iterating it as
    // blocks would silently yield '' and erase the whole answer.
    expect(collectText([{ type: 'assistant', message: { content: '纯字符串回答' } } as any])).toBe('纯字符串回答')
    expect(collectText([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'B' }] } },
      { type: 'assistant', message: { content: [] } },
      { type: 'assistant', message: { content: '尾巴' } },
    ] as any)).toBe('AB尾巴')
  })

  it('a rejecting sub-agent propagates instead of becoming a bogus empty answer', async () => {
    // roundtable's Promise.allSettled turns this into an infra-flagged failing verdict; if
    // it were swallowed into '', the phase would read as a real (empty) answer instead.
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
      throw new Error('provider exploded')
    }
    await expect(makeRunAgentFn(baseDeps(fakeRun))(req({ phase: 'plan' }))).rejects.toThrow('provider exploded')
  })

  it('onChunk receives each message individually, not the cumulative buffer', async () => {
    const chunks: string[] = []
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'AAA' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'BBB' }] } }
    }
    const text = await makeRunAgentFn(baseDeps(fakeRun))(req({ phase: 'plan', onChunk: (t: string) => chunks.push(t) }))
    expect(chunks).toEqual(['AAA', 'BBB'])
    expect(text).toBe('AAABBB')
  })

  it('pickAgentDefinition resolves a duplicated agentType to the first match', () => {
    const first = { agentType: 'dup', tag: 1 } as any
    const second = { agentType: 'dup', tag: 2 } as any
    const main = { agentType: 'main' } as any
    expect(pickAgentDefinition({ roleName: 'dup' }, [first, second], main)).toBe(first)
  })

  it('a throwing onChunk does not take the call down', async () => {
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }
    }
    const text = await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', onChunk: () => { throw new Error('渲染崩溃') } }),
    )
    expect(text).toBe('AB')
  })
})

describe('a hung provider is bounded by the phase deadline', () => {
  it('aborts and reports instead of parking forever', async () => {
    // Wall clock was the one unbounded axis: a provider that never rejects leaves the
    // pipeline in `await`, the tree showing 运行中 forever, and even Esc cannot unstick it
    // because nothing is polling.
    let innerAborted = false
    async function* neverYields(args: any): AsyncGenerator<any> {
      args.override.abortController.signal.addEventListener('abort', () => { innerAborted = true })
      await new Promise(() => {}) // hangs
      yield { type: 'assistant', message: { content: [] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any,
      readOnlyTools: [] as any,
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      timeoutMs: 60,
      runAgentImpl: neverYields as any,
    })
    const started = Date.now()
    await expect(
      fn({ phase: 'execute', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal }),
    ).rejects.toThrow('超时')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(innerAborted).toBe(true) // the sub-agent really was told to stop
  })

  it('a responsive call is unaffected by the deadline', async () => {
    async function* quick(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any,
      readOnlyTools: [] as any,
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      timeoutMs: 5000,
      runAgentImpl: quick as any,
    })
    expect(await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })).toBe('done')
  })
})
