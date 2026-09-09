import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { proxyRouteNote, registerDirectHosts } from '../../../utils/lanDirect.js'
import { estimateBodyTokens } from '../tokenEstimate.js'
import { RetrySession, currentRetrySession, setRetrySessionFactory } from '../retrySession.js'
import { anthropicEventsToSSE } from './blocks.js'
import { PROTOCOL_ROUTES, TRANSLATING_PROTOCOLS } from './protocols.js'
import { bodyPrefixKey, codexHeaders } from './codexIdentity.js'
import { buildOpenAIClient, framesWithErrorFrame, isSdkAbort, peekFrames, sdkFailure } from './sdkTransport.js'
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
/**
 * 这个进程里第几次翻译响应。见签发 request-id 那一段。
 *
 * 计数器 + 随机段,而不是纯随机:同一次运行里的顺序读得出来(排查时有用),
 * 而随机段保证跨进程/跨 run 不撞 —— 用量表是按这个 id 去重的,撞一次就少记一次调用。
 */
let requestSeq = 0
// runAgent 为每次子 agent 调用复制配置;同一员工的后续工具轮次沿用已换过的标识。
// WeakMap 不延长配置的生命,也不把随机标识写入 settings。
const sessionIdentities = new WeakMap<RoleClientConfig, { nonce?: string }>()
function mintRequestId(): string {
  requestSeq += 1
  return `req_role_${requestSeq}_${Math.random().toString(36).slice(2, 10)}`
}

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
function failureResponse(status: number, message: string, upstreamHeaders?: Headers): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  // 错误体会重写,但上游要求的冷却时间必须交给 withRetry,否则 429 会过早重发。
  const retryAfter = upstreamHeaders?.get('retry-after')
  if (retryAfter !== null && retryAfter !== undefined) headers.set('retry-after', retryAfter)
  return new Response(
    JSON.stringify({ type: 'error', message, error: { type: 'api_error', message } }),
    { status, headers },
  )
}

/**
 * 「这条 fetch **只走流式**」的标记。
 *
 * 翻译分支上的每一步都假定回来的是 SSE:`sniffSSE` 判不是 SSE 就 502,
 * `toAnthropicEvents` 吃的是帧,返回的响应写死 `content-type: text/event-stream`。
 * 也就是说**非流式请求在这条路上没有一个能走通的结局** —— 严格网关直接 400
 * (`Stream must be set to true`,而 `toResponsesRequest`/`toOpenAIRequest` 在
 * `body.stream` 缺席时确实不发这个字段),宽容网关回一个非流式 JSON,我们这边同样判失败。
 *
 * 而引擎在流式失败后会**静默地**把同一轮改成非流式重发一次(claude.ts 的非流式回退)。
 * 于是一次本可重试的流中断,变成一个**不可重试**的 400:那一席当场死掉,已经跑了上百条
 * 消息的对话全部作废,而屏幕上那句 400 还在建议用户「先查 model 写得对不对」。
 * 用 Symbol.for 而不是普通属性:跨模块实例安全,且不会撞上 fetch 上任何真实字段。
 */
const STREAM_ONLY = Symbol.for('claude-code.roleFetch.streamOnly')

/** 这条 fetch 是不是「只走流式」的翻译层。非函数、普通 fetch 一律 false。 */
export function isStreamOnlyFetch(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as Record<symbol, unknown>)[STREAM_ONLY] === true
}

export function buildRoleFetch(cfg: RoleClientConfig, inner: typeof fetch = fetch): typeof fetch {
  const rotateSession = cfg.rotateSessionOnRetry === true && cfg.apiProtocol !== 'anthropic'
  let identity = sessionIdentities.get(cfg)
  if (rotateSession && !identity) {
    identity = {}
    sessionIdentities.set(cfg, identity)
  }
  const target = new URL(cfg.apiUrl)
  /**
   * 内网端点在**这里**再登记一次直连(见 utils/lanDirect)。
   *
   * 主登记点在配置载入那一侧(rolesFromSettings),这一处是纵深防御:员工配置不止一条
   * 来路(测试、SDK 调用方、以后新增的来源都可能直接造一个 RoleClientConfig),而漏登记的
   * 后果不是「少一点优化」,是这个员工在有全局代理的机器上**一次都连不通**。
   *
   * 放在构造期而不是请求期:构造只发生一次,请求发生几百次,而 `NO_PROXY` 是进程级的。
   */
  registerDirectHosts([cfg.apiUrl])
  const roleFetch = (async (url: any, init: any = {}) => {
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
      const res = await inner(dest.toString(), { ...init, headers })
      /**
       * **上游没给 `request-id` 就补一个。**
       *
       * 这条分支是原样转发,不翻译 —— 但用量表按 request-id 去重,而第三方 anthropic 兼容
       * 网关基本不回这个头。缺了它:SDK 的 `streamRequestId` 是 undefined → `reportApiUsage`
       * 直接丢弃 → **子 agent 内部的自动压缩在这一档完全看不见**,而那正是那条旁路存在的
       * 唯一理由。评审点名的就是这个缺口。
       *
       * 只补、不覆盖:上游给了的话那是它自己的追踪 id,比我们编的有用得多(用户拿它去
       * 找网关日志)。
       *
       * 复制一层响应而不是原地改:`Response.headers` 在多数运行时上是不可变的。
       * body 是流,`new Response(res.body, …)` 直接转交,不额外缓冲。
       */
      if (res.headers.get('request-id')) return res
      const withId = new Headers(res.headers)
      withId.set('request-id', mintRequestId())
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: withId })
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
    /**
     * **request-id 提前签,codex 形状的头两条路共用。**
     *
     * 原来 requestId 是在 raw 档嗅完 SSE 之后才签的;现在它还要参与 `x-client-request-id`,
     * 得在发请求之前就有。响应头那一侧的用法一个字没变(见下面签发那段的注释)。
     *
     * 头本身的理由见 codexIdentity 的文件头:跑机上的网关按请求特征分流,SDK 默认那套
     * `user-agent: OpenAI/JS` + `x-stainless-*` 一条都匹配不上。
     */
    const requestId = mintRequestId()
    const retrySession = currentRetrySession()
    const codexHdrs = codexHeaders(bodyPrefixKey(outBody as any), requestId,
      rotateSession ? (retrySession ? retrySession.nonce : identity?.nonce) : undefined)
    for (const [k, v] of Object.entries(codexHdrs)) headers.set(k, v)
    // 拼好的地址要**留在手上**:它是诊断 502 的第一手材料,而此前它只存在于这一行表达式里。
    const dest = joinRoute(target.toString(), proto.route, PROTOCOL_ROUTES)
    const said = (status: number, statusText: string, upstreamHeaders?: Headers) =>
      (returnStatus: number, body: string, extra?: { notStreamed?: true; connectFailed?: true; emptyStream?: true }): Response =>
        failureResponse(returnStatus, upstreamFailureMessage({
          roleName: cfg.roleName, protocol: cfg.apiProtocol, url: dest,
          status, statusText, body,
          // 「走的代理还是直连」现算,不在构造期算一次:`NO_PROXY` 是进程级的,而一次
          // run 里另一个员工的登记会改变这个答案 —— 印一个过期的判断比不印更糟。
          route: proxyRouteNote(dest),
          transport: cfg.transport,
          ...extra,
        }), upstreamHeaders)
    /**
     * **sdk 档在这里分叉** —— 帧来自官方客户端,别的一切照旧(见 sdkTransport 的文件头)。
     *
     * 分叉点选在这里,是为了让**所有**已经算好的东西都被两条路共用:请求体(`outBody`)、
     * 诊断闭包(`said`,连 `dest` 和代理路线都在里面)、下面那段重新编码和 request-id。
     * 两条传输的差异因此被压到只剩「帧从哪来」这一件事,而那正是对拍测试要钉的东西。
     *
     * sniffSSE / 空流 / 200-不是-SSE 那三条判断不在这条路上:SDK 自己会因为响应不是 SSE
     * 而抛错,那条异常经 `sdkFailure` 走进**同一句**诊断文案。少掉的不是判断,是判断的位置。
     */
    if (cfg.transport === 'sdk') {
      const abortSignal = init.signal as AbortSignal | undefined
      /**
       * 非流式请求在这条路上没有能走通的结局(见 STREAM_ONLY 的注释),而 sdk 档更糟:
       * `create()` 不带 stream 时返回的是一个**普通对象**,`for await` 它要么抛 TypeError、
       * 要么什么都不产出 —— 两种都会变成「成功但空白」。在发出去之前就说清楚。
       */
      if ((outBody as { stream?: unknown } | null)?.stream !== true) {
        return said(0, '')(502, '(本地判定:这条路只走流式,请求没有发出)', { notStreamed: true })
      }
      /**
       * **盯住上游那条原始响应** —— sdk 档补回 raw 档 `sniffSSE` 的那两条判断靠它。
       *
       * 只在「不是 SSE」时才 clone:clone 会把整条响应缓冲一份,而正常那条是几百 KB 的
       * 流式正文,复制一份纯属白烧内存。判失败的那些体都是小 JSON,拷了不心疼。
       */
      const upstreamSeen: { status?: number; headers?: Headers; contentType?: string | null; text?: () => Promise<string> } = {}
      const spy = (async (u: any, i: any) => {
        const r = await inner(u, i)
        upstreamSeen.status = r.status
        upstreamSeen.headers = r.headers
        upstreamSeen.contentType = r.headers.get('content-type')
        if (r.ok && !(upstreamSeen.contentType ?? '').includes('text/event-stream')) {
          const copy = r.clone()
          upstreamSeen.text = () => copy.text().catch(() => '')
        }
        return r
      }) as typeof fetch
      let stream: AsyncIterable<any>
      try {
        stream = await proto.sdkStream(
          // accept 在这条分支上显式给:sdk 档不经过我们那套 headers(SDK 自己拼头,
          // 默认发 application/json),而上面那道闸已经保证了这里一定是流式请求。
          buildOpenAIClient(cfg, PROTOCOL_ROUTES, spy, { ...codexHdrs, accept: 'text/event-stream' }),
          outBody,
          abortSignal,
        )
      } catch (e) {
        // 中止原样抛 —— 和下面 raw 档 catch 里那条判据同因,判法见 isSdkAbort。
        if (isSdkAbort(e, abortSignal)) throw e
        const f = sdkFailure(e)
        return said(f.status, '', upstreamSeen.headers)(
          f.status > 0 ? f.status : 502,
          f.body,
          f.connectFailed ? { connectFailed: true } : undefined,
        )
      }
      /**
       * **一帧都没有 = 上游什么都没给**,和 raw 档那两条判断等价(见 peekFrames)。
       *
       * 验收实测:上游回 200 的 JSON、或者 200 空体时,SDK **不抛错**,只是零帧 —— 于是
       * 这一席交出一次「成功但完全空白」的回答,而流水线会把它当成真实产出继续往下走。
       * 分两档报,措辞和 raw 档逐字对齐:不是 SSE 的那档要把上游原文带上,它是诊断的第一手材料。
       */
      const peeked = await peekFrames(stream)
      if (peeked.empty) {
        const notSSE = !(upstreamSeen.contentType ?? '').includes('text/event-stream')
        return said(upstreamSeen.status ?? 0, '', upstreamSeen.headers)(
          502,
          notSSE && upstreamSeen.text ? await upstreamSeen.text() : '',
          notSSE ? { notStreamed: true } : { emptyStream: true },
        )
      }
      const events = proto.toAnthropicEvents(framesWithErrorFrame(peeked.frames, abortSignal), {
        anthropicModel: anthropicBody.model,
        requestId,
        estimatedInput: () => estimateBodyTokens(outBody),
      })
      return new Response(anthropicEventsToSSE(events), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'request-id': requestId },
      })
    }
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
    const fail = said(res.status, res.statusText, res.headers)
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
    /**
     * 给这次响应**签一个 request-id**。
     *
     * SDK 从 `request-id` 响应头里读它(`api-promise.js`:`response.headers.get('request-id')`),
     * 一路挂到每条 assistant 消息上。第三方网关基本不给这个头,于是 `/et` 这边所有员工调用的
     * requestId 都是 undefined —— 而**用量按请求去重**要靠它:没有 id 就只能退回按
     * `message.id` 去重,而 OpenAI 兼容后端恰恰是最容易缺 id 的一档。
     *
     * 它同时是「这次的用量是估出来的」这条信息的唯一载体(见 tokenEstimate 的注释)。
     *
     * 用 `req_` 前缀 + 计数器 + 随机段:不与上游的 id 空间冲突,同进程内唯一,肉眼可辨来源。
     */
    const events = proto.toAnthropicEvents(parseSSE(new Response(sniff.stream)), {
      anthropicModel: anthropicBody.model,
      requestId,
      // 输入侧的估算只有这一层算得出来 —— 翻译层手上只有响应帧,没有请求体。
      // 惰性:上游给了真 usage 时这个函数一次都不会被调(见 StreamCtx.estimatedInput)。
      estimatedInput: () => estimateBodyTokens(outBody),
    })
    return new Response(anthropicEventsToSSE(events), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': requestId },
    })
  }) as typeof fetch
  /**
   * 只有**翻译**分支只走流式。`anthropic` 是原样转发,非流式请求在那条路上一切正常
   * (它连 body 都不看),打上标记反而会白白关掉一条真能救场的回退。
   */
  if (cfg.apiProtocol !== 'anthropic') {
    Object.defineProperty(roleFetch, STREAM_ONLY, { value: true })
  }
  if (rotateSession && identity) {
    const savedIdentity = identity
    setRetrySessionFactory(roleFetch, () => new RetrySession(savedIdentity.nonce, nonce => {
      savedIdentity.nonce = nonce
    }))
  }
  return roleFetch
}
