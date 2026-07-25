// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode } from './types.js'
import { ANSWER_TAGS, parseExecOutput, parsePlanOutput, type AnswerTag } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle } from './stateMachine.js'

export interface PipelineCtx {
  config: EffTaskConfig
  byId: Map<string, TaskNode>
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  signal: AbortSignal
  onUpdate: () => void
}

async function commit(node: TaskNode, status: TaskNode['status'], ctx: PipelineCtx): Promise<void> {
  node.status = status
  node.updatedAt = ctx.now()
  await ctx.persist(node)
  ctx.onUpdate()
}

type PhaseResult = { ok: true; text: string } | { ok: false; reason: string }
// Wraps a direct runAgent phase call (plan/execute). A throw OR an abort observed
// after the call yields ok:false with a reason; the caller hands it to blockWithReason,
// which records it into node.blockedReason and BLOCKs the node.
async function runPhase(ctx: PipelineCtx, req: Parameters<RunAgentFn>[0]): Promise<PhaseResult> {
  try {
    const text = await ctx.runAgent(req)
    if (ctx.signal.aborted) return { ok: false, reason: '已中断' }
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

// A node with deps must SEE what its dependencies produced, otherwise it replans from
// scratch and redoes upstream work.
function depsSection(node: TaskNode, ctx: PipelineCtx): string {
  if (node.deps.length === 0) return ''
  const lines = node.deps.map(id => {
    const d = ctx.byId.get(id)
    return d ? `- ${d.title}(${d.status}): ${d.execStatus || '(尚无执行状态)'}` : `- ${id}: (依赖节点缺失)`
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
function answerRule(tag: AnswerTag): string {
  return (
    `\n\n严格要求:把本次回答放进一个 \`\`\`${tag} 代码块里,整条回复中只能有这一个 ` +
    `\`\`\`${tag} 块,且必须位于回复的最末尾。引用上下文请用普通的 \`\`\`json 块。`
  )
}

function planPrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  const caps = ctx.config.caps
  return (
    `任务:${node.title}\n目标:${ctxGoal(node)}\n` +
    depsSection(node, ctx) +
    // The depth budget lives IN THE PROMPT so the model self-limits, instead of us
    // silently discarding the children it asked for once it hits the cap.
    `当前深度 ${node.depth}/上限 ${caps.maxDepth};已达上限时必须返回 kind=executable,不得再拆分。\n` +
    (feedback
      ? `上一版方案(就是它需要被修订):\n${JSON.stringify(node.plan)}\n上一轮评审阻断意见,请针对性修订:\n${feedback}\n`
      : '') +
    `请输出一个 json 代码块:{ "kind":"decompose"|"executable", "solution", "keyPoints", "risks", "acceptance", "children":[{"title","deps":["兄弟标题"]}] }。` +
    `能直接完成就 executable(children 省略);需要拆分就 decompose 并给出子任务标题与兄弟间依赖。` +
    answerRule(ANSWER_TAGS.plan)
  )
}
// Reference the IMMUTABLE node goal (set at creation), not the mutable plan.solution —
// otherwise the goal drifts every time the plan is re-emitted during review iterations.
function ctxGoal(node: TaskNode): string { return node.goal }

function reviewPrompt(node: TaskNode): string {
  return `请评审以下方案是否可执行、完整、无重大风险。方案:\n${JSON.stringify(node.plan)}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。有任何阻断问题填入 blocking。` + answerRule(ANSWER_TAGS.verdict)
}
function executePrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  return (
    `按以下方案执行任务并完成实际改动。方案:\n${JSON.stringify(node.plan)}\n` +
    depsSection(node, ctx) +
    // REWORK path: show the acceptance blockers AND what the previous round already did,
    // so the rerun is a targeted fix rather than a blind repeat.
    (feedback
      ? `上一轮验收未通过,阻断意见:\n${feedback}\n上一轮执行状态:\n${node.execStatus}\n请针对性返工。\n`
      : '') +
    `完成后输出:{ "execStatus":"做了什么、结果如何" }。` + answerRule(ANSWER_TAGS.exec)
  )
}
function acceptPrompt(node: TaskNode): string {
  return `请验收执行结果是否达成验收点。验收点:${node.plan.acceptance}\n执行状态:${node.execStatus}\n输出:{ "pass":boolean, "blocking":string[], "comments":string }。` + answerRule(ANSWER_TAGS.verdict)
}
// Integration acceptance judges CHILD evidence against the parent goal. acceptPrompt would
// show only the parent's own execStatus — which for a decompose node is empty.
function integratePrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  const children = node.childIds
    .map(id => ctx.byId.get(id))
    .filter((c): c is TaskNode => c !== undefined)
    .map(c => `### ${c.title}\n- 状态: ${c.status}\n- 执行状态: ${c.execStatus || '(无)'}\n- 验收点: ${c.plan.acceptance || '(无)'}`)
    .join('\n')
  return (
    `请验收"全部子任务的结果合起来是否达成本节点目标"。\n` +
    `父目标:${ctxGoal(node)}\n父验收点:${node.plan.acceptance || '(无)'}\n\n` +
    `子任务结果:\n${children || '(无子任务)'}\n\n` +
    (feedback ? `上一轮集成验收阻断意见,请复核是否已解决:\n${feedback}\n\n` : '') +
    `输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(ANSWER_TAGS.verdict)
  )
}

function firstRole(node: TaskNode, phase: 'plan' | 'execute') {
  return node.phaseRoles[phase][0] ?? null
}

export async function stepStart(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
  // plan → review loop. A rejected child GROUP (dependency cycle) re-enters this same
  // loop, so replanning is bounded by the SAME maxIterations budget — a cycle costs a
  // retry, it does not instantly kill the run.
  for (;;) {
    await commit(node, 'PLANNING', ctx)
    const res = await runPhase(ctx, { phase: 'plan', node, role: firstRole(node, 'plan'), system: 'plan', prompt: planPrompt(node, ctx, feedback), signal: ctx.signal })
    if (!res.ok) { await blockWithReason(node, res.reason, ctx); return }
    const parsed = parsePlanOutput(res.text)
    node.kind = parsed.kind
    node.plan = parsed.plan
    const lastChildren = parsed.children
    await commit(node, 'PLAN_REVIEW', ctx)
    const rec = await runRoundtable({ phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1, system: 'review', prompt: reviewPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
    node.reviewLog.push(rec)
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
      if (lastChildren.length > 0) {
        node.plan.solution += `\n\n已达最大深度,不得再拆分,请在本节点内依次完成:${lastChildren.map(c => c.title).join('、')}`
      }
      node.kind = 'executable'
      await commit(node, 'READY', ctx)
      return
    }

    const created = await createChildren(node, lastChildren, ctx)
    if (created.ok) { await commit(node, 'WAITING_CHILDREN', ctx); return }
    // Node-count cap is fatal (retrying can't make room); a dependency cycle is not.
    if (!created.retryable) { await blockWithReason(node, created.reason, ctx); return }
    node.iteration.planReview++
    feedback = created.reason
    if (node.iteration.planReview >= caps.maxIterations) {
      await blockWithReason(node, `评审迭代超限(${caps.maxIterations}): ${created.reason}`, ctx)
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
  // child.deps reference SIBLING TITLES; map each to the sibling's id (drop unknown titles).
  // NOTE: duplicate child titles bind dep-by-title to the LAST duplicate (minor, accepted).
  const titleToId = new Map<string, string>()
  specs.forEach((c, i) => titleToId.set(c.title, childId(node.id, i + 1, c.title)))
  // Build the group in a LOCAL array first. Nothing touches ctx.byId / node.childIds until
  // the cycle guard passes, so a rejected group leaves ZERO partial state behind.
  const created: TaskNode[] = specs.map((c, i) => {
    const id = childId(node.id, i + 1, c.title)
    // map sibling titles → ids; drop unknown titles AND any self-reference (child depping on itself).
    const deps = c.deps.map(t => titleToId.get(t)).filter((x): x is string => !!x && x !== id)
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
  for (const child of created) {
    ctx.byId.set(child.id, child)
    node.childIds.push(child.id)
    await ctx.persist(child)
  }
  await ctx.persist(node)
  ctx.onUpdate()
  return { ok: true }
}

export async function stepExecute(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = '' // previous round's acceptance blockingSummary; drives the REWORK prompt
  for (;;) {
    await commit(node, 'EXECUTING', ctx)
    // node.execStatus still holds the PREVIOUS round's result here (it's overwritten below),
    // which is exactly what executePrompt renders on rework.
    const res = await runPhase(ctx, { phase: 'execute', node, role: firstRole(node, 'execute'), system: 'execute', prompt: executePrompt(node, ctx, feedback), cwd: node.worktree?.path, signal: ctx.signal })
    if (!res.ok) { await blockWithReason(node, res.reason, ctx); return }
    node.execStatus = parseExecOutput(res.text).execStatus
    await commit(node, 'ACCEPTANCE', ctx)
    const rec = await runRoundtable({ phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1, system: 'accept', prompt: acceptPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
    node.acceptLog.push(rec)
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
    node.iteration.acceptance++
    if (node.iteration.acceptance >= caps.maxIterations) {
      await blockWithReason(node, `验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    feedback = rec.synthesized.blockingSummary
    await commit(node, 'REWORK', ctx)
  }
}

export async function stepIntegrate(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
  // Same bounded-retry shape as stepExecute: a single failed integration verdict must not
  // be terminal (the roundtable may simply have misread the evidence).
  for (;;) {
    await commit(node, 'INTEGRATION_ACCEPT', ctx)
    const rec = await runRoundtable({
      phase: 'accept', node, roles: node.phaseRoles.accept,
      round: node.iteration.acceptance + 1, system: 'integrate',
      prompt: integratePrompt(node, ctx, feedback), // child evidence, NOT acceptPrompt
      runAgent: ctx.runAgent, signal: ctx.signal,
    })
    node.acceptLog.push(rec)
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
    node.iteration.acceptance++
    if (node.iteration.acceptance >= caps.maxIterations) {
      await blockWithReason(node, `集成验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    feedback = rec.synthesized.blockingSummary
  }
}
