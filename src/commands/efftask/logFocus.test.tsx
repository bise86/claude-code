/**
 * 「切换到哪,展示哪」—— 挂真组件,按真键,让正在跑的那条流真的吐新输出。
 *
 * 用户报的现象:Tab 切到某个阶段之后,上下键却在展示**正在执行**的那个子 agent 的数据。
 * 纯函数档(logAnchor.test.ts)守的是解算规则;这一档守的是**它真的接上了**,以及那条
 * 一直在动的流不会把视口抢回去。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createStreamStore } from '../../tools/efftask/agentStream.js'
import { AgentLogPane, LOG_COALESCE_MS, useStreamTick } from './AgentLogPane.js'

/**
 * 必须**超过合批窗口**(LOG_COALESCE_MS = 250)。
 *
 * 30ms 的话流的变化根本还没引起重绘,于是「视口没动」是空的 —— 什么都没动过。
 * 这一点是被下面那条正向用例(折叠之后 from 必须变小)顺带暴露出来的。
 */
// 切流从 Tab 改成 n:Tab 让给了详情页的**区切换**(段落区 ⇄ 输出区)——
// 详情页原来整个键盘归日志窗,用户没有任何办法把焦点移到上面的段落上。
const NEXT_STREAM = 'n'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, LOG_COALESCE_MS + 80))

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
    isTTY: true, columns: 100, rows: 40,
    write: (s: string) => { frame += s; return true },
  })
  return { stdin, stdout, since: (mark: number) => frame.slice(mark), len: () => frame.length }
}

/**
 * 两条流:一条「分析」已经收口(会被折叠),一条「执行」还在跑(展开、还在长)。
 * 这正是用户那一屏的形状。
 */
function twoStreams() {
  const store = createStreamStore()
  const plan = store.open({ nodeId: 'n', phaseLabel: '分析', label: '甲' })
  for (let i = 0; i < 12; i++) plan.push({ kind: 'text', text: `分析第${i}行的独有内容` })
  const exec = store.open({ nodeId: 'n', phaseLabel: '执行', label: '乙' })
  for (let i = 0; i < 12; i++) exec.push({ kind: 'text', text: `执行第${i}行` })
  return { store, plan, exec }
}

/**
 * 探针组件:**每次重绘都重新取快照**,和 NodeDetail 的真实做法一致。
 *
 * store.streams(id) 返回的是快照数组;只取一次的话,后续 push 不会引起重绘 ——
 * 那样测出来的「视口没动」是假的(什么都没动过)。useStreamTick 就是生产里
 * 用来把流的变化接进 React 的那个钩子。
 */
function Probe(props: {
  store: ReturnType<typeof createStreamStore>
  onState: (s: { selected: number; follow: boolean; from: number; total: number }) => void
}): React.ReactElement {
  // 第二个参数是 active。漏掉它 = effect 直接早退、从不订阅 —— 于是组件永远不重绘,
  // 而「视口没动」这类断言会全部空过(实测:推 30 条之后 total 纹丝不动)。
  useStreamTick(props.store, true)
  return (
    <AgentLogPane
      streams={props.store.streams('n')}
      height={10}
      width={90}
      isActive
      onState={s => props.onState({ selected: s.selected, follow: s.follow, from: s.from, total: s.total })}
    />
  )
}

async function mountPane(store: ReturnType<typeof createStreamStore>) {
  const t = fakeTty()
  const state: { selected: number; follow: boolean; from: number; total: number }[] = []
  const app = await render(
    <Probe store={store} onState={s => state.push(s)} />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { t, app, last: () => state[state.length - 1]! }
}

describe('n 切到哪条流,视口就停在哪条', () => {
  it('n 一下:选中项前进,并且**关掉跟随**', async () => {
    const { store } = twoStreams()
    const m = await mountPane(store)
    expect(m.last().follow).toBe(true) // 初始粘底
    m.t.stdin.press(NEXT_STREAM)
    await tick()
    m.app.unmount()
    // 关掉跟随是这条修复的一半:原来只在「找得到表头」时才关,于是切到一条还没渲染出
    // 表头的流时,视口继续粘在底部那条正在跑的流上 —— 正是用户抱怨的现象。
    expect(m.last().follow).toBe(false)
    expect(m.last().selected).toBe(1)
  })

  it('切过去之后,正在跑的那条流再吐输出也**抢不走**视口', async () => {
    const { store, exec } = twoStreams()
    const m = await mountPane(store)
    // n 两下回到第 0 条(分析)。
    m.t.stdin.press(NEXT_STREAM); await tick()
    m.t.stdin.press(NEXT_STREAM); await tick()
    expect(m.last().selected).toBe(0)
    const parked = m.last().from
    const totalBefore = m.last().total

    // 执行那条继续吐 —— 这是「子 agent 捕获了上下键」的现场。
    for (let i = 0; i < 30; i++) exec.push({ kind: 'text', text: `新输出${i}` })
    await tick()
    m.app.unmount()
    // 先证明**重绘真的发生了** —— 否则「视口没动」只是因为什么都没动过。
    expect(m.last().total).toBeGreaterThan(totalBefore)
    // 然后才是被测行为:视口不许因为**别处**长了东西而移动。
    expect(`新输出之后的起始行: ${m.last().from}`).toBe(`新输出之后的起始行: ${parked}`)
    expect(m.last().follow).toBe(false)
  })

  it('一条流跑完折叠、上方塌掉时,视口跟着选中的流走', async () => {
    const { store, plan } = twoStreams()
    const m = await mountPane(store)
    m.t.stdin.press(NEXT_STREAM); await tick() // 选中第 1 条(执行)
    expect(m.last().selected).toBe(1)
    const before = m.last().from

    // 第 0 条(分析)收口 → 默认折叠 → 它那十几行当场塌掉。
    plan.end()
    await tick()
    m.app.unmount()
    // 记绝对行号的话 from 不变,而那个行号现在指着别的内容。锚在流上时 from 必须**变小**。
    expect(`塌掉前 ${before} → 塌掉后 ${m.last().from}`).not.toBe(`塌掉前 ${before} → 塌掉后 ${before}`)
    expect(m.last().from).toBeLessThan(before)
    expect(m.last().selected).toBe(1)
  })

  it('按 End / G 回到底部会恢复跟随 —— 不然新输出就再也不动了', async () => {
    const { store } = twoStreams()
    const m = await mountPane(store)
    m.t.stdin.press(NEXT_STREAM); await tick()
    expect(m.last().follow).toBe(false)
    m.t.stdin.press('G'); await tick()
    m.app.unmount()
    expect(m.last().follow).toBe(true)
  })
})
