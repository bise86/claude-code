import * as React from 'react'
import { Box, Text } from 'ink'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus, type UiStatus } from '../../tools/efftask/stateMachine.js'

const COLOR: Record<UiStatus, string> = { done: 'green', running: 'yellow', queued: 'gray', failed: 'red' }
const GLYPH: Record<UiStatus, string> = { done: '●', running: '◐', queued: '○', failed: '✗' }

/**
 * Wall-clock age of a node. A node that reached a terminal state freezes at the moment it
 * got there; a live one keeps counting against `nowMs`.
 *
 * Both timestamps come off disk/`deps.now()` and can be empty (the orchestrator's nowSafe
 * falls back to '' if the very first clock call throws), so a NaN parse renders '-' instead
 * of leaking "NaNs" into the tree.
 */
function elapsed(node: TaskNode, nowMs: number): string {
  const start = Date.parse(node.createdAt)
  if (!Number.isFinite(start)) return '-'
  const terminal = node.status === 'ACCEPTED' || node.status === 'BLOCKED'
  const endParsed = terminal ? Date.parse(node.updatedAt) : nowMs
  const end = Number.isFinite(endParsed) ? endParsed : nowMs
  return `${Math.max(0, Math.round((end - start) / 1000))}s`
}

export function TaskTreePanel(props: { nodes: TaskNode[]; runId: string }): React.ReactElement {
  // Tick once a second so elapsed times keep moving even when no node transitions —
  // otherwise the panel only repaints on onUpdate and looks frozen during a long phase.
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Plain code-point compare, NOT localeCompare — same ordering rule the orchestrator's
  // scheduler uses, so the panel shows nodes in the order they are actually picked.
  // Child ids are `<parentId>/NN-slug`, so this also yields a parent-before-child walk.
  const ordered = [...props.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const counts: Record<UiStatus, number> = { done: 0, running: 0, queued: 0, failed: 0 }
  for (const n of props.nodes) counts[uiStatus(n.status)]++

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        高效任务 · run {props.runId}{'  '}
        <Text color="green">✓{counts.done}</Text> <Text color="yellow">◐{counts.running}</Text>{' '}
        <Text color="gray">○{counts.queued}</Text> <Text color="red">✗{counts.failed}</Text>
      </Text>
      {ordered.map(n => {
        const ui = uiStatus(n.status)
        return (
          <Text key={n.id} color={COLOR[ui]}>
            {'  '.repeat(n.depth)}
            {GLYPH[ui]} {n.title}{' '}
            <Text dimColor>
              [{n.status}] {elapsed(n, nowMs)}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
