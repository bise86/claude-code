import { describe, it, expect } from 'bun:test'
import { buildConflictCard, escalationLines } from './conflictEscalation.js'
import { createNode, emptyPhaseRoles } from './types.js'

const NOW = '2026-01-01T00:00:00.000Z'
const node = () =>
  createNode({ id: 'root/02', title: '接入支付回调', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('冲突升级卡', () => {
  it('carries every fact the human needs to act, without hunting for the run', () => {
    const lines = escalationLines(
      { node: node(), branch: 'efftask/007/n-ab12cd34', path: '/repo/.efftask-worktrees/n-ab12cd34', files: ['src/pay.ts', 'src/api.ts'], attempts: 1, state: { markers: true, staged: false } },
      '007',
    )
    const text = lines.join('\n')
    expect(text).toContain('接入支付回调')
    expect(text).toContain('root/02')
    expect(text).toContain('efftask/007/n-ab12cd34')
    expect(text).toContain('/repo/.efftask-worktrees/n-ab12cd34')
    expect(text).toContain('src/pay.ts、src/api.ts')
    // The resume command, spelled out with the real id. Without it the user has to go find
    // which run this was before they can restart it.
    expect(text).toContain('/et --resume 007')
    // It must say the machine already tried — otherwise the obvious first reaction is
    // "just retry the merge", which is exactly what already failed.
    expect(text).toContain('本次已自动尝试解决 1 次仍未成功')
  })

  it('does NOT claim an attempt that this run never made', () => {
    // iteration.mergeResolve is persisted, so after a --resume the budget reads as spent
    // while nothing was tried. Saying 已自动尝试解决一次未成功 there describes a PREVIOUS
    // session; the user reads it as 'the machine just tried' and stops looking for the
    // interrupt that actually consumed the attempt.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'], attempts: 0, state: { markers: true, staged: false } }, '1').join('\n')
    expect(text).not.toContain('本次已自动尝试解决')
    expect(text).toContain('本次运行没有再尝试自动解决')
  })

  it('tells the user to RESOLVE when markers really are there', () => {
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'], attempts: 1, state: { markers: true, staged: false }, integrationBranch: 'efftask/007/integration' }, '1').join('\n')
    expect(text).toContain('那里就是冲突现场')
    expect(text).toContain('<<<<<<<')
    expect(text).toContain('efftask/007/integration') // the other side, or they cannot reproduce it
  })

  it('describes a staged merge without inventing who staged it or how it was judged', () => {
    // This state is ALSO reached by a human who ran `git merge` + `git add` and forgot to
    // commit before resuming. The earlier wording hard-coded 自动解决…验收未通过 and was false
    // in every clause for them — including one that contradicted the line directly above it
    // (本次未再尝试). Say only what was measured.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'], attempts: 0, state: { markers: false, staged: true } }, '1').join('\n')
    expect(text).toContain('未提交完成的合并')
    expect(text).not.toContain('自动解决已经改好')
    expect(text).not.toContain('但验收未通过')
    expect(text).not.toContain('那里就是冲突现场')
  })

  it('names committed leftover markers instead of claiming there is no conflict', () => {
    // A resolver that 'resolves' by committing both sides leaves a CLEAN worktree with no
    // MERGE_HEAD. Every other probe calls that conflict-free, so the card said 那里目前没有
    // 冲突现场 while <<<<<<< HEAD sat in the file, and prescribed a `git merge` that answers
    // 'Already up to date.' — an instruction with no effect on a real problem it never named.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['shared.txt'], attempts: 1, state: { markers: true, staged: false, stale: true } }, '1').join('\n')
    expect(text).toContain('已经被提交进这个分支的文件里')
    expect(text).toContain('Already up to date')
    expect(text).not.toContain('那里目前没有冲突现场')
  })

  it('admits when the worktree has no conflict in it at all', () => {
    // Reachable whenever the resolve budget was spent in an earlier session: nothing
    // reproduced the conflict this run. Claiming markers there sent users hunting for
    // something that was never created.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'], attempts: 0, state: { markers: false, staged: false }, integrationBranch: 'efftask/007/integration' }, '1').join('\n')
    expect(text).toContain('目前没有冲突现场')
    expect(text).toContain('git merge')
    expect(text).not.toContain('<<<<<<<')
  })
 it('still names the run even when the id was not threaded through', () => {
    // A placeholder is honest; silently omitting the resume step is not.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: ['a'], attempts: 1, state: { markers: true, staged: false } }).join('\n')
    expect(text).toContain('/et --resume <运行 ID>')
  })

  it('says so when the conflict file list could not be read', () => {
    // An empty "冲突文件:" line reads as "no files conflicted", which would be a lie about
    // the one thing the user is being woken up for.
    const text = escalationLines({ node: node(), branch: 'b', path: '/p', files: [], attempts: 1, state: { markers: true, staged: false } }, '1').join('\n')
    expect(text).toContain('未能读出文件列表')
  })

  it('renders a red-header card whose body is the same lines', () => {
    const e = { node: node(), branch: 'b', path: '/p', files: ['x.ts'], attempts: 1, state: { markers: true, staged: false } }
    const card = buildConflictCard(e, '007') as {
      header: { template: string; title: { content: string } }
      elements: { text: { content: string } }[]
    }
    // Red: this card is a stop, not a request — it must not look like the startup prompt.
    expect(card.header.template).toBe('red')
    expect(card.header.title.content).toContain('合并冲突')
    for (const line of escalationLines(e, '007')) expect(card.elements[0]!.text.content).toContain(line)
  })
})
