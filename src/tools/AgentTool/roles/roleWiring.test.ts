/**
 * 员工配置**接线**档 —— 从 settings.json 里那几行,到真正出网的那个请求。
 *
 * 存在的理由:纯函数档(roleThinking.test.ts)只能证明「翻译表是对的」,证明不了
 * 「这张表被接上了」。而这个仓库反复出的正是后一种错 —— 函数写对了、单测全绿、
 * 生产上零调用点。所以这一档只从两侧看:配置里写了什么 → 出网请求里是什么 /
 * 用户被告知了什么。
 */
import { describe, expect, it } from 'bun:test'
import { parseRoles, roleLoadIssues } from './rolesFromSettings.js'
import { buildRoleFetch } from '../../../services/api/openaiCompat/roleFetch.js'

const api = (over: Record<string, unknown> = {}) => ({
  name: 'gpt', whenToUse: 'w', execMode: 'api',
  apiUrl: 'https://x.example/v1', apiToken: 'sk', model: 'gpt-5.1', ...over,
})
/** 只看这一次 parse 产生的诊断。ISSUES 按来源覆盖,所以用独立的 source 名。 */
const issuesOf = (roles: unknown[], source: string): string[] => {
  parseRoles(roles, source)
  return roleLoadIssues().filter(i => i.source === source).map(i => i.reason)
}

describe('新协议真的配得进去', () => {
  it('apiProtocol: openai-responses 不再被 zod 拒掉', () => {
    // 这条今天是红的:enum 只有 anthropic|openai,整条员工被跳过,而用户只看到
    // 「这个员工不存在」。
    const out = parseRoles([api({ apiProtocol: 'openai-responses' })], 'probe-a')
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.roleClientConfig?.apiProtocol).toBe('openai-responses')
  })

  it('写错一个字时,原因是**数据**,不只是一句被吞掉的 console.error', () => {
    /**
     * ink 的 patchConsole 把 console.warn/error/trace 全改写成 logError —— 只进 debug
     * 日志文件,交互式会话的屏幕上一个字都不会出现。所以「少写一个 s」today 的表现是
     * 员工凭空消失、屏幕一言不发,用户分不清是自己打错字还是这个功能没做。
     */
    const reasons = issuesOf([api({ apiProtocol: 'openai-response' })], 'probe-b')
    expect(reasons.join('\n')).toContain('整条员工未载入')
    // 可照做的那半句必须排在**最前面** —— 它被夹到 100 字时最先活下来的应该是它。
    expect(reasons.join('\n')).toContain('apiProtocol 不是合法取值')
    expect(reasons.join('\n')).toContain('openai-responses')
  })

  it('三种协议名都在报错信息里列出来 —— 让用户能照着改', () => {
    const reasons = issuesOf([api({ apiProtocol: 'responses' })], 'probe-c').join('\n')
    for (const p of ['anthropic', 'openai', 'openai-responses']) expect(reasons).toContain(p)
  })
})

describe('思考级别一路走到出网请求', () => {
  it('xhigh 不再被静默丢弃', () => {
    // 今天:parseEffortValue('xhigh') = undefined,roleClientConfig 里连 thinkingDepth
    // 这个键都没有,零 stderr、零日志,员工看起来完全健康。
    const out = parseRoles([api({ apiProtocol: 'openai', thinkingDepth: 'xhigh' })], 'probe-d')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBe('xhigh')
  })

  it('max 在 OpenAI 侧被译成 xhigh,并且告诉用户', () => {
    const out = parseRoles([api({ apiProtocol: 'openai', thinkingDepth: 'max' })], 'probe-e')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBe('xhigh')
    expect(roleLoadIssues().filter(i => i.source === 'probe-e').map(i => i.reason).join()).toContain('xhigh')
  })

  it('数字在 OpenAI 侧不发,并且说清为什么 —— 这是今天就有的 400', () => {
    // 实测今天 "120" 会原样出网成 reasoning_effort: "120"。
    const out = parseRoles([api({ apiProtocol: 'openai', thinkingDepth: '120' })], 'probe-f')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBeUndefined()
    expect(roleLoadIssues().filter(i => i.source === 'probe-f').map(i => i.reason).join()).toContain('数字无效')
  })

  it('JSON 数字不再让**整条员工**消失', () => {
    // 今天:z.string() + .strict() → "expected string, received number" → 员工被跳过。
    // 而文档明写着可以填一个数字。
    const out = parseRoles([api({ apiProtocol: 'anthropic', model: 'claude-opus-4-6-x', thinkingDepth: 80 })], 'probe-g')
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.effort).toBe(80)
  })

  it('认不出来的档位记一条诊断,而不是无声无息', () => {
    const reasons = issuesOf([api({ thinkingDepth: 'deep' })], 'probe-h').join()
    expect(reasons).toContain('无法识别')
    expect(reasons).toContain('xhigh')
  })

  it('翻译型协议下 agentDef.effort 置空 —— 那条路上它是死代码', () => {
    /**
     * effort 进的是 claude.ts 的 output_config,而 toOpenAIRequest / toResponsesRequest
     * 都是显式白名单,output_config 从来没被拷进出网请求。留一个值只会坑下一个人:
     * 它看起来像生效了。
     */
    for (const p of ['openai', 'openai-responses']) {
      const out = parseRoles([api({ apiProtocol: p, thinkingDepth: 'high' })], `probe-i-${p}`)
      expect(`${p}: ${out[0].agentDef.effort}`).toBe(`${p}: undefined`)
    }
  })

  it('anthropic 协议下两个字段仍然一致 —— 一份判据两个调用点', () => {
    const out = parseRoles([api({ apiProtocol: 'anthropic', model: 'claude-opus-4-6-x', thinkingDepth: 'xhigh' })], 'probe-j')
    // xhigh 在 Anthropic 侧没有,统一降成 high —— 两处不能各降各的。
    expect(out[0].agentDef.effort).toBe('high')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBe('high')
  })
})

describe('出网请求真的按协议分流', () => {
  const capture = () => {
    const seen: { url: string; body: any }[] = []
    const inner = async (url: any, init: any) => {
      seen.push({ url: String(url), body: JSON.parse(init.body as string) })
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return { seen, inner }
  }
  const anthropicBody = JSON.stringify({
    model: 'claude-alias', max_tokens: 100, stream: true,
    messages: [{ role: 'user', content: '你好' }],
  })

  it('openai → /chat/completions', async () => {
    const { seen, inner } = capture()
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://x.example/v1', apiToken: 'sk', backendModel: 'gpt-4o' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', body: anthropicBody })
    expect(seen[0].url).toBe('https://x.example/v1/chat/completions')
    expect(seen[0].body.messages).toBeDefined()
  })

  it('openai-responses → /responses,而且发的是 input 不是 messages', async () => {
    const { seen, inner } = capture()
    const f = buildRoleFetch({ apiProtocol: 'openai-responses', apiUrl: 'https://x.example/v1', apiToken: 'sk', backendModel: 'gpt-5.1', thinkingDepth: 'xhigh' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', body: anthropicBody })
    expect(seen[0].url).toBe('https://x.example/v1/responses')
    expect(seen[0].body.input).toEqual([{ role: 'user', content: '你好' }])
    expect(seen[0].body.messages).toBeUndefined()
    expect(seen[0].body.max_output_tokens).toBe(100)
    // 思考档位一路走到了 reasoning.effort —— 这是「配了但没生效」的正面。
    expect(seen[0].body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
  })

  it('apiUrl 自己的路径前缀不会被冲掉', async () => {
    const { seen, inner } = capture()
    const f = buildRoleFetch({ apiProtocol: 'openai-responses', apiUrl: 'https://gw.example/openai/v1/', apiToken: 'sk', backendModel: 'm' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', body: anthropicBody })
    expect(seen[0].url).toBe('https://gw.example/openai/v1/responses')
  })

  it('两种协议都换成 Bearer,并且把全局的 x-api-key 摘掉', async () => {
    for (const p of ['openai', 'openai-responses'] as const) {
      let h = new Headers()
      const inner = async (_u: any, init: any) => { h = new Headers(init.headers as HeadersInit); return new Response('', { status: 200 }) }
      const f = buildRoleFetch({ apiProtocol: p, apiUrl: 'https://x.example/v1', apiToken: 'sk-role', backendModel: 'm' }, inner as any)
      await f('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: new Headers({ 'x-api-key': 'GLOBAL', authorization: 'Bearer GLOBAL' }), body: anthropicBody,
      })
      expect(`${p}: ${h.get('authorization')}`).toBe(`${p}: Bearer sk-role`)
      expect(`${p}: ${h.get('x-api-key')}`).toBe(`${p}: null`)
    }
  })
})
