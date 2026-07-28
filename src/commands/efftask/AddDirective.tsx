import * as React from 'react'

import { Box, Text, useInput } from '../../ink.js'
import { MAX_DIRECTIVE_CHARS } from '../../tools/efftask/control.js'
import { useLiveState } from './useLiveState.js'

/**
 * 运行中补一句指令。
 *
 * 用户的原话:「可以用提示词修正这个任务怎么做不」。在这之前运行中**没有任何文本输入
 * 通道** —— 提示词在派发那一刻就拼好了,中途没有注入点。
 *
 * 这一屏只做一件事:收一段话。它作用于**之后**派发的提示词,不打断在飞的调用 ——
 * 打断是暂停和取消管的事,三件事分开才说得清。
 *
 * 自己收字符而不是用现成的输入组件:这个仓库的 vendored ink 没有输入框,而这里要的
 * 东西很少(一行、退格、回车、Esc),多引一层反而多一处会坏的地方。
 */
export function AddDirective(props: {
  /** 已经补过几条 —— 让用户知道之前那些还在。 */
  existing: number
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [text, setText, textRef] = useLiveState('')

  useInput((input, key) => {
    if (key.escape) { props.onCancel(); return }
    if (key.return) {
      const t = textRef.current.trim()
      // 空的就当取消。提交一条空指令会在提示词里留一个空槽,而模型会努力去理解它。
      if (t.length === 0) props.onCancel()
      else props.onSubmit(t)
      return
    }
    if (key.backspace || key.delete) {
      // 按**码点**退,不是按 UTF-16 单元:一个 emoji 退一次要整个消失,否则会留下半个
      // 代理对,终端上显示成一个替换字符,而用户再退一次才走。
      const cps = Array.from(textRef.current)
      cps.pop()
      setText(cps.join(''))
      return
    }
    // 组合键归终端(Ctrl+C 之类),别当成正文吃掉。
    if (key.ctrl || key.meta) return
    if (input.length === 0) return
    // 控制字符不进正文:它们会真的作用在终端上(清屏、改标题栏)。
    const clean = Array.from(input).filter(c => c >= ' ' || c === '\t').join('')
    if (clean.length === 0) return
    setText(Array.from(textRef.current + clean).slice(0, MAX_DIRECTIVE_CHARS).join(''))
  })

  const shown = text.length > 0 ? text : ''
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold color="warning">追加一句指令</Text>
      <Text dimColor>
        它会加进**之后**派发的提示词,不打断正在跑的调用。
        {props.existing > 0 ? ` 已补过 ${props.existing} 条。` : ''}
      </Text>
      <Text>
        {'> '}
        {shown}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>
        回车 提交 · Esc 取消 · {Array.from(text).length}/{MAX_DIRECTIVE_CHARS}
      </Text>
    </Box>
  )
}
