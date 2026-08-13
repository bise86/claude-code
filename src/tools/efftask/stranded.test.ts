/**
 * 「活卡在哪儿」清单 —— 对着**真 git** 测。
 *
 * 这份清单的全部价值是**一件都不漏**,而漏项恰恰是假 GitRunner 最会点头的东西:
 * 它会对「目录没了、分支还在」「抢救 ref 认不回主」「集成工作区半合并」全部给出你写死的
 * 那个答案。所以每一格都在真仓库上造出真实形状。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import { scanStranded, strandedLines, STRANDED_KINDS, STRANDED_KIND_LIST, type StrandedDeps } from './stranded.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const git: GitRunner = (args, cwd) =>
  new Promise(resolve => {
    const p = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += String(d) })
    p.stderr.on('data', d => { stderr += String(d) })
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    p.on('error', e => resolve({ code: -1, stdout: '', stderr: String(e) }))
  })

const roots: string[] = []
let gitRoot = ''
let worktreeRoot = ''

const node = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: new Date().toISOString(),
  }),
  ...over,
})

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-str-'))
  roots.push(base)
  gitRoot = join(base, 'repo')
  worktreeRoot = join(base, 'wt')
  await mkdir(gitRoot, { recursive: true })
  await mkdir(worktreeRoot, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], gitRoot)
  await git(['config', 'user.email', 's@s'], gitRoot)
  await git(['config', 'user.name', 's'], gitRoot)
  await writeFile(join(gitRoot, 'base.txt'), 'base\n')
  await git(['add', '-A'], gitRoot)
  await git(['commit', '-qm', 'base'], gitRoot)
}

const pool = () => createWorktreePool({ runId: '001', gitRoot, git, worktreeRoot })

const depsOf = (p: ReturnType<typeof pool>, over: Partial<StrandedDeps> = {}): StrandedDeps => ({
  git,
  runId: '001',
  gitRoot: p.gitRoot,
  integrationBranch: p.integrationBranchName,
  integrationPath: p.integrationPath,
  pathFor: n => p.worktreePathOf(n),
  branchFor: n => p.worktreeBranchOf(n),
  exists: path => access(path).then(() => true, () => false),
  ...over,
})

const kinds = (r: { items: { kind: string }[] }): string[] => r.items.map(i => i.kind).sort()

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

/**
 * **分类表是这份穷举的唯一真相,而它必须真的被覆盖。**
 *
 * 这一条钉的不是某个行为,是这个模块存在的前提:漏一格就是「全部捞出来」这句话变成假的。
 * 分类表新增一格而扫描没跟上时,它变红。
 */
describe('分类表的完整性', () => {
  it('每一格都有 label / action / how,而且 action 只有三种去处', () => {
    expect(STRANDED_KIND_LIST.length).toBeGreaterThan(0)
    for (const k of STRANDED_KIND_LIST) {
      const e = STRANDED_KINDS[k]
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.how.length).toBeGreaterThan(0)
      expect(['merge', 'backtrack', 'report']).toContain(e.action)
    }
  })

  /**
   * **扫描里必须逐格都出现过。** 判据是「这个分类字面量在源码里被 push 过」——
   * 弱,但它守的是「新增一格而忘了扫」这条唯一真实的退化路径,而下面每一格另有行为探针。
   */
  it('扫描覆盖分类表里的每一格', async () => {
    const src = await Bun.file(new URL('./stranded.ts', import.meta.url)).text()
    for (const k of STRANDED_KIND_LIST) {
      expect(src.includes(`kind: '${k}'`)).toBe(true)
    }
  })
})

describe('东西还在、只是没送到', () => {
  it('工作区里未提交的内容', async () => {
    const p = pool(); await p.init()
    const n = node('root/01', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'loose.ts'), 'not committed\n')
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('loose')
    expect(r.items.find(i => i.kind === 'loose')?.loose).toBe(1)
    expect(r.counts.merge).toBeGreaterThan(0)
  })

  it('已提交、没合进集成分支', async () => {
    const p = pool(); await p.init()
    const n = node('root/02', { status: 'BLOCKED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'w\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'unmerged'], l.path)
    const r = await scanStranded(depsOf(p), [n])
    const it = r.items.find(i => i.kind === 'unmerged')!
    expect(it.commits).toBe(1)
    expect(it.branch).toBe(p.worktreeBranchOf(n))
  })

  /**
   * **目录没了、分支还在** —— 跑机实测最常见的那一种(etcd3 上 32 条工作树登记项里 31 条)。
   * `m` 键走 `childIds → pathFor(node)`,对这种形状**完全看不见**,而分支上带着整个节点的产出。
   */
  it('工作区目录已经不在,而分支上还有没合入的提交', async () => {
    const p = pool(); await p.init()
    const n = node('root/03', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'w\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'work'], l.path)
    // 只把目录清掉,分支留着 —— 用户手工 rm -rf 或上一趟清理留下的形状。
    await rm(l.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)

    const r = await scanStranded(depsOf(p), [n])
    const it = r.items.find(i => i.kind === 'branchOnly')!
    expect(it.branch).toBe(p.worktreeBranchOf(n))
    expect(it.commits).toBe(1)
    expect(it.title).toBe(n.title)
  })

  it('抢救分支认得回是谁的', async () => {
    const p = pool(); await p.init()
    const n = node('root/04', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    const d = await p.discard(n)
    expect(d.salvaged).toBeDefined()

    const r = await scanStranded(depsOf(p), [n])
    const it = r.items.find(i => i.kind === 'salvage')!
    expect(it.branch).toBe(d.salvaged)
    expect(it.nodeId).toBe(n.id)
  })

  /**
   * **认不回主的抢救分支不是「跳过」。** slug 是 `sha256(nodeId)[:8]`,单向的 ——
   * 节点被重做/回溯从树上删掉之后,它的抢救 ref 谁也认不回来。写成跳过就是把
   * 「全部捞出来」承诺的那一类静默丢掉。
   */
  it('抢救分支对应的任务已经不在树上 —— 照样列出来', async () => {
    const p = pool(); await p.init()
    const gone = node('root/05-gone', { status: 'ACCEPTED' })
    const l = await p.acquire(gone) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    await p.discard(gone)

    // 树里**没有**这个节点了 —— 重做删掉子树之后的形状。
    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    const it = r.items.find(i => i.kind === 'salvageOrphan')!
    expect(it.nodeId).toBeUndefined()
    expect(it.why).toContain('已经不在树上')
  })

  it('集成分支上的提交还没送到你的分支', async () => {
    const p = pool(); await p.init()
    const n = node('root/06', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'w\n')
    await p.commitAndMerge(n)
    // commitAndMerge 会顺手往主干送一次,所以先把主干退回去造出「没送到」的形状。
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    const r = await scanStranded(depsOf(p), [n])
    const it = r.items.find(i => i.kind === 'trunk')!
    expect(it.commits).toBeGreaterThan(0)
  })
})

describe('合并解决不了的那两格', () => {
  /**
   * **产出丢了。** 判据是 `mergeAndRelease` 自己写的那句注记 —— 它在 `merged === false`
   * 时追加,也就是「通过了验收,而集成分支一个字节都没多」。这是「生成不知道什么原因丢失」
   * 在盘上唯一的硬证据。
   */
  it('判了通过而集成分支一个字节都没多 → 要返工,不是要合并', async () => {
    const p = pool(); await p.init()
    const n = node('root/07', {
      status: 'ACCEPTED',
      execStatus: '实现了 api.ts\n(注:该节点没有向集成分支贡献任何改动)',
    })
    const r = await scanStranded(depsOf(p), [n])
    const it = r.items.find(i => i.kind === 'missing')!
    expect(it.nodeId).toBe(n.id)
    expect(STRANDED_KINDS.missing.action).toBe('backtrack')
    expect(r.counts.backtrack).toBeGreaterThan(0)
  })

  it('集成验收没通过 → 要返工', async () => {
    const p = pool(); await p.init()
    const n = node('root/08', {
      status: 'BLOCKED',
      acceptLog: [{
        round: 1, step: 'integrate', verdicts: [],
        synthesized: { pass: false, blockingSummary: '子任务合起来没覆盖导出接口' },
      }],
    })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('integrateFail')
  })

  /** 叶子验收那条记录**不算** —— 它和集成验收共用 acceptLog,只有 `step` 分得开。 */
  it('叶子验收失败的记录不会被当成集成验收失败', async () => {
    const p = pool(); await p.init()
    const n = node('root/09', {
      status: 'BLOCKED',
      acceptLog: [{
        round: 1, step: 'accept', verdicts: [],
        synthesized: { pass: false, blockingSummary: '测试没跑' },
      }],
    })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).not.toContain('integrateFail')
  })
})

describe('要你自己定的那几格', () => {
  it('被 x 取消的任务照样列出来 —— 清单要完整', async () => {
    const p = pool(); await p.init()
    const n = node('root/10', { status: 'CREATED', cancelled: true })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('cancelled')
    expect(STRANDED_KINDS.cancelled.action).toBe('report')
  })

  it('降级放行的任务:跑完了,但没有人判它通过', async () => {
    const p = pool(); await p.init()
    const n = node('root/11', { status: 'ACCEPTED', degraded: ['accept'] })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('degraded')
  })

  it('集成工作区里留着没解完的合并', async () => {
    const p = pool(); await p.init()
    await writeFile(join(p.integrationPath, 'scratch.txt'), 'seat left this\n')
    const r = await scanStranded(depsOf(p), [])
    const it = r.items.find(i => i.kind === 'integrationDirty')!
    expect(it.path).toBe(p.integrationPath)
  })

  /**
   * **孤儿目录判据必须是「盘上存不存在」。**
   *
   * 孤儿的定义就是「git 不认识它」,拿 `git rev-parse --git-dir` 去问,答案恒为「不在」——
   * 那一格会变成永远为空的死代码。
   */
  it('自愈挪走的孤儿目录要列出来', async () => {
    const p = pool(); await p.init()
    await mkdir(`${p.integrationPath}.orphan`, { recursive: true })
    await writeFile(`${p.integrationPath}.orphan/big.bin`, 'x')
    const r = await scanStranded(depsOf(p), [])
    expect(kinds(r)).toContain('orphanDir')
  })

  it('没有目录探测接缝时如实说这一格没查 —— 空白不等于没有', async () => {
    const p = pool(); await p.init()
    const { exists: _drop, ...rest } = depsOf(p)
    const r = await scanStranded(rest as StrandedDeps, [])
    expect(r.problems.join('\n')).toContain('没有检查孤儿工作树目录')
  })
})

describe('探不明白 ≠ 没问题', () => {
  it('merge-base 探测失败的条目要带 unknown,并在屏幕上单独说一句', async () => {
    const p = pool(); await p.init()
    const n = node('root/12', { status: 'ACCEPTED' })
    await p.acquire(n)
    const deps = depsOf(p, {
      git: async (args, cwd) => (
        args[0] === 'merge-base' ? { code: 128, stdout: '', stderr: 'fatal: 坏了' } : git(args, cwd)
      ),
    })
    const r = await scanStranded(deps, [n])
    expect(r.items.some(i => i.unknown === true)).toBe(true)
    expect(strandedLines(r).join('\n')).toContain('未知')
  })

  it('列不出抢救分支时要说这一格是空白,不是没有', async () => {
    const p = pool(); await p.init()
    const deps = depsOf(p, {
      git: async (args, cwd) => (
        args[0] === 'for-each-ref' ? { code: 1, stdout: '', stderr: 'boom' } : git(args, cwd)
      ),
    })
    const r = await scanStranded(deps, [])
    expect(r.problems.join('\n')).toContain('不代表没有')
  })
})

describe('在飞的节点不算卡住', () => {
  it('正在跑的节点整个跳过 —— 它跑完自己会合一次', async () => {
    const p = pool(); await p.init()
    const n = node('root/13', { status: 'EXECUTING' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'half.ts'), 'writing\n')
    const r = await scanStranded(depsOf(p, { inFlight: [n.id] }), [n])
    expect(r.items.filter(i => i.nodeId === n.id)).toEqual([])
  })
})

describe('屏幕上说了什么', () => {
  it('一条都没有时说「都送到了」,不印空标题', async () => {
    const p = pool(); await p.init()
    const lines = strandedLines(await scanStranded(depsOf(p), []))
    expect(lines[0]).toContain('没有卡住的活')
    expect(lines.join('\n')).not.toContain('可以合进来的')
  })

  it('按去处分组,而不是按分类', async () => {
    const p = pool(); await p.init()
    const n = node('root/14', {
      status: 'ACCEPTED',
      execStatus: '(注:该节点没有向集成分支贡献任何改动)',
      cancelled: false,
    })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'loose.ts'), 'x\n')
    const r = await scanStranded(depsOf(p), [n])
    const text = strandedLines(r).join('\n')
    expect(text).toContain('可以合进来的')
    expect(text).toContain('要返工的')
  })
})

/**
 * **判据必须和回溯那一侧共用一份。**
 *
 * 验收实测抓到的:本轮把「贡献为零」的节点从 ACCEPTED 改成 **BLOCKED** 之后,这边那份
 * 硬编码副本(只认 `ACCEPTED` + 字面量)**一件都扫不到**,而同一个节点在 `outputMissing()`
 * 里判 true。同一个概念两份实现,只更新了其中一份 —— 而这一份正是「全部捞出来」的入口。
 */
describe('产出丢了:两种形态都要认', () => {
  it('新形态(BLOCKED,原因写在 blockedReason 里)扫得到', async () => {
    const p = pool(); await p.init()
    const n = node('root/miss-blocked', {
      status: 'BLOCKED',
      blockedReason: '该节点没有向集成分支贡献任何改动 —— 产出不在集成分支上。按 b 回溯',
    })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('missing')
  })

  it('老形态(ACCEPTED,注记写在 execStatus 里)照样扫得到', async () => {
    const p = pool(); await p.init()
    const n = node('root/miss-accepted', {
      status: 'ACCEPTED', execStatus: '(注:该节点没有向集成分支贡献任何改动)',
    })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).toContain('missing')
  })

  it('还在跑的不算 —— 它本来就还没轮到贡献', async () => {
    const p = pool(); await p.init()
    const n = node('root/miss-running', {
      status: 'EXECUTING', execStatus: '没有向集成分支贡献任何改动',
    })
    const r = await scanStranded(depsOf(p), [n])
    expect(kinds(r)).not.toContain('missing')
  })
})
