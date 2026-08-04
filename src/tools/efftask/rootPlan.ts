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
import { ANSWER_TAGS, answerTag, hollow, MIN_FIELD_CHARS, parsePlanOutput } from './parseOutput.js'
import type { StreamHandle } from './agentStream.js'
import { planPrompt, seatPreamble, type PlanPromptCtx } from './pipeline.js'
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
  /**
   * Whether this run will execute children in separate git worktrees.
   *
   * planPrompt uses it to decide whether to warn the planner about spec §16's biggest risk
   * (independent siblings editing one file, the later merge conflicting). At the third gate
   * the isolation pool is already resolved, so the draft the user approves is planned under
   * the same rules the run will use — otherwise the gate would show a decomposition made
   * without the constraint the run then enforces.
   */
  worktrees?: PlanPromptCtx['worktrees']
  /** 告诉方案作者「你在哪」。缺了它,它只能照着标题写一句正确的废话。 */
  cwd?: string
  /**
   * 第三关的实时窗口。
   *
   * 这是整个运行里最长的单次调用之一(要读代码、拆任务),而它此前**完全没接输出** ——
   * 用户面对的是一屏纯文字的「正在起草根方案…」,不知道模型是在读文件还是卡死了。
   */
  stream?: StreamHandle
  /** 自动重拟那一次的窗口。工厂函数:一次调用一个句柄。 */
  retryStream?: () => StreamHandle
}): Promise<DraftResult> {
  const { root, config, runAgent, signal } = args
  const tag = answerTag(ANSWER_TAGS.plan)
  // byId holds only the root: it has no deps and no children yet, so depsSection renders
  // empty — the same string the run's first plan call would produce.
  const ctx = { config, byId: new Map([[root.id, root]]), worktrees: args.worktrees, cwd: args.cwd }
  // 两次调用同一席 —— 取一次,免得重拟那次悄悄换了人。
  const seat = config.phaseRoles.plan[0] ?? null
  let text: string
  try {
    text = await runAgent({
      phase: 'plan',
      node: root,
      role: config.phaseRoles.plan[0] ?? null,
      system: 'plan',
      /**
       * **第五个参数(前言)不许省。**
       *
       * 它是 `seatBrief`(这一席的角色简报)+ 定向注入(用户在 /et 提示词里点名给分析环节
       * 或给这一席的话)的唯一通道,而这里是根节点分析调用的**正常路径** ——
       * 用户在第三关批准之后,`stepStart` 会消费 `confirmedDraft` 并**跳过它自己那次
       * plan 调用**。所以省掉它的后果不是「少一段」,是「整棵树的第一份方案什么都收不到」:
       * 角色简报从来没到过根方案作者手上(这一条比定向注入更早就断着),而
       * 「分析时先按文件边界拆」这类话被写在提示词里、抽取对了、关口也显示了,
       * 却一个字都不会进那次调用。
       */
      prompt: planPrompt(root, ctx, tag, args.feedback ?? '', seatPreamble(ctx, seat, 'plan', root)),
      signal,
      stream: args.stream,
    })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  // An abort observed after the call must not be reported as a plan: the user is bailing
  // out, and rendering a gate for a run they just cancelled is worse than saying nothing.
  if (signal.aborted) return { ok: false, reason: '已中断' }
  let parsed = parsePlanOutput(text, tag)
  /**
   * 空方案**自动重拟一次**,不要端给用户。
   *
   * 实测第一版产出:一句「对 X 项目进行全面的代码审查」,重点/风险点/验收点全空 ——
   * 而第三关把它原样渲染成「(空)」。让用户按 e 手动提意见,等于把「模型偷懒了」这件事
   * 转嫁给用户去发现。一次就够:再空就如实端出去,并由 draftBlockers 在关口上列清楚,
   * 免得无限重试烧钱。
   */
  const gaps = planGaps(parsed.plan)
  if (gaps.length > 0 && !signal.aborted) {
    const retryTag = answerTag(ANSWER_TAGS.plan)
    try {
      const again = await runAgent({
        phase: 'plan', node: root, role: config.phaseRoles.plan[0] ?? null, system: 'plan',
        /**
         * 重拟的提示词有两处**必须**这么写,验收各踩过一次:
         *
         * 1. `{ ...root, plan: parsed.plan }` —— planPrompt 读的是 `node.plan`,而 root 的
         *    plan 要等这个函数**返回之后**才被写(applyRootDraft)。直接传 root,模型看到的
         *    「上一版方案」是 `{"solution":"","keyPoints":"",…}` 四个空串 —— 它根本看不到
         *    自己刚写的那几十个字,「针对性修订」这条通道第一轮就不成立,只能从头再答一次。
         *    这也正是重拟结果容易比第一版更浅的结构性原因。
         * 2. **用户的修改意见要带上**。args.feedback 是用户在第三关按 e 亲手输入的;不带的话
         *    重拟等于把他的话丢了,而关口底部还写着「已按你的意见重拟」。
         */
        prompt: planPrompt(
          { ...root, plan: parsed.plan }, ctx, retryTag,
          [args.feedback, `上一版方案不合格:${gaps.join(';')}。请补齐这几处,其余部分保留。`]
            .filter(Boolean).join('\n'),
          // 重拟同样要带前言 —— 少了它,这一次调用比第一次知道得**更少**,而它的任务是补齐。
          seatPreamble(ctx, seat, 'plan', root),
        ),
        signal, stream: args.retryStream?.(),
      })
      if (!signal.aborted) {
        const re = parsePlanOutput(again, retryTag)
        if (isBetterDraft(re, parsed, gaps.length)) parsed = re
      }
    } catch {
      // 重拟失败就用第一版 —— 关口会把空字段列出来,用户仍然看得见真相。
    }
  }
  // 重拟途中被中断时也要报中断,别端出一份半成品。第一次调用后 abort 走的是上面那条
  // ok:false,两条路径的语义必须一样 —— 不一样的话,调用方按 ok 分支处理就会分叉。
  if (signal.aborted) return { ok: false, reason: '已中断' }
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
/**
 * 一份方案里**空着**的字段。
 *
 * 实测:目标「认真 review 下当前目录下的代码」产出的根方案是一句
 * 「对 X 项目进行全面的代码审查,涵盖架构、安全、性能……」,重点/风险点/验收点**全空**,
 * 而第三关把它原样渲染成「(空)」端给用户看,像那就是方案本身。
 *
 * 空的验收点尤其糟:验收环节拿它当判据 —— 判据是空的,那一关就只能凭执行者的自述。
 *
 * 这里只做**检测**,不改判定。判定归评审和用户。
 */
/**
 * 「方案」短到这个程度就只能是一句话,不是方案。
 *
 * 12 而不是 40:用户实测那一版 solution 有五十多字(「对 X 项目进行全面的代码审查,
 * 涵盖架构设计、安全性……」),**长度根本挡不住它** —— 真正挡住它的是另外三个字段全空。
 * 所以这条只当粗筛,拦「三步走」那种三个字的。
 *
 * 阈值从 20 降到 12 是验收实测逼的:中文码点密度约是英文的 1.6 倍,20 会误伤
 * 「把 README 第一行标题改成 X」(15 码点)这类**合理的**小任务方案,而同义英文
 * (21 字符)却放行。误伤的代价是白烧一次重拟调用 + 关口上一条吓人的警告。
 */
export const MIN_SOLUTION_CHARS = 12

/**
 * 占位词判据搬到了 `parseOutput.ts`(叶子模块),因为 `pipeline.ts` 也要用它 —— 子节点的
 * 验收点同样不能只判 `=== ''`。这里 re-export,保住本模块原有的公开面。
 */
export { MIN_FIELD_CHARS, hollow }

export function planGaps(plan: { solution: string; keyPoints: string; risks: string; acceptance: string } | null | undefined): string[] {
  // 它是 export 的,而且唯一调用链之外没人保证传得进对象。守 plan 本身,不只守字段。
  if (!plan || typeof plan !== 'object') return ['方案整个是空的']
  const out: string[] = []
  if (hollow(plan.solution)) out.push('完整方案是空的')
  else if (Array.from(String(plan.solution).trim()).length < MIN_SOLUTION_CHARS) {
    out.push(`完整方案只有 ${Array.from(String(plan.solution).trim()).length} 个字,基本等于复述目标`)
  }
  if (hollow(plan.keyPoints)) out.push('重点是空的(或只填了「无」这类占位)')
  if (hollow(plan.risks)) out.push('风险点是空的(或只填了「无」这类占位)')
  if (hollow(plan.acceptance)) out.push('验收点是空的 —— 验收环节拿它当判据,空的就只能凭执行者自述')
  return out
}

type ParsedPlan = { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] }

/**
 * 重拟的那一版是不是**真的**更好。
 *
 * 判据不能只数空字段个数。验收实跑复现过:第一版是 `decompose` + 3 个子任务、gaps=2,
 * 重拟版是 `executable` + 0 个子任务、gaps=1 —— 只比个数的话就被换掉了,而 `parsed = re`
 * 是整体替换,**子任务一起没了**。产出正好是用户抱怨里的那一行:
 * 「初始任务树 · 第一层(0 个) (不拆分,根任务直接执行)」。
 *
 * 所以三条都要满足:空字段确实少了、子任务一个都没丢、没有从「要拆」退回「不拆」。
 */
export function isBetterDraft(next: ParsedPlan, prev: ParsedPlan, prevGaps: number): boolean {
  if (planGaps(next.plan).length >= prevGaps) return false
  if (next.children.length < prev.children.length) return false
  if (prev.kind === 'decompose' && next.kind !== 'decompose') return false
  return true
}

export function draftBlockers(draft: RootDraft): string[] {
  const out: string[] = []
  // 方案本身是不是空的,排在依赖问题前面 —— 一份空方案上讨论子任务依赖没有意义。
  out.push(...planGaps(draft.plan))
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
