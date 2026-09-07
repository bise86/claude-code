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
    expect(es.find(e => e.event === 'message_delta')!.data.usage)
      .toEqual({ input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 0 })
  })

  it('命中缓存的那一段单列出来,并从 input 里减掉', async () => {
    /**
     * OpenAI 的 `input_tokens` **已经包含**缓存部分。不减的话总量没错,但详情页那句
     * 「缓存 读 X」对 openai 系员工恒为 0 —— 而 README 明写着「缓存读写单列」,
     * 一个高度复用上下文的运行里那便宜的一大截会被算成全价输入。
     */
    const es = await run([created, completed({ input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } })])
    expect(es.find(e => e.event === 'message_delta')!.data.usage)
      .toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 })
  })

  it('两个数不自洽时夹到 0,不出负数', async () => {
    // 网关自己报的数不一定自洽,而负数会一路渲染成 `-800`。
    const es = await run([created, completed({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 900 } })])
    expect(es.find(e => e.event === 'message_delta')!.data.usage.input_tokens).toBe(0)
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
  const hiddenReasoning = {
    type: 'response.output_item.done',
    item: { type: 'reasoning', id: 'rs_hidden', encrypted_content: 'HIDDEN' },
  }

  for (const failure of [
    { type: 'error', code: 'server_is_overloaded', message: 'Please try again later' },
    { type: 'response.failed', response: { error: { message: 'Please try again later' } } },
  ]) {
    it(`只有推理密文后 ${failure.type}:不提交空 thinking 块,让上层继续重试`, async () => {
      const es = await run([created, hiddenReasoning, failure])
      expect(types(es)).toEqual(['message_start', 'error'])
      expect(es[1].data.error.message).toBe('Please try again later')
    })
  }

  it('随后工具调用成功:密文在工具之前交出,顺序和内容都保留', async () => {
    const es = await run([
      created,
      hiddenReasoning,
      { type: 'response.output_item.done', item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}',
      } },
      completed(),
    ])
    expect(blocks(es)).toEqual(['thinking', 'tool_use'])
    const sig = es.find(e => e.data?.delta?.type === 'signature_delta')!.data.delta.signature
    expect(decodeReasoningSignature(sig)).toEqual({ id: 'rs_hidden', enc: 'HIDDEN' })
    expect(es.find(e => e.data?.content_block?.type === 'tool_use')!.data.content_block.id).toBe('call_1')
  })

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

/**
 * 验收在这几条上跑出了**存活变异** —— 不是代码错,是「这段代码在不在」没人问过。
 * 共同病根:每条用例喂的 `output_item.done` 都带全了 call_id+name+arguments,
 * 于是整个累加器被短路,改坏它测试照绿。
 */
describe('累加器真的在用', () => {
  it('`.done` 不带参数时,用增量拼出来的那份 —— 而且两者**不相等**', async () => {
    // 原来那条用例喂的增量拼起来恰好等于 `.done` 的串,两个分支产出同一个值,
    // 它物理上分辨不出自己在测什么。
    const es = await run([
      created,
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'X' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"from":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"delta"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"from":"done"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'X' } },
      completed(),
    ])
    // `.done` 优先。删掉那一支的话这里会读到 {"from":"delta"}。
    expect(es.find(e => e.data?.delta?.type === 'input_json_delta')!.data.delta.partial_json).toBe('{"from":"done"}')
  })

  it('流断在半路时,攒着的那次调用**连身份一起**发出去', async () => {
    // 原来只断言「blocks 里有 tool_use」—— 而 call_id 和 name 正是 `.added` 唯一的用处,
    // 丢了它们下一轮 tool_call_id 撞不上、工具也查不到。
    const es = await run([
      created,
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_keep', name: 'Bash' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":"ls"}' },
    ])
    const start = es.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')!
    expect(start.data.content_block.id).toBe('call_keep')
    expect(start.data.content_block.name).toBe('Bash')
    expect(es.find(e => e.data?.delta?.type === 'input_json_delta')!.data.delta.partial_json).toBe('{"command":"ls"}')
  })

  it('`response.failed` 之后也要**立刻收口**,不是接着往下发', async () => {
    // 原来「报错之后就收口」那条只走了顶层 error 事件,failed 那一支的 return 改成 break 存活。
    const es = await run([
      created, { type: 'response.failed', response: { error: { message: '炸了' } } },
      { type: 'response.output_text.delta', delta: '不该出现' },
    ])
    expect(textOf(es)).toBe('')
    expect(types(es)).not.toContain('message_stop')
  })
})

describe('相邻两条推理片段,两条密文都要活着', () => {
  it('中间没有正文隔开时也不能覆盖', async () => {
    /**
     * `signature()` 只在没开着思考块时才开新块,而 claude.ts 处理 signature_delta 是
     * **赋值不是追加** —— 两条 reasoning item 挨着来时,第一条的密文被第二条盖掉,
     * 静默消失。gpt-5.1-codex 系一轮里交替吐 [reasoning, 正文, reasoning, function_call]
     * 是这条协议的典型输出,唯独相邻这一种排布中招。
     */
    const es = await run([
      created,
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'C1' } },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', encrypted_content: 'C2' } },
      completed(),
    ])
    const sigs = es.filter(e => e.data?.delta?.type === 'signature_delta')
      .map(e => decodeReasoningSignature(e.data.delta.signature)?.enc)
    expect(sigs).toEqual(['C1', 'C2'])
    // 而且它们必须落在**两个不同**的思考块上,否则下游那次赋值照样只留最后一条。
    const idx = new Set(es.filter(e => e.data?.delta?.type === 'signature_delta').map(e => e.data.index))
    expect(idx.size).toBe(2)
  })

  it('正文开着时签名也接得住 —— 会先把文本块关掉', async () => {
    const es = await run([
      created,
      { type: 'response.output_text.delta', delta: '我想想' },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_3', encrypted_content: 'C3' } },
      completed(),
    ])
    let open = 0
    for (const e of es) {
      if (e.event === 'content_block_start') open++
      if (e.event === 'content_block_stop') open--
      expect(open).toBeLessThanOrEqual(1)
    }
    expect(es.some(e => e.data?.delta?.type === 'signature_delta')).toBe(true)
  })
})
