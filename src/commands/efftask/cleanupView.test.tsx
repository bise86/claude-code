/**
 * 「一键清理已完成工作区」的**真组件**验证。
 *
 * 和 redoView.test.tsx 同一个理由:这个仓库在接线上割断过三次,函数写对了、单测全绿、
 * 生产上零调用点。所以这一档不 import 判据函数,只做用户做的事 —— 挂真组件、按真键、
 * 看真帧。
 *
 * 守的是:
 *  - 详情页里按 `c` 真的会带着**打开的那个节点**回调;
 *  - 没给回调时 `c` 是死键,而且页脚里不许出现这个键(按了没反应比没有更糟);
 *  - 关口在按下确认之前,把「删几个 / 腾多少 / 连带删掉什么 / 什么不会被动」印在屏幕上;
 *  - 扫描没回来之前回车**不会**执行,删除过程中键盘不认;
 *  - 结果自己上屏 —— 删除是静默的,没有这一屏用户分不清成功和一个都没删掉。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { ConfirmCleanup } from './ConfirmCleanup.js'
import { DoneView } from './efftask.js'
import type { CleanupOutcome, CleanupPlan } from '../../tools/efftask/cleanupWorktrees.js'

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
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '')
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

const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
  mk('root/01-b', { title: '乙', parentId: 'root', depth: 1, status: 'BLOCKED', blockedReason: '连续返工超限' }),
]

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

const PLAN = (over: Partial<CleanupPlan> = {}): CleanupPlan => ({
  targetId: 'root',
  items: [{
    nodeId: 'root/00-a', title: '甲', path: '/w/a', branch: 'worktree-a',
    sizeKb: 3 * 1024 * 1024, leftovers: ['!! target/'], leftoverCount: 9,
  }],
  kept: [], unfinished: 1, absent: 0, totalKb: 3 * 1024 * 1024, sizeKnown: true,
  ...over,
})

describe('详情页的 c 键', () => {
  it('带着**打开的那个节点**回调', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}} onCleanupWorktrees={n => seen.push(n)}
      />,
    )
    t.stdin.press('[B') // ↓ 到「甲」
    await tick()
    t.stdin.press('\r') // 进详情页
    await tick()
    t.stdin.press('c')
    await tick()
    app.unmount()
    expect(seen.map(n => n.id)).toEqual(['root/00-a'])
  })

  it('页脚在给了回调时才写这个键 —— 正反两个方向都守', async () => {
    const withKey = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}} onCleanupWorktrees={() => {}}
      />,
    )
    withKey.t.stdin.press('\r')
    await tick()
    const on = withKey.t.lastFrame()
    withKey.app.unmount()

    const without = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}}
      />,
    )
    without.t.stdin.press('\r')
    await tick()
    const off = without.t.lastFrame()
    without.app.unmount()

    // 措辞从「清理已完成工作区」缩成「清理工作区」是**量出来的**:动作键挪到导航说明
    // 之前以后,这一行在 80 列上要同时装下 r / R / s,而它是这几个键里最不紧急的一个。
    expect(on).toContain('c 清理工作区')
    // 共享工作树运行时没有池子 —— 写着一个按了什么都不会发生的键比没有这个键更糟。
    expect(off).not.toContain('c 清理工作区')
  })

  it('没给回调时按 c 不抛异常,也不会关掉详情页', async () => {
    const errs: unknown[] = []
    const onErr = (e: unknown): void => { errs.push(e) }
    process.on('uncaughtException', onErr)
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}}
      />,
    )
    t.stdin.press('\r')
    await tick()
    t.stdin.press('c')
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    process.off('uncaughtException', onErr)
    expect(errs).toEqual([])
    // 还在详情页里(页签条还在)。
    expect(frame).toContain('子 agent 输出')
  })
})

describe('清理关口', () => {
  const target = mk('root', { title: '根任务' })

  it('确认之前把后果摊开:删几个、腾多少、连带删什么、什么不会被动', async () => {
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={async () => PLAN()}
        onRun={async () => ({ removed: [], failed: [], problems: [], freedKb: 0, sizeKnown: false })}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('3.0 GB')
    expect(frame).toContain('连带删除 9 项')
    expect(frame).toContain('任务记录不受影响')
    // 还没验收的那个必须说清楚是「跳过」,不是被算进了删除。
    expect(frame).toContain('跳过 1 个')
    expect(frame).toContain('不可恢复')
  })

  it('扫描还没回来时回车不执行 —— 那一下不该落在一个还不存在的清单上', async () => {
    let ran = 0
    let release = (): void => {}
    const gate = new Promise<CleanupPlan>(res => { release = () => res(PLAN()) })
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={() => gate}
        onRun={async () => { ran++; return { removed: [], failed: [], problems: [], freedKb: 0, sizeKnown: false } }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r')
    await tick()
    expect(ran).toBe(0)
    expect(t.lastFrame()).toContain('正在清点')
    release()
    await tick()
    app.unmount()
  })

  it('回车执行一次,并且**只有一次** —— 删除期间键盘不认', async () => {
    let ran = 0
    let finish = (): void => {}
    const running = new Promise<CleanupOutcome>(res => {
      finish = () => res({
        removed: [{ nodeId: 'root/00-a', title: '甲', path: '/w/a', branch: 'b', sizeKb: 2048, leftovers: [], leftoverCount: 0 }],
        failed: [], problems: [], freedKb: 2048, sizeKnown: true,
      })
    })
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={async () => PLAN()}
        onRun={() => { ran++; return running }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    t.stdin.press('\r')
    await tick()
    expect(ran).toBe(1)
    finish()
    await tick()
    // 结果自己上屏:删除是静默的,没有这一句用户分不清成功和一个都没删掉。
    expect(t.lastFrame()).toContain('已删除 1 个')
    expect(t.lastFrame()).toContain('2.0 MB')
    app.unmount()
  })

  it('没有可清的东西时,回车是「知道了」而不是执行一次空操作', async () => {
    let ran = 0
    let cancelled = 0
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={async () => PLAN({ items: [], totalKb: 0, sizeKnown: false, absent: 2 })}
        onRun={async () => { ran++; return { removed: [], failed: [], problems: [], freedKb: 0, sizeKnown: false } }}
        onDone={() => {}} onCancel={() => { cancelled++ }}
      />,
    )
    await tick()
    expect(t.lastFrame()).toContain('没有可以回收的工作区')
    t.stdin.press('\r')
    await tick()
    app.unmount()
    expect(ran).toBe(0)
    expect(cancelled).toBe(1)
  })

  it('扫描失败要说原因,而不是一屏空清单', async () => {
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={async () => { throw new Error('这一趟没有使用隔离工作区') }}
        onRun={async () => ({ removed: [], failed: [], problems: [], freedKb: 0, sizeKnown: false })}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 空清单会被读成「已经没有可清的了」,而真相是这一趟根本没用隔离工作区。
    expect(frame).toContain('没有使用隔离工作区')
    expect(frame).not.toContain('没有可以回收的工作区')
  })

  it('q 取消时一个字节都不删', async () => {
    let ran = 0
    let cancelled = 0
    const { t, app } = await mount(
      <ConfirmCleanup
        target={target}
        onScan={async () => PLAN()}
        onRun={async () => { ran++; return { removed: [], failed: [], problems: [], freedKb: 0, sizeKnown: false } }}
        onDone={() => {}} onCancel={() => { cancelled++ }}
      />,
    )
    await tick()
    t.stdin.press('q')
    await tick()
    app.unmount()
    expect([ran, cancelled]).toEqual([0, 1])
  })
})
