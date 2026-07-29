import { describe, expect, it } from 'bun:test'
import { parseRoleThinking, resolveRoleThinking, ROLE_THINKING_LEVELS } from './roleThinking.js'
import { EFFORT_LEVELS } from '../../../utils/effort.js'

// 支持 effort 的 Claude 模型名。modelSupportsEffort 认 opus-4-6 / sonnet-4-6。
const CLAUDE = 'claude-opus-4-6-20260101'
// 不支持 effort 的旧模型 —— 正是 docs/roles-setup.md 里那个示例配的。
const OLD_CLAUDE = 'claude-3-5-sonnet-20241022'

describe('parseRoleThinking', () => {
  it('五个档位都认,而且大小写不敏感', () => {
    for (const l of ROLE_THINKING_LEVELS) {
      expect(`${l} → ${parseRoleThinking(l)}`).toBe(`${l} → ${l}`)
      expect(parseRoleThinking(l.toUpperCase())).toBe(l)
    }
  })

  it('xhigh 是这一层新增的那一档', () => {
    // 全局的 EFFORT_LEVELS 里没有它 —— 那个列表绑着 /effort 选择器和 settings schema,
    // 为员工多一个档位去改它,改动面远大于收益。
    expect(EFFORT_LEVELS).not.toContain('xhigh' as never)
    expect(parseRoleThinking('xhigh')).toBe('xhigh')
  })

  it('xhigh 两边都收 —— 只有 max 是 Anthropic 独有的', () => {
    expect(resolveRoleThinking({ level: 'xhigh', protocol: 'anthropic', model: CLAUDE }).value).toBe('xhigh')
    expect(resolveRoleThinking({ level: 'xhigh', protocol: 'openai', model: 'gpt-5.1' }).value).toBe('xhigh')
    expect(resolveRoleThinking({ level: 'max', protocol: 'openai', model: 'gpt-5.1' }).value).toBe('xhigh')
  })

  it('数字和数字字符串都收', () => {
    expect(parseRoleThinking(80)).toBe(80)
    expect(parseRoleThinking('120')).toBe(120)
    expect(parseRoleThinking(1.5)).toBeUndefined()
  })

  it('认不出来的返回 undefined —— 由调用方负责说给用户听', () => {
    expect(parseRoleThinking('deep')).toBeUndefined()
    expect(parseRoleThinking('')).toBeUndefined()
    expect(parseRoleThinking(undefined)).toBeUndefined()
    expect(parseRoleThinking(null)).toBeUndefined()
  })
})

describe('anthropic 协议', () => {
  const at = (level: any, model = CLAUDE) => resolveRoleThinking({ level, protocol: 'anthropic', model })

  it('三个通用档位原样发', () => {
    for (const l of ['low', 'medium', 'high'] as const) expect(at(l).value).toBe(l)
    expect(at('low').note).toBeUndefined()
  })

  it('xhigh 原样发,而且**不说废话** —— 没被翻译就没有 note', () => {
    // 翻译层只在真的改了你写的东西时才出声。无条件出声的话,真正需要注意的那几条
    // 会淹没在一片「已按 X 发送」里。
    const r = at('xhigh')
    expect(r.value).toBe('xhigh')
    expect(r.note).toBeUndefined()
  })

  it('模型不支持 effort 时**整段不发**,而且这件事必须说出来', () => {
    /**
     * configureEffortParams 的第一句就是 `if (!modelSupportsEffort(model)) return`。
     * 这是比 xhigh 静默丢弃**更大**的一个静默丢弃:docs/roles-setup.md 的示例正是
     * claude-3-5-sonnet + thinkingDepth:"max",那份示例做不到它自己写的事。
     */
    const r = at('max', OLD_CLAUDE)
    expect(r.value).toBeUndefined()
    expect(r.note).toContain('不支持 effort')
    expect(r.note).toContain(OLD_CLAUDE)
  })

  it('模型不支持 max 时照实说会按 high 发', () => {
    const r = at('max', 'claude-sonnet-4-6-20260101')
    expect(r.note).toContain('max')
    expect(r.note).toContain('high')
  })

  it('数字档保持既有行为(ant-only 的 effort_override)', () => {
    expect(at(80).value).toBe(80)
  })
})

describe('openai / openai-responses 协议', () => {
  for (const protocol of ['openai', 'openai-responses']) {
    const at = (level: any) => resolveRoleThinking({ level, protocol, model: 'gpt-5.1' })

    it(`${protocol}: 四个档位原样发,包括 xhigh`, () => {
      for (const l of ['low', 'medium', 'high', 'xhigh'] as const) {
        expect(`${l} → ${at(l).value}`).toBe(`${l} → ${l}`)
      }
    })

    it(`${protocol}: max → xhigh,并且说出来`, () => {
      // OpenAI 的 ReasoningEffort 联合里没有 max,原样发出去是 400。
      const r = at('max')
      expect(r.value).toBe('xhigh')
      expect(r.note).toContain('max')
      expect(r.note).toContain('xhigh')
    })

    it(`${protocol}: 数字不发,而且说清为什么`, () => {
      /**
       * 这是今天就有的一个 live bug:toOpenAIRequest 是裸的
       * `if (thinkingDepth) out.reasoning_effort = thinkingDepth`,
       * 实测 "120" 原样出网成 `reasoning_effort: "120"` → 上游 400。
       * 而 docs/roles-setup.md 明写着可以填一个数字。
       */
      const r = at(120)
      expect(r.value).toBeUndefined()
      expect(r.note).toContain('数字无效')
      expect(r.note).toContain('xhigh')
    })

    it(`${protocol}: 模型名不影响判定 —— 第三方模型名的能力表在这里没有意义`, () => {
      expect(resolveRoleThinking({ level: 'high', protocol, model: 'deepseek-chat' }).value).toBe('high')
    })
  }
})

describe('没配就什么都不发', () => {
  it('三种协议一致', () => {
    for (const protocol of ['anthropic', 'openai', 'openai-responses']) {
      const r = resolveRoleThinking({ level: undefined, protocol, model: CLAUDE })
      expect(`${protocol}: ${JSON.stringify(r)}`).toBe(`${protocol}: {}`)
    }
  })
})

describe('模型别名', () => {
  it('别名先解析成全名再判能力 —— 否则 `opus` 会被判成不支持 effort', () => {
    /**
     * 这一层跑在**解析期**拿用户写的原始串,而 configureEffortParams 跑在**请求期**
     * 拿 getAgentModel 解析过别名的全名。实测 modelSupportsEffort('opus') 是 false、
     * ('claude-opus-4-6') 是 true —— 不解析的话关口会印一句假话,同时把档位静默丢掉。
     */
    const r = resolveRoleThinking({ level: 'high', protocol: 'anthropic', model: 'opus' })
    expect(r.value).toBe('high')
    expect(r.note).toBeUndefined()
  })

  it('模型名为空时不印一个空洞的「模型 ␣ 不支持」', () => {
    // cli 角色可以不写 model。
    const r = resolveRoleThinking({ level: 'high', protocol: 'anthropic', model: '' })
    expect(r.note ?? '').not.toContain('模型  ')
  })
})
