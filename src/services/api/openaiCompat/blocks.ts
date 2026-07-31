import { estimateTokens, markEstimatedUsage } from '../tokenEstimate.js'
/** anthropic 流式协议里的一条事件。 */
export type Evt = { event: string; data: any }

export interface BlockUsage {
  input_tokens: number
  output_tokens: number
  /** 命中缓存的输入。**不含在 input_tokens 里** —— 见两个翻译层的 readUsage。 */
  cache_read_input_tokens?: number
}

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
/**
 * 上游没给 id 时的兜底消息 id 计数器。
 *
 * **不能是一个常量。** 原来写死 `'msg_openai'`,于是同一个进程里所有匿名回合共用一个
 * 消息 id —— 而消息 id 是「这是第几次模型调用」的唯一凭据:任何按 id 去重的统计
 * (节点用量、遥测、会话记录)都会把一个节点里的几十次调用记成一次。
 *
 * 计数器而不是随机数:同一次运行里唯一就够用了,而确定性让测试能直接断言。
 */
let anonMessageSeq = 0

export function createBlockWriter(ctx: { anthropicModel: string }) {
  let started = false
  /**
   * 这一轮**产出**了多少 token(估算值)。
   *
   * 存在的理由是上游可能一个 usage 都不给:`stream_options.include_usage` 是我们发的,
   * 认不认在对面(实测有网关直接忽略)。那种情况下整趟运行的 token 数会全是 0 ——
   * 而 0 是一句假话,那些 token 真的花掉了。这个计数器是兜底估算的输出侧。
   *
   * **逐块累加**,不是最后统一算:文本是流式到达的,攒一份完整副本只为了估算它的长度,
   * 等于给每一次调用多留一份全文在内存里。代价是每块各 `Math.ceil` 一次,估算会略偏高 ——
   * 而这个数本来就带着 `≈` 显示。
   */
  let estOutput = 0
  let nextIndex = 0
  let textOpen = false
  let textIndex = -1
  let thinkOpen = false
  let thinkIndex = -1

  function* startIfNeeded(id?: string): Generator<Evt> {
    if (started) return
    started = true
    yield { event: 'message_start', data: { type: 'message_start', message: {
      id: id ?? `msg_openai_${++anonMessageSeq}`, type: 'message', role: 'assistant', model: ctx.anthropicModel,
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
    /** 到此为止**产出**了多少 token(估算)。上游不给 usage 时的兜底,见 estOutput。 */
    estimatedOutputTokens: (): number => estOutput,
    startIfNeeded,
    closeText,
    closeThinking,

    /** 思考正文。开着文本块就先关掉 —— 同一时刻只能有一个块。 */
    *thinking(text: string): Generator<Evt> {
      if (text.length === 0) return
      // 思考也是产出,也要计费。漏掉它,一个「想很久说很少」的推理模型会被估成几乎不花钱。
      estOutput += estimateTokens(text)
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
      estOutput += estimateTokens(t)
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
      // 工具调用的参数同样是模型产出的 token,而执行环节里它常常是最大的一块。
      estOutput += estimateTokens(call.name ?? '') + estimateTokens(call.args)
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

/**
 * 上游**一个用量都没给**时的兜底:用估算值顶上,并且把「这是估的」记下来。
 *
 * ## 判据是「两个数都为 0」,不是「有没有 usage 帧」
 *
 * 有的网关会发一个 usage 帧但字段全 0(转发时丢了),也有的压根不发。两种在结果上是
 * 同一件事:我们手上没有真实用量。而 `input===0 && output===0` 在一次真实调用里不可能
 * 发生 —— 请求体至少有系统提示词,回复至少有一个字。
 *
 * ## 为什么宁可估也不留 0
 *
 * 0 会让 `/et` 的用量整段消失(空用量不渲染),用户看到的是「统计没了」。而那些 token
 * 是真花掉的。一个标着 `≈` 的粗略数字回答得了他真正的问题(这一趟量级多大),
 * 一个 0 回答不了,还是假话。
 *
 * 估算标记走 `markEstimatedUsage(requestId)` 这条侧路,理由见 tokenEstimate:塞进 usage
 * 里的自定义字段会被 claude.ts 的白名单静默丢掉,于是「估算」会变成「实测」。
 */
export function fallbackUsage(
  upstream: BlockUsage,
  writer: { estimatedOutputTokens: () => number },
  ctx: { requestId?: string; estimatedInput?: () => number },
): BlockUsage {
  /**
   * **逐字段兜底,不是「两个都为 0 才兜」。**
   *
   * 第一版的判据是 `input > 0 || output > 0` 就原样采信。评审和验收各自独立实测出同一条:
   * 网关**只报一半**的时候(`{prompt_tokens: 5000, completion_tokens: 0}` —— 转发时丢了
   * 一半、或者只在最后一帧带输入侧),那条路整个不触发:产出记 0,而且**不打 `≈`**。
   * 于是屏幕上是一个「一半真、一半假」的数,还带着实测的身份 —— 比全 0 更难被发现。
   *
   * 现在两侧各判各的:上游给了正数就用它,给 0 就用估算并把这次调用标成估算。
   * 只要有**一侧**是估的,`≈` 就要出现 —— 那个记号说的是「这行数字里有估算成分」。
   */
  const upIn = upstream.input_tokens ?? 0
  const upOut = upstream.output_tokens ?? 0
  /**
   * 输入侧算不算「上游报过」,**要带上缓存那一格**。
   *
   * 两个翻译层的口径是 `input_tokens = prompt_tokens - cached_tokens`,所以一次
   * **输入全部命中缓存**的调用会以 `{input_tokens: 0, cache_read_input_tokens: 5000}`
   * 的形状到这里 —— 和「上游什么都没报」长得一模一样。只看 `input_tokens` 的后果
   * (复验实测):那 5000 的真实缓存读被抹成 0、输入被换成估算值,而这次调用的用量
   * **本来是完全真实的**,却盖上了一个 `≈`。而高度复用上下文的运行里,这一档很常见。
   */
  const hasUpIn = upIn > 0 || (upstream.cache_read_input_tokens ?? 0) > 0
  if (hasUpIn && upOut > 0) return upstream
  const estOut = upOut > 0 ? 0 : writer.estimatedOutputTokens()
  const estIn = hasUpIn ? 0 : (ctx.estimatedInput?.() ?? 0)
  // 估不出来的那一侧保持 0 —— 那时候 0 才是实话(空请求 / 空回复)。
  if (estOut === 0 && estIn === 0) return upstream
  markEstimatedUsage(ctx.requestId)
  return {
    input_tokens: hasUpIn ? upIn : estIn,
    output_tokens: upOut > 0 ? upOut : estOut,
    // 上游报了输入就连它的缓存口径一起留着 —— 那一格是它自己算的,我们估不出来。
    cache_read_input_tokens: hasUpIn ? upstream.cache_read_input_tokens : 0,
  }
}
