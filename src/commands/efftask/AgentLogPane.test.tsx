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
import { render } from '../../ink.js'
import { AgentLogPane } from './AgentLogPane.js'
import type { AgentEvent } from '../../tools/efftask/agentEvents.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'

const ESC = String.fromCharCode(27)
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
const TAB = '\t'
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

type State = { from: number; total: number; follow: boolean; selected: number; folded: number[] }

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
    expect(last().from).toBe(last().total - 6)
    app.unmount()
  })

  it('↑ 离开底部就停止跟随,新输出不再把视线推走', async () => {
    const { t, app, last } = await mount({ streams: long() })
    t.stdin.press(UP)
    await tick()
    expect(last().follow).toBe(false)
    expect(last().from).toBe(last().total - 7)
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
    expect(last().from).toBe(last().total - 6)
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

  it('Tab 在流之间轮转', async () => {
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

  it('钉住的提示自己占一行,不把最后一行挤出去', async () => {
    // 不扣这一行的话,窗口会画 height+1 行,把它下面的东西顶掉一行。
    const many = [stream({ events: lines(...[...Array(40)].map((_, i) => `行${i}`)) })]
    const a = await mount({ streams: many })
    const b = await mount({ streams: many, droppedEvents: 7 })
    expect(`无提示时窗口高 ${a.last().total - a.last().from}`).toBe('无提示时窗口高 6')
    expect(`有提示时窗口高 ${b.last().total - b.last().from}`).toBe('有提示时窗口高 5')
    a.app.unmount(); b.app.unmount()
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
