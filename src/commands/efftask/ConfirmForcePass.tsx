import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  failedPhaseOf, forcePassFailedPhaseReason, forcePassOptions, forcePassSummary, planForcePass,
  type RedoContext,
} from '../../tools/efftask/redo.js'
import { MANUAL_PASS_ROLE, MAX_GUIDANCE_CHARS, PHASE_LABEL, type PhaseName, type TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState } from './useLiveState.js'
import { LineInput } from './LineInput.js'
import { redoSummaryLines } from './ConfirmRedo.js'

/**
 * 强制通过关口。
 *
 * 用户的原话:「圆桌没有过导致任务失败了…相当于让圆桌强制过」。跳过已经能让节点继续往下
 * 走,但它**刻意不留记录**(见 pipeline 里「一条 PASS 记录 = 谎报有人评审过」那条注释),
 * 于是「没人看过」和「有人看过并拍板」在 node.md 上长得一模一样。这一屏补的就是后者。
 *
 * ## 两条路,由节点状态决定,不由用户再选一次
 *
 * - **已阻断** → 强制通过的就是**失败的那个环节**,`failedAt` 说了算,没得选(和跳过关口
 *   逐字同因:给一条唯一的路套菜单只会让它看起来像有分支)。走 `planForcePass`,
 *   节点当场重新落座、重启编排。
 * - **还在跑** → 用户要自己指一个「等会儿走到那儿别开会了」。这条路**不改节点**,只往
 *   `RunControl` 上记一笔,由 pipeline 走到那个环节时自己看见 —— 和 `addDirective`
 *   同规矩,不打断在飞的调用。
 *
 * 两条路的确认屏都必须把「这一下换掉了什么」摊开,而且**每一行都来自会真的执行的那份
 * 计算**(阻断那条用同一个 `planForcePass` 预演)—— 用户是照着屏幕按的确认。
 */
export function ConfirmForcePass(props: {
  nodes: TaskNode[]
  targetId: string
  now: string
  phases?: RedoContext
  /**
   * 运行中预先批准的落点。**给了才有那条路** —— 结束之后没有编排器可以告知,
   * 而一个按了没反应的键比没有这个键更糟(和 TaskTreePanel 的 runControl 同规矩)。
   */
  onPreApprove?: (phase: PhaseName) => void
  onConfirm: (guidance?: { scope: PhaseName | 'all'; text: string }) => void
  onCancel: () => void
}): React.ReactElement {
  const byId = React.useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes])
  const target = byId.get(props.targetId)
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [noting, setNoting, notingRef] = useLiveState(false)
  const [note, setNote, noteRef] = useLiveState('')
  const [pick, setPick, pickRef] = useLiveState(0)

  /**
   * 走哪条路。判据是**节点状态**,不是「调用方给没给 onPreApprove」:一个已经阻断的节点
   * 在运行视图里也看得到,而那时候正解是重新落座(它已经停了,预先批准永远不会被走到)。
   */
  const blocked = target?.status === 'BLOCKED'
  const options = React.useMemo(
    () => (target && !blocked ? forcePassOptions(target, props.phases) : []),
    [target, blocked, props.phases],
  )
  const enabled = options.filter(o => !o.disabled)

  // 预演。和真正执行用**同一个** planForcePass + 同一份 ctx —— 两边各算一次的话,
  // 用户是照着屏幕按的确认,而屏幕说的可能不是接下来发生的事。
  const preview = React.useMemo(() => {
    if (!target || !blocked) return null
    const r = planForcePass(props.nodes, props.targetId, props.now, props.phases)
    return 'error' in r ? { error: r.error } : { plan: r }
  }, [target, blocked, props.nodes, props.targetId, props.now, props.phases])

  const phase = target && blocked ? failedPhaseOf(target) : undefined
  const why = !target
    ? `节点不存在: ${props.targetId}`
    : blocked
      ? forcePassFailedPhaseReason(target, props.phases)
      : props.onPreApprove === undefined
        ? `「${target.title}」还在跑(${target.status}),而这次会话没有可以接收预先批准的编排器`
        : enabled.length === 0
          ? `「${target.title}」没有可以强制通过的环节 —— ${options.map(o => `${o.label}:${o.disabled}`).join(';')}`
          : undefined

  /**
   * 这一屏此刻是不是**错误屏**。算在 `useInput` 之前,因为它要管键盘 —— 评审在跳过关口
   * 上实按出来的问题是错误屏的页脚只写「q / Esc 返回」,而按回车真的执行了。屏幕刚说
   * 这件事做不到,回车就做了,而回车是最容易误按的那个键。
   */
  const errored = !target || why !== undefined || (blocked && (phase === undefined || !preview))

  useInput((input, key) => {
    // 补提示词那一屏的键盘整个归 LineInput:不让路的话,用户写「q 要改成小写」的那个 q
    // 会把整个关口关掉,他刚打的字全没了。
    if (notingRef.current) return
    const k = input.toLowerCase()
    if (key.escape || k === 'q' || k === 'n') { props.onCancel(); return }
    // 错误屏上**只有出口**。页脚写的就是这一句,不许多做一件事。
    if (errored) return
    if (blocked) {
      if (k === 'e') { setNoting(true); return }
      if (key.return || k === 'y') {
        const t = noteRef.current.trim()
        // 强制通过的是一个环节,而补的这句话是给**这个节点接下来的路**的 —— 所以是
        // 'all',不是那个被放行的环节:往那个环节上写等于写给一个这次不会开会的读者。
        props.onConfirm(t.length > 0 ? { scope: 'all', text: t } : undefined)
      }
      return
    }
    // 预先批准:先选环节。上下键在**可选的**那几条里绕,禁用项不接受光标 ——
    // 停在一个按回车没反应的行上,和错误屏那条是同一类病。
    if (key.upArrow || k === 'k') { setPick((pickRef.current + enabled.length - 1) % enabled.length); return }
    if (key.downArrow || k === 'j') { setPick((pickRef.current + 1) % enabled.length); return }
    if (key.return || k === 'y') {
      const chosen = enabled[pickRef.current]
      if (chosen) props.onPreApprove?.(chosen.phase)
    }
  })

  if (errored) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">强制通过</Text>
        <Text color="error">{why ?? '看不出这个节点是哪个环节失败的'}</Text>
        <Text dimColor>q / Esc 返回</Text>
      </Box>
    )
  }

  if (noting) {
    return (
      <LineInput
        title={`补一句提示词给「${target!.title}」的每一个环节`}
        hint="它会被拼进本节点之后每个环节的提示词(裁决类环节也看得到,并被告知按补充后的意图判)。"
        maxChars={MAX_GUIDANCE_CHARS}
        initialText={note}
        footerNote="留空 = 不补充"
        onSubmit={t => { setNote(t); setNoting(false) }}
        onCancel={() => setNoting(false)}
      />
    )
  }

  if (!blocked) {
    const cur = enabled[pick % Math.max(1, enabled.length)]
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">预先批准一个环节 —— {target!.title}（{target!.status}）</Text>
        {options.map(o => {
          const on = !o.disabled && o.phase === cur?.phase
          return (
            <Text key={o.phase} color={o.disabled ? 'inactive' : on ? 'warning' : undefined} wrap="truncate-end">
              {o.disabled ? '  ' : on ? '❯ ' : '  '}{o.label}{o.disabled ? ` —— ${o.disabled}` : ''}
            </Text>
          )
        })}
        <Text> </Text>
        <Text wrap="truncate-end">本节点下一次走到该环节时不开会,直接记一条署名「{MANUAL_PASS_ROLE}」的通过</Text>
        {/* 这三条是这条路最容易被误解的地方,而它们都不是猜的 —— 见 RunControl.forcePass。 */}
        <Text wrap="truncate-end">不打断此刻在飞的调用 —— 已经开着的那一桌照常开完,这一批准从下一次进入该环节起生效</Text>
        <Text wrap="truncate-end">一次性:用掉就没了,之后的返工轮照常开会</Text>
        <Text wrap="truncate-end">只活在这次进程里 —— 中途退出或 --resume 之后要重按</Text>
        <Text dimColor>↑↓ / j k 选 · 回车 / y 批准 · q / Esc / n 取消</Text>
      </Box>
    )
  }

  const shot = preview!
  const lines = 'error' in shot
    ? [shot.error]
    : [
        ...forcePassSummary(shot.plan, target!, phase!, props.phases),
        ...(note.trim().length > 0 ? [`补充指引(给整个任务): ${note.trim()}`] : []),
      ]
  // 和确认重做/跳过共用同一份夹取:这一屏同样会长,而 ink 不裁剪 —— 溢出时终端自己滚,
  // 滚掉的是最上面的标题和最重要的那几行。
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">强制通过「{PHASE_LABEL[phase!]}」并继续 —— {target!.title}</Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={l.startsWith('⚠') ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条后果未显示(终端太矮);放大窗口或见 run.md</Text> : null}
      <Text dimColor>回车 / y 确认强制通过 · e {note.trim().length > 0 ? '改写补充指引' : '补一句提示词'} · q / Esc / n 取消</Text>
    </Box>
  )
}
