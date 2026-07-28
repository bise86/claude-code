import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { logError } from '../../../utils/log.js'
import { toOpenAIRequest } from './toOpenAIRequest.js'
import { openaiChunksToAnthropicEvents, anthropicEventsToSSE } from './fromOpenAIStream.js'

async function* parseOpenAISSE(res: Response): AsyncGenerator<any> {
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
        // Skip (don't throw) a malformed OpenAI SSE frame, same as
        // cliAgentRunner.ts's parseJsonLines does for bad protocol lines —
        // one bad frame shouldn't take down the whole stream. Still worth
        // a log line so a consistently-malformed upstream isn't silently
        // invisible.
        const snippet = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload
        logError(new Error(`roleFetch: skipping malformed SSE frame: ${snippet}`))
      }
    }
  }
}

// Join `base` (an arbitrary API root, possibly with a trailing slash and/or a
// path prefix like `/v1`) with the OpenAI `chat/completions` route without
// losing that prefix — `new URL('/chat/completions', base)` would discard it.
function chatCompletionsUrl(base: string): string {
  const u = new URL(base)
  u.pathname = u.pathname.replace(/\/+$/, '') + '/chat/completions'
  return u.toString()
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

    // openai
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${cfg.apiToken}`)
    headers.set('content-type', 'application/json')
    const anthropicBody = JSON.parse(init.body as string)
    const openaiBody = toOpenAIRequest(anthropicBody, cfg.backendModel, cfg.thinkingDepth)
    const res = await inner(chatCompletionsUrl(target.toString()), { ...init, method: 'POST', headers, body: JSON.stringify(openaiBody) })
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText || res.statusText } }), { status: res.ok ? 502 : res.status, headers: { 'content-type': 'application/json' } })
    }
    const events = openaiChunksToAnthropicEvents(parseOpenAISSE(res), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
