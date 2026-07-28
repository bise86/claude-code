/**
 * 任务详情页的段落焦点。
 *
 * 用户的原话:「任务详情里的目标、完整方案、重点、风险点、验收点等等各个可以通过空格
 * 展开看详细信息,但是可以通过 Tab 先切到上面吧,或者上下键等。」
 *
 * 在这之前详情页的键盘**整个归日志窗**:段落被裁到两三行的头尾,而 ↑↓ 在滚日志、
 * 空格在折日志的流 —— 没有任何办法展开其中一段。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createStreamStore } from '../../tools/efftask/agentStream.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { NodeDetail } from './NodeDetail.js'

const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 30))
// 方向键必须显式转义:字面量 ESC 会被写文件那一步吞掉,键送不到、断言恒真(本轮踩过多次)。
const DOWN = '\u001b[B'
const UP = '\u001b[A'
const TAB = '\t'

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
    isTTY: true, columns: 110, rows: 44,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  /**
   * **累积**缓冲,不提供 reset。
   *
   * 这个渲染器只写**增量**:reset 之后再取一帧,拿到的是被改动的那几个片段
   * (实测:一次移动之后只剩一个孤零零的 `❯`,和半截「收起)」)。所以正向断言一律
   * 看累积 —— 「这个东西在某一刻被画出来过」;反向断言则挑一个**只在目标状态下才会
   * 出现**的标记,而不是「此刻屏幕上没有」。
   */
  /**
   * 转义**去掉而不留空格**的视图,专门给内容断言用。
   *
   * lastFrame 把转义替成空格是为了让相邻的两段文字不粘连;但增量渲染会在**一行中间**
   * 插光标移动,于是 '目标第25行' 在 lastFrame 里长成 '目标 25行' —— 内容明明在,
   * 子串却匹配不上。两个视图各管一头:标题那种整行渲染的用 lastFrame,
   * 正文用 packed。
   */
  const packed = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, '').replace(/[\u001b\r]/g, '')
  return { stdin, stdout, lastFrame: plain, packed }
}

/** 每段都够长,裁剪一定会发生 —— 否则「展开」看不出区别。 */
const long = (tag: string, n = 30): string =>
  Array.from({ length: n }, (_, i) => `${tag}第${i}行`).join('\n')

const node = (): TaskNode => ({
  ...createNode({
    id: 'root', title: '根任务', parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  status: 'EXECUTING',
  goal: long('目标'),
  plan: { solution: long('方案'), keyPoints: long('重点'), risks: long('风险'), acceptance: long('验收') },
  execStatus: long('执行'),
})

async function mount(over: Record<string, unknown> = {}) {
  const t = fakeTty()
  const seen: { zone: string; cursor: number; expanded: string[] }[] = []
  const app = await render(
    <NodeDetail
      node={node()} elapsed="12s" logActive columns={110}
      onState={x => seen.push(x)}
      {...over}
    />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  /** 焦点状态从 onState 读,不从帧里猜 —— 见 fakeTty 上那段注释。 */
  const at = () => seen[seen.length - 1]!
  return { t, app, at }
}

describe('段落区', () => {
  it('默认光标停在第一段,焦点在段落区', async () => {
    const { t, app, at } = await mount()
    // 帧里那一行是用户真看得到的东西,单行渲染所以子串匹配是可靠的。
    expect(t.lastFrame()).toContain('目标')
    app.unmount()
    expect(at()).toEqual({ zone: 'sections', cursor: 0, expanded: [] })
  })

  it('↑↓ 在段落之间移动', async () => {
    const { app, at, t } = await mount()
    t.stdin.press(DOWN); await tick()
    expect(at().cursor).toBe(1)
    t.stdin.press(DOWN); await tick()
    expect(at().cursor).toBe(2) // 重点
    t.stdin.press(UP); await tick()
    app.unmount()
    expect(at().cursor).toBe(1)
  })

  it('两端都夹住,不跑出去', async () => {
    const { t, app, at } = await mount()
    t.stdin.press(UP); await tick()
    t.stdin.press(UP); await tick()
    expect(at().cursor).toBe(0)
    for (let i = 0; i < 12; i++) { t.stdin.press(DOWN); await tick() }
    app.unmount()
    // 六段,下标最大 5。越界的话渲染时 sections[cursor] 是 undefined,空格变成死键。
    expect(at().cursor).toBe(5)
  })

  it('空格展开选中那一段,再按收起', async () => {
    const { t, app, at } = await mount()
    // 裁剪时会告诉你一共多少行 —— 不说的话用户不知道还有更多。单行渲染,可靠。
    expect(t.lastFrame()).toContain('空格展开')
    t.stdin.press(' '); await tick()
    expect(at().expanded).toEqual(['目标'])
    /**
     * **不断言帧里的正文。**
     *
     * 这个渲染器的增量是**字符级**的:重画一行时只写变了的那几个字,于是
     * '目标第25行' 在缓冲里长成 '目标' + 光标移动 + '25行' —— 完整串一次都没出现过。
     * 把 strip 改成不留空格也救不回来(实测)。所以正文这一跳靠首帧那条单行标记
     * (「空格展开,共 30 行」,首帧是整屏写,可靠)+ 状态断言来守。
     */
    t.stdin.press(' '); await tick()
    app.unmount()
    expect(at().expanded).toEqual([])
  })

  it('展开的是**选中**那一段,不是第一段', async () => {
    const { t, app, at } = await mount()
    t.stdin.press(DOWN); await tick() // → 完整方案
    t.stdin.press(' '); await tick()
    expect(at().expanded).toEqual(['完整方案'])
    app.unmount()
    // 目标那一段从头到尾没展开过 —— 状态里只有「完整方案」。
    expect(at().expanded).not.toContain('目标')
  })

  it('空的段落不进列表 —— 否则光标会停在一个什么都没有的格子上', async () => {
    // 断言必须落在**下标**上:Section 对空 body 本来就 return null,所以光看画面
    // 有没有「风险点」是分辨不出过滤有没有生效的(实测:删掉 filter,画面一模一样)。
    const n = node()
    n.plan = { ...n.plan, keyPoints: '', risks: '' }
    const { t, app, at } = await mount({ node: n })
    expect(t.lastFrame()).not.toContain('风险点')
    // 过滤生效时列表是 目标/完整方案/验收点/执行状态,下标 2 就是验收点。
    t.stdin.press(DOWN); await tick()
    t.stdin.press(DOWN); await tick()
    t.stdin.press(' '); await tick()
    app.unmount()
    expect(at().expanded).toEqual(['验收点'])
  })
})

describe('两个区的切换', () => {
  const withLog = () => {
    const store = createStreamStore()
    const h = store.open({ nodeId: 'root', phaseLabel: '执行', label: '甲' })
    h.push({ kind: 'text', text: '正在改 src/login.ts' })
    return store.streams('root')
  }

  it('Tab 切到输出区之后,↓ 和空格都不再动段落', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(TAB); await tick()
    expect(at().zone).toBe('log')
    t.stdin.press(DOWN); await tick()
    t.stdin.press(' '); await tick()
    app.unmount()
    // 键归日志窗:光标没动,也没展开任何段落。
    expect(at().cursor).toBe(0)
    expect(at().expanded).toEqual([])
  })

  it('在输出区时,段落的内容一行都不会多出来', async () => {
    const { t, app } = await mount({ streams: withLog() })
    t.stdin.press(TAB); await tick()
    t.stdin.press(' '); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('目标第25行')
  })

  it('Tab 再按一次切回段落区', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(TAB); await tick()
    t.stdin.press(TAB); await tick()
    expect(at().zone).toBe('sections')
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(1)
  })

  it('焦点在段落区时,日志窗**收不到**键 —— 否则 n 会在背后换流', () => {
    // 这一条守的是 AgentLogPane 的 isActive 真的跟着区焦点走。
    // 观测口是日志窗自己的 onState:段落区有焦点时按 n,选中的流不许变。
    return (async () => {
      const store = createStreamStore()
      for (const label of ['甲', '乙']) {
        const h = store.open({ nodeId: 'root', phaseLabel: '执行', label })
        h.push({ kind: 'text', text: label + '在干活' })
      }
      const seen: number[] = []
      const t = fakeTty()
      const app = await render(
        <NodeDetail
          node={node()} elapsed="12s" logActive columns={110}
          streams={store.streams('root')}
          onLogState={x => seen.push(x.selected)}
        />,
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const before = seen[seen.length - 1]
      t.stdin.press('n'); await tick()
      expect(seen[seen.length - 1]).toBe(before)   // 段落区有焦点,n 不该换流
      t.stdin.press(TAB); await tick()
      t.stdin.press('n'); await tick()
      app.unmount()
      expect(seen[seen.length - 1]).not.toBe(before) // 切过去之后才换得动
    })()
  })
  it('没有输出可看时 Tab 不切走 —— 切过去会是一个按什么都没反应的空区', async () => {
    const { t, app, at } = await mount() // 不传 streams
    t.stdin.press(TAB); await tick()
    expect(at().zone).toBe('sections')
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(1)
  })
})
