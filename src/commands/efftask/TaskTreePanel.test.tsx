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
import { TaskTreePanel, visibleRows, viewport, elapsed, budgetedViewport, kindGlyph, KIND_GLYPH, HEADER_HINT_MIN_COLUMNS } from './TaskTreePanel.js'
import { NodeDetail, phaseTimeBody } from './NodeDetail.js'
import { PHASE_LABEL, PHASE_NAMES } from '../../tools/efftask/types.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'

const NOW = new Date().toISOString()
const ESC = String.fromCharCode(27)
const UP = ESC + '[A'
const DOWN = ESC + '[B'
const LEFT = ESC + '[D'
const RIGHT = ESC + '[C'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))
const tickEsc = (): Promise<void> => new Promise(r => setTimeout(r, 250))

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
  // Cursor-move sequences ARE the spacing, so they become a space; the bare ESC byte that
  // precedes them must then be removed or it lands between every pair of words.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  // rawFrame KEEPS the escape codes — `plain` strips exactly what a colour assertion needs.
  return { stdin, stdout, lastFrame: plain, rawFrame: () => frame, reset: () => { frame = '' } }
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

describe('表头一行装得下 —— 那是行预算的前提', () => {
  /**
   * 「面板高度 = 边框 2 + 表头 1 + height + 提示 1」是 `budgetedViewport` 全部预算的前提,
   * 而表头是**会回流的**(它是 `<Text>`,不是 truncate)。表头一旦折成两行,被顶出屏幕的
   * 正是底部的图例和按键提示。
   *
   * 这条不变量此前**一条测试都没有**,而 `HEADER_USAGE_MIN_COLUMNS` 的注释里那句
   * 「实测 46 列时是 2 行」只活在注释里。加 `+/-` 那 4 列时才发现没人守着它。
   */
  const usageTree = (): TaskNode[] => tree().map((n, i) => (
    i === 0 ? { ...n, usage: { calls: 6, input: 900, output: 300, cacheRead: 0, cacheWrite: 0 } } : n
  ))
  const mountAt = async (cols: number, over: Record<string, unknown> = {}) => {
    const t = fakeTty(cols)
    const app = await render(
      React.createElement(TaskTreePanel, {
        nodes: usageTree(), runId: '003', interactive: true,
        pool: () => ({ inUse: 2, limit: 7 }),
        runControl: {
          paused: false, onTogglePause: () => {}, onAddDirective: () => {},
          onCancelNode: () => {}, onAdjustParallelism: () => {},
        },
        ...over,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    return { ...t, app }
  }

  it('72 列时 并行占用 + `+/-` + 用量合计 仍在同一行', async () => {
    /**
     * 宽度写**字面量 72**,不是 `HEADER_HINT_MIN_COLUMNS`。
     *
     * 从常量自己推导的话,这两条用例永远钉不住那个值 —— 验收实测把它改成
     * 73/80/100 全套照绿,而改成 100 之后 80 列终端不再画 `+/-`,README 的
     * 「窄于 72 列」当场变假。常量和字面量必须分开断言,这才是「值本身」被守住。
     */
    expect(HEADER_HINT_MIN_COLUMNS).toBe(72)
    const m = await mountAt(72)
    const f = m.lastFrame()
    m.app.unmount()
    // 一行的证据:三者之间没有换行。中间那些空格数不能断言 —— `plain()` 把每段 ANSI
    // 换成一个空格,而分段是渲染细节。
    expect(f).toMatch(/并行 2\/7[^\n]*\+\/-[^\n]*⇅/)
  })

  it('窄于 72 列时整段不画 —— 4 列换两行表头不值', async () => {
    const m = await mountAt(71)
    const f = m.lastFrame()
    m.app.unmount()
    expect(f).toContain('并行 2/7')
    expect(f).not.toContain('+/-')
  })
})

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

describe('树行要能一眼看出哪个节点在等人(真渲染器)', () => {
  it('marks the node that is waiting on a human, not just [BLOCKED]', async () => {
    // mergeConflict is persisted and nothing rendered it: on a 100-node tree every ✗ looked
    // identical, so finding the one node waiting on YOU meant pressing Enter into each of them.
    const nodes = [
      mk({ id: 'root', title: '根', status: 'BLOCKED', blockedReason: '子节点阻断', childIds: ['root/01', 'root/02'], kind: 'decompose' }),
      mk({ id: 'root/01', parentId: 'root', depth: 1, title: '要人工解冲突的', status: 'BLOCKED', mergeConflict: true }),
      mk({ id: 'root/02', parentId: 'root', depth: 1, title: '验收超限的', status: 'BLOCKED', blockedReason: '验收迭代超限(3)' }),
    ]
    const { lastFrame, app } = await mount({ nodes })
    const frame = lastFrame()
    app.unmount()
    const rows = frame.split('\n')
    expect(rows.find(r => r.includes('要人工解冲突的'))).toContain('待人工解冲突')
    expect(rows.find(r => r.includes('验收超限的'))).not.toContain('待人工解冲突')
  })
})

describe('详情裁剪不能把最新发生的事截掉(真渲染器)', () => {
  it('keeps the LAST lines of 执行状态, where every conflict note is appended', async () => {
    // Three acceptance reviews measured the same thing: 执行状态 clipped to its first 4 lines,
    // so a node's last visible line was "自测全绿" while the conflict rejection that actually
    // blocked it — appended below — was findable nowhere in the TUI. blockedReason does not
    // carry it either.
    const n = mk({
      id: 'root', title: '接支付回调', status: 'BLOCKED',
      blockedReason: '合并冲突,已保留工作区待人工处理。',
      execStatus: [
        '已实现支付回调签名校验与幂等落库。',
        '改动文件:src/pay/callback.ts',
        '自测:bun test src/pay 全绿(17 项)。',
        '遗留:退款回调走旧分支,本次未动。',
        '(合并冲突解决)按集成分支的新签名重写了 refundKey 的调用点。',
        '(冲突解决后验收未通过: [qa] 解决冲突时把退款回调的重试丢了)',
      ].join('\n'),
    })
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail, { node: n, elapsed: '3s' } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('已实现支付回调签名校验')          // the head is still there
    expect(frame).toContain('解决冲突时把退款回调的重试丢了')  // and so is the newest line
    expect(frame).toContain('中间省略')                        // honestly labelled
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

describe('status colours must be real theme keys, not bare colour names', () => {
  // A review caught the whole efftask UI rendering monochrome. 'green'/'red'/'yellow'/'gray'
  // are NOT colours to this renderer: ThemedText.resolveColor passes anything that is not
  // rgb()/#/ansi256()/ansi: through as a THEME KEY, the theme has no such keys, so it
  // resolved to undefined and emitted nothing. Measured: color="green" → 0 SGR codes;
  // color="success" → ESC[32m.
  //
  // Asserting on emitted escape codes turned out to be the wrong probe — the renderer decides
  // colour support at module load, so under `bun test` it emits none and the assertion
  // passes for the wrong reason. Checking the NAMES against the real theme is env-independent
  // and lands exactly on the defect.
  it('every colour this UI asks for exists in the theme', async () => {
    const { getTheme } = await import('../../utils/theme.js')
    const theme = getTheme() as unknown as Record<string, unknown>
    const used = ['success', 'warning', 'inactive', 'error']
    for (const key of used) {
      expect(`${key}:${typeof theme[key]}`).toBe(`${key}:string`)
    }
    // …and the names that silently did nothing must not come back.
    for (const bad of ['green', 'red', 'yellow', 'gray', 'cyan']) {
      expect(`${bad}:${theme[bad] === undefined}`).toBe(`${bad}:true`)
    }
  })

  it('no efftask component passes a bare colour name', async () => {
    const files = [
      'TaskTreePanel.tsx', 'NodeDetail.tsx', 'ConfirmStartup.tsx',
      'ConfirmResume.tsx', 'ResumePicker.tsx', 'efftask.tsx', 'ConfirmHandoff.tsx',
    ]
    const fs = await import('node:fs/promises')
    for (const f of files) {
      const src = await fs.readFile(new URL(f, import.meta.url), 'utf-8')
      for (const bad of ['green', 'red', 'yellow', 'gray', 'cyan']) {
        expect(`${f}/${bad}:${src.includes(`color="${bad}"`) || src.includes(`'${bad}'`)}`)
          .toBe(`${f}/${bad}:false`)
      }
    }
  })
})

describe('评分必须在界面上可见(spec §10.1 / §10.2)', () => {
  // It was computed, persisted to node.md's frontmatter, and shown NOWHERE — a user who
  // configured an observer got a number that only existed on disk.
  const scored = (): TaskNode[] => {
    const t = tree()
    t[2].score = { plan: { role: 'w', score: 88, rationale: '方案清楚' }, exec: { role: 'w', score: 71, rationale: '测试偏少' } }
    return t
  }

  it('shows the WORST dimension inline on the row', async () => {
    // One number fits a row; showing the flattering one would hide exactly the case a
    // threshold exists to catch.
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel, { nodes: scored(), runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('★71')
    app.unmount()
  })

  it('shows both dimensions AND their reasons in the detail view', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel, { nodes: scored(), runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    for (let i = 0; i < 2; i++) { t.stdin.press(DOWN); await tick() } // → 写 schema
    t.reset()
    t.stdin.press('\r')
    await tick()
    const d = t.lastFrame()
    expect(d).toContain('评分')
    expect(d).toContain('88')
    expect(d).toContain('方案清楚')
    expect(d).toContain('测试偏少')
    app.unmount()
  })

  it('an unscored node adds no empty 评分 section', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel, { nodes: tree(), runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    expect(t.lastFrame()).not.toContain('评分')
    app.unmount()
  })
})

describe('视口:大树不得把光标和表头挤出屏幕', () => {
  // At the default cap of 100 nodes the panel drew 105 lines. In a 40-line terminal the
  // cursor AND the counts header scrolled off, so the user could not see what they had
  // selected — a review measured exactly this.
  const big = (n: number): TaskNode[] => {
    const root = mk({ id: 'root', title: '根', status: 'WAITING_CHILDREN', kind: 'decompose' })
    const kids = Array.from({ length: n }, (_, i) =>
      mk({ id: `root/${String(i + 1).padStart(2, '0')}-k`, title: `任务${i + 1}`, parentId: 'root', depth: 1, status: 'READY', kind: 'executable' }))
    root.childIds = kids.map(k => k.id)
    return [root, ...kids]
  }

  it('draws at most maxRows tree rows regardless of tree size', () => {
    const rows = visibleRows(big(100), new Set())
    expect(rows).toHaveLength(101)
    expect(viewport(rows, 0, 20).slice).toHaveLength(20)
    expect(viewport(rows, 100, 20).slice).toHaveLength(20)
  })

  it('always keeps the cursor inside the drawn slice', () => {
    const rows = visibleRows(big(100), new Set())
    for (const cursor of [0, 1, 5, 50, 99, 100]) {
      const v = viewport(rows, cursor, 20)
      expect(`${cursor}:${cursor >= v.from && cursor < v.from + v.slice.length}`).toBe(`${cursor}:true`)
    }
  })

  it('does not clip a tree that already fits', () => {
    const rows = visibleRows(big(5), new Set())
    const v = viewport(rows, 0, 20)
    expect(v.from).toBe(0)
    expect(v.slice).toHaveLength(rows.length)
  })

  it('shows a position indicator only when rows are hidden', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel, { nodes: big(100), runId: '003', interactive: true, maxRows: 10 } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    expect(f).toContain('1/101')
    expect(f).toContain('根')      // the header row is still on screen
    expect(f).toContain('高效任务') // and so is the counts line
    app.unmount()
  })
})

/** 造一条流。事件按行,和真实提取出来的形状一致。 */
let __seq = 0
const mkStream = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  meta: { nodeId: 'n', phaseLabel: '执行', label: '甲员工' },
  events: [], dropped: 0, toolCount: 0, startedAt: Date.now() - 1000,
  closed: false, seq: __seq++, ...over,
})
const lines = (...t: string[]): Record<string, unknown>[] => t.map(x => ({ kind: 'text', text: x }))
/** 一个只读的假 store,够 TaskTreePanel 用。 */
const fakeStore = (byNode: Record<string, Record<string, unknown>[]>, dropped = 0) => ({
  open: () => ({ push: () => {}, end: () => {} }),
  streams: (id: string) => byNode[id] ?? [],
  droppedEvents: () => dropped,
  nodes: () => Object.keys(byNode),
  subscribe: () => () => {},
  markHistorical: () => {},
  isHistorical: () => false,
  totalEvents: () => 0,
})

describe('节点详情里的子 agent 实时输出 (spec §10.2)', () => {
  const store = (lines: string[], dropped = 0) => ({
    push: () => {}, lines: () => lines, dropped: () => dropped, nodes: () => ['n'],
  })

  it('shows the stream for the node being viewed', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', title: '打通接口', status: 'EXECUTING', kind: 'executable' }),
        elapsed: '1m',
        columns: 100,
        initialTab: 'log',
        streams: [mkStream({ events: lines('正在改 src/login.ts', '跑测试:12 通过') })],
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    expect(f).toContain('子 agent 输出')
    expect(f).toContain('正在改 src/login.ts')
    expect(f).toContain('跑测试:12 通过')
    app.unmount()
  })

  it('keeps the TAIL — a live log is read from its newest line', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', status: 'EXECUTING', kind: 'executable' }),
        elapsed: '1m', maxRows: 24, columns: 100, initialTab: 'log',
        streams: [mkStream({ events: lines(...[...Array(60)].map((_, i) => `行 ${i}`)) })],
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // The newest line must be on screen; the oldest must not push it off.
    expect(t.lastFrame()).toContain('行 59')
    expect(t.lastFrame()).not.toContain('行 0 ')
    app.unmount()
  })

  it('says how much scrolled out of the buffer instead of implying it shows everything', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', status: 'EXECUTING', kind: 'executable' }),
        elapsed: '1m', columns: 100, initialTab: 'log',
        streams: [mkStream({ events: lines('最后一行'), dropped: 143 })],
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('143')
    expect(t.lastFrame()).toContain('滚出缓冲')
    app.unmount()
  })

  it('没有输出时,输出页卡说「暂无输出」,不画一个空窗口假装有内容', async () => {
    // 页卡本身是**常在**的(它是版面的一部分,不能忽有忽无 —— 那会让页签条的宽度
    // 每次运行都不一样)。要守的是:切过去看到的是一句实话,而不是一个空框。
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, { node: mk({ id: 'n' }), elapsed: '1m', streams: [], initialTab: 'log' } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('暂无输出')
    // 页签上那个「(N)」只在真有流的时候才出现 —— 否则它自己就是一句假话。
    expect(t.lastFrame()).not.toContain('输出(')
    app.unmount()
  })

  it('按 → 就能从任务页卡切到输出页卡 —— 键真的接通了', async () => {
    // 上面那几条是用 initialTab 直接开在输出页卡上的,它证明不了**切**得过去。
    // ←/→ 在这一屏原来是死键,这条钉的就是它现在真的管用。
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', status: 'EXECUTING', kind: 'executable' }),
        elapsed: '1m', columns: 100, logActive: true,
        streams: [mkStream({ events: lines('切过来才看得到这句') })],
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).not.toContain('切过来才看得到这句')
    t.stdin.press('\u001b[C') // →
    await tick()
    expect(t.lastFrame()).toContain('切过来才看得到这句')
    app.unmount()
  })

  it('the panel hands the RIGHT node\'s stream to the detail view', async () => {
    // Two nodes with output; opening one must not show the other's. The store is read at
    // render time by node id, so a wrong id here silently shows someone else's log.
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: tree(), runId: '003', interactive: true,
        // Every node has DISTINCT output, keyed by id. A panel that passed a fixed id — or the
        // wrong node's id — would show someone else's log with no visible sign of it.
        streams: {
          open: () => ({ push: () => {}, end: () => {} }),
          streams: (id: string) => [mkStream({ meta: { nodeId: id, phaseLabel: '执行', label: '甲' }, events: lines('输出属于 ' + id) })],
          droppedEvents: () => 0, nodes: () => [], subscribe: () => () => {},
          markHistorical: () => {}, isHistorical: () => false, totalEvents: () => 0,
        },
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // Move OFF root first, or a hard-coded 'root' would pass by accident.
    t.stdin.press(DOWN)
    await tick()
    t.stdin.press('\r')
    await tick()
    expect(t.lastFrame()).toContain('输出属于 root/01-甲')
    expect(t.lastFrame()).not.toContain('输出属于 root ')
    app.unmount()
  })
})

describe('实时输出面板不能只交代一半的截断', () => {
  const mountDetail = async (props: Record<string, unknown>) => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', status: 'EXECUTING', kind: 'executable' }), elapsed: '1m', ...props,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    return f
  }

  it('spec §10.2:依赖显示成标题和状态,不是"依赖 2 个"', async () => {
    // 计数回答不了读的人真正的两个问题 —— 是**哪些**任务、它们跑完了没有 —— 而这个面板
    // 正是有人来查"这个节点为什么一直停在 READY"的地方。
    const dep = mk({ id: 'root/01-a', title: '建表', status: 'ACCEPTED' })
    const f = await mountDetail({
      node: mk({ id: 'root/02-b', title: '写接口', status: 'READY', deps: ['root/01-a', 'root/09-gone'] }),
      resolveNode: (id: string) => (id === dep.id ? dep : undefined),
    })
    // 标题**恰好**是「依赖」:toContain('依赖') 是超集匹配,改成「依赖项目清单」照样绿
    // (验收评审实测)。后面跟空白 = 这一行到此为止。
    expect(f).toMatch(/依赖\s/)
    expect(f).toContain('建表')
    expect(f).toContain('ACCEPTED')
    // 缺失的依赖要报出来,不能悄悄缩短列表 —— 那恰恰是这个节点推不动的原因。
    expect(f).toContain('节点缺失')
  })

  it('没接解析器时退化成裸 id,不能说成"节点缺失"', async () => {
    // 「调用方忘了接线」和「依赖真的没了」是两件事。默认值原本选反了:没有 resolveNode 时
    // 每一条**健康**依赖都被渲染成「节点缺失」—— 恰好是这个仓库反复在修的那一类谎,而且
    // 会把人送去查一个并不存在的故障。
    const f = await mountDetail({ node: mk({ id: 'n', deps: ['root/01-a'] }) })
    expect(f).toContain('root/01-a')
    expect(f).not.toContain('节点缺失')
  })

  it('没有依赖时不渲染空的「依赖」小节', async () => {
    const f = await mountDetail({ node: mk({ id: 'n', title: '独立任务', deps: [] }) })
    expect(f).not.toContain('依赖')
    // 正向锚点:否则一个空帧(渲染整个挂了)也能满足上面那条否定断言。
    expect(f).toContain('独立任务')
  })

  it('面板真的把整棵树交给了详情 —— 否则依赖只能显示成 id', async () => {
    // 上面那条把 resolveNode 直接喂给 NodeDetail,绕过了 TaskTreePanel 这一跳。而这个仓库
    // 剪断过的正是这种线(chunks 传给了视图却没往下转、pool reader 同理)。这条从面板按键
    // 进详情,把那一跳也钉住。
    const a = mk({ id: 'root', title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const dep = mk({ id: 'root/01-a', title: '建表', parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const b = mk({ id: 'root/02-b', title: '写接口', parentId: 'root', depth: 1, status: 'READY', deps: ['root/01-a'] })
    a.childIds = ['root/01-a', 'root/02-b']
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel, { nodes: [a, dep, b], runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(DOWN); await tick()  // → 建表
    t.stdin.press(DOWN); await tick()  // → 写接口
    t.reset()
    t.stdin.press('\r'); await tick()  // 回车进详情
    const f = t.lastFrame()
    expect(f).toContain('建表(ACCEPTED)') // 标题+状态,只有拿到整棵树才渲染得出来
    app.unmount()
  })

  it('隐藏的行数把"滚出缓冲"和"没渲染"两部分都算进去', async () => {
    // Measured before: the buffer dropped 300 and the pane then rendered only its last 8, so a
    // user was told 300 were hidden while 492 were. Same "starts in the middle but looks
    // complete" lie block() had to fix in this very file.
    const f = await mountDetail({
      columns: 100, maxRows: 24, initialTab: 'log',
      streams: [mkStream({ events: lines(...[...Array(200)].map((_, i) => `行${i}`)), dropped: 42 })],
      droppedEvents: 342,
    })
    // 节点级的计数**已经把两部分都算进去了**(store 的 droppedEvents 同时累加环形缓冲
    // 丢掉的和被压成墓碑时带走的),所以这里只有一个数要报 —— 但它必须在**跟随最新**的
    // 时候也看得见。钉在滚动区之外就是为这件事:当日志的第一行发出去,它会被粘底行为
    // 埋掉,于是一个残缺的视图看起来完完整整。
    expect(f).toContain('342')
    expect(f).toContain('已释放')
    // …而且最新那一行同时在屏幕上。
    expect(f).toContain('行199')
  })

  it('缓冲没丢过东西时,不提"滚出缓冲"', async () => {
    const f = await mountDetail({ columns: 100, streams: [mkStream({ events: lines('一', '二') })], droppedEvents: 0, initialTab: 'log' })
    expect(f).not.toContain('滚出缓冲')
    expect(f).not.toContain('已释放')
  })

  it('输出区有自己的预算,不是各段落里最小的那一份', async () => {
    // At perSection*2 the pane rendered a fixed 8 lines, leaving 96% of a 200-line buffer
    // permanently unreachable — a long way from §10.2's "与单个子 agent 终端观感一致".
    // Zero-padded: 'L1' is a SUBSTRING of 'L10'..'L19', so an unpadded fixture counted lines
    // that were never rendered and the assertion held no matter what the budget was.
    const names = [...Array(60)].map((_, i) => `L${String(i).padStart(3, '0')}`)
    const f = await mountDetail({ columns: 100, streams: [mkStream({ events: lines(...names) })], maxRows: 24, initialTab: 'log' })
    const shown = names.filter(l => f.includes(l))
    expect(shown.length).toBeGreaterThan(8)
  })
})


describe('耗时要量的是"干活的时间",不是"活了多久" (spec §10.1)', () => {
  it('从没跑过的节点显示"排队中",不是它被创建以来的秒数', () => {
    // Measured: a node blocked behind unfinished dependencies rendered 3600s an hour after
    // the tree was built, so a user hunting for the slow node was pointed at one that had
    // not started.
    const queued = mk({ id: 'q', status: 'CREATED', createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    expect(elapsed(queued, Date.now())).toBe('排队中')
  })

  it('从进入活动态起算', () => {
    const n = mk({
      id: 'r', status: 'EXECUTING',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    })
    const s = Number(elapsed(n, Date.now()).replace('s', ''))
    expect(s).toBeGreaterThanOrEqual(4)
    expect(s).toBeLessThan(10)   // NOT 3600
  })

  it('终态节点用 updatedAt 收尾', () => {
    const n = mk({
      id: 'r', status: 'ACCEPTED',
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
    })
    expect(elapsed(n, Date.now())).toBe('20s')
  })

  it('从没跑过就被阻断的节点显示 -,不假装它跑过', () => {
    expect(elapsed(mk({ id: 'x', status: 'BLOCKED' }), Date.now())).toBe('-')
  })
})

describe('顶部状态条的并行占用 (spec §10.1)', () => {
  it('显示 n/N,数的是池子的占用而不是"跑着的节点数"', async () => {
    // The pool's occupancy includes the reviewers a roundtable is running — that is precisely
    // the number the confirmation gate promised to cap, and counting nodes would under-report
    // it by a factor of |roles|.
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: tree(), runId: '003', interactive: true,
        pool: () => ({ inUse: 4, limit: 5 }),
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('并行 4/5')
    app.unmount()
  })

  it('没有 pool 时不渲染这一段,也不显示 0/0', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, { nodes: tree(), runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).not.toContain('并行')
    app.unmount()
  })

  it('节点详情列出已经花掉的迭代次数 (spec §10.2)', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({
          id: 'n', status: 'BLOCKED', kind: 'executable',
          iteration: { planReview: 1, acceptance: 3, integration: 0, scoring: 0, mergeResolve: 1 },
        }),
        elapsed: '1m',
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    expect(f).toContain('迭代次数')
    expect(f).toContain('验收返工 3')
    expect(f).toContain('自动解决合并冲突 1')
    // Counters at zero are omitted rather than rendered as noise.
    expect(f).not.toContain('集成验收返工')
    app.unmount()
  })

  it('一次都没返工的节点不显示这一段', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, { node: mk({ id: 'n' }), elapsed: '1m' } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).not.toContain('迭代次数')
    app.unmount()
  })
})

describe('startedAt 不是字符串时,耗时不能渲染成 1900 年', () => {
  it('非字符串一律显示 -', () => {
    // Date.parse(123) does NOT throw, it coerces — and Number.isFinite then passed, so a
    // hand-edited `startedAt: 123` rendered as 60070736830s. This field exists precisely so
    // the panel does not point at the wrong node.
    for (const bad of [123, true, {}, []]) {
      const n = mk({ id: 'x', status: 'EXECUTING', startedAt: bad as never })
      expect(elapsed(n, Date.now())).toBe('-')
    }
  })

  it('无法解析的字符串也显示 -', () => {
    expect(elapsed(mk({ id: 'x', status: 'EXECUTING', startedAt: 'not a date' }), Date.now())).toBe('-')
  })
})


describe('updatedAt 也要查类型', () => {
  it('终态节点的 updatedAt 不是字符串时,不把两小时显示成 0s', () => {
    // Date.parse(123) coerces rather than throwing, and Math.max(0, …) then floored a
    // two-hour node to 0s — the same "points at the wrong node" this field exists to prevent.
    const n = mk({
      id: 'x', status: 'ACCEPTED',
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      updatedAt: 123,
    })
    expect(elapsed(n, Date.now())).not.toBe('0s')
  })
})

describe('spec §10.2:详情页要显示各阶段耗时', () => {
  const mountDetail = async (props: Record<string, unknown>) => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, { elapsed: '1m', ...props } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    return f
  }

  it('按耗时从大到小列出,让人一眼看到时间花在哪', async () => {
    const f = await mountDetail({
      // 插入顺序**故意**和耗时顺序相反:第一版按 EXECUTING 最大且写在最前面构造,于是
      // Object.entries 的天然顺序就已经满足断言,把 .sort() 删掉照样绿(变异跑出来的)。
      node: mk({ id: 'n', phaseMs: { ACCEPTANCE: 8_000, PLAN_REVIEW: 45_000, EXECUTING: 120_000 } }),
    })
    expect(f).toContain('各阶段耗时')
    // 分钟以上给 `2m0s` 而不是 `120s`:加上时间点之后这一列要和时刻并排读,而一个
    // 45 分钟的执行环节原来印的是 `2700s`。
    expect(f).toContain('执行 2m0s')
    expect(f).toContain('质疑修复 45s')
    // 顺序:**没有时间点**的老数据仍然按耗时倒序 —— 执行(120)排在质疑修复(45)前面,
    // 质疑修复又在验收(8)前面。读的人是来找"时间花哪了"的。
    expect(f.indexOf('执行 2m0s')).toBeLessThan(f.indexOf('质疑修复 45s'))
    expect(f.indexOf('质疑修复 45s')).toBeLessThan(f.indexOf('验收 8s'))
  })

  it('不足一秒、又没有时间点的阶段不列 —— 一行 0s 只会让人以为那里出了问题', async () => {
    // 用一个生产**真的会产出**的状态。第一版拿 SCORING 当样本 —— 而当时 SCORING 压根不在
    // 白名单里、phaseMs 里永远不会出现它,所以那条断言测的是一个不存在的情况。
    const f = await mountDetail({ node: mk({ id: 'n', phaseMs: { EXECUTING: 60_000, PLAN_REVIEW: 300 } }) })
    expect(f).toContain('执行 1m0s')
    // 断言的是**这个状态的中文标签**。上一版写的是 `not.toContain('方案评审')`,而
    // PLAN_REVIEW 的标签是「质疑修复」—— 那条断言恒真,把整条过滤删掉照样绿。
    expect(f).not.toContain('质疑修复')
  })

  /**
   * 用户原话:「任务运行和阶段运行,都要有具体的运行时间点,现在只有一个运行了多长时间。」
   *
   * 一个 `749s` 回答不了他真正在问的那个问题:**那是什么时候的事**。
   */
  it('有时间点时,每个阶段印出「什么时候进、什么时候出」,并按发生顺序排', async () => {
    const f = await mountDetail({
      node: mk({
        id: 'n',
        // 插入顺序和时间顺序相反 —— 排序真的发生了才会绿。
        phaseMs: { ACCEPTANCE: 8_000, EXECUTING: 120_000 },
        phaseAt: {
          EXECUTING: { first: '2026-07-31T09:00:00.000Z', last: '2026-07-31T09:02:00.000Z' },
          ACCEPTANCE: { first: '2026-07-31T09:05:00.000Z', last: '2026-07-31T09:05:08.000Z' },
        },
      }),
    })
    /**
     * 日期前缀是**可选**的,不是漏写。
     *
     * `timePoint` 只给今天的时刻印 `时:分:秒`,跨天的会带上 `07-31` —— 而上面那两个时刻是
     * 写死的日期。原来的正则不收日期前缀,于是这条测试**只在 2026-07-31 当天是绿的**,
     * 过了那天以后一直红着(实测:`执行 07-31 09:00:00 → …`)。
     *
     * 修法不是把时刻改成「今天」:那会让它在午夜前后跨天翻车,换一种更难查的红。
     * 这条测试要守的是「每个阶段印出进出时刻、带累计、按发生顺序排」,日期印不印由
     * `timePoint` 自己的用例守(见 detailSections 那组)。
     */
    expect(f).toMatch(/执行 (\d\d-\d\d )?\d\d:\d\d:\d\d → (\d\d-\d\d )?\d\d:\d\d:\d\d · 累计 2m0s/)
    expect(f).toMatch(/验收 (\d\d-\d\d )?\d\d:\d\d:\d\d → (\d\d-\d\d )?\d\d:\d\d:\d\d · 累计 8s/)
    // 时间线不是排行榜:先发生的排前面,哪怕它更短。
    expect(f.indexOf('执行')).toBeLessThan(f.indexOf('验收'))
  })

  it('进了还没出来的阶段说「进行中」,不拿此刻冒充结束时刻', async () => {
    // 一个被杀在半路的节点走的也是这一支。拿 now 去填会让它显示成「刚刚还在跑」。
    const f = await mountDetail({
      node: mk({ id: 'n', phaseMs: {}, phaseAt: { EXECUTING: { first: '2026-07-31T09:00:00.000Z' } } }),
    })
    expect(f).toContain('进行中')
  })

  it('节点自己的时间线:创建 / 开始 / 结束', async () => {
    const f = await mountDetail({
      node: mk({
        id: 'n', status: 'ACCEPTED',
        createdAt: '2026-07-31T08:00:00.000Z',
        startedAt: '2026-07-31T09:00:00.000Z',
        finishedAt: '2026-07-31T09:30:00.000Z',
      }),
    })
    expect(f).toContain('创建')
    expect(f).toContain('开始')
    expect(f).toContain('结束')
    // 开始→结束的跨度,和「各阶段耗时」的合计不是一回事(中间还有排队和等子任务)
    expect(f).toContain('历时 30m0s')
  })

  it('还没结束的节点说「进行中,至今 …」,而不是印一个空的结束时刻', async () => {
    const f = await mountDetail({
      node: mk({ id: 'n', status: 'EXECUTING', startedAt: new Date(Date.now() - 65_000).toISOString() }),
    })
    expect(f).toContain('进行中,至今')
  })

  it('REWORK 那一行不能叫"返工" —— 它量的不是返工', async () => {
    // REWORK 的窗口里只有一件事:refreshFromIntegration,把兄弟节点已合入的改动拉进本节点
    // 的 worktree,然后就 commit(EXECUTING) 了。真正的返工工作量记在下一轮 EXECUTING 名下。
    // 一行「返工 45s」紧挨着「迭代次数 · 验收返工 2」印着,两个数字会互相误导。
    const f = await mountDetail({ node: mk({ id: 'n', phaseMs: { REWORK: 45_000 } }) })
    expect(f).toContain('45s')
    expect(f).toContain('同步集成分支')
    expect(f).not.toMatch(/[^前]返工 45s/)
  })

  it('还没跑过的节点不渲染这一段', async () => {
    const f = await mountDetail({ node: mk({ id: 'n', title: '刚建好' }) })
    expect(f).not.toContain('各阶段耗时')
    expect(f).toContain('刚建好') // 正向锚点
  })
})

describe('各阶段耗时不能把内部枚举名漏给用户', () => {
  it('每个会计时的状态都有中文标签', () => {
    // 漏一个,那一行就渲染成 `VERIFYING 5s` —— 内部枚举名直接摆到用户面前。
    const n = tree()[0]
    n.phaseMs = {
      PLANNING: 1000, PLAN_REVIEW: 1000, EXECUTING: 1000, VERIFYING: 1000,
      ACCEPTANCE: 1000, REWORK: 1000, INTEGRATION_ACCEPT: 1000, SCORING: 1000, MERGE: 1000,
    } as never
    const body = phaseTimeBody(n)
    for (const st of ['PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'VERIFYING', 'ACCEPTANCE',
                      'REWORK', 'INTEGRATION_ACCEPT', 'SCORING', 'MERGE']) {
      expect(`${st}:${body.includes(st)}`).toBe(`${st}:false`)
    }
    expect(body).toContain('测试修复')
  })
})

describe('运行中的界面不能还叫旧名', () => {
  it('阶段耗时行用的是 PHASE_LABEL 里的名字', () => {
    // 「集成提交」改名成「集成验收」的**全部理由**就是前者听起来像在做合并,而它不做
    // 合并(README 特意声明过)。关口、错误信息、升级卡、两份文档都改了,只有用户
    // 真正盯着跑的这块屏幕没改 —— 他会以为有两个环节,或者以为这一步在提交代码。
    const body = phaseTimeBody({
      phaseMs: { PLANNING: 3000, PLAN_REVIEW: 3000, EXECUTING: 3000, VERIFYING: 3000,
        ACCEPTANCE: 3000, INTEGRATION_ACCEPT: 3000, SCORING: 3000 },
    } as never)
    // 七个环节的名字都必须来自同一个源;任何一个漂了,这里就红。
    for (const p of PHASE_NAMES) {
      expect(`${p} 的标签: ${body.includes(PHASE_LABEL[p])}`).toBe(`${p} 的标签: true`)
    }
    expect(body).not.toContain('集成提交')
  })
})

describe('budgetedViewport —— 画出去的终端行数不能超预算', () => {
  const rows = (n: number) => [...Array(n)].map((_, i) => i)

  it('全是单行时就是普通 viewport', () => {
    const v = budgetedViewport(rows(40), rows(40).map(() => 1), 10, 20)
    expect(v.slice).toHaveLength(20)
  })

  it('随机扫描:Σcost(实际画的那些行) 恒不超 height', () => {
    // 第一版是两趟 viewport,而两趟的 from 不是同一个 —— 「按哪些行算的预算」和「实际画
    // 的哪些行」错开。20 万次随机扫描里最坏一例超 7 行,顶掉的正是底部的计数和按键提示。
    // 这条测试是那次实测的固化:不看实现怎么写,只看这条不变量。
    let worst = 0
    let worstCase = ''
    // 确定性伪随机 —— 这个仓库的测试不许摸真实时钟,也不该跑一次绿一次红。
    let seed = 12345
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (let t = 0; t < 4000; t++) {
      const total = 1 + rnd(60)
      const height = 3 + rnd(30)
      const cursor = rnd(total)
      const runFrom = rnd(total)
      const cost = [...Array(total)].map((_, i) => (i >= runFrom ? 2 : 1))
      const v = budgetedViewport(rows(total), cost, cursor, height)
      const used = cost.slice(v.from, v.from + v.slice.length).reduce((a, b) => a + b, 0)
      if (used - height > worst) {
        worst = used - height
        worstCase = `total=${total} height=${height} cursor=${cursor} runFrom=${runFrom} from=${v.from} used=${used}`
      }
    }
    expect(`最坏超出 ${worst} 行 ${worstCase}`).toBe('最坏超出 0 行 ')
  })

  it('至少画一行 —— 预算再紧也不能把树整个变空', () => {
    expect(budgetedViewport(rows(5), [2, 2, 2, 2, 2], 0, 1).slice.length).toBeGreaterThanOrEqual(1)
  })
})

describe('拆分任务 / 执行任务 要一眼分得开', () => {
  it('kindGlyph:三种 kind 三个符号', () => {
    expect(kindGlyph({ kind: 'decompose', childIds: [] })).toBe(KIND_GLYPH.decompose)
    expect(kindGlyph({ kind: 'executable', childIds: [] })).toBe(KIND_GLYPH.executable)
    expect(kindGlyph({ kind: 'unknown', childIds: [] })).toBe(KIND_GLYPH.unknown)
    // 三个必须互不相同,否则「分得开」这件事根本不成立
    expect(new Set(Object.values(KIND_GLYPH)).size).toBe(3)
  })

  it('有孩子就是拆分节点,哪怕 kind 还写着 executable', () => {
    // 动态生长会把子节点嫁接到一个已经判成 executable 的节点上(spec §4),此时 kind
    // 还没被改写。只看 kind 的话,一个明明有 3 个孩子的行会画成「执行任务」—— 树上
    // 直接说假话。
    expect(kindGlyph({ kind: 'executable', childIds: ['a', 'b', 'c'] })).toBe(KIND_GLYPH.decompose)
  })

  it('标记不和已有的字形撞', () => {
    // 撞了就分不出「这是折叠箭头还是任务类型」。已有的:光标、折叠、状态、活动行。
    const taken = ['❯', '▾', '▸', '●', '◐', '○', '✗', '⎿', ' ']
    for (const g of Object.values(KIND_GLYPH)) {
      expect(`${g} 撞了: ${taken.includes(g)}`).toBe(`${g} 撞了: false`)
    }
  })

  it('树上真的画出来了,而且拆分和执行画的不是同一个', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: [
          mk({ id: 'root', title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] }),
          mk({ id: 'root/01-a', title: '写代码', parentId: 'root', depth: 1, status: 'EXECUTING', kind: 'executable' }),
        ],
        runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    // 两个符号都在屏幕上,而且图例也在 —— 只画符号不给图例等于让人猜。
    expect(f).toContain(KIND_GLYPH.decompose)
    expect(f).toContain(KIND_GLYPH.executable)
    expect(f).toContain('拆分')
    expect(f).toContain('执行')
    app.unmount()
  })

  it('详情页用文字说清是哪一种', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, {
        node: mk({ id: 'n', title: '写代码', kind: 'executable' }), elapsed: '1m',
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('执行任务')
    app.unmount()
  })

  it('长标题被截断,不回流成两行 —— 一行一个终端行是行预算的前提', async () => {
    // 行预算(budgetedViewport)按「一行 = 一个终端行」结算。默认 wrap 会把一个超长标题
    // 回流成好几行,预算就白算了,底部的计数和按键提示照样被顶出屏幕。
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: [mk({ id: 'root', title: 'x'.repeat(500), status: 'READY', kind: 'executable' })],
        runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const rows = t.lastFrame().split('\n').filter(l => l.includes('xxx'))
    expect(`标题占了 ${rows.length} 个终端行`).toBe('标题占了 1 个终端行')
    app.unmount()
  })

  it('图例三种都列,而且分隔符不能是「待定」那个字形', async () => {
    // '·' 既是分隔符又是「待定」的字形 —— 图例 `⊞ 拆分任务 · ▪ 执行任务` 读起来像三项。
    // 而且树上画三种、详情页写三种,只有图例是两种,等于让人猜第三种。
    const t = fakeTty()
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: [mk({ id: 'root', title: '根', status: 'READY', kind: 'unknown' })],
        runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    for (const label of ['拆分', '执行', '待定']) expect(f).toContain(label)
    // 图例内部和图例↔按键之间都不能用 '·' 分隔 —— 那正是「待定」的字形,读起来会多出一项。
    const legend = f.split('\n').find(l => l.includes('待定')) ?? ''
    expect(`图例里用了点号分隔: ${/待定\s*·/.test(legend)}`).toBe('图例里用了点号分隔: false')
    app.unmount()
  })

  it('状态和耗时永远留在屏幕上 —— 哪怕标题很长、后缀是中文', async () => {
    // 整行交给 truncate-end 的话,从右边吃掉的正好是状态和耗时。实测 80 列 + 27 字中文
    // 标题:`[WAITING_CHILDREN]` 被截成 `[WAITING_CHIL…`,耗时整个没了。
    // 后缀宽度要按 stringWidth 量:「待人工解冲突」是 7 个 UTF-16 单元但占 13 列。
    const t = fakeTty()
    t.stdout.columns = 80
    const app = await render(
      React.createElement(TaskTreePanel as never, {
        nodes: [mk({
          id: 'root', title: '这是一个非常非常长的中文任务标题用来把这一行撑爆掉',
          status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['x'], mergeConflict: true,
        })],
        runId: '003', interactive: true,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    // 这个夹具的 ANSI 剥离正则会把 `[W` 当成转义序列吃掉,所以断言的是幸存的那半截。
    // (`[WAITING_CHILDREN]` → ` AITING_CHILDREN]`,这是夹具的老毛病,不是本次改动。)
    expect(`状态还在: ${f.includes('AITING_CHILDREN')}`).toBe('状态还在: true')
    expect(`冲突标记还在: ${f.includes('待人工解冲突')}`).toBe('冲突标记还在: true')
    expect(`标题被截断了: ${f.includes('…')}`).toBe('标题被截断了: true')
    app.unmount()
  })

  it('24 行终端上整个面板不超屏 —— 高度要跟着终端行数走', async () => {
    // 写死 20 时:边框 2 + 表头 1 + 20 + 提示 1 = 24,一点富余都没有,而 24 行是极常见
    // 的默认。budgetedViewport 的注释自己说「溢出的那几行顶掉的正是底部的计数与按键
    // 提示」—— 行预算算得再准,也被面板外的固定开销吃掉。
    const t = fakeTty()
    t.stdout.rows = 24
    const nodes = [...Array(60)].map((_, i) => mk({ id: `n${i}`, title: `任务${i}`, status: 'READY', kind: 'executable' }))
    const app = await render(
      React.createElement(TaskTreePanel as never, { nodes, runId: '003', interactive: true } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const lines = t.lastFrame().split('\n').filter(l => l.trim().length > 0)
    // 不是「不超过 24」——写死 20 时正好是 24,占满整屏、一点余量都没有,而 /et 是
    // 渲染在 REPL 消息流里的,上面还有对话内容、下面还有输入行。要留出余量。
    expect(`面板占了 ${lines.length} 行(终端 24,要留余量)`).toBe('面板占了 20 行(终端 24,要留余量)')
    // 底部提示必须还在屏幕上 —— 它是被顶掉的第一个
    expect(t.lastFrame()).toContain('Esc/q 退出')
    app.unmount()
  })
})

/**
 * 树上要看得出「这个任务在返工,而且是因为什么」。
 *
 * 用户原话:「重拟和重做时,其原因没有列清楚,不知道啥原因导致的。」在这之前,一个被验收
 * 打回、正在跑第二轮的节点,在树上和一个第一次执行的节点**逐字相同** —— 唯一的线索要按
 * 回车进详情页、再从一段流水账里自己找最后一条未通过。
 */
describe('返工要在树上看得见(真渲染器)', () => {
  const failedRound = (round: number, why: string, step: string): any => ({
    round, verdicts: [], synthesized: { pass: false, blockingSummary: why }, step,
  })

  it('返工过的节点带 ↻N,没返工的不带', async () => {
    const nodes = [
      mk({ id: 'root', title: '返工过两轮的', status: 'EXECUTING',
        iteration: { planReview: 1, acceptance: 1, integration: 0, scoring: 0, mergeResolve: 0 } }),
      mk({ id: 'root2', title: '一次过的', status: 'EXECUTING' }),
    ]
    const { lastFrame, app } = await mount({ nodes })
    const rows = lastFrame().split('\n')
    app.unmount()
    expect(rows.find(r => r.includes('返工过两轮的'))).toContain('↻2')
    expect(rows.find(r => r.includes('一次过的'))).not.toContain('↻')
  })

  it('原因就挂在下一行 —— 第几轮、哪一关、说了什么', async () => {
    const nodes = [mk({
      id: 'root', title: '在返工的', status: 'EXECUTING',
      iteration: { planReview: 0, acceptance: 1, integration: 0, scoring: 0, mergeResolve: 0 },
      acceptLog: [failedRound(1, '退款回调的重试丢了', 'accept')],
    })]
    const { lastFrame, app } = await mount({ nodes })
    const frame = lastFrame()
    app.unmount()
    expect(frame).toContain('第 1 轮')
    expect(frame).toContain('验收未通过')
    expect(frame).toContain('退款回调的重试丢了')
  })

  it('测试修复和验收要分得开 —— 用户要照着修的东西不一样', async () => {
    const nodes = [mk({
      id: 'root', title: '在返工的', status: 'EXECUTING',
      acceptLog: [failedRound(1, '两个用例没跑', 'verify')],
    })]
    const { lastFrame, app } = await mount({ nodes })
    const frame = lastFrame()
    app.unmount()
    expect(frame).toContain('测试修复未通过')
  })
})

/**
 * 返工那一行**也要进行预算**。
 *
 * 「面板高度 = 边框 2 + 表头 1 + height + 提示」是 `budgetedViewport` 全部预算的前提,而
 * 它按 `cost` 知道哪些行会多占一个终端行。返工那一行是**第二个**会让一行变两行的东西
 * (第一个是「此刻在调什么工具」)—— 漏进预算的话,10 行的窗口会画出 20 个终端行,
 * 顶掉的正是底部的图例和按键提示。变异测试实测:去掉 cost 里的返工那一项,只有这条会挂。
 */
describe('返工那一行要算进行预算', () => {
  it('每行都带返工原因时,画出去的树行数减半', async () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      mk({
        id: `n${i}`, title: `任务${i}`, status: 'EXECUTING',
        acceptLog: [{ round: 1, verdicts: [], synthesized: { pass: false, blockingSummary: `第${i}条意见` }, step: 'accept' }],
      } as never))
    const { lastFrame, app } = await mount({ nodes, maxRows: 10 })
    const frame = lastFrame()
    app.unmount()
    const reworkRows = frame.split('\n').filter(l => l.includes('⎿ 第 1 轮')).length
    // 10 行预算 ÷ 每行 2 个终端行 = 5 个节点
    expect(reworkRows).toBe(5)
    // 而底部的提示必须还在屏幕上 —— 那正是预算算错时第一个消失的东西。
    expect(frame).toContain('Esc/q 退出')
  })
})
