/**
 * **硬封顶闸永远不许排在自动压缩前面。**
 *
 * ## 这一组守的是一次真实事故
 *
 * 2026-08-19 跑机(qianbase-xtp,run 001):10 个执行席位命中 `Prompt is too long`、
 * 6 个节点最终 BLOCKED,而**请求一次都没发出去** —— 打死它们的是 `query.ts` 的硬封顶闸,
 * 不是上游。判据:这 10 席那条报错的 `errorDetails` 一条都没有,而真上游拒收必带。
 *
 * 机制是两条线各自减各自的:
 *   封顶闸   = effective − MANUAL_COMPACT_BUFFER_TOKENS(固定 3000)
 *   压缩阈值 = effective − min(AUTOCOMPACT_BUFFER_TOKENS, effective × 10%)
 *
 * 窗口大的时候后者是 13000 > 3000,压缩先开火,封顶闸只是它没救成时的兜底 —— 这正是
 * `query.ts` 那句注释「only applies when auto-compact is OFF」描述的世界。但有两条路会
 * 把顺序**颠倒**过来:
 *
 *  1. **两边用了不同的窗口。** 封顶闸当时漏传员工的 `contextWindow`,于是它按父会话模型的
 *     200k 默认算(恒定 177000),而压缩阈值跟着员工声明走。声明 233000 → 阈值 200000 →
 *     [177000, 200000) 是必杀区间;声明 1M → [177000, 967000)。**声明得越大死得越快**,
 *     而当时阻断卡上那句建议恰恰是「给这个员工声明真实的上下文窗口」。
 *  2. **窗口太小时 `effective × 10%` 掉到 3000 以下**,两条线自然换位 —— 这条与传不传窗口
 *     无关,`MIN_ROLE_CONTEXT_WINDOW = 8000` 明确放行这些值。
 *
 * 第 1 条修在 `query.ts`(补传窗口),第 2 条修在这里(取 max)。下面钉的是**第 2 条**,
 * 以及「两边同窗口时顺序恒定正确」这条不变量。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  shouldPreemptForContextLimit,
} from './autoCompact.js'
import {
  noteUpstreamContextLimit,
  resetLearnedContextWindows,
} from './roleContextCeiling.js'

const MODEL = 'claude-opus-4-5'

// roleContextCeiling 是模块级账本,两个测试文件共用一份 —— 每条用例前清一次,
// 别指望「谁弄脏谁擦干净」那种手工平衡。
beforeEach(() => resetLearnedContextWindows())

/** 二分找出「封顶闸从这个 token 数开始开火」。 */
function blockingLimitFiresAt(window?: number): number {
  let lo = 1
  let hi = 2_000_000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (calculateTokenWarningState(mid, MODEL, window).isAtBlockingLimit) hi = mid
    else lo = mid + 1
  }
  return lo
}

describe('不变量:自动压缩开着时,封顶闸不早于压缩阈值', () => {
  /**
   * 覆盖到 `MIN_ROLE_CONTEXT_WINDOW`(8000)那一档 —— 小窗口正是换位发生的地方。
   * 换位的精确临界是 **effective ≥ 30000,即声明窗口 ≥ 37500**(那时 `effective×10%` 才
   * 追上固定的 3000);37500~40000 之间顺序本来就是对的,下面取 40000 只是取整。
   *
   * 变异:把 `autoCompact.ts` 里 `Math.max(rawBlockingLimit, autoCompactThreshold)`
   * 改回 `rawBlockingLimit` → 8000/16000/32000/37000 四档立刻变红
   * (实测换位区间:[3400,5760)、[9800,11520)、[22600,23040)、[26600,26640))。
   */
  test.each([
    8_000, 16_000, 32_000, 37_000, 40_000, 128_000, 200_000, 233_000, 1_000_000,
  ])('声明窗口 %i', window => {
    const threshold = getAutoCompactThreshold(MODEL, window)
    expect(blockingLimitFiresAt(window)).toBeGreaterThanOrEqual(threshold)
  })

  test('不声明窗口时(主循环那条路)同样成立', () => {
    expect(blockingLimitFiresAt()).toBeGreaterThanOrEqual(getAutoCompactThreshold(MODEL))
  })
})

describe('大窗口那几档的算术一个字节都没变', () => {
  /**
   * `Math.max` 在这些档上必须是**恒等**的:13000 > 3000,原来的 `effective − 3000`
   * 本来就大于阈值。这条钉的是「修小窗口没有顺手改动 200k / 1M 的行为」。
   */
  test.each([
    [undefined, 180_000],
    [200_000, 180_000],
    [233_000, 213_000],
    [1_000_000, 980_000],
  ])('声明 %s → 封顶闸仍是 effective − 3000 = %i', (window, effective) => {
    expect(getEffectiveContextWindowSize(MODEL, window as number | undefined)).toBe(effective)
    expect(blockingLimitFiresAt(window as number | undefined)).toBe(effective - 3_000)
  })
})

describe('事故现场的那两个数', () => {
  /**
   * 这条是**归档**:它记住必杀区间当年到底长什么样,以及区间宽度随声明值放大这件事。
   * 两个数用的是**同一个窗口**,所以现在的正确关系是「压缩先开火」。
   */
  test('声明 233000:压缩 200000 先于封顶闸 210000', () => {
    expect(getAutoCompactThreshold(MODEL, 233_000)).toBe(200_000)
    expect(blockingLimitFiresAt(233_000)).toBe(210_000)
  })

  /**
   * 当年真正致命的是**两边窗口不一致**:封顶闸按 200k 默认算 = 177000,而压缩要到 200000
   * 才动。这条把「不传窗口时闸门在哪」钉住,免得有人以为漏传无所谓。
   */
  test('漏传窗口时闸门恒在 177000 —— 与员工声明多大完全无关', () => {
    expect(blockingLimitFiresAt()).toBe(177_000)
  })
})

describe('shouldPreemptForContextLimit —— query.ts 真正调用的那一个', () => {
  /**
   * 这一组钉的是**接线**,不是算术。这个仓库为「判据写对了但接线是死的」付过三次学费,
   * 而这条判据最容易坏的地方恰恰是少传一个 `roleClientConfig`。
   *
   * 变异:把 `shouldPreemptForContextLimit` 里的 `effectiveRoleContextWindow(...)`
   * 换成 `undefined` → 这个 describe 里的**三条**都红(178399 会被判成要拦,而它离员工自己的压缩
   * 阈值还差 21601;学到的上界也一起失效)。
   */
  test('给了员工窗口就按员工窗口算 —— 事故现场那个数不再被拦', () => {
    // 必杀区间里的一个代表值:比闸门(177000)高,比压缩阈值(200000)低
    expect(shouldPreemptForContextLimit(178_399, MODEL, { contextWindow: 233_000 })).toBe(false)
    // 而漏传窗口时它会被拦 —— 这正是当年发生的事
    expect(shouldPreemptForContextLimit(178_399, MODEL, undefined)).toBe(true)
  })

  test('真到了员工自己的闸门才拦', () => {
    expect(shouldPreemptForContextLimit(209_999, MODEL, { contextWindow: 233_000 })).toBe(false)
    expect(shouldPreemptForContextLimit(210_000, MODEL, { contextWindow: 233_000 })).toBe(true)
  })

  /**
   * 自适应上界也必须走同一条路 —— 否则学到了真实上限,而闸门还按声明值算。
   * 变异:把 `effectiveRoleContextWindow(cfg)` 换成 `cfg?.contextWindow` → 这条红。
   */
  test('学到的上界会一起生效', () => {
    resetLearnedContextWindows()
    const cfg = { roleName: '研发', contextWindow: 233_000 }
    expect(shouldPreemptForContextLimit(150_000, MODEL, cfg)).toBe(false)
    noteUpstreamContextLimit('研发', 140_000)
    // 上界收到 140000 之后 effective = 112000,闸门 = 100800(取 max 后与阈值持平)
    expect(shouldPreemptForContextLimit(150_000, MODEL, cfg)).toBe(true)
    resetLearnedContextWindows()
  })

  test('主循环(没有 roleClientConfig)逐字不变', () => {
    expect(shouldPreemptForContextLimit(176_999, MODEL, undefined)).toBe(false)
    expect(shouldPreemptForContextLimit(177_000, MODEL, undefined)).toBe(true)
  })
})
