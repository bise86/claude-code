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
import { TaskTreePanel, visibleRows, viewport } from './TaskTreePanel.js'
import { NodeDetail } from './NodeDetail.js'
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
      'ConfirmResume.tsx', 'ResumePicker.tsx', 'efftask.tsx',
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
        output: ['正在改 src/login.ts', '跑测试:12 通过'],
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
        elapsed: '1m', maxLines: 24,
        output: [...Array(60)].map((_, i) => `行 ${i}`),
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
        elapsed: '1m', output: ['最后一行'], outputDropped: 143,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('143')
    expect(t.lastFrame()).toContain('已滚出缓冲')
    app.unmount()
  })

  it('renders nothing at all when the node never produced output', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(NodeDetail as never, { node: mk({ id: 'n' }), elapsed: '1m', output: [] } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).not.toContain('子 agent 输出')
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
        chunks: { push: () => {}, nodes: () => [], dropped: () => 0, lines: (id: string) => ['输出属于 ' + id] },
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

  it('隐藏的行数把"滚出缓冲"和"没渲染"两部分都算进去', async () => {
    // Measured before: the buffer dropped 300 and the pane then rendered only its last 8, so a
    // user was told 300 were hidden while 492 were. Same "starts in the middle but looks
    // complete" lie block() had to fix in this very file.
    const f = await mountDetail({
      output: [...Array(200)].map((_, i) => `行${i}`), outputDropped: 300, maxLines: 24,
    })
    const m = f.match(/更早的 (\d+) 行未显示/)
    expect(m).not.toBeNull()
    const hidden = Number(m![1])
    expect(hidden).toBeGreaterThan(300)     // strictly more than the buffer alone dropped
    expect(f).toContain('其中 300 行已滚出缓冲')
    // …and the newest line is on screen.
    expect(f).toContain('行199')
  })

  it('缓冲没丢过东西时,不提"滚出缓冲"', async () => {
    const f = await mountDetail({ output: ['一', '二'], outputDropped: 0 })
    expect(f).not.toContain('滚出缓冲')
    expect(f).not.toContain('未显示')
  })

  it('输出区有自己的预算,不是各段落里最小的那一份', async () => {
    // At perSection*2 the pane rendered a fixed 8 lines, leaving 96% of a 200-line buffer
    // permanently unreachable — a long way from §10.2's "与单个子 agent 终端观感一致".
    // Zero-padded: 'L1' is a SUBSTRING of 'L10'..'L19', so an unpadded fixture counted lines
    // that were never rendered and the assertion held no matter what the budget was.
    const names = [...Array(60)].map((_, i) => `L${String(i).padStart(3, '0')}`)
    const f = await mountDetail({ output: names, maxLines: 24 })
    const shown = names.filter(l => f.includes(l))
    expect(shown.length).toBeGreaterThan(8)
  })
})
