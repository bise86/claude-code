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

  it('路径叠加的两个方向都不许发生', async () => {
    /**
     * 用户实测:「只写 env 时一切正常,一加 roles[] 就炸」,报的是
     *   「There's an issue with the selected model (K3)…」
     * 而上游自己说的是 `path /v1/v1/messages not found` —— 404 被 errors.ts 统一翻译成
     * 「模型有问题」,一路把人往改模型名上带(我自己就照着误诊了两轮)。
     *
     * 叠加有两个方向:
     *  (a) 会话侧:传进来的 url 是 SDK 按**会话自己的** baseURL 拼的完整路径,带路径的
     *      ANTHROPIC_BASE_URL 会把自己那一段塞进员工端点;
     *  (b) 员工侧:apiUrl 本身以 /v1 结尾 —— docs/roles-setup.md 里 openai 的例子正是
     *      这么写的,而文档没一句说 anthropic 的不能这么写。
     */
    const seen: string[] = []
    const inner = async (url: any) => { seen.push(String(url)); return new Response('{}') }
    const call = async (apiUrl: string, from: string): Promise<void> => {
      const f = buildRoleFetch({ apiProtocol: 'anthropic', apiUrl, apiToken: 'sk', backendModel: 'x' }, inner as any)
      await f(from, { method: 'POST', headers: new Headers(), body: '{}' })
    }
    // (b) 员工 apiUrl 自带 /v1
    await call('https://my-proxy.example.com/v1', 'https://api.anthropic.com/v1/messages')
    // (a) 会话 baseURL 带路径,员工 apiUrl 也带路径
    await call('https://vendor.example.com/coding', 'https://vendor.example.com/anthropic/v1/messages')
    // 两个方向同时踩
    await call('https://vendor.example.com/coding/v1', 'https://vendor.example.com/anthropic/v1/messages')
    // 结尾斜杠
    await call('https://vendor.example.com/coding/', 'https://api.anthropic.com/v1/messages')
    expect(seen).toEqual([
      'https://my-proxy.example.com/v1/messages',
      'https://vendor.example.com/coding/v1/messages',
      'https://vendor.example.com/coding/v1/messages',
      'https://vendor.example.com/coding/v1/messages',
    ])
    // 已有那条用例钉着 apiUrl 自己的前缀(MiniMax 的 /anthropic)不许被 WHATWG 覆盖掉,
    // 这一条钉的是反面:前缀只能来自 apiUrl,不能来自会话的 baseURL。
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

  it('forwards init.signal to the upstream chat/completions fetch so aborting the caller cancels it', async () => {
    let seenSignal: AbortSignal | undefined
    const inner = async (_url: any, init: any) => {
      seenSignal = init.signal
      const sse = 'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk-role', backendModel: 'gpt-4o' }, inner as any)
    const controller = new AbortController()
    await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
      signal: controller.signal,
    })
    expect(seenSignal).toBeTruthy()
    expect(seenSignal).toBe(controller.signal)
  })

  it('joins two `data:` lines within a single SSE frame per the SSE spec before parsing', async () => {
    const inner = async (_url: any, _init: any) => {
      // A single JSON chunk split across two `data:` lines within ONE frame
      // (no blank line between them). Neither line is valid JSON on its
      // own — only the SSE-spec-mandated `\n` join between them reconstructs
      // valid JSON (a raw newline between JSON tokens is legal whitespace).
      const full = JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] })
      const splitAt = full.length - 1 // keep the final closing `}` on its own line
      const line1 = full.slice(0, splitAt)
      const line2 = full.slice(splitAt)
      const sse = `data: ${line1}\ndata: ${line2}\n\n` + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'
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

  it('空体 502 也要说清「谁、发到哪、怎么办」—— 用户实测拿到的那一句里这三样一个都没有', async () => {
    /**
     * 原样抄用户报的:
     *   API Error: 502 {"type":"error","error":{"type":"api_error","message":"Bad Gateway"}}
     * 老代码是 `message: errText || res.statusText`,上游给空体时它退化成 statusText,
     * 也就是「Bad Gateway」四个字母 —— 而 502 的全部诊断依据(哪个员工、真实 URL)
     * 我们手上一直都有,只是从来没写进去过。
     */
    const inner = async () => new Response(null, { status: 502, statusText: 'Bad Gateway' })
    const f = buildRoleFetch({
      apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/v1',
      apiToken: 'sk', backendModel: 'gpt-5.1', roleName: '评审员甲',
    }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {}, body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    })
    expect(res.status).toBe(502)
    const msg = (await res.json() as any).error.message as string
    expect(msg).toContain('评审员甲')
    expect(msg).toContain('openai-responses')
    // 真实 URL —— 路径叠加这类错在这一行上当场自明。
    expect(msg).toContain('https://gw.example/v1/responses')
    expect(msg).toContain('502')
    // 空体要明说是空的,不能留一段空白让人以为上游说了什么而我们没转达。
    expect(msg).toContain('(空)')
    // 一条能动手的建议,而且指向具体的配置键。空体 5xx 这一档给的是「先重试确认不是
    // 瞬时的」+「查 apiUrl 的路径前缀」—— 不再断言「这个网关没有这条路由」(那种情况
    // 通常回 404,评审用真 socket 戳穿了这条)。
    expect(msg).toContain('重试')
    expect(msg).toContain('apiUrl')
    // **一行**。这段字符串是塞进 JSON 字符串字段里被原样打印的,换行在那里是 `\n` 两个字符。
    expect(msg).not.toContain('\n')
  })

  it('apiUrl 里已经带了路由段时不许再拼一遍(两条协议互相踩也算)', async () => {
    const seen: string[] = []
    const inner = async (url: any) => { seen.push(String(url)); return new Response(null, { status: 500 }) }
    const call = async (apiUrl: string, apiProtocol: string): Promise<void> => {
      const f = buildRoleFetch({ apiProtocol, apiUrl, apiToken: 'sk', backendModel: 'm' } as any, inner as any)
      await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: {}, body: '{"messages":[]}' })
    }
    // 厂商文档印的就是完整端点,复制粘贴天经地义。
    await call('https://gw.example/v1/chat/completions', 'openai')
    await call('https://gw.example/v1/responses', 'openai-responses')
    // 换协议但 apiUrl 还停在上一条协议的路由上 —— 所以剥的是**全表**,不只是本次这条。
    await call('https://gw.example/v1/chat/completions', 'openai-responses')
    await call('https://gw.example/v1/responses/', 'openai')
    expect(seen).toEqual([
      'https://gw.example/v1/chat/completions',
      'https://gw.example/v1/responses',
      'https://gw.example/v1/responses',
      'https://gw.example/v1/chat/completions',
    ])
  })

  it('anthropic 专用头不许带到 OpenAI 系端点上', async () => {
    let seen: Headers = new Headers()
    const inner = async (_u: any, init: any) => {
      seen = new Headers(init.headers as HeadersInit)
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk-role', backendModel: 'gpt-4o' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: new Headers({
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'a,b,c',
        'x-stainless-lang': 'js',
        'x-api-key': 'GLOBAL',
        accept: 'application/json',
      }),
      body: '{"messages":[]}',
    })
    // 这些描述的是 Anthropic 的 SDK,不是这一次出网的请求。严格网关会对陌生头
    // 直接 4xx/502,而那种 502 是空体的 —— 正是用户报的那一句。
    expect(seen.get('anthropic-version')).toBeNull()
    expect(seen.get('anthropic-beta')).toBeNull()
    expect(seen.get('x-stainless-lang')).toBeNull()
    expect(seen.get('x-api-key')).toBeNull()
    // 不相干的头照旧,鉴权换成这条路径认的那一套。
    expect(seen.get('accept')).toBe('application/json')
    expect(seen.get('authorization')).toBe('Bearer sk-role')
  })

  it('HTTP 200 但不是 SSE —— 报出来,不要变成一次「成功但空白」的回答', async () => {
    /**
     * 有一类网关在不支持 stream 时用 **200** 返回一个 JSON 错误体。老路径上 parseSSE
     * 一帧都解不出来 → 零事件 → 用户拿到一次完全空白的成功回答,而流水线会把这个空回答
     * 当成这一席的真实产出继续往下走。报错反而是最轻的后果。
     */
    const inner = async () => new Response(
      JSON.stringify({ error: { message: 'stream is not supported by this deployment' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const f = buildRoleFetch({ apiProtocol: 'openai-responses', apiUrl: 'https://gw/v1', apiToken: 'sk', backendModel: 'm' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {}, body: '{"messages":[],"stream":true}',
    })
    expect(res.status).toBe(502)
    const msg = (await res.json() as any).error.message as string
    expect(msg).toContain('不是 SSE')
    expect(msg).toContain('stream is not supported by this deployment')
  })

  it('嗅探过的第一口数据必须原样接回流里 —— 否则第一帧就没了', async () => {
    // sniffSSE 要读第一口才能判断,那一口如果不还回去,回答会被吃掉开头。
    const inner = async () => {
      const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: '开头两个字' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '后面的' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {}, body: '{"messages":[],"stream":true}',
    })
    const text = await res.text()
    expect(text).toContain('开头两个字')
    expect(text).toContain('后面的')
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
