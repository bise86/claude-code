const DROP = new Set(['betas','anthropic_beta','output_config','context_management','metadata','thinking','container','anthropic_version'])
function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('')
  return ''
}
export function toOpenAIRequest(body: any, backendModel: string, thinkingDepth?: string): any {
  const messages: any[] = []
  if (body.system) messages.push({ role: 'system', content: textOf(body.system) })
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use')
    const toolResults = blocks.filter((b: any) => b.type === 'tool_result')
    if (m.role === 'assistant' && toolUses.length) {
      messages.push({ role: 'assistant', content: textOf(blocks) || null,
        tool_calls: toolUses.map((t: any) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) })
    } else if (toolResults.length) {
      for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: textOf(tr.content) })
    } else {
      messages.push({ role: m.role, content: textOf(blocks) })
    }
  }
  const out: any = { model: backendModel, messages, stream: body.stream, stream_options: { include_usage: true } }
  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.tools) out.tools = body.tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  if (body.tool_choice) out.tool_choice = body.tool_choice.type === 'auto' ? 'auto' : body.tool_choice.type === 'any' ? 'required' : { type: 'function', function: { name: body.tool_choice.name } }
  if (thinkingDepth) out.reasoning_effort = thinkingDepth
  for (const k of Object.keys(out)) if (DROP.has(k)) delete out[k]
  return out
}
