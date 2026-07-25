import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import { capsLine, clampParallelism, goalLine, noticeLines, parallelismLine, rosterLines, type StartupDecision } from '../../tools/efftask/startupConfirm.js'

export function ConfirmStartup(props: { config: EffTaskConfig; isolation?: 'worktree' | 'none'; onDecision: (d: StartupDecision) => void }): React.ReactElement {
  // 用户原话:"默认5个,需求提示词可指定,可跟用户确认修改" —— the fourth clause. Both
  // branches used to echo props.config.parallelism, so the value was never editable.
  const [parallelism, setParallelism] = React.useState(clampParallelism(props.config.parallelism))
  useInput((input, key) => {
    if (key.leftArrow || input === '-') { setParallelism(p => clampParallelism(p - 1)); return }
    if (key.rightArrow || input === '+' || input === '=') { setParallelism(p => clampParallelism(p + 1)); return }
    if (key.return || input.toLowerCase() === 'y') props.onDecision({ parallelism, approved: true })
    else if (key.escape || input.toLowerCase() === 'n') props.onDecision({ parallelism, approved: false })
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 启动确认</Text>
      <Text>目标: {goalLine(props.config.goalPrompt)}</Text>
      <Text>{parallelismLine({ ...props.config, parallelism }, { editable: true, isolation: props.isolation })}</Text>
      {/* Real roster from config.phaseRoles — settings roles DO take effect in P1. */}
      <Text bold>角色名册:</Text>
      {rosterLines(props.config).map(line => <Text key={line}>  {line}</Text>)}
      {noticeLines(props.config).length > 0 && (
        <Box flexDirection="column">
          <Text color="warning">你的请求中有以下部分不会生效:</Text>
          {noticeLines(props.config).map(l => <Text key={l} color="warning">  · {l}</Text>)}
        </Box>
      )}
      <Text>{capsLine(props.config)}</Text>
      <Text dimColor>回车/y 开始 · Esc/n 取消</Text>
    </Box>
  )
}
