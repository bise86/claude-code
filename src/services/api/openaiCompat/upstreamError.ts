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
  /**
   * 请求**根本没发出去** —— DNS、拒连、TLS、代理。
   *
   * 和「上游回了个错」必须分开:这一档以前压根走不到(异常直接穿过整个翻译层),
   * 用户拿到的是引擎的通用兜底「Unable to connect to API. Check your internet
   * connection」—— 没有员工名、没有协议、没有 URL,而他的网络是好的。
   */
  connectFailed?: boolean
  /**
   * 上游 2xx,而且**一个字节都没返回**。
   *
   * 和「返回的不是 SSE」分开:前者是它收下请求就断开(源站挂了、连接被掐),后者是它
   * 认认真真回了个东西、只是不流。两条排查路径不一样,合成一句话等于把它们并成一条。
   */
  emptyStream?: boolean
  /**
   * 这次请求**走的是代理还是直连**(见 utils/lanDirect 的 proxyRouteNote)。
   *
   * 只在连不上时才有意义,所以由调用方决定填不填。空串 = 不说 —— 没配代理时多一句
   * 「未经代理」是噪音,而它要挤掉的是上游原文。
   */
  route?: string
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
/**
 * 上游说的是「上下文超了」吗。
 *
 * 各家写法不一样,但都绕不开这几个词。收得宽一点是对的:判错的代价只是多给一条建议,
 * 而漏判的代价是把人引到 model 名上去 —— 400 那一档的通用建议第一句就是「先查 model
 * 写得对不对」,对着一个跑了半小时、上下文涨满的席位说这句话,等于让他去改一个没错的字段。
 */
export function looksLikeContextOverflow(body: string): boolean {
  const s = body.toLowerCase()
  return (
    s.includes('context_length_exceeded') ||
    s.includes('context length') ||
    s.includes('context window') ||
    s.includes('maximum context') ||
    s.includes('too many tokens') ||
    s.includes('prompt is too long') ||
    s.includes('input length and `max_tokens` exceed') ||
    s.includes('reduce the length') ||
    s.includes('上下文') ||
    (s.includes('token') && (s.includes('exceed') || s.includes('too long')))
  )
}

export function upstreamAdvice(
  f: Pick<UpstreamFailure, 'status' | 'protocol' | 'notStreamed' | 'connectFailed' | 'emptyStream'> & { emptyBody?: boolean; body?: string },
): string {
  const route = f.protocol === 'openai-responses' ? '/responses' : '/chat/completions'
  const otherProtocol = f.protocol === 'openai-responses' ? 'openai' : 'openai-responses'
  if (f.connectFailed === true) {
    // 连不上和「上游回了个错」是两件事,而这一档以前根本走不到:异常直接穿过整个翻译层,
    // 用户拿到引擎的通用兜底「检查你的网络连接」—— 而他的网络是好的。
    //
    // 「这次走的是代理还是直连」由调用方量出来一并传进来(见 route)。少了它,最常见的
    // 真因(全局代理到不了内网端点)恰好是最难想到的那一个:同一台机器上 curl 是通的。
    return `根本没连上这个地址。先确认 apiUrl 的域名和端口没写错、这台机器出得去网(公司代理/防火墙),再确认网关还活着`
  }
  if (f.emptyStream === true) {
    /**
     * 「一个字节都没给」和「给的不是 SSE」要分开说 —— 两者该查的东西不一样。
     *
     * 前者是上游**接受了请求然后立刻断开**:源站 reset、LB 掐了连接、网关自己崩了。
     * 后者是它认认真真回了个东西,只是不流。给同一句话等于把两条排查路径合成一条。
     */
    return `上游收下了请求,然后一个字节都没返回就断开了。多半是它后面的源站挂了或连接被掐断 —— 先原样重试一次确认不是瞬时的;反复出现就查这个网关的健康状态,以及 model 名它认不认`
  }
  if (f.notStreamed === true) {
    return `上游没有按流式返回(既不是 SSE,也不是一条能识别的错误)。多数是这个网关不支持 ${route},或者它把 stream 参数吞了 —— 换成 ${otherProtocol} 协议试一次`
  }
  if (f.status === 401 || f.status === 403) return 'apiToken 不对,或者这个 token 没有该模型的权限'
  if (f.status === 404 || f.status === 405) {
    /**
     * **不要再叫用户手动去掉路由段** —— `joinRoute` 已经自动剥了(实测 apiUrl 写
     * `.../v1` 和写 `.../v1/responses` 发出去的地址一模一样)。照着一条「做了等于没做」
     * 的建议改完再试、症状分毫不差,用户就会认定这套建议不可信,后面几条也不再看。
     *
     * 404 真正的成因是**路径前缀**不对,而各家前缀差得远。
     */
    return `这个地址上没有 ${route}。路由段我们会自动归一,写不写都行;要查的是 apiUrl 的**路径前缀**对不对(各家不一样:/v1、/openai/v1、/api/v1、/v1beta/openai)。如果这个网关只实现了另一种方言,把 apiProtocol 改成 ${otherProtocol}`
  }
  if (f.status === 400 || f.status === 422) {
    /**
     * **上下文超了要单独说。**
     *
     * 这一档以前和「请求体不对」共用一条建议,而那条建议的第一句是「先查 model 写得对不对」——
     * 对一个跑到一半、上下文涨满的席位,那是让人去改一个没错的字段。
     *
     * 真正的修法是让自动压缩**认得这个员工的窗口**:翻译型协议的员工跑在别人的模型上,而
     * 引擎的压缩阈值算的是父会话 Claude 模型的窗口(`runAgent.ts:352` 故意这么设),没声明
     * 窗口时按 128k 估 —— 上游窗口比这个小,就会一直撞到这里。
     */
    if (looksLikeContextOverflow(f.body ?? '')) {
      return `这是**上下文超了**,不是请求体写错。在 settings.json 里给这个员工写上 contextWindow(这台模型真正的窗口,比如 "contextWindow": 32000),自动压缩就会在撞上游之前先压一次;也可以把任务拆小、或者调低 caps.maxIterations 少攒几轮返工历史`
    }
    return `上游拒绝了请求体(上面就是它的原话)。先查 model 写得对不对,再看它是不是根本不认 ${route} 这套字段 —— 后者换 ${otherProtocol} 协议`
  }
  if (f.status === 429) return '上游限流了。把 caps.maxSeatsPerPhase 调小以降低并发,或者把 apiToken 换成配额更宽的那个'
  if (f.status >= 500) {
    /**
     * 分两档,而且**都不再断言「最常见的原因是没有这条路由」**。
     *
     * 那句断言有三个毛病,评审逐条戳穿了:网关缺路由的标准返回是 **404**(代码里就有
     * 那一支,两档在讲同一个原因等于自相矛盾);空体 502 在中转链路上真正常见的两个
     * 成因(源站被 reset、首字节太慢被 CDN/LB 掐断)一个字没提;而且它**无条件印**——
     * 上游明明回了一段 nginx 的 502 页面,我们还在讲空体和路由。
     */
    if (f.emptyBody === true) {
      return `上游或它前面的网关自己出错了,而且没留下任何内容。这一档最常见的两种:上游进程/连接被掐断(先原样重试一次,确认不是瞬时的);或者首字节太慢被中间层按超时切断(推理模型 + 长上下文最容易撞)。都排除之后再查 apiUrl 的路径前缀对不对、这个网关是不是根本没有 ${route}(那种情况通常回 404)`
    }
    return `上游或它前面的网关自己出错了 —— 上面那段就是它自己的说法,先照它排查。先重试一次确认不是瞬时的;如果反复,再查 apiUrl 的路径前缀,或者把 apiProtocol 改成 ${otherProtocol}`
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
  const status = f.connectFailed === true ? '连不上'
    : f.emptyStream === true ? `${code} 但一个字节都没返回`
    : f.notStreamed === true ? `${code} 但不是 SSE` : code
  const label = f.connectFailed === true ? '错误' : '上游原文'
  return [
    `${who}(${f.protocol} 协议)调用失败`,
    `POST ${f.url} → ${status}`,
    `${label}:${upstreamBodyText(f.body)}${f.connectFailed === true && f.route ? ` ${f.route}` : ''}`,
    // 上游给没给内容会换一条建议 —— 空体 5xx 和带内容的 5xx 该查的东西不一样。
    `可能原因:${upstreamAdvice({ ...f, emptyBody: f.body.trim().length === 0 })}`,
  ].join(' · ')
}
