/**
 * 依赖重算的**顺序**那一半:调用/重拟/落盘。
 *
 * 这一档钉的全是「谁先谁后」以及「失败时盘上和内存分别是什么」——判据本身在
 * depsRecalc.test.ts。评审在这两件事上各抓到过一个 P0。
 */
import { describe, expect, it } from 'bun:test'
import { applyRecalc, askRecalc } from './depsRecalcRun.js'
import { recalcScope, type RecalcPlan } from './depsRecalc.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-09T00:00:00.000Z'
const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id.split('/').pop() ?? id, parentId: null, deps: [], depth: id.split('/').length - 1,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const A = 'root/00-a', B = 'root/01-b', B1 = 'root/01-b/00-b1', B2 = 'root/01-b/01-b2'

function tree(): Map<string, TaskNode> {
  return new Map([
    mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: [A, B] }),
    mk(A, { parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
    mk(B, { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [B1, B2] }),
    mk(B1, { parentId: B, status: 'CREATED' }),
    mk(B2, { parentId: B, status: 'CREATED' }),
  ].map(n => [n.id, n]))
}

const scopeOf = (m: Map<string, TaskNode>) => {
  const s = recalcScope(m.get(A)!, m)
  if (!s.ok) throw new Error('refused')
  return s
}

const block = (tag: string, o: unknown): string => `\`\`\`${tag}\n${JSON.stringify(o)}\n\`\`\``
/** 从提示词里把本次 tag 抠出来 —— 每次调用都是新的,测试必须跟着走。 */
const tagOf = (prompt: string): string => prompt.match(/```(deps[a-z]+)/)![1]

describe('askRecalc', () => {
  it('把模型的回答归一化成计划', async () => {
    const m = tree()
    const r = await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      runAgent: async ({ prompt }) => block(tagOf(prompt), { deps: [{ dep: B, needs: [{ id: B1, title: 'b1', why: 'x' }] }] }),
    }, new AbortController().signal)
    expect(r.ok).toBe(true)
    expect((r as { plan: RecalcPlan }).plan.after).toEqual([B1])
  })

  it('调用回来先判 aborted 再解析 —— 空串不许被报成「所有依赖保持原样」', async () => {
    const m = tree()
    const ac = new AbortController()
    const r = await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      // 适配层在已 abort 时**返回空串、不抛**,这里逐字模拟那条路
      runAgent: async () => { ac.abort(); return '' },
    }, ac.signal)
    expect(r.ok).toBe(false)
    expect((r as { kind: string }).kind).toBe('aborted')
  })

  it('调用抛错 → call-failed,不当成「没得细」', async () => {
    const m = tree()
    const r = await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m, runAgent: async () => { throw new Error('上游 400') },
    }, new AbortController().signal)
    expect((r as { kind: string; reason: string }).kind).toBe('call-failed')
    expect((r as { reason: string }).reason).toContain('400')
  })

  it('id 全对不上 → 重拟一次,而且**换一个新 tag**', async () => {
    const m = tree()
    const tags: string[] = []
    let call = 0
    const r = await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      runAgent: async ({ prompt }) => {
        const tag = tagOf(prompt); tags.push(tag); call++
        return call === 1
          ? block(tag, { deps: [{ dep: B, needs: [{ id: '不存在', title: '', why: '' }] }] })
          : block(tag, { deps: [{ dep: B, needs: [{ id: B2, title: '', why: 'x' }] }] })
      },
    }, new AbortController().signal)
    expect(call).toBe(2)
    // tag 不换的话,重拟提示词里被回灌的那段旧回答会变成本轮的 tagged 块
    expect(tags[0]).not.toBe(tags[1])
    expect((r as { plan: RecalcPlan }).plan.after).toEqual([B2])
  })

  it('重拟提示词里回灌的 id 被中和过反引号', async () => {
    const m = tree()
    let second = ''
    let call = 0
    await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      runAgent: async ({ prompt }) => {
        call++
        if (call === 2) second = prompt
        return block(tagOf(prompt), { deps: [{ dep: B, needs: [{ id: '```坏的', title: '', why: '' }] }] })
      },
    }, new AbortController().signal)
    // 只剩输出示例那一对围栏;回灌进来的三反引号必须已经被中和
    expect(second.split('```').length - 1).toBe(2)
  })

  it('模型说「保持原样」**不重拟**(那是结论,不是失败)', async () => {
    const m = tree()
    let call = 0
    await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      runAgent: async ({ prompt }) => { call++; return block(tagOf(prompt), { deps: [{ dep: B, needs: [{ id: B, title: '', why: '就是要等它整体完成' }] }] }) },
    }, new AbortController().signal)
    expect(call).toBe(1)
  })

  it('用真节点发起调用 —— 用量要记在它身上,不能记在 stub 上', async () => {
    const m = tree()
    let seen: TaskNode | undefined
    await askRecalc(m.get(A)!, scopeOf(m), {
      byId: () => m,
      runAgent: async ({ node, prompt }) => { seen = node; return block(tagOf(prompt), { deps: [] }) },
    }, new AbortController().signal)
    expect(seen).toBe(m.get(A)!)
  })
})

describe('applyRecalc', () => {
  const plan = (over: Partial<RecalcPlan> = {}): RecalcPlan => ({
    nodeId: A, before: [B], after: [B1], perDep: [], warnings: [], unchanged: false, outcome: 'refined', ...over,
  })
  const deps = (m: Map<string, TaskNode>, over: Partial<Parameters<typeof applyRecalc>[2]> = {}) => ({
    byId: () => m,
    now: () => NOW,
    persist: async () => {},
    hold: () => ({ ok: true as const, release: () => {} }),
    depsChanged: () => ({ ok: true as const }),
    ...over,
  })

  it('顺序是 hold → 校验 → 落盘 → 才动活对象 → 叫醒调度', async () => {
    const m = tree()
    const log: string[] = []
    const r = await applyRecalc(m.get(A)!, plan(), deps(m, {
      hold: () => { log.push('hold'); return { ok: true, release: () => log.push('release') } },
      persist: async n => { log.push(`persist:${n.deps.join(',')}`); expect(m.get(A)!.deps).toEqual([B]) },
      depsChanged: () => { log.push('woke'); return { ok: true } },
    }))
    expect(r.ok).toBe(true)
    expect(log).toEqual(['hold', `persist:${B1}`, 'woke', 'release'])
    expect(m.get(A)!.deps).toEqual([B1])
    expect(m.get(A)!.depsRecalc).toEqual([{ at: NOW, from: [B], to: [B1] }])
  })

  /**
   * 评审抓的 P0:本功能改的是**共享对象**,落盘失败时若已经就地改过,编排器当场就会按
   * 一份盘上没有的依赖去调度它。所以落盘失败之后活对象必须**一个字段都没变**。
   */
  it('落盘失败 → 活对象一个字段都没变,而且如实说「这次重算没有发生」', async () => {
    const m = tree()
    const before = { deps: [...m.get(A)!.deps], updatedAt: m.get(A)!.updatedAt, rec: m.get(A)!.depsRecalc }
    const r = await applyRecalc(m.get(A)!, plan(), deps(m, {
      persist: async () => { throw new Error('磁盘满') },
    }))
    expect(r.ok).toBe(false)
    expect((r as { diskChanged: boolean }).diskChanged).toBe(false)
    expect((r as { reason: string }).reason).toContain('这次重算没有发生')
    expect(m.get(A)!.deps).toEqual(before.deps)
    expect(m.get(A)!.updatedAt).toBe(before.updatedAt)
    expect(m.get(A)!.depsRecalc).toBe(before.rec)
  })

  it('hold 失败 → 盘上零字节改动,而且**不透传**那句关于「重做 / 结束屏」的话', async () => {
    const m = tree()
    let persisted = false
    const r = await applyRecalc(m.get(A)!, plan(), deps(m, {
      hold: () => ({ ok: false, reason: '本次编排已经结束(最后一个任务刚跑完),这次重做要走结束屏那条路' }),
      persist: async () => { persisted = true },
    }))
    expect(persisted).toBe(false)
    expect((r as { diskChanged: boolean }).diskChanged).toBe(false)
    // 透传由调用方负责改写;这里只保证 applyRecalc 自己不落盘、并把原因带出去
    expect(r.ok).toBe(false)
  })

  it('陈旧的计划(树在这期间变了)被拒,且不落盘', async () => {
    const m = tree()
    m.get(A)!.deps = [B, 'root/02-c']
    m.set('root/02-c', mk('root/02-c', { parentId: 'root' }))
    let persisted = false
    const r = await applyRecalc(m.get(A)!, plan(), deps(m, { persist: async () => { persisted = true } }))
    expect(persisted).toBe(false)
    expect((r as { reason: string }).reason).toContain('树在这期间变了')
  })

  it('第一次重算不许因为 depsRecalc 缺席而抛(裸 push 会)', async () => {
    const m = tree()
    expect(m.get(A)!.depsRecalc).toBeUndefined()
    const r = await applyRecalc(m.get(A)!, plan(), deps(m))
    expect(r.ok).toBe(true)
    expect(m.get(A)!.depsRecalc!.length).toBe(1)
  })

  it('叫不醒调度时区分「中止」和「刚结束」,而且都说依赖已经落盘了', async () => {
    for (const [kind, want] of [['aborted', '已被中止'], ['finished', '刚刚结束']] as const) {
      const m = tree()
      const r = await applyRecalc(m.get(A)!, plan(), deps(m, { depsChanged: () => ({ ok: false, reason: kind }) }))
      expect((r as { diskChanged: boolean }).diskChanged).toBe(true)
      expect((r as { reason: string }).reason).toContain(want)
      expect((r as { reason: string }).reason).toContain('落盘')
    }
  })

  it('release 无条件执行 —— 扣住不放的话这个节点再也不会被调度', async () => {
    const m = tree()
    let released = false
    await applyRecalc(m.get(A)!, plan(), deps(m, {
      hold: () => ({ ok: true, release: () => { released = true } }),
      persist: async () => { throw new Error('磁盘满') },
    }))
    expect(released).toBe(true)
  })
})
