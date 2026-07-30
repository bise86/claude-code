import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { useLiveState } from './useLiveState.js'

/**
 * 一行文本输入。
 *
 * 这个仓库的 vendored ink **没有输入框**,所以每一处要收一段话的地方都得自己收字符。
 * 抽出来是因为现在有三处:运行中追加指令、重做时补一句提示词、跳过时补一句提示词。
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
   * 键盘归不归这一屏。见上面第 1 条。
   *
   * **今天只有 `AddDirective` 真的传它**,而那是唯一在**运行中**弹出来的输入框 ——
   * 重做/跳过关口只挂在 done 视图上,那时 run 已经结束,不会有在飞的调用弹权限框。
   * 如实记下来,而不是让上面那条「必须有」读起来像每个调用点都在遵守它。
   */
  isActive?: boolean
  /** 页脚右边的补充说明(可选),比如「留空 = 不补充」。 */
  footerNote?: string
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.ReactElement {
  // 按码点夹到上限:传进来的初值也可能超(它上一次就是这么被夹的,但调用方不该依赖那个)。
  const [text, setText, textRef] = useLiveState(
    Array.from(props.initialText ?? '').slice(0, props.maxChars).join(''),
  )

  useInput((input, key) => {
    if (key.escape) { props.onCancel(); return }
    if (key.return) {
      const t = textRef.current.trim()
      // 空的就当取消。提交一段空文本会在提示词里留一个空槽,而模型会努力去理解它。
      if (t.length === 0) props.onCancel()
      else props.onSubmit(t)
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
    const clean = Array.from(input)
      .map(c => (c === '\n' || c === '\r' ? ' ' : c))
      .filter(c => c >= ' ' || c === '\t')
      .join('')
    if (clean.length === 0) return
    setText(Array.from(textRef.current + clean).slice(0, props.maxChars).join(''))
  }, { isActive: props.isActive !== false })

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">{props.title}</Text>
      <Text dimColor>{props.hint}</Text>
      <Text>
        {'> '}
        {text}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>
        回车 提交 · Esc 取消 · {Array.from(text).length}/{props.maxChars}
        {props.footerNote ? ` · ${props.footerNote}` : ''}
      </Text>
    </Box>
  )
}
