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

describe('自动收口撞上冲突时,解决者必须被真的传下去', () => {
  it('冲突 → 派解决者 → 复核通过 → 合成了', async () => {
    // 这一跳曾经断在别处两次(onEscalate / openStream):声明了、实现了、测试了,就是
    // 没有人把它传下去。这里断的是「解决者被调用过」,不是源码里有没有那个词。
    let called = 0
    const git: GitFn = async args => {
      const [a, b] = args
      if (a === 'diff') return { code: 0, stdout: '', stderr: '' }
      if (a === 'symbolic-ref') return { code: 0, stdout: 'refs/heads/main\n', stderr: '' }
      if (a === 'rev-parse') return { code: 0, stdout: 'deadbee\n', stderr: '' }
      if (a === 'merge' && b === '--abort') return { code: 0, stdout: '', stderr: '' }
      if (a === 'merge') return { code: 1, stdout: '', stderr: 'CONFLICT (content): a.ts' }
      if (a === 'status') return { code: 0, stdout: called === 0 ? 'UU a.ts\n' : '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const out = await finishHandoff({
      handoff: h(), git, cwd: '/repo',
      resolveConflict: async () => { called++ },
    })
    expect(called).toBe(1)
    expect(out.merged).toBe(true)
    expect(out.result!.message).toContain('已自动解决')
  })

  it('不给解决者时行为不变:留下冲突现场,并说清工作区在哪', async () => {
    const git: GitFn = async args => {
      const [a] = args
      if (a === 'diff') return { code: 0, stdout: '', stderr: '' }
      if (a === 'symbolic-ref') return { code: 0, stdout: 'refs/heads/main\n', stderr: '' }
      if (a === 'merge') return { code: 1, stdout: '', stderr: 'CONFLICT (content): a.ts' }
      if (a === 'status') return { code: 0, stdout: 'UU a.ts\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const out = await finishHandoff({ handoff: h(), git, cwd: '/repo' })
    expect(out.merged).toBe(false)
    expect(out.conflicted).toBe(true)
  })
})

/**
 * 分支开发那一档**没有了**(用户:「不要什么分支开发,只有主干开发」)。
 *
 * 它和逐任务合并互斥:一个每完成一个子任务就把集成分支合回当前分支的运行,没有办法同时
 * 承诺「产出留在分支上、不动你的目录」。所以这里只剩一件要守的事:剩下的每条路都要合。
 */
describe('只有主干开发', () => {
  it('跑完 + 树干净 → 合,没有任何「保留分支」的岔路', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(true)
    expect(g.ran('merge --no-edit efftask/001/integration')).toBe(true)
  })

  it('「没跑完」照旧不合,而且措辞里说清半成品在哪', () => {
    const p = planFinish(h({ outcome: 'blocked', reason: '3 个节点被阻断' }), { dirty: false })
    if (p.action !== 'skip') throw new Error('unreachable')
    expect(p.why).toContain('3 个节点被阻断')
  })
})

/**
 * 主干开发的**正常结局**:每个子任务完成时就合过了,收口时 commits === 0。
 * 那条早退不能顺手把自动推送也吃掉 —— 打开了开关的人在最常见的路径上一次也推不出去。
 */
describe('逐任务合并之后:没有待收口的东西,但推送照发生', () => {
  it('commits === 0 + 逐任务合过 + 开了推送 → 推当前分支', async () => {
    const g = fakeGit({ 'symbolic-ref --short': { stdout: 'feature/x\n' } })
    const out = await finishHandoff({
      handoff: h({ commits: 0 }), git: g.git, cwd: '/repo', autoPush: true, trunkLanded: 3,
      outcome: 'completed',
    })
    expect(g.ran('merge')).toBe(false)   // 没什么可合的
    expect(g.ran('push -u origin feature/x')).toBe(true)
    expect(out.push?.ok).toBe(true)
  })

  it('真的什么都没发生(trunkLanded 0)→ 不推', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h({ commits: 0 }), git: g.git, cwd: '/repo', autoPush: true, outcome: 'completed' })
    expect(g.ran('push')).toBe(false)
    expect(out.push).toBeUndefined()
  })

  /**
   * 这条早退是逐任务合并之后**最常见的那条路径**(commits === 0 → 连 pendingHandoff 都
   * 不挂),而它原来一个前提都不查。于是一次被阻断的 run 只要中途合过一次,就会把半成品
   * 推到远程 —— 而推送在本文件里的定义是「对外动作、不可撤销」。
   */
  it('run 没跑完 → 即使中途合过也不推(推送是对外的、不可撤销的)', async () => {
    for (const outcome of ['blocked', 'cancelled'] as const) {
      const g = fakeGit({ 'symbolic-ref --short': { stdout: 'feature/x\n' } })
      const out = await finishHandoff({
        handoff: h({ commits: 0, outcome: 'blocked' }), git: g.git, cwd: '/repo',
        autoPush: true, trunkLanded: 3, outcome,
      })
      expect(g.ran('push')).toBe(false)
      expect(out.push).toBeUndefined()
    }
    // 连 outcome 都没传时同样不推:宁可少推一次,也不替用户做一次他没批准的对外动作。
    const g = fakeGit({ 'symbolic-ref --short': { stdout: 'feature/x\n' } })
    await finishHandoff({ handoff: h({ commits: 0 }), git: g.git, cwd: '/repo', autoPush: true, trunkLanded: 3 })
    expect(g.ran('push')).toBe(false)
  })
})

describe('自动推送:默认关,开了才推', () => {
  it('不开就一次 push 都不跑', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo' })
    expect(g.ran('push')).toBe(false)
    expect(out.push).toBeUndefined()
  })

  it('合成功 + 开了推送 → 推**当前分支**,而且带 -u 和显式分支名', async () => {
    // 裸 `git push` 的行为取决于 push.default 和有没有 upstream —— 一个没设过 upstream
    // 的分支上它直接失败,而用户打开的开关叫「自动推送」。
    const g = fakeGit({ 'symbolic-ref --short': { stdout: 'feature/x\n' } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo', autoPush: true })
    expect(out.merged).toBe(true)
    expect(g.ran('push -u origin feature/x')).toBe(true)
    expect(out.push?.ok).toBe(true)
  })

  it('合不了的那几档不推 —— 那些是「有问题,先别动」', async () => {
    const dirty = fakeGit({ 'diff --quiet': { code: 1 } })
    expect((await finishHandoff({ handoff: h(), git: dirty.git, cwd: '/repo', autoPush: true })).push).toBeUndefined()
    expect(dirty.ran('push')).toBe(false)
    const blocked = fakeGit()
    expect((await finishHandoff({ handoff: h({ outcome: 'blocked' }), git: blocked.git, cwd: '/repo', autoPush: true })).push).toBeUndefined()
    expect(blocked.ran('push')).toBe(false)
  })

  it('推送失败**不能**把「已合并」说成没合并 —— 那是两件事', async () => {
    const g = fakeGit({
      'symbolic-ref --short': { stdout: 'feature/x\n' },
      'push': { code: 1, stderr: 'fatal: No configured push destination' },
    })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo', autoPush: true })
    expect(out.merged).toBe(true)         // 合并真的发生了
    expect(out.result?.ok).toBe(true)
    expect(out.push?.ok).toBe(false)
    // git 的原话要带出来 —— 它通常就是修法本身。
    expect(out.push?.message).toContain('No configured push destination')
  })

  it('取不到当前分支名时如实说,不去裸推一把', async () => {
    const g = fakeGit({ 'symbolic-ref --short': { code: 1 } })
    const out = await finishHandoff({ handoff: h(), git: g.git, cwd: '/repo', autoPush: true })
    expect(out.push?.ok).toBe(false)
    expect(g.ran('push')).toBe(false)
  })
})

/**
 * 触顶降级放行之后,run 的 `outcome` **就是** `completed`(树推完了、根 ACCEPTED)——
 * 于是这一层原本会直接 `{action:'merge'}`,**把一份没人判通过的代码自动 merge 进用户的
 * 检出**,不弹确认、不按任何键、而且不可逆(merge commit 已经在他的历史里了)。
 *
 * 自动合并当初被认定安全,前提逐字是「一次**干净**跑完的运行」。降级放行把那个前提改掉了,
 * 所以这道门必须跟着改 —— 这是「不失败」这套东西最容易造成真实损害的那一处。
 */
/**
 * **这道闸从「拒绝合」降成「合了,但要说」。**
 *
 * 逐任务合并之后它已经拦不住任何东西:降级放行的节点在通过验收那一刻就被 `intoTrunk`
 * 送进用户的分支了,而集成分支是累积的 —— 想把某个节点排除在外,唯一办法是从此不再合。
 * 于是「干净就合、脏了就拒绝」变成一条任意规则:拦下的不是风险,只是运气;而一个已经
 * 把产出全收下的用户会看到一句「没有自动合并」。信息不能少,判决要改。
 */
describe('降级放行:照样合,但必须说出口', () => {
  it('有降级节点 → 仍然 merge,而且带着一句必须说出口的话', () => {
    const p = planFinish(h({ degradedNodes: 2 }), { dirty: false })
    expect(p.action).toBe('merge')
    if (p.action !== 'merge') throw new Error('unreachable')
    expect((p.warn ?? []).join('\n')).toContain('降级放行')
    expect((p.warn ?? []).join('\n')).toContain('2')
    // 「它们的产出也在这次合并里」—— 这句是判决改掉之后唯一还能防止误解的东西。
    expect((p.warn ?? []).join('\n')).toContain('也在这次合并里')
    expect((p.warn ?? []).join('\n')).toContain('run.md')
  })

  it('这句话要真的到达用户 —— 并进合并成功那条消息的 followUps', async () => {
    const g = fakeGit()
    const out = await finishHandoff({ handoff: h({ degradedNodes: 2 }), git: g.git, cwd: '/repo' })
    expect(out.merged).toBe(true)
    expect((out.result?.followUps ?? []).join('\n')).toContain('降级放行')
  })

  it('一个降级节点都没有 → 行为逐字不变,照常自动合', () => {
    expect(planFinish(h({ degradedNodes: 0 }), { dirty: false })).toEqual({ action: 'merge' })
    expect(planFinish(h(), { dirty: false })).toEqual({ action: 'merge' })
  })
})
