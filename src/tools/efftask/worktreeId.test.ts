import { describe, expect, it } from 'bun:test'
import { integrationBranch, worktreeBranch, worktreeSlug } from './worktreeId.js'
import { validateWorktreeSlug } from '../../utils/worktree.js'
import { childId } from './persistence.js'

describe('worktreeSlug is legal for the node shapes that actually occur', () => {
  it('accepts Chinese titles, deep nesting and absurd lengths', () => {
    // validateWorktreeSlug allows only [a-zA-Z0-9._-] per '/'-separated segment, max 64 chars.
    // Deriving the slug from runId + node.id threw for every realistic node: `root/01-建表`
    // failed the segment rule, a three-level English id came to 94 characters. The one shape
    // that passed was `root/01-x` — which an earlier plan had picked as its acceptance case,
    // so it would have gone green over a total failure.
    const deep = childId(childId(childId('root', 1, '建表'), 2, 'write integration tests for the endpoint'), 3, '压测')
    for (const id of ['root', 'root/01-建表', deep, 'root/01-' + 'x'.repeat(300), 'root/01-🙂-emoji']) {
      const slug = worktreeSlug('001', id)
      expect(() => validateWorktreeSlug(slug)).not.toThrow()
      expect(slug.length).toBeLessThanOrEqual(64)
      expect(slug).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('is stable for the same node — resume must find the same worktree again', () => {
    expect(worktreeSlug('001', 'root/01-建表')).toBe(worktreeSlug('001', 'root/01-建表'))
  })

  it('is distinct across nodes and across runs', () => {
    expect(worktreeSlug('001', 'root/01-a')).not.toBe(worktreeSlug('001', 'root/02-a'))
    expect(worktreeSlug('001', 'root/01-a')).not.toBe(worktreeSlug('002', 'root/01-a'))
  })

  it('names the integration and worktree branches explicitly', () => {
    // <wtBranch> was used four times in an earlier plan and defined nowhere — and it is
    // exactly what decides whether a salvage commit gets orphaned.
    expect(integrationBranch('003')).toBe('efftask/003/integration')
    expect(worktreeBranch('efftask-001-deadbeef')).toBe('worktree-efftask-001-deadbeef')
  })
})
