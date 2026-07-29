import { describe, it, expect } from 'bun:test'
import { toOpenAIRequest } from './toOpenAIRequest.js'

describe('toOpenAIRequest', () => {
  it('maps system + messages, uses backendModel, drops anthropic-only fields', () => {
    const out = toOpenAIRequest({
      model: 'claude-alias', system: [{ type: 'text', text: 'SYS' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 100, betas: ['x'], thinking: { type: 'enabled' }, metadata: { a: 1 },
    }, 'gpt-4o')
    expect(out.model).toBe('gpt-4o')
    expect(out.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(out.max_completion_tokens).toBe(100)
    expect(out.betas).toBeUndefined(); expect(out.thinking).toBeUndefined(); expect(out.metadata).toBeUndefined()
    // stream was never set on the input body, so it must not be synthesized on the output
    // (stream_options is only valid alongside stream:true — see dedicated tests below).
    expect(out.stream).toBeUndefined()
    expect(out.stream_options).toBeUndefined()
  })
  it('flattens tool_use → assistant.tool_calls and tool_result → role:tool messages in order', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]}, 'gpt-4o')
    expect(out.messages[0]).toEqual({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ cmd: 'ls' }) } }]})
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' })
  })
  it('maps tools[].input_schema → function.parameters and thinkingDepth → reasoning_effort', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }] }, 'o1', 'high')
    expect(out.tools[0]).toEqual({ type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } } })
    expect(out.reasoning_effort).toBe('high')
  })
  it('preserves a sibling text block alongside a tool_result in the same message', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'text', text: 'and one more thing' },
      ] },
    ]}, 'gpt-4o')
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' })
    expect(out.messages[2]).toEqual({ role: 'user', content: 'and one more thing' })
    expect(out.messages.length).toBe(3)
  })
  it('does not emit a sibling message when the tool_result has no non-tool_result siblings', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]}, 'gpt-4o')
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 't1', content: 'ok' }])
  })
  it('omits stream and stream_options when body.stream is not set', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [] }, 'gpt-4o')
    expect('stream' in out).toBe(false)
    expect('stream_options' in out).toBe(false)
  })
  it('omits stream_options when body.stream is explicitly false', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [], stream: false }, 'gpt-4o')
    expect(out.stream).toBe(false)
    expect('stream_options' in out).toBe(false)
  })
  it('includes stream:true and stream_options when body.stream is true', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [], stream: true }, 'gpt-4o')
    expect(out.stream).toBe(true)
    expect(out.stream_options).toEqual({ include_usage: true })
  })
  it('emits no system message when system is an empty array', () => {
    const out = toOpenAIRequest({ model: 'm', system: [], messages: [] }, 'gpt-4o')
    expect(out.messages.find((m: any) => m.role === 'system')).toBeUndefined()
  })
  it('emits no system message when system is an empty string', () => {
    const out = toOpenAIRequest({ model: 'm', system: '', messages: [] }, 'gpt-4o')
    expect(out.messages.find((m: any) => m.role === 'system')).toBeUndefined()
  })

  /**
   * 「只有 thinking 的 assistant 轮次」是 fromOpenAIStream 认思考之后**新出现**的形状:
   * 在那之前,推理中撞 max_tokens、或后端吐完 reasoning_content 就 finish 的那一轮
   * 根本不产生 assistant 消息。现在它是一条只含 thinking 块的消息,而 textOf 只留 text ——
   * 出网就是 `{"role":"assistant","content":""}`,一部分兼容后端(DeepSeek 尤甚)直接 400。
   */
  it('只有 thinking 块的 assistant 消息不出网', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'text', text: '干活' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '想了很久', signature: '' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ] }, 'deepseek-reasoner')
    expect(out.messages).toEqual([
      { role: 'user', content: '干活' },
      { role: 'user', content: '继续' },
    ])
  })

  it('thinking + text 的 assistant 消息照常出网(防上一条误伤)', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '我来读一下。' }] },
    ] }, 'm')
    expect(out.messages).toEqual([{ role: 'assistant', content: '我来读一下。' }])
  })

  it('user 的空消息不受影响 —— 这条改动只挡 assistant', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [{ role: 'user', content: [] }] }, 'm')
    expect(out.messages).toEqual([{ role: 'user', content: '' }])
  })

  it('没有 input_schema 的服务端工具不往外发', () => {
    // anthropic 的服务端工具(web_search / advisor 一类)没有 input_schema,claude.ts 会把
    // 它们拼进同一个 tools 数组。原样映射得到一个没有 parameters 的函数:严格后端 400,
    // 宽松后端会让模型去调一个这条桥根本执行不了的工具。
    const out = toOpenAIRequest({ model: 'm', messages: [], tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'Read', description: 'r', input_schema: { type: 'object' } },
    ] }, 'm')
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'Read', description: 'r', parameters: { type: 'object' } } }])
  })

  it('工具被滤光时不发空的 tools 字段', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [], tools: [{ type: 'advisor_20260301', name: 'advisor' }] }, 'm')
    expect('tools' in out).toBe(false)
  })

  it("tool_choice 'none' 不许拼成一个没名字的强制调用", () => {
    // 漏了 none 会掉进最后那一支,发出 {type:'function',function:{name:undefined}} ——
    // 本意「这轮别调工具」,出网成了「必须调某个没名字的工具」,语义完全相反。
    expect(toOpenAIRequest({ model: 'm', messages: [], tool_choice: { type: 'none' } }, 'm').tool_choice).toBe('none')
    expect(toOpenAIRequest({ model: 'm', messages: [], tool_choice: { type: 'auto' } }, 'm').tool_choice).toBe('auto')
    expect(toOpenAIRequest({ model: 'm', messages: [], tool_choice: { type: 'any' } }, 'm').tool_choice).toBe('required')
    expect(toOpenAIRequest({ model: 'm', messages: [], tool_choice: { type: 'tool', name: 'Bash' } }, 'm').tool_choice)
      .toEqual({ type: 'function', function: { name: 'Bash' } })
  })
})
