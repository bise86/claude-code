/**
 * 翻译层的**真 socket** 测试。
 *
 * ## 为什么必须有这一份
 *
 * `roleFetch.test.ts` 全部用进程内的 `new Response(...)` 当上游。那是个**长得像**真上游
 * 的替身,而两个真 bug 恰好就藏在它和真网络不一样的地方 —— 评审用真 socket 一抓一个准:
 *
 * 1. **`res.body` 在真 socket 上永远不是 null。** 空体 200、甚至 204,拿到的都是一个
 *    立刻 done 的流。于是 `if (!res.body)` 那道防线在真实网络上是**死代码**,而
 *    「上游 200 却一个字节都没给」正是它本来要挡的东西 —— 用户拿到一次成功的空回答。
 * 2. **HTTP 分块的边界由上游和中间层决定。** 首块只有 1~4 个字节完全正常(逐字节 flush、
 *    TLS record 切分、代理重新分块),而 `data:` 有 5 个字节 —— 只看第一口的嗅探会把
 *    一条完全正常的流判成「不是 SSE」,硬转成 502,报错正文还把它刚拒掉的 SSE 原样印出来。
 *
 * 两条在替身上都复现不出来。所以这一份存在的理由不是「多测一遍」,是「测的是另一件事」。
 */
import { describe, expect, it } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'

const cfg = (over: Record<string, unknown> = {}) => ({
  apiProtocol: 'openai', apiUrl: 'about:blank', apiToken: 'sk', backendModel: 'gpt-4o',
  roleName: '员工甲', ...over,
}) as never

const FRAME = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: '正文' } }] }) + '\n\n'
const TAIL = 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'

/** 起一个真 HTTP 服务,跑一次完整的翻译层调用,拿回 `{status, text}`。 */
async function callServer(
  handler: (req: Request) => Response | Promise<Response>,
  over: Record<string, unknown> = {},
): Promise<{ status: number; text: string; message: string }> {
  const srv = Bun.serve({ port: 0, fetch: handler })
  try {
    const f = buildRoleFetch(cfg({ apiUrl: `http://localhost:${srv.port}/v1`, ...over }))
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: new Headers({ 'anthropic-version': '2023-06-01' }),
      body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }),
    })
    const text = await res.text()
    let message = ''
    try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? '' } catch { /* SSE,不是 JSON */ }
    return { status: res.status, text, message }
  } finally {
    srv.stop(true)
  }
}

/** 一个按指定字节数切开首块的 SSE 流。模拟逐字节 flush / 代理重新分块。 */
function slicedSSE(cut: number): Response {
  const enc = new TextEncoder()
  const whole = FRAME + TAIL
  return new Response(new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(whole.slice(0, cut)))
      await Bun.sleep(1)
      c.enqueue(enc.encode(whole.slice(cut)))
      c.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

describe('真 socket:首块多小都不许把正常的流判成非 SSE', () => {
  it('首块 1~6 字节全部照常出流', async () => {
    // `data:` 有 5 个字节。只看第一口的嗅探在 cut=1..4 上全部变成 502,而那条流完全正常。
    for (const cut of [1, 2, 3, 4, 5, 6, 20]) {
      const r = await callServer(() => slicedSSE(cut))
      expect(`cut=${cut} status=${r.status}`).toBe(`cut=${cut} status=200`)
      expect(`cut=${cut} 正文在: ${r.text.includes('正文')}`).toBe(`cut=${cut} 正文在: true`)
    }
  })

  it('首块是一个多字节字符的半截时,不把非 SSE 的正文判成 SSE', async () => {
    // `decode(…,{stream:true})` 对半个字符返回空串 —— 只看第一口时这会判成「是 SSE」。
    const enc = new TextEncoder()
    const bytes = enc.encode('你好,这不是 SSE')
    const r = await callServer(() => new Response(new ReadableStream({
      async start(c) { c.enqueue(bytes.slice(0, 1)); await Bun.sleep(1); c.enqueue(bytes.slice(1)); c.close() },
    })))
    expect(r.status).toBe(502)
    expect(r.message).toContain('不是 SSE')
    expect(r.message).toContain('你好')
  })

  it('注释行开头的 keepalive 保活流认得出来', async () => {
    // `: ping` 是网关保活最常用的形状,而它也是合法的 SSE 行首。
    const r = await callServer(() => new Response(': ping\n\n' + FRAME + TAIL, { headers: { 'content-type': 'text/event-stream' } }))
    expect(r.status).toBe(200)
    expect(r.text).toContain('正文')
  })
})

describe('真 socket:状态码与行首', () => {
  it('上游的状态码**原样透传** —— 上层的重试策略读的是它', async () => {
    // 代码注释明写「好让上层的重试策略照旧」,而评审的变异发现:一律改成 502 之后
    // 全量测试一条不红。429(限流,该退避重试)和 503(该重试)会被当成 502 处理。
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const r = await callServer(() => new Response('{"error":{"message":"x"}}', { status }))
      expect(`上游 ${status} → 返回 ${r.status}`).toBe(`上游 ${status} → 返回 ${status}`)
    }
  })

  it('SSE 的四种行首全部认得 —— 认错一个就是把正常的流打成硬 502', async () => {
    // `: ping` 是网关保活最常用的形状;`id:` / `retry:` 也是合法行首。
    for (const head of ['data: ', 'event: msg\ndata: ', 'id: 1\ndata: ', 'retry: 1000\ndata: ', ': ping\n\ndata: ']) {
      const sse = head + JSON.stringify({ id: 'x', choices: [{ delta: { content: '正文' } }] }) + '\n\n' + TAIL
      const r = await callServer(() => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
      expect(`${JSON.stringify(head)} → ${r.status}`).toBe(`${JSON.stringify(head)} → 200`)
    }
  })

})

describe('真 socket:200 但完全空白', () => {
  it('空体 200 报错,而不是变成一次成功的空回答', async () => {
    /**
     * 这条路以前靠 `if (!res.body)` 挡,而 `res.body` 在真 socket 上**永远不是 null**——
     * 于是空体 200 一路走完管道,用户拿到一次「成功但完全空白」的回答,流水线还会把这个
     * 空回答当成这一席的真实产出往下走。
     */
    const r = await callServer(() => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    expect(r.status).toBe(502)
    // 「一个字节都没返回」和「返回的不是 SSE」是**两句不同的话**:前者是上游收下请求就
    // 断开(源站挂了、连接被掐),后者是它认真回了个东西、只是不流。两条排查路径不一样。
    expect(r.message).toContain('一个字节都没返回')
    expect(r.message).toContain('重试')
    expect(r.message).toContain('(空)')
    // 而且这一档不许退化成「成功」:整条响应里不能有 message_stop。
    expect(r.text).not.toContain('message_stop')
  })

  it('204 同样', async () => {
    const r = await callServer(() => new Response(null, { status: 204 }))
    expect(r.status).toBe(502)
  })
})

describe('真 socket:连不上', () => {
  it('DNS / 拒连 → 一句带员工名和真实 URL 的话,不是引擎的通用「检查你的网络连接」', async () => {
    // 端口上没有人在听。这一支以前没有 catch,异常直接穿过整个翻译层。
    const f = buildRoleFetch(cfg({ apiUrl: 'http://127.0.0.1:1/v1', roleName: '架构评审员' }))
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: new Headers(), body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    })
    expect(res.status).toBe(502)
    const msg = (await res.json() as { error: { message: string } }).error.message
    expect(msg).toContain('架构评审员')
    expect(msg).toContain('http://127.0.0.1:1/v1/chat/completions')
    expect(msg).toContain('连不上')
    expect(msg).toContain('代理')
  })

  it('**中断不许被翻译成 502** —— 那是用户按了 Esc,不是 provider 挂了', async () => {
    const srv = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(5000); return new Response('') } })
    try {
      const f = buildRoleFetch(cfg({ apiUrl: `http://localhost:${srv.port}/v1` }))
      const ac = new AbortController()
      const p = f('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: new Headers(), signal: ac.signal,
        body: JSON.stringify({ model: 'm', messages: [], stream: true }),
      })
      setTimeout(() => ac.abort(), 20)
      // 抛出去,而不是变成一个假的 502 —— 上层按 abort 处理,把它当 provider 故障
      // 会去劝用户提高超时,而他刚刚亲手按了取消。
      await expect(p).rejects.toThrow()
    } finally {
      srv.stop(true)
    }
  })
})

describe('真 socket:报错到得了用户眼前', () => {
  it('失败体带**顶层** message —— 否则 SDK 会把整个 body JSON.stringify 当报错正文', async () => {
    /**
     * SDK 的 `APIError.makeMessage` 读的是顶层 `message`,读不到就退到
     * `JSON.stringify(整个 body)`。于是那句人话被塞进一个 JSON 壳里,而详情页
     * 「阻断原因」默认只给 3 行预览 —— 用户看到的第一行是
     * `API Error: 502 {"type":"error","error":{"type":"api_error","message":"员工「`,
     * 和他最初报障时贴的那一串**逐字相同**。
     */
    const r = await callServer(() => new Response(null, { status: 502, statusText: 'Bad Gateway' }))
    const body = JSON.parse(r.text) as { message?: string; error?: { message?: string } }
    expect(body.message).toBe(body.error?.message)
    expect(body.message).toContain('员工「员工甲」')
    // anthropic 的嵌套形状也留着 —— 别的读者(将来的)按老形状读一样拿得到。
    expect(body.error?.type).toBe('api_error')
  })

  it('流式请求明说要 SSE,不再原样透传 SDK 的 Accept: application/json', async () => {
    // 做内容协商的严格网关看到 `application/json` 完全有理由回一个非流式 JSON,
    // 而那正好会撞进「200 但不是 SSE」那条硬失败。
    let seen = ''
    const r = await callServer(req => {
      seen = req.headers.get('accept') ?? ''
      return new Response(FRAME + TAIL, { headers: { 'content-type': 'text/event-stream' } })
    })
    expect(r.status).toBe(200)
    expect(seen).toBe('text/event-stream')
  })

  it('上游的 5xx 原文原样带回来,状态码也原样透传', async () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body><center>nginx/1.24.0</center></body></html>'
    const r = await callServer(() => new Response(html, { status: 502 }))
    expect(r.status).toBe(502)
    expect(r.message).toContain('nginx/1.24.0')
    // 上游给了内容,就不能再讲「空体 502」那一套。
    expect(r.message).toContain('它自己的说法')
    expect(r.message).not.toContain('(空)')
  })
})
