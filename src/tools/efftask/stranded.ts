import { worktreeSlug } from './worktreeId.js'
// 「产出丢了」和「集成验收没通过」这两条判据和回溯那一侧**共用一份**。
// 验收实测过分家的后果:本轮把零贡献节点从 ACCEPTED 改成 BLOCKED 之后,这边那份
// 硬编码副本(只认 ACCEPTED + 字面量)一件都扫不到,而同一个节点在回溯那边判 true。
import { lastIntegrateFailed, outputMissing } from './backtrack.js'
import { isTerminal } from './stateMachine.js'
import type { TaskNode } from './types.js'

/**
 * **这一趟里,活可能卡在哪儿 —— 一份不许漏项的清单。**
 *
 * 用户原话:「目标就是把哪些没有提交的或没有合并的,功能没有达标的全部捞出来。」
 *
 * ## 为什么是一份清单,而不是三个各管一摊的键
 *
 * 「全部捞出来」的验收标准是**一件都不能漏**,而在这之前,能不能捞得看你按的是哪个键:
 * `m` 走 `childIds → pathFor(node)`,于是**没有工作区目录的东西它一个都看不见**——
 * 抢救分支(它正是在目录被毁时建的)、只剩分支的残留(跑机实测 etcd3 上 32 条工作树登记项
 * 里 **31 条**目录已不在)、被 `healIntegrationSlot` 挪走的孤儿目录,三类都在它的视野之外。
 * 收口屏对其中两类**念一句就完了**,没有任何一条路径会去动它们。
 *
 * 所以判据倒过来:**先穷举活能藏在哪儿,再让每个动作认领其中几格。** 分类表
 * (`STRANDED_KINDS`)是这份穷举的落地,而 `scanStranded` 必须覆盖表里每一格 ——
 * 漏一格就是「全部捞出来」这句话变成假的,而那正是这次要修的东西。
 *
 * ## 三类去处,一件都不许静默丢掉
 *
 *  - **能合的**(`action: 'merge'`)—— 东西还在,只是没送到:未提交的、没合入的、
 *    抢救出来的、只剩分支的。
 *  - **要返工的**(`action: 'backtrack'`)—— 东西**根本不在了**(生成丢失,捞无可捞)
 *    或者功能没达标(集成验收不通过)。这两类合不了,只能重新生成 / 返工。
 *  - **只摆出来的**(`action: 'report'`)—— 该不该动是**你的决定**,不是我们能替你判的:
 *    被你按 `x` 取消的、降级放行的、盘上那个孤儿目录。给路径、给命令,不替你按。
 *
 * ## 一条贯穿的规矩
 *
 * **探不明白也要列出来。** 一个 `merge-base` 探测失败的分支、一条映射不回节点的抢救 ref,
 * 它们最容易被写成「跳过」——而跳过和「这里没有东西」在屏幕上长得一模一样。
 */

/** 一格「活可能卡在哪儿」。**分类表是这份穷举的唯一真相**,`scanStranded` 必须逐格覆盖。 */
export const STRANDED_KINDS = {
  loose: {
    label: '工作区里还没提交的内容',
    action: 'merge',
    /** 怎么进去的 —— 写在这里而不是散在各处,是为了让「漏了哪一格」可以被一眼看出来。 */
    how: '执行者写完了,还没走到 commitAndMerge',
  },
  unmerged: {
    label: '已提交、但没合进集成分支',
    action: 'merge',
    how: '撞了合并冲突而阻断,或者 run 在合并之前被中止',
  },
  salvage: {
    label: '抢救出来的提交',
    action: 'merge',
    how: 'acquire 复用目录 / 重做时 discard —— 都会先把当时的产出存成一条 salvage ref',
  },
  salvageOrphan: {
    label: '抢救出来的提交,而对应的任务已经不在树上',
    action: 'report',
    how: '重做删掉过子树,或回溯改写过树 —— 而 slug 是单向哈希,认不回是谁的',
  },
  branchOnly: {
    label: '只剩分支,工作区目录已经不在',
    action: 'merge',
    how: '上一趟清过目录没删分支;跑机实测 32 条登记项里 31 条是这形状',
  },
  trunk: {
    label: '集成分支上的提交还没送到你当前的分支',
    action: 'merge',
    how: '合的那一刻你的工作区脏 / 你在 detached HEAD 上 / 你自己回退过 / 撞了冲突',
  },
  integrationDirty: {
    label: '集成工作区里留着未提交或没解完的合并',
    action: 'report',
    how: '席位在里面跑过构建,或者一次合并失败之后现场没收拾干净',
  },
  orphanDir: {
    label: 'git 已经不认识的孤儿工作树目录',
    action: 'report',
    how: 'init() 自愈时把它挪到了 .orphan(**故意不删**:里面可能有 git 此刻读不出来的东西)',
  },
  missing: {
    label: '判了通过,而集成分支上一个字节都没多',
    action: 'backtrack',
    how: 'mergeAndRelease 在 merged === false 时自己写下的那句注记 —— 产出丢了,捞无可捞',
  },
  integrateFail: {
    label: '集成验收没通过',
    action: 'backtrack',
    how: '子任务合起来没达成父目标 —— 功能没达标,合并解决不了',
  },
  degraded: {
    label: '降级放行 —— 跑完了,但没有人判它通过',
    action: 'report',
    how: '迭代打满之后放行的',
  },
  cancelled: {
    label: '被你按 x 取消的任务',
    action: 'report',
    how: '你自己的决定 —— 列出来只是为了这份清单是完整的',
  },
} as const

export type StrandedKind = keyof typeof STRANDED_KINDS
export type StrandedAction = (typeof STRANDED_KINDS)[StrandedKind]['action']

/** 分类表的键,派生而不是手写 —— 手写的那一份会在新增一格的那天悄悄少一项。 */
export const STRANDED_KIND_LIST = Object.keys(STRANDED_KINDS) as StrandedKind[]

export interface StrandedItem {
  kind: StrandedKind
  /** 认得出是谁的就带上;`salvageOrphan` 那一格按定义没有。 */
  nodeId?: string
  title?: string
  path?: string
  branch?: string
  /** 这条分支上、集成分支还没有的提交数。 */
  commits?: number
  /** 工作区里还没提交的条目数。 */
  loose?: number
  /** 这一条为什么还卡在这儿 —— 给人看的一句话。 */
  why: string
  /**
   * **这条抢救出来的东西后来怎么样了。**
   *
   * 只有抢救那两格有。它是**调用方知道、而解冲突模型无从得知**的事实,也是这条路上唯一
   * 能防住「废稿反向污染」的东西:一条被取代的抢救分支和集成分支在同一个文件上都有内容
   * → add/add 冲突 → 一个不知情的解决者会尽力「保留双方的意图」,于是把废稿留了下来,
   * 盖在已经修好的代码上。真 git 上验过这个形状。
   *
   * 判据:这个节点后来**已经把另一版产出送进集成分支了**(`contributed`),
   * 或者它被回溯过(`backtrack`)—— 两者都意味着眼前这一版是旧的。
   * 认不回主的那些只能是 `unknown`。
   */
  fate?: 'superseded' | 'still-open' | 'unknown'
  /**
   * 探不明白。**和「这里没有东西」必须分开** —— 一个探测失败被写成跳过,在屏幕上和
   * 「干净」长得一模一样,而它们要用户做的事完全不同。
   */
  unknown?: boolean
}

export interface StrandedGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface StrandedDeps {
  git: StrandedGit
  runId: string
  gitRoot: string
  integrationBranch: string
  integrationPath: string
  /** 节点 → 工作区目录 / 分支。由池子给(路径是 hash(nodeId),外面猜不到)。 */
  pathFor: (node: TaskNode) => string
  branchFor: (node: TaskNode) => string
  /**
   * 此刻真的有一步在跑的节点。在飞的节点**不算卡住** —— 它正在被写,而它跑完自己会合一次。
   * 拿不到 = 空 = 没有节点在飞,那是真的。
   */
  inFlight?: readonly string[]
  /**
   * 盘上存不存在这个路径。**只给孤儿目录那一格用**,而它没有别的办法探:
   * 孤儿的定义就是「git 不认识它」,拿 git 去问答案恒为「不在」,那一格会变成永远为空的死代码。
   *
   * 缺席时那一格如实报进 `problems`,不静默跳过 —— 空白和「没有孤儿目录」在屏幕上一样。
   */
  exists?: (path: string) => Promise<boolean>
}

export interface StrandedReport {
  items: StrandedItem[]
  /** 按去处分组的条数,给概览行用。 */
  counts: Record<StrandedAction, number>
  /** 扫描本身出的问题(git 探不动之类)。**空数组也要有** —— 静默失败最难查。 */
  problems: string[]
}

/** 一条分支上、集成分支还没有的提交数。探不出来回 undefined,不回 0。 */
async function aheadOf(
  deps: StrandedDeps, ref: string,
): Promise<number | undefined> {
  const r = await deps.git(['rev-list', '--count', `${deps.integrationBranch}..${ref}`], deps.gitRoot)
  if (r.code !== 0) return undefined
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : undefined
}

/** `ref` 是不是已经全在集成分支里。`1` = 真的没合入;其它非零 = 探不明白。 */
async function containedIn(deps: StrandedDeps, ref: string): Promise<'yes' | 'no' | 'unknown'> {
  const r = await deps.git(['merge-base', '--is-ancestor', ref, deps.integrationBranch], deps.gitRoot)
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown'
}

/**
 * 扫一遍:这一趟有多少活卡着。**只读**,一个字节都不动。
 *
 * 顺序按「用户最可能关心什么」排:自己的分支(第 6 格)→ 每个节点的工作区与分支
 * (1/2/9/missing/integrateFail/degraded/cancelled)→ 盘上认不回主的那些
 * (salvage / salvageOrphan / branchOnly / orphanDir)→ 集成工作区。
 */
export async function scanStranded(
  deps: StrandedDeps, nodes: readonly TaskNode[],
): Promise<StrandedReport> {
  const items: StrandedItem[] = []
  const problems: string[] = []
  const busy = new Set(deps.inFlight ?? [])

  /**
   * slug → 节点。用来把盘上那些**只剩 ref** 的东西认回主。
   *
   * 正向算(对每个现存节点求 `worktreeSlug`)而不是反向解析 —— slug 是
   * `sha256(nodeId)[:8]`,**单向的**。认不回来的那些不是「跳过」,它们进 `salvageOrphan`。
   */
  const bySlug = new Map<string, TaskNode>()
  for (const n of nodes) bySlug.set(worktreeSlug(deps.runId, n.id), n)

  // ── 第 6 格:集成分支 → 你当前的分支 ────────────────────────────────
  const head = await deps.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], deps.gitRoot)
  const branch = head.stdout.trim()
  const pending = await aheadOf({ ...deps, integrationBranch: 'HEAD' }, deps.integrationBranch)
  if (pending === undefined) {
    problems.push('数不出集成分支上还有多少提交没送到你的分支(git rev-list 失败)')
  } else if (pending > 0) {
    items.push({
      kind: 'trunk',
      branch: deps.integrationBranch,
      commits: pending,
      why: head.code !== 0 || branch.length === 0
        ? '你当前是 detached HEAD(不在任何分支上)—— 合过去的提交不会留在任何分支上'
        : `还没合进 ${branch}`,
    })
  }

  // ── 每个节点 ─────────────────────────────────────────────────────
  for (const n of nodes) {
    /**
     * **在飞的节点整个跳过。** 它正在被执行者写着,而它跑完自己会合一次 ——
     * 把它列成「卡住的活」会让这份清单在一次正常运行中途看起来像一场灾难。
     */
    if (busy.has(n.id)) continue

    if (n.cancelled === true) {
      items.push({ kind: 'cancelled', nodeId: n.id, title: n.title, why: '你按 x 取消过它' })
      continue
    }

    // 功能没达标那两格 —— 它们和 git 无关,只看盘上的记录。
    /**
     * **产出丢了**:判了通过,而集成分支上一个字节都没多。
     *
     * 判据是 `mergeAndRelease` 自己写下的那句注记 —— 它在 `merged === false` 时追加,
     * 也就是「这个节点通过了验收,而它对集成分支的贡献是零」。这是「生成不知道什么原因
     * 丢失」在盘上唯一的硬证据,合并解决不了它,只能重新生成。
     */
    if (outputMissing(n)) {
      items.push({
        kind: 'missing', nodeId: n.id, title: n.title,
        why: '通过了验收,而它对集成分支的贡献是零 —— 产出不在任何地方,只能重新执行',
      })
    }
    if (n.status === 'BLOCKED' && lastIntegrateFailed(n)) {
      items.push({
        kind: 'integrateFail', nodeId: n.id, title: n.title,
        why: '集成验收没通过 —— 子任务合起来没达成父目标,合并解决不了',
      })
    }
    if ((n.degraded ?? []).length > 0 && n.status === 'ACCEPTED') {
      items.push({
        kind: 'degraded', nodeId: n.id, title: n.title,
        why: `降级放行(${(n.degraded ?? []).join('、')})—— 跑完了,但没有人判它通过`,
      })
    }

    // git 那几格。
    const path = deps.pathFor(n)
    const nodeBranch = deps.branchFor(n)
    const there = await deps.git(['rev-parse', '--git-dir'], path)
    if (there.code === 0) {
      const st = await deps.git(['-c', 'core.quotepath=false', 'status', '--porcelain'], path)
      // `--ignored` 不带:构建产物不会被 `add -A` 暂存,把它们数进「会被提交的内容」
      // 是一句精确的假话(mergeSubtree 为同一件事定过这条)。
      const looseLines = st.code === 0
        ? st.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        : []
      if (looseLines.length > 0) {
        items.push({
          kind: 'loose', nodeId: n.id, title: n.title, path, branch: nodeBranch,
          loose: looseLines.length,
          why: '工作区里还有没提交的内容',
        })
      }
      /**
       * HEAD 要在**那棵树里**问,不在 `gitRoot` 里问 —— 分支完全可能已经被删而目录还在
       * (`release()` 删分支、`c` 键删分支,两条路都留得下这种形状),那时候只有工作区自己的
       * HEAD 答得对。`cleanupWorktrees` 和 `acquire` 的抢救判据用的都是这一条。
       */
      const inWt = await deps.git(['merge-base', '--is-ancestor', 'HEAD', deps.integrationBranch], path)
      const state = inWt.code === 0 ? 'yes' : inWt.code === 1 ? 'no' : 'unknown'
      if (state === 'no') {
        const ahead = await aheadOf(deps, nodeBranch)
        items.push({
          kind: 'unmerged',
          nodeId: n.id, title: n.title, path, branch: nodeBranch,
          ...(ahead === undefined ? {} : { commits: ahead }),
          why: n.mergeConflict === true
            ? '撞了合并冲突,提交锁在它自己的分支上'
            : '有提交没合进集成分支',
        })
      } else if (state === 'unknown') {
        items.push({
          kind: 'unmerged', nodeId: n.id, title: n.title, path, branch: nodeBranch, unknown: true,
          why: `无法判断提交是否已合入(git 探测失败:${inWt.stderr.trim() || `退出码 ${inWt.code}`})`,
        })
      }
      continue
    }

    /**
     * **目录不在了,而分支还在** —— 跑机实测最常见的那一种(32 条登记项里 31 条)。
     * 那种状态下 `m` 键完全看不见它,而分支上可能带着一整个节点的产出。
     */
    const hasBranch = await deps.git(['rev-parse', '--verify', '--quiet', nodeBranch], deps.gitRoot)
    if (hasBranch.code === 0) {
      const state = await containedIn(deps, nodeBranch)
      if (state !== 'yes') {
        const ahead = await aheadOf(deps, nodeBranch)
        items.push({
          kind: 'branchOnly', nodeId: n.id, title: n.title, branch: nodeBranch,
          ...(ahead === undefined ? {} : { commits: ahead }),
          ...(state === 'unknown' ? { unknown: true } : {}),
          why: state === 'unknown'
            ? '工作区目录已经不在,而它的分支是否已合入探不明白'
            : '工作区目录已经不在,但分支上还有没合入的提交',
        })
      }
    }
  }

  // ── 抢救分支 ────────────────────────────────────────────────────
  const salv = await deps.git(
    ['for-each-ref', '--format=%(refname:short)', `refs/heads/efftask/${deps.runId}/salvage`],
    deps.gitRoot,
  )
  if (salv.code !== 0) {
    problems.push(`列不出抢救分支(${salv.stderr.trim() || `退出码 ${salv.code}`})—— 这一格这次是空白,不代表没有`)
  } else {
    for (const ref of salv.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      const state = await containedIn(deps, ref)
      if (state === 'yes') continue
      const ahead = await aheadOf(deps, ref)
      /**
       * 认回是谁的:ref 的最后一段是 slug(可能带 `-2`/`-3` 后缀,见 `salvageRefFor`)。
       * 认不回来的**不是跳过** —— 它进 `salvageOrphan` 并如实说「对应的任务已不在树上」。
       */
      const tail = ref.split('/').pop() ?? ''
      const slug = tail.replace(/-\d+$/, '')
      const owner = bySlug.get(slug)
      /**
       * **来历要算出来,不能写死。**
       *
       * 验收实测:这个字段此前在 `rescue.ts` 里被硬编码成 `still-open`,于是
       * `provenanceNote` 的 superseded 特判、`makeRescueTriage` 提示词里那句
       * 「这个任务后来:被重做过」**永远处于未武装状态** —— 而且更糟的是,它把一句
       * 反过来的假事实(「还没有别的版本合入」)交给了分诊模型。
       * 真 git 上跑出来的结果:废稿被合进了集成分支,盖在已修好的实现上。
       */
      const fate: 'superseded' | 'still-open' | 'unknown' = owner === undefined
        ? 'unknown'
        : (owner.contributed === true || owner.backtrack !== undefined) ? 'superseded' : 'still-open'
      items.push(owner
        ? {
          kind: 'salvage', nodeId: owner.id, title: owner.title, branch: ref, fate,
          ...(ahead === undefined ? {} : { commits: ahead }),
          ...(state === 'unknown' ? { unknown: true } : {}),
          why: '这个任务此前某一版的产出被抢救在这里,还没合进集成分支',
        }
        : {
          kind: 'salvageOrphan', branch: ref, fate,
          ...(ahead === undefined ? {} : { commits: ahead }),
          ...(state === 'unknown' ? { unknown: true } : {}),
          why: '抢救出来的提交,但对应的任务已经不在树上了(重做或回溯改写过树)',
        })
    }
  }

  // ── 集成工作区 ──────────────────────────────────────────────────
  const intSt = await deps.git(['-c', 'core.quotepath=false', 'status', '--porcelain'], deps.integrationPath)
  if (intSt.code === 0) {
    const lines = intSt.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const conflicted = lines.filter(l => /^(UU|AA|DU|UD|AU|UA|DD) /.test(l))
    if (lines.length > 0) {
      items.push({
        kind: 'integrationDirty', path: deps.integrationPath, loose: lines.length,
        why: conflicted.length > 0
          ? `留着一次没解完的合并(${conflicted.length} 个冲突文件)—— 下一次合并会被它挡住`
          : '有未提交的内容(席位在里面跑过构建)—— 下一次合并会先把它清掉',
      })
    }
  }

  // ── 孤儿目录 ────────────────────────────────────────────────────
  /**
   * `healIntegrationSlot` 把 git 已经不认识的工作树目录挪到 `<路径>.orphan`(以及
   * `.orphan-2`……),**故意不删** —— 里面可能有 git 此刻读不出来的东西。它今天只在关口的
   * notices 里出现一句,而**没有任何一条路径**会再去看它:挪走一个 15G 的目录之后就此失联。
   *
   * 判据必须是**盘上存不存在**,不能用 `git rev-parse --git-dir` —— 孤儿的定义就是
   * 「git 不认识它」,拿 git 去问一个 git 不认识的东西,答案恒为「不在」,这一格会变成
   * 永远为空的死代码。所以要一个真正的存在性接缝。
   */
  if (deps.exists) {
    for (let i = 1; i < 10; i++) {
      const p = i === 1 ? `${deps.integrationPath}.orphan` : `${deps.integrationPath}.orphan-${i}`
      if (!(await deps.exists(p))) continue
      items.push({
        kind: 'orphanDir', path: p,
        why: '这是自愈时挪走的孤儿工作树目录,里面可能还有东西 —— 确认无用后请自行删除',
      })
    }
  } else {
    // 缺席**要说**:这一格这次是空白,而空白和「没有孤儿目录」在屏幕上长得一样。
    problems.push('没有可用的目录探测接缝,这一趟没有检查孤儿工作树目录(.orphan)')
  }

  const counts: Record<StrandedAction, number> = { merge: 0, backtrack: 0, report: 0 }
  for (const it of items) counts[STRANDED_KINDS[it.kind].action] += 1
  return { items, counts, problems }
}


/**
 * **这里刻意**没有**一个 `strandedLines` 渲染器。**
 *
 * 曾经有过,而它从落地那天起就只被自己的测试引用 —— 上屏那一份住在
 * `mergeSubtree.subtreeMergeLines`(它按「这个键认领哪几格」组织,而不是按分类法组织,
 * 因为用户看那一屏是为了决定按哪个键)。两份渲染器里活着的那份总会先退化,
 * 而这个仓库为「声明了、实现了、测过了,而生产上没有任何人用它」付过账。
 *
 * 需要一份独立视图时,从 `StrandedReport` 现写 —— 分类表 `STRANDED_KINDS` 带着
 * label / action / how 三样,足够任何一屏自己组织。
 */
