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

/**
 * 一个终端行。**两个页卡共用**的最小单位。
 *
 * 「一条 ViewLine = 一个终端行」是这一层的硬不变量,而它不是洁癖:详情页做成满屏之后,
 * 一个带 `height` 的 Box 里,超量的子节点会被 yoga **按比例压缩**,不是被裁掉 ——
 * 实测 50 行塞进 10 行的框,拿到的是 `L004,L009,L014,…`(每 5 行采样 1 行),而且标题行
 * 本身也一起消失。也就是说:一个残缺的视图看起来完完整整。
 *
 * 所以行数必须由**我们自己**算准、自己切片,`height` 只当最后一道保险。而要算得准,
 * 前提就是每一条数据结构上只对应一个终端行。
 */
export interface ViewLine {
  text: string
  color?: LogColor
  dim?: boolean
  bold?: boolean
  /** 反显。选中的流表头、选中的段落标题。 */
  inverse?: boolean
}

export interface LogLine extends ViewLine {
  /** 属于第几条流。-1 = 全局提示行。 */
  streamIndex: number
  isHeader?: boolean
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

/**
 * 单次工具调用的耗时。表头那个 `secs()` 量的是整场,秒级够用;这里量的是一次调用,
 * 而一次 Read 常常是几十毫秒 —— 全都渲染成 `0s` 的话,这个数字就等于没有。
 *
 * 三档:亚秒给毫秒、一分钟内给一位小数、再长给分秒。
 */
export function formatDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${s % 60}s`
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

/**
 * @param showOwner 这条返回的**上一行不是它自己的那次调用** —— 要把归属写出来。
 */
function eventLine(e: AgentEvent, showOwner = false): EventLine {
  switch (e.kind) {
    case 'text': return { prefix: GUTTER, body: e.text, color: undefined, dim: false }
    case 'thinking': return { prefix: GUTTER, body: e.text, color: undefined, dim: true }
    case 'tool': return { prefix: `${GUTTER}${BLACK_CIRCLE} `, body: e.brief, color: 'warning', dim: false }
    case 'result': {
      /**
       * 归属和耗时放在 body 的**开头**,不是结尾,也不进 prefix。
       *
       *  - 放结尾:body 会被 wrapDisplayWidth 折行,耗时会掉到续行上,而续行看起来
       *    像是返回内容的一部分。
       *  - 放 prefix:prefix 的宽度决定续行缩进(见 renderStreamLines 里的 cont),
       *    一条长归属会把整段返回挤成一条窄缝。
       */
      const dur = e.durMs === undefined ? '' : formatDur(e.durMs)
      const head = [showOwner ? e.ofBrief : '', dur].filter(x => x !== undefined && x !== '')
      return {
        prefix: `${GUTTER}  ${RESULT_ARROW}`,
        body: head.length > 0 ? `${head.join(' · ')} · ${e.brief}` : e.brief,
        color: e.isError ? 'error' : undefined,
        dim: !e.isError,
      }
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
      inverse: i === args.selected,
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
    /**
     * 上一条渲染出来的事件,当且仅当它是一次工具调用。
     *
     * `⎿` 在终端里的公认语义是「**上一行**的返回」。并行工具调用下,返回是按到达顺序
     * 到的,和调用顺序对不上 —— 实测两个 MCP 调用之后连着两条 `⎿`,第一条画在第二个
     * 工具那行底下,而它其实是第一个工具的返回。事件里明明带着 useId,却一次都没用过。
     *
     * 非工具事件要把它清空:中间隔了一段文本的话,`⎿` 就已经不是「上一行的返回」了。
     */
    let prevTool: Extract<AgentEvent, { kind: 'tool' }> | null = null
    for (const e of foldThinking(s.events, args.expandedThinking?.has(i) === true)) {
      // 空 useId(provider 没给 id)时只能靠位置判断:上一行就是工具调用就认它。
      // 这和 agentStream 的先进先出配对是同一条假设,串行调用下永远成立。
      const showOwner = e.kind === 'result' && e.ofBrief !== undefined && !(
        prevTool !== null && (e.useId.length > 0 ? prevTool.useId === e.useId : true)
      )
      const { prefix, body, color, dim } = eventLine(e, showOwner)
      prevTool = e.kind === 'tool' ? e : null
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
 * 详情页的版面算术。**纯函数,单独钉。**
 *
 * 抽出来不是洁癖:内容区是 `flexGrow` + `overflow:hidden`,所以这里少算一行的后果
 * **不是**画面溢出,而是**静默少画一行** —— 变异测试实测,把 chrome 减 1、或者不给
 * 「↓ 下面还有 N 行」预留位置,整套渲染断言一条都不红。算错了没人告诉你,正是这个仓库
 * 反复付学费的形状。
 *
 * @param budget    这一屏一共能用多少个终端行(调用方声明)
 * @param columns   可用列宽
 * @param inModal   是不是画在 FullscreenLayout 的 modal 槽里(那里不需要自己的边框)
 */
export function detailLayout(args: { budget: number; columns: number; inModal: boolean }): {
  /** 内容区(两个页卡共用)有多少行。 */
  contentRows: number
  /** 内容区里真正铺行的高度 —— 比 contentRows 少一行,留给「↓ 下面还有 N 行」。 */
  paneRows: number
  /** 内容区列宽(含滚动条那一列)。 */
  contentWidth: number
} {
  const budget = Math.max(10, Math.floor(args.budget))
  // 标题 1 + 元信息 1 + 页签条 1 + 页脚 1(+ 非模态下自己那圈边框 2)。
  const chrome = 4 + (args.inModal ? 0 : 2)
  const contentRows = Math.max(3, budget - chrome)
  return {
    contentRows,
    paneRows: Math.max(2, contentRows - 1),
    // paddingX={1} 吃掉 2 列;非模态下边框再吃 2 列。
    contentWidth: Math.max(24, Math.floor(args.columns) - (args.inModal ? 2 : 4)),
  }
}

/** 详情页「任务」页卡里的一段。空 body 的段落由调用方过滤掉 —— 选中一个空段是死格。 */
export interface SectionSpec {
  title: string
  body: string
  color?: LogColor
  /** 未展开时这一段留几行。省略则用 `collapsedLines`。 */
  maxLines?: number
}

/**
 * 展开一段之后最多铺多少行。
 *
 * 有滚动之后本来可以不设上限,但 `execStatus` 是**逐轮追加**的(每次返工都往后写),
 * 单字段上限 8000 字乘上返工轮数并没有硬顶。留一个很大的数,超了照样用「中间省略 N 行」
 * 兑现 —— 不假装那是全部。
 */
export const EXPANDED_MAX_LINES = 2000

/**
 * 一段正文 → 若干终端行,超量时**掐头留尾**。
 *
 * 留尾是有来历的:这个功能里每一轮追加的内容都追加在**末尾**(执行状态后面会长出
 * 「(合并冲突解决)…」,验收记录后面长出最新一轮裁决)。只留头的话,三份验收都量到过
 * 同一件事 —— 屏幕上最后一行还写着「自测全绿」,而把节点挡下来的那条拒绝理由被裁掉了,
 * 在整个 TUI 里再也找不到。
 */
function bodyLines(body: string, width: number, maxLines: number): { lines: string[]; total: number } {
  // **按显示宽度折行,不是按码点。** 老的 block() 写死 `width = 100` 并按码点判断,
  // 于是 100 个汉字(=200 列)被判成「不用折」,交给 Text 默认的 wrap 回流成两三个终端行。
  // 实测同一份内容,中文比 ASCII 多出 24 行 —— 行预算是假的,而且 80 列和 100 列的终端
  // 算出来一模一样(列宽根本没参与)。
  const wrapped = body.split('\n').flatMap(l => wrapDisplayWidth(l, width))
  const total = wrapped.length
  const cap = Math.max(1, Math.floor(maxLines))
  if (total <= cap) return { lines: wrapped, total }
  /**
   * 「中间省略 N 行」**自己也占一行**,所以它要从预算里扣。
   *
   * 老的 block() 没扣,产出的是 `maxLines + 1` 行 —— 那时候没人按行算总高,所以看不出来;
   * 现在两个页卡的高度都是精确算出来的,多一行就会把最底下的页签条顶出屏幕。
   *
   * 尾巴优先于头:每一轮追加的内容都追加在**末尾**,只留头的话,把节点挡下来的那条
   * 拒绝理由在整个 TUI 里都找不到(三份验收量到过同一件事)。
   */
  if (cap <= 1) return { lines: [`… 共 ${total} 行,这里放不下`], total }
  const tail = Math.min(2, cap - 2 >= 1 ? cap - 2 : 1)
  const head = Math.max(0, cap - 1 - tail)
  return {
    // 省略的行数按**真实**留下的算,不是 total - cap —— 那个数会少报一行,
    // 而这一行字的全部意义就是把这个数说准。
    lines: [...wrapped.slice(0, head), `… 中间省略 ${total - head - tail} 行`, ...wrapped.slice(total - tail)],
    total,
  }
}

/**
 * 「任务」页卡的段落 → 行数组 + 每段标题行的下标。
 *
 * 和 `renderStreamLines` 并列:两个页卡各有一个「产行」函数,下游(切片、滚动条、
 * 逐行渲染)完全共用。新增第三个页卡只需要再写一个这样的函数。
 *
 * @returns headerAt 第 i 段的标题行在 lines 里的下标(-1 = 不存在)。直接喂给 `anchoredFrom`
 *          当锚 —— 展开/收起一段会让它下面所有行的行号整体位移,锚在绝对行号上会当场跳走。
 */
export function sectionLines(args: {
  sections: readonly SectionSpec[]
  /** 光标停在第几段。-1 = 没有光标(只读)。 */
  cursor: number
  /** 展开了哪几段(按标题)。 */
  expanded: ReadonlySet<string>
  /** 内容区列宽(**不含**滚动条那一列)。 */
  width: number
  /** 未展开的段落默认留几行。 */
  collapsedLines: number
}): { lines: ViewLine[]; headerAt: (i: number) => number } {
  const w = Math.max(10, args.width)
  // 正文缩进 4 列,和这个页面原来的排版一致。
  const bodyWidth = Math.max(6, w - 4)
  const lines: ViewLine[] = []
  const headers: number[] = []
  args.sections.forEach((sec, i) => {
    const isExpanded = args.expanded.has(sec.title)
    const selected = i === args.cursor
    const { lines: body, total } = bodyLines(
      sec.body.trim(),
      bodyWidth,
      isExpanded ? EXPANDED_MAX_LINES : (sec.maxLines ?? args.collapsedLines),
    )
    const clipped = body.length < total
    const hint = isExpanded ? '(空格收起)' : clipped ? `(空格展开,共 ${total} 行)` : ''
    headers.push(lines.length)
    lines.push({
      text: clipToWidth(`${selected ? '❯ ' : '  '}${sec.title}${hint}`, w),
      bold: true,
      color: sec.color ?? (selected ? 'success' : undefined),
      inverse: selected,
    })
    for (const l of body) lines.push({ text: `    ${l}`, color: sec.color, dim: sec.color === undefined })
  })
  return { lines, headerAt: i => headers[i] ?? -1 }
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
  // Tab 让给**区切换**(段落区 ⇄ 输出区)——详情页原来整个键盘归这里,
  // 用户因此没有任何办法把焦点移到上面的段落上。切流改用 n。
  if (key.tab) return null
  if (input === 'n' || input === 'N') return { t: 'nextStream' }
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

/**
 * 运行中的人工干预键。
 *
 * 抽成纯函数和 redoGateAction 同一个理由:面板的按键处理没有别的接缝,而这几个键的
 * 后果一个比一个重(取消一个正在改代码的节点、把整轮暂停下来)。
 *
 * **只在运行中生效**,而且都挑了不与既有键冲突的字母:
 *  - p/P:暂停 / 恢复调度(在飞的调用不打断)
 *  - i/I:追加一句指令(作用于之后派发的提示词)
 *  - x/X:取消**光标选中**的那一个节点
 *
 * 大小写都收:用户按住 shift 打字是常事,而一个「按了没反应」的键比没有这个键更糟。
 */
export type RunControlKey = 'togglePause' | 'addDirective' | 'cancelNode'

export function runControlAction(input: string, key: { ctrl?: boolean; meta?: boolean }): RunControlKey | null {
  // 组合键归终端和 REPL,别抢。
  if (key.ctrl || key.meta) return null
  if (input.length === 0) return null
  const c = input[0]!
  // 只认「同一个字符的连续重复」——否则那是别的输入被合批带进来的(和 logPaneAction 同因)。
  if (input !== c.repeat(input.length)) return null
  const k = c.toLowerCase()
  if (k === 'p') return 'togglePause'
  if (k === 'i') return 'addDirective'
  if (k === 'x') return 'cancelNode'
  return null
}

/**
 * 任务详情页的**段落区**按键。
 *
 * 用户的原话:「任务详情里的目标、完整方案、重点、风险点、验收点等等各个可以通过空格
 * 展开看详细信息,但是可以通过 Tab 先切到上面吧,或者上下键等。」
 *
 * 在这之前详情页的键盘**整个归日志窗** —— 段落只能看被裁到十几行的头尾,没有任何办法
 * 展开其中一段。所以这里引入两个区:
 *
 *  - **段落区**:↑↓ / jk 选段落,空格展开或收起选中那一段
 *  - **输出区**:原来那套(滚动、折叠、切流)
 *  - **Tab** 在两个区之间切
 *
 * Tab 原来是「切到下一条流」,现在让给区切换,切流改用 `n`。这是有代价的改动,但两个区
 * 之间没有别的自然键可用,而「切不过去」正是用户报的问题本身。
 */
export type SectionPaneAction =
  | { t: 'move'; d: number }
  | { t: 'toggle' }
  /** Tab / Shift+Tab:在 页签条 ⇄ 内容区 之间轮转。 */
  | { t: 'switchZone'; d: number }
  /** ←/→:切页卡。**在详情页里这两个键原来是死键**,零冲突白捡。 */
  | { t: 'tab'; d: number }
  /** 半页滚动。ctrl+u / ctrl+d,以及 PgUp/PgDn(收到就用,收不到也不写进页脚)。 */
  | { t: 'scroll'; d: number }

/**
 * 任务详情页**内容区之外**的按键。
 *
 * 详情页同时挂着三个 `useInput`,而 vendored 的 `useInput` 是**广播**的、不做
 * stopPropagation(`AgentLogPane` 文件头有原话)—— 不冲突全靠键位不重叠 + 各自判 zone。
 * 这里认的每一个键都对照过另外两处:
 *  - `←/→`:`logPaneAction` 不认左右箭头;`TaskTreePanel` 的 detail 分支直接 return。空的。
 *  - `Tab`:`logPaneAction` 第三行就是 `if (key.tab) return null`,专门让给这里。
 *  - `ctrl+u/d`、`PgUp/PgDn`:只在 zone 不是 log 时由调用方派发,和 `logPaneAction` 互斥。
 *
 * **回车不在这里。** 它归 `TaskTreePanel`(返回任务树),只有焦点落在页签条上时才让路 ——
 * 而那一让也必须由 TaskTreePanel 自己做:`useInput` 的 listener 槽位按 mount 时刻固定,
 * TaskTreePanel 比 NodeDetail 先挂,所以它**永远先跑**,在 NodeDetail 里调
 * stopImmediatePropagation 已经来不及了。
 */
export function sectionPaneAction(
  input: string,
  key: {
    tab?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean
    pageUp?: boolean; pageDown?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean
  },
): SectionPaneAction | null {
  if (key.tab) return { t: 'switchZone', d: key.shift === true ? -1 : 1 }
  if (key.leftArrow) return { t: 'tab', d: -1 }
  if (key.rightArrow) return { t: 'tab', d: 1 }
  if (key.pageUp) return { t: 'scroll', d: -1 }
  if (key.pageDown) return { t: 'scroll', d: 1 }
  if (key.ctrl && input === 'u') return { t: 'scroll', d: -1 }
  if (key.ctrl && input === 'd') return { t: 'scroll', d: 1 }
  if (key.ctrl || key.meta) return null
  if (key.upArrow) return { t: 'move', d: -1 }
  if (key.downArrow) return { t: 'move', d: 1 }
  if (input === ' ') return { t: 'toggle' }
  if (input.length === 0) return null
  const c = input[0]!
  // 和 logPaneAction 同一条规矩:只认同一字符的连续重复,否则那是合批带进来的别的输入。
  if (input !== c.repeat(input.length)) return null
  if (c === 'j') return { t: 'move', d: input.length }
  if (c === 'k') return { t: 'move', d: -input.length }
  return null
}

/**
 * 焦点在哪 → 段落区该不该画光标 / 哪个页签该反显。
 *
 * 两个都是一行表达式,抽出来是因为**它们在组件里根本观测不到**:这个渲染器只写增量,
 * 一次焦点切换在帧里是几个分散的片段,而 `lastFrame()` 又把转义换成空格,连
 * 「有没有反显」都看不出来。而它们说的是同一件事 —— **别画一个「选中了、但按键不归它」
 * 的假象**,那正是这个仓库反复付学费的那类谎。
 */
export function sectionCursor(
  zone: 'tabs' | 'content',
  activeTabIsTask: boolean,
  cursor: number,
): number {
  // -1 = 不画光标。焦点在页签条上、或者当前是别的页卡时,段落上那个 ❯ 就是假的。
  return zone === 'content' && activeTabIsTask ? cursor : -1
}

/** 这个页签该不该反显 —— 只有「焦点在页签条上」且「它就是当前页卡」时才反显。 */
export function tabFocused(zone: 'tabs' | 'content', isActiveTab: boolean): boolean {
  return zone === 'tabs' && isActiveTab
}

/**
 * 鼠标点击到底能不能用。
 *
 * 三道闸门,少判一道就会在页脚上写一句假话,而「一个按了没反应的键比没有更糟」是这个
 * 仓库反复付过学费的那条:
 *  - 非全屏:终端根本没被要求上报鼠标(`ENABLE_MOUSE_TRACKING` 只在 AlternateScreen 里写出),
 *    而且 `Ink.dispatchClick` 第一句就是 `if (!this.altScreenActive) return false`;
 *  - `CLAUDE_CODE_DISABLE_MOUSE=1`:全屏但不开追踪;
 *  - `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`:开追踪但吞掉点击(滚轮仍然有效)。
 *
 * env 由调用方注入 —— 纯函数才测得动,而这三个开关的组合正是最容易写错的地方。
 */
export type MouseAvailability = 'on' | 'needs-fullscreen' | 'tracking-disabled' | 'clicks-disabled'

export function mouseAvailability(env: {
  fullscreen: boolean
  tracking: boolean
  clicks: boolean
}): MouseAvailability {
  if (!env.fullscreen) return 'needs-fullscreen'
  if (!env.tracking) return 'tracking-disabled'
  if (!env.clicks) return 'clicks-disabled'
  return 'on'
}

/**
 * 任务树页脚里「怎么进详情页」那半句。
 *
 * 能点才说能点。不能点时**一个字都不多写** —— 那一行是 truncate-end 的,多塞一句
 * 「需要开全屏」会把右边的 `Esc/q 退出` 直接吃掉,等于用「解释一个用不了的功能」
 * 换掉「怎么退出去」。为什么点不了,由详情页页签条右侧那个专门的位置来说。
 */
export function detailEntryHint(a: MouseAvailability): string {
  return a === 'on' ? '回车/点击看详情' : '回车看详情'
}

/** 页脚里那半句话。可用时说「或点击」,不可用时说清为什么,而不是闭口不提。 */
export function mouseHint(a: MouseAvailability): string {
  switch (a) {
    case 'on': return '鼠标点击'
    case 'needs-fullscreen': return '鼠标需全屏模式(CLAUDE_CODE_NO_FLICKER=1)'
    case 'tracking-disabled': return '鼠标被 CLAUDE_CODE_DISABLE_MOUSE 关掉了'
    case 'clicks-disabled': return '点击被 CLAUDE_CODE_DISABLE_MOUSE_CLICKS 关掉了'
  }
}
