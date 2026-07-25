import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS } from './types.js'
import type { EffTaskConfig } from './types.js'
import { FsLike, slugify, childId, allocateRunId, serializeNode, parseNodeFile, writeNode, readNode, loadRun, writeRunManifest, renderTreeSnapshot } from './persistence.js'

const NOW = '2026-07-25T00:00:00Z'
function memFs(seed: Record<string, string> = {}): FsLike & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    store,
    async readFile(p) { const v = store.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v },
    async writeFile(p, data) { store.set(p, data) },
    async mkdir(p) { dirs.add(p) },
    async exists(p) { return store.has(p) || dirs.has(p) },
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : p + '/'
      const names = new Set<string>()
      for (const k of [...store.keys(), ...dirs]) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
  }
}

describe('persistence', () => {
  it('slugify & childId', () => {
    expect(slugify('设计 API Layer!')).toMatch(/api-layer/)
    expect(childId('root', 1, 'Do Thing')).toBe('root/01-do-thing')
  })
  it('allocateRunId increments zero-padded', async () => {
    expect(await allocateRunId(memFs(), '/eff')).toBe('001')
    const fs = memFs()
    await fs.mkdir('/eff/001'); await fs.mkdir('/eff/007')
    expect(await allocateRunId(fs, '/eff')).toBe('008')
  })
  it('serialize/parse node round-trips machine state', () => {
    const n = createNode({ id: 'root/01-x', title: 'X', parentId: 'root', deps: ['root/02-y'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.status = 'ACCEPTED'; n.kind = 'executable'; n.plan.solution = '方案文本'; n.score = { exec: { role: 'main', score: 88, rationale: 'ok' } }
    n.blockedReason = '评审迭代超限(3): [main] 缺验收点'
    const text = serializeNode(n)
    expect(text).toContain('## 阻断原因') // rendered in the body only when non-empty
    const parsed = parseNodeFile(text)
    expect(parsed.blockedReason).toBe('评审迭代超限(3): [main] 缺验收点')
    expect(parsed.id).toBe('root/01-x')
    expect(parsed.goal).toBe('X') // immutable goal round-trips via frontmatter {...node}
    expect(parsed.deps).toEqual(['root/02-y'])
    expect(parsed.status).toBe('ACCEPTED')
    expect(parsed.plan.solution).toBe('方案文本')
    expect(parsed.score.exec?.score).toBe(88)
  })
  it('writeNode/readNode go through fs at node.id path', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', n)
    expect(fs.store.has('/eff/001/root/node.md')).toBe(true)
    const back = await readNode(fs, '/eff/001', 'root')
    expect(back.title).toBe('根')
  })
  it('renderTreeSnapshot lists nodes with ui status', () => {
    const a = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    a.status = 'EXECUTING'
    const snap = renderTreeSnapshot([a])
    expect(snap).toContain('根')
    expect(snap).toContain('running')
  })
  it('loadRun walks the run dir recursively and returns all nodes (round-trip)', async () => {
    const fs = memFs()
    const runDir = '/eff/001'
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const c1 = createNode({ id: 'root/01-a', title: 'A', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    const c2 = createNode({ id: 'root/02-b', title: 'B', parentId: 'root', deps: ['root/01-a'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    root.childIds = ['root/01-a', 'root/02-b']; root.status = 'WAITING_CHILDREN'
    c1.status = 'ACCEPTED'; c2.status = 'CREATED'
    for (const n of [root, c1, c2]) await writeNode(fs, runDir, n)
    const { nodes } = await loadRun(fs, runDir)
    const byId = new Map(nodes.map(n => [n.id, n]))
    expect(nodes).toHaveLength(3)
    expect(byId.get('root')!.status).toBe('WAITING_CHILDREN')
    expect(byId.get('root/01-a')!.status).toBe('ACCEPTED') // status preserved
    expect(byId.get('root/02-b')!.deps).toEqual(['root/01-a']) // deps preserved
  })
  it('writeRunManifest writes run.md with createdAt + config in frontmatter', async () => {
    const fs = memFs()
    const cfg: EffTaskConfig = { goalPrompt: '目标 X', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeRunManifest(fs, '/eff/001', cfg, [root])
    const text = fs.store.get('/eff/001/run.md')!
    expect(text).toContain('createdAt')
    expect(text).toContain(NOW) // run-level createdAt taken from the root node
    expect(text).toContain('goalPrompt')
    expect(text).toContain('parallelism: 3')
    // final call carries the run outcome
    await writeRunManifest(fs, '/eff/001', cfg, [root], { status: 'blocked', reason: '评审迭代超限' })
    const final = fs.store.get('/eff/001/run.md')!
    expect(final).toContain('status: blocked')
    expect(final).toContain('评审迭代超限')
  })
})
