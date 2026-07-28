/**
 * 把 `/et` 真的挂起来跑一遍。
 *
 * 这个文件是三条 P0 逼出来的,它们的共同点是**全量测试 1384 条全绿**:
 *
 * 1. `efftask.tsx` 的依赖数组里写了裸 `effRoot`(那个绑定只在 `call()` 作用域里),
 *    依赖数组每次 render 都求值 —— 于是 `/et` 输入任何内容都只得到一屏 ReferenceError
 *    堆栈,一次模型调用都没有。**整个命令是坏的**,而没有一条测试挂载过它。
 * 2. `collectSkipSteps` 写好了、六条单测全绿、两份文档都把它写成录入口之一,而它在生产上
 *    零调用点。断言「源码里有 efftaskSkipSteps 这个字符串」照样绿。
 * 3. 跳过分析那条早退绕开了 `startRun`,`runOrchestrator` 因此永远不被调用,界面停在
 *    「✓0 ◐0 ○0 ✗0」不动。钉源码字符串的闸门反而把 bug 钉死了 —— 改对它会变红。
 *
 * 三条都只有一种测法:**挂载真组件,喂真配置,看真输出**。所以这里不 import 任何被测
 * 内部函数,只从用户那一侧看:settings 里写了什么 → 关口上显示了什么 → 编排器有没有被调。
 */
import { afterAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 假 settings:两条录入口里的「配置文件」那条。
 *
 * 必须 `...real` 展开后再覆盖一个导出 —— 整份替换会让这个模块的其它导出
 * (getInitialSettings 等)对所有 importer 消失,测试还没跑就先崩。
 */
const realSettings = await import('../../utils/settings/settings.js')
let FAKE_SETTINGS: Record<string, unknown> = {}
mock.module('../../utils/settings/settings.js', () => ({
  ...realSettings,
  getSettingsForSource: (src: string) => (src === 'userSettings' ? FAKE_SETTINGS : undefined),
}))

/**
 * cwd 挪到临时目录。
 *
 * 不挪的话这个文件每跑一次就在**用户的仓库里**真的建一个 run 目录、一条
 * efftask/NNN/integration 分支和一个 git worktree —— 实测跑几轮就攒到 046。
 * 测试可以真跑,但不能在别人家里留东西。
 */
const realCwd = await import('../../utils/cwd.js')
const TMP = mkdtempSync(join(tmpdir(), 'et-mount-'))
mock.module('../../utils/cwd.js', () => ({ ...realCwd, getCwd: () => TMP }))

const { render } = await import('../../ink.js')
const { call } = await import('./efftask.js')
const { AppStateProvider } = await import('../../state/AppState.js')
const { applyStartupDecision } = await import('../../tools/efftask/startupConfirm.js')
const { DEFAULT_CAPS, emptyPhaseRoles } = await import('../../tools/efftask/types.js')
const baseConfig = { goalPrompt: 'g', parallelism: 3, notices: [], caps: { ...DEFAULT_CAPS }, phaseRoles: emptyPhaseRoles() }

function fakeTty() {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {},
    read: () => { const v = pending; pending = null; return v },
    setEncoding() {}, unref() {}, ref() {},
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let out = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 120, rows: 40,
    write(s: string) { out += s },
  })
  return { stdin, stdout, frames: () => out }
}

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
/** 去掉 ANSI,否则渲染出来的中文之间夹着控制序列,任何 includes 都是碰运气。 */
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

async function mount(args: string, settings: Record<string, unknown>, tools: { name: string }[] = []) {
  FAKE_SETTINGS = settings
  const tty = fakeTty()
  const done: string[] = []
  const node = await call(
    (msg: string) => { done.push(msg) },
    {
      options: {
        isNonInteractiveSession: false,
        mainLoopModel: 'main',
        // 抽取模型:这一层只回默认,让「配置文件那条录入口」单独可见。
        tools,
      },
      abortController: new AbortController(),
    } as never,
    args,
  )
  if (node === null) return { tty, done, node: null, instance: null }
  // 必须裹 AppStateProvider:组件在 :540 调 useAppStore,没有 provider 就抛。
  const app = await render(
    React.createElement(AppStateProvider, null, node as React.ReactElement),
    { stdin: tty.stdin as never, stdout: tty.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { tty, done, node, app }
}

describe('/et 真的能挂起来(整命令的存活闸门)', () => {
  it('挂载不抛异常 —— 裸 effRoot 那类错误在这里现形', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {})
    const f = tty.frames()
    // ReferenceError 会被 React 冒泡成一屏堆栈。断言「没有堆栈」而不是「有某句话」:
    // 前者对渲染内容的变化免疫,只对「组件挂不起来」敏感。
    expect(`渲染出错: ${/ReferenceError|is not defined|at EffTaskRunner/.test(f)}`).toBe('渲染出错: false')
    expect(f.length).toBeGreaterThan(0)
    app.unmount()
  })

  it('settings.json 的 efftaskSkipSteps 一路走到关口上', async () => {
    // 这条走的是完整链路:settings → collectSkipSteps → baseSkipSteps prop → cfg.skipSteps
    // → rosterLines。链路上任何一环断掉(包括「函数写好了但没人调」)这里都会红。
    const { tty, app } = await mount('把 README 翻译成英文', { efftaskSkipSteps: ['质疑讨论'] })
    await tick(10)
    const f = tty.frames()
    // 关口说的是**后果**,不是「已跳过」——所以断言后果那句话。
    expect(`关口显示跳过后果: ${f.includes('方案没人质疑就进执行')}`).toBe('关口显示跳过后果: true')
    app.unmount()
  })

  it('没配 efftaskSkipSteps 时关口不说跳过 —— 排除「这句话恒显示」', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {})
    await tick(10)
    const f = tty.frames()
    expect(`误报跳过: ${f.includes('方案没人质疑就进执行')}`).toBe('误报跳过: false')
    app.unmount()
  })

  it('配置文件里环节名写错 → 诊断到得了关口', async () => {
    // notices 此前完全没人接:写错一个字,关口一言不发,那一步照跑照收费。
    const { tty, app } = await mount('把 README 翻译成英文', { efftaskSkipSteps: ['测试'] })
    await tick(10)
    expect(`诊断可见: ${/是不是想写/.test(tty.frames())}`).toBe('诊断可见: true')
    app.unmount()
  })
})

describe('跳过分析:run 必须真的启动', () => {
  it('批准关口后 runOrchestrator 被调用,且带着 skipSteps', async () => {
    // 这条是 §2 的唯一可观测点。runOrchestrator 在 efftask.tsx 里只有 startRun 一个调用点;
    // 早退里写 setPhase('running') 只是把界面翻到运行视图,编排器一次都不会被调 ——
    // 用户看到「run 004 ✓0 ◐0 ○0 ✗0」永远不动,没有节点、没有报错、也不退出。
    const { tty, app } = await mount('把 README 翻译成英文', { efftaskSkipSteps: ['分析'] })
    await tick(12)
    expect(`关口出现了: ${tty.frames().includes('高效任务模式')}`).toBe('关口出现了: true')
    tty.stdin.press('y')
    await tick(40)
    const f = strip(tty.frames())
    // 编排器跑起来的证据 = 任务树上真的出现了一个节点。setPhase('running') 那个 bug 下
    // 界面是「✓0 ◐0 ○0 ✗0」且一行节点都没有 —— 计数全 0 正是它的指纹。
    // 状态字形和标题之间多了一个类型标记(⊞ 拆分 / ▪ 执行 / · 待定)。
    expect(`任务树上有节点: ${/[◐✓✗○]\s*[⊞▪·]\s*把 README 翻译成英文/.test(f)}`).toBe('任务树上有节点: true')
    expect(`停在空树: ${/✓0◐0○0✗0/.test(f)}`).toBe('停在空树: false')
    app.unmount()
  })
})

afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

describe('飞书批准不能被当成「清空跳过」', () => {
  it('payload 里没有 skipSteps 时,config 里的跳过原样保留', async () => {
    // applyStartupDecision 的 `?? config.skipSteps` 语义是「缺省 = 不变」。写成 `?? []`
    // 的话,从飞书批准会静默取消用户在 settings.json 里配的全部跳过 —— 而卡片上根本
    // 没有这个开关,他也无从知道自己按了什么。
    const applied = applyStartupDecision(
      { ...baseConfig, skipSteps: ['review'] } as never,
      { parallelism: 3, approved: true } as never,   // 飞书卡的 payload 形状
    )
    expect(applied.skipSteps).toEqual(['review'])
  })
})

describe('MCP 工具要一路走到关口上', () => {
  it('会话里有 mcp__* 时,关口说清它们在所有环节可用、以及挡不住什么', async () => {
    // 这条钉的是**接线**:mcpNoticeLines 写对了、单测全绿,但如果 efftask.tsx 不把
    // context.options.tools 里的 mcp__* 传给关口,用户什么都看不到 —— 而这正是
    // collectSkipSteps 死掉整整一版的同一个形状。
    const { tty, app } = await mount('把 README 翻译成英文', {}, [
      { name: 'Read' }, { name: 'mcp__docs__search' },
    ])
    await tick(10)
    const f = strip(tty.frames())
    expect(`关口列出了 MCP: ${f.includes('mcp__docs__search')}`).toBe('关口列出了 MCP: true')
    expect(`关口说了挡不住: ${f.includes('挡不住')}`).toBe('关口说了挡不住: true')
    app.unmount()
  })

  it('会话里没有 MCP 时,关口不提这件事', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {}, [{ name: 'Read' }])
    await tick(10)
    expect(`误报 MCP: ${strip(tty.frames()).includes('MCP工具:')}`).toBe('误报 MCP: false')
    app.unmount()
  })
})
