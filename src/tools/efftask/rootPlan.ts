// 启动关口第三关 (spec §2):
//   "编排器先用 plan 阶段角色起草根节点的完整方案 + 顶层子节点拆分(仅第一层),
//    渲染出来给用户确认/修改,再开始自主执行。"
//
// This module is the DRAFT half — pure logic, no React, no orchestrator. The gate view
// renders what it returns and hands the approved result back through `applyRootDraft`.
//
// It deliberately reuses `planPrompt` and `parsePlanOutput` rather than asking its own
// question. A separate prompt here would mean the plan the user approves and the plan the
// run would have produced answer two different questions, and the difference would only
// surface after the gate — the exact "gate describes something other than the run" failure
// the confirmation gates exist to prevent.
import { ANSWER_TAGS, answerTag, parsePlanOutput } from './parseOutput.js'
import { planPrompt } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'
import { createNode } from './types.js'
import type { EffTaskConfig, NodeKind, NodePlan, TaskNode } from './types.js'

export interface ChildSpec { title: string; deps: string[] }
export interface RootDraft {
  kind: NodeKind
  plan: NodePlan
  children: ChildSpec[]
}

/**
 * The run's root node.
 *
 * ONE definition, shared with the orchestrator. The gate builds a root, drafts a plan into
 * it and hands it back as the run's seed, so a second copy of this construction would let
 * the two disagree about the root's id, goal or roster — and the id is what every child id
 * is derived from.
 */
export function rootTitle(goal: string): string {
  // First NON-EMPTY line: a goal that opens with a blank line still has a real title.
  const line = goal.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  // Slice CODE POINTS, matching persistence.slugify — a UTF-16 slice can strand a lone
  // surrogate, and this title is rendered into run.md and into prompts.
  return Array.from(line).slice(0, 80).join('') || '根任务'
}

export function makeRootNode(cfg: EffTaskConfig, now: string): TaskNode {
  // root goal = the FULL goalPrompt (title is only a truncated display label); ctxGoal
  // reads node.goal, so the plan prompt must see the whole objective, not the truncation.
  return createNode({
    id: 'root',
    title: rootTitle(cfg.goalPrompt),
    goal: cfg.goalPrompt,
    parentId: null,
    deps: [],
    depth: 0,
    phaseRoles: cfg.phaseRoles,
    now,
  })
}

export type DraftResult = { ok: true; draft: RootDraft } | { ok: false; reason: string }

/**
 * One plan-role call against the root node.
 *
 * `feedback` carries the user's 修改意见 from a previous pass at this same gate. It goes
 * through planPrompt's existing revision channel — which also shows the model its previous
 * plan — so "改成三步、把测试拆出来" revises rather than restarts.
 *
 * Never throws: a failed draft is a degraded gate, not a dead run. The caller offers to
 * start anyway, and the run then drafts the root plan itself exactly as it did before this
 * gate existed.
 */
export async function draftRootPlan(args: {
  root: TaskNode
  config: EffTaskConfig
  runAgent: RunAgentFn
  signal: AbortSignal
  feedback?: string
}): Promise<DraftResult> {
  const { root, config, runAgent, signal } = args
  const tag = answerTag(ANSWER_TAGS.plan)
  // byId holds only the root: it has no deps and no children yet, so depsSection renders
  // empty — the same string the run's first plan call would produce.
  const ctx = { config, byId: new Map([[root.id, root]]) }
  let text: string
  try {
    text = await runAgent({
      phase: 'plan',
      node: root,
      role: config.phaseRoles.plan[0] ?? null,
      system: 'plan',
      prompt: planPrompt(root, ctx, tag, args.feedback ?? ''),
      signal,
    })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  // An abort observed after the call must not be reported as a plan: the user is bailing
  // out, and rendering a gate for a run they just cancelled is worse than saying nothing.
  if (signal.aborted) return { ok: false, reason: '已中断' }
  const parsed = parsePlanOutput(text, tag)
  return { ok: true, draft: { kind: parsed.kind, plan: parsed.plan, children: parsed.children } }
}

/**
 * Seal the approved draft into the root node.
 *
 * `confirmedDraft` is what makes the approval BIND: stepStart consumes it instead of making
 * its own first plan call. Setting only `plan`/`kind` would have looked identical at the
 * gate and been silently discarded on the run's first step.
 */
export function applyRootDraft(root: TaskNode, draft: RootDraft, now: string): void {
  root.kind = draft.kind
  root.plan = { ...draft.plan }
  // An executable root has no children, and an empty list must still mean "confirmed":
  // presence of the field is the signal, not its length.
  root.confirmedDraft = { children: draft.children.map(c => ({ title: c.title, deps: [...c.deps] })) }
  root.updatedAt = now
}

/**
 * 第三关的飞书**通知**卡 —— 明确不是确认卡。
 *
 * The other two gates race a Feishu card because their decision is {approved, parallelism},
 * two values a card action can carry. This gate's 修改 is free text, which the permission-
 * callback protocol has no channel for. But saying nothing was worse: a user who approved
 * gates 1 and 2 FROM FEISHU got no further messages at all, and the run sat at the third gate
 * waiting for a keystroke nobody was there to press — the Feishu path simply dead-ended.
 *
 * So: send the plan and the tree, and say plainly that the answer has to come from the
 * terminal. A notification that admits its own scope beats silence, and beats a card with
 * buttons that decide something different from what the terminal offers.
 */
export function buildRootPlanNoticeCard(args: {
  goalPrompt: string
  draft: RootDraft
  drafted: boolean
  runId?: string
}): object {
  const { draft, drafted } = args
  const clip = (s: string, max: number): string => {
    const cps = Array.from(s)
    return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s
  }
  const section = (title: string, body: string): string =>
    `**${title}**\n${clip(body.trim() || '(空)', 400)}`
  const lines = [
    `**目标**: ${clip(args.goalPrompt.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '', 120)}`,
    drafted ? section('完整方案', draft.plan.solution) : '**未能起草根方案**,确认后将由 plan 角色在运行中自行起草。',
    ...(drafted ? [section('验收点', draft.plan.acceptance)] : []),
    `**初始任务树 · 第一层**(${drafted ? `${draft.children.length} 个` : '未起草'})\n` +
      childLines(draft, drafted).map(l => `- ${l}`).join('\n'),
    // The whole point of the card. Without this the reader waits for buttons that never come.
    '⚠️ **本关口只能在终端确认**(可以改方案,是自由文本,飞书卡片没有这个通道)。请回到终端按回车确认、或按 e 提修改意见。',
  ]
  return {
    config: { wide_screen_mode: true },
    header: {
      // Grey/blue: nothing is wrong and nothing is being asked OF the card. It must not look
      // like the startup card, which IS answerable here.
      template: 'blue',
      title: { tag: 'plain_text', content: `高效任务模式 · 根方案待确认${args.runId ? ` (${args.runId})` : ''}` },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n\n') } }],
  }
}

/**
 * Problems that make `createChildren` REJECT the whole batch, sending stepStart back to the
 * plan role — which discards the tree the user just approved and builds a different one.
 *
 * Distinct from the per-child 无效依赖 warning below: that one loses an edge, this one loses
 * everything. The gate is the only place a human can see it coming.
 */
export function draftBlockers(draft: RootDraft): string[] {
  const out: string[] = []
  const titles = draft.children.map(c => c.title)
  const dupes = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))]
  if (dupes.length > 0) out.push(`子任务标题重复(${dupes.join('、')})——依赖只能按标题引用,这会让整批子任务被退回重拟`)
  // Sibling deps only; resolved by title within the batch, exactly as createChildren does.
  const index = new Map(titles.map((t, i) => [t, i]))
  const edges = draft.children.map(c => c.deps.map(d => index.get(d)).filter((i): i is number => i !== undefined))
  const state = new Array(draft.children.length).fill(0)
  const hasCycle = (i: number): boolean => {
    if (state[i] === 1) return true
    if (state[i] === 2) return false
    state[i] = 1
    for (const j of edges[i]) if (j !== i && hasCycle(j)) return true
    state[i] = 2
    return false
  }
  if (draft.children.some((_, i) => hasCycle(i))) {
    out.push('子任务依赖成环——这会让整批子任务被退回重拟')
  }
  return out
}

/** Gate rendering: one line per first-level child, with its sibling dependencies named. */
export function childLines(draft: RootDraft, drafted = true): string[] {
  // A FAILED draft has no tree at all. Rendering the empty list as "不拆分,根任务直接执行"
  // asserted a decision nobody made, and directly contradicted the error line above it, which
  // says the plan role will draft (and probably decompose) at run time.
  if (!drafted) return ['(未能起草,运行时由 plan 角色重新拆分)']
  if (draft.children.length === 0) return ['(不拆分,根任务直接执行)']
  return draft.children.map((c, i) => {
    // Deps are sibling TITLES at this stage — ids do not exist until createChildren runs.
    // A dep naming no sibling is reported rather than hidden: createChildren silently drops
    // it, so this gate is the only place a user can catch a typo'd dependency.
    const known = new Set(draft.children.map(x => x.title))
    const bad = c.deps.filter(d => !known.has(d) || d === c.title)
    const good = c.deps.filter(d => known.has(d) && d !== c.title)
    const dep = good.length > 0 ? `依赖: ${good.join('、')}` : '无依赖'
    const warn = bad.length > 0 ? ` · 无效依赖(将被忽略): ${bad.join('、')}` : ''
    return `${i + 1}. ${c.title} — ${dep}${warn}`
  })
}
