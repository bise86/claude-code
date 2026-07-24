const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' }
type Evt = { event: string; data: any }
export async function* openaiChunksToAnthropicEvents(chunks: AsyncIterable<any>, ctx: { anthropicModel: string }): AsyncGenerator<Evt> {
  let started = false, textOpen = false, textIndex = -1, nextIndex = 0
  const toolBlocks = new Map<number, { globalIndex: number }>()  // openai tool index → anthropic block
  let stopReason = 'end_turn'
  let usage = { input_tokens: 0, output_tokens: 0 }
  const startIfNeeded = function* (id?: string): Generator<Evt> {
    if (started) return
    started = true
    yield { event: 'message_start', data: { type: 'message_start', message: {
      id: id ?? 'msg_openai', type: 'message', role: 'assistant', model: ctx.anthropicModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }
  }
  for await (const c of chunks) {
    if (c.usage) usage = { input_tokens: c.usage.prompt_tokens ?? 0, output_tokens: c.usage.completion_tokens ?? 0 }
    const choice = c.choices?.[0]; if (!choice && !c.usage) continue
    const delta = choice?.delta ?? {}
    yield* startIfNeeded(c.id)
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textOpen) { textOpen = true; textIndex = nextIndex++; yield { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } } }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } } }
    }
    for (const tc of delta.tool_calls ?? []) {
      let blk = toolBlocks.get(tc.index)
      if (!blk) {
        if (textOpen) { yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }; textOpen = false }
        blk = { globalIndex: nextIndex++ }; toolBlocks.set(tc.index, blk)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: blk.globalIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name, input: {} } } }
      }
      if (tc.function?.arguments) yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: blk.globalIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } }
    }
    if (choice?.finish_reason) stopReason = STOP[choice.finish_reason] ?? 'end_turn'
  }
  if (textOpen) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }
  for (const blk of toolBlocks.values()) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: blk.globalIndex } }
  yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } }
  yield { event: 'message_stop', data: { type: 'message_stop' } }
}
export function anthropicEventsToSSE(events: AsyncIterable<Evt>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({ async start(ctrl) {
    for await (const e of events) ctrl.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
    ctrl.close()
  }})
}
