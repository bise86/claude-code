// src/tools/efftask/escapeRegistry.ts
//
// **哪些主检出里的路径,是被席位点名写过的。**
//
// 病灶:隔离靠 cwd,而**绝对路径绕开 cwd**。跑机 .30 run 001 实测:席位用提示词里写死的
// 绝对路径写了主检出(node.md 全文里指向主检出的绝对路径 2566 处,是方案自己教的),
// 于是回主干那一跳被 git 拒绝(`Your local changes … would be overwritten by merge`),
// 而集成分支照常前进 —— 第一次静默七小时,四小时后复发。
//
// ## 为什么要有这么一个登记簿,而不是「脏了就钉走」
//
// `intoTrunk` 分不清挡路的那个脏文件是**席位越界**还是**用户自己在改**。
// 一律钉走会把用户正在写的东西悄悄收进 stash —— 而「检测到脏就自动 stash」这一档
// 用户明确否决过(`stashGuard.ts` 文件头逐字写着「默认关,由用户按一下打开」)。
//
// 所以判据是**归因**:这条路径被某个席位点名写过 → 是工具自己造的烂摊子,收拾它天经地义;
// 没有被点名 → 那是用户的东西,维持原行为(拒绝合并、如实报告、一个字节不碰)。
//
// ## 为什么是「工具输入」而不是「前后拍指纹」
//
// 圆桌四席一致否掉了指纹方案,三条实测理由:
//  1. 20 路并发 `git status` 打在 gitRoot 上会抢 `index.lock` → merge 失败 38/40,
//     **检测手段自己复现了要修的那个故障**;
//  2. porcelain 是**电平**不是**边沿** —— 同一个文件被改第二次时前后文本相同,
//     实测「1 个席位越界 5 次 → 只被点名 1 次,而 14 个诚实席位被冤枉」;
//  3. `verifySnapshot` 自己的注释(pipeline.ts:2364-2374)明令禁止把它用在共享目录上。
//
// 工具输入是**边沿触发**的:越界 4 次记 4 条,而且天然带席位身份。
// 覆盖面要说清:Edit/Write/MultiEdit/NotebookEdit 看得见 `file_path`;
// **Bash 与 MCP 看不见** —— 那一类归因不到,按「不是席位干的」处理(保守方向:不动用户的东西)。

/** 一条越界记录。 */
export interface EscapeClaim {
  /** 哪个节点的席位。 */
  nodeId: string
  /** 哪一关。 */
  phase: string
  /** 被点名的绝对路径(已经过 realpath 归一)。 */
  path: string
  /** 哪个工具。 */
  tool: string
  /**
   * **这一次被硬闸拦下了 —— 一个字节都没写。**
   *
   * 这样的记录进 `claims()`(屏幕要说「席位试了 N 次」),但**不进 `owns()`**。
   *
   * 上一版没有这个区分,先 `note` 再 `deny`,于是:t0 席位 Edit 主检出的 `conn_executor.rs`
   * → 被拒、没写,但从此 `owns()` 为真;t1 用户自己在编辑器里改同一个文件(run 跑三小时,
   * 他当然在改);t2 `intoTrunk` 被这个文件挡住 → 全称判断通过 → **把用户的活 stash 走**。
   * 闸拦得越勤,伪造的归因证据越多 —— 两个特性之间的负交互,对抗席构造出来的。
   *
   * 判据回到它该有的样子:`owns()` 的语义是「**这个文件现在的脏,是我们造的**」,
   * 只有真落了盘的写才算数。
   */
  blocked?: boolean
}

export interface EscapeRegistry {
  /** 记一条。同一条路径重复点名只保留第一条的身份,但计数照增。 */
  note(claim: EscapeClaim): void
  /**
   * 这条路径**落盘的脏是席位造的**吗。`path` 可以是绝对路径,也可以是相对 gitRoot 的。
   *
   * 被硬闸拦下的尝试(`blocked`)一律为假 —— 见 `EscapeClaim.blocked`。
   */
  owns(path: string): boolean
  /** 全部记录(含被拦下的),给屏幕和 node.md 用。 */
  claims(): readonly EscapeClaim[]
  /** 有多少条不同的路径**真被写过**(不含被拦下的)。 */
  size(): number
}

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

export function createEscapeRegistry(): EscapeRegistry {
  const byPath = new Map<string, EscapeClaim>()
  const all: EscapeClaim[] = []
  return {
    note(claim) {
      const key = normalisePath(claim.path)
      all.push({ ...claim, path: key })
      // 被硬闸拦下的**不进索引** —— 没落盘的写不是「这个文件的脏是我们造的」的证据。
      if (claim.blocked === true) return
      if (!byPath.has(key)) byPath.set(key, { ...claim, path: key })
    },
    owns(path) {
      return byPath.has(normalisePath(path))
    },
    claims() { return all },
    size() { return byPath.size },
  }
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
