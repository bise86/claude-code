/**
 * Mounts through the VENDORED renderer (src/ink.ts), not npm ink — same reason as
 * ConfirmStartup.test.tsx: both renderers emit identical frames, but useInput only works
 * against the app's own StdinContext, so a panel that paints correctly and ignores every key
 * is indistinguishable on screen from a working one.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { TaskTreePanel, visibleRows } from './TaskTreePanel.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'

const NOW = new Date().toISOString()
const ESC = String.fromCharCode(27)
const UP = ESC + '[A'
const DOWN = ESC + '[B'
const LEFT = ESC + '[D'
const RIGHT = ESC + '[C'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))
const tickEsc = (): Promise<void> => new Promise(r => setTimeout(r, 250))

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
  // Cursor-move sequences ARE the spacing, so they become a space; the bare ESC byte that
  // precedes them must then be removed or it lands between every pair of words.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

/** root ─ 甲(ACCEPTED, 2 kids) ─ 乙(BLOCKED) */
const tree = (): TaskNode[] => [
  mk({ id: 'root', title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-甲', 'root/02-乙'] }),
  mk({ id: 'root/01-甲', title: '建表', parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-甲/01-a', 'root/01-甲/02-b'] }),
  mk({ id: 'root/01-甲/01-a', title: '写 schema', parentId: 'root/01-甲', depth: 2, status: 'ACCEPTED', kind: 'executable' }),
  mk({ id: 'root/01-甲/02-b', title: '写迁移', parentId: 'root/01-甲', depth: 2, status: 'EXECUTING', kind: 'executable' }),
  mk({
    id: 'root/02-乙', title: '打通接口', parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'executable',
    blockedReason: '验收迭代超限(3): [qa] 缺测试',
    plan: { solution: '接上登录接口', keyPoints: '注意超时', risks: '可能与支付冲突', acceptance: '有集成测试' },
    execStatus: '改了 src/login.ts',
  }),
]

const mount = async (over: Record<string, unknown> = {}) => {
  const t = fakeTty()
  const app = await render(
    React.createElement(TaskTreePanel, { nodes: tree(), runId: '003', interactive: true, ...over } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { ...t, app }
}

describe('visibleRows folds subtrees, parent before child', () => {
  it('hides a collapsed node\'s whole subtree', () => {
    const all = visibleRows(tree(), new Set())
    expect(all.map(r => r.node.id)).toEqual(['root', 'root/01-甲', 'root/01-甲/01-a', 'root/01-甲/02-b', 'root/02-乙'])
    const folded = visibleRows(tree(), new Set(['root/01-甲']))
    expect(folded.map(r => r.node.id)).toEqual(['root', 'root/01-甲', 'root/02-乙'])
    expect(folded.find(r => r.node.id === 'root/01-甲')!.hasKids).toBe(true)
  })

  it('does not hang on a parent/child cycle recovered from disk', () => {
    const a = mk({ id: 'a', parentId: 'b', childIds: ['b'] })
    const b = mk({ id: 'b', parentId: 'a', childIds: ['a'] })
    expect(visibleRows([a, b], new Set()).map(r => r.node.id).sort()).toEqual(['a', 'b'])
  })

  it('still emits an orphan whose parent is missing', () => {
    const orphan = mk({ id: 'x', parentId: 'ghost', depth: 1 })
    expect(visibleRows([orphan], new Set()).map(r => r.node.id)).toEqual(['x'])
  })
})

describe('TaskTreePanel is navigable with real keypresses (vendored renderer)', () => {
  it('paints the tree with status colour, elapsed and fold markers', async () => {
    const { lastFrame, app } = await mount()
    const f = lastFrame()
    expect(f).toContain('根任务')
    expect(f).toContain('写 schema')
    expect(f).toContain('▾') // an expanded parent shows the open marker
    expect(f).toContain('回车看详情')
    app.unmount()
  })

  it('folds a subtree and says how many rows it hid', async () => {
    // Hiding rows without saying how many silently loses work from the user's view.
    const { stdin, lastFrame, reset, app } = await mount()
    stdin.press(DOWN)          // → 甲
    await tick()
    reset()
    stdin.press(LEFT)          // fold
    await tick()
    const f = lastFrame()
    expect(f).toContain('▸')
    expect(f).toContain('+2')  // two descendants hidden
    expect(f).not.toContain('写 schema')
    app.unmount()
  })

  it('re-expands with the right arrow', async () => {
    const { stdin, lastFrame, reset, app } = await mount()
    stdin.press(DOWN); await tick()
    stdin.press(LEFT); await tick()
    reset()
    stdin.press(RIGHT); await tick()
    expect(lastFrame()).toContain('写 schema')
    app.unmount()
  })

  it('left on a leaf jumps to its parent instead of being a dead key', async () => {
    const { stdin, lastFrame, reset, app } = await mount()
    stdin.press(DOWN); await tick()   // 甲
    stdin.press(DOWN); await tick()   // 写 schema (leaf)
    stdin.press(LEFT); await tick()   // → cursor back on 甲 (leaf has nothing to fold)
    reset()
    // Press LEFT again: if the cursor really moved to 甲, this folds it — a state change the
    // renderer repaints. Asserting on a no-op keypress would read an empty frame either way.
    stdin.press(LEFT); await tick()
    const f = lastFrame()
    expect(f).toContain('▸')
    expect(f).toContain('+2')
    app.unmount()
  })

  it('Enter opens the node detail and Esc returns', async () => {
    // 用户原话:"单个任务可回车进入看更多任务细节"
    const { stdin, lastFrame, reset, app } = await mount()
    for (let i = 0; i < 4; i++) { stdin.press(DOWN); await tick() } // → 打通接口 (BLOCKED)
    reset()
    stdin.press('\r')
    await tick()
    const detail = lastFrame()
    expect(detail).toContain('打通接口')
    expect(detail).toContain('完整方案')
    expect(detail).toContain('接上登录接口')
    expect(detail).toContain('风险点')
    expect(detail).toContain('阻断原因')
    expect(detail).toContain('缺测试')
    reset()
    stdin.press(ESC)
    await tickEsc()
    expect(lastFrame()).toContain('根任务') // back on the tree
    app.unmount()
  })

  it('Esc in the DETAIL view returns instead of aborting the run', async () => {
    // The panel owns the keyboard precisely so these two meanings cannot collide: a second
    // useInput in the parent would ALSO see this Esc and kill the run.
    let exits = 0
    const { stdin, app } = await mount({ onExitKey: () => { exits++ } })
    stdin.press('\r'); await tick()      // open detail on root
    stdin.press(ESC); await tickEsc()    // back
    expect(exits).toBe(0)
    stdin.press(ESC); await tickEsc()    // now it means leave
    expect(exits).toBe(1)
    app.unmount()
  })

  it('ignores navigation entirely when not interactive', async () => {
    // The non-interactive path is what run.md-style read-only renders use.
    let exits = 0
    const { stdin, lastFrame, app } = await mount({ interactive: false, onExitKey: () => { exits++ } })
    stdin.press(ESC); await tickEsc()
    expect(exits).toBe(0)
    expect(lastFrame()).not.toContain('回车看详情')
    app.unmount()
  })
})
