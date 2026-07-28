/**
 * 人工干预面**真的接上了**吗 —— 跑真编排器,数真调用。
 *
 * control.test.ts 守的是那三件事各自的规则;这一档守的是它们在真实调度里生效:
 * 暂停时不再派新活、取消只停那一个节点、追加指令真的出现在之后的提示词里。
 *
 * 这个仓库反复付过的代价是「函数写对了但没接上」,所以这三条都必须从**外部可观测的量**
 * 上断言:调用次数、别的节点还跑不跑、提示词原文。
 */
import { describe, expect, it } from 'bun:test'

import { createRunControl } from './control.js'
import { NodeCancelledError } from './runAgentAdapter.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import type { RunAgentFn } from './roundtable.js'
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, type EffTaskConfig } from './types.js'

const NOW = '2026-07-28T00:00:00Z'
const vtag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over,
})

const allPass: RunAgentFn = async req => {
  if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
  if (req.phase === 'execute') return '```exec\n{"execStatus":"done"}\n```'
  return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
}

/** 根拆成两个子任务,之后每个子任务都是执行型。 */
function splitThenLeaves(): RunAgentFn {
  let planCalls = 0
  return async req => {
    if (req.phase === 'plan') {
      planCalls++
      return planCalls === 1
        ? '```plan\n{"kind":"decompose","solution":"s","acceptance":"a","children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]}]}\n```'
        : '```plan\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
    }
    return allPass(req)
  }
}

describe('暂停', () => {
  it('暂停期间不再派新活,恢复之后继续跑完', async () => {
    const control = createRunControl()
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      calls++
      // 第一次调用之后就暂停 —— 模拟用户在运行中按下暂停。
      if (calls === 1) control.pause()
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    const run = orch.run()
    await new Promise(r => setTimeout(r, 60))
    const during = calls
    // 再等一会儿:暂停着就不该再涨。
    await new Promise(r => setTimeout(r, 80))
    expect(`暂停期间的调用次数: ${calls}`).toBe(`暂停期间的调用次数: ${during}`)

    control.resume()
    const out = await run
    expect(out.status).toBe('completed')
    expect(calls).toBeGreaterThan(during)
  })

  it('暂停时**没有在飞的调用**也不会被当成「走不动」', async () => {
    // 这条是暂停最容易写错的地方:那个 `inFlight.size === 0 → 返回 blocked` 的分支
    // 排在暂停检查前面的话,一次暂停就把整轮判死,而用户只是想插一句话。
    const control = createRunControl()
    control.pause()
    let calls = 0
    const runAgent: RunAgentFn = async req => { calls++; return allPass(req) }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    const run = orch.run()
    await new Promise(r => setTimeout(r, 80))
    expect(calls).toBe(0)
    control.resume()
    expect((await run).status).toBe('completed')
  })
})

describe('取消单个节点', () => {
  /**
   * 这一层注入的是**裸 RunAgentFn**,绕过了真适配器 —— 而登记 controller、判定
   * wasCancelled、抛 NodeCancelledError 全都发生在适配器里(见 controlAdapter.test.ts)。
   * 所以这里模拟适配器**已经**抛出来之后的样子:编排器和流水线该怎么处理它。
   */
  const cancelDuringExecute = (title: string, control: ReturnType<typeof createRunControl>) => {
    const splitFn = splitThenLeaves()
    const fn: RunAgentFn = async req => {
      if (req.phase === 'execute' && req.node.title === title) {
        control.cancelNode(req.node.id)
        throw new NodeCancelledError(req.node.id)
      }
      return splitFn(req)
    }
    return fn
  }

  it('只停那一个,别的照跑完', async () => {
    const control = createRunControl()
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent: cancelDuringExecute('甲', control), control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const nodes = orch.nodes()
    const jia = nodes.find(n => n.title === '甲')!
    const yi = nodes.find(n => n.title === '乙')!
    expect(jia.status).toBe('BLOCKED')
    expect(jia.blockedReason).toContain('已被用户取消')
    // 取消一个而炸掉整棵树的话,和 Esc 就没区别了 —— 而这个功能存在的全部理由就是有区别。
    expect(yi.status).toBe('ACCEPTED')
  })

  it('被取消的节点保持可恢复 —— 取消不是判决', async () => {
    const control = createRunControl()
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent: cancelDuringExecute('甲', control), control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const jia = orch.nodes().find(n => n.title === '甲')!
    // interrupted 才会被 reseat 重新排队。不置的话 --resume 救不回来,取消成了永久判决。
    expect(jia.interrupted).toBe(true)
    // 也**不能**带 capCategory:那会让阻断卡去劝用户提高超时/把节点拆小。
    expect(jia.capCategory).toBeUndefined()
    expect(jia.capBlocked).toBe(false)
  })

  it('**分析环节**被取消也走同一条路 —— 两个阻断点是分开写的', async () => {
    // 分析和执行各有一处 blockWithReason,漏掉任何一处,那个环节被取消时就会拿到
    // 一句「调用失败」+ 一张劝你提高超时的阻断卡,而且不再可恢复。
    const control = createRunControl()
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        control.cancelNode(req.node.id)
        throw new NodeCancelledError(req.node.id)
      }
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('已被用户取消')
    expect(root.interrupted).toBe(true)
    expect(root.capCategory).toBeUndefined()
  })
  it('阻断信息里要告诉他怎么救回来', async () => {
    const control = createRunControl()
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent: cancelDuringExecute('甲', control), control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const jia = orch.nodes().find(n => n.title === '甲')!
    expect(jia.blockedReason).toContain('--resume')
    expect(jia.blockedReason).toContain('r 重做')
  })
})
describe('追加指令', () => {
  it('运行中补的话,出现在**之后**派发的提示词里', async () => {
    const control = createRunControl()
    const prompts: string[] = []
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      calls++
      prompts.push(req.prompt)
      if (calls === 1) control.addDirective('别动 src/legacy,那是别人的模块')
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    // 第一次调用时还没加,所以它里面不该有。
    expect(prompts[0]).not.toContain('别动 src/legacy')
    // 之后必须有 —— 否则这个功能等于没有。
    expect(prompts.slice(1).some(p => p.includes('别动 src/legacy'))).toBe(true)
  })

  it('没补过话时提示词里不多一段空标题', async () => {
    const control = createRunControl()
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return allPass(req) }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    expect(prompts.some(p => p.includes('运行中的追加指令'))).toBe(false)
  })
})
