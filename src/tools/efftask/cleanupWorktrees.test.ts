/**
 * 回收已完成工作区 —— 对着**真的 git**测。
 *
 * 和 worktreePool.test.ts 同一个理由,而且更硬:这条路会 `worktree remove --force`,
 * 一个假 GitRunner 会对「--force 到底删不删得掉带构建产物的工作树」点头,而那正是这个
 * 功能存在的全部理由(`release()` 在同一个输入上是拒绝的)。每条用例都注明它钉住的那次
 * 实测。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import {
  cleanupLines, cleanupResultLines, cleanupScope, formatSize, runCleanup, scanCleanup,
  type CleanupDeps,
} from './cleanupWorktrees.js'
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
  const base = await mkdtemp(join(tmpdir(), 'efftask-clean-'))
  roots.push(base)
  gitRoot = join(base, 'repo')
  worktreeRoot = join(base, 'wt')
  await mkdir(gitRoot, { recursive: true })
  await mkdir(worktreeRoot, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], gitRoot)
  await git(['config', 'user.email', 's@s'], gitRoot)
  await git(['config', 'user.name', 's'], gitRoot)
  await writeFile(join(gitRoot, '.gitignore'), 'target/\n')
  await writeFile(join(gitRoot, 'base.txt'), 'base\n')
  await git(['add', '-A'], gitRoot)
  await git(['commit', '-qm', 'base'], gitRoot)
}

const pool = () => createWorktreePool({ runId: '001', gitRoot, git, worktreeRoot })

const depsOf = (p: ReturnType<typeof pool>, over: Partial<CleanupDeps> = {}): CleanupDeps => ({
  git,
  gitRoot: p.gitRoot,
  integrationBranch: p.integrationBranchName,
  pathFor: n => p.worktreePathOf(n),
  branchFor: n => p.worktreeBranchOf(n),
  ...over,
})

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('cleanupScope —— 谁在范围里', () => {
  const tree = (): TaskNode[] => [
    node('root', { childIds: ['a', 'b'], status: 'ACCEPTED' }),
    node('a', { parentId: 'root', childIds: ['a1'], status: 'ACCEPTED' }),
    node('a1', { parentId: 'a', status: 'ACCEPTED' }),
    node('b', { parentId: 'root', status: 'EXECUTING' }),
    // 血统之外,状态一样是 ACCEPTED —— 它是这条判据唯一会犯的错的形状。
    node('outside', { status: 'ACCEPTED' }),
  ]

  it('自己 + 全部子孙,递归下去', () => {
    const s = cleanupScope(tree(), 'root')
    expect(s.done.map(n => n.id).sort()).toEqual(['a', 'a1', 'root'])
    // 血统之外的那个不在里面,哪怕它也已验收。
    expect(s.done.some(n => n.id === 'outside')).toBe(false)
  })

  it('只认 ACCEPTED —— 没验收的算进「跳过」而不是删掉', () => {
    const s = cleanupScope(tree(), 'root')
    expect(s.unfinished).toBe(1)
    expect(s.done.some(n => n.id === 'b')).toBe(false)
  })

  it('BLOCKED 不算完成 —— 它的工作区正是升级卡让用户去解冲突的那个现场', () => {
    const s = cleanupScope([node('root', { childIds: ['x'] }), node('x', { parentId: 'root', status: 'BLOCKED' })], 'root')
    expect(s.done).toEqual([])
    expect(s.unfinished).toBe(2)
  })

  it('自指的 childIds 不会死循环(盘上那份是可手工编辑的,而这跑在按键处理里)', () => {
    const s = cleanupScope([node('root', { childIds: ['root'], status: 'ACCEPTED' })], 'root')
    expect(s.done.map(n => n.id)).toEqual(['root'])
  })
})

describe('scanCleanup / runCleanup against real git', () => {
  it('删得掉一个只剩构建产物的工作区 —— 而 release() 在同一个输入上是拒绝的', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    const path = (lease as { path: string }).path
    n.worktree = { branch: (lease as { branch: string }).branch, path }
    await writeFile(join(path, 'src.txt'), 'work\n')
    expect((await p.commitAndMerge(n)).ok).toBe(true)
    // 验收席位在这棵树里跑了一次构建:被忽略的产物 + 一个被改写的已跟踪文件。
    await mkdir(join(path, 'target'), { recursive: true })
    await writeFile(join(path, 'target', 'big.bin'), 'x'.repeat(4096))
    await writeFile(join(path, 'base.txt'), 'touched by the build\n')

    // 这正是用户看到的现状:收口时 dispose() 走过一遍,而 release 拒绝删。
    expect((await p.release(n)).removed).toBe(false)

    const deps = depsOf(p, { dirSizeKb: async () => 12 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toHaveLength(1)
    // 被忽略的产物必须出现在「会被一并删掉」里 —— 不带 --ignored 的话确认屏会对着一个
    // target/ 说「没有未提交的内容」。
    expect(plan.items[0]!.leftoverCount).toBeGreaterThanOrEqual(2)
    expect(plan.items[0]!.leftovers.join(' ')).toContain('target/')
    expect(plan.totalKb).toBe(12)

    const branch = n.worktree!.branch
    const out = await runCleanup(deps, plan, [n])
    expect(out.failed).toEqual([])
    expect(out.removed).toHaveLength(1)
    expect(out.freedKb).toBe(12)
    expect(await exists(path)).toBe(false)
    // 分支也回收了(它已经被集成分支包含,留着只会堆在 git branch 里)。
    expect((await git(['rev-parse', '--verify', '--quiet', branch], gitRoot)).code).not.toBe(0)
  })

  it('产出仍然在集成分支上 —— 删的是工作区,不是工作', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    await writeFile(join((lease as { path: string }).path, 'src.txt'), 'work\n')
    await p.commitAndMerge(n)
    const deps = depsOf(p)
    await runCleanup(deps, await scanCleanup(deps, [n], n.id), [n])
    const show = await git(['show', `${p.integrationBranchName}:src.txt`], gitRoot)
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('work')
  })

  it('有未合入的提交就保留 —— 这是唯一的硬闸', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    const path = (lease as { path: string }).path
    // 节点自己提交了,但没有合进集成分支(验收通过后合并失败的那种形态)。
    await writeFile(join(path, 'unmerged.txt'), 'not merged\n')
    await git(['add', '-A'], path)
    await git(['commit', '-qm', 'local'], path)

    const deps = depsOf(p)
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])
    expect(plan.kept).toHaveLength(1)
    expect(plan.kept[0]!.why).toContain('未合入')
    // 摸都别摸。
    const out = await runCleanup(deps, plan, [n])
    expect(out.removed).toEqual([])
    expect(await exists(path)).toBe(true)
  })

  it('探测失败(不是「没合入」)要说自己没探明白,并且同样保留', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    await p.acquire(n)
    // `--is-ancestor` 用 1 表示「不是祖先」,128 表示它自己出错了。判据只看 `!== 0` 的话,
    // 一个坏掉的仓库会被说成「你还有东西没合」——而两句话要用户做的事完全不同。
    const deps = depsOf(p, {
      git: async (args, cwd) => (
        args[0] === 'merge-base' ? { code: 128, stdout: '', stderr: 'fatal: bad object' } : git(args, cwd)
      ),
    })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])
    expect(plan.kept[0]!.why).toContain('无法判断')
    expect(plan.kept[0]!.why).toContain('bad object')
  })

  it('工作区目录不存在时既不删也不报错,只计入「盘上没有」', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const plan = await scanCleanup(depsOf(p), [n], n.id)
    expect(plan.items).toEqual([])
    expect(plan.kept).toEqual([])
    expect(plan.absent).toBe(1)
  })

  it('删完把 node.md 里那条工作区记录也抹掉 —— 别指着一个不存在的目录', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    n.worktree = { branch: (lease as { branch: string }).branch, path: (lease as { path: string }).path }
    await p.commitAndMerge(n)

    const runDir = join(roots[roots.length - 1]!, 'run')
    const written = new Map<string, string>()
    const fs = {
      readFile: async (f: string) => written.get(f) ?? '',
      writeFile: async (f: string, d: string) => { written.set(f, d) },
      mkdir: async () => {},
      mkdirExclusive: async () => true,
      unlink: async () => {},
      rmdir: async () => {},
      rename: async () => {}, appendFile: async () => {},
      readdir: async () => [],
      exists: async () => true,
    }
    const deps = depsOf(p, { persist: { fs, runDir } })
    const out = await runCleanup(deps, await scanCleanup(deps, [n], n.id), [n])
    expect(out.removed).toHaveLength(1)
    // 就地清掉:界面和编排器持有的是同一批节点对象,造新对象会被编排器下一次推送覆盖。
    expect(n.worktree).toBeUndefined()
    const md = [...written.values()].join('\n')
    expect(md.length).toBeGreaterThan(0)
    expect(md).not.toContain('.efftask-worktrees')
    // 任务记录本身没被删:状态、标题还在盘上那份里。
    expect(md).toContain('ACCEPTED')
  })

  it('工作区删不掉时不去删它的分支,并把 git 的原话报出来', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    await p.acquire(n)
    const deps = depsOf(p, {
      git: async (args, cwd) => (
        args[0] === 'worktree' && args[1] === 'remove'
          ? { code: 1, stdout: '', stderr: 'fatal: working tree is locked' }
          : git(args, cwd)
      ),
    })
    const plan = await scanCleanup(deps, [n], n.id)
    const out = await runCleanup(deps, plan, [n])
    expect(out.removed).toEqual([])
    expect(out.failed[0]!.why).toContain('locked')
    // 分支还在 —— 删了它,一个还留着目录的工作区会更难救。
    expect((await git(['rev-parse', '--verify', '--quiet', p.worktreeBranchOf(n)], gitRoot)).code).toBe(0)
  })

  it('集成工作区不在任何一次清理的范围里', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    await p.acquire(n)
    await p.commitAndMerge(n)
    const deps = depsOf(p)
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items.map(i => i.path)).not.toContain(p.integrationPath)
    await runCleanup(deps, plan, [n])
    expect(await exists(p.integrationPath)).toBe(true)
  })
})

describe('屏幕上的每一行', () => {
  const planWith = (over: Partial<Parameters<typeof cleanupLines>[0]> = {}) => cleanupLines({
    targetId: 'root', items: [], kept: [], unfinished: 0, absent: 0, totalKb: 0, sizeKnown: false,
    logs: [], logKb: 0, logSizeKnown: false,
    scratch: [], scratchKb: 0, scratchSizeKnown: false, ...over,
  })

  it('说得出删几个、腾多少', () => {
    const lines = planWith({
      items: [{ nodeId: 'a', title: '建表', path: '/w/a', branch: 'b', sizeKb: 2 * 1024 * 1024, leftovers: ['!! target/'], leftoverCount: 7 }],
      totalKb: 2 * 1024 * 1024, sizeKnown: true,
    })
    expect(lines[0]).toContain('1 个')
    expect(lines[0]).toContain('2.0 GB')
    expect(lines.join('\n')).toContain('连带删除 7 项')
  })

  it('量不到大小时说出来,而不是印一个 0', () => {
    const lines = planWith({
      items: [{ nodeId: 'a', title: '建表', path: '/w/a', branch: 'b', leftovers: [], leftoverCount: 0 }],
      sizeKnown: false,
    })
    expect(lines.join('\n')).toContain('量不到大小')
    expect(lines.join('\n')).not.toContain('0 KB')
  })

  it('总要逐条点名什么不会被动 —— 那是用户唯一真正担心的事', () => {
    expect(planWith().join('\n')).toContain('node.md')
    expect(planWith().join('\n')).toContain('state.jsonl')
  })

  it('保留和跳过各自摆出来,不合并成一个数', () => {
    const lines = planWith({
      kept: [{ nodeId: 'a', title: '建表', path: '/w/a', why: '仍有未合入集成分支的提交' }],
      unfinished: 3, absent: 2,
    })
    const text = lines.join('\n')
    expect(text).toContain('保留 1 个')
    expect(text).toContain('未合入')
    expect(text).toContain('跳过 3 个')
    expect(text).toContain('2 个已验收任务在盘上没有工作区目录')
  })

  it('结果屏对「一个都没删掉」不说成功', () => {
    const text = cleanupResultLines({
      removed: [], failed: [{ nodeId: 'a', title: '建表', path: '/w/a', why: 'locked' }],
      problems: [], freedKb: 0, sizeKnown: false,
      logsRemoved: 0, logsFreedKb: 0,
      scratchRemoved: 0, scratchFreedKb: 0, integrationCleaned: false, integrationFreedKb: 0,
    }).join('\n')
    expect(text).toContain('没有删除任何工作区')
    expect(text).toContain('⚠ 建表 没删掉')
    // 这一格没做的两件事一个字都不许印 —— 「已删除 0 个」读起来像一次成功的空操作。
    expect(text).not.toContain('临时目录')
    expect(text).not.toContain('构建产物')
  })

  /**
   * 临时目录那一行**必须点名它在项目之外**:用户看着一屏「回收工作区」,而这一条删的是
   * `/tmp`。变异:把 `cleanupLines` 里 scratch 那一段删掉 → 这条红。
   */
  it('临时目录那一段说得出在哪、有多少', () => {
    const text = planWith({
      scratch: [{ path: '/tmp/efftask-001-0184c778-target', kb: 1024 * 1024 }],
      scratchKb: 1024 * 1024, scratchSizeKnown: true,
    }).join('\n')
    expect(text).toContain('临时目录')
    expect(text).toContain('1 个')
    expect(text).toContain('1.0 GB')
  })

  /**
   * 集成工作区那两行:**说清代价**(全量重编),并且**说清目录本身留着**。
   * 只印「腾出 22 GB」而不说要重编,是拿一句半真话换一次按键。
   */
  it('集成工作区:清产物、留目录、说出重编的代价', () => {
    const text = planWith({
      integration: { path: '/w/integration', entries: ['target/'], entryCount: 1, kb: 22 * 1024 * 1024 },
    }).join('\n')
    expect(text).toContain('构建产物')
    expect(text).toContain('22 GB')
    expect(text).toContain('全量重编')
    expect(text).toContain('本身保留')
  })

  /** 没有可清产物时,那句话要改口 —— 不能一直印着「只清掉它里面的构建产物」。 */
  it('集成工作区没东西可清时,措辞跟着改', () => {
    const text = planWith().join('\n')
    expect(text).toContain('本身保留')
    expect(text).toContain('没有可清的构建产物')
    expect(text).not.toContain('全量重编')
  })

  it('大小的量纲', () => {
    expect(formatSize(undefined)).toBe('大小未知')
    expect(formatSize(512)).toBe('512 KB')
    expect(formatSize(1536)).toBe('1.5 MB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 GB')
  })
})

/**
 * 用户原话:「1, 绝对不能删除任务的基本信息和状态,以及各阶段结果状态。」
 *
 * 这一档钉的是**边界**,不是功能:`c` 删事件日志,而 `node.md` / `state.jsonl`
 * 一个字节都不许动。三条断言分开写 —— 合成一句「只删了日志」在实现把 node.md 也删掉时
 * 同样是绿的(它只断言日志没了)。
 */
describe('c 键的删除边界', () => {
  const memFs = (): FsLike & { store: Map<string, string> } => {
    const store = new Map<string, string>()
    return {
      store,
      async readFile(p) { const v = store.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
      async writeFile(p, d) { store.set(p, d) },
      async appendFile(p, d) { store.set(p, (store.get(p) ?? '') + d) },
      async mkdir() {}, async mkdirExclusive() { return true },
      async unlink(p) { store.delete(p) },
      async rmdir() {},
      async rename(a, b) { const v = store.get(a)!; store.set(b, v); store.delete(a) },
      async readdir() { return [] },
      async exists(p) { return store.has(p) },
    }
  }

  it('删事件日志,而 node.md 和 state.jsonl 原样留着', async () => {
    const p = pool()
    await p.init()
    const n = node('root', { status: 'ACCEPTED' })
    const { path } = await p.acquire(n)
    await writeFile(join(path, 'f.txt'), 'done\n')
    expect((await p.commitAndMerge(n)).ok).toBe(true)

    const fs = memFs()
    fs.store.set('/run/root/node.md', '---\nid: root\n---\n')
    fs.store.set('/run/root/state.jsonl', '{"t":"f","at":"x","d":{}}\n')
    fs.store.set('/run/root/agent-log.jsonl', 'x'.repeat(4096))

    const deps = depsOf(p, { persist: { fs, runDir: '/run' }, dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.logs.map(l => l.nodeId)).toEqual(['root'])

    const out = await runCleanup(deps, plan, [n])
    expect(out.logsRemoved).toBe(1)
    expect(fs.store.has('/run/root/agent-log.jsonl')).toBe(false)
    // **这两条是这一档存在的全部理由。**
    expect(fs.store.has('/run/root/node.md')).toBe(true)
    expect(fs.store.has('/run/root/state.jsonl')).toBe(true)
  })

  it('确认屏必须把这件事说出来 —— 静默删除和静默截断是同一类毛病', async () => {
    const p = pool()
    await p.init()
    const n = node('root', { status: 'ACCEPTED' })
    const { path } = await p.acquire(n)
    await writeFile(join(path, 'f.txt'), 'done\n')
    await p.commitAndMerge(n)

    const fs = memFs()
    fs.store.set('/run/root/agent-log.jsonl', 'x'.repeat(4096))
    const deps = depsOf(p, { persist: { fs, runDir: '/run' }, dirSizeKb: async () => 4 })
    const text = cleanupLines(await scanCleanup(deps, [n], n.id)).join('\n')
    expect(text).toContain('agent-log.jsonl')
    expect(text).toContain('node.md')
    expect(text).toContain('state.jsonl')
  })

  it('没有 persist 接缝时一个文件都不删 —— 老调用点逐字不变', async () => {
    const p = pool()
    await p.init()
    const n = node('root', { status: 'ACCEPTED' })
    await p.acquire(n)
    const deps = depsOf(p)
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.logs).toEqual([])
    expect((await runCleanup(deps, plan, [n])).logsRemoved).toBe(0)
  })
})

/**
 * 探针补洞:变异测试抓到「日志名单挂在 items 上」时全绿 —— 说明没有任何用例
 * 区分得了 `done` 和 `items`。而这正是 CleanupPlan.logs 那段注释讲的事:
 * 一个**工作区早就被清过**的已验收节点(`absent`),日志照样躺在盘上几 MB,
 * 而它恰恰是最该被清的那一批。
 */
describe('日志名单走 done 全体,不走 items', () => {
  it('工作区已经不在的已验收节点,日志照样进名单并被删掉', async () => {
    const p = pool()
    await p.init()
    const n = node('root', { status: 'ACCEPTED' })
    // **不 acquire** —— 盘上根本没有这个节点的工作区目录,scanCleanup 会把它记成 absent。
    const fs: FsLike & { store: Map<string, string> } = (() => {
      const store = new Map<string, string>()
      return {
        store,
        async readFile(x) { const v = store.get(x); if (v === undefined) throw new Error('ENOENT'); return v },
        async writeFile(x, d) { store.set(x, d) },
        async appendFile(x, d) { store.set(x, (store.get(x) ?? '') + d) },
        async mkdir() {}, async mkdirExclusive() { return true },
        async unlink(x) { store.delete(x) },
        async rmdir() {},
        async rename(a, b) { const v = store.get(a)!; store.set(b, v); store.delete(a) },
        async readdir() { return [] },
        async exists(x) { return store.has(x) },
      }
    })()
    fs.store.set('/run/root/agent-log.jsonl', 'x'.repeat(4096))

    const deps = depsOf(p, { persist: { fs, runDir: '/run' }, dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    // 工作区那份名单是空的(目录不在)……
    expect(plan.items).toEqual([])
    expect(plan.absent).toBe(1)
    // ……而日志那份**不是**。挂在 items 上的话这里会是 []。
    expect(plan.logs.map(l => l.nodeId)).toEqual(['root'])
    const out = await runCleanup(deps, plan, [n])
    expect(out.logsRemoved).toBe(1)
    expect(fs.store.has('/run/root/agent-log.jsonl')).toBe(false)
  })
})

/**
 * **磁盘被撑爆的那两个大头,`c` 键现在都管。**
 *
 * 跑机实测(qianbase-xtp run 001,盘 100% 满、`/` 只剩 1.7 MB,84 次
 * `ENOSPC: no space left on device`):
 *  - `.efftask-worktrees/integration/target` 一个人 22 GB —— 它是**唯一**不随节点回收
 *    走掉的构建产物,因为集成工作区被复用,永远不会被 `worktree remove`;
 *  - 系统临时目录里 141 个条目、23 GB,最老的躺了 8 天 —— 席位自己写出去的,
 *    工作树删掉时一个都不跟着走。
 */
describe('集成工作区的构建产物', () => {
  it('清掉 target/,而目录本身和未被忽略的文件都留着', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    await writeFile(join((lease as { path: string }).path, 'src.txt'), 'work\n')
    await p.commitAndMerge(n)

    // 集成工作区里跑过构建:target/ 被 .gitignore 忽略,conflict.txt 只是未跟踪。
    await mkdir(join(p.integrationPath, 'target'), { recursive: true })
    await writeFile(join(p.integrationPath, 'target', 'big.bin'), 'x'.repeat(4096))
    await writeFile(join(p.integrationPath, 'conflict.txt'), '<<<<<<< 现场\n')

    const deps = depsOf(p, { integrationPath: p.integrationPath, dirSizeKb: async () => 12 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.integration?.entryCount).toBeGreaterThanOrEqual(1)
    expect(plan.integration?.entries.join(' ')).toContain('target/')

    const out = await runCleanup(deps, plan, [n])
    expect(out.integrationCleaned).toBe(true)
    expect(await exists(join(p.integrationPath, 'target'))).toBe(false)
    // 目录本身留着 —— 下一次收口和每一次合并都在它里面发生。
    expect(await exists(p.integrationPath)).toBe(true)
    // 未跟踪但**没被忽略**的文件一个都不碰:那可能是一次正在进行的冲突解决现场。
    // 变异:把 runCleanup 里的 `-X` 换成 `-x` → 这条红。
    expect(await exists(join(p.integrationPath, 'conflict.txt'))).toBe(true)
  })

  it('没给 integrationPath 就完全不碰它(旧行为)', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    await p.acquire(n)
    await p.commitAndMerge(n)
    await mkdir(join(p.integrationPath, 'target'), { recursive: true })
    await writeFile(join(p.integrationPath, 'target', 'big.bin'), 'x')

    const deps = depsOf(p)
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.integration).toBeUndefined()
    const out = await runCleanup(deps, plan, [n])
    expect(out.integrationCleaned).toBe(false)
    expect(await exists(join(p.integrationPath, 'target'))).toBe(true)
  })
})

describe('系统临时目录里的残留', () => {
  /** 用一个真目录当 /tmp:接缝要测的是 slug 怎么算、删了没有,不是 node:os 的行为。 */
  const scratchIn = async (dir: string, names: string[]): Promise<void> => {
    await mkdir(dir, { recursive: true })
    for (const n of names) await writeFile(join(dir, n), 'x'.repeat(1024))
  }
  const scratchDeps = (dir: string) => ({
    list: async (slugs: readonly string[]) => {
      const { readdir } = await import('node:fs/promises')
      const names = await readdir(dir)
      return names.filter(n => slugs.some(s => n.includes(s))).map(n => ({ path: join(dir, n), kb: 1 }))
    },
    remove: async (path: string) => { await rm(path, { recursive: true, force: true }) },
  })

  it('按 slug 认得出属于这些任务的那些,删掉;别人的一个不动', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    await p.acquire(n)
    await p.commitAndMerge(n)
    const slug = p.worktreePathOf(n).split('/').pop()!

    const tmp = join(worktreeRoot, '..', 'faketmp')
    await scratchIn(tmp, [
      `${slug}-target`,          // 这一趟这个节点的
      `qianbase-${slug}-check.log`, // 同一个 slug,另一种命名
      'efftask-999-deadbeef-target', // 另一趟 run 的 —— 不许动
      'unrelated.txt',
    ])

    const deps = depsOf(p, { scratch: scratchDeps(tmp) })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.scratch.map(s => s.path.split('/').pop()).sort())
      .toEqual([`${slug}-target`, `qianbase-${slug}-check.log`].sort())

    const out = await runCleanup(deps, plan, [n])
    expect(out.scratchRemoved).toBe(2)
    expect(await exists(join(tmp, `${slug}-target`))).toBe(false)
    // 反向:别人的东西还在。变异:把匹配从 slug 换成「以 efftask 开头」→ 这条红。
    expect(await exists(join(tmp, 'efftask-999-deadbeef-target'))).toBe(true)
    expect(await exists(join(tmp, 'unrelated.txt'))).toBe(true)
  })

  /**
   * **走 `done` 全体,不走 `items`** —— 和事件日志那份名单同一条规矩。一个工作区早就被
   * 清掉的节点,`/tmp` 里那几个 GB 照样还在,而它正是攒得最久的那一批。
   */
  it('工作区已经不在的节点,它的临时残留照样清得掉', async () => {
    const p = pool()
    const n = node('root', { status: 'ACCEPTED' })
    const slug = p.worktreePathOf(n).split('/').pop()!
    const tmp = join(worktreeRoot, '..', 'faketmp2')
    await scratchIn(tmp, [`${slug}-target`])

    const deps = depsOf(p, { scratch: scratchDeps(tmp) })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])       // 盘上没有工作区目录
    expect(plan.absent).toBe(1)
    expect(plan.scratch).toHaveLength(1) // 而这一份**不是**空的
    const out = await runCleanup(deps, plan, [n])
    expect(out.scratchRemoved).toBe(1)
    expect(await exists(join(tmp, `${slug}-target`))).toBe(false)
  })

  /**
   * 退化的 slug 不许进到匹配里 —— 消费者拿它做的是子串匹配 + `rm -rf`。
   * 变异:把 `.filter(s => s.length >= 8)` 删掉 → 这条红(list 会收到一个 `''`,
   * 而 `''` 是任何名字的子串)。
   */
  it('slug 退化时宁可什么都不清', async () => {
    const p = pool()
    const n = node('root', { status: 'ACCEPTED' })
    let got: readonly string[] | undefined
    const deps = depsOf(p, {
      pathFor: () => '/',           // 末段是空
      scratch: {
        list: async slugs => { got = slugs; return [] },
        remove: async () => { throw new Error('不该走到这里') },
      },
    })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(got).toBeUndefined()
    expect(plan.scratch).toEqual([])
  })
})

/**
 * **工作区里那些不叫 `target/` 的构建目录,一样跟着走。**
 *
 * 用户问的是跑机上真实存在的这一个:`.efftask-worktrees/efftask-001-d05873eb/` 底下的
 * `.cargo-target-sql-restore`。它和上面那条用例里的 `target/` 有两处不同,而这两处恰好
 * 是「会不会被漏掉」的全部可能:
 *  - **点开头**(`.` 前缀):很多遍历默认跳过隐藏项;
 *  - **没被 .gitignore 忽略**,只是未跟踪 —— 于是它不在 `--ignored` 那一类里。
 *
 * 判据是 `git worktree remove --force` 删的是**整个目录**,不是「git 认识的那些文件」。
 * 这一条把它钉住:漏掉的话,用户按完 c 看见「已回收」,而几个 GB 还躺在盘上。
 */
describe('用户实测的那个目录名', () => {
  it('.cargo-target-sql-restore(点开头、未被忽略)也一起删掉', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'ACCEPTED' })
    const lease = await p.acquire(n)
    const path = (lease as { path: string }).path
    await writeFile(join(path, 'src.txt'), 'work\n')
    expect((await p.commitAndMerge(n)).ok).toBe(true)

    // 验收席位在这棵树里跑构建留下的三种残留,一起摆进去。
    await mkdir(join(path, '.cargo-target-sql-restore', 'debug'), { recursive: true })
    await writeFile(join(path, '.cargo-target-sql-restore', 'debug', 'big.bin'), 'x'.repeat(4096))
    await mkdir(join(path, 'target'), { recursive: true })          // 被忽略的那种
    await writeFile(join(path, 'target', 'big.bin'), 'x'.repeat(4096))
    await writeFile(join(path, '.env.local'), 'K=V\n')              // 点开头的单个文件

    const deps = depsOf(p, { dirSizeKb: async () => 8 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toHaveLength(1)
    // 确认屏必须把它数进「会被一并删掉」里 —— 只有 --ignored 而漏掉未跟踪的话,
    // 屏幕上的条数会比实际删掉的少。
    expect(plan.items[0]!.leftovers.join(' ') + plan.items[0]!.leftoverCount).toContain('cargo-target')

    const out = await runCleanup(deps, plan, [n])
    expect(out.failed).toEqual([])
    expect(await exists(join(path, '.cargo-target-sql-restore'))).toBe(false)
    expect(await exists(join(path, 'target'))).toBe(false)
    expect(await exists(join(path, '.env.local'))).toBe(false)
    expect(await exists(path)).toBe(false)
  })

  /** 反向:**没验收**的节点,同一个目录一个字节都不许动 —— 那是现场。 */
  it('节点还没验收时,这些目录原样留着', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a', { status: 'EXECUTING' })
    const lease = await p.acquire(n)
    const path = (lease as { path: string }).path
    await mkdir(join(path, '.cargo-target-sql-restore'), { recursive: true })
    await writeFile(join(path, '.cargo-target-sql-restore', 'big.bin'), 'x')

    const deps = depsOf(p, { dirSizeKb: async () => 8 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])
    await runCleanup(deps, plan, [n])
    expect(await exists(join(path, '.cargo-target-sql-restore'))).toBe(true)
  })
})

/**
 * **用户第 5 条的另一半:目录必须留着的那两桶,它们的构建产物今天一个字节都清不到。**
 *
 * 用户是在 `7339528`(c 键管起 /tmp 与集成工作区)和 `6a3ffa7`(钉住 `.cargo-target-…`)
 * **之后**又问了一遍「为什么按 c 键,target 没有完全清理掉」。而 `c` 键真正够得着的只有
 * 「已验收 **且** 已合入」那一桶(整个目录删掉);另外两类它整个跳过:
 *
 *  - 有未合入提交的已验收节点(`kept`)—— 目录必须留(那是没人能替他决定的工作);
 *  - 还没验收完的节点(`unfinished`,含被阻断的)—— 目录必须留(那是现场)。
 *    跑机上「一个阻断、9 个兄弟依赖阻断」是常态,这一批攒得最久。
 *
 * 判据一句话:**清产物 ≠ 删目录。**
 */
describe('目录留着、只清构建产物', () => {
  /** 造一个「已验收、但有一笔没合进集成分支的提交」的工作区。 */
  async function keptNode(p: ReturnType<typeof pool>, id: string): Promise<{ n: TaskNode; path: string }> {
    const n = node(id, { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'own.ts'), 'executor committed this\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'own commit'], l.path)
    await mkdir(join(l.path, 'target', 'debug'), { recursive: true })
    await writeFile(join(l.path, 'target', 'debug', 'big.o'), 'x'.repeat(4096))
    return { n, path: l.path }
  }

  it('有未合入提交的节点:目录、提交、未提交改动全保,只有 target/ 消失', async () => {
    const p = pool()
    await p.init()
    const { n, path } = await keptNode(p, 'root/01-kept')
    // 未提交的已跟踪改动 + 未跟踪未忽略的文件 —— 两样都必须活下来。
    await writeFile(join(path, 'own.ts'), 'edited but not committed\n')
    await writeFile(join(path, 'draft.ts'), 'not committed at all\n')

    const deps = depsOf(p, { dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    // 硬闸没变:它仍然在 kept 里,一个目录都不会被删。
    expect(plan.items).toEqual([])
    expect(plan.kept).toHaveLength(1)
    // 而它进了新的那一桶。
    expect(plan.buildOnly.map(b => b.nodeId)).toEqual([n.id])
    expect(plan.buildOnly[0]!.plan.entries.map(e => e.rel)).toEqual(['target/'])

    const out = await runCleanup(deps, plan, [n])
    expect(out.removed).toEqual([])
    expect(out.buildOnlyCleaned).toBe(1)
    expect(out.buildOnlyEntries).toBe(1)
    expect(await exists(join(path, 'target'))).toBe(false)
    // 用户第 6 条:未正常合并提交的绝对不能删除掉。逐一验。
    expect(await exists(path)).toBe(true)
    expect(await readFile(join(path, 'own.ts'), 'utf-8')).toBe('edited but not committed\n')
    expect(await exists(join(path, 'draft.ts'))).toBe(true)
    expect((await git(['rev-parse', '--verify', p.worktreeBranchOf(n)], gitRoot)).code).toBe(0)
  })

  it('还没验收完的节点(被阻断的现场)同样只清产物', async () => {
    const p = pool()
    await p.init()
    const n = node('root/02-blocked', { status: 'BLOCKED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'half.ts'), 'half done\n')
    await mkdir(join(l.path, 'target'), { recursive: true })
    await writeFile(join(l.path, 'target', 'a.o'), 'x'.repeat(4096))

    const deps = depsOf(p, { dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    // 它仍然算「还没验收」——那句「跳过 N 个」照旧,目录一个都不删。
    expect(plan.unfinished).toBe(1)
    expect(plan.items).toEqual([])
    expect(plan.buildOnly.map(b => b.nodeId)).toEqual([n.id])

    await runCleanup(deps, plan, [n])
    expect(await exists(join(l.path, 'target'))).toBe(false)
    // 现场一个字节都不动。
    expect(await exists(join(l.path, 'half.ts'))).toBe(true)
    expect(await exists(l.path)).toBe(true)
  })

  /**
   * **在飞的节点一个字节都不碰。**
   *
   * 一次跑到一半的增量编译被抽掉产物,最好的结果是重编,最坏的结果是工具链拿着半个目录
   * 报一堆看不懂的错 —— 而用户会以为是模型写坏了代码。
   */
  it('正在运行的节点整个跳过,而且要数出来', async () => {
    const p = pool()
    await p.init()
    const n = node('root/03-running', { status: 'EXECUTING' })
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, 'target'), { recursive: true })
    await writeFile(join(l.path, 'target', 'a.o'), 'x')

    const deps = depsOf(p, { dirSizeKb: async () => 4, inFlight: [n.id] })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.buildOnly).toEqual([])
    expect(plan.buildOnlyBusy).toBe(1)
    await runCleanup(deps, plan, [n])
    expect(await exists(join(l.path, 'target'))).toBe(true)
  })

  /**
   * **「我没探明白」那一类整个不碰。**
   *
   * 「你还有东西没合」和「探测失败」要用户做的事不一样,而这里的差别不止是措辞:
   * 在一个状态未知的仓库里跑 `git clean -f` 是这个功能最不该做的事。
   */
  it('merge-base 探测失败的节点不进「只清产物」那一桶', async () => {
    const p = pool()
    await p.init()
    const n = node('root/04-unknown', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, 'target'), { recursive: true })
    await writeFile(join(l.path, 'target', 'a.o'), 'x')

    const deps = depsOf(p, {
      dirSizeKb: async () => 4,
      // 只把那一问打成「我不知道」(128),别的 git 调用照常。
      git: async (args, cwd) => (
        args[0] === 'merge-base' ? { code: 128, stdout: '', stderr: 'fatal: 仓库出问题了' } : git(args, cwd)
      ),
    })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.kept).toHaveLength(1)
    expect(plan.kept[0]!.unknown).toBe(true)
    expect(plan.buildOnly).toEqual([])
    await runCleanup(deps, plan, [n])
    expect(await exists(join(l.path, 'target'))).toBe(true)
  })

  /** 没有产物可清的工作区不该在屏幕上占一行。 */
  it('目录里没有构建产物时不进名单', async () => {
    const p = pool()
    await p.init()
    const n = node('root/05-clean', { status: 'BLOCKED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'src.ts'), 'x\n')
    const plan = await scanCleanup(depsOf(p, { dirSizeKb: async () => 4 }), [n], n.id)
    expect(plan.buildOnly).toEqual([])
    expect(plan.buildOnlySizeKnown).toBe(false)
  })

  it('确认屏要说清:只删被忽略的产物、未被忽略的清不掉、被忽略的目录整个消失', async () => {
    const p = pool()
    await p.init()
    const { n } = await keptNode(p, 'root/06-lines')
    const plan = await scanCleanup(depsOf(p, { dirSizeKb: async () => 4 }), [n], n.id)
    const text = cleanupLines(plan).join('\n')
    expect(text).toContain('目录必须留着')
    expect(text).toContain('一个字节都不动')
    expect(text).toContain('清不掉')
    expect(text).toContain('整个')
    // 结果屏同样要说「目录、提交、未提交的改动都原样留着」。
    const out = await runCleanup(depsOf(p, { dirSizeKb: async () => 4 }), plan, [n])
    expect(cleanupResultLines(out).join('\n')).toContain('原样留着')
  })
})

/**
 * **用户第 6 条的反向探针 —— 今天零覆盖。**
 *
 * 「清理按键 c 触发后,未正常合并提交的绝对不能删除掉。」硬闸的正向行为有用例,
 * 而「按下确认之后那个目录、那条分支、那些未提交内容**逐一**还在」从来没有被断言过 ——
 * 而这是一次不可逆的动作。
 */
describe('未合入的绝对不能删(反向)', () => {
  it('已验收但未合入:目录、分支、未提交内容逐一还在', async () => {
    const p = pool()
    await p.init()
    const n = node('root/07-unmerged', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'real work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'unmerged work'], l.path)
    await writeFile(join(l.path, 'loose.ts'), 'uncommitted\n')

    const deps = depsOf(p, { dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])
    const out = await runCleanup(deps, plan, [n])
    expect(out.removed).toEqual([])
    expect(await exists(l.path)).toBe(true)
    expect(await exists(join(l.path, 'work.ts'))).toBe(true)
    expect(await exists(join(l.path, 'loose.ts'))).toBe(true)
    expect((await git(['rev-parse', '--verify', p.worktreeBranchOf(n)], gitRoot)).code).toBe(0)
    // 那笔提交仍然找得回来 —— 「删了就真的没了」这句话的反面。
    expect((await git(['log', '--oneline', p.worktreeBranchOf(n)], gitRoot)).stdout).toContain('unmerged work')
  })

  /**
   * `runCleanup` **只对 `plan.items` 做 `worktree remove`**。
   *
   * 今天靠代码结构成立,没有任何断言 —— 而这是不可逆动作。手工把一个 kept 节点塞进
   * 一个**空的** items 名单里跑一遍,证明它不会顺着别的名单去删东西。
   */
  it('只对 items 动 worktree remove,别的名单一个目录都不删', async () => {
    const p = pool()
    await p.init()
    const n = node('root/08-only-items', { status: 'ACCEPTED' })
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'x\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'w'], l.path)
    await mkdir(join(l.path, 'target'), { recursive: true })
    await writeFile(join(l.path, 'target', 'a.o'), 'x')

    const deps = depsOf(p, { dirSizeKb: async () => 4 })
    const plan = await scanCleanup(deps, [n], n.id)
    expect(plan.items).toEqual([])          // 未合入 → 不在 items 里
    expect(plan.buildOnly).toHaveLength(1)  // 只在「清产物」那一桶
    await runCleanup(deps, plan, [n])
    expect(await exists(l.path)).toBe(true)
  })
})
