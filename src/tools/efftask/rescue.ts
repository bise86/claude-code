import { mergeIntoIntegration, type IntegrationMergeDeps } from './integrationMerge.js'
import type { StrandedItem } from './stranded.js'

/**
 * **把那四类今天谁都捞不到的东西捞回来** —— 触发回溯时由主模型辅助分诊。
 *
 * 用户原话:「穷举出来最要命的是四类今天谁都捞不到的,这个必须要捞回,用主模型辅助,
 * 在触发回溯时。」
 *
 * 四类(判据与来历见 `stranded.ts` 的分类表):
 *
 *  - `branchOnly` —— **只剩分支,工作区目录已经不在**。跑机实测(etcd3)32 条工作树登记项里
 *    31 条是这形状,而 `m` 键走 `childIds → pathFor(node)`,对它完全看不见。
 *  - `salvage` —— **抢救出来的提交**。它正是在目录被毁那一刻建的,所以按定义没有目录。
 *  - `salvageOrphan` —— 同上,**而且连是谁的都不知道**(slug 是 `sha256(nodeId)[:8]`,单向)。
 *  - `orphanDir` —— 自愈挪走的孤儿目录。**它已经不是 git 工作树了**,`git merge` 用不上。
 *
 * ## 主模型在这里只做一件事:分诊
 *
 * 前三类机械上都能 `git merge` 进集成分支,难的不是怎么合,是**该不该合**:
 * `discard` 抢救下来的东西里有一类是**被验收否决过的产出**,节点后来重做出了正确版本。
 * 把它合回去会撞 add/add 冲突,而解冲突的模型**不知道右边那半是被否决的** —— 真 git 上
 * 验过这个形状,结果是一个已经修好的文件被一份废稿反向污染。
 *
 * 所以主模型拿到的是**证据**(这条 ref 相对集成分支的 diffstat、它对应的任务后来怎么样了),
 * 输出的是**分诊**(合 / 不合 / 拿不准),而**不是**判决、不是解冲突方案。三条硬规矩:
 *
 *  1. **模型只分诊,不动手** —— 合并由 git 做,复核由 git 做;
 *  2. **拿不准一律不合**,并如实说「拿不准」(默认方向朝安全那一侧:不合只是没捞到,
 *     合错了是把废稿盖到已经修好的代码上);
 *  3. **一个字节都不删** —— 「捞」是往集成分支加东西,不是清理。分支合完照样留着,
 *     孤儿目录合完照样留着,由用户自己处置。
 *
 * ## 孤儿目录为什么要单独一条路
 *
 * 它不是工作树,没有 HEAD、没有分支,`git merge` 无从谈起。唯一能做的是**逐文件比对**:
 * `git hash-object` 对 `git rev-parse <集成分支>:<路径>`(第十七轮在跑机上用这一招判断过
 * 「能不能把共享工作树里的产出补录成集成分支上的一个提交」)。三种结果:
 *
 *  - 内容一致 → 没什么可捞;
 *  - 集成分支里**根本没有**这个路径 → 候选(最可能是真的丢了的产出);
 *  - 内容不同 → 候选,但**风险最高**(可能是旧版本),交给分诊。
 */

export interface RescueGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

/** 一条 ref 相对集成分支带来了什么 —— 交给分诊的**证据**,不是结论。 */
export interface RescueEvidence {
  ref: string
  commits: number
  /** `git diff --stat` 的摘要行,截断给人/模型看。 */
  files: string[]
  fileCount: number
  /** 认得出主的话带上;`salvageOrphan` 那一格按定义没有。 */
  nodeId?: string
  title?: string
  /**
   * 对应的任务后来怎么样了 —— **分诊最关键的一条证据**。
   *
   * `superseded` = 那个任务后来重做过、或者已经通过验收并合入了别的版本。
   * 这一版八成是废稿,合回去就是拿它去污染已经修好的代码。
   */
  fate?: 'superseded' | 'still-open' | 'unknown'
}

/** 分诊结论。**只有三种**,而「拿不准」必须是独立一种,不能被并进「不合」。 */
export type RescueVerdict = 'merge' | 'skip' | 'unsure'

/**
 * 派主模型分诊一批证据。
 *
 * 注入而不是直接调 `runAgent`:这个模块是纯的,而 `RunAgentFn` 要节点、要角色、要窗口 ——
 * 那些住在命令层。**不给 = 全部按 `unsure` 处理并如实说出来**,而不是默默全合
 * (默认方向必须朝安全那一侧)。
 */
export type RescueTriage = (evidence: RescueEvidence[]) => Promise<
  { ref: string; verdict: RescueVerdict; why: string }[]
>

export interface RescueDeps {
  git: RescueGit
  gitRoot: string
  integrationBranch: string
  integrationPath: string
  /** 临时合并工作树建在哪 —— 模型解冲突就发生在那里(见 `integrationMerge.ts`)。 */
  worktreeRoot: string
  /** 集成工作区只有一个 index、一个检出 —— 合并必须排队。由池子的 `withIntegrationRead` 给。 */
  withIntegrationLock: <T>(fn: () => Promise<T>) => Promise<T>
  triage?: RescueTriage
  /**
   * **用解决合并冲突的模型来执行合并**(用户原话)。
   *
   * 不给 = 撞了冲突就如实报告,而不是假装没有这个功能。给了的话,合并本身走
   * `mergeIntoIntegration`:在一棵**专用的临时工作树**里合、在那里迭代解、
   * 最后只用一次毫秒级快进进集成分支 —— 模型调用一次都不在 `mergeLock` 里。
   */
  resolve?: IntegrationMergeDeps['resolve']
  /** 同一次合并最多让模型解几轮。见 `caps.trunkResolveRounds`。 */
  rounds?: number
  onProgress?: (line: string) => void
  signal?: AbortSignal
}

export interface RescueCandidate {
  item: StrandedItem
  evidence: RescueEvidence
  verdict: RescueVerdict
  why: string
}

export interface RescuePlan {
  /** 分诊判「合」的。 */
  merge: RescueCandidate[]
  /** 分诊判「不合」或「拿不准」的 —— **照样列出来**,附上能照做的 git 命令。 */
  hold: RescueCandidate[]
  /** 孤儿目录里可能有、而集成分支上没有的文件。 */
  orphanFiles: { path: string; files: { rel: string; kind: 'absent' | 'differs' }[] }[]
  problems: string[]
}

/** 这条 ref 相对集成分支的证据。探不动就回 undefined —— 没有证据不许分诊。 */
async function evidenceFor(
  deps: RescueDeps, ref: string, over: Partial<RescueEvidence> = {},
): Promise<RescueEvidence | undefined> {
  const count = await deps.git(['rev-list', '--count', `${deps.integrationBranch}..${ref}`], deps.gitRoot)
  if (count.code !== 0) return undefined
  const commits = Number.parseInt(count.stdout.trim(), 10) || 0
  // `--name-only` 而不是 `--stat`:后者的宽度随终端变,而这串东西要进提示词。
  const diff = await deps.git(
    ['-c', 'core.quotepath=false', 'diff', '--name-only', `${deps.integrationBranch}...${ref}`],
    deps.gitRoot,
  )
  const files = diff.code === 0
    ? diff.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    : []
  return { ref, commits, files: files.slice(0, 20), fileCount: files.length, ...over }
}

/**
 * 一个孤儿目录里有什么是集成分支上没有的。
 *
 * 逐文件比 `git hash-object` 与 `git rev-parse <集成分支>:<路径>` —— 第十七轮在跑机上
 * 用的就是这一招。**只读**,一个字节都不动。
 */
export async function orphanDirFindings(
  deps: RescueDeps,
  dir: string,
  listFiles: (dir: string) => Promise<string[]>,
): Promise<{ files: { rel: string; kind: 'absent' | 'differs' }[]; problems: string[] }> {
  const problems: string[] = []
  let rels: string[]
  try {
    rels = await listFiles(dir)
  } catch (e) {
    return { files: [], problems: [`读不出孤儿目录 ${dir}(${e instanceof Error ? e.message : String(e)})`] }
  }
  const out: { rel: string; kind: 'absent' | 'differs' }[] = []
  for (const rel of rels) {
    const mine = await deps.git(['hash-object', `${dir}/${rel}`], deps.gitRoot)
    if (mine.code !== 0) {
      problems.push(`算不出 ${rel} 的哈希(${mine.stderr.trim() || `退出码 ${mine.code}`})—— 这一个没有比对`)
      continue
    }
    const theirs = await deps.git(['rev-parse', `${deps.integrationBranch}:${rel}`], deps.gitRoot)
    // 集成分支上根本没有这个路径 —— 最可能是真的丢了的产出。
    if (theirs.code !== 0) { out.push({ rel, kind: 'absent' }); continue }
    if (theirs.stdout.trim() !== mine.stdout.trim()) out.push({ rel, kind: 'differs' })
  }
  return { files: out, problems }
}

/**
 * 算出「按下确认之后会捞回什么」。**只读**。
 *
 * `triage` 缺席时全部落 `unsure` 并进 `hold` —— 默认方向朝安全那一侧,而且要说出来:
 * 默默全合的后果是把一份被验收否决过的废稿盖到已经修好的代码上。
 */
export async function planRescue(
  deps: RescueDeps,
  items: readonly StrandedItem[],
  orphanLister?: (dir: string) => Promise<string[]>,
): Promise<RescuePlan> {
  const problems: string[] = []
  const withRef: { item: StrandedItem; evidence: RescueEvidence }[] = []

  for (const it of items) {
    if (it.kind !== 'branchOnly' && it.kind !== 'salvage' && it.kind !== 'salvageOrphan') continue
    if (it.branch === undefined) continue
    const ev = await evidenceFor(deps, it.branch, {
      ...(it.nodeId ? { nodeId: it.nodeId } : {}),
      ...(it.title ? { title: it.title } : {}),
      /**
       * **来历由清单算出来,这里不许写死。**
       *
       * 上一版这里是 `it.kind === 'salvageOrphan' ? 'unknown' : 'still-open'` —— 于是
       * `provenanceNote` 的 superseded 特判和分诊提示词里那句「被重做过」**永远不触发**,
       * 而且把一句反过来的假事实交给了模型。验收在真 git 上跑出的结果是废稿被合进集成分支。
       */
      fate: it.fate ?? (it.kind === 'salvageOrphan' ? 'unknown' : 'still-open'),
    })
    if (!ev) {
      problems.push(`${it.branch}:探不出它相对集成分支带来了什么,没有分诊(git 失败)`)
      continue
    }
    // 相对集成分支一个提交都没多 = 已经全在里面了,没什么可捞。
    if (ev.commits === 0 && ev.fileCount === 0) continue
    withRef.push({ item: it, evidence: ev })
  }

  let verdicts: { ref: string; verdict: RescueVerdict; why: string }[] = []
  if (deps.triage && withRef.length > 0) {
    try {
      verdicts = await deps.triage(withRef.map(w => w.evidence))
    } catch (e) {
      problems.push(`分诊调用没打通(${e instanceof Error ? e.message : String(e)})—— 这一批全部按「拿不准」处理,没有自动合并`)
    }
  } else if (withRef.length > 0) {
    problems.push('这一趟没有可用的分诊模型 —— 全部按「拿不准」处理,只列出来不自动合并')
  }
  const byRef = new Map(verdicts.map(v => [v.ref, v]))

  const merge: RescueCandidate[] = []
  const hold: RescueCandidate[] = []
  for (const w of withRef) {
    const v = byRef.get(w.evidence.ref)
    /**
     * **模型没提到的那些也是「拿不准」,不是「合」。** 一个只回了半张表的模型,
     * 剩下那半不该因为沉默而被当成同意 —— 这个仓库为「沉默被读成同意」付过账。
     */
    const verdict: RescueVerdict = v?.verdict ?? 'unsure'
    const why = v?.why ?? '分诊没有覆盖这一条'
    const c: RescueCandidate = { item: w.item, evidence: w.evidence, verdict, why }
    if (verdict === 'merge') merge.push(c)
    else hold.push(c)
  }

  const orphanFiles: RescuePlan['orphanFiles'] = []
  for (const it of items) {
    if (it.kind !== 'orphanDir' || it.path === undefined) continue
    if (!orphanLister) {
      problems.push(`孤儿目录 ${it.path}:没有目录遍历接缝,这一趟没有比对里面的内容`)
      continue
    }
    const f = await orphanDirFindings(deps, it.path, orphanLister)
    problems.push(...f.problems)
    if (f.files.length > 0) orphanFiles.push({ path: it.path, files: f.files })
  }

  return { merge, hold, orphanFiles, problems }
}

export interface RescueOutcome {
  merged: { ref: string; commits: number; title?: string; resolvedFiles?: string[] }[]
  failed: { ref: string; why: string }[]
  problems: string[]
  aborted: boolean
}

/**
 * 交给解冲突模型的那句「另一半是什么来历」。
 *
 * 这是**调用方知道、而模型无从得知**的事实,也是这条路上唯一能防住「废稿反向污染」的东西:
 * 一条被取代的抢救分支和集成分支在同一个文件上都有内容 → add/add 冲突 → 一个不知情的
 * 解决者会尽力「保留双方的意图」,于是把废稿留了下来。真 git 上验过这个形状。
 */
export function provenanceNote(c: RescueCandidate): string {
  const who = c.evidence.title ?? c.evidence.nodeId ?? '一个已经不在树上的任务'
  const base = `正在合入的这一半来自 ${quote(c.evidence.ref)} —— 「${who}」此前某一版产出的抢救分支,` +
    `它没有合进过集成分支。分诊结论:${c.why}`
  if (c.evidence.fate === 'superseded') {
    // 这一句是这条路存在的全部理由,不能省成一句泛泛的提醒。
    return `${base}\n**注意:这一版已经被后来的版本取代。** 冲突时以集成分支(HEAD)那一侧为准,` +
      `只在被合入的这一侧含有集成分支**确实缺失**的内容时才采纳它 —— 不要为了「保留双方意图」` +
      `把已经被替换掉的旧实现留下来。`
  }
  return `${base}\n冲突时优先保住集成分支(HEAD)已有的行为,把这一侧独有的产出补进去。`
}

const quote = (s: string): string => `\`${s}\``

/**
 * 真的捞。**只对分诊判「合」的那些**,一个都不多。
 *
 * 合进**集成分支**(在集成工作区里,拿锁),不直接碰用户的分支 —— 送到用户分支那一跳
 * 由收口/`m` 那条路统一做,它有脏树、detached、冲突的整套判据。
 *
 * 撞冲突就**收拾干净再报告**:判据是收拾完之后 `MERGE_HEAD` 还在不在,**不看 abort 的
 * 退出码** —— 没有合并可中止时 git 回 128 而树是干净的,按退出码判会报一句假的「还原失败」。
 * (自动解冲突接在这一步之后,那是「先同步主干再迭代解」那一批的事。)
 *
 * **成功不删分支**:捞是往集成分支加东西,不是清理。删除不可逆,而这条 ref 是那一版产出
 * 唯一的落脚点。
 */
export async function runRescue(deps: RescueDeps, plan: RescuePlan): Promise<RescueOutcome> {
  const out: RescueOutcome = { merged: [], failed: [], problems: [...plan.problems], aborted: false }
  for (const c of plan.merge) {
    if (deps.signal?.aborted) { out.aborted = true; break }
    const ref = c.evidence.ref
    deps.onProgress?.(`捞回 ${ref}(${c.evidence.commits} 个提交)…`)
    /**
     * **合并本身交给解冲突的模型**(用户原话:「用解决合并冲突的模型来执行合并」)。
     *
     * 合发生在一棵**专用的临时工作树**里,不是集成工作区 —— 后者只有一个 index、一个检出,
     * 而 `commitAndMerge` 写它、集成验收读它,两者共用 `mergeLock`。把一次几分钟的模型
     * 调用关进那把锁,整棵树的合并当场停摆。锁只用在最后那一次毫秒级快进上。
     *
     * `provenanceNote` 一路带到解冲突的提示词里 —— 少了它,一个不知情的解决者会把
     * 被取代的废稿「保留双方意图」地留下来。
     */
    const res = await mergeIntoIntegration(
      {
        git: deps.git,
        gitRoot: deps.gitRoot,
        integrationBranch: deps.integrationBranch,
        integrationPath: deps.integrationPath,
        worktreeRoot: deps.worktreeRoot,
        withIntegrationLock: deps.withIntegrationLock,
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
        ...(deps.rounds === undefined ? {} : { rounds: deps.rounds }),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      },
      ref,
      provenanceNote(c),
    )
    if (res.ok) {
      out.merged.push({
        ref, commits: c.evidence.commits,
        ...(c.evidence.title ? { title: c.evidence.title } : {}),
        ...(res.resolvedFiles.length > 0 ? { resolvedFiles: res.resolvedFiles } : {}),
      })
      continue
    }
    out.failed.push({ ref, why: res.why })
    if (!res.restored) {
      // 临时工作树停在半合并态 —— 下一条捞会被它挡住,必须说,而且到此为止。
      out.problems.push(
        `临时合并工作区里留着一次没收拾干净的合并(${ref})—— 请到 ${deps.worktreeRoot}/merge-scratch 处理`,
      )
      break
    }
  }
  return out
}

/** 确认屏那几行。**是数据,不是 JSX**。 */
export function rescueLines(plan: RescuePlan): string[] {
  const out: string[] = []
  if (plan.merge.length === 0 && plan.hold.length === 0 && plan.orphanFiles.length === 0) {
    out.push('没有需要捞回来的东西:孤立的分支和目录里都没有集成分支缺的内容。')
  }
  if (plan.merge.length > 0) {
    const total = plan.merge.reduce((s, c) => s + c.evidence.commits, 0)
    out.push(`将把 ${plan.merge.length} 处孤立的产出(共 ${total} 个提交)合进集成分支:`)
    for (const c of plan.merge) {
      out.push(`  · ${c.evidence.title ?? c.evidence.ref}(${c.evidence.fileCount} 个文件):${c.why}`)
    }
    out.push('合完这些分支**照样保留** —— 捞是往集成分支加东西,不是清理。')
  }
  if (plan.hold.length > 0) {
    // 「拿不准」和「判定不合」要分开数:前者是我们没把握,后者是有理由的排除。
    const unsure = plan.hold.filter(c => c.verdict === 'unsure').length
    out.push(`保留不合 ${plan.hold.length} 处${unsure > 0 ? `(其中 ${unsure} 处拿不准)` : ''}:`)
    for (const c of plan.hold) {
      out.push(`  · ${c.evidence.title ?? c.evidence.ref}:${c.why}`)
      out.push(`    想自己看:git log ${c.evidence.ref} · git diff <集成分支>...${c.evidence.ref}`)
    }
  }
  for (const o of plan.orphanFiles) {
    const absent = o.files.filter(f => f.kind === 'absent').length
    out.push(`孤儿目录 ${o.path} 里有 ${o.files.length} 个文件不在集成分支上(${absent} 个是集成分支根本没有的):`)
    for (const f of o.files.slice(0, 5)) {
      out.push(`  · ${f.rel}(${f.kind === 'absent' ? '集成分支上没有' : '内容不同'})`)
    }
    // 它不是 git 工作树,合不进来 —— 这句必须说,否则用户以为按一下就收进去了。
    out.push('  ⚠ 这个目录已经不是 git 工作树,没法合并;请自行确认后手工取用(目录不会被删)。')
  }
  for (const p of plan.problems) out.push(`⚠ ${p}`)
  return out
}
