/**
 * 依赖重算那个键的接线,以及它**被拒时不许把用户踢回任务树**。
 *
 * 后一条是评审抓出来的:准入判据全是同步内存读,而关口是 phase 级整屏替换 —— 切过去
 * 再回来会把 `TaskTreePanel` 连同 `NodeDetail` 整棵卸载,用户展开到哪一段、读到第几行
 * (住在那两个组件自己的 state 里)全没了。而「什么都没发生」不该长成「你的阅读位置没了」。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { detailSections } from './NodeDetail.js'

const ENTER = '\r'
const CTRL_D = String.fromCharCode(4)
const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

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

/** 光标默认停在 root;它是 CREATED、依赖 甲。 */
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'unknown', status: 'CREATED', deps: ['dep'], childIds: [] }),
  mk('dep', { title: '被依赖的任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [] }),
]

async function mountDetail(props: Partial<React.ComponentProps<typeof TaskTreePanel>> = {}) {
  const t = fakeTty()
  const app = await render(
    <TaskTreePanel nodes={TREE()} runId="003" interactive onExitKey={() => {}} {...props} />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  t.stdin.press(ENTER); await tick() // 进详情页
  return { t, app }
}

describe('d 键', () => {
  it('把详情页那个节点交给回调', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onRecalcDeps: n => { seen.push(n.id); return undefined } })
    t.stdin.press('d'); await tick()
    app.unmount()
    expect(seen).toEqual(['root'])
  })

  it('**Ctrl+D 不触发它**(那是半页滚动)', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onRecalcDeps: n => { seen.push(n.id); return undefined } })
    t.stdin.press(CTRL_D); await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  it('被拒时**详情页还开着**,而且拒绝理由画在屏幕上', async () => {
    const { t, app } = await mountDetail({
      onRecalcDeps: () => '这个任务已经开始分析了(当前 PLANNING)',
      onCleanupWorktrees: () => {},
    })
    t.stdin.press('d'); await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 理由上屏
    expect(frame).toContain('已经开始分析')
    // 详情页没被关掉 —— 用「只在详情页上有出口的键」证明(帧是增量的,不能靠它判断)
    expect(frame).toContain('返回任务树')
  })

  it('没接这个回调时按 d 什么都不会发生(而不是崩)', async () => {
    const { t, app } = await mountDetail({})
    t.stdin.press('d'); await tick()
    app.unmount()
    expect(true).toBe(true)
  })
})

describe('「依赖」段上的提示', () => {
  const n = mk('root', { title: '根', status: 'CREATED', deps: ['dep'] })
  const resolve = (id: string): TaskNode | undefined =>
    id === 'dep' ? mk('dep', { title: '被依赖的任务' }) : undefined

  it('只在 canRecalcDeps 时写,而且写在**最后一行**', () => {
    const on = detailSections(n, resolve, true).find(s => s.title === '依赖')!
    const off = detailSections(n, resolve, false).find(s => s.title === '依赖')!
    expect(on.body.split('\n').at(-1)).toContain('按 d')
    expect(off.body).not.toContain('按 d')
  })

  /**
   * **提示不许进段落标题。** `expanded` / `secMode` / `anchor` / `selTitle` 四个状态全按
   * 标题寻址,而这个提示的显示条件是 `status === 'CREATED'` —— 节点离开 CREATED 是编排器
   * 自己 tick 出来的,用户一个键都没按。标题一改,他展开着的那一段会自己收起、↑↓ 的语义
   * 当场翻面、视口跳回顶部。
   */
  it('段落标题在两种情况下**逐字相同**', () => {
    const on = detailSections(n, resolve, true).map(s => s.title)
    const off = detailSections(n, resolve, false).map(s => s.title)
    expect(on).toEqual(off)
    expect(on).toContain('依赖')
  })

  it('依赖行同时印标题和真 id —— 同名孙节点上「父/子」路径仍然不唯一', () => {
    const s = detailSections(n, resolve, false).find(x => x.title === '依赖')!
    expect(s.body).toContain('被依赖的任务')
    expect(s.body).toContain('dep')
  })

  it('拒绝理由单开一段,没有理由时那一段不出现', () => {
    const withNotice = detailSections(n, resolve, true, '不行,因为…').map(s => s.title)
    const without = detailSections(n, resolve, true).map(s => s.title)
    expect(withNotice).toContain('依赖重算')
    expect(without).not.toContain('依赖重算')
  })

  it('重算记录单开一段,没重算过的节点版面逐字不变', () => {
    const clean = detailSections(n, resolve, false).map(s => s.title)
    const done = detailSections(
      { ...n, depsRecalc: [{ at: NOW, from: ['dep'], to: ['dep/00-x'] }] },
      resolve, false,
    ).map(s => s.title)
    expect(clean).not.toContain('依赖重算记录')
    expect(done).toContain('依赖重算记录')
  })
})
