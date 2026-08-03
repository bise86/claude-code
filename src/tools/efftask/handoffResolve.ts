// src/tools/efftask/handoffResolve.ts
//
// 收口那一次合并撞上冲突时,**派谁去解**。
//
// 节点合并进集成分支的冲突走的是 pipeline 里的 §8 那条路(在节点自己的隔离工作区里解、
// 解完重跑验收、每次运行两次机会)。这里是另一条:集成分支合回**用户自己的分支**,发生在
// 所有节点都已验收通过之后,现场在用户的检出里。
//
// 两条路刻意不共用实现,因为环境不一样:
//  - 那边有节点、有角色名册、有实时窗口,解完之后还有一整席验收在等着复核;
//  - 这边只有一个目录和一条分支名。**复核由 git 做**,不由模型自称 —— 见
//    `autoResolveMerge`:未合并路径、暂存区里的冲突标记、commit 是否成功,一条不过就
//    `git merge --abort` 还原。
//
// 所以这个文件只负责一件事:把「有冲突要解」翻译成一次带写工具的模型调用。
import type { ConflictResolver } from './handoffActions.js'
import type { RunAgentFn } from './roundtable.js'
import type { TaskNode } from './types.js'

/**
 * `RunAgentFn` 要一个节点,而收口时并没有「哪个节点」这回事 —— 合的是整条集成分支。
 *
 * 传根节点:它是这次运行的目标本身,提示词里的目标/方案就是用户最初要的那件事,这恰好
 * 是解冲突时最该知道的上下文。拿不到根节点(理论上不会,run 一定有 root)就不接线,
 * 让收口退回「留下冲突现场」的老行为 —— 宁可不自动,也不拿一个假节点去凑。
 */
export function makeHandoffConflictResolver(deps: {
  runAgent: RunAgentFn
  node: TaskNode
  signal: AbortSignal
}): ConflictResolver {
  return async ({ files, branch, cwd }) => {
    await deps.runAgent({
      // execute —— 这一趟要真的改文件,工具档由 phase 决定(见 makeRunAgentFn)。
      phase: 'execute',
      node: deps.node,
      // 不挂角色:收口不属于任何一个环节的席位,挂上去会让日志里出现一个从没被派过的员工。
      role: null,
      system: 'execute',
      prompt:
        `这是一次**收口合并**:本次运行的产出都在分支 ${JSON.stringify(branch)} 上,` +
        `刚才把它合并回你所在的这个工作目录时产生了冲突。\n` +
        `当前目录里就是冲突现场(带 <<<<<<< / >>>>>>> 标记)。\n` +
        `请解决冲突,保留双方的意图,不要简单丢弃任何一边。\n` +
        // 不许提交:提交由 autoResolveMerge 在**复核之后**做。模型自己 commit 的话,
        // 那道复核就永远晚了一步 —— 它要检查的东西已经进历史了。
        `解决后 git add 冲突文件即可,**不要 commit**,也不要 git merge --abort。\n` +
        `冲突文件:\n${files.map(f => '- ' + JSON.stringify(f)).join('\n')}\n` +
        `注意:这里是用户自己的工作目录,不是隔离工作区 —— 不要动与本次冲突无关的文件。`,
      cwd,
      signal: deps.signal,
    })
  }
}
