/**
 * 运行中重做的两个纯判据。
 *
 * 「碰了哪些节点」这一份**宁可多、不可少**:少报一个正在跑的节点,它的 step 会把结果
 * commit 进一个已经被换掉的对象 —— 跑完了,树上却什么都没有,而且没有任何一处会报错。
 * 所以这里逐个来源钉一遍,而不是只测一个 happy path。
 */
import { describe, expect, it } from 'bun:test'
import { affectedByRedo, liveRedoUnavailableReason } from './liveRedo.js'
import type { RedoPlan } from './redo.js'

const plan = (over: Partial<RedoPlan> = {}): RedoPlan => ({
  nodes: [],
  deleted: [],
  dependencyRewrites: [],
  worktreesToRelease: [],
  seatedAt: 'READY',
  reopenedAncestors: [],
  warnings: [],
  ...over,
})

describe('这次重做碰了哪些节点', () => {
  it('目标节点永远在里面 —— 哪怕别的什么都没动', () => {
    expect(affectedByRedo(plan(), 'root/02')).toEqual(['root/02'])
  })

  it('被删的整棵子树都算', () => {
    // 删掉的节点会从新树里消失,而一个正在跑的节点凭空消失是这条路上最坏的结局。
    const got = affectedByRedo(plan({ deleted: ['root/02/01', 'root/02/02'] }), 'root/02')
    expect(got.sort()).toEqual(['root/02', 'root/02/01', 'root/02/02'])
  })

  it('被放回可推进状态的祖先也算 —— 它们会重跑集成验收', () => {
    const got = affectedByRedo(plan({ reopenedAncestors: ['root'] }), 'root/02')
    expect(got.sort()).toEqual(['root', 'root/02'])
  })

  it('依赖被改写的**子树外**节点也算', () => {
    // 它的 deps 变了。正在跑的话,它的 step 手里那份 deps 停在改写之前。
    const got = affectedByRedo(plan({ dependencyRewrites: [{ nodeId: 'root/03', from: 'a', to: 'b' }] }), 'root/02')
    expect(got.sort()).toEqual(['root/02', 'root/03'])
  })

  it('同一个 id 从两个来源来只出现一次', () => {
    const got = affectedByRedo(
      plan({ deleted: ['root/02'], reopenedAncestors: ['root/02'] }),
      'root/02',
    )
    expect(got).toEqual(['root/02'])
  })
})

describe('这一刻能不能就地重做', () => {
  it('编排器没在跑 → 不拦(那是结束屏那条路,由它自己的闸门管)', () => {
    expect(liveRedoUnavailableReason({ running: false, nodeRunning: true, title: '甲' })).toBeUndefined()
  })

  it('目标节点自己正在跑 → 拦住,并且说清下一步按什么', () => {
    // 替用户砍掉一个在飞的调用不是这个键该做的决定 —— 说清楚让他自己按 x。
    const why = liveRedoUnavailableReason({ running: true, nodeRunning: true, title: '接入支付回调' })
    expect(why).toContain('接入支付回调')
    expect(why).toContain('x')
  })

  it('别的节点在跑、这个没在跑 → 放行(这就是这个功能本身)', () => {
    expect(liveRedoUnavailableReason({ running: true, nodeRunning: false, title: '甲' })).toBeUndefined()
  })
})
