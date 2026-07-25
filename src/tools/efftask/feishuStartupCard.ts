// Integration surface — rides the SHARED always-on FeishuClient + permission callbacks
// owned by useFeishuBridge, so no unit test (repo convention).
// The pure racer / roster primitives stay in startupConfirm.ts.
//
// HARD RULE: never `new FeishuClient`, never connect()/close(), never onCardAction().
// useFeishuBridge owns the single connection AND the single onCardAction handler slot
// (which routes permission prompts). A second connection mis-routes events; re-registering
// onCardAction would silently clobber the permission bridge. Multiplexing already exists
// one layer up: wireCardAction dispatches by value.requestId into
// FeishuPermissionCallbacks.resolve(...), so we just claim our own requestId.
import type { FeishuClient } from '../../services/feishu/FeishuClient.js'
import type { FeishuPermissionCallbacks } from '../../services/feishu/feishuPermissions.js'
import type { EffTaskConfig } from './types.js'
import { rosterLines, type ConfirmWinner, type StartupDecision, type SurfaceTeardown } from './startupConfirm.js'
import { logError } from '../../utils/log.js'

// Button shape MIRRORS src/services/feishu/cards.ts: the callback payload is
// { requestId, behavior }, which is exactly what wireCardAction reads.
function button(content: string, type: string, value: Record<string, unknown>) {
  return { tag: 'button', text: { tag: 'plain_text', content }, type, behaviors: [{ type: 'callback', value }] }
}

export function buildStartupCard(config: EffTaskConfig, requestId: string): object {
  const goal = config.goalPrompt.split('\n')[0].slice(0, 80)
  const body =
    `**目标**: ${goal}\n` +
    `**并行数**: ${config.parallelism}（P1 串行,值 P2 生效）\n` +
    `**安全阀**: 深度${config.caps.maxDepth} / 节点${config.caps.maxNodes} / 迭代${config.caps.maxIterations}\n` +
    `**角色名册**:\n${rosterLines(config).map(l => `- ${l}`).join('\n')}`
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '高效任务模式 · 启动确认' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'action',
        actions: [
          button('开始', 'primary', { requestId, behavior: 'allow' }),
          button('取消', 'danger', { requestId, behavior: 'deny' }),
        ],
      },
    ],
  }
}

// Mirrors buildResolvedCard in services/feishu/cards.ts: the card must say WHO decided and
// WHAT was decided. A constant "handled elsewhere" text leaves a user who cancelled from
// Feishu unable to tell whether the run started.
const VIA: Record<ConfirmWinner, string> = { terminal: '终端', feishu: '飞书', cancelled: '系统' }
function resolvedCard(winner: ConfirmWinner, decision: StartupDecision): object {
  const label = winner === 'cancelled' ? '⏹ 已取消' : decision.approved ? '✅ 已开始' : '❌ 已取消'
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '高效任务模式 · 启动确认' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: `${label}（${VIA[winner]}）` } }],
  }
}

export function sendFeishuStartupCard(
  deps: {
    client: FeishuClient // the SHARED, already-connected client from AppState
    callbacks: FeishuPermissionCallbacks // the SHARED registry from AppState
    requestId: string // randomUUID() minted by the caller; also embedded in cardContent
    cardContent: object
    parallelism: number // echoed back in the decision (the card has no inline editor in P1)
  },
  claim: (winner: ConfirmWinner, d: StartupDecision) => void,
  onTeardown: (fn: SurfaceTeardown) => void,
): void {
  let messageId: string | undefined
  let resolved: { winner: ConfirmWinner; decision: StartupDecision } | undefined

  // Compensation patch, same shape as makeFeishuRacer: the card and the decision can land
  // in either order, so flip it from BOTH sides. Without the post-send call, a terminal win
  // that beats sendCard leaves a live 开始/取消 card in the chat forever, silently
  // swallowing clicks.
  const patchResolved = (): void => {
    if (messageId && resolved) {
      void deps.client.updateCard(messageId, resolvedCard(resolved.winner, resolved.decision))
    }
  }

  // Register on the shared registry — NOT client.onCardAction (single slot, already taken).
  const unsub = deps.callbacks.onResponse(deps.requestId, r => {
    const decision = { parallelism: deps.parallelism, approved: r.behavior === 'allow' }
    claim('feishu', decision)
  })
  // Registered BEFORE anything that can throw, so a later failure still unwinds the entry
  // out of the shared registry instead of poisoning it for the permission bridge.
  onTeardown((winner, decision) => {
    unsub()
    resolved = { winner, decision }
    patchResolved()
  })

  try {
    // fire-and-forget send on the shared client; the messageId arrives later.
    void deps.client
      .sendCard(deps.cardContent)
      .then(id => { messageId = id; patchResolved() })
      .catch(logError)
  } catch (e) {
    logError(e)
  }
}
