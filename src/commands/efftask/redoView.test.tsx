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
import { ConfirmSkip } from './ConfirmSkip.js'
import { ConfirmForcePass } from './ConfirmForcePass.js'
import { ConfirmBacktrack, resultLines } from './ConfirmBacktrack.js'
import { DoneView, RunningView } from './efftask.js'

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

async function mount(el: React.ReactElement, size?: { rows?: number; columns?: number }) {
  const t = fakeTty()
  if (size?.rows) (t.stdout as unknown as { rows: number }).rows = size.rows
  if (size?.columns) (t.stdout as unknown as { columns: number }).columns = size.columns
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
    /**
     * 图例行那一句(和 done 屏底框那句是两处不同的文案)。
     *
     * 断言从「回车看详情 · r 重做」改成「Esc/q 退出 · r 重做」:这一行的次序按**被截掉的
     * 先后**重排过了 —— 出口排最前,然后是动作键,再是导航,最后是图例。评审用真渲染量到
     * 原来那个次序的后果:运行中整行 123 列,60~126 列上一律没有 `Esc/q 退出`;而光标从一个
     * 正常节点移到失败节点时,`R`/`s` 一进来就把 100 列上的出口挤掉了。
     */
    expect(f).toContain('Esc/q 退出 · r 重做')
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
  it('第一屏先选粒度 —— 任务重做和阶段重做的代价差着数量级', async () => {
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('任务重做')
    expect(f).toContain('阶段重做')
    // 不可逆的那一条,数量必须在第一屏就看得见。
    expect(f).toContain('2 个子任务')
  })

  it('第二屏列出六个环节,不可用的写明原因而不是消失', async () => {
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('[B') // ↓ 到「阶段重做」
    await tick()
    t.stdin.press('\r')
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('从「质疑修复」重做')
    expect(f).toContain('从「执行」重做')
    expect(f).toContain('从「测试修复」重做')
    expect(f).toContain('从「验收」重做')
    expect(f).toContain('从「集成验收」重做')
    expect(f).toContain('从「观察」重做')
    // 菜单随节点类型忽隐忽现的话,用户记不住第几项是哪一项,也看不见为什么这里不能这么做。
    expect(f).toContain('拆分任务')
  })

  it('测试修复 / 验收 / 观察在屏幕上按不动,而且写着去哪儿重跑', async () => {
    // 这三个跑在别的 step 内部,没有自己的入口。只写「不可用」是半句话 ——
    // 用户想重跑的那件事通常还是做得到的,只是入口在别处。
    const { t, app } = await mount(
      <ConfirmRedo nodes={TREE()} targetId="root/00-a" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    await tick()
    t.stdin.press('[B')
    await tick()
    t.stdin.press('\r')
    await tick()
    // 窄屏时只有光标那一条带说明,所以逐条走一遍把三条原因都看到。
    let seen = ''
    for (let i = 0; i < 6; i++) { seen += t.lastFrame(); t.stdin.press('[B'); await tick() }
    seen += t.lastFrame()
    app.unmount()
    expect(seen).toContain('跑在执行环节内部')
    // 默认配置下 verify/observer 都是 0 席,理由说的是「这次压根不跑它」——
    // 而不是把用户指到一条同屏可见、却写着「不跑测试修复」的条目上。
    expect(seen).toContain('本次运行没有测试修复环节')
    expect(seen).toContain('本次运行没有观察环节')
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
    expect(f).toContain('删除 1 个隔离工作区的目录与分支')
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
    t.stdin.press('[B') // ↓ 到「阶段重做」
    await tick()
    t.stdin.press('\r')       // 进环节清单,光标落在「质疑修复」(root 没有方案,不可用)
    await tick()
    t.stdin.press('\r')
    await tick()
    // 不可用的条目按不动 —— 按下去什么都不该发生,更不该确认成别的环节。
    expect(got).toEqual([])
    // ↓×4:质疑修复 → 执行 → 测试修复 → 验收 → 集成验收
    for (let i = 0; i < 4; i++) { t.stdin.press('[B'); await tick() }
    t.stdin.press('\r')
    await tick()
    t.stdin.press('\r') // 确认屏
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

  it('默认配置下关口不许承诺一个不存在的测试修复环节', async () => {
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
    // 测试修复是 opt-in,没配角色就整个不存在。写死「执行 → 测试修复 → 验收」
    // 对大多数用户(不配角色的)就是假话。
    expect(f).toContain('未配置角色')
  })

  it('配了验证和观察角色就照实把四步都写出来', async () => {
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={TREE()} targetId="root/00-a" now={NOW}
        phases={{ seatCount: { verify: 2, observer: 1 } }}
        onConfirm={() => {}} onCancel={() => {}}
      />,
    )
    await tick()
    t.stdin.press('[B') // ↓ 到「阶段重做」
    await tick()
    t.stdin.press('\r')
    await tick()
    t.stdin.press('[B') // ↓ 到「执行」—— 光标那一条一定带说明
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('执行 → 测试修复 → 验收 → 观察')
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


/**
 * 屏幕上**画出来了没有** —— 五条被验收抓到的存活变异。
 *
 * 它们的共同点:纯函数那一层钉得很死(`redoGateAction` / `redoMenuLayout` 全绿),
 * 而「这句话有没有出现在屏幕上」一条都没人守。把 `❯`、窗口提示行、第一屏的可选清单、
 * 两处页脚整个删掉,95 条测试照样绿 —— 而这个仓库出过反向的同一种错:页脚写着
 * 「回车/空格 进入」而两个键都是死键,还有一条测试钉住了那句假话的字面量。
 */
describe('菜单画出来的样子', () => {
  const gate = (over: Record<string, unknown> = {}) => (
    <ConfirmRedo nodes={TREE()} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} {...over} />
  )

  it('光标标记 ❯ 在屏幕上 —— 一个会删子树的菜单,得看得出停在哪一项', async () => {
    const { t, app } = await mount(gate())
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('❯')
  })

  it('第一屏写明**这个节点**能选哪几个环节 —— 进去才发现全灰是白走一趟', async () => {
    const { t, app } = await mount(gate())
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('本节点可选')
    expect(f).toContain('集成验收')
  })

  it('第二屏页脚说清「分析」在上一级 —— 这是屏幕上唯一说这件事的地方', async () => {
    const { t, app } = await mount(gate())
    await tick()
    t.stdin.press('[B'); await tick()
    t.stdin.press('\r'); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('上一级')
    expect(f).toContain('分析')
  })

  it('确认屏页脚写着 Esc 能返回重选 —— 键是活的,那就得说', async () => {
    const { t, app } = await mount(gate())
    await tick()
    t.stdin.press('\r')     // 任务重做直接进确认屏
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('Esc 返回重选')
  })

  it('放不下时窗口提示行**画出来**,不是只在算出来', async () => {
    // redoGate.test.ts 只断言 redoMenuLayout 的 from/capacity —— 那一行字有没有上屏,
    // 此前没有任何东西问过。
    const { t, app } = await mount(gate(), { rows: 16 })
    await tick()
    t.stdin.press('[B'); await tick()
    t.stdin.press('\r'); await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('下面还有')
  })

  it('确认屏放不下时,**印出少了几条** —— 截断提示必须活过截断本身', async () => {
    /**
     * 这一屏此前一行预算都没有。实测 80×24 上一个带 9 个子任务 + 依赖改写/移除 +
     * 祖先重开 + 工作区的父节点,光这个框就 21 行,加 REPL 的 5 行 = 26 > 24 ——
     * ink 不裁剪,终端自己滚,**滚掉的是最上面 4 行**,而新加的三条披露正好排在那儿。
     *
     * 现在按预算夹,并印一行「另有 N 条未显示」。那一行占的是**预算之内**的一行 ——
     * 挤在预算之外的话,它自己就是最先被滚掉的东西。
     */
    const nodes = TREE()
    // 造一棵够长的:9 个子任务 + 一条跨子树依赖 + 一个隔离工作区。
    const kids = Array.from({ length: 9 }, (_, i) => mk(`root/1${i}-k`, { title: `子${i}`, parentId: 'root', depth: 1, status: 'ACCEPTED' as const }))
    nodes[0]!.childIds = [...nodes[0]!.childIds, ...kids.map(k => k.id)]
    kids[0]!.worktree = { branch: 'b', path: '/wt/k0' }
    nodes[2]!.deps = [kids[1]!.id]
    const { t, app } = await mount(
      <ConfirmRedo nodes={[...nodes, ...kids]} targetId="root" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
      { rows: 14 },
    )
    await tick()
    t.stdin.press('\r')     // 任务重做 → 确认屏
    await tick()
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('另有')
    expect(f).toContain('条后果未显示')
  })

  it('禁用的条目按下回车**什么都不发生** —— 不是只有文案灰着', async () => {
    // 原来那条只断言了文案在不在,名字承诺的「按不动」那一半从没测过。
    const got: string[] = []
    const { t, app } = await mount(gate({ onConfirm: (e: string) => got.push(e) }))
    await tick()
    t.stdin.press('[B'); await tick()
    t.stdin.press('\r'); await tick()
    // 光标停在「质疑修复」(root 没有方案 → 禁用)。逐条往下按,凡是禁用的都不该确认。
    for (let i = 0; i < 4; i++) {
      t.stdin.press('\r'); await tick()
      expect(`第 ${i} 行按下之后确认了几次: ${got.length}`).toBe(`第 ${i} 行按下之后确认了几次: 0`)
      t.stdin.press('[B'); await tick()
    }
    app.unmount()
  })
})

/**
 * 连按回车。
 *
 * 用户报的两件事的同一个病根:「失败任务重做时,整体并行任务数会超过设置的数」+
 * 「最上面那几个数字老是在跳来跳去,一会儿高一会儿低」。
 *
 * 按下确认**不会**当场卸载这一屏 —— 卸载要等 React 提交下一帧,而在那之前到来的每一下
 * 回车都会再跑一遍同一个 useInput 处理器、再发一次同一个回调。重做/跳过那条路的下游是
 * `applyRedo → runRedo → startRun`,于是同一个 run 目录上起了两个编排器:两个并发池
 * **各自**守着用户设的上限(实际并发翻倍),两棵树又各自往同一个 setNodes 里推
 * (表头那几个计数来回跳)。根方案关口为这件事单独立过 `rootDecided`(注释里记着实测的
 * 「三下快回车 = 三个编排器」),这三个关口是同一个形状。
 *
 * 实测过没有闩时的读数:三下回车 = 3 次 onConfirm。
 */
describe('关口的出口只走一次', () => {
  const blockedAt = (phase: 'ACCEPTANCE' | 'EXECUTING'): TaskNode[] => [
    mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
    mk('root/00-a', {
      title: '甲', parentId: 'root', depth: 1, status: 'BLOCKED',
      blockedReason: '连续返工超限', failedAt: phase,
    }),
  ]

  it('ConfirmRedo:三下回车只确认一次', async () => {
    let confirms = 0
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={blockedAt('EXECUTING')} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={() => { confirms++ }} onCancel={() => {}}
      />,
    )
    // 三下之间**不等 React 提交** —— 真实的连按就是这样(见上面的注释)。
    t.stdin.press('\r')
    t.stdin.press('\r')
    t.stdin.press('\r')
    await tick()
    app.unmount()
    expect(`三下回车确认了几次: ${confirms}`).toBe('三下回车确认了几次: 1')
  })

  it('ConfirmRedo:确认之后的 Esc 不再发第二个决定', async () => {
    // 确认和取消共用同一个闩:它们都是这一屏的出口,发过一个就不该再发另一个 ——
    // 否则 onCancel 会把界面翻回 done,而重做已经开跑了。
    const seen: string[] = []
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={blockedAt('EXECUTING')} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={() => seen.push('confirm')} onCancel={() => seen.push('cancel')}
      />,
    )
    t.stdin.press('\r')
    t.stdin.press('q') // q 和 Esc 同义,而 Esc 在假 TTY 上要等 tokenizer 的窗口
    await tick()
    app.unmount()
    expect(seen).toEqual(['confirm'])
  })

  it('ConfirmSkip:两下回车只确认一次', async () => {
    let confirms = 0
    const { t, app } = await mount(
      <ConfirmSkip
        nodes={blockedAt('ACCEPTANCE')} targetId="root/00-a" now={NOW}
        onConfirm={() => { confirms++ }} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r')
    t.stdin.press('\r')
    await tick()
    app.unmount()
    expect(`两下回车确认了几次: ${confirms}`).toBe('两下回车确认了几次: 1')
  })

  it('ConfirmForcePass:两下回车只确认一次', async () => {
    let confirms = 0
    const { t, app } = await mount(
      <ConfirmForcePass
        nodes={blockedAt('ACCEPTANCE')} targetId="root/00-a" now={NOW}
        onConfirm={() => { confirms++ }} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r')
    t.stdin.press('\r')
    await tick()
    app.unmount()
    // 强制通过重开编排走的也是 startRun;而它留下的是一条署名的裁决记录,两次就是两条。
    expect(`两下回车确认了几次: ${confirms}`).toBe('两下回车确认了几次: 1')
  })

  it('ConfirmForcePass:运行中预先批准也只记一笔', async () => {
    // 这条路不重开编排,但预先批准是**一次性**标记:多记的那一条会作用到下一次同名环节上,
    // 而那正是 failedAt 过期时踩过的坑。
    const picks: string[] = []
    const running: TaskNode[] = [
      mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a'], status: 'WAITING_CHILDREN' }),
      mk('root/00-a', { title: '甲', parentId: 'root', depth: 1, status: 'EXECUTING' }),
    ]
    const { t, app } = await mount(
      <ConfirmForcePass
        nodes={running} targetId="root/00-a" now={NOW}
        onConfirm={() => {}} onCancel={() => {}} onPreApprove={p => { picks.push(p); return undefined }}
      />,
    )
    t.stdin.press('\r')
    t.stdin.press('\r')
    await tick()
    app.unmount()
    expect(picks.length).toBe(1)
  })
})

/**
 * **回溯关口:真组件、真键、真帧。**
 *
 * 这一屏是「按下确认之后到底发生了什么」的唯一出口,而它此前一条组件级用例都没有 ——
 * 而同一个功能的接线层曾经造出 14 条存活变异,每一条的用户可见后果都是
 * 「按下确认之后界面纹丝不动」。
 */
describe('回溯关口', () => {
  const NOW2 = '2026-08-14T00:00:00.000Z'
  const bt = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW2 }),
    ...over,
  })
  /** 子任务全绿的父任务 —— 跑机上 34 个,而它此前会让整次回溯变成一行「回溯未执行」。 */
  const judgeOnlyTree = (): TaskNode[] => [
    bt('P', {
      kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01'],
      acceptLog: [{
        round: 3, step: 'integrate',
        verdicts: [{ role: '集成官', pass: false, blocking: ['datum.rs 不在集成工作区'], comments: '' }],
        synthesized: { pass: false, blockingSummary: 'datum.rs 不在集成工作区' },
      }],
    }),
    bt('P/01', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
  ]

  it('确认之前就说清:这一格是「重新裁决 + 重新开放补救拆分」,不是重跑执行', async () => {
    const nodes = judgeOnlyTree()
    const { t, app } = await mount(
      <ConfirmBacktrack
        target={nodes[0]} nodes={nodes}
        onRun={async () => undefined} onDone={() => {}} onCancel={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('重新裁决')
    expect(f).toContain('补救拆分')
    // 「N 个任务重跑执行阶段」这句话对这一格是假的 —— 一个执行者都不会被派出去。
    expect(f).toContain('0 个任务重跑执行阶段')
    /**
     * **这一句才是「接线接上了」的证据。** 对抗席实测:把 `conservativeEntries(...)`
     * 整段换回改前的 `entry: ''`,上面那三条断言**照样成立**(其中 `0 个任务重跑执行阶段`
     * 恰恰是坏版本也会印的那个 0),而真正被换掉的这一句在坏版本里整句消失。
     * 真组件真帧 ≠ 真断言 —— 断言要落在「只有接对了才会出现」的那句话上。
     */
    expect(f?.replace(/\s+/g, '')).toContain('1个只重新裁决集成验收')
  })

  it('结果屏把「跳过了哪几个」印出来 —— 不许只报成功的那几个', () => {
    const lines = resultLines({
      entries: [{ nodeId: 'P/02', entry: 'execute' }, { nodeId: 'P', entry: 'integrate' }],
      skipped: ['P/09:这是拆分任务,它自己没有执行环节'],
      rearmed: ['P'],
    })
    const s = lines.join('\n')
    expect(s).toContain('已重跑 2 个任务')
    expect(s).toContain('只重新裁决集成验收')
    expect(s).toContain('P/09')
    expect(s).toContain('重新武装了补救拆分')
  })

  it('一个都没跑成时不说「已重跑 0 个」', () => {
    const s = resultLines({ entries: [], skipped: [], rearmed: [] }).join('\n')
    expect(s).toContain('没有重跑任何任务')
    expect(s).not.toContain('已重跑 0')
  })
})

/**
 * **「没做成的事」在运行视图上也要看得见。**
 *
 * 接缝席真帧实测:`onProblems` 那条流此前只有结束屏读,而 `r`/`R`/`s`/`b` 四个键在运行
 * 视图上全是通的 —— 关口关掉之后回的就是这一屏,而 `ConfirmBacktrack` 印的是
 * 「这次回溯没有执行 —— 原因见任务树上的提示」。那时运行视图上一个字都没有。
 */
describe('运行视图上的 problems', () => {
  it('印出来,而且给树让位(reservedRows)', async () => {
    const { t, app } = await mount(
      <RunningView
        nodes={TREE()} runId="003" onAbort={() => {}}
        problems={['回溯未执行:这棵子树里没有一个可以重新派出去的任务']}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('回溯未执行')
  })

  it('超过 3 条时,被挤掉的那几条要有人说出来', async () => {
    const { t, app } = await mount(
      <RunningView
        nodes={TREE()} runId="003" onAbort={() => {}}
        problems={['一', '二', '三', '四', '五']}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('另有 2 条未显示')
  })

  it('没有 problems 时一行都不占', async () => {
    const { t, app } = await mount(<RunningView nodes={TREE()} runId="003" onAbort={() => {}} />)
    const f = t.lastFrame()
    app.unmount()
    expect(f).not.toContain('⚠')
  })
})

/**
 * **让位是要量的,不是承诺的。**
 *
 * 这几行按条数计进 `reservedRows` —— 不让位的话树照旧画满,总输出多出这么多行,
 * 而被顶出屏幕的是底部的图例和按键提示(这个仓库为同一件事写过两次注释)。
 * 变异测试实测:把 `reservedRows={problemRows}` 整个拿掉,全套 4030 条一条都不红。
 */
describe('运行视图的行预算', () => {
  const many = (): TaskNode[] => [
    mk('root', { title: '根任务', kind: 'decompose', childIds: Array.from({ length: 30 }, (_, i) => `root/${i}`), status: 'WAITING_CHILDREN' }),
    ...Array.from({ length: 30 }, (_, i) => mk(`root/${i}`, { title: `子任务${i}`, parentId: 'root', depth: 1, status: 'ACCEPTED' })),
  ]
  const countTaskRows = (f: string): number => (f.match(/\[(ACCEPTED|WAITING_CHILDREN)\]/g) ?? []).length

  it('印了 3 条问题,树就要少画 3 行', async () => {
    // 终端要**矮到**让 `termRows - 8 - reserved` 咬得住 20 行那个上限 ——
    // 40 行的默认终端上两边都夹到 20,这条用例会证明不了任何事(第一版就是这样)。
    const a = await mount(<RunningView nodes={many()} runId="003" onAbort={() => {}} />, { rows: 24 })
    const rowsWithout = countTaskRows(a.t.lastFrame())
    a.app.unmount()
    const b = await mount(
      <RunningView nodes={many()} runId="003" onAbort={() => {}} problems={['一', '二', '三']} />,
      { rows: 24 },
    )
    const rowsWith = countTaskRows(b.t.lastFrame())
    b.app.unmount()
    expect(rowsWithout).toBeGreaterThan(3)
    expect(rowsWithout - rowsWith).toBe(3)
  })
})


/**
 * 结果屏的截断纪律 —— 和仓库里那条「N hidden 必须活在被裁掉的东西之外」同一类。
 */
describe('结果屏:跳过的太多时', () => {
  it('只印前 5 条,并说清还有几条', () => {
    const s = resultLines({
      entries: [{ nodeId: 'A', entry: 'execute' }],
      skipped: Array.from({ length: 9 }, (_, i) => `P/0${i}:算不出来`),
      rearmed: [],
    }).join('\n')
    expect(s).toContain('另有 9 个没能派出去')
    expect(s).toContain('P/04')
    expect(s).not.toContain('P/05')
    expect(s).toContain('…另有 4 条')
  })
})
