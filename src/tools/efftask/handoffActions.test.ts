import { describe, expect, it } from 'bun:test'
import { choiceLabels, discardConfirmLines, runHandoffChoice, type GitFn } from './handoffActions.js'
import type { PendingHandoff } from './types.js'

const H: PendingHandoff = {
  branch: 'efftask/001/integration', commits: 3,
  integrationPath: '/repo/.efftask-worktrees/001-int',
  kept: [{ path: '/repo/.efftask-worktrees/001-a', why: '仍有未合入的内容' }],
  salvage: ['efftask/001/salvage'],
  outcome: 'completed',
}

const gitOf = (table: Record<string, { code: number; stdout?: string; stderr?: string }>): {
  git: GitFn; calls: string[][]
} => {
  const calls: string[][] = []
  const git: GitFn = async args => {
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    const r = table[key] ?? table[args[0]] ?? { code: 0 }
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return { git, calls }
}

describe('选项标签必须等于行为', () => {
  it('「推送分支」不叫「建 PR」', () => {
    // 只跑 git push 却叫「建 PR」,就是承诺一件不会发生的事 —— 除非真去跑
    // gh pr create 并处理 gh 不存在的情况。
    const labels = choiceLabels(H)
    const push = labels.find(l => l.key === 'push')!
    expect(push.label).not.toContain('PR')
    expect(push.hint).toContain('git push')
  })

  it('四个选项齐全,合并那条说清在哪儿执行', () => {
    expect(choiceLabels(H).map(l => l.key)).toEqual(['merge', 'push', 'keep', 'discard'])
    expect(choiceLabels(H)[0].hint).toContain('你的工作区')
  })
})

describe('保留 = 什么都不做', () => {
  it('一次 git 都不跑', async () => {
    const { git, calls } = gitOf({})
    const r = await runHandoffChoice('keep', H, git, '/repo')
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
    expect(r.message).toContain(H.branch)
  })
})

describe('合并回当前分支', () => {
  it('成功时说合并了几个提交', async () => {
    const { git, calls } = gitOf({ 'status --porcelain': { code: 0, stdout: '' } })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('3 个提交')
    expect(calls.some(c => c[0] === 'merge')).toBe(true)
  })

  it('冲突时如实报告失败,绝不显示「已合并」', async () => {
    // 显示「已合并」是这个功能最不能出的错:用户会据此去做下一步,而代码根本不在
    // 他的分支上。
    const { git } = gitOf({
      'status --porcelain': { code: 0, stdout: '' },
      merge: { code: 1, stderr: 'CONFLICT (content): Merge conflict in a.ts' },
    })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('合并失败')
    expect(r.message).toContain('CONFLICT')
    expect(r.message).not.toContain('已合并')
    expect(r.followUps!.join('\n')).toContain('没有任何东西丢失')
  })

  it('工作区脏时先挡住,并且不跑 merge', async () => {
    const { git, calls } = gitOf({ 'status --porcelain': { code: 0, stdout: ' M src/a.ts\n' } })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('未提交的改动')
    expect(calls.some(c => c[0] === 'merge')).toBe(false)
  })
})

describe('推送分支', () => {
  it('成功', async () => {
    const { git, calls } = gitOf({})
    const r = await runHandoffChoice('push', H, git, '/repo')
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(['push', '-u', 'origin', H.branch])
  })

  it('失败时说清分支还在本地', async () => {
    const { git } = gitOf({ push: { code: 128, stderr: "fatal: 'origin' does not appear to be a git repository" } })
    const r = await runHandoffChoice('push', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('推送失败')
    expect(r.followUps!.join('\n')).toContain('仍在本地')
  })
})

describe('丢弃 —— 唯一不可逆的那个', () => {
  it('先删工作区再删分支:被 worktree 占着的分支删不掉', async () => {
    // 实测过真 git:cannot delete branch … used by worktree at …
    const { git, calls } = gitOf({})
    const r = await runHandoffChoice('discard', H, git, '/repo')
    expect(r.ok).toBe(true)
    const wtAt = calls.findIndex(c => c[0] === 'worktree')
    const brAt = calls.findIndex(c => c[0] === 'branch')
    expect(wtAt).toBeGreaterThanOrEqual(0)
    expect(wtAt).toBeLessThan(brAt)
  })

  it('删分支失败时不说「已删除」,并说清还剩什么', async () => {
    const { git } = gitOf({ branch: { code: 1, stderr: "error: branch 'x' not found" } })
    const r = await runHandoffChoice('discard', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain('已删除')
    expect(r.followUps!.join('\n')).toContain('可能仍然存在')
  })

  it('没有集成工作区时不跑 worktree remove', async () => {
    const { git, calls } = gitOf({})
    await runHandoffChoice('discard', { ...H, integrationPath: undefined }, git, '/repo')
    expect(calls.some(c => c[0] === 'worktree')).toBe(false)
  })

  it('二次确认文案如实列出会删什么、不会删什么', async () => {
    // 列不全,用户就是在对一件他没看全的事按下确认。
    const lines = discardConfirmLines(H).join('\n')
    expect(lines).toContain(H.branch)
    expect(lines).toContain('3 个提交')
    expect(lines).toContain(H.integrationPath!)
    expect(lines).toContain('不会')
    expect(lines).toContain('抢救分支')
    expect(lines).toContain('未回收的节点工作区')
    expect(lines).toContain('run 目录')
  })

  it('没有抢救分支时不假称有', async () => {
    const lines = discardConfirmLines({ ...H, salvage: [], kept: [] }).join('\n')
    expect(lines).not.toContain('抢救分支')
    expect(lines).not.toContain('未回收的节点工作区')
    expect(lines).toContain('run 目录')
  })
})
