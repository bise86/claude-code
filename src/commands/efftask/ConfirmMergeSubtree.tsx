import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  subtreeMergeLines, subtreeMergeResultLines,
  type SubtreeMergeOutcome, type SubtreeMergePlan,
} from '../../tools/efftask/mergeSubtree.js'
import type { TaskNode } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState } from './useLiveState.js'
import { redoSummaryLines } from './ConfirmRedo.js'

/**
 * 「把这棵子树里还没合的工作区合进主干」关口 —— 一屏,五个状态。
 *
 * 用户原话:「如果任务树上有 worktree 没有合并到主干,进入任务详情页,可以手动触发合并
 * 提交,并且包括所有孙子任务。如果合并遇到问题用主模型解决并且进行合并提交。」
 *
 * ## 为什么不是「按一下就合」
 *
 * 这个动作会在**用户自己的检出**里产生真实的 merge commit,而且撞冲突时会派模型去改代码。
 * 所以和回收工作区那一屏同一套骨架(ConfirmCleanup 的注释里逐条记着理由),外加一件它
 * 没有的事:
 *
 *  - `working` **要有进度**。回收是几秒钟的 `worktree remove`;这一路每个冲突都是一次
 *    模型调用,十几个节点跑几分钟很正常。一屏不动的「正在合并…」和死机在屏幕上没有区别,
 *    而这个仓库为「按下去没反应」付过两次学费。
 *  - `working` 里 **Esc/q 是「合完当前这个就停」**,不是「立刻停」:一次 git merge 中途
 *    停下来只会留下半合并状态。屏幕上写的就是这句话,不写成「已取消」。
 *
 * 判据和动作住在 `mergeSubtree.ts`(那里对着真 git 测),这一屏不认识 git。
 */
/**
 * **这一屏按下回车到底有没有事要做。**
 *
 * 判据必须**三跳全看**,而它此前只看了两跳:
 *
 *  1. `items` —— 有工作区目录、要逐个 commitAndMerge 的那些;
 *  2. `trunk` —— 第二跳(集成分支 → 你当前的分支)。一个节点都不用合、而集成分支上压着
 *     十个提交没送到,是这个键最典型的用法之一;
 *  3. **`rescue`** —— 没有工作区目录的那几类(抢救分支、只剩分支的残留、认不回主的 ref)。
 *
 * 漏掉第 3 跳的后果在验收里被**真挂载复现**过:屏幕逐字印着「另外捞回 1 处没有工作区目录
 * 的产出(共 4 个提交)」,而页脚是「回车 / q / Esc 返回」,回车走 `onCancel`,
 * `onRun` **一次都没被调用**。而那恰恰是 `rescue.ts` 自己写的主场景 —— 跑机实测 32 条
 * 工作树登记项里 **31 条**目录已不在:目录全清过、集成分支也已送达时前两跳都是空的,
 * 于是那条捞回链路**永远执行不到**。
 *
 * **抽成一份**是因为这个判据有**两个**读者(按键处理和页脚文案),而这次漏掉 rescue
 * 正是两处各写一份的直接后果。
 */
export function hasNothingToDo(p: SubtreeMergePlan): boolean {
  const rescue = p.rescue
  const hasRescue = rescue !== undefined && rescue.merge.length > 0
  return p.items.length === 0
    && (p.trunk.pending === 0 || p.trunk.blocked !== undefined)
    && !hasRescue
}

export function ConfirmMergeSubtree(props: {
  target: TaskNode
  onScan: () => Promise<SubtreeMergePlan>
  /** 执行。`onProgress` 由这一屏给进去 —— 进度是这一路唯一让人知道它还活着的东西。 */
  /** `stash` = 用户按过 `s`:第 2 跳先收起他的改动,合完自动放回(见 stashGuard)。 */
  onRun: (plan: SubtreeMergePlan, stash: boolean, onProgress: (line: string) => void) => Promise<SubtreeMergeOutcome>
  /** 「合完当前这个就停」。给了才在执行中提示这个键。 */
  onInterrupt?: () => void
  /** 关掉这一屏。合完也走它 —— 回到用户来的那一屏。 */
  onDone: () => void
  onCancel: () => void
}): React.ReactElement {
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [mode, setMode, modeRef] = useLiveState<'scanning' | 'ready' | 'working' | 'done' | 'error'>('scanning')
  const [plan, setPlan, planRef] = useLiveState<SubtreeMergePlan | null>(null)
  const [outcome, setOutcome] = useLiveState<SubtreeMergeOutcome | null>(null)
  const [error, setError] = useLiveState<string>('')
  const [progress, setProgress] = useLiveState<readonly string[]>([])
  const [stopping, setStopping] = useLiveState(false)
  /**
   * 卸载之后不再改 state。关口可以被 Esc 关掉,而扫描/合并还在跑 —— 而合并那一路**跑完
   * 也不撤销**:它已经在用户的仓库里落了提交,只是没人再看着屏幕了。
   */
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  React.useEffect(() => {
    void props.onScan().then(
      p => { if (alive.current) { setPlan(p); setMode('ready') } },
      (e: unknown) => {
        if (!alive.current) return
        setError(e instanceof Error ? e.message : String(e))
        setMode('error')
      },
    )
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时扫一次
  }, [])

  /**
   * 这一趟要不要先 stash。**用 ref 读**:按键处理器是在 `useInput` 的闭包里,
   * 而 `onRun` 在同一次按键里就被调用 —— state 那一份这时还没提交。
   */
  const [stash, setStash] = React.useState(false)
  const stashRef = React.useRef(false)
  stashRef.current = stash
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
    if (m === 'working') {
      // 合并中途唯一认的键:请求「合完当前这个就停」。**不是立刻停** —— 一次 git merge
      // 被打断只会留下半合并状态,那正是这个功能要替用户避免的东西。
      if ((key.escape || (plain && k === 'q')) && props.onInterrupt && !stopping) {
        setStopping(true)
        props.onInterrupt()
      }
      return
    }
    if (m === 'done' || m === 'error') {
      if (key.return || key.escape || (plain && k === 'q')) props.onDone()
      return
    }
    if (key.escape || (plain && (k === 'q' || k === 'n'))) { props.onCancel(); return }
    if (m !== 'ready') return
    const p = planRef.current
    /**
     * 没有节点要合、而且第二跳也没什么可送时,回车是「知道了」,不是「执行一次空操作」。
     *
     * 判据**必须带上第二跳**:一个节点都不用合、而集成分支上压着十个提交没送到用户分支,
     * 是这个键最典型的用法之一(逐任务合并那一路被脏树挡过)。只看 `items.length` 会把
     * 那一次变成死键,而屏幕上写着「回车 确认合并」。
     */
    const nothing = !p || hasNothingToDo(p)
    if (nothing) {
      if (plain && (key.return || k === 'y')) props.onCancel()
      return
    }
    /**
     * **`s`:先把你的改动收起来、合完自动放回去。**
     *
     * 只在「你手上确实有未提交的已跟踪改动」时才是一个选择 —— 否则它是一个按下去什么都
     * 不会变的键,而那比没有这个键更糟。用户原话:「提供选项,但要你按一下」;
     * 「检测到脏就自动 stash」那一档他明确否决过,所以默认永远是关。
     */
    if (plain && k === 's' && p?.trunk.dirty !== undefined) { setStash(v => !v); return }
    if (plain && (key.return || k === 'y')) {
      setMode('working')
      void props.onRun(p, stashRef.current, line => { if (alive.current) setProgress(cur => [...cur, line]) }).then(
        o => { if (alive.current) { setOutcome(o); setMode('done') } },
        (e: unknown) => {
          if (!alive.current) return
          setError(e instanceof Error ? e.message : String(e))
          setMode('error')
        },
      )
    }
  })

  const title = `合并未合入主干的工作区 —— ${props.target.title}`
  if (mode === 'scanning') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        <Text dimColor>正在清点这棵子树里还没合入集成分支的工作区…</Text>
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
    /**
     * 进度留**最新的几条**,滚掉的是最老的。
     *
     * `redoSummaryLines` 是从**尾部**裁的(它的用户是「一屏清单」,头几行最重要),而这一屏
     * 正相反 —— 用户盯着它就是想知道「现在在干什么」,裁掉最新那几行等于把这一屏唯一的
     * 用途裁掉。所以从头往下丢,直到一条都不用藏为止;丢掉了几条**说出来**,而那句话画在
     * 被裁的内容**外面**(不然它自己会是第一个被裁掉的)。
     */
    const raw = progress.length > 0 ? [...progress] : ['正在合并…']
    let recent = raw.slice(-Math.max(1, rows))
    let fit = redoSummaryLines(recent, rows, columns)
    while (fit.hidden > 0 && recent.length > 1) {
      recent = recent.slice(1)
      fit = redoSummaryLines(recent, rows, columns)
    }
    const scrolled = raw.length - recent.length
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">{title}</Text>
        {scrolled > 0 ? <Text dimColor>…前面 {scrolled} 条已滚过</Text> : null}
        {fit.shown.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
          <Text key={i} wrap="truncate-end" dimColor>{l}</Text>
        ))}
        <Text dimColor>
          {stopping
            ? '已请求中断:合完当前这个任务就停(一次 git merge 中途停下会留下半合并状态)'
            : props.onInterrupt
              ? 'q / Esc 请求中断(合完当前这个任务再停)'
              : '合并期间按键不响应'}
        </Text>
      </Box>
    )
  }

  const lines = mode === 'done'
    ? (outcome ? subtreeMergeResultLines(outcome) : ['(没有结果)'])
    : (plan ? subtreeMergeLines(plan) : ['(没有可合并的内容)'])
  const { shown, hidden } = redoSummaryLines(lines, rows, columns)
  const nothing = mode === 'ready' && plan !== null && hasNothingToDo(plan)
  const footer = mode === 'done' || nothing
    ? '回车 / q / Esc 返回'
    : '回车 / y 确认合并(会在你的分支上产生真实提交) · q / Esc / n 取消'
      + (plan?.trunk.dirty !== undefined
        ? ` · s ${stash ? '「先 stash 再合」已开(合完自动放回)' : '先 stash 再合'}`
        : '')
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      {/**
        * **标题色不能只看 `failed`。** 第 2 跳没成(含「产出合过去了,但把你的改动放回来时
        * 撞了冲突」那一种)时 `failed` 是空的,而标题此前照样是绿色的「合并完成」——
        * 而那几条恢复说明排在 `lines` 最末尾,矮终端上正是第一批被折叠掉的。
        */}
      <Text bold color={mode === 'done'
        ? (outcome?.failed.length || outcome?.trunk?.ok === false ? 'warning' : 'success')
        : 'warning'}>
        {mode === 'done' ? `合并完成 —— ${props.target.title}` : title}
      </Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={l.startsWith('⚠') ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条未显示(终端太矮);放大窗口再看</Text> : null}
      {/* `wrap` 必须有:`redoSummaryLines` 把这一行按常数 1 行预算,而开了 stash 之后
          它在 120 列上就回流成 2 行 —— 矮终端上多出来的行会把最后一条内容行顶掉。
          结束屏那一行刚为同一件事加过。 */}
      <Text dimColor wrap="truncate-end">{footer}</Text>
    </Box>
  )
}
