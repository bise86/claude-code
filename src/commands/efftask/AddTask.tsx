import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  addTaskLines, deriveTitle, type AddTaskScope,
} from '../../tools/efftask/addTask.js'
import { MAX_TASK_PROMPT_CHARS } from '../../tools/efftask/types.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useLiveState, useSettleOnce } from './useLiveState.js'
import { LineInput } from './LineInput.js'
import { isWarningLine, redoSummaryLines } from './ConfirmRedo.js'
import { wrapAnsi } from './ansiText.js'

/**
 * 「用一段提示词新增一个任务」的关口 —— 两态。
 *
 * ## 为什么是「确认屏在前、`e` 进输入框」,而不是「先打字再确认」
 *
 * 「打完字连敲两下回车」是最常见的输入习惯。排成「输入 → 确认」的话,第二下回车会落在确认屏
 * 上 —— 用户**从没看见过**那一屏列出的后果(会重开哪几个上级、预算会被重置、目标仍然是
 * 阻断的),而任务已经加进去了。所以照 `ConfirmRedo` 的形状:确认屏是主屏,`e` 进输入框。
 *
 * 第一次进来提示词是空的,所以直接停在输入屏(空着确认没有意义);写完回到确认屏。
 *
 * ## 为什么**没有** refused 这一态
 *
 * 准入判据全是同步内存读,所以拒绝根本不走这一屏:切屏会把任务树面板连同详情页整棵卸载,
 * 而用户展开到哪一段、读到第几行都住在那两个组件自己的 state 里。「什么都没发生」不该长成
 * 「你的阅读位置没了」。拒绝理由画在详情页页脚上(`act()` 那条路)。
 */
export function AddTask(props: {
  scope: AddTaskScope
  /** 新任务最终的 id —— 由调用方按**当下**的树算(slug 会退化、序号会撞)。 */
  previewId: (title: string) => string
  /** 新任务此刻跑得起来吗;`undefined` = 跑得起来。 */
  notSchedulable?: (anchorId: string) => string | undefined
  /** 结束屏那条路:确认后会重启一轮编排。 */
  willRestart?: boolean
  /** 重启会清掉几条一次性标记(只在 willRestart 时印)。 */
  clearsCancels?: number
  clearsForcePasses?: number
  /**
   * 键盘归不归这一屏。
   *
   * **两态都要传。** `/et` 声明了 spawnsSubagents,权限对话框画在它之上,而 ink 的 useInput
   * 是广播的 —— 缺了它,一下回车既确认了新增**又批准了一个待确认的工具**,而执行环节的
   * 确认可以是带写能力的 Bash。现存六个关口一个都没传(仓库现存的洞),新增面不继承。
   */
  isActive?: boolean
  /**
   * 已经打进去的那段话(以及因上限丢了几个字)。
   *
   * **住在调用方那一层。** 两条实测:①关口开着时 run 恰好跑完 → `setPhase('done')` 把
   * 这一屏连同用户正在打的几千字一起卸载;②确认之后任何一条拒绝都会关掉这一屏。
   * 两种情况下那段话都必须还在。
   */
  initialPrompt?: string
  initialDropped?: number
  /** 每次提示词变化都往上报,好让它活过这一屏的卸载。 */
  onPromptChange?: (prompt: string, dropped: number) => void
  onConfirm: (prompt: string, title: string) => void
  onCancel: () => void
}): React.ReactElement {
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  const [prompt, setPromptState, promptRef] = useLiveState(props.initialPrompt ?? '')
  const [dropped, setDroppedState, droppedRef] = useLiveState(props.initialDropped ?? 0)
  const setPrompt = (t: string, d = droppedRef.current): void => {
    setPromptState(t)
    setDroppedState(d)
    props.onPromptChange?.(t, d)
  }
  const setDropped = (d: number): void => {
    setDroppedState(d)
    props.onPromptChange?.(promptRef.current, d)
  }
  // 提示词还是空的 = 还没写过,直接停在输入屏;带着上次写的东西回来时直接停在确认屏。
  const [editing, setEditing, editingRef] = useLiveState((props.initialPrompt ?? '').trim().length === 0)

  /** 出口只许走一次 —— 确认和取消共用一把闩(见 useSettleOnce)。 */
  const settle = useSettleOnce()

  /**
   * 确认屏**真的画过一帧**了吗。
   *
   * 这一道闩不是防连按的那一道(那是 `useSettleOnce`),它防的是**同一下回车被两个处理器
   * 各解释一次**:LineInput 是本组件的子节点,而 React 的 effect 是**子先于父**执行,
   * 于是它的 `useInput` 监听槽比本组件的**先**注册、**先**跑。用户写完按下的那一下回车:
   *
   *   1. LineInput 的处理器先跑 → `onSubmit` → `setEditing(false)`,而 `useLiveState` 的
   *      ref 是**同步**更新的;
   *   2. 紧接着本组件的处理器拿到**同一个**事件,`editingRef.current` 已经是 false,
   *      于是这一下回车当场被当成「确认」——用户**一眼都没看过**那一屏后果,任务已经加了。
   *
   * 实测出来的(这条用例现在钉在 addTaskKeys.test.tsx 里)。effect 在整块 stdin 同步派发
   * **之后**才跑,所以「等下一帧」正好把这一下、以及同一个块里后面那几下,全部挡在外面。
   */
  const armed = React.useRef(false)
  React.useEffect(() => {
    armed.current = !editing
  }, [editing])

  const title = deriveTitle(prompt)

  useInput((input, key) => {
    // 输入屏的键盘整个归 LineInput(它自己有 Esc / 回车 / 退格 / 正文)。不让路的话,
    // 用户写「q 要改成小写」的那个 q 会被这里当成取消。
    if (editingRef.current) return
    // 刚从输入屏回来的那一下(以及同一个 stdin 块里后面那几下)不算数 —— 见 armed。
    if (!armed.current) return
    const k = input.toLowerCase()
    if (key.escape) { setEditing(true); return }
    if (k === 'q') { settle(() => props.onCancel()); return }
    if (k === 'e') { setEditing(true); return }
    if (key.return || k === 'y') {
      const t = promptRef.current.trim()
      // 走不到(空提示词永远停在输入屏),但空提示词会造出一个目标为空的任务,
      // 而那正是这个仓库反复在防的「凭空多出一个没人说得清要干什么的节点」。
      if (t.length === 0) { setEditing(true); return }
      settle(() => props.onConfirm(t, deriveTitle(t)))
    }
  }, { isActive: props.isActive !== false })

  if (editing) {
    return (
      <LineInput
        title="新增任务:写下这个任务的提示词"
        // Ink 不渲染 markdown,写 ** 出来就是两个星号(`AddDirective` 为同一件事写过一句,
        // 而其余三个调用点都遵守 —— 这一处上一版没遵守,验收席真渲染看出来的)。
        hint={
          '这段话会逐字成为新任务的目标(不拼父任务的上下文)。' +
          '它还会跟着进这个任务每一个子孙的目标和每一次提示词,所以别把整个文件粘进来。'
        }
        maxChars={MAX_TASK_PROMPT_CHARS}
        // 换行留着:这是一个任务的全部输入,折平会把编号列表和代码片段的结构整个抹掉。
        keepNewlines
        // 4000 码点在 100 列下是 40 个终端行,不裁会把标题和 hint 顶出屏幕。
        maxBodyRows={8}
        initialText={prompt}
        // 丢字的累计要跟着进来 —— 按 `e` 回来改一个错字,不该把「N 个字没收进来」抹掉。
        initialDropped={dropped}
        isActive={props.isActive}
        footerNote="回车 = 提交(不是换行)"
        onSubmit={(t, info) => {
          setPrompt(t, info.dropped)
          setEditing(false)
        }}
        /**
         * 输入屏的 Esc:**没写过就退出整个关口,写过就回确认屏并把写的留住**。
         *
         * 判据必须看**输入框此刻的文本**,不能只看 `promptRef` —— 那一份要到提交才更新,
         * 于是「打了三行然后按 Esc」在它眼里和「什么都没写」逐字相同,一下 Esc 就把
         * 那三行丢了。而「用户刚写完一段话、一下 Esc 把它丢掉」正是这个仓库反复付账的
         * 那一类(探针实测抓到)。
         *
         * 写过之后不退出整个关口:确认屏上还有 `q` 那个明确的出口,而且那一屏会把
         * 他写的东西完整印出来。
         */
        onCancel={(text, info) => {
          const written = text.trim().length > 0 || promptRef.current.trim().length > 0
          if (!written) { settle(() => props.onCancel()); return }
          /**
           * **`trim()` 和 `dropped` 两件都要跟着走。**
           *
           * 存未 trim 的原文,确认屏印的就和最终落盘的 `goal` 不是同一段字符串
           * (`onConfirm` 那里还会 trim 一次);而丢字警告只挂在 LineInput 自己的 state 上,
           * 不接过来的话,走 Esc 这条路回到确认屏时「N 个字没有收进来」整条消失 ——
           * 而这条路恰恰是文档承诺用来「把写的留住」的那一条。两条都是验收席实跑抓到的。
           */
          if (text.trim().length > 0) setPrompt(text.trim(), info.dropped)
          setEditing(false)
        }}
      />
    )
  }

  const id = props.previewId(title)
  const lines = addTaskLines(props.scope, {
    title,
    id,
    prompt,
    droppedChars: dropped,
    ...(props.notSchedulable === undefined
      ? {}
      : (() => {
        const why = props.notSchedulable(props.scope.anchor.id)
        return why === undefined ? {} : { notSchedulable: why }
      })()),
    ...(props.willRestart === true ? { willRestart: true } : {}),
    ...(props.clearsCancels === undefined ? {} : { clearsCancels: props.clearsCancels }),
    ...(props.clearsForcePasses === undefined ? {} : { clearsForcePasses: props.clearsForcePasses }),
  })
  /**
   * 提示词回显。**按真实显示宽度折行、按行数裁,而且那个数字必须是真的。**
   *
   * 上一版是 `<Text wrap="truncate-end">{整段}</Text>` + 一句「以下显示前 400 字」,
   * 两位验收员各自实测出同一组读数:120 列下号称 400 字、**实际画出 40~57 个**;
   * 60 列下号称「逐字」、实际 24 个。ink 把整段塞进一个 Text 之后按框宽再截一次,
   * 而屏幕上那个数字纹丝不动 —— 用户是在这一屏按下不可逆确认的,却看不到自己写的东西。
   *
   * 另一半是高度:40 行的提示词会把标题和全部 ⚠ 后果行顶出屏幕(非全屏时终端滚掉的
   * 正是顶部)。所以正文自己也要有行上限,而「上面/下面还有多少」印在**被裁那段之外**。
   */
  const PROMPT_ROWS = 8
  // 边框 2 + paddingX 各 1 → 正文可用宽。夹到 ≥1,免得窄终端上 wrapAnsi 拿到 0。
  const bodyWidth = Math.max(1, columns - 4)
  const wrapped = prompt.split('\n').flatMap(l => (l === '' ? [''] : wrapAnsi(l, bodyWidth)))
  const bodyShown = wrapped.slice(0, PROMPT_ROWS)
  const bodyHidden = wrapped.length - bodyShown.length
  // 和重做 / 清理 / 依赖重算关口共用同一份夹取。回显真正会占几行,从预算里先扣掉。
  const { shown, hidden } = redoSummaryLines(
    lines, Math.max(4, rows - (bodyShown.length + 2)), columns,
  )

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">确认新增任务</Text>
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={isWarningLine(l) ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>…另有 {hidden} 条后果未显示(终端太矮);放大窗口再看</Text> : null}
      <Text dimColor>
        {bodyHidden > 0
          ? `提示词(共 ${Array.from(prompt).length} 字 / ${wrapped.length} 行,以下是前 ${bodyShown.length} 行):`
          : `提示词(逐字,共 ${Array.from(prompt).length} 字):`}
      </Text>
      {bodyShown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={`b-${i}`}>{l}</Text>
      ))}
      {/* 截断提示必须活在被截断的那一段**之外** —— 这个仓库为这条写过一次判决。 */}
      {bodyHidden > 0 ? <Text dimColor>… 下面还有 {bodyHidden} 行没显示(按 e 可以回去看全文)</Text> : null}
      <Text dimColor>回车 / y 确认 · e 改提示词 · Esc 返回改写 · q 取消</Text>
    </Box>
  )
}
