import { descendantsOf } from './redo.js'
import { isTerminal } from './stateMachine.js'
import { writeNode, type FsLike } from './persistence.js'
import { autoResolveMerge, runHandoffChoice, type ConflictResolver, type GitFn } from './handoffActions.js'
import type { MergeResult } from './worktreePool.js'
import type { TaskNode } from './types.js'

/**
 * 手动把一棵子树里**还没合进主干**的隔离工作区合并掉 —— 详情页那个 `m` 键。
 *
 * 用户原话:「如果任务树上有 worktree 没有合并到主干,进入任务详情页,可以手动触发合并
 * 提交,并且包括所有孙子任务。如果合并遇到问题用主模型解决并且进行合并提交。」
 *
 * ## 「主干」是两跳,不是一跳
 *
 * 一个节点的产出要落到用户眼前的目录,要走两次合并:
 *   1. 节点分支 → **集成分支**(`pool.commitAndMerge`);
 *   2. 集成分支 → **用户当前的分支**(`intoTrunk`,由第 1 步在成功时自己带着跑)。
 *
 * 两跳都可能停在半路,而且原因完全不同:第 1 跳停在冲突上(节点被阻断,产出锁在它自己的
 * 分支里),第 2 跳停在「你的工作区脏 / 你在 detached HEAD 上 / 你自己回退过这一趟的提交」
 * 上(`intoTrunk` 的那几条判据 —— 它们是**故意**不自动越过的)。所以这个键必须两跳都做,
 * 而且**第 2 跳要单独再做一次**:第 1 跳可能一个节点都不用合(全都合过了),而东西照样
 * 卡在集成分支上没送到用户的分支。
 *
 * ## 为什么复用 `pool.commitAndMerge`,而不是自己写一遍 git
 *
 * `cleanupWorktrees` 的开头记着相反的选择(它**不能**复用 `release()`,因为判据不同)。
 * 这里正相反:判据要的**逐字就是**自动路径那一份 —— 未解决的冲突要拒、合并提交里带
 * `<<<<<<<` 要拒、集成工作区脏了要先洗再重试、合成功要立刻往用户分支送一次。第二份实现
 * 会在其中任何一条上悄悄分叉,而分叉的方向必然是「手动这条更松」,那正是这个仓库
 * 「宁可重做,不可谎报」要挡的东西。
 *
 * 同理,冲突走的也是自动路径那条:`mergeIntegrationIntoNode` 把集成分支合进**节点自己的
 * 工作区**、把冲突留在那里(它存在的理由见 worktreePool 里那一大段:合并发生在共享的
 * 集成工作区里,冲突报出来的那一刻节点的树是干净的,派人去那里解等于派他去一个没有现场
 * 的目录),解完由 **git 复核**(`autoResolveMerge`:还有未合并路径、暂存区里还留着
 * 冲突标记、commit 不成 —— 任何一条都算没解成)。
 *
 * ## 和跑着的编排器抢集成工作区
 *
 * 集成工作区只有一个 index、一个检出。`commitAndMerge` 自己带 `mergeLock`,所以逐个节点
 * 那一跳天然排队;这个模块额外要锁的只有一处 —— 第 2 跳之后那次「把用户分支反向快进回
 * 集成分支」(见 `mergeToTrunk`),它在 `intPath` 里跑。**解冲突那次模型调用不在锁里**:
 * 它发生在节点自己的工作区,而把一次几分钟的模型调用关进 mergeLock 会让整棵树的合并停摆。
 *
 * ## 不改任务的判决
 *
 * 合并是 git 上的事,不是「这个任务通过了」。所以这里**一个 status 都不动**,
 * `mergeConflict` 也不清 —— 它是 `--resume` 唯一一把能把冲突阻断的节点重新叫起来的钥匙
 * (见 reseat 的 `awaitingHumanMerge`),清掉它等于让那个节点永远躺在 BLOCKED 上。
 * 唯一写回 node.md 的是 `execStatus` 上一句注记,好让盘上留下「这次合并是人手动触发的」
 * 这个事实。
 */

/** 这个模块用到的池子接口。结构化声明,方便测试直接塞一个**真的**池子进来。 */
export interface SubtreeMergePool {
  integrationBranchName: string
  integrationPath: string
  gitRoot: string
  worktreePathOf(node: TaskNode): string
  worktreeBranchOf(node: TaskNode): string
  commitAndMerge(node: TaskNode): Promise<MergeResult>
  mergeIntegrationIntoNode(node: TaskNode): Promise<
    | { ok: true; conflicted: false }
    | { ok: true; conflicted: true; files: string[] }
    | { ok: false; message: string }
  >
  withIntegrationRead<T>(fn: () => Promise<T>): Promise<T>
}

export interface SubtreeMergeDeps {
  pool: SubtreeMergePool
  git: GitFn
  /**
   * 派主模型去解冲突。**不给 = 撞了冲突就如实报告**(而不是假装没有这个功能):
   * 用户原话里「用主模型解决」是这个键的一半,但一个拿不到模型接缝的调用方
   * (理论上不该有)不该因此把冲突现场悄悄毁掉。
   */
  resolve?: ConflictResolver
  /** 合完把注记写回 node.md。缺省 = 只动 git。 */
  persist?: { fs: FsLike; runDir: string }
  /** 一条一条往界面上推的进度。这一路会跑好几分钟(每个冲突都是一次模型调用)。 */
  onProgress?: (line: string) => void
  onError?: (e: Error) => void
  signal?: AbortSignal
  /** 时间戳。注入是为了让注记那一行可断言。 */
  now?: () => string
  /** 编排器还在跑吗 —— 只影响确认屏上那句提醒。 */
  runActive?: boolean
}

/** 一个**要合**的工作区。 */
export interface SubtreeMergeItem {
  nodeId: string
  title: string
  status: TaskNode['status']
  path: string
  branch: string
  /** 这条分支上、集成分支还没有的提交数。 */
  commits: number
  /** 工作区里还没提交的条目数 —— 合并会先把它们提交掉,所以要先说。 */
  loose: number
}

/** 一个**不合**的工作区,以及为什么。 */
export interface SubtreeMergeSkip {
  nodeId: string
  title: string
  why: string
}

/** 第 2 跳:集成分支 → 用户当前分支。 */
export interface TrunkPlan {
  /** 用户当前所在的分支。detached HEAD 时缺席。 */
  branch?: string
  /** 集成分支上还没到那条分支的提交数。 */
  pending: number
  /** 现在就知道合不了的原因(detached / 停在集成分支上 / 工作区脏)。 */
  blocked?: string
}

export interface SubtreeMergePlan {
  targetId: string
  items: SubtreeMergeItem[]
  skipped: SubtreeMergeSkip[]
  /** 血统里已经合过了的节点数。 */
  alreadyMerged: number
  /** 血统里盘上根本没有工作区目录的节点数。 */
  absent: number
  trunk: TrunkPlan
  /** 有没有解冲突的人。没有就要在屏幕上说清楚:撞了冲突这一趟只会停下来报告。 */
  canResolve: boolean
  /** 编排器还在跑 —— 屏幕上要提醒:合并会和它抢同一条集成分支。 */
  runActive: boolean
}

export interface SubtreeMergeOutcome {
  merged: { nodeId: string; title: string; commits: number; resolvedFiles?: string[] }[]
  failed: { nodeId: string; title: string; why: string; followUps: string[] }[]
  /** 第 2 跳的结果。`undefined` = 根本没走到那一步(中途被取消)。 */
  trunk?: { ok: boolean; message: string; followUps: string[] }
  /** 合是合了,但别的地方没做干净(集成工作区被清掉的东西、注记没写回)。 */
  problems: string[]
  /** 被 Esc / run 级中止打断,后面的节点没动。 */
  aborted: boolean
}

const oneLine = (s: string): string => s.trim().split('\n').filter(Boolean).slice(0, 3).join('; ')

/** node.md 上那句注记的前缀。去重判据用它 —— 见 `noteMerged`。 */
export const MANUAL_MERGE_NOTE = '(手动合并:由用户在详情页触发于 '

/**
 * 本次合并的范围:目标节点自己 + `childIds` 递归下去的**全部后代**。
 *
 * **纯函数**,确认屏预演和真正执行共用同一份(两边各算一次的话,用户是照着屏幕按的确认,
 * 而实际发生的可以是另一回事 —— cleanupWorktrees 为同一条规矩写过注释)。
 *
 * 血统走 `childIds` 不走 `deps`:依赖是横向引用,顺着它走会从任意一个节点漫到整棵树,
 * 而用户按的是「这个任务」的键。`descendantsOf` 自带环保护(childIds 是可手工编辑的)。
 */
export function subtreeMergeScope(
  nodes: readonly TaskNode[], targetId: string,
): { target?: TaskNode; scope: TaskNode[] } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { scope: [] }
  const kids = descendantsOf(target, byId).map(id => byId.get(id)).filter((n): n is TaskNode => n !== undefined)
  return { target, scope: [target, ...kids] }
}

/**
 * 探一遍盘上的真实状态,算出「按下确认之后会发生什么」。
 *
 * 每个候选节点问四件事,顺序有讲究:
 *  1. **目录还在吗** —— 不在就什么都不用说(那一趟没隔离 / 已经清掉了);
 *  2. **它的提交是不是已经全在集成分支里** —— 已经在的不用合;
 *  3. **它还在跑吗** —— 在跑的**不合**,见下面那一段;
 *  4. **有多少提交、多少没提交的东西** —— 都要摆到屏幕上,合并会把后者一并提交掉。
 */
export async function scanSubtreeMerge(
  deps: SubtreeMergeDeps, nodes: readonly TaskNode[], targetId: string,
): Promise<SubtreeMergePlan> {
  const { pool, git } = deps
  const { scope } = subtreeMergeScope(nodes, targetId)
  const items: SubtreeMergeItem[] = []
  const skipped: SubtreeMergeSkip[] = []
  let alreadyMerged = 0
  let absent = 0

  for (const node of scope) {
    const path = pool.worktreePathOf(node)
    const branch = pool.worktreeBranchOf(node)
    const there = await git(['rev-parse', '--git-dir'], path)
    if (there.code !== 0) { absent++; continue }
    /**
     * 判据问 **HEAD**,不问分支名:分支可能已经被 `release()` 删掉而目录还在,而工作区里
     * HEAD 就是它的 tip(`cleanupWorktrees` 和 `acquire` 的抢救分支判据用的都是这一条)。
     *
     * `code === 1` 才是「真的没合入」;别的非零是 git 自己出问题(路径坏了、ref 不存在)。
     * 把探测失败当成一个确定的答案,是在一个已经出问题的工作区上做写操作。
     */
    const merged = await git(['merge-base', '--is-ancestor', 'HEAD', pool.integrationBranchName], path)
    if (merged.code === 0) { alreadyMerged++; continue }
    if (merged.code !== 1) {
      skipped.push({
        nodeId: node.id, title: node.title,
        why: `无法判断提交是否已合入(git 探测失败:${merged.stderr.trim() || `退出码 ${merged.code}`})`,
      })
      continue
    }
    /**
     * **还在跑的节点不合。**
     *
     * 那棵树此刻正被一个执行者写着:`commitAndMerge` 的第一句是 `git add -A` + commit,
     * 于是半句写到一半的代码会带着一次真实的 merge commit 落到用户的分支上 ——
     * `finishHandoff` 为同一件事拒绝过自动合并(「半成品会带着一次真实的 merge commit
     * 落到他的分支上」)。而它跑完之后**本来就会自己合一次**,等它就是了。
     *
     * 判据是 `isTerminal`(ACCEPTED / BLOCKED),不是 `ACCEPTED`:被阻断的节点恰恰是这个
     * 键最主要的服务对象 —— 它的产出锁在自己的分支里,没有任何自动路径会再来合它。
     */
    if (!isTerminal(node.status)) {
      skipped.push({
        nodeId: node.id, title: node.title,
        why: `还没跑完(${node.status})—— 它的工作区正被执行者写着,跑完会自己合一次`,
      })
      continue
    }
    /**
     * **工作区里有一次没解完的合并 = 一个字都不碰。**
     *
     * 这道闸拦的是这条路上最坏的一个结局:`git add -A` 作用在一棵还挂着 `MERGE_HEAD` 的树上
     * 会把每一个冲突路径**标记成已解决** —— 连同里面的 `<<<<<<<` 一起 —— 而紧接着的 commit
     * 是一次真正的合并提交,它会一路快进到集成分支,再从那里进用户的分支。worktreePool 为
     * 同一件事在 `commitAndMerge` 顶上写了一道拒绝(「Measured: markers shipped, node
     * ACCEPTED, nobody paged」),但那道只看**未合并路径**:一份已经 `git add` 过、
     * 只差一次 commit 的解决没有任何未合并路径,却照样带着标记。
     *
     * 两种现场都拦,而且是**在扫描里**拦:确认屏不该承诺一件一会儿会被拒绝的事。
     * 拦下来不是丢下不管 —— 屏幕上给的是能照做的下一步,而那个目录里的东西一个字节没动。
     */
    const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], path)
    const inMerge = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path)
    if (unmerged.stdout.trim().length > 0 || inMerge.code === 0) {
      skipped.push({
        nodeId: node.id, title: node.title,
        why: `工作区里有一次没解完的合并(冲突现场还在,或者有一份已 git add、还没提交的解决)——` +
          `请到 ${path} 解完并 git commit,再按一次 m`,
      })
      continue
    }
    const count = await git(['rev-list', '--count', `${pool.integrationBranchName}..HEAD`], path)
    const commits = Number.parseInt(count.stdout.trim(), 10) || 0
    // `--ignored` 不带:构建产物会被 `git add -A` 跳过(它不暂存被忽略的文件),把它们
    // 数进「会被一并提交的内容」是一句精确的假话。回收那个键才需要 `--ignored`。
    const st = await git(['-c', 'core.quotepath=false', 'status', '--porcelain'], path)
    const lines = st.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    items.push({
      nodeId: node.id, title: node.title, status: node.status, path, branch,
      commits, loose: lines.length,
    })
  }

  return {
    targetId,
    /**
     * **按完成时间排**,拿不到时间的按 id。
     *
     * 这是它们本来会被合进去的顺序(自动路径就是一个节点跑完合一次),而合并顺序会实打实
     * 改变冲突落在谁头上。乱序不是错,但不可复现的顺序会让「上次报的冲突这次换了个节点」
     * 变成没人能解释的事。
     */
    items: items.sort((a, b) => {
      const ta = nodes.find(n => n.id === a.nodeId)?.finishedAt ?? ''
      const tb = nodes.find(n => n.id === b.nodeId)?.finishedAt ?? ''
      if (ta !== tb) return ta === '' ? 1 : tb === '' ? -1 : ta < tb ? -1 : 1
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
    }),
    skipped,
    alreadyMerged,
    absent,
    trunk: await scanTrunk(deps),
    canResolve: deps.resolve !== undefined,
    runActive: deps.runActive === true,
  }
}

/**
 * 第 2 跳的现状。判据和 `intoTrunk` 逐字同源 —— 屏幕上写着的「合不了,因为 X」必须就是
 * 一会儿真的会挡住它的那个 X。
 */
async function scanTrunk(deps: SubtreeMergeDeps): Promise<TrunkPlan> {
  const { pool, git } = deps
  const root = pool.gitRoot
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  const branch = head.stdout.trim()
  const count = await git(['rev-list', '--count', `HEAD..${pool.integrationBranchName}`], root)
  const pending = Number.parseInt(count.stdout.trim(), 10) || 0
  if (head.code !== 0 || branch.length === 0) {
    return { pending, blocked: '当前是 detached HEAD(不在任何分支上)—— 合过去的提交不会留在任何分支上' }
  }
  if (branch === pool.integrationBranchName) {
    return {
      branch, pending,
      blocked: `你的主检出停在集成分支 ${branch} 上(集成工作区也占着它)——` +
        `请先 git switch 回你自己的分支`,
    }
  }
  // 未跟踪文件不算脏:`/et` 自己就在用户的检出里写 `.claude/efftask/`,按 `status --porcelain`
  // 判会让这个功能在正常仓库里一次都不发生(handoffActions.trackedChanges 为此付过学费)。
  const worktree = await git(['diff', '--quiet'], root)
  const staged = await git(['diff', '--cached', '--quiet'], root)
  if (worktree.code > 1 || staged.code > 1) {
    return { branch, pending, blocked: '无法判断你的工作区是否干净(git diff 失败)' }
  }
  if (worktree.code !== 0 || staged.code !== 0) {
    return {
      branch, pending,
      blocked: '你的工作区有未提交的改动(已跟踪文件)—— 先提交或 stash,你的改动不该被一次合并卷进来',
    }
  }
  return { branch, pending }
}

/**
 * 真的合。**只对 `scanSubtreeMerge` 挑出来的那些**,一个都不多。
 *
 * 每个节点最多两次 `commitAndMerge`:第一次撞冲突 → 派主模型在**节点自己的工作区**里解
 * (集成分支合进去、冲突留在那儿)→ git 复核 + 提交 → 第二次合(此时是快进)。
 * 解不成就如实报告并停在这个节点上,不往下瞒。
 */
export async function runSubtreeMerge(
  deps: SubtreeMergeDeps, plan: SubtreeMergePlan, nodes: readonly TaskNode[],
): Promise<SubtreeMergeOutcome> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: SubtreeMergeOutcome = { merged: [], failed: [], problems: [], aborted: false }
  const note = (s: string): void => deps.onProgress?.(s)

  for (const item of plan.items) {
    if (deps.signal?.aborted) { out.aborted = true; break }
    const node = byId.get(item.nodeId)
    if (!node) {
      out.problems.push(`${item.title}:节点已经不在树上了,跳过`)
      continue
    }
    note(`合并「${item.title}」(${item.commits} 个提交)…`)
    let res = await deps.pool.commitAndMerge(node)
    let resolvedFiles: string[] | undefined

    if (!res.ok && res.kind === 'conflict') {
      if (!deps.resolve) {
        out.failed.push({
          nodeId: item.nodeId, title: item.title,
          why: `撞了合并冲突(${item.branch}),而这一趟没有可用的解冲突模型`,
          followUps: [
            `冲突文件:${res.files.slice(0, 5).join('、')}${res.files.length > 5 ? ` 等 ${res.files.length} 个` : ''}`,
            `产出仍在分支 ${item.branch} 上,一个字节都没丢`,
          ],
        })
        recordCleaned(out, item.title, res)
        continue
      }
      note(`「${item.title}」撞了冲突(${res.files.length} 个文件),派主模型解决…`)
      const fixed = await resolveInNode(deps, node, item)
      if (!fixed.ok) {
        out.failed.push({
          nodeId: item.nodeId, title: item.title,
          why: `冲突自动解决未成功:${fixed.why}`,
          followUps: fixed.followUps,
        })
        recordCleaned(out, item.title, res)
        continue
      }
      resolvedFiles = fixed.files
      note(`「${item.title}」冲突已解决(${fixed.files.length} 个文件),重新合并…`)
      // 解完再合一次。**照旧走 commitAndMerge** —— 它那道「合并提交里带 <<<<<<<」的扫描
      // 正是为一份糊弄过去的解决准备的,绕过去等于把最需要它的那一次放行。
      res = await deps.pool.commitAndMerge(node)
    }

    recordCleaned(out, item.title, res)
    if (!res.ok) {
      out.failed.push({
        nodeId: item.nodeId, title: item.title,
        why: res.kind === 'conflict'
          ? `解决之后仍然合不上(冲突文件:${res.files.slice(0, 5).join('、')})`
          : `合并失败(基础设施):${oneLine(res.message)}`,
        followUps: [`产出仍在分支 ${item.branch} 上,工作区在 ${item.path}`],
      })
      continue
    }
    /**
     * `merged: false` = 到这一步已经没什么可合了(极少见:扫描和执行之间编排器自己合掉了)。
     * **仍然算成功**,但提交数如实写 0 —— 报一个扫描时的旧数字会让人以为这次真的搬了东西。
     */
    out.merged.push({
      nodeId: item.nodeId, title: item.title,
      commits: res.merged ? item.commits : 0,
      ...(resolvedFiles && resolvedFiles.length > 0 ? { resolvedFiles } : {}),
    })
    // 第 1 跳成功时 `commitAndMerge` 自己会往用户分支送一次;没送成的原因照旧要说出来,
    // 但**不在这里报成失败** —— 下面 mergeToTrunk 会带着解冲突的人再试一次。
    if (res.trunk && res.trunk.advanced === false && res.trunk.reason) {
      note(`「${item.title}」已合入集成分支,但还没送到你的分支:${res.trunk.reason}`)
    }
    await noteMerged(deps, node, out)
  }

  if (!out.aborted) {
    note('把集成分支合回你当前的分支…')
    out.trunk = await mergeToTrunk(deps)
  }
  return out
}

/** 集成工作区里被 `clean -fd` 抹掉的东西 —— **每一条出口都要留痕**,静默清理和静默截断同类。 */
function recordCleaned(out: SubtreeMergeOutcome, title: string, res: MergeResult): void {
  if (res.cleaned && res.cleaned.length > 0) {
    out.problems.push(`${title}:合并前集成工作区有未提交改动,已清理后重试(被清理的:${res.cleaned.join('、')})`)
  }
}

/**
 * 在**节点自己的工作区**里解冲突。
 *
 * 方向是「集成分支 → 节点工作区」,不是反过来:`commitAndMerge` 在共享的集成工作区里合,
 * 失败后 `reset --hard` + `clean -fd`,所以冲突被报出来的那一刻节点的树是**干净的** ——
 * 派人去那里「解决冲突」是派他去一个没有现场的目录(worktreePool 里为这件事记过一次实测:
 * 解决者什么都没找到、验收照样点头、第二次合并撞出一模一样的冲突)。
 *
 * 模型说自己解完了**不算数**:`autoResolveMerge` 一律拿 git 复核(未合并路径、暂存区里的
 * 冲突标记、commit 成不成),不过就 `git merge --abort` 把节点工作区还原。
 */
async function resolveInNode(
  deps: SubtreeMergeDeps, node: TaskNode, item: SubtreeMergeItem,
): Promise<{ ok: true; files: string[] } | { ok: false; why: string; followUps: string[] }> {
  const intBranch = deps.pool.integrationBranchName
  /**
   * **再量一次**「这棵树里有没有一次没解完的合并」。
   *
   * 扫描那一遍已经拦过同一件事,但这里离它可能隔着好几分钟和好几次模型调用(前面每个
   * 冲突节点都是一次),而这中间跑着的编排器完全可能在自己的解冲突循环里把这棵树留成
   * 半合并态。判据和理由与扫描那一处逐字相同 —— 越过它的代价是把 `<<<<<<<` 提交进
   * 集成分支再送进用户的分支,那是这条路上最坏的一个结局。
   */
  const unmerged = await deps.git(['diff', '--name-only', '--diff-filter=U'], item.path)
  const inMerge = await deps.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], item.path)
  if (unmerged.stdout.trim().length > 0 || inMerge.code === 0) {
    return {
      ok: false,
      why: '节点工作区里有一次没解完的合并(冲突现场还在,或者有一份已 git add、还没提交的解决)',
      followUps: [
        `没有动那个目录:${item.path}`,
        '请在那里解完冲突并 git commit,再按一次 m',
      ],
    }
  }
  const into = await deps.pool.mergeIntegrationIntoNode(node)
  if (!into.ok) {
    return {
      ok: false, why: `无法在节点工作区重现冲突:${oneLine(into.message)}`,
      followUps: [`节点工作区在 ${item.path};确认它还在、没有被别的进程占用后可以再按一次 m`],
    }
  }
  // 冲突自己没了(另一侧后来又合进去了什么,正好把它抹平)。没什么可解的,直接去重试合并。
  if (!into.conflicted) return { ok: true, files: [] }
  const auto = await autoResolveMerge({
    git: deps.git, cwd: item.path, branch: intBranch, files: into.files, resolve: deps.resolve!,
  })
  if (auto.ok) return { ok: true, files: into.files }
  return {
    ok: false, why: auto.why,
    followUps: auto.restored
      ? [
        `节点工作区已还原到合并前,分支 ${item.branch} 原样保留`,
        `想自己来:到 ${item.path} 里 git merge ${intBranch},解完冲突后 git commit`,
      ]
      : [
        `**节点工作区里留着一次未完成的合并**(自动还原也失败了):${item.path}`,
        `冲突文件:${into.files.slice(0, 5).join('、')}${into.files.length > 5 ? ` 等 ${into.files.length} 个` : ''}`,
        `解完冲突后 git commit;不想要这次合并就 git merge --abort 回到合并前`,
      ],
  }
}

/**
 * 第 2 跳:集成分支 → 用户当前的分支,**带着解冲突的人**。
 *
 * 复用 `runHandoffChoice('merge', …)`:脏树先挡、撞冲突派模型、解完 git 复核、如实报告 ——
 * 收口那一屏走的就是它。这里唯一多做的是**反向补一次快进**(把用户分支上多出来的东西带回
 * 集成分支),理由见 `intoTrunk`:不补的话,之后每个节点 `acquire` 出来的基线永远看不见
 * 用户自己那几笔提交,而合并冲突正是在那里攒出来的。
 */
async function mergeToTrunk(
  deps: SubtreeMergeDeps,
): Promise<{ ok: boolean; message: string; followUps: string[] }> {
  const { pool, git } = deps
  const root = pool.gitRoot
  const intBranch = pool.integrationBranchName
  const trunk = await scanTrunk(deps)
  if (trunk.blocked !== undefined) {
    return {
      ok: false,
      message: `没有把产出合回你的分支:${trunk.blocked}`,
      followUps: [`产出仍在集成分支 ${intBranch} 上,处理完之后可以再按一次 m,或者自己 git merge ${intBranch}`],
    }
  }
  const contained = await git(['merge-base', '--is-ancestor', intBranch, 'HEAD'], root)
  if (contained.code === 0) {
    return { ok: true, message: `你的分支 ${trunk.branch} 上已经有集成分支的全部提交,不需要再合`, followUps: [] }
  }
  const res = await runHandoffChoice(
    'merge',
    {
      branch: intBranch, commits: trunk.pending, kept: [], salvage: [],
      outcome: 'completed', integrationPath: pool.integrationPath,
    },
    git, root, deps.resolve,
  )
  if (!res.ok) return { ok: false, message: res.message, followUps: res.followUps ?? [] }
  /**
   * 反向快进。`--ff-only`:集成分支此刻是用户分支的祖先(用户分支 = 集成 + 他自己那几笔的
   * 合并),所以快进一定成立;万一不成立说明有人动过集成分支 —— 那就**什么都不做**,
   * 而不是在共享的集成工作区里造一次没人预料的合并。锁着做:`intPath` 是共享的。
   */
  const behind = await git(['merge-base', '--is-ancestor', trunk.branch!, intBranch], root)
  if (behind.code !== 0) {
    await pool.withIntegrationRead(async () => {
      await git(['merge', '--ff-only', trunk.branch!], pool.integrationPath)
    })
  }
  return { ok: true, message: res.message, followUps: res.followUps ?? [] }
}

/** 盘上要留下「这次合并是人手动触发的」这个事实。写失败不影响合并本身,但**要说**。 */
async function noteMerged(deps: SubtreeMergeDeps, node: TaskNode, out: SubtreeMergeOutcome): Promise<void> {
  if (!deps.persist) return
  const at = (deps.now ?? (() => new Date().toISOString()))()
  const line = `${MANUAL_MERGE_NOTE}${at},已把本任务的产出合入集成分支 ${deps.pool.integrationBranchName})`
  /**
   * 同一句注记只写一次。时间戳让每一行都不相同,所以判据比的是**前缀**,不是整行 ——
   * 按 `includes(line)` 判等于没判:连按两次 m、或者一次没合上后重试,execStatus 里就会
   * 叠出两句只有秒数不同的话,而读的人会以为发生了两件事(pipeline 的 noteOnNode 为
   * 同一件事写过注释)。
   */
  if (!node.execStatus.includes(MANUAL_MERGE_NOTE)) {
    node.execStatus = `${node.execStatus}${node.execStatus ? '\n' : ''}${line}`
  }
  try {
    await writeNode(deps.persist.fs, deps.persist.runDir, node)
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    deps.onError?.(err)
    out.problems.push(`${node.title}:合并已完成,但注记没能写回 node.md(${err.message})`)
  }
}

/**
 * 确认屏上的每一行。**是数据,不是 JSX** —— 屏幕上到底承诺了什么要能被断言钉住。
 *
 * ⚠ 开头的行会被上色。次序按用户真正关心的顺序:先说会合几个、合到哪,再说合并会顺手
 * 提交什么,再说**撞了冲突会发生什么**(这一条是这个键和别处最不一样的地方),
 * 最后才是跳过和已完成的明细。
 */
export function subtreeMergeLines(plan: SubtreeMergePlan): string[] {
  const out: string[] = []
  const total = plan.items.reduce((s, i) => s + i.commits, 0)
  out.push(plan.items.length === 0
    ? '这棵子树里没有需要合并的工作区。'
    : `将把 ${plan.items.length} 个任务的隔离工作区(共 ${total} 个提交)合入集成分支:`)
  for (const it of plan.items) {
    const bits = [`${it.commits} 个提交`]
    if (it.loose > 0) bits.push(`另有 ${it.loose} 项未提交内容会被一并提交`)
    out.push(`  · ${it.title} [${it.status}] — ${bits.join(' · ')}`)
  }
  if (plan.items.length > 0) {
    out.push(plan.canResolve
      ? '撞上合并冲突时,会派**主模型**在该任务自己的工作区里解决,解完由 git 复核(还有冲突标记就不算解决,并还原工作区)。'
      : '⚠ 这一趟没有可用的解冲突模型:撞上冲突只会停下来报告,不会自动解决。')
  }
  // 第 2 跳 —— **单独说**。它可能在一个节点都不用合的时候仍然要做,而那正是这个键
  // 最容易被误以为「什么都没发生」的一次。
  if (plan.trunk.blocked !== undefined) {
    out.push(`⚠ 合回你当前分支这一步现在做不了:${plan.trunk.blocked}`)
  } else if (plan.trunk.pending > 0) {
    out.push(`然后把集成分支合回 ${plan.trunk.branch}(现在就有 ${plan.trunk.pending} 个提交没送过去,合完还会更多)。`)
  } else if (plan.items.length > 0) {
    out.push(`然后把集成分支合回 ${plan.trunk.branch}(本次合入的提交会一并送过去)。`)
  } else {
    /**
     * 两边都没事可做。**必须明说**,不能只留上面那句「没有需要合并的工作区」——
     * 用户按这个键多半是因为「我的产出不在目录里」,而这一格的真实答案是
     * 「它已经在了」,那和「有东西没合、只是我没告诉你」是两个完全不同的结论。
     */
    out.push(`集成分支上也没有还没送到 ${plan.trunk.branch} 的提交 —— 这棵子树的产出都已经在你的分支上了。`)
  }
  out.push('任务状态不会被改动:合并只动 git,节点的判决、评审与验收记录原样保留。')
  if (plan.runActive) {
    out.push('⚠ 这一趟还在跑:合并会和编排器共用同一条集成分支,两边按顺序排队(可能要等在飞的那次合并让出来)。')
  }
  if (plan.skipped.length > 0) {
    out.push(`跳过 ${plan.skipped.length} 个:`)
    for (const s of plan.skipped) out.push(`  · ${s.title}:${s.why}`)
  }
  if (plan.alreadyMerged > 0) out.push(`另有 ${plan.alreadyMerged} 个任务的工作区早就合过了。`)
  if (plan.absent > 0) out.push(`另有 ${plan.absent} 个任务在盘上没有工作区目录(清过了,或那一趟没隔离)。`)
  return out
}

/** 合完那一屏的每一行。同上,是数据。 */
export function subtreeMergeResultLines(out: SubtreeMergeOutcome): string[] {
  const lines: string[] = []
  /**
   * 一个都没合成时**不许说「已合并 0 个」**:那句话读起来像一次成功的空操作,而这一格
   * 真实的意思是「你按下了确认,而它全都失败了」(cleanupResultLines 为同一条规矩写过)。
   */
  if (out.merged.length === 0) {
    lines.push('没有合并任何工作区。')
  } else {
    const commits = out.merged.reduce((s, m) => s + m.commits, 0)
    lines.push(`已把 ${out.merged.length} 个任务的产出(${commits} 个提交)合入集成分支。`)
    for (const m of out.merged) {
      if (m.resolvedFiles && m.resolvedFiles.length > 0) {
        lines.push(`  · ${m.title}:主模型解决了 ${m.resolvedFiles.length} 个冲突文件` +
          `(${m.resolvedFiles.slice(0, 3).join('、')}${m.resolvedFiles.length > 3 ? '…' : ''})`)
      }
    }
  }
  if (out.merged.some(m => (m.resolvedFiles?.length ?? 0) > 0)) {
    // 不是客套:自动解冲突挑的是「每个 hunk 留哪一边」,而这次没有任何人复核过。
    lines.push('自动解决的冲突没有经过评审,建议 git show 过一眼。')
  }
  if (out.trunk) {
    lines.push(out.trunk.ok ? out.trunk.message : `⚠ ${out.trunk.message}`)
    for (const f of out.trunk.followUps) lines.push(`  · ${f}`)
  }
  for (const f of out.failed) {
    lines.push(`⚠ ${f.title} 没合上:${f.why}`)
    for (const u of f.followUps) lines.push(`  · ${u}`)
  }
  for (const p of out.problems) lines.push(`⚠ ${p}`)
  if (out.aborted) lines.push('⚠ 被中断了,后面的任务没有动 —— 已经合进去的不会退回来,再按一次 m 可以接着合。')
  return lines
}
