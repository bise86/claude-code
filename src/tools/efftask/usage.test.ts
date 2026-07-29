import { describe, expect, it } from 'bun:test'
import {
  addUsage, createUsageMeter, EMPTY_USAGE, formatTokens, isEmptyUsage,
  sanitizeUsage, subtreeUsage, totalTokens, usageBrief, type UsageNode,
} from './usage.js'
import { createAssistantAPIErrorMessage, createAssistantMessage } from '../../utils/messages.js'
import { makeRunAgentFn } from './runAgentAdapter.js'

/** 一条真实形状的上游 assistant 消息。usage 缺省时补成 message_start 那一刻的样子。 */
function apiMsg(id: string, usage: Partial<Record<string, number>> = {}): unknown {
  return {
    type: 'assistant',
    message: {
      id, model: 'claude-opus-4-6', role: 'assistant', type: 'message',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage,
      },
    },
  }
}

describe('createUsageMeter', () => {
  it('流式下同一次调用被拆成多条消息 —— 那是**一次**调用,不是三次', () => {
    /**
     * claude.ts 在流式路径上为**每个内容块**产一条 AssistantMessage,它们共用一个
     * `message.id`;最终 usage 只被写回**最后一条**(前面几条停在 message_start 那一刻,
     * output_tokens 是 0)。按消息条数计次会把一次带三个块的回答记成三次调用,
     * 而这个数正是用户拿来判断「贵在哪」的东西。
     */
    const m = createUsageMeter()
    m.observe(apiMsg('msg_1', { input_tokens: 1200 }))          // 思考块
    m.observe(apiMsg('msg_1', { input_tokens: 1200 }))          // 文本块
    m.observe(apiMsg('msg_1', { input_tokens: 1200, output_tokens: 340 })) // 收口,带最终 usage
    expect(m.totals()).toEqual({ calls: 1, input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 })
  })

  it('后到的那条恰好是 message_start 那一份时不许倒退', () => {
    // 适配层看到的顺序不由我们保证,所以是逐字段取最大,不是整条替换。
    const m = createUsageMeter()
    m.observe(apiMsg('a', { input_tokens: 10, output_tokens: 900 }))
    m.observe(apiMsg('a', { input_tokens: 10, output_tokens: 0 }))
    expect(m.totals().output).toBe(900)
  })

  it('不同 message.id = 不同的调用,tokens 相加', () => {
    const m = createUsageMeter()
    m.observe(apiMsg('a', { input_tokens: 100, output_tokens: 10 }))
    m.observe(apiMsg('b', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 7 }))
    expect(m.totals()).toEqual({ calls: 2, input: 300, output: 30, cacheRead: 5000, cacheWrite: 7 })
  })

  it('合成消息不算一次调用 —— 否则报错越多「调用次数」涨得越快', () => {
    /**
     * provider 报错走的是 createAssistantAPIErrorMessage,它长得和一条正常回答一模一样
     * (这个仓库为这件事已经付过一次学费,见 providerErrorOf)。它背后**没有**一次上游
     * 请求可以对应,算进去的话用户会照着一个被报错灌水的数字去判断成本。
     */
    const m = createUsageMeter()
    m.observe(createAssistantAPIErrorMessage({ content: 'K3 挂了', error: 'invalid_request' }))
    m.observe(createAssistantMessage({ content: '占位' }))
    expect(m.totals()).toEqual(EMPTY_USAGE)
    expect(isEmptyUsage(m.totals())).toBe(true)
  })

  it('非 assistant 消息、畸形消息都不算,而且**一条都不许抛**', () => {
    // 它跑在模型消息热路径上。一个只负责数数的函数抛出去,会让席位判 infra、重试三桌、
    // 最后把节点阻断,而阻断理由写的是「角色调用失败」—— 指向完全错误的方向。
    const m = createUsageMeter()
    for (const bad of [null, undefined, 42, 'x', [], { type: 'user' }, { type: 'assistant' },
      { type: 'assistant', message: null }, { type: 'assistant', message: { id: 'z' } },
      { type: 'assistant', message: { id: 'z', usage: 'nope' } }]) {
      expect(() => m.observe(bad)).not.toThrow()
    }
    expect(m.totals()).toEqual(EMPTY_USAGE)
  })

  it('id 缺席时各算各的 —— 少报比多报更糟', () => {
    // 合并成一个 id 会把 N 次调用记成 1 次,而用户会照着一个偏小的数去放宽 caps。
    const m = createUsageMeter()
    m.observe({ type: 'assistant', message: { model: 'x', usage: { input_tokens: 5, output_tokens: 1 } } })
    m.observe({ type: 'assistant', message: { model: 'x', usage: { input_tokens: 5, output_tokens: 1 } } })
    expect(m.totals().calls).toBe(2)
  })

  it('负数 / NaN / 字符串 token 一律读成 0', () => {
    const m = createUsageMeter()
    m.observe(apiMsg('a', { input_tokens: -5, output_tokens: NaN }))
    m.observe({ type: 'assistant', message: { id: 'b', model: 'x', usage: { input_tokens: '900' } } })
    expect(totalTokens(m.totals())).toBe(0)
    expect(m.totals().calls).toBe(2)
  })

  it('take() 交增量并推游标 —— 连续两次不会把同一笔记两遍', () => {
    const m = createUsageMeter()
    m.observe(apiMsg('a', { input_tokens: 100, output_tokens: 10 }))
    expect(m.take()).toEqual({ calls: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
    expect(m.take()).toEqual(EMPTY_USAGE)
    m.observe(apiMsg('a', { input_tokens: 100, output_tokens: 50 }))
    // 同一次调用的 usage 长大了:增量只算长出来的那一截,calls 不再加。
    expect(m.take()).toEqual({ calls: 0, input: 0, output: 40, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('subtreeUsage', () => {
  const mk = (id: string, childIds: string[], calls = 1): UsageNode =>
    ({ id, childIds, usage: { calls, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } })

  it('自己 + 整棵子树', () => {
    const nodes = [mk('r', ['a', 'b']), mk('a', ['a1']), mk('a1', []), mk('b', [])]
    const byId = new Map(nodes.map(n => [n.id, n]))
    expect(subtreeUsage(byId.get('r'), id => byId.get(id))).toEqual({ calls: 4, input: 40, output: 4, cacheRead: 0, cacheWrite: 0 })
    expect(subtreeUsage(byId.get('a'), id => byId.get(id)).calls).toBe(2)
    expect(subtreeUsage(byId.get('b'), id => byId.get(id)).calls).toBe(1)
  })

  it('成环时收敛,不吃满栈 —— childIds 是从可手工编辑的 node.md 读回来的', () => {
    // 而这个函数跑在渲染路径上,每秒一次。
    const nodes = [mk('a', ['b']), mk('b', ['a'])]
    const byId = new Map(nodes.map(n => [n.id, n]))
    expect(subtreeUsage(byId.get('a'), id => byId.get(id)).calls).toBe(2)
  })

  it('自指也不挂', () => {
    const n = mk('a', ['a'])
    expect(subtreeUsage(n, () => n).calls).toBe(1)
  })

  it('找不到的子节点跳过,不当 0 也不抛', () => {
    const r = mk('r', ['ghost'])
    expect(subtreeUsage(r, () => undefined).calls).toBe(1)
  })

  it('没有用量的节点合计出空 —— 界面据此决定画不画', () => {
    const r: UsageNode = { id: 'r', childIds: [] }
    expect(isEmptyUsage(subtreeUsage(r, () => undefined))).toBe(true)
  })
})

describe('sanitizeUsage', () => {
  it('盘上的垃圾值一律归零,全零则整个丢掉', () => {
    expect(sanitizeUsage({ calls: NaN, input: -1, output: '5' })).toBeUndefined()
    expect(sanitizeUsage('nope')).toBeUndefined()
    expect(sanitizeUsage(null)).toBeUndefined()
    expect(sanitizeUsage({ calls: 3, input: 1.9 })).toEqual({ calls: 3, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('格式化', () => {
  it('三位数以内给原数,再大给一位小数的 k / M', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(34_500)).toBe('34.5k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    // NaN 会一路上屏成 `NaNk`,而它来自可手工编辑的 node.md。
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
  })

  it('总量把**缓存读写也算进去** —— 长上下文的运行里它常常是大头', () => {
    /**
     * 只加 input+output 的话,一个高度复用上下文的运行会显示成几千 token,而实际打进
     * 上游的是几十万 —— 这个数字的全部用途就是回答「花了多少」,漏掉大头等于没这个数。
     * (计费上便宜是另一回事,所以详情页把两者分行列;总量这一格必须是全量。)
     */
    const u = { calls: 3, input: 1_000, output: 500, cacheRead: 120_000, cacheWrite: 8_000 }
    expect(totalTokens(u)).toBe(129_500)
    expect(usageBrief(u)).toBe('3 次 · 129.5k')
  })

  it('usageBrief 空用量返回空串 —— 由调用方决定画不画,而不是画一个 `0 次 · 0`', () => {
    expect(usageBrief(undefined)).toBe('')
    expect(usageBrief(EMPTY_USAGE)).toBe('')
    expect(usageBrief({ calls: 12, input: 30_000, output: 4_500, cacheRead: 0, cacheWrite: 0 })).toBe('12 次 · 34.5k')
  })

  it('addUsage 对 undefined 两边都成立', () => {
    expect(addUsage(undefined, undefined)).toEqual(EMPTY_USAGE)
    const u = { calls: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }
    expect(addUsage(u, undefined)).toEqual(u)
    expect(addUsage(undefined, u)).toEqual(u)
  })
})

describe('接线:用量记在**节点**上', () => {
  const deps = (impl: unknown) => ({
    toolUseContext: {} as never,
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    availableTools: [] as never,
    readOnlyTools: [] as never,
    activeAgents: [] as never,
    mainModelDefault: { agentType: 'main' } as never,
    runAgentImpl: impl as never,
  })

  it('一次调用之后,node.usage 就是这次的账', async () => {
    async function* fake(): AsyncGenerator<never> {
      yield apiMsg('m1', { input_tokens: 1000 }) as never
      yield apiMsg('m1', { input_tokens: 1000, output_tokens: 200 }) as never
      // 工具循环里的第二个上游回合。
      yield apiMsg('m2', { input_tokens: 1500, output_tokens: 60, cache_read_input_tokens: 9000 }) as never
    }
    const node = { id: 'root', childIds: [] } as never as { id: string; usage?: unknown }
    await makeRunAgentFn(deps(fake))({
      phase: 'plan', node: node as never, role: null,
      system: 's', prompt: 'p', signal: new AbortController().signal,
    })
    expect(node.usage).toEqual({ calls: 2, input: 2500, output: 260, cacheRead: 9000, cacheWrite: 0 })
  })

  it('调用抛出去了,已经花掉的那部分照样记账', async () => {
    // 超时、取消、provider 5xx —— 三条路径上 token 都是真花掉了的。等到收口再补记,
    // 就等于给自己多加一整类要证明的东西。
    async function* boom(): AsyncGenerator<never> {
      yield apiMsg('m1', { input_tokens: 800, output_tokens: 40 }) as never
      throw new Error('上游断了')
    }
    const node = { id: 'root', childIds: [] } as never as { id: string; usage?: unknown }
    await makeRunAgentFn(deps(boom))({
      phase: 'execute', node: node as never, role: null,
      system: 's', prompt: 'p', signal: new AbortController().signal,
    }).catch(() => {})
    expect(node.usage).toEqual({ calls: 1, input: 800, output: 40, cacheRead: 0, cacheWrite: 0 })
  })

  it('多次调用**累加**到同一个节点上 —— 一个节点会被评审、返工、验收各调一遍', async () => {
    async function* one(): AsyncGenerator<never> {
      yield apiMsg(`m${seq++}`, { input_tokens: 100, output_tokens: 10 }) as never
    }
    let seq = 0
    const node = { id: 'root', childIds: [] } as never as { id: string; usage?: { calls: number } }
    const fn = makeRunAgentFn(deps(one))
    for (const phase of ['plan', 'review', 'execute'] as const) {
      await fn({ phase, node: node as never, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })
    }
    expect(node.usage?.calls).toBe(3)
  })
})
