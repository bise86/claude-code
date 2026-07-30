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
      // 刚打开时没有任何段落是展开的 → ↑↓ 是「选段落」。这个字段是「此刻 ↑↓ 归谁」
      // 唯一的观测口(屏幕上看不见模式),见 NodeDetail.onState 的注释。
      secMode: 'select',
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

/**
 * ↑↓ 的两个含义 —— 用户原话:「任务页卡上,和子 agent 上一样,选择项就是上下键看内容,
 * 空格缩起来后,上下键移动选择项目。」
 *
 * 断言一律落在 `onState`(cursor / from / secMode)上,不看帧文本:模式在屏幕上根本
 * 观测不到(渲染器只写增量),而页脚那半句只能证明「写对了」,证明不了「按下去是这个行为」。
 */
describe('段落区 ↑↓ 双语义', () => {
  it('折叠着 ↑↓ 选段落,展开后 ↑↓ 滚它的内容,收起又回到选段落', async () => {
    const { t, app, at } = await mount()
    expect(at().secMode).toBe('select')
    t.stdin.press(DOWN); await tick() // → 完整方案
    expect(at().cursor).toBe(1)
    const beforeExpand = at().from

    t.stdin.press(' '); await tick()
    expect(at().expanded).toEqual(['完整方案'])
    // 展开状态本身就是模式,不另存 state。
    expect(at().secMode).toBe('read')

    t.stdin.press(DOWN); await tick()
    // 光标**不动**(这一下不是「换段落」),视口往下走一行。
    expect(at().cursor).toBe(1)
    expect(at().from).toBe(beforeExpand + 1)
    t.stdin.press(UP); await tick()
    expect(at().from).toBe(beforeExpand)

    t.stdin.press(' '); await tick() // 收起
    expect(at().secMode).toBe('select')
    t.stdin.press(DOWN); await tick()
    app.unmount()
    // 收起之后 ↑↓ 又是「移动选择项目」。
    expect(at().cursor).toBe(2)
  })

  it('一个 chunk 里连按 ↓ 要滚多行 —— 而不是只滚一行', async () => {
    /**
     * 一个 stdin chunk 会被拆成多个按键事件**同步**派发,而 `useInput` 的 handler 只在
     * commit 之后才换。所以「滚到哪」必须在 handler 里从 ref 现算 —— 读 render 作用域的
     * `from` 时,一个 chunk 里后面几下全都基于同一个陈旧值、互相覆盖。
     * AgentLogPane 今天就有这个病(一个 chunk 4 个 ↑ 只动 1 行),而「按住 ↓ 一路读下去」
     * 正是这个功能的主要用法。
     */
    const { t, app, at } = await mount()
    t.stdin.press(' '); await tick() // 展开「目标」→ read
    expect(at().secMode).toBe('read')
    const from0 = at().from
    t.stdin.press(`${DOWN}${DOWN}${DOWN}`); await tick()
    app.unmount()
    expect(at().from).toBe(from0 + 3)
  })

  it('jjj / kkk 在 read 模式下也是逐行滚,而且合批计数', async () => {
    const { t, app, at } = await mount()
    t.stdin.press(' '); await tick()
    const from0 = at().from
    t.stdin.press('jjj'); await tick()
    expect(at().from).toBe(from0 + 3)
    t.stdin.press('kk'); await tick()
    app.unmount()
    expect(at().from).toBe(from0 + 1)
  })

  it('read 模式下 n 换下一段 —— 不必先收起', async () => {
    /** 这是从输出页卡搬过来的那半个逃生口:`n` 在两种模式下都认。 */
    const { t, app, at } = await mount()
    t.stdin.press(' '); await tick() // 展开「目标」
    expect(at().secMode).toBe('read')
    t.stdin.press('n'); await tick()
    expect(at().cursor).toBe(1)
    // 「目标」还是展开着的(n 只换选中项,不动展开状态),而选中的「完整方案」是折叠的
    // → 模式跟着选中项回到 select。
    expect(at().expanded).toEqual(['目标'])
    expect(at().secMode).toBe('select')
    // 循环:从最后一段按 n 回到第 0 段。
    for (let i = 0; i < 5; i++) { t.stdin.press('n'); await tick() }
    app.unmount()
    expect(at().cursor).toBe(0)
  })

  it('内容短到滚不动时,展开也**不**进 read —— 否则 ↑↓ 是死键', async () => {
    /**
     * 段落区和输出区的第一处结构差异:一条流动辄几百行,而一个刚起跑的节点只有一段
     * 一行的目标。展开之后总行数仍然 ≤ 视口高度时,`maxFrom` 是 0 —— 判成「滚动」的
     * 后果就是按下去屏幕一个字不动,而页脚正好写着「↑↓ 滚内容」。
     */
    const n = node()
    n.goal = '就一行目标'
    n.plan = { solution: '', keyPoints: '', risks: '', acceptance: '' }
    n.execStatus = ''
    const { t, app, at } = await mount({ node: n })
    t.stdin.press(' '); await tick()
    expect(at().expanded).toEqual(['目标'])
    expect(at().secMode).toBe('select')
    // 而它仍然是「选段落」:唯一的一段,↑↓ 夹在原地,但语义是真的。
    t.stdin.press(DOWN); await tick()
    app.unmount()
    expect(at().cursor).toBe(0)
  })

  it('段落列表在跑动中增长,模式**不**跟着翻面 —— 光标按标题走,不按下标', async () => {
    /**
     * 实测过的病:光标停在下标 2(「模型用量」)、空格展开 → 方案跑出来了、
     * 列表从 3 段变成 7 段 → 下标 2 现在指着「重点」→ 展开状态还挂在「模型用量」上 →
     * ↑↓ 的语义在用户手底下自己从「滚内容」翻回「选段落」,而他一个键都没按。
     */
    const before = node()
    before.plan = { solution: '', keyPoints: '', risks: '', acceptance: '' }
    before.execStatus = ''
    // 段落 = [目标, 阻断原因]
    before.blockedReason = long('阻断')
    // 方案跑出来了:四段插进「目标」和「阻断原因」之间。
    const after = { ...before, plan: node().plan }
    const t = fakeTty()
    const seen: { cursor: number; secMode: string; expanded: string[]; from: number }[] = []
    /**
     * 换节点必须由**父组件的 state** 换,不能用 `app.rerender(<NodeDetail .../>)`:
     * 这个夹具里 rerender 会让 NodeDetail 重新挂载(实测:展开状态和光标一起清零),
     * 于是这条测试测的就变成「重挂之后是不是干净的」——恒绿,而要钉的那件事没被碰到。
     * 真实运行里换的是 props(树每秒 tick 一次),组件实例是同一个。
     */
    const grow: { current?: () => void } = {}
    const Grower = (): React.ReactElement => {
      const [n, setN] = React.useState<TaskNode>(before)
      grow.current = () => setN(after)
      return (
        <NodeDetail
          node={n} elapsed="12s" logActive columns={110}
          onState={x => seen.push(x as never)}
        />
      )
    }
    const app = await render(
      <Grower />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const at = () => seen[seen.length - 1]!
    t.stdin.press(DOWN); await tick() // → 阻断原因(下标 1)
    t.stdin.press(' '); await tick()
    expect(at().expanded).toEqual(['阻断原因'])
    expect(at().secMode).toBe('read')
    // 往这一段里读几行 —— 视口此刻停在「阻断原因」的第 6 行附近。
    t.stdin.press(DOWN.repeat(6)); await tick()
    const beforeGrow = at().from

    // **没有按任何键**,只是节点长出了新段落。
    grow.current!()
    await tick()
    // 下标跟着那一段走(0 目标 / 1..4 方案四段 / 5 阻断原因)。
    expect(at().cursor).toBe(5)
    // 而模式一动不动 —— 用户还在读他刚展开的那一段。
    expect(at().secMode).toBe('read')
    /**
     * **视口也必须跟着那一段走。**
     *
     * 验收实测过只改光标不改锚的后果:光标跟着「阻断原因」走到了下标 5,而锚里那个
     * `stream: 1` 被 `headerAt(1)` 解成了**「完整方案」**的标题行 —— 用户正在读的那一行
     * 已经在屏幕外,而空格/`n`/模式派生作用在第 5 段。比不修更糟:改动前光标和锚都按
     * 下标、**互相一致**(一起指错段),两者分叉之后屏幕和键盘说的是两段不同的内容。
     *
     * 判据是「`from` 落在那一段的标题行上」——展开时锚的 delta 是 0(select() 钉的),
     * 而那一段现在在第 headerAt(5) 行。
     */
    expect(at().from).toBeGreaterThan(beforeGrow)
    // 而且它仍然归「读内容」:按 ↑ 视口退一行,光标一动不动。
    const afterGrow = at().from
    t.stdin.press(UP); await tick()
    expect(at().from).toBe(afterGrow - 1)
    expect(at().cursor).toBe(5)
    t.stdin.press(' '); await tick()
    app.unmount()
    // 收起的仍然是他展开的那一段,不是「现在下标 1 指着的那一段」。
    expect(at().expanded).toEqual([])
  })

  it('**同一个回合**里「空格 + ↓」:那一下 ↓ 必须按展开之后的语义走', async () => {
    /**
     * 这是 `measure()` 从几个常量改成一个函数、以及 handler 里现算模式的**全部理由**,
     * 而它此前一条测试都没有:别的用例在空格和箭头之间 `await tick()`,已经提交过一帧了。
     *
     * 真实场景是用户按住键或者快速连按两下 —— 两个 stdin chunk 落在同一个同步回合里,
     * 而 `useInput` 的 handler 只在 commit 之后才换。读上一帧的模式,那一下 ↓ 会被当成
     * 「换段落」(展开之前的语义),视口一动不动。
     */
    const { t, app, at } = await mount()
    // 两次 press 之间**不 await** —— 这才是同一个回合。
    t.stdin.press(' ')
    t.stdin.press(DOWN.repeat(3))
    await tick()
    app.unmount()
    expect(at().expanded).toEqual(['目标'])
    expect(at().secMode).toBe('read')
    // 光标没动、视口滚了 3 行:那三下走的是**展开之后**的语义。
    expect(at().cursor).toBe(0)
    expect(at().from).toBe(3)
  })

  it('同一回合里展开**把「滚得动」这件事本身翻过来**时,那一下 ↓ 也要按新版面走', async () => {
    /**
     * 变异测试实测出来的缺口:把 `measure(expandedRef.current, …)` 换成 render 作用域的
     * `measure(expanded, …)` 之后,上面那条「空格↓↓↓」照样绿 —— 因为模式本身读的是
     * `expandedRef.current`,陈旧的 `expanded` 只经由 `canScroll` 和 `from` 显形,而那条
     * 用例里两者恰好同值。
     *
     * 这一条专门造出**差异**:折叠时整份列表放得下(canScroll 假 → select),展开之后
     * 放不下(canScroll 真 → read)。同一个同步回合里「空格 + ↓」,陈旧的版面会算出
     * 「还是滚不动」→ 那一下 ↓ 变成移光标,视口一动不动。
     */
    const n = node()
    n.goal = Array.from({ length: 40 }, (_, i) => `目标第${i}行`).join('\n')
    n.plan = { solution: '', keyPoints: '', risks: '', acceptance: '' }
    n.execStatus = ''
    const { t, app, at } = await mount({ node: n, maxRows: 14 })
    // 前提:折叠着的时候是「选段落」(整份列表放得下)。
    expect(at().secMode).toBe('select')
    t.stdin.press(' ')
    t.stdin.press(DOWN)
    await tick()
    app.unmount()
    expect(at().expanded).toEqual(['目标'])
    expect(at().secMode).toBe('read')
    // 那一下 ↓ 走的是**展开之后**的版面:视口动了,光标没动。
    expect(at().from).toBe(1)
    expect(at().cursor).toBe(0)
  })

  it('滚不动的边界:总行数正好等于视口高度时仍然是 select', async () => {
    /**
     * `canScroll` 差一个等号(`>` 写成 `>=`)就会造出一个死键:`maxFrom` 是 0,而页脚
     * 写着「↑↓ 滚内容」。边界值必须有探针 —— 这正是 `sectionPaneMode` 第 1 条注释存在的理由。
     *
     * 造法:把可用高度压到刚好容纳展开后的全部行。段落只有「目标」一段(12 行正文),
     * maxRows 给到「标题 1 + 正文 12」正好等于 paneRows 的那个值。
     */
    const n = node()
    n.goal = Array.from({ length: 12 }, (_, i) => `目标第${i}行`).join('\n')
    n.plan = { solution: '', keyPoints: '', risks: '', acceptance: '' }
    n.execStatus = ''
    // 逐个高度试,找到「展开后 total === paneRows」那一档:此时 canScroll 必须为假。
    let hit = false
    for (let rows = 10; rows <= 26 && !hit; rows++) {
      const { t, app, at } = await mount({ node: n, maxRows: rows })
      t.stdin.press(' '); await tick()
      const expanded = at().expanded.length === 1
      const from = at().from
      t.stdin.press(DOWN); await tick()
      const moved = at().from !== from
      app.unmount()
      // 找的是「展开了、但一行都滚不动」那一档 —— 那一档的模式必须是 select。
      if (expanded && !moved) { expect(at().secMode).toBe('select'); hit = true }
    }
    expect(hit).toBe(true)
  })

  it('段落光标那个 ❯ 真的画在屏幕上 —— 不是只在 onState 里', async () => {
    /**
     * `onState.cursorShown` 是**独立重算**的(effect 里再调一次 `sectionCursor`),
     * 不是从渲染结果读的 —— 也就是说它是一个 look-alike:把渲染时那个 `cursor:` 改成 -1,
     * 屏幕上一个光标都没有,而所有 cursorShown 断言照旧全绿(验收实测存活)。
     */
    const { t, app } = await mount()
    app.unmount()
    expect(t.lastFrame()).toContain('❯')
  })

  it('「下面还有 N 行」那句提示也要跟着模式变', async () => {
    // select 模式下 ↑↓ 换的是段落,写「↑↓ 继续」就是那句「页脚上写着的键按了不是这个
    // 意思」的翻版 —— 而这一行比页脚更贴着内容,用户更容易当真。
    const { t, app, at } = await mount()
    expect(t.lastFrame()).toContain('^d 翻页')
    expect(t.lastFrame()).not.toContain('↑↓ 继续')
    t.stdin.press(' '); await tick()
    expect(at().secMode).toBe('read')
    app.unmount()
    expect(t.lastFrame()).toContain('↑↓ 继续')
  })

  it('页脚跟着模式变 —— 两句都不许写成假话', async () => {
    const { t, app, at } = await mount()
    // 首帧是整屏写,所以整句可靠。
    expect(t.lastFrame()).toContain('↑↓/jk 选段落')
    expect(t.lastFrame()).toContain('^u/^d 翻页')
    t.stdin.press(' '); await tick()
    expect(at().secMode).toBe('read')
    app.unmount()
    /**
     * 换页脚那一跳是**增量**重画,整句在缓冲里从来没出现过(实测:只剩
     * `滚内容 收起 选段落 n 下一段 …` 这些被改动的片段)。所以挑的是两个**只在
     * read 模式的页脚里出现**的片段 —— 写死一句「↑↓/jk 滚动」的话它们一个都不会有。
     */
    expect(t.lastFrame()).toContain('滚内容')
    expect(t.lastFrame()).toContain('n 下一段')
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
