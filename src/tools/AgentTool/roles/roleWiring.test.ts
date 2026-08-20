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
import { contextUnmanaged } from '../../../services/compact/roleContextCeiling.js'

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
    // 两处都从 resolveRoleThinking 取值,所以永远不会一个发 xhigh 一个发别的。
    expect(out[0].agentDef.effort).toBe('xhigh')
    expect(out[0].agentDef.roleClientConfig?.thinkingDepth).toBe('xhigh')
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

/**
 * **自动压缩的绝对阈值**从 settings 一路走到 roleClientConfig ——
 * 对齐 codex 的 `model_auto_compact_token_limit`(那边是 `-c` 一行,我们这边是员工上的一个键)。
 *
 * 这一档只看两侧:settings 里写了什么 → roleClientConfig 上是什么 / 用户被告知了什么。
 * 阈值算术本身在 services/compact/autoCompactLimit.test.ts。
 */
describe('autoCompactTokenLimit 配得进去', () => {
  it('900000 和 "900k" 都收,落在 roleClientConfig 上', () => {
    for (const v of [900_000, '900k', '900000'] as const) {
      const out = parseRoles([api({ apiProtocol: 'openai-responses', contextWindow: '1m', autoCompactTokenLimit: v })], `probe-acl-${v}`)
      expect(`${v}: ${out[0]?.agentDef.roleClientConfig?.autoCompactTokenLimit}`).toBe(`${v}: 900000`)
    }
  })

  it('写法不认识:整条员工照样载入,但把原因说出来', () => {
    const source = 'probe-acl-bad'
    const out = parseRoles([api({ contextWindow: '1m', autoCompactTokenLimit: 'lots' })], source)
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.roleClientConfig?.autoCompactTokenLimit).toBeUndefined()
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('autoCompactTokenLimit')
    expect(reasons).toContain('900k')
  })

  /**
   * 压缩自己也是一次带着整段对话的请求。阈值贴着窗口 = 被上游拒的是压缩本身,
   * 而这个 fork 撞上去没有兜底。所以这个值有上限,而且**在载入时**就说出来 ——
   * 留给运行期的 Math.min 去悄悄夹的话,用户看到的是「我写了 995000,它 967000 就压了」。
   */
  it('高过窗口能用的上限:忽略,并且告诉用户最多能写多少', () => {
    const source = 'probe-acl-cap'
    const out = parseRoles([api({ contextWindow: '1m', autoCompactTokenLimit: 995_000 })], source)
    expect(out[0].agentDef.roleClientConfig?.autoCompactTokenLimit).toBeUndefined()
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('967000')
  })

  it('没声明 contextWindow 时,上限按那个**估出来的** 128k 算', () => {
    const source = 'probe-acl-assumed'
    const out = parseRoles([api({ apiProtocol: 'openai-responses', autoCompactTokenLimit: 900_000 })], source)
    expect(out[0].agentDef.roleClientConfig?.autoCompactTokenLimit).toBeUndefined()
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('97200')
  })

  it('cli 员工上写了它:不生效,而且说出来(那一档没有 roleClientConfig,外部 CLI 自己压)', () => {
    const source = 'probe-acl-cli'
    const out = parseRoles([{ name: 'cx', whenToUse: 'w', execMode: 'cli', command: 'codex', autoCompactTokenLimit: 900_000 }], source)
    expect(out).toHaveLength(1)
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('autoCompactTokenLimit')
    expect(reasons).toContain('cli')
  })
})

/**
 * **传输档**从 settings 一路走到 roleClientConfig。
 *
 * 两条传输的等价性由 `services/api/openaiCompat/transportParity.test.ts` 钉;这一档只管
 * 「用户写的那个字符串有没有变成这一席真正走的路」—— 灰度期间最需要能明确回答的就是这个,
 * 而一个被悄悄忽略的值会让那个问题变成猜。
 */
describe('transport 配得进去', () => {
  it('sdk / raw 都收,大小写和空格不计', () => {
    for (const [written, want] of [['sdk', 'sdk'], ['SDK', 'sdk'], [' raw ', 'raw']] as const) {
      const out = parseRoles([api({ apiProtocol: 'openai-responses', transport: written })], `probe-tr-${written}`)
      expect(`${written}: ${out[0]?.agentDef.roleClientConfig?.transport}`).toBe(`${written}: ${want}`)
    }
  })

  it('不写就是 undefined —— 默认走 raw,不靠字符串默认值', () => {
    const out = parseRoles([api({ apiProtocol: 'openai-responses' })], 'probe-tr-none')
    expect(out[0].agentDef.roleClientConfig?.transport).toBeUndefined()
  })

  it('写错的值不让整条员工消失,只记一条能照做的诊断', () => {
    const source = 'probe-tr-bad'
    const out = parseRoles([api({ apiProtocol: 'openai', transport: 'openai-sdk' })], source)
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.roleClientConfig?.transport).toBeUndefined()
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('raw / sdk')
  })

  it('anthropic 协议上写了它:忽略并说明(那一档是原样转发,没有可替换的帧来源)', () => {
    const source = 'probe-tr-anthropic'
    const out = parseRoles([api({ apiProtocol: 'anthropic', transport: 'sdk' })], source)
    expect(out[0].agentDef.roleClientConfig?.transport).toBeUndefined()
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('transport')
    expect(reasons).toContain('anthropic')
  })

  it('cli 员工上写了它:忽略并说明', () => {
    const source = 'probe-tr-cli'
    const out = parseRoles([{ name: 'cx', whenToUse: 'w', execMode: 'cli', command: 'codex', transport: 'sdk' }], source)
    expect(out).toHaveLength(1)
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('transport')
    expect(reasons).toContain('api')
  })
})

/**
 * `transport: 'sdk'` 改的不只是传输,而是**这一席不再做本地上下文管理**。这是一个会改变
 * 运行行为的开关,而效果要跑很久才看得出来,所以关口上要说一声 —— 说的是我们这边做了
 * 什么、哪些配置因此没有消费者,不预测交出去之后会发生什么。
 */
describe('sdk 档:后果和失效的配置都要在关口上说出来', () => {
  it('点名「不做上下文管理」', () => {
    const source = 'probe-sdk-unmanaged'
    parseRoles([api({ apiProtocol: 'openai-responses', transport: 'sdk' })], source)
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('不做本地上下文管理')
    expect(reasons).toContain('交给 SDK / 模型处理')
  })

  it('写了两个旋钮时,把它们各自的归宿说清(contextWindow 仍管工具产出预算)', () => {
    const source = 'probe-sdk-knobs'
    parseRoles([api({ apiProtocol: 'openai-responses', transport: 'sdk', contextWindow: '1m', autoCompactTokenLimit: 900_000 })], source)
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).toContain('autoCompactTokenLimit 无效')
    expect(reasons).toContain('工具产出的每消息预算')
  })

  it('raw 档一个字都不多说', () => {
    const source = 'probe-raw-quiet'
    parseRoles([api({ apiProtocol: 'openai-responses', contextWindow: '1m', autoCompactTokenLimit: 900_000 })], source)
    const reasons = roleLoadIssues().filter(i => i.source === source).map(i => i.reason).join('\n')
    expect(reasons).not.toContain('不做本地上下文管理')
  })
})

/**
 * **从 settings.json 那几行,直通「这一席做不做上下文管理」。**
 *
 * 前面几组用的是手搓的 config 对象,而生产里那个对象是 `parseRoles` 造出来的 ——
 * 这个仓库为「探针打在一个长得像的替身上」付过学费。
 */
describe('settings → 这一席做不做上下文管理', () => {
  const unmanaged = (role: Record<string, unknown>, source: string): boolean => {
    const out = parseRoles([api(role)], source)
    const cfg = out[0]?.agentDef.roleClientConfig
    expect(cfg).toBeDefined()
    return contextUnmanaged(cfg)
  }

  it('两条协议的 sdk 档都不管', () => {
    expect(unmanaged({ apiProtocol: 'openai-responses', transport: 'sdk' }, 'probe-own-a')).toBe(true)
    expect(unmanaged({ apiProtocol: 'openai', transport: 'sdk' }, 'probe-own-b')).toBe(true)
  })

  it('不写 transport:照常由我们管', () => {
    expect(unmanaged({ apiProtocol: 'openai-responses' }, 'probe-own-c')).toBe(false)
  })

  it('transport 写错(被忽略成 raw):照常由我们管 —— 一个打错的字不该把上下文管理悄悄关掉', () => {
    expect(unmanaged({ apiProtocol: 'openai-responses', transport: 'sdk1' }, 'probe-own-d')).toBe(false)
  })
})
