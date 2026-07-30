import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  failedPhaseOf, planSkip, skipFailedPhaseReason, skipSummary,
  type RedoContext,
} from '../../tools/efftask/redo.js'
import { MAX_GUIDANCE_CHARS, PHASE_LABEL, type PhaseName, type TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState } from './useLiveState.js'
import { LineInput } from './LineInput.js'
import { redoSummaryLines } from './ConfirmRedo.js'

/**
 * 跳过关口 —— **一屏**。
 *
 * 用户的原话:「对于失败的任务,有键可以快速重做失败的阶段或跳过失败的阶段,继续往下走」。
 *
 * 为什么只有一屏,而重做有三屏:重做要**选**(粒度 × 环节,七条里四条能按),而跳过没有可选的
 * —— 跳的就是失败的那一个,是哪一个由 `failedAt` 说了算。给它套两屏菜单只会让一条唯一的路
 * 看起来像有分支。
 *
 * 但**确认屏一定要有**,而且要把后果摊开:跳过验收意味着这个节点的产出没有任何人核对就
 * 合进集成分支,而这件事没有回头路。这一屏的每一行都来自 `planSkip` 的返回值 ——
 * 屏幕上说的就是接下来真的会发生的事。
 */
export function ConfirmSkip(props: {
  nodes: TaskNode[]
  targetId: string
  now: string
  phases?: RedoContext
  onConfirm: (guidance?: { scope: PhaseName | 'all'; text: string }) => void
  onCancel: () => void
}): React.ReactElement {
  const byId = React.useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes])
  const target = byId.get(props.targetId)
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [noting, setNoting, notingRef] = useLiveState(false)
  const [note, setNote, noteRef] = useLiveState('')

  // 预演。和真正执行用**同一个** planSkip + 同一份 ctx,所以屏幕上的每一行就是接下来
  // 会发生的事;两边各算一次的话,用户是照着屏幕按的确认。
  const preview = React.useMemo(() => {
    if (!target) return null
    const r = planSkip(props.nodes, props.targetId, props.now, props.phases)
    return 'error' in r ? { error: r.error } : { plan: r }
  }, [target, props.nodes, props.targetId, props.now, props.phases])

  useInput((input, key) => {
    // 补提示词那一屏的键盘整个归 LineInput —— 和重做关口逐字同因:不让路的话,
    // 用户写「q 要改成小写」的那个 q 会把整个关口关掉,他刚打的字全没了。
    if (notingRef.current) return
    const k = input.toLowerCase()
    if (key.escape || k === 'q' || k === 'n') { props.onCancel(); return }
    if (k === 'e') { setNoting(true); return }
    if (key.return || k === 'y') {
      const t = noteRef.current.trim()
      // 跳过的是一个环节,而补的这句话是给**这个节点接下来的路**的 —— 所以是 'all',
      // 不是那个被跳掉的环节:往那个环节上写等于写给一个这次不会发生的读者。
      props.onConfirm(t.length > 0 ? { scope: 'all', text: t } : undefined)
    }
  })

  if (!target) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="error">节点不存在: {props.targetId}</Text>
        <Text dimColor>q / Esc 返回</Text>
      </Box>
    )
  }

  const phase = failedPhaseOf(target)
  // 关口打开之前调用方已经用同一份判据挡过一次了(见 TaskTreePanel 的 s 键),所以这一屏
  // 通常不会渲染错误态。留着它是因为树在关口开着的时候还会变(重做会重启编排),
  // 而一屏白屏比一句原因糟得多。
  const why = skipFailedPhaseReason(target, props.phases)
  if (why || phase === undefined || !preview) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">跳过失败环节</Text>
        <Text color="error">{why ?? '看不出这个节点是哪个环节失败的'}</Text>
        <Text dimColor>q / Esc 返回</Text>
      </Box>
    )
  }

  if (noting) {
    return (
      <LineInput
        title={`补一句提示词给「${target.title}」的每一个环节`}
        hint="它会被拼进本节点之后每个环节的提示词(裁决类环节也看得到,并被告知按补充后的意图判)。"
        maxChars={MAX_GUIDANCE_CHARS}
        footerNote="留空 = 不补充"
        onSubmit={t => { setNote(t); setNoting(false) }}
        onCancel={() => setNoting(false)}
      />
    )
  }

  const lines = 'error' in preview
    ? [preview.error]
    : [
        ...skipSummary(preview.plan, target, phase, props.phases),
        ...(note.trim().length > 0 ? [`补充指引(给整个任务): ${note.trim()}`] : []),
      ]
  // 和确认重做那一屏共用同一份夹取:这一屏同样会长(跳过集成验收带着两条 ⚠),而 ink
  // 不裁剪 —— 溢出时终端自己滚,滚掉的是最上面的标题和最重要的那几行。
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">跳过「{PHASE_LABEL[phase]}」并继续 —— {target.title}</Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={l.startsWith('⚠') ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条后果未显示(终端太矮);放大窗口或见 run.md</Text> : null}
      <Text dimColor>回车 / y 确认跳过 · e {note.trim().length > 0 ? '改写补充指引' : '补一句提示词'} · q / Esc / n 取消</Text>
    </Box>
  )
}
