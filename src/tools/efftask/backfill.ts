import { stageAt } from './integrationMerge.js'

/**
 * **加法补录 —— 「捞」的第 2 级。**
 *
 * 用户原话:「必须尽最大努力去捞。」
 *
 * 第 1 级是整条 `git merge`(分诊判「合」的那些,见 `rescue.ts`)。它失手之后今天就到此为止,
 * 而「拿不准」那一整格从来没有被试过 —— 那不是最大努力,那是一次判决。
 *
 * 这一级只做一件严格更弱的事:**只取「这条 ref 上有、而集成分支上根本没有」的路径**,
 * 落成集成分支上**单独一笔**提交。它不是合并 —— 那条 ref 不会被记成已合入(我们只取了它的
 * 一部分,历史上必须仍然看得出它没合完),而且这一笔随时可以 `git revert`。
 *
 * ## 「覆盖不了任何东西」必须由 git 强制,而不是由提交消息声明
 *
 * 方案第一版把这句话当成了自明之理。圆桌的数据安全席在玩具仓库上把它**逐条证伪**,
 * 下面每一条判据后面都跟着一次真实复现:
 *
 *  1. **空集合直接跳过。** `git checkout <ref> --`(pathspec 为空)不是空操作,是**切分支**:
 *     scratch 的 HEAD 落到那条 ref 上 → 后面那句 `merge --ff-only HEAD` 把**整条废稿**
 *     快进进集成分支;而且下一趟 `stageAt` 的 `reset --hard` 会把那条抢救分支挪到集成分支 tip,
 *     那一版产出唯一的落脚点当场变成悬垂对象。**这是这个文件里最危险的一格。**
 *  2. **pathspec 一律 `:(literal)`。** `checkout -- <path>` 的 path 是通配符:
 *     一条叫 `pages/[id].tsx` 的路径会把 `pages/d.tsx` 一起覆盖掉(实测 `M pages/d.tsx`),
 *     而判据刚刚才说过那个文件「不收」。
 *  3. **祖先前缀不许是 blob,而且提交前用 git 复核。** 集成分支上 `foo` 是文件、ref 上
 *     `foo/` 是目录时,补录 `foo/bar.txt` 会让 git **删掉** `foo`(实测 `D foo / A foo/bar.txt`)。
 *     最后那道 `--diff-filter=DMR` 断言才是把「没有覆盖任何东西」从一句话变成**会失败的判据**
 *     的东西。
 *  4. **集成分支删过的路径不收。** 删除本身也是成果;把它复活和覆盖一个文件是同一类事故。
 *  5. **候选清单用两点 diff(tip 口径)。** `A...B` 是 merge-base 口径,和判据不是同一把尺:
 *     同一件事,ref 恰好碰过那个文件就复活、没碰过就漏掉 —— 结果由一件和意图无关的偶然决定。
 *  6. **`-z` 切,不靠 `core.quotepath`。** 后者去不掉 `"` / `\` / tab 的 C 引号,那几条会静默漏捞。
 *  7. **存在性用 `rev-parse --verify`,不用 `cat-file -e`。** 后者对 gitlink 返回 128,
 *     于是「集成分支上没有」被误判成真,一个普通文件会顶掉集成分支上的 submodule 入口。
 *  8. **ff 不成立要重试,而且重算候选。** 只重做 ff 不重算判据,会把 fail-closed 变成真覆盖。
 *
 * ## 字节保真:唯一确认安全的那一条
 *
 * `git checkout <tree-ish> -- <path>` 把 ref 上的 blob **原样**装进 index(不重跑 clean filter),
 * `commit`(**没有 `-a`**)提交的就是 index。所以补录进集成分支的字节和 ref 上逐字相同,
 * 哪怕两边的 `.gitattributes` / CRLF 设置不一样。**前提是不许 `commit -a`、不许在 checkout
 * 之后 `git add`** —— 这两条在下面是硬约束,不是风格。
 *
 * 孤儿目录那条路(`backfillFromDir`)**没有**这个保证:它是从工作区文件正常入库,
 * clean filter 该跑也会跑。那是对的(那些文件本来就在工作区形态),但两条路的差别要说出来。
 */

export interface BackfillGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface BackfillDeps {
  git: BackfillGit
  gitRoot: string
  integrationBranch: string
  integrationPath: string
  /** 补录发生在 `<worktreeRoot>/merge-scratch` —— 和 `mergeIntoIntegration` 同一棵树。 */
  worktreeRoot: string
  withIntegrationLock: <T>(fn: () => Promise<T>) => Promise<T>
  onProgress?: (line: string) => void
  signal?: AbortSignal
}

/** 一条候选路径为什么没被收 —— **必须带出去**:最大努力的另一半是说清哪几条没捞到。 */
export interface BackfillSkip {
  path: string
  why: string
}

export interface BackfillResult {
  ok: boolean
  /** 真的补进集成分支的路径。 */
  added: string[]
  /** 看过、而按判据不收的。 */
  skipped: BackfillSkip[]
  /** 补录那一笔提交的 sha(有东西补进去时才有)。 */
  commit?: string
  why?: string
}

/** 一次最多往 argv 上放几条 pathspec —— 再多要分批(单条路径可能很长)。 */
const PATHSPEC_BATCH = 100
/** ff 撞上「集成分支这期间前进了」时重试几次。和 `mergeIntoIntegration` 同一个数。 */
const FF_ATTEMPTS = 3

/** 一条 pathspec,关掉通配符。见文件头第 2 条。 */
const literal = (p: string): string => `:(literal)${p}`

const splitZ = (s: string): string[] => s.split('\0').map(x => x.trim()).filter(Boolean)

/** 这个树对象上有没有这条路径。**gitlink 也算有** —— `cat-file -e` 在那一格是错的。 */
async function existsAt(deps: BackfillDeps, tree: string, path: string): Promise<boolean> {
  const r = await deps.git(['rev-parse', '--verify', '-q', `${tree}:${path}`], deps.gitRoot)
  return r.code === 0
}

/** `100644` / `120000` / `160000` / `040000`;读不出来回空串。 */
async function modeAt(deps: BackfillDeps, tree: string, path: string): Promise<string> {
  const r = await deps.git(['ls-tree', tree, '--', literal(path)], deps.gitRoot)
  if (r.code !== 0) return ''
  const first = r.stdout.split('\n')[0] ?? ''
  return first.split(' ')[0] ?? ''
}

/**
 * 这条符号链接会不会指到仓库外面去。
 *
 * git 自己对这种链接是安全的(实测:`clean -fd` 不顺着它删、`update-index` 拒绝把它当目录),
 * 但补录进集成分支之后它会随着第 2 跳进**用户自己的检出**,而之后任何非 git 的工具
 * (构建脚本的 `rm -rf`、`cp -r`、打包器的 glob)顺着它走就写到仓库外了。
 * 「捞回一份数据」不该顺带在用户仓库里开一个出口。
 */
function escapes(from: string, target: string): boolean {
  if (target.startsWith('/')) return true
  const parts = `${from}/..`.split('/').filter(p => p.length > 0 && p !== '.')
  const stack: string[] = []
  for (const p of parts) {
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  for (const p of target.split('/')) {
    if (p.length === 0 || p === '.') continue
    if (p === '..') {
      if (stack.length === 0) return true
      stack.pop()
    } else stack.push(p)
  }
  return false
}

/**
 * 这条 ref 上有、而集成分支 tip 上**根本没有**的路径。
 *
 * 判据的每一条都在文件头有对应的复现。返回 `skipped` 是刻意的:被判据挡下来的那些正是
 * 「捞不回来」的明细,它们要一路走到屏幕和 `rescueStranded` 上,而不是消失。
 */
export async function candidatePaths(
  deps: BackfillDeps, ref: string, tip: string,
): Promise<{ take: string[]; skipped: BackfillSkip[]; problems: string[] }> {
  const problems: string[] = []
  const skipped: BackfillSkip[] = []
  // **两点**,tip 口径 —— 三点是 merge-base 口径,和下面的判据不是同一把尺(文件头第 5 条)。
  const diff = await deps.git(['diff', '--name-only', '-z', tip, ref], deps.gitRoot)
  if (diff.code !== 0) {
    return { take: [], skipped, problems: [`${ref}:列不出它和集成分支的差异(${diff.stderr.trim() || `退出码 ${diff.code}`})`] }
  }
  const take: string[] = []
  for (const path of splitZ(diff.stdout)) {
    if (deps.signal?.aborted) break
    // ref 上没有 = 这是一次**删除**,不是新增。删除永远不补录。
    if (!(await existsAt(deps, ref, path))) continue
    if (await existsAt(deps, tip, path)) continue

    // 集成分支**删过**它 —— 删除本身是成果,复活它和覆盖一个文件是同一类事故(第 4 条)。
    const hist = await deps.git(['rev-list', '-1', tip, '--', literal(path)], deps.gitRoot)
    if (hist.code === 0 && hist.stdout.trim().length > 0) {
      skipped.push({ path, why: '集成分支上曾经有、后来被删掉了 —— 补录回去等于撤销那次删除' })
      continue
    }

    // 祖先前缀在 tip 上是文件 → 补录会把那个文件删掉(第 3 条,实测 `D foo`)。
    const segs = path.split('/')
    let dfConflict = ''
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/')
      const t = await deps.git(['cat-file', '-t', `${tip}:${prefix}`], deps.gitRoot)
      if (t.code === 0 && t.stdout.trim() === 'blob') { dfConflict = prefix; break }
    }
    if (dfConflict.length > 0) {
      skipped.push({ path, why: `集成分支上 ${dfConflict} 是个文件,补录它下面的路径会把那个文件删掉` })
      continue
    }

    const mode = await modeAt(deps, ref, path)
    if (mode === '160000') {
      skipped.push({ path, why: '这是一个 submodule 入口,补录它而不带 .gitmodules 只会造出一个空洞' })
      continue
    }
    if (mode === '120000') {
      const blob = await deps.git(['cat-file', 'blob', `${ref}:${path}`], deps.gitRoot)
      const target = blob.code === 0 ? blob.stdout.trim() : ''
      if (target.length === 0) {
        skipped.push({ path, why: '这是一个符号链接,而读不出它指向哪里' })
        continue
      }
      if (escapes(path, target)) {
        skipped.push({ path, why: `这是一个指向仓库外的符号链接(→ ${target})—— 补录它等于在你的检出里开一个出口` })
        continue
      }
    }
    take.push(path)
  }
  return { take, skipped, problems }
}

/**
 * 把候选路径提交进集成分支。**共用给 ref 和孤儿目录两条路。**
 *
 * `stage` 负责把内容放进 scratch 的暂存区,它是两条路唯一不同的一步。
 */
async function commitAndFf(
  deps: BackfillDeps, scratch: string, tip: string, message: string,
  stage: () => Promise<{ ok: true } | { ok: false; why: string }>,
): Promise<{ ok: true; commit?: string } | { ok: false; why: string }> {
  const staged = await stage()
  if (!staged.ok) {
    await deps.git(['reset', '--hard', tip], scratch)
    await deps.git(['clean', '-fd'], scratch)
    return staged
  }
  /**
   * **最后一道,也是唯一由 git 强制的那道。**
   *
   * 上面每一条判据都可能有我没想到的绕法(D/F 只是被抓到的那一个)。这一句问的是
   * git 自己:相对 HEAD,这次暂存区里有没有**删除 / 修改 / 改名**。有 = 我们正在覆盖
   * 什么东西 = 整笔作废。没有这一句,「只补录集成分支缺失的文件,没有覆盖任何东西」
   * 就只是提交消息里的一句自述。
   */
  const dirty = await deps.git(['diff', '--cached', '--name-only', '-z', '--diff-filter=DMR'], scratch)
  if (dirty.code !== 0 || splitZ(dirty.stdout).length > 0) {
    const names = splitZ(dirty.stdout).slice(0, 5).join('、')
    await deps.git(['reset', '--hard', tip], scratch)
    await deps.git(['clean', '-fd'], scratch)
    return {
      ok: false,
      why: dirty.code !== 0
        ? `复核不了这次补录动了什么(${dirty.stderr.trim() || `退出码 ${dirty.code}`})—— 已还原,一个字节都没提交`
        : `这次补录会改到集成分支上已有的内容(${names})—— 已还原,一个字节都没提交`,
    }
  }
  const staged2 = await deps.git(['diff', '--cached', '--name-only', '-z'], scratch)
  if (splitZ(staged2.stdout).length === 0) return { ok: true }

  const commit = await deps.git(['commit', '--no-verify', '-m', message], scratch)
  if (commit.code !== 0) {
    await deps.git(['reset', '--hard', tip], scratch)
    await deps.git(['clean', '-fd'], scratch)
    return { ok: false, why: `补录提交没成(${commit.stderr.trim() || commit.stdout.trim()})` }
  }
  const head = await deps.git(['rev-parse', 'HEAD'], scratch)
  if (head.code !== 0) return { ok: false, why: `读不出补录提交(${head.stderr.trim()})` }
  const sha = head.stdout.trim()
  const ff = await deps.withIntegrationLock(() =>
    deps.git(['merge', '--ff-only', '--no-verify', sha], deps.integrationPath))
  if (ff.code !== 0) return { ok: false, why: `集成分支在这期间前进了,这一笔补录没能快进上去` }
  return { ok: true, commit: sha }
}

/**
 * 把一条 ref 上「集成分支根本没有」的文件补录进集成分支。
 *
 * `note` 是这一笔的来历,会写进提交消息 —— 它是日后有人问「这几个文件哪来的」时唯一的答案。
 */
export async function backfillFromRef(
  deps: BackfillDeps, ref: string, note: string,
): Promise<BackfillResult> {
  const scratch = `${deps.worktreeRoot}/merge-scratch`
  let lastSkipped: BackfillSkip[] = []
  const problems: string[] = []
  for (let attempt = 0; attempt < FF_ATTEMPTS; attempt++) {
    if (deps.signal?.aborted) return { ok: false, added: [], skipped: lastSkipped, why: '已中断' }
    const tipRes = await deps.withIntegrationLock(() =>
      deps.git(['rev-parse', deps.integrationBranch], deps.gitRoot))
    if (tipRes.code !== 0) {
      return { ok: false, added: [], skipped: lastSkipped, why: `读不出集成分支的 tip: ${tipRes.stderr.trim()}` }
    }
    const tip = tipRes.stdout.trim()
    /**
     * **每一趟都重算。** 只重做 ff 而不重算判据,会把「集成分支这期间刚补上了同一个文件」
     * 从 fail-closed 变成真覆盖。
     */
    const cand = await candidatePaths(deps, ref, tip)
    lastSkipped = cand.skipped
    problems.push(...cand.problems)
    /**
     * **空集合直接返回,连 checkout 都不许发。** 见文件头第 1 条:空 pathspec 的
     * `git checkout <ref> --` 是切分支,后果是整条废稿被快进进集成分支 + 抢救分支被销毁。
     */
    if (cand.take.length === 0) {
      return { ok: true, added: [], skipped: cand.skipped, ...(problems.length > 0 ? { why: problems.join(';') } : {}) }
    }

    const st = await stageAt(deps, scratch, tip)
    if (!st.ok) return { ok: false, added: [], skipped: cand.skipped, why: st.why }

    const res = await commitAndFf(deps, scratch, tip, `efftask: 补录 ${cand.take.length} 个集成分支缺失的文件\n\n${note}`, async () => {
      for (let i = 0; i < cand.take.length; i += PATHSPEC_BATCH) {
        const batch = cand.take.slice(i, i + PATHSPEC_BATCH)
        const co = await deps.git(['checkout', ref, '--', ...batch.map(literal)], scratch)
        if (co.code !== 0) return { ok: false, why: `取不出这一批文件(${co.stderr.trim() || `退出码 ${co.code}`})` }
      }
      return { ok: true }
    })
    if (res.ok) {
      deps.onProgress?.(`补录 ${cand.take.length} 个文件(${ref})`)
      return {
        ok: true, added: cand.take, skipped: cand.skipped,
        ...(res.commit ? { commit: res.commit } : {}),
      }
    }
    // 快进不成立 = 编排器在这期间合了别的东西。回第一步重算重来。
    if (res.why.includes('快进')) {
      deps.onProgress?.('集成分支在这期间前进了,重算补录清单后再试一次…')
      continue
    }
    return { ok: false, added: [], skipped: cand.skipped, why: res.why }
  }
  return { ok: false, added: [], skipped: lastSkipped, why: '集成分支反复前进,补录重试 3 次仍没能落上去' }
}

/** 把一个**不是 git 工作树**的孤儿目录里的文件拷进 scratch。见 `backfillFromDir`。 */
export type CopyInto = (from: string, to: string) => Promise<void>

/**
 * 把孤儿目录里「集成分支根本没有」的文件补录进集成分支。
 *
 * 四类今天谁都捞不到的东西里,这一格此前是**唯一 0% 捞回**的 —— 它不是 git 工作树,
 * 没有 HEAD、没有分支,`git merge` 无从谈起,于是从落地那天起屏幕上写的就是
 * 「请自行确认后手工取用」。而加法补录用得上:哪个文件集成分支上没有,`orphanDirFindings`
 * 已经逐文件比过了。
 *
 * 和 `backfillFromRef` 的**唯一**区别:内容来自工作区文件,所以走 `git add`,
 * clean filter 会跑。那是对的(它们本来就是工作区形态),但和 ref 那条路的字节保真
 * 不是同一回事,不要把两条路的注释抄来抄去。
 */
export async function backfillFromDir(
  deps: BackfillDeps, dir: string, rels: readonly string[], copyInto: CopyInto, note: string,
): Promise<BackfillResult> {
  const scratch = `${deps.worktreeRoot}/merge-scratch`
  if (rels.length === 0) return { ok: true, added: [], skipped: [] }
  for (let attempt = 0; attempt < FF_ATTEMPTS; attempt++) {
    if (deps.signal?.aborted) return { ok: false, added: [], skipped: [], why: '已中断' }
    const tipRes = await deps.withIntegrationLock(() =>
      deps.git(['rev-parse', deps.integrationBranch], deps.gitRoot))
    if (tipRes.code !== 0) {
      return { ok: false, added: [], skipped: [], why: `读不出集成分支的 tip: ${tipRes.stderr.trim()}` }
    }
    const tip = tipRes.stdout.trim()
    const take: string[] = []
    const skipped: BackfillSkip[] = []
    for (const rel of rels) {
      // 这期间集成分支可能已经有了同名路径 —— 那就不再是「加法」了。
      if (await existsAt(deps, tip, rel)) {
        skipped.push({ path: rel, why: '集成分支上现在已经有这个路径了' })
        continue
      }
      const segs = rel.split('/')
      let df = ''
      for (let i = 1; i < segs.length; i++) {
        const prefix = segs.slice(0, i).join('/')
        const t = await deps.git(['cat-file', '-t', `${tip}:${prefix}`], deps.gitRoot)
        if (t.code === 0 && t.stdout.trim() === 'blob') { df = prefix; break }
      }
      if (df.length > 0) {
        skipped.push({ path: rel, why: `集成分支上 ${df} 是个文件,补录它下面的路径会把那个文件删掉` })
        continue
      }
      take.push(rel)
    }
    if (take.length === 0) return { ok: true, added: [], skipped }

    const st = await stageAt(deps, scratch, tip)
    if (!st.ok) return { ok: false, added: [], skipped, why: st.why }

    const res = await commitAndFf(deps, scratch, tip, `efftask: 从孤儿工作树目录补录 ${take.length} 个文件\n\n${note}`, async () => {
      for (const rel of take) {
        try {
          await copyInto(`${dir}/${rel}`, `${scratch}/${rel}`)
        } catch (e) {
          return { ok: false, why: `拷不动 ${rel}(${e instanceof Error ? e.message : String(e)})` }
        }
      }
      for (let i = 0; i < take.length; i += PATHSPEC_BATCH) {
        const batch = take.slice(i, i + PATHSPEC_BATCH)
        const add = await deps.git(['add', '--', ...batch.map(literal)], scratch)
        if (add.code !== 0) return { ok: false, why: `入库失败(${add.stderr.trim() || `退出码 ${add.code}`})` }
      }
      return { ok: true }
    })
    if (res.ok) {
      deps.onProgress?.(`从 ${dir} 补录 ${take.length} 个文件`)
      return { ok: true, added: take, skipped, ...(res.commit ? { commit: res.commit } : {}) }
    }
    if (res.why.includes('快进')) continue
    return { ok: false, added: [], skipped, why: res.why }
  }
  return { ok: false, added: [], skipped: [], why: '集成分支反复前进,补录重试 3 次仍没能落上去' }
}
