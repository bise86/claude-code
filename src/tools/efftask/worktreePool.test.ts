/**
 * Integration tests against REAL git in a throwaway repo.
 *
 * Deliberately not a fake GitRunner. Three rounds of plan review for this module were
 * overturned not by design mistakes but by assumptions about what git actually does — a fake
 * would have agreed with every one of those wrong assumptions. Each test below names the
 * measurement it encodes.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
import { worktreeSlug } from './worktreeId.js'
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

const node = (id: string, title = id): TaskNode =>
  createNode({ id, title, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: new Date().toISOString() })

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-wt-'))
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

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('worktreePool against real git', () => {
  it('init creates the integration branch and a dedicated merge worktree', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const br = await git(['rev-parse', '--verify', 'efftask/001/integration'], gitRoot)
    expect(br.code).toBe(0)
    // Dedicated on purpose: merging in the user's own checkout drags their uncommitted edits
    // onto the integration branch and leaves conflict markers in THEIR working tree.
    const wt = await git(['rev-parse', '--git-dir'], p.integrationPath)
    expect(wt.code).toBe(0)
  })

  it('acquire gives a worktree based on the integration branch, not on origin/default', async () => {
    const p = pool()
    await p.init()
    // Something already merged into integration must be visible to the next node.
    await writeFile(join(p.integrationPath, 'dep.txt'), 'from a dependency\n')
    await git(['add', '-A'], p.integrationPath)
    await git(['commit', '-qm', 'dep'], p.integrationPath)

    const lease = await p.acquire(node('root/01-a'))
    expect('error' in lease).toBe(false)
    const ls = await git(['show', 'HEAD:dep.txt'], (lease as { path: string }).path)
    expect(ls.code).toBe(0)
    expect(ls.stdout).toContain('from a dependency')
  })

  it('merges a node whose EXECUTOR already committed — the case a staged-only check misses', async () => {
    // Measured: after the executor commits inside its worktree, `git diff --cached --quiet`
    // exits 0 (nothing staged) while `merge-base --is-ancestor` exits 1 (not merged). A
    // staged-only emptiness test therefore reports "this node produced nothing", skips the
    // merge, and the integration branch silently loses the work while the node is ACCEPTED.
    const p = pool()
    await p.init()
    const n = node('root/01-a', '写接口')
    const lease = await p.acquire(n) as { path: string }
    await writeFile(join(lease.path, 'api.ts'), 'export const api = 1\n')
    await git(['add', '-A'], lease.path)
    await git(['commit', '-qm', 'executor did its own commit'], lease.path)

    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: true })
    const shown = await git(['show', `efftask/001/integration:api.ts`], gitRoot)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('export const api = 1')
  })

  it('merges a node that left its work UNCOMMITTED', async () => {
    const p = pool()
    await p.init()
    const n = node('root/02-b')
    const lease = await p.acquire(n) as { path: string }
    await writeFile(join(lease.path, 'raw.txt'), 'never committed by the executor\n')
    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: true })
    expect((await git(['show', 'efftask/001/integration:raw.txt'], gitRoot)).code).toBe(0)
  })

  it('reports merged:false ONLY when there is genuinely nothing to merge', async () => {
    const p = pool()
    await p.init()
    const n = node('root/03-c')
    await p.acquire(n)
    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: false })
  })

  it('is idempotent: re-merging an already-merged node is success, not failure', async () => {
    // Measured: a second `git merge` prints "Already up to date." and exits 0 without moving
    // HEAD, so a "did HEAD advance" check would call it a failure. Resume re-merges.
    const p = pool()
    await p.init()
    const n = node('root/04-d')
    const lease = await p.acquire(n) as { path: string }
    await writeFile(join(lease.path, 'x.txt'), 'x\n')
    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: true })
    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: false })
  })

  it('a pre-commit hook that rejects everything does NOT stop the merge', async () => {
    // The user's hooks path is set in the SHARED config, so their pre-commit fires inside
    // every agent worktree. Measured: hook rejection and nothing-to-commit BOTH exit 1, so
    // the exit code cannot classify them. Rejecting half-finished agent output is
    // deterministic — retrying it would never converge — so the pool commits --no-verify.
    const p = pool()
    await p.init()
    await mkdir(join(gitRoot, '.git', 'hooks'), { recursive: true })
    await writeFile(join(gitRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 })
    const n = node('root/05-e')
    const lease = await p.acquire(n) as { path: string }
    await writeFile(join(lease.path, 'hooked.txt'), 'work\n')
    expect(await p.commitAndMerge(n)).toMatchObject({ ok: true, merged: true })
  })

  it('a real conflict is reported as a conflict, with the files, and keeps the worktree', async () => {
    const p = pool()
    await p.init()
    const a = node('root/06-f')
    const leaseA = await p.acquire(a) as { path: string }
    await writeFile(join(leaseA.path, 'same.txt'), 'from A\n')
    await p.commitAndMerge(a)

    const b = node('root/07-g')
    const leaseB = await p.acquire(b) as { path: string }
    // b branched BEFORE a merged? No — acquire bases on integration, so force a conflict by
    // rewriting the same file that a just merged.
    await writeFile(join(leaseB.path, 'same.txt'), 'from B\n')
    await git(['add', '-A'], leaseB.path)
    await git(['commit', '-qm', 'b'], leaseB.path)
    // Move integration on so the two diverge on the same line.
    await writeFile(join(p.integrationPath, 'same.txt'), 'from integration\n')
    await git(['add', '-A'], p.integrationPath)
    await git(['commit', '-qm', 'int'], p.integrationPath)

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.kind).toBe('conflict')
    // The worktree must survive a conflict — it is the only place the user can fix it.
    expect((await git(['rev-parse', '--git-dir'], leaseB.path)).code).toBe(0)
  })

  it('a conflict leaves the integration worktree USABLE for the next node', async () => {
    // Measured: a failed merge leaves a staged entry with no MERGE_HEAD, so `merge --abort`
    // reports "There is no merge to abort" and the NEXT merge dies with "local changes would
    // be overwritten" — the integration worktree wedges permanently. reset --hard + clean -fd
    // is what actually recovers it.
    const p = pool()
    await p.init()
    const a = node('root/08-h')
    const la = await p.acquire(a) as { path: string }
    await writeFile(join(la.path, 'c.txt'), 'A\n')
    await p.commitAndMerge(a)

    const b = node('root/09-i')
    const lb = await p.acquire(b) as { path: string }
    await writeFile(join(lb.path, 'c.txt'), 'B\n')
    await git(['add', '-A'], lb.path); await git(['commit', '-qm', 'b'], lb.path)
    await writeFile(join(p.integrationPath, 'c.txt'), 'INT\n')
    await git(['add', '-A'], p.integrationPath); await git(['commit', '-qm', 'int'], p.integrationPath)
    await p.commitAndMerge(b) // conflicts

    // A completely independent node must still be able to merge afterwards.
    const c = node('root/10-j')
    const lc = await p.acquire(c) as { path: string }
    await writeFile(join(lc.path, 'unrelated.txt'), 'fine\n')
    expect(await p.commitAndMerge(c)).toMatchObject({ ok: true, merged: true })
  })

  it('concurrent merges are serialised — every node lands, none is lost', async () => {
    // Measured WITHOUT the mutex: 4 concurrent merges into one checkout gave one rc=0, two
    // rc=128 `cannot lock ref 'HEAD'`, one rc=2 — and only the winner was actually merged.
    const p = pool()
    await p.init()
    const nodes = ['a', 'b', 'c', 'd'].map((x, i) => node(`root/1${i}-${x}`))
    for (const n of nodes) {
      const l = await p.acquire(n) as { path: string }
      await writeFile(join(l.path, `${n.id.split('/')[1]}.txt`), n.id + '\n')
    }
    const results = await Promise.all(nodes.map(n => p.commitAndMerge(n)))
    expect(results.every(r => r.ok)).toBe(true)
    for (const n of nodes) {
      const f = `${n.id.split('/')[1]}.txt`
      expect(`${f}:${(await git(['show', `efftask/001/integration:${f}`], gitRoot)).code}`).toBe(`${f}:0`)
    }
  })

  it('release deletes only when the tree is clean AND the work is merged', async () => {
    const p = pool()
    await p.init()
    const n = node('root/20-k')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'k.txt'), 'k\n')

    // Unmerged work → kept.
    expect((await p.release(n)).removed).toBe(false)
    await p.commitAndMerge(n)
    // Merged and clean → removed.
    expect((await p.release(n)).removed).toBe(true)
  })

  it('release KEEPS a worktree with uncommitted work even when the branch is merged', async () => {
    // 宁可保留垃圾,不可删掉工作: `worktree remove --force` would discard it silently.
    const p = pool()
    await p.init()
    const n = node('root/21-l')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'l.txt'), 'l\n')
    await p.commitAndMerge(n)
    await writeFile(join(l.path, 'later.txt'), 'written after the merge\n')
    const st = await git(["status","--porcelain","--ignored"], l.path)
    console.log("  [debug] worktree=", l.path, "status=", JSON.stringify(st.stdout), "code=", st.code)
    const r = await p.release(n)
    console.log("  [debug] release=", JSON.stringify(r))
    expect(r.removed).toBe(false)
    expect(r.keptBecause).toContain('未提交')
  })

  it('resume: reacquiring a dirty worktree salvages its work to a REACHABLE ref', async () => {
    // Measured: committing and then `checkout -B <same branch> <integration>` resets that
    // branch off the salvage commit — `git for-each-ref --contains <sha>` returned 0 refs and
    // the file vanished from the tree. The salvage must go to a DISTINCT ref first.
    const p = pool()
    await p.init()
    const n = node('root/22-m')
    const l1 = await p.acquire(n) as { path: string }
    await writeFile(join(l1.path, 'partial.ts'), 'half-finished work\n')

    const l2 = await p.acquire(n) as { path: string } // resume re-acquires the same node
    expect(l2.path).toBe(l1.path)
    const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/efftask/001/salvage'], gitRoot)
    expect(refs.stdout).toContain('salvage')
    // …and the salvaged content is retrievable from that ref.
    const salvageRef = refs.stdout.split('\n').map(s => s.trim()).filter(Boolean)[0]
    const show = await git(['show', `${salvageRef}:partial.ts`], gitRoot)
    expect(show.code).toBe(0)
    expect(show.stdout).toContain('half-finished work')
  })

  it('只有被忽略的构建产物时不留抢救分支 —— 那条分支会是集成分支的逐字副本', async () => {
    // 脏的判据带 --ignored(它得覆盖「产出就是 dist/」那种节点),于是一个只跑过构建的
    // 工作区也会走进抢救那一段;而 `add -A` 不暂存被忽略的文件,commit 无事可做,
    // HEAD 就还是集成分支的 tip。无条件建分支 = 收口报告里多一条「这里抢救出了东西」,
    // 而那条分支里一个字节的差异都没有。
    //
    // 分析/质疑讨论也在节点工作区里跑之后,这条路是每个隔离节点的必经之路。
    const p = pool()
    await p.init()
    await writeFile(join(p.integrationPath, '.gitignore'), 'target/\n')
    await git(['add', '-A'], p.integrationPath)
    await git(['commit', '-qm', 'ignore target'], p.integrationPath)

    const n = node('root/23-build')
    const l1 = await p.acquire(n) as { path: string }
    await mkdir(join(l1.path, 'target'), { recursive: true })
    await writeFile(join(l1.path, 'target', 'out.bin'), 'built\n')
    // 前提:这棵树确实被算成「脏」,否则这个用例什么都没证。
    const st = await git(['status', '--porcelain', '--ignored'], l1.path)
    expect(st.stdout.trim().length).toBeGreaterThan(0)

    await p.acquire(n)
    const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/efftask/001/salvage'], gitRoot)
    expect(refs.stdout.trim()).toBe('')
    // 而构建产物本身还在原处 —— 只是没有人假装抢救过它。
    const still = await readFile(join(l1.path, 'target', 'out.bin'), 'utf-8')
    expect(still).toContain('built')
  })

  it('dispose reports what it kept instead of silently deleting or silently leaking', async () => {
    const p = pool()
    await p.init()
    const done = node('root/30-x')
    const dirty = node('root/31-y')
    const ld = await p.acquire(done) as { path: string }
    await writeFile(join(ld.path, 'x.txt'), 'x\n')
    await p.commitAndMerge(done)
    const ly = await p.acquire(dirty) as { path: string }
    await writeFile(join(ly.path, 'y.txt'), 'never merged\n')

    const { kept } = await p.dispose([done, dirty])
    expect(kept).toHaveLength(1)
    expect(kept[0].path).toContain('efftask-001-')
    expect(kept[0].why).toBeTruthy()
  })
})

describe('生命周期边界(验收员用真 pool + 真 pipeline 同进程时发现的)', () => {
  it('init is RE-ENTRANT and never moves an existing integration branch', async () => {
    // Measured before this fix: `branch -f` was unconditional, so after a routine
    // `git worktree prune` a second init returned ok:true while resetting the integration
    // branch back to HEAD. Every already-merged node's commit landed in ZERO refs — release
    // had already deleted their branches — and showed up under `git fsck --unreachable`.
    const p = pool()
    await p.init()
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'kept.txt'), 'merged work\n')
    await p.commitAndMerge(n)
    await p.release(n)
    const before = (await git(['rev-parse', 'efftask/001/integration'], gitRoot)).stdout.trim()

    // Simulate the gc that makes this dangerous.
    await rm(p.integrationPath, { recursive: true, force: true })
    await git(['worktree', 'prune'], gitRoot)

    expect(await p.init()).toEqual({ ok: true })
    expect((await git(['rev-parse', 'efftask/001/integration'], gitRoot)).stdout.trim()).toBe(before)
    expect((await git(['show', 'efftask/001/integration:kept.txt'], gitRoot)).code).toBe(0)
  })

  it('release KEEPS a worktree whose only output is gitignored', async () => {
    // `git status --porcelain` does not list ignored files, so a node whose deliverable is a
    // build output reported a CLEAN tree and `worktree remove --force` deleted it.
    // .gitignore must be in place BEFORE init: git refuses to move a branch that a worktree
    // has checked out, so committing it afterwards and force-moving the integration branch
    // silently leaves the integration tip without it — and then dist/ is not ignored at all
    // and deleting the worktree is the CORRECT behaviour. The first version of this test made
    // exactly that mistake and "failed" against a working implementation.
    await writeFile(join(gitRoot, '.gitignore'), 'dist/\n')
    await git(['add', '-A'], gitRoot); await git(['commit', '-qm', 'ignore dist'], gitRoot)
    const p = pool()
    await p.init()

    const n = node('root/02-b')
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, 'dist'), { recursive: true })
    await writeFile(join(l.path, 'dist', 'bundle.js'), 'the deliverable\n')
    await p.commitAndMerge(n)
    const r = await p.release(n)
    expect(r.removed).toBe(false)
    expect(r.keptBecause).toContain('忽略')
  })

  /**
   * **合并完成即清构建产物** —— 用户第 9 条,打在真 git 上。
   *
   * 上面那条用例记着的正是这个功能存在的理由:一个只留下 `dist/` 的工作区,`release()`
   * 因为「带 `--ignored` 的脏」拒绝删除 —— 于是跑机上每一个已完成节点的 `target/` 都留在盘上,
   * 而 `c` 键的模块头写着「用户此刻还看得见的目录,恰恰全是 release 拒绝过的那些」。
   *
   * 先清再放之后,同一个工作区**当场变成可回收的**。这是这条功能顺带买到的东西,
   * 不是它的目的 —— 但它得能被断言,否则谁都可以把顺序调回去而全套测试照绿。
   */
  it('wipeBuildOutputs 之后,原本被 release 拒绝的工作区当场可回收', async () => {
    // .gitignore 必须在 init 之前落到集成分支上 —— 理由见上一条用例(否则 dist/ 根本不被
    // 忽略,而删掉它是**正确**行为,用例会对着一个好的实现「失败」)。
    await writeFile(join(gitRoot, '.gitignore'), 'dist/\n')
    await git(['add', '-A'], gitRoot); await git(['commit', '-qm', 'ignore dist'], gitRoot)
    const p = pool()
    await p.init()

    const n = node('root/09-w')
    const l = await p.acquire(n) as { path: string }
    // 真交付物(会被合走)+ 构建产物(被忽略,永远到不了集成分支)。
    await writeFile(join(l.path, 'api.ts'), 'export const api = 1\n')
    await mkdir(join(l.path, 'dist'), { recursive: true })
    await writeFile(join(l.path, 'dist', 'bundle.js'), 'x'.repeat(4096))
    expect((await p.commitAndMerge(n)).ok).toBe(true)

    // 没清之前:release 拒绝,而且拒绝的理由恰恰是那个构建产物。
    const before = await p.release(n)
    expect(before.removed).toBe(false)
    expect(before.keptBecause).toContain('忽略')

    const wiped = await p.wipeBuildOutputs(n)
    expect(wiped.error).toBeUndefined()
    expect(wiped.removed).toEqual(['dist/'])
    // 交付物一个字节都不许动:它是已跟踪、已提交的。
    expect(await readFile(join(l.path, 'api.ts'), 'utf-8')).toBe('export const api = 1\n')

    const after = await p.release(n)
    expect(after.removed).toBe(true)
  })

  it('salvages commits the executor made itself, not only uncommitted edits', async () => {
    // Measured: an executor that COMMITTED inside its worktree and was then interrupted had
    // those commits reset away by `checkout -B` — 0 refs contained them, the file was gone.
    // A dirty-only salvage check never fires for that shape.
    const p = pool()
    await p.init()
    const n = node('root/03-c')
    const l1 = await p.acquire(n) as { path: string }
    await writeFile(join(l1.path, 'committed.ts'), 'executor committed this\n')
    await git(['add', '-A'], l1.path)
    await git(['commit', '-qm', 'executor own commit'], l1.path)
    const sha = (await git(['rev-parse', 'HEAD'], l1.path)).stdout.trim()

    await p.acquire(n) // resume re-acquires
    const refs = await git(['for-each-ref', '--contains', sha, '--format=%(refname)'], gitRoot)
    expect(refs.stdout.trim().length).toBeGreaterThan(0)
  })
})

describe('冲突必须发生在节点自己的工作区(spec §8),且绝不带着标记合入', () => {
  /** Two nodes editing the same line, A merged first — the only way to get a real conflict. */
  async function conflictingPair() {
    const p = pool()
    await p.init()
    const a = node('n-a'), b = node('n-b')
    const la = await p.acquire(a), lb = await p.acquire(b)
    if ('error' in la || 'error' in lb) throw new Error('acquire failed')
    a.worktree = { branch: la.branch, path: la.path }
    b.worktree = { branch: lb.branch, path: lb.path }
    await writeFile(join(la.path, 'shared.txt'), 'line1\nA 版本\nline3\n')
    await writeFile(join(lb.path, 'shared.txt'), 'line1\nB 版本\nline3\n')
    await p.commitAndMerge(a)
    return { p, a, b, pa: la.path, pb: lb.path }
  }

  it('reproduces the conflict IN the node worktree, with markers and MERGE_HEAD', async () => {
    // The whole feature rests on this. commitAndMerge merges in the SHARED integration
    // worktree and then reset --hard + clean -fd there, so at the moment a conflict is
    // reported the node's own worktree is CLEAN — measured. Sending a resolver (or a human)
    // there to 解决冲突 pointed both at a directory with nothing in it to resolve.
    const { p, b, pb } = await conflictingPair()
    const first = await p.commitAndMerge(b)
    expect(first.ok).toBe(false)
    expect(first.ok === false && first.kind).toBe('conflict')

    const before = await git(['status', '--porcelain'], pb)
    expect(before.stdout.trim()).toBe('') // the defect: clean, nothing to fix

    const made = await p.mergeIntegrationIntoNode(b)
    expect(made).toEqual({ ok: true, conflicted: true, files: ['shared.txt'] })
    const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], pb)
    expect(mh.code).toBe(0)
    const txt = await Bun.file(join(pb, 'shared.txt')).text()
    expect(txt).toContain('<<<<<<<')
    expect(txt).toContain('A 版本')
    expect(txt).toContain('B 版本')
  })

  it('REFUSES to merge an unresolved worktree instead of shipping the markers', async () => {
    // REGRESSION, and the worst kind: commitAndMerge opens with `git add -A`, which on a
    // worktree with a live MERGE_HEAD marks every conflicted path RESOLVED with the <<<<<<<
    // text still in it. The commit became a merge commit, isMerged() said true, and the
    // integration branch received conflict markers while the node reached ACCEPTED and nobody
    // was paged. Blocking is strictly better: the work survives and a human is told.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)   // conflict now live in pb, nobody resolves it

    const headBefore = await git(['rev-parse', 'HEAD'], pb)
    const second = await p.commitAndMerge(b)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.kind).toBe('conflict')
    // The unmerged-paths check earns its keep HERE: the marker scan downstream would also
    // refuse this, but only after `git add -A` + commit had already built a junk merge commit
    // full of markers on the node branch — which is what the human then has to untangle.
    expect((await git(['rev-parse', 'HEAD'], pb)).stdout).toBe(headBefore.stdout)

    const intFile = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(intFile.stdout).not.toContain('<<<<<<<')
    expect(intFile.stdout).toContain('A 版本')
    // and the node's work is still there to be rescued
    expect(await Bun.file(join(pb, 'shared.txt')).text()).toContain('<<<<<<<')
  })

  it('refuses staged conflict markers even with no merge in progress', async () => {
    // A resolver can also "resolve" by staging a file that still has both sides in it. There
    // is no MERGE_HEAD in that case, so the unmerged-paths check above does not catch it.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\n<<<<<<< HEAD\nB 版本\n=======\nA 版本\n>>>>>>> x\nline3\n')
    await git(['add', '-A'], pb)
    await git(['commit', '--no-verify', '-qm', 'fake resolve'], pb) // merge concluded, markers kept
    await writeFile(join(pb, 'other.txt'), 'x\n')

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(false)
    const intFile = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(intFile.stdout).not.toContain('<<<<<<<')
  })

  it('refuses markers a resolver merely staged — the exact shape the prompt asks for', async () => {
    // The resolve prompt says "解决后 git add 冲突文件即可,不要提交". A resolver that stages the
    // file with both sides still in it therefore leaves NO unmerged path and NO commit of its
    // own — commitAndMerge makes the merge commit itself. An earlier version ran this scan
    // BEFORE that commit, against a HEAD that did not yet contain the round's work, so it
    // matched nothing: the guard was decorative and its test passed for another reason.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\n<<<<<<< HEAD\nB 版本\n=======\nA 版本\n>>>>>>> x\nline3\n')
    await git(['add', 'shared.txt'], pb) // staged, NOT committed — exactly as instructed

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.kind).toBe('conflict')
    const intFile = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(intFile.stdout).not.toContain('<<<<<<<')
    expect(intFile.stdout).toContain('A 版本') // the earlier node's work is intact
  })

  it('refuses a SINGLE stray marker line the resolver left behind', async () => {
    // The realistic failure, from an acceptance review: the resolver genuinely merges both
    // sides but leaves one orphan >>>>>>> line, then `git add` (exactly what the prompt asks).
    // Nothing is unmerged, nothing is committed by the resolver, and the text looks resolved
    // at a glance — the node reported ACCEPTED with the marker on the integration branch.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\nA 版本 + B 版本\n>>>>>>> efftask/001/integration\nline3\n')
    await git(['add', 'shared.txt'], pb)

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(false)
    const shown = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(shown.stdout).not.toContain('>>>>>>>')
  })

  it('reports COMMITTED leftover markers rather than calling the worktree conflict-free', async () => {
    // A resolver that "resolves" by committing both sides leaves a worktree that is clean and
    // has no MERGE_HEAD. Every other probe calls that conflict-free — and the escalation card
    // then told the user 那里目前没有冲突现场 while <<<<<<< HEAD sat in the file, prescribing a
    // `git merge` that answers "Already up to date." Measured on a real card.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\n<<<<<<< HEAD\nB 版本\n=======\nA 版本\n>>>>>>> x\nline3\n')
    await git(['add', '-A'], pb)
    await git(['commit', '--no-verify', '-qm', 'fake resolve'], pb)

    const st = await p.conflictState(b)
    expect(st.markers).toBe(true)
    expect(st.stale).toBe(true)              // committed, not a live merge — a different fix
    expect(st.files).toEqual(['shared.txt']) // and only the file that actually carries them
    // Probing must not have quietly merged anything either.
    const shown = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(shown.stdout).not.toContain('<<<<<<<')
  })

  it('lists only the files that carry markers, not every file the branch touched', async () => {
    // res.files on the marker-scan path was `diff --name-only`, i.e. everything the branch
    // changed: a real card listed two untouched files under 冲突文件.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\n<<<<<<< HEAD\nB\n=======\nA\n>>>>>>> x\nline3\n')
    await writeFile(join(pb, 'unrelated1.txt'), '完全正常的内容\n')
    await writeFile(join(pb, 'unrelated2.txt'), '也完全正常\n')
    await git(['add', '-A'], pb)

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.kind === 'conflict' && res.files).toEqual(['shared.txt'])
  })

  it('a correct resolution still merges when an UNRELATED file documents markers', async () => {
    // The controlled pair from an acceptance review: two byte-identical runs, differing only
    // in that one also ships a CONFLICTS.md about merge markers. The genuine resolution of the
    // real conflict was refused because of the other file — and the card then told the author
    // to delete their own documentation to get unblocked.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\nA 版本 + B 版本\nline3\n') // really resolved
    await writeFile(join(pb, 'CONFLICTS.md'), [
      '# 冲突处理指南', '', '你会看到:', '', '<<<<<<< HEAD', '你的', '=======', '别人的', '>>>>>>> other', '',
    ].join('\n'))
    await git(['add', '-A'], pb)

    const res = await p.commitAndMerge(b)
    expect(res).toMatchObject({ ok: true, merged: true })
    const shared = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(shared.stdout).toContain('A 版本 + B 版本')
    // the documentation survives intact — it was never the problem
    const doc = await git(['show', `${p.integrationBranchName}:CONFLICTS.md`], gitRoot)
    expect(doc.stdout).toContain('<<<<<<< HEAD')
  })

  it('does NOT refuse a node whose deliverable merely CONTAINS marker-shaped text', async () => {
    // Conflict-marker text is not evidence of a conflict. A README about resolving merge
    // conflicts — or any Markdown using a `=======` setext underline — matches the pattern.
    // Measured before the merge-commit gate: 3 hits on a documentation file, and the node
    // would have been refused permanently while the card sent its author to resolve a
    // conflict that did not exist.
    const p = pool()
    await p.init()
    const n = node('n-doc')
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error('acquire failed')
    n.worktree = { branch: lease.branch, path: lease.path }
    await writeFile(join(lease.path, 'doc.md'), [
      '# 冲突处理', '', '出现下面这样的内容时:', '',
      '<<<<<<< HEAD', '你的改动', '=======', '别人的改动', '>>>>>>> other', '',
      '请手工合并。', '',
      '标题', '=======', '',
    ].join('\n'))

    const res = await p.commitAndMerge(n)
    expect(res).toMatchObject({ ok: true, merged: true })
    const shown = await git(['show', `${p.integrationBranchName}:doc.md`], gitRoot)
    expect(shown.stdout).toContain('请手工合并')
  })

  it('a real resolution merges cleanly and keeps BOTH sides', async () => {
    // The counterfactual that proves the mechanism works, not just that it refuses things.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    await writeFile(join(pb, 'shared.txt'), 'line1\nA 版本 + B 版本\nline3\n')
    await git(['add', 'shared.txt'], pb)

    const res = await p.commitAndMerge(b)
    expect(res.ok).toBe(true)
    const intFile = await git(['show', `${p.integrationBranchName}:shared.txt`], gitRoot)
    expect(intFile.stdout).toContain('A 版本 + B 版本')
    expect(intFile.stdout).not.toContain('<<<<<<<')
  })

  it('conflictState is READ-ONLY — a probe must not change what it reports', async () => {
    // It used to call mergeIntegrationIntoNode so the card would have a conflict to point at.
    // That made the probe commit the executor's loose files under a message claiming they were
    // the deliverable, perform the merge, and then report the state its own merge produced:
    // the card's "请自行 git merge" answered "Already up to date", and the merge commit it
    // manufactured was what armed the marker scan for the next round.
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await writeFile(join(pb, 'loose.txt'), '执行者还没提交的东西\n')
    const headBefore = await git(['rev-parse', 'HEAD'], pb)

    const st = await p.conflictState(b)
    expect(st).toEqual({ markers: false, staged: false, stale: false, files: [] })
    expect((await git(['rev-parse', 'HEAD'], pb)).stdout).toBe(headBefore.stdout)
    expect((await git(['status', '--porcelain'], pb)).stdout).toContain('loose.txt')
    // …and because nothing was pre-merged, the instruction the card gives for this state
    // ("请自行把集成分支合并进来") really does reproduce the conflict.
    const byHand = await git(['merge', '--no-edit', p.integrationBranchName], pb)
    expect(byHand.code).not.toBe(0)
    expect(byHand.stdout + byHand.stderr).not.toContain('Already up to date')
  })

  it('reports a live conflict and a staged resolution without touching either', async () => {
    const { p, b, pb } = await conflictingPair()
    await p.commitAndMerge(b)
    await p.mergeIntegrationIntoNode(b)
    expect(await p.conflictState(b)).toEqual({ markers: true, staged: false, stale: false, files: ['shared.txt'] })

    await writeFile(join(pb, 'shared.txt'), 'line1\n合并后的\nline3\n')
    await git(['add', 'shared.txt'], pb)
    const head = await git(['rev-parse', 'HEAD'], pb)
    expect(await p.conflictState(b)).toEqual({ markers: false, staged: true, stale: false, files: [] })
    expect((await git(['rev-parse', 'HEAD'], pb)).stdout).toBe(head.stdout)
  })
})

/**
 * **完成一个子任务就合一次**(用户:「不要等所有任务完成再合并。所以也不要什么分支开发,
 * 只有主干开发」)。
 *
 * 在这之前,集成分支只在整趟跑完时由 finishHandoff 合一次 —— 中途用户的目录里什么都没有,
 * 一个跑三小时的 run 就是三小时的黑箱。这一组用例钉住的是「什么时候合、什么时候不合、
 * 不合的时候说什么」,全部对着真 git:这条路会**改用户自己的工作区**,假 runner 会对
 * 每一个关于 git 行为的假设点头。
 */
describe('逐任务合回主干', () => {
  const trunkFile = async (name: string): Promise<string | null> =>
    readFile(join(gitRoot, name), 'utf-8').catch(() => null)

  it('一个子任务合进集成分支之后,产出**立刻**出现在用户的目录里', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    const res = await p.commitAndMerge(n)
    expect(res).toMatchObject({ ok: true, merged: true, trunk: { advanced: true } })
    // 文件真的在用户的检出里,而且 main 真的前进了(不是只有集成分支动了)。
    expect(await trunkFile('shipped.ts')).toContain('the work')
    expect((await git(['rev-parse', 'main'], gitRoot)).stdout.trim())
      .toBe((await git(['rev-parse', 'efftask/001/integration'], gitRoot)).stdout.trim())
  })

  it('两个子任务 = 两次合并,不是攒到最后一次', async () => {
    const p = pool()
    await p.init()
    for (const id of ['root/01-a', 'root/02-b']) {
      const n = node(id)
      const l = await p.acquire(n) as { path: string }
      await writeFile(join(l.path, `${id.slice(-1)}.ts`), `${id}\n`)
      expect(await p.commitAndMerge(n)).toMatchObject({ trunk: { advanced: true } })
      // 每一步之后当前那一份就已经在用户目录里 —— 不必等下一个子任务。
      expect(await trunkFile(`${id.slice(-1)}.ts`)).toContain(id)
    }
    const h = await p.handoff([])
    // **从 git 现算**:两个子任务各贡献一次提交,全部已经落在 main 上。
    expect(h.trunkLanded).toBe(2)
    expect(h.commits).toBe(0)
  })

  /**
   * **脏树不再前置挡 —— 这一条推翻了它的上一版,而推翻它的是跑机上的真实后果。**
   *
   * 上一版断言「有已跟踪改动 → 这一跳整个跳过」。qianbase-xtp run 001 实测:3 个不相干的
   * 脏文件把 **607 个提交**全堵在集成分支上,每个子任务完成时都印一句「已合入集成分支,
   * 但还没送到你的分支」,跑了几百次。用户原话:「这个不应该自动合进来吗」。
   *
   * git 的保护是**逐文件**的:碰不到就直接合上,真要覆盖则当场拒绝、一个字节不动。
   */
  it('用户的脏文件和这次合并不相交 → 照常送到,而且他的改动一个字节没变', async () => {
    const p = pool()
    await p.init()
    await writeFile(join(gitRoot, 'base.txt'), '用户自己正在改\n')
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    const res = await p.commitAndMerge(n) as { ok: true; merged: boolean; trunk?: { advanced: boolean; reason?: string } }
    expect(res).toMatchObject({ ok: true, merged: true })
    expect(res.trunk?.advanced).toBe(true)
    // 产出真的到了用户的目录里。
    expect(await trunkFile('shipped.ts')).toContain('the work')
    // 而他手上那份改动原样在,并且仍然是未提交的 —— 合并没有把它卷进任何提交。
    expect(await trunkFile('base.txt')).toContain('用户自己正在改')
    expect((await git(['status', '--porcelain', '--', 'base.txt'], gitRoot)).stdout).toContain('base.txt')
    expect((await p.handoff([])).trunkSkips).toHaveLength(0)
  })

  /**
   * 真撞上时:git 当场拒绝、**一个字节不动**、不留 `MERGE_HEAD`,于是失败路径的
   * `restored` 直接为真,并把 git 的原话带出来。节点自己的判决不受影响。
   */
  it('用户的脏文件正好被这次合并改到 → git 拒绝,产出留在集成分支上,他的改动毫发无损', async () => {
    const p = pool()
    await p.init()
    await writeFile(join(gitRoot, 'base.txt'), '用户自己正在改\n')
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    // 这次任务改的正是 base.txt。
    await writeFile(join(l.path, 'base.txt'), '来自任务的内容\n')
    const res = await p.commitAndMerge(n) as { ok: true; merged: boolean; trunk?: { advanced: boolean; reason?: string } }
    expect(res).toMatchObject({ ok: true, merged: true })
    expect(res.trunk?.advanced).toBe(false)
    // 说的是 git 的原话,而且要带上文件名 —— 用户据此才知道该去存哪个文件。
    expect(res.trunk?.reason ?? '').toContain('base.txt')
    expect(await trunkFile('base.txt')).toContain('用户自己正在改')
    expect((await p.handoff([])).trunkSkips.join(' ')).toContain('base.txt')
  })

  it('**未跟踪**文件不算脏 —— 按 status --porcelain 判的话这个功能几乎一次都不会发生', async () => {
    const p = pool()
    await p.init()
    // `.claude/efftask/` 由 init() 写进 .git/info/exclude,**证明不了这一条** —— 它在
    // status 里本来就看不见。要一个真正会出现在 `status --porcelain` 里的未跟踪文件:
    // 用户目录里那种随手留下的东西才是这条判据每天要面对的输入。
    await writeFile(join(gitRoot, 'scratch.txt'), '用户随手留下的\n')
    expect((await git(['status', '--porcelain'], gitRoot)).stdout).toContain('?? scratch.txt')
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    expect(await p.commitAndMerge(n)).toMatchObject({ trunk: { advanced: true } })
    expect(await trunkFile('shipped.ts')).toContain('the work')
  })

  it('detached HEAD → 不合(那是唯一「合成功了、代码却不在任何分支上」的路)', async () => {
    const p = pool()
    await p.init()
    await git(['checkout', '-q', '--detach', 'HEAD'], gitRoot)
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    const res = await p.commitAndMerge(n) as { trunk?: { advanced: boolean; reason?: string } }
    expect(res.trunk?.advanced).toBe(false)
    expect(res.trunk?.reason).toContain('detached HEAD')
  })

  it('用户自己就站在集成分支上 → 不对自己 merge,但必须说出来(他的 status 会显示成一串删除)', async () => {
    const p = pool()
    await p.init()
    // 集成工作区占着那条分支,所以主检出要用 --ignore-other-worktrees 才切得过去。
    await git(['checkout', '-q', '--ignore-other-worktrees', 'efftask/001/integration'], gitRoot)
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    const res = await p.commitAndMerge(n) as { trunk?: { advanced: boolean; reason?: string } }
    expect(res.trunk?.advanced).toBe(false)
    /**
     * **不能沉默。** 分支引用是共享的:集成工作区把它推进之后,他那棵树的 HEAD 跟着走
     * 而工作区文件没动 —— `git status` 把整批产出显示成一串待提交的删除。验收实测到的
     * 就是这个形态,而上一版在这一格上一个字都不说。
     */
    expect(res.trunk?.reason).toContain('停在集成分支')
    expect(res.trunk?.reason).toContain('git switch')
    expect((await p.handoff([])).trunkSkips.join(' ')).toContain('停在集成分支')
  })

  /**
   * **merge 失败 ≠ 有冲突文件。** 验收实测到三个各自独立的触发器,全都是「非零退出 +
   * 零个 unmerged path」:`commit-msg` 钩子拒绝(commitlint/husky)、`pre-merge-commit`
   * 钩子拒绝、`rerere.autoupdate` 自动暂存了解决。上一版只在有 UU 行时才 abort,于是
   * 这三条路都把 MERGE_HEAD 和整批产出留在用户的检出里,而收口屏逐字写着
   * 「你的工作区未被改动」;之后每个子任务还会把这个半合并状态**报成用户的脏改动**。
   *
   * 前提只有一个:用户在 run 跑着的时候自己提交过一笔(否则合并是快进,不产生提交,
   * 也就不走 commit 钩子)—— 而那正是这个功能的卖点场景。
   */
  it('commit-msg 钩子拒绝(非零退出但零冲突文件)→ 不许把用户丢在半合并状态', async () => {
    const p = pool()
    await p.init()
    // 用户自己提交一笔 → 下面那次合并是真的合并提交,会走 commit-msg 钩子。
    // **钩子要装在这一笔之后**:装在前面的话用户这次提交自己就被拒了,树留着脏改动,
    // 测的就变成脏树那一格了(第一版就是这么写的,而它「通过」得毫无意义)。
    await writeFile(join(gitRoot, 'user.txt'), '用户自己的\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user'], gitRoot)
    await mkdir(join(gitRoot, '.git', 'hooks'), { recursive: true })
    await writeFile(join(gitRoot, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\necho "commitlint: subject may not be empty" >&2\nexit 1\n', { mode: 0o755 })

    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'a.ts'), 'A\n')
    const res = await p.commitAndMerge(n) as { trunk?: { advanced: boolean; reason?: string } }

    // `--no-verify` 让它直接合成了(编排器发起的合并必然要发生,钩子拒绝是确定性失败,
    // 重试永远不会收敛 —— commitAndMerge 早就为同一个理由带着这个开关)。
    expect(res.trunk?.advanced).toBe(true)
    // 而无论走哪条路,**绝不能**留下 MERGE_HEAD。
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)).code).not.toBe(0)
    expect(await trunkFile('a.ts')).toContain('A')
  })

  it('合并失败但一个冲突文件都没有 → 照样 abort,并且复核过现场真的没了', async () => {
    // 直接制造「非零退出 + 零 unmerged path」:用户目录里有一个未跟踪文件,而集成分支
    // 带来同名文件 —— git 在动任何字节之前就拒绝,报错第一行没有宾语(文件名在后面几行)。
    const p = pool()
    await p.init()
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'collide.ts'), '任务这一版\n')
    await writeFile(join(gitRoot, 'collide.ts'), '用户手里那一版\n')
    const res = await p.commitAndMerge(n) as { trunk?: { advanced: boolean; reason?: string } }

    expect(res.trunk?.advanced).toBe(false)
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)).code).not.toBe(0)
    // 用户那个未跟踪文件一个字节都没动 —— git 自己的拒绝比我们猜得准。
    expect(await trunkFile('collide.ts')).toContain('用户手里那一版')
    // 原因里要有**宾语**:只取 stderr 第一行的话,用户拿到的是
    // 「error: The following untracked working tree files would be overwritten by merge:」。
    expect(res.trunk?.reason).toContain('collide.ts')
  })

  it('rerere 自动暂存了解决(MERGE_HEAD 在、一个 UU 都没有)→ 照样还原,不留半合并现场', async () => {
    /**
     * `--no-verify` 挡掉了钩子那两个触发器,**这一个挡不掉**:开了
     * `rerere.enabled + rerere.autoupdate` 的用户(相当常见),再次遇到同一个冲突时 git 会
     * 自动套用上次的解决并 `git add`,然后**非零退出**等人来 commit —— 于是 `status` 里
     * 只有 `M ` 而没有 `UU`。上一版的 abort 门控在「有没有 UU 行」上,这一格直接漏过去。
     * 实测(git 2.54):`rc=1` / `MERGE_HEAD present` / `M  f.txt`。
     */
    const p = pool()
    await p.init()
    await git(['config', 'rerere.enabled', 'true'], gitRoot)
    await git(['config', 'rerere.autoupdate', 'true'], gitRoot)
    // 先让 rerere 记住一次解决:同样的两边、同样的基线。
    await git(['branch', 'rr-src'], gitRoot)
    await writeFile(join(gitRoot, 'f.txt'), '用户这一版\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user side'], gitRoot)
    await git(['checkout', '-q', 'rr-src'], gitRoot)
    await writeFile(join(gitRoot, 'f.txt'), '任务这一版\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'node side'], gitRoot)
    await git(['checkout', '-q', 'main'], gitRoot)
    await git(['merge', '--no-edit', 'rr-src'], gitRoot)          // 冲突
    await writeFile(join(gitRoot, 'f.txt'), '手工解决的\n')
    await git(['add', 'f.txt'], gitRoot)
    await git(['commit', '-qm', 'resolved'], gitRoot)             // ← rerere 记下来了
    await git(['reset', '-q', '--hard', 'HEAD~1'], gitRoot)       // 撤销那次合并,保留记录

    // 现在一个子任务带来**逐字相同**的另一边,于是主干合并时命中那条记录。
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'f.txt'), '任务这一版\n')
    const res = await p.commitAndMerge(n) as { trunk?: { advanced: boolean; reason?: string } }

    expect(res.trunk?.advanced).toBe(false)
    // **这一条是整个用例的意义所在**:现场必须被收拾干净。
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], gitRoot)).code).not.toBe(0)
    expect((await git(['status', '--porcelain'], gitRoot)).stdout.trim()).toBe('')
    expect(await trunkFile('f.txt')).toContain('用户这一版')
    expect(res.trunk?.reason).toContain('已还原你的工作区')
  })

  it('用户回退掉已经合进来的提交 → 不再原样合回去,并说清为什么', async () => {
    // README 卖的是「合并只发生在你自己的仓库里,随时 git reset 得回来」。不认这件事的话,
    // 下一个子任务完成时会把他刚扔掉的提交原样合回来 —— 而没有任何提示说它被撤销了。
    const p = pool()
    await p.init()
    const a = node('root/01-a')
    const la = await p.acquire(a) as { path: string }
    await writeFile(join(la.path, 'a.ts'), 'A\n')
    await p.commitAndMerge(a)
    expect(await trunkFile('a.ts')).toContain('A')

    await git(['reset', '--hard', 'HEAD~1'], gitRoot)
    expect(await trunkFile('a.ts')).toBeNull()

    const b = node('root/02-b')
    const lb = await p.acquire(b) as { path: string }
    await writeFile(join(lb.path, 'b.ts'), 'B\n')
    const res = await p.commitAndMerge(b) as { trunk?: { advanced: boolean; reason?: string } }
    expect(res.trunk?.advanced).toBe(false)
    expect(res.trunk?.reason).toContain('回退过')
    expect(await trunkFile('a.ts')).toBeNull()   // 他扔掉的东西没有被合回来
    expect(await trunkFile('b.ts')).toBeNull()
    // 而产出一个都没丢:全在集成分支上,收口那一屏会告诉他怎么拿。
    expect((await git(['show', 'efftask/001/integration:b.ts'], gitRoot)).stdout).toContain('B')
  })

  it('一次成功的合并会把此前「没送到」的警告清掉 —— 集成分支是累积的', async () => {
    const p = pool()
    await p.init()
    // 造一次**真的**没送到:任务改的正好是用户手上没存的那个文件,git 当场拒绝。
    // (「脏就整个跳过」那道前置闸已经拿掉了 —— 不相交的脏文件不再产生 skip。)
    await writeFile(join(gitRoot, 'base.txt'), '用户正在改\n')
    const a = node('root/01-a')
    const la = await p.acquire(a) as { path: string }
    await writeFile(join(la.path, 'base.txt'), '来自任务甲\n')
    await p.commitAndMerge(a)
    expect((await p.handoff([])).trunkSkips.length).toBe(1)

    // 用户把自己那份改动撤了 —— 下一次就合得上。
    await git(['checkout', '--', 'base.txt'], gitRoot)
    const b = node('root/02-b')
    const lb = await p.acquire(b) as { path: string }
    await writeFile(join(lb.path, 'b.ts'), 'B\n')
    await p.commitAndMerge(b)
    // 两笔都到了,那句警告在这一刻已经不成立 —— 留着它会和上面那句「已逐一合并回你的
    // 分支」同时印在收口屏上。
    expect(await trunkFile('base.txt')).toContain('来自任务甲')
    expect((await p.handoff([])).trunkSkips).toEqual([])
  })

  it('撞冲突 → 还原用户的工作区,如实说,产出留在集成分支上', async () => {
    const p = pool()
    await p.init()
    // 用户在自己的分支上改了同一个文件并提交 —— 于是两边在同一行分叉。
    await writeFile(join(gitRoot, 'same.txt'), '用户这一版\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user side'], gitRoot)
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'same.txt'), '任务这一版\n')
    const res = await p.commitAndMerge(n) as { ok: true; trunk?: { advanced: boolean; reason?: string; conflicted?: boolean } }
    expect(res.ok).toBe(true)
    expect(res.trunk?.conflicted).toBe(true)
    expect(res.trunk?.reason).toContain('撞了冲突')
    expect(res.trunk?.reason).toContain('已还原')
    // 关键:用户的工作区**没有**被留在半合并状态。
    const st = await git(['status', '--porcelain'], gitRoot)
    expect(st.stdout).not.toMatch(/^(UU|AA) /m)
    expect(await trunkFile('same.txt')).toContain('用户这一版')
    // 而产出在集成分支上,收口那一次还会再试一遍。
    expect((await p.handoff([])).commits).toBeGreaterThan(0)
  })

  it('`--resume` 之后仍然说得出「产出已经在你的分支上」—— 新进程 = 新池子 = 计数器归零', async () => {
    /**
     * 这一条是**内存计数器不够用**的证明。验收实测:恢复之后收口屏印的是
     * 「本次没有产生任何改动;分支与起点相同」,而用户目录里躺着三个子任务的产出;
     * 打开了自动推送的人在这条路上也一次都推不出去(那个开关的门就是这个数)。
     *
     * 所以 `trunkLanded` 必须从 git 现算(起点钉在 `refs/efftask/<runId>/base` 上),
     * 而不是数这个进程里合成功过几次。
     */
    const first = pool()
    await first.init()
    for (const id of ['root/01-a', 'root/02-b', 'root/03-c']) {
      const n = node(id)
      const l = await first.acquire(n) as { path: string }
      await writeFile(join(l.path, `${id.slice(-1)}.ts`), `${id}\n`)
      await first.commitAndMerge(n)
    }
    expect((await first.handoff([])).trunkLanded).toBe(3)

    // 新进程:同一个 runId、同一个仓库,一个全新的池子(`--resume` 就是这样)。
    const resumed = pool()
    expect(await resumed.init()).toEqual({ ok: true })
    const h = await resumed.handoff([])
    expect(h.commits).toBe(0)
    expect(h.trunkLanded).toBe(3)   // ← 内存计数器在这里是 0
    expect(await trunkFile('a.ts')).toContain('root/01-a')
  })

  it('用户在 run 跑着的时候自己提交了 → 那几笔会被带进集成分支,后面的任务看得见', async () => {
    // 「任务开始就先从主干同步代码」在这种情况下才是真的:acquire 基于集成分支,
    // 不把主干上多出来的东西带回去,用户自己那几笔对所有后续任务永远不存在。
    const p = pool()
    await p.init()
    await writeFile(join(gitRoot, 'user.txt'), '用户自己提交的\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user commit during the run'], gitRoot)

    const a = node('root/01-a')
    const la = await p.acquire(a) as { path: string }
    await writeFile(join(la.path, 'a.ts'), 'A\n')
    expect(await p.commitAndMerge(a)).toMatchObject({ trunk: { advanced: true } })

    // 集成分支现在也含有用户那一笔 —— 所以下一个节点的工作区里看得到它。
    expect((await git(['show', 'efftask/001/integration:user.txt'], gitRoot)).stdout).toContain('用户自己提交的')
    const b = node('root/02-b')
    const lb = await p.acquire(b) as { path: string }
    expect(await readFile(join(lb.path, 'user.txt'), 'utf-8')).toContain('用户自己提交的')
  })

  it('脏树挡掉一次之后,树干净了 → 下一个子任务把两笔一起带过去', async () => {
    const p = pool()
    await p.init()
    // 同上:用真撞车造这一次「没送到」。
    await writeFile(join(gitRoot, 'base.txt'), '用户自己正在改\n')
    const a = node('root/01-a')
    const la = await p.acquire(a) as { path: string }
    await writeFile(join(la.path, 'base.txt'), '来自任务甲\n')
    await p.commitAndMerge(a)
    expect(await trunkFile('base.txt')).toContain('用户自己正在改')

    // 用户把自己那份撤了 —— 树干净了。
    await git(['checkout', '--', 'base.txt'], gitRoot)
    const b = node('root/02-b')
    const lb = await p.acquire(b) as { path: string }
    await writeFile(join(lb.path, 'b.ts'), 'B\n')
    expect(await p.commitAndMerge(b)).toMatchObject({ trunk: { advanced: true } })
    // **两笔**都到了:落下的那一笔不需要等到收口。
    expect(await trunkFile('base.txt')).toContain('来自任务甲')
    expect(await trunkFile('b.ts')).toContain('B')
  })
})

describe('收口:用户必须能找到自己的工作(spec §8)', () => {
  it('reports the branch, the commit count and anything left behind', async () => {
    // Without this the run ends having written every change to a branch the user is never
    // told about, in worktrees they do not know exist. Preserved-and-invisible is
    // indistinguishable from lost.
    const p = pool()
    await p.init()
    const done = node('root/01-a')
    const l = await p.acquire(done) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    await p.commitAndMerge(done)
    await p.release(done)

    const stuck = node('root/02-b')
    const ls = await p.acquire(stuck) as { path: string }
    await writeFile(join(ls.path, 'unmerged.ts'), 'never merged\n')
    ;(stuck as { worktree?: unknown }).worktree = { branch: 'x', path: ls.path }

    const h = await p.handoff([done, stuck])
    expect(h.branch).toBe('efftask/001/integration')
    // 逐任务合并已经把它送进 main 了 —— 所以「还没合进你分支的提交数」是 0,而
    // trunkMerged 是 1。两个数一起才说得清这一趟的产出在哪:少了后者,收口那一屏会
    // 对着一次真的合并印「本次没有产生任何改动」。
    expect(h.commits).toBe(0)
    expect(h.trunkLanded).toBe(1)
    expect(h.trunkSkips).toEqual([])
    expect((await git(['show', 'HEAD:shipped.ts'], gitRoot)).stdout).toContain('the work')
    expect(h.kept.map(k => k.path)).toContain(ls.path)
  })

  /**
   * 分析/质疑讨论借来的那棵树在 `releasePlanBase` 里被交回(`node.worktree` 清空),而目录
   * 留给执行环节复用。节点如果在这中间被阻断、或 run 在此刻中止,目录就成了
   * **保留而不可见**:`handoff().kept` 原来只遍历还挂着 `worktree` 的节点,而 `dispose()`
   * 收得掉干净的、收不掉被方案席写脏的那些(它的返回值在编排层被丢弃)。
   *
   * 「保留而不可见」对用户等同于丢失 —— 这是 spec §8 收口那一节的全部理由。
   */
  it('分析阶段借完就交回、但里面还有东西的目录,也要报出去', async () => {
    const p = pool()
    await p.init()
    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, '调研笔记.md'), '方案席留下的\n')
    // 交回 = 只清引用,不动磁盘(执行环节要复用同一个目录)。
    expect(n.worktree).toBeUndefined()

    const kept = (await p.handoff([n])).kept
    expect(kept.map(k => k.path)).toContain(l.path)
    expect(kept.find(k => k.path === l.path)?.why).toContain('分析/质疑讨论')
  })

  /**
   * **只剩被忽略的构建产物 → 不报。**
   *
   * 跑机实测:11 个保留工作区里 8 个的全部「内容」就是 Rust 的 target 目录,
   * 而它们一个提交都没有、`m` 也合不了(那一屏把它们记进 `ignoredOnly`)。
   * 旧判据带 `--ignored`,于是收口屏说「有 8 处产出没送到」,而实际是 0 处。
   */
  /**
   * **构建产物要进 `.git/info/exclude` —— 这是 2 681 个文件进版本库的事前那一半。**
   *
   * 跑机 .30 实测:master 上被跟踪的构建产物 2 608 个文件 / 52.86 GiB,而项目
   * `.gitignore` 里一条相关规则都没有。来历是执行者自建 `.cargo-target-<名字>` 当 cargo
   * 的 target 目录,`commitAndMerge` 的 `add -A` 照单全收。写 `info/exclude` 而不是改
   * 用户的 `.gitignore`(那是被跟踪的文件,替他改并提交是越权),而它对 linked worktree
   * 同样生效 —— 正是需要的那一侧。
   */
  it('init 把构建产物模式写进 .git/info/exclude(执行者的 add -A 才带不走它们)', async () => {
    const p = pool()
    await p.init()
    const excl = await readFile(join(gitRoot, '.git/info/exclude'), 'utf-8')
    for (const want of ['.cargo-target-', '.cargo-task-', 'target/', '.rlib', '.rmeta']) {
      expect(excl).toContain(want)
    }
    // 老两条不许被挤掉 —— 它们治的是「用户的 git status 里有没有我们留下的垃圾」。
    expect(excl).toContain('.claude/efftask/')
    expect(excl).toContain('.efftask-worktrees/')
    // 真闸:节点工作区里建一个 target 目录,git 必须看不见它。
    const n = node('root/09-x')
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, '.cargo-target-probe'), { recursive: true })
    await writeFile(join(l.path, '.cargo-target-probe', 'a.bin'), 'x')
    const st = await git(['status', '--porcelain'], l.path)
    expect(st.stdout).not.toContain('.cargo-target-probe')
  })

  it('交回之后只剩被忽略的构建产物 → 不报(那是 c 键的事,不是「产出没送到」)', async () => {
    // 忽略规则先进**基线提交**,这样节点工作区一建出来就带着它,而 .gitignore 自己
    // 是被跟踪的 —— 目录里唯一剩下的就是被忽略的产物,正是跑机上那 8 个的形态。
    await writeFile(join(gitRoot, '.gitignore'), 'build-out/\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'ignore build-out'], gitRoot)
    const p = pool()
    await p.init()
    const n = node('root/03-c')
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, 'build-out'), { recursive: true })
    await writeFile(join(l.path, 'build-out', 'app.o'), 'binary\n')
    // 反证一次:带 --ignored 时 git 确实看得见它(否则这条探针什么都没测)。
    const withIgnored = await git(['status', '--porcelain', '--ignored'], l.path)
    expect(withIgnored.stdout).toContain('build-out')
    expect((await p.handoff([n])).kept).toEqual([])
  })

  /**
   * **「仍有未合入的内容」有两半,而干净的树只考得到一半。**
   *
   * 判据是「工作区脏 **或** 分支上有集成分支没有的提交」。变异测试实测:把 `|| ahead`
   * 拿掉之后全套照绿 —— 因为没有一条用例造过「树是干净的、活全在提交里」这个形状,
   * 而它恰恰是执行者**已经 commit、但合并没成**时的常态(跑机上那 3 个
   * `commits_ahead_of_int=3` 的工作区就是它)。
   */
  it('工作区干净、但分支上有未合入的提交 → 仍然算「仍有未合入的内容」', async () => {
    const p = pool()
    await p.init()
    const n = node('root/04-d')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'done.txt'), 'work\n')
    await git(['add', '-A'], l.path)
    await git(['commit', '-qm', 'executor committed'], l.path)
    // 树干净了(全提交了),而这一笔还没合进集成分支。
    expect((await git(['status', '--porcelain'], l.path)).stdout.trim()).toBe('')
    const kept = (await p.handoff([n])).kept
    // 引用在不在只影响措辞;「有没有东西没送到」这个结论必须一样。
    expect(kept.map(k => k.path)).toContain(l.path)
    expect(kept.find(k => k.path === l.path)?.why).not.toBe('未回收')
  })

  /**
   * **已经合进集成分支的抢救分支不再列。**
   *
   * `rescue.ts` 写死「成功不删分支」,而这里原来是一句裸 `for-each-ref` —— 于是一条抢救
   * 分支一旦建出来就永久出现在每一次收口屏上,而屏幕紧跟着那行「⚠ …不在集成分支上,
   * git merge 捞不到它们」在合过之后逐字是假话。
   */
  it('抢救分支合进集成分支之后就不再出现在收口屏上', async () => {
    const p = pool()
    await p.init()
    // 造一条真的抢救分支:从集成分支拉出去、加一笔提交。
    const int = 'efftask/001/integration'
    await git(['branch', `efftask/001/salvage/aa11bb22`, int], gitRoot)
    expect((await p.handoff([])).salvage).toEqual([])   // 与集成分支同点 = 已包含
    // 让它真的领先一笔 —— 这时才该被列出来。
    const wt = join(worktreeRoot, 'probe')
    await git(['worktree', 'add', '-q', wt, 'efftask/001/salvage/aa11bb22'], gitRoot)
    await writeFile(join(wt, 'salvaged.txt'), 'work\n')
    await git(['add', '-A'], wt)
    await git(['commit', '-qm', 'salvaged'], wt)
    expect((await p.handoff([])).salvage).toEqual(['efftask/001/salvage/aa11bb22'])
    // 合进集成分支之后又该消失。
    await git(['merge', '--no-verify', '--no-edit', '-q', 'efftask/001/salvage/aa11bb22'], p.integrationPath)
    expect((await p.handoff([])).salvage).toEqual([])
  })

  it('交回之后目录是干净的 → 不报(干净目录出现在收口屏上纯属噪音)', async () => {
    const p = pool()
    await p.init()
    const n = node('root/02-b')
    await p.acquire(n)
    expect((await p.handoff([n])).kept).toEqual([])
  })

  it('says plainly when a run produced nothing', async () => {
    const p = pool()
    await p.init()
    const h = await p.handoff([])
    expect(h.commits).toBe(0)
    expect(h.kept).toEqual([])
  })
})

describe('不把自己的痕迹留在用户的 git status 里', () => {
  it('init excludes the worktree scratch dir via .git/info/exclude', async () => {
    // .efftask-worktrees/ lives under gitRoot, so without this it shows as untracked forever.
    // info/exclude is per-clone and NOT a tracked file, so we are not editing anything the
    // user committed.
    const p = pool()
    await p.init()
    const excl = await git(['check-ignore', '-v', '.efftask-worktrees/'], gitRoot)
    expect(excl.code).toBe(0)
    expect((await git(['status', '--porcelain'], gitRoot)).stdout).not.toContain('.efftask-worktrees')
  })

  it('run 目录(.claude/efftask/)也要排除 —— 否则自动收口永远被自己挡住', async () => {
    /**
     * 这一条不是「顺手」:`/et` 从第一帧就在**用户的检出里**写 `.claude/efftask/<runId>/`,
     * 而收口那条判据(工作区干净才自动合并)原来看 `git status --porcelain` —— 它把未跟踪
     * 文件也算进去,于是每一趟运行结束时都躺着一条 `?? .claude/`,「跑完把产出送回当前
     * 目录」在一个没 gitignore 掉 `.claude/` 的普通仓库里**一次也不会发生**(真 git 实测)。
     *
     * 判据那一侧已经改成只看已跟踪改动(handoffActions.trackedChanges),这里是第二道:
     * 让用户自己的 `git status` 也干净。两条一起写,不是二选一。
     */
    const p = pool()
    await p.init()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(gitRoot, '.claude', 'efftask', '001'), { recursive: true })
    await writeFile(join(gitRoot, '.claude', 'efftask', '001', 'run.md'), '# run\n')
    expect((await git(['check-ignore', '-v', '.claude/efftask/'], gitRoot)).code).toBe(0)
    expect((await git(['status', '--porcelain'], gitRoot)).stdout).not.toContain('.claude')
  })

  it('is idempotent — a second init does not duplicate the entry', async () => {
    const p = pool()
    await p.init()
    await p.init()
    const { readFile } = await import('node:fs/promises')
    const txt = await readFile(join(gitRoot, '.git', 'info', 'exclude'), 'utf-8')
    expect(txt.split('.efftask-worktrees/').length - 1).toBe(1)
  })
})

describe('跨分支依赖调度:一个节点看得见依赖合进来的东西吗', () => {
  const read = async (path: string, file: string): Promise<string> => {
    const r = await git(['show', `HEAD:${file}`], path)
    return r.code === 0 ? r.stdout : ''
  }

  it('a node acquired AFTER a dependency merged starts from that dependency\'s work', async () => {
    // The whole isolation design rests on this: the dependency GATE only guarantees the dep
    // reached ACCEPTED, and ACCEPTED means merged. What makes the downstream node able to
    // BUILD on it is that acquire bases the new worktree on the integration tip. Nothing in
    // the suite proved that, and it is one `worktree add <base>` argument away from silently
    // becoming "based on main" — every node would then plan against a repo that never saw
    // its upstream, and every merge would conflict.
    const p = pool()
    await p.init()
    const dep = node('root/01-dep', '写 schema')
    const lease = await p.acquire(dep)
    if ('error' in lease) throw new Error(lease.error)
    await writeFile(join(lease.path, 'schema.sql'), 'CREATE TABLE t;\n')
    expect(await p.commitAndMerge(dep)).toMatchObject({ ok: true, merged: true })

    const downstream = node('root/02-use', '用 schema')
    const l2 = await p.acquire(downstream)
    if ('error' in l2) throw new Error(l2.error)
    expect(await read(l2.path, 'schema.sql')).toContain('CREATE TABLE t;')
  })

  it('a worktree acquired BEFORE the merge is stale — which is what refresh exists for', async () => {
    // Measured, and the reason 跨分支依赖调度 needed anything at all: acquire freezes the
    // base. A node that sits in a rework loop while siblings merge is editing a tree that no
    // longer matches what it will merge into.
    const p = pool()
    await p.init()
    const early = node('root/01-early', '早开工的')
    const l1 = await p.acquire(early)
    if ('error' in l1) throw new Error(l1.error)

    const other = node('root/02-other', '别人')
    const l2 = await p.acquire(other)
    if ('error' in l2) throw new Error(l2.error)
    await writeFile(join(l2.path, 'shared.ts'), 'export const a = 1\n')
    await p.commitAndMerge(other)

    // Stale by construction.
    expect(await read(l1.path, 'shared.ts')).toBe('')
    const sync = await p.refreshFromIntegration(early)
    expect(sync).toEqual({ ok: true, updated: true })
    expect(await read(l1.path, 'shared.ts')).toContain('export const a = 1')
  })

  it('refresh commits the executor\'s loose work instead of refusing on a dirty tree', async () => {
    // `git merge` refuses to start on a dirty tree, and a rework round is exactly when the
    // tree is dirty. Reporting that as a failure would make the refresh useless precisely
    // where it is needed.
    const p = pool()
    await p.init()
    const a = node('root/01-a')
    const l = await p.acquire(a)
    if ('error' in l) throw new Error(l.error)
    await writeFile(join(l.path, 'mine.ts'), 'mine\n')

    const other = node('root/02-b')
    const l2 = await p.acquire(other)
    if ('error' in l2) throw new Error(l2.error)
    await writeFile(join(l2.path, 'theirs.ts'), 'theirs\n')
    await p.commitAndMerge(other)

    expect(await p.refreshFromIntegration(a)).toEqual({ ok: true, updated: true })
    // BOTH survive: the loose work was committed, not discarded.
    expect(await read(l.path, 'mine.ts')).toContain('mine')
    expect(await read(l.path, 'theirs.ts')).toContain('theirs')
  })

  it('says "nothing to do" instead of manufacturing an empty commit', async () => {
    const p = pool()
    await p.init()
    const a = node('root/01-a')
    await p.acquire(a)
    expect(await p.refreshFromIntegration(a)).toEqual({ ok: true, updated: false })
  })

  it('leaves NO conflict behind when the refresh conflicts', async () => {
    // The rework loop is not the place to hand someone a conflicted tree: the executor was
    // asked to fix acceptance blockers, and would find <<<<<<< markers it did not expect in
    // files it may not even be working on. Staying on the old base is the honest answer —
    // the merge at the end still catches it and routes it through the §8 conflict path.
    const p = pool()
    await p.init()
    const a = node('root/01-a')
    const la = await p.acquire(a)
    if ('error' in la) throw new Error(la.error)
    const b = node('root/02-b')
    const lb = await p.acquire(b)
    if ('error' in lb) throw new Error(lb.error)

    await writeFile(join(la.path, 'shared.txt'), 'A 的版本\n')
    await writeFile(join(lb.path, 'shared.txt'), 'B 的版本\n')
    await p.commitAndMerge(b)

    const sync = await p.refreshFromIntegration(a)
    expect(sync.ok).toBe(false)
    if (sync.ok) return
    expect(sync.conflicted).toBe(true)
    // No markers, no MERGE_HEAD, nothing half-done — and A's own work intact.
    const st = await git(['status', '--porcelain'], la.path)
    expect(st.stdout.trim()).toBe('')
    expect(await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], la.path)).toMatchObject({ code: 1 })
    expect(await read(la.path, 'shared.txt')).toContain('A 的版本')
  })

  it('a refreshed node still merges cleanly afterwards', async () => {
    // The point of refreshing: the eventual merge becomes a fast-forward instead of a
    // three-way merge over hunks neither side has seen.
    const p = pool()
    await p.init()
    const a = node('root/01-a')
    const la = await p.acquire(a)
    if ('error' in la) throw new Error(la.error)
    const b = node('root/02-b')
    const lb = await p.acquire(b)
    if ('error' in lb) throw new Error(lb.error)
    await writeFile(join(lb.path, 'theirs.ts'), 'theirs\n')
    await p.commitAndMerge(b)

    await writeFile(join(la.path, 'mine.ts'), 'mine\n')
    expect(await p.refreshFromIntegration(a)).toEqual({ ok: true, updated: true })

    // THE property, and it was never asserted: after refreshing, the node's branch CONTAINS
    // the integration tip, so the merge is a fast-forward rather than a three-way merge over
    // hunks neither side has seen. Without this the test passed with refreshFromIntegration
    // gutted to a no-op — mine.ts and theirs.ts are different files and merge cleanly anyway.
    const intTip = (await git(['rev-parse', 'efftask/001/integration'], gitRoot)).stdout.trim()
    const contains = await git(['merge-base', '--is-ancestor', intTip, 'HEAD'], la.path)
    expect(contains.code).toBe(0)

    expect(await p.commitAndMerge(a)).toMatchObject({ ok: true, merged: true })
    const intFile = await git(['show', `efftask/001/integration:mine.ts`], gitRoot)
    expect(intFile.stdout).toContain('mine')
  })
})

/**
 * 集成工作区被别人弄脏 —— 一次合并失败干掉整棵树。
 *
 * 实测事故(跑机 run 001,节点 `01-rust-环境初始化`):方案席和两个评审席都
 * `cd .efftask-worktrees/integration` 跑了 `devenv shell cargo check --workspace`,
 * devenv 改写了**受跟踪的** devenv.lock 并留在那儿。40 分钟后该节点测试验证 3 轮、
 * 验收 1 轮全部通过,合并却报「您对下列文件的本地修改将被合并操作覆盖:devenv.lock」,
 * 节点阻断,9 个兄弟节点全部「依赖阻断」,整个 run 死掉。
 *
 * **用例的形状是必要条件,不是随便挑的**:git 只在「本地脏文件同时被并入方改动」时才拒绝。
 * 探针实测过 —— 脏文件与节点分支不相交时 merge 照常成功(脏改动原样留着),那种写法的用例
 * 在不改任何实现的前提下就是绿的,证明不了任何事。所以:节点分支必须**提交对同一个文件的
 * 改动**,intPath 里必须对**同一个文件**做未提交修改。
 */
describe('合并撞上被弄脏的集成工作区:洗掉重试,而不是把整棵树打死', () => {
  const intPathOf = () => join(worktreeRoot, 'integration')

  it('受跟踪文件脏且与节点分支重叠 → 清理后重试合并成功,节点的那一版进了集成分支', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    // 基线上先有这个文件,两边才谈得上「重叠」
    await writeFile(join(gitRoot, 'devenv.lock'), 'v1\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'lock v1'], gitRoot)
    await git(['branch', '-f', 'efftask/001/integration', 'HEAD'], gitRoot)
    await git(['-C', intPathOf(), 'reset', '--hard', 'efftask/001/integration'], gitRoot)

    const n = node('a')
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error(lease.error)
    n.worktree = { branch: lease.branch, path: lease.path }
    await writeFile(join(lease.path, 'devenv.lock'), 'v2-node\n')

    // 席位在共享的集成工作区里跑了构建,改了同一个受跟踪文件,没提交
    await writeFile(join(intPathOf(), 'devenv.lock'), 'v1-dirtied-by-a-reviewer\n')

    const res = await p.commitAndMerge(n)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.merged).toBe(true)
    // 清掉了什么必须报出来 —— 那个目录用户被告知「下次运行会复用」
    expect(res.cleaned).toBeDefined()
    expect(res.cleaned!.join('\n')).toContain('devenv.lock')
    // 节点的成果没有被清理顺手吞掉
    const merged = await git(['show', 'efftask/001/integration:devenv.lock'], gitRoot)
    expect(merged.stdout.trim()).toBe('v2-node')

    /**
     * **`cleaned` 只是一份讣告 —— 名字救不回任何东西。**
     *
     * 这条路是**自动跑**的主路径,而它此前对那棵共享的树零保护:席位在里面跑过构建、
     * 手工解过一半的冲突,`reset --hard` + `clean -fd` 一过就一个字节都不剩,
     * 屏幕上只有一串文件名。判据落在「**取不取得回来**」上,不落在返回值上。
     */
    expect(res.pinned).toBeDefined()
    /**
     * **判据落在未跟踪那一格上** —— 这棵树上最常见的一份丢失就是它(席位跑构建留下的
     * 产物),而 `git stash create` 拿不到未跟踪文件。只验已跟踪的那半等于只证明了容易的一半。
     *
     * 取内容用 `^3`:未跟踪的文件住在 stash 的**第三个父提交**里,主树上没有它。
     * (用户那条 `git stash apply` 在这里会报 “already exists” —— 因为合并之后同名文件
     * 已经回来了。那是 git 的正常行为,而这条探针要问的是「内容还在不在」。)
     */
    const back = await git(['show', `${res.pinned}^3:devenv.lock`], gitRoot)
    expect(back.code).toBe(0)
    expect(back.stdout.trim()).toBe('v1-dirtied-by-a-reviewer')
    // 而**用户自己的** stash 列表不许因此多出一条 —— refs/stash 是整个仓库共享的。
    expect((await git(['stash', 'list'], gitRoot)).stdout.trim()).toBe('')
  })

  /** 树本来就干净时不许写 ref —— 正常路径上这个原语必须是零成本、零噪音的。 */
  it('集成工作区干净时,不留下任何快照 ref', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const n = node('clean-one')
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error(lease.error)
    n.worktree = { branch: lease.branch, path: lease.path }
    await writeFile(join(lease.path, 'ok.txt'), 'fine\n')
    const res = await p.commitAndMerge(n)
    expect(res.ok).toBe(true)
    const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/et/rescued'], gitRoot)
    expect(refs.stdout.trim()).toBe('')
  })

  it('未跟踪文件挡路时同样能过 —— clean -fd 那一半也要有测试', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const n = node('b')
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error(lease.error)
    n.worktree = { branch: lease.branch, path: lease.path }
    await writeFile(join(lease.path, 'brandnew.txt'), 'from node\n')
    // 同名未跟踪文件躺在集成工作区里:git 会拒绝「would be overwritten by merge」
    await writeFile(join(intPathOf(), 'brandnew.txt'), 'left by someone\n')

    const res = await p.commitAndMerge(n)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.cleaned!.join('\n')).toContain('brandnew.txt')
    const merged = await git(['show', 'efftask/001/integration:brandnew.txt'], gitRoot)
    expect(merged.stdout.trim()).toBe('from node')
  })

  it('真冲突不许被重试吞掉:仍然报 conflict,而且报的是冲突文件', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    await writeFile(join(gitRoot, 'shared.txt'), 'v1\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'shared v1'], gitRoot)
    await git(['branch', '-f', 'efftask/001/integration', 'HEAD'], gitRoot)
    await git(['-C', intPathOf(), 'reset', '--hard', 'efftask/001/integration'], gitRoot)

    // 先让一个节点把改动合进集成分支
    const first = node('c1')
    const l1 = await p.acquire(first)
    if ('error' in l1) throw new Error(l1.error)
    first.worktree = { branch: l1.branch, path: l1.path }
    await writeFile(join(l1.path, 'shared.txt'), 'from c1\n')
    expect((await p.commitAndMerge(first)).ok).toBe(true)

    // 第二个节点基于旧基线改同一行 → 真冲突
    const second = node('c2')
    const l2 = await p.acquire(second)
    if ('error' in l2) throw new Error(l2.error)
    second.worktree = { branch: l2.branch, path: l2.path }
    await git(['-C', l2.path, 'reset', '--hard', 'HEAD~1'], gitRoot)
    await writeFile(join(l2.path, 'shared.txt'), 'from c2\n')

    const res = await p.commitAndMerge(second)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.kind).toBe('conflict')
  })
})

/**
 * 洗掉重试那条路上的三个出口 —— 成功之外的两个也要说清「刚才抹掉了什么」,
 * 而且**不许在一棵不属于自己的树上重试**。
 */
describe('洗掉重试:失败出口同样要报 cleaned;不在集成分支上就拒绝重试', () => {
  const intPathOf = () => join(worktreeRoot, 'integration')

  /** 让基线上有 shared.txt,并把集成分支对齐到它。 */
  async function seedShared(): Promise<void> {
    await writeFile(join(gitRoot, 'shared.txt'), 'v1\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'shared v1'], gitRoot)
    await git(['branch', '-f', 'efftask/001/integration', 'HEAD'], gitRoot)
    await git(['-C', intPathOf(), 'reset', '--hard', 'efftask/001/integration'], gitRoot)
  }

  it('重试之后撞上真冲突:仍报 conflict,而且把被抹掉的用户文件一起报出来', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    await seedShared()
    // 先让一个节点把 shared.txt 改动合进集成分支
    const first = node('d1')
    const l1 = await p.acquire(first)
    if ('error' in l1) throw new Error(l1.error)
    first.worktree = { branch: l1.branch, path: l1.path }
    await writeFile(join(l1.path, 'shared.txt'), 'from d1\n')
    expect((await p.commitAndMerge(first)).ok).toBe(true)

    // 第二个节点基于旧基线改同一行(→ 真冲突),同时集成工作区里有别的脏东西挡住第一次合并
    const second = node('d2')
    const l2 = await p.acquire(second)
    if ('error' in l2) throw new Error(l2.error)
    second.worktree = { branch: l2.branch, path: l2.path }
    await git(['-C', l2.path, 'reset', '--hard', 'HEAD~1'], gitRoot)
    await writeFile(join(l2.path, 'shared.txt'), 'from d2\n')
    await writeFile(join(l2.path, 'onlyd2.txt'), 'x\n')
    await writeFile(join(intPathOf(), 'onlyd2.txt'), 'left by a reviewer\n')
    await writeFile(join(intPathOf(), 'precious-user-file.txt'), '用户自己放的\n')

    const res = await p.commitAndMerge(second)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.kind).toBe('conflict')
    // 用户文件被 clean -fd 抹掉了 —— 这一条出口以前一个字都不说
    expect(res.cleaned).toBeDefined()
    expect(res.cleaned!.join('\n')).toContain('precious-user-file.txt')
  })

  it('集成工作区被切到别的分支:拒绝重试,并说清它在哪儿', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    await seedShared()
    const n = node('e1')
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error(lease.error)
    n.worktree = { branch: lease.branch, path: lease.path }
    await writeFile(join(lease.path, 'shared.txt'), 'from e1\n')

    // 有人把共享的集成工作区切走了(run 002 复用 run 001 留下的目录就是这个形状)
    await git(['-C', intPathOf(), 'checkout', '-q', '-b', 'somebody-elses-branch'], gitRoot)
    await writeFile(join(intPathOf(), 'shared.txt'), 'dirty\n')

    const res = await p.commitAndMerge(n)
    expect(res.ok).toBe(false)
    if (res.ok || res.kind !== 'infra') throw new Error('expected infra')
    expect(res.message).toContain('somebody-elses-branch')
    expect(res.message).toContain('efftask/001/integration')
    // 没有把这个节点的提交合进别人的分支。
    // **只看提交信息,不要 `--oneline`**:那一行开头是 7 位 sha,而 sha 是随机的 ——
    // 十六进制里出现 `e1` 的概率不低(实测抓到过一次 `3e58e19 base`),这条断言会隔三差五
    // 无缘无故地红一次,而它红的时候和被测行为毫无关系。
    const theirs = await git(['log', '--format=%s', 'somebody-elses-branch'], gitRoot)
    expect(theirs.stdout).not.toContain('e1')
  })
})

/**
 * `init()` 建不起池子 = 这一趟 `serialiseExecute` 恒为真 = **并发全丢**,而且每一次
 * `--resume` 都原样重演(没有任何路径会去动这两种残留)。
 *
 * 跑机实测(qianbase-xtp run 001):`parallelism: 20`、44 个 READY、只有 1 个席位在飞,
 * 连着好几天。用户的原话是「这个任务怎么感觉并行不起来」。
 */
describe('init 对两种「永久建不起池子」的残留自愈', () => {
  const intPathOf = (): string => join(worktreeRoot, 'integration')

  it('孤儿目录:盘上有、git 不认 —— 挪走并重试,不是放弃', async () => {
    expect(await pool().init()).toEqual({ ok: true })
    // 现场的形状:登记项没了(仓库被移动过 + init 自己那句 worktree prune),
    // 工作树目录原地留着,`.git` 文件指向一个不存在的 gitdir。
    await rm(join(gitRoot, '.git', 'worktrees', 'integration'), { recursive: true, force: true })
    await writeFile(join(intPathOf(), 'leftover.txt'), '15G 的 target/ 就是这么留下的\n')

    // 修之前:rev-parse 128 → prune 不删目录 → add 报 already exists。
    const probe = await git(['rev-parse', '--git-dir'], intPathOf())
    expect(probe.code).not.toBe(0)
    const wouldFail = await git(['worktree', 'add', intPathOf(), 'efftask/001/integration'], gitRoot)
    expect(wouldFail.code).not.toBe(0)
    expect(wouldFail.stderr).toContain('already exists')

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    // 池子真的可用了 —— 不是「返回了 ok」,是集成工作区真的在 git 的名册上。
    expect((await git(['rev-parse', '--git-dir'], intPathOf())).code).toBe(0)
    // 挪走,**不删**:那个目录里可能有 git 此刻读不出来的东西。
    expect(await readFile(join(`${intPathOf()}.orphan`, 'leftover.txt'), 'utf-8')).toContain('15G')
    expect(p.healNotes().join('\n')).toContain('孤儿目录')
  })

  it('集成分支被自建工作树占着 —— 让它 detach 再重试', async () => {
    expect(await pool().init()).toEqual({ ok: true })
    // 一棵节点工作树坐到了集成分支上(执行者自己 checkout 过就是这个形状),
    // 而集成工作区的目录不在了。
    await git(['worktree', 'remove', '--force', intPathOf()], gitRoot)
    const squatter = join(worktreeRoot, 'efftask-001-squatter')
    expect((await git(['worktree', 'add', squatter, 'efftask/001/integration'], gitRoot)).code).toBe(0)
    const wouldFail = await git(['worktree', 'add', intPathOf(), 'efftask/001/integration'], gitRoot)
    expect(wouldFail.stderr).toContain('already used by worktree')

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    expect((await git(['rev-parse', '--git-dir'], intPathOf())).code).toBe(0)
    // detach 而不是删除:那棵树上可能有还没合走的提交。
    expect(await exists(squatter)).toBe(true)
    expect(p.healNotes().join('\n')).toContain('detached HEAD')
  })

  it('占着分支的不是我们建的树 —— 一个字节都不碰,把它是谁说出来', async () => {
    expect(await pool().init()).toEqual({ ok: true })
    await git(['worktree', 'remove', '--force', intPathOf()], gitRoot)
    // 用户自己的检出(在 worktreeRoot 外面)。切进去动它 = 把别人正在干活的树掀了。
    const theirs = join(gitRoot, '..', 'their-checkout')
    expect((await git(['worktree', 'add', theirs, 'efftask/001/integration'], gitRoot)).code).toBe(0)

    const p = pool()
    const r = await p.init()
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.reason).toContain('那不是本次运行建的工作树')
    // 还在原来的分支上 —— 没被 detach。
    const still = await git(['rev-parse', '--abbrev-ref', 'HEAD'], theirs)
    expect(still.stdout.trim()).toBe('efftask/001/integration')
  })

  it('一切正常时不动任何东西(自愈只在 add 真的失败之后发生)', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    expect(await p.init()).toEqual({ ok: true }) // 可重入
    expect(p.healNotes()).toEqual([])
    expect(await exists(`${intPathOf()}.orphan`)).toBe(false)
  })
})

async function exists(p: string): Promise<boolean> {
  try { await readFile(join(p, '.git')); return true } catch { /* fallthrough */ }
  try { const { stat } = await import('node:fs/promises'); await stat(p); return true } catch { return false }
}

/**
 * **目录被清掉、分支没删 → 这个节点永久起不来。**
 *
 * `acquire` 的重建路径用 `-b`(新建分支),而 `-f` 只强制路径。分支名是 `hash(nodeId)`,
 * 不随时间变 —— 所以重做走的是逐字相同的一条路,用户报的原话是「重做也一样失败」。
 *
 * 跑机实测(10.10.20.13 / qianbase-xtp,2026-08-11):154 条节点分支里 10 条是这个形状
 * (用户自己 `rm -rf .efftask-worktrees/` 之后必然如此),报错逐字是
 * `无法为该节点准备隔离工作区,拒绝在共享工作区执行: 无法创建工作区: fatal: 一个分支名
 * 'worktree-efftask-001-54b6ba01' 已经存在`。
 */
describe('acquire 撞上残留的节点分支', () => {
  /** 用户清掉工作区目录、分支留下 —— 跑机上那 10 条的形状。 */
  async function orphanBranch(n: TaskNode): Promise<string> {
    const lease = await (async () => {
      const p = pool()
      expect(await p.init()).toEqual({ ok: true })
      const l = await p.acquire(n)
      if ('error' in l) throw new Error(l.error)
      return l
    })()
    await git(['worktree', 'remove', '--force', lease.path], gitRoot)
    // `worktree remove` 会连分支一起留下 —— 这正是现场的形状。
    expect((await git(['rev-parse', '--verify', '--quiet', lease.branch], gitRoot)).code).toBe(0)
    return lease.branch
  }

  it('分支已全部合进集成分支 → 复用它,节点跑得起来', async () => {
    const n = node('e1')
    const branch = await orphanBranch(n)
    // 修之前:worktree add -b 报 already exists,节点当场阻断。
    const wouldFail = await git(['worktree', 'add', '-f', '-b', branch, join(worktreeRoot, 'x'), 'efftask/001/integration'], gitRoot)
    expect(wouldFail.code).not.toBe(0)

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const lease = await p.acquire(n)
    expect('error' in lease).toBe(false)
    if ('error' in lease) throw new Error(lease.error)
    expect(lease.branch).toBe(branch)
    expect((await git(['rev-parse', '--git-dir'], lease.path)).code).toBe(0)
    expect(p.healNotes().join('\n')).toContain('复用残留分支')
  })

  /**
   * **分支上还有没合走的提交时,先存 salvage 再重置。**
   * 这是 acquire 复用目录那条路上 salvage 段防的同一件事,只是换成重建目录这条路 ——
   * 少了它,`-B` 会把那次执行的产出重置进 0 个 ref。
   */
  it('分支上有没合走的提交 → 先存 salvage 分支,再重置', async () => {
    const n = node('e2')
    const p0 = pool()
    expect(await p0.init()).toEqual({ ok: true })
    const l0 = await p0.acquire(n)
    if ('error' in l0) throw new Error(l0.error)
    await writeFile(join(l0.path, 'only-here.txt'), '没合走的活\n')
    await git(['add', '-A'], l0.path)
    await git(['commit', '-qm', 'e2 干了活但没合'], l0.path)
    const lost = (await git(['rev-parse', 'HEAD'], l0.path)).stdout.trim()
    await git(['worktree', 'remove', '--force', l0.path], gitRoot)

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const lease = await p.acquire(n)
    if ('error' in lease) throw new Error(lease.error)
    // 提交还在 —— 存到了 salvage 分支上,没有被 `-B` 重置掉。
    const salvage = (await git(['rev-parse', 'efftask/001/salvage/' + lease.branch.replace('worktree-', '')], gitRoot)).stdout.trim()
    expect(salvage).toBe(lost)
    // 而新工作区是从集成分支重开的 —— 那个文件不在里面(salvage 是它唯一的去处)。
    expect(await readFile(join(lease.path, 'only-here.txt'), 'utf-8').catch(() => 'gone')).toBe('gone')
    expect(p.healNotes().join('\n')).toContain('已先存到')
  })

/**
   * **存不下来就绝不重置。** 宁可这个节点报错,不可静默丢掉一次执行的产出。
   *
   * 用一条**同名的父 ref** 挡住 salvage:git 的 ref 存在文件系统上,
   * 有了分支 `efftask/001/salvage` 就再也建不出 `efftask/001/salvage/<slug>`
   * (`cannot lock ref`)。这是真会发生的形状 —— 只要有人手工建过那条分支。
   */
  it('salvage 存不下来 → 拒绝重置,提交仍在原分支上', async () => {
    const n = node('e4')
    const p0 = pool()
    expect(await p0.init()).toEqual({ ok: true })
    const l0 = await p0.acquire(n)
    if ('error' in l0) throw new Error(l0.error)
    await writeFile(join(l0.path, 'only-here.txt'), '没合走的活\n')
    await git(['add', '-A'], l0.path)
    await git(['commit', '-qm', 'e4 干了活但没合'], l0.path)
    const lost = (await git(['rev-parse', 'HEAD'], l0.path)).stdout.trim()
    await git(['worktree', 'remove', '--force', l0.path], gitRoot)
    // 把 salvage 的父路径占成一条分支 —— 之后任何 efftask/001/salvage/* 都建不出来。
    expect((await git(['branch', 'efftask/001/salvage', 'HEAD'], gitRoot)).code).toBe(0)

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const lease = await p.acquire(n)
    // 报错而不是重置。
    expect('error' in lease).toBe(true)
    if (!('error' in lease)) throw new Error('expected refusal')
    expect(lease.error).toContain('没有重置它')
    // 活还在原地 —— 这条断言才是这个测试的全部意义。
    const still = await git(['rev-parse', (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-efftask-001-*'], gitRoot)).stdout.trim()], gitRoot)
    expect(still.stdout.trim()).toBe(lost)
  })

  /**
   * **add 因为别的原因失败时,不许给出一句关于分支的假诊断。**
   *
   * 判据是「这条分支在不在」,而且是在**发 add 之前**问的 —— 补救式的写法只能靠解析
   * git 的报错文本来分辨,而那句话随 locale 变(跑机上是中文)。这条钉的是:分支不存在时
   * 整条自愈路径不参与,报出去的是 git 的真因,healNotes 一个字都不多。
   */
  it('路径被一个普通目录占着 → 报的是 git 的真因,不是编出来的分支诊断', async () => {
    const n = node('e5')
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    // 目录在、但不是工作树(rev-parse --git-dir 失败 → 走重建那条路)
    await mkdir(join(worktreeRoot, worktreeSlug('001', 'e5')), { recursive: true })
    await writeFile(join(worktreeRoot, worktreeSlug('001', 'e5'), 'junk.txt'), 'x\n')

    const lease = await p.acquire(n)
    expect('error' in lease).toBe(true)
    if (!('error' in lease)) throw new Error('expected failure')
    expect(lease.error).not.toContain('残留分支')
    expect(p.healNotes()).toEqual([])
  })

/**
   * **最常见的那一种:目录被手工删掉,`.git/worktrees/<slug>` 登记项还在。**
   *
   * 跑机实测(10.10.20.13 / etcd3):32 条登记项里 **31 条**是这个形状。git 在这种状态下
   * 拒绝一切动作 —— `branch -D` 回「无法删除检出于 … 的分支」、`worktree add` 回
   * already used,而那个「…」指向的目录根本不存在,所以 `checkout --detach` 也没地方跑。
   * 唯一的出路是 `worktree prune`,而 `acquire` 这条路上从来没有调过它。
   */
  it('登记项还在、目录被手工删掉 → prune 掉再重建', async () => {
    const n = node('e6')
    const p0 = pool()
    expect(await p0.init()).toEqual({ ok: true })
    const l0 = await p0.acquire(n)
    if ('error' in l0) throw new Error(l0.error)
    // 手工删目录(用户清空间时就是这么干的),**不动登记项**。
    await rm(l0.path, { recursive: true, force: true })
    expect((await git(['worktree', 'list', '--porcelain'], gitRoot)).stdout).toContain('prunable')
    // 修之前:分支被一棵不存在的工作树占着,连删都删不掉。
    const cantDelete = await git(['branch', '-D', l0.branch], gitRoot)
    expect(cantDelete.code).not.toBe(0)

    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const lease = await p.acquire(n)
    expect('error' in lease).toBe(false)
    if ('error' in lease) throw new Error(lease.error)
    expect((await git(['rev-parse', '--git-dir'], lease.path)).code).toBe(0)
    expect((await git(['worktree', 'list', '--porcelain'], gitRoot)).stdout).not.toContain('prunable')
  })

  /** 正常路径一个字都不说 —— 自愈只在 add 真的失败之后发生。 */
  it('没有残留时不留任何自愈记录', async () => {
    const p = pool()
    expect(await p.init()).toEqual({ ok: true })
    const lease = await p.acquire(node('e3'))
    expect('error' in lease).toBe(false)
    expect(p.healNotes()).toEqual([])
  })
})

/**
 * **重做要求的那次销毁**(用户第 2、4 条)—— 打在真 git 上。
 *
 * 今天这条路走 `release()`,而它的判据是「干净(带 `--ignored`)+ 已合入」——
 * `target/` 的存在必然让它拒绝。于是重做在真实运行里一个工作区都放不掉,而**执行者读到的
 * 注记**逐字写着「隔离工作区已重置为集成分支最新状态」。
 */
describe('discard —— 重做时把工作区整个删掉', () => {
  it('删掉目录、删掉分支,连被忽略的构建产物一起', async () => {
    await writeFile(join(gitRoot, '.gitignore'), 'target/\n')
    await git(['add', '-A'], gitRoot); await git(['commit', '-qm', 'ignore target'], gitRoot)
    const p = pool()
    await p.init()
    const n = node('root/10-d')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'x\n')
    await p.commitAndMerge(n)               // 产出已合入 → 没有东西要抢救
    await mkdir(join(l.path, 'target'), { recursive: true })
    await writeFile(join(l.path, 'target', 'big.o'), 'x'.repeat(4096))

    const r = await p.discard(n)
    expect(r.removed).toBe(true)
    expect(r.salvaged).toBeUndefined()
    expect(await exists(l.path)).toBe(false)
    expect((await git(['rev-parse', '--verify', p.worktreeBranchOf(n)], gitRoot)).code).not.toBe(0)
  })

  /**
   * **未提交的产出必须先被固化。**
   *
   * 评审在真 git 上量过不固化的后果:节点分支上一笔提交都没有(执行产出在
   * `commitAndMerge` 之前一直是未提交的)时,抢救闸判「无需抢救」,删完
   * `git fsck --lost-found` 无输出、文件无从恢复。用户第 8 条:不能丢弃了。
   */
  it('执行者还没提交的产出:先固化再抢救,删完仍然找得回来', async () => {
    const p = pool()
    await p.init()
    const n = node('root/11-loose')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'newfeature.ts'), 'the deliverable\n')  // 一笔提交都没有

    const r = await p.discard(n)
    expect(r.removed).toBe(true)
    expect(r.salvaged).toBeDefined()
    expect(await exists(l.path)).toBe(false)
    // 内容逐字找得回来 —— 这条断言是这个功能存在的全部理由。
    const show = await git(['show', `${r.salvaged}:newfeature.ts`], gitRoot)
    expect(show.code).toBe(0)
    expect(show.stdout).toBe('the deliverable\n')
  })

  /**
   * **`branch -f` 会静默毁掉上一次的抢救** —— 名字必须唯一。
   *
   * 同一个节点被 discard 两次(重做 → 再执行 → 再重做),抢救名是 `hash(nodeId)`、不随时间变。
   * 评审实测:第二次之后上一版落在**零个 ref** 上,而收口和 `m` 键都走 `for-each-ref`。
   */
  it('同一个节点抢救两次:第一版不会被第二版顶掉', async () => {
    const p = pool()
    await p.init()
    const n = node('root/12-twice')

    const l1 = await p.acquire(n) as { path: string }
    await writeFile(join(l1.path, 'v1.ts'), 'first version\n')
    const r1 = await p.discard(n)
    expect(r1.salvaged).toBeDefined()

    const l2 = await p.acquire(n) as { path: string }
    await writeFile(join(l2.path, 'v2.ts'), 'second version\n')
    const r2 = await p.discard(n)
    expect(r2.salvaged).toBeDefined()
    // 两条不同的 ref —— 而且第一版的内容仍然读得出来。
    expect(r2.salvaged).not.toBe(r1.salvaged)
    expect((await git(['show', `${r1.salvaged}:v1.ts`], gitRoot)).stdout).toBe('first version\n')
    expect((await git(['show', `${r2.salvaged}:v2.ts`], gitRoot)).stdout).toBe('second version\n')
    // 两条都在 for-each-ref 里看得见(收口报告和 m 键读的就是它)。
    const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/efftask/001/salvage'], gitRoot)
    expect(refs.stdout).toContain(r1.salvaged!)
    expect(refs.stdout).toContain(r2.salvaged!)
  })

  /** 已经被新 tip 包含的那条**重用**,不在盘上堆一串互为祖先的 ref。 */
  it('上一条抢救已被新 tip 包含时重用同一个名字', async () => {
    const p = pool()
    await p.init()
    const n = node('root/13-reuse')
    const l1 = await p.acquire(n) as { path: string }
    await writeFile(join(l1.path, 'a.ts'), 'a\n')
    const r1 = await p.discard(n)
    // 从抢救出来的那条继续往下做 —— 新 tip 包含旧 tip。
    const add = await git(['worktree', 'add', '--detach', join(worktreeRoot, 'tmp13'), r1.salvaged!], gitRoot)
    expect(add.code).toBe(0)
    await writeFile(join(worktreeRoot, 'tmp13', 'b.ts'), 'b\n')
    await git(['add', '-A'], join(worktreeRoot, 'tmp13'))
    await git(['commit', '-qm', 'more'], join(worktreeRoot, 'tmp13'))
    const tip = (await git(['rev-parse', 'HEAD'], join(worktreeRoot, 'tmp13'))).stdout.trim()
    await git(['branch', '-f', p.worktreeBranchOf(n), tip], gitRoot)
    await git(['worktree', 'remove', '--force', join(worktreeRoot, 'tmp13')], gitRoot)
    // 重新造一个工作区,让 discard 走一次。
    const l2 = await p.acquire(n) as { path: string }
    void l2
    await git(['reset', '--hard', tip], l2.path)
    const r2 = await p.discard(n)
    expect(r2.salvaged).toBe(r1.salvaged)
  })

  /** 目录本来就不在 = 没什么可做,不是失败。 */
  it('目录已经不在时报成功而不是失败', async () => {
    const p = pool()
    await p.init()
    const n = node('root/14-absent')
    const r = await p.discard(n)
    expect(r.removed).toBe(true)
  })

  /**
   * **探不明白就不动手。** 「你还有东西没合」和「我没探明白」要做的事不一样,
   * 而这一步是不可逆的。
   */
  it('merge-base 探测失败时拒绝删除', async () => {
    const p0 = pool()
    await p0.init()
    const n = node('root/15-unknown')
    await p0.acquire(n)
    // 只把那一问打成 128,别的 git 调用照常。
    const broken = createWorktreePool({
      runId: '001', gitRoot, worktreeRoot,
      git: async (args, cwd) => (
        args[0] === 'merge-base' ? { code: 128, stdout: '', stderr: 'fatal: 坏了' } : git(args, cwd)
      ),
    })
    const r = await broken.discard(n)
    expect(r.removed).toBe(false)
    expect(r.keptBecause).toContain('无法判断')
    expect(await exists(p0.worktreePathOf(n))).toBe(true)
  })
})

/**
 * **嵌套 git 仓库一律拒绝删除。**
 *
 * 验收在真 git 上量过不拒绝的后果:`add -A` 对它只记一个 gitlink,而
 * `worktree remove --force` 把目录整个删掉 —— 对象库跟着没,存下来的抢救分支里是一个
 * **悬空指针**,而屏幕照样念「已抢救,可用 git show 查看」。
 */
describe('discard 遇到嵌套 git 仓库', () => {
  it('拒绝删除,并说清是哪几个目录', async () => {
    const p = pool()
    await p.init()
    const n = node('root/16-nested')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'work.ts'), 'x\n')
    const sub = join(l.path, 'vendored')
    await mkdir(sub, { recursive: true })
    await git(['init', '-q', '-b', 'main', '.'], sub)
    await git(['config', 'user.email', 's@s'], sub)
    await git(['config', 'user.name', 's'], sub)
    await writeFile(join(sub, 'secret.txt'), 'not pushed anywhere\n')
    await git(['add', '-A'], sub)
    await git(['commit', '-qm', 'v'], sub)

    const r = await p.discard(n)
    expect(r.removed).toBe(false)
    expect(r.keptBecause).toContain('嵌套')
    expect(r.keptBecause).toContain('vendored')
    // 一个字节都没动:目录还在,里面那个仓库的提交也还在。
    expect(await exists(join(sub, 'secret.txt'))).toBe(true)
    expect(await exists(l.path)).toBe(true)
  })

  /** 没有嵌套仓库时照旧删 —— 这道闸不许把正常路径也挡住。 */
  it('没有嵌套仓库时不受影响', async () => {
    const p = pool()
    await p.init()
    const n = node('root/17-plain')
    const l = await p.acquire(n) as { path: string }
    await mkdir(join(l.path, 'sub'), { recursive: true })
    await writeFile(join(l.path, 'sub', 'a.ts'), 'x\n')
    const r = await p.discard(n)
    expect(r.removed).toBe(true)
    expect(await exists(l.path)).toBe(false)
  })
})

/**
 * **「已暂存」那一格:git 的保护不再是逐文件的。**
 *
 * 评审席真 git 实测:快进时索引脏不影响合并;而**真三方合并**(用户在 run 期间自己提交
 * 过)时,索引里**任何一个**文件脏就整个被拒,而 git 点名的那个文件**这次合并根本没碰**。
 * 上一版把那句英文原样转出去,用户会去看一个和本次合并无关的文件名。
 */
describe('索引脏 + 真三方合并', () => {
  it('如实说是索引的问题,并给出能照做的下一步', async () => {
    const p = pool()
    await p.init()
    // 用户在 run 期间自己提交过一笔 —— 这一步让第 2 跳变成真三方合并。
    await writeFile(join(gitRoot, 'mine.txt'), '我自己的\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'user'], gitRoot)
    // 而且他手上还有**已暂存**的改动(和本次任务无关的文件)。
    await writeFile(join(gitRoot, 'mine.txt'), '又改了\n')
    await git(['add', 'mine.txt'], gitRoot)

    const n = node('root/01-a')
    const l = await p.acquire(n) as { path: string }
    await writeFile(join(l.path, 'shipped.ts'), 'the work\n')
    const res = await p.commitAndMerge(n) as { ok: true; trunk?: { advanced: boolean; reason?: string } }
    if (res.trunk?.advanced === true) return // 这台 git 上没被拒,这一格不适用

    const why = res.trunk?.reason ?? ''
    expect(why).toContain('索引里有已暂存的改动')
    expect(why).toContain('git stash')
    // 用户的东西一个字节都没动。
    expect(await readFile(join(gitRoot, 'mine.txt'), 'utf-8')).toContain('又改了')
  })
})
