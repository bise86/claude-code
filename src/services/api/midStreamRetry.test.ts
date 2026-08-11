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
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message.js'

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
 * **把 VCR 支到一个一次性目录去。**
 *
 * `shouldUseVCR()` 在 `NODE_ENV === 'test'` 下恒为真,于是第一次跑会把这次交互录成磁带
 * 写进仓库根的 `fixtures/`,之后每一次都是**回放** —— fetchOverride 一次都不会被调到
 * (实测:calls 从 2 变成 0,而失败点在回放的记账代码里)。这一档数的就是出网次数,
 * 回放会让它永远量不到真实行为。
 */
process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = mkdtempSync(join(tmpdir(), 'midstream-vcr-'))
// 客户端建不起来就一次网都不出,而这一档数的正是出网次数。**在文件里自己给**,不靠
// 命令行传:整套跑的时候没人会替这一个文件设环境变量(实测:单跑绿、全量跑红)。
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-a-real-secret'

const { queryModelWithStreaming } = await import('./claude.js')
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

/** **每条用例一份新的、而且正文各不相同** —— VCR 按消息内容做磁带的键,两条用例说同一句话时,
 * 第二条会命中第一条刚录下的磁带,一次网都不出(实测 calls 从 1 掉到 0)。 —— 这条链路会往消息数组里追加,共用一份的话第二条用例拿到的是
 * 第一条跑完的残留(实测:它在 `message.message.model` 上炸掉,一次网都没出)。 */
const messagesFixture = (text: string): Message[] => [
  { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', timestamp: '' } as never,
]

describe('流中途的错误帧要能整轮重来', () => {
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

  /**
   * 反向:**已经吐过正文之后不许重来** —— 否则同一段话会说两遍,工具调用甚至跑两次。
   * 变异:把 `emittedToCaller` 从判据里去掉 → 这条红(calls 会变成 2)。
   */
  it('已经吐过正文再断:不重来,原样报错', async () => {
    let calls = 0
    const fetchFn = streamOnly(async () => {
      calls++
      return sseResponse([MESSAGE_START, TEXT_AND_STOP.split('event: content_block_stop')[0]!, OVERLOADED_FRAME])
    })
    const gen = queryModelWithStreaming({
      messages: messagesFixture('probe-2'),
      systemPrompt: [] as never,
      thinkingConfig: { type: 'disabled' },
      tools: [] as never,
      signal: new AbortController().signal,
      options: optionsWith(fetchFn as never),
    })
    await drain(gen as never)
    expect(calls).toBe(1)
  }, 60_000)
})
