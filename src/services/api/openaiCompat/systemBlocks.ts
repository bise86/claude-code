/**
 * 发给**第三方模型**之前,把 Anthropic 专属的那两块从系统提示词里摘掉。
 *
 * ## 摘的是哪两块
 *
 * `claude.ts` 在每次请求前会往系统提示词最前面拼两块(见那里的 `asSystemPrompt([...])`):
 *
 *   [0] `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;`
 *   [1] `You are Claude Code, Anthropic's official CLI for Claude.`(或它的两个 SDK 变体)
 *   [2] …这一席自己的系统提示词(员工 prompt、工具说明、环境信息)
 *
 * 前两块是给 **Anthropic 的 API** 的:一个是计费/归因标识,一个是 Claude 自己的身份前缀。
 * 原样转给 gpt / GLM 这类后端时,第一块是纯噪音,第二块更糟 —— 它在告诉一个不是 Claude
 * 的模型「你是 Claude Code」。
 *
 * **[2] 一定要留下。** 那里面是这一席怎么干活的全部依据(员工 prompt、可用工具、
 * 产出格式)。摘掉它等于让席位裸奔,而这个仓库对「席位交出空产出」已经有过教训。
 *
 * ## 为什么标记写在这里而不是 import 过来
 *
 * 真身在 `constants/system.ts`,但那个模块拖着 growthbook 和 provider 解析,而这条链
 * (translator → protocols → rolesFromSettings)跑在**员工载入**那一段,是启动最早的路径之一。
 * 所以这里只写两个字面量,并由 `systemBlocks.test.ts` **import 真身来对着核** ——
 * 漂移由测试挡,不由注释挡。
 */

/** 归因块的行首。真身:`constants/system.ts` 的 `getAttributionHeader`。 */
const ATTRIBUTION_PREFIX = 'x-anthropic-billing-header'

/** 身份前缀的三个取值。真身:`constants/system.ts` 的 `CLI_SYSPROMPT_PREFIX_VALUES`。 */
const CLI_PREFIXES: readonly string[] = [
  `You are Claude Code, Anthropic's official CLI for Claude.`,
  `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`,
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.`,
]

/** 这一块是不是 Anthropic 专属的(归因 / 身份前缀)。 */
function isAnthropicOnly(text: string): boolean {
  const t = text.trim()
  return t.startsWith(ATTRIBUTION_PREFIX) || CLI_PREFIXES.includes(t)
}

/**
 * @param system anthropic 请求体里的 `system`(文本块数组,或者一整段字符串)
 * @returns 同样形状,去掉那两块。没有可摘的就原样返回。
 */
export function stripAnthropicSystemBlocks(system: unknown): unknown {
  if (typeof system === 'string') {
    /**
     * 字符串形态在 `claude.ts` 那条路上不会出现(它给的是块数组),但这一层被别的调用方
     * 直接喂过请求体。按**整行**摘,不做子串替换:身份前缀那句话完全可能出现在员工自己
     * 写的提示词正文里,而那是用户的话,不该被我们剪掉。
     */
    const kept = system.split('\n').filter(line => !isAnthropicOnly(line))
    return kept.join('\n')
  }
  if (!Array.isArray(system)) return system
  return system.filter(b => {
    const text = typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''
    return text.length === 0 || !isAnthropicOnly(text)
  })
}
