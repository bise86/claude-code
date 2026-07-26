/**
 * 通过 **vendored** renderer(src/ink.ts)挂载,不是 npm ink。
 *
 * 理由见 ConfirmStartup.test.tsx:用 npm ink 渲染画面看起来完全正常,但 useInput 订阅的是
 * 另一个 StdinContext,这个 app 从不挂载它 —— 于是每一个按键处理器都是死的,关口既答不了
 * 也取消不掉,而 useCancelRequest 在 local-jsx 对话框期间又禁掉了 Esc/Ctrl+C,会话直接卡死。
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { EventEmitter } from 'node:events'
import { render } from '../../ink.js'
import { ConfirmHandoff } from './ConfirmHandoff.js'
import type { PendingHandoff } from '../../tools/efftask/types.js'
import type { HandoffChoice } from '../../tools/efftask/handoffActions.js'

const H: PendingHandoff = {
  branch: 'efftask/001/integration', commits: 3,
  integrationPath: '/repo/.efftask-worktrees/001-int',
  kept: [], salvage: [], outcome: 'completed',
}

function fakeTty() {
  let pending: string | null = null
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() {}, resume() {}, pause() {},
    read: () => { const v = pending; pending = null; return v },
    setEncoding() {}, unref() {}, ref() {},
    press(seq: string) { pending = seq; stdin.emit('readable') },
  })
  let frame = ''
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true, columns: 100, rows: 30,
    write: (s: string) => { frame += s; return true },
  })
  const plain = (): string => frame.replace(/\[[0-9;>?]*[a-zA-Z]/g, ' ')
  const reset = () => { frame = '' }
  return { stdin, stdout, lastFrame: plain, reset }
}

const mount = async (h: PendingHandoff, onDecision: (c: HandoffChoice) => void, onSkip = () => {}) => {
  const tty = fakeTty()
  await render(
    React.createElement(ConfirmHandoff, { handoff: h, runId: '001', onDecision, onSkip }),
    // biome-ignore lint/suspicious/noExplicitAny: fake TTY streams for a headless render
    { stdin: tty.stdin as any, stdout: tty.stdout as any, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(r => setTimeout(r, 20))
  return tty
}
// 源码里的裸控制字符看不见,也会让后续按行/按串的编辑打偏。具名。
const ESC = String.fromCharCode(27)
const DOWN = ESC + '[B'
const tick = () => new Promise(r => setTimeout(r, 20))
// 单独一个 ESC 会被 tokenizer 缓冲,直到它能排除「这是一段转义序列」为止 —— 所以
// Esc 断言必须等过那个窗口。这是渲染器的正确行为,不是 flake。
const tickEsc = () => new Promise(r => setTimeout(r, 250))

describe('收口关口', () => {
  it('四个选项都在,而且按键真的到得了 useInput', async () => {
    const picks: HandoffChoice[] = []
    const tty = await mount(H, c => picks.push(c))
    const f = tty.lastFrame()
    expect(f).toContain('合并回当前分支')
    expect(f).toContain('推送分支')
    expect(f).toContain('保留分支')
    expect(f).toContain('丢弃')
    // 第一项是合并;回车直接选中它。按键到不了 useInput 的话 picks 会一直是空的。
    tty.stdin.press('\r')
    await tick()
    expect(picks).toEqual(['merge'])
  })

  it('「推送」不叫「建 PR」—— 标签必须等于行为', async () => {
    const tty = await mount(H, () => {})
    expect(tty.lastFrame()).not.toContain('PR')
  })

  it('↓ 能移到别的选项', async () => {
    const picks: HandoffChoice[] = []
    const tty = await mount(H, c => picks.push(c))
    tty.stdin.press(DOWN)
    await tickEsc()
    tty.stdin.press('\r')
    await tick()
    expect(picks).toEqual(['push'])
  })

  it('Esc = 稍后再说,不丢任何东西', async () => {
    let skipped = false
    const tty = await mount(H, () => {}, () => { skipped = true })
    tty.stdin.press(ESC)
    await tickEsc()
    expect(skipped).toBe(true)
  })

  it('丢弃要二次确认 —— 一次回车不会删任何东西', async () => {
    const picks: HandoffChoice[] = []
    const tty = await mount(H, c => picks.push(c))
    for (let i = 0; i < 3; i++) { tty.stdin.press(DOWN); await tick() } // 移到「丢弃」
    tty.stdin.press('\r')
    await tick()
    // 还没决定,而是进了确认页
    expect(picks).toEqual([])
    tty.reset()
    await tick()
    tty.stdin.press('\r')
    await tick()
    expect(picks).toEqual(['discard'])
  })

  it('二次确认页如实列出会删什么、不会删什么', async () => {
    const withExtras: PendingHandoff = {
      ...H, salvage: ['efftask/001/salvage'],
      kept: [{ path: '/repo/.wt/a', why: '仍有未合入的内容' }],
    }
    const tty = await mount(withExtras, () => {})
    for (let i = 0; i < 3; i++) { tty.stdin.press(DOWN); await tick() }
    tty.reset()
    tty.stdin.press('\r')
    await tick()
    const f = tty.lastFrame()
    expect(f).toContain('不可逆')
    // 渲染器画的是**增量差分**:重绘会把一个词从中间截断(实测 'efftask/001/' + 光标
    // 移动 + 'ntegration')。断言用不会被截断的短片段。
    expect(f).toContain('将删除集成分支')
    expect(f).toContain('将删除集成工作区')
    expect(f).toContain('不会')
    expect(f).toContain('抢救')
  })

  it('确认页按其它键返回,不会误删', async () => {
    const picks: HandoffChoice[] = []
    const tty = await mount(H, c => picks.push(c))
    for (let i = 0; i < 3; i++) { tty.stdin.press(DOWN); await tick() }
    tty.stdin.press('\r')
    await tick()
    tty.stdin.press('x')
    await tick()
    expect(picks).toEqual([])
  })

  it('run 没跑完时,关口顶部就说清楚 —— 别邀请用户合并一棵半成品', async () => {
    const tty = await mount({ ...H, outcome: 'blocked', reason: '连续返工超限' }, () => {})
    const f = tty.lastFrame()
    expect(f).toContain('没有正常跑完')
    expect(f).toContain('连续返工超限')
  })

  it('正常跑完时不吓唬用户', async () => {
    const tty = await mount(H, () => {})
    expect(tty.lastFrame()).not.toContain('没有正常跑完')
  })
})
