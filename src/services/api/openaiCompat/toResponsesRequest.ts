/**
 * anthropic 请求体 → OpenAI **Responses** 请求体(`POST {apiUrl}/responses`)。
 *
 * 和 `toOpenAIRequest`(chat/completions)是**两份**,不是一份带 if 的。两边的输入模型
 * 差得远:chat 是 `messages[]` + 顶层 `system` + 嵌套的 `{type:'function',function:{…}}`;
 * responses 是 `input[]` 里混排 message / function_call / function_call_output / reasoning
 * 四种 item,工具是**扁平**的,system 走 `instructions`。硬合成一份只会把差异挤成一堆 if。
 */

/**
 * 推理片段带回下一轮时用的签名前缀。
 *
 * 为什么要有这个东西:Responses 在**带工具调用**的轮次里要求把上一轮的 reasoning item
 * 一起回传,否则直接 400(`Item of type 'function_call' was provided without its required
 * 'reasoning' item`)。而这条桥是**无状态**的 —— 每一轮都从 anthropic 的 messages 重建整个
 * input,历史归 claude.ts 管,用不了 `previous_response_id`。
 *
 * 所以密文得搭 anthropic 的顺风车回来。现成的槽是 thinking 块的 `signature`:
 * claude.ts 主动把它初始化成空串、从 `signature_delta` 写它、又把整个 thinking 块**原样**
 * 发回下一轮(只对 cache_control 做特判)。加前缀是为了永远不会把 anthropic 自己的签名
 * 误认成我们编的这个。
 */
export const REASONING_SIG_PREFIX = 'openai-responses-reasoning:'

export function encodeReasoningSignature(id: string, encrypted: string): string {
  return `${REASONING_SIG_PREFIX}${JSON.stringify({ id, enc: encrypted })}`
}

/** 从 thinking 块的签名里取回推理片段;不是我们编的就返回 undefined。**永不抛。** */
export function decodeReasoningSignature(sig: unknown): { id?: string; enc?: string } | undefined {
  if (typeof sig !== 'string' || !sig.startsWith(REASONING_SIG_PREFIX)) return undefined
  try {
    const v = JSON.parse(sig.slice(REASONING_SIG_PREFIX.length)) as { id?: unknown; enc?: unknown }
    const id = typeof v.id === 'string' ? v.id : undefined
    const enc = typeof v.enc === 'string' ? v.enc : undefined
    return id === undefined && enc === undefined ? undefined : { id, enc }
  } catch {
    // 手工改过的会话记录、或者上游换了编码 —— 丢掉这一条比让整个请求构造抛要好。
    return undefined
  }
}

function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text').map(b => b.text).join('')
  return ''
}

export interface ResponsesOptions {
  backendModel: string
  /**
   * 上下文超出模型窗口时,让**上游**从对话开头丢条目,而不是回 400。
   *
   * 只有 `transport: 'sdk'` 的员工会打开它 —— 那一档的约定是「这一席的上下文归上游管」,
   * 我们这边不再压缩(见 roleContextCeiling 的 upstreamManagesContext)。两件事必须**同时**
   * 成立:只关掉我们的压缩而不开这个,那一席撞满就是硬 400;只开这个而不关压缩,则是
   * 两套上下文管理同时在动,谁先开火取决于阈值算得准不准。
   *
   * 语义要记清楚:它**丢原文,不摘要**,而且按**模型自己的**窗口判定 —— 用户写的
   * `contextWindow` / `autoCompactTokenLimit` 它不看(那两个键在这一档因此不生效,
   * 载入时会记一条诊断)。
   */
  truncation?: boolean
  /** 已经按协议归一过的思考档位。原样填进 `reasoning.effort`。 */
  effort?: string
}

export function toResponsesRequest(body: any, opts: ResponsesOptions): any {
  const input: any[] = []
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const toolUses = blocks.filter((b: any) => b?.type === 'tool_use')
    const toolResults = blocks.filter((b: any) => b?.type === 'tool_result')
    if (m.role === 'assistant') {
      /**
       * reasoning item 必须排在同一轮的 function_call **之前**,而且只在这一轮真的有
       * 工具调用时才需要。没有工具调用的轮次带上它没坏处,但会白白多发一大段密文。
       */
      if (toolUses.length > 0) {
        for (const b of blocks) {
          if (b?.type !== 'thinking') continue
          const r = decodeReasoningSignature(b.signature)
          if (!r?.enc) continue
          input.push({ type: 'reasoning', ...(r.id ? { id: r.id } : {}), encrypted_content: r.enc, summary: [] })
        }
      }
      const text = textOf(blocks)
      /**
       * assistant 轮次用 `EasyInputMessage`(role + 纯字符串),**不是**
       * `{type:'message', content:[{type:'output_text'…}]}`。
       *
       * 后者匹配的是 `ResponseOutputMessage`,它必填 `id` 和 `status`,里面的
       * `ResponseOutputText` 还必填 `annotations` —— 这三个我们一个都没有,发出去是
       * 一个校验不过的形状。而 `ResponseInputItem.Message` 的 role 只收
       * user/system/developer,压根没有 assistant 这一档。
       *
       * 空文本直接跳过:一个「只有推理、没有正文」的轮次(推理中撞上限,或者吐完
       * 推理就 finish)在这里会变成 `content: ''`,而部分后端对空 assistant 直接 400。
       * 这条和 chat 那侧的同名守卫是同一个实测教训。
       */
      if (text.length > 0) input.push({ role: 'assistant', content: text })
      for (const t of toolUses) {
        // `call_id`,不是 item 的 `id` —— 两者是不同的命名空间(`call_…` vs `fc_…`),
        // 而下一轮的 function_call_output 必须按 call_id 配对。
        input.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) })
      }
      continue
    }
    if (toolResults.length > 0) {
      // Known lossy conversion: textOf() 丢掉 tool_result 里的非文本块(比如图片)——
      // Responses 的 function_call_output 只收字符串,和 chat 那侧同一个已知损失。
      for (const tr of toolResults) input.push({ type: 'function_call_output', call_id: tr.tool_use_id, output: textOf(tr.content) })
      // 工具结果之后可能还跟着同一条消息里的正文(生产上的顺序就是「先结果、后追问」)。
      const sibling = textOf(blocks.filter((b: any) => b?.type !== 'tool_result'))
      if (sibling.length > 0) input.push({ role: m.role, content: sibling })
      continue
    }
    const text = textOf(blocks)
    input.push({ role: m.role, content: text })
  }

  const out: any = {
    model: opts.backendModel,
    input,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    /**
     * `store: false` + `include`,**必须一起上**。
     *
     * store 默认 true,对话会留在 OpenAI 侧;员工是用户自带 token 的第三方后端,默认不留
     * 更保守。但一旦关掉服务端存储,跨轮的推理片段就只能靠密文自己带回来 —— 所以
     * `include: ['reasoning.encrypted_content']` 不是可选项,少了它下一轮带工具调用就 400。
     */
    store: false,
    include: ['reasoning.encrypted_content'],
  }
  if (opts.truncation === true) out.truncation = 'auto'
  const systemText = textOf(body.system)
  if (systemText.length > 0) out.instructions = systemText
  // anthropic 的 max_tokens 在这个协议里叫 max_output_tokens。
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (opts.effort) {
    // summary:'auto' 是**思考过程能不能上屏**的开关。不要它的话用户又回到「openai 员工
    // 没有思考、没有过程」——那正是这条桥要解决的问题。
    out.reasoning = { effort: opts.effort, summary: 'auto' }
  }
  if (body.tools) {
    /**
     * 工具是**扁平**的:`{type:'function', name, description, parameters}`,
     * 不是 chat 那种 `{type:'function', function:{…}}` 嵌套。抄错这一层的话上游 400。
     *
     * `strict` 默认是 **true**,而 anthropic 的 input_schema 满足不了严格模式
     * (要求 additionalProperties:false 且所有键必填),所以必须显式关掉。
     *
     * 只转有 input_schema 的:anthropic 的服务端工具(web_search 一类)没有 schema,
     * 原样映射过去得到一个没有 parameters 的函数 —— 严格后端 400,宽松后端更糟:
     * 它会让模型去调一个这条桥根本执行不了的工具,而模型不知道,只会一遍遍重试。
     * 全被滤光时**不发 tools 字段**,而不是发一个空数组。
     */
    const fns = body.tools
      .filter((t: any) => t && typeof t.name === 'string' && t.name.length > 0 && t.input_schema)
      .map((t: any) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }))
    if (fns.length > 0) out.tools = fns
  }
  if (body.tool_choice) {
    out.tool_choice = body.tool_choice.type === 'auto' ? 'auto'
      : body.tool_choice.type === 'any' ? 'required'
      : body.tool_choice.type === 'none' ? 'none'
      // 这里也是扁平的 —— `{type:'function', name}`,没有嵌套的 function 对象。
      : { type: 'function', name: body.tool_choice.name }
  }
  return out
}
