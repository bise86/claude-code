/**
 * **raw 和 sdk 两条传输必须是同一件事** —— 对 **openai 家族的两条协议都成立**。
 *
 * 假上游对两条路是**同一个** `inner`:raw 档自己调它,sdk 档把它当作
 * `new OpenAI({ fetch })` 交进去。同一份上游字节喂进去,翻译出来的 anthropic 事件流
 * 必须逐字相等,出网地址和鉴权头也必须相同。
 *
 * 请求体只允许有**一个**差异:`openai-responses` 的 sdk 档多一个 `truncation: 'auto'`
 * (那一档的约定是「这一席的上下文归上游管」)。
 *
 * **`openai`(chat/completions)没有 truncation 这个字段**,所以那条协议的 sdk 档请求体
 * 和 raw **逐字相同**,而它的上下文**仍由我们压**(判据见
 * `roleContextCeiling.upstreamManagesContext`:交不交出去看的是「这条协议接不接得住」,
 * 不是「transport 是不是 sdk」)。这里用一条断言把「chat 的两条传输请求体全等」钉住 ——
 * 哪天有人给 chat 硬塞一个 truncation,它会立刻变红。
 */
import { expect, test } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'

/** responses 协议的帧:每帧带 event 行。 */
const RESPONSES_FRAMES: any[] = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_text.delta', delta: '你' },
  { type: 'response.output_text.delta', delta: '好' },
  { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 22 } } },
]
const responsesSSE = (): string =>
  RESPONSES_FRAMES.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('')

/** chat/completions 的帧:纯 data 行,以 [DONE] 收尾。 */
const CHAT_CHUNKS: any[] = [
  { id: 'chatcmpl_1', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
  { id: 'chatcmpl_1', choices: [{ index: 0, delta: { content: '好' } }] },
  { id: 'chatcmpl_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } },
]
const chatSSE = (): string =>
  `${CHAT_CHUNKS.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`

const PROTOCOLS = [
  { name: 'openai-responses' as const, route: 'responses', sse: responsesSSE, truncates: true },
  { name: 'openai' as const, route: 'chat/completions', sse: chatSSE, truncates: false },
]

const ANTHROPIC_BODY = JSON.stringify({
  model: 'claude-alias',
  max_tokens: 100,
  stream: true,
  messages: [{ role: 'user', content: '你好' }],
})

type Seen = { url: string; body: unknown; auth: string | null }

async function drive(
  protocol: 'openai' | 'openai-responses',
  transport: 'raw' | 'sdk',
  upstream: () => Response,
): Promise<{ seen: Seen[]; text: string; status: number }> {
  const seen: Seen[] = []
  const inner = (async (input: any, init: any = {}) => {
    // SDK 可能传 Request 对象,raw 档传的是 (url, init) —— 两种形状都要收得下。
    const isRequest = typeof input === 'object' && input !== null && typeof input.url === 'string'
    const url = isRequest ? input.url : String(input)
    const rawBody = init?.body ?? (isRequest ? await input.clone().text() : undefined)
    const headers = new Headers(isRequest ? input.headers : (init?.headers as HeadersInit))
    let body: unknown
    try { body = JSON.parse(String(rawBody)) } catch { body = rawBody }
    seen.push({ url, body, auth: headers.get('authorization') })
    return upstream()
  }) as unknown as typeof fetch

  const f = buildRoleFetch({
    apiProtocol: protocol,
    apiUrl: 'https://gw.example/v1',
    apiToken: 'sk-role',
    backendModel: 'gpt-5.1',
    roleName: 'seat',
    transport,
  }, inner)
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: ANTHROPIC_BODY,
  })
  return { seen, text: await res.text(), status: res.status }
}

for (const p of PROTOCOLS) {
  const ok = () => new Response(p.sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })

  test(`[${p.name}] 两条传输打同一个地址、带同一个鉴权头`, async () => {
    const raw = await drive(p.name, 'raw', ok)
    const sdk = await drive(p.name, 'sdk', ok)
    expect(sdk.seen).toHaveLength(1)
    expect(sdk.seen[0]!.url).toBe(raw.seen[0]!.url)
    expect(sdk.seen[0]!.url).toBe(`https://gw.example/v1/${p.route}`)
    expect(sdk.seen[0]!.auth).toBe('Bearer sk-role')
    expect(raw.seen[0]!.auth).toBe('Bearer sk-role')
  })

  test(`[${p.name}] 同一份上游字节 → 逐字相同的 anthropic 事件流`, async () => {
    const raw = await drive(p.name, 'raw', ok)
    const sdk = await drive(p.name, 'sdk', ok)
    expect(sdk.status).toBe(200)
    expect(sdk.text).toBe(raw.text)
    // 两边都空的话上面那条断言毫无意义。
    expect(raw.text).toContain('你')
    expect(raw.text).toContain('11')
  })

  test(`[${p.name}] 请求体的差异清单:${p.truncates ? '只有 truncation' : '一个都没有(这条协议没有 truncation)'}`, async () => {
    const raw = await drive(p.name, 'raw', ok)
    const sdk = await drive(p.name, 'sdk', ok)
    const rawBody = raw.seen[0]!.body as Record<string, unknown>
    const sdkBody = sdk.seen[0]!.body as Record<string, unknown>
    expect(rawBody.truncation).toBeUndefined()
    if (p.truncates) {
      // 有意的那一个差异:上下文归上游管。
      expect(sdkBody.truncation).toBe('auto')
      const { truncation: _dropped, ...rest } = sdkBody
      expect(rest).toEqual(rawBody)
    } else {
      /**
       * chat/completions 侧**没有**这个字段,所以这里逐字相同 —— 而这正是
       * 「openai + sdk 的上下文仍由我们压」那条判据的依据(见 autoCompactLimit.test.ts)。
       */
      expect(sdkBody.truncation).toBeUndefined()
      expect(sdkBody).toEqual(rawBody)
    }
  })
}

test('上游报错:两条路都给出带员工名的诊断,状态码原样透传给上层的重试策略', async () => {
  const bad = () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
  const raw = await drive('openai-responses', 'raw', bad)
  const sdk = await drive('openai-responses', 'sdk', bad)
  // 状态码不能被吞:withRetry 读它来决定退避(这个 fork 的策略是所有错误都重试)。
  expect(raw.status).toBe(404)
  expect(sdk.status).toBe(404)
  for (const t of [raw.text, sdk.text]) {
    expect(t).toContain('员工「seat」')
    expect(t).toContain('model not found')
  }
  // 灰度期间「切了 sdk 之后开始报」和「本来就报」必须分得开。
  expect(sdk.text).toContain('sdk 传输')
  expect(raw.text).not.toContain('sdk 传输')
})

test('连不上:sdk 档也走同一句诊断,并以 502 交给上层重试', async () => {
  const boom = () => { throw new Error('ECONNREFUSED') }
  const sdk = await drive('openai-responses', 'sdk', boom as any)
  expect(sdk.status).toBe(502)
  expect(sdk.text).toContain('员工「seat」')
  expect(sdk.text).toContain('连不上')
})

/**
 * **sdk 档的失败必须落进退避重试**,而且落进的是**我们这一套**,不是 SDK 自带的那套。
 *
 * 客户端上写死 `maxRetries: 0`(见 sdkTransport 的文件头):SDK 默认重试 2 次且**按状态码
 * 分档**(400 它不重试),而这个仓库的策略是所有错误都重试、10 次、0.5s 起翻倍到 32s。
 * 两套叠起来是乘法,退避曲线还会错乱 —— SDK 自己先退两次,我们这边只记了第一次。
 *
 * 这条把两端钉在一起:上面几条测出 sdk 档失败时返回的**状态码原样透传**,这里测那些
 * 状态码在 `shouldRetry` 下都为真。中间那一段(SDK 把响应变成 APIError)是
 * `@anthropic-ai/sdk` 的既有行为。
 */
import { APIError } from '@anthropic-ai/sdk'
import { shouldRetry } from '../withRetry.js'

test('sdk 档会返回的那些状态码,都会被上层重试', () => {
  // 404 上游报错、502 连不上/翻译层判失败、500 网关内部错、429 限流。
  for (const status of [404, 429, 500, 502]) {
    expect(`${status}: ${shouldRetry(new APIError(status, { message: 'x' }, undefined, new Headers()))}`)
      .toBe(`${status}: true`)
  }
})

/**
 * **sdk 档必须补回 raw 档 `sniffSSE` 的那两条判断。**
 *
 * 验收实测(这一组就是从那次实测长出来的):上游回 200 的 JSON、或者 200 空体时,
 * SDK **不抛错**,只是一帧都不产出 —— 于是这一席交出一次「成功但完全空白」的回答,
 * 状态码 200,而流水线把这个空回答当成真实产出继续往下走。raw 档对这两种都回 502。
 *
 * 一次「空白的成功」比一次失败贵得多:失败会被 `withRetry` 重试,空白不会。
 */
const notSSE = () => new Response(JSON.stringify({ id: 'resp', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
const emptySSE = () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })

test('200 但不是 SSE:两条传输都回 502,而且带上游原文', async () => {
  const raw = await drive('openai-responses', 'raw', notSSE)
  const sdk = await drive('openai-responses', 'sdk', notSSE)
  for (const r of [raw, sdk]) {
    expect(r.status).toBe(502)
    // 正文是一层 JSON 壳,诊断在 message 里 —— 解出来比在转义过的字符串上做子串匹配可靠。
    const msg = String((JSON.parse(r.text) as { message?: unknown }).message)
    expect(msg).toContain('200 但不是 SSE')
    expect(msg).toContain('"output":[]')   // 上游原文是诊断的第一手材料
  }
})

test('200 空体:两条传输都回 502', async () => {
  const raw = await drive('openai-responses', 'raw', emptySSE)
  const sdk = await drive('openai-responses', 'sdk', emptySSE)
  for (const r of [raw, sdk]) {
    expect(r.status).toBe(502)
    expect(r.text).toContain('一个字节都没返回')
  }
})

test('非流式请求体:sdk 档在发出去之前就判失败,不产出空白成功', async () => {
  const seen: unknown[] = []
  const inner = (async () => { seen.push(1); return notSSE() }) as unknown as typeof fetch
  const f = buildRoleFetch({
    apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/v1', apiToken: 'sk',
    backendModel: 'gpt-5.1', roleName: 'seat', transport: 'sdk',
  }, inner)
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: new Headers(),
    body: JSON.stringify({ model: 'claude-alias', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(res.status).toBe(502)
  expect(await res.text()).toContain('只走流式')
  expect(seen).toHaveLength(0) // 一次都没出网
})

/**
 * 中止**原样抛**,不能翻译成上游故障 —— 用户按 Esc / 阶段闸门开火走的都是这条。
 * 判法见 `isSdkAbort`:openai 的 `APIUserAbortError` 的 `name` 实测是 `Error`,
 * 只看 name 会漏,而它又 `instanceof APIError`,漏掉就会被当成「连不上」翻成 502。
 */
test('已中止的请求:sdk 档抛出去,不合成 502', async () => {
  const inner = (async () => new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
  const f = buildRoleFetch({
    apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/v1', apiToken: 'sk',
    backendModel: 'gpt-5.1', roleName: 'seat', transport: 'sdk',
  }, inner)
  const ac = new AbortController()
  ac.abort()
  let threw: unknown
  try {
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: new Headers(), body: ANTHROPIC_BODY, signal: ac.signal })
  } catch (e) { threw = e }
  expect(threw).toBeDefined()
  expect(String((threw as Error)?.message)).toContain('abort')
})
