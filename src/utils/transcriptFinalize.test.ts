/**
 * transcript 的写队列**要等 assistant 记录定稿再序列化** —— 但只等**可能被写回的那一条**。
 *
 * ## 这一组守的是什么
 *
 * `claude.ts` 在 `message_delta` 里把最终的 `usage` 和 `stop_reason` 写回
 * `newMessages.at(-1)`(两条相邻赋值,同一个 `if` 块、中间没有 await,所以同生共死),
 * 而记录在更早的 `content_block_stop` 就入队了。队列存**活引用**、`jsonStringify` 发生在
 * drain —— 所以 drain 抢在写回之前的话,落盘的是 `message_start` 铺的初值:
 * `usage` 全 0、`stop_reason: null`。
 *
 * `QueryEngine.ts` 里那段 "fire-and-forget for assistant messages" 的注释明写着它**在指望**
 * 这次惰性序列化能接住写回。而 2026-08-19 跑机实测:openai-responses 协议的席位,最后一个
 * 内容块到 `message_delta` 之间隔 121ms(该协议的 usage 只在 `response.completed` 帧里,
 * 要等整条流跑完),而 drain 周期是 100ms —— **234 次响应里只有 58 次(24.8%)的 usage
 * 落到了盘上**(这三个数在 8 份席位 jsonl 上逐条数过,吻合)。
 *
 * 代价不是「统计不好看」:`--resume` 从盘上重建,而 `tokenCountWithEstimation` 会锚在一条
 * 全 0 的记录上返回约 0 —— 恢复出来的会话以为自己是空的(实测那 8 份盘上记录跑出来是
 * 60 / 97 / 479 / 1133 / 1303 / 1585 / 2820 / 68063)。
 *
 * ## 两条判据都是被验收打回后才长出来的
 *
 *  1. **只等队尾那条。** `message_delta` 只写回 `at(-1)`,所以一条多块响应里除最后一块外的
 *     记录**永远不会定稿**。第一版对它们一视同仁地等,而 text+tool_use 是 agent 循环里最
 *     普通的一轮 —— 三席各自实测出同一组数(真写盘路径):单块 128ms → 两块 610ms →
 *     四块 1608ms,白等,而且把崩溃丢失窗口从 ~100ms 拉到 ~1.6s。
 *  2. **预算是墙钟,不是轮数。** `FLUSH_INTERVAL_MS` 不是常量:`setRemoteIngressUrl` /
 *     `setInternalEventWriter` 会把它改成 10ms,那时「5 轮」只有 50ms < 要等的 121ms,
 *     整条修复在 remote/CCR 那一档完全失效(验收实测:83ms 就写出一条全 0)。
 *
 * ## 为什么不改流时序
 *
 * 评审里提过「照 chat 桥把块攒到最后再发」。那个依据不成立:`fromOpenAIStream` 的
 * `w.text()/w.thinking()` 同样是逐 chunk 立即发,两桥 `finish` 位置也一样,121ms 的差别来自
 * **网关把 usage 放在哪一帧**。真按那个方案改,会丢掉 responses 桥现在独有的流式工具提前量
 * (`streamingToolExecutor` 能在模型还在吐后续块时就开跑第一个工具)。所以修在 drain 这一侧:
 * 不动任何人看到消息的时机,只动**序列化的时机**。
 */
import { describe, expect, test } from 'bun:test'
import {
  FINALIZE_WAIT_MS,
  isUnfinalizedAssistantEntry,
  writableQueuePrefix,
} from './sessionStorage.js'

const assistant = (stopReason: string | null): Record<string, unknown> => ({
  type: 'assistant',
  message: { stop_reason: stopReason, usage: { input_tokens: 0, output_tokens: 0 } },
})
const user = (): Record<string, unknown> => ({ type: 'user', message: { content: 'x' } })
const q = (...entries: unknown[]): { entry: unknown }[] => entries.map(entry => ({ entry }))

/** 固定时钟,免得探针依赖真实时间。 */
const clock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}

describe('isUnfinalizedAssistantEntry', () => {
  test('stop_reason 还是 null 的 assistant = 没定稿', () => {
    expect(isUnfinalizedAssistantEntry(assistant(null))).toBe(true)
  })

  /**
   * 判据只看 `stop_reason` 不看 `usage`:两者由相邻两条赋值写回、同生共死,而
   * `stop_reason: null` 没有歧义 —— `usage` 全 0 理论上还能有别的成因。
   *
   * 变异:改成判 usage 全 0 → **这一条**红(它的 usage 也是全 0,会被误判成没定稿)。
   */
  test('写回过 stop_reason 的 assistant = 定稿了', () => {
    expect(isUnfinalizedAssistantEntry(assistant('tool_use'))).toBe(false)
  })

  test('user 记录、以及非记录一律不等待', () => {
    expect(isUnfinalizedAssistantEntry(user())).toBe(false)
    expect(isUnfinalizedAssistantEntry(undefined)).toBe(false)
    expect(isUnfinalizedAssistantEntry(null)).toBe(false)
    expect(isUnfinalizedAssistantEntry({ type: 'assistant' })).toBe(false)
  })
})

describe('writableQueuePrefix', () => {
  test('全都定稿了 → 整批写出去', () => {
    const c = clock()
    expect(writableQueuePrefix(q(user(), assistant('end_turn'), user()), false, new WeakMap(), c.now)).toBe(3)
  })

  /**
   * 变异:把 `return last` 改成 `return queue.length` → 这条红,而它正是整个修复的落点。
   */
  test('队头那条没定稿 → 这一轮一条都不写', () => {
    const c = clock()
    expect(writableQueuePrefix(q(assistant(null), user()), false, new WeakMap(), c.now)).toBe(0)
  })

  /**
   * **候选只有队尾那条 assistant,不管它定没定稿。**
   *
   * 这条是 agent 循环里**最常见**的一轮:text 块(`stop_reason` 恒 null,因为
   * `message_delta` 只写回 `at(-1)`)+ tool_use 块(拿到写回)。队尾那条已经定稿,
   * 说明整条响应收口了 —— 前面那条 text **永远**不会再被写回,等它是纯亏损。
   *
   * 判据写成「最后一条**未定稿的** assistant」会在这里踩坑:它会回头去等那条 text。
   * 真写盘路径实测:那一版两块 509ms / 四块 508ms,而正确的判据是 104ms / 106ms
   * (不修是 610ms / 1608ms)。**第一版修法在旧探针上是绿的**,所以有了这一条。
   *
   * 变异:把候选找法改回「最后一条未定稿的 assistant」→ 这条红(会返回 0)。
   */
  test('text + tool_use:队尾已定稿 → 整批放行,不回头等永不定稿的那条', () => {
    const c = clock()
    const queue = q(assistant(null), assistant('tool_use'))
    expect(writableQueuePrefix(queue, false, new WeakMap(), c.now)).toBe(2)
  })

  /**
   * 四块(text + 3 个并行 tool_use)同理 —— 只要队尾定稿了就整批放行。
   */
  test('四块响应:队尾定稿 → 整批放行', () => {
    const c = clock()
    const queue = q(assistant(null), assistant(null), assistant(null), assistant('tool_use'), user())
    expect(writableQueuePrefix(queue, false, new WeakMap(), c.now)).toBe(5)
  })

  /**
   * 队尾那条**没**定稿时才等,而且只等它一条:它前面的非末块直接放行。
   *
   * 变异:把「找最后一条 assistant」改回「找第一条未定稿的」(`for` 里 `break`)
   * → 这条红(会返回 0 而不是 2)。
   */
  test('队尾未定稿:只有它挡路,前面的非末块直接放行', () => {
    const c = clock()
    const queue = q(assistant(null), assistant(null), assistant(null), user())
    expect(writableQueuePrefix(queue, false, new WeakMap(), c.now)).toBe(2)
  })

  /**
   * **连坐是必须的。** 只留下要等的那条、先写它后面的,会把文件顺序打乱 —— transcript 靠
   * `parentUuid` 串成链,且流式工具执行会在 assistant 还没定稿时就产生 tool_result 记录,
   * 所以「后面的先到」是真实会发生的。顺序一乱,`--resume` 重建出来的父子关系就是错的。
   */
  test('要等的那条后面的也一起等,顺序不许打乱', () => {
    const c = clock()
    const queue = q(user(), assistant('end_turn'), assistant(null), user(), user())
    expect(writableQueuePrefix(queue, false, new WeakMap(), c.now)).toBe(2)
  })

  /**
   * 这条钉的是**活引用**这个机制本身:等的过程中 `claude.ts` 把 stop_reason 写了回来,
   * 下一轮就该放行 —— 而放行时序列化到的正是写回后的值。
   */
  test('等待期间被写回之后就放行', () => {
    const c = clock()
    const entry = assistant(null)
    const queue = q(entry)
    const seen = new WeakMap<object, number>()
    expect(writableQueuePrefix(queue, false, seen, c.now)).toBe(0)
    ;(entry.message as { stop_reason: string }).stop_reason = 'tool_use'
    expect(writableQueuePrefix(queue, false, seen, c.now)).toBe(1)
  })

  /**
   * **预算是墙钟,不是轮数。** `FLUSH_INTERVAL_MS` 会被 remote/CCR 改成 10ms,数轮数的话
   * 那一档只等 50ms,而要等的是 121ms —— 整条修复失效(验收实测 83ms 就写出一条全 0)。
   *
   * 变异:把 `t - seen >= FINALIZE_WAIT_MS` 改成恒假 → 这条红(永远返回 0)。
   */
  test('到墙钟预算就按现状写出去,不管 drain 跑了几轮', () => {
    const c = clock()
    const queue = q(assistant(null), user())
    const seen = new WeakMap<object, number>()
    // 10ms 一轮跑很多轮也不放行 —— 数轮数的版本在这里就红了
    for (let i = 0; i < 20; i++) {
      expect(writableQueuePrefix(queue, false, seen, c.now)).toBe(0)
      c.advance(10)
    }
    c.advance(FINALIZE_WAIT_MS)
    expect(writableQueuePrefix(queue, false, seen, c.now)).toBe(2)
  })

  /**
   * `flush()` 传 force —— 关机/切会话时再等下去就是丢记录。
   * 变异:把 `if (force) return queue.length` 删掉 → 这条红。
   */
  test('force 一律全写,不为任何一条等待', () => {
    const c = clock()
    expect(writableQueuePrefix(q(assistant(null), user()), true, new WeakMap(), c.now)).toBe(2)
  })
})
