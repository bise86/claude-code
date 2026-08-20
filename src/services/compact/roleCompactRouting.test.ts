/**
 * 压缩那次请求,**仍然是这个员工在说话**。
 *
 * 阈值算对了、火也开了,但压缩本身是一次**带着整段对话**的模型调用 —— 它如果打回
 * Anthropic(用父会话的模型和凭据),对一个挂在第三方网关上的席位来说结果是:
 * 上下文一涨满就必然失败,而屏幕上的说法会是「压缩失败」,没人会去看端点。
 *
 * 链路是两段,这里两段都用**真身**跑:
 *  1. 压缩是一次 fork(`compact.ts` → `runForkedAgent` → `createSubagentContext`),
 *     fork 必须把 `options.roleClientConfig` 原样带过去;
 *  2. `query.ts` 拿这份配置解析出这一轮的 fetch(`resolveRoleFetch`),它决定请求打到哪。
 *
 * 中间那一句「query.ts 用的就是 fork 出来的那个 options」是一行接线
 * (`fetchOverride: resolveRoleFetch(toolUseContext.options.roleClientConfig)`),不在这里。
 */
import { expect, test } from 'bun:test'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { resolveRoleFetch } from '../../query.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'

const SEAT = {
  apiProtocol: 'openai-responses' as const,
  apiUrl: 'https://probe.example/v1',
  apiToken: 'sk-role',
  backendModel: 'gpt-5.1',
  roleName: 'seat',
  contextWindow: 1_000_000,
  autoCompactTokenLimit: 900_000,
}

const seatContext = (): any => ({
  options: { mainLoopModel: 'claude-opus-4-5', tools: [], roleClientConfig: SEAT },
  abortController: new AbortController(),
  agentId: 'seat-1',
  readFileState: createFileStateCacheWithSizeLimit(10),
  getAppState: () => ({ toolPermissionContext: {} }),
  setAppState: () => {},
})

test('压缩 fork 把员工配置原样带过去(窗口和阈值一起)', () => {
  const forked = createSubagentContext(seatContext(), { abortController: new AbortController() } as any)
  expect(forked.options.roleClientConfig?.apiUrl).toBe(SEAT.apiUrl)
  expect(forked.options.roleClientConfig?.contextWindow).toBe(1_000_000)
  expect(forked.options.roleClientConfig?.autoCompactTokenLimit).toBe(900_000)
})

test('这份配置解析出来的 fetch 打到 {apiUrl}/responses,用员工自己的模型和 token', async () => {
  const seen: { url: string; model?: string; auth: string | null }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (u: any, init: any) => {
    let model: string | undefined
    try { model = JSON.parse(String(init?.body)).model } catch { /* 非 JSON 体不关心 */ }
    seen.push({ url: String(u), model, auth: new Headers(init?.headers as HeadersInit).get('authorization') })
    return new Response('', { status: 200 })
  }) as any
  try {
    const forked = createSubagentContext(seatContext(), { abortController: new AbortController() } as any)
    const f = resolveRoleFetch(forked.options.roleClientConfig, undefined)
    // 压缩发出去的就是一条普通的 anthropic /v1/messages —— 摘要请求和别的请求走同一条路。
    await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 100,
        messages: [{ role: 'user', content: '把上面的对话总结一下' }],
      }),
    })
  } finally {
    globalThis.fetch = orig
  }
  expect(seen[0]?.url).toBe('https://probe.example/v1/responses')
  expect(seen[0]?.model).toBe('gpt-5.1')
  expect(seen[0]?.auth).toBe('Bearer sk-role')
})
