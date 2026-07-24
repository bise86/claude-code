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
})
