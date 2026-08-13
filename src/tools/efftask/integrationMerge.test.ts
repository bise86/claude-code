/**
 * 「用解冲突的模型来执行合并」—— 对着**真 git** 测。
 *
 * 这条路会往集成分支上产生真实提交,而且中间夹着模型调用。三件事只有真 git 答得对:
 * 冲突到底出没出、`--ff-only` 到底成不成立、`merge --abort` 之后现场干不干净。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import { mergeIntoIntegration, type IntegrationMergeDeps } from './integrationMerge.js'
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

const node = (id: string): TaskNode => createNode({
  id, title: id, parentId: null, deps: [], depth: 0,
  phaseRoles: emptyPhaseRoles(), now: new Date().toISOString(),
})

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-im-'))
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

/** 锁的进出计数 —— 「模型调用不在锁里」这条判据靠它断言。 */
let lockDepth = 0

const depsOf = (
  p: ReturnType<typeof pool>, over: Partial<IntegrationMergeDeps> = {},
): IntegrationMergeDeps => ({
  git,
  gitRoot: p.gitRoot,
  integrationBranch: p.integrationBranchName,
  integrationPath: p.integrationPath,
  worktreeRoot,
  withIntegrationLock: async fn => {
    lockDepth += 1
    try { return await p.withIntegrationRead(fn) } finally { lockDepth -= 1 }
  },
  ...over,
})

/**
 * 造一条和集成分支在同一个文件同一行上冲突的分支。
 *
 * 基线必须在**第一次合并之前**取:`commitAndMerge` 成功后 `intoTrunk` 会把 `main` 也推进,
 * 从 `main` 拉分支拿到的 merge-base 就是集成分支的 tip —— 那是一次快进而**根本不冲突**。
 */
async function clashingBranch(
  p: ReturnType<typeof pool>, mine: string, theirs: string,
): Promise<string> {
  const base = (await git(['rev-parse', 'HEAD'], gitRoot)).stdout.trim()
  const a = node('root/int')
  const la = await p.acquire(a) as { path: string }
  await writeFile(join(la.path, 'clash.ts'), theirs)
  await p.commitAndMerge(a)

  const b = node('root/other')
  const lb = await p.acquire(b) as { path: string }
  await git(['checkout', '-B', p.worktreeBranchOf(b), base], lb.path)
  await writeFile(join(lb.path, 'clash.ts'), mine)
  await git(['add', '-A'], lb.path)
  await git(['commit', '-qm', 'other side'], lb.path)
  const branch = p.worktreeBranchOf(b)
  await rm(lb.path, { recursive: true, force: true })
  await git(['worktree', 'prune'], gitRoot)
  return branch
}

beforeEach(async () => { lockDepth = 0; await freshRepo() })
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('干净合并', () => {
  it('合进集成分支,而且只在快进那一下拿锁', async () => {
    const p = pool(); await p.init()
    const n = node('root/01')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'new.ts'), 'work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'w'], l.path)
    const branch = p.worktreeBranchOf(n)
    await rm(l.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)

    const res = await mergeIntoIntegration(depsOf(p), branch)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advanced).toBe(true)
    expect((await git(['show', `${p.integrationBranchName}:new.ts`], gitRoot)).stdout).toBe('work\n')
  })

  it('已经全在集成分支里 → 报没前进,而不是报失败', async () => {
    const p = pool(); await p.init()
    const n = node('root/02')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'a.ts'), 'x\n')
    await p.commitAndMerge(n)
    const res = await mergeIntoIntegration(depsOf(p), p.worktreeBranchOf(n))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advanced).toBe(false)
  })
})

describe('撞冲突:交给模型解', () => {
  /**
   * **这条是整个落点的理由。**
   *
   * 集成工作区只有一个 index、一个检出,而 `commitAndMerge` 写它、集成验收读它,
   * 两者共用 `mergeLock`。把一次几分钟的模型调用关进那把锁,整棵树的合并当场停摆
   * (`mergeSubtree.ts` 顶上那段注释写死过这条)。所以解冲突必须发生在**锁外**。
   */
  it('模型解冲突时那把锁没有被持着', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    const depths: number[] = []
    const res = await mergeIntoIntegration(depsOf(p, {
      resolve: async info => {
        depths.push(lockDepth)
        await writeFile(join(info.cwd, 'clash.ts'), 'MERGED BY MODEL\n')
      },
    }), branch)
    expect(res.ok).toBe(true)
    expect(depths.length).toBeGreaterThan(0)
    // 每一次模型调用都必须在锁外。
    expect(depths.every(d => d === 0)).toBe(true)
  })

  it('解完之后内容真的到了集成分支上,而且报得出解了哪几个文件', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    const res = await mergeIntoIntegration(depsOf(p, {
      resolve: async info => { await writeFile(join(info.cwd, 'clash.ts'), 'BOTH SIDES\n') },
    }), branch)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.resolvedFiles).toContain('clash.ts')
    expect((await git(['show', `${p.integrationBranchName}:clash.ts`], gitRoot)).stdout).toBe('BOTH SIDES\n')
  })

  /**
   * **「另一半是什么来历」必须一路带到解决者手上。**
   *
   * 捞回一条**被后来的版本取代**的抢救分支时,一个不知情的解决者会尽力「保留双方的意图」,
   * 于是把废稿留下来盖在已经修好的代码上。这件事是调用方知道、模型无从得知的。
   */
  it('note 传得到解决者手上', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    let seen: string | undefined
    await mergeIntoIntegration(depsOf(p, {
      resolve: async info => {
        seen = info.note
        await writeFile(join(info.cwd, 'clash.ts'), 'x\n')
      },
    }), branch, '这一版已经被后来的版本取代')
    expect(seen).toContain('已经被后来的版本取代')
  })

  it('没有解冲突模型 → 如实报告,集成分支一个字节都没动', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    const before = (await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()
    const res = await mergeIntoIntegration(depsOf(p), branch)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.conflicted).toBe(true)
      expect(res.restored).toBe(true)
      expect(res.why).toContain('没有可用的解冲突模型')
    }
    expect((await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()).toBe(before)
  })

  /**
   * **模型说自己解完了不算数。** 留着冲突标记就一律不算 —— `autoResolveMerge` 的三道
   * git 复核里,这一道是唯一抓得住「一个字节都没改」的(那句 `git add` 本身就会消掉
   * 未合并状态)。
   */
  it('解决结果里还留着冲突标记 → 判没解成,并还原', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    const before = (await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()
    const res = await mergeIntoIntegration(depsOf(p, {
      // 什么都不改 —— 带 <<<<<<< 的文件原样留着。
      resolve: async () => {},
      rounds: 1,
    }), branch)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.restored).toBe(true)
    expect((await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()).toBe(before)
  })

  /** 轮数用完就停,而且要说清用满了 —— 不能无限烧。 */
  it('用满轮数仍未解决 → 停下来说清楚', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    let calls = 0
    const res = await mergeIntoIntegration(depsOf(p, {
      resolve: async () => { calls += 1 },
      rounds: 2,
    }), branch)
    expect(res.ok).toBe(false)
    // 冲突文件两轮逐字相同 → 认出「原地打转」,不会白烧满两轮。
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('rounds 为 0 = 不自动解,直接报告', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    let calls = 0
    const res = await mergeIntoIntegration(depsOf(p, {
      resolve: async () => { calls += 1 },
      rounds: 0,
    }), branch)
    expect(res.ok).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('集成分支在解冲突期间前进了', () => {
  /**
   * 模型调用是分钟级的,编排器完全可能在那期间合进去几笔 —— 于是最后那次
   * `--ff-only` 不成立。判据必须是**回去重新同步再合一次**,而**绝不退回普通 merge**:
   * 那会在共享的集成工作区里造一次没人预料的三方合并,撞冲突的话现场就留在大家共用的树里。
   */
  it('快进不成立 → 重新同步后再合一次,最终仍然合上', async () => {
    const p = pool(); await p.init()
    const branch = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    let round = 0
    const res = await mergeIntoIntegration(depsOf(p, {
      resolve: async info => {
        round += 1
        await writeFile(join(info.cwd, 'clash.ts'), `RESOLVED ${round}\n`)
        // 第一轮解完之后,模拟编排器把集成分支推进了一笔(动的是**别的**文件)。
        if (round === 1) {
          const n = node('root/late')
          const l = await p.acquire(n) as { path: string }
          await writeFile(join(l.path, 'late.ts'), 'landed later\n')
          await p.commitAndMerge(n)
        }
      },
    }), branch)
    expect(res.ok).toBe(true)
    // 两边的东西都在:后来那一笔,和最终解出来的那一版。
    expect((await git(['show', `${p.integrationBranchName}:late.ts`], gitRoot)).stdout).toBe('landed later\n')
    expect((await git(['show', `${p.integrationBranchName}:clash.ts`], gitRoot)).stdout).toContain('RESOLVED')
  })
})

describe('临时工作树', () => {
  /** 复用时必须先收掉上一趟留下的半合并态和散落文件,否则这一次的 merge 起不来。 */
  it('复用一棵留着散落文件的临时工作树', async () => {
    const p = pool(); await p.init()
    const scratch = join(worktreeRoot, 'merge-scratch')
    await git(['worktree', 'add', '--detach', scratch, p.integrationBranchName], gitRoot)
    await writeFile(join(scratch, 'junk.txt'), 'left over\n')
    await writeFile(join(scratch, 'base.txt'), 'dirtied\n')

    const n = node('root/03')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'new.ts'), 'work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'w'], l.path)
    const branch = p.worktreeBranchOf(n)

    const res = await mergeIntoIntegration(depsOf(p), branch)
    expect(res.ok).toBe(true)
    // 散落文件被收掉了,而**集成分支上没有它** —— 它不该被一次捞回顺手提交进去。
    expect((await git(['show', `${p.integrationBranchName}:junk.txt`], gitRoot)).code).not.toBe(0)
    expect(await readFile(join(gitRoot, 'base.txt'), 'utf-8')).toBe('base\n')
  })
})
