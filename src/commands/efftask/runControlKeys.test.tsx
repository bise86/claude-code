/**
 * 运行中的三个干预键 —— 挂真组件,按真键。
 *
 * 纯函数档(logView 的 runControlAction)守的是「哪个键对应哪个动作」;这一档守的是
 * **它真的接上了**,以及那些不该发生的事不发生。
 *
 * 写这一档时立刻抓到一个:`isTerminal` 在 TaskTreePanel 里**没有导入**,而全套测试照绿
 * —— 因为按 x 那条路从没被走过。真按一下就是 ReferenceError,整个面板白屏。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'

/**
 * 方向键必须写成**显式转义**。字面量 ESC 会被编辑器/脚本吞掉,剩下 '[B' 两个普通字符 ——
 * 光标一动不动,而断言会去打中排在第一位的那个节点,看起来像「取消打错了对象」。
 */
const DOWN = '\u001b[B'
const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

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

/** root(等子任务) ─┬─ 甲(执行中) └─ 乙(已验收,终态) */
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'EXECUTING' }),
  mk('root/01-b', { title: '乙', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
]

function spy() {
  const log: string[] = []
  const cancelled: TaskNode[] = []
  return {
    log, cancelled,
    ctl: {
      paused: false,
      onTogglePause: () => log.push('pause'),
      onAddDirective: () => log.push('directive'),
      onCancelNode: (n: TaskNode) => { log.push('cancel'); cancelled.push(n) },
    },
  }
}

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('三个干预键', () => {
  it('p 暂停 / i 追加指令,各走各的', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    t.stdin.press('p'); await tick()
    t.stdin.press('i'); await tick()
    app.unmount()
    expect(s.log).toEqual(['pause', 'directive'])
  })

  it('大写也认 —— 按住 shift 打字是常事', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    t.stdin.press('P'); await tick()
    app.unmount()
    expect(s.log).toEqual(['pause'])
  })

  it('x 取消的是**光标选中**的那个节点', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN); await tick() // ↓ 到「甲」
    t.stdin.press('x'); await tick()
    app.unmount()
    // 固定传根节点的话,用户在树上选了半天的那一下就白费了。
    expect(s.cancelled.map(n => n.id)).toEqual(['root/00-a'])
  })

  it('终态节点按 x **不响应** —— 它早就跑完了', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN); await tick()
    t.stdin.press(DOWN); await tick() // ↓↓ 到「乙」(ACCEPTED)
    t.stdin.press('x'); await tick()
    app.unmount()
    // 给一个「已取消」的错觉比什么都不做更糟。
    expect(s.cancelled).toEqual([])
    expect(s.log).toEqual([])
  })

  it('没给 runControl 时三个键都是死键,提示行里也不写', async () => {
    let exits = 0
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive onExitKey={() => { exits++ }} />,
    )
    for (const k of ['p', 'i', 'x']) { t.stdin.press(k); await tick() }
    const f = t.lastFrame()
    app.unmount()
    expect(exits).toBe(0)
    expect(f).not.toContain('p 暂停')
    expect(f).not.toContain('x 取消选中任务')
  })

  it('提示行照实说当前是不是暂停着', async () => {
    const s = spy()
    const running = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    const f1 = running.t.lastFrame()
    running.app.unmount()
    expect(f1).toContain('p 暂停')

    const paused = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        runControl={{ ...s.ctl, paused: true }} onExitKey={() => {}}
      />,
    )
    const f2 = paused.t.lastFrame()
    paused.app.unmount()
    // 暂停着却写「p 暂停」的话,用户按一下会以为自己暂停成功了,而其实是恢复了。
    expect(f2).toContain('已暂停')
    expect(f2).toContain('p 恢复')
  })

  it('+ / - 调并发,一次一步,四种写法都认', async () => {
    // `+` 要按 shift,而不按的那一下终端送来的是 `=`;`_` 是 shift+`-`。只收 `+`/`-` 的话
    // 一半的按法是死键,而「按了没反应」在这个仓库是反复付过学费的那一类。
    const s = spy()
    const steps: number[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        runControl={{ ...s.ctl, onAdjustParallelism: d => steps.push(d) }}
        onExitKey={() => {}}
      />,
    )
    for (const k of ['+', '=', '-', '_']) { t.stdin.press(k); await tick() }
    app.unmount()
    expect(steps).toEqual([1, 1, -1, -1])
    // 别的干预键一个都没被顺手触发。
    expect(s.log).toEqual([])
  })

  it('按住 + 被合批成 `+++` 时**只走一步**', async () => {
    /**
     * 和 j/k 那条「按住多久滚多远」的规矩不同,是故意的:这个数字的每一步都会真的多派一个
     * 带写工具的执行者出去,而终端把按住 300ms 合批成一个 `+++++++` 是常事 —— 那会把并发
     * 从 1 直接推到 8,而用户以为自己只点了一下。
     */
    const s = spy()
    const steps: number[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        runControl={{ ...s.ctl, onAdjustParallelism: d => steps.push(d) }}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press('+++++'); await tick()
    app.unmount()
    expect(steps).toEqual([1])
  })

  it('没接 onAdjustParallelism 时 + / - 是死键,表头也不写 `+/-`', async () => {
    // 一个按了没反应的 affordance 比没有更糟。这一屏(比如结束视图)根本没有并发度可调。
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive runControl={s.ctl}
        pool={() => ({ inUse: 1, limit: 5 })} onExitKey={() => {}}
      />,
    )
    for (const k of ['+', '-']) { t.stdin.press(k); await tick() }
    const f = t.lastFrame()
    app.unmount()
    expect(s.log).toEqual([])
    expect(f).toContain('并行 1/5')
    expect(f).not.toContain('+/-')
  })

  it('表头在并行占用旁边写 `+/-` —— 那是这个数字唯一露面的地方', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        runControl={{ ...s.ctl, onAdjustParallelism: () => {} }}
        pool={() => ({ inUse: 2, limit: 7 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    // 页脚那一行在 80 列上早就被截掉右半截了(带 runControl 时整行 123 列),把这个键塞进去
    // 等于让它在最常见的宽度上看不见。
    expect(f).toContain('并行 2/7')
    expect(f).toContain('+/-')
  })

  it('这三个键不影响原有的导航', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive runControl={s.ctl} onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN); await tick()
    t.stdin.press('\r'); await tick() // 回车仍然开详情
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('返回任务树')
  })
})
