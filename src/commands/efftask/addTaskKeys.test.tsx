/**
 * `a` 键的接线,以及那一屏的两个闩。
 *
 * 真渲染 + 真按键 —— 这个仓库的教训是「读不等于跑」,而且「真组件真帧 ≠ 真断言」:
 * 断言必须在**坏版本上会红**。所以这里测的是行为(回调被调了几次、参数是谁、切没切屏),
 * 不是帧里有没有某几个字。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { AddTask } from './AddTask.js'
import { LineInput } from './LineInput.js'
import type { AddTaskScope } from '../../tools/efftask/addTask.js'

const ENTER = '\r'
const CTRL_A = String.fromCharCode(1)
const NOW = new Date().toISOString()
const ESC = '\u001b'
/**
 * 必须**等过 ink 的转义消歧窗口**(App.tsx 里是 50ms)。30ms 的话裸 ESC 根本不会被派发,
 * 于是每一条「Esc 怎么样」都恒假 —— 这个仓库在别处踩过两次,注释各记了一遍。
 */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 120))

function fakeTty(cols = 160) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: cols, rows: 60,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] }),
  mk('root/01-a', { title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
]

async function mountTree(props: Partial<React.ComponentProps<typeof TaskTreePanel>> = {}) {
  const t = fakeTty()
  const app = await render(
    <TaskTreePanel nodes={TREE()} runId="003" interactive onExitKey={() => {}} {...props} />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { t, app }
}

/** 树上按一下回车进详情页。 */
async function mountDetail(props: Partial<React.ComponentProps<typeof TaskTreePanel>> = {}) {
  const m = await mountTree(props)
  m.t.stdin.press(ENTER)
  await tick()
  return m
}

describe('a 键(详情页)', () => {
  it('把详情页那个节点交给回调', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onAddTask: n => { seen.push(n.id); return undefined } })
    t.stdin.press('a')
    await tick()
    app.unmount()
    expect(seen).toEqual(['root'])
  })

  /**
   * `plain` 守卫。本 fork 的 `internal_exitOnCtrlC` 是 false,Ctrl 组合键被**原样派发**给
   * 每一个监听者,而带 ctrl 时 `input` 就是键名本身。
   */
  it('Ctrl+A 不触发', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onAddTask: n => { seen.push(n.id); return undefined } })
    t.stdin.press(CTRL_A)
    await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  /**
   * 判据用 `input` 而不是小写化后的 `k`。这一屏本来就在教用户按 Shift(`R 重做失败环节`),
   * 而 `a` 紧挨着 `s`(跳过失败环节)。
   */
  it('大写 A 不触发', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onAddTask: n => { seen.push(n.id); return undefined } })
    t.stdin.press('A')
    await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  /**
   * 被拒时**不许把用户踢回任务树**:准入是同步内存读,而切屏会把整棵详情页卸载,
   * 用户展开到哪一段、读到第几行全没了。
   */
  it('被拒时留在详情页,并且把理由画到页脚', async () => {
    const { t, app } = await mountDetail({ onAddTask: () => '这个任务此刻正在运行' })
    t.reset()
    t.stdin.press('a')
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 还在详情页(详情页才有页签条),而且那句话真的画出来了
    expect(frame).toContain('这个任务此刻正在运行')
  })

  it('页脚只在**真准入**通过时才宣告这个键', async () => {
    const off = await mountDetail({ onAddTask: () => undefined, addTaskAvailable: () => false })
    const noHint = off.t.lastFrame()
    off.app.unmount()
    const on = await mountDetail({ onAddTask: () => undefined, addTaskAvailable: () => true })
    const hint = on.t.lastFrame()
    on.app.unmount()
    expect(hint).toContain('a 新增任务')
    expect(noHint).not.toContain('a 新增任务')
  })
})

describe('a 键(任务树上)', () => {
  it('不用先进详情页 —— 树上直接按就作用在光标那一行', async () => {
    const seen: string[] = []
    const { t, app } = await mountTree({ onAddTask: n => { seen.push(n.id); return undefined } })
    t.stdin.press('a')
    await tick()
    app.unmount()
    expect(seen).toEqual(['root'])
  })

  it('树上被拒时也要把理由画出来', async () => {
    const { t, app } = await mountTree({ onAddTask: () => '这一趟的任务数已经到上限' })
    t.reset()
    t.stdin.press('a')
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('已经到上限')
  })

  it('树上的 Ctrl+A 同样不触发', async () => {
    const seen: string[] = []
    const { t, app } = await mountTree({ onAddTask: n => { seen.push(n.id); return undefined } })
    t.stdin.press(CTRL_A)
    await tick()
    app.unmount()
    expect(seen).toEqual([])
  })
})

const scope = (over: Partial<AddTaskScope> = {}): AddTaskScope => ({
  ok: true,
  anchor: mk('root', { title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] }),
  reopen: [],
  chain: ['root'],
  ...over,
})

async function mountGate(props: Partial<React.ComponentProps<typeof AddTask>> = {}) {
  const t = fakeTty()
  const confirms: { prompt: string; title: string }[] = []
  let cancels = 0
  const app = await render(
    <AddTask
      scope={scope()}
      previewId={title => `root/02-${title}`}
      onConfirm={(prompt, title) => { confirms.push({ prompt, title }) }}
      onCancel={() => { cancels++ }}
      {...props}
    />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { t, app, confirms, cancels: () => cancels }
}

describe('新增任务关口', () => {
  it('先停在输入屏(提示词是空的,确认没有意义)', async () => {
    const g = await mountGate()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(frame).toContain('写下这个任务的提示词')
  })

  it('写完回到确认屏,后果和提示词都印出来', async () => {
    const g = await mountGate()
    g.t.stdin.press('修一下登录超时')
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(frame).toContain('确认新增任务')
    expect(frame).toContain('修一下登录超时')
    // 还没确认
    expect(g.confirms.length).toBe(0)
  })

  /**
   * **这一条是这一屏存在两态的全部理由。**
   *
   * vendored 渲染器把一个 stdin 块拆成多个 InputEvent **同步**派发,而卸载要等下一帧。
   * 「打完字连敲两下回车」是最常见的输入习惯 —— 排成「输入 → 确认」的话,第二下回车会
   * 落在确认屏上,用户从没看见过后果,任务已经加进去了。
   */
  it('连按两下回车不会直接确认 —— 第二下只是停在确认屏', async () => {
    const g = await mountGate()
    g.t.stdin.press('写点什么')
    await tick()
    /**
     * **两下之间不 await** —— 那才是「连按」的模型:没有 React 提交、没有重绘,
     * 第二下拿到的是第一下同步改过的 ref。
     *
     * ⚠ 别写成 `press(ENTER + ENTER)`:实测那**整块是个空操作**(解析器不把它拆成两个
     * 回车事件),于是那样写出来的断言在**坏版本上也是绿的** —— 这个仓库把这一类
     * 叫「真组件真帧 ≠ 真断言」。
     */
    g.t.stdin.press(ENTER)
    g.t.stdin.press(ENTER)
    await tick()
    g.app.unmount()
    expect(g.confirms.length).toBe(0)
  })

  /**
   * 确认屏自己那把闩(`useSettleOnce`)。下游是 `startRun` / 落盘,发两次就是两个任务
   * (而且两次算出同一个 index → 同一个 id → 第二份 writeNode 覆盖第一份)。
   */
  it('确认屏上连按两下回车只确认一次', async () => {
    const g = await mountGate()
    g.t.stdin.press('写点什么')
    await tick()
    g.t.stdin.press(ENTER)   // 提交文字,回到确认屏
    await tick()
    // 两下之间不 await —— 见上一条用例里那段注释。
    g.t.stdin.press(ENTER)
    g.t.stdin.press(ENTER)
    await tick()
    g.app.unmount()
    expect(g.confirms.length).toBe(1)
  })

  it('确认之后再按取消也不发第二次(确认和取消共用一把闩)', async () => {
    const g = await mountGate()
    g.t.stdin.press('写点什么')
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.t.stdin.press('q')
    await tick()
    g.app.unmount()
    expect(g.confirms.length).toBe(1)
    expect(g.cancels()).toBe(0)
  })

  it('e 回到输入屏,而且原文还在(不是从空开始)', async () => {
    const g = await mountGate()
    g.t.stdin.press('第一版文字')
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.t.reset()
    g.t.stdin.press('e')
    await tick()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(frame).toContain('第一版文字')
  })

  it('输入屏上什么都没写就 Esc = 取消整个关口', async () => {
    const g = await mountGate()
    g.t.stdin.press(ESC)
    await tick()
    g.app.unmount()
    expect(g.cancels()).toBe(1)
  })

  /**
   * 写过之后 Esc **不许**直接丢掉 —— 「用户刚写完一段话,一下 Esc 把它丢掉」是这个仓库
   * 反复付账的那一类。它回确认屏,那里还有 `q` 这个明确的出口。
   */
  it('写过之后 Esc 回确认屏,不丢文字', async () => {
    const g = await mountGate()
    g.t.stdin.press('别丢了我')
    await tick()
    g.t.stdin.press(ESC)
    await tick()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(g.cancels()).toBe(0)
    expect(frame).toContain('别丢了我')
  })

  /**
   * 权限对话框画在关口之上时键盘归对话框。缺了这个守卫,一下回车既确认了新增
   * **又批准了一个待确认的工具**,而执行环节的确认可以是带写能力的 Bash。
   */
  it('isActive=false 时一个键都不认(两态都是)', async () => {
    const g = await mountGate({ isActive: false })
    g.t.stdin.press('写点什么')
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.app.unmount()
    expect(g.confirms.length).toBe(0)
    expect(g.cancels()).toBe(0)
  })

  it('提交给调用方的是逐字的提示词和从它派生的标题', async () => {
    const g = await mountGate()
    g.t.stdin.press('把超时从 3s 改成 10s')
    await tick()
    g.t.stdin.press(ENTER)
    await tick()
    g.t.stdin.press('y')
    await tick()
    g.app.unmount()
    expect(g.confirms).toEqual([{ prompt: '把超时从 3s 改成 10s', title: '把超时从 3s 改成 10s' }])
  })
})

describe('LineInput 的三处改动', () => {
  async function inputWith(props: Partial<React.ComponentProps<typeof LineInput>>, chunks: string[]) {
    const t = fakeTty()
    let got: { text: string; dropped: number } | null = null
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={2000}
        onSubmit={(text, info) => { got = { text, dropped: info.dropped } }}
        onCancel={() => {}}
        {...props}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    for (const c of chunks) { t.stdin.press(c); await tick() }
    const frame = t.lastFrame()
    t.stdin.press(ENTER)
    await tick()
    app.unmount()
    return { got: got as { text: string; dropped: number } | null, frame }
  }

  it('keepNewlines 为真:多行粘贴保留换行', async () => {
    const r = await inputWith({ keepNewlines: true }, ['第一行\n第二行'])
    expect(r.got?.text).toBe('第一行\n第二行')
  })

  it('默认(不给这个 prop)逐字节维持现状:换行折成空格', async () => {
    const r = await inputWith({}, ['第一行\n第二行'])
    expect(r.got?.text).toBe('第一行 第二行')
  })

  it('CRLF 只算一个换行(否则 keepNewlines 下会变成两个)', async () => {
    const r = await inputWith({ keepNewlines: true }, ['甲\r\n乙'])
    expect(r.got?.text).toBe('甲\n乙')
  })

  /** 超上限在这之前是**静默**的:提交 abcde 而整帧里没有一个字提到丢弃。 */
  it('超上限时说出丢了几个字,并且把这个数交给调用方', async () => {
    const r = await inputWith({ maxChars: 5 }, ['abcdefghij'])
    expect(r.got?.text).toBe('abcde')
    expect(r.got?.dropped).toBe(5)
    expect(r.frame).toContain('5')
    expect(r.frame).toContain('没有收进来')
  })

  it('丢字计数是累计的(连按十下要知道一共丢了多少)', async () => {
    const r = await inputWith({ maxChars: 3 }, ['abcd', 'ef'])
    expect(r.got?.dropped).toBe(3)
  })

  /**
   * 4000 码点在 100 列下是 40 个终端行,而 `/et` 非全屏渲染在对话流里 ——
   * 帧高超过视口会逼出整屏重置,而且切掉的是**顶部**(标题和 hint)。
   */
  it('超高时只画尾部,并且把「上面还有 N 行」印在被裁范围之外', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `行${i}`).join('\n')
    const r = await inputWith({ keepNewlines: true, maxBodyRows: 4 }, [many])
    expect(r.frame).toContain('上面还有')
    // 尾部在,头部不在
    expect(r.frame).toContain('行11')
    expect(r.frame).not.toContain('行0\n')
  })
})

/**
 * 验收席在这一屏上抓到的四条,每一条都钉住一个**观察到的读数**。
 *
 * 共同的形状是「屏幕上写着的和实际画出来的不是一回事」—— 而用户正是在这一屏按下
 * 不可逆确认的。
 */
describe('确认屏不许说假话', () => {
  async function gateWith(prompt: string, cols: number) {
    const t = fakeTty(cols)
    const app = await render(
      <AddTask
        scope={scope()}
        previewId={() => 'root/02-x'}
        initialPrompt={prompt}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    return frame
  }

  /** 带着上次写的东西回来时直接停在确认屏(不用再按一次回车)。 */
  it('给了 initialPrompt 就直接是确认屏,而且那段话在里面', async () => {
    const frame = await gateWith('上次写了一半的提示词', 120)
    expect(frame).toContain('确认新增任务')
    expect(frame).toContain('上次写了一半的提示词')
  })

  /**
   * 上一版:`<Text wrap="truncate-end">{整段}</Text>` + 一句「以下显示前 400 字」,
   * 而 ink 按框宽再截一次 —— 两位验收员各自量到 120 列下实际只画出 40~57 个字。
   */
  it('长提示词按真实宽度折行,而不是塞进一个 Text 让 ink 截掉', async () => {
    const frame = await gateWith('甲'.repeat(300), 100)
    // 折行之后,第 200 个字也该在屏幕上(单个 Text + truncate 的话它根本画不出来)
    expect(frame.split('甲').length - 1).toBeGreaterThan(150)
  })

  /**
   * 40 行提示词会把标题和全部 ⚠ 后果行顶出屏幕(非全屏时终端滚掉的正是顶部)。
   */
  it('多行提示词不许把标题和后果顶出屏幕,而且要说清没显示几行', async () => {
    const frame = await gateWith(Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n'), 120)
    expect(frame).toContain('确认新增任务')      // 标题还在
    expect(frame).toContain('挂在')              // 后果行还在
    expect(frame).toContain('下面还有')          // 截断提示在被裁那段之外
    expect(frame).not.toContain('行39')          // 尾巴真的被裁了
  })

  it('数字必须是真的:说「共 N 字 / M 行」就得是那个数', async () => {
    const frame = await gateWith('甲\n乙\n丙', 120)
    expect(frame).toContain('共 5 字')           // 3 个字 + 2 个换行
  })
})

describe('LineInput:超长单行也要裁', () => {
  /**
   * 验收席实测:100 列 / `maxBodyRows=8` 下,4000 字**单行**画出 49 个终端行、
   * 一句「上面还有」都没有 —— 而那正是这个 prop 注释自己写的那个场景。
   * 按 `split('\n')` 数逻辑行时,单行永远是 1 行。
   */
  it('4000 字单行要按折行之后的行数裁', async () => {
    const t = fakeTty(100)
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={4000} keepNewlines maxBodyRows={8}
        initialText={'丙'.repeat(2000)}
        onSubmit={() => {}} onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('上面还有')
  })

  it('Esc 那条路也要把「N 个字没有收进来」带出去', async () => {
    const t = fakeTty(120)
    let got: { text: string; dropped: number } | null = null
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={5}
        onSubmit={() => {}}
        onCancel={(text, info) => { got = { text, dropped: info.dropped } }}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('abcdefghij')
    await tick()
    t.stdin.press(ESC)
    await tick()
    app.unmount()
    expect(got).not.toBeNull()
    expect(got!.dropped).toBe(5)
  })

  it('被滤掉的控制字符也算「没有收进来」', async () => {
    const t = fakeTty(120)
    let got: { dropped: number } | null = null
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={100}
        onSubmit={(_t, info) => { got = { dropped: info.dropped } }}
        onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // 三个控制字节 + 三个可见字符
    t.stdin.press(`a${String.fromCharCode(7)}b${String.fromCharCode(0)}c${String.fromCharCode(127)}`)
    await tick()
    t.stdin.press(ENTER)
    await tick()
    app.unmount()
    expect(got).not.toBeNull()
    expect(got!.dropped).toBe(3)
  })
})

/**
 * `isActive` 要**两态都挡住**。
 *
 * ⚠ 上一条「isActive=false 时一个键都不认(两态都是)」实测**只覆盖确认态** ——
 * 剪掉输入屏那一路(`isActive={props.isActive}` 不传给 LineInput)它照样绿(接缝席剪线实测)。
 * 权限对话框画在关口之上时,打字的每个字符会同时喂给对话框,数字/字母还可能选中它的选项。
 */
describe('权限对话框在上面时,输入屏也要让出键盘', () => {
  it('isActive=false 时输入屏一个字符都不收', async () => {
    const g = await mountGate({ isActive: false })
    g.t.stdin.press('不该被收进去')
    await tick()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(frame).not.toContain('不该被收进去')
  })

  it('isActive=true 时照常收', async () => {
    const g = await mountGate({ isActive: true })
    g.t.stdin.press('应该收进去')
    await tick()
    const frame = g.t.lastFrame()
    g.app.unmount()
    expect(frame).toContain('应该收进去')
  })

  /**
   * 按 `e` 回去改一个错字,不该把「N 个字没有收进来」这条警告抹掉。
   *
   * 钉的是 `LineInput` 那个 `initialDropped` 接缝本身:这一屏重挂时内部计数从 0 起,
   * 而丢字是上一次发生的。(接缝席实测:4100 字 → 确认屏印「100 个字没有收进来」→
   * 按 `e` 再确认 → 那一行没了,而提示词仍然是被截断的。)
   */
  it('重挂输入屏时,上一次丢掉的字数要接着算', async () => {
    const t = fakeTty(120)
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={5} initialText="abcde" initialDropped={7}
        onSubmit={() => {}} onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('7 个字没有收进来')
  })

  it('不给 initialDropped 时从 0 起(现有四个调用点逐字不变)', async () => {
    const t = fakeTty(120)
    const app = await render(
      <LineInput
        title="t" hint="h" maxChars={5} initialText="abcde"
        onSubmit={() => {}} onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).not.toContain('没有收进来')
  })
})

/**
 * 变异测试抓出来的两个缺口(第二轮)。
 *
 * 这一组存在的理由和上面那些一样,但更该记一笔:它们钉的是**为验收修复本身**打的补丁,
 * 而验收席的核心指控正是「P0/P1 全落在没有任何探针的位置」。补丁没有探针 = 同一件事再来一次。
 */
describe('第二轮变异补上的两条', () => {
  /**
   * 提示词要**往上报**。不报的话,关口一被卸载(run 恰好跑完)或者确认之后被拒,
   * 用户写的几千字就没了 —— 而这正是那条修复的全部内容。
   */
  it('每次提示词变化都交给调用方(否则拒绝一次就白写)', async () => {
    const seen: { prompt: string; dropped: number }[] = []
    const t = fakeTty()
    const app = await render(
      <AddTask
        scope={scope()}
        previewId={() => 'root/02-x'}
        onPromptChange={(prompt, dropped) => { seen.push({ prompt, dropped }) }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('要往上报的这段话')
    await tick()
    t.stdin.press(ENTER)
    await tick()
    app.unmount()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)?.prompt).toBe('要往上报的这段话')
  })

  /**
   * 确认屏那个「共 N 字 / M 行」里的 **M 必须是折行之后的行数**。
   *
   * 按 `split('\n')` 数的话,一段没有换行的长文永远是「1 行」—— 而它在屏幕上占十几行,
   * 于是那个数字和用户看到的东西对不上,行数上限也就永远不会触发。
   * 粘一段长文本最常见的形态就是没有换行的一大段。
   */
  it('一整段没有换行的长文,行数要按折行算', async () => {
    const t = fakeTty(60)
    const app = await render(
      <AddTask
        scope={scope()}
        previewId={() => 'root/02-x'}
        initialPrompt={'甲'.repeat(400)}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 60 列下 400 个全角字符远超 8 行 → 必须触发行数上限并说出来
    expect(frame).toContain('下面还有')
    expect(frame).toContain('共 400 字')
    // 而且不能报成「1 行」
    expect(frame).not.toContain('/ 1 行')
  })
})
