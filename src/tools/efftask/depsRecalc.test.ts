/**
 * 依赖重算的**判据**层。四席圆桌评审逐条抓出来的东西,在这里各有一条探针。
 *
 * 每条用例都注明它钉住的是哪一个失败 —— 这些不是假想的边界,是评审对着代码算出来的。
 */
import { describe, expect, it } from 'bun:test'
import {
  MAX_DEPS_PER_DEP, buildRecalcListing, depLabel, finalGuard, inSubtreeOf, normalizeRecalc,
  normalizeRef, recalcPrompt, recalcScope, resolveNeed, revalidateRecalc, subtreeFullyAccepted,
  subtreeIds, RECALC_LIST_BUDGET,
} from './depsRecalc.js'
import { parseDepsRecalc, ANSWER_TAGS, answerTag, MAX_RECALC_NEEDS } from './parseOutput.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-09T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id.split('/').pop() ?? id, parentId: null, deps: [], depth: id.split('/').length - 1,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const map = (ns: TaskNode[]): Map<string, TaskNode> => new Map(ns.map(n => [n.id, n]))

/**
 * root ─┬─ A(CREATED,依赖 B)
 *       └─ B(WAITING_CHILDREN)─┬─ B1(叶子)
 *                              ├─ B2 ─┬─ B2a
 *                              │      └─ B2b
 *                              └─ B3(叶子)
 */
function tree(over: Record<string, Partial<TaskNode>> = {}): Map<string, TaskNode> {
  const ns = [
    mk('root', { title: '根', kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['root/00-a', 'root/01-b'] }),
    mk('root/00-a', { title: '甲', parentId: 'root', deps: ['root/01-b'], status: 'CREATED', kind: 'unknown' }),
    mk('root/01-b', {
      title: '乙', parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-b/00-b1', 'root/01-b/01-b2', 'root/01-b/02-b3'],
    }),
    mk('root/01-b/00-b1', { title: 'B1', parentId: 'root/01-b', status: 'CREATED' }),
    mk('root/01-b/01-b2', {
      title: 'B2', parentId: 'root/01-b', status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-b/01-b2/00-b2a', 'root/01-b/01-b2/01-b2b'],
    }),
    mk('root/01-b/01-b2/00-b2a', { title: 'B2a', parentId: 'root/01-b/01-b2', status: 'CREATED' }),
    mk('root/01-b/01-b2/01-b2b', { title: 'B2b', parentId: 'root/01-b/01-b2', status: 'CREATED' }),
    mk('root/01-b/02-b3', { title: 'B3', parentId: 'root/01-b', status: 'CREATED' }),
  ]
  const m = map(ns)
  for (const [id, patch] of Object.entries(over)) Object.assign(m.get(id)!, patch)
  return m
}

const A = 'root/00-a'
const B = 'root/01-b'
const B1 = 'root/01-b/00-b1'
const B2 = 'root/01-b/01-b2'
const B2A = 'root/01-b/01-b2/00-b2a'
const B2B = 'root/01-b/01-b2/01-b2b'
const B3 = 'root/01-b/02-b3'

const need = (id: string, title = '', why = 'x') => ({ id, title, why })
const answer = (deps: { dep: string; needs: { id: string; title?: string; why?: string }[] }[]) =>
  ({ deps: deps.map(d => ({ dep: d.dep, needs: d.needs.map(n => need(n.id, n.title ?? '', n.why ?? 'x')) })) })

// ═══════════════════════════════════════════════════════════════ 准入

describe('准入', () => {
  it('依赖没拆分出子任务 → 直接返回(用户点名的那一条)', () => {
    const m = tree({ [B]: { childIds: [], status: 'CREATED', kind: 'unknown' } })
    const r = recalcScope(m.get(A)!, m)
    expect(r.ok).toBe(false)
    expect((r as { details: string[] }).details.join('')).toContain('还没拆分出子任务')
  })

  it('没有依赖 → 直接返回,而且要说出后果', () => {
    const m = tree({ [A]: { deps: [] } })
    const r = recalcScope(m.get(A)!, m)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('不会因为重算更早起跑')
  })

  it('依赖已完成 → 不参与细化(细化它买不到并发)', () => {
    // 必须有**第二条**没满足的依赖,否则 depsSatisfied 会在更早的那道门就把整次拒掉 ——
    // 「已完成」这条逐依赖分类只在多依赖时才轮得到说话。
    const m = tree({ [B]: { status: 'ACCEPTED' }, [A]: { deps: [B, 'root/02-c'] } })
    m.set('root/02-c', mk('root/02-c', { parentId: 'root', status: 'CREATED' }))
    m.get('root')!.childIds.push('root/02-c')
    const r = recalcScope(m.get(A)!, m)
    expect(r.ok).toBe(false)
    const details = (r as { details: string[] }).details.join('')
    expect(details).toContain('已经完成')
    expect(details).toContain('还没拆分出子任务')
  })

  it('依赖在树里找不到 → 说清这是真故障、会被永久挡住', () => {
    const m = tree({ [A]: { deps: ['root/99-ghost'] } })
    const r = recalcScope(m.get(A)!, m)
    expect((r as { details: string[] }).details.join('')).toContain('永远不会满足')
  })

  it('已经开始分析 → 拒绝,而终态要说的是另一句话', () => {
    const running = tree({ [A]: { status: 'PLANNING' } })
    expect((recalcScope(running.get(A)!, running) as { reason: string }).reason).toContain('已经开始分析')
    const done = tree({ [A]: { status: 'ACCEPTED' } })
    // 对一个 ACCEPTED 的节点说「已经开始分析」是错的
    const r = (recalcScope(done.get(A)!, done) as { reason: string }).reason
    expect(r).toContain('已经结束了')
    expect(r).not.toContain('已经开始分析')
  })

  it('被 x 取消过 → 拒绝(重算不许替他改主意)', () => {
    const m = tree()
    const r = recalcScope(m.get(A)!, m, { cancelled: true })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('取消过')
  })

  it('正在运行 → 自己一句话,不许复用「已经开始分析(当前 CREATED)」那句自相矛盾的话', () => {
    const m = tree()
    const r = recalcScope(m.get(A)!, m, { running: new Set([A]) })
    const reason = (r as { reason: string }).reason
    expect(reason).toContain('正在被调度器执行')
    expect(reason).not.toContain('已经开始分析')
  })

  it('祖先阻断 → 拒绝并说清按多少次都不会有事发生', () => {
    const m = tree({ root: { status: 'BLOCKED' } })
    const r = recalcScope(m.get(A)!, m)
    expect((r as { reason: string }).reason).toContain('上级任务已经阻断')
  })

  it('依赖此刻已经满足 → 拒绝(重算买不到并发)', () => {
    const m = tree({ [B]: { status: 'ACCEPTED' } })
    // 这里 B 已 ACCEPTED,depsSatisfied 为真
    const r = recalcScope(m.get(A)!, m)
    expect(r.ok).toBe(false)
  })

  it('编排器已结束 → 文案不许把人指向结束屏(那里没有这个键)', () => {
    const m = tree()
    const r = recalcScope(m.get(A)!, m, { finished: true })
    const reason = (r as { reason: string }).reason
    expect(reason).toContain('--resume')
    expect(reason).not.toContain('结束屏')
  })

  /**
   * 评审抓的那一条:`planRedo(entry:'plan')` 把 kind 打回 'unknown' **却不清 plan**
   * (stepStart 随后会整份覆盖它)。只判「方案全空」会挡掉这个**最该放行**的场景,
   * 而拒绝文案「改依赖不会改方案」在那条路上逐字为假。
   */
  it('任务重做之后(kind=unknown、plan 还留着旧的)仍然放行', () => {
    const m = tree({
      [A]: { kind: 'unknown', plan: { solution: '旧方案', keyPoints: 'k', risks: 'r', acceptance: 'a' } },
    })
    expect(recalcScope(m.get(A)!, m).ok).toBe(true)
  })

  it('从质疑修复重入(redoFrom 有值)→ 拒绝', () => {
    const m = tree({ [A]: { redoFrom: 'review' } })
    expect(recalcScope(m.get(A)!, m).ok).toBe(false)
  })

  it('方案已经写过(kind 也定了)→ 拒绝', () => {
    const m = tree({
      [A]: { kind: 'executable', plan: { solution: '写好了', keyPoints: '', risks: '', acceptance: '' } },
    })
    expect(recalcScope(m.get(A)!, m).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════ 归一化

describe('归一化', () => {
  const scopeOf = (m: Map<string, TaskNode>) => {
    const s = recalcScope(m.get(A)!, m)
    if (!s.ok) throw new Error('scope refused')
    return s
  }

  it('细化到孙节点一项 —— 用户点名的「依赖其二层孙子任务一项就要写准孙子任务」', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B2A }] }]))
    expect(plan.after).toEqual([B2A])
    expect(plan.outcome).toBe('refined')
  })

  /**
   * 这是 v2 → v3 改掉的那个反向优化:全部子任务都被选中时**不许**急切上卷。
   * 「依赖 {B2a,B2b}」解锁必然不晚于「依赖 B2」(后者还要多过一整场集成验收圆桌),
   * 所以只要没超闸,保留细的严格更优。
   */
  it('全部子任务都被选中、但没超闸 → 保留细项,不卷', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B2A }, { id: B2B }] }]))
    expect(plan.after).toEqual([B2A, B2B])
  })

  it('必须卷的时候,优先卷「全部子任务都被选中」的那一组(用户点名的那一条)', () => {
    /**
     * B2 的两个孩子都被选中(全覆盖),而 B1/B3 是 B 的另两个孩子、只被选中了部分。
     * 闸门压到 2 时,卷 B2 严格更好:它不会多等任何一个用不上的兄弟。
     */
    const m = tree()
    const s = recalcScope(m.get(A)!, m)
    if (!s.ok) throw new Error('refused')
    const plan = normalizeRecalc(
      m.get(A)!, m, s,
      answer([{ dep: B, needs: [{ id: B2A }, { id: B2B }, { id: B1 }] }]),
      { perDep: 2 },
    )
    expect(plan.after).toEqual([B1, B2].sort())
    expect(plan.perDep[0].rolledUp).toEqual([B2])
  })

  it('超过单条上限才卷,而且卷到刚好装下就停', () => {
    // 造一个 12 个叶子的依赖,超过 MAX_DEPS_PER_DEP=8
    const kids = Array.from({ length: 12 }, (_, i) => `${B}/${String(i).padStart(2, '0')}-k`)
    const ns = [
      mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: [A, B] }),
      mk(A, { parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
      mk(B, { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids }),
      ...kids.map(k => mk(k, { parentId: B, status: 'CREATED' })),
    ]
    const m = map(ns)
    const s = recalcScope(m.get(A)!, m)
    if (!s.ok) throw new Error('refused')
    const plan = normalizeRecalc(m.get(A)!, m, s, answer([{ dep: B, needs: kids.map(id => ({ id })) }]))
    // 12 个同父叶子 → 一次上卷就变成 [B] 本身
    expect(plan.after).toEqual([B])
    expect(plan.perDep[0].rolledUp).toEqual([B])
  })

  /**
   * 上卷判据对**叶子恒为真**(`every` 对空数组恒真)。不挡的话不动点会把整棵子树的叶子
   * 全吸进来再一路卷回 {D},功能在任何有叶子的树上恒定返回「没有变化」。
   * `childrenAllAccepted` 为完全相同的陷阱写过守卫。
   */
  it('叶子不会因为「没有子任务」被当成「全部子任务都在集合里」', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B1 }] }]))
    expect(plan.after).toEqual([B1])
  })

  it('祖先吃后代:同时选了 B2 和 B2a → 只留 B2', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B2 }, { id: B2A }] }]))
    expect(plan.after).toEqual([B2])
  })

  it('模型给的项全在子树外 → 兜底回原依赖,并报 all-dropped(不许说成「没得细」)', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: 'root/00-a' }] }]))
    expect(plan.after).toEqual([B])
    expect(plan.outcome).toBe('all-dropped')
    expect(plan.perDep[0].dropped.join('')).toContain('不在这个依赖的子树里')
  })

  it('模型什么都没给 → no-finer(它是一个结论,不是一次失败)', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), { deps: [] })
    expect(plan.outcome).toBe('no-finer')
    expect(plan.unchanged).toBe(true)
  })

  it('解析不出对象 → unparsed,而且和 all-dropped 分开', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), null)
    expect(plan.outcome).toBe('unparsed')
  })

  it('模型给了细项、被我们自己卷回原依赖 → rolled-back,不许报成 no-finer', () => {
    const m = tree()
    // 只有一个依赖,总闸设成 0 会被 floor(=1) 兜住;这里用 perDep=1 逼出上卷
    const plan = normalizeRecalc(
      m.get(A)!, m, scopeOf(m),
      answer([{ dep: B, needs: [{ id: B1 }, { id: B3 }] }]),
      { perDep: 1 },
    )
    expect(plan.after).toEqual([B])
    expect(plan.outcome).toBe('rolled-back')
  })

  /**
   * 「祖先 ACCEPTED ⇒ 后代全 ACCEPTED」不是不变式(growTree 那条 await 交错能造出反例)。
   * 选中一个自称已完成、底下却没跑完的节点,等于让本任务在半成品上起跑。
   */
  it('假 ACCEPTED:候选自称已完成、底下没完成 → 这一条整条退回原依赖', () => {
    const m = tree({ [B2]: { status: 'ACCEPTED' } }) // 但 B2a/B2b 仍是 CREATED
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B2 }] }]))
    expect(plan.after).toEqual([B])
    expect(plan.warnings.join('')).toContain('自称已完成')
  })

  it('真 ACCEPTED(整棵子树都完成)照常被采纳', () => {
    const m = tree({
      [B2]: { status: 'ACCEPTED' }, [B2A]: { status: 'ACCEPTED' }, [B2B]: { status: 'ACCEPTED' },
    })
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([{ dep: B, needs: [{ id: B2 }] }]))
    expect(plan.after).toEqual([B2])
  })

  it('结果去重且按 id 升序 —— 关口预演和真正执行必须逐字相同', () => {
    const m = tree()
    const plan = normalizeRecalc(m.get(A)!, m, scopeOf(m), answer([
      { dep: B, needs: [{ id: B3 }, { id: B1 }, { id: B1 }] },
    ]))
    expect(plan.after).toEqual([B1, B3])
  })
})

// ═══════════════════════════════════════════════════════════════ 数量闸不死循环

describe('总数闸', () => {
  it('卷不动时**不死循环**,并如实说这是原依赖条数决定的下界', () => {
    /**
     * 造一个「超了闸、但一步都卷不动」的形状:依赖 D 下面三个中间节点各带**一个**孙子,
     * 选中的正是那三个孙子 —— 每个父节点只有一个被选中的孩子,`collapseOnce` 要求 ≥2,
     * 于是一个候选组都没有。总闸设成 1,而下界(去重后的原依赖条数)是 1,所以 3 > 1
     * 一定进循环 —— 少了显式出口这里就是死循环,而它跑在按键处理里。
     */
    const mids = ['root/01-d/00-p', 'root/01-d/01-p', 'root/01-d/02-p']
    const kids = mids.map(p => `${p}/00-g`)
    const ns = [
      mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['root/00-a', 'root/01-d'] }),
      mk('root/00-a', { parentId: 'root', deps: ['root/01-d'], status: 'CREATED', kind: 'unknown' }),
      mk('root/01-d', { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: mids }),
      ...mids.map(p => mk(p, { parentId: 'root/01-d', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [`${p}/00-g`] })),
      ...kids.map(g => mk(g, { parentId: g.slice(0, g.lastIndexOf('/')), status: 'CREATED' })),
    ]
    const m = map(ns)
    const s = recalcScope(m.get('root/00-a')!, m)
    if (!s.ok) throw new Error('refused')
    const started = Date.now()
    const plan = normalizeRecalc(
      m.get('root/00-a')!, m, s,
      answer([{ dep: 'root/01-d', needs: kids.map(id => ({ id })) }]),
      { total: 1 },
    )
    expect(Date.now() - started).toBeLessThan(2000) // 不许挂住
    expect(plan.after).toEqual([...kids].sort())
    expect(plan.warnings.join('')).toContain('卷不动')
  })

  it('总闸用**去重后**的原依赖条数当下界', () => {
    const m = tree({ [A]: { deps: [B, B] } })
    const s = recalcScope(m.get(A)!, m)
    if (!s.ok) throw new Error('refused')
    const plan = normalizeRecalc(m.get(A)!, m, s, answer([{ dep: B, needs: [{ id: B1 }, { id: B3 }] }]), { total: 1 })
    // 去重后下界是 1,所以 2 项会被卷成 [B];若拿没去重的 2 当下界,这里会原样放行
    expect(plan.after).toEqual([B])
  })
})

// ═══════════════════════════════════════════════════════════════ id 救回

describe('id 归一化与救回', () => {
  it('去掉反引号/引号/列表前缀/尾斜杠/全角', () => {
    expect(normalizeRef('  `root/01-b`  ')).toBe('root/01-b')
    expect(normalizeRef('- "root/01-b/"')).toBe('root/01-b')
    expect(normalizeRef('ｒｏｏｔ')).toBe('root')
  })

  it('唯一后缀命中', () => {
    const m = tree()
    const scope = subtreeIds(B, m)
    expect(resolveNeed(need('01-b2'), scope, m).id).toBe(B2)
  })

  /**
   * 裸 endsWith 下 'root/12-y'.endsWith('2-y') 为真 —— 「序号形态写错」这种最常见的抄错
   * 会被匹配成**另一个真实节点**。后缀必须按 `/` 分段对齐。
   */
  it('后缀必须按 / 对齐:`1-b2` 不许命中 `01-b2`', () => {
    const m = tree()
    const scope = subtreeIds(B, m)
    expect(resolveNeed(need('1-b2'), scope, m).id).toBeUndefined()
  })

  it('答标题而不是 id 也能救回来(最常见的抄错形态)', () => {
    const m = tree()
    const scope = subtreeIds(B, m)
    expect(resolveNeed({ id: '', title: 'B2a', why: '' }, scope, m).id).toBe(B2A)
  })

  it('同名节点 → 弃权,而且措辞和「不在子树里」分开', () => {
    const m = tree({ [B1]: { title: '同名' }, [B3]: { title: '同名' } })
    const scope = subtreeIds(B, m)
    const r = resolveNeed({ id: '', title: '同名', why: '' }, scope, m)
    expect(r.id).toBeUndefined()
    expect(r.problem).toContain('同名')
  })

  it('id 与 title 互相矛盾 → 丢并说出来(对账必须在接受之前)', () => {
    const m = tree()
    const scope = subtreeIds(B, m)
    const r = resolveNeed({ id: B1, title: 'B3', why: '' }, scope, m)
    expect(r.id).toBeUndefined()
    expect(r.problem).toContain('矛盾')
  })

  it('模型照抄示例占位符 → 单独报,不混进「不在子树里」', () => {
    const m = tree()
    const r = resolveNeed(need('<从上面清单里逐字复制的节点 id>'), subtreeIds(B, m), m)
    expect(r.problem).toContain('占位符')
  })

  it('绝不做模糊匹配:一个改了两个字的 id 直接丢', () => {
    const m = tree()
    expect(resolveNeed(need('root/01-b/00-bX'), subtreeIds(B, m), m).id).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════ 安全闸

describe('最终安全闸', () => {
  it('依赖自己的祖先 → 整次放弃(父子门与依赖门互相等待,Kahn 查不出)', () => {
    const m = tree()
    expect(finalGuard(m.get(A)!, m, [B], ['root'])).toContain('上级')
  })

  it('依赖自己的子任务 → 整次放弃', () => {
    const m = tree({ [A]: { childIds: ['root/00-a/00-x'] } })
    m.set('root/00-a/00-x', mk('root/00-a/00-x', { parentId: A }))
    expect(finalGuard(m.get(A)!, m, [B], ['root/00-a/00-x'])).toContain('子任务')
  })

  /**
   * Kahn 的集合含「环的**下游**」。本节点本来就在某个既有环的下游时,直接看 after
   * 会把它误报成「这次重算成了环」,然后给一句不对症的解释。判据必须是 before/after 的差集。
   */
  it('本节点本来就在环里 → 不许把它误报成「这次重算成的环」', () => {
    /**
     * Kahn 的集合含环的**下游**,所以直接看 `after` 会把一个本来就推不动的节点算成
     * 「这次成的环」,然后给用户一句不对症的解释。判据必须是 before/after 的**差集**。
     */
    const m = tree()
    m.set('root/02-c', mk('root/02-c', { parentId: 'root', deps: [A], status: 'CREATED' }))
    m.get('root')!.childIds.push('root/02-c')
    m.get(A)!.deps = [B, 'root/02-c'] // A ↔ C 已经成环
    expect(finalGuard(m.get(A)!, m, [B, 'root/02-c'], [B1, 'root/02-c'])).toBeUndefined()
  })

  it('新指向一条推不动的依赖链 → 拒绝,措辞盖住两种读法', () => {
    const m = tree()
    m.get(B1)!.deps = [B3]
    m.get(B3)!.deps = [B1] // B1 ↔ B3 死锁
    expect(finalGuard(m.get(A)!, m, [B], [B1])).toContain('推不动')
  })

  it('真的成环 → 整次放弃', () => {
    const m = tree()
    m.get(B1)!.deps = [A] // B1 依赖 A;A 再去依赖 B1 就成环
    expect(finalGuard(m.get(A)!, m, [B], [B1])).toContain('成环')
  })
})

// ═══════════════════════════════════════════════════════════════ 应用前重校验

describe('应用前重校验', () => {
  it('依赖在模型调用期间被别人改过 → 拒绝', () => {
    const m = tree()
    const plan = { nodeId: A, before: [B], after: [B1], perDep: [], warnings: [], unchanged: false, outcome: 'refined' as const }
    m.get(A)!.deps = ['root/01-b', 'root/02-other']
    m.set('root/02-other', mk('root/02-other', { parentId: 'root' }))
    expect(revalidateRecalc(m.get(A)!, m, plan)).toContain('依赖已经被别的操作改过')
  })

  it('候选节点在这期间消失了 → 拒绝', () => {
    const m = tree()
    const plan = { nodeId: A, before: [B], after: [B1], perDep: [], warnings: [], unchanged: false, outcome: 'refined' as const }
    m.delete(B1)
    expect(revalidateRecalc(m.get(A)!, m, plan)).toContain('已经不在树里')
  })

  it('候选在这期间变成假 ACCEPTED → 拒绝(应用那一刻要再量一遍)', () => {
    const m = tree()
    const plan = { nodeId: A, before: [B], after: [B2], perDep: [], warnings: [], unchanged: false, outcome: 'refined' as const }
    m.get(B2)!.status = 'ACCEPTED' // 而 B2a/B2b 仍是 CREATED
    expect(revalidateRecalc(m.get(A)!, m, plan)).toContain('自称已完成')
  })

  it('一切照旧 → 放行', () => {
    const m = tree()
    const plan = { nodeId: A, before: [B], after: [B1], perDep: [], warnings: [], unchanged: false, outcome: 'refined' as const }
    expect(revalidateRecalc(m.get(A)!, m, plan)).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════ 提示词

describe('提示词与清单', () => {
  it('清单夹在预算之内,而且「还有 N 个未列出」写在每一组的最前面', () => {
    const kids = Array.from({ length: 400 }, (_, i) => `${B}/${String(i).padStart(3, '0')}-很长的子任务标题用来撑体积`)
    const ns = [
      mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: [A, B] }),
      mk(A, { parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
      mk(B, { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids }),
      ...kids.map(k => mk(k, { parentId: B, status: 'CREATED' })),
    ]
    const m = map(ns)
    const listing = buildRecalcListing([{ dep: B, ids: subtreeIds(B, m) }], m)
    expect(Array.from(listing.text).length).toBeLessThanOrEqual(RECALC_LIST_BUDGET)
    const head = listing.text.split('\n')[0]
    expect(head).toContain('未列出')
    // 掐中间留两头会先吃掉写在后面的那一行,所以它必须在最前面
    expect(listing.text.indexOf('未列出')).toBeLessThan(200)
  })

  it('连身份行都装不下的依赖会被点名,而不是发一次注定被掐的调用', () => {
    const m = tree()
    const listing = buildRecalcListing([{ dep: B, ids: subtreeIds(B, m) }], m, 5)
    expect(listing.tooBig).toEqual([B])
  })

  it('提示词里一个反引号都没有(除了围栏本身),也不给具体的示例 id', () => {
    const m = tree()
    const listing = buildRecalcListing([{ dep: B, ids: subtreeIds(B, m) }], m)
    const p = recalcPrompt({ node: m.get(A)!, byId: m, listing: listing.text, tag: 'depsxy' })
    // 围栏那两处之外不许有反引号
    expect(p.split('```').length - 1).toBe(2)
    expect(p).toContain('<从上面清单里逐字复制的节点 id>')
    expect(p).not.toMatch(/"id"\s*:\s*"root\//)
  })

  it('提示词里没有「全部子任务都要就写父任务」那条规则(它是有损的,合并归代码)', () => {
    const m = tree()
    const listing = buildRecalcListing([{ dep: B, ids: subtreeIds(B, m) }], m)
    const p = recalcPrompt({ node: m.get(A)!, byId: m, listing: listing.text, tag: 'depsxy' })
    expect(p).not.toContain('父任务的 id')
    expect(p).toContain('不要为了少写几项而改写成它们的父任务')
  })
})

// ═══════════════════════════════════════════════════════════════ 解析

describe('parseDepsRecalc', () => {
  const tag = 'depsabc'
  const wrap = (o: unknown): string => `回答如下:\n\`\`\`${tag}\n${JSON.stringify(o)}\n\`\`\`\n`

  it('认带标记的块', () => {
    const r = parseDepsRecalc(wrap({ deps: [{ dep: 'root/01-b', needs: [{ id: 'x', title: 't', why: 'w' }] }] }), tag)
    expect(r.answer?.deps[0].needs[0]).toEqual({ id: 'x', title: 't', why: 'w' })
  })

  it('**失败关闭**:没打标记的同形块一律不认(改 deps 是结构性变更)', () => {
    const text = '```json\n{"deps":[{"dep":"root/01-b","needs":[{"id":"x"}]}]}\n```'
    expect(parseDepsRecalc(text, tag).answer).toBeNull()
  })

  it('两个带标记的块 → ambiguous', () => {
    // 两块内容必须**不同**:`collectCandidates` 对逐字相同的块去重,拿两份一模一样的
    // 文本去测,证明不了任何事(这条探针第一版就是这么假绿的)。
    const t = wrap({ deps: [{ dep: 'root/01-b', needs: [] }] })
      + wrap({ deps: [{ dep: 'root/02-c', needs: [] }] })
    expect(parseDepsRecalc(t, tag).ambiguous).toBe(true)
  })

  it('围栏在场但内容坏了 → broken(重拟时才能诚实地说「你的 JSON 没解析成功」)', () => {
    const t = `\`\`\`${tag}\n{"deps": [ 坏掉\n\`\`\``
    const r = parseDepsRecalc(t, tag)
    expect(r.broken).toBe(true)
    expect(r.answer).toBeNull()
  })

  it('裸数组不算答案', () => {
    expect(parseDepsRecalc(`\`\`\`${tag}\n[{"dep":"x"}]\n\`\`\``, tag).answer).toBeNull()
  })

  it('needs 超过防御上限时截断,而且**报出来**', () => {
    const many = Array.from({ length: MAX_RECALC_NEEDS + 7 }, (_, i) => ({ id: `n${i}`, title: '', why: '' }))
    const r = parseDepsRecalc(wrap({ deps: [{ dep: 'd', needs: many }] }), tag)
    expect(r.answer?.deps[0].needs.length).toBe(MAX_RECALC_NEEDS)
    expect(r.truncated).toBe(7)
  })

  it('id 不按 200 夹 —— 合法 id 在深树上就有 224 码点', () => {
    const longId = 'root/' + Array.from({ length: 5 }, (_, i) => `${String(i).padStart(2, '0')}-${'子'.repeat(40)}`).join('/')
    const r = parseDepsRecalc(wrap({ deps: [{ dep: 'd', needs: [{ id: longId, title: '', why: '' }] }] }), tag)
    expect(r.answer?.deps[0].needs[0].id).toBe(longId)
  })

  it('deps tag 是自己的一个 ANSWER_TAG', () => {
    expect(ANSWER_TAGS.deps).toBe('deps')
    expect(answerTag(ANSWER_TAGS.deps).startsWith('deps')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════ 血缘工具

describe('血缘工具', () => {
  it('subtreeIds 带环保护,只收真实存在的节点', () => {
    const m = tree()
    m.get(B)!.childIds = [...m.get(B)!.childIds, 'root/01-b', 'root/99-ghost']
    expect(subtreeIds(B, m)).toEqual([B, B1, B2, B2A, B2B, B3].sort())
  })

  it('inSubtreeOf 带环保护', () => {
    const m = tree()
    m.get(B)!.parentId = B // 自指
    expect(inSubtreeOf(B, 'root', m)).toBe(false)
    expect(inSubtreeOf(B, B, m)).toBe(true)
  })

  it('subtreeFullyAccepted 对缺失子节点 fail-closed', () => {
    const m = tree({ [B2]: { status: 'ACCEPTED' } })
    m.delete(B2A)
    expect(subtreeFullyAccepted(B2, m)).toBe(false)
  })

  it('depLabel 对非兄弟给两级路径 —— 裸标题在「兄弟标题」那套坐标系里读起来像不存在的兄弟', () => {
    const m = tree()
    expect(depLabel(B, m, 'root')).toBe('乙')
    expect(depLabel(B2A, m, 'root')).toBe('B2 / B2a')
    expect(depLabel('root/99-ghost', m, 'root')).toContain('节点缺失')
  })
})
