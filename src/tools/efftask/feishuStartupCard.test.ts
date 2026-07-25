import { describe, expect, it } from 'bun:test'
import { buildStartupCard } from './feishuStartupCard.js'

describe('启动卡不能邀请一件它自己会丢掉的事', () => {
  it('不再说"如需调整请在终端修改" —— 在此批准正是丢弃终端修改的那条路径', () => {
    // The card claims with {parallelism, approved} snapshotted at gate-open and carries no
    // roster at all; applyStartupDecision reads an absent roster as "unchanged". So approving
    // from here uses the values on THIS card, and any terminal edit is discarded.
    const cfg = {
      goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
      caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
      phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
    }
    const card = buildStartupCard(cfg as never, 'req-1') as { elements: { text?: { content: string } }[] }
    const text = card.elements.map(e => e.text?.content ?? '').join('\n')
    expect(text).not.toContain('如需调整请在终端确认界面修改')
    expect(text).toContain('在此批准 = 就用本卡片显示的并行数与名册')
  })
})
