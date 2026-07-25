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
  if (lines.length <= maxLines) return lines
  // Keep the HEAD and the TAIL, not just the head.
  //
  // Every line this run appends is appended at the END: 执行状态 gains "(合并冲突解决)…" and
  // "(冲突解决后验收未通过: …)", 验收记录 gains the newest verdict. A head-only clip therefore
  // hid exactly the lines that say what happened most recently — three acceptance reviews
  // measured a node whose last visible line was "自测全绿" while the rejection that blocked it
  // was in the part that got dropped, findable nowhere in the TUI.
  const tail = Math.min(2, maxLines - 1)
  const head = maxLines - tail
  return [
    ...lines.slice(0, head),
    `… 中间省略 ${lines.length - maxLines} 行`,
    ...lines.slice(lines.length - tail),
  ]
}

function Section(props: { title: string; body: string; color?: string; maxLines?: number }): React.ReactElement | null {
  const trimmed = props.body.trim()
  if (trimmed.length === 0) return null
  return (
    <Box flexDirection="column">
      <Text bold color={props.color}>{props.title}</Text>
      {block(trimmed, props.maxLines).map((l, i) => (
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

export function NodeDetail(props: {
  node: TaskNode
  elapsed: string
  maxLines?: number
  /** 子 agent 实时输出 (spec §10.2), oldest first. Empty when nothing has streamed yet. */
  output?: string[]
  /** How many lines the ring buffer dropped. Shown, so the pane cannot imply it holds all of it. */
  outputDropped?: number
}): React.ReactElement {
  const n = props.node
  // Per-section clipping was not enough: eight sections at 12 lines each is ~127 lines in
  // a 40-line terminal, and this view does not scroll, so the title and goal were the first
  // things pushed off screen. Share one budget across the sections instead.
  const budget = Math.max(6, props.maxLines ?? 24)
  const perSection = Math.max(2, Math.floor(budget / 6))
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
      <Section maxLines={perSection} title="目标" body={n.goal} />
      <Section maxLines={perSection} title="完整方案" body={n.plan.solution} />
      <Section maxLines={perSection} title="重点" body={n.plan.keyPoints} />
      <Section maxLines={perSection} title="风险点" body={n.plan.risks} />
      <Section maxLines={perSection} title="验收点" body={n.plan.acceptance} />
      <Section maxLines={perSection} title="执行状态" body={n.execStatus} />
      <Section maxLines={perSection} title="阻断原因" body={n.blockedReason} color="error" />
      <Section maxLines={perSection} title="评分" body={scoreBody(n)} />
      <Section maxLines={perSection} title="评审记录" body={rounds(n.reviewLog)} />
      <Section maxLines={perSection} title="验收记录" body={rounds(n.acceptLog)} />
      {n.worktree ? <Section maxLines={perSection} title="隔离工作区" body={`${n.worktree.branch}\n${n.worktree.path}`} /> : null}
      {/* 子 agent 实时终端 (spec §10.2). The TAIL, because this is a live stream and the newest
          line is the one being waited on — the opposite of the plan sections above, which are
          documents. Kept after the run ends too ("完成后保留最终输出"). */}
      {props.output && props.output.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color={ui === 'running' ? 'warning' : undefined}>
            子 agent 输出{ui === 'running' ? '(进行中)' : ''}
          </Text>
          {(props.outputDropped ?? 0) > 0 ? (
            <Text dimColor>  … 更早的 {props.outputDropped} 行已滚出缓冲</Text>
          ) : null}
          {props.output.slice(-Math.max(3, perSection * 2)).map((l, i) => (
            <Text key={`out-${i}`} dimColor>  {Array.from(l).slice(0, 100).join('')}</Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>回车 / Esc / q 返回任务树</Text>
    </Box>
  )
}
