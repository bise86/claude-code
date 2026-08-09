/**
 * 详情页的动作键**不许被修饰键触发** —— 挂真组件,送真的控制字符序列。
 *
 * 病因是两件事叠在一起,单看哪一件都正常:
 *  1. 这个 fork 起 ink 时用的是 `getRenderContext(false)`(`main.tsx`),即
 *     `internal_exitOnCtrlC === false`;`use-input.ts` 只在它为真时吞掉 Ctrl+C,
 *     否则**原样派发**给每一个监听者;
 *  2. `input-event.ts` 对带 ctrl 的按键给出的 `input` 正是**键名本身**
 *     (`input = keypress.ctrl ? keypress.name : keypress.sequence`)。
 *
 * 于是 `TaskTreePanel` 详情分支里那些 `k === 'c'` / `k === 'q'` 会被 Ctrl+C / Ctrl+Q 命中。
 * 实测后果:详情页上 **Ctrl+C 打开「清理已完成工作区」关口**、**Ctrl+Q abort 整个 run**。
 *
 * 这一档同时钉住反方向的三件事,它们才是这次修改最容易打坏的:
 *  - 裸 `c` / 裸 `r` 照旧;
 *  - **Esc 照旧返回** —— `key.meta` 对 Escape 恒为真(`input-event.ts` 的
 *    `meta: keypress.meta || keypress.name === 'escape' || keypress.option`),所以守卫只能
 *    逐条与,写成分支开头的早退会让 Esc 当场变死键;
 *  - Ctrl+D 落空之后不触发任何动作键(它是 NodeDetail / AgentLogPane 的半页滚动,
 *    而 `useInput` 是广播的,这里 `return` 并不阻断它们)。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'

const ENTER = '\r'
const ESC = ''
const CTRL_C = ''
const CTRL_Q = ''
const CTRL_R = ''
const CTRL_S = ''
const CTRL_F = ''
const CTRL_D = ''
const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

function fakeTty(cols = 120) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: cols, rows: 40,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: `任务${id}`, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  ...over,
})

const TREE = (): TaskNode[] => [
  mk('root', {
    title: '根任务', kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN',
    goal: '这是根任务的目标文本',
  }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'BLOCKED', failedAt: 'ACCEPTANCE' }),
]

async function mountDetail(log: string[], cols = 120) {
  const t = fakeTty(cols)
  const app = await render(
    <TaskTreePanel
      nodes={TREE()} runId="003" interactive
      onRedo={n => log.push(`redo:${n.id}`)}
      onRedoFailed={n => log.push(`redoFailed:${n.id}`)}
      onSkipFailed={n => log.push(`skip:${n.id}`)}
      onForcePass={n => log.push(`force:${n.id}`)}
      onCleanupWorktrees={n => log.push(`cleanup:${n.id}`)}
      onExitKey={() => log.push('exit')}
    />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  // 回车进详情页(光标停在 root 上)
  t.stdin.press(ENTER); await tick()
  return { t, app }
}

/** 详情页是不是还开着 —— 它有页脚里那句「返回任务树」,树那一屏没有。 */
const inDetail = (frame: string): boolean => frame.includes('返回任务树')

describe('详情页的动作键不许被 ctrl / meta 触发', () => {
  it('Ctrl+C 不再打开「清理已完成工作区」关口', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press(CTRL_C); await tick()
    app.unmount()
    expect(log).toEqual([])
  })

  it('Ctrl+Q 不再 abort 整个 run,也不关掉详情页', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press(CTRL_Q); await tick()
    /**
     * 「详情页还开着吗」**不能看帧**:渲染器只写增量,一个不改状态的按键**一帧都不会写**,
     * 于是 `reset()` 之后读到的空帧和「详情页关掉了」长得一模一样(这条探针第一版就是这么
     * 假绿的)。改成按一个**只在详情页上有出口**的键:`c` 在树那一支根本没有处理者。
     */
    t.stdin.press('c'); await tick()
    app.unmount()
    expect(log).toEqual(['cleanup:root'])
  })

  it('Ctrl+R / Ctrl+S / Ctrl+F 都不触发各自的关口', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press(CTRL_R); await tick()
    t.stdin.press(CTRL_S); await tick()
    t.stdin.press(CTRL_F); await tick()
    app.unmount()
    expect(log).toEqual([])
  })

  it('Ctrl+D 不触发任何动作键,详情页照旧开着(它是半页滚动)', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press(CTRL_D); await tick()
    // 同上:用「只在详情页上有出口的键」证明它还开着,不看帧。
    t.stdin.press('c'); await tick()
    app.unmount()
    expect(log).toEqual(['cleanup:root'])
  })

  it('裸 c 照旧打开清理关口 —— 这次改动不许拿走它', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press('c'); await tick()
    app.unmount()
    expect(log).toEqual(['cleanup:root'])
  })

  it('裸 r 照旧打开重做关口', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.stdin.press('r'); await tick()
    app.unmount()
    expect(log).toEqual(['redo:root'])
  })

  it('Esc 仍然返回任务树 —— key.meta 对 Escape 恒为真,守卫写成早退会让它变死键', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.reset()
    t.stdin.press(ESC); await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 回到树上:不再有详情页页脚,而且没有把 onExitKey 打出去(那是树那一层的 Esc)
    expect(inDetail(frame)).toBe(false)
    expect(log).toEqual([])
  })

  it('裸 q 仍然返回任务树', async () => {
    const log: string[] = []
    const { t, app } = await mountDetail(log)
    t.reset()
    t.stdin.press('q'); await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(inDetail(frame)).toBe(false)
    expect(log).toEqual([])
  })
})
