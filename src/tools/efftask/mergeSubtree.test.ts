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
  type SubtreeMergeDeps,
} from './mergeSubtree.js'
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
  pool, git, ...over,
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
    const plan = await scanSubtreeMerge(depsOf(pool), [a], a.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.skipped[0]!.why).toContain('还没跑完')
  })

  it('被阻断的节点**要合** —— 它正是这个键的主要服务对象', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲', status: 'BLOCKED', mergeConflict: true })
    await work(pool, a, 'a.txt', 'a\n')
    const plan = await scanSubtreeMerge(depsOf(pool), [a], a.id)
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
    const plan = await scanSubtreeMerge(depsOf(pool), [a], a.id)
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
    // 用户的检出脏着 —— 逐任务合并会合进集成分支,但送不到 main。
    await writeFile(join(gitRoot, 'shared.txt'), 'dirty\n')
    expect((await pool.commitAndMerge(a)).ok).toBe(true)
    expect(await Bun.file(join(gitRoot, 'a.txt')).exists()).toBe(false)
    // 用户收拾干净之后再按 m。
    await git(['checkout', '--', 'shared.txt'], gitRoot)

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    expect(plan.items).toHaveLength(0)
    expect(plan.trunk.pending).toBe(1)
    const out = await runSubtreeMerge(deps, plan, [a])
    expect(out.trunk?.ok).toBe(true)
    expect(await readFile(join(gitRoot, 'a.txt'), 'utf-8')).toBe('hello\n')
  })

  it('工作区脏时**不合**,而且如实说出来', async () => {
    const pool = newPool()
    await pool.init()
    const a = mk('root/00-a', { title: '甲' })
    await work(pool, a, 'a.txt', 'hello\n')
    await writeFile(join(gitRoot, 'shared.txt'), 'dirty\n')

    const deps = depsOf(pool)
    const plan = await scanSubtreeMerge(deps, [a], a.id)
    expect(plan.trunk.blocked).toContain('未提交的改动')
    expect(subtreeMergeLines(plan).some(l => l.startsWith('⚠') && l.includes('未提交的改动'))).toBe(true)
    const out = await runSubtreeMerge(deps, plan, [a])
    // 第一跳照做(产出进了集成分支),第二跳如实报告没做。
    expect(out.merged).toHaveLength(1)
    expect(out.trunk?.ok).toBe(false)
    expect(await readFile(join(gitRoot, 'shared.txt'), 'utf-8')).toBe('dirty\n')
    expect(subtreeMergeResultLines(out).some(l => l.startsWith('⚠'))).toBe(true)
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
