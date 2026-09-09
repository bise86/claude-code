import { describe, expect, it } from 'bun:test'
import { RetrySession, createRetrySession, withRetrySession } from './retrySession.js'
import { buildRoleFetch } from './openaiCompat/roleFetch.js'
import type { RoleClientConfig } from '../../tools/AgentTool/roles/roleTypes.js'

describe('会话更换的有限预算', () => {
  it('首次 + 3 次重试才更换,最多两次,最后一组用原有上限', () => {
    const session = new RetrySession()
    const attempts: number[] = []
    const nonces: (string | undefined)[] = []
    do {
      attempts.push(session.attempt)
      nonces.push(session.nonce)
      if (attempts.length > 20) throw new Error('重试循环未收口')
    } while (session.next(10))
    expect(attempts).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(new Set(nonces).size).toBe(3)
    expect(nonces.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined])
    expect(session.rotations).toBe(2)
  })

  for (const maxRetries of [0, 1, 2]) {
    it(`用户预算 ${maxRetries} 小于 3 时不额外更换`, () => {
      const session = new RetrySession()
      let calls = 1
      while (session.next(maxRetries)) calls++
      expect(calls).toBe(maxRetries + 1)
      expect(session.rotations).toBe(0)
    })
  }
  it('无效预算也不能变成无限重试', () => {
    for (const budget of [NaN, Infinity, -1]) expect(new RetrySession().next(budget)).toBeUndefined()
  })
})

const config: RoleClientConfig = {
  apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/v1', apiToken: 'test',
  backendModel: 'test-model', rotateSessionOnRetry: true,
}
const request = {
  method: 'POST',
  body: JSON.stringify({ model: 'test', stream: true, messages: [{ role: 'user', content: 'same conversation' }] }),
}
type Captured = { headers: Headers; body: any }
const capture = (out: Captured[]) => (async (_url: unknown, init: RequestInit) => {
  out.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
  return new Response('event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
}) as typeof fetch
const send = async (fetch: typeof globalThis.fetch, session?: RetrySession) => {
  await withRetrySession(session, async () => {
    await (await fetch('https://api.anthropic.com/v1/messages', request)).text()
  })
}
const rotate = (session: RetrySession) => { for (let i = 0; i < 4; i++) session.next(10) }

describe('更换会话头但保留 NewAPI 路由键', () => {
  it('默认关闭,anthropic 即使设了开关也不开放更换能力', () => {
    for (const cfg of [{ ...config, rotateSessionOnRetry: undefined },
      { ...config, rotateSessionOnRetry: false }, { ...config, apiProtocol: 'anthropic' as const }]) {
      expect(createRetrySession(buildRoleFetch(cfg))).toBeUndefined()
    }
  })

  it('头和 metadata 同步更换,缓存键/请求内容/installation 不变,后续轮次沿用新会话', async () => {
    const cfg = { ...config }
    const seen: Captured[] = []
    const fetch = buildRoleFetch(cfg, capture(seen))
    const session = createRetrySession(fetch)!
    await send(fetch, session)
    rotate(session)
    await send(fetch, session)
    await send(buildRoleFetch(cfg, capture(seen)))
    const [old, changed, later] = seen
    expect(changed.body).toEqual(old.body)
    expect(changed.body.prompt_cache_key).toBe(old.headers.get('session-id'))
    expect(changed.headers.get('session-id')).not.toBe(old.headers.get('session-id'))
    expect(changed.headers.get('thread-id')).not.toBe(old.headers.get('thread-id'))
    expect(later.headers.get('session-id')).toBe(changed.headers.get('session-id'))
    const meta = JSON.parse(changed.headers.get('x-codex-turn-metadata')!)
    expect(meta.session_id).toBe(changed.headers.get('session-id'))
    expect(meta.thread_id).toBe(changed.headers.get('thread-id'))
    expect(meta.window_id).toBe(changed.headers.get('x-codex-window-id'))
    expect(meta.installation_id).toBe(JSON.parse(old.headers.get('x-codex-turn-metadata')!).installation_id)
  })

  it('相同提示词的并发调用各带自己的标识,另一员工不受影响', async () => {
    const seen: Captured[] = []
    const fetch = buildRoleFetch({ ...config }, capture(seen))
    const a = createRetrySession(fetch)!
    const b = createRetrySession(fetch)!
    rotate(a)
    await Promise.all([send(fetch, a), send(fetch, b)])
    await send(buildRoleFetch({ ...config }, capture(seen)))
    expect(seen[0].headers.get('session-id')).not.toBe(seen[1].headers.get('session-id'))
    expect(seen[1].headers.get('session-id')).toBe(seen[2].headers.get('session-id'))
    expect(new Set(seen.map(s => s.body.prompt_cache_key)).size).toBe(1)
  })
})
