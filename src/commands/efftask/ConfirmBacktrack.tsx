import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { backtrackLines, backtrackScope, type BacktrackTarget } from '../../tools/efftask/backtrack.js'
import type { BacktrackOutcome } from '../../tools/efftask/backtrackRun.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState, useSettleOnce } from './useLiveState.js'
import { redoSummaryLines } from './ConfirmRedo.js'

/**
 * 「回溯」关口 —— 详情页那个 `b` 键。
 *
 * 用户原话:「b 键只去检查那些集成验收不过的……优先触发相应任务重新执行阶段,补进解决
 * 对应问题提示词。如果不行,可以完全重做任务和加新任务。」
 *
 * ## 四个状态,理由和清理那一屏同源
 *
 *  - `ready` —— 范围是**纯函数**算出来的(`backtrackScope`),所以没有扫描等待:
 *    进来就能把「哪几个任务、走第几级、为什么」摊开;
 *  - `working` —— 这一路要派一次**分钟级**的主模型调用,然后落盘、重启编排器。
 *    期间**一个键都不认**:半途的回车会再触发一次,而下游是 `startRun`;
 *  - `done` —— 结果必须自己上屏。回溯是静默的:没有这一屏,用户按完只会看到界面弹回去,
 *    分不清「重跑了 5 个」和「一个都没动」;
 *  - `error`。
 *
 * ## `useSettleOnce` 不是可选的
 *
 * 这一屏的出口是 `start(nodes, affected)` → `startRun` —— 和重做关口**同一个形状**。
 * 而按键处理器里那道闩记着实测:vendored ink 把一个 stdin 块拆成多个 InputEvent **同步**
 * 派发,卸载要等 React 提交下一帧,于是连按的每一下回车都再跑一遍同一个处理器 ——
 * 三下快回车在同一个 run 目录上起了**三个编排器**。确认和取消共用同一个闩:
 * 它们都是这一屏的出口,发过一个就不该再发另一个。
 */
export function ConfirmBacktrack(props: {
  /**
   * 这一趟有没有隔离工作区(池子在不在)。缺省当成有。
   *
   * 共享目录那两档下不传的话,这一屏会承诺「隔离工作区会被删掉并从集成分支最新状态
   * 重建」—— 那里既没有工作区也没有集成分支,而重做面对的是上一轮留下的脏现场。
   */
  isolated?: boolean
  target: TaskNode
  nodes: readonly TaskNode[]
  /** 真的跑一次回溯。进度一条一条推回来 —— 主模型那一步是分钟级的。 */
  onRun: (onProgress: (line: string) => void) => Promise<BacktrackOutcome | undefined>
  onDone: () => void
  onCancel: () => void
}): React.ReactElement {
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const settle = useSettleOnce()
  const [mode, setMode, modeRef] = useLiveState<'ready' | 'working' | 'done' | 'error'>('ready')
  const [outcome, setOutcome] = useLiveState<BacktrackOutcome | null>(null)
  const [error, setError] = useLiveState<string>('')
  const [progress, setProgress] = useLiveState<string[]>([])

  /**
   * 范围**现算**,而且和执行共用同一份 `backtrackScope` —— 两边各算一次的话,用户是照着
   * 屏幕按的确认,而实际发生的可以是另一回事(`cleanupWorktrees` 为同一条规矩写过)。
   */
  const targets: BacktrackTarget[] = React.useMemo(
    () => backtrackScope(props.nodes, props.target.id).targets,
    [props.nodes, props.target.id],
  )

  useInput((input, key) => {
    const k = input.toLowerCase()
    /**
     * **带修饰键的不算动作键。** 和 `TaskTreePanel` 那两支同一条规矩,理由在这一屏更硬:
     * 这里的确认键会**产生真实提交 / 删目录 / 删分支**,而 `Ctrl+Y`、`Alt+y`、kitty 的
     * `ESC[121;5u` 在没有这道闸时逐个都能按下去(验收席真按键实测)。本 fork 的
     * `internal_exitOnCtrlC` 是 false,Ctrl 系列被原样派发。
     *
     * **只许逐条与,不许写成分支开头的早退**:`key.meta` 对 Escape 恒为真,那样写会把
     * 「Esc 任何时候都是返回」这条规矩当场废掉。
     */
    const plain = key.ctrl !== true && key.meta !== true
    const m = modeRef.current
    // 跑的过程中一个键都不认:半途的回车会再触发一次,而下游是 startRun。
    if (m === 'working') return
    if (m === 'done' || m === 'error') {
      if (key.return || key.escape || (plain && k === 'q')) settle(props.onDone)
      return
    }
    if (key.escape || (plain && (k === 'q' || k === 'n'))) { settle(props.onCancel); return }
    // 没有可回溯的任务时回车是「知道了」,不是「执行一次空操作」—— 页脚写的就是这一句。
    if (targets.length === 0) {
      if (plain && (key.return || k === 'y')) settle(props.onCancel)
      return
    }
    if (plain && (key.return || k === 'y')) {
      /**
       * **闩在这里,不在 onRun 里。** 这一屏的出口只有一个决定,而连按的第二下回车会在
       * 卸载之前再跑一遍这个处理器 —— 那时 `mode` 还没提交成 'working'。
       */
      settle(() => {
        setMode('working')
        void props.onRun(l => setProgress(p => [...p, l])).then(
          o => { setOutcome(o ?? null); setMode('done') },
          (e: unknown) => {
            setError(e instanceof Error ? e.message : String(e))
            setMode('error')
          },
        )
      })
    }
  })

  const title = `回溯 —— ${props.target.title}`
  if (mode === 'error') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        <Text color="error">{error || '未知错误'}</Text>
        <Text dimColor>回车 / q / Esc 返回</Text>
      </Box>
    )
  }
  if (mode === 'working') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        {/* 进度必须有:主模型那一步是分钟级的,而这个仓库为「按下去没反应」付过两次学费。 */}
        {progress.slice(-6).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 进度按位置定义,内容可重复
          <Text key={i} dimColor wrap="truncate-end">{l}</Text>
        ))}
        <Text dimColor>正在回溯…(期间按键不响应)</Text>
      </Box>
    )
  }

  const lines = mode === 'done'
    ? resultLines(outcome)
    : backtrackLines(
        targets,
        targets.flatMap(t => (t.suspects.length > 0 ? t.suspects : [t.node.id])).map(id => ({ nodeId: id, entry: '' })),
        // 这一趟到底有没有工作区可删可同步。**判据是池子在不在**,不是配置里写着什么
        // (配置可以写着隔离而每一次 acquire 都失败)。
        props.isolated !== false,
      )
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  const footer = mode === 'done' || targets.length === 0
    ? '回车 / q / Esc 返回'
    : '回车 / y 确认回溯 · q / Esc / n 取消'
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color={mode === 'done' ? 'success' : 'warning'}>
        {mode === 'done' ? `回溯完成 —— ${props.target.title}` : title}
      </Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={l.startsWith('⚠') ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条未显示(终端太矮);放大窗口再看</Text> : null}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}

/**
 * 回溯完那一屏的每一行。**是数据,不是 JSX**。
 *
 * 一个都没重跑时**不许说「已重跑 0 个」** —— 那句话读起来像一次成功的空操作,而真实的
 * 意思是「你按下了确认,而它什么都没做」(`cleanupResultLines` 为同一条规矩写过)。
 */
export function resultLines(out: BacktrackOutcome | null): string[] {
  if (!out) return ['这次回溯没有执行 —— 原因见任务树上的提示。']
  const lines: string[] = []
  if (out.entries.length === 0) {
    lines.push('没有重跑任何任务。')
  } else {
    const again = out.entries.filter(e => e.entry === 'execute').length
    const redo = out.entries.filter(e => e.entry === 'plan').length
    lines.push(
      `已重跑 ${out.entries.length} 个任务` +
      `(${again} 个重新执行${redo > 0 ? `、${redo} 个完全重做` : ''})—— 它们已经回到队列里。`,
    )
  }
  if (out.rearmed.length > 0) {
    lines.push(`${out.rearmed.length} 个任务重新武装了补救拆分:下一轮集成验收可以给它们加新的子任务。`)
  }
  // 降级要单独说,而且要说清用的是什么名单 —— 它决定了这次重跑的范围对不对。
  if (out.degraded) lines.push(`⚠ ${out.degraded}`)
  return lines
}
