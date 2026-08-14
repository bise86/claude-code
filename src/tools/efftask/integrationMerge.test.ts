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
import { mergeIntoIntegration, syncTrunk, type IntegrationMergeDeps } from './integrationMerge.js'
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

/**
 * **临时合并工作区是共享的,而从 `git merge` 到读 HEAD 这一段不在任何锁里。**
 *
 * 数据安全席在真 git 上复现:另一条流的 `stageAt`(`reset --hard <tip>`)落在这中间时,
 * 读到的 HEAD 就是 `tip` 本身,接着 `merge --ff-only <tip>` 回一句 `Already up to date`、
 * **退出码 0** —— 这条路把它当成成功,而集成分支一个字节都没动。
 *
 * 这里用真 git + 一个会在指定时刻插一脚的 runner 复现那一刻。判据不是「报了什么」,
 * 是**集成分支上到底有没有那个文件**。
 */
describe('别的流程在中途收拾了临时合并工作区', () => {
  /** 造一条有产出、目录已经不在的分支 —— `m` 键那条路上最常见的形状。 */
  async function branchWithWork(p: ReturnType<typeof pool>, id: string, file: string): Promise<string> {
    const n = node(id)
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, file), 'work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'w'], l.path)
    const branch = p.worktreeBranchOf(n)
    await rm(l.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)
    return branch
  }

  it('合完之后 HEAD 被挪回 tip:不许报成功,重来一趟并真的合上', async () => {
    const p = pool(); await p.init()
    const branch = await branchWithWork(p, 'root/10', 'rescued.ts')
    const scratch = join(worktreeRoot, 'merge-scratch')
    let intruded = 0
    // 只插一脚:第一次读 scratch 的 HEAD 之前,模拟另一条流的 stageAt 把它 reset 回 tip。
    const meddling: GitRunner = async (args, cwd) => {
      if (cwd === scratch && args[0] === 'rev-parse' && args[1] === 'HEAD' && intruded === 0) {
        intruded += 1
        const tip = (await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()
        await git(['reset', '--hard', tip], scratch)
      }
      return git(args, cwd)
    }
    const res = await mergeIntoIntegration(depsOf(p, { git: meddling }), branch)
    expect(intruded).toBe(1)
    expect(res.ok).toBe(true)
    // **判据落在集成分支上,不落在返回值上** —— 假成功那一版这里是 code !== 0。
    expect((await git(['show', `${p.integrationBranchName}:rescued.ts`], gitRoot)).code).toBe(0)
  })

  it('每一趟都被挪走:如实报失败,而不是报一句假的「已捞回」', async () => {
    const p = pool(); await p.init()
    const branch = await branchWithWork(p, 'root/11', 'rescued.ts')
    const scratch = join(worktreeRoot, 'merge-scratch')
    const meddling: GitRunner = async (args, cwd) => {
      if (cwd === scratch && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        const tip = (await git(['rev-parse', p.integrationBranchName], gitRoot)).stdout.trim()
        await git(['reset', '--hard', tip], scratch)
      }
      return git(args, cwd)
    }
    const res = await mergeIntoIntegration(depsOf(p, { git: meddling }), branch)
    expect(res.ok).toBe(false)
    expect((await git(['show', `${p.integrationBranchName}:rescued.ts`], gitRoot)).code).not.toBe(0)
  })

  /**
   * **「合进去了」由 git 证明,不由 `--ff-only` 的退出码证明。**
   *
   * 上面那道 `sha !== tip` 挡的是已知的一种成因。这条探针把闸单独拎出来:让快进这一句
   * **假装**成功(退出码 0、什么都不做),看这条路认不认。这个仓库为「前面的判据把兜底
   * 闸遮住了、反转它测试全绿」付过账,所以兜底闸要能被单独证明。
   */
  it('快进报了 0 而 ref 并没进集成分支 → 判失败', async () => {
    const p = pool(); await p.init()
    const branch = await branchWithWork(p, 'root/12', 'rescued.ts')
    const lying: GitRunner = async (args, cwd) => {
      if (cwd === p.integrationPath && args[0] === 'merge' && args[1] === '--ff-only') {
        return { code: 0, stdout: '', stderr: '' }
      }
      return git(args, cwd)
    }
    const res = await mergeIntoIntegration(depsOf(p, { git: lying }), branch)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toContain('仍然不在集成分支里')
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

/**
 * **需求 7:集成分支 → 你当前的分支,先同步主干再迭代解冲突。**
 *
 * 关键是方向:先把**用户的分支合进集成分支**(冲突在临时树里由模型解),之后回主干那一跳
 * 自然是快进 —— 用户的检出一次三方合并都不会经历。`intoTrunk` 今天的做法是反的,
 * 所以它撞冲突只能无条件 abort。
 */
describe('syncTrunk —— 先同步主干,再快进', () => {
  const clean = async (): Promise<{ dirty: boolean }> => ({ dirty: false })

  it('主干落后时直接快进', async () => {
    const p = pool(); await p.init()
    const n = node('root/t1')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'out.ts'), 'produced\n')
    await p.commitAndMerge(n)
    // commitAndMerge 顺手送过一次,把主干退回去造出「没送到」的形状。
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)

    const res = await syncTrunk({ ...depsOf(p), trackedDirty: clean })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advanced).toBe(true)
    expect(await readFile(join(gitRoot, 'out.ts'), 'utf-8')).toBe('produced\n')
  })

  /**
   * **这一条是整条改造的理由。** 用户自己提交过、而且和产出撞在同一个文件同一行上 ——
   * 今天 `intoTrunk` 在这里只能 abort,产出永远送不到他的目录。
   */
  it('用户自己提交过且撞冲突:在临时树里解掉,他的检出全程干净', async () => {
    const p = pool(); await p.init()
    const base = (await git(['rev-parse', 'HEAD'], gitRoot)).stdout.trim()
    const n = node('root/t2')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'clash.ts'), 'FROM RUN\n')
    await p.commitAndMerge(n)
    // 用户回到合并之前,自己在同一个文件上提交一笔 —— 真冲突。
    await git(['reset', '--hard', base], gitRoot)
    await writeFile(join(gitRoot, 'clash.ts'), 'FROM USER\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user own work'], gitRoot)

    const dirtyDuring: boolean[] = []
    const res = await syncTrunk({
      ...depsOf(p, {
        resolve: async info => {
          // 解冲突期间,用户的检出必须干净 —— 冲突现场在临时树里,不在他那儿。
          const st = await git(['status', '--porcelain'], gitRoot)
          dirtyDuring.push(st.stdout.split('\n').some(x => /^(UU|AA) /.test(x.trim())))
          await writeFile(join(info.cwd, 'clash.ts'), 'FROM USER + FROM RUN\n')
        },
      }),
      trackedDirty: clean,
    })
    expect(res.ok).toBe(true)
    expect(dirtyDuring.every(d => d === false)).toBe(true)
    // 两边的意图都落到了他的目录里。
    expect(await readFile(join(gitRoot, 'clash.ts'), 'utf-8')).toBe('FROM USER + FROM RUN\n')
    // 而且他的检出没有留下任何半合并态。
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)).code).not.toBe(0)
  })

  /**
   * **脏树不再前置挡 —— 这一条推翻了它的上一版。**
   *
   * 上一版断言「有已跟踪改动就 `ok:false`」。真 git 上量过那道闸比 git 本身严得多:
   * git 的保护是**逐文件**的,合并碰不到那几个脏文件就直接成功、改动毫发无损。跑机实测
   * (qianbase-xtp run 001):3 个不相干的脏文件把 607 个提交全堵在集成分支上。
   *
   * 夹具用**真脏文件**,不是桩 —— 这一条的全部意义就是「用户的改动在合并前后逐字节相同」。
   */
  it('脏文件和这次合并不相交 → 照常合上,而且用户的改动一个字节都没变', async () => {
    const p = pool(); await p.init()
    // 集成分支必须先领先一步,这条判据才轮得到(「已经是最新的」那条早退排在前面)。
    const n = node('root/t-dirty')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'out.ts'), 'produced\n')
    await p.commitAndMerge(n)
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    // 用户手上一个**和 out.ts 无关**的脏文件。
    const mine = join(gitRoot, 'base.txt')
    await writeFile(mine, '我正在改的东西\n')

    const res = await syncTrunk({ ...depsOf(p), trackedDirty: async () => ({ dirty: true, detail: ' M base.txt' }) })
    expect(res.ok).toBe(true)
    expect(await readFile(mine, 'utf8')).toBe('我正在改的东西\n')
    // 而且它仍然是未提交的 —— 合并没有把它卷进任何提交。
    const st = await git(['status', '--porcelain', '--', 'base.txt'], gitRoot)
    expect(st.stdout.trim()).toContain('base.txt')
  })

  /**
   * 真撞上时:git 当场拒绝、**一个字节不动**,而这一层要认得出它的原话并点名文件 ——
   * 此前这一串会掉进底下的 3 次重试循环,最后报「你在同步期间反复提交,重试 3 次仍未
   * 合上」,一条**假原因**(用户根本没有反复提交,他只是有几个文件没存)。
   */
  it('脏文件正好被这次合并改到 → 如实说是哪个文件,不说「反复提交」', async () => {
    const p = pool(); await p.init()
    const n = node('root/t-collide')
    const l = await p.acquire(n) as { path: string }
    // 这次合并要改的正是 base.txt。
    await writeFile(join(l.path, 'base.txt'), '来自任务的内容\n')
    await p.commitAndMerge(n)
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    const mine = join(gitRoot, 'base.txt')
    await writeFile(mine, '我正在改的东西\n')

    const res = await syncTrunk({ ...depsOf(p), trackedDirty: async () => ({ dirty: true, detail: ' M base.txt' }) })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.why).toContain('base.txt')
      expect(res.why).toContain('没有任何东西被改动')
      expect(res.why).not.toContain('反复提交')
      expect(res.followUps.join('\n')).toContain('stash')
    }
    // 最要紧的:他的文件原样在。
    expect(await readFile(mine, 'utf8')).toBe('我正在改的东西\n')
  })

  it('detached HEAD 不合', async () => {
    const p = pool(); await p.init()
    await git(['checkout', '--detach'], gitRoot)
    const res = await syncTrunk({ ...depsOf(p), trackedDirty: clean })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toContain('detached')
  })

  it('已经是最新的 → 报没前进,而不是报失败', async () => {
    const p = pool(); await p.init()
    const res = await syncTrunk({ ...depsOf(p), trackedDirty: clean })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.advanced).toBe(false)
  })

  /**
   * 未跟踪文件挡住那一种是**良性**的:git 拒绝并且一个字节都不动。它重试也不会好,
   * 所以要认出来并如实说「你的文件原样保留」,而不是笼统报一句合并失败。
   */
  it('未跟踪文件会被覆盖时:如实说清楚,而文件原样保留', async () => {
    const p = pool(); await p.init()
    const n = node('root/t3')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'newfile.ts'), 'from run\n')
    await p.commitAndMerge(n)
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    // 用户目录里有个同名的未跟踪文件。
    await writeFile(join(gitRoot, 'newfile.ts'), 'MY PRECIOUS\n')

    const res = await syncTrunk({ ...depsOf(p), trackedDirty: clean })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.why).toContain('原样保留')
    expect(await readFile(join(gitRoot, 'newfile.ts'), 'utf-8')).toBe('MY PRECIOUS\n')
  })
})

/**
 * **复用临时工作树时,收拾必须排在对齐之前 —— 否则它会被永久卡死。**
 *
 * 验收在真 git 上复现的路径完全现实:`autoResolveMerge` 只 `git add -- <冲突文件>` 然后
 * `commit --no-edit`(**没有 `-a`**)。解冲突模型顺手改了一个不在冲突列表里的受跟踪文件
 * → 这一次合并成功,而临时树留着一个未暂存的改动。下一次进来时 `checkout --detach` 报
 * 「local changes would be overwritten」并早退,而收拾它的 `reset --hard` / `clean -fd`
 * 排在它下游 —— 从此 `m` 键的捞回和合回主干**两条路全部永久失败**。
 */
describe('临时工作树被上一轮弄脏之后', () => {
  it('解冲突模型顺手改了别的受跟踪文件 → 下一次合并照样成功', async () => {
    const p = pool(); await p.init()
    const first = await clashingBranch(p, 'MINE\n', 'THEIRS\n')
    const res1 = await mergeIntoIntegration(depsOf(p, {
      resolve: async info => {
        await writeFile(join(info.cwd, 'clash.ts'), 'RESOLVED\n')
        // 不在冲突列表里的受跟踪文件 —— `git add -- <冲突文件>` 不会带上它,
        // `commit --no-edit` 也不会(没有 -a),于是它留在树里没暂存。
        await writeFile(join(info.cwd, 'base.txt'), 'model touched this too\n')
      },
    }), first)
    expect(res1.ok).toBe(true)
    /**
     * 成功那条路现在会把临时树**收掉**(它是一棵完整检出,而这一轮的起因就是盘被撑满),
     * 所以这里不能再拿「上一次留下的脏」当前提 —— 改成**显式造**一棵脏的复用它。
     * 失败路径仍然会把它留在盘上(那是现场),复用逻辑照样要顶得住。
     */
    await git(['worktree', 'add', '--detach', join(worktreeRoot, 'merge-scratch'), p.integrationBranchName], gitRoot)
    await writeFile(join(worktreeRoot, 'merge-scratch', 'base.txt'), 'left dirty by an earlier round\n')
    const dirty = await git(['status', '--porcelain'], join(worktreeRoot, 'merge-scratch'))
    expect(dirty.stdout.trim().length).toBeGreaterThan(0)

    // 第二次合并:换一条干净的分支,不该受上一轮的残留影响。
    const n = node('root/after-dirty')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'second.ts'), 'second work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'second'], l.path)
    const branch = p.worktreeBranchOf(n)
    await rm(l.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)

    const res2 = await mergeIntoIntegration(depsOf(p), branch)
    expect(res2.ok).toBe(true)
    expect((await git(['show', `${p.integrationBranchName}:second.ts`], gitRoot)).stdout).toBe('second work\n')
  })

  /** 半合并态残留同理:先 abort、再 reset,不能让它挡住后面的对齐。 */
  it('上一轮留下半合并态时也能复用', async () => {
    const p = pool(); await p.init()
    const scratch = join(worktreeRoot, 'merge-scratch')
    await git(['worktree', 'add', '--detach', scratch, p.integrationBranchName], gitRoot)
    await writeFile(join(scratch, 'base.txt'), 'dirtied without staging\n')

    const n = node('root/after-halfmerge')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'x.ts'), 'x\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'x'], l.path)
    const res = await mergeIntoIntegration(depsOf(p), p.worktreeBranchOf(n))
    expect(res.ok).toBe(true)
  })
})
