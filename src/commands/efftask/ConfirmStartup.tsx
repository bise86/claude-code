import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useLiveState } from './useLiveState.js'
import { PHASE_NAMES } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from '../../tools/efftask/types.js'
import {
  capsLine, costLine, clampParallelism, goalLine, isolationChoiceLines, noticeLines, parallelismLine, rosterEditorLines,
  rosterLines, toggleRole, type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'

export function ConfirmStartup(props: {
  config: EffTaskConfig
  isolation?: 'worktree' | 'none'
  /**
   * Role names this session can actually dispatch — spec §2 第一关's "名册可编辑".
   *
   * Every dispatchable agent, not just settings `roles`: built-ins, plugin agents and
   * `.claude/agents/*.md` all arrive through activeAgents. Empty means there is nothing to
   * edit and the editor says so rather than rendering a blank table.
   */
  availableRoles?: string[]
  /** Which model a role runs on, so an edited seat is not rendered as a bare name. */
  roleModel?: (roleName: string) => string | undefined
  /**
   * Fired the first time the user changes anything here.
   *
   * The Feishu surface can win the race with a payload built when the gate OPENED, so an
   * uncommitted terminal edit is silently discarded. The command uses this to say so rather
   * than let the view flip to the next phase as if nothing was lost.
   */
  onEdited?: () => void
  /**
   * 隔离不可用的原因 (spec §8). Present means the run WILL share the working tree.
   *
   * Rendered as its own block rather than folded into `notices`: that list is headed
   * 「以下请求不会生效」 and is about the prompt's directives, while this is a change to how
   * the whole run executes. Burying one inside the other is how a degradation the user never
   * chose looks like a parsing footnote.
   */
  isolationReason?: string
  /**
   * 「或初始化 git」 (spec §8). Absent → the gate offers only the degrade-or-cancel choice and
   * says so, rather than advertising a key that does nothing.
   */
  onInitGit?: () => void
  onDecision: (d: StartupDecision) => void
}): React.ReactElement {
  // 用户原话:"默认5个,需求提示词可指定,可跟用户确认修改" —— the fourth clause. Both
  // branches used to echo props.config.parallelism, so the value was never editable.
  const [parallelism, setParallelism, parRef] = useLiveState(clampParallelism(props.config.parallelism))
  // spec §2 第一关:"名册可编辑后确认". It was rendered read-only, so a user who wanted a
  // different panel had to cancel, reword the prompt and start over.
  const [roster, setRoster, rosterRef] = useLiveState<Record<PhaseName, RoleBinding[]>>(
    // ?? []:老 run.md 或早于本版的配置缺新增的环节键,少一个就在这里抛 TypeError
    // ——实测整个关口渲染成一屏红色堆栈。
    Object.fromEntries(PHASE_NAMES.map(p => [p, [...(props.config.phaseRoles[p] ?? [])]])) as Record<PhaseName, RoleBinding[]>,
  )
  const [editing, setEditing, editingRef] = useLiveState(false)
  const [phaseIdx, setPhaseIdx, phaseRef] = useLiveState(0)
  const [roleIdx, setRoleIdx, roleRef] = useLiveState(0)
  /** Whether the user touched the roster at all — the notices below describe the ORIGINAL parse. */
  const [edited, setEdited, editedRef] = useLiveState(false)
  const available = props.availableRoles ?? []

  const confirm = (): void =>
    props.onDecision({ parallelism: parRef.current, approved: true, phaseRoles: rosterRef.current })

  useInput((input, key) => {
    if (editingRef.current) {
      // Esc LEAVES the editor; it does not cancel the run. Cancelling from inside an editor
      // the user just opened would lose the edits AND the gate in one keystroke.
      if (key.escape) { setEditing(false); return }
      if (key.upArrow || input === 'k') { setPhaseIdx((phaseRef.current + PHASE_NAMES.length - 1) % PHASE_NAMES.length); return }
      if (key.downArrow || input === 'j') { setPhaseIdx((phaseRef.current + 1) % PHASE_NAMES.length); return }
      if (available.length > 0) {
        if (key.leftArrow || input === 'h') { setRoleIdx((roleRef.current + available.length - 1) % available.length); return }
        if (key.rightArrow || input === 'l') { setRoleIdx((roleRef.current + 1) % available.length); return }
        if (input === ' ') {
          const name = available[roleRef.current]
          setRoster(toggleRole(rosterRef.current, PHASE_NAMES[phaseRef.current], name, props.roleModel?.(name), props.config.caps.maxSeatsPerPhase))
          setEdited(true)
          props.onEdited?.()
          return
        }
      }
      // 回车 in the editor confirms the WHOLE gate, so a user who has just finished editing
      // does not have to find their way back out first.
      if (key.return) confirm()
      return
    }
    if (key.leftArrow || input === '-') { setParallelism(clampParallelism(parRef.current - 1)); props.onEdited?.(); return }
    if (key.rightArrow || input === '+' || input === '=') { setParallelism(clampParallelism(parRef.current + 1)); props.onEdited?.(); return }
    if (input.toLowerCase() === 'r') { setEditing(true); return }
    // 「或初始化 git」 (spec §8). Only live when the caller supplied a handler AND isolation is
    // actually unavailable — an advertised key that does nothing is the failure this repo has
    // paid for repeatedly.
    if (input.toLowerCase() === 'g' && props.onInitGit && props.isolationReason) { props.onInitGit(); return }
    if (key.return || input.toLowerCase() === 'y') confirm()
    else if (key.escape || input.toLowerCase() === 'n') props.onDecision({ parallelism: parRef.current, approved: false })
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
          {/* The notices came from parsing the PROMPT. Once the roster is hand-edited they can
              contradict the table right above them — "方案仍由 architect 承担" beside a
              方案: 主模型 row. Say which one is current instead of leaving two claims. */}
          {edited && <Text dimColor>  (以上是解析提示词时的提醒;名册已被你手动修改,以上面的名册为准)</Text>}
        </Box>
      )}
      {/* 隔离不可用 (spec §8) gets its OWN block. It used to be one line inside the
          「你的请求中有以下部分不会生效」 list — a heading about the PROMPT's directives —
          so a change to how the entire run executes read as a parsing footnote, and the spec's
          「允许选择」 amounted to accept-or-cancel. */}
      {props.isolationReason && !editing && (
        <Box flexDirection="column">
          <Text color="warning">隔离并行不可用,本次将降级执行:</Text>
          {isolationChoiceLines(props.isolationReason, props.onInitGit !== undefined).map(l => (
            <Text key={l} color="warning">  · {l}</Text>
          ))}
        </Box>
      )}
      <Text>{capsLine(props.config)}</Text>
      <Text dimColor>{costLine(props.config)}</Text>
      {editing ? (
        <Text dimColor>
          {available.length > 0
            ? '↑/↓ 选阶段 · ←/→ 选角色 · 空格 增删 · 回车 确认并开始 · Esc 退出编辑'
            // ←/→ and 空格 are gated on there being candidates; listing them here made three
            // dead keys look live.
            : '回车 确认并开始 · Esc 退出编辑(没有可用角色,无法编辑)'}
        </Text>
      ) : (
        <Text dimColor>
          回车/y 开始 · r 编辑角色名册 · ←/→ 调整并行数
          {props.isolationReason && props.onInitGit ? ' · g 初始化 git 并重试隔离' : ''}
          {' · Esc/n 取消'}
        </Text>
      )}
    </Box>
  )
}
