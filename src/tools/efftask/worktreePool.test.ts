/**
 * Integration tests against REAL git in a throwaway repo.
 *
 * Deliberately not a fake GitRunner. Three rounds of plan review for this module were
 * overturned not by design mistakes but by assumptions about what git actually does — a fake
 * would have agreed with every one of those wrong assumptions. Each test below names the
 * measurement it encodes.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createWorktreePool, type GitRunner } from './worktreePool.js'
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

    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: true })
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
    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: true })
    expect((await git(['show', 'efftask/001/integration:raw.txt'], gitRoot)).code).toBe(0)
  })

  it('reports merged:false ONLY when there is genuinely nothing to merge', async () => {
    const p = pool()
    await p.init()
    const n = node('root/03-c')
    await p.acquire(n)
    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: false })
  })

  it('is idempotent: re-merging an already-merged node is success, not failure', async () => {
    // Measured: a second `git merge` prints "Already up to date." and exits 0 without moving
    // HEAD, so a "did HEAD advance" check would call it a failure. Resume re-merges.
    const p = pool()
    await p.init()
    const n = node('root/04-d')
    const lease = await p.acquire(n) as { path: string }
    await writeFile(join(lease.path, 'x.txt'), 'x\n')
    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: true })
    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: false })
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
    expect(await p.commitAndMerge(n)).toEqual({ ok: true, merged: true })
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
    expect(await p.commitAndMerge(c)).toEqual({ ok: true, merged: true })
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
    expect(h.commits).toBeGreaterThan(0)
    expect(h.kept.map(k => k.path)).toContain(ls.path)
  })

  it('says plainly when a run produced nothing', async () => {
    const p = pool()
    await p.init()
    const h = await p.handoff([])
    expect(h.commits).toBe(0)
    expect(h.kept).toEqual([])
  })
})
