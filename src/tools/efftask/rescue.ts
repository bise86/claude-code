import { backfillFromDir, backfillFromRef, type BackfillSkip, type CopyInto } from './backfill.js'
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
 * ## 三级递降 —— 「必须尽最大努力去捞」(用户 2026-08-13 原话)
 *
 * 上面第 2 条**原样有效**,而「不合」不等于「不试」。一次分诊、一种手段、失败即止,
 * 那是一次判决,不是最大努力。所以拆成三级,每一级严格弱于上一级:
 *
 * | 级 | 手段 | 谁进这一级 |
 * |---|---|---|
 * | 1 | 整条 `git merge`(解冲突模型) | 分诊判 `merge` |
 * | 2 | **加法补录**:只取「这条 ref 上有、而集成分支上根本没有」的路径(见 `backfill.ts`) | `unsure` 且**不是**被取代的那些;以及第 1 级合失败的 |
 * | 3 | 在节点上落痕 → `b` 回溯认领 → 重新执行 / 完全重做 | 前两级之后仍有内容没进来的 |
 *
 * 第 2 级**不是合并**:它只加集成分支从来没有过的路径,落成单独一笔可 `revert` 的提交,
 * 那条 ref 也不会被记成已合入。「拿不准一律不合」因此没有被翻面 —— 加进来的东西按 git 的
 * 复核(`--diff-filter=DMR` 必须为空)覆盖不了任何已有内容。
 *
 * **`skip` 不进第 2 级,也不落痕。** `unsure` 是我们没把握,`skip` 是分诊**有理由地**排除
 * (最典型:这一版被后来的版本取代)。一个被取代的版本里「集成分支上没有」的文件,
 * 很可能正是后继版本**故意删掉**的那个 —— 补录回去是另一种污染;而让 `b` 去重做一个
 * 有理由被排除的废稿是纯破坏。同理 `fate === 'superseded'` 的 `unsure` 也不补录。
 * 但屏幕上必须把这两类**分开说**,并给出推翻这次分诊的命令 —— 混在一句「保留不合」里,
 * 用户读到的是「先放着」,而实际是「永远放着」。
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
  /**
   * 孤儿目录补录用的拷贝接缝(纯模块不许自己碰 fs)。
   *
   * **不给 = 那一格退回「只列不捞」,并且要在 `problems` 里说出来** —— 四类里
   * 它是此前唯一 0% 捞回的一格,静默退回等于这条路白写。
   */
  copyInto?: CopyInto
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
  /**
   * 第 2 级:**加法补录**。`unsure` 且不是被取代的那些 —— 只取集成分支根本没有的路径。
   *
   * 和 `hold` 分开是判据的一部分,不是渲染口味:混在一个桶里的后果是屏幕上写着
   * 「保留不合」而代码正要往集成分支写东西。
   */
  backfill: RescueCandidate[]
  /** 分诊判「不合」、以及被取代的「拿不准」—— **照样列出来**,附上能照做的 git 命令。 */
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
    /**
     * **模型漏说的那几条,单独再问一轮。**
     *
     * 一次沉默 = 永久放弃,那不是最大努力。第二轮只带**没被覆盖**的那些(证据一样,
     * 但清单短得多,而漏说最常见的成因就是清单长)。**最多一轮** —— 再多也只是把
     * 同样的沉默推迟几分钟。
     *
     * 中断要在发之前看:`planRescue` 此前从头到尾没读过 `deps.signal`,于是 Esc 之后
     * 首轮照发;加一轮就是照发两次。
     */
    const covered = new Set(verdicts.map(v => v.ref))
    const missed = withRef.filter(w => !covered.has(w.evidence.ref))
    if (missed.length > 0 && missed.length < withRef.length && !deps.signal?.aborted) {
      deps.onProgress?.(`分诊漏了 ${missed.length} 条,单独再问一轮…`)
      try {
        const more = await deps.triage(missed.map(w => w.evidence))
        // 第二轮只补,不覆盖首轮已经给过的结论。
        for (const v of more) if (!covered.has(v.ref)) { verdicts.push(v); covered.add(v.ref) }
      } catch (e) {
        problems.push(`第二轮分诊也没打通(${e instanceof Error ? e.message : String(e)})—— 漏掉的那 ${missed.length} 条按「拿不准」处理`)
      }
    }
  } else if (withRef.length > 0) {
    problems.push('这一趟没有可用的分诊模型 —— 全部按「拿不准」处理,只列出来不自动合并')
  }
  const byRef = new Map(verdicts.map(v => [v.ref, v]))

  const merge: RescueCandidate[] = []
  const backfill: RescueCandidate[] = []
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
    /**
     * **被取代的那一版不补录。** 它「集成分支上没有」的文件,很可能正是后继版本故意
     * 删掉的那个 —— 和「集成分支删过这条路径」是同一个形状,而那一条在 `backfill.ts`
     * 里也是不收。这里挡的是同一件事在 ref 这一层的版本。
     */
    else if (verdict === 'unsure' && w.evidence.fate !== 'superseded') backfill.push(c)
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
  /**
   * 接缝缺席**要说**。四类里孤儿目录是此前唯一 0% 捞回的一格,静默退回「只列不捞」
   * 就是这个仓库的招牌断线:声明了、实现了、测过了,而生产上没有人调用。
   */
  if (orphanFiles.some(o => o.files.some(f => f.kind === 'absent')) && !deps.copyInto) {
    problems.push('孤儿目录里有集成分支缺失的文件,但这一趟没有拷贝接缝 —— 只列出来,没有补录')
  }

  return { merge, backfill, hold, orphanFiles, problems }
}

export interface RescueOutcome {
  merged: { ref: string; commits: number; title?: string; resolvedFiles?: string[] }[]
  /** 第 2 级真的补进集成分支的。`added` 为空也要留一条 —— 「试过了,一个都没得补」是结论。 */
  backfilled: { ref: string; title?: string; added: string[]; skipped: BackfillSkip[]; nodeId?: string }[]
  failed: { ref: string; why: string }[]
  /**
   * **三级都试过、仍然没捞回来的。** 这份清单是第 3 级(落痕 → `b` 回溯)的**唯一**输入。
   *
   * 判据是 git 说了算的:补录之后再问一次 `git diff --name-only <集成分支> <ref>`,
   * 还有内容 = 还有东西没进来。不是「我们放弃了」,是「量出来还差这些」。
   */
  stranded: { ref: string; nodeId?: string; title?: string; why: string; remaining: number }[]
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
  const out: RescueOutcome = {
    merged: [], backfilled: [], failed: [], stranded: [], problems: [...plan.problems], aborted: false,
  }
  /** 这条 ref 相对集成分支还剩多少路径没进来。**捞完之后由 git 重新量**,不靠记账。 */
  const remainingOf = async (ref: string): Promise<number> => {
    const d = await deps.git(['diff', '--name-only', '-z', deps.integrationBranch, ref], deps.gitRoot)
    if (d.code !== 0) return -1
    return d.stdout.split('\0').map(s => s.trim()).filter(Boolean).length
  }
  /** 第 3 级:记一条「三级都试过、还是没回来」。`-1` = 连量都量不出来,那更要说。 */
  const strand = async (c: RescueCandidate, why: string): Promise<void> => {
    const remaining = await remainingOf(c.evidence.ref)
    if (remaining === 0) return
    out.stranded.push({
      ref: c.evidence.ref, why, remaining,
      ...(c.evidence.nodeId ? { nodeId: c.evidence.nodeId } : {}),
      ...(c.evidence.title ? { title: c.evidence.title } : {}),
    })
  }
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
    /**
     * **合不上不等于捞不到。** 一次解不掉的冲突只说明「同一个文件两边都改了」,
     * 而这条 ref 上那些**集成分支根本没有**的文件和这场冲突毫无关系 —— 它们此前
     * 跟着整条 ref 一起被放弃了。降到第 2 级。
     */
    await descend(deps, out, c, `第 1 级合并没成(${res.why})`)
  }

  // ── 第 2 级:分诊拿不准的那些 ────────────────────────────────────
  for (const c of plan.backfill) {
    if (deps.signal?.aborted) { out.aborted = true; break }
    await descend(deps, out, c, '分诊拿不准,没有整条合并')
  }

  // ── 第 2 级:孤儿目录 ───────────────────────────────────────────
  for (const o of plan.orphanFiles) {
    if (deps.signal?.aborted) { out.aborted = true; break }
    const absent = o.files.filter(f => f.kind === 'absent').map(f => f.rel)
    if (absent.length === 0 || !deps.copyInto) continue
    const res = await backfillFromDir(
      deps, o.path, absent, deps.copyInto,
      `来自自愈时挪走的孤儿工作树目录 ${o.path};只补录集成分支上根本没有的路径。`,
    )
    out.backfilled.push({ ref: o.path, added: res.added, skipped: res.skipped })
    if (!res.ok && res.why !== undefined) out.problems.push(`孤儿目录 ${o.path} 补录没成:${res.why}`)
  }

  // ── 第 3 级:分诊判「拿不准」而被取代、因此连补录都没做的 ────────
  for (const c of plan.hold) {
    // `skip` 是**有理由的排除**,不落痕 —— 让 `b` 去重做一个废稿是纯破坏。
    if (c.verdict !== 'unsure') continue
    await strand(c, `分诊拿不准,而这一版已经被后来的版本取代,没有补录:${c.why}`)
  }
  return out
}

/**
 * 降到第 2 级:加法补录,然后**用 git 重新量**还剩多少没进来。
 *
 * 补录成功 ≠ 全部捞回:一条 ref 上「两边都有、而内容不同」的文件按判据一个都不会进来
 * (那正是唯一会覆盖的一格)。所以这里不记「成功」,只记**量出来的差额** —— 差额还在,
 * 就交给第 3 级。
 */
async function descend(
  deps: RescueDeps, out: RescueOutcome, c: RescueCandidate, why: string,
): Promise<void> {
  const ref = c.evidence.ref
  deps.onProgress?.(`补录 ${ref} 上集成分支缺失的文件…`)
  const res = await backfillFromRef(deps, ref, provenanceNote(c))
  out.backfilled.push({
    ref, added: res.added, skipped: res.skipped,
    ...(c.evidence.title ? { title: c.evidence.title } : {}),
    ...(c.evidence.nodeId ? { nodeId: c.evidence.nodeId } : {}),
  })
  if (!res.ok && res.why !== undefined) out.problems.push(`${ref} 补录没成:${res.why}`)
  const d = await deps.git(['diff', '--name-only', '-z', deps.integrationBranch, ref], deps.gitRoot)
  const remaining = d.code !== 0
    ? -1
    : d.stdout.split('\0').map(s => s.trim()).filter(Boolean).length
  if (remaining === 0) return
  out.stranded.push({
    ref, remaining,
    why: res.added.length > 0
      ? `${why};补录了 ${res.added.length} 个文件,还有 ${remaining} 处两边都有而内容不同的没能捞回`
      : why,
    ...(c.evidence.nodeId ? { nodeId: c.evidence.nodeId } : {}),
    ...(c.evidence.title ? { title: c.evidence.title } : {}),
  })
}

/**
 * 确认屏那几行。**是数据,不是 JSX**。
 *
 * `canBackfillOrphan` = 这一趟有没有拷贝接缝。**必须由调用方传真值**:孤儿目录那一格
 * 会不会真的被补录取决于它,而屏幕是在用户按下 `y` **之前**读的。
 */
export function rescueLines(plan: RescuePlan, canBackfillOrphan = false): string[] {
  const out: string[] = []
  if (plan.merge.length === 0 && plan.backfill.length === 0 && plan.hold.length === 0
    && plan.orphanFiles.length === 0) {
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
  /**
   * 第 2 级要**单独说**,而且要说清它和第 1 级不是一回事:整条合进去和只捡集成分支没有的
   * 文件,对用户是两个不同的事实,而上一版把它们混在同一句「保留不合」里 —— 屏幕说着
   * 「保留不合」,代码正要往集成分支写东西。
   */
  if (plan.backfill.length > 0) {
    out.push(`另有 ${plan.backfill.length} 处分诊拿不准,**不整条合并**,但会尽最大努力捞:`
      + '只把「集成分支上根本没有」的文件补录进去(单独一笔提交,覆盖不了任何已有内容,随时可以 git revert)。')
    for (const c of plan.backfill) {
      out.push(`  · ${c.evidence.title ?? c.evidence.ref}(${c.evidence.fileCount} 个文件):${c.why}`)
    }
    out.push('  两边都有、而内容不同的那些**一个都不会动** —— 那是唯一会覆盖的一格,留给回溯。')
  }
  if (plan.hold.length > 0) {
    // 「拿不准」和「判定不合」是两件事,而且**归宿不同**:前者会被补录/落痕,
    // 后者到此为止。混在一行里,用户读到的是「先放着」,实际是「永远放着」。
    const skipped = plan.hold.filter(c => c.verdict === 'skip')
    const superseded = plan.hold.filter(c => c.verdict !== 'skip')
    if (skipped.length > 0) {
      out.push(`判定**不该合** ${skipped.length} 处 —— 这几条到此为止,自动的路不会再碰它们:`)
      for (const c of skipped) {
        out.push(`  · ${c.evidence.title ?? c.evidence.ref}:${c.why}`)
        out.push(`    不同意这个判断的话,自己来:git merge ${c.evidence.ref}(先看:git diff <集成分支> ${c.evidence.ref})`)
      }
    }
    if (superseded.length > 0) {
      out.push(`拿不准、而且这一版已经被后来的版本取代 ${superseded.length} 处 —— **连补录都不做**`
        + '(它「集成分支上没有」的文件,很可能正是后来那一版故意删掉的):')
      for (const c of superseded) {
        out.push(`  · ${c.evidence.title ?? c.evidence.ref}:${c.why}`)
        out.push(`    想自己看:git log ${c.evidence.ref} · git diff <集成分支> ${c.evidence.ref}`)
      }
    }
  }
  for (const o of plan.orphanFiles) {
    const absent = o.files.filter(f => f.kind === 'absent').length
    out.push(`孤儿目录 ${o.path} 里有 ${o.files.length} 个文件不在集成分支上(${absent} 个是集成分支根本没有的):`)
    for (const f of o.files.slice(0, 5)) {
      out.push(`  · ${f.rel}(${f.kind === 'absent' ? '集成分支上没有' : '内容不同'})`)
    }
    /**
     * 它**不是** git 工作树,所以合不进来 —— 但「合不进来」不等于「捞不回来」。
     * `absent` 那些走加法补录(拷进临时工作树、`git add`、单独一笔提交),
     * `differs` 那些一个都不动。这两句话必须分开说:上一版只有一句「没法合并,请手工取用」,
     * 而那句话在补录落地之后就是假的。
     */
    if (absent > 0 && canBackfillOrphan) {
      out.push(`  这 ${absent} 个集成分支根本没有的会被**补录**进集成分支(单独一笔提交);目录本身不会被删。`)
    } else if (absent > 0) {
      out.push('  ⚠ 这一趟没有拷贝接缝,这几个文件**不会**被补录 —— 请自行确认后手工取用(目录不会被删)。')
    }
    if (o.files.length - absent > 0) {
      out.push(`  ⚠ 另外 ${o.files.length - absent} 个和集成分支内容不同的**一个都不会动** —— 那一格只能你自己判。`)
    }
  }
  for (const p of plan.problems) out.push(`⚠ ${p}`)
  return out
}
