/**
 * **出网请求要长得像 codex CLI**,否则跑机上那条按请求特征分流的规则匹配不上,
 * 走的就是没有前缀缓存的渠道(实测:同一份 3138 token 前缀连发三次,cached_tokens 恒 0)。
 *
 * 头的形状是 2026-08-20 用本地捕获服务器从 codex 0.147.0 抓下来的,不是猜的。
 *
 * 这一组从**两侧**看:派生出来的 id 对不对(跨轮恒定 / 换对话就换),以及真正出网的那次
 * 请求里到底有什么 —— 后者用真的 `buildRoleFetch` 抓,因为「SDK 会不会把自己的
 * `x-stainless-*` 加回来」只有跑一次才知道。
 */
import { describe, expect, it } from 'bun:test'
import { bodyPrefixKey, codexHeaders, derivedId } from './codexIdentity.js'
import { buildRoleFetch } from './roleFetch.js'

const SSE = 'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n'

/** 真正发出去的那一次请求。 */
async function sent(transport: 'raw' | 'sdk', body: unknown) {
  let seen: { headers: Headers; body: any } | undefined
  const inner = (async (input: any, init: any = {}) => {
    const isReq = typeof input === 'object' && input !== null && typeof input.url === 'string'
    const raw = init?.body ?? (isReq ? await input.clone().text() : '{}')
    seen = {
      headers: new Headers(isReq ? input.headers : init.headers),
      body: JSON.parse(String(raw)),
    }
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const f = buildRoleFetch({
    apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/v1', apiToken: 'sk',
    backendModel: 'gpt-5.1', roleName: 'seat', transport,
  }, inner)
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'anthropic-version': '2023-06-01', 'user-agent': 'Anthropic/JS' }),
    body: JSON.stringify(body),
  })
  await res.text()
  return seen!
}

const body = (userText: string) => ({
  model: 'claude-alias', max_tokens: 100, stream: true,
  system: [{ type: 'text', text: '员工提示词' }],
  messages: [{ role: 'user', content: userText }],
})

for (const transport of ['raw', 'sdk'] as const) {
  describe(`[${transport}] 出网请求的身份面`, () => {
    it('codex 那几个头都在', async () => {
      const s = await sent(transport, body('hi'))
      expect(s.headers.get('originator')).toBe('codex_cli_rs')
      expect(s.headers.get('x-codex-beta-features')).toBe('remote_compaction_v2')
      expect(s.headers.get('user-agent')).toContain('codex_cli_rs/')
      expect(s.headers.get('accept')).toBe('text/event-stream')
      for (const h of ['session-id', 'thread-id', 'x-client-request-id', 'x-codex-window-id']) {
        expect(`${h}: ${(s.headers.get(h) ?? '').length > 0}`).toBe(`${h}: true`)
      }
      // turn-metadata 是一段 JSON,里面的 id 要和头上的对得上。
      const meta = JSON.parse(s.headers.get('x-codex-turn-metadata') ?? '{}')
      expect(meta.session_id).toBe(s.headers.get('session-id'))
      expect(meta.turn_id).toBe(s.headers.get('x-client-request-id'))
      expect(meta.request_kind).toBe('turn')
    })

    it('不是 codex 的那些头一个都不许留', async () => {
      const s = await sent(transport, body('hi'))
      const names = [...s.headers.keys()]
      // SDK 的客户端指纹:openai-node 会自己加,必须显式关掉(见 sdkTransport 的 STAINLESS_OFF)。
      expect(names.filter(n => n.startsWith('x-stainless-'))).toEqual([])
      // Anthropic SDK 透传下来的 UA 也不该出现在第三方端点上。
      expect(s.headers.get('user-agent')).not.toContain('Anthropic')
      expect(s.headers.get('user-agent')).not.toContain('OpenAI/JS')
      expect(names.filter(n => n.startsWith('anthropic-'))).toEqual([])
    })

    it('prompt_cache_key 在请求体里,而且等于 session-id', async () => {
      const s = await sent(transport, body('hi'))
      expect(typeof s.body.prompt_cache_key).toBe('string')
      expect(s.body.prompt_cache_key).toBe(s.headers.get('session-id'))
    })

    /**
     * **这条是整组的重点。** 缓存路由键的全部价值在于「同一段对话逐轮同值」——
     * 拿每轮都变的东西去填,等于每轮都告诉上游「这是一段新对话」,缓存永远建不起来。
     */
    it('同一段对话:session / thread / cache key 跨轮恒定,只有 request-id 每次变', async () => {
      const a = await sent(transport, body('hi'))
      const b = await sent(transport, body('hi'))
      expect(b.headers.get('session-id')).toBe(a.headers.get('session-id'))
      expect(b.headers.get('thread-id')).toBe(a.headers.get('thread-id'))
      expect(b.body.prompt_cache_key).toBe(a.body.prompt_cache_key)
      expect(b.headers.get('x-client-request-id')).not.toBe(a.headers.get('x-client-request-id'))
    })

    it('换一段对话就换一组 id', async () => {
      const a = await sent(transport, body('hi'))
      const c = await sent(transport, body('完全不同的第一句'))
      expect(c.headers.get('session-id')).not.toBe(a.headers.get('session-id'))
      expect(c.body.prompt_cache_key).not.toBe(a.body.prompt_cache_key)
    })
  })
}

describe('派生规则本身', () => {
  it('前缀只取 instructions 和第一条 input —— 后面的消息不参与', () => {
    const k1 = bodyPrefixKey({ instructions: 'S', input: [{ role: 'user', content: 'a' }] })
    const k2 = bodyPrefixKey({ instructions: 'S', input: [{ role: 'user', content: 'a' }, { role: 'user', content: '第二轮' }] })
    expect(k2).toBe(k1)
  })

  it('chat 那种形状也认(系统消息 + 第一条用户消息)', () => {
    const k = bodyPrefixKey({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'a' }] })
    expect(k.length).toBeGreaterThan(0)
    expect(k).not.toBe(bodyPrefixKey({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'b' }] }))
  })

  it('同前缀不同盐 = 不同 id(codex 那边它们本来就是几个不同的 id)', () => {
    expect(derivedId('p', 'session')).not.toBe(derivedId('p', 'thread'))
    expect(derivedId('p', 'session')).toBe(derivedId('p', 'session'))
  })

  it('长得像 uuid —— 网关那边按格式做校验时不至于被挡', () => {
    expect(derivedId('p', 'session')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('codexHeaders 的 turn id 跟着 requestId 走,其余不跟', () => {
    const p = bodyPrefixKey({ instructions: 'S', input: [{ role: 'user', content: 'a' }] })
    const h1 = codexHeaders(p, 'req_1')
    const h2 = codexHeaders(p, 'req_2')
    expect(h2['session-id']).toBe(h1['session-id'])
    expect(h2['x-client-request-id']).not.toBe(h1['x-client-request-id'])
  })
})
