import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { PHASE_NAMES } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, RoleBinding, TaskNode } from '../../tools/efftask/types.js'
import { useLiveState } from './useLiveState.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import {
  clampParallelism, goalLine, noticeLines, parallelismLine, rosterLines, rosterEditorLines, toggleRole, resumeSummarySections,
  type ResumeSummary, type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'

/** Rows of tree the gate draws. Small on purpose — the gate must stay readable on one
 * screen, and `v` opens the full browsable tree for anyone who needs more. */
const TREE_ROWS = 10

/**
 * §17.3 恢复确认关口. Same shape as ConfirmStartup, plus the recovery summary — rendered
 * from `resumeSummarySections`, the SAME function the Feishu card uses, so the two surfaces
 * cannot describe the resume differently.
 *
 * 仅查看后退出 is a real third answer, not a synonym for cancel: a user who ran `--resume`
 * to inspect a crashed run should be able to read the tree without being asked whether to
 * spend money on it.
 *
 * It USED to be a synonym — `v` sent the byte-identical `{parallelism, approved: false}` that
 * Esc sends, and this comment's own last sentence said so ("exactly like Esc") while the key
 * on screen said 仅查看后退出. Nothing was ever viewed. The recovered tree is already in
 * memory at that point (this gate renders its counts from it), so the answer now carries
 * `viewOnly` and the command hands that tree to the read-only browser instead of exiting.
 */
export function ConfirmResume(props: {
  config: EffTaskConfig
  summary: ResumeSummary
  isolation?: 'worktree' | 'none'
  /**
   * 恢复出的任务树 (spec §17.3 的第一项)。
   *
   * The gate listed counts and a repair summary but never showed the tree itself, so a user
   * was asked to approve spending real money on a run whose shape they could not see: which
   * branches survived, which are blocked, how much is left. Rendered NON-interactively —
   * TaskTreePanel's `useInput` is gated on `interactive`, so it cannot steal this gate's
   * keyboard. Optional so the component still renders standalone.
   */
  nodes?: TaskNode[]
  /**
   * 名册可编辑 (spec §17.3: 「与新建 run **相同的**确认界面……角色名册与并行数(**可改**)」).
   *
   * Only parallelism was editable here. That is not a cosmetic gap: the roster comes back off
   * run.md, and this command's own code notes that a role recorded on disk may no longer exist
   * in this session and will be silently downgraded to the main model. The user saw that on the
   * gate and had exactly two options — accept it, or cancel and hand-edit run.md.
   */
  availableRoles?: string[]
  roleModel?: (roleName: string) => string | undefined
  /**
   * Fired the first time the user changes anything here.
   *
   * The Feishu surface races this gate and its card carries no roster and a gate-open
   * parallelism snapshot, so a Feishu win silently discards whatever was edited in the
   * terminal. The command uses this to SAY so. Without it that warning was dead code on the
   * resume path — and this gate had just started inviting roster edits, which made the
   * omission worse than it had been.
   */
  onEdited?: () => void
  onDecision: (d: StartupDecision) => void
}): React.ReactElement {
  const [parallelism, setParallelism, parRef] = useLiveState(clampParallelism(props.config.parallelism))
  const [roster, setRoster, rosterRef] = useLiveState<Record<PhaseName, RoleBinding[]>>(
    Object.fromEntries(PHASE_NAMES.map(p => [p, [...props.config.phaseRoles[p]]])) as Record<PhaseName, RoleBinding[]>,
  )
  const [editing, setEditing, editingRef] = useLiveState(false)
  const [phaseIdx, setPhaseIdx, phaseRef] = useLiveState(0)
  const [roleIdx, setRoleIdx, roleRef] = useLiveState(0)
  const available = props.availableRoles ?? []

  const decide = (d: Partial<StartupDecision> & { approved: boolean }): void =>
    props.onDecision({ parallelism: parRef.current, phaseRoles: rosterRef.current, ...d })

  useInput((input, key) => {
    const k = input.toLowerCase()
    if (editingRef.current) {
      // Esc LEAVES the editor rather than cancelling the resume — losing the edits AND the
      // gate to one keystroke is the same trap ConfirmStartup avoids.
      if (key.escape) { setEditing(false); return }
      if (key.upArrow || k === 'k') { setPhaseIdx((phaseRef.current + PHASE_NAMES.length - 1) % PHASE_NAMES.length); return }
      if (key.downArrow || k === 'j') { setPhaseIdx((phaseRef.current + 1) % PHASE_NAMES.length); return }
      if (available.length > 0) {
        if (key.leftArrow || k === 'h') { setRoleIdx((roleRef.current + available.length - 1) % available.length); return }
        if (key.rightArrow || k === 'l') { setRoleIdx((roleRef.current + 1) % available.length); return }
        if (input === ' ') {
          const name = available[roleRef.current]
          setRoster(toggleRole(rosterRef.current, PHASE_NAMES[phaseRef.current], name, props.roleModel?.(name), props.config.caps.maxSeatsPerPhase))
          props.onEdited?.()
          return
        }
      }
      if (key.return) decide({ approved: true })
      return
    }
    if (key.leftArrow || input === '-') { setParallelism(clampParallelism(parRef.current - 1)); props.onEdited?.(); return }
    if (key.rightArrow || input === '+' || input === '=') { setParallelism(clampParallelism(parRef.current + 1)); props.onEdited?.(); return }
    if (k === 'r') { setEditing(true); return }
    if (key.return || k === 'y') decide({ approved: true })
    else if (k === 'v') decide({ approved: false, viewOnly: true })
    else if (key.escape || k === 'n') decide({ approved: false })
  })
  const sections = resumeSummarySections(props.summary)
  // What the roster lines describe must be the EDITED roster, not what came off disk —
  // otherwise the gate shows one panel and resumes with another.
  const shown: EffTaskConfig = { ...props.config, phaseRoles: roster }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 恢复确认</Text>
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
          <Text color="warning">以下请求不会生效:</Text>
          {noticeLines(props.config).map(l => <Text key={l} color="warning">  · {l}</Text>)}
        </Box>
      )}
      {sections.map(sec => (
        <Box key={sec.heading} flexDirection="column">
          <Text color={sec.tone === 'warn' ? 'warning' : undefined} bold>{sec.heading}</Text>
          {sec.lines.map(l => (
            <Text key={l} color={sec.tone === 'warn' ? 'warning' : undefined} dimColor={sec.tone !== 'warn'}>  · {l}</Text>
          ))}
        </Box>
      ))}
      {/* 恢复出的任务树 (spec §17.3). Non-interactive: TaskTreePanel gates its useInput on
          `interactive`, so this cannot take the keyboard away from the gate above. Height is
          clamped because the gate has to stay readable on one screen — `v` opens the full
          browsable tree for anyone who needs to go deeper. */}
      {props.nodes && props.nodes.length > 0 ? (
        <Box flexDirection="column">
          <TaskTreePanel nodes={props.nodes} runId={props.summary.runId} maxRows={TREE_ROWS} />
          {/* Say the truncation out loud. The panel is NON-interactive here, so nothing can
              scroll it: with 21 nodes the frame showed the first 10 and closed its border as
              though that were the whole tree, while the header counted a ✗ the user could not
              see. The only hint was the panel's `1/21`, which is a cursor position — and there
              is no cursor in this mode. Same rule the log pane and block() already follow. */}
          {props.nodes.length > TREE_ROWS ? (
            <Text dimColor>
              {'  '}(树太长,上面只显示了前 {TREE_ROWS} 行,共 {props.nodes.length} 个节点;按 v 查看完整任务树)
            </Text>
          ) : null}
        </Box>
      ) : null}
      {editing ? (
        <Text dimColor>
          {available.length > 0
            ? '↑/↓ 选阶段 · ←/→ 选角色 · 空格 增删 · 回车 确认并继续 · Esc 退出编辑'
            // ←/→ and 空格 are gated on there being candidates; listing them with none
            // available would advertise three dead keys.
            : '回车 确认并继续 · Esc 退出编辑(没有可用角色,无法编辑)'}
        </Text>
      ) : (
        <Text dimColor>回车/y 继续执行 · r 编辑角色名册 · ←/→ 调整并行数 · v 仅查看后退出 · Esc/n 取消</Text>
      )}
    </Box>
  )
}
