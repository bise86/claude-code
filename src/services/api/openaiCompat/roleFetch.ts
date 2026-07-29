import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { anthropicEventsToSSE } from './blocks.js'
import { PROTOCOL_ROUTES, TRANSLATING_PROTOCOLS } from './protocols.js'
import { drainText, joinRoute, parseSSE, sniffSSE } from './sse.js'
import { upstreamFailureMessage } from './upstreamError.js'

/**
 * 翻译层要**摘掉**的请求头。
 *
 * 它们描述的是 Anthropic 的 SDK,不是这一次出网的请求:`anthropic-version` /
 * `anthropic-beta` 对 OpenAI 系端点毫无意义(而 `anthropic-beta` 常常是好几百字节的
 * 一长串特性名),`x-stainless-*` 是 SDK 的遥测,`x-api-key` 是另一套鉴权 ——
 * 这条路径上鉴权走 `Authorization: Bearer`,留着它等于把 token 多发一份到一个
 * 根本不会用它的头里。
 *
 * 严格一点的网关会对陌生头直接 4xx/502,而那种 502 是**空体**的 —— 也就是用户报的
 * 那一句「Bad Gateway」,什么线索都没有。
 */
function scrubAnthropicHeaders(headers: Headers): void {
  // 先快照再删:一边迭代一边 delete 在 Headers 上是未定义行为。
  for (const key of [...headers.keys()]) {
    if (key.startsWith('anthropic-') || key.startsWith('x-stainless-') || key === 'x-api-key' || key === 'x-app') {
      headers.delete(key)
    }
  }
}

/** 上游失败 → 一条 anthropic 形状的错误响应。**状态码原样透传**,好让上层的重试策略照旧。 */
function failureResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

export function buildRoleFetch(cfg: RoleClientConfig, inner: typeof fetch = fetch): typeof fetch {
  const target = new URL(cfg.apiUrl)
  return (async (url: any, init: any = {}) => {
    // Normalize via the WHATWG Headers API (case-insensitive) so we don't
    // silently drop SDK-set headers passed as a `Headers` instance — spreading
    // a `Headers` instance (`{ ...init.headers }`) yields `{}`, since its
    // entries live behind iterators/symbols rather than own enumerable props.
    const headers = new Headers(init.headers as HeadersInit)
    headers.delete('authorization')

    if (cfg.apiProtocol === 'anthropic') {
      headers.set('x-api-key', cfg.apiToken)
      const orig = new URL(String(url))
      // Concatenate apiUrl's own path (e.g. `/anthropic`) with the incoming
      // request's path — `new URL(orig.pathname, target)` would instead
      // *replace* target's path per WHATWG absolute-path resolution, dropping
      // any prefix apiUrl carries (e.g. MiniMax's documented `/anthropic`).
      //
      // 但只能拼**API 自己那一段**(`/v1/...`),不能拼整个 orig.pathname:orig 是 SDK
      // 按**会话自己的** baseURL 拼出来的完整路径。用户把 ANTHROPIC_BASE_URL 指到同一个
      // 第三方厂商(带路径,比如 https://vendor.example.com/anthropic)时,两段路径会**叠加**:
      //   会话 base /anthropic + 员工 apiUrl /coding → /coding/anthropic/v1/messages → 404
      // 而 404 会被 errors.ts 统一翻译成「模型有问题(K3)」—— 一路把人往改模型名上带。
      // 「只写 env 时一切正常、一加 roles[] 就炸」正是这个叠加造成的。
      // 叠加有**两个**方向,都要堵:
      //  (a) 会话侧:orig 是 SDK 按会话自己的 baseURL 拼出来的完整路径,带路径的
      //      ANTHROPIC_BASE_URL 会把自己那一段塞进来 → 只取 API 自己的 `/v1/...`;
      //  (b) 员工侧:apiUrl 本身就以 `/v1` 结尾(docs/roles-setup.md 里 openai 的例子
      //      正是这么写的,而文档没有一句说 anthropic 的不能这么写)→ 剥掉它。
      // 实测:员工 apiUrl = https://my-proxy.example.com/v1 时,只堵 (a) 仍然拼成
      // /v1/v1/messages,上游明写 `path /v1/v1/messages not found`,而 errors.ts 把这个
      // 404 翻译成「模型有问题(K3)」—— 一路把人往改模型名上带。
      const v1 = orig.pathname.indexOf('/v1/')
      const apiSuffix = v1 >= 0 ? orig.pathname.slice(v1) : orig.pathname
      const base = target.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
      const dest = new URL(base + apiSuffix + orig.search, target.origin)
      return inner(dest.toString(), { ...init, headers })
    }

    /**
     * 要翻译的协议。**查表**,不是 if 链 —— 新增一种 OpenAI 系方言时这个文件一行不动。
     *
     * 认不出来的协议名走 openai(chat/completions)兜底:配置那一侧的 zod enum 已经
     * 挡住了写错的值,能到这里的只有「表里新加了名字但忘了加表项」这一种内部不一致,
     * 而那时候退化成最常见的方言,比抛一个用户看不懂的异常要好。
     */
    const proto = TRANSLATING_PROTOCOLS[cfg.apiProtocol] ?? TRANSLATING_PROTOCOLS.openai!
    scrubAnthropicHeaders(headers)
    headers.set('authorization', `Bearer ${cfg.apiToken}`)
    headers.set('content-type', 'application/json')
    const anthropicBody = JSON.parse(init.body as string)
    const outBody = proto.buildBody(anthropicBody, cfg)
    // 拼好的地址要**留在手上**:它是诊断 502 的第一手材料,而此前它只存在于这一行表达式里。
    const dest = joinRoute(target.toString(), proto.route, PROTOCOL_ROUTES)
    const res = await inner(dest, { ...init, method: 'POST', headers, body: JSON.stringify(outBody) })
    /**
     * **返回给上层的状态码**和**上游自己说的状态码**是两回事,不能共用一个数。
     *
     * 上层的重试策略读前者;而报错正文里印的必须是后者 —— 上游 200、我们判定它不是 SSE
     * 之后返回 502,正文写「502 但不是 SSE」就是在编,用户会拿着 502 去找网关日志,
     * 而网关那边记的是一次成功的 200。
     */
    const fail = (returnStatus: number, body: string, notStreamed?: true): Response =>
      failureResponse(returnStatus, upstreamFailureMessage({
        roleName: cfg.roleName, protocol: cfg.apiProtocol, url: dest,
        status: res.status, statusText: res.statusText, body, notStreamed,
      }))
    // 上游报错:状态码原样透传,好让上层的重试策略照旧。
    if (!res.ok) return fail(res.status, await res.text().catch(() => ''))
    // 2xx 但根本没有 body —— 和「不是 SSE」是同一件事的极端形态,走同一条解释。
    if (!res.body) return fail(502, '', true)
    /**
     * 200 但不是 SSE —— 单独一条路径,见 sniffSSE 的注释。
     *
     * 不判的话这条响应会安安静静地解出**零个事件**,用户拿到一次「成功但完全空白」的
     * 回答,而流水线把这个空回答当成这一席的真实产出继续往下走。
     */
    const sniff = await sniffSSE(res.body)
    if (!sniff.isSSE) return fail(502, await drainText(sniff.stream), true)
    const events = proto.toAnthropicEvents(parseSSE(new Response(sniff.stream)), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
