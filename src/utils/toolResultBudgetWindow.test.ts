/**
 * 每消息聚合预算**按员工窗口标定**这条路的探针。
 *
 * 为什么单开一个文件:这套机制(`enforceToolResultBudget` / `ContentReplacementState`)
 * 在这个仓库里**一条测试都没有** —— 全仓 126 个测试文件对它的引用是零,3491 绿的基线
 * 对它一个字都没盖。也就是说改坏了不会有任何东西变红,而症状(子 agent 的产出被静默换成
 * 预览、模型读了又读)要几天后才看得出来。
 *
 * 每条用例都标了它要杀的变异 —— 「幸存 = 探针坏了」这条教训这个仓库付过三次学费。
 */
import { describe, expect, test } from 'bun:test'
import { PER_MESSAGE_BUDGET_WINDOW_SHARE } from '../constants/toolLimits.js'
import { createAssistantMessage, createUserMessage } from './messages.js'
import type { Message } from '../types/message.js'
import {
  applyToolResultBudget,
  createContentReplacementState,
  enforceToolResultBudget,
  getPerMessageBudgetLimit,
  roleWindowChars,
} from './toolResultStorage.js'

/** 一条 assistant(tool_use) + 一条 user(tool_result),构成一个 API 轮次。 */
function round(
  parts: { id: string; tool: string; chars: number }[],
): Message[] {
  return [
    createAssistantMessage({
      content: parts.map(p => ({
        type: 'tool_use' as const,
        id: p.id,
        name: p.tool,
        input: {},
      })),
    }),
    createUserMessage({
      content: parts.map(p => ({
        type: 'tool_result' as const,
        tool_use_id: p.id,
        content: 'x'.repeat(p.chars),
      })),
    }),
  ]
}

/** 一份消息里所有 tool_result 的字符总量 —— 预算比的就是这个数。 */
function toolResultTotal(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const b of m.message.content) {
      if (b.type === 'tool_result' && typeof b.content === 'string') {
        total += b.content.length
      }
    }
  }
  return total
}

async function run(
  messages: Message[],
  windowChars: number | undefined,
  skip: string[] = [],
) {
  const state = createContentReplacementState()
  const res = await enforceToolResultBudget(
    messages,
    state,
    new Set(skip),
    windowChars,
  )
  return res.newlyReplaced.map(r => r.toolUseId)
}

describe('getPerMessageBudgetLimit — 窗口标定', () => {
  // 变异:让 undefined 也走比例分支 → 主循环被拖下水,这条会红。
  test('没有窗口(主循环)回落 Infinity —— 整条不生效', () => {
    expect(getPerMessageBudgetLimit(undefined)).toBe(Number.POSITIVE_INFINITY)
    expect(roleWindowChars(undefined)).toBeUndefined()
  })

  // 变异:把 BYTES_PER_TOKEN 换成 1,或把 SHARE 改成 1.0 → 这三行任一会红。
  test('按窗口比例算,四档各不相同', () => {
    expect(getPerMessageBudgetLimit(roleWindowChars(32_000))).toBe(64_000)
    expect(getPerMessageBudgetLimit(roleWindowChars(128_000))).toBe(256_000)
    expect(getPerMessageBudgetLimit(roleWindowChars(1_000_000))).toBe(2_000_000)
  })

  /**
   * v1 方案在字符域上放过一个 200_000 的绝对地板,四位评审各自算出同一个结论:
   * 200_000 字符 = 50_000 token,比 32k 员工的**整扇窗口**(128_000 字符)还大,
   * 于是比例判据对所有 200k 以下的员工一次都不生效。这条把那个错钉死。
   * 变异:加回 `Math.max(200_000, …)` → 前两行会红。
   */
  test('小窗口的预算必须小于它自己的窗口(v1 地板的回归闸)', () => {
    for (const w of [8_000, 32_000, 128_000]) {
      const chars = roleWindowChars(w)!
      expect(getPerMessageBudgetLimit(chars)).toBeLessThan(chars)
    }
    expect(PER_MESSAGE_BUDGET_WINDOW_SHARE).toBeLessThan(1)
  })
})

describe('enforceToolResultBudget — 按员工窗口落盘', () => {
  /**
   * 128k 员工预算 256_000 字符。300KB 单条跨在预算线上 —— 这个体积是特意挑的:
   * v1 的探针用 3MB,而 3MB 在「比例项生效」和「地板生效」两种实现下都会落盘,
   * 于是那条探针对核心常数**没有任何分辨力**(质量席和规范席各自独立算出这一条)。
   * 变异:SHARE 0.5 → 1.0(预算涨到 512_000)→ 这条会红。
   */
  test('128k 员工 + 单条 300KB → 落盘', async () => {
    const ids = await run(
      round([{ id: 't1', tool: 'Glob', chars: 300_000 }]),
      roleWindowChars(128_000),
    )
    expect(ids).toEqual(['t1'])
  })

  /**
   * 主循环那一行 —— 用户当初拆掉产出上限的决定必须逐字未变。
   *
   * **杀伤范围要说准**:这条打在 `enforceToolResultBudget` 本体上,钉的是「窗口为
   * undefined 时不落盘」。它**杀不掉** `query.ts` 那一行接线的变异(把
   * `roleWindowChars(...)` 换成一个常数窗口)—— 验收席实测那个变异存活。
   * query.ts 的接线目前零覆盖,见本文件末尾那条 `applyToolResultBudget` 的用例只覆盖到
   * 参数透传为止。这是已知缺口,不要照着旧注释以为它被钉住了。
   */
  test('主循环(无窗口)+ 800KB → 不落盘', async () => {
    const ids = await run(
      round([{ id: 't1', tool: 'Bash', chars: 800_000 }]),
      undefined,
    )
    expect(ids).toEqual([])
  })

  /**
   * v1 的单条判据**完全测不到**的形状:6 条各 190KB,每条都在预算以下,
   * 合起来 1.14MB 顶穿 128k 员工的 256_000 预算。这正是 `/et` 席位最常见的一轮
   * (并行 Grep/Glob),也是选聚合机制而不是单条阈值的全部理由。
   * 变异:改回单条判据(逐条比 limit)→ 这条会红。
   */
  test('128k 员工 + 6 条并行各 190KB → 落盘(聚合形状)', async () => {
    const ids = await run(
      round(
        Array.from({ length: 6 }, (_, i) => ({
          id: `t${i}`,
          tool: 'Grep',
          chars: 190_000,
        })),
      ),
      roleWindowChars(128_000),
    )
    expect(ids.length).toBeGreaterThan(0)
  })

  /**
   * **先换最大的那条** —— 上一版这条没被任何探针看见:聚合那条用了 6 条等长产出,
   * 顺序反过来结果一模一样,于是验收席把 `selectFreshToReplace` 的降序改成升序,
   * 3533 个测试全绿。换成参差不齐的尺寸才看得出来:预算 256_000,总量 660_000,
   * 只要换掉 400_000 那条就够(660_000 − 400_000 + 预览 ≈ 262_000,还差一点,
   * 再换 200_000 那条),而升序会从 10_000 开始换,要换掉更多条才够。
   *
   * 变异:`b.size - a.size` → `a.size - b.size` → 这条会红。
   */
  test('先换最大的那条,不是碰到哪条换哪条', async () => {
    const ids = await run(
      round([
        { id: 'tiny', tool: 'Grep', chars: 10_000 },
        { id: 'big', tool: 'Glob', chars: 400_000 },
        { id: 'mid', tool: 'Grep', chars: 200_000 },
        { id: 'small', tool: 'Grep', chars: 50_000 },
      ]),
      roleWindowChars(128_000),
    )
    expect(ids).toEqual(['big', 'mid'])
  })

  /**
   * MCP 走的是另一条截断路(`mcpValidation.ts` 的 `getMaxMcpOutputTokens`,本 fork 也是
   * Infinity),v1 给 `getPersistenceThreshold` 加参数那条路**整个绕过它**。
   * 聚合预算按 tool_result 块判,与产出者无关,所以 MCP 自动被覆盖 —— 这条钉住它。
   * 变异:把 mcp__ 前缀加进 skipToolNames → 这条会红。
   */
  test('MCP 工具返回 3MB → 落盘(不因为它是 MCP 就放过)', async () => {
    const ids = await run(
      round([{ id: 't1', tool: 'mcp__gitlab__list_issues', chars: 3_000_000 }]),
      roleWindowChars(128_000),
    )
    expect(ids).toEqual(['t1'])
  })

  /**
   * Read 的硬豁免。`FileReadTool` 声明 `maxResultSizeChars: Infinity`,
   * query.ts 据此把它放进 skipToolNames —— 落盘让模型再 Read 一次是循环的。
   *
   * **杀伤范围**:这条钉的是「收到 skip 集合之后真的跳过」,打在本体上。
   * query.ts 里**组装**那个集合的表达式不在覆盖内(验收席实测把它换成空集后本条仍绿)。
   */
  test('Read(声明 Infinity)返回 3MB → 不落盘', async () => {
    const ids = await run(
      round([{ id: 't1', tool: 'Read', chars: 3_000_000 }]),
      roleWindowChars(128_000),
      ['Read'],
    )
    expect(ids).toEqual([])
  })

  /**
   * **执行完之后真的落到预算以下了吗** —— 上一版整套探针都没有这条断言:
   * 算术那几条钉的是「预算值 < 窗口」,落盘那几条钉的是「哪几个 id 被换掉」,
   * 没有一条量过**执行后的真实总量**。验收席用真函数量出来:8k 员工换完之后
   * 仍是 30610 字符(预算 16000、窗口 32000),因为 `selectFreshToReplace` 减的是
   * 整条原文而没算换进去的预览本身。小窗口是这个功能存在的理由,所以这条必须钉死。
   *
   * 变异:`remaining -= Math.max(0, c.size - REPLACEMENT_SIZE_ESTIMATE)` 改回
   * `remaining -= c.size` → 8k / 32k 两档会红。
   */
  test('换完之后的真实总量必须落到预算以下(小窗口尤其)', async () => {
    for (const [win, count, each] of [
      [8_000, 10, 5_000],
      [32_000, 10, 20_000],
      [128_000, 6, 190_000],
    ] as const) {
      const chars = roleWindowChars(win)!
      const limit = getPerMessageBudgetLimit(chars)
      const state = createContentReplacementState()
      const res = await enforceToolResultBudget(
        round(
          Array.from({ length: count }, (_, i) => ({
            id: `w${win}-${i}`,
            tool: 'Grep',
            chars: each,
          })),
        ),
        state,
        new Set(),
        chars,
      )
      const after = toolResultTotal(res.messages)
      /**
       * 契约是「**甩到预算以下,或者已经无可再甩**」,不是无条件的 `after <= limit`。
       *
       * 后者在小窗口上**算术不成立**:8k 员工预算 16000 字符,而 10 条产出即使全部换成
       * 预览也还有约 2.3K × 10 = 23000 字符 —— 预览本身就是地板。断言一件设计并不成立的
       * 事,修的会是代码而不是断言(这个仓库为这条付过学费,上一轮我自己也刚犯过一次)。
       * 那个地板是真实存在的边界:窗口小到装不下「每条一个预览」时,唯一的出路是少并行,
       * 而不是继续压 —— 这一条写在这里,免得下一个人把它当 bug 修。
       */
      const allShed = res.newlyReplaced.length === count
      expect({ win, after, limit, ok: after <= limit || allShed }).toEqual({
        win,
        after,
        limit,
        ok: true,
      })
    }
  })

  /**
   * 「一旦看过就冻结」:同一份消息第二次进来不会被重新替换(否则打断 prompt cache)。
   * 变异:让 fresh 的判据忽略 seenIds → 第二次会返回非空,这条会红。
   */
  /**
   * **`applyToolResultBudget` 是 query.ts 唯一调用的那个函数,而它此前零覆盖。**
   *
   * 验收席把它内部那句 `windowChars,` 改成 `undefined,`(= 整个功能对 /et 变成空操作),
   * 3533 个测试全绿 —— 因为上面所有用例驱动的都是内层的 `enforceToolResultBudget`。
   * 这条补上外层:窗口要真的透传下去,`onPersisted` 要真的被叫到。
   *
   * 变异:①`enforceToolResultBudget(messages, state, skipToolNames, windowChars)` 的
   * 第四个实参改成 `undefined` ②删掉 `onPersisted?.(...)` —— 两个都会红。
   */
  test('applyToolResultBudget:窗口透传 + onPersisted 真的被叫到', async () => {
    const persisted: number[] = []
    const state = createContentReplacementState()
    const out = await applyToolResultBudget(
      round([{ id: 't1', tool: 'Glob', chars: 300_000 }]),
      state,
      undefined,
      new Set(),
      roleWindowChars(128_000),
      recs => persisted.push(recs.length),
    )
    expect(persisted).toEqual([1])
    expect(toolResultTotal(out)).toBeLessThan(300_000)
  })

  /** 没有窗口时外层也必须什么都不做(主循环那条路走的就是它)。 */
  test('applyToolResultBudget:无窗口 → 不落盘、不叫 onPersisted', async () => {
    const persisted: number[] = []
    const state = createContentReplacementState()
    const msgs = round([{ id: 't1', tool: 'Bash', chars: 800_000 }])
    const out = await applyToolResultBudget(
      msgs,
      state,
      undefined,
      new Set(),
      undefined,
      recs => persisted.push(recs.length),
    )
    expect(persisted).toEqual([])
    expect(out).toBe(msgs)
  })

  test('第二轮不重复落盘(冻结语义)', async () => {
    const msgs = round([{ id: 't1', tool: 'Glob', chars: 300_000 }])
    const state = createContentReplacementState()
    const w = roleWindowChars(128_000)
    const first = await enforceToolResultBudget(msgs, state, new Set(), w)
    const second = await enforceToolResultBudget(
      first.messages,
      state,
      new Set(),
      w,
    )
    expect(first.newlyReplaced.length).toBe(1)
    expect(second.newlyReplaced.length).toBe(0)
  })
})
