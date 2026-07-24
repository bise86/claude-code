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
})
