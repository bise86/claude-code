import { describe, expect, it } from 'bun:test'
import {
  decodeReasoningSignature, encodeReasoningSignature, toResponsesRequest,
} from './toResponsesRequest.js'

const O = { backendModel: 'gpt-5.1' }
const build = (body: any, opts = O) => toResponsesRequest(body, opts)

describe('消息映射', () => {
  it('顶层 system 走 instructions,不是 input 里的一条消息', () => {
    const r = build({ system: '你是助手', messages: [{ role: 'user', content: '你好' }] })
    expect(r.instructions).toBe('你是助手')
    expect(r.input).toEqual([{ role: 'user', content: '你好' }])
  })

  it('system 是块数组时也拼得出来', () => {
    const r = build({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] })
    expect(r.instructions).toBe('ab')
  })

  it('assistant 轮次用 EasyInputMessage(纯字符串),不是 output_text 块', () => {
    /**
     * `{type:'message', role:'assistant', content:[{type:'output_text',…}]}` 是**非法形状**:
     * 那个形状匹配的是 ResponseOutputMessage,它必填 id 和 status,里面的 ResponseOutputText
     * 还必填 annotations —— 三个我们一个都没有。而 ResponseInputItem.Message 的 role
     * 只收 user/system/developer,压根没有 assistant 这一档。
     */
    const r = build({ messages: [{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }] })
    expect(r.input).toEqual([{ role: 'assistant', content: '好的' }])
  })

  it('只有推理没有正文的 assistant 轮次整条丢掉,不发空字符串', () => {
    // 推理中撞上限、或者吐完推理就 finish 时会出现这种轮次;空 assistant 被部分后端 400。
    const r = build({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '想了想', signature: '' }] }] })
    expect(r.input).toEqual([])
  })

  it('tool_use → function_call,用的是 call_id', () => {
    const r = build({ messages: [{ role: 'assistant', content: [
      { type: 'text', text: '我查一下' },
      { type: 'tool_use', id: 'call_abc', name: 'Read', input: { file_path: 'a.ts' } },
    ] }] })
    expect(r.input).toEqual([
      { role: 'assistant', content: '我查一下' },
      { type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ])
  })

  it('tool_result → function_call_output,字段名是 output', () => {
    const r = build({ messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_abc', content: '读到了' },
    ] }] })
    expect(r.input).toEqual([{ type: 'function_call_output', call_id: 'call_abc', output: '读到了' }])
  })

  it('工具结果旁边的正文单独成一条,顺序是先结果后正文', () => {
    const r = build({ messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      { type: 'text', text: '继续' },
    ] }] })
    expect(r.input).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      { role: 'user', content: '继续' },
    ])
  })
})

describe('推理片段的往返', () => {
  const sig = encodeReasoningSignature('rs_1', 'ENCRYPTED')

  it('带工具调用的轮次会把 reasoning item 重发,而且排在 function_call 前面', () => {
    /**
     * 不重发就 400:`Item of type 'function_call' was provided without its required
     * 'reasoning' item`。而这条桥是无状态的(每轮从 anthropic messages 重建整个 input),
     * 用不了 previous_response_id —— 密文只能搭 thinking 块的 signature 回来。
     */
    const r = build({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: '想', signature: sig },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} },
    ] }] })
    expect(r.input[0]).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED', summary: [] })
    expect(r.input[1].type).toBe('function_call')
  })

  it('没有工具调用的轮次不白发密文', () => {
    const r = build({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: '想', signature: sig },
      { type: 'text', text: '答案是 42' },
    ] }] })
    expect(r.input).toEqual([{ role: 'assistant', content: '答案是 42' }])
  })

  it('不是我们编的签名一律不认 —— 免得把 anthropic 自己的签名当成密文发出去', () => {
    expect(decodeReasoningSignature('ErUBCkYIBBgCKkA…')).toBeUndefined()
    expect(decodeReasoningSignature(undefined)).toBeUndefined()
    expect(decodeReasoningSignature(42)).toBeUndefined()
  })

  it('签名被手工改坏时返回 undefined,不抛', () => {
    // node.md / 会话记录都可能被手工编辑;这里抛的话整个请求都发不出去。
    expect(decodeReasoningSignature('openai-responses-reasoning:{坏掉的')).toBeUndefined()
  })

  it('编码解码是一对', () => {
    expect(decodeReasoningSignature(encodeReasoningSignature('rs_9', 'X'))).toEqual({ id: 'rs_9', enc: 'X' })
  })
})

describe('顶层参数', () => {
  it('store:false 和 include 必须一起在 —— 少了 include 下一轮带工具调用就 400', () => {
    const r = build({ messages: [] })
    expect(r.store).toBe(false)
    expect(r.include).toEqual(['reasoning.encrypted_content'])
  })

  it('max_tokens → max_output_tokens', () => {
    expect(build({ messages: [], max_tokens: 1024 }).max_output_tokens).toBe(1024)
    expect(build({ messages: [] }).max_output_tokens).toBeUndefined()
  })

  it('思考档位落在 reasoning.effort,并且开着摘要', () => {
    // summary:'auto' 是思考过程能不能上屏的开关 —— 不开就又回到「没有思考、没有过程」。
    const r = build({ messages: [] }, { backendModel: 'gpt-5.1', effort: 'xhigh' })
    expect(r.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
  })

  it('没配档位就整个不发 reasoning', () => {
    expect(build({ messages: [] }).reasoning).toBeUndefined()
  })
})

describe('工具映射', () => {
  const tools = [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: {} } }]

  it('工具是**扁平**的,不是 chat 那种嵌套的 function 对象', () => {
    const r = build({ messages: [], tools })
    expect(r.tools).toEqual([{
      type: 'function', name: 'Read', description: '读文件',
      parameters: { type: 'object', properties: {} }, strict: false,
    }])
  })

  it('strict 必须显式关掉 —— 它默认是 true,而 anthropic 的 schema 满足不了严格模式', () => {
    expect(build({ messages: [], tools }).tools[0].strict).toBe(false)
  })

  it('没有 input_schema 的服务端工具被滤掉', () => {
    const r = build({ messages: [], tools: [...tools, { name: 'web_search', type: 'web_search_20250305' }] })
    expect(r.tools.map((t: any) => t.name)).toEqual(['Read'])
  })

  it('全被滤光时不发 tools 字段,而不是发空数组', () => {
    expect(build({ messages: [], tools: [{ name: 'web_search' }] }).tools).toBeUndefined()
  })

  it('tool_choice 四种都译,而且指定工具那种也是扁平的', () => {
    expect(build({ messages: [], tool_choice: { type: 'auto' } }).tool_choice).toBe('auto')
    expect(build({ messages: [], tool_choice: { type: 'any' } }).tool_choice).toBe('required')
    expect(build({ messages: [], tool_choice: { type: 'none' } }).tool_choice).toBe('none')
    expect(build({ messages: [], tool_choice: { type: 'tool', name: 'Read' } }).tool_choice)
      .toEqual({ type: 'function', name: 'Read' })
  })
})

describe('anthropic 专有字段一个都不带过去', () => {
  it('白名单式构造 —— betas/output_config/thinking/metadata 之类从来没被拷进来', () => {
    const r = build({
      messages: [], betas: ['x'], anthropic_beta: ['y'], output_config: { effort: 'high' },
      context_management: {}, metadata: {}, thinking: { type: 'enabled' }, container: 'c',
    })
    for (const k of ['betas', 'anthropic_beta', 'output_config', 'context_management', 'metadata', 'thinking', 'container']) {
      expect(`${k}: ${k in r}`).toBe(`${k}: false`)
    }
  })
})
