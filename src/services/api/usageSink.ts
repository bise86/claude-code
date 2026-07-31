/**
 * 「这次 API 调用花了多少」的**旁路上报**。
 *
 * ## 为什么需要它
 *
 * `/et` 的用量表原来只认一个来源:子 agent yield 出来的 assistant 消息上带的 `usage`。
 * 那条路数得准,但它**只看得见被 yield 出来的调用**,而一个子 agent 的一生里有几类调用
 * 根本不产生 assistant 消息:
 *
 *  - **自动压缩**(`autoCompactIfNeeded`):它对子 agent 不设防,而一次压缩就是一次读满
 *    上下文窗口的完整调用(200k 模型上 15~18 万输入 token);它的产出以 `UserMessage`
 *    回到主循环,用量表一条都看不见。执行档最容易把窗口撑满,也就是最贵的那一档漏得最多。
 *  - 引擎自己发起的辅助调用(标题生成、摘要之类)。
 *
 * 于是那张表的自述里写着「这个数是**下限**,误差随有没有压缩过而阶跃」。这个模块把那道
 * 阶跃抹平:所有真实请求在 `claude.ts` 结算成本的**同一处**顺手上报一份,谁在听谁收。
 *
 * ## 为什么是 AsyncLocalStorage,而不是一个全局回调
 *
 * 一次 `/et` 运行里有几十个节点并行,每个节点自己一份账。全局回调分不清这一次上报属于
 * 哪个节点;而 ALS 天然按**异步调用链**归属 —— 适配器在派发这一次子 agent 调用时把
 * sink 装进上下文,那条链上发生的每一次 API 请求(包括它内部的压缩)都会落到对的节点上。
 * 仓库里已经有同样的用法(`runWithCwdOverride`)。
 *
 * ## 去重靠 requestId
 *
 * 同一次请求会被上报**两次**:一次从这里,一次从那条消息上的 `usage`。两边带的是同一个
 * `requestId`(SDK 从 `request-id` 响应头读出来,翻译层也会给自己的响应签一个),
 * 所以用量表按这个键取最大值就能把它们合成一次 —— 见 `usage.ts` 的 `keyOf`。
 *
 * 没有 requestId 时**不上报**:那种情况下没有任何办法把这一份和消息上的那一份认成同一次,
 * 而多报一次的后果(调用次数虚涨、token 翻倍)比少报一次更坏 —— 用户正拿这个数判断
 * 一趟跑下来花了多少。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ApiUsageReport {
  /** SDK 从 `request-id` 响应头读到的那个。缺席时这条上报会被丢掉(见文件头)。 */
  requestId?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ApiUsageSink = (r: ApiUsageReport) => void

const store = new AsyncLocalStorage<ApiUsageSink>()

/** 在这段异步调用链里,所有 API 用量都报给 `sink`。 */
export function withApiUsageSink<T>(sink: ApiUsageSink, fn: () => T): T {
  return store.run(sink, fn)
}

/**
 * 上报一次真实请求的用量。**永不抛** —— 它跑在模型响应的热路径上,而一个统计功能
 * 没有资格让一次真实调用失败。
 */
export function reportApiUsage(r: ApiUsageReport): void {
  const sink = store.getStore()
  if (!sink) return
  // 见文件头:没有 requestId 就没法和消息那一侧去重,宁可少报。
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) return
  try {
    sink(r)
  } catch {
    /* 统计失败不能影响这次调用 */
  }
}
