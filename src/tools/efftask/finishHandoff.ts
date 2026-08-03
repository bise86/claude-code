// src/tools/efftask/finishHandoff.ts
//
// 跑完之后**把产出送回当前目录**。
//
// 用户原话:「任务完后,在隔离环境产出的代码和目录,并且提交成功了,要在当前目录下有对应的
// 存在。」
//
// 在这之前:隔离运行的产出全部落在 `efftask/<runId>` 集成分支上,用户的检出一个字节都不动,
// done 视图印的是「本次改动已合并到分支 X(N 个提交),**你的工作区未被改动**」+ 几行要手敲
// 的 git 命令。收口关口(合并/推送/保留/丢弃)**只在 `--resume` 路径上出现** —— 同一次会话
// 里跑完是直接进 done 视图。也就是说:正常跑一趟,合并这件事永远不会发生。
//
// ## 为什么是「自动合并」而不是「跑完弹关口」
//
// 弹关口这条路评审用真渲染量过,有三个当场就能踩到的坑,而且都发生在用户完全没准备的时刻:
//  - `ConfirmHandoff` 的默认项是**合并回当前分支**,它的 useInput 没有 isActive、也没有
//    「已决定」闩。用户正在运行视图里按回车逛任务树,编排恰好在这一刻结束 —— 同一下回车
//    落到刚挂上的关口上,`git merge` 就在他的检出里跑了,他连那一屏都没看清;
//  - 两下快回车 = 两个并发 `git merge` 打同一个 index(仓库为「三下回车起了三个编排器」
//    已经付过一次学费,那里的解法是一个 `rootDecided` 闩);
//  - run 被阻断时它更糟:关口不认 `r`/`R`/`s`/`f`,用户想重做只能先按 Esc,而 Esc 那条路
//    会把待收口记录**划掉**(`keep` 也走「成功就清 pendingHandoff」)。
//
// 所以这里只做一件明确的事:**跑完了、而且干净,就合;否则不合、并且说清为什么**。
// 关口原样留在 `--resume` 那条路上(用户清理完工作区再进来,四个选项一个不少)。
import type { PendingHandoff } from './types.js'
import {
  mergeLeftovers, runHandoffChoice, trackedChanges,
  type ConflictResolver, type GitFn, type HandoffResult,
} from './handoffActions.js'

export type FinishPlan =
  /** 没有待收口的东西:非隔离运行(产出本来就在当前目录里),或者零提交。 */
  | { action: 'none' }
  | { action: 'merge' }
  /** 不自动合,并且把原因带给用户 —— 屏幕上不说 = 他以为代码已经在手上了。 */
  | { action: 'skip'; why: string; followUps: string[] }

/**
 * 该不该自动合并。**纯函数**,判据全在这一处。
 *
 * `dirty` 由调用方探(一次 `git status --porcelain`)。这里不自己探是因为
 * `runHandoffChoice('merge')` 里已经有一次同样的检查 —— 两份判据里最松的那一份会成为
 * 实际生效的那一份,所以这一层只负责「决定」,真正的守门仍然在那边(见 finishHandoff)。
 */
export function planFinish(
  h: PendingHandoff | undefined,
  opts: { dirty: boolean; dirtyDetail?: string },
): FinishPlan {
  if (!h || h.commits <= 0) return { action: 'none' }
  /**
   * 没跑完的树不自动合。
   *
   * `PendingHandoff.outcome` 存在的全部理由就是「别邀请用户合并一棵没做完的树」——
   * 自动替他合更不行:半成品会带着一次真实的 merge commit 落到他的分支上。
   */
  if (h.outcome !== 'completed') {
    return {
      action: 'skip',
      why: `本次运行没有正常完成(${h.reason ? h.reason : '被阻断或中止'}),没有自动合并`,
      followUps: [
        `产出仍在分支 ${h.branch}(${h.commits} 个提交),什么都没丢`,
        `修完之后 /et --resume 会弹出「合并/推送/保留/丢弃」,也可以直接 git merge ${h.branch}`,
      ],
    }
  }
  if (opts.dirty) {
    return {
      action: 'skip',
      // 「已跟踪文件的改动」—— 措辞要准:未跟踪文件**不**算(见 trackedChanges),
      // 而说成「未提交的改动」会让一个只有 `?? scratch.txt` 的用户去找他没有的东西。
      why: '你的工作区有未提交的改动(已跟踪文件),没有自动合并 —— 你的改动不该被一次合并卷进来',
      followUps: [
        ...(opts.dirtyDetail ? [`未提交:${opts.dirtyDetail}`] : []),
        `先提交或 stash,再 git merge ${h.branch}(或 /et --resume 走收口关口)`,
      ],
    }
  }
  return { action: 'merge' }
}

export interface FinishOutcome {
  /** 产出此刻**在当前目录里**吗。done 视图那句话按它写 —— 写错就是一句可照做的假话。 */
  merged: boolean
  /**
   * 这次自动合并**把用户的工作区留在了半合并状态**(冲突标记 + MERGE_HEAD)。
   *
   * 必须单独交出来:done 视图上那句「你的工作区未被改动」在这种情形下是假话,而这一路是
   * **自动**发生的 —— 用户没按任何键就被丢进了冲突态,屏幕至少要说清他现在在哪。
   */
  conflicted?: boolean
  /** 给用户看的一行 + 后续动作。`none` 时没有(屏幕上照旧只印分支说明)。 */
  result?: HandoffResult
}

/**
 * 收口:能合就合,合不了就如实说。**永不抛** —— 见 runOrchestrator 那个 finally 的注释:
 * 那一段里每一句都是被保护的,一个逃出去的异常会让 `setPhase('done')` 永不执行,
 * 界面永久停在「运行中」而 Esc 毫无反应。
 */
export async function finishHandoff(deps: {
  handoff: PendingHandoff | undefined
  git: GitFn
  cwd: string
  /**
   * 自动合并撞上冲突时,派模型去解一次。不给就退回原来的行为(留下冲突现场)。
   *
   * 这一路**没有任何人按过键**,所以解不成时 `autoResolveMerge` 会把工作区 abort 回合并前
   * ——「自动发生的事必须能自动收拾干净」比「把现场留给用户」更重要,因为用户压根不知道
   * 刚才发生过一次合并。
   */
  resolveConflict?: ConflictResolver
}): Promise<FinishOutcome> {
  const { handoff: h, git, cwd } = deps
  try {
    if (!h || h.commits <= 0) return { merged: false }
    // **只看被跟踪的改动**,和 runHandoffChoice 用同一个函数 —— 两份判据里最松的那一份
    // 会成为实际生效的那一份,而这里更严的那一份曾经让整个功能一次也没发生过
    // (`/et` 自己写的 `.claude/efftask/` 就是一条 `?? .claude/`)。见 trackedChanges。
    /**
     * **detached HEAD 不自动合并。**
     *
     * 那是唯一一个「合成功了、代码却不在任何分支上」的路径:merge 会成功、文件会到位,
     * 而 `main` 还停在旧提交,下一次 checkout 就把这一趟的产出留在了 reflog 里。
     * 而屏幕上写的是「已合并回你**当前的分支**」—— 一句这时候不成立的话。
     *
     * 判据用 `symbolic-ref --quiet HEAD`:detached 时它非 0 退出,不吐东西。
     */
    if (h.outcome === 'completed') {
      const head = await git(['symbolic-ref', '--quiet', 'HEAD'], cwd)
      if (head.code !== 0) {
        return {
          merged: false,
          result: {
            ok: false,
            message: '当前是 detached HEAD(不在任何分支上),没有自动合并 —— 合进去的东西不会留在任何分支上',
            followUps: [
              `先 git switch 到目标分支,再 git merge ${h.branch}`,
              `产出仍在分支 ${h.branch}(${h.commits} 个提交),什么都没丢`,
            ],
          },
        }
      }
    }
    const dirty = h.outcome === 'completed' ? await trackedChanges(git, cwd) : { dirty: false }
    const plan = planFinish(h, { dirty: dirty.dirty, dirtyDetail: dirty.detail })
    if (plan.action === 'none') return { merged: false }
    if (plan.action === 'skip') {
      return { merged: false, result: { ok: false, message: plan.why, followUps: plan.followUps } }
    }
    // 走**现成的**那一份:脏树复查、失败时如实报告、分支原样保留全在里面,而收口关口
    // 按的也是同一个函数。两份实现迟早给出两种答案。
    const res = await runHandoffChoice('merge', h, git, cwd, deps.resolveConflict)
    if (res.ok) return { merged: true, result: res }
    // 失败了 —— 工作区被留在半合并状态了吗?这一问必须由**我们**来问:这一路是自动
    // 发生的,而屏幕上那句「你的工作区未被改动」得按答案改口。
    const conflicted = (await mergeLeftovers(git, cwd)).length > 0
    return { merged: false, conflicted, result: res }
  } catch (e) {
    return {
      merged: false,
      result: {
        ok: false,
        message: `自动合并没能执行: ${e instanceof Error ? e.message : String(e)}`,
        followUps: h ? [`产出仍在分支 ${h.branch},可以手工 git merge ${h.branch}`] : [],
      },
    }
  }
}
