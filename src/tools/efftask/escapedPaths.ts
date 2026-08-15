// src/tools/efftask/escapedPaths.ts
//
// **一次工具调用要写的路径,落在主检出里还是落在这个席位自己的工作区里。**
//
// ## 这里曾经还有一个「归因登记簿」,已经删掉
//
// 那个登记簿记「哪条路径被哪个席位写过」,给 park-then-merge 判断「挡路的脏文件是不是
// 我们自己造的」。它在生产上**一次都没有生效过**:硬闸默认开 ⇒ 每次越界都被拒 ⇒
// 记录全是「拦下来的」⇒ `owns()` 结构性恒假 ⇒ park 整块是死代码(约 600 行含测试)。
//
// 病根是两个特性在争同一个证据源:**闸只看得见「我们没让它写成」的那些**,
// 而 park 要的是「已经落了盘并挡住合并」的那些。闸拦得越干净,归因这条路越空。
//
// 替代它的是一条**不需要知道是谁写的**判据(`worktreePool.losslessAt`):
// 工作区里这条路径的内容/模式,和这次合并将要写入的一模一样 ⇒ 丢弃它可证明无损。
// 那条判据严格更强 —— 不依赖任何证据源,而且对用户自己的改动也安全。
//
// 「被拒了一次」这件事仍然要上屏,走 `onEscapeBlocked`,不再经过登记簿
// (登记簿的 `claims()` 全仓零消费者,席位撞闸 40 次没有任何人知道)。
//
// ## 病灶
//
// 隔离靠 cwd,而**绝对路径绕开 cwd**。跑机 .30 run 001 实测:席位照提示词里的绝对路径
// 写了主检出(node.md 里 2566 处,是根方案那次渲染教的),写进去的内容不在任何任务分支上,
// `add -A` 够不着 —— 于是回主干那一跳被 git 拒绝,而集成分支照常前进,静默七小时。
//
// ## 覆盖面(说清楚,不假装)
//
// 只认 Edit/Write/MultiEdit/NotebookEdit 的 `file_path` / `notebook_path`。
// **Bash 与 MCP 看不见** —— 从命令行推断「改了哪个文件」不可靠。那一类靠
// `worktreePool.losslessAt`(内容可证明无损就清掉)兜一部分,兜不住的退回
// 「拒绝合并、如实报告、一个字节不碰」。

/**
 * 路径归一:压平 `//`、消掉 `.` 与 `..` 段、去掉结尾斜杠。
 *
 * `.` / `..` 必须消:`/repo/./pkg/a.rs` 和 `/repo/pkg/a.rs` 是同一个文件,而登记簿是
 * 按字符串做键的 —— 不消的话 `owns()` 查 `${gitRoot}/${p}` 永远对不上那条 `.` 形态的键,
 * 记了等于没记(对抗席实测)。`NotebookEdit` 尤其要紧:Edit/Write 在 `canUseTool` 之前
 * 有 `backfillObservableInput` → `expandPath` 帮忙 `normalize` 过,notebook 那条**没有**。
 *
 * **不做 realpath** —— 这个模块是纯的(没有 fs)。软链由调用方通过 `opts.realpath`
 * 注进来,见 `escapedPathsIn`。
 */
export function normalisePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // 相对路径要留住开头的 `..`(它没有可弹的父段);绝对路径在根上再往上就是根。
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/**
 * 一条路径在不在某个根目录**下面**。
 *
 * 用**路径段**比,不用 `startsWith`:后者会把 `/repo-backup/x` 判成在 `/repo` 下面。
 * 这个仓库为同一类前缀误判付过账(`buildOutputs` 的 proven 归属那条,变异测试抓出来的)。
 */
export function under(root: string, p: string): boolean {
  const r = normalisePath(root)
  const q = normalisePath(p)
  return q === r || q.startsWith(`${r}/`)
}


/**
 * 从一次工具调用的输入里,摘出**落在主检出、而不在这个席位工作区里**的路径。
 *
 * 判据三步,顺序有讲究:
 *  1. 席位没有自己的工作区(`cwd` 缺席)→ **一条都不算**。共享工作树档下席位本来就在
 *     主检出干活;不早退的话每次调用都误报(接缝席点名的那条)。
 *  2. 路径要在 `gitRoot` 下面 —— 否则它写的是 `/tmp` 或源码目录,不关这件事。
 *  3. 路径**不在** `cwd` 下面 —— 在里面就是正常干活。
 *
 * 只认 `file_path`(Edit/Write/MultiEdit/NotebookEdit)。Bash 的 `command` **故意不解析**:
 * 从命令行里推断"改了哪个文件"不可靠,而这个判据的下游要动用户的工作区 ——
 * 宁可归因不到(退回保守行为),不可归因错。这条覆盖面缺口要在屏幕上说出来。
 *
 * ## 软链走 `opts.realpath`,不走「别名根」
 *
 * 上一版是让调用方把别名根塞进 `roots`,而调用方填的是 `[getCwd()]` ——
 * `getCwd()` 和 `git rev-parse --show-toplevel` **都返回物理路径**
 * (前者在 bootstrap 里 `realpathSync` 过、`cd` 走 `pwd -P`;后者 git 自己解软链),
 * 所以那个别名根**恒等于 `gitRoot`,恒为空操作**。三席各自量到同一个结果。
 * 也就是说提交信息自己点名的那条事故路径(席位照 `/home/esgyn/work/tools/…` 写,
 * node.md 里 1170 次)**一次都没被覆盖过**。
 *
 * 正解是解**被写的那条路径**,而不是去枚举「有哪些软链指向仓库」—— 后者根本枚举不完。
 * `realpath` 由调用方注入(这个模块保持无 fs);文件还不存在时(Write 新建)沿着
 * 最近的**已存在祖先**解,再把剩下的段接回去。
 */
export function escapedPathsIn(
  input: unknown,
  opts: {
    gitRoot: string
    cwd?: string
    roots?: readonly string[]
    /** 解软链。拿不到就返回 undefined(那时退回按字面比,不能因此崩)。 */
    realpath?: (p: string) => string | undefined
  },
): string[] {
  if (opts.cwd === undefined || opts.cwd.length === 0) return []
  const roots = [opts.gitRoot, ...(opts.roots ?? [])].filter(r => r.length > 0)
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key !== 'file_path' && key !== 'notebook_path') return
      /**
       * **相对路径要按 `cwd` 解开,不能直接放行。**
       *
       * 上一版这里 `return`,理由写的是「相对路径天然在工作区里」—— 错的:`../../x`
       * 一样是相对路径。`Edit`/`Write` 侥幸没事,因为 `backfillObservableInput`
       * → `expandPath` 在 `canUseTool` **之前**已经把它们变成绝对路径了;
       * 而 `NotebookEdit` 是唯一**没有** `backfillObservableInput` 的写工具,
       * 它自己 `isAbsolute(p) ? p : resolve(getCwd(), p)` 且不 normalize ——
       * 于是 `../../analysis.ipynb` 从工作区落进主检出,零拦截零记录(对抗席实测)。
       */
      const lit = normalisePath(v.startsWith('/') ? v : `${opts.cwd as string}/${v}`)
      if (!lit.startsWith('/')) return
      // 解软链之后再判,而且**记的也是解开之后那条** —— 否则 `intoTrunk` 拿
      // `${gitRoot}/<git 报的相对路径>` 去查,永远对不上别名形态的键。
      const p = normalisePath(opts.realpath?.(lit) ?? lit)
      if (!roots.some(r => under(r, p))) return
      if (under(opts.cwd as string, p)) return
      if (seen.has(p)) return
      seen.add(p)
      out.push(p)
      return
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k)
    }
  }
  visit(input)
  return out
}

/**
 * **把方案文本里指向仓库内的绝对路径削成仓库根相对路径。**
 *
 * ## 为什么要在这里削
 *
 * 事故的病根不在闸,在**提示词自己教的**:根方案那一次渲染「工作目录:`<主检出绝对路径>`」
 * (根节点没有 worktree,所以那一格落到 `ctx.cwd`),模型把它写进 solution / acceptance,
 * 随后被 `子节点 goal 继承` 和 `执行提示词回灌整个 plan JSON` 复制到全树 ——
 * 跑机上 node.md 里 2566 处就是这么长出来的。
 *
 * 而**根方案作者那一席根本不在闸内**(它没有 `req.cwd`,`escapedPathsIn` 第一行就早退),
 * 所以它是唯一一个既在生产污染源、又不受拦截的席位。削要削在**它的输出**上。
 *
 * ## 削什么、不削什么
 *
 * - 只削**注册过的根**下面的路径(gitRoot 及调用方给的别名),用 `under()` 的段边界比,
 *   不用 `startsWith` —— 否则 `/repo-backup/x` 会被削成 `-backup/x`。
 * - **仓库外的绝对路径一个字不动**(`/etc/…`、参考仓库、日志目录)——
 *   那些可能是用户故意写的,而且相对化之后毫无意义。
 * - 只作用于**模型产出的字段**,不作用于整份提示词:用户原话里的绝对路径同理不能碰。
 *
 * ## 它替代不了硬闸
 *
 * 跑机上 `/home/esgyn/work/tools/…` 是物理路径的**软链别名**,在 node.md 里 1170 次,
 * 而 `gitRoot` 来自 `rev-parse --show-toplevel`(物理路径)—— 这一削对那 1170 处
 * **一处都不命中**,除非调用方把别名也传进 `roots`。所以这是**降触发率**,不是防线:
 * 提示词是建议,闸是强制。
 */
export function relativisePaths(text: string, roots: readonly string[]): string {
  const rs = roots.map(normalisePath).filter(r => r.length > 1)
  if (rs.length === 0 || text.length === 0) return text
  // 长的先削 —— 否则 `/a` 会先命中 `/a/b` 里的前缀,把它削成 `/b`
  const sorted = [...new Set(rs)].sort((x, y) => y.length - x.length)
  let out = text
  for (const r of sorted) {
    // 后面必须跟路径分隔符或词边界,`under()` 那条段边界规矩的字符串版
    out = out.split(`${r}/`).join('')
    // 光秃秃的根本身 → `.`(「在仓库根」),别削成空串让句子塌掉
    out = out.replace(new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`, 'g'), '.')
  }
  return out
}
