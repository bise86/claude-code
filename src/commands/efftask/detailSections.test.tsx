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
import { NodeDetail, detailSections } from './NodeDetail.js'

const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 30))
// 方向键必须显式转义:字面量 ESC 会被写文件那一步吞掉,键送不到、断言恒真(本轮踩过多次)。
const DOWN = '\u001b[B'
const UP = '\u001b[A'
const TAB = '\t'
const RIGHT = '\u001b[C'
const LEFT = '\u001b[D'

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
  const seen: { zone: string; tab: string; cursor: number; expanded: string[] }[] = []
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
    // from 一起断言:它是「视口停在第几行」的观测口(和 AgentLogPane 同一个理由),
    // 刚打开时必须停在最顶上,否则用户一进详情页就已经滚到半截了。
    // cursorShown / tabsInverse 交的是**画出来的样子**:刚打开时段落光标在第 0 段、
    // 页签条上没有反显(焦点在内容区)。它们和 cursor/zone 是两件事 —— 见 NodeDetail 的注释。
    expect(at()).toEqual({
      zone: 'content', tab: 'task', cursor: 0, expanded: [], from: 0,
      cursorShown: 0, tabsInverse: [],
    })
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

describe('两个页卡', () => {
  const withLog = () => {
    const store = createStreamStore()
    const h = store.open({ nodeId: 'root', phaseLabel: '执行', label: '甲' })
    h.push({ kind: 'text', text: '正在改 src/login.ts' })
    return store.streams('root')
  }

  it('→ 切到输出页卡之后,↓ 和空格都不再动段落', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(RIGHT); await tick()
    expect(at().tab).toBe('log')
    t.stdin.press(DOWN); await tick()
    t.stdin.press(' '); await tick()
    app.unmount()
    // 键归日志窗:光标没动,也没展开任何段落。
    expect(at().cursor).toBe(0)
    expect(at().expanded).toEqual([])
  })

  it('在输出页卡上,段落的内容一行都不会多出来', async () => {
    const { t, app } = await mount({ streams: withLog() })
    t.stdin.press(RIGHT); await tick()
    t.stdin.press(' '); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('目标第25行')
  })

  it('← 切回任务页卡,段落键又管用了', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(RIGHT); await tick()
    t.stdin.press(LEFT); await tick()
    expect(at().tab).toBe('task')
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(1)
  })

  it('页卡是绕圈的 —— 两个页卡时 → 两下回到原地', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(RIGHT); await tick()
    t.stdin.press(RIGHT); await tick()
    app.unmount()
    expect(at().tab).toBe('task')
  })

  it('Tab 把焦点交给页签条,再按一次交回内容区', async () => {
    // 用户原话:「最下面点击或回车可选择不同的页卡内容展示」。焦点态是「回车」那半句
    // 的落点 —— 回车本身归 TaskTreePanel(返回任务树),只有焦点在页签条上时才让路。
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(TAB); await tick()
    expect(at().zone).toBe('tabs')
    // 焦点在页签条上时,↓ 不许动段落光标。
    t.stdin.press(DOWN); await tick()
    expect(at().cursor).toBe(0)
    t.stdin.press(TAB); await tick()
    expect(at().zone).toBe('content')
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(1)
  })

  it('焦点在页签条上时,←→ 照样切页卡', async () => {
    const { t, app, at } = await mount({ streams: withLog() })
    t.stdin.press(TAB); await tick()
    t.stdin.press(RIGHT); await tick()
    app.unmount()
    expect(`${at().zone} ${at().tab}`).toBe('tabs log')
  })

  it('在任务页卡上时,日志窗**收不到**键 —— 否则 n 会在背后换流', () => {
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
      expect(seen[seen.length - 1]).toBe(before)   // 在任务页卡上,n 不该换流
      t.stdin.press(RIGHT); await tick()
      t.stdin.press('n'); await tick()
      app.unmount()
      expect(seen[seen.length - 1]).not.toBe(before) // 切到输出页卡之后才换得动
    })()
  })
  it('没有输出时,输出页卡照样在,而且说的是实话', async () => {
    /**
     * 老版本在这里是「没有输出就不许切过去」。页卡化之后那条守不住也不该守:
     * 页签条的宽度不能随节点有没有输出而变(版面会跳),而且用户看到「子 agent 输出」
     * 这个页签、切过去发现是空的,本身就是一个准确的回答 —— 比一个按了不动的 Tab 好。
     * 要守的是**别撒谎**:说「暂无输出」,而不是画一个空窗口。
     */
    const { t, app, at } = await mount() // 不传 streams
    t.stdin.press(RIGHT); await tick()
    expect(at().tab).toBe('log')
    expect(t.lastFrame()).toContain('暂无输出')
    // 焦点确实交给了输出页卡:↓ 不再动段落光标。
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(0)
  })
})

describe('补充指引(你写的)必须有地方看得见', () => {
  /**
   * 它会被**原样拼进提示词**,而「同一处再写一次是替换」—— 不显示的话,用户没有任何办法
   * 知道这个节点上此刻挂着哪几句话、上一次写的那句还在不在。
   *
   * 断言落在 `detailSections`(纯函数)上而不是帧上:段落列表是数据,而屏幕上任何时刻只有
   * 其中一屏 —— 「这一段在不在」和「它有没有恰好滚到可视区」是两件事。
   */
  const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id: 'root', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })

  it('按环节列,「整个任务」那条排最前', () => {
    const secs = detailSections(mk({
      guidance: { execute: '先跑 bun test', all: '别动 src/legacy', review: '重点看并发' },
    }))
    const g = secs.find(s => s.title === '补充指引(你写的)')
    expect(g).toBeDefined()
    // 「整个任务」覆盖面最大,排最前;其余按 PHASE_NAMES 的次序(和环节耗时、名册一致)。
    expect(g!.body.split('\n')).toEqual([
      '整个任务: 别动 src/legacy',
      '质疑讨论: 重点看并发',
      '执行: 先跑 bun test',
    ])
  })

  it('没写过就整段不出现 —— 空段落是死格', () => {
    expect(detailSections(mk()).some(s => s.title === '补充指引(你写的)')).toBe(false)
    // 全是空白也一样。**两个分支都要验**:`all` 和某个环节键各走一条判断,只验前者时
    // 「环节键的空白也画出来」这条变异是活的(实测存活)—— 而那会画出一行「执行: 」,
    // 一个看起来像内容丢了的空槽。
    expect(detailSections(mk({ guidance: { all: '   ' } })).some(s => s.title === '补充指引(你写的)')).toBe(false)
    expect(detailSections(mk({ guidance: { execute: '  \t ' } })).some(s => s.title === '补充指引(你写的)')).toBe(false)
    // 一个有内容 + 一个空白:只画有内容的那一行。
    const mixed = detailSections(mk({ guidance: { execute: '  ', review: '看并发' } }))
      .find(s => s.title === '补充指引(你写的)')!
    expect(mixed.body).toBe('质疑讨论: 看并发')
  })
})
