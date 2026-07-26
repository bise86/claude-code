/**
 * Mounts the resume views through the VENDORED renderer (src/ink.ts), not npm ink.
 *
 * Same reason as ConfirmStartup.test.tsx: both renderers emit identical frames, but
 * `useInput` only works against the app's own StdinContext. A gate that paints correctly and
 * ignores every key is indistinguishable from a working one on screen — and because
 * useCancelRequest disables Esc/Ctrl+C while a local-jsx dialog is mounted, an unanswerable
 * gate wedges the whole session.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ResumePicker } from './ResumePicker.js'
import { ConfirmResume } from './ConfirmResume.js'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import type { ResumeSummary } from '../../tools/efftask/startupConfirm.js'
import type { RunSummary } from '../../tools/efftask/runRegistry.js'

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
    isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  // Cursor-move sequences ARE the spacing, so they become a space; the bare ESC byte
  // that precedes them must then be removed or it lands between every pair of words.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

const mkNode = (o: { id: string; title: string }) =>
  createNode({ ...o, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-26T00:00:00Z' })

const ESC = String.fromCharCode(27)
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 10))
// A lone ESC is buffered by the tokenizer until it can rule out an escape sequence, so an
// Esc assertion has to outwait that window — this is the renderer behaving correctly.
const tickEsc = (): Promise<void> => new Promise(r => setTimeout(r, 250))

const runs: RunSummary[] = [
  { runId: '003', goalLine: '重构支付', updatedAt: 'b', counts: { accepted: 1, blocked: 0, pending: 2, total: 3 }, degraded: false },
  { runId: '001', goalLine: '打通登录', updatedAt: 'a', counts: { accepted: 4, blocked: 1, pending: 0, total: 5 }, degraded: true },
]

describe('ResumePicker (vendored renderer)', () => {
  it('lists the recoverable runs and answers real keypresses', async () => {
    const picked: string[] = []
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: id => picked.push(id), onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('003')
    expect(frame).toContain('重构支付')
    expect(frame).toContain('配置不完整') // the degraded run is flagged, not silently listed

    stdin.press('\r') // Enter picks the run under the cursor
    await tick()
    expect(picked).toEqual(['003'])
    app.unmount()
  })

  it('moves the cursor before picking', async () => {
    const picked: string[] = []
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: id => picked.push(id), onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press('j') // down
    await tick()
    stdin.press('\r')
    await tick()
    expect(picked).toEqual(['001'])
    app.unmount()
  })

  it('cancels on Esc rather than trapping the session', async () => {
    let cancelled = false
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs, onPick: () => {}, onCancel: () => { cancelled = true } }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press(ESC)
    await tickEsc()
    expect(cancelled).toBe(true)
    app.unmount()
  })

  it('an empty list says so and is still dismissible', async () => {
    let cancelled = false
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: [], onPick: () => {}, onCancel: () => { cancelled = true } }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(lastFrame()).toContain('没有可恢复的 run')
    stdin.press('q')
    await tick()
    expect(cancelled).toBe(true)
    app.unmount()
  })
})

const config: EffTaskConfig = {
  goalPrompt: '打通登录接口',
  parallelism: 3,
  phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS },
  notices: [],
  mainModel: 'claude-opus-4-8',
}

const summary: ResumeSummary = {
  runId: '003',
  counts: { accepted: 2, blocked: 1, pending: 3, total: 6 },
  repairs: ['节点 root/02-b:依赖节点缺失(root/01-a)'],
  reseated: ['root/03-c'],
  exhausted: ['root/04-d'],
  degraded: [],
  loadErrors: [],
  inheritedGuidance: '先从简',
}

describe('ConfirmResume (vendored renderer)', () => {
  it('shows what recovery actually did before asking for approval', async () => {
    // §17.2 requires the validation summary reach the user. Approving a resume without
    // seeing what was repaired or re-queued is approving something you were not shown.
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, onDecision: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('恢复确认')
    expect(frame).toContain('已验收 2')
    expect(frame).toContain('依赖节点缺失')
    expect(frame).toContain('预算已耗尽')
    expect(frame).toContain('沿用') // inherited guidance is disclosed, not applied silently
    expect(frame).toContain('主模型(claude-opus-4-8)') // the roster still names its models
    app.unmount()
  })

  it('approves on Enter and refuses on Esc', async () => {
    const decisions: { approved: boolean }[] = []
    for (const [key, approved] of [['\r', true], [ESC, false]] as const) {
      const { stdin, stdout } = fakeTty()
      const app = await render(
        React.createElement(ConfirmResume, { config, summary, onDecision: d => decisions.push(d) }),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      stdin.press(key)
      await (key === ESC ? tickEsc() : tick())
      expect(decisions[decisions.length - 1]?.approved).toBe(approved)
      app.unmount()
    }
  })

  it('spec §17.3:恢复关口要显示恢复出来的任务树', async () => {
    // 关口原本只有计数和修复摘要,树本身一眼都看不到 —— 用户被要求批准"花真金白银继续跑"
    // 一个自己看不见形状的 run:哪些分支活下来了、哪些是阻断的、还剩多少。
    const nodes = [
      { ...mkNode({ id: 'root', title: '根任务' }), status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] },
      // 标题刻意和 config.goalPrompt('打通登录接口')不同 —— 否则断言会被顶部的目标行满足。
      { ...mkNode({ id: 'root/01-a', title: '登录子任务' }), parentId: 'root', depth: 1, status: 'BLOCKED' },
    ] as never
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, nodes, onDecision: () => {} } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = lastFrame()
    // 三条断言,每一条都必须只能由**树里那一行**满足。第一版三条里有两条是空的:
    //   · toContain('打通登录') 由顶部的「目标: 打通登录接口」满足,和树无关 —— 实测把
    //     阻断分支整个过滤掉,用例照样绿,而"哪些是阻断的"正是它自称要保护的东西;
    //   · toContain('✗') 由表头那个静态的 `✗{counts.failed}` 满足,不是行内状态字形 ——
    //     实测把 GLYPH[ui] 换成 '@',用例照样绿。
    // 所以改成用树里独有的标题、以及"字形 + 标题同处一行"来钉。
    expect(f).toContain('登录子任务')                 // 只出现在树里,不在目标行里
    expect(f).toMatch(/✗\s*登录子任务/)              // 状态字形必须贴在那一行上
    expect(f).toMatch(/▾\s*○\s*根任务/)              // 折叠标记 + 排队字形 + 根标题
    app.unmount()
  })

  it('树放不下时要说出来 —— 关口上没有任何键能滚动它', async () => {
    // 非交互渲染意味着**没有任何键能滚**。21 个节点时画面只显示前 10 行,边框直接闭合,
    // 看起来像一整棵完整的树,而表头还数着一个用户根本看不到的 ✗。唯一的线索是面板那个
    // `1/21` —— 那是交互模式下的光标位置,而这里没有光标。同一个仓库里 block() 和实时
    // 输出面板都为这类情况写了"省略了 N 行"。
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...mkNode({ id: `root/${i}`, title: `子任务${i}` }),
      status: i === 20 ? 'BLOCKED' : 'READY',
    })) as never
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, nodes: many, onDecision: () => {} } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = lastFrame()
    expect(f).toContain('共 21 个节点')
    expect(f).toContain('按 v 查看完整任务树')
    app.unmount()
  })

  it('放得下时不显示那句提示', async () => {
    const few = [{ ...mkNode({ id: 'root', title: '根任务' }), status: 'WAITING_CHILDREN' }] as never
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, nodes: few, onDecision: () => {} } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(lastFrame()).not.toContain('按 v 查看完整任务树')
    expect(lastFrame()).toContain('根任务') // 正向锚点:树确实渲染了
    app.unmount()
  })

  it('嵌进来的树不能把关口的键盘抢走', async () => {
    // TaskTreePanel 的 useInput 是按 `interactive` 门控的。忘了这一点的话,↑↓ 会同时滚树
    // 和调并行数,回车的含义也会有两个 —— 这个仓库为"两个 handler 抢同一个键"付过账。
    const nodes = [{ ...mkNode({ id: 'root', title: '根任务' }), status: 'WAITING_CHILDREN' }] as never
    const decisions: { approved: boolean }[] = []
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, nodes, onDecision: (d: never) => decisions.push(d) } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    // 断言树是**非交互**渲染的。只按一次回车再看 decisions 抓不到这个问题 —— 两个 handler
    // 都会收到同一个键,关口照样会收到"继续执行",而树同时把节点详情打开了。所以直接查
    // 交互模式独有的两样东西:面板自己的按键提示行,和选中行的 ❯ 标记。
    const f = lastFrame()
    expect(f).not.toContain('↑↓/jk 移动')
    expect(f).not.toContain('❯')
    // 关口自己的提示行仍在,说明少掉的确实是树那一份而不是整块没渲染。
    expect(f).toContain('回车/y 继续执行')
    stdin.press('\r')
    await tick()
    expect(decisions).toEqual([{ parallelism: 3, approved: true }])
    app.unmount()
  })

  it('"v" is view-only: it declines, and says so DISTINCTLY from a cancellation', async () => {
    // This used to assert the byte-identical payload Esc sends — which is precisely what made
    // the key a lie: it is labelled 仅查看后退出 and nothing was ever viewed. The distinction
    // has to reach the caller, or the command cannot tell "show me the tree" from "forget it".
    const decisions: { approved: boolean; viewOnly?: boolean }[] = []
    const { stdin, stdout } = fakeTty()
    const app = await render(
      React.createElement(ConfirmResume, { config, summary, onDecision: d => decisions.push(d) }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    stdin.press('v')
    await tick()
    expect(decisions).toEqual([{ parallelism: 3, approved: false, viewOnly: true }])
    app.unmount()
  })

  it('Esc / n 仍然是纯取消 —— 不能带 viewOnly', async () => {
    // 否则每一次取消都会打开一个用户没要的树浏览器,上一条的区分也就成了摆设。
    for (const key of [ESC, 'n']) {
      const decisions: { approved: boolean; viewOnly?: boolean }[] = []
      const { stdin, stdout } = fakeTty()
      const app = await render(
        React.createElement(ConfirmResume, { config, summary, onDecision: d => decisions.push(d) }),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      stdin.press(key)
      await (key === ESC ? tickEsc() : tick())
      expect(decisions[decisions.length - 1]?.approved).toBe(false)
      expect(decisions[decisions.length - 1]?.viewOnly).toBeUndefined()
      app.unmount()
    }
  })
})


import { ConfirmStartup } from './ConfirmStartup.js'

const RIGHT = ESC + '[C'
const LEFT = ESC + '[D'

describe('the gate lets the user CHANGE the parallelism (用户第四句)', () => {
  // "各任务执行可以并行,默认5个,需求提示词可指定,可跟用户确认修改" — the fourth clause.
  // Both branches used to echo props.config.parallelism, so the number was display-only, and
  // the Feishu card's own comment said "the card has no inline editor in P1".
  const propsFor = (name: string, onDecision: (d: { parallelism: number; approved: boolean }) => void) =>
    (name === 'ConfirmResume' ? { config, summary, onDecision } : { config, onDecision }) as never

  for (const [name, Comp] of [
    ['ConfirmStartup', ConfirmStartup],
    ['ConfirmResume', ConfirmResume],
  ] as [string, (p: never) => React.ReactElement][]) {
    it(name + ': arrows change it and the decision carries the NEW value', async () => {
      const decisions: { parallelism: number; approved: boolean }[] = []
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, d => decisions.push(d))),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      expect(lastFrame()).toContain('并行数: 3')
      stdin.press(RIGHT)
      await tick()
      stdin.press('+')
      await tick()
      // The renderer repaints only the CHANGED line, so the accumulated buffer holds a bare
      // "5" rather than the whole label — assert the contract (what onDecision carries),
      // not the intermediate frame.
      expect(lastFrame()).toMatch(/\n\s*5\r?\n/)
      stdin.press('\r')
      await tick()
      expect(decisions[0]).toMatchObject({ parallelism: 5, approved: true })
      app.unmount()
    })

    it(name + ': cannot be pushed below 1', async () => {
      const decisions: { parallelism: number; approved: boolean }[] = []
      const { stdin, stdout } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, d => decisions.push(d))),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      for (let i = 0; i < 6; i++) { stdin.press(LEFT); await tick() }
      stdin.press('\r')
      await tick()
      expect(decisions[0].parallelism).toBe(1)
      app.unmount()
    })

    it(name + ': describes what parallelism actually buys today', async () => {
      // Three surfaces once carried three separately-worded hardcoded strings, two of which
      // still claimed "P1 串行执行" after the concurrent pool shipped.
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, () => {})),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const frame = lastFrame()
      expect(frame).toContain('方案/评审阶段并行')
      expect(frame).toContain('执行与叶子验收串行')
      expect(frame).not.toContain('P1 串行执行')
      // 读取 is not one of this product's phases; naming it here once put a row on the gate
      // that has no counterpart in the roster three lines below.
      expect(frame).not.toContain('读取')
      app.unmount()
    })
  }
})

describe('关口渲染出来的那句话必须随隔离状态变化', () => {
  // A review found parallelismLine could say two things while NO call site ever passed
  // `isolation` — every gate rendered "未启用隔离" including runs whose measured execute
  // concurrency was 4. Testing the function alone could not see that: the gap was the wiring.
  const propsFor = (name: string, isolation?: 'worktree' | 'none') =>
    (name === 'ConfirmResume'
      ? { config, summary, isolation, onDecision: () => {} }
      : { config, isolation, onDecision: () => {} }) as never

  for (const [name, Comp] of [
    ['ConfirmStartup', ConfirmStartup],
    ['ConfirmResume', ConfirmResume],
  ] as [string, (p: never) => React.ReactElement][]) {
    it(name + ': says isolated when the run IS isolated', async () => {
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, 'worktree')),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = lastFrame()
      expect(f).toContain('各阶段并行')
      expect(f).toContain('worktree')
      expect(f).not.toContain('未启用隔离')
      app.unmount()
    })

    it(name + ': says serial when it is NOT isolated', async () => {
      const { stdin, stdout, lastFrame } = fakeTty()
      const app = await render(
        React.createElement(Comp as never, propsFor(name, 'none')),
        { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      expect(lastFrame()).toContain('未启用隔离')
      app.unmount()
    })
  }
})

describe('spec §17.1:选择器上要看得见最后更新时间', () => {
  it('渲染相对时间 —— listRuns 一直算着它,却只用来排序', async () => {
    // The pure formatter having tests does not prove the picker calls it: this repo has cut
    // exactly this wire before (a chunk store passed to a view that never forwarded it).
    // §17.1 lists 最后更新时间 as one of four required columns; with several runs the user
    // was choosing between 003 and 007 on goal text alone.
    const now = Date.now()
    const withTimes: RunSummary[] = [
      { runId: '003', goalLine: '重构支付', updatedAt: new Date(now - 20 * 60_000).toISOString(),
        counts: { accepted: 1, blocked: 0, pending: 2, total: 3 }, degraded: false },
      { runId: '001', goalLine: '打通登录', updatedAt: new Date(now - 3 * 3600_000).toISOString(),
        counts: { accepted: 4, blocked: 1, pending: 0, total: 5 }, degraded: false },
    ]
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: withTimes, onPick: () => {}, onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = lastFrame()
    expect(frame).toContain('20 分钟前')
    expect(frame).toContain('3 小时前')
    app.unmount()
  })

  it('时间戳坏掉的 run 不渲染占位符,也不炸', async () => {
    // listRuns 的累加器从 '' 起步,所以 node.md 全被写坏的 run 到这里就是空串。
    const broken: RunSummary[] = [
      { runId: '004', goalLine: '坏掉的', updatedAt: '',
        counts: { accepted: 0, blocked: 0, pending: 1, total: 1 }, degraded: false },
    ]
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ResumePicker, { runs: broken, onPick: () => {}, onCancel: () => {} }),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(lastFrame()).toContain('坏掉的')
    expect(lastFrame()).not.toContain('前')
    app.unmount()
  })
})
