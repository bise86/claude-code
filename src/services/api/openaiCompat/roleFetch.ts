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

/**
 * 上游失败 → 一条 anthropic 形状的错误响应。**状态码原样透传**,好让上层的重试策略照旧。
 *
 * ## 为什么多一个**顶层** `message`
 *
 * 这一条是验收从真链路上量出来的,而它把整个「让报错说人话」的改动几乎清零。
 *
 * SDK 的 `APIError.makeMessage` 是这么写的(`@anthropic-ai/sdk/core/error.js`):
 *
 *     const msg = error?.message ? … : error ? JSON.stringify(error) : message
 *
 * 它读的是**顶层**的 `message`。anthropic 的线上形状里没有这个字段,于是它退到
 * `JSON.stringify(整个 body)` —— 我们精心写的那一句被塞进一个 JSON 壳里:
 *
 *     API Error: 502 {"type":"error","error":{"type":"api_error","message":"员工「…
 *
 * 而详情页「阻断原因」默认只给 3 行预览(掐头留尾),用户看到的第一行是
 * `API Error: 502 {"type":"error","error":{"type":"api_error","message":"员工「` ——
 * **和他最初报障时贴的那一串前 66 个字符逐字相同**。
 *
 * 加上顶层 `message` 之后,同一条路径上出来的是 `API Error: 502 员工「…」…`,3 行预览
 * 里就能读到真正的诊断。这一层不是 anthropic 的线上 API,而是我们自己的适配器,
 * body 的唯一消费者就是 SDK —— 多一个字段是安全的。
 */
function failureResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', message, error: { type: 'api_error', message } }),
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
    /**
     * 流式请求就明说要 SSE。
     *
     * 原来原样透传 SDK 设的 `Accept: application/json` —— 做内容协商的严格网关看到它
     * 完全有理由回一个非流式 JSON,而那正好会撞进下面「200 但不是 SSE」那条硬失败。
     * 我们自己要什么,自己说清楚。
     */
    if ((outBody as { stream?: unknown } | null)?.stream === true) headers.set('accept', 'text/event-stream')
    // 拼好的地址要**留在手上**:它是诊断 502 的第一手材料,而此前它只存在于这一行表达式里。
    const dest = joinRoute(target.toString(), proto.route, PROTOCOL_ROUTES)
    const said = (status: number, statusText: string) =>
      (returnStatus: number, body: string, extra?: { notStreamed?: true; connectFailed?: true; emptyStream?: true }): Response =>
        failureResponse(returnStatus, upstreamFailureMessage({
          roleName: cfg.roleName, protocol: cfg.apiProtocol, url: dest,
          status, statusText, body, ...extra,
        }))
    let res: Response
    try {
      res = await inner(dest, { ...init, method: 'POST', headers, body: JSON.stringify(outBody) })
    } catch (e) {
      /**
       * **连不上**:DNS 打错一个字母、网关宕了、TLS 证书不对、公司代理拦了出网。
       *
       * 这一支以前没有 catch,异常直接穿过整个翻译层 —— `upstreamFailureMessage` 一次
       * 都不会被调用,用户拿到的是引擎的通用兜底「Unable to connect to API. Check your
       * internet connection」:没有员工名、没有协议、没有 URL。而这几种恰恰是 502 之外
       * 最可能的真因,他的网络是好的,于是他会去查网络。
       *
       * **中断要原样抛回去。** 用户按 Esc、或者阶段超时闸门开火,走的都是 abort;
       * 把它翻译成一个 502 会让上层以为是 provider 挂了,而那是用户自己的决定。
       */
      const name = (e as { name?: unknown } | null)?.name
      if (name === 'AbortError' || (init.signal as AbortSignal | undefined)?.aborted === true) throw e
      return said(0, '')(502, e instanceof Error ? `${e.name}: ${e.message}` : String(e), { connectFailed: true })
    }
    /**
     * **返回给上层的状态码**和**上游自己说的状态码**是两回事,不能共用一个数。
     *
     * 上层的重试策略读前者;而报错正文里印的必须是后者 —— 上游 200、我们判定它不是 SSE
     * 之后返回 502,正文写「502 但不是 SSE」就是在编,用户会拿着 502 去找网关日志,
     * 而网关那边记的是一次成功的 200。
     */
    const fail = said(res.status, res.statusText)
    // 上游报错:状态码原样透传,好让上层的重试策略照旧。
    if (!res.ok) return fail(res.status, await res.text().catch(() => ''))
    // 进程内的假 fetch 会给 `null` body;真 socket 永远不会(见下面 bytes === 0 那一条)。
    if (!res.body) return fail(502, '', { notStreamed: true })
    /**
     * 200 但不是 SSE —— 单独一条路径,见 sniffSSE 的注释。
     *
     * 不判的话这条响应会安安静静地解出**零个事件**,用户拿到一次「成功但完全空白」的
     * 回答,而流水线把这个空回答当成这一席的真实产出继续往下走。
     */
    const sniff = await sniffSSE(res.body)
    /**
     * **`bytes === 0` 要单独判**,不能指望 `!res.body`。
     *
     * 评审用真 socket 量过:空体 200、甚至 204,`res.body` 都**不是 null** —— 拿到的是
     * 一个立刻 done 的流。也就是说上面那条 `!res.body` 在真实网络上是死代码,而
     * 「上游 200 却一个字节都没给」正是它本来要挡的东西。
     */
    if (sniff.bytes === 0) return fail(502, '', { emptyStream: true })
    if (!sniff.isSSE) return fail(502, await drainText(sniff.stream), { notStreamed: true })
    const events = proto.toAnthropicEvents(parseSSE(new Response(sniff.stream)), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
