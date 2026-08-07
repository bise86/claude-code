/**
 * 子 agent 的「产出替换」账本从哪来。
 *
 * 这条接缝是整个「按员工窗口封顶」功能的**唯一开关**:少了它,预算算术、窗口换算、
 * 落盘、上屏全都写好了,而 `/et` 员工那条路上 `applyToolResultBudget` 第一行就
 * `if (!state) return messages` 返回了 —— 编译通过、3491 个测试全绿、跑机上一个字节
 * 都没省下来。跑机席评审就是在这里发现方案 v1 会变成一次完整的空操作。
 */
import { describe, expect, test } from 'bun:test'
import { subagentReplacementState } from './runAgent.js'
import { createContentReplacementState } from '../../utils/toolResultStorage.js'

const apiRole = (contextWindow: number | undefined) =>
  ({
    execMode: 'api' as const,
    roleClientConfig: contextWindow === undefined ? {} : { contextWindow },
  }) as Parameters<typeof subagentReplacementState>[1]

describe('subagentReplacementState', () => {
  // 变异:去掉 `if (inherited) return inherited` → 打断 fork 的 prompt cache,这条会红。
  test('传进来的一份优先(fork 为命中缓存显式克隆的)', () => {
    const inherited = createContentReplacementState()
    inherited.seenIds.add('已经看过的')
    const got = subagentReplacementState(inherited, apiRole(128_000))
    expect(got).toBe(inherited)
  })

  /**
   * 这一条就是跑机席那个 P0 的回归闸。
   * 变异:整个函数改成 `return inherited` → 这条会红,而其它 8 条预算探针**全都还是绿的**。
   */
  test('声明了窗口的 api 员工 → 自己开一份(否则整个功能是空操作)', () => {
    const got = subagentReplacementState(undefined, apiRole(128_000))
    expect(got).toBeDefined()
    expect(got!.seenIds.size).toBe(0)
    expect(got!.replacements.size).toBe(0)
  })

  // 变异:去掉 contextWindow 判据 → 这条会红。没声明窗口就没有预算可算,开账本没有意义。
  test('没声明窗口的 api 员工 → 不开', () => {
    expect(subagentReplacementState(undefined, apiRole(undefined))).toBeUndefined()
  })

  // 变异:去掉 execMode 判据 → 这条会红。cli 员工的上下文是外部 CLI 自己管的。
  test('cli 员工 → 不开', () => {
    const cli = {
      execMode: 'cli' as const,
      roleClientConfig: { contextWindow: 128_000 },
    } as Parameters<typeof subagentReplacementState>[1]
    expect(subagentReplacementState(undefined, cli)).toBeUndefined()
  })

  // 主循环派下来的内建 agent:没有 roleClientConfig,一律不开 → 主循环逐字不变。
  test('内建 agent(无 roleClientConfig)→ 不开', () => {
    const builtin = { execMode: undefined, roleClientConfig: undefined } as unknown as Parameters<
      typeof subagentReplacementState
    >[1]
    expect(subagentReplacementState(undefined, builtin)).toBeUndefined()
  })

  // 每次调用要是**新**的一份 —— 共用会让两个员工互相污染 seenIds。
  test('两次调用不共享同一个对象', () => {
    const a = subagentReplacementState(undefined, apiRole(32_000))
    const b = subagentReplacementState(undefined, apiRole(32_000))
    expect(a).not.toBe(b)
  })
})
