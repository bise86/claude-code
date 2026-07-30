/**
 * 失败节点的两个键(`R` 重做失败环节 / `s` 跳过它),以及跳过关口 —— 挂真组件,按真键。
 *
 * 纯函数档(redo.ts 的 failedRedoTarget / skipFailedPhaseReason / planSkip)守的是判据;
 * 这一档守的是**它真的接上了**,以及三件必须成立的事:
 *
 *  1. `R` 不被 `r` 吃掉(`input.toLowerCase()` 是这个面板的既有写法,而 `R` 必须排在它前面);
 *  2. 页脚只在**光标停在失败节点上**时才写这两个键 —— 一个按了只会被拒绝的键和一个按了
 *     没反应的键一样糟;
 *  3. 补提示词那一屏的键盘整个归输入框:用户写「q 要改成小写」时那个 `q` 不许把关口关掉。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'

import { render } from '../../ink.js'
import { createNode, emptyPhaseRoles, type TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { ConfirmSkip } from './ConfirmSkip.js'
import { ConfirmRedo } from './ConfirmRedo.js'

const DOWN = '\u001b[B'
const NOW = new Date().toISOString()
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

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
  const plain = (): string => frame.replace(/\u001b\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(/\u001b/g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: `任务${id}`, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  kind: 'executable',
  ...over,
})

/** root(等子任务) ─┬─ 甲(验收失败) └─ 乙(已验收) */
const TREE = (): TaskNode[] => [
  mk('root', { title: '根任务', kind: 'decompose', childIds: ['root/00-a', 'root/01-b'], status: 'WAITING_CHILDREN' }),
  mk('root/00-a', {
    title: '甲', parentId: 'root', depth: 1, status: 'BLOCKED', failedAt: 'ACCEPTANCE',
    blockedReason: '验收迭代超限(3): [qa] 缺测试',
    plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
    execStatus: '改了 src/a.ts',
  }),
  mk('root/01-b', { title: '乙', parentId: 'root', depth: 1, status: 'ACCEPTED' }),
]

async function mount(el: React.ReactElement, cols = 120) {
  const t = fakeTty(cols)
  const app = await render(el, {
    stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  await tick()
  return { t, app }
}

describe('R / s 两个键', () => {
  it('R 走的是**快速重做失败环节**,不是那个三屏菜单', async () => {
    /**
     * 这个面板既有的写法是 `const k = input.toLowerCase()`,所以 `R` 会被 `k === 'r'`
     * 那一支吃掉 —— 用户按 R 拿到的是「自己选环节」的菜单,而快速重做这个键彻底消失。
     * 判据必须是 `input` 原文,而且排在 `r` 前面。
     */
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={() => log.push('redo')}
        onRedoFailed={n => log.push(`redoFailed:${n.id}`)}
        onSkipFailed={n => log.push(`skip:${n.id}`)}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press(DOWN); await tick()   // ↓ 到「甲」
    t.stdin.press('R'); await tick()
    app.unmount()
    expect(log).toEqual(['redoFailed:root/00-a'])
  })

  it('s 跳过光标选中的那个节点', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={() => log.push('redo')}
        onSkipFailed={n => log.push(`skip:${n.id}`)}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press(DOWN); await tick()
    t.stdin.press('s'); await tick()
    app.unmount()
    expect(log).toEqual(['skip:root/00-a'])
  })

  it('小写 r 仍然是那个三屏菜单 —— 这次改动不许拿走它', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={n => log.push(`redo:${n.id}`)}
        onRedoFailed={() => log.push('redoFailed')}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press('r'); await tick()
    app.unmount()
    expect(log).toEqual(['redo:root'])
  })

  it('页脚只在光标停在失败节点上时才写这两个键', async () => {
    /**
     * 这一行是 `wrap="truncate-end"`,实测已经贴着 80 列 —— 无条件多写 20 列会把右边的
     * `Esc/q 退出` 吃掉,也就是用「两个只在特定行有用的键」换掉「怎么退出去」。
     * 而且它们对一个没失败的节点本来就不可用。
     */
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={() => {}} onRedoFailed={() => {}} onSkipFailed={() => {}}
        onExitKey={() => {}}
      />,
    )
    // 光标在 root(WAITING_CHILDREN):不写。
    expect(t.lastFrame()).not.toContain('R 重做失败环节')
    t.reset()
    t.stdin.press(DOWN); await tick()   // ↓ 到「甲」(BLOCKED)
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('R 重做失败环节')
    expect(f).toContain('s 跳过它')
  })

  it('详情页里这两个键也在 —— 那正是刚看完阻断原因的地方', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={() => log.push('redo')}
        onRedoFailed={n => log.push(`redoFailed:${n.id}`)}
        onSkipFailed={n => log.push(`skip:${n.id}`)}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press(DOWN); await tick()
    t.stdin.press('\r'); await tick()   // 进详情页
    expect(t.lastFrame()).toContain('返回任务树')
    t.stdin.press('R'); await tick()
    app.unmount()
    expect(log).toEqual(['redoFailed:root/00-a'])
  })

  it('没接这两个回调时它们是死键,页脚也不写', async () => {
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel nodes={TREE()} runId="003" interactive onRedo={() => log.push('redo')} onExitKey={() => {}} />,
    )
    t.stdin.press(DOWN); await tick()
    const f = t.lastFrame()
    t.stdin.press('s'); await tick()
    app.unmount()
    expect(log).toEqual([])
    expect(f).not.toContain('s 跳过它')
  })
})

describe('跳过关口', () => {
  const nodes = () => TREE()

  it('一屏摊开后果:跳了哪个环节、之后跑什么、执行不重跑', async () => {
    const { t, app } = await mount(
      <ConfirmSkip nodes={nodes()} targetId="root/00-a" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('跳过「验收」')
    expect(f).toContain('不会发生')
    // 这次跳过最容易被误解的地方 —— 它不重跑执行者。
    expect(f).toContain('执行环节不重跑')
  })

  it('回车确认;不写提示词时不带 guidance', async () => {
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmSkip nodes={nodes()} targetId="root/00-a" now={NOW} onConfirm={g => seen.push(g)} onCancel={() => {}} />,
    )
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([undefined])
  })

  it('q 取消,一次都不确认', async () => {
    let confirms = 0
    let cancels = 0
    const { t, app } = await mount(
      <ConfirmSkip
        nodes={nodes()} targetId="root/00-a" now={NOW}
        onConfirm={() => { confirms++ }} onCancel={() => { cancels++ }}
      />,
    )
    t.stdin.press('q'); await tick()
    app.unmount()
    expect([confirms, cancels]).toEqual([0, 1])
  })

  it('e 进输入框,写完回到确认屏并把那句话印出来', async () => {
    /**
     * 印出来是**功能性的**:它会真的进提示词,而这是用户按下确认之前最后一次核对自己写了
     * 什么的机会。只在页脚写一句「已补充」是半句话 —— 他不知道自己有没有打错、打漏。
     */
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmSkip nodes={nodes()} targetId="root/00-a" now={NOW} onConfirm={g => seen.push(g)} onCancel={() => {}} />,
    )
    t.stdin.press('e'); await tick()
    expect(t.lastFrame()).toContain('补一句提示词')
    for (const ch of ['补', '上', '测', '试']) { t.stdin.press(ch); await tick() }
    t.stdin.press('\r'); await tick()   // 提交那句话 → 回确认屏
    /**
     * 断言**后果清单那一行的形状**,不是裸的「补充指引」。
     *
     * 验收抓到的:页脚在 note 非空时写的是「e **改写补充指引**」,所以
     * `toContain('补充指引')` 恒真 —— 把回显那一行整个删掉,用户打的字从屏幕上消失,
     * 而这条用例 17 pass。这正是这个仓库反复付学费的 look-alike 断言。
     */
    expect(t.lastFrame()).toContain('补充指引(给整个任务)')
    expect(t.lastFrame()).toContain('补上测试')
    t.stdin.press('\r'); await tick()   // 确认跳过
    app.unmount()
    expect(seen).toEqual([{ scope: 'all', text: '补上测试' }])
  })

  it('输入框里的 q / y / n 是**正文**,不是快捷键', async () => {
    // 不让路的话,用户写「q 要改成小写」的那个 q 会把整个关口关掉,他刚打的字全没了;
    // `y` 更糟 —— 确认屏那一支会把它当「确认」,当场开跑。
    const seen: unknown[] = []
    let cancels = 0
    const { t, app } = await mount(
      <ConfirmSkip
        nodes={nodes()} targetId="root/00-a" now={NOW}
        onConfirm={g => seen.push(g)} onCancel={() => { cancels++ }}
      />,
    )
    t.stdin.press('e'); await tick()
    for (const ch of ['q', 'y', 'n']) { t.stdin.press(ch); await tick() }
    expect(cancels).toBe(0)
    expect(seen).toEqual([])
    t.stdin.press('\r'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([{ scope: 'all', text: 'qyn' }])
  })

  it('不能跳的节点:说原因,而不是给一个按不动的确认屏', async () => {
    const bad = [mk('x', { status: 'BLOCKED', failedAt: 'EXECUTING' })]
    const { t, app } = await mount(
      <ConfirmSkip nodes={bad} targetId="x" now={NOW} onConfirm={() => {}} onCancel={() => {}} />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('什么都没做')
  })
})

describe('重做关口:补一句提示词', () => {
  const nodes = () => TREE()

  it('预选入口时直接停在确认屏上,而且**仍然**是确认屏', async () => {
    // 「快速」是省掉两屏菜单,不是省掉确认屏:失败在分析环节的拆分型节点,它的入口就是
    // 「任务重做」,而那一条会删掉整棵子树。一个按下去就删的快捷键不该存在。
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={nodes()} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={() => {}} onCancel={() => {}}
      />,
    )
    const f = t.lastFrame()
    app.unmount()
    expect(f).toContain('确认重做')
    expect(f).toContain('回车 / y 确认')
  })

  it('阶段重做:那句话只给那个环节', async () => {
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={nodes()} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={(e, g) => seen.push([e, g])} onCancel={() => {}}
      />,
    )
    t.stdin.press('e'); await tick()
    for (const ch of ['先', '跑', '测', '试']) { t.stdin.press(ch); await tick() }
    t.stdin.press('\r'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([['execute', { scope: 'execute', text: '先跑测试' }]])
  })

  it('任务重做:那句话给整个节点', async () => {
    // 用户的两句原话分别对应这两个去处(「给这个阶段」/「给这个子任务」),
    // 写死一个会让另一句失效。
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={nodes()} targetId="root/00-a" now={NOW} initialEntry="plan"
        onConfirm={(e, g) => seen.push([e, g])} onCancel={() => {}}
      />,
    )
    t.stdin.press('e'); await tick()
    for (const ch of ['换', '个', '思', '路']) { t.stdin.press(ch); await tick() }
    t.stdin.press('\r'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([['plan', { scope: 'all', text: '换个思路' }]])
  })

  it('不写就不带 —— 空文本不许在提示词里留一个空槽', async () => {
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={nodes()} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={(e, g) => seen.push([e, g])} onCancel={() => {}}
      />,
    )
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([['execute', undefined]])
  })

  it('输入框里的 y 是正文,不是「确认」', async () => {
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={nodes()} targetId="root/00-a" now={NOW} initialEntry="execute"
        onConfirm={(e, g) => seen.push([e, g])} onCancel={() => {}}
      />,
    )
    t.stdin.press('e'); await tick()
    t.stdin.press('y'); await tick()
    expect(seen).toEqual([])
    t.stdin.press('\r'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([['execute', { scope: 'execute', text: 'y' }]])
  })
})

describe('评审实按查出来的那几条', () => {
  it('kitty / modifyOtherKeys 终端上按 Shift+R 也要走快速重做', async () => {
    /**
     * 那些终端送的是 `ESC[82;2u`,而仓库自己的 parse-keypress 把它解成
     * `input='r', shift=true` —— 只判 `input === 'R'` 的话它会掉到下一行的 `k === 'r'` 上,
     * 用户按 R 拿到的是三屏菜单,而快速重做这个键彻底消失。`ink.tsx` 正是在 iTerm / kitty /
     * WezTerm / ghostty / tmux / Windows Terminal 上开 ENABLE_KITTY_KEYBOARD。
     *
     * 同一个仓库已经为**同一件事**双写过两次(logPaneAction 的 `c === 'g' && key.shift`、
     * ScrollKeybindingHandler 同款)。
     */
    const log: string[] = []
    const { t, app } = await mount(
      <TaskTreePanel
        nodes={TREE()} runId="003" interactive
        onRedo={() => log.push('redo')}
        onRedoFailed={n => log.push(`redoFailed:${n.id}`)}
        onExitKey={() => {}}
      />,
    )
    t.stdin.press(DOWN); await tick()
    // kitty 协议的 Shift+R。这个序列由仓库自己的 parse-keypress 解析,不是我手写的假事件。
    t.stdin.press('\u001b[82;2u'); await tick()
    app.unmount()
    expect(log).toEqual(['redoFailed:root/00-a'])
  })

  it('出口键排在这一行最前面 —— 光标移到失败节点上不许把它挤掉', async () => {
    /**
     * 评审用真渲染量到:出口原来排在**末尾**,于是 100 列时光标从一个正常节点移到失败节点,
     * `R`/`s` 两句话一进来 `Esc/q 退出` 当场消失 —— 移一下光标就把出口弄丢了。
     * 运行中那一截(p/i/x)更糟:60~126 列上一律没有出口。
     */
    for (const cols of [60, 80, 100, 120]) {
      const { t, app } = await mount(
        <TaskTreePanel
          nodes={TREE()} runId="003" interactive
          onRedo={() => {}} onRedoFailed={() => {}} onSkipFailed={() => {}}
          runControl={{
            paused: false, onTogglePause: () => {}, onAddDirective: () => {},
            onCancelNode: () => {}, onAdjustParallelism: () => {},
          }}
          onExitKey={() => {}}
        />,
        cols,
      )
      t.stdin.press(DOWN); await tick()   // 停在失败节点上(最挤的那一种情形)
      const f = t.lastFrame()
      app.unmount()
      expect(`${cols} 列有出口: ${f.includes('Esc/q 退出')}`).toBe(`${cols} 列有出口: true`)
    }
  })

  it('错误屏上回车**什么都不做** —— 页脚只写了「q / Esc 返回」', async () => {
    /**
     * 评审实按:屏上是「没有失败(当前 ACCEPTED),没有环节可跳」+「q / Esc 返回」,
     * 而按回车真的触发了 onConfirm。`runSkip` 会二次校验所以不毁数据,但屏幕刚说这件事
     * 做不到,回车就做了 —— 而回车是最容易误按的那个键。
     */
    let confirms = 0
    let cancels = 0
    const done = [mk('x', { status: 'ACCEPTED' })]
    const { t, app } = await mount(
      <ConfirmSkip
        nodes={done} targetId="x" now={NOW}
        onConfirm={() => { confirms++ }} onCancel={() => { cancels++ }}
      />,
    )
    expect(t.lastFrame()).toContain('没有失败')
    t.stdin.press('\r'); await tick()
    t.stdin.press('y'); await tick()
    t.stdin.press('e'); await tick()
    expect([confirms, cancels]).toEqual([0, 0])
    // 出口照旧管用。
    t.stdin.press('q'); await tick()
    app.unmount()
    expect([confirms, cancels]).toEqual([0, 1])
  })

  it('重做关口的「节点不存在」屏同理:回车不许开跑', async () => {
    // `initialEntry` 预置了 picked,于是 redoGateAction 在那一支会把回车当确认 ——
    // 屏幕说「节点不存在: nope」,回车却把 onConfirm('execute') 发了出去。
    const seen: unknown[] = []
    let cancels = 0
    const { t, app } = await mount(
      <ConfirmRedo
        nodes={TREE()} targetId="nope" now={NOW} initialEntry="execute"
        onConfirm={(e, g) => seen.push([e, g])} onCancel={() => { cancels++ }}
      />,
    )
    expect(t.lastFrame()).toContain('节点不存在')
    t.stdin.press('\r'); await tick()
    t.stdin.press('y'); await tick()
    expect(seen).toEqual([])
    t.stdin.press('q'); await tick()
    app.unmount()
    expect(cancels).toBe(1)
  })

  it('再按一次 e 是**接着改**,不是从空开始', async () => {
    // 页脚在写过一次之后写的是「e 改写补充指引」,而输入框原来每次挂载都从空开始:
    // 想改一个错字的人只补了半句,原句就被替换掉了。
    const seen: unknown[] = []
    const { t, app } = await mount(
      <ConfirmSkip nodes={TREE()} targetId="root/00-a" now={NOW} onConfirm={g => seen.push(g)} onCancel={() => {}} />,
    )
    t.stdin.press('e'); await tick()
    for (const ch of ['甲', '乙']) { t.stdin.press(ch); await tick() }
    t.stdin.press('\r'); await tick()
    expect(t.lastFrame()).toContain('改写补充指引')
    t.stdin.press('e'); await tick()
    // 原文还在屏幕上 —— 而不是一个空输入框。
    expect(t.lastFrame()).toContain('甲乙')
    t.stdin.press('丙'); await tick()
    t.stdin.press('\r'); await tick()
    t.stdin.press('\r'); await tick()
    app.unmount()
    expect(seen).toEqual([{ scope: 'all', text: '甲乙丙' }])
  })
})
