/**
 * 宽度这一层的硬不变量:**任何一行的显示宽度都不许超过给定列宽。**
 *
 * 单列一份是因为它的反例只在 emoji 上出现,而上面那几份测试的夹具全是中英文 ——
 * 评审用属性测试一跑就是一千多条反例,而全套 2457 条测试一条不红。
 *
 * 后果不是「排版难看」:少算宽度 → 行按 N 列排版、实际渲染 N+k 列 → ink 回流成两个
 * 终端行 → 「一条 ViewLine = 一个终端行」当场破。真渲染量到的表现是整整一段被挤出屏幕、
 * 「↓ 下面还有 13 行」那句话被静默剪掉,而**帧的总行数一点没变** —— 一个残缺的视图
 * 看起来完完整整。
 */
import { describe, expect, it } from 'bun:test'
import { clipAnsi, graphemes, stripAnsiAtoms, wrapAnsi } from './ansiText.js'
import { clipToWidth, wrapDisplayWidth } from './logView.js'
import { markdownLines } from './markdownView.js'
import { stringWidth } from '../../ink/stringWidth.js'

/** 真实会出现在模型正文里的那几类:变体选择符、ZWJ 家族、肤色、组合记号。 */
const SAMPLES = [
  '⚠️ 风险点:并发写同一个文件',
  '❤️❤️❤️abcdef',
  '👨‍👩‍👧 家庭 emoji 混在中文里排版',
  'abc⚠️def⚠️ghi⚠️jkl',
  '✅ 已完成 ❌ 未完成 ⚠️ 有风险',
  '👍🏽 点赞带肤色修饰符',
  'école 组合记号',
  '一段普通中文,没有任何 emoji',
]
const WIDTHS = [6, 8, 10, 12, 20, 30, 41]

describe('字素簇,不是码点', () => {
  it('`⚠️` 是两个码点、一个字素簇 —— 按码点切就会各量一次', () => {
    expect(Array.from('⚠️')).toHaveLength(2)
    expect(graphemes('⚠️')).toHaveLength(1)
    expect(graphemes('👨‍👩‍👧')).toHaveLength(1)
    // 这就是错的来源:拆开之后两段的宽度之和 ≠ 整簇的宽度。
    expect(Array.from('👨‍👩‍👧').reduce((n, c) => n + stringWidth(c), 0)).not.toBe(stringWidth('👨‍👩‍👧'))
  })

  it('四个入口在 emoji 上都不超宽', () => {
    const bad: string[] = []
    for (const s of SAMPLES) {
      for (const w of WIDTHS) {
        for (const l of wrapAnsi(s, w)) if (stringWidth(l) > w) bad.push(`wrapAnsi w=${w} ${JSON.stringify(l)}`)
        for (const l of wrapDisplayWidth(s, w)) if (stringWidth(l) > w) bad.push(`wrapDisplayWidth w=${w} ${JSON.stringify(l)}`)
        if (stringWidth(clipAnsi(s, w)) > w) bad.push(`clipAnsi w=${w}`)
        if (stringWidth(clipToWidth(s, w)) > w) bad.push(`clipToWidth w=${w}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('折行不丢字 —— 拼回去必须逐字等于原文', () => {
    // 少算宽度的另一种表现是**静默吃字**:行首几个 emoji 之后,行尾几个字符直接消失,
    // 连省略号都没有。
    for (const s of SAMPLES) {
      for (const w of WIDTHS) {
        expect(`${w}: ${wrapAnsi(s, w).map(stripAnsiAtoms).join('')}`).toBe(`${w}: ${s}`)
        expect(`${w}: ${wrapDisplayWidth(s, w).join('')}`).toBe(`${w}: ${s}`)
      }
    }
  })

  it('ZWJ 家族不许被劈成两半', () => {
    for (const w of [3, 4, 6, 8]) {
      for (const line of wrapAnsi('👨‍👩‍👧尾巴', w).map(stripAnsiAtoms)) {
        // 出现了家庭 emoji 的**一部分**却没有整簇 = 被劈开了。
        expect(`w=${w} 劈开了: ${line.includes('👨') && !line.includes('👨‍👩‍👧')}`).toBe(`w=${w} 劈开了: false`)
      }
    }
  })

  it('markdown 段落里的 emoji 同样不超宽', () => {
    // 详情页真正走的是这一条,而模型的「风险点」一段里 ⚠️ 是家常便饭。
    const body = '## ⚠️ 风险点\n\n- ⚠️ 并发写同一个文件\n- ✅ 已经有锁\n\n正文' + '啊'.repeat(40) + '⚠️'
    for (const w of [20, 33, 41]) {
      for (const l of markdownLines(body, w, 'dark')) {
        expect(`w=${w}: ${stringWidth(l)} <= ${w}`).toBe(`w=${w}: ${Math.min(stringWidth(l), w)} <= ${w}`)
      }
    }
  })
})
