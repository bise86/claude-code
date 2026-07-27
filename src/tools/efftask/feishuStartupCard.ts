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
import type { EffTaskConfig, PendingHandoff } from './types.js'
import { capsLine, costLine, skipConflictLines, skipConsequenceLines, goalLine, noticeLines, parallelismLine, rosterLines, resumeSummarySections, type ConfirmWinner, type ResumeSummary, type StartupDecision, type SurfaceTeardown } from './startupConfirm.js'
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
export function buildStartupCard(config: EffTaskConfig, requestId: string, resume?: ResumeSummary, isolation?: 'worktree' | 'none'): object {
  const goal = goalLine(config.goalPrompt)
  const body =
    `**目标**: ${goal}\n` +
    // Same sentence as the terminal, from the same function. A Feishu approver must not
    // be told something different about the run than the person at the keyboard.
    `**${parallelismLine(config, { editable: false, isolation })}**\n` +
    // NOT "如需调整请在终端修改". This card's own approve button is the path that DISCARDS
    // terminal edits: the payload it claims with is {parallelism, approved} snapshotted when
    // the gate opened, and applyStartupDecision reads an absent roster as "unchanged". So a
    // user who edits in the terminal and is then approved from here silently gets the values
    // shown on THIS card. Say that, instead of inviting the edit that will be thrown away.
    `（在此批准 = 就用本卡片显示的并行数与名册;若要改动,请改在终端确认界面并在终端按回车)\n` +
    `**${capsLine(config)}**\n` +
    `${costLine(config)}\n` +
    `**角色名册**:\n${rosterLines(config).map(l => `- ${l}`).join('\n')}` +
    // The roster says who WILL run; this says whose request was dropped and why. Without it
    // the card would answer the user's "确认有多少角色、各自承担什么" with a half-truth.
    // 竞速器的前提是两端说同一件事:终端拦住的组合,卡片也必须拦。
    (skipConflictLines(config).length > 0
      ? `\n\n**以下配置组合会让任务跑不完**:\n${skipConflictLines(config).map(l => `- ${l}`).join('\n')}`
      : '') +
    (skipConsequenceLines(config).length > 0
      ? `\n\n**跳过带来的连带后果**:\n${skipConsequenceLines(config).map(l => `- ${l}`).join('\n')}`
      : '') +
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

/**
 * 收口卡片(spec §8)。三个按钮,**没有「丢弃」**。
 *
 * 丢弃是四个动作里唯一不可逆的一个,而这条通道是最不适合承载它的:卡片没有过期机制、
 * 点击一张失效卡完全静默、updateCard 吞掉所有错误。不可逆动作配上一条「点了没反应也
 * 不知道」的通道,是最坏的组合。所以卡片**显示**这个选项存在,但要求去终端确认 ——
 * 假装它不存在同样是撒谎。
 *
 * 无限期有效、不设默认、不自动选:飞书卡 7 天,过期就是过期;终端那端一直等。两边一致。
 */
export function buildHandoffCard(h: PendingHandoff, runId: string, requestId: string): object {
  const lines: string[] = []
  // run 的结局摆在最前 —— 别邀请用户合并一棵没做完的树。
  if (h.outcome === 'blocked') {
    lines.push('⚠ **本次运行没有正常跑完**(' + (h.reason || '被阻断或已取消') + '),下面的改动可能是半成品', '')
  }
  lines.push('**高效任务 ' + runId + ' · 收口**')
  lines.push('分支 ' + h.branch + ' 上有 ' + h.commits + ' 个提交,你的工作区未被改动')
  if (h.integrationPath) lines.push('集成工作区: ' + h.integrationPath)
  if (h.salvage.length > 0) lines.push('中断时抢救出的提交: ' + h.salvage.join('、'))
  if (h.kept.length > 0) lines.push('保留的工作区: ' + h.kept.length + ' 个')
  lines.push('', '**丢弃**这一项不在卡片上 —— 它不可逆,请在终端确认。')
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '高效任务模式 · 收口' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          button('合并回当前分支', 'primary', { requestId, behavior: 'allow', choice: 'merge' }),
          button('推送分支', 'default', { requestId, behavior: 'allow', choice: 'push' }),
          button('保留分支', 'default', { requestId, behavior: 'allow', choice: 'keep' }),
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
