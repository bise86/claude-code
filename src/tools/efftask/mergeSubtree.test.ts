/**
 * 手动合并子树 —— 对着**真的 git** 测。
 *
 * 和 cleanupWorktrees.test.ts 同一个理由,而且更硬:这条路会在**用户自己的检出**里产生
 * 真实的 merge commit,还会派一个「主模型」去改冲突文件。一个假 GitRunner 会对
 * 「解完之后到底还有没有 <<<<<<<」「abort 之后工作区是不是真的还原了」点头,而这两件事
 * 正是这个功能唯一不能出错的地方。
 *
 * 每条用例都注明它钉住的那一句承诺。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner, type WorktreePool } from './worktreePool.js'
import {
  runSubtreeMerge, scanSubtreeMerge, subtreeMergeLines, subtreeMergeResultLines, subtreeMergeScope,
  MERGE_KEY_COVERS,
  MERGE_KEY_REPORTS,
  type SubtreeMergeDeps,
} from './mergeSubtree.js'
 import { STRANDED_KINDS, STRANDED_KIND_LIST } from './stranded.js'
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

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: new Date().toISOString(),
  }),
  status: 'ACCEPTED',
  ...over,
})

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-merge-'))
  roots.push(base)
  gitRoot = join(base, 'repo')
  worktreeRoot = join(base, 'wt')
  await mkdir(gitRoot, { recursive: true })
  await mkdir(worktreeRoot, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], gitRoot)
  await git(['config', 'user.email', 's@s'], gitRoot)
  await git(['config', 'user.name', 's'], gitRoot)
  await writeFile(join(gitRoot, 'shared.txt'), 'base\n')
  await git(['add', '-A'], gitRoot)
  await git(['commit', '-qm', 'base'], gitRoot)
}

const newPool = (): WorktreePool => createWorktreePool({ runId: '001', gitRoot, git, worktreeRoot })

const depsOf = (pool: WorktreePool, over: Partial<SubtreeMergeDeps> = {}): SubtreeMergeDeps => ({
  // `worktreeRoot` 是第二跳的必需品:合回主干现在走 `syncTrunk`,而它要一棵**临时工作树**
  // 来放冲突现场(见 integrationMerge.ts —— 模型调用一秒都不能待在 mergeLock 里)。
  // 缺了它这一跳会如实早退,而不是悄悄不做。
  pool, git, worktreeRoot, ...over,
})

/** 拿一个工作区、在里面写点东西并提交 —— 一个「跑完了但还没合」的节点长这样。 */
async function work(pool: WorktreePool, node: TaskNode, file: string, body: string): Promise<string> {
  const lease = await pool.acquire(node)
  if ('error' in lease) throw new Error(lease.error)
  node.worktree = { branch: lease.branch, path: lease.path }
  await writeFile(join(lease.path, file), body)
  await git(['add', '-A'], lease.path)
  await git(['commit', '-qm', `work ${node.id}`], lease.path)
  return lease.path
}

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('范围', () => {
  it('包含目标节点自己 + 全部后代(含孙节点)', () => {
    const tree = [
      mk('root', { childIds: ['root/00-a'] }),
      mk('root/00-a', { parentId: 'root', childIds: ['root/00-a/00-x'] }),
      mk('root/00-a/00-x', { parentId: 'root/00-a' }),
      mk('other'),
    ]
    const { scope } = subtreeMergeScope(tree, 'root')
    expect(scope.map(n => n.id).sort()).toEqual(['root', 'root/00-a', 'root/00-a/00-x'])
  })
})

describe('扫描', () => {
  it('把「有提交没合入」的工作区挑出来,已经合过的和没有目录的分别计数', async () => {
    const pool = newPool()
    expect(await pool.init()).toEqual({ ok: true })
    const a = mk('root/00-a', { title: '甲' })
    const b = mk('root/01-b', { title: '乙' })
    const c = mk('root/02-c', { title: '丙' })   // 从来没有过工作区
    const root = mk('root', { title: '根', childIds: [a.id, b.id, c.id] })
    for (const n of [a, b, c]) n.parentId = 'root'
    await work(pool, a, 'a.txt', 'a\n')
    await work(pool, b, 'b.txt', 'b\n')
    // 乙已经自己合过了。
    expect((await pool.commitAndMerge(b)).ok).toBe(true)

    const plan = await scanSubtreeMerge(depsOf(pool), [root, a, b, c], 'root')
    expect(plan.items.map(i => i.nodeId)).toEqual([a.id])
    expect(plan.items[0]!.commits).toBe(1)
    expect(plan.alreadyMerged).toBe(1)
    // root 和丙都没有目录。
    expect(plan.absent).toBe(2)
  })

  it('还在跑的节点不合 —— 它的工作区正被执行者写着', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲', status: 'EXECUTING' })
    await work(pool, a, 'a.txt', 'a\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.skipped[0]!.why).toContain('还没跑完')
  })

  it('被阻断的节点**要合** —— 它正是这个键的主要服务对象', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲', status: 'BLOCKED', mergeConflict: true })
    await work(pool, a, 'a.txt', 'a\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    expect(plan.items.map(i => i.nodeId)).toEqual([a.id])
  })

  /**
   * 这条守的是这条路上最坏的一个结局:`git add -A` 作用在还挂着 MERGE_HEAD 的树上会把
   * 每个冲突路径标记成已解决(标记还在里面),紧接着的 commit 是一次真合并提交,一路
   * 快进到集成分支再进用户的分支。两种现场都要拦,而**已 git add、只差一次 commit** 的
   * 那种没有任何未合并路径 —— `commitAndMerge` 顶上那道拒绝看不见它。
   */
  it('工作区里有一次没解完的合并时,一个字都不碰(未合并路径)', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    const b = mk('root/01-b', { title: '乙' })
    await work(pool, a, 'shared.txt', '甲写的\n')
    const bPath = await work(pool, b, 'shared.txt', '乙写的\n')
    expect((await pool.commitAndMerge(a)).ok).toBe(true)
    // 把冲突现场留在乙自己的工作区里 —— 一次失败的合并之后就是这个样子。
    const m = await pool.mergeIntegrationIntoNode(b)
    expect(m.ok && m.conflicted).toBe(true)

    const plan = await scanSubtreeMerge(depsOf(pool), [a, b], b.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.skipped[0]!.why).toContain('没解完的合并')
    // 那个目录一个字节都没动:标记还在原处。
    expect(await readFile(join(bPath, 'shared.txt'), 'utf-8')).toContain('<<<<<<<')
  })

  it('已 git add、只差一次 commit 的解决同样不碰 —— 它没有任何未合并路径', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    const b = mk('root/01-b', { title: '乙' })
    await work(pool, a, 'shared.txt', '甲写的\n')
    const bPath = await work(pool, b, 'shared.txt', '乙写的\n')
    await pool.commitAndMerge(a)
    await pool.mergeIntegrationIntoNode(b)
    // 「解了一半」:标记还在文件里,但已经 git add 过了。
    await git(['add', 'shared.txt'], bPath)
    expect((await git(['diff', '--name-only', '--diff-filter=U'], bPath)).stdout.trim()).toBe('')

    const plan = await scanSubtreeMerge(depsOf(pool), [a, b], b.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.skipped[0]!.why).toContain('没解完的合并')
    // 真正要守的那一句:带标记的内容没有被合进集成分支。
    const int = await git(['show', `${pool.integrationBranchName}:shared.txt`], gitRoot)
    expect(int.stdout).not.toContain('<<<<<<<')
  })

  it('未提交的东西要先数出来 —— 合并会把它们一并提交进去', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    const path = await work(pool, a, 'a.txt', 'a\n')
    await writeFile(join(path, 'loose.txt'), 'loose\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    expect(plan.items[0]!.loose).toBe(1)
    expect(subtreeMergeLines(plan).join('\n')).toContain('未提交内容会被一并提交')
  })
})

describe('合并到主干', () => {
  it('产出真的出现在用户自己的检出里(两跳都做了)', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    const out = await runSubtreeMerge(deps, plan, [a])

    expect(out.failed).toEqual([])
    expect(out.merged.map(m => m.nodeId)).toEqual([a.id])
    expect(out.trunk?.ok).toBe(true)
    // 这一条才是这个功能的全部承诺:文件在**用户的工作目录**里。
    expect(await readFile(join(gitRoot, 'a.txt'), 'utf-8')).toBe('hello\n')
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)
    expect(branch.stdout.trim()).toBe('main')
  })

  it('一个节点都不用合时,仍然把卡在集成分支上的东西送到你的分支', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    expect((await pool.commitAndMerge(a)).ok).toBe(true)
    /**
     * **让第 2 跳重新变成「欠着的」。**
     *
     * 上一版是靠「把用户的检出弄脏」做到这一点的 —— 而脏树已经不再挡住这一跳了
     * (git 的保护是逐文件的,不相交就直接合上)。改用 `reset --hard HEAD~1`:
     * 用户自己回退掉刚合进来的那一笔,集成分支于是重新领先一步,而 `items` 仍然是空的
     * (那个节点已经合过了)—— 这条用例要测的正是「一个节点都不用合,但主干这一跳有欠账」。
     */
    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    expect(await Bun.file(join(gitRoot, 'a.txt')).exists()).toBe(false)

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.trunk.pending).toBe(1)
    const out = await runSubtreeMerge(deps, plan, [a])
    expect(out.trunk?.ok).toBe(true)
    expect(await readFile(join(gitRoot, 'a.txt'), 'utf-8')).toBe('hello\n')
  })

  /**
   * **脏树不再挡住第 2 跳 —— 这一条推翻了它的上一版。**
   *
   * 上一版断言 `plan.trunk.blocked` 含「未提交的改动」,于是 `m` 的确认屏印
   * 「⚠ 合回你当前分支这一步现在做不了」,而真正跑那一跳的 `syncTrunk` 根本没被调到。
   * 跑机实测(qianbase-xtp run 001):3 个不相干的脏文件把 607 个提交全堵住。
   */
  it('脏文件和这次合并不相交 → 第 2 跳照做,而且用户的脏文件一个字节没变', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    // 用户手上一个**和 a.txt 无关**的脏文件(shared.txt 是已跟踪的)。
    await writeFile(join(gitRoot, 'shared.txt'), 'dirty\n')

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    expect(plan.trunk.blocked).toBeUndefined()
    const out = await runSubtreeMerge(deps, plan, [a])
    expect(out.merged).toHaveLength(1)
    expect(out.trunk?.ok).toBe(true)
    // 产出到了,而他的改动原样在、而且仍然是未提交的。
    expect(await readFile(join(gitRoot, 'a.txt'), 'utf-8')).toBe('hello\n')
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).toBe('dirty\n')
    const st = await git(['status', '--porcelain', '--', 'shared.txt'], gitRoot)
    expect(st.stdout.trim()).toContain('shared.txt')
  })

  /** 探不出干净与否(git 自己出错)仍然要挡 —— 那不是「脏」,是这个仓库问不出话来。 */
  it('git diff 探测失败仍然挡住第 2 跳', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    const deps = depsOf(pool)
    const broken = {
      ...deps,
      git: async (args: string[], cwd: string) =>
        args[0] === 'diff' && cwd === gitRoot
          ? { code: 128, stdout: '', stderr: 'fatal: 坏了' }
          : deps.git(args, cwd),
    }
    const plan = await scanSubtreeMerge(broken, [a], a.id)
    expect(plan.trunk.blocked).toContain('无法判断')
  })
})

describe('撞冲突', () => {
  /** 造两个改同一行的节点:第一个合得进去,第二个必然冲突。 */
  async function conflictingPair(pool: WorktreePool): Promise<[TaskNode, TaskNode]> {
    const a = mk('root/00-a', { title: '甲' })
    const b = mk('root/01-b', { title: '乙' })
    await work(pool, a, 'shared.txt', '甲写的\n')
    await work(pool, b, 'shared.txt', '乙写的\n')
    return [a, b]
  }

  it('派主模型解决,解完 git 复核通过就产生真的合并提交', async () => {
    const pool = newPool()
    await pool.init()
    const [a, b] = await conflictingPair(pool)
    let called = 0
    const deps = depsOf(pool, {
      resolve: async ({ files, cwd }) => {
        called++
        // 「主模型」把两边的意图都保留下来 —— 真实解决长这样。
        for (const f of files) await writeFile(join(cwd, f), '甲写的\n乙写的\n')
      },
    })
    const plan = await scanSubtreeMerge(deps, [a, b], 'root/00-a')
    // 两个节点不在同一棵子树里,分别合。
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], a.id), [a, b])
    expect(out.failed).toEqual([])
    const out2 = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], b.id), [a, b])

    expect(plan.items).toHaveLength(1)
    expect(called).toBe(1)
    expect(out2.failed).toEqual([])
    expect(out2.merged[0]!.resolvedFiles).toEqual(['shared.txt'])
    const text = await readFile(join(gitRoot, 'shared.txt'), 'utf-8')
    expect(text).toBe('甲写的\n乙写的\n')
    expect(text).not.toContain('<<<<<<<')
    expect(subtreeMergeResultLines(out2).join('\n')).toContain('主模型解决了 1 个冲突文件')
  })

  it('模型什么都没干时**不算解决** —— 冲突标记会被 git 抓住,工作区还原,如实报失败', async () => {
    const pool = newPool()
    await pool.init()
    const [a, b] = await conflictingPair(pool)
    const deps = depsOf(pool, { resolve: async () => { /* 一个字节都不改 */ } })
    await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], a.id), [a, b])
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], b.id), [a, b])

    expect(out.merged).toEqual([])
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]!.why).toContain('冲突标记')
    // 节点的工作区被还原了 —— 没有半合并状态留在那里。
    const st = await git(['status', '--porcelain'], pool.worktreePathOf(b))
    expect(st.stdout.split('\n').filter(l => /^(UU|AA) /.test(l))).toEqual([])
    // 用户的检出里也没有乙的半成品。
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).toBe('甲写的\n')
    expect(subtreeMergeResultLines(out)[0]).toBe('没有合并任何工作区。')
  })

  /**
   * 扫描和执行之间隔着好几分钟和好几次模型调用,而这中间跑着的编排器完全可能在自己的
   * 解冲突循环里把某棵树留成半合并态。扫描那道闸拦不到它 —— 所以执行前要再量一次。
   * 越过它的代价是把 `<<<<<<<` 提交进集成分支再送进用户的分支。
   */
  it('扫描之后工作区才变成半合并态的,执行时再量一次并停手', async () => {
    const pool = newPool()
    await pool.init()
    const [a, b] = await conflictingPair(pool)
    const deps = depsOf(pool, { resolve: async () => { /* 不该被叫到 */ } })
    await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], a.id), [a, b])
    // 计划是在乙的工作区还干净的时候算出来的。
    const plan = await scanSubtreeMerge(deps, [a, b], b.id)
    expect(plan.items).toHaveLength(1)
    // …然后别人把它留成了半合并态。
    await pool.mergeIntegrationIntoNode(b)

    const out = await runSubtreeMerge(deps, plan, [a, b])
    expect(out.merged).toEqual([])
    expect(out.failed[0]!.why).toContain('没解完的合并')
    const int = await git(['show', `${pool.integrationBranchName}:shared.txt`], gitRoot)
    expect(int.stdout).not.toContain('<<<<<<<')
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).not.toContain('<<<<<<<')
  })

  it('没有解冲突的人时,如实报告并保住分支', async () => {
    const pool = newPool()
    await pool.init()
    const [a, b] = await conflictingPair(pool)
    const deps = depsOf(pool)
    await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], a.id), [a, b])
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a, b], b.id), [a, b])
    expect(out.failed[0]!.why).toContain('没有可用的解冲突模型')
    expect(out.failed[0]!.followUps.some(f => f.includes('一个字节都没丢'))).toBe(true)
    const lines = subtreeMergeLines(await scanSubtreeMerge(deps, [a, b], b.id))
    expect(lines.some(l => l.startsWith('⚠') && l.includes('不会自动解决'))).toBe(true)
  })
})

describe('落盘与中止', () => {
  it('合完在 node.md 上留一句注记,而且连按两次也只留一句', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'x\n')
    const files = new Map<string, string>()
    const fs = {
      readFile: async (p: string) => files.get(p) ?? '',
      writeFile: async (p: string, d: string) => { files.set(p, d) },
      mkdir: async () => {},
      readdir: async () => [],
      exists: async (p: string) => files.has(p),
      rm: async () => {},
      stat: async () => ({ mtimeMs: 0 }),
    }
    const deps = depsOf(pool, { persist: { fs: fs as never, runDir: '/run' }, now: () => 'T1' })
    await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(a.execStatus).toContain('手动合并')
    expect([...files.keys()].some(k => k.includes('root/00-a'))).toBe(true)
    // 再来一次(此时已经没什么可合了,但注记路径要幂等)。
    await work(pool, a, 'a2.txt', 'y\n')
    await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(a.execStatus.match(/手动合并/g)).toHaveLength(1)
  })

  it('被中止时停在当前节点,并且说出「后面的没有动」', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'x\n')
    const ctl = new AbortController()
    ctl.abort()
    const deps = depsOf(pool, { signal: ctl.signal })
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(out.aborted).toBe(true)
    expect(out.merged).toEqual([])
    expect(out.trunk).toBeUndefined()
    expect(subtreeMergeResultLines(out).some(l => l.includes('被中断了'))).toBe(true)
  })
})

/**
 * **「全部捞回」的验收标准是一件都不漏,而漏项唯一的形态是「新增了一类,没人认领」。**
 *
 * 用户原话:「必须保证全部捞回。」这一组把那句话变成可以变红的断言。
 */
describe('覆盖完整性', () => {
  it('分类表里每一个「能合的」格子都有人认领', () => {
    const shouldMerge = STRANDED_KIND_LIST.filter(k => STRANDED_KINDS[k].action === 'merge')
    for (const k of shouldMerge) {
      expect(MERGE_KEY_COVERS).toContain(k)
    }
  })

  /** 反过来也要成立:认领表里不许出现分类表里没有的名字(改名之后会静默失联)。 */
  it('认领表里没有分类表之外的名字', () => {
    for (const k of MERGE_KEY_COVERS) expect(STRANDED_KIND_LIST).toContain(k)
  })

  /**
   * **每一格都要有人管 —— 不只是「能合的」那几格。**
   *
   * 上一版只断言 `action === 'merge'` 的格子,于是 `missing` / `integrateFail`
   * (用户原话里的「功能没有达标的」)被 `scanRescue` 静默丢掉时,这一组照样全绿:
   * `refOnly` 不收它们,而 notices 的判据写的是 `=== 'report'`,两边都不进。
   */
  it('分类表里每一格要么被合、要么被念出来', () => {
    for (const k of STRANDED_KIND_LIST) {
      expect(
        `${k}: ${MERGE_KEY_COVERS.includes(k) || MERGE_KEY_REPORTS.includes(k) ? '有人管' : '没人管'}`,
      ).toBe(`${k}: 有人管`)
    }
  })

  /** 「合并解决不了」那两格要指向 `b`,而不是混进「摆出来」那一堆。 */
  it('backtrack 那两格在念出来的表里', () => {
    for (const k of STRANDED_KIND_LIST.filter(x => STRANDED_KINDS[x].action === 'backtrack')) {
      expect(MERGE_KEY_REPORTS).toContain(k)
    }
  })
})

/**
 * **那些没有工作区目录、这个键在结构上看不见的产出。**
 *
 * `scanSubtreeMerge` 的主循环走 `childIds → pathFor(node)`,目录不在就一条都扫不到 ——
 * 而活恰恰最容易卡在没有目录的地方。跑机实测(etcd3)32 条工作树登记项里 **31 条**目录已不在。
 */
describe('没有工作区目录的那几类', () => {
  it('只剩分支的残留会被扫出来,并且合得回去', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-branchonly')
    const path = await work(pool, n, 'lost.ts', 'the lost work\n')
    // 目录清掉、分支留着 —— 跑机上最常见的那一种形状。
    await rm(path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)
    n.worktree = undefined

    const deps = depsOf(pool, {
      runId: '001',
      triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'merge' as const, why: '独有产出' })),
    })
    const plan = await scanSubtreeMerge(deps, [n], n.id)
    // 主循环看不见它(目录不在),它走的是捞那条路。
    expect(plan.items).toHaveLength(0)
    expect(plan.rescue?.merge.map(c => c.evidence.ref)).toEqual([pool.worktreeBranchOf(n)])

    const out = await runSubtreeMerge(deps, plan, [n])
    expect(out.failed).toEqual([])
    expect((await git(['show', `${pool.integrationBranchName}:lost.ts`], gitRoot)).stdout).toBe('the lost work\n')
  })

  /**
   * **缺料时要说「没查」,而不是渲染一个干净的空清单。**
   *
   * 空白和「没有」在屏幕上长得一模一样,而用户按 m 正是为了确认「还有没有东西没送到」。
   */
  it('没给 runId / worktreeRoot 时 rescue 是 undefined —— 那是「没查」', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-noscan')
    const plan = await scanSubtreeMerge(depsOf(pool), [n], n.id)
    expect(plan.rescue).toBeUndefined()
  })
})

/**
 * **「已合入」不等于「没东西了」** —— 用户第 8 条那句「要保证所有未提交的都要提交」
 * 正正落在这个桶上,而它此前对 `m` 完全不可见(`alreadyMerged` 那句早退排在数 loose 之前)。
 */
describe('已合入、但目录里还留着未提交内容', () => {
  it('照样进名单,而且真的被提交并合入', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-loose')
    const path = await work(pool, n, 'a.ts', 'first\n')
    expect((await pool.commitAndMerge(n)).ok).toBe(true)
    // 验收/测试席位在这棵树里留下的东西 —— 还没有被提交到任何分支上。
    await writeFile(join(path, 'left-behind.ts'), 'seat left this\n')

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [n], n.id)
    expect(plan.alreadyMerged).toBe(0)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.loose).toBe(1)
    expect(plan.items[0]!.commits).toBe(0)

    const out = await runSubtreeMerge(deps, plan, [n])
    expect(out.failed).toEqual([])
    expect((await git(['show', `${pool.integrationBranchName}:left-behind.ts`], gitRoot)).stdout)
      .toBe('seat left this\n')
  })

  it('目录干净、提交也全合入的才算「早就合过了」', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-clean')
    await work(pool, n, 'a.ts', 'x\n')
    await pool.commitAndMerge(n)
    const plan = await scanSubtreeMerge(depsOf(pool), [n], n.id)
    expect(plan.alreadyMerged).toBe(1)
    expect(plan.items).toEqual([])
  })
})

/**
 * **判据是「此刻在不在飞」,不是「状态是不是终态」。**
 *
 * 老判据把「引用已交回、目录留着」的那一类也挡掉了 —— 而那正是用户点名的
 * 「保留的工作区(仍有未合入的内容)」,没有任何自动路径会再来合它们。
 */
describe('在不在飞', () => {
  it('非终态但不在飞的节点照样合', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-planbase')
    n.status = 'PLANNING'
    await work(pool, n, 'plan-leftover.ts', 'left by the planner\n')
    const deps = depsOf(pool, { inFlight: [] })
    const plan = await scanSubtreeMerge(deps, [n], n.id)
    expect(plan.items).toHaveLength(1)
    expect(plan.skipped).toEqual([])
  })

  it('此刻在飞的节点一个字节都不碰', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-running')
    n.status = 'EXECUTING'
    await work(pool, n, 'half.ts', 'writing\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { inFlight: [n.id] }), [n], n.id)
    expect(plan.items).toEqual([])
    expect(plan.skipped[0]!.why).toContain('正在运行')
  })

  it('拿不到在飞集合时退回老判据,而且要说出来', async () => {
    const pool = newPool()
    await pool.init()
    const n = mk('root/x-unknown')
    n.status = 'EXECUTING'
    await work(pool, n, 'half.ts', 'writing\n')
    const plan = await scanSubtreeMerge(depsOf(pool), [n], n.id)
    expect(plan.items).toEqual([])
    expect(plan.skipped[0]!.why).toContain('拿不到')
  })
})

/**
 * **算出来了就必须上屏。**
 *
 * 扫描找得到、执行会真的去合,而确认屏一个字都没有 —— 那是「静默动手」,和静默清理、
 * 静默截断是同一类毛病。这一批尤其不能少:抢救分支和只剩分支的残留,用户多半根本不知道
 * 它们存在。
 */
describe('捞回那一批要出现在确认屏上', () => {
  it('要合的、不合的、以及孤儿目录各自成段', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/r-1', { title: '甲' })
    const path = await work(pool, a, 'lost.ts', 'x\n')
    await rm(path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)
    a.worktree = undefined

    const deps = depsOf(pool, {
      runId: '001',
      triage: async ev => ev.map(e => ({ ref: e.ref, verdict: 'merge' as const, why: '独有产出' })),
    })
    const text = subtreeMergeLines(await scanSubtreeMerge(deps, [a], a.id)).join('\n')
    expect(text).toContain('没有工作区目录')
    expect(text).toContain('独有产出')
    // 「合完分支照样保留」是这条路的承诺,不能只写在代码注释里。
    expect(text).toContain('照样保留')
  })

  it('分诊拿不准的只列出来,而且要数出「拿不准」几处', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/r-2', { title: '乙' })
    const path = await work(pool, a, 'lost.ts', 'x\n')
    await rm(path, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)
    a.worktree = undefined

    // 不给 triage —— 全部落「拿不准」。
    const text = subtreeMergeLines(await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)).join('\n')
    expect(text).toContain('不合')
    expect(text).toContain('拿不准')
  })

  /**
   * **「没查」和「查过了没有」要说两句不同的话。** 空白冒充「没有」是这份清单最坏的读法
   * —— 用户按 m 正是为了确认「还有没有东西没送到」。
   */
  it('缺少扫描所需信息时明说「这一格没查」', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/r-3', { title: '丙' })
    // 不给 runId → rescue 是 undefined
    const text = subtreeMergeLines(await scanSubtreeMerge(depsOf(pool), [a], a.id)).join('\n')
    expect(text).toContain('没有检查')
  })

  /**
   * 「查过了、确实没有」这一格要**每一样都给全**才成立 —— 少给一个接缝(例如目录探测),
   * 屏幕会照实说那一格没查。第一版夹具就漏了 `exists`,于是它断言的是一件当时并不成立的事。
   */
  it('查过了、确实没有 → 不印那句警告,也不印空标题', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/r-4', { title: '丁' })
    const deps = depsOf(pool, { runId: '001', exists: async () => false })
    const text = subtreeMergeLines(await scanSubtreeMerge(deps, [a], a.id)).join('\n')
    expect(text).not.toContain('没有检查')
    // 锚要精确到**捞回那一段的抬头**:「没有工作区目录」这几个字在既有文案里也出现
    // (「另有 N 个任务在盘上没有工作区目录」),按它断言等于什么都没断言。
    expect(text).not.toContain('另外捞回')
  })
})

/**
 * **「功能没达标」那两格:算出来了,就必须念出来。**
 *
 * 用户原话三段里的第三段(「功能没有达标的」)对应 `missing`(产出丢了)和
 * `integrateFail`(集成验收没通过)。它们的 action 是 `backtrack` —— 合并这条路对它们
 * 根本无效,而上一版 `scanRescue` 的 notices 判据写的是 `=== 'report'`,于是这两格
 * `refOnly` 不收、notices 也不收,被唯一的消费者算出来之后原样扔掉。
 */
describe('合并解决不了的那几项要指向 b', () => {
  /**
   * `integrateFail` 的判据是 `status === 'BLOCKED'` **且** acceptLog 里最后一条
   * `step: 'integrate'` 的裁决没通过(见 `lastIntegrateFailed`)。缺 `step` 的老记录
   * 谁的历史都不算 —— 那正是它专门挡的东西。
   */
  const mkFail = (id: string): TaskNode => {
    const n = mk(id, { title: '甲' })
    n.status = 'BLOCKED'
    n.acceptLog = [{
      step: 'integrate', at: 'T0', round: 1, verdicts: [],
      synthesized: { pass: false, blocking: ['产出对不上'], comments: '' },
    }] as never
    return n
  }

  it('集成验收没通过 → 屏幕上明说「合并解决不了,按 b 回溯」', async () => {
    const pool = newPool()
    await pool.init()
    const a = mkFail('root/00-a')
    await work(pool, a, 'a.txt', 'hello\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    const t = subtreeMergeLines(plan).join('\n')
    expect(t).toContain('合并解决不了')
    expect(t).toContain('按 b 回溯')
    /**
     * **逐条列出来,不只是数一个数。** 用户要知道是**哪几个任务**没达标 —— 这几条正是
     * `notices` 那一路(判据是「不是 merge」而不是「是 report」;写成后者的话这两格
     * 两边都不进,屏幕上只剩一句没有主语的总数)。
     */
    expect(t).toContain('甲:集成验收没通过')
  })

  it('没有这类项时一个字都不多说', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    expect(subtreeMergeLines(plan).join('\n')).not.toContain('合并解决不了')
  })
})

/**
 * **「先 stash 再合」那一档 —— 用户按一下才开。**
 *
 * 用户原话:「提供选项,但要你按一下」;「检测到脏就自动 stash」那一档他明确否决过。
 * 真正的正确性住在 `stashGuard`(独立原语,14 条真 git 探针),这里钉的是接线:
 * 默认关、开了才包住第 2 跳、而且撞上时用户的改动真的回来了。
 */
describe('第 2 跳的 stash 那一档', () => {
  /** 造一个「脏文件正好被这次合并改到」的现场:不开这一档,git 会拒绝。 */
  const collide = async (pool: WorktreePool) => {
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'shared.txt', '来自任务\n')
    await writeFile(join(gitRoot, 'shared.txt'), '我正在改\n')
    return a
  }

  it('默认不开 → git 拒绝,改动原样在,而且屏幕点名文件', async () => {
    const pool = newPool()
    await pool.init()
    const a = await collide(pool)
    const deps = depsOf(pool, { runId: '001' })
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    // 脏不再阻断,只是被记下来,并把那一档摆出来。
    expect(plan.trunk.blocked).toBeUndefined()
    expect(plan.trunk.dirty).toContain('shared.txt')
    expect(subtreeMergeLines(plan).join('\n')).toContain('按 s')

    const out = await runSubtreeMerge(deps, plan, [a])
    expect(out.trunk?.ok).toBe(false)
    expect(out.trunk?.message ?? '').toContain('shared.txt')
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).toBe('我正在改\n')
  })

  /** 脏文件和这次合并**不相交**:合得上,改动原样回到工作区,不留任何痕迹。 */
  it('开了 + 脏文件不相交 → 合得上,改动原样放回,且不留 stash', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    await writeFile(join(gitRoot, 'shared.txt'), '我正在改\n')

    const deps = depsOf(pool, { runId: '001', stash: true })
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(out.trunk?.ok).toBe(true)
    expect(await readFile(join(gitRoot, 'a.txt'), 'utf-8')).toBe('hello\n')
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).toBe('我正在改\n')
    expect((await git(['stash', 'list'], gitRoot)).stdout.trim()).toBe('')
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup/001'], gitRoot)).stdout.trim()).toBe('')
  })

  /**
   * **真撞车时 pop 一定会冲突** —— 这是这一档最该说实话的一格,不是失败,是「合并做完了,
   * 但你的改动放回来时和它撞上了」。两处都留着,而且屏幕要把取回命令写全。
   */
  it('开了 + 脏文件正好撞上 → 合得上,而改动两处都还在(不许吞)', async () => {
    const pool = newPool()
    await pool.init()
    const a = await collide(pool)
    const deps = depsOf(pool, { runId: '001', stash: true })
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])

    /**
     * **不是绿色的「完成」。** 合并确实做完了,但用户的检出里现在带着冲突标记 ——
     * 只看 `syncTrunk` 的成败会让面板标题变绿,而那六条说明排在最末尾、不是警告色、
     * 矮终端下最先被裁掉。
     */
    expect(out.trunk?.ok).toBe(false)
    expect(out.trunk?.message ?? '').toContain('撞了冲突')
    expect(out.trunk?.message ?? '').toContain('一个字节都没丢')
    const t = (out.trunk?.followUps ?? []).join('\n')
    expect(t).toContain('一个字节都没丢')
    expect(t).toContain('git stash drop')
    expect(t).toContain('git stash apply refs/et/stash-backup/001/')
    // 两处都真的在。
    expect((await git(['stash', 'list'], gitRoot)).stdout).toContain('et: 自动 stash(001)')
    // 备份 ref 现在带内容 sha(见 stashGuard 的 P0 注释),按前缀找。
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup/001'], gitRoot)).stdout.trim().length).toBeGreaterThan(0)
  })

  /** 不脏的那一趟开着它也无害:什么都没 stash,照常合。 */
  it('树本来就干净 → 开着也不出事', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    const deps = depsOf(pool, { runId: '001', stash: true })
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(out.trunk?.ok).toBe(true)
    expect((await git(['stash', 'list'], gitRoot)).stdout.trim()).toBe('')
  })
})

/**
 * **「只剩构建产物」的保留工作区:结束屏说它「未回收」,而 `m` 合不了它。**
 *
 * `handoff().kept` 用的是 `status --porcelain --ignored`,`m` 这一路用的是不带 `--ignored`
 * 的那一份。于是用户读到「保留的工作区(…未回收): /path」→ 按 `m` → 一屏「没有需要合并
 * 的工作区」,而那句「⚠ 被 .gitignore 忽略的文件不会被提交」又被 `items.some(loose>0)`
 * 门控住,一个字都不印。他拿到的是一屏静默的「没事」。
 */
describe('只剩构建产物的保留工作区', () => {
  it('m 这一屏要自己说清:合不了,要腾空间按 c', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    expect((await pool.commitAndMerge(a)).ok).toBe(true)
    /**
     * 合完之后目录里只剩被忽略的构建产物。忽略规则写进 `$GIT_COMMON_DIR/info/exclude` ——
     * 它对 linked worktree 同样生效(真 git 实测),而在工作区里提交一个 `.gitignore`
     * 会让这个节点重新变成「有没合入的提交」,那就不是这一格要测的形态了。
     */
    const dir = pool.worktreePathOf(a)
    await mkdir(join(gitRoot, '.git', 'info'), { recursive: true })
    await writeFile(join(gitRoot, '.git', 'info', 'exclude'), 'build/\n')
    await mkdir(join(dir, 'build'), { recursive: true })
    await writeFile(join(dir, 'build', 'big.o'), 'x'.repeat(64))
    // `status --porcelain` 看不见它,`--ignored` 看得见 —— 这一格的全部前提。
    expect((await git(['status', '--porcelain'], dir)).stdout.trim()).toBe('')
    expect((await git(['status', '--porcelain', '--ignored'], dir)).stdout).toContain('build/')

    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    const t = subtreeMergeLines(plan).join('\n')
    expect(plan.ignoredOnly).toBeGreaterThan(0)
    expect(t).toContain('只剩构建产物')
    expect(t).toContain('按 c')
    // 那句「不会被提交」也要出现 —— 它此前被 items 门控住了。
    expect(t).toContain('不会**被提交')
  })

  it('目录里真的什么都没有时,一个字都不多说', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    await pool.commitAndMerge(a)
    const plan = await scanSubtreeMerge(depsOf(pool, { runId: '001' }), [a], a.id)
    expect(plan.ignoredOnly).toBe(0)
    expect(subtreeMergeLines(plan).join('\n')).not.toContain('只剩构建产物')
  })
})


/**
 * **「先 stash」那一步自己失败时,绝不能把合并照跑掉。**
 *
 * 用户按 `s` 表达的是「我要那层保护」。上一版一律 `?? await runSync()`,于是保护被静默
 * 取消,而 `syncTrunk` 随后在一个已经出问题的仓库上重试三轮,最后报「你在同步期间反复
 * 提交,重试 3 次仍未合上」—— 一句用户一次提交都没做过的假原因。
 */
describe('stash 那一步失败 → 这一跳不许执行', () => {
  /**
   * **判据接在哪一层要说清。** 「用户的检出卡在一次没做完的合并里」这个状态,在整条
   * `runSubtreeMerge` 流水线上活不到第 2 跳(中间几步会把现场收拾掉),所以这一条把
   * MERGE_HEAD 这一问**在 git 这一层注入**——它正是 `stashAvailability` 唯一读的东西。
   * `withStash` 自己那一侧的真 git 覆盖在 `stashGuard.test.ts`(前置不可用 / create 失败)。
   */
  it('withStash 报 failed → 这一跳不执行,而且不许说「反复提交」', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    const base = depsOf(pool, { runId: '001', stash: true })
    const deps = {
      ...base,
      git: async (args: string[], cwd: string) =>
        args[0] === 'rev-parse' && args.includes('MERGE_HEAD') && cwd === gitRoot
          ? { code: 0, stdout: 'deadbeef\n', stderr: '' }
          : base.git(args, cwd),
    }
    const out = await runSubtreeMerge(deps, await scanSubtreeMerge(deps, [a], a.id), [a])
    expect(out.trunk?.ok).toBe(false)
    const t = `${out.trunk?.message ?? ''}\n${(out.trunk?.followUps ?? []).join('\n')}`
    expect(t).toContain('没做完的合并')
    expect(t).toContain('--abort')
    // **那句假原因绝不许出现。**
    expect(t).not.toContain('反复提交')
    // 「没有执行」要说的是**这一跳**没跑,不是「产出没到」—— 逐任务自动投递可能早就把它
    // 送过去了(E 节之后那条路不再被脏树挡住)。所以判据落在这一跳自己的措辞上。
    expect(t).toContain('这一跳没有执行')
  })
})

/**
 * **被扣下的 ref 必须出现在结果屏上,而且要能被界面看见。**
 *
 * `runRescue` 是唯一把 `plan.problems` 抄进 `out.problems` 的地方,而它只在有东西要合的
 * 时候才跑。于是全部落 `hold` 的那一趟(生产上最常见:模型回 unsure,而没被模型提到的
 * 也算 unsure)结果屏是一句无保留的成功 —— 而记录正在这一刻被抹掉(见 efftask.tsx 的
 * `heldBack`)。
 */
describe('全部被扣下时,结果屏不许是一句无保留的成功', () => {
  it('hold 的每一条都念出来,而且 outcome 带得出 rescue 计划', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    await pool.commitAndMerge(a)
    // 造一条抢救分支:它不在集成分支上,而 triage 缺席 → 全部落 hold。
    await git(['branch', 'efftask/001/salvage/x', pool.worktreeBranchOf(a)], gitRoot)
    await git(['commit', '--allow-empty', '-qm', 'extra'], gitRoot)
    await git(['branch', '-f', 'efftask/001/salvage/x', 'HEAD'], gitRoot)

    const deps = depsOf(pool, { runId: '001' })
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    const out = await runSubtreeMerge(deps, plan, [a])
    if ((plan.rescue?.hold.length ?? 0) === 0) return // 这一趟没造出 hold,不做假断言
    // 界面据它决定要不要留住 pendingHandoff —— 缺了它就是第二个「按 q 之后永久失联」。
    expect(out.rescue?.hold.length).toBe(plan.rescue?.hold.length)
    const t = subtreeMergeResultLines(out).join('\n')
    for (const h of plan.rescue?.hold ?? []) {
      expect(t).toContain(h.item.branch ?? h.item.path ?? h.item.title ?? '')
    }
    expect(t).toContain('一个字节都没丢')
  })
})
