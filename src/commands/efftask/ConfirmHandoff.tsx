import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useLiveState, useSettleOnce } from './useLiveState.js'
import { choiceLabels, discardConfirmLines, type HandoffChoice } from '../../tools/efftask/handoffActions.js'
import type { PendingHandoff } from '../../tools/efftask/types.js'

/**
 * 收口关口(spec §8):run 跑完之后,让用户决定集成分支怎么处置。
 *
 * 此前这里只有「打印三条要用户自己敲的命令」。现在是一个真的关口 —— 而且是**可恢复**的:
 * 待收口状态写在 run.md 里,用户按 Esc 或直接关终端之后,`/et --resume` 会把它重新弹出来。
 *
 * 无限期等待,不设默认、不自动选(用户明确要求:飞书卡片 7 天,过期就是过期;终端这端
 * 一直等,两边行为一致)。
 */
export function ConfirmHandoff(props: {
  handoff: PendingHandoff
  runId: string
  onDecision: (choice: HandoffChoice) => void
  /** 用户放弃选择(Esc)。退化成「保留」:分支和工作区都留着,但待收口记录会被划掉。 */
  onSkip: () => void
}): React.ReactNode {
  const choices = choiceLabels(props.handoff)
  const [idx, setIdx, idxRef] = useLiveState(0)
  // 二次确认只给「丢弃」——四个动作里唯一不可逆的那个。
  const [confirmingDiscard, setConfirming, confirmRef] = useLiveState(false)

  /**
   * 出口只许走一次(见 useSettleOnce)。这一屏的四个选择**每一个都是不可逆的 git 动作**
   * (合并 / 推送 / 删分支),而连按的第二下回车会在同一个处理器里把它再发一次。
   */
  const settle = useSettleOnce()

  useInput((input, key) => {
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
    if (confirmRef.current) {
      /**
       * 二次确认里,只有明确的 y/回车 才算数;其余任何键都退回选择列表。
       *
       * **必须与 `plain`**:这一下确认的是「丢弃」—— 删集成分支、删集成工作区。验收席
       * 真按键实测,`Ctrl+Y` / `Alt+y` / kitty `ESC[121;5u` 四条全部按得下去。
       */
      if (plain && (key.return || input === 'y' || input === 'Y')) { settle(() => props.onDecision('discard')); return }
      setConfirming(false)
      return
    }
    if (key.escape) { settle(() => props.onSkip()); return }
    if (key.upArrow) { setIdx((idxRef.current + choices.length - 1) % choices.length); return }
    if (key.downArrow) { setIdx((idxRef.current + 1) % choices.length); return }
    if (plain && key.return) {
      const c = choices[idxRef.current].key
      if (c === 'discard') { setConfirming(true); return }
      settle(() => props.onDecision(c))
    }
  })

  const h = props.handoff
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务 {props.runId} · 收口</Text>
      {/* run 的结局要摆在最前面 —— 别邀请用户合并一棵没做完的树。 */}
      {h.outcome === 'blocked' ? (
        <Text color="warning">
          注意:本次运行**没有正常跑完**（{h.reason || '被阻断或已取消'}）,下面的改动可能是半成品
        </Text>
      ) : null}
      {/*
        「你的工作区未被改动」**只有在真没动过时才能说**。逐任务合并之后,中途合成功过的
        提交早就在用户目录里了(`trunkLanded`),对着它说没动过是一句他会照着做决定的假话。
      */}
      <Text>
        {(h.trunkLanded ?? 0) > 0
          ? `分支 ${h.branch} 上还有 ${h.commits} 个提交没合进来;另有 ${h.trunkLanded} 个提交已在跑的过程中合进了你当前的分支`
          : `分支 ${h.branch} 上有 ${h.commits} 个提交,你的工作区未被改动`}
      </Text>
      {/**
        * **`commits === 0` 时这一屏在说反话。**
        *
        * 这个关口现在也会为「没有待合的提交、但盘上还剩 salvage / 保留工作区」的 run 弹出来
        * (那正是 F 节要救的那一类)。而默认选中的「合并回当前分支」对 0 个提交是**空操作**,
        * 「你的工作区未被改动」又把注意力从真正剩下的东西上引开。所以这一档要自己说清:
        * 合并这条路捞不到它们,能捞的是任务树上的 `m`。
        */}
      {h.commits === 0 && (h.salvage.length > 0 || h.kept.length > 0) ? (
        <Box flexDirection="column">
          <Text color="warning">
            ⚠ 没有待合的提交,但还有 {h.salvage.length} 条抢救分支 / {h.kept.length} 个保留工作区没送到。
          </Text>
          <Text color="warning">
            {'  '}「合并回当前分支」对它们无效 —— 它们按定义就不在集成分支上;捞回它们要**进任务树按 m**。
          </Text>
        </Box>
      ) : null}
      {h.integrationPath ? <Text dimColor>集成工作区: {h.integrationPath}</Text> : null}
      {h.salvage.map(s => <Text key={s} dimColor>抢救出的提交(未合入集成分支的中间产物): {s}</Text>)}
      {h.kept.map(k => <Text key={k.path} dimColor>保留的工作区({k.why}): {k.path}</Text>)}

      {confirmingDiscard ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="error">确认丢弃?这一步不可逆</Text>
          {discardConfirmLines(h).map(l => <Text key={l}>{l}</Text>)}
          <Text dimColor>回车/y 确认丢弃 · 其它任意键返回</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {choices.map((c, i) => (
            <Text key={c.key} color={i === idx ? 'success' : undefined}>
              {i === idx ? '▶ ' : '  '}{c.label} — {c.hint}
            </Text>
          ))}
          {/* 「稍后再说」曾经写成一句做不到的话:keep 之后待收口记录**会被划掉**,
              /et --resume 不会再弹这一屏。不划掉又会让被阻断的 run 永久卡在这里
              (恢复路径在节点检查之前就 return 到关口)—— 所以留着划掉,把话说准。 */}
          <Text dimColor>↑/↓ 选择 · 回车 确认 · Esc 等同「保留」(分支留着,但这一屏不会再弹;之后 git merge 只捞得到集成分支上的提交,抢救分支/保留工作区要进树按 m)</Text>
        </Box>
      )}
    </Box>
  )
}
