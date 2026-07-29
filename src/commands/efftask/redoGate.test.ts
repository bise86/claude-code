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
 *
 * 这一版从两屏长到三屏(粒度 → 环节 → 确认),Esc 因此有**两个**「退一级」的落点,
 * 而 q 在三屏上都必须是真的取消。
 */
import { describe, expect, it } from 'bun:test'

import { redoGateAction, redoDetailLines, redoMenuLayout, isWarningLine, type RedoGateState } from './ConfirmRedo.js'

/** 一份真实形状的七条:plan 归第一级,其余六条归第二级,其中三条永远禁用。 */
const OPTS = [
  { entry: 'plan' as const, scope: 'task' as const },
  { entry: 'review' as const, scope: 'phase' as const },
  { entry: 'execute' as const, scope: 'phase' as const },
  { entry: 'verify' as const, scope: 'phase' as const, disabled: '测试验证跑在执行环节内部' },
  { entry: 'accept' as const, scope: 'phase' as const, disabled: '验收跑在执行环节内部' },
  { entry: 'integrate' as const, scope: 'phase' as const, disabled: '没有子任务,不存在集成验收' },
  { entry: 'observer' as const, scope: 'phase' as const, disabled: '观察评分跟在验收通过之后跑' },
]
const scopeScreen: RedoGateState = { scope: null, cursor: 0, picked: null }
const phaseScreen: RedoGateState = { scope: 'phase', cursor: 0, picked: null }
const confirmScreen: RedoGateState = { scope: null, cursor: 0, picked: 'plan' }

describe('第一屏:选粒度', () => {
  it('Esc 取消', () => {
    expect(redoGateAction({ escape: true }, '', scopeScreen, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('q 也取消', () => {
    expect(redoGateAction({}, 'q', scopeScreen, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('↓ 移动光标,并且停在最后一项 —— 第一级只有两条', () => {
    expect(redoGateAction({ downArrow: true }, '', scopeScreen, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 1, picked: null } })
    expect(redoGateAction({ downArrow: true }, '', { scope: null, cursor: 1, picked: null }, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 1, picked: null } })
  })

  it('↑ 停在第一项', () => {
    expect(redoGateAction({ upArrow: true }, '', scopeScreen, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 0, picked: null } })
  })

  it('任务重做**跳过环节清单**直接进确认屏', () => {
    // 它只对应一个环节(分析),中间再插一屏只有一条的清单是空转。
    expect(redoGateAction({ return: true }, '', scopeScreen, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 0, picked: 'plan' } })
  })

  it('阶段重做进第二屏,光标回到顶上', () => {
    expect(redoGateAction({ return: true }, '', { scope: null, cursor: 1, picked: null }, OPTS))
      .toEqual({ kind: 'state', next: { scope: 'phase', cursor: 0, picked: null } })
  })

  it('任务重做被禁用时按不动 —— 授权判据和屏幕是同一份', () => {
    // 屏幕上禁用而这里放行,就是两个真相源;planRedo 那侧也照同一份 options 拒绝。
    const noTask = OPTS.map(o => (o.entry === 'plan' ? { ...o, disabled: '本次配置下不跑任何环节' } : o))
    expect(redoGateAction({ return: true }, '', scopeScreen, noTask)).toEqual({ kind: 'none' })
  })

  it('六条环节全禁用时,不把用户送进一屏全灰的清单', () => {
    const allDead = OPTS.map(o => (o.scope === 'phase' ? { ...o, disabled: '不可用' } : o))
    expect(redoGateAction({ return: true }, '', { scope: null, cursor: 1, picked: null }, allDead))
      .toEqual({ kind: 'none' })
  })

  it('y 在选择屏不是确认 —— 那是确认屏的键', () => {
    expect(redoGateAction({}, 'y', scopeScreen, OPTS)).toEqual({ kind: 'none' })
  })
})

describe('第二屏:选环节', () => {
  it('Esc 退回第一级,**不**取消', () => {
    expect(redoGateAction({ escape: true }, '', { scope: 'phase', cursor: 3, picked: null }, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 0, picked: null } })
  })

  it('q 是真的取消,不是退一级', () => {
    // 页脚写着「Esc 上一级 · q 取消」。两个键走同一分支时那句话是假的。
    expect(redoGateAction({}, 'q', phaseScreen, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('光标下界是**第二级那六条**的条数,不是七条', () => {
    // 用 options.length 的话光标能停到第七行,而那一行不存在 —— 回车什么都不匹配。
    expect(redoGateAction({ downArrow: true }, '', { scope: 'phase', cursor: 5, picked: null }, OPTS))
      .toEqual({ kind: 'state', next: { scope: 'phase', cursor: 5, picked: null } })
  })

  it('回车选中当前环节', () => {
    expect(redoGateAction({ return: true }, '', phaseScreen, OPTS))
      .toEqual({ kind: 'state', next: { scope: 'phase', cursor: 0, picked: 'review' } })
  })

  it('不可用的条目按不动', () => {
    // 按下去什么都不该发生,更不该确认成别的环节。
    expect(redoGateAction({ return: true }, '', { scope: 'phase', cursor: 2, picked: null }, OPTS))
      .toEqual({ kind: 'none' })
  })

  it('光标越界时回车也不崩', () => {
    expect(redoGateAction({ return: true }, '', { scope: 'phase', cursor: 99, picked: null }, OPTS))
      .toEqual({ kind: 'none' })
  })

  it('一条都没有时 ↓ 不会把光标推到 -1', () => {
    // -1 渲染成空白、回车又什么都不匹配 —— 一个看得见却按不动的假位置。
    expect(redoGateAction({ downArrow: true }, '', phaseScreen, [OPTS[0]]))
      .toEqual({ kind: 'state', next: { scope: 'phase', cursor: 0, picked: null } })
  })
})

describe('第三屏:确认', () => {
  it('Esc 退回重选,**不**取消', () => {
    // 看完后果改主意,是这一步最常见的动作。
    expect(redoGateAction({ escape: true }, '', confirmScreen, OPTS))
      .toEqual({ kind: 'state', next: { scope: null, cursor: 0, picked: null } })
  })

  it('从第二级进来的,Esc 退回的是环节清单而不是第一级', () => {
    // scope 保持 'phase' —— 退回第一级会让用户重新选一遍粒度,而他只是想换个环节。
    expect(redoGateAction({ escape: true }, '', { scope: 'phase', cursor: 1, picked: 'execute' }, OPTS))
      .toEqual({ kind: 'state', next: { scope: 'phase', cursor: 1, picked: null } })
  })

  it('q 是真的取消', () => {
    expect(redoGateAction({}, 'q', confirmScreen, OPTS)).toEqual({ kind: 'cancel' })
  })

  it('回车确认', () => {
    expect(redoGateAction({ return: true }, '', confirmScreen, OPTS))
      .toEqual({ kind: 'confirm', entry: 'plan' })
  })

  it('y 也确认', () => {
    expect(redoGateAction({}, 'Y', confirmScreen, OPTS)).toEqual({ kind: 'confirm', entry: 'plan' })
  })

  it('方向键在确认屏不动 —— 这一屏没有可选项', () => {
    expect(redoGateAction({ downArrow: true }, '', confirmScreen, OPTS)).toEqual({ kind: 'none' })
  })

  it('确认交出去的是选中的那个环节,不是写死的', () => {
    expect(redoGateAction({ return: true }, '', { scope: 'phase', cursor: 1, picked: 'review' }, OPTS))
      .toEqual({ kind: 'confirm', entry: 'review' })
  })
})

/**
 * 高度预算。
 *
 * 这一屏此前**两样都没有**(名册夹到 80 码点并印「另 N 席未显示」,名册编辑器开 6 行的窗
 * 并印「←N →N」,唯独这里平铺)。而 ink 不裁剪:放不下时终端自己滚,滚掉的是最上面的
 * 标题和前几条,页脚反而留着 —— 用户看不见 `❯` 停在哪一项。
 */
describe('高度预算', () => {
  const opt = (detail: string, disabled?: string) => ({ detail, disabled })
  const six = [
    opt('保留现有方案,只重跑一次质疑讨论。不通过则本节点阻断并附评审意见 —— 要按意见重出方案请用「任务重做」'),
    opt('方案保留;本次实际跑:执行 → 验收;不跑:测试验证、观察(未配置角色,这些环节不存在)'),
    opt('', '测试验证跑在执行环节内部,没有自己的入口 —— 要重跑它请选「从执行重做」'),
    opt('', '验收跑在执行环节内部,没有自己的入口 —— 要重跑它请选「从执行重做」'),
    opt('子任务全部保留,只重新裁决一次「合起来达没达成父目标」'),
    opt('', '观察评分跟在验收/集成验收通过之后跑,没有自己的入口'),
  ]

  it('80×24 上六条放不下 —— 不能全带说明', () => {
    // 实测这六条的真实高度是 [3,3,3,2,2,2] = 15 行,加框架 4 行 = 19,再加 REPL
    // 自己的输入框和状态行,24 行终端上一点富余都没有。
    const l = redoMenuLayout(24, 80, six, 0)
    expect(l.detailed).toBe(false)
  })

  it('画出来的总高,永远给 REPL 留得下 5 行', () => {
    /**
     * 判据**不用**组件自己那个 MENU_CHROME_ROWS —— 那样只是把实现抄一遍,把它改成 4
     * 测试照样绿。这里用两个独立的事实:组件自己的框架是边框 2 + 标题 1 + 页脚 1 = 4 行,
     * 而 `/et` 画在 REPL 的 transcript 流里,下面至少还有 5 行输入框和状态行。
     */
    const CHROME = 4
    const REPL_BELOW = 5
    for (const rows of [16, 20, 24, 28, 40]) {
      for (const cursor of [0, 3, 5]) {
        const l = redoMenuLayout(rows, 80, six, cursor)
        const shown = six.slice(l.from, l.from + l.capacity)
        const bodies = shown.reduce((a, o, i) => a + (
          l.detailed || l.from + i === cursor
            ? redoDetailLines(o.disabled ? `不可用:${o.disabled}` : o.detail, 80).length
            : 0
        ), 0)
        const hint = l.capacity < six.length ? 1 : 0
        const total = l.capacity + bodies + hint + CHROME
        expect(`${rows}×${cursor}: ${total} <= ${rows - REPL_BELOW}`)
          .toBe(`${rows}×${cursor}: ${Math.min(total, rows - REPL_BELOW)} <= ${rows - REPL_BELOW}`)
      }
    }
  })

  it('窗口跟着光标走 —— 选到最后一条时它一定在窗口里', () => {
    const l = redoMenuLayout(16, 80, six, 5)
    expect(5).toBeGreaterThanOrEqual(l.from)
    expect(5).toBeLessThan(l.from + l.capacity)
  })

  it('地方足够时六条全带说明,窗口不开', () => {
    const l = redoMenuLayout(60, 120, six, 0)
    expect(l.detailed).toBe(true)
    expect(l.capacity).toBe(6)
    expect(l.from).toBe(0)
  })

  it('说明按**显示宽度**折行 —— 中文一个字两列', () => {
    // 按码点算的话预算永远偏乐观,而偏乐观的方向就是溢出。
    const cn = '一二三四五六七八九十'.repeat(4) // 40 个汉字 = 80 列
    expect(redoDetailLines(cn, 80).length).toBeGreaterThan(1)
  })

  it('过长的说明夹到三行并留省略号 —— 它是说明,不是正文', () => {
    const lines = redoDetailLines('说明'.repeat(200), 80)
    expect(lines).toHaveLength(3)
    expect(lines[2].endsWith('…')).toBe(true)
  })

  it('空说明不占行', () => {
    expect(redoDetailLines('', 80)).toEqual([])
  })
})

describe('摘要行的分色判定', () => {
  it('⚠ 开头的是警告', () => {
    expect(isWarningLine('⚠ 2 个已验收子任务的代码已经落进代码')).toBe(true)
  })

  it('普通说明不是', () => {
    // 一条「删除 2 个子任务」和一条「代码不会回滚」长得一样时,最重的那句会被读成流水账。
    expect(isWarningLine('删除 2 个子任务,重做后按新方案重建')).toBe(false)
    expect(isWarningLine('「甲」将重新走: 执行 → 验收')).toBe(false)
  })

  it('⚠ 出现在中间不算 —— 只认行首那个标记', () => {
    // 模型写出来的标题里完全可能带这个字符;按「包含」判的话,一条普通说明会被染成
    // 警告色,而真正的警告就淹没在一片黄里。
    expect(isWarningLine('删除 1 个子任务(标题里有 ⚠ 的那个)')).toBe(false)
  })
})
