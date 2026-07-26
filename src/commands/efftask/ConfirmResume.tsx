import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import {
  clampParallelism, goalLine, noticeLines, parallelismLine, rosterLines, resumeSummarySections,
  type ResumeSummary, type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'

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
  onDecision: (d: StartupDecision) => void
}): React.ReactElement {
  const [parallelism, setParallelism] = React.useState(clampParallelism(props.config.parallelism))
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (key.leftArrow || input === '-') { setParallelism(p => clampParallelism(p - 1)); return }
    if (key.rightArrow || input === '+' || input === '=') { setParallelism(p => clampParallelism(p + 1)); return }
    if (key.return || k === 'y') props.onDecision({ parallelism, approved: true })
    else if (k === 'v') props.onDecision({ parallelism, approved: false, viewOnly: true })
    else if (key.escape || k === 'n') props.onDecision({ parallelism, approved: false })
  })
  const sections = resumeSummarySections(props.summary)
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 恢复确认</Text>
      <Text>目标: {goalLine(props.config.goalPrompt)}</Text>
      <Text>{parallelismLine({ ...props.config, parallelism }, { editable: true, isolation: props.isolation })}</Text>
      <Text bold>角色名册:</Text>
      {rosterLines(props.config).map(line => <Text key={line}>  {line}</Text>)}
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
        <TaskTreePanel nodes={props.nodes} runId={props.summary.runId} maxRows={10} />
      ) : null}
      <Text dimColor>回车/y 继续执行 · v 仅查看后退出 · Esc/n 取消</Text>
    </Box>
  )
}
