import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { RunSummary } from '../../tools/efftask/runRegistry.js'
import { clip } from '../../tools/efftask/startupConfirm.js'

/**
 * §17.1 `/et --resume` with no id: choose a run.
 *
 * `listRuns` already omits reserved-but-empty directories, so anything shown here really is
 * recoverable. An empty list is still possible (a fresh project) and must say so rather than
 * render a chooser with nothing to choose.
 */
export function ResumePicker(props: {
  runs: RunSummary[]
  onPick: (runId: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [cursor, setCursor] = React.useState(0)
  const { runs, onPick, onCancel } = props
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') { onCancel(); return }
    if (runs.length === 0) return
    if (key.upArrow || input === 'k') setCursor(c => (c - 1 + runs.length) % runs.length)
    else if (key.downArrow || input === 'j') setCursor(c => (c + 1) % runs.length)
    else if (key.return) onPick(runs[cursor].runId)
    else if (/^[1-9]$/.test(input)) {
      const i = Number(input) - 1
      if (i < runs.length) onPick(runs[i].runId)
    }
  })

  if (runs.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>高效任务模式 · 选择要恢复的 run</Text>
        <Text color="yellow">没有可恢复的 run（.claude/efftask/ 下没有包含任何节点的目录）</Text>
        <Text dimColor>Esc/q 退出</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 选择要恢复的 run</Text>
      {runs.map((r, i) => {
        const active = i === cursor
        return (
          <Text key={r.runId} color={active ? 'cyan' : undefined} bold={active}>
            {active ? '❯' : ' '} {i < 9 ? `${i + 1}.` : '  '} {r.runId}  {clip(r.goalLine, 44)}
            {'  '}
            <Text color="green">✓{r.counts.accepted}</Text>
            {' '}
            <Text color="red">✗{r.counts.blocked}</Text>
            {' '}
            <Text dimColor>…{r.counts.pending}</Text>
            {r.degraded ? <Text color="yellow">  (配置不完整)</Text> : null}
          </Text>
        )
      })}
      <Text dimColor>↑↓/jk 选择 · 回车确认 · 数字直选 · Esc/q 退出</Text>
    </Box>
  )
}
