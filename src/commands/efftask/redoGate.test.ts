/**
 * 重做关口的按键语义 —— **纯函数档**。
 *
 * 存在的理由是一条被验收抓到的**假测试**:组件档里那条「第二屏 Esc 退回第一屏」,
 * 把整个 Esc 分支删成 `if (false)` 之后 10 条照样全绿。两个原因叠在一起:
 *
 *  1. 假 TTY 送裸 `\x1b` 时 vendored ink 的 useInput 收不到 —— 键根本没到,
 *     `expect(cancels).toBe(0)` 因此恒真;
 *  2. harness 的 `frame` 是**累加**的,第一屏那帧从没被清掉 —— 画面断言也恒真。
 *
 * 送得进去的键(q / 方向键 / 回车)仍然由组件档守;Esc 的语义归这里。
 */
import { describe, expect, it } from 'bun:test'

import { redoGateAction, type RedoGateState } from './ConfirmRedo.js'

const OPTS = [
  { entry: 'plan' as const },
  { entry: 'execute' as const, disabled: '这是拆分任务' },
  { entry: 'integrate' as const },
]
const first: RedoGateState = { cursor: 0, picked: null }
const second: RedoGateState = { cursor: 0, picked: 'plan' }

describe('第一屏', () => {
  it('Esc 取消', () => {
    expect(redoGateAction({ escape: true }, '', first, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('q 也取消', () => {
    expect(redoGateAction({}, 'q', first, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('↓ 移动光标,并且停在最后一项', () => {
    expect(redoGateAction({ downArrow: true }, '', first, OPTS))
      .toEqual({ kind: 'state', next: { cursor: 1, picked: null } })
    expect(redoGateAction({ downArrow: true }, '', { cursor: 2, picked: null }, OPTS))
      .toEqual({ kind: 'state', next: { cursor: 2, picked: null } })
  })

  it('↑ 停在第一项', () => {
    expect(redoGateAction({ upArrow: true }, '', first, OPTS))
      .toEqual({ kind: 'state', next: { cursor: 0, picked: null } })
  })

  it('回车选中当前项', () => {
    expect(redoGateAction({ return: true }, '', first, OPTS))
      .toEqual({ kind: 'state', next: { cursor: 0, picked: 'plan' } })
  })

  it('不可用的条目按不动', () => {
    // 按下去什么都不该发生,更不该确认成别的环节。
    expect(redoGateAction({ return: true }, '', { cursor: 1, picked: null }, OPTS))
      .toEqual({ kind: 'none' })
  })

  it('光标越界时回车也不崩', () => {
    expect(redoGateAction({ return: true }, '', { cursor: 99, picked: null }, OPTS))
      .toEqual({ kind: 'none' })
  })

  it('y 在第一屏不是确认 —— 那是第二屏的键', () => {
    expect(redoGateAction({}, 'y', first, OPTS)).toEqual({ kind: 'none' })
  })
})

describe('第二屏', () => {
  it('Esc 退回第一屏,**不**取消', () => {
    // 看完后果改主意选另一个环节,是这一步最常见的动作。这条正是那条假测试想守
    // 却没守住的。
    expect(redoGateAction({ escape: true }, '', second, OPTS))
      .toEqual({ kind: 'state', next: { cursor: 0, picked: null } })
  })

  it('q 是真的取消,不是退回第一屏', () => {
    // 页脚写着「Esc 换一个环节 · q 取消」。两个键走同一分支时那句话是假的。
    expect(redoGateAction({}, 'q', second, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('回车确认', () => {
    expect(redoGateAction({ return: true }, '', second, OPTS))
      .toEqual({ kind: 'confirm', entry: 'plan' })
  })

  it('y 也确认', () => {
    expect(redoGateAction({}, 'Y', second, OPTS)).toEqual({ kind: 'confirm', entry: 'plan' })
  })

  it('方向键在第二屏不动 —— 这一屏没有可选项', () => {
    expect(redoGateAction({ downArrow: true }, '', second, OPTS)).toEqual({ kind: 'none' })
  })

  it('确认交出去的是第一屏选中的那个环节,不是写死的', () => {
    expect(redoGateAction({ return: true }, '', { cursor: 2, picked: 'integrate' }, OPTS))
      .toEqual({ kind: 'confirm', entry: 'integrate' })
  })
})
