/**
 * 「这一席的上下文被动过手脚」的**旁路上报**。
 *
 * ## 为什么需要它
 *
 * 两件事会在用户不知情的时候改变一个席位的上下文形态:
 *
 *  - **产出落盘换预览**(`applyToolResultBudget`):一条几 MB 的工具产出被存到文件、
 *    消息里只留 2KB 预览 + 路径。
 *  - **压缩体积抢救**(`shrinkLargestToolResults`):上游已经拒收、压缩自己也被拒之后,
 *    把最大的几条产出换成预览再重试。
 *
 * 两条都必须有人看见 —— 静默截断是这个仓库反复付代价的那一类。而第一版把出口接在
 * `toolUseContext.addNotification` 上,验收席跑真接缝证出那是一次**完整的空操作**:
 * `createSubagentContext`(`utils/forkedAgent.ts`)对子 agent **写死** `addNotification:
 * undefined`,注释理由是「子 agent 控制不了父进程的 UI」—— 那个决定本身是对的。
 * 于是「预算生效的上下文」和「通知可用的上下文」是两个**不相交**的集合:主循环有通知但
 * 永远不触发预算,员工触发预算但永远没有通知。
 *
 * ## 为什么是 AsyncLocalStorage
 *
 * 和 `usageSink` 逐字同构(那是这个仓库为同一个问题给出的既有答案):一次 `/et` 运行里
 * 几十个节点并行,全局回调分不清这一次上报属于哪个节点,而 ALS 按**异步调用链**归属 ——
 * 适配器派发这一次子 agent 调用时把 sink 装进上下文,那条链上发生的一切(包括它内部的
 * 自动压缩)都会落到对的节点上。
 *
 * ## 没人听的时候
 *
 * 什么都不做。主循环那条路上 `addNotification` 是活的,由调用点自己去用;这个 sink 只
 * 负责把消息送到**子 agent 那条路上真正看得见的地方**(`/et` 的席位输出流)。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type ContextNoticeKind =
  | 'tool-result-persisted'
  | 'ptl-volume-shrink'
  /**
   * 上游报错、正在退避重试。
   *
   * 严格说它改的不是「上下文」,借道这里是因为这是**子 agent 那条路上唯一看得见的旁路**
   * (上面那段解释了为什么不能用 addNotification)。而它必须被看见:一次 10 连重试的
   * 退避加起来能有两分半,期间席位窗口上一个字都不会动 —— 和「这一席挂死了」长得一模一样,
   * 而用户上一次为这类静默付的代价就是那句「没看到日志」。
   */
  | 'api-retry'
  /** 流已经输出不可安全重放的内容;说明为何不能整轮重试。 */
  | 'api-retry-skipped'
  /**
   * 上游说上下文超长,我们把这个员工的窗口上界收到实测值、压缩一次之后重发。
   *
   * 必须被看见:它同时说明了两件用户改得动的事 —— settings 里那个 `contextWindow`
   * 写大了(大多少这行会印出来),以及这一轮的产出被摘要取代了。
   */
  | 'ptl-ceiling-retry'

export interface ContextNotice {
  kind: ContextNoticeKind
  /** 已经写成人话的一行,调用点直接显示。 */
  text: string
}

export type ContextNoticeSink = (n: ContextNotice) => void

const store = new AsyncLocalStorage<ContextNoticeSink>()

/** 在这段异步调用链里,上下文改写事件都报给 `sink`。 */
export function withContextNoticeSink<T>(
  sink: ContextNoticeSink,
  fn: () => T,
): T {
  return store.run(sink, fn)
}

/**
 * 报一条。**永不抛** —— 它跑在一次真实调用的热路径上,而一个可见性功能没有资格让
 * 那次调用失败(`usageSink.reportApiUsage` 同样的理由)。
 *
 * @returns 有没有人收下。调用点用它决定要不要退回自己那条通道(比如主循环的通知)。
 */
export function reportContextNotice(n: ContextNotice): boolean {
  const sink = store.getStore()
  if (!sink) return false
  try {
    sink(n)
    return true
  } catch {
    return false
  }
}
