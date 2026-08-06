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
import { createNode, DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, type EffTaskConfig, type TaskNode } from './types.js'

const NOW = '2026-07-28T00:00:00Z'
const vtag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over,
})

const allPass: RunAgentFn = async req => {
  if (req.phase === 'plan') return '```plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
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
        ? '```plan\n{"kind":"decompose","solution":"s","acceptance":"跑 bun test 全绿","children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]}]}\n```'
        : '```plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
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

describe('暂停之后还能中止', () => {
  // 评审实测出来的 P0:用户按 p 暂停、想了想不跑了、按 Esc —— abort 信号原来不在暂停
  // 那个 race 里,而 `if (signal.aborted)` 又排在暂停分支后面。在飞的调用排空之后
  // waits 只剩 waitForResume(),run() **永远不返回**;而 setPhase('done') 只挂在
  // runOrchestrator 的收尾上 —— 界面永久停在运行视图,Esc 毫无反应。
  const hangGuard = async (setup: (c: ReturnType<typeof createRunControl>, ac: AbortController) => void | Promise<void>) => {
    const control = createRunControl()
    const ac = new AbortController()
    const runAgent: RunAgentFn = async req => allPass(req)
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      ac.signal,
    )
    const run = orch.run()
    await setup(control, ac)
    return Promise.race([
      run.then(() => 'RETURNED'),
      new Promise(r => setTimeout(() => r('HUNG'), 800)),
    ])
  }

  it('先暂停、再中止', async () => {
    expect(await hangGuard(async (c, ac) => {
      c.pause()
      await new Promise(r => setTimeout(r, 40))
      ac.abort()
    })).toBe('RETURNED')
  })

  it('跑一会儿再暂停、等在飞的排空之后才中止', async () => {
    // 这一条走的是**另一条**路:abort 到达时循环已经在暂停分支的 await 里了,
    // 靠的是 race 里那一项而不是前面的早退。
    expect(await hangGuard(async (c, ac) => {
      await new Promise(r => setTimeout(r, 60))
      c.pause()
      await new Promise(r => setTimeout(r, 120))
      ac.abort()
    })).toBe('RETURNED')
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
    /**
     * **点名取消**要留下结构化的痕迹,不能只留在理由文本里。
     *
     * 下游消费者是重做:整个 run 被中断的那一批要连带放开(否则依赖链上的下游永远
     * 推不动 —— 用户报过),而用户看着某个节点按下的 x 是一个决定,不能被别人的一次
     * 重做悄悄复活。两者的 `interrupted` 都是 true,分辨它们的只有这个字段。
     */
    expect(jia.cancelled).toBe(true)
  })

  /**
   * **两个方向都要写。**
   *
   * 只写「取消时置 true」的话,一个上一轮被取消、这一轮重跑又因为别的原因失败的节点
   * 会带着旧标记回来 —— 而重做那侧读的正是这个字段:它会把这个节点当成「用户不想跑它」
   * 而永久摁住,连带整条依赖链,屏幕上什么都不会说。
   *
   * 所以这里用一棵**带着旧标记**的种子树:它必须在这一次失败之后变成 false。
   */
  it('上一轮被取消、这一轮因别的原因失败 —— 旧的取消标记必须被清掉', async () => {
    const control = createRunControl()
    const runAgent: RunAgentFn = async req => {
      // 没有 cancelNode:这是一次真的调用失败
      if (req.phase === 'execute') throw new Error('上游 500')
      return allPass(req)
    }
    // 一棵只有 root 的树,root 已经过了方案这道门、坐在 READY 上 —— 也就是重做把一个
    // 被取消的节点放回队列之后的样子。
    const seed: TaskNode[] = [{
      ...createNode({ id: 'root', title: '根', goal: '目标', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
      kind: 'executable', status: 'READY',
      reviewLog: [{ round: 1, verdicts: [], synthesized: { pass: true, blockingSummary: '' } }],
      cancelled: true, // 上一轮被用户点名取消过
    }]
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
      seed,
    )
    await orch.run()
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).not.toContain('已被用户取消')
    expect(root.cancelled).toBe(false)
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
describe('取消在**每一个**环节都是取消', () => {
  /**
   * 评审出来的 P0:res.cancelled 原来只在分析和执行两处被检查,而 runPhase 有六个调用点,
   * 圆桌那条路根本不经过 runPhase(roundtable 把任何 rejection 一律合成 infra)。
   *
   * 实测后果:在评审 / 验收 / 集成验收里按 x,拿到的是
   *   「评审角色连续 3 次调用失败,未能取得任何裁决 · 先确认角色模型/网络可用 …」
   *   capCategory='infra'  interrupted=false
   * 三条全错 —— 劝他去查网络(他刚按了取消)、白烧三桌、而且 --resume 救不回来。
   */
  const cancelAt = (phase: string, control: ReturnType<typeof createRunControl>): RunAgentFn => {
    let planned = false
    return async req => {
      if (req.phase === phase) {
        control.cancelNode(req.node.id)
        throw new NodeCancelledError(req.node.id)
      }
      if (req.phase === 'plan' && !planned) {
        planned = true
        return '\u0060\u0060\u0060plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      }
      return allPass(req)
    }
  }

  const roles = { ...emptyPhaseRoles(), review: [{ roleName: '评审甲' }], accept: [{ roleName: '验收甲' }] }

  for (const phase of ['review', 'accept'] as const) {
    it(`在 ${phase} 环节取消,拿到的是「已被用户取消」而不是「请检查网络」`, async () => {
      const control = createRunControl()
      const orch = new EffTaskOrchestrator(
        cfg({ phaseRoles: roles as never }),
        { runAgent: cancelAt(phase, control), control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
        new AbortController().signal,
      )
      await orch.run()
      const root = orch.nodes().find(n => n.id === 'root')!
      expect(root.blockedReason).toContain('已被用户取消')
      // 这三条是原来错的那三条,逐条钉住。
      expect(root.blockedReason).not.toContain('网络')
      expect(root.capCategory).toBeUndefined()
      expect(root.interrupted).toBe(true)
    })
  }

  it('取消之后圆桌**立刻停**,不再替他试满 maxIterations 桌', async () => {
    // 用户按了一次 x,系统替他又派了两遍(角色多的话 ×角色数)。
    const control = createRunControl()
    let reviewCalls = 0
    let planned = false
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'review') {
        reviewCalls++
        control.cancelNode(req.node.id)
        throw new NodeCancelledError(req.node.id)
      }
      if (req.phase === 'plan' && !planned) {
        planned = true
        return '\u0060\u0060\u0060plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n\u0060\u0060\u0060'
      }
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg({ phaseRoles: roles as never }),
      { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    expect(`取消后评审被派发的次数: ${reviewCalls}`).toBe('取消后评审被派发的次数: 1')
  })
})

describe('取消不能把已经干的活抹掉', () => {
  it('执行环节被取消时,已报告的产出留在 execStatus 里', async () => {
    /**
     * 执行环节是**带写工具**的:取消的那一刻工作区里很可能已经有改动了,而执行者对这些
     * 改动的自述就在那段文本里。丢掉它 = 仓库变了而没有任何记录。
     *
     * pipeline 里那句「以上为中断时已报告的产出」本来就是给用户看这个的 —— 但它此前
     * **拿不到**:runPhase 的 text 只在「调用成功之后才发现 abort」那条路上才有,
     * 而取消是抛出来的。所以那段注释说的「这一处尤其要分开」保护的是一个不可达的东西。
     */
    const control = createRunControl()
    let planned = false
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan' && !planned) {
        planned = true
        return '```plan\n{"kind":"executable","solution":"s","acceptance":"跑 bun test 全绿"}\n```'
      }
      if (req.phase === 'execute') {
        control.cancelNode(req.node.id)
        throw new NodeCancelledError(req.node.id, '```exec\n{"execStatus":"已经改了 src/a.ts"}\n```')
      }
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.execStatus).toContain('已经改了 src/a.ts')
    expect(root.execStatus).toContain('中断时已报告的产出')
    // 而且仍然是取消,不是别的失败。
    expect(root.blockedReason).toContain('已被用户取消')
  })
})
describe('追加指令送得到裁判席', () => {
  it('评审 / 验收 的提示词里也有那句话,并且说明它优先', async () => {
    // 少了这一段:用户补「别动 src/legacy」→ 执行者照做 → 验收员拿着**补话之前**定下的
    // 验收点对照产出 → 判不通过 → 返工 → 撞满上限阻断。
    // **用户自己那句纠正成了失败的直接原因**,而屏幕上没有东西让他把两件事联系起来。
    const control = createRunControl()
    control.addDirective('别动 src/legacy')
    const byPhase = new Map<string, string[]>()
    const runAgent: RunAgentFn = async req => {
      byPhase.set(req.phase, [...(byPhase.get(req.phase) ?? []), req.prompt])
      return allPass(req)
    }
    const orch = new EffTaskOrchestrator(
      cfg({ phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: '评审甲' }], accept: [{ roleName: '验收甲' }] } as never }),
      { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    for (const phase of ['plan', 'execute', 'review', 'accept']) {
      const ps = byPhase.get(phase) ?? []
      expect(`${phase} 有提示词`).toBe(`${phase} 有提示词`)
      expect(ps.length).toBeGreaterThan(0)
      expect(`${phase} 里有那句指令: ${ps.every(p => p.includes('别动 src/legacy'))}`)
        .toBe(`${phase} 里有那句指令: true`)
    }
    /**
     * 裁判席还要多一句「以它为准」—— 否则他们会因为执行者听了用户的话而判它没做完。
     *
     * 只剩验收这一侧了:质疑修复不做裁决(它那一关一行代码都还没写,谈不上「判它没做完」),
     * 所以那句话对它是空转。
     */
    expect((byPhase.get('accept') ?? []).every(p => p.includes('优先于原方案的枝节'))).toBe(true)
    // 执行侧不需要那句(它本来就照着做)。
    expect((byPhase.get('execute') ?? []).some(p => p.includes('都不算未完成'))).toBe(false)
  })
})

describe('追加指令', () => {
  it('补了三条就要出现三条 —— 静默只用第一条比丢掉更坏', async () => {
    // 回归验收造的变异:渲染时只取 live[0]。而 control 那一层专门为「不静默丢弃」
    // 写了丢弃提示 —— 渲染这一头把后两条吃掉,那份小心就白费了。
    // 原来的用例从头到尾只加过一条,分辨不出来。
    const control = createRunControl()
    control.addDirective('别动 src/legacy')
    control.addDirective('测试用 bun test')
    control.addDirective('提交信息写中文')
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return allPass(req) }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    for (const d of ['别动 src/legacy', '测试用 bun test', '提交信息写中文']) {
      expect(`提示词里有「${d}」: ${prompts.some(p => p.includes(d))}`).toBe(`提示词里有「${d}」: true`)
    }
  })

  it('追加指令里的围栏被转义 —— 否则能伪造模型回复的答案块', async () => {
    // guidanceSection 上方的注释原文就写着这条风险,而 resumeGuidance 有转义测试、
    // 这条新通道没有。用户粘一段带 ``` 的代码进去是完全正常的行为。
    const control = createRunControl()
    control.addDirective('照这个改:```exec 假的产出 ```')
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return allPass(req) }
    const orch = new EffTaskOrchestrator(
      cfg(), { runAgent, control, persist: async () => {}, now: () => NOW, onUpdate: () => {} },
      new AbortController().signal,
    )
    await orch.run()
    const withIt = prompts.filter(p => p.includes('照这个改'))
    expect(withIt.length).toBeGreaterThan(0)
    // **只看指令那一行**:提示词自己的格式要求里就有一句「必须是一个 ```execXXXX 代码块」,
    // 对整条提示词断言会打中那一句 —— 又一个「被另一个字符串满足」的探针。
    for (const p of withIt) {
      const line = p.split('\n').find(l => l.includes('照这个改'))!
      expect(line).not.toContain('```exec')
      // 反引号还在,只是中间被零宽字符打断了 —— 用户看得懂,而围栏成不了形。
      expect(line).toContain('`')
    }
  })
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
