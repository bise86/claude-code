/**
 * **上游不报用量**时,一趟运行的 token 不能是 0。
 *
 * 用户报的原话:「token 统计效果没有了,而且之前数据也不准确,不管 CLI 还是 API 都要
 * 准确」。API 这一侧最常见的成因就在这里:`stream_options: { include_usage: true }` 是
 * 我们发的,认不认在对面 —— 实测有 OpenAI 兼容网关直接忽略它。那种情况下每次调用的
 * usage 全是 0,而 `/et` 的用量段落在空用量时整段不渲染:用户看到的正是「统计没了」。
 *
 * 0 比一个粗略的估算**更坏**:那些 token 是真花掉的,0 是一句假话。所以这一层的规矩是
 * 「拿不到真数就估,并且标明是估的」。
 *
 * 这份测试走的是**真的翻译层**(buildRoleFetch → 真 SSE → 解析回 anthropic 事件),
 * 不是对着 fallbackUsage 单测 —— 那样证明不了它被接在了链路上。
 */
import { describe, expect, it } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'
import { isEstimatedUsage, _resetEstimatedUsage } from '../tokenEstimate.js'

const cfg = (over: Record<string, unknown> = {}) => ({
  apiProtocol: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiToken: 'sk',
  backendModel: 'gpt-4o', roleName: '员工甲', ...over,
}) as never

/** 一次完整的翻译调用,返回收到的 anthropic SSE 全文和响应头。 */
async function call(sse: string, over: Record<string, unknown> = {}) {
  const inner: typeof fetch = async () =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const f = buildRoleFetch(cfg(over), inner)
  const res = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'anthropic-version': '2023-06-01' }),
    body: JSON.stringify({
      model: 'claude-alias', stream: true, max_tokens: 100,
      messages: [{ role: 'user', content: '请把这个函数改成异步的,并补上单元测试。' }],
    }),
  })
  return { res, text: await res.text() }
}

/** 从翻译出来的 SSE 里挖出 message_delta 上那份 usage。 */
function finalUsage(text: string): { input_tokens: number; output_tokens: number } | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const d = JSON.parse(line.slice(6))
      if (d.type === 'message_delta' && d.usage) return d.usage
    } catch { /* 不是 JSON 的行跳过 */ }
  }
  return undefined
}

const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
const BODY = frame({ id: 'c1', choices: [{ delta: { role: 'assistant', content: '好的,我来改。这里是修改后的实现,以及三条测试。' } }] })
const DONE = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'

describe('上游报了用量', () => {
  it('原样采信,不标成估算', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(BODY + frame({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 45 } }) + DONE)
    expect(finalUsage(text)).toMatchObject({ input_tokens: 321, output_tokens: 45 })
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(false)
  })
})

describe('上游一个用量都不给', () => {
  it('两个数都估出来,而不是留 0', async () => {
    _resetEstimatedUsage()
    const { text } = await call(BODY + DONE)
    const u = finalUsage(text)!
    // 输入侧由发请求那一层估(只有它看得见请求体),输出侧由块写入器边写边累加。
    expect(u.input_tokens).toBeGreaterThan(0)
    expect(u.output_tokens).toBeGreaterThan(0)
  })

  it('这一次被登记成估算 —— 界面上要带 ≈', async () => {
    _resetEstimatedUsage()
    const { res } = await call(BODY + DONE)
    const id = res.headers.get('request-id')
    expect(typeof id).toBe('string')
    expect(isEstimatedUsage(id)).toBe(true)
  })

  it('思考和工具调用也算进产出 —— 一个「想很久说很少」的模型不是免费的', async () => {
    _resetEstimatedUsage()
    const think = frame({ id: 'c1', choices: [{ delta: { reasoning_content: '先看看现有实现……'.repeat(20) } }] })
    const { text: withThink } = await call(think + DONE)
    const { text: without } = await call(frame({ id: 'c1', choices: [{ delta: { content: '' } }] }) + DONE)
    expect(finalUsage(withThink)!.output_tokens).toBeGreaterThan(finalUsage(without)?.output_tokens ?? 0)
  })
})

describe('每次响应都签一个 request-id', () => {
  it('用量表按它去重 —— 第三方网关几乎都不给这个头', async () => {
    const a = await call(BODY + DONE)
    const b = await call(BODY + DONE)
    const ida = a.res.headers.get('request-id')
    const idb = b.res.headers.get('request-id')
    expect(ida).toBeTruthy()
    // 两次调用不能共用身份,否则用量表会把它们合成一次
    expect(ida).not.toBe(idb)
  })
})

/**
 * **只报一半**的网关 —— 评审和验收各自独立实测出来的同一条。
 *
 * `{prompt_tokens: 5000, completion_tokens: 0}` 这种响应真实存在(转发时丢了一半、
 * 或者只在最后一帧带输入侧)。第一版的判据是「两个都为 0 才兜底」,于是这一档整个不触发:
 * 产出记 0,而且**不打 ≈** —— 一个一半真一半假的数,还带着实测的身份,比全 0 更难发现。
 */
describe('上游只报了一半', () => {
  it('只给输入 → 产出估出来,并且整条标成估算', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(BODY + frame({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 0 } }) + DONE)
    const u = finalUsage(text)!
    // 上游给的那一侧原样留着 —— 它比我们的估算准
    expect(u.input_tokens).toBe(5000)
    expect(u.output_tokens).toBeGreaterThan(0)
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(true)
  })

  it('只给产出 → 输入估出来,并且整条标成估算', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(BODY + frame({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 55 } }) + DONE)
    const u = finalUsage(text)!
    expect(u.output_tokens).toBe(55)
    expect(u.input_tokens).toBeGreaterThan(0)
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(true)
  })

  it('两个都给了就一个字都不改,也不标估算', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(
      BODY + frame({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 } } }) + DONE,
    )
    // 缓存那一格是上游自己算的,我们估不出来 —— 它必须原样留着
    expect(finalUsage(text)).toMatchObject({ input_tokens: 800, output_tokens: 12, cache_read_input_tokens: 100 })
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(false)
  })

  it('工具调用的参数计入产出估算 —— 执行环节里它常常是最大的一块', async () => {
    // 这一条是验收报出来的「变异存活」:把工具参数那一行估算删掉,全量 2941 条一条不红。
    _resetEstimatedUsage()
    const args = JSON.stringify({ file_path: '/repo/src/very/long/path/to/a/file.ts', content: 'x'.repeat(400) })
    const toolFrame = frame({ id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Write', arguments: args } }] } }] })
    const { text: withTool } = await call(toolFrame + DONE)
    const { text: without } = await call(frame({ id: 'c1', choices: [{ delta: { content: '' } }] }) + DONE)
    expect(finalUsage(withTool)!.output_tokens).toBeGreaterThan((finalUsage(without)?.output_tokens ?? 0) + 50)
  })
})

/**
 * `anthropic` 协议那条**转发**分支同样要有 request-id。
 *
 * 评审点名的缺口:那条路不翻译、原样转发,而第三方 anthropic 兼容网关基本不回这个头 ——
 * 于是 `streamRequestId` 是 undefined,旁路上报被直接丢弃,**子 agent 内部的自动压缩
 * 在这一档完全看不见**,而那正是那条旁路存在的唯一理由。
 */
describe('anthropic 转发分支', () => {
  const anthropicCall = async (upstream: Response) => {
    const f = buildRoleFetch(
      { apiProtocol: 'anthropic', apiUrl: 'http://127.0.0.1:1/anthropic', apiToken: 'sk', backendModel: 'claude-x', roleName: '员工乙' } as never,
      async () => upstream,
    )
    return f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: new Headers(), body: '{}' })
  }

  it('上游没给就补一个', async () => {
    const res = await anthropicCall(new Response('data: x\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    expect(res.headers.get('request-id')).toMatch(/^req_role_/)
    // 正文原样转交,不额外缓冲
    expect(await res.text()).toBe('data: x\n\n')
  })

  it('上游给了就不动 —— 那是它自己的追踪 id,用户拿它去找网关日志', async () => {
    const res = await anthropicCall(new Response('ok', { status: 200, headers: { 'request-id': 'req_upstream_123' } }))
    expect(res.headers.get('request-id')).toBe('req_upstream_123')
  })

  it('状态码和别的响应头一个不丢', async () => {
    const res = await anthropicCall(new Response('nope', { status: 429, headers: { 'retry-after': '30' } }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    expect(res.headers.get('request-id')).toMatch(/^req_role_/)
  })
})

/**
 * **输入全部命中缓存**的那一档 —— 复验实测出来的:它长得和「上游什么都没报」一模一样。
 *
 * 两个翻译层的口径是 `input_tokens = prompt_tokens - cached_tokens`,所以这种调用会以
 * `{input_tokens: 0, cache_read_input_tokens: 5000}` 到达兜底那一层。只看 input_tokens
 * 的话,那 5000 的真实缓存读被抹成 0、输入换成估算值,而这次调用的用量本来是完全真实的。
 */
describe('输入全部命中缓存', () => {
  it('缓存那一格算「上游报过输入」—— 不许抹掉它,也不许标成估算', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(
      BODY + frame({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 800, prompt_tokens_details: { cached_tokens: 5000 } } }) + DONE,
    )
    const u = finalUsage(text)! as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
    expect(u.input_tokens).toBe(0)          // 全命中缓存,非缓存输入确实是 0
    expect(u.cache_read_input_tokens).toBe(5000)  // 而这 5000 是真的,不能被估算顶掉
    expect(u.output_tokens).toBe(800)
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(false)
  })

  it('缓存有值但产出没报 → 只估产出,输入侧一个字不动', async () => {
    _resetEstimatedUsage()
    const { res, text } = await call(
      BODY + frame({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 5000 } } }) + DONE,
    )
    const u = finalUsage(text)! as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
    expect(u.cache_read_input_tokens).toBe(5000)
    expect(u.output_tokens).toBeGreaterThan(0)
    expect(isEstimatedUsage(res.headers.get('request-id'))).toBe(true)
  })
})
