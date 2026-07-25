import { describe, expect, it } from 'bun:test'
import { blockEscalationLines, buildBlockCard, createEscalationLimiter, MAX_ESCALATION_CARDS, type BlockCategory } from './escalation.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-26T00:00:00.000Z'
const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root/02-支付', title: '接入支付回调', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW }),
  kind: 'executable',
  ...over,
})
const lines = (category: BlockCategory, reason = '验收迭代超限(3): [qa] 缺测试', over: Partial<TaskNode> = {}) =>
  blockEscalationLines({ node: node(over), reason, category, runDir: '.claude/efftask/007' }, '007').join('\n')

describe('触阀升级卡 (spec §9/§11)', () => {
  it('carries the node, the verbatim reason and where the record is', () => {
    const t = lines('rework')
    expect(t).toContain('接入支付回调')
    expect(t).toContain('root/02-支付')
    // VERBATIM. node.md already records this sentence with its counts; paraphrasing would
    // give the card and the file two different accounts of the same event.
    expect(t).toContain('验收迭代超限(3): [qa] 缺测试')
    expect(t).toContain('.claude/efftask/007/root/02-支付/node.md')
  })

  it('says the node is NOT going to retry itself', () => {
    // "已暂停" alone reads as "it will pick up later". It will not: reseatTransientNodes
    // skips a cap-blocked node on every plain resume.
    const t = lines('rework')
    expect(t).toContain('不会自动重试')
    // …and that the branch below it is stuck too, which is why a run can look idle.
    expect(t).toContain('下面的任务也不会继续')
  })

  it('names the ONE command that actually reopens it', () => {
    // A bare `/et --resume 007` reproduces the identical block having made zero model calls.
    // This flag is what makes the instruction true; without naming it the card would be
    // prescribing a no-op.
    const t = lines('rework')
    expect(t).toContain('/et --resume 007 --retry-blocked')
  })

  it('says WHICH phase a retry re-runs, so the cost is visible before spending it', () => {
    expect(lines('rework', 'r', { kind: 'executable' })).toContain('执行 → 验收')
    expect(lines('cap-iteration', 'r', { kind: 'unknown' })).toContain('方案制定 → 评审')
    expect(lines('rework', 'r', { childIds: ['a'] })).toContain('集成验收')
  })

  it('prescribes a DIFFERENT fix per valve — "just try again" is useless for all of them', () => {
    // Retrying unchanged trips the same cap at the same place. Each valve has its own knob.
    expect(lines('cap-iteration')).toContain('caps.maxIterations')
    expect(lines('cap-nodes')).toContain('caps.maxNodes')
    expect(lines('timeout')).toContain('caps.nodeTimeoutMs')
    expect(lines('rework')).toContain('验收记录')
    expect(lines('infra')).toContain('roles')
  })

  it('titles each category as itself', () => {
    expect(lines('rework')).toContain('连续返工超限')       // spec §9 uses exactly this name
    expect(lines('cap-nodes')).toContain('节点数超上限')
    expect(lines('timeout')).toContain('单节点执行超时')
    expect(lines('infra')).toContain('角色调用连续失败')
  })

  it('degrades to a placeholder rather than dropping the resume step', () => {
    const t = blockEscalationLines({ node: node(), reason: 'r', category: 'rework' }).join('\n')
    expect(t).toContain('<运行 ID>')
    expect(t).toContain('该节点目录下的 node.md') // no runDir given → say so, don't print an empty path
  })

  it('does NOT look like the merge-conflict card — the two ask for different things', () => {
    // Red is the conflict card: a stop only the user can clear. This is a valve asking
    // whether to spend more. Identical-looking cards in a chat window train people to skim.
    const card = buildBlockCard({ node: node(), reason: 'r', category: 'rework' }, '007') as {
      header: { template: string; title: { content: string } }
      elements: { text: { content: string } }[]
    }
    expect(card.header.template).toBe('orange')
    expect(card.header.title.content).toContain('连续返工超限')
    for (const l of blockEscalationLines({ node: node(), reason: 'r', category: 'rework' }, '007')) {
      expect(card.elements[0].text.content).toContain(l)
    }
  })
})

describe('升级卡限流', () => {
  it('lets the first cards through', () => {
    const l = createEscalationLimiter(3)
    expect(l.admit().send).toBe(true)
    expect(l.admit().send).toBe(true)
  })

  it('ANNOUNCES the cut-off on the last card rather than going quiet', () => {
    // A provider outage blocks every node in flight. Silently dropping the rest is the same
    // failure as never notifying at all — the user cannot tell "8 problems" from "80".
    const l = createEscalationLimiter(3)
    l.admit(); l.admit()
    const third = l.admit()
    expect(third.send).toBe(true)
    expect(third.note).toContain('已达 3 条上限')
    expect(third.note).toContain('run.md')
  })

  it('suppresses beyond the cap and keeps count', () => {
    const l = createEscalationLimiter(2)
    l.admit(); l.admit()
    expect(l.admit()).toEqual({ send: false })
    expect(l.admit()).toEqual({ send: false })
    expect(l.suppressed()).toBe(2)
  })

  it('defaults to a cap that is small enough to read', () => {
    expect(MAX_ESCALATION_CARDS).toBeLessThanOrEqual(10)
    const l = createEscalationLimiter()
    let sent = 0
    for (let i = 0; i < 50; i++) if (l.admit().send) sent++
    expect(sent).toBe(MAX_ESCALATION_CARDS)
  })
})
