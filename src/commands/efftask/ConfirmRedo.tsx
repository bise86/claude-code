import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { planRedo, redoOptions, redoSummary, type RedoEntry } from '../../tools/efftask/redo.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useLiveState } from './useLiveState.js'

/**
 * 重做关口 —— 两屏。
 *
 * 第一屏选环节,第二屏**先把后果摊开再要确认**。分成两屏不是排版偏好:从方案重做会
 * 删掉整棵子树,而「重做」两个字听起来是可逆的。一屏式的「按 r 重做?y/n」会让一次
 * 手滑删掉几十个已验收节点,而用户以为自己只是重跑了一下。
 *
 * 摘要是**算出来的**,不是写死的文案:它直接来自 planRedo 的返回值,所以屏幕上说
 * 「删除 3 个子任务、改写 2 条依赖」的时候,那就是接下来真的会发生的事。两边各写一份
 * 的话,它们迟早会不一致 —— 而不一致的那一次,用户是照着屏幕做的决定。
 */
export function ConfirmRedo(props: {
  nodes: TaskNode[]
  targetId: string
  now: string
  onConfirm: (entry: RedoEntry) => void
  onCancel: () => void
}): React.ReactElement {
  const byId = React.useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes])
  const target = byId.get(props.targetId)
  const options = React.useMemo(
    () => (target ? redoOptions(target, byId) : []),
    [target, byId],
  )
  const [cursor, setCursor, cursorRef] = useLiveState(0)
  const [picked, setPicked, pickedRef] = useLiveState<RedoEntry | null>(null)

  // 预演。选中哪一条就算哪一条,所以第二屏的数字和第一屏的选择永远对得上。
  const preview = React.useMemo(() => {
    const entry = picked
    if (!entry || !target) return null
    const r = planRedo(props.nodes, props.targetId, entry, props.now)
    return 'error' in r ? { error: r.error } : { plan: r }
  }, [picked, target, props.nodes, props.targetId, props.now])

  useInput((input, key) => {
    const k = input.toLowerCase()
    if (key.escape || k === 'q') {
      // 第二屏的 Esc 退回第一屏,而不是一路退出去 —— 看完后果改主意选另一个环节,
      // 是这一步最常见的动作。
      if (pickedRef.current !== null) { setPicked(null); return }
      props.onCancel()
      return
    }
    if (pickedRef.current !== null) {
      if (key.return || k === 'y') props.onConfirm(pickedRef.current)
      return
    }
    if (key.upArrow || k === 'k') { setCursor(Math.max(0, cursorRef.current - 1)); return }
    if (key.downArrow || k === 'j') { setCursor(Math.min(options.length - 1, cursorRef.current + 1)); return }
    if (key.return) {
      const opt = options[cursorRef.current]
      // 不可用的条目**留在屏幕上但按不动**。直接不渲染的话,菜单会随节点类型忽隐忽现,
      // 用户记不住「第二项」是哪一项;而且看不见「为什么这里不能这么做」。
      if (!opt || opt.disabled) return
      setPicked(opt.entry)
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

  if (picked !== null && preview) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">确认重做</Text>
        {'error' in preview
          ? <Text color="error">{preview.error}</Text>
          : redoSummary(preview.plan, target, picked).map(l => (
              <Text key={l} color={l.startsWith('⚠') ? 'warning' : undefined}>{l}</Text>
            ))}
        {'plan' in preview && preview.plan.deleted.length > 0
          ? <Text dimColor>被删的子任务: {preview.plan.deleted.slice(0, 6).join(', ')}
              {preview.plan.deleted.length > 6 ? ` 等 ${preview.plan.deleted.length} 个` : ''}</Text>
          : null}
        <Text dimColor>回车 / y 确认 · Esc 换一个环节 · q 取消</Text>
      </Box>
    )
  }

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold>重做「{target.title}」</Text>
      <Text dimColor>从哪个环节开始重来</Text>
      {options.map((o, i) => (
        <Box key={o.entry} flexDirection="column">
          <Text color={o.disabled ? undefined : i === cursor ? 'success' : undefined} dimColor={!!o.disabled}>
            {i === cursor ? '❯ ' : '  '}{o.label}
          </Text>
          <Text dimColor>    {o.disabled ? `不可用:${o.disabled}` : o.detail}</Text>
        </Box>
      ))}
      <Text dimColor>↑↓ 选择 · 回车 下一步 · q / Esc 取消</Text>
    </Box>
  )
}
