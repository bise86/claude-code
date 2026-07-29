import { describe, it, expect } from 'bun:test'
import { openaiChunksToAnthropicEvents, reasoningTextOf, REASONING_FIELDS } from './fromOpenAIStream.js'

async function collect(chunks: any[]) {
  const evts: any[] = []
  for await (const e of openaiChunksToAnthropicEvents((async function*(){ for (const c of chunks) yield c })(), { anthropicModel: 'claude-alias' })) evts.push(e)
  return evts
}

describe('openaiChunksToAnthropicEvents', () => {
  it('emits message_start with skeleton, text deltas, and message_stop', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'He' } }] },
      { choices: [{ delta: { content: 'llo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ])
    const types = evts.map(e => e.event)
    expect(types[0]).toBe('message_start')
    expect(evts[0].data.message.usage).toBeDefined()
    expect(types).toContain('content_block_delta')
    const text = evts.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('')
    expect(text).toBe('Hello')
    const md = evts.find(e => e.event === 'message_delta')
    expect(md.data.delta.stop_reason).toBe('end_turn')
    expect(md.data.usage.output_tokens).toBe(2)
    expect(types[types.length - 1]).toBe('message_stop')
  })

  it('maps tool_calls to a tool_use content block at global index 1 after text', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '{"cmd":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = evts.filter(e => e.event === 'content_block_start')
    expect(starts.find(s => s.data.content_block.type === 'tool_use').data.index).toBe(1)
    const partial = evts.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
    expect(partial).toBe('{"cmd":"ls"}')
    expect(evts.find(e => e.event === 'message_delta').data.delta.stop_reason).toBe('tool_use')
  })

  it('surfaces input_tokens from the final usage chunk in message_delta', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 500, completion_tokens: 2 } },
    ])
    const md = evts.find(e => e.event === 'message_delta')
    expect(md.data.usage.input_tokens).toBe(500)
    expect(md.data.usage.output_tokens).toBe(2)
  })

  it('emits exactly one message_start, before message_delta/message_stop, for an empty stream', async () => {
    const evts = await collect([])
    const types = evts.map(e => e.event)
    expect(types.filter(t => t === 'message_start').length).toBe(1)
    expect(types.indexOf('message_start')).toBeLessThan(types.indexOf('message_delta'))
    expect(types.indexOf('message_start')).toBeLessThan(types.indexOf('message_stop'))
  })

  it('surfaces an in-band error chunk as an error event without a trailing clean message_delta', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { content: 'partial' } }] },
      { error: { message: 'upstream failure' } },
    ])
    const errEvt = evts.find(e => e.event === 'error')
    expect(errEvt).toBeDefined()
    expect(JSON.stringify(errEvt.data)).toContain('upstream failure')
    const trailingMd = evts.find(e => e.event === 'message_delta' && e.data.delta.stop_reason === 'end_turn')
    expect(trailingMd).toBeUndefined()
  })

  it('emits message_start before the error event when the error is the very first chunk', async () => {
    const evts = await collect([
      { error: { message: 'upstream failure' } },
    ])
    const types = evts.map(e => e.event)
    expect(types[0]).toBe('message_start')
    expect(types[1]).toBe('error')
    expect(types.length).toBe(2)
  })

  it('maps content_filter finish_reason to end_turn stop_reason', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
    ])
    const md = evts.find(e => e.event === 'message_delta')
    expect(md.data.delta.stop_reason).toBe('end_turn')
  })

  it('maps parallel tool_calls (indexes 0 and 1) to distinct tool_use blocks at global indexes 1 and 2', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 't1', function: { name: 'Bash', arguments: '{"cmd":' } },
        { index: 1, id: 't2', function: { name: 'Read', arguments: '{"file":' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, function: { arguments: '"ls"}' } },
        { index: 1, function: { arguments: '"a.txt"}' } },
      ] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = evts.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    expect(starts.length).toBe(2)
    const first = starts.find(s => s.data.content_block.id === 't1')
    const second = starts.find(s => s.data.content_block.id === 't2')
    expect(first.data.index).toBe(1)
    expect(first.data.content_block.name).toBe('Bash')
    expect(second.data.index).toBe(2)
    expect(second.data.content_block.name).toBe('Read')
    const partialFor = (idx: number) => evts.filter(e => e.event === 'content_block_delta' && e.data.index === idx && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
    expect(partialFor(1)).toBe('{"cmd":"ls"}')
    expect(partialFor(2)).toBe('{"file":"a.txt"}')
  })

  /**
   * 思考。用户的原话:「子 agent 调用 openai api 时没有思考、输出过程」。
   *
   * 根因就在这个文件:在这之前只有 `delta.content` 和 `delta.tool_calls` 两个分支,
   * 而支持推理的兼容后端把思考放在 `reasoning_content` / `reasoning` 上 —— 一个都没读。
   */
  it('reasoning_content 变成 thinking 块,而且排在正文之前', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { reasoning_content: '先读 package.json' } }] },
      { choices: [{ delta: { reasoning_content: ',再看 lockfile' } }] },
      { choices: [{ delta: { content: '我来读一下。' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    // 事件序列**逐条**钉住:只断言「含 thinking 字样」的话,把 thinking_delta 写成
    // text_delta 照样绿,而那正好把思考混进方案正文里。
    const shape = evts.map(e => e.event === 'content_block_start' ? `start:${e.data.content_block.type}`
      : e.event === 'content_block_delta' ? `delta:${e.data.delta.type}`
      : e.event === 'content_block_stop' ? 'stop' : e.event)
    expect(shape).toEqual([
      'message_start',
      'start:thinking', 'delta:thinking_delta', 'delta:thinking_delta', 'stop',
      'start:text', 'delta:text_delta', 'stop',
      'message_delta', 'message_stop',
    ])
    const think = evts.filter(e => e.data?.delta?.type === 'thinking_delta').map(e => e.data.delta.thinking).join('')
    expect(think).toBe('先读 package.json,再看 lockfile')
    // 思考块在 index 0、正文在 index 1 —— anthropic 协议要求 thinking 排在 text 之前。
    const starts = evts.filter(e => e.event === 'content_block_start')
    expect(starts.map(x => [x.data.content_block.type, x.data.index])).toEqual([['thinking', 0], ['text', 1]])
  })

  it('四种方言的字段名都认;新后端只需往 REASONING_FIELDS 里加一个名字', async () => {
    const cases: [string, any][] = [
      ['reasoning_content', { reasoning_content: '甲' }],
      ['reasoning', { reasoning: '甲' }],
      ['reasoning_details', { reasoning_details: [{ type: 'reasoning.text', text: '甲' }] }],
      ['thinking', { thinking: '甲' }],
    ]
    for (const [name, delta] of cases) {
      const evts = await collect([{ id: 'x', choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
      const think = evts.filter(e => e.data?.delta?.type === 'thinking_delta').map(e => e.data.delta.thinking).join('')
      expect(`${name}: ${think}`).toBe(`${name}: 甲`)
    }
    // 名单本身也钉住:少一个方言就是少一批后端的思考,而那是静默的。
    expect([...REASONING_FIELDS]).toEqual(['reasoning_content', 'reasoning', 'reasoning_details', 'thinking'])
  })

  it('同一条 delta 里 reasoning 和 reasoning_details 同时出现时不重影', () => {
    // OpenRouter 就是这么发的:一个纯文本、一个结构化,内容相同。把所有字段拼起来
    // 会把每一段思考显示两遍。
    expect(reasoningTextOf({ reasoning: '想一想', reasoning_details: [{ text: '想一想' }] })).toBe('想一想')
  })

  it('加密的思考不许打到终端上', () => {
    // reasoning.encrypted 的 data 是一大段 base64:既没有信息,又会把工具调用淹掉。
    // 所以正文键名是白名单,不是「随便找个字符串属性」。
    expect(reasoningTextOf({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'QUJDREVGR0hJSg==' }] })).toBe('')
    expect(reasoningTextOf({ reasoning_content: '' })).toBe('')
    expect(reasoningTextOf(null)).toBe('')
    expect(reasoningTextOf('裸字符串不是 delta')).toBe('')
  })

  it('正文之后又来思考:先关掉正文块,再开新的思考块', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { content: '甲' } }] },
      { choices: [{ delta: { reasoning_content: '再想想' } }] },
      { choices: [{ delta: { content: '乙' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const shape = evts.map(e => e.event === 'content_block_start' ? `start:${e.data.content_block.type}@${e.data.index}`
      : e.event === 'content_block_stop' ? `stop@${e.data.index}` : null).filter(Boolean)
    // 一个内容块没关就开下一个,是坏掉的 anthropic 流。
    expect(shape).toEqual(['start:text@0', 'stop@0', 'start:thinking@1', 'stop@1', 'start:text@2', 'stop@2'])
  })

  /**
   * 工具调用。**第 3 项(「子 agent 有没有调 tools、mcp」)和第 4 项是同一个病。**
   *
   * `tc.index` 是 OpenAI 规范字段,但不是每家兼容后端都发 —— 不发的那些每条 delta
   * 携带一个完整的 tool_call。原来的 `toolBlocks.get(tc.index)` 于是永远命中
   * `get(undefined)`:两个并行调用被并成一块,arguments 拼成 `{...}{...}`,
   * `safeParseJSON(...) ?? {}` 解析失败 → 第一个工具拿空参数被调用,第二个整个消失。
   */
  it('provider 不发 index 时,并行调用不许被并成一块', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = evts.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    expect(starts.map(x => x.data.content_block.name)).toEqual(['Read', 'Bash'])
    const jsonAt = (idx: number) => evts.filter(e => e.event === 'content_block_delta' && e.data.index === idx && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
    // **要真的能 parse** —— 只断言字符串相等的话,拼串的 bug 换个写法就能绕过去。
    expect(JSON.parse(jsonAt(starts[0]!.data.index))).toEqual({ file_path: 'a.ts' })
    expect(JSON.parse(jsonAt(starts[1]!.data.index))).toEqual({ command: 'ls' })
  })

  it('不发 index 时,只带 arguments 的续块归上一次调用', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{"command":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = evts.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    expect(starts.length).toBe(1)
    const json = evts.filter(e => e.data?.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
    expect(JSON.parse(json)).toEqual({ command: 'ls' })
  })

  it('name / id 晚一条 delta 才到也要接住', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'Read', arguments: '"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const start = evts.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    // 边收边发时 content_block_start 在第一条 delta 就出去了,而 anthropic 协议里
    // name/id 一旦发出不能改 —— 实测拿到的是 name=undefined(工具查不到)。
    expect(start.data.content_block.name).toBe('Read')
    expect(start.data.content_block.id).toBe('c9')
  })

  it('完全没有 id 时合成一个,而且两个并行调用的 id 不相同', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Read', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'Bash', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const ids = evts.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use').map(e => e.data.content_block.id)
    expect(ids.length).toBe(2)
    expect(ids.every((i: string) => typeof i === 'string' && i.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('「文本 → 工具 → 文本」时,工具块排在所有文本块之后', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { content: '甲' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '{}' } }] } }] },
      { choices: [{ delta: { content: '乙' } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    // claude.ts 是**按 content_block_stop 产消息**的,所以 stop 的顺序就是窗口里的顺序。
    // 边收边发时工具行会出现在两段文本之后 —— 时序是错的。
    const stops = evts.filter(e => e.event === 'content_block_stop').map(e => e.data.index)
    const toolIdx = evts.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use').data.index
    const textIdx = evts.filter(e => e.event === 'content_block_start' && e.data.content_block.type === 'text').map(e => e.data.index)
    expect(Math.max(...textIdx)).toBeLessThan(toolIdx)
    expect(stops[stops.length - 1]).toBe(toolIdx)
  })
})
