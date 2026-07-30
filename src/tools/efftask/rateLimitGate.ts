// src/tools/efftask/rateLimitGate.ts
//
// 上游说「慢一点」之后,**整趟 run 一起慢下来**。
//
// 用户报的是 429。查下来 `/et` 这一侧有三处在限流的那一刻**加剧**它,而 `src/tools/efftask/`
// 和 `src/commands/efftask/` 全目录一个 sleep/backoff 都没有(grep 过):
//
//  1. 429 → `errors.ts` 造一条 `isApiErrorMessage` 的 assistant 消息 → `providerErrorOf`
//     认出来 → 抛 `ProviderApiError` → 圆桌把任何 rejection 一律合成 `infra: true` →
//     `roundtableWithInfraRetry` **立刻**重开整桌,中间零间隔;
//  2. 重开的是**整桌**,包括已经出过裁决的席位(那一半在 pipeline 里单独修);
//  3. 一次限流只惩罚一个席位,其余槽位继续满速开火 —— 没有任何 run 级的「上游在限流」状态。
//
// 而 SDK 那一层**并不会**替我们兜住:`withRetry.ts` 的 `shouldRetry` 对 429 是
// `!isClaudeAISubscriber() || isEnterpriseSubscriber()` —— 订阅账号的 429 一次都不重试。
// 也就是说在最常见的账号形态下,我们这一层是唯一的重试,而它零间隔。
//
// ## 这个闸门是什么
//
// 一个 run 级的「不早于某个时刻再发下一个请求」。所有 `/et` 的模型调用都从
// `makeRunAgentFn` 出发(七个环节、圆桌的每一席、根方案、自动重拟、冲突自动解决),
// 所以接缝只有一处。
//
// ## 两条实测出来的设计约束(评审给的,都不是推理)
//
//  - **一个冷却窗口最多抬一级。** 限流是整波打过来的:池子满载 5 个在飞 → 一波 5 次
//    `noteRateLimit`;一桌 5 席 × 3 次重试 → 最坏 15 次。每次都抬级的话 `k` 从 6 起就顶到
//    上限,而其中 14 次说的是**同一件事**。所以窗口内的重复上报只延长不抬级。
//  - **到点不能一起醒。** 抖动加在「冷却时长」上时,所有等待者算出同一个 `until`,
//    冷却到点时 5 个(用户调到 20 就是 20 个)请求在同一个 tick 出发 → 必然再吃一次 429 →
//    再冷却:把限流变成一个自激振荡。所以每个等待者**各自**加一个递增的错峰量。

/** 冷却的第一级。之后每级翻倍,上限 60s。 */
const BASE_MS = 2_000
const MAX_MS = 60_000
/** 每个等待者之间的错峰间隔 —— 见文件头第二条。 */
const STAGGER_MS = 250
/** 错峰的上限:席位再多也不该把一个 2s 的冷却拖成一分钟。 */
const MAX_STAGGER_MS = 5_000

export interface RateLimitGate {
  /**
   * 冷却没结束就等到点。**abort 或本节点被取消时立刻返回** —— 调用方在这之后必须再判一次
   * (见 makeRunAgentFn 里那两句):等待期间用户完全可能按了 Esc 或 x,而一个已经 abort 的
   * signal **不会再派发 abort 事件**,靠监听器是救不回来的。
   *
   * @returns 实际等了多少毫秒(0 = 没等)
   */
  wait(opts?: {
    signal?: AbortSignal
    /** 额外的早退条件(单节点取消)。轮询式检查,所以要便宜。 */
    stop?: () => boolean
    /** 真的要等时叫一次,让调用方把「在等什么」写到屏幕上。 */
    onWait?: (ms: number) => void
  }): Promise<number>
  /** 记一次限流,返回本次冷却时长(ms)。窗口内重复上报只延长、不抬级。 */
  noteRateLimit(): number
  /** 一次成功的调用 —— 冷却已经过去了,把级数清零。 */
  noteSuccess(): void
  /** 还要冷却多久(ms),0 = 不在冷却中。给 UI 用。 */
  cooldownMs(): number
}

export function createRateLimitGate(deps: {
  now?: () => number
  /** 可注入,测试用假时钟。默认真 sleep,并且**可被 signal 打断**。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 抖动 [0,1)。测试里固定成 0。 */
  random?: () => number
} = {}): RateLimitGate {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>(resolve => {
      const t = setTimeout(done, ms)
      function done(): void {
        clearTimeout(t)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      // 已经 abort 的 signal 不会再派发事件,所以要先判一次。
      if (signal?.aborted === true) { done(); return }
      signal?.addEventListener('abort', done, { once: true })
    }))
  /** 连续限流的级数。一次成功清零。 */
  let level = 0
  /** 冷却到什么时候。0 = 不在冷却中。 */
  let until = 0
  /** 本窗口已经有几个等待者 —— 用来错峰。窗口结束后归零。 */
  let waiters = 0

  const remaining = (): number => Math.max(0, until - now())

  return {
    noteRateLimit() {
      const t = now()
      if (t < until) {
        // 同一个窗口里的第二、第三…条上报说的是同一件事(整波请求一起被拒)。
        // 不抬级,只把窗口按当前级数续满 —— 否则一波 15 次直接顶到上限。
        return until - t
      }
      level = Math.min(level + 1, 32)
      const base = Math.min(MAX_MS, BASE_MS * 2 ** (level - 1))
      const ms = base + Math.floor(random() * 500)
      until = t + ms
      waiters = 0
      return ms
    },
    noteSuccess() {
      /**
       * **只在冷却窗口之外才清级数。**
       *
       * 反过来(无条件清)在并发下会让梯子永远停在第一级:满载 5 个在飞时,一波里只要
       * 有一个调用成功,`level` 就被清零 —— 实测每一轮都是 2s,而 README 承诺的
       * 「2s → 4s → 8s …上限 60s」在最常见的混合形态下不可达。
       *
       * 窗口内的成功恰恰说明「错峰放行是有效的」,不说明「限流过去了」——
       * 真正过去了的判据是**冷却结束之后**还能成功。
       *
       * 也**不清 `until`**:一次成功不代表窗口结束(它可能是错峰放行的第一个请求)。
       */
      if (now() >= until) level = 0
    },
    cooldownMs: remaining,
    async wait(opts = {}) {
      const base = remaining()
      if (base <= 0) return 0
      if (opts.signal?.aborted === true || opts.stop?.() === true) return 0
      // 各自错峰:同一个窗口里第 n 个等待者多等 n × STAGGER。见文件头第二条。
      const stagger = Math.min(MAX_STAGGER_MS, waiters * STAGGER_MS)
      waiters += 1
      const ms = base + stagger
      try { opts.onWait?.(ms) } catch { /* 只是提示,不能把这次调用带走 */ }
      const started = now()
      await sleep(ms, opts.signal)
      // 假时钟下 now() 可能没动;真时钟下按实际经过算。
      return Math.max(0, now() - started)
    },
  }
}
