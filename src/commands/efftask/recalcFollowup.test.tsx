/**
 * 三席验收(commit `d8dd5f0`)之后的复验 —— 质量席对着**新 HEAD** 再跑一遍。
 *
 * 三条修复本身守没守住,以及那一轮扫描漏掉的三处。每一条都注明它钉的是哪个变异。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { ConfirmRecalcDeps } from './ConfirmRecalcDeps.js'
import { recalcLines, type RecalcPlan } from '../../tools/efftask/depsRecalc.js'
import { validateLoadedNodes } from '../../tools/efftask/resumeCore.js'
import { renderTreeSnapshot, serializeNode } from '../../tools/efftask/persistence.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'

const NOW = '2026-08-10T00:00:00.000Z'
const ENTER = '\r'
const tick = (ms = 40): Promise<void> => new Promise(r => setTimeout(r, ms))
const OPTS = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

function fakeTty(cols = 160) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: cols, rows: 60, write: (s: string) => { frame += s; return true },
  })
  return { stdin, stdout, last: () => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '') }
}

const B = 'root/01-b', B1 = 'root/01-b/00-b1'
const byId = (): Map<string, TaskNode> => new Map([
  [B, mk(B, { title: '乙' })], [B1, mk(B1, { title: 'B1', parentId: B })],
])
const dupPlan = (): RecalcPlan => ({
  nodeId: 'root/00-a', before: [B, B], after: [B1],
  perDep: [{ dep: B, needs: [{ id: B1, why: 'x' }], dropped: [], rolledUp: [] }],
  warnings: [], unchanged: false, outcome: 'refined',
})

async function mount(over: Partial<React.ComponentProps<typeof ConfirmRecalcDeps>> = {}) {
  const t = fakeTty()
  const app = await render(
    <ConfirmRecalcDeps
      target={mk('root/00-a', { title: '甲', deps: [B, B] })}
      resolveNode={id => byId().get(id)}
      onAsk={async () => ({ ok: true, plan: dupPlan() })}
      onApply={async () => ({ ok: true })}
      onCancelAsk={() => {}}
      onDone={() => {}}
      {...over}
    />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  return { t, app }
}

describe('关口的实时输出窗(钉 H02)', () => {
  /**
   * `d8dd5f0` 修掉的第 2 个真 bug 是「关口里压根没有输出窗组件」。修法是挂上
   * `AgentLogPane` —— 但**把那个渲染分支整条剪掉,3739 条测试一条都不红**(实测变异 H02)。
   * 也就是说这次修复自己没有守卫:同一个 bug 再犯一次不会有人发现。
   *
   * 这条断言走真渲染:给了流就必须有窗,没给就不能凭空长出来。
   */
  it('给了流就要真的画出来 —— 剪掉渲染分支时这条要红', async () => {
    const stream = {
      meta: { nodeId: 'root/00-a', phaseLabel: '依赖重算', label: '主模型' },
      events: [{ kind: 'text', text: '模型正在读子树清单' }],
      dropped: 0, toolCount: 0, startedAt: Date.now(), closed: false, seq: 1,
    } as unknown as StreamState

    const withPane = await mount({ streams: [stream] })
    await tick()
    const on = withPane.t.last()
    withPane.app.unmount()

    const without = await mount({ streams: [] })
    await tick()
    const off = without.t.last()
    without.app.unmount()

    // 两屏都还在 asking(共有的那句话在)
    expect(on).toContain('别的任务仍在照常运行')
    expect(off).toContain('别的任务仍在照常运行')
    // 而只有给了流的那一屏多出了窗里的内容
    expect(on).toContain('模型正在读子树清单')
    expect(off).not.toContain('模型正在读子树清单')
  })
})

describe('复验:三席那一轮漏掉的三处', () => {
  /**
   * 「从 N 条」的去重必须**两屏同口径**。只改 `recalcLines`(ready 屏)而不改
   * `ConfirmRecalcDeps` 的 done 屏,同一次重算会给出互相矛盾的条数 —— 而
   * `node.deps` 含重复(`[乙, 乙]`)是重做那条路真实产生过的形状。
   */
  it('ready 屏和 done 屏的条数同口径(before 去重)', async () => {
    expect(recalcLines(dupPlan(), byId(), 'root').join('\n')).toContain('从 1 条变成 1 条')

    const { t, app } = await mount()
    await tick()
    t.stdin.press(ENTER) // ready → 应用
    await tick(80)
    const frame = t.last()
    app.unmount()
    const line = frame.split('\n').map(s => s.trim()).find(s => s.includes('依赖已更新'))
    expect(line).toBeDefined()
    expect(line).toContain('1 条 → 1 条')
    expect(line).not.toContain('2 条')
    // 顺带钉住方案称为「这个功能唯一的成功指标」的那一句(走 notSchedulableReason)
    expect(line).toMatch(/马上就会被调度|仍在等依赖/)
  })

  /**
   * **孤儿计数是真信息,留着;但那一节不许暗示还有别的可读。**
   *
   * 「一个合法正数 + 没有任何记录」这个态是可达的(更早的恢复边界夹掉过、或整批记录
   * 坏掉被丢弃),而它说的事情是真的:这个节点确实被手工重算过 N 次。删掉计数等于抹掉
   * 「有人动过这个节点的依赖」本身,而那正是 run.md 上 ⟲ 存在的理由。
   *
   * 代价是 node.md 那一节会是空的 —— 所以零记录时的措辞必须换掉:「**另有** N 次」
   * 暗示还有别的可以读。这条探针钉的就是这个分叉。
   *
   * (`depsRecalcWiring.test.ts` 那条同名用例喂的是 `'七'`,走的是归一化垃圾值那一支 ——
   * 它守的是另一半,两条都要。)
   */
  it('合法的孤儿 dropped 保留,而那一节改口不说「另有」', () => {
    // 既有用例覆盖的那一半(垃圾值)确实被清掉了
    const garbage = mk('root')
    ;(garbage as { depsRecalcDropped?: unknown }).depsRecalcDropped = '七'
    expect(validateLoadedNodes([garbage], OPTS).nodes[0].depsRecalcDropped).toBeUndefined()

    // 而名字真正描述的那一半没有
    const orphan = mk('root', { depsRecalcDropped: 7 })
    const got = validateLoadedNodes([orphan], OPTS).nodes[0]
    expect(got.depsRecalc).toBeUndefined()
    expect(got.depsRecalcDropped).toBe(7)
    expect(renderTreeSnapshot([got])).toContain('⟲ 依赖重算 ×7')
    // 一条记录都没有时不许写「另有」—— 那句话暗示还有别的可以读
    const md = serializeNode(got)
    expect(md).toContain('共 7 次重算,逐条记录均未保留')
    expect(md).not.toContain('另有 7 次')
  })

  /** 同一个孤儿态,主分支(记录全坏 + 已有计数)也走得到 —— 不只是手改出来的。 */
  it('记录全坏时主分支自己造出同一个孤儿态,而它仍然说真话', () => {
    const n = mk('root', { depsRecalc: [{ at: 't', from: 'x', to: 3 }] as never, depsRecalcDropped: 7 })
    const got = validateLoadedNodes([n], OPTS).nodes[0]
    expect(got.depsRecalc).toBeUndefined()
    expect(got.depsRecalcDropped).toBe(7)
    expect(renderTreeSnapshot([got])).toContain('⟲ 依赖重算 ×7')
  })
})
