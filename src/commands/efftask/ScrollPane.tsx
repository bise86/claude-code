import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { OffscreenFreeze } from '../../components/OffscreenFreeze.js'
import { scrollbarColumn, type ViewLine } from './logView.js'

/**
 * 一屏行 + 右侧滚动条。**两个页卡共用**。
 *
 * 抽出来不是为了少写几行,是为了把三条会静默出错的规矩关在一个地方:
 *
 * 1. **每一行自己一个 `flexShrink={0}` 的 Box。** 详情页做成满屏之后,外层 Box 带上了
 *    确定高度,而 vendored Box 的 `flexShrink` 默认是 1 —— 超量的子节点会被 yoga
 *    **按比例压缩**,不是被裁掉。实测 50 行塞进 10 行的框,屏幕上是
 *    `L004,L009,L014,…`(每 5 行采样一行),连标题行都一起没了。
 *    一个残缺的视图看起来完完整整,正是这个仓库反复付学费的那一类。
 *
 * 2. **`wrap="truncate-end"`,禁止回流。** 一行回流成两行,实打印行数就和算出来的对不上,
 *    而滚动条的滑块位置是按 total/height 算的 —— 位置会直接指错,而它是窗口唯一的位置指示。
 *
 * 3. **切片由调用方给**(`from`),不在这里算:两个页卡的锚语义不同(日志窗锚在流的表头,
 *    段落区锚在段落标题),而锚的解算本身是纯函数,该留在 logView 里被单独测。
 */
export function ScrollPane(props: {
  /** 已经切好的那一屏。长度就是实打印的行数。 */
  slice: readonly ViewLine[]
  /** 总行数与窗口起点 —— 只用来画滚动条。 */
  total: number
  from: number
  /** 窗口高度(行)。滚动条按它铺满,所以短内容也不会让滑块跳。 */
  height: number
  /**
   * 钉在滚动区**之外**的一行。
   *
   * 「丢了多少」这类提示跟着滚的话会被粘底行为直接埋掉:窗口默认跟随最新,第一行早就
   * 滚出可视区,于是一个残缺的视图看起来完完整整 —— 而这正是那条提示存在的理由。
   */
  notice?: string | null
  /** 下面还有几行。0 = 不画。 */
  behind?: number
  /** 底部提示的文案(不同页卡不一样)。 */
  behindHint?: string
}): React.ReactElement {
  const bar = scrollbarColumn(props.total, props.height, props.from)
  return (
    // 视口之上的内容变化会逼出整屏重置。ShellProgressMessage 为同一个理由裹了同一个东西。
    <OffscreenFreeze>
      <Box flexDirection="column" flexShrink={0}>
        {props.notice ? (
          <Box flexShrink={0}><Text dimColor wrap="truncate-end">{props.notice}</Text></Box>
        ) : null}
        {props.slice.map((l, i) => (
          <Box key={`vl-${props.from + i}`} flexDirection="row" flexShrink={0}>
            <Text
              color={l.color}
              dimColor={l.dim === true}
              bold={l.bold === true}
              inverse={l.inverse === true}
              wrap="truncate-end"
            >
              {l.text}
            </Text>
            <Box flexGrow={1} />
            <Text dimColor>{bar[i] ?? ' '}</Text>
          </Box>
        ))}
        {(props.behind ?? 0) > 0 ? (
          <Box flexShrink={0}>
            <Text color="warning" wrap="truncate-end">
              {`↓ 下面还有 ${props.behind} 行${props.behindHint ? `(${props.behindHint})` : ''}`}
            </Text>
          </Box>
        ) : null}
      </Box>
    </OffscreenFreeze>
  )
}
