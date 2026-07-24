import { describe, it, expect } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'

describe('buildRoleFetch anthropic passthrough', () => {
  it('rewrites host and replaces auth headers with role token', async () => {
    let seenUrl = '', seenHeaders: any = {}
    const inner = async (url: any, init: any) => { seenUrl = String(url); seenHeaders = init.headers; return new Response('{}') }
    const f = buildRoleFetch({ apiProtocol: 'anthropic', apiUrl: 'https://role.example/anthropic', apiToken: 'sk-role', backendModel: 'x' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'authorization': 'Bearer GLOBAL', 'x-api-key': 'GLOBAL' }, body: '{}' })
    expect(seenUrl).toContain('role.example')
    expect(seenHeaders['x-api-key']).toBe('sk-role')
    expect(seenHeaders['authorization']).toBeUndefined()
  })
})

describe('buildRoleFetch openai translate', () => {
  it('sends openai request to role url and returns anthropic-SSE response', async () => {
    let sentBody: any
    const inner = async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) + '\n\n' +
                  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: {}, body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }) })
    expect(sentBody.model).toBe('gpt-4o')
    const text = await res.text()
    expect(text).toContain('event: message_start'); expect(text).toContain('event: message_stop')
  })
})
