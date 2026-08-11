/**
 * 状态账 —— 用户第 3、4 条:「各阶段的运行结果和状态必须保存,不能丢」
 * 「每个任务下的子任务信息也不能丢,可以只是名称或 ID」。
 *
 * 钉的是 node.md **写不下去**的那一刻:原子写要么全成要么全败,失败时盘上留着的是
 * 上一次的完整版本 —— 刚跑完那一关的结果就此不存在。这份账是那一刻唯一还在的东西。
 */
import { describe, expect, it } from 'bun:test'
import {
  createNodeJournal, nodeDelta, nodeJournalPath, readNodeJournal, replayNodeJournal,
} from './nodeJournal.js'
import { loadRun, writeNode, type FsLike } from './persistence.js'
import { createNode, emptyPhaseRoles } from './types.js'
import type { TaskNode } from './types.js'

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

describe('增量', () => {
  it('只记变了的顶层字段', () => {
    const a = mk('root')
    const b = { ...a, status: 'EXECUTING' as const, execStatus: '干完了' }
    const d = nodeDelta(a, b)
    expect(Object.keys(d).sort()).toEqual(['execStatus', 'status'])
  })

  it('字段被清掉也是一次变化 —— 一次性标记必须记得下来', () => {
    const a = mk('root', { skipPhase: 'accept' })
    const b = { ...a, skipPhase: undefined }
    const d = nodeDelta(a, b) as Record<string, unknown>
    // JSON 丢 undefined,所以写成 null;重放时翻回来。只记「有值」的话,重放出来的
    // 节点会带着一个早就用掉的跳过标记再跳一关。
    expect('skipPhase' in d).toBe(true)
    expect(d.skipPhase).toBeNull()
    const back = replayNodeJournal(`${JSON.stringify({ t: 'd', at: NOW, d })}\n`)
    expect(back.node!).toHaveProperty('skipPhase', undefined)
  })

  it('什么都没变就不写 —— 否则一次空 commit 也要占一行', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    const n = mk('root')
    await j.record(n)
    const after = fs.store.get(nodeJournalPath('/r', 'root'))!
    await j.record({ ...n })
    expect(fs.store.get(nodeJournalPath('/r', 'root'))).toBe(after)
  })
})

describe('重放', () => {
  it('全量 → 增量 → 增量,重放出最后的状态', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    const n = mk('root/01-a')
    await j.record(n)
    await j.record({ ...n, status: 'PLANNING' })
    await j.record({ ...n, status: 'EXECUTING', execStatus: '写完了' })
    const r = (await readNodeJournal(fs, '/r', 'root/01-a'))!
    expect(r.node!.status).toBe('EXECUTING')
    expect(r.node!.execStatus).toBe('写完了')
    expect(r.node!.title).toBe('01-a') // 全量那一条留下来的身份
    expect(r.badLines).toBe(0)
  })

  it('全量是**替换**不是合并 —— 压实之后被删掉的字段不许从更早的增量里复活', () => {
    const text = [
      JSON.stringify({ t: 'f', at: NOW, d: { id: 'x', execStatus: '老的' } }),
      JSON.stringify({ t: 'd', at: NOW, d: { blockedReason: '挂了' } }),
      JSON.stringify({ t: 'f', at: NOW, d: { id: 'x', status: 'ACCEPTED' } }),
    ].join('\n')
    const r = replayNodeJournal(text)
    expect(r.node).toEqual({ id: 'x', status: 'ACCEPTED' } as never)
  })

  it('坏行跳过,前面的记录一条不少', () => {
    const text = [
      JSON.stringify({ t: 'f', at: NOW, d: { id: 'x', title: 'T' } }),
      '{"t":"d","at":"…","d":{"stat',
    ].join('\n')
    const r = replayNodeJournal(text)
    expect(r.node!.title).toBe('T')
    expect(r.badLines).toBe(1)
  })

  it('超过上限就压实成一条全量 —— 不是停笔', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r', maxBytesPerNode: 400 })
    const n = mk('root')
    for (let i = 0; i < 30; i++) await j.record({ ...n, execStatus: `第 ${i} 次`.repeat(5) })
    const text = fs.store.get(nodeJournalPath('/r', 'root'))!
    expect(text.split('\n').filter(Boolean).length).toBeLessThan(5) // 压实过
    // **最新的状态必须还在** —— 停笔式的上限会把它丢掉,而那正是这份账要保的东西。
    const r = replayNodeJournal(text)
    expect(r.node!.execStatus).toContain('第 29 次')
  })
})

describe('node.md 写不下去时,阶段结果还在账里', () => {
  it('账先写、node.md 后写 —— 磁盘满时结果不丢', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    const n = mk('root/01-a')
    await writeNode(fs, '/r', n, j)

    // 现在磁盘满:原子写整个失败(临时文件都写不出去)。
    const full: FsLike = {
      ...fs,
      async writeFile(p, d) { if (p.endsWith('.tmp')) throw new Error('ENOSPC'); return fs.writeFile(p, d) },
    }
    const done = { ...n, status: 'ACCEPTED' as const, execStatus: '这一关真的跑完了' }
    await expect(writeNode(full, '/r', done, j)).rejects.toThrow(/ENOSPC/)

    // node.md 停在上一版……
    const { nodes } = await loadRun(fs, '/r')
    expect(nodes[0].status).not.toBe('ACCEPTED')
    // ……而这一关的结果在账里,一个字都没少。
    const r = (await readNodeJournal(fs, '/r', 'root/01-a'))!
    expect(r.node!.status).toBe('ACCEPTED')
    expect(r.node!.execStatus).toBe('这一关真的跑完了')
  })
})

describe('子任务信息不能丢(用户第 4 条)', () => {
  it('node.md 整个没了,只剩账 —— 节点连同它的名字照样回到树上', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    const root = mk('root', { kind: 'decompose', childIds: ['root/01-a'], status: 'WAITING_CHILDREN' })
    const kid = mk('root/01-a', { title: '迁移表达式规范化', status: 'PLAN_REVIEW' })
    await writeNode(fs, '/r', root, j)
    await writeNode(fs, '/r', kid, j)
    // 子节点的 node.md 被彻底毁掉(删了),只剩 state.jsonl
    fs.store.delete('/r/root/01-a/node.md')

    const { nodes, salvaged } = await loadRun(fs, '/r')
    const byId = new Map(nodes.map(n => [n.id, n]))
    expect(byId.has('root/01-a')).toBe(true)
    expect(byId.get('root/01-a')!.title).toBe('迁移表达式规范化')
    expect(byId.get('root/01-a')!.parentId).toBe('root')
    expect(salvaged.map(s => s.from)).toEqual(['账'])
    // 父任务看得见它 —— 这正是「childIds 有 5 个、树上只有 3 个」那个 bug 的反面。
    expect(byId.get('root')!.childIds.filter(c => byId.has(c))).toEqual(['root/01-a'])
  })

  it('node.md 是半截 + 账还在 → **账压在残骸上**(残骸停在被砍断的那一刻)', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    const n = mk('root/01-a', { kind: 'executable' })
    n.plan.solution = 'x'.repeat(20000)
    await writeNode(fs, '/r', n, j)
    // 又跑完一关,账记下了 ACCEPTED……
    await j.record({ ...n, status: 'ACCEPTED', execStatus: '做完了' })
    // ……而 node.md 还是更早那一版,并且被砍成半截
    fs.store.set('/r/root/01-a/node.md', fs.store.get('/r/root/01-a/node.md')!.slice(0, 8192))

    const { nodes, salvaged } = await loadRun(fs, '/r')
    const back = nodes.find(x => x.id === 'root/01-a')!
    // 反过来合的话,一个已经 ACCEPTED 的节点会退回 CREATED 并被重跑一遍。
    expect(back.status).toBe('ACCEPTED')
    expect(back.execStatus).toBe('做完了')
    expect(salvaged[0].from).toBe('账 + 残骸')
  })
})

describe('兼容老的 run(用户第 2 条)', () => {
  it('没有 state.jsonl 的 run 逐字按老路走', async () => {
    const fs = memFs()
    const n = mk('root', { status: 'ACCEPTED' })
    await writeNode(fs, '/r', n) // 不传账 —— 老调用点的样子
    expect(fs.store.has(nodeJournalPath('/r', 'root'))).toBe(false)
    const { nodes, errors, salvaged } = await loadRun(fs, '/r')
    expect(errors).toEqual([])
    expect(salvaged).toEqual([])
    expect(nodes[0].status).toBe('ACCEPTED')
  })

  it('账不存在时读回来是 undefined,不是错误', async () => {
    expect(await readNodeJournal(memFs(), '/r', 'root')).toBeUndefined()
  })

  it('state.jsonl 不叫 node.md,所以不会被当成一个额外的节点读进来', async () => {
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    await writeNode(fs, '/r', mk('root'), j)
    const { nodes } = await loadRun(fs, '/r')
    expect(nodes.map(n => n.id)).toEqual(['root'])
  })
})

describe('探针补洞:两条被变异测试抓出来没测到的', () => {
  it('账里的 id 和它所在的目录不一致时,**以目录为准**', async () => {
    /**
     * 「路径即 id」是这个仓库的既定规矩(spec §5)。账是可以被手工编辑、也可以被整个
     * 目录拷贝过来的 —— 一个带着别人 id 的账,如果按它自己说的算,恢复出来的节点会
     * 认领另一个节点的身份:父节点的 childIds 对不上,而 writeNode 会去写第二个目录。
     * 目录是唯一一个不会被写坏的信息源,由文件系统自己保证。
     */
    const fs = memFs()
    const j = createNodeJournal({ fs, runDir: '/r' })
    await writeNode(fs, '/r', mk('root'), j)
    await writeNode(fs, '/r', mk('root/01-a'), j)
    // node.md 没了,而账里的 id 指向别人
    fs.store.delete('/r/root/01-a/node.md')
    fs.store.set(
      nodeJournalPath('/r', 'root/01-a'),
      `${JSON.stringify({ t: 'f', at: NOW, d: { id: 'root/99-别人', title: '搬过来的账' } })}\n`,
    )
    const { nodes } = await loadRun(fs, '/r')
    const ids = nodes.map(n => n.id).sort()
    expect(ids).toEqual(['root', 'root/01-a'])
    expect(ids).not.toContain('root/99-别人')
  })
})
