/**
 * 重做之后**编排器真的会再跑**吗。
 *
 * 这一档是用户视角验收逼出来的,而它逼出来的东西正是这个仓库反复栽的那一类:
 * 线接着、源码闸门绿、`startRun(cfg, computed.nodes)` 这行字在,而线那头的编排器
 * 在第一个循环里就返回了。
 *
 * `run()` 的**第一句**是 `if (root.status === 'ACCEPTED') return {status:'completed'}`。
 * 于是一个跑成功的 run 上重做任何非 root 节点:数据已经删了(commitRedo 先落的盘)、
 * 模型调用 0 次、界面闪一下回到「✓ 高效任务完成」。用户什么都没得到,还少了一批记录。
 *
 * 所以这里不测源码字符串,测**模型被调了几次**。
 */
import { describe, expect, it } from 'bun:test'

import { EffTaskOrchestrator } from './orchestrator.js'
import { planRedo } from './redo.js'
import type { RunAgentFn } from './roundtable.js'
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, type EffTaskConfig, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00Z'
const vtag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over,
})
const deps = (runAgent: RunAgentFn) => ({
  runAgent, persist: async () => {}, now: () => NOW, onUpdate: () => {},
})

const allPass: RunAgentFn = async req => {
  if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
  if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
  return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
}

/** 先真跑一棵「根 + 两个子任务」的树到全绿,拿到落定后的节点。 */
async function completedTree(): Promise<TaskNode[]> {
  let planCalls = 0
  const runAgent: RunAgentFn = async req => {
    if (req.phase === 'plan') {
      planCalls++
      // 第一次:根拆成两个子任务。之后:叶子。
      return planCalls === 1
        ? '```plan\n{"kind":"decompose","solution":"s","acceptance":"a","children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]}]}\n```'
        : '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
    }
    return allPass(req)
  }
  const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
  const out = await orch.run()
  if (out.status !== 'completed') throw new Error(`前置条件不成立,树没跑绿: ${out.reason}`)
  return orch.nodes()
}

/** 拿一棵树当种子再跑一次,数模型被调了几次。 */
async function rerun(seed: TaskNode[]): Promise<{ calls: number; status: string }> {
  let calls = 0
  const runAgent: RunAgentFn = async req => { calls++; return allPass(req) }
  const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal, seed)
  const out = await orch.run()
  return { calls, status: out.status }
}

describe('重做之后编排器真的会再跑', () => {
  it('前置条件:跑绿的树 root 是 ACCEPTED,原样再跑一次是 0 次调用', async () => {
    // 这条不是被测行为,是**探针自检**:没有它,下面两条即使因为别的原因返回 0
    // 也看不出来。原样重跑 0 次调用是正确的 —— 树已经完成了。
    const done = await completedTree()
    expect(done.find(n => n.id === 'root')!.status).toBe('ACCEPTED')
    expect(await rerun(done)).toEqual({ calls: 0, status: 'completed' })
  })

  it('重做一个叶子 → 至少要真的调一次模型', async () => {
    const done = await completedTree()
    const leaf = done.find(n => n.parentId === 'root')!
    const plan = planRedo(done, leaf.id, 'execute', NOW)
    if ('error' in plan) throw new Error(plan.error)

    const { calls, status } = await rerun(plan.nodes)
    // 0 次 = 用户按了确认、看着子任务记录被删掉,然后界面回到「✓ 高效任务完成」——
    // 什么都没重做,还少了一批记录,而且此后 --resume / --retry-blocked 都救不回来
    // (它们只碰 BLOCKED 节点,不会把 ACCEPTED 的 root 退回去)。
    expect(`重做叶子后的模型调用次数: ${calls}`).not.toBe('重做叶子后的模型调用次数: 0')
    expect(status).toBe('completed')
  })

  it('重做一个叶子 → 父节点的集成验收也要重跑', async () => {
    const done = await completedTree()
    const leaf = done.find(n => n.parentId === 'root')!
    const plan = planRedo(done, leaf.id, 'execute', NOW)
    if ('error' in plan) throw new Error(plan.error)

    /**
     * 探针看的是 **root 真实走过的状态**,不是 req.phase。
     *
     * 集成验收的席位在用户没配 integrate 角色时**回落到验收席位**,派发时写的就是
     * `phase:'accept'`(pipeline.ts 里那段兼容注释)。所以按 req.phase 数的话,
     * 集成验收和叶子验收是同一个字符串 —— 断言会被后者满足,而这条用例要问的正是
     * 前者有没有发生。INTEGRATION_ACCEPT 这个状态只有集成验收会经过。
     */
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => allPass(req)
    const orch = new EffTaskOrchestrator(
      cfg(),
      {
        runAgent, persist: async () => {}, now: () => NOW,
        onUpdate: (ns: TaskNode[]) => {
          const r = ns.find(n => n.id === 'root')
          if (r && seen[seen.length - 1] !== r.status) seen.push(r.status)
        },
      },
      new AbortController().signal,
      plan.nodes,
    )
    await orch.run()
    // 父节点那句「子任务合起来达没达成父目标」的裁决,原来挂在**旧产出**上。
    // 子任务重做过之后它就不再成立了 —— 不重跑的话,树上写着已验收,而验收的是别的东西。
    expect(seen).toContain('INTEGRATION_ACCEPT')
  })

  it('重做一个中间层的拆分任务 → 同样要真的跑起来', async () => {
    const done = await completedTree()
    const plan = planRedo(done, 'root', 'integrate', NOW)
    if ('error' in plan) throw new Error(plan.error)
    const { calls } = await rerun(plan.nodes)
    expect(`重做 root 集成验收后的模型调用次数: ${calls}`)
      .not.toBe('重做 root 集成验收后的模型调用次数: 0')
  })
})
