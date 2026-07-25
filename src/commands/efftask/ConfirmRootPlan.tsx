import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { childLines, draftBlockers, type RootDraft } from '../../tools/efftask/rootPlan.js'
import { clip, goalLine } from '../../tools/efftask/startupConfirm.js'

/**
 * 启动关口第三关 (spec §2):根方案 + 初始任务树,给用户确认/修改。
 *
 * TERMINAL ONLY, and it says so. The other two gates race a Feishu card because their whole
 * decision is {approved, parallelism} — two numbers a card action can carry. This one's
 * "修改" is free text, which the Feishu permission-callback protocol has no channel for, so
 * a card here could only ever offer 同意/取消 while the terminal offered 同意/改/取消. Two
 * surfaces that decide different things is worse than one surface that admits its scope.
 */
export type RootPlanDecision =
  | { action: 'start' }
  /** 修改: re-draft with this feedback. Never empty — the view refuses to submit a blank. */
  | { action: 'redraft'; feedback: string }
  | { action: 'cancel' }

/** How much of each plan section the gate shows before it starts eliding. */
const SECTION_LINES = 8

/**
 * Head AND tail, never a bare head.
 *
 * A plan's last lines are where the 验收点 and the caveats live; clipping to the first N
 * lines hid exactly the part a reviewer needs to judge, while looking complete.
 */
export function block(text: string, maxLines = SECTION_LINES): string[] {
  const lines = text.split('\n').map(l => l.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return ['(空)']
  if (lines.length <= maxLines) return lines
  const tail = Math.min(2, maxLines - 1)
  const head = maxLines - tail
  return [...lines.slice(0, head), `… 中间省略 ${lines.length - maxLines} 行`, ...lines.slice(lines.length - tail)]
}

function Section(props: { title: string; body: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>{props.title}</Text>
      {block(props.body).map((l, i) => (
        <Text key={`${props.title}-${i}`} dimColor={l === '(空)'}>{'  '}{clip(l, 160)}</Text>
      ))}
    </Box>
  )
}

export function ConfirmRootPlan(props: {
  goalPrompt: string
  draft: RootDraft
  /**
   * False when drafting failed and `draft` is the empty placeholder. The tree section then
   * says so instead of asserting 不拆分 — a decision nobody made, and one that contradicts
   * the error line telling the user the plan role will draft at run time.
   */
  drafted?: boolean
  /**
   * How many roles will actually sit on the review roundtable.
   *
   * An empty roster is NOT "multi-role": runRoundtable turns it into a single main-model
   * reviewer. Promising 多角色圆桌评审 there would have users waving through a plan they did
   * not read, believing a panel would catch it.
   */
  reviewRoles?: number
  /** Set when a previous draft attempt failed; the gate then offers to start without one. */
  draftError?: string | null
  /** How many times the user has already asked for a re-draft — shown so the cost is visible. */
  redrafts?: number
  onDecision: (d: RootPlanDecision) => void
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')
  useInput((input, key) => {
    if (editing) {
      if (key.escape) { setEditing(false); setFeedback(''); return }
      if (key.return) {
        const text = feedback.trim()
        // A blank 修改意见 would spend a plan call to ask for "the same thing again". Stay in
        // the editor rather than silently turning it into a confirmation.
        if (text.length === 0) return
        props.onDecision({ action: 'redraft', feedback: text })
        return
      }
      if (key.backspace || key.delete) { setFeedback(f => Array.from(f).slice(0, -1).join('')); return }
      // Printable input only. Control sequences arrive here as escape-prefixed strings and
      // would otherwise be pasted into the feedback verbatim.
      // eslint-disable-next-line no-control-regex -- filtering control bytes is the point
      const printable = input.replace(/[\u0000-\u001F\u007F]/g, '')
      if (printable) setFeedback(f => f + printable)
      return
    }
    if (key.return || input.toLowerCase() === 'y') { props.onDecision({ action: 'start' }); return }
    if (input.toLowerCase() === 'e') { setEditing(true); return }
    if (key.escape || input.toLowerCase() === 'n') props.onDecision({ action: 'cancel' })
  })

  const kids = childLines(props.draft, props.drafted !== false)
  const panel = (props.reviewRoles ?? 0) > 1 ? `${props.reviewRoles} 位角色圆桌评审` : '一位评审角色(未配置多角色评审)'
  const blockers = props.drafted === false ? [] : draftBlockers(props.draft)
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 根方案确认(第三关)</Text>
      <Text>目标: {goalLine(props.goalPrompt)}</Text>
      {/* Phrased by the caller, rendered verbatim: a first-draft failure and a re-draft
          failure are different facts (one has no plan below it, the other still shows the
          PREVIOUS plan), and one fixed sentence here was wrong for whichever it wasn't. */}
      {props.draftError ? <Text color="warning">{clip(props.draftError, 160)}</Text> : null}
      <Section title="完整方案" body={props.draft.plan.solution} />
      <Section title="重点" body={props.draft.plan.keyPoints} />
      <Section title="风险点" body={props.draft.plan.risks} />
      <Section title="验收点" body={props.draft.plan.acceptance} />
      <Box flexDirection="column">
        <Text bold>
          初始任务树 · 第一层({props.drafted === false ? '未起草' : `${props.draft.children.length} 个`})
        </Text>
        {kids.map((l, i) => <Text key={`kid-${i}`}>{'  '}{clip(l, 160)}</Text>)}
        {/* These two shapes make createChildren reject the WHOLE batch, so the tree above is
            not what would get built — the plan role would be asked again and produce a
            different one. Worth a warning before the user approves it. */}
        {blockers.map(b => <Text key={b} color="warning">{'  ⚠ '}{clip(b, 160)}</Text>)}
      </Box>
      {/* Say what confirming BUYS. The plan is not final — it still faces the review
          roundtable — and a gate that implied otherwise would misrepresent the process. */}
      {/* Names the REAL panel size. "多角色圆桌评审" with an empty roster was a promise the
          run could not keep — runRoundtable degrades an empty roster to one main-model
          reviewer, and a user may approve an unread plan believing a panel will catch it. */}
      <Text dimColor>确认后该方案仍会经过{panel};提出阻断问题时会按意见修订。</Text>
      {props.redrafts && props.redrafts > 0 ? (
        <Text dimColor>已按你的意见重拟 {props.redrafts} 次。</Text>
      ) : null}
      {editing ? (
        <Box flexDirection="column">
          <Text bold color="warning">修改意见(回车提交重拟 · Esc 放弃修改):</Text>
          <Text>{'  '}{feedback.length > 0 ? feedback : '…'}</Text>
        </Box>
      ) : (
        <Text dimColor>回车/y 确认并开始 · e 提修改意见重拟 · Esc/n 取消 · (本关口仅在终端确认)</Text>
      )}
    </Box>
  )
}
