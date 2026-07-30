import * as React from 'react'
import { Text, useInput, useTheme } from '../../ink.js'
import type { StreamState, StreamStore } from '../../tools/efftask/agentStream.js'
import { ScrollPane } from './ScrollPane.js'
import {
  anchoredFrom,
  budgetRows,
  foldedStreams,
  logPaneAction,
  logPaneMode,
  renderStreamLines,
  scrollWindow,
  droppedNotice,
  type LogLine,
  type LogAnchor,
  type LogPaneMode,
} from './logView.js'
import { useLiveState } from './useLiveState.js'

/**
 * 事件到屏幕的合批间隔。
 *
 * 不做盲轮询。设计稿第一版打算 400ms tick,并说「Ink 会 diff,相同帧不写终端所以不闪」——
 * 那个结论是错的:OffscreenFreeze 的注释写着,**视口之上的任何内容变化都会把 log-update
 * 推进一次整屏重置**(它没法局部更新已经滚出去的行),而表头带着秒数,帧根本不相同。
 * 实测记录是 1s tick 在 29 行终端 + 4000 行历史下,10 分钟 507 次整屏重置。
 *
 * 改成订阅 + 合批:**这个窗口自己**在静默期零重绘,有事件时 ≤250ms 上屏。
 *
 * 说清边界:任务树那个 1s tick(TaskTreePanel)**没有动** —— 只要还有节点在跑它就照跑,
 * 因为树上的耗时是按秒变的。所以「整屏静默期零重绘」并不成立,成立的是「日志窗没有在
 * 那之上再加一个轮询」。上面那段实测数据讲的是为什么不该再加一个。
 */
export const LOG_COALESCE_MS = 250

/**
 * 订阅事件流,合批地把宿主组件重绘一次。
 *
 * 放在**读 store 的那个组件**上,不是放在窗口自己身上:窗口拿到的 `streams` 是宿主在
 * render 期读出来的,窗口自己重绘并不会让宿主重新去读。
 */
export function useStreamTick(store: StreamStore | undefined, active: boolean): void {
  const [, setTick] = React.useState(0)
  const pending = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastAt = React.useRef(0)
  React.useEffect(() => {
    if (!store || !active) return
    const fire = (): void => {
      lastAt.current = Date.now()
      setTick(t => t + 1)
    }
    const off = store.subscribe(() => {
      /**
       * **首个事件立刻上屏**,后续才合批。
       *
       * 纯尾部合批(第一版)有个要命的后果:窗口开出来之后要等满一个 250ms 才第一次重绘,
       * 而「正在解析需求…」那次调用本身可能就几秒甚至更短 —— 屏一换,窗口一次都没画过,
       * 用户看到的是**全程什么都没有**。这正是「第一关第二关看不到子 TUI」的成因,
       * 挂载测试复现了它:tick 到期之前 phase 已经走了。
       *
       * 前沿触发 + 尾部合批:第一条事件零延迟,连续刷屏仍然按 250ms 收敛。
       */
      const now = Date.now()
      const since = now - lastAt.current
      if (since >= LOG_COALESCE_MS) { fire(); return }
      if (pending.current) return
      pending.current = setTimeout(() => {
        pending.current = undefined
        fire()
        // `- since` 不是微调,是这条前沿语义的另一半:写成固定的 LOG_COALESCE_MS,
        // 一条刚过完合批窗口的事件又要再等满 250ms。变异测试上这两处**必须一起**改回去
        // 才会变红 —— 只删上面那个 if,这一行照样让首个事件零延迟上屏。
      }, LOG_COALESCE_MS - since)
    })
    return () => {
      off()
      if (pending.current) {
        clearTimeout(pending.current)
        pending.current = undefined
      }
    }
  }, [store, active])
}

export interface AgentLogPaneProps {
  streams: readonly StreamState[]
  droppedEvents?: number
  historical?: boolean
  /** 窗口高度(行)。含不了表头就没意义,所以下限 4。 */
  height: number
  /** 可用列宽,含滚动条那一列。 */
  width: number
  /** 是否接管键盘。等待屏上的窗口是只读的。 */
  isActive?: boolean
  emptyHint?: string
  /** 仅供测试观测内部状态 —— 滚动位置在这个仓库的 TTY 夹具里根本看不见。 */
  onState?: (s: {
    from: number; total: number; follow: boolean; selected: number; folded: number[]; thinking: number[]
    /**
     * 此刻 ↑↓ 是在选阶段还是在滚内容。
     *
     * 交出来是因为它在帧里**看不见**:两种模式的画面可以逐像素相同(选中的表头一直是
     * 反显的),差别只体现在下一次按键做了什么。而「上下键到底归谁」正是这次改动的全部内容。
     */
    mode: LogPaneMode
  }) => void
}

/**
 * 子 agent 的实时终端窗口:可折叠、可滚动、带滚动条。
 *
 * 键位**刻意避开 Esc / q / 回车** —— 那三个键归详情视图(返回任务树)。vendored 的
 * `useInput` 把 listener 注册在 mount 时、`isActive` 只在 handler 内部判、而且不做
 * stopPropagation,所以两个 handler 会同时收到每一个键;不冲突全靠键位不重叠,
 * `logPaneAction` 里有一条测试专门钉这件事。
 */
export function AgentLogPane(props: AgentLogPaneProps): React.ReactElement {
  // markdown 上色要主题(行内代码那一档是主题色)。
  const [theme] = useTheme()
  // 「丢了多少」钉在滚动区之外,占一行 —— 它跟着滚的话会被粘底行为直接埋掉。
  const notice = droppedNotice(props.droppedEvents)
  /**
   * 「↓ 下面还有 N 行」那一行**也要从预算里扣**,而且**无条件**扣。
   *
   * 原来没扣,于是这个窗口实打印的行数比 `props.height` 多 1(不跟随时);再加上它自己
   * 那两行页脚(已删,见文件尾),最坏超 3 行。调用方按 height 排好的版面因此被顶掉
   * 最底下几行 —— 而详情页最底下正是页签条和页脚。
   *
   * 「跟随时不扣」看着更省地方,但它会让 height 随 follow 抖:不跟随 → height 变小 →
   * maxFrom 变大 → 到底的判据跟着变。恒定预留换来的是**恒定的可用行数**,跟随时空一行,
   * 代价远小于一个会自己伸缩的窗口。
   */
  const height = Math.max(4, Math.floor(props.height) - (notice ? 1 : 0) - 1)
  // 滚动条占一列。
  const contentWidth = Math.max(20, Math.floor(props.width) - 1)

  /**
   * 视口锚在**哪条流的表头 + 偏移几行**,而不是一个绝对行号。
   *
   * 用户报的:「切到某个阶段,上下键却在展示正在执行的那个子 agent 的数据」。
   * 绝对行号的问题是**它上方的内容一直在变**——一条流跑完就从展开变折叠,那几十行当场
   * 塌掉,同一个行号于是指向了别的流(通常正是还在动的那条)。锚在选中的流上就跟着它走。
   */
  const [, setAnchor, anchorRef] = useLiveState<LogAnchor>({ stream: 0, delta: 0 })
  const [, setFollow, followRef] = useLiveState(true)
  const [, setSelected, selectedRef] = useLiveState(0)
  /**
   * 用户**显式**改过的折叠状态。没记录的流按默认走:运行中展开,已收口折叠。
   *
   * 不能只存一个 `Set<number>`:流是一条条长出来的,一个纯集合分不清「用户展开了它」和
   * 「它还没被折过」,于是一条刚跑完的流会在用户眼皮底下自己收起来,或者反过来,一屏
   * 几千行全铺开。
   */
  const [, setOverride, overrideRef] = useLiveState<ReadonlyMap<number, boolean>>(new Map())
  /** 展开了思考原文的流。默认空 —— 思考会淹掉工具调用,但用户点名要看得到。 */
  const [, setThinking, thinkingRef] = useLiveState<ReadonlySet<number>>(new Set())


  /**
   * **每帧重算,不 memo。**
   *
   * 原来是 `useMemo(..., [props.streams, overrideRef.current])`,而这两个依赖的 identity
   * **永远不变**:store.streams(id) 返回的是 byNode 里那个**活数组本身**(新流是 push 进去
   * 的,数组没换),overrideRef 是个 ref。于是这个 memo **只在挂载时算过一次**。
   *
   * 后果是用户报的那个现象的另一半:一条流跑完之后 `closed` 变 true,但折叠集合是挂载
   * 那一刻的快照,**它永远不会被折起来**。日志窗于是无限长,正在跑的输出被埋在几百行
   * 之下,而用户以为是自己切不过去。
   *
   * 重算的代价是每帧遍历 ≤40 条流(MAX_STREAMS_PER_NODE),而这一帧本来就要
   * renderStreamLines 整个列表 —— memo 省下的那点远小于它掩盖的错。
   */
  const folded = foldedStreams(props.streams, overrideRef.current)

  /**
   * ↑↓ 此刻归谁 —— **由选中那条流的折叠状态决定**,不是另存一个模式开关。
   *
   * 用户的原话:「各阶段选择中了可以通过上下键来选择,按空格展开后,上下键就是该阶段输出
   * 内容的上下滚动了」。折叠 = 选阶段,展开 = 滚内容,一条规则,而空格正好是切换它的键。
   *
   * 派生的第二个好处是**自愈**:一条跑完的流会自动折起来(见上面的 folded),此时 ↑↓
   * 自动变回选阶段 —— 而一个独立的模式变量会停在「滚内容」,对着一条只有表头的流,
   * ↑↓ 成了死键。反过来,用户**显式**展开过的流不会被自动折叠(override 记着),
   * 所以他刚刚亲手进入的阅读态不会被背后的状态变化抽走。
   *
   * 判据本身在 `logView.logPaneMode` 里,和详情页页脚共用一份 —— 页脚要在**挂载那一帧**
   * 就说对「↑↓ 现在是选阶段还是滚动」,各算一份的话第一帧就会说错。
   */
  const mode: LogPaneMode = logPaneMode(folded, selectedRef.current, props.streams.length)

  const lines: LogLine[] = renderStreamLines({
    streams: props.streams,
    folded,
    selected: selectedRef.current,
    nowMs: Date.now(),
    width: contentWidth,
    historical: props.historical,
    expandedThinking: thinkingRef.current,
    theme,
  })

  const total = lines.length
  const maxFrom = Math.max(0, total - height)
  const headerIdxOf = (i: number): number =>
    lines.findIndex(l => l.isHeader === true && l.streamIndex === i)
  // 粘底:跟随时永远停在最后一屏。新事件进来自然往上顶,这就是「实时终端」的手感。
  // 不跟随时按**锚**解算——见 anchorRef 的注释。
  const rawFrom = followRef.current
    ? maxFrom
    : anchoredFrom(total, height, anchorRef.current, headerIdxOf)
  const { from } = scrollWindow(total, height, rawFrom)

  useInput(
    (input, key) => {
      const act = logPaneAction(input, key, mode)
      if (!act) return
      const headerIdx = headerIdxOf
      /** 把「我想让视口停在第 n 行」翻译成锚(相对当前选中流的表头)。 */
      const anchorAt = (line: number): LogAnchor => {
        const i = selectedRef.current
        const at = headerIdx(i)
        return at >= 0 ? { stream: i, delta: line - at } : { stream: i, delta: line }
      }
      switch (act.t) {
        case 'line':
        case 'halfPage': {
          const step = act.t === 'line' ? act.d : act.d * Math.floor(height / 2)
          const next = Math.max(0, Math.min(maxFrom, from + step))
          setAnchor(anchorAt(next))
          // 滚到底就恢复跟随 —— 否则用户一路按 ↓ 到底之后,新输出反而不动了。
          setFollow(next >= maxFrom)
          return
        }
        case 'top':
          setAnchor(anchorAt(0))
          setFollow(false)
          return
        case 'bottom':
          setAnchor(anchorAt(maxFrom))
          setFollow(true)
          return
        case 'selectStream': {
          if (props.streams.length === 0) return
          /**
           * **夹住,不循环。** `n` 是「下一条」(循环),这是一个列表光标:撞到头就停,
           * 和任务树、段落列表的行为一致。循环的话用户在第一条上按 ↑ 会跳到最后一条 ——
           * 而那条通常正是还在跑、一直在动的那条,也就是他抱怨过的现象。
           */
          const next = Math.max(0, Math.min(props.streams.length - 1, selectedRef.current + act.d))
          if (next === selectedRef.current) return
          setSelected(next)
          // 切到哪,展示哪:锚钉到那条流的表头,并无条件关掉跟随 —— 否则视口继续粘在
          // 底部那条正在跑的流上(和 nextStream 逐字同因)。
          setAnchor({ stream: next, delta: 0 })
          setFollow(false)
          return
        }
        case 'nextStream': {
          if (props.streams.length === 0) return
          const next = (selectedRef.current + 1) % props.streams.length
          setSelected(next)
          // **切换到哪,展示哪**:锚直接钉到那条流的表头,delta 归零。
          // 而且**无条件**关掉跟随——原来只在找得到表头时才关,于是切到一条还没渲染出
          // 表头的流时,视口继续粘在底部那条正在跑的流上,正是用户抱怨的现象。
          setAnchor({ stream: next, delta: 0 })
          setFollow(false)
          return
        }
        case 'toggleThinking': {
          const i = selectedRef.current
          if (i < 0 || i >= props.streams.length) return
          const set = new Set(thinkingRef.current)
          if (set.has(i)) set.delete(i)
          else set.add(i)
          setThinking(set)
          return
        }
        case 'toggleFold': {
          const i = selectedRef.current
          if (i < 0 || i >= props.streams.length) return
          const cur = overrideRef.current.get(i) ?? props.streams[i]!.closed
          const m = new Map(overrideRef.current)
          m.set(i, !cur)
          setOverride(m)
          return
        }
      }
    },
    { isActive: props.isActive === true },
  )

  React.useEffect(() => {
    props.onState?.({
      from,
      total,
      follow: followRef.current,
      selected: selectedRef.current,
      folded: [...folded].sort((a, b) => a - b),
      thinking: [...thinkingRef.current].sort((a, b) => a - b),
      mode,
    })
  })

  if (props.streams.length === 0 && props.historical !== true) {
    return <Text dimColor>{props.emptyHint ?? '暂无输出'}</Text>
  }

  const slice = lines.slice(from, from + height)
  const behind = followRef.current ? 0 : Math.max(0, maxFrom - from)

  /**
   * **这个窗口不再画自己的页脚。**
   *
   * 它原来那两行里有一句是**假的**:「Tab 切换环节」—— 而 `logPaneAction` 第三行就是
   * `if (key.tab) return null`,Tab 早就让给区切换了,切流是 `n`,页脚从没提过 `n`。
   * 详情页做成两个页卡之后,这两行还会和 NodeDetail 自己的页脚**同屏**,一条说 Tab
   * 切环节、一条说 Tab 切段落,互相打脸。
   *
   * 页脚职责收归 NodeDetail 一行(按当前 zone 变文案):省 2 行版面、消一条假话、
   * 键位说明只有一个出处。
   */
  return (
    <ScrollPane
      slice={slice}
      total={total}
      from={from}
      height={height}
      notice={notice}
      behind={behind}
      behindHint="G 跟随最新"
    />
  )
}
