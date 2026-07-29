import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { anthropicEventsToSSE } from './blocks.js'
import { TRANSLATING_PROTOCOLS } from './protocols.js'
import { joinRoute, parseSSE } from './sse.js'

export function buildRoleFetch(cfg: RoleClientConfig, inner: typeof fetch = fetch): typeof fetch {
  const target = new URL(cfg.apiUrl)
  return (async (url: any, init: any = {}) => {
    // Normalize via the WHATWG Headers API (case-insensitive) so we don't
    // silently drop SDK-set headers passed as a `Headers` instance — spreading
    // a `Headers` instance (`{ ...init.headers }`) yields `{}`, since its
    // entries live behind iterators/symbols rather than own enumerable props.
    const headers = new Headers(init.headers as HeadersInit)
    headers.delete('authorization')

    if (cfg.apiProtocol === 'anthropic') {
      headers.set('x-api-key', cfg.apiToken)
      const orig = new URL(String(url))
      // Concatenate apiUrl's own path (e.g. `/anthropic`) with the incoming
      // request's path — `new URL(orig.pathname, target)` would instead
      // *replace* target's path per WHATWG absolute-path resolution, dropping
      // any prefix apiUrl carries (e.g. MiniMax's documented `/anthropic`).
      //
      // 但只能拼**API 自己那一段**(`/v1/...`),不能拼整个 orig.pathname:orig 是 SDK
      // 按**会话自己的** baseURL 拼出来的完整路径。用户把 ANTHROPIC_BASE_URL 指到同一个
      // 第三方厂商(带路径,比如 https://vendor.example.com/anthropic)时,两段路径会**叠加**:
      //   会话 base /anthropic + 员工 apiUrl /coding → /coding/anthropic/v1/messages → 404
      // 而 404 会被 errors.ts 统一翻译成「模型有问题(K3)」—— 一路把人往改模型名上带。
      // 「只写 env 时一切正常、一加 roles[] 就炸」正是这个叠加造成的。
      // 叠加有**两个**方向,都要堵:
      //  (a) 会话侧:orig 是 SDK 按会话自己的 baseURL 拼出来的完整路径,带路径的
      //      ANTHROPIC_BASE_URL 会把自己那一段塞进来 → 只取 API 自己的 `/v1/...`;
      //  (b) 员工侧:apiUrl 本身就以 `/v1` 结尾(docs/roles-setup.md 里 openai 的例子
      //      正是这么写的,而文档没有一句说 anthropic 的不能这么写)→ 剥掉它。
      // 实测:员工 apiUrl = https://my-proxy.example.com/v1 时,只堵 (a) 仍然拼成
      // /v1/v1/messages,上游明写 `path /v1/v1/messages not found`,而 errors.ts 把这个
      // 404 翻译成「模型有问题(K3)」—— 一路把人往改模型名上带。
      const v1 = orig.pathname.indexOf('/v1/')
      const apiSuffix = v1 >= 0 ? orig.pathname.slice(v1) : orig.pathname
      const base = target.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
      const dest = new URL(base + apiSuffix + orig.search, target.origin)
      return inner(dest.toString(), { ...init, headers })
    }

    /**
     * 要翻译的协议。**查表**,不是 if 链 —— 新增一种 OpenAI 系方言时这个文件一行不动。
     *
     * 认不出来的协议名走 openai(chat/completions)兜底:配置那一侧的 zod enum 已经
     * 挡住了写错的值,能到这里的只有「表里新加了名字但忘了加表项」这一种内部不一致,
     * 而那时候退化成最常见的方言,比抛一个用户看不懂的异常要好。
     */
    const proto = TRANSLATING_PROTOCOLS[cfg.apiProtocol] ?? TRANSLATING_PROTOCOLS.openai!
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${cfg.apiToken}`)
    headers.set('content-type', 'application/json')
    const anthropicBody = JSON.parse(init.body as string)
    const outBody = proto.buildBody(anthropicBody, cfg)
    const res = await inner(joinRoute(target.toString(), proto.route), { ...init, method: 'POST', headers, body: JSON.stringify(outBody) })
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText || res.statusText } }), { status: res.ok ? 502 : res.status, headers: { 'content-type': 'application/json' } })
    }
    const events = proto.toAnthropicEvents(parseSSE(res), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
