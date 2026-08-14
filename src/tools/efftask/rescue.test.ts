/**
 * 捞回那四类孤立产出 —— 对着**真 git** 测。
 *
 * 这条路会往集成分支上产生真实提交,而它最坏的结局是**把一份被验收否决过的废稿合到已经
 * 修好的代码上**。假 GitRunner 会对「合进去了没有」「撞冲突之后现场干不干净」全部点头。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import { orphanDirFindings, planRescue, remainingOnRef, rescueLines, runRescue, type RescueDeps } from './rescue.js'
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
  it('没有分诊模型时一条都不整条合并,而且要说出来', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/01', 'a.ts', 'work\n')
    const plan = await planRescue(depsOf(p), [item({ kind: 'branchOnly', branch, why: '' })])
    expect(plan.merge).toEqual([])
    /**
     * **「不整条合并」和「什么都不做」是两件事。**
     *
     * 拿不准的落 `backfill`(第 2 级:只补录集成分支根本没有的路径),不落 `merge`。
     * 这一条钉的正是那个分界:把它挪回 `merge` 就是「沉默被读成同意」,
     * 把第 2 级删掉就是「一次判决冒充最大努力」。
     */
    expect(plan.backfill).toHaveLength(1)
    expect(plan.backfill[0]!.verdict).toBe('unsure')
    expect(plan.hold).toEqual([])
    expect(plan.problems.join('\n')).toContain('没有可用的分诊模型')
  })

  /**
   * **被取代的那一版连补录都不做。**
   *
   * 它「集成分支上没有」的文件,很可能正是后继版本**故意删掉**的那个 —— 补录回去
   * 是另一种污染。这一条和上面那条是一对:同样是 `unsure`,`fate` 决定去哪个桶。
   */
  it('拿不准、但已经被取代的 → 不补录,进 hold', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/01s', 'a.ts', 'work\n')
    const plan = await planRescue(
      depsOf(p), [{ ...item({ kind: 'salvage', branch, why: '' }), fate: 'superseded' }],
    )
    expect(plan.backfill).toEqual([])
    expect(plan.hold).toHaveLength(1)
    expect(plan.hold[0]!.evidence.fate).toBe('superseded')
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
    expect(plan.backfill.map(c => c.evidence.ref)).toEqual([b.branch])
    expect(plan.backfill[0]!.verdict).toBe('unsure')
  })

  /**
   * **模型漏说的那几条要单独再问一轮 —— 一次沉默不是永久放弃。**
   *
   * 反向断言在这里是判据的一半:第二轮**只带漏掉的那些**。带全量就是把同一份长清单
   * 再问一遍,而漏说最常见的成因正是清单太长。
   */
  it('分诊漏说的条目会被单独追问一轮', async () => {
    const p = pool(); await p.init()
    const a = await strandedBranch(p, 'root/02r-a', 'a.ts', 'A\n')
    const b = await strandedBranch(p, 'root/02r-b', 'b.ts', 'B\n')
    const rounds: string[][] = []
    const plan = await planRescue(
      depsOf(p, {
        triage: async ev => {
          rounds.push(ev.map(e => e.ref))
          return rounds.length === 1
            ? [{ ref: a.branch, verdict: 'merge' as const, why: '独有产出' }]
            : [{ ref: b.branch, verdict: 'skip' as const, why: '第二轮才说清' }]
        },
      }),
      [item({ kind: 'branchOnly', branch: a.branch, why: '' }), item({ kind: 'branchOnly', branch: b.branch, why: '' })],
    )
    expect(rounds).toHaveLength(2)
    expect(rounds[1]).toEqual([b.branch])
    expect(plan.hold.map(c => c.evidence.ref)).toEqual([b.branch])
    expect(plan.hold[0]!.verdict).toBe('skip')
  })

  /** 已经按过 Esc 了就别再发第二轮 —— `planRescue` 此前从头到尾没读过 signal。 */
  it('中断之后不再追问第二轮', async () => {
    const p = pool(); await p.init()
    const a = await strandedBranch(p, 'root/02s-a', 'a.ts', 'A\n')
    const b = await strandedBranch(p, 'root/02s-b', 'b.ts', 'B\n')
    const ctl = new AbortController()
    let calls = 0
    await planRescue(
      depsOf(p, {
        signal: ctl.signal,
        triage: async () => {
          calls += 1
          ctl.abort()
          return [{ ref: a.branch, verdict: 'merge' as const, why: '独有' }]
        },
      }),
      [item({ kind: 'branchOnly', branch: a.branch, why: '' }), item({ kind: 'branchOnly', branch: b.branch, why: '' })],
    )
    expect(calls).toBe(1)
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
    /**
     * **同一份计划,两句相反的话,判据是这一趟有没有拷贝接缝。**
     *
     * 上一版这里无条件写「没法合并,请手工取用」—— 加法补录落地之后那句话就是假的,
     * 而它印在用户按下 y **之前**。所以正反两面各钉一条:接缝缺席时不许承诺补录,
     * 接缝在时不许还说「手工取用」。
     */
    const without = rescueLines(plan, false).join('\n')
    expect(without).toContain('没有拷贝接缝')
    expect(without).toContain('手工取用')
    expect(without).not.toContain('会被**补录**')
    const withSeam = rescueLines(plan, true).join('\n')
    expect(withSeam).toContain('会被**补录**进集成分支')
    expect(withSeam).not.toContain('手工取用')
    expect(withSeam).toContain('目录本身不会被删')
  })
})

/**
 * **第 3 级对孤儿目录也要生效。**
 *
 * 上一版补录完什么都不量,于是这一格永远不会出现在 `stranded` 里 —— 三级递降只对 ref
 * 那条路成立,而孤儿目录恰恰是四类里此前唯一 0% 捞回的那一格。
 */
describe('孤儿目录的第 3 级', () => {
  const copyInto = async (from: string, to: string): Promise<void> => {
    await mkdir(join(to, '..'), { recursive: true })
    await copyFile(from, to)
  }

  async function orphanWith(files: Record<string, string>): Promise<string> {
    const orphan = join(worktreeRoot, 'integration.orphan')
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(join(orphan, rel, '..'), { recursive: true })
      await writeFile(join(orphan, rel), body)
    }
    return orphan
  }

  it('补录没成 → 落一条痕,而且说清是哪几个文件', async () => {
    const p = pool(); await p.init()
    const orphan = await orphanWith({ 'lost.ts': 'only here\n' })
    // 让最后那一次快进一直失败 —— 补录进不去,而文件确确实实还没在集成分支上。
    const stuck: RescueDeps['git'] = async (args, cwd) =>
      args[0] === 'merge' && args[1] === '--ff-only'
        ? { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' }
        : git(args, cwd)
    const plan = await planRescue(depsOf(p, { copyInto }), [item({ kind: 'orphanDir', path: orphan, why: '' })], listFiles)
    const out = await runRescue(depsOf(p, { copyInto, git: stuck }), plan)
    const s = out.stranded.find(x => x.ref === orphan)
    expect(s).toBeDefined()
    expect(s?.paths).toEqual(['lost.ts'])
    // 无主 —— 孤儿目录按定义没有节点,不许假装有人接。
    expect(s?.nodeId).toBeUndefined()
    // 「你自己处置」那句命令按它分岔:目录不能用 `git diff <分支> <目录>`。
    expect(s?.where).toBe('dir')
  })

  it('补录成功的那些不落痕 —— 判据是量出来的,不是打算做的', async () => {
    const p = pool(); await p.init()
    const orphan = await orphanWith({ 'lost.ts': 'only here\n' })
    const plan = await planRescue(depsOf(p, { copyInto }), [item({ kind: 'orphanDir', path: orphan, why: '' })], listFiles)
    const out = await runRescue(depsOf(p, { copyInto }), plan)
    expect(out.backfilled[0]?.added).toEqual(['lost.ts'])
    expect(out.stranded.find(x => x.ref === orphan)).toBeUndefined()
  })

  /**
   * **量差额的基准是补录那一笔提交,不是那条会动的分支。**
   *
   * `deps.integrationBranch` 是共享的:别的节点在这中间合进来、并且**故意删掉**我们刚
   * 补录的文件时,再量一遍会得到「还差」,于是 `b` 会去复活一次故意的删除。这正是这个
   * 仓库那条记忆(「基准挂在别人随时会动的东西上」)的又一张脸。
   */
  it('补录成功之后集成分支又删掉了它 —— 不许因此落痕', async () => {
    const p = pool(); await p.init()
    const orphan = await orphanWith({ 'lost.ts': 'only here\n' })
    let deleted = false
    // 补录那一笔快进进去之后,立刻模拟另一个节点合进来并删掉它。
    const thenDelete: RescueDeps['git'] = async (args, cwd) => {
      const r = await git(args, cwd)
      if (!deleted && args[0] === 'merge' && args[1] === '--ff-only' && r.code === 0) {
        deleted = true
        await git(['rm', '-q', '--', 'lost.ts'], p.integrationPath)
        await git(['commit', '-qm', '别的节点故意删掉了它'], p.integrationPath)
      }
      return r
    }
    const plan = await planRescue(depsOf(p, { copyInto }), [item({ kind: 'orphanDir', path: orphan, why: '' })], listFiles)
    const out = await runRescue(depsOf(p, { copyInto, git: thenDelete }), plan)
    expect(deleted).toBe(true)
    expect(out.backfilled[0]?.added).toEqual(['lost.ts'])
    expect(out.stranded.find(x => x.ref === orphan)).toBeUndefined()
  })

  /**
   * **有明确理由被挡下的那些不落痕。**
   *
   * D/F 冲突、`.gitignore`、符号链接 —— 它们该留在屏幕上让**用户自己判**。落痕等于替他
   * 判成「按 b 重做」,而 D/F 冲突那一类在结构上根本补录不了,重做多少次都一样。
   */
  it('被判据挡下的那一条不落痕,但要出现在 skipped 里', async () => {
    const p = pool(); await p.init()
    // 集成分支上 `lib` 是个文件,孤儿目录里 `lib/` 是目录 —— 补录它会让 git 删掉那个文件。
    const l = await p.acquire(node('root/df')) as { path: string }
    await writeFile(join(l.path, 'lib'), 'I am a file\n')
    await p.commitAndMerge(node('root/df'))
    const orphan = await orphanWith({ 'lib/util.ts': 'U\n' })
    const plan = await planRescue(depsOf(p, { copyInto }), [item({ kind: 'orphanDir', path: orphan, why: '' })], listFiles)
    const out = await runRescue(depsOf(p, { copyInto }), plan)
    expect(out.backfilled[0]?.skipped.some(s => s.path === 'lib/util.ts')).toBe(true)
    expect(out.stranded.find(x => x.ref === orphan)).toBeUndefined()
  })
})

describe('屏幕上说了什么', () => {
  it('「拿不准」要说清会补录、也要说清不会动什么', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/09', 'a.ts', 'x\n')
    const plan = await planRescue(depsOf(p), [item({ kind: 'branchOnly', branch, why: '' })])
    const text = rescueLines(plan).join('\n')
    expect(text).toContain('拿不准')
    /**
     * **屏幕说的和代码要做的必须是同一件事。**
     *
     * 拿不准那一桶现在会被真的写进集成分支(只写它没有的路径)。上一版把它印成
     * 「**保留不合**」—— 屏幕说着不动,代码正要动手。所以正反各钉一条。
     */
    expect(text).toContain('不整条合并')
    expect(text).toContain('覆盖不了任何已有内容')
    expect(text).not.toContain('保留不合')
  })

  /**
   * **`skip` 和「拿不准」的归宿不同,屏幕上就必须是两句话。**
   *
   * `skip` 到此为止:不补录、也不落痕(让 `b` 去重做一个有理由被排除的废稿是纯破坏)。
   * 而「到此为止」这件事必须说出来,并给出推翻它的命令 —— 混在一句「保留不合」里,
   * 用户读到的是「先放着」,实际是「永远放着」。
   */
  it('判定不合的那些要说「到此为止」,并给出自己动手的命令', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/09s', 'a.ts', 'x\n')
    const plan = await planRescue(
      depsOf(p, { triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'skip' as const, why: '已被取代' })) }),
      [item({ kind: 'branchOnly', branch, why: '' })],
    )
    const text = rescueLines(plan).join('\n')
    expect(text).toContain('到此为止')
    expect(text).toContain(`git merge ${branch}`)
    expect(plan.backfill).toEqual([])
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

/**
 * **量「还剩多少」的那把尺,只能数 ref 这一侧真的有的路径。**
 *
 * 验收席实测:上一版直接数 `git diff --name-only <集成分支> <ref>` 的行数,而那份清单里
 * 同样含着**集成分支自己独有**的路径(别的节点合进去的东西)。一条已经全捞回来的 ref
 * 因此被算成「还差 2 处」→ 节点被落痕 → 屏幕承诺「按 b 回溯会把这些内容重新做出来」→
 * `b` 去重跑一个已经完成的任务。只要树上不止一个节点(也就是永远),这把尺就一直偏。
 */
describe('还剩多少没捞回来', () => {
  it('集成分支自己独有的路径不算「还差」', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/rm-1', 'mine.ts', 'M\n')
    // 别的节点往集成分支上合了两个文件 —— 和这条 ref 毫无关系。
    await writeFile(join(p.integrationPath, 'other1.ts'), 'O1\n')
    await writeFile(join(p.integrationPath, 'other2.ts'), 'O2\n')
    await git(['add', '-A'], p.integrationPath)
    await git(['commit', '-qm', 'others'], p.integrationPath)
    // 把这条 ref 自己那份也合进去 —— 它现在一个字都不差了。
    await git(['merge', '--no-edit', '-q', branch], p.integrationPath)

    expect(await remainingOnRef(depsOf(p), branch)).toBe(0)
  })

  it('ref 上真的还有没进去的内容时,数得出来', async () => {
    const p = pool(); await p.init()
    const { branch } = await strandedBranch(p, 'root/rm-2', 'mine.ts', 'M\n')
    expect(await remainingOnRef(depsOf(p), branch)).toBe(1)
  })
})
