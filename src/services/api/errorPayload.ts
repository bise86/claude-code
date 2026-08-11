import type { APIError } from '@anthropic-ai/sdk'

/**
 * 「上游到底出了什么事」—— **从错误体里读出来,而不是从状态码**。
 *
 * ## 为什么需要这一层
 *
 * SDK 在**流中途**收到一帧 `event: error` 时,造出来的是这个(`core/streaming.js`):
 *
 *     new APIError(undefined, safeJSON(sse.data) ?? sse.data, undefined, response.headers)
 *
 * 第一个参数是 `undefined` —— 也就是说**这一类错误没有状态码**,哪怕上游说的就是
 * 「我过载了,等会儿再来」。而 `withRetry.shouldRetry` 的最后一道判据是
 * `if (!error.status) return false`:于是这一整类错误**一次都不重试**,当场把这次调用
 * (以及 `/et` 里的那一席)判死。
 *
 * 真实跑机上抓到的原话(qianbase-xtp run 001 的 node.md,逐字):
 *
 *     API Error: {"type":"error","error":{"type":"api_error",
 *                 "message":"Our servers are currently overloaded. Please try again later."}}
 *
 * 上游自己写着 **Please try again later**,而我们的重试逻辑连一次都没试。后果在日志里
 * 看得见:「补验收点那次调用未完成」→ 这个节点从此没有验收判据;「自动解决冲突未能完成」
 * ×3 → 合并阻断。
 *
 * ## 为什么不是再加一个字符串判据
 *
 * `withRetry` 里原本已经有一条 `error.message?.includes('"type":"overloaded_error"')` ——
 * 那就是**上一次**用 case-by-case 的方式打的同一个补丁,它只认 anthropic 官方那一种拼写。
 * 第三方网关(以及我们自己的 openai 翻译层 `openaiCompat/blocks.ts`)发的是 `api_error`,
 * OpenAI 系发的是 `server_error`,于是同一个「等一会儿就好」的故障,换个拼写就必死。
 *
 * 所以这里做的是**把错误体的 type 归一成一个状态码**,让 `shouldRetry` 后面那一整套按
 * 状态码写的判据原样复用 —— 新增一种拼写只是往表里加一行,不是再加一条 if。
 *
 * ## 为什么只映射「可重试」的那几种
 *
 * 认不出来 → `undefined` → 沿用今天的行为(不重试)。把 `authentication_error` 也映射成
 * 401 是很诱人的(判据现成),但 401 在 `withRetry` 里会**触发一次 OAuth 刷新**,而一个
 * 流中途的鉴权错误值不值得刷 token 是另一件事 —— 这个改动只负责一件事:
 * **上游说它自己临时挂了的时候,我们要重试。**
 */

/**
 * 错误体的 `type` → 拿它当哪个状态码看。
 *
 * 三家的拼写都在这里,而它们说的是同一件事:
 *  - anthropic:`overloaded_error` / `api_error` / `rate_limit_error`;
 *  - OpenAI 及其兼容网关:`server_error` / `internal_error` / `rate_limit_exceeded`;
 *  - 我们自己的翻译层(`openaiCompat/blocks.ts` 的 `w.error()`):写死 `api_error`。
 *
 * 值取的是「等价的 HTTP 状态码」而不是一个自造的枚举,因为消费者(`shouldRetry`)后面
 * 那三十行判据全是按状态码写的:408 重试、429 看订阅、>=500 重试。归一到状态码之后,
 * 这一层不需要重复任何一条策略,也不会和它们分叉。
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
  // 限流。映射成 429 而不是直接「可重试」:订阅账号的 429 该不该重试是
  // `shouldRetry` 自己的政策(它要看 isClaudeAISubscriber),这一层不替它决定。
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
 * **传输层的失败** —— 连接在请求或流的中途断了,而错误对象里既没有状态码也没有错误体。
 *
 * 跑机实测(qianbase-xtp run 001):这一趟**每一个**杀掉席位的错误都是这一类,
 * 16/20 逐字是
 *
 *     角色调用失败: API Error: The socket connection was closed unexpectedly.
 *     For more information, pass `verbose: true` in the second argument to fetch()
 *
 * 后果和上面那一整段治的是同一种:验收席死掉 → 整轮 FAIL、「补验收点那次调用未完成」→
 * 该节点从此没有验收判据。
 *
 * 病根和 `transientStatusFromErrorPayload` 也是同一个,只是**低一层**:
 * `withRetry` 的闸写的是 `!(error instanceof APIError) || !shouldRetry(error)`,而 Bun 的
 * fetch 在流被中途掐断时抛的是一个**普通 Error**(消息就是上面那一句),既不是 APIError
 * 也不是 SDK 的 APIConnectionError —— SDK 只包装 `fetch()` 调用本身抛出的异常,
 * 而这一类是在**消费响应流**的时候才炸的,那时候 SDK 早就把响应交出去了。
 * 于是「连接断了」这一整类 —— 教科书上最该重试的那一类 —— 我们一次都不重试。
 *
 * 判据按**错误码优先、文本兜底**:
 *  - `code`/`errno`:Node 与 undici 都带,是最硬的判据;
 *  - 文本:Bun 的 socket 消息不带 code,undici 的 `terminated`/`fetch failed` 也不带。
 *
 * **`ENOTFOUND` / `ECONNREFUSED` 不在表里**,尽管它们也是「网络错」:域名打错一个字母、
 * 端口写错、网关没起 —— 那是配置错,重试十次只是把「一句能看懂的报错」换成
 * 「五分钟之后的同一句报错」。这一条和归一表那边「认不出来的一律沿用旧行为」同源:
 * 只放行**真的会自己好**的那些。
 *
 * **中止不算**。用户按 Esc、阶段超时闸门开火,走的都是 abort,而 abort 在底层
 * 长得和「连接断了」一模一样。把它当传输故障重试,等于用户按了停止之后又跑十次 ——
 * `roleFetch` 的 catch 里为同一件事写过同一条例外。
 */
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET',      // 对端在中途关掉了连接 —— 最常见的那一个
  'EPIPE',           // 我们还在写,对端已经关了
  'ETIMEDOUT',       // 连接/读取超时
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'EAI_AGAIN',       // DNS 的**临时**失败(区别于 ENOTFOUND 的「查无此名」)
  'UND_ERR_SOCKET',  // undici:socket 挂了
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** 不带 code 的那些,只能按文本认。全部小写比较。 */
const RETRYABLE_TRANSPORT_TEXT = [
  'socket connection was closed', // Bun:流被中途掐断(跑机上 16/20 就是它)
  'socket hang up',
  'connection closed',
  'other side closed',
  'connection reset',
  'network error',
  'fetch failed',                 // undici 的通用包装
  'terminated',                   // undici:流在中途结束
  'premature close',
]

/** 中止**不是**传输故障 —— 那是用户或超时闸门的决定。 */
function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const e = error as { name?: unknown; code?: unknown }
  return e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'ABORT_ERR'
}

/**
 * 这次失败是不是「连接断了,再来一次多半就好」。
 *
 * `cause` 也要看:undici/Bun 把真因挂在 `cause` 上而外层只留一句 `fetch failed`。
 * 只看一层的话,最常见的那个形状(`TypeError: fetch failed` ← `ECONNRESET`)
 * 会因为外层文本太笼统而**恰好**被放过 —— 而它正是要治的那一个。
 */
export function isRetryableTransportError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 3) return false
  if (isAbort(error)) return false
  const e = error as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown }
  for (const c of [e.code, e.errno]) {
    if (typeof c === 'string' && RETRYABLE_TRANSPORT_CODES.has(c)) return true
  }
  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase()
    if (RETRYABLE_TRANSPORT_TEXT.some(t => m.includes(t))) return true
  }
  // 深度有界:`cause` 成环是真实存在的(有些库把外层挂回去),而这个函数在每一次
  // 失败的重试判断上都会被调到。
  return isRetryableTransportError(e.cause, depth + 1)
}
