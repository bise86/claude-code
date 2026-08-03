import { describe, expect, test } from 'bun:test'
import { estimateTokens } from '../../services/api/tokenEstimate.js'
import { fitPromptToWindow } from './cliPromptFit.js'

const big = (n: number, ch = 'a'): string => ch.repeat(n)

describe('fitPromptToWindow', () => {
  test('没声明窗口时一个字节都不动', () => {
    const p = big(4_000_000)
    const r = fitPromptToWindow(p, undefined)
    expect(r.truncated).toBe(false)
    expect(r.prompt).toBe(p)
  })

  test('非法窗口按未声明处理', () => {
    for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitPromptToWindow('hello', w).truncated).toBe(false)
    }
  })

  test('装得下就原样返回', () => {
    const r = fitPromptToWindow('short prompt', 32_000)
    expect(r.truncated).toBe(false)
    expect(r.prompt).toBe('short prompt')
  })

  test('超了就截,而且截完真的在预算内', () => {
    const p = big(1_000_000)
    const r = fitPromptToWindow(p, 32_000)
    expect(r.truncated).toBe(true)
    // 预算 = 窗口的 75%,估算值必须落在里面(留一点点余量给通知本身的换行)
    expect(estimateTokens(r.prompt)).toBeLessThanOrEqual(32_000 * 0.75 + 100)
  })

  test('中文提示词也要真的落进预算 —— 换算比例按这一段自己的密度算', () => {
    const p = '在这一轮里执行者必须先读一遍集成分支上的改动。'.repeat(20_000)
    const r = fitPromptToWindow(p, 32_000)
    expect(r.truncated).toBe(true)
    expect(estimateTokens(r.prompt)).toBeLessThanOrEqual(32_000 * 0.75 + 100)
  })

  test('通知在最前面 —— 被挖掉的那一段不能自己声明自己被挖掉', () => {
    const r = fitPromptToWindow(big(1_000_000), 32_000)
    expect(r.prompt.startsWith('〔提示词过长已被截断〕')).toBe(true)
  })

  test('头尾都留住 —— 开头是任务,结尾是上一轮的意见和产出要求', () => {
    const p = `任务开始标记${big(500_000)}产出要求结束标记`
    const r = fitPromptToWindow(p, 32_000)
    expect(r.prompt).toContain('任务开始标记')
    expect(r.prompt).toContain('产出要求结束标记')
    expect(r.prompt).toContain('中间约')
  })

  test('截断的账要报出来', () => {
    const r = fitPromptToWindow(big(1_000_000), 32_000)
    expect(r.originalTokens).toBeGreaterThan(0)
    expect(r.droppedChars).toBeGreaterThan(0)
  })
})
