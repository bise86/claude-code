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
    expect(res).toEqual({ ok: true, merged: true })
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
    expect(res).toEqual({ ok: true, merged: true })
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
    expect(await p.commitAndMerge(dep)).toEqual({ ok: true, merged: true })

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

    expect(await p.commitAndMerge(a)).toEqual({ ok: true, merged: true })
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
    // 没有把这个节点的提交合进别人的分支
    const theirs = await git(['log', '--oneline', 'somebody-elses-branch'], gitRoot)
    expect(theirs.stdout).not.toContain('e1')
  })
})
