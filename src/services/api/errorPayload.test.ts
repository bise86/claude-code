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
