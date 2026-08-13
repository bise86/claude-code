/**
 * 清掉一个工作区里的**构建产物** —— 被 `.gitignore` 忽略的那些。
 *
 * 三个调用者共用这一份:
 *  1. 一个任务合并提交、判 ACCEPTED 的那一刻(用户:「合并提交后……需要立马清理掉」);
 *  2. 详情页 `c` 键里那两桶**不能删目录**的节点(有未合入提交的、还没验收完的);
 *  3. 集成工作区(它永远不删,只能清里面的产物)。
 *
 * ## 为什么不是一句 `git clean -X -d -f`
 *
 * 那一句在真 git 上有**三个**会让屏幕说假话的行为,每一个都实测过:
 *
 * 一、**嵌套 git 仓库被静默跳过,而退出码仍然是 0。**
 *
 *     $ git clean -X -d -f
 *     Removing target/
 *     Skipping repository vendorbuild/subrepo
 *     $ echo $?
 *     0
 *
 *    按退出码判成功,屏幕就会说「已清掉 8.2 GB」而盘上一个字节没少 —— Rust/Go/node 的
 *    忽略目录里躺个 vendored checkout 是常事。**绝不能改用 `-f -f` 越过它**:那会连同
 *    那个仓库一起删掉,而它里面可能有没推走的提交。如实报出来,让人自己处置。
 *
 * 二、**`$GIT_COMMON_DIR/info/exclude` 对 linked worktree 生效**(实测 `git check-ignore -v`
 *    指到主仓库的 `.git/info/exclude`),而 `worktreePool.init()` 往里写了
 *    `.efftask-worktrees/` 和 `.claude/efftask/`。也就是说在**节点工作区内部**跑一句裸的
 *    `clean -X`,会把 `/et` 自己的记录一起清掉 —— 而执行者的 cwd 正是节点工作区。
 *
 *    `:(exclude)` pathspec **挡不住它**,实测两种形状行为不一致:
 *
 *        $ git clean -X -d -n -- . ':(exclude).claude' ':(exclude).efftask-worktrees'
 *        Would remove .efftask-worktrees/          ← 没挡住
 *        Would remove target/
 *
 *    (`.claude` 挡住了,因为它自己**不是**被忽略的目录、只有里面的内容是;
 *     `.efftask-worktrees/` 整个目录就是忽略项,pathspec 排除对它不生效。)
 *    所以判据不能交给 pathspec:**先 `-n` 枚举、在这里过滤、再按显式路径逐条删**。
 *
 * 三、**git 会把「父目录未被跟踪、而里面全是忽略项」的情况折叠成父目录。**
 *
 *     $ git clean -X -d -n            # .git/info/exclude 里写的是 .claude/efftask/
 *     Would remove .claude/           ← 报的是 .claude/,不是 .claude/efftask/
 *
 *    于是「以受保护路径为前缀」这条过滤会**漏掉它**。判据必须双向:一个条目落在受保护
 *    路径**里面**要排除,**是它的祖先**同样要排除(删 `.claude/` 就是删 `.claude/efftask/`)。
 *
 * ## 只清被忽略的,一个字节都不多
 *
 * `-X` 而不是 `-x`:未跟踪**但没被忽略**的文件可能是执行者刚生成、还没提交的交付物
 * (执行环节的产出在 `commitAndMerge` 之前一直是未提交的)。把它们一起删掉,正好删在
 * 「工作还没合走」的那两桶上。用户点名的 `.cargo-target-sql-restore` 就是这一类 ——
 * 它清不掉,而这件事要**说出来**,不是假装没有。
 *
 * ## 被忽略的目录是**整个**消失的
 *
 * 实测:`target/` 被忽略时,手工放在 `target/NOTES.md` 的东西随 `Removing target/` 一起没了,
 * 而 `clean -Xdn` 只报顶层条目。所以屏幕上不许写「未跟踪的文件一个字节都不碰」——
 * 要写「这类目录会被**整个**删掉,包括你手工放在里面的东西」。
 */

/** 一次 git 调用。注入以便测试,形状与 worktreePool 的 GitRunner 相同。 */
export interface BuildWipeGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface BuildWipeDeps {
  git: BuildWipeGit
  /**
   * 目录/文件占用(KB)。**拿不到就返回 undefined,不要编一个数** —— 这个功能对用户的
   * 全部意义就是「腾出多少」,一个猜出来的数字比没有数字糟得多。
   */
  dirSizeKb?: (path: string) => Promise<number | undefined>
}

/**
 * `/et` 自己写在工作区里的东西。**永远不清。**
 *
 * 和 `worktreePool.init()` 写进 `.git/info/exclude` 的那两条**必须是同一份** ——
 * 各写一份的话,哪天那边加了第三条,这边就会开始删它。
 */
export const EFFTASK_INTERNAL_PATHS: readonly string[] = ['.claude/efftask', '.efftask-worktrees']

/** 一条会被删掉的顶层条目。 */
export interface BuildWipeEntry {
  /** 相对工作区的路径,git 报什么就是什么(目录带尾斜杠)。 */
  rel: string
  /** 占用,KB。`undefined` = 量不到。 */
  kb?: number
}

export interface BuildWipePlan {
  path: string
  /** 会被删掉的。 */
  entries: BuildWipeEntry[]
  /**
   * 因为属于 `/et` 自己的记录而**刻意排除**的条目。
   *
   * 空着不报也能跑,但那就是一次静默的例外 —— 而这个仓库的规矩是盘上的处置都要说得出口。
   */
  excluded: string[]
  /** git 静默跳过的嵌套仓库。退出码是 0,不报出来屏幕就会说假话。 */
  skippedRepos: string[]
  totalKb: number
  /** 占用是不是**每一条**都量到了。有一条量不到就为 false。 */
  sizeKnown: boolean
  /** 探不动(不是 git 仓库、目录没了)。有值时 `entries` 必空。 */
  error?: string
}

export interface BuildWipeOutcome {
  /** git 说它真的删了的那些(`Removing …` 行),不是我们打算删的那些。 */
  removed: string[]
  skippedRepos: string[]
  excluded: string[]
  /**
   * 实测释放量:只累加**真的被删掉**的那几条在删除前量到的大小。
   *
   * 不拿 `plan.totalKb` 顶替 —— 计划里的条目完全可能因为嵌套仓库、权限而没删成,
   * 而那个数字已经在确认屏上承诺过了。
   */
  freedKb: number
  sizeKnown: boolean
  error?: string
}

/** 一个条目是不是 `/et` 自己的东西 —— **双向判**,见文件头第三条。 */
export function isInternalPath(rel: string): boolean {
  const e = rel.replace(/\/+$/, '')
  return EFFTASK_INTERNAL_PATHS.some(p => e === p || e.startsWith(`${p}/`) || p.startsWith(`${e}/`))
}

/**
 * `git clean` 的输出。`-n` 说 `Would remove` / `Would skip repository`,
 * `-f` 说 `Removing` / `Skipping repository` —— 两套措辞都要认(实测)。
 */
function parseCleanOutput(stdout: string): { entries: string[]; repos: string[] } {
  const entries: string[] = []
  const repos: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const repo = /^(?:Would skip repository|Skipping repository)\s+(.+)$/.exec(line)
    if (repo?.[1]) { repos.push(repo[1].trim()); continue }
    const rm = /^(?:Would remove|Removing)\s+(.+)$/.exec(line)
    if (rm?.[1]) entries.push(rm[1].trim())
  }
  return { entries, repos }
}

/**
 * 探一遍:这个工作区里有哪些构建产物,删掉能腾出多少。
 *
 * `core.quotepath=false`:否则中文/非 ASCII 路径在这里是 `"\344\270\255…"`,而这串东西
 * 会一路进确认屏给人看(worktreePool 为同一件事带过三次这个开关)。实测带上它之后,
 * 中文目录名和带空格的目录名都原样出来,而**按 argv 数组传回去删也照样命中**(不过 shell)。
 */
export async function scanBuildOutputs(deps: BuildWipeDeps, path: string): Promise<BuildWipePlan> {
  const dry = await deps.git(['-c', 'core.quotepath=false', 'clean', '-X', '-d', '-n'], path)
  if (dry.code !== 0) {
    return {
      path, entries: [], excluded: [], skippedRepos: [], totalKb: 0, sizeKnown: false,
      error: dry.stderr.trim() || dry.stdout.trim() || `git clean -n 退出码 ${dry.code}`,
    }
  }
  const { entries: all, repos } = parseCleanOutput(dry.stdout)
  const excluded = all.filter(isInternalPath)
  const wanted = all.filter(e => !isInternalPath(e))
  const entries: BuildWipeEntry[] = []
  let totalKb = 0
  let sizeKnown = true
  for (const rel of wanted) {
    const kb = await deps.dirSizeKb?.(`${path}/${rel.replace(/\/+$/, '')}`).catch(() => undefined)
    if (kb === undefined) sizeKnown = false
    else totalKb += kb
    entries.push({ rel, ...(kb === undefined ? {} : { kb }) })
  }
  return {
    path, entries, excluded, skippedRepos: repos, totalKb,
    // 一条都没有时 `sizeKnown` 报 true 会让屏幕印「共 0 KB」,而真实的意思是「没东西可清」。
    sizeKnown: sizeKnown && entries.length > 0,
  }
}

/**
 * 真的删。**只删 `scanBuildOutputs` 挑出来的那些**,一条都不多。
 *
 * 按显式 pathspec 删而不是再跑一次裸的 `clean -X -d -f`,理由见文件头第二条:
 * 裸的那一句会连 `/et` 自己的记录一起清掉,而 `:(exclude)` 挡不住整目录被忽略的那种。
 */
export async function wipeBuildOutputs(
  deps: BuildWipeDeps, plan: BuildWipePlan,
): Promise<BuildWipeOutcome> {
  const base = {
    removed: [] as string[], skippedRepos: plan.skippedRepos, excluded: plan.excluded,
    freedKb: 0, sizeKnown: false,
  }
  if (plan.error !== undefined) return { ...base, error: plan.error }
  if (plan.entries.length === 0) return { ...base, sizeKnown: true }
  const res = await deps.git(
    ['-c', 'core.quotepath=false', 'clean', '-X', '-d', '-f', '--', ...plan.entries.map(e => e.rel)],
    plan.path,
  )
  if (res.code !== 0) {
    return { ...base, error: res.stderr.trim() || res.stdout.trim() || `git clean 退出码 ${res.code}` }
  }
  const { entries: removed, repos } = parseCleanOutput(res.stdout)
  /**
   * 释放量按**真的删掉的那些**结算。git 报了 `Removing X` 才算 X 没了 ——
   * 计划里的条目完全可能撞上嵌套仓库或权限而原地不动,而 `plan.totalKb` 已经在
   * 确认屏上承诺过了,拿它顶替就是把一句承诺当成一次测量。
   */
  const bySlash = new Map(plan.entries.map(e => [e.rel.replace(/\/+$/, ''), e]))
  let freedKb = 0
  let sizeKnown = true
  for (const rel of removed) {
    const hit = bySlash.get(rel.replace(/\/+$/, ''))
    if (hit?.kb === undefined) sizeKnown = false
    else freedKb += hit.kb
  }
  return {
    removed,
    // 两次都要报:`-n` 那一遍和真删这一遍之间,盘上完全可能多出一个嵌套仓库。
    skippedRepos: [...new Set([...plan.skippedRepos, ...repos])],
    excluded: plan.excluded,
    freedKb,
    sizeKnown: sizeKnown && removed.length > 0,
  }
}

/** 扫 + 删一次做完。给不需要先摆给人看的调用者(合并完成那一刻)。 */
export async function wipeBuildOutputsAt(
  deps: BuildWipeDeps, path: string,
): Promise<BuildWipeOutcome> {
  return wipeBuildOutputs(deps, await scanBuildOutputs(deps, path))
}
