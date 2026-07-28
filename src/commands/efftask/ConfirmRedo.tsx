import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  planRedo, redoOptions, redoSummary, type RedoContext, type RedoEntry,
} from '../../tools/efftask/redo.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useLiveState } from './useLiveState.js'

/**
 * 重做关口 —— 两屏。
 *
 * 第一屏选环节,第二屏**先把后果摊开再要确认**。分成两屏不是排版偏好:从方案重做会
 * 删掉整棵子树,而「重做」两个字听起来是可逆的。一屏式的「按 r 重做?y/n」会让一次
 * 手滑删掉几十个已验收节点,而用户以为自己只是重跑了一下。
 *
 * 摘要是**算出来的**,不是写死的文案:它直接来自 planRedo 的返回值,所以屏幕上说
 * 「删除 3 个子任务、改写 2 条依赖」的时候,那就是接下来真的会发生的事。两边各写一份
 * 的话,它们迟早会不一致 —— 而不一致的那一次,用户是照着屏幕做的决定。
 */
/**
 * 关口收到一个按键之后该做什么。
 *
 * 抽成纯函数的直接原因是**那条测试是假的**:假 TTY 送裸 `\x1b` 时 vendored ink 的
 * useInput 收不到,于是「第二屏 Esc 退回第一屏」这条用例里,`cancels === 0` 因为键根本
 * 没到而恒真,画面断言又因为 harness 累加所有 write、第一屏那帧从没被清掉而恒真 ——
 * 把整个 Esc 分支删掉,10 条照样全绿(实测)。
 *
 * 组件测试仍然守 q / 方向键 / 回车(那些送得进去);Esc 的语义归这里。
 */
/**
 * 摘要里哪一行是**警告**(要用告警色,不能和普通说明混在一起)。
 *
 * 抽出来是因为颜色本身**从测试接缝里看不见**:假 TTY 下 vendored ink 一个 SGR 都不发
 * (实测 FORCE_COLOR 未设时 0 个色码,设成 3 之后才有 `\u001b[93m`)。让断言依赖一个
 * 环境变量比不测更糟 —— 它会在别人本地绿、在 CI 红,或者反过来。判定是纯的,那就测判定。
 *
 * 分色的理由:一条「这些代码已经落进代码、删任务不回滚」和一条「删除 2 个子任务」
 * 长得一样时,最重的那句会被读成流水账。
 */
export function isWarningLine(line: string): boolean {
  return line.startsWith('⚠')
}

export type RedoGateState = { cursor: number; picked: RedoEntry | null }
export type RedoGateAction =
  | { kind: 'cancel' }
  | { kind: 'confirm'; entry: RedoEntry }
  | { kind: 'state'; next: RedoGateState }
  | { kind: 'none' }

export function redoGateAction(
  key: { escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean },
  input: string,
  state: RedoGateState,
  options: readonly { entry: RedoEntry; disabled?: string }[],
): RedoGateAction {
  const k = input.toLowerCase()
  // Esc 和 q 在第二屏上**不是同一件事**,页脚也是这么写的。两个键走同一分支时
  // 「q 取消」是句假话:按下去只是回到第一屏,想彻底退出得连按两次而屏幕没说。
  if (key.escape && state.picked !== null) {
    // 看完后果改主意选另一个环节,是这一步最常见的动作。
    return { kind: 'state', next: { ...state, picked: null } }
  }
  if (key.escape || k === 'q') return { kind: 'cancel' }
  if (state.picked !== null) {
    return key.return || k === 'y' ? { kind: 'confirm', entry: state.picked } : { kind: 'none' }
  }
  if (key.upArrow || k === 'k') {
    return { kind: 'state', next: { ...state, cursor: Math.max(0, state.cursor - 1) } }
  }
  if (key.downArrow || k === 'j') {
    return { kind: 'state', next: { ...state, cursor: Math.min(options.length - 1, state.cursor + 1) } }
  }
  if (key.return) {
    const opt = options[state.cursor]
    // 不可用的条目**留在屏幕上但按不动**。直接不渲染的话,菜单会随节点类型忽隐忽现,
    // 用户记不住「第二项」是哪一项;而且看不见「为什么这里不能这么做」。
    if (!opt || opt.disabled) return { kind: 'none' }
    return { kind: 'state', next: { ...state, picked: opt.entry } }
  }
  return { kind: 'none' }
}

export function ConfirmRedo(props: {
  nodes: TaskNode[]
  targetId: string
  now: string
  /**
   * 这次 run 的环节实况(哪些环节配了席位、哪些被跳过)。
   *
   * 没有它的话屏幕只能写一句无条件的「执行 → 测试验证 → 验收」,而测试验证是 opt-in ——
   * 默认配置下那句话就是假的。
   */
  phases?: RedoContext
  onConfirm: (entry: RedoEntry) => void
  onCancel: () => void
}): React.ReactElement {
  const byId = React.useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes])
  const target = byId.get(props.targetId)
  const options = React.useMemo(
    () => (target ? redoOptions(target, byId, props.phases) : []),
    [target, byId, props.phases],
  )
  const [cursor, setCursor, cursorRef] = useLiveState(0)
  const [picked, setPicked, pickedRef] = useLiveState<RedoEntry | null>(null)

  // 预演。选中哪一条就算哪一条,所以第二屏的数字和第一屏的选择永远对得上。
  const preview = React.useMemo(() => {
    const entry = picked
    if (!entry || !target) return null
    const r = planRedo(props.nodes, props.targetId, entry, props.now)
    return 'error' in r ? { error: r.error } : { plan: r }
  }, [picked, target, props.nodes, props.targetId, props.now])

  useInput((input, key) => {
    // 全部判定归 redoGateAction —— 这里只负责把结果落到 state / 回调上。
    const act = redoGateAction(key, input, { cursor: cursorRef.current, picked: pickedRef.current }, options)
    if (act.kind === 'cancel') { props.onCancel(); return }
    if (act.kind === 'confirm') { props.onConfirm(act.entry); return }
    if (act.kind === 'state') {
      if (act.next.cursor !== cursorRef.current) setCursor(act.next.cursor)
      if (act.next.picked !== pickedRef.current) setPicked(act.next.picked)
    }
  })

  if (!target) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="error">节点不存在: {props.targetId}</Text>
        <Text dimColor>q / Esc 返回</Text>
      </Box>
    )
  }

  /**
   * `&& preview` 这半个条件**当前不可达**,如实记在这里而不是假装它被测过:
   * preview 只在 `!entry || !target` 时为 null,而 picked !== null 蕴含 entry 存在,
   * target 不存在时上面那个 `if (!target)` 已经先 return 了。删掉它全套照绿(变异验证过)。
   * 留着是因为它挡的是「第二屏白屏」——一旦 preview 的依赖数组以后多一个来源,
   * 这半个条件就是唯一的防线。
   */
  if (picked !== null && preview) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">确认重做</Text>
        {'error' in preview
          ? <Text color="error">{preview.error}</Text>
          : redoSummary(preview.plan, target, picked, props.phases).map(l => (
              <Text key={l} color={isWarningLine(l) ? 'warning' : undefined}>{l}</Text>
            ))}
        {'plan' in preview && preview.plan.deleted.length > 0
          ? <Text dimColor>被删的子任务: {preview.plan.deleted.slice(0, 6).join(', ')}
              {preview.plan.deleted.length > 6 ? ` 等 ${preview.plan.deleted.length} 个` : ''}</Text>
          : null}
        <Text dimColor>回车 / y 确认 · Esc 换一个环节 · q 取消</Text>
      </Box>
    )
  }

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold>重做「{target.title}」</Text>
      <Text dimColor>从哪个环节开始重来</Text>
      {options.map((o, i) => (
        <Box key={o.entry} flexDirection="column">
          <Text color={o.disabled ? undefined : i === cursor ? 'success' : undefined} dimColor={!!o.disabled}>
            {i === cursor ? '❯ ' : '  '}{o.label}
          </Text>
          <Text dimColor>    {o.disabled ? `不可用:${o.disabled}` : o.detail}</Text>
        </Box>
      ))}
      <Text dimColor>↑↓ 选择 · 回车 下一步 · q / Esc 取消</Text>
    </Box>
  )
}
