/**
 * 详情页 `g` 键 —— 用户第 1 条:「这些损毁的任务必须恢复回来,可以通过某个键触发,
 * 主模型协助来完全正确的恢复。」
 *
 * 这个文件里**最重要的一档是「不许模型做什么」**:让它推断一个节点「应该是通过了的」,
 * 产出的是一条署名了却从未发生过的判决,以及一份并不在集成分支上的「已完成」产出。
 */
import { describe, expect, it } from 'bun:test'
import {
  applyRepair, conservativeStatus, damageOf, REPAIRABLE_FIELDS, repairPrompt, sanitizeRepair,
} from './nodeRepair.js'
import { repairNode, type RepairDeps } from './nodeRepairRun.js'
import { parseRepair } from './parseOutput.js'
import { createNodeJournal } from './nodeJournal.js'
import { loadRun, writeNode, type FsLike } from './persistence.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-11T00:00:00Z'
function memFs(): FsLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    store,
    async readFile(p) { const v = store.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v },
    async writeFile(p, d) { store.set(p, d) },
    async appendFile(p, d) { store.set(p, (store.get(p) ?? '') + d) },
    async mkdir(p) { dirs.add(p) },
    async mkdirExclusive(p) { if (dirs.has(p)) return false; dirs.add(p); return true },
    async unlink(p) { store.delete(p) },
    async rmdir(p) { dirs.delete(p) },
    async rename(a, b) { const v = store.get(a); if (v === undefined) throw new Error('ENOENT ' + a); store.set(b, v); store.delete(a) },
    async exists(p) { return store.has(p) || dirs.has(p) },
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : p + '/'
      const names = new Set<string>()
      for (const k of [...store.keys(), ...dirs]) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
      return [...names]
    },
  }
}
const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => Object.assign(
  createNode({
    id, title: id.split('/').pop()!, parentId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null,
    deps: [], depth: id.split('/').length - 1, phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  over,
)

describe('哪里坏了', () => {
  it('完整的节点没有损伤', () => {
    const d = damageOf(mk('root', { kind: 'decompose', title: 'T', goal: 'G' }))
    expect(d.blocking).toEqual([])
    expect(d.soft).toEqual([])
  })
  it('非法状态 / 丢了列表 / 没标题都认得出来', () => {
    const d = damageOf({ id: 'x', status: 'NOPE' as never, kind: 'executable' })
    expect(d.blocking.join()).toContain('状态非法')
    expect(d.blocking.join()).toContain('子任务列表丢了')
    expect(d.blocking.join()).toContain('依赖列表丢了')
    expect(d.soft.join()).toContain('没有标题')
  })
  it('`unknown` 是还没分析过的合法初值,不算坏', () => {
    expect(damageOf(mk('root')).blocking).toEqual([])
  })
})

describe('主模型能改什么、不能改什么', () => {
  it('判决和状态**一律拒收** —— 这是整个功能唯一真正危险的地方', () => {
    const node = { id: 'x', status: undefined } as Partial<TaskNode>
    const { patch, rejected } = sanitizeRepair({
      title: '真标题',
      status: 'ACCEPTED',
      acceptLog: [{ round: 1, verdicts: [{ role: '验收官', pass: true }] }],
      reviewLog: [{ round: 1 }],
      execStatus: '我猜它做完了',
      score: { exec: { score: 99 } },
    }, node)
    expect(patch).toEqual({ title: '真标题' })
    // 一条署名了却从未发生过的判决 = 凭空捏造的往事(和「强制通过」那条规矩同源)。
    for (const forbidden of ['status', 'acceptLog', 'reviewLog', 'execStatus', 'score']) {
      expect(rejected.join()).toContain(forbidden)
    }
  })

  it('盘上已有真值时,不采纳模型的版本 —— 事实压推测', () => {
    const node = mk('root', { title: '账里的真标题' })
    const { patch, rejected } = sanitizeRepair({ title: '模型猜的标题' }, node)
    expect(patch.title).toBeUndefined()
    expect(rejected.join()).toContain('盘上已有真值')
  })

  it('非法 kind 拒收,空值拒收', () => {
    const { patch, rejected } = sanitizeRepair({ kind: '随便写的', goal: '   ' }, { id: 'x' })
    expect(patch).toEqual({})
    expect(rejected.join()).toContain('不是合法类型')
    expect(rejected.join()).toContain('空值')
  })

  it('白名单是白名单 —— 新字段默认不可改', () => {
    const { patch } = sanitizeRepair({ worktree: { path: '/tmp/x' }, deps: ['a'] }, { id: 'x' })
    expect(patch).toEqual({})
    expect(REPAIRABLE_FIELDS).not.toContain('deps' as never)
  })
})

describe('状态按「宁可重跑一遍,不可谎报完成」定', () => {
  it('账里留着合法状态就用它', () => {
    expect(conservativeStatus({ status: 'ACCEPTED' })).toBe('ACCEPTED')
  })
  it('什么都没留下就回 CREATED,不猜 ACCEPTED', () => {
    expect(conservativeStatus({})).toBe('CREATED')
    expect(conservativeStatus({ status: 'HALF_WRITTEN' as never })).toBe('CREATED')
  })
})

describe('补齐之后是一个能被调度的节点', () => {
  it('结构性的洞全补上,而且不经模型', () => {
    const out = applyRepair({ id: 'root/01-a' }, { title: 'T' }, emptyPhaseRoles())
    expect(out.title).toBe('T')
    expect(out.childIds).toEqual([])
    expect(out.deps).toEqual([])
    expect(out.reviewLog).toEqual([])
    expect(out.acceptLog).toEqual([])
    expect(out.status).toBe('CREATED')
    expect(out.iteration.planReview).toBe(0)
    expect(out.depth).toBe(1)
  })
  it('连标题都补不出来时退回 id 的最后一段,不留空', () => {
    expect(applyRepair({ id: 'root/07-x' }, {}, emptyPhaseRoles()).title).toBe('07-x')
  })
})

describe('提示词', () => {
  const ctx = {
    node: { id: 'root/01-a', kind: 'executable' as const },
    raw: '方案里带着 ```json 代码块',
    parent: { title: '父任务', goal: '父目标' },
    siblings: ['兄弟一'],
  }
  it('把禁令写进去,而且点名了判决', () => {
    const p = repairPrompt(ctx, damageOf(ctx.node))
    expect(p).toContain('不要判断这个任务做完了没有')
    expect(p).toContain('评审、验收结论')
    expect(p).toContain('宁可留空也不要编')
  })
  it('铺进去的原文要中和反引号 —— 否则它当场劈开我们自己的代码块', () => {
    const p = repairPrompt(ctx, damageOf(ctx.node))
    // 我们自己那一对围栏之外不许再出现三反引号(见 prompt-teaches-the-bug)。
    expect(p).not.toContain('```json')
  })
})

describe('解析:铺进提示词的旧块不许被当成本轮回答', () => {
  it('要求带标记 —— 无标记的同形块一概不认', () => {
    const reply = '这是坏文件里的旧内容:\n```json\n{"title":"旧的"}\n```\n我看不出来。'
    expect(parseRepair(reply, 'repairxyz').answer).toBeNull()
  })
  it('带标记的才收', () => {
    const reply = '```repairxyz\n{"title":"新的"}\n```'
    expect(parseRepair(reply, 'repairxyz').answer).toEqual({ title: '新的' })
  })
  it('两个带标记的块 = 分不清,拒收', () => {
    const reply = '```repairxyz\n{"title":"A"}\n```\n```repairxyz\n{"title":"B"}\n```'
    const r = parseRepair(reply, 'repairxyz')
    expect(r.ambiguous).toBe(true)
  })
})

describe('端到端:按下 g,盘上那个坏节点真的变好了', () => {
  const deps = (fs: FsLike, reply: string, byId: Map<string, TaskNode>): RepairDeps => ({
    fs, runDir: '/r', byId: () => byId,
    runAgent: async ({ prompt }) => reply.replace('TAG', prompt.match(/写成 (repair[a-z]+)/)?.[1] ?? 'repair'),
  })

  it('模型补上标题和目标,状态保守,盘上写回去了', async () => {
    const fs = memFs()
    const broken = { id: 'root/01-a', parentId: 'root', kind: 'executable' } as unknown as TaskNode
    const byId = new Map<string, TaskNode>([['root', mk('root', { kind: 'decompose', childIds: ['root/01-a'] })]])
    const out = await repairNode(
      broken,
      deps(fs, '```TAG\n{"title":"迁移表达式规范化","goal":"把 normalize.go 翻成 Rust"}\n```', byId),
      new AbortController().signal,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.node.title).toBe('迁移表达式规范化')
    expect(out.node.status).toBe('CREATED') // 没有证据 → 重跑,不谎报完成
    // **必须落盘** —— 只改内存的话下一次 --resume 会把同一个坏节点原样端回来。
    const { nodes } = await loadRun(fs, '/r')
    expect(nodes.find(n => n.id === 'root/01-a')!.title).toBe('迁移表达式规范化')
  })

  it('模型没按格式答也不算失败 —— 确定性的那部分照样补齐并落盘', async () => {
    const fs = memFs()
    const broken = { id: 'root/01-a', parentId: 'root' } as unknown as TaskNode
    const out = await repairNode(broken, deps(fs, '我不知道该怎么恢复。', new Map()), new AbortController().signal)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.note).toContain('只按盘上已有的信息恢复')
    expect(out.node.childIds).toEqual([])
    expect(fs.store.has('/r/root/01-a/node.md')).toBe(true)
  })

  it('中止:适配层返回空串而不是抛 —— 不许把取消报成「没按格式答」', async () => {
    const fs = memFs()
    const ac = new AbortController()
    const broken = { id: 'root/01-a', parentId: null } as unknown as TaskNode
    const out = await repairNode(
      broken,
      { fs, runDir: '/r', byId: () => new Map(), runAgent: async () => { ac.abort(); return '' } },
      ac.signal,
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe('aborted')
    // 中止就是什么都没动 —— 不许留下一个半修好的节点。
    expect(fs.store.has('/r/root/01-a/node.md')).toBe(false)
  })

  it('没坏的节点拒绝修 —— 不白烧一次调用', async () => {
    const fs = memFs()
    let called = 0
    const good = mk('root', { kind: 'decompose', title: 'T', goal: 'G' })
    await writeNode(fs, '/r', good)
    const out = await repairNode(
      good,
      { fs, runDir: '/r', byId: () => new Map(), runAgent: async () => { called++; return '' } },
      new AbortController().signal,
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe('not-damaged')
    expect(called).toBe(0)
  })

  it('skipModel:一个调用都不发,只用账和残骸修', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    await writeNode(fs, '/r', mk('root/01-a', { title: '账里的标题' }), j)
    let called = 0
    const broken = { id: 'root/01-a', parentId: 'root', title: '账里的标题' } as unknown as TaskNode
    const out = await repairNode(
      broken,
      { fs, runDir: '/r', byId: () => new Map(), runAgent: async () => { called++; return '' }, journal: j },
      new AbortController().signal,
      { skipModel: true },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(called).toBe(0)
    expect(out.asked).toBe(false)
    expect(out.node.title).toBe('账里的标题')
  })
})
