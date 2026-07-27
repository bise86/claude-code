import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { OffscreenFreeze } from '../../components/OffscreenFreeze.js'
import type { StreamState, StreamStore } from '../../tools/efftask/agentStream.js'
import {
  budgetRows,
  logPaneAction,
  renderStreamLines,
  scrollbarColumn,
  scrollWindow,
  droppedNotice,
  type LogLine,
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
  React.useEffect(() => {
    if (!store || !active) return
    const off = store.subscribe(() => {
      if (pending.current) return
      pending.current = setTimeout(() => {
        pending.current = undefined
        setTick(t => t + 1)
      }, LOG_COALESCE_MS)
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
  onState?: (s: { from: number; total: number; follow: boolean; selected: number; folded: number[]; thinking: number[] }) => void
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
  // 「丢了多少」钉在滚动区之外,占一行 —— 它跟着滚的话会被粘底行为直接埋掉。
  const notice = droppedNotice(props.droppedEvents)
  const height = Math.max(4, Math.floor(props.height) - (notice ? 1 : 0))
  // 滚动条占一列。
  const contentWidth = Math.max(20, Math.floor(props.width) - 1)

  const [, setOffset, offsetRef] = useLiveState(0)
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

  const folded = React.useMemo(() => {
    const s = new Set<number>()
    props.streams.forEach((st, i) => {
      const ov = overrideRef.current.get(i)
      if (ov === undefined ? st.closed : ov) s.add(i)
    })
    return s
    // overrideRef 是 ref,变更靠 setOverride 触发的重绘带出来;把它列进依赖没有意义。
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [props.streams, overrideRef.current])

  const lines: LogLine[] = renderStreamLines({
    streams: props.streams,
    folded,
    selected: selectedRef.current,
    nowMs: Date.now(),
    width: contentWidth,
    historical: props.historical,
    expandedThinking: thinkingRef.current,
  })

  const total = lines.length
  const maxFrom = Math.max(0, total - height)
  // 粘底:跟随时永远停在最后一屏。新事件进来自然往上顶,这就是「实时终端」的手感。
  const rawFrom = followRef.current ? maxFrom : offsetRef.current
  const { from } = scrollWindow(total, height, rawFrom)

  useInput(
    (input, key) => {
      const act = logPaneAction(input, key)
      if (!act) return
      const headerIdx = (i: number): number => lines.findIndex(l => l.isHeader === true && l.streamIndex === i)
      switch (act.t) {
        case 'line':
        case 'halfPage': {
          const step = act.t === 'line' ? act.d : act.d * Math.floor(height / 2)
          const next = Math.max(0, Math.min(maxFrom, from + step))
          setOffset(next)
          // 滚到底就恢复跟随 —— 否则用户一路按 ↓ 到底之后,新输出反而不动了。
          setFollow(next >= maxFrom)
          return
        }
        case 'top':
          setOffset(0)
          setFollow(false)
          return
        case 'bottom':
          setOffset(maxFrom)
          setFollow(true)
          return
        case 'nextStream': {
          if (props.streams.length === 0) return
          const next = (selectedRef.current + 1) % props.streams.length
          setSelected(next)
          const at = headerIdx(next)
          if (at >= 0) {
            setOffset(Math.max(0, Math.min(maxFrom, at)))
            setFollow(false)
          }
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
    })
  })

  if (props.streams.length === 0 && props.historical !== true) {
    return <Text dimColor>{props.emptyHint ?? '暂无输出'}</Text>
  }

  const slice = lines.slice(from, from + height)
  const bar = scrollbarColumn(total, height, from)
  const behind = followRef.current ? 0 : Math.max(0, maxFrom - from)

  return (
    // 视口之上的内容变化会逼出整屏重置。ShellProgressMessage 为同一个理由裹了同一个东西。
    <OffscreenFreeze>
      <Box flexDirection="column">
        {notice ? <Text dimColor>{notice}</Text> : null}
        {slice.map((l, i) => (
          <Box key={`log-${from + i}`} flexDirection="row">
            <Text
              color={l.color}
              dimColor={l.dim === true}
              bold={l.bold === true}
              inverse={l.selected === true}
              wrap="truncate-end"
            >
              {l.text}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor>{bar[i] ?? ' '}</Text>
          </Box>
        ))}
        {behind > 0 ? (
          <Text color="warning">{`↓ 下面还有 ${behind} 行(G 跟随最新)`}</Text>
        ) : null}
        {props.isActive === true ? (
          <Text dimColor>↑↓/jk 滚动 · PgUp/PgDn 翻页 · g/G 顶部/底部 · Tab 切换环节 · 空格 折叠 · t 思考</Text>
        ) : null}
      </Box>
    </OffscreenFreeze>
  )
}
