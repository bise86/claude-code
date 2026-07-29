import { describe, expect, it } from 'bun:test'
import { responsesEventsToAnthropicEvents } from './fromResponsesStream.js'
import { decodeReasoningSignature } from './toResponsesRequest.js'

type Evt = { event: string; data: any }
async function run(frames: any[]): Promise<Evt[]> {
  const out: Evt[] = []
  const gen = responsesEventsToAnthropicEvents(
    (async function* () { for (const f of frames) yield f })(),
    { anthropicModel: 'claude-alias' },
  )
  for await (const e of gen) out.push(e)
  return out
}
const types = (es: Evt[]) => es.map(e => e.event)
const blocks = (es: Evt[]) => es.filter(e => e.event === 'content_block_start').map(e => e.data.content_block.type)
const textOf = (es: Evt[]) => es.filter(e => e.data?.delta?.type === 'text_delta').map(e => e.data.delta.text).join('')
const thinkOf = (es: Evt[]) => es.filter(e => e.data?.delta?.type === 'thinking_delta').map(e => e.data.delta.thinking).join('')

const created = { type: 'response.created', response: { id: 'resp_1' } }
const completed = (usage?: any) => ({ type: 'response.completed', response: { usage } })

describe('骨架', () => {
  it('message_start 用的是 response 自己的 id', async () => {
    const es = await run([created, completed()])
    expect(es[0].event).toBe('message_start')
    expect(es[0].data.message.id).toBe('resp_1')
    expect(es[0].data.message.model).toBe('claude-alias')
  })

  it('空流也吐一条完整骨架', async () => {
    const es = await run([])
    expect(types(es)).toEqual(['message_start', 'message_delta', 'message_stop'])
  })

  it('usage 用的是 input_tokens/output_tokens,不是 chat 那套 prompt/completion', async () => {
    const es = await run([created, completed({ input_tokens: 11, output_tokens: 22 })])
    expect(es.find(e => e.event === 'message_delta')!.data.usage).toEqual({ input_tokens: 11, output_tokens: 22 })
  })

  it('认不出来的事件一律忽略,不报错也不打断', async () => {
    // 事件种类多而且在增长,为一个没见过的名字报错是最差的选择。
    const es = await run([
      created,
      { type: 'response.in_progress' }, { type: 'response.output_item.added', item: { type: 'message' } },
      { type: 'response.content_part.done' }, { type: '未来的新事件' },
      { type: 'response.output_text.delta', delta: '好' }, completed(),
    ])
    expect(textOf(es)).toBe('好')
    expect(types(es)).not.toContain('error')
  })
})

describe('思考', () => {
  it('推理摘要变成 thinking 块', async () => {
    const es = await run([
      created,
      { type: 'response.reasoning_summary_text.delta', delta: '先看看' },
      // 空 delta 不该多开一个块,也不该抛。
      { type: 'response.reasoning_summary_text.delta', delta: '' },
      completed(),
    ])
    expect(blocks(es)).toEqual(['thinking'])
    expect(thinkOf(es)).toBe('先看看')
  })

  it('reasoning_text 和 reasoning_summary_text 两个事件都收', async () => {
    const a = await run([created, { type: 'response.reasoning_summary_text.delta', delta: 'A' }, completed()])
    const b = await run([created, { type: 'response.reasoning_text.delta', delta: 'B' }, completed()])
    expect(thinkOf(a)).toBe('A')
    expect(thinkOf(b)).toBe('B')
  })

  it('摘要分成多段时自己补空行 —— 直接拼接会把段落粘死', async () => {
    const es = await run([
      created,
      { type: 'response.reasoning_summary_part.added', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', delta: '第一段' },
      { type: 'response.reasoning_summary_part.added', summary_index: 1 },
      { type: 'response.reasoning_summary_text.delta', delta: '第二段' },
      completed(),
    ])
    expect(thinkOf(es)).toBe('第一段\n\n第二段')
  })

  it('思考和正文交替时,同一时刻只开着一个块', async () => {
    // 破了这条不变量的后果不是排版难看:claude.ts 在 content_block_stop 那一支直接
    // throw RangeError('Content block not found'),整条流炸掉。
    const es = await run([
      created,
      { type: 'response.reasoning_summary_text.delta', delta: '想' },
      { type: 'response.output_text.delta', delta: '说' },
      { type: 'response.reasoning_summary_text.delta', delta: '再想' },
      completed(),
    ])
    let open = 0
    for (const e of es) {
      if (e.event === 'content_block_start') open++
      if (e.event === 'content_block_stop') open--
      expect(open).toBeLessThanOrEqual(1)
      expect(open).toBeGreaterThanOrEqual(0)
    }
    expect(open).toBe(0)
  })
})

describe('推理片段带回下一轮', () => {
  it('密文塞进 thinking 块的签名', async () => {
    const es = await run([
      created,
      { type: 'response.reasoning_summary_text.delta', delta: '想' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_7', encrypted_content: 'CIPHER' } },
      completed(),
    ])
    const sig = es.find(e => e.data?.delta?.type === 'signature_delta')!.data.delta.signature
    expect(decodeReasoningSignature(sig)).toEqual({ id: 'rs_7', enc: 'CIPHER' })
  })

  it('一段摘要都没有时也不能把密文丢掉 —— 丢了下一轮调工具就 400', async () => {
    /**
     * 摘要是 opt-in 的,而且模型可以一个字都不给,但 reasoning item 照样带着密文。
     * 丢掉它的后果不是少一段思考,是这个员工一旦调工具就再也接不下去。
     */
    const es = await run([
      created,
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_8', encrypted_content: 'C2' } },
      completed(),
    ])
    expect(blocks(es)).toContain('thinking')
    const sig = es.find(e => e.data?.delta?.type === 'signature_delta')!.data.delta.signature
    expect(decodeReasoningSignature(sig)).toEqual({ id: 'rs_8', enc: 'C2' })
  })

  it('没有密文就不发签名', async () => {
    const es = await run([created, { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_9' } }, completed()])
    expect(es.some(e => e.data?.delta?.type === 'signature_delta')).toBe(false)
  })
})

describe('工具调用', () => {
  const call = (id: string, callId: string, name: string, args: string) => [
    { type: 'response.output_item.added', item: { type: 'function_call', id, call_id: callId, name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: id, delta: args.slice(0, 3) },
    { type: 'response.function_call_arguments.delta', item_id: id, delta: args.slice(3) },
    { type: 'response.function_call_arguments.done', item_id: id, arguments: args },
    { type: 'response.output_item.done', item: { type: 'function_call', id, call_id: callId, name, arguments: args } },
  ]

  it('id 用的是 call_id,不是 item 的 fc_ 那个', async () => {
    // 两者是不同的命名空间,而下一轮的 function_call_output 按 call_id 配对 ——
    // 传错就是下一轮 400。
    const es = await run([created, ...call('fc_1', 'call_1', 'Read', '{"file_path":"a.ts"}'), completed()])
    const start = es.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')!
    expect(start.data.content_block.id).toBe('call_1')
    expect(start.data.content_block.name).toBe('Read')
  })

  it('两个并行调用各自完整,参数不会串', async () => {
    /**
     * chat 那侧「不发 index」的方言会把两个并行调用并成一块(实测
     * `{"file_path":"a.ts"}{"command":"ls"}` → 解析失败 → 一个拿空参数、一个整个消失)。
     * responses 这边 item_id 是必填的,所以物理上不会发生 —— 这条钉住它确实没发生。
     */
    const es = await run([
      created,
      ...call('fc_1', 'call_1', 'Read', '{"file_path":"a.ts"}'),
      ...call('fc_2', 'call_2', 'Bash', '{"command":"ls"}'),
      completed(),
    ])
    const args = es.filter(e => e.data?.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json)
    expect(args).toEqual(['{"file_path":"a.ts"}', '{"command":"ls"}'])
  })

  it('参数以 .done 带的完整串为准,增量只在它缺席时兜底', async () => {
    const es = await run([
      created,
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'X' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':1}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'X' } },
      completed(),
    ])
    expect(es.find(e => e.data?.delta?.type === 'input_json_delta')!.data.delta.partial_json).toBe('{"a":1}')
  })

  it('**stop_reason 自己推导成 tool_use** —— responses 没有 finish_reason', async () => {
    // 漏了这条推导,工具循环根本不跑:模型请求了工具,而引擎以为这一轮结束了。
    const es = await run([created, ...call('fc_1', 'call_1', 'Read', '{}'), completed()])
    expect(es.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use')
  })

  it('没有工具调用时是 end_turn', async () => {
    const es = await run([created, { type: 'response.output_text.delta', delta: 'hi' }, completed()])
    expect(es.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('end_turn')
  })

  it('流断在半路时攒着的调用照发,不丢块', async () => {
    const es = await run([
      created,
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'Read' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":1}' },
      // 没有 output_item.done,也没有 completed —— 上游断了
    ])
    expect(blocks(es)).toContain('tool_use')
    expect(es.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use')
  })

  it('added 没到就先来 delta 时也不丢参数', async () => {
    const es = await run([
      created,
      { type: 'response.function_call_arguments.delta', item_id: 'fc_9', delta: '{"y":2}' },
    ])
    expect(es.find(e => e.data?.delta?.type === 'input_json_delta')!.data.delta.partial_json).toBe('{"y":2}')
  })
})

describe('拒答与截断', () => {
  it('拒答走正文,不能被「忽略未知事件」吃掉', async () => {
    // 吃掉的话用户拿到一个完全空白的回复,看不出是拒答、是超时,还是这条桥坏了。
    const es = await run([created, { type: 'response.refusal.delta', delta: '我不能这么做' }, completed()])
    expect(textOf(es)).toBe('我不能这么做')
  })

  it('output token 用完 → max_tokens', async () => {
    const es = await run([
      created, { type: 'response.output_text.delta', delta: 'abc' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 2 } } },
    ])
    expect(es.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens')
  })

  it('内容过滤 → end_turn(和 chat 那侧同口径)', async () => {
    const es = await run([created, { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }])
    expect(es.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('end_turn')
  })
})

describe('两种错误形状都要接', () => {
  it('顶层 error 事件的 message 在**顶层**', async () => {
    // 照搬 chat 那侧的 `c.error?.message` 会读到 undefined —— 真正的原因被吞掉,
    // 用户只拿到一句「upstream error」。
    const es = await run([{ type: 'error', code: 'rate_limit', message: '太快了' }])
    expect(es[0].event).toBe('message_start')
    const err = es.find(e => e.event === 'error')!
    expect(err.data.error.message).toBe('太快了')
  })

  it('response.failed 的错误在 response.error.message', async () => {
    const es = await run([created, { type: 'response.failed', response: { id: 'resp_1', error: { message: '模型炸了' } } }])
    expect(es.find(e => e.event === 'error')!.data.error.message).toBe('模型炸了')
  })

  it('错误是第一帧时,message_start 仍然排在它前面', async () => {
    const es = await run([{ type: 'response.failed', response: { error: { message: 'x' } } }])
    expect(es[0].event).toBe('message_start')
  })

  it('报错之后就收口,不再往下发', async () => {
    const es = await run([
      created, { type: 'error', message: '断了' },
      { type: 'response.output_text.delta', delta: '不该出现' },
    ])
    expect(textOf(es)).toBe('')
    expect(types(es)).not.toContain('message_stop')
  })
})
