import { describe, expect, it } from 'bun:test'
import { verifyToolPool } from '../../commands/efftask/efftask.js'
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
    for (const phase of ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer'] as const) {
      async function* fakeRun(args: any): AsyncGenerator<any> {
        seen[phase] = (args.availableTools as { name: string }[]).map(t => t.name)
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }
      }
      await makeRunAgentFn(baseDeps(fakeRun))(req({ phase }))
    }
    expect(seen.execute).toEqual(['Write'])
    // 新增的两个环节也要在这条循环里 —— 漏掉它们,这条测试对它们一个字都没说。
    for (const phase of ['plan', 'review', 'accept', 'integrate', 'observer']) {
      expect(seen[phase]).toEqual(['Read']) // may read the repo, may never write to it
    }
    // verify 有自己的档位:deps 没给 verifyTools 时回落只读(这个 baseDeps 就没给)。
    expect(seen.verify).toEqual(['Read'])
  })

  it('verify 拿的是 verifyTools,不是只读池', async () => {
    // 删掉 runAgentAdapter 的 verify 分支,此前是全套测试全绿 —— 验证者静默退回只读,
    // 跑不了任何命令,这个环节的全部存在理由就没了。
    let got: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: fake agent runner
    async function* fakeRun(args: any): AsyncGenerator<any> {
      got = (args.availableTools as { name: string }[]).map(t => t.name)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }
    }
    const deps = { ...baseDeps(fakeRun), verifyTools: [{ name: 'Bash' }, { name: 'Read' }] as never }
    await makeRunAgentFn(deps)(req({ phase: 'verify' }))
    expect(got).toEqual(['Bash', 'Read'])
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

describe('the deadline must not turn a provider error into a crash report', () => {
  it('a rejecting provider under an active deadline emits no unhandled rejection', async () => {
    // The deadline branch once polled with `void work.finally(() => clearInterval(check))`.
    // `.finally()` returns a DERIVED promise; when `work` rejects, that derived promise
    // rejects too, with nothing attached to it. The caller still saw the error (the race
    // observed `work` itself), so nothing looked broken — but the process-level handler
    // logged a crash-telemetry event for every provider 5xx. Real wiring always passes
    // caps.nodeTimeoutMs, so this fired on every failed phase call.
    const seen: unknown[] = []
    const onUnhandled = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      async function* explodes(): AsyncGenerator<any> {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
        throw new Error('provider exploded (503)')
      }
      const fn = makeRunAgentFn({
        toolUseContext: {} as any,
        canUseTool: (async () => ({ behavior: 'allow' })) as any,
        availableTools: [] as any,
        readOnlyTools: [] as any,
        activeAgents: [],
        mainModelDefault: { agentType: 'main' } as any,
        timeoutMs: 600_000, // the value the real command passes
        runAgentImpl: explodes as any,
      })
      await expect(
        fn({ phase: 'execute', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal }),
      ).rejects.toThrow('provider exploded')
      // Unhandled rejections are reported a turn of the event loop later, not synchronously.
      await new Promise(r => setTimeout(r, 60))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('各环节的子 agent 都拿得到自己的 MCP(2026-07 起的新约定)', () => {
  const mcpAgent = {
    agentType: 'sec',
    mcpServers: [{ name: 'writer', command: 'x' }],
  } as unknown as import('../AgentTool/loadAgentsDir.js').AgentDefinition

  /**
   * NOTE the seam. Asserting on the FINAL availableTools cannot detect this: the MCP merge
   * happens inside the real runAgent, which the injected runAgentImpl replaces, so such an
   * assertion is green on unfixed code. The observable at this layer is the agentDefinition
   * handed to runAgent — if it still carries mcpServers, runAgent will merge those tools
   * back in after the per-phase filter.
   */
  const seenDefs: Record<string, unknown> = {}
  const fnFor = () => {
    async function* fake(args: { agentDefinition: { agentType: string; mcpServers?: unknown } }): AsyncGenerator<any> {
      seenDefs[args.agentDefinition.agentType] = args.agentDefinition.mcpServers
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }
    }
    return makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [{ name: 'Write' }] as any,
      readOnlyTools: [{ name: 'Read' }] as any,
      activeAgents: [mcpAgent],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fake as any,
    })
  }

  it('非执行环节也保留 mcpServers —— 评审员查得了文档和数据库', async () => {
    // 旧约定是非执行环节一律剥掉 mcpServers,于是评审员/验收员连**只读** MCP 都没有,
    // 只能凭 Read/Glob/Grep 猜,而关口对此一个字都没说。用户要求各环节都能用 MCP。
    //
    // 换来的代价必须记清楚:runAgent 在工具分档**之后**才合并 agentMcpTools,所以一个
    // 声明了写能力 MCP 的角色挂在评审席位上时,能自己改完再判通过。剩下的防线是
    // 「内建写工具仍然只有执行环节有」+ canUseTool 询问 + 测试验证的工作区指纹比对。
    for (const phase of ['plan', 'review', 'accept', 'observer'] as const) {
      seenDefs.sec = 'unset'
      await fnFor()({
        phase, node: {} as any, role: { roleName: 'sec' }, system: 's', prompt: 'p',
        signal: new AbortController().signal,
      })
      expect(`${phase}:${Array.isArray(seenDefs.sec)}`).toBe(`${phase}:true`)
    }
  })

  it('但内建的写工具仍然只有执行环节拿得到', async () => {
    // 这条是放开 MCP 之后**唯一**还在结构上拦着「评审员自己改」的东西,必须钉死。
    const seenTools: Record<string, string[]> = {}
    async function* fake(args: { agentDefinition: { agentType: string }; availableTools: { name: string }[] }): AsyncGenerator<any> {
      seenTools[args.agentDefinition.agentType] = args.availableTools.map(t => t.name)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [{ name: 'Write' }, { name: 'Read' }, { name: 'mcp__db__query' }] as any,
      readOnlyTools: [{ name: 'Read' }, { name: 'mcp__db__query' }] as any,
      activeAgents: [mcpAgent],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fake as any,
    })
    for (const phase of ['plan', 'review', 'accept', 'observer'] as const) {
      seenTools.sec = []
      await fn({ phase, node: {} as any, role: { roleName: 'sec' }, system: 's', prompt: 'p', signal: new AbortController().signal })
      expect(`${phase} 拿到写工具: ${seenTools.sec.includes('Write')}`).toBe(`${phase} 拿到写工具: false`)
      expect(`${phase} 拿到 MCP: ${seenTools.sec.includes('mcp__db__query')}`).toBe(`${phase} 拿到 MCP: true`)
    }
    seenTools.sec = []
    await fn({ phase: 'execute', node: {} as any, role: { roleName: 'sec' }, system: 's', prompt: 'p', signal: new AbortController().signal })
    expect(seenTools.sec).toContain('Write')
  })

  it('执行环节照旧', async () => {
    seenDefs.sec = 'unset'
    await fnFor()({
      phase: 'execute', node: {} as any, role: { roleName: 'sec' }, system: 's', prompt: 'p',
      signal: new AbortController().signal,
    })
    expect(Array.isArray(seenDefs.sec)).toBe(true)
  })

  it('does not mutate the shared agent definition', async () => {
    // activeAgents is the session-wide roster; clobbering it would disable MCP for every
    // later AgentTool call in the session.
    await fnFor()({
      phase: 'review', node: {} as any, role: { roleName: 'sec' }, system: 's', prompt: 'p',
      signal: new AbortController().signal,
    })
    expect((mcpAgent as { mcpServers?: unknown[] }).mcpServers).toHaveLength(1)
  })
})

describe('the phase deadline follows the RUN config, not a frozen default', () => {
  it('reads the getter at call time, so a later config change takes effect', async () => {
    // The seam is built in call(), before any config exists. On resume the caps come back
    // off run.md — which is hand-editable — so capturing a number here would let the
    // manifest declare one deadline while the run enforced another.
    let limit = 60_000
    async function* neverYields(args: any): AsyncGenerator<any> {
      args.override.abortController.signal.addEventListener('abort', () => {})
      await new Promise(() => {})
      yield { type: 'assistant', message: { content: [] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any,
      readOnlyTools: [] as any,
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      timeoutMs: () => limit,
      runAgentImpl: neverYields as any,
    })
    limit = 60 // the config resolved after the seam was built
    const started = Date.now()
    await expect(
      fn({ phase: 'execute', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal }),
    ).rejects.toThrow('超时(60 ms)')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('still accepts a plain number', async () => {
    async function* quick(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any, readOnlyTools: [] as any, activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      timeoutMs: 5000, runAgentImpl: quick as any,
    })
    expect(await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })).toBe('ok')
  })
})

describe('测试验证档的工具池(此前整条接线零覆盖)', () => {
  // 三种改法 —— 删掉 verifyTools 接线、删掉 runAgentAdapter 的 verify 分支、把
  // RUN_COMMAND_TOOL_NAMES 清空 —— 此前**各自都是全套测试全绿**,而验证者会静默退回
  // 只读工具、跑不了任何命令,也就是这个环节的全部存在理由没了。
  const tools = [
    { name: 'Read' }, { name: 'Glob' }, { name: 'Grep' },
    { name: 'Bash' }, { name: 'TaskOutput' }, { name: 'TaskStop' },
    { name: 'Edit' }, { name: 'Write' }, { name: 'NotebookEdit' },
  ]

  it('验证档拿得到 Bash —— 没有它,这个环节做不了它唯一该做的事', () => {
    expect(verifyToolPool(tools).map(t => t.name)).toContain('Bash')
  })

  it('拿不到编辑类工具', () => {
    const names = verifyToolPool(tools).map(t => t.name)
    for (const w of ['Edit', 'Write', 'NotebookEdit']) expect(`${w}:${names.includes(w)}`).toBe(`${w}:false`)
  })

  it('后台 shell 的读输出/停止也在 —— 名字必须是仓库的规范名', () => {
    // 早先写的 'BashOutput' / 'KillShell' 在这里是死名,filter 匹配不上不报错,
    // 只会静默少给两个工具:后台起的 shell 读不到输出、杀不掉。
    const names = verifyToolPool(tools).map(t => t.name)
    expect(names).toContain('TaskOutput')
    expect(names).toContain('TaskStop')
    expect(names).not.toContain('BashOutput')
  })

  it('只读那三个照旧在', () => {
    const names = verifyToolPool(tools).map(t => t.name)
    for (const r of ['Read', 'Glob', 'Grep']) expect(`${r}:${names.includes(r)}`).toBe(`${r}:true`)
  })
})
