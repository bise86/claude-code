/** anthropic 流式协议里的一条事件。 */
export type Evt = { event: string; data: any }

export interface BlockUsage { input_tokens: number; output_tokens: number }

/**
 * anthropic **内容块的开合记账**。
 *
 * 这是两个协议翻译层里唯一值得共用的**语义**片段。它维护的不变量只有两条 ——
 * 同一时刻只能开着一个内容块;`content_block_stop` 必须配得上一个先发出去的
 * `content_block_start` —— 而破了它的后果不是排版难看,是 `claude.ts` 在
 * `content_block_stop` 那一支直接 `throw new RangeError('Content block not found')`,
 * 整条流炸掉、这次调用的产出全丢。
 *
 * chat/completions 和 responses 两边的这两条不变量**逐字相同**,所以抽出来是纯机械的:
 * 抽出来的这个文件里一个 `if (protocol === …)` 都没有。
 *
 * 真正不该共用的东西留在各自的翻译层里(厂商方言的思考字段嗅探、工具调用累加、
 * finish_reason 映射表、错误形状)—— 那几样两边差得远,硬抽只会把差异挤成一堆 if。
 */
export function createBlockWriter(ctx: { anthropicModel: string }) {
  let started = false
  let nextIndex = 0
  let textOpen = false
  let textIndex = -1
  let thinkOpen = false
  let thinkIndex = -1

  function* startIfNeeded(id?: string): Generator<Evt> {
    if (started) return
    started = true
    yield { event: 'message_start', data: { type: 'message_start', message: {
      id: id ?? 'msg_openai', type: 'message', role: 'assistant', model: ctx.anthropicModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }
  }

  function* closeText(): Generator<Evt> {
    if (!textOpen) return
    textOpen = false
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }
  }

  function* closeThinking(): Generator<Evt> {
    if (!thinkOpen) return
    thinkOpen = false
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: thinkIndex } }
  }

  return {
    startIfNeeded,
    closeText,
    closeThinking,

    /** 思考正文。开着文本块就先关掉 —— 同一时刻只能有一个块。 */
    *thinking(text: string): Generator<Evt> {
      if (text.length === 0) return
      yield* startIfNeeded()
      yield* closeText()
      if (!thinkOpen) {
        thinkOpen = true; thinkIndex = nextIndex++
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } } }
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: thinkIndex, delta: { type: 'thinking_delta', thinking: text } } }
    },

    /**
     * 给当前思考块盖一个签名。
     *
     * responses 协议靠它把服务端加密的推理片段原样带回下一轮(下一轮不带就 400)。
     * `claude.ts` 主动把 thinking 块的 signature 初始化成空串、从 `signature_delta` 写它、
     * 再把整个 thinking 块**原样**发回下一轮 —— 通道是现成的,这里只是用它。
     *
     * 没有开着的思考块就静默丢弃:签名没有归属时发出去会撞上一个不存在的 index。
     */
    *signature(sig: string): Generator<Evt> {
      if (sig.length === 0) return
      yield* startIfNeeded()
      // 没有开着的思考块就**开一个空的**,而不是把签名丢掉。
      //
      // responses 的推理摘要是 opt-in 的,而且模型可以一个字都不给;此时仍然会有一个
      // reasoning item 带着密文。丢掉它的后果不是少一段思考,是**下一轮 400**
      // (`function_call was provided without its required reasoning item`)——
      // 也就是这个员工一旦调工具就再也接不下去。
      if (!thinkOpen) {
        yield* closeText()
        thinkOpen = true; thinkIndex = nextIndex++
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } } }
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: thinkIndex, delta: { type: 'signature_delta', signature: sig } } }
    },

    /** 模型正文。开着思考块就先关掉。 */
    *text(t: string): Generator<Evt> {
      if (t.length === 0) return
      yield* startIfNeeded()
      yield* closeThinking()
      if (!textOpen) {
        textOpen = true; textIndex = nextIndex++
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } }
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: t } } }
    },

    /**
     * 一次完整的工具调用 —— start + delta + stop 三件套一起发。
     *
     * 缺 id 就合成一个,缺 name 就发空串,**不丢块**:丢块的话模型这次调用的意图凭空消失,
     * 而用户只会看到「它什么都没干」;发出去的话 agentEvents 把空名渲染成「未知工具」、
     * 工具循环回一条 tool_result 报错 —— 一个看得见、查得到的失败,永远好过一个安静的空白。
     */
    *toolUse(call: { id?: string; name?: string; args: string }): Generator<Evt> {
      yield* startIfNeeded()
      yield* closeThinking()
      yield* closeText()
      const index = nextIndex++
      yield { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id ?? `call_${index}`, name: call.name ?? '', input: {} } } }
      if (call.args.length > 0) {
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } } }
      }
      yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } }
    },

    /** 收口:把还开着的块关掉,再发 message_delta / message_stop。 */
    *finish(stopReason: string, usage: BlockUsage): Generator<Evt> {
      yield* startIfNeeded()
      yield* closeThinking()
      yield* closeText()
      yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage } }
      yield { event: 'message_stop', data: { type: 'message_stop' } }
    },

    /** 上游报错:message_start 必须先于任何别的事件,哪怕错误是第一帧。 */
    *error(message: string, id?: string): Generator<Evt> {
      yield* startIfNeeded(id)
      yield { event: 'error', data: { type: 'error', error: { type: 'api_error', message } } }
    },
  }
}

export function anthropicEventsToSSE(events: AsyncIterable<Evt>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({ async start(ctrl) {
    for await (const e of events) ctrl.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
    ctrl.close()
  } })
}
