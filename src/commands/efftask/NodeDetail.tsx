import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus } from '../../tools/efftask/stateMachine.js'

const COLOR = { done: 'success', running: 'warning', queued: 'inactive', failed: 'error' } as const

/** Clip to CODE POINTS and cap the line count so one huge plan cannot push the tree off screen. */
function block(text: string, maxLines = 12, width = 100): string[] {
  const lines = text.split('\n').flatMap(l => {
    const cps = Array.from(l)
    if (cps.length <= width) return [l]
    const out: string[] = []
    for (let i = 0; i < cps.length; i += width) out.push(cps.slice(i, i + width).join(''))
    return out
  })
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… 还有 ${lines.length - maxLines} 行`] : lines
}

function Section(props: { title: string; body: string; color?: string }): React.ReactElement | null {
  const trimmed = props.body.trim()
  if (trimmed.length === 0) return null
  return (
    <Box flexDirection="column">
      <Text bold color={props.color}>{props.title}</Text>
      {block(trimmed).map((l, i) => (
        <Text key={`${props.title}-${i}`} color={props.color} dimColor={!props.color}>  {l}</Text>
      ))}
    </Box>
  )
}

/**
 * One node, in full — the "回车进入看更多任务细节" view.
 *
 * Everything here is model-authored and already sanitised on the way to disk
 * (persistence.stripControl); this renders the in-memory node, so it clips by code points
 * rather than trusting either the width or the length of any field.
 */
/**
 * 观察评分, with the reasons — spec §10.2 lists 评分 among the detail view's contents.
 *
 * It was computed, persisted to node.md's frontmatter and then shown NOWHERE: the tree row
 * omitted it and this view omitted it, so a user who configured an observer got a number
 * that only existed on disk. Section() drops an empty body, so an unscored node adds nothing.
 */
function scoreBody(n: TaskNode): string {
  const line = (label: string, s?: { score: number; rationale: string }): string =>
    s ? `${label}: ${s.score}${s.rationale ? ' — ' + s.rationale : ''}` : ''
  return [line('方案质量', n.score.plan), line('执行质量', n.score.exec)].filter(Boolean).join('\n')
}

export function NodeDetail(props: { node: TaskNode; elapsed: string }): React.ReactElement {
  const n = props.node
  const ui = uiStatus(n.status)
  const rounds = (log: TaskNode['reviewLog']) =>
    log.map(r => `第 ${r.round} 轮 ${r.synthesized.pass ? '通过' : '未通过'}${r.synthesized.blockingSummary ? ': ' + r.synthesized.blockingSummary : ''}`).join('\n')
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={COLOR[ui]}>{n.title}</Text>
      <Text dimColor>
        {n.id} · {n.status} · {props.elapsed}
        {n.deps.length > 0 ? ` · 依赖 ${n.deps.length} 个` : ''}
        {n.childIds.length > 0 ? ` · 子任务 ${n.childIds.length} 个` : ''}
      </Text>
      <Section title="目标" body={n.goal} />
      <Section title="完整方案" body={n.plan.solution} />
      <Section title="重点" body={n.plan.keyPoints} />
      <Section title="风险点" body={n.plan.risks} />
      <Section title="验收点" body={n.plan.acceptance} />
      <Section title="执行状态" body={n.execStatus} />
      <Section title="阻断原因" body={n.blockedReason} color="error" />
      <Section title="评分" body={scoreBody(n)} />
      <Section title="评审记录" body={rounds(n.reviewLog)} />
      <Section title="验收记录" body={rounds(n.acceptLog)} />
      {n.worktree ? <Section title="隔离工作区" body={`${n.worktree.branch}\n${n.worktree.path}`} /> : null}
      <Text dimColor>回车 / Esc / q 返回任务树</Text>
    </Box>
  )
}
