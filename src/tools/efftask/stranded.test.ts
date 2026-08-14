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
import { scanStranded, STRANDED_KINDS, STRANDED_KIND_LIST, type StrandedDeps } from './stranded.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'
import { pinSnapshot } from './snapshot.js'

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
  it('merge-base 探测失败的条目要带 unknown', async () => {
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

/**
 * **这一节曾经断言 `strandedLines` 的输出,而那个渲染器已经删掉了。**
 *
 * 它从落地那天起就只被这里引用 —— 上屏那一份住在 `mergeSubtree.subtreeMergeLines`,
 * 按「这个键认领哪几格」组织而不是按分类法组织。两份渲染器里活着的那份总会先退化,
 * 而这个仓库为「声明了、实现了、测过了,而生产上没有任何人用它」付过账。
 *
 * 它守的两件事换了地方,一样有人守:
 *  - 「按去处分组」→ `counts` 仍然按 action 累加(下面那条);
 *  - 「一条都没有时说清楚」→ `mergeSubtree.test.ts` 的「查过了、确实没有」那一条。
 */
describe('去处分组', () => {
  it('counts 按 action 累加,三类各自数得出来', async () => {
    const p = pool(); await p.init()
    const n = node('root/14', {
      status: 'ACCEPTED',
      execStatus: '(注:该节点没有向集成分支贡献任何改动)',
    })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'loose.ts'), 'x\n')
    const r = await scanStranded(depsOf(p), [n])
    expect(r.counts.merge).toBeGreaterThan(0)
    expect(r.counts.backtrack).toBeGreaterThan(0)
    // 三个去处的和 = 全部条目,一条都不许掉在分类之外。
    expect(r.counts.merge + r.counts.backtrack + r.counts.report).toBe(r.items.length)
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

/**
 * **认不回主的那些,至少要认得回它是谁的。**
 *
 * 规范席点名:上一版把「认不回来」写成了定局(「slug 是 sha256,单向」),而那是个
 * **代码里就是假的**前提 —— 打抢救提交的两处把节点 id 明文写进了提交信息。
 * 回溯仍然认领不了它(没有节点对象可落痕),但屏幕上从一串 slug 变成了任务 id,
 * 而那是用户唯一能据以动手的东西。
 */
describe('抢救分支的来历', () => {
  it('任务已经不在树上时,从提交信息里认回它是谁的', async () => {
    const p = pool(); await p.init()
    const gone = node('root/07-gone', { status: 'ACCEPTED' })
    const l = await p.acquire(gone) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    await p.discard(gone)

    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    const item = r.items.find(i => i.kind === 'salvageOrphan')!
    expect(item.why).toContain('root/07-gone')
    // 认得回是谁的 ≠ 有节点可落痕 —— 这一格仍然是 orphan,不许假装有主。
    expect(item.nodeId).toBeUndefined()
  })

  /**
   * **被回溯过 ≠ 已经被取代。**
   *
   * 这条判据上一版还认 `backtrack`,于是有一个自噬回路:捞不回来 → 落痕 → 按 b →
   * 节点被打上 backtrack → 下一次按 m,它全部抢救 ref 变成「废稿」→ 分诊大概率 skip →
   * 出局。而那次重执行如果又没产出(那正是它进回溯的原因),这条 ref 就是唯一的副本。
   */
  it('只被回溯过的节点,它的抢救分支不算废稿', async () => {
    const p = pool(); await p.init()
    const n = node('root/08', { status: 'ACCEPTED', backtrack: { rounds: 1, at: '2026-08-13T00:00:00Z' } })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    await p.discard(n)

    const r = await scanStranded(depsOf(p), [n])
    expect(r.items.find(i => i.kind === 'salvage')!.fate).toBe('still-open')
  })

  /** 真的有另一版进了集成分支,那才是废稿 —— 这一条不能被上面那条一起关掉。 */
  it('真的贡献过别的版本时,抢救分支算废稿', async () => {
    const p = pool(); await p.init()
    const n = node('root/09', { status: 'ACCEPTED', contributed: true })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    await p.discard(n)

    const r = await scanStranded(depsOf(p), [n])
    expect(r.items.find(i => i.kind === 'salvage')!.fate).toBe('superseded')
  })
})

/**
 * **落在零个 ref 上的提交** —— 这个仓库自己量过两次的丢失通道,而清单里此前一格都没有。
 *
 * `worktreePool` 的注释记着:`branch -f` 打第二次抢救时上一版落在零个 ref 上
 * (实测 `for-each-ref --contains | wc -l` → 0),以及 init 重置集成分支那次每个已合并
 * 节点的提交都进了 `git fsck --unreachable`。两处都写着「gc 之后就真没了」。
 */
describe('悬空提交', () => {
  it('efftask 打的、又落在零个 ref 上的提交要被列出来', async () => {
    const p = pool(); await p.init()
    const n = node('root/dg', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    const d = await p.discard(n)
    // 老 run 的形状:抢救 ref 被覆盖掉,那一版落在零个 ref 上。
    const sha = (await git(['rev-parse', d.salvaged!], gitRoot)).stdout.trim()
    await git(['update-ref', '-d', `refs/heads/${d.salvaged}`], gitRoot)
    expect((await git(['for-each-ref', '--contains', sha], gitRoot)).stdout.trim()).toBe('')

    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    const item = r.items.find(i => i.kind === 'dangling')
    expect(item?.branch).toBe(sha)
    expect(item?.why).toContain('gc 之后就真没了')
  })

  /**
   * **用户自己的历史不算这一趟卡住的活。** 不加这条判据的话,他 rebase / amend 掉的
   * 每一个旧提交都会涌进来,把真正那几条淹掉 —— 而一份没人看的清单等于没有清单。
   */
  it('不是 efftask 打的悬空提交不进清单', async () => {
    const p = pool(); await p.init()
    await writeFile(join(gitRoot, 'mine.txt'), 'x\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'my own work'], gitRoot)
    const sha = (await git(['rev-parse', 'HEAD'], gitRoot)).stdout.trim()
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)

    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    expect(r.items.some(i => i.kind === 'dangling' && i.branch === sha)).toBe(false)
  })

  /**
   * **「不在任何分支上」的判据是「任何 ref 都够不着」,不是「我随手挑的两个 ref 够不着」。**
   *
   * 上一版给了 `fsck` 显式 head(`HEAD` + 集成分支),于是别的 ref 不再算根 ——
   * 数据安全席实测:一条**活着的抢救分支的 tip** 被列成悬空。同一份产出在屏幕上出现两次,
   * 而其中一次说的是「gc 之后就真没了」,那是假的。
   */
  it('活着的抢救分支不许被当成悬空提交', async () => {
    const p = pool(); await p.init()
    const n = node('root/alive', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'v1.ts'), 'first\n')
    const d = await p.discard(n)
    const sha = (await git(['rev-parse', d.salvaged!], gitRoot)).stdout.trim()
    // 这一次**不删** ref —— 它活着,而且 salvage 那一格已经在列它了。
    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    expect(r.items.some(i => i.kind === 'dangling' && i.branch === sha)).toBe(false)
  })
})

/**
 * **用户自己的东西,和我们替他钉的快照。**
 *
 * 这两格此前不在这份「不许漏项」的穷举表里,而 `stashBackup` 装的是四类里唯一
 * **不属于这一趟产出**的东西:他自己没提交的改动。
 */
describe('refs/et 下那两格', () => {
  it('我们钉的快照要被列出来,而且不许被当成悬空提交', async () => {
    const p = pool(); await p.init()
    // **改一个已跟踪的文件** —— `stash create` 拿不到未跟踪的那些(实测 -u 对它静默无效)。
    await writeFile(join(p.integrationPath, 'base.txt'), 'base\n席位在这里跑过构建\n')
    const snap = await pinSnapshot({ git, gitRoot, runId: '001' }, p.integrationPath)
    expect(snap.ref).toBeDefined()

    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    const it0 = r.items.find(i => i.kind === 'rescued')
    expect(it0?.branch).toBe(snap.ref!)
    expect(it0?.why).toContain('git stash apply')
    // 它是一条 ref 的 tip,而 fsck 拿所有 ref 当根 —— 不该同时出现在悬空那一格里。
    expect(r.items.some(i => i.kind === 'dangling')).toBe(false)
  })

  /**
   * **按 runId 切这张表,「穷举」这个词就是假的。**
   *
   * 每一处 ref 扫描都拼了 runId,`sweepStashBackups` 也只管本 run —— 于是**上一趟**崩掉的
   * run 留下的东西对每一个扫描器永久隐形,而「上一趟留下的」正是用户已经忘掉的那一份。
   */
  it('别的 run 留下的 stash 备份照样列,并且点明不是这一趟的', async () => {
    const p = pool(); await p.init()
    await writeFile(join(gitRoot, 'base.txt'), 'base\n他自己改了一天的东西\n')
    const sha = (await git(['stash', 'create', 'his work'], gitRoot)).stdout.trim()
    await git(['update-ref', 'refs/et/stash-backup/999/abcdef', sha], gitRoot)

    const r = await scanStranded(depsOf(p), [node('root', { status: 'ACCEPTED' })])
    const it0 = r.items.find(i => i.kind === 'stashBackup')
    expect(it0?.branch).toBe('refs/et/stash-backup/999/abcdef')
    expect(it0?.why).toContain('另一趟')
  })
})
