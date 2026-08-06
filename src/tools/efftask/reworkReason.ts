/**
 * **这一轮为什么在重做** —— 一个从已有记录派生出来的问句,不是新状态。
 *
 * ## 用户报的是什么
 *
 * 「重拟和重做时,其原因没有列清楚,不知道啥原因导致的。」
 *
 * 意见本身**一直都在传**:方案返工带累积评审意见(`planFeedbackPrompt`)、执行返工带
 * 验收的累积账、判决侧带「你自己前几轮提过什么」(`reviewRepeatNotice`)。
 * 缺的是**给人看的那一面**:树上一个节点从 EXECUTING 退回去重做时,屏幕上一个字都不说,
 * 而详情页里那两段「评审记录 / 验收记录」要按回车才看得到,并且是流水账 —— 它回答
 * 「历史上都提过什么」,不回答「**此刻**这一轮是被谁打回来的」。
 *
 * ## 为什么是派生而不是一个字段
 *
 * 存一个 `node.reworkReason` 就要维护它:每一处 `commit()`、每一次跳过/强制通过/重做都得
 * 记得清它,而这个仓库已经为「一个只在某些路径上被清掉的一次性标记」付过三次学费
 * (`failedAt` 过期、`skipPhase` 残留、`forcePass` 跨轮生效)。这里的每一样东西
 * (reviewLog / acceptLog / status)都是已经有人维护的真相,派生出来的东西不会过期。
 *
 * ## 判据:只看**当前那一关**的账
 *
 * 按 `node.status` 决定读哪个 log(和 redo.ts 的 `STATUS_PHASE` 同一张表):分析/质疑修复
 * 读 `reviewLog`,其余读 `acceptLog`。**不跨关兜底** —— 一个方案被打回过一次、现在正常执行
 * 的节点,跨关兜底会让树上挂着「方案评审未通过」,而那件事早就解决了。
 *
 * ## 方案侧现在只可能读到**老运行**的账
 *
 * 质疑修复和测试修复都不再做裁决(记录里 `synthesized.pass` 恒为 true),所以
 * `lastFailing` 在这两关上永远找不到东西 —— 新运行里,「被打回」只会来自验收 / 集成验收 /
 * 评分。这不需要额外的判据:判据本来就是「有没有一条没通过的记录」,而不是「这一关叫什么」。
 * 老 node.md 里那些真实发生过的评审否决照旧读得出来,那是对的。
 */
import { PHASE_LABEL } from './types.js'
import type { PhaseName, RoundtableRecord, TaskNode } from './types.js'

/** 树行上那一句的长度上限。整行还要放标题、状态、耗时。 */
const REASON_BUDGET = 60

export interface ReworkReason {
  /** 打回它的是哪一关。 */
  step: PhaseName
  /** 那一关**已经判过**几轮(= 接下来这一轮的序号 - 1)。 */
  rounds: number
  /** 判决原文(未截断)。 */
  why: string
}

/**
 * 这个节点当前处在哪一关 —— 和 `redo.ts` 的 `STATUS_PHASE` 同一张表的**收窄版**:
 * 这里只需要分成「方案侧」和「执行侧」两条账。
 */
function laneOf(node: TaskNode): 'plan' | 'exec' {
  switch (node.status) {
    case 'CREATED':
    case 'PLANNING':
    case 'PLAN_REVIEW':
      return 'plan'
    default:
      // BLOCKED 的节点看它**倒在哪一步**。failedAt 只由 commit() 写,而且只写节点自己的
      // 失败(被牵连阻断的那条路刻意不记)—— 所以拿不到它时按执行侧读是安全的:
      // 方案侧的账本来就只有 reviewLog 一条,读不到就什么都不说。
      if (node.status === 'BLOCKED' && (node.failedAt === 'PLANNING' || node.failedAt === 'PLAN_REVIEW' || node.failedAt === 'CREATED')) {
        return 'plan'
      }
      return 'exec'
  }
}

/** 从后往前找第一条**没通过**的记录。 */
function lastFailing(log: readonly RoundtableRecord[]): RoundtableRecord | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    if (!log[i]!.synthesized.pass) return log[i]
  }
  return undefined
}

/**
 * 这个节点此刻这一轮是被谁、因为什么打回来的。没有返工就是 `undefined`。
 */
export function reworkReason(node: TaskNode): ReworkReason | undefined {
  const lane = laneOf(node)
  const log = lane === 'plan' ? node.reviewLog : node.acceptLog
  const rec = lastFailing(log ?? [])
  if (!rec) return undefined
  const why = (rec.synthesized.blockingSummary || '').trim()
  // 空理由**不当作没有返工** —— 「被打回了但没人说为什么」本身就是要告诉用户的事,
  // 而返回 undefined 会让它和「根本没返工」在屏幕上长得一模一样。
  return {
    // 老 node.md 里没有 step:验收侧省略即验收(见 RoundtableRecord.step 的注释),
    // 方案侧那条账只可能来自质疑讨论。
    step: rec.step ?? (lane === 'plan' ? 'review' : 'accept'),
    rounds: rec.round,
    why: why || '(该轮没有留下具体意见)',
  }
}

/**
 * 树行上的紧凑标记:`↻2`。没返工时是空串。
 *
 * 数的是**这个节点一共被打回过几次**(四条计数相加),不是当前这一关的轮次 —— 树行上
 * 这一格回答的是「这个任务折腾了几趟」,而具体是哪一关折腾的由下面那行和详情页回答。
 */
export function reworkMarker(node: TaskNode): string {
  const it = node.iteration
  if (!it) return ''
  const n = (it.planReview ?? 0) + (it.acceptance ?? 0) + (it.integration ?? 0) + (it.scoring ?? 0)
  return n > 0 ? ` ↻${n}` : ''
}

/** 一行话:`第 2 轮验收未通过:…`。没返工时是空串。 */
export function reworkLine(node: TaskNode, budget = REASON_BUDGET): string {
  const r = reworkReason(node)
  if (!r) return ''
  const head = `第 ${r.rounds} 轮${PHASE_LABEL[r.step]}未通过:`
  const room = Math.max(10, budget - Array.from(head).length)
  const cps = Array.from(r.why.replace(/\s+/g, ' '))
  return head + (cps.length > room ? `${cps.slice(0, room).join('')}…` : cps.join(''))
}
