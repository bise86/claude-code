import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import type { RepairOutcome } from '../../tools/efftask/nodeRepairRun.js'
import type { Damage } from '../../tools/efftask/nodeRepair.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { AgentLogPane } from './AgentLogPane.js'
import { useSettleOnce } from './useLiveState.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'

/**
 * 「修复损毁的任务」关口(详情页 `g` 键)—— 一屏,五态。
 *
 * 形状跟着 `ConfirmRecalcDeps` 走(扫描 → 确认 → 干活 → 结果),因为要挡的东西是同一批。
 * 三条这一屏特有的:
 *
 *  1. **先扫再问用户**。「这个节点到底缺什么」是读盘得出的,不是猜的 —— 而
 *     `damageOf` 读的是**盘上**那份,不是内存里被 `validateLoadedNodes` 补过默认值的那份。
 *     没扫就弹确认,用户会对着一个「要不要修?」却看不到修什么。
 *  2. **说清主模型不会做什么**。这一屏要发起一次模型调用去补标题/目标/方案,而用户最该
 *     知道的是它**不会**替他判断这个任务做完了没有 —— 否则「让 AI 恢复」听起来就像
 *     「让 AI 决定这活算不算干完」。
 *  3. **可以不问模型**。账和残骸够用时按 `s` 直接修,一个调用都不发。
 */
export function ConfirmRepair(props: {
  target: TaskNode
  /** 读盘,算出损伤与可用材料。关口打开时跑一次。 */
  onScan: () => Promise<{ damage: Damage; raw?: string; journalRecords: number }>
  onRepair: (opts: { skipModel: boolean }) => Promise<RepairOutcome>
  onCancelAsk: () => void
  onDone: () => void
  streams?: readonly StreamState[]
  columns?: number
}): React.ReactElement {
  const term = useTerminalSize()
  const { columns } = useModalOrTerminalSize(term)
  const w = props.columns ?? columns

  type Stage =
    | { k: 'scanning' }
    | { k: 'ready'; damage: Damage; hasRaw: boolean; journalRecords: number }
    | { k: 'working'; withModel: boolean }
    | { k: 'done'; out: RepairOutcome }
  const [stage, setStage] = React.useState<Stage>({ k: 'scanning' })

  React.useEffect(() => {
    let cancelled = false
    void props.onScan()
      .then(r => {
        if (cancelled) return
        setStage({ k: 'ready', damage: r.damage, hasRaw: typeof r.raw === 'string', journalRecords: r.journalRecords })
      })
      .catch(e => {
        if (cancelled) return
        setStage({ k: 'done', out: { ok: false, kind: 'write-failed', reason: `扫描失败: ${e instanceof Error ? e.message : String(e)}` } })
      })
    return () => { cancelled = true }
    // biome-ignore lint/correctness/useExhaustiveDependencies: scan once per gate
  }, [])

  /**
   * 确认和取消**共用一个闩**。vendored 的 ink 把一个 stdin 块拆成多个 InputEvent
   * **同步**派发,而按下确认不会当场卸载这一屏 —— 连按的第二下回车会再跑一遍
   * 整个 `useInput`,再发起一次修复(第十三轮为「同一个 run 起了两个编排器」付过学费)。
   */
  const settle = useSettleOnce()

  const run = (withModel: boolean): void => settle(() => {
    setStage({ k: 'working', withModel })
    void props.onRepair({ skipModel: !withModel })
      .then(out => setStage({ k: 'done', out }))
      .catch(e => setStage({ k: 'done', out: { ok: false, kind: 'call-failed', reason: e instanceof Error ? e.message : String(e) } }))
  })

  useInput((input, key) => {
    const k = input.toLowerCase()
    if (stage.k === 'scanning') {
      // 扫描是几次读盘,毫秒级 —— 但 Esc 要能退出去,否则一个读不了的目录会把用户关在里面。
      if (key.escape || k === 'q') props.onDone()
      return
    }
    if (stage.k === 'ready') {
      if (key.return) { run(true); return }
      if (k === 's') { run(false); return }
      if (key.escape || k === 'q') { settle(props.onDone); return }
      return
    }
    // working 期间**一个键都不认**,除了中止那一次在飞的调用。半途的回车会再执行一次。
    if (stage.k === 'working') {
      if (key.escape) props.onCancelAsk()
      return
    }
    props.onDone()
  })

  const title = <Text bold>修复损毁的任务:{props.target.title}</Text>

  if (stage.k === 'scanning') {
    return (
      <Box flexDirection="column" width={w}>
        {title}
        <Text dimColor>正在读盘,看这个任务还剩下什么…</Text>
        <Text dimColor>Esc 返回</Text>
      </Box>
    )
  }

  if (stage.k === 'ready') {
    const { damage, hasRaw, journalRecords } = stage
    const nothing = damage.blocking.length === 0 && damage.soft.length === 0
    return (
      <Box flexDirection="column" width={w}>
        {title}
        <Box height={1} />
        {nothing ? (
          <Text color="green">这个任务的状态是完整的,没有需要修复的地方。</Text>
        ) : (
          <>
            <Text bold>缺什么</Text>
            {damage.blocking.map(d => <Text key={d} color="red">  ✗ {d}</Text>)}
            {damage.soft.map(d => <Text key={d} color="yellow">  · {d}</Text>)}
            <Box height={1} />
            <Text bold>手上有什么材料</Text>
            <Text>  {journalRecords > 0
              ? `· 状态账:${journalRecords} 条记录(每一关提交过的结果都在里面,最可信)`
              : '· 状态账:没有(这个任务是在启用状态账之前跑的)'}</Text>
            <Text>  {hasRaw ? '· 损坏文件的残骸:还能读出一部分原文' : '· 损坏文件:读不出来了'}</Text>
            <Box height={1} />
            <Text bold>主模型会做什么</Text>
            <Text>  会:从上面的材料里还原标题、目标、类型、方案正文、验收点。</Text>
            {/* 这一条是这一屏最重要的一句话 —— 见组件头第 2 条。 */}
            <Text color="yellow">  不会:判断这个任务做完了没有,也不会产生任何评审或验收结论。</Text>
            <Text dimColor>  任务状态按「宁可重跑一遍,不可谎报完成」由程序自己定。</Text>
            <Box height={1} />
            <Text>回车 = 请主模型协助修复    s = 只用盘上已有的信息修(不发调用)    Esc = 返回</Text>
          </>
        )}
        {nothing ? <Text dimColor>Esc 返回</Text> : null}
      </Box>
    )
  }

  if (stage.k === 'working') {
    return (
      <Box flexDirection="column" width={w}>
        {title}
        <Text dimColor>
          {stage.withModel ? '主模型正在恢复这个任务…(别的任务仍在照常运行)' : '正在按盘上已有的信息恢复…'}
        </Text>
        {stage.withModel && props.streams ? (
          <AgentLogPane streams={props.streams} height={10} width={w} isActive />
        ) : null}
        <Text dimColor>Esc 中止这一次调用</Text>
      </Box>
    )
  }

  const out = stage.out
  return (
    <Box flexDirection="column" width={w}>
      {title}
      <Box height={1} />
      {out.ok ? (
        <>
          <Text color="green">已恢复,并写回磁盘。</Text>
          <Text>  任务状态:{out.node.status}{out.node.status === 'CREATED' ? '(没有证据证明它跑过,会从头再跑一遍)' : '(来自状态账,是真的提交过的)'}</Text>
          {Object.entries(out.patch).length > 0 ? (
            <>
              <Text bold>主模型补上的</Text>
              {Object.entries(out.patch).map(([k, v]) => (
                <Text key={k}>  · {k}: {String(v).slice(0, 100)}</Text>
              ))}
            </>
          ) : (
            <Text dimColor>  主模型没有补上任何字段(盘上的信息已经够,或者它没给出可用的回答)。</Text>
          )}
          {/* 被拒的也要说 —— 「模型答了但我们没采纳」和「模型没答」是两回事。 */}
          {out.rejected.length > 0 ? (
            <>
              <Text bold>没有采纳的</Text>
              {out.rejected.slice(0, 6).map(r => <Text key={r} dimColor>  · {r}</Text>)}
            </>
          ) : null}
          {out.note ? <Text color="yellow">  {out.note}</Text> : null}
        </>
      ) : (
        <Text color={out.kind === 'not-damaged' ? 'green' : 'red'}>{out.reason}</Text>
      )}
      <Box height={1} />
      <Text dimColor>任意键返回</Text>
    </Box>
  )
}
