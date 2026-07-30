import { describe, expect, it } from 'bun:test'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { AgentEvent } from '../../tools/efftask/agentEvents.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import { runControlAction,
  foldedStreams,
  logPaneMode,
  budgetRows,
  lastActivity,
  logPaneAction,
  renderStreamLines,
  scrollbarColumn,
  scrollWindow,
  droppedNotice,
  wrapDisplayWidth,
  formatDur,
  sectionLines,
  sectionPaneAction,
  mouseAvailability,
  mouseHint,
  detailEntryHint,
  EXPANDED_MAX_LINES,
  detailLayout,
  MIN_DETAIL_WIDTH,
  collapsedLinesFor,
  sectionCursor,
  tabFocused,
  type LogLine,
} from './logView.js'

const key = (over: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
  home: false, end: false, return: false, escape: false, ctrl: false,
  shift: false, fn: false, tab: false, backspace: false, delete: false,
  meta: false, super: false, ...over,
})

let seq = 0
const stream = (over: Partial<StreamState> = {}): StreamState => ({
  meta: { nodeId: 'n', phaseLabel: '执行', label: '甲员工' },
  events: [],
  dropped: 0,
  toolCount: 0,
  startedAt: 1000,
  closed: false,
  seq: seq++,
  ...over,
})

const text = (t: string): AgentEvent => ({ kind: 'text', text: t })
const think = (t: string): AgentEvent => ({ kind: 'thinking', text: t })
const tool = (n: string, b: string): AgentEvent => ({ kind: 'tool', useId: n, name: n, brief: b })
const result = (b: string, isError = false): AgentEvent => ({ kind: 'result', useId: 'x', brief: b, isError })
const resultOf = (useId: string, b: string, durMs?: number, ofBrief?: string): AgentEvent =>
  ({ kind: 'result', useId, brief: b, isError: false, durMs, ofBrief })

const render = (over: Partial<Parameters<typeof renderStreamLines>[0]> = {}): LogLine[] =>
  renderStreamLines({ streams: [], folded: new Set(), selected: -1, nowMs: 5000, width: 60, ...over })
const plain = (ls: LogLine[]): string[] => ls.map(l => l.text)

describe('wrapDisplayWidth —— 按显示宽度,不是按码点', () => {
  it('中文按两列算', () => {
    // 按码点折的话这 15 个汉字算「宽度 15」,放得下 width=20,于是只出一行 —— 而它实际
    // 占 30 列,Ink 会把它回流成两个终端行。窗口算出的 height 就全错了,滚动条指的位置
    // 也跟着错。
    const out = wrapDisplayWidth('一二三四五六七八九十甲乙丙丁戊', 20)
    expect(out).toHaveLength(2)
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(20)
  })

  it('ASCII 按一列算', () => {
    expect(wrapDisplayWidth('abcdefghij', 20)).toEqual(['abcdefghij'])
    expect(wrapDisplayWidth('a'.repeat(25), 10)).toHaveLength(3)
  })

  it('放得下就原样返回', () => {
    expect(wrapDisplayWidth('短', 10)).toEqual(['短'])
  })

  it('宽字符不会被劈成半个', () => {
    for (const l of wrapDisplayWidth('中'.repeat(11), 7)) {
      expect(stringWidth(l)).toBeLessThanOrEqual(7)
    }
  })

  it('width 非正时不死循环', () => {
    expect(wrapDisplayWidth('abc', 0)).toEqual(['abc'])
    expect(wrapDisplayWidth('abc', -5)).toEqual(['abc'])
  })
})

describe('renderStreamLines', () => {
  it('每条流一个带署名的表头', () => {
    const ls = render({
      streams: [
        stream({ meta: { nodeId: 'n', phaseLabel: '质疑讨论', label: '甲员工', model: 'opus', round: 2 } }),
        stream({ meta: { nodeId: 'n', phaseLabel: '质疑讨论', label: '乙员工', model: 'sonnet', round: 2 } }),
      ],
      width: 70,
    })
    const heads = ls.filter(l => l.isHeader)
    expect(heads).toHaveLength(2)
    expect(heads[0]!.text).toContain('甲员工')
    expect(heads[0]!.text).toContain('opus')
    expect(heads[0]!.text).toContain('第2轮')
    expect(heads[1]!.text).toContain('乙员工')
  })

  it('运行中 / 已完成 / 失败三种状态,颜色不同', () => {
    const ls = render({
      streams: [
        stream({ closed: false }),
        stream({ closed: true, endedAt: 4000 }),
        stream({ closed: true, endedAt: 4000, error: '角色调用失败: 401' }),
      ],
      width: 70,
    })
    const heads = ls.filter(l => l.isHeader)
    expect(heads[0]!.color).toBe('warning')
    expect(heads[0]!.text).toContain('运行中')
    expect(heads[1]!.color).toBe('success')
    expect(heads[1]!.text).toContain('已完成')
    expect(heads[2]!.color).toBe('error')
    expect(heads[2]!.text).toContain('调用失败')
  })

  it('耗时:活流走 nowMs,收口的流冻在 endedAt', () => {
    const ls = render({
      streams: [stream({ closed: false }), stream({ closed: true, endedAt: 3000 })],
      nowMs: 9000,
      width: 70,
    })
    const heads = ls.filter(l => l.isHeader)
    expect(heads[0]!.text).toContain('8s')
    expect(heads[1]!.text).toContain('2s')
  })

  it('工具调用、思考、返回值各有前缀,报错的返回值是 error 色', () => {
    const ls = render({
      streams: [stream({ events: [text('我先读一下'), tool('Read', 'Read(a.ts)'), result('2000 行'), result('找不到文件', true)] })],
      width: 60,
    })
    const body = ls.filter(l => !l.isHeader)
    expect(body[0]!.text).toContain('我先读一下')
    expect(body[1]!.text).toContain('Read(a.ts)')
    expect(body[1]!.color).toBe('warning')
    expect(body[2]!.text).toContain('⎿')
    expect(body[2]!.dim).toBe(true)
    expect(body[3]!.color).toBe('error')
    expect(body[3]!.dim).toBe(false)
  })

  it('连续思考合并成一行计数,不逐段刷屏', () => {
    // 实测思考流会把工具调用整个淹掉,而用户第一位要看的是工具。
    const ls = render({
      streams: [stream({ events: [think('a'), think('b'), think('c'), tool('Bash', 'Bash(x)'), think('d')] })],
      width: 60,
    })
    const body = plain(ls.filter(l => !l.isHeader))
    expect(body.filter(t => t.includes('思考 3 段'))).toHaveLength(1)
    expect(body.filter(t => t.includes('思考 1 段'))).toHaveLength(1)
    expect(body.filter(t => t.includes('Bash(x)'))).toHaveLength(1)
    expect(body).toHaveLength(3)
  })

  it('折叠只留表头 + 一行「最新」', () => {
    const s = stream({ events: [text('说了很多'), tool('Grep', 'Grep(onChunk)'), text('还在说')] })
    const ls = render({ streams: [s], folded: new Set([0]), width: 60 })
    expect(ls).toHaveLength(2)
    expect(ls[0]!.isHeader).toBe(true)
    expect(ls[1]!.text).toContain('最新')
    expect(ls[1]!.text).toContain('Grep(onChunk)')
  })

  it('折叠和展开的三角必须不一样 —— 那是「还有内容被收着」的唯一提示', () => {
    const s = [stream(), stream()]
    const ls = render({ streams: s, folded: new Set([1]), width: 60 })
    const heads = ls.filter(l => l.isHeader)
    const openGlyph = heads[0]!.text[0]
    const shutGlyph = heads[1]!.text[0]
    expect(`展开=${openGlyph} 折叠=${shutGlyph} 相同=${openGlyph === shutGlyph}`)
      .toBe(`展开=${openGlyph} 折叠=${shutGlyph} 相同=false`)
  })

  it('表头报工具调用次数 —— 「它到底干了多少活」是折叠态唯一的量', () => {
    const ls = render({ streams: [stream({ toolCount: 12 })], width: 70 })
    expect(ls[0]!.text).toContain('12 工具')
    const none = render({ streams: [stream({ toolCount: 0 })], width: 70 })
    expect(none[0]!.text).not.toContain('工具')
  })

  it('折叠一条不影响另一条展开', () => {
    // 折叠态**仍然**留一行「最新」,所以拿最后一句话做否定断言是空的 —— 它照样在。
    // 要断言的是被折起来的那些**早先**的行不见了。
    const a = stream({ events: [text('甲的开场白'), text('甲的最后一句')] })
    const b = stream({ events: [text('乙的开场白'), text('乙的最后一句')] })
    const ls = render({ streams: [a, b], folded: new Set([0]), width: 60 })
    expect(plain(ls).some(t => t.includes('甲的开场白'))).toBe(false)
    expect(plain(ls).some(t => t.includes('甲的最后一句'))).toBe(true) // 「最新: 」那一行
    expect(plain(ls).some(t => t.includes('乙的开场白'))).toBe(true)
  })

  it('选中的表头带标记', () => {
    const ls = render({ streams: [stream(), stream()], selected: 1, width: 60 })
    const heads = ls.filter(l => l.isHeader)
    expect(heads[0]!.inverse).toBe(false)
    expect(heads[1]!.inverse).toBe(true)
  })

  it('流内的「滚出缓冲」跟着那条流走', () => {
    const ls = render({ streams: [stream({ dropped: 42, events: [text('还剩这些')] })], width: 60 })
    expect(plain(ls).join('\n')).toContain('42')
  })

  it('节点级的「已释放」不进滚动区 —— 它会被粘底行为直接埋掉', () => {
    // 这条提示的全部意义是「你看到的不是全部」。把它当日志第一行发出去,而窗口默认跟随
    // 最新,它就永远滚在可视区之外 —— 一个残缺的视图看起来完完整整,正好犯了它要防的病。
    const ls = render({ streams: [stream({ events: [text('x')] })], width: 60 })
    expect(plain(ls).join('\n')).not.toContain('已释放')
    expect(droppedNotice(300)).toContain('300')
    expect(droppedNotice(0)).toBeNull()
    expect(droppedNotice(undefined)).toBeNull()
  })

  it('墓碑流说明自己被收起过', () => {
    const ls = render({ streams: [stream({ tombstone: true, closed: true, endedAt: 2000, events: [text('尾巴')] })], width: 60 })
    expect(plain(ls).join('\n')).toContain('已收起')
  })

  it('resume 的历史节点说实话,不渲染成「什么都没干」', () => {
    const ls = render({ streams: [], historical: true, width: 60 })
    const all = plain(ls).join('')
    expect(all).toContain('上一次运行')
    expect(all).toContain('不落盘')
  })

  it('历史节点一旦有了新流,就按正常窗口渲染', () => {
    // reseat 重开的节点会从当前环节开始产生新流。这时再说「看不到历史」就把新输出盖住了。
    const ls = render({ streams: [stream({ events: [text('这一轮新跑的') ] })], historical: true, width: 60 })
    expect(plain(ls).join('\n')).toContain('这一轮新跑的')
  })

  it('每一行都不超过给定宽度 —— 一条 LogLine 必须是一个终端行', () => {
    const long = '这是一段很长的中文输出'.repeat(12)
    const ls = render({
      streams: [stream({ events: [text(long), tool('Bash', long), result(long)] })],
      width: 48,
    })
    for (const l of ls) expect(stringWidth(l.text)).toBeLessThanOrEqual(48)
  })

  it('折行的续行对齐到内容列,并保住左边那根竖线', () => {
    const ls = render({ streams: [stream({ events: [tool('Bash', 'x'.repeat(120))] })], width: 40 })
    const body = ls.filter(l => !l.isHeader)
    expect(body.length).toBeGreaterThan(1)
    for (const l of body) expect(l.text.startsWith('│')).toBe(true)
    // 第二行不能再出现那个工具圆点 —— 否则读起来像调了两次
    expect(body[1]!.text).not.toContain('●')
    expect(body[1]!.text).not.toContain('⏺')
  })
})

describe('lastActivity', () => {
  it('工具优先于文字', () => {
    expect(lastActivity(stream({ events: [tool('Read', 'Read(a)'), text('后来说的话')] }))).toContain('Read(a)')
  })
  it('取**最后**一个工具,不是第一个 —— 折叠态问的是「此刻在干什么」', () => {
    // 只放一个工具事件的话,「取最早」和「取最新」产出相同,探针是空的。
    const s = stream({ events: [tool('Read', 'Read(旧的)'), text('中间说了话'), tool('Bash', 'Bash(新的)')] })
    expect(lastActivity(s)).toContain('Bash(新的)')
    expect(lastActivity(s)).not.toContain('旧的')
  })
  it('没有工具就用最后一句话', () => {
    expect(lastActivity(stream({ events: [text('只说了话')] }))).toBe('只说了话')
  })
  it('什么都没有就是空', () => {
    expect(lastActivity(stream())).toBe('')
  })
})

describe('scrollWindow', () => {
  it('内容装得下就恒为 0', () => {
    expect(scrollWindow(5, 10, 3).from).toBe(0)
    expect(scrollWindow(10, 10, 99).from).toBe(0)
  })
  it('钳在 [0, total-height]', () => {
    expect(scrollWindow(100, 10, -5).from).toBe(0)
    expect(scrollWindow(100, 10, 999).from).toBe(90)
    expect(scrollWindow(100, 10, 42).from).toBe(42)
  })
  it('非法输入不产出 NaN', () => {
    expect(scrollWindow(100, 10, Number.NaN).from).toBe(0)
    expect(scrollWindow(100, 0, 5).from).toBe(0)
  })
})

describe('scrollbarColumn', () => {
  it('滚不动的时候不画轨道 —— 有滚动条却滚不动会让人以为卡住了', () => {
    expect(scrollbarColumn(5, 10, 0).join('')).toBe(' '.repeat(10))
  })
  it('滑块长度反映可见比例', () => {
    const col = scrollbarColumn(100, 10, 0)
    expect(col).toHaveLength(10)
    expect(col.filter(c => c !== '│')).toHaveLength(1) // 10*10/100 = 1
    const half = scrollbarColumn(20, 10, 0)
    expect(half.filter(c => c !== '│')).toHaveLength(5)
  })
  it('滑块位置跟着 from 走:顶部在头,底部在尾', () => {
    const top = scrollbarColumn(100, 10, 0)
    const bottom = scrollbarColumn(100, 10, 90)
    expect(top[0]).not.toBe('│')
    expect(top[9]).toBe('│')
    expect(bottom[9]).not.toBe('│')
    expect(bottom[0]).toBe('│')
  })
  it('height 为 0 时是空数组', () => {
    expect(scrollbarColumn(100, 0, 0)).toEqual([])
  })
})

describe('折叠状态决定 ↑↓ 归谁', () => {
  const s = (closed: boolean) => ({ closed })

  it('默认按流自己的状态走:运行中展开、已收口折叠', () => {
    expect([...foldedStreams([s(false), s(true), s(false)], new Map())]).toEqual([1])
  })

  it('用户显式改过的按他改的走 —— 包括「把一条跑完的重新展开」', () => {
    // 只存一个 Set<number> 分不清「用户展开了它」和「它还没被折过」,于是一条刚跑完的流
    // 会在用户眼皮底下自己收起来。这里的 false 就是「我要它展开着」。
    expect([...foldedStreams([s(true), s(false)], new Map([[0, false], [1, true]]))]).toEqual([1])
  })

  it('选中的折着 → 选阶段;展开着 → 滚内容', () => {
    expect(logPaneMode(new Set([0, 1]), 0, 2)).toBe('select')
    expect(logPaneMode(new Set([1]), 0, 2)).toBe('read')
  })

  it('越界的 selected 算选阶段 —— 没有内容可滚时把键交给列表导航', () => {
    // 流列表会变短(环形缓冲淘汰),而 selected 是一个独立的 state。
    expect(logPaneMode(new Set(), 5, 2)).toBe('select')
    expect(logPaneMode(new Set(), -1, 2)).toBe('select')
    expect(logPaneMode(new Set(), 0, 0)).toBe('select')
  })
})

describe('logPaneAction —— 按键必须是纯函数', () => {
  it('选阶段模式下,只有 ↑↓ 和 j/k 换含义', () => {
    // 其余键两种模式下逐字相同:滚轮一格是 3 行(当选择用会飞过整个列表),
    // 而 g/G 说的是「到顶 / 到底并恢复跟随」,那是视口的事。
    expect(logPaneAction('', key({ upArrow: true }), 'select')).toEqual({ t: 'selectStream', d: -1 })
    expect(logPaneAction('', key({ downArrow: true }), 'select')).toEqual({ t: 'selectStream', d: 1 })
    expect(logPaneAction('jj', key(), 'select')).toEqual({ t: 'selectStream', d: 2 })
    expect(logPaneAction('k', key(), 'select')).toEqual({ t: 'selectStream', d: -1 })
    expect(logPaneAction('', key({ wheelDown: true }), 'select')).toEqual({ t: 'line', d: 3 })
    expect(logPaneAction('', key({ pageDown: true }), 'select')).toEqual({ t: 'halfPage', d: 1 })
    expect(logPaneAction('d', key({ ctrl: true }), 'select')).toEqual({ t: 'halfPage', d: 1 })
    expect(logPaneAction('G', key(), 'select')).toEqual({ t: 'bottom' })
    expect(logPaneAction('g', key(), 'select')).toEqual({ t: 'top' })
    expect(logPaneAction(' ', key(), 'select')).toEqual({ t: 'toggleFold' })
    expect(logPaneAction('n', key(), 'select')).toEqual({ t: 'nextStream' })
    expect(logPaneAction('t', key(), 'select')).toEqual({ t: 'toggleThinking' })
  })

  it('不传模式时行为和加这个参数之前逐字相同', () => {
    // 新参数不该改变任何既有调用点的语义 —— 默认 read 就是这个函数原来唯一的行为。
    expect(logPaneAction('', key({ upArrow: true }))).toEqual({ t: 'line', d: -1 })
    expect(logPaneAction('', key({ upArrow: true }), 'read')).toEqual({ t: 'line', d: -1 })
    expect(logPaneAction('jjj', key())).toEqual({ t: 'line', d: 3 })
  })

  it('方向键与翻页键', () => {
    expect(logPaneAction('', key({ upArrow: true }))).toEqual({ t: 'line', d: -1 })
    expect(logPaneAction('', key({ downArrow: true }))).toEqual({ t: 'line', d: 1 })
    expect(logPaneAction('', key({ pageUp: true }))).toEqual({ t: 'halfPage', d: -1 })
    expect(logPaneAction('', key({ pageDown: true }))).toEqual({ t: 'halfPage', d: 1 })
    expect(logPaneAction('u', key({ ctrl: true }))).toEqual({ t: 'halfPage', d: -1 })
    expect(logPaneAction('d', key({ ctrl: true }))).toEqual({ t: 'halfPage', d: 1 })
  })

  it('连击合批:按住 j 拿到的是 "jjj",要滚三行而不是变成死键', () => {
    // parse-keypress 对一个 text token 直接产出一个按键事件,而 token 可以是多字符。
    // TaskTreePanel 今天正因为按 `k === 'j'` 判等,按住 j 什么都不发生。
    expect(logPaneAction('jjj', key())).toEqual({ t: 'line', d: 3 })
    expect(logPaneAction('kk', key())).toEqual({ t: 'line', d: -2 })
    expect(logPaneAction('j', key())).toEqual({ t: 'line', d: 1 })
  })

  it('混合字符不是连击,不当按键处理', () => {
    expect(logPaneAction('jk', key())).toBeNull()
    expect(logPaneAction('abc', key())).toBeNull()
  })

  it('g / G 幂等,重复多少次都一样', () => {
    expect(logPaneAction('gg', key())).toEqual({ t: 'top' })
    expect(logPaneAction('GGG', key())).toEqual({ t: 'bottom' })
  })

  it('G 要双写 —— kitty 协议给的是 g + shift', () => {
    expect(logPaneAction('G', key())).toEqual({ t: 'bottom' })
    expect(logPaneAction('g', key({ shift: true }))).toEqual({ t: 'bottom' })
    expect(logPaneAction('g', key())).toEqual({ t: 'top' })
  })

  it('n 换流,空格折叠;**Tab 不再归这里**', () => {
    expect(logPaneAction('n', key())).toEqual({ t: 'nextStream' })
    expect(logPaneAction('N', key())).toEqual({ t: 'nextStream' })
    expect(logPaneAction(' ', key())).toEqual({ t: 'toggleFold' })
    // Tab 让给了**区切换**(段落区 ⇄ 输出区)。详情页原来整个键盘归日志窗,
    // 用户因此没有任何办法把焦点移到上面的段落上 —— 那正是他报的问题。
    expect(logPaneAction('', key({ tab: true }))).toBeNull()
  })

  it('刻意不认 Esc / q / 回车 —— 那三个键归详情视图', () => {
    // 两个 useInput 会同时收到每一个键,不冲突全靠键位不重叠。这条断言就是那份约定。
    expect(logPaneAction('', key({ escape: true }))).toBeNull()
    expect(logPaneAction('', key({ return: true }))).toBeNull()
    expect(logPaneAction('q', key())).toBeNull()
    expect(logPaneAction('qqq', key())).toBeNull()
  })

  it('其他修饰键组合一律不认', () => {
    expect(logPaneAction('j', key({ ctrl: true }))).toBeNull()
    expect(logPaneAction('j', key({ meta: true }))).toBeNull()
    expect(logPaneAction('', key())).toBeNull()
  })
})

describe('budgetRows —— 任务树的行预算按行结算', () => {
  it('全是单行时就是 height', () => {
    expect(budgetRows([1, 1, 1, 1, 1], 0, 3)).toBe(3)
  })

  it('运行中的行占两行,总打印行数不超预算', () => {
    // 设计稿第一版是 height - min(runningRows, height/3):height=20、全部在跑时预算 14,
    // 而那 14 行全是运行中的 → 实打印 28 行。
    const cost = Array.from({ length: 30 }, () => 2)
    const n = budgetRows(cost, 0, 20)
    expect(n * 2).toBeLessThanOrEqual(20)
    expect(n).toBe(10)
  })

  it('切片里没有运行中的行时不白扣预算', () => {
    // 反方向的错:按「全树运行中节点数」减常数,会让一屏全是已完成节点时也少显示好几个。
    const cost = [1, 1, 1, 1, 1, 2, 2, 2]
    expect(budgetRows(cost, 0, 5)).toBe(5)
  })

  it('从中间开始也对', () => {
    expect(budgetRows([2, 2, 1, 1, 1], 2, 3)).toBe(3)
  })

  it('至少画一行', () => {
    expect(budgetRows([2, 2], 0, 1)).toBe(1)
    expect(budgetRows([], 0, 10)).toBe(1)
  })

  it('height 非正时是 0', () => {
    expect(budgetRows([1, 1], 0, 0)).toBe(0)
  })
})

describe('思考:默认折成段数,但要给得出来', () => {
  const s = () => stream({ events: [think('第一段想法'), think('第二段想法'), tool('Bash', 'Bash(x)')] })

  it('默认只给段数,并说清怎么展开', () => {
    const ls = render({ streams: [s()], width: 60 })
    const body = plain(ls.filter(l => !l.isHeader)).join('\n')
    expect(body).toContain('思考 2 段')
    expect(body).toContain('t 展开')
    expect(body).not.toContain('第一段想法')
  })

  it('展开之后思考原文真的到得了屏幕', () => {
    // 此前 agentEvents 老老实实按行抽了思考、eventLine 还给它备了 dim 样式,而渲染层
    // 把它整体换成一个计数 —— 抽出来的原文**永远到不了屏幕**。用户的原话是「看到模型
    // 在思考啥」,这是直接对着需求做的相反决定。
    const ls = render({ streams: [s()], width: 60, expandedThinking: new Set([0]) })
    const body = plain(ls.filter(l => !l.isHeader)).join('\n')
    expect(body).toContain('第一段想法')
    expect(body).toContain('第二段想法')
    expect(body).toContain('Bash(x)')
  })

  it('只展开被点名的那一条流', () => {
    const ls = render({ streams: [s(), s()], width: 60, expandedThinking: new Set([1]) })
    const body = plain(ls).join('\n')
    expect((body.match(/第一段想法/g) ?? []).length).toBe(1)
  })

  it('t 是一个按键动作', () => {
    expect(logPaneAction('t', key())).toEqual({ t: 'toggleThinking' })
    // 幂等:连击只走一次,不该来回翻
    expect(logPaneAction('ttt', key())).toEqual({ t: 'toggleThinking' })
  })
})

describe('鼠标滚轮', () => {
  it('滚轮上下各走三行', () => {
    // 能不能收到取决于终端有没有开鼠标追踪(这个 fork 默认非全屏,不开)。接上它零成本,
    // 开了的场景就能用;不接的话,开了也白开。
    expect(logPaneAction('', key({ wheelUp: true }))).toEqual({ t: 'line', d: -3 })
    expect(logPaneAction('', key({ wheelDown: true }))).toEqual({ t: 'line', d: 3 })
  })
})

describe('runControlAction —— 运行中的三个干预键', () => {
  // 这个纯函数原来**一条测试都没有**,而同文件的 logPaneAction / redoGateAction 都有。
  // 回归验收在它上面造了四条变异,全部存活。
  const k = (over: Record<string, unknown> = {}) => over as never

  it('p / i / x,大小写都认', () => {
    expect(runControlAction('p', k())).toBe('togglePause')
    expect(runControlAction('P', k())).toBe('togglePause')
    expect(runControlAction('i', k())).toBe('addDirective')
    expect(runControlAction('x', k())).toBe('cancelNode')
    expect(runControlAction('X', k())).toBe('cancelNode')
  })

  it('组合键归终端 —— **Ctrl+X 绝不能取消节点**', () => {
    // 实测 ink 对 Ctrl+字母给的是 input='x' + key.ctrl=true。去掉这道闸的话,
    // Ctrl+X 会取消光标选中的节点、Ctrl+P 会把整轮暂停 —— 而用户按的是终端的常用键。
    expect(runControlAction('x', k({ ctrl: true }))).toBeNull()
    expect(runControlAction('p', k({ ctrl: true }))).toBeNull()
    expect(runControlAction('i', k({ meta: true }))).toBeNull()
  })

  it('别的键一律不认 —— 兜底不能变成「按什么都暂停」', () => {
    for (const c of ['j', 'k', 'h', 'l', ' ', 'q', 'r', 'n', 'G', '1']) {
      expect(`${c} → ${String(runControlAction(c, k()))}`).toBe(`${c} → null`)
    }
    expect(runControlAction('', k())).toBeNull()
  })

  it('只认同一字符的连续重复 —— 合批输入不许触发', () => {
    // 渲染器会把一个 stdin 分片拆成几个事件;'pi' 是两个键被合批带进来的,
    // 取整串首字符判的话会当成一次暂停。
    expect(runControlAction('pi', k())).toBeNull()
    expect(runControlAction('xp', k())).toBeNull()
    // 按住不放是同一个字符重复,那算一次。
    expect(runControlAction('ppp', k())).toBe('togglePause')
  })
})

describe('工具调用的耗时与归属(渲染)', () => {
  it('耗时紧跟在 ⎿ 后面,不在行尾 —— 行尾会被折行甩到续行上', () => {
    const ls = plain(render({
      streams: [stream({ events: [tool('T1', 'Bash(bun test)'), resultOf('T1', '2043 pass', 1800, 'Bash(bun test)')] })],
    }))
    const line = ls.find(l => l.includes('2043 pass'))!
    expect(line).toContain('1.8s · 2043 pass')
    // 上一行就是它自己的调用,归属是多余的。
    expect(line.includes('Bash(bun test)')).toBe(false)
  })

  it('并行调用错序返回时,把归属写出来 —— ⎿ 的语义是「上一行的返回」', () => {
    const ls = plain(render({
      streams: [stream({ events: [
        tool('T1', 'gitlab - List Issues (MCP)(acme/web)'),
        tool('T2', 'ctx7 - resolve-library-id (MCP)(react)'),
        resultOf('T1', '#412 登录页 500', 1800, 'gitlab - List Issues (MCP)(acme/web)'),
        resultOf('T2', 'MCP error -32001', 900, 'ctx7 - resolve-library-id (MCP)(react)'),
      ] })],
      width: 200,
    }))
    const first = ls.find(l => l.includes('#412'))!
    const second = ls.find(l => l.includes('-32001'))!
    // 第一条返回的上一行是 ctx7 那次调用,不是它自己的 —— 必须报出归属。
    expect(first).toContain('gitlab - List Issues (MCP)(acme/web) · 1.8s · #412 登录页 500')
    // 第二条的上一行是第一条返回(不是工具),同样要报。
    // 900ms 走亚秒那一档 —— 亚秒不许被渲染成 0s(见下面那条格式测试)。
    expect(second).toContain('ctx7 - resolve-library-id (MCP)(react) · 900ms · MCP error -32001')
  })

  it('没有耗时就什么都不加 —— 不画 0s', () => {
    const ls = plain(render({
      streams: [stream({ events: [tool('T1', 'Read(a.ts)'), resultOf('T1', '读到了')] })],
    }))
    const line = ls.find(l => l.includes('读到了'))!
    expect(line.trim()).toBe('│   ⎿ 读到了')
  })

  it('耗时的三档格式', () => {
    expect([formatDur(85), formatDur(1800), formatDur(133000)]).toEqual(['85ms', '1.8s', '2m13s'])
    // 亚秒不许显示成 0s:一次 Read 常常就是几十毫秒,全渲染成 0s 等于没有这个数。
    expect(formatDur(40)).not.toBe('0s')
    expect(formatDur(Number.NaN)).toBe('')
  })
})

describe('sectionLines —— 「任务」页卡的产行函数', () => {
  const base = { cursor: 0, expanded: new Set<string>(), width: 40, collapsedLines: 3 }

  it('按显示宽度折行,不是按码点 —— 中文一个字占两列', () => {
    /**
     * 夹具的方向很容易搞反,搞反了这条测试就是恒真的。
     *
     * 要触发的老毛病是 block() 的 `Array.from(l).length <= width`:**码点数没超、显示宽度
     * 超了**的那一行会被判成「不用折」,交给 Text 默认 wrap 回流成两三个终端行,
     * 而窗口按「一行」记了账。所以这一行必须挑在这个夹缝里:
     *   正文可用 36 列;30 个汉字 = 30 码点(**没超**)= 60 列(**超了一倍**)。
     * 用 60 个汉字反而测不到 —— 码点数也超了,按码点判的实现照样会折。
     */
    const body = '中'.repeat(30)
    expect(Array.from(body).length).toBeLessThanOrEqual(36) // 前提:码点数没超
    expect(stringWidth(body)).toBeGreaterThan(36)           // 前提:显示宽度超了
    const { lines } = sectionLines({ ...base, sections: [{ title: '目标', body }], collapsedLines: 50 })
    for (const l of lines.slice(1)) expect(stringWidth(l.text)).toBeLessThanOrEqual(40)
    // 折成了两行正文,不是一行。
    expect(lines.length).toBe(3)
  })

  it('列宽真的参与计算 —— 窄终端要折出更多行', () => {
    const wide = sectionLines({ ...base, sections: [{ title: '目标', body: 'a'.repeat(200) }], width: 100, collapsedLines: 50 })
    const narrow = sectionLines({ ...base, sections: [{ title: '目标', body: 'a'.repeat(200) }], width: 40, collapsedLines: 50 })
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length)
  })

  it('折叠时掐头**留尾** —— 最新的那几行不许被裁掉', () => {
    // 每一轮追加的内容都追加在末尾(执行状态后面长出「(合并冲突解决)…」,验收记录后面
    // 长出最新一轮裁决)。只留头的话,把节点挡下来的那条拒绝理由在整个 TUI 里都找不到。
    const body = Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n')
    const { lines } = sectionLines({ ...base, sections: [{ title: '执行状态', body }], collapsedLines: 4 })
    const texts = lines.map(l => l.text)
    expect(texts.some(t => t.includes('第0行'))).toBe(true)
    expect(texts.some(t => t.includes('第29行'))).toBe(true)
    expect(texts.some(t => t.includes('中间省略'))).toBe(true)
    // 标题 + 4 行正文,一行不多。
    expect(lines.length).toBe(5)
  })

  it('标题上写清一共多少行,展开之后换成「空格收起」', () => {
    const body = Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n')
    const collapsed = sectionLines({ ...base, sections: [{ title: '目标', body }] })
    expect(collapsed.lines[0]!.text).toContain('共 30 行')
    const open = sectionLines({ ...base, sections: [{ title: '目标', body }], expanded: new Set(['目标']) })
    expect(open.lines[0]!.text).toContain('空格收起')
    // 展开之后整段铺开(30 行 + 1 行标题)。
    expect(open.lines.length).toBe(31)
  })

  it('装得下就不提「共 N 行」—— 一句没用的提示也是噪声', () => {
    const { lines } = sectionLines({ ...base, sections: [{ title: '重点', body: '就一行' }] })
    expect(lines[0]!.text).not.toContain('共')
    expect(lines[0]!.text).not.toContain('空格')
  })

  it('展开也有上限,超了照样说省略了多少 —— 不假装那是全部', () => {
    const body = Array.from({ length: EXPANDED_MAX_LINES + 500 }, (_, i) => `第${i}行`).join('\n')
    const { lines } = sectionLines({ ...base, sections: [{ title: '执行状态', body }], expanded: new Set(['执行状态']) })
    // 标题 1 行 + 正文恰好 EXPANDED_MAX_LINES 行(含「中间省略」那一行本身)。
    expect(lines.length).toBe(EXPANDED_MAX_LINES + 1)
    // 省略的行数按真实留下的算:总行数 - 头 - 尾 = 2500 - 1997 - 2。
    expect(lines.map(l => l.text).some(t => t.includes(`中间省略 ${2500 - (EXPANDED_MAX_LINES - 3) - 2} 行`))).toBe(true)
  })

  it('光标那一段带 ❯ 和反显,别的段没有', () => {
    const { lines, headerAt } = sectionLines({
      ...base, cursor: 1, sections: [{ title: '目标', body: 'a' }, { title: '重点', body: 'b' }],
    })
    expect(lines[headerAt(0)]!.text).not.toContain('❯')
    expect(lines[headerAt(0)]!.inverse).toBe(false)
    expect(lines[headerAt(1)]!.text).toContain('❯')
    expect(lines[headerAt(1)]!.inverse).toBe(true)
  })

  it('headerAt 指的是那一段的标题行 —— 展开上面一段之后它也要跟着走', () => {
    // 锚在绝对行号上的话,展开一段会让下面所有行整体位移,视口当场跳到别处 ——
    // 这是日志窗那边已经付过一次学费的坑。
    const secs = [{ title: '目标', body: 'x\n'.repeat(20) }, { title: '重点', body: '重点正文' }]
    const before = sectionLines({ ...base, sections: secs })
    const after = sectionLines({ ...base, sections: secs, expanded: new Set(['目标']) })
    expect(after.headerAt(1)).toBeGreaterThan(before.headerAt(1))
    expect(after.lines[after.headerAt(1)]!.text).toContain('重点')
    expect(before.lines[before.headerAt(1)]!.text).toContain('重点')
  })

  it('段落自带颜色时,正文不再 dim —— 阻断原因要看得见', () => {
    const { lines } = sectionLines({ ...base, sections: [{ title: '阻断原因', body: '验收未通过', color: 'error' }] })
    expect(lines[0]!.color).toBe('error')
    expect(lines[1]!.color).toBe('error')
    expect(lines[1]!.dim).toBe(false)
  })
})

describe('详情页的按键(段落区 / 页签条)', () => {
  it('←/→ 切页卡 —— 这两个键在详情页原来是死键', () => {
    expect(sectionPaneAction('', key({ leftArrow: true }))).toEqual({ t: 'tab', d: -1 })
    expect(sectionPaneAction('', key({ rightArrow: true }))).toEqual({ t: 'tab', d: 1 })
    // 日志窗**不认**左右箭头 —— 两个 useInput 会同时收到每一个键,不冲突全靠这一点。
    expect(logPaneAction('', key({ leftArrow: true }))).toBeNull()
    expect(logPaneAction('', key({ rightArrow: true }))).toBeNull()
  })

  it('Tab 轮转焦点区,Shift+Tab 反向', () => {
    expect(sectionPaneAction('', key({ tab: true }))).toEqual({ t: 'switchZone', d: 1 })
    expect(sectionPaneAction('', key({ tab: true, shift: true }))).toEqual({ t: 'switchZone', d: -1 })
    // Tab 是专门从日志窗那边让出来的。
    expect(logPaneAction('', key({ tab: true }))).toBeNull()
  })

  it('ctrl+u / ctrl+d 半页滚动 —— 挑的是没被 REPL 抢走的那两个键', () => {
    // 全屏下 PgUp/PgDn/滚轮已经被 REPL 的 ScrollKeybindingHandler 绑走并
    // stopImmediatePropagation 掉了(它比详情页先挂),所以页脚只承诺 ^u/^d。
    expect(sectionPaneAction('u', key({ ctrl: true }))).toEqual({ t: 'scroll', d: -1 })
    expect(sectionPaneAction('d', key({ ctrl: true }))).toEqual({ t: 'scroll', d: 1 })
    expect(sectionPaneAction('', key({ pageUp: true }))).toEqual({ t: 'scroll', d: -1 })
    expect(sectionPaneAction('', key({ pageDown: true }))).toEqual({ t: 'scroll', d: 1 })
  })

  it('↑↓/jk 选段落,空格展开;别的组合键一律不认', () => {
    expect(sectionPaneAction('', key({ upArrow: true }))).toEqual({ t: 'move', d: -1 })
    expect(sectionPaneAction('jjj', key())).toEqual({ t: 'move', d: 3 })
    expect(sectionPaneAction(' ', key())).toEqual({ t: 'toggle' })
    expect(sectionPaneAction('x', key({ meta: true }))).toBeNull()
    // 合批带进来的别的输入不认(和 logPaneAction 同一条规矩)。
    expect(sectionPaneAction('jk', key())).toBeNull()
  })
})

describe('鼠标可用性 —— 三道闸门', () => {
  it('全开才是能点', () => {
    expect(mouseAvailability({ fullscreen: true, tracking: true, clicks: true })).toBe('on')
  })

  it('三个不同的原因要分得开 —— 否则用户不知道该动哪个开关', () => {
    expect(mouseAvailability({ fullscreen: false, tracking: true, clicks: true })).toBe('needs-fullscreen')
    expect(mouseAvailability({ fullscreen: true, tracking: false, clicks: true })).toBe('tracking-disabled')
    expect(mouseAvailability({ fullscreen: true, tracking: true, clicks: false })).toBe('clicks-disabled')
  })

  it('非全屏时,后面两个开关怎么设都不改变结论', () => {
    // 非全屏下终端根本不上报鼠标,说「被 DISABLE_MOUSE 关掉了」会把人指去改一个
    // 和现象无关的开关。
    expect(mouseAvailability({ fullscreen: false, tracking: false, clicks: false })).toBe('needs-fullscreen')
  })

  it('每一种不可用都给得出一句能照着做的话', () => {
    for (const a of ['needs-fullscreen', 'tracking-disabled', 'clicks-disabled'] as const) {
      // 提示里必须点名那个环境变量,否则等于只说了「不能用」。
      expect(`${a}: ${/CLAUDE_CODE_[A-Z_]+/.test(mouseHint(a))}`).toBe(`${a}: true`)
    }
    expect(mouseHint('on')).toBe('鼠标点击')
  })
})

describe('detailLayout —— 详情页的版面算术', () => {
  /**
   * 单独钉这几个数,是因为算错的后果**不是画面溢出**:内容区是 flexGrow +
   * overflow:hidden,少算一行只会**静默少画一行**。变异实测:把 chrome 减 1、
   * 或者不给「↓ 下面还有 N 行」预留位置,整套渲染断言一条都不红。
   */
  it('非模态:标题 + 元信息 + 页签条 + 页脚 + 上下边框,一共 6 行', () => {
    const l = detailLayout({ budget: 30, columns: 100, inModal: false })
    expect(l.contentRows).toBe(24)
    expect(l.contentWidth).toBe(96) // paddingX 2 + 边框 2
  })

  it('模态槽里不画自己的边框,省下 2 行 2 列', () => {
    const l = detailLayout({ budget: 30, columns: 100, inModal: true })
    expect(l.contentRows).toBe(26)
    expect(l.contentWidth).toBe(98)
  })

  it('paneRows 比 contentRows 少一行 —— 那一行留给「下面还有 N 行」', () => {
    for (const budget of [10, 16, 24, 40, 60]) {
      const l = detailLayout({ budget, columns: 100, inModal: false })
      expect(`budget=${budget} pane=${l.paneRows}`).toBe(`budget=${budget} pane=${l.contentRows - 1}`)
    }
  })

  it('全部加起来正好是预算,一行不多一行不少', () => {
    for (const inModal of [true, false]) {
      for (const budget of [12, 20, 24, 40, 60]) {
        const l = detailLayout({ budget, columns: 100, inModal })
        const chrome = 4 + (inModal ? 0 : 2)
        expect(`${inModal}/${budget}: ${l.contentRows + chrome}`).toBe(`${inModal}/${budget}: ${budget}`)
      }
    }
  })

  it('行数有下限,但**列宽没有虚高下限** —— 宁可诚实地小', () => {
    /**
     * 列宽一度写着 `Math.max(24, …)`:26 列的终端上真实内宽 22、算出来 24,于是行按
     * 23 列排版、渲进 22 列 → 回流成两个终端行 → ScrollPane 最后一个孩子被
     * overflow:hidden 剪掉,而**帧的总行数一点没变**。实测被吃掉的正是「↓ 下面还有 8 行」。
     * 返回一个比真实宽度大的数是最坏的一种错:下游所有算术都成立,只有像素不成立。
     */
    const l = detailLayout({ budget: 1, columns: 10, inModal: false })
    expect(l.contentRows).toBeGreaterThanOrEqual(3)
    expect(l.paneRows).toBeGreaterThanOrEqual(2)
    expect(l.contentWidth).toBe(6) // 10 - 边框2 - padding2,一分不多
    // 各种窄宽度下都必须**恰好**是真实可用宽度。
    for (const columns of [26, 28, 40, 100]) {
      expect(`${columns} 列: ${detailLayout({ budget: 20, columns, inModal: false }).contentWidth}`)
        .toBe(`${columns} 列: ${columns - 4}`)
    }
    // 窄到排不出东西时,由调用方明说「终端太窄」——见 MIN_DETAIL_WIDTH。
    expect(MIN_DETAIL_WIDTH).toBeGreaterThan(0)
  })
})

describe('焦点标记不许说假话', () => {
  it('焦点在页签条上时,段落区不画光标', () => {
    // 画了的话就是「这一段选中了」——而此刻 ↑↓ 和空格都不归它。
    expect(sectionCursor('content', true, 3)).toBe(3)
    expect(sectionCursor('tabs', true, 3)).toBe(-1)
  })

  it('当前是别的页卡时,段落区也不画光标', () => {
    expect(sectionCursor('content', false, 3)).toBe(-1)
    expect(sectionCursor('tabs', false, 3)).toBe(-1)
  })

  it('页签只在焦点真的落在页签条上时才反显', () => {
    // 「当前页卡」和「焦点在页签条上」是两件事:前者用加粗和颜色表示,
    // 后者才是反显。合成一个的话,用户永远看不出键盘此刻归谁。
    expect(tabFocused('tabs', true)).toBe(true)
    expect(tabFocused('tabs', false)).toBe(false)
    expect(tabFocused('content', true)).toBe(false)
  })
})

describe('任务树页脚里「怎么进详情页」那半句', () => {
  it('能点才说能点', () => {
    expect(detailEntryHint('on')).toBe('回车/点击看详情')
  })

  it('不能点时一个字都不多写 —— 那一行是 truncate-end 的', () => {
    // 多塞一句「需要开全屏」会把右边的「Esc/q 退出」吃掉,等于用「解释一个用不了的
    // 功能」换掉「怎么退出去」。为什么点不了由详情页页签条右侧那个专门的位置去说。
    for (const a of ['needs-fullscreen', 'tracking-disabled', 'clicks-disabled'] as const) {
      expect(`${a}: ${detailEntryHint(a)}`).toBe(`${a}: 回车看详情`)
    }
  })
})

describe('同一屏上不许有两套时间格式', () => {
  it('表头超过一分钟也走分秒,别让人心算 613/60', () => {
    const ls = render({
      streams: [stream({ closed: true, endedAt: 1000 + 613000 })],
      nowMs: 999999, width: 70,
    })
    expect(ls[0]!.text).toContain('10m13s')
    expect(ls[0]!.text).not.toContain('613s')
  })

  it('一分钟以内保持整秒 —— 那是表头一直以来的样子', () => {
    const ls = render({ streams: [stream({ closed: true, endedAt: 9000 })], nowMs: 999999, width: 70 })
    expect(ls[0]!.text).toContain('8s')
  })
})

describe('折叠态那一行是回看时的主要形态,不能只剩一句裸 brief', () => {
  it('「最新: ⎿ …」带上归属和耗时 —— 数据本来就在事件里', () => {
    // 已收口的流默认就是折叠的,所以事后回看一个跑完的节点时,这一行是绝大多数流的
    // 全部可见内容。它一度看不出是哪个工具的返回,也没有耗时。
    const s = stream({
      closed: true, endedAt: 4000,
      events: [tool('T1', 'Bash(bun test)'), resultOf('T1', '2043 pass', 1800, 'Bash(bun test)')],
    })
    const ls = plain(render({ streams: [s], folded: new Set([0]), width: 80 }))
    const latest = ls.find(l => l.includes('最新'))!
    expect(latest).toContain('Bash(bun test)')
    expect(latest).toContain('1.8s')
    expect(latest).toContain('2043 pass')
  })

  it('没有归属和耗时时不硬凑', () => {
    const s = stream({ closed: true, endedAt: 4000, events: [tool('T1', 'Read(a.ts)'), resultOf('T1', '读到了')] })
    const ls = plain(render({ streams: [s], folded: new Set([0]), width: 80 }))
    expect(ls.find(l => l.includes('最新'))!).toContain('⎿ 读到了')
  })
})

describe('展开思考之后要看得出哪句是想的', () => {
  it('每一段思考前插一行标记,并告诉用户怎么收起', () => {
    // 不插的话,思考正文和模型说的话只差一个 dimColor —— 而 dimColor 在很多终端主题下
    // 几乎看不出来;而且「t 展开」那一行整个消失了,用户不知道怎么收回去。
    const ls = plain(render({
      streams: [stream({ events: [think('先想想'), think('再想想'), text('我来读一下'), think('又想')] })],
      expandedThinking: new Set([0]), width: 60,
    }))
    expect(ls.filter(l => l.includes('t 收起')).length).toBe(2) // 两段思考,各一个标记
    expect(ls.some(l => l.includes('先想想'))).toBe(true)
    expect(ls.some(l => l.includes('我来读一下'))).toBe(true)
  })

  it('不展开时还是一行计数,和原来一样', () => {
    const ls = plain(render({
      streams: [stream({ events: [think('a'), think('b'), text('说话')] })],
      width: 60,
    }))
    expect(ls.some(l => l.includes('思考 2 段(t 展开)'))).toBe(true)
    expect(ls.some(l => l.includes('a'))).toBe(false)
  })
})

describe('折叠预览至少留得下「头 + 省略 + 尾」', () => {
  it('collapsedLines 下限是 3,不是 2 —— 2 会把头挤掉', () => {
    // 2 行时 head=0,每一段都长成「… 中间省略 59 行」+ 一条从中间切开的续行碎片,
    // 零信息量。而那正是 24 行终端上用户第一次打开详情页看到的东西。
    expect(collapsedLinesFor(10)).toBe(3)
    expect(collapsedLinesFor(6)).toBe(3)
    expect(collapsedLinesFor(60)).toBe(10)
  })

  it('三行时头和尾都在', () => {
    const body = Array.from({ length: 30 }, (_, i) => `第${i}行`).join('\n')
    const { lines } = sectionLines({
      sections: [{ title: '目标', body }], cursor: 0, expanded: new Set<string>(),
      width: 40, collapsedLines: 3,
    })
    const texts = lines.map(l => l.text)
    expect(texts.some(t => t.includes('第0行'))).toBe(true)   // 头
    expect(texts.some(t => t.includes('中间省略'))).toBe(true)
    expect(texts.some(t => t.includes('第29行'))).toBe(true)  // 尾
    expect(lines.length).toBe(4) // 标题 + 3
  })
})

describe('⎿ 的归属:provider 没给 id 时也不能瞎认主人', () => {
  it('两个匿名并行调用错序返回,归属要按 brief 认出来', () => {
    // 第一版在空 useId 上写的是「上一行是工具就认它」,而先进先出配对是按**发出顺序**
    // 配的、返回却是错序到的 —— 于是第一条 ⎿ 画在第二个工具底下、还不写归属,
    // 而事件里明明有 ofBrief。这正是这次改动声称要消灭的「错位却装作没错位」。
    const ls = plain(render({
      streams: [stream({ events: [
        tool('', 'Read(a.ts)'),
        tool('', 'Bash(ls)'),
        resultOf('', 'A 的返回', 100, 'Read(a.ts)'),
        resultOf('', 'B 的返回', 190, 'Bash(ls)'),
      ] })],
      width: 200,
    }))
    expect(ls.find(l => l.includes('A 的返回'))!).toContain('Read(a.ts)')
    expect(ls.find(l => l.includes('B 的返回'))!).toContain('Bash(ls)')
  })

  it('紧跟自己调用行的匿名返回仍然省掉归属', () => {
    const ls = plain(render({
      streams: [stream({ events: [tool('', 'Read(a.ts)'), resultOf('', '读到了', 100, 'Read(a.ts)')] })],
      width: 200,
    }))
    const line = ls.find(l => l.includes('读到了'))!
    expect(line).toContain('100ms · 读到了')
    expect(line.includes('Read(a.ts)')).toBe(false)
  })
})
