/**
 * **整个功能的验收点**:细化之后,依赖方真的会更早被调度。
 *
 * 上面那两档(判据 / 顺序)证明的都是「我们算得对、写得对」。这一档证明的是**收益本身**
 * 存在 —— 少了它,前面全是自说自话:一份算得再漂亮的 `deps` 如果 `pickBatch` 不认,
 * 这个功能就是零。
 *
 * 判据走 `pickBatch` 自己(不是 `depsSatisfied`),因为屏幕上那句「当场可起跑」承诺的
 * 正是它:祖先阻断、终态、在飞,它比依赖门多管三件事。
 */
import { describe, expect, it } from 'bun:test'
import { pickBatch } from './scheduler.js'
import { applyRecalc } from './depsRecalcRun.js'
import { normalizeRecalc, recalcScope } from './depsRecalc.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-09T00:00:00.000Z'
const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id.split('/').pop() ?? id, parentId: null, deps: [], depth: id.split('/').length - 1,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const A = 'root/00-a', B = 'root/01-b'
const B1 = 'root/01-b/00-b1', B2 = 'root/01-b/01-b2', B3 = 'root/01-b/02-b3'

/** 甲依赖整个乙;乙已经拆成 B1/B2/B3。 */
function tree(): Map<string, TaskNode> {
  return new Map([
    mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: [A, B] }),
    mk(A, { parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
    mk(B, { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [B1, B2, B3] }),
    mk(B1, { parentId: B, status: 'CREATED' }),
    mk(B2, { parentId: B, status: 'CREATED' }),
    mk(B3, { parentId: B, status: 'CREATED' }),
  ].map(n => [n.id, n]))
}

const picked = (m: Map<string, TaskNode>): string[] =>
  pickBatch([...m.values()], m, new Set(), 10).map(x => x.node.id)

describe('端到端:细化之后依赖方真的更早起跑', () => {
  it('粗依赖下,B2 验收完甲仍然起不来;细化之后当场就能被调度', async () => {
    const m = tree()

    // —— 改之前:B2 通过验收,甲照旧起不来(它在等整个乙,包括乙自己那一关集成验收)
    m.get(B2)!.status = 'ACCEPTED'
    expect(picked(m)).not.toContain(A)

    // —— 重算:甲只需要 B2
    const scope = recalcScope(m.get(A)!, m)
    if (!scope.ok) throw new Error('准入没过')
    const plan = normalizeRecalc(m.get(A)!, m, scope, {
      deps: [{ dep: B, needs: [{ id: B2, title: 'b2', why: '甲要用 B2 的接口' }] }],
    })
    expect(plan.after).toEqual([B2])

    const r = await applyRecalc(m.get(A)!, plan, {
      byId: () => m,
      now: () => NOW,
      persist: async () => {},
      hold: () => ({ ok: true, release: () => {} }),
      depsChanged: () => ({ ok: true }),
    })
    expect(r.ok).toBe(true)

    // —— 改之后:当场可调度,而 B1/B3 一个字节都没动
    expect(picked(m)).toContain(A)
    expect(m.get(B1)!.status).toBe('CREATED')
    expect(m.get(B3)!.status).toBe('CREATED')
  })

  it('B2 还没完成时,细化**不会**让甲提前起跑 —— 门还在,只是换了个更小的门', async () => {
    const m = tree()
    const scope = recalcScope(m.get(A)!, m)
    if (!scope.ok) throw new Error('准入没过')
    const plan = normalizeRecalc(m.get(A)!, m, scope, {
      deps: [{ dep: B, needs: [{ id: B2, title: '', why: 'x' }] }],
    })
    await applyRecalc(m.get(A)!, plan, {
      byId: () => m, now: () => NOW, persist: async () => {},
      hold: () => ({ ok: true, release: () => {} }), depsChanged: () => ({ ok: true }),
    })
    expect(picked(m)).not.toContain(A)
  })

  it('细化之后 B2 阻断,甲照样被连坐 —— 死亡传播不会因为跨层依赖漏掉', async () => {
    const m = tree()
    const scope = recalcScope(m.get(A)!, m)
    if (!scope.ok) throw new Error('准入没过')
    const plan = normalizeRecalc(m.get(A)!, m, scope, {
      deps: [{ dep: B, needs: [{ id: B2, title: '', why: 'x' }] }],
    })
    await applyRecalc(m.get(A)!, plan, {
      byId: () => m, now: () => NOW, persist: async () => {},
      hold: () => ({ ok: true, release: () => {} }), depsChanged: () => ({ ok: true }),
    })
    m.get(B2)!.status = 'BLOCKED'
    // pickBatch 不会选它(依赖没满足);而 propagateBlocked 的 depBlocked 判据按 id 走,
    // 不假设兄弟关系 —— 跨层依赖对它完全透明。
    expect(picked(m)).not.toContain(A)
    expect(m.get(A)!.deps.some(d => m.get(d)!.status === 'BLOCKED')).toBe(true)
  })

  it('依赖被细化过的节点,重做被依赖方时会退回粗依赖并留下一条记录', async () => {
    const { planRedo } = await import('./redo.js')
    const m = tree()
    const scope = recalcScope(m.get(A)!, m)
    if (!scope.ok) throw new Error('准入没过')
    const plan = normalizeRecalc(m.get(A)!, m, scope, {
      deps: [{ dep: B, needs: [{ id: B2, title: '', why: 'x' }] }],
    })
    await applyRecalc(m.get(A)!, plan, {
      byId: () => m, now: () => NOW, persist: async () => {},
      hold: () => ({ ok: true, release: () => {} }), depsChanged: () => ({ ok: true }),
    })
    expect(m.get(A)!.deps).toEqual([B2])

    // 用户对乙按「任务重做」→ B2 会被删掉 → 甲的依赖必须退回乙本身
    const redo = planRedo([...m.values()], B, 'plan', NOW)
    if ('error' in redo) throw new Error(redo.error)
    const a = redo.nodes.find(n => n.id === A)!
    expect(a.deps).toEqual([B])
    // …而且要留下一条记录,否则盘上会并存「deps 指着乙」和「重算成了 B2」,
    // 而 B2 的目录已经被删掉。
    expect(a.depsRecalc!.at(-1)).toMatchObject({ from: [B2], to: [B], note: expect.stringContaining('退回') })
    expect(redo.warnings.join('')).toContain('重新细化')
  })
})
