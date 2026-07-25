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
import type { TaskNode } from './types.js'

/**
 * Why the node stopped. Structural, because the card's whole content is chosen from it and
 * because `--retry-blocked` must never resurrect a node blocked by disk damage.
 */
export type BlockCategory =
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

export interface BlockEscalation {
  node: TaskNode
  /** The reason as recorded on the node — quoted, never paraphrased. */
  reason: string
  category: BlockCategory
  /** `.claude/efftask/<runId>` — where node.md and run.md live. */
  runDir?: string
}

const TITLE: Record<BlockCategory, string> = {
  'cap-iteration': '安全阀 · 方案评审迭代超限',
  'cap-nodes': '安全阀 · 任务树节点数超上限',
  rework: '连续返工超限',
  timeout: '安全阀 · 单节点执行超时',
  infra: '角色调用连续失败',
}

/**
 * What to change BEFORE retrying. Category-specific, because "retry it again unchanged" is
 * useless advice for four of these five: the same cap trips at the same place.
 */
const REMEDY: Record<BlockCategory, string> = {
  'cap-iteration': '若方案本身没问题,可提高 run.md 里 caps.maxIterations 后再重试;否则先按评审意见改需求或补充信息。',
  'cap-nodes': '提高 run.md 里 caps.maxNodes 后再重试,或缩小需求范围。',
  rework: '先看该节点的验收记录,按阻断意见改代码或改验收点;必要时提高 caps.maxIterations。',
  timeout: '提高 run.md 里 caps.nodeTimeoutMs 后再重试,或把该节点拆小。',
  infra: '先确认角色模型/网络可用(角色配置在 .claude/settings.json 的 roles 里),再重试。',
}

/** The phase a retried node re-enters, and therefore what the user is buying. */
function retryTarget(node: TaskNode): string {
  if (node.childIds.length > 0) return '集成验收'
  return node.kind === 'executable' ? '执行 → 验收' : '方案制定 → 评审'
}

export function blockEscalationLines(e: BlockEscalation, runId?: string): string[] {
  const id = runId ?? '<运行 ID>'
  return [
    `节点: ${e.node.title}(${e.node.id})`,
    `类别: ${TITLE[e.category]}`,
    // Verbatim. The reason already names the counts ("验收迭代超限(3): …") and paraphrasing
    // it here would give the card and node.md two different accounts of the same event.
    `原因: ${e.reason}`,
    // Say the ABSENCE out loud. This node is not queued, not retrying, not waiting on
    // anything — and a card that only says "已暂停" reads as "it will pick up later".
    '状态: 已暂停,不会自动重试;这一支下面的任务也不会继续。',
    e.runDir ? `记录: ${e.runDir}/${e.node.id}/node.md` : '记录: 该节点目录下的 node.md',
    `处理方式: ${REMEDY[e.category]}`,
    // The ONLY command that actually reopens this node. A bare `--resume` reproduces the
    // block having made zero model calls — measured behaviour of reseatTransientNodes.
    `重试该节点: /et --resume ${id} --retry-blocked(会重跑「${retryTarget(e.node)}」)`,
    `不重试、只看结果: /et --resume ${id} 或直接读 run.md`,
  ]
}

export function buildBlockCard(e: BlockEscalation, runId?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      // Orange, not red: red is the merge-conflict card, which is a stop the user must
      // personally unblock. This is a valve — the run protected itself and is asking whether
      // to spend more. Two different asks should not look identical in a chat window.
      template: 'orange',
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
  admit: () => { send: boolean; note?: string }
  suppressed: () => number
} {
  let sent = 0
  let dropped = 0
  return {
    admit() {
      if (sent < max - 1) { sent++; return { send: true } }
      if (sent === max - 1) {
        sent++
        return { send: true, note: `本次运行的升级通知已达 ${max} 条上限,后续升级不再单独发卡,请看 run.md 或终端任务树。` }
      }
      dropped++
      return { send: false }
    },
    suppressed: () => dropped,
  }
}
