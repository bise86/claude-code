/**
 * 质量验收席对「依赖重算」界面那一半的对抗探针。
 *
 * 专攻:拒绝理由的**生命周期**(它挂在面板上,不挂在节点上)、以及「按 d」这个提示
 * 在什么时候是一句必然被拒的空话。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { detailSections } from './NodeDetail.js'
import { recalcLines, recalcScope, type RecalcPlan } from '../../tools/efftask/depsRecalc.js'
import { redoSummaryLines } from './ConfirmRedo.js'

const ENTER = '\r'
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
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

/** 两个平级的 CREATED 节点,都还被依赖挡着。光标默认停在第一个。 */
const TWO = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'unknown', status: 'CREATED', deps: ['dep'], childIds: [] }),
  mk('other', { title: '另一个任务', kind: 'unknown', status: 'CREATED', deps: ['dep'], childIds: [] }),
  mk('dep', { title: '被依赖的任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [] }),
]

describe('拒绝理由的生命周期', () => {
  /**
   * **拒绝理由必须带着它属于哪个节点。**
   *
   * 只存一个字符串时它只在下一次按 d 才被覆盖:在甲上被拒之后退回任务树、打开乙的详情页,
   * 乙的「依赖重算」段上写着的是**甲**那次被拒的理由 —— 一句关于另一个任务的话,
   * 印在这个任务的详情页上。验收席用真渲染 + 真按键复现过,这条探针钉的就是那次修复。
   */
  it('在 A 上被拒之后,打开 B 的详情页**不许**印着 A 那一次的理由', async () => {
    const t = fakeTty()
    const app = await render(
      <TaskTreePanel
        nodes={TWO()} runId="003" interactive onExitKey={() => {}}
        onRecalcDeps={n => (n.id === 'root' ? 'ROOT 专属的拒绝理由' : undefined)}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()      // 进 root 详情页
    t.stdin.press('d'); await tick()        // 被拒
    expect(t.lastFrame()).toContain('ROOT 专属的拒绝理由')
    t.stdin.press('q'); await tick()        // 回任务树
    t.stdin.press('j'); await tick()        // 选中 other
    t.reset()
    t.stdin.press(ENTER); await tick()      // 进 other 详情页
    const frame = t.lastFrame()
    app.unmount()
    // 拒绝理由带着它属于哪个节点;打开别人的详情页时不该看到它。
    expect(frame).toContain('另一个任务')
    expect(frame).not.toContain('ROOT 专属的拒绝理由')
  })
})

describe('「按 d 重算」这句提示什么时候是空话', () => {
  const resolve = (m: Map<string, TaskNode>) => (id: string): TaskNode | undefined => m.get(id)

  /**
   * `depsBody` 的注释写着「给了才写「按 d 重算」那一行 —— **一个按了必然被拒的提示比
   * 没有更糟**」,而 `TaskTreePanel` 给的判据只有 `status === 'CREATED'`。
   * 下面四种都满足那个判据、都会印出这行提示,而 `recalcScope` 会逐条拒掉。
   */
  const cases: { name: string; node: TaskNode; tree: TaskNode[] }[] = (() => {
    const dep = mk('dep', { title: '被依赖', status: 'ACCEPTED' })
    const depNoKids = mk('dep', { title: '被依赖', status: 'WAITING_CHILDREN', childIds: [] })
    return [
      {
        name: '依赖已经全部完成(重算买不到任何并发)',
        node: mk('root', { title: '根', status: 'CREATED', deps: ['dep'] }),
        tree: [dep],
      },
      {
        name: '依赖一个子任务都还没拆出来(无从细化)',
        node: mk('root', { title: '根', status: 'CREATED', deps: ['dep'] }),
        tree: [depNoKids],
      },
      {
        name: '节点正从质疑修复重入(redoFrom 有值)',
        node: mk('root', { title: '根', status: 'CREATED', deps: ['dep'], redoFrom: 'plan' as never }),
        tree: [depNoKids],
      },
      {
        name: '上级已经阻断(整棵子树都不会再被调度)',
        node: mk('kid', { title: '子', parentId: 'p', status: 'CREATED', deps: ['dep'] }),
        tree: [mk('p', { title: '父', status: 'BLOCKED', childIds: ['kid'] }), depNoKids],
      },
    ]
  })()

  for (const c of cases) {
    it(`${c.name} —— 提示照印,而 recalcScope 必拒`, () => {
      const m = new Map<string, TaskNode>([...c.tree, c.node].map(n => [n.id, n]))
      // 详情页给出的判据(TaskTreePanel: onRecalcDeps 已接线 && status === 'CREATED')
      const canRecalc = c.node.status === 'CREATED'
      expect(canRecalc).toBe(true)
      const body = detailSections(c.node, resolve(m), canRecalc).find(s => s.title === '依赖')!.body
      expect(body).toContain('按 d')
      // 而按下去必然被拒
      expect(recalcScope(c.node, m).ok).toBe(false)
    })
  }
})

describe('拒绝会在段落列表中间插入一段', () => {
  /**
   * `NodeDetail` 里那段注释的立意是「段落标题是身份,不许被非用户动作改动」。
   * 拒绝理由确实是用户按键触发的,但它插入的位置在 **「依赖」和「目标」之间** ——
   * 一次「什么都没发生」的按键把它下面每一段的下标整体推后一位。
   */
  it('被拒前后,「目标」这一段的下标不同', () => {
    const n = mk('root', { title: '根', status: 'CREATED', deps: ['dep'], goal: '目标文本' })
    const resolve = (id: string): TaskNode | undefined => (id === 'dep' ? mk('dep', { title: '被依赖' }) : undefined)
    const before = detailSections(n, resolve, true).findIndex(s => s.title === '目标')
    const after = detailSections(n, resolve, true, '不行,因为…').findIndex(s => s.title === '目标')
    expect(before).toBeGreaterThanOrEqual(0)
    expect(after).toBe(before + 1)
  })
})

describe('关口的夹取方向', () => {
  /**
   * **【缺陷 · 已确认】** `recalcLines` 的头部注释说明了「三句知情同意要排在最前面,
   * 因为 `redoSummaryLines` 是**从尾部**夹的」—— 然后把 `结果:…` 那一行和**全部 ⚠ 警告**
   * 放在了最后面。而当最终安全闸触发时,「已整次放弃(依赖保持原样)」这句话只存在于
   * 那些警告里:终端一矮,用户看到的就是一屏逐条列出的细化结果 + 一个「回车 返回」的页脚,
   * 唯一说明「这次什么都不会发生」的那一行已经被夹掉了。
   */
  it('终端一矮时,⚠ 警告仍然活着 —— 它是「这次什么都不会发生」的唯一出口', () => {
    const byId = new Map<string, TaskNode>()
    const perDep = Array.from({ length: 5 }, (_, i) => {
      const dep = `root/0${i}-d`
      byId.set(dep, mk(dep, { title: `依赖${i}` }))
      const needs = Array.from({ length: 3 }, (_, j) => {
        const id = `${dep}/0${j}-k`
        byId.set(id, mk(id, { title: `子${j}`, parentId: dep }))
        return { id, why: `本任务第 ${j} 步要用到它的产出` }
      })
      return { dep, needs, dropped: [], rolledUp: [] }
    })
    const plan: RecalcPlan = {
      nodeId: 'root', before: perDep.map(p => p.dep), after: perDep.flatMap(p => p.needs.map(n => n.id)),
      perDep, unchanged: true, outcome: 'rolled-back',
      warnings: ['⚠ 算出来的新依赖会落进一条成环 / 推不动的依赖链,已整次放弃(依赖保持原样)'],
    }
    const lines = recalcLines(plan, byId, 'root')
    // 警告排在**明细之前**:redoSummaryLines 从尾部夹,而最终安全闸触发时
    // 「已整次放弃(依赖保持原样)」只存在于这些警告里 —— 排在最后就是第一个被吃掉的。
    expect(lines.slice(0, 12).join('\n')).toContain('已整次放弃')

    // 30 行终端(budget = 30 - 10 = 20 行),120 列
    const { shown, hidden } = redoSummaryLines(lines, 30, 120)
    expect(hidden).toBeGreaterThan(0)
    expect(shown.join('\n')).toContain('已整次放弃')
    // 知情同意那几句同样活着
    expect(shown.join('\n')).toContain('不读代码')
  })
})
