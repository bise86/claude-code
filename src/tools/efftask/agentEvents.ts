/**
 * 把子 agent 的一条消息拆成「窗口里能看的一行行东西」(spec 2026-07-27 §4)。
 *
 * 在这之前,`runAgentAdapter` 只对 `type === 'assistant'` 的消息调 `collectText()`,也就是
 * **只取 text 块**:模型的思考、它调了什么工具、工具返回了什么,全部丢掉。一个纯工具轮次
 * (读了 12 个文件)在界面上是完全空白的 —— 用户看到「运行中 · 47s」和一片空白,分不清
 * 模型在干活还是卡死了。这个模块就是为了让那一片空白变成一段能读的终端输出。
 *
 * 全纯函数,没有状态、没有 IO。原因有两条:
 *  1. 它跑在**模型消息热路径**上,每条消息都要过一遍;
 *  2. 它跑在**热路径上且不能抛** —— 见 runAgentAdapter 里那段 try/catch 的注释:一个只负责
 *     画字符串的函数抛出去,会让席位判 infra、重试三桌、最后把节点阻断,而阻断理由写的是
 *     「角色调用失败」,指向完全错误的方向。所以这里对每一个外来字段都当敌意输入处理。
 */
import type { Message } from '../../types/message.js'

/**
 * 单**行**保留的码点数。
 *
 * 是「行」不是「块」。设计稿第一版把一整个 text block 做成一条事件再截 300 码点,而现状
 * (chunkBuffer)是先按 `\n` 拆行、每行截 300、保 200 行 —— 那样改等于把「模型说了什么」
 * 从 200 行砍到 300 字,比动手之前更差。而模型说的话恰恰是用户第一位要看的东西。
 */
export const MAX_EVENT_CHARS = 300

/**
 * 一个 text/thinking 块最多拆出多少行。
 *
 * 不设这条的话,一段 2000 行的产出自述会一次性挤爆该席位的环形缓冲,把**工具调用记录全部
 * 顶掉** —— 而工具调用正是这个功能最想让人看见的部分。超出的部分用一行说明兑现,不假装
 * 没有。取头不取尾:一段超长的模型自述是散文,开头有代表性(与执行日志相反,那边是 tail)。
 */
export const MAX_LINES_PER_BLOCK = 60

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; useId: string; name: string; brief: string }
  | { kind: 'result'; useId: string; brief: string; isError: boolean }

/**
 * 工具摘要的外部解析器。
 *
 * `/et` 的适配层手上就有 `availableTools`,每个 Tool 自带 `userFacingName(input)`(src/Tool.ts),
 * 主 REPL 就是用它渲染每一行工具调用的。优先走它,新工具进来自动有好摘要;缺席或返回空
 * 才落到本文件下面那张静态表。表是兜底,不是主路径。
 */
export type BriefResolver = (name: string, input: unknown) => string | undefined

/**
 * 控制字节。保留 TAB(U+0009) 与换行(U+000A),其余一律剥掉 —— 含回车(U+000D)。
 *
 * chunkBuffer 里那条留了回车;这里补上,因为 CRLF 文本拆行之后每行尾部会挂一个回车,把
 * 光标打回行首,后面一行就覆盖上去了。
 *
 * 为什么要剥:这条路径的文本**从模型直达终端**,和其他字段不同 —— 它从不落盘,所以
 * persistence.stripControl 永远看不到它。实测一条含 ESC[2J(清屏)的消息能整条打到终端上。
 */
// eslint-disable-next-line no-control-regex -- 剥控制字节就是本函数的目的
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g

/**
 * 一行文本 → 可以直接打到终端上的一行,或空串(调用方丢弃)。
 *
 * 三步的顺序不能换。先粗切再剥再精切:一个 0.25 MB 的无换行行(读一个 minified bundle 的
 * 返回值)如果先跑全串正则替换,会白白造一个 0.25 MB 的新串,而最终只留 300 码点 —— 而这
 * 是每个工具返回都要走一遍的热路径。
 *
 * 返回空串而不是 null:调用方只有 `pushLines` 一处,空串在那里被 `if (!line) continue` 挡住。
 * 一个「可能为 null」的返回值会有 N 个调用方各自记得判空,而这里只需要一处记得。
 */
export function sanitizeLine(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const coarse = raw.length > MAX_EVENT_CHARS * 4 ? raw.slice(0, MAX_EVENT_CHARS * 4) : raw
  const stripped = coarse.replace(CONTROL, '')
  const cps = Array.from(stripped)
  const clipped = cps.length > MAX_EVENT_CHARS ? cps.slice(0, MAX_EVENT_CHARS).join('') + '…' : stripped
  return clipped.trim().length === 0 ? '' : clipped
}

/** 一个 text/thinking 块 → 若干条按行的事件。空白行与纯控制字节行不产出事件。 */
function pushLines(out: AgentEvent[], kind: 'text' | 'thinking', body: string): void {
  const raw = body.split('\n')
  const limit = Math.min(raw.length, MAX_LINES_PER_BLOCK)
  for (let i = 0; i < limit; i++) {
    const line = sanitizeLine(raw[i]!)
    if (!line) continue
    out.push({ kind, text: line })
  }
  if (raw.length > MAX_LINES_PER_BLOCK) {
    out.push({ kind, text: `… (本段还有 ${raw.length - MAX_LINES_PER_BLOCK} 行未显示)` })
  }
}

/** 参数摘要里的一段值 → 一行。带上「后面还有」的省略号,不谎报这是全部。 */
function briefValue(s: string): string {
  const window = s.length > MAX_EVENT_CHARS * 4 ? s.slice(0, MAX_EVENT_CHARS * 4) : s
  const nl = window.indexOf('\n')
  const head = nl >= 0 ? window.slice(0, nl) : window
  const truncated = nl >= 0 || s.length > window.length
  const line = sanitizeLine(head)
  if (!line) return ''
  return truncated && !line.endsWith('…') ? `${line}…` : line
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead'])

/**
 * 静态兜底表。
 *
 * `input` 是 `unknown` 而且**畸形是生产可达的**,不是理论:utils/messages.ts 的
 * `normalizeContentFromAPI` 对流式返回的 input 走 `safeParseJSON(...) ?? {}`,而
 * `JSON.parse('[1,2]')` 是数组、`JSON.parse('5')` 是数字、`JSON.parse('"x"')` 是字符串 ——
 * 三者都不是 null,`?? {}` 一个都拦不住。所以第一行就把非普通对象挡掉。
 *
 * 不用 JSON.stringify 做兜底:循环引用直接抛,而这条路径不能抛。
 */
function staticBrief(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  const rec = input as Record<string, unknown>
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '')
  if (FILE_TOOLS.has(name)) return briefValue(str('file_path') || str('notebook_path'))
  // 不要先 firstLine 再 briefValue:briefValue 自己就取首行,而且**靠有没有换行来判断要不要
  // 加省略号**。先把换行切掉,它就以为这已经是全部了,一条 20 行的脚本会渲染成第一行、
  // 不带任何「后面还有」的提示。
  if (name === 'Bash' || name === 'PowerShell') return briefValue(str('command'))
  if (name === 'Grep') {
    const p = briefValue(str('pattern'))
    const path = str('path')
    return p && path ? `${p} in ${briefValue(path)}` : p
  }
  if (name === 'Glob') return briefValue(str('pattern'))
  if (name === 'Task' || name === 'Agent') return briefValue(str('description'))
  // 兜底:第一个有内容的字符串型自有属性。mcp__* 走的就是这条。
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim().length > 0) return briefValue(v)
  }
  return ''
}

/** `Read(src/a.ts)` / `Bash(bun test)` / 没有可用参数时就是工具名本身。永不抛。 */
export function briefOfToolUse(name: string, input: unknown, resolve?: BriefResolver): string {
  try {
    if (resolve) {
      const injected = resolve(name, input)
      if (typeof injected === 'string' && injected.trim().length > 0) {
        const line = briefValue(injected)
        if (line) return `${name}(${line})`
      }
    }
  } catch {
    // 工具自己的 userFacingName 在畸形输入上抛了。落到静态表,不要带走这次调用。
  }
  try {
    const arg = staticBrief(name, input)
    return arg ? `${name}(${arg})` : name
  } catch {
    return name
  }
}

/**
 * 工具返回值 → 一行摘要。永不抛。
 *
 * **只取第一个 text 块,不拼接。** 拼接是为了取首行而先复制全部文本:10 个 25 KB 的块就是
 * 一次 250 KB 的临时分配,而需要的只有前 300 个码点。也**不数行数** —— 数行要么 split
 * (0.25 MB 上分配约 5000 个字符串对象)要么全串扫描,而窗口里那个数没人核对,一个省略号
 * 传达的信息是一样的。
 */
export function briefOfToolResult(content: unknown): string {
  try {
    if (typeof content === 'string') return briefValue(content) || '(无输出)'
    if (Array.isArray(content)) {
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const b = raw as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') return briefValue(b.text) || '(无输出)'
      }
      return content.length > 0 ? '(非文本输出)' : '(无输出)'
    }
    return '(无输出)'
  } catch {
    return '(无输出)'
  }
}

function asId(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 一条消息 → 0..N 条事件。
 *
 * 内容路径是 **`m.message.content`**,不是 `m.content`。这一点必须写出来:`src/types/message.ts`
 * 在这个 fork 里**不存在**(186 处 type-only 导入,构建期擦除),所以路径写错**零反馈** ——
 * 加上下面「未知类型返回空数组」这条,一个写错的路径会被伪装成「这条消息没有事件」,永远
 * 不报错。仓库里仅有的两处真实证据:runAgentAdapter.ts 的 `m.message.content`,以及
 * utils/messages.ts 的 `message.message.content[0]?.type === 'tool_result'`。
 */
export function eventsFromMessage(m: Message, resolve?: BriefResolver): AgentEvent[] {
  const msg = m as unknown as { type?: unknown; message?: { content?: unknown } } | null
  if (!msg || typeof msg !== 'object') return []
  const content = msg.message?.content
  const out: AgentEvent[] = []

  if (msg.type === 'assistant') {
    // content 是纯字符串是一个合法变体(见 utils/messages.ts 与 services/api/claude.ts)。
    // 掉进下面的块循环会**逐字符**迭代,每个 `.type` 都是 undefined,整段回答静默消失。
    if (typeof content === 'string') {
      pushLines(out, 'text', content)
      return out
    }
    if (!Array.isArray(content)) return []
    for (const raw of content) {
      // 内容数组里可以有 null —— 直接读 `.type` 会抛,而抛出去的代价见文件头。
      if (!raw || typeof raw !== 'object') continue
      const b = raw as Record<string, unknown>
      switch (b.type) {
        case 'text':
          if (typeof b.text === 'string') pushLines(out, 'text', b.text)
          break
        case 'thinking':
          if (typeof b.thinking === 'string') pushLines(out, 'thinking', b.thinking)
          break
        case 'redacted_thinking':
          out.push({ kind: 'thinking', text: '(思考内容已由服务端隐去)' })
          break
        case 'tool_use': {
          const name = typeof b.name === 'string' && b.name.length > 0 ? b.name : '未知工具'
          out.push({ kind: 'tool', useId: asId(b.id), name, brief: briefOfToolUse(name, b.input, resolve) })
          break
        }
        default:
          break
      }
    }
    return out
  }

  if (msg.type === 'user') {
    if (!Array.isArray(content)) return []
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const b = raw as Record<string, unknown>
      if (b.type !== 'tool_result') continue
      out.push({
        kind: 'result',
        useId: asId(b.tool_use_id),
        brief: briefOfToolResult(b.content),
        isError: b.is_error === true,
      })
    }
    return out
  }

  // progress / attachment / 未知类型。**返回空数组,不抛** —— 见文件头。
  return []
}
