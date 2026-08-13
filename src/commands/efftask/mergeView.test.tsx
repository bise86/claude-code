/**
 * 「手动合并未合入主干的工作区」的**真组件**验证。
 *
 * 和 cleanupView.test.tsx 同一个理由:这个仓库在接线上割断过三次,函数写对了、单测全绿、
 * 生产上零调用点。所以这一档不 import 判据函数,只做用户做的事 —— 挂真组件、按真键、
 * 看真帧。
 *
 * 守的是:
 *  - 详情页里按 `m` 真的会带着**打开的那个节点**回调;
 *  - 没给回调时 `m` 是死键,而且页脚里不许出现这个键(按了没反应比没有更糟);
 *  - 关口在按下确认之前,把「合几个 / 合到哪条分支 / 撞冲突谁来解 / 什么不会被改」印出来;
 *  - 扫描没回来之前回车**不会**执行;
 *  - 合并期间**有进度**(这一路每个冲突都是一次模型调用,一屏不动等于死机);
 *  - 「合完当前这个再停」是一个真的按钮,不是一句安慰;
 *  - 结果自己上屏 —— 合并是静默的,没有这一屏用户分不清成功和一个都没合上。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { ConfirmMergeSubtree } from './ConfirmMergeSubtree.js'
import { DoneView } from './efftask.js'
import type { SubtreeMergeOutcome, SubtreeMergePlan } from '../../tools/efftask/mergeSubtree.js'

const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 15))
// 裸 ESC 会被 tokenizer 压住,直到它能排除「这是一段转义序列的开头」为止 —— 断言 Esc
// 必须等过那个窗口(resumeView.test.tsx 为同一件事写过这条注释)。
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
  const plain = (): string => frame.replace(/\x1b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\x1b/g, '')
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

const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
  mk('root/01-b', { title: '乙', parentId: 'root', depth: 1, status: 'BLOCKED', mergeConflict: true }),
]

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

const PLAN = (over: Partial<SubtreeMergePlan> = {}): SubtreeMergePlan => ({
  targetId: 'root',
  items: [{
    nodeId: 'root/01-b', title: '乙', status: 'BLOCKED',
    path: '/w/b', branch: 'efftask/001/node-b', commits: 3, loose: 2,
  }],
  skipped: [{ nodeId: 'root/02-c', title: '丙', why: '还没跑完(EXECUTING)—— 它的工作区正被执行者写着' }],
  alreadyMerged: 1, absent: 0, ignoredOnly: 0,
  trunk: { branch: 'main', pending: 4 },
  canResolve: true, runActive: false,
  ...over,
})

const OUTCOME = (over: Partial<SubtreeMergeOutcome> = {}): SubtreeMergeOutcome => ({
  merged: [{ nodeId: 'root/01-b', title: '乙', commits: 3 }],
  failed: [], problems: [],
  trunk: { ok: true, message: '已合并 efftask/001/integration(4 个提交)到当前分支', followUps: [] },
  aborted: false,
  ...over,
})

describe('详情页的 m 键', () => {
  it('带着**打开的那个节点**回调', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}} onMergeWorktrees={n => seen.push(n)}
      />,
    )
    t.stdin.press('\x1b[B') // ↓ 到「甲」
    await tick()
    t.stdin.press('\r')     // 进详情页
    await tick()
    t.stdin.press('m')
    await tick()
    app.unmount()
    expect(seen.map(n => n.id)).toEqual(['root/00-a'])
  })

  it('页脚在给了回调时才写这个键,而且写清目的地 —— 正反两个方向都守', async () => {
    const withKey = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}} onMergeWorktrees={() => {}}
      />,
    )
    withKey.t.stdin.press('\r')
    await tick()
    const on = withKey.t.lastFrame()
    withKey.app.unmount()

    const without = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}}
      />,
    )
    without.t.stdin.press('\r')
    await tick()
    const off = without.t.lastFrame()
    without.app.unmount()

    // 「合并工作区」不够:这个键会在用户自己的分支上产生真实提交,页脚是他唯一读得到的地方。
    expect(on).toContain('m 合并工作区到主干')
    // 共享工作树运行时没有池子 —— 一个按了什么都不会发生的键比没有这个键更糟。
    expect(off).not.toContain('m 合并工作区')
  })

  it('没给回调时按 m 不抛异常,也不会关掉详情页', async () => {
    const errs: unknown[] = []
    const onErr = (e: unknown): void => { errs.push(e) }
    process.on('uncaughtException', onErr)
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'completed' }} handoff={null}
        onExit={() => {}}
      />,
    )
    t.stdin.press('\r')
    await tick()
    t.stdin.press('m')
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    process.off('uncaughtException', onErr)
    expect(errs).toEqual([])
    expect(frame).toContain('子 agent 输出')
  })
})

describe('合并关口', () => {
  const target = mk('root', { title: '根任务' })
  const noop = async (): Promise<SubtreeMergeOutcome> => OUTCOME({ merged: [] })

  it('确认之前把后果摊开:合几个、合到哪、撞冲突谁来解、什么不会被改', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => PLAN()} onRun={noop}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('3 个提交')
    expect(frame).toContain('未提交内容会被一并提交')
    expect(frame).toContain('主模型')
    expect(frame).toContain('main')
    expect(frame).toContain('任务状态不会被改动')
    // 还在跑的那个必须说清楚是「跳过」,不是被算进了这次合并。
    expect(frame).toContain('跳过 1 个')
    expect(frame).toContain('确认合并')
  })

  it('两边都没事可做时,明说「已经在你的分支上了」,而不是只说「没有需要合并的工作区」', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target}
        onScan={async () => PLAN({ items: [], skipped: [], trunk: { branch: 'main', pending: 0 } })}
        onRun={noop} onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    // 用户按这个键多半是因为「我的产出不在目录里」——「已经在了」和「有东西没合、只是
    // 我没告诉你」是两个完全不同的结论。
    expect(frame).toContain('都已经在你的分支上了')
    expect(frame).toContain('回车 / q / Esc 返回')
  })

  it('没有解冲突的人时,屏幕上必须先说出来', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => PLAN({ canResolve: false })} onRun={noop}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('不会自动解决')
  })

  it('一个节点都不用合、但东西还卡在集成分支上时,回车**要能执行**', async () => {
    let ran = 0
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target}
        onScan={async () => PLAN({ items: [], trunk: { branch: 'main', pending: 4 } })}
        onRun={async () => { ran++; return OUTCOME({ merged: [] }) }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    app.unmount()
    // 这是这个键最典型的一次用法(逐任务合并被脏树挡过),把它变成死键等于功能不存在。
    expect(ran).toBe(1)
  })

  it('扫描还没回来时回车不执行 —— 那一下不该落在一个还不存在的清单上', async () => {
    let ran = 0
    let release = (): void => {}
    const gate = new Promise<SubtreeMergePlan>(res => { release = () => res(PLAN()) })
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={() => gate}
        onRun={async () => { ran++; return OUTCOME() }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r')
    await tick()
    expect(ran).toBe(0)
    expect(t.lastFrame()).toContain('正在清点')
    release()
    await tick()
    app.unmount()
  })

  it('合并期间有**进度**,而且「合完当前这个再停」是个真按钮', async () => {
    let ran = 0
    let push: (s: string) => void = () => {}
    let finish = (): void => {}
    let interrupted = 0
    const running = new Promise<SubtreeMergeOutcome>(res => { finish = () => res(OUTCOME()) })
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => PLAN()}
        onRun={(_p, _stash, onProgress) => { ran++; push = onProgress; return running }}
        onInterrupt={() => { interrupted++ }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    expect(ran).toBe(1)
    push('合并「乙」(3 个提交)…')
    await tick()
    expect(t.lastFrame()).toContain('合并「乙」')
    // 合并中途再按回车不该第二次执行。
    t.stdin.press('\r')
    await tick()
    expect(ran).toBe(1)
    // Esc = 请求中断(不是立刻停:一次 git merge 被劈开只会留下半合并状态)。
    t.stdin.press('\x1b')
    await tickEsc()
    expect(interrupted).toBe(1)
    expect(t.lastFrame()).toContain('已请求中断')
    finish()
    await tick()
    app.unmount()
  })

  it('结果自己上屏 —— 一个都没合上时不许说「已合并 0 个」', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => PLAN()}
        onRun={async () => OUTCOME({
          merged: [],
          failed: [{ nodeId: 'root/01-b', title: '乙', why: '冲突自动解决未成功:解决结果里还留着冲突标记', followUps: ['分支原样保留'] }],
          trunk: { ok: false, message: '没有把产出合回你的分支:你的工作区有未提交的改动', followUps: [] },
        })}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    const frame = t.lastFrame()
    app.unmount()
    expect(frame).toContain('没有合并任何工作区')
    expect(frame).toContain('乙 没合上')
    expect(frame).toContain('未提交的改动')
    expect(frame).not.toContain('已合并 0 个')
  })
})

/**
 * **`s`:先把你的改动收起来、合完自动放回去 —— 默认关,按一下才开。**
 *
 * 用户原话:「提供选项,但要你按一下」;「检测到脏就自动 stash」那一档他明确否决过。
 * 而这个键只在「你手上确实有未提交的已跟踪改动」时才是一个选择 —— 否则它按下去什么都
 * 不会变,那比没有这个键更糟。
 */
describe('合并关口的 s 键', () => {
  const target = mk('root', { title: '根任务' })
  const noop = async (): Promise<SubtreeMergeOutcome> => OUTCOME({ merged: [] })
  const dirtyPlan = () => PLAN({ trunk: { branch: 'main', pending: 3, dirty: ' M src/app.ts' } })

  it('脏的时候把这一档摆出来,按一下开、再按一下关', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => dirtyPlan()} onRun={noop}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    expect(t.lastFrame()).toContain('s 先 stash 再合')
    t.stdin.press('s'); await tick()
    expect(t.lastFrame()).toContain('已开')
    t.stdin.press('s'); await tick()
    expect(t.lastFrame()).toContain('s 先 stash 再合')
    app.unmount()
  })

  it('按过 s 之后,onRun 真的收到 true', async () => {
    let got: boolean | undefined
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => dirtyPlan()}
        onRun={async (_p, stash) => { got = stash; return OUTCOME() }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    t.stdin.press('s'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(got).toBe(true)
  })

  it('没按过就是 false —— 默认永远是关', async () => {
    let got: boolean | undefined
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => dirtyPlan()}
        onRun={async (_p, stash) => { got = stash; return OUTCOME() }}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(got).toBe(false)
  })

  /** 树不脏时这个键**不摆出来**,也按不动 —— 一个按下去什么都不变的键比没有它更糟。 */
  it('不脏就不印这个键', async () => {
    const { t, app } = await mount(
      <ConfirmMergeSubtree
        target={target} onScan={async () => PLAN()} onRun={noop}
        onDone={() => {}} onCancel={() => {}}
      />,
    )
    t.stdin.press('s'); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('先 stash 再合')
    expect(f).not.toContain('已开')
  })
})

/**
 * **带修饰键的不算动作键 —— 这一屏的确认键会产生真实提交。**
 *
 * 验收席真按键实测:C 节把 `s` 加进了唯一漏掉 `plain` 守卫的那一屏,而 `Ctrl+Y` /
 * `Alt+y` / kitty `ESC[121;5u` 在这里全都按得下去 —— 那一下会真的开始合并。
 */
describe('合并关口不认修饰键', () => {
  const ESC = String.fromCharCode(27)

  it('Ctrl+Y / Alt+y / kitty C-y 都不许开始合并', async () => {
    let ran = 0
    const t = fakeTty()
    const app = await render(
      <ConfirmMergeSubtree
        target={mk('root', { title: '根任务' })} onScan={async () => PLAN()}
        onRun={async () => { ran++; return OUTCOME() }}
        onDone={() => {}} onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    for (const seq of ['\x19', `${ESC}y`, `${ESC}[121;5u`]) {
      t.stdin.press(seq)
      await tick()
    }
    app.unmount()
    expect(ran).toBe(0)
  })

  it('Ctrl+S 不许拨动 stash 那一档', async () => {
    const t = fakeTty()
    const app = await render(
      <ConfirmMergeSubtree
        target={mk('root', { title: '根任务' })}
        onScan={async () => PLAN({ trunk: { branch: 'main', pending: 3, dirty: ' M a.ts' } })}
        onRun={async () => OUTCOME()} onDone={() => {}} onCancel={() => {}}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    for (const seq of ['\x13', `${ESC}s`, `${ESC}[115;5u`]) {
      t.stdin.press(seq)
      await tick()
    }
    expect(t.lastFrame()).not.toContain('已开')
    // 裸 s 仍然要能拨。
    t.stdin.press('s'); await tick()
    expect(t.lastFrame()).toContain('已开')
    app.unmount()
  })

  /** Esc 不许被守卫写死 —— `key.meta` 对 Escape 恒为真。 */
  it('Esc 照旧是取消', async () => {
    let cancelled = 0
    const t = fakeTty()
    const app = await render(
      <ConfirmMergeSubtree
        target={mk('root', { title: '根任务' })} onScan={async () => PLAN()}
        onRun={async () => OUTCOME()} onDone={() => {}} onCancel={() => { cancelled++ }}
      />,
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await tick()
    t.stdin.press(ESC)
    await new Promise(r => setTimeout(r, 80))
    app.unmount()
    expect(cancelled).toBe(1)
  })
})
