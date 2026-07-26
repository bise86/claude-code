/**
 * Mounts through the VENDORED renderer (src/ink.ts), not npm ink.
 *
 * This exists because of a real bug: these components originally imported `ink` directly.
 * Rendering looked perfect — both renderers emit identical frames — but `useInput`
 * subscribed to npm ink's StdinContext, which this app never mounts, so every key handler
 * was dead: the confirm gate could not be answered OR cancelled, and because
 * useCancelRequest disables Esc/Ctrl+C while a local-jsx dialog is up, the session wedged.
 * A test that renders with the wrong renderer cannot see this, so this one must always use
 * the app's own `render`.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { DEFAULT_CAPS, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from '../../tools/efftask/types.js'

const config: EffTaskConfig = {
  goalPrompt: '把 README 翻译成英文',
  parallelism: 3,
  phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'arch' }] } as Record<PhaseName, RoleBinding[]>,
  caps: { ...DEFAULT_CAPS },
  notices: [],
}

function fakeTty() {
  // The vendored renderer subscribes to 'readable' and pulls with read() — NOT 'data'.
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    read: () => { const v = pending; pending = null; return v },
    setEncoding() {},
    unref() {},
    ref() {},
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  // The renderer positions text with cursor-move escapes rather than spaces, so raw frames
  // read as "把[1CREADME". Strip control sequences before asserting on content.
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ')
  return { stdin, stdout, lastFrame: plain }
}

describe('ConfirmStartup (vendored renderer)', () => {
  it('renders the roster and answers real keypresses', async () => {
    const decisions: Array<{ approved: boolean }> = []
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmStartup, { config, onDecision: d => decisions.push(d) }),
      // biome-ignore lint/suspicious/noExplicitAny: fake TTY streams for a headless render
      { stdin: stdin as any, stdout: stdout as any, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))

    const frame = lastFrame()
    expect(frame).toContain('高效任务模式')
    expect(frame).toContain('翻译成英文') // the goal, via the shared goalLine()
    expect(frame).toContain('arch') // the REAL roster, not a placeholder
    expect(frame).toContain('主模型') // phases with no binding fall back to the main model

    // A key must actually reach useInput. If these components ever import npm ink again,
    // this stays empty and the gate becomes unanswerable in the real REPL.
    stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    // The decision now carries the roster too (spec §2 第一关 "名册可编辑后确认"); an
    // unedited gate sends back exactly what it was given.
    expect(decisions[0]).toMatchObject({ parallelism: 3, approved: true })
    expect(decisions[0].phaseRoles).toBeDefined()

    stdin.press('n')
    await new Promise(r => setTimeout(r, 20))
    // A CANCEL carries no roster — there is nothing to apply.
    expect(decisions[1]).toEqual({ parallelism: 3, approved: false })

    app.unmount()
  })
})

describe('启动关口的角色名册真的能改 (spec §2 第一关)', () => {
  const cfg2 = () => ({
    goalPrompt: '打通登录接口', parallelism: 3, notices: [], mainModel: 'claude-opus-5',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600000 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  })
  const mount2 = async (over: Record<string, unknown> = {}) => {
    const { stdin, stdout, lastFrame } = fakeTty()
    const decisions: { parallelism: number; approved: boolean; phaseRoles?: Record<string, { roleName: string }[]> }[] = []
    const app = await render(
      React.createElement(ConfirmStartup as never, {
        config: cfg2(), availableRoles: ['architect', 'security', 'qa'],
        onDecision: (d: never) => decisions.push(d), ...over,
      } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    return { stdin, lastFrame, decisions, app }
  }
  const press = async (m: { stdin: { press: (s: string) => void } }, s: string) => {
    m.stdin.press(s); await new Promise(r => setTimeout(r, 20))
  }
  const DOWN2 = String.fromCharCode(27) + '[B'
  const RIGHT2 = String.fromCharCode(27) + '[C'

  it('r 打开编辑器,空格把角色加到当前阶段,回车带着新名册确认', async () => {
    // spec §2: "名册可编辑后确认". It was rendered read-only, so a user who wanted a
    // different panel had to cancel, reword the prompt and start the whole thing over.
    const m = await mount2()
    await press(m, 'r')
    expect(m.lastFrame()).toContain('编辑中')
    await press(m, DOWN2)     // plan → review
    await press(m, RIGHT2)    // architect → security
    await press(m, ' ')       // bind it
    await press(m, '\r')
    expect(m.decisions).toHaveLength(1)
    expect(m.decisions[0].approved).toBe(true)
    expect(m.decisions[0].phaseRoles?.review.map(r => r.roleName)).toEqual(['security'])
    m.app.unmount()
  })

  it('编辑器里的 Esc 只退出编辑,不取消整个 run', async () => {
    // Cancelling from inside an editor the user just opened would lose the edits AND the gate
    // in one keystroke.
    const m = await mount2()
    await press(m, 'r')
    await press(m, ' ')       // bind architect to plan
    await press(m, String.fromCharCode(27))
    await new Promise(r => setTimeout(r, 250))
    expect(m.decisions).toEqual([])           // NOT cancelled
    await press(m, '\r')
    expect(m.decisions[0].phaseRoles?.plan.map(r => r.roleName)).toEqual(['architect']) // edit kept
    m.app.unmount()
  })

  it('名册显示的是编辑后的样子,不是传进来的那份', async () => {
    // A gate that shows one panel and starts another is the failure this gate exists to prevent.
    const m = await mount2()
    await press(m, 'r')
    await press(m, ' ')
    await press(m, String.fromCharCode(27))
    await new Promise(r => setTimeout(r, 250))
    // A DISCRIMINATING substring. Plain 'architect' is printed by the EDITOR too (it lists
    // every candidate), and the frame buffer accumulates — so that assertion passed whether
    // or not the read-only roster reflected the edit. Only rosterLines produces this shape.
    expect(m.lastFrame()).toContain('方案: architect')
    m.app.unmount()
  })

  it('没有可用角色时说明原因,而不是画一张空表', async () => {
    const m = await mount2({ availableRoles: [] })
    await press(m, 'r')
    expect(m.lastFrame()).toContain('没有可用角色')
    // …and it must still be answerable.
    await press(m, '\r')
    expect(m.decisions[0].approved).toBe(true)
    m.app.unmount()
  })

  it('不编辑时,←/→ 仍然调并行数', async () => {
    const m = await mount2()
    await press(m, RIGHT2)
    await press(m, '\r')
    expect(m.decisions[0].parallelism).toBe(4)
    m.app.unmount()
  })
})

describe('一次 chunk 里到达多个键(按住方向键、ssh/tmux 合并输入)', () => {
  const cfg3 = () => ({
    goalPrompt: 'g', parallelism: 3, notices: [], mainModel: 'claude-opus-5',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600000 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  })
  const mount3 = async () => {
    const { stdin, stdout, lastFrame } = fakeTty()
    const decisions: { parallelism: number; approved: boolean; phaseRoles?: Record<string, { roleName: string }[]> }[] = []
    const app = await render(
      React.createElement(ConfirmStartup as never, {
        config: cfg3(), availableRoles: ['architect', 'security', 'qa'],
        onDecision: (d: never) => decisions.push(d),
      } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    return { stdin, lastFrame, decisions, app }
  }
  const ESC3 = String.fromCharCode(27)

  it('↓ 和 空格 一起到达时,角色绑到光标所在的阶段', async () => {
    // The renderer splits one stdin chunk into several InputEvents and dispatches them
    // SYNCHRONOUSLY, while useInput only swaps its handler in a post-commit layout effect —
    // so the second key ran the previous render's closure. Measured: the role landed on 方案
    // while ▶ was rendered on 评审, and the read-only roster then showed the wrong panel,
    // which the user confirmed.
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[B ')       // ↓ and space in ONE chunk
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.review.map(r => r.roleName)).toEqual(['architect'])
    expect(m.decisions[0].phaseRoles?.plan).toEqual([])
    m.app.unmount()
  })

  it('↓↓ 和 空格 一起到达时也一样', async () => {
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[B' + ESC3 + '[B ')
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.execute.map(r => r.roleName)).toEqual(['architect'])
    m.app.unmount()
  })

  it('→ 和 空格 一起到达时,绑的是光标所在的角色', async () => {
    const m = await mount3()
    m.stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    m.stdin.press(ESC3 + '[C ')
    await new Promise(r => setTimeout(r, 30))
    m.stdin.press('\r')
    await new Promise(r => setTimeout(r, 20))
    expect(m.decisions[0].phaseRoles?.plan.map(r => r.roleName)).toEqual(['security'])
    m.app.unmount()
  })

  it('→ 和 回车 一起到达时,确认的是屏幕上那个并行数', async () => {
    // Same class, and it predates the roster editor: onDecision read `parallelism` from the
    // closure, so the screen said 4 and the decision carried 3.
    const m = await mount3()
    m.stdin.press(ESC3 + '[C\r')
    await new Promise(r => setTimeout(r, 30))
    expect(m.decisions[0].parallelism).toBe(4)
    m.app.unmount()
  })
})


describe('编辑器的提示行不能列出死键', () => {
  it('没有可用角色时,不再宣传 ←/→ 和空格', async () => {
    // available.length > 0 gates those three keys, but the hint line was unconditional — it
    // advertised three keys that do nothing, on the one screen where nothing can be edited.
    const { stdin, stdout, lastFrame } = fakeTty()
    const app = await render(
      React.createElement(ConfirmStartup as never, {
        config: {
          goalPrompt: 'g', parallelism: 3, notices: [], mainModel: 'm',
          caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
          phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
        },
        availableRoles: [], onDecision: () => {},
      } as never),
      { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    stdin.press('r')
    await new Promise(r => setTimeout(r, 20))
    const f = lastFrame()
    expect(f).toContain('没有可用角色,无法编辑')
    expect(f).not.toContain('空格 增删')
    app.unmount()
  })
})

describe('spec §8:隔离不可用时,关口把它呈现成一个选择', () => {
  const mountIso = async (props: Record<string, unknown>) => {
    const t = fakeTty()
    const app = await render(
      React.createElement(ConfirmStartup as never, { config, onDecision: () => {}, ...props } as never),
      { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
    )
    await new Promise(r => setTimeout(r, 20))
    return { ...t, app }
  }

  it('单独成块,不再混在"你的请求不会生效"里', async () => {
    // 那个标题讲的是提示词里的指令没生效;而这里变的是整个 run 的执行方式。把后者塞进前者,
    // 就是让一次用户从没选择过的降级读起来像一条解析脚注。
    const { lastFrame, app } = await mountIso({ isolation: 'none', isolationReason: '当前目录不是 git 仓库' })
    const f = lastFrame()
    expect(f).toContain('隔离并行不可用')
    expect(f).toContain('当前目录不是 git 仓库')
    expect(f).toContain('串行')
    app.unmount()
  })

  it('隔离正常时整块都不出现', async () => {
    const { lastFrame, app } = await mountIso({ isolation: 'worktree' })
    expect(lastFrame()).not.toContain('隔离并行不可用')
    app.unmount()
  })

  it('给了 onInitGit 才提 g 键,按下去才真的触发', async () => {
    let fired = 0
    const { stdin, lastFrame, app } = await mountIso({
      isolation: 'none', isolationReason: '当前目录不是 git 仓库', onInitGit: () => { fired++ },
    })
    expect(lastFrame()).toContain('g 初始化 git')
    stdin.press('g'); await new Promise(r => setTimeout(r, 20))
    expect(fired).toBe(1)
    app.unmount()
  })

  it('没给 onInitGit 就不宣传 g,按下去也不能有副作用', async () => {
    const { stdin, lastFrame, app } = await mountIso({ isolation: 'none', isolationReason: 'r' })
    expect(lastFrame()).not.toContain('g 初始化 git')
    stdin.press('g'); await new Promise(r => setTimeout(r, 20))
    expect(lastFrame()).toContain('隔离并行不可用') // 还在关口上,没被当成别的键吞掉
    app.unmount()
  })

  it('隔离正常时 g 不是活键 —— 免得误触在一个好好的仓库里跑 git init', async () => {
    let fired = 0
    const { stdin, app } = await mountIso({ isolation: 'worktree', onInitGit: () => { fired++ } })
    stdin.press('g'); await new Promise(r => setTimeout(r, 20))
    expect(fired).toBe(0)
    app.unmount()
  })
})


describe('启动关口:每一种改动都要通知调用方', () => {
  // 三个通知点全部要守住。我上一轮以为右方向键和名册切换本来就有覆盖 —— 那是假的:
  // 这个文件里 onEdited 只出现在这一条测试里,把那两处的 props.onEdited?.() 删掉全套照样
  // 绿(验收评审的变异矩阵证实)。后果和这条 fix 本身要修的一模一样:改完之后被飞书抢跑,
  // 不会有那句"你在终端里未提交的修改没有生效"。
  const E = String.fromCharCode(27)
  it('每一个改动入口都要通知', async () => {
    for (const keys of [[E + '[D'], ['-'], [E + '[C'], ['+'], ['r', ' ']]) {
      let edited = 0
      const t = fakeTty()
      const app = await render(
        React.createElement(ConfirmStartup as never, {
          config, availableRoles: ['architect'], onEdited: () => { edited++ }, onDecision: () => {},
        } as never),
        { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
      )
      await new Promise(r => setTimeout(r, 20))
      for (const k of keys) {
        t.stdin.press(k)
        await new Promise(r => setTimeout(r, 20))
      }
      expect(edited).toBeGreaterThan(0)
      app.unmount()
    }
  })
})
