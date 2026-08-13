/**
 * 权限确认弹出时,任务树面板必须**交出键盘**。
 *
 * 用户报的:「需要用户确认接受时,光标选中的任务回车同时会进入任务详情」。
 *
 * 根因是架构性的、而且是有意为之的一半:`/et` 声明了 `spawnsSubagents`,于是
 * `allowsPermissionDialogs` 让 REPL 把权限对话框画在面板**之上**(否则子 agent 要的
 * 批准根本没地方画,运行会永远等下去 —— 那是更早修过的另一个 bug)。两个组件因此同时
 * 挂着,而 ink 的 useInput 是**广播**的:一下回车,对话框收到,面板也收到。
 *
 * 所以这一档从两侧都测:面板在 suspended 时对每个键都不响应;计数器在并发下的行为。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'

/**
 * 方向键和 Esc 必须写成**显式转义**。
 *
 * 这个文件原来一个 ESC 字节都没有 —— 字面量被写文件的那一步吞掉了,剩下 '[B' 两个普通
 * 字符。于是「方向键也不动」「Esc 不能中断整个 run」这两条断言是**空的**:键根本没送到,
 * 什么都没发生自然成立。改成显式转义之后它们才真的在测被测行为。
 */
const DOWN = '\u001b[B'
const ESC = '\u001b'
const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 15))

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
  // 用 \u001b 转义写:字面量 ESC 会被编辑器吞掉,`//` 就成了行注释,函数体整个坏掉。
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: `任务${id}`, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  ...over,
})

/**
 * 详情视图独有的一行。
 *
 * **不能**用「子 agent 输出」当标志:那一段只在传了 streams 时才渲染,而这一档没传 ——
 * 于是 not.toContain('子 agent 输出') 是恒真的,那几条断言全是空的。这一点是被下面
 * 那条正向用例(「键盘要拿回来」)顺带暴露出来的:它按了回车、详情**真的**打开了,
 * 却因为找不到那个字符串而报红。
 */
const DETAIL_MARK = '返回任务树'
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'EXECUTING' }),
]

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('执行串行时顶上要说实话', () => {
  it('没有隔离工作区时,明说执行是串行的', async () => {
    // 不说的话顶上那个「并行 1/5」是在误导:用户看着 5 的上限却发现子任务一个一个来,
    // 只能怀疑是不是自己配错了 —— 而真实原因是 orchestrator 的 serialiseExecute。
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive serialExecute
        pool={() => ({ inUse: 1, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并行 1/5')
    expect(f).toContain('执行串行(无隔离工作区)')
  })

  /**
   * **第三档整趟跑下来必须有一个标记 —— 它是最危险的那一档。**
   *
   * 实测过它此前和「worktree 隔离并发」在表头上逐字相同(两者 `serialExecute` 都是
   * false、`pool` 都不画):唯一的标记给了最安全那一档,而多个执行者正在同时裸写用户
   * 当前目录的那一趟,屏幕上一个字都没有。
   */
  it('共享目录 + 并发:说的是「没有安全网」,不是「慢」', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive sharedParallel
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并发直写当前目录(无隔离)')
    // 两个标记是两件事,不能互相顶替。
    expect(f).not.toContain('执行串行')
  })

  it('隔离并行那一趟两个标记都不画', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('并发直写当前目录')
    expect(f).not.toContain('执行串行')
  })

  it('有隔离时不提 —— 那句话此时是假的', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并行 3/5')
    expect(f).not.toContain('执行串行')
  })
})
describe('suspended 时面板不吃任何键', () => {
  it('回车不再打开详情 —— 这就是用户报的那一下', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 详情视图的标志性内容不能出现。用户按的那一下回车是给上面那个权限对话框的。
    expect(f).not.toContain(DETAIL_MARK)
    expect(f).toContain('等你回答上面那个权限确认')
  })

  it('Esc / q 也不能顺手把整个 run 中断掉', async () => {
    // 这条比回车更凶:权限对话框上按 Esc 是「拒绝这次工具调用」,如果面板也收到,
    // 用户拒绝一次工具就把整个运行中断了。
    let exits = 0
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => { exits++ }} />,
    )
    t.stdin.press(ESC)
    await tick()
    t.stdin.press('q')
    await tick()
    app.unmount()
    expect(exits).toBe(0)
  })

  it('方向键也不动 —— 键归对话框', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN)
    await tick()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain(DETAIL_MARK)
  })

  it('r 重做也不响应', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onRedo={n => seen.push(n)} onExitKey={() => {}} />,
    )
    t.stdin.press('r')
    await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  it('对话框收走之后键盘要**拿回来** —— 只挂起不恢复比原来的 bug 更糟', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended={false} onExitKey={() => {}} />,
    )
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain(DETAIL_MARK)
  })

  it('挂起时提示行说清为什么按键没反应', async () => {
    // 不说的话,用户会按着方向键发现树不动,以为界面卡死了。
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('这期间按键归它')
    // 挂起时不该再列一堆用不了的键。
    expect(f).not.toContain('↑↓/jk 移动')
  })
})
