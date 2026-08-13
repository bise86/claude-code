import { autoResolveMerge, mergeLeftovers, type ConflictResolver, type GitFn } from './handoffActions.js'
import { DEFAULT_TRUNK_RESOLVE } from './types.js'

/**
 * **把一条 ref 合进集成分支,撞冲突就由解冲突的模型把它解掉。**
 *
 * 用户原话:「用解决合并冲突的模型来执行合并。」
 *
 * ## 为什么不能在集成工作区里做
 *
 * `.efftask-worktrees/integration` 只有一个 index、一个检出:`commitAndMerge` 写它,
 * 集成验收读它,两者共用 `mergeLock`。把一次**几分钟的模型调用**关进那把锁里,
 * 整棵树的合并当场停摆 —— `mergeSubtree.ts` 顶上那段注释为这件事写死过规矩:
 * 「解冲突那次模型调用不在锁里」。
 *
 * 所以合并在**第三棵树**里做:`<worktreeRoot>/merge-scratch`,detached 在集成分支的 tip 上。
 * 它不属于任何节点,没有第二个读者,所以模型可以在里面解任意久。锁只用在最后那一次
 * **毫秒级**的快进上。
 *
 * ```
 *   1. 【进锁】读集成分支 tip
 *   2. 把 merge-scratch 摆到那个 tip 上(懒建 / 复用都要 reset --hard + clean)
 *   3. git merge --no-verify <ref>      ← 冲突留在这里
 *   4. 撞冲突 → 派模型解 → git 复核 → commit(迭代,不在锁里)
 *   5. 【进锁】git merge --ff-only <scratch 的 HEAD>   ← 毫秒级
 *      快进不成立 = 这期间集成分支被推进过 → 回第 1 步,有界重试
 * ```
 *
 * ## 三条判据
 *
 * 1. **detached,不占分支。** 集成分支被 `integration` 那棵工作树占着,git 不许两棵树
 *    占同一条;`--detach` 之后我们照样能在上面提交,最后用 sha 快进过去。
 * 2. **模型说自己解完了不算数。** 一律走 `autoResolveMerge` 的三道 git 复核(还有未合并
 *    路径 / 暂存区里还留着冲突标记 / commit 成不成),任何一条不过就 `merge --abort`。
 * 3. **`note` 要一路带到解冲突的提示词里。** 捞回一条**被后来的版本取代**的抢救分支时,
 *    解冲突的模型如果不知道右边那半是废稿,它会把废稿的内容留下来 —— 真 git 上验过这个
 *    形状(add/add 冲突,一个已经修好的文件被反向污染)。所以「这一半是什么来历」必须是
 *    这条路的入参,而不是让模型自己猜。
 */

export interface IntegrationMergeDeps {
  git: GitFn
  gitRoot: string
  integrationBranch: string
  integrationPath: string
  /** 临时工作树建在哪(`<worktreeRoot>/merge-scratch`)。 */
  worktreeRoot: string
  /** 集成工作区的那把锁。由池子的 `withIntegrationRead` 给。 */
  withIntegrationLock: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * 解冲突的模型。**不给 = 撞了冲突就如实报告**(而不是假装没有这个功能)。
   */
  resolve?: ConflictResolver
  /** 同一次合并最多让模型解几轮。见 `caps.trunkResolveRounds`;缺省 3。 */
  rounds?: number
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

export type IntegrationMergeResult =
  | { ok: true; advanced: boolean; resolvedFiles: string[]; rounds: number }
  | {
    ok: false
    why: string
    conflicted: boolean
    /** 临时工作树有没有被收拾干净。false = 那里留着一次没完成的合并,要说出来。 */
    restored: boolean
  }

/** 这一趟允许模型解几轮。0 = 不自动解(撞冲突直接报告)。 */
const DEFAULT_ROUNDS = DEFAULT_TRUNK_RESOLVE

/**
 * 让 `merge-scratch` 干干净净地停在 `tip` 上。
 *
 * 复用比重建便宜得多(一次 checkout vs 一次全量检出),而复用的**唯一**安全形态是
 * 「`reset --hard` + `clean -fd`」—— 上一趟可能把它留在半合并态或者留了一地散落文件。
 * 这棵树是我们自己的、没有第二个读者,所以在这里 `clean -fd` 不会误伤任何人。
 */
export async function stageAt(
  deps: Pick<IntegrationMergeDeps, 'git' | 'gitRoot'>, path: string, tip: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const there = await deps.git(['rev-parse', '--git-dir'], path)
  if (there.code !== 0) {
    // 盘上可能留着一个 git 已经不认识的同名目录(仓库被移动过)。prune 只清登记项,
    // 清不掉目录 —— 那时 `add` 会报 already exists,如实带出去让人处置。
    await deps.git(['worktree', 'prune'], deps.gitRoot)
    const add = await deps.git(['worktree', 'add', '--detach', path, tip], deps.gitRoot)
    if (add.code !== 0) return { ok: false, why: `建不出临时合并工作区: ${add.stderr.trim() || add.stdout.trim()}` }
    return { ok: true }
  }
  /**
   * 复用。**先收拾,再对齐** —— 顺序反了这棵树会被永久卡死。
   *
   * 验收在真 git 上复现过:`autoResolveMerge` 只 `git add -- <冲突文件>` 然后
   * `commit --no-edit`(**没有 `-a`**)。解冲突模型顺手改了一个不在冲突列表里的受跟踪文件
   * → 合并成功,而这棵树留着一个未暂存的改动。下一次进来时 `checkout --detach` 报
   * 「Your local changes to the following files would be overwritten by checkout」并 return,
   * 而收拾它的那两句 `reset --hard` / `clean -fd` **排在它下游,永远到不了**:
   *
   *     attempt 1..3: 临时合并工作区切不到集成分支: error: Your local changes …
   *
   * 从此 `m` 键的**捞回**和**合回主干**两条路全部永久失败,而报出去的错没有任何可操作的
   * 下一步。所以 `reset --hard` 排第一 —— 它本来就能把 HEAD 挪到 tip,`checkout` 那一步
   * 反而是多余的。这棵树是我们自己的、没有第二个读者,所以在这里 `reset` + `clean` 不伤人。
   */
  const inMerge = await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)
  if (inMerge.code === 0) await deps.git(['merge', '--abort'], path)
  /**
   * **先脱离分支,再 `reset --hard`。**
   *
   * 这棵树按设计永远是 detached(`worktree add --detach`),而「按设计」在这里不够:
   * 数据安全席在真 git 上复现过一条把它推上分支的路 —— `git checkout <ref> --` 在
   * pathspec **为空**时不是空操作,是**切分支**。一旦 HEAD 停在某条抢救分支上,
   * 下一趟进来的这句 `reset --hard <集成分支 tip>` 就会把**那条分支**挪到集成分支上,
   * 而 `rescue.ts` 的铁律正是「成功不删分支 —— 这条 ref 是那一版产出唯一的落脚点」。
   * 实测结果:分支指向 tip,那一版产出只剩悬垂对象,等 gc。
   *
   * 空 pathspec 那条路已经在 `backfill.ts` 里堵死了,但闸要留两道:这一句是**最后一道**,
   * 而且它不改任何文件(只把 HEAD 从符号引用换成 sha),对正常那条路是零成本。
   */
  const onBranch = await deps.git(['symbolic-ref', '-q', 'HEAD'], path)
  if (onBranch.code === 0) await deps.git(['checkout', '--detach'], path)
  const reset = await deps.git(['reset', '--hard', tip], path)
  if (reset.code !== 0) return { ok: false, why: `临时合并工作区对不齐集成分支: ${reset.stderr.trim()}` }
  await deps.git(['clean', '-fd'], path)
  return { ok: true }
}

/**
 * 把 `ref` 合进集成分支。
 *
 * `note` 是「右边这一半是什么来历」——它会一路进解冲突的提示词。捞回一条被取代的抢救分支
 * 时,少了它模型会把废稿留下来。
 */
export async function mergeIntoIntegration(
  deps: IntegrationMergeDeps, ref: string, note?: string,
): Promise<IntegrationMergeResult> {
  const path = `${deps.worktreeRoot}/merge-scratch`
  const rounds = deps.rounds ?? DEFAULT_ROUNDS
  const resolvedFiles: string[] = []
  let spent = 0

  /**
   * 「这期间集成分支被推进过」要有界重试 —— 编排器完全可能在我们解冲突的那几分钟里
   * 合进去几笔。次数少而固定:每一轮都要重做一次合并和一次解冲突,而它收敛不了的时候
   * 多试几次也只是把同样的话推迟几分钟说出口。
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deps.signal?.aborted) return { ok: false, why: '已中断', conflicted: false, restored: true }

    const tipRes = await deps.withIntegrationLock(() =>
      deps.git(['rev-parse', deps.integrationBranch], deps.gitRoot))
    if (tipRes.code !== 0) {
      return { ok: false, why: `读不出集成分支的 tip: ${tipRes.stderr.trim()}`, conflicted: false, restored: true }
    }
    const tip = tipRes.stdout.trim()

    // 已经全在里面了 —— 没什么可合的,而这不是失败。
    const contained = await deps.git(['merge-base', '--is-ancestor', ref, tip], deps.gitRoot)
    if (contained.code === 0) return { ok: true, advanced: false, resolvedFiles, rounds: spent }

    const staged = await stageAt(deps, path, tip)
    if (!staged.ok) return { ok: false, why: staged.why, conflicted: false, restored: true }

    const merge = await deps.git(['merge', '--no-edit', '--no-verify', ref], path)
    if (merge.code !== 0) {
      const files = await mergeLeftovers(deps.git, path)
      if (files.length === 0) {
        // 非零退出但没有未合并路径 —— 钩子拒绝、或者别的什么。收拾干净再报。
        const inMerge = await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)
        if (inMerge.code === 0) await deps.git(['merge', '--abort'], path)
        const still = (await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)).code === 0
        return {
          ok: false,
          why: merge.stderr.trim() || merge.stdout.trim() || '合并未生效',
          conflicted: false,
          restored: !still,
        }
      }
      if (!deps.resolve || rounds <= 0) {
        await deps.git(['merge', '--abort'], path)
        const still = (await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)).code === 0
        return {
          ok: false,
          why: `撞了冲突(${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 个` : ''}),而这一趟没有可用的解冲突模型`,
          conflicted: true,
          restored: !still,
        }
      }
      /**
       * **迭代解。** 每一轮都由 git 复核,而且「有没有进展」也由 git 说 ——
       * 两轮之间未合并路径**逐字相同**就停:模型在原地打转,再派十轮只是烧钱。
       */
      let last = files.join(' ')
      let solved = false
      for (; spent < rounds; ) {
        if (deps.signal?.aborted) {
          await deps.git(['merge', '--abort'], path)
          return { ok: false, why: '已中断', conflicted: true, restored: true }
        }
        spent += 1
        const now = await mergeLeftovers(deps.git, path)
        deps.onProgress?.(`解冲突第 ${spent} 轮(${now.length} 个文件)…`)
        const auto = await autoResolveMerge({
          git: deps.git, cwd: path, branch: deps.integrationBranch, files: now, resolve: deps.resolve,
          ...(note ? { note } : {}),
        })
        if (auto.ok) { resolvedFiles.push(...now); solved = true; break }
        const after = await mergeLeftovers(deps.git, path)
        if (after.length === 0) {
          // `autoResolveMerge` 失败时会 abort,所以这里没有未合并路径是**它已经还原过了**。
          return { ok: false, why: auto.why, conflicted: true, restored: auto.restored }
        }
        const fingerprint = after.join(' ')
        if (fingerprint === last) {
          return {
            ok: false,
            why: `${auto.why};而且这一轮和上一轮的冲突文件逐字相同 —— 模型在原地打转,已停止`,
            conflicted: true,
            restored: auto.restored,
          }
        }
        last = fingerprint
      }
      if (!solved) {
        const stillFiles = await mergeLeftovers(deps.git, path)
        if (stillFiles.length > 0) await deps.git(['merge', '--abort'], path)
        const still = (await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)).code === 0
        return { ok: false, why: `解冲突用满了 ${rounds} 轮仍未解决`, conflicted: true, restored: !still }
      }
    }

    // 合成了(干净合并,或者解完并提交)。**进锁快进** —— 毫秒级,没有模型调用。
    const head = await deps.git(['rev-parse', 'HEAD'], path)
    if (head.code !== 0) {
      return { ok: false, why: `读不出临时合并工作区的 HEAD: ${head.stderr.trim()}`, conflicted: false, restored: true }
    }
    const sha = head.stdout.trim()
    const ff = await deps.withIntegrationLock(() =>
      deps.git(['merge', '--ff-only', '--no-verify', sha], deps.integrationPath))
    if (ff.code === 0) {
      /**
       * **合成了就把临时工作树收掉。**
       *
       * 它是一棵**完整检出**,建在 `.efftask-worktrees/merge-scratch`,而
       * `cleanupWorktrees`(`c` 键)、`finishHandoff`、`dispose` 都不认识它 ——
       * 验收点名:这一轮的起因就是跑机 916 G 撑满,而这个功能自己往那儿永久多放一份仓库。
       *
       * 只在**成功**这条路上收:失败时那棵树是现场(报错里指着它让人去处理)。
       * 收不掉不算失败 —— 下一次进来 `stageAt` 会复用它。
       */
      await deps.git(['worktree', 'remove', '--force', path], deps.gitRoot)
      return { ok: true, advanced: true, resolvedFiles, rounds: spent }
    }
    /**
     * 快进不成立 = 这期间集成分支被推进过(编排器合了别的节点)。**回第 1 步重来**,
     * 而**绝不退回普通 merge** —— 那会在共享的集成工作区里造一次没人预料的三方合并,
     * 而它撞冲突的话,现场就留在所有人共用的那棵树里。
     */
    deps.onProgress?.('集成分支在这期间前进了,重新同步后再合一次…')
  }
  return {
    ok: false,
    why: '集成分支在解冲突期间反复前进,重试 3 次仍未合上 —— 请等编排器空下来再试',
    conflicted: false,
    restored: true,
  }
}

export type TrunkSyncResult =
  | { ok: true; advanced: boolean; message: string; resolvedFiles: string[] }
  | { ok: false; why: string; followUps: string[] }

/**
 * **集成分支 → 你当前的分支。先同步主干,再迭代解冲突,最后快进。**
 *
 * 用户原话(需求 7):「合并冲突,要先同步主干,然后迭代解决冲突合并提交。」
 *
 * ## 方向是反的,而这正是关键
 *
 * 直觉写法是在 `gitRoot` 里 `git merge <集成分支>` —— 那是 `intoTrunk` 今天做的事,
 * 而它撞冲突**只能无条件 abort**:冲突现场会落在**用户正在用的目录**里,那是唯一
 * 不能拿来当解冲突现场的地方(他自己的编辑器、他自己的 git status 全在那儿)。
 *
 * 所以反过来做:**先把用户的分支合进集成分支**(在临时工作树里,模型在那儿解),
 * 之后 `集成分支` 就包含了用户分支的全部提交 —— 回主干那一跳**自然成为快进**,
 * 用户的检出一次三方合并都不会经历,更不会被留在半合并态。
 *
 * 顺带兑现的还有一件事:之后每个节点 `acquire` 出来的基线都含有用户自己那几笔提交,
 * 而「任务开始先从主干同步」在他动过手之后一直是假的(`intoTrunk` 里那次反向 `--ff-only`
 * 只在合成功时才跑,撞冲突就根本到不了)。
 *
 * ## 四条早退,判据与 `intoTrunk` 同源
 *
 * 屏幕上写着的「合不了,因为 X」必须就是一会儿真的会挡住它的那个 X。
 */
export async function syncTrunk(
  deps: IntegrationMergeDeps & {
    /** 用户的工作区脏不脏。判据只看**已跟踪**改动 —— 见 handoffActions.trackedChanges。 */
    trackedDirty: () => Promise<{ dirty: boolean; detail?: string }>
  },
): Promise<TrunkSyncResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deps.signal?.aborted) return { ok: false, why: '已中断', followUps: [] }

    const head = await deps.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], deps.gitRoot)
    const branch = head.stdout.trim()
    if (head.code !== 0 || branch.length === 0) {
      return {
        ok: false,
        why: '当前是 detached HEAD(不在任何分支上)—— 合过去的提交不会留在任何分支上',
        followUps: [`先 git switch 回你自己的分支,再试一次;产出仍在 ${deps.integrationBranch} 上`],
      }
    }
    if (branch === deps.integrationBranch) {
      return {
        ok: false,
        why: `你的主检出停在集成分支 ${branch} 上(集成工作区也占着它)`,
        followUps: ['请先 git switch 回你自己的分支'],
      }
    }
    // 已经是最新的 —— 没什么可合,而这不是失败。
    const contained = await deps.git(['merge-base', '--is-ancestor', deps.integrationBranch, 'HEAD'], deps.gitRoot)
    if (contained.code === 0) {
      return { ok: true, advanced: false, message: `${branch} 上已经有集成分支的全部提交`, resolvedFiles: [] }
    }
    /**
     * **脏树不再前置挡 —— 让 git 去判。**
     *
     * 这里原来是「只要有任何一个已跟踪文件是脏的就整个拒绝」,理由写的是「你的改动不该
     * 被一次合并卷进来」。真 git 上量过,那个担心不成立、而代价极大:
     *
     *  · 合并碰不到那几个脏文件 → 直接成功,用户的改动**毫发无损**留在工作区里
     *    (merge 提交只含已提交的内容,它不会卷进未提交的东西);
     *  · 真要覆盖 → git 当场拒绝并**一个字节不动**,而下面已经逐条认得出它的原话。
     *
     * git 的保护是**逐文件**的,这道闸是「一处脏就全不合」。跑机实测(qianbase-xtp
     * run 001):3 个不相干的脏文件把 607 个提交全堵在集成分支上,用户原话「这个不应该
     * 自动合进来吗」。
     *
     * `trackedDirty` 这个 dep 仍然留着 —— C 节那一档(先 stash 再合)要用它决定
     * 「值不值得提供」,而**判据不再由它来做**。
     */

    /**
     * **第一步:把主干合进集成分支。** 冲突(如果有)在临时工作树里由模型解掉,
     * 用户的检出一个字节都不会被碰到。
     */
    const behind = await deps.git(['merge-base', '--is-ancestor', branch, deps.integrationBranch], deps.gitRoot)
    let resolvedFiles: string[] = []
    if (behind.code !== 0) {
      deps.onProgress?.(`先把 ${branch} 同步进集成分支…`)
      const sync = await mergeIntoIntegration(
        deps, branch,
        `正在合入的这一半是**用户自己的分支** ${branch} —— 他在这一趟运行期间自己提交的东西。` +
        `冲突时两边都要保住:集成分支这一侧是本次运行产出的成果,他那一侧是他自己的工作,` +
        `任何一边被丢掉都是数据丢失。`,
      )
      if (!sync.ok) {
        return {
          ok: false,
          why: `把你的分支 ${branch} 同步进集成分支时失败:${sync.why}`,
          followUps: sync.restored
            ? [`集成分支和你的分支都原样保留,你的工作区没有被碰过`]
            : [`临时合并工作区 ${deps.worktreeRoot}/merge-scratch 里留着一次没完成的合并,请去处理`],
        }
      }
      resolvedFiles = sync.resolvedFiles
    }

    /**
     * **第二步:快进。** 走到这里集成分支已经包含用户分支的全部提交,所以这是快进 ——
     * 但**不是无条件的**:他完全可能在上一步那几分钟里又提交了一笔。
     * 那时回第 1 步重来(有界),而**绝不退回普通 merge** —— 实测那条路会在他的检出里
     * 留下 `UU` 和活的 MERGE_HEAD,而这整条改造存在的理由就是别让那件事发生。
     */
    const ff = await deps.git(['merge', '--ff-only', '--no-verify', deps.integrationBranch], deps.gitRoot)
    if (ff.code === 0) {
      return {
        ok: true, advanced: true, resolvedFiles,
        message: `已把集成分支合回 ${branch}${resolvedFiles.length > 0 ? `(解决了 ${resolvedFiles.length} 个冲突文件)` : ''}`,
      }
    }
    /**
     * 未跟踪文件挡住的那一种是**良性**的:实测 git 拒绝并且**一个字节都不动**
     * (`error: The following untracked working tree files would be overwritten by merge`),
     * 文件原样留在原处、树干净、没有半合并态。它重试也不会好,直接如实说。
     */
    const msg = ff.stderr.trim() || ff.stdout.trim()
    if (msg.includes('untracked working tree files')) {
      return {
        ok: false,
        why: '你的目录里有未跟踪的文件会被这次合并覆盖,git 拒绝了(你的文件原样保留,没有任何东西被改动)',
        followUps: [msg.split('\n').slice(0, 5).join(' / ')],
      }
    }
    /**
     * **已跟踪文件撞上,是另一种良性拒绝 —— 而它此前掉进了重试循环。**
     *
     * git 的原话是 `error: Your local changes to the following files would be overwritten
     * by merge:` + 文件名。和上面那一种一样:git 当场拒绝、**一个字节都不动**、没有半
     * 合并态。它重试也不会好 —— 而底下那句「你在同步期间反复提交,重试 3 次仍未合上」
     * 是**一条假原因**:用户根本没有反复提交,他只是有几个文件没存。
     *
     * 这一条是「让 git 去判」那条路的另一半:前置脏闸拿掉之后,这里必须认得出 git 的
     * 每一种回答,否则拿掉闸只是把一句诚实的拒绝换成了一句瞎猜。
     */
    if (msg.includes('Your local changes to the following files would be overwritten')) {
      // 文件名在**后面几行** —— 第一行是一句没有宾语的话(和 untracked 那一串同一个形状)。
      const files = msg.split('\n').map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('error:') && !l.startsWith('Please') && !l.startsWith('Aborting'))
      return {
        ok: false,
        why: `你有未提交的改动正好落在这次合并要改的文件上,git 拒绝了(你的改动原样保留,没有任何东西被改动)${files.length > 0 ? `:${files.slice(0, 5).join('、')}` : ''}`,
        followUps: ['提交或 stash 这几个文件之后再按一次;产出仍在集成分支上,一个字节都没丢'],
      }
    }
    deps.onProgress?.('你在这期间又提交了 —— 重新同步一次再合…')
  }
  return {
    ok: false,
    why: '你在同步期间反复提交,重试 3 次仍未合上',
    followUps: ['等手上的提交告一段落再按一次;产出仍在集成分支上,一个字节都没丢'],
  }
}
