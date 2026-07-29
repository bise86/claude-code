import { logError } from '../../../utils/log.js'

/**
 * SSE 分帧 —— 两个 OpenAI 系协议共用。
 *
 * 能共用是因为它只读 `data:` 行、忽略 `event:` 行,而 responses 的每个 payload 自己带
 * `type` 字段(SDK 里 50 多个事件类型全都有),所以丢掉 `event:` 行不损失任何信息。
 * CRLF 归一、多 `data:` 行拼接、坏帧跳过并记一笔 —— 四条需求两边一模一样。
 */
export async function* parseSSE(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    // Normalize CRLF to LF so frames terminated by `\r\n\r\n` (some upstreams)
    // are recognized the same as the spec-standard `\n\n`.
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      // Per the SSE spec, a frame may contain multiple `data:` lines whose
      // values must be concatenated (joined with `\n`) before parsing.
      const dataLines = frame.split('\n').filter(l => l.startsWith('data:'))
      if (dataLines.length === 0) continue
      const payload = dataLines.map(l => l.slice(5).trimStart()).join('\n').trim()
      if (payload === '[DONE]') return
      try {
        yield JSON.parse(payload)
      } catch {
        // Skip (don't throw) a malformed SSE frame, same as cliAgentRunner.ts's
        // parseJsonLines does for bad protocol lines — one bad frame shouldn't take
        // down the whole stream. Still worth a log line so a consistently-malformed
        // upstream isn't silently invisible.
        const snippet = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload
        logError(new Error(`roleFetch: skipping malformed SSE frame: ${snippet}`))
      }
    }
  }
}

/**
 * 把一个任意的 API 根地址和一个路由拼起来,**不丢它自己的路径前缀**。
 *
 * `new URL('/responses', base)` 会按 WHATWG 的绝对路径解析把 base 的 `/v1` 一类前缀
 * 整个替换掉 —— 那正是「只写 env 时一切正常、一加 roles[] 就 404」的那类故障。
 *
 * ## 还要剥掉 apiUrl 自己带的路由段(`knownRoutes`)
 *
 * 用户把**完整端点**贴进 apiUrl 是最常见的一种配错 —— 厂商文档里印的就是
 * `https://host/v1/chat/completions`,复制粘贴天经地义。不剥的话拼出来是
 * `/v1/chat/completions/chat/completions`,而网关对这种路径回的**常常是一个空体 502**,
 * 用户拿到的只有「Bad Gateway」四个字。
 *
 * 换协议时同理:apiUrl 停在 `/v1/chat/completions`、apiProtocol 改成 openai-responses,
 * 拼出来是 `/v1/chat/completions/responses`。所以剥的是**所有已知路由**,不只是本次这个。
 *
 * 长的排前面(`chat/completions` 先于 `responses`),否则短的先匹配会剥不干净。
 */
export function joinRoute(base: string, route: string, knownRoutes: readonly string[] = [route]): string {
  const u = new URL(base)
  let path = u.pathname.replace(/\/+$/, '')
  for (const r of [...knownRoutes].sort((a, b) => b.length - a.length)) {
    if (path.endsWith(`/${r}`)) {
      path = path.slice(0, -(r.length + 1))
      break
    }
  }
  u.pathname = `${path}/${route}`
  return u.toString()
}

/**
 * SSE 帧的合法行首。协议规定一帧只能以这五种之一开头(`:` 是注释行,网关的 keepalive
 * 保活最常用的就是它)。
 */
const SSE_TOKENS = ['data:', 'event:', 'id:', 'retry:', ':'] as const

/**
 * 最多为了下结论读多少字节 / 多少口。
 *
 * 上限的作用只有一个:一个不断发**零长度块**的上游会让下面这个循环永远转下去。
 * 正常情况下最迟第 6 个字节就能下结论(最长的 token 是 `retry:`)。
 */
const SNIFF_MAX_BYTES = 64
const SNIFF_MAX_READS = 32

/**
 * 这条 200 响应到底是不是 SSE —— **看开头那几个字节,不看 content-type**。
 *
 * 为什么不看头:第三方网关的 content-type 五花八门(`application/octet-stream`、
 * 漏设、带 charset),按头判会把正常的流误杀。而**第一帧长什么样**是 SSE 协议本身规定的。
 *
 * 为什么非判不可:有一类网关在不支持 `stream` 时会**用 HTTP 200 返回一个 JSON 错误体**。
 * 那条路径上 parseSSE 一帧都解不出来 → 零事件 → 用户拿到的是一次「成功但完全空白」的
 * 回答,而流水线会把这个空回答当成这一席的真实产出往下走。报错反而是最轻的后果。
 *
 * ## 为什么是「读到能下结论为止」,不是「读第一口就下结论」
 *
 * 这里的第一版是 `read()` 一次就判,**那是个真 bug,评审用真 socket 抓到的**:
 * HTTP 分块的边界由上游和中间层决定,首块只有 1~4 个字节完全正常(逐字节 flush、
 * TLS record 切分、代理重新分块)。而 `data:` 有 5 个字节 —— 于是
 *
 *     首块 1~4 字节 → 判成「不是 SSE」→ 一条完全正常的流被硬转成 502,
 *     报错正文还会把它刚拒掉的那段 SSE 原样印出来,再让用户去换协议。
 *
 * 同一个 bug 的反面:首块正好是一个多字节字符的头一个字节时,`decode(…,{stream:true})`
 * 返回空串,于是一段**不是** SSE 的正文被判成 SSE。
 *
 * 所以判据改成三分:**完整匹配 → 是**;**还是某个 token 的严格前缀(或仍为空)→ 继续读**;
 * **两者都不是 → 不是**。
 *
 * 读走的数据由本函数**原样接回**返回的流里,所以调用方拿到的仍是完整响应体。
 *
 * @returns bytes 为止一共读到多少字节。**0 = 上游一个字节都没给** —— 调用方要把这一档
 *          单独报出来:`res.body` 在真 socket 上**永远不是 null**(空体 200 也给一个
 *          立刻 done 的流),所以「200 但完全空白」只能从这个数里看出来。
 */
export async function sniffSSE(
  body: ReadableStream<Uint8Array>,
): Promise<{ isSSE: boolean; head: string; bytes: number; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  const buffered: Uint8Array[] = []
  let head = ''
  let bytes = 0
  let isSSE = false
  let reads = 0
  for (;;) {
    if (reads++ >= SNIFF_MAX_READS || bytes >= SNIFF_MAX_BYTES) break
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    buffered.push(value)
    bytes += value.byteLength
    head += dec.decode(value, { stream: true })
    // 前导空白和 BOM 不参与判定 —— 有网关会先发一个 `\n` 或者带 BOM。
    const probe = head.replace(/^[﻿\s]+/, '')
    if (probe.length === 0) continue
    if (SSE_TOKENS.some(t => probe.startsWith(t))) { isSSE = true; break }
    // 还是某个 token 的严格前缀 → 证据不够,再读一口。
    if (SSE_TOKENS.some(t => t.startsWith(probe))) continue
    break
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of buffered) c.enqueue(chunk)
    },
    async pull(c) {
      const { done, value } = await reader.read()
      if (done) c.close()
      else c.enqueue(value)
    },
    cancel(reason) {
      void reader.cancel(reason)
    },
  })
  return { isSSE, head, bytes, stream }
}

/**
 * 非 SSE 的 200 响应体读到底 —— 用来当报错原文。
 *
 * 有上限:一个返回整页 HTML 错误页的网关不该让我们把它全读进内存,而**报错只需要开头**。
 */
export async function drainText(stream: ReadableStream<Uint8Array>, limit = 4096): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  try {
    while (out.length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) out += dec.decode(value, { stream: true })
    }
  } catch {
    // 读一半断了也要把已经读到的交出去 —— 那半段就是诊断材料。
  } finally {
    void reader.cancel().catch(() => {})
  }
  return out.slice(0, limit)
}
