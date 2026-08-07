/**
 * 压缩兜底「丢体积不丢轮次」这条路的探针。
 *
 * 背景:`truncateHeadForPTLRetry` 只丢**最老**的组,而顶穿窗口的那条几 MB 的产出恰恰在
 * **最近**一轮(它刚产生,正是它顶穿的)。于是压缩自己也超长、也被拒,三次重试全废,
 * 最后抛 ERROR_MESSAGE_PROMPT_TOO_LONG,那一席直接死掉。
 *
 * **覆盖范围要说清:** 下面测的是这条路上的两个原语(`shrinkLargestToolResults`、
 * `ptlShrinkTarget`)和它们所依赖的前提(单轮时丢头必然返回 null)。把整个
 * `compactConversation` / `partialCompactConversation` 循环驱动起来需要伪造
 * `streamCompactSummary` 的流式响应,而这个仓库现在**一条压缩循环的测试都没有**,
 * 那套脚手架不在本轮范围内 —— `messagesToKeep` 那条接缝目前靠代码审查保证,不靠探针。
 * 这是已知缺口,不是「已覆盖」。
 */
import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../../services/api/errors.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  PERSISTED_OUTPUT_TAG,
  shrinkLargestToolResults,
} from '../../utils/toolResultStorage.js'
import {
  persistExemptToolNames,
  ptlShrinkTarget,
  truncateHeadForPTLRetry,
} from './compact.js'

function round(parts: { id: string; tool: string; chars: number }[]): Message[] {
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

/**
 * 上游那句「Prompt is too long」的**真实形状**。
 *
 * 必须走 `createAssistantAPIErrorMessage`:`getPromptTooLongTokenGap` 的第一道闸是
 * `isPromptTooLongMessage(msg) && msg.errorDetails`,而前者又要求 `isApiErrorMessage`
 * 为 true。用一条普通 assistant 消息装上同样的文字**看起来一样、判据一条都不满足** ——
 * 探针第一版就是这么写的,于是它测的是回落分支,而不是它自称在测的那条。
 */
function ptlResponse(errorDetails?: string): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content: PROMPT_TOO_LONG_ERROR_MESSAGE,
    errorDetails,
  })
}

function toolResultTexts(messages: Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const b of m.message.content) {
      if (b.type === 'tool_result' && typeof b.content === 'string') {
        out.push(b.content)
      }
    }
  }
  return out
}

describe('前提:丢头对单轮对话无能为力', () => {
  /**
   * 这条是 D 的**落点**为什么选在 `truncated === null` 而不是 `dropCount < 1` 的全部理由。
   * v1 方案选了后者,而单轮那一档在更早的 `groups.length < 2` 就返回了,
   * 那条新分支一次都不会被执行 —— 质量席和规范席各自独立指出这一点。
   *
   * **这条钉的是「调用方看得见的 null」,不区分内部哪一道闸返回的**(单轮时
   * `groups.length < 2` 和随后的 `dropCount < 1` 会给出同一个结果,验收席实测把前者
   * 改成 `< 1` 本条仍绿)。而落点依赖的恰恰就是这个调用方可见的事实,所以断言是对的 ——
   * 不要照着一个更强的杀伤声明去读它。
   */
  test('只有一轮时 truncateHeadForPTLRetry 返回 null', () => {
    const msgs = round([{ id: 't1', tool: 'Glob', chars: 3_000_000 }])
    expect(truncateHeadForPTLRetry(msgs, ptlResponse())).toBeNull()
  })
})

describe('shrinkLargestToolResults', () => {
  /**
   * 变异:把排序去掉(不按 size 降序)→ 会先换掉小的、甩不够目标,这条会红。
   */
  test('优先换掉最大的那条,直到甩够目标', async () => {
    const msgs = round([
      { id: 'small', tool: 'Grep', chars: 5_000 },
      { id: 'huge', tool: 'Glob', chars: 900_000 },
    ])
    const res = await shrinkLargestToolResults(msgs, 500_000)
    expect([...res.replacements.keys()]).toEqual(['huge'])
    expect(res.freedChars).toBeGreaterThan(500_000)
  })

  // 变异:去掉 `if (freedChars >= targetChars) break` → 会把 small 也换掉,上面那条会红。

  /**
   * 换进去的必须是**预览 + 路径**,而且原文真的不在消息里了 —— 否则这一步甩不掉任何体积。
   * 变异:返回原 messages(不调 replaceToolResultContents)→ 这条会红。
   */
  test('替换后的消息里是预览,不是原文', async () => {
    const msgs = round([{ id: 'huge', tool: 'Glob', chars: 900_000 }])
    const res = await shrinkLargestToolResults(msgs, 100_000)
    const texts = toolResultTexts(res.messages)
    expect(texts[0]).toContain(PERSISTED_OUTPUT_TAG)
    expect(texts[0]!.length).toBeLessThan(900_000)
  })

  /**
   * Read 的豁免在这条路上同样成立 —— 落盘让模型再 Read 一次是循环的。
   * 变异:忽略 skipToolNames → 这条会红。
   */
  test('skipToolNames 里的工具不动', async () => {
    const msgs = round([{ id: 't1', tool: 'Read', chars: 900_000 }])
    const res = await shrinkLargestToolResults(msgs, 100_000, new Set(['Read']))
    expect(res.replacements.size).toBe(0)
    expect(res.freedChars).toBe(0)
    // 甩不动时必须原样返回,让调用点能判断出「抢救失败」并抛出真实的那句报错。
    expect(res.messages).toBe(msgs)
  })

  /**
   * 已经是预览的不再重复落盘(`isContentAlreadyCompacted` 把它挡在候选之外)。
   * 变异:去掉那条过滤 → 第二次会返回非空,这条会红。
   */
  test('第二次调用不重复换(已经是预览了)', async () => {
    const msgs = round([{ id: 'huge', tool: 'Glob', chars: 900_000 }])
    const first = await shrinkLargestToolResults(msgs, 100_000)
    const second = await shrinkLargestToolResults(first.messages, 100_000)
    expect(first.replacements.size).toBe(1)
    expect(second.replacements.size).toBe(0)
  })
})

describe('persistExemptToolNames 的接线', () => {
  /**
   * 两个调用点原来都**不传** skipToolNames(集成验收发现那个形参是纯死参),
   * 于是常规预算永远不碰的 Read 产出会在压缩兜底里被换掉,而这条分歧没有任何地方写着。
   * 这条钉的是「豁免集合真的被算出来并传下去」——
   * 变异:把 `persistExemptToolNames` 的 filter 判据反过来(或让它返回空集)→ 会红。
   */
  test('声明 Infinity 的工具进得了豁免集合', () => {
    // 打**真身**,不重抄一份 filter —— 重抄出来的替身和真身漂移时测试仍然是绿的。
    const ctx = {
      options: {
        tools: [
          { name: 'Read', maxResultSizeChars: Number.POSITIVE_INFINITY },
          { name: 'Glob', maxResultSizeChars: 100_000 },
        ],
      },
    } as unknown as Parameters<typeof persistExemptToolNames>[0]
    expect([...persistExemptToolNames(ctx)]).toEqual(['Read'])
  })
})

describe('ptlShrinkTarget', () => {
  /**
   * 上游报了 `N tokens > M maximum` 时按缺口算,并**乘余量** —— 刚好卡着缺口甩会再撞一次,
   * 而每一次再撞都是一趟完整的压缩调用。
   * 变异:去掉 1.5 的余量 → 这条会红。
   */
  test('上游给了 token 缺口时按缺口算,并留余量', () => {
    const resp = ptlResponse('prompt is too long: 210000 tokens > 200000 maximum')
    const target = ptlShrinkTarget(resp, round([{ id: 'a', tool: 'X', chars: 10 }]))
    // 缺口 10000 token × 4 字符 × 1.5 = 60000
    expect(target).toBe(60_000)
  })

  /**
   * 第三方网关基本不给那个数,这时退回「甩掉当前总量的一半」。
   * 变异:解析不出来时返回 0 → 抢救会一条都不换,这条会红。
   */
  test('解析不出缺口时退回按总量的一半', () => {
    const msgs = round([{ id: 'a', tool: 'Glob', chars: 400_000 }])
    const target = ptlShrinkTarget(ptlResponse(), msgs)
    // 钉住 0.5 这个系数本身:`toBeGreaterThan(0)` 对任何正系数都成立,
    // 验收席实测把 0.5 改成 0.01 那条仍然绿。
    const expected = Math.ceil(
      roughTokenCountEstimationForMessages(msgs) * 4 * 0.5,
    )
    expect(target).toBe(expected)
  })
})
