import { parse as yamlParse } from 'yaml'
import { createNode, emptyPhaseRoles, emptyPlan, BLOCK_CATEGORIES, DEFAULT_CAPS, DEFAULT_PARALLELISM, PHASE_NAMES } from './types.js'
import type { Caps, EffTaskConfig, NodeKind, PhaseName, ResumeRecord, RoleBinding, TaskNode } from './types.js'
import type { FsLike } from './persistence.js'

const LEGAL_STATUS = new Set<string>([
  'CREATED', 'PLANNING', 'PLAN_REVIEW', 'READY', 'EXECUTING', 'EXECUTED', 'ACCEPTANCE',
  'REWORK', 'WAITING_CHILDREN', 'INTEGRATION_ACCEPT', 'SCORING', 'MERGE', 'ACCEPTED', 'BLOCKED',
])
const LEGAL_KIND = new Set<string>(['decompose', 'executable', 'unknown'])

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

// Filter ELEMENTS, not just the array: a node.md carrying `accept: ['pm']` would otherwise
// reach runRoundtable with role.roleName undefined in the runAgent request.
const roleArray = (v: unknown): RoleBinding[] =>
  Array.isArray(v)
    ? v
        .filter((r): r is { roleName: string; model?: unknown } =>
          !!r && typeof r === 'object' && typeof (r as { roleName?: unknown }).roleName === 'string')
        .map(r => ({ roleName: r.roleName, ...(typeof r.model === 'string' ? { model: r.model } : {}) }))
    : []

/**
 * Ids that sit on a dependency cycle.
 *
 * `hasCycle` in stateMachine.ts answers yes/no, which is enough for the live path (reject
 * the proposed child group) but not for resume: a cycle already on disk must have its exact
 * members BLOCKED. Otherwise nothing is advanceable, no propagateBlocked rule fires — the
 * deps all exist and none is BLOCKED — and run() ends with the opaque
 * '存在无法推进的阻断节点' while no node carries a reason, a state every later resume
 * reproduces byte for byte.
 *
 * Kahn's algorithm: whatever never reaches in-degree zero is on, or downstream of, a cycle.
 */
export function depCycleMembers(nodes: TaskNode[]): Set<string> {
  const ids = new Set(nodes.map(n => n.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const n of nodes) {
    // Only in-set, non-self edges: a dangling dep is a different failure (handled by the
    // referential-integrity pass) and counting it here would report a false cycle.
    const deps = n.deps.filter(d => ids.has(d) && d !== n.id)
    indeg.set(n.id, deps.length)
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id])
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const settled = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    settled.add(id)
    for (const dep of dependents.get(id) ?? []) {
      const left = (indeg.get(dep) ?? 0) - 1
      indeg.set(dep, left)
      if (left === 0) queue.push(dep)
    }
  }
  return new Set([...ids].filter(id => !settled.has(id)))
}

export interface ValidateResult { nodes: TaskNode[]; repairs: string[] }

/**
 * Turn whatever `loadRun` scraped off disk into something the state machine may safely see.
 *
 * The governing rule is BLOCK, NEVER SILENTLY DROP. Every edge that points at a node we
 * could not recover is evidence that the tree is incomplete, and P1's orchestrator already
 * blocks on exactly those two conditions (`子节点缺失` / `依赖节点缺失`, orchestrator.ts).
 * Erasing the edge would delete the evidence AND disable that rule, so a node would execute
 * with write tools on the premise that upstream work it cannot verify succeeded — and the
 * run would report completed. That is the one outcome this feature must never produce.
 *
 * `opts.goal` and `opts.phaseRoles` come from the recovered manifest: a synthesized root
 * needs the REAL objective and the REAL roster, because it is what the integration
 * roundtable judges the entire run against.
 */
export function validateLoadedNodes(
  nodes: TaskNode[],
  opts: { goal: string; phaseRoles: Record<PhaseName, RoleBinding[]>; now: string },
): ValidateResult {
  const repairs: string[] = []
  const kept = nodes.filter(n => {
    const ok = !!n && typeof n.id === 'string' && n.id.length > 0
    if (!ok) repairs.push('丢弃一个没有 id 的节点记录')
    return ok
  })
  const byId = new Map<string, TaskNode>()
  for (const n of kept) {
    if (byId.has(n.id)) { repairs.push(`重复节点 ${n.id},保留先读到的一份`); continue }
    byId.set(n.id, n)
  }

  const block = (n: TaskNode, why: string): void => {
    n.status = 'BLOCKED'
    n.blockedReason = n.blockedReason || why
    // NEVER interrupted: reseat reopens interrupted nodes, and a node blocked because its
    // own disk state is unusable must stay blocked.
    n.interrupted = false
    // Same door, and it was left open: a node that had legitimately tripped a valve keeps
    // capBlocked === true, so a later --retry-blocked reopened it even though this pass has
    // since blocked it for an UNRECOVERABLE reason (a missing child/dep, a cycle). The resume
    // gate then reported "重开 1 个节点" for a node that re-blocks with zero model calls —
    // exactly the failure --retry-blocked exists to fix — and n.blockedReason = '' erased the
    // original diagnosis on the way.
    n.capBlocked = false
    repairs.push(`节点 ${n.id}:${why}`)
  }

  for (const n of byId.values()) {
    if (!LEGAL_STATUS.has(n.status as string)) block(n, `恢复时发现非法状态 ${String(n.status)},无法安全重入`)
    if (!LEGAL_KIND.has(n.kind as string)) { repairs.push(`节点 ${n.id} 的 kind 非法,重置为 unknown`); n.kind = 'unknown' as NodeKind }
    n.deps = strArray(n.deps)
    n.childIds = strArray(n.childIds)
    if (typeof n.depth !== 'number' || !Number.isFinite(n.depth)) { repairs.push(`节点 ${n.id} 的 depth 非法,重置为 0`); n.depth = 0 }
    const it = (n.iteration ?? {}) as Partial<TaskNode['iteration']>
    // A missing counter reads as 0, never as "no limit": undefined + 1 is NaN, which never
    // satisfies >= maxIterations and would turn a bounded retry loop into an unbounded one.
    n.iteration = {
      planReview: Number.isFinite(it.planReview) ? (it.planReview as number) : 0,
      acceptance: Number.isFinite(it.acceptance) ? (it.acceptance as number) : 0,
      integration: Number.isFinite(it.integration) ? (it.integration as number) : 0,
      scoring: Number.isFinite(it.scoring) ? (it.scoring as number) : 0,
      mergeResolve: Number.isFinite(it.mergeResolve) ? (it.mergeResolve as number) : 0,
    }
    if (typeof n.execStatus !== 'string') n.execStatus = ''
    if (typeof n.blockedReason !== 'string') n.blockedReason = ''
    if (!n.plan || typeof n.plan !== 'object') n.plan = emptyPlan()
    else for (const k of ['solution', 'keyPoints', 'risks', 'acceptance'] as const) {
      if (typeof n.plan[k] !== 'string') n.plan[k] = ''
    }
    if (!Array.isArray(n.reviewLog)) n.reviewLog = []
    if (!Array.isArray(n.acceptLog)) n.acceptLog = []
    if (!n.score || typeof n.score !== 'object') n.score = {}
    const pr = (n.phaseRoles ?? {}) as Record<string, unknown>
    n.phaseRoles = Object.fromEntries(PHASE_NAMES.map(p => [p, roleArray(pr[p])])) as Record<PhaseName, RoleBinding[]>
    if (typeof n.title !== 'string' || n.title.length === 0) n.title = n.id
    if (typeof n.goal !== 'string' || n.goal.length === 0) n.goal = n.title
    // `--retry-blocked` keys on this EXACT boolean. run.md and node.md are hand-editable, and
    // a truthy non-boolean (`capBlocked: "yes"`) would let the retry path reopen a node no
    // valve ever stopped. Only a real `true` counts; everything else means "not a valve".
    if (n.capBlocked !== undefined && n.capBlocked !== true) n.capBlocked = false
    // Same discipline as capBlocked one line up, and it was missing: node.md is hand-editable,
    // and reseat chooses which PHASE a retried node re-enters from this string. A garbage or
    // non-string value silently took the executable seat — the review-bypass this field exists
    // to prevent. Unknown values are dropped, which falls back to the derived check.
    if (n.capCategory !== undefined && !BLOCK_CATEGORIES.has(n.capCategory as string)) {
      repairs.push(`节点 ${n.id}:安全阀类别 ${String(n.capCategory)} 无法识别,已清除`)
      n.capCategory = undefined
    }
    // 根方案关口 (spec §2 第三关) 的确认结果。Reachable on disk when the run was aborted
    // before the root's first commit consumed it, so it must survive — but it is also the one
    // field that SKIPS the plan phase, and a malformed one would send an empty plan straight
    // into review. Anything that is not the exact shape is dropped, which degrades to
    // "the plan role drafts it", never to "an empty plan is approved".
    if (n.confirmedDraft !== undefined) {
      const kids = (n.confirmedDraft as { children?: unknown }).children
      const clean = Array.isArray(kids)
        ? kids
            .filter((c): c is { title: string; deps?: unknown } =>
              !!c && typeof c === 'object' && typeof (c as { title?: unknown }).title === 'string' && (c as { title: string }).title.length > 0)
            .map(c => ({ title: c.title, deps: strArray(c.deps) }))
        : null
      // An array whose every entry is malformed cleans to [] — which is NOT "no children",
      // it is "we lost them". Kept, it made stepStart skip the plan call and approve an EMPTY
      // decomposition: root went to WAITING_CHILDREN with childIds: [], advanceableKind
      // returned null, propagateBlocked had nothing to blame, and the run ended
      // '存在无法推进的阻断节点' with a grey root and no explanation — reproducibly, on every
      // later resume. Measured: planCalls = 0.
      const lostChildren = clean !== null && clean.length === 0 && Array.isArray(kids) && kids.length > 0
      if (clean === null || lostChildren) {
        repairs.push(`节点 ${n.id}:根方案确认记录已损坏,恢复后将由 plan 角色重新起草`)
        n.confirmedDraft = undefined
      } else {
        n.confirmedDraft = { children: clean }
      }
    }
    // A worktree reference is a DISK path, and disk paths do not survive. serializeNode
    // round-trips it, so a resumed node arrives still claiming a worktree that dispose or gc
    // may have removed — and because the isolation gate is "no worktree yet", that stale
    // value makes the gate PASS: acquire is never called again and the executor runs against
    // a dead path, or against a base that never saw its dependencies' merges. Clearing it
    // forces a fresh acquire, which is also what re-bases the worktree.
    if (n.worktree !== undefined) {
      // EXCEPT for a conflict block. There the path is not stale bookkeeping — it is where
      // the human was told to go and fix things. Clearing it forces a fresh acquire(), whose
      // `checkout -B <branch> <integration>` resets the node branch and parks the human's
      // commit on a salvage ref: measured, the fix left the tree entirely and was never
      // merged. Keeping the reference is also what lets handoff() report the worktree.
      if (n.mergeConflict === true) {
        repairs.push(`节点 ${n.id}:保留冲突工作区 ${n.worktree.path},恢复后将重跑验收并重试合并`)
      } else {
        repairs.push(`节点 ${n.id}:清除陈旧的隔离工作区引用,恢复时将重新分配`)
        n.worktree = undefined
      }
    }
  }

  // ---- referential integrity: block the referrer, keep the edge ----
  for (const n of byId.values()) {
    if (n.deps.some(d => d === n.id)) {
      repairs.push(`节点 ${n.id}:丢弃自依赖(自依赖必然死锁)`)
      n.deps = n.deps.filter(d => d !== n.id)
    }
    const missingDeps = n.deps.filter(d => !byId.has(d))
    if (missingDeps.length > 0) block(n, `依赖节点缺失(${missingDeps.join('、')})`)
    const missingKids = n.childIds.filter(c => !byId.has(c))
    if (missingKids.length > 0) block(n, `子节点缺失(${missingKids.join('、')})`)
    if (n.parentId !== null && !byId.has(n.parentId)) {
      repairs.push(`节点 ${n.id} 的父节点 ${n.parentId} 不存在,改挂为根级`)
      n.parentId = null
    }
  }

  for (const id of depCycleMembers([...byId.values()])) {
    const n = byId.get(id)!
    if (n.status !== 'BLOCKED') block(n, '依赖成环,无法确定执行顺序')
  }

  // ---- rebuild both link directions ----
  for (const n of byId.values()) {
    for (const cid of n.childIds) {
      const child = byId.get(cid)
      // Do NOT overwrite unconditionally. On a cyclic childIds graph that manufactures a
      // parentId cycle, after which NO node has parentId === null and the tree can neither
      // render nor walk ancestors. Only fill in a parent that is genuinely absent.
      if (child && child.parentId === null && child.id !== n.id) {
        repairs.push(`修正 ${cid} 的父指针为 ${n.id}`)
        child.parentId = n.id
      }
    }
  }
  for (const n of byId.values()) {
    if (n.parentId === null) continue
    const parent = byId.get(n.parentId)
    if (parent && !parent.childIds.includes(n.id)) {
      repairs.push(`把 ${n.id} 补回父节点 ${parent.id} 的子列表`)
      parent.childIds.push(n.id)
    }
  }
  // Last resort: if the link repair left the graph with no root-level node at all (a
  // childIds cycle among every node), free the lowest id so the tree has somewhere to start.
  if (byId.size > 0 && ![...byId.values()].some(n => n.parentId === null)) {
    const first = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))[0]
    repairs.push(`所有节点都声称有父节点(父子关系成环),已把 ${first.id} 提为根级`)
    first.parentId = null
  }

  // ---- guarantee the invariant run() asserts on every iteration ----
  const root = byId.get('root')
  if (!root) {
    repairs.push('恢复的树里没有根节点,已合成一个根并挂上所有根级节点')
    const orphans = [...byId.values()].filter(n => n.parentId === null)
    const synthesized = createNode({
      id: 'root',
      title: opts.goal.split('\n').map(l => l.trim()).find(l => l.length > 0) || '根任务(恢复时合成)',
      goal: opts.goal,
      parentId: null, deps: [], depth: 0,
      // The REAL roster: runRoundtable turns an empty one into a single main-model reviewer,
      // so an empty roster here would judge the whole run on a panel the gate never showed.
      phaseRoles: opts.phaseRoles,
      now: opts.now,
    })
    if (orphans.length === 0) {
      synthesized.status = 'BLOCKED'
      synthesized.blockedReason = '恢复时没有恢复到任何节点,run 目录可能是空的或已损坏'
      synthesized.interrupted = false
    } else if (opts.goal.trim().length === 0) {
      // No manifest either → no objective to accept against. Letting this root reach
      // INTEGRATION_ACCEPT would decide the entire run on an empty question.
      synthesized.kind = 'decompose'
      synthesized.status = 'BLOCKED'
      synthesized.blockedReason = '原始目标已丢失(run.md 不可读),无法判定整体验收'
      synthesized.interrupted = false
      synthesized.childIds = orphans.map(o => o.id)
      for (const o of orphans) o.parentId = 'root'
    } else {
      synthesized.kind = 'decompose'
      synthesized.status = 'WAITING_CHILDREN'
      synthesized.childIds = orphans.map(o => o.id)
      for (const o of orphans) o.parentId = 'root'
    }
    byId.set('root', synthesized)
  } else {
    // A recovered orphan that is not the root belongs somewhere, or it will run and never
    // count towards anything.
    for (const n of byId.values()) {
      if (n.id === 'root' || n.parentId !== null) continue
      repairs.push(`节点 ${n.id} 没有父节点,已挂到根节点下`)
      n.parentId = 'root'
      if (!root.childIds.includes(n.id)) root.childIds.push(n.id)
    }
  }

  return { nodes: [...byId.values()], repairs }
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

export interface ManifestResult { config: EffTaskConfig; degraded: string[] }

/**
 * Rebuild the run's config from `run.md`'s frontmatter — the parallelism, roster, safety
 * caps and original objective the run was started with.
 *
 * Same rule as `loadRun`: ONE damaged file must not cost the user the recovered tree. A
 * missing or unparseable manifest degrades to defaults and says so in `degraded`, which the
 * resume gate shows; every node.md is still on disk and the roster is re-confirmable there.
 *
 * Every number is clamped rather than trusted: this file is as hand-editable as node.md, and
 * a `parallelism: 99999` read straight into the pool would be a self-inflicted fork bomb.
 */
export async function readRunManifest(fs: FsLike, runDir: string): Promise<ManifestResult> {
  const degraded: string[] = []
  const base: EffTaskConfig = {
    goalPrompt: '', parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, notices: [],
  }
  let fm: Record<string, unknown>
  try {
    const text = await fs.readFile(`${runDir}/run.md`)
    const m = text.match(/^---\n([\s\S]*?)\n---/)
    if (!m) throw new Error('run.md 缺少 frontmatter')
    const parsed = yamlParse(m[1])
    if (!parsed || typeof parsed !== 'object') throw new Error('run.md frontmatter 不是一个映射')
    fm = parsed as Record<string, unknown>
  } catch (e) {
    degraded.push(`run.md 无法读取或解析(${e instanceof Error ? e.message : String(e)}),配置回退默认值`)
    return { config: base, degraded }
  }

  if (typeof fm.goalPrompt === 'string' && fm.goalPrompt.length > 0) base.goalPrompt = fm.goalPrompt
  else degraded.push('run.md 缺少 goalPrompt(原始目标),整体验收将无法判定')
  base.parallelism = clampInt(fm.parallelism, 1, 64, DEFAULT_PARALLELISM)

  const caps = (fm.caps ?? {}) as Record<string, unknown>
  const rebuilt: Caps = {
    maxDepth: clampInt(caps.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth),
    maxNodes: clampInt(caps.maxNodes, 1, 5000, DEFAULT_CAPS.maxNodes),
    maxIterations: clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations),
    nodeTimeoutMs: clampInt(caps.nodeTimeoutMs, 1000, 3_600_000, DEFAULT_CAPS.nodeTimeoutMs),
  }
  // Rebuilding field-by-field silently dropped scoreThreshold, so a run configured with one
  // lost it on resume. Carry it when present.
  if (caps.scoreThreshold !== undefined) rebuilt.scoreThreshold = clampInt(caps.scoreThreshold, 0, 100, 0)
  base.caps = rebuilt

  const pr = (fm.phaseRoles ?? {}) as Record<string, unknown>
  base.phaseRoles = Object.fromEntries(
    PHASE_NAMES.map(p => [p, roleArray(pr[p])]),
  ) as Record<PhaseName, RoleBinding[]>

  base.notices = Array.isArray(fm.notices) ? fm.notices.filter((n): n is string => typeof n === 'string') : []
  if (typeof fm.mainModel === 'string') base.mainModel = fm.mainModel
  if (typeof fm.resumeGuidance === 'string') base.resumeGuidance = fm.resumeGuidance
  // Re-emitted verbatim on every later manifest write, so the resume history accumulates
  // instead of being flattened by the next full-file rewrite.
  if (Array.isArray(fm.resumes)) {
    base.resumes = fm.resumes
      .filter((r): r is ResumeRecord => !!r && typeof r === 'object' && typeof (r as { at?: unknown }).at === 'string')
      .map(r => ({
        at: r.at,
        reseated: Number.isFinite(r.reseated) ? r.reseated : 0,
        exhausted: Number.isFinite(r.exhausted) ? r.exhausted : 0,
        repairs: Array.isArray(r.repairs) ? r.repairs.filter((x): x is string => typeof x === 'string') : [],
      }))
  }
  return { config: base, degraded }
}
