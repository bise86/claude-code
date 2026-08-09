/**
 * 质量验收席的对抗探针 —— 专攻实现者可能没想到的输入。
 *
 * 这个文件里的用例不是「再抄一遍已有覆盖」,而是逐条针对一个**没被现有探针钉住**的
 * 输入形态:空树 / 单节点 / 深树 / 成环 / 自指 / 重复依赖 / 装饰过的 dep 名 /
 * null 混入 / 超长 id / emoji 标题 / 全角边界 / 悬空依赖。
 */
import { describe, expect, it } from 'bun:test'
import {
  MAX_DEPS_PER_DEP, MAX_DEPS_TOTAL, RECALC_LIST_BUDGET,
  buildRecalcListing, depLabel, finalGuard, inSubtreeOf, normalizeRecalc, normalizeRef,
  recalcLines, recalcPrompt, recalcScope, resolveNeed, revalidateRecalc, subtreeFullyAccepted,
  subtreeIds,
} from './depsRecalc.js'
import { ANSWER_TAGS, answerTag, capText, parseDepsRecalc, MAX_RECALC_ID_CHARS } from './parseOutput.js'
import { notSchedulableReason } from './scheduler.js'
import { renderTreeSnapshot, serializeNode } from './persistence.js'
import { validateLoadedNodes } from './resumeCore.js'
import { createStreamStore } from './agentStream.js'
import { createNode, emptyPhaseRoles, MAX_DEPS_RECALC_RECORDS, type TaskNode } from './types.js'

const NOW = '2026-08-09T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id.split('/').pop() ?? id, parentId: null, deps: [], depth: id.split('/').length - 1,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})
const map = (ns: TaskNode[]): Map<string, TaskNode> => new Map(ns.map(n => [n.id, n]))

/** 和主探针同形的最小树:甲(CREATED,依赖乙)/ 乙(已拆 3 个子任务)。 */
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

const FENCE = '`'.repeat(3)
/** 一个带标记的代码块 —— tag 必须是 `answerTag()` 造出来的那种形状。 */
const block = (tag: string, o: unknown): string => `${FENCE}${tag}\n${JSON.stringify(o)}\n${FENCE}`

const need = (id: string, title = '', why = 'x') => ({ id, title, why })
const ans = (deps: { dep: string; needs: { id: string; title?: string; why?: string }[] }[]) =>
  ({ deps: deps.map(d => ({ dep: d.dep, needs: d.needs.map(n => need(n.id, n.title ?? '', n.why ?? 'x')) })) })

const scopeOf = (m: Map<string, TaskNode>, id = A) => {
  const s = recalcScope(m.get(id)!, m)
  if (s.ok !== true) throw new Error(`scope 被拒:${s.reason}`)
  return s
}

// ═══════════════════════════════════════════════════ 空 / 单节点 / 缺失

describe('退化的树', () => {
  it('空 byId + 节点不在树里:每个纯函数都不抛,而且给的是「找不到」而不是崩', () => {
    const empty = new Map<string, TaskNode>()
    const lone = mk('x', { deps: ['y'], status: 'CREATED' })
    expect(() => subtreeIds('x', empty)).not.toThrow()
    expect(subtreeIds('x', empty)).toEqual([])
    expect(inSubtreeOf('x', 'y', empty)).toBe(false)
    expect(subtreeFullyAccepted('x', empty)).toBe(false)
    expect(depLabel('x', empty)).toContain('节点缺失')
    const r = recalcScope(lone, empty)
    expect(r.ok).toBe(false)
  })

  it('单节点树(无依赖)→ 拒绝,而且说得出后果', () => {
    const n = mk('root', { status: 'CREATED' })
    const r = recalcScope(n, map([n]))
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('没有依赖')
  })

  it('依赖自己 → 最终安全闸整次放弃;自己不在 after 里就放行', () => {
    const m = tree()
    const a = m.get(A)!
    a.deps = [A, B]
    expect(finalGuard(a, m, [A, B], [B1])).toBeUndefined()
    expect(finalGuard(a, m, [A, B], [B1, A])).toContain('有它自己')
  })

  it('依赖指向本任务的上级 / 本任务自己的子任务 → 都整次放弃', () => {
    const m = tree()
    const a = m.get(A)!
    a.childIds = ['root/00-a/00-k']
    m.set('root/00-a/00-k', mk('root/00-a/00-k', { parentId: A, status: 'CREATED' }))
    expect(finalGuard(a, m, [B], ['root'])).toContain('上级')
    expect(finalGuard(a, m, [B], ['root/00-a/00-k'])).toContain('子任务')
  })
})

// ═══════════════════════════════════════════════════ 环

describe('成环的树', () => {
  it('childIds 成环:subtreeIds / subtreeFullyAccepted 都要终止', () => {
    const ns = [
      mk('c0', { childIds: ['c1'], status: 'ACCEPTED' }),
      mk('c1', { parentId: 'c0', childIds: ['c0'], status: 'ACCEPTED' }),
    ]
    const m = map(ns)
    const ids = subtreeIds('c0', m)
    expect(ids.sort()).toEqual(['c0', 'c1'])
    expect(() => subtreeFullyAccepted('c0', m)).not.toThrow()
  })

  it('childIds 自指(n 是自己的孩子)不死循环', () => {
    const n = mk('s', { childIds: ['s'], status: 'ACCEPTED' })
    const m = map([n])
    expect(subtreeIds('s', m)).toEqual(['s'])
    expect(() => subtreeFullyAccepted('s', m)).not.toThrow()
  })

  it('parentId 成环:inSubtreeOf / depLabel 都要终止', () => {
    const ns = [mk('p0', { parentId: 'p1' }), mk('p1', { parentId: 'p0' })]
    const m = map(ns)
    expect(inSubtreeOf('p0', 'zzz', m)).toBe(false)
    expect(() => depLabel('p0', m, null)).not.toThrow()
  })

  it('parentId 成环 + 走完整 normalizeRecalc 不挂死', () => {
    const m = tree()
    // 把 B2 的 parentId 指回自己的孩子 —— 手工编辑 node.md 真能做到
    m.get(B2)!.parentId = 'root/01-b/01-b2/00-b2a'
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }, { id: B3 }] }]))
    expect(p.after.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════ 深树

describe('depth 20 的深树', () => {
  const deep = (): { m: Map<string, TaskNode>; leafDep: string } => {
    const ns: TaskNode[] = [mk('root', { title: '根', status: 'WAITING_CHILDREN', childIds: ['root/00-a', 'root/01-b'] })]
    ns.push(mk('root/00-a', { title: '甲', parentId: 'root', deps: ['root/01-b'], status: 'CREATED', kind: 'unknown' }))
    let cur = 'root/01-b'
    ns.push(mk(cur, { title: '乙', parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [] }))
    for (let d = 0; d < 20; d++) {
      const next = `${cur}/00-${'x'.repeat(40)}`
      ns.find(n => n.id === cur)!.childIds = [next]
      ns.push(mk(next, { title: `层${d}`, parentId: cur, status: 'CREATED' }))
      cur = next
    }
    return { m: map(ns), leafDep: cur }
  }

  it('subtreeIds 走得完,清单不越预算,而且不会切在半行上', () => {
    const { m } = deep()
    const s = scopeOf(m)
    expect(s.groups[0].ids.length).toBe(21)
    const listing = buildRecalcListing(s.groups, m)
    expect(Array.from(listing.text).length).toBeLessThanOrEqual(RECALC_LIST_BUDGET)
    // 每一行要么是头行、要么是 `- id | ...` 的完整形态
    for (const line of listing.text.split('\n')) {
      if (line.startsWith('- ')) expect(line).toContain(' | ')
    }
  })

  it('深树上的 id 超过 200 码点 —— MAX_RECALC_ID_CHARS 必须放得下(否则合法 id 被截成不存在的 id)', () => {
    const { m, leafDep } = deep()
    expect(leafDep.length).toBeGreaterThan(200)
    expect(leafDep.length).toBeLessThan(MAX_RECALC_ID_CHARS)
    const s = scopeOf(m)
    const r = resolveNeed(need(leafDep), s.groups[0].ids, m)
    expect(r.id).toBe(leafDep)
  })
})

// ═══════════════════════════════════════════════════ 依赖列表本身的畸形

describe('依赖列表畸形', () => {
  it('同一个依赖在 node.deps 里出现两次 → 只发一组,不重复计数', () => {
    const m = tree({ [A]: { deps: [B, B] } })
    const s = scopeOf(m)
    expect(s.groups.length).toBe(1)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }] }]))
    expect(p.after).toEqual([B1])
  })

  /**
   * **【缺陷 · 已确认】** `recalcLines` / `ConfirmRecalcDeps` 印的是 `plan.before.length`,
   * 而 `before` 就是 `node.deps` 的原样拷贝(**不去重**),`after` 是去重的。
   * 总闸自己算下界时是 `new Set(before).size` —— 同一份数据在两处口径不同,而屏幕取的是
   * 松的那一份。`deps: [乙, 乙]` 细化成一条时,用户会读到「从 2 条变成 1 条」。
   */
  it('重复依赖只算一条 —— 屏幕上的数和总闸的下界必须同一个口径', () => {
    const m = tree({ [A]: { deps: [B, B] } })
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }] }]))
    expect(new Set(p.before).size).toBe(1)
    const text = recalcLines(p, m, 'root').join('\n')
    expect(text).toContain('从 1 条变成 1 条')
    expect(text).not.toContain('从 2 条')
  })

  /**
   * **【缺陷 · 已确认】** `recalcScope` **专门**为「依赖指向一个树里没有的 id」写了一条
   * `kept`(措辞是「重算不碰它」),于是那个 id 原样进了 `after`;而 `revalidateRecalc`
   * 无条件要求 `after` 里每一个 id 都在树里,于是在**树一个字节都没变**的情况下返回
   * 「树在这期间变了:… 已经不在树里,请重新按 d」。
   *
   * 同一个文件里两条判据互相否定:按 d → 花掉一次主模型调用 → 关口上给出一份细化方案 →
   * 回车 → 一句假的诊断 → 再按 d 还是这样。
   */
  it('本来就悬空的依赖不算「树变了」—— 否则按多少次 d 都是同一句假诊断', () => {
    const m = tree({ [A]: { deps: [B, 'root/99-ghost'] } })
    const s = scopeOf(m)
    expect(s.kept.some(k => k.dep === 'root/99-ghost')).toBe(true)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }] }]))
    expect(p.unchanged).toBe(false)
    expect(p.after).toContain('root/99-ghost')
    // 同一份 byId,一次 await 都没发生过 —— 不许报「树在这期间变了」
    expect(revalidateRecalc(m.get(A)!, m, p)).toBeUndefined()
    // 而**这次新加进来**的 id 消失了,仍然要拦
    m.delete(B1)
    expect(revalidateRecalc(m.get(A)!, m, p)).toContain('已经不在树里')
  })
})

// ═══════════════════════════════════════════════════ 模型回答的畸形

describe('模型回答畸形', () => {
  it('dep 名带装饰:反引号 / 列表符 / 全角 / 尾斜杠 —— 四种都要对回同一个依赖', () => {
    const m = tree()
    const s = scopeOf(m)
    for (const decorated of ['`root/01-b`', '- root/01-b', '"root/01-b"', 'root/01-b/', '01-b']) {
      const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: decorated, needs: [{ id: B1 }] }]))
      expect(p.after).toEqual([B1])
    }
  })

  it('全角 dep 名(ｒｏｏｔ/０１−ｂ 这种)也要对回来', () => {
    const m = tree()
    const s = scopeOf(m)
    const full = 'root/01-b'.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))
    expect(full).not.toBe('root/01-b')
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: full, needs: [{ id: B1 }] }]))
    expect(p.after).toEqual([B1])
  })

  it('同一项出现两次 → 去重,不许在 after 里出现两条', () => {
    const m = tree()
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }, { id: B1 }, { id: B1 }] }]))
    expect(p.after).toEqual([B1])
  })

  it('同一个 dep 在 answer.deps 里出现两次 → 两组 needs 合并', () => {
    const m = tree()
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([
      { dep: B, needs: [{ id: B1 }] },
      { dep: B, needs: [{ id: B3 }] },
    ]))
    expect(p.after).toEqual([B1, B3])
  })

  it('needs 里混入 null / 数组 / 字符串 / 数字 → 解析层丢掉,不抛', () => {
    const tag = answerTag(ANSWER_TAGS.deps)
    const text = block(tag, { deps: [{ dep: B, needs: [null, ['a'], 'b', { id: B1, title: 'B1', why: 'x' }, 3] }] })
    const r = parseDepsRecalc(text, tag)
    expect(r.answer?.deps[0].needs.map(n => n.id)).toEqual([B1])
  })

  it('deps 里混入 null / needs 是 null / 顶层 deps 是 null → 不抛', () => {
    const tag = answerTag(ANSWER_TAGS.deps)
    const t1 = block(tag, { deps: [null, { dep: B, needs: null }] })
    expect(parseDepsRecalc(t1, tag).answer?.deps[0].needs).toEqual([])
    const t2 = block(tag, { deps: null })
    expect(parseDepsRecalc(t2, tag).answer).toBeNull()
  })

  it('needs 项里 id/title/why 是数字或对象 → 归一成空串,不抛', () => {
    const tag = answerTag(ANSWER_TAGS.deps)
    const t = block(tag, { deps: [{ dep: B, needs: [{ id: 7, title: {}, why: [] }] }] })
    expect(parseDepsRecalc(t, tag).answer?.deps[0].needs[0]).toEqual({ id: '', title: '', why: '' })
  })

  it('resolveNeed 直接吃到 null id/title 不抛', () => {
    const m = tree()
    const s = scopeOf(m)
    const r = resolveNeed({ id: null as unknown as string, title: null as unknown as string, why: '' }, s.groups[0].ids, m)
    expect(r.id).toBeUndefined()
    expect(r.problem).toBeTruthy()
  })

  it('超长 id(远超上限)→ 解析层夹掉,归一化如实报「不在子树里」而不是命中别人', () => {
    const huge = `${B1}${'z'.repeat(MAX_RECALC_ID_CHARS * 2)}`
    const tag = answerTag(ANSWER_TAGS.deps)
    const text = block(tag, { deps: [{ dep: B, needs: [{ id: huge, title: '', why: '' }] }] })
    const r = parseDepsRecalc(text, tag)
    // capText 会在夹取处补一句提示,所以长度略大于上限;要点是它**被夹过**
    const got = Array.from(r.answer!.deps[0].needs[0].id).length
    expect(got).toBeLessThan(Array.from(huge).length)
    expect(got).toBeGreaterThanOrEqual(MAX_RECALC_ID_CHARS)
    const m = tree()
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, r.answer)
    expect(p.perDep[0].keptCoarse).toBeTruthy()
  })

  it('模型抄回占位符 → 单独报,不当成「不在子树里」', () => {
    const m = tree()
    const s = scopeOf(m)
    const r = resolveNeed(need('<从上面清单里逐字复制的节点 id>'), s.groups[0].ids, m)
    expect(r.problem).toContain('占位符')
  })
})

// ═══════════════════════════════════════════════════ Unicode / emoji

describe('Unicode / emoji 标题', () => {
  it('emoji 标题在清单 / 提示词 / 标签里都不被切成半个代理对', () => {
    const m = tree({ [B1]: { title: '🚀🔥 部署'.repeat(30) } })
    const s = scopeOf(m)
    const listing = buildRecalcListing(s.groups, m)
    // 不许出现孤立代理(0xD800-0xDFFF)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(listing.text)).toBe(false)
    const prompt = recalcPrompt({ node: m.get(A)!, byId: m, listing: listing.text, tag: 't' })
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(prompt)).toBe(false)
  })

  it('emoji / 组合字标题走 title 一侧也能对回来', () => {
    const m = tree({ [B1]: { title: '🚀 部署 é' } })
    const s = scopeOf(m)
    const r = resolveNeed(need('', '🚀 部署 é'), s.groups[0].ids, m)
    expect(r.id).toBe(B1)
  })

  /**
   * **【缺陷 · 已确认 · 最严重的一条】围栏注入。**
   *
   * `recalcPrompt` 的函数头写着「整份提示词里**一个反引号都没有**」,并点名这个仓库为
   * 「提示词里的示范被模型照抄回来、正好劈开自己的代码块」烧穿过一整棵树的迭代预算。
   * 而**节点标题 / 目标 / 上级方案要点全是原样铺进去的**:`listLine` 只过 `capText`,
   * `recalcPrompt` 里的 `node.title` / `node.goal` / `parentPlan` 也只过 `capText` ——
   * 三处都没有 `pipeline.ts` 的 `quote()`,也没有 `depsRecalcRun.ts` 自己那个 `neutralize()`
   * (那个只用在重拟的 feedback 上)。
   *
   * 一个标题带三反引号的子任务(「修复 ```js 代码块解析」这种完全可能由模型自己写出来)
   * 会把 schema 那个代码块从中间劈开。
   */
  it('标题里的三反引号被中和 —— 它会把 schema 代码块从中间劈开', () => {
    const m = tree({ [B1]: { title: `${FENCE}js 注入` } })
    const s = scopeOf(m)
    const listing = buildRecalcListing(s.groups, m)
    expect(listing.text).not.toContain(FENCE)
    const prompt = recalcPrompt({ node: m.get(A)!, byId: m, listing: listing.text, tag: 't' })
    // 只剩 schema 自己那一对
    expect(prompt.split(FENCE).length - 1).toBe(2)
  })

  it('本任务标题 / 目标 / 上级方案要点同样要中和', () => {
    const m = tree()
    Object.assign(m.get(A)!, { title: `甲${FENCE}`, goal: `目标${FENCE}` })
    Object.assign(m.get('root')!, { plan: { ...m.get('root')!.plan, keyPoints: `要点${FENCE}` } })
    const s = scopeOf(m)
    const prompt = recalcPrompt({
      node: m.get(A)!, byId: m, listing: buildRecalcListing(s.groups, m).text, tag: 't',
      parentPlan: m.get('root')!.plan.keyPoints,
    })
    expect(prompt.split(FENCE).length - 1).toBe(2) // 只剩 schema 自己那一对
  })
})

// ═══════════════════════════════════════════════════ normalizeRef 全角边界

describe('normalizeRef 的全角边界', () => {
  it('U+FF01(!)和 U+FF5E(~)是两端,必须换;U+FF00 和 U+FF5F 不许换', () => {
    expect(normalizeRef('！')).toBe('!')
    expect(normalizeRef('～')).toBe('~')
    // U+FF00 未分配、U+FF5F 是全角左白括号 —— 都不在 ASCII 可见区的映射范围里
    expect(normalizeRef('｟')).toBe('｟')
  })

  it('CJK 标点区(U+3000 段)不在映射范围里,原样保留', () => {
    for (const ch of ['。', '、', '「', '」', '·', '—']) {
      expect(normalizeRef(`x${ch}x`)).toBe(`x${ch}x`)
    }
  })

  /**
   * 全角逗号是 U+FF0C —— **在**范围里,会被换成半角 `,`。这是对的:比较双方
   * (清单里的 title 和模型抄回来的 title)都过同一次 `normalizeRef`,所以一致。
   * 写下来是因为它看起来像误伤。
   */
  it('全角逗号 / 冒号确实会被换成半角(两侧同变换,所以一致)', () => {
    expect(normalizeRef('甲,乙')).toBe('甲,乙')
    expect(normalizeRef('甲:乙')).toBe('甲:乙')
  })

  it('全角空格(U+3000)被 String.prototype.trim 吃掉 —— 两侧同规则,不产生歧义', () => {
    expect(normalizeRef('　a　')).toBe('a')
  })

  it('只由装饰组成的串归一成空,不会变成一个能命中东西的 ref', () => {
    for (const s of ['``', '""', '“”', '///', '   ']) expect(normalizeRef(s)).toBe('')
    // 光秃秃一个 '-' 不算列表符(规则要它后面跟空白),原样留下 —— 它不会命中任何 id
    expect(normalizeRef('- ')).toBe('-')
  })

  it('多层装饰叠加:`「"x"」` 这种只剥自己认识的那几种', () => {
    expect(normalizeRef('  - `"root/01-b"`  ')).toBe('root/01-b')
    expect(normalizeRef('“root/01-b”')).toBe('root/01-b')
    expect(normalizeRef('root/01-b///')).toBe('root/01-b')
  })

  it('全角转换后才剥装饰:全角反引号 / 全角减号的顺序', () => {
    // 全角引号 U+FF02 → " ,应当在剥装饰之前先转半角
    expect(normalizeRef('＂root/01-b＂')).toBe('root/01-b')
  })
})

// ═══════════════════════════════════════════════════ 数量闸的边界

describe('数量闸边界', () => {
  /** 一个依赖底下挂 n 个平级叶子,全部选中。 */
  const wide = (n: number): Map<string, TaskNode> => {
    const kids = Array.from({ length: n }, (_, i) => `root/01-b/${String(i).padStart(2, '0')}-k`)
    const ns = [
      mk('root', { status: 'WAITING_CHILDREN', childIds: ['root/00-a', 'root/01-b'] }),
      mk('root/00-a', { title: '甲', parentId: 'root', deps: ['root/01-b'], status: 'CREATED', kind: 'unknown' }),
      mk('root/01-b', { title: '乙', parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids }),
      ...kids.map(k => mk(k, { title: k.split('/').pop()!, parentId: 'root/01-b', status: 'CREATED' })),
    ]
    return map(ns)
  }

  it('单依赖超上限且全覆盖 → 卷成父(也就是原依赖本身),结果等于「没有变化」', () => {
    const m = wide(MAX_DEPS_PER_DEP + 2)
    const s = scopeOf(m)
    const all = s.groups[0].ids.filter(i => i !== B)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: all.map(id => ({ id })) }]))
    expect(p.after).toEqual([B])
    expect(p.unchanged).toBe(true)
  })

  it('总闸的下界是去重后的原依赖条数 —— 原依赖 20 条时不许把它卷到 16', () => {
    // 20 个各自独立、都还没拆的依赖(全部 kept)
    const deps = Array.from({ length: 20 }, (_, i) => `root/${String(i).padStart(2, '0')}-d`)
    const ns = [
      mk('root', { status: 'WAITING_CHILDREN', childIds: [...deps, 'root/99-a'] }),
      mk('root/99-a', { title: '甲', parentId: 'root', deps, status: 'CREATED', kind: 'unknown' }),
      ...deps.map(d => mk(d, { parentId: 'root', status: 'CREATED' })),
    ]
    // 其中一个已经拆了,让准入过得去
    const m = map(ns)
    m.get(deps[0])!.childIds = ['root/00-d/00-k']
    m.set('root/00-d/00-k', mk('root/00-d/00-k', { parentId: deps[0], status: 'CREATED' }))
    const node = m.get('root/99-a')!
    const s = recalcScope(node, m)
    expect(s.ok).toBe(true)
    const p = normalizeRecalc(node, m, s as never, ans([{ dep: deps[0], needs: [{ id: 'root/00-d/00-k' }] }]))
    expect(p.after.length).toBe(20)
    expect(p.after.length).toBeGreaterThan(MAX_DEPS_TOTAL)
  })

  it('卷不动时必须有显式出口(不许死循环)—— 平级无共同父的一堆', () => {
    // 每个依赖各出一项,项数超过 MAX_DEPS_TOTAL 且分属不同父
    const t0 = Date.now()
    const deps = Array.from({ length: 3 }, (_, i) => `root/${String(i).padStart(2, '0')}-d`)
    const ns: TaskNode[] = [mk('root', { status: 'WAITING_CHILDREN', childIds: [...deps, 'root/99-a'] })]
    ns.push(mk('root/99-a', { title: '甲', parentId: 'root', deps, status: 'CREATED', kind: 'unknown' }))
    for (const d of deps) {
      const kids = Array.from({ length: 7 }, (_, i) => `${d}/${String(i).padStart(2, '0')}-k`)
      ns.push(mk(d, { parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids }))
      for (const k of kids) ns.push(mk(k, { parentId: d, status: 'CREATED' }))
    }
    const m = map(ns)
    const node = m.get('root/99-a')!
    const s = recalcScope(node, m)
    expect(s.ok).toBe(true)
    const a = ans(deps.map(d => ({
      dep: d,
      needs: Array.from({ length: 7 }, (_, i) => ({ id: `${d}/${String(i).padStart(2, '0')}-k` })),
    })))
    const p = normalizeRecalc(node, m, s as never, a)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(p.after.length).toBeLessThanOrEqual(MAX_DEPS_TOTAL)
  })
})

// ═══════════════════════════════════════════════════ scheduler

describe('notSchedulableReason', () => {
  it('祖先阻断的节点:依赖全满足也不许说「马上就会被调度」', () => {
    const m = tree({ root: { status: 'BLOCKED' }, [B]: { status: 'ACCEPTED' } })
    const why = notSchedulableReason(m.get(A)!, m)
    expect(why).toContain('上级任务已阻断')
  })

  it('在飞 / 被扣住 / 终态各说各的', () => {
    const m = tree()
    expect(notSchedulableReason(m.get(A)!, m, { inFlight: new Set([A]) })).toContain('正在运行')
    expect(notSchedulableReason(m.get(A)!, m, { held: new Set([A]) })).toContain('扣住')
    const acc = tree({ [A]: { status: 'ACCEPTED' } })
    expect(notSchedulableReason(acc.get(A)!, acc)).toContain('终态')
  })

  it('依赖没满足 → 报「还在等 N 个依赖」,而 N 是真实条数', () => {
    const m = tree({ [A]: { deps: [B, B3] } })
    expect(notSchedulableReason(m.get(A)!, m)).toBe('还在等 2 个依赖任务完成')
  })

  it('推得动的节点返回 undefined', () => {
    const m = tree({ [B]: { status: 'ACCEPTED', childIds: [] } })
    expect(notSchedulableReason(m.get(A)!, m)).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════ 幸存变异的对照探针
//
// 下面每一条都**在当前代码上通过**,而在一条具体的变异下失败。它们的作用是把
// 「变异幸存」这件事定性:是探针坏了,还是覆盖真的缺 —— 结论是后者。

describe('对照探针:上卷的两级定序', () => {
  /**
   * 现有那条名字叫「优先卷『全部子任务都被选中』的那一组(用户点名的那一条)」的用例
   * **不区分这条规则**:那棵树上只有**一个**候选父节点(另一组只贡献 1 项,被
   * `kids.length >= 2` 先滤掉了),所以卷谁根本不由 `covered` 决定。
   * 把 `covered` 从排序里去掉,整份测试仍然全绿。
   */
  it('两个候选父都能卷时,卷「全覆盖」那个,而不是 id 小的那个', () => {
    const Q = 'root/01-b/00-q', P = 'root/01-b/01-p'
    const qk = [`${Q}/00-k`, `${Q}/01-k`, `${Q}/02-k`]
    const pk = [`${P}/00-k`, `${P}/01-k`]
    const ns = [
      mk('root', { status: 'WAITING_CHILDREN', childIds: [A, B] }),
      mk(A, { title: '甲', parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
      mk(B, { title: '乙', parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [Q, P] }),
      mk(Q, { title: 'Q', parentId: B, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: qk }),
      mk(P, { title: 'P', parentId: B, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: pk }),
      ...qk.map(k => mk(k, { parentId: Q, status: 'CREATED' })),
      ...pk.map(k => mk(k, { parentId: P, status: 'CREATED' })),
    ]
    const m = map(ns)
    const s = scopeOf(m)
    // Q 只被覆盖 2/3,P 被全覆盖;两组各 2 个成员,所以 kids 数打平,只剩 covered 能定序。
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{
      dep: B, needs: [{ id: qk[0] }, { id: qk[1] }, { id: pk[0] }, { id: pk[1] }],
    }]), { perDep: 3 })
    expect(p.perDep[0].rolledUp).toEqual([P])
    expect(p.after).toEqual([P, qk[0], qk[1]].sort())
  })

  /** 上卷不许卷到依赖子树外面去(手改过的 parentId 能造出这个形状)。 */
  it('两个子树成员的父在子树外 → 卷不动,而不是卷成本任务的上级', () => {
    const m = tree()
    m.get(B1)!.parentId = 'root'
    m.get(B3)!.parentId = 'root'
    const s = scopeOf(m)
    const p = normalizeRecalc(m.get(A)!, m, s, ans([{ dep: B, needs: [{ id: B1 }, { id: B3 }] }]), { perDep: 1 })
    expect(p.after).toEqual([B1, B3].sort())
    expect(p.warnings.join('')).toContain('卷不动了')
  })
})

describe('对照探针:id 救回的两条未覆盖分支', () => {
  /** title 侧的「同名弃权」有用例,**id 侧没有** —— 而「绝不模糊匹配」正是这个模块的立意。 */
  it('一个后缀能对上子树里两个节点 → 弃权,不许挑第一个', () => {
    const X = 'root/01-b/00-x', Y = 'root/01-b/01-y'
    const ns = [
      mk('root', { status: 'WAITING_CHILDREN', childIds: [A, B] }),
      mk(A, { title: '甲', parentId: 'root', deps: [B], status: 'CREATED', kind: 'unknown' }),
      mk(B, { title: '乙', parentId: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [X, Y] }),
      mk(X, { title: 'X', parentId: B, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [`${X}/00-k`] }),
      mk(Y, { title: 'Y', parentId: B, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [`${Y}/00-k`] }),
      mk(`${X}/00-k`, { title: 'KX', parentId: X, status: 'CREATED' }),
      mk(`${Y}/00-k`, { title: 'KY', parentId: Y, status: 'CREATED' }),
    ]
    const m = map(ns)
    const r = resolveNeed(need('00-k'), scopeOf(m).groups[0].ids, m)
    expect(r.id).toBeUndefined()
    expect(r.problem).toContain('认不出是哪一个')
  })

  /** 清单里的标题过了 `capText(200)`,模型只能照抄夹过的那一份 —— 比较双方必须同变换。 */
  it('标题超过 200 码点:模型照抄夹过的那一份也要能对回来', () => {
    const long = `长标题${'甲'.repeat(400)}`
    const m = tree({ [B1]: { title: long } })
    const asModelSees = capText(long, 200)
    expect(asModelSees).not.toBe(long)
    expect(resolveNeed(need('', asModelSees), scopeOf(m).groups[0].ids, m).id).toBe(B1)
  })
})

describe('对照探针:假 ACCEPTED 的递归那一层', () => {
  /**
   * 现有用例只造了**深度 1** 的假 ACCEPTED,而 `childrenAllAccepted` 单独就能挡住它。
   * 把递归整条去掉,整份测试仍然全绿。
   */
  it('孙辈才破:父与子都 ACCEPTED、孙子没有 → 这一条仍要整条退回', () => {
    const G = 'root/01-b/01-b2/00-b2a/00-g'
    const m = tree()
    Object.assign(m.get(B2)!, { status: 'ACCEPTED' })
    Object.assign(m.get(B2A)!, { status: 'ACCEPTED', childIds: [G] })
    Object.assign(m.get(B2B)!, { status: 'ACCEPTED' })
    m.set(G, mk(G, { parentId: B2A, status: 'CREATED' }))
    expect(subtreeFullyAccepted(B2, m)).toBe(false)
    const p = normalizeRecalc(m.get(A)!, m, scopeOf(m), ans([{ dep: B, needs: [{ id: B2 }] }]))
    expect(p.perDep[0].keptCoarse).toContain('自称已完成')
  })
})

describe('对照探针:应用那一刻的准入复用', () => {
  /**
   * 现有那条叫「陈旧的计划(树在这期间变了)被拒」的用例走的是
   * `sameSet(node.deps, plan.before)` 那一支 —— **准入那一支没有任何探针**,
   * 而模型调用是分钟级的,期间节点完全可以离开 CREATED、或者被用户按 x 取消。
   */
  it('调用期间被 x 取消 / 自己起跑了 → 应用那一刻必须拒绝', () => {
    const m = tree()
    const p = normalizeRecalc(m.get(A)!, m, scopeOf(m), ans([{ dep: B, needs: [{ id: B1 }] }]))
    expect(revalidateRecalc(m.get(A)!, m, p)).toBeUndefined()
    expect(revalidateRecalc(m.get(A)!, m, p, { cancelled: true })).toContain('取消')
    const m2 = tree({ [A]: { status: 'PLANNING' } })
    expect(revalidateRecalc(m2.get(A)!, m2, p)).toContain('已经开始分析')
  })
})

describe('对照探针:落盘 / 读回 / run.md(这一整块此前零行为断言)', () => {
  const rec = (at: string, from: string[], to: string[]) => ({ at, from, to })
  const OPTS = { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW }

  it('node.md 有「## 依赖重算」一节,逐条印 from → to,并印出被夹掉的条数', () => {
    const n = mk(A, {
      title: '甲', parentId: 'root', deps: [B1],
      depsRecalc: [rec('2026-08-09T00:00:00Z', [B], [B1])],
      depsRecalcDropped: 3,
    })
    const md = serializeNode(n)
    expect(md).toContain('## 依赖重算')
    expect(md).toContain(`${B} → ${B1}`)
    expect(md).toContain('另有 3 次')
    // 没重算过的节点版面**逐字节不变**
    expect(serializeNode(mk(A, { title: '甲', parentId: 'root' }))).not.toContain('依赖重算')
  })

  /**
   * 这一节跑在**每一次 commit** 上,而 node.md 按设计可以手工编辑 ——
   * 抛一次就是节点带着裸 TypeError 阻断,每次 `--resume` 复演。
   * (hostileDisk 那一趟走的是 `validateLoadedNodes`,它在 `serializeNode` 看到之前就
   * 已经把字段归一成数组了 —— 手改的 node.md 直接进 commit 那条路没有被走到过。)
   */
  it('node.md 那一节对手改的敌意值不抛', () => {
    for (const bad of ['boom', 42, { a: 1 }, [null], [{ from: 'x', to: 3 }], null]) {
      const n = mk(A, { title: '甲', parentId: 'root', depsRecalc: bad as never })
      expect(() => serializeNode(n)).not.toThrow()
    }
    for (const bad of ['boom', Number.NaN, -3, { }]) {
      const n = mk(A, { title: '甲', parentId: 'root', depsRecalcDropped: bad as never })
      expect(() => serializeNode(n)).not.toThrow()
    }
  })

  it('run.md 的 ⟲ ×N 算「留下的 + 夹掉的」,坏数据算 0', () => {
    const snap = (over: Partial<TaskNode>): string => renderTreeSnapshot([
      mk('root', { title: '根', status: 'WAITING_CHILDREN', childIds: [A] }),
      mk(A, { title: '甲', parentId: 'root', ...over }),
    ])
    expect(snap({ depsRecalc: [rec('t', [], [])], depsRecalcDropped: 4 })).toContain('⟲ 依赖重算 ×5')
    expect(snap({ depsRecalc: [rec('t', [], [])] })).toContain('⟲ 依赖重算 ×1')
    // 手改过的 node.md:`depsRecalc: boom` 上 `.length === 4` —— 不许印出一个凭空的 ×4
    expect(snap({ depsRecalc: 'boom' as never })).not.toContain('⟲')
    expect(snap({})).not.toContain('⟲')
  })

  it('恢复边界:夹到 20 条(最老 1 + 最近 19),丢弃计数**累加**', () => {
    const many = Array.from({ length: 25 }, (_, i) => rec(`t${i}`, [`f${i}`], [`x${i}`]))
    const n = mk('root', { title: '根', depsRecalc: many, depsRecalcDropped: 7 })
    const out = validateLoadedNodes([n], OPTS)
    const got = out.nodes[0]!
    expect(got.depsRecalc!.length).toBe(MAX_DEPS_RECALC_RECORDS)
    // 最老那一条按**位置**留下 —— 它的 from 是这条链的起点
    expect(got.depsRecalc![0].from).toEqual(['f0'])
    expect(got.depsRecalc![1].from).toEqual(['f6'])
    expect(got.depsRecalcDropped).toBe(12) // 7 + 5,不是 5
    expect(out.repairs.join('')).toContain('累计未逐条保留 12')
  })

  it('恢复边界:from/to 不是数组的记录整条丢掉并记一条 repair', () => {
    const n = mk('root', {
      title: '根',
      depsRecalc: [{ at: 't', from: 'x', to: [] }, { at: 't2', from: [], to: [] }] as never,
    })
    const out = validateLoadedNodes([n], OPTS)
    expect(out.nodes[0]!.depsRecalc!.length).toBe(1)
    expect(out.repairs.join('')).toContain('1 条依赖重算记录已损坏')
  })
})

describe('对照探针:重算那次调用的实时输出窗', () => {
  /**
   * **【缺陷 · 已确认】** `efftask.tsx` 逐字写的是
   * `streams.current.open(target.id, '依赖重算')`,而 `StreamStore.open` 收的是**一个
   * `StreamMeta` 对象**。于是这条流挂在一个 `undefined` 的 nodeId 上:
   * 详情页的「子 agent 输出」按 `streams(nodeId)` 取,永远取不到它;
   * 而 `ConfirmRecalcDeps` 那一屏**根本没有输出窗组件**(它的 useInput 注释却写着
   * 「这一屏挂着实时输出窗」)。一次分钟级、用户自己掏钱的调用,输出在任何地方都看不到。
   */
  it('位置参数的 open() 挂不到节点上,还会往 nodes() 里塞一个 null', () => {
    const s = createStreamStore()
    ;(s.open as unknown as (a: unknown, b: unknown) => unknown)(A, '依赖重算')
    expect(s.streams(A).length).toBe(0) // ← 详情页取不到
    expect(s.nodes()).toEqual([undefined] as never) // ← 一个 undefined 的 nodeId 进了流表
    // 对照:正确的调用形状
    const ok = createStreamStore()
    ok.open({ nodeId: A, phaseLabel: '依赖重算' } as never)
    expect(ok.streams(A).length).toBe(1)
    expect(ok.nodes()).toEqual([A])
  })
})
