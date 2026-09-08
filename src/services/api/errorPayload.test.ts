/**
 * **政策:所有失败都重试,一律退避。**
 *
 * 这一档钉的是那条政策本身,以及它唯一的例外(中止)。之前这里是一张按状态码分档的表,
 * 每一档都在回答「这次值不值得再发一次」;它连着三次被同一件事推翻 ——
 *
 *  - 流中途的一帧 `event: error` **没有状态码**(SDK 造的 APIError,status 恒为 undefined),
 *    而上游在那一帧里写的正是 `Please try again later`;
 *  - 传输层的失败连 APIError 都不是(Bun 在流被中途掐断时抛普通 Error);
 *  - 网关把自己的故障写成 400(`Stream must be set to true`、注入了上游不认的参数)。
 *
 * 每一次都是「又发现一种它其实该重试」,而每一次判错的代价都是**一席当场死掉**。所以判据
 * 不再逐类猜:发出去失败了就再发。
 *
 * 探针从**真的两侧**看:错误对象照 SDK 那一行原样构造,判据用真的 `shouldRetry`,
 * 重试用真的 `withRetry` 循环 —— 中间不放替身,否则测的是我自己写的那个假 SDK。
 */
import { describe, expect, it } from 'bun:test'
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import { withContextNoticeSink } from './contextNoticeSink.js'
import {
  effectiveErrorStatus,
  isAbortError,
  transientStatusFromErrorPayload,
} from './errorPayload.js'
import {
  is529Error,
  nextRetryDelay,
  shouldRetry,
  withRetry,
} from './withRetry.js'

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

/** SDK 拿到一个**真的** HTTP 状态码时造出来的东西。 */
function httpError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIError {
  return new APIError(status, body, undefined, new Headers(headers))
}

/**
 * 翻译层(`openaiCompat/roleFetch.ts`)的形状:外层 type 是 `api_error`,网关原文
 * **整段塞在 message 里**。用户报障贴的就是这个形状。
 */
function roleFetch400(upstream: string): APIError {
  return httpError(400, {
    type: 'error',
    error: {
      type: 'api_error',
      message:
        `员工「架构」(openai-responses 协议)调用失败 · POST ` +
        `http://10.10.20.33:3000/v1/responses → 400 Bad Request · 上游原文:${upstream}`,
    },
  })
}

/** 跑真的重试循环,数 operation 被调了几次;抛出来的错原样交给调用方。 */
async function runLoop(
  fail: (attempt: number) => unknown | null,
  opts: { maxRetries: number; querySource?: string } = { maxRetries: 1 },
): Promise<{ attempts: number; yields: number; value: unknown; error: unknown }> {
  let attempts = 0
  // 循环每决定退避一次就 yield 一条系统消息 —— 数它,才分得清「一次都没重试」和
  // 「重试了但 operation 根本没被调到」(闸门在调用之前开火的那些)。
  let yields = 0
  let value: unknown
  let error: unknown
  const gen = withRetry(
    async () => ({}) as Anthropic,
    async () => {
      attempts++
      const e = fail(attempts)
      if (e) throw e
      return '答上来了'
    },
    {
      model: 'claude-opus-5',
      thinkingConfig: { type: 'disabled' },
      maxRetries: opts.maxRetries,
      ...(opts.querySource ? { querySource: opts.querySource as never } : {}),
    },
  )
  try {
    let out = await gen.next()
    while (out.done !== true) {
      yields++
      out = await gen.next()
    }
    value = out.value
  } catch (e) {
    error = e
  }
  return { attempts, yields, value, error }
}

describe('所有失败都重试', () => {
  /**
   * **用户报障的那一个**,逐字。网关(10.10.20.33)自己往请求体里注入了
   * `prompt_cache_retention`,上游不认这个参数 —— 而错误体上写的是
   * `invalid_request_error` + `invalid_parameter`,也就是老判据里「我们的请求本身不合法」
   * 的两条,于是**一次都不重试**,那一席当场死掉。
   *
   * 变异:把 `shouldRetry` 里加回「400 且认得出是确定性错误就返回 false」→ 这条红。
   */
  it('网关注入了上游不认的参数(invalid_parameter)——现在会重试', async () => {
    const e = roleFetch400(
      '{"error":{"message":"prompt_cache_retention is not supported on this model",' +
        '"type":"invalid_request_error","param":"prompt_cache_retention","code":"invalid_parameter"}}',
    )
    expect(e.status).toBe(400) // 前提:它是个真的 400
    expect(shouldRetry(e)).toBe(true)
    const r = await runLoop(a => (a < 2 ? e : null))
    expect(r.value).toBe('答上来了')
    expect(r.attempts).toBe(2)
  }, 30_000)

  /** 提示词超长、模型名写错、工具块对不上 —— 老判据里全是「必死」,现在一样重试。 */
  it('老判据里那四类确定性 400,现在也重试', () => {
    expect(
      shouldRetry(
        httpError(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 250000 tokens > 200000 maximum',
          },
        }),
      ),
    ).toBe(true)
    expect(
      shouldRetry(
        httpError(400, {
          error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' },
        }),
      ),
    ).toBe(true)
    expect(
      shouldRetry(
        httpError(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages.12: `tool_use` ids must be unique',
          },
        }),
      ),
    ).toBe(true)
  })

  /**
   * 服务端明说「别重试」也重试。这一条是政策里最扎眼的一条,单独钉住 ——
   * 变异:把 `x-should-retry: false` 那道老闸加回来 → 这条红。
   */
  it('x-should-retry: false 不再是一票否决', async () => {
    const e = httpError(400, { error: { message: 'nope' } }, { 'x-should-retry': 'false' })
    expect(shouldRetry(e)).toBe(true)
    const r = await runLoop(a => (a < 2 ? e : null))
    expect(r.attempts).toBe(2)
  }, 30_000)

  /**
   * 跑机上 16/20 席死在这一个上:Bun 的 fetch 在**消费响应流**时抛的普通 Error ——
   * 既不是 APIError 也不是 APIConnectionError,老闸写的是「不是 APIError 就一定不重试」。
   */
  it('连 APIError 都不是的传输层失败,也重试', async () => {
    const socketClose = new Error(
      'The socket connection was closed unexpectedly. For more information, ' +
        'pass `verbose: true` in the second argument to fetch()',
    )
    expect(shouldRetry(socketClose)).toBe(true)
    const r = await runLoop(a => (a < 3 ? socketClose : null), { maxRetries: 3 })
    expect(r.value).toBe('答上来了')
    expect(r.attempts).toBe(3)
  }, 30_000)

  /**
   * 「配置错不重试」这条老规矩也没了 —— 网关刚起来的那几秒、DNS 刚生效的那几秒,
   * 长得和「域名打错一个字母」一模一样,而分辨它们要付的代价是一席。
   */
  it('ENOTFOUND / ECONNREFUSED 这类老「配置错」也重试', () => {
    expect(
      shouldRetry(Object.assign(new Error('getaddrinfo ENOTFOUND typo.example'), { code: 'ENOTFOUND' })),
    ).toBe(true)
    expect(
      shouldRetry(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ).toBe(true)
  })

  /** 没有状态码的那一帧(上游自己写着 Please try again later)。 */
  it('流中途的错误帧(没有状态码)会重试', async () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}',
    )
    expect(e.status).toBeUndefined() // 前提:它真的没有状态码
    const r = await runLoop(a => (a < 3 ? e : null), { maxRetries: 3 })
    expect(r.value).toBe('答上来了')
    expect(r.attempts).toBe(3)
  }, 30_000)

  /** 压根不是 JSON 的一帧 —— 认不出类型,照样重试。 */
  it('认不出类型的错误也重试', () => {
    expect(shouldRetry(midStreamError('boom'))).toBe(true)
    expect(shouldRetry(new Error('方案解析失败'))).toBe(true)
  })

  /**
   * 后台来源(标题、摘要、分类器)的 529 以前是**当场丢弃**的,理由是重试放大。
   * 政策统一之后它们也重试 —— 变异:把 `shouldRetry529` 那道闸加回来 → 这条红。
   */
  it('后台来源的 529 不再被当场丢弃', async () => {
    // 529 会走到「连续 529 就切 fallbackModel」那一段,而它要问 isClaudeAISubscriber() ——
    // 单测进程里 config 还没允许访问,那一句会抛 `Config accessed before allowed`。
    // 这个环境变量是那个 || 的**第一个**操作数,置上它就短路在配置之前,而被测的那条
    // 判据(来源名单)在更前面,不受影响。
    const saved = process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
    process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
    try {
      const e = httpError(529, { type: 'error', error: { type: 'overloaded_error' } })
      const r = await runLoop(a => (a < 2 ? e : null), {
        maxRetries: 1,
        // 老名单(FOREGROUND_529_RETRY_SOURCES)里没有的来源
        querySource: 'conversation_title',
      })
      expect(r.attempts).toBe(2)
    } finally {
      if (saved === undefined) delete process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
      else process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = saved
    }
  }, 30_000)
})

describe('重试是有界的', () => {
  /**
   * 「一律重试」不等于「无限重试」:次数仍然由 `maxRetries` 封顶,超了就 `CannotRetryError`。
   * 少了这一条,把上面那些改成死循环也能全绿。
   */
  it('一个永远失败的请求,走满 maxRetries+1 次就报出来', async () => {
    const e = roleFetch400('{"error":{"message":"whatever","code":"invalid_parameter"}}')
    const r = await runLoop(() => e, { maxRetries: 2 })
    expect(r.attempts).toBe(3)
    expect(r.error).toBeDefined()
    expect(String((r.error as Error).message)).toContain('whatever')
  }, 30_000)
})

describe('唯一的例外:中止', () => {
  it('isAbortError 认得三种形状,别的都不认', () => {
    expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(true)
    expect(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(true)
    expect(isAbortError(new Error('The socket connection was closed unexpectedly'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError('AbortError')).toBe(false) // 字符串不是错误对象
  })

  it('shouldRetry 对中止说不 —— SDK 的那一种也算', () => {
    expect(shouldRetry(new APIUserAbortError())).toBe(false)
    expect(shouldRetry(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe(false)
  })

  /**
   * 反向探针,从**真循环**外面看:用户按了 Esc 之后不许再跑十次。
   * 变异:把 `shouldRetry` 里两条中止判据去掉 → 这条会变成 4 次调用。
   */
  it('真循环:中止只调用一次', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const r = await runLoop(() => abort, { maxRetries: 3 })
    expect(r.attempts).toBe(1)
    expect(r.error).toBeDefined()
  }, 30_000)

  /**
   * 另一个例外:`/mock-limits` 造的假限流 —— ant 本地造出来的、根本没出过网的错误对象。
   * 它在循环**开头**就抛,所以真循环里 operation 一次都不该被调到。
   * 变异:把 `isMockRateLimitError` 那条去掉 → 这条会变成 4 次调用(每次都重试那个假错)。
   */
  it('真循环:/mock-limits 的假限流不重试', async () => {
    const savedUser = process.env.USER_TYPE
    const savedMock = process.env.CLAUDE_MOCK_HEADERLESS_429
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_MOCK_HEADERLESS_429 = '假的限流,别重试'
    try {
      const r = await runLoop(() => null, { maxRetries: 3 })
      expect(r.attempts).toBe(0)
      expect(r.error).toBeDefined()
      // **这一条才是判据**:假错在 operation **之前**抛,attempts 恒为 0,重不重试都一样。
      // 每退避一次会 yield 一条系统消息 —— 一条都没有,才证明它当场就结束了。
      expect(r.yields).toBe(0)
    } finally {
      if (savedUser === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = savedUser
      if (savedMock === undefined) delete process.env.CLAUDE_MOCK_HEADERLESS_429
      else process.env.CLAUDE_MOCK_HEADERLESS_429 = savedMock
    }
  }, 30_000)
})

describe('退避曲线', () => {
  it('默认十次重试按指定秒数等待,不加抖动', () => {
    expect(Array.from({ length: 10 }, (_, i) => nextRetryDelay(i + 1))).toEqual([
      3_000, 6_000, 10_000, 15_000, 30_000, 45_000, 60_000, 60_000, 90_000, 90_000,
    ])
  })

  it('超过序列后保持 90s', () => {
    expect(nextRetryDelay(11)).toBe(90_000)
    expect(nextRetryDelay(100)).toBe(90_000)
  })

  /** 服务端说什么时候回来就什么时候回来 —— 在封顶以内的照办。 */
  it('Retry-After 照看', () => {
    expect(nextRetryDelay(1, '5')).toBe(5_000)
    expect(nextRetryDelay(1, '45')).toBe(45_000)
  })

  it('Retry-After 最短也等 3s', () => {
    for (const header of ['-1', '0', '1', '2', '3']) {
      expect(nextRetryDelay(1, header)).toBe(3_000)
    }
  })

  it('Retry-After 再大也夹在 90s', () => {
    expect(nextRetryDelay(1, '18000')).toBe(90_000)
    expect(nextRetryDelay(4, '3600')).toBe(90_000)
    expect(nextRetryDelay(1, '90')).toBe(90_000)
  })

  it('缺失或无效的 Retry-After 使用当前重试级别', () => {
    for (const header of [undefined, null, '', 'invalid']) {
      expect(nextRetryDelay(1, header)).toBe(3_000)
      expect(nextRetryDelay(4, header)).toBe(15_000)
    }
  })
})

/**
 * 判据对了不等于**用户看得见**:`withRetry` yield 出去的那条系统消息只到 QueryEngine ——
 * 子 agent 那条路上看不见它(`createSubagentContext` 对子 agent 写死
 * `addNotification: undefined`)。而一串重试加起来能有数分钟:窗口一动不动,
 * 和「这一席挂死了」长得一模一样。
 */
describe('退避期间席位窗口有话说', () => {
  it('通过 ALS 旁路报一行,子 agent 那条路才看得见', async () => {
    const seen: string[] = []
    await withContextNoticeSink(
      n => {
        if (n.kind === 'api-retry') seen.push(n.text)
      },
      async () => {
        const e = midStreamError(
          '{"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}',
        )
        await runLoop(a => (a < 2 ? e : null), { maxRetries: 2 })
      },
    )
    expect(seen).toHaveLength(1)
    // 三样都要在:哪一类错、等多久、第几次 —— 少一样这一行就只是噪音。
    expect(seen[0]).toContain('500')
    expect(seen[0]).toContain('overloaded')
    expect(seen[0]).toContain('3s 后重试(第 1/2 次)')
  }, 30_000)
})

/**
 * 归一表**不再决定重试与否**,但仍然是三条岔路的判据:切 fallbackModel、持久重试只对
 * 容量类无限等、以及退避那一行上印的状态码。所以它自己那一档留着。
 */
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

  /** OpenAI 系与只填 code 的网关,拼写不同、说的是同一件事。 */
  it('三家的拼写都认得', () => {
    expect(
      transientStatusFromErrorPayload(
        midStreamError('{"error":{"message":"boom","type":"server_error","code":null}}'),
      ),
    ).toBe(500)
    expect(
      transientStatusFromErrorPayload(
        midStreamError('{"error":{"message":"upstream unavailable","code":"service_unavailable"}}'),
      ),
    ).toBe(503)
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
   * `error.type = 'api_error'`,包括那些 4xx。翻成 500 的话,一个 400 会被
   * 持久重试当成容量问题无限等下去。
   */
  it('有真状态码时不被错误体翻案', () => {
    const e = httpError(400, {
      type: 'error',
      error: { type: 'api_error', message: 'bad request' },
    })
    expect(effectiveErrorStatus(e)).toBe(400)
    expect(is529Error(e)).toBe(false)
  })

  /** 鉴权类故意不映射:401 会触发一次 OAuth 刷新,那不该由一帧流中错误发起。 */
  it('鉴权类不归一(但它照样重试)', () => {
    const e = midStreamError(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )
    expect(transientStatusFromErrorPayload(e)).toBeUndefined()
    expect(shouldRetry(e)).toBe(true)
  })
})
