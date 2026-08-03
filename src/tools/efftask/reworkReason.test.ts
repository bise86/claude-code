import { describe, expect, it } from 'bun:test'
import { reworkLine, reworkMarker, reworkReason } from './reworkReason.js'
import type { NodeStatus, PhaseName, RoundtableRecord, TaskNode } from './types.js'

const rec = (round: number, pass: boolean, why: string, step?: PhaseName): RoundtableRecord => ({
  round, verdicts: [], synthesized: { pass, blockingSummary: why }, ...(step ? { step } : {}),
})

const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  id: 'n1', title: 't', objective: 'o', status: 'EXECUTING' as NodeStatus,
  parentId: undefined, childIds: [], deps: [], depth: 0,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  blockedReason: '', reviewLog: [], acceptLog: [], scores: [],
  phaseRoles: {} as TaskNode['phaseRoles'],
  iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
  ...over,
} as unknown as TaskNode)

describe('reworkReason', () => {
  it('没有任何未通过的记录时什么都不说', () => {
    expect(reworkReason(node())).toBeUndefined()
    expect(reworkReason(node({ acceptLog: [rec(1, true, '')] }))).toBeUndefined()
  })

  it('执行侧读 acceptLog 的最后一条未通过', () => {
    const n = node({
      status: 'EXECUTING' as NodeStatus,
      acceptLog: [rec(1, false, '第一轮的意见', 'verify'), rec(2, false, '缺回滚方案', 'accept')],
    })
    expect(reworkReason(n)).toEqual({ step: 'accept', rounds: 2, why: '缺回滚方案' })
  })

  it('方案侧读 reviewLog —— 重拟是被质疑讨论打回来的', () => {
    const n = node({ status: 'PLANNING' as NodeStatus, reviewLog: [rec(1, false, '没有拆分依据')] })
    expect(reworkReason(n)).toEqual({ step: 'review', rounds: 1, why: '没有拆分依据' })
  })

  it('**不跨关兜底** —— 方案被打回过、现在正常执行的节点不许挂着「方案评审未通过」', () => {
    // 跨关兜底会让一件早就解决了的事一直挂在树上,而用户读到的是「它现在因为这个在返工」。
    const n = node({ status: 'EXECUTING' as NodeStatus, reviewLog: [rec(1, false, '方案当时被打回过')] })
    expect(reworkReason(n)).toBeUndefined()
  })

  it('BLOCKED 的节点按它倒在哪一步读账', () => {
    const planFail = node({
      status: 'BLOCKED' as NodeStatus, failedAt: 'PLAN_REVIEW' as NodeStatus,
      reviewLog: [rec(3, false, '连续三轮同一条没解决')],
      acceptLog: [rec(1, false, '这条不该被读到')],
    } as Partial<TaskNode>)
    expect(reworkReason(planFail)?.why).toBe('连续三轮同一条没解决')
    const execFail = node({
      status: 'BLOCKED' as NodeStatus, failedAt: 'ACCEPTANCE' as NodeStatus,
      acceptLog: [rec(2, false, '测试没跑')],
    } as Partial<TaskNode>)
    expect(reworkReason(execFail)?.why).toBe('测试没跑')
  })

  it('老记录没有 step 时,验收侧按验收、方案侧按质疑讨论', () => {
    expect(reworkReason(node({ acceptLog: [rec(1, false, 'x')] }))?.step).toBe('accept')
    expect(reworkReason(node({ status: 'PLANNING' as NodeStatus, reviewLog: [rec(1, false, 'x')] }))?.step).toBe('review')
  })

  it('意见是空的**不等于**没返工 —— 那种情况本身要说出来', () => {
    const r = reworkReason(node({ acceptLog: [rec(1, false, '   ')] }))
    expect(r).toBeDefined()
    expect(r?.why).toContain('没有留下具体意见')
  })
})

describe('reworkMarker', () => {
  it('没返工时是空串', () => {
    expect(reworkMarker(node())).toBe('')
  })

  it('四条计数相加 —— 这一格回答的是「这个任务折腾了几趟」', () => {
    expect(reworkMarker(node({ iteration: { planReview: 1, acceptance: 2, integration: 0, scoring: 1, mergeResolve: 9 } })))
      .toBe(' ↻4')
    // mergeResolve 不算:那是解冲突,不是判决把活打回来
    expect(reworkMarker(node({ iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 3 } })))
      .toBe('')
  })
})

describe('reworkLine', () => {
  it('一行话:第几轮、哪一关、原文', () => {
    const l = reworkLine(node({ acceptLog: [rec(2, false, '缺回滚方案', 'accept')] }))
    expect(l).toContain('第 2 轮')
    expect(l).toContain('验收')
    expect(l).toContain('缺回滚方案')
  })

  it('测试验收两关分得开 —— 用户要照着修的东西不一样', () => {
    expect(reworkLine(node({ acceptLog: [rec(1, false, 'x', 'verify')] }))).toContain('测试验证')
  })

  it('长意见按码点截,而且不许把换行原样带进树行', () => {
    const l = reworkLine(node({ acceptLog: [rec(1, false, `一二三四五六七八九十`.repeat(20) + '\n换行')] }), 40)
    expect(Array.from(l).length).toBeLessThanOrEqual(41)
    expect(l).not.toContain('\n')
    expect(l.endsWith('…')).toBe(true)
  })

  it('没返工时是空串 —— 调用方拿它当「画不画这一行」的判据', () => {
    expect(reworkLine(node())).toBe('')
  })
})
