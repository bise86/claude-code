/**
 * 页脚按键提示的分页。
 *
 * 用户报「子任务重跑和阶段重跑功能没有了」—— 键一直是好的,是提示在 113 列以下一个字
 * 都画不出来。调次序只能决定谁先被吃掉;吃不下这件事本身要靠翻页解决。
 */
import { describe, expect, it } from 'bun:test'
import { paginateHints } from './logView.js'
import { stringWidth } from '../../ink/stringWidth.js'

const SEGS = [
  'Esc/q 返回任务树', 'r 重做本任务', 'R 重做失败环节', 's 跳过它', 'f 强制通过它',
  'c 清理工作区', 'd 重算依赖', '↑↓/jk 选段落', '空格 展开', '←→ 换页卡', 'Tab 到页签', '^u/^d 翻页',
]

describe('paginateHints', () => {
  it('装得下时**一个字都不多写** —— 宽终端上凭空的「1/1 ?换页」是纯噪声', () => {
    const r = paginateHints(SEGS, 999)
    expect(r.pages).toBe(1)
    // 判据不能是「不含『换页』」—— 段落自己就有「换页卡」和「翻页」两个词(第一版探针
    // 就是这么红的)。判的是页码那个方括号。
    expect(r.text).not.toContain('[')
    expect(r.text).toContain('Esc/q 返回任务树')
    expect(r.text).toContain('^u/^d 翻页')
  })

  it('装不下就分页,而且**每一页都不超宽**', () => {
    for (const width of [40, 60, 76, 96, 116]) {
      const first = paginateHints(SEGS, width, 0)
      expect(first.pages).toBeGreaterThan(1)
      for (let p = 0; p < first.pages; p++) {
        const r = paginateHints(SEGS, width, p)
        /**
         * 单段本身就比一页宽时**不许丢掉它** —— 那一页会超,交给 truncate-end。
         * 分页解决的是「装不下就消失」,不是「把一段切两半」(切开的那半截读起来像
         * 另一个键)。所以不变式是:要么这一页装得下,要么它只有一段。
         */
        const segs = r.text.split(' · ').length
        expect(stringWidth(r.text) <= width || segs <= 2).toBe(true)
      }
    }
  })

  it('**出口钉在每一页上** —— 分页不许把「怎么出去」翻到第 2 页', () => {
    const width = 60
    const { pages } = paginateHints(SEGS, width, 0)
    for (let p = 0; p < pages; p++) {
      expect(paginateHints(SEGS, width, p).text.startsWith('Esc/q 返回任务树')).toBe(true)
    }
  })

  it('**每一段都出现在某一页上** —— 分页的全部意义就是不再丢东西', () => {
    const width = 60
    const { pages } = paginateHints(SEGS, width, 0)
    const seen = new Set<string>()
    for (let p = 0; p < pages; p++) {
      for (const seg of SEGS) if (paginateHints(SEGS, width, p).text.includes(seg)) seen.add(seg)
    }
    expect([...SEGS].filter(s => !seen.has(s))).toEqual([])
  })

  it('页码本身先占地方 —— 不预留的话最后一段会把它顶出去,而那是它存在的唯一出口', () => {
    const width = 60
    const r = paginateHints(SEGS, width, 0)
    expect(r.text).toContain('?换页')
    expect(stringWidth(r.text)).toBeLessThanOrEqual(width)
  })

  it('page 取模:调用方一直加不用管边界,负数也落回合法页', () => {
    const { pages } = paginateHints(SEGS, 60, 0)
    expect(paginateHints(SEGS, 60, pages).page).toBe(0)
    expect(paginateHints(SEGS, 60, pages + 1).page).toBe(1 % pages)
    expect(paginateHints(SEGS, 60, -1).page).toBe(pages - 1)
  })

  it('只有一段 / 空段一律不分页', () => {
    expect(paginateHints(['Esc/q 退出'], 10).pages).toBe(1)
    expect(paginateHints([], 80).text).toBe('')
    expect(paginateHints(['', '', 'a'], 80).text).toBe('a')
  })

  it('连头段都放不下时不分页 —— 交给 truncate-end,分页帮不上忙', () => {
    const r = paginateHints(SEGS, 4, 0)
    expect(r.pages).toBe(1)
    expect(r.text).toBe('Esc/q 返回任务树')
  })

  it('中文按 2 列算(这一行的宽度判断全靠它)', () => {
    // 'Esc/q ' = 6 列,'返回任务树' = 5 个汉字 × 2 = 10 列
    expect(stringWidth('Esc/q 返回任务树')).toBe(16)
  })
})
