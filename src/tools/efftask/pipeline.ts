// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, RoleBinding, RoundtableRecord, TaskNode } from './types.js'
import { createNode } from './types.js'
import { ANSWER_TAGS, answerTag, parseExecOutput, parsePlanOutput, parseScoreOutput } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle, isTerminal } from './stateMachine.js'
import type { WorktreePool } from './worktreePool.js'

/** A claim on node-count budget. Single-shot by construction — see reserveNodes. */
export type NodeSlots = { release: () => void }

export interface PipelineCtx {
  config: EffTaskConfig
  byId: Map<string, TaskNode>
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  signal: AbortSignal
  onUpdate: () => void
  /**
   * Claim `count` node slots, or return null when the cap would be exceeded.
   *
   * SYNCHRONOUS on purpose: the cap check and the claim must not be separated by an await.
   * The old inline `byId.size + specs.length > maxNodes` check was followed by an await
   * before the insert, so two concurrent decompositions both measured the same stale size,
   * both passed, and the tree ran past the cap — the safety valve silently off.
   *
   * Returns a TOKEN rather than a boolean so release is structurally single-shot and pairs
   * with try/finally. A plain `releaseNodes(count)` invites a double release, and clamping
   * that at zero would silently UNDER-enforce maxNodes instead of failing loudly.
   */
  reserveNodes: (count: number) => NodeSlots | null
  /**
   * Per-node git isolation, or undefined when the run is not isolated.
   *
   * Its PRESENCE is the switch: when it is set, a node that cannot get a worktree must be
   * blocked, never executed. Falling back to the shared tree would run a write-capable
   * executor in the user's real checkout — and, with the execute mutex lifted, several of
   * them concurrently. That is the exact outcome isolation exists to prevent.
   */
  worktrees?: WorktreePool
  /**
   * 人工升级 (spec §8): a merge conflict the node could not resolve itself.
   *
   * A callback rather than a direct Feishu call, because the shared client lives in the
   * command layer — the same rule the confirmation card follows. Absent in tests and in runs
   * with no Feishu bridge; the node still blocks with the details in blockedReason either way.
   */
  onEscalate?: (info: {
    node: TaskNode; branch: string; path: string; files: string[]; attempted: boolean
    /** MEASURED state of that worktree, so the card can describe it instead of guessing. */
    state: { markers: boolean; staged: boolean; stale: boolean }
    integrationBranch?: string
  }) => void
}

/**
 * Advance the node and make it durable. Returns false when the write failed — the caller
 * must stop immediately.
 *
 * A persist failure cannot be ignored: the orchestrator schedules off in-memory state, so
 * continuing would run work whose progress can never be recovered, and on-disk the node
 * would keep a stale (often transient) status forever. We mark it BLOCKED in memory so the
 * scheduler treats it as terminal rather than re-entering it every tick.
 */
async function commit(node: TaskNode, status: TaskNode['status'], ctx: PipelineCtx): Promise<boolean> {
  node.status = status
  node.updatedAt = ctx.now()
  try {
    await ctx.persist(node)
  } catch (e) {
    node.status = 'BLOCKED'
    node.blockedReason = `状态持久化失败: ${e instanceof Error ? e.message : String(e)}`
    safeUpdate(ctx)
    return false
  }
  safeUpdate(ctx)
  return true
}

// A crashing renderer must never take the run down with it.
function safeUpdate(ctx: PipelineCtx): void {
  try { ctx.onUpdate() } catch { /* UI failure is not a run failure */ }
}

// `text` rides along on the FAILURE branch too: the execute phase runs with write-capable
// tools, so an abort that arrives after the executor answered may be discarding the only
// record of changes already made to the repo.
type PhaseResult = { ok: true; text: string } | { ok: false; reason: string; text?: string }
// Wraps a direct runAgent phase call (plan/execute). A throw OR an abort observed
// after the call yields ok:false with a reason; the caller hands it to blockWithReason,
// which records it into node.blockedReason and BLOCKs the node.
async function runPhase(ctx: PipelineCtx, req: Parameters<RunAgentFn>[0]): Promise<PhaseResult> {
  try {
    const text = await ctx.runAgent(req)
    if (ctx.signal.aborted) return { ok: false, reason: '已中断', text }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// Records WHY the node died in its own field. It must NOT touch node.execStatus, which may
// hold real completed-work evidence that acceptance/audit still needs.
async function blockWithReason(node: TaskNode, reason: string, ctx: PipelineCtx): Promise<void> {
  node.blockedReason = reason
  // Structural, not textual: if the run is aborting, this block is an interruption rather
  // than a judgement about the work, and resume must be able to reopen exactly these nodes.
  // Assigned in BOTH directions on purpose — a node reseated by an earlier resume carries a
  // cleared flag, and if it later fails for real the flag must not linger and resurrect it.
  // (The orchestrator's abort sweep marks the rest; it skips nodes that are already BLOCKED,
  // which is exactly the set this line covers.)
  node.interrupted = ctx.signal.aborted
  await commit(node, 'BLOCKED', ctx)
}

// True when a round failed only because reviewer CALLS failed, not because anyone judged
// the work. Retrying the review is right; redoing the executor's work would be wrong.
function isInfraOnlyFailure(rec: { verdicts: { pass: boolean; blocking: string[]; infra?: boolean }[] }): boolean {
  const failing = rec.verdicts.filter(v => !v.pass || v.blocking.length > 0)
  return failing.length > 0 && failing.every(v => v.infra === true)
}

// A node with deps must SEE what its dependencies produced, otherwise it replans from
// scratch and redoes upstream work.
function depsSection(node: TaskNode, ctx: PipelineCtx): string {
  if (node.deps.length === 0) return ''
  const lines = node.deps.map(id => {
    const d = ctx.byId.get(id)
    return d ? `- ${quote(d.title)}(${d.status}): ${quote(d.execStatus) || '(尚无执行状态)'}` : `- ${quote(id)}: (依赖节点缺失)`
  })
  return `已完成的依赖任务及其产出(基于这些结果继续,不要重复它们的工作):\n${lines.join('\n')}\n`
}

// OUTPUT DISCIPLINE — every phase prompt must end with answerRule(tag). The answer
// goes in a fence tagged with ITS phase tag (```plan / ```verdict / ```exec); plain
// ```json stays reserved for quoted context. That tag is the only thing that tells
// parseOutput "this is my answer" apart from "this is something I'm quoting" —
// shape and recency both mis-rank a same-shaped recap of a previous verdict, which
// is how a fail silently became a pass. parseVerdict additionally FAILS CLOSED when
// it sees two untagged verdict blocks, so an uncooperative model costs an iteration
// rather than letting unfinished work through.
/**
 * Run one roundtable, retrying ONLY when the reviewers' calls failed rather than judged.
 *
 * All three loops (review / accept / integrate) need this identical policy: a flaky
 * provider must not read as a rejection, because that costs a full plan regeneration or a
 * whole re-execution — and for integrate it discards an already-finished subtree. Encoding
 * it once keeps the three from drifting, which they already had.
 */
async function roundtableWithInfraRetry(args: {
  phase: 'review' | 'accept'
  node: TaskNode
  roles: RoleBinding[]
  round: number
  system: string
  buildPrompt: (tag: string) => string
  ctx: PipelineCtx
  /** Where the reviewers should read from — the node's worktree when it is isolated. */
  cwd?: string
}): Promise<{ rec: RoundtableRecord; infraExhausted: boolean }> {
  // At least one attempt regardless of a programmatically-supplied cap: zero attempts would
  // leave `rec` undefined and every caller dereferences it.
  const max = Math.max(1, args.ctx.config.caps.maxIterations)
  let rec!: RoundtableRecord
  for (let attempt = 1; attempt <= max; attempt++) {
    // A fresh tag per attempt: an agent cannot pre-plant a verdict under a tag it has
    // never seen, and a stale tag from an earlier attempt no longer counts as tagged.
    const tag = answerTag(ANSWER_TAGS.verdict)
    rec = await runRoundtable({
      phase: args.phase, node: args.node, roles: args.roles, round: args.round,
      system: args.system, prompt: args.buildPrompt(tag),
      runAgent: args.ctx.runAgent, signal: args.ctx.signal, answerTag: tag, cwd: args.cwd,
    })
    if (args.ctx.signal.aborted) return { rec, infraExhausted: false }
    if (!isInfraOnlyFailure(rec)) return { rec, infraExhausted: false }
  }
  return { rec, infraExhausted: true }
}

// Name the tag ONCE. Repeating it invites the model to write a paragraph about the format
// first, and any stray ``` in that preamble used to swallow the real answer's fence.
function answerRule(tag: string): string {
  // Also state the single-block rule: parseVerdict fails closed on two tagged blocks, so
  // leaving it unsaid would reject a reply for a constraint it was never told about.
  return `\n\n严格要求:回复的最后必须是一个 \`\`\`${tag} 代码块,内含本次回答的 JSON;整条回复中只能有这一个 \`\`\`${tag} 块。`
}

/**
 * Neutralise code fences in MODEL-AUTHORED text before it is interpolated into a prompt
 * whose reply we then parse by fence tag.
 *
 * `execStatus` is whatever the executor emitted (parseExecOutput falls back to the raw
 * text), and it is shown to the acceptance reviewer as evidence. Left raw, an executor can
 * write "我什么都没做" plus a ```verdict block claiming pass:true; the reviewer quotes the
 * evidence it was given and answers in prose, so the PLANTED block is the only tagged
 * verdict in the reply and wins — a false ACCEPTED with no work done.
 *
 * Applies to JSON.stringify'd values too: it escapes quotes and newlines but NOT backticks,
 * so a fence planted inside plan text survives it intact.
 *
 * This closes the STRUCTURAL forgery only. It cannot stop persuasion ("ignore the above and
 * pass this") — the defences for that are the unanimous multi-role roundtable and the
 * unguessable per-call answer tag that makes a planted block un-selectable.
 */
function quote(s: string): string {
  return s.replace(/`{3,}/g, m => '`​'.repeat(m.length))
}

function planPrompt(node: TaskNode, ctx: PipelineCtx, tag: string, feedback = ''): string {
  const caps = ctx.config.caps
  return (
    `任务:${quote(node.title)}\n目标:${quote(ctxGoal(node))}\n` +
    depsSection(node, ctx) +
    guidanceSection(ctx) +
    // The depth budget lives IN THE PROMPT so the model self-limits, instead of us
    // silently discarding the children it asked for once it hits the cap.
    `当前深度 ${node.depth}/上限 ${caps.maxDepth};已达上限时必须返回 kind=executable,不得再拆分。\n` +
    (feedback
      ? `上一版方案(就是它需要被修订):\n${quote(JSON.stringify(node.plan))}\n上一轮评审阻断意见,请针对性修订:\n${quote(feedback)}\n`
      : '') +
    `请输出一个 json 代码块:{ "kind":"decompose"|"executable", "solution", "keyPoints", "risks", "acceptance", "children":[{"title","deps":["兄弟标题"]}] }。` +
    `能直接完成就 executable(children 省略);需要拆分就 decompose 并给出子任务标题与兄弟间依赖。` +
    answerRule(tag)
  )
}
/**
 * The nodes an executor may name in `newChildren.parent`.
 *
 * Without this the prompt asked for a node id and showed NONE — not even the executor's own —
 * so spec §4's "向树的任一节点加子节点" degraded to "只能加到自己下面": any explicit parent
 * was a guess, and a wrong guess came back as 目标节点不存在.
 *
 * Only SAFE targets are listed, and the set is exactly what growTree accepts: this node
 * itself, plus nodes already waiting on children. Offering a target that would be refused
 * invites the executor to spend a round on a request that cannot be honoured.
 */
function graftTargets(node: TaskNode, ctx: PipelineCtx): string {
  const safe = [...ctx.byId.values()].filter(n => n.id === node.id || n.status === 'WAITING_CHILDREN')
  if (safe.length === 0) return ''
  // maxNodes can legally reach 5000; an unbounded list would swamp the prompt.
  const lines = safe.slice(0, 40).map(n => `- ${quote(n.id)}${n.id === node.id ? '(本节点)' : ''}: ${quote(n.title)}`)
  const more = safe.length > 40 ? `\n(还有 ${safe.length - 40} 个,未全部列出)` : ''
  return `可作为 newChildren.parent 的节点(只有这些可以挂):\n${lines.join('\n')}${more}\n`
}

// Reference the IMMUTABLE node goal (set at creation), not the mutable plan.solution —
// otherwise the goal drifts every time the plan is re-emitted during review iterations.
function ctxGoal(node: TaskNode): string { return node.goal }

function reviewPrompt(node: TaskNode, tag: string): string {
  return `请评审以下方案是否可执行、完整、无重大风险。方案:\n${quote(JSON.stringify(node.plan))}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。有任何阻断问题填入 blocking。` + answerRule(tag)
}
function executePrompt(node: TaskNode, ctx: PipelineCtx, tag: string, feedback = ''): string {
  return (
    `按以下方案执行任务并完成实际改动。方案:\n${quote(JSON.stringify(node.plan))}\n` +
    depsSection(node, ctx) +
    guidanceSection(ctx) +
    // REWORK path: show the acceptance blockers AND what the previous round already did,
    // so the rerun is a targeted fix rather than a blind repeat.
    (feedback
      ? `上一轮验收未通过,阻断意见:\n${quote(feedback)}\n上一轮执行状态:\n${quote(node.execStatus)}\n请针对性返工。\n`
      : '') +
    graftTargets(node, ctx) +
    `完成后输出:{ "execStatus":"做了什么、结果如何", "newChildren"?:[{"parent"?:"上面清单里的节点 id,省略则挂到本节点下","title","deps":["同批兄弟标题"]}] }。` +
    `只有在执行中发现必须先完成的新子任务时才给 newChildren。` + answerRule(tag)
  )
}
// Blank fields must READ as blank. Interpolating an empty acceptance/execStatus renders
// "验收点:\n执行状态:" — two empty slots a reviewer can wave through as satisfied.
function acceptPrompt(node: TaskNode, tag: string): string {
  return (
    `请验收执行结果是否达成验收点。\n` +
    `验收点:${quote(node.plan.acceptance) || '(本节点未定义验收点,请依据目标判断:' + quote(ctxGoal(node)) + ')'}\n` +
    `执行状态:${quote(node.execStatus) || '(执行阶段没有报告任何产出,视为未完成)'}\n` +
    `输出:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(tag)
  )
}
// Integration acceptance judges CHILD evidence against the parent goal. acceptPrompt would
// show only the parent's own execStatus — which for a decompose node is empty.
function integratePrompt(node: TaskNode, ctx: PipelineCtx, tag: string, feedback = ''): string {
  // A child missing from the map is REPORTED, not filtered away: silently shrinking the
  // evidence list would let a parent be accepted on the strength of the children that
  // happen to still be there.
  const children = node.childIds
    .map(id => {
      const c = ctx.byId.get(id)
      return c
        ? `### ${quote(c.title)}\n- 状态: ${c.status}\n- 执行状态: ${quote(c.execStatus) || '(无)'}\n- 验收点: ${quote(c.plan.acceptance) || '(无)'}`
        : `### ${quote(id)}\n- 状态: (节点缺失,无法核实其结果)`
    })
    .join('\n')
  return (
    `请验收"全部子任务的结果合起来是否达成本节点目标"。\n` +
    `父目标:${quote(ctxGoal(node))}\n父验收点:${quote(node.plan.acceptance) || '(无)'}\n\n` +
    `子任务结果:\n${children || '(无子任务)'}\n\n` +
    (feedback ? `上一轮集成验收阻断意见,请复核是否已解决:\n${quote(feedback)}\n\n` : '') +
    `输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(tag)
  )
}

// P1 runs a single planner/executor even if several are configured; only review and
// accept fan out into a roundtable. Extra plan/execute roles are deliberately ignored.
function firstRole(node: TaskNode, phase: 'plan' | 'execute') {
  return node.phaseRoles[phase][0] ?? null
}

// Re-entering a finished node would append a second verdict log and could flip a BLOCKED
// node to ACCEPTED. Terminal means terminal. (isTerminal is the state machine's own rule —
// don't restate it here, or the two definitions will drift.)
function isFinished(node: TaskNode): boolean {
  return isTerminal(node.status)
}


/**
 * 续跑指引(§17.4):恢复时用户补充的一段话,追加进后续 plan/execute 提示词。
 *
 * quote()d like every other model- or user-authored interpolation: this text lands in a
 * prompt whose reply is parsed by fence tag, so an unquoted \`\`\` in it could forge one.
 * Only affects unfinished work — an ACCEPTED node is never re-entered.
 */
function guidanceSection(ctx: PipelineCtx): string {
  const g = ctx.config.resumeGuidance?.trim()
  return g ? `续跑指引(用户在恢复时补充,优先级高于原方案的枝节):\n${quote(g)}\n` : ''
}

/**
 * The blocking summary of the last round that FAILED, recovered from the persisted log.
 *
 * `feedback` is a local inside stepStart/stepExecute, so a node reseated out of REWORK or
 * PLAN_REVIEW would re-enter with an empty one and the executor would blindly repeat the
 * work that was just rejected — with one fewer round of budget left. The data survives on
 * disk in the logs; read it back instead of losing it.
 */
function lastFailureFeedback(log: { synthesized: { pass: boolean; blockingSummary: string } }[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    if (!log[i].synthesized.pass) return log[i].synthesized.blockingSummary
  }
  return ''
}

export async function stepStart(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  // Seeded from the log so a RESUMED node re-plans against the blockers it already earned
  // rather than starting blind (see lastFailureFeedback).
  let feedback = lastFailureFeedback(node.reviewLog)
  // plan → review loop. A rejected child GROUP (dependency cycle) re-enters this same
  // loop, so replanning is bounded by the SAME maxIterations budget — a cycle costs a
  // retry, it does not instantly kill the run.
  for (;;) {
    if (!(await commit(node, 'PLANNING', ctx))) return
    const planTag = answerTag(ANSWER_TAGS.plan)
    const res = await runPhase(ctx, { phase: 'plan', node, role: firstRole(node, 'plan'), system: 'plan', prompt: planPrompt(node, ctx, planTag, feedback), signal: ctx.signal })
    if (!res.ok) { await blockWithReason(node, res.reason, ctx); return }
    const parsed = parsePlanOutput(res.text, planTag)
    node.kind = parsed.kind
    node.plan = parsed.plan
    const lastChildren = parsed.children
    if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1,
      system: 'review', buildPrompt: tag => reviewPrompt(node, tag), ctx,
    })
    node.reviewLog.push(rec)
    // runRoundtable resolves even when the run was cancelled mid-flight (it collects
    // whatever settled). Without this the node would go on to commit READY/WAITING_CHILDREN
    // after the user already cancelled.
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody judged the plan — say that rather than blaming the plan.
      await blockWithReason(node, `评审角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    if (!rec.synthesized.pass) {
      node.iteration.planReview++
      feedback = rec.synthesized.blockingSummary
      if (node.iteration.planReview >= caps.maxIterations) {
        await blockWithReason(node, `评审迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
        return
      }
      continue
    }

    // Re-check before committing READY. Read-only phases run CONCURRENTLY, so another node's
    // growTree can have grafted children onto THIS one while its plan call was in flight.
    // Overwriting that WAITING_CHILDREN with READY orphaned the new subtree: nothing waited
    // on it, and the run reported completed with the grafted work never executed.
    if (node.childIds.length > 0) {
      node.kind = 'decompose'
      await commit(node, 'WAITING_CHILDREN', ctx)
      return
    }
    if (node.kind !== 'decompose') { await commit(node, 'READY', ctx); return }

    // Depth cap: force this node executable rather than decomposing. Do NOT silently drop
    // the children the model asked for — fold their titles into the solution so the work
    // survives as an in-node checklist.
    if (node.depth + 1 > caps.maxDepth) {
      // parsePlanOutput only reports 'decompose' when it parsed at least one child, so
      // lastChildren is non-empty here.
      node.plan.solution += `\n\n已达最大深度,不得再拆分,请在本节点内依次完成:${lastChildren.map(c => c.title).join('、')}`
      node.kind = 'executable'
      await commit(node, 'READY', ctx)
      return
    }

    const created = await createChildren(node, lastChildren, ctx)
    if (created.ok) { await commit(node, 'WAITING_CHILDREN', ctx); return }
    // Node-count cap and persist failures are fatal (retrying can't make room or fix the
    // disk); a dependency cycle is a planning mistake the model can correct.
    if (!created.retryable) { await blockWithReason(node, created.reason, ctx); return }
    node.iteration.planReview++
    feedback = created.reason
    if (node.iteration.planReview >= caps.maxIterations) {
      await blockWithReason(node, `拆分迭代超限(${caps.maxIterations}): ${created.reason}`, ctx)
      return
    }
  }
}

type CreateResult = { ok: true } | { ok: false; reason: string; retryable: boolean }

export async function createChildren(node: TaskNode, specs: { title: string; deps: string[] }[], ctx: PipelineCtx): Promise<CreateResult> {
  // Node-count cap: if creating these children would exceed maxNodes, create NONE
  // (never silently truncate). Not retryable — replanning can't create budget.
  // Reserved ATOMICALLY (see PipelineCtx.reserveNodes): the old check compared against
  // byId.size and then awaited before inserting, so two concurrent decompositions both
  // passed against the same stale size and the tree ran past the cap.
  const slots = ctx.reserveNodes(specs.length)
  if (!slots) {
    return { ok: false, reason: '节点数超过上限', retryable: false }
  }
  try {
    // Sibling deps are written as TITLES, so duplicate titles make every reference to them
    // ambiguous — including "does this node depend on itself?". Don't guess: hand it back as
    // a planning error the model can fix, the same way a dependency cycle is handled.
    const titles = specs.map(c => c.title)
    if (new Set(titles).size !== titles.length) {
      return { ok: false, reason: '子任务标题重复,依赖只能按标题引用,请给出互不相同的子任务标题', retryable: true }
    }
    // Map each dep title to the sibling's INDEX; resolving by index (not id) makes the
    // self-reference check exact.
    const titleToIndex = new Map<string, number>()
    specs.forEach((c, i) => titleToIndex.set(c.title, i))
    // Build the group in a LOCAL array first. Nothing touches ctx.byId / node.childIds until
    // the cycle guard passes, so a rejected group leaves ZERO partial state behind.
    const base = node.childIds.length
  const created: TaskNode[] = specs.map((c, i) => {
      // Number AFTER the children this node already has. Restarting at 1 every batch makes
    // childId collide with an existing sibling — and childId's own comment warns that the
    // same (index, title) yields the same id and writeNode would OVERWRITE it. Reproduced:
    // a second batch reusing a title reset an ACCEPTED sibling to CREATED, wiped its
    // execStatus, and rewrote its node.md. That is irreversible loss of real work.
    const id = childId(node.id, base + i + 1, c.title)
      const deps = c.deps
        .map(t => titleToIndex.get(t))
        .filter((di): di is number => di !== undefined && di !== i) // unknown title / self-reference
        .map(di => childId(node.id, base + di + 1, specs[di].title))
      return createNode({
        id,
        title: c.title,
        // Children inherit a COMPOSED goal. A bare title strips all parent context and the
        // child then replans the wrong thing from nothing.
        goal: `${node.goal}\n> 上级方案要点: ${(node.plan.keyPoints || node.plan.solution).slice(0, 500)}\n> 本子任务: ${c.title}`,
        parentId: node.id,
        deps,
        depth: node.depth + 1,
        phaseRoles: node.phaseRoles,
        now: ctx.now(),
      })
    })
    // Cycle guard: sibling deps only reference siblings. A cyclic group is a PLANNING error,
    // so hand it back as retryable feedback instead of killing the branch.
    if (hasCycle(created)) {
      return { ok: false, reason: '子任务依赖成环,请重新给出无环的子任务依赖', retryable: true }
    }
    // Persist the whole group BEFORE attaching any of it. Attaching first and writing inside
    // the loop meant a failure on child 2 of 3 left a half-attached subtree in ctx.byId and
    // node.childIds — the exact partial state the local-array staging above exists to prevent.
    for (const child of created) {
      try {
        await ctx.persist(child)
      } catch (e) {
        return { ok: false, reason: `子节点持久化失败: ${e instanceof Error ? e.message : String(e)}`, retryable: false }
      }
    }
    for (const child of created) {
      ctx.byId.set(child.id, child)
      node.childIds.push(child.id)
    }
    // The parent's own durable point is the commit(WAITING_CHILDREN) that follows.
    safeUpdate(ctx)
    return { ok: true }
  } finally {
    // UNCONDITIONAL. Once the children are in byId they are counted by byId.size, so the
    // reservation is always handed back here. Releasing per-return-path instead would miss
    // the THROW out of the raw ctx.now() inside the specs.map — and a leaked slot
    // permanently overstates the tree, so a LATER decomposition that genuinely fits gets
    // refused and BLOCKED: the safety valve corrupted in the other direction, silently.
    slots.release()
  }
}

function scorePrompt(node: TaskNode, tag: string): string {
  return (
    `请对这个已通过验收的任务打分。\n` +
    `目标:${quote(ctxGoal(node))}\n` +
    `方案:\n${quote(JSON.stringify(node.plan))}\n` +
    `执行结果:\n${quote(node.execStatus)}\n` +
    `输出 json:{ "plan": {"score": 0-100, "rationale": "…"}, "exec": {"score": 0-100, "rationale": "…"} }。` +
    `plan 评方案质量,exec 评执行质量。` +
    answerRule(tag)
  )
}

/**
 * 观察评分(spec §11). Runs after acceptance passes, only when an observer role is bound.
 *
 * Advisory BY DEFAULT: the scores are recorded and nothing else happens. They gate the node
 * only when `caps.scoreThreshold` is set, and then for exactly ONE rework — an advisory
 * number must not be able to spend an unbounded number of write-capable execute calls.
 *
 * Returns true when the node should go back for rework.
 */
async function scoreNode(node: TaskNode, ctx: PipelineCtx): Promise<boolean> {
  const role = firstRole(node, 'observer')
  if (!role) return false // opt-in: no observer, no scoring, no fallback to the main model
  const tag = answerTag(ANSWER_TAGS.score)
  const res = await runPhase(ctx, {
    phase: 'observer', node, role, system: 'observer', prompt: scorePrompt(node, tag), signal: ctx.signal,
    cwd: node.worktree?.path,
  })
  if (!res.ok) {
    // A failed scoring call must NOT fail the node: acceptance already passed, and scoring is
    // advisory. Record why the number is missing instead of discarding hours of accepted work.
    node.score = {
      plan: { role: role.roleName, score: 0, rationale: `评分调用失败: ${res.reason}` },
      exec: { role: role.roleName, score: 0, rationale: `评分调用失败: ${res.reason}` },
    }
    return false
  }
  const parsed = parseScoreOutput(res.text, tag)
  node.score = {
    plan: { role: role.roleName, score: parsed.plan.score, rationale: parsed.plan.rationale },
    exec: { role: role.roleName, score: parsed.exec.score, rationale: parsed.exec.rationale },
  }
  const threshold = ctx.config.caps.scoreThreshold
  if (threshold === undefined) return false // 默认仅记录
  const worst = Math.min(parsed.plan.score, parsed.exec.score)
  if (worst >= threshold) return false
  // Exactly one rework, then the score is recorded and the node proceeds regardless.
  if (node.iteration.scoring >= 1) return false
  node.iteration.scoring += 1
  return true
}

/**
 * 动态生长(spec §4):an executing node grafts children onto ANY node of the tree.
 *
 * Every rule here exists because the target is named by a MODEL, in text, at runtime:
 *  - unknown id → refused; creating it anyway would invent a parent.
 *  - TERMINAL target → refused. An ACCEPTED node already has a passing verdict on record,
 *    and reopening it would make that verdict describe work it never saw. A BLOCKED one is
 *    dead and its subtree is not scheduled.
 *  - depth cap → refused per target, so one bad spec cannot sink the whole batch.
 *  - node cap → left to createChildren's atomic reservation, untouched here.
 *
 * Refusals are REPORTED back into execStatus rather than silently dropped: the executor
 * believes it queued that work, and a growth request that vanishes without trace is the
 * same "said one thing, did another" failure this project keeps paying for.
 */
async function growTree(
  node: TaskNode,
  specs: { parent?: string; title: string; deps: string[] }[],
  ctx: PipelineCtx,
): Promise<{ grown: string[]; refusals: string[] }> {
  const grown: string[] = []
  const refusals: string[] = []
  // Group by target so each target's children are created as ONE batch: createChildren
  // resolves sibling deps by title WITHIN a batch, so splitting them would break the links.
  const byTarget = new Map<string, { title: string; deps: string[] }[]>()
  for (const spec of specs) {
    const targetId = spec.parent ?? node.id
    byTarget.set(targetId, [...(byTarget.get(targetId) ?? []), { title: spec.title, deps: spec.deps }])
  }
  for (const [targetId, kids] of byTarget) {
    const target = ctx.byId.get(targetId)
    if (!target) { refusals.push(`目标节点不存在: ${quote(targetId)}`); continue }
    // A target must be SAFE to graft onto. Blocking only terminal states was not enough
    // (reproduced): grafting onto a CREATED/READY node overwrote its status and kind, so its
    // own plan and execute phases were deleted outright — and because advanceableKind's
    // WAITING_CHILDREN branch does not consult depsSatisfied, that node then advanced with
    // its dependencies still unmet. The safe set is: the executing node itself, or a node
    // that is already waiting on children.
    if (isTerminal(target.status)) {
      refusals.push(`目标节点 ${quote(targetId)} 已是终态(${target.status}),不能再加子节点`)
      continue
    }
    if (target.id !== node.id && target.status !== 'WAITING_CHILDREN') {
      refusals.push(
        `目标节点 ${quote(targetId)} 当前是 ${target.status},尚未走完自己的方案/执行阶段;` +
        `向它插子节点会顶掉那些阶段,请改为挂到本节点下,或等它进入 WAITING_CHILDREN`,
      )
      continue
    }
    if (target.depth + 1 > ctx.config.caps.maxDepth) {
      refusals.push(`目标节点 ${quote(targetId)} 已达深度上限 ${ctx.config.caps.maxDepth}`)
      continue
    }
    const res = await createChildren(target, kids, ctx)
    if (!res.ok) { refusals.push(`向 ${quote(targetId)} 加子节点失败: ${res.reason}`); continue }
    // The target now has unfinished children, so it must wait — including when the target IS
    // the executing node, which is exactly the spec's "父节点转 WAITING_CHILDREN,待新子节点
    // ACCEPTED 后恢复". kind becomes decompose so the state machine routes it to integration
    // rather than re-executing it.
    target.kind = 'decompose'
    if (!(await commit(target, 'WAITING_CHILDREN', ctx))) {
      refusals.push(`向 ${quote(targetId)} 加子节点后落盘失败`)
      continue
    }
    grown.push(targetId)
  }
  return { grown, refusals }
}

/**
 * Merge the node's worktree into the integration branch, then release it.
 *
 * Returns false when the node must NOT be accepted — a conflict or an infrastructure failure.
 * A conflict keeps the worktree: it is the only place the user can fix it, and the reason
 * carries the path, branch and files so they can act without hunting.
 *
 * An un-isolated run short-circuits to true: there is nothing to merge, the executor wrote
 * straight into the shared tree.
 */
async function mergeAndRelease(node: TaskNode, ctx: PipelineCtx, triedThisRun = false): Promise<boolean> {
  if (!ctx.worktrees || !node.worktree) return true
  const res = await ctx.worktrees.commitAndMerge(node)
  if (!res.ok) {
    if (res.kind === 'conflict') {
      // A cancel must never page a human. The user is standing at the keyboard; the node is
      // reopened by --resume on its own, and a card saying "现已暂停等待人工" would contradict
      // the run's own "已取消" in the same second.
      if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return false }

      // spec §8: 触发一次"合并解决". Bounded to one — an unbounded loop spends write-capable
      // calls on a merge that keeps failing, each attempt starting from a tree the last one
      // already edited. Tested BEFORE the increment, so a resumed node gets no second attempt.
      let attempted = triedThisRun
      if (node.iteration.mergeResolve < 1) {
        node.iteration.mergeResolve += 1
        // Put the conflict INTO this node's own worktree first. Without this the resolver is
        // sent to a clean directory (see mergeIntegrationIntoNode) and can only pretend.
        const local = await ctx.worktrees.mergeIntegrationIntoNode(node)
        if (!local.ok) {
          await blockWithReason(node, `合并失败(基础设施):无法在节点工作区重现冲突: ${local.message}`, ctx)
          return false
        }
        if (!local.conflicted) {
          // The other side moved on and the merge is now clean — nothing to resolve. Retry.
          return mergeAndRelease(node, ctx, true)
        }
        const tag = answerTag(ANSWER_TAGS.exec)
        const resolve = await runPhase(ctx, {
          phase: 'execute', node, role: firstRole(node, 'execute'), system: 'execute',
          prompt:
            `已把集成分支 ${quote(ctx.worktrees.integrationBranchName)} 合并进你的工作区,产生了冲突。` +
            `当前工作目录里就是冲突现场(带 <<<<<<< / >>>>>>> 标记)。\n` +
            `请解决冲突,保留双方的意图,不要简单丢弃任何一边;解决后 git add 冲突文件即可,不要提交。\n` +
            `冲突文件:\n${local.files.map(f => '- ' + quote(f)).join('\n')}\n` +
            `解决后输出:{ "execStatus":"如何解决的" }。` + answerRule(tag),
          cwd: node.worktree.path, signal: ctx.signal,
        })
        // Set only once the executor has actually been asked. Setting it on entry made the
        // card claim an attempt on the branch that recurses without ever calling the model.
        attempted = true
        // The resolve call is the longest window in this path (a write-capable model call with
        // the node timeout). An abort landing inside it arrived here with no check and fell
        // straight through to onEscalate: the run said 已取消 while the card said 等待人工.
        if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return false }
        if (!resolve.ok) {
          // Record WHY. Every other runPhase failure in this file reports its reason; letting
          // this one fall silently into the generic conflict message hid timeouts entirely.
          node.execStatus = `${node.execStatus}\n(自动解决冲突未能完成: ${resolve.reason})`
        } else {
          node.execStatus = `${node.execStatus}\n(合并冲突解决)${parseExecOutput(resolve.text, tag).execStatus}`
          if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return false }
          // 重跑验收 (spec §8, second half). A conflict resolution is NEW CODE nobody has
          // reviewed — it chose, by hand, which side of every hunk survives. Merging it on the
          // strength of the ORIGINAL acceptance would make the edit likeliest to silently drop
          // a feature the one edit nobody checks.
          //
          // Round number from the LOG's length, not from iteration.acceptance.
          //
          // Incrementing the counter looked equivalent and was not: reseat charges a resumed
          // node's re-entry against iteration.acceptance and refuses at maxIterations, so a
          // node that had used its normal rounds became un-resumable the moment it hit a
          // conflict — measured "恢复时该阶段预算已耗尽(3/3)" on a node whose card had just
          // told the user to resume it. The rework budget must mean rework.
          const { rec, infraExhausted } = await roundtableWithInfraRetry({
            phase: 'accept', node, roles: node.phaseRoles.accept, round: node.acceptLog.length + 1,
            system: 'accept', buildPrompt: t => acceptPrompt(node, t), ctx, cwd: node.worktree.path,
          })
          node.acceptLog.push(rec)
          if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return false }
          if (!infraExhausted && rec.synthesized.pass) return mergeAndRelease(node, ctx, true)
          node.execStatus = `${node.execStatus}\n(冲突解决后验收未通过: ${rec.synthesized.blockingSummary || '验收角色调用失败'})`
        }
      }
      // MEASURE the worktree instead of asserting anything about it. A blanket re-merge here
      // was wrong: on the primary path the worktree already holds a STAGED resolution that
      // acceptance rejected, and merging would have committed exactly that.
      // Only the two booleans travel: conflictState also returns its own file list, and
      // shipping both would put two different answers to "which files" on one card.
      let state = { markers: false, staged: false, stale: false }
      // res.files is whatever the FIRST merge attempt reported and is stale by construction:
      // on the marker-scan path it is every file the branch touches, so a card listed two
      // untouched files as 冲突文件. Prefer the measurement; fall back only if it fails.
      let files = res.files
      try {
        const probed = await ctx.worktrees.conflictState(node)
        state = { markers: probed.markers, staged: probed.staged, stale: probed.stale === true }
        if (probed.files.length > 0) files = probed.files
      } catch { /* describe what we already know rather than swallowing the escalation */ }
      // Marks this as a HUMAN-RESUMABLE block. Without it reseat skips the node on every
      // later --resume, which made the escalation card's instructions untrue.
      node.mergeConflict = true
      const detail = `合并冲突,已保留工作区待人工处理。分支 ${node.worktree.branch};路径 ${node.worktree.path};冲突文件: ${files.join('、')}`
      // Escalate BEFORE blocking, so the card carries the same facts the tree will show.
      // `attempted` is threaded through the recursion rather than derived from
      // iteration.mergeResolve, which is PERSISTED: a node resumed with its one attempt
      // already spent makes none this run, and a card claiming "已自动尝试解决一次" would be
      // describing something that happened in a previous session — or, after an interrupt,
      // something that never finished at all.
      try {
        ctx.onEscalate?.({ node, branch: node.worktree.branch, path: node.worktree.path, files, attempted, state, integrationBranch: ctx.worktrees.integrationBranchName })
      } catch { /* a notification failure must not change the run's verdict */ }
      await blockWithReason(node, detail, ctx)
      return false
    }
    await blockWithReason(node, `合并失败(基础设施): ${res.message}`, ctx)
    return false
  }
  // The pool is the ONLY component that knows whether this node contributed a commit.
  // Discarding that answer let a node that wrote nothing — while reporting "已实现并自测通过"
  // — reach ACCEPTED with the integration branch byte-identical to base, and nothing anywhere
  // recorded it. Put it in the evidence the acceptance record keeps.
  if (!res.merged) {
    node.execStatus = `${node.execStatus}\n(注:该节点没有向集成分支贡献任何改动)`
  }
  const rel = await ctx.worktrees.release(node)
  // A kept worktree is NOT a failure — release refuses to delete anything holding real work.
  // Record it so the user can find it rather than discovering a stray directory later.
  if (!rel.removed && rel.keptBecause) {
    node.execStatus = `${node.execStatus}\n(注:隔离工作区已保留 —— ${rel.keptBecause};路径 ${node.worktree.path})`
  }
  return true
}

export async function stepExecute(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  // Isolation is a HARD gate, not a preference. Without a worktree this node would execute
  // with write tools in the user's real checkout — concurrently with others once the execute
  // mutex is lifted. Refusing is the only safe answer; the run degrades node by node, and
  // says so, instead of silently writing where it promised not to.
  if (ctx.worktrees && !node.worktree) {
    const lease = await ctx.worktrees.acquire(node)
    if ('error' in lease) {
      await blockWithReason(node, `无法为该节点准备隔离工作区,拒绝在共享工作区执行: ${lease.error}`, ctx)
      return
    }
    node.worktree = { branch: lease.branch, path: lease.path }
  }
  // 人工解决冲突后的续跑 (spec §8 "等人工处理" → the user acts → `/et --resume`).
  //
  // Re-enters at ACCEPTANCE, never at execute: the human already did the work, and re-running
  // the executor would overwrite their resolution with a fresh attempt at the same conflict.
  // Their edit is also NEW, UNREVIEWED CODE that chose by hand which side of every hunk
  // survives — so it is judged before it merges, exactly as an auto-resolution is.
  if (node.mergeConflict && node.worktree) {
    node.mergeConflict = false
    if (!(await commit(node, 'ACCEPTANCE', ctx))) return
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      // acceptLog.length + 1, like the other conflict path. iteration.acceptance is never
      // incremented on either, so using it here reproduced a round number already in the log:
      // 验收记录 rendered 第 2 轮 twice, once before and once after 第 3 轮 — and the card sends
      // the user to exactly that record.
      phase: 'accept', node, roles: node.phaseRoles.accept, round: node.acceptLog.length + 1,
      system: 'accept', buildPrompt: t => acceptPrompt(node, t), ctx, cwd: node.worktree.path,
    })
    node.acceptLog.push(rec)
    if (!infraExhausted && rec.synthesized.pass) {
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    // No REWORK: a human is in this loop, and sending their resolution back to the executor
    // would discard it. Block again with what the reviewers actually said.
    // Keep the flag: the user can revise their resolution and resume again. Clearing it made
    // this a dead end — reseat skipped the node forever and no second card was ever sent.
    node.mergeConflict = true
    // Send a card here as well. Keeping the node resumable without telling anyone left the
    // user waiting on a run that was waiting on them.
    try {
      ctx.onEscalate?.({
        node, branch: node.worktree.branch, path: node.worktree.path, files: [],
        attempted: false, state: { markers: false, staged: true, stale: false },
        integrationBranch: ctx.worktrees?.integrationBranchName,
      })
    } catch { /* a notification failure must not change the run's verdict */ }
    await blockWithReason(node, `人工解决冲突后验收未通过: ${rec.synthesized.blockingSummary || '验收角色调用失败'}`, ctx)
    return
  }
  const caps = ctx.config.caps
  // previous round's acceptance blockingSummary; drives the REWORK prompt. Seeded from the
  // persisted log so a resumed node does not repeat work that was already rejected.
  let feedback = lastFailureFeedback(node.acceptLog)
  let emptyReports = 0
  for (;;) {
    if (!(await commit(node, 'EXECUTING', ctx))) return
    // node.execStatus still holds the PREVIOUS round's result here (it's overwritten below),
    // which is exactly what executePrompt renders on rework.
    const execTag = answerTag(ANSWER_TAGS.exec)
    const res = await runPhase(ctx, { phase: 'execute', node, role: firstRole(node, 'execute'), system: 'execute', prompt: executePrompt(node, ctx, execTag, feedback), cwd: node.worktree?.path, signal: ctx.signal })
    if (!res.ok) {
      // Keep whatever the executor managed to report before the interruption. It ran with
      // write tools, so discarding this can leave the repo changed with no record of it.
      const partial = res.text ? parseExecOutput(res.text, execTag).execStatus.trim() : ''
      if (partial) node.execStatus = `${partial}\n(注:本轮在完成前被中断,以上为中断时已报告的产出)`
      await blockWithReason(node, res.reason, ctx)
      return
    }
    const out = parseExecOutput(res.text, execTag)
    const reported = out.execStatus.trim()
    // An executor that reports NOTHING has evidenced nothing. Sending a blank execStatus
    // into acceptance asks the reviewers to bless an empty slot — the one way a node can
    // reach ACCEPTED without any work having happened. Treat it as a failed round.
    if (reported === '') {
      emptyReports++
      node.iteration.acceptance++
      if (node.iteration.acceptance >= caps.maxIterations) {
        await blockWithReason(node, `执行阶段未报告任何产出(第 ${emptyReports} 次),已达迭代上限 ${caps.maxIterations}`, ctx)
        return
      }
      feedback = '上一轮执行没有报告任何产出。请真正执行任务,并在 execStatus 里写明具体做了什么、结果如何。'
      if (!(await commit(node, 'REWORK', ctx))) return
      continue
    }
    node.execStatus = reported

    // 动态生长(spec §4):honoured AFTER the empty-report gate, so a reply that grafts nodes
    // but evidences no work still counts as an empty round rather than buying a free pass.
    if (out.newChildren.length > 0) {
      const { grown, refusals } = await growTree(node, out.newChildren, ctx)
      if (refusals.length > 0) {
        // Append, never replace: execStatus is the executor's own record of what it did, and
        // a growth request that vanished without trace is the same "said one thing, did
        // another" failure this project keeps paying for.
        node.execStatus = `${reported}\n(注:以下加子节点请求被拒绝)\n${refusals.map(r => '- ' + r).join('\n')}`
      }
      // If the EXECUTING node itself grew children it is now WAITING_CHILDREN, and its own
      // acceptance must wait for them. Returning here is what the spec's "恢复" means: the
      // scheduler picks it up again for integration once every child is ACCEPTED.
      if (grown.includes(node.id)) {
        // This node now waits on children, and stepIntegrate will later accept it — a path
        // that never passes through the merge above. Its worktree holds the executor's real
        // writes, so merge NOW or that work never reaches the integration branch at all.
        if (!(await mergeAndRelease(node, ctx))) return
        await ctx.persist(node)
        safeUpdate(ctx)
        return
      }
    }

    // Acceptance. Reviewer-CALL failures retry the roundtable on their own budget (see
    // roundtableWithInfraRetry) — redoing the executor's real work over a flaky connection
    // would be wrong, and charging those retries to the rework budget would consume every
    // attempt the executor was owed.
    if (!(await commit(node, 'ACCEPTANCE', ctx))) return
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1,
      system: 'accept', buildPrompt: tag => acceptPrompt(node, tag), ctx, cwd: node.worktree?.path,
    })
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody ever judged the work — say that, rather than blaming the work.
      await blockWithReason(node, `验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    if (rec.synthesized.pass) {
      // 观察评分 runs between acceptance and ACCEPTED (spec §8: 验收 + 评分通过后进入 MERGE).
      const needsRework = await scoreNode(node, ctx)
      if (needsRework) {
        feedback = `观察角色评分低于阈值,请针对性改进后重新提交。\n方案 ${node.score.plan?.score}: ${node.score.plan?.rationale}\n执行 ${node.score.exec?.score}: ${node.score.exec?.rationale}`
        if (!(await commit(node, 'REWORK', ctx))) return
        continue
      }
      // MERGE is the last step before ACCEPTED (spec §8: 验收 + 评分通过后进入 MERGE).
      // It runs AFTER scoring on purpose: scoring can send the node back to REWORK, and a
      // node that had already merged would then be reworking on top of work the integration
      // branch has taken — with its worktree possibly already released.
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    node.iteration.acceptance++
    if (node.iteration.acceptance >= caps.maxIterations) {
      await blockWithReason(node, `验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    // Keep the REAL blockers: overwriting them with a generic message would send the rework
    // prompt back without the reason the work was actually rejected.
    feedback = rec.synthesized.blockingSummary
    if (!(await commit(node, 'REWORK', ctx))) return
  }
}

export async function stepIntegrate(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
  // Same bounded-retry shape as stepExecute: a single failed integration verdict must not
  // be terminal (the roundtable may simply have misread the evidence). Uses its OWN budget
  // so a node that spent `acceptance` elsewhere still gets a full integration allowance.
  for (;;) {
    if (!(await commit(node, 'INTEGRATION_ACCEPT', ctx))) return
    // Hold the integration worktree for the whole review: it is what the reviewers read, and
    // concurrent merges rewrite it underneath them.
    const runIntegrate = async () => roundtableWithInfraRetry({
      phase: 'accept', node, roles: node.phaseRoles.accept,
      round: node.iteration.integration + 1, system: 'integrate',
      buildPrompt: tag => integratePrompt(node, ctx, tag, feedback), // child evidence, NOT acceptPrompt
      ctx,
      // The INTEGRATION worktree, not the user's tree. This roundtable accepts every
      // decompose node — including root, i.e. the run's final verdict — and under isolation
      // the user's checkout contains none of the run's work.
      cwd: ctx.worktrees?.integrationPath,
    })
    const { rec, infraExhausted } = ctx.worktrees
      ? await ctx.worktrees.withIntegrationRead(runIntegrate)
      : await runIntegrate()
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // A decompose node whose children ALL succeeded must not be thrown away because the
      // reviewer's connection failed three times.
      await blockWithReason(node, `集成验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
    node.iteration.integration++
    if (node.iteration.integration >= caps.maxIterations) {
      await blockWithReason(node, `集成验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    feedback = rec.synthesized.blockingSummary
  }
}
