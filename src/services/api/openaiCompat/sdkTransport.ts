/**
 * **sdk 档的帧来源** —— 用官方 `openai` 客户端发请求,产出的帧喂给和 raw 档**同一个**翻译器。
 *
 * ## 这一层只负责一件事
 *
 * 两条传输的分工是刻意切得很窄的:
 *
 *   raw : fetch → sniffSSE → parseSSE  ┐
 *                                       ├→ proto.toAnthropicEvents → anthropicEventsToSSE → Response
 *   sdk : client.*.create(stream) ──────┘
 *
 * 也就是说 **SDK 只替换「帧从哪来」**。请求体的构造(`toResponsesRequest` / `toOpenAIRequest`)、
 * 事件翻译(`fromResponsesStream` / `fromOpenAIStream`)、重新编码、诊断文案、request-id 补发、
 * 用量估算兜底 —— 全部共享。各写一份就等着漂移,而这两条路的差异必须小到能对拍。
 *
 * 能这么切是因为 SDK 的流事件对象**就是线上的那个 JSON**(`{type:'response.output_text.delta', …}`),
 * 只是带上了类型。翻译器读的是 `f.type` / `f.item` / `f.response?.usage` 这些字段,不关心它是
 * 我们自己 `JSON.parse` 出来的还是 SDK 解出来的。
 *
 * ## 为什么 `maxRetries: 0`
 *
 * 重试策略在这个仓库里是一条**明确的产品决定**:所有 API 错误都重试(`withRetry.ts` 的
 * `shouldRetry`),10 次、0.5s 起翻倍到 32s 带抖动、`Retry-After` 有硬封顶、529 特判。
 * SDK 默认是 `maxRetries: 2` 且**按状态码分档**(400 它不重试)。两套叠起来是乘法,
 * 而且退避曲线会错乱:SDK 自己先退两次,我们这边只记了第一次。
 *
 * 所以这一层**不重试**,把整件事留在 withRetry 一处。中途断流同理:SDK 的请求级重试
 * 本来也管不到它,那是 `midStreamRetry` 的地盘。
 *
 * ## 为什么把 `fetch` 传进去
 *
 * 内网直连(`NO_PROXY` 登记)、头清洗、连接失败的分类诊断都挂在调用方给的那个 fetch 上。
 * 不传的话 SDK 用自己的出网路径,一台开着 `HTTPS_PROXY` 的机器上,指向局域网的员工端点
 * **一次都连不通** —— 而 Bun 上代理这块是单向陷阱(见 utils/lanDirect 的文件头),
 * 出了问题也不是改回来就好。
 */
import OpenAI, { APIError, APIUserAbortError } from 'openai'

/**
 * 一次 sdk 档调用失败时,要交给 `upstreamFailureMessage` 的那两样东西。
 *
 * 状态码原样透传,理由和 raw 档逐字相同:上层的重试策略读它。SDK 在**连不上**时抛的是
 * `APIConnectionError`(`status` 为 undefined),那一档按 0 处理 —— 和 raw 档 catch 到
 * 网络异常时的口径对齐。
 */
export type SdkFailure = { status: number; body: string; connectFailed: boolean }

/**
 * 这个异常是不是「用户/闸门主动中止」—— 是的话**原样抛**,不能翻译成上游故障。
 *
 * 三条判据缺一不可,验收实测过为什么:openai 的 `APIUserAbortError` 的 `name` 打印出来是
 * `Error`(它没有显式设 name),只看 name 会漏;而它又 `instanceof APIError`,漏掉之后会被
 * `sdkFailure` 当成 status 0 的「连不上」翻译成一条 502 —— 用户按下 Esc,屏幕上说 provider 挂了。
 */
export function isSdkAbort(e: unknown, signal?: AbortSignal): boolean {
  if (e instanceof APIUserAbortError) return true
  if ((e as { name?: unknown } | null)?.name === 'AbortError') return true
  return signal?.aborted === true
}

/** SDK 抛出来的东西 → 和 raw 档同一套诊断需要的字段。中止不在这里处理(调用方原样抛)。 */
export function sdkFailure(e: unknown): SdkFailure {
  if (e instanceof APIError) {
    const status = typeof e.status === 'number' ? e.status : 0
    // `e.error` 是上游的原始错误体,比 SDK 拼的 message 更接近网关日志里那一条。
    const raw = e.error === undefined ? undefined : JSON.stringify(e.error)
    return { status, body: raw ?? e.message, connectFailed: status === 0 }
  }
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return { status: 0, body: msg, connectFailed: true }
}

/**
 * 单次请求的超时。
 *
 * SDK 默认 10 分钟,而一个开着 xhigh 的推理模型在一次工具轮里想久一点是正常的 ——
 * 超时在这条路上不是「慢」,是**整席位当场失败**(这个 fork 里一次静默超时就把节点判死,
 * 而人手上唯一的恢复动作是再跑一遍)。往长了给,真卡死了有阶段闸门兜。
 */
const SDK_TIMEOUT_MS = 30 * 60 * 1000

/**
 * baseURL 要的是**不带路由段**的地址。
 *
 * 用户的 `apiUrl` 常常是从厂商文档上整条复制下来的(`https://host/v1/responses`),而 SDK
 * 自己会拼 `/responses`。不剥的话拼成 `/v1/responses/responses`,网关对这种路径回的
 * 常常是一个空体 502 —— 和 raw 档 `joinRoute` 要解决的是同一件事,所以共用同一张路由表。
 */
export function sdkBaseURL(apiUrl: string, knownRoutes: readonly string[]): string {
  const u = new URL(apiUrl)
  let path = u.pathname.replace(/\/+$/, '')
  for (const r of [...knownRoutes].sort((a, b) => b.length - a.length)) {
    if (path.endsWith(`/${r}`)) {
      path = path.slice(0, -(r.length + 1))
      break
    }
  }
  u.pathname = path
  return u.toString().replace(/\/+$/, '')
}

/**
 * 把 SDK 自己那套遥测头**关掉**。
 *
 * `x-stainless-*` 是 stainless 生成器给每个官方 SDK 加的客户端指纹(语言、运行时、
 * 版本、重试次数)。它们不参与鉴权也不参与缓存,但**会参与网关的分流规则** —— 跑机上
 * 那条 codex cli trace 规则要看请求特征,而带着一串 `x-stainless-*` 的请求一眼就不是 codex。
 *
 * openai-node 的约定是:`defaultHeaders` 里把某个头设成 `null` 就**不发**它(不是发空串)。
 * 逐个列出来而不是通配:SDK 加了哪些是版本相关的,列表里少一个的表现是它照旧被发出去,
 * 而这件事只有抓包看得见 —— 所以 `codexIdentity.test.ts` 用真的 buildRoleFetch 抓一次头,
 * 断言出网请求里一个 `x-stainless-` 都没有。
 */
const STAINLESS_OFF: Record<string, null> = {
  'x-stainless-lang': null,
  'x-stainless-package-version': null,
  'x-stainless-os': null,
  'x-stainless-arch': null,
  'x-stainless-runtime': null,
  'x-stainless-runtime-version': null,
  'x-stainless-retry-count': null,
  'x-stainless-timeout': null,
  'x-stainless-read-timeout': null,
}

export function buildOpenAIClient(
  cfg: { apiUrl: string; apiToken: string },
  knownRoutes: readonly string[],
  fetchImpl: typeof fetch,
  /**
   * 覆盖 SDK 自己那套头。
   *
   * SDK 默认发 `user-agent: OpenAI/JS <ver>` 加六个 `x-stainless-*`,而跑机上的网关按
   * 请求特征分流(codex cli trace),那套头一条都匹配不上 —— 于是走没有前缀缓存的渠道。
   * 这里传进来的是 codex 形状的头(见 codexIdentity),同名的会覆盖掉 SDK 的默认值。
   */
  defaultHeaders?: Record<string, string>,
): OpenAI {
  return new OpenAI({
    apiKey: cfg.apiToken,
    baseURL: sdkBaseURL(cfg.apiUrl, knownRoutes),
    fetch: fetchImpl,
    maxRetries: 0,
    timeout: SDK_TIMEOUT_MS,
    ...(defaultHeaders ? { defaultHeaders: { ...STAINLESS_OFF, ...defaultHeaders } } : {}),
  })
}

/**
 * 流**中途**炸掉时,转成一条和上游同形的 `error` 帧,而不是让异常穿过整个翻译层。
 *
 * raw 档遇到中途失败时,拿到的是上游发来的 error 帧(responses 是顶层
 * `{type:'error', message}`,chat 是 `{error:{message}}`),翻译器对这两种都有处理:
 * 发一条 anthropic 的 error 事件、把已经攒着的工具调用照发、正常收尾。sdk 档如果让异常
 * 直接抛出去,这一整套收尾就被跳过 —— 模型这一轮的意图凭空消失,而用户只看到「它什么都没干」。
 *
 * 两种形状**都填**:一个帧同时带顶层 `message` 和 `error.message`,responses 和 chat
 * 两侧的读法各自都能读到。多写一个字段的代价远小于「换了传输之后报错正文变成 undefined」。
 *
 * **中止原样抛。** 用户按 Esc、阶段闸门开火走的都是 abort;把它变成一条 error 帧,
 * 上层会以为是 provider 挂了,而那是用户自己的决定 —— 和 raw 档 catch 里那条判据逐字同因。
 */
export async function* framesWithErrorFrame(
  src: AsyncIterable<any>,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  try {
    for await (const f of src) yield f
  } catch (e) {
    if (isSdkAbort(e, signal)) throw e
    const f = sdkFailure(e)
    const msg = `${f.body}`
    yield { type: 'error', message: msg, error: { message: msg } }
  }
}

/**
 * 先**取一帧**,好在返回响应之前判「上游到底有没有给我们东西」。
 *
 * raw 档靠 `sniffSSE` 判两件事:200 但不是 SSE、200 但一个字节都没有。sdk 档没有这两条 ——
 * 而验收实测:上游回一个 200 的 JSON(或者干脆空体)时,SDK **不抛错**,只是一帧都不产出,
 * 于是这一席交出一次「成功但完全空白」的回答,流水线把这个空回答当成真实产出继续往下走。
 * 这正是 sniffSSE 当初存在的理由,不能因为换了传输就丢掉。
 *
 * 判据统一成「零帧」:它同时盖住上面两种,而且不依赖 SDK 的任何内部结构。第一帧要**先取
 * 出来再放回去**(不能重新迭代,SDK 的流是一次性的),所以这里把它接回生成器前面。
 */
export async function peekFrames(
  src: AsyncIterable<any>,
): Promise<{ empty: boolean; frames: AsyncIterable<any> }> {
  const it = src[Symbol.asyncIterator]()
  const first = await it.next()
  if (first.done === true) return { empty: true, frames: (async function* () {})() }
  return {
    empty: false,
    frames: (async function* () {
      yield first.value
      for (;;) {
        const n = await it.next()
        if (n.done === true) return
        yield n.value
      }
    })(),
  }
}
