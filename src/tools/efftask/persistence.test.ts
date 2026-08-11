import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { FsLike, salvageNodeFile, sweepTempFiles, writeFileAtomic, slugify, childId, allocateRunId, serializeNode, parseNodeFile, writeNode, readNode, loadRun, removeNodeDirs, writeRunManifest, renderTreeSnapshot } from './persistence.js'

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
    async unlink(p) { store.delete(p) },
    async rmdir(p) { dirs.delete(p) },
    async appendFile(p, data) { store.set(p, (store.get(p) ?? '') + data) },
    async rename(from, to) {
      const v = store.get(from)
      if (v === undefined) throw new Error('ENOENT ' + from)
      store.set(to, v)
      store.delete(from)
    },
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
    n.iteration = { planReview: 2, acceptance: 1, integration: 0, scoring: 3, mergeResolve: 1 }
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
    expect(back.iteration).toEqual({ planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 })
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


describe('node.md 的正文要留下角色意见和评分理由 (spec §7 / §4.2)', () => {
  const withLogs = () => {
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-01-01T00:00:00Z' })
    n.reviewLog = [{
      round: 1,
      verdicts: [
        { role: 'architect', pass: false, blocking: ['缺回滚方案'], comments: '' },
        { role: 'security', pass: true, blocking: [], comments: '没有暴露面' },
        { role: 'qa', pass: false, blocking: [], comments: '', infra: true },
      ],
      synthesized: { pass: false, blockingSummary: '[architect] 缺回滚方案' },
    }]
    n.score = {
      plan: { role: 'scorer', score: 88, rationale: '结构清楚' },
      exec: { role: 'scorer', score: 91, rationale: '测试齐全' },
    }
    return n
  }

  it('每个角色说了什么都写进正文', () => {
    // spec §7: "每一轮的角色意见与合成结果都追加进…并落盘到 node.md". Only the synthesized
    // verdict made it; the per-role opinions survived in the frontmatter, but the body is the
    // part a human opens this file to read, and "为什么没通过" is why they open it.
    const body = serializeNode(withLogs())
    expect(body).toContain('[architect] FAIL: 缺回滚方案')
    expect(body).toContain('[security] pass: 没有暴露面')
    // A reviewer whose CALL failed never judged anything — that must not read as a rejection.
    expect(body).toContain('[qa] CALL-FAILED')
  })

  it('评分带上理由,不只是数字', () => {
    const body = serializeNode(withLogs())
    expect(body).toContain('plan: 88 [scorer] — 结构清楚')
    expect(body).toContain('exec: 91 [scorer] — 测试齐全')
  })

  it('没有记录的节点不会多出空段落里的垃圾', () => {
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'x' })
    const body = serializeNode(n)
    expect(body).toContain('## 质疑修复记录\n\n')
    expect(body).toContain('plan: -')
  })

  it('角色名和理由里的控制字节被剥掉 —— 正文不像 frontmatter 那样会转义', () => {
    const n = withLogs()
    n.score.plan = { role: 'sc' + String.fromCharCode(27) + '[2Jorer', score: 1, rationale: 'a' + String.fromCharCode(7) + 'b' }
    const body = serializeNode(n)
    expect(body).not.toContain(String.fromCharCode(27))
    expect(body).not.toContain(String.fromCharCode(7))
  })
})

describe('路径即 id (spec §5)', () => {
  it('frontmatter 的 id 与目录不一致时,以目录为准并报出来', async () => {
    // Nothing checked this. A hand-edited or mis-copied id detached the node from its own
    // directory: every later writeNode created a SECOND directory, and the original was read
    // back again on the next resume.
    const files = new Map<string, string>()
    const n = createNode({ id: 'root/99-wrong', title: 'a', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: 'x' })
    files.set('/run/root/01-right/node.md', serializeNode(n))
    const fs2 = {
      readFile: async (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
      writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
      unlink: async () => {}, rmdir: async () => {}, rename: async () => {}, appendFile: async () => {}, exists: async () => true,
      readdir: async (d: string) => {
        if (d === '/run') return ['root']
        if (d === '/run/root') return ['01-right']
        if (d === '/run/root/01-right') return ['node.md']
        throw new Error('not a dir')
      },
    }
    const { nodes, errors } = await loadRun(fs2 as never, '/run')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('root/01-right')          // the directory wins
    expect(errors.some(e => e.message.includes('不一致'))).toBe(true)
  })
})


describe('正文里的模型作者文本要有上限,控制字节要剥干净', () => {
  const withBig = (n = 4000) => {
    const node = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'x' })
    node.reviewLog = [{
      round: 1,
      verdicts: [{ role: 'a', pass: false, blocking: ['x'.repeat(n)], comments: '' }],
      synthesized: { pass: false, blockingSummary: 's' },
    }]
    return node
  }

  it('单条意见按码点截断,并指向 frontmatter', () => {
    // blocking[] length and each entry's length are both model-authored, and this was the one
    // body surface with no cap — measured 73.8K of body for 3 rounds x 5 roles x 6 blockings.
    const body = serializeNode(withBig())
    expect(body).toContain('完整内容见 frontmatter')
    // …and the full value is still in the frontmatter, so nothing is actually lost.
    expect(parseNodeFile(body).reviewLog[0].verdicts[0].blocking[0].length).toBe(4000)
  })

  it('短的意见不被截断', () => {
    expect(serializeNode(withBig(10))).not.toContain('完整内容见 frontmatter')
  })

  it('角色名、意见、评分数字里的控制字节全部剥掉', () => {
    // Every one of these comes off yamlParse, and validateLoadedNodes only checks that
    // `score` is an object — a hand-edited node.md can put ESC[2J in the NUMBER.
    const esc = String.fromCharCode(27)
    const node = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'x' })
    node.reviewLog = [{
      round: 1,
      verdicts: [{ role: 'a' + esc + '[2Jb', pass: false, blocking: ['c' + esc + '[31md'], comments: '' }],
      synthesized: { pass: false, blockingSummary: 's' },
    }]
    node.score = { plan: { role: 'r' + esc + 'x', score: ('9' + esc + '[2J9') as never, rationale: 'e' + esc + 'f' } }
    const body = serializeNode(node)
    expect(body.slice(body.indexOf('## 评审记录'))).not.toContain(esc)
  })
})


describe('writer 自己也不能被坏数据打死', () => {
  it('score.rationale 不是字符串时 serializeNode 不抛', () => {
    // The validator normalises this, but serializeNode runs on EVERY commit and a throw here
    // blocks the node with a raw TypeError and repeats on every resume. Belt and braces —
    // and the belt half needs its own test, or only the braces are actually covered.
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'x' })
    n.score = { plan: { role: 'r', score: 1, rationale: 90 as never } }
    expect(() => serializeNode(n)).not.toThrow()
    expect(serializeNode(n)).toContain('plan: 1')
  })

  it('role 和 score 不是字符串/数字时也不抛', () => {
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'x' })
    n.score = { exec: { role: { a: 1 } as never, score: 'x' as never, rationale: '' } }
    expect(() => serializeNode(n)).not.toThrow()
  })
})

describe('spec §13:renderTreeSnapshot 的输出必须稳定', () => {
  const nd = (id: string, title: string, over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({ id, title, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
    ...over,
  })

  it('同一棵树,节点数组顺序不同,快照必须一模一样', () => {
    // §13 列了「renderTreeSnapshot 输出稳定」,而在此之前零覆盖。实测同一棵多根树
    // `[root, orphan]` 和 `[orphan, root]` 会渲染出两个不同的文件 —— 而 loadRun 的节点
    // 来自 readdir,顺序没有任何保证。run.md 每次 commit 都重写,于是这会变成读的人
    // 分辨不出是不是真的动了的抖动。多根树正是恢复期的损坏形状,不是纸上谈兵。
    // **两个**根级节点。第一版只放了一个根,于是第一趟遍历无论数组怎么排都只发出它一个,
    // "顺序无关"是碰巧成立的 —— 把排序删掉照样绿(变异跑出来的)。多根正是 §17 恢复期真会
    // 出现的形状:父指针指向一个没恢复出来的节点时,validateLoadedNodes 会把它提为根级。
    const a = nd('root', 'A', { kind: 'decompose', childIds: ['root/01-x'] })
    const kid = nd('root/01-x', 'X', { parentId: 'root', depth: 1 })
    const b = nd('zz-second-root', 'B')
    const orphan = nd('mm-orphan', 'C', { parentId: 'ghost', depth: 1 })
    const s1 = renderTreeSnapshot([a, kid, b, orphan])
    const s2 = renderTreeSnapshot([b, orphan, kid, a])
    const s3 = renderTreeSnapshot([orphan, b, a, kid])
    expect(s2).toBe(s1)
    expect(s3).toBe(s1)
    // …而且确实是按 id 排的,不是碰巧和某个输入顺序一致。
    expect(s1.indexOf('A (')).toBeLessThan(s1.indexOf('B ('))
  })

  it('子节点仍按 childIds 的顺序,那个顺序是有含义的', () => {
    // 子节点顺序是创建顺序,每个子 id 的 `NN-` 前缀就编码着它 —— 不能一起按 id 排掉,
    // 那会把"先做哪个"这个信息抹平。这里故意让 childIds 的顺序和 id 的字典序相反。
    const p = nd('root', 'P', { kind: 'decompose', childIds: ['root/02-b', 'root/01-a'] })
    const b = nd('root/02-b', 'BBB', { parentId: 'root', depth: 1 })
    const a = nd('root/01-a', 'AAA', { parentId: 'root', depth: 1 })
    const out = renderTreeSnapshot([p, a, b])
    expect(out.indexOf('BBB')).toBeLessThan(out.indexOf('AAA'))
  })
})

describe('验收记录要说清哪一轮是哪一关', () => {
  // 测试修复和验收共用 acceptLog、也共用 iteration.acceptance 计数,于是「## 验收记录」
  // 里会出现两条 `round 1`,而升级卡片写的正是「先看该节点的验收记录」。
  const rec = (over: object = {}) => ({
    round: 1, verdicts: [{ role: 'r', pass: true, blocking: [], comments: '' }],
    synthesized: { pass: true, blockingSummary: '' }, ...over,
  })

  it('测试修复那一轮被标出来', () => {
    const n = createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'NOW' })
    n.acceptLog = [rec({ step: 'verify' }), rec()] as never
    const body = serializeNode(n)
    expect(body).toContain('[测试修复] round 1')
    // 验收那一轮不加前缀 —— 老 node.md 的形状不变。
    expect(body).toContain('- round 1')
  })

  /**
   * 作废的那一轮要在 body 里读得出来。判据是**渲染**,不是内存里的字段:
   * `pipeline` 那侧的用例断的是 `node.acceptLog[].voided`,碰不到这一行 ——
   * 实测把这段渲染整个删掉,全量测试一条不红。
   */
  it('作废的那一轮标出来,而且排在 PASS/FAIL 之前', () => {
    const n = createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'NOW' })
    // `voided` 这条路今天由**老 node.md** 提供(测试修复不再作废任何一轮),所以拿一条
    // 老的验收记录当输入 —— 那才是它现在唯一还会出现的地方。
    n.acceptLog = [rec({ voided: '该轮裁决作废' })] as never
    const line = serializeNode(n).split('\n').find(l => l.startsWith('- round'))!
    expect(line).toContain('[已作废:')
    expect(line.indexOf('[已作废:')).toBeLessThan(line.indexOf('PASS'))
  })

  it('没有 voided 的记录逐字不变 —— 老 node.md 的形状不许动', () => {
    const n = createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'NOW' })
    n.acceptLog = [rec()] as never
    expect(serializeNode(n)).not.toContain('已作废')
  })

  it('没有 step 的老记录照旧渲染', () => {
    const n = createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: 'NOW' })
    n.acceptLog = [rec()] as never
    expect(serializeNode(n)).toContain('- round 1: PASS')
  })
})

describe('落选稿要真的落到人读得到的那一半', () => {
  // 「不静默截断」此前只做到了机器可读那一半:frontmatter 里有,body 里没有 ——
  // 人打开 node.md 什么都看不到。这一段整个删掉,全量 1385 条一条不红。
  const withAlts = (alts: { staff: string; solution: string }[]) => {
    const n = createNode({ id: 'root', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.plan = { solution: '融合稿', keyPoints: 'k', risks: 'r', acceptance: 'a', alternatives: alts }
    return n
  }

  it('body 里有「备选方案」段,每份一个小标题', () => {
    const md = serializeNode(withAlts([
      { staff: 'opus-架构', solution: 'A 方案正文' },
      { staff: 'ds-安全', solution: 'B 方案正文' },
    ]))
    expect(md).toContain('## 备选方案')
    expect(md).toContain('### opus-架构')
    expect(md).toContain('### ds-安全')
    expect(md).toContain('A 方案正文')
    expect(md).toContain('B 方案正文')
  })

  it('没有落选稿时不画空段 —— 空标题会让人以为落选稿丢了', () => {
    const n = createNode({ id: 'root', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    expect(serializeNode(n)).not.toContain('备选方案')
  })

  it('超长的落选稿在 body 里被截断,并指向 frontmatter', () => {
    // body 给人读,frontmatter 给机器读。body 无上限的话,一份 5000 字的落选稿会把
    // node.md 顶到人翻不动;直接砍掉又是静默截断 —— 砍完必须说清全文去哪儿找。
    const md = serializeNode(withAlts([{ staff: 'a', solution: 'X'.repeat(5000) }]))
    const body = md.slice(md.indexOf('## 备选方案'))
    expect(body).toContain('完整内容见 frontmatter')
    expect(body.length).toBeLessThan(2000)
    // 而全文确实还在 frontmatter 里 —— 说了去哪儿找,那儿就得真有。
    expect(md.slice(0, md.indexOf('## 备选方案'))).toContain('X'.repeat(2000))
  })
})


/**
 * 「对上一轮意见的逐条处置」也要落到人读得到的那一半。
 *
 * 和落选稿是同一条规矩,但追责价值更高:这两节是「作者/执行者当时**声称**这一条已经解决」
 * 的唯一书面记录。事后要查的正是这句话 —— 哪一条是它说改了而其实没改的。
 */
describe('逐条处置要落到 body', () => {
  const withResponses = (plan?: string[], exec?: string[]) => {
    const n = createNode({ id: 'root', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a', ...(plan ? { responses: plan } : {}) }
    if (exec) n.execResponses = exec
    return n
  }

  it('两节各自成段,而且分得开是哪一关的账', () => {
    const md = serializeNode(withResponses(['第 1 条 → 方案第 3 步'], ['第 1 条 → 改了 src/a.ts']))
    expect(md).toContain('## 方案:对上一轮意见的逐条处置')
    expect(md).toContain('1. 第 1 条 → 方案第 3 步')
    expect(md).toContain('## 执行:对上一轮验收意见的逐条处置')
    expect(md).toContain('1. 第 1 条 → 改了 src/a.ts')
  })

  it('没有回应时不画空段', () => {
    expect(serializeNode(withResponses())).not.toContain('逐条处置')
  })

  it('逐条夹,不是整节夹 —— 一条长的不许把后面的条目连编号一起顶掉', () => {
    const md = serializeNode(withResponses(undefined, ['X'.repeat(5000), '第 2 条 → 不适用']))
    const body = md.slice(md.indexOf('## 执行:对上一轮'))
    expect(body).toContain('完整内容见 frontmatter')
    // 第 2 条必须还在。整节夹的话读者看到的是一份**看起来完整**的一条清单。
    expect(body).toContain('2. 第 2 条 → 不适用')
  })

  it('手工编辑出来的坏值不许让 commit 抛 —— 抛一次这个节点每次 --resume 都死同一处', () => {
    const n = withResponses()
    ;(n as { execResponses?: unknown }).execResponses = [{ a: 1 }, null]
    expect(() => serializeNode(n)).not.toThrow()
    ;(n as { execResponses?: unknown }).execResponses = 'boom'
    expect(() => serializeNode(n)).not.toThrow()
    expect(serializeNode(n)).not.toContain('## 执行:对上一轮')
  })
})

describe('removeNodeDirs 不许删出 run 目录之外', () => {
  const probeFs = (touched: string[]): FsLike => ({
    readFile: async () => '', writeFile: async () => {}, mkdir: async () => {},
    readdir: async () => [], exists: async () => true, mkdirExclusive: async () => true,
    unlink: async (p: string) => { touched.push('unlink ' + p) },
    rmdir: async (p: string) => { touched.push('rmdir ' + p) },
  })

  it('id 里带 .. 时拒绝删除并报出来', async () => {
    // id 是从盘上读来的,而 node.md 按设计就是可手工编辑的(升级卡片就是这么教用户的)
    // —— 所以它不可信,而这个函数是拿来删文件的。影响有界不是放行的理由。
    const touched: string[] = []
    const { failed } = await removeNodeDirs(probeFs(touched), '/run', ['../../victim'])
    expect(touched).toEqual([])
    expect(failed[0]!.message).toContain('越出了 run 目录')
  })

  it('绝对路径同样拒绝', async () => {
    const touched: string[] = []
    const { failed } = await removeNodeDirs(probeFs(touched), '/run', ['/etc/whatever'])
    expect(touched).toEqual([])
    expect(failed).toHaveLength(1)
  })

  it('正常的嵌套 id 照删,而且先深后浅', async () => {
    const touched: string[] = []
    const { failed } = await removeNodeDirs(probeFs(touched), '/run', ['root/00-a', 'root/00-a/01-b'])
    // rmdir 是非递归的:子目录必须先被清空,顺序错了它就失败,留下一地空目录。
    expect(touched[0]).toBe('unlink /run/root/00-a/01-b/node.md')
    expect(touched).toContain('unlink /run/root/00-a/node.md')
    expect(failed).toEqual([])
  })
})

/**
 * 上一版方案的往返。
 *
 * 它**不需要** serializeNode/parseNodeFile 各写一段:`fm = { ...node }` 整节点倾倒 +
 * `yamlParse(...) as TaskNode` 读回,frontmatter 白拿。这条用例钉的就是「白拿」这件事仍然
 * 成立 —— 哪天有人把 fm 改成显式字段清单,这里会红。
 */
describe('上一版方案要能原样躺过一次落盘', () => {
  const mk = () => createNode({
    id: 'root', title: 't', parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW, goal: 'g',
  })

  it('四个字段逐字往返', () => {
    const n = mk()
    n.prevPlan = { solution: '上一版\n多行\t制表', keyPoints: '中文与 emoji 🌱', risks: '  行尾空格  ', acceptance: 'bun test' }
    const back = parseNodeFile(serializeNode(n))
    expect(back.prevPlan).toEqual(n.prevPlan)
  })

  /**
   * `alternatives: undefined` 落盘时**键整个不输出**,不是输出 `alternatives: null`。
   * 这一条是本特性最初最担心的翻车点:若变成 null,下游任何 `.length` 都会炸。
   */
  it('值为 undefined 的键不落盘,也不会读回成 null', () => {
    const n = mk()
    n.prevPlan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a', alternatives: undefined, responses: undefined }
    const text = serializeNode(n)
    expect(text).not.toContain('alternatives: null')
    expect(text).not.toContain('responses: null')
    const back = parseNodeFile(text)
    expect('alternatives' in back.prevPlan!).toBe(false)
    expect(back.prevPlan!.responses).toBeUndefined()
  })

  /**
   * **同引用会让 yaml 输出锚点/别名**(`plan: &a1` / `prevPlan: *a1`),读回来两者是同一个
   * 对象 —— 于是 `delete node.plan.responses` 会把上一版的一起删掉。写入点那句展开
   * (`{ ...node.plan, … }`)就是为了避开它,而后人「简化」时看不出来。
   */
  it('展开是 load-bearing:同引用会写出 yaml 别名', () => {
    const n = mk()
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    // 故意写成同引用,证明这个危险是真的存在,不是假想。
    n.prevPlan = n.plan
    expect(serializeNode(n)).toMatch(/[&*]a\d/)
    // 正确写法:展开一份。
    n.prevPlan = { ...n.plan }
    expect(serializeNode(n)).not.toMatch(/[&*]a\d/)
    const back = parseNodeFile(serializeNode(n))
    expect(back.prevPlan).not.toBe(back.plan)
  })
})


/**
 * `Verdict.advice` 只落 frontmatter 的话,一条真的提出过、真的被送到下游的建议,
 * 在 node.md 上和「这一席什么都没说」长得一模一样 —— 而 node.md 是事后追责唯一读得到的
 * 东西。这个文件自己的规矩写过三遍:「body 才是人读的那一半」。
 * (降级那一节只渲染**降级发生时**收拢的那一份;一轮提了建议、下一轮就通过了的节点
 * 根本没有降级记录,那条建议就此无处可读。)
 */
describe('修改建议要出现在 node.md 的正文里', () => {
  it('评审记录那一行带上「修改建议 N 条」和原文', () => {
    const n = createNode({ id: 'root', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.reviewLog = [{
      round: 1,
      verdicts: [{ role: '总监', pass: false, blocking: ['参数不可执行'], comments: '', advice: ['把 repo 值改成 etcd'] }],
      synthesized: { pass: false, blockingSummary: '参数不可执行' },
    }]
    const md = serializeNode(n)
    const body = md.slice(md.indexOf('## 质疑修复记录'))
    expect(body).toContain('修改建议')
    expect(body).toContain('把 repo 值改成 etcd')
  })
})

/**
 * 半截 node.md —— 用户跑机上的真实事故。
 *
 * 1224 个节点的 run 里 **43 个 node.md 被写成了半截**,每一个都断在 4096 的整数倍上
 * (磁盘满时的短写就是按页断的)。旧行为是:解析失败 → 记一条 error → **把这个节点丢掉**。
 * 于是父任务的 childIds 里写着 5 个孩子、树上只画得出 3 个,而父任务顶着一句
 * 「子节点阻断」—— 那 3 个孩子全是 ACCEPTED,屏幕上没有任何一处解释得了为什么。
 */
describe('半截 node.md:原子写防住,抢救兜住', () => {
  const nodeOf = (id: string, status: TaskNode['status'] = 'PLAN_REVIEW') => {
    const n = createNode({ id, title: id.split('/').pop()!, parentId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null, deps: [], depth: id.split('/').length - 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.status = status
    n.kind = 'executable'
    // 方案正文要足够长,截断点才落得进 frontmatter 之后 —— 真实事故正是断在这里。
    n.plan.solution = 'x'.repeat(20000)
    return n
  }

  it('写盘写到一半失败时,盘上那个文件一个字节都没被动过', async () => {
    const fs = memFs()
    const good = nodeOf('root/01-a', 'ACCEPTED')
    await writeNode(fs, '/eff/001', good)
    const before = fs.store.get('/eff/001/root/01-a/node.md')!
    expect(before.length).toBeGreaterThan(0)

    // 磁盘满:写**临时文件**那一步失败。旧实现是直接往 node.md 上写,同样的失败会把
    // 它截成半截;现在这一步碰不到 node.md。
    const full: FsLike = {
      ...fs,
      async writeFile(p, data) {
        if (p.endsWith('.tmp')) throw new Error('ENOSPC: no space left on device')
        return fs.writeFile(p, data)
      },
    }
    const changed = { ...good, plan: { ...good.plan, solution: 'y'.repeat(30000) } }
    await expect(writeNode(full, '/eff/001', changed)).rejects.toThrow(/ENOSPC/)
    // 关键断言:失败之后盘上还是**完整的旧版本**,不是新版本的前 N 个字节。
    expect(fs.store.get('/eff/001/root/01-a/node.md')).toBe(before)
    expect(parseNodeFile(fs.store.get('/eff/001/root/01-a/node.md')!).id).toBe('root/01-a')
  })

  it('写完临时文件、rename 失败时,也不留下半截 node.md,临时文件被清掉', async () => {
    const fs = memFs()
    await writeNode(fs, '/eff/001', nodeOf('root/01-a', 'ACCEPTED'))
    const before = fs.store.get('/eff/001/root/01-a/node.md')!
    const broken: FsLike = { ...fs, async rename() { throw new Error('EXDEV') } }
    await expect(writeNode(broken, '/eff/001', nodeOf('root/01-a', 'ACCEPTED'))).rejects.toThrow(/EXDEV/)
    expect(fs.store.get('/eff/001/root/01-a/node.md')).toBe(before)
    expect([...fs.store.keys()].filter(k => k.endsWith('.tmp'))).toEqual([])
  })

  it('writeFileAtomic 确实走的是「临时文件 + rename」,不是直接覆盖', async () => {
    const fs = memFs()
    const seen: string[] = []
    const spy: FsLike = {
      ...fs,
      async writeFile(p, d) { seen.push(`write ${p}`); return fs.writeFile(p, d) },
      async rename(a, b) { seen.push(`rename ${a} -> ${b}`); return fs.rename(a, b) },
    }
    await writeFileAtomic(spy, '/eff/001/run.md', 'hello')
    // 顺序必须是「先写别的地方,再 rename 盖上去」。直接 write 目标路径 = 旧实现。
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(/^write \/eff\/001\/\.run\.md\..*\.tmp$/)
    expect(seen[1]).toMatch(/^rename \/eff\/001\/\.run\.md\..*\.tmp -> \/eff\/001\/run\.md$/)
    expect(fs.store.get('/eff/001/run.md')).toBe('hello')
  })

  it('临时文件不叫 node.md,所以 loadRun 不会把它当成一个节点读进来', async () => {
    const fs = memFs()
    await writeNode(fs, '/eff/001', nodeOf('root'))
    // 模拟一次崩在 rename 之前的写:临时文件留在盘上。
    fs.store.set('/eff/001/root/.node.md.999.0.tmp', fs.store.get('/eff/001/root/node.md')!)
    const { nodes } = await loadRun(fs, '/eff/001')
    expect(nodes.map(n => n.id)).toEqual(['root'])
  })

  it('抢救:半截文件不再让节点消失,身份与状态原样回来', async () => {
    const fs = memFs()
    const parent = nodeOf('root', 'WAITING_CHILDREN')
    parent.kind = 'decompose'
    parent.childIds = ['root/01-a', 'root/02-b']
    const a = nodeOf('root/01-a', 'ACCEPTED')
    const b = nodeOf('root/02-b', 'PLAN_REVIEW')
    for (const n of [parent, a, b]) await writeNode(fs, '/eff/001', n)

    // 真实事故的形状:按 4096 的整数倍砍断。
    const full = fs.store.get('/eff/001/root/02-b/node.md')!
    fs.store.set('/eff/001/root/02-b/node.md', full.slice(0, 8192))
    expect(() => parseNodeFile(fs.store.get('/eff/001/root/02-b/node.md')!)).toThrow()

    const { nodes, errors, salvaged } = await loadRun(fs, '/eff/001')
    expect(errors).toEqual([])
    expect(nodes.map(n => n.id).sort()).toEqual(['root', 'root/01-a', 'root/02-b'])
    const back = nodes.find(n => n.id === 'root/02-b')!
    expect(back.status).toBe('PLAN_REVIEW') // 状态是决定它要不要重跑的字段,必须是真的
    expect(back.title).toBe('02-b')
    expect(back.parentId).toBe('root')
    expect(salvaged.map(s => s.id)).toEqual(['root/02-b'])
  })

  it('抢救后父节点看得见全部子节点 —— 不再「childIds 有 2 个、树上只有 1 个」', async () => {
    const fs = memFs()
    const parent = nodeOf('root', 'WAITING_CHILDREN')
    parent.kind = 'decompose'
    parent.childIds = ['root/01-a', 'root/02-b']
    for (const n of [parent, nodeOf('root/01-a', 'ACCEPTED'), nodeOf('root/02-b')]) await writeNode(fs, '/eff/001', n)
    fs.store.set('/eff/001/root/02-b/node.md', fs.store.get('/eff/001/root/02-b/node.md')!.slice(0, 4096))

    const { nodes } = await loadRun(fs, '/eff/001')
    const byId = new Map(nodes.map(n => [n.id, n]))
    const p = byId.get('root')!
    expect(p.childIds.filter(c => byId.has(c))).toEqual(p.childIds)
  })

  it('被砍断的最后半行一律扔掉 —— `status: ACCEP` 解析得出来,但那个值是编的', () => {
    const n = nodeOf('root/01-a', 'CREATED')
    const text = serializeNode(n)
    // 砍在 status 那一行中间。
    const at = text.indexOf('status: CREATED')
    expect(at).toBeGreaterThan(0)
    const cut = text.slice(0, at + 'status: CRE'.length) // 没有换行结尾 = 半行
    const r = salvageNodeFile(cut)
    expect(r).not.toBeNull()
    expect(r!.node.id).toBe('root/01-a')
    // 半行被扔掉,所以 status 要么缺席、要么是合法值 —— 绝不能是 'CRE'。
    expect(r!.node.status).not.toBe('CRE')
  })

  it('连 id 都没留下就老实说抢救不了,不编一个节点出来', () => {
    expect(salvageNodeFile('---\ntitle: 只剩标题')).toBeNull()
    expect(salvageNodeFile('完全不是 node.md')).toBeNull()
  })
})

/**
 * 重做删子树时,事件日志也要一起删。
 *
 * 两个理由,第二个是硬的:`rmdir` 是**非递归**的,目录里剩着 agent-log.jsonl 就删不掉,
 * run 目录里会堆满只剩一份日志的空壳目录;而那些日志再也没有任何界面能打开
 * (`dropNodes` 已经把内存那一份扔了)。
 */
describe('removeNodeDirs 要连事件日志一起清掉', () => {
  it('node.md 和 agent-log.jsonl 都从盘上消失,目录也删得掉', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root/01-a', title: 'A', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', n)
    await fs.appendFile('/eff/001/root/01-a/agent-log.jsonl', '{"t":"open","s":0,"at":1,"meta":{}}\n')
    expect(fs.store.has('/eff/001/root/01-a/agent-log.jsonl')).toBe(true)
    // 状态账也一样要删 —— 少了它 rmdir 删不掉这个目录,而账本身再没人会读。
    await fs.appendFile('/eff/001/root/01-a/state.jsonl', '{"t":"f","at":"x","d":{}}\n')
    expect(fs.store.has('/eff/001/root/01-a/state.jsonl')).toBe(true)

    const { failed } = await removeNodeDirs(fs, '/eff/001', ['root/01-a'])
    expect(failed).toEqual([])
    expect(fs.store.has('/eff/001/root/01-a/node.md')).toBe(false)
    // 少了这一条,目录非空、rmdir 删不掉,而且几 MB 的历史输出永远留在盘上。
    expect(fs.store.has('/eff/001/root/01-a/agent-log.jsonl')).toBe(false)
    expect(fs.store.has('/eff/001/root/01-a/state.jsonl')).toBe(false)
  })
})

/**
 * 原子写留下的 `.tmp` —— **先抢救,确认没用了才删**(用户原话:「首先进行恢复后确认无用可删除」)。
 *
 * 关键在于 `.tmp` 有两种,文件名一模一样:
 *  - 被打断在**写的中途** → 半截,是垃圾;
 *  - 被打断在**写完之后、rename 之前** → 一份**完整且更新**的 node.md,只差最后一步。
 * 后一种直接删掉,就是亲手扔掉刚跑完那一关的结果。
 */
describe('临时文件:先抢救再删', () => {
  const tmpName = (base: string) => `.${base}.4242.0.tmp`

  it('写完但没 rename 的 .tmp 更新 → 抢救回 node.md', async () => {
    const fs = memFs()
    const old = createNode({ id: 'root', title: '旧', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    old.updatedAt = '2026-08-11T00:00:00Z'
    await writeNode(fs, '/eff/001', old)
    const fresh = { ...old, title: '这一关跑完的结果', updatedAt: '2026-08-11T09:00:00Z' }
    fs.store.set(`/eff/001/root/${tmpName('node.md')}`, serializeNode(fresh))

    const out = await sweepTempFiles(fs, '/eff/001')
    expect(out.recovered.map(r => r.path)).toEqual(['/eff/001/root/node.md'])
    expect(out.deleted).toEqual([])
    const { nodes } = await loadRun(fs, '/eff/001')
    expect(nodes[0].title).toBe('这一关跑完的结果')
    expect(fs.store.has(`/eff/001/root/${tmpName('node.md')}`)).toBe(false)
  })

  it('半截的 .tmp → 删掉,而 node.md 一个字节没动', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root', title: '好的', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', n)
    const before = fs.store.get('/eff/001/root/node.md')!
    fs.store.set(`/eff/001/root/${tmpName('node.md')}`, serializeNode(n).slice(0, 4096))

    const out = await sweepTempFiles(fs, '/eff/001')
    expect(out.recovered).toEqual([])
    expect(out.deleted).toHaveLength(1)
    expect(fs.store.get('/eff/001/root/node.md')).toBe(before)
  })

  it('.tmp 比盘上那份**旧** → 删掉,不许拿旧的盖新的', async () => {
    const fs = memFs()
    const cur = createNode({ id: 'root', title: '新的', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    cur.updatedAt = '2026-08-11T09:00:00Z'
    await writeNode(fs, '/eff/001', cur)
    const stale = { ...cur, title: '上一轮的', updatedAt: '2026-08-10T00:00:00Z' }
    fs.store.set(`/eff/001/root/${tmpName('node.md')}`, serializeNode(stale))

    await sweepTempFiles(fs, '/eff/001')
    const { nodes } = await loadRun(fs, '/eff/001')
    expect(nodes[0].title).toBe('新的')
  })

  it('node.md 整个不在时,完整的 .tmp 就是唯一的真相 —— 一定要救', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root', title: '只剩临时文件', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await fs.mkdir('/eff/001/root')
    fs.store.set(`/eff/001/root/${tmpName('node.md')}`, serializeNode(n))
    const out = await sweepTempFiles(fs, '/eff/001')
    expect(out.recovered).toHaveLength(1)
    const { nodes } = await loadRun(fs, '/eff/001')
    expect(nodes.map(x => x.title)).toEqual(['只剩临时文件'])
  })

  it('run.md 的 .tmp 直接删,不抢救 —— 它是整棵树的快照,救回来会写回一棵旧树', async () => {
    const fs = memFs()
    await fs.mkdir('/eff/001')
    fs.store.set(`/eff/001/${tmpName('run.md')}`, '---\ncreatedAt: x\n---\n')
    const out = await sweepTempFiles(fs, '/eff/001')
    expect(out.recovered).toEqual([])
    expect(out.deleted).toHaveLength(1)
  })

  it('不碰任何不是 .tmp 的文件', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root', title: 'T', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', n)
    await fs.appendFile('/eff/001/root/state.jsonl', '{"t":"f","at":"x","d":{}}\n')
    await fs.appendFile('/eff/001/root/agent-log.jsonl', 'x\n')
    const before = [...fs.store.keys()].sort()
    await sweepTempFiles(fs, '/eff/001')
    expect([...fs.store.keys()].sort()).toEqual(before)
  })
})
