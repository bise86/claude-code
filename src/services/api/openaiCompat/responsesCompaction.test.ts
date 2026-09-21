import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { parseRoles } from '../../../tools/AgentTool/roles/rolesFromSettings.js'
import {
  createAssistantMessage, createUserMessage, ensureToolResultPairing, filterOrphanedThinkingOnlyMessages,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import type { Message } from '../../../types/message.js'
import { buildRoleFetch } from './roleFetch.js'
import { responsesEventsToAnthropicEvents } from './fromResponsesStream.js'
import { decodeCompactionSignature, encodeCompactionSignature } from './responsesCompaction.js'
import { encodeReasoningSignature, toResponsesRequest } from './toResponsesRequest.js'

const checkpoint = (id = 'cmp_1') => ({ type: 'compaction' as const, id, encrypted_content: `encrypted-${id}` })
const done = (item: any) => ({ type: 'response.output_item.done', item })
const text = (delta: string) => ({ type: 'response.output_text.delta', delta })
const completed = { type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 10 } } }
const block = (id = 'cmp_1') => ({ type: 'thinking' as const, thinking: '', signature: encodeCompactionSignature(checkpoint(id)) })

function setup(frames: any[][], overrides: Record<string, unknown> = {}) {
  const cfg = parseRoles([{
    name: 'compaction-test', whenToUse: 'test', execMode: 'api',
    apiUrl: 'https://compaction.example/v1', apiToken: 'test-key', model: 'test-model',
    apiProtocol: 'openai-responses', transport: 'sdk',
    contextWindow: '1m', autoCompactTokenLimit: 900000, ...overrides,
  }], 'compaction-test')[0]!.agentDef.roleClientConfig!
  const requests: { url: string; body: any }[] = []
  const fetchOverride = buildRoleFetch(cfg, (async (input: any, init: any) => {
    const body = JSON.parse(init?.body ?? await input.clone().text())
    const batch = frames[requests.length] ?? [text('ok')]
    requests.push({ url: typeof input === 'string' ? input : input.url, body })
    return new Response([
      { type: 'response.created', response: { id: `resp_${requests.length}` } },
      ...batch, completed,
    ].map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch)
  const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: fetchOverride })

  async function turn(history: Message[]) {
    const normalized = ensureToolResultPairing(normalizeMessagesForAPI(history))
    const response = await client.messages.stream({
      model: 'claude-alias', max_tokens: 100,
      messages: normalized.map(m => ({ role: m.message.role, content: m.message.content })) as any,
    }).finalMessage()
    // Production yields one message per stopped content block. Persist that
    // shape, so the next request exercises normalization and same-ID merging.
    for (const content of response.content) {
      const message = createAssistantMessage({ content: [content] as any })
      message.message.id = response.id
      history.push(message)
    }
    return response
  }
  return { cfg, requests, turn }
}

describe('SDK Responses server-side compaction', () => {
  test('settings reach the SDK; checkpoint survives persistence and a tool-result turn', async () => {
    const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}' }
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'reasoning-secret' }
    const { cfg, requests, turn } = setup([
      [text('old output'), done(checkpoint()), done(reasoning), text('reading'), done(tool)],
      [text('finished')],
      [text('continued')],
    ])
    expect(cfg.contextWindow).toBe(1_000_000)
    let history: Message[] = [createUserMessage({ content: 'old task' })]
    const first = await turn(history)
    expect(first.stop_reason).toBe('tool_use')
    expect(requests[0]!.body.context_management).toEqual([{ type: 'compaction', compact_threshold: 900000 }])
    expect(requests[0]!.body.truncation).toBeUndefined()
    expect(requests[0]!.body.store).toBe(false)
    history = JSON.parse(JSON.stringify(history))
    history.push(createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] }))
    await turn(history)
    expect(requests[1]!.body.input).toEqual([
      checkpoint(),
      { ...reasoning, summary: [] },
      { role: 'assistant', content: 'reading' },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: tool.arguments },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ])
    history.push(createUserMessage({ content: 'continue' }))
    await turn(history)
    expect(requests[2]!.body.input[0]).toEqual(checkpoint())
    expect(requests[2]!.body.input.slice(-2)).toEqual([
      { role: 'assistant', content: 'finished' }, { role: 'user', content: 'continue' },
    ])
    expect(requests.every(r => r.url === 'https://compaction.example/v1/responses')).toBe(true)
    expect(requests).toHaveLength(3) // No separate compact or summary request.
    expect(JSON.stringify(history)).toContain('old task') // Display history is unchanged.
  })

  test('a second checkpoint replaces the first, including earlier blocks in its own response', async () => {
    const { requests, turn } = setup([
      [done(checkpoint()), text('first window')],
      [text('before second checkpoint'), done(checkpoint('cmp_2')), text('after checkpoint')],
      [text('ok')],
    ])
    const history: Message[] = [createUserMessage({ content: 'begin' })]
    await turn(history)
    history.push(createUserMessage({ content: 'next window' }))
    await turn(history)
    history.push(createUserMessage({ content: 'continue' }))
    await turn(history)
    expect(requests[2]!.body.input).toEqual([
      checkpoint('cmp_2'), { role: 'assistant', content: 'after checkpoint' }, { role: 'user', content: 'continue' },
    ])
  })

  test('checkpoint-only responses survive orphan and trailing thinking cleanup', async () => {
    const { turn, requests } = setup([[done(checkpoint())], [text('ok')]])
    const history: Message[] = [createUserMessage({ content: 'begin' })]
    await turn(history)
    const normalized = normalizeMessagesForAPI(JSON.parse(JSON.stringify(history)))
    expect(normalized.at(-1)!.message.content).toEqual([block()])
    // Also keep the checkpoint if ordinary trailing thinking follows it.
    history.push(createAssistantMessage({ content: [block('cmp_2'), { type: 'thinking', thinking: 'unfinished', signature: '' }] }))
    expect(normalizeMessagesForAPI(history).at(-1)!.message.content).toEqual([block('cmp_2')])
    history.push(createUserMessage({ content: 'continue' }))
    await turn(history)
    expect(requests[1]!.body.input).toEqual([checkpoint('cmp_2'), { role: 'user', content: 'continue' }])
  })

  test('ordinary Anthropic thinking still follows the existing cleanup rules', () => {
    const thinking = { type: 'thinking' as const, thinking: 'ordinary reasoning', signature: 'anthropic-signature' }
    expect(filterOrphanedThinkingOnlyMessages([createAssistantMessage({ content: [thinking] })])).toEqual([])
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'answer', citations: [] }, thinking] })
    expect(normalizeMessagesForAPI([message])[0]!.message.content).toEqual([{ type: 'text', text: 'answer', citations: [] }])
  })

  test('an unsupported gateway error is surfaced without disabling compaction or calling another endpoint', async () => {
    const { cfg } = setup([])
    const urls: string[] = []
    const fetchOverride = buildRoleFetch(cfg, (async (input: any) => {
      urls.push(typeof input === 'string' ? input : input.url)
      return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: context_management' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)
    const response = await fetchOverride('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: new Headers(),
      body: JSON.stringify({ model: 'claude-alias', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'begin' }] }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Unsupported parameter: context_management')
    expect(urls).toEqual(['https://compaction.example/v1/responses'])
  })

  for (const transport of ['raw', undefined]) {
    test(`${transport ?? 'default'} transport does not request server compaction`, async () => {
      const { requests, turn } = setup([[text('ok')]], { transport })
      await turn([createUserMessage({ content: 'begin' })])
      expect(requests[0]!.body.context_management).toBeUndefined()
    })
  }

  test('SDK without a threshold does not silently enable server compaction', async () => {
    const { requests, turn } = setup([[text('ok')]], { autoCompactTokenLimit: undefined })
    await turn([createUserMessage({ content: 'begin' })])
    expect(requests[0]!.body.context_management).toBeUndefined()
  })

  test('invalid checkpoint signatures never erase prior history', () => {
    for (const signature of ['openai-responses-compaction:bad', 'openai-responses-compaction:null', 'openai-responses-compaction:{"enc":""}', encodeReasoningSignature('rs_1', 'secret')]) {
      expect(decodeCompactionSignature(signature)).toBeUndefined()
      const request = toResponsesRequest({ messages: [
        { role: 'user', content: 'keep me' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature }] },
      ] }, { backendModel: 'test-model' })
      expect(request.input).toEqual([{ role: 'user', content: 'keep me' }])
    }
  })

  test('compaction-only output followed by failure stays retryable', async () => {
    const events = []
    for await (const event of responsesEventsToAnthropicEvents((async function* () {
      yield done(checkpoint())
      yield { type: 'error', message: 'server overloaded' }
    })(), { anthropicModel: 'claude-alias' })) events.push(event)
    expect(events.map(e => e.event)).toEqual(['message_start', 'error'])
    expect(events[1]!.data.error.message).toBe('server overloaded')
  })

  test('missing encrypted checkpoint is a visible error', async () => {
    const events = []
    for await (const event of responsesEventsToAnthropicEvents((async function* () {
      yield done({ type: 'compaction', id: 'cmp_bad' })
    })(), { anthropicModel: 'claude-alias' })) events.push(event)
    expect(events.at(-1)!.data.error.message).toContain('missing encrypted_content')
  })
})
