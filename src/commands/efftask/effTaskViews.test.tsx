/**
 * The three §10.2 hops that live in `efftask.tsx`.
 *
 * That file has no tests — it renders Ink and touches the real store — and it is exactly
 * where this repo has cut a wire twice (onEscalate, and the roster). A reviewer proved all
 * three of these mutations stayed green:
 *
 *   - `openStream: meta => streams.current.open(meta)` → undefined
 *   - `streams={props.streams}` removed from RunningView
 *   - `streams={props.streams}` removed from DoneView
 *
 * The two views are exported for this reason. The store creation and the onChunk closure are
 * one line each and still uncovered; what is covered here is that a store handed to either
 * view actually reaches the detail pane a user opens.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { RunningView, DoneView } from './efftask.js'
import { createStreamStore } from '../../tools/efftask/agentStream.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'

const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 15))

function fakeTty(rows = 40, columns = 120) {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {}, setEncoding() {}, unref() {}, ref() {},
    read: () => { const v = pending; pending = null; return v },
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns, rows,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain }
}

const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  kind: 'executable',
  ...over,
})

/**
 * 打开光标那一行的详情页。`toLog` 再按一下 → 切到「子 agent 输出」页卡。
 *
 * 输出现在住在第二个页卡上,所以「详情里看得到输出」这件事要多走一跳 —— 而多走的
 * 这一跳恰好把整条线都串上了:树 → 回车 → 详情 → 切页卡 → 日志窗拿到的是**这个**节点的流。
 */
async function openDetail(View: unknown, props: Record<string, unknown>, toLog = false) {
  const t = fakeTty()
  const app = await render(
    React.createElement(View as never, props as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  t.stdin.press('\r') // Enter on the cursor row opens that node's detail
  await tick()
  if (toLog) {
    t.stdin.press('\u001b[C') // →
    await tick()
  }
  const f = t.lastFrame()
  app.unmount()
  return f
}

describe('运行中的面板把输出缓冲交到详情视图手里', () => {
  it('RunningView → 详情里看得到子 agent 的输出', async () => {
    const streams = createStreamStore()
    streams.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' }).push({ kind: 'text', text: '正在改 src/login.ts' })
    const f = await openDetail(RunningView, {
      nodes: [node({ status: 'EXECUTING' })], runId: '003', streams, onAbort: () => {},
    }, true)
    /**
     * 断言必须落在**日志窗独有**的形状上。
     *
     * 原来断的是 `子 agent 输出` 和那句正文 —— 两条都是恒真的:前者现在是页签标题、
     * 永远在;后者被**任务树上运行中节点的活动行**满足(树自己会画 `⎿ 执行·甲员工 …`),
     * 根本没经过详情页。验收实测:把日志窗的 slice 改成 [],这条照样绿。
     * 流表头(环节 · 署名 + 状态)只有日志窗画得出来。
     */
    expect(f).toContain('执行 · 甲员工')
    expect(f).toContain('正在改 src/login.ts')
  })

  it('DoneView → 跑完之后输出仍然留着(spec §10.2 "完成后保留最终输出")', async () => {
    const streams = createStreamStore()
    streams.open({ nodeId: 'root', phaseLabel: '执行', label: '甲员工' }).push({ kind: 'text', text: '最终产出:12 个测试通过' })
    const f = await openDetail(DoneView, {
      nodes: [node({ status: 'ACCEPTED' })], runId: '003', streams,
      outcome: { status: 'completed' }, handoff: null, onExit: () => {},
    }, true)
    expect(f).toContain('执行 · 甲员工')
    expect(f).toContain('最终产出:12 个测试通过')
  })

  it('没有缓冲时两个视图都照常渲染,不炸', async () => {
    // `streams` 在两个视图上都是可选的;一次什么都没流过的运行照样要能打开。
    const f = await openDetail(RunningView, {
      nodes: [node({ status: 'EXECUTING' })], runId: '003', onAbort: () => {},
    }, true)
    expect(f).toContain('根任务')
    // 页签在(版面不许随有没有输出而变形),但切过去说的是实话。
    expect(f).toContain('暂无输出')
    expect(f).not.toContain('输出(')
  })
})


describe('并行占用 (spec §10.1) 的最后一跳', () => {
  it('RunningView 把 pool reader 交给面板', async () => {
    // Four mutations on this wire were green: slotUsage() returning zeros, runOrchestrator not
    // calling onPool, efftask.tsx not storing the reader, and RunningView not passing it. Only
    // the panel's own formatting was covered, and it reads a test-injected fake. This is the
    // same shape this repo has cut five times (onEscalate, roster, onChunk x2, pool).
    const t = fakeTty()
    const app = await render(
      React.createElement(RunningView as never, {
        nodes: [node({ status: 'EXECUTING' })], runId: '003',
        pool: () => ({ inUse: 3, limit: 5 }),
        onAbort: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('并行 3/5')
    app.unmount()
  })

  it('没有 pool 时 RunningView 照常渲染', async () => {
    const t = fakeTty()
    const app = await render(
      React.createElement(RunningView as never, {
        nodes: [node({ status: 'EXECUTING' })], runId: '003', onAbort: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('根任务')
    expect(t.lastFrame()).not.toContain('并行 ')
    app.unmount()
  })
})

describe('先看树 (spec §17.3):没有只读模式,也不能报成"被阻断"', () => {
  it('说的是"没有继续执行",并给出继续的命令,而且不许自称一种模式', async () => {
    // 用户按 v 是自己选择不继续,run 原封不动留在盘上、完全可以续跑。把这说成
    // 「✗ 高效任务被阻断」,是把用户的一次按键报成一次失败 —— 而"被阻断"在这个产品里
    // 有确切含义(有节点触阀/失败),会把人送去查一个根本不存在的故障。
    //
    // 而「仅查看 / 只读」这类**模式**说辞同样不许有:那一屏上所有键照常可用,
    // 说它是一种受限模式就是屏幕在说假话(用户原话:「没有只读模式,所有功能都可以用」)。
    const t = fakeTty()
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ status: 'READY' })], runId: '003',
        outcome: null, handoff: null, viewOnly: true, onExit: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    expect(f).toContain('没有继续执行')
    expect(f).not.toContain('被阻断')
    expect(f).not.toContain('仅查看')
    expect(f).not.toContain('只读')
    expect(f).toContain('--resume 003')
    app.unmount()
  })

  it('真的被阻断时照旧说被阻断', async () => {
    // 反向守卫:上一条不能是靠"永远不说被阻断"过的。
    const t = fakeTty()
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ status: 'BLOCKED' })], runId: '003',
        outcome: { status: 'blocked', reason: '存在无法推进的阻断节点' }, handoff: null, onExit: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    expect(t.lastFrame()).toContain('被阻断')
    app.unmount()
  })
})

describe('完成视图必须把下面那个总结框的行数交给面板', () => {
  /**
   * 这条接线此前零覆盖:把 `reservedRows={summaryRows}` 换成 `{0}`,**整个特性关掉**,
   * 全套测试一条都不红(验收在干净副本上实测)。已有的测试量的都是消费者,
   * 喂的是写死的数字 —— 生产者到消费者这一跳没人走过。
   *
   * 判据:总结框变高几行,树上就要少画几行。不让位的话,那个框会把树(以及树里的
   * 详情页)最底下几行顶出屏幕 —— 而那里正是页签条和「怎么退出去」。
   */
  it('总结框多几行,树就少画几行', async () => {
    const nodes = [
      node({ id: 'root', title: '根任务', kind: 'decompose', childIds: Array.from({ length: 30 }, (_, i) => `root/${i}`) }),
      ...Array.from({ length: 30 }, (_, i) => ({ ...node({ id: `root/${i}`, title: `任务${i}` }), parentId: 'root' })),
    ] as never
    const visible = async (extra: Record<string, unknown>) => {
      // 28 行:40 行终端下树的 min(20, …) 上限会把差异整个吃掉,那样这条断言恒真。
      const t = fakeTty(28)
      const app = await render(
        React.createElement(DoneView as never, {
          nodes, runId: '003', outcome: { status: 'completed' }, handoff: null, onExit: () => {}, ...extra,
        } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      const f = t.lastFrame()
      app.unmount()
      return Array.from({ length: 30 }, (_, i) => `任务${i} `).filter(x => f.includes(x)).length
    }
    const bare = await visible({})
    // 收口结果 1 行 + 三条后续动作 3 行 = 总结框高 4 行。
    const fat = await visible({ handoffResult: { ok: true, message: '已合并', followUps: ['甲', '乙', '丙'] } })
    expect(`空框画 ${bare} 行,厚框画 ${fat} 行`).toBe(`空框画 ${bare} 行,厚框画 ${bare - 4} 行`)
  })
})

/**
 * 收口那几行**说的是不是真话** —— 三种结局三套文案。
 *
 * 验收实测过两条存活变异:把 `handoffLines(..., props.handoffState)` 的第三参写死成
 * 「没合」、以及不接 `setHandoffResult` —— 前者让自动合并成功之后屏幕上照旧写着
 * 「你的工作区未被改动」,后者让合并失败在屏幕上一个字都没有。两条全套测试都不红,
 * 因为**没有任何一条断言看过这一屏渲染出来的文字**。
 */
describe('done 视图上的收口文案', () => {
  const summary = { branch: 'efftask/007/integration', commits: 3, kept: [], salvage: [] }
  const frameOf = async (extra: Record<string, unknown>): Promise<string> => {
    const t = fakeTty(40)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'completed' }, handoff: summary, onExit: () => {}, ...extra,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    return f
  }

  it('合成功 → 说产出就在当前目录里,而且不再教用户去 --resume 收口', async () => {
    const f = await frameOf({ handoffState: 'merged', handoffResult: { ok: true, message: '已合并 3 个提交' } })
    expect(f).toContain('已合并回你当前的分支')
    expect(f).not.toContain('你的工作区未被改动')
    // pendingHandoff 已经被清掉了,那条命令进去什么都不会弹。
    expect(f).not.toContain('会重新弹出')
  })

  it('没合 → 照旧说工作区未被改动,并给出收口入口', async () => {
    const f = await frameOf({ handoffResult: { ok: false, message: '你的工作区有未提交的改动' } })
    expect(f).toContain('你的工作区未被改动')
    expect(f).toContain('/et --resume 007')
    // 失败原因必须显示出来 —— 安静地回到 done,用户会以为成功了。
    expect(f).toContain('未提交的改动')
  })

  it('撞冲突 → 说清工作区里留着一次未完成的合并', async () => {
    // 这一路是**自动**发生的:用户没按任何键就被丢进冲突态。屏幕上写「工作区未被改动」
    // 是这一屏最不能出的错。
    const f = await frameOf({
      handoffState: 'conflicted',
      handoffResult: { ok: false, message: '合并失败:CONFLICT (content)', followUps: ['git merge --abort 回到合并前'] },
    })
    expect(f).toContain('未完成的合并')
    expect(f).not.toContain('你的工作区未被改动')
    expect(f).toContain('--abort')
  })
})
