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
    /**
     * 这一轮是按**哪一档**判的。
     *
     * 档位可以在运行中调,而 `RoundtableRecord.strictness` 承诺的是「『第 1 轮按专家判
     * 不通过、第 2 轮降到中级判通过』这件事在盘上必须读得出来」。只写进 frontmatter 的话
     * 那只做到了机器可读那一半 —— 而这个文件自己的规矩是「body 才是人读的那一半」。
     *
     * 省略 = 不设档,老 node.md 逐字节不变。
     */
    const lv = r?.strictness ? `(${stripControl(String(r.strictness))}档) ` : ''
    /**
     * 作废的那一轮要**当场标出来**,理由和下面 MANUAL-PASS 那条逐字同源:这一节是事后
     * 追责唯一读得到的东西,而一条已作废的裁决和一条真裁决在这里本来长得一模一样。
     * 排在 PASS/FAIL 之前 —— 先说「这条不算数」,再说它当时判了什么。
     */
    const voided = typeof r?.voided === 'string' && r.voided.length > 0
      ? `[已作废:${clipBody(stripControl(r.voided))}] ` : ''
    /**
     * 修复类环节(质疑修复 / 测试修复)**不渲染 PASS/FAIL**。
     *
     * 它们不做裁决,记录里的 `synthesized.pass` 恒为 true —— 那是给下游读的「这一关没有
     * 挡住任何人」,不是一次判决。原样印成 `PASS` 会让 node.md 上出现一次从没发生过的
     * 通过,而这一节正是用户事后追责唯一读得到的东西(同一条规矩上一次是为
     * MANUAL-PASS 立的)。
     *
     * 判据是**记录自己带的 `step`**,不是「它躺在哪个 log 里」:这个函数两个 log 共用,
     * 而老 node.md 里的评审记录没有 step —— 那时候 review 真的是一次判决,照旧印
     * PASS/FAIL 才是对的。
     */
    const isFix = r?.step === 'review' || r?.step === 'verify'
    const head = `- ${step}${lv}round ${stripControl(String(r?.round ?? '?'))}: ${voided}${
      isFix ? '已完成(本环节直接修复,不做判决)' : r?.synthesized?.pass ? 'PASS' : 'FAIL'
    } ${stripControl(r?.synthesized?.blockingSummary ?? '')}`
    const roles = (r?.verdicts ?? []).map(v => {
      const detail = (v?.blocking ?? []).length > 0 ? (v.blocking ?? []).join('; ') : (v?.comments ?? '')
      /**
       * `MANUAL` 排在 `pass` **之前**,而且是自己的记号,不是 pass 的一种。
       *
       * 这一行是事后追责唯一读得到的东西。一条人工强制通过如果渲染成 `pass`,它和一位
       * 真的评审员点头就**逐字相同** —— 而两者的区别正是这一节存在的全部理由。
       * 判据是 `manual` 那个布尔,不是 role 里那四个字:role 是显示用的字符串,而
       * node.md 可以手工编辑,拿它当判据等于让改个名字就能伪装成人工放行(反过来也一样)。
       */
      // 修复类环节同理(见上面 isFix):这一席不是「赞成」,它是**动过手**的那一个。
      // 印成 pass 会让「改了三段」和「点了个头」在事后追责时长得一样。
      const mark = v?.infra ? 'CALL-FAILED' : v?.manual ? 'MANUAL-PASS' : isFix ? '已处理' : v?.pass ? 'pass' : 'FAIL'
      /**
       * **撤回要人读得见**,理由和上面 MANUAL-PASS 那条逐字同源。
       *
       * `Verdict.retracted` 会让一条历史阻断意见从 `feedbackItems` 里整条消失 —— 它不再进
       * 作者的反馈、不再进 `stuckItems`、也不再进 `exhaustionReason`。也就是说撤回是这套
       * 里**唯一**能让一条真实提出过的意见在下游全线消失的机制,而代码侧没有任何闸门校验
       * 撤回者是不是提出者、撤得对不对(那需要语义)。
       *
       * 唯一诚实的做法是让它在**人读的那一半**留痕:frontmatter 里本来就有,但这个文件
       * 自己的规矩是「body 才是人读的那一半」(见 strictness 那条渲染的注释)。少了这一行,
       * 一次误撤或滥撤在 node.md 上和「这条意见从没被提过」长得一模一样。
       */
      const gone = (v?.retracted ?? []).length > 0
        ? `\n    ↩ 本轮撤回 ${(v.retracted ?? []).length} 条历史意见: ` +
          clipBody(stripControl((v.retracted ?? []).join('; ')))
        : ''
      /**
       * **修改建议也要人读得见**,和上面 `retracted` 逐字同源。
       *
       * `Verdict.advice` 是「触顶不失败」整套东西的载荷:它会被 `adviceOf` 收进降级记录、
       * 铺进执行者和验收员的提示词。只落 frontmatter 的话,一条真的提出过、真的被送下去的
       * 建议在 node.md 上和「这一席什么都没说」长得一模一样 —— 而 node.md 是事后追责唯一
       * 读得到的东西。降级那一节只渲染**降级发生时**收拢的那一份;一轮提了建议、下一轮就
       * 通过了的节点根本不会有降级记录,那条建议就此无处可读。
       */
      const tips = (v?.advice ?? []).length > 0
        ? `\n    → 修改建议 ${(v.advice ?? []).length} 条: ` +
          clipBody(stripControl((v.advice ?? []).join('; ')))
        : ''
      return `  - [${stripControl(String(v?.role ?? 'unknown'))}] ${mark}${detail ? ': ' + clipBody(stripControl(detail)) : ''}${gone}${tips}`
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

/**
 * 一节「逐条处置」。
 *
 * `clipBody` 是**逐条**夹的,不是整节夹的:一条 2000 字的回应(上限见 capResponses)会把
 * 后面所有条目连同它们的编号一起顶掉,而读的人看到的是一份**看起来完整**的短清单 ——
 * 这个仓库反复在修的正是这一类。
 *
 * DEFENSIVE:和 roundtableBody 同一条理由。这段跑在每一次 commit 上,而
 * `validateLoadedNodes` 之外还有手工编辑过的 node.md;这里抛一次,节点就会带着一条裸
 * TypeError 阻断,而且每次 --resume 都复现。一节 body 不值一个死掉的 run。
 */
function responsesBody(heading: string, items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  // 续行缩进,理由见 pipeline 的 `responseLine`:条目正文是模型写的,它换一行就顶格,
  // 于是屏幕上「一共回了几条」这个数当场失真(两条含换行的回应看起来是四条,编号 1/2/2/3)
  // —— 而重新编号本来就是为了保住那个数。
  const lines = items.map((s, i) =>
    `${i + 1}. ${clipBody(stripControl(typeof s === 'string' ? s : String(s))).split('\n').join('\n   ')}`)
  return `${heading}\n${lines.join('\n')}\n\n`
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
    // 逐条处置。**body 也要有** —— 它是「作者/执行者当时声称这条已经解决了」的唯一书面
    // 记录,而事后追责问的正是这句话:哪一条是它说改了而其实没改的。只落进 frontmatter
    // 等于只做到机器可读那一半,这个文件自己的规矩是 body 才是人读的那一半(见 alternatives)。
    // 省略 = 没有回应(第 1 轮,或者一条都没答),老 node.md 的形状逐字不变。
    responsesBody('## 方案:对上一轮意见的逐条处置', node.plan.responses) +
    `## 执行状态\n${c(node.execStatus)}\n\n` +
    responsesBody('## 执行:对上一轮验收意见的逐条处置', node.execResponses) +
    (node.blockedReason ? `## 阻断原因\n${c(node.blockedReason)}\n\n` : '') +
    /**
     * 降级放行的账,**写进人读的那一半**。
     *
     * frontmatter 里已经有 `degraded`,但这个文件自己的规矩是「只落 frontmatter 等于
     * 只做到机器可读那一半」(见上面 alternatives 和 responses 的两处)。而这一段恰恰是
     * 用户最需要读到的:这个节点**没有通过判决**,是按迭代上限放行的,而当初提的意见
     * 一条不少地在这里。少了它,node.md 上一个 ACCEPTED 的节点读起来和真通过的完全一样。
     */
    ((node.degraded ?? []).length > 0
      ? `## 降级放行(未通过判决,按迭代上限放行)\n${(node.degraded ?? []).map(d =>
          `### ${PHASE_LABEL[d.phase]} · 第 ${d.round} 轮 · ${stripControl(d.at)}\n` +
          `${c(d.reason)}\n` +
          (d.advice.length > 0
            ? `修改建议(已随节点交给后续环节):\n${d.advice.map((a, i) => `  ${i + 1}. ${c(a)}`).join('\n')}\n`
            : '(这几轮没有留下可执行的修改建议)\n')).join('\n')}\n`
      : '') +
    // 落选稿。只落进 frontmatter 而 body 不渲染的话,「不静默截断」只做到了机器可读那一半
    // —— body 才是人读的那一半。
    (node.plan.alternatives && node.plan.alternatives.length > 0
      ? `## 备选方案(圆桌落选稿)\n${node.plan.alternatives
          .map(alt => `### ${stripControl(alt.staff)}\n${clipBody(stripControl(alt.solution))}`).join('\n')}\n\n`
      : '') +
    // 标题跟着职责改:这一节记的是「谁质疑了什么、改了哪几段」,不再是几张赞成/反对票。
    `## 质疑修复记录\n${roundtableBody(node.reviewLog)}\n\n` +
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
    /**
     * **降级放行的节点不许画成一次干净的完成。**
     *
     * 它是 ACCEPTED,但它**没有通过判决** —— 轮数用尽之后带着意见被放行的。
     * 一行 `- [done] 某任务 (ACCEPTED)` 和一个真的过了三席验收的节点逐字相同,
     * 而 run.md 正是用户事后追责时唯一会读的那份文件。这个仓库为「谎报完成」
     * 付过三次学费(工作树已丢时拒绝跳过验收、半合并状态、finishedAt 缺席当状态),
     * 每一次的教训都是同一句:**终态相同不等于结论相同,渲染必须说得出差别**。
     *
     * 挂在同一行、而不是另起一段:和 `why` 同因 —— run.md 是脚本指过来的那份文件,
     * 把差别藏进嵌套的 node.md 等于没说。
     */
    const dg = (n.degraded ?? [])
    const degradeMark = dg.length > 0
      ? ` ⚠ 降级放行(${dg.map(d => PHASE_LABEL[d.phase]).join('、')}未通过,按迭代上限放行)`
      : ''
    lines.push(`${'  '.repeat(depth)}- [${uiStatus(n.status)}] ${stripControl(n.title)} (${n.status})${degradeMark}${why}`)
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
    /**
     * 两个 git 开关。同一条白名单规矩,而它们尤其不能漏:
     * `--resume` 的关口会拿读回来的 config 当**初值**渲染,读不回来的话,用户上一趟明明
     * 选了「共享工作树」,恢复之后关口显示「worktree 隔离」—— 而他多半是直接回车的。
     * (收口方式那一档已经取消,`finish` 不再落盘;老 run.md 里的由 resumeCore 忽略。)
     *
     * **写条件是「不等于默认值」而不是「有值」**:默认那两个不写,新 run 的 frontmatter
     * 才和以前逐字一样(和上面 resumeGuidance 那几条同一条规矩)。
     */
    ...(cfg.isolation && cfg.isolation !== 'worktree' ? { isolation: cfg.isolation } : {}),
    ...(cfg.autoPush === true ? { autoPush: true } : {}),
    // 独立于 status 落盘 —— 见 EffTaskConfig.pendingHandoff:status 先写下 completed 而
    // 集成分支还没处置,用户直接关终端就再也没人管那条分支了。
    ...(cfg.pendingHandoff ? { pendingHandoff: cfg.pendingHandoff } : {}),
    ...(result ? { status: result.status, reason: result.reason ?? '' } : {}),
  })}---\n\n`
  await fs.mkdir(runDir)
  await fs.writeFile(`${runDir}/run.md`, header + renderTreeSnapshot(nodes))
}
