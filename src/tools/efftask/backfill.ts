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
 *
 * ## 「尽最大努力」的第二半:一条坏的不许杀掉一整条 ref
 *
 * 上一版的 `stage` 回调是**全有或全无**:任何一条命令非零就整笔作废。于是同一条 ref 上
 * 一个补录不了的路径(一个符号链接、一个 D/F 冲突、一个 `.gitignore` 挡下的构建产物)
 * 会把旁边十个真正丢了的文件一起带走,而屏幕上报的理由里写着**受害者**的名字。
 *
 * 现在是 `stagePaths`:整批跑一次(快),非零就把这一批**拆成逐条**重跑,只有真的失败的
 * 那一条进 `skipped`,理由取 git 自己的原话。安全侧一个字没松 —— 最后那道
 * `--diff-filter=DMR`(基准 `tip`)照常跑。
 *
 * 另一件同样要两条路一视同仁的事是 **`.gitignore`**:`git add` 会自己挡下被忽略的路径,
 * 而 `git checkout <ref> -- <path>` **从来不看** `.gitignore`(它从树对象取内容,永远回 0)。
 * 不显式发这一问的话,同一件事在两条路上是相反的政策。见 `ignoredAt`。
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
  /** 收了、但要跟用户说一声的(目前只有一种:集成分支的 .gitignore 覆盖到了它)。 */
  notes?: string[]
  why?: string
}

/** 一次最多往 argv 上放几条 pathspec —— 再多要分批(单条路径可能很长)。 */
const PATHSPEC_BATCH = 100
/** ff 撞上「集成分支这期间前进了」时重试几次。和 `mergeIntoIntegration` 同一个数。 */
const FF_ATTEMPTS = 3

/** 一条 pathspec,关掉通配符。见文件头第 2 条。 */
const literal = (p: string): string => `:(literal)${p}`

/**
 * 按 NUL 切。**不许 `trim()`** —— 文件名首尾可以是空格,而 `-z` 存在的全部理由就是
 * 「不要在这里做任何按字符的猜测」。上一版顺手 trim 了一下,于是 ` lead.txt` / `trail.txt `
 * 既没被捞、也没进 skipped,验收席实测到的静默漏捞。
 */
const splitZ = (s: string): string[] => s.split('\0').filter(x => x.length > 0)

/**
 * 一条命令的第一行错误 —— 拿 **git 自己的原话**当理由。
 *
 * 「取不出这一批文件」这种我们编的句子里没有可操作的东西;git 那句
 * (`The following paths are ignored by one of your .gitignore files` / `did not match any file(s)`)
 * 才是用户能据以动手的。多行只取第一行:后面几行是 `hint:`。
 */
const firstLine = (r: { code: number; stdout: string; stderr: string }): string =>
  (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.trim() || `退出码 ${r.code}`

/**
 * **批量是优化,逐条是判据。**
 *
 * 上一版任何一条命令非零就整批作废,于是**一条**路径能杀掉同一条 ref 上所有无辜的文件,
 * 而报出去的理由里写的是受害者的名字、不是肇事者的。真 git 上两条路的失败形状还不一样:
 *
 *  · `git checkout <ref> -- <批>` 混一条 ref 上没有的路径 → 退出码 1,**一个文件都不落地**;
 *  · `git add -- <批>` 混一条被 `.gitignore` 挡下的 → 退出码 1,而**好的那条已经暂存了**
 *    (git 部分成功)。上一版接着 `reset --hard` + `clean -fd` 把它一起冲掉 ——
 *    这才是「孤儿目录里有一个构建产物就 0 捞回」的真成因,只分批不改回滚是修不掉的。
 *
 * 所以:先整批跑一次(快),非零就把**这一批**拆成逐条重跑,只有真的失败的那一条进
 * `skipped`。安全侧一个字没松 —— 最后那道 `--diff-filter=DMR`(基准 `tip`)照常跑,
 * 这里只决定**谁进得来**。
 */
async function stagePaths(
  take: readonly string[],
  run: (paths: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ staged: string[]; skipped: BackfillSkip[] }> {
  const staged: string[] = []
  const skipped: BackfillSkip[] = []
  for (let i = 0; i < take.length; i += PATHSPEC_BATCH) {
    const batch = take.slice(i, i + PATHSPEC_BATCH)
    const res = await run(batch)
    if (res.code === 0) { staged.push(...batch); continue }
    for (const p of batch) {
      const one = await run([p])
      if (one.code === 0) { staged.push(p); continue }
      skipped.push({ path: p, why: firstLine(one) })
    }
  }
  return { staged, skipped }
}

/**
 * 这些路径里,哪几条被**集成分支自己的** `.gitignore` 挡着。
 *
 * 在 `scratch` 里问,不在 `gitRoot` 里问:scratch 刚被 `stageAt` 对齐到 tip,那里的
 * `.gitignore` 就是集成分支这一刻的规则,而用户检出里那份可能完全不同。
 *
 * **为什么要挡**:`.gitignore` 是这个仓库说的「我不要这个」。把构建产物补录进集成分支
 * 不是捞回产出,是另一种污染 —— 而且它会随第 2 跳进用户的检出。挡下来的照样上屏,
 * 由用户自己判。
 *
 * 三条实测出来的用法约束(git 2.54):
 *  1. `check-ignore` **不认 pathspec magic**,`:(literal)` 直接 `fatal` —— 只能传裸路径。
 *     不要紧:它比的是**路径名**,`pages/[id].tsx` 不会被当成通配符(实测退出码 1)。
 *  2. **`-q` 只接单条**(`--quiet is only valid with a single pathname`),所以没法批量问。
 *  3. **必须带 `--no-index`**:重试那一趟路径已经进了 index,裸 `-q` 会回「不忽略」,
 *     于是第二趟给出一个和第一趟相反的理由。
 * 退出码:0 = 忽略,1 = 不忽略,其它 = 探不动(**不猜**,当作不忽略)。
 */
async function ignoredAt(
  deps: BackfillDeps, cwd: string, paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const p of paths) {
    if (deps.signal?.aborted) break
    const r = await deps.git(['check-ignore', '--no-index', '-q', '--', p], cwd)
    if (r.code === 0) out.set(p, '集成分支的 .gitignore 说这个仓库不要它(多半是构建产物)—— 没有补录')
  }
  return out
}

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
): Promise<{ ok: true; commit?: string; added?: string[] } | { ok: false; why: string; retryable?: boolean }> {
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
   * git 自己:相对**集成分支的 tip**,这次暂存区里有没有删除 / 修改 / 改名。
   *
   * **基准是 `tip`,不是 HEAD** —— 验收席在真 git 上把上一版(裸 `diff --cached`)证伪了:
   * `merge-scratch` 是**共享的**(第 1 级合并、`syncTrunk`、补录都用同一个目录),而这一段
   * 不在锁里。另一条流的 `stageAt` + `git merge` 落在我们两批 checkout 之间时,我们的补录
   * 提交长在**它的合并提交**上,ff 把整条废稿一起快进进集成分支 —— DMR 一次都没响,
   * 因为它比的是 index 和一个**已经被挪走的 HEAD**。实测:已经修好的文件被废稿盖掉,
   * 而且那一笔 revert 也退不掉(它只含补录的那些路径)。
   *
   * 换成 tip 之后,别人那次合并带进来的每一处改动都会显形成 M/D,当场作废;
   * 而上面那句 HEAD 复核把「index 被别人 reset 掉」也一起接住。
   */
  const headNow = await deps.git(['rev-parse', 'HEAD'], scratch)
  if (headNow.code !== 0 || headNow.stdout.trim() !== tip) {
    await deps.git(['reset', '--hard', tip], scratch)
    await deps.git(['clean', '-fd'], scratch)
    return { ok: false, why: '临时合并工作区在这期间被别的流程挪走了(它是共享的)—— 已还原,一个字节都没提交' }
  }
  const dirty = await deps.git(['diff', '--cached', '--name-only', '-z', '--diff-filter=DMR', tip], scratch)
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
  /**
   * **暂存区空了 ≠ 成功。**
   *
   * 候选非空却什么都没暂存,只有一种成因:别的流程把这棵共享的树收拾过一遍
   * (`stageAt` 的 `reset --hard` + `clean -fd`)。上一版在这里 `return { ok: true }`,
   * 于是屏幕逐字说「补录了 1 个集成分支缺失的文件(lost.ts)」而集成分支一个字节都没动 ——
   * 验收席实测到的**假成功**。`added` 是从候选清单抄的,不是量出来的,所以它不会自己露馅。
   */
  const staged2 = await deps.git(['diff', '--cached', '--name-only', '-z', tip], scratch)
  const stagedNames = splitZ(staged2.stdout)
  if (stagedNames.length === 0) {
    return { ok: false, why: '要补录的内容在提交前消失了(临时合并工作区被别的流程收拾过)—— 一个字节都没提交' }
  }

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
  if (ff.code !== 0) {
    /**
     * **失败原因由 git 说,不许写死。**
     *
     * 补录只加集成分支没有的路径,所以现实中最常见的失败根本不是「集成分支前进了」,
     * 而是**集成工作区里有同名未跟踪文件**(验收席就在那棵树里跑构建)。上一版把这句话
     * 写死,于是用户拿到一句假成因和零个下一步,而 git 的原话里就有可操作的那句。
     */
    const why = ff.stderr.trim() || ff.stdout.trim()
    const advanced = /fast-forward|non-fast|not possible/i.test(why)
    return {
      ok: false,
      why: advanced
        ? `集成分支在这期间前进了,这一笔补录没能快进上去(${why})`
        : `这一笔补录没能进集成分支:${why}`,
      retryable: advanced,
    }
  }
  /**
   * **「落到集成分支上了」由 git 证明,不由 `--ff-only` 的退出码证明。**
   *
   * 验收席实测:让快进落在别处(或者对一个已经是祖先的 sha),`--ff-only` 照样回 0 ——
   * 于是屏幕说「补录了 N 个文件」,集成分支上一个字节都没有。而孤儿目录那条第 3 级拿
   * `res.commit` 当基准去量差额,那一笔提交里必然含着我们暂存过的每一条 ——
   * **一次假成功把最后一次发现的机会也关掉了**。
   *
   * 184966f 刚给 `mergeIntoIntegration` 加过这道闸,理由逐字相同,而这边没有。
   */
  const landed = await deps.git(
    ['merge-base', '--is-ancestor', sha, deps.integrationBranch], deps.gitRoot,
  )
  if (landed.code !== 0) {
    return { ok: false, why: '快进报了成功,而这一笔补录并没有落到集成分支上 —— 一个字节都不算数' }
  }
  return { ok: true, commit: sha, added: stagedNames }
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

    /** 这一趟被逐条降级挡下来的 —— 和候选阶段的 `skipped` 合并后一起带出去。 */
    const staging: BackfillSkip[] = []
    /** 收了、但有话要说的(见下面 `.gitignore` 那一段)。 */
    const notes: string[] = []
    const res = await commitAndFf(deps, scratch, tip, `efftask: 补录 ${cand.take.length} 个集成分支缺失的文件\n\n${note}`, async () => {
      /**
       * **这条路上不问 `.gitignore` —— 上一版问了,而那是把工作区的规则套到已入库的内容上。**
       *
       * 验收席在真 git 上打穿了它:执行者用 `git add -f` **故意提交**的交付物
       * (`config.local.json`、被忽略目录下的产物)会被这一问丢掉,理由还写着「多半是
       * 构建产物」—— 一句猜测,而事实是他显式提交的。更糟的是它没有出口:丢掉 → 落痕 →
       * 按 `b` 重做 → 再产出同样的文件 → 再被同一条判据丢掉,一个没有出口的环。
       *
       * 判据回到 git 自己的语义:**`.gitignore` 按定义不管已跟踪的文件**。这些路径已经在
       * 一个 commit 里,`git merge` 会毫不犹豫地合进来,而第 2 级是「一次合并的加法子集」,
       * 不该比合并更严。孤儿目录那条路仍然问 —— 那边是**工作区文件**,`git add` 本来就挡,
       * 两条路的差别不是政策不一致,是 git 在这两种形态上的规则本来就不同。
       *
       * 收是收,但要**点名**:集成分支的 `.gitignore` 覆盖到它们,用户有权知道。
       */
      const covered = await ignoredAt(deps, scratch, cand.take)
      for (const path of covered.keys()) {
        notes.push(`${path}:集成分支的 .gitignore 覆盖了这条路径,但它在 ref 上是已跟踪的产出 —— 照样补录(git merge 也会带它进来)`)
      }
      const { staged, skipped } = await stagePaths(
        cand.take, batch => deps.git(['checkout', ref, '--', ...batch.map(literal)], scratch),
      )
      staging.push(...skipped)
      if (staged.length === 0) return { ok: false, why: `一个文件都没能取出来(${skipped[0]?.why ?? '原因不明'})` }
      return { ok: true }
    })
    if (res.ok) {
      // **报量出来的,不报打算做的。** `cand.take` 是候选清单,它不知道 git 最后收了什么。
      const added = res.added ?? cand.take
      deps.onProgress?.(`补录 ${added.length} 个文件(${ref})`)
      return {
        ok: true, added, skipped: [...cand.skipped, ...staging],
        ...(notes.length > 0 ? { notes } : {}),
        ...(res.commit ? { commit: res.commit } : {}),
      }
    }
    if (staging.length > 0) cand.skipped.push(...staging)
    // 只有「集成分支前进了」值得重来(而且要**重算候选**);别的原因重试只是重复同一次失败。
    if (res.retryable === true) {
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

    const staging: BackfillSkip[] = []
    const res = await commitAndFf(deps, scratch, tip, `efftask: 从孤儿工作树目录补录 ${take.length} 个文件\n\n${note}`, async () => {
      /**
       * **先问 `.gitignore`,再拷。** 顺序不是风格:拷过去再被 `git add` 拒掉的话,
       * 那份文件会永久留在**共享的** scratch 里(`clean -fd` 不带 `-x`,清不掉它),
       * 每一趟都多一份。这一轮的起因正是跑机磁盘被撑爆。
       */
      const ignored = await ignoredAt(deps, scratch, take)
      for (const [path, why] of ignored) staging.push({ path, why })
      const keep = take.filter(p => !ignored.has(p))
      if (keep.length === 0) return { ok: false, why: '这个目录里够得着的文件全被集成分支的 .gitignore 挡下了' }
      const copied: string[] = []
      for (const rel of keep) {
        try {
          await copyInto(`${dir}/${rel}`, `${scratch}/${rel}`)
          copied.push(rel)
        } catch (e) {
          // **一个拷不动不该杀掉其余的** —— 它自己进 skipped,别人照走。
          staging.push({ path: rel, why: `拷不动(${e instanceof Error ? e.message : String(e)})` })
        }
      }
      if (copied.length === 0) return { ok: false, why: `一个文件都没拷过去(${staging[0]?.why ?? '原因不明'})` }
      const { staged, skipped: addSkips } = await stagePaths(
        copied, batch => deps.git(['add', '--', ...batch.map(literal)], scratch),
      )
      staging.push(...addSkips)
      if (staged.length === 0) return { ok: false, why: `一个文件都没能入库(${addSkips[0]?.why ?? '原因不明'})` }
      return { ok: true }
    })
    if (res.ok) {
      const added = res.added ?? take
      deps.onProgress?.(`从 ${dir} 补录 ${added.length} 个文件`)
      return { ok: true, added, skipped: [...skipped, ...staging], ...(res.commit ? { commit: res.commit } : {}) }
    }
    if (res.retryable === true) continue
    return { ok: false, added: [], skipped: [...skipped, ...staging], why: res.why }
  }
  return { ok: false, added: [], skipped: [], why: '集成分支反复前进,补录重试 3 次仍没能落上去' }
}
