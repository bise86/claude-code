import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  cleanupLines, cleanupResultLines,
  type CleanupOutcome, type CleanupPlan,
} from '../../tools/efftask/cleanupWorktrees.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState } from './useLiveState.js'
import { redoSummaryLines } from './ConfirmRedo.js'

/**
 * 「清理已完成任务的隔离工作区」关口 —— 一屏,四个状态。
 *
 * 用户原话:「任务已经完成的 worktree 是否可以删除掉,占用了大量的存储空间。在任务详情页
 * 下面有个控制键,一键清理。」
 *
 * ## 为什么是四个状态,而不是「按一下就删」
 *
 * 这是这个界面里**唯一一个不可逆、而且删的是真实文件**的动作(重做删的是记录,还有
 * `pool.release()` 那道拒绝把关)。所以:
 *
 *  - `scanning` —— 探盘要跑 git,还要 `du` 一遍几 GB 的目录,快不了。**不能白屏**:
 *    这个仓库为「按下去没反应」付过两次学费。
 *  - `ready` —— 把接下来真的会发生的事逐条摊开(`cleanupLines`,和执行共用同一份 plan)。
 *  - `working` —— 删的过程中键盘整个不认:一下误按的回车不该在半途再触发一次。
 *  - `done` —— 结果必须**自己上屏**。删除是静默的:没有这一屏,用户按完确认只会看到界面
 *    弹回去,分不清「清干净了」和「一个都没删掉」。
 *
 * 扫描和执行都由调用方传进来(`onScan` / `onRun`),这一屏不认识 git —— 判据和动作住在
 * cleanupWorktrees.ts,那里能被真 git 测出来。
 */
export function ConfirmCleanup(props: {
  target: TaskNode
  onScan: () => Promise<CleanupPlan>
  onRun: (plan: CleanupPlan) => Promise<CleanupOutcome>
  /** 关掉这一屏。清理完也走它 —— 回到用户来的那一屏。 */
  onDone: () => void
  onCancel: () => void
}): React.ReactElement {
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [mode, setMode, modeRef] = useLiveState<'scanning' | 'ready' | 'working' | 'done' | 'error'>('scanning')
  const [plan, setPlan, planRef] = useLiveState<CleanupPlan | null>(null)
  const [outcome, setOutcome] = useLiveState<CleanupOutcome | null>(null)
  const [error, setError] = useLiveState<string>('')

  React.useEffect(() => {
    let alive = true
    void props.onScan().then(
      p => { if (alive) { setPlan(p); setMode('ready') } },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setMode('error')
      },
    )
    // 卸载之后不再改 state:关口是可以被 Esc 关掉的,而扫描还在跑。
    return () => { alive = false }
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时扫一次
  }, [])

  useInput((input, key) => {
    const k = input.toLowerCase()
    const m = modeRef.current
    // 删的过程中**一个键都不认**。半途的回车会再触发一次执行,而这一路是不可逆的。
    if (m === 'working') return
    if (m === 'done' || m === 'error') {
      if (key.return || key.escape || k === 'q') props.onDone()
      return
    }
    if (key.escape || k === 'q' || k === 'n') { props.onCancel(); return }
    if (m !== 'ready') return
    const p = planRef.current
    // 没有可删的东西时回车也是「知道了」,不是「执行一次空操作」—— 页脚写的就是这一句。
    if (!p || p.items.length === 0) {
      if (key.return || k === 'y') props.onCancel()
      return
    }
    if (key.return || k === 'y') {
      setMode('working')
      void props.onRun(p).then(
        o => { setOutcome(o); setMode('done') },
        (e: unknown) => {
          setError(e instanceof Error ? e.message : String(e))
          setMode('error')
        },
      )
    }
  })

  const title = `清理已完成任务的隔离工作区 —— ${props.target.title}`
  if (mode === 'scanning') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        <Text dimColor>正在清点这棵子树里已验收任务的工作区(要逐个统计目录占用,大目录会慢一点)…</Text>
        <Text dimColor>q / Esc 取消</Text>
      </Box>
    )
  }
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
        <Text dimColor>正在删除 {plan?.items.length ?? 0} 个工作区…(删除期间按键不响应)</Text>
      </Box>
    )
  }

  const lines = mode === 'done'
    ? (outcome ? cleanupResultLines(outcome) : ['(没有结果)'])
    : (plan ? cleanupLines(plan) : ['(没有可清理的内容)'])
  // 和重做/跳过关口共用同一份夹取:这一屏会很长(每个工作区一行),而 ink 不裁剪 ——
  // 溢出时终端自己滚,滚掉的是最上面的标题和最重要的那几行。
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  const empty = mode === 'ready' && (plan?.items.length ?? 0) === 0
  const footer = mode === 'done'
    ? '回车 / q / Esc 返回'
    : empty
      ? '回车 / q / Esc 返回'
      : '回车 / y 确认删除(不可恢复) · q / Esc / n 取消'
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color={mode === 'done' ? 'success' : 'warning'}>
        {mode === 'done' ? `清理完成 —— ${props.target.title}` : title}
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
