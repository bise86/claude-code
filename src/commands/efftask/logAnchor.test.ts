/**
 * 视口的锚:切换到哪,展示哪。
 *
 * 用户报的:「通过 Tab 切到某个阶段、空格展开、上下键看这个阶段的具体数据。当前使用
 * 上下键会被这个任务正在执行的子 agent 捕获,会展示它的数据。」
 *
 * 键位本来就有(Tab 切流、空格折叠、上下滚动),坏的是**偏移量的锚**:它记的是绝对行号,
 * 而行号上方的内容一直在变 —— 一条流跑完就从「运行中(展开)」变成「已收口(折叠)」,
 * 那几十行当场塌掉;新阶段又在别处插一段。于是同一个行号,一秒前指着「分析」的输出,
 * 一秒后指着正在跑的「执行」。用户没动过键,画面自己跳了。
 */
import { describe, expect, it } from 'bun:test'

import { anchoredFrom, type LogAnchor } from './logView.js'

/**
 * 一个假的行表:第 i 条流的表头在 headers[i]。
 * 传 -1 表示这条流当前没有表头(被淘汰了,或者列表刚变短)。
 */
const headerAt = (headers: number[]) => (i: number): number => headers[i] ?? -1

describe('anchoredFrom', () => {
  it('钉在表头上时,起始行就是那条流的表头', () => {
    const from = anchoredFrom(200, 20, { stream: 1, delta: 0 }, headerAt([0, 50, 120]))
    expect(from).toBe(50)
  })

  it('**上方的流塌掉之后,视口跟着走** —— 这就是那个 bug', () => {
    const anchor: LogAnchor = { stream: 2, delta: 3 }
    // 第 0 条流跑完前:展开的,占 50 行,第 2 条流的表头在 120。
    const before = anchoredFrom(200, 20, anchor, headerAt([0, 50, 120]))
    // 第 0 条流跑完 → 折叠 → 它那 48 行塌掉,后面全部上移。
    const after = anchoredFrom(152, 20, anchor, headerAt([0, 2, 72]))
    // 记绝对行号的话 before 和 after 都是 123,而 123 在塌掉之后指着完全不同的内容。
    expect(before).toBe(123)
    expect(after).toBe(75) // 72 + 3,仍然是「第 2 条流往下三行」
  })

  it('负 delta 能看到前一条流的尾巴', () => {
    expect(anchoredFrom(200, 20, { stream: 1, delta: -5 }, headerAt([0, 50, 120]))).toBe(45)
  })

  it('不会滚出内容范围', () => {
    // 往上越界
    expect(anchoredFrom(200, 20, { stream: 0, delta: -99 }, headerAt([0, 50]))).toBe(0)
    // 往下越界:夹在 total - height
    expect(anchoredFrom(200, 20, { stream: 1, delta: 999 }, headerAt([0, 50]))).toBe(180)
  })

  it('内容比一屏还少时起始行是 0', () => {
    expect(anchoredFrom(5, 20, { stream: 0, delta: 3 }, headerAt([0]))).toBe(0)
  })

  it('锚指向的流不见了 → 回顶部,**不是**回底部', () => {
    // 回底部的话,用户正好落在那条一直在动的运行流上 —— 就是他抱怨的那个现象。
    expect(anchoredFrom(200, 20, { stream: 7, delta: 3 }, headerAt([0, 50]))).toBe(0)
  })

  it('新流在**下方**长出来时,视口纹丝不动', () => {
    const anchor: LogAnchor = { stream: 0, delta: 10 }
    const before = anchoredFrom(100, 20, anchor, headerAt([0, 60]))
    // 又开了一条新流,总行数涨了 80 行,但它在下面 —— 第 0 条流的表头没动。
    const after = anchoredFrom(180, 20, anchor, headerAt([0, 60, 100]))
    expect(before).toBe(10)
    expect(after).toBe(10)
  })

  it('新流在**上方**插进来时,视口跟着选中的流走', () => {
    // 极少见但可能:上游重排了流的顺序。锚跟着表头走,而不是停在原来的行号上。
    const anchor: LogAnchor = { stream: 1, delta: 2 }
    expect(anchoredFrom(200, 20, anchor, headerAt([0, 50]))).toBe(52)
    expect(anchoredFrom(230, 20, anchor, headerAt([0, 80]))).toBe(82)
  })
})
