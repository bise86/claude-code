/**
 * 子 agent 实时窗口的渲染与按键 —— 全纯函数 (spec 2026-07-27 §7/§8)。
 *
 * 组件里只留状态和副作用,能算的全部搬到这里。这不是洁癖:评审已经指出,滚动位置在这个
 * 仓库的 TTY 夹具里**根本观测不到**(累积型夹具让 `not.toContain` 恒真;带 reset 的夹具
 * 又因为渲染器只写 diff 而让正向断言不可靠)。按键语义和窗口计算如果留在组件里,就只能
 * 靠人眼验证。
 */
import figures from 'figures'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { AgentEvent } from '../../tools/efftask/agentEvents.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import { BLACK_CIRCLE, TEARDROP_ASTERISK } from '../../constants/figures.js'

/**
 * 主题键,不是裸色名。
 *
 * vendored 的 Ink 把不认识的颜色名解析成 `undefined`,于是「写了颜色」和「没写颜色」在
 * 屏幕上一模一样,而测试里也看不出区别。封闭联合把这件事交给类型卡住。
 */
export type LogColor = 'success' | 'warning' | 'error' | 'inactive' | undefined

export interface LogLine {
  text: string
  color?: LogColor
  dim?: boolean
  bold?: boolean
  /** 属于第几条流。-1 = 全局提示行。 */
  streamIndex: number
  isHeader?: boolean
  /** 选中的流的表头 —— 组件据此加 inverse。 */
  selected?: boolean
}

/** 折叠/展开的三角。走 figures,它在不支持 Unicode 的终端上自动退 ASCII。 */
const OPEN = figures.triangleDownSmall
const SHUT = figures.triangleRightSmall
/** 滚动条滑块。`█` 全仓没有先例,而且可能被终端按宽度 2 渲染,和折行叠加会整列错位。 */
const THUMB = figures.square
const TRACK = '│'
const GUTTER = '│ '
/** 工具返回值那一行的缩进符,和主 REPL 的 MessageResponse 一致。 */
const RESULT_ARROW = '⎿ '

/**
 * 按**显示宽度**折行,不是按码点。
 *
 * 这个功能的内容 99% 是中文。100 个汉字按码点算是「宽度 100」,实际占 200 列 —— 而
 * Ink 的 Text 默认 `wrap`,于是这一行被回流成两个终端行:窗口算出的 height 行实际打印
 * 2×height 行,把边框和下面的内容挤出屏幕;更要命的是滚动条的滑块位置按 total/height 算,
 * 而真实可见行数不是 height,**滚动条指的位置就是错的** —— 它还是窗口唯一的位置指示。
 *
 * 「一条 LogLine = 一个终端行」是这个模块的硬不变量。
 */
export function wrapDisplayWidth(s: string, width: number): string[] {
  if (width <= 0) return [s]
  if (stringWidth(s) <= width) return [s]
  const out: string[] = []
  let cur = ''
  let curW = 0
  // 按码点走,宽度按 stringWidth 累加。一个宽字符放不下就先断行,绝不把它劈成半个。
  for (const ch of s) {
    const w = stringWidth(ch)
    if (curW + w > width) {
      out.push(cur)
      cur = ch
      curW = w
    } else {
      cur += ch
      curW += w
    }
  }
  if (cur.length > 0) out.push(cur)
  return out.length > 0 ? out : ['']
}

/**
 * 按**显示宽度**截断,超出补省略号。
 *
 * 给「标题 + 状态 + 耗时」这类行用:整行交给 truncate-end 的话,从右边吃掉的正好是
 * 状态和耗时 —— 实测 80 列 + 27 字中文标题,`[WAITING_CHILDREN]` 被截成
 * `[WAITING_CHIL…`,耗时整个没了。这个仓库为日志窗表头已经记过一次同样的坑。
 */
export function clipToWidth(s: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = stringWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

/** 右对齐地把左右两段拼进一行;放不下就只留左边(截断由渲染层的 truncate-end 兜)。 */
function justify(left: string, right: string, width: number): string {
  const pad = width - stringWidth(left) - stringWidth(right)
  return pad > 0 ? left + ' '.repeat(pad) + right : `${left} ${right}`
}

function secs(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`
}

/** 一条流的状态短语 + 颜色。 */
function statusOf(s: StreamState, nowMs: number): { text: string; color: LogColor } {
  const end = s.endedAt ?? nowMs
  const dur = secs(end - s.startedAt)
  const tools = s.toolCount > 0 ? ` · ${s.toolCount} 工具` : ''
  if (s.error) return { text: `${figures.cross} 调用失败 · ${dur}`, color: 'error' }
  // 运行中用 ◐,和任务树的 GLYPH.running 是同一个字形 —— 树上和窗口里指同一件事的东西
  // 不该长得不一样。(figures.circleDotted 的 ASCII 退化形是 `( )`,三列宽,会把右对齐
  // 的表头挤歪。)
  if (!s.closed) return { text: `◐ 运行中${tools} · ${dur}`, color: 'warning' }
  return { text: `${BLACK_CIRCLE} 已完成${tools} · ${dur}`, color: 'success' }
}

/** 折叠态那一行:这条流最后在干什么。工具优先 —— 那是用户第一位想看的。 */
export function lastActivity(s: StreamState): string {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i]!
    if (e.kind === 'tool') return `${BLACK_CIRCLE} ${e.brief}`
    if (e.kind === 'result') return `${RESULT_ARROW}${e.brief}`
  }
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i]!
    if (e.kind === 'text') return e.text
  }
  return ''
}

/**
 * 连续的 thinking 合并成一行计数。
 *
 * 实测思考流会把工具调用整个淹掉,而用户第一位要看的是工具。这是定论,所以**不给切换键**
 * —— 一个已经想清楚的问题不该再造一个旋钮和一条测试。
 */
function foldThinking(events: readonly AgentEvent[], expanded: boolean): AgentEvent[] {
  // 展开时原样返回:抽出来的思考原文此前**永远到不了屏幕** —— agentEvents 老老实实按行
  // 抽了、eventLine 还给它准备了 dim 样式,渲染层却在这里把它整体换成一个计数。
  // 而用户的原话是「看到模型…在思考啥」。默认仍然折叠(思考会淹掉工具调用,这条实测
  // 成立),但必须给得出来。
  if (expanded) return [...events]
  const out: AgentEvent[] = []
  let run = 0
  const flush = (): void => {
    if (run > 0) out.push({ kind: 'thinking', text: `${TEARDROP_ASTERISK} 思考 ${run} 段(t 展开)` })
    run = 0
  }
  for (const e of events) {
    if (e.kind === 'thinking') { run++; continue }
    flush()
    out.push(e)
  }
  flush()
  return out
}

interface EventLine { prefix: string; body: string; color: LogColor; dim: boolean }

function eventLine(e: AgentEvent): EventLine {
  switch (e.kind) {
    case 'text': return { prefix: GUTTER, body: e.text, color: undefined, dim: false }
    case 'thinking': return { prefix: GUTTER, body: e.text, color: undefined, dim: true }
    case 'tool': return { prefix: `${GUTTER}${BLACK_CIRCLE} `, body: e.brief, color: 'warning', dim: false }
    case 'result':
      return {
        prefix: `${GUTTER}  ${RESULT_ARROW}`,
        body: e.brief,
        color: e.isError ? 'error' : undefined,
        dim: !e.isError,
      }
  }
}

export interface RenderArgs {
  streams: readonly StreamState[]
  /** 折叠了哪几条流(下标)。 */
  folded: ReadonlySet<number>
  selected: number
  nowMs: number
  /** 内容区宽度(**不含**滚动条那一列)。 */
  width: number
  /** 这个节点的输出属于上一次运行。 */
  historical?: boolean
  /** 哪几条流要展开思考原文(下标)。默认全部折叠成段数。 */
  expandedThinking?: ReadonlySet<number>
}

export function renderStreamLines(args: RenderArgs): LogLine[] {
  const out: LogLine[] = []
  const w = Math.max(10, args.width)

  if (args.historical === true && args.streams.length === 0) {
    // 空 store + 已完成的节点 = 「这个节点什么都没干」,而事实是它上次跑了四十分钟。
    // 残缺的视图不许看起来像完整的视图 —— 这条规矩 NodeDetail 的裁剪已经付过一次学费。
    for (const l of wrapDisplayWidth('本节点的输出属于上一次运行。事件流只存在内存中,不落盘,所以看不到历史。', w)) {
      out.push({ text: l, dim: true, streamIndex: -1 })
    }
    return out
  }

  args.streams.forEach((s, i) => {
    const isFolded = args.folded.has(i)
    const st = statusOf(s, args.nowMs)
    const round = s.meta.round && s.meta.round > 0 ? ` 第${s.meta.round}轮` : ''
    const model = s.meta.model ? ` (${s.meta.model})` : ''
    const left = `${isFolded ? SHUT : OPEN} ${s.meta.phaseLabel}${round} · ${s.meta.label}${model}`
    out.push({
      text: justify(left, st.text, w),
      color: st.color,
      bold: true,
      streamIndex: i,
      isHeader: true,
      selected: i === args.selected,
    })

    if (isFolded) {
      const last = lastActivity(s)
      if (last) {
        out.push({ text: wrapDisplayWidth(`${GUTTER}最新: ${last}`, w)[0]!, dim: true, streamIndex: i })
      }
      return
    }

    if (s.dropped > 0) {
      out.push({ text: `${GUTTER}… 更早的 ${s.dropped} 条已滚出缓冲`, dim: true, streamIndex: i })
    }
    if (s.tombstone === true) {
      out.push({ text: `${GUTTER}… 这一场的窗口已收起,只留最后几条`, dim: true, streamIndex: i })
    }
    for (const e of foldThinking(s.events, args.expandedThinking?.has(i) === true)) {
      const { prefix, body, color, dim } = eventLine(e)
      const avail = Math.max(4, w - stringWidth(prefix))
      // 续行对齐到内容列,并保住左边那根 gutter —— 真实终端就是这么折的。
      const cont = GUTTER + ' '.repeat(Math.max(0, stringWidth(prefix) - stringWidth(GUTTER)))
      wrapDisplayWidth(body, avail).forEach((chunk, k) => {
        out.push({ text: (k === 0 ? prefix : cont) + chunk, color, dim, streamIndex: i })
      })
    }
  })
  return out
}

/**
 * 节点级的「丢了多少」提示。**必须钉在滚动区之外。**
 *
 * 它一开始是当作日志的第一行发出去的,于是被自己的粘底行为埋掉了:窗口默认跟随最新,
 * 第一行早就滚出可视区,用户永远看不到这句话 —— 一个残缺的视图看起来完完整整。这正是
 * 这条提示存在的理由,所以它不能自己也犯同样的毛病。
 *
 * 流内的「滚出缓冲」不同,它属于那条流的开头,跟着滚是对的。
 */
export function droppedNotice(droppedEvents?: number): string | null {
  return (droppedEvents ?? 0) > 0 ? `… 这个节点更早的 ${droppedEvents} 条输出已释放` : null
}

/** 滚动窗口的起点,钳到 [0, total-height]。 */
export function scrollWindow(total: number, height: number, offset: number): { from: number } {
  if (height <= 0 || total <= height) return { from: 0 }
  const max = total - height
  const from = Number.isFinite(offset) ? Math.round(offset) : 0
  return { from: Math.max(0, Math.min(from, max)) }
}

/**
 * 滚动条那一列,每行一个字符。
 *
 * `total <= height` 时整列是空格 —— **不画轨道**。有一根滚动条却怎么也滚不动,会让人以为
 * 界面卡住了。
 */
export function scrollbarColumn(total: number, height: number, from: number): string[] {
  if (height <= 0) return []
  if (total <= height) return Array.from({ length: height }, () => ' ')
  const thumb = Math.max(1, Math.round((height * height) / total))
  const span = height - thumb
  const start = span <= 0 ? 0 : Math.round((from * span) / (total - height))
  return Array.from({ length: height }, (_, i) => (i >= start && i < start + thumb ? THUMB : TRACK))
}

export type PaneAction =
  | { t: 'line'; d: number }
  | { t: 'halfPage'; d: number }
  | { t: 'top' }
  | { t: 'bottom' }
  | { t: 'nextStream' }
  | { t: 'toggleFold' }
  | { t: 'toggleThinking' }

/**
 * 按键 → 动作。
 *
 * **连击会被合批。** parse-keypress 对一个 text token 直接产出一个按键事件,而 token 可以
 * 是多字符:按住 `j` 拿到的是 `'jjj'`。仓库里 ScrollKeybindingHandler 的既定写法就是先判
 * 「是不是同一个字符的连续重复」,TaskTreePanel 今天正因为没判而让按住 j 变成死键。
 * 而「按住 ↓ 一路翻到底」恰恰是日志窗最常用的操作。
 *
 * `G` 要双写:kitty 协议的终端给的是 `input='g', shift=true`,传统终端给 `input='G'`。
 *
 * **刻意不认 Esc / q / 回车** —— 那三个键归详情视图(返回任务树)。两个 useInput 会同时收到
 * 每一个键,不冲突全靠键位不重叠。
 */
export function logPaneAction(input: string, key: Key): PaneAction | null {
  if (key.escape || key.return) return null
  if (key.tab) return { t: 'nextStream' }
  if (key.upArrow) return { t: 'line', d: -1 }
  if (key.downArrow) return { t: 'line', d: 1 }
  // 鼠标滚轮。**能不能收到取决于终端有没有开鼠标追踪**(这个 fork 默认非全屏,不开)——
  // 接上它零成本,开了的场景就能用;没开的场景键盘照旧。不接的话,开了也白开。
  if (key.wheelUp) return { t: 'line', d: -3 }
  if (key.wheelDown) return { t: 'line', d: 3 }
  if (key.pageUp) return { t: 'halfPage', d: -1 }
  if (key.pageDown) return { t: 'halfPage', d: 1 }
  if (key.home) return { t: 'top' }
  if (key.end) return { t: 'bottom' }
  if (key.ctrl && input === 'u') return { t: 'halfPage', d: -1 }
  if (key.ctrl && input === 'd') return { t: 'halfPage', d: 1 }
  if (key.ctrl || key.meta) return null
  if (input === ' ') return { t: 'toggleFold' }
  if (input.length === 0) return null
  // 裸字母:只认「同一个字符的连续重复」,否则那是别的输入被合批带进来的。
  const c = input[0]!
  if (input !== c.repeat(input.length)) return null
  if (c === 'G' || (c === 'g' && key.shift)) return { t: 'bottom' }
  if (c === 'g') return { t: 'top' }
  // j/k 是**非幂等**的,按住多久就滚多远;g/G 幂等,重复多少次都一样。
  // 't' 展开/折叠选中流的思考原文。幂等,所以连击只走一次。
  if (c === 't') return { t: 'toggleThinking' }
  if (c === 'j') return { t: 'line', d: input.length }
  if (c === 'k') return { t: 'line', d: -input.length }
  return null
}

/**
 * 任务树的行预算 —— 运行中的行下面会多挂一条「此刻在调什么工具」。
 *
 * 逐行结算,不是先按运行中节点数减一个常数。设计稿第一版写的是
 * `height - min(runningRows, height/3)`,评审给出的反例是:height=20、全部节点在跑时
 * 预算 14,而那 14 行**全是运行中的**,实打印 28 行,超 8 行;反方向,切片里一个运行中
 * 的都没有时照样白扣 6 行,树永久少显示 6 个节点。
 *
 * @param cost 每一行占几个终端行(运行中且有活动 = 2)
 * @returns 从 from 开始能画几行
 */
export function budgetRows(cost: readonly number[], from: number, height: number): number {
  if (height <= 0) return 0
  let used = 0
  let n = 0
  for (let i = Math.max(0, from); i < cost.length; i++) {
    const c = Math.max(1, cost[i] ?? 1)
    if (used + c > height) break
    used += c
    n++
  }
  // 至少画一行:否则一个「运行中 + 活动行」的节点在 height=1 时会让树整个空掉。
  return Math.max(1, n)
}

/**
 * 视口的锚。
 *
 * **不是绝对行号。** 这是用户报出来的:「切到某个阶段,上下键却在展示正在执行的那个
 * 子 agent 的数据」。根因是偏移量记的是行号,而**行号上方的内容一直在变**:
 *
 *  - 一条流跑完就从「运行中(展开)」变成「已收口(折叠)」,它那几十行当场塌掉;
 *  - 新阶段开一条新流,又在别处插进一段。
 *
 * 于是同一个行号,一秒之前指着「分析」的输出,一秒之后指着正在跑的「执行」——用户没动
 * 过键,画面自己跳了;他再按上下键,就是在滚那条正在跑的流。
 *
 * 钉在**选中的流**上就没有这个问题:那一段自己塌了或长了,锚跟着走;别处怎么变都与它无关。
 * 这也正好是用户要的语义——**切换到哪,展示哪**。
 */
export interface LogAnchor {
  /** 锚在第几条流的表头上。 */
  stream: number
  /** 从那条表头往下偏移几行(负数 = 往上,能看到前一条流的尾巴)。 */
  delta: number
}

/**
 * 把锚解算成这一帧的起始行号。
 *
 * @param headerAt 第 i 条流的表头在 lines 里的下标;-1 表示这条流当前没有表头行
 *                 (它被上游过滤掉了,或者流列表刚变短)
 */
export function anchoredFrom(
  total: number, height: number, anchor: LogAnchor, headerAt: (i: number) => number,
): number {
  const maxFrom = Math.max(0, total - height)
  const at = headerAt(anchor.stream)
  // 锚指向的流不见了(流被淘汰/列表变短):退回顶部而不是底部。
  // 退到底部的话,用户会正好落在那条一直在动的运行流上——就是他抱怨的那个现象。
  if (at < 0) return 0
  return Math.max(0, Math.min(maxFrom, at + anchor.delta))
}
