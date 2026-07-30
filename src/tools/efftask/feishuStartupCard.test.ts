import { describe, expect, it } from 'bun:test'
import { buildStartupCard, buildHandoffCard } from './feishuStartupCard.js'
import { capsLine, costLine } from './startupConfirm.js'

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
    /**
     * capsLine **整行**也要钉,而不是逐条钉它里面的字段。
     *
     * 验收造的变异:卡片侧把 capsLine 的输出正则剥掉「· 静默超时 …」那一段 —— 433 tests
     * 全绿。逐条钉的写法对**下一个**新增字段同样无效,而这一行的字段还会长。
     */
    expect(text(cfg())).toContain(capsLine(cfg() as never))
    /**
     * capsLine **整行**也要钉,而不是逐条钉它里面的字段。
     *
     * 验收造的变异:卡片侧把 capsLine 的输出正则剥掉「· 静默超时 …」那一段 —— 433 tests
     * 全绿。逐条钉的写法对**下一个**新增字段同样无效,而这一行的字段还会长。
     */
    expect(text(cfg())).toContain(capsLine(cfg() as never))
    expect(text(cfg())).toContain('次模型调用')
  })

  it('不是全票时卡片也要说', () => {
    const c = cfg({ caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1, quorum: 60 } })
    expect(text(c)).toContain('需 60% 席位赞成')
  })
})

describe('收口卡片:不可逆动作不上卡', () => {
  const H = {
    branch: 'efftask/001/integration', commits: 3,
    integrationPath: '/repo/.wt/int', kept: [], salvage: [], outcome: 'completed' as const,
  }
  const card = (h = H) => buildHandoffCard(h, '001', 'req-1') as {
    elements: { text?: { content: string }; actions?: { text: { content: string } }[] }[]
  }
  const buttons = (h = H) => card(h).elements.flatMap(e => e.actions ?? []).map(a => a.text.content)
  const text = (h = H) => card(h).elements.map(e => e.text?.content ?? '').join('\n')

  it('三个按钮,没有「丢弃」', () => {
    // 丢弃不可逆,而这条通道没有过期机制、点击失效卡完全静默、updateCard 吞掉所有错误。
    // 不可逆动作配上一条「点了没反应也不知道」的通道,是最坏的组合。
    expect(buttons()).toEqual(['合并回当前分支', '推送分支', '保留分支'])
    expect(buttons().join('')).not.toContain('丢弃')
  })

  it('但要说清这个选项存在、去哪儿做 —— 不是假装它不存在', () => {
    expect(text()).toContain('丢弃')
    expect(text()).toContain('终端')
  })

  it('「推送」不叫「建 PR」,和终端一致', () => {
    expect(buttons().join('')).not.toContain('PR')
  })

  it('每个按钮带上自己的 choice,否则三个按钮点下去是同一件事', () => {
    const acts = card().elements.flatMap(e => e.actions ?? []) as unknown as
      { behaviors: { value: { choice?: string } }[] }[]
    expect(acts.map(a => a.behaviors[0].value.choice)).toEqual(['merge', 'push', 'keep'])
  })

  it('run 没跑完时卡片顶部就说清楚', () => {
    const t = text({ ...H, outcome: 'blocked', reason: '连续返工超限' })
    expect(t).toContain('没有正常跑完')
    expect(t).toContain('连续返工超限')
  })

  it('分支与提交数如实显示', () => {
    expect(text()).toContain('efftask/001/integration')
    expect(text()).toContain('3 个提交')
  })
})

describe('组合警告两端都要有', () => {
  it('飞书卡带上和终端同一批组合警告', () => {
    // 竞速器的前提是两端说同一件事:终端拦住的组合,从飞书批准的人也必须看到。
    const cfg = {
      goalPrompt: 'g', parallelism: 5, notices: [], mainModel: 'm',
      caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
      phaseRoles: { plan: [], review: [], execute: [], verify: [], accept: [], integrate: [], observer: [] },
      skipSteps: ['execute'],
    }
    const card = buildStartupCard(cfg as never, 'req-1') as { elements: { text?: { content: string } }[] }
    const text = card.elements.map(e => e.text?.content ?? '').join('\n')
    expect(text).toContain('跑不完')
    expect(text).toContain("跳过了执行但没跳验收:本次不会有任何代码改动,验收席位仍会照常开会,去核对一个空产出。判通过 = 给一个什么都没做的节点盖章并合进集成分支;判不通过 = 烧完验收迭代后阻断。要么一并跳过验收,要么别跳执行。")
  })
})
