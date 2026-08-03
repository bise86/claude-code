// src/tools/efftask/liveRedo.ts
//
// **运行中重做**:一个任务失败了,别的任务还在跑,用户想现在就重做它 —— 而不是等整棵树
// 收尾、拿到一个 blocked、再从结束屏重来。
//
// 用户原话:「任务失败了,不需要整体返回失败才能重做任务或阶段,在其它任务还在运行时
// 就可以重做。」
//
// ## 和结束屏那条路的唯一区别
//
// 算新树、落盘、上屏、丢历史输出这四步**逐字共用** `runRedo` / `runSkip` / `runForcePass`
// (它们的 deps 是可注入的,就是为了这个)。区别只在最后一步:
//
//  - 结束屏:`start(nodes)` —— 起一个新的编排器,把新树当种子;
//  - 运行中:`orch.applyLive(nodes, affected)` —— 把新树**并进正在跑的那一棵**。
//
// 起第二个编排器是这条路上最不能做的事:此刻别的节点正在跑,老编排器仍持有它们的在飞
// 调用、仍会 commit 进自己那棵树,而新编排器会把同一批节点再派一遍。这个仓库为
// 「三下回车起了三个编排器」已经付过一次学费。
import type { RedoPlan } from './redo.js'

/**
 * 这次重做**碰过**哪些节点。
 *
 * `applyLive` 拿它判「有没有碰到正在跑的节点」,所以这份清单**宁可多、不可少**:少报一个
 * 正在跑的节点,它的 step 会把结果 commit 进一个已经被换掉的对象 —— 跑完了,树上却什么
 * 都没有,而且没有任何一处会报错。
 *
 * 四个来源都来自 plan 自己,不是重新推导:
 *  - 目标节点(它的状态、迭代计数、工作区都被重置了);
 *  - `deleted` —— 被删掉的整棵子树;
 *  - `reopenedAncestors` —— 被一并放回可推进状态的祖先(它们会重跑集成验收);
 *  - `dependencyRewrites` —— 依赖被改写的**子树外**节点。
 */
export function affectedByRedo(plan: RedoPlan, targetId: string): string[] {
  const out = new Set<string>([targetId])
  for (const id of plan.deleted) out.add(id)
  for (const id of plan.reopenedAncestors) out.add(id)
  for (const r of plan.dependencyRewrites) out.add(r.nodeId)
  return [...out]
}

/**
 * 运行中能不能重做这个节点 —— **在按键那一刻**回答,而不是让用户选完环节、看完后果、
 * 确认完之后才发现不行。
 *
 * 只回答「这一刻这条路通不通」,不回答「这个节点的这个环节能不能重入」(那是
 * `failedRedoTarget` / `skipFailedPhaseReason` 的事,两道闸门分别有各自的话要说)。
 */
export function liveRedoUnavailableReason(opts: {
  /** 编排器还在跑吗。false = 该走结束屏那条路。 */
  running: boolean
  /** 这个节点此刻正在跑吗。 */
  nodeRunning: boolean
  title: string
}): string | undefined {
  if (!opts.running) return undefined // 没在跑就是结束屏那条路,由它自己的闸门管
  if (opts.nodeRunning) {
    return `「${opts.title}」此刻正在运行 —— 重做要先把它停下来。` +
      `在树上选中它按 x 取消,取消完再按 r。`
  }
  return undefined
}
