/**
 * 权限确认弹出时,任务树面板必须**交出键盘**。
 *
 * 用户报的:「需要用户确认接受时,光标选中的任务回车同时会进入任务详情」。
 *
 * 根因是架构性的、而且是有意为之的一半:`/et` 声明了 `spawnsSubagents`,于是
 * `allowsPermissionDialogs` 让 REPL 把权限对话框画在面板**之上**(否则子 agent 要的
 * 批准根本没地方画,运行会永远等下去 —— 那是更早修过的另一个 bug)。两个组件因此同时
 * 挂着,而 ink 的 useInput 是**广播**的:一下回车,对话框收到,面板也收到。
 *
 * 所以这一档从两侧都测:面板在 suspended 时对每个键都不响应;计数器在并发下的行为。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'

/**
 * 方向键和 Esc 必须写成**显式转义**。
 *
 * 这个文件原来一个 ESC 字节都没有 —— 字面量被写文件的那一步吞掉了,剩下 '[B' 两个普通
 * 字符。于是「方向键也不动」「Esc 不能中断整个 run」这两条断言是**空的**:键根本没送到,
 * 什么都没发生自然成立。改成显式转义之后它们才真的在测被测行为。
 */
const DOWN = '\u001b[B'
const ESC = '\u001b'
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
  // 用 \u001b 转义写:字面量 ESC 会被编辑器吞掉,`//` 就成了行注释,函数体整个坏掉。
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
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

/**
 * 详情视图独有的一行。
 *
 * **不能**用「子 agent 输出」当标志:那一段只在传了 streams 时才渲染,而这一档没传 ——
 * 于是 not.toContain('子 agent 输出') 是恒真的,那几条断言全是空的。这一点是被下面
 * 那条正向用例(「键盘要拿回来」)顺带暴露出来的:它按了回车、详情**真的**打开了,
 * 却因为找不到那个字符串而报红。
 */
const DETAIL_MARK = '返回任务树'
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'EXECUTING' }),
]

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('执行串行时顶上要说实话', () => {
  it('没有隔离工作区时,明说执行是串行的', async () => {
    // 不说的话顶上那个「并行 1/5」是在误导:用户看着 5 的上限却发现子任务一个一个来,
    // 只能怀疑是不是自己配错了 —— 而真实原因是 orchestrator 的 serialiseExecute。
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive serialExecute
        pool={() => ({ inUse: 1, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并行 1/5')
    expect(f).toContain('执行串行(无隔离工作区)')
  })

  /**
   * **第三档整趟跑下来必须有一个标记 —— 它是最危险的那一档。**
   *
   * 实测过它此前和「worktree 隔离并发」在表头上逐字相同(两者 `serialExecute` 都是
   * false、`pool` 都不画):唯一的标记给了最安全那一档,而多个执行者正在同时裸写用户
   * 当前目录的那一趟,屏幕上一个字都没有。
   */
  it('共享目录 + 并发:说的是「没有安全网」,不是「慢」', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive sharedParallel
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并发直写当前目录(无隔离)')
    // 两个标记是两件事,不能互相顶替。
    expect(f).not.toContain('执行串行')
  })

  it('隔离并行那一趟两个标记都不画', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('并发直写当前目录')
    expect(f).not.toContain('执行串行')
  })

  it('有隔离时不提 —— 那句话此时是假的', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        pool={() => ({ inUse: 3, limit: 5 })} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('并行 3/5')
    expect(f).not.toContain('执行串行')
  })
})
describe('suspended 时面板不吃任何键', () => {
  it('回车不再打开详情 —— 这就是用户报的那一下', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 详情视图的标志性内容不能出现。用户按的那一下回车是给上面那个权限对话框的。
    expect(f).not.toContain(DETAIL_MARK)
    expect(f).toContain('等你回答上面那个权限确认')
  })

  it('Esc / q 也不能顺手把整个 run 中断掉', async () => {
    // 这条比回车更凶:权限对话框上按 Esc 是「拒绝这次工具调用」,如果面板也收到,
    // 用户拒绝一次工具就把整个运行中断了。
    let exits = 0
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => { exits++ }} />,
    )
    t.stdin.press(ESC)
    await tick()
    t.stdin.press('q')
    await tick()
    app.unmount()
    expect(exits).toBe(0)
  })

  it('方向键也不动 —— 键归对话框', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN)
    await tick()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain(DETAIL_MARK)
  })

  it('r 重做也不响应', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onRedo={n => seen.push(n)} onExitKey={() => {}} />,
    )
    t.stdin.press('r')
    await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  it('对话框收走之后键盘要**拿回来** —— 只挂起不恢复比原来的 bug 更糟', async () => {
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended={false} onExitKey={() => {}} />,
    )
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain(DETAIL_MARK)
  })

  it('挂起时提示行说清为什么按键没反应', async () => {
    // 不说的话,用户会按着方向键发现树不动,以为界面卡死了。
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive suspended onExitKey={() => {}} />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('这期间按键归它')
    // 挂起时不该再列一堆用不了的键。
    expect(f).not.toContain('↑↓/jk 移动')
  })
})

/**
 * **`m` / `c` / `b` 在树这一层也要能按,而带 Ctrl 的绝对不能。**
 *
 * 跑机实测(qianbase-xtp run 001):结束屏写着「607 个提交没合进来 / 7 条抢救分支 /
 * 3 个保留工作区」,而 `m` 只在详情页那一支里,页脚也从没宣告过它。用户原话:
 * 「这些老是提示这些进不去执行 m 键」。
 *
 * 反面同样要钉死:本 fork 的 `internal_exitOnCtrlC` 是 false,Ctrl+C 被原样派发;
 * kitty 键盘协议无条件开启,Ctrl+M 会给出 `{name:'m', ctrl:true}`。不挡的话 Ctrl+C 就是
 * 这一屏唯一删目录的键。
 */
describe('树这一层的 m / c / b', () => {
  const spy = () => {
    const hits: string[] = []
    return { hits, on: (n: string) => (() => { hits.push(n) }) }
  }

  const mountTree = async (s: ReturnType<typeof spy>) => mount(
    <TaskTreePanel
      nodes={TREE()} runId="003" interactive
      onMergeWorktrees={s.on('m')} onCleanupWorktrees={s.on('c')} onBacktrack={s.on('b')}
      onExitKey={() => {}}
    />,
  )

  it('裸按 m / c / b 都触发,不用先进详情页', async () => {
    for (const key of ['m', 'c', 'b']) {
      const s = spy()
      const { t, app } = await mountTree(s)
      t.stdin.press(key)
      await new Promise(r => setTimeout(r, 20))
      app.unmount()
      expect(`${key}: ${s.hits.join(',')}`).toBe(`${key}: ${key}`)
    }
  })

  /** Ctrl+C 打开删目录的关口是这一改动最贵的失手方式。 */
  it('带 Ctrl 的一个都不许触发', async () => {
    const s = spy()
    const { t, app } = await mountTree(s)
    // 传统终端的 Ctrl+C / Ctrl+B,以及 kitty 协议下的 Ctrl+M。
    for (const seq of ['\x03', '\x02', '\x1b[109;5u']) {
      t.stdin.press(seq)
      await new Promise(r => setTimeout(r, 20))
    }
    app.unmount()
    expect(s.hits).toEqual([])
  })

  it('页脚把这三个键写出来,而且 m 排在出口紧后面', async () => {
    const s = spy()
    const { t, app } = await mountTree(s)
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('m 合并/捞回未合入的产出')
    // 「工作区」三个字不许出现在树层这句里 —— 它只覆盖三桶里的一桶。
    expect(f).not.toContain('m 合并工作区到主干')
    expect(f.indexOf('Esc/q 退出')).toBeLessThan(f.indexOf('m 合并'))
  })

  /** 没接 handler 的那一趟(共享工作树:没有池子)不许印这几个键。 */
  it('没有 handler 就不印,也按不出来', async () => {
    const s = spy()
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive onExitKey={() => {}} />,
    )
    t.stdin.press('m')
    await new Promise(r => setTimeout(r, 20))
    const f = t.lastFrame()
    app.unmount()
    expect(s.hits).toEqual([])
    expect(f).not.toContain('m 合并')
  })
})

/**
 * **树是空的时候不许宣告 `m`/`c`/`b` —— 那时它们是死键。**
 *
 * 树层的按键分支在 `rows.length === 0` 时整个早退。而恢复路径上真有这么一屏:关口处置完
 * 之后落到结束屏,那时 `nodes` 还是空的(树是 `loadRun` 之后才有的)—— 验收实测那一屏
 * 是绿色的「✓ 高效任务完成」+ 空树 + 页脚宣告着 `m`。宣告一个按下去什么都不发生的键,
 * 比没有这个键更糟。
 */
describe('空树上的键位提示', () => {
  it('没有任何行时,m / c / b 一个都不印', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={[]} runId="003" interactive
        onMergeWorktrees={() => {}} onCleanupWorktrees={() => {}} onBacktrack={() => {}}
        onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('m 合并/捞回未合入的产出')
    expect(f).not.toContain('c 清理工作区')
    expect(f).not.toContain('b 回溯未通过的子任务')
  })

  it('有行时照常印', async () => {
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onMergeWorktrees={() => {}} onExitKey={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('m 合并/捞回未合入的产出')
  })
})

/**
 * **大写不算。** `k = input.toLowerCase()` 会让 `M`/`C`/`B` 和 kitty 的 Shift 序列一起触发,
 * 而这一屏本来就在教用户按 Shift(`R 重做失败环节`)—— Shift+ 相邻键误触的概率不是零,
 * 而 `C` 那一下打开的是删目录的关口。这三个键从来没被宣告成大写形式。
 */
describe('树层的 m / c / b 只认小写', () => {
  it('大写 M / C / B 一个都不触发', async () => {
    const hits: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onMergeWorktrees={() => hits.push('m')} onCleanupWorktrees={() => hits.push('c')}
        onBacktrack={() => hits.push('b')} onExitKey={() => {}}
      />,
    )
    for (const key of ['M', 'C', 'B']) {
      t.stdin.press(key)
      await new Promise(r => setTimeout(r, 20))
    }
    app.unmount()
    expect(hits).toEqual([])
  })

  it('小写照旧能按', async () => {
    const hits: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onCleanupWorktrees={() => hits.push('c')} onExitKey={() => {}}
      />,
    )
    t.stdin.press('c')
    await new Promise(r => setTimeout(r, 20))
    app.unmount()
    expect(hits).toEqual(['c'])
  })
})
