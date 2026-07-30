/**
 * 通过 vendored 渲染器挂载(src/ink.ts),不是 npm ink —— useInput 只认这个 app 自己的
 * StdinContext,所以「画得对但一个键都不响应」在屏幕上和正常的一模一样。
 *
 * 断言方式是刻意选的:
 *  - **滚动位置在这个仓库的 TTY 夹具里根本观测不到**。累积型夹具让 `not.toContain` 恒真;
 *    带 reset 的夹具又因为渲染器只写 diff,让「某一行现在应该在屏幕上」这种正向断言不可靠。
 *    所以内部状态走 `onState` 回调看,而不是靠数屏幕上的行。
 *  - 屏幕断言只用「按键之后**新出现**的那一行文本」(diff 一定会写它)。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render, Text } from '../../ink.js'
import { AgentLogPane, useStreamTick } from './AgentLogPane.js'
import type { AgentEvent } from '../../tools/efftask/agentEvents.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'

const ESC = String.fromCharCode(27)
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
// 切流从 Tab 改成 n:Tab 让给了详情页的**区切换**(段落区 ⇄ 输出区)。
const TAB = 'n'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))

function fakeTty() {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 120, rows: 40,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

let seq = 0
const stream = (over: Partial<StreamState> = {}): StreamState => ({
  meta: { nodeId: 'n', phaseLabel: '执行', label: '甲员工' },
  events: [], dropped: 0, toolCount: 0, startedAt: Date.now() - 3000,
  closed: false, seq: seq++, ...over,
})
const lines = (...t: string[]): AgentEvent[] => t.map(x => ({ kind: 'text', text: x }))

type State = { from: number; total: number; follow: boolean; selected: number; folded: number[]; mode: 'select' | 'read' }

async function mount(props: Record<string, unknown>) {
  const t = fakeTty()
  const seen: State[] = []
  const app = await render(
    React.createElement(AgentLogPane as never, {
      height: 6, width: 60, isActive: true, onState: (s: State) => seen.push(s), ...props,
    } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { t, app, last: () => seen[seen.length - 1]! }
}

describe('AgentLogPane 的滚动', () => {
  const long = () => [stream({ events: lines(...[...Array(40)].map((_, i) => `行${String(i).padStart(2, '0')}`)) })]

  it('默认粘底 —— 实时终端就该停在最新一屏', async () => {
    const { app, last } = await mount({ streams: long() })
    expect(last().follow).toBe(true)
    // height=6,可用 5 行:「↓ 下面还有 N 行」那一行**无条件**从预算里扣,
    // 否则这个窗口实打印比 props.height 多一行,把调用方最底下那行顶掉。
    expect(last().from).toBe(last().total - 5)
    app.unmount()
  })

  it('↑ 离开底部就停止跟随,新输出不再把视线推走', async () => {
    const { t, app, last } = await mount({ streams: long() })
    t.stdin.press(UP)
    await tick()
    expect(last().follow).toBe(false)
    expect(last().from).toBe(last().total - 6)
    app.unmount()
  })

  it('↓ 滚回底部自动恢复跟随 —— 否则一路按到底之后反而不动了', async () => {
    const { t, app, last } = await mount({ streams: long() })
    t.stdin.press(UP); await tick()
    t.stdin.press(DOWN); await tick()
    expect(last().follow).toBe(true)
    app.unmount()
  })

  it('g 到顶、G 回底并恢复跟随', async () => {
    const { t, app, last } = await mount({ streams: long() })
    t.stdin.press('g'); await tick()
    expect(last().from).toBe(0)
    expect(last().follow).toBe(false)
    t.stdin.press('G'); await tick()
    expect(last().from).toBe(last().total - 5)
    expect(last().follow).toBe(true)
    app.unmount()
  })

  it('按住 j 连击一次滚多行,不是死键', async () => {
    // parse-keypress 把一个 text token 直接变成一个按键事件,而 token 可以是多字符。
    const { t, app, last } = await mount({ streams: long() })
    t.stdin.press('g'); await tick()
    t.stdin.press('jjjj'); await tick()
    expect(last().from).toBe(4)
    app.unmount()
  })

  it('离开底部时告诉用户下面还有多少 —— 否则看起来像没在动', async () => {
    const { t, app } = await mount({ streams: long() })
    // 不 reset:渲染器只写 diff,reset 之后一个没变的行一个字节都不会重写,
    // 「它现在应该在屏幕上」这种断言就不可靠了。正向断言用累积帧是成立的 ——
    // 空的是**否定**断言,不是肯定断言。
    t.stdin.press('g'); await tick()
    t.stdin.press(DOWN); await tick()
    expect(t.lastFrame()).toContain('下面还有')
    app.unmount()
  })
})

describe('AgentLogPane 的折叠', () => {
  it('默认只展开运行中的流:跑完的自动收起', async () => {
    // 不定这条的话,一打开详情要么是几千行,要么要按几十次空格。
    const { app, last } = await mount({
      streams: [
        stream({ closed: true, endedAt: Date.now(), events: lines('跑完了') }),
        stream({ closed: false, events: lines('还在跑') }),
      ],
    })
    expect(last().folded).toEqual([0])
    app.unmount()
  })

  it('空格折叠/展开选中的那一条,而且用户的选择压得住默认值', async () => {
    // 只存一个 Set 的话分不清「用户展开了它」和「它还没被折过」,于是一条刚跑完的流会
    // 在用户眼皮底下自己收起来。
    const { t, app, last } = await mount({
      streams: [stream({ closed: false, events: lines('一', '二') }), stream({ closed: true, endedAt: Date.now(), events: lines('三') })],
    })
    expect(last().folded).toEqual([1])
    t.stdin.press(' '); await tick()
    expect(last().folded).toEqual([0, 1]) // 选中的是第 0 条,把它折起来
    t.stdin.press(' '); await tick()
    expect(last().folded).toEqual([1])
    app.unmount()
  })

  it('n 在流之间轮转(Tab 已让给详情页的区切换)', async () => {
    const { t, app, last } = await mount({
      streams: [stream({ events: lines('甲') }), stream({ events: lines('乙') }), stream({ events: lines('丙') })],
    })
    expect(last().selected).toBe(0)
    t.stdin.press(TAB); await tick()
    expect(last().selected).toBe(1)
    t.stdin.press(TAB); await tick()
    t.stdin.press(TAB); await tick()
    expect(last().selected).toBe(0) // 绕回来
    app.unmount()
  })

  it('空格折的是**选中**那条,不是第 0 条', async () => {
    // 只在 selected=0 的时候按空格,写死成 0 的实现照样绿 —— 探针是空的。
    // 第 0 条**已收口**、第 1 条还在跑 —— 两者的默认折叠状态必须不同,否则「读第 0 条
    // 的当前值」和「读选中那条的当前值」算出来一样,探针是空的。
    const { t, app, last } = await mount({
      streams: [
        stream({ closed: true, endedAt: Date.now(), events: lines('甲') }),
        stream({ closed: false, events: lines('乙') }),
        stream({ closed: false, events: lines('丙') }),
      ],
    })
    expect(last().folded).toEqual([0])   // 默认:收口的折起来
    t.stdin.press(TAB); await tick()     // 选中第 1 条(还在跑,默认展开)
    t.stdin.press(' '); await tick()
    expect(last().folded).toEqual([0, 1])
    app.unmount()
  })
})

describe('AgentLogPane 的边界', () => {
  it('刻意不吃 Esc / q / 回车 —— 那三个键归详情视图', async () => {
    // 两个 useInput 会同时收到每一个键,不冲突全靠键位不重叠。这里正向验证:按下这三个
    // 键之后窗口的内部状态**一动不动**(否定屏幕内容在只写 diff 的渲染器上不可靠)。
    const { t, app, last } = await mount({
      streams: [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })],
    })
    t.stdin.press('g'); await tick()
    const before = last()
    for (const k of [ESC, 'q', '\r']) { t.stdin.press(k); await tick() }
    const after = last()
    expect(`from ${after.from} follow ${after.follow} selected ${after.selected}`)
      .toBe(`from ${before.from} follow ${before.follow} selected ${before.selected}`)
    app.unmount()
  })

  it('isActive=false 时一个键都不接 —— 等待屏上的窗口是只读的', async () => {
    const { t, app, last } = await mount({
      streams: [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })],
      isActive: false,
    })
    const before = last().from
    t.stdin.press('g'); await tick()
    expect(last().from).toBe(before)
    app.unmount()
  })

  it('「已释放」钉在滚动区之外,跟随最新时照样看得见', async () => {
    // 它当日志第一行发出去的话,会被自己的粘底行为埋掉 —— 一个残缺的视图看起来完完整整,
    // 正好犯了这条提示要防的病。
    const { t, app } = await mount({
      streams: [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })],
      droppedEvents: 342,
    })
    expect(t.lastFrame()).toContain('342')
    expect(t.lastFrame()).toContain('已释放')
    app.unmount()
  })

  it('实打印行数不许超过 props.height —— 钉的是不变量,不是某个数字', async () => {
    /**
     * 这个窗口一共有三样东西会占行:钉住的「丢了多少」提示、内容切片、
     * 「↓ 下面还有 N 行」。三样加起来必须 ≤ props.height。
     *
     * 原来只扣了第一样,于是不跟随时实打印 height+1;它自己那两行页脚(已删)再加 2,
     * 最坏超 3 行 —— 而详情页最底下正是页签条和页脚,超出去顶掉的就是它们。
     * 钉具体数字的话,任何一次预算改动都要回来改测试,而改错了照样绿。
     */
    const many = [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })]
    for (const [label, props] of [
      ['跟随 · 无提示', { streams: many }],
      ['跟随 · 有提示', { streams: many, droppedEvents: 7 }],
    ] as [string, Record<string, unknown>][]) {
      const m = await mount(props)
      const noticeRows = props.droppedEvents ? 1 : 0
      const behindRows = m.last().follow ? 0 : 1
      const printed = noticeRows + (m.last().total - m.last().from) + behindRows
      expect(`${label} 实打印 ${printed} 行,预算 6`).toBe(`${label} 实打印 ${Math.min(printed, 6)} 行,预算 6`)
      m.app.unmount()
    }
  })

  it('滚上去之后,「下面还有 N 行」那一行是真的有位置画', async () => {
    // 不跟随时这一行才出现。它和内容切片加起来仍然不能超预算 —— 这是上一条的另一半,
    // 而上一条只能测到跟随态(mount 完默认粘底)。
    const many = [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })]
    const m = await mount({ streams: many })
    // 跟随时 from 正好是 total-height,所以这一步量到的就是窗口真实高度。
    // 不跟随之后 `total - from` 是「离结尾还有多远」,不再等于高度 —— 不能拿它当行数。
    const height = m.last().total - m.last().from
    m.t.stdin.press(UP)
    await tick()
    expect(m.last().follow).toBe(false)
    const printed = height + 1 // 内容切片 + 「↓ 下面还有 N 行」
    expect(`实打印 ${printed} 行,预算 6`).toBe(`实打印 ${Math.min(printed, 6)} 行,预算 6`)
    expect(m.t.lastFrame()).toContain('下面还有')
    m.app.unmount()
  })

  it('内容溢出时画滚动条,装得下时不画', async () => {
    // 有一根滚动条却怎么也滚不动,会让人以为界面卡住了。
    const big = await mount({ streams: [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })] })
    expect(big.t.lastFrame()).toContain('█')
    big.app.unmount()
    const small = await mount({ streams: [stream({ events: lines('就一行') })] })
    expect(small.t.lastFrame()).not.toContain('█')
    small.app.unmount()
  })

  it('没有任何流时给一句话,不是空白', async () => {
    const { t, app } = await mount({ streams: [], emptyHint: '还没开始' })
    expect(t.lastFrame()).toContain('还没开始')
    app.unmount()
  })

  it('resume 的历史节点即使没有流也说实话', async () => {
    const { t, app } = await mount({ streams: [], historical: true })
    expect(t.lastFrame()).toContain('上一次运行')
    app.unmount()
  })
})

describe('useStreamTick:首个事件要立刻上屏', () => {
  it('前沿触发 —— 纯尾部合批会让短调用全程什么都不显示', async () => {
    // 第一版是纯尾部合批:窗口开出来之后要等满一个 250ms 才第一次重绘,而「正在解析
    // 需求…」那次调用本身可能就几秒甚至更短 —— 屏一换,窗口一次都没画过。挂载测试
    // 复现过这个:tick 到期之前 phase 已经走了。
    const { createStreamStore } = await import('../../tools/efftask/agentStream.js')
    const store = createStreamStore()
    let repaints = 0
    const Probe = (): React.ReactElement => {
      useStreamTick(store, true)
      repaints++
      return React.createElement(Text, null, `r${repaints}`)
    }
    const t = fakeTty()
    const app = await render(React.createElement(Probe), {
      stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
    })
    await tick()
    const before = repaints
    store.open({ nodeId: 'n', phaseLabel: '需求解析', label: '主模型' }).push({ kind: 'text', text: '第一条' })
    // 只等几个宏任务,远小于 250ms 的合批窗口
    await tick()
    expect(`立刻重绘了: ${repaints > before}`).toBe('立刻重绘了: true')
    app.unmount()
  })
})

describe('折叠的阶段:↑↓ 选阶段,展开后 ↑↓ 滚内容', () => {
  /**
   * 用户的原话:「任务详情页中子agent里,各阶段选择中了可以通过上下键来选择,按空格展开后,
   * 上下键就是该阶段输出内容的上下滚动了」。
   *
   * 在这之前 ↑↓ **永远**是滚整个列表:一屏几十条流全折着的时候,按 ↑↓ 滚的是一堆表头,
   * 而「换一条流」只有 `n` 一个键、还只能单向循环。
   */
  /** 三条跑完的流(跑完默认折叠),各自有内容 —— 展开之后才有东西可滚。 */
  const three = () => [
    stream({ closed: true, events: lines(...[...Array(20)].map((_, i) => `甲${i}`)) }),
    stream({ closed: true, events: lines(...[...Array(20)].map((_, i) => `乙${i}`)) }),
    stream({ closed: true, events: lines(...[...Array(20)].map((_, i) => `丙${i}`)) }),
  ]

  it('全折着时 ↓ 换的是**选中的流**,不是滚动', async () => {
    const { t, app, last } = await mount({ streams: three() })
    expect(last().mode).toBe('select')
    expect(last().selected).toBe(0)
    t.stdin.press(DOWN); await tick()
    expect(last().selected).toBe(1)
    t.stdin.press(DOWN); await tick()
    expect(last().selected).toBe(2)
    app.unmount()
  })

  it('列表光标**撞到头就停**,不循环', async () => {
    // `n` 是「下一条」(循环),这是列表光标。循环的话在第一条上按 ↑ 会跳到最后一条 ——
    // 而那条通常正是还在跑、一直在动的那条,也就是用户抱怨过的现象。
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press(UP); await tick()
    expect(last().selected).toBe(0)
    for (let i = 0; i < 5; i++) { t.stdin.press(DOWN); await tick() }
    expect(last().selected).toBe(2)
    app.unmount()
  })

  it('空格展开选中那条之后,↑↓ 变成滚它的内容', async () => {
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press(DOWN); await tick()            // 选中第二条
    expect(last().selected).toBe(1)
    t.stdin.press(' '); await tick()             // 展开
    expect(last().folded).toEqual([0, 2])
    expect(last().mode).toBe('read')
    const before = last().from
    t.stdin.press(DOWN); await tick()
    // 选中的那条一动不动 —— 这一下是滚动。
    expect(last().selected).toBe(1)
    expect(last().from).toBeGreaterThan(before)
    app.unmount()
  })

  it('再按一次空格收起来,↑↓ 又回到选阶段', async () => {
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press(' '); await tick()
    expect(last().mode).toBe('read')
    t.stdin.press(' '); await tick()
    expect(last().mode).toBe('select')
    t.stdin.press(DOWN); await tick()
    expect(last().selected).toBe(1)
    app.unmount()
  })

  it('正在跑的那条默认是展开的,所以 ↑↓ 一进来就是滚动', async () => {
    // 「实时终端」的手感不能被这次改动拿走:一个节点正在跑的时候,人是来看输出的,
    // 而那条流本来就是展开的。要换阶段就按空格折起来,或者直接按 n。
    const { t, app, last } = await mount({
      streams: [stream({ events: lines(...[...Array(30)].map((_, i) => `行${i}`)) })],
    })
    expect(last().mode).toBe('read')
    const before = last().from
    t.stdin.press(UP); await tick()
    expect(last().from).toBeLessThan(before)
    app.unmount()
  })

  it('j/k 跟着 ↑↓ 走 —— 页脚只写一句「↑↓/jk」,两者不一样那句话就是假的', async () => {
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press('j'); await tick()
    expect(last().selected).toBe(1)
    t.stdin.press('k'); await tick()
    expect(last().selected).toBe(0)
    app.unmount()
  })

  it('选阶段模式下,滚轮和 g/G 仍然是滚动', async () => {
    /**
     * 一格滚轮是 3 行。当成「往下跳 3 条流」的话,轻轻一拨就飞过整个列表;而 g/G 说的是
     * 「到顶 / 到底并恢复跟随」,那是视口的事,和选中哪条流无关。
     */
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press('G'); await tick()
    expect(last().selected).toBe(0)
    expect(last().follow).toBe(true)
    t.stdin.press('g'); await tick()
    expect(last().selected).toBe(0)
    expect(last().from).toBe(0)
    app.unmount()
  })

  it('切到别的流之后,那条流的折叠状态决定 ↑↓ 归谁', async () => {
    // 「模式」不是一个独立的开关,而是**选中那条流的折叠状态**。展开甲、再选到乙,
    // ↑↓ 必须变回选阶段 —— 乙还是折着的。
    const { t, app, last } = await mount({ streams: three() })
    t.stdin.press(' '); await tick()
    expect(last().mode).toBe('read')
    t.stdin.press('n'); await tick()
    expect(last().selected).toBe(1)
    expect(last().mode).toBe('select')
    app.unmount()
  })
})
