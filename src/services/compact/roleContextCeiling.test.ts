/**
 * 员工窗口的**自适应上界** —— 从跑动中学到的那个数。
 *
 * 这一组守的是 2026-08-19 那次事故的第二半:压缩阈值完全建立在**用户写在 settings 里的
 * 一句声明**上,而那句话写大了是默认会发生的事(网关标称的窗口不含系统提示词、工具
 * schema,也不含它自己留给输出的那一段)。阈值一旦坐在对面真实上限的外面,proactive
 * 压缩结构上就够不着。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MIN_LEARNED_CONTEXT_WINDOW,
  effectiveRoleContextWindow,
  noteUpstreamContextLimit,
  resetLearnedContextWindows,
} from './roleContextCeiling.js'

/** 学到了什么 —— 不传声明值时 effectiveRoleContextWindow 返回的就是它。 */
const learned = (roleName: string): number | undefined =>
  effectiveRoleContextWindow({ roleName })

beforeEach(() => resetLearnedContextWindows())

describe('没学到东西时不干预', () => {
  /**
   * 这条钉的是「主循环逐字不变」:主循环没有 roleClientConfig,这里必须返回 undefined,
   * 调用方才会回落引擎自己那套算术。
   * 变异:把 `if (cfg === undefined) return undefined` 删掉 → 抛 TypeError,这条红。
   */
  test('没有 roleClientConfig → undefined(主循环那条路)', () => {
    expect(effectiveRoleContextWindow(undefined)).toBeUndefined()
  })

  test('有员工但既没声明也没学到 → undefined', () => {
    expect(effectiveRoleContextWindow({ roleName: '研发' })).toBeUndefined()
  })

  test('只声明了就用声明值', () => {
    expect(effectiveRoleContextWindow({ roleName: '研发', contextWindow: 233_000 })).toBe(233_000)
  })
})

describe('学一次之后取小', () => {
  /**
   * 事故现场的形状:声明 233000,而上游在 ~178k 就收不下了。
   * 变异:把 `Math.min(declared, observed)` 改成 `declared` → 这条红。
   */
  test('声明值和学到的上界取小', () => {
    noteUpstreamContextLimit('研发', 178_000)
    expect(effectiveRoleContextWindow({ roleName: '研发', contextWindow: 233_000 })).toBe(178_000)
  })

  test('没声明也能只靠学到的值', () => {
    noteUpstreamContextLimit('研发', 178_000)
    expect(effectiveRoleContextWindow({ roleName: '研发' })).toBe(178_000)
  })

  /**
   * 只往小里收。一次成功不能证明上限变高了(它只证明那一次没超),而一次拒收确实证明
   * 了上限比那次请求小。
   * 变异:把 `Math.min(prev, floored)` 改成 `floored` → 这条红。
   */
  test('第二次学到一个更大的数时不放大', () => {
    noteUpstreamContextLimit('研发', 178_000)
    noteUpstreamContextLimit('研发', 300_000)
    expect(learned('研发')).toBe(178_000)
  })

  test('第二次学到更小的数时继续收', () => {
    noteUpstreamContextLimit('研发', 178_000)
    noteUpstreamContextLimit('研发', 150_000)
    expect(learned('研发')).toBe(150_000)
  })

  test('按员工名隔离,不串台', () => {
    noteUpstreamContextLimit('研发', 150_000)
    expect(effectiveRoleContextWindow({ roleName: '测试', contextWindow: 233_000 })).toBe(233_000)
  })
})

describe('地板', () => {
  /**
   * 地板的理由**不是**「阈值会算成负数」—— 保留额度和缓冲都按比例夹(0.2 / 0.1),
   * 阈值恒等于 0.72×窗口,再小也不为负。理由只有一条:**一次偶然的观测不能有权把整个
   * 员工锁死一整趟 run**,而这份账本只减不增、按员工名进程级共享、进程内不可恢复。
   *
   * 变异:把 `Math.max(MIN_LEARNED_CONTEXT_WINDOW, ...)` 去掉 → 这条红。
   */
  test('学到的值不许低于地板', () => {
    noteUpstreamContextLimit('研发', 5_000)
    expect(learned('研发')).toBe(MIN_LEARNED_CONTEXT_WINDOW)
  })
})

describe('不可用的输入一律不记', () => {
  /**
   * `noteUpstreamContextLimit` 的两个入参都可能是 undefined:主循环没有 roleName;
   * 上游不肯报上限、而这次请求的大小也估不出来时 observed 是 undefined。
   * 那种情况下**什么都别记** —— 记一个瞎猜的数比不记更糟。
   * 变异:把两处早退删掉 → 会往表里塞 NaN/undefined,这几条红。
   */
  test.each([
    ['没有员工名', undefined, 178_000],
    ['没有观测值', '研发', undefined],
    ['观测值是 0', '研发', 0],
    ['观测值是负数', '研发', -1],
    ['观测值是 NaN', '研发', Number.NaN],
    ['员工名是空串', '', 178_000],
  ])('%s → 不记', (_label, roleName, observed) => {
    expect(
      noteUpstreamContextLimit(roleName as string | undefined, observed as number | undefined),
    ).toBeUndefined()
    expect(effectiveRoleContextWindow({ roleName: '研发' })).toBeUndefined()
  })
})
