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
    logs: [], logKb: 0, logSizeKnown: false, ...over,
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
    }).join('\n')
    expect(text).toContain('没有删除任何工作区')
    expect(text).toContain('⚠ 建表 没删掉')
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
