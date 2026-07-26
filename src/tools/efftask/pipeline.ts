// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, PhaseName, RoleBinding, RoundtableRecord, TaskNode } from './types.js'
import { roleBriefFor } from './roleDefs.js'
import { createNode } from './types.js'
import { ANSWER_TAGS, answerTag, capText, MAX_FIELD_CHARS, parseExecOutput, parsePlanOutput, parseScoreOutput, MAX_REMEDY_CHILDREN } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle, isTerminal } from './stateMachine.js'
import type { WorktreePool } from './worktreePool.js'
import type { SlotPool } from './slotPool.js'
import { blockReasonWithRemedy, type BlockCategory } from './escalation.js'
import { PhaseTimeoutError } from './runAgentAdapter.js'

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
  /**
   * 触阀升级 (spec §9/§11): a node stopped because a SAFETY VALVE tripped.
   *
   * Separate from onEscalate because the two carry different facts and prescribe different
   * actions — a conflict hands the user a worktree to fix, a valve asks whether to spend more
   * budget. Sharing one payload would have meant one card describing both, with half its
   * fields empty for whichever case it wasn't.
   */
  onBlocked?: (info: { node: TaskNode; reason: string; category: BlockCategory; stopped?: boolean }) => void
  /**
   * The run id, when the caller knows it.
   *
   * Only used to write actionable text — the record path and the retry command — into
   * `blockedReason`, which is what run.md renders. Optional because every test builds a ctx
   * by hand; absent, the text degrades to a placeholder rather than to nothing.
   */
  runId?: string
  /**
   * 子 agent 实时输出 (spec §10.2). Every phase call streams its assistant messages here,
   * tagged with the node they belong to.
   *
   * The plumbing already existed and was tested — `RunAgentFn` has taken an `onChunk` since
   * P1 and runAgentAdapter implements it — but NOTHING in production ever passed one, so the
   * detail view had no output to show. A declared-and-implemented-and-tested parameter with
   * no caller is exactly the dead wire this project keeps finding.
   */
  onChunk?: (nodeId: string, text: string) => void
  /**
   * 全局并发池 (spec §6): "评审/验收的多角色调用…受同一全局池约束,避免总并发爆炸".
   *
   * The step already holds a slot; the roundtable's extra reviewers lease from the same pool,
   * so the number at the confirmation gate is the real ceiling rather than a per-step one.
   */
  slots?: SlotPool
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
/**
 * Statuses that mean the node is doing work, not waiting for its turn.
 *
 * SCORING and MERGE belong here and were missing, which cost 各阶段耗时 38% of a measured
 * lifecycle: SCORING runs a full observer model call (`scoreNode`), and MERGE runs a real git
 * merge plus, on conflict, another WRITE-CAPABLE execute call to resolve it. Leaving them out
 * put that time in nobody's column, so the detail pane printed a 240s aggregate above a
 * per-phase list summing to 150s — two numbers on one screen contradicting each other.
 *
 * Three things already treated them as active while this list did not: `reseat.ts`'s own
 * ACTIVE set contains both, spec §10.1 colours them 运行中, and `NodeDetail`'s label map had
 * entries for both — labels production could never emit. The comment on the SCORING commit
 * even says it exists because "a user watching a node sit for minutes could not tell which of
 * the three it was in", which is precisely the question 各阶段耗时 answers.
 *
 * `startedAt` reads this set too, and is unaffected: both statuses are only ever reached after
 * ACCEPTANCE or INTEGRATION_ACCEPT, so the first-active stamp has already happened.
 */
const ACTIVE_STATUSES = new Set([
  'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'ACCEPTANCE', 'REWORK', 'INTEGRATION_ACCEPT',
  'SCORING', 'MERGE',
])

async function commit(node: TaskNode, status: TaskNode['status'], ctx: PipelineCtx): Promise<boolean> {
  /**
   * 各阶段耗时 (spec §10.2 lists it among what the node detail view must show).
   *
   * Accumulated on the way OUT of a status, measured from `updatedAt` — which every commit
   * and every reseat already stamps. That is a correctness choice, not a convenience one: a
   * dedicated "phase entered at" timestamp would keep running across a crash, so the hours
   * while the terminal was closed would be booked to whichever phase happened to be in
   * flight. That is precisely the defect that made the resume gate render 48 hours of
   * "runtime" beside a queued node. reseat re-stamps `updatedAt`, so downtime lands in
   * nobody's column.
   *
   * Only ACTIVE statuses are counted. Time at READY or WAITING_CHILDREN is spent waiting for
   * the scheduler or for children — not work this node did — and counting it would make a
   * dependency-starved leaf look like the slow one, the exact misdirection `startedAt` exists
   * to prevent.
   */
  const prev = node.status
  if (prev !== status && ACTIVE_STATUSES.has(prev)) {
    const since = Date.parse(node.updatedAt)
    const now = Date.parse(ctx.now())
    // Both come off disk on a resumed node and either can be garbage. A NaN would poison the
    // running total permanently; a negative delta (clock skew between machines that wrote the
    // same run) would render a phase that finished before it started.
    if (Number.isFinite(since) && Number.isFinite(now) && now > since) {
      node.phaseMs = { ...(node.phaseMs ?? {}), [prev]: (node.phaseMs?.[prev] ?? 0) + (now - since) }
    }
  }
  node.status = status
  // Stamped ONCE, on the first active phase. Re-stamping would restart the clock on every
  // rework round and under-report exactly the nodes a user is looking for.
  if (node.startedAt === undefined && ACTIVE_STATUSES.has(status)) node.startedAt = ctx.now()
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

/**
 * commit(), exposed for the phase-timing tests.
 *
 * The accumulation lives inside commit because every phase transition goes through it, and a
 * separate helper would be a second list to keep in step. Driving it directly is the only way
 * to control the clock precisely enough to assert on durations.
 */
export const commitForTest = commit

/**
 * 触阀但不停机 (spec §11 的 maxDepth 分支)。
 *
 * blockWithReason cannot serve this: the node is NOT blocked, and setting capBlocked would
 * offer it to `--retry-blocked`, which would then reopen a node that is running fine.
 * Announced anyway — "触任何阀:…不静默截断" means the user gets to know the tree was
 * flattened, not merely that the run succeeded.
 */
function notifyValve(node: TaskNode, reason: string, category: BlockCategory, ctx: PipelineCtx): void {
  // stopped: false — EVERY caller of this helper leaves its node running. blockWithReason is
  // the one that stops nodes, and it sends its own payload.
  // Same rule as blockWithReason: a cancel must never page a human.
  //
  // NOT COVERED BY A TEST, and recorded rather than faked: both call sites sit behind an
  // earlier `runPhase`/roundtable abort check that returns first, so the only way to reach
  // here with the signal set is an abort landing in the await window between that check and
  // this line. Removing this guard leaves the suite green. It is defence for a race the
  // current control flow makes very narrow — keep it, but do not claim it is tested.
  if (ctx.signal.aborted) return
  try { ctx.onBlocked?.({ node, reason, category, stopped: false }) } catch { /* a notification failure must not change the run */ }
}

/**
 * Prefix marking a line in `execStatus` as ORCHESTRATOR bookkeeping rather than executor output.
 *
 * Three writers append to a field that otherwise belongs to the execute phase: reseat's
 * 上次运行在…中断 note, growTree's refusal list, and 补救拆分's note. Anything that asks
 * "did this node do its own work?" has to be able to tell them apart — integratePrompt asked
 * by checking non-emptiness and consequently presented a bookkeeping line to the final
 * acceptance roundtable as merged code.
 */
export const ORCHESTRATOR_NOTE = '(注:'

// A crashing renderer must never take the run down with it.
function safeUpdate(ctx: PipelineCtx): void {
  try { ctx.onUpdate() } catch { /* UI failure is not a run failure */ }
}

// `text` rides along on the FAILURE branch too: the execute phase runs with write-capable
// tools, so an abort that arrives after the executor answered may be discarding the only
// record of changes already made to the repo.
type PhaseResult = { ok: true; text: string } | { ok: false; reason: string; text?: string; timeout?: boolean }
// Wraps a direct runAgent phase call (plan/execute). A throw OR an abort observed
// after the call yields ok:false with a reason; the caller hands it to blockWithReason,
// which records it into node.blockedReason and BLOCKs the node.
async function runPhase(ctx: PipelineCtx, req: Parameters<RunAgentFn>[0]): Promise<PhaseResult> {
  try {
    // Tagged with the node so the detail view can show the right stream. A caller-supplied
    // onChunk wins, so this never silently replaces a more specific one.
    const text = await ctx.runAgent({
      ...req,
      onChunk: req.onChunk ?? (ctx.onChunk ? t => ctx.onChunk!(req.node.id, t) : undefined),
    })
    if (ctx.signal.aborted) return { ok: false, reason: '已中断', text }
    return { ok: true, text }
  } catch (e) {
    // caps.nodeTimeoutMs is a safety VALVE (spec §11) and escalates differently from an
    // ordinary provider failure, so it travels as a flag rather than as prose to grep.
    return { ok: false, reason: e instanceof Error ? e.message : String(e), timeout: e instanceof PhaseTimeoutError }
  }
}

// Records WHY the node died in its own field. It must NOT touch node.execStatus, which may
// hold real completed-work evidence that acceptance/audit still needs.
async function blockWithReason(node: TaskNode, reason: string, ctx: PipelineCtx, category?: BlockCategory): Promise<void> {
  // The 处理方式 and the retry command travel WITH the reason, exactly as the merge-conflict
  // path does. The escalation limiter drops cards past its cap while telling the user to read
  // run.md — so run.md has to actually contain what the card would have said.
  node.blockedReason = category !== undefined ? blockReasonWithRemedy(reason, category, ctx.runId) : reason
  // Assigned in BOTH directions, like `interrupted`: a node that previously tripped a valve
  // and is now blocked for a structural reason must not keep a flag that offers a retry.
  node.capBlocked = category !== undefined
  // Recorded, not re-derived. See TaskNode.capCategory.
  node.capCategory = category
  // Structural, not textual: if the run is aborting, this block is an interruption rather
  // than a judgement about the work, and resume must be able to reopen exactly these nodes.
  // Assigned in BOTH directions on purpose — a node reseated by an earlier resume carries a
  // cleared flag, and if it later fails for real the flag must not linger and resurrect it.
  // (The orchestrator's abort sweep marks the rest; it skips nodes that are already BLOCKED,
  // which is exactly the set this line covers.)
  node.interrupted = ctx.signal.aborted
  await commit(node, 'BLOCKED', ctx)
  // A cancel must never page a human — same rule the conflict path follows. The user is
  // standing at the keyboard, and a card saying 已暂停等待人工 would contradict the run's own
  // 已取消 in the same second. Fired AFTER the commit so the card and the tree agree.
  if (category !== undefined && !ctx.signal.aborted) {
    // The RAW reason: buildBlockCard renders its own 处理方式 line, and passing the already-
    // decorated text would print the remedy twice on one card.
    try { ctx.onBlocked?.({ node, reason, category, stopped: true }) } catch { /* a notification failure must not change the verdict */ }
  }
}

// True when a round failed only because reviewer CALLS failed, not because anyone judged
// the work. Retrying the review is right; redoing the executor's work would be wrong.
function isInfraOnlyFailure(rec: { verdicts: { pass: boolean; blocking: string[]; infra?: boolean }[] }): boolean {
  const failing = rec.verdicts.filter(v => !v.pass || v.blocking.length > 0)
  return failing.length > 0 && failing.every(v => v.infra === true)
}

/**
 * Which valve an exhausted roundtable actually tripped.
 *
 * caps.nodeTimeoutMs is its own valve (spec §11) with its own fix — 提高 nodeTimeoutMs / 把
 * 节点拆小 — and it is nothing like "the provider is unreachable". Reported as `infra`, the
 * card told users to go check their network while the real cause was a deadline they could
 * raise in one line of run.md.
 */
function exhaustionCategory(rec: RoundtableRecord): BlockCategory {
  const failing = rec.verdicts.filter(v => !v.pass || v.blocking.length > 0)
  return failing.length > 0 && failing.every(v => v.timeout === true) ? 'timeout' : 'infra'
}

/**
 * Everything the PLAN prompt reads.
 *
 * Narrower than PipelineCtx on purpose: the 根方案关口 (spec §2 第三关) builds this exact
 * prompt before any orchestrator exists, and it must be the SAME text the run would have
 * used. Widening it to PipelineCtx would force the gate to fabricate a runAgent, a signal and
 * a persist just to render a string — and a hand-rolled second copy of the prompt is how the
 * gate and the run start describing different tasks.
 */
/**
 * `worktrees` is here only so the prompt can tell the planner whether siblings will run in
 * SEPARATE working trees — which is what makes spec §16's biggest risk (two independent
 * siblings editing one file, the later merge conflicting) possible in the first place. Under
 * a shared tree the execute phase is serialised, so that advice would be describing a hazard
 * the run cannot have.
 */
export type PlanPromptCtx = Pick<PipelineCtx, 'config' | 'byId' | 'worktrees'>

// A node with deps must SEE what its dependencies produced, otherwise it replans from
// scratch and redoes upstream work.
function depsSection(node: TaskNode, ctx: Pick<PipelineCtx, 'byId'>): string {
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
  /**
   * Per-SEAT prompt builder. The seat argument is what lets a task role carry its own brief
   * into the model call — see runRoundtable.prompt for why a single shared string made role
   * definitions unreachable.
   */
  buildPrompt: (tag: string, seat: RoleBinding | null) => string
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
      system: args.system, prompt: (seat: RoleBinding | null) => args.buildPrompt(tag, seat),
      runAgent: args.ctx.runAgent, signal: args.ctx.signal, answerTag: tag, cwd: args.cwd,
      quorum: args.ctx.config.caps.quorum, quorumSeats: args.ctx.config.caps.quorumSeats,
      onChunk: args.ctx.onChunk ? t => args.ctx.onChunk!(args.node.id, t) : undefined,
      slots: args.ctx.slots,
    })
    if (args.ctx.signal.aborted) return { rec, infraExhausted: false }
    // 已经达成结论就收工 —— 哪怕有席位没打通。
    //
    // 这里此前只看 isInfraOnlyFailure,完全不看 pass。放宽 quorum 之后,「2 席赞成 +
    // 1 席打不通」的 synthesized.pass 已经是 true,却因为「所有 failing 都是 infra」
    // 继续重试,烧完 maxIterations 桌之后以 `未能取得任何裁决` 阻断 —— 而那句话是假的:
    // a、b 都判决了且都通过。前几轮通过的裁决还会被丢掉(只返回最后一个 rec)。
    // 实测:3 席 quorum=60、c 永久失败 → BLOCKED,9 次评审调用,reviewLog 只剩 1 条。
    if (rec.synthesized.pass || !isInfraOnlyFailure(rec)) return { rec, infraExhausted: false }
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

export function planPrompt(node: TaskNode, ctx: PlanPromptCtx, tag: string, feedback = '', brief = ''): string {
  const caps = ctx.config.caps
  const isolated = ctx.worktrees !== undefined
  return (
    brief +
    `任务:${quote(node.title)}\n目标:${quote(ctxGoal(node))}\n` +
    depsSection(node, ctx) +
    guidanceSection(ctx) +
    // The depth budget lives IN THE PROMPT so the model self-limits, instead of us
    // silently discarding the children it asked for once it hits the cap.
    `当前深度 ${node.depth}/上限 ${caps.maxDepth};已达上限时必须返回 kind=executable,不得再拆分。\n` +
    (feedback
      ? `上一版方案(就是它需要被修订):\n${quote(JSON.stringify(node.plan))}\n上一轮评审阻断意见,请针对性修订:\n${quote(feedback)}\n`
      : '') +
    // spec §16 names worktree merge conflict as the run's BIGGEST risk, and names exactly one
    // mitigation for it: 「鼓励 plan 阶段以依赖边串联可能冲突的节点」. That instruction reached
    // the planner nowhere — the schema line asked for `deps` and never said what they are for,
    // so a planner optimising for parallelism produced precisely the shape the spec warns
    // about: independent siblings editing one file, each in its own worktree, the later merge
    // conflicting. Isolation is what makes this both possible and invisible until merge time.
    // Suppressed at the depth cap — the line above just said "no more children", so advice
    // about how to wire siblings contradicts it — and at parallelism 1, where the global pool
    // admits one node at a time and `acquire` branches from the integration branch's CURRENT
    // tip, so the second node already contains the first one's merge. That is the same test
    // used to suppress this for un-isolated runs: do not describe a hazard this run cannot have.
    (isolated && node.depth + 1 <= caps.maxDepth && ctx.config.parallelism > 1
      ? `注意:子任务在**各自独立的 git worktree** 里并行执行,最后逐个合并回集成分支。` +
        `所以**几乎必然会改到同一个文件的子任务,优先用 deps 串起来**,让它们先后执行。\n` +
        // The counter-pressure, and it is load-bearing rather than decoration. `deps` is a hard
        // scheduling gate, and 依赖阻断 propagates to every downstream dependant — so
        // over-chaining converts "one node failed" into "the whole chain failed", on top of
        // costing wall-clock. spec §16 says 鼓励, and in the same breath 「不追求全自动无冲突」
        // with an auto-resolve → escalate path behind it. An earlier wording here said 必须 and
        // gave three clauses all pushing the same way; asked "could these touch the same file?"
        // a planner answers yes for almost any two tasks in one repo, so that reads as
        // "serialise everything" — destroying the parallelism this whole mode exists for.
        `但 deps 是硬调度门:串起来的任务只能依次执行,而且上游一旦阻断,下游会跟着阻断。` +
        `所以只在**确实会碰同一个文件**时串,拿不准就并列 —— 合并冲突有自动解决和人工升级兜底,` +
        `不必为了躲冲突牺牲并行。\n`
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

function reviewPrompt(node: TaskNode, tag: string, brief = ''): string {
  return brief + `请评审以下方案是否可执行、完整、无重大风险。方案:\n${quote(JSON.stringify(node.plan))}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。有任何阻断问题填入 blocking。` + answerRule(tag)
}
function executePrompt(node: TaskNode, ctx: PipelineCtx, tag: string, feedback = '', syncNote = '', brief = ''): string {
  return (
    brief +
    `按以下方案执行任务并完成实际改动。方案:\n${quote(JSON.stringify(node.plan))}\n` +
    depsSection(node, ctx) +
    guidanceSection(ctx) +
    // 跨分支依赖调度: what happened on the integration branch while this node worked. Told to
    // the executor rather than buried in execStatus, because it changes what it should DO —
    // re-read files that moved, or expect a conflict it will have to help resolve.
    syncNote +
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
function acceptPrompt(node: TaskNode, tag: string, brief = ''): string {
  return (
    brief +
    `请验收执行结果是否达成验收点。\n` +
    `验收点:${quote(node.plan.acceptance) || '(本节点未定义验收点,请依据目标判断:' + quote(ctxGoal(node)) + ')'}\n` +
    `执行状态:${quote(node.execStatus) || '(执行阶段没有报告任何产出,视为未完成)'}\n` +
    `输出:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(tag)
  )
}
// Integration acceptance judges CHILD evidence against the parent goal. acceptPrompt would
// show only the parent's own execStatus — which for a decompose node is empty.
function integratePrompt(node: TaskNode, ctx: PipelineCtx, tag: string, feedback = '', brief = ''): string {
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
  /**
   * The node's OWN execution output — and the reason this section exists at all.
   *
   * A node that grows children mid-execute takes stepExecute's early return (:1118-1126):
   * it merges its real repo writes into the integration branch and leaves BEFORE the
   * ACCEPTANCE roundtable. From then on it only ever reaches ACCEPTED through stepIntegrate —
   * and this prompt rendered the parent goal and the CHILDREN's results only. So the
   * executor's own changes were merged and then accepted with **no role having ever looked
   * at them**, while the run reported completed. That is the one outcome the Global
   * Constraints forbid ("不谎报完成"), and spec §8 states the rule it broke: 验收 + 评分通过
   * 后才进入 MERGE.
   *
   * Judging it HERE rather than adding an acceptance round before the merge is deliberate:
   * the work is half-finished by construction (that is why it grew children), so accepting
   * it on its own would be judging an incomplete thing against the node's acceptance
   * criteria. Together with the children is exactly when it becomes judgeable.
   *
   * Empty for a pure decompose node, which never executes — so this adds nothing to the
   * prompt for the ordinary case.
   */
  // ORCHESTRATOR NOTES DO NOT COUNT. `execStatus` holds the executor's own report, but the
  // orchestrator also appends bookkeeping lines to it — reseat's 上次运行在…中断, growTree's
  // refusal list, and 补救拆分's own note. Keying "this node did its own work" on "execStatus
  // is non-empty" therefore told this roundtable that a bookkeeping line was merged code:
  //   本节点自己的执行产出(已合入集成分支,同样需要你验收):
  //   (注:集成验收未通过,已追加补救子任务 …)
  // Two falsehoods in one section, on the round that decides root's final verdict.
  const realWork = node.execStatus
    .split('\n')
    .filter(l => !l.trimStart().startsWith(ORCHESTRATOR_NOTE))
    .join('\n')
    .trim()
  const ownWork = realWork.length > 0
    ? `本节点自己的执行产出(已合入集成分支,同样需要你验收):\n${quote(realWork)}\n\n`
    : ''
  return (
    brief +
    (ownWork
      ? `请验收"本节点自己的执行产出 + 全部子任务的结果,合起来是否达成本节点目标"。\n`
      : `请验收"全部子任务的结果合起来是否达成本节点目标"。\n`) +
    `父目标:${quote(ctxGoal(node))}\n父验收点:${quote(node.plan.acceptance) || '(无)'}\n\n` +
    ownWork +
    `子任务结果:\n${children || '(无子任务)'}\n\n` +
    (feedback ? `上一轮集成验收阻断意见,请复核是否已解决:\n${quote(feedback)}\n\n` : '') +
    // 补救拆分 (spec §4.1). Asked for HERE, inside the verdict, rather than by a separate plan
    // call — see Verdict.remedy for why that placement is the design. Described as optional
    // and small on purpose: it is spent at most once per node, and these siblings all touch
    // the same files.
    `不通过时,若你认为"再补几个子任务"能补上缺口,可在同一个 json 里给出 ` +
    `"remedy":[{"title":"子任务标题","deps":[]}](最多 ${MAX_REMEDY_CHILDREN} 个;` +
    `补不上、或问题不在于缺工作,就省略该字段)。\n` +
    `输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(tag)
  )
}

// P1 runs a single planner/executor even if several are configured; only review and
// accept fan out into a roundtable. Extra plan/execute roles are deliberately ignored.
// 'observer' is a real caller (scoreNode, and the two SCORING commits). The narrower literal
// union was simply wrong, and with no typecheck in this repo nothing said so.
/**
 * 集成验收这一场坐谁。
 *
 * 配了「集成提交」就用它;没配则回落到验收席位 —— 那是兼容老 run.md 和没配这个环节的
 * 用户,行为与拆环节之前逐字节相同。
 */
function integrateSeats(node: TaskNode): RoleBinding[] {
  const own = node.phaseRoles.integrate ?? []
  return own.length > 0 ? own : (node.phaseRoles.accept ?? [])
}
/** 简报要从席位真正所属的那个环节读,否则回落时会去找一份不存在的角色定义。 */
function integrateBriefPhase(node: TaskNode): PhaseName {
  return (node.phaseRoles.integrate ?? []).length > 0 ? 'integrate' : 'accept'
}

function firstRole(node: TaskNode, phase: 'plan' | 'execute' | 'observer') {
  return node.phaseRoles[phase][0] ?? null
}

/**
 * 方案阶段的「多员工达成一致」:**顺序精化**,不是投票。
 *
 * 用户的要求是「一个角色有多个员工其必须过圆桌评审达成一致,只有一个结论方案或产出」。
 * 裁决类阶段(评审/验收)天然可合成 —— 全票/法定人数就是合成规则。方案类不行:两份
 * 方案没法机械合并,而「各自出稿再投票」要新 schema、新 answerTag、新解析器、新聚合
 * (argmax 而不是 AND),还要在 node 上给落选稿找地方放 —— 放不下就是静默丢弃(§11)。
 *
 * 顺序精化是唯一物理上成立的形态:第一位起草,后面每一位在**前一稿上修订**。全程只有
 * 一份稿子在走,所以「只有一个产出」是结构保证的,不是靠事后挑。代价是 N 次串行调用
 * —— 这正是关口的 costLine 要把调用数显示出来的原因。
 */
async function runPlanRefinement(
  node: TaskNode, ctx: PipelineCtx, feedback: string,
): Promise<{ ok: true; parsed: ReturnType<typeof parsePlanOutput> } | { ok: false; reason: string; timeout?: boolean }> {
  // 空名册 = 主模型一席,与引入本函数之前完全一样。
  const seats: (RoleBinding | null)[] = node.phaseRoles.plan.length > 0 ? node.phaseRoles.plan : [null]
  let parsed!: ReturnType<typeof parsePlanOutput>
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i]
    const tag = answerTag(ANSWER_TAGS.plan)
    // 第二位起,把前一稿原样交出去并要求**修订**而不是重写。quote() 中和围栏,免得
    // 上一稿里的代码块提前关掉本次的答案围栏。
    const priorDraft = i === 0 ? '' : (
      '已有一份同伴起草的方案,请在它的基础上修订(补漏、纠错、收敛),不要推倒重写;' +
      '你认可的部分原样保留。\n上一稿方案:\n' + quote(JSON.stringify(parsed.plan)) + '\n' +
      '上一稿的子任务拆分:' + quote(JSON.stringify(parsed.children)) + '\n\n'
    )
    const res = await runPhase(ctx, {
      phase: 'plan', node, role: seat, system: 'plan',
      prompt: planPrompt(node, ctx, tag, feedback, seatBrief(ctx, seat, 'plan') + priorDraft),
      signal: ctx.signal,
    })
    if (!res.ok) {
      // 第一位就失败 → 手上没有任何稿子,照旧阻断。后面的人失败 → 已经有一份**解析通过**
      // 的稿子,拿它继续走评审,比把前面的工作全丢掉更诚实 —— 评审那关照样会挡。
      // 但必须留痕:静默降级成「少一位修订者」正是不静默截断要防的。
      if (i === 0) return { ok: false, reason: res.reason, timeout: res.timeout }
      node.execStatus = (node.execStatus ? node.execStatus + '\n' : '') +
        ORCHESTRATOR_NOTE + '方案精化第 ' + (i + 1) + ' 位(' + (seat?.roleName || '主模型') +
        ')调用失败,采用前一稿: ' + res.reason + ')'
      break
    }
    parsed = parsePlanOutput(res.text, tag)
  }
  return { ok: true, parsed }
}

/**
 * 这一席的角色简报,已带好尾部空行 —— 角色的「产出什么、起什么作用」到达模型的唯一通道。
 *
 * 席位没有 roleTag(关口上手勾的员工、老 run.md 里的席位)就是空串,提示词退回原样。
 */
function seatBrief(ctx: { config: EffTaskConfig }, seat: RoleBinding | null, phase: PhaseName): string {
  const b = roleBriefFor(ctx.config.roleDefs ?? [], seat, phase)
  return b ? b + '\n\n' : ''
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
function guidanceSection(ctx: Pick<PipelineCtx, 'config'>): string {
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
  /**
   * 启动关口第三关 (spec §2): a plan a human has already seen and approved.
   *
   * Consumed on the FIRST iteration only, and re-drafted like any other plan if the review
   * roundtable blocks it — the human's approval is an input to the process, not an exemption
   * from it ("每个方案经多角色圆桌评审").
   */
  let confirmed = node.confirmedDraft
  // plan → review loop. A rejected child GROUP (dependency cycle) re-enters this same
  // loop, so replanning is bounded by the SAME maxIterations budget — a cycle costs a
  // retry, it does not instantly kill the run.
  for (;;) {
    let lastChildren: { title: string; deps: string[] }[]
    // A confirmed draft is only usable if it can actually BUILD what it promises. Two shapes
    // reach here and neither can:
    //  - decompose with no children: nothing gets created, the node parks at
    //    WAITING_CHILDREN with childIds: [], and advanceableKind returns null forever. The run
    //    ends '存在无法推进的阻断节点' with no reason on any node. (Reachable from a
    //    half-written node.md; measured.)
    //  - the node ALREADY has children: the guard further down returns before lastChildren is
    //    used, so the approved first level is consumed and silently dropped.
    // Falling back to a normal plan call is the honest degradation — it is what the run did
    // before this gate existed.
    if (confirmed && (
      // NOT `kind === 'decompose'`: a node.md carrying `kind: unknown` with an empty child
      // list passes validateLoadedNodes untouched (an empty array is legal) and then skipped
      // the plan call outright — measured 0 plan calls, root left READY/unknown, and the run
      // ended '存在无法推进的阻断节点' with an empty blockedReason. Only an EXECUTABLE node
      // legitimately has no children.
      (node.kind !== 'executable' && confirmed.children.length === 0) ||
      // …and the mirror image: any NON-decompose node with children in its draft. stepStart's
      // non-decompose branch commits READY and returns, so the approved children are consumed
      // and dropped — measured phases ["review"], childIds [], one node in the tree. Written as
      // `!== 'decompose'` rather than `=== 'executable'` because validateLoadedNodes resets an
      // illegal kind to 'unknown', which is the same shape through a different door.
      (node.kind !== 'decompose' && confirmed.children.length > 0) ||
      node.childIds.length > 0
    )) {
      confirmed = undefined
      node.confirmedDraft = undefined
    }
    if (confirmed) {
      // NO plan call. Re-drafting here would ask the plan role the question the user just
      // answered and silently throw their edits away — the gate would render, they would
      // approve a tree, and the run would build a different one.
      lastChildren = confirmed.children
      confirmed = undefined
      // Cleared by the commit below. NOTE the assignment happens BEFORE it: if that write
      // fails the node is BLOCKED having already lost the draft, and neither `interrupted`
      // nor `capBlocked` is set, so no resume reopens it. commit()'s failure path is
      // pre-existing; the draft merely gives it one more thing to lose.
      node.confirmedDraft = undefined
      if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    } else {
      if (!(await commit(node, 'PLANNING', ctx))) return
      const res = await runPlanRefinement(node, ctx, feedback)
      if (!res.ok) { await blockWithReason(node, res.reason, ctx, res.timeout ? 'timeout' : undefined); return }
      const parsed = res.parsed
      node.kind = parsed.kind
      node.plan = parsed.plan
      lastChildren = parsed.children
      if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    }
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1,
      system: 'review', buildPrompt: (tag, seat) => reviewPrompt(node, tag, seatBrief(ctx, seat, 'review')), ctx,
    })
    node.reviewLog.push(rec)
    // runRoundtable resolves even when the run was cancelled mid-flight (it collects
    // whatever settled). Without this the node would go on to commit READY/WAITING_CHILDREN
    // after the user already cancelled.
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody judged the plan — say that rather than blaming the plan.
      await blockWithReason(node, `评审角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec))
      return
    }
    if (!rec.synthesized.pass) {
      node.iteration.planReview++
      feedback = rec.synthesized.blockingSummary
      if (node.iteration.planReview >= caps.maxIterations) {
        await blockWithReason(node, `评审迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx, 'cap-iteration')
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
      const folded = lastChildren.map(c => c.title).join('、')
      node.plan.solution += `\n\n已达最大深度,不得再拆分,请在本节点内依次完成:${folded}`
      node.kind = 'executable'
      await commit(node, 'READY', ctx)
      // The valve tripped. The work is not lost (it is folded into the plan above, which the
      // executor and the acceptance roundtable both read) but the TREE was flattened, and
      // nothing else anywhere says so — the node renders exactly like a normal executable.
      notifyValve(node, `已达最大深度 ${caps.maxDepth},以下子任务被折进本节点内完成:${folded}`, 'cap-depth', ctx)
      return
    }

    const created = await createChildren(node, lastChildren, ctx)
    if (created.ok) { await commit(node, 'WAITING_CHILDREN', ctx); return }
    // Node-count cap and persist failures are fatal (retrying can't make room or fix the
    // disk); a dependency cycle is a planning mistake the model can correct.
    if (!created.retryable) { await blockWithReason(node, created.reason, ctx, created.cap ? 'cap-nodes' : undefined); return }
    node.iteration.planReview++
    feedback = created.reason
    if (node.iteration.planReview >= caps.maxIterations) {
      await blockWithReason(node, `拆分迭代超限(${caps.maxIterations}): ${created.reason}`, ctx, 'cap-iteration')
      return
    }
  }
}

type CreateResult =
  | { ok: true }
  // `cap` marks the node-count valve specifically. The caller used to compare the reason
  // against a string literal to tell it from a persist failure — two modules sharing a
  // sentence is not an interface, and the two need different cards.
  | { ok: false; reason: string; retryable: boolean; cap?: boolean }

export async function createChildren(
  node: TaskNode,
  specs: { title: string; deps: string[] }[],
  ctx: PipelineCtx,
  /**
   * Extra context appended to each child's goal — why this batch exists.
   *
   * Added for 补救拆分 (spec §4.1). The composed goal below carries the parent's plan
   * keyPoints, and for a corrective batch that plan is precisely the one the integration
   * roundtable just refused: without this the child would replan against the failing text
   * with nothing to go on but a ≤200-char title. Absent for ordinary decomposition, where
   * the parent's plan IS the right context.
   */
  goalNote?: string,
): Promise<CreateResult> {
  // Node-count cap: if creating these children would exceed maxNodes, create NONE
  // (never silently truncate). Not retryable — replanning can't create budget.
  // Reserved ATOMICALLY (see PipelineCtx.reserveNodes): the old check compared against
  // byId.size and then awaited before inserting, so two concurrent decompositions both
  // passed against the same stale size and the tree ran past the cap.
  const slots = ctx.reserveNodes(specs.length)
  if (!slots) {
    return { ok: false, reason: '节点数超过上限', retryable: false, cap: true }
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
        goal: `${node.goal}\n> 上级方案要点: ${(node.plan.keyPoints || node.plan.solution).slice(0, 500)}\n> 本子任务: ${c.title}`
          + (goalNote ? `\n> ${goalNote.slice(0, 1000)}` : ''),
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

function scorePrompt(node: TaskNode, tag: string, brief = ''): string {
  return (
    brief +
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
    phase: 'observer', node, role, system: 'observer', prompt: scorePrompt(node, tag, seatBrief(ctx, role, 'observer')), signal: ctx.signal,
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
      const why = `目标节点 ${quote(targetId)} 已达深度上限 ${ctx.config.caps.maxDepth}`
      refusals.push(why)
      // Same valve as the stepStart path, same announcement. Reaching it through dynamic
      // growth instead of decomposition does not make it a different event — and it used to
      // land ONLY in execStatus, where a run could pass acceptance having silently dropped
      // the work the executor said it needed.
      notifyValve(node, why, 'cap-depth', ctx)
      continue
    }
    const res = await createChildren(target, kids, ctx)
    if (!res.ok) {
      const why = `向 ${quote(targetId)} 加子节点失败: ${res.reason}`
      refusals.push(why)
      // spec §11: "maxNodes 超限 → 暂停新增,升级人工". The 暂停新增 half was done; this is
      // the other half. Same valve as the decomposition path, which DOES escalate.
      if (res.cap) notifyValve(node, why, 'cap-nodes', ctx)
      continue
    }
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
  /**
   * "Nothing to merge" and "the pool that owned my commits is gone" are NOT the same answer.
   *
   * The single `!ctx.worktrees || !node.worktree` short-circuit reported success for both.
   * The second case is reachable, and it is the bad one: `validateLoadedNodes` deliberately
   * KEEPS `node.worktree` for a node blocked on a merge conflict — that path is where the
   * human's fix lives, and the resume summary promises 「恢复后将重跑验收并重试合并」. If the
   * pool then fails to init on that resume (very reachable: the escalation card sends the user
   * to look at the conflict, they `git checkout` the integration branch in their main tree,
   * and the next `git worktree add` refuses with "already checked out"), the run degrades to
   * `isolation: 'none'` — and this function answered "merged fine" for a node holding real
   * commits on a branch nothing will ever merge. It then reached ACCEPTED. Measured by an
   * acceptance reviewer end to end.
   *
   * That is exactly what §17.2 promises never to do: 宁可重做,不可谎报.
   */
  if (!ctx.worktrees && node.worktree) {
    await blockWithReason(
      node,
      `该节点在隔离工作区(${node.worktree.branch})里有未合并的提交,但本次运行没有可用的隔离池,` +
      `无法把它合入集成分支。请先解决 ${node.worktree.path} 处的占用(常见原因:集成分支已在主检出里被 checkout),再 /et --resume 继续。`,
      ctx,
    )
    return false
  }
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
            system: 'accept', buildPrompt: (t, seat) => acceptPrompt(node, t, seatBrief(ctx, seat, 'accept')), ctx, cwd: node.worktree.path,
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
      // Carries the 处理方式 and the resume command too. Those lived ONLY on the Feishu card,
      // so a run with no bridge left the user with a path and no idea what to do with it —
      // and the tree is the only surface such a run has.
      const detail =
        `合并冲突,已保留工作区待人工处理。分支 ${node.worktree.branch};路径 ${node.worktree.path};` +
        `冲突文件: ${files.join('、')}。` +
        (state.stale
          ? '该分支的文件里残留了已提交的冲突标记,请清理后提交;'
          : state.staged
            ? '那里有一个已 git add 但未提交的合并,请核对后 git commit;'
            : state.markers
              ? '进入该路径解决冲突后 git add 并 git commit;'
              : `进入该路径后自行 git merge ${ctx.worktrees.integrationBranchName} 重现冲突并解决;`) +
        `随后用 /et --resume 继续。`
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
  } else if (rel.removed) {
    // The directory is GONE. Keeping the reference made the node advertise a path that no
    // longer exists — NodeDetail renders it under 隔离工作区, and handoff() probes it — which
    // is the product stating something untrue about its own state. It also makes a later
    // re-entry (resume, growth) skip `acquire` and run against nothing.
    node.worktree = undefined
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
      system: 'accept', buildPrompt: (t, seat) => acceptPrompt(node, t, seatBrief(ctx, seat, 'accept')), ctx, cwd: node.worktree.path,
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
  let round = 0
  let syncNote = ''
  for (;;) {
    round++
    // 跨分支依赖调度. `acquire` based this worktree on the integration tip, and then froze it.
    // Rounds 2+ can be minutes or hours later, with sibling branches merged in between — so
    // refresh before reworking rather than editing a tree that no longer matches what the
    // node will merge into. Round 1 needs nothing: acquire just did it.
    if (round > 1 && ctx.worktrees && node.worktree) {
      const sync = await ctx.worktrees.refreshFromIntegration(node)
      syncNote = sync.ok
        ? sync.updated
          ? '注意:自上一轮以来集成分支上有其他任务的改动已合入你的工作区,相关文件可能已变化,动手前先重新读一遍。\n'
          : ''
        : sync.dirty
          // The rollback FAILED and the tree is still conflicted. Saying 仍在原基线上 here
          // would send the executor into a directory with <<<<<<< markers it does not expect.
          ? '注意:同步集成分支时发生冲突且未能回滚,你的工作区里现在有冲突标记。请先解决这些冲突再继续本轮返工。\n'
          : sync.conflicted
            // Honest, and actionable: the node stays on its old base, and the executor is the
            // one who can make the eventual merge resolvable by not fighting the other side.
            ? '注意:集成分支上有其他任务的改动,但与你的改动冲突,本轮未能同步(仍在原基线上)。请尽量只改与本任务相关的部分,避免让冲突扩大。\n'
            // Neither up-to-date nor conflicted: the sync itself broke (git add/commit failed).
            // Silence here left the executor believing it was current when it was not.
            : '注意:本轮未能与集成分支同步(同步过程出错),你仍在较旧的基线上,可能看不到其他任务已合入的改动。\n'
    }
    if (!(await commit(node, 'EXECUTING', ctx))) return
    // node.execStatus still holds the PREVIOUS round's result here (it's overwritten below),
    // which is exactly what executePrompt renders on rework.
    const execTag = answerTag(ANSWER_TAGS.exec)
    const execSeat = firstRole(node, 'execute')
    const res = await runPhase(ctx, { phase: 'execute', node, role: execSeat, system: 'execute', prompt: executePrompt(node, ctx, execTag, feedback, syncNote, seatBrief(ctx, execSeat, 'execute')), cwd: node.worktree?.path, signal: ctx.signal })
    if (!res.ok) {
      // Keep whatever the executor managed to report before the interruption. It ran with
      // write tools, so discarding this can leave the repo changed with no record of it.
      const partial = res.text ? parseExecOutput(res.text, execTag).execStatus.trim() : ''
      if (partial) node.execStatus = `${partial}\n(注:本轮在完成前被中断,以上为中断时已报告的产出)`
      await blockWithReason(node, res.reason, ctx, res.timeout ? 'timeout' : undefined)
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
        await blockWithReason(node, `执行阶段未报告任何产出(第 ${emptyReports} 次),已达迭代上限 ${caps.maxIterations}`, ctx, 'rework')
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
        // Capped, and the REFUSALS get the reserved room — not the report.
        //
        // This is appended AFTER the parse boundary, so it was the one path that could still
        // put unbounded model text into a node. But capping the concatenation cut the refusals
        // off the end, which is the opposite of the point: the executor believes it queued
        // that work, and the refusal is the new information. So the refusals are capped on
        // their own and the report is trimmed to fit around them.
        const refusalText = capText(`(注:以下加子节点请求被拒绝)\n${refusals.map(r => '- ' + r).join('\n')}`, 2000)
        const room = Math.max(500, MAX_FIELD_CHARS - Array.from(refusalText).length - 1)
        node.execStatus = `${capText(reported, room)}\n${refusalText}`
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
      system: 'accept', buildPrompt: (tag, seat) => acceptPrompt(node, tag, seatBrief(ctx, seat, 'accept')), ctx, cwd: node.worktree?.path,
    })
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody ever judged the work — say that, rather than blaming the work.
      await blockWithReason(node, `验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec))
      return
    }
    if (rec.synthesized.pass) {
      // 观察评分 runs between acceptance and ACCEPTED (spec §8: 验收 + 评分通过后进入 MERGE).
      // Committed as its own status: scoring and merging are separately slow phases, and the
      // panel rendered both as ACCEPTANCE — a user watching a node sit for minutes could not
      // tell which of the three it was in. SCORING/MERGE were in NodeStatus and never written.
      if (firstRole(node, 'observer') && !(await commit(node, 'SCORING', ctx))) return
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
      if (ctx.worktrees && node.worktree && !(await commit(node, 'MERGE', ctx))) return
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    node.iteration.acceptance++
    if (node.iteration.acceptance >= caps.maxIterations) {
      await blockWithReason(node, `验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx, 'rework')
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
  // A node that grew children mid-execute and then FAILED to merge arrives here still holding
  // an unresolved conflict. Integration acceptance judges its children's evidence and would
  // hand it an ACCEPTED — while its own commits sit on a branch that never reached the
  // integration branch. Measured: outcome 'completed', node ACCEPTED, no COMMIT+MERGE for it.
  // "不谎报完成" means this has to stop here.
  if (node.mergeConflict === true) {
    await blockWithReason(
      node,
      `该节点自己的改动尚未合入集成分支(合并冲突未解决),不能仅凭子任务结果验收通过。` +
      (node.worktree ? `请到 ${node.worktree.path} 解决冲突后 /et --resume 继续。` : '请解决冲突后 /et --resume 继续。'),
      ctx,
    )
    return
  }
  const caps = ctx.config.caps
  /**
   * The blockers this node already earned, recovered from disk — the third consumer of
   * `lastFailureFeedback`, and the one that was missed.
   *
   * `stepStart:472` and `stepExecute:1037` both seed from the log; this one started blank, so
   * a node reseated out of INTEGRATION_ACCEPT — which is exactly what `--resume` does, see
   * reseat.ts's ACTIVE set — re-entered with empty feedback and `integratePrompt` dropped its
   * 上一轮集成验收阻断意见 section entirely. The roundtable then re-judged the same evidence
   * with no memory of why it had refused it, one round of budget poorer.
   *
   * GUARDED on the integration counter, which nothing but the loop below increments.
   * `acceptLog` is NOT an integration-only log: an executable node whose first acceptance
   * round fails pushes a LEAF verdict (:1138), and if its next execute grows children (:1098)
   * it becomes a decompose node and arrives here with that leaf record still last;
   * mergeAndRelease pushes there too (:900). Rendering either one as 上一轮集成验收阻断意见
   * would tell this roundtable — the one that decides the run's final verdict on root — to
   * re-check a complaint about something else entirely.
   */
  let feedback = node.iteration.integration > 0 ? lastFailureFeedback(node.acceptLog) : ''
  // Same bounded-retry shape as stepExecute: a single failed integration verdict must not
  // be terminal (the roundtable may simply have misread the evidence). Uses its OWN budget
  // so a node that spent `acceptance` elsewhere still gets a full integration allowance.
  for (;;) {
    if (!(await commit(node, 'INTEGRATION_ACCEPT', ctx))) return
    // Hold the integration worktree for the whole review: it is what the reviewers read, and
    // concurrent merges rewrite it underneath them.
    const runIntegrate = async () => roundtableWithInfraRetry({
      // 集成提交(integrate)自己的席位。
      //
      // 回落到 accept 是**兼容**,不是默认:老 run.md 和没配这个环节的用户照旧由验收
      // 角色承担,行为逐字节不变。但一旦用户配了「集成提交」,它就不再借用验收席位 ——
      // 此前两者共用 phaseRoles.accept,规范告诉用户这是两个环节,系统却当成一个。
      phase: 'accept', node, roles: integrateSeats(node),
      round: node.iteration.integration + 1, system: 'integrate',
      buildPrompt: (tag, seat) => integratePrompt(node, ctx, tag, feedback, seatBrief(ctx, seat, integrateBriefPhase(node))), // child evidence, NOT acceptPrompt
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
      await blockWithReason(node, `集成验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec))
      return
    }
    if (rec.synthesized.pass) {
      // 观察评分 (spec §7) applies to "每个节点", and it only ran on the executable-leaf path —
      // so every decompose node, and therefore the ROOT (the run's own verdict), was never
      // scored at all. The observer's rework signal is deliberately NOT honoured here: a
      // decompose node has no execute phase to redo, and its children are already ACCEPTED.
      // Committed as SCORING for the same reason the leaf path does: otherwise the panel
      // shows INTEGRATION_ACCEPT while the run's FINAL score is being computed.
      if (firstRole(node, 'observer') && !(await commit(node, 'SCORING', ctx))) return
      await scoreNode(node, ctx)
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    node.iteration.integration++
    if (node.iteration.integration >= caps.maxIterations) {
      // 回到 decompose 修订 (spec §4.1) — the LAST thing tried before blocking, exactly once.
      const revise = await reviseDecomposition(node, rec, ctx)
      if (revise.kind === 'revised') return
      // commit() already blocked the node with the REAL reason (a persist failure). Falling
      // through would overwrite it with the iteration message and set capBlocked, i.e. offer
      // `--retry-blocked` for a node whose disk is broken. Every other commit call site in
      // this file returns immediately for exactly this reason.
      if (revise.kind === 'stop') return
      await blockWithReason(
        node,
        `集成验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}` +
        // WHY the last resort did not fire, folded into the one block rather than announced
        // on a separate card. A `stopped:false` card saying 本次运行没有停 immediately before
        // a block that stops the node contradicts itself; and without this line the real
        // cause (a cycle in the proposed deps, duplicate titles, the node cap, a persist
        // error) was discarded entirely and the user was told to raise maxIterations.
        (revise.note ? `;补救拆分未能进行: ${revise.note}` : ''),
        ctx,
        'rework',
      )
      return
    }
    feedback = rec.synthesized.blockingSummary
  }
}

/**
 * What `reviseDecomposition` did, so the caller can tell the three outcomes apart.
 *
 * A bare boolean conflated "could not revise" with "the node is already blocked for an
 * unrelated reason", and the caller then reported the wrong cause for both.
 */
type ReviseOutcome =
  | { kind: 'revised' }
  | { kind: 'stop' }
  | { kind: 'no'; note?: string }

/**
 * spec §4.1: `INTEGRATION_ACCEPT ──fail──▶ (回到 decompose 修订)`.
 *
 * The edge existed in the diagram and nowhere in the code. `stepIntegrate`'s loop re-ran the
 * SAME roundtable over the SAME children with the same evidence — `integratePrompt` reads only
 * the parent goal and each child's execStatus, none of which changes between rounds — so the
 * only variable was the feedback line. It burned `maxIterations` real roundtables and blocked.
 * Every other fail edge in that diagram re-runs the phase that PRODUCED the thing being judged
 * (PLAN_REVIEW→PLANNING rewrites the plan, ACCEPTANCE→REWORK re-runs the executor); this one
 * alone changed nothing.
 *
 * Runs at the cap rather than every round, and at most once per node — see TaskNode.revised
 * for why that bound is the whole cost argument.
 *
 * KNOWN NARROWING, recorded rather than papered over. This implements 修订 as "append
 * corrective children", which is a proper SUBSET of what the word can mean:
 *
 *   - it cannot CHANGE the existing decomposition — no re-splitting a wrong child, no
 *     re-wiring sibling deps, no turning the node executable;
 *   - it cannot revise `plan.acceptance`, so the next integration roundtable still judges
 *     against the same 父验收点 it just rejected. When the real fault is "the acceptance
 *     criteria were wrong", three extra siblings cannot express that fix and the node blocks
 *     anyway, one round later;
 *   - the proposal rides an individual verdict, so on a multi-role panel one dissenting
 *     reviewer's titles become real nodes without the others having agreed. §7's roundtable
 *     contract governs the PASS/FAIL synthesis, which is untouched — but this is genuinely a
 *     channel that goes around it.
 *
 * The wider reading — re-run the node's PLAN phase and put the result through PLAN_REVIEW —
 * covers all three, and costs one plan call plus a full review roundtable per revision. It
 * also needs `kind` pinned, because parsePlanOutput flips a childless reply to `executable`
 * and a node that already has children would land in a state `advanceableKind` refuses.
 * Appending is what §4's 「二者都可在后续再追加」 already sanctions; going wider is a product
 * decision about cost, not a defect to fix quietly.
 */
async function reviseDecomposition(node: TaskNode, rec: RoundtableRecord, ctx: PipelineCtx): Promise<ReviseOutcome> {
  if (node.revised === true) return { kind: 'no' }
  // Proposals come only from verdicts that FAILED — parseVerdict drops `remedy` on a pass —
  // and are deduped by title across roles. Exact-title agreement between roles is NOT
  // required: with the common single-role roster it would never fire, which would make the
  // whole feature dead code, and a corrective task nobody else named is not thereby wrong.
  // The dedup itself IS load-bearing on a multi-role panel: two reviewers naming the same
  // remedy would otherwise reach createChildren as duplicate titles, which it rejects
  // wholesale (sibling deps are resolved by title, so duplicates make every reference
  // ambiguous) — and the revision would be silently abandoned precisely when two roles agreed.
  const seen = new Set<string>()
  const specs: { title: string; deps: string[] }[] = []
  for (const v of rec.verdicts) {
    for (const c of v.remedy ?? []) {
      if (seen.has(c.title)) continue
      seen.add(c.title)
      specs.push(c)
      if (specs.length >= MAX_REMEDY_CHILDREN) break
    }
    if (specs.length >= MAX_REMEDY_CHILDREN) break
  }
  if (specs.length === 0) return { kind: 'no' }
  // The depth valve. NOT announced on its own card: this branch is immediately followed by a
  // block, and a `stopped:false` card reading 本次运行没有停 in front of a stop contradicts
  // itself — the cap-depth wording additionally claims the refused work was folded into the
  // node's plan, which is true for stepStart and false here. The reason rides the block.
  if (node.depth + 1 > ctx.config.caps.maxDepth) {
    return { kind: 'no', note: `已达深度上限 ${ctx.config.caps.maxDepth}` }
  }
  // CHAINED, not parallel. These siblings are all closing the same integration gap, so they
  // touch the same files; spec §16 calls worktree merge conflict the run's biggest risk and
  // names dependency edges as its mitigation.
  //
  // A reviewer's own deps are honoured ONLY where they name a sibling in THIS batch, because
  // that is the only thing createChildren can resolve — it maps dep titles to batch indices
  // and silently drops the rest. Measured: a remedy citing an existing sibling ("AA", which
  // the reviewer can see in the prompt's 子任务结果 section) produced three nodes with NO
  // edges at all, i.e. exactly the parallel-same-files shape this chaining exists to prevent,
  // and nothing anywhere said so. Anything unresolvable falls back to the chain.
  const titles = new Set(specs.map(c => c.title))
  const chained = specs.map((c, i) => {
    const usable = c.deps.filter(d => titles.has(d) && d !== c.title)
    return { title: c.title, deps: usable.length > 0 ? usable : i === 0 ? [] : [specs[i - 1].title] }
  })
  // Carry WHY each child exists. createChildren composes a child goal from the parent goal
  // plus the parent's plan keyPoints — and that plan is the one the roundtable just refused,
  // so without this the corrective child replans against the very text that failed, knowing
  // only a ≤200-char title.
  const why = rec.synthesized.blockingSummary
  const res = await createChildren(node, chained, ctx, `集成验收未通过,本子任务是为解决以下问题而追加的:\n${why}`)
  if (!res.ok) {
    // The REAL reason travels back, whatever it was. Only the node cap used to be reported,
    // so a persist failure, a dependency cycle or duplicate titles were discarded entirely and
    // the user was told 提高 caps.maxIterations while the actual fault was a broken disk.
    return { kind: 'no', note: res.reason }
  }
  node.revised = true
  /**
   * A FRESH integration budget, and this is a correctness fix rather than generosity.
   *
   * Without it the node sits at WAITING_CHILDREN with `iteration.integration === maxIterations`
   * for however long the corrective subtree takes — a state that was unreachable before this
   * feature, because reaching the cap used to block immediately. Interrupt in that window
   * (Esc during a multi-minute child run) and propagateBlocked marks the node
   * BLOCKED+interrupted; on the next `--resume`, reseat's exhausted check sees 3/3, blocks it
   * with 恢复时该阶段预算已耗尽 and clears `interrupted` — while `capBlocked` was never set,
   * so `--retry-blocked` does not match it either. Both reviewers reproduced end to end:
   * the node is permanently dead, its corrective children already merged, and on root that
   * sentence becomes the run's final word.
   *
   * Resetting is also what the counter MEANS: it bounds re-judging the same evidence, and the
   * evidence is about to be different. `revised` is the cost bound, and burning the budget was
   * only ever doing that job by accident — badly, since it also left the re-verification with
   * a single round and made the eventual block report 超限(3) with the counter reading 4.
   */
  node.iteration.integration = 0
  // Recorded where the user will actually look. §11's 不静默截断 applies: a round that
  // silently grew the tree by three nodes reads, in the detail view, as one more identical
  // FAIL — and the tree gaining rows with no explanation is the mirror image of the flattening
  // that stepStart already announces.
  node.execStatus = capText(
    `${node.execStatus}${node.execStatus ? '\n' : ''}${ORCHESTRATOR_NOTE}集成验收未通过,已追加补救子任务 ${chained.map(c => c.title).join('、')};通过后将重新集成验收)`,
    MAX_FIELD_CHARS,
  )
  // Its OWN category, not 'rework'. 'rework' means 连续返工超限 — a stopping reason — so the
  // card came out headed 安全阀 · 连续返工超限 over a node that had just recovered, in the
  // blue "nothing is waiting on you" template, with the generic non-stopping body text that
  // says the grow request was REFUSED. One card contradicted itself three ways.
  notifyValve(node, `集成验收未通过,已追加 ${chained.length} 个补救子任务并重新等待子任务完成`, 'revise', ctx)
  node.kind = 'decompose'
  return (await commit(node, 'WAITING_CHILDREN', ctx)) ? { kind: 'revised' } : { kind: 'stop' }
}
