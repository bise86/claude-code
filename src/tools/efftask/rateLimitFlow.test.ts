/**
 * 限流从「上游的一条错误消息」到「整趟 run 慢下来」的完整一条路。
 *
 * 用户的原话:「多角色进行圆桌时,这些是不是并行的。其调用 API 感觉有些问题,会导致报 429
 * 等错误。好好检查下这里的逻辑,会存在什么问题导致调用比较频繁不。」
 *
 * 并行本身是**受同一个全局池约束**的(见 slotPool),没有并发爆炸。真正在「让调用变频繁」
 * 的是限流那一刻的三件事,这个文件按那三件事分三组断言:
 *  1. 认出限流(结构化字段 + 529 的文案兜底);
 *  2. 认出之后**下一次调用先等**(run 级,不是单个席位自己等);
 *  3. 单点调用(分析/执行那六个调用点)以前一次重试都没有,拿到 429 直接把节点判死。
 */
import { describe, expect, it } from 'bun:test'

import { createAssistantAPIErrorMessage } from '../../utils/messages.js'
import { createRunControl } from './control.js'
import { createRateLimitGate } from './rateLimitGate.js'
import {
  makeRunAgentFn, providerErrorInfoOf, ProviderApiError, NodeCancelledError,
} from './runAgentAdapter.js'

const deps = (impl: unknown, over: Record<string, unknown> = {}) => ({
  toolUseContext: {} as never,
  canUseTool: (async () => ({ behavior: 'allow' })) as never,
  availableTools: [] as never,
  readOnlyTools: [] as never,
  activeAgents: [],
  mainModelDefault: { agentType: 'main' } as never,
  runAgentImpl: impl as never,
  ...over,
})
const call = (
  fn: ReturnType<typeof makeRunAgentFn>,
  over: Record<string, unknown> = {},
): Promise<string> => fn({
  phase: 'review', node: { id: 'root' } as never, role: null,
  system: 's', prompt: 'p', signal: new AbortController().signal, ...over,
} as never)

describe('认出「上游在限流」', () => {
  it('429 走**结构化**字段,不是 grep 文案', () => {
    /**
     * `errors.ts` 造那条 assistant 消息时写了 `error: 'rate_limit'`,而
     * `baseCreateAssistantMessage` 把它原样挂在消息上。判字段的好处是那句英文文案
     * (「API Error: Request rejected (429) · …」)怎么改都不影响判据。
     */
    const m = createAssistantAPIErrorMessage({ content: '一句上游自己的中文错误', error: 'rate_limit' })
    expect(providerErrorInfoOf([m])?.kind).toBe('rate_limit')
  })

  it('529 / overloaded 只能认文案 —— 而它必须被认出来', () => {
    /**
     * `getAssistantMessageFromError` 里**没有** 529 分支,它落到最后那个 `error: 'unknown'`
     * 兜底(写 'rate_limit' 的 `categorizeRetryableAPIError` 只服务 SDK 输出通道,
     * 不在 /et 这条路上)。而 529 恰恰是最容易把节点拖长的那一类。
     */
    for (const text of [
      'API Error: 529 {"type":"overloaded_error"}',
      'API Error: Request rejected (429) · capacity',
      'Rate limit reached for this model',
    ]) {
      const m = createAssistantAPIErrorMessage({ content: text, error: 'unknown' })
      expect(providerErrorInfoOf([m])?.kind).toBe('rate_limit')
    }
  })

  it('别的 provider 报错**不是**限流 —— 误判会把一次真故障变成无限退避', () => {
    const m = createAssistantAPIErrorMessage({
      content: "There's an issue with the selected model (K3).", error: 'invalid_request',
    })
    expect(providerErrorInfoOf([m])?.kind).toBeUndefined()
    expect(providerErrorInfoOf([m])?.text).toContain('K3')
  })
})

describe('认出之后:下一次调用先等(run 级)', () => {
  const rateLimited = () => createAssistantAPIErrorMessage({
    content: 'API Error: Request rejected (429)', error: 'rate_limit',
  })

  it('一次 429 之后,**下一次**调用(哪个节点、哪一席都算)先等冷却', async () => {
    const waits: number[] = []
    let t = 0
    const gate = createRateLimitGate({
      now: () => t, random: () => 0,
      sleep: async ms => { waits.push(ms); t += ms },
    })
    async function* fail(): AsyncGenerator<never> { yield rateLimited() as never }
    async function* okRun(): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } } as never
    }
    const failing = makeRunAgentFn(deps(fail, { rateGate: gate }))
    await expect(call(failing)).rejects.toBeInstanceOf(ProviderApiError)
    // 抛出来的错带着分类 —— 调用方靠它决定「退避后重试」还是「当成判决」。
    await call(failing).catch((e: unknown) => {
      expect(e).toBeInstanceOf(ProviderApiError)
      expect((e as ProviderApiError).kind).toBe('rate_limit')
    })
    // 这次换一个**不同节点**的成功调用:它照样要先等 —— 冷却是 run 级的。
    const good = makeRunAgentFn(deps(okRun, { rateGate: gate }))
    expect(await call(good, { node: { id: 'other' } })).toBe('好')
    expect(waits.length).toBeGreaterThan(0)
  })

  it('冷却期间**不许**派出子 agent —— 而且成功一次就把级数清零', async () => {
    let t = 0
    let dispatched = 0
    const order: string[] = []
    const gate = createRateLimitGate({
      now: () => t, random: () => 0,
      sleep: async ms => { order.push(`sleep:${ms}`); t += ms },
    })
    async function* okRun(): AsyncGenerator<never> {
      dispatched++
      order.push('dispatch')
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    gate.noteRateLimit() // 假装上一次调用吃了 429
    await call(makeRunAgentFn(deps(okRun, { rateGate: gate })))
    // 顺序是全部:先睡再派。反过来的话退避一点用都没有。
    expect(order).toEqual(['sleep:2000', 'dispatch'])
    expect(dispatched).toBe(1)
    // 成功 → 级数清零 → 下一次限流从最短的冷却重新起步。
    expect(gate.noteRateLimit()).toBe(2_000)
  })

  it('冷却中被 abort:一秒不等,而且**不派**子 agent', async () => {
    /**
     * 这一条是**功能性**的。等待排在「已经 abort 就早退」那一句**之前**,理由是:
     * 一个已经 aborted 的 signal 不会再派发 abort 事件,`relay` 永不执行、`inner` 永不
     * abort —— 于是 60 秒之后我们照样派出一个真的、带写工具的子 agent。
     */
    let dispatched = 0
    const gate = createRateLimitGate({ now: () => 0, random: () => 0, sleep: async () => {} })
    gate.noteRateLimit()
    async function* okRun(): AsyncGenerator<never> {
      dispatched++
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    const ac = new AbortController()
    ac.abort()
    const fn = makeRunAgentFn(deps(okRun, { rateGate: gate }))
    expect(await fn({
      phase: 'review', node: { id: 'root' } as never, role: null,
      system: 's', prompt: 'p', signal: ac.signal,
    } as never)).toBe('')
    expect(dispatched).toBe(0)
  })

  it('冷却中按 x 取消单个节点:立刻停,不等满 60 秒', async () => {
    /**
     * `registerCall` 在等待**之后**才发生,而 `cancelNode` 只 abort 已登记的 controller ——
     * 不给闸门这条早退,用户按下 x 之后屏幕上那个节点会继续显示「运行中」直到冷却结束。
     */
    const control = createRunControl()
    control.cancelNode('root')
    let dispatched = 0
    const gate = createRateLimitGate({ now: () => 0, random: () => 0, sleep: async () => { throw new Error('不该睡') } })
    gate.noteRateLimit()
    async function* okRun(): AsyncGenerator<never> {
      dispatched++
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    await expect(call(makeRunAgentFn(deps(okRun, { rateGate: gate, control }))))
      .rejects.toBeInstanceOf(NodeCancelledError)
    expect(dispatched).toBe(0)
  })

  it('冷却**不**算进静默时钟 —— 一次正常退避不许被判成挂死', async () => {
    /**
     * `caps.nodeTimeoutMs` 量的是「静默时长」,而计时器在等待之后才起跑。搞反的话:
     * 一个 2 秒的退避在一个 1 秒静默预算的节点上会直接以「阶段调用超时」阻断,
     * 而给的建议是「提高 nodeTimeoutMs 或把节点拆小」——两条都不对症。
     */
    let t = 0
    const gate = createRateLimitGate({ now: () => t, random: () => 0, sleep: async ms => { t += ms } })
    gate.noteRateLimit()
    async function* okRun(): AsyncGenerator<never> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    // 静默预算 60ms,而冷却是 2000ms(假时钟里瞬间过去,真时钟里也一样:计时器还没建)。
    expect(await call(makeRunAgentFn(deps(okRun, { rateGate: gate, timeoutMs: 60 })))).toBe('x')
  })

  it('不注入闸门:行为与这个功能不存在时逐字相同', async () => {
    async function* fail(): AsyncGenerator<never> { yield rateLimited() as never }
    await expect(call(makeRunAgentFn(deps(fail)))).rejects.toBeInstanceOf(ProviderApiError)
  })

  it('等待过程中按 Esc:sleep 被打断,而且**不派**子 agent', async () => {
    /**
     * 和上面那条「已经 abort」不是同一条路:那一条被 `wait` 开头的早退接住,**压根不进
     * sleep**。这一条进了 sleep 才 abort —— 走的是默认 sleep 里那个
     * `addEventListener('abort', done)`,而它此前零覆盖。剪断它的后果是级数爬到 6 级时
     * 「用户按了 Esc,屏幕不动 60 秒」。
     *
     * 用**真时钟**跑:假 sleep 测不出这条(它根本不听 signal)。
     */
    const gate = createRateLimitGate() // 真 now / 真 sleep
    gate.noteRateLimit() // 2s 冷却
    let dispatched = 0
    async function* okRun(): AsyncGenerator<never> {
      dispatched++
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as never
    }
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 80)
    const text = await makeRunAgentFn(deps(okRun, { rateGate: gate }))({
      phase: 'review', node: { id: 'root' } as never, role: null,
      system: 's', prompt: 'p', signal: ac.signal,
    } as never)
    const waited = Date.now() - started
    expect(text).toBe('')
    expect(dispatched).toBe(0)
    // 2000ms 的冷却在 80ms 就被打断了。给足余量,但必须远小于 2s。
    expect(waited).toBeLessThan(1_000)
  })
})

describe('额度用尽 ≠ 限流', () => {
  /**
   * `errors.ts` 把 `error: 'rate_limit'` **同时**用在四种情况上,其中三种等待毫无意义:
   * 订阅额度用尽(`resets 3pm`,最长几小时)、1M 上下文要 `/extra-usage`、以及
   * Opus→Sonnet 回落那条哑消息。只按字段判的后果是这次改动的**净负面**:
   * 上游自己说 resets 3pm,我们在后面贴一句「等几分钟再 --resume」,而且每个调用点
   * 先白花 3 次调用 + 6 秒退避 —— 改动前是 1 次调用后立刻阻断。
   */
  const quotaMsg = (text: string) => createAssistantAPIErrorMessage({ content: text, error: 'rate_limit' })

  it('三种「等没有用」的都判成 quota,不是 rate_limit', () => {
    for (const text of [
      "Claude AI usage limit reached: You've hit your session limit · resets 3pm",
      'API Error: Extra usage is required for 1M context · run /extra-usage to enable',
      'No response requested.',
    ]) {
      expect(providerErrorInfoOf([quotaMsg(text)])?.kind).toBe('quota')
    }
  })

  it('quota **不记在闸门上**、也不退避', async () => {
    let noted = 0
    const gate = createRateLimitGate({ now: () => 0, random: () => 0, sleep: async () => { noted++ } })
    async function* fail(): AsyncGenerator<never> {
      yield quotaMsg("You've hit your session limit · resets 3pm") as never
    }
    await call(makeRunAgentFn(deps(fail, { rateGate: gate }))).catch((e: unknown) => {
      expect((e as ProviderApiError).kind).toBe('quota')
    })
    // 没有冷却窗口 → 下一次调用不等。
    expect(gate.cooldownMs()).toBe(0)
    expect(noted).toBe(0)
  })
})
