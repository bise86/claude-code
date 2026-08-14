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
/**
 * 这一屏按下确认之后**真的会做事**吗 —— 五桶取或。
 *
 * 判据原来只看 `items`(工作区那一桶),而 `runCleanup` 另外还删事件日志、`/tmp` 残留、
 * 只清产物的那批目录、集成工作区里的产物,以及(本轮新增)版本库里已被跟踪的产物。
 * 于是一棵工作区早就清干净、却还留着几百 MB 日志的子树,按回车什么都不会发生,
 * 而屏幕上明明把它们列着 —— 「屏幕说有、按下去没有」是这个仓库的固定病灶。
 *
 * 导出是为了能被单独断言:它此前住在 useInput 里,而那里打不中。
 */
export function hasWork(p: CleanupPlan): boolean {
  const tr = p.tracked
  const trackedWork = tr !== undefined
    && tr.blocked.length === 0
    && (tr.proven.length > 0 || tr.suspected.length > 0)
  return p.items.length > 0
    || p.logs.length > 0
    || p.scratch.length > 0
    || (p.buildOnly?.length ?? 0) > 0
    || p.integration !== undefined
    || trackedWork
}

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
  /** `t` 键的那一档:疑似桶算不算。默认关,见 useInput 里那一段。 */
  const [includeSuspected, setIncludeSuspected, includeSuspectedRef] = useLiveState<boolean>(false)

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
    // 删的过程中**一个键都不认**。半途的回车会再触发一次执行,而这一路是不可逆的。
    if (m === 'working') return
    if (m === 'done' || m === 'error') {
      if (key.return || key.escape || (plain && k === 'q')) props.onDone()
      return
    }
    if (key.escape || (plain && (k === 'q' || k === 'n'))) { props.onCancel(); return }
    if (m !== 'ready') return
    const p = planRef.current
    /**
     * **`t`:把「名字像产物、但拿不出签名」那一桶也算上。**
     *
     * 默认不选 —— 「很可能是产物」和「证明了是产物」在一次不可逆的删除面前不是同一件事
     * (判据见 `buildOutputs.scanTrackedBuildOutputs`)。这个键是那一桶**唯一**的开关:
     * 少了它,`includeSuspected` 在任何路径上都是 false,而计划屏上那句
     * 「要一起删请按 t」是一条按不到的指令 —— 这个仓库为「屏幕承诺一个不存在的键」
     * 付过账(收口报告印过一条 git 必然拒绝的 `branch -D`)。
     */
    if (plain && k === 't' && (p?.tracked?.suspected.length ?? 0) > 0) {
      setIncludeSuspected(v => !v)
      return
    }
    /**
     * 没有可做的事时回车是「知道了」,不是「执行一次空操作」。
     *
     * **判据必须覆盖全部桶**,而它原来只看 `items`(工作区那一桶)—— 于是一棵工作区
     * 早就清干净、却还留着几百 MB 事件日志 / `/tmp` 残留 / 版本库里的构建产物的子树,
     * 按回车什么都不会发生,而屏幕上明明列着它们。
     */
    if (!p || !hasWork(p)) {
      if (plain && (key.return || k === 'y')) props.onCancel()
      return
    }
    if (plain && (key.return || k === 'y')) {
      setMode('working')
      void props.onRun({ ...p, includeSuspected: includeSuspectedRef.current }).then(
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
  // 判据和按键处理**共用同一份** `hasWork` —— 两边各算一次的话,页脚说「回车确认删除」
  // 而回车实际走的是「知道了」,用户是照着页脚按的。
  const empty = mode === 'ready' && (plan === null || !hasWork(plan))
  /** 疑似桶那一档的开关提示。只在真有那一桶时才出现 —— 按不到的键不许印。 */
  const tHint = (plan?.tracked?.suspected.length ?? 0) > 0
    ? ` · t ${includeSuspected ? '取消' : ''}包含 ${plan?.tracked?.suspected.length} 个疑似产物${includeSuspected ? '(已包含)' : ''}`
    : ''
  const footer = mode === 'done'
    ? '回车 / q / Esc 返回'
    : empty
      ? '回车 / q / Esc 返回'
      : `回车 / y 确认删除(不可恢复)${tHint} · q / Esc / n 取消`
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
