/**
 * 定向注入 —— 提示词里点名给某个**环节**或某个**角色**的话,真的进了那个环节 / 那一席。
 *
 * 用户的原话:「/et 写提示词时,有些内容是关注某些阶段或者角色的,会将其提示词内容扩展给
 * 注入到对应阶段或角色」。
 *
 * 在这之前整段提示词只有一个去处 —— `goalPrompt`,它进的是**根节点的目标**。所以
 * 「评审时重点看并发安全」这句话的实际去处是:根方案作者读到它,然后它被 plan 的产出覆盖掉,
 * 评审员一个字都看不到(reviewPrompt 只吃 `node.plan`)。
 *
 * 这个文件从四个层次钉它:抽取 → 落盘/读回 → 关口显示 → **真的进了那次调用的提示词**。
 * 最后一条是唯一能证明功能存在的那一层:前三条全绿而提示词里没有,是这个仓库反复付过学费的
 * 「配得进去、永远到不了」。
 */
import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'
import { readRunManifest, validateLoadedNodes } from './resumeCore.js'
import { writeRunManifest, type FsLike } from './persistence.js'
import { guidanceLines } from './startupConfirm.js'
import { stepExecute, stepIntegrate, stepStart } from './pipeline.js'
import { byIdMap } from './stateMachine.js'
import { attachGuidance } from './redo.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM, type EffTaskConfig, type TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'
import type { PipelineCtx } from './pipeline.js'

const NOW = '2026-07-30T00:00:00Z'
const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn, config: EffTaskConfig): PipelineCtx {
  return {
    config, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
  }
}
function memFs(): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readFile: async p => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
    writeFile: async (p, d) => { files.set(p, d) },
    mkdir: async () => {}, mkdirExclusive: async () => true,
    unlink: async p => { files.delete(p) }, rmdir: async () => {},
    readdir: async () => [], exists: async p => files.has(p),
  }
}

describe('抽取:哪句话冲着谁说的', () => {
  const parse = (json: string, knownRoles: string[] = []) =>
    parseDirectives('随便什么目标', { knownRoles, modelJson: async () => '```json\n' + json + '\n```' })

  it('环节名收中文别名,落盘统一成内部名', async () => {
    // 和 skipSteps 同一条规矩:落盘永远是内部 phase 名,中文只是输入别名。两边都当
    // canonical 会让 run.md 里出现两种写法,而读回那侧只认一种。
    const c = await parse('{"phaseGuidance":{"质疑讨论":"重点看并发安全","执行":"别动 src/legacy"}}')
    expect(c.phaseGuidance).toEqual({ review: '重点看并发安全', execute: '别动 src/legacy' })
  })

  it('同一个环节被点两次就接起来,不覆盖', async () => {
    // 两条都是用户亲手写的,覆盖会静默丢掉前一条。
    const c = await parse('{"phaseGuidance":{"review":"看并发","质疑讨论":"也看回滚"}}')
    expect(c.phaseGuidance!.review).toBe('看并发\n也看回滚')
  })

  it('认不出来的环节名:说出来并猜一个,不静默丢弃', async () => {
    // 静默丢弃的话,用户明明写了「测试时重点跑并发用例」,而没有任何界面能让他发现那段话
    // 谁也没收到。
    const c = await parse('{"phaseGuidance":{"测试":"跑并发用例"}}')
    expect(c.phaseGuidance).toBeUndefined()
    expect(c.notices.some(n => n.includes('测试') && n.includes('不会进任何提示词'))).toBe(true)
    expect(c.notices.some(n => n.includes('是不是想写「测试验证」'))).toBe(true)
  })

  it('点给一个**这次不会跑**的环节:说出来', async () => {
    /**
     * 「测试验证时要跑 bun test」+ 没配 verify 角色 = 这段话永远不会被任何人读到,而用户
     * 以为自己已经安排好了。判据和 phaseRuns 一致:只有 verify/observer 是「没配角色就
     * 整个不存在」。
     */
    const c = await parse('{"phaseGuidance":{"测试验证":"跑 bun test"}}')
    expect(c.phaseGuidance!.verify).toBe('跑 bun test')
    expect(c.notices.some(n => n.includes('测试验证') && n.includes('不会发生'))).toBe(true)
  })

  it('点给一个被整个跳过的环节:也说出来', async () => {
    const c = await parse('{"skipSteps":["验收"],"phaseGuidance":{"验收":"逐条核对"}}')
    expect(c.notices.some(n => n.includes('整个跳过了这个环节'))).toBe(true)
  })

  it('角色定向:名字对不上任何一席时点名说出来,并列出真名', async () => {
    // 用户写的是「架构师注意回滚」,而名册里那个员工叫「甲」—— 没有这条 notice,
    // 那段话谁也读不到,而关口上一切正常。
    const c = await parse(
      '{"phaseRoles":{"review":["甲"]},"roleGuidance":[{"name":"架构师","text":"给出回滚方案"}]}',
      ['甲'],
    )
    expect(c.roleGuidance).toEqual([{ name: '架构师', text: '给出回滚方案' }])
    expect(c.notices.some(n => n.includes('架构师') && n.includes('没有这个角色或员工'))).toBe(true)
  })

  it('名字对得上员工名时不报 —— 判据和 seatMatchesName 是同一份', async () => {
    const c = await parse(
      '{"phaseRoles":{"review":["甲"]},"roleGuidance":[{"name":"甲","text":"看并发"}]}',
      ['甲'],
    )
    expect(c.notices.some(n => n.includes('没有这个角色或员工'))).toBe(false)
  })

  it('名字对得上**角色名**(roleTag)时也不报', async () => {
    // 角色名是在 applyRoleDefsToPhases 里落到席位 roleTag 上的,所以这条判定必须排在
    // 角色定义合并**之后** —— 提前判会把每一个按角色名点的人都误报成「找不到」。
    const c = await parse(
      '{"roles":[{"name":"架构师","step":"review","output":"裁决","purpose":"质疑拆分","staff":["甲"]}],' +
      '"roleGuidance":[{"name":"架构师","text":"给出回滚方案"}]}',
      ['甲'],
    )
    expect(c.notices.some(n => n.includes('没有这个角色或员工'))).toBe(false)
  })

  it('空内容 / 非字符串一律丢掉,不留空槽', async () => {
    // 空槽会让模型努力去理解一个不存在的要求。
    const c = await parse('{"phaseGuidance":{"review":"  ","execute":12},"roleGuidance":[{"name":"甲"},{"text":"x"}]}')
    expect(c.phaseGuidance).toBeUndefined()
    expect(c.roleGuidance).toBeUndefined()
  })
})

describe('落盘与读回', () => {
  it('写进 run.md 并原样读回来 —— 只写不读会在第一次 --resume 时清零', async () => {
    /**
     * `writeRunManifest` 整文件重写 run.md。一个只写不读的字段会在第一次 `--resume` 时
     * 静默消失:恢复后的名册一模一样,而模型收到的东西变了,界面上没有任何地方能让用户
     * 发现。`roleDefs` 和 `resumes` 都为这条注释付过学费。
     */
    const fs = memFs()
    const c = cfg({
      phaseGuidance: { review: '重点看并发安全', execute: '别动 src/legacy' },
      roleGuidance: [{ name: '架构师', text: '给出回滚方案' }],
    })
    await writeRunManifest(fs, '/run', c, [mk()])
    expect(fs.files.get('/run/run.md')).toContain('phaseGuidance')
    const back = await readRunManifest(fs, '/run')
    expect(back.config.phaseGuidance).toEqual(c.phaseGuidance)
    expect(back.config.roleGuidance).toEqual(c.roleGuidance)
  })

  it('没有这两个字段时,run.md 的形状一个字节都不变', async () => {
    // 恢复不能改变一个没用这个功能的 run 在盘上的样子。
    const fs = memFs()
    await writeRunManifest(fs, '/run', cfg(), [mk()])
    const md = fs.files.get('/run/run.md') ?? ''
    expect(md).not.toContain('phaseGuidance')
    expect(md).not.toContain('roleGuidance')
  })

  it('手改 run.md 写坏了:归一 + 白名单 + 说出来', async () => {
    // 手改 run.md 是一条绕开 parseDirectives 全部校验的路,而这两个字段会被**原样拼进
    // 提示词** —— `{review: 12}` 会以「12」的形状发给评审员,而屏幕上看不出来。
    const fs = memFs()
    fs.files.set('/run/run.md', [
      '---',
      'createdAt: x',
      'goalPrompt: g',
      'phaseGuidance:',
      '  质疑讨论: 看并发',   // 中文别名要归一
      '  乱写: 什么',          // 非法环节名
      '  execute: 12',        // 非字符串
      'roleGuidance:',
      '  - name: 甲',         // 缺 text
      '  - name: 乙',
      '    text: 看回滚',
      '---',
      '',
    ].join('\n'))
    const { config, degraded } = await readRunManifest(fs, '/run')
    expect(config.phaseGuidance).toEqual({ review: '看并发' })
    expect(config.roleGuidance).toEqual([{ name: '乙', text: '看回滚' }])
    expect(degraded.filter(d => d.includes('定向')).length).toBeGreaterThanOrEqual(2)
  })

  it('节点上那份补充指引:非法键和非字符串值都被清掉并点名', () => {
    // node.md 同样是可手工编辑的,而这一份直接决定发给模型的字节。
    const nodes = [{
      ...mk(),
      // biome-ignore lint/suspicious/noExplicitAny: 故意写坏的盘上数据
      guidance: { all: '注意兼容', 乱写: 'x', execute: 12, review: '   ' } as any,
    }]
    const { repairs } = validateLoadedNodes(nodes, NOW)
    expect(nodes[0]!.guidance).toEqual({ all: '注意兼容' })
    expect(repairs.some(r => r.includes('补充指引'))).toBe(true)
  })
})

describe('关口要把定向去处摊开', () => {
  it('每一条都写清进了哪个环节 / 哪一席', () => {
    /**
     * 哪句话进哪个环节是一次**抽取模型的判断**。抽错了运行会照常跑完,而用户唯一能发现的
     * 方式是事后翻 node.md —— 而关口存在的全部意义正是「批准之前看见自己批准了什么」。
     */
    const lines = guidanceLines(cfg({
      phaseGuidance: { review: '重点看并发安全' },
      roleGuidance: [{ name: '架构师', text: '给出回滚方案' }],
    }))
    expect(lines.some(l => l.includes('质疑讨论') && l.includes('并发安全'))).toBe(true)
    expect(lines.some(l => l.includes('架构师') && l.includes('回滚'))).toBe(true)
  })

  it('没有定向内容时一行都不画', () => {
    expect(guidanceLines(cfg())).toEqual([])
  })
})

describe('真的进了那次调用的提示词', () => {
  /** 收集每个环节实际发出去的提示词。 */
  function recorder() {
    const seen: { phase: string; prompt: string }[] = []
    const fn = (async (req: { phase: string; prompt: string }) => {
      seen.push({ phase: req.phase, prompt: req.prompt })
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn
    const promptOf = (phase: string) => seen.find(s => s.phase === phase)?.prompt ?? ''
    return { seen, fn, promptOf }
  }

  it('环节定向进的是**那个环节**的提示词', async () => {
    const r = recorder()
    const config = cfg({ phaseGuidance: { plan: '先按文件边界拆', review: '重点看并发安全' } })
    const n = mk()
    await stepStart(n, ctxFor([n], r.fn, config))
    expect(r.promptOf('plan')).toContain('先按文件边界拆')
    expect(r.promptOf('review')).toContain('重点看并发安全')
    // 分析那一条不该在评审提示词里以「针对质疑讨论」的名义出现 —— 它是执行侧的话。
    expect(r.promptOf('review')).toContain('先按文件边界拆')
    expect(r.promptOf('review')).toContain('都不算未完成')
  })

  it('裁决席位看得到给**执行侧**的那几条,并被告知以补充后的意图为准', async () => {
    /**
     * 这一条是实测换来的:用户补「别动 src/legacy」→ 执行者照做 → 验收员拿着补话之前定下的
     * 验收点对照产出 → 判不通过 → 返工 → 执行者下一轮同时拿到用户那句话和「方案要求改
     * legacy,未见改动」,两条直接打架 → 撞满 maxIterations 阻断。**用户自己那句纠正成了
     * 这个节点失败的直接原因**,而屏幕上没有任何东西会让他把这两件事联系起来。
     */
    const r = recorder()
    const config = cfg({ phaseGuidance: { execute: '别动 src/legacy' } })
    const n = mk({ status: 'READY', kind: 'executable', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' } })
    await stepExecute(n, ctxFor([n], r.fn, config))
    expect(r.promptOf('execute')).toContain('别动 src/legacy')
    expect(r.promptOf('accept')).toContain('别动 src/legacy')
    expect(r.promptOf('accept')).toContain('都不算未完成')
  })

  it('角色定向只进**名字对得上的那一席**', async () => {
    const seen: { label: string; prompt: string }[] = []
    const roles = emptyPhaseRoles()
    roles.review = [{ roleName: '甲', roleTag: '架构师' }, { roleName: '乙', roleTag: '安全' }]
    const config = cfg({
      phaseRoles: roles,
      roleGuidance: [{ name: '架构师', text: '给出回滚方案' }],
    })
    const runAgent = (async (req: { phase: string; prompt: string; role?: { roleName?: string } }) => {
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
      seen.push({ label: req.role?.roleName ?? '?', prompt: req.prompt })
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn
    const n = mk({ phaseRoles: roles })
    await stepStart(n, ctxFor([n], runAgent, config))
    const jia = seen.find(s => s.label === '甲')!
    const yi = seen.find(s => s.label === '乙')!
    expect(jia.prompt).toContain('给出回滚方案')
    // 点名给架构师的话不该出现在安全那一席的提示词里 —— 否则「点名」两个字没有意义,
    // 而每一席都要多背一段不属于它的要求(那是要付钱的)。
    expect(yi.prompt).not.toContain('给出回滚方案')
  })

  it('员工名也认,而且 ASCII 不分大小写', async () => {
    const seen: string[] = []
    const roles = emptyPhaseRoles()
    roles.review = [{ roleName: 'GPT5-方案' }]
    const config = cfg({ phaseRoles: roles, roleGuidance: [{ name: 'gpt5-方案', text: '写清回滚步骤' }] })
    const runAgent = (async (req: { phase: string; prompt: string }) => {
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
      seen.push(req.prompt)
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }) as unknown as RunAgentFn
    const n = mk({ phaseRoles: roles })
    await stepStart(n, ctxFor([n], runAgent, config))
    expect(seen[0]).toContain('写清回滚步骤')
  })

  it('节点上那份补充指引进的是**这个节点**的提示词', async () => {
    const r = recorder()
    const n = mk({ status: 'READY', kind: 'executable', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' } })
    attachGuidance(n, 'all', '这次务必补上测试')
    attachGuidance(n, 'execute', '先跑一遍 bun test')
    await stepExecute(n, ctxFor([n], r.fn, cfg()))
    expect(r.promptOf('execute')).toContain('这次务必补上测试')
    expect(r.promptOf('execute')).toContain('先跑一遍 bun test')
    // 裁决席位同样看得到 —— 见上面那条死循环。
    expect(r.promptOf('accept')).toContain('这次务必补上测试')
    expect(r.promptOf('accept')).toContain('先跑一遍 bun test')
  })

  it('集成验收席位也收得到 —— 七个环节一个都不许漏', async () => {
    /**
     * 十二个调用点是机械替换,而漏掉的那个环节就是一个「配得进去、永远到不了」的功能。
     * 这个仓库为这一类漏接线付过三次学费(onEscalate、onBlocked、openStream 各一次),
     * 所以这里对最容易被忘掉的那个环节单独钉一条。
     */
    const nodes = [
      mk({ id: 'root', kind: 'decompose', childIds: ['root/01-a'], status: 'WAITING_CHILDREN' }),
      mk({ id: 'root/01-a', parentId: 'root', depth: 1, kind: 'executable', status: 'ACCEPTED' }),
    ]
    attachGuidance(nodes[0]!, 'all', '合起来必须能一键回滚')
    const r = recorder()
    await stepIntegrate(nodes[0]!, ctxFor(nodes, r.fn, cfg({ phaseGuidance: { integrate: '按验收点逐条核' } })))
    // 集成验收走的是 phase: 'accept'(席位回落),所以按提示词内容认。
    const prompt = r.seen.map(s => s.prompt).join('\n')
    expect(prompt).toContain('合起来必须能一键回滚')
    expect(prompt).toContain('按验收点逐条核')
  })

  it('没有任何定向内容时,提示词和加这个功能之前逐字相同', async () => {
    // 一个不用这个功能的 run 不该因为它多背一个字节。
    const withGuide = recorder()
    const without = recorder()
    const a = mk({ status: 'READY', kind: 'executable', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' } })
    const b = mk({ status: 'READY', kind: 'executable', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' } })
    await stepExecute(a, ctxFor([a], withGuide.fn, cfg({ phaseGuidance: {} })))
    await stepExecute(b, ctxFor([b], without.fn, cfg()))
    // answerTag 是每次调用随机的,所以只比去掉尾部那条格式要求之后的正文。
    const strip = (s: string) => s.replace(/严格要求:[\s\S]*$/, '')
    expect(strip(withGuide.promptOf('execute'))).toBe(strip(without.promptOf('execute')))
  })
})
