import { describe, it, expect } from 'bun:test'
import { openaiChunksToAnthropicEvents } from './fromOpenAIStream.js'

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
})
