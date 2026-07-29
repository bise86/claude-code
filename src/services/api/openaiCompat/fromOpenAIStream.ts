import { logError } from '../../../utils/log.js'
const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' }
type Evt = { event: string; data: any }

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
  let started = false, textOpen = false, textIndex = -1, nextIndex = 0
  // 思考块。和 text 完全对称:同一时刻只能开着一个内容块,谁来了就先把对方关掉。
  let thinkOpen = false, thinkIndex = -1
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
  let stopReason = 'end_turn'
  let usage = { input_tokens: 0, output_tokens: 0 }
  const startIfNeeded = function* (id?: string): Generator<Evt> {
    if (started) return
    started = true
    yield { event: 'message_start', data: { type: 'message_start', message: {
      id: id ?? 'msg_openai', type: 'message', role: 'assistant', model: ctx.anthropicModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }
  }
  const closeText = function* (): Generator<Evt> {
    if (!textOpen) return
    textOpen = false
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }
  }
  const closeThinking = function* (): Generator<Evt> {
    if (!thinkOpen) return
    thinkOpen = false
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: thinkIndex } }
  }
  for await (const c of chunks) {
    if (c.error) {
      logError(new Error(`OpenAI-compat upstream error: ${c.error?.message ?? JSON.stringify(c.error)}`))
      // Emit message_start first even when the error is the very first chunk —
      // callers expect a message_start to always precede any other event.
      yield* startIfNeeded(c.id)
      yield { event: 'error', data: { type: 'error', error: { type: 'api_error', message: c.error?.message ?? 'upstream error' } } }
      return
    }
    if (c.usage) usage = { input_tokens: c.usage.prompt_tokens ?? 0, output_tokens: c.usage.completion_tokens ?? 0 }
    const choice = c.choices?.[0]; if (!choice && !c.usage) continue
    const delta = choice?.delta ?? {}
    yield* startIfNeeded(c.id)
    /**
     * 思考排在正文**之前**判。
     *
     * 在这之前这两个字段一个都没读:整段思考在协议转换层就没了,后面 agentEvents 认得
     * `thinking` 块也没用 —— 用户报的「openai 员工没有思考、没有过程」就是这一句。
     * 下游接得住:claude.ts 的 content_block_start 有 'thinking' 分支,并且**主动**把
     * signature 初始化成空串(注释原话:ensure field exists even if signature_delta never
     * arrives),所以这里**不需要伪造 signature_delta**。
     */
    const reasoning = reasoningTextOf(delta)
    if (reasoning.length > 0) {
      yield* closeText()
      if (!thinkOpen) {
        thinkOpen = true; thinkIndex = nextIndex++
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } } }
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: thinkIndex, delta: { type: 'thinking_delta', thinking: reasoning } } }
    }
    if (typeof delta.content === 'string' && delta.content.length) {
      yield* closeThinking()
      if (!textOpen) { textOpen = true; textIndex = nextIndex++; yield { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } } }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } } }
    }
    for (const tc of delta.tool_calls ?? []) {
      let key: string
      if (typeof tc.index === 'number') {
        key = `i${tc.index}`
      } else if (tc.id != null || tc.function?.name != null) {
        // 带身份 = 一次**新的**调用。
        key = `a${anonSeq++}`
        lastAnonKey = key
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
  yield* startIfNeeded()
  yield* closeThinking()
  yield* closeText()
  for (const acc of toolAcc.values()) {
    const index = nextIndex++
    /**
     * 缺 id 就合成一个,缺 name 就发空串 —— **不丢块**。
     *
     * 丢块的话模型这次调用的意图凭空消失,而用户只会看到「它什么都没干」;发出去的话
     * agentEvents 把空名渲染成「未知工具」、工具循环回一条 tool_result 报错 ——
     * 一个看得见、查得到的失败,永远好过一个安静的空白。
     */
    yield { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: acc.id ?? `call_${index}`, name: acc.name ?? '', input: {} } } }
    if (acc.args.length > 0) yield { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: acc.args } } }
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } }
  }
  yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } }
  yield { event: 'message_stop', data: { type: 'message_stop' } }
}
export function anthropicEventsToSSE(events: AsyncIterable<Evt>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({ async start(ctrl) {
    for await (const e of events) ctrl.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
    ctrl.close()
  }})
}
