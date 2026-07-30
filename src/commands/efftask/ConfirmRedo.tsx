import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import {
  guidanceScopeFor, planRedo, redoOptions, redoSummary,
  type RedoContext, type RedoEntry, type RedoScope,
} from '../../tools/efftask/redo.js'
import { MAX_GUIDANCE_CHARS, PHASE_LABEL, type PhaseName, type TaskNode } from '../../tools/efftask/types.js'
import { LineInput } from './LineInput.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { clipToWidth, wrapDisplayWidth } from './logView.js'
import { useLiveState } from './useLiveState.js'

/**
 * 重做关口 —— 三屏。
 *
 * 第一屏选**粒度**(任务重做 / 阶段重做),第二屏选**环节**,第三屏**先把后果摊开再要确认**。
 *
 * 分屏不是排版偏好。任务重做会删掉整棵子树,而「重做」两个字听起来是可逆的;把它和
 * 五六个「只重跑一个环节」的条目并排放在同一张单子上,选错一行的代价差着数量级。
 * 一屏式的「按 r 重做?y/n」会让一次手滑删掉几十个已验收节点,而用户以为自己只是重跑了一下。
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
 * (实测 FORCE_COLOR 未设时 0 个色码,设成 3 之后才有 `[93m`)。让断言依赖一个
 * 环境变量比不测更糟 —— 它会在别人本地绿、在 CI 红,或者反过来。判定是纯的,那就测判定。
 *
 * 分色的理由:一条「这些代码已经落进代码、删任务不回滚」和一条「删除 2 个子任务」
 * 长得一样时,最重的那句会被读成流水账。
 */
export function isWarningLine(line: string): boolean {
  return line.startsWith('⚠')
}

/** 第一级两条的次序。第 0 条是任务重做,第 1 条是阶段重做 —— 键盘处理和渲染共用它。 */
export const SCOPE_ROWS: readonly RedoScope[] = ['task', 'phase']

export type RedoGateState = {
  /** null = 还在第一级(选粒度);'phase' = 已经进了环节清单。 */
  scope: RedoScope | null
  cursor: number
  picked: RedoEntry | null
  /**
   * 补提示词那一屏开着吗。
   *
   * 它是**确认屏的一个岔路**,不是第四级:`e` 进去写、写完回到确认屏(能看到自己写了什么)、
   * 再按回车确认。做成一级的话,用户写完那句话会直接开跑 —— 而这一屏的全部意义是
   * 「按下确认之前先看清后果」。
   */
  noting?: boolean
}
export type RedoGateAction =
  | { kind: 'cancel' }
  | { kind: 'confirm'; entry: RedoEntry }
  | { kind: 'state'; next: RedoGateState }
  | { kind: 'none' }

export function redoGateAction(
  key: { escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean },
  input: string,
  state: RedoGateState,
  /** **全部七条**,不是某一屏那几条 —— 两屏共用一份授权判据,免得它们各说各话。 */
  options: readonly { entry: RedoEntry; scope: RedoScope; disabled?: string }[],
): RedoGateAction {
  const k = input.toLowerCase()
  const phaseOpts = options.filter(o => o.scope === 'phase')
  /**
   * 补提示词那一屏的键盘**整个归 LineInput** —— 它自己有 Esc / 回车 / 退格 / 正文。
   *
   * 必须排在最前面。少了这一句,用户写「q 要改成小写」时那个 `q` 会被下面
   * 「`q` = 取消」吃掉:整个关口关闭,他刚打的字全没了,而屏幕上没有任何解释。
   * `y` 更糟 —— 确认屏那一支会把它当「确认」,当场开跑。
   */
  if (state.noting === true) return { kind: 'none' }
  // Esc 在三屏上**不是同一件事**,页脚也是这么写的。三屏走同一分支时「q 取消」是句假话:
  // 按下去只是退一级,想彻底退出得连按三次而屏幕没说。
  if (key.escape && state.picked !== null) {
    // 看完后果改主意,是这一步最常见的动作。退回它是从哪一级选出来的那一屏。
    return { kind: 'state', next: { ...state, picked: null } }
  }
  if (key.escape && state.scope !== null) {
    return { kind: 'state', next: { scope: null, cursor: 0, picked: null } }
  }
  if (key.escape || k === 'q') return { kind: 'cancel' }
  if (state.picked !== null) {
    // `e` 进补提示词那一屏(用户原话:「重做失败的阶段,可以塞新的提示词给这个阶段」/
    // 「重做整个子任务时,可以塞新的提示词给这个子任务」)。
    if (k === 'e') return { kind: 'state', next: { ...state, noting: true } }
    return key.return || k === 'y' ? { kind: 'confirm', entry: state.picked } : { kind: 'none' }
  }
  const rows = state.scope === null ? SCOPE_ROWS.length : phaseOpts.length
  if (key.upArrow || k === 'k') {
    return { kind: 'state', next: { ...state, cursor: Math.max(0, state.cursor - 1) } }
  }
  if (key.downArrow || k === 'j') {
    // `Math.max(0, …)`:一屏零条时 `rows - 1` 是 -1,光标会被推到 -1 上 —— 一个
    // 渲染成空白、回车又什么都不匹配的位置。零条这一屏是可达的(七条全禁用时
    // 回车不进来,但 state 可以从别处到达),所以下限必须写死。
    return { kind: 'state', next: { ...state, cursor: Math.min(Math.max(0, rows - 1), state.cursor + 1) } }
  }
  if (key.return) {
    if (state.scope === null) {
      // 任务重做直接进确认屏 —— 它只对应一个环节(分析),中间再插一屏只有一条的清单
      // 是空转。但**授权判据仍然是同一份**:走 options 里 plan 那条的 disabled。
      if (SCOPE_ROWS[state.cursor] === 'task') {
        const task = options.find(o => o.entry === 'plan')
        if (!task || task.disabled) return { kind: 'none' }
        return { kind: 'state', next: { ...state, picked: task.entry } }
      }
      // 一条都按不动时别把用户送进一屏全灰的清单。
      if (phaseOpts.every(o => o.disabled)) return { kind: 'none' }
      return { kind: 'state', next: { scope: 'phase', cursor: 0, picked: null } }
    }
    const opt = phaseOpts[state.cursor]
    // 不可用的条目**留在屏幕上但按不动**。直接不渲染的话,菜单会随节点类型忽隐忽现,
    // 用户记不住「第二项」是哪一项;而且看不见「为什么这里不能这么做」。
    if (!opt || opt.disabled) return { kind: 'none' }
    return { kind: 'state', next: { ...state, picked: opt.entry } }
  }
  return { kind: 'none' }
}

/**
 * 边框(2)+ 标题(1)+ 页脚(1),再给 REPL 自己的输入框和状态行留 6 行。
 *
 * `/et` 在 index.ts 里**没有** isImmediate,所以这张关口是画在 REPL 的 transcript 流里的,
 * 下面还有别的东西 —— 输入框和状态行不归这个组件管,行数只能估。
 *
 * 估**多**了的代价是少显示几行说明;估**少**了的代价是整屏溢出,而 ink 不裁剪:
 * 终端自己滚,滚掉的是最上面的标题和光标那几条。两边不对称,所以往保守估。
 */
const MENU_CHROME_ROWS = 10

/** 一条说明最多占几行。再长就夹掉 —— 它是说明,不是正文。 */
const MAX_DETAIL_ROWS = 3

/** 说明行在这一屏上**真正会占几个终端行**。边框 2 + paddingX 2 + 缩进 4。 */
export function redoDetailLines(text: string, columns: number): string[] {
  if (text.length === 0) return []
  const w = Math.max(8, columns - 8)
  const all = wrapDisplayWidth(text, w)
  if (all.length <= MAX_DETAIL_ROWS) return all
  const kept = all.slice(0, MAX_DETAIL_ROWS)
  kept[MAX_DETAIL_ROWS - 1] = clipToWidth(`${kept[MAX_DETAIL_ROWS - 1]}…`, w)
  return kept
}

/** 这一屏的说明按不按下去算 —— disabled 时屏幕上显示的是原因,不是 detail。 */
function bodyTextOf(o: { detail: string; disabled?: string }): string {
  return o.disabled ? `不可用:${o.disabled}` : o.detail
}

/**
 * 环节清单这一屏能画几条、画不画每条下面的说明。
 *
 * 必须算,不能平铺:六条带说明是 12 行 + 4 行框架 + REPL 的 5 行 = 21 行,24 行终端上
 * 就已经溢出了。而 ink **不裁剪** —— 实测把 28 行的 Box 写进 24 行的假 TTY,28 行全写
 * 出去,终端自己滚,滚掉的是**最上面**的标题和前几条,页脚反而留着。用户于是看不见
 * `❯` 停在哪一项,也看不见这是哪个节点。
 *
 * 这个功能里其它每张清单都有预算(名册夹到 80 码点并印「另 N 席未显示」,名册编辑器
 * 开 6 行的窗并印「←N →N」),唯独这一张两样都没有。
 */
export function redoMenuLayout(
  rows: number,
  columns: number,
  options: readonly { detail: string; disabled?: string }[],
  cursor: number,
): { from: number; capacity: number; detailed: boolean } {
  const budget = Math.max(1, rows - MENU_CHROME_ROWS)
  const count = options.length
  // **按折行后的真实行数算**,不是「一条说明 = 一行」。这一屏 99% 是中文:一个汉字
  // 占两列,80 列终端上一句 40 字的说明就是两行。按码点估算的话预算永远是错的,
  // 而错的方向是「以为放得下」—— 于是溢出、终端滚动、标题和光标滚出屏幕。
  const heights = options.map(o => 1 + redoDetailLines(bodyTextOf(o), columns).length)
  if (heights.reduce((a, b) => a + b, 0) <= budget) {
    return { from: 0, capacity: count, detailed: true }
  }
  // 放不下就只给**光标停着的那一条**留说明:用户要按的就是它,而「这一条会毁掉什么」
  // 正写在那儿。其余每条一行。
  const at = Math.max(0, Math.min(cursor, count - 1))
  const body = redoDetailLines(bodyTextOf(options[at] ?? { detail: '' }), columns).length
  // 还留一行给「上面/下面还有几条」—— 那是用户唯一能知道自己没看全的依据,所以它占的是
  // **预算之内**的一行,不是挤在预算之外让终端去滚。
  const capacity = Math.max(1, Math.min(count, count + body <= budget ? count : budget - body - 1))
  let from = at >= capacity ? at - capacity + 1 : 0
  from = Math.min(from, Math.max(0, count - capacity))
  return { from, capacity, detailed: false }
}

/**
 * 确认屏那几行摘要,**按显示宽度折行并夹进预算**。
 *
 * 这一屏此前一行预算都没有,而它才是最长、也最要命的那一屏:实测 80×24 上一个带
 * 9 个子任务 + 依赖改写/移除 + 祖先重开 + 工作区的父节点,光这个框就 21 行,
 * 加上 REPL 自己那 5 行 = 26 > 24 —— ink 不裁剪,终端自己滚,**滚掉的是最上面 4 行**,
 * 而这次新加的三条披露(退出终态 / salvage 分支 / 执行者会读到什么)正好排在那儿。
 *
 * 夹的时候留最前面的:摘要是**按重要性排的**(先说会重新走哪些环节、再说退出终态、
 * 再说删了什么)。被夹掉的那几条印一行计数,而计数行占的是**预算之内**的一行。
 */
export function redoSummaryLines(
  lines: readonly string[], rows: number, columns: number,
): { shown: string[]; hidden: number } {
  const budget = Math.max(2, rows - MENU_CHROME_ROWS)
  const wrapped: string[][] = lines.map(l => wrapDisplayWidth(l, Math.max(8, columns - 4)))
  const out: string[] = []
  let used = 0
  for (let i = 0; i < wrapped.length; i++) {
    const need = wrapped[i]!.length
    // 还有没画的就得给计数行留一行。
    const reserve = i < wrapped.length - 1 ? 1 : 0
    if (used + need + reserve > budget) return { shown: out, hidden: lines.length - i }
    out.push(...wrapped[i]!)
    used += need
  }
  return { shown: out, hidden: 0 }
}

/** 一屏清单。窗口、隐藏计数、说明行的开关都在这里,两级菜单共用。 */
function OptionList(props: {
  options: readonly { label: string; detail: string; disabled?: string }[]
  cursor: number
  rows: number
  columns: number
}): React.ReactElement {
  const { from, capacity, detailed } = redoMenuLayout(props.rows, props.columns, props.options, props.cursor)
  const shown = props.options.slice(from, from + capacity)
  const above = from
  const below = Math.max(0, props.options.length - from - capacity)
  return (
    <Box flexDirection="column">
      {shown.map((o, i) => {
        const at = from + i
        const body = detailed || at === props.cursor ? redoDetailLines(bodyTextOf(o), props.columns) : []
        return (
          <Box key={o.label} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate-end" color={o.disabled ? undefined : at === props.cursor ? 'success' : undefined} dimColor={!!o.disabled}>
              {at === props.cursor ? '❯ ' : '  '}{o.label}
            </Text>
            {body.map((line, j) => (
              // 每行自己一个 Text 并且 truncate-end —— 交给 Ink 自动回流的话,
              // 「一条说明 = redoDetailLines 算出的那几行」这个不变量就断了,
              // 而上面的预算全建立在它上面。
              // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
              <Text key={j} dimColor wrap="truncate-end">    {line}</Text>
            ))}
          </Box>
        )
      })}
      {above > 0 || below > 0
        ? <Text dimColor>{above > 0 ? `↑ 上面还有 ${above} 条` : ''}{above > 0 && below > 0 ? ' · ' : ''}{below > 0 ? `↓ 下面还有 ${below} 条` : ''}</Text>
        : null}
    </Box>
  )
}

/** 确认屏的正文。折行、夹取、以及「另 N 条未显示」都在这里。 */
function SummaryBody(props: { lines: readonly string[]; rows: number; columns: number }): React.ReactElement {
  const { shown, hidden } = redoSummaryLines(props.lines, props.rows, props.columns)
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 折行结果按位置定义,内容可重复
        <Text key={i} wrap="truncate-end" color={isWarningLine(l) ? 'warning' : undefined}>{l}</Text>
      ))}
      {hidden > 0
        // 计数行**在预算之内**,不是挤在预算之外让终端去滚 —— 否则最先滚掉的就是它。
        ? <Text dimColor>…另有 {hidden} 条后果未显示(终端太矮);放大窗口或见 run.md</Text>
        : null}
    </Box>
  )
}

export function ConfirmRedo(props: {
  nodes: TaskNode[]
  targetId: string
  now: string
  /**
   * 这次 run 的环节实况(哪些环节配了席位、哪些被跳过)。
   *
   * 没有它的话屏幕只能写一句无条件的「执行 → 测试验证 → 验收」,而测试验证是 opt-in ——
   * 默认配置下那句话就是假的。同一份 ctx 也会传给 planRedo,免得「屏幕禁用、planRedo 放行」。
   */
  phases?: RedoContext
  /**
   * 直接停在这个环节的**确认屏**上(跳过前两屏)。
   *
   * 「快速重做失败的那个环节」走它:失败点已经决定了要重做哪一条,两屏菜单是白走。
   * 但**仍然要过确认屏** —— 失败在分析环节的拆分型节点,它的入口就是「任务重做」,
   * 而那一条会删掉整棵子树。一个按下去就删的快捷键不该存在。
   */
  initialEntry?: RedoEntry
  /**
   * 确认之后回调,带上用户补的那句提示词(没写就是 undefined)。
   *
   * `scope` 由粒度决定:任务重做给整个节点(`'all'`),阶段重做只给那个环节 ——
   * 用户的两句原话分别对应这两个去处。
   */
  onConfirm: (entry: RedoEntry, guidance?: { scope: PhaseName | 'all'; text: string }) => void
  onCancel: () => void
}): React.ReactElement {
  const byId = React.useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes])
  const target = byId.get(props.targetId)
  const options = React.useMemo(
    () => (target ? redoOptions(target, byId, props.phases) : []),
    [target, byId, props.phases],
  )
  const phaseOpts = React.useMemo(() => options.filter(o => o.scope === 'phase'), [options])
  const taskOpt = React.useMemo(() => options.find(o => o.entry === 'plan'), [options])
  const term = useTerminalSize()
  const { rows, columns } = useModalOrTerminalSize(term)
  // `initialEntry` 决定初始屏:给了就直接停在确认屏上(见它的注释)。粒度跟着它算 ——
  // 摘要和补充指引的去处都按粒度分流,写死 'phase' 会让快速重做的任务重做把那句提示词
  // 送错地方。
  const [scope, setScope, scopeRef] = useLiveState<RedoScope | null>(
    props.initialEntry === undefined ? null : props.initialEntry === 'plan' ? 'task' : 'phase',
  )
  const [cursor, setCursor, cursorRef] = useLiveState(0)
  const [picked, setPicked, pickedRef] = useLiveState<RedoEntry | null>(props.initialEntry ?? null)
  const [noting, setNoting, notingRef] = useLiveState(false)
  /** 用户补的那句提示词。空串 = 没补。 */
  const [note, setNote, noteRef] = useLiveState('')

  // 预演。选中哪一条就算哪一条,所以第三屏的数字和前面的选择永远对得上。
  const preview = React.useMemo(() => {
    const entry = picked
    if (!entry || !target) return null
    const r = planRedo(props.nodes, props.targetId, entry, props.now, props.phases)
    return 'error' in r ? { error: r.error } : { plan: r }
  }, [picked, target, props.nodes, props.targetId, props.now, props.phases])

  /** 这次补的提示词给谁 —— 任务重做给整个节点,阶段重做只给那个环节。 */
  const guidanceScope = (entry: RedoEntry): PhaseName | 'all' =>
    guidanceScopeFor(entry, scopeRef.current ?? 'phase')

  useInput((input, key) => {
    /**
     * 「节点不存在」那一屏上**只有出口**。
     *
     * 评审实按出来的:那一屏的页脚只写「q / Esc 返回」,而 `initialEntry` 预置了 `picked`
     * 之后,`redoGateAction` 在 `picked !== null` 那一支会把回车当**确认**——于是屏幕说
     * 「节点不存在: nope」,回车却把 `onConfirm('execute')` 发出去了。`runRedo` 会二次校验
     * 所以不毁数据,但回车是最容易误按的那个键,而屏幕刚说这件事做不到。
     */
    if (!target) {
      if (key.escape || input.toLowerCase() === 'q') props.onCancel()
      return
    }
    // 全部判定归 redoGateAction —— 这里只负责把结果落到 state / 回调上。
    const act = redoGateAction(
      key, input,
      { scope: scopeRef.current, cursor: cursorRef.current, picked: pickedRef.current, noting: notingRef.current },
      options,
    )
    if (act.kind === 'cancel') { props.onCancel(); return }
    if (act.kind === 'confirm') {
      const t = noteRef.current.trim()
      props.onConfirm(act.entry, t.length > 0 ? { scope: guidanceScope(act.entry), text: t } : undefined)
      return
    }
    if (act.kind === 'state') {
      if (act.next.scope !== scopeRef.current) setScope(act.next.scope)
      if (act.next.cursor !== cursorRef.current) setCursor(act.next.cursor)
      if (act.next.picked !== pickedRef.current) setPicked(act.next.picked)
      if ((act.next.noting === true) !== notingRef.current) setNoting(act.next.noting === true)
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
   * 留着是因为它挡的是「第三屏白屏」——一旦 preview 的依赖数组以后多一个来源,
   * 这半个条件就是唯一的防线。
   */
  /**
   * 补一句提示词那一屏。
   *
   * 用户的两句原话:「重做失败的阶段,可以塞新的提示词给这个阶段」、「重做整个子任务时,
   * 可以塞新的提示词给这个子任务」。去处按粒度分,标题把它说出来 —— 同一个输入框写下的
   * 一句话,进「这个环节的提示词」和进「这个节点每个环节的提示词」是两件事,
   * 而用户是照着标题决定要不要写具体到某一步的。
   */
  if (picked !== null && noting) {
    const scopeText = guidanceScopeFor(picked, scope ?? 'phase') === 'all'
      ? `「${target.title}」的每一个环节`
      : `「${target.title}」的「${PHASE_LABEL[picked]}」这一步`
    return (
      <LineInput
        title={`补一句提示词给${scopeText}`}
        hint={'它会被拼进该环节的提示词(裁决类环节也看得到,并被告知按补充后的意图判)。同一处再写一次是替换。'}
        maxChars={MAX_GUIDANCE_CHARS}
        // 再进来一次是**接着改**,不是从空开始 —— 页脚在写过之后写的就是「改写」。
        initialText={note}
        footerNote="留空 = 不补充"
        onSubmit={t => { setNote(t); setNoting(false) }}
        // 取消**只关这一屏**,不取消整次重做 —— 用户可能只是改主意不补了。
        // 已经写过的那句话保留:他按 e 再进来还能看到。
        onCancel={() => setNoting(false)}
      />
    )
  }

  if (picked !== null && preview) {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="warning">确认重做</Text>
        {'error' in preview
          ? <Text color="error">{preview.error}</Text>
          : <SummaryBody
              lines={[
                ...redoSummary(preview.plan, target, picked, props.phases),
                ...(preview.plan.deleted.length > 0
                  ? [`被删的子任务: ${preview.plan.deleted.slice(0, 6).join(', ')}${preview.plan.deleted.length > 6 ? ` 等 ${preview.plan.deleted.length} 个` : ''}`]
                  : []),
                /**
                 * 补过的那句话要**印在这一屏上**。
                 *
                 * 它会真的进提示词,而这是用户按下确认之前最后一次核对自己写了什么的机会。
                 * 只在页脚写一句「已补充」是半句话:他不知道自己有没有打错、打漏。
                 */
                ...(note.trim().length > 0
                  ? [`补充指引(给${guidanceScopeFor(picked, scope ?? 'phase') === 'all' ? '整个任务' : `「${PHASE_LABEL[picked]}」`}): ${note.trim()}`]
                  : []),
              ]}
              rows={rows} columns={columns}
            />}
        <Text dimColor>回车 / y 确认 · e {note.trim().length > 0 ? '改写补充指引' : '补一句提示词'} · Esc 返回重选 · q 取消</Text>
      </Box>
    )
  }

  if (scope === 'phase') {
    return (
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold>阶段重做「{target.title}」</Text>
        <OptionList options={phaseOpts} cursor={cursor} rows={rows} columns={columns} />
        <Text dimColor>↑↓ 选择 · 回车 下一步 · Esc 上一级(「分析」在那里) · q 取消</Text>
      </Box>
    )
  }

  const enabledPhases = phaseOpts.filter(o => !o.disabled).map(o => o.label.replace(/^从「|」重做$/g, ''))
  const scopeRows: { label: string; detail: string; disabled?: string }[] = [
    {
      label: '任务重做',
      detail: taskOpt?.detail ?? '',
      disabled: taskOpt?.disabled,
    },
    {
      label: '阶段重做',
      // 把**能选的那几个**直接写在这里。进去才发现六条全灰,是白走一趟;而且这一行
      // 顺带回答了「阶段重做到底能做什么」——那正是用户在这一屏要判断的事。
      detail: enabledPhases.length > 0
        ? `从某一个环节重新开始;本节点可选:${enabledPhases.join('、')}`
        : '从某一个环节重新开始',
      disabled: enabledPhases.length > 0 ? undefined : '本节点没有任何可单独重入的环节 —— 只能整任务重来',
    },
  ]

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold>重做「{target.title}」</Text>
      <OptionList options={scopeRows} cursor={cursor} rows={rows} columns={columns} />
      <Text dimColor>↑↓ 选择 · 回车 下一步 · q / Esc 取消</Text>
    </Box>
  )
}
