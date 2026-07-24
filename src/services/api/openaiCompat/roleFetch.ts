import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
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
      try { yield JSON.parse(payload) } catch {}
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
      const dest = new URL(target.pathname.replace(/\/$/, '') + orig.pathname + orig.search, target.origin)
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
