import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { PHASE_NAMES } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from '../../tools/efftask/types.js'
import {
  capsLine, clampParallelism, goalLine, noticeLines, parallelismLine, rosterEditorLines,
  rosterLines, toggleRole, type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'

export function ConfirmStartup(props: {
  config: EffTaskConfig
  isolation?: 'worktree' | 'none'
  /**
   * Role names this session can actually dispatch — spec §2 第一关's "名册可编辑".
   *
   * Comes from the command layer (settings `roles` → activeAgents), which is the only place
   * that knows them. Empty means there is nothing to edit and the editor says so rather than
   * rendering a blank table.
   */
  availableRoles?: string[]
  onDecision: (d: StartupDecision) => void
}): React.ReactElement {
  // 用户原话:"默认5个,需求提示词可指定,可跟用户确认修改" —— the fourth clause. Both
  // branches used to echo props.config.parallelism, so the value was never editable.
  const [parallelism, setParallelism] = React.useState(clampParallelism(props.config.parallelism))
  // spec §2 第一关:"名册可编辑后确认". It was rendered read-only, so a user who wanted a
  // different panel had to cancel, reword the prompt and start over.
  const [roster, setRoster] = React.useState<Record<PhaseName, RoleBinding[]>>(() =>
    Object.fromEntries(PHASE_NAMES.map(p => [p, [...props.config.phaseRoles[p]]])) as Record<PhaseName, RoleBinding[]>,
  )
  const [editing, setEditing] = React.useState(false)
  const [phaseIdx, setPhaseIdx] = React.useState(0)
  const [roleIdx, setRoleIdx] = React.useState(0)
  const available = props.availableRoles ?? []

  useInput((input, key) => {
    if (editing) {
      // Esc LEAVES the editor; it does not cancel the run. Cancelling from inside an editor
      // the user just opened would lose the edits AND the gate in one keystroke.
      if (key.escape) { setEditing(false); return }
      if (key.upArrow || input === 'k') { setPhaseIdx(i => (i + PHASE_NAMES.length - 1) % PHASE_NAMES.length); return }
      if (key.downArrow || input === 'j') { setPhaseIdx(i => (i + 1) % PHASE_NAMES.length); return }
      if (available.length > 0) {
        if (key.leftArrow || input === 'h') { setRoleIdx(i => (i + available.length - 1) % available.length); return }
        if (key.rightArrow || input === 'l') { setRoleIdx(i => (i + 1) % available.length); return }
        if (input === ' ') {
          setRoster(r => toggleRole(r, PHASE_NAMES[phaseIdx], available[roleIdx]))
          return
        }
      }
      // 回车 in the editor confirms the WHOLE gate, so a user who has just finished editing
      // does not have to find their way back out first.
      if (key.return) props.onDecision({ parallelism, approved: true, phaseRoles: roster })
      return
    }
    if (key.leftArrow || input === '-') { setParallelism(p => clampParallelism(p - 1)); return }
    if (key.rightArrow || input === '+' || input === '=') { setParallelism(p => clampParallelism(p + 1)); return }
    if (input.toLowerCase() === 'r') { setEditing(true); return }
    if (key.return || input.toLowerCase() === 'y') props.onDecision({ parallelism, approved: true, phaseRoles: roster })
    else if (key.escape || input.toLowerCase() === 'n') props.onDecision({ parallelism, approved: false })
  })

  // What the roster lines describe must be the EDITED roster, not the incoming config —
  // otherwise the gate shows one panel and starts another.
  const shown: EffTaskConfig = { ...props.config, phaseRoles: roster }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 启动确认</Text>
      <Text>目标: {goalLine(props.config.goalPrompt)}</Text>
      <Text>{parallelismLine({ ...shown, parallelism }, { editable: !editing, isolation: props.isolation })}</Text>
      <Text bold>角色名册{editing ? '(编辑中)' : ''}:</Text>
      {editing
        ? rosterEditorLines(roster, available, phaseIdx, roleIdx).map((line, i) => (
          <Text key={`ed-${i}`}>{'  '}{line}</Text>
        ))
        : rosterLines(shown).map(line => <Text key={line}>  {line}</Text>)}
      {noticeLines(props.config).length > 0 && (
        <Box flexDirection="column">
          <Text color="warning">你的请求中有以下部分不会生效:</Text>
          {noticeLines(props.config).map(l => <Text key={l} color="warning">  · {l}</Text>)}
        </Box>
      )}
      <Text>{capsLine(props.config)}</Text>
      {editing ? (
        <Text dimColor>↑/↓ 选阶段 · ←/→ 选角色 · 空格 增删 · 回车 确认并开始 · Esc 退出编辑</Text>
      ) : (
        <Text dimColor>回车/y 开始 · r 编辑角色名册 · ←/→ 调整并行数 · Esc/n 取消</Text>
      )}
    </Box>
  )
}
