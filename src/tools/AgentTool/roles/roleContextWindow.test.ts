import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TRANSLATED_CONTEXT_WINDOW,
  formatContextWindow,
  MAX_ROLE_CONTEXT_WINDOW,
  MIN_ROLE_CONTEXT_WINDOW,
  parseContextWindow,
  roleContextWindow,
} from './roleContextWindow.js'

describe('parseContextWindow', () => {
  test('数字、字符串、k/M 后缀都收', () => {
    expect(parseContextWindow(128_000)).toBe(128_000)
    expect(parseContextWindow('128000')).toBe(128_000)
    expect(parseContextWindow('128k')).toBe(128_000)
    expect(parseContextWindow('128K')).toBe(128_000)
    expect(parseContextWindow(' 200k ')).toBe(200_000)
    expect(parseContextWindow('1m')).toBe(1_000_000)
    expect(parseContextWindow('1M')).toBe(1_000_000)
    expect(parseContextWindow('128_000')).toBe(128_000)
    expect(parseContextWindow('128,000')).toBe(128_000)
  })

  test('认不出来的一律 undefined —— 不许悄悄回落到一个默认值', () => {
    for (const bad of [undefined, null, '', '  ', 'big', '12x', {}, [], NaN, Infinity, true]) {
      expect(parseContextWindow(bad)).toBeUndefined()
    }
  })

  test('区间外的当没写 —— 负阈值会变成「每轮都压」的烧钱循环', () => {
    expect(parseContextWindow(MIN_ROLE_CONTEXT_WINDOW - 1)).toBeUndefined()
    expect(parseContextWindow(MIN_ROLE_CONTEXT_WINDOW)).toBe(MIN_ROLE_CONTEXT_WINDOW)
    expect(parseContextWindow(MAX_ROLE_CONTEXT_WINDOW)).toBe(MAX_ROLE_CONTEXT_WINDOW)
    expect(parseContextWindow(MAX_ROLE_CONTEXT_WINDOW + 1)).toBeUndefined()
    expect(parseContextWindow(0)).toBeUndefined()
    expect(parseContextWindow(-128_000)).toBeUndefined()
  })
})

describe('roleContextWindow', () => {
  test('翻译型协议没声明时按默认值估,并且标成 assumed', () => {
    for (const p of ['openai', 'openai-responses']) {
      expect(roleContextWindow({ execMode: 'api', apiProtocol: p })).toEqual({
        value: DEFAULT_TRANSLATED_CONTEXT_WINDOW,
        assumed: true,
      })
    }
  })

  test('anthropic 协议不干预 —— 引擎自己那套算术是准的', () => {
    expect(roleContextWindow({ execMode: 'api', apiProtocol: 'anthropic' })).toEqual({ assumed: false })
    expect(roleContextWindow({ execMode: 'api' })).toEqual({ assumed: false })
  })

  test('cli 档没声明时不封顶 —— 外部 CLI 自己带上下文管理', () => {
    expect(roleContextWindow({ execMode: 'cli' })).toEqual({ assumed: false })
    expect(roleContextWindow({ execMode: 'cli', declared: 200_000 })).toEqual({ value: 200_000, assumed: false })
  })

  test('cli 档**压过协议** —— 员工上写了 apiProtocol 也不该被估一个窗口出来', () => {
    // RoleSchema 里 apiProtocol 是无条件可选的,所以一条 cli 员工上写着 "apiProtocol":
    // "openai" 是合法输入(用户从一条 api 员工复制粘贴改过来时天天发生)。判据要是漏了
    // execMode 这一层,它会被当成翻译型协议估出 128k —— 于是我们开始截一台自己会压缩的
    // CLI 的提示词。变异测试实测:去掉 cli 那一支,只有这条断言会挂。
    for (const p of ['openai', 'openai-responses']) {
      expect(roleContextWindow({ execMode: 'cli', apiProtocol: p })).toEqual({ assumed: false })
    }
  })

  test('声明了就一律听用户的,anthropic 协议也一样', () => {
    expect(roleContextWindow({ execMode: 'api', apiProtocol: 'anthropic', declared: 64_000 }))
      .toEqual({ value: 64_000, assumed: false })
    expect(roleContextWindow({ execMode: 'api', apiProtocol: 'openai', declared: 1_000_000 }))
      .toEqual({ value: 1_000_000, assumed: false })
  })
})

describe('formatContextWindow', () => {
  test('给人看的写法', () => {
    expect(formatContextWindow(128_000)).toBe('128k')
    expect(formatContextWindow(200_000)).toBe('200k')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(8_000)).toBe('8k')
    expect(formatContextWindow(32_768)).toBe('32768')
  })
})
