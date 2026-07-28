// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, PhaseName, RoleBinding, RoundtableRecord, ScoreRecord, TaskNode } from './types.js'
import { roleBriefFor } from './roleDefs.js'
import { ALT_SOLUTION_CHARS, createNode, PHASE_LABEL } from './types.js'
import type { StreamHandle, StreamMeta } from './agentStream.js'
import { exhaustionReason, exhaustionRemedy, feedbackItems, planFeedbackPrompt, reviewRepeatNotice } from './reviewConvergence.js'
import { ANSWER_TAGS, answerTag, capText, MAX_FIELD_CHARS, parseExecOutput, parsePlanOutput, parseScoreOutput, MAX_REMEDY_CHILDREN } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle, isTerminal } from './stateMachine.js'
import type { WorktreePool } from './worktreePool.js'
import { mapWithinPool, type SlotPool } from './slotPool.js'
import { blockReasonWithRemedy, humanTimeoutRemedy, type BlockCategory } from './escalation.js'
import { PhaseTimeoutError, type TimeoutKind } from './runAgentAdapter.js'

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
  openStream?: (meta: StreamMeta) => StreamHandle
  /**
   * 方案环节告诉模型「你在哪」用的工作目录。见 PlanPromptCtx.cwd。
   *
   * 不是给子 agent 换 cwd 的(那是 req.cwd 的事),只进提示词 —— 方案环节读的是主工作树。
   */
  cwd?: string
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
  'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'VERIFYING', 'ACCEPTANCE', 'REWORK',
  'INTEGRATION_ACCEPT', 'SCORING', 'MERGE',
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
type PhaseResult =
  | { ok: true; text: string }
  // timeoutKind 要跟着走:静默超时和等人超时的处理方式**相反**,合并成一个 boolean
  // 就只能给一句通用的话。
  | { ok: false; reason: string; text?: string; timeout?: boolean; timeoutKind?: TimeoutKind }

/**
 * 方案环节的返回值。
 *
 * 抽成具名类型不是为了短:原来三个函数各写一遍内联字面量,而其中调用方要读的
 * `timeoutKind` **一个都没写** —— 于是 `res.timeoutKind === 'human'` 是一条永远取不到值
 * 的死分支,分析环节的「没人来点确认」拿到的是静默超时那一版建议(去调 nodeTimeoutMs、
 * 把节点拆小),和病因完全无关。这个仓库没有 typecheck 会指出来。一处定义,漏不掉。
 */
type PlanPhaseResult =
  | { ok: true; parsed: ReturnType<typeof parsePlanOutput> }
  | { ok: false; reason: string; timeout?: boolean; timeoutKind?: TimeoutKind }
// Wraps a direct runAgent phase call (plan/execute). A throw OR an abort observed
// after the call yields ok:false with a reason; the caller hands it to blockWithReason,
// which records it into node.blockedReason and BLOCKs the node.
/**
 * 单次(非圆桌)模型调用。
 *
 * `meta` 不是可选的装饰:分析圆桌(N 席并行)、方案融合席、分析精化(N 席)、观察评分
 * (N 席并行)全都走这里,而不是走 runRoundtable。少给一个署名,这些席位就会退回
 * chunkBuffer 时代那种「几个人的话并成一坨、看不出谁说的」——正是本次要治的病。
 */
async function runPhase(ctx: PipelineCtx, req: Parameters<RunAgentFn>[0], meta: Omit<StreamMeta, 'nodeId'>): Promise<PhaseResult> {
  try {
    const text = await ctx.runAgent({
      ...req,
      stream: req.stream ?? ctx.openStream?.({ nodeId: req.node.id, ...meta }),
    })
    if (ctx.signal.aborted) return { ok: false, reason: '已中断', text }
    return { ok: true, text }
  } catch (e) {
    // caps.nodeTimeoutMs is a safety VALVE (spec §11) and escalates differently from an
    // ordinary provider failure, so it travels as a flag rather than as prose to grep.
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      timeout: e instanceof PhaseTimeoutError,
      timeoutKind: e instanceof PhaseTimeoutError ? e.kind : undefined,
    }
  }
}

// Records WHY the node died in its own field. It must NOT touch node.execStatus, which may
// hold real completed-work evidence that acceptance/audit still needs.
async function blockWithReason(node: TaskNode, reason: string, ctx: PipelineCtx, category?: BlockCategory, remedy?: string): Promise<void> {
  // The 处理方式 and the retry command travel WITH the reason, exactly as the merge-conflict
  // path does. The escalation limiter drops cards past its cap while telling the user to read
  // run.md — so run.md has to actually contain what the card would have said.
  node.blockedReason = category !== undefined ? blockReasonWithRemedy(reason, category, ctx.runId, remedy) : reason
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
    try { ctx.onBlocked?.({ node, reason, category, stopped: true, remedy }) } catch { /* a notification failure must not change the verdict */ }
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
 * 圆桌耗尽时该给哪一版补救建议。
 *
 * 「有任何一席是等人超时」就给等人那版:等人超时是所有席位一起等**同一个**权限确认,
 * 只要有一席在等人,叫用户去调 nodeTimeoutMs 就是白费。返回 undefined = 用按 category
 * 走的默认那版。
 *
 * 不做这一步的实测后果:评审、验收、集成三个环节把「没有人回答工具权限确认」诊断对了,
 * 建议却给成「提高 caps.nodeTimeoutMs 后再重试,或把该节点拆小」—— 一句话前后两半
 * 自相矛盾,而用户是照着后半句去做的。
 */
function exhaustionRemedyFor(rec: RoundtableRecord): string | undefined {
  return rec.verdicts.some(v => v.timeoutKind === 'human') ? humanTimeoutRemedy() : undefined
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
export type PlanPromptCtx = Pick<PipelineCtx, 'config' | 'byId' | 'worktrees'> & {
  /**
   * 方案环节看到的工作目录。
   *
   * 缺了它,「认真 review 下当前目录下的代码」这类目标的方案作者**根本不知道自己在哪**
   * —— 实测产出是一句「对 X 项目进行全面的代码审查」,重点/风险点/验收点全空。它有
   * Read/Glob/Grep,只是没人告诉它该用、也没告诉它对着哪个目录用。
   */
  cwd?: string
}

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
  phase: 'review' | 'accept' | 'verify'
  node: TaskNode
  roles: RoleBinding[]
  round: number
  system: string
  /**
   * 窗口表头上的环节名。省略则按 phase 取 PHASE_LABEL。
   *
   * 集成验收必须显式给:它走的是 `phase: 'accept'`(只有 system 是 'integrate'),按 phase
   * 取名会把整个 run 的最终裁决标成「验收」—— 和 node.md 里分开记的两份记录、以及关口对
   * 用户讲的「这是两个不同环节」全都对不上。
   */
  phaseLabel?: string
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
      openStream: args.ctx.openStream,
      // 集成验收走的是 phase:'accept'(只有 system 不同),表头照 phase 写会把整个 run 的
      // 最终裁决标成「验收」,和 node.md 的验收记录、和关口对用户讲的两个不同环节全对不上。
      phaseLabel: args.phaseLabel ?? PHASE_LABEL[args.phase],
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
    // 「在哪」和「可以看」。这两句缺席时,方案作者只能照着标题写一句正确的废话。
    (ctx.cwd ? `工作目录:${quote(ctx.cwd)}\n` : '') +
    `你有 Read / Glob / Grep,**先真的去看代码,再定方案** —— 不要只凭任务标题推测。\n` +
    depsSection(node, ctx) +
    guidanceSection(ctx) +
    // The depth budget lives IN THE PROMPT so the model self-limits, instead of us
    // silently discarding the children it asked for once it hits the cap.
    `当前深度 ${node.depth}/上限 ${caps.maxDepth};已达上限时必须返回 kind=executable,不得再拆分。\n` +
    // `alternatives` 必须剥掉。它存的是圆桌落选稿的 `{staff: 真名, solution: 正文}`,
    // 而这一段在返工时喂给**每一位**起草者(以及融合者 —— 而融合者本人就是作者之一)。
    // 不剥的话,第二轮起两条写进 README 的承诺当场作废:
    //   - 「拿到的是匿名化的稿 A / 稿 B / 稿 C,看不到谁写的」→ 带着真名回来了
    //   - 「每一位独立起草,互相看不到」→ 第二轮每人都逐字读到了别人第一轮的稿
    // 而且这是个**具名**的锚,比顺序精化那种匿名锚更糟 —— 圆桌存在的全部理由就是去掉锚。
    // 融合那一处早就剥了(见 fusePrompt 的 `alternatives: undefined`),这一处漏了。
    // 顺带:不剥的话每轮还要多背 ALT_SOLUTION_CHARS(1500)× N 的提示词。
    (feedback
      ? `上一版方案(就是它需要被修订):\n${quote(JSON.stringify({ ...node.plan, alternatives: undefined }))}\n上一轮评审阻断意见,请针对性修订:\n${quote(feedback)}\n`
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
    /**
     * **先按文件边界拆。**
     *
     * 这一句和下面那段的区别是「事前」和「事后」:下面讲的是「已经会碰同一个文件了,
     * 用 deps 串起来」—— 而串起来要花掉并行度,还把「一个节点失败」放大成「整条链失败」。
     * 按文件边界拆是免费的:两个子任务本来就不碰同一批文件时,既不需要串,也不会冲突。
     *
     * 不挂在 isolated 上:这不是在描述一个「这次运行不会有的风险」,而是拆分质量本身 ——
     * 边界清楚的子任务,验收点也写得出来,评审也判得动。串行运行同样受益。
     *
     * 要求它**把文件写进 solution**,而不是只在心里想:验收环节按 acceptance 判,而
     * acceptance 那条已经要求「改了哪些文件」—— 两头对得上,才有人能发现拆歪了。
     */
    (node.depth + 1 <= caps.maxDepth
      ? `拆分时**先按文件/模块边界切**,尽量让不同子任务改到的文件不重叠;` +
        `每个子任务的 solution 里要写清它预计会动哪些文件。\n`
      : '') +
    (isolated && node.depth + 1 <= caps.maxDepth && ctx.config.parallelism > 1
      ? `子任务在**各自独立的 git worktree** 里并行执行,最后逐个合并回集成分支。` +
        `按文件边界切完之后**实在避不开**的那些(几乎必然会改到同一个文件),用 deps 串起来,` +
        `让它们先后执行。\n` +
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
    `能直接完成就 executable(children 省略);需要拆分就 decompose 并给出子任务标题与兄弟间依赖。\n` +
    // 四个字段此前只在 schema 里出现过名字,没说要什么 —— 于是模型只填 solution,其余
    // 三个返回空串,而解析层默认成 ''、关口照样渲染成「(空)」。空的验收点尤其糟:
    // 验收环节拿它当判据。
    `四个字段都不许留空,各写具体内容:\n` +
    `- solution:怎么做,分几步,每步动到哪些文件/模块。不要复述目标。\n` +
    `- keyPoints:执行时最容易做错或做漏的地方。\n` +
    `- risks:这么做可能破坏什么、哪些地方不确定。\n` +
    `- acceptance:**可检验**的完成标准(跑什么命令、看到什么结果、改了哪些文件),验收环节按它判。\n` +
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

/**
 * 评审提示词。
 *
 * `round` 和历史是**后加的**,而它们的缺席正是评审循环不收敛的一半原因:此前这里只吃
 * `node.plan` —— 没有 reviewLog、没有轮次号、没有上一版方案,而 `node.reviewLog` 就挂在
 * 同一个对象上,一行没用。方案作者那边反而是有历史的(planPrompt 带「上一版方案」+
 * feedback),所以是**单边失明**:作者知道自己在改什么,评审员不知道自己在重复什么。
 */
/**
 * @param notice 已经算好的重复提示。**不在这里算。**
 *
 * 这个函数是 per-seat 的:5 席就调 5 次,而 `feedbackItems(node.reviewLog)` 在一轮之内
 * 结果完全相同。放在函数体里实测过 —— 5 席 × 3 轮 × 20 条时单次 752 ms,一轮 15 次 =
 * **11.3 秒的主线程同步阻塞**,期间整个界面(含别的节点正在跑的日志窗)不刷新。
 */
function reviewPrompt(
  node: TaskNode, tag: string, brief = '', notice = '', round = 1, maxRounds = 3,
): string {
  return brief +
    `请评审以下方案是否**足以开始执行**。方案:\n${quote(JSON.stringify(node.plan))}\n` +
    (notice ? notice + '\n' : '') +
    `这是第 ${round}/${maxRounds} 轮评审。` +
    // 「第 N 轮不过整个任务就中止」不是吓唬,是事实(见 stepStart 的 cap-iteration 分支)。
    // 评审员不知道自己手上握着什么,就会按「还能更好」的标准打分。
    `第 ${maxRounds} 轮仍不通过,这个任务会被整个中止,一行代码都不会写。\n` +
    `判据:\n` +
    `- blocking 只填**会让执行失败、或让产出没法验收**的问题。\n` +
    `- 方案不需要完美,只需要「能开始干、干完能按验收点验」。能达到这条就判通过。\n` +
    `- 可以更好但不阻塞的,写进 comments,**不要**放进 blocking(放进去等同于否决)。\n` +
    (round > 1
      // 这一条是冲着实测来的:一次运行里三轮评审提了 **12 条互不相同**的要求
      // (「缺少执行步骤」「缺少范围界定」「缺少输出物定义」……),全部只出现过一轮。
      // 方案每轮都在按上一轮改,而评审每轮都换一批新要求 —— 这种组合下迭代上限
      // 是必然会撞到的,和方案质量无关。
      ? `- **不要提出上一轮没有提过的新要求**,除非那是这一版新引入的缺陷。\n` +
        `  上一轮要求改的地方改了,就该判通过;换一个角度再挑一遍,这个任务就会被中止。\n`
      : '') +
    `输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(tag)
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
/**
 * 测试验证的提示词。
 *
 * 和验收的关键差别:它要求**真的把命令跑起来并贴出原始输出**,而不是判断产出描述。
 * 没有这一步,验收员只能给执行者的散文盖章 —— 这是本 fork 自己反复付过代价的那件事。
 */
function verifyPrompt(node: TaskNode, tag: string, brief = ''): string {
  return (
    brief +
    `请**实际运行**验证这次改动,不要只读执行者的自述。\n` +
    `验收点:${quote(node.plan.acceptance) || '(本节点未定义验收点,请依据目标判断:' + quote(ctxGoal(node)) + ')'}\n` +
    `执行者的自述(仅供参考,不能作为通过依据):${quote(node.execStatus) || '(没有报告任何产出)'}\n` +
    `要求:跑测试/构建/复现步骤,把**实际执行的命令与原始输出**写进 comments;` +
    `跑不起来、或没有可跑的验证手段,如实说明并判不通过。\n` +
    `**不要修改代码** —— 你的职责是验证,不是修复。发现问题填进 blocking 交回执行者。\n` +
    `输出:{ "pass":boolean, "blocking":string[], "comments":"命令与原始输出" }。` +
    answerRule(tag)
  )
}
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
/**
 * 测试验证前后的工作区指纹。
 *
 * 没有隔离池(非 git 仓库、池初始化失败)或没有本节点的 worktree 时返回 undefined ——
 * 此时无从比对,**不假装比对过**:静默放行和静默判失败都是撒谎,调用方看到 undefined
 * 就知道这道闸门这次没生效。
 */
async function verifySnapshot(node: TaskNode, ctx: PipelineCtx): Promise<string | undefined> {
  // !wt 是纵深防御:走到这里时 acquire 要么已经给了工作区、要么已经阻断了节点,
  // 所以它在 stepExecute 里不可达。留着是因为它一旦可达,后果是拿**用户主仓库**的
  // git status 当指纹 —— 他手头任何无关改动都会被算到验证者头上。
  const wt = node.worktree?.path
  if (!wt || !ctx.worktrees?.statusFingerprint) return undefined
  try { return await ctx.worktrees.statusFingerprint(wt) } catch { return undefined }
}

/** 往 execStatus 追一条编排器注记(不是执行者写的,integratePrompt 会把它过滤掉)。 */
function appendOrchestratorNote(cur: string, note: string): string {
  return `${cur}${cur ? '\n' : ''}${ORCHESTRATOR_NOTE}${note})`
}

function integrateSeats(node: TaskNode): RoleBinding[] {
  const own = node.phaseRoles.integrate ?? []
  return own.length > 0 ? own : (node.phaseRoles.accept ?? [])
}
/** 简报要从席位真正所属的那个环节读,否则回落时会去找一份不存在的角色定义。 */
function integrateBriefPhase(node: TaskNode): PhaseName {
  return (node.phaseRoles.integrate ?? []).length > 0 ? 'integrate' : 'accept'
}

/**
 * 这个环节被整个跳过了吗?
 *
 * **跳过 ≠ 清空席位。** 0 席在 plan/review/execute/accept 上的语义是「主模型顶上跑一次」,
 * 在 integrate 上是「回落到 accept 席位」—— 只有 verify/observer 真的不发生。所以跳过必须
 * 是显式早退,而席位**保持原样**(清空还会让关口说「未配置」而不是「已跳过」,并误触发
 * integrateSeats 的回落)。
 */
function isSkipped(ctx: PipelineCtx, phase: PhaseName): boolean {
  return (ctx.config.skipSteps ?? []).includes(phase)
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
/**
 * 分析环节的产出 —— 按 caps.planConverge 走两条路之一。
 *
 * 单席位时两条路**行为完全相同**(都是一次调用),不额外花钱、也不加融合那一次。
 */
async function runPlanPhase(
  node: TaskNode, ctx: PipelineCtx, feedback: string,
): Promise<PlanPhaseResult> {
  const seats = node.phaseRoles.plan ?? []
  if (ctx.config.caps.planConverge === '圆桌' && seats.length > 1) return runPlanRoundtable(node, ctx, feedback)
  return runPlanRefinement(node, ctx, feedback)
}

/**
 * 圆桌:N 席**并行**各自从零起草 → 最后一席融合成一份。
 *
 * 为什么融合由**最后一席**做:runPlanRefinement 今天的不变式就是「本环节的最终产出来自
 * 最后一席」。让融合也用最后一席,两种模式的不变式逐字节相同,costLine 的 P 项含义不变,
 * 而且它天然不是第一稿的作者。融合因此是精化的**严格推广** —— 最后一席看到的是全部 N 份,
 * 而不只是前一份。(第一席还不稳定:toggleRole 删席位时会重排,applyRosterToNodes 恢复时
 * 整份覆盖,同一节点两次运行的「第一席」可能不是同一个人。)
 *
 * 并发**必须**走 ctx.slots:runPlanRefinement 是串行的,所以 plan 阶段每节点只占一个在飞
 * 调用;不套池子就会复现 roundtable.ts 记录过的那个已修缺陷(parallelism 2 + 3 席面板
 * 实测峰值 6 个并发调用),而且是在 parallelism 个节点同时开的情况下。
 */
async function runPlanRoundtable(
  node: TaskNode, ctx: PipelineCtx, feedback: string,
): Promise<PlanPhaseResult> {
  const seats = node.phaseRoles.plan
  const tag = answerTag(ANSWER_TAGS.plan)
  const settled = await mapWithinPool(
    seats,
    seat => runPhase(ctx, {
      phase: 'plan', node, role: seat, system: 'plan',
      prompt: planPrompt(node, ctx, tag, feedback, seatBrief(ctx, seat, 'plan')),
      signal: ctx.signal,
    }, { phaseLabel: PHASE_LABEL.plan, round: node.iteration.planReview + 1, label: (seat?.roleName || seat?.roleTag) || '主模型', model: seat?.model }),
    ctx.slots,
  )
  const drafts: { staff: string; parsed: ReturnType<typeof parsePlanOutput> }[] = []
  const failures: string[] = []
  settled.forEach((r, i) => {
    const who = seats[i].roleName || '主模型'
    if (r.status !== 'fulfilled' || !r.value.ok) {
      failures.push(`${who}: ${r.status === 'fulfilled' ? r.value.reason : String(r.reason)}`)
      return
    }
    drafts.push({ staff: who, parsed: parsePlanOutput(r.value.text, tag) })
  })
  // 一份都没成 → 照旧阻断,和精化第一位失败时一致。
  if (drafts.length === 0) return { ok: false, reason: `全部方案席位调用失败: ${failures.join('; ')}` }
  // 只剩一份 → 没什么可融合的,直接用它(还省下融合那一次调用)。
  if (drafts.length === 1) {
    if (failures.length > 0) noteOnNode(node, `方案圆桌只有 1 份稿可用,未做融合: ${failures.join('; ')}`)
    return { ok: true, parsed: drafts[0].parsed }
  }
  const fuseSeat = seats[seats.length - 1]
  const fuseTag = answerTag(ANSWER_TAGS.plan)
  const fused = await runPhase(ctx, {
    phase: 'plan', node, role: fuseSeat, system: 'plan',
    prompt: fusePrompt(node, ctx, fuseTag, feedback, seatBrief(ctx, fuseSeat, 'plan'), drafts.map(d => d.parsed)),
    signal: ctx.signal,
  }, { phaseLabel: '方案融合', round: node.iteration.planReview + 1, label: (fuseSeat?.roleName || fuseSeat?.roleTag) || '主模型', model: fuseSeat?.model })
  if (!fused.ok) {
    // 融合那一次失败 → 回落到第一份成功的草稿。比整体阻断诚实:手上确实有可用的稿子。
    noteOnNode(node, `方案融合调用失败,采用第一份草稿(${drafts[0].staff}): ${fused.reason}`)
    return { ok: true, parsed: drafts[0].parsed }
  }
  const parsed = parsePlanOutput(fused.text, fuseTag)
  // 落选稿挂到融合结果上。**不静默截断**:三份稿只产出一份,另外两份不能凭空消失。
  parsed.plan.alternatives = drafts.map(d => ({
    staff: d.staff, solution: capText(d.parsed.plan.solution, ALT_SOLUTION_CHARS),
  }))
  if (failures.length > 0) noteOnNode(node, `方案圆桌有席位调用失败,已用其余稿融合: ${failures.join('; ')}`)
  return { ok: true, parsed }
}

/** 往 execStatus 追一条编排器注记(带前缀,否则 integratePrompt 会当成执行产出)。 */
function noteOnNode(node: TaskNode, note: string): void {
  const line = `${ORCHESTRATOR_NOTE}${note})`
  // 同一句注记不重复写。跳过分支在每轮返工里都会重新走一遍,实测三轮之后 execStatus
  // 里是同一句话叠了三遍(86 字符)—— 读的人会以为发生了三件事。
  if (node.execStatus.includes(line)) return
  node.execStatus = `${node.execStatus}${node.execStatus ? '\n' : ''}${line}`
}

/**
 * 融合提示词。
 *
 * 稿子**匿名**(稿 A/B/C,不写员工名):融合由最后一席做,而它自己也交了一份稿 —— 署名会
 * 让它偏袒自己那份。真名记在 node.plan.alternatives 里,供事后追责。
 */
function fusePrompt(
  node: TaskNode, ctx: PlanPromptCtx, tag: string, feedback: string, brief: string,
  drafts: ReturnType<typeof parsePlanOutput>[],
): string {
  const letters = drafts.map((d, i) => 
    `### 稿 ${String.fromCharCode(65 + i)}\n${quote(JSON.stringify({ ...d.plan, alternatives: undefined }))}\n子任务拆分:${quote(JSON.stringify(d.children))}`,
  ).join('\n\n')
  return (
    brief +
    `下面是 ${drafts.length} 份**各自独立**起草的方案。请合成**一份**最优方案。\n\n` +
    letters +
    `\n\n要求:\n` +
    `- **不是选一份**,是取各稿之长合成一份;某一稿的哪个点更好,就吸收哪个点。\n` +
    `- 在 keyPoints 里写清楚你吸收了哪几稿的哪些点、放弃了什么以及为什么。\n` +
    `- 子任务拆分同样要合成一份 —— 不是几份的并集,而是去重、补漏之后的那一份。\n` +
    planPrompt(node, ctx, tag, feedback)
  )
}

async function runPlanRefinement(
  node: TaskNode, ctx: PipelineCtx, feedback: string,
): Promise<PlanPhaseResult> {
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
    }, { phaseLabel: i === 0 ? PHASE_LABEL.plan : '方案精化', round: node.iteration.planReview + 1, label: (seat?.roleName || seat?.roleTag) || '主模型', model: seat?.model })
    if (!res.ok) {
      // 第一位就失败 → 手上没有任何稿子,照旧阻断。后面的人失败 → 已经有一份**解析通过**
      // 的稿子,拿它继续走评审,比把前面的工作全丢掉更诚实 —— 评审那关照样会挡。
      // 但必须留痕:静默降级成「少一位修订者」正是不静默截断要防的。
      // timeoutKind 必须跟着走。少了它,1046 行那句 `res.timeoutKind === 'human'` 就是
      // 一条**永远为 undefined 的死分支**(返回类型里根本没这个字段,而本仓库没有
      // typecheck 会说)—— 于是分析环节的等人超时拿到的是静默超时那一版建议。
      if (i === 0) return { ok: false, reason: res.reason, timeout: res.timeout, timeoutKind: res.timeoutKind }
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
    } else if (isSkipped(ctx, 'plan')) {
      // 跳过分析 = 本次不出方案、不主动拆子任务。
      //
      // node.kind 是 plan 的产出,不设它的话 advanceableKind 对 'unknown' 恒返回 null ——
      // 节点永久不可推进,调度器每一轮都跳过它(实测)。
      //
      // childIds 守卫必须复制正常路径那一条:plan 在飞时别的节点可能已经把子节点挂上来了,
      // 直接判成 executable 会让那棵子树被孤儿化。
      // 只设 executable 即可:评审之后的路由(:977)会在 childIds 非空时把它改判成
      // decompose + WAITING_CHILDREN。在这里再判一次是冗余 —— 实测把它写死成
      // 'executable',带子节点的用例照样通过,因为下游兜住了。
      node.kind = 'executable'
      noteOnNode(node, '分析环节已跳过:本节点不出方案,也不主动拆子任务')
      lastChildren = []
      if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    } else {
      if (!(await commit(node, 'PLANNING', ctx))) return
      const res = await runPlanPhase(node, ctx, feedback)
      if (!res.ok) {
        await blockWithReason(
          node, res.reason, ctx, res.timeout ? 'timeout' : undefined,
          res.timeoutKind === 'human' ? humanTimeoutRemedy() : undefined,
        )
        return
      }
      const parsed = res.parsed
      node.kind = parsed.kind
      node.plan = parsed.plan
      lastChildren = parsed.children
      if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    }
    if (isSkipped(ctx, 'review')) {
      // 名册上还挂着评审员,记录却一片空白 —— 不写一行的话,这在 node.md 上读起来像
      // 「跑了但记录丢了」。写「已跳过」是为了让这两件事在事后追责时分得开。
      noteOnNode(node, '质疑讨论环节已跳过:本节点的方案没有经过任何评审')
    } else {
    const reviewNotice = reviewRepeatNotice(feedbackItems(node.reviewLog), node.iteration.planReview + 1)
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1,
      system: 'review',
      // 一轮算一次,不是一席算一次:reviewLog 在这一轮之内不变。
      buildPrompt: (tag, seat) =>
        reviewPrompt(node, tag, seatBrief(ctx, seat, 'review'), reviewNotice, node.iteration.planReview + 1, caps.maxIterations),
      ctx,
    })
    node.reviewLog.push(rec)
    // runRoundtable resolves even when the run was cancelled mid-flight (it collects
    // whatever settled). Without this the node would go on to commit READY/WAITING_CHILDREN
    // after the user already cancelled.
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody judged the plan — say that rather than blaming the plan.
      await blockWithReason(node, `评审角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec), exhaustionRemedyFor(rec))
      return
    }
    if (!rec.synthesized.pass) {
      node.iteration.planReview++
      // **累积**反馈,不是只带最后一轮。
      //
      // 此前是 `feedback = rec.synthesized.blockingSummary`,每轮覆盖 —— 方案作者从来
      // 没同时看到过三轮意见,它每次都在打地鼠:第 1 轮的意见在第 2 轮被改跑偏,第 3 轮
      // 又提回来,三轮烧完,说的其实是同一件事。
      const items = feedbackItems(node.reviewLog)
      feedback = planFeedbackPrompt(items) || rec.synthesized.blockingSummary
      if (node.iteration.planReview >= caps.maxIterations) {
        // 触顶时点名**哪几条是连着几轮没解决的**,并按这个事实给下一步 —— 静态的一句
        // 「可提高 caps.maxIterations」在「同一条连提三轮」的情况下是误导。
        await blockWithReason(node, exhaustionReason(items, caps.maxIterations), ctx, 'cap-iteration', exhaustionRemedy(items))
        return
      }
      continue
    }

    }
    // 跳过评审时**不写 reviewLog** —— 一条 PASS 记录 = 谎报有人评审过,而 node.md 是
    // 用户事后追责的依据。跳过 ≠ 通过。评审之后的路由(深度上限/建子节点)原样跑。
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
  const seats = node.phaseRoles.observer ?? []
  // 跳过与「没配席位」在这两个环节上等价 —— 它们本来就是 opt-in。
  // 但**配了席位再跳**要留痕:名册上挂着 watcher、评分一片空白、没有任何解释,和跳过
  // 质疑讨论时是同一种歧义。没配席位就不写 —— 那本来就不算「跳过了」。
  if (seats.length > 0 && isSkipped(ctx, 'observer')) {
    noteOnNode(node, '观察环节已跳过:本节点没有评分,低分返工不会发生')
    return false
  }
  if (seats.length === 0 || isSkipped(ctx, 'observer')) return false // opt-in: no observer, no scoring, no fallback to the main model
  const tag = answerTag(ANSWER_TAGS.score)
  // 每个席位独立打分,并行 —— 和圆桌同构。取最低分收敛成一个结论(显示宽容的那个数会
  // 掩盖阈值要抓的情况),其余理由挂在 others 上而不是丢掉。
  const results = await mapWithinPool(
    seats,
    seat => runPhase(ctx, {
      phase: 'observer', node, role: seat, system: 'observer',
      prompt: scorePrompt(node, tag, seatBrief(ctx, seat, 'observer')), signal: ctx.signal,
      cwd: node.worktree?.path,
    }, { phaseLabel: PHASE_LABEL.observer, round: node.iteration.scoring + 1, label: (seat?.roleName || seat?.roleTag) || '主模型', model: seat?.model }),
    ctx.slots,
  )
  type Pair = { role: string; ok: boolean; plan: { score: number; rationale: string }; exec: { score: number; rationale: string } }
  const pairs: Pair[] = results.map((r, i) => {
    const who = seats[i].roleName || 'main'
    if (r.status !== 'fulfilled' || !r.value.ok) {
      // 评分调用失败**不能**让节点失败:验收已经通过,评分是咨询性的。记下为什么没有
      // 这个数,而不是丢掉已经完成的工作。
      const why = `评分调用失败: ${r.status === 'fulfilled' ? r.value.reason : String(r.reason)}`
      return { role: who, ok: false, plan: { score: 0, rationale: why }, exec: { score: 0, rationale: why } }
    }
    const parsed = parseScoreOutput(r.value.text, tag)
    return { role: who, ok: true, plan: parsed.plan, exec: parsed.exec }
  })
  // 真正判决过的席位。调用失败被折成 score 0,如果让它参与排序,它必然成为最低分 ——
  // 于是一次网络抖动就把节点的展示分变成 0,并(配了阈值时)买下一整轮带写工具的执行。
  // 旧代码在调用失败时直接 return false,这条回归是本轮改成多席位时引入的。
  const judged = pairs.filter(x => x.ok)
  const pick = (dim: 'plan' | 'exec'): ScoreRecord => {
    // 主记录只在判决过的席位里选;失败的席位仍然记进 others,原因不丢。
    const ranked = (judged.length > 0 ? judged : pairs)
    const sorted = [...ranked].sort((x, y) => x[dim].score - y[dim].score)
    const low = sorted[0]
    const rest = [...sorted.slice(1), ...(judged.length > 0 ? pairs.filter(x => !x.ok) : [])]
    return {
      role: low.role, score: low[dim].score, rationale: low[dim].rationale,
      ...(rest.length > 0
        ? { others: rest.map(o => ({ role: o.role, score: o[dim].score, rationale: o[dim].rationale })) }
        : {}),
    }
  }
  node.score = { plan: pick('plan'), exec: pick('exec') }
  const threshold = ctx.config.caps.scoreThreshold
  if (threshold === undefined) return false // 默认仅记录
  // 没有任何席位真正判决过 → 不返工。验收已经通过,评分是咨询性的:不能因为一次调用
  // 失败丢掉已完成的工作,更不能让它买下一整轮执行。
  if (judged.length === 0) return false
  const worst = Math.min(node.score.plan!.score, node.score.exec!.score)
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
        }, {
          // 不是「执行」:它和主执行流是两件事,共用一个表头会让人以为执行跑了两遍。
          phaseLabel: '解决合并冲突',
          round: node.iteration.mergeResolve + 1,
          label: (firstRole(node, 'execute')?.roleName || firstRole(node, 'execute')?.roleTag) || '主模型',
          model: firstRole(node, 'execute')?.model,
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
          if (isSkipped(ctx, 'accept')) {
            // 跳过验收的第三个调用点(自动解冲突后的复验)。
            //
            // **必须和通过分支走同一个出口** `return mergeAndRelease(node, ctx, true)`,
            // 不能自己拍板 ACCEPTED。这里是 mergeAndRelease 内部,函数签名是 Promise<boolean>:
            //  - 裸 `return` 返回 undefined,调用方的 `if (!(await mergeAndRelease(...)))`
            //    会把成功当失败;
            //  - 更糟的是自己 commit ACCEPTED —— 执行者在这一轮给自己挂了补救子任务时,
            //    调用方本该把它置成 WAITING_CHILDREN。实测:冲突 + 跳过验收 → 父节点
            //    ACCEPTED(终态),子节点停在 CREATED 永远不被调度,run 报告完成而那个
            //    子任务一次都没跑。
            // triedThisRun=true 也不能漏:漏了的话重入时 attempted 停在 false,升级卡会说
            // 「自动解决机会已在此前用完,本次未再尝试」,而本次实实在在跑了一次解冲突。
            noteOnNode(node, '自动解决冲突后的复验已跳过')
            return mergeAndRelease(node, ctx, true)
          }
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
  if (isSkipped(ctx, 'execute')) {
    // 早退必须在 acquire **之前**:放后面的话,每个被跳过的节点仍会真的 git worktree add
    // 一个分支再 release。放前面 node.worktree 为 undefined,mergeAndRelease 直接短路。
    //
    // 必须往 execStatus 写一行,否则 acceptPrompt / integratePrompt 会渲染成空槽;而且
    // 这一行**必须带编排器前缀** —— 否则 integratePrompt 的 realWork 过滤器会把它当成
    // 「本节点自己的执行产出(已合入集成分支)」交给集成验收员。
    //
    // 不早退而只是「不调模型」的话,空产出闸门会让节点空转 maxIterations 圈再阻断,
    // 一次模型调用都没有,而阻断信息还在指责执行者没干活。
    noteOnNode(node, '执行环节已跳过:本节点没有产生任何代码改动')
  } else if (ctx.worktrees && !node.worktree) {
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
    if (isSkipped(ctx, 'accept')) {
      // 跳过验收的第二个调用点。人手改过的冲突解决代码因此**零评审直接合入** ——
      // 这是用户选择跳过验收的代价,关口文案里写明了。
      noteOnNode(node, '人工解决冲突后的验收已跳过')
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
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
    if (!isSkipped(ctx, 'execute')) {
    // 跳过执行时整块不跑 —— **不能**只是「不调模型」:空产出闸门会让节点空转
    // maxIterations 圈再阻断,一次模型调用都没有,而阻断信息还在指责执行者没干活。
    // execStatus 里已经有跳过的注记(带编排器前缀),验收/集成验收因此不会渲染成空槽。
    // node.execStatus still holds the PREVIOUS round's result here (it's overwritten below),
    // which is exactly what executePrompt renders on rework.
    const execTag = answerTag(ANSWER_TAGS.exec)
    const execSeat = firstRole(node, 'execute')
    const res = await runPhase(ctx, { phase: 'execute', node, role: execSeat, system: 'execute', prompt: executePrompt(node, ctx, execTag, feedback, syncNote, seatBrief(ctx, execSeat, 'execute')), cwd: node.worktree?.path, signal: ctx.signal },
      // round 用的是 stepExecute 的局部轮次:返工每一轮都是一次独立的执行,合成一条流
      // 会让「第三轮才修好」读起来像「一直在改同一件事」。
      { phaseLabel: PHASE_LABEL.execute, round, label: (execSeat?.roleName || execSeat?.roleTag) || '主模型', model: execSeat?.model })
    if (!res.ok) {
      // Keep whatever the executor managed to report before the interruption. It ran with
      // write tools, so discarding this can leave the repo changed with no record of it.
      const partial = res.text ? parseExecOutput(res.text, execTag).execStatus.trim() : ''
      if (partial) node.execStatus = `${partial}\n(注:本轮在完成前被中断,以上为中断时已报告的产出)`
      await blockWithReason(
        node, res.reason, ctx, res.timeout ? 'timeout' : undefined,
        res.timeoutKind === 'human' ? humanTimeoutRemedy() : undefined,
      )
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
    // 执行者的自述覆盖**上一轮的自述**,但不能连编排器注记一起冲掉。那些注记记的是
    // 「这个环节整个没跑过」这类事实(跳过分析/质疑讨论都写在 stepStart 里),被这一行
    // 覆盖之后 node.md 上就只剩「名册挂着评审员、评审记录一片空白、没有任何解释」——
    // 正是注记要消除的那种歧义。实测:跳过质疑讨论的 executable 节点走完 stepExecute
    // 后,node.md 里搜不到「质疑讨论环节已跳过」。
    const keptNotes = node.execStatus.split('\n').filter(l => l.startsWith(ORCHESTRATOR_NOTE))
    node.execStatus = [reported, ...keptNotes].join('\n')

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

    }

    // 测试验证(spec §7.1)。**只在配了这个环节的角色时存在** —— 没配就整个不发生,
    // 行为与引入它之前逐字节相同。
    //
    // 它和执行是不同的动机:执行者有动机说「做完了」;它和验收是不同的证据:验收判
    // 「达没达成验收点」读的是产出描述,测试验证判「跑起来对不对」要真的执行命令。
    // 没有这一步,验收员只能给执行者的散文盖章。
    // 配了席位却被跳过时要留痕 —— 名册上挂着 tester、验证记录空白、没有解释,
    // 和跳过质疑讨论时是同一种歧义。没配席位就不写:那本来就是 opt-in,不算「跳过了」。
    if ((node.phaseRoles.verify ?? []).length > 0 && isSkipped(ctx, 'verify')) {
      noteOnNode(node, '测试验证环节已跳过:没有实跑过任何测试')
    }
    if ((node.phaseRoles.verify ?? []).length > 0 && !isSkipped(ctx, 'verify')) {
      if (!(await commit(node, 'VERIFYING', ctx))) return
      // 验证者**不该改代码**,而工具清单挡不住这件事:Bash 本身就能写(echo >、sed -i、
      // git apply)。所以真正的探针是前后比对工作区 —— 断言它的工具集里没有 Edit/Write
      // 与「它会不会改代码」毫无关系。
      const before = await verifySnapshot(node, ctx)
      const v = await roundtableWithInfraRetry({
        phase: 'verify', node, roles: node.phaseRoles.verify, round: node.iteration.acceptance + 1,
        system: 'verify',
        buildPrompt: (tag, seat) => verifyPrompt(node, tag, seatBrief(ctx, seat, 'verify')),
        ctx, cwd: node.worktree?.path,
      })
      node.acceptLog.push({ ...v.rec, step: 'verify' })
      const after = await verifySnapshot(node, ctx)
      if (before !== undefined && after !== undefined && before !== after) {
        // 它动了工作区。这一轮裁决作废:一个「跑完测试顺手把它改绿」的验证等于没有验证。
        // 走返工而不是直接阻断 —— 执行者还有预算,而且现在工作区里多了一些没人评审过的
        // 改动,必须让下一轮把它们纳入正常流程。
        node.iteration.acceptance++
        const why = '测试验证环节改动了工作区,该轮裁决作废(验证者只应验证,不应修复)'
        if (node.iteration.acceptance >= caps.maxIterations) {
          await blockWithReason(node, `${why};迭代已用尽(${caps.maxIterations})`, ctx, 'rework')
          return
        }
        node.execStatus = appendOrchestratorNote(node.execStatus, why)
        // 同样要进 feedback:execStatus 里的注记只在 feedback 非空时才被渲染进提示词,
        // 只写 execStatus 等于写给没人看的地方。
        feedback = why
        if (!(await commit(node, 'REWORK', ctx))) return
        continue
      }
      if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
      if (v.infraExhausted) {
        await blockWithReason(node, `测试验证角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${v.rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(v.rec), exhaustionRemedyFor(v.rec))
        return
      }
      if (!v.rec.synthesized.pass) {
        // 失败走已有的返工路径,和验收失败同一条,共用 iteration.acceptance —— 不新增
        // 预算维度。但阻断文案要说清是**哪一关**没过,否则升级卡片和 --retry-blocked
        // 会拿到一句「验收迭代超限」,而其实是测试没跑通。
        //
        // **把原因交给执行者。** 不设 feedback 的后果实测过:第 1 轮和第 2 轮的执行提示词
        // 逐字节相同(只有随机 answer tag 不同),三轮空转后阻断 —— verifyPrompt 花整段
        // 要来的「实际执行的命令与原始输出」一次也到不了能修它的人。更糟的是 feedback 是
        // 循环外变量:不覆盖它,执行者会拿到**两轮之前、另一道关口**的意见,还被告知那是
        // 「上一轮」的。
        feedback = v.rec.synthesized.blockingSummary
        node.iteration.acceptance++
        if (node.iteration.acceptance >= caps.maxIterations) {
          await blockWithReason(node, `测试验证迭代超限(${caps.maxIterations}): ${v.rec.synthesized.blockingSummary}`, ctx, 'rework')
          return
        }
        if (!(await commit(node, 'REWORK', ctx))) return
        continue
      }
    }

    // Acceptance. Reviewer-CALL failures retry the roundtable on their own budget (see
    // roundtableWithInfraRetry) — redoing the executor's real work over a flaky connection
    // would be wrong, and charging those retries to the rework budget would consume every
    // attempt the executor was owed.
    if (isSkipped(ctx, 'accept')) {
      // **三个调用点全部跳过**(主循环 + 人工解冲突后 + 自动解冲突后)。只跳主循环的话,
      // 验收会在「最该有人看」的冲突解决场景悄悄复活 —— 那是更坏的惊喜。
      //
      // 不写 acceptLog:跳过 ≠ 通过。但要在 execStatus 上留一行,否则 node.md 是
      // 「名册挂着 qa、验收记录空白、状态 ACCEPTED」—— 读起来像记录丢了,不像没跑过。
      noteOnNode(node, '验收环节已跳过:本节点的产出未经任何人核对就合进集成分支')
      if (firstRole(node, 'observer') && !isSkipped(ctx, 'observer') && !(await commit(node, 'SCORING', ctx))) return
      if (await scoreNode(node, ctx)) {
        if (!(await commit(node, 'REWORK', ctx))) return
        continue
      }
      if (ctx.worktrees && node.worktree && !(await commit(node, 'MERGE', ctx))) return
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    if (!(await commit(node, 'ACCEPTANCE', ctx))) return
    const { rec, infraExhausted } = await roundtableWithInfraRetry({
      phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1,
      system: 'accept', buildPrompt: (tag, seat) => acceptPrompt(node, tag, seatBrief(ctx, seat, 'accept')), ctx, cwd: node.worktree?.path,
    })
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (infraExhausted) {
      // Nobody ever judged the work — say that, rather than blaming the work.
      await blockWithReason(node, `验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec), exhaustionRemedyFor(rec))
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
    if (isSkipped(ctx, 'integrate')) {
      // 跳过集成验收。连带后果(关口要说):补救子任务的唯一入口没了,而且 scoreNode 也
      // 一起没了 —— 所有拆分型节点包括根再也不会被评分,整个 run 的最终分消失。
      //
      // mergeConflict 不用在这里再挡一次 —— stepIntegrate 前面已有一道守卫会先触发
      // (实测阻断信息来自那一道)。在这里重复一份是死代码,而死代码会让人以为
      // 保护来自这里,下次改前面那道时就没人知道它是唯一的那道。
      noteOnNode(node, '集成验收已跳过:子任务各自通过即视为本节点达成')
      if (ctx.worktrees && node.worktree && !(await commit(node, 'MERGE', ctx))) return
      if (!(await mergeAndRelease(node, ctx))) return
      await commit(node, 'ACCEPTED', ctx)
      return
    }
    const runIntegrate = async () => roundtableWithInfraRetry({
      // 集成提交(integrate)自己的席位。
      //
      // 回落到 accept 是**兼容**,不是默认:老 run.md 和没配这个环节的用户照旧由验收
      // 角色承担,行为逐字节不变。但一旦用户配了「集成提交」,它就不再借用验收席位 ——
      // 此前两者共用 phaseRoles.accept,规范告诉用户这是两个环节,系统却当成一个。
      phase: 'accept', node, roles: integrateSeats(node),
      round: node.iteration.integration + 1, system: 'integrate',
      // 见 phaseLabel 的注释:不显式给的话,整个 run 的最终裁决会被标成「验收」。
      phaseLabel: PHASE_LABEL.integrate,
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
      await blockWithReason(node, `集成验收角色连续 ${caps.maxIterations} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx, exhaustionCategory(rec), exhaustionRemedyFor(rec))
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
