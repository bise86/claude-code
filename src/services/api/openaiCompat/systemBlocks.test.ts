/**
 * **Anthropic 专属的两块不发给第三方模型,而这一席自己的提示词必须原样留下。**
 *
 * 最后一条 `import 真身对着核` 是这一组的核心:标记字面量为了不把 growthbook 拖进
 * 员工载入路径而写在本地,漂移只能靠测试挡 —— 注释挡不住。
 */
import { describe, expect, it } from 'bun:test'
import { CLI_SYSPROMPT_PREFIXES } from '../../../constants/system.js'
import { stripAnthropicSystemBlocks } from './systemBlocks.js'
import { toResponsesRequest } from './toResponsesRequest.js'
import { toOpenAIRequest } from './toOpenAIRequest.js'

const ATTR = 'x-anthropic-billing-header: cc_version=1.2.3.abc; cc_entrypoint=cli;'
const IDENT = `You are Claude Code, Anthropic's official CLI for Claude.`
const SEAT = '你是这个任务的执行者。产出必须写进 execStatus。'

/** claude.ts 组装之后真正上线的形状:最多三块文本(见 utils/api.ts 的 splitSysPromptPrefix)。 */
const wireSystem = () => [
  { type: 'text', text: ATTR },
  { type: 'text', text: IDENT },
  { type: 'text', text: SEAT },
]

describe('摘掉哪些、留下哪些', () => {
  it('归因块和身份前缀被摘掉,员工自己的提示词留下', () => {
    const out = stripAnthropicSystemBlocks(wireSystem()) as any[]
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe(SEAT)
  })

  it('三个身份前缀变体都认得', () => {
    for (const p of CLI_SYSPROMPT_PREFIXES) {
      const out = stripAnthropicSystemBlocks([{ type: 'text', text: p }, { type: 'text', text: SEAT }]) as any[]
      expect(`${p.slice(0, 20)}: ${out.length}`).toBe(`${p.slice(0, 20)}: 1`)
    }
  })

  it('字符串形态按整行摘,不做子串替换', () => {
    // 身份前缀那句话完全可能出现在员工自己写的正文里 —— 那是用户的话,不许剪。
    const s = `${ATTR}\n${IDENT}\n参考:${IDENT} 这句话是我引用的,不要删`
    const out = stripAnthropicSystemBlocks(s) as string
    expect(out).toBe(`参考:${IDENT} 这句话是我引用的,不要删`)
  })

  it('没有可摘的就原样返回', () => {
    const only = [{ type: 'text', text: SEAT }]
    expect(stripAnthropicSystemBlocks(only)).toEqual(only)
    expect(stripAnthropicSystemBlocks(undefined)).toBeUndefined()
  })
})

describe('两个翻译器都接上了', () => {
  const body = { model: 'claude-alias', max_tokens: 100, stream: true, system: wireSystem(), messages: [{ role: 'user', content: 'hi' }] }

  it('openai-responses:instructions 里没有那两块', () => {
    const out: any = toResponsesRequest(body, { backendModel: 'gpt-5.1' })
    expect(out.instructions).toBe(SEAT)
    expect(out.instructions).not.toContain('x-anthropic-billing-header')
    expect(out.instructions).not.toContain('Claude Code')
  })

  it('openai(chat):system 消息里没有那两块', () => {
    const out: any = toOpenAIRequest(body, 'gpt-4o')
    const sys = out.messages.find((m: any) => m.role === 'system')
    expect(sys.content).toBe(SEAT)
    expect(sys.content).not.toContain('Claude Code')
  })
})

/**
 * **标记字面量必须和真身一致。** 本地那份是为了不把 growthbook 拖进员工载入路径而抄的,
 * 抄本和真身漂移时,表现是「新版本的身份前缀原样发给了第三方模型」—— 静默,没人会发现。
 */
describe('抄本和真身对得上', () => {
  it('constants/system 里的每一个身份前缀都会被摘掉', () => {
    for (const p of CLI_SYSPROMPT_PREFIXES) {
      const out = stripAnthropicSystemBlocks([{ type: 'text', text: p }]) as any[]
      expect(`${p}: ${out.length}`).toBe(`${p}: 0`)
    }
  })
})
