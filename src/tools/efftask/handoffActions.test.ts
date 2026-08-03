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
    const { git, calls } = gitOf({ 'diff --quiet': { code: 0 } })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(true)
    expect(r.message).toContain('3 个提交')
    expect(calls.some(c => c[0] === 'merge')).toBe(true)
  })

  it('冲突时如实报告失败,绝不显示「已合并」', async () => {
    // 显示「已合并」是这个功能最不能出的错:用户会据此去做下一步,而代码根本不在
    // 他的分支上。
    const { git } = gitOf({
      'diff --quiet': { code: 0 },
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
    // `git diff --quiet` 的约定:1 = 有差异。
    const { git, calls } = gitOf({
      'diff --quiet': { code: 1 },
      'status --porcelain': { code: 0, stdout: ' M src/a.ts\n' },
    })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('未提交的改动')
    expect(r.followUps!.join('\n')).toContain('src/a.ts')
    expect(calls.some(c => c[0] === 'merge')).toBe(false)
  })

  it('**未跟踪文件不算脏** —— 否则这个功能在正常仓库里一次也不会发生', async () => {
    /**
     * 判据原来是 `git status --porcelain` 非空,而它把未跟踪文件也算进去。`/et` 自己就在
     * 用户的检出里写 `.claude/efftask/<runId>/`,于是每一趟运行结束时 status 里都躺着
     * 一条 `?? .claude/` —— 自动合并永远被自己挡住,而给出的补救照做也没用
     * (`git stash` 对未跟踪目录回答「No local changes to save」)。
     *
     * 真的会被覆盖时 **git 自己会拒绝并且不动工作树**,那条路比我们猜更准。
     */
    const { git, calls } = gitOf({
      'diff --quiet': { code: 0 },
      // 只有未跟踪文件时 `git diff` 全都干净,而 porcelain 会吐 `?? …`。
      'status --porcelain': { code: 0, stdout: '?? .claude/\n?? scratch.txt\n' },
    })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'merge')).toBe(true)
  })

  it('**只暂存、没提交**也算脏 —— 那份改动同样会被一次合并卷进去', async () => {
    /**
     * 变异测试实测存活:把 `git diff --cached --quiet` 那一问删掉(只看工作区)之后,
     * 全套照绿 —— 因为别的用例的夹具让**工作区**那一问就已经报脏了。
     *
     * 而 `git add` 过、还没 commit 的改动正是最容易被吞掉的一种:工作区干净
     * (`git diff --quiet` 返回 0),而 merge 会把它和合并结果搅在一起。
     */
    const { git, calls } = gitOf({
      'diff --quiet': { code: 0 },   // 工作区干净
      'diff --cached': { code: 1 },  // 但暂存区有改动
      'status --porcelain': { code: 0, stdout: 'A  new.ts\n' },
    })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(calls.some(c => c[0] === 'merge')).toBe(false)
    expect(r.followUps!.join('\n')).toContain('new.ts')
  })

  it('冲突把工作区留在半合并状态时,要说出来并给出 --abort', async () => {
    /**
     * git 在内容冲突时**不回滚**:冲突标记留在文件里、`MERGE_HEAD` 还在。而自动收口
     * 这一路是用户没按任何键就发生的,所以「分支原样保留,没有任何东西丢失」这一句
     * 漏掉了工作区;而原来给的「冲突需要你手工解决: git merge <branch>」照做会得到
     * `error: Merging is not possible because you have unmerged files.`。
     */
    const { git } = gitOf({
      'diff --quiet': { code: 0 },
      merge: { code: 1, stderr: 'CONFLICT (content): Merge conflict in a.ts' },
      'status --porcelain': { code: 0, stdout: 'UU a.ts\n M b.ts\n' },
    })
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    const ups = r.followUps!.join('\n')
    expect(ups).toContain('未完成的合并')
    expect(ups).toContain('a.ts')
    expect(ups).toContain('git merge --abort')
    // 「没有任何东西丢失」这句话在这里是假的 —— 工作区被动过了。
    expect(ups).not.toContain('没有任何东西丢失')
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

describe('收口合并撞上冲突:先让模型解一次', () => {
  /**
   * 这一组不用上面那个 `gitOf`:它按 `args.slice(0, 2)` 建键,而这条路上
   * `diff --cached --quiet`(脏树判据)和 `diff --cached -U0 --`(冲突标记复核)会撞成
   * 同一个键 —— 两件完全不同的事共用一个夹具答案,测出来的东西就不是被测的东西了。
   */
  const fakeGit = (over: {
    mergeFails?: boolean
    /** `git status --porcelain` 依次返回的内容 —— 合并后、模型解完后。 */
    statuses?: string[]
    stagedDiff?: string
    commitFails?: boolean
    abortFails?: boolean
    addFails?: boolean
  } = {}): { git: GitFn; calls: string[][] } => {
    const calls: string[][] = []
    let statusIdx = 0
    const statuses = over.statuses ?? ['UU a.ts\n', '']
    const git: GitFn = async args => {
      calls.push(args)
      const [a, b] = args
      if (a === 'diff' && args.includes('--quiet')) return { code: 0, stdout: '', stderr: '' }
      if (a === 'rev-parse') return { code: 0, stdout: 'abc1234\n', stderr: '' }
      if (a === 'merge' && b === '--abort') return { code: over.abortFails ? 1 : 0, stdout: '', stderr: '' }
      if (a === 'merge') {
        return over.mergeFails === false
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in a.ts' }
      }
      if (a === 'status') {
        const out = statuses[Math.min(statusIdx, statuses.length - 1)] ?? ''
        statusIdx++
        return { code: 0, stdout: out, stderr: '' }
      }
      if (a === 'add') return { code: over.addFails ? 1 : 0, stdout: '', stderr: 'add 炸了' }
      if (a === 'diff') return { code: 0, stdout: over.stagedDiff ?? '', stderr: '' }
      if (a === 'commit') return { code: over.commitFails ? 1 : 0, stdout: '', stderr: 'commit 炸了' }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { git, calls }
  }

  it('模型解完、git 复核通过 → 真的提交,并告诉用户怎么撤销', async () => {
    // 用户原话:「这个应该要模型自动解决冲突问题」。这条路以前只会把冲突现场丢给他。
    const seen: { files: string[]; branch: string; cwd: string }[] = []
    const { git, calls } = fakeGit()
    const r = await runHandoffChoice('merge', H, git, '/repo', async info => { seen.push(info) })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('已自动解决')
    expect(calls.some(c => c[0] === 'commit')).toBe(true)
    // 解决者知道自己在解谁、解哪些文件、在哪解 —— 少一样它都只能猜。
    expect(seen).toEqual([{ files: ['a.ts'], branch: H.branch, cwd: '/repo' }])
    // 撤销命令带真实的 sha:给一条错的 reset 目标比不给危险得多。
    expect(r.followUps!.join('\n')).toContain('git reset --hard abc1234')
    // 没人复核过这份解决,这句话不能省。
    expect(r.followUps!.join('\n')).toContain('没有经过评审')
  })

  it('只 add 冲突的那几个文件,不 `add -A`', async () => {
    // `add -A` 会把用户检出里本来就有的未跟踪文件一起卷进这次合并提交 —— 而这次合并是
    // 自动发生的,他根本不知道有东西被提交了。
    const { git, calls } = fakeGit()
    await runHandoffChoice('merge', H, git, '/repo', async () => {})
    const add = calls.find(c => c[0] === 'add')!
    expect(add).toEqual(['add', '--', 'a.ts'])
  })

  it('模型说解完了但还有未合并路径 → 不提交,还原工作区', async () => {
    // 模型的自述不是判据。git 说了算。
    const { git, calls } = fakeGit({ statuses: ['UU a.ts\n', 'UU a.ts\n'] })
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => {})
    expect(r.ok).toBe(false)
    expect(r.message).toContain('仍有未解决的冲突文件')
    expect(calls.some(c => c[0] === 'commit')).toBe(false)
    expect(calls.some(c => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
    expect(r.followUps!.join('\n')).toContain('已还原到合并前')
  })

  it('解决结果里还留着冲突标记 → 不提交,还原工作区', async () => {
    // 「把两边都留下」是解冲突最常见的假动作:文件里 <<<<<<< 原样躺着,而 git 认为已解决。
    const { git, calls } = fakeGit({
      stagedDiff: '+++ b/a.ts\n+<<<<<<< HEAD\n+旧的\n+>>>>>>> efftask/001/integration\n',
    })
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => {})
    expect(r.ok).toBe(false)
    expect(r.message).toContain('还留着冲突标记')
    expect(r.message).toContain('a.ts')
    expect(calls.some(c => c[0] === 'commit')).toBe(false)
  })

  it('光杆 `=======` 不算冲突标记 —— 那是 Markdown 的下划线', async () => {
    // 反过来的代价更大:一份好的解决被判成没解干净,然后被 abort 掉。真的残留三种标记都在。
    const { git, calls } = fakeGit({ stagedDiff: '+++ b/README.md\n+标题\n+=======\n' })
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => {})
    expect(r.ok).toBe(true)
    expect(calls.some(c => c[0] === 'commit')).toBe(true)
  })

  it('解决调用自己抛了 → 还原工作区,并说清是调用失败', async () => {
    const { git, calls } = fakeGit()
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => { throw new Error('上游限流') })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('上游限流')
    expect(calls.some(c => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
  })

  it('提交失败也要还原,不能把半合并留给用户', async () => {
    const { git, calls } = fakeGit({ commitFails: true })
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => {})
    expect(r.ok).toBe(false)
    expect(r.message).toContain('提交失败')
    expect(calls.some(c => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
  })

  it('连 --abort 都失败时,如实说工作区还停在半合并状态', async () => {
    // 这时候说「已还原到合并前」就是一句可照做的假话:他会以为不用管。
    const { git } = fakeGit({ abortFails: true, statuses: ['UU a.ts\n', 'UU a.ts\n'] })
    const r = await runHandoffChoice('merge', H, git, '/repo', async () => {})
    expect(r.ok).toBe(false)
    const ups = r.followUps!.join('\n')
    expect(ups).toContain('未完成的合并')
    expect(ups).toContain('git merge --abort')
    expect(ups).not.toContain('已还原到合并前')
  })

  it('不给解决者时行为一个字节都不变 —— 留下现场,让用户自己解', async () => {
    // 关口/收口以外的调用点(测试、别的分支)不该因为这个特性而改变行为。
    const { git, calls } = fakeGit()
    const r = await runHandoffChoice('merge', H, git, '/repo')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('合并失败')
    expect(calls.some(c => c[0] === 'merge' && c[1] === '--abort')).toBe(false)
    expect(r.followUps!.join('\n')).toContain('未完成的合并')
  })
})
