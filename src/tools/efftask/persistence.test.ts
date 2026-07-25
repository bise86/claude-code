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
    async mkdirExclusive(p) { if (dirs.has(p)) return false; dirs.add(p); return true },
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

  it('round-trips a fully populated node, including content that could break YAML', async () => {
    const n = createNode({ id: 'root/01-x', title: '含冒号: 与"引号"', goal: '真实目标', parentId: 'root', deps: ['root/02-y'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.phaseRoles.review = [{ roleName: 'arch' }, { roleName: 'sec', model: 'sonnet' }]
    n.childIds = ['root/01-x/01-a']
    n.kind = 'decompose'
    n.status = 'BLOCKED'
    n.blockedReason = '评审迭代超限(3)'
    n.execStatus = '改了文件\n---\n# 标题\n```json\n{"a":1}\n```\n\t制表符 🎉 中文'
    n.plan = { solution: '---\n方案', keyPoints: '&anchor', risks: '2026-07-25', acceptance: 'yes' }
    n.worktree = { branch: 'efftask/001/root-01-x', path: '/tmp/wt' }
    n.iteration = { planReview: 2, acceptance: 1, integration: 0 }
    n.reviewLog = [{ round: 1, verdicts: [{ role: 'arch', pass: false, blocking: ['缺验收点'], comments: 'c' }], synthesized: { pass: false, blockingSummary: '[arch] 缺验收点' } }]
    n.acceptLog = []
    n.score = { plan: { role: 'obs', score: 88, rationale: 'ok' }, exec: { role: 'obs', score: 91, rationale: 'good' } }
    const back = parseNodeFile(serializeNode(n))
    expect(back).toEqual(n) // every field survives, byte-for-byte
  })

  it('normalises missing iteration counters to 0 when reading an older node.md', async () => {
    // A file written by an earlier build has no `integration` counter. Left undefined it
    // would make `undefined + 1 === NaN`, and `NaN >= maxIterations` is false — turning a
    // bounded retry loop into an unbounded one issuing real model calls.
    const n = createNode({ id: 'root', title: 'T', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const text = serializeNode(n).replace(/\n {2}integration: 0/, '')
    expect(text).not.toContain('integration')
    const back = parseNodeFile(text)
    expect(back.iteration).toEqual({ planReview: 0, acceptance: 0, integration: 0 })
    // and a garbage counter is not trusted either
    const junk = parseNodeFile(serializeNode(n).replace('planReview: 0', 'planReview: "many"'))
    expect(junk.iteration.planReview).toBe(0)
  })

  it('loadRun keeps the nodes it can read when one node.md is corrupt', async () => {
    // A crash is exactly what leaves a half-written node.md behind, so one bad file
    // must not throw away every node that WAS recovered.
    const fs = memFs()
    const good = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', good)
    fs.store.set('/eff/001/root/01-broken/node.md', '这不是 frontmatter')
    const { nodes, errors } = await loadRun(fs, '/eff/001')
    expect(nodes.map(n => n.id)).toEqual(['root'])
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toContain('01-broken')
  })

  it('renderTreeSnapshot nests by childIds, not by array order', async () => {
    // loadRun's order comes from readdir, which no filesystem guarantees.
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const child = createNode({ id: 'root/01-a', title: '子', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    root.childIds = ['root/01-a']
    const shuffled = renderTreeSnapshot([child, root]) // child first on purpose
    const lines = shuffled.trim().split('\n').filter(l => l.startsWith('-') || l.startsWith(' '))
    expect(lines[0]).toContain('根')
    expect(lines[1]).toMatch(/^ {2}- .*子/) // child indented under its parent
    expect(shuffled).toBe(renderTreeSnapshot([root, child])) // order-independent
  })

  it('allocateRunId ignores non-numeric dirs and rethrows when the root exists but is unreadable', async () => {
    const fs = memFs()
    await fs.mkdir('/eff/007'); await fs.mkdir('/eff/abc'); await fs.mkdir('/eff/0012')
    expect(await allocateRunId(fs, '/eff')).toBe('013') // 'abc' ignored; '0012' parses as 12 → next is 13
    const broken: FsLike = { ...memFs(), async readdir() { throw new Error('EACCES') }, async exists() { return true } }
    // An unreadable-but-present root must NOT look empty: handing out 001 would
    // overwrite an existing run's tree.
    await expect(allocateRunId(broken, '/eff')).rejects.toThrow('EACCES')
    const missing: FsLike = { ...memFs(), async readdir() { throw new Error('ENOENT') }, async exists() { return false } }
    expect(await allocateRunId(missing, '/eff')).toBe('001')
  })

  it('slugify never escapes the run dir and never ends on a separator', () => {
    expect(slugify('../../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('/absolute/path')).toBe('absolute-path')
    expect(slugify('!!!???')).toBe('node')
    expect(slugify('x'.repeat(39) + '🎉' + 'y'.repeat(10))).not.toMatch(/-$/)
    expect(slugify('中文标题测试')).toBe('中文标题测试')
  })
})

describe('run ids are reservations, not guesses', () => {
  it('two allocations racing on an empty root never get the same id', async () => {
    // Nothing is written until the orchestrator starts, so two /et commands launched in
    // that window would both scan an empty dir. Without an atomic reservation the second
    // overwrites the first run's entire tree while both report success.
    const fs = memFs()
    const [a, b] = await Promise.all([allocateRunId(fs, '/eff'), allocateRunId(fs, '/eff')])
    expect(a).not.toBe(b)
    expect([a, b].sort()).toEqual(['001', '002'])
  })

  it('reserves the next free id when earlier ones are taken', async () => {
    const fs = memFs()
    await fs.mkdirExclusive('/eff/001')
    await fs.mkdirExclusive('/eff/002')
    expect(await allocateRunId(fs, '/eff')).toBe('003')
  })

  it('a reserved id is really on disk, so a later scan sees it', async () => {
    const fs = memFs()
    const first = await allocateRunId(fs, '/eff')
    const second = await allocateRunId(fs, '/eff')
    expect(first).toBe('001')
    expect(second).toBe('002') // the reservation, not any written node, is what advances it
  })
})


describe('the artifacts must be readable and safe to cat', () => {
  it('run.md carries the blocked reason, not just the status', () => {
    // run.md is the file the transcript points at. "[failed] X (BLOCKED)" with the reason
    // buried in a nested node.md leaves a human unable to see why the run stopped.
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const child = createNode({ id: 'root/01-x', title: '会失败的一步', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    root.childIds = ['root/01-x']
    root.status = 'BLOCKED'; root.blockedReason = '子节点阻断'
    child.status = 'BLOCKED'; child.blockedReason = '验收迭代超限(3): [main] 迁移脚本没写'
    const snap = renderTreeSnapshot([root, child])
    expect(snap).toContain('迁移脚本没写')
    expect(snap).toContain('子节点阻断')
  })

  it('strips terminal control bytes from the markdown body', () => {
    // Titles, plans and exec statuses are model-authored. YAML escapes control bytes; a
    // markdown body does not, so `cat node.md` would clear the screen and set the title.
    const ESC = String.fromCharCode(27)
    const BEL = String.fromCharCode(7)
    const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
    const n = createNode({ id: 'root', title: ESC + '[2J' + ESC + ']0;PWNED' + BEL + '标题', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.execStatus = 'done' + BEL
    n.plan.solution = 'plan' + ESC + '[31m'
    const text = serializeNode(n)
    const body = text.slice(text.indexOf('\n---\n\n') + 6)
    expect(CTRL.test(body)).toBe(false)
    expect(body).toContain('标题') // the readable part survives
    expect(CTRL.test(renderTreeSnapshot([n]))).toBe(false)
  })
})
