/**
 * 自动压缩的阈值算术 —— **按员工真正的上下文窗口算**。
 *
 * 这一组测试守的是两件事:
 *  1. 200k / 1M 这两档(Claude 自己的模型)算出来的数**一个字节都不能变**;
 *  2. 小窗口(网关模型常见的 32k)不许算出负阈值 —— 负阈值 = 每一轮都压 = 烧钱循环。
 */
import { describe, expect, test } from 'bun:test'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  autoCompactIfNeeded,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  shouldAutoCompact,
} from './autoCompact.js'

const MODEL = 'claude-opus-4-5'

describe('getEffectiveContextWindowSize', () => {
  test('不传 override 时和以前逐字一样(200k - 20k 保留)', () => {
    expect(getEffectiveContextWindowSize(MODEL)).toBe(180_000)
  })

  test('override 直接替换窗口', () => {
    expect(getEffectiveContextWindowSize(MODEL, 1_000_000)).toBe(980_000)
    expect(getEffectiveContextWindowSize(MODEL, 128_000)).toBe(108_000)
  })

  test('小窗口下保留额度按比例夹,不再是固定 20k', () => {
    // 32k 的 20% = 6.4k,而不是 20k(那会把窗口砍掉 62%)
    expect(getEffectiveContextWindowSize(MODEL, 32_000)).toBe(32_000 - 6_400)
    expect(getEffectiveContextWindowSize(MODEL, 8_000)).toBe(8_000 - 1_600)
  })
})

describe('getAutoCompactThreshold', () => {
  test('默认档逐字不变:180k - 13k', () => {
    expect(getAutoCompactThreshold(MODEL)).toBe(180_000 - AUTOCOMPACT_BUFFER_TOKENS)
  })

  test('大窗口下缓冲区仍是固定的 13k;有效窗口小于 130k 时才按比例', () => {
    expect(getAutoCompactThreshold(MODEL, 1_000_000)).toBe(980_000 - AUTOCOMPACT_BUFFER_TOKENS)
    // 128k 窗口 → 有效 108k → 缓冲 min(13k, 10.8k) = 10.8k
    expect(getAutoCompactThreshold(MODEL, 128_000)).toBe(108_000 - 10_800)
  })

  test('小窗口下阈值必须是正的,而且留得下真正的对话', () => {
    for (const w of [8_000, 16_000, 32_000, 64_000, 100_000]) {
      const t = getAutoCompactThreshold(MODEL, w)
      expect(t).toBeGreaterThan(0)
      // 至少留住窗口的一半 —— 低于这个数,压缩会频繁到把工作本身挤掉
      expect(t).toBeGreaterThanOrEqual(w * 0.5)
      // 而且必须真的低于窗口,否则等于没有阈值
      expect(t).toBeLessThan(w)
    }
  })

  test('override 单调:窗口越大阈值越大', () => {
    const ts = [16_000, 32_000, 128_000, 200_000, 1_000_000].map(w =>
      getAutoCompactThreshold(MODEL, w),
    )
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]!)
  })
})

/**
 * 阈值算对了还不够 —— 得有人**把员工的窗口递进来**。
 *
 * 这一组走的是 `shouldAutoCompact` 的真接缝(不是重算一遍阈值):同一份消息、同一个模型,
 * 只有窗口不同,判决就必须不同。少了这一层,`getAutoCompactThreshold` 可以完全正确,而
 * `autoCompactIfNeeded` 那边一个字都没传 —— 症状和从来没做过这个功能一模一样。
 */
describe('shouldAutoCompact 认不认员工自己的窗口', () => {
  /** 一条带 usage 的 assistant 消息 —— token 计数就是从这里读的。 */
  const withUsage = (inputTokens: number): any => [{
    type: 'assistant',
    uuid: 'u1',
    timestamp: new Date(0).toISOString(),
    requestId: 'r1',
    message: {
      id: 'msg_1', role: 'assistant', type: 'message', model: MODEL, content: [{ type: 'text', text: 'x' }],
      stop_reason: null, stop_sequence: null,
      usage: {
        input_tokens: inputTokens, output_tokens: 1,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
  }]

  test('120k 上下文:200k 的窗口不压,32k 的窗口要压', async () => {
    const msgs = withUsage(120_000)
    expect(await shouldAutoCompact(msgs, MODEL)).toBe(false)
    expect(await shouldAutoCompact(msgs, MODEL, undefined, 0, 32_000)).toBe(true)
  })

  test('1M 的窗口下,同一份 120k 上下文照样不压', async () => {
    expect(await shouldAutoCompact(withUsage(120_000), MODEL, undefined, 0, 1_000_000)).toBe(false)
  })
})

/**
 * 最后一段接缝:`autoCompactIfNeeded` 得**从 `options.roleClientConfig` 上把窗口读出来**。
 *
 * 判据是「它有没有动手压」,不是返回值里的某个数:测试环境里没有 API,压缩必然失败,而
 * 「试过并失败」(`consecutiveFailures: 1`)和「压根没试」({wasCompacted:false} 且没有那个字段)
 * 在返回值上是分得开的两件事。这一条挂掉 = 阈值算得再对也没人用它。
 */
describe('autoCompactIfNeeded 从员工配置上读窗口', () => {
  const msgs = (inputTokens: number): any => [{
    type: 'assistant', uuid: 'u1', timestamp: new Date(0).toISOString(), requestId: 'r1',
    message: {
      id: 'm1', role: 'assistant', type: 'message', model: MODEL,
      content: [{ type: 'text', text: 'x' }], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }]
  const ctx = (contextWindow?: number): any => ({
    options: {
      mainLoopModel: MODEL, tools: [],
      roleClientConfig: contextWindow === undefined ? undefined
        : { apiProtocol: 'openai', apiUrl: 'u', apiToken: 't', backendModel: 'gpt', contextWindow },
    },
    abortController: new AbortController(), agentId: 'a1',
    getAppState: () => ({}), setAppState: () => {},
  })

  test('120k 上下文 + 没有员工窗口:不动手(主模型 200k 还装得下)', async () => {
    const r = await autoCompactIfNeeded(msgs(120_000), ctx(), {} as any, undefined, undefined, 0)
    expect(r.wasCompacted).toBe(false)
    expect(r.consecutiveFailures).toBeUndefined()
  })

  test('同一份上下文 + 员工声明 32k:动手了', async () => {
    const r = await autoCompactIfNeeded(msgs(120_000), ctx(32_000), {} as any, undefined, undefined, 0)
    // 测试环境里压不成(没有 API),但**试过**这件事本身就是这条接缝的证据。
    expect(r.consecutiveFailures).toBe(1)
  })
})
