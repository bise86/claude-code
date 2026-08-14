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
import { NO_CONTRIBUTION_NOTE, RESCUE_STRANDED_NOTE } from './backtrack.js'
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

/**
 * **datum 那一格,端到端。**
 *
 * 跑机 .13 run 001 的真实形状:父任务的集成验收连着三轮点名 `datum.rs` 不在集成工作区,
 * 主模型也正确地点了写 datum 的那个子任务 —— 而它 `status: ACCEPTED`、改过一行
 * Cargo.toml 所以「有贡献」,不在按状态算出来的保守名单里,于是被当成**幻觉 id 丢掉**,
 * 屏幕上印「主模型点了 1 个不在这棵子树里的任务,已忽略」(一句假话),名单退回保守版,
 * 重跑了三个不相干的兄弟,真凶一次都没动。
 */
describe('主模型点名的 ACCEPTED 子任务', () => {
  const datumTree = (): TaskNode[] => [
    mk('P', {
      kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01', 'P/02', 'P/03'],
      acceptLog: [{
        round: 3, step: 'integrate',
        verdicts: [{ role: '测试', pass: false, blocking: ['datum.rs 不在集成工作区'], comments: '' }],
        synthesized: { pass: false, blockingSummary: 'datum.rs 不在集成工作区' },
      }],
    }),
    mk('P/01', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    mk('P/02', {
      parentId: 'P', kind: 'executable', status: 'ACCEPTED',
      execStatus: '已登记依赖。\n本轮未做:创建 datum.rs',
      undone: ['创建 datum.rs'],
    }),
    mk('P/03', { parentId: 'P', kind: 'executable', status: 'ACCEPTED', execStatus: `(注:该节点${NO_CONTRIBUTION_NOTE})` }),
  ]

  it('它在这棵子树里,就不许被当成幻觉丢掉', async () => {
    const { deps, problems } = spyDeps({
      map: async () => [{ nodeId: 'P/02', guidance: '这次真的把 datum.rs 写出来' }],
    })
    const out = await runBacktrack(datumTree(), 'P', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).toEqual(['P/02'])
    expect(out?.degraded).toBeUndefined()
    expect(problems.flat().join('\n')).not.toContain('不在这棵子树里')
  })

  it('模型缺席时,保守名单也收得到它(自陈未做那条判据)', async () => {
    const { deps } = spyDeps()
    const out = await runBacktrack(datumTree(), 'P', NOW, deps)
    expect(out?.entries.map(e => e.nodeId).sort()).toEqual(['P/02', 'P/03'])
  })

  it('编出来的 id 照旧丢掉 —— 白名单一个字没松', async () => {
    const { deps, problems } = spyDeps({ map: async () => [{ nodeId: '别的树/x' }] })
    const out = await runBacktrack(datumTree(), 'P', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).not.toContain('别的树/x')
    expect(problems.flat().join('\n')).toContain('改用保守名单')
  })
})

/**
 * **子任务全绿的父任务** —— 跑机上 34 个。此前这一格会让整次回溯变成一行
 * 「回溯未执行:这是拆分任务,它自己没有执行环节」,同一批里真正该重跑的一个都不动。
 */
describe('拆分型目标 + 空保守名单', () => {
  const t = (): TaskNode[] => [
    mk('R', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['R/P1', 'R/P2'] }),
    mk('R/P1', {
      parentId: 'R', kind: 'decompose', status: 'ACCEPTED', childIds: ['R/P1/a'],
      acceptLog: [integrateFail('合起来没达成父目标')], revised: true,
    }),
    mk('R/P1/a', { parentId: 'R/P1', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    mk('R/P2', { parentId: 'R', kind: 'decompose', status: 'ACCEPTED', childIds: ['R/P2/a'], acceptLog: [integrateFail('缺 X')] }),
    mk('R/P2/a', { parentId: 'R/P2', kind: 'executable', status: 'ACCEPTED', execStatus: `(注:该节点${NO_CONTRIBUTION_NOTE})` }),
  ]

  it('不再掀翻整批:P1 走重新裁决,P2 的子任务照样重跑', async () => {
    const { deps } = spyDeps()
    const out = await runBacktrack(t(), 'R', NOW, deps)
    expect(out?.entries.sort((a, b) => a.nodeId.localeCompare(b.nodeId))).toEqual([
      { nodeId: 'R/P1', entry: 'integrate' },
      { nodeId: 'R/P2/a', entry: 'execute' },
    ])
    expect(out?.skipped).toEqual([])
  })

  it('重新开放补救拆分 —— 这才是这一格买到的「加新任务」', async () => {
    const { deps, started } = spyDeps()
    const out = await runBacktrack(t(), 'R', NOW, deps)
    expect(out?.rearmed).toContain('R/P1')
    expect(started[0].find(n => n.id === 'R/P1')?.revised).toBe(false)
  })
})

/**
 * 算不出来的那一条:**跳过 + 说出来**,而不是整批放弃,也不是静默。
 */
describe('部分跳过', () => {
  /**
   * 真实的「算不出来」是**本次配置**造成的:`redoOptions` 的 `runsNothing` 会把一条
   * 「本次跳过了这个环节」的入口整个禁用,而 `planRedo` 照同一份判据拒绝。
   * 这一趟(.13 run 001)就跳过了质疑修复/测试验证/验收/观察四关。
   */
  it('一条算不出来 → 跳过它并说出来,其余照做', async () => {
    const nodes = [
      mk('root', { childIds: ['root/00-a', 'root/01-b'], status: 'BLOCKED', kind: 'decompose', acceptLog: [integrateFail()] }),
      mk('root/00-a', { parentId: 'root', status: 'BLOCKED', kind: 'executable' }),
      // 这一个的 kind 还是 unknown → entryFor 给 'plan',而下面的 ctx 说这一趟不跑分析。
      mk('root/01-b', { parentId: 'root', status: 'BLOCKED', kind: 'unknown' }),
    ]
    const { deps, problems } = spyDeps()
    const out = await runBacktrack(
      nodes, 'root', NOW, deps,
      n => (n.id === 'root/01-b' ? { skipSteps: ['plan'] as const } : undefined),
    )
    expect(out?.entries.map(e => e.nodeId)).toEqual(['root/00-a'])
    expect(out?.skipped.join()).toContain('root/01-b')
    // 说出来:这条规矩的全部前提。commitRedo 不看 plan.warnings,所以必须由这里推上去。
    expect(problems.flat().join('\n')).toContain('root/01-b')
  })
})

/**
 * 变异测试补上的两条 —— 我原来的探针没打在点上。
 */
describe('变异测试补漏', () => {
  /**
   * **血统 = 整棵子树。** 上一版探针只造了「模型点的正好也在保守名单里」那种输入,
   * 于是把 `descendantsOf` 那一行剪掉之后全套照绿。真实形状是模型点了一个**更深的**
   * 节点:集成验收的意见里点名的是文件,而那个文件属于孙子节点。
   */
  it('模型点名一个更深的、干干净净的孙子节点 —— 不许当幻觉丢掉', async () => {
    const nodes = [
      mk('P', {
        kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01'],
        acceptLog: [{
          round: 1, step: 'integrate',
          verdicts: [{ role: 'r', pass: false, blocking: ['pgwire/types.rs 不在集成工作区'], comments: '' }],
          synthesized: { pass: false, blockingSummary: 'pgwire/types.rs 不在集成工作区' },
        }],
      }),
      // 中间那层干干净净:它不在 suspects 里。
      mk('P/01', { parentId: 'P', kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01/aa'], execStatus: '做完了' }),
      // 孙子:同样已验收、同样有贡献 —— 只有集成验收的意见知道是它。
      mk('P/01/aa', { parentId: 'P/01', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    ]
    const { deps, problems } = spyDeps({ map: async () => [{ nodeId: 'P/01/aa', guidance: '把 types.rs 写出来' }] })
    const out = await runBacktrack(nodes, 'P', NOW, deps)
    expect(out?.entries.map(e => e.nodeId)).toEqual(['P/01/aa'])
    expect(problems.flat().join('\n')).not.toContain('不在这棵子树里')
  })

  /**
   * **被跳过的节点不许清证据。** `markBacktracked` 的 `reran` 闸就是为这件事存在的:
   * 一条捞不回来的 ref,证据被抹掉之后下一次按 `b` 再也找不到它,那条 ref 就此彻底失联。
   * 上一版探针里被跳过的那个节点身上根本没有证据,所以剪掉闸也没人红。
   */
  it('算不出来而被跳过的节点,身上的「捞不回来」证据要原样留着', async () => {
    const stranded = {
      execStatus: `做完了\n(注:该节点${RESCUE_STRANDED_NOTE}(还差 2 处))`,
      rescueStranded: [{ ref: 'efftask/001/salvage/ab12', why: '合不上', at: NOW, remaining: 2 }],
    }
    const nodes = [
      mk('root', {
        childIds: ['root/00-a', 'root/01-b'], status: 'BLOCKED', kind: 'decompose',
        acceptLog: [integrateFail()],
      }),
      mk('root/00-a', { parentId: 'root', status: 'BLOCKED', kind: 'executable' }),
      /**
       * 它自己就是一个 target(捞不回来 —— 而 `backtrackCanClaim` 要求执行型叶子,
       * 探针第一版写成 `kind:'unknown'`,于是它根本不是 target,变异照样活着)。
       * 这一趟它算不出来:本次配置跳过了执行环节 → `planRedo` 判 disabled。
       */
      mk('root/01-b', { parentId: 'root', status: 'ACCEPTED', kind: 'executable', ...stranded }),
    ]
    const { deps, started } = spyDeps()
    const out = await runBacktrack(
      nodes, 'root', NOW, deps,
      n => (n.id === 'root/01-b' ? { skipSteps: ['execute'] as const } : undefined),
    )
    expect(out?.skipped.join()).toContain('root/01-b')
    const after = started[0].find(n => n.id === 'root/01-b')!
    expect(after.rescueStranded).toBeDefined()
    expect(after.execStatus).toContain(RESCUE_STRANDED_NOTE)
  })
})

/**
 * **兜底注入的范围要和 `inScope` 一样宽。**
 *
 * 放宽 `inScope` 到整棵子树的那一次没带上 `fallbackOf` —— 规范席实测:主模型点了一个
 * 合法但不在保守名单里的后代(那正是放宽要救的那种节点),它被接受、被重跑,
 * 却**一句意见都拿不到**,而确认屏承诺的是「把集成验收的意见注入执行提示词」。
 */
describe('兜底注入的范围', () => {
  it('主模型点的后代没给 guidance 时,也拿得到盘上那句意见', async () => {
    const nodes = [
      mk('P', {
        kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01'],
        acceptLog: [{
          round: 1, step: 'integrate',
          verdicts: [{ role: 'r', pass: false, blocking: ['types.rs 不在集成工作区'], comments: '' }],
          synthesized: { pass: false, blockingSummary: 'types.rs 不在集成工作区' },
        }],
      }),
      mk('P/01', { parentId: 'P', kind: 'decompose', status: 'ACCEPTED', childIds: ['P/01/aa'], execStatus: '做完了' }),
      mk('P/01/aa', { parentId: 'P/01', kind: 'executable', status: 'ACCEPTED', execStatus: '做完了' }),
    ]
    // 模型只给 id,不给 guidance(`parseBacktrackMap` 允许)。
    const { deps, started } = spyDeps({ map: async () => [{ nodeId: 'P/01/aa' }] })
    await runBacktrack(nodes, 'P', NOW, deps)
    const n = started[0].find(x => x.id === 'P/01/aa')!
    expect(JSON.stringify(n.guidance ?? {})).toContain('types.rs 不在集成工作区')
  })
})


/**
 * **扣押集只按真的派出去的那些算。** `canApply` 扣住的节点在这段时间里不许被调度,
 * 而把一个**根本没被回溯**的节点也扣进去,是在白白冻结一个还能往前跑的任务。
 */
describe('扣押集的范围', () => {
  it('被跳过的那一条不进 canApply 的影响面', async () => {
    const nodes = [
      mk('root', {
        childIds: ['root/00-a', 'root/01-b'], status: 'BLOCKED', kind: 'decompose',
        acceptLog: [integrateFail()],
      }),
      mk('root/00-a', { parentId: 'root', status: 'BLOCKED', kind: 'executable' }),
      mk('root/01-b', { parentId: 'root', status: 'BLOCKED', kind: 'unknown' }),
    ]
    let seen: readonly string[] = []
    const { deps } = spyDeps({ canApply: ids => { seen = ids; return undefined } })
    await runBacktrack(nodes, 'root', NOW, deps,
      n => (n.id === 'root/01-b' ? { skipSteps: ['plan'] as const } : undefined))
    expect(seen).toContain('root/00-a')
    expect(seen).not.toContain('root/01-b')
  })
})
