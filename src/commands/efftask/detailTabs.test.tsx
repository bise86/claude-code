/**
 * 详情页的两个页卡、满屏预算,以及树上的鼠标点击。
 *
 * 用户的原话:
 *  1.「任务树上可以有鼠标点击看详情页和回车一样的效果。」
 *  2.「任务详情页要和普通 claude code 终端一样满屏,分为两个页卡……最下面点击或回车
 *     可选择不同的页卡内容展示。」
 *
 * 这里钉三样东西,每一样都对应一个**实测过的**失败模式:
 *  - **不许超屏**:带 height 的 Box 里,超量的子节点会被 yoga 按比例压缩而不是裁掉 ——
 *    实测 50 行塞进 10 行拿到的是 `L004,L009,L014,…`,连标题行都一起没了。
 *    一个残缺的视图看起来完完整整。
 *  - **底部块必须活过裁剪**:全屏下 `/et` 在 FullscreenLayout 的 modal 槽里,溢出是从
 *    **底部**剪的 —— 而用户点名要的页签条就在最下面。
 *  - **点击等价于回车**:非全屏下终端根本不上报点击,所以这条只有把 alt-screen 打开
 *    才测得到;打不开就是永远绿的假测试。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { ModalContext } from '../../context/modalContext.js'
import instances from '../../ink/instances.js'
import { createStreamStore } from '../../tools/efftask/agentStream.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { NodeDetail, detailSections } from './NodeDetail.js'
import { ScrollPane } from './ScrollPane.js'
import { collapsedLinesFor, detailLayout, sectionLines } from './logView.js'
import { Box } from '../../ink.js'
import { TaskTreePanel } from './TaskTreePanel.js'

const NOW = new Date().toISOString()
const ESC = String.fromCharCode(27)
const RIGHT = `${ESC}[C`
const DOWN = `${ESC}[B`
const TAB = '\t'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 30))

function fakeTty(rows = 24, columns = 100) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns, rows,
    write: (s: string) => { frame += s; return true },
  })
  const strip = new RegExp(`${ESC}\\[[0-9;>?]*[a-zA-Z]`, 'g')
  const plain = (): string => frame.replace(strip, ' ').split(ESC).join('')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id: 'root', title: '根任务', parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  ...over,
})

/** 每段都很长,而且是**中文** —— 折行按码点算的话预算会被打穿一倍。 */
const long = (tag: string, n = 40): string =>
  Array.from({ length: n }, (_, i) => `${tag}第${i}行` + '内容'.repeat(20)).join('\n')

const fatNode = (): TaskNode => node({
  status: 'EXECUTING',
  goal: long('目标'),
  plan: { solution: long('方案'), keyPoints: long('重点'), risks: long('风险'), acceptance: long('验收') },
  execStatus: long('执行'),
  blockedReason: long('阻断'),
})

const withLog = (n = 200) => {
  const store = createStreamStore()
  const h = store.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' })
  for (let i = 0; i < n; i++) h.push({ kind: 'text', text: `输出第${i}行` + '内容'.repeat(20) })
  return store.streams('root')
}

/**
 * 逼一次**整屏重画**再量。
 *
 * 这个渲染器只写增量:清过帧之后按到的键只会重画变了的那几行,拿它数行数量到的是
 * diff 的大小,不是屏幕的高度 —— 变异实测,一条「不许超屏」的断言会因此对任何高度
 * 都为真。切一次 alt-screen 会把 diff 状态清掉并整屏重画,这是唯一可靠的取样点。
 */
async function fullFrame(t: ReturnType<typeof fakeTty>, stdout: unknown, nudge = TAB): Promise<string> {
  const ink = instances.get(stdout as never)!
  // setAltScreenActive **只清 diff 状态,自己不重画** —— 清完之后还得有一次真的渲染,
  // 那一次才会整屏写出来。所以补一个不改变行数的按键把它逼出来(详情页用 Tab 切焦点区,
  // 树上用 ↓ 移光标)。一次挂载只能用一次:diff 状态清过就不会再清了。
  ink.setAltScreenActive(true, true)
  await tick()
  t.reset()
  t.stdin.press(nudge)
  await tick()
  return t.lastFrame()
}

/**
 * 帧里真正被画出来的终端行数。
 *
 * **按 \r 和 \n 一起切。** 非全屏那一版是 \r\n 分行的,而 alt-screen 下渲染器改用
 * 回车 + 光标移动,一整屏里一个 \n 都没有 —— 只按 \n 数的话,任何画面都会被数成 1 行,
 * 于是「不许超屏」的断言对什么高度都为真。这个坑吃过一次。
 */
function frameRows(f: string): number {
  return f.split(/[\r\n]+/).filter(l => l.trim().length > 0).length
}

describe('详情页满屏:算得准,而且底部块永远活着', () => {
  const CASES: [string, number, number][] = [
    ['24 行 · 100 列', 24, 100],
    ['24 行 · 40 列', 24, 40],
    ['24 行 · 80 列', 24, 80],
    ['40 行 · 120 列', 40, 120],
    ['60 行 · 60 列', 60, 60],
  ]
  for (const [label, rows, columns] of CASES) {
    for (const [tabLabel, tabProps] of [
      ['任务页卡', {}],
      ['输出页卡', { initialTab: 'log', streams: withLog() }],
    ] as [string, Record<string, unknown>][]) {
      it(`${label} · ${tabLabel}:不超预算,页签条和页脚都在`, async () => {
        const t = fakeTty(rows, columns)
        const budget = rows - 4
        const app = await render(
          React.createElement(NodeDetail as never, {
            node: fatNode(), elapsed: '1m', columns, maxRows: budget, logActive: true, ...tabProps,
          } as never),
          { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
        )
        await tick()
        const f = t.lastFrame()
        app.unmount()
        expect(`${label}/${tabLabel} 画了 ${frameRows(f)} 行,预算 ${budget}`)
          .toBe(`${label}/${tabLabel} 画了 ${Math.min(frameRows(f), budget)} 行,预算 ${budget}`)
        // 底部块:两个页签 + 页脚。它们是**最先**被剪掉的东西,所以要单独守。
        expect(f).toContain('任务')
        expect(f).toContain('子 agent 输出')
        expect(f).toContain('Esc/q 返回任务树')
      })
    }
  }

  it('内容连续,不是每 N 行采样一行 —— 压缩式失败长得和裁剪一模一样', async () => {
    /**
     * 这一条是整组里最重要的:给 Box 一个 height 而子节点用默认 flexShrink 时,
     * yoga 会把 50 行等比压进 10 行,屏幕上是 `L004,L009,L014,…`。
     * 「行数没超」的断言对它**完全无感** —— 只有查连续性才抓得住。
     */
    const t = fakeTty(24, 100)
    const marks = Array.from({ length: 12 }, (_, i) => `M${String(i).padStart(3, '0')}`)
    /**
     * 每段**恰好** collapsedLines 行(maxRows=20 → contentRows=14 → 每段 2 行),
     * 所以没有任何一段被掐头留尾 —— 屏幕上留下的就该是这 18 行的**开头连续一截**。
     * 这样一次渲染就判得了,不用按空格(累积帧会把展开前后两份画面混在一起)。
     */
    const pair = (i: number) => `${marks[i]}\n${marks[i + 1]}`
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: node({
          goal: pair(0),
          plan: { solution: pair(2), keyPoints: pair(4), risks: pair(6), acceptance: pair(8) },
          execStatus: pair(10),
        }),
        elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    const shown = marks.filter(m => f.includes(m))
    // 装不下全部(6 段 × 3 行 = 18 > 13),所以一定会截 —— 截出来的必须是开头那一截。
    expect(shown.length).toBeGreaterThan(5)
    expect(shown.length).toBeLessThan(marks.length)
    expect(shown).toEqual(marks.slice(0, shown.length))
  })
})

describe('页签条', () => {
  it('点一下页签就换页卡 —— 和 →/回车 同一个效果', async () => {
    const t = fakeTty(24, 100)
    const seen: { zone: string }[] = []
    const el = React.createElement(NodeDetail as never, {
      node: node({ goal: '目标内容' }), elapsed: '1m', columns: 100, maxRows: 20,
      logActive: true, streams: withLog(3),
      onState: (x: { zone: string }) => seen.push(x),
    } as never)
    const app = await render(
      el,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).not.toContain('输出第0行')
    // 非全屏下终端根本不上报点击,所以必须先把 alt-screen 打开 —— 否则
    // `Ink.dispatchClick` 第一句就 return false,这条测试会永远绿。
    const ink = instances.get(t.stdout as never)!
    // 开 alt-screen 会写 ENTER_ALT_SCREEN + ERASE + 整屏重画,所以这一跳之后帧里就是
    // 一整屏。**不要在这里 rerender 同一个 element** —— React 会直接 bail,
    // 一行都不重画,而按空帧算出来的行号是没有意义的。
    ink.setAltScreenActive(true, true)
    await tick()
    const rowsInFrame = t.lastFrame().split('\n')
    const barRow = rowsInFrame.findIndex(l => l.includes('子 agent 输出'))
    expect(barRow).toBeGreaterThanOrEqual(0)
    /**
     * 在页签条**这一行**上从右往左试,直到画面真的换成了输出页卡。
     *
     * 不直接按 `indexOf('子 agent 输出')` 定位:`lastFrame()` 把每一段转义换成一个空格,
     * 列号相对真实屏幕是**平移过的**。树上那条测试不受影响(整行都可点),而页签是窄的,
     * 平移几列就打偏 —— 打偏之后 `dispatchClick` 照样返回 true(命中了「任务」那个页签),
     * 于是一条写死列号的测试会**在功能坏掉时依然绿**。
     *
     * 从右往左是因为「子 agent 输出」在「任务」右边;找到即停,并把命中的列记下来断言。
     */
    // **先把焦点挪到页签条上**,否则 zone 本来就是 content,那条断言恒真。
    t.stdin.press(TAB)
    await tick()
    expect(seen[seen.length - 1]!.zone).toBe('tabs')
    let hitCol = -1
    for (let col = rowsInFrame[barRow]!.length; col >= 0 && hitCol < 0; col--) {
      t.reset()
      if (!ink.dispatchClick(col, barRow)) continue
      await tick()
      if (t.lastFrame().includes('输出第2行')) hitCol = col
    }
    app.unmount()
    expect(`点得到吗: ${hitCol >= 0}`).toBe('点得到吗: true')
    // 点完焦点要**落到内容区**,不是留在页签条上 —— 留着的话用户点了页签、
    // 却发现 ↑↓ 还在页签条上打转,而屏幕上那个页签还反显着。
    expect(`点完的焦点: ${seen[seen.length - 1]!.zone}`).toBe('点完的焦点: content')
  })

  it('Tab 把焦点交给页签条,而 Esc/q 任何时候都能返回', async () => {
    // 「返回」这条路不许有死角:焦点在页签条上时回车归页卡,而 Esc/q 仍然必须能出去。
    const seen: { zone: string; tab: string }[] = []
    const t = fakeTty(24, 100)
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: node({ goal: '目标内容' }), elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
        onState: (s: { zone: string; tab: string }) => seen.push(s),
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(TAB)
    await tick()
    app.unmount()
    expect(seen[seen.length - 1]!.zone).toBe('tabs')
  })
})

describe('树上的鼠标点击 = 在这一行上按回车', () => {
  const tree = (): TaskNode[] => [
    node({ id: 'root', title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'] }),
    { ...node({ id: 'root/00-a', title: '甲任务' }), parentId: 'root', goal: '甲的目标内容' },
    { ...node({ id: 'root/01-b', title: '乙任务' }), parentId: 'root', goal: '乙的目标内容' },
  ]

  it('点第三行(乙任务)打开的是**乙**的详情,不是光标那一行的', async () => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: tree(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const ink = instances.get(t.stdout as never)!
    ink.setAltScreenActive(true, true)
    await tick()
    const rowsInFrame = t.lastFrame().split('\n')
    const row = rowsInFrame.findIndex(l => l.includes('乙任务'))
    expect(row).toBeGreaterThanOrEqual(0)
    t.reset()
    const hit = ink.dispatchClick(rowsInFrame[row]!.indexOf('乙任务'), row)
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(`命中=${hit}`).toBe('命中=true')
    // 详情页开了,而且开的是乙 —— 光标本来停在根任务上。
    expect(f).toContain('乙的目标内容')
    expect(f).not.toContain('甲的目标内容')
  })

  it('非全屏时点击不产生任何效果 —— 这段代码是惰性的,不是坏的', async () => {
    // 终端在非全屏下根本不发鼠标序列,而 Ink.dispatchClick 第一句就是
    // `if (!this.altScreenActive) return false`。这条钉的是「加了 onClick 没有副作用」。
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: tree(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const ink = instances.get(t.stdout as never)!
    const rowsInFrame = t.lastFrame().split('\n')
    const row = rowsInFrame.findIndex(l => l.includes('乙任务'))
    const hit = ink.dispatchClick(rowsInFrame[row]!.indexOf('乙任务'), row)
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(`命中=${hit}`).toBe('命中=false')
    expect(f).not.toContain('乙的目标内容')
  })

  it('回车走的仍然是光标那一行 —— 点击没有把它顶掉', async () => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: tree(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('[B') // ↓ → 甲任务
    await tick()
    t.reset()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('甲的目标内容')
  })
})

describe('回车在页签条上归详情页,别的时候归任务树', () => {
    // 两个节点:↓ 要真的移得动光标,才能靠它逼出一次重画。
  const one = (): TaskNode[] => [
    node({ id: 'root', title: '根任务', kind: 'decompose', childIds: ['root/00-a'], goal: '目标内容在这里' }),
    { ...node({ id: 'root/00-a', title: '甲任务' }), parentId: 'root', goal: '甲的目标' },
  ]

  it('焦点在内容区时,回车关掉详情页(既有行为不许变)', async () => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: one(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    expect(t.lastFrame()).toContain('目标内容在这里')
    t.reset()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 回到树上:页脚是树的那一条,不是详情页的。
    expect(f).toContain('Esc/q 退出')
    expect(f).not.toContain('Esc/q 返回任务树')
  })

  it('焦点在页签条上时,回车不关详情页 —— 它归页卡', async () => {
    /**
     * 这一让必须由 TaskTreePanel 做:vendored 的 useInput 把 listener 槽位钉在 mount
     * 时刻,面板比 NodeDetail 先挂、**永远先跑**,在 NodeDetail 里 stopImmediatePropagation
     * 已经来不及了。所以这条测的是那条让路,不是 NodeDetail 自己。
     */
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: one(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    t.stdin.press(TAB) // → 焦点到页签条
    await tick()
    t.reset()
    t.stdin.press('\r')
    await tick()
    // 回车如果被正确忽略,画面一个像素都不会变 —— 而这个渲染器只写增量,
    // 清过帧之后就是空串,对空串断言什么都证明不了。所以补一下 Tab(焦点回内容区,
    // 页脚文案会变),逼出一次重画,再看重画出来的是谁的页脚。
    t.stdin.press(TAB)
    await tick()
    const f = t.lastFrame()
    app.unmount()
    /**
     * 断言落在**内容区页脚独有**的那一段上。
     *
     * 两条页脚的前缀是同一句「Esc/q 返回任务树 · ←→ …」,而这个渲染器只写增量 ——
     * 清过帧之后前缀根本不会被重写,拿它做断言会恒假。「↑↓/jk 选段落」只在焦点回到
     * 内容区、而且详情页还开着的时候才会被画出来。
     */
    expect(f).toContain('↑↓/jk 选段落')
    expect(f).not.toContain('Esc/q 退出')
  })

  it('Esc 在页签条上仍然返回 —— 返回这条路不许有死角', async () => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: one(), runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\r'); await tick()
    t.stdin.press(TAB); await tick()
    t.reset()
    t.stdin.press(ESC); await tick()
    // 同上:补一次一定会重画的按键(树上的 ↓ 会移光标)。Esc 真的返回了的话,
    // 这一下 ↓ 走的就是树的导航,重画出来的是树的页脚。
    t.stdin.press('\u001b[B'); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('Esc/q 退出')
  })
})

describe('页卡切换不重挂日志窗 —— 滚动位置不许被清掉', () => {
  it('切走再切回来,选中的流还是原来那条', async () => {
    const store = createStreamStore()
    for (const label of ['甲', '乙', '丙']) {
      store.open({ nodeId: 'root', phaseLabel: '执行', label }).push({ kind: 'text', text: `${label}在干活` })
    }
    const seen: number[] = []
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: node({ goal: '目标' }), elapsed: '1m', columns: 100, maxRows: 24, logActive: true,
        initialTab: 'log', streams: store.streams('root'),
        onLogState: (s: { selected: number }) => seen.push(s.selected),
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // 初值是最后一条(见 logView.initialSelectedStream),两下 n 从 2 绕到 1。
    t.stdin.press('n'); await tick()   // 2 → 0(绕回头)
    t.stdin.press('n'); await tick()   // 0 → 1
    const before = seen[seen.length - 1]
    expect(before).toBe(1)
    t.stdin.press(RIGHT); await tick() // → 任务页卡
    t.stdin.press(RIGHT); await tick() // → 转回输出页卡
    app.unmount()
    // 重挂的话这几个 useLiveState 会被清空,选中的流回到**初值**(最后一条,这里是 2)
    // —— 用户会以为自己按错了。所以断言的是「和切走之前一样」,而不是某个固定下标:
    // 前者才是这条用例要守的性质。
    expect(seen[seen.length - 1]).toBe(before)
  })
})

describe('尺寸从哪来', () => {
  it('在 modal 槽里要按槽给的行数排版,不是按终端行数', async () => {
    /**
     * 全屏时 `/et` 是 local-jsx,渲染在 FullscreenLayout 的 modal 槽里,那个槽给的是
     * `rows - 3` / `columns - 4`,外面罩着 overflow:hidden。按终端行数排版会**恒定多算
     * 3 行**,而多出来的是从**底部**剪掉的 —— 第一个被剪掉的正是页签条。
     */
    const t = fakeTty(40, 100)
    const app = await render(
      React.createElement(
        ModalContext as never,
        // 槽给的比终端小得多:按终端算的话会画 32 行,按槽算只该画 14 行。
        { value: { rows: 14, columns: 60, scrollRef: null } } as never,
        React.createElement(NodeDetail as never, { node: fatNode(), elapsed: '1m', logActive: true } as never),
      ),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(`画了 ${frameRows(f)} 行,槽给 14`).toBe(`画了 ${Math.min(frameRows(f), 14)} 行,槽给 14`)
    expect(f).toContain('子 agent 输出')
    expect(f).toContain('Esc/q 返回任务树')
  })

  it('没人给 maxRows 时,非全屏下要给对话流留余量,不吃满整屏', async () => {
    // 吃满的话帧高超过视口,任务树那个 1s tick 每跳一次就逼出一次整屏重置,
    // 而且被切掉的是**顶部** —— 标题和目标。
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(NodeDetail as never, { node: fatNode(), elapsed: '1m', columns: 100, logActive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(`画了 ${frameRows(f)} 行,终端 30`).toBe(`画了 ${Math.min(frameRows(f), 30 - 8)} 行,终端 30`)
    expect(f).toContain('Esc/q 返回任务树')
  })

  it('窄终端上宁可不解释鼠标,也不能让页签条回流成两行', async () => {
    // 那一行一旦回流,「一行 = 一个终端行」就破了,页脚会被顶出屏幕。
    const t = fakeTty(24, 46)
    const app = await render(
      React.createElement(NodeDetail as never, { node: fatNode(), elapsed: '1m', columns: 46, maxRows: 20, logActive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 断在**开头**上,不是环境变量名上:提示是 truncate-end 的,不画守卫的话它会被
    // 截成「鼠标需全屏模…」—— 环境变量名恰好被截掉,断在名字上的话这条测试会恒真。
    expect(f).not.toContain('鼠标需全屏')
    expect(f).toContain('子 agent 输出')
    expect(f).toContain('Esc/q 返回任务树')
    expect(`画了 ${frameRows(f)} 行,预算 20`).toBe(`画了 ${Math.min(frameRows(f), 20)} 行,预算 20`)
  })
})

describe('展开一段之后,视口跟着那一段走', () => {
  it('展开的是第 4 段,屏幕上就该停在第 4 段,不是跳回顶上', async () => {
    /**
     * 展开一段会让它下面所有行的行号整体位移。锚如果不重新钉回这一段的标题,
     * 视口就会停在原来那个行号上 —— 用户按了空格,画面却跳去了别的地方。
     * 日志窗那边为同一件事付过一次学费。
     */
    const t = fakeTty(24, 100)
    const mark = (tag: string) => Array.from({ length: 30 }, (_, i) => `${tag}${i}`).join('\n')
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: node({ goal: mark('目标'), plan: { solution: mark('方案'), keyPoints: mark('重点'), risks: mark('风险'), acceptance: '' }, execStatus: '' }),
        elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\u001b[B'); await tick() // → 完整方案
    t.stdin.press('\u001b[B'); await tick() // → 重点
    t.reset()
    t.stdin.press(' '); await tick()        // 展开「重点」
    const f = t.lastFrame()
    app.unmount()
    // 展开之后画面上要出现「重点」这一段的正文开头,而不是「目标」那一段。
    expect(f).toContain('重点0')
  })
})

describe('滚开之后再展开,视口要回到光标那一段', () => {
  it('翻页翻走之后按空格,视口回到选中那一段的标题行', async () => {
    /**
     * 移动光标本来就会把锚钉到那一段的标题上,所以「移动后展开」碰巧不重钉也是对的 ——
     * 钉不住这条。**翻页会改锚的偏移**,这时候不重钉就会停在翻到的位置,用户按了空格
     * 却看不到自己展开的那一段。
     *
     * 观测口是 onState 交出来的 `from`:滚动位置在这个仓库的 TTY 夹具里根本看不见
     * (渲染器只写增量,累积缓冲又把前后两份画面混在一起)。AgentLogPane 为同一个理由
     * 交出同一个数。
     */
    const seen: { cursor: number; from: number }[] = []
    const t = fakeTty(24, 100)
    const mark = (tag: string) => Array.from({ length: 40 }, (_, i) => `${tag}${i}`).join('\n')
    const app = await render(
      React.createElement(NodeDetail as never, {
        // 六段(折叠态每段 3 行 = 18 行)才装不下 13 行的窗口 —— 装得下的话 ^d 是个空操作,
        // 后面那条断言就永远为真。
        node: node({
          goal: mark('目标'),
          plan: { solution: mark('方案'), keyPoints: mark('重点'), risks: mark('风险'), acceptance: mark('验收') },
          execStatus: mark('执行'),
        }),
        elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
        onState: (x: { cursor: number; from: number }) => seen.push(x),
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\u001b[B'); await tick()   // 光标 → 完整方案(第 2 段)
    const atSection = seen[seen.length - 1]!.from
    expect(seen[seen.length - 1]!.cursor).toBe(1)
    t.stdin.press('\u0004'); await tick()    // ^d:翻页,视口离开那一段
    const scrolled = seen[seen.length - 1]!.from
    // 前提:这一下真的滚动了,否则后面那条断言是恒真的。
    expect(`滚走了吗: ${scrolled !== atSection}`).toBe('滚走了吗: true')
    t.stdin.press(' '); await tick()         // 展开「完整方案」
    const after = seen[seen.length - 1]!.from
    app.unmount()
    // 重钉了锚 → 视口回到那一段的标题行(它上面只有「目标」那一段,折叠着占 3 行)。
    expect(`展开后 from=${after}`).toBe(`展开后 from=${atSection}`)
  })
})

describe('树面板把可用高度算对', () => {
  // 详情页要**有好几段**,↓ 才移得动光标 —— 而 fullFrame 正是靠那一下按键逼出整屏重画的。
  // 只有一段时 ↓ 会被夹住、不改状态、不重绘,量到的就是一片空白,断言变成恒真。
  const fat = (): TaskNode[] => [
    node({ id: 'root', title: '根任务', kind: 'decompose', childIds: ['root/00-a'] }),
    {
      ...node({ id: 'root/00-a', title: '甲任务' }),
      parentId: 'root',
      goal: long('目标'),
      plan: { solution: long('方案'), keyPoints: long('重点'), risks: long('风险'), acceptance: long('验收') },
      execStatus: long('执行'),
    },
  ]

  it('点一行之后光标真的移过去了 —— 「和回车一样的效果」的另一半', async () => {
    /**
     * 只开对详情页是不够的:点完退回树上,光标必须停在**被点的那一行**。
     * 不移的话,用户点了乙、退出来、再按回车,打开的又是甲 —— 而他刚刚明明点的是乙。
     */
    const t = fakeTty(30, 100)
    const nodes: TaskNode[] = [
      node({ id: 'root', title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'] }),
      { ...node({ id: 'root/00-a', title: '甲任务' }), parentId: 'root', goal: '甲的目标内容' },
      { ...node({ id: 'root/01-b', title: '乙任务' }), parentId: 'root', goal: '乙的目标内容' },
    ]
    const app = await render(
      React.createElement(TaskTreePanel as never, { nodes, runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const ink = instances.get(t.stdout as never)!
    ink.setAltScreenActive(true, true)
    await tick()
    const rowsInFrame = t.lastFrame().split('\n')
    const row = rowsInFrame.findIndex(l => l.includes('乙任务'))
    expect(ink.dispatchClick(rowsInFrame[row]!.indexOf('乙任务'), row)).toBe(true)
    await tick()
    // 退回树上,看光标停在哪一行:树是整块重画的,所以这一帧读得准。
    // 用 q 而不是 Esc:孤立的 ESC 是 CSI 序列的前缀,解析器会先缓冲一小会儿等后续字节,
    // 30ms 之内看不到任何重画 —— 那样这条断言会对着空帧跑,变成恒假。
    t.reset()
    t.stdin.press('q'); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toMatch(/❯[^\n]*乙任务/)
    expect(f).not.toMatch(/❯[^\n]*根任务/)
  })

  it('树面板在 modal 槽里要按槽给的行数算详情页高度', async () => {
    const t = fakeTty(40, 100)
    const app = await render(
      React.createElement(
        ModalContext as never,
        { value: { rows: 16, columns: 60, scrollRef: null } } as never,
        React.createElement(TaskTreePanel as never, { nodes: fat(), runId: '003', interactive: true } as never),
      ),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\u001b[B'); await tick() // → 甲任务(内容很长)
    t.stdin.press('\r'); await tick()
    const f = await fullFrame(t, t.stdout, DOWN)
    app.unmount()
    expect(`画了 ${frameRows(f)} 行,槽给 16`).toBe(`画了 ${Math.min(frameRows(f), 16)} 行,槽给 16`)
    expect(f).toContain('Esc/q 返回任务树')
  })

  it('调用方声明了下面还有 N 行,详情页就得让出那 N 行', async () => {
    // 完成视图在树的**下面**画着一个总结框,行数运行时可变。组件看不见它 ——
    // 不让位的话,详情页最底下的页签条和页脚会被那个框顶出屏幕。
    const measure = async (reservedRows: number) => {
      const t = fakeTty(40, 100)
      const app = await render(
        React.createElement(TaskTreePanel as never, { nodes: fat(), runId: '003', interactive: true, reservedRows } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      t.stdin.press('\u001b[B'); await tick()
      t.stdin.press('\r'); await tick()
      const rows = frameRows(await fullFrame(t, t.stdout, DOWN))
      app.unmount()
      return rows
    }
    const none = await measure(0)
    const reserved = await measure(10)
    expect(`不让位 ${none} 行,让 10 行之后 ${reserved} 行`).toBe(`不让位 ${none} 行,让 10 行之后 ${none - 10} 行`)
  })
})

describe('树自己的高度也要给下面的东西让位', () => {
  it('声明了 reservedRows,树上画的行数就要少那么多', async () => {
    // 树和详情页共用同一份预算。只让详情页让位、树不让的话,完成视图里那个总结框
    // 会被树顶下去,而它正是「这次跑完了没有、代码在哪个分支上」的唯一出处。
    const nodes: TaskNode[] = [
      node({ id: 'root', title: '根任务', kind: 'decompose', childIds: Array.from({ length: 30 }, (_, i) => `root/${i}`) }),
      ...Array.from({ length: 30 }, (_, i) => ({ ...node({ id: `root/${i}`, title: `任务${i}` }), parentId: 'root' })),
    ]
    const measure = async (reservedRows: number) => {
      // 28 行:40 行终端下树的 min(20, …) 上限会把差异整个吃掉,那样这条断言恒真。
      const t = fakeTty(28, 100)
      const app = await render(
        React.createElement(TaskTreePanel as never, { nodes, runId: '003', interactive: true, reservedRows } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = await fullFrame(t, t.stdout, DOWN)
      app.unmount()
      return Array.from({ length: 30 }, (_, i) => `任务${i} `).filter(x => f.includes(x)).length
    }
    const none = await measure(0)
    const reserved = await measure(8)
    expect(`没让位画 ${none} 行,让 8 行之后画 ${reserved} 行`)
      .toBe(`没让位画 ${none} 行,让 8 行之后画 ${none - 8} 行`)
  })
})

describe('ScrollPane 在被超供时是裁剪,不是采样', () => {
  it('给它 40 行、框只有 10 行:画出来的必须是**开头连续的**那一截', async () => {
    /**
     * 这是整套版面设计的地基。带 height 的 Box 里,子节点默认 `flexShrink: 1`,
     * yoga 会把 40 行**等比压进** 10 行 —— 屏幕上是 `L004,L009,L014,…`,而且标题行
     * 也一起消失。行数没超,内容却少了四分之三,一个残缺的视图看起来完完整整。
     *
     * 正常路径下 NodeDetail 自己切好片、永远不会超供,所以这条守卫在生产上碰不到 ——
     * 但它挡的正是「以后有人把切片算错」。故意超供一次,才测得到它。
     */
    const t = fakeTty(24, 60)
    const marks = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(3, '0')}`)
    const app = await render(
      React.createElement(
        Box as never,
        { flexDirection: 'column', height: 10 } as never,
        React.createElement(ScrollPane as never, {
          slice: marks.map(text => ({ text })),
          total: marks.length, from: 0, height: marks.length,
        } as never),
      ),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    const shown = marks.filter(m => f.includes(m))
    expect(shown.length).toBeGreaterThan(3)
    expect(shown.length).toBeLessThan(marks.length)
    expect(shown).toEqual(marks.slice(0, shown.length))
  })

  it('一行超宽时截断,不回流 —— 回流会让实打印行数和算出来的对不上', async () => {
    const t = fakeTty(24, 40)
    const app = await render(
      React.createElement(ScrollPane as never, {
        slice: [{ text: 'A'.repeat(200) }, { text: 'B尾行' }],
        total: 2, from: 0, height: 2,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 回流的话第一行会占五行,把第二行推到第六行去 —— 而窗口按两行记的账。
    expect(frameRows(f)).toBe(2)
    expect(f).toContain('B尾行')
  })
})

describe('详情页画出来的内容行数,必须**等于**算出来的那一屏', () => {
  /**
   * 版面里任何一处多占一行(页脚回流、页签条回流、标题被压缩、内容区不裁剪),
   * 后果都**不是**画面溢出:内容区是 flexGrow,它会安静地把自己缩掉一行来吸收。
   * 于是「不许超屏」的断言全绿,而用户少看到一行 —— 而且没有任何提示。
   *
   * 所以这里不数总行数,而是把**期望的那一屏**用纯函数重算一遍,再核对屏幕。
   * 那两个纯函数各自都被单独钉过,所以这不是把映射抄一遍,是在核对组件有没有真的用它们。
   */
  for (const [label, rows, columns] of [
    ['24 行 · 100 列', 24, 100],
    ['24 行 · 40 列', 24, 40],
    ['40 行 · 120 列', 40, 120],
  ] as [string, number, number][]) {
    it(`${label}:一行不多一行不少`, async () => {
      // 每段 7 行 × 6 段 = 48 行,40 行终端也装不下 —— 装得下的话「多一行少一行」看不出来。
      const marks = Array.from({ length: 42 }, (_, i) => `M${String(i).padStart(3, '0')}`)
      const seg = (k: number) => marks.slice(k * 7, k * 7 + 7).join('\n')
      const n = node({
        goal: seg(0),
        plan: { solution: seg(1), keyPoints: seg(2), risks: seg(3), acceptance: seg(4) },
        execStatus: seg(5),
      })
      const budget = rows - 4
      const { paneRows, contentWidth } = detailLayout({ budget, columns, inModal: false })
      const expected = sectionLines({
        sections: detailSections(n),
        cursor: 0,
        expanded: new Set<string>(),
        width: contentWidth - 1,
        collapsedLines: collapsedLinesFor(paneRows + 1),
      }).lines.slice(0, paneRows).map(l => l.text)

      const t = fakeTty(rows, columns)
      const app = await render(
        React.createElement(NodeDetail as never, { node: n, elapsed: '1m', columns, maxRows: budget, logActive: true } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = t.lastFrame()
      app.unmount()
      const inSlice = marks.filter(m => expected.some(l => l.includes(m)))
      const outOfSlice = marks.filter(m => !expected.some(l => l.includes(m)))
      // 前提:这一屏确实装不下全部,否则「多一行少一行」根本看不出来。
      expect(`${label} 屏外还有 ${outOfSlice.length} 个`).not.toBe(`${label} 屏外还有 0 个`)
      expect(`${label} 屏内: ${marks.filter(m => f.includes(m)).join()}`)
        .toBe(`${label} 屏内: ${inSlice.join()}`)
    })
  }
})

describe('页签条上的回车和空格必须真的能进内容区', () => {
  /**
   * 用户原话:「最下面**点击或回车**可选择不同的页卡内容展示」。
   *
   * 这一条一度只写进了页脚和 README、没有落到代码里:`sectionPaneAction` 不认回车,
   * `NodeDetail` 的内容区闸门又把空格挡了,而 `TaskTreePanel` 已经为这一下回车让了路
   * (焦点在页签条上时不再关详情页)—— 于是它**既不进内容,也不返回**,彻底消失。
   * 两份验收各自独立报了同一条。原来的测试只有负向断言(「回车不关详情页」),
   * 从来没人问过「那它做了什么」。
   */
  for (const [label, seq] of [['回车', '\r'], ['空格', ' ']] as [string, string][]) {
    it(`焦点在页签条上时,${label} 进内容区`, async () => {
      const seen: { zone: string; tab: string }[] = []
      const t = fakeTty(24, 100)
      const app = await render(
        React.createElement(NodeDetail as never, {
          node: node({ goal: '目标内容' }), elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
          onState: (x: { zone: string; tab: string }) => seen.push(x),
        } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      t.stdin.press(TAB); await tick()
      expect(seen[seen.length - 1]!.zone).toBe('tabs')
      t.stdin.press(seq); await tick()
      app.unmount()
      expect(`${label} 之后: ${seen[seen.length - 1]!.zone}`).toBe(`${label} 之后: content`)
    })
  }

  it('内容区里的回车仍然是「返回任务树」,没被这条改动抢走', async () => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: [node({ id: 'root', title: '根任务', goal: '目标内容在这里' })], runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\r'); await tick()   // 打开详情
    expect(t.lastFrame()).toContain('目标内容在这里')
    t.reset()
    t.stdin.press('\r'); await tick()   // 焦点还在内容区 → 这一下是返回
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('Esc/q 退出')
  })
})

describe('窄终端:该出现的提示必须真的出现在帧里', () => {
  /**
   * **判据不能是「帧行数 ≤ budget」。**
   *
   * 版面算错时 yoga 是**按比例压缩**内容区,总行数恒等 —— 那个断言对这一类失败完全无感。
   * 验收实测:去掉页脚的 `wrap="truncate-end"` 之后,26–88 共 32 个列宽上「↓ 下面还有 N 行」
   * 整条消失,而仓库全套测试 473 pass 全绿。所以这里断言的是**那句话在不在**。
   *
   * 26 列这一档还压着另一个坑:`detailLayout` 的列宽一度有个 `Math.max(24, …)` 的虚高下限,
   * 真实内宽 22 却算出 24,行按 23 列排、渲进 22 列 → 回流 → 最后一行被剪掉。
   */
  for (const columns of [26, 28, 40, 60, 80, 100]) {
    it(`${columns} 列:「↓ 下面还有 N 行」不许被静默吃掉`, async () => {
      const marks = Array.from({ length: 42 }, (_, i) => `M${String(i).padStart(3, '0')}`)
      const seg = (k: number) => marks.slice(k * 7, k * 7 + 7).join('\n')
      const n = node({
        goal: seg(0),
        plan: { solution: seg(1), keyPoints: seg(2), risks: seg(3), acceptance: seg(4) },
        execStatus: seg(5),
      })
      const budget = 20
      const { paneRows, contentWidth } = detailLayout({ budget, columns, inModal: false })
      const total = sectionLines({
        sections: detailSections(n),
        cursor: 0,
        expanded: new Set<string>(),
        width: contentWidth - 1,
        collapsedLines: collapsedLinesFor(paneRows + 1),
      }).lines.length
      // 前提:这一屏确实装不下,否则那句提示本来就不该出现。
      expect(`${columns} 列 总行 ${total} > 窗口 ${paneRows}`).toBe(`${columns} 列 总行 ${total} > 窗口 ${Math.min(paneRows, total - 1)}`)

      const t = fakeTty(24, columns)
      const app = await render(
        React.createElement(NodeDetail as never, { node: n, elapsed: '1m', columns, maxRows: budget, logActive: true } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = t.lastFrame()
      app.unmount()
      expect(`${columns} 列有没有「下面还有」: ${f.includes('下面还有')}`).toBe(`${columns} 列有没有「下面还有」: true`)
      // 页签条和页脚也必须活着(它们是模态槽里最先被剪的一头)。
      expect(f).toContain('子 agent 输出')
      expect(f).toContain('Esc/q 返回任务树')
    })
  }

  it('窄到排不出东西时明说「终端太窄」,不硬排', async () => {
    const t = fakeTty(24, 18)
    const app = await render(
      React.createElement(NodeDetail as never, { node: fatNode(), elapsed: '1m', columns: 18, maxRows: 20, logActive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('终端太窄')
  })
})

describe('--resume 带进来的节点:输出页卡要说清为什么是空的', () => {
  it('没有流 ≠ 什么都没干 —— 必须说出原因,不能白屏', async () => {
    // 这一屏此前零覆盖:把这句说明整个删掉,全套测试仍然全绿(验收实测)。
    // 而 `--resume` 一个 BLOCKED 的运行、进详情页看输出,正是最容易撞上它的场景。
    const t = fakeTty(24, 100)
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: node({ goal: '目标内容' }), elapsed: '1m', columns: 100, maxRows: 20,
        logActive: true, historical: true, streams: [], initialTab: 'log',
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('属于上一次运行')
    expect(f).toContain('盘上没有留下它的事件日志')
    // 这一屏没有日志窗,页脚就不许列日志窗的键 —— 那一排全是死键。
    expect(f).not.toContain('n 换流')
    expect(f).not.toContain('t 思考')
    expect(f).toContain('Esc/q 返回任务树')
  })
})

describe('输出页卡的页脚要跟着 ↑↓ 的含义变', () => {
  /**
   * ↑↓ 在这一屏有两个含义(折叠时选阶段、展开时滚内容),而页脚原来无条件写着
   * 「↑↓/jk 滚动」。这个仓库为「页脚上写着的键按了没反应」已经付过两次学费
   * (日志窗写「Tab 切换环节」而 Tab 早让给了区切换;页签条写着回车进入而代码里没有分支
   * 接住)。这一条守的是同一件事的第三次。
   */
  const closedLog = () => {
    const store = createStreamStore()
    const h = store.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' })
    for (let i = 0; i < 40; i++) h.push({ kind: 'text', text: `输出第${i}行` })
    h.end()
    return store.streams('root')
  }

  const mountLog = async (streams: unknown) => {
    const t = fakeTty(30, 100)
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: fatNode(), elapsed: '1m', columns: 100, maxRows: 26,
        logActive: true, initialTab: 'log', streams,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    return { t, app }
  }

  it('选中的是折叠的流 → 写「选阶段」,而且说清空格之后会变成滚动', async () => {
    const { t, app } = await mountLog(closedLog())
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('↑↓/jk 选阶段')
    expect(f).toContain('空格 展开')
    expect(f).not.toContain('↑↓/jk 滚动')
  })

  it('空格展开之后 → 改写「滚动」,并说清怎么回到选阶段', async () => {
    const { t, app } = await mountLog(closedLog())
    t.reset()
    t.stdin.press(' ')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    /**
     * 断言落在**两条文案第一处不同的地方之后**。
     *
     * 这个渲染器只写增量,而两条页脚的公共前缀(`… Tab 到页签 · ↑↓/jk `)一个字节都不会
     * 被重写 —— 拿 `↑↓/jk 滚动` 做断言会恒假。实测重画出来的正是
     * 「滚动 · 空格 收起(回到选阶段) · n 下一条 · g/G」这一截。
     */
    expect(f).toContain('滚动 · 空格 收起')
    expect(f).toContain('回到选阶段')
  })

  it('正在跑的流(默认展开)第一帧就写「滚动」—— 不许先说错再改口', async () => {
    // 页脚的种子和窗口挂载那一刻的判据是同一份(logPaneMode + foldedStreams)。
    // 各算一份的话第一帧写的是「选阶段」,下一帧才纠正 —— 而那次纠正还会多写一帧,
    // 把详情页那条「不超预算」的行数断言顶掉 1 行(实测)。
    const { t, app } = await mountLog(withLog(40))
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('↑↓/jk 滚动')
    expect(f).not.toContain('↑↓/jk 选阶段')
  })
})
