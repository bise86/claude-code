import { integrationBranch, worktreeBranch, worktreeSlug } from './worktreeId.js'
import type { TaskNode } from './types.js'

/**
 * One git invocation. Injected so the pool is unit-testable without a repo, and so the
 * integration tests can point it at a throwaway one.
 *
 * `cwd` matters: a worktree's index and HEAD are per-worktree, so almost every call here has
 * to say WHERE it runs. Never assume the process cwd.
 */
export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface Lease {
  path: string
  branch: string
  gitRoot: string
}

export type MergeResult =
  | { ok: true; merged: boolean }
  | { ok: false; kind: 'conflict'; files: string[] }
  | { ok: false; kind: 'infra'; message: string }

/**
 * Serialises an async section. `acquire` and `merge` each need one: measured, 5 concurrent
 * `git worktree add` produced `could not lock config file .git/config` and one worktree that
 * was never created, and 4 concurrent merges into one checkout produced rc=128
 * `cannot lock ref 'HEAD'` and rc=2 alongside a single winner.
 */
function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Chain onto BOTH settle paths so one rejection cannot poison every later section.
    const run = tail.then(fn, fn) as Promise<T>
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export interface WorktreePoolDeps {
  runId: string
  gitRoot: string
  git: GitRunner
  /** Where per-node worktrees live. */
  worktreeRoot: string
}

/**
 * Per-node git worktrees, merged back into one integration branch.
 *
 * Every rule below was measured against real git in a throwaway repo, because three rounds of
 * plan review were overturned by assumptions about these primitives. The measurements are
 * quoted at each rule so the next reader does not have to re-derive them.
 */
export function createWorktreePool(deps: WorktreePoolDeps) {
  const { runId, gitRoot, git, worktreeRoot } = deps
  const intBranch = integrationBranch(runId)
  const intPath = `${worktreeRoot}/integration`
  const acquireLock = mutex()
  const mergeLock = mutex()

  const slugFor = (node: TaskNode): string => worktreeSlug(runId, node.id)
  const branchFor = (node: TaskNode): string => worktreeBranch(slugFor(node))
  const pathFor = (node: TaskNode): string => `${worktreeRoot}/${slugFor(node)}`

  /** Is this branch's tip already contained in the integration branch? */
  async function isMerged(branch: string): Promise<boolean> {
    const r = await git(['merge-base', '--is-ancestor', branch, intBranch], gitRoot)
    return r.code === 0
  }

  return {
    /**
     * Create the integration branch and a dedicated worktree to merge in.
     *
     * The merge worktree is dedicated on purpose: merging in the user's own checkout drags
     * their uncommitted edits onto the integration branch and leaves conflict markers in
     * THEIR working tree.
     */
    async init(): Promise<{ ok: true } | { ok: false; reason: string }> {
      const head = await git(['rev-parse', 'HEAD'], gitRoot)
      if (head.code !== 0) return { ok: false, reason: `不是 git 仓库或没有提交: ${head.stderr.trim()}` }
      const br = await git(['branch', '-f', intBranch, 'HEAD'], gitRoot)
      if (br.code !== 0) return { ok: false, reason: `无法创建集成分支: ${br.stderr.trim()}` }
      const add = await git(['worktree', 'add', '-f', intPath, intBranch], gitRoot)
      if (add.code !== 0) return { ok: false, reason: `无法创建集成工作区: ${add.stderr.trim()}` }
      return { ok: true }
    },

    /**
     * A worktree for this node, based on the integration branch's CURRENT state so a node
     * sees what its dependencies already merged.
     *
     * Reuse (resume) is the subtle path. The worktree is already ON this node's branch, so
     * committing and then `checkout -B <same branch> <integration>` RESETS that branch off the
     * salvage commit: measured `git for-each-ref --contains <salvage>` = 0 refs and the file
     * gone from the tree. The salvage therefore goes to a DISTINCT ref first (measured: 1 ref
     * afterwards), honouring 宁可保留垃圾,不可删掉工作.
     */
    acquire(node: TaskNode): Promise<Lease | { error: string }> {
      return acquireLock(async () => {
        const path = pathFor(node)
        const branch = branchFor(node)
        const exists = await git(['rev-parse', '--git-dir'], path)
        if (exists.code === 0) {
          const dirty = await git(['status', '--porcelain'], path)
          if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
            await git(['add', '-A'], path)
            await git(['commit', '--no-verify', '-m', `efftask: 恢复时固化中断产出 (${node.id})`], path)
            const sha = await git(['rev-parse', 'HEAD'], path)
            if (sha.code === 0) {
              await git(['branch', '-f', `efftask/${runId}/salvage/${slugFor(node)}`, sha.stdout.trim()], gitRoot)
            }
          }
        } else {
          const add = await git(['worktree', 'add', '-f', '-b', branch, path, intBranch], gitRoot)
          if (add.code !== 0) return { error: `无法创建工作区: ${add.stderr.trim()}` }
          return { path, branch, gitRoot }
        }
        // Re-base the reused worktree onto the integration branch's current state.
        const co = await git(['checkout', '-B', branch, intBranch], path)
        if (co.code !== 0) return { error: `无法把工作区切到集成分支: ${co.stderr.trim()}` }
        return { path, branch, gitRoot }
      })
    },

    /**
     * Commit whatever the node produced and merge it into the integration branch.
     *
     * `merged: false` means there was genuinely nothing to merge, and it needs BOTH signals:
     * measured, an executor that committed its own work leaves `git diff --cached --quiet`
     * at rc=0 (nothing staged) while `merge-base --is-ancestor` says rc=1 (not merged). A
     * staged-only test therefore reports "no output" for a node that did real work, and the
     * integration branch silently loses it.
     *
     * The hook problem is solved by ORDER, not by parsing: hook rejection and
     * nothing-to-commit both exit 1 (measured), so we check the index FIRST. If something was
     * staged, a failing commit can only be a real failure.
     */
    commitAndMerge(node: TaskNode): Promise<MergeResult> {
      return mergeLock(async () => {
        const path = pathFor(node)
        const branch = branchFor(node)

        const add = await git(['add', '-A'], path)
        if (add.code !== 0) return { ok: false, kind: 'infra', message: `git add 失败: ${add.stderr.trim()}` }
        const staged = await git(['diff', '--cached', '--quiet'], path)
        const hasStaged = staged.code !== 0

        if (hasStaged) {
          const commit = await git(['commit', '--no-verify', '-m', `efftask: ${node.title}`], path)
          // We KNOW there was something staged, so any failure here is real — no exit-code
          // guessing. --no-verify because the user's pre-commit hook fires inside every agent
          // worktree (core.hooksPath is set in the SHARED config) and rejecting half-finished
          // agent output is deterministic: retrying it would never converge.
          if (commit.code !== 0) {
            return { ok: false, kind: 'infra', message: `提交失败: ${commit.stderr.trim() || commit.stdout.trim()}` }
          }
        }

        if (await isMerged(branch)) return { ok: true, merged: false }

        const merge = await git(['merge', '--no-edit', branch], intPath)
        if (await isMerged(branch)) return { ok: true, merged: true }

        // Not merged. Distinguish a real conflict from infrastructure — an earlier design
        // reported every git failure as a conflict with a fabricated file list.
        const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], intPath)
        const files = conflicts.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        // Leave the integration worktree usable either way.
        //
        // On a genuine conflict MERGE_HEAD exists and `merge --abort` would also work. The
        // reason for reset+clean is the OTHER failure: measured, a lost merge race leaves a
        // staged entry with NO MERGE_HEAD, so abort reports "There is no merge to abort" and
        // the next attempt dies with "local changes would be overwritten" — the worktree
        // wedges permanently, and only reset --hard + clean -fd recovered it.
        //
        // NOT COVERED BY A TEST, and recorded rather than faked: the merge mutex above makes
        // that race unreachable within a run, so swapping this back to `merge --abort` leaves
        // the suite green. It is defence for a state the current design prevents — keep it,
        // but do not claim it is tested.
        await git(['reset', '--hard'], intPath)
        await git(['clean', '-fd'], intPath)
        if (files.length > 0) return { ok: false, kind: 'conflict', files }
        return { ok: false, kind: 'infra', message: merge.stderr.trim() || merge.stdout.trim() || '合并未生效' }
      })
    },

    /**
     * Remove a node's worktree — only when it is provably safe.
     *
     * BOTH conditions, because either alone deletes real work: a clean tree can still hold
     * commits that never merged, and a merged branch can still have uncommitted edits.
     */
    async release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }> {
      const path = pathFor(node)
      const branch = branchFor(node)
      const dirty = await git(['status', '--porcelain'], path)
      if (dirty.code !== 0) return { removed: false, keptBecause: '无法读取工作区状态' }
      if (dirty.stdout.trim().length > 0) return { removed: false, keptBecause: '工作区仍有未提交改动' }
      if (!(await isMerged(branch))) return { removed: false, keptBecause: '仍有未合入集成分支的提交' }
      const rm = await git(['worktree', 'remove', '--force', path], gitRoot)
      if (rm.code !== 0) return { removed: false, keptBecause: `移除失败: ${rm.stderr.trim()}` }
      await git(['branch', '-D', branch], gitRoot)
      return { removed: true }
    },

    /** Reclaim what is safe; report what was kept so the user can find it. */
    async dispose(nodes: TaskNode[]): Promise<{ kept: { path: string; why: string }[] }> {
      const kept: { path: string; why: string }[] = []
      for (const n of nodes) {
        const r = await this.release(n)
        if (!r.removed) kept.push({ path: pathFor(n), why: r.keptBecause ?? '未知' })
      }
      return { kept }
    },

    integrationPath: intPath,
    integrationBranchName: intBranch,
  }
}
