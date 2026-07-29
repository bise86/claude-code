/**
 * The three §10.2 hops that live in `efftask.tsx`.
 *
 * That file has no tests — it renders Ink and touches the real store — and it is exactly
 * where this repo has cut a wire twice (onEscalate, and the roster). A reviewer proved all
 * three of these mutations stayed green:
 *
 *   - `openStream: meta => streams.current.open(meta)` → undefined
 *   - `streams={props.streams}` removed from RunningView
 *   - `streams={props.streams}` removed from DoneView
 *
 * The two views are exported for this reason. The store creation and the onChunk closure are
 * one line each and still uncovered; what is covered here is that a store handed to either
 * view actually reaches the detail pane a user opens.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { RunningView, DoneView } from './efftask.js'
import { createStreamStore } from '../../tools/efftask/agentStream.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'

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
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  kind: 'executable',
  ...over,
})

/**
 * 打开光标那一行的详情页。`toLog` 再按一下 → 切到「子 agent 输出」页卡。
 *
 * 输出现在住在第二个页卡上,所以「详情里看得到输出」这件事要多走一跳 —— 而多走的
 * 这一跳恰好把整条线都串上了:树 → 回车 → 详情 → 切页卡 → 日志窗拿到的是**这个**节点的流。
 */
async function openDetail(View: unknown, props: Record<string, unknown>, toLog = false) {
  const t = fakeTty()
  const app = await render(
    React.createElement(View as never, props as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  t.stdin.press('\r') // Enter on the cursor row opens that node's detail
  await tick()
  if (toLog) {
    t.stdin.press('\u001b[C') // →
    await tick()
  }
  const f = t.lastFrame()
  app.unmount()
  return f
}

describe('运行中的面板把输出缓冲交到详情视图手里', () => {
  it('RunningView → 详情里看得到子 agent 的输出', async () => {
    const streams = createStreamStore()
    streams.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' }).push({ kind: 'text', text: '正在改 src/login.ts' })
    const f = await openDetail(RunningView, {
      nodes: [node({ status: 'EXECUTING' })], runId: '003', streams, onAbort: () => {},
    }, true)
    expect(f).toContain('子 agent 输出')
    expect(f).toContain('正在改 src/login.ts')
  })

  it('DoneView → 跑完之后输出仍然留着(spec §10.2 "完成后保留最终输出")', async () => {
    const streams = createStreamStore()
    streams.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' }).push({ kind: 'text', text: '最终产出:12 个测试通过' })
    const f = await openDetail(DoneView, {
      nodes: [node({ status: 'ACCEPTED' })], runId: '003', streams,
      outcome: { status: 'completed' }, handoff: null, onExit: () => {},
    }, true)
    expect(f).toContain('最终产出:12 个测试通过')
  })

  it('没有缓冲时两个视图都照常渲染,不炸', async () => {
    // `streams` 在两个视图上都是可选的;一次什么都没流过的运行照样要能打开。
    const f = await openDetail(RunningView, {
      nodes: [node({ status: 'EXECUTING' })], runId: '003', onAbort: () => {},
    }, true)
    expect(f).toContain('根任务')
    // 页签在(版面不许随有没有输出而变形),但切过去说的是实话。
    expect(f).toContain('暂无输出')
    expect(f).not.toContain('输出(')
  })
})


describe('并行占用 (spec §10.1) 的最后一跳', () => {
  it('RunningView 把 pool reader 交给面板', async () => {
    // Four mutations on this wire were green: slotUsage() returning zeros, runOrchestrator not
    // calling onPool, efftask.tsx not storing the reader, and RunningView not passing it. Only
    // the panel's own formatting was covered, and it reads a test-injected fake. This is the
    // same shape this repo has cut five times (onEscalate, roster, onChunk x2, pool).
    const t = fakeTty()
    const app = await render(
      React.createElement(RunningView as never, {
        nodes: [node({ status: 'EXECUTING' })], runId: '003',
        pool: () => ({ inUse: 3, limit: 5 }),
        onAbort: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('并行 3/5')
    app.unmount()
  })

  it('没有 pool 时 RunningView 照常渲染', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(RunningView as never, {
        nodes: [node({ status: 'EXECUTING' })], runId: '003', onAbort: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('根任务')
    expect(t.lastFrame()).not.toContain('并行 ')
    app.unmount()
  })
})

describe('仅查看后退出 (spec §17.3):只读浏览,不能报成"被阻断"', () => {
  it('viewOnly 时说的是"没有继续执行",并给出继续的命令', async () => {
    // 用户按 v 是自己选择不继续,run 原封不动留在盘上、完全可以续跑。把这说成
    // 「✗ 高效任务被阻断」,是把用户的一次按键报成一次失败 —— 而"被阻断"在这个产品里
    // 有确切含义(有节点触阀/失败),会把人送去查一个根本不存在的故障。
    const t = fakeTty()
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ status: 'READY' })], runId: '003',
        outcome: null, handoff: null, viewOnly: true, onExit: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    expect(f).toContain('仅查看')
    expect(f).not.toContain('被阻断')
    expect(f).toContain('--resume 003')
    app.unmount()
  })

  it('真的被阻断时照旧说被阻断', async () => {
    // 反向守卫:上一条不能是靠"永远不说被阻断"过的。
    const t = fakeTty()
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ status: 'BLOCKED' })], runId: '003',
        outcome: { status: 'blocked', reason: '存在无法推进的阻断节点' }, handoff: null, onExit: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('被阻断')
    app.unmount()
  })
})
