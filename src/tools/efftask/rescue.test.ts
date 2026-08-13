/**
 * 捞回那四类孤立产出 —— 对着**真 git** 测。
 *
 * 这条路会往集成分支上产生真实提交,而它最坏的结局是**把一份被验收否决过的废稿合到已经
 * 修好的代码上**。假 GitRunner 会对「合进去了没有」「撞冲突之后现场干不干净」全部点头。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import { orphanDirFindings, planRescue, rescueLines, runRescue, type RescueDeps } from './rescue.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'
import type { StrandedItem } from './stranded.js'

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
  const base = await mkdtemp(join(tmpdir(), 'efftask-rescue-'))
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

const depsOf = (p: ReturnType<typeof pool>, over: Partial<RescueDeps> = {}): RescueDeps => ({
  git,
  gitRoot: p.gitRoot,
  integrationBranch: p.integrationBranchName,
  integrationPath: p.integrationPath,
  worktreeRoot,
  withIntegrationLock: fn => p.withIntegrationRead(fn),
  ...over,
})

/** 造一条「有产出、没合进集成分支」的孤立分支,并返回它的名字。 */
async function strandedBranch(
  p: ReturnType<typeof pool>, id: string, file: string, body: string,
): Promise<{ n: TaskNode; branch: string }> {
  const n = node(id)
  const l = await p.acquire(n) as { path: string }
  // 子目录要先建 —— 夹具里写 `src/api.ts` 那一条原来直接 ENOENT。
  await mkdir(join(l.path, file, '..'), { recursive: true })
  await writeFile(join(l.path, file), body)
  await git(['add', '-A'], l.path)
  await git(['commit', '-qm', `work ${id}`], l.path)
  const branch = p.worktreeBranchOf(n)
  // 把目录清掉,只留分支 —— 跑机上最常见的那一种形状。
  await rm(l.path, { recursive: true, force: true })
  await git(['worktree', 'prune'], gitRoot)
  return { n, branch }
}

const item = (over: Partial<StrandedItem> & Pick<StrandedItem, 'kind' | 'why'>): StrandedItem =>
  ({ ...over } as StrandedItem)

/** 目录下所有文件的相对路径(递归),给孤儿目录比对用。 */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${name.name}` : name.name
    if (name.isDirectory()) out.push(...await listFiles(join(dir, name.name), rel))
    else out.push(rel)
  }
  return out
}

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('分诊:模型只圈范围,默认方向朝安全那一侧', () => {
  it('没有分诊模型时一条都不合,而且要说出来', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/01', 'a.ts', 'work\n')
    const plan = await planRescue(depsOf(p), [item({ kind: 'branchOnly', branch, why: '' })])
    expect(plan.merge).toEqual([])
    expect(plan.hold).toHaveLength(1)
    expect(plan.hold[0]!.verdict).toBe('unsure')
    expect(plan.problems.join('\n')).toContain('没有可用的分诊模型')
  })

  /**
   * **模型没提到的那一条也是「拿不准」,不是「合」。**
   *
   * 一个只回了半张表的模型,剩下那半不该因为沉默而被当成同意 —— 这个仓库为
   * 「沉默被读成同意」付过账。
   */
  it('分诊没覆盖到的条目落「拿不准」,不落「合」', async () => {
    const p = pool(); await p.init()
    const a = await strandedBranch(p, 'root/02-a', 'a.ts', 'A\n')
    const b = await strandedBranch(p, 'root/02-b', 'b.ts', 'B\n')
    const plan = await planRescue(
      depsOf(p, { triage: async () => [{ ref: a.branch, verdict: 'merge', why: '独有产出' }] }),
      [item({ kind: 'branchOnly', branch: a.branch, why: '' }), item({ kind: 'branchOnly', branch: b.branch, why: '' })],
    )
    expect(plan.merge.map(c => c.evidence.ref)).toEqual([a.branch])
    expect(plan.hold.map(c => c.evidence.ref)).toEqual([b.branch])
    expect(plan.hold[0]!.verdict).toBe('unsure')
  })

  it('分诊调用抛异常 → 整批按「拿不准」,一条都不合', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/03', 'a.ts', 'work\n')
    const plan = await planRescue(
      depsOf(p, { triage: async () => { throw new Error('限流') } }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    expect(plan.merge).toEqual([])
    expect(plan.problems.join('\n')).toContain('限流')
  })

  /** 分诊拿到的是**证据**,不是让它自己去查 —— 证据算不出来就不许分诊。 */
  it('证据里带着 diff 的文件名和提交数', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/04', 'src/api.ts', 'x\n')
    let seen: { ref: string; commits: number; files: string[] }[] = []
    await planRescue(
      depsOf(p, { triage: async ev => { seen = ev.map(e => ({ ref: e.ref, commits: e.commits, files: e.files })); return [] } }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    expect(seen[0]!.commits).toBe(1)
    expect(seen[0]!.files).toContain('src/api.ts')
  })

  it('相对集成分支一个提交都没多的不进分诊', async () => {
    const p = pool(); await p.init()
    const n = node('root/05')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'a.ts'), 'x\n')
    await p.commitAndMerge(n)   // 已经合进去了
    let asked = 0
    const plan = await planRescue(
      depsOf(p, { triage: async ev => { asked = ev.length; return [] } }),
      [item({ kind: 'branchOnly', branch: p.worktreeBranchOf(n), why: '' })],
    )
    expect(asked).toBe(0)
    expect(plan.merge).toEqual([])
    expect(plan.hold).toEqual([])
  })
})

describe('真的捞', () => {
  it('分诊判「合」的合进集成分支,而分支照样留着', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/06', 'rescued.ts', 'the lost work\n')
    const plan = await planRescue(
      depsOf(p, { triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'merge' as const, why: '独有产出' })) }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    const out = await runRescue(depsOf(p), plan)
    expect(out.failed).toEqual([])
    expect(out.merged.map(m => m.ref)).toEqual([branch])
    // 内容真的到了集成分支上。
    const show = await git(['show', `${p.integrationBranchName}:rescued.ts`], gitRoot)
    expect(show.stdout).toBe('the lost work\n')
    // **捞是加东西,不是清理** —— 分支一个都不删。
    expect((await git(['rev-parse', '--verify', branch], gitRoot)).code).toBe(0)
  })

  it('判「不合」的一个字节都不动', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/07', 'junk.ts', 'rejected draft\n')
    const plan = await planRescue(
      depsOf(p, { triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'skip' as const, why: '已被后来的版本取代' })) }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    expect(plan.merge).toEqual([])
    const out = await runRescue(depsOf(p), plan)
    expect(out.merged).toEqual([])
    expect((await git(['show', `${p.integrationBranchName}:junk.ts`], gitRoot)).code).not.toBe(0)
  })

  /**
   * **撞冲突要收拾干净,而判据是现场、不是退出码。**
   *
   * 没有合并可中止时 `git merge --abort` 回 128 而树是干净的 —— 按退出码判会报一句假的
   * 「还原失败」;反过来钩子拒绝那一类是「非零退出 + 零个 unmerged path」,只看冲突文件
   * 会把 MERGE_HEAD 留在共享的集成工作区里,之后每一次合并都被它挡住。
   */
  it('撞冲突:如实报告,而集成工作区收拾干净(没有留下 MERGE_HEAD)', async () => {
    const p = pool(); await p.init()
    /**
     * 基线要在**第一次合并之前**取。
     *
     * `commitAndMerge` 成功之后会顺手 `intoTrunk` 把集成分支合回 `main` —— 于是
     * `main` 也含有对侧的内容了,从它拉分支拿到的 merge-base 就是集成分支的 tip,
     * 那是一次快进而**根本不冲突**。第一版夹具就是这么写的,它对着一个好的实现「通过」。
     */
    const base = (await git(['rev-parse', 'HEAD'], gitRoot)).stdout.trim()
    // 集成分支和孤立分支各改同一个文件的同一行。
    const n = node('root/08-int')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'clash.ts'), 'INTEGRATION SIDE\n')
    await p.commitAndMerge(n)

    const other = node('root/08-other')
    const l2 = await p.acquire(other) as { path: string }
    await git(['checkout', '-B', p.worktreeBranchOf(other), base], l2.path)
    await writeFile(join(l2.path, 'clash.ts'), 'ORPHAN SIDE\n')
    await git(['add', '-A'], l2.path)
    await git(['commit', '-qm', 'orphan work'], l2.path)
    const branch = p.worktreeBranchOf(other)
    await rm(l2.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)

    const plan = await planRescue(
      depsOf(p, { triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'merge' as const, why: '试试' })) }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    const out = await runRescue(depsOf(p), plan)
    expect(out.merged).toEqual([])
    expect(out.failed[0]!.why).toContain('冲突')
    // 现场干净:MERGE_HEAD 不在了,集成分支也没被推进。
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], p.integrationPath)).code).not.toBe(0)
    expect((await git(['show', `${p.integrationBranchName}:clash.ts`], gitRoot)).stdout).toBe('INTEGRATION SIDE\n')
  })
})

/**
 * **孤儿目录不是 git 工作树** —— `git merge` 无从谈起,只能逐文件比
 * `git hash-object` 与 `git rev-parse <集成分支>:<路径>`(第十七轮在跑机上用的就是这一招)。
 */
describe('孤儿目录', () => {
  it('分出「集成分支上没有」和「内容不同」两种,一样的不报', async () => {
    const p = pool(); await p.init()
    const orphan = join(worktreeRoot, 'integration.orphan')
    await mkdir(join(orphan, 'src'), { recursive: true })
    await writeFile(join(orphan, 'base.txt'), 'base\n')            // 和集成分支一样
    await writeFile(join(orphan, 'src', 'lost.ts'), 'only here\n') // 集成分支上没有
    await writeFile(join(orphan, 'changed.txt'), 'different\n')     // 名字集成分支上也没有

    const f = await orphanDirFindings(depsOf(p), orphan, listFiles)
    const rels = f.files.map(x => x.rel).sort()
    expect(rels).toEqual(['changed.txt', 'src/lost.ts'])
    expect(f.files.find(x => x.rel === 'src/lost.ts')!.kind).toBe('absent')
    // 一样的那个一个字都不报 —— 否则清单里全是噪声。
    expect(rels).not.toContain('base.txt')
  })

  it('内容不同的那种认得出来', async () => {
    const p = pool(); await p.init()
    const orphan = join(worktreeRoot, 'integration.orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'base.txt'), 'CHANGED\n')
    const f = await orphanDirFindings(depsOf(p), orphan, listFiles)
    expect(f.files).toEqual([{ rel: 'base.txt', kind: 'differs' }])
  })

  it('没有目录遍历接缝时如实说这一格没查', async () => {
    const p = pool(); await p.init()
    const plan = await planRescue(depsOf(p), [item({ kind: 'orphanDir', path: '/nope', why: '' })])
    expect(plan.problems.join('\n')).toContain('没有目录遍历接缝')
  })

  it('屏幕上必须说清它合不进来', async () => {
    const p = pool(); await p.init()
    const orphan = join(worktreeRoot, 'integration.orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'lost.ts'), 'only here\n')
    const plan = await planRescue(depsOf(p), [item({ kind: 'orphanDir', path: orphan, why: '' })], listFiles)
    const text = rescueLines(plan).join('\n')
    expect(text).toContain('已经不是 git 工作树')
    expect(text).toContain('目录不会被删')
  })
})

describe('屏幕上说了什么', () => {
  it('「拿不准」要单独数出来,并给出能照做的命令', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/09', 'a.ts', 'x\n')
    const plan = await planRescue(depsOf(p), [item({ kind: 'branchOnly', branch, why: '' })])
    const text = rescueLines(plan).join('\n')
    expect(text).toContain('拿不准')
    expect(text).toContain('git diff')
  })

  it('要合的那一段必须说「分支照样保留」', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/10', 'a.ts', 'x\n')
    const plan = await planRescue(
      depsOf(p, { triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'merge' as const, why: 'ok' })) }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    expect(rescueLines(plan).join('\n')).toContain('照样保留')
  })

  it('什么都没有时说清楚,不印空标题', async () => {
    const p = pool(); await p.init()
    const plan = await planRescue(depsOf(p), [])
    expect(rescueLines(plan)[0]).toContain('没有需要捞回来的东西')
  })
})
