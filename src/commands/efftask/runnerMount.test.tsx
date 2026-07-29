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

/**
 * 假的子 agent。抽取那一次调用是**真的模型调用**,不接管它的话这个文件永远测不到
 * 「窗口里有没有东西」—— 而用户的抱怨正是第一屏什么都看不见。
 */
const realRunAgent = await import('../../tools/AgentTool/runAgent.js')
mock.module('../../tools/AgentTool/runAgent.js', () => ({
  ...realRunAgent,
  async *runAgent() {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } }
    yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '读到了' }] } }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "```json\n{}\n```" }] } }
  },
}))

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
/**
 * 再把空格也去掉。带边框的 Box 里那一行渲出来是 `q/Esc退出·回车看节点详情·r重做选中的任务` ——
 * 词之间的空格没了(实测)。按源码里的写法带空格去匹配,断言会恒假,而恒假的断言
 * 在这个文件里正是要防的东西。
 */
const squash = (s: string) => strip(s).replace(/[ \t]/g, '')

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

/**
 * 这一帧里有没有「渲染抛了」。
 *
 * **原来那个谓词是假的。** 它写的是 `/ReferenceError|is not defined|at EffTaskRunner/`,
 * 而 ink 的错误框根本不印这些字。实测(拿一个引用未导入标识符的组件真挂进本仓库的
 * ink,120×40 假 TTY):
 *
 *     ERRORPHASE_NAMES_NOT_IMPORTEDisnotdefined
 *     /path/to/file.tsx:21:79
 *     - Boom(/path/to/file.tsx:21:79)
 *     - react_stack_bottom_frame(node_modules/react-reconciler/…)
 *
 * 前缀是 `ERROR` 不是 `ReferenceError`;列式排版把词之间的空格全吃掉,所以
 * `is not defined` 匹配不到(帧里是 `isnotdefined`);栈行是 `- Boom(` 不是 `at Boom`。
 * 三个分支**一个都命中不了** —— 这条「整命令的存活闸门」在真崩溃上返回 false。
 *
 * 而它本该拦住的正是 `phase === 'confirmRedo'` 那一屏里没导入的 `PHASE_NAMES`:
 * 按下 r 就是一屏堆栈,而 2189 条测试全绿。
 *
 * 现在用两个**互相独立**的信号:错误框的标题,和它下面那行源码定位。
 */
function renderCrashed(frame: string): boolean {
  const f = frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  return /ERROR/.test(f) && /\.tsx?:\d+:\d+/.test(f)
}

describe('/et 真的能挂起来(整命令的存活闸门)', () => {
  it('挂载不抛异常 —— 裸 effRoot 那类错误在这里现形', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {})
    const f = tty.frames()
    expect(`渲染出错: ${renderCrashed(f)}`).toBe('渲染出错: false')
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

describe('第一屏就要看得见模型在干什么', () => {
  it('解析需求那一屏挂着实时窗口,并且在数秒数', async () => {
    // 用户实测:第一关/第二关看不到任何子 TUI 终端。这一屏背后是一次**真实的模型调用**
    // (parseDirectives 的抽取),此前它是一屏静止的「正在解析需求…」——分不出在读代码
    // 还是卡死了。窗口靠 useStreamTick 重绘,秒数靠自己的 1s 心跳(事件驱动的重绘在
    // 静默期不触发,而这一屏的常态就是静默)。
    const { tty, app } = await mount('把 README 翻译成英文', {})
    await tick(10)
    const f = strip(tty.frames())
    expect(`这一屏在数秒数: ${/已等待\s*\d+s/.test(f)}`).toBe('这一屏在数秒数: true')
    // 而且窗口里真的有东西 —— 「屏在」和「窗口里有内容」是两件事,只测前者会漏掉
    // 「挂上去了但它是死的」那一类(这个文件的存在理由就是这类)。
    // 「屏在」和「窗口里有东西」是两件事,只测前者会漏掉「挂上去了但它是死的」——
    // 这个文件的存在理由就是这一类。断言窗口的表头真的画出来了,而且数到了工具调用。
    expect(`窗口出现了: ${f.includes('需求解析')}`).toBe('窗口出现了: true')
    expect(`窗口数到了工具调用: ${/\d+\s*工具/.test(f)}`).toBe('窗口数到了工具调用: true')
    app.unmount()
  })
})

/**
 * 重做关口能不能**画出来**。
 *
 * 这一屏此前从没被挂载过:`redoGate.test.ts` 测 `redoGateAction`、`redoView.test.tsx`
 * 直接挂 `ConfirmRedo`,两边都不经过 `EffTaskRunner`;而 `wiringCoverage.test.ts` 守这一跳
 * 用的是**源码文本**断言(它的注释自己写着「这一跳没有运行时接缝」)。
 *
 * 于是 `efftask.tsx` 里那一句用了没导入的 `PHASE_NAMES` 时:2189 条全绿,而用户按下 r
 * 拿到的是一屏 ReferenceError —— 重做这个功能**从任何路径都到不了**,连 `--resume`
 * 回来再按也是同一屏。
 *
 * 断言是**正向**的(帧里出现菜单那句话),不是「帧里没有堆栈」:后者被上面那个
 * renderCrashed 的教训证明过太容易写成一句永远为真的话。
 */
describe('重做关口:从 done 屏按 r 真的能画出来', () => {
  it('按 r 出现的是重做菜单,不是一屏堆栈', async () => {
    // 跳过分析 → 节点直接 READY → 执行者(假的)报不出产出 → 撞返工上限 → 阻断 → done。
    const { tty, app } = await mount('把 README 翻译成英文', { efftaskSkipSteps: ['分析'] })
    await tick(12)
    tty.stdin.press('y')
    // 阻断要跑满 maxIterations 轮评审,给足时间落到 done 视图。
    for (let i = 0; i < 80 && !squash(tty.frames()).includes('r重做选中的任务'); i++) await tick(10)
    expect(`到了 done 屏: ${squash(tty.frames()).includes('r重做选中的任务')}`).toBe('到了 done 屏: true')

    tty.stdin.press('r')
    await tick(20)
    const f = squash(tty.frames())
    app.unmount()
    expect(`按 r 之后渲染出错: ${renderCrashed(tty.frames())}`).toBe('按 r 之后渲染出错: false')
    // 菜单第一屏那两条。**正向**断言 —— 不画出来就红。
    expect(`菜单出现了: ${f.includes('任务重做') && f.includes('阶段重做')}`).toBe('菜单出现了: true')
  })
})

/**
 * 员工配置写错时,原因**到得了屏幕**。
 *
 * 此前唯一的出口是 `console.error`,而实测 ink 的 `patchConsole` 把 warn/error/trace
 * 全部改写成 `logError` —— 只进 debug 日志文件。也就是说 `rolesFromSettings.ts` 里那三处
 * 「must be visible without --debug」的注释本身就是假话:交互式会话里屏幕上一个字都没有。
 *
 * 用户能观察到的现象是「这个员工不存在」,而他分不清是自己打错了字,还是这个功能没做 ——
 * 需求二要加一个新协议名,不修这条的话,新协议上线之后这个歧义只会更常见。
 */
describe('员工配置写错 → 原因到得了启动关口', () => {
  it('协议名少写一个字母时,关口说出来,而不是让员工凭空消失', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {
      roles: [{
        name: 'gpt5', whenToUse: '架构', execMode: 'api',
        apiProtocol: 'openai-response',   // 少一个 s
        apiUrl: 'https://x.example/v1', apiToken: 'sk', model: 'gpt-5.1',
      }],
    })
    await tick(12)
    const f = squash(tty.frames())
    app.unmount()
    expect(`关口提到了这个员工: ${f.includes('gpt5')}`).toBe('关口提到了这个员工: true')
    expect(`说清了没被载入: ${f.includes('没有被载入')}`).toBe('说清了没被载入: true')
  })

  it('思考级别写错时也说,并且列出可用值', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {
      roles: [{
        name: 'ds', whenToUse: '测试', execMode: 'api', apiProtocol: 'openai',
        apiUrl: 'https://x.example/v1', apiToken: 'sk', model: 'deepseek-chat',
        thinkingDepth: 'deep',
      }],
    })
    await tick(12)
    const f = squash(tty.frames())
    app.unmount()
    expect(`说了无法识别: ${f.includes('无法识别')}`).toBe('说了无法识别: true')
    expect(`列出了可用值: ${f.includes('xhigh')}`).toBe('列出了可用值: true')
  })

  it('配置全对时关口不无中生有 —— 排除「这句话恒显示」', async () => {
    const { tty, app } = await mount('把 README 翻译成英文', {
      roles: [{
        name: 'ok', whenToUse: '架构', execMode: 'api', apiProtocol: 'openai-responses',
        apiUrl: 'https://x.example/v1', apiToken: 'sk', model: 'gpt-5.1', thinkingDepth: 'xhigh',
      }],
    })
    await tick(12)
    const f = squash(tty.frames())
    app.unmount()
    expect(`误报: ${f.includes('没有被载入') || f.includes('无法识别')}`).toBe('误报: false')
  })
})
