/**
 * 「有几次权限确认在等人」这个计数器。
 *
 * 它是 suspended 那条链上唯一带状态的一环,而并行度大于 1 时可以同时有几个执行节点各自
 * 等一个确认 —— 用布尔的话,其中一个被回答完就把面板的键盘放回去了,而屏幕上还有下一个
 * 对话框,于是回车照样既批准工具又打开详情页:**要修的 bug 只修好一半**。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render, Text } from '../../ink.js'
import { useHumanWaitCount } from './useLiveState.js'

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 15))

/** 把计数器挂进一个真组件,并把控制权交出来。 */
function Probe(props: { onReady: (api: { begin: () => void; end: () => void }) => void }): React.ReactElement {
  const h = useHumanWaitCount()
  React.useEffect(() => { props.onReady({ begin: h.begin, end: h.end }) }, [props, h.begin, h.end])
  return <Text>{h.waiting ? 'WAITING' : 'FREE'}</Text>
}

async function mount() {
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 80, rows: 20, write: (s: string) => { frame += s; return true },
  })
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => null,
  })
  let api: { begin: () => void; end: () => void } | undefined
  const app = await render(<Probe onReady={a => { api = a }} />, {
    stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  // 只看**最后一帧**:渲染器是增量写的,累加起来的缓冲里 FREE 和 WAITING 会同时存在。
  const last = (): string => frame.slice(frame.lastIndexOf('[2K') >= 0 ? 0 : 0).split('\r').pop() ?? ''
  const state = (): string => (frame.lastIndexOf('WAITING') > frame.lastIndexOf('FREE') ? 'WAITING' : 'FREE')
  return { app, api: () => api!, state, last }
}

describe('useHumanWaitCount', () => {
  it('初始是自由的', async () => {
    const m = await mount()
    expect(m.state()).toBe('FREE')
    m.app.unmount()
  })

  it('一次 begin 就挂起,对应的 end 放回来', async () => {
    const m = await mount()
    m.api().begin(); await tick()
    expect(m.state()).toBe('WAITING')
    m.api().end(); await tick()
    expect(m.state()).toBe('FREE')
    m.app.unmount()
  })

  it('两个节点同时等批准时,回答完一个**仍然**挂起', async () => {
    // 这是计数器存在的全部理由。用布尔的话这里会变回 FREE,而屏幕上还有第二个对话框。
    const m = await mount()
    m.api().begin(); await tick()
    m.api().begin(); await tick()
    expect(m.state()).toBe('WAITING')
    m.api().end(); await tick()
    expect(m.state()).toBe('WAITING')
    m.api().end(); await tick()
    expect(m.state()).toBe('FREE')
    m.app.unmount()
  })

  it('多一次 end 不会让计数变成负数', async () => {
    // 负数的后果是**后面所有**的确认都不再挂起面板,而且没有任何迹象 ——
    // 那正是原来那个 bug 的完整复现,只是更难查。
    const m = await mount()
    m.api().end(); await tick()
    m.api().end(); await tick()
    m.api().begin(); await tick()
    expect(m.state()).toBe('WAITING')
    m.app.unmount()
  })

  it('连着两下 begin 之间不等 render 也数得对', async () => {
    // 渲染器会把一个 stdin 分片拆成几个事件**同步**派发,而 useInput 的处理器只在
    // 提交后的 useLayoutEffect 里换 —— 所以边沿可能在一次 render 之前连着来两下。
    // ref 那一路就是为这个。
    const m = await mount()
    m.api().begin()
    m.api().begin()
    await tick()
    m.api().end(); await tick()
    expect(m.state()).toBe('WAITING')
    m.app.unmount()
  })
})
