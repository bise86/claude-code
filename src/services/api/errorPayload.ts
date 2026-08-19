import type { APIError } from '@anthropic-ai/sdk'

/**
 * 「上游到底出了什么事」—— **从错误体里读出来,而不是从状态码**。
 *
 * ## 这一层现在服务谁
 *
 * **不再服务「要不要重试」** —— 那个问题已经没有分档了(政策见 `withRetry.shouldRetry`:
 * 所有失败都重试)。留下来是因为**「是不是 529」**仍然是三条岔路的判据,而它们和重试与否
 * 是两件事:
 *
 *  - 连续 529 到了次数就切 `fallbackModel`;
 *  - `CLAUDE_CODE_UNATTENDED_RETRY` 的持久重试只对容量类错误无限等(别的仍然走 maxRetries);
 *  - 退避时报给用户的那一行要写清是「上游报错(529)」还是「(500)」。
 *
 * ## 为什么必须从错误体里读
 *
 * SDK 在**流中途**收到一帧 `event: error` 时,造出来的是这个(`core/streaming.js`):
 *
 *     new APIError(undefined, safeJSON(sse.data) ?? sse.data, undefined, response.headers)
 *
 * 第一个参数是 `undefined` —— **这一类错误没有状态码**,哪怕上游说的就是「我过载了」。
 * 真实跑机上抓到的原话(qianbase-xtp run 001 的 node.md,逐字):
 *
 *     API Error: {"type":"error","error":{"type":"api_error",
 *                 "message":"Our servers are currently overloaded. Please try again later."}}
 *
 * ## 为什么不是按文案匹配
 *
 * 同一个「等一会儿就好」,anthropic 写 `overloaded_error`,OpenAI 系写 `server_error`,
 * 我们自己的翻译层(`openaiCompat/blocks.ts`)写 `api_error`。所以这里做的是**把错误体的
 * type 归一成一个状态码**,新增一种拼写只是往表里加一行,不是再加一条 if。
 */

/**
 * 错误体的 `type` → 拿它当哪个状态码看。
 *
 * 三家的拼写都在这里,而它们说的是同一件事:
 *  - anthropic:`overloaded_error` / `api_error` / `rate_limit_error`;
 *  - OpenAI 及其兼容网关:`server_error` / `internal_error` / `rate_limit_exceeded`;
 *  - 我们自己的翻译层(`openaiCompat/blocks.ts` 的 `w.error()`):写死 `api_error`。
 *
 * 值取的是「等价的 HTTP 状态码」而不是一个自造的枚举:消费者要么问「是不是 529」,
 * 要么把它印在那一行提示上,两者用状态码都比用一个只有这个文件懂的枚举直白。
 *
 * **只映射「上游临时挂了」这一类。** 认不出来 → `undefined`,也就是「这个错误没有等价
 * 状态码」,而不是「不可重试」—— 重试与否已经不问这里了。鉴权类故意不映射:401 在
 * `withRetry` 的循环开头会触发一次 OAuth 刷新,而一帧流中错误值不值得刷 token 是另一件事。
 */
const TRANSIENT_PAYLOAD_STATUS: Readonly<Record<string, number>> = {
  // 容量:等一会儿就好
  overloaded_error: 529,
  overloaded: 529,
  // 服务端自己的错(anthropic 的 api_error 语义就是 500)
  api_error: 500,
  server_error: 500,
  internal_error: 500,
  internal_server_error: 500,
  service_unavailable: 503,
  service_unavailable_error: 503,
  // 网关/中转层
  upstream_error: 502,
  gateway_error: 502,
  bad_gateway: 502,
  // 超时
  timeout_error: 408,
  request_timeout: 408,
  // 限流
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
}

/** 最多往里剥几层 `{ error: { error: … } }`。三层足够覆盖三家的嵌套,又不会被环形结构挂住。 */
const MAX_DEPTH = 3

function knownType(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  return TRANSIENT_PAYLOAD_STATUS[value.toLowerCase()]
}

/**
 * 从已解析的错误体对象里找类型。
 *
 * 逐层看 `type` 和 `code`(有的网关只填 `code`),再往 `.error` 里钻。外层那个
 * `"type":"error"` 是个壳,认不出来是**对的** —— 真正的类型在它里面。
 */
function fromObject(body: unknown, depth = 0): number | undefined {
  if (depth > MAX_DEPTH || body === null || typeof body !== 'object') {
    return undefined
  }
  const o = body as { type?: unknown; code?: unknown; error?: unknown }
  return knownType(o.type) ?? knownType(o.code) ?? fromObject(o.error, depth + 1)
}

/**
 * 从错误**文本**里找类型 —— 兜底,给那些 body 没被解析成对象的路径。
 *
 * 两种情况需要它:SDK 把整个 body `JSON.stringify` 进了 message(`makeMessage` 在
 * 没有顶层 `message` 字段时就是这么干的),以及错误在别处被转成字符串之后才走到这里。
 *
 * 扫**所有**的 `"type"/"code": "…"`,取第一个认得的 —— 不能只取第一个匹配项,
 * 因为 anthropic 的形状第一个是壳上的 `"type":"error"`。
 */
function fromText(text: string): number | undefined {
  for (const m of text.matchAll(/"(?:type|code)"\s*:\s*"([a-zA-Z_]+)"/g)) {
    const status = knownType(m[1])
    if (status !== undefined) return status
  }
  return undefined
}

/**
 * 这个错误的**类型字段**等价于哪个状态码。认不出来 → undefined(调用方沿用旧行为)。
 */
export function transientStatusFromErrorPayload(
  error: unknown,
): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  // `.error` 是 SDK 存下来的原始 body(见 APIError 构造函数)。
  const fromBody = fromObject((error as { error?: unknown }).error)
  if (fromBody !== undefined) return fromBody
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? fromText(message) : undefined
}

/**
 * 这次失败该按哪个状态码处理。
 *
 * 有真状态码就用真的 —— 上游明说 400,它的错误体里写什么都不该翻案。只有在**根本没有**
 * 状态码时(流中途的 SSE error 帧),才回落到错误体里的类型。
 */
export function effectiveErrorStatus(error: APIError): number | undefined {
  return error.status ?? transientStatusFromErrorPayload(error)
}

/**
 * **中止不是失败。**
 *
 * 重试政策是「所有失败都重试」(见 `withRetry.shouldRetry`),这是它唯一的例外 ——
 * 而它本来就不属于「失败」:用户按 Esc、阶段超时闸门开火,走的都是 abort。把中止
 * 当故障重试,等于用户按了停止之后我们又跑十次。`roleFetch` 的 catch 里为同一件事
 * 写过同一条例外。
 *
 * 判据只认**结构**(name / code),不引 SDK 的运行时:`APIUserAbortError` 那一种由
 * `withRetry` 用 `instanceof` 认,它本来就 import 了 SDK。
 *
 * 底层形状:Bun 与 undici 抛的是名字为 `AbortError` 的普通 Error,Node 的
 * `AbortSignal.timeout` 抛 `TimeoutError`,老一些的运行时挂的是 `code: 'ABORT_ERR'` ——
 * 三种都要认,因为一次调用可能被这三条里的任意一条掐掉。
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const e = error as { name?: unknown; code?: unknown }
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    e.code === 'ABORT_ERR'
  )
}
