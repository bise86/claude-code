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
}

export interface EscapeRegistry {
  /** 记一条。同一条路径重复点名只保留第一条的身份,但计数照增。 */
  note(claim: EscapeClaim): void
  /** 这条路径被席位点名过吗。`path` 可以是绝对路径,也可以是相对 gitRoot 的。 */
  owns(path: string): boolean
  /** 全部记录,给屏幕和 node.md 用。 */
  claims(): readonly EscapeClaim[]
  /** 点名过多少条不同的路径。 */
  size(): number
}

/**
 * 路径归一:去掉结尾斜杠、把 `//` 压平。
 *
 * **不做 realpath** —— 这个模块是纯的(没有 fs),而软链要在**调用方**解开:
 * 跑机上 `/home/esgyn/work/tools/qianbase-xtp` 是 `/home/esgyn/tb/tools/qianbase-xtp`
 * 的软链,两条路径 node.md 里各出现 1170 / 1396 次。调用方不解,这里就认不出是同一个。
 */
export function normalisePath(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
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
 */
export function escapedPathsIn(
  input: unknown,
  opts: { gitRoot: string; cwd?: string; roots?: readonly string[] },
): string[] {
  if (opts.cwd === undefined || opts.cwd.length === 0) return []
  const roots = [opts.gitRoot, ...(opts.roots ?? [])].filter(r => r.length > 0)
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (key !== 'file_path' && key !== 'notebook_path') return
      const p = normalisePath(v)
      if (!p.startsWith('/')) return
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
