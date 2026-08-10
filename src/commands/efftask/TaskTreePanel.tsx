import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { isTerminal, uiStatus, type UiStatus } from '../../tools/efftask/stateMachine.js'
import { NodeDetail, type DetailZone } from './NodeDetail.js'
import type { StreamStore } from '../../tools/efftask/agentStream.js'
import { useStreamTick } from './AgentLogPane.js'
import { runControlAction, budgetRows, clipToWidth, lastActivity, detailEntryHint, paginateHints } from './logView.js'
import { currentMouseAvailability } from './mouseEnv.js'
import { addUsage, EMPTY_USAGE, formatTokens, isEmptyUsage, subtreeUsage, totalTokens, type UsageTotals } from '../../tools/efftask/usage.js'
import { reworkLine, reworkMarker } from '../../tools/efftask/reworkReason.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js'

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
 * 树行上那个用量标记。
 *
 * **算的是含子任务的合计**,不是这个节点自己那一份 —— 树上一个折叠着的拆分节点,人想
 * 知道的正是「这一整块花了多少」,而它自己那一份通常只有几次分析和评审调用。详情页里
 * 两个数都给,那儿有地方分得开。
 *
 * `⇅` 是宽度 1 的箭头,和这个文件里已有的字形不撞。
 */
export function usageTag(n: TaskNode, byId: Map<string, TaskNode>): string {
  const u = subtreeUsage(n, id => byId.get(id))
  // 里面有估出来的数就带 ≈ —— 见 UsageTotals.estimated。一个字符,而它挡住的是
  // 「把估算显示成实测」那一类假话(上游不报用量、以及 CLI 档员工)。
  return isEmptyUsage(u) ? '' : ` ⇅${u.calls}/${(u.estimated ?? 0) > 0 ? '≈' : ''}${formatTokens(totalTokens(u))}`
}

/**
 * 标题至少要留下这么多列,用量标记才配上树行。
 *
 * 比 `clipToWidth` 那个 6 列的硬下限宽得多,而且是故意的:6 列是「宁可夹成两个字也别
 * 让行溢出」的兜底,不是一个可读的标题。落到那一档时,用量必须先让位 —— 树行回答的
 * 第一个问题永远是「这是哪个任务」。
 */
export const MIN_TITLE_ROOM = 16

/**
 * 表头那份整趟合计至少要这么宽才画。
 *
 * 实测 46 列时带它的表头是 **2 行**、不带是 1 行;30 列时 3 行 vs 2 行。而这个文件自己的
 * 注释把「表头 1 行」当成高度预算的前提。60 是「run id + 四个计数 + 并行占用」之后还
 * 剩得下那一小截合计的宽度。
 */
export const HEADER_USAGE_MIN_COLUMNS = 60

/**
 * 「`+/-` 可以调这个数」这句提示至少要这么宽才画。
 *
 * 它跟着 `并行 n/N` 走 —— 那是这个数字**唯一**露面的地方,而键位提示离它越近越好。
 * 代价是表头会长 4 列,而表头一旦折成两行,`budgetedViewport` 那句「面板高度 = 边框 2 +
 * 表头 1 + height + 提示」就不成立了,被顶出屏幕的正是底部的图例和按键提示。
 *
 * 比 `HEADER_USAGE_MIN_COLUMNS` 高 12,不是随手取的:60 那个数是「四个计数 + 并行占用
 * 之后还塞得下用量合计」量出来的,已经贴着一行的边;这 4 列必须自己带余量,否则在 60~63
 * 之间就会把表头挤成两行。`headerFitsOneLine` 那条测试按真渲染钉住了这个数。
 */
export const HEADER_HINT_MIN_COLUMNS = 72

/** 整棵树的用量合计 —— 表头那一句「这一趟花了多少」。 */
export function runUsage(nodes: readonly TaskNode[]): UsageTotals {
  // 逐个节点把**自己那一份**加起来,而不是从根做子树合计:盘上结构半损时会出现够不到
  // 的孤儿节点,而它们一样是真花过钱的,从根走会把它们整个漏掉。
  //
  // (任务重做**不**留孤儿 —— 它连节点一起删,那部分的账记在重做目标的 discardedUsage 上。)
  let out = EMPTY_USAGE
  for (const n of nodes) out = addUsage(addUsage(out, n.usage), n.discardedUsage)
  return out
}

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
 * ## 鼠标
 *
 * 每一行挂一个 `onClick`(移光标 + 打开详情),等价于在这一行上按回车 —— 用户点名要的。
 *
 * 这里**不主动去开**鼠标追踪:开了会夺走终端自己的选中复制。接的是「已经开着时把点击
 * 收下来」,而追踪只在全屏模式下开(`Ink.dispatchClick` 第一句就是
 * `if (!this.altScreenActive) return false`,更上游的终端在非全屏下根本不发这些序列)。
 * 所以非全屏下这段代码是**惰性**的:零成本、不会崩、也不会改变任何既有行为。
 * 页脚会按 `currentMouseAvailability()` 如实说明此刻能不能点 —— 一个按了没反应的
 * affordance 比没有更糟。
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
  /**
   * 子 agent 实时输出。详情视图按需读,树上的活动行也读它。
   *
   * 活存储而不是 React state:事件流对每个在飞的节点每条消息都要触发一次,镜像进 state
   * 会让整棵树在每条消息上重绘。重绘由 useStreamTick 合批驱动(静默期零重绘)。
   */
  streams?: StreamStore
  /** 并行占用 (spec §10.1). Read at render time; see `chunks` for why it is not state. */
  pool?: () => { inUse: number; limit: number }
  /**
   * 执行环节是不是被串行化了(没有隔离工作区时是)。
   *
   * 必须显示,因为不显示的话顶上那个「并行 1/5」是**在误导**:用户看着 5 的上限,
   * 却发现子任务一个一个来,只能怀疑是不是自己配错了。而真实原因是
   * orchestrator 的 `serialiseExecute = kind === 'execute' && worktrees === undefined` ——
   * 两个执行者共用一棵工作树会互相覆盖对方的改动,**同时**各自向自己的验收员汇报成功。
   */
  serialExecute?: boolean
  /**
   * 运行中的人工干预。给了才有 p / i / x 三个键。
   *
   * 只在运行视图给 —— 结束之后没有东西可以暂停或取消,而一个按了没反应的键比没有更糟。
   */
  runControl?: {
    paused: boolean
    onTogglePause: () => void
    onAddDirective: () => void
    /** 取消**光标选中**的那个节点。已经终结的节点不会走到这里(面板自己挡)。 */
    onCancelNode: (node: TaskNode) => void
    /**
     * 调并发上限,`d` 是步长(±1)。给了才有 `+` / `-` 两个键。
     *
     * 面板**不持有那个数**:唯一真相在 RunControl 里,而屏幕上显示的是编排器现读出来的
     * `pool().limit`。面板自己记一份的话,夹取(1..64)和真实上限会在边界上分叉,
     * 而表头和页脚会各说一个数。
     */
    onAdjustParallelism?: (d: number) => void
    /**
     * 调严格度,`d` 是方向(±1)。给了才有 `<` / `>` 两个键。
     *
     * 和 `onAdjustParallelism` 同规矩:面板**不持有那个值**,唯一真相在 RunControl 里,
     * 屏幕上显示的是 `strictness` 现读出来的那一份。
     */
    onAdjustStrictness?: (d: number) => void
    /** 当前生效的档位,`undefined` = 没设。只用于显示。 */
    strictness?: string
  }
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
  /**
   * 尺寸走 `useModalOrTerminalSize`,不是裸的 `useTerminalSize`。
   *
   * 全屏时 `/et` 是 local-jsx,渲染在 FullscreenLayout 的 modal 槽里,而那个槽给的是
   * `rows - 3` / `columns - 4`,外面还罩着 `overflow="hidden"` —— 按终端行数排版会
   * **恒定多算 3 行**,多出来的从底部剪掉。
   */
  const { columns, rows: termRows } = useModalOrTerminalSize(useTerminalSize())
  const inModal = useIsInsideModal()
  const reserved = Math.max(0, props.reservedRows ?? 0)

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  const [cursor, setCursor] = React.useState(0)
  const [detailId, setDetailId] = React.useState<string | null>(null)
  /**
   * 详情页此刻的焦点区。**功能性的,不只是观测。**
   *
   * 回车归这里(返回任务树),而用户要的是「最下面点击或回车可选择不同的页卡」——
   * 所以焦点落在页签条上时这一下回车要让给详情页。让路只能由**这里**做:
   * vendored 的 `useInput` 把 listener 槽位定在 mount 时刻,本面板比 NodeDetail 先挂、
   * 永远先跑,在 NodeDetail 里调 stopImmediatePropagation 已经来不及了。
   */
  const detailZone = React.useRef<DetailZone>('content')
  /** 页脚按键提示翻到第几页。`?` 键 +1,`paginateHints` 自己取模。 */
  const [hintPage, setHintPage] = React.useState(0)
  /**
   * 上一次**动作键**被拒绝的原因,**连同它属于哪个节点**。
   *
   * 只存字符串是不够的:它只在下一次按 d 时才被覆盖,于是在甲上被拒之后打开乙的详情页,
   * 乙的「依赖重算」段上写着**甲那一次**的理由 —— 一句关于别的任务的话,印在这个任务的
   * 详情页上。验收席用真渲染 + 真按键复现过。
   */
  /**
   * `kind` 决定这句话**画在哪** —— 两处都画就是同一句话说两遍:
   *  - `recalc`:重算的拒绝理由是**多行**的(逐条依赖各一句),页脚那一行装不下,
   *    所以它走详情页的「依赖重算」段;
   *  - `action`:重做/跳过/强制通过的拒绝是一句话,走页脚 —— 用户刚按了键,他只看那儿。
   */
  type Notice = { nodeId: string; text: string; kind: 'recalc' | 'action' }
  const [notice, setNotice] = React.useState<Notice | undefined>(undefined)
  const noticeRef = React.useRef<Notice | undefined>(undefined)
  noticeRef.current = notice

  const rows = visibleRows(props.nodes, collapsed)
  // Rows of TREE to draw at once; the border, header and key hint live outside it.
  /**
   * 树画多少行。跟着**终端行数**走,不是写死 20。
   *
   * 写死 20 时面板总高 = 边框 2 + 表头 1 + 20 + 提示 1 = 24,而 24 行是极常见的默认 ——
   * 一点富余都没有,再多一行提示就溢出。减 8 是给边框、表头、提示、以及 /et 上方
   * REPL 里的其它内容留的余量。
   */
  const height = Math.max(3, props.maxRows ?? Math.min(20, Math.max(6, termRows - 8 - reserved)))
  /**
   * 详情页能用多少个终端行。
   *
   * 模态槽里可以吃满(那个槽给的已经是可用值);非全屏时留 8 行余量 —— `/et` 渲染在
   * 对话流里,帧高一旦超过视口,上面那个 1s tick 每跳一次就逼出一次整屏重置,而且被
   * 切掉的是**顶部**(标题和目标),和全屏正好相反。
   */
  const detailRows = Math.max(10, (inModal ? termRows : termRows - 8) - reserved)
  // The tree grows while it runs, so a cursor parked past the end must not render a blank
  // selection — clamp on every paint rather than trying to fix it up on each mutation.
  const idx = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1)
  const current = rows[idx]?.node
  const detail = detailId ? props.nodes.find(n => n.id === detailId) : undefined

  useInput((input, key) => {
    const k = input.toLowerCase()
    /**
     * Shift+R —— **两种写法都要认**。
     *
     * kitty 键盘协议 / modifyOtherKeys 的终端送的是 `ESC[82;2u`,而仓库自己的 parse-keypress
     * 把它解成 `input='r', shift=true`;传统终端送的是裸 `R`。只判 `input === 'R'` 的话,
     * 在 iTerm / kitty / WezTerm / ghostty / tmux / Windows Terminal 上(`ink.tsx` 正是在这些
     * 终端里写 ENABLE_KITTY_KEYBOARD)这个键会掉到下一行的 `k === 'r'` 上 —— 用户按 R
     * 拿到的是「自己选环节」那个三屏菜单,而快速重做这个键彻底消失。评审用真的
     * parse-keypress 送序列复现过。
     *
     * 同一个仓库已经为**同一件事**双写过两次(`logView.logPaneAction` 的 `c === 'g' &&
     * key.shift`、`ScrollKeybindingHandler` 同款),这里跟着来。
     */
    const shiftR = input === 'R' || (k === 'r' && key.shift === true)
    // Detail view owns Esc/q/Enter while it is open; only after it closes do those keys mean
    // "leave the panel" again.
    if (detail) {
      /**
       * **带修饰键的那一下不算这里的动作键。**
       *
       * 这一段每一条判的都是**裸小写字符**,而 `internal_exitOnCtrlC` 在这个 fork 里是
       * false(`main.tsx` 的 `getRenderContext(false)`),于是 `use-input.ts` 把 Ctrl+C
       * **原样派发**给每一个监听者;`input-event.ts` 对带 ctrl 的键给出的 `input` 又正是
       * 键名本身。两件事合起来的实测后果:
       *  - **Ctrl+C 打开「清理已完成工作区」关口**(下面那条 `k === 'c'`);
       *  - **Ctrl+Q 走 `onExitKey` —— 运行视图里那是 abort 整个 run**;
       *  - Ctrl+R / Ctrl+F / Ctrl+S 各自打开重做 / 强制通过 / 跳过关口。
       * 而 Ctrl+D / Ctrl+U 本来是 `NodeDetail` 与 `AgentLogPane` 的半页滚动:`useInput` 是
       * 广播的,这里 `return` 并不阻断它们,所以挡掉之后那两个键逐字不变。
       *
       * **只许逐条与,不许写成分支开头的早退。** `key.meta` 对 **Escape 恒为真**
       * (`input-event.ts` 的 `meta: keypress.meta || keypress.name === 'escape' || …`),
       * 一句 `if (!plain) return` 会让 Esc 当场变成死键 —— 而下面那句注释立的规矩正是
       * 「Esc / q 任何时候都是返回,返回这条路不许有死角」。
       *
       * 树那一支(下面)不需要这一层:它的动作键走 `runControlAction`,那个函数第一句
       * 就是 `if (key.ctrl || key.meta) return null`。
       */
      const plain = key.ctrl !== true && key.meta !== true
      // 详情页是判断「这个节点到底哪儿错了」的地方 —— 看完就想重做,最不该逼用户先退回
      // 树上再按一次 r。快速重做和跳过同理,而且更是:详情页正是他刚看完阻断原因的地方。
      //
      // **`R` 要排在 `r` 之前**,而且判据要收两种终端写法(见 shiftR):下面那一句用的是
      // `k === 'r'`(已经 toLowerCase 过),所以 Shift+R 会先被它吃掉 —— 用户按 R
      // 拿到的是「自己选环节」那个三屏菜单,而快速重做这个键彻底消失。
      /**
       * **被拒时不关详情页,而且要说出来。**
       *
       * 这三个键的拒绝路径此前全是静默的:调用方把原因写进一个只有结束屏读的 state,
       * 而这里在调它之前就已经 `setDetailId(null)`。用户按下去看到的是「详情页关掉了、
       * 回到树上、什么都没发生」—— 报过来的原话是「按了 r 其实是没有效果」。
       *
       * 回一句话 = 被拒:留在详情页、把话画到页脚上。`undefined` = 调用方已经切屏了。
       */
      const act = (
        fn: ((n: TaskNode) => string | undefined) | undefined,
      ): boolean => {
        if (!fn) return false
        const why = fn(detail)
        if (why === undefined) { setDetailId(null); return true }
        setNotice({ nodeId: detail.id, text: why, kind: 'action' })
        return true
      }
      // 详情页是判断「这个节点到底哪儿错了」的地方 —— 看完就想重做,最不该逼用户先退回
      // 树上再按一次 r。快速重做和跳过同理,而且更是:详情页正是他刚看完阻断原因的地方。
      //
      // **`R` 要排在 `r` 之前**,而且判据要收两种终端写法(见 shiftR):下面那一句用的是
      // `k === 'r'`(已经 toLowerCase 过),所以 Shift+R 会先被它吃掉。
      if (plain && shiftR && props.onRedoFailed) { act(props.onRedoFailed); return }
      if (plain && k === 's' && props.onSkipFailed) { act(props.onSkipFailed); return }
      if (plain && k === 'f' && props.onForcePass) { act(props.onForcePass); return }
      if (plain && k === 'r' && props.onRedo) { act(props.onRedo); return }
      // 一键回收已完成子任务的工作区。关口自己会先扫一遍再让用户确认,所以这里不判
      // 「有没有东西可清」—— 那需要跑 git,而按键处理里不能等。
      if (plain && k === 'c' && props.onCleanupWorktrees) { setDetailId(null); props.onCleanupWorktrees(detail); return }
      // 依赖重算。**被拒时不清 detailId** —— 那是它最常见的结局,而被拒的语义是
      // 「什么都没发生」。拒绝理由渲染在详情页自己那一段里(见 onRecalcDeps)。
      if (plain && k === 'd' && props.onRecalcDeps) {
        const why = props.onRecalcDeps(detail)
        setNotice(why === undefined ? undefined : { nodeId: detail.id, text: why, kind: 'recalc' })
        return
      }
      // 页脚按键提示翻页:一屏放不下的键不再消失,而是等下一页(见 paginateHints)。
      if (plain && input === '?') { setHintPage(x => x + 1); return }
      // 任何**别的**键都把上一条提示清掉 —— 它描述的是上一次按键的结果。
      if (noticeRef.current !== undefined) setNotice(undefined)
      if (key.return && detailZone.current === 'tabs') return
      if (key.return || key.escape || (plain && k === 'q')) setDetailId(null)
      return
    }
    if (key.escape || k === 'q') { props.onExitKey?.(); return }
    if (rows.length === 0) return
    // 重做。放在方向键**之前**,因为它不依赖 rows 之外的任何东西,而且放后面会被
    // 下面那些 `return` 挡掉一半路径。
    // `R`(快速重做失败环节)排在 `r` 前面,理由见详情页那一支:`k` 已经小写过了。
    /**
      * 树上按这几个键被拒时**同样不许静默** —— 理由和详情页那一支逐字相同,只是这里
      * 没有详情页可留,话画在页脚上(下一次按键清掉)。
      */
    const actHere = (fn: ((n: TaskNode) => string | undefined) | undefined): boolean => {
      if (!fn || !current) return false
      const why = fn(current)
      if (why !== undefined) setNotice({ nodeId: current.id, text: why, kind: 'action' })
      return true
    }
    if (shiftR && props.onRedoFailed && current) { actHere(props.onRedoFailed); return }
    if (k === 's' && props.onSkipFailed && current) { actHere(props.onSkipFailed); return }
    if (k === 'f' && props.onForcePass && current) { actHere(props.onForcePass); return }
    if (k === 'r' && props.onRedo && current) { actHere(props.onRedo); return }
    // 页脚提示翻页。放在方向键之前,和上面那几个键同一档。
    if (input === '?' && key.ctrl !== true && key.meta !== true) { setHintPage(x => x + 1); return }
    // 运行中的人工干预。同样放在方向键之前,同样的理由。
    if (props.runControl) {
      const act = runControlAction(input, key)
      if (act === 'togglePause') { props.runControl.onTogglePause(); return }
      if (act === 'addDirective') { props.runControl.onAddDirective(); return }
      if (act === 'cancelNode') {
        // 终态节点没什么可取消的。不挡的话会给一个「已取消」的错觉,而它早就跑完了。
        if (current && !isTerminal(current.status)) props.runControl.onCancelNode(current)
        return
      }
      // 没接这两个键时**不吞掉它们** —— 落下去也没有别的处理者,但吞掉等于把
      // 「这个键在这一屏没有意义」变成「这个键坏了」,而两者在排查时差别很大。
      if (act === 'raiseParallelism' && props.runControl.onAdjustParallelism) {
        props.runControl.onAdjustParallelism(1)
        return
      }
      if (act === 'lowerParallelism' && props.runControl.onAdjustParallelism) {
        props.runControl.onAdjustParallelism(-1)
        return
      }
      // 同上那条「没接就不吞掉」的规矩。
      if (act === 'raiseStrictness' && props.runControl.onAdjustStrictness) {
        props.runControl.onAdjustStrictness(1)
        return
      }
      if (act === 'lowerStrictness' && props.runControl.onAdjustStrictness) {
        props.runControl.onAdjustStrictness(-1)
        return
      }
    }
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
  }, { isActive: props.interactive === true && props.suspended !== true })

  if (detail) {
    return (
      <NodeDetail
        canRedo={props.onRedo !== undefined}
        // 同一条规矩:只在这个节点真的失败了时才写这两个键(见页脚那一行的注释)。
        canRedoFailed={props.onRedoFailed !== undefined && detail.status === 'BLOCKED'}
        canSkipFailed={props.onSkipFailed !== undefined && detail.status === 'BLOCKED'}
        // 这个键**不看节点状态**:清的是整棵子树里已验收的那些,而一个还在跑的父节点
        // 底下完全可以已经躺着十个跑完的子任务 —— 那正是长跑途中最想按它的时刻。
        canCleanup={props.onCleanupWorktrees !== undefined}
        // 判据形状抄上面 canRedoFailed 那一条:回调给了 **且** 这个节点此刻真的能按。
        /**
   * 判据必须是**真的准入**,不是 `status === 'CREATED'`。
   *
   * 准入有八条,而 CREATED 只是其中一条:零依赖、依赖还没拆子任务、依赖已全部完成 ——
   * 这三种最常见的形态下节点都还是 CREATED,提示照写,按下去必被拒。而 `depsBody` 上面
   * 那行注释自己写着「一个按了必然被拒的提示比没有更糟」。
   */
        canRecalcDeps={props.recalcAvailable?.(detail) === true}
        // 只画属于**这个**节点的那一条。
        recalcNotice={notice?.nodeId === detail.id && notice.kind === 'recalc' ? notice.text : undefined}
        actionNotice={notice?.nodeId === detail.id && notice.kind === 'action' ? notice.text : undefined}
        hintPage={hintPage}
        canForcePass={props.onForcePass !== undefined}
        node={detail}
        elapsed={elapsed(detail, nowMs)}
        maxRows={detailRows}
        onState={s => { detailZone.current = s.zone }}
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
  /**
   * 「这一轮为什么在重做」—— 派生的,不是状态(见 tools/efftask/reworkReason.ts)。
   *
   * 在这里算一次而不是在渲染里逐行算:`cost` 要先知道哪些行会多占一个终端行,而那正是
   * 这一格有没有内容决定的 —— 两处各算一遍就是两份判据,而不一致的那一次会让窗口预算
   * 算错、把底部的按键提示顶出屏幕(`budgetedViewport` 的注释里量过这笔账)。
   */
  const rework = new Map<string, string>()
  for (const r of rows) {
    const line = reworkLine(r.node)
    if (line) rework.set(r.node.id, line)
  }
  const cost = rows.map(r => (activity.has(r.node.id) || rework.has(r.node.id) ? 2 : 1))
  const view = budgetedViewport(rows, cost, idx, height)
  const counts: Record<UiStatus, number> = { done: 0, running: 0, queued: 0, failed: 0 }
  for (const n of props.nodes) counts[uiStatus(n.status)]++
  const mouse = currentMouseAvailability()
  const total = runUsage(props.nodes)
  /**
   * 树行**真正**能用多少列。
   *
   * `columns` 是终端宽度,而这个面板整个包在 `<Box borderStyle="round" paddingX={1}>`
   * 里:左右边框各 1 列、左右内边距各 1 列,一共少 4 列。拿裸 `columns` 去算的后果
   * 评审用真渲染量到了 —— 70 列时行末的用量标记被 truncate-end 从右边啃掉一半,
   * 屏幕上显示的是 `⇅12/3…`:**一个错的数字**,而不是一个被截断的数字。
   *
   * (这 4 列的差在加用量标记之前就在,一直在啃 `elapsed`;新标记只是把它顶成了
   * 「显示一个错数」这种更糟的形态。)
   */
  const rowWidth = Math.max(10, columns - 4)
  /** 光标停在失败节点上时才写这两个键 —— 理由在页脚那一行的注释里。 */
  const onFailedNode = current?.status === 'BLOCKED'
  /**
   * `f` 的措辞跟着**光标所在节点的状态**换,因为这个键在两种节点上做的是两件事:
   * 失败节点上是「覆盖那次不通过」,运行中节点上是「预先批准接下来某一关」。
   * 写死一句的话,总有一半的时候页脚在说另一件事 —— 而这一行是用户唯一的说明书。
   */
  const forcePassHint = props.onForcePass
    ? (onFailedNode ? ' · f 强制通过它' : current && !isTerminal(current.status) ? ' · f 预先批准' : '')
    : ''
  const failedKeysHint =
    (onFailedNode && props.onRedoFailed ? ' · R 重做失败环节' : '') +
    (onFailedNode && props.onSkipFailed ? ' · s 跳过它' : '') +
    forcePassHint
  // 子树合计要按 id 找孩子。建一次给整屏用 —— 每行各建一个是 O(行 × 节点)。
  const byId = new Map(props.nodes.map(n => [n.id, n]))

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        高效任务 · run {props.runId}{'  '}
        <Text color="success">✓{counts.done}</Text> <Text color="warning">◐{counts.running}</Text>{' '}
        <Text color="inactive">○{counts.queued}</Text> <Text color="error">✗{counts.failed}</Text>
        {/* 并行占用 n/N (spec §10.1). The POOL's occupancy, which includes the reviewers a
            roundtable is running — that is the number the confirmation gate capped. */}
        {props.pool ? <Text dimColor>{'  '}并行 {props.pool().inUse}/{props.pool().limit}</Text> : null}
        {/* 「这个数能调」写在这个数**旁边**。页脚那一行在 80 列上早就被截掉右半截了
            (实测带 runControl 时整行 123 列),把一个新键塞进去等于让它在最常见的宽度上
            看不见;而这里紧挨着它要改的那个数字,4 列就够。 */}
        {props.pool && props.runControl?.onAdjustParallelism && columns >= HEADER_HINT_MIN_COLUMNS
          ? <Text dimColor>{' '}+/-</Text>
          : null}
        {/* 严格度。**和并行度同一条规矩:键位提示紧挨着它要改的那个东西。**
            没设档位时整段不画 —— 印一个「严格度 未设」会让一个从来没用过这个旋钮的用户
            以为自己漏配了什么,而不设档正是默认且完全正常的形态。 */}
        {props.runControl?.strictness
          ? <Text dimColor>{'  '}严格度 {props.runControl.strictness}
            {props.runControl.onAdjustStrictness && columns >= HEADER_HINT_MIN_COLUMNS ? ' </>' : ''}</Text>
          : null}
        {props.serialExecute === true
          ? <Text color="warning">{'  '}执行串行(无隔离工作区)</Text>
          : null}
        {/* 这一趟一共花了多少。表头是唯一一个「不用挑节点就看得到全局」的位置,而
            「这次跑掉了多少钱」正是一个人在树上第一眼想确认的事。空的时候整段不画 ——
            还没有任何调用时印一个 `0 次 · 0` 只是噪音。 */}
        {/* 窄终端上**整段不画**:表头是 wrap 的,多这一截会把它挤成两行,而
            「面板高度 = 边框 2 + 表头 1 + height + 提示」是下面行预算的前提 ——
            多一行就把底部的图例和按键提示顶出屏幕。行末那个标记已经有同样的让路规矩。 */}
        {isEmptyUsage(total) || columns < HEADER_USAGE_MIN_COLUMNS ? null : (
          <Text dimColor>{'  '}⇅{total.calls} 次 · {(total.estimated ?? 0) > 0 ? '≈' : ''}{formatTokens(totalTokens(total))} tokens</Text>
        )}
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
        const base = ` [${n.status}]${n.mergeConflict === true ? ' 待人工解冲突' : ''} ${elapsed(n, nowMs)}${reworkMarker(n)}${scoreTag(n)}${hidden}`
        /**
         * 用量标记**放得下才画**。
         *
         * 这一行已经很挤,而 `room` 的下限是 6 列 —— 硬加一段 11 列的后缀,窄终端上换来的
         * 是把标题夹成两三个字,也就是用「花了多少」换掉「这是哪个任务」。宽松时给,
         * 紧张时不给,和这个文件里鼠标提示的两级降级是同一条规矩。
         */
        const tag = usageTag(n, byId)
        const roomWith = rowWidth - (8 + depth * 2) - stringWidth(base + tag)
        const usage = tag && roomWith >= MIN_TITLE_ROOM ? tag : ''
        const suffix = base + usage
        // stringWidth 而不是 .length:后缀里有中文(「待人工解冲突」7 个 UTF-16 单元、
        // 13 列),按 .length 算会少扣一半宽度,行照样溢出 —— truncate-end 就得替它兜,
        // 而从右边吃掉的正是状态和耗时。
        const room = rowWidth - (8 + depth * 2) - stringWidth(suffix)
        const title = clipToWidth(n.title, Math.max(6, room))
        return (
          <Box
            key={n.id}
            flexDirection="column"
            flexShrink={0}
            /**
             * 点这一行 = 在这一行上按回车:先把光标移过来,再打开详情。
             *
             * 挂在**每一行自己**的 Box 上,而不是在容器上挂一个再用 `event.localRow`
             * 反推行号 —— 命中测试本来就是取最深的那个节点(hit-test 反向遍历),
             * 而 localCol/localRow 只在 nodeCache 里有这个节点时才被填,反推等于给自己
             * 加一条会静默失效的假设。
             */
            onClick={() => { setCursor(i); setDetailId(n.id) }}
          >
            {/* truncate-end,不让长标题回流成两行:一行一个终端行是 budgetedViewport 的
                前提,行数一旦对不上,底部的计数和按键提示就会被顶出屏幕。 */}
            <Text color={COLOR[ui]} inverse={selected} wrap="truncate-end">
              {selected ? '❯' : ' '}
              {'  '.repeat(depth)}
              {fold} {GLYPH[ui]} {kindGlyph(n)} {title}{' '}
              <Text dimColor>
                [{n.status}]{n.mergeConflict === true ? ' 待人工解冲突' : ''} {elapsed(n, nowMs)}{reworkMarker(n)}{scoreTag(n)}{hidden}{usage}
              </Text>
            </Text>
            {/* 「此刻在调什么工具」—— 不用进详情视图就答得上来。1s 采样,不承诺逐条。
                没有活动时,同一格改说「这一轮为什么在重做」。
                **两者共用一行**,不是各占一行:行数是 `cost` 里那个 1/2 的前提,而
                「面板高度 = 边框 2 + 表头 1 + height + 提示」再多一行就把底部的图例和
                按键提示顶出 24 行的屏幕。活动更新更快、也更当下,所以它优先。 */}
            {act || rework.get(n.id) ? (
              <Text dimColor wrap="truncate-end">
                {'   '}{'  '.repeat(depth)}⎿ {act || rework.get(n.id)}
              </Text>
            ) : null}
          </Box>
        )
      })}
      {props.interactive === true ? (
        // 图例和按键**同一行**:面板高度 = 边框 2 + 表头 1 + height 20 + 提示,
        // 多一行就是 25 行,而 24 行是极常见的默认 —— 底部的计数和提示会被顶出去。
        // 分隔符不用 '·':「待定」那个字形本身就是 '·',读起来会变成三项。
        <Text dimColor wrap="truncate-end" color={notice ? 'warning' : undefined}>
          {notice !== undefined
            // 上一次动作键被拒的原因**盖住键位提示** —— 用户刚按了键、什么都没发生,
            // 而这一行是他唯一会看的地方。下一次按键清掉。
            ? `⚠ ${notice.text}`
            : props.suspended === true
            // 不说的话,用户会按着方向键发现树不动,以为界面卡死了。
            ? '⏸ 等你回答上面那个权限确认 —— 这期间按键归它'
            /**
             * 鼠标**只在真的能点的时候才提**。
             *
             * 不能点时这里一个字都不多写 —— 原因有两条:
             *  1. 承诺一个按了没反应的 affordance 比没有更糟(这条这个仓库付过好几次学费);
             *  2. 这一行已经很挤,而它是 `wrap="truncate-end"` —— 多塞一句「需要开全屏」
             *     会把右边的 `Esc/q 退出` 直接吃掉,也就是用「解释一个用不了的功能」
             *     换掉「怎么退出去」。
             * 「为什么点不了」由详情页页签条右侧那个专门的位置来说,那里有地方。
             */
            /**
             * `R` / `s` **只在光标停在一个失败节点上时才写**:它们对一个没失败的节点本来就
             * 不可用(按下去只会得到一句「这个任务没有失败」),而一个按了只会被拒绝的键
             * 和一个按了没反应的键一样糟。
             */
            /**
             * **「怎么出去」排在最前面。**
             *
             * 这一行是 `wrap="truncate-end"`,而它在真实宽度上一定会被截。评审用真渲染量到
             * 出口原来排在**末尾**的两个后果:
             *  - 运行中(带 p/i/x 那一截)整行 123 列,**60~126 列上一律没有 `Esc/q 退出`**;
             *  - 光标从一个正常节点移到一个失败节点,`R`/`s` 两句话一进来,100 列上
             *    `Esc/q 退出` 当场消失 —— 移一下光标就把出口弄丢了。
             *
             * 所以次序按「被截掉的先后」定,不按「读起来顺」:
             * 出口 → 干预/动作键 → 导航 → 图例。图例最先被吃掉是对的 —— 它是三个字形的
             * 说明,不是一件能做的事。
             */
            : paginateHints([
              'Esc/q 退出',
              ...(props.runControl
                ? [
                  props.runControl.paused ? '⏸ 已暂停(p 恢复)' : 'p 暂停',
                  'i 追加指令', 'x 取消选中任务',
                  ...(props.runControl.onAdjustStrictness ? ['<> 严格度'] : []),
                ]
                : []),
              ...(props.onRedo ? ['r 重做'] : []),
              ...(onFailedNode && props.onRedoFailed ? ['R 重做失败环节'] : []),
              ...(onFailedNode && props.onSkipFailed ? ['s 跳过它'] : []),
              ...(forcePassHint ? [forcePassHint.replace(' · ', '')] : []),
              '↑↓/jk 移动', '←/→ 折叠', '空格切换', detailEntryHint(mouse),
              `${KIND_GLYPH.decompose}拆分 ${KIND_GLYPH.executable}执行 ${KIND_GLYPH.unknown}待定`,
            ], rowWidth, hintPage).text}
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
