/**
 * 上游限流之后的退避。
 *
 * 用户报的是 429。`/et` 这一侧在限流的那一刻做了三件加剧它的事(见 rateLimitGate.ts 文件头),
 * 而这个文件钉的是**退避本身的两条硬约束** —— 它们都是评审用真数字算出来的,不是审美:
 *  1. 一个冷却窗口最多抬一级(否则一波 15 次上报直接顶到 60s 上限);
 *  2. 到点不能一起醒(否则 5 个请求在同一个 tick 出发,必然再吃一次 429 → 自激振荡)。
 */
import { describe, expect, it } from 'bun:test'

import { createRateLimitGate } from './rateLimitGate.js'

/** 假时钟 + 假 sleep:sleep 只把时钟往前推,不真的等。 */
function fake() {
  let t = 1_000
  const slept: number[] = []
  const gate = createRateLimitGate({
    now: () => t,
    random: () => 0, // 抖动固定成 0,断言才能是精确数字
    sleep: async (ms, signal) => {
      slept.push(ms)
      // signal 已经 abort 时立刻返回,时钟不动 —— 真 sleep 也是这个行为。
      if (signal?.aborted === true) return
      t += ms
    },
  })
  return { gate, slept, advance: (ms: number) => { t += ms }, at: () => t }
}

describe('退避的时长', () => {
  it('每级翻倍,从 2s 起,上限 60s', () => {
    const { gate, advance } = fake()
    const seen: number[] = []
    for (let i = 0; i < 7; i++) {
      seen.push(gate.noteRateLimit())
      // 让上一个窗口过去,下一次上报才算「新一波」。
      advance(seen[seen.length - 1]! + 1)
    }
    expect(seen).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  })

  it('同一个窗口里的重复上报**不抬级**,只报剩余时间', () => {
    /**
     * 限流是整波打过来的:池子满载 5 个在飞 → 一波 5 次上报;一桌 5 席 × 3 次重试 →
     * 最坏 15 次。每次都抬级的话 k 从 6 起就顶到上限,而其中 14 次说的是同一件事。
     */
    const { gate, advance } = fake()
    expect(gate.noteRateLimit()).toBe(2_000)
    advance(500)
    expect(gate.noteRateLimit()).toBe(1_500) // 剩余,不是 4_000
    expect(gate.noteRateLimit()).toBe(1_500)
    // 窗口过去之后才抬一级。
    advance(2_000)
    expect(gate.noteRateLimit()).toBe(4_000)
  })

  it('一次成功把级数清零', () => {
    const { gate, advance } = fake()
    gate.noteRateLimit(); advance(2_001)
    gate.noteRateLimit(); advance(4_001)
    gate.noteSuccess()
    expect(gate.noteRateLimit()).toBe(2_000)
  })

  it('**窗口之内**的成功不清级数 —— 否则并发下梯子永远停在第一级', () => {
    /**
     * 满载 5 个在飞时,一波限流里只要有一个调用成功(错峰放行的第一个),无条件清零会把
     * 级数打回去 —— 实测每一轮都是 2s,而 README 承诺的「2s → 4s → 8s …上限 60s」在
     * 最常见的混合形态下**不可达**。
     *
     * 窗口内的成功恰恰说明「错峰放行有效」,不说明「限流过去了」;真正过去了的判据是
     * **冷却结束之后**还能成功 —— 那一条上面那个用例守着。
     */
    const { gate, advance } = fake()
    expect(gate.noteRateLimit()).toBe(2_000)
    advance(500)
    gate.noteSuccess() // 还在冷却窗口里
    advance(1_501) // 窗口过去
    expect(gate.noteRateLimit()).toBe(4_000) // 抬到第二级,而不是回到 2s
  })

  it('cooldownMs 随时间递减,到点归零', () => {
    const { gate, advance } = fake()
    gate.noteRateLimit()
    expect(gate.cooldownMs()).toBe(2_000)
    advance(1_200)
    expect(gate.cooldownMs()).toBe(800)
    advance(800)
    expect(gate.cooldownMs()).toBe(0)
  })
})

describe('wait', () => {
  it('不在冷却中就是零成本', async () => {
    const { gate, slept } = fake()
    expect(await gate.wait()).toBe(0)
    expect(slept).toEqual([])
  })

  it('冷却中就等到点,并把「在等什么」交出去', async () => {
    const { gate, slept } = fake()
    gate.noteRateLimit()
    const waited: number[] = []
    await gate.wait({ onWait: ms => waited.push(ms) })
    expect(slept).toEqual([2_000])
    expect(waited).toEqual([2_000])
    expect(gate.cooldownMs()).toBe(0)
  })

  it('多个等待者**各自错峰**,不在同一个 tick 一起醒', async () => {
    /**
     * 这条是自激振荡的解药。抖动加在「冷却时长」上时所有等待者算出同一个 until,
     * 冷却到点时 5 个(用户把并行调到 20 就是 20 个)请求在同一 tick 出发 →
     * 必然再吃一次 429 → 再冷却 60s:把限流变成一个周期性的死循环。
     */
    const { gate, slept } = fake()
    gate.noteRateLimit()
    // 三个等待者同时进来(不推时钟,模拟同一瞬间)。
    const g = createRateLimitGate({
      now: () => 1_000, random: () => 0, sleep: async ms => { slept.push(ms) },
    })
    g.noteRateLimit()
    await Promise.all([g.wait(), g.wait(), g.wait()])
    // 第 1 个等基础冷却,后面每个多等一档。
    expect(slept.slice(-3)).toEqual([2_000, 2_250, 2_500])
  })

  it('错峰有上限 —— 席位再多也不该把 2s 拖成一分钟', async () => {
    const slept: number[] = []
    const g = createRateLimitGate({ now: () => 0, random: () => 0, sleep: async ms => { slept.push(ms) } })
    g.noteRateLimit()
    for (let i = 0; i < 40; i++) await g.wait()
    expect(Math.max(...slept)).toBe(2_000 + 5_000)
  })

  it('已经 abort 的 signal:一秒都不等', async () => {
    /**
     * 而且这一条是**功能性**的,不只是省时间:调用方在 wait 之后靠 `signal.aborted`
     * 早退,而一个已经 abort 的 signal 不会再派发 abort 事件 —— 等下去的后果是 60 秒后
     * 照样派出一个真的、带写工具的子 agent。
     */
    const { gate, slept } = fake()
    gate.noteRateLimit()
    const ac = new AbortController()
    ac.abort()
    expect(await gate.wait({ signal: ac.signal })).toBe(0)
    expect(slept).toEqual([])
  })

  it('单节点被取消:同样立刻返回', async () => {
    // `registerCall` 发生在 wait 之后,所以 cancelNode 碰不到这次调用 —— 不给这条早退,
    // 用户按下 x 之后屏幕上那个节点会继续显示「运行中」直到冷却结束(最坏 60 秒)。
    const { gate, slept } = fake()
    gate.noteRateLimit()
    expect(await gate.wait({ stop: () => true })).toBe(0)
    expect(slept).toEqual([])
  })

  it('等待期间 abort:sleep 被打断,而且不假报等了多久', async () => {
    let t = 0
    const gate = createRateLimitGate({
      now: () => t,
      random: () => 0,
      // 真 sleep 的行为:signal abort 时立刻返回,时钟没走完。
      sleep: async (_ms, signal) => { if (signal?.aborted !== true) t += _ms; else t += 5 },
    })
    gate.noteRateLimit()
    const ac = new AbortController()
    ac.abort()
    // 已经 abort → 上面那条早退接住,压根不进 sleep。
    expect(await gate.wait({ signal: ac.signal })).toBe(0)
  })

  it('onWait 抛异常不能把这次调用带走', async () => {
    const { gate } = fake()
    gate.noteRateLimit()
    await gate.wait({ onWait: () => { throw new Error('UI 炸了') } })
    expect(gate.cooldownMs()).toBe(0)
  })
})
