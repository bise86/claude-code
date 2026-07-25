import { createHash } from 'node:crypto'
import { worktreeBranchName } from '../../utils/worktree.js'

/**
 * A worktree slug for a node — `efftask-<runId>-<8 hex of sha256(nodeId)>`.
 *
 * NOT derived from the node id or title, and that is the whole point.
 * `validateWorktreeSlug` allows only `[a-zA-Z0-9._-]` per `/`-separated segment and caps the
 * whole slug at 64 characters. Node ids are `root/01-建表`-shaped: they carry `/`, CJK, and
 * grow past 64 characters by depth 3. Every direct derivation throws.
 *
 * Measured on the real validator: `root/01-建表` → invalid segment;
 * `root/01-add-user-registration-endpoint/02-write-integration-tests-for-the-endpoint` → 94
 * characters. The one shape that passed was `root/01-x` — which is exactly what an earlier
 * plan had chosen as its acceptance case, so it would have gone green over a total failure.
 *
 * Stability matters: resume must find the SAME worktree again, and node ids are stable on
 * disk (they are the directory names), so hashing the id is stable too.
 */
export function worktreeSlug(runId: string, nodeId: string): string {
  const hash = createHash('sha256').update(nodeId).digest('hex').slice(0, 8)
  // runId is `\d{1,4}` by construction (allocateRunId), so it needs no sanitising; the hash is
  // hex. The result is therefore always [a-z0-9-] and ~20 characters.
  return `efftask-${runId}-${hash}`
}

/** The run's integration branch: every node's work is merged back here. */
export function integrationBranch(runId: string): string {
  return `efftask/${runId}/integration`
}

/**
 * The branch a node's worktree sits on.
 *
 * `createAgentWorktree` names it for us (`worktree-<slug>`), but the pool needs the name
 * BEFORE and AFTER that call — to re-point the worktree at the integration branch, to test
 * `merge-base --is-ancestor`, and to delete it. An undefined `<wtBranch>` was a live source of
 * confusion in an earlier plan, so it gets a name here rather than living in prose.
 */
export function worktreeBranch(slug: string): string {
  // DELEGATES rather than reimplements: worktreeBranchName also flattens the slug, and a
  // second copy of that rule here would drift the day either side changes. Our slugs contain
  // no '/', so flattening is a no-op today — which is exactly why a duplicate would look
  // correct right up until it wasn't.
  return worktreeBranchName(slug)
}
