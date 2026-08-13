import { descendantsOf } from './redo.js'
import { AGENT_LOG_NAME } from './agentLog.js'
import { writeNode, type FsLike } from './persistence.js'
import { createNodeJournal } from './nodeJournal.js'
import { scanBuildOutputs, wipeBuildOutputs, type BuildWipePlan } from './buildOutputs.js'
import type { TaskNode } from './types.js'

/**
 * 一键回收**已完成**子任务的隔离工作区 —— 详情页那个 `c` 键。
 *
 * ## 为什么不是再调一次 `pool.release()`
 *
 * `release()` 的判据是「工作区一个字节都不脏(带 `--ignored`)**并且**提交已合入」,而
 * `dispose()` 在每次收口时已经拿它把全树走了一遍。也就是说:**用户此刻还看得见的那些目录,
 * 恰恰全是 `release()` 拒绝过的那些**。原因几乎总是同一个 —— 被忽略的构建产物
 * (`target/`、`dist/`、`.direnv/`),而那正是占空间的大头(用户报的就是这个)。
 * 把这个键接到 `release()` 上,它在真实运行里一个字节都清不掉,而屏幕会显示「已完成」。
 *
 * 所以这里换一条判据,并且**只换一条**:
 *
 *  - **保留的硬闸只剩「提交有没有全部合入集成分支」**。它保护的是*工作*——一个没合入的
 *    提交删掉就真的没了。
 *  - **未提交的残留一律删**(构建产物、未跟踪文件、已跟踪文件的改动)。一个 ACCEPTED 节点
 *    的产出在 `commitAndMerge` 那一刻就已经 `add -A` + commit + 合进集成分支了;之后还留在
 *    那棵树里的东西,来自**验收/测试验证席位在里面跑构建**(run 001 那次 devenv 改写
 *    devenv.lock 就是这一种)。它们不是交付物。
 *  - 但**必须先数出来摆给人看**:确认屏逐节点列出会被删掉的残留条数和目录占用,
 *    「静默清理和静默截断是同一类毛病」(MergeResult.cleaned 的注释,同一个仓库同一条规矩)。
 *
 * ## 范围
 *
 * 目标节点自己 + `childIds` 递归下去的**全部后代**,而且只认 `ACCEPTED`。
 *
 *  - **血统走 `childIds`,不走 `deps`。** 依赖是横向引用:A 依赖 B 不代表 B 归 A 管,
 *    顺着它走会从任意一个节点漫到整棵树,而用户按的是「这个任务」的键。
 *  - **完成 = `ACCEPTED`,不是 `isTerminal`。** BLOCKED 也是终态,而一个阻断节点的工作区
 *    正是唯一还留着现场的地方 —— 升级卡逐字在教用户去那个目录里解冲突。
 *  - **不碰集成工作区**(`.efftask-worktrees/integration`):收口、集成验收、之后每一次
 *    逐任务合并都在它里面发生,而 `init()` 下次运行还会复用它。
 *
 * ## 不删任务记录 —— 只有**一个**例外,而且是被点名要求的
 *
 * 用户原话(第一轮):「不要误删除任务状态等数据。」用户原话(本轮):「绝对不能删除任务的
 * 基本信息和状态,以及各阶段结果状态。」
 *
 * 所以这里删的东西**只有一样**:`agent-log.jsonl` —— 子 agent 的事件流,也就是用户
 * 自己划成「日志这些可丢」的那一份。它是占地大头(单节点最多 8 MB)。
 *
 * **`node.md` 和 `state.jsonl` 一个字节都不碰**,这条不是保守,是判据:
 *  - `node.md` 是任务的基本信息、状态、各阶段结果;
 *  - `state.jsonl` 是它们的**第二条恢复路径**(只增不改的状态账)。而这个键的作用范围
 *    恰恰是 `ACCEPTED` 节点 —— 一个已验收节点的状态是最不能出错的那种:它丢了,
 *    父任务的收口、集成分支的推进全都建立在一个查不回来的「已完成」上。
 *    为了腾几 MB 把第二条恢复路径拆掉,是拿这一整轮 bug 的病根去换空间。
 *
 * 唯一写回 node.md 的仍然只有 `worktree` 那个引用本身(见 `runCleanup`),那是为了让记录
 * 别指着一个已经不存在的目录。
 */

export interface CleanupGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface CleanupDeps {
  git: CleanupGit
  gitRoot: string
  integrationBranch: string
  /** 节点 → 它的工作区目录。由池子给(路径是 hash(nodeId),不是这里能猜的)。 */
  pathFor: (node: TaskNode) => string
  /** 节点 → 它的工作区分支。同上。 */
  branchFor: (node: TaskNode) => string
  /**
   * 目录占用(KB)。**拿不到就返回 undefined,不要编一个数** —— 这个功能的全部卖点是
   * 「腾出多少空间」,一个猜出来的数字比没有数字糟得多。
   */
  dirSizeKb?: (path: string) => Promise<number | undefined>
  /** 清理成功后把 node.worktree 从 node.md 上抹掉。缺省 = 只动 git。 */
  persist?: { fs: FsLike; runDir: string }
  /**
   * **系统临时目录里那些席位自己写的东西。**
   *
   * 跑机实测(qianbase-xtp run 001):`/tmp` 下有 141 个条目、23 GB,最老的躺了 8 天 ——
   * `efftask-001-<slug>-target`、`…-sql-check`、`…-cargo-check.log` 之类。它们不是这一层
   * 造的(`src/tools/efftask/` 全目录没有一处写 `/tmp`),是**子 agent 自己**为了不把
   * 构建产物塞进工作树而写出去的,所以工作树被删掉时它们一个都不会跟着走。
   *
   * 接缝按 **slug 精确匹配**,不按前缀猜:`worktreeSlug` 是 `hash(nodeId)` 算出来的,
   * 名字里带着它的那些条目和这个节点是一一对应的关系,而「以 efftask 开头」会连上
   * 别的 run(用户机器上同时存在 001 和 etcd3 那两趟)。
   */
  scratch?: {
    /** 列出名字里含有其中任一 slug 的顶层条目。量不到大小就留 undefined,不编 0。 */
    list: (slugs: readonly string[]) => Promise<{ path: string; kb?: number }[]>
    /** 删掉一个条目(可能是目录,也可能是单个文件)。 */
    remove: (path: string) => Promise<void>
  }
  /**
   * 集成工作区的路径。**给了才会清它的构建产物**。
   *
   * 这个目录本身**永远不删** —— 收口、集成验收、之后每一次逐任务合并都在它里面发生,
   * `init()` 下次运行还要复用它。清的只有 `git clean -X` 认定的**被忽略**的那些
   * (跑机上是 22 GB 的 `target/`)。未跟踪但没被忽略的文件一个都不碰:那可能是一次
   * 正在进行的冲突解决留下的现场,而它和构建产物长得完全不一样。
   */
  integrationPath?: string
  /**
   * 此刻**真的有一步在跑**的节点 id(`orchestrator.runningNodeIds()`)。
   *
   * 只给「清构建产物」那两桶用,而且是硬闸:一个正在被执行者写着的工作区,连它的
   * `target/` 都不能动 —— 一次跑到一半的增量编译被抽掉产物,最好的结果是重编,
   * 最坏的结果是工具链拿着半个目录报一堆看不懂的错,而用户会以为是模型写坏了代码。
   *
   * 拿不到(结束屏、`--resume` 之后编排器还没建起来)= 空数组 = 没有节点在飞,那是真的。
   */
  inFlight?: readonly string[]
  onError?: (e: Error) => void
}

/** 一个会被删掉的工作区。 */
export interface CleanupItem {
  nodeId: string
  title: string
  path: string
  branch: string
  /** 目录占用,KB。`undefined` = 量不到(没有 du / 命令失败)。 */
  sizeKb?: number
  /** 会被一并删掉的未提交内容,给人看的前几条。 */
  leftovers: string[]
  /** 未提交内容一共几条(`leftovers` 是它的截断)。 */
  leftoverCount: number
}

/** 一个**保留下来**的工作区,以及为什么。 */
export interface CleanupKept {
  nodeId: string
  title: string
  path: string
  why: string
  /**
   * 这个理由是不是「我没探明白」(`merge-base` 非 0 非 1)。
   *
   * **必须和「你还有东西没合」分开**,而且不只是措辞:一个状态未知的仓库里跑
   * `git clean -f` 是这个功能最不该做的事,所以只有**探明白了**的那一类才进 `keptBuild`。
   * (`integrationAhead` 那条注释的第三次应验。)
   */
  unknown?: boolean
}

/**
 * 一个**目录整个保留、只清里面构建产物**的工作区。
 *
 * ## 为什么需要这一档
 *
 * 用户第 5 条问的是「为什么按 c 键,worktree 的 target 没有完全清理掉」,而他是在
 * `7339528` / `6a3ffa7` 两个修复**之后**又问的一遍。今天 `c` 键真正够得着的只有
 * 「已验收 **且** 已合入」那一桶(整个目录删掉);另外两类工作区它一个字节都碰不到:
 *
 *  - **有未合入提交的已验收节点**(`kept`)—— 目录必须留,那是没人能替他决定的工作;
 *  - **还没验收完的节点**(`unfinished`,含被阻断的)—— 目录必须留,那是现场。
 *    而跑机上「一个节点阻断、9 个兄弟依赖阻断」是常态,它们的 `target/` 攒得最久。
 *
 * 两类的共同点是**目录不能删**,而 `target/` 和「保护工作」「保护现场」都没有关系。
 * 判据一句话:**清产物 ≠ 删目录。**
 *
 * ## 边界(每一条都在确认屏上说出口)
 *
 *  - 只清**被 .gitignore 忽略的**。未跟踪但没被忽略的可能是执行者刚生成、还没提交的
 *    交付物 —— 而这两桶恰恰是「工作还没合走」的桶。用户点名的 `.cargo-target-sql-restore`
 *    就属于这一类,它清不掉,这件事要说,不是假装没有。
 *  - 被忽略的**目录是整个消失的**,包括手工放在里面的文件(真 git 实测)。
 *  - **在飞的节点一个字节都不动**(见 `CleanupDeps.inFlight`)。
 */
export interface CleanupBuildItem {
  nodeId: string
  title: string
  path: string
  /** 这个工作区为什么只清产物、不删目录 —— 给确认屏分组用。 */
  why: string
  plan: BuildWipePlan
}

export interface CleanupPlan {
  targetId: string
  items: CleanupItem[]
  kept: CleanupKept[]
  /** 血统里**还没完成**的节点数 —— 整个不在本次范围内。 */
  unfinished: number
  /** 已完成、但盘上根本没有工作区目录的节点数(清过了 / 那一趟没隔离)。 */
  absent: number
  /** 全部 item 的占用合计,KB。 */
  totalKb: number
  /** 占用是不是**每一个**都量到了。有一个量不到就为 false,屏幕上要说出来。 */
  sizeKnown: boolean
  /**
   * 会被删掉的**事件日志**(`agent-log.jsonl`)。
   *
   * 和 `items` 是**两份名单,不是一份** —— 范围不一样:工作区那份要求盘上真有那个目录
   * (`absent` 的节点整个跳过),而日志和工作区没关系,一个早就被清过工作区的节点
   * 照样留着几 MB 日志。挂在 items 上会正好漏掉最该清的那批。
   */
  logs: { nodeId: string; title: string; kb?: number }[]
  /** 事件日志合计,KB。 */
  logKb: number
  /** 日志占用是不是每一个都量到了。 */
  logSizeKnown: boolean
  /**
   * 临时目录里的残留(见 `CleanupDeps.scratch`)。
   *
   * **第三份名单** —— 和 `items`、`logs` 的范围都不一样,理由和 `logs` 那一条同源:
   * 它认的是 slug,不是盘上还有没有那个工作树。一个早就被清过工作区的节点,`/tmp` 里
   * 那几个 GB 照样还在,而它恰恰是攒得最久的那一批。
   */
  scratch: { path: string; kb?: number }[]
  scratchKb: number
  scratchSizeKnown: boolean
  /**
   * 集成工作区里会被清掉的构建产物。`undefined` = 没给路径,或者那里根本没有被忽略的东西。
   */
  integration?: {
    path: string
    /** 被忽略的顶层条目(给人看的前几条)。 */
    entries: string[]
    entryCount: number
    kb?: number
    /** 真正要执行的那份计划 —— 扫描和执行**共用同一份**,不许各算一次。 */
    plan?: BuildWipePlan
  }
  /**
   * **目录整个保留、只清里面构建产物**的那些(见 `CleanupBuildItem`)。
   *
   * 第四份名单,范围和前三份都不一样:它收的是 `kept`(已验收但没合入)与
   * `unfinished`(还没验收完、且此刻不在飞)两类 —— 也就是今天 `c` 键完全够不着的那部分。
   */
  buildOnly: CleanupBuildItem[]
  buildOnlyKb: number
  buildOnlySizeKnown: boolean
  /**
   * 会被 git 静默跳过的嵌套仓库(`clean` 对它退出码仍是 0)。
   * 不报出来,屏幕就会承诺一份根本不会被腾出来的空间。
   */
  buildOnlySkippedRepos: string[]
  /** 因为节点此刻**在飞**而整个不碰的工作区数。 */
  buildOnlyBusy: number
}

export interface CleanupOutcome {
  removed: CleanupItem[]
  failed: { nodeId: string; title: string; path: string; why: string }[]
  /** 删掉了工作区、但别的地方没做干净(分支没删掉、记录没写回)。每一条都要上屏。 */
  problems: string[]
  /** 真的被删掉的事件日志数,以及它们腾出来的 KB。 */
  logsRemoved: number
  logsFreedKb: number
  /** 真的被删掉的临时目录条目数,以及它们腾出来的 KB。 */
  scratchRemoved: number
  scratchFreedKb: number
  /** 集成工作区的构建产物清掉了没有(没给路径 / 没东西可清 = false)。 */
  integrationCleaned: boolean
  integrationFreedKb: number
  /** 「只清产物」那一桶:清过东西的工作区数、条目数、实测释放量。 */
  buildOnlyCleaned: number
  buildOnlyEntries: number
  buildOnlyFreedKb: number
  buildOnlySizeKnown: boolean
  /** 真删那一遍里被 git 跳过的嵌套仓库(带节点标题,好让人找得到)。 */
  buildOnlySkipped: { title: string; path: string }[]
  freedKb: number
  sizeKnown: boolean
}

/**
 * 本次清理的范围。**纯函数**,关口预演和真正执行共用同一份(两边各算一次的话,
 * 用户是照着屏幕按的确认,而实际发生的可以是另一回事)。
 */
export function cleanupScope(nodes: readonly TaskNode[], targetId: string): {
  target?: TaskNode
  /** 血统里已验收的那些,目标节点自己排第一(如果它也已验收)。 */
  done: TaskNode[]
  unfinished: number
  /**
   * 血统里**还没验收完**的那些节点本身,不只是个数。
   *
   * 从前这里只回一个计数,因为它们整个不在范围内。现在它们进「只清产物」那一桶:
   * 目录仍然一个都不删(那是现场),但 `target/` 和保护现场没有关系 —— 而跑机上
   * 「一个阻断、9 个兄弟依赖阻断」是常态,这一批的构建产物攒得最久,`c` 键从来碰不到。
   */
  unfinishedNodes: TaskNode[]
} {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { done: [], unfinished: 0, unfinishedNodes: [] }
  // 自己 + 全部后代。descendantsOf 自带环保护,并且只收**真实存在**的后代 ——
  // childIds 是可手工编辑的,一个自指的条目会让这里死循环,而它跑在按键处理里。
  const scope = [target, ...descendantsOf(target, byId).map(id => byId.get(id)!).filter(Boolean)]
  const done = scope.filter(n => n.status === 'ACCEPTED')
  const unfinishedNodes = scope.filter(n => n.status !== 'ACCEPTED')
  return { target, done, unfinished: unfinishedNodes.length, unfinishedNodes }
}

/**
 * 探一遍盘上的真实状态,算出「按下确认之后会发生什么」。
 *
 * 每个候选节点问三件事,顺序有讲究:
 *  1. **目录还在吗** —— 不在就什么都不用说(已经清过了 / 那一趟根本没隔离);
 *  2. **它的提交是不是已经全在集成分支里** —— 这是唯一的硬闸;
 *  3. **还剩什么没提交** —— 会被删掉,所以要数出来。
 */
export async function scanCleanup(
  deps: CleanupDeps, nodes: readonly TaskNode[], targetId: string,
): Promise<CleanupPlan> {
  const { done, unfinished, unfinishedNodes } = cleanupScope(nodes, targetId)
  const items: CleanupItem[] = []
  const kept: CleanupKept[] = []
  let absent = 0
  let totalKb = 0
  let sizeKnown = true
  /**
   * 「目录留着、只清产物」那一桶。收两类,而两类都要**先确认它不在飞**。
   *
   * 攒在这里、循环之后统一探盘 —— `kept` 是在下面那个循环里才产生的,而 `unfinished`
   * 根本不在那个循环里。
   */
  const buildTargets: { node: TaskNode; path: string; why: string }[] = []

  for (const node of done) {
    const path = deps.pathFor(node)
    const branch = deps.branchFor(node)
    const there = await deps.git(['rev-parse', '--git-dir'], path)
    if (there.code !== 0) { absent++; continue }
    /**
     * **唯一的硬闸:这棵树的 HEAD 已经被集成分支包含了吗。**
     *
     * 判据必须区分 `code === 1`(真的不是祖先 = 有没合入的提交)和别的非零
     * (路径坏了、ref 不存在、仓库出问题)—— `integrationAhead` 为同一件事写过一次:
     * 把「探测失败」当成一个确定的答案,是在一个已经出问题的工作区上做不可逆的决定。
     * 两种都保留,但**说的话不一样**:一种是「你还有东西没合」,另一种是「我没探明白」。
     *
     * 问 HEAD 而不是问分支名:分支可能已经被删/被改名,而工作区里 HEAD 就是它的 tip;
     * `acquire` 的抢救分支判据用的也是这一条。
     */
    const merged = await deps.git(['merge-base', '--is-ancestor', 'HEAD', deps.integrationBranch], path)
    if (merged.code === 1) {
      kept.push({
        nodeId: node.id, title: node.title, path,
        why: `仍有未合入集成分支 ${deps.integrationBranch} 的提交 —— 删了就真的没了`,
      })
      /**
       * 目录保住了,**但它里面的构建产物和「保护工作」没有任何关系**。
       *
       * 用户第 6 条要的是「未正常合并提交的绝对不能删除掉」—— 那说的是提交和目录。
       * 而第 5 条问的是 target 为什么没清干净,这一桶正是答案的一半。
       */
      buildTargets.push({ node, path, why: '有未合入集成分支的提交,目录必须留着' })
      continue
    }
    if (merged.code !== 0) {
      kept.push({
        nodeId: node.id, title: node.title, path, unknown: true,
        why: `无法判断提交是否已合入(git 探测失败:${merged.stderr.trim() || `退出码 ${merged.code}`})`,
      })
      /**
       * **这一类刻意不进 `buildTargets`。**
       *
       * 「你还有东西没合」和「我没探明白」要用户做的事不一样(`integrationAhead` 那条注释
       * 的第三次应验),而这里的差别不止是措辞:在一个**状态未知**的仓库里跑 `git clean -f`
       * 是这个功能最不该做的事。探不明白就整个不碰。
       */
      continue
    }
    /**
     * 会被一并删掉的东西。`--ignored` 是重点:构建产物在普通 `--porcelain` 里根本看不见,
     * 而它正是这个功能要清的那一部分 —— 不带它,确认屏会对着一个 3GB 的 `target/`
     * 说「没有未提交的内容」。
     *
     * `core.quotepath=false`:否则中文路径在这里是 `"\344\270\255…"`,而这串东西会原样
     * 摆到用户面前(这个仓库为同一件事在 worktreePool 里加过两次这个开关)。
     */
    const st = await deps.git(['-c', 'core.quotepath=false', 'status', '--porcelain', '--ignored'], path)
    const lines = st.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const sizeKb = await deps.dirSizeKb?.(path).catch(() => undefined)
    if (sizeKb === undefined) sizeKnown = false
    else totalKb += sizeKb
    items.push({
      nodeId: node.id, title: node.title, path, branch,
      ...(sizeKb === undefined ? {} : { sizeKb }),
      leftovers: lines.slice(0, 3),
      leftoverCount: lines.length,
    })
  }

  /**
   * **还没验收完的那些节点** —— 用户第 5 条最可能的真凶。
   *
   * 它们的目录一个都不删(那是现场:升级卡逐字在教用户去那里解冲突),但 `target/` 与
   * 保护现场无关。跑机上「一个节点阻断、9 个兄弟依赖阻断」是常态,而这一批的构建产物
   * 从 `c` 键第一版起就一个字节都碰不到 —— `cleanupScope` 把它们整个算进 `unfinished`
   * 然后跳过。
   */
  for (const node of unfinishedNodes) {
    buildTargets.push({ node, path: deps.pathFor(node), why: `还没验收完(${node.status}),目录是现场` })
  }

  /**
   * 「只清产物」那一桶的实际探盘。
   *
   * **在飞的节点一个字节都不动**,而且判据放在这里(而不是上面各自的分支里)—— 一处判、
   * 一处计数,少一个地方漏判就是一次打在正在跑的增量编译上的 `git clean`。
   */
  const busy = new Set(deps.inFlight ?? [])
  const buildOnly: CleanupBuildItem[] = []
  let buildOnlyKb = 0
  let buildOnlySizeKnown = true
  let buildOnlyBusy = 0
  const buildOnlySkippedRepos: string[] = []
  for (const t of buildTargets) {
    if (busy.has(t.node.id)) { buildOnlyBusy++; continue }
    const there = await deps.git(['rev-parse', '--git-dir'], t.path)
    if (there.code !== 0) continue
    const plan = await scanBuildOutputs(
      { git: deps.git, ...(deps.dirSizeKb ? { dirSizeKb: deps.dirSizeKb } : {}) }, t.path,
    )
    // 探不动、或者根本没有产物可清 —— 都不该在屏幕上占一行。
    if (plan.error !== undefined || plan.entries.length === 0) {
      for (const r of plan.skippedRepos) if (!buildOnlySkippedRepos.includes(r)) buildOnlySkippedRepos.push(r)
      continue
    }
    if (!plan.sizeKnown) buildOnlySizeKnown = false
    buildOnlyKb += plan.totalKb
    for (const r of plan.skippedRepos) if (!buildOnlySkippedRepos.includes(r)) buildOnlySkippedRepos.push(r)
    buildOnly.push({ nodeId: t.node.id, title: t.node.title, path: t.path, why: t.why, plan })
  }

  /**
   * 事件日志那一份名单。**走 `done` 全体,不走 `items`** —— 见 CleanupPlan.logs。
   *
   * 量不到大小就留 `undefined`,不编 0(`dirSizeKb` 那条注释的同一条规矩:那个数字
   * 直接决定用户按不按下不可逆的确认)。`du -sk` 对普通文件一样有效,所以复用同一个接缝。
   */
  const logs: CleanupPlan['logs'] = []
  let logKb = 0
  let logSizeKnown = true
  if (deps.persist) {
    for (const node of done) {
      const p = `${deps.persist.runDir}/${node.id}/${AGENT_LOG_NAME}`
      if (!(await deps.persist.fs.exists(p))) continue
      const kb = await deps.dirSizeKb?.(p)
      if (kb === undefined) logSizeKnown = false
      else logKb += kb
      logs.push({ nodeId: node.id, title: node.title, ...(kb === undefined ? {} : { kb }) })
    }
  }
  /**
   * 临时目录那一份名单。**同样走 `done` 全体** —— 见 CleanupPlan.scratch:它认的是 slug,
   * 而不是盘上还有没有那个工作树。
   *
   * slug 从 `pathFor` 的最后一段取,不在这里重算一遍:`worktreeSlug` 的规则改动的那一天,
   * 重算的那一份会开始匹配另一批目录,而这里做的是 `rm -rf`(池子路径那条注释同一个理由)。
   */
  const scratch: CleanupPlan['scratch'] = []
  let scratchKb = 0
  let scratchSizeKnown = true
  if (deps.scratch) {
    /**
     * `length >= 8` 不是洁癖:消费者拿这些 slug 去**子串匹配**系统临时目录里的条目,
     * 然后 `rm -rf`。一个退化的 slug(路径末尾是空、是 `.`、是单个字符)会匹配上
     * 半个 `/tmp`。真实的 slug 是 `efftask-<runId>-<8位hash>`,离这条线很远 ——
     * 它挡的是「`worktreeSlug` 哪天变了或 `pathFor` 返回了个怪东西」的那一天。
     */
    const slugs = [...new Set(done.map(n => slugOf(deps.pathFor(n))))].filter(s => s.length >= 8)
    if (slugs.length > 0) {
      try {
        for (const e of await deps.scratch.list(slugs)) {
          if (e.kb === undefined) scratchSizeKnown = false
          else scratchKb += e.kb
          scratch.push(e)
        }
      } catch (e) {
        // 列不出来就当没有 —— 这一格失败不该让整屏确认打不开(工作区那一份才是主菜)。
        deps.onError?.(e instanceof Error ? e : new Error(String(e)))
        scratchSizeKnown = false
      }
    }
  }

  /**
   * 集成工作区的构建产物。**只问被忽略的那些**(`--ignored` 里 `!!` 打头的行)——
   * 未跟踪但没被忽略的文件不在其中,理由见 `CleanupDeps.integrationPath`。
   */
  /**
   * 集成工作区的构建产物。**走和别处同一个原语**(`scanBuildOutputs`)。
   *
   * 这一格此前是自己写的一段:`status --porcelain --ignored` 枚举 + 裸的
   * `git clean -X -d -f` 执行。验收在真 git 上量出三个后果,每一个 `buildOutputs.ts`
   * 的文件头都逐条写过、而这一格一条都没享受到:
   *
   *  1. **把 `/et` 自己的记录当构建产物删掉。** `.claude/efftask/` 之所以被忽略,
   *     正是 `pool.init()` 自己往共享的 `info/exclude` 里写的那条;git 再把它折叠成
   *     父目录 `.claude/`。实测:`.claude/efftask/r1/run.md` 被删掉了。
   *  2. **嵌套 git 仓库被静默跳过而退出码是 0** —— 屏幕说腾出 596 KB,其中 184 KB
   *     原地不动。
   *  3. **释放量报的是承诺值不是测量值**(`plan.integration.kb`)。
   */
  let integration: CleanupPlan['integration']
  if (deps.integrationPath) {
    const plan = await scanBuildOutputs(
      { git: deps.git, ...(deps.dirSizeKb ? { dirSizeKb: deps.dirSizeKb } : {}) },
      deps.integrationPath,
    )
    if (plan.error === undefined && plan.entries.length > 0) {
      integration = {
        path: deps.integrationPath,
        entries: plan.entries.slice(0, 3).map(e => e.rel),
        entryCount: plan.entries.length,
        ...(plan.sizeKnown ? { kb: plan.totalKb } : {}),
        plan,
      }
    }
  }

  return {
    targetId, items, kept, unfinished, absent, totalKb,
    sizeKnown: sizeKnown && items.length > 0,
    logs, logKb, logSizeKnown: logSizeKnown && logs.length > 0,
    scratch, scratchKb, scratchSizeKnown: scratchSizeKnown && scratch.length > 0,
    ...(integration ? { integration } : {}),
    buildOnly, buildOnlyKb,
    // 和别处同一条规矩:一条都没有时报 `true` 会让屏幕印「共 0 KB」,而真实的意思是
    // 「没东西可清」。
    buildOnlySizeKnown: buildOnlySizeKnown && buildOnly.length > 0,
    buildOnlySkippedRepos, buildOnlyBusy,
  }
}

/** 路径的最后一段 —— 工作树目录名就是它的 slug。 */
function slugOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? ''
}

/**
 * 真的删。**只对 `scanCleanup` 挑出来的那些**,一个都不多。
 *
 * ## `--force` 是必须的,而且只加一次
 *
 * 实测(git-worktree(1) 也这么写):`worktree remove` 对**不干净**的工作树直接拒绝,
 * 加一次 `--force` 才删得掉;加两次是给**被锁**的工作树用的,而我们的工作树从不上锁 ——
 * 多加一次等于把「有人锁住了它」这条本该报出来的情况一起吞掉。
 *
 * ## 顺序:先删目录,再删分支
 *
 * 分支在被工作树占用时 git 直接拒绝删除(`cannot delete branch … used by worktree at …`,
 * 收口报告为这句话吃过一次亏)。反过来先删分支也不行 —— 目录删失败时,一个已经没了分支的
 * 工作区更难救。所以:目录没删成就**整条跳过**,分支留着。
 *
 * ## 为什么要就地改 `node.worktree`,而不是造新对象
 *
 * `orchestrator.nodes()` 只复制**数组**,里面是同一批节点对象 —— 界面拿到的和编排器
 * 手里的是同一份。造新对象的话,运行中清理完,编排器下一次 `onUpdate` 会把带着陈旧
 * 引用的那一份原样推回界面,而那个目录已经不在了。
 *
 * 清掉这个引用不是「删任务数据」,恰恰相反:留着它,详情页的「隔离工作区」那一段会
 * 指着一个不存在的路径,而 `stepExecute` 的 `enterAtJudge` 判的正是
 * `node.worktree !== undefined` —— 它要挡的是「把一个空工作区合进集成分支并判 ACCEPTED」。
 * 引用消失让那道闸说的是真话。
 */
export async function runCleanup(
  deps: CleanupDeps, plan: CleanupPlan, nodes: readonly TaskNode[],
): Promise<CleanupOutcome> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const removed: CleanupItem[] = []
  const failed: CleanupOutcome['failed'] = []
  const problems: string[] = []
  let freedKb = 0
  let sizeKnown = true

  for (const item of plan.items) {
    const rm = await deps.git(['worktree', 'remove', '--force', item.path], deps.gitRoot)
    if (rm.code !== 0) {
      failed.push({
        nodeId: item.nodeId, title: item.title, path: item.path,
        why: rm.stderr.trim() || rm.stdout.trim() || `git worktree remove 退出码 ${rm.code}`,
      })
      continue
    }
    // 分支删不掉不影响「腾出空间」这件事(占地方的是目录),但**要说** —— 一条留下来的
    // 分支会一直出现在 `git branch` 里,而用户以为这里已经清干净了。
    const br = await deps.git(['branch', '-D', item.branch], deps.gitRoot)
    if (br.code !== 0) {
      problems.push(`${item.title}:目录已删,但分支 ${item.branch} 没删掉(${br.stderr.trim() || `退出码 ${br.code}`})`)
    }
    const node = byId.get(item.nodeId)
    if (node?.worktree) {
      node.worktree = undefined
      if (deps.persist) {
        try {
          // 状态账一起写 —— 见 redoCommit 里那一段。
          await writeNode(
            deps.persist.fs, deps.persist.runDir, node,
            createNodeJournal({ fs: deps.persist.fs, runDir: deps.persist.runDir }),
          )
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          deps.onError?.(err)
          // 目录真的没了,而 node.md 上还写着它 —— 下次 `--resume` 读回来的是一条指向
          // 空气的工作区记录。说出来,别让它在恢复时才以另一种面目出现。
          problems.push(`${item.title}:工作区已删,但 node.md 里那条记录没能写回(${err.message})`)
        }
      }
    }
    if (item.sizeKb === undefined) sizeKnown = false
    else freedKb += item.sizeKb
    removed.push(item)
  }

  /**
   * 事件日志。**排在工作区之后**,而且删不掉只记一条 problem、不算失败 ——
   * 一个删不掉的日志文件不影响这次回收的主要目的,而把它算成失败会让屏幕上那句
   * 「回收了 N 个工作区」变成红的。
   *
   * **只删 `agent-log.jsonl`。** `node.md` 和 `state.jsonl` 不在这个循环里,也不该被
   * 加进来 —— 见模块头「只有一个例外」那一节。
   */
  let logsRemoved = 0
  let logsFreedKb = 0
  if (deps.persist) {
    for (const l of plan.logs) {
      const p = `${deps.persist.runDir}/${l.nodeId}/${AGENT_LOG_NAME}`
      try {
        if (!(await deps.persist.fs.exists(p))) continue
        await deps.persist.fs.unlink(p)
        logsRemoved++
        logsFreedKb += l.kb ?? 0
      } catch (e) {
        problems.push(`${l.title}:事件日志没删掉(${e instanceof Error ? e.message : String(e)})`)
      }
    }
  }

  /**
   * 临时目录的残留。**排在工作区之后,失败只记 problem** —— 和事件日志同一条规矩:
   * 一个删不掉的 `/tmp` 条目不影响这次回收的主要目的,把它算成失败会让「回收了 N 个
   * 工作区」变成红的。
   *
   * 逐条删、逐条记大小:一次 `rm -rf` 整批的写法在这里是错的,因为其中任何一条失败
   * (权限、正在被写)都会让剩下的全部不了了之,而屏幕上那个「腾出多少」已经承诺过了。
   */
  let scratchRemoved = 0
  let scratchFreedKb = 0
  if (deps.scratch) {
    for (const s of plan.scratch) {
      try {
        await deps.scratch.remove(s.path)
        scratchRemoved++
        scratchFreedKb += s.kb ?? 0
      } catch (e) {
        problems.push(`临时目录 ${s.path} 没删掉(${e instanceof Error ? e.message : String(e)})`)
      }
    }
  }

  /**
   * 集成工作区的构建产物。`git clean -X -d -f`:
   *  - `-X` **只删被忽略的**(不是 `-x`)—— 未跟踪但没被忽略的文件可能是一次正在进行的
   *    冲突解决现场,那不是构建产物;
   *  - `-d` 进入被忽略的目录(不加它,`target/` 这种整目录被忽略的一个字节都清不掉);
   *  - `-f` 是 git 对删除操作的必答项。
   *
   * 这个目录**本身不删**,只清里面的产物 —— 下一次收口、合并还要用它。
   */
  let integrationCleaned = false
  let integrationFreedKb = 0
  if (plan.integration?.plan) {
    const out = await wipeBuildOutputs(
      { git: deps.git, ...(deps.dirSizeKb ? { dirSizeKb: deps.dirSizeKb } : {}) },
      plan.integration.plan,
    )
    if (out.error !== undefined) {
      problems.push(`集成工作区的构建产物没清掉(${out.error})`)
    } else {
      integrationCleaned = out.removed.length > 0
      // **按测量结算**,不拿计划里那个已经在确认屏上承诺过的数字顶替。
      integrationFreedKb = out.freedKb
    }
    for (const r of out.skippedRepos) {
      // 嵌套仓库被 git 静默跳过而退出码是 0 —— 不报的话屏幕承诺的空间里有一部分
      // 根本不会被腾出来。
      problems.push(`集成工作区里的 ${r} 是嵌套的 git 仓库,git 跳过了它 —— 那部分空间没有被回收`)
    }
  }

  /**
   * 「目录留着、只清产物」那一桶。
   *
   * **排在最后**,和事件日志、临时目录同一条规矩:它清不掉不影响这次回收的主要目的
   * (删工作区),把它算成失败会让屏幕上那句「回收了 N 个工作区」变成红的。
   *
   * **绝不 `worktree remove`** —— 这一桶存在的全部理由就是目录必须留着
   * (未合入的提交 / 还没验收完的现场)。用户第 6 条:「未正常合并提交的绝对不能删除掉」。
   */
  let buildOnlyCleaned = 0
  let buildOnlyEntries = 0
  let buildOnlyFreedKb = 0
  let buildOnlySizeKnown = true
  const buildOnlySkipped: { title: string; path: string }[] = []
  for (const b of plan.buildOnly ?? []) {
    const out = await wipeBuildOutputs(
      { git: deps.git, ...(deps.dirSizeKb ? { dirSizeKb: deps.dirSizeKb } : {}) }, b.plan,
    )
    if (out.error !== undefined) {
      problems.push(`${b.title}:构建产物没清掉(${out.error})`)
      continue
    }
    for (const r of out.skippedRepos) {
      if (!buildOnlySkipped.some(x => x.path === r)) buildOnlySkipped.push({ title: b.title, path: r })
    }
    if (out.removed.length === 0) continue
    buildOnlyCleaned++
    buildOnlyEntries += out.removed.length
    buildOnlyFreedKb += out.freedKb
    if (!out.sizeKnown) buildOnlySizeKnown = false
  }

  return {
    removed, failed, problems, freedKb, sizeKnown: sizeKnown && removed.length > 0,
    logsRemoved, logsFreedKb,
    scratchRemoved, scratchFreedKb,
    integrationCleaned, integrationFreedKb,
    buildOnlyCleaned, buildOnlyEntries, buildOnlyFreedKb,
    buildOnlySizeKnown: buildOnlySizeKnown && buildOnlyCleaned > 0,
    buildOnlySkipped,
  }
}

/** KB → 人读的大小。量不到时给一个明确的「未知」,不给 0 —— 0 是一句假话。 */
export function formatSize(kb: number | undefined): string {
  if (kb === undefined || !Number.isFinite(kb) || kb < 0) return '大小未知'
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}

/**
 * 确认屏上的每一行。**是数据,不是 JSX** —— 关口那一屏只负责画,而「屏幕上到底承诺了
 * 什么」要能被一条断言钉住(这个仓库为「按下确认之后界面纹丝不动」造过 14 条存活变异)。
 *
 * ⚠ 开头的行会被上色。措辞按后果的严重程度排:先说要删几个、腾多少,再说会连带删掉什么,
 * 再说什么**不会**被动(用户唯一真正担心的那件事),最后才是保留和跳过的明细。
 */
export function cleanupLines(plan: CleanupPlan): string[] {
  const out: string[] = []
  /**
   * 新加的那几格**必须容得下一个不带它们的 plan**。类型上它们是必填的,而这一屏的
   * 失败方式是:少一个字段 → 渲染时抛 → 用户看到的不是清单,是一屏红色的 ERROR 栈,
   * 连「取消」都要靠猜。一次实测(cleanupView 那四条)就是这个形状。
   */
  const scratch = plan.scratch ?? []
  const scratchKb = plan.scratchKb ?? 0
  const size = plan.items.length === 0
    ? ''
    : plan.sizeKnown
      ? `,共 ${formatSize(plan.totalKb)}`
      : plan.totalKb > 0 ? `,至少 ${formatSize(plan.totalKb)}(有目录量不到大小)` : '(量不到大小)'
  out.push(plan.items.length === 0
    ? '没有可以回收的工作区。'
    : `将删除 ${plan.items.length} 个已验收任务的隔离工作区${size}:`)
  for (const it of plan.items) {
    const left = it.leftoverCount > 0
      ? ` · 连带删除 ${it.leftoverCount} 项未提交内容(${it.leftovers.join('、')}${it.leftoverCount > it.leftovers.length ? '…' : ''})`
      : ''
    out.push(`  · ${it.title} — ${formatSize(it.sizeKb)}${left}`)
  }
  if (plan.items.some(i => i.leftoverCount > 0)) {
    out.push('⚠ 那些未提交内容(构建产物、未跟踪文件、已跟踪文件的改动)会被一并删掉,不可恢复。')
    out.push('  它们全部产生在这些任务通过验收**之后**——交付物本身早已合进集成分支,不在其中。')
  }
  /**
   * 事件日志那一段。**必须自己占一行说出来** —— 这个键原来的承诺是「只动 git」,
   * 现在它会删文件了,而静默删除和静默截断是这个仓库反复在修的同一类毛病。
   */
  if (plan.logs.length > 0) {
    const lsize = plan.logSizeKnown
      ? `,共 ${formatSize(plan.logKb)}`
      : plan.logKb > 0 ? `,至少 ${formatSize(plan.logKb)}(有文件量不到大小)` : '(量不到大小)'
    out.push(`并删除 ${plan.logs.length} 份子 agent 事件日志(agent-log.jsonl)${lsize} —— 只是历史输出记录。`)
  }
  /**
   * 临时目录那一段。**必须点名它在系统 `/tmp` 里** —— 用户看着一屏「回收工作区」,
   * 而这一条删的是项目目录**之外**的东西,那是他最没预期会被动到的地方。
   */
  if (scratch.length > 0) {
    const ssize = plan.scratchSizeKnown
      ? `,共 ${formatSize(scratchKb)}`
      : scratchKb > 0 ? `,至少 ${formatSize(scratchKb)}(有条目量不到大小)` : '(量不到大小)'
    out.push(`并删除系统临时目录里 ${scratch.length} 个属于这些任务的残留${ssize} —— 席位自己写出去的构建目录和检查日志,名字里带着它们的工作区编号。`)
  }
  /**
   * 集成工作区那一段。这一条**必须说出代价**:清掉之后下一次集成验收是全量重编。
   * 只说「腾出 22 GB」而不说要重编,是拿一句半真话换一次按键。
   */
  if (plan.integration) {
    out.push(`并清掉集成工作区里 ${plan.integration.entryCount} 项构建产物(${plan.integration.entries.join('、')}${plan.integration.entryCount > plan.integration.entries.length ? '…' : ''})${plan.integration.kb === undefined ? '(量不到大小)' : `,共 ${formatSize(plan.integration.kb)}`}。`)
    out.push('⚠ 它们是被 .gitignore 忽略的构建产物,删掉不丢任何产出,但下一次集成验收会全量重编。')
  }
  /**
   * **目录留着、只清里面构建产物**的那一桶(用户第 5 条的另一半)。
   *
   * 拆成好几个 `out.push` 而不是一句长的:正文是 `wrap="truncate-end"`,80 列上一句
   * 60 个全角字会被砍掉可操作的后半句(集成工作区那一段就是这个范式:一句陈述 + 一句 ⚠ 代价)。
   */
  const buildOnly = plan.buildOnly ?? []
  if (buildOnly.length > 0) {
    const bsize = plan.buildOnlySizeKnown
      ? `,共 ${formatSize(plan.buildOnlyKb ?? 0)}`
      : (plan.buildOnlyKb ?? 0) > 0 ? `,至少 ${formatSize(plan.buildOnlyKb ?? 0)}` : '(量不到大小)'
    out.push(`另有 ${buildOnly.length} 个**目录必须留着**的工作区,只清掉它们里面的构建产物${bsize}:`)
    for (const b of buildOnly) {
      const kb = b.plan.sizeKnown ? formatSize(b.plan.totalKb) : '大小未知'
      const head = b.plan.entries.slice(0, 3).map(e => e.rel).join('、')
      out.push(`  · ${b.title}(${b.why})— ${kb}:${head}${b.plan.entries.length > 3 ? '…' : ''}`)
    }
    out.push('⚠ 这些工作区的目录、提交、未提交的改动一个字节都不动 —— 只删被 .gitignore 忽略的产物。')
    // 用户点名过 `.cargo-target-sql-restore`(点开头、**未被忽略**)。它清不掉,
    // 而这件事必须说,不能让人按完发现盘没腾出来。
    out.push('  没有被 .gitignore 忽略的构建目录(例如 .cargo-target-… 这种)不在其中,清不掉。')
    out.push('  被忽略的目录会被**整个**删掉,包括你手工放在里面的东西。')
  }
  if ((plan.buildOnlySkippedRepos ?? []).length > 0) {
    // `git clean` 对嵌套仓库静默跳过而**退出码仍是 0**(真 git 实测)。不说的话,
    // 屏幕承诺的空间里有一部分根本不会被腾出来。
    out.push(`⚠ 其中 ${plan.buildOnlySkippedRepos!.length} 处是嵌套的 git 仓库,git 会跳过它们(${plan.buildOnlySkippedRepos!.slice(0, 2).join('、')}${plan.buildOnlySkippedRepos!.length > 2 ? '…' : ''})。`)
  }
  if ((plan.buildOnlyBusy ?? 0) > 0) {
    out.push(`另有 ${plan.buildOnlyBusy} 个任务此刻正在运行,它们的工作区一个字节都不碰。`)
  }
  // 措辞逐条点名,不说「任务记录不受影响」那种笼统话:现在**确实**有一样记录会被删,
  // 而一句笼统的保证配上一次真实的删除,就是这一屏最坏的读法。
  out.push('不会动的:node.md(基本信息、状态、方案、评审与验收记录)和 state.jsonl(状态账)一个字节都不碰。')
  if (plan.kept.length > 0) {
    out.push(`保留 ${plan.kept.length} 个:`)
    for (const k of plan.kept) out.push(`  · ${k.title}:${k.why}`)
  }
  if (plan.unfinished > 0) {
    out.push(`跳过 ${plan.unfinished} 个还没验收的任务 —— 它们的工作区正是现场,不在本次范围。`)
  }
  /**
   * **`c` 和 `m` 的正面冲突,必须自己占一行。**
   *
   * 用户同一轮里既说「未正常合并提交的绝对不能删除掉」(第 6 条),又说「要保证所有
   * 未提交的都要提交,不能丢弃了」(第 8 条)。而 items 那一桶里的未提交内容,`c` 会
   * **连目录一起删掉**。两句话都对,冲突在于**顺序**:先合再清。
   * 不说的话,一个刚读完第 6 条那句保证的用户会以为这一屏什么工作都不会丢。
   */
  if (plan.items.some(i => i.leftoverCount > 0)) {
    /**
     * **这句指路不能许一个 `m` 兑现不了的承诺。**
     *
     * 上面那句「未提交内容」是**带 `--ignored`** 数出来的(见 leftoverCount),里面包含
     * 构建产物;而 `m` 走的 `commitAndMerge` 第一句是 `git add -A`,**不暂存被忽略的
     * 文件**。所以「先按 m 保住它们」对其中一部分逐字为假 —— 验收把这两屏并排读出来了。
     */
    out.push('提示:上面那些未提交内容还没有被提交到任何分支上。')
    out.push('  **未被忽略的**那些可以先按 m 合并一次保住;而被 .gitignore 忽略的(构建产物)m 也提交不了 —— 它们只能被删。')
  }
  if (plan.absent > 0) out.push(`另有 ${plan.absent} 个已验收任务在盘上没有工作区目录(清过了,或那一趟没隔离)。`)
  // 集成工作区那句话分两半,而且两半都要说:**目录留着**(下一次收口和合并都在它里面
  // 发生,`init()` 还要复用),**里面的构建产物清掉**。只说前半句是这一屏原来的措辞,
  // 而它现在会是一句假话。
  out.push('集成工作区(.efftask-worktrees/integration)本身保留:收口和每一次合并都在它里面发生;'
    + (plan.integration ? '只清掉它里面被忽略的构建产物。' : '这次它里面没有可清的构建产物。'))
  return out
}

/** 清理完那一屏的每一行。同上,是数据。 */
export function cleanupResultLines(out: CleanupOutcome): string[] {
  const lines: string[] = []
  /**
   * 一个都没删掉时**不许说「已删除 0 个」**。
   *
   * 那句话读起来像一次成功的空操作,而这一格真实的意思是「你按下了确认,而它全都失败了」
   * —— 后面那几条 ⚠ 才是这一屏的主语。判据只看 `removed`:失败与否不改变「没删掉任何
   * 东西」这个事实。
   */
  if (out.removed.length === 0) {
    lines.push('没有删除任何工作区。')
  } else {
    const size = out.sizeKnown
      ? `,腾出 ${formatSize(out.freedKb)}`
      : out.freedKb > 0 ? `,至少腾出 ${formatSize(out.freedKb)}` : ''
    lines.push(`已删除 ${out.removed.length} 个隔离工作区${size}。`)
  }
  /**
   * 日志那一句**只在真的删过时才印**。`logsRemoved === 0` 时印「已删除 0 份」
   * 读起来像一次成功的空操作 —— 和上面 removed 那条同一条规矩。
   */
  if (out.logsRemoved > 0) {
    lines.push(`已删除 ${out.logsRemoved} 份事件日志${out.logsFreedKb > 0 ? `,腾出 ${formatSize(out.logsFreedKb)}` : ''}。`)
  }
  // 同上:0 条时一个字都不印。
  if (out.scratchRemoved > 0) {
    lines.push(`已删除临时目录里 ${out.scratchRemoved} 个残留${out.scratchFreedKb > 0 ? `,腾出 ${formatSize(out.scratchFreedKb)}` : ''}。`)
  }
  if (out.integrationCleaned) {
    lines.push(`已清掉集成工作区的构建产物${out.integrationFreedKb > 0 ? `,腾出 ${formatSize(out.integrationFreedKb)}` : ''} —— 下一次集成验收会全量重编。`)
  }
  // 同上:0 个时一个字都不印。
  if ((out.buildOnlyCleaned ?? 0) > 0) {
    const size = out.buildOnlySizeKnown
      ? `,腾出 ${formatSize(out.buildOnlyFreedKb ?? 0)}`
      : (out.buildOnlyFreedKb ?? 0) > 0 ? `,至少腾出 ${formatSize(out.buildOnlyFreedKb ?? 0)}` : ''
    lines.push(`已清掉 ${out.buildOnlyCleaned} 个保留工作区里的 ${out.buildOnlyEntries} 项构建产物${size} —— 目录、提交、未提交的改动都原样留着。`)
  }
  for (const s of out.buildOnlySkipped ?? []) {
    // 指名道姓:用户能做的事(自己去看那个 vendored checkout)只有知道路径才做得了。
    lines.push(`⚠ ${s.title}:${s.path} 是嵌套的 git 仓库,git 跳过了它 —— 那部分空间没有被回收。`)
  }
  for (const f of out.failed) lines.push(`⚠ ${f.title} 没删掉:${f.why}`)
  for (const p of out.problems) lines.push(`⚠ ${p}`)
  return lines
}
