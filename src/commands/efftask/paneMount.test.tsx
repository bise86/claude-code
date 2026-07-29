/**
 * markdown 上色和模型用量,**从真渲染器里量**。
 *
 * 为什么不能只测纯函数:markdown 行走的是 `<Ansi>` 而不是裸 `<Text>`,而 `<Ansi>` 会把
 * 一行拆成一串兄弟 span 塞进一个带 `wrap="truncate-end"` 的 `<Text>` 里。这条组合路径在
 * 纯函数层完全看不见 —— `sectionLines` 返回 `{ansi:true}` 的那一刻,「它到底画不画得出来」
 * 一个字都没被验证。这个仓库为「测试全绿而界面整个没画」付过一次学费(见 runnerMount)。
 *
 * 挂的是**仓库自带的**渲染器(src/ink.ts),不是 npm 的 ink —— 和 TaskTreePanel.test.tsx
 * 同一个理由。
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import chalk from 'chalk'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { NodeDetail, usageBody } from './NodeDetail.js'
import { TaskTreePanel, runUsage, usageTag, MIN_TITLE_ROOM } from './TaskTreePanel.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import type { UsageTotals } from '../../tools/efftask/usage.js'

const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))

// 渲染路径上 markdown 在 chalk.level === 0 时是整个短路的,不强开的话下面每一条
// 断言测的都是那条短路。
const saved = chalk.level
beforeAll(() => { chalk.level = 3 })
afterAll(() => { chalk.level = saved })

function fakeTty(columns = 120) {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => null,
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns, rows: 40,
    write: (s: string) => { frame += s; return true },
  })
  // 光标移动序列**就是**间距,所以换成一个空格;剩下的裸 ESC 字节再抹掉,
  // 否则它会夹在每两个词之间。抄 TaskTreePanel.test.tsx 的同名处理。
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

const use = (calls: number, input = 0, output = 0, cacheRead = 0, cacheWrite = 0): UsageTotals =>
  ({ calls, input, output, cacheRead, cacheWrite })

async function mountDetail(props: Record<string, unknown>): Promise<string> {
  const t = fakeTty()
  const app = await render(
    React.createElement(NodeDetail as never, {
      node: mk({ id: 'n', status: 'EXECUTING', kind: 'executable' }), elapsed: '1m', columns: 100, maxRows: 30, ...props,
    } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  const f = t.lastFrame()
  app.unmount()
  return f
}

/** 列宽走**假终端**,不是 props —— 这个面板的宽度来自 useTerminalSize。 */
async function mountTree(props: Record<string, unknown>, columns = 120): Promise<string> {
  const t = fakeTty(columns)
  const app = await render(
    React.createElement(TaskTreePanel as never, { runId: 'r1', nodes: [], ...props } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  const f = t.lastFrame()
  app.unmount()
  return f
}

describe('markdown 真的画得出来', () => {
  it('方案里的记号被吃掉、正文还在 —— 而不是原样把 `**` 打到屏幕上', async () => {
    const f = await mountDetail({
      node: mk({
        id: 'n', status: 'EXECUTING', kind: 'executable',
        plan: { solution: '## 步骤\n\n先改 **鉴权中间件**,再补 `login.test.ts`', keyPoints: '', risks: '', acceptance: '' },
      }),
    })
    // 正文到屏幕上了(这一条挂了 = <Ansi> 整个没画出来)。
    expect(f).toContain('鉴权中间件')
    expect(f).toContain('步骤')
    // 记号没了 —— 这就是「上过色」的可观测证据:纯函数层返回 ansi:true 只说明我们打了个
    // 标记,说明不了渲染层认不认它。
    expect(f).not.toContain('**')
    expect(f).not.toContain('## ')
  })

  it('机器生成的段落一个记号都不许被吃掉', async () => {
    // `src/a_b.ts` 的下划线、`--flag` 的连字号在 markdown 里都是记号。这几段不上色,
    // 正是为了它们。
    const dep = mk({ id: 'root/01-a', title: 'a_b --flag [X]', status: 'ACCEPTED' })
    const f = await mountDetail({
      node: mk({ id: 'root/02-b', status: 'READY', deps: ['root/01-a'] }),
      resolveNode: (id: string) => (id === dep.id ? dep : undefined),
    })
    expect(f).toContain('a_b --flag [X]')
  })

  it('阻断原因仍然是红的 —— 那层颜色是语义,不能被 markdown 顶掉', async () => {
    const f = await mountDetail({
      node: mk({ id: 'n', status: 'BLOCKED', blockedReason: '验收迭代超限(3):[qa] 缺**测试**' }),
    })
    // 不上色 = 原文原样,包括那对星号。
    expect(f).toContain('缺**测试**')
  })
})

describe('模型用量', () => {
  it('详情页画出本节点和含子任务的两行', async () => {
    const kid = mk({ id: 'root/01-a', parentId: 'root', usage: use(8, 20_000, 3_000) })
    const f = await mountDetail({
      node: mk({ id: 'root', childIds: ['root/01-a'], usage: use(4, 10_000, 1_000) }),
      resolveNode: (id: string) => (id === kid.id ? kid : undefined),
    })
    expect(f).toContain('模型用量')
    expect(f).toContain('本节点')
    expect(f).toContain('4 次调用')
    // 合计 = 4 + 8;token 合计 34k。
    expect(f).toContain('12 次调用')
    expect(f).toContain('34.0k')
  })

  it('叶子节点只画一行 —— 两行相同的数字只会让人怀疑自己看错了', () => {
    const body = usageBody(mk({ id: 'n', usage: use(3, 100) }), () => undefined)
    expect(body.split('\n')).toHaveLength(1)
    expect(body).toContain('本节点')
  })

  it('有子任务但没接解析器时**不画合计** —— 画一个等于自己的合计是一句假话', () => {
    const n = mk({ id: 'root', childIds: ['root/01-a'], usage: use(4, 100) })
    const body = usageBody(n, undefined)
    expect(body).not.toContain('合计')
    // 但要明说这一屏取不到,而不是让人以为这个节点的子任务真的一次调用都没有。
    expect(body).toContain('取不到')
  })

  it('没有用量的节点整段不出现', () => {
    expect(usageBody(mk({ id: 'n' }), () => undefined)).toBe('')
  })

  it('树的表头给整趟的合计', async () => {
    const f = await mountTree({
      nodes: [mk({ id: 'root', usage: use(5, 1_000) }), mk({ id: 'root/01-a', parentId: 'root', usage: use(7, 2_000) })],
    })
    expect(f).toContain('12')
    expect(f).toContain('tokens')
  })

  it('一次调用都还没有时表头不画 `0 次` —— 那只是噪音', async () => {
    const f = await mountTree({ nodes: [mk({ id: 'root', title: '根任务' })] })
    expect(f).toContain('根任务')
    expect(f).not.toContain('tokens')
  })

  it('孤儿节点的账也算进整趟合计 —— 它是真花过钱的', () => {
    // 从根做子树合计会把父节点被重做删掉的那些整个漏掉。
    const total = runUsage([
      mk({ id: 'root', childIds: [], usage: use(1, 10) }),
      mk({ id: 'orphan', parentId: 'gone', usage: use(2, 20) }),
    ])
    expect(total.calls).toBe(3)
  })

  it('树行上的标记算的是**含子任务**的合计', () => {
    const nodes = [
      mk({ id: 'root', childIds: ['root/01-a'], usage: use(1, 10) }),
      mk({ id: 'root/01-a', parentId: 'root', usage: use(9, 90) }),
    ]
    const byId = new Map(nodes.map(n => [n.id, n]))
    /**
     * **逐字相等,不是 toContain。** 上一版写的是 `toContain('10')`,而算错时的输出
     * 是 `⇅1/10` —— 它也含 '10',于是「算自己那一份」这个变异活了下来。
     * 折叠着的拆分节点上,人想知道的正是「这一整块花了多少」。
     */
    expect(usageTag(nodes[0]!, byId)).toBe(' ⇅10/100')
    expect(usageTag(nodes[1]!, byId)).toBe(' ⇅9/90')
    expect(usageTag(mk({ id: 'x' }), byId)).toBe('')
  })

  it('被重做删掉的那部分,合计里**认账**', () => {
    /**
     * 任务重做把整棵子树从内存和盘上一起删掉,而 `runUsage` 逐个累加还活着的节点 ——
     * 验收实测一次重做让表头的总数当场掉了 83%,而 README 写的是「重做不清零,钱花掉了
     * 就是花掉了」。少报的正好是被丢弃的那部分工作,也正是他按下 `r` 那一刻最想知道的数。
     */
    const target = mk({ id: 'root', usage: use(4, 100), discardedUsage: use(20, 900) })
    expect(runUsage([target]).calls).toBe(24)
    expect(runUsage([target]).input).toBe(1000)
    // 子树合计同样算 —— 树行上那个标记读的是它。
    const byId = new Map([[target.id, target]])
    expect(usageTag(target, byId)).toBe(' ⇅24/1.0k')
  })

})

describe('窄终端上用量要给标题让路', () => {
  it('放不下就整个不画,而不是把标题夹成两个字', async () => {
    const long = mk({ id: 'root', title: '一个相当长的中文任务标题需要占掉很多列', usage: use(12, 30_000) })
    const wide = await mountTree({ nodes: [long] }, 120)
    const narrow = await mountTree({ nodes: [long] }, 46)
    // 宽的时候给。
    expect(wide).toContain('⇅12')
    // 窄的时候把这几列还给标题 —— 树行回答的第一个问题永远是「这是哪个任务」。
    expect(narrow).not.toContain('⇅12/')
    expect(narrow).toContain('一个相当长')
    /**
     * **表头那一截同样让路。**
     *
     * 验收实测 46 列时带用量的表头是 2 行、不带是 1 行;而这个面板的高度预算把
     * 「表头 1 行」当成前提 —— 多一行就把底部的图例和按键提示顶出屏幕。
     */
    expect(narrow).not.toContain('tokens')
    // 宽的时候在。
    expect(wide).toContain('tokens')
  })

  it('行末的用量标记不许被从右边啃掉 —— 那会显示一个**错的数字**', async () => {
    /**
     * `columns` 是终端宽度,而面板整个包在 `<Box borderStyle="round" paddingX={1}>` 里:
     * 边框 2 + 内边距 2 = 少 4 列。拿裸 `columns` 去算,评审用真渲染量到 70 列时
     * 屏幕上是 `⇅12/3…` —— 30.0k 被截成 3,而截断和「显示一个错数」是两回事。
     */
    const n = mk({ id: 'root', title: '一个相当长的中文任务标题需要占掉很多列', usage: use(12, 30_000) })
    for (const columns of [70, 80, 100, 120]) {
      const f = await mountTree({ nodes: [n] }, columns)
      // 要么整段不画(让位给标题),要么**画全** —— 不许画半截。
      const shown = f.includes('⇅12/30.0k')
      const truncated = /⇅12\/3(?!0\.0k)/.test(f) || f.includes('⇅12/…')
      expect(`${columns} 列被截了半截: ${truncated}`).toBe(`${columns} 列被截了半截: false`)
      if (columns >= 80) expect(`${columns} 列画全了: ${shown}`).toBe(`${columns} 列画全了: true`)
    }
  })

  it('让路的阈值比 clipToWidth 那个 6 列的兜底宽得多', () => {
    // 6 列是「宁可夹成两个字也别让行溢出」的最后一道保险,不是一个可读的标题。
    expect(MIN_TITLE_ROOM).toBeGreaterThan(6)
  })
})
