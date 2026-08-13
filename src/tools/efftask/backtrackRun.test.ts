/**
 * 回溯的接线 —— 每一步都真的调一次并断言顺序与参数。
 *
 * 理由和 `redoRun.test.ts` 逐字相同,而且是被验收量出来的:`efftask.tsx` 挂不起来,
 * 于是唯一的防线曾经是源码文本断言 —— 而那种断言证明不了「这一步真的被调用过、
 * 而且带着对的参数」。那一次造出了 **14 条存活变异**,每一条的用户可见后果都是
 * 「按下确认之后界面纹丝不动」,而全套测试绿。
 */
import { describe, expect, it } from 'bun:test'
import { runBacktrack, type BacktrackRunDeps } from './backtrackRun.js'
import { NO_CONTRIBUTION_NOTE } from './backtrack.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'
import type { RedoPlan } from './redo.js'

const NOW = '2026-08-13T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const integrateFail = (why = '合起来没覆盖导出接口'): TaskNode['acceptLog'][number] => ({
  round: 1, step: 'integrate', verdicts: [], synthesized: { pass: false, blockingSummary: why },
})

/** 一棵「父任务集成验收没过、两个子任务一好一坏」的树。 */
const tree = (): TaskNode[] => [
  mk('root', {
    childIds: ['root/00-a', 'root/01-b'], status: 'BLOCKED', kind: 'decompose',
    acceptLog: [integrateFail()],
  }),
  mk('root/00-a', { parentId: 'root', status: 'BLOCKED', kind: 'executable', worktree: { branch: 'ba', path: '/wt/a' } }),
  mk('root/01-b', { parentId: 'root', status: 'ACCEPTED', kind: 'executable' }),
]

const spyDeps = (over: Partial<BacktrackRunDeps> = {}): {
  deps: BacktrackRunDeps; log: string[]; started: TaskNode[][]; problems: string[][]
} => {
  const log: string[] = []
  const started: TaskNode[][] = []
  const problems: string[][] = []
  return {
    log, started, problems,
    deps: {
      commit: async () => { log.push('commit'); return { problems: [] } },
      onProblems: p => { log.push('onProblems'); problems.push(p) },
      onNodes: () => { log.push('onNodes') },
      onDropStreams: () => { log.push('onDropStreams') },
      start: n => { log.push('start'); started.push(n) },
      onDone: () => { log.push('onDone') },
      ...over,
    },
  }
}

describe('顺序', () => {
  it('算 → 落盘 → 上屏 → 进 state → 重启', async () => {
    const { deps, log } = spyDeps()
    await runBacktrack(tree(), 'root', NOW, deps)
    expect(log).toEqual(['commit', 'onProblems', 'onNodes', 'start'])
  })

  /**
   * **`start` 是整个功能的目的。** 少了它,回溯只是改了改树 —— 屏幕说重跑了,
   * 而一个模型调用都不会发生。
   */
  it('新树真的被交给了 start,而且里面的目标已经被重置', async () => {
    const { deps, started } = spyDeps()
    await runBacktrack(tree(), 'root', NOW, deps)
    expect(started).toHaveLength(1)
    const a = started[0]!.find(n => n.id === 'root/00-a')!
    expect(a.status).not.toBe('BLOCKED')
  })
})

describe('主模型那一步', () => {
  it('模型给的名单被采纳,补充提示词写进对应节点', async () => {
    const { deps, started } = spyDeps({
      map: async () => [{ nodeId: 'root/00-a', guidance: '这次把导出接口补上' }],
    })
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).toEqual(['root/00-a'])
    const a = started[0]!.find(n => n.id === 'root/00-a')!
    expect(JSON.stringify(a.guidance ?? {})).toContain('把导出接口补上')
  })

  /**
   * **模型点的 id 必须落在血统里 —— 白名单不是黑名单。**
   *
   * 一个编出来的 id 会被送去 `planRedo`,而那会改一整棵树。
   */
  it('血统之外的 id 被丢掉,而且要说出来', async () => {
    const notes: string[] = []
    const { deps } = spyDeps({
      map: async () => [{ nodeId: '别的树/x' }, { nodeId: 'root/00-a' }],
      onProgress: l => notes.push(l),
    })
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).toEqual(['root/00-a'])
    expect(notes.join('\n')).toContain('不在这棵子树里')
  })

  /**
   * **调用失败不等于什么都不做。** 退回保守名单,并把这件事说出来 ——
   * 静默变成空操作是这个仓库反复在修的那一类。
   */
  it('模型抛异常 → 退回保守名单,并把降级说出来', async () => {
    const { deps, problems } = spyDeps({ map: async () => { throw new Error('限流') } })
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).toEqual(['root/00-a'])   // 保守名单 = 没验收通过的
    expect(out?.degraded).toContain('限流')
    expect(problems[0]!.join('\n')).toContain('限流')
  })

  it('没有主模型 → 同样退回保守名单并说出来', async () => {
    const { deps, problems } = spyDeps()
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.degraded).toContain('没有可用的主模型')
    expect(problems[0]!.join('\n')).toContain('保守名单')
  })

  /**
   * **模型缺席时,注入也必须真的发生。**
   *
   * 屏幕上那句承诺是无条件的:「把集成验收的意见**注入执行提示词**,重跑一遍」。
   * 而 `guidance` 此前**只**从模型的映射来 —— 没有模型的那一趟是**裸重跑**:
   * 同样的提示词、同样的模型,凭什么这次会不一样。而那句意见本来就在盘上
   * (`BacktrackTarget.blocking`),它此前只被拿去上屏和喂模型。
   */
  it('没有主模型时,用盘上已有的意见兜底注入', async () => {
    const { deps, started } = spyDeps()
    await runBacktrack(tree(), 'root', NOW, deps)
    /**
     * 断言落在**交出去的那棵树**上:`runBacktrack` 的返回值刻意不带 guidance,
     * 而真正决定重跑那一趟长什么样的是树上那句话。
     */
    const child = started[0]!.find(n => n.id === 'root/00-a')!
    expect(JSON.stringify(child)).toContain('合起来没覆盖导出接口')
  })

  /** 模型给了话就用模型的 —— 兜底不许把更具体的那句顶掉。 */
  it('模型给了补充提示词时,兜底不生效', async () => {
    const { deps, started } = spyDeps({ map: async () => [{ nodeId: 'root/00-a', guidance: '这次把导出接口补上' }] })
    await runBacktrack(tree(), 'root', NOW, deps)
    const child = JSON.stringify(started[0]!.find(n => n.id === 'root/00-a')!)
    expect(child).toContain('这次把导出接口补上')
    expect(child).not.toContain('合起来没覆盖导出接口')
  })

  /** 模型答了、但一条有效的都没有 —— 和「没答」对用户是同一个结果,不该一个静默一个说话。 */
  it('模型只给了无效项 → 也算降级', async () => {
    const { deps } = spyDeps({ map: async () => [{ nodeId: '不存在' }] })
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.degraded).toContain('保守名单')
    expect(out?.entries.map(e => e.nodeId)).toEqual(['root/00-a'])
  })

  /**
   * 保守名单**只收没验收通过的和产出丢了的** —— 已验收且健康的子任务不许被卷进来
   * (那正是按过 `c` 键之后的正常状态)。
   */
  it('保守名单不碰健康的已验收子任务', async () => {
    const { deps } = spyDeps()
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).not.toContain('root/01-b')
  })

  it('产出丢了的已验收子任务要进保守名单', async () => {
    const t = tree()
    t[2]!.execStatus = `做完了\n(注:该节点${NO_CONTRIBUTION_NOTE})`
    const { deps } = spyDeps()
    const out = await runBacktrack(t, 'root', NOW, deps)
    expect(out?.entries.map(e => e.nodeId).sort()).toEqual(['root/00-a', 'root/01-b'])
  })
})

describe('阶梯', () => {
  it('父任务没回溯过 → 子任务走执行重做', async () => {
    const { deps } = spyDeps()
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out?.entries[0]!.entry).toBe('execute')
  })

  /**
   * 阶梯记在**集成验收没通过的那个节点**身上,不是记在子任务身上:同一个父任务第二次仍然
   * 不通过,该升级的是**这次干预的手段**,而不是某个碰巧被点两次的子任务。
   */
  it('父任务回溯过一轮 → 这次走完全重做', async () => {
    const t = tree()
    t[0]!.backtrack = { rounds: 1, at: '早先' }
    const { deps } = spyDeps()
    const out = await runBacktrack(t, 'root', NOW, deps)
    expect(out?.entries[0]!.entry).toBe('plan')
  })

  it('第 2 级重新武装补救拆分', async () => {
    const t = tree()
    t[0]!.backtrack = { rounds: 1, at: '早先' }
    t[0]!.revised = true
    const { deps } = spyDeps()
    const out = await runBacktrack(t, 'root', NOW, deps)
    expect(out?.rearmed).toEqual(['root'])
  })

  it('回溯之后轮次落在交出去的那棵树上', async () => {
    const { deps, started } = spyDeps()
    await runBacktrack(tree(), 'root', NOW, deps)
    expect(started[0]!.find(n => n.id === 'root')!.backtrack).toEqual({ rounds: 1, at: NOW })
  })
})

describe('拒绝路径', () => {
  it('没有可回溯的任务 → 什么都不做,但要答复', async () => {
    const { deps, log, problems } = spyDeps()
    const clean = [mk('root', { status: 'ACCEPTED' })]
    const out = await runBacktrack(clean, 'root', NOW, deps)
    expect(out).toBeUndefined()
    expect(log).toEqual(['onProblems', 'onDone'])
    expect(problems[0]!.join('')).toContain('没有集成验收未通过')
  })

  /**
   * **扣不住就整条不做。** 盘上一个字节都没动过(`composeRedos` 是纯函数),
   * 所以说清原因、关掉关口就够了 —— 但**必须答复**:那次回溯什么都没发生,
   * 静默 = 屏幕说回溯了而一个调用都不会有。
   */
  it('canApply 拒绝 → 不落盘、不重启,而且要答复', async () => {
    const { deps, log } = spyDeps({ canApply: () => '有节点正在运行' })
    const out = await runBacktrack(tree(), 'root', NOW, deps)
    expect(out).toBeUndefined()
    expect(log).toEqual(['onProblems', 'onDone'])
    expect(log).not.toContain('commit')
    expect(log).not.toContain('start')
  })

  /**
   * 扣押集要取**全集**:N 次 planRedo 各自的并集 ∪ 每个目标自己。
   * 少了并集,共同祖先会漏出去 —— 而它此刻是 WAITING_CHILDREN,调度循环当场可以把它
   * 派去集成验收。
   */
  it('扣押集里既有被重跑的子任务,也有集成验收没过的那个父任务', async () => {
    let seen: readonly string[] = []
    const { deps } = spyDeps({ canApply: a => { seen = a; return undefined } })
    await runBacktrack(tree(), 'root', NOW, deps)
    expect([...seen].sort()).toContain('root')
    expect([...seen].sort()).toContain('root/00-a')
  })
})

describe('落盘', () => {
  it('commit 拿到的 before 是**回溯前**的原始节点', async () => {
    let before: readonly TaskNode[] = []
    const { deps } = spyDeps({
      commit: async (_p: RedoPlan, b: readonly TaskNode[]) => { before = b; return { problems: [] } },
    })
    const original = tree()
    await runBacktrack(original, 'root', NOW, deps)
    // 传错的话 commitRedo 算不出工作区的路径和分支 —— 而且不会有任何报错。
    expect(before.find(n => n.id === 'root/00-a')?.worktree?.path).toBe('/wt/a')
  })

  it('落盘的 problems 原样上屏', async () => {
    const { deps, problems } = spyDeps({ commit: async () => ({ problems: ['工作区没删掉'] }) })
    await runBacktrack(tree(), 'root', NOW, deps)
    expect(problems[0]!.join('\n')).toContain('工作区没删掉')
  })
})
