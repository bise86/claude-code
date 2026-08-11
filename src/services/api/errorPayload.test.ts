/**
 * 流中途的一帧 `event: error` **没有状态码**,而它此前意味着「一次都不重试」。
 *
 * 这一档钉的是真实跑机(qianbase-xtp run 001)上的事故。node.md 里逐字抄下来的是:
 *
 *     API Error: {"type":"error","error":{"type":"api_error",
 *                 "message":"Our servers are currently overloaded. Please try again later."}}
 *
 * 上游自己写着 **Please try again later**,而 `shouldRetry` 在
 * `if (!error.status) return false` 那一行把它判成不可重试 —— 因为 SDK 对流中错误帧造出来
 * 的 APIError,status 恒为 `undefined`(`core/streaming.js`)。日志里能看见代价:
 * 「补验收点那次调用未完成」(该节点从此没有验收判据)、「自动解决冲突未能完成」×3。
 *
 * 探针从**真的两侧**看:错误对象照 SDK 那一行原样构造(`new APIError(undefined, 解析后的
 * body, undefined, headers)`),判据用真的 `shouldRetry` —— 中间不放替身,否则这条测试
 * 测的是我自己写的那个假 SDK。
 */
import { describe, expect, it } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { withContextNoticeSink } from './contextNoticeSink.js'
import {
  effectiveErrorStatus,
  isRetryableTransportError,
  transientStatusFromErrorPayload,
} from './errorPayload.js'
import { is529Error, shouldRetry, withRetry } from './withRetry.js'

/** SDK 在流中途收到 `event: error` 时做的事,逐行照抄 `@anthropic-ai/sdk/core/streaming.js`。 */
function midStreamError(data: string): APIError {
  let body: unknown
  try {
    body = JSON.parse(data)
  } catch {
    body = data
  }
  return new APIError(undefined, body, undefined, new Headers())
}

describe('没有状态码的上游错误', () => {
  /**
   * 主判据。变异:把 `shouldRetry` 里的 `effectiveErrorStatus(error)` 换回
   * `error.status` → 这条红。
   */
  it('跑机实测的那一帧(api_error · overloaded)现在会重试', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}',
    )
    expect(e.status).toBeUndefined() // 前提:它真的没有状态码
    expect(shouldRetry(e)).toBe(true)
  })

  /**
   * 用户最初报障时贴的那一串(另一家网关,另一段文案,同一个形状)。
   * 两条一起在,是为了说明判据认的是**类型字段**,不是某一句文案。
   */
  it('另一家网关的同型错误(help.openai.com 那一串)也重试', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"api_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 33a70f5f in your message."}}',
    )
    expect(shouldRetry(e)).toBe(true)
  })

  /** OpenAI 自己的形状:没有外层壳,类型写在 `error.type` 上。 */
  it('OpenAI 形状的 server_error 也重试', () => {
    const e = midStreamError(
      '{"error":{"message":"The server had an error while processing your request.","type":"server_error","code":null}}',
    )
    expect(shouldRetry(e)).toBe(true)
  })

  /** 有的网关只填 `code`,不填 `type`。 */
  it('只写 code 的网关也认得出来', () => {
    const e = midStreamError(
      '{"error":{"message":"upstream unavailable","code":"service_unavailable"}}',
    )
    expect(shouldRetry(e)).toBe(true)
  })

  /**
   * **反向探针**:这个改动只放行「上游临时挂了」,不是把所有无状态码的错误都变成可重试。
   * 少了它,把 `transientStatusFromErrorPayload` 写成「恒返回 500」也能让上面四条全绿。
   */
  it('请求体写错(invalid_request_error)仍然不重试', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
    )
    expect(shouldRetry(e)).toBe(false)
  })

  it('鉴权失败仍然不重试(它不该由一帧流中错误去刷 token)', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )
    expect(shouldRetry(e)).toBe(false)
  })

  it('压根不是 JSON 的一帧,行为不变(不重试)', () => {
    expect(shouldRetry(midStreamError('boom'))).toBe(false)
  })
})

/**
 * 判据对了不等于**真的重试了**:`shouldRetry` 只是重试循环里的一个 if。这一档从
 * `withRetry` 这个真的循环外面看 —— 它是整条链路上唯一的重试实现(claude.ts 建客户端时
 * 写死 `maxRetries: 0`,「Disabled auto-retry in favor of manual implementation」)。
 */
describe('真的重试循环', () => {
  it('流中错误帧连着两次之后,第三次拿到答案', async () => {
    let attempts = 0
    const gen = withRetry(
      async () => ({}) as Anthropic,
      async () => {
        attempts++
        if (attempts < 3) {
          throw midStreamError(
            '{"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}',
          )
        }
        return '答上来了'
      },
      {
        model: 'claude-opus-5',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 3,
      },
    )
    // 生成器 yield 的是「正在重试」的系统消息,返回值才是结果。
    let out = await gen.next()
    while (out.done !== true) out = await gen.next()
    expect(out.value).toBe('答上来了')
    expect(attempts).toBe(3)
  }, 30_000)

  /**
   * **退避期间席位窗口必须有话说。**
   *
   * `withRetry` yield 出去的那条系统消息只到 QueryEngine —— 子 agent 那条路上看不见它
   * (`createSubagentContext` 对子 agent 写死 `addNotification: undefined`)。而一串重试
   * 加起来能有两分半:窗口一动不动,和「这一席挂死了」长得一模一样。
   */
  it('退避时通过 ALS 旁路报一行,子 agent 那条路才看得见', async () => {
    const seen: string[] = []
    let attempts = 0
    await withContextNoticeSink(
      n => {
        if (n.kind === 'api-retry') seen.push(n.text)
      },
      async () => {
        const gen = withRetry(
          async () => ({}) as Anthropic,
          async () => {
            attempts++
            if (attempts < 2) {
              throw midStreamError(
                '{"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}',
              )
            }
            return 'ok'
          },
          {
            model: 'claude-opus-5',
            thinkingConfig: { type: 'disabled' },
            maxRetries: 2,
          },
        )
        let out = await gen.next()
        while (out.done !== true) out = await gen.next()
      },
    )
    expect(seen).toHaveLength(1)
    // 三样都要在:哪一类错、等多久、第几次 —— 少一样这一行就只是噪音。
    expect(seen[0]).toContain('500')
    expect(seen[0]).toContain('overloaded')
    expect(seen[0]).toContain('后重试(第 1/2 次)')
  }, 30_000)
})

describe('归一成状态码', () => {
  it('overloaded_error → 529,并且 is529Error 认得(回落模型那条路要用)', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    )
    expect(transientStatusFromErrorPayload(e)).toBe(529)
    expect(is529Error(e)).toBe(true)
  })

  /**
   * 外层那个 `"type":"error"` 是壳,不能被当成类型。它是**第一个**匹配到的 type ——
   * 只取第一个匹配项的实现会在这里退化成「认不出来」。
   */
  it('外层的 "type":"error" 壳不干扰内层判定', () => {
    expect(
      transientStatusFromErrorPayload(
        midStreamError('{"type":"error","error":{"type":"api_error"}}'),
      ),
    ).toBe(500)
  })

  /** body 没被解析成对象时(SDK 把整段 JSON 塞进了 message),文本兜底要接住。 */
  it('只有文本时也能认出来', () => {
    const e = new APIError(
      undefined,
      undefined,
      '{"type":"error","error":{"type":"api_error","message":"nope"}}',
      new Headers(),
    )
    expect(transientStatusFromErrorPayload(e)).toBe(500)
  })

  /**
   * **真状态码优先**:上游明说 400 的时候,它错误体里写什么都不该翻案 ——
   * 我们自己的翻译层(roleFetch 的 failureResponse)对**任何**上游失败都写
   * `error.type = 'api_error'`,包括那些 4xx。
   */
  it('有真状态码时不被错误体翻案', () => {
    const e = new APIError(
      400,
      { type: 'error', error: { type: 'api_error', message: 'bad request' } },
      undefined,
      new Headers(),
    )
    expect(effectiveErrorStatus(e)).toBe(400)
    expect(shouldRetry(e)).toBe(false)
  })
})

/**
 * **同一个洞低一层:传输层的错连 APIError 都不是。**
 *
 * 上面那一档治的是「有错误体、没状态码」。跑机(qianbase-xtp run 001)在那之后的日志里,
 * **每一个**杀掉席位的错误都换成了这一类,16/20 逐字是
 *
 *     角色调用失败: API Error: The socket connection was closed unexpectedly.
 *     For more information, pass `verbose: true` in the second argument to fetch()
 *
 * 那是 Bun 的 fetch 在**消费响应流**时抛的普通 Error —— SDK 只包装 `fetch()` 本身抛出的
 * 异常,流是后来才炸的,所以既不是 APIError 也不是 APIConnectionError。而 `withRetry`
 * 那道闸写的是「不是 APIError 就一定不重试」。
 */
describe('传输层失败(连 APIError 都不是的那一类)', () => {
  /** Bun 在流被中途掐断时抛的那一个,逐字。 */
  const bunSocketClose = (): Error =>
    new Error(
      'The socket connection was closed unexpectedly. For more information, ' +
      'pass `verbose: true` in the second argument to fetch()',
    )

  it('跑机上那 16 次:socket 被掐断,现在算可重试', () => {
    expect(isRetryableTransportError(bunSocketClose())).toBe(true)
  })

  it('按错误码认(ECONNRESET / undici 的超时)', () => {
    expect(isRetryableTransportError(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableTransportError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true)
  })

  /**
   * **最常见的形状:外层文本太笼统,真因挂在 `cause` 上。**
   *
   * 外层**故意不用** `fetch failed` —— 那一句本身就在文本表里,拿它做输入的话
   * 第一层就返回 true,`cause` 那条递归一次都不执行。第一版探针就是这么写的,
   * 变异测试当场证明:剪掉整条 `cause` 递归,22 条测试一条不红。
   */
  it('穿透 cause:外层文本不匹配,真因在 cause 上(ECONNRESET)', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const outer = Object.assign(new Error('request to http://10.10.20.9/v1 did not complete'), { cause: inner })
    expect(isRetryableTransportError(outer)).toBe(true)
    // 反证外层自己不算数,这条测的确实是递归。
    expect(isRetryableTransportError(new Error('request to http://10.10.20.9/v1 did not complete'))).toBe(false)
  })

  /** undici 真实的形状。它靠外层文本就能认出来 —— 记在这里免得有人以为上一条多余。 */
  it('undici 的 TypeError: fetch failed 靠外层文本就认得', () => {
    expect(isRetryableTransportError(new TypeError('fetch failed'))).toBe(true)
  })

  it('cause 成环也不挂(深度有界)', () => {
    const a = new Error('outer') as Error & { cause?: unknown }
    const b = new Error('inner') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(isRetryableTransportError(a)).toBe(false)
  })

  /**
   * **中止不是传输故障。** 用户按 Esc、阶段超时闸门开火,底层长得和「连接断了」一模一样;
   * 当成故障重试 = 用户按了停止之后又跑十次。`roleFetch` 的 catch 里为同一件事写过同一条例外。
   */
  it('AbortError 不重试,哪怕它同时长着一句 socket 文本', () => {
    expect(isRetryableTransportError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe(false)
    const aborted = Object.assign(bunSocketClose(), { name: 'AbortError' })
    expect(isRetryableTransportError(aborted)).toBe(false)
  })

  /**
   * **配置错不重试。** 域名打错一个字母、网关没起 —— 重试十次只是把一句能看懂的报错
   * 换成五分钟之后的同一句。和归一表那边「认不出来的一律沿用旧行为」同源。
   */
  it('ENOTFOUND / ECONNREFUSED 仍然当场失败', () => {
    expect(isRetryableTransportError(Object.assign(new Error('getaddrinfo ENOTFOUND typo.example'), { code: 'ENOTFOUND' }))).toBe(false)
    expect(isRetryableTransportError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false)
  })

  it('普通的业务异常不受影响', () => {
    expect(isRetryableTransportError(new Error('方案解析失败'))).toBe(false)
    expect(isRetryableTransportError(null)).toBe(false)
    expect(isRetryableTransportError('socket connection was closed')).toBe(false) // 字符串不是错误对象
  })

  /**
   * 从**真的** `withRetry` 循环外面看。这一条才是用户报的那件事:
   * 修之前它在第一次就 `CannotRetryError`,那一席当场死掉。
   *
   * 变异:把闸上的 `!transport &&` 删掉 → 这条红。
   */
  it('真循环:socket 断两次,第三次拿到答案', async () => {
    let attempts = 0
    const gen = withRetry(
      async () => ({}) as Anthropic,
      async () => {
        attempts++
        if (attempts < 3) throw bunSocketClose()
        return '答上来了'
      },
      { model: 'claude-opus-5', thinkingConfig: { type: 'disabled' }, maxRetries: 3 },
    )
    let out = await gen.next()
    while (out.done !== true) out = await gen.next()
    expect(out.value).toBe('答上来了')
    expect(attempts).toBe(3)
  }, 30_000)

  /** 反向:中止在真循环里**一次都不重试**(否则 Esc 会变成十次调用)。 */
  it('真循环:AbortError 当场结束,只调用一次', async () => {
    let attempts = 0
    const gen = withRetry(
      async () => ({}) as Anthropic,
      async () => {
        attempts++
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      },
      { model: 'claude-opus-5', thinkingConfig: { type: 'disabled' }, maxRetries: 3 },
    )
    await (async () => {
      try {
        let out = await gen.next()
        while (out.done !== true) out = await gen.next()
      } catch { /* CannotRetryError —— 正是要的 */ }
    })()
    expect(attempts).toBe(1)
  }, 30_000)
})
