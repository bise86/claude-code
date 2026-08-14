import { integrationBranch, worktreeBranch, worktreeSlug } from './worktreeId.js'
import { pinAndClear } from './snapshot.js'
import { EFFTASK_INTERNAL_PATHS, wipeBuildOutputsAt, type BuildWipeOutcome } from './buildOutputs.js'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { TaskNode } from './types.js'

/**
 * One git invocation. Injected so the pool is unit-testable without a repo, and so the
 * integration tests can point it at a throwaway one.
 *
 * `cwd` matters: a worktree's index and HEAD are per-worktree, so almost every call here has
 * to say WHERE it runs. Never assume the process cwd.
 */
export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface Lease {
  path: string
  branch: string
  gitRoot: string
}

/**
 * 一次「集成分支 → 用户当前分支」的同步结果。
 *
 * `advanced` 只在真的合进去了时为真;`reason` 是没合的原因(脏树 / detached / 冲突),
 * 它必须能一路走到 node.md ——「产出应该在当前目录里」是这个功能的全部承诺,而没做到
 * 的时候用户唯一能察觉的方式就是有人告诉他。
 */
export type TrunkSync =
  | { advanced: true }
  | { advanced: false; reason?: string; conflicted?: boolean }

export type MergeResult =
  /**
   * `pinned`:抹掉之前把那些内容钉成的耐久 ref(见 `snapshot.ts`)。
   *
   * `cleaned` 只留下**名字**,而名字救不回任何东西。这条 ref 才是「被抹掉的东西还能取回来」
   * 那句话的兑现物 —— 少了它,`cleaned` 就只是一份讣告。
   *
   * `cleaned`:合并失败后从集成工作区里被 `reset --hard` / `clean -fd` 抹掉的路径。
   *
   * 必须报出去。那个目录是产品**主动告诉用户可以复用**的(启动关口上印着「集成工作区
   * (下次运行会复用)」),在里面被抹掉的东西不能无声消失 —— 静默清理和静默截断是同一类
   * 毛病。空/缺省 = 什么都没清。
   *
   * `trunk`:紧跟着这次合并做的「合回用户当前分支」。只在 `merged: true` 时出现。
   */
  | { ok: true; merged: boolean; cleaned?: string[]; pinned?: string; trunk?: TrunkSync }
  | { ok: false; kind: 'conflict'; files: string[]; cleaned?: string[]; pinned?: string }
  | { ok: false; kind: 'infra'; message: string; cleaned?: string[]; pinned?: string }

/**
 * Serialises an async section. `acquire` and `merge` each need one: measured, 5 concurrent
 * `git worktree add` produced `could not lock config file .git/config` and one worktree that
 * was never created, and 4 concurrent merges into one checkout produced rc=128
 * `cannot lock ref 'HEAD'` and rc=2 alongside a single winner.
 */
/** 盘上有没有这个路径。缺席**和**探不明白都算「没有」—— 这里的调用方拿它当动手的前提。 */
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Chain onto BOTH settle paths so one rejection cannot poison every later section.
    const run = tail.then(fn, fn) as Promise<T>
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export interface WorktreePoolDeps {
  runId: string
  gitRoot: string
  git: GitRunner
  /** Where per-node worktrees live. */
  worktreeRoot: string
  /**
   * 目录占用(KB)。只给 `wipeBuildOutputs` 用,好让「腾出多少」是量出来的。
   *
   * **可选,而且缺席时不许编 0** —— `du` 在 Windows / 精简容器里可能根本不存在,
   * 那时屏幕说「大小未知」比说 0 诚实(`CleanupDeps.dirSizeKb` 为同一件事写过)。
   */
  dirSizeKb?: (path: string) => Promise<number | undefined>
}

/**
 * Per-node git worktrees, merged back into one integration branch.
 *
 * Every rule below was measured against real git in a throwaway repo, because three rounds of
 * plan review were overturned by assumptions about these primitives. The measurements are
 * quoted at each rule so the next reader does not have to re-derive them.
 */
/**
 * The pool's public shape.
 *
 * Derived from the factory rather than hand-written: pipeline.ts imported a WorktreePool
 * type that this module never exported, and import-type is ERASED by bun — so the suite
 * stayed green while tsc would have said TS2305, and this repo has no typecheck to say it.
 */
export type WorktreePool = ReturnType<typeof createWorktreePool>

export function createWorktreePool(deps: WorktreePoolDeps) {
  const { runId, gitRoot, git, worktreeRoot, dirSizeKb } = deps
  const intBranch = integrationBranch(runId)

  /**
   * **抹掉集成工作区之前,把里面的未提交内容钉成一条耐久 ref。**
   *
   * 这条路(合并失败 → `reset --hard` + `clean -fd`)是**自动跑**的主路径,而它此前
   * 对那棵共享的树零保护:`cleaned` 只报名字,内容没了。`m` 键那边已经在动手前钉一次,
   * 自动跑这边一次都没有 —— 同一个原语接一条路,「通用」就是半句话。
   *
   * 只读那棵树:`git stash create` 实测不动工作区、不动 index;树干净时连 ref 都不写,
   * 正常路径上零成本。**失败不影响合并本身** —— 钉不住是坏消息,不是拒绝干活的理由,
   * 但它要能被看见,所以返回 ref 名(拿不到就 undefined,由调用方照实上屏)。
   */
  const pinBeforeWipe = async (): Promise<string | undefined> => {
    try {
      // `pinAndClear` 而不是 `pinSnapshot`:下一行就要 clean -fd,而 `stash create` 拿不到
      // 未跟踪文件 —— 而那正是这棵树上最常见的一份丢失(席位在里面跑过构建)。
      const res = await pinAndClear({ git, gitRoot, runId }, intPath)
      return res.ref
    } catch {
      // 钉快照永远不许把一次合并变成一次崩溃。
      return undefined
    }
  }
  /**
   * node id → the files git itself reported as conflicted by that node's local merge.
   *
   * The marker scan is restricted to these. Matching marker TEXT across everything the branch
   * contributes is not a conflict predicate: a node that legitimately ships a CONFLICTS.md
   * documenting <<<<<<< — and correctly resolves a real conflict in a different file — was
   * refused permanently, and the card's "清理掉残留标记并提交" then had the author delete their
   * own documentation to get unblocked. Measured: same resolution, opposite verdicts, decided
   * only by an unrelated file.
   *
   * Empty after a restart, which is correct: on resume the human resolved by hand and the
   * unmerged-paths guard is what protects that path.
   */
  const conflictedByNode = new Map<string, string[]>()
  const intPath = `${worktreeRoot}/integration`
  const acquireLock = mutex()
  const mergeLock = mutex()

  const slugFor = (node: TaskNode): string => worktreeSlug(runId, node.id)
  const branchFor = (node: TaskNode): string => worktreeBranch(slugFor(node))
  const pathFor = (node: TaskNode): string => `${worktreeRoot}/${slugFor(node)}`

  /** Is this branch's tip already contained in the integration branch? */
  async function isMerged(branch: string): Promise<boolean> {
    const r = await git(['merge-base', '--is-ancestor', branch, intBranch], gitRoot)
    return r.code === 0
  }

  /**
   * 这一趟往用户分支上合成功了几次、以及**至今仍然成立**的跳过原因。
   *
   * `trunkSkips` 在合成功时清空:集成分支是累积的,所以一次成功的合并会把此前被挡住的
   * 全部一并带过去 —— 留着那句「有东西没送到你的目录」就成了收口屏上一句已经不成立的
   * 警告(验收实测:任务 1 被脏树挡掉、任务 2..20 全部成功,两句话同时印在屏幕上)。
   */
  let trunkMerged = 0
  let trunkSkips: string[] = []
  const noteSkip = (why: string): void => { if (!trunkSkips.includes(why)) trunkSkips.push(why) }
  /**
   * 上一次成功合进用户分支时,集成分支的 tip。
   *
   * 用来认出**用户自己把这一趟的提交回退掉了**(`git reset --hard`)。不认的话下一个子任务
   * 完成时会原样把它们合回去 —— 而 README 卖的正是「合并只发生在你自己的仓库里,随时
   * `git reset` 得回来」。认出来之后**本进程内不再自动合**:他已经用最明确的方式说过
   * 不要了,再合一次是在跟他较劲。
   *
   * 刻意只存在内存里:它是「这个进程观察到的用户意图」,而 `--resume` 之后那个意图无从
   * 谈起(中间隔着任意长的时间和任意多次手工操作),把它当成持久事实反而会让恢复出来的
   * run 永远不敢合。
   */
  let lastMergedTip: string | undefined
  let userRewound = false
  /**
   * 这一趟的**起点**。`init()` 建集成分支时把当时的 HEAD 钉在这条 ref 上。
   *
   * 它存在的唯一理由是**「已经落在你分支上的提交数」必须能从 git 现算出来**,而不能靠
   * 内存计数器:逐任务合并把 `HEAD..集成分支` 在正常路径上打成 0,而 `--resume` 是一个
   * 新进程 = 新的池子 = 计数器归零 —— 验收实测,恢复之后收口屏印的是
   * 「本次没有产生任何改动;分支与起点相同」,而用户目录里躺着三个子任务的产出;
   * 打开了自动推送的人在这条路上也一次都推不出去。
   *
   * 用 `refs/efftask/<runId>/base` 而不是分支:它不该出现在 `git branch` 里。
   * 老 run(这条 ref 之前的)拿不到它,那时**退回内存计数器**,行为与引入它之前相同。
   */
  const baseRef = `refs/efftask/${runId}/base`

  /**
   * **一个子任务合进集成分支之后,立刻把集成分支合回用户当前的分支。**
   *
   * 用户原话:「完成一个单独子任务就要去合并,不要等所有任务完成再合并。所以也不要什么
   * 分支开发,只有主干开发。」在这之前,集成分支只在**整趟跑完**时由 `finishHandoff` 合
   * 一次 —— 中途用户的目录里什么都没有,而一个跑三小时的 run 就是三小时的黑箱。
   *
   * ## 判据(每一条都对应一个「不这么判就会说假话」的形态)
   *
   * 1. **在用户自己的检出里合**(`gitRoot`),不是在集成工作区里。目标分支就是他 checkout
   *    着的那条,git 不允许同一条分支被两个工作树同时占用,而 `--force` 绕过去的后果更坏:
   *    另一棵树把分支推进之后,用户那棵树的 HEAD 跟着走而工作区文件没变,`git status` 会
   *    把整批产出显示成「未提交的反向改动」。
   * 2. **脏树不合**,判据只看**已跟踪**改动(`diff --quiet` + `--cached`)—— 未跟踪不算:
   *    `/et` 自己就在用户检出里写 `.claude/efftask/`,按 `status --porcelain` 判会让这个
   *    功能在正常仓库里一次都不发生(收口那一侧为同一件事付过学费)。
   * 3. **detached HEAD 不合**:那是唯一一条「合成功了、代码却不在任何分支上」的路。
   * 4. **用户正停在集成分支上**(少见但合法:他自己 checkout 过去看)= 不需要合,也不能
   *    对自己 merge。
   * 5. **只要合并没成,就把工作区还原回去**,判据**不是**「有没有冲突文件」。验收实测:
   *    `commit-msg` / `pre-merge-commit` 钩子拒绝、以及 `rerere.autoupdate` 自动暂存了
   *    解决之后,`git merge` 都是**非零退出 + 零个 unmerged path** —— 上一版在这条路上
   *    只记一句原因就 return,于是 MERGE_HEAD 和整批产出留在用户的检出里,而屏幕逐字
   *    写着「你的工作区未被改动」。之后每个子任务还会把 /et 自己造成的半合并状态**报成
   *    用户的脏改动**,并劝他「先提交或 stash」——照做等于替我们提交一次我们自己都没敢
   *    提交的合并。所以:失败 → 无条件 abort → **再量一次**确认真的干净。
   * 6. **`--no-verify`**:这次合并是编排器发起的、必然要发生的动作,而用户的 commit-msg
   *    钩子(commitlint 之类)对一条 `Merge branch 'efftask/...'` 的消息必然拒绝 ——
   *    确定性失败,重试永远不会收敛。`commitAndMerge` 早就为同一个理由带着它。
   *
   * 失败**不影响节点的判决**:产出已经在集成分支上了,收口那一次(以及下一个子任务完成
   * 时的这一次)还会再试。所以返回值是「情况说明」,不是成败。
   */
  async function intoTrunk(): Promise<TrunkSync> {
    const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], gitRoot)
    const branch = head.stdout.trim()
    if (head.code !== 0 || branch.length === 0) {
      const why = '当前是 detached HEAD(不在任何分支上),没有把产出合回你的目录'
      noteSkip(why)
      return { advanced: false, reason: why }
    }
    if (branch === intBranch) {
      /**
       * 他把主检出切到了集成分支上(要 `--ignore-other-worktrees` 才切得过去,因为集成
       * 工作区正占着它)。**这不是「已经在他目录里」**:分支引用是共享的,集成工作区把它
       * 推进之后,他那棵树的 HEAD 跟着走而文件没动 —— `git status` 会把整批产出显示成
       * 一串待提交的**删除**。验收实测过这个形态。合并对自己没有意义,但必须说出来。
       */
      const why = `你的主检出当前停在集成分支 ${intBranch} 上(而集成工作区也占着它)——` +
        `没有把产出合回你的目录,而且你的 git status 可能把这一趟的产出显示成一串删除。` +
        `请切回你自己的分支(git switch <你的分支>)。`
      noteSkip(why)
      return { advanced: false, reason: why }
    }
    if (userRewound) {
      const why = `你在本次运行期间回退过已经合进来的提交,之后不再自动合并 —— ` +
        `产出仍在集成分支 ${intBranch} 上,需要的话自己 git merge ${intBranch}`
      noteSkip(why)
      return { advanced: false, reason: why }
    }
    /**
     * 用户把合进去的东西**回退掉了**吗。放在「已经是最新的」那一问之前:reset 之后
     * 集成分支当然不再被 HEAD 包含,所以两问的顺序决定了这一格是「该合」还是「他不要」。
     */
    if (lastMergedTip !== undefined) {
      const kept = await git(['merge-base', '--is-ancestor', lastMergedTip, 'HEAD'], gitRoot)
      if (kept.code !== 0) {
        userRewound = true
        const why = `你在本次运行期间回退过已经合进来的提交(git reset 之类),之后不再自动合并 —— ` +
          `产出仍在集成分支 ${intBranch} 上,需要的话自己 git merge ${intBranch}`
        noteSkip(why)
        return { advanced: false, reason: why }
      }
    }
    const contained = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], gitRoot)
    if (contained.code === 0) return { advanced: false } // 已经是最新的,没什么可合
    /**
     * **脏树不再前置挡 —— 让 git 去判。**
     *
     * 这里原来是「只要用户目录里有任何一个已跟踪文件是脏的,这一跳整个跳过」,理由写的是
     * 「你的改动不该被一次合并卷进来」。真 git 上量过,那个担心不成立:
     *
     *  · 合并碰不到那几个脏文件 → 直接成功,他的改动**毫发无损**(merge 提交只含已提交
     *    的内容,不会卷进未提交的东西);
     *  · 真要覆盖 → git 当场拒绝、**一个字节不动**、不留 `MERGE_HEAD`,于是下面那条失败
     *    路径的 `restored` 直接为真,并且会把 git 的原话(含文件名)如实带出来。
     *
     * git 的保护是**逐文件**的,这道闸是「一处脏就全不合」。跑机实测(qianbase-xtp
     * run 001):3 个不相干的脏文件把 607 个提交全堵在集成分支上 —— 每个子任务完成时
     * 都印一句「已合入集成分支,但还没送到你的分支」,跑了几百次。用户原话:
     * 「这个不应该自动合进来吗」。
     *
     * **拿掉闸的前提是下面那条失败路径已经安全**,而它本来就是:判据用「有没有
     * `MERGE_HEAD`」而不是「有没有 UU 行」,无条件 abort,再复核现场还在不在。
     */
    const merge = await git(['merge', '--no-edit', '--no-verify', intBranch], gitRoot)
    if (merge.code === 0) {
      trunkMerged++
      // 送到了 = 此前那些「有东西没送到你的目录」全部不再成立(集成分支是累积的)。
      trunkSkips = []
      const tip = await git(['rev-parse', intBranch], gitRoot)
      if (tip.code === 0) lastMergedTip = tip.stdout.trim()
      /**
       * **反向也要通一次:主干上多出来的东西要带回集成分支。**
       *
       * 上面那次 merge 通常是快进(集成分支就是从主干拉的),但用户在 run 跑着的时候
       * 完全可能自己提交 / pull —— 那时它是一次真的三方合并,合完主干**领先**集成分支。
       * 不把这一步补上的话,「任务开始就先从主干同步代码」在这种情况下是假的:之后每个
       * 节点的 `acquire` 都基于集成分支,永远看不见用户自己那几笔,而合并冲突正是在
       * 那里攒出来的。
       *
       * `--ff-only`:集成分支此刻是主干的祖先(主干 = 集成 + 用户那几笔的合并),所以
       * 快进一定成立;万一不成立,说明有人动过集成分支 —— 那就**什么都不做**,节点继续
       * 用老基线,而不是在共享的集成工作区里造一次没人预料的合并。
       */
      const behind = await git(['merge-base', '--is-ancestor', branch, intBranch], gitRoot)
      if (behind.code !== 0) await git(['merge', '--ff-only', branch], intPath)
      return { advanced: true }
    }
    /**
     * 没合上。**先看现场,再无条件收拾,再复核**。
     *
     * `core.quotepath=false`:否则中文/非 ASCII 路径在这里是 `"\344\270\255…"`,而这串
     * 东西会一路进 node.md 和收口屏给人看(`cleaned` 那条为同一件事带过这个开关)。
     */
    const conflicts = async (): Promise<string[]> => (
      await git(['-c', 'core.quotepath=false', 'status', '--porcelain'], gitRoot)
    ).stdout.split('\n').filter(l => /^(UU|AA|DU|UD|AU|UA|DD) /.test(l)).map(l => l.slice(3).trim()).filter(Boolean)
    const left = await conflicts()
    /**
     * **无条件 abort**,不看有没有冲突文件。判据用「有没有 MERGE_HEAD」而不是「有没有
     * UU 行」:钩子拒绝和 rerere 自动暂存都会留下一个**没有任何 unmerged path 的**
     * MERGE_HEAD,而那正是上一版把用户丢在半合并态的那条路。
     *
     * 没有合并在进行时 `merge --abort` 会非零退出并抱怨「没有可中止的合并」——所以成败
     * 不看它的退出码,看**收拾完之后现场还在不在**。
     */
    const inMerge = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)
    if (inMerge.code === 0) await git(['merge', '--abort'], gitRoot)
    const stillInMerge = (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)).code === 0
    const stillConflicted = (await conflicts()).length > 0
    const restored = !stillInMerge && !stillConflicted
    /**
     * git 的原话要带出来,而且**不能只取第一行**:实测「would be overwritten by merge」
     * 那一类的第一行是 `error: The following untracked working tree files would be
     * overwritten by merge:` —— 一句没有宾语的话,文件名全在后面几行。
     */
    const detail = (merge.stderr || merge.stdout).trim().split('\n')
      .map(l => l.trim()).filter(Boolean).slice(0, 4).join(' / ')
    /**
     * **「已暂存」那一格:git 的保护不再是逐文件的。**
     *
     * 真 git 实测(评审席):快进时索引脏不影响合并;而**真三方合并**(用户在 run 期间
     * 自己提交过)时,索引里**任何一个**文件脏就整个被拒(`code 2` +
     * `Merge with strategy ort failed.`),而它点名的那个文件**这次合并根本没碰**。
     *
     * 所以这一句不能只把 git 的原话转出去:用户会去看一个和本次合并无关的文件名,
     * 而真正要他做的是把**索引**清空(提交或 `git stash`)。
     */
    const stagedBlocked = detail.includes('would be overwritten by merge')
      && detail.includes('strategy ort failed')
    const what = stagedBlocked
      ? `没成功:你的**索引里有已暂存的改动**,而这次是一次真三方合并 —— git 在这种情况下` +
        `会整个拒绝,并且点名的文件可能和本次合并无关(它点的是:${detail})。` +
        `先 git commit 或 git stash 把索引清空,产出会在下一个子任务完成时自动送过来`
      : left.length > 0
      ? `撞了冲突(${left.slice(0, 3).join('、')}${left.length > 3 ? ` 等 ${left.length} 个` : ''})`
      : `没成功:${detail || '未知原因'}`
    const why = restored
      ? `把产出合回 ${branch} ${what},已还原你的工作区 —— 产出留在集成分支上,之后会再试`
      : `把产出合回 ${branch} ${what},**而且自动还原失败**:你的工作区里现在留着一次未完成的合并` +
        `(解完 git commit,或 git merge --abort 回到合并前)`
    noteSkip(why)
    return { advanced: false, reason: why, conflicted: left.length > 0 || !restored }
  }

  /**
   * `init()` 自愈时动过的东西,给收口/关口读。
   *
   * 挪走一个孤儿工作树目录是**盘上的真实变化**(实测那一个 15G),让出集成分支同理 ——
   * 静默做掉和静默截断是同一类毛病。
   */
  const healNotes: string[] = []
  const noteHeal = (notes: string[]): void => {
    for (const n of notes) if (!healNotes.includes(n)) healNotes.push(n)
  }

  /**
   * `git worktree list --porcelain` 的记录。
   *
   * 逐块解析而不是 `git worktree list` 的人类格式:后者把路径、sha、分支挤在一行并按
   * 列对齐,**路径里有空格**时切不开 —— 而 `worktreeRoot` 来自用户的 cwd。
   */
  async function listWorktrees(): Promise<{ path: string; branch?: string }[]> {
    const r = await git(['worktree', 'list', '--porcelain'], gitRoot)
    if (r.code !== 0) return []
    const out: { path: string; branch?: string }[] = []
    let cur: { path: string; branch?: string } | undefined
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length).trim() }; out.push(cur) }
      else if (line.startsWith('branch ') && cur) cur.branch = line.slice('branch '.length).trim()
    }
    return out
  }

  /**
   * 让 `git worktree add <intPath> <intBranch>` 有第二次机会 —— **只动我们自己的东西**。
   *
   * 两种成因各自都会让隔离**永久**建不起来(每次 `--resume` 原样重演),而两种的补救都
   * 不该由用户手工做,因为屏幕上只有一句 git 的 `already exists`,它不说要删什么。
   *
   * 一、**孤儿目录**:`intPath` 在盘上,但 git 的登记项没了(仓库被移动过 + 上面那句
   *    `worktree prune`)。**挪走,不删** —— 那个目录可能有 git 此刻读不出来的内容,而这
   *    个仓库的规矩是盘上的东西不许静默消失。挪到隔壁并把新名字说出来,让人自己处置。
   *
   * 二、**集成分支被另一棵树占着**:git 不许两棵工作树占同一条分支。只在那棵树
   *    **是我们自己建的**(路径在 `worktreeRoot` 底下、且不是用户的检出)时才 `--detach`
   *    让出来;别人的检出一律不碰 —— 那可能正是用户此刻在里面干活的地方。
   *    `--detach` 而不是删除:那棵树上可能有还没合走的提交,detach 之后它们仍在原 sha 上。
   */
  async function healIntegrationSlot(): Promise<{ changed: boolean; notes: string[] }> {
    const notes: string[] = []
    let changed = false

    const trees = await listWorktrees()
    const known = new Set(trees.map(t => t.path))

    // 一、孤儿目录。判据是「盘上有 + git 不认」,两条都要:只判存在会在正常的重复
    // 调用上把一棵**好的**工作树挪走(init 是可重入的,上面那句 rev-parse 失败也可能
    // 只是一次瞬时的 git 错误)。
    if (!known.has(intPath) && await exists(intPath)) {
      const parked = `${intPath}.orphan`
      const dest = await freeName(parked)
      try {
        await rename(intPath, dest)
        changed = true
        notes.push(`把 git 已不认识的孤儿目录挪到了 ${dest}(没有删除;确认无用后请自行清理)`)
      } catch (e) {
        notes.push(`孤儿目录 ${intPath} 挪不走(${e instanceof Error ? e.message : String(e)})`)
      }
    }

    // 二、分支被占。**排在孤儿之后**:挪走目录之后 add 仍会因为这条失败,而两条一起
    // 治才只需要一次重试 —— 分两轮的话第一轮的重试会白白付一次 checkout 的钱。
    const holder = trees.find(t => t.branch === `refs/heads/${intBranch}` && t.path !== intPath)
    if (holder) {
      const ours = holder.path.startsWith(`${worktreeRoot}/`) && holder.path !== gitRoot
      if (!ours) {
        notes.push(`集成分支 ${intBranch} 被 ${holder.path} 占着,那不是本次运行建的工作树 —— 没有动它`)
      } else {
        const det = await git(['checkout', '--detach'], holder.path)
        if (det.code === 0) {
          changed = true
          notes.push(`集成分支 ${intBranch} 被自建工作树 ${holder.path} 占着,已让它切到 detached HEAD`)
        } else {
          notes.push(`集成分支 ${intBranch} 被 ${holder.path} 占着,让不出来:${det.stderr.trim()}`)
        }
      }
    }
    return { changed, notes }
  }

/**
   * 「分支名已存在」之后的一次诊断 + 让路。**返回 changed=false 就绝不重置。**
   *
   * 两种成因,和 `healIntegrationSlot` 一一对应,只是降到节点这一层:
   *
   * 一、**残留分支**:上一趟(或用户手工 `rm -rf .efftask-worktrees/`)把工作区目录清了,
   *    分支没删。分支里**已经全部合进集成分支**时它就是个空壳,重置零损失。
   *    **没合进去的时候先存一条 salvage 分支再重置** —— 那是 `acquire` 上面那一整段
   *    「commits the executor made itself that never reached the integration branch」
   *    防的同一件事,只是那段防的是复用目录这条路,这里是重建目录这条路。
   *    **存不下来就整条放弃**(宁可这个节点报错,不可静默丢掉一次执行的产出)。
   *
   * 二、**分支被另一棵工作树占着**:只在那棵树**是我们自己建的**时才让它 detach。
   *    别人的检出一律不碰 —— 那可能正是用户此刻在里面干活的地方。
   *
   * 判据都跑在 `gitRoot` 上:`path` 这时候按定义还不存在。
   */
  async function reclaimNodeBranch(
    node: TaskNode, branch: string, path: string,
  ): Promise<{ changed: boolean; notes: string[] }> {
    // 「这条分支确实存在」由调用点建立(它就是靠这个决定 `-b` 还是 `-B` 的)——
    // 这里不再自己判一次:那会是一个永远为真的条件,而这个仓库为不可达分支付过账。
    const notes: string[] = []
    /**
     * **先 prune。** 目录被清掉、而 `.git/worktrees/<slug>` 登记项还在,是这一类残留
     * **最常见**的形状 —— 跑机实测(10.10.20.13 / etcd3):32 条登记项里 31 条是 prunable。
     * 那种状态下分支被一棵**并不存在**的工作树占着,git 拒绝一切动作(`branch -D` 说
     * 「无法删除检出于 … 的分支」,`worktree add` 说 already used),而 `checkout --detach`
     * 也没地方跑 —— 下面那段让路逻辑对它完全无能为力。
     *
     * prune 只清「目录已经不在」的登记项,不碰任何还在的工作树。放在 `acquireLock` 里,
     * 不会和并发的 `worktree add` 抢 `.git/config`(见 mutex 那段实测)。
     */
    await git(['worktree', 'prune'], gitRoot)
    const contained = await git(['merge-base', '--is-ancestor', branch, intBranch], gitRoot)
    if (contained.code !== 0) {
      // 名字要唯一 —— `branch -f` 会把上一次的抢救打到零个 ref 上,见 salvageRefFor。
      const salvage = await salvageRefFor(node, branch)
      if (salvage === undefined) {
        notes.push(`残留分支 ${branch} 上有没合进集成分支的提交,而抢救 ref 的名字全被占满了 —— 没有重置它`)
        return { changed: false, notes }
      }
      const saved = await git(['branch', '-f', salvage, branch], gitRoot)
      if (saved.code !== 0) {
        notes.push(`残留分支 ${branch} 上有没合进集成分支的提交,而它存不进 ${salvage}(${saved.stderr.trim()})—— 没有重置它`)
        return { changed: false, notes }
      }
      notes.push(`残留分支 ${branch} 上有没合进集成分支的提交,已先存到 ${salvage} 再重置`)
    } else {
      notes.push(`复用残留分支 ${branch}(它的提交都已在集成分支上,重置零损失)`)
    }

    const holder = (await listWorktrees()).find(t => t.branch === `refs/heads/${branch}` && t.path !== path)
    if (holder) {
      const ours = holder.path.startsWith(`${worktreeRoot}/`) && holder.path !== gitRoot
      if (!ours) {
        notes.push(`而 ${branch} 还被 ${holder.path} 占着,那不是本次运行建的工作树 —— 没有动它`)
        return { changed: false, notes }
      }
      const det = await git(['checkout', '--detach'], holder.path)
      if (det.code !== 0) {
        notes.push(`而 ${branch} 被自建工作树 ${holder.path} 占着,让不出来:${det.stderr.trim()}`)
        return { changed: false, notes }
      }
      notes.push(`并让占着它的自建工作树 ${holder.path} 切到 detached HEAD`)
    }
    return { changed: true, notes }
  }

  /**
   * 这个节点这一次抢救该写到**哪条 ref** 上。
   *
   * ## `branch -f` 会静默毁掉上一次的抢救
   *
   * 抢救分支名是 `efftask/<runId>/salvage/<hash(nodeId)>` —— **不随时间变**。同一个节点被
   * 抢救第二次(重做 → 再执行 → 再重做,或者 `acquire` 复用目录那条路走了两遍),
   * `branch -f` 把它直接指到新 tip 上。评审在真 git 上量过后果:
   *
   *     $ git branch -f efftask/r1/salvage/aaa efftask/r1/node/aaa   # 第二次
   *     $ git for-each-ref --contains <上一版的 sha> | wc -l
   *     0
   *
   * 上一版落在**零个 ref** 上,只剩 branch reflog —— 而收口报告和 `m` 键都走
   * `for-each-ref`,它们永远看不见它,gc 之后就真没了。这直接违反这个模块自己写了三遍的
   * 那句「宁可保留垃圾,不可删掉工作」。
   *
   * ## 判据:同一条内容不占两个名字
   *
   * 已有的那条**已经被新 tip 包含**时(最常见:上一次抢救之后又提交了几笔),重用它零损失
   * —— 每次都换新名字会在盘上堆一串互为祖先的 ref,而收口屏要把它们逐条念给用户听。
   * 不是祖先才换名字,`-2`、`-3`…… 和 `freeName` 同一条思路(治过一次的仓库会治第二次)。
   *
   * 全都占满 → 返回 undefined,调用方**必须拒绝**这次重置(宁可这个节点报错)。
   */
  async function salvageRefFor(node: TaskNode, tip: string): Promise<string | undefined> {
    const base = `efftask/${runId}/salvage/${slugFor(node)}`
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? base : `${base}-${i}`
      const has = await git(['rev-parse', '--verify', '--quiet', name], gitRoot)
      if (has.code !== 0) return name
      // 已有的那条被新 tip 包含 = 重用它零损失。
      const contained = await git(['merge-base', '--is-ancestor', name, tip], gitRoot)
      if (contained.code === 0) return name
    }
    return undefined
  }

  /** 第一个还没被占用的名字。`.orphan`、`.orphan-2`、…… —— 治过一次的仓库会治第二次。 */
  async function freeName(base: string): Promise<string> {
    if (!await exists(base)) return base
    for (let i = 2; i < 100; i++) if (!await exists(`${base}-${i}`)) return `${base}-${i}`
    return `${base}-${100}`
  }

  return {
    /**
     * Create the integration branch and a dedicated worktree to merge in.
     *
     * The merge worktree is dedicated on purpose: merging in the user's own checkout drags
     * their uncommitted edits onto the integration branch and leaves conflict markers in
     * THEIR working tree.
     */
    async init(): Promise<{ ok: true } | { ok: false; reason: string }> {
      const head = await git(['rev-parse', 'HEAD'], gitRoot)
      if (head.code !== 0) return { ok: false, reason: `不是 git 仓库或没有提交: ${head.stderr.trim()}` }
      // RE-ENTRANT. `branch -f` was unconditional, which is catastrophic on resume:
      // measured, after a routine `git worktree prune` init returned ok:true while resetting
      // the integration branch back to HEAD — every already-merged node's commit ended up in
      // ZERO refs (release had already deleted their branches) and showed up under
      // `git fsck --unreachable`. An existing integration branch is the run's accumulated
      // work; never move it.
      const existing = await git(['rev-parse', '--verify', '--quiet', intBranch], gitRoot)
      if (existing.code !== 0) {
        const br = await git(['branch', intBranch, 'HEAD'], gitRoot)
        if (br.code !== 0) return { ok: false, reason: `无法创建集成分支: ${br.stderr.trim()}` }
        /**
         * 起点钉在一条 ref 上 —— **只在真的新建集成分支这一刻**。
         *
         * 放在 if 外面就等于每次 `--resume` 都把起点挪到当前 HEAD,而那时 HEAD 已经含有
         * 前几趟合进去的产出:`base..集成分支` 会算成 0,收口屏于是对着一堆真实产出说
         * 「本次没有产生任何改动」—— 正是这条 ref 要修的那句假话,换个方向再犯一次。
         * 失败不致命(下面退回内存计数器),所以不检查返回码。
         */
        await git(['update-ref', baseRef, head.stdout.trim()], gitRoot)
      }
      // The worktree may already be registered (resume) or may have been pruned out from
      // under us (gc). Prune stale registrations first, then add only if it is really absent.
      // Keep our scratch out of the user's `git status`. .git/info/exclude is the right
      // place: it is per-clone and NOT a tracked file, so we are not editing something the
      // user committed. Without it, .efftask-worktrees/ shows as untracked forever.
      /**
       * `.claude/efftask/` 也要排除,**而它不是「顺手」**。
       *
       * 那是 run 目录(任务树的 md 镜像),`/et` 在**用户的检出里**从第一帧就开始写它。
       * 只排除 `.efftask-worktrees/` 的后果是每一趟运行结束时 `git status` 里都躺着一条
       * `?? .claude/` —— 而收口那条判据(工作区干净才自动合并)会被它挡住,于是
       * 「跑完把产出送回当前目录」在一个没有 gitignore 掉 `.claude/` 的普通仓库里
       * 一次也不会发生。判据那一侧已经改成只看被跟踪的改动(见 handoffActions.trackedChanges),
       * 这里是第二道:让用户的 `git status` 也干净。
       *
       * **两条一起写**,不是二选一:判据那一侧治的是「合不合」,这一侧治的是
       * 「用户看到的 status 里有没有我们留下的垃圾」。
       *
       * linked worktree 里 `.git` 是**文件**,`mkdir(.git/info)` 会 ENOTDIR —— 整段被
       * catch 吞掉,那种检出上两条都写不进去。所以判据那一侧不能依赖这里。
       */
      try {
        const info = `${gitRoot}/.git/info`
        await mkdir(info, { recursive: true })
        const excl = `${info}/exclude`
        const cur = await readFile(excl, 'utf-8').catch(() => '')
        /**
         * 从 `EFFTASK_INTERNAL_PATHS` 派生,**不写字面量**:`buildOutputs` 那一侧靠同一份
         * 名单决定「清构建产物时不许碰哪些」。各写一份的话,哪天这里加了第三条,
         * 那边就会开始删它 —— 而它是**用户的任务记录**。
         */
        /**
         * **构建产物也写进来 —— 这是 2 681 个文件进版本库的真正来源。**
         *
         * 跑机 .30 实测:master 上被跟踪的构建产物 **2 608 个文件 / 52.86 GiB**,
         * 而项目的 `.gitignore` 里一条相关规则都没有。来历是每个执行者自己建一个
         * `.cargo-target-<名字>/` 当 cargo 的 target 目录,然后 `commitAndMerge` 的
         * `add -A` 照单全收 —— `clean -X` 也清不到它们(它们从来没被忽略过)。
         * 后果是集成分支合回 master 时逐个 add/add 撞冲突,643 个提交卡了好几天。
         *
         * 写 `info/exclude` 而不是改用户的 `.gitignore`:后者是**被跟踪的文件**,
         * 替他改并提交是越权(上面那两条为同一个理由写在这里)。而 `info/exclude`
         * 对 linked worktree 同样生效(`buildOutputs.ts` 文件头第二条实测),
         * 所以节点工作区里的 `add -A` 也会跳过它们 —— 正是需要的那一侧。
         *
         * **只写产物,不写 `target/` 之外的通配**:这份名单里的每一条都要能说出
         * 「它只可能是构建产物」。`.cargo-target-*` / `.cargo-task-*` / `*-cargo-target/`
         * 是 efftask 执行者自己造的命名;`target/` 是 cargo 默认;`*.rlib`/`*.rmeta`
         * 是编译产物的扩展名。**不写 `.cargo-*`** —— 那会命中 `.cargo/config.toml`,
         * 一个真会被提交的配置文件。
         */
        const BUILD_OUTPUT_EXCLUDES: readonly string[] = [
          '.cargo-target-*/', '.cargo-task-*/', '*-cargo-target/', 'target/',
          '*-cargo-check.log', '*-check.short.log', '.cargo-check-*.log', '*.rlib', '*.rmeta',
        ]
        const want = [...EFFTASK_INTERNAL_PATHS.map(p => `${p}/`), ...BUILD_OUTPUT_EXCLUDES]
          .filter(p => !cur.includes(p))
        if (want.length > 0) {
          await writeFile(excl, `${cur}${cur.endsWith('\n') || cur === '' ? '' : '\n'}${want.join('\n')}\n`)
        }
      } catch { /* cosmetic only — never fail a run over it */ }
      const registered = await git(['rev-parse', '--git-dir'], intPath)
      if (registered.code !== 0) {
        await git(['worktree', 'prune'], gitRoot)
        let add = await git(['worktree', 'add', intPath, intBranch], gitRoot)
        /**
         * **`worktree add` 失败一次不等于这一趟没有隔离。**
         *
         * 实测事故(跑机 qianbase-xtp,run 001):`.efftask-worktrees/integration` 是一个
         * **git 已经不认识的目录** —— 它的 `.git` 文件指向 `.git/worktrees/integration`,
         * 而那个登记项已经不在了。于是 `rev-parse --git-dir` 128、`worktree prune` 不删
         * 目录(prune 删的是登记项,不是工作树)、`worktree add` 报 `already exists`。
         * 池子建不起来 → `serialiseExecute` 为真 → **20 个并发退化成 1**,而且**每一次
         * `--resume` 都会原样再来一遍**:没有任何一条路径会去动那个目录。用户看到的是
         * 「44 个 READY,只有一个在跑」,连着好几天。
         *
         * 更要命的是这个状态**是 init() 自己造的**:上面那句 `worktree prune` 在仓库被
         * 移动过之后(登记的绝对路径失效)会把登记项清掉,而工作树目录原地留着。
         *
         * 所以失败之后诊断一次再重试一次。两种成因**都只动我们自己的东西**,判据写在
         * 各自的 helper 里 —— 拿不准就不动,把原因说清楚让人来处理。
         */
        if (add.code !== 0) {
          const healed = await healIntegrationSlot()
          if (healed.changed) add = await git(['worktree', 'add', intPath, intBranch], gitRoot)
          if (add.code !== 0) {
            // 诊断要跟着失败一起走出去。原来只有 git 那句 `already exists`,而它不说
            // 「那个目录是个孤儿」,更不说「分支被另一棵树占着」—— 用户读完仍然不知道
            // 要删什么。
            const notes = healed.notes.length > 0 ? ` (已尝试:${healed.notes.join(';')})` : ''
            return { ok: false, reason: `无法创建集成工作区: ${add.stderr.trim()}${notes}` }
          }
          if (healed.notes.length > 0) noteHeal(healed.notes)
        }
      }
      return { ok: true }
    },

    /**
     * `init()` 自愈时挪走/让出了什么。**必须报出去** —— 挪走一个 15G 的孤儿目录是盘上的
     * 真实变化,静默做掉和静默截断是同一类毛病。空 = 什么都没治。
     */
    healNotes(): readonly string[] { return healNotes },

    /**
     * A worktree for this node, based on the integration branch's CURRENT state so a node
     * sees what its dependencies already merged.
     *
     * Reuse (resume) is the subtle path. The worktree is already ON this node's branch, so
     * committing and then `checkout -B <same branch> <integration>` RESETS that branch off the
     * salvage commit: measured `git for-each-ref --contains <salvage>` = 0 refs and the file
     * gone from the tree. The salvage therefore goes to a DISTINCT ref first (measured: 1 ref
     * afterwards), honouring 宁可保留垃圾,不可删掉工作.
     */
    acquire(node: TaskNode): Promise<Lease | { error: string }> {
      return acquireLock(async () => {
        const path = pathFor(node)
        const branch = branchFor(node)
        const exists = await git(['rev-parse', '--git-dir'], path)
        if (exists.code === 0) {
          // Salvage covers BOTH shapes, because `checkout -B` below destroys both:
          //   - uncommitted edits (obvious), and
          //   - commits the executor made itself that never reached the integration branch.
          // Measured on the second shape: after checkout -B the commit was in 0 refs and the
          // file was gone from the tree — the very orphaning this branch exists to prevent,
          // reached through the input a dirty-only check ignores.
          const dirty = await git(['status', '--porcelain', '--ignored'], path)
          const unmerged = !(await isMerged(branch))
          if ((dirty.code === 0 && dirty.stdout.trim().length > 0) || unmerged) {
            await git(['add', '-A'], path)
            // **不说「中断」**:这条路今天最常见的来源是分析/质疑讨论在这棵树里留下的
            // 散落文件(那两关也住在节点工作区里了),一次中断都没发生过。
            await git(['commit', '--no-verify', '-m', `efftask: 固化工作区残留 (${node.id})`], path)
            const sha = await git(['rev-parse', 'HEAD'], path)
            /**
             * **HEAD 已经被集成分支包含 = 没有任何东西需要抢救。**
             *
             * 脏的判据带 `--ignored`,所以「只有构建产物」的工作区(dist/、target/、
             * .direnv/)也会走进这一段 —— 而 `add -A` 不会暂存被忽略的文件,于是 commit
             * 什么都没提交(rc≠0),`rev-parse HEAD` 拿回来的就是集成分支的 tip 本身。
             * 无条件建分支的后果是一条**内容与集成分支逐字相同**的抢救分支,而收口报告
             * (`handoff().salvage`)会把它当作「这里抢救出了东西」念给用户听 —— 一句
             * 精确的假话,而用户据此去翻一条空分支。
             *
             * 分析/质疑讨论也在节点工作区里跑之后,这条路从「只在 --resume 上出现」变成了
             * 每个隔离节点的必经之路(方案席在自己的树里跑一次构建就够了),所以它从
             * 潜在瑕疵变成了常态噪音。
             *
             * 判据用 `merge-base --is-ancestor`,不是 `commit.code`:执行者自己提交过、
             * 而这一段的 commit 因此无事可做的那种形态(下面 335 行那个用例),同样只有
             * 「HEAD 是否已在集成分支里」答得对。
             */
            if (sha.code === 0) {
              const contained = await git(['merge-base', '--is-ancestor', 'HEAD', intBranch], path)
              if (contained.code !== 0) {
                // 名字要唯一。同一个节点走到这条路两次(重做 → 再执行 → 再重做)时,
                // `branch -f` 会把上一版打到零个 ref 上,而收口和 `m` 键都走
                // `for-each-ref` —— 它们永远看不见它。见 salvageRefFor。
                const tip = sha.stdout.trim()
                const ref = await salvageRefFor(node, tip)
                if (ref !== undefined) await git(['branch', '-f', ref, tip], gitRoot)
              }
            }
          }
        } else {
          /**
           * **目录不在了,分支还在** —— `-b` 是「新建分支」,而 `-f` 只强制**路径**,
           * 于是 git 报 `fatal: a branch named 'worktree-efftask-001-…' already exists`,
           * 这个节点**永久**起不来:分支名是 `hash(nodeId)`,不随时间变,重做走的是同一条路。
           *
           * 跑机实测(10.10.20.13 / qianbase-xtp,2026-08-11):154 条节点分支里 10 条
           * 处于这个形状(工作区目录被清掉了、分支没删),用户报「重做也一样失败」。
           * 和 `healIntegrationSlot` 是同一个病:池子清不掉自己留下的东西,而没有任何
           * 一条路径会去动它。
           */
          /**
           * **先看分支在不在,再决定 `-b` 还是 `-B`** —— 不是「失败之后再补救」。
           *
           * 补救式的写法要能分辨「add 是因为分支失败的」和「因为别的失败的」,而唯一的
           * 材料是 git 的报错文本 —— 那句话**随 locale 变**(跑机上逐字是
           * 「fatal: 一个分支名 'worktree-efftask-001-54b6ba01' 已经存在」)。
           * 按文本判会在中文机器上整条失效,而这个功能的现场恰恰就是那台机器。
           * 顺带也不会再对一次注定失败的 add 白白重置一遍分支。
           */
          const existing = await git(['rev-parse', '--verify', '--quiet', branch], gitRoot)
          let create = '-b'
          if (existing.code === 0) {
            const healed = await reclaimNodeBranch(node, branch, path)
            // `-B` = 有就重置。**只在 reclaim 说可以之后**用它:重置一条还带着没合走的
            // 提交的分支,正是上面那一整段 salvage 拼命在防的事。
            if (!healed.changed) {
              return { error: `无法创建工作区:${healed.notes.join(';') || `残留分支 ${branch} 拦着,而它动不得`}` }
            }
            noteHeal(healed.notes)
            create = '-B'
          }
          const add = await git(['worktree', 'add', '-f', create, branch, path, intBranch], gitRoot)
          if (add.code !== 0) return { error: `无法创建工作区: ${add.stderr.trim()}` }
          return { path, branch, gitRoot }
        }
        // Re-base the reused worktree onto the integration branch's current state.
        const co = await git(['checkout', '-B', branch, intBranch], path)
        if (co.code !== 0) return { error: `无法把工作区切到集成分支: ${co.stderr.trim()}` }
        return { path, branch, gitRoot }
      })
    },

    /**
     * Commit whatever the node produced and merge it into the integration branch.
     *
     * `merged: false` means there was genuinely nothing to merge, and it needs BOTH signals:
     * measured, an executor that committed its own work leaves `git diff --cached --quiet`
     * at rc=0 (nothing staged) while `merge-base --is-ancestor` says rc=1 (not merged). A
     * staged-only test therefore reports "no output" for a node that did real work, and the
     * integration branch silently loses it.
     *
     * The hook problem is solved by ORDER, not by parsing: hook rejection and
     * nothing-to-commit both exit 1 (measured), so we check the index FIRST. If something was
     * staged, a failing commit can only be a real failure.
     */
    commitAndMerge(node: TaskNode): Promise<MergeResult> {
      return mergeLock(async () => {
        const path = pathFor(node)
        const branch = branchFor(node)

        // REFUSE an unresolved merge. `git add -A` on a worktree with a live MERGE_HEAD marks
        // every conflicted path RESOLVED — with the <<<<<<< text still in it — and the commit
        // below then becomes a merge commit that fast-forwards straight onto the integration
        // branch. Measured: markers shipped, node ACCEPTED, nobody paged, and release() then
        // deleted the worktree because it was clean and merged. Blocking here is strictly
        // better: the work survives and a human is told.
        const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], path)
        const unmergedFiles = unmerged.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        if (unmergedFiles.length > 0) return { ok: false, kind: 'conflict', files: unmergedFiles }

        const add = await git(['add', '-A'], path)
        if (add.code !== 0) return { ok: false, kind: 'infra', message: `git add 失败: ${add.stderr.trim()}` }
        const staged = await git(['diff', '--cached', '--quiet'], path)
        const hasStaged = staged.code !== 0

        if (hasStaged) {
          const commit = await git(['commit', '--no-verify', '-m', `efftask: ${node.title}`], path)
          // We KNOW there was something staged, so any failure here is real — no exit-code
          // guessing. --no-verify because the user's pre-commit hook fires inside every agent
          // worktree (core.hooksPath is set in the SHARED config) and rejecting half-finished
          // agent output is deterministic: retrying it would never converge.
          if (commit.code !== 0) {
            return { ok: false, kind: 'infra', message: `提交失败: ${commit.stderr.trim() || commit.stdout.trim()}` }
          }
        }

        // AFTER the commit on purpose. Placed before it, this scanned a HEAD that did not
        // yet contain the round's work, so it matched nothing and the guard was decorative —
        // the test that "proved" it passed only because its fixture committed separately.
        // Refusing here is safe: the commit stays on the node branch, unmerged, and the
        // escalation hands the user a branch that still holds everything.
        // Markers can also arrive without an unmerged path — a resolver that edits the file by
        // hand, or one that "resolves" by leaving both sides in and committing. Scan what this
        // branch would BRING (its diff against the merge base), not just what is staged: an
        // earlier version checked only the index and a resolver that committed its markers
        // sailed straight through. Scanned by pattern rather than `diff --check`, which also
        // fires on trailing whitespace and would refuse perfectly good commits.
        // Gated on this branch actually having performed an integration merge. Conflict-marker
        // TEXT is not evidence of a conflict: a node whose deliverable is a README about
        // resolving merge conflicts, or any Markdown using a `=======` setext underline, trips
        // the pattern. Measured on a throwaway repo: 3 hits, and the node would have been
        // refused permanently while the card told the user to go resolve a conflict that does
        // not exist. A resolver that commits its markers, on the other hand, necessarily
        // produces a merge commit here — so gate on that and the false positive disappears
        // without losing the case the scan exists for.
        const mergeCommits = await git(['rev-list', '--merges', `${intBranch}..HEAD`], path)
        if (mergeCommits.stdout.trim().length > 0) {
          // Same helper the card reads, so the refusal and the card never name different
          // files. Reporting every file the branch touched listed two untouched files as
          // 冲突文件 on a real card.
          const marked = await this.markerFiles(node)
          if (marked.length > 0) return { ok: false, kind: 'conflict', files: marked }
        }

        /**
         * 没什么可合(节点分支已被集成分支包含,`--resume --retry-blocked` 打在一个其实
         * 已经合过的节点上就是这个形态)。**主干那一趟照样要跑**:集成分支上完全可能
         * 攒着前几次因为脏树/冲突没送出去的东西,而这里是一次现成的机会。
         */
        if (await isMerged(branch)) return { ok: true, merged: false, trunk: await intoTrunk() }

        const merge = await git(['merge', '--no-edit', branch], intPath)
        // 合进集成分支了 → **马上**把集成分支合回用户当前的分支。见 intoTrunk:
        // 「完成一个子任务就合一次」,不等整趟跑完。仍然在 mergeLock 里,所以两个节点的
        // 「合集成 + 合主干」不会交叉。
        if (await isMerged(branch)) return { ok: true, merged: true, trunk: await intoTrunk() }

        // Not merged. Distinguish a real conflict from infrastructure — an earlier design
        // reported every git failure as a conflict with a fabricated file list.
        const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], intPath)
        const files = conflicts.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        /**
         * 不是冲突的那一支:量一下这棵树到底脏在哪 —— **必须在 reset 之前**。
         *
         * 实测事故(跑机 run 001):方案席和两个评审席都 `cd .efftask-worktrees/integration`
         * 跑了 `devenv shell cargo check --workspace`,devenv 改写了**受跟踪的** devenv.lock;
         * 40 分钟后这个节点验收全过,合并却报
         * 「您对下列文件的本地修改将被合并操作覆盖:devenv.lock」——
         * 节点阻断,9 个兄弟全部「依赖阻断」,整个 run 死掉。
         *
         * 真冲突那一支不量:`status --porcelain` 那时列的是 UU 之类的冲突路径,把它们报成
         * 「被清掉的用户改动」是在说假话。
         */
        // `core.quotepath=false`:否则中文/非 ASCII 路径在这里是 `"\344\270\255..."`,
        // 而这串东西会一路进 node.md 给人看。
        const cleaned = files.length > 0
          ? []
          : (await git(['-c', 'core.quotepath=false', 'status', '--porcelain'], intPath)).stdout
            .split('\n').map(l => l.trim()).filter(Boolean)
        // Leave the integration worktree usable either way.
        //
        // On a genuine conflict MERGE_HEAD exists and `merge --abort` would also work. The
        // reason for reset+clean is the OTHER failure: measured, a lost merge race leaves a
        // staged entry with NO MERGE_HEAD, so abort reports "There is no merge to abort" and
        // the next attempt dies with "local changes would be overwritten" — the worktree
        // wedges permanently, and only reset --hard + clean -fd recovered it.
        //
        // NOT COVERED BY A TEST, and recorded rather than faked: the merge mutex above makes
        // that race unreachable within a run, so swapping this back to `merge --abort` leaves
        // the suite green. It is defence for a state the current design prevents — keep it,
        // but do not claim it is tested.
        /**
         * **抹掉之前先钉住。**
         *
         * 上面那句 `cleaned` 只留下**名字**,而名字救不回任何东西 —— 席位在这棵树里跑过
         * 构建、手工解过一半的冲突,下面这两句一过就一个字节都不剩。这条路是**自动跑**
         * 的主路径(`pipeline` 每个节点合一次),它此前对集成工作区零保护。
         *
         * `pinSnapshot` 只读那棵树(`git stash create` 实测不动工作区、不动 index),
         * 树干净时连 ref 都不写 —— 正常路径上零成本。它拿不到未跟踪文件,那一格由它自己
         * 如实报告(见 `snapshot.ts`)。
         */
        const pinned = await pinBeforeWipe()
        await git(['reset', '--hard'], intPath)
        await git(['clean', '-fd'], intPath)
        if (files.length > 0) return { ok: false, kind: 'conflict', files, ...(pinned ? { pinned } : {}) }
        /**
         * 洗完**重试一次**。
         *
         * 清理动作原来只有上面那两句,而它跑在合并失败**之后** —— 于是第一次合并必然撞上
         * 别人留下的脏东西,阻断;下一次运行反而是干净的。晚了整整一次合并。
         *
         * 为什么是「失败后洗+重试」而不是「合并前无条件洗」:intPath 是**共享**的,而
         * 集成验收就在里面开会(`withIntegrationRead`),这个文件上面记过一次实测——
         * 「a reviewer saw conflict markers and a live MERGE_HEAD mid-review, and clean -fd
         * deleted its scratch files」。把清理常态化 = 把那个已经量到的破坏从「罕见」提成
         * 「每次」。后置方案在正常路径上一次都不洗。
         *
         * 前提是真 git 量过的:合并因本地修改被拒时**工作树一个字节都没动**、没有
         * MERGE_HEAD,所以「洗掉本地修改再合一次」不会丢掉任何已经合进去的东西。
         * 只在确实洗掉了东西时重试 —— 树本来就干净的话,第二次会用同样的输入得到同样的失败。
         */
        if (cleaned.length > 0) {
          /**
           * **重试之前必须确认这棵树真的在集成分支上。** 验收实测过不确认的后果:
           * `intPath` 不带 runId、`dispose()` 从不删它、`init()` 只用 `rev-parse --git-dir`
           * 判复用 —— 于是 run 002 会接手 run 001 留下的集成工作区,它的 HEAD 还在
           * `efftask/001/integration` 上。这时候重试会**把本节点的提交合进别人的分支**,
           * 然后再洗一遍这棵树;而 `isMerged` 判的是 `efftask/002/integration`,永远为假,
           * 于是阻断卡叫用户 `--retry-blocked`,每重试一次就再毁一次 —— 一句自信而错误的
           * 建议驱动的破坏循环。宁可在这里如实报错。
           */
          const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], intPath)
          const on = head.stdout.trim()
          if (head.code !== 0 || on !== intBranch) {
            return {
              ok: false, kind: 'infra', cleaned, ...(pinned ? { pinned } : {}),
              message: `集成工作区 ${intPath} 当前在 ${on || '(未知)'} 上,不是集成分支 ${intBranch};` +
                `拒绝在它上面重试合并(那会把本节点的提交合进别的分支)。` +
                `请把它切回 ${intBranch},或删掉该目录让下次运行重建。`,
            }
          }
          const again = await git(['merge', '--no-edit', branch], intPath)
          // 洗完重试成功也是一次真的合入 —— 同样要往主干送一次(漏了这条出口的话,
          // 「每个子任务完成就合」在这条路上就是假的)。
          if (await isMerged(branch)) {
            return { ok: true, merged: true, cleaned, ...(pinned ? { pinned } : {}), trunk: await intoTrunk() }
          }
          const retryConflicts = await git(['diff', '--name-only', '--diff-filter=U'], intPath)
          const retryFiles = retryConflicts.stdout.split('\n').map(l => l.trim()).filter(Boolean)
          // 同上:这一处也在抹东西(重试撞了冲突之后的现场),同样先钉。
          const pinned2 = await pinBeforeWipe()
          await git(['reset', '--hard'], intPath)
          await git(['clean', '-fd'], intPath)
          /**
           * `cleaned` 要跟着**每一条**出口走。验收实测:只有成功那条带它,而失败那两条
           * 恰恰是用户最需要知道「我刚才丢了什么」的时刻 —— 一个未跟踪的用户文件被
           * clean -fd 抹掉、重试又撞冲突,node.md / 阻断卡 / run.md 里一个字都没有。
           *
           * **`pinned` 是同一条规矩**,而且比 `cleaned` 更该跟到底:名字只是讣告,ref 才是
           * 能取回来的那个东西。第二次钉的优先(它是离用户最近的那次现场),第一次兜底。
           */
          const kept = pinned2 ?? pinned
          if (retryFiles.length > 0) {
            return { ok: false, kind: 'conflict', files: retryFiles, cleaned, ...(kept ? { pinned: kept } : {}) }
          }
          return {
            ok: false, kind: 'infra', cleaned, ...(kept ? { pinned: kept } : {}),
            /**
             * **别把 git 的成功输出当失败原因念给用户听。**
             *
             * `stderr || stdout` 是从上面那条抄来的惯用法,但只有重试这一格会稳定命中
             * 「git 命令 rc=0、`isMerged` 仍为假」:实测端到用户面前的是
             * 「合并失败(基础设施): Updating 8533347..e866727 / Fast-forward / 2 files changed」。
             */
            message: `合并命令已执行,但集成分支 ${intBranch} 没有前进` +
              `(已清理集成工作区的本地改动 ${cleaned.length} 处并重试一次)。` +
              `git 输出:${again.stderr.trim() || again.stdout.trim() || '(空)'}`,
          }
        }
        return { ok: false, kind: 'infra', message: merge.stderr.trim() || merge.stdout.trim() || '合并未生效' }
      })
    },

    /**
     * 清掉这个节点工作区里的**构建产物**(被 `.gitignore` 忽略的那些)。
     *
     * 用户原话:「合并提交后,任务标记完成了,需要立马清理掉 worktree 下的 target 目录下的
     * 编译产物这些」。调用点在 `mergeAndRelease` 里、`release()` 之前 —— 那一刻的事实是
     * 逐字确定的:交付物已经 `add -A` + commit + 合进集成分支,而 `add -A` **从不暂存被
     * 忽略的文件**,所以之后还留在这棵树里的被忽略文件在**任何路径上都到不了集成分支**
     * (`refreshFromIntegration` 的 KNOWN GAP 段落已经把这条记死了)。它们不是交付物。
     *
     * 判据、以及为什么不是一句 `git clean -X -d -f`,全部在 `buildOutputs.ts` 的文件头
     * (三条真 git 实测:嵌套仓库静默跳过而退出码是 0、`info/exclude` 对 linked worktree
     * 生效、git 会把父目录折叠上来)。
     *
     * **不删目录** —— 用户要的是清产物,而目录还在是 `m` 键、重做、升级卡指路的前提。
     * 顺带买到的是:清完之后 `release()` 的判据(干净带 `--ignored` + 已合入)在很多节点上
     * 当场变成成立,于是收口时 `dispose()` 能真的回收它们,而不是像从前那样被 `target/`
     * 一律拒绝。
     */
    wipeBuildOutputs(node: TaskNode): Promise<BuildWipeOutcome> {
      return wipeBuildOutputsAt({ git, ...(dirSizeKb ? { dirSizeKb } : {}) }, pathFor(node))
    },

    /**
     * **重做要求的那次销毁** —— 详情页 `r`「任务重做」以及任何会让执行者重跑工作的重做。
     *
     * 用户原话(第 4 条):「任务重做是要将其 worktree 工作区这些全部删除掉。」
     * 而第 2 条给了理由:「除了合并重做外,其它重做意味着要重新编译这些。」
     *
     * ## 为什么不是 `release()`
     *
     * `release()` 的判据是「干净(带 `--ignored`)**且**已合入」,而 `target/` 的存在
     * **必然**让它拒绝 —— 也就是说今天的重做在真实运行里一个工作区都放不掉,`problems` 里
     * 留一条「工作区仍有未提交或被忽略的文件」,而**执行者读到的注记**(`REDO_NOTE_LOST` /
     * `REDO_NOTE_MERGED`)逐字写着「隔离工作区已重置为集成分支最新状态」。那句话是假的。
     *
     * 这和 `cleanupWorktrees` 当初「必须不复用 `release()`」是**同一条判据**:
     * release 的两条是池子对「什么时候可以自动动用户的目录」的承诺,而这里是**用户逐个
     * 确认过**的另一套。两者不该共用一个函数名。
     *
     * ## 四步,顺序不可换
     *
     * 1. **先固化未提交的东西。** 评审在真 git 上量过不固化的后果:节点分支上一笔提交都
     *    没有(执行产出在 `commitAndMerge` 之前一直是未提交的)时,下面那道抢救闸
     *    `merge-base --is-ancestor` 判「无需抢救」,`worktree remove --force` 之后
     *    `git fsck --lost-found` **无输出,文件无从恢复**。这正面撞用户第 8 条
     *    「所有未提交的都要提交,不能丢弃了」。
     *    ⚠ `add -A` **不暂存被忽略的文件** —— 那部分确实会随目录一起消失,而那正是第 2 条
     *    要的「删掉 target 重新编译」。确认屏必须说出这半句。
     * 2. **抢救,用唯一名**(见 `salvageRefFor`)。**存不下来就整条放弃** ——
     *    宁可这个节点报错,不可静默丢掉一次执行的产出。
     * 3. `worktree remove --force`,**一次**。真 git 实测:第二个 `--force` 是给**被锁**的
     *    工作树用的(`fatal: cannot remove a locked working tree; use 'remove -f -f'`),
     *    多加一次会把「有人锁住了它」这条该报的情况一起吞掉。
     *    **不需要 `worktree prune`** —— 实测 remove 会连登记项一起清掉,连目录已被外部
     *    `rm -rf` 的情况也照样 exit=0。
     * 4. 目录删成了**才** `branch -D`(分支被工作树占着时 git 直接拒绝);
     *    没删成就整条跳过,分支留着 —— 一个已经没了分支的残留工作区更难救。
     */
    async discard(node: TaskNode): Promise<{
      removed: boolean
      /** 没删成的原因。`removed: false` 时必有。 */
      keptBecause?: string
      /** 这次抢救出来的 ref(有没合入的提交时才有),要念给用户听。 */
      salvaged?: string
      /** 分支没删掉 —— 不影响腾空间,但它会一直躺在 `git branch` 里。 */
      branchKept?: string
    }> {
      const path = pathFor(node)
      const branch = branchFor(node)
      const here = await git(['rev-parse', '--git-dir'], path)
      // 目录本来就不在 = 这一步没什么可做的,不是失败。分支的事交给 acquire 的 reclaim。
      if (here.code !== 0) return { removed: true }

      /**
       * **零、嵌套 git 仓库一律拒绝删除。**
       *
       * 验收在真 git 上量过不拒绝的后果:`git add -A` 对工作区里的嵌套仓库只记一个
       * **gitlink**(git 自己在 stderr 里喊 `warning: adding embedded git repository`),
       * 而第三步 `worktree remove --force` 把目录整个删掉 —— 对象库跟着没。于是:
       *
       *     $ git ls-tree <salvage> nested
       *     160000 commit d5e9795…  nested          ← 存下来的是一个悬空指针
       *     $ git show <salvage>:nested/secret.txt
       *     fatal: path 'nested/secret.txt' does not exist
       *
       * 而屏幕(`redoCommit`)照样念「重做前的产出已抢救到分支 …(没有丢失,可用 git show
       * 查看)」。这直接违反本函数第二步自己写的那句「**存不下来就整条放弃** —— 宁可这个
       * 节点报错,不可静默丢掉一次执行的产出」:一个悬空的 gitlink 就是「存不下来」。
       *
       * 判据用**git 自己记下来的东西**:`add -A` 之后 `ls-files -s` 里那条 `160000`
       * (gitlink 的模式位)。它就是让抢救变成悬空指针的那个条目 —— 精确、与 locale 无关。
       *
       * 实测过两条不能用的:
       *  - 解析 `add` 的**警告文本**(`warning: adding embedded git repository`)——
       *    那句话随 locale 变,而这个功能的现场恰恰是中文机器(第十八轮为同一件事付过账);
       *  - 扫 `ls-files -o --exclude-standard` 找 `.git` —— git **不会 descend 进嵌套仓库**,
       *    它只报一个 `vendored/`,里面的 `.git` 一个字都看不到(第一版就是这么写的,
       *    对着真仓库一次都没命中)。
       *
       * 探到就**把索引还原回去**再拒绝:这一路承诺「一个字节都不动」,而 `add -A` 已经
       * 动过暂存区了。
       */
      await git(['add', '-A'], path)
      const staged = await git(['ls-files', '-s'], path)
      const nestedRepos = staged.stdout.split('\n')
        .filter(l => l.startsWith('160000'))
        .map(l => l.slice(l.indexOf('\t') + 1).trim())
        .filter(Boolean)
      if (nestedRepos.length > 0) {
        await git(['reset'], path)
        return {
          removed: false,
          keptBecause: `工作区里有嵌套的 git 仓库(${nestedRepos.slice(0, 3).join('、')}` +
            `${nestedRepos.length > 3 ? ` 等 ${nestedRepos.length} 个` : ''})—— ` +
            `它们的提交存不进抢救分支(git 只记一个 gitlink,内容留在那个目录自己的对象库里),` +
            `删掉就真的没了。请自行处置那几个目录之后再重做。`,
        }
      }

      // 一、固化(`add -A` 已在上面做过)。没东西可提交时 commit 非零退出,那不是失败 ——
      // 判据是下一步的「HEAD 在不在集成分支里」,不是这次 commit 的退出码(acquire 为同一件事
      // 写过一整段:执行者自己提交过的形态只有那一问答得对)。
      await git(['commit', '--no-verify', '-m', `efftask: 固化工作区残留 (${node.id})`], path)

      // 二、抢救。
      let salvaged: string | undefined
      const sha = await git(['rev-parse', 'HEAD'], path)
      if (sha.code === 0) {
        const tip = sha.stdout.trim()
        const contained = await git(['merge-base', '--is-ancestor', tip, intBranch], path)
        if (contained.code === 1) {
          const ref = await salvageRefFor(node, tip)
          if (ref === undefined) {
            return { removed: false, keptBecause: '有没合入集成分支的提交,而抢救 ref 的名字全被占满了 —— 没有删除它' }
          }
          const saved = await git(['branch', '-f', ref, tip], gitRoot)
          if (saved.code !== 0) {
            return {
              removed: false,
              keptBecause: `有没合入集成分支的提交,而它存不进 ${ref}(${saved.stderr.trim()})—— 没有删除它`,
            }
          }
          salvaged = ref
        } else if (contained.code !== 0) {
          // 探不明白就不动手 —— 「你还有东西没合」和「我没探明白」要做的事不一样,
          // 而这一步是不可逆的(`integrationAhead` 那条注释的又一次应验)。
          return {
            removed: false,
            keptBecause: `无法判断提交是否已合入(git 探测失败:${contained.stderr.trim() || `退出码 ${contained.code}`})—— 没有删除它`,
          }
        }
      }

      // 三、删目录。
      const rm = await git(['worktree', 'remove', '--force', path], gitRoot)
      if (rm.code !== 0) {
        return {
          removed: false,
          keptBecause: `移除失败: ${rm.stderr.trim() || rm.stdout.trim() || `退出码 ${rm.code}`}`,
          ...(salvaged ? { salvaged } : {}),
        }
      }
      // 四、删分支。
      const del = await git(['branch', '-D', branch], gitRoot)
      return {
        removed: true,
        ...(salvaged ? { salvaged } : {}),
        ...(del.code !== 0 ? { branchKept: branch } : {}),
      }
    },

    /**
     * Remove a node's worktree — only when it is provably safe.
     *
     * BOTH conditions, because either alone deletes real work: a clean tree can still hold
     * commits that never merged, and a merged branch can still have uncommitted edits.
     */
    async release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }> {
      const path = pathFor(node)
      const branch = branchFor(node)
      // --ignored is load-bearing: plain porcelain hides gitignored files, so a node whose
      // deliverable is a build output (dist/, coverage/) reported a CLEAN tree and
      // `worktree remove --force` then deleted it. Measured. That is the opposite of
      // 宁可保留垃圾,不可删掉工作.
      const dirty = await git(['status', '--porcelain', '--ignored'], path)
      if (dirty.code !== 0) return { removed: false, keptBecause: '无法读取工作区状态' }
      if (dirty.stdout.trim().length > 0) return { removed: false, keptBecause: '工作区仍有未提交或被忽略的文件' }
      if (!(await isMerged(branch))) return { removed: false, keptBecause: '仍有未合入集成分支的提交' }
      // No --force: the checks above already proved this tree clean and merged, so --force
      // could only ever override a safeguard we want.
      const rm = await git(['worktree', 'remove', path], gitRoot)
      if (rm.code !== 0) return { removed: false, keptBecause: `移除失败: ${rm.stderr.trim()}` }
      await git(['branch', '-D', branch], gitRoot)
      return { removed: true }
    },

    /** Reclaim what is safe; report what was kept so the user can find it. */
    async dispose(nodes: TaskNode[]): Promise<{ kept: { path: string; why: string }[] }> {
      const kept: { path: string; why: string }[] = []
      for (const n of nodes) {
        const r = await this.release(n)
        if (!r.removed) kept.push({ path: pathFor(n), why: r.keptBecause ?? '未知' })
      }
      return { kept }
    },

    /**
     * Everything the user needs to find their work after the run — spec §8's 收口.
     *
     * Without this the run ends having written every change to a branch the user is never
     * told about, in worktrees they do not know exist. The work is preserved and invisible,
     * which for them is indistinguishable from lost.
     */
    /**
     * 一个工作区当前的改动指纹。
     *
     * 给测试验证环节用:那一场跑完之后再取一次,不同就说明验证者动了代码 —— 而工具
     * 清单挡不住这件事(Bash 能 echo > file)。用 --porcelain 而不是 diff,是因为它同时
     * 覆盖已跟踪与未跟踪文件:只看 diff 会漏掉「新建一个文件让测试通过」。
     */
    async statusFingerprint(cwd: string): Promise<string> {
      const st = await git(['status', '--porcelain'], cwd)
      return st.code === 0 ? st.stdout.trim() : `err:${st.code}`
    },

    async handoff(nodes: TaskNode[]): Promise<{
      branch: string
      commits: number
      kept: { path: string; why: string }[]
      salvage: string[]
      integrationPath: string
      /**
       * 这一趟**已经落在你当前分支上**的提交数,从 git 现算。
       *
       * 收口那一屏必须拿到它:逐任务合并把 `commits`(= `HEAD..集成分支`)在正常路径上打成
       * 0,而 `handoffLines` 对 0 印的是「本次没有产生任何改动;分支与起点相同」——
       * 一句在 20 个子任务已经合进用户分支之后逐字为假的话。
       *
       * **现算而不是内存计数**:验收实测,`--resume` 是新进程 = 新池子 = 计数器归零,
       * 于是恢复之后那句假话原样复活,而且自动推送也不会发生。
       */
      trunkLanded: number
      trunkSkips: string[]
    }> {
      const count = await git(['rev-list', '--count', `HEAD..${intBranch}`], gitRoot)
      const commits = Number.parseInt(count.stdout.trim(), 10) || 0
      /**
       * 已落地 = 这一趟产出的全部 − 还没合进用户分支的那些。
       *
       * 拿不到起点(引入 `refs/efftask/<runId>/base` 之前开的老 run)就退回内存计数器 ——
       * 行为与引入它之前逐字相同,而不是报一个凭空造出来的 0。
       */
      const produced = await git(['rev-list', '--count', `${baseRef}..${intBranch}`], gitRoot)
      const trunkLanded = produced.code === 0
        ? Math.max(0, (Number.parseInt(produced.stdout.trim(), 10) || 0) - commits)
        : trunkMerged
      /**
       * **抢救分支要判「合没合进去」,不能裸列。**
       *
       * 这里原来是一句裸的 `for-each-ref`,而 `rescue.ts` 写死了「成功不删分支」
       * (有道理:那条 ref 是那一版产出唯一的落脚点)。两条加起来 = **一条抢救分支
       * 一旦建出来,就永久出现在每一次收口屏上**,哪怕它早就被 `m` 合进去了。
       * 更糟的是屏幕上紧跟着那行「⚠ 上面这 N 条抢救分支**不在集成分支上**,
       * git merge 捞不到它们」—— 合过之后它逐字是假话。
       *
       * 判据和 `stranded.ts` 那一侧对齐(`containedIn === 'yes' → 跳过`):同一件事
       * 两套判据是这个仓库的固定病灶。`--is-ancestor` 的约定:0 = 是祖先,1 = 不是,
       * >1 = 命令自己出错 —— **探不出来的照旧列出来**,状态未知时宁可多说一句。
       */
      const salvAll = await git(
        ['for-each-ref', '--format=%(refname:short)', `refs/heads/efftask/${runId}/salvage`], gitRoot,
      )
      const salvKept: string[] = []
      for (const ref of salvAll.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
        const inInt = await git(['merge-base', '--is-ancestor', ref, intBranch], gitRoot)
        if (inInt.code !== 0) salvKept.push(ref)
      }
      const kept: { path: string; why: string }[] = []
      for (const n of nodes) {
        /**
         * **没有 `worktree` 引用的节点也要探一眼。**
         *
         * 分析/质疑讨论借来的那棵树在 `releasePlanBase` 里被交回(引用清空),而目录留给
         * 执行环节复用。节点如果在这中间被阻断、或 run 在此刻中止,目录就成了「保留而
         * 不可见」——`dispose()` 收得掉干净的,收不掉被方案席写脏的那些,而它的返回值
         * 在编排层被丢弃。验收实测:目录还在,`handoff().kept` 是空的。
         *
         * 只报**真的还有东西**的:干净目录出现在收口屏上纯属噪音。
         */
        const path = n.worktree?.path ?? pathFor(n)
        /**
         * **判据分成两问,而且都不再数被忽略的文件。**
         *
         * 这里原来一律 `status --porcelain --ignored` 非空就报「仍有未合入的内容」。
         * `--ignored` 把**构建产物**也算进去 —— Rust 项目每个节点工作区里躺着一个
         * `target/`,于是跑机上 11 个保留工作区里 8 个的全部「内容」就是编译产物,
         * 而它们**一个提交都没有**、`m` 也合不了(那一屏把它们记进 `ignoredOnly`)。
         * 用户读到的是「有 8 处产出没送到」,而实际是 0 处。
         *
         * 换成:①这条分支上还有没有集成分支没有的**提交**;②工作区里还有没有
         * git 看得见的改动。两问都为否 = 真的没东西了,只是目录还占着盘 ——
         * 那是 `c` 键的事,不该在收口屏上冒充「产出没送到」。
         *
         * **去掉的只有 `--ignored`,不是 `-u`。** 探针当场把第一版顶红了:方案席留下的
         * 一个 `调研笔记.md` 是**未跟踪但没被忽略**的,目录一删就真没了 —— 那正是这一格
         * 存在的理由。plain `--porcelain` 恰好是「显示未跟踪、不显示被忽略」。
         */
        const st = await git(['status', '--porcelain'], path)
        if (st.code !== 0) continue
        const dirty = st.stdout.trim().length > 0
        /**
         * **分支按 `branchFor(n)` 算,不看 `n.worktree` 还在不在。**
         *
         * 探针抓到过:挂在 `n.worktree?.branch` 上的话,「引用已交回、而提交还在分支上」
         * 那一类整个漏掉 —— 而它正是执行者**已经 commit、合并却没成**时的常态
         * (跑机上那三个 `commits_ahead_of_int=3` 的工作区就是它)。分支名是
         * `hash(nodeId)` 算出来的,不随引用在不在而变,所以这里可以直接问。
         *
         * 分支不存在时 `rev-list` 非 0 → `ahead` 为假,和「没有未合入的提交」同一个结论。
         */
        const c = await git(['rev-list', '--count', `${intBranch}..${branchFor(n)}`], gitRoot)
        const ahead = c.code === 0 && (Number.parseInt(c.stdout.trim(), 10) || 0) > 0
        if (dirty || ahead) {
          kept.push({
            path,
            why: n.worktree ? '仍有未合入的内容' : '分析/质疑讨论阶段留下的文件,未回收',
          })
        } else if (n.worktree) kept.push({ path, why: '未回收' })
      }
      return {
        branch: intBranch,
        commits,
        kept,
        salvage: salvKept,
        // Reported because the branch above CANNOT BE DELETED while this worktree holds it,
        // and nothing ever reclaims it: `dispose()` walks only the NODES it is handed, and
        // the next run deliberately re-adopts this one rather than rebuilding it. The exit
        // report printed `丢弃: git branch -D <branch>`, which git refuses outright —
        // "cannot delete branch … used by worktree at …". The user needs this path both to
        // make that command work and to know the directory is there at all.
        integrationPath: intPath,
        trunkLanded,
        trunkSkips: [...trunkSkips],
      }
    },
    /**
     * 收口那一次**不走这里**,走 `finishHandoff` → `runHandoffChoice('merge')`:那条路
     * 多一层「撞冲突时派模型解一次」,而逐任务这条路上没有人在等、也不该为每个子任务
     * 付一次解冲突的模型调用。落下的东西由收口那一次一起补上(它合的是同一条集成分支)。
     */

    /**
     * Run `fn` with exclusive use of the integration worktree.
     *
     * That worktree has ONE index and ONE checkout: commitAndMerge writes it (merge, and on
     * failure reset --hard + clean -fd) while integration acceptance READS it. Measured
     * without this: a reviewer saw conflict markers and a live MERGE_HEAD mid-review, and
     * clean -fd deleted its scratch files. Serialising execute used to keep that to one
     * writer; lifting the lock made it N.
     */
    /**
     * Bring the integration branch INTO the node's own worktree, leaving any conflict there.
     *
     * This exists because the obvious design is wrong. `commitAndMerge` merges in the SHARED
     * integration worktree and, on conflict, ends with `reset --hard` + `clean -fd` there —
     * so at the moment a conflict is reported, the node's own worktree is CLEAN: no
     * MERGE_HEAD, no markers, only its own side of the change. Sending a resolver (or a human)
     * to that path to "解决冲突" pointed both of them at a directory with nothing to resolve.
     * Measured: the resolve call found nothing, acceptance rubber-stamped, the second merge
     * conflicted identically, and the node's work never reached the integration branch.
     *
     * Merging the other direction puts the conflict where it can actually be worked on, in a
     * worktree only this node owns, and leaves it in place — markers, MERGE_HEAD and all —
     * so a human who follows the escalation card finds exactly what the card describes.
     * Once resolved and committed, the integration merge becomes a fast-forward.
     */
    /**
     * What a human will ACTUALLY find in this node's worktree, and a conflict to find if
     * there is none yet.
     *
     * The escalation card describes this directory, so the card can only be truthful if it is
     * built from a measurement rather than an assumption. Three real states reach an
     * escalation and they need three different sentences:
     *   - unmerged paths present  → markers are there, resolve them
     *   - MERGE_HEAD but no unmerged paths → a resolution is STAGED and was rejected by
     *     acceptance; telling the user to "git add and commit" would commit exactly the code
     *     the reviewers just refused
     *   - clean → the conflict was never reproduced here (budget already spent), so make one
     *
     * Never touches a worktree that already has a merge in progress: `mergeIntegrationIntoNode`
     * would commit the staged resolution before merging, which is the rejected work.
     */
    /** Files this branch would bring that still carry conflict-marker lines. */
    async markerFiles(node: TaskNode): Promise<string[]> {
      const path = pathFor(node)
      // ONLY the files git said were conflicted. Everything else this branch contributes is
      // ordinary work, and marker-shaped text in it is ordinary content — a documentation file,
      // a Markdown setext underline, a fixture. Restricting the scan is what makes this a
      // conflict predicate instead of a text search.
      const suspect = conflictedByNode.get(node.id)
      if (!suspect || suspect.length === 0) return []
      const merges = await git(['rev-list', '--merges', `${intBranch}..HEAD`], path)
      if (merges.stdout.trim().length === 0) return []
      const diff = await git(['diff', '-U0', `${intBranch}...HEAD`], path)
      const out: string[] = []
      let current = ''
      for (const line of diff.stdout.split('\n')) {
        if (line.startsWith('+++ b/')) { current = line.slice('+++ b/'.length).trim(); continue }
        if (!suspect.includes(current)) continue
        if (current && /^\+(<{7} |>{7} |={7}$)/.test(line) && !out.includes(current)) out.push(current)
      }
      return out
    },

    /**
     * Bring the integration branch INTO this node's worktree, and leave NO conflict behind.
     *
     * 跨分支依赖调度: a node's worktree is based on the integration tip at `acquire` time and
     * then frozen. The dependency GATE guarantees a node's own deps merged before it starts,
     * but nothing keeps it current afterwards — and an executable node can spend several
     * rework rounds in that worktree while sibling branches merge. Measured consequence: the
     * executor reworks against a tree that is missing merged work, the acceptance roundtable
     * reads that same stale tree, and the final merge is far likelier to conflict over hunks
     * neither side ever saw.
     *
     * Deliberately NOT `mergeIntegrationIntoNode`: that one leaves the conflict in place,
     * which is exactly right when a human or a resolver is about to work on it and exactly
     * wrong in the middle of a rework loop — the executor would be asked to fix acceptance
     * blockers and resolve a merge in one round, in a tree it did not expect to be conflicted.
     * Here a conflict simply means "stay on the old base"; the merge at the end still catches
     * it and routes it through the tested §8 conflict path.
     */
    /**
     * MEASURED, and recorded so it is not re-litigated:
     *
     *  - NOT under `mergeLock`/`acquireLock`, and that is safe. This touches only the node's
     *    OWN linked worktree (its per-worktree index, HEAD and MERGE_HEAD) plus one read of
     *    the integration ref; it never touches `intPath`, where commitAndMerge does its
     *    `reset --hard` + `clean -fd`. Verified against real git: 6 concurrent refreshes
     *    racing a commitAndMerge, and 5 refreshes racing 5 acquires, produced no corruption,
     *    no MERGE_HEAD residue and `git fsck` clean, with every file reaching integration.
     *
     *  - KNOWN GAP, bounded and deliberate: `git add -A` does not stage gitignored files, so
     *    a SUCCESSFUL merge can overwrite one (measured: a build output was replaced with the
     *    other side's content, leaving a clean `git status`). `release()` carries `--ignored`
     *    precisely because build outputs are a real deliverable shape here. Not fixed: those
     *    files cannot reach the integration branch under any path, and refusing to refresh
     *    whenever a dist/ exists would disable this feature in most repos. Recorded rather
     *    than pretended away.
     */
    async refreshFromIntegration(node: TaskNode): Promise<
      | { ok: true; updated: boolean }
      // `dirty` means the rollback itself failed and the worktree is STILL conflicted. The
      // caller must not then tell the executor it is on a clean base.
      | { ok: false; conflicted: boolean; message: string; dirty?: boolean }
    > {
      const path = pathFor(node)
      // Already contains everything the integration branch has → nothing to do, and no
      // pointless commit of the executor's half-finished work.
      const current = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], path)
      if (current.code === 0) return { ok: true, updated: false }
      // `git merge` refuses to start on a dirty tree. Committing here is safe: commitAndMerge
      // would commit exactly the same content under exactly the same message later, and it
      // is what makes `merge --abort` below a lossless restore.
      const add = await git(['add', '-A'], path)
      if (add.code !== 0) return { ok: false, conflicted: false, message: `git add 失败: ${add.stderr.trim()}` }
      const staged = await git(['diff', '--cached', '--quiet'], path)
      if (staged.code !== 0) {
        const c = await git(['commit', '--no-verify', '-m', `efftask: ${node.title}`], path)
        if (c.code !== 0) return { ok: false, conflicted: false, message: `提交失败: ${c.stderr.trim() || c.stdout.trim()}` }
      }
      const merge = await git(['merge', '--no-edit', intBranch], path)
      if (merge.code === 0) return { ok: true, updated: true }
      const u = await git(['diff', '--name-only', '--diff-filter=U'], path)
      const conflicted = u.stdout.trim().length > 0
      // Restore. NOT reset --hard: the executor's work is committed now, and abort rewinds
      // only the merge.
      const abort = await git(['merge', '--abort'], path)
      // The exit code MATTERS. The caller tells the executor "仍在原基线上" on this branch,
      // and that sentence is only true if the abort actually happened. A failed abort with
      // unmerged paths still present leaves markers in the tree the executor is about to edit
      // — so verify rather than assume, and say so when it did not work.
      if (abort.code !== 0 && conflicted) {
        const still = await git(['diff', '--name-only', '--diff-filter=U'], path)
        if (still.stdout.trim().length > 0) {
          return { ok: false, conflicted: true, dirty: true, message: `合并冲突且无法回滚(git merge --abort 失败): ${abort.stderr.trim()}` }
        }
      }
      return { ok: false, conflicted, message: merge.stderr.trim() || merge.stdout.trim() || '合并未生效' }
    },

    /**
     * 集成分支上有没有这个工作区**还没有**的提交。
     *
     * 解冲突循环拿它决定「这一轮要不要重新从集成分支同步」。判据必须是 `code === 1`
     * 而不是 `code !== 0`:`--is-ancestor` 用 1 表示「不是祖先」,用 128 表示自己出错了
     * (路径没了、仓库坏了、ref 不存在)。把出错当成「有新东西」会让循环在一个已经出问题的
     * 工作区上再发起一次合并 —— 而这一路的下一步是 `add -A` + `commit`,拿不准的时候
     * 什么都不做才是对的(退回今天的行为:原地改)。
     */
    async integrationAhead(node: TaskNode): Promise<boolean> {
      const r = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], pathFor(node))
      return r.code === 1
    },

    async conflictState(node: TaskNode): Promise<{ markers: boolean; staged: boolean; stale: boolean; files: string[] }> {
      const path = pathFor(node)
      const u = await git(['diff', '--name-only', '--diff-filter=U'], path)
      const files = u.stdout.split('\n').map(l => l.trim()).filter(Boolean)
      if (files.length > 0) return { markers: true, staged: false, stale: false, files }
      const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)
      if (mh.code === 0) return { markers: false, staged: true, stale: false, files: [] }
      // BEFORE trying to make a conflict: markers may already be sitting in COMMITTED content
      // (a resolver that "resolved" by committing both sides). That worktree is clean and has
      // no MERGE_HEAD, so every other probe calls it conflict-free — and the card then told the
      // user 那里目前没有冲突现场 while <<<<<<< HEAD was literally in the file, and prescribed a
      // `git merge` that answers "Already up to date."
      const stale = await this.markerFiles(node)
      if (stale.length > 0) return { markers: true, staged: false, stale: true, files: stale }
      // READ-ONLY from here. An earlier version called mergeIntegrationIntoNode to "make" a
      // conflict so the card would have something to point at. That made a probe mutate what
      // it measured: it committed the executor's loose files under a message claiming they
      // were the deliverable, performed the merge, and then reported the state its own merge
      // had produced — so the card's "请自行 git merge" answered "Already up to date", and the
      // merge commit it manufactured was what armed the marker scan for the next round.
      // Reporting a clean worktree honestly is worth more: the card's instruction to merge it
      // in by hand then actually reproduces the conflict.
      return { markers: false, staged: false, stale: false, files: [] }
    },

    async mergeIntegrationIntoNode(node: TaskNode): Promise<{ ok: true; conflicted: false } | { ok: true; conflicted: true; files: string[] } | { ok: false; message: string }> {
      const path = pathFor(node)
      // Commit whatever the executor left loose first: `git merge` refuses to start on a
      // dirty tree, and that refusal would read as an infrastructure failure.
      const add = await git(['add', '-A'], path)
      if (add.code !== 0) return { ok: false, message: `git add 失败: ${add.stderr.trim()}` }
      const staged = await git(['diff', '--cached', '--quiet'], path)
      if (staged.code !== 0) {
        const c = await git(['commit', '--no-verify', '-m', `efftask: ${node.title}`], path)
        if (c.code !== 0) return { ok: false, message: `提交失败: ${c.stderr.trim() || c.stdout.trim()}` }
      }
      const merge = await git(['merge', '--no-edit', intBranch], path)
      if (merge.code === 0) return { ok: true, conflicted: false }
      const u = await git(['diff', '--name-only', '--diff-filter=U'], path)
      const files = u.stdout.split('\n').map(l => l.trim()).filter(Boolean)
      // NOT aborted on purpose — the conflicted state IS the deliverable here.
      if (files.length > 0) {
        conflictedByNode.set(node.id, files)
        return { ok: true, conflicted: true, files }
      }
      // No unmerged paths and a non-zero exit is not a conflict; leave nothing half-done.
      await git(['merge', '--abort'], path)
      return { ok: false, message: merge.stderr.trim() || merge.stdout.trim() || '合并未生效' }
    },

    withIntegrationRead<T>(fn: () => Promise<T>): Promise<T> {
      return mergeLock(fn)
    },

    integrationPath: intPath,
    integrationBranchName: intBranch,
    /**
     * 一个节点的工作区目录/分支,以及这一趟的仓库根。
     *
     * 交出去是给**一键回收已完成工作区**(cleanupWorktrees)用的:那条路要按自己的判据
     * 探盘、然后 `worktree remove --force`,而路径是 `hash(nodeId)` 算出来的 —— 池子外面
     * 谁都猜不到。第二份实现会在 runId 或 slug 规则改动的那一天悄悄指向别的目录,
     * 而那条路的动作是不可逆的。
     *
     * 刻意**不**在这里提供「删掉它」:`release()` 的判据(干净 + 已合入)是这个池子对
     * 「什么时候可以动用户的目录」的承诺,回收那条路是用户逐个确认过的另一套判据,
     * 两者不该共用一个函数名。
     */
    gitRoot,
    worktreePathOf: (node: TaskNode): string => pathFor(node),
    worktreeBranchOf: (node: TaskNode): string => branchFor(node),
  }
}
