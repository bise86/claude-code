import { createHash } from 'node:crypto'

/**
 * 把出网请求**对齐 codex CLI 的形状** —— 让网关那条按请求特征分流的规则认得出来。
 *
 * ## 为什么需要
 *
 * 跑机上的 new-api 有一条「codex cli trace」规则:匹配上的请求才走带前缀缓存的那条渠道。
 * 我们原来发的是 `user-agent: OpenAI/JS 7.5.0` 加一堆 `x-stainless-*`,一条都匹配不上,
 * 于是每一轮都按全价重发 —— 实测同一份 3138 token 前缀连发三次,`cached_tokens` 恒为 0。
 *
 * ## 对齐到什么程度
 *
 * 下面这些是 2026-08-20 用本地捕获服务器从 codex 0.147.0 **实际抓下来的**,不是猜的:
 * 把 codex 指向一个只记请求的本地端点,读它 POST /v1/responses 的头和体。
 *
 * **对齐的是身份面**:请求头 + `prompt_cache_key`。**没有**伪造 `client_metadata` 里
 * `installation_id` 那类东西,也没有跟着改 `parallel_tool_calls`(那个会改模型行为,
 * 和分流无关)。指令、输入、工具本来就是我们自己的,谈不上一致。
 *
 * ## 这些 id 必须跨轮恒定
 *
 * codex 用它自己的会话 uuid。我们这一层是无状态的(每一轮从 anthropic 消息重建整个请求),
 * 手上没有会话对象,所以从**请求前缀**派生:`instructions` 加第一条 input。同一个席位的
 * 同一段对话,这两样逐轮不变,id 就不变;换一个席位或节点就换一个 id。
 *
 * 这正是 `prompt_cache_key` 要的语义 —— 它是缓存路由键,值稳定才有意义。拿 requestId
 * 那种每轮都变的东西去填,等于每轮都告诉上游「这是一段新对话」。
 */

/** codex 的 originator 取值集合里 CLI 那一档。二进制里同时有 codex_exec / codex-tui 等。 */
const ORIGINATOR = 'codex_cli_rs'

/** 抓包里 codex 0.147.0 带的 beta 标记。 */
const BETA_FEATURES = 'remote_compaction_v2'

/** UA 形状照抄 codex。 */
const CODEX_VERSION = '0.147.0'

/** 32 位 hex 切成 uuid 的 8-4-4-4-12 分段。只为长得像,不承诺任何 uuid 语义。 */
function asUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 从**请求前缀**派生一个跨轮恒定的 id。
 *
 * 只取 `instructions` 和第一条 input —— 后面的消息逐轮增长,拿进来的话 id 每轮都变,
 * 而那恰恰是要避免的。加 `salt` 让同一段对话的 session / thread / window 各不相同,
 * 像 codex 那样是几个不同的 id。
 */
export function derivedId(prefix: string, salt: string): string {
  return asUuid(createHash('sha256').update(`${salt} ${prefix}`).digest('hex').slice(0, 32))
}

/** 从已经译好的 responses 请求体里取出前缀 —— 只有它是跨轮稳定的部分。 */
export function bodyPrefixKey(body: { instructions?: unknown; input?: unknown; messages?: unknown }): string {
  // responses:instructions + 第一条 input。
  const ins = typeof body.instructions === 'string' ? body.instructions : ''
  const first = Array.isArray(body.input) && body.input.length > 0 ? JSON.stringify(body.input[0]) : ''
  // chat:系统消息在 messages[0],第一条用户消息在 messages[1]。两种形状共用一个函数,
  // 因为「前缀是哪一段」这个判断只有一处才不会漂。
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const chat = msgs.length > 0 ? `${JSON.stringify(msgs[0])} ${msgs.length > 1 ? JSON.stringify(msgs[1]) : ''}` : ''
  return `${ins} ${first} ${chat}`
}

/**
 * codex 形状的请求头。
 *
 * @param prefix 跨轮稳定的前缀键(见 bodyPrefixKey)
 * @param requestId 这一次调用自己的 id。只有 `x-client-request-id` 用它,其余都要恒定
 */
export function codexHeaders(prefix: string, requestId: string): Record<string, string> {
  const session = derivedId(prefix, 'session')
  const thread = derivedId(prefix, 'thread')
  const turn = derivedId(prefix, `turn:${requestId}`)
  const installation = derivedId(prefix, 'installation')
  const meta = JSON.stringify({
    installation_id: installation,
    session_id: session,
    thread_id: thread,
    turn_id: turn,
    window_id: `${session}:0`,
    request_kind: 'turn',
    thread_source: 'user',
  })
  return {
    originator: ORIGINATOR,
    'session-id': session,
    'thread-id': thread,
    'x-client-request-id': turn,
    'x-codex-window-id': `${session}:0`,
    'x-codex-beta-features': BETA_FEATURES,
    'x-codex-turn-metadata': meta,
    'user-agent': `${ORIGINATOR}/${CODEX_VERSION} (${process.platform}; ${process.arch}) (${ORIGINATOR}; ${CODEX_VERSION})`,
    // accept 不在这里设:调用方已经按「这个请求是不是流式」设过了(roleFetch 里那一行),
    // 而真实流量在这条路上一律是流式,值和 codex 一样。在这里无条件覆盖会把非流式那一档
    // 的既有行为也改掉,而那一档有测试钉着「不相干的头照旧」。
  }
}
