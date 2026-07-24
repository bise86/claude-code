import { describe, it, expect } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'

describe('buildRoleFetch anthropic passthrough', () => {
  it('rewrites host and replaces auth headers with role token, preserving apiUrl path prefix', async () => {
    let seenUrl = ''
    let seenHeaders: Headers = new Headers()
    const inner = async (url: any, init: any) => {
      seenUrl = String(url)
      seenHeaders = new Headers(init.headers as HeadersInit)
      return new Response('{}')
    }
    const f = buildRoleFetch({ apiProtocol: 'anthropic', apiUrl: 'https://role.example/anthropic', apiToken: 'sk-role', backendModel: 'x' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: new Headers({ 'anthropic-version': '2023-06-01', 'authorization': 'Bearer GLOBAL', 'x-api-key': 'GLOBAL' }),
      body: '{}',
    })
    // The apiUrl's own path prefix (`/anthropic`) must be preserved, not clobbered
    // by WHATWG absolute-path resolution of the incoming request's path.
    expect(seenUrl).toBe('https://role.example/anthropic/v1/messages')
    expect(seenHeaders.get('x-api-key')).toBe('sk-role')
    expect(seenHeaders.get('authorization')).toBeNull()
    // SDK-set headers (carried on a Headers instance, as the real caller does)
    // must survive — not be dropped by spreading a Headers instance into `{}`.
    expect(seenHeaders.get('anthropic-version')).toBe('2023-06-01')
  })
})

describe('buildRoleFetch openai translate', () => {
  it('sends openai request to role url and returns anthropic-SSE response', async () => {
    let sentBody: any
    let seenHeaders: Headers = new Headers()
    const inner = async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      seenHeaders = new Headers(init.headers as HeadersInit)
      const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) + '\n\n' +
                  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk-role', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: new Headers({ 'anthropic-version': '2023-06-01', 'authorization': 'Bearer GLOBAL', 'x-api-key': 'GLOBAL' }),
      body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
    })
    expect(sentBody.model).toBe('gpt-4o')
    expect(seenHeaders.get('authorization')).toBe('Bearer sk-role')
    expect(seenHeaders.get('x-api-key')).toBeNull()
    const text = await res.text()
    expect(text).toContain('event: message_start'); expect(text).toContain('event: message_stop')
  })

  it('handles CRLF-terminated SSE frames and multiple data: lines per frame', async () => {
    const inner = async (_url: any, _init: any) => {
      // CRLF frame separators, and a frame with a split/continued data: line
      // (per the SSE spec, multiple `data:` lines in one frame are concatenated).
      const part1 = JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] })
      const sse =
        'data: ' + part1 + '\r\n\r\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\r\n\r\n' +
        'data: [DONE]\r\n\r\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk-role', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
    })
    const text = await res.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: message_stop')
    expect(text).toContain('"hi"')
  })

  it('returns a non-2xx status on upstream error even when upstream status was 2xx', async () => {
    const inner = async (_url: any, _init: any) => {
      // Simulate an upstream that responds 2xx but with a null body (edge
      // case that should still be surfaced as an error, not a fake-success
      // status by echoing the upstream's 2xx).
      return new Response(null, { status: 200, statusText: 'OK' })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk-role', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
    })
    expect(res.status).not.toBe(200)
    expect(res.status).toBe(502)
  })
})
