// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, RoleBinding, RoundtableRecord, TaskNode } from './types.js'
import { createNode } from './types.js'
import { ANSWER_TAGS, answerTag, parseExecOutput, parsePlanOutput } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle, isTerminal } from './stateMachine.js'

export interface PipelineCtx {
  config: EffTaskConfig
  byId: Map<string, TaskNode>
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  signal: AbortSignal
  onUpdate: () => void
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
      runAgent: args.ctx.runAgent, signal: args.ctx.signal, answerTag: tag,
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
    // REWORK path: show the acceptance blockers AND what the previous round already did,
    // so the rerun is a targeted fix rather than a blind repeat.
    (feedback
      ? `上一轮验收未通过,阻断意见:\n${quote(feedback)}\n上一轮执行状态:\n${quote(node.execStatus)}\n请针对性返工。\n`
      : '') +
    `完成后输出:{ "execStatus":"做了什么、结果如何" }。` + answerRule(tag)
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

export async function stepStart(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
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

async function createChildren(node: TaskNode, specs: { title: string; deps: string[] }[], ctx: PipelineCtx): Promise<CreateResult> {
  // Node-count cap: if creating these children would exceed maxNodes, create NONE
  // (never silently truncate). Not retryable — replanning can't create budget.
  if (ctx.byId.size + specs.length > ctx.config.caps.maxNodes) {
    return { ok: false, reason: '节点数超过上限', retryable: false }
  }
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
  const created: TaskNode[] = specs.map((c, i) => {
    const id = childId(node.id, i + 1, c.title)
    const deps = c.deps
      .map(t => titleToIndex.get(t))
      .filter((di): di is number => di !== undefined && di !== i) // unknown title / self-reference
      .map(di => childId(node.id, di + 1, specs[di].title))
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
}

export async function stepExecute(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = '' // previous round's acceptance blockingSummary; drives the REWORK prompt
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
    const reported = parseExecOutput(res.text, execTag).execStatus.trim()
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

    // Acceptance. Reviewer-CALL failures retry the roundtable on their own budget (see
    // roundtableWithInfraRetry) — redoing the executor's real work over a flaky connection
    // would be wrong, and charging those retries to the rework budget would consume every
    // attempt the executor was owed.
    if (!(await commit(node, 'ACCEPTANCE', ctx))) return
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1,
      system: 'accept', buildPrompt: tag => acceptPrompt(node, tag), ctx,
    })
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody ever judged the work — say that, rather than blaming the work.
      await blockWithReason(node, `验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
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
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'accept', node, roles: node.phaseRoles.accept,
      round: node.iteration.integration + 1, system: 'integrate',
      buildPrompt: tag => integratePrompt(node, ctx, tag, feedback), // child evidence, NOT acceptPrompt
      ctx,
    })
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
