import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus, type UiStatus } from '../../tools/efftask/stateMachine.js'
import { NodeDetail } from './NodeDetail.js'
import type { ChunkStore } from '../../tools/efftask/chunkBuffer.js'

const COLOR: Record<UiStatus, string> = { done: 'success', running: 'warning', queued: 'inactive', failed: 'error' }
const GLYPH: Record<UiStatus, string> = { done: '●', running: '◐', queued: '○', failed: '✗' }

/**
 * Wall-clock age of a node. A node that reached a terminal state freezes at the moment it
 * got there; a live one keeps counting against `nowMs`.
 *
 * Both timestamps come off disk/`deps.now()` and can be empty (the orchestrator's nowSafe
 * falls back to '' if the very first clock call throws), so a NaN parse renders '-' instead
 * of leaking "NaNs" into the tree.
 */
export function elapsed(node: TaskNode, nowMs: number): string {
  const start = Date.parse(node.createdAt)
  if (!Number.isFinite(start)) return '-'
  const terminal = node.status === 'ACCEPTED' || node.status === 'BLOCKED'
  const endParsed = terminal ? Date.parse(node.updatedAt) : nowMs
  const end = Number.isFinite(endParsed) ? endParsed : nowMs
  return `${Math.max(0, Math.round((end - start) / 1000))}s`
}

/**
 * Rows to draw: a parent-before-child walk that skips the subtree of any collapsed node.
 *
 * Walks `childIds` from the roots rather than sorting the flat list, because a collapsed
 * node must hide its whole subtree — which id-order alone cannot express. Orphans (a parent
 * that is missing or corrupt on the resume path) are emitted last so nothing is dropped.
 */
export function visibleRows(
  nodes: TaskNode[], collapsed: ReadonlySet<string>,
): { node: TaskNode; depth: number; hasKids: boolean }[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const rows: { node: TaskNode; depth: number; hasKids: boolean }[] = []
  const walk = (n: TaskNode, depth: number, emit: boolean): void => {
    if (seen.has(n.id)) return // a cyclic parent/child link must not hang the render
    seen.add(n.id)
    const kids = n.childIds.map(id => byId.get(id)).filter((c): c is TaskNode => c !== undefined)
    if (emit) rows.push({ node: n, depth, hasKids: kids.length > 0 })
    // A collapsed node's subtree is still WALKED — marking it seen — it just isn't emitted.
    // Skipping the walk entirely would leave those nodes unvisited, and the orphan sweep
    // below would then append them at the bottom of the tree: folding would move rows
    // instead of hiding them.
    const showKids = emit && !collapsed.has(n.id)
    for (const c of kids) walk(c, depth + 1, showKids)
  }
  for (const n of nodes) if (n.parentId === null) walk(n, 0, true)
  // Orphans (a parent missing or corrupt on the resume path) are emitted last so a damaged
  // tree still shows every node it recovered.
  for (const n of nodes) if (!seen.has(n.id)) walk(n, n.depth, true)
  return rows
}

/**
 * The live task tree.
 *
 * `interactive` drives navigation, fold/unfold and the per-node detail view. It also takes
 * over Esc/q so the parent must NOT install a second `useInput` — two handlers both receive
 * every key, and the running view's Esc means "abort the run" while the detail view's means
 * "go back". `onExitKey` is how the parent still gets its abort/exit.
 *
 * ON MOUSE: the request was "点击展开". The vendored renderer does parse SGR mouse events,
 * but mouse tracking is only enabled in fullscreen mode, and turning it on inside the REPL
 * takes away the user's ability to select and copy terminal text — a worse trade than
 * keyboard folding. Arrow/hjkl folding is the equivalent affordance here.
 */
/**
 * The slice of rows to actually draw, and where that slice starts.
 *
 * Without this the panel drew EVERY row: at the default cap of 100 nodes that is 105 lines
 * in a 40-line terminal, so the cursor and the counts header both scrolled off and the user
 * could not see what they were selecting. The cursor is kept away from the window edges by
 * a small margin so that moving one row does not immediately re-scroll the whole view.
 */
export function viewport<T>(rows: T[], cursor: number, height: number): { slice: T[]; from: number } {
  if (height <= 0 || rows.length <= height) return { slice: rows, from: 0 }
  const margin = Math.min(2, Math.floor(height / 4))
  let from = cursor - Math.floor(height / 2)
  from = Math.max(0, Math.min(from, rows.length - height))
  if (cursor < from + margin) from = cursor - margin
  if (cursor > from + height - 1 - margin) from = cursor - height + 1 + margin
  from = Math.max(0, Math.min(from, rows.length - height))
  return { slice: rows.slice(from, from + height), from }
}

export function TaskTreePanel(props: {
  nodes: TaskNode[]
  runId: string
  interactive?: boolean
  /** Rows of tree drawn at once; the rest scrolls with the cursor. */
  maxRows?: number
  onExitKey?: () => void
  /**
   * 子 agent 实时输出 (spec §10.2). Read on demand by the detail view.
   *
   * A live store rather than React state on purpose: the stream fires once per assistant
   * message for EVERY node in flight, and mirroring that into state would repaint the whole
   * tree on each one. The panel already re-renders once a second while anything is running,
   * which is the refresh rate a scrolling log needs.
   */
  chunks?: ChunkStore
}): React.ReactElement {
  // Tick once a second so elapsed times keep moving even when no node transitions —
  // otherwise the panel only repaints on onUpdate and looks frozen during a long phase.
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  // …but stop once every node is terminal: all elapsed values are frozen then, so ticking
  // would repaint identical output every second for as long as the done view stays open.
  const live = props.nodes.some(n => n.status !== 'ACCEPTED' && n.status !== 'BLOCKED')
  React.useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const [cursor, setCursor] = React.useState(0)
  const [detailId, setDetailId] = React.useState<string | null>(null)

  const rows = visibleRows(props.nodes, collapsed)
  // Rows of TREE to draw at once; the border, header and key hint live outside it.
  const height = Math.max(3, props.maxRows ?? 20)
  // The tree grows while it runs, so a cursor parked past the end must not render a blank
  // selection — clamp on every paint rather than trying to fix it up on each mutation.
  const idx = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1)
  const current = rows[idx]?.node
  const detail = detailId ? props.nodes.find(n => n.id === detailId) : undefined

  useInput((input, key) => {
    const k = input.toLowerCase()
    // Detail view owns Esc/q/Enter while it is open; only after it closes do those keys mean
    // "leave the panel" again.
    if (detail) {
      if (key.return || key.escape || k === 'q') setDetailId(null)
      return
    }
    if (key.escape || k === 'q') { props.onExitKey?.(); return }
    if (rows.length === 0) return
    if (key.upArrow || k === 'k') { setCursor(c => Math.max(0, Math.min(c, rows.length - 1) - 1)); return }
    if (key.downArrow || k === 'j') { setCursor(c => Math.min(rows.length - 1, Math.min(c, rows.length - 1) + 1)); return }
    if (key.return) { if (current) setDetailId(current.id); return }
    if (!current) return
    if (key.rightArrow || k === 'l') {
      setCollapsed(s => { const n = new Set(s); n.delete(current.id); return n })
      return
    }
    if (key.leftArrow || k === 'h') {
      // Collapsing a leaf (or an already-collapsed node) jumps to its parent instead — the
      // behaviour every tree widget has, and without it ← is a dead key on most rows.
      const foldable = current.childIds.length > 0 && !collapsed.has(current.id)
      if (foldable) setCollapsed(s => new Set(s).add(current.id))
      else if (current.parentId) {
        const p = rows.findIndex(r => r.node.id === current.parentId)
        if (p >= 0) setCursor(p)
      }
      return
    }
    if (input === ' ') {
      setCollapsed(s => {
        const n = new Set(s)
        if (n.has(current.id)) n.delete(current.id)
        else if (current.childIds.length > 0) n.add(current.id)
        return n
      })
    }
  }, { isActive: props.interactive === true })

  if (detail) {
    return (
      <NodeDetail
        node={detail}
        elapsed={elapsed(detail, nowMs)}
        // 子 agent 实时输出 (spec §10.2). Read at RENDER time from the live store, not copied
        // into React state: the stream fires per assistant message across every node in
        // flight, and mirroring it into state would re-render the whole tree on each one.
        output={props.chunks?.lines(detail.id)}
        outputDropped={props.chunks?.dropped(detail.id)}
      />
    )
  }

  const view = viewport(rows, idx, height)
  const counts: Record<UiStatus, number> = { done: 0, running: 0, queued: 0, failed: 0 }
  for (const n of props.nodes) counts[uiStatus(n.status)]++

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        高效任务 · run {props.runId}{'  '}
        <Text color="success">✓{counts.done}</Text> <Text color="warning">◐{counts.running}</Text>{' '}
        <Text color="inactive">○{counts.queued}</Text> <Text color="error">✗{counts.failed}</Text>
        {rows.length > view.slice.length ? <Text dimColor>{'  '}{idx + 1}/{rows.length}</Text> : null}
      </Text>
      {view.slice.map(({ node: n, depth, hasKids }, vi) => {
        const i = view.from + vi
        const ui = uiStatus(n.status)
        const selected = props.interactive === true && i === idx
        const fold = hasKids ? (collapsed.has(n.id) ? '▸' : '▾') : ' '
        const hidden = hasKids && collapsed.has(n.id) ? ` (+${countSubtree(props.nodes, n)})` : ''
        return (
          <Text key={n.id} color={COLOR[ui]} inverse={selected}>
            {selected ? '❯' : ' '}
            {'  '.repeat(depth)}
            {fold} {GLYPH[ui]} {n.title}{' '}
            <Text dimColor>
              [{n.status}]{n.mergeConflict === true ? ' 待人工解冲突' : ''} {elapsed(n, nowMs)}{scoreTag(n)}{hidden}
            </Text>
          </Text>
        )
      })}
      {props.interactive === true ? (
        <Text dimColor>↑↓/jk 移动 · ←/→ 折叠展开 · 空格切换 · 回车看详情 · Esc/q 退出</Text>
      ) : null}
    </Box>
  )
}

/**
 * The inline score badge (spec §10.1 lists 评分 in the row format).
 *
 * The WORST of the two dimensions: a row has space for one number, and showing the flattering
 * one would hide exactly the case a threshold is meant to catch.
 */
function scoreTag(n: TaskNode): string {
  const s = [n.score.plan?.score, n.score.exec?.score].filter((x): x is number => typeof x === 'number')
  return s.length > 0 ? ` ★${Math.min(...s)}` : ''
}

/** How many descendants a collapsed node is hiding — otherwise folding silently loses them. */
function countSubtree(nodes: TaskNode[], root: TaskNode): number {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  let count = 0
  const walk = (n: TaskNode): void => {
    for (const id of n.childIds) {
      const c = byId.get(id)
      if (!c || seen.has(c.id)) continue
      seen.add(c.id)
      count++
      walk(c)
    }
  }
  walk(root)
  return count
}
