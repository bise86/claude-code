import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus, type UiStatus } from '../../tools/efftask/stateMachine.js'
import { NodeDetail } from './NodeDetail.js'
import type { StreamStore } from '../../tools/efftask/agentStream.js'
import { useStreamTick } from './AgentLogPane.js'
import { budgetRows, clipToWidth, lastActivity } from './logView.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'

const COLOR: Record<UiStatus, string> = { done: 'success', running: 'warning', queued: 'inactive', failed: 'error' }
const GLYPH: Record<UiStatus, string> = { done: '●', running: '◐', queued: '○', failed: '✗' }

/**
 * 拆分任务 / 执行任务 的标记。
 *
 * 状态那个圆点回答的是「跑到哪了」,回答不了「这是一个要往下拆的节点,还是一个真的
 * 会改代码的节点」—— 而这两种节点在树上长得一模一样,只有展开之后才看得出来谁有孩子。
 *
 * 字形都是宽度 1 的几何符号(实测过),不和已有的 `▾ ▸ ● ◐ ○ ✗ ❯ ⎿` 撞。这个文件里
 * 的状态字形本来就是裸写的几何符号,这里跟着来,不为两个符号引入 figures 依赖。
 */
export const KIND_GLYPH = { decompose: '⊞', executable: '▪', unknown: '·' } as const

/**
 * 一个节点该画哪个标记。
 *
 * **同时看 kind 和 childIds**,不只看 kind:动态生长会把子节点嫁接到一个已经判成
 * `executable` 的节点上(spec §4),此时 kind 还没被改写,而它事实上已经是拆分节点了。
 * 只看 kind 的话,一个明明有 3 个孩子的行会画成「执行任务」——树上直接说假话。
 */
export function kindGlyph(node: Pick<TaskNode, 'kind' | 'childIds'>): string {
  if (node.childIds.length > 0 || node.kind === 'decompose') return KIND_GLYPH.decompose
  if (node.kind === 'executable') return KIND_GLYPH.executable
  return KIND_GLYPH.unknown
}

/**
 * Wall-clock age of a node. A node that reached a terminal state freezes at the moment it
 * got there; a live one keeps counting against `nowMs`.
 *
 * Both timestamps come off disk/`deps.now()` and can be empty (the orchestrator's nowSafe
 * falls back to '' if the very first clock call throws), so a NaN parse renders '-' instead
 * of leaking "NaNs" into the tree.
 */
export function elapsed(node: TaskNode, nowMs: number): string {
  // From the node's FIRST ACTIVE phase, per spec §10.1 ("自进入活动态起的累计耗时"), not from
  // creation. Measured before: a node that never ran because its dependencies were unfinished
  // rendered 3600s an hour after the tree was built, so a user hunting for the slow node was
  // pointed at one that had not started.
  if (node.startedAt === undefined) {
    return node.status === 'ACCEPTED' || node.status === 'BLOCKED' ? '-' : '排队中'
  }
  // typeof-checked: Date.parse(123) does NOT throw, it coerces — and a hand-edited
  // `startedAt: 123` rendered as 60070736830s. This field exists precisely so the panel does
  // not point at the wrong node.
  const start = typeof node.startedAt === 'string' ? Date.parse(node.startedAt) : Number.NaN
  if (!Number.isFinite(start)) return '-'
  const terminal = node.status === 'ACCEPTED' || node.status === 'BLOCKED'
  // typeof-checked for the same reason as startedAt two lines up: Date.parse(123) coerces
  // rather than throwing, and Math.max(0, …) then rendered a two-hour node as 0s.
  const endParsed = terminal && typeof node.updatedAt === 'string' ? Date.parse(node.updatedAt) : nowMs
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

/**
 * 按**终端行数**而不是**树行数**开窗 —— 运行中的行下面会多挂一条活动行。
 *
 * 第一版是两趟 `viewport`:先用 height 定一个 from、按它算预算、再用变小的 height 调一次
 * viewport。**那两趟的 from 不是同一个** —— 第二趟会拿新 height 重新居中光标,于是「按哪些
 * 行算的预算」和「实际画的哪些行」错开。实测 height=20、光标在 30、34 行起全在跑:
 * firstFrom=20 算出预算 17,而真正画的是 from=22,占 22 个终端行 —— 超 2 行;20 万次随机
 * 扫描里最坏一例超 7 行。溢出的那几行顶掉的正是底部的计数与按键提示。
 *
 * 现在迭代到不动点,并且**最后一步一定是「按最终的 from 重算行数」**,所以
 * `Σcost(slice) <= height` 是构造上成立的,不靠收敛运气。收敛不了就以不溢出为准。
 */
export function budgetedViewport<T>(
  rows: T[], cost: readonly number[], cursor: number, height: number,
): { slice: T[]; from: number } {
  let from = viewport(rows, cursor, height).from
  let n = budgetRows(cost, from, height)
  for (let i = 0; i < 4; i++) {
    const next = viewport(rows, cursor, n).from
    if (next === from) break
    from = next
    n = budgetRows(cost, from, height)
  }
  return { slice: rows.slice(from, from + n), from }
}

export function TaskTreePanel(props: {
  nodes: TaskNode[]
  runId: string
  interactive?: boolean
  /** Rows of tree drawn at once; the rest scrolls with the cursor. */
  maxRows?: number
  onExitKey?: () => void
  /**
   * 重做入口。给了才有 `r` 键 —— 运行中的树不给,因为编排器正握着这些节点。
   *
   * 传的是节点本身而不是 id:调用方要立刻拿它的标题去渲染关口标题,而它手上那份
   * nodes 可能比这次按键晚一拍(树是一直在长的)。
   */
  onRedo?: (node: TaskNode) => void
  /**
   * 子 agent 实时输出。详情视图按需读,树上的活动行也读它。
   *
   * 活存储而不是 React state:事件流对每个在飞的节点每条消息都要触发一次,镜像进 state
   * 会让整棵树在每条消息上重绘。重绘由 useStreamTick 合批驱动(静默期零重绘)。
   */
  streams?: StreamStore
  /** 并行占用 (spec §10.1). Read at render time; see `chunks` for why it is not state. */
  pool?: () => { inUse: number; limit: number }
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

  // 订阅事件流,合批重绘。放在这里而不是放在窗口自己身上:窗口拿到的 streams 是这个组件
  // 在 render 期读出来的,窗口自己重绘并不会让这里重新去读。
  useStreamTick(props.streams, live)
  const { columns, rows: termRows } = useTerminalSize()

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const [cursor, setCursor] = React.useState(0)
  const [detailId, setDetailId] = React.useState<string | null>(null)

  const rows = visibleRows(props.nodes, collapsed)
  // Rows of TREE to draw at once; the border, header and key hint live outside it.
  /**
   * 树画多少行。跟着**终端行数**走,不是写死 20。
   *
   * 写死 20 时面板总高 = 边框 2 + 表头 1 + 20 + 提示 1 = 24,而 24 行是极常见的默认 ——
   * 一点富余都没有,再多一行提示就溢出。减 8 是给边框、表头、提示、以及 /et 上方
   * REPL 里的其它内容留的余量。
   */
  const height = Math.max(3, props.maxRows ?? Math.min(20, Math.max(6, termRows - 8)))
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
      // 详情页是判断「这个节点到底哪儿错了」的地方 —— 看完就想重做,最不该逼用户先退回
      // 树上再按一次 r。
      if (k === 'r' && props.onRedo) { setDetailId(null); props.onRedo(detail); return }
      if (key.return || key.escape || k === 'q') setDetailId(null)
      return
    }
    if (key.escape || k === 'q') { props.onExitKey?.(); return }
    if (rows.length === 0) return
    // 重做。放在方向键**之前**,因为它不依赖 rows 之外的任何东西,而且放后面会被
    // 下面那些 `return` 挡掉一半路径。
    if (k === 'r' && props.onRedo && current) { props.onRedo(current); return }
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
        canRedo={props.onRedo !== undefined}
        node={detail}
        elapsed={elapsed(detail, nowMs)}
        // 在 RENDER 期从活存储读,不复制进 React state:事件流对每个在飞的节点每条消息
        // 都要触发一次,镜像进 state 会让整棵树在每条消息上重绘。
        streams={props.streams?.streams(detail.id)}
        droppedEvents={props.streams?.droppedEvents(detail.id)}
        historical={props.streams?.isHistorical(detail.id)}
        logActive={props.interactive === true}
        columns={columns}
        // 依赖 (spec §10.2) needs the whole tree to turn ids into titles and statuses; the
        // detail pane only ever holds one node.
        resolveNode={id => props.nodes.find(x => x.id === id)}
      />
    )
  }

  /**
   * 行预算按行结算:运行中且有活动的行下面会多挂一条「此刻在调什么工具」。
   *
   * 不能先按「全树运行中节点数」减一个常数。反例:height=20、全部节点在跑 → 预算 14,
   * 而那 14 行**全是运行中的** → 实打印 28 行;反方向,切片里一个运行中的都没有时照样
   * 白扣,树永久少显示好几个节点。
   */
  const activity = new Map<string, string>()
  if (props.streams) {
    for (const r of rows) {
      if (uiStatus(r.node.status) !== 'running') continue
      const list = props.streams.streams(r.node.id)
      const open = [...list].reverse().find(x => !x.closed) ?? list[list.length - 1]
      if (!open) continue
      const act = lastActivity(open)
      if (act) activity.set(r.node.id, `${open.meta.phaseLabel}·${open.meta.label} ${act}`)
    }
  }
  const cost = rows.map(r => (activity.has(r.node.id) ? 2 : 1))
  const view = budgetedViewport(rows, cost, idx, height)
  const counts: Record<UiStatus, number> = { done: 0, running: 0, queued: 0, failed: 0 }
  for (const n of props.nodes) counts[uiStatus(n.status)]++

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        高效任务 · run {props.runId}{'  '}
        <Text color="success">✓{counts.done}</Text> <Text color="warning">◐{counts.running}</Text>{' '}
        <Text color="inactive">○{counts.queued}</Text> <Text color="error">✗{counts.failed}</Text>
        {/* 并行占用 n/N (spec §10.1). The POOL's occupancy, which includes the reviewers a
            roundtable is running — that is the number the confirmation gate capped. */}
        {props.pool ? <Text dimColor>{'  '}并行 {props.pool().inUse}/{props.pool().limit}</Text> : null}
        {rows.length > view.slice.length ? <Text dimColor>{'  '}{idx + 1}/{rows.length}</Text> : null}
      </Text>
      {view.slice.map(({ node: n, depth, hasKids }, vi) => {
        const i = view.from + vi
        const ui = uiStatus(n.status)
        const selected = props.interactive === true && i === idx
        const fold = hasKids ? (collapsed.has(n.id) ? '▸' : '▾') : ' '
        const hidden = hasKids && collapsed.has(n.id) ? ` (+${countSubtree(props.nodes, n)})` : ''
        const act = activity.get(n.id)
        // 标题先按剩余宽度截,状态和耗时才不会被 truncate-end 从右边吃掉。
        // 前缀 = 光标 1 + 缩进 2×depth + 折叠 1 + 空格 1 + 状态字形 1 + 空格 1 + 类型 1 + 空格 1
        const suffix = ` [${n.status}]${n.mergeConflict === true ? ' 待人工解冲突' : ''} ${elapsed(n, nowMs)}${scoreTag(n)}${hidden}`
        // stringWidth 而不是 .length:后缀里有中文(「待人工解冲突」7 个 UTF-16 单元、
        // 13 列),按 .length 算会少扣一半宽度,行照样溢出 —— truncate-end 就得替它兜,
        // 而从右边吃掉的正是状态和耗时。
        const room = columns - (8 + depth * 2) - stringWidth(suffix)
        const title = clipToWidth(n.title, Math.max(6, room))
        return (
          <Box key={n.id} flexDirection="column">
            {/* truncate-end,不让长标题回流成两行:一行一个终端行是 budgetedViewport 的
                前提,行数一旦对不上,底部的计数和按键提示就会被顶出屏幕。 */}
            <Text color={COLOR[ui]} inverse={selected} wrap="truncate-end">
              {selected ? '❯' : ' '}
              {'  '.repeat(depth)}
              {fold} {GLYPH[ui]} {kindGlyph(n)} {title}{' '}
              <Text dimColor>
                [{n.status}]{n.mergeConflict === true ? ' 待人工解冲突' : ''} {elapsed(n, nowMs)}{scoreTag(n)}{hidden}
              </Text>
            </Text>
            {/* 「此刻在调什么工具」—— 不用进详情视图就答得上来。1s 采样,不承诺逐条。 */}
            {act ? (
              <Text dimColor wrap="truncate-end">
                {'   '}{'  '.repeat(depth)}⎿ {act}
              </Text>
            ) : null}
          </Box>
        )
      })}
      {props.interactive === true ? (
        // 图例和按键**同一行**:面板高度 = 边框 2 + 表头 1 + height 20 + 提示,
        // 多一行就是 25 行,而 24 行是极常见的默认 —— 底部的计数和提示会被顶出去。
        // 分隔符不用 '·':「待定」那个字形本身就是 '·',读起来会变成三项。
        <Text dimColor wrap="truncate-end">
          {KIND_GLYPH.decompose}拆分 {KIND_GLYPH.executable}执行 {KIND_GLYPH.unknown}待定{'    '}
          ↑↓/jk 移动 · ←/→ 折叠 · 空格切换 · 回车看详情{props.onRedo ? ' · r 重做' : ''} · Esc/q 退出
        </Text>
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
