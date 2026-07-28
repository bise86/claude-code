/**
 * 重做入口的**真组件**验证。
 *
 * 这个仓库在这里割断过三次线:函数写对了、单测全绿、生产上零调用点。所以这一档不 import
 * 任何内部函数,只做用户做的事 —— 把真组件挂起来,按真键,看真帧。
 *
 * 具体守的是:
 *  - DoneView 上按 `r` 真的会带着**光标所在那个节点**回调(不是根、不是第一个);
 *  - 不给 onRedo 时 `r` 是死键,提示行里也不许出现「r 重做」;
 *  - 详情页里按 `r` 同样能进,不用先退回树上;
 *  - 重做关口第二屏在要确认之前,把删除数量/依赖改写/警告**真的印在屏幕上**。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { ConfirmRedo } from './ConfirmRedo.js'
import { DoneView } from './efftask.js'

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
  // 注意这条 strip 正则会把 `[方案]` 这类方括号内容也吃掉一部分,所以断言尽量挑中文短语。
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '')
  // 未经 strip 的原始帧 —— 查颜色时必须用它,plain() 把色码全吃掉了。
  return { stdin, stdout, lastFrame: plain, rawFrame: () => frame }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: `任务${id}`, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  ...over,
})

/** root ─┬─ 甲(已验收) └─ 乙(阻断) */
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
  mk('root/01-b', { title: '乙', parentId: 'root', depth: 1, status: 'BLOCKED', blockedReason: '连续返工超限' }),
]

async function mount(el: React.ReactElement) {
  const t = fakeTty()
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('DoneView 的重做入口', () => {
  it('按 r 带着**光标所在**的节点回调,而不是根节点', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} onRedo={n => seen.push(n)}
      />,
    )
    t.stdin.press('[B') // ↓ 到「甲」
    await tick()
    t.stdin.press('[B') // ↓ 到「乙」
    await tick()
    t.stdin.press('r')
    await tick()
    app.unmount()
    // 回调固定传根节点的话,用户在树上选了半天的那一下就白费了 —— 而屏幕上光标明明在「乙」。
    expect(seen.map(n => n.id)).toEqual(['root/01-b'])
  })

  it('详情页里按 r 也能进,不用先退回树上', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} onRedo={n => seen.push(n)}
      />,
    )
    t.stdin.press('[B')
    await tick()
    t.stdin.press('\r') // 打开详情
    await tick()
    t.stdin.press('r')
    await tick()
    app.unmount()
    // 详情页正是判断「这个节点哪儿错了」的地方,看完就想重做。
    expect(seen.map(n => n.id)).toEqual(['root/00-a'])
  })

  it('没给 onRedo 时按 r 不许抛异常 —— 键处理里的异常对断言是隐形的', async () => {
    // `props.onRedo!(current)` 这种写法在 useInput 里会抛 TypeError,而「r 是死键」
    // 那条用例只断言 exits === 0 和屏幕文案 —— 两个都不会因为抛异常而变。
    // 这里显式盯着未捕获错误。
    const errs: unknown[] = []
    const onErr = (e: unknown): void => { errs.push(e) }
    process.on('uncaughtException', onErr)
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}}
      />,
    )
    t.stdin.press('r')
    await tick()
    app.unmount()
    process.off('uncaughtException', onErr)
    expect(errs).toEqual([])
  })

  it('树面板的图例行在能重做时才写 r —— 正反两个方向都要守', async () => {
    // 原来只测了「没给 onRedo 时不许出现」。反向没测的话,把那个三元改成恒不显示
    // 照样绿 —— 键能用却不写在图例上,等于没有。
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} onRedo={() => {}}
      />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 图例行那一句(和 done 屏底框那句是两处不同的文案)。
    expect(f).toContain('回车看详情 · r 重做')
  })
  it('没给 onRedo 时 r 是死键,提示行里也不许写着有这个键', async () => {
    let exits = 0
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => { exits++ }}
      />,
    )
    t.stdin.press('r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 提示里写了一个不存在的键,比没有这个键更糟。
    expect(f).not.toContain('r 重做')
    expect(exits).toBe(0)
  })

  it('提示行在给了 onRedo 时才出现 r 重做', async () => {
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} onRedo={() => {}}
      />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 断言 DoneView **自己那句**,不是光秃秃的「r 重做」—— 面板底部的图例行里也有这四个字,
    // 所以宽断言会被它满足,把 done 屏这条提示删掉照样绿(变异验证过)。
    expect(f).toContain('r 重做选中的任务')
  })

  it('上一次重做没做成的事显示在 done 屏上', async () => {
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} redoProblems={['甲 的记录没删掉(下次恢复会复活它): EACCES']}
      />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 删不掉的 node.md 会在下一次 --resume 时自己长回来。只写日志等于没说。
    expect(f).toContain('下次恢复会复活它')
  })
})

describe('重做关口', () => {
  it('第一屏列出三条,不可用的写明原因而不是消失', async () => {
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('从「方案」重做')
    expect(f).toContain('从「执行」重做')
    expect(f).toContain('从「集成验收」重做')
    // 菜单随节点类型忽隐忽现的话,用户记不住第几项是哪一项,也看不见为什么这里不能这么做。
    expect(f).toContain('拆分任务')
  })

  it('确认前先把删除数量、依赖改写和警告印出来', async () => {
    const nodes = TREE()
    nodes[2]!.deps = ['root/00-a'] // 乙 依赖 甲
    // 甲 是已验收且有隔离工作区的 —— 这两点合起来才会触发「不会回滚」那句警告。
    nodes[1]!.worktree = { branch: 'br-a', path: '/wt/a' }
    const { t, app } = await mount(
      <ConfirmRedo nodes={nodes} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('\r') // 选中第一条「从方案重做」
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('删除 2 个子任务')
    expect(f).toContain('不会回滚')
    expect(f).toContain('释放 1 个隔离工作区')
  })

  // 「第二屏 Esc 退回第一屏」不在这里测:假 TTY 送裸 \x1b 时 useInput 收不到,
  // 而 harness 的 frame 是累加的 —— 两个条件叠在一起让那条用例的两个断言全部恒真,
  // 把整个 Esc 分支删掉 10 条照样绿(验收实测)。它的语义归 redoGate.test.ts。

  it('回车确认后把选中的环节交出去', async () => {
    const got: string[] = []
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={e => got.push(e)} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('[B') // ↓ 到「执行」(root 上不可用)
    await tick()
    t.stdin.press('\r')
    await tick()
    // 不可用的条目按不动 —— 按下去什么都不该发生,更不该确认成别的环节。
    expect(got).toEqual([])
    t.stdin.press('[B') // ↓ 到「集成验收」
    await tick()
    t.stdin.press('\r')
    await tick()
    t.stdin.press('\r') // 第二屏确认
    await tick()
    app.unmount()
    expect(got).toEqual(['integrate'])
  })

  it('第二屏的 q 是**真的取消**,不是回上一屏', async () => {
    let cancels = 0
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => { cancels++ }} />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    t.stdin.press('q')
    await tick()
    app.unmount()
    // 页脚写着「Esc 换一个环节 · q 取消」。原来两个键走同一分支,于是「q 取消」是句
    // 假话:按下去只是回到第一屏,想彻底退出得连按两次,而屏幕没告诉他。
    expect(cancels).toBe(1)
  })

  it('默认配置下关口不许承诺一个不存在的测试验证环节', async () => {
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={TREE()} targetId="root/00-a" now={NOW}
        phases={{ seatCount: { verify: 0 } }}
        onConfirm={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    // 测试验证是 opt-in,没配角色就整个不存在。写死「执行 → 测试验证 → 验收」
    // 对大多数用户(不配角色的)就是假话。
    expect(f).toContain('未配置角色')
  })

  it('配了验证角色就照实写三步', async () => {
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={TREE()} targetId="root/00-a" now={NOW}
        phases={{ seatCount: { verify: 2 } }}
        onConfirm={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('执行 → 测试验证 → 验收')
    expect(f).not.toContain('未配置角色')
  })

  it('详情页页脚在能重做时才写 r —— 键能用却不写等于没有', async () => {
    const seen: TaskNode[] = []
    const { t, app } = await mount(
      <DoneView
        nodes={TREE()} runId="003" outcome={{ status: 'blocked' }} handoff={null}
        onExit={() => {}} onRedo={n => seen.push(n)}
      />,
    )
    t.stdin.press('\r') // 打开详情
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('r 重做本任务')
  })

  it('被删的子任务清单真的印出来 —— 而且超过 6 个时说清一共多少', async () => {
    // 这一屏是用户在按下不可逆动作之前唯一能核对「删的到底是哪些」的地方。
    const nodes: TaskNode[] = [mk('root', { title: '根任务', kind: 'decompose', status: 'WAITING_CHILDREN' })]
    for (let i = 0; i < 8; i++) {
      const id = 'root/0' + i + '-x'
      nodes[0]!.childIds.push(id)
      nodes.push(mk(id, { title: '子' + i, parentId: 'root', depth: 1 }))
    }
    const { t, app } = await mount(
      <ConfirmRedo nodes={nodes} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('被删的子任务')
    // 印的必须是**前** 6 个:descendantsOf 是 LIFO,不排序的话印出来是 07..02,
    // 而用户最先认得的 00/01 恰好被截掉。
    expect(f).toContain('root/00-x')
    expect(f).not.toContain('root/07-x')
    // 只印前 6 个,但**总数必须说** —— 截断而不说总数,用户会以为只删 6 个。
    expect(f).toContain('等 8 个')
  })

  it('没有子任务可删时不渲染那一行空清单', async () => {
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root/00-a" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('被删的子任务')
  })
  it('目标节点不在树里时给一屏错误,而不是白屏或崩溃', async () => {
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="不存在" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('节点不存在')
  })
})
