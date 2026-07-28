import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus } from '../../tools/efftask/stateMachine.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import { AgentLogPane } from './AgentLogPane.js'

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

/** 迭代次数 (spec §10.2). Only the counters that have actually been spent. */
function iterationBody(n: TaskNode): string {
  const it = n.iteration
  return [
    it.planReview > 0 ? `方案评审返工 ${it.planReview}` : '',
    it.acceptance > 0 ? `验收返工 ${it.acceptance}` : '',
    it.integration > 0 ? `集成验收返工 ${it.integration}` : '',
    it.scoring > 0 ? `评分触发返工 ${it.scoring}` : '',
    it.mergeResolve > 0 ? `自动解决合并冲突 ${it.mergeResolve}` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * 各阶段耗时 (spec §10.2), largest first.
 *
 * The pane showed a single aggregate, which cannot answer the question someone opens it with:
 * a node that took 20 minutes because its executor is slow and one that took 20 minutes
 * because it was reviewed four times render identically. Ordered by cost rather than by the
 * state machine's sequence — the reader is looking for where the time went.
 *
 * Sub-second phases are dropped: they are noise beside a phase measured in minutes, and a row
 * reading `0s` invites the reader to wonder what went wrong there.
 */
export function phaseTimeBody(n: TaskNode): string {
  const LABEL: Partial<Record<string, string>> = {
    PLANNING: '分析', PLAN_REVIEW: '质疑讨论', EXECUTING: '执行',
    VERIFYING: '测试验证', ACCEPTANCE: '验收',
    // NOT 「返工」. The REWORK window holds exactly one thing — `refreshFromIntegration`,
    // pulling sibling merges into this node's worktree — and then commits EXECUTING; the
    // actual rework effort is charged to that next EXECUTING round. A row reading 返工 45s
    // directly beneath 迭代次数 · 验收返工 2 reads as "reworking took 45 seconds", and the
    // two mislead each other.
    REWORK: '返工前同步集成分支', INTEGRATION_ACCEPT: '集成验收', SCORING: '观察', MERGE: '合并',
  }
  return Object.entries(n.phaseMs ?? {})
    .filter(([, ms]) => Number.isFinite(ms) && ms >= 1000)
    .sort((a, b) => b[1] - a[1])
    .map(([status, ms]) => `${LABEL[status] ?? status} ${Math.round(ms / 1000)}s`)
    .join(' · ')
}

export function NodeDetail(props: {
  node: TaskNode
  elapsed: string
  maxLines?: number
  /** 子 agent 实时输出:每次模型调用一条流,带署名。 */
  streams?: readonly StreamState[]
  /** 这个节点一共有多少输出没能留下来(环形缓冲 + 被收起的窗口)。 */
  droppedEvents?: number
  /** 这个节点是 --resume 带进来的:没有流 ≠ 什么都没干。 */
  historical?: boolean
  /** 日志窗是否接管键盘(详情视图打开时是,只读等待屏不是)。 */
  logActive?: boolean
  /** 可用列宽。 */
  columns?: number
  /**
   * Resolves a dependency id to its node, so 依赖 renders as titles and statuses.
   *
   * spec §10.2 lists 依赖 among what this pane must show; it rendered `· 依赖 2 个`. A count
   * answers neither question the reader actually has — WHICH tasks, and are they finished —
   * and this pane is exactly where someone goes to find out why a node has been sitting at
   * READY. Optional, so the component still renders standalone.
   */
  resolveNode?: (id: string) => TaskNode | undefined
}): React.ReactElement {
  const n = props.node
  // Per-section clipping was not enough: eight sections at 12 lines each is ~127 lines in
  // a 40-line terminal, and this view does not scroll, so the title and goal were the first
  // things pushed off screen. Share one budget across the sections instead.
  const budget = Math.max(6, props.maxLines ?? 24)
  const hasLog = (props.streams?.length ?? 0) > 0
  /**
   * resume 回来、又没有任何新流的节点:只给**一行**说明,不给一个 12 行的空窗口。
   *
   * `historical` 是个只进不出的标记,`--resume` 之后每个节点都带着它。跟着 hasLog 一起
   * 判的话,perSection 恒为 2 —— 目标、完整方案、执行状态、**阻断原因**、评审记录全被压到
   * 2 行,而让出来的位置是一个只写着「输出属于上一次运行」的大窗口。用户 resume 一个
   * BLOCKED 的运行,进详情视图正是为了读阻断原因和方案,结果反而比不 resume 时看得少。
   */
  const historyOnly = !hasLog && props.historical === true
  // 日志窗打开时其余小节收缩到 2 行。不收的话十几个小节各占 4 行,加上一个至少 8 行的
  // 窗口,标题和目标会被挤出屏幕 —— 这个文件上一次就是为这件事重写过预算分配。
  const perSection = hasLog ? 2 : Math.max(2, Math.floor(budget / 6))
  const ui = uiStatus(n.status)
  // 日志窗自己一份预算,不吃小节的份额:它要读起来像一个子 agent 的终端,而按小节切
  // 出来的四五行做不到这件事。
  const logHeight = Math.max(8, Math.floor(budget / 2))
  const rounds = (log: TaskNode['reviewLog']) =>
    log.map(r => `第 ${r.round} 轮 ${r.synthesized.pass ? '通过' : '未通过'}${r.synthesized.blockingSummary ? ': ' + r.synthesized.blockingSummary : ''}`).join('\n')
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={COLOR[ui]}>{n.title}</Text>
      <Text dimColor>
        {/* 树上用 ⊞ / ▪ 两个符号区分,这里有地方写字就直接写字 —— 详情页不该逼人回去
            对照图例。判据和树上那一处保持一致(见 TaskTreePanel.kindGlyph):同时看
            childIds,因为动态生长会把子节点嫁接到一个已判 executable 的节点上。 */}
        {n.childIds.length > 0 || n.kind === 'decompose' ? '拆分任务' : n.kind === 'executable' ? '执行任务' : '待定'}
        {' · '}
        {n.id} · {n.status} · {props.elapsed}
        {/* 依赖 used to be a bare count here. It now has its own section listing each one by
            title and status, so a count on this line is duplication — and worse, it made the
            section's own title untestable: an assertion for 「依赖」 matched this line whether
            or not the section rendered at all. 子任务 keeps its count because children are
            not listed anywhere in this pane. */}
        {n.childIds.length > 0 ? ` · 子任务 ${n.childIds.length} 个` : ''}
      </Text>
      {/* 依赖 (spec §10.2). Missing deps are REPORTED, not hidden: a dangling id is why the
          node is blocked, and silently shrinking the list would hide the cause. */}
      <Section
        // Its own allowance, like the live log below, rather than the shared per-section
        // slice. `perSection` is budget/6 — four lines at the default — and that divisor was
        // set when there were six sections; 依赖 is now the eleventh. Four lines answers "you
        // have deps" but not "which ones am I waiting on", which is the entire question that
        // brings someone to this pane. Lines here are one short row per dependency, so a
        // larger allowance costs little. Over-long lists still fold through block(), which
        // says how many it hid.
        maxLines={Math.max(6, Math.floor(budget / 3))}
        title="依赖"
        body={n.deps
          .map(id => {
            // No resolver at all is NOT "the node is missing" — it is "the caller did not
            // wire one". Reporting the first as the second is precisely the class of lie this
            // repo keeps paying for, so an unwired pane degrades to bare ids and only a
            // resolver that ANSWERS undefined reports a missing node.
            if (!props.resolveNode) return id
            const d = props.resolveNode(id)
            return d ? `${d.title}(${d.status})` : `${id}(节点缺失)`
          })
          .join('\n')}
      />
      <Section maxLines={perSection} title="目标" body={n.goal} />
      <Section maxLines={perSection} title="完整方案" body={n.plan.solution} />
      <Section maxLines={perSection} title="重点" body={n.plan.keyPoints} />
      <Section maxLines={perSection} title="风险点" body={n.plan.risks} />
      <Section maxLines={perSection} title="验收点" body={n.plan.acceptance} />
      <Section maxLines={perSection} title="执行状态" body={n.execStatus} />
      <Section maxLines={perSection} title="阻断原因" body={n.blockedReason} color="error" />
      <Section maxLines={perSection} title="评分" body={scoreBody(n)} />
      {/* 迭代次数 (spec §10.2 lists it). Zero counters render nothing — Section drops an
          empty body — so an untouched node stays uncluttered. */}
      <Section maxLines={perSection} title="迭代次数" body={iterationBody(n)} />
      {/* 各阶段耗时 (spec §10.2). Empty until at least one phase has run for a second, so a
          node that has barely started stays uncluttered. */}
      <Section maxLines={perSection} title="各阶段耗时" body={phaseTimeBody(n)} />
      <Section maxLines={perSection} title="评审记录" body={rounds(n.reviewLog)} />
      <Section maxLines={perSection} title="验收记录" body={rounds(n.acceptLog)} />
      {n.worktree ? <Section maxLines={perSection} title="隔离工作区" body={`${n.worktree.branch}\n${n.worktree.path}`} /> : null}
      {/* 子 agent 实时终端:每次模型调用一条可折叠的流,带滚动条。最新的在下面 ——
          这是活的流,不是上面那些文档。运行结束后保留最终输出。 */}
      {historyOnly ? (
        <Text dimColor>子 agent 输出:属于上一次运行,事件流只在内存里、不落盘,看不到历史。</Text>
      ) : null}
      {hasLog ? (
        <Box flexDirection="column">
          <Text bold color={ui === 'running' ? 'warning' : undefined}>
            子 agent 输出{ui === 'running' ? '(进行中)' : ''}
          </Text>
          <AgentLogPane
            streams={props.streams ?? []}
            droppedEvents={props.droppedEvents}
            historical={props.historical}
            height={logHeight}
            width={Math.max(30, props.columns ?? 100)}
            isActive={props.logActive === true}
          />
        </Box>
      ) : null}
      <Text dimColor>回车 / Esc / q 返回任务树</Text>
    </Box>
  )
}
