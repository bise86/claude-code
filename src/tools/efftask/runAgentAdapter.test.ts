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

  it('makeRunAgentFn stops consuming once req.signal is aborted', async () => {
    const ac = new AbortController()
    ac.abort() // already aborted before the run starts
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }
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
    const text = await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: ac.signal })
    expect(text).toBe('first') // breaks after the first message; 'second' never consumed
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
