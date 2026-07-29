import { logError } from '../../../utils/log.js'
import { anthropicEventsToSSE, createBlockWriter, type Evt } from './blocks.js'

/** 上游的 finish_reason → anthropic 的 stop_reason。**chat 独有** —— responses 没有这个字段。 */
const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' }

// 两个协议的翻译层共用同一个 SSE 序列化。从这里再导出一次,免得调用方要记住它搬去了哪。
export { anthropicEventsToSSE }
export type { Evt }

/**
 * OpenAI 兼容后端把「思考」放在哪个字段上。
 *
 * OpenAI 自家的 `chat/completions` **不暴露**推理正文(只给 `usage.reasoning_tokens`),
 * 所以这份名单全是兼容后端的方言:
 *  - `reasoning_content`:DeepSeek / Moonshot(Kimi)/ 智谱 GLM / 通义 Qwen / MiniMax /
 *    vLLM(`--reasoning-parser`)/ SGLang —— 也就是绝大多数
 *  - `reasoning` 与 `reasoning_details`:OpenRouter 及若干网关
 *  - `thinking`:少数直接照搬 anthropic 字段名的代理
 *
 * **新后端进来就往这个数组里加一个名字**,不要写成 if-else 链。顺序有意义:
 * 取**第一个非空**的,不是把所有字段拼起来 —— OpenRouter 会在同一条 delta 里同时给
 * `reasoning`(纯文本)和 `reasoning_details`(同样内容的结构化版),拼起来就是重影。
 */
export const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details', 'thinking'] as const

/**
 * 从一个可能是字符串 / 对象 / 数组的推理字段里抠出正文。**永不抛。**
 *
 * 只认这几个**正文**键名。`reasoning_details` 里还有一种
 * `{type:'reasoning.encrypted', data:'<base64>'}` —— 那是服务端加密的思考,`data` 是
 * 一大段 base64,打到终端上既没有信息又会把工具调用淹掉。所以这里是**白名单**,
 * 不是「随便找个字符串属性」。
 */
function pickReasoningText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    let out = ''
    for (const item of v) out += pickReasoningText(item)
    return out
  }
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const k of ['text', 'content', 'summary', 'thinking', 'reasoning']) {
      const s = rec[k]
      if (typeof s === 'string' && s.length > 0) return s
    }
  }
  return ''
}

/** 一条 delta 里的思考正文;没有就是空串。**永不抛** —— 它跑在流式热路径上。 */
export function reasoningTextOf(delta: unknown): string {
  if (delta === null || typeof delta !== 'object') return ''
  const rec = delta as Record<string, unknown>
  for (const f of REASONING_FIELDS) {
    const text = pickReasoningText(rec[f])
    if (text.length > 0) return text
  }
  return ''
}

/** 一次工具调用攒到的东西。id / name 可能比第一条 arguments 晚到。 */
interface ToolAcc { id?: string; name?: string; args: string }

export async function* openaiChunksToAnthropicEvents(chunks: AsyncIterable<any>, ctx: { anthropicModel: string }): AsyncGenerator<Evt> {
  // 块的开合记账归 blocks.ts —— 它维护的两条不变量(同一时刻只开一个块、stop 必须配得上
  // 一个先发出去的 start)在两个协议上逐字相同,而破了它 claude.ts 直接抛 RangeError。
  const w = createBlockWriter(ctx)
  /**
   * 工具调用**攒到流末尾再发**,不是边收边发。
   *
   * 边收边发有三个实测故障,而且它们互相独立:
   *
   *  1. **provider 不发 `tc.index`**(规范里有,但不是每家都发 —— 不发的那些每条 delta
   *     携带一个完整的 tool_call)。原来的 `toolBlocks.get(tc.index)` 于是永远命中
   *     `get(undefined)`,两个并行调用被并成**一块**:实测 `{"file_path":"a.ts"}{"command":"ls"}`
   *     → `normalizeContentFromAPI` 的 `safeParseJSON(...) ?? {}` 解析失败 → **Read 拿着空参数
   *     被调用,而 Bash 这次调用整个消失**。用户看到的就是「子 agent 好像没在调工具/MCP」。
   *  2. **`id` / `name` 晚到**:`content_block_start` 在第一条 delta 就发出去了,而 anthropic
   *     协议里 name/id 一旦发出就不能改 —— 实测拿到 `name=undefined`(工具查不到)和
   *     `id=undefined`(下一轮 `tool_call_id: undefined` → 400)。
   *  3. **顺序**:「文本 → 工具 → 文本」时,工具块的 `content_block_stop` 排在后半段文本
   *     之后,而 claude.ts 是**按 stop 产消息**的 —— 窗口里工具行会出现在两段文本之后。
   *
   * 代价:tool_use 不再增量流式。而这**零损失** —— `claude.ts` 本来就只在
   * `content_block_stop` 才产出一条 AssistantMessage(见 case 'content_block_stop'),
   * 增量的 `input_json_delta` 从来没有单独上过屏。
   */
  const toolAcc = new Map<string, ToolAcc>()
  // 匿名调用(没有 index)的键空间和带 index 的**分开**,否则 `i0` 和第一个匿名调用会撞。
  let anonSeq = 0
  let lastAnonKey: string | null = null
  /** 见过的 tool_call id → 它的键。用来认出「同一个 id 又来了」这一种方言。 */
  const byId = new Map<string, string>()
  let stopReason = 'end_turn'
  let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } = { input_tokens: 0, output_tokens: 0 }
  for await (const c of chunks) {
    if (c.error) {
      logError(new Error(`OpenAI-compat upstream error: ${c.error?.message ?? JSON.stringify(c.error)}`))
      // Emit message_start first even when the error is the very first chunk —
      // callers expect a message_start to always precede any other event.
      yield* w.error(c.error?.message ?? 'upstream error', c.id)
      return
    }
    if (c.usage) {
      /**
       * 命中缓存的那一段要**单列出来**。
       *
       * OpenAI 的 `prompt_tokens` / `input_tokens` 本身**已经包含**缓存部分,所以不减掉的话
       * 总量没错、但详情页那句「缓存 读 X」对 openai 系员工恒为 0 —— 而 README 明写着
       * 「缓存读写单列」。一个高度复用上下文的运行,便宜的那一大截会被算成全价输入。
       *
       * 减完可能为负(网关自己报的两个数不自洽),夹到 0。
       */
      const cached = Math.max(0, c.usage.prompt_tokens_details?.cached_tokens ?? 0)
      usage = {
        input_tokens: Math.max(0, (c.usage.prompt_tokens ?? 0) - cached),
        output_tokens: c.usage.completion_tokens ?? 0,
        cache_read_input_tokens: cached,
      }
    }
    const choice = c.choices?.[0]; if (!choice && !c.usage) continue
    const delta = choice?.delta ?? {}
    // 显式带上 chunk 的 id —— message_start 的 id 取的是**第一条 chunk** 的 id,
    // 交给 w.thinking()/w.text() 内部那次兜底调用的话就成了合成 id。
    yield* w.startIfNeeded(c.id)
    /**
     * 思考排在正文**之前**判。
     *
     * 在这之前这两个字段一个都没读:整段思考在协议转换层就没了,后面 agentEvents 认得
     * `thinking` 块也没用 —— 用户报的「openai 员工没有思考、没有过程」就是这一句。
     * 下游接得住:claude.ts 的 content_block_start 有 'thinking' 分支,并且**主动**把
     * signature 初始化成空串(注释原话:ensure field exists even if signature_delta never
     * arrives),所以这里**不需要伪造 signature_delta**。
     */
    yield* w.thinking(reasoningTextOf(delta))
    if (typeof delta.content === 'string') yield* w.text(delta.content)
    for (const tc of delta.tool_calls ?? []) {
      let key: string
      if (typeof tc.index === 'number') {
        key = `i${tc.index}`
      } else if (typeof tc.id === 'string' && tc.id.length > 0 && byId.has(tc.id)) {
        /**
         * **同一个 id 又来了 = 同一次调用的续块,不是新调用。**
         *
         * 「不发 index」至少有两种方言,我第一版只认了一种:
         *  - 一种每次给一个**新**调用(id 各不相同)—— 那就是下面那一支;
         *  - 另一种把**同一个 id 重复带在每一条续块**上,arguments 分片跟在后面。
         * 第二种被拆成 N 个块之后,每块的 arguments 都是残片(`{"file_`、`path":"` …),
         * 各自 JSON 解析失败 → `?? {}` → 工具拿空参数;而且 N 个 tool_use 共用同一个 id,
         * 下一轮的 tool_call_id 会撞,严格后端直接 400。
         *
         * 这一档在改造**之前是好的**(旧代码 `get(undefined)` 恰好把它们并成了一条),
         * 是这次改动引入的退化 —— 验收用真探针抓出来的。
         */
        key = byId.get(tc.id)!
        lastAnonKey = key
      } else if (tc.id != null || tc.function?.name != null) {
        // 带身份、而且这个 id 没见过 = 一次**新的**调用。
        key = `a${anonSeq++}`
        lastAnonKey = key
        if (typeof tc.id === 'string' && tc.id.length > 0) byId.set(tc.id, key)
      } else {
        // 只有 arguments 的续块,归上一次匿名调用;一次都还没开过就自己开一个。
        key = lastAnonKey ?? (lastAnonKey = `a${anonSeq++}`)
      }
      let acc = toolAcc.get(key)
      if (!acc) { acc = { args: '' }; toolAcc.set(key, acc) }
      // `??=` 而不是覆盖:晚到的 id/name 要接住,先到的不许被后面的空值冲掉。
      if (acc.id === undefined && typeof tc.id === 'string' && tc.id.length > 0) acc.id = tc.id
      if (acc.name === undefined && typeof tc.function?.name === 'string' && tc.function.name.length > 0) acc.name = tc.function.name
      if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments
    }
    if (choice?.finish_reason) stopReason = STOP[choice.finish_reason] ?? 'end_turn'
  }
  for (const acc of toolAcc.values()) yield* w.toolUse(acc)
  yield* w.finish(stopReason, usage)
}
