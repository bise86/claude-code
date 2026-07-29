/**
 * 翻译层的上游失败 → **一句人能照着修的话**。
 *
 * ## 为什么值得一个独立模块
 *
 * 用户实测报的是这一句,原样抄在这里:
 *
 *     API Error: 502 {"type":"error","error":{"type":"api_error","message":"Bad Gateway"}}
 *
 * 这句话里没有任何一个字能帮他:哪个员工、哪条协议、POST 到了哪个 URL、上游说了什么 ——
 * 一个都没有。而这三样恰恰是 502 的全部诊断依据:网关**没有这个路由**时返回的常常就是
 * 一个空体 502,只要把 URL 印出来,`/v1/responses/responses` 这类叠加当场自明。
 *
 * roleFetch 此前的写法是 `message: errText || res.statusText` —— 上游给空体时它退化成
 * `res.statusText`,也就是 `Bad Gateway` 这四个字母。**信息不是在传输中丢的,是我们自己
 * 从来没写进去过。**
 *
 * ## 为什么是一行
 *
 * 这段字符串会被塞进一个 JSON 的字符串字段里,而 SDK 打印错误时打的是**整个原始 body**。
 * 换行在那里是 `\n` 两个字符,多行排版会变成一条又长又难读的转义串。所以用 ` · ` 分段,
 * 不用换行 —— 这是被输出通道决定的,不是审美。
 */

/** 上游原文最多带回多少个字符。够看清一条 JSON 错误,又不至于把整页 HTML 错误页搬过来。 */
export const MAX_UPSTREAM_BODY = 400

export interface UpstreamFailure {
  /** 哪个员工。缺省时不提 —— 编一个「未知员工」比不写更让人迷惑。 */
  roleName?: string
  protocol: string
  /** 我们**真正** POST 过去的那个地址。诊断 502 的第一手材料。 */
  url: string
  status: number
  statusText: string
  /** 上游返回的原文(可能是空串)。 */
  body: string
  /**
   * HTTP 是 2xx,但返回的**不是** SSE。
   *
   * 单列一档而不是并进 status:这一类的表现是「一次成功但空白的回答」,而不是报错 ——
   * 不点名的话用户会去查模型为什么不说话,而真正的原因是这个网关根本没按流式返回。
   */
  notStreamed?: boolean
}

/** 上游原文夹到 MAX_UPSTREAM_BODY,空的时候说「空」而不是留一段空白。 */
export function upstreamBodyText(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim()
  if (s.length === 0) return '(空)'
  const cps = Array.from(s)
  return cps.length > MAX_UPSTREAM_BODY ? `${cps.slice(0, MAX_UPSTREAM_BODY).join('')}…` : s
}

/**
 * 按状态码给一条**能动手**的建议。
 *
 * 每一条都指向一个具体的配置键(apiUrl / apiToken / apiProtocol / model),因为这一层
 * 唯一能被用户修的东西就是 `.claude/settings.json` 里的那几行。
 */
export function upstreamAdvice(f: Pick<UpstreamFailure, 'status' | 'protocol' | 'notStreamed'>): string {
  const route = f.protocol === 'openai-responses' ? '/responses' : '/chat/completions'
  const otherProtocol = f.protocol === 'openai-responses' ? 'openai' : 'openai-responses'
  if (f.notStreamed === true) {
    return `上游没有按流式返回(既不是 SSE,也不是一条能识别的错误)。多数是这个网关不支持 ${route},或者它把 stream 参数吞了 —— 换成 ${otherProtocol} 协议试一次`
  }
  if (f.status === 401 || f.status === 403) return 'apiToken 不对,或者这个 token 没有该模型的权限'
  if (f.status === 404 || f.status === 405) {
    return `这个地址上没有 ${route}。apiUrl 只写到 /v1 为止(别把 ${route} 也写进去);如果这个网关只实现了另一种方言,把 apiProtocol 改成 ${otherProtocol}`
  }
  if (f.status === 400 || f.status === 422) {
    return `上游拒绝了请求体(上面就是它的原话)。先查 model 写得对不对,再看它是不是根本不认 ${route} 这套字段 —— 后者换 ${otherProtocol} 协议`
  }
  if (f.status === 429) return '上游限流了。把 caps.maxSeatsPerPhase 调小以降低并发,或者把 apiToken 换成配额更宽的那个'
  if (f.status >= 500) {
    return `上游或它前面的网关自己出错了。**空体 502 最常见的原因是这个网关没有 ${route} 这个路由** —— 先确认 apiUrl 只写到 /v1、再确认它真的支持这套协议,否则把 apiProtocol 改成 ${otherProtocol}`
  }
  return `检查 apiUrl / apiToken / model 三项;如果这个网关不支持 ${route},把 apiProtocol 改成 ${otherProtocol}`
}

/**
 * 一整句。**员工名 → 协议 → 真实 URL → 状态 → 上游原文 → 建议**,顺序就是排查顺序。
 *
 * 不带任何请求头:token 就在 `authorization` 里,而这句话会原样出现在阻断原因、
 * 详情页和日志窗上。写请求体也没意义 —— 它是我们自己拼的,用户改不了。
 */
export function upstreamFailureMessage(f: UpstreamFailure): string {
  const who = f.roleName ? `员工「${f.roleName}」` : '员工'
  const code = `${f.status}${f.statusText ? ` ${f.statusText}` : ''}`
  // `status` 是**上游自己说的**那个码,不是我们返回给上层的那个。上游 200、我们判定不是
  // SSE 之后返回 502 时,正文写 502 就是在编 —— 用户拿着 502 去查网关日志,那边记的是 200。
  const status = f.notStreamed === true ? `${code} 但不是 SSE` : code
  return [
    `${who}(${f.protocol} 协议)调用失败`,
    `POST ${f.url} → ${status}`,
    `上游原文:${upstreamBodyText(f.body)}`,
    `可能原因:${upstreamAdvice(f)}`,
  ].join(' · ')
}
