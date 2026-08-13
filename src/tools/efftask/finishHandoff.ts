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
  /**
   * 合。`warn` 是**合了之后仍然要说的话** —— 目前只有一句:这一趟有降级放行的节点。
   * 见下面那段注释:它从「拒绝合」降成「合了但要说」,因为拒绝在逐任务合并之后已经
   * 拦不住任何东西了。
   */
  | { action: 'merge'; warn?: string[] }
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
  /**
   * 降级放行:**从「拒绝合」降成「合了,但要说」。**
   *
   * 原来的理由今天仍然对(它值得原样记下来):这一趟确实跑完了,但「跑完」和「通过了」
   * 不是一回事 —— 降级放行的节点是判决没过、按迭代上限放行的,而把没人判通过的代码不声
   * 不响落进用户的分支是这套东西能造成的最坏后果,并且不可逆。
   *
   * 但逐任务合并之后,这道闸已经**拦不住任何东西**——降级放行的节点在它通过验收
   * 的那一刻就已经合进集成分支、并被 `intoTrunk` 送进用户的分支了(`pipeline.ts` 的
   * `acceptDegraded` → `mergeAndRelease` → `commitAndMerge` → `intoTrunk`)。而集成分支是
   * **累积**的:想把某个节点排除在用户分支之外,唯一办法是从此再也不合 —— 那等于取消
   * 这个功能。
   *
   * 于是「跑得干净就自动合、脏了就拒绝」在这里变成一条**任意**的规则:同一份代码,
   * 工作区当时干净就已经在用户分支上了,当时脏就被这道闸拦下 —— 拦下的不是风险,只是
   * 运气。留着它反而更糟:一个已经把产出全收下的用户,会看到一句「没有自动合并」。
   *
   * 所以改成合 + 一句必须说出口的话。信息一个字没少(那才是这道闸真正的价值),
   * 而屏幕不再对着一份已经在用户手上的产出说它没被合进来。
   */
  const warn = (h.degradedNodes ?? 0) > 0
    ? [
      `⚠ 本次运行有 ${h.degradedNodes} 个节点是**降级放行**的(判决未通过,按迭代上限放行),它们的产出也在这次合并里`,
      '先看 run.md 的「降级放行」那几条:它们是判决当时提出、没人落实的问题',
    ]
    : undefined
  /**
   * 「分支开发」那一档在这里**不存在了**(用户:「不要什么分支开发,只有主干开发」)。
   * 它和逐任务合并互斥:一个每完成一个子任务就把集成分支合回当前分支的运行,没有办法
   * 同时承诺「产出留在分支上不动你的目录」。走到这里的一定是「该合但还没合上」。
   */
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
  return warn ? { action: 'merge', warn } : { action: 'merge' }
}

/**
 * `git push` 当前分支。
 *
 * **`-u` + 显式分支名**,不是裸 `git push`:裸推送的行为取决于 `push.default` 和有没有
 * upstream —— 一个没设过 upstream 的分支上,裸推送直接失败,而用户打开的开关叫「自动推送」。
 * 分支名从 `symbolic-ref` 拿(这条路径已经确认过不是 detached HEAD)。
 */
async function pushCurrent(git: GitFn, cwd: string): Promise<{ ok: boolean; message: string }> {
  const head = await git(['symbolic-ref', '--short', '--quiet', 'HEAD'], cwd)
  const branch = head.stdout.trim()
  if (head.code !== 0 || branch.length === 0) {
    return { ok: false, message: '自动推送没能执行:取不到当前分支名' }
  }
  return pushBranch(git, cwd, branch)
}

/** `git push -u origin <branch>`。失败时**把 git 的原话带出来** —— 它通常就是修法本身。 */
async function pushBranch(git: GitFn, cwd: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const res = await git(['push', '-u', 'origin', branch], cwd)
  if (res.code === 0) return { ok: true, message: `已推送 ${branch} 到 origin` }
  const why = (res.stderr || res.stdout).trim()
  return { ok: false, message: `自动推送 ${branch} 失败${why ? `: ${why}` : ''}(合并本身不受影响)` }
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
  /**
   * 自动推送发生过吗、结果如何。没开这个开关时**整个字段缺席**(不是一条「未推送」)——
   * 一个从没打开过推送的人不需要每次跑完都被告知没推送。
   *
   * 推送失败**不影响 `merged`**:合并已经发生了,把它说成没发生才是假话。两件事分开报。
   */
  push?: { ok: boolean; message: string }
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
  /**
   * **「先同步主干、再迭代解冲突」那条路。** 给了就用它来做收口那一次合并。
   *
   * 收口和 `m` 键面对的是**同一件事**(集成分支 → 用户当前分支),而在这之前只有 `m`
   * 走了新机制:收口仍在用户自己的检出里 `git merge`,撞冲突只能 abort ——
   * 于是「跑完把产出送回你的目录」在最容易撞冲突的那一次上失效,而那正是一整趟运行的结尾。
   *
   * 可选:测试和不带池子的调用方不给它,那时逐字退回老实现。
   */
  syncTrunkMerge?: () => Promise<{ ok: boolean; message: string; followUps?: string[] }>
  /** 关口上打开的自动推送。默认关 —— 推送是对外动作,必须由人打开。 */
  autoPush?: boolean
  /**
   * 这一趟已经落在用户当前分支上的提交数(`worktreePool.handoff().trunkLanded`,从 git 现算)。
   *
   * 主干开发的**正常结局**是 `commits === 0`:每个子任务完成时就合过了,收口时已经没有
   * 待合的提交。少了这个字段,那条早退会顺手把自动推送也吃掉 —— 一个打开了推送开关的人,
   * 在最常见的那条路径上一次也推不出去。
   */
  trunkLanded?: number
  /**
   * 这一趟的结局。**只有 `completed` 才允许上面那条早退去推远程。**
   *
   * 验收实测:早退原来一个前提都不查,而它恰恰是最常见的那条路径(逐任务合并让
   * `commits === 0` → 连 `pendingHandoff` 都不挂)。于是一个**被阻断或被取消**的 run
   * 只要中途合过一次,就会把半成品推到远程 —— 而本文件自己把推送定义为「对外动作、
   * 不可撤销」,下面那条 skip 分支也逐字写着「合不了的那几档一律不推」。
   *
   * 缺省(不传)= 不推:宁可少推一次,也不能替用户做一次他没批准的对外动作。
   */
  outcome?: 'completed' | 'blocked' | 'cancelled'
}): Promise<FinishOutcome> {
  const { handoff: h, git, cwd } = deps
  try {
    if (!h || h.commits <= 0) {
      // 没有待收口的东西。但如果产出是逐任务合进去的,推送这件事照样该发生。
      const push = deps.autoPush === true && (deps.trunkLanded ?? 0) > 0 && deps.outcome === 'completed'
        ? await pushCurrent(git, cwd)
        : undefined
      return { merged: false, ...(push ? { push } : {}) }
    }
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
      /**
       * 合不上的那几档(没跑完、脏树、detached、有降级放行)**一律不推**:那些是
       * 「有问题,先别动」,而推送是对外的、不可撤销的。
       *
       * 这里原来还有一档「用户选了保留分支 → 照样推那条集成分支」—— 随分支开发一起去掉了。
       */
      return { merged: false, result: { ok: false, message: plan.why, followUps: plan.followUps } }
    }
    // 走**现成的**那一份:脏树复查、失败时如实报告、分支原样保留全在里面,而收口关口
    // 按的也是同一个函数。两份实现迟早给出两种答案。
    const res = await runHandoffChoice(
      'merge', h, git, cwd, deps.resolveConflict,
      // 给了就走「先同步主干」那条 —— 方向反过来之后,用户的检出一次三方合并都不会经历。
      deps.syncTrunkMerge ? async () => {
        const r = await deps.syncTrunkMerge!()
        return { ok: r.ok, message: r.message, ...(r.followUps ? { followUps: r.followUps } : {}) }
      } : undefined,
    )
    if (res.ok) {
      // 合成功了才推当前分支 —— 没合的话,推上去的是一份不含本次产出的分支。
      const push = deps.autoPush === true ? await pushCurrent(git, cwd) : undefined
      // 降级放行那句话跟着**成功**这条路走(它现在是「合了但要说」,不是「不合」)。
      const withWarn = plan.warn ? { ...res, followUps: [...plan.warn, ...(res.followUps ?? [])] } : res
      return { merged: true, result: withWarn, ...(push ? { push } : {}) }
    }
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
