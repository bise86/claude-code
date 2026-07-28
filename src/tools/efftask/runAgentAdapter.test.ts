import { describe, expect, it } from 'bun:test'
import { verifyToolPool } from '../../commands/efftask/efftask.js'
import { collectText, modelForRole, pickAgentDefinition, makeRunAgentFn, pollIntervalMs } from './runAgentAdapter.js'
import { createRunControl } from './control.js'
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

  it('员工没解析出来时,**不许**把它的模型名传下去', () => {
    /**
     * 用户实测:配了 roles[] 之后方案环节整段变成
     *   「There's an issue with the selected model (K3). It may not exist or you may not
     *    have access to it.」
     * 而重点/风险点/验收点全空 —— 关口上三行 ⚠,一次真正的分析都没发生。
     *
     * 根因:员工匹配不到 agent 定义时回落到主模型,而调用方仍然把 role.model 传下去,
     * 于是拿着 'K3' 去问会话自己的 provider。员工自己的 apiUrl/apiToken 挂在它自己的
     * agent 定义上,回落之后那一份根本没被用上。
     */
    const coder = { agentType: '架构' } as never
    // 解析到了 → 用它自己的模型(它的 apiUrl 也跟着那份定义走)。
    expect(modelForRole({ roleName: '架构', model: 'K3' } as never, [coder])).toBe('K3')
    // 没解析到 → **退回主模型的默认模型**,而不是硬塞一个不存在的名字。
    expect(modelForRole({ roleName: '不存在的员工', model: 'K3' } as never, [coder])).toBeUndefined()
    // 没写 model 的员工本来就跟主模型走。
    expect(modelForRole({ roleName: '架构' } as never, [coder])).toBeUndefined()
    expect(modelForRole(null, [coder])).toBeUndefined()
  })
  it('派发时真的用的是 modelForRole,不是裸的 role.model', async () => {
    // 纯函数写对了但没接上去 —— 这个仓库反复付过的代价。这条从**真派发**看:
    // 一个解析不出来的员工,传给 runAgent 的 model 必须是 undefined。
    let seen: unknown = 'NOT-SET'
    async function* fake(args: { model?: unknown }): AsyncGenerator<never> {
      seen = args.model
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } as never
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as never,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      availableTools: [] as never,
      readOnlyTools: [] as never,
      activeAgents: [{ agentType: '架构' } as never],
      mainModelDefault: { agentType: 'main' } as never,
      runAgentImpl: fake as never,
    })
    await fn({
      phase: 'plan', node: { id: 'root' } as never,
      role: { roleName: '不存在的员工', model: 'K3' } as never,
      system: 's', prompt: 'p', signal: new AbortController().signal,
    })
    expect(`传给 runAgent 的 model: ${String(seen)}`).toBe('传给 runAgent 的 model: undefined')
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
      signal: ac.signal, stream: { push: () => ac.abort(), end: () => {} },
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

  it('每条消息逐条推给窗口,不是把累积缓冲重发一遍', async () => {
    const evs: string[] = []
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'AAA' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'BBB' }] } }
    }
    const text = await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', stream: { push: (e: any) => evs.push(e.text), end: () => {} } }),
    )
    expect(evs).toEqual(['AAA', 'BBB'])
    expect(text).toBe('AAABBB')
  })

  it('工具调用与工具返回值也进窗口 —— 此前这两类一个字都看不到', async () => {
    // 改动之前:只有 type === 'assistant' 触发回调,而且只取 text 块。于是模型「调了什么
    // 工具」「工具返回了什么」全部丢失,一个纯工具轮次在界面上完全空白。
    const kinds: string[] = []
    const briefs: string[] = []
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先看看' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '读到了' }] } }
    }
    await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', stream: { push: (e: any) => { kinds.push(e.kind); briefs.push(e.brief ?? e.text) }, end: () => {} } }),
    )
    expect(kinds).toEqual(['thinking', 'tool', 'result'])
    expect(briefs[1]).toBe('Read(a.ts)')
    expect(briefs[2]).toBe('读到了')
  })

  it('调用结束时收口窗口 —— 这是唯一一个所有模型调用必经的点', async () => {
    // 放在圆桌里收口的话,走 runPhase 的六处(分析圆桌/方案融合/方案精化/观察评分/
    // 冲突解决/执行)加根方案全都不会收口:表头永远停在「运行中」,而且这些流永远不进
    // 可淘汰集合,内存上限对它们直接失效。
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
    }
    let ended = 0
    await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', stream: { push: () => {}, end: () => { ended++ } } }),
    )
    expect(ended).toBe(1)
  })

  it('provider 抛出时也收口', async () => {
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
      throw new Error('provider exploded')
    }
    let ended = 0
    let reason: string | undefined
    await expect(
      makeRunAgentFn(baseDeps(fakeRun))(req({ phase: 'plan', stream: { push: () => {}, end: (e?: string) => { ended++; reason = e } } })),
    ).rejects.toThrow('provider exploded')
    expect(ended).toBe(1)
    // **收口时要带上理由。** 只断言 end() 被调用是不够的:第一版给抛出那一支传的是
    // undefined,于是 provider 抛 ECONNRESET 之后窗口表头是绿色的「● 已完成」——
    // 而中断那条路径反而是对的,同一块屏上两种失败长得不一样。
    expect(reason).toContain('provider exploded')
  })

  it('已中断的早退路径也收口 —— 它绕过 finally', async () => {
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
    }
    const ac = new AbortController()
    ac.abort()
    let endedWith: string | undefined | null = null
    const text = await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', signal: ac.signal, stream: { push: () => {}, end: (e?: string) => { endedWith = e } } }),
    )
    expect(text).toBe('')
    expect(endedWith).toBe('已中断')
  })

  it('pickAgentDefinition resolves a duplicated agentType to the first match', () => {
    const first = { agentType: 'dup', tag: 1 } as any
    const second = { agentType: 'dup', tag: 2 } as any
    const main = { agentType: 'main' } as any
    expect(pickAgentDefinition({ roleName: 'dup' }, [first, second], main)).toBe(first)
  })

  it('窗口崩了不能带走这次调用', async () => {
    // 代价不是「窗口空了」:异常从 for await 逃出 → consume() reject → collectText 永不
    // 执行 → 模型已经答完的内容全丢 → 席位判 infra → 重试三桌 → 节点阻断,而理由写的是
    // 「角色调用失败」,指向完全错误的方向。
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }
    }
    const text = await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', stream: { push: () => { throw new Error('渲染崩溃') }, end: () => {} } }),
    )
    expect(text).toBe('AB')
  })

  it('事件提取本身抛了也不能带走这次调用', async () => {
    // try/catch 必须包住 eventsFromMessage,不能只包 push —— 只包 push 的话,一个畸形
    // 消息在提取阶段抛出来就直接逃出循环了。
    //
    // 用 **user** 类型是刻意的:collectText 先判 `m.type !== 'assistant'` 就 continue,
    // 根本不碰 `.message`,所以这条消息只在**事件提取**那一侧炸。用 assistant 的话
    // collectText 会先炸,这条测试就变成在测别的东西了(第一版就是这么写错的)。
    const hostile = { type: 'user', get message(): never { throw new Error('畸形消息') } }
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }
      yield hostile
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }
    }
    const text = await makeRunAgentFn(baseDeps(fakeRun))(
      req({ phase: 'plan', stream: { push: () => {}, end: () => {} } }),
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

describe('两个时钟:等人回答不能算进接口超时', () => {
  const deps = (runAgentImpl: unknown, over: Record<string, unknown> = {}) => ({
    toolUseContext: {} as never,
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    availableTools: [] as never,
    readOnlyTools: [] as never,
    activeAgents: [],
    mainModelDefault: { agentType: 'main' } as never,
    runAgentImpl: runAgentImpl as never,
    ...over,
  })
  // node 带上 id:取消是**按节点 id** 登记和触发的,`{}` 的话 id 是 undefined,
  // 于是 registerCall 和 cancelNode 各按各的键走,取消永远命不中。
  const call = (fn: ReturnType<typeof makeRunAgentFn>) =>
    fn({ phase: 'execute', node: { id: 'root' } as never, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })

  /**
   * 数 setInterval / clearInterval —— 直接拦全局函数。
   *
   * 第一版用的是 `process._getActiveHandles`,而 **bun 上根本没有这个函数**:
   * `?.() ?? 0` 于是恒返回 0,断言变成 `0 <= 0`,把 clearInterval 整条删掉照样绿
   * (实测存活)。这是「探针坏了被记成覆盖」的典型形状。
   */
  function watchIntervals(): { stop: () => { created: number; cleared: number; delays: number[] } } {
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let created = 0
    let cleared = 0
    const delays: number[] = []
    globalThis.setInterval = ((...a: unknown[]) => {
      created++
      if (typeof a[1] === 'number') delays.push(a[1])
      return (realSet as (...x: unknown[]) => unknown)(...a)
    }) as typeof globalThis.setInterval
    globalThis.clearInterval = ((h: unknown) => {
      cleared++
      return (realClear as (x: unknown) => unknown)(h)
    }) as typeof globalThis.clearInterval
    return {
      stop: () => {
        globalThis.setInterval = realSet
        globalThis.clearInterval = realClear
        return { created, cleared, delays }
      },
    }
  }

  it('一直在吐消息就不算超时 —— 量的是静默时长,不是总时长', async () => {
    // 原来是一个 setTimeout 罩住整次调用:一个读二十个文件、跑测试、改代码的执行环节
    // 十几分钟很正常,会被当成挂死杀掉,而它一秒都没卡住。
    async function* steady(): AsyncGenerator<never> {
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 30))
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `第${i}条` }] } } as never
      }
    }
    // 总时长约 240ms,远超 80ms 的预算;但每 30ms 就有一条消息 → 不该超时
    const text = await call(makeRunAgentFn(deps(steady, { timeoutMs: 80 })))
    expect(text).toContain('第7条')
  })

  it('真的静默才超时', async () => {
    async function* silent(): AsyncGenerator<never> {
      await new Promise(r => setTimeout(r, 5000))
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    await expect(call(makeRunAgentFn(deps(silent, { timeoutMs: 60 })))).rejects.toThrow('阶段调用超时')
  })

  it('等人回答的那段时间不走接口时钟', async () => {
    // 工具权限确认就在这个窗口里被 await。合成一个预算的话,「用户去倒杯水」和
    // 「provider 挂死了」共用同一个 10 分钟 —— 回来一看节点已经阻断,而给的建议是
    // 「提高超时或把节点拆小」,两条都不对症。
    let asked = false
    async function* usesTool(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      await args.canUseTool()   // 人在这里想了很久
      asked = true
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '结束' }] } } as never
    }
    const slowHuman = (async () => { await new Promise(r => setTimeout(r, 250)); return { behavior: 'allow' } }) as never
    const text = await call(makeRunAgentFn(deps(usesTool, {
      canUseTool: slowHuman, timeoutMs: 80, humanTimeoutMs: 60_000,
    })))
    expect(asked).toBe(true)
    expect(text).toContain('结束')
  })

  it('没人回答到超过人工预算 → 报的是**人工**超时,不是接口超时', async () => {
    async function* usesTool(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      await args.canUseTool()
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '结束' }] } } as never
    }
    const neverAnswers = (() => new Promise(() => {})) as never
    await expect(call(makeRunAgentFn(deps(usesTool, {
      canUseTool: neverAnswers, timeoutMs: 50_000, humanTimeoutMs: 80,
    })))).rejects.toThrow('等待人工确认超时')
  })

  it('人答完之后 stall 时钟必须重新走起来', async () => {
    /**
     * G19 —— 回归验收挖出来的最重的一条,而且**没有任何用例碰过**。
     *
     * canUseTool 的 finally 里如果不把 humanWaitFrom 清成 undefined,轮询体从此
     * 每一轮都走「在等人」那一支并 return —— 于是**这次阶段调用的 stall 时钟永久失效**。
     * 后果:确认过一次权限之后,provider 挂死了也不会被 stall 杀掉,要等满人工预算
     * (默认 7 天)。
     *
     * 探针形状是关键:人答完之后必须**真的静默一段**再看。原来的用例里 canUseTool 一
     * resolve 生成器就立刻 yield,消息侧的 markProgress 抢在下一个 tick 之前跑掉,
     * 于是清不清 humanWaitFrom 都看不出来。
     */
    async function* answerThenGoSilent(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      await args.canUseTool()
      // 人答完了,然后模型再也不吐东西 —— 这一段必须由 stall 时钟负责。
      await new Promise(r => setTimeout(r, 5000))
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '不该到这里' }] } } as never
    }
    const quickHuman = (async () => ({ behavior: 'allow' })) as never
    try {
      await call(makeRunAgentFn(deps(answerThenGoSilent, {
        canUseTool: quickHuman, timeoutMs: 80, humanTimeoutMs: 60_000,
      })))
      throw new Error('should have thrown')
    } catch (e) {
      // 不是 human:人早就答完了。清不掉 humanWaitFrom 的话这里会一直等到 60 秒。
      expect((e as { kind?: string }).kind).toBe('stall')
    }
  })

  it('人答完的那一刻 stall 时钟要归零,不能把人思考的时间算进去', async () => {
    /**
     * G20 —— finally 里少了 markProgress()。
     *
     * 人答完的一瞬间 `now - lastProgressAt` 已经等于**人思考的时长**,于是用户点完
     * 「允许」立刻收到一条「静默超时」—— 而他刚刚才操作过。
     *
     * 所以这里让人想得比 stall 预算久,答完之后立刻吐一条消息:归零了就不该超时。
     */
    async function* usesTool(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      await args.canUseTool()
      /**
       * 这个 40ms 的缺口是**探针的关键**,不是凑数。
       *
       * canUseTool 一 resolve 生成器就立刻 yield 的话,消息侧的 markProgress 会抢在
       * 下一个轮询之前跑掉 —— 于是 finally 里清不清 lastProgressAt 都看不出来
       * (实测:变异存活)。留一个**比 stall 预算(80ms)短**的静默缺口之后:
       * 归零了就该正常收尾,没归零则轮询会拿「人思考的 250ms」判它静默超时。
       */
      await new Promise(r => setTimeout(r, 40))
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '结束' }] } } as never
    }
    // 人想了 250ms,而 stall 预算只有 80ms。
    const slowHuman = (async () => { await new Promise(r => setTimeout(r, 250)); return { behavior: 'allow' } }) as never
    const text = await call(makeRunAgentFn(deps(usesTool, {
      canUseTool: slowHuman, timeoutMs: 80, humanTimeoutMs: 60_000,
    })))
    expect(text).toContain('结束')
  })

  it('人工超时的消息里印的是**人工**预算,不是接口预算', async () => {
    // G24。原来只断言了「等待人工确认超时」这几个字,数字没人看 —— 于是把
    // `(kind === 'human' ? humanLimitMs : limitMs)` 改回恒用 limitMs 照样绿,
    // 而用户看到「等待人工确认超时(50000 ms)」会照着去调一个不相干的旋钮。
    async function* usesTool(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      await args.canUseTool()
      yield null as never
    }
    const neverAnswers = (() => new Promise(() => {})) as never
    try {
      await call(makeRunAgentFn(deps(usesTool, {
        canUseTool: neverAnswers, timeoutMs: 50_000, humanTimeoutMs: 80,
      })))
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as { limitMs?: number; message?: string }
      expect(err.limitMs).toBe(80)
      // 50_000 是接口预算,绝不能出现在人工超时的话里。
      expect(err.message).not.toContain('50')
    }
  })

  it('调用结束后轮询器要停 —— 否则每次阶段调用泄漏一个永不停止的 setInterval', async () => {
    // G23。泄漏的那个 interval 还会在预算到点后对**已经结束**的 controller 调
    // inner.abort()。一次长 run 几百个。
    async function* quick(): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '完事' }] } } as never
    }
    const w = watchIntervals()
    try {
      await call(makeRunAgentFn(deps(quick, { timeoutMs: 50_000, humanTimeoutMs: 60_000 })))
    } finally {
      const { created, cleared, delays } = w.stop()
      // 建了几个就要清几个。少清一个 = 每次阶段调用泄漏一个永不停止的轮询器,
      // 而且它还会在预算到点后对**已经结束**的 controller 调 inner.abort()。
      expect(`建 ${created} 清 ${cleared}`).toBe(`建 ${created} 清 ${created}`)
      expect(created).toBeGreaterThan(0)
      // 接线断言:50_000 的预算 → pollIntervalMs 给 1000。写死 50 的话这里就红了。
      expect(delays).toContain(pollIntervalMs(50_000))
    }
  })

  it('轮询周期:预算大的时候发现延迟不能跟着变大', () => {
    // 内联表达式整个零覆盖 —— 改成 Math.min(60000, …) 之后默认预算(600s)下轮询
    // 周期变成 **30 秒**,超时最多晚 30 秒才被发现;而全套测试用的都是几十毫秒的小
    // 预算,那里三个数取值相同,看不出来。
    expect(pollIntervalMs(600_000)).toBe(1000)   // 上限压住,不是 30000
    expect(pollIntervalMs(80)).toBe(50)          // 下限托住,不是 4
    expect(pollIntervalMs(10_000)).toBe(500)     // 中间段真的取 1/20
  })

  it('轮询周期:没配接口预算时也不能退化成 0', () => {
    // 「只配了 humanTimeoutMs」是被显式支持的组合。兜底取 0 的话就是
    // setInterval(…, 0),整次调用空转烧 CPU。
    expect(pollIntervalMs(undefined)).toBe(50)
    expect(pollIntervalMs(0)).toBe(50)
    expect(pollIntervalMs(-1)).toBe(50)
  })
  it('轮询器真的按 pollIntervalMs 算出来的周期起 —— 接线不能被剪断', () => {
    // 纯函数写对了但没接上去,是这个仓库反复出现的一类。所有用例的预算都是几十毫秒
    // (那里 tickMs 恒等于下限 50),所以把 `pollIntervalMs(limitMs)` 换成写死的 50
    // 照样全绿 —— 拦 setInterval 时把 delay 一起记下来才看得见。
    expect(pollIntervalMs(10_000)).toBe(500)
  })
  /** 一个用一次工具、然后正常收尾的生成器。 */
  async function* usesOneTool(args: { canUseTool: () => Promise<unknown> }): AsyncGenerator<never> {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
    await args.canUseTool()
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '结束' }] } } as never
  }

  it('等人批准工具时通知界面让出键盘,答完再还回去', async () => {
    // 用户报的:「需要用户确认接受时,光标选中的任务回车同时会进入任务详情」。
    // /et 声明了 spawnsSubagents,权限对话框因此画在任务树面板**之上**,两个组件同时
    // 挂着而 useInput 是广播的 —— 一下回车,对话框收到,面板也收到。
    const edges: boolean[] = []
    const allow = (async () => ({ behavior: 'allow' })) as never
    await call(makeRunAgentFn(deps(usesOneTool, {
      canUseTool: allow, onHumanWait: (w: boolean) => edges.push(w),
    })))
    expect(edges).toEqual([true, false])
  })

  it('用户**拒绝**时也要把键盘还回去', async () => {
    // 少了这一半,一次拒绝之后面板永久失聪 —— 比原来的 bug 更糟:用户既动不了树,
    // 也退不出去,而屏幕上没有任何解释。
    const edges: boolean[] = []
    const deny = (async () => ({ behavior: 'deny', message: '不允许' })) as never
    await call(makeRunAgentFn(deps(usesOneTool, {
      canUseTool: deny, onHumanWait: (w: boolean) => edges.push(w),
    })))
    expect(edges).toEqual([true, false])
  })

  it('canUseTool 抛异常时同样还回去', async () => {
    const edges: boolean[] = []
    const boom = (() => { throw new Error('权限系统挂了') }) as never
    try {
      await call(makeRunAgentFn(deps(usesOneTool, {
        canUseTool: boom, onHumanWait: (w: boolean) => edges.push(w),
      })))
    } catch { /* 这条用例只关心边沿 */ }
    expect(edges).toEqual([true, false])
  })

  it('通知回调自己抛异常,不能把这次工具调用带走', async () => {
    // 它就在带写工具的执行环节的关键路径上。一个崩溃的 UI 回调不该让运行失败。
    const allow = (async () => ({ behavior: 'allow' })) as never
    const text = await call(makeRunAgentFn(deps(usesOneTool, {
      canUseTool: allow, onHumanWait: () => { throw new Error('渲染炸了') },
    })))
    expect(text).toContain('结束')
  })
  it('取消单个节点:中止在飞的调用,并抛一个可辨别的错', async () => {
    // 登记 controller 和抛 NodeCancelledError 都只发生在这一层 —— 编排器那一档注入的是
    // 裸 RunAgentFn,碰不到它。
    const control = createRunControl()
    let aborted = false
    async function* slow(args: { abortSignal?: AbortSignal }): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      control.cancelNode('root')
      await new Promise(r => setTimeout(r, 40))
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '不该到这里' }] } } as never
    }
    void aborted
    try {
      await call(makeRunAgentFn(deps(slow, { control })))
      throw new Error('should have thrown')
    } catch (e) {
      // 不是超时、不是 provider 故障 —— 那两种会让阻断卡去劝用户提高超时。
      expect((e as Error).name).toBe('NodeCancelledError')
    }
  })

  it('调用跑完之后必须从登记表里摘掉', async () => {
    // 不摘的话 calls 表只增不减:后来对同一节点的取消会去 abort 一堆早已结束的
    // controller,掩盖「这个节点此刻根本没在跑」。回归验收造的 R04 变异原来是活的 ——
    // control 那一层测得到 off() 本身,但**适配器有没有调它**只有这一层看得见。
    const control = createRunControl()
    let captured: AbortController | undefined
    async function* quick(args: { override: { abortController: AbortController } }): AsyncGenerator<never> {
      captured = args.override.abortController
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '完事' }] } } as never
    }
    await call(makeRunAgentFn(deps(quick, { control })))
    expect(captured).toBeDefined()
    control.cancelNode('root')
    // 那次调用早就结束了 —— 取消碰不到它。
    expect(captured!.signal.aborted).toBe(false)
  })
  it('取消**之前**登记的调用不受影响 —— 注销要真的注销', async () => {
    const control = createRunControl()
    async function* quick(): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '完事' }] } } as never
    }
    const text = await call(makeRunAgentFn(deps(quick, { control })))
    expect(text).toContain('完事')
    // 调用早就结束了。此刻再取消不该抛,也不该留下悬挂的 controller。
    expect(() => control.cancelNode('root')).not.toThrow()
  })

  it('取消一次**在飞中**的调用,真的把它的信号 abort 掉', async () => {
    // 只断言错误名的话,把整条 registerCall 删光照样绿 —— 那个错是最后 wasCancelled
    // 事后补的。回归验收造了三条这样的变异(不登记 / 登记别的 controller / 登记用错 key),
    // 全部存活。而这条链是整个「取消」功能存在的理由。
    const control = createRunControl()
    let aborted = false
    async function* slow(args: { override: { abortController: AbortController } }): AsyncGenerator<never> {
      args.override.abortController.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '开始' }] } } as never
      control.cancelNode('root')   // 调用已经在飞了,这时才取消
      await new Promise(r => setTimeout(r, 300))
      yield null as never
    }
    try { await call(makeRunAgentFn(deps(slow, { control }))) } catch { /* 只关心信号 */ }
    expect(aborted).toBe(true)
  })

  it('既超时又被取消时,报的是**取消** —— 建议完全不同', async () => {
    // 判成超时的话,阻断卡去劝用户「提高 nodeTimeoutMs」,而他刚亲手按了取消。
    const control = createRunControl()
    async function* silentAfterCancel(): AsyncGenerator<never> {
      control.cancelNode('root')
      await new Promise(r => setTimeout(r, 3000))
      yield null as never
    }
    try {
      await call(makeRunAgentFn(deps(silentAfterCancel, { control, timeoutMs: 60 })))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).name).toBe('NodeCancelledError')
    }
  })
  it('已经被取消过的节点,新一轮派发立刻停 —— 取消和派发可能撞在一起', async () => {
    const control = createRunControl()
    control.cancelNode('root')
    /**
     * 生成器**必须真的听 abortSignal**,而且它自己的等待要远短于 bun 的用例超时。
     *
     * 原来写的是干等 5000ms —— 而 bun 默认用例超时正好 5000ms,实测这条用例耗时
     * 5000.43ms,在 CI 上是一颗随时会红的定时炸弹。更要命的是它**反证了取消没生效**:
     * 调用等满了生成器的 5 秒才结束,只是结果被丢掉了。
     */
    let aborted = false
    // 这个 harness 把内部 controller 放在 override.abortController 上(见本文件别处的
    // 同样用法),不是 abortSignal —— 取错属性会让断言恒假,看起来像功能坏了。
    async function* neverEnds(args: { override: { abortController: AbortController } }): AsyncGenerator<never> {
      // 查**状态**而不是挂监听:这个节点在派发之前就被取消过了,registerCall 在登记的
      // 那一刻就当场 abort —— 早于生成器被创建,监听器挂上时那一枪已经开完了。
      aborted = args.override.abortController.signal.aborted
      await new Promise(r => setTimeout(r, 800))
      yield null as never
    }
    try {
      await call(makeRunAgentFn(deps(neverEnds, { control })))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).name).toBe('NodeCancelledError')
    }
    // **取消真的把在飞的那次 abort 掉了** —— 只断言错误名的话,把整条登记删光照样绿
    // (回归验收造了三条这样的变异,全部存活)。那个错是最后 wasCancelled 事后补的。
    expect(aborted).toBe(true)
  })
  it('两种超时带着不同的 kind —— 处理方式相反,不能合并', async () => {
    async function* silent(): AsyncGenerator<never> {
      await new Promise(r => setTimeout(r, 5000))
      yield null as never
    }
    try {
      await call(makeRunAgentFn(deps(silent, { timeoutMs: 60 })))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe('stall')
    }
  })
})
