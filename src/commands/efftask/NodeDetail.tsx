import * as React from 'react'
import { Box, Text, useInput, useTheme } from '../../ink.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus } from '../../tools/efftask/stateMachine.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import { AgentLogPane } from './AgentLogPane.js'
import { ScrollPane } from './ScrollPane.js'
import {
  anchoredFrom,
  clipToWidth,
  scrollWindow,
  sectionLines,
  sectionPaneAction,
  detailLayout,
  collapsedLinesFor,
  MIN_DETAIL_WIDTH,
  sectionCursor,
  tabFocused,
  mouseHint,
  type LogAnchor,
  type SectionSpec,
} from './logView.js'
import { formatTokens, isEmptyUsage, subtreeUsage, totalTokens, type UsageTotals } from '../../tools/efftask/usage.js'
import { currentMouseAvailability } from './mouseEnv.js'
import { useLiveState } from './useLiveState.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js'

const COLOR = { done: 'success', running: 'warning', queued: 'inactive', failed: 'error' } as const

/**
 * 两个页卡。
 *
 * **是数据,不是两段写死的 JSX。** 这个文件已经为同一条论证改过一次(段落列表),
 * 原话是:「哪一段被选中、哪一段展开着」需要按下标寻址。页卡一模一样 —— 页签条要枚举它们、
 * 点击要知道自己是第几个、页脚要按当前页卡换文案。加第三个页卡的成本是这个数组里加一行。
 */
export const DETAIL_TABS = [
  { id: 'task', title: '任务' },
  { id: 'log', title: '子 agent 输出' },
] as const
export type DetailTabId = (typeof DETAIL_TABS)[number]['id']

/** 焦点在页签条上,还是在内容区里。 */
export type DetailZone = 'tabs' | 'content'

/**
 * 观察评分, with the reasons — spec §10.2 lists 评分 among the detail view's contents.
 *
 * It was computed, persisted to node.md's frontmatter and then shown NOWHERE: the tree row
 * omitted it and this view omitted it, so a user who configured an observer got a number
 * that only existed on disk.
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

/**
 * 模型用量 (用户原话:「每个任务都要统计模型调用次数和消耗 token,有子任务的要计算所有
 * 子任务的总量」)。
 *
 * 两行,而且**只有真的分得开时才画第二行**:一个叶子节点的「本节点」和「含子任务」永远
 * 相等,画两行相同的数字只会让人怀疑自己看错了。
 *
 * 缓存读写单列:命中缓存的输入在计费上便宜一个数量级,把它并进 input 会让一个高度复用
 * 上下文的运行看起来贵得离谱。
 */
export function usageBody(n: TaskNode, resolveNode?: (id: string) => TaskNode | undefined): string {
  const own = n.usage
  const line = (label: string, u: UsageTotals): string => {
    const parts = [`${u.calls} 次调用`, `${formatTokens(totalTokens(u))} tokens`]
    if (u.input > 0 || u.output > 0) parts.push(`输入 ${formatTokens(u.input)} / 输出 ${formatTokens(u.output)}`)
    if (u.cacheRead > 0 || u.cacheWrite > 0) parts.push(`缓存 读 ${formatTokens(u.cacheRead)} / 写 ${formatTokens(u.cacheWrite)}`)
    return `${label}: ${parts.join(' · ')}`
  }
  const rows: string[] = []
  if (!isEmptyUsage(own)) rows.push(line('本节点', own!))
  if (n.childIds.length > 0) {
    // resolveNode 缺席时**不画这一行**,而不是画一个等于自己的合计 —— 后者是一句假话:
    // 这个节点明明有子任务,数字却把它们全漏了,而屏幕上看不出漏了。
    if (resolveNode) {
      const all = subtreeUsage(n, resolveNode)
      if (!isEmptyUsage(all)) rows.push(line(`含 ${n.childIds.length} 个子任务合计`, all))
    } else if (rows.length > 0) {
      rows.push(`(子任务用量本屏取不到)`)
    }
  }
  return rows.join('\n')
}

/** 评审 / 验收记录:每轮一行。 */
function roundsBody(log: TaskNode['reviewLog']): string {
  return log
    .map(r => `第 ${r.round} 轮 ${r.synthesized.pass ? '通过' : '未通过'}${r.synthesized.blockingSummary ? ': ' + r.synthesized.blockingSummary : ''}`)
    .join('\n')
}

/**
 * 依赖 (spec §10.2). Missing deps are REPORTED, not hidden: a dangling id is why the node is
 * blocked, and silently shrinking the list would hide the cause.
 */
function depsBody(n: TaskNode, resolveNode?: (id: string) => TaskNode | undefined): string {
  return n.deps
    .map(id => {
      // No resolver at all is NOT "the node is missing" — it is "the caller did not wire one".
      // Reporting the first as the second is precisely the class of lie this repo keeps paying
      // for, so an unwired pane degrades to bare ids and only a resolver that ANSWERS undefined
      // reports a missing node.
      if (!resolveNode) return id
      const d = resolveNode(id)
      return d ? `${d.title}(${d.status})` : `${id}(节点缺失)`
    })
    .join('\n')
}

/**
 * 「任务」页卡的全部段落。**纯函数**,和渲染分开。
 *
 * 分开不是洁癖:详情页现在是一个会滚动的窗口,屏幕上任何时刻都只有其中一屏 ——
 * 「评审记录这一段在不在」这类断言如果只能从帧里找,就会变成「它有没有恰好滚到可视区」,
 * 而那和它存不存在是两件事。段落是数据,可视区是另一回事。
 *
 * 空 body 的段落**不进列表**:选中一个什么都没有的「风险点」是死格。
 */
export function detailSections(
  n: TaskNode,
  resolveNode?: (id: string) => TaskNode | undefined,
): SectionSpec[] {
  const all: SectionSpec[] = [
    // 依赖排在最前,和改造之前的版面一致 —— 一个节点停在 READY 不动时,人是为这一段来的。
    // 机器生成的几段(依赖 / 评分 / 迭代 / 耗时 / 用量 / 工作区)**不上 markdown**:
    // 里面是 id、路径、`[STATUS]`、`--flag`,交给 markdown 解析器只会被吃掉记号。
    { title: '依赖', body: depsBody(n, resolveNode) },
    // 以下都是模型写的散文,而且模型本来就在写 markdown。
    { title: '目标', body: n.goal, md: true },
    { title: '完整方案', body: n.plan.solution, md: true },
    { title: '重点', body: n.plan.keyPoints, md: true },
    { title: '风险点', body: n.plan.risks, md: true },
    { title: '验收点', body: n.plan.acceptance, md: true },
    { title: '执行状态', body: n.execStatus, md: true },
    // 红色是**语义**(这是把节点挡下来的那条),不能被 markdown 的行内颜色顶掉。
    { title: '阻断原因', body: n.blockedReason, color: 'error' },
    { title: '评分', body: scoreBody(n) },
    { title: '迭代次数', body: iterationBody(n) },
    { title: '各阶段耗时', body: phaseTimeBody(n) },
    // 紧挨着耗时:两者回答的是同一个问题的两半 ——「这个节点贵在哪」。
    { title: '模型用量', body: usageBody(n, resolveNode) },
    // 每轮一行的骨架是我们拼的,但 blockingSummary 是评审员写的散文 —— 上色的收益
    // (「[架构] **缺回滚**」里的重点看得见)大于骨架被解析的风险(骨架里没有记号)。
    { title: '评审记录', body: roundsBody(n.reviewLog), md: true },
    { title: '验收记录', body: roundsBody(n.acceptLog), md: true },
  ]
  if (n.worktree) all.push({ title: '隔离工作区', body: `${n.worktree.branch}\n${n.worktree.path}` })
  return all.filter(s => s.body.trim().length > 0)
}

/**
 * 一个节点,满屏,两个页卡 —— 「回车进入看更多任务细节」那一屏。
 *
 * ## 高度从哪来(这里错一个数就会静默丢内容)
 *
 * 全屏模式下 `/et` 是 local-jsx,渲染在 FullscreenLayout 的 **modal 槽**里,而那个槽给的是
 * `rows - 3` / `columns - 4`,外面还罩着 `overflow="hidden"`。所以尺寸走
 * `useModalOrTerminalSize`(仓库为这件事写的钩子),不是裸的 `useTerminalSize` ——
 * 后者会**恒定多算 3 行**,而多出来的部分是从**底部**剪掉的,第一个被剪掉的正是
 * 用户点名要的那条页签条。
 *
 * 非全屏时**不做满屏**:`/et` 渲染在对话流里,帧高一旦超过视口,任务树那个 1s tick
 * 每跳一次就逼出一次整屏重置(实测 29 行终端 + 长历史下 10 分钟 507 次),而且被切掉的
 * 是**顶部**(标题和目标)—— 和全屏正好相反。所以非全屏留 8 行余量,和任务树面板一致。
 *
 * ## 为什么自己切片,而不是给 Box 一个 height 就完事
 *
 * 实测:带 height 的 Box 里,超量子节点会被 yoga **按比例压缩**而不是裁掉 ——
 * 50 行塞进 10 行拿到的是 `L004,L009,L014,…`,而且标题行本身也一起消失。
 * 所以行数必须自己算准、自己切片,每一行 `flexShrink={0}`,`height` 只当最后一道保险。
 */
export function NodeDetail(props: {
  node: TaskNode
  elapsed: string
  /**
   * 这一屏能用多少个终端行。**由调用方声明**,不由本组件猜。
   *
   * 两个调用方的可用高度不一样:运行视图里面板独占屏幕,而完成视图在树的**下面**还画着
   * 一个总结框(收口结果 / 后续动作 / 重做遗留问题),行数运行时可变。组件看不见那个框。
   */
  maxRows?: number
  /** 子 agent 实时输出:每次模型调用一条流,带署名。 */
  streams?: readonly StreamState[]
  /** 这个节点一共有多少输出没能留下来(环形缓冲 + 被收起的窗口)。 */
  droppedEvents?: number
  /** 这个节点是 --resume 带进来的:没有流 ≠ 什么都没干。 */
  historical?: boolean
  /** 本屏是否接管键盘。 */
  logActive?: boolean
  /** 日志窗自己的状态 —— 用来断言「页卡焦点真的管住了它的键盘」。 */
  onLogState?: (s: { selected: number }) => void
  /**
   * 焦点状态的观测口。
   *
   * 这个渲染器只写**增量**,一次光标移动在帧里是几个分散的片段,按子串断言既脆又容易恒真。
   * 测试要的是「焦点到底在哪」,那就把它直接交出来。
   *
   * `zone` 还有第二个用途,而且是**功能性**的:回车归 TaskTreePanel(返回任务树),
   * 只有焦点落在页签条上时才让路 —— 而那一让必须由 TaskTreePanel 自己做,
   * 因为 `useInput` 的 listener 槽位按 mount 时刻固定,它比本组件先挂、永远先跑。
   */
  onState?: (s: {
    zone: DetailZone
    tab: DetailTabId
    cursor: number
    expanded: string[]
    /**
     * 段落区**实际画出来的**光标下标;-1 = 没画(焦点不在它身上)。
     *
     * 和 `cursor` 是两件事:`cursor` 是「光标记在第几段」,这个是「屏幕上有没有画那个 ❯」。
     * 这三条接线(段落光标跟不跟焦点、页签反显、点页签换不换焦点)此前一条都没被钉住 ——
     * 把它们逐个改掉,全套 2150 条测试一条不红。而它们说的正是「别画一个『选中了、
     * 但按键不归它』的假象」,是这个仓库反复付学费的那类谎。
     */
    cursorShown: number
    /** 此刻反显的是哪几个页签(焦点真的落在页签条上时才有)。 */
    tabsInverse: string[]
    /**
     * 「任务」页卡此刻从第几行开始画。
     *
     * 和 AgentLogPane 的 onState 交出 from 是同一个理由,而且是同一个坑:滚动位置在这个
     * 仓库的 TTY 夹具里**根本观测不到** —— 渲染器只写增量,累积缓冲又把展开前后的两份
     * 画面混在一起。「展开一段之后视口跳没跳走」只能靠这个数来判。
     */
    from: number
  }) => void
  /** 这一屏能不能按 r 重做。键是父面板处理的,这里只负责**说出来**。 */
  canRedo?: boolean
  /** 可用列宽。省略则跟着终端/模态槽走。 */
  columns?: number
  /** Resolves a dependency id to its node, so 依赖 renders as titles and statuses. */
  resolveNode?: (id: string) => TaskNode | undefined
  /** 打开时停在哪个页卡。默认「任务」—— 进来先看目标和方案。 */
  initialTab?: DetailTabId
}): React.ReactElement {
  const n = props.node
  const [theme] = useTheme()
  const term = useTerminalSize()
  const { rows: availRows, columns: availCols } = useModalOrTerminalSize(term)
  const inModal = useIsInsideModal()
  const ui = uiStatus(n.status)

  /**
   * 非全屏时**留 8 行余量**,不吃满 rows。
   *
   * `/et` 渲染在对话流里,帧高一旦超过视口,任务树那个 1s tick 每跳一次就逼出一次整屏
   * 重置(实测 29 行终端 + 长历史下 10 分钟 507 次),而且被切掉的是**顶部**(标题和
   * 目标)—— 和全屏正好相反。8 这个数和任务树面板用的是同一个。
   */
  const budget = Math.max(10, props.maxRows ?? (inModal ? availRows : availRows - 8))
  const { contentRows, paneRows, contentWidth } = detailLayout({
    budget,
    columns: props.columns ?? availCols,
    inModal,
  })

  const [zone, setZone, zoneRef] = useLiveState<DetailZone>('content')
  const [tab, setTab, tabRef] = useLiveState<DetailTabId>(props.initialTab ?? 'task')
  const [cursor, setCursor, cursorRef] = useLiveState(0)
  const [expanded, setExpanded, expandedRef] = useLiveState<ReadonlySet<string>>(new Set())
  const [, setAnchor, anchorRef] = useLiveState<LogAnchor>({ stream: 0, delta: 0 })

  const sections = detailSections(n, props.resolveNode)
  /**
   * 未展开的段落各留几行。
   *
   * 跟着内容区高度走,而不是写死:24 行的终端上每段 2 行(十几段刚好扫得完),
   * 大屏上每段能露出更多。下限 2 —— 一行标题一行正文,少于这个就不叫「摘要」了。
   */
  /**
   * 下限是 **3**,不是 2。
   *
   * 掐头留尾要占三行:头 1 + 「… 中间省略 N 行」1 + 尾 1。只给 2 行时头会被挤掉,
   * 24 行终端上每一段都长成「… 中间省略 59 行」+ 一条从中间切开的续行碎片 ——
   * 零信息量,而那正是用户第一次打开详情页看到的东西。
   */
  const collapsedLines = collapsedLinesFor(contentRows)
  // 滚动条占一列。
  const { lines: secLines, headerAt } = sectionLines({
    sections,
    cursor: sectionCursor(zone, tab === 'task', cursor),
    expanded,
    width: contentWidth - 1,
    collapsedLines,
    theme,
  })
  const secTotal = secLines.length
  const secFrom = scrollWindow(
    secTotal,
    paneRows,
    anchoredFrom(secTotal, paneRows, anchorRef.current, headerAt),
  ).from

  React.useEffect(() => {
    props.onState?.({
      zone, tab, cursor, expanded: [...expanded].sort(), from: secFrom,
      // 交的是**画出来的样子**,不是 state 里的意图 —— 见上面 cursorShown 的注释。
      cursorShown: sectionCursor(zone, tab === 'task', cursor),
      tabsInverse: DETAIL_TABS.filter(t => tabFocused(zone, t.id === tab)).map(t => t.id),
    })
  })

  useInput((input, key) => {
    const act = sectionPaneAction(input, key)
    if (!act) return
    /** 把「我想让视口停在第 n 行」翻译成锚(相对当前选中段落的标题行)。 */
    const anchorAt = (line: number): LogAnchor => {
      const i = cursorRef.current
      const at = headerAt(i)
      return { stream: i, delta: at >= 0 ? line - at : line }
    }
    if (act.t === 'tab') {
      const i = DETAIL_TABS.findIndex(t => t.id === tabRef.current)
      const next = DETAIL_TABS[(i + act.d + DETAIL_TABS.length) % DETAIL_TABS.length]!
      setTab(next.id)
      return
    }
    if (act.t === 'switchZone') {
      setZone(zoneRef.current === 'tabs' ? 'content' : 'tabs')
      return
    }
    /**
     * 焦点在页签条上时,回车和空格都是「进入内容区」—— 用户原话「最下面点击或回车
     * 可选择不同的页卡内容展示」的那一半。
     *
     * **必须排在下面那条内容区闸门之前**:空格走到闸门那里会被当成「展开段落」挡掉,
     * 回车更是连闸门都到不了。这两个键此前只写在页脚上、按下去什么都不会发生,而
     * TaskTreePanel 已经为回车让了路(不再关详情页)—— 于是它彻底消失。
     */
    if (zoneRef.current === 'tabs') {
      if (act.t === 'enterContent' || act.t === 'toggle') setZone('content')
      return
    }
    // 内容区里的回车不归这里 —— 它是任务树面板的「返回任务树」。原样放过去。
    if (act.t === 'enterContent') return
    // 剩下的键归**内容区**,而且只归「任务」页卡 —— 「子 agent 输出」页卡的键盘是
    // AgentLogPane 自己的 useInput 在管。两个 handler 会同时收到每一个键,
    // 不冲突全靠这一句 + 键位不重叠(logPaneAction 里 Tab 和左右箭头都是不认的)。
    if (tabRef.current !== 'task') return
    if (act.t === 'scroll') {
      const step = act.d * Math.max(1, Math.floor(paneRows / 2))
      const maxFrom = Math.max(0, secTotal - paneRows)
      setAnchor(anchorAt(Math.max(0, Math.min(maxFrom, secFrom + step))))
      return
    }
    if (act.t === 'move') {
      if (sections.length === 0) return
      const next = Math.max(0, Math.min(sections.length - 1, cursorRef.current + act.d))
      setCursor(next)
      // **切到哪,展示哪**:锚直接钉到那一段的标题行上。
      setAnchor({ stream: next, delta: 0 })
      return
    }
    const title = sections[cursorRef.current]?.title
    if (title === undefined) return
    const set = new Set(expandedRef.current)
    if (set.has(title)) set.delete(title)
    else set.add(title)
    setExpanded(set)
    // 展开/收起会让下面所有行整体位移,锚重新钉回这一段的标题 —— 否则视口当场跳走。
    setAnchor({ stream: cursorRef.current, delta: 0 })
  }, { isActive: props.logActive === true })

  const hasLog = (props.streams?.length ?? 0) > 0
  /**
   * `--resume` 带进来、又没有任何新流的节点:输出页卡上**根本没有日志窗**,只有一行说明。
   *
   * 页脚必须跟着变 —— 不变的话它会列出「n 换流 · 空格 折叠 · t 思考」一整排,而那一排
   * 此刻全是死键。验收实测抓到的:这一屏此前零覆盖,连那句说明被整个删掉都没人红。
   */
  const logPaneMounted = !(props.historical === true && !hasLog)
  const mouse = currentMouseAvailability()
  /** 页签条自己占多宽(每个页签两侧各一个空格)。用来决定右边还放不放得下鼠标说明。 */
  const tabsWidth = DETAIL_TABS.reduce(
    (w, t) => w + stringWidth(` ${t.title}${t.id === 'log' && hasLog ? `(${props.streams!.length})` : ''} `),
    0,
  )
  const mouseText = mouse === 'on' ? '可点击页签' : mouseHint(mouse)
  /**
   * 页脚。**「怎么出去」排在最前面。**
   *
   * 这一行是 `wrap="truncate-end"`,而窄终端上它一定会被截 —— 实测 100 列时
   * 「Esc/q 返回任务树」正好是被吃掉的那一截。把出口放在末尾,等于用「还有哪些花活」
   * 换掉了「怎么退出去」。截断只许吃掉最不重要的那一头。
   */
  const redoHint = props.canRedo ? ' · r 重做本任务' : ''
  const footer = ((): string => {
    if (zone === 'tabs') return `Esc/q 返回任务树${redoHint} · ←→ 选页卡 · 回车/空格 进入 · Tab 回内容`
    if (tab === 'log') {
      return logPaneMounted
        ? `Esc/q 返回任务树${redoHint} · ←→ 换页卡 · Tab 到页签 · ↑↓/jk 滚动 · g/G 顶部/底部 · n 换流 · 空格 折叠 · t 思考 · 耗时含等你批权限的时间`
        : `Esc/q 返回任务树${redoHint} · ←→ 换页卡 · Tab 到页签`
    }
    return `Esc/q 返回任务树${redoHint} · ←→ 换页卡 · Tab 到页签 · ↑↓/jk 选段落 · 空格 展开/收起 · ^u/^d 翻页`
  })()

  return (
    <Box
      flexDirection="column"
      // height 只是最后一道保险 —— 真正保证不溢出的是上面自己算出来的 contentRows。
      height={budget}
      borderStyle={inModal ? undefined : 'round'}
      paddingX={1}
    >
      <Box flexShrink={0}>
        <Text bold color={COLOR[ui]} wrap="truncate-end">{clipToWidth(n.title, contentWidth)}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {/* 树上用 ⊞ / ▪ 两个符号区分,这里有地方写字就直接写字。判据和树上那一处保持一致
              (见 TaskTreePanel.kindGlyph):同时看 childIds,因为动态生长会把子节点嫁接到
              一个已判 executable 的节点上。 */}
          {n.childIds.length > 0 || n.kind === 'decompose' ? '拆分任务' : n.kind === 'executable' ? '执行任务' : '待定'}
          {' · '}{n.id} · {n.status} · {props.elapsed}
          {n.childIds.length > 0 ? ` · 子任务 ${n.childIds.length} 个` : ''}
          {n.mergeConflict === true ? ' · 待人工解冲突' : ''}
        </Text>
      </Box>

      {/* 内容区。flexGrow 吃掉中间所有剩余高度,而它自己画的行数是上面算好的。 */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {contentWidth < MIN_DETAIL_WIDTH ? (
          /* 排不出可读的东西就明说,不要硬排 —— 硬排的结果是行回流、最后一行被静默剪掉,
             而帧的总行数一点没变(一个残缺的视图看起来完完整整)。 */
          <Box flexShrink={0}><Text color="warning" wrap="truncate-end">终端太窄</Text></Box>
        ) : tab === 'task'
          ? sections.length === 0
            ? <Text dimColor>这个节点还没有任何方案或执行记录。</Text>
            : (
              <ScrollPane
                slice={secLines.slice(secFrom, secFrom + paneRows)}
                total={secTotal}
                from={secFrom}
                height={paneRows}
                behind={Math.max(0, secTotal - paneRows - secFrom)}
                behindHint="↑↓ 继续,^d 翻页"
              />
            )
          : null}
        {/**
          * 输出页卡**常挂**,不活跃时把高度压成 0,而不是卸载掉。
          *
          * 卸载的代价是实打实的:滚动位置、选中哪条流、哪些流被展开、思考展开了没有 ——
          * 全在 AgentLogPane 自己的 useLiveState 里。切去看一眼方案再切回来,用户会发现
          * 自己刚挑好的那条流回到了第一条,而他没按过任何键。
          *
          * `isActive` 必须**同时**判 tab:它现在一直挂着,不判的话在「任务」页卡上按 n
          * 会在背后偷偷换流 —— 两个 useInput 都收得到每一个键。
          */}
        <Box
          flexDirection="column"
          overflow="hidden"
          {...(tab === 'log' ? { flexGrow: 1 } : { height: 0, flexShrink: 0 })}
        >
          {props.historical === true && !hasLog ? (
            <Text dimColor>子 agent 输出:属于上一次运行,事件流只在内存里、不落盘,看不到历史。</Text>
          ) : (
            <AgentLogPane
              streams={props.streams ?? []}
              droppedEvents={props.droppedEvents}
              historical={props.historical}
              height={contentRows}
              width={contentWidth}
              isActive={props.logActive === true && zone === 'content' && tab === 'log'}
              onState={s => props.onLogState?.({ selected: s.selected })}
            />
          )}
        </Box>
      </Box>

      {/* 页签条 + 页脚:同一个 flexShrink={0} 的底部块。
          **必须永远活过裁剪** —— 全屏下 modal 槽是从底部剪的,而用户点名要的就是
          「最下面点击或回车选页卡」。它一旦成为被剪掉的那一头,这个功能就等于不存在。 */}
      <Box flexShrink={0} flexDirection="row">
        {DETAIL_TABS.map(t => {
          const active = t.id === tab
          // 「(2)」会被读成「2 个子 agent」或「2 条输出」。它其实是**这个节点开过几次
          // 模型调用**(一次调用一条流,5 席圆桌下能到几十条,上限 40),所以把量纲写出来。
          const badge = t.id === 'log' && hasLog ? `(${props.streams!.length} 次调用)` : ''
          return (
            // 裸 Box + onClick,**不带 tabIndex**:带了的话 Tab 会同时轮转 DOM 焦点,
            // 而 Tab 在这一屏是「页签条 ⇄ 内容区」。写法抄 CoordinatorAgentStatus 的可点行。
            <Box key={t.id} flexShrink={0} onClick={() => { setTab(t.id); setZone('content') }}>
              <Text
                bold={active}
                inverse={tabFocused(zone, active)}
                color={active ? 'success' : undefined}
                dimColor={!active}
              >
                {` ${t.title}${badge} `}
              </Text>
            </Box>
          )
        })}
        <Box flexGrow={1} />
        {/* 鼠标说明。窄终端上**整个不画** —— 它会把这一行撑到回流成两行,而
            「一行 = 一个终端行」一旦破,下面的页脚就被顶出屏幕。宽度不够时宁可不解释。 */}
        {/* 放得下整句就说整句;放不下就退化成一个短标记 —— 但**不能什么都不说**。
            README 写着「具体原因写在页签条的右边」,而窄终端上那句话一度整个不画,
            于是「为什么点不动」在界面上哪儿都找不到。截断成半句更糟(会得到
            「鼠标需全屏模…」),所以是两级降级,不是 truncate。 */}
        {contentWidth - tabsWidth >= stringWidth(mouseText) + 1 ? (
          <Text dimColor wrap="truncate-end">{mouseText}</Text>
        ) : contentWidth - tabsWidth >= stringWidth(mouse === 'on' ? '可点' : '鼠标✗') + 1 ? (
          <Text dimColor wrap="truncate-end">{mouse === 'on' ? '可点' : '鼠标✗'}</Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">{footer}</Text>
      </Box>
    </Box>
  )
}
