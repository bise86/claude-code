import { formatSize } from './cleanupWorktrees.js'
import type { BuildWipeOutcome } from './buildOutputs.js'

/**
 * 「合并完成即清构建产物」的 **run 级账**。
 *
 * ## 为什么必须有这么一份东西
 *
 * 这一路是**自动的、不可逆的**删除,而它刻意不往 `execStatus` 上写(那个字段会被喂进之后
 * 每一次验收/集成验收的提示词,每节点一句会把它撑成流水账 —— `worktreePool` 为逐任务合并
 * 定过同一条规矩)。两条规矩合起来的后果是:**一次真实的删除对用户完全不可见**。
 * 而「静默清理和静默截断是同一类毛病」是这个仓库反复在修的那一条。
 *
 * 所以统计**汇总**在这里,一行摆进收口屏。
 *
 * ## 三件必须分开记的事
 *
 *  1. **清掉了多少** —— 这个功能的全部卖点;
 *  2. **量不到大小的有几个** —— 有一个量不到,总数就是「至少」而不是「共」。
 *     编一个 0 出来,是拿一个假数字去换用户对整块统计的信任(`formatSize` 为同一条规矩存在);
 *  3. **嵌套 git 仓库被跳过了哪些** —— `git clean` 对它静默跳过而**退出码仍是 0**(实测)。
 *     不单独记的话,屏幕会说「已回收 22 GB」而那 22 GB 原地不动。这一条要指名道姓,
 *     因为用户能做的事(自己去看那个 vendored checkout)只有知道路径才做得了。
 */
export interface BuildWipeTally {
  /** 真的清过东西的节点数(清出来是空的不算)。 */
  nodes: number
  /** 被删掉的顶层条目总数。 */
  entries: number
  freedKb: number
  /** 有没有条目量不到大小 —— 有就只能说「至少」。 */
  sizeKnown: boolean
  /** 被 git 静默跳过的嵌套仓库(去重,带节点标题好让人找得到)。 */
  skippedRepos: { title: string; path: string }[]
  /** 清理本身失败的节点。不影响判决,但要说。 */
  failures: { title: string; why: string }[]
}

export function emptyBuildWipeTally(): BuildWipeTally {
  return { nodes: 0, entries: 0, freedKb: 0, sizeKnown: true, skippedRepos: [], failures: [] }
}

/**
 * 收一次结果。**就地累加**(调用点在编排器的回调里,一次运行一份账)。
 *
 * `sizeKnown` 是**与**下来的:一个量不到的条目就足以让总数变成「至少」。
 * 反过来写(有一个量到了就算知道)会让屏幕上那个数字看起来是全量的。
 */
export function noteBuildWipe(
  tally: BuildWipeTally, e: { title: string; outcome: BuildWipeOutcome },
): BuildWipeTally {
  const o = e.outcome
  if (o.error !== undefined) {
    tally.failures.push({ title: e.title, why: o.error })
    // 失败也可能已经删掉了一部分,所以下面照旧结算 —— 不 return。
  }
  if (o.removed.length > 0) {
    tally.nodes += 1
    tally.entries += o.removed.length
    tally.freedKb += o.freedKb
    if (!o.sizeKnown) tally.sizeKnown = false
  }
  for (const r of o.skippedRepos) {
    if (!tally.skippedRepos.some(x => x.path === r)) tally.skippedRepos.push({ title: e.title, path: r })
  }
  return tally
}

/**
 * 收口屏上的那几行。**是数据,不是 JSX** —— 屏幕上到底承诺了什么要能被一条断言钉住。
 *
 * 一条都没清时**一个字都不印**:印「已回收 0 处」读起来像一次成功的空操作,而真实的意思是
 * 「这一趟没有任何构建产物可清」——那不值得占一行(`cleanupResultLines` 为同一条规矩写过)。
 * 但**跳过的嵌套仓库和失败要照印** —— 那两条恰恰是「你以为清了而其实没清」的来源。
 */
export function buildWipeLines(tally: BuildWipeTally): string[] {
  const out: string[] = []
  if (tally.nodes > 0) {
    const size = tally.sizeKnown
      ? `,腾出 ${formatSize(tally.freedKb)}`
      : tally.freedKb > 0 ? `,至少腾出 ${formatSize(tally.freedKb)}` : '(量不到大小)'
    out.push(
      `任务完成即回收:已清掉 ${tally.nodes} 个任务工作区里的 ${tally.entries} 项构建产物${size}。`,
    )
    // 代价要和收益写在一起,而不是让用户下次重做时才发现。
    out.push('  它们是被 .gitignore 忽略的产物,不含任何交付物;重做这些任务会全量重编。')
  }
  for (const r of tally.skippedRepos) {
    // 指名道姓:用户能做的事只有知道路径才做得了。
    out.push(`⚠ ${r.title}:${r.path} 是一个嵌套的 git 仓库,git 跳过了它 —— 那部分空间没有被回收。`)
  }
  for (const f of tally.failures) out.push(`⚠ ${f.title}:构建产物没清掉(${f.why})`)
  return out
}
