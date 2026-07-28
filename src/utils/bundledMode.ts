/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * 官方 native 构建 —— 判据是「带着嵌入资源」。
 *
 * **这个函数不等于「我是不是单文件可执行程序」。** 两者被混用过一次,代价是
 * `ENOENT: posix_spawn '/$bunfs/root/vendor/ripgrep/x64-linux/rg'`:
 * `bun build --compile` 的产物如果没有嵌入任何**资源**(只有 JS),
 * `Bun.embeddedFiles` 就是**空数组**(实测 length=0),于是这里返回 false,
 * 所有消费点都退回「有脚本路径可用」的那条分支 —— 而在单文件产物里,
 * `import.meta.url` 和 `process.argv[1]` 都指向 bunfs 虚拟根,既 spawn 不了也读不到。
 *
 * 要问「我是不是单文件产物」用 {@link isSingleFileExecutable};
 * 要问「我能不能靠 re-exec 自己代替脚本路径」用 {@link isSelfContainedExecutable}。
 * 这个函数保留原语义,只服务于「官方构建里静态链接的那些东西在不在」——
 * 例如 ripgrep 的 argv0 分发、image-processor-napi。
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}

/**
 * bun 给单文件产物的虚拟根。
 *
 * POSIX 上是 `/$bunfs/root/…`,Windows 上是 `B:\~BUN\root\…`。两个都要认:
 * 只认 POSIX 那个的话,Windows 产物会静默走回「开发态」分支,而那条分支拿到的
 * 同样是一条不存在的路径 —— 和这次 Linux 上这个 bug 一模一样,只是换个平台才发现。
 */
const BUNFS_MARKERS = ['/$bunfs/', '\\~BUN\\', '/~BUN/'] as const

function looksLikeBunfs(p: unknown): boolean {
  return typeof p === 'string' && BUNFS_MARKERS.some(m => p.includes(m))
}

/**
 * 是不是 `bun build --compile` 出来的单文件可执行程序。
 *
 * 判据是模块路径落在 bunfs 虚拟根上,而不是 `Bun.embeddedFiles` —— 后者只说明
 * 「嵌了资源」,不说明「是单文件产物」(见 {@link isInBundledMode})。
 *
 * 实测(bun 1.3.14):
 * ```
 *   编译产物: Bun.main = /$bunfs/root/probe   argv[1] = /$bunfs/root/probe   embeddedFiles = 0
 *   开发态:   Bun.main = /tmp/probe.ts        argv[1] = /tmp/probe.ts
 * ```
 *
 * 三个信号都查,因为它们在不同 bun 版本/入口形态下不总是同时可用;任何一个命中即可。
 */
export function isSingleFileExecutable(): boolean {
  if (typeof Bun === 'undefined') return false
  const main = (Bun as unknown as { main?: unknown }).main
  return looksLikeBunfs(main) || looksLikeBunfs(process.argv[1]) || looksLikeBunfs(import.meta.url)
}

/**
 * 手上有没有一个「真实存在于磁盘、可以直接 spawn 的自己」,而**没有**可用的脚本路径。
 *
 * 官方 native 构建和 `--compile` 单文件产物都属于这一类:两者的
 * `process.execPath` 都是真路径,而 `process.argv[1]` 要么不存在、要么是 bunfs 虚拟路径。
 * 所有「起一个子进程跑我自己」的地方(teammate、bridge、computer-use、chrome)
 * 都该按这个判据分支,而不是按「有没有嵌入资源」。
 */
export function isSelfContainedExecutable(): boolean {
  return isInBundledMode() || isSingleFileExecutable()
}

/**
 * 「这份可执行文件是用户自己编出来的」。
 *
 * = 单文件产物 **且不是**官方 native 构建。用途见 getAutoUpdaterDisabledReason():
 * 自动更新会把它换成官方的 claude,所以必须能把两者分开。
 *
 * 做成可注入的纯函数不是为了好看:在测试进程里 `Bun.embeddedFiles` 恒为空数组,
 * 于是 `!isOfficial()` 这半个条件**在真实进程里永远杀不掉** —— 删掉它全套测试照绿,
 * 而后果是官方构建也被禁更。只有把两个信号做成参数,四个组合才测得到。
 */
export function isLocallyBuiltExecutable(
  deps: { isSingleFile: () => boolean; isOfficial: () => boolean } = {
    isSingleFile: isSingleFileExecutable,
    isOfficial: isInBundledMode,
  },
): boolean {
  return deps.isSingleFile() && !deps.isOfficial()
}

/**
 * 「要再启动一次自己,该执行哪个文件」。
 *
 * 十三个 `isSelfContainedExecutable()` 消费点里,有**四处逐字相同**:swarm 的
 * spawnUtils、spawnMultiAgent、以及 completionCache 的两处。四份拷贝、零测试 ——
 * 把任意一处改回旧判据,全套照绿(实测 9/9 存活)。
 *
 * 而且这四份不是全都一样:completionCache 那两份写的是 `process.argv[1] || 'claude'`,
 * 那个 `||` **永远短路不到** —— 单文件产物里 argv[1] 是 `/$bunfs/root/cli.js`,非空。
 * 于是「兜底成 claude」这个意图在最需要它的那一种形态下从来没生效过。四份拷贝里只有
 * 两份带这个兜底,本身就说明它们已经开始分叉了。
 *
 * 做成可注入的纯函数,两条分支才测得到:单文件产物里 `process.argv[1]` 指向 bunfs
 * 虚拟根,**读得到但 spawn 不了**;非单文件时它才是一条真路径。
 */
export function selfInvocationPath(
  fallback?: string,
  deps: { selfContained: () => boolean; execPath: () => string; argv1: () => string | undefined } = {
    selfContained: isSelfContainedExecutable,
    execPath: () => process.execPath,
    argv1: () => process.argv[1],
  },
): string {
  if (deps.selfContained()) return deps.execPath()
  const a = deps.argv1()
  // 空串也要走兜底 —— 这正是四份拷贝里那个 `||` 想做而做不到的事。
  return a !== undefined && a.length > 0 ? a : (fallback ?? '')
}
