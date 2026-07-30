/**
 * 跑完之后把产出送回**当前目录**。
 *
 * 用户原话:「任务完后,在隔离环境产出的代码和目录,并且提交成功了,要在当前目录下有对应的
 * 存在。」在这之前隔离运行的产出只存在于 `efftask/<runId>` 集成分支上,而收口关口只在
 * `--resume` 那条路上出现 —— 正常跑一趟,合并这件事永远不会发生。
 *
 * 这里断的是**判据**和**如实报告**两件事。判据错了会在用户的检出里跑一次他没同意的 merge;
 * 报告错了更糟:屏幕上写「已合并」而代码根本不在他的分支上,他会照着这句话去做下一步。
 */
import { describe, expect, it } from 'bun:test'

import { finishHandoff, planFinish } from './finishHandoff.js'
import type { GitFn } from './handoffActions.js'
import type { PendingHandoff } from './types.js'

const h = (over: Partial<PendingHandoff> = {}): PendingHandoff => ({
  branch: 'efftask/001/integration',
  commits: 3,
  integrationPath: '/wt/integration',
  kept: [],
  salvage: [],
  outcome: 'completed',
  ...over,
})

/** 记下每一条 git 命令,并按前缀给答案。 */
function fakeGit(answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[][] = []
  /** 每条命令的 cwd —— 跑错目录是这个功能最不能出的错(见那条 cwd 用例)。 */
  const cwds: (string | undefined)[] = []
  const git: GitFn = async (args, cwd) => {
    calls.push(args)
    cwds.push(cwd)
    const hit = Object.entries(answers).find(([k]) => args.join(' ').startsWith(k))
    const a = hit?.[1] ?? {}
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  }
  return { git, calls, cwds, ran: (prefix: string) => calls.some(c => c.join(' ').startsWith(prefix)) }
}

describe('planFinish —— 什么时候可以替用户合并', () => {
  it('没有待收口 / 零提交 → 什么都不做', () => {
    // 非隔离运行本来就写在当前目录里,没有分支可合。
    expect(planFinish(undefined, { dirty: false })).toEqual({ action: 'none' })
    expect(planFinish(h({ commits: 0 }), { dirty: false })).toEqual({ action: 'none' })
  })

  it('跑完 + 工作区干净 → 合', () => {
    expect(planFinish(h(), { dirty: false })).toEqual({ action: 'merge' })
  })

  it('没跑完的树不合,并说清为什么', () => {
    /**
     * `PendingHandoff.outcome` 存在的全部理由就是「别邀请用户合并一棵没做完的树」——
     * 自动替他合更不行:半成品会带着一次真实的 merge commit 落到他的分支上。
     */
    const p = planFinish(h({ outcome: 'blocked', reason: '3 个节点被阻断' }), { dirty: false })
    expect(p.action).toBe('skip')
    if (p.action !== 'skip') throw new Error('unreachable')
    expect(p.why).toContain('3 个节点被阻断')
    // 而且必须告诉他产出在哪、怎么自己来 —— 否则他以为这一趟白跑了。
    expect(p.followUps.join('\n')).toContain('efftask/001/integration')
  })

  it('工作区脏 → 不合,并把脏在哪印出来', () => {
    const p = planFinish(h(), { dirty: true, dirtyDetail: ' M src/app.ts' })
    expect(p.action).toBe('skip')
    if (p.action !== 'skip') throw new Error('unreachable')
    expect(p.why).toContain('未提交')
    expect(p.followUps.join('\n')).toContain('src/app.ts')
  })
})

describe('finishHandoff —— 真的去跑 git,并如实报告', () => {
  it('干净 + 跑完 → 真的 merge,并报告已合并', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(g.ran('diff --quiet')).toBe(true)
    expect(g.ran('merge --no-edit efftask/001/integration')).toBe(true)
    expect(out.merged).toBe(true)
    expect(out.result?.ok).toBe(true)
  })

  it('脏树 → **一次 merge 都不许跑**', async () => {
    const g = fakeGit({ 'diff --quiet': { code: 1 }, 'status --porcelain': { stdout: ' M src/app.ts\n' } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(g.ran('merge')).toBe(false)
    expect(out.merged).toBe(false)
    expect(out.result?.ok).toBe(false)
    expect(out.result?.message).toContain('未提交')
  })

  it('被阻断的 run → 不探脏、不合,只报告', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h({ outcome: 'blocked' }), git: g.git, cwd: '/repo' })
    expect(g.calls).toEqual([])
    expect(out.merged).toBe(false)
    expect(out.result?.ok).toBe(false)
  })

  it('merge 失败(冲突)→ merged 为假,消息是 git 的原话,而**不是**「已合并」', async () => {
    /**
     * 这一条是这个功能最不能出的错:屏幕上显示「已合并」而代码不在他的分支上,
     * 用户会据此去做下一步(继续改、提 PR、删分支)。
     */
    const g = fakeGit({ 'merge': { code: 1, stderr: 'CONFLICT (content): Merge conflict in src/app.ts' } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    expect(out.result?.message).toContain('CONFLICT')
    expect(out.result?.message).not.toContain('已合并')
    // 分支原样保留 —— 什么都没丢,而且告诉他怎么手工来。
    expect(out.result?.followUps?.join('\n')).toContain('git merge efftask/001/integration')
  })

  it('git diff 自己报错 → 按脏算,不合', async () => {
    // 状态未知的检出里跑 merge 是最坏的选择:宁可不合并并说清楚。
    //  的约定:>1 = 命令自己出错(1 只是「有差异」)。
    const g = fakeGit({ 'diff --quiet': { code: 128, stderr: 'not a git repository' } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(g.ran('merge')).toBe(false)
    expect(out.result?.followUps?.join('\n')).toContain('git diff 失败')
  })

  it('每一条 git 都跑在**用户的** cwd 上', async () => {
    /**
     * 这一条守的是这个功能最不能出的错。验收实测过把 merge 的 cwd 错写成
     * `h.integrationPath` 的后果:那里已经在集成分支上,`git merge` 回答
     * `Already up to date.` → code 0 → 屏幕报「已合并 2 个提交到当前分支」,
     * 而**用户目录里一个文件都没有、HEAD 也没动**。全套测试对此全绿。
     */
    const g = fakeGit()
    await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(g.calls.length).toBeGreaterThan(0)
    for (const c of g.cwds) expect(c).toBe('/repo')
  })

  it('冲突把工作区留在半合并状态时,`conflicted` 要为真', async () => {
    // done 视图那句「你的工作区未被改动」按它改口 —— 而这一路是自动发生的,用户没按
    // 任何键就被丢进了冲突态。
    const g = fakeGit({
      merge: { code: 1, stderr: 'CONFLICT (content): Merge conflict in a.ts' },
      'status --porcelain': { stdout: 'UU a.ts\n' },
    })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    expect(out.conflicted).toBe(true)
  })

  it('未跟踪文件会被覆盖时 git 自己拒绝 —— 那不是半合并', async () => {
    const g = fakeGit({
      merge: { code: 1, stderr: 'error: The following untracked working tree files would be overwritten by merge' },
      'status --porcelain': { stdout: '?? feat.ts\n' },
    })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    // 没有冲突码 → 工作树没被动过,不该吓用户。
    expect(out.conflicted).toBe(false)
  })

  it('detached HEAD → 不合,并说清「合进去也不留在任何分支上」', async () => {
    /**
     * 这是唯一一个「合成功了、代码却不在任何分支上」的路径:merge 会成功、文件会到位,
     * 而分支还停在旧提交,下一次 checkout 就把这一趟的产出留在 reflog 里。
     * 而屏幕上写的是「已合并回你**当前的分支**」。
     */
    const g = fakeGit({ 'symbolic-ref': { code: 1 } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    expect(g.ran('merge')).toBe(false)
    expect(out.result?.message).toContain('detached HEAD')
    expect(out.result?.followUps?.join('\n')).toContain('git switch')
  })

  it('git 抛异常也**永不抛出去**', async () => {
    /**
     * 它跑在 runOrchestrator 的 finally 里,而那一段每一句都是被保护的:一个逃出去的
     * 异常会让 `setPhase('done')` 永不执行 —— 界面永久停在「运行中」,Esc 毫无反应。
     */
    const git: GitFn = async () => { throw new Error('spawn EAGAIN') }
    const out = await finishHandoff({ handoff: h(), git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    expect(out.result?.message).toContain('spawn EAGAIN')
  })
})
