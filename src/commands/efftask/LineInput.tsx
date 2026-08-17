import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { wrapAnsi } from './ansiText.js'
import { useLiveState } from './useLiveState.js'

/**
 * 一行文本输入。
 *
 * 这个仓库的 vendored ink **没有输入框**,所以每一处要收一段话的地方都得自己收字符。
 * 抽出来是因为现在有**五处**:运行中追加指令、重做 / 跳过 / 强制通过时补一句提示词、
 * 以及新增任务的那整段提示词。
 * 各写一份的话,下面那四个坑要各踩一遍 —— 它们每一个都是实测出来的:
 *
 *  1. **必须能让出键盘**(`isActive`)。`/et` 声明了 spawnsSubagents,权限对话框会画在它
 *     **之上**,而 ink 的 useInput 是广播的 —— 缺了这个守卫,一下回车既提交了输入
 *     **又批准了待确认的工具**,而执行环节的确认可以是带写能力的 Bash。打字过程中每个
 *     字符也会同时喂给对话框,数字/字母还可能选中它的选项。
 *  2. **退格按码点退**,不是按 UTF-16 单元:一个 emoji 退一次要整个消失,否则会留下半个
 *     代理对,终端上显示成一个替换字符,而用户再退一次才走。
 *  3. **控制字符不进正文,但换行要留成空格**。直接滤掉的话,粘一段多行文本会被静默拼成
 *     一行:「不要动 A\n删掉 B」变成「不要动 A删掉 B」,语义都变了,而用户看不出来。
 *  4. **组合键归终端**(Ctrl+C 之类),别当成正文吃掉。
 */
export function LineInput(props: {
  /** 标题行。 */
  title: string
  /** 标题下面那句说明 —— 说清这段话**会**怎么被用,以及**不会**怎么被用。 */
  hint: string
  /** 长度上限(按码点)。 */
  maxChars: number
  /**
   * 初始文本 —— 再进来一次时接着改,而不是从空开始。
   *
   * 重做/跳过关口的页脚在写过一次之后写的是「e **改写**补充指引」,而不给这个 prop 的话
   * 进来是空的:想改一个错字的人只补了半句,原句就被替换掉了(评审实测)。
   */
  initialText?: string
  /**
   * 已经丢过几个字(上一次进这一屏时的累计)。
   *
   * 不接的话:4100 字 → 确认屏印「100 个字没有收进来」→ 按 `e` 回来改一个错字 → 再确认,
   * **那一行没了**,而提示词仍然是被截断的。这一屏重挂时内部计数从 0 起,而丢字这件事
   * 是上一次发生的。验收席实测(`onCancel` 那条路刚被修好、`onSubmit` 这条漏了)。
   */
  initialDropped?: number
  /**
   * 键盘归不归这一屏。见上面第 1 条。
   *
   * **今天只有 `AddDirective` 真的传它**,而那是唯一在**运行中**弹出来的输入框 ——
   * 重做/跳过关口只挂在 done 视图上,那时 run 已经结束,不会有在飞的调用弹权限框。
   * 如实记下来,而不是让上面那条「必须有」读起来像每个调用点都在遵守它。
   */
  isActive?: boolean
  /** 页脚右边的补充说明(可选),比如「留空 = 不补充」。 */
  footerNote?: string
  /**
   * 换行留在正文里,不折成空格。
   *
   * **默认 false。** 只有「新增任务」传真:那一段话是一个任务的全部输入(它会成为节点的
   * `goal`),而折平会把编号列表、代码片段的结构整个抹掉。
   *
   * ⚠ 上一版这里写着「现有三个调用点**逐字节不变**」——**两处都不准**,验收席 A/B 实跑:
   * 调用点其实是**四个**(`AddDirective` / `ConfirmRedo` / `ConfirmSkip` / `ConfirmForcePass`),
   * 而且默认档下有两处可见变化:`甲\r\n乙` 从两个空格变成一个(CRLF 先归一了),
   * 以及超上限时多印一行「N 个字没有收进来」。两条都是改进,但不能说成「没变」。
   *
   * ## 这条路通,是实测出来的
   *
   * 真渲染 + 真按键量过:一个 chunk 里的 `\n`(块首/块中/块尾/裸块)和块**中间**的 `\r`
   * 都是**普通字符**,不会被解析成回车;4000 字一整块也完整到达。
   *
   * **剩下的那一种,以及一条被推翻的说法。** 上一版这里写着「恰好以 `\r` **开头**的块会被
   * 解析成 `key.return`」—— **那是错的**,验收席真渲染真按键推翻了它:送 `"前半段"` 再送
   * `"\r后半段"`,零 submit、零 cancel,最终提交 `"前半段\n后半段"`。判据在
   * `parse-keypress.ts:701`,是 `s === '\r'` —— **整块恰好等于** CR 才算回车,不是「以它开头」。
   * 所以真正会提交半截的只有「一次 read 恰好只拿到那一个字节」这一种,而它是既有行为
   * (今天折成空格的路上同样如此),不因这个开关变好也不变坏。
   */
  keepNewlines?: boolean
  /**
   * 正文最多画几行。超了只画**尾部**(光标在那儿),并在上面印一句「上面还有 N 行」。
   *
   * 必须有:4000 码点在 100 列下是 40 个终端行,而 `/et` 非全屏时渲染在对话流里 ——
   * 帧高一旦超过视口,任务树那个 1s tick 每跳一次就逼出一次整屏重置,而且**切掉的是顶部**
   * (标题和 hint)。省略 = 不裁,现有调用点行为不变。
   */
  maxBodyRows?: number
  /**
   * `info.dropped` = 因为长度上限被丢掉了几个码点。
   *
   * 交出去而不是只画在这一屏上:确认关口要把它再说一遍 —— 用户是在**那一屏**按下不可逆的
   * 确认的,而这一屏他可能几十秒前就翻过去了。现有调用点只收第一个参数,逐字不受影响。
   */
  onSubmit: (text: string, info: { dropped: number }) => void
  /**
   * 取消。**带上此刻已经打进去的那段话。**
   *
   * 不带的话,调用方对「他什么都没写就 Esc」和「他写了三行才 Esc」看到的是同一件事 ——
   * 而这两件事该做的完全相反(前者是退出,后者绝不能把他写的东西丢掉)。
   * 现有调用点忽略这个参数,行为逐字不变。
   */
  onCancel: (text: string, info: { dropped: number }) => void
}): React.ReactElement {
  // 按码点夹到上限:传进来的初值也可能超(它上一次就是这么被夹的,但调用方不该依赖那个)。
  const [text, setText, textRef] = useLiveState(
    Array.from(props.initialText ?? '').slice(0, props.maxChars).join(''),
  )
  /**
   * 因为上限被丢掉的码点数,**累计**。
   *
   * 在这之前超限是**静默**的:实测 `maxChars=5` 喂 `abcdefghij` 提交的是 `abcde`,而整帧里
   * 没有任何一个字提到丢弃。`control.ts` 为**同一件事**(追加指令超条数)专门写了 `dropped`
   * 计数并把「(较早的 N 条…已被丢弃)」塞进返回值,注释原话是「静默丢弃用户亲手写的话是
   * 这个仓库反复付过代价的那一类」。这里是同一条规矩的另一半。
   *
   * 累计而不是「这一次丢了几个」:他连按十下,要知道的是**一共**没进去多少。
   */
  const [dropped, setDropped, droppedRef] = useLiveState(props.initialDropped ?? 0)

  useInput((input, key) => {
    if (key.escape) { props.onCancel(textRef.current, { dropped: droppedRef.current }); return }
    if (key.return) {
      const t = textRef.current.trim()
      // 空的就当取消。提交一段空文本会在提示词里留一个空槽,而模型会努力去理解它。
      if (t.length === 0) props.onCancel(textRef.current, { dropped: droppedRef.current })
      else props.onSubmit(t, { dropped: droppedRef.current })
      return
    }
    if (key.backspace || key.delete) {
      const cps = Array.from(textRef.current)
      cps.pop()
      setText(cps.join(''))
      return
    }
    if (key.ctrl || key.meta) return
    if (input.length === 0) return
    const nl = props.keepNewlines === true
    const mapped = Array.from(
      // CRLF 先归一,否则 keepNewlines 下一个换行会变成两个(实测:`a\r\nb` 折出两个空格)。
      input.replace(/\r\n/g, '\n'),
    )
      .map(c => (c === '\n' || c === '\r' ? (nl ? '\n' : ' ') : c))
    const clean = mapped
      // `\n` 的码点小于空格,所以留换行时要显式放行它。DEL(U+007F)大于空格,得单独挡 ——
      // 不挡的话它会原样进正文(而它在 `goal` 里就是一个看不见的字节)。
      .filter(c => (c >= ' ' && c !== '\u007f') || c === '\t' || (nl && c === '\n'))
      .join('')
    // 被滤掉的控制字符也算「没有收进来」。以前它们是**静默**消失的:粘一段带 ANSI 的日志,
    // 那些字节直接没了,而页脚的计数和 dropped 都不反映(验收席点名的第三处静默改写)。
    const filtered = mapped.length - Array.from(clean).length
    if (clean.length === 0) {
      if (filtered > 0) setDropped(droppedRef.current + filtered)
      return
    }
    const merged = Array.from(textRef.current + clean)
    // **超出的部分要被数出来**,不能像以前那样静默切掉(见 dropped 的注释)。
    const over = Math.max(0, merged.length - props.maxChars)
    if (over + filtered > 0) setDropped(droppedRef.current + over + filtered)
    setText(merged.slice(0, props.maxChars).join(''))
  }, { isActive: props.isActive !== false })

  /**
   * 正文按**折行之后的行数**切,超高时只画尾部(光标在那儿)。
   *
   * ⚠ **按 `split('\n')` 数逻辑行是不够的** —— 验收席实测:100 列 / `maxBodyRows=8` 下,
   * 4000 字**单行**画出 49 个终端行、一句「上面还有」都没有;而那恰恰是这个 prop 的注释
   * 自己写的那个场景(「4000 码点在 100 列下是 40 个终端行」)。粘一段长文本最常见的形态
   * 就是没有换行的一大段。
   *
   * 「上面还有 N 行」必须落在**被裁掉的那一段之外** —— 截断提示活不过截断的话,
   * 用户看到的就是一份看起来完整的残缺内容(这个仓库为这条写过一次判决)。
   */
  const term = useTerminalSize()
  const { columns } = useModalOrTerminalSize(term)
  // 边框 2 + paddingX 各 1 + 行首那两个字符(`> ` / `  `)。夹到 ≥1,免得 wrapAnsi 拿到 0。
  const bodyWidth = Math.max(1, columns - 6)
  const bodyLines = text.split('\n').flatMap(l => (l === '' ? [''] : wrapAnsi(l, bodyWidth)))
  const rowCap = props.maxBodyRows
  const hiddenRows = rowCap !== undefined && bodyLines.length > rowCap ? bodyLines.length - rowCap : 0
  const shownLines = hiddenRows > 0 ? bodyLines.slice(hiddenRows) : bodyLines

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      {hiddenRows > 0 ? <Text dimColor>… 上面还有 {hiddenRows} 行(写完按回车会整段提交)</Text> : null}
      {shownLines.map((line, i) => (
        <Text key={`l-${i}`}>
          {i === 0 && hiddenRows === 0 ? '> ' : '  '}
          {line}
          {i === shownLines.length - 1 ? <Text inverse> </Text> : null}
        </Text>
      ))}
      <Text dimColor>
        回车 提交 · Esc 取消 · {Array.from(text).length}/{props.maxChars}
        {props.footerNote ? ` · ${props.footerNote}` : ''}
      </Text>
      {/* 丢字必须自己上屏。页脚那个 `4000/4000` 只说「满了」,不说「你有 N 个字没进来」。
          措辞不写死「长度上限」—— 这个数现在也含被滤掉的控制字符(粘 ANSI 日志那一路)。 */}
      {dropped > 0
        ? <Text color="warning">⚠ 有 {dropped} 个字没有收进来(超出长度上限,或者是控制字符)—— 提交的是上面这些。</Text>
        : null}
    </Box>
  )
}
