/**
 * Mounts through the VENDORED renderer (src/ink.ts), not npm ink: useInput only subscribes
 * to the app's own StdinContext, so a gate that paints perfectly and ignores every key is
 * indistinguishable on screen from a working one — and this gate's whole value is that the
 * user can act on it.
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ConfirmRootPlan, block, type RootPlanDecision } from './ConfirmRootPlan.js'
import type { RootDraft } from '../../tools/efftask/rootPlan.js'
import { emptyPlan } from '../../tools/efftask/types.js'

const ESC = String.fromCharCode(27)
const CR = '\r'
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 12))
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
    isTTY: true, columns: 160, rows: 60,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ').replace(//g, '')
  return { stdin, stdout, lastFrame: plain, reset: () => { frame = '' } }
}

const draft = (over: Partial<RootDraft> = {}): RootDraft => ({
  kind: 'decompose',
  plan: { solution: '分三步走', keyPoints: '注意幂等', risks: '可能与结算冲突', acceptance: '有集成测试' },
  children: [{ title: '设计接口', deps: [] }, { title: '实现服务', deps: ['设计接口'] }],
  ...over,
})

async function mount(over: Record<string, unknown> = {}) {
  const t = fakeTty()
  const decisions: RootPlanDecision[] = []
  const app = await render(
    React.createElement(ConfirmRootPlan, {
      goalPrompt: '做一个支付回调',
      draft: draft(),
      onDecision: (d: RootPlanDecision) => decisions.push(d),
      ...over,
    } as never),
    { stdin: t.stdin as never, stdout: t.stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await tick()
  return { ...t, app, decisions }
}

describe('根方案确认关口 · 渲染', () => {
  it('shows the plan AND the first-level tree the user is approving', async () => {
    const m = await mount()
    const f = m.lastFrame()
    expect(f).toContain('做一个支付回调')
    expect(f).toContain('分三步走')
    expect(f).toContain('注意幂等')
    expect(f).toContain('可能与结算冲突')
    expect(f).toContain('有集成测试')
    expect(f).toContain('设计接口')
    expect(f).toContain('实现服务')
    m.app.unmount()
  })

  it('does not imply the plan is final — it still faces the roundtable', async () => {
    // A gate that reads as "this is what will be built" would misdescribe the process: the
    // confirmed plan goes to PLAN_REVIEW and can be sent back for revision.
    const m = await mount({ reviewRoles: 3 })
    expect(m.lastFrame()).toContain('3 位角色圆桌评审')
    m.app.unmount()
  })

  it('does NOT promise a panel that will not convene', async () => {
    // runRoundtable turns an empty roster into ONE main-model reviewer. Saying 多角色圆桌评审
    // there invites the user to wave through a plan they did not read, believing a panel will
    // catch it.
    const m = await mount({ reviewRoles: 0 })
    const f = m.lastFrame()
    expect(f).toContain('一位评审角色(未配置多角色评审)')
    expect(f).not.toContain('多角色圆桌评审')
    m.app.unmount()
  })

  it('a failed draft does not claim the run decided NOT to decompose', async () => {
    // The empty placeholder used to render as 「(不拆分,根任务直接执行)」 — a decision nobody
    // made, contradicting the error line directly above it, which says the plan role will
    // draft (and probably decompose) at run time.
    const m = await mount({
      draft: { kind: 'unknown', plan: emptyPlan(), children: [] },
      drafted: false,
      draftError: '未能起草根方案(provider down);确认后将由 plan 角色在运行中自行起草。',
    })
    const f = m.lastFrame()
    expect(f).toContain('未能起草,运行时由 plan 角色重新拆分')
    expect(f).not.toContain('不拆分,根任务直接执行')
    expect(f).toContain('第一层(未起草)')
    m.app.unmount()
  })

  it('warns before the user approves a tree that would be thrown away whole', async () => {
    // Duplicate titles and dependency cycles make createChildren reject the ENTIRE batch —
    // stepStart then asks the plan role again and builds a different tree. The per-child
    // 无效依赖 warning only covers edges that get dropped; these lose everything.
    const dupes = await mount({
      draft: { kind: 'decompose', plan: emptyPlan(), children: [{ title: 'A', deps: [] }, { title: 'A', deps: [] }] },
    })
    expect(dupes.lastFrame()).toContain('子任务标题重复')
    dupes.app.unmount()

    const cyc = await mount({
      draft: { kind: 'decompose', plan: emptyPlan(), children: [{ title: 'A', deps: ['B'] }, { title: 'B', deps: ['A'] }] },
    })
    expect(cyc.lastFrame()).toContain('依赖成环')
    cyc.app.unmount()
  })

  it('states its own scope instead of implying Feishu can answer it', async () => {
    // The other two gates race a Feishu card. This one cannot (free-text 修改 has no channel
    // in the card protocol), and a user waiting on a card that will never arrive is the
    // failure mode of saying nothing.
    const m = await mount()
    expect(m.lastFrame()).toContain('仅在终端确认')
    m.app.unmount()
  })

  it('renders a failed draft as an error, not as an empty plan', async () => {
    const m = await mount({
      draft: { kind: 'unknown', plan: emptyPlan(), children: [] },
      draftError: '未能起草根方案(provider down);确认后将由 plan 角色在运行中自行起草。',
    })
    expect(m.lastFrame()).toContain('provider down')
    expect(m.lastFrame()).toContain('运行中自行起草')
    m.app.unmount()
  })
})

describe('根方案确认关口 · 键盘', () => {
  it('回车 confirms', async () => {
    const m = await mount()
    m.stdin.press(CR)
    await tick()
    expect(m.decisions).toEqual([{ action: 'start' }])
    m.app.unmount()
  })

  it('Esc cancels', async () => {
    const m = await mount()
    m.stdin.press(ESC)
    await tickEsc()
    expect(m.decisions).toEqual([{ action: 'cancel' }])
    m.app.unmount()
  })

  it('e opens the 修改意见 editor and 回车 submits it as a re-draft', async () => {
    const m = await mount()
    m.stdin.press('e')
    await tick()
    expect(m.lastFrame()).toContain('修改意见')
    for (const ch of '拆成三步') { m.stdin.press(ch); await tick() }
    m.stdin.press(CR)
    await tick()
    // Assert on the DECISION, not the frame: the renderer paints incremental diffs, so the
    // accumulated text never appears in one frame — and the decision is what actually
    // travels to the re-draft call.
    expect(m.decisions).toEqual([{ action: 'redraft', feedback: '拆成三步' }])
    m.app.unmount()
  })

  it('refuses to spend a plan call on a BLANK 修改意见', async () => {
    // Submitting nothing would ask the model for "the same thing again" and silently read as
    // a confirmation on screen.
    const m = await mount()
    m.stdin.press('e')
    await tick()
    m.stdin.press(CR)
    await tick()
    expect(m.decisions).toEqual([])
    // A DISCRIMINATING substring. The old assertion used '修改意见', which the default footer
    // 「e 提修改意见重拟」 also contains — so it passed whether or not the editor was open.
    // This phrase exists only in the editor header. (reset() is no help here: the renderer
    // paints incremental diffs, so a cleared buffer only ever holds the changed region.)
    expect(m.lastFrame()).toContain('修改意见(回车提交重拟')
    m.app.unmount()
  })

  it('backspace deletes a whole code point, not half an emoji', async () => {
    const m = await mount()
    m.stdin.press('e')
    await tick()
    for (const ch of ['改', '🙂']) { m.stdin.press(ch); await tick() }
    m.stdin.press(String.fromCharCode(127))
    await tick()
    m.stdin.press('x')
    await tick()
    m.stdin.press(CR)
    await tick()
    // A UTF-16 slice would leave the emoji's lone high surrogate behind — and this string is
    // interpolated into a model prompt and written into run.md.
    expect(m.decisions).toEqual([{ action: 'redraft', feedback: '改x' }])
    m.app.unmount()
  })

  it('Esc inside the editor returns to the gate WITHOUT deciding anything', async () => {
    const m = await mount()
    m.stdin.press('e')
    await tick()
    m.stdin.press('改')
    await tick()
    m.stdin.press(ESC)
    await tickEsc()
    // The DECISION is the property: Esc inside the editor must abandon the edit without
    // starting or cancelling the run.
    expect(m.decisions).toEqual([])
    // NO frame assertion here, deliberately. '回车/y 确认并开始' is painted at mount and the
    // buffer accumulates, so it is present whether or not Esc did anything — it would be a
    // decorative assertion. The editor-vs-gate distinction is covered by the test above, whose
    // substring only the editor produces.
    m.app.unmount()
  })

  it('y in the editor is TEXT, not a confirmation', async () => {
    // The gate's own shortcut must not fire while the user is typing a sentence that
    // happens to contain it — that would start a run they were still describing.
    const m = await mount()
    m.stdin.press('e')
    await tick()
    m.stdin.press('y')
    await tick()
    expect(m.decisions).toEqual([])
    expect(m.lastFrame()).toContain('修改意见')
    m.app.unmount()
  })
})

describe('block()', () => {
  it('keeps the TAIL, where 验收点 and caveats live', () => {
    const lines = block([...Array(20)].map((_, i) => `L${i}`).join('\n'), 5)
    expect(lines[0]).toBe('L0')
    expect(lines[lines.length - 1]).toBe('L19')
    // The elision count must be TRUE: 20 lines shown as 3 head + 2 tail elides exactly 15.
    expect(lines).toContain('… 中间省略 15 行')
    expect(lines).toHaveLength(6) // head + marker + tail
  })

  it('says (空) rather than rendering an empty slot a reviewer can wave through', () => {
    expect(block('')).toEqual(['(空)'])
    expect(block('\n\n  \n')).toEqual(['(空)'])
  })
})
