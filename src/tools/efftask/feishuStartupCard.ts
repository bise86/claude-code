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
import { capsLine, goalLine, noticeLines, parallelismLine, rosterLines, resumeSummarySections, type ConfirmWinner, type ResumeSummary, type StartupDecision, type SurfaceTeardown } from './startupConfirm.js'
import { logError } from '../../utils/log.js'

// Button shape MIRRORS src/services/feishu/cards.ts: the callback payload is
// { requestId, behavior }, which is exactly what wireCardAction reads.
function button(content: string, type: string, value: Record<string, unknown>) {
  return { tag: 'button', text: { tag: 'plain_text', content }, type, behaviors: [{ type: 'callback', value }] }
}

/**
 * @param resume when present the card is a RESUME confirmation: the header says so and the
 * recovery summary is rendered from the SAME shared sections the terminal view uses. Without
 * it a Feishu approver would sanction a resume seeing only a normal startup card — no counts,
 * no repairs — i.e. approving something different from what the terminal describes.
 */
export function buildStartupCard(config: EffTaskConfig, requestId: string, resume?: ResumeSummary): object {
  const goal = goalLine(config.goalPrompt)
  const body =
    `**目标**: ${goal}\n` +
    // Same sentence as the terminal, from the same function. A Feishu approver must not
    // be told something different about the run than the person at the keyboard.
    `**${parallelismLine(config, { editable: false })}**（如需调整请在终端确认界面修改）\n` +
    `**${capsLine(config)}**\n` +
    `**角色名册**:\n${rosterLines(config).map(l => `- ${l}`).join('\n')}` +
    // The roster says who WILL run; this says whose request was dropped and why. Without it
    // the card would answer the user's "确认有多少角色、各自承担什么" with a half-truth.
    (noticeLines(config).length > 0
      ? `\n\n**以下请求不会生效**:\n${noticeLines(config).map(l => `- ${l}`).join('\n')}`
      : '') +
    (resume
      ? '\n\n' + resumeSummarySections(resume)
          .map(sec => `**${sec.tone === 'warn' ? '⚠ ' : ''}${sec.heading}**\n${sec.lines.map(l => `- ${l}`).join('\n')}`)
          .join('\n\n')
      : '')
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: resume ? '高效任务模式 · 恢复确认' : '高效任务模式 · 启动确认' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'action',
        actions: [
          button(resume ? '继续执行' : '开始', 'primary', { requestId, behavior: 'allow' }),
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
    parallelism: number // echoed back in the decision — the card has allow/deny buttons only,
                      // so a Feishu approver cannot change it; the terminal gate can.
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
