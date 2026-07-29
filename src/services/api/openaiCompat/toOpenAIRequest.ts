function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('')
  return ''
}
export function toOpenAIRequest(body: any, backendModel: string, thinkingDepth?: string): any {
  const messages: any[] = []
  const systemText = textOf(body.system)
  if (systemText) messages.push({ role: 'system', content: systemText })
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use')
    const toolResults = blocks.filter((b: any) => b.type === 'tool_result')
    if (m.role === 'assistant' && toolUses.length) {
      messages.push({ role: 'assistant', content: textOf(blocks) || null,
        tool_calls: toolUses.map((t: any) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) })
    } else if (toolResults.length) {
      // Known lossy conversion: textOf() drops non-text blocks (e.g. images) inside
      // tool_result content — there is no faithful OpenAI role:'tool' mapping for
      // images today, so any image content in a tool_result is silently discarded.
      for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: textOf(tr.content) })
      // A user message can carry a tool_result alongside sibling content (e.g. a
      // trailing text block). Emit the tool messages first (matches production
      // order: tool results then follow-up text), then surface any sibling text
      // in its own message so it isn't silently dropped.
      const nonToolResultBlocks = blocks.filter((b: any) => b.type !== 'tool_result')
      const siblingText = textOf(nonToolResultBlocks)
      if (siblingText) messages.push({ role: m.role, content: siblingText })
    } else {
      const text = textOf(blocks)
      /**
       * 只剩空内容的 **assistant** 轮次直接丢掉。
       *
       * 这条是 `fromOpenAIStream` 认思考之后**新出现**的形状:在那之前,一个「只有推理、
       * 没有正文」的轮次(推理中撞 max_tokens,或后端吐完 reasoning_content 就 finish)
       * 根本不产生 assistant 消息;现在它是一条只含 thinking 块的消息,而 textOf 只留
       * `type==='text'` —— 实测出网变成 `{"role":"assistant","content":""}`,一部分兼容
       * 后端(DeepSeek 尤甚)对空 assistant 直接 400。
       *
       * **只挡 assistant。** user 的空消息是既有行为,不在这次改动的范围里,顺手改会
       * 改掉一条没人验证过的语义。
       */
      if (m.role === 'assistant' && text.length === 0) continue
      messages.push({ role: m.role, content: text })
    }
  }
  // `out` is an explicit whitelist of OpenAI-compatible fields — anthropic-only
  // fields (betas, anthropic_beta, output_config, context_management, metadata,
  // thinking, container, anthropic_version, ...) are simply never copied in, so
  // there is nothing to drop after the fact.
  const out: any = { model: backendModel, messages,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}) }
  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.tools) {
    /**
     * 只转**有 input_schema 的**工具。
     *
     * anthropic 的服务端工具(web_search / advisor 一类)没有 `input_schema` —— claude.ts
     * 会把它们拼进同一个 tools 数组。原样映射过去得到的是一个**没有 parameters 的函数**:
     * 严格后端 400,宽松后端更糟 —— 它会让模型去调一个这条桥根本执行不了的工具,
     * 而模型不知道,只会一遍遍重试。
     *
     * 全被滤光时**不发 `tools` 字段**,而不是发一个空数组:部分后端对 `tools: []` 报错。
     */
    const fns = body.tools
      .filter((t: any) => t && typeof t.name === 'string' && t.name.length > 0 && t.input_schema)
      .map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
    if (fns.length > 0) out.tools = fns
  }
  if (body.tool_choice) out.tool_choice = body.tool_choice.type === 'auto' ? 'auto' : body.tool_choice.type === 'any' ? 'required'
    // 'none' 漏了会掉进最后那一支,拼出 `{type:'function',function:{name:undefined}}` —— 一个
    // 语义完全相反的请求(本意是「这轮别调工具」,发出去成了「必须调某个没名字的工具」)。
    : body.tool_choice.type === 'none' ? 'none'
    : { type: 'function', function: { name: body.tool_choice.name } }
  if (thinkingDepth) out.reasoning_effort = thinkingDepth
  return out
}
