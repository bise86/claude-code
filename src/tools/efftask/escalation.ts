// 中途升级 (spec §9): "触阀、合并冲突升级、连续返工超限 → 复用确认竞速器 + 飞书卡片",
// and §11: "触任何阀:暂停 + 飞书升级,不静默截断、不谎报完成。"
//
// The merge-conflict half of that shipped first and lives in conflictEscalation.ts. This is
// the other half — the safety valves. Same rules as that module and for the same reasons:
//
//  - PURE. The send path rides the SHARED FeishuClient owned by useFeishuBridge, which is
//    untestable by repo convention. Keeping the CONTENT pure keeps the part that can be wrong
//    — what the user is told — under test.
//  - The card must carry a 处理方式 that is TRUE. A cap-blocked node is not reopened by a
//    plain `/et --resume`: `reseatTransientNodes` only reopens interrupted and merge-conflict
//    nodes, so an instruction to "just resume" would send the user to a run that reproduces
//    the identical block having made zero model calls. `--retry-blocked` is the flag that
//    makes the instruction true, and it exists because this card needed to be honest.
import type { BlockCategory, TaskNode } from './types.js'
export type { BlockCategory }

/**
 * Why the node stopped. Structural, because the card's whole content is chosen from it and
 * because `--retry-blocked` must never resurrect a node blocked by disk damage.
 *
 * The union itself lives in types.ts so TaskNode can name it without an import cycle; the
 * per-member documentation stays here, next to the cards that render each one.
 */
type BlockCategoryDoc =
  /** 方案评审 / 拆分 迭代超限 (caps.maxIterations). */
  | 'cap-iteration'
  /** 整棵树的节点数超过 caps.maxNodes,拆分被拒。 */
  | 'cap-nodes'
  /** 连续返工超限 —— 执行结果反复未通过验收 (spec §9 名字就是这个)。 */
  | 'rework'
  /** 单节点阶段调用超过 caps.nodeTimeoutMs,已被中止。 */
  | 'timeout'
  /** 角色调用连续失败,没有任何人真正裁决过这份工作。 */
  | 'infra'
  /**
   * 深度上限 (caps.maxDepth)。The ONLY valve that does not stop its node: spec §11 says
   * "该分支不再拆,强制 `executable` 或 BLOCKED 升级", and this implementation takes the
   * first branch — the children the planner asked for are folded into the node's own
   * solution and it keeps going. Still announced, because "触任何阀:…不静默截断" means the
   * user gets to know the tree was flattened, not just that it succeeded.
   */
  | 'cap-depth'

export interface BlockEscalation {
  node: TaskNode
  /** The reason as recorded on the node — quoted, never paraphrased. */
  reason: string
  category: BlockCategory
  /**
   * Did this trip actually STOP the node?
   *
   * Not derivable from the category alone. `cap-nodes` stops a node when it trips during
   * decomposition (stepStart blocks) but NOT when it trips during dynamic growth (growTree
   * refuses the graft and the node carries on to ACCEPTED). Measured: the growth path sent a
   * card reading 该节点已停…以「被阻断」收场 for a node whose real state was ACCEPTED with an
   * empty blockedReason, and told the user to run `--retry-blocked`, which matched nothing.
   *
   * Defaults from the category when the caller does not say.
   */
  stopped?: boolean
}

const TITLE: Record<BlockCategory, string> = {
  'cap-iteration': '安全阀 · 方案评审迭代超限',
  'cap-nodes': '安全阀 · 任务树节点数超上限',
  rework: '连续返工超限',
  timeout: '安全阀 · 单节点执行超时',
  infra: '角色调用连续失败',
  'cap-depth': '安全阀 · 已达最大拆分深度',
}

/**
 * What to change BEFORE retrying. Category-specific, because "retry it again unchanged" is
 * useless advice for most of these: the same cap trips at the same place.
 */
const REMEDY: Record<BlockCategory, string> = {
  'cap-iteration': '若方案本身没问题,可提高 run.md 里 caps.maxIterations 后再重试;否则先按评审意见改需求或补充信息。',
  'cap-nodes': '提高 run.md 里 caps.maxNodes 后再重试,或缩小需求范围。',
  rework: '先看该节点的验收记录,按阻断意见改代码或改验收点;必要时提高 caps.maxIterations。',
  timeout: '提高 run.md 里 caps.nodeTimeoutMs 后再重试,或把该节点拆小。',
  infra: '先确认角色模型/网络可用(角色配置在 .claude/settings.json 的 roles 里),再重试。',
  'cap-depth': '若这些子任务确实该独立成节点,提高 run.md 里 caps.maxDepth 后重跑该节点;否则无需处理。',
}

/** The one valve that lets its node continue. Everything the card says branches on this. */
export function stopsTheNode(category: BlockCategory): boolean {
  return category !== 'cap-depth'
}

/**
 * The phase a retried node re-enters, and therefore what the user is buying.
 *
 * MUST mirror reseat.ts's seat rules, including its cap-iteration branch. It did not: for the
 * typical cap-iteration node — a plan that called itself executable and was then rejected
 * three times — reseat sends it back to CREATED to re-plan, while this said 「执行 → 验收」.
 * A card headed 安全阀 · 方案评审迭代超限 told the user the retry would keep the plan and
 * only re-run execution. Exactly backwards.
 */
function retryTarget(node: TaskNode, category: BlockCategory): string {
  if (node.childIds.length > 0) return '集成验收'
  // reseat's `reviewExhausted`: a childless node whose REVIEW budget was the one that ran out
  // goes back to CREATED, whatever `kind` happens to say.
  if (category === 'cap-iteration') return '方案制定 → 评审(方案会重新生成)'
  return node.kind === 'executable' ? '执行 → 验收' : '方案制定 → 评审'
}

/**
 * Where the node's own record lives.
 *
 * Derived from the run id rather than passed in. It WAS a `runDir` field on the payload, and
 * in production it was never populated — `PipelineCtx.onBlocked` carries only
 * {node, reason, category}, so every real card printed the fallback "该节点目录下的 node.md"
 * with no path in it, while the tests set the field by hand and asserted the full path. One
 * fewer wire is one fewer wire that can be cut.
 */
function recordPath(node: TaskNode, runId?: string): string {
  return runId ? `.claude/efftask/${runId}/${node.id}/node.md` : `.claude/efftask/<运行 ID>/${node.id}/node.md`
}

export function blockEscalationLines(e: BlockEscalation, runId?: string): string[] {
  const id = runId ?? '<运行 ID>'
  const head = [
    `节点: ${e.node.title}(${e.node.id})`,
    `类别: ${TITLE[e.category]}`,
    // Verbatim. The reason already names the counts ("验收迭代超限(3): …") and paraphrasing
    // it here would give the card and node.md two different accounts of the same event.
    `原因: ${e.reason}`,
  ]
  if (!(e.stopped ?? stopsTheNode(e.category))) {
    // This trip did NOT stop the node. Saying 已暂停 here would send the user to fix a run
    // that is still working, and `--retry-blocked` would not match this node at all.
    return [
      ...head,
      e.category === 'cap-depth'
        ? '状态: 该节点不再拆分,planner 要的子任务已折进它自己的方案里,继续执行。本次运行没有停。'
        : '状态: 这次加子节点的请求被拒绝了,但该节点本身没有停,会带着这条拒绝记录继续执行和验收。',
      `记录: ${recordPath(e.node, runId)}`,
      `处理方式: ${REMEDY[e.category]}`,
    ]
  }
  return [
    ...head,
    // Say the ABSENCE out loud. This node is not queued, not retrying, not waiting on
    // anything — and a card that only says "已暂停" reads as "it will pick up later".
    '状态: 该节点已停,不会自动重试。它的上级会被标记为阻断,本次运行最终会以「被阻断」收场。',
    // …but the RUN has not stopped yet, and that distinction is load-bearing: a second `/et`
    // started now would acquire the run lock (the FIRST run never takes one — only --resume
    // does) and a second orchestrator would write the same node.md files concurrently, each
    // silently overwriting the other while both reported success.
    // Says only what is KNOWN. The payload carries no in-flight count, so "其它分支此刻仍在跑"
    // was an unconditional assertion that is false at parallelism 1, and false whenever this
    // was the last step running. The ADVICE is sound either way — verified: a new run never
    // takes the run lock (acquireRunLock is only called on the --resume path), so a second
    // /et really would have two orchestrators writing the same node.md files.
    '注意: 本次运行可能还有其它分支在跑。请等它结束后再执行下面的命令 —— 运行期间另开一个 /et 会有两个进程写同一批 node.md。',
    `记录: ${recordPath(e.node, runId)}`,
    `处理方式: ${REMEDY[e.category]}`,
    // The ONLY command that actually reopens this node. A bare `--resume` reproduces the
    // block having made zero model calls — measured behaviour of reseatTransientNodes.
    // Run-scoped, and says so: the flag reopens EVERY valve-stopped node in the run, not just
    // this one, and up to 8 cards can each be pointing at it.
    `重试(会重开本次运行中所有被安全阀停下的节点,本节点将重跑「${retryTarget(e.node, e.category)}」): /et --resume ${id} --retry-blocked`,
    // NOT `/et --resume` — that is not a read-only operation. It takes the run lock, reseats
    // every interrupted node and issues real write-capable model calls.
    // The PATH, not a relative direction. node.md lives at <runDir>/<node.id>/node.md and
    // node.id contains slashes, so run.md is two or three levels up depending on depth —
    // "上一级目录" was wrong for every node in the tree, including root.
    `只看结果、不重跑: 直接读 ${runId ? `.claude/efftask/${runId}/run.md` : '该 run 目录下的 run.md'}。`,
  ]
}

export function buildBlockCard(e: BlockEscalation, runId?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      // Orange, not red: red is the merge-conflict card, which is a stop the user must
      // personally unblock. This is a valve — the run protected itself and is asking whether
      // to spend more. Two different asks should not look identical in a chat window.
      // The depth valve is blue: nothing is wrong and nothing is waiting on anyone.
      template: (e.stopped ?? stopsTheNode(e.category)) ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `高效任务模式 · ${TITLE[e.category]}` },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: blockEscalationLines(e, runId).map(l => `- ${l}`).join('\n') },
      },
    ],
  }
}

/**
 * The same 处理方式 the card carries, for `node.blockedReason`.
 *
 * run.md is the only durable surface a run has, and the escalation limiter drops cards past
 * the cap while telling the user to "看 run.md" — so the remedy has to actually be there.
 * The merge-conflict path already does exactly this (its detail string carries the 处理方式
 * and the resume command); the valve path recorded a bare reason.
 */
export function blockReasonWithRemedy(reason: string, category: BlockCategory, runId?: string): string {
  const id = runId ?? '<运行 ID>'
  return `${reason} · ${REMEDY[category]} · 重试: /et --resume ${id} --retry-blocked`
}

/** Default cards per run before the limiter starts suppressing. */
export const MAX_ESCALATION_CARDS = 8

/**
 * Rate-limit escalations for one run.
 *
 * A provider outage blocks every node in flight, and a 100-node tree would then send 100
 * cards — which is not "being told", it is being buried, and the ONE card that mattered is
 * unfindable. Suppression is ANNOUNCED on the last card that gets through: silently dropping
 * notifications is the same failure as never sending them.
 */
export function createEscalationLimiter(max = MAX_ESCALATION_CARDS): {
  admit: (stopped?: boolean) => { send: boolean; note?: string }
  suppressed: () => number
} {
  let sent = 0
  let dropped = 0
  return {
    /**
     * `stopped` splits the budget. A deep tree that folds eight branches would otherwise spend
     * the whole quota on blue "nothing stopped" cards and suppress the ONE orange card asking a
     * human whether to spend more — measured: the node that actually stopped got {send:false}.
     * Information-only notices get half; a card that needs a decision always gets through
     * until the full cap.
     */
    admit(stopped = true) {
      const ceiling = stopped ? max : Math.floor(max / 2)
      if (sent >= ceiling) { dropped++; return { send: false } }
      if (sent < max - 1) { sent++; return { send: true } }
      if (sent === max - 1) {
        sent++
        // NOT "详见 run.md" flat: renderTreeSnapshot only prints a reason for BLOCKED nodes,
        // and the non-stopping valves (cap-depth flattening a branch, cap-nodes refusing a
        // graft) leave their node running with an empty blockedReason — those land in the
        // node's own node.md and appear nowhere in run.md. Point at both, accurately.
        return { send: true, note: `本次运行的升级通知已达 ${max} 条上限,后续升级不再单独发卡。被阻断的节点在 run.md 的任务树里带着原因和处理方式;未阻断的(如深度上限、加子节点被拒)只记在该节点的 node.md 里。` }
      }
      dropped++
      return { send: false }
    },
    suppressed: () => dropped,
  }
}
