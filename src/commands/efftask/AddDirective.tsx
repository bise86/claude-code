import * as React from 'react'

import { MAX_DIRECTIVE_CHARS } from '../../tools/efftask/control.js'
import { LineInput } from './LineInput.js'

/**
 * 运行中补一句指令。
 *
 * 用户的原话:「可以用提示词修正这个任务怎么做不」。在这之前运行中**没有任何文本输入
 * 通道** —— 提示词在派发那一刻就拼好了,中途没有注入点。
 *
 * 这一屏只做一件事:收一段话。它作用于**之后**派发的提示词,不打断在飞的调用 ——
 * 打断是暂停和取消管的事,三件事分开才说得清。
 *
 * 收字符那一整套(让出键盘、按码点退格、换行折成空格、组合键归终端)住在 `LineInput` 里,
 * 因为现在有三处要收一段话:这里、重做关口、跳过关口。四个坑各踩一遍不如共用一份。
 */
export function AddDirective(props: {
  /** 已经补过几条 —— 让用户知道之前那些还在。 */
  existing: number
  /**
   * 键盘归不归这一屏。
   *
   * **必须有。** `/et` 声明了 spawnsSubagents,权限对话框会画在它**之上**,而 ink 的
   * useInput 是广播的 —— 缺了这个守卫,一下回车既提交了指令**又批准了待确认的工具**,
   * 而执行环节的确认可以是带写能力的 Bash。
   */
  isActive?: boolean
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <LineInput
      title="追加一句指令"
      // Ink 不渲染 markdown,写 ** 出来就是两个星号。而且这句话必须说出用户最需要知道的
      // 那件事:正在跑的这一轮拿不到它。
      hint={`加进之后派发的提示词。正在跑的这一轮拿不到它,验收也按补充后的意图判。${
        props.existing > 0 ? ` 已补过 ${props.existing} 条。` : ''}`}
      maxChars={MAX_DIRECTIVE_CHARS}
      isActive={props.isActive}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
    />
  )
}
