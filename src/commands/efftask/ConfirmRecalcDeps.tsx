import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { recalcLines, type RecalcPlan } from '../../tools/efftask/depsRecalc.js'
import type { RecalcApply, RecalcAsk } from '../../tools/efftask/depsRecalcRun.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState } from './useLiveState.js'
import { redoSummaryLines, isWarningLine } from './ConfirmRedo.js'
import { AgentLogPane } from './AgentLogPane.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'

/**
 * 「依赖重算」关口 —— 一屏,五态。
 *
 * ## 为什么**没有** refused 这一态
 *
 * 准入判据全是同步内存读,所以拒绝根本不走这一屏:切屏会把任务树面板连同详情页整棵卸载,
 * 而用户展开到哪一段、读到第几行都住在那两个组件自己的 state 里。「什么都没发生」不该
 * 长成「你的阅读位置没了」。拒绝理由渲染在详情页的「依赖重算」那一段里。
 *
 * 这一屏只在**真的要去调模型**的时候才开 —— 那时用户本来就知道自己启动了一件长事。
 *
 * ## 五态各自在挡什么
 *
 *  - `asking` —— 主模型在算,分钟级。**不能白屏**,而且必须说清「别的任务仍在照常运行」:
 *    这一屏遮住的只是树,编排器一秒都没停;
 *  - `ready` —— 接下来真的会发生什么,逐条摊开(和执行共用同一份 plan);
 *  - `working` —— 毫秒级(hold / depsChanged 都是同步的),但键盘照样不认:一下误按的回车
 *    不该在半途再触发一次;
 *  - `done` / `error` —— 结果必须**自己上屏**。而 `error` 和「这一刻不适用」是两回事:
 *    前者是调用炸了 / 扣不住 / 叫不醒,后者根本不会走到这一屏。
 */
export function ConfirmRecalcDeps(props: {
  target: TaskNode
  resolveNode: (id: string) => TaskNode | undefined
  onAsk: () => Promise<RecalcAsk>
  onApply: (plan: RecalcPlan) => Promise<RecalcApply>
  /** 取消这一次在飞的模型调用。**只 abort per-call controller** —— 见下面那段注释。 */
  onCancelAsk: () => void
  onDone: () => void
  /**
   * 这一次调用的实时输出。
   *
   * **不是装饰**:这一屏会停几分钟,而少了它「模型卡住了」和「正常在读」在屏幕上
   * 长得一模一样 —— 用户唯一的信息是一个在跳的秒数。这个仓库为「没看到日志」改过一轮。
   */
  streams?: readonly StreamState[]
  columns?: number
}): React.ReactElement {
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [mode, setMode, modeRef] = useLiveState<'asking' | 'ready' | 'working' | 'done' | 'error'>('asking')
  const [plan, setPlan, planRef] = useLiveState<RecalcPlan | null>(null)
  const [error, setError] = useLiveState<string>('')
  const [result, setResult] = useLiveState<string>('')
  const [secs, setSecs] = useLiveState<number>(0)

  React.useEffect(() => {
    // 秒表。这一屏会停几分钟,而「按下去没反应」这个仓库付过两次学费。
    const t = setInterval(() => setSecs(s => s + 1), 1000)
    return () => clearInterval(t)
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时起一次
  }, [])

  React.useEffect(() => {
    let alive = true
    void props.onAsk().then(
      r => {
        if (!alive) return
        if (r.ok === true) { setPlan(r.plan); setMode('ready') }
        else { setError(r.reason); setMode(r.kind === 'aborted' ? 'done' : 'error') }
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setMode('error')
      },
    )
    // 卸载之后不再改 state:这一屏可以被 Esc 关掉,而调用还在飞。
    return () => { alive = false }
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时问一次
  }, [])

  useInput((input, key) => {
    const k = input.toLowerCase()
    if (modeRef.current === 'working') return // 半途的回车会再执行一次
    if (modeRef.current === 'done' || modeRef.current === 'error') {
      if (key.return || key.escape || k === 'q') props.onDone()
      return
    }
    if (modeRef.current === 'asking') {
      /**
       * 取消**只**收 q / Esc。
       *
       * 不收 `n`:这一屏挂着实时输出窗,而那个窗口把 `n` 认成「下一条流」—— 同一个键
       * 两种意思。
       *
       * 而且这次取消**只 abort 这一次调用的 controller**,绝不调 `control.cancelNode`:
       * 那会给这个节点置上**永久**的取消标记,而重算的准入判据从此拒绝它、`pickBatch`
       * 也永远不选它 —— 在这一屏按一次 Esc 会把这个任务从整趟 run 里除名。
       */
      if (key.escape || k === 'q') { props.onCancelAsk(); props.onDone() }
      return
    }
    // ready
    if (key.escape || k === 'q' || k === 'n') { props.onDone(); return }
    const p = planRef.current
    if (!p || p.unchanged) {
      // 没有变化时回车是「知道了」,不是「执行一次空操作」—— 页脚写的就是这一句。
      if (key.return || k === 'y') props.onDone()
      return
    }
    if (key.return || k === 'y') {
      setMode('working')
      void props.onApply(p).then(
        r => {
          if (r.ok === true) {
            setResult(`依赖已更新:${p.before.length} 条 → ${p.after.length} 条。`)
            setMode('done')
          } else {
            setError(r.diskChanged
              ? r.reason
              : `${r.reason}\n(任务树和磁盘都没有被改动。)`)
            setMode('error')
          }
        },
        (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setMode('error') },
      )
    }
  })

  const title = `依赖重算 —— ${props.target.title}`
  if (mode === 'asking') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        <Text dimColor>正在让主模型按已拆出的子任务重新判断依赖…(已等待 {secs}s)</Text>
        <Text dimColor>别的任务仍在照常运行 —— 这一屏只挡住了任务树,没有暂停调度。</Text>
        {props.streams && props.streams.length > 0 ? (
          // isActive={false}:这一屏的键盘归本组件。窗口自己的 useInput 会把 `n` 认成
          // 「下一条流」,而这里只有一条流、`n` 也不该有第二种含义。
          <AgentLogPane streams={props.streams} height={12} width={props.columns ?? columns} isActive={false} />
        ) : null}
        <Text dimColor>q / Esc 取消这次重算(要中止整个运行,请先按 Esc 退出这一屏)</Text>
      </Box>
    )
  }
  if (mode === 'working') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        <Text dimColor>正在写入…</Text>
      </Box>
    )
  }
  if (mode === 'error') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="error">{title}</Text>
        {error.split('\n').map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义
          <Text key={i} color="error" wrap="truncate-end">{l}</Text>
        ))}
        <Text dimColor>回车 / q / Esc 返回</Text>
      </Box>
    )
  }
  if (mode === 'done') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="success">{title}</Text>
        <Text>{result || error || '已取消,依赖未改动。'}</Text>
        <Text dimColor>回车 / q / Esc 返回</Text>
      </Box>
    )
  }

  const lines = plan ? recalcLines(plan, mapOf(props.resolveNode, plan), props.target.parentId) : ['(没有结果)']
  // 和重做 / 清理关口共用同一份夹取:这一屏会很长,而 ink 不裁剪 —— 溢出时终端自己滚,
  // 滚掉的是最上面的标题和最重要的那几行。
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  const empty = plan?.unchanged === true
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">{title}</Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={isWarningLine(l) ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条未显示(终端太矮);放大窗口再看</Text> : null}
      <Text dimColor>{empty ? '回车 / q / Esc 返回' : '回车 / y 应用这份依赖 · q / Esc / n 取消'}</Text>
    </Box>
  )
}

/**
 * `recalcLines` 要的是一张 map,而这一屏拿到的是一个 resolver。
 *
 * 只收计划里真的提到过的 id —— 这一屏没有整棵树,而 `depLabel` 只会问这些。
 */
function mapOf(resolve: (id: string) => TaskNode | undefined, plan: RecalcPlan): Map<string, TaskNode> {
  const out = new Map<string, TaskNode>()
  const add = (id: string): void => {
    const n = resolve(id)
    if (!n) return
    out.set(id, n)
    if (n.parentId) { const p = resolve(n.parentId); if (p) out.set(p.id, p) }
  }
  for (const id of [...plan.before, ...plan.after]) add(id)
  for (const p of plan.perDep) { add(p.dep); for (const n of p.needs) add(n.id) }
  return out
}
