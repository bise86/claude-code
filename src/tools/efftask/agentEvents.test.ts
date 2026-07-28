import { describe, expect, it } from 'bun:test'
import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import {
  briefOfToolResult,
  briefOfToolUse,
  eventsFromMessage,
  MAX_EVENT_CHARS,
  MAX_LINES_PER_BLOCK,
  sanitizeLine,
  type AgentEvent,
} from './agentEvents.js'

/**
 * 夹具一律用真工厂造(createAssistantMessage / createUserMessage),不手搓
 * `{type:'assistant', content:[…]}` 字面量。
 *
 * 理由很实在:`src/types/message.ts` 在这个 fork 里**不存在**(全是 type-only 导入,构建期
 * 擦除),而且没有 typecheck。手搓一个 `m.content` 的夹具会让实现和测试**一起错、一起绿**
 * —— 实现读 `m.content` 读到了,测试也过了,而真实消息的内容在 `m.message.content`,生产
 * 里一个事件都出不来。工厂是唯一能证明路径对的东西。
 */
const asst = (content: unknown): Message =>
  createAssistantMessage({ content: content as never }) as unknown as Message
const user = (content: unknown): Message =>
  createUserMessage({ content: content as never }) as unknown as Message

const kinds = (evs: AgentEvent[]): string[] => evs.map(e => e.kind)
const texts = (evs: AgentEvent[]): string[] =>
  evs.flatMap(e => (e.kind === 'text' || e.kind === 'thinking' ? [e.text] : []))

const ESC = String.fromCharCode(27)

describe('eventsFromMessage —— 四类事件', () => {
  it('assistant 的 text / thinking / tool_use 各自成事件', () => {
    const evs = eventsFromMessage(
      asst([
        { type: 'text', text: '我先读一下实现' },
        { type: 'thinking', thinking: '应该从 pipeline 入手' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
      ]),
    )
    expect(kinds(evs)).toEqual(['text', 'thinking', 'tool'])
    expect(evs[0]).toEqual({ kind: 'text', text: '我先读一下实现' })
    expect(evs[1]).toEqual({ kind: 'thinking', text: '应该从 pipeline 入手' })
    expect(evs[2]).toEqual({ kind: 'tool', useId: 'tu_1', name: 'Read', brief: 'Read(src/a.ts)' })
  })

  it('user 消息里的 tool_result 是事件 —— 这一整类今天完全看不到', () => {
    // 现状:runAgentAdapter 只处理 type === 'assistant',user 消息整条跳过,所以工具返回了
    // 什么、报没报错,界面上一个字都没有。
    const evs = eventsFromMessage(
      user([{ type: 'tool_result', tool_use_id: 'tu_1', content: '1461 pass, 0 fail' }]),
    )
    expect(evs).toEqual([{ kind: 'result', useId: 'tu_1', brief: '1461 pass, 0 fail', isError: false }])
  })

  it('报错的 tool_result 带 isError', () => {
    const evs = eventsFromMessage(
      user([{ type: 'tool_result', tool_use_id: 'x', content: '找不到文件', is_error: true }]),
    )
    expect(evs[0]).toMatchObject({ kind: 'result', isError: true, brief: '找不到文件' })
  })

  it('redacted_thinking 也出一条,不静默吞掉', () => {
    const evs = eventsFromMessage(asst([{ type: 'redacted_thinking', data: 'xxxx' }]))
    expect(kinds(evs)).toEqual(['thinking'])
    expect(texts(evs)[0]).toContain('隐去')
  })

  it('纯工具轮次不再是一片空白', () => {
    // 这就是本功能存在的理由:一个只调工具、不说话的轮次,今天在界面上完全空白。
    const evs = eventsFromMessage(
      asst([
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } },
        { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'onChunk' } },
      ]),
    )
    expect(evs).toHaveLength(2)
    expect(kinds(evs)).toEqual(['tool', 'tool'])
  })

  it('content 是纯字符串的合法变体不会被逐字符迭代掉', () => {
    // 工厂会把字符串正规化成 text 块,所以这个变体只能手搓 —— 而它是真的:
    // runAgentAdapter.ts 的 collectText 专门为它留了一条分支。掉进块循环会逐 CHARACTER
    // 迭代,每个 .type 都是 undefined,整段回答静默消失。
    const raw = { type: 'assistant', message: { role: 'assistant', content: '直接一段字符串' } }
    const evs = eventsFromMessage(raw as unknown as Message)
    expect(evs).toEqual([{ kind: 'text', text: '直接一段字符串' }])
  })

  it('progress / attachment / 未知类型返回空数组,不抛', () => {
    for (const t of ['progress', 'attachment', 'system', '', 'nope']) {
      const m = { type: t, message: { content: [{ type: 'text', text: 'x' }] } }
      expect(eventsFromMessage(m as unknown as Message)).toEqual([])
    }
  })

  it('内容不是数组、或消息本身是 null,都返回空数组', () => {
    expect(eventsFromMessage(null as unknown as Message)).toEqual([])
    expect(eventsFromMessage({ type: 'assistant' } as unknown as Message)).toEqual([])
    expect(eventsFromMessage({ type: 'assistant', message: { content: 42 } } as unknown as Message)).toEqual([])
  })
})

describe('按行拆 —— 不能比现状更差', () => {
  it('一个 text 块按 \\n 拆成多条事件', () => {
    // 现状(chunkBuffer)是先拆行、每行截 300、保 200 行。若一整块只出一条事件再截 300 码点,
    // 一段两千字的产出自述就只剩 300 字 —— 比动手之前更差,而这正是用户第一位要看的东西。
    const evs = eventsFromMessage(asst([{ type: 'text', text: '第一行\n第二行\n第三行' }]))
    expect(texts(evs)).toEqual(['第一行', '第二行', '第三行'])
  })

  it('空白行与纯控制字节行不产出事件', () => {
    const evs = eventsFromMessage(
      asst([{ type: 'text', text: `有内容\n\n   \n${ESC}${String.fromCharCode(7)}\n又有内容` }]),
    )
    expect(texts(evs)).toEqual(['有内容', '又有内容'])
  })

  it('超长块只留头部,并把丢掉多少说出来', () => {
    const body = Array.from({ length: MAX_LINES_PER_BLOCK + 25 }, (_, i) => `行${i + 1}`).join('\n')
    const evs = eventsFromMessage(asst([{ type: 'text', text: body }]))
    const t = texts(evs)
    expect(t).toHaveLength(MAX_LINES_PER_BLOCK + 1)
    expect(t[0]).toBe('行1')
    expect(t[MAX_LINES_PER_BLOCK]).toBe('… (本段还有 25 行未显示)')
  })
})

describe('sanitizeLine', () => {
  it('剥控制字节 —— 这条路径的文本从模型直达终端,从不落盘', () => {
    // 实测:一条含 ESC[2J(清屏)的消息能整条打到终端字节流上。其他字段有
    // persistence.stripControl 兜着,这条路径没有。
    const out = sanitizeLine(`${ESC}[2J${ESC}[31m我把屏幕清了`)
    expect(out).not.toContain(ESC)
    expect(out).toContain('我把屏幕清了')
  })

  it('回车也要剥 —— CRLF 拆行后行尾的 \\r 会把后一行覆盖上去', () => {
    expect(sanitizeLine('一行内容\r')).toBe('一行内容')
  })

  it('TAB 换成空格 —— 量出来的宽度必须等于画出来的宽度', () => {
    // 留着 TAB 的话 stringWidth('\t') 是 0,而渲染层按 8 列展开:实测一行 4 个 TAB
    // 量出 26 列、实际画 45 列,折行按错误的宽度切块,后面的块接在看不见的位置上。
    // 而这不是理论 —— 每一条 Read 的返回值首行都是 `%6d\t…`。
    expect(sanitizeLine('a\tb')).toBe('a  b')
    expect(sanitizeLine('\t\t缩进')).toBe('    缩进')
  })

  it('按码点截断 —— 一条没有换行的百万字消息不能常驻整场运行', () => {
    const out = sanitizeLine('x'.repeat(1_000_000))
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_EVENT_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('刚好合规的行不加省略号', () => {
    expect(sanitizeLine('a'.repeat(MAX_EVENT_CHARS))).not.toContain('…')
  })

  it('按码点而不是 UTF-16 单元 —— emoji 不能被腰斩成半个代理项', () => {
    expect(Array.from(sanitizeLine('哈'.repeat(1000))).length).toBe(MAX_EVENT_CHARS + 1) // +1 是省略号

    // 前缀那个 'a' 是**故意**的:MAX_EVENT_CHARS 是偶数,纯 emoji 串按 UTF-16 单元切也
    // 恰好落在代理对边界上,于是「按码点切」和「按单元切」产出相同结果 —— 探针就成了空的。
    // 加一个单字节前缀把边界推成奇数,两种切法才真正分叉。
    const emoji = sanitizeLine('a' + '🙂'.repeat(1000))
    expect(Array.from(emoji).length).toBe(MAX_EVENT_CHARS + 1)
    const lone = [...emoji].some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)
    expect(`留下了半个代理项: ${lone}`).toBe('留下了半个代理项: false')
  })

  it('空白 / 纯控制字节 → 空串(调用方据此丢弃)', () => {
    expect(sanitizeLine('')).toBe('')
    expect(sanitizeLine('   \t ')).toBe('')
    expect(sanitizeLine(ESC + String.fromCharCode(7))).toBe('')
  })
})

describe('briefOfToolUse —— 像真实终端那一行', () => {
  const cases: [string, unknown, string][] = [
    ['Read', { file_path: 'src/tools/efftask/pipeline.ts' }, 'Read(src/tools/efftask/pipeline.ts)'],
    ['Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, 'Edit(a.ts)'],
    ['Write', { file_path: 'b.ts', content: '...' }, 'Write(b.ts)'],
    ['Bash', { command: 'bun test src/tools/efftask' }, 'Bash(bun test src/tools/efftask)'],
    ['Glob', { pattern: '**/*.ts' }, 'Glob(**/*.ts)'],
    ['Task', { description: '评审这段代码', prompt: '很长很长' }, 'Task(评审这段代码)'],
  ]
  for (const [name, input, want] of cases) {
    it(`${name} → ${want}`, () => {
      expect(briefOfToolUse(name, input)).toBe(want)
    })
  }

  it('Grep 带上搜索路径', () => {
    expect(briefOfToolUse('Grep', { pattern: 'onChunk', path: 'src' })).toBe('Grep(onChunk in src)')
    expect(briefOfToolUse('Grep', { pattern: 'onChunk' })).toBe('Grep(onChunk)')
  })

  it('多行命令只取首行,并说明后面还有', () => {
    expect(briefOfToolUse('Bash', { command: 'cd x\nbun test' })).toBe('Bash(cd x…)')
  })

  it('mcp__* 走兜底:第一个有内容的字符串参数', () => {
    expect(briefOfToolUse('mcp__docs__search', { limit: 5, query: '事件流' })).toBe('mcp__docs__search(事件流)')
  })

  it('没有可用参数时就是工具名本身,不渲染一对空括号', () => {
    expect(briefOfToolUse('SomeTool', {})).toBe('SomeTool')
    expect(briefOfToolUse('SomeTool', { n: 1 })).toBe('SomeTool')
  })

  it('注入的是**标签**,参数仍然来自输入 —— 这条原来编码的就是那个 bug', () => {
    // 旧断言是 'Read(注入的摘要)':把 resolve() 的结果当成括号里的内容。
    // 而 resolve 接的是各工具的 userFacingName(input),它返回的是**工具显示名**
    // (FileReadTool 返回 'Read',BashTool 返回 'Bash')—— 非空,于是一路短路,
    // 静态表根本轮不到跑。用户看到的就是一串没有文件名的 Read、没有命令的 Bash。
    expect(briefOfToolUse('Read', { file_path: 'a.ts' }, () => '注入的摘要'))
      .toBe('注入的摘要(a.ts)')
  })

  it('工具改了显示名时,标签跟着改而参数不丢', () => {
    // 读方案文件时 FileReadTool 的 userFacingName 返回 'Reading Plan'。
    expect(briefOfToolUse('Read', { file_path: '/plans/x.md' }, () => 'Reading Plan'))
      .toBe('Reading Plan(/plans/x.md)')
  })

  it('userFacingName 只回工具名时,和没有解析器一样有参数', () => {
    // 这是**多数**工具的形态,也是用户实际踩到的那一种。
    expect(briefOfToolUse('Read', { file_path: 'src/a.ts' }, () => 'Read'))
      .toBe('Read(src/a.ts)')
    expect(briefOfToolUse('Bash', { command: 'bun test' }, () => 'Bash'))
      .toBe('Bash(bun test)')
  })

  it('标签里已经含了参数就不重复', () => {
    // 有些工具会把路径拼进显示名,直接追加会得到 'Read src/a.ts(src/a.ts)'。
    expect(briefOfToolUse('Read', { file_path: 'src/a.ts' }, () => 'Read src/a.ts'))
      .toBe('Read src/a.ts')
  })

  it('注入的解析器抛了,落回静态表而不是带走这次调用', () => {
    const brief = briefOfToolUse('Read', { file_path: 'a.ts' }, () => {
      throw new Error('工具的 userFacingName 炸了')
    })
    expect(brief).toBe('Read(a.ts)')
  })
})

describe('briefOfToolResult', () => {
  it('字符串取首行', () => {
    expect(briefOfToolResult('1461 pass\n0 fail')).toBe('1461 pass…')
  })
  it('数组只取第一个 text 块,不拼接', () => {
    expect(briefOfToolResult([{ type: 'text', text: '第一块' }, { type: 'text', text: '第二块' }])).toBe('第一块')
  })
  it('没有文本块 / 空 / 非数组都有话说,不留空白', () => {
    expect(briefOfToolResult([{ type: 'image', source: {} }])).toBe('(非文本输出)')
    expect(briefOfToolResult([])).toBe('(无输出)')
    expect(briefOfToolResult(undefined)).toBe('(无输出)')
    expect(briefOfToolResult('')).toBe('(无输出)')
  })
  it('超大返回值不会被整串带进内存', () => {
    const huge = 'x'.repeat(250_000)
    const out = briefOfToolResult(huge)
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_EVENT_CHARS + 1)
  })
})

describe('敌意输入:这条路径不能抛', () => {
  /**
   * 生成式,不是列举 —— 和 hostileDisk.test.ts 同一个理由。
   *
   * 而且畸形 input 是**生产可达**的:utils/messages.ts 的 normalizeContentFromAPI 对流式
   * 返回的 input 走 `safeParseJSON(...) ?? {}`,而 JSON.parse('[1,2]') 是数组、
   * JSON.parse('5') 是数字、JSON.parse('"x"') 是字符串 —— 三者都不是 null,`?? {}` 一个
   * 都拦不住。
   *
   * 抛出去的代价不是「窗口空了」:异常会从 for await 逃出 → consume() reject →
   * collectText 永不执行 → 席位判 infra → 重试三桌 → 节点阻断,理由写「角色调用失败」。
   */
  const circular: Record<string, unknown> = { name: 'x' }
  circular.self = circular
  const deep = ((): unknown => {
    let o: unknown = { end: true }
    for (let i = 0; i < 1000; i++) o = { nest: o }
    return o
  })()
  const HOSTILE: unknown[] = [
    null, undefined, 123, -1, 0, Number.NaN, 'a string', '', true, false,
    [], [null], ['x'], {}, { nope: 1 }, { file_path: 123 }, { command: null },
    circular, deep, Object.create(null),
    new Proxy({}, { ownKeys() { throw new Error('proxy 炸了') } }),
  ]

  it('briefOfToolUse 对任何 input 都不抛,且总是返回字符串', () => {
    for (const input of HOSTILE) {
      for (const name of ['Read', 'Bash', 'Grep', 'mcp__x__y', '']) {
        const out = briefOfToolUse(name, input)
        expect(typeof out).toBe('string')
      }
    }
  })

  it('数组和标量 input 只出工具名,不编一个不存在的参数出来', () => {
    // `input` 是数组/数字/字符串是**生产可达**的(见上面那段注释)。若只挡 null,
    // `Object.values(['x'])` 会回 'x',界面上就渲染成 `Read(x)` —— 一个根本不存在的文件名。
    // 编一个看着像真的的参数,比什么都不显示更糟。
    // 走兜底那条分支的工具(表里没有的名字)才是真正会被数组咬到的:表内工具取具名字段,
    // 数组上取到 undefined 就自然空了;而兜底是 `Object.values(input).find(…)`,数组的
    // values 就是元素本身。只测 Read 的话,少了这行守卫照样绿。
    expect(briefOfToolUse('mcp__x__y', ['第一个元素', 'b'])).toBe('mcp__x__y')
    expect(briefOfToolUse('Read', ['secrets.ts', 'b.ts'])).toBe('Read')
    expect(briefOfToolUse('Bash', 'rm -rf /')).toBe('Bash')
    expect(briefOfToolUse('Read', 5)).toBe('Read')
    expect(briefOfToolUse('Read', true)).toBe('Read')
  })

  it('briefOfToolResult 对任何 content 都不抛', () => {
    for (const c of HOSTILE) expect(typeof briefOfToolResult(c)).toBe('string')
  })

  it('eventsFromMessage 对畸形块都不抛', () => {
    for (const bad of HOSTILE) {
      // 块本身畸形
      expect(() => eventsFromMessage(asst([bad]))).not.toThrow()
      // 已知类型但字段畸形
      expect(() => eventsFromMessage(asst([{ type: 'text', text: bad }]))).not.toThrow()
      expect(() => eventsFromMessage(asst([{ type: 'thinking', thinking: bad }]))).not.toThrow()
      expect(() => eventsFromMessage(asst([{ type: 'tool_use', id: bad, name: bad, input: bad }]))).not.toThrow()
      expect(() => eventsFromMessage(user([{ type: 'tool_result', tool_use_id: bad, content: bad }]))).not.toThrow()
    }
  })

  it('字段畸形时宁可不出事件,也不出一条 undefined 的事件', () => {
    const evs = eventsFromMessage(asst([{ type: 'text', text: 123 }, { type: 'thinking', thinking: null }]))
    expect(evs).toEqual([])
  })

  it('工具名畸形时仍然出事件 —— 「调了个说不清的工具」也是信息', () => {
    const evs = eventsFromMessage(asst([{ type: 'tool_use', id: 5, name: null, input: { a: 'b' } }]))
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'tool', useId: '', name: '未知工具' })
  })
})
