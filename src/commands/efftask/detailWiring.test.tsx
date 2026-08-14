/**
 * 三条**接线**:段落光标跟不跟焦点、页签反显、点页签换不换焦点;以及完成视图那个
 * 「下面还有几行」的生产者。
 *
 * 这四样此前全是零覆盖 —— 逐个改掉,全套 2150 条测试一条不红(验收在干净副本上实测)。
 * 它们说的是同一件事:**别画一个「选中了、但按键不归它」的假象**,以及**别少算别人的
 * 位置**。两样都属于这个仓库反复付学费的那一类。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { NodeDetail } from './NodeDetail.js'
import { doneSummaryRows, briefResolverFor } from './efftask.js'

const NOW = new Date().toISOString()
const ESC = String.fromCharCode(27)
const RIGHT = `${ESC}[C`
const TAB = '\t'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 30))

function fakeTty(rows = 24, columns = 100) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns, rows, write: () => true })
  return { stdin, stdout }
}

const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  kind: 'executable',
  ...over,
})

type Seen = { zone: string; tab: string; cursorShown: number; tabsInverse: string[] }

async function mount(over: Record<string, unknown> = {}) {
  const seen: Seen[] = []
  const t = fakeTty()
  const app = await render(
    React.createElement(NodeDetail as never, {
      node: node({ goal: '目标内容\n第二行', plan: { solution: '方案内容', keyPoints: '', risks: '', acceptance: '' } }),
      elapsed: '1m', columns: 100, maxRows: 20, logActive: true,
      onState: (s: Seen) => seen.push(s),
      ...over,
    } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { t, app, at: () => seen[seen.length - 1]! }
}

describe('焦点在哪,屏幕就只能标哪', () => {
  it('焦点在内容区的任务页卡上:段落画光标,页签不反显', async () => {
    const { app, at } = await mount()
    app.unmount()
    expect(`光标 ${at().cursorShown} 反显 ${at().tabsInverse.join()}`).toBe('光标 0 反显 ')
  })

  it('焦点移到页签条:段落光标必须撤掉,当前页签开始反显', async () => {
    // 不撤的话屏幕上有个 ❯ 说「这一段选中了」,而 ↑↓ 和空格此刻都不归它。
    const { t, app, at } = await mount()
    t.stdin.press(TAB)
    await tick()
    app.unmount()
    expect(`光标 ${at().cursorShown} 反显 ${at().tabsInverse.join()}`).toBe('光标 -1 反显 task')
  })

  it('切到输出页卡:段落光标也要撤掉 —— 那一屏根本没有段落', async () => {
    const store = { streams: [] as never[] }
    const { t, app, at } = await mount(store)
    t.stdin.press(RIGHT)
    await tick()
    app.unmount()
    expect(`页卡 ${at().tab} 光标 ${at().cursorShown}`).toBe('页卡 log 光标 -1')
  })

  it('回到内容区:光标回来,反显撤掉', async () => {
    const { t, app, at } = await mount()
    t.stdin.press(TAB); await tick()
    t.stdin.press(TAB); await tick()
    app.unmount()
    expect(`光标 ${at().cursorShown} 反显 ${at().tabsInverse.join()}`).toBe('光标 0 反显 ')
  })
})

describe('完成视图那个总结框占几行 —— 生产者也要被钉住', () => {
  /**
   * 这个数原来内联在 JSX 里:**把整个特性关掉(reservedRows={0})、或者把常数 4 改成 1,
   * 全套测试一条都不红**。已有的两条测试量的是消费者(面板收到之后有没有让位),
   * 喂的是写死的数字。而这个数正是那段注释吹嘘「数出来,不是估」的那件事。
   */
  it('空空如也时就是边框 2 + 标题 1 + 提示 1', () => {
    expect(doneSummaryRows({
      viewOnly: false, hasReason: false, hasHandoffResult: false,
      followUps: 0, handoffLines: 0, redoProblems: 0,
    })).toBe(4)
  })

  it('每一种可变行都真的被算进去,一行不落', () => {
    const base = { viewOnly: false, hasReason: false, hasHandoffResult: false, followUps: 0, handoffLines: 0, redoProblems: 0 }
    expect(doneSummaryRows({ ...base, hasReason: true })).toBe(5)
    expect(doneSummaryRows({ ...base, hasHandoffResult: true })).toBe(5)
    expect(doneSummaryRows({ ...base, followUps: 3 })).toBe(7)
    expect(doneSummaryRows({ ...base, handoffLines: 2 })).toBe(6)
    expect(doneSummaryRows({ ...base, redoProblems: 4 })).toBe(8)
    /**
     * 「那几类没查过,按 m 扫一遍」那一行也占一行。**不算进去的后果是把树顶出屏幕**——
     * 而这一行恰恰只在「看起来什么都不缺」时出现,也就是用户最不会怀疑版面的那一次。
     */
    expect(doneSummaryRows({ ...base, hasScanHint: true })).toBe(5)
    // 全都有的时候要累加,不是取最大。
    expect(doneSummaryRows({ viewOnly: false, hasReason: true, hasHandoffResult: true, followUps: 3, handoffLines: 2, redoProblems: 4 })).toBe(15) // 4+1+1+3+2+4
  })

  it('仅查看时显示的是「原样留在盘上」那一行,而 reason 不显示', () => {
    // 仅查看不是失败 —— 显示 reason 会把用户自己按的一下退出报成一次阻断。
    const base = { hasReason: true, hasHandoffResult: false, followUps: 0, handoffLines: 0, redoProblems: 0 }
    expect(doneSummaryRows({ ...base, viewOnly: true })).toBe(5)  // 4 + 那一行提示
    expect(doneSummaryRows({ ...base, viewOnly: false })).toBe(5) // 4 + reason
  })
})

describe('工具摘要解析器:真的会带着输入去调 userFacingName', () => {
  /**
   * 这一跳的测试此前**把它手抄了一遍**(测试文件里自己写了一份「逐字同构」的 resolver),
   * 于是把真的那份改成 `return undefined`、或者把 `input` 参数丢掉,全套测试一条不红 ——
   * 而那两种改法产出的正是用户报过的形状:窗口里只剩光秃秃的 `mcp__gitlab__list_issues`,
   * 或者 `Read` 后面没有文件名。
   */
  const tools = [
    { name: 'Read', userFacingName: () => 'Read' },
    { name: 'mcp__gitlab__list_issues', userFacingName: () => 'gitlab - List Issues (MCP)' },
    { name: 'Plan', userFacingName: (i: unknown) => ((i as { file?: string })?.file === 'plan.md' ? 'Reading Plan' : 'Read') },
    { name: 'Boom', userFacingName: () => { throw new Error('工具自己炸了') } },
  ]

  it('找得到就返回它的显示名', () => {
    expect(briefResolverFor(tools)('mcp__gitlab__list_issues', {})).toBe('gitlab - List Issues (MCP)')
  })

  it('**带着输入**调 —— 看输入的那些工具靠的就是这个参数', () => {
    expect(briefResolverFor(tools)('Plan', { file: 'plan.md' })).toBe('Reading Plan')
    expect(briefResolverFor(tools)('Plan', { file: 'x.ts' })).toBe('Read')
  })

  it('工具表里没有、或者工具自己抛了,都安静地返回 undefined', () => {
    expect(briefResolverFor(tools)('不存在的工具', {})).toBeUndefined()
    expect(briefResolverFor(tools)('Boom', {})).toBeUndefined()
  })
})

/**
 * 「起…止…共…」那一行也占一行 —— 评审点名的存活变异。
 *
 * 这个数错了的后果写在 doneSummaryRows 自己的注释里:面板按可用高度排版,而这个框画在
 * 它**下面**、高度随内容变;少算一行,详情页最底下那条页签条就会被顶出屏幕。
 */
describe('doneSummaryRows 把 run 时间窗那一行也数进去', () => {
  const base = { viewOnly: false, hasReason: false, hasHandoffResult: false, followUps: 0, handoffLines: 0, redoProblems: 0 }
  it('有那一行就多一行', () => {
    expect(doneSummaryRows({ ...base, hasRunSpan: true })).toBe(doneSummaryRows(base) + 1)
  })
  it('没有就不多', () => {
    expect(doneSummaryRows({ ...base, hasRunSpan: false })).toBe(doneSummaryRows(base))
  })
})
