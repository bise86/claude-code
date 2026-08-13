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
async function stageAt(
  deps: IntegrationMergeDeps, path: string, tip: string,
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
  // 复用。先把可能存在的半合并态收掉,再对齐到 tip。
  const inMerge = await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)
  if (inMerge.code === 0) await deps.git(['merge', '--abort'], path)
  const co = await deps.git(['checkout', '--detach', tip], path)
  if (co.code !== 0) return { ok: false, why: `临时合并工作区切不到集成分支: ${co.stderr.trim()}` }
  await deps.git(['reset', '--hard', tip], path)
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
    if (ff.code === 0) return { ok: true, advanced: true, resolvedFiles, rounds: spent }
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
     * 脏树先挡。**只看已跟踪的改动** —— `/et` 自己就在用户检出里写 `.claude/efftask/`,
     * 按 `status --porcelain` 判会让这个功能在正常仓库里一次都不发生
     * (`trackedChanges` 为同一件事付过学费)。
     */
    const dirty = await deps.trackedDirty()
    if (dirty.dirty) {
      return {
        ok: false,
        why: '你的工作区有未提交的改动(已跟踪文件)—— 你的改动不该被一次合并卷进来',
        followUps: [
          '先提交或 stash,再试一次',
          ...(dirty.detail ? [`改动:${dirty.detail}`] : []),
        ],
      }
    }

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
    deps.onProgress?.('你在这期间又提交了 —— 重新同步一次再合…')
  }
  return {
    ok: false,
    why: '你在同步期间反复提交,重试 3 次仍未合上',
    followUps: ['等手上的提交告一段落再按一次;产出仍在集成分支上,一个字节都没丢'],
  }
}
