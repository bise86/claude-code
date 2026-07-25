import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import {
  goalLine, noticeLines, rosterLines, resumeSummarySections,
  type ResumeSummary, type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'

/**
 * §17.3 恢复确认关口. Same shape as ConfirmStartup, plus the recovery summary — rendered
 * from `resumeSummarySections`, the SAME function the Feishu card uses, so the two surfaces
 * cannot describe the resume differently.
 *
 * 仅查看后退出 is a real third answer, not a synonym for cancel: a user who ran `--resume`
 * to inspect a crashed run should be able to read the tree without being asked whether to
 * spend money on it. It resolves the gate as not-approved, exactly like Esc.
 */
export function ConfirmResume(props: {
  config: EffTaskConfig
  summary: ResumeSummary
  onDecision: (d: StartupDecision) => void
}): React.ReactElement {
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (key.return || k === 'y') props.onDecision({ parallelism: props.config.parallelism, approved: true })
    else if (key.escape || k === 'n' || k === 'v') props.onDecision({ parallelism: props.config.parallelism, approved: false })
  })
  const sections = resumeSummarySections(props.summary)
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 恢复确认</Text>
      <Text>目标: {goalLine(props.config.goalPrompt)}</Text>
      <Text>并行数: {props.config.parallelism}（P1 串行执行,此值 P2 生效）</Text>
      <Text bold>角色名册:</Text>
      {rosterLines(props.config).map(line => <Text key={line}>  {line}</Text>)}
      {noticeLines(props.config).length > 0 && (
        <Box flexDirection="column">
          <Text color="yellow">以下请求不会生效:</Text>
          {noticeLines(props.config).map(l => <Text key={l} color="yellow">  · {l}</Text>)}
        </Box>
      )}
      {sections.map(sec => (
        <Box key={sec.heading} flexDirection="column">
          <Text color={sec.tone === 'warn' ? 'yellow' : undefined} bold>{sec.heading}</Text>
          {sec.lines.map(l => (
            <Text key={l} color={sec.tone === 'warn' ? 'yellow' : undefined} dimColor={sec.tone !== 'warn'}>  · {l}</Text>
          ))}
        </Box>
      ))}
      <Text dimColor>回车/y 继续执行 · v 仅查看后退出 · Esc/n 取消</Text>
    </Box>
  )
}
