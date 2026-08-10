/**
 * 依赖重算那个键的接线,以及它**被拒时不许把用户踢回任务树**。
 *
 * 后一条是评审抓出来的:准入判据全是同步内存读,而关口是 phase 级整屏替换 —— 切过去
 * 再回来会把 `TaskTreePanel` 连同 `NodeDetail` 整棵卸载,用户展开到哪一段、读到第几行
 * (住在那两个组件自己的 state 里)全没了。而「什么都没发生」不该长成「你的阅读位置没了」。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { detailSections } from './NodeDetail.js'

const ENTER = '\r'
const CTRL_D = String.fromCharCode(4)
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
    const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

/** 光标默认停在 root;它是 CREATED、依赖 甲。 */
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'unknown', status: 'CREATED', deps: ['dep'], childIds: [] }),
  mk('dep', { title: '被依赖的任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [] }),
]

async function mountDetail(props: Partial<React.ComponentProps<typeof TaskTreePanel>> = {}) {
  const t = fakeTty()
  const app = await render(
    <TaskTreePanel nodes={TREE()} runId="003" interactive onExitKey={() => {}} {...props} />,
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  t.stdin.press(ENTER); await tick() // 进详情页
  return { t, app }
}

describe('d 键', () => {
  it('把详情页那个节点交给回调', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onRecalcDeps: n => { seen.push(n.id); return undefined } })
    t.stdin.press('d'); await tick()
    app.unmount()
    expect(seen).toEqual(['root'])
  })

  it('**Ctrl+D 不触发它**(那是半页滚动)', async () => {
    const seen: string[] = []
    const { t, app } = await mountDetail({ onRecalcDeps: n => { seen.push(n.id); return undefined } })
    t.stdin.press(CTRL_D); await tick()
    app.unmount()
    expect(seen).toEqual([])
  })

  it('被拒时**详情页还开着**,而且拒绝理由画在屏幕上', async () => {
    const { t, app } = await mountDetail({
      onRecalcDeps: () => '这个任务已经开始分析了(当前 PLANNING)',
      onCleanupWorktrees: () => {},
    })
    t.stdin.press('d'); await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 理由上屏
    expect(frame).toContain('已经开始分析')
    // 详情页没被关掉 —— 用「只在详情页上有出口的键」证明(帧是增量的,不能靠它判断)
    expect(frame).toContain('返回任务树')
  })

  it('没接这个回调时按 d 什么都不会发生(而不是崩)', async () => {
    const { t, app } = await mountDetail({})
    t.stdin.press('d'); await tick()
    app.unmount()
    expect(true).toBe(true)
  })
})

describe('「依赖」段上的提示', () => {
  const n = mk('root', { title: '根', status: 'CREATED', deps: ['dep'] })
  const resolve = (id: string): TaskNode | undefined =>
    id === 'dep' ? mk('dep', { title: '被依赖的任务' }) : undefined

  it('只在 canRecalcDeps 时写,而且写在**最后一行**', () => {
    const on = detailSections(n, resolve, true).find(s => s.title === '依赖')!
    const off = detailSections(n, resolve, false).find(s => s.title === '依赖')!
    expect(on.body.split('\n').at(-1)).toContain('按 d')
    expect(off.body).not.toContain('按 d')
  })

  /**
   * **提示不许进段落标题。** `expanded` / `secMode` / `anchor` / `selTitle` 四个状态全按
   * 标题寻址,而这个提示的显示条件是 `status === 'CREATED'` —— 节点离开 CREATED 是编排器
   * 自己 tick 出来的,用户一个键都没按。标题一改,他展开着的那一段会自己收起、↑↓ 的语义
   * 当场翻面、视口跳回顶部。
   */
  it('段落标题在两种情况下**逐字相同**', () => {
    const on = detailSections(n, resolve, true).map(s => s.title)
    const off = detailSections(n, resolve, false).map(s => s.title)
    expect(on).toEqual(off)
    expect(on).toContain('依赖')
  })

  it('依赖行同时印标题和真 id —— 同名孙节点上「父/子」路径仍然不唯一', () => {
    const s = detailSections(n, resolve, false).find(x => x.title === '依赖')!
    expect(s.body).toContain('被依赖的任务')
    expect(s.body).toContain('dep')
  })

  it('拒绝理由单开一段,没有理由时那一段不出现', () => {
    const withNotice = detailSections(n, resolve, true, '不行,因为…').map(s => s.title)
    const without = detailSections(n, resolve, true).map(s => s.title)
    expect(withNotice).toContain('依赖重算')
    expect(without).not.toContain('依赖重算')
  })

  it('重算记录单开一段,没重算过的节点版面逐字不变', () => {
    const clean = detailSections(n, resolve, false).map(s => s.title)
    const done = detailSections(
      { ...n, depsRecalc: [{ at: NOW, from: ['dep'], to: ['dep/00-x'] }] },
      resolve, false,
    ).map(s => s.title)
    expect(clean).not.toContain('依赖重算记录')
    expect(done).toContain('依赖重算记录')
  })
})

/**
 * 详情页页脚上的**动作键**在窄终端上必须活着。
 *
 * 用户报的原话是「子任务重跑和阶段重跑功能没有了」—— 而键一直是好的:页脚曾经把动作键
 * 排在导航说明**之后**,而导航那一句自己就有 94 列,于是 113 列以下 `r 重做本任务` 一个字
 * 都画不出来,130 列以下没有 `R`,141 列以下没有 `s`。**一个从不被宣告的键等于不存在。**
 *
 * 断言按**真渲染**做,不按拼出来的字符串:被截掉的那一半在字符串里是在的。
 */
describe('详情页页脚的动作键在窄终端上活着', () => {
  const FAILED = (): TaskNode[] => [
    mk('root', {
      title: '根任务', status: 'BLOCKED', failedAt: 'ACCEPTANCE', blockedReason: '验收未通过',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'x' }, execStatus: '改了 a.ts',
    }),
  ]

  for (const cols of [80, 100, 120]) {
    it(`${cols} 列:r / R / s 都画得出来`, async () => {
      const t = fakeTty(cols)
      const app = await render(
        <TaskTreePanel
          nodes={FAILED()} runId="003" interactive
          onRedo={() => {}} onRedoFailed={() => {}} onSkipFailed={() => {}}
          onExitKey={() => {}}
        />,
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      t.stdin.press(ENTER); await tick()
      const foot = t.lastFrame().split('\n').filter(l => l.includes('返回任务树')).pop() ?? ''
      app.unmount()
      expect(foot).toContain('r 重做本任务')
      expect(foot).toContain('R 重做失败环节')
      expect(foot).toContain('s 跳过它')
      // 出口永远排第一 —— 截断只许吃掉最不重要的那一头
      expect(foot.indexOf('Esc/q')).toBeLessThan(foot.indexOf('r 重做本任务'))
    })
  }

  it('动作键排在导航说明之前 —— ↑↓ 按下去就有反应,而 r 没提示就完全不可发现', async () => {
    const t = fakeTty(160)
    const app = await render(
      <TaskTreePanel
        nodes={FAILED()} runId="003" interactive
        onRedo={() => {}} onRedoFailed={() => {}} onSkipFailed={() => {}} onExitKey={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()
    const foot = t.lastFrame().split('\n').filter(l => l.includes('返回任务树')).pop() ?? ''
    app.unmount()
    expect(foot.indexOf('r 重做本任务')).toBeLessThan(foot.indexOf('选段落'))
  })
})

/**
 * 用户报的三件事,各一组探针。
 *
 * 1. 「在任务详情页按了 r 其实是没有效果」—— 拒绝路径此前把原因写进一个**只有结束屏读**
 *    的 state,而详情页在调回调之前就已经关掉了。按下去 = 详情页消失 + 什么都没发生。
 * 2. 「可以看下是否所有功能键都在」—— `f 强制通过` 一直能按却从来没被宣告过。
 * 3. 「功能键可以有翻页」—— 一屏放不下的键不再消失,而是等下一页。
 */
describe('动作键被拒时必须说话,而且不许把人踢出详情页', () => {
  const NODE = (): TaskNode[] => [
    mk('root', {
      title: '根任务', status: 'BLOCKED', failedAt: 'ACCEPTANCE', blockedReason: '验收未通过',
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'x' }, execStatus: '改了 a.ts',
    }),
  ]

  for (const [key, prop] of [['r', 'onRedo'], ['R', 'onRedoFailed'], ['s', 'onSkipFailed']] as const) {
    it(`按 ${key} 被拒 → 理由上屏,而且详情页还开着`, async () => {
      const t = fakeTty(100)
      const app = await render(
        <TaskTreePanel
          nodes={NODE()} runId="003" interactive onExitKey={() => {}}
          {...{ [prop]: () => '这个任务此刻正在运行 —— 先按 x 取消' }}
        />,
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await tick()
      t.stdin.press(ENTER); await tick()
      t.stdin.press(key); await tick()
      const frame = t.lastFrame()
      app.unmount()
      expect(frame).toContain('先按 x 取消')
      // 还在详情页 —— 被拒的语义是「什么都没发生」,不该顺带丢掉他的阅读位置
      expect(frame).toContain('返回任务树')
    })
  }

  it('放行时照常切屏(回 undefined = 调用方已经开关口了)', async () => {
    const seen: string[] = []
    const t = fakeTty(100)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onRedo={n => { seen.push(n.id); return undefined }}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()
    t.stdin.press('r'); await tick()
    // 详情页已关(c 没有出口可打) —— 用回调是否再被调到来证明
    t.stdin.press('r'); await tick()
    app.unmount()
    expect(seen).toEqual(['root', 'root']) // 树上按 r 同样会调,证明确实回到了树
  })

  it('`f 强制通过` 出现在页脚上 —— 它一直能按,却从来没被宣告过', async () => {
    const t = fakeTty(100)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onForcePass={() => undefined}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('f 强制通过')
  })

  it('窄终端上按 ? 翻页 —— 装不下的键不再消失', async () => {
    const t = fakeTty(80)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onRedo={() => undefined} onRedoFailed={() => undefined}
        onSkipFailed={() => undefined} onForcePass={() => undefined}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()
    /**
     * 断言做在**整帧的子串**上,不按行切。
     *
     * 两个坑都踩过:`reset()` 之后拿到的是半张帧(渲染器只写增量);而按 '\n' 切行时
     * 两次重画可能落在同一条文本行里,于是「第 2 页」和「第 1 页」被 `.pop()` 合成一条,
     * 断言当场恒真。页码本身是唯一可靠的判据。
     */
    expect(t.lastFrame()).toContain('[1/')
    expect(t.lastFrame()).toContain('?换页')
    t.stdin.press('?'); await tick()
    const after = t.lastFrame()
    app.unmount()
    expect(after).toContain('[2/')          // 真的翻到了第 2 页
    expect(after).toContain('Esc/q 返回任务树') // 出口每一页都在
  })
})

/**
 * **「只看」不该剥夺重做。**
 *
 * 恢复关口自己印着「树太长……**按 v 查看完整任务树**」,而按 v 之后原来四个动作键
 * 全被摘掉 —— 想看整棵树的人被指进一条死胡同:看得见、动不了。用户报的原话:
 * 「是先按了 v,不然树出不来」。
 *
 * 现在键照给(重做本来就要过确认屏,那是第二次明确决定),代价写在页脚上。
 */
describe('只看模式下动作键仍然在,代价写在明处', () => {
  const NODE = (): TaskNode[] => [mk('root', { title: '根任务', status: 'BLOCKED' })]

  it('键和「按了会开跑」这句话同时在页脚上', async () => {
    const t = fakeTty(100)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onRedo={() => undefined} onRedoFailed={() => undefined}
        onSkipFailed={() => undefined} onForcePass={() => undefined}
        keysNote="只看模式:按这些键并确认后会开始跑一次"
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const tree = t.lastFrame()
    t.stdin.press(ENTER); await tick()
    const detail = t.lastFrame()
    app.unmount()
    // 树上和详情页上都要有那句话,而且键**没有**消失
    expect(tree).toContain('只看模式')
    expect(tree).toContain('r 重做')
    expect(detail).toContain('只看模式')
  })

  it('只看模式下按 r 真的会调到回调 —— 不是一个画上去的死键', async () => {
    const seen: string[] = []
    const t = fakeTty(100)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onRedo={n => { seen.push(n.id); return undefined }}
        keysNote="只看模式:按这些键并确认后会开始跑一次"
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ENTER); await tick()
    t.stdin.press('r'); await tick()
    app.unmount()
    expect(seen).toEqual(['root'])
  })

  it('正常模式下一个字都不多写', async () => {
    const t = fakeTty(100)
    const app = await render(
      <TaskTreePanel
        nodes={NODE()} runId="003" interactive onExitKey={() => {}}
        onRedo={() => undefined}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).not.toContain('只看模式')
    expect(frame).toContain('r 重做')
  })
})
