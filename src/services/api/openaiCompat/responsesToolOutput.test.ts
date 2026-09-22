import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { getProjectDir } from '../../../utils/sessionStorage.js'
import { withContextNoticeSink } from '../contextNoticeSink.js'
import { buildRoleFetch } from './roleFetch.js'
import { encodeCompactionSignature } from './responsesCompaction.js'

// Reproduce the gateway's field constraint independently of the implementation.
const upstreamMax = 10_485_760
let temp: string
let savedConfigDir: string | undefined

function resetPaths() {
  getClaudeConfigHomeDir.cache.clear()
  getProjectDir.cache.clear()
}

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'responses-output-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = temp
  resetPaths()
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  resetPaths()
  await rm(temp, { recursive: true, force: true })
})

function history(content: any, id = 'call_large'): any[] {
  return [
    ...Array.from({ length: 98 }, (_, i) => ({ role: 'user', content: `earlier message ${i}` })),
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'build.log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ]
}

function setup(transport: 'raw' | 'sdk', options: { autoCompactTokenLimit?: number } = { autoCompactTokenLimit: 600000 }) {
  const requests: any[] = []
  const urls: string[] = []
  const fetchFn = buildRoleFetch({
    apiProtocol: 'openai-responses', transport,
    apiUrl: 'https://output-test.invalid/v1', apiToken: 'test-key',
    backendModel: 'test-model', roleName: '研发', contextWindow: 1000000, ...options,
  }, (async (input: any, init: any = {}) => {
    const body = JSON.parse(String(init.body ?? await input.clone().text()))
    requests.push(body)
    urls.push(typeof input === 'string' ? input : input.url)
    if (body.input.some((i: any) => i.type === 'function_call_output' && i.output.length > upstreamMax)) {
      return new Response(JSON.stringify({ error: { message: 'string_above_max_length' } }), { status: 400 })
    }
    const frames = [
      { type: 'response.created', response: { id: 'resp_output' } },
      { type: 'response.output_text.delta', delta: 'continued' },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 2 } } },
    ]
    return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch)
  const send = (messages: any[]) => fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST', body: JSON.stringify({ model: 'claude-alias', stream: true, max_tokens: 100, messages }),
  })
  return { requests, urls, send }
}

function savedPath(output: string): string {
  const path = output.match(/Full output saved to: (.+)\n/)?.[1]
  expect(path).toBeDefined()
  expect(path!.startsWith(temp + '/')).toBe(true)
  return path!
}

describe('Responses tool output field limit', () => {
  for (const transport of ['raw', 'sdk'] as const) {
    test(`${transport}: 42,985,300-character input[99].output is saved whole before the request`, async () => {
      const content = 'begin\n' + 'x'.repeat(42_985_300 - 10) + '\nend'
      const messages = history(content)
      const { send, requests, urls } = setup(transport)
      const notices: string[] = []
      const response = await withContextNoticeSink(n => notices.push(n.text), () => send(messages))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('continued')
      const output = requests[0].input[99]
      expect(output.type).toBe('function_call_output')
      expect(output.call_id).toBe('call_large')
      expect(output.output.length).toBeLessThan(10000)
      expect(await readFile(savedPath(output.output), 'utf8')).toBe(content)
      expect(messages.at(-1).content[0].content).toBe(content)
      expect(notices.join('\n')).toContain('10485760')
      expect(urls).toEqual(['https://output-test.invalid/v1/responses'])
      expect(requests[0].context_management).toEqual(transport === 'sdk'
        ? [{ type: 'compaction', compact_threshold: 600000 }] : undefined)
    })
  }

  test('checks concatenated text blocks and reuses the same file and preview after resume', async () => {
    const parts = [{ type: 'text', text: 'a'.repeat(6_000_000) }, { type: 'text', text: 'b'.repeat(6_000_000) }]
    const messages = history(parts, '../../unsafe-id')
    const first = setup('sdk', {})
    expect((await first.send(messages)).status).toBe(200)
    const output = first.requests[0].input[99].output
    expect(await readFile(savedPath(output), 'utf8')).toBe(parts.map(p => p.text).join(''))
    const resumed = setup('sdk', {})
    expect((await resumed.send(JSON.parse(JSON.stringify(messages)))).status).toBe(200)
    expect(resumed.requests[0].input[99].output).toBe(output)
    expect(resumed.requests[0].input[99].call_id).toBe('../../unsafe-id')
    expect(resumed.requests[0].context_management).toBeUndefined()
  })

  test('different output for the same call ID cannot reuse a stale file', async () => {
    const first = setup('sdk')
    const original = 'a'.repeat(upstreamMax + 1)
    const updated = 'b' + original.slice(1)
    await first.send(history(original))
    await first.send(history(updated))
    const paths = first.requests.map(r => savedPath(r.input[99].output))
    expect(paths[0]).not.toBe(paths[1])
    expect(await readFile(paths[1]!, 'utf8')).toBe(updated)
  })

  test('a string exactly at the character limit is unchanged, including non-ASCII text', async () => {
    const content = '中'.repeat(upstreamMax)
    const { send, requests } = setup('sdk')
    expect((await send(history(content))).status).toBe(200)
    expect(requests[0].input[99].output).toBe(content)
    expect(await readdir(temp)).toEqual([])
  })

  test('oversized history already covered by a checkpoint is not persisted or sent', async () => {
    const messages = history('x'.repeat(upstreamMax + 1))
    const checkpoint = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'checkpoint' }
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: encodeCompactionSignature(checkpoint) }] })
    messages.push({ role: 'user', content: 'continue' })
    const { send, requests } = setup('sdk')
    expect((await send(messages)).status).toBe(200)
    expect(requests[0].input).toEqual([checkpoint, { role: 'user', content: 'continue' }])
    expect(await readdir(temp)).toEqual([])
  })

  test('a disk error is reported locally without sending an invalid request or losing the result', async () => {
    const blockedPath = join(temp, 'not-a-directory')
    await writeFile(blockedPath, 'occupied')
    process.env.CLAUDE_CONFIG_DIR = blockedPath
    resetPaths()
    const content = 'x'.repeat(upstreamMax + 1)
    const messages = history(content)
    const { send, requests } = setup('sdk')
    const response = await send(messages)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('无法保存')
    expect(requests).toHaveLength(0)
    expect(messages.at(-1).content[0].content).toBe(content)
  })
})
