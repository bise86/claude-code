import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { PHASE_LABEL } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { uiStatus } from './stateMachine.js'

export interface FsLike {
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  mkdir(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
  exists(p: string): Promise<boolean>
  /**
   * Create `p` and report whether WE created it — false if it already existed.
   *
   * Must be atomic (a non-recursive mkdir is, on every real filesystem). This is what makes
   * a run id a reservation rather than a guess: two commands started before either wrote
   * anything would otherwise both scan an empty directory, both pick the same id, and the
   * second would overwrite the first's whole tree while both reported success.
   */
  mkdirExclusive(p: string): Promise<boolean>
  /**
   * Remove a file. REQUIRED, not optional: the only caller is the run lock's release path,
   * and `fs.unlink?.(…)` on an adapter that forgot to implement it resolves successfully
   * having done nothing — leaving the lock on disk and every other terminal refused, with
   * nothing in any log to explain it.
   */
  unlink(p: string): Promise<void>
  /** Remove an EMPTY directory. Used to release the lock directory; must not be recursive. */
  rmdir(p: string): Promise<void>
}

/**
 * Title → a safe single path segment. Strips anything that could escape the run
 * directory (`/`, `..`) by construction, since the result is used as a directory name.
 * Note: Windows device names (`con`, `aux`, …) survive; that is safe only because the
 * sole caller, childId, always prefixes `NN-`. Don't use slugify standalone for a path.
 */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-')
  // Array.from + slice on CODE POINTS: a plain .slice(0,40) can cut a surrogate pair in
  // half and produce a lone surrogate in a filesystem path. Trim separators AFTER
  // truncating — cutting at 40 can land right on one and leave a trailing dash.
  const cut = Array.from(s).slice(0, 40).join('').replace(/^-+|-+$/g, '')
  return cut || 'node'
}

/**
 * Child node id = parent id + `NN-slug`. The two-digit index only orders siblings
 * for human readability; the authoritative structure is each node's `childIds`, so a
 * parent with ≥100 children (impossible under DEFAULT_CAPS.maxNodes) would look
 * mis-sorted in a directory listing but still load correctly.
 * Uniqueness comes from the caller assigning distinct indices — same (index, title)
 * twice yields the same id, and writeNode would overwrite.
 */
export function childId(parentId: string, index: number, title: string): string {
  const nn = String(index).padStart(2, '0')
  return `${parentId}/${nn}-${slugify(title)}`
}

export async function allocateRunId(fs: FsLike, effRoot: string): Promise<string> {
  let max = 0
  // Read directly rather than gating on fs.exists(effRoot): mkdir() implementations
  // (real recursive mkdir, and the in-memory test fake) don't necessarily register an
  // entry for every ancestor path, so an exists() pre-check can false-negative even
  // when effRoot has numbered children.
  let names: string[] = []
  try {
    names = await fs.readdir(effRoot)
  } catch (e) {
    // A missing root is the normal first-run case → start at 001. But if the directory
    // IS there and merely unreadable, treating it as empty would hand out an id that
    // already exists and overwrite a previous run's tree — fail loudly instead.
    if (await fs.exists(effRoot)) throw e
    names = []
  }
  for (const name of names) {
    const m = name.match(/^(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  // RESERVE it, don't just compute it. Scanning alone is a guess: nothing is written until
  // the orchestrator starts, so a second /et launched in that window would scan the same
  // directory, pick the same id, and later overwrite the first run's tree — with both
  // commands reporting success at the same path. Creating the directory here is the
  // reservation, and mkdirExclusive tells us whether we won it.
  await fs.mkdir(effRoot)
  for (let n = max + 1; n <= max + 1000; n++) {
    const id = String(n).padStart(3, '0')
    if (await fs.mkdirExclusive(`${effRoot}/${id}`)) return id
  }
  throw new Error('efftask: 无法分配 run id(连续 1000 个都已被占用)')
}

/**
 * 评审/验收记录 (spec §7): "每一轮的**角色意见**与合成结果都追加进 reviewLog/acceptLog 并
 * 落盘到 node.md 的 ## 评审记录/## 验收记录".
 *
 * The per-role opinions were the half that never made it into the body — only the synthesized
 * verdict did. They survive in the frontmatter (serializeNode dumps the whole node), but the
 * body is the part a human reads, and "为什么没通过" is exactly the question they open this
 * file to answer.
 */
/** Per-line cap for model-authored body text. Frontmatter keeps the full value. */
const MAX_BODY_LINE = 400
const clipBody = (s: string): string => {
  const cps = Array.from(s)
  return cps.length > MAX_BODY_LINE ? `${cps.slice(0, MAX_BODY_LINE).join('')}…(完整内容见 frontmatter)` : s
}

function roundtableBody(log: TaskNode['reviewLog']): string {
  if (log.length === 0) return ''
  // DEFENSIVE on purpose, even though validateLoadedNodes now normalises these. This runs on
  // EVERY commit; a throw here blocks the node with a raw TypeError as its reason and repeats
  // on every resume. A body section is never worth a dead run.
  return log.map(r => {
    // 标出是哪一关:测试验证和验收共用 acceptLog、也共用 iteration.acceptance,于是这一节
    // 里会出现两条 `round 1`,而升级卡片写的正是「先看该节点的验收记录」。
    // 省略 step = 验收(老 node.md 的形状不变)。
    const step = r?.step && PHASE_LABEL[r.step] ? `[${PHASE_LABEL[r.step]}] ` : ''
    const head = `- ${step}round ${stripControl(String(r?.round ?? '?'))}: ${r?.synthesized?.pass ? 'PASS' : 'FAIL'} ${stripControl(r?.synthesized?.blockingSummary ?? '')}`
    const roles = (r?.verdicts ?? []).map(v => {
      const detail = (v?.blocking ?? []).length > 0 ? (v.blocking ?? []).join('; ') : (v?.comments ?? '')
      const mark = v?.infra ? 'CALL-FAILED' : v?.pass ? 'pass' : 'FAIL'
      return `  - [${stripControl(String(v?.role ?? 'unknown'))}] ${mark}${detail ? ': ' + clipBody(stripControl(detail)) : ''}`
    })
    return [head, ...roles].join('\n')
  }).join('\n')
}

/** 评分 with the REASONS. The number alone does not say why, and §4.2 lists rationale. */
function scoreBody(node: TaskNode): string {
  const line = (label: string, s?: { role: string; score: number; rationale: string }): string =>
    // `score` is stripped too: it comes straight off yamlParse and validateLoadedNodes only
    // checks that `score` is an object, so a hand-edited node.md can put ESC[2J in the NUMBER.
    s ? `${label}: ${stripControl(String(s.score))} [${stripControl(String(s.role))}]${s.rationale ? ' — ' + clipBody(stripControl(String(s.rationale))) : ''}` : `${label}: -`
  return [line('plan', node.score.plan), line('exec', node.score.exec)].join('\n')
}

// machine-state frontmatter fields (everything except derived human body)
export function serializeNode(node: TaskNode): string {
  const fm = { ...node }
  // Body fields are model-authored. YAML frontmatter escapes control bytes; a markdown body
  // does not, so an ESC or BEL in a title would make `cat node.md` clear the screen.
  const c = stripControl
  const body =
    `# ${c(node.title)}\n\n` +
    `## 完整方案\n${c(node.plan.solution)}\n\n` +
    `## 重点\n${c(node.plan.keyPoints)}\n\n` +
    `## 风险点\n${c(node.plan.risks)}\n\n` +
    `## 验收点\n${c(node.plan.acceptance)}\n\n` +
    `## 执行状态\n${c(node.execStatus)}\n\n` +
    (node.blockedReason ? `## 阻断原因\n${c(node.blockedReason)}\n\n` : '') +
    // 落选稿。只落进 frontmatter 而 body 不渲染的话,「不静默截断」只做到了机器可读那一半
    // —— body 才是人读的那一半。
    (node.plan.alternatives && node.plan.alternatives.length > 0
      ? `## 备选方案(圆桌落选稿)\n${node.plan.alternatives
          .map(alt => `### ${stripControl(alt.staff)}\n${clipBody(stripControl(alt.solution))}`).join('\n')}\n\n`
      : '') +
    `## 评审记录\n${roundtableBody(node.reviewLog)}\n\n` +
    `## 验收记录\n${roundtableBody(node.acceptLog)}\n\n` +
    `## 评分\n${scoreBody(node)}\n`
  return `---\n${yamlStringify(fm)}---\n\n${body}`
}

export function parseNodeFile(text: string): TaskNode {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error('efftask: node.md missing frontmatter')
  // MOSTLY-UNVALIDATED CAST: yamlParse returns `any`-shaped data straight off disk. The
  // resume path reads user-editable / possibly-stale files and must still validate the
  // rest (status is a legal NodeStatus, deps/childIds are string[]) before feeding the
  // state machine — a malformed status would silently deadlock or skip the dependency gate.
  const node = yamlParse(m[1]) as TaskNode
  // Counters are normalised HERE because they are the one field whose absence is actively
  // dangerous rather than merely wrong: a file written by an older build has no
  // `integration` counter, and `undefined + 1` is NaN, which never satisfies
  // `>= maxIterations` — turning a bounded retry loop into an unbounded one that keeps
  // issuing real model calls. Missing counters read as 0, not as "no limit".
  const it = (node.iteration ?? {}) as Partial<TaskNode['iteration']>
  node.iteration = {
    planReview: Number.isFinite(it.planReview) ? (it.planReview as number) : 0,
    acceptance: Number.isFinite(it.acceptance) ? (it.acceptance as number) : 0,
    integration: Number.isFinite(it.integration) ? (it.integration as number) : 0,
    scoring: Number.isFinite(it.scoring) ? (it.scoring as number) : 0,
    mergeResolve: Number.isFinite(it.mergeResolve) ? (it.mergeResolve as number) : 0,
  }
  return node
}

function nodeMdPath(runDir: string, nodeId: string): string {
  return `${runDir}/${nodeId}/node.md`
}

export async function writeNode(fs: FsLike, runDir: string, node: TaskNode): Promise<void> {
  await fs.mkdir(`${runDir}/${node.id}`)
  await fs.writeFile(nodeMdPath(runDir, node.id), serializeNode(node))
}

/**
 * 把一批节点从盘上抹掉 —— 父任务重做时删子树用。
 *
 * **不删干净等于没删。** loadRun 是照着目录树走的:留在盘上的 node.md 会在下一次
 * `--resume` 时原样复活,而内存里的树已经不认它了 —— 于是恢复出来一批父节点 childIds
 * 里根本没有的幽灵兄弟,validateLoadedNodes 那一关会因为 parentId 指向的节点还在而放行,
 * 然后 childrenAllAccepted 永远等不到它们。
 *
 * 顺序是**先深后浅**:id 就是相对路径(childId = `${parentId}/NN-slug`),所以按 '/'
 * 的个数倒序排一遍,子目录一定在父目录之前被清空。rmdir 是非递归的,顺序错了它就失败。
 *
 * 失败**返回而不是吞掉**。一个删不掉的 node.md 是会自己长回来的东西,用户必须看见。
 */
export async function removeNodeDirs(
  fs: FsLike, runDir: string, ids: readonly string[],
): Promise<{ failed: { id: string; message: string }[] }> {
  const failed: { id: string; message: string }[] = []
  const deepestFirst = [...ids].sort((x, y) => y.split('/').length - x.split('/').length)
  for (const id of deepestFirst) {
    /**
     * id 是从盘上读来的,而 node.md 按设计就是可手工编辑的 —— 所以它**不可信**。
     * `id: '../../victim'` 会让下面那行拼出 runDir 之外的路径,而这个函数是拿来删文件的。
     * 影响有界(只删得掉叫 node.md 的文件、只 rmdir 得掉空目录),但「有界」不是理由。
     */
    if (id.length === 0 || id.startsWith('/') || id.split('/').includes('..')) {
      failed.push({ id, message: '节点 id 越出了 run 目录,拒绝删除' })
      continue
    }
    const dir = `${runDir}/${id}`
    try {
      // node.md 可能本来就不在(节点还没落过盘),那不算失败 —— 目标是「盘上没有它」。
      if (await fs.exists(nodeMdPath(runDir, id))) await fs.unlink(nodeMdPath(runDir, id))
      // 目录留着是无害的(loadRun 只认 node.md),但留下一地空目录会让 run 目录难读。
      // 删不掉就算了 —— 里面可能还有别的东西,那更不该动。
      try { await fs.rmdir(dir) } catch { /* 非空或已不在,都无所谓 */ }
    } catch (e) {
      failed.push({ id, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { failed }
}

export async function readNode(fs: FsLike, runDir: string, nodeId: string): Promise<TaskNode> {
  return parseNodeFile(await fs.readFile(nodeMdPath(runDir, nodeId)))
}

/**
 * Recursively walk the run dir; every `node.md` becomes a TaskNode. The physical layout
 * mirrors node.id (runDir/<id>/node.md), so a DFS over subdirs recovers all nodes.
 *
 * A corrupt file never aborts the walk. This runs after a crash — a half-written
 * `node.md` is exactly what a crash leaves behind — so losing every successfully
 * recovered node because one sibling is truncated would defeat the purpose. Failures
 * are returned in `errors` for the caller to surface; they are not swallowed silently.
 */
export async function loadRun(
  fs: FsLike,
  runDir: string,
): Promise<{ nodes: TaskNode[]; errors: { path: string; message: string }[] }> {
  const nodes: TaskNode[] = []
  const errors: { path: string; message: string }[] = []
  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { return } // not a dir (e.g. a file) → skip
    for (const name of entries) {
      const path = `${dir}/${name}`
      if (name === 'node.md') {
        try {
          const node = parseNodeFile(await fs.readFile(path))
          // 路径即 id (spec §5): "node.md frontmatter 的 id 与其磁盘路径一致(路径即 id)".
          // Nothing checked it, so a hand-edited or mis-copied id silently detached the node
          // from its own directory — every later writeNode would then create a SECOND
          // directory and the original would be read back again on the next resume.
          const fromPath = dir.slice(runDir.length + 1)
          if (fromPath.length > 0 && node.id !== fromPath) {
            errors.push({ path, message: `frontmatter 的 id (${node.id}) 与所在目录 (${fromPath}) 不一致,已按目录为准` })
            node.id = fromPath
          }
          nodes.push(node)
        } catch (e) {
          errors.push({ path, message: e instanceof Error ? e.message : String(e) })
        }
      } else {
        await walk(path) // recurse into child node dirs; non-dirs (run.md) readdir-throw and skip
      }
    }
  }
  await walk(runDir)
  return { nodes, errors }
}

/**
 * Indented tree text for run.md. Walks parent→children from the roots rather than
 * trusting array order: loadRun's order comes from readdir, which no filesystem
 * guarantees, and printing a child before its parent renders a structurally wrong tree.
 * Orphans (parent missing/corrupt) are printed last so nothing is silently dropped.
 */
/**
 * Strip terminal control characters from model- and user-authored text before it is written
 * into a markdown body.
 *
 * YAML frontmatter escapes them; the body does not. A node title carrying `ESC[2J` or a BEL
 * makes `cat run.md` clear the screen and rewrite the terminal title — and titles, plans and
 * exec statuses are all model-authored.
 */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

export function renderTreeSnapshot(nodes: TaskNode[]): string {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const lines: string[] = []
  const emit = (n: TaskNode, depth: number): void => {
    if (seen.has(n.id)) return // defensive: a cyclic parent/child link must not hang the render
    seen.add(n.id)
    // Carry the blocked reason INTO the tree: run.md is the file the transcript points at,
    // and "[failed] 某任务 (BLOCKED)" with the reason only in a nested node.md leaves a
    // human unable to see why the run stopped without hunting through the directory.
    const why = n.status === 'BLOCKED' && n.blockedReason ? ` — ${stripControl(n.blockedReason)}` : ''
    lines.push(`${'  '.repeat(depth)}- [${uiStatus(n.status)}] ${stripControl(n.title)} (${n.status})${why}`)
    for (const cid of n.childIds) {
      const child = byId.get(cid)
      if (child) emit(child, depth + 1)
    }
  }
  /**
   * Roots and orphans are walked in ID order, not array order — spec §13 asks for
   * 「renderTreeSnapshot 输出稳定」 and array order does not provide it.
   *
   * `loadRun` builds its list from `readdir`, which guarantees no ordering, so the SAME tree
   * rendered on two resumes could emit its top-level rows in different sequences. Measured:
   * `[root, orphan]` and `[orphan, root]` produce two different files. run.md is rewritten on
   * every commit, so that turns into churn a reader cannot distinguish from real movement.
   *
   * CHILDREN keep `childIds` order, which is meaningful — it is creation order, and the `NN-`
   * prefix in every child id encodes it.
   */
  const byIdOrder = (a: TaskNode, b: TaskNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const n of [...nodes].sort(byIdOrder)) if (n.parentId === null) emit(n, 0)
  for (const n of [...nodes].sort(byIdOrder)) if (!seen.has(n.id)) emit(n, n.depth)
  return `# Efficient Task Run\n\n${lines.join('\n')}\n`
}

export async function writeRunManifest(
  fs: FsLike,
  runDir: string,
  cfg: EffTaskConfig,
  nodes: TaskNode[],
  // Final run outcome, written only on the last call so run.md records how the run ended.
  result?: { status: 'completed' | 'blocked'; reason?: string },
): Promise<void> {
  // run-level createdAt from the root node (fallback: first node) for a stable manifest timestamp.
  const createdAt = nodes.find(n => n.parentId === null)?.createdAt ?? nodes[0]?.createdAt ?? ''
  // Every field the resume path needs to rebuild an EffTaskConfig (§17.2) belongs here —
  // run.md IS the persisted config. `notices` and `mainModel` are part of that: a resumed
  // run re-opens the same confirmation gate, and without them it would show a roster with
  // no models and silently drop the record of what was refused the first time.
  const header = `---\n${yamlStringify({
    createdAt,
    parallelism: cfg.parallelism,
    phaseRoles: cfg.phaseRoles,
    caps: cfg.caps,
    goalPrompt: cfg.goalPrompt,
    notices: cfg.notices ?? [],
    ...(cfg.mainModel ? { mainModel: cfg.mainModel } : {}),
    // Written CONDITIONALLY so a plain new run's frontmatter stays byte-identical to what
    // P1 produced — resume must not change what a non-resumed run looks like on disk.
    ...(cfg.resumeGuidance ? { resumeGuidance: cfg.resumeGuidance } : {}),
    ...(cfg.resumes && cfg.resumes.length > 0 ? { resumes: cfg.resumes } : {}),
    ...(cfg.roleDefs && cfg.roleDefs.length > 0 ? { roleDefs: cfg.roleDefs } : {}),
    // writeRunManifest 是**显式白名单** —— 不加进来就永远写不出去,而 readRunManifest
    // 读的是一个不存在的键:恢复之后所有跳过失效,评审/验收席位复活(0 席 = 主模型顶上),
    // 用户毫不知情地为一次恢复付了说好不付的钱。
    ...(cfg.skipSteps && cfg.skipSteps.length > 0 ? { skipSteps: cfg.skipSteps } : {}),
    // 定向注入(§定向注入)。同一条白名单规矩:不加进来就永远写不出去,而 --resume 之后
    // 「评审时重点看并发安全」这句话会**静默消失** —— 名册一模一样,评审员收到的东西变了,
    // 而界面上没有任何地方能让用户发现。roleDefs 和 skipSteps 都是为这条注释付过学费的。
    ...(cfg.phaseGuidance && Object.keys(cfg.phaseGuidance).length > 0 ? { phaseGuidance: cfg.phaseGuidance } : {}),
    ...(cfg.roleGuidance && cfg.roleGuidance.length > 0 ? { roleGuidance: cfg.roleGuidance } : {}),
    // 独立于 status 落盘 —— 见 EffTaskConfig.pendingHandoff:status 先写下 completed 而
    // 集成分支还没处置,用户直接关终端就再也没人管那条分支了。
    ...(cfg.pendingHandoff ? { pendingHandoff: cfg.pendingHandoff } : {}),
    ...(result ? { status: result.status, reason: result.reason ?? '' } : {}),
  })}---\n\n`
  await fs.mkdir(runDir)
  await fs.writeFile(`${runDir}/run.md`, header + renderTreeSnapshot(nodes))
}
