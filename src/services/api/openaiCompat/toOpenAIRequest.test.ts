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
    expect(out.stream_options).toEqual({ include_usage: true })
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
})
