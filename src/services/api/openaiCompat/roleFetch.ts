import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { toOpenAIRequest } from './toOpenAIRequest.js'
import { openaiChunksToAnthropicEvents, anthropicEventsToSSE } from './fromOpenAIStream.js'

async function* parseOpenAISSE(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      const line = frame.split('\n').find(l => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim(); if (payload === '[DONE]') return
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
    const headers: Record<string, string> = { ...(init.headers as any) }
    delete headers['authorization']; delete headers['Authorization']

    if (cfg.apiProtocol === 'anthropic') {
      headers['x-api-key'] = cfg.apiToken
      const orig = new URL(String(url))
      const dest = new URL(orig.pathname + orig.search, target)
      return inner(dest.toString(), { ...init, headers })
    }

    // openai
    headers['authorization'] = `Bearer ${cfg.apiToken}`
    delete headers['x-api-key']
    headers['content-type'] = 'application/json'
    const anthropicBody = JSON.parse(init.body as string)
    const openaiBody = toOpenAIRequest(anthropicBody, cfg.backendModel, cfg.thinkingDepth)
    const res = await inner(chatCompletionsUrl(target.toString()), { method: 'POST', headers, body: JSON.stringify(openaiBody) })
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText || res.statusText } }), { status: res.status || 502, headers: { 'content-type': 'application/json' } })
    }
    const events = openaiChunksToAnthropicEvents(parseOpenAISSE(res), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
