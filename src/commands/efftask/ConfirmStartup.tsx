import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import { goalLine, rosterLines, type StartupDecision } from '../../tools/efftask/startupConfirm.js'

export function ConfirmStartup(props: { config: EffTaskConfig; onDecision: (d: StartupDecision) => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.return || input.toLowerCase() === 'y') props.onDecision({ parallelism: props.config.parallelism, approved: true })
    else if (key.escape || input.toLowerCase() === 'n') props.onDecision({ parallelism: props.config.parallelism, approved: false })
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 启动确认</Text>
      <Text>目标: {goalLine(props.config.goalPrompt)}</Text>
      <Text>并行数: {props.config.parallelism}（P1 串行执行,此值 P2 生效）</Text>
      {/* Real roster from config.phaseRoles — settings roles DO take effect in P1. */}
      <Text bold>角色名册:</Text>
      {rosterLines(props.config).map(line => <Text key={line}>  {line}</Text>)}
      <Text>安全阀: 深度{props.config.caps.maxDepth} / 节点{props.config.caps.maxNodes} / 迭代{props.config.caps.maxIterations}</Text>
      <Text dimColor>回车/y 开始 · Esc/n 取消</Text>
    </Box>
  )
}
