import { descendantsOf } from './redo.js'
import { AGENT_LOG_NAME } from './agentLog.js'
import { writeNode, type FsLike } from './persistence.js'
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
}

export interface CleanupOutcome {
  removed: CleanupItem[]
  failed: { nodeId: string; title: string; path: string; why: string }[]
  /** 删掉了工作区、但别的地方没做干净(分支没删掉、记录没写回)。每一条都要上屏。 */
  problems: string[]
  /** 真的被删掉的事件日志数,以及它们腾出来的 KB。 */
  logsRemoved: number
  logsFreedKb: number
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
} {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { done: [], unfinished: 0 }
  // 自己 + 全部后代。descendantsOf 自带环保护,并且只收**真实存在**的后代 ——
  // childIds 是可手工编辑的,一个自指的条目会让这里死循环,而它跑在按键处理里。
  const scope = [target, ...descendantsOf(target, byId).map(id => byId.get(id)!).filter(Boolean)]
  const done = scope.filter(n => n.status === 'ACCEPTED')
  return { target, done, unfinished: scope.length - done.length }
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
  const { done, unfinished } = cleanupScope(nodes, targetId)
  const items: CleanupItem[] = []
  const kept: CleanupKept[] = []
  let absent = 0
  let totalKb = 0
  let sizeKnown = true

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
      continue
    }
    if (merged.code !== 0) {
      kept.push({
        nodeId: node.id, title: node.title, path,
        why: `无法判断提交是否已合入(git 探测失败:${merged.stderr.trim() || `退出码 ${merged.code}`})`,
      })
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
  return {
    targetId, items, kept, unfinished, absent, totalKb,
    sizeKnown: sizeKnown && items.length > 0,
    logs, logKb, logSizeKnown: logSizeKnown && logs.length > 0,
  }
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
          await writeNode(deps.persist.fs, deps.persist.runDir, node)
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

  return {
    removed, failed, problems, freedKb, sizeKnown: sizeKnown && removed.length > 0,
    logsRemoved, logsFreedKb,
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
  if (plan.absent > 0) out.push(`另有 ${plan.absent} 个已验收任务在盘上没有工作区目录(清过了,或那一趟没隔离)。`)
  out.push('集成工作区(.efftask-worktrees/integration)不在范围内:收口和每一次合并都在它里面发生。')
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
  for (const f of out.failed) lines.push(`⚠ ${f.title} 没删掉:${f.why}`)
  for (const p of out.problems) lines.push(`⚠ ${p}`)
  return lines
}
