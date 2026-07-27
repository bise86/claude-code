import { describe, expect, it } from 'bun:test'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { AgentEvent } from '../../tools/efftask/agentEvents.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import {
  budgetRows,
  lastActivity,
  logPaneAction,
  renderStreamLines,
  scrollbarColumn,
  scrollWindow,
  droppedNotice,
  wrapDisplayWidth,
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
    expect(heads[0]!.selected).toBe(false)
    expect(heads[1]!.selected).toBe(true)
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

describe('logPaneAction —— 按键必须是纯函数', () => {
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

  it('Tab 换流,空格折叠', () => {
    expect(logPaneAction('', key({ tab: true }))).toEqual({ t: 'nextStream' })
    expect(logPaneAction(' ', key())).toEqual({ t: 'toggleFold' })
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
