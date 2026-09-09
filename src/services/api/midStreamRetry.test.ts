/**
 * **流已经建起来之后才失败的那一类,要能整轮重来。**
 *
 * 用户报的现场(`/et` 席位,逐字):
 *
 *     ▸ 执行 第1轮 · 研发    ● 已完成 · 3s
 *     │ 最新: API Error: {"type":"error","error":{"type":"api_error",
 *                         "message":"Our servers are currently overloaded. Please try again later."}}
 *
 * 三秒、零重试。而判据(`shouldRetry` + `errorPayload`)在这一帧上是**对的** —— 病根是
 * 它根本不会被问到:`withRetry` 的 operation 返回的是 `Stream` 对象本身,try 到那一行
 * 就结束了,而这一帧是在 `for await` 消费流的时候才抛的,已经在循环外面。
 *
 * 所以这一档**必须从真的出网接缝上看**,不能像 errorPayload.test.ts 那样在 operation
 * 回调里 throw —— 那个形状恰恰是「在循环里面抛」,它绿了一整天,而真实链路一次都没重试过。
 * 这里数的是 `fetchOverride` 被调了几次:它是 `/et` 的员工链路真正出网的那一层。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message.js'
import { buildRoleFetch } from './openaiCompat/roleFetch.js'
import { withContextNoticeSink } from './contextNoticeSink.js'

/**
 * `MACRO` 是打包时注入的全局(版本号那些),`bunfig.toml` 的 preload 在
 * `bun test <单个文件>` 这种调用形式下**不生效** —— 实测:探针里
 * `typeof globalThis.MACRO` 是 `undefined`,而 claude.ts 一进去就要用它算指纹。
 * 所以这里自己兜一份,再**动态**导入 claude.js(静态 import 会被提升到这之前)。
 */
;(globalThis as { MACRO?: unknown }).MACRO ??= {
  VERSION: '999.0.0-test',
  PACKAGE_URL: 'claude-code-test',
  NATIVE_PACKAGE_URL: 'claude-code-test',
  BUILD_TIME: '1970-01-01T00:00:00.000Z',
  FEEDBACK_CHANNEL: 'local',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '',
}

/**
 * **VCR 必须让开,而且只能在这两条用例期间让开。**
 *
 * `shouldUseVCR()` 在 `NODE_ENV === 'test'` 下恒为真,于是这条链路默认走磁带,而这一档
 * 数的正是**出网次数** —— 回放会让它永远量不到真实行为。两种环境两种坏法,都实测过:
 *
 *  - 本地:第一次跑把交互录进仓库根的 `fixtures/`,之后每次都是回放,`fetchOverride`
 *    一次都不调(calls 从 2 变 0);
 *  - CI(`env.isCI`):没有磁带时**直接抛** `Anthropic API fixture missing`,`f()` 压根
 *    不执行 —— 这就是 CI 上那两条 `Received: 0`。
 *
 * 所以磁带目录支到一次性临时目录,并且打开 `VCR_RECORD` 让 CI 那条分支去「录」(录 =
 * 真的调用底下那个函数)。
 *
 * **三个环境变量都在 beforeAll 里设、afterAll 里还回去**,不再写在模块顶层:同一个进程
 * 里跑着上百个测试文件,一个被支走的 fixtures 根目录会让**别人的**磁带全部找不到,
 * 而一个常开的 `VCR_RECORD` 会把别人「缺磁带就该报错」这条保护悄悄关掉。
 */
const FIXTURES_ROOT = mkdtempSync(join(tmpdir(), 'midstream-vcr-'))
const SAVED: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ['CLAUDE_CODE_TEST_FIXTURES_ROOT', 'VCR_RECORD', 'ANTHROPIC_API_KEY']) {
    SAVED[k] = process.env[k]
  }
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = FIXTURES_ROOT
  process.env.VCR_RECORD = '1'
  // 客户端建不起来就一次网都不出。**自己给**,不靠命令行传:整套跑的时候没人会替这一个
  // 文件设环境变量(实测:单跑绿、全量跑红)。
  process.env.ANTHROPIC_API_KEY ??= 'test-key-not-a-real-secret'
})

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(FIXTURES_ROOT, { recursive: true, force: true })
})

const { queryModelWithStreaming } = await import('./claude.js')
const { handleMessageFromStream } = await import('../../utils/messages.js')
type Options = Awaited<typeof import('./claude.js')>['Options'] extends never
  ? never
  : Parameters<typeof queryModelWithStreaming>[0]['options']

/** 一条真的 SSE 响应:先把流开起来,再吐一帧 error —— 网关最常见的那个形状。 */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const MESSAGE_START =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'

/** 跑机上逐字的那一帧。 */
const OVERLOADED_FRAME =
  'event: error\n' +
  'data: {"type":"error","error":{"type":"api_error","message":"Our servers are currently overloaded. Please try again later."}}\n\n'

const TEXT_AND_STOP =
  'event: content_block_start\n' +
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"答上来了"}}\n\n' +
  'event: content_block_stop\n' +
  'data: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n' +
  'event: message_stop\n' +
  'data: {"type":"message_stop"}\n\n'

/**
 * 只走流式的链路 —— `/et` 的 openai / openai-responses 员工就是这么标记的
 * (见 isStreamOnlyFetch:标记打在真正出网的那个 fetch 上)。
 */
function streamOnly<T extends (...args: never[]) => Promise<Response>>(fetchFn: T): T {
  // 标记必须用**真的那个 symbol**(roleFetch.ts 里的 `Symbol.for(...)`)。第一版这里自己
  // 编了个字符串属性名,于是 `isStreamOnlyFetch` 判 false → 走的是非流式回退那条老路,
  // 而测试照样看见「出网两次」。差点把一条根本没执行到新代码的用例当成通过 ——
  // 现在多一条「第二次必须还是流式请求」的断言把这个形状钉死。
  Object.defineProperty(fetchFn, Symbol.for('claude-code.roleFetch.streamOnly'), {
    value: true,
  })
  return fetchFn
}

function optionsWith(fetchOverride: Options['fetchOverride']): Options {
  return {
    getToolPermissionContext: async () => ({}) as never,
    model: 'claude-opus-5',
    isNonInteractiveSession: true,
    querySource: 'agent:default',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [] as never,
    fetchOverride,
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<{ ok: boolean; error?: unknown }> {
  try {
    for await (const _ of gen) {
      /* 事件本身这一档不关心,只关心出网了几次 */
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e }
  }
}

/**
 * **每条用例一份新的、而且正文各不相同。** 两件事各自都实测过:
 *  - 共用同一个数组:这条链路会往里追加,第二条用例拿到的是第一条跑完的残留,
 *    在 `message.message.model` 上炸掉,一次网都没出;
 *  - 说同一句话:VCR 按消息内容做磁带的键,第二条会命中第一条刚录下的磁带(calls 掉到 0)。
 */
const messagesFixture = (text: string): Message[] => [
  { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', timestamp: '' } as never,
]

describe('会话轮换重试:真实 HTTP 与 SSE 链路', () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  let restoreClock = () => {}
  let oldMax: string | undefined
  beforeEach(() => {
    oldMax = process.env.CLAUDE_CODE_MAX_RETRIES
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    // 此组验证请求/计数/标识,仅加速退避等待;间隔由现有 nextRetryDelay 用例验证。
    const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
      realSetTimeout(fn, ms !== undefined && ms >= 3_000 && ms <= 90_000 ? 0 : ms, ...args)) as typeof setTimeout)
    restoreClock = () => clock.mockRestore()
  })
  afterEach(() => {
    restoreClock()
    if (oldMax === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
    else process.env.CLAUDE_CODE_MAX_RETRIES = oldMax
  })
  const frame = (type: string, extra: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`
  const start = frame('response.created', { response: { id: 'resp-rotation' } })
  const failure = frame('error', { error: { type: 'server_error', message: 'rotation probe failure' } })
  const success = () => sseResponse([start,
    frame('response.output_text.delta', { delta: '恢复成功' }),
    frame('response.completed', { response: {} })])

  async function probe(opts: {
    name: string; transport?: 'raw' | 'sdk'; mode?: 'http' | 'sse' | 'mixed'
    protocol?: 'openai' | 'openai-responses'; overflowFirst?: boolean
    enabled?: boolean; succeedAt?: number; cancelOnRotation?: boolean; toolBeforeError?: boolean
  }) {
    const seen: { headers: Headers; body: any }[] = []
    const retries: number[] = []
    const delays: number[] = []
    const notices: { kind: string; text: string }[] = []
    const texts: string[] = []
    let finalErrors = 0
    const abort = new AbortController()
    const fetch = buildRoleFetch({
      apiProtocol: opts.protocol ?? 'openai-responses', transport: opts.transport ?? 'raw',
      apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
      rotateSessionOnRetry: opts.enabled ?? true,
    }, (async (input: any, init: any = {}) => {
      const raw = init.body ?? (input instanceof Request ? await input.clone().text() : '{}')
      seen.push({ headers: new Headers(init.headers ?? input.headers), body: JSON.parse(String(raw)) })
      if (seen.length > 20) { abort.abort(); throw new Error('重试次数未收口') }
      if (seen.length === opts.succeedAt) return success()
      if (opts.overflowFirst && seen.length === 1) {
        return new Response(JSON.stringify({ error: {
          type: 'invalid_request_error',
          message: 'input length and `max_tokens` exceed context limit: 10000 + 6000 > 15000',
        } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      if (opts.toolBeforeError) return sseResponse([start, frame('response.output_item.done', {
        item: { type: 'function_call', id: 'fc-rotation', call_id: 'call-rotation', name: 'Read', arguments: '{}' },
      }), failure])
      if (opts.mode === 'http' || (opts.mode === 'mixed' && seen.length % 2 === 1)) {
        return new Response('{"error":{"type":"server_error","message":"rotation probe failure"}}',
          { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return sseResponse([start, frame('response.output_text.delta', { delta: '失败预览' }), failure])
    }) as typeof globalThis.fetch)
    await withContextNoticeSink(n => {
      notices.push(n)
      if (opts.cancelOnRotation && n.kind === 'api-session-rotated') abort.abort()
    }, async () => {
      for await (const event of queryModelWithStreaming({
        messages: messagesFixture(`rotation-${opts.name}`), systemPrompt: [] as never,
        thinkingConfig: { type: 'disabled' }, tools: [] as never,
        signal: abort.signal, options: optionsWith(fetch),
      })) {
        if (event.type === 'system' && event.subtype === 'api_error') {
          retries.push(event.retryAttempt)
          delays.push(event.retryInMs)
        }
        if (event.type === 'assistant') {
          if (event.isApiErrorMessage) finalErrors++
          else for (const block of event.message.content) if (block.type === 'text') texts.push(block.text)
        }
      }
    })
    return { seen, retries, delays, notices, texts, finalErrors }
  }

  for (const transport of ['raw', 'sdk'] as const) {
    for (const mode of ['http', 'sse', 'mixed'] as const) {
      it(`${transport}/${mode}: 三组会话共 19 次请求,轮换两次,路由键始终相同`, async () => {
        const p = await probe({ name: `${transport}-${mode}`, transport, mode })
        expect(p.seen).toHaveLength(19)
        const sessions = p.seen.map(s => s.headers.get('session-id'))
        expect(new Set(sessions).size).toBe(3)
        expect(new Set(sessions.slice(0, 4)).size).toBe(1)
        expect(new Set(sessions.slice(4, 8)).size).toBe(1)
        expect(new Set(sessions.slice(8)).size).toBe(1)
        expect(new Set(p.seen.map(s => s.body.prompt_cache_key)).size).toBe(1)
        expect(new Set(p.seen.map(s => s.headers.get('x-client-request-id'))).size).toBe(19)
        expect(p.retries).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(p.delays.slice(0, 9)).toEqual([3000, 6000, 10000, 3000, 6000, 10000, 3000, 6000, 10000])
        expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(2)
        expect(p.finalErrors).toBe(1)
        expect(p.texts).toEqual([])
      })
    }
    it(`${transport}: 更换后的首次请求成功,停止重试且只提交成功内容`, async () => {
      const p = await probe({ name: `${transport}-recovered`, transport, mode: 'mixed', succeedAt: 5 })
      expect(p.seen).toHaveLength(5)
      expect(p.finalErrors).toBe(0)
      expect(p.texts).toEqual(['恢复成功'])
      expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(1)
    })
    it(`${transport}/chat: 同样最多 19 次请求,保持原有请求体`, async () => {
      const p = await probe({ name: `${transport}-chat`, transport, protocol: 'openai', mode: 'http' })
      expect(p.seen).toHaveLength(19)
      expect(new Set(p.seen.map(s => s.headers.get('session-id'))).size).toBe(3)
      expect(p.seen.every(s => JSON.stringify(s.body) === JSON.stringify(p.seen[0].body))).toBe(true)
      expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(2)
      expect(p.finalErrors).toBe(1)
    })
    it(`${transport}: 开启后仍会修正上下文超限的输出上限`, async () => {
      const p = await probe({ name: `${transport}-overflow`, transport, overflowFirst: true, succeedAt: 2 })
      expect(p.seen).toHaveLength(2)
      expect(p.seen[1].body.max_output_tokens).toBe(4000)
      expect(p.seen[1].body.prompt_cache_key).toBe(p.seen[0].body.prompt_cache_key)
      expect(p.retries).toEqual([1])
      expect(p.texts).toEqual(['恢复成功'])
      expect(p.finalErrors).toBe(0)
    })
  }

  it('关闭开关仍是原来的 10 次重试,不轮换', async () => {
    const p = await probe({ name: 'disabled', mode: 'http', enabled: false })
    expect(p.seen).toHaveLength(11)
    expect(new Set(p.seen.map(s => s.headers.get('session-id'))).size).toBe(1)
    expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(0)
  })
  it('用户设置的 2 次预算仍优先,不因轮换扩张', async () => {
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    const p = await probe({ name: 'small-budget', mode: 'mixed' })
    expect(p.seen).toHaveLength(3)
    expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(0)
  })
  it('轮换等待期间取消不会发出新请求', async () => {
    const p = await probe({ name: 'cancel', mode: 'mixed', cancelOnRotation: true })
    expect(p.seen).toHaveLength(4)
    expect(p.finalErrors).toBe(0)
    expect(p.texts).toEqual([])
  })
  it('已经输出工具调用时不重放,开关不能绕过这道保护', async () => {
    const p = await probe({ name: 'tool', toolBeforeError: true })
    expect(p.seen).toHaveLength(1)
    expect(p.notices.some(n => n.kind === 'api-retry-skipped')).toBe(true)
    expect(p.notices.filter(n => n.kind === 'api-session-rotated')).toHaveLength(0)
  })
})

describe('流中途的错误帧要能整轮重来', () => {
  const frame = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const start = frame('response.created', { type: 'response.created', response: { id: 'resp-overload' } })
  const reasoning = frame('response.output_item.done', {
    type: 'response.output_item.done',
    item: { id: 'rs-hidden', type: 'reasoning', encrypted_content: 'opaque-reasoning' },
  })
  const overloaded = frame('error', {
    type: 'error',
    error: {
      type: 'service_unavailable_error', code: 'server_is_overloaded',
      message: 'Our servers are currently overloaded. Please try again later.', param: null,
    },
  })

  const serverError = frame('error', {
    type: 'error',
    error: {
      type: 'server_error', code: 'server_error',
      message: 'An error occurred while processing your request. You can retry your request.',
    },
  })
  const thinkingDelta = frame('response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta', delta: '失败尝试的思考',
  })
  const textDelta = frame('response.output_text.delta', {
    type: 'response.output_text.delta', delta: '失败尝试的正文',
  })

  for (const [name, prefix] of [
    ['no-content', []],
    ['visible-thinking', [thinkingDelta]],
    ['closed-thinking', [thinkingDelta, reasoning]],
    ['partial-text', [textDelta]],
    ['empty-summary-parts', [
      frame('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added' }),
      frame('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added' }),
    ]],
    // 切换块会关闭前面的正文/思考,claude.ts 原来会立即将其作为 assistant 提交。
    ['closed-text-and-thinking', [textDelta, thinkingDelta, reasoning, textDelta]],
  ] as const) {
    it(`SDK server_error 在 ${name} 后发生:重试且不提交失败尝试的内容`, async () => {
      let calls = 0
      const texts: string[] = []
      const notices: string[] = []
      const fetchFn = buildRoleFetch({
        apiProtocol: 'openai-responses', transport: 'sdk',
        apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
      }, (async () => {
        calls++
        return sseResponse(calls === 1 ? [start, ...prefix, serverError] : [
          start,
          frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '重试成功' }),
          frame('response.completed', { type: 'response.completed', response: {} }),
        ])
      }) as typeof fetch)
      await withContextNoticeSink(n => notices.push(n.text), async () => {
        for await (const event of queryModelWithStreaming({
          messages: messagesFixture(`probe-sdk-server-error-${name}`),
          systemPrompt: [] as never, thinkingConfig: { type: 'disabled' }, tools: [] as never,
          signal: new AbortController().signal, options: optionsWith(fetchFn),
        })) {
          if (event.type !== 'assistant') continue
          expect(event.isApiErrorMessage).not.toBe(true)
          for (const block of event.message.content) {
            expect(block.type).toBe('text')
            if (block.type === 'text') texts.push(block.text)
          }
        }
      })
      expect(calls).toBe(2)
      expect(texts).toEqual(['重试成功'])
      expect(notices.filter(n => n.includes('后重试'))).toHaveLength(1)
      expect(notices.find(n => n.includes('后重试'))).toContain('server_error')
    }, 10_000)
  }

  const tool = frame('response.output_item.done', {
    type: 'response.output_item.done',
    item: { type: 'function_call', id: 'fc-once', call_id: 'call-once', name: 'Read', arguments: '{"file_path":"/tmp/probe"}' },
  })

  for (const failAfterTool of [false, true]) {
    it(`SDK 工具调用及时提交、保留块顺序,且之后出错不重复执行(失败: ${failAfterTool})`, async () => {
      let calls = 0
      const notices: string[] = []
      const blockTypes: string[] = []
      let finalErrors = 0
      let toolDelivered = false
      let previewDelivered = false
      const fetchFn = buildRoleFetch({
        apiProtocol: 'openai-responses', transport: 'sdk',
        apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
      }, (async () => {
        calls++
        return sseResponse([start, textDelta, thinkingDelta, reasoning, tool,
          failAfterTool ? serverError : frame('response.completed', { type: 'response.completed', response: {} })])
      }) as typeof fetch)
      await withContextNoticeSink(n => notices.push(n.text), async () => {
        for await (const event of queryModelWithStreaming({
          messages: messagesFixture(`probe-sdk-tool-replay-${failAfterTool}`),
          systemPrompt: [] as never, thinkingConfig: { type: 'disabled' }, tools: [] as never,
          signal: new AbortController().signal, options: optionsWith(fetchFn),
        })) {
          if (event.type === 'stream_event' && event.event.type === 'content_block_delta') {
            previewDelivered = true
          }
          if (event.type === 'stream_event' && event.event.type === 'message_delta') {
            // VCR preserves event order, though it buffers the generator while
            // recording. Verify the tool is yielded before response completion.
            expect(toolDelivered).toBe(true)
          }
          if (event.type !== 'assistant') continue
          if (event.isApiErrorMessage) {
            expect(toolDelivered).toBe(true)
            finalErrors++
          } else {
            expect(previewDelivered).toBe(true)
            for (const block of event.message.content) {
              blockTypes.push(block.type)
              if (block.type === 'tool_use') toolDelivered = true
              if (block.type === 'thinking') expect(block.signature).toBeTruthy()
            }
          }
        }
      })
      expect(calls).toBe(1)
      expect(blockTypes).toEqual(['text', 'thinking', 'tool_use'])
      expect(finalErrors).toBe(failAfterTool ? 1 : 0)
      expect(notices.some(n => n.includes('为避免重复执行'))).toBe(failAfterTool)
    }, 10_000)
  }

  it('SDK 已输出并关闭思考块后持续 server_error:按配置重试到上限', async () => {
    const savedRetries = process.env.CLAUDE_CODE_MAX_RETRIES
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    let finalErrors = 0
    const attempts: number[] = []
    try {
      const fetchFn = buildRoleFetch({
        apiProtocol: 'openai-responses', transport: 'sdk',
        apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
      }, (async () => {
        calls++
        return sseResponse([start, textDelta, thinkingDelta, reasoning, serverError])
      }) as typeof fetch)
      for await (const event of queryModelWithStreaming({
        messages: messagesFixture('probe-sdk-visible-server-error-exhausted'),
        systemPrompt: [] as never, thinkingConfig: { type: 'disabled' }, tools: [] as never,
        signal: new AbortController().signal, options: optionsWith(fetchFn),
      })) {
        if (event.type === 'system' && event.subtype === 'api_error') attempts.push(event.retryAttempt)
        if (event.type === 'assistant') {
          expect(event.isApiErrorMessage).toBe(true)
          expect(JSON.stringify(event.message.content)).toContain('server_error')
          finalErrors++
        }
      }
      expect(calls).toBe(3)
      expect(attempts).toEqual([1, 2])
      expect(finalErrors).toBe(1)
    } finally {
      if (savedRetries === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
      else process.env.CLAUDE_CODE_MAX_RETRIES = savedRetries
    }
  }, 10_000)

  it('SDK server_error 退避期间取消:不再请求,也不提交失败内容', async () => {
    const controller = new AbortController()
    let calls = 0
    let assistantMessages = 0
    const fetchFn = buildRoleFetch({
      apiProtocol: 'openai-responses', transport: 'sdk',
      apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
    }, (async () => {
      calls++
      return sseResponse([start, thinkingDelta, reasoning, serverError])
    }) as typeof fetch)
    await withContextNoticeSink(n => {
      if (n.kind === 'api-retry') controller.abort()
    }, async () => {
      for await (const event of queryModelWithStreaming({
        messages: messagesFixture('probe-sdk-visible-server-error-abort'),
        systemPrompt: [] as never, thinkingConfig: { type: 'disabled' }, tools: [] as never,
        signal: controller.signal, options: optionsWith(fetchFn),
      })) {
        if (event.type === 'assistant') assistantMessages++
      }
    })
    expect(controller.signal.aborted).toBe(true)
    expect(calls).toBe(1)
    expect(assistantMessages).toBe(0)
  })

  it('新尝试的 message_start 清空失败尝试的实时预览', () => {
    let text: string | null = '失败尝试的正文'
    let thinking: unknown = { thinking: '失败尝试的思考', isStreaming: true }
    let tools: unknown[] = [{}]
    handleMessageFromStream({
      type: 'stream_event', event: { type: 'message_start', message: {} },
    } as never, () => {}, () => {}, () => {}, f => { tools = f(tools as never) },
    undefined, f => { thinking = f(thinking as never) }, undefined, f => { text = f(text) })
    expect(text).toBeNull()
    expect(thinking).toBeNull()
    expect(tools).toEqual([])
  })

  for (const hiddenReasoning of [false, true]) {
    it(`SDK Responses 连续两次流中 server_is_overloaded 后恢复(隐藏推理: ${hiddenReasoning})`, async () => {
      let calls = 0
      const notices: string[] = []
      const errors: string[] = []
      const texts: string[] = []
      const fetchFn = buildRoleFetch({
        apiProtocol: 'openai-responses', transport: 'sdk',
        apiUrl: 'https://gw.example/v1', apiToken: 'test-key',
        backendModel: 'test-model', roleName: '研发',
      }, (async () => {
        calls++
        return sseResponse(calls <= 2 ? [start, ...(calls === 2 && hiddenReasoning ? [reasoning] : []), overloaded] : [
          start,
          frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '答上来了' }),
          frame('response.completed', {
            type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 4 } },
          }),
        ])
      }) as typeof fetch)
      await withContextNoticeSink(n => notices.push(n.text), async () => {
        for await (const event of queryModelWithStreaming({
          messages: messagesFixture(`probe-sdk-repeated-overload-${hiddenReasoning}`),
          systemPrompt: [] as never,
          thinkingConfig: { type: 'disabled' },
          tools: [] as never,
          signal: new AbortController().signal,
          options: optionsWith(fetchFn),
        })) {
          if (event.type !== 'assistant') continue
          for (const block of event.message.content) {
            // 失败尝试的密文不能留在会话里;成功的这次只有正文。
            expect(block.type).not.toBe('thinking')
            if (block.type === 'text') (event.isApiErrorMessage ? errors : texts).push(block.text)
          }
        }
      })
      expect(calls).toBe(3)
      expect(errors).toEqual([])
      expect(texts).toContain('答上来了')
      const retries = notices.filter(n => n.includes('后重试'))
      expect(retries).toHaveLength(2)
      expect(retries[0]).toContain('3s 后重试(第 1/10 次)')
      expect(retries[1]).toContain('6s 后重试(第 2/10 次)')
    }, 20_000)
  }

  it('SDK 隐藏推理后持续过载:用尽配置的重试次数才报最终错误', async () => {
    const savedRetries = process.env.CLAUDE_CODE_MAX_RETRIES
    process.env.CLAUDE_CODE_MAX_RETRIES = '2'
    let calls = 0
    let finalErrors = 0
    const attempts: number[] = []
    try {
      const fetchFn = buildRoleFetch({
        apiProtocol: 'openai-responses', transport: 'sdk',
        apiUrl: 'https://gw.example/v1', apiToken: 'test-key', backendModel: 'test-model',
      }, (async () => {
        calls++
        return sseResponse([start, reasoning, overloaded])
      }) as typeof fetch)
      for await (const event of queryModelWithStreaming({
        messages: messagesFixture('probe-sdk-hidden-overload-exhausted'),
        systemPrompt: [] as never,
        thinkingConfig: { type: 'disabled' },
        tools: [] as never,
        signal: new AbortController().signal,
        options: optionsWith(fetchFn),
      })) {
        if (event.type === 'system' && event.subtype === 'api_error') attempts.push(event.retryAttempt)
        if (event.type === 'assistant') {
          expect(event.isApiErrorMessage).toBe(true)
          finalErrors++
        }
      }
      expect(calls).toBe(3)
      expect(attempts).toEqual([1, 2])
      expect(finalErrors).toBe(1)
    } finally {
      if (savedRetries === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
      else process.env.CLAUDE_CODE_MAX_RETRIES = savedRetries
    }
  }, 20_000)

  it('HTTP 429:完整模型链路默认重试 10 次,共发出 11 次请求', async () => {
    const savedRetries = process.env.CLAUDE_CODE_MAX_RETRIES
    delete process.env.CLAUDE_CODE_MAX_RETRIES
    let calls = 0
    const retries: number[] = []
    let finalError = false
    try {
      const fetchFn = streamOnly(async () => {
        calls++
        return new Response('{"error":{"type":"rate_limit_error","message":"Rate limited"}}', {
          status: 429,
          // 这条测次数;Retry-After: 0 仍受 3s 下限约束,十次共等 30s。
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      })
      for await (const event of queryModelWithStreaming({
        messages: messagesFixture('probe-http-429-default-retries'),
        systemPrompt: [] as never,
        thinkingConfig: { type: 'disabled' },
        tools: [] as never,
        signal: new AbortController().signal,
        options: optionsWith(fetchFn as never),
      })) {
        if (event.type === 'system' && event.subtype === 'api_error') {
          retries.push(event.retryAttempt)
          expect(event.maxRetries).toBe(10)
          expect(event.retryInMs).toBe(3_000)
        }
        if (event.type === 'assistant' && event.isApiErrorMessage) finalError = true
      }
      expect(calls).toBe(11)
      expect(retries).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(finalError).toBe(true)
    } finally {
      if (savedRetries === undefined) delete process.env.CLAUDE_CODE_MAX_RETRIES
      else process.env.CLAUDE_CODE_MAX_RETRIES = savedRetries
    }
  }, 45_000)

  it('先 message_start 再 error:出网两次,第二次拿到答案', async () => {
    const bodies: string[] = []
    let calls = 0
    const fetchFn = streamOnly(async (_url: never, init: never) => {
      calls++
      bodies.push(String((init as { body?: unknown } | undefined)?.body ?? ''))
      return calls === 1
        ? sseResponse([MESSAGE_START, OVERLOADED_FRAME])
        : sseResponse([MESSAGE_START, TEXT_AND_STOP])
    })
    const gen = queryModelWithStreaming({
      messages: messagesFixture('probe-1'),
      systemPrompt: [] as never,
      thinkingConfig: { type: 'disabled' },
      tools: [] as never,
      signal: new AbortController().signal,
      options: optionsWith(fetchFn as never),
    })
    const out = await drain(gen as never)
    // 修之前:calls === 1,而那一席当场死掉。
    expect(calls).toBe(2)
    // 第二次必须还是**流式**请求 —— 否则它就不是这个补丁,而是非流式回退那条路
    // (executeNonStreamingRequest 自带 withRetry,那条路在只走流式的链路上本来就该关着)。
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain('"stream":true')
  }, 60_000)

  it('已经吐过正文再断:仍然重试,只提交成功尝试的正文', async () => {
    let calls = 0
    const fetchFn = streamOnly(async () => {
      calls++
      return calls === 1
        ? sseResponse([MESSAGE_START, TEXT_AND_STOP.split('event: content_block_stop')[0]!, OVERLOADED_FRAME])
        : sseResponse([MESSAGE_START, TEXT_AND_STOP])
    })
    const gen = queryModelWithStreaming({
      messages: messagesFixture('probe-2'),
      systemPrompt: [] as never,
      thinkingConfig: { type: 'disabled' },
      tools: [] as never,
      signal: new AbortController().signal,
      options: optionsWith(fetchFn as never),
    })
    const texts: string[] = []
    for await (const event of gen) {
      if (event.type !== 'assistant') continue
      expect(event.isApiErrorMessage).not.toBe(true)
      for (const block of event.message.content) if (block.type === 'text') texts.push(block.text)
    }
    expect(calls).toBe(2)
    expect(texts).toEqual(['答上来了'])
  }, 60_000)
})
