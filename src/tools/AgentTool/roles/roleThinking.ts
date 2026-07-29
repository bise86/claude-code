import { modelSupportsEffort, modelSupportsMaxEffort } from '../../../utils/effort.js'

/**
 * 员工的**思考级别**。
 *
 * 为什么不直接用 `utils/effort.ts` 的 `EFFORT_LEVELS`:那个列表(low/medium/high/max)
 * 绑着 `/effort` 选择器、settings 的 zod schema、以及 `modelSupportsEffort` /
 * `modelSupportsMaxEffort` 的模型能力判定。为了员工多一个档位去改它,改动面远大于收益,
 * 而且会把 `xhigh` 泄进主循环的 UI —— 那一档是 OpenAI 的,Anthropic 的 API 收不了。
 *
 * 两边的合法值本来就不是一个集合:
 *  - Anthropic 的 `output_config.effort`:low / medium / high / **max**
 *  - OpenAI 的 `reasoning_effort` / `reasoning.effort`:(none / minimal /) low / medium / high / **xhigh**
 *
 * 所以这一层的职责就一件事:**把用户写的那个词翻译成这个协议+这个模型真正收得下的值,
 * 翻不过去的时候说出来**,而不是静默丢掉。静默丢掉正是今天的行为 ——
 * `parseEffortValue('xhigh')` 返回 undefined,配了等于没配,零提示。
 */
export const ROLE_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type RoleThinkingLevel = (typeof ROLE_THINKING_LEVELS)[number]

/** 配置里写的那个值,归一之后的样子。数字是 Anthropic 的 ant-only 覆盖档。 */
export type RoleThinking = RoleThinkingLevel | number

/**
 * 解析 `thinkingDepth`。**大小写不敏感**(和 parseEffortValue 一致),数字和数字字符串都收。
 *
 * 认不出来的返回 undefined —— 调用方负责把「认不出来」说给用户听。
 */
export function parseRoleThinking(value: unknown): RoleThinking | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  const str = String(value).trim().toLowerCase()
  if ((ROLE_THINKING_LEVELS as readonly string[]).includes(str)) return str as RoleThinkingLevel
  const n = Number.parseInt(str, 10)
  return Number.isNaN(n) ? undefined : n
}

export interface ResolvedThinking {
  /** 真正会发出去的值。undefined = 这次一个思考参数都不发。 */
  value?: string | number
  /**
   * 要说给用户听的话。**不为空就必须上屏** —— 这个项目反复出的错就是
   * 「界面告诉用户一件不真的事」,而「你配了但它没生效」是同一类。
   */
  note?: string
}

/**
 * (档位, 协议, 模型)→ 实际会发出去什么。
 *
 * **模型这个参数不能省。** Anthropic 那条路上 `configureEffortParams` 的第一句就是
 * `if (!modelSupportsEffort(model)) return` —— 也就是说模型不在支持名单里时,整个
 * effort 参数**一个字都不发**。而 `docs/roles-setup.md` 里那个示例配的正是
 * `claude-3-5-sonnet-20241022` + `thinkingDepth: "max"`:实测 `modelSupportsEffort`
 * 对它返回 false,那份示例做不到它自己写的事,而屏幕上一句提示都没有。
 * 只修 xhigh 的静默丢弃、留着这个更大的静默丢弃,等于没修。
 */
export function resolveRoleThinking(args: {
  level: RoleThinking | undefined
  protocol: string
  model: string
}): ResolvedThinking {
  const { level, protocol, model } = args
  if (level === undefined) return {}
  const translating = protocol !== 'anthropic'

  if (!translating) {
    if (!modelSupportsEffort(model)) {
      return { note: `思考级别 ${level}:模型 ${model} 不支持 effort 参数,本次不会发送思考级别` }
    }
    if (level === 'xhigh') {
      // Anthropic 没有这一档(BetaOutputConfig.effort 只收 low/medium/high/max)。
      return { value: 'high', note: `思考级别 xhigh:Anthropic 协议没有这一档,已按 high 发送` }
    }
    if (level === 'max' && !modelSupportsMaxEffort(model)) {
      // resolveAppliedEffort 会把它降成 high,而屏幕上此前一句都没说。
      return { value: 'max', note: `思考级别 max:模型 ${model} 不支持 max,实际会按 high 发送` }
    }
    return { value: level }
  }

  // openai / openai-responses
  if (typeof level === 'number') {
    /**
     * 数字档 OpenAI 收不了。这不是新增的限制,是**今天就有的一个 live bug**:
     * `toOpenAIRequest` 是裸的 `if (thinkingDepth) out.reasoning_effort = thinkingDepth`,
     * 实测 `"120"` 会原样出网成 `reasoning_effort: "120"` —— 上游 400,而
     * `docs/roles-setup.md` 明写着可以填一个数字。
     */
    return { note: `思考级别 ${level}:OpenAI 系协议只收档位名(${ROLE_THINKING_LEVELS.join(' / ')}),数字无效,本次不会发送思考级别` }
  }
  if (level === 'max') {
    // OpenAI 没有 max,最高是 xhigh。原样发出去是 400。
    return { value: 'xhigh', note: `思考级别 max:OpenAI 系协议没有这一档,已按 xhigh 发送` }
  }
  return { value: level }
}
