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
 */
export function joinRoute(base: string, route: string): string {
  const u = new URL(base)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${route}`
  return u.toString()
}
