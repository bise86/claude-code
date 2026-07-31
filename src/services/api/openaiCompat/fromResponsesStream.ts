import { logError } from '../../../utils/log.js'
import { createBlockWriter, type Evt, fallbackUsage } from './blocks.js'
import type { StreamCtx } from './protocols.js'
import { encodeReasoningSignature } from './toResponsesRequest.js'

/**
 * OpenAI **Responses** 事件流 → anthropic 事件流。
 *
 * 和 chat/completions 那侧是**两份**。差别不是风格,是事件模型:
 * chat 是 `choices[0].delta` 的增量拼装(所以要一路猜 index、猜 id 什么时候到);
 * responses 是有类型的事件流,每个 item 的身份在 `response.output_item.added` 那一刻
 * 就**全都有了**,还有 `response.output_item.done` 标出精确终点。
 *
 * 直接后果:chat 那边「工具调用攒到流末尾再发」的三条实测理由,前两条在这里
 * **物理上不可能发生**(`item_id` / `output_index` 是必填,`output_item.added` 一开始
 * 就带全 `call_id` 和 `name`)。所以这里在 `output_item.done` **当场**发,顺序是真实时序,
 * 比 chat 那边「攒到末尾把顺序变确定」更正确,代码也少一半。
 *
 * 白名单式处理:responses 的事件种类多而且还在增长,认不出来的一律忽略,不报错。
 */

/** 一次工具调用在流里的中间态。键是 `item_id`(`fc_…`),回传要用的是 `call_id`(`call_…`)。 */
interface PendingCall { callId?: string; name?: string; args: string; fromDelta: string }

export async function* responsesEventsToAnthropicEvents(
  frames: AsyncIterable<any>, ctx: StreamCtx,
): AsyncGenerator<Evt> {
  const w = createBlockWriter(ctx)
  const calls = new Map<string, PendingCall>()
  let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } = { input_tokens: 0, output_tokens: 0 }
  /**
   * responses **没有 finish_reason**,所以 stop_reason 只能自己推:本轮发过 function_call
   * 就是 tool_use。漏了这条推导的后果是工具循环根本不跑 —— 模型请求了工具,而引擎
   * 以为这一轮结束了。
   */
  let emittedTool = false
  let stopReason = 'end_turn'
  /** 推理摘要可能分成多个 part。直接拼接会把段落粘死,所以第二段起自己补空行。 */
  let summaryParts = 0

  const readUsage = (u: any): void => {
    if (!u) return
    // responses 用 input_tokens/output_tokens,chat 用 prompt_tokens/completion_tokens。
    /**
     * 命中缓存的那一段要**单列出来**。
     *
     * OpenAI 的 `prompt_tokens` / `input_tokens` 本身**已经包含**缓存部分,所以不减掉的话
     * 总量没错、但详情页那句「缓存 读 X」对 openai 系员工恒为 0 —— 而 README 明写着
     * 「缓存读写单列」。一个高度复用上下文的运行,便宜的那一大截会被算成全价输入。
     *
     * 减完可能为负(网关自己报的两个数不自洽),夹到 0。
     */
    const cached = Math.max(0, u.input_tokens_details?.cached_tokens ?? 0)
    usage = {
      input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: cached,
    }
  }

  for await (const f of frames) {
    const type: string = typeof f?.type === 'string' ? f.type : ''
    switch (type) {
      case 'response.created':
        yield* w.startIfNeeded(f.response?.id)
        break

      case 'response.reasoning_summary_part.added':
        // 只做分段记账,正文由下面的 delta 事件送。
        if (summaryParts > 0) yield* w.thinking('\n\n')
        summaryParts++
        break

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        // 两个事件都存在:摘要(summary:'auto' 时)和推理正文(部分模型/配置下才有)。
        if (typeof f.delta === 'string') yield* w.thinking(f.delta)
        break

      case 'response.output_text.delta':
        if (typeof f.delta === 'string') yield* w.text(f.delta)
        break

      case 'response.refusal.delta':
        /**
         * 拒答也是模型这一轮的回答。按「认不出来就忽略」丢掉它的话,用户拿到的是一个
         * **完全空白**的回复 —— 看不出是拒答、是超时,还是这条桥坏了。
         */
        if (typeof f.delta === 'string') yield* w.text(f.delta)
        break

      case 'response.output_item.added': {
        const item = f.item
        if (item?.type !== 'function_call') break
        const key = String(item.id ?? f.item_id ?? `i${calls.size}`)
        calls.set(key, {
          callId: typeof item.call_id === 'string' ? item.call_id : undefined,
          name: typeof item.name === 'string' ? item.name : undefined,
          args: typeof item.arguments === 'string' ? item.arguments : '',
          fromDelta: '',
        })
        break
      }

      case 'response.function_call_arguments.delta': {
        const key = String(f.item_id ?? '')
        const c = calls.get(key)
        // added 没到就先建一条 —— 顺序反常时宁可留住参数,也不要静默丢掉一次调用。
        if (!c) calls.set(key, { args: '', fromDelta: typeof f.delta === 'string' ? f.delta : '' })
        else if (typeof f.delta === 'string') c.fromDelta += f.delta
        break
      }

      case 'response.function_call_arguments.done': {
        const c = calls.get(String(f.item_id ?? ''))
        // `.done` 带的是**完整**参数,以它为准;拼出来的增量只在它缺席时兜底。
        if (c && typeof f.arguments === 'string') c.args = f.arguments
        break
      }

      case 'response.output_item.done': {
        const item = f.item
        if (item?.type === 'reasoning') {
          /**
           * 把密文塞进 thinking 块的签名带回下一轮。不带的话,下一轮只要有工具调用就
           * 400(`function_call was provided without its required reasoning item`)——
           * 而一个天天调工具的员工,那是常态不是边界。
           */
          const enc = typeof item.encrypted_content === 'string' ? item.encrypted_content : ''
          if (enc.length > 0) yield* w.signature(encodeReasoningSignature(String(item.id ?? ''), enc))
          /**
           * 盖完签名**立刻收口这个思考块**。
           *
           * 不收的话下一条 reasoning item 的签名会落在**同一个块**上,而 claude.ts 处理
           * signature_delta 是 `contentBlock.signature = delta.signature` —— **赋值不是追加**,
           * 后写的把先写的盖掉。实测一轮里相邻两条 reasoning item,第一条的密文静默消失。
           *
           * gpt-5.1-codex 系在一轮里交替吐 [reasoning, 正文, reasoning, function_call] 是这条
           * 协议的典型输出,中间隔着正文时 w.text 会顺手关掉;**唯独相邻**这一种排布中招。
           */
          yield* w.closeThinking()
          break
        }
        if (item?.type !== 'function_call') break
        const key = String(item.id ?? f.item_id ?? '')
        const c = calls.get(key)
        const args = (typeof item.arguments === 'string' && item.arguments.length > 0)
          ? item.arguments
          : (c?.args && c.args.length > 0 ? c.args : (c?.fromDelta ?? ''))
        // **call_id**,不是 item_id:下一轮的 function_call_output 按 call_id 配对,
        // 传 item 的 `fc_…` 过去下一轮就撞不上。
        yield* w.toolUse({
          id: (typeof item.call_id === 'string' ? item.call_id : c?.callId),
          name: (typeof item.name === 'string' ? item.name : c?.name),
          args,
        })
        calls.delete(key)
        emittedTool = true
        break
      }

      case 'response.incomplete': {
        readUsage(f.response?.usage)
        const reason = f.response?.incomplete_details?.reason
        // content_filter 与 chat 那侧口径一致(映射成 end_turn),别的都当截断。
        stopReason = reason === 'content_filter' ? 'end_turn' : 'max_tokens'
        break
      }

      case 'response.completed':
        readUsage(f.response?.usage)
        break

      case 'response.failed': {
        readUsage(f.response?.usage)
        // `response.failed` 的错误在 **response.error.message**,不是顶层。
        const msg = f.response?.error?.message ?? 'upstream response failed'
        logError(new Error(`Responses upstream failed: ${msg}`))
        yield* w.error(String(msg), f.response?.id)
        return
      }

      case 'error': {
        /**
         * 顶层 error 事件的 message 在**顶层**(`{type:'error', code, message, param}`),
         * 和 `response.failed` 是**两种**形状。照搬 chat 那侧的 `c.error?.message`
         * 两个都读不到 —— 用户会拿到一条「upstream error」而真正的原因被吞掉。
         */
        const msg = f.message ?? f.error?.message ?? 'upstream error'
        logError(new Error(`Responses upstream error: ${msg}`))
        yield* w.error(String(msg))
        return
      }

      default:
        // 认不出来的事件一律忽略。种类多且在增长,为一个没见过的名字报错是最差的选择。
        break
    }
  }

  /**
   * 流断在半路时还攒着的调用**照发**。
   *
   * 丢掉的话模型这次调用的意图凭空消失,而用户只看到「它什么都没干」;发出去则是一个
   * 看得见、查得到的失败。和 chat 那侧「不丢块」是同一条理由。
   */
  for (const c of calls.values()) {
    yield* w.toolUse({ id: c.callId, name: c.name, args: c.args.length > 0 ? c.args : c.fromDelta })
    emittedTool = true
  }
  if (emittedTool && stopReason === 'end_turn') stopReason = 'tool_use'
  yield* w.finish(stopReason, fallbackUsage(usage, w, ctx))
}
