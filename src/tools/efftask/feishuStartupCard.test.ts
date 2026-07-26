import { describe, expect, it } from 'bun:test'
import { buildStartupCard } from './feishuStartupCard.js'
import { costLine } from './startupConfirm.js'

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

describe('两个界面必须说同一件事', () => {
  const cfg = (over: object = {}) => ({
    goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
    phaseRoles: { plan: [], review: [{ roleName: 'a' }, { roleName: 'b' }], execute: [], accept: [], observer: [] },
    ...over,
  })
  const text = (c: object) => {
    const card = buildStartupCard(c as never, 'req-1') as { elements: { text?: { content: string } }[] }
    return card.elements.map(e => e.text?.content ?? '').join('\n')
  }

  it('卡片带上和终端同一行的成本预估', () => {
    // 竞速器的前提是两端显示同一份配置 —— 谁先点谁算数。终端说了代价而卡片没说,
    // 从飞书批准的人批准的就是一份他没看全的配置。
    expect(text(cfg())).toContain(costLine(cfg() as never))
    expect(text(cfg())).toContain('次模型调用')
  })

  it('不是全票时卡片也要说', () => {
    const c = cfg({ caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1, quorum: 60 } })
    expect(text(c)).toContain('需 60% 席位赞成')
  })
})
