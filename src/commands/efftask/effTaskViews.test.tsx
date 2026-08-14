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

  /**
   * 用户原话:「worktree 的代码合并到主干,才算任务完成吧。」
   *
   * 在这之前结论行只看 `outcome.status`,于是这一屏是自相矛盾的:第一行 ✓ 高效任务完成,
   * 第二行 ⚠ 没有把产出合回你的目录,第三行「还有 3 个提交没合进来」—— 而用户读的是第一行。
   */
  it('产出还没到你的分支时,结论行不许写「✓ 完成」', async () => {
    const f = await frameOf({ handoffResult: { ok: false, message: '你的工作区有未提交的改动' } })
    expect(f).not.toContain('✓ 高效任务完成')
    expect(f).toContain('跑完了,但产出还没到你的分支')
    // 数目要在结论行上 —— 「还差多少」是他决定下一步的依据。
    expect(f).toContain('3 个提交')
  })

  it('产出已经在你的分支上时,结论行照旧是「✓ 完成」', async () => {
    const f = await frameOf({ handoffState: 'merged', handoffResult: { ok: true, message: '已合并 3 个提交' } })
    expect(f).toContain('✓ 高效任务完成')
    expect(f).not.toContain('还没到你的分支')
  })

  /**
   * **「✓ 完成」是一句我们没有资格说的话 —— 除非有人真的查过。**
   *
   * `strandedCount` 只数 `HandoffSummary` 里的 `kept + salvage`,而 `orphanDir` /
   * `branchOnly` / `dangling` / `stashBackup` **根本不在里面**(那一段注释自己写着
   * 「它为假只等于我们没看见」)。而这一屏照样印绿色的「✓ 高效任务完成」。
   *
   * 这一句是整条捞回链的**入口**:`scanStranded` 全仓库只有一个消费者(`m` 键),
   * 而 `m` 只能从任务树进。用户在这一屏按 `q`,那之后再也没有任何一条路径提起它们 ——
   * 捞得再全,没人按也白搭。所以在他最可能按 q 的这一刻,把那个键说出来。
   */
  /** 宽一点的帧:这一行带 `truncate-end`,40 列下会被截掉一半,那测的就不是它说了什么。 */
  const wideFrame = async (extra: Record<string, unknown>): Promise<string> => {
    const t = fakeTty(120)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'completed' }, handoff: summary, onExit: () => {}, ...extra,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const fr = t.lastFrame()
    app.unmount()
    return fr
  }

  it('看起来什么都不缺时,也要说清「那几类没查过,按 m 扫一遍」', async () => {
    const f = await wideFrame({
      handoffState: 'merged', handoffResult: { ok: true, message: '已合并 3 个提交' },
      onMergeWorktrees: () => {},
    })
    expect(f).toContain('按 m 扫一遍')
    expect(f).toContain('孤儿目录')
  })

  /**
   * 反面:`m` 按不到的时候不许说 —— 一条按不了的指令比没有更糟。
   * (共享工作树没有 `onMergeWorktrees`;恢复路径上那一屏 `nodes` 是空的。)
   */
  it('m 按不到时不提这一句', async () => {
    const f = await wideFrame({
      handoffState: 'merged', handoffResult: { ok: true, message: '已合并 3 个提交' },
      // **不传** onMergeWorktrees —— 共享工作树运行时就是这个形状。
    })
    expect(f).not.toContain('按 m 扫一遍')
  })

  it('被阻断的 run 不叠第二句 —— 那一行本来就没在声称成功', async () => {
    const t = fakeTty(40)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'blocked', reason: '连续返工超限' },
        handoff: summary, onExit: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('✗ 高效任务被阻断')
    expect(f).not.toContain('跑完了,但产出还没到你的分支')
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

/**
 * **提交都送到了,不等于盘上没剩东西。**
 *
 * `undeliveredCommits` 在 `state === 'merged'` 时恒返回 0,而保留的工作区和抢救出来的
 * 提交与收口结局无关 —— 它们按定义就不在集成分支上。跑机形态(run 001):逐任务合并全部
 * 落地(commits 归零)而盘上仍有 7 条 salvage + 3 个保留工作区,这一屏印的却是绿色的
 * 「✓ 高效任务完成」,而用户读的就是第一行,读完直接按 q —— 之后再没人提起它们。
 */
describe('结束屏 · 盘上还剩没合入的东西', () => {
  const stranded = {
    branch: 'efftask/007/integration', commits: 0,
    kept: [{ path: '/wt/a', why: '未回收' }],
    salvage: ['efftask/007/salvage/a', 'efftask/007/salvage/b'],
  }
  const frame = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const t = fakeTty(40)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'completed' }, handoff: stranded,
        handoffState: 'merged', onExit: () => {}, ...extra,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    return f
  }

  it('结论行不许写「✓ 完成」,而且要写出还剩几处', async () => {
    const f = await frame()
    expect(f).not.toContain('✓ 高效任务完成')
    // 1 个保留工作区 + 2 条抢救分支。
    expect(f).toContain('还有 3 处产出没送到')
  })

  it('接了 m 的话,页脚要把它指出来', async () => {
    const f = await frame({ onMergeWorktrees: () => {} })
    expect(f).toContain('m 合并未合入的产出')
    // 排在「回车看节点详情」之前 —— 截断先吃掉的是末尾。
    expect(f.indexOf('m 合并未合入的产出')).toBeLessThan(f.indexOf('回车看节点详情'))
  })

  /** 没接 m(共享工作树:没有池子)就别指一条按不出来的路。 */
  /**
   * **这一行必须只占一行。** `doneSummaryRows` 把它按常数 1 行计,回流成两行会把树的
   * 最后一行静默挤掉 —— 上面那条结论行为同一件事写过同样的注释,而这一行此前没有 wrap。
   */
  it('窄终端上不换行(它被按常数 1 行计)', async () => {
    // **列数要真的窄**:`fakeTty(40)` 的 40 是**行数**,列默认 120 —— 那个宽度下这一行
    // 本来就放得下,拿它做判据等于什么都没测(实测:去掉 wrap 也不变红)。
    const t = fakeTty(40, 44)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'completed' }, handoff: stranded,
        handoffState: 'merged', onExit: () => {}, onMergeWorktrees: () => {},
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 只认这一行独有的片段 —— 树自己的页脚里也有「退出」。
    const lines = f.split('\n').filter(l => l.includes('回车看节点详情') || l.includes('m 合并未合入的产出'))
    expect(`页脚占了 ${lines.length} 行`).toBe('页脚占了 1 行')
  })

  it('没接 m 就不印那一句', async () => {
    expect(await frame()).not.toContain('m 合并未合入的产出')
  })

  it('盘上真的干净时照旧是「✓ 完成」', async () => {
    const f = await frame({ handoff: { ...stranded, kept: [], salvage: [] } })
    expect(f).toContain('✓ 高效任务完成')
    expect(f).not.toContain('处产出没送到')
  })
})

/**
 * **结论行的文字、颜色、和「按 m」这三件事必须同源。**
 *
 * 验收席真按键 + 原始 ANSI 实测:上一版颜色用 `hasUnmerged`(含 `trunkSkips`)、文字只看
 * `strandedCount` —— 于是有 `trunkSkips` 而没有 salvage 的那一屏印出一个**黄色的**
 * 「✓ 高效任务完成」,而下一行正说着东西没送到。另外树是空的时候(恢复路径上关口处置完
 * 落到的那一屏)`m` 是死键,而结论行和摘要页脚都还在喊它。
 */
describe('结束屏 · 结论行不许自相矛盾', () => {
  const frameWith = async (over: Record<string, unknown>): Promise<string> => {
    const t = fakeTty(40)
    const app = await render(
      React.createElement(DoneView as never, {
        nodes: [node({ id: 'root', title: '根任务' })] as never,
        runId: '007', outcome: { status: 'completed' }, handoffState: 'merged',
        onExit: () => {}, onMergeWorktrees: () => {}, ...over,
      } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    return f
  }

  it('只有 trunkSkips(没有 salvage)→ 不许写「✓ 完成」', async () => {
    const f = await frameWith({
      handoff: {
        branch: 'efftask/007/integration', commits: 0, kept: [], salvage: [],
        trunkSkips: ['你的工作区有未提交的改动,跳过了逐任务合并'],
      },
    })
    expect(f).not.toContain('✓ 高效任务完成')
    expect(f).toContain('有东西没送到你的分支')
  })

  /** 树是空的 → `m` 是死键,结论行和页脚都不许喊它。 */
  it('空树 → 不喊 m', async () => {
    const f = await frameWith({
      nodes: [],
      handoff: { branch: 'efftask/007/integration', commits: 0, kept: [], salvage: ['a', 'b'] },
    })
    expect(f).toContain('处产出没送到')
    expect(f).not.toContain('按 m 捞回')
    expect(f).not.toContain('m 合并未合入的产出')
  })

  /** 没接 `onMergeWorktrees`(共享工作树,没有池子)同理。 */
  it('没接 m → 不喊 m', async () => {
    const f = await frameWith({
      onMergeWorktrees: undefined,
      handoff: { branch: 'efftask/007/integration', commits: 0, kept: [], salvage: ['a'] },
    })
    expect(f).toContain('处产出没送到')
    expect(f).not.toContain('按 m 捞回')
  })

  it('树在、也接了 m → 照喊', async () => {
    const f = await frameWith({
      handoff: { branch: 'efftask/007/integration', commits: 0, kept: [], salvage: ['a'] },
    })
    expect(f).toContain('按 m 捞回')
  })
})
