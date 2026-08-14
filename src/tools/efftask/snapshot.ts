/**
 * **抹掉之前先钉一个 ref。**
 *
 * 用户 2026-08-13:「必须尽最大努力去捞。」而这条路上最便宜的一次「捞」,是在东西**还在**
 * 的时候花两条 git 命令把它钉住 —— 而不是等它没了再去想办法。
 *
 * ## 谁会抹掉东西
 *
 * 这个功能里有好几处「先收拾干净再干活」,它们都是对的(共享的树必须对齐才能用),
 * 而它们抹掉的东西没有任何人先看一眼:
 *
 *  - `worktreePool` 合并失败之后对集成工作区的 `reset --hard` + `clean -fd` ——
 *    席位在那棵树里跑过构建、解过一半的冲突,`recordCleaned` 只留下**名字**,内容没了;
 *  - `stageAt` 每次进临时合并工作区都会 `reset --hard <tip>` + `clean -fd` ——
 *    而解冲突模型刚刚可能在那里写了几十分钟;
 *  - `backfill` 的每一条回滚路径。
 *
 * 分类表(`stranded.ts`)里 `integrationDirty` 那一格今天只在屏幕上被念一句,**没有任何
 * 一条路径会去救它**;临时合并工作区更彻底 —— 它连一格都没有。
 *
 * ## 为什么是 `git stash create`,以及它做不到什么(全部真 git 实测)
 *
 *  - **它不动工作区、也不动 index**:链接工作树、有未跟踪文件、index 里有已暂存内容、
 *    脏 submodule、`.gitignore` 的构建产物 —— 六种形状同时具备时,前后 `git status` 和
 *    `git ls-files -s` 逐字相同。这是它能被放在「别人正在用的树」上的全部理由。
 *  - **`-u` / `--include-untracked` 对 `create` 无效,而且是静默无效**:退出码 0、sha 也给,
 *    但只有 2 个 parent、没有 `^3`,未跟踪文件一个都没进去。所以未跟踪那一格**钉不住**,
 *    只能点名列出来 —— 说清楚比假装钉住了强。
 *  - **冲突态下它直接失败**(`Cannot save the current index state`,退出码 1)。而
 *    「留着一次没解完的合并」恰恰是最该保护的那一格,所以这条要如实报告,不能吞掉。
 *  - `git stash apply <ref 名>` 可以直接吃我们钉的这条 ref —— 所以钉的是 **stash 提交
 *    本身**,不重新包一层:重包之后它就不是 stash 形状,`apply` 会拒绝,而那是用户
 *    唯一顺手的恢复命令。
 *
 * ## ref 名按 **tree** 取,不按 commit
 *
 * 同一份内容连着 `stash create` 两次,commit sha **不同**(带 committer 时间戳)而 tree
 * 相同。按 commit 命名的话,用户按十次 `m` 就留下十条指着同一棵树的 ref,而没有任何
 * 东西回收它们 —— 那是「无限增长」,和这个仓库修过的「同名 ref 互相覆盖」正好是一对
 * 反面。按 tree 命名天然幂等:同样的内容,永远是同一条 ref。
 */

export interface SnapshotGit {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface SnapshotDeps {
  git: SnapshotGit
  /** ref 写在哪个仓库上。ref 是全仓共享的,所以从哪棵工作树写都一样。 */
  gitRoot: string
  /** 认得出是哪一趟钉的。**只用来起名字** —— 扫描那一侧不按 runId 过滤(见 `stranded.ts`)。 */
  runId: string
}

export interface SnapshotResult {
  /** 钉住了没有。**「没什么可钉」也算 ok** —— 它和「钉失败了」要用户做的事完全不同。 */
  ok: boolean
  /** 钉住的那条 ref。没东西可钉时没有。 */
  ref?: string
  /** 这份快照里有几条改动(`status --porcelain` 的行数),给屏幕用。 */
  changes?: number
  /**
   * **没能钉住的未跟踪文件。** `stash create` 拿不到它们,而 `clean -fd` 会删掉
   * 非忽略的那些 —— 这是这条路唯一的漏洞,必须点名,不许含糊成一句「已备份」。
   */
  untracked?: string[]
  why?: string
}

/** 未跟踪文件最多点名几个。清单要能读得完,而它后面那句「另有 N 个」在截断之外。 */
export const MAX_UNTRACKED_NAMED = 10

/** `refs/et/rescued/<runId>/<tree 前 12 位>`。 */
export const RESCUED_REF_PREFIX = 'refs/et/rescued'

/**
 * 把一棵工作树此刻的未提交内容钉成一条耐久 ref。**只读那棵树**,一个字节都不改。
 */
export async function pinSnapshot(deps: SnapshotDeps, cwd: string): Promise<SnapshotResult> {
  /**
   * `-uall` 是必须的:不带它,`status` 把一个未跟踪**目录**折成一行(`bigdir/`)。
   * 验收席实测:屏幕承诺「另有 1 个未跟踪文件没能钉住」,而 `clean -fd` 会删掉 500 个。
   */
  const st = await deps.git(['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], cwd)
  if (st.code !== 0) {
    return { ok: false, why: `看不出 ${cwd} 里有没有未提交的内容(${first(st)})` }
  }
  const lines = st.stdout.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0)
  if (lines.length === 0) return { ok: true }

  /**
   * **未跟踪的先数出来。** 它们不会进快照,而 `clean -fd` 会删掉非忽略的那些。
   * `status --porcelain` 不带 `--ignored`,所以这里数到的都是**真的会被删掉**的那些 ——
   * 被 `.gitignore` 忽略的构建产物 `clean -fd`(不带 `-x`)本来就不碰,点名它们是假警报。
   */
  const untracked = lines.filter(l => l.startsWith('??')).map(l => l.slice(3))

  const created = await deps.git(['stash', 'create', `efftask 抢救快照(${deps.runId})`], cwd)
  if (created.code !== 0) {
    /**
     * 最常见的成因是**冲突态**(`Cannot save the current index state`)—— 而那正是最该
     * 保护的一格。如实说,并给出唯一能让它重新可钉的那一步。
     */
    return {
      ok: false,
      ...(untracked.length > 0 ? { untracked } : {}),
      changes: lines.length,
      why: `钉不住 ${cwd} 里的内容(${first(created)})`,
    }
  }
  const sha = created.stdout.trim()
  /**
   * **空 sha ≠ 「没什么可钉」。**
   *
   * 上面那句 `status` 已经数出 `lines.length` 处改动了。到这里 `stash create` 却什么都没给,
   * 只有一种成因:**别的流程在这两句之间把那棵树收拾了**(集成工作区是共享的,而这一段
   * 不在锁里)。验收席在真 git 上复现:`ok: true`、`ref` 为空、`snapshotLines` **一行都不输出** ——
   * 用户一整天的未提交内容没了,屏幕上一个字都没有。
   *
   * 只有 `lines` 里全是未跟踪文件时,空 sha 才是正常的(`stash create` 本来就拿不到它们)。
   */
  if (sha.length === 0) {
    const tracked = lines.length - untracked.length
    return {
      ok: tracked === 0, changes: lines.length,
      ...(untracked.length > 0 ? { untracked } : {}),
      ...(tracked === 0 ? {} : { why: `看见了 ${tracked} 处已跟踪的改动,而一处都没能钉住(这棵树是共享的,可能正被别的流程收拾)` }),
    }
  }

  const tree = await deps.git(['rev-parse', `${sha}^{tree}`], deps.gitRoot)
  if (tree.code !== 0) return { ok: false, changes: lines.length, why: `读不出快照的 tree(${first(tree)})` }
  const base = `${RESCUED_REF_PREFIX}/${deps.runId}/${tree.stdout.trim().slice(0, 12)}`
  /**
   * **只创建,不覆盖。**
   *
   * ref 名只编码 tree,不编码基准。验收席实测:两棵不同基准的树上有同一份内容时,
   * 第二次 `update-ref` 会把第一条**直接抹掉**,那份快照落到零个 ref 上等 gc ——
   * 而这个函数是作为**通用原语**导出的,下一个调用者会直接踩进去。
   * 空的 `<oldvalue>` 就是 git 的「必须不存在」。已经存在且指的就是同一个 sha = 幂等,收工。
   */
  let ref = base
  for (let i = 0; i < 5; i++) {
    const created = await deps.git(['update-ref', ref, sha, ''], deps.gitRoot)
    if (created.code === 0) break
    const cur = await deps.git(['rev-parse', '--verify', '-q', ref], deps.gitRoot)
    if (cur.code === 0 && cur.stdout.trim() === sha) break
    if (i === 4) return { ok: false, changes: lines.length, why: `钉不住那条 ref(${first(created)})` }
    ref = `${base}-${i + 2}`
  }
  return {
    ok: true, ref, changes: lines.length,
    ...(untracked.length > 0 ? { untracked } : {}),
  }
}

const first = (r: { code: number; stdout: string; stderr: string }): string =>
  (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.trim() || `退出码 ${r.code}`

/**
 * 一次快照该怎么上屏。**是数据,不是 JSX。**
 *
 * 三件事必须**分开说**,因为它们要用户做的事完全不同:钉住了 / 没钉住 / 钉不了。
 */
export function snapshotLines(where: string, res: SnapshotResult): string[] {
  const out: string[] = []
  if (res.ok && res.ref === undefined && res.changes === undefined) return out
  if (res.ref !== undefined) {
    out.push(`${where} 里有 ${res.changes} 处未提交的内容,已经钉成 ${res.ref}`
      + `(下一次合并失败时的 reset --hard / clean -fd 拿不走它了)`)
    out.push(`  想取回来:git stash apply ${res.ref}(先看:git show --stat ${res.ref})`)
  } else if (!res.ok) {
    out.push(`⚠ ${where} 里的未提交内容**没能钉住**:${res.why}`)
    out.push('  最常见的成因是那里留着一次没解完的合并 —— 先把它处理完(git merge --abort 或解完提交),再按一次 m')
  }
  if (res.untracked && res.untracked.length > 0) {
    const named = res.untracked.slice(0, MAX_UNTRACKED_NAMED)
    /**
     * **截断提示要在被截断的那一段外面。** 而且这一句本身就是这条路的漏洞公告:
     * `stash create` 拿不到未跟踪文件(`-u` 对它静默无效),所以这几个是真的没被钉住。
     */
    out.push(`⚠ ${where} 里另有 ${res.untracked.length} 个**未跟踪**文件没能钉住`
      + `(git stash create 拿不到它们),而下一次合并失败的 clean -fd 会删掉它们:`)
    out.push(`  ${named.join('、')}${res.untracked.length > named.length ? `,以及另外 ${res.untracked.length - named.length} 个(git status 看全部)` : ''}`)
  }
  return out
}
