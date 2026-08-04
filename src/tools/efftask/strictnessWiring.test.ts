// src/tools/efftask/strictnessWiring.test.ts
//
// 档位这个旋钮跨了九个文件,而它的每一处**接缝**都有一条已经付过学费的失败形态。
// 这个文件钉的就是那些接缝 —— strictness.test.ts 钉的是文本本身。
import { describe, expect, it } from 'bun:test'
import { validateLoadedNodes, readRunManifest } from './resumeCore.js'
import type { FsLike } from './persistence.js'
import { serializeNode } from './persistence.js'
import { parseDirectives } from './parseDirectives.js'
import { seatPreamble, stepStart, type PipelineCtx } from './pipeline.js'
import { createRunControl } from './control.js'
import { capsLine } from './startupConfirm.js'
import { feedbackItems, reviewRepeatNotice } from './reviewConvergence.js'
import { runControlAction } from '../../commands/efftask/logView.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, RoundtableRecord, TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const OPTS = { goal: '目标', phaseRoles: emptyPhaseRoles(), now: NOW }
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
const rec = (over: Partial<RoundtableRecord> = {}): RoundtableRecord => ({
  round: 1, verdicts: [{ role: 'main', pass: false, blocking: ['缺回滚方案'], comments: '' }],
  synthesized: { pass: false, blockingSummary: '[main] 缺回滚方案' }, ...over,
})
const fsWith = (files: Record<string, string>): FsLike => ({
  readFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
  writeFile: async () => {}, mkdir: async () => {}, mkdirExclusive: async () => true,
  unlink: async () => {}, rmdir: async () => {},
  readdir: async () => [], exists: async (p: string) => p in files,
})
const manifest = (caps: string[]): string => [
  '---', 'runId: 001', 'parallelism: 3', 'phaseRoles:', '  plan: []',
  'caps:', ...caps, 'goalPrompt: 目标', '---', '',
].join('\n')

describe('圆桌记录读得回来 —— step 今天就在被丢,strictness 会死在同一行', () => {
  /**
   * `roundArray` 是**逐字段重建**,只列了 round/verdicts/synthesized。而 `serializeNode`
   * 是 `{...node}` 全量倾倒 —— 也就是写得出去、读不回来。
   *
   * `step` 丢掉的连带后果不是「少一个字段」:`stepOfRound()` 对每条记录返回 undefined,
   * 于是 `judgeNotice` 的 `filter(r => stepOfRound(r) === step)` 恒为空 —— 每一次
   * `--resume` 之后,测试验证/验收/集成验收三关的「你前几轮提过什么」**全部失效**。
   */
  it('step 与 strictness 都活过一次落盘+读回', () => {
    const n = mk({ acceptLog: [rec({ step: 'verify', strictness: '专家' })] })
    // 真的走一遍序列化,不是手搓一个对象:落盘那一侧漏写同样会让这条断言失去意义。
    const disk = JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(n)))) as TaskNode
    expect(serializeNode(disk)).toContain('专家')
    const got = validateLoadedNodes([disk], OPTS).nodes[0]!
    expect(got.acceptLog[0]!.step).toBe('verify')
    expect(got.acceptLog[0]!.strictness).toBe('专家')
  })
  it('非法值一律丢掉 —— 手改 node.md 是绕开全部上游校验的一条路', () => {
    const n = mk({ acceptLog: [rec({ step: 'nonsense', strictness: '超级严格' } as never)] })
    const got = validateLoadedNodes([n], OPTS).nodes[0]!
    expect(got.acceptLog[0]!.step).toBeUndefined()
    expect(got.acceptLog[0]!.strictness).toBeUndefined()
  })
  it('老记录(两个字段都没有)照旧读回,不被塞进任何默认值', () => {
    const got = validateLoadedNodes([mk({ acceptLog: [rec()] })], OPTS).nodes[0]!
    expect(got.acceptLog[0]!.step).toBeUndefined()
    expect(got.acceptLog[0]!.strictness).toBeUndefined()
    expect(got.acceptLog[0]!.synthesized.blockingSummary).toBe('[main] 缺回滚方案')
  })

  /**
   * `voided` 是同一行上的第三个字段,而它丢掉的后果最刺眼:一条**已作废**的裁决恢复之后
   * 重新长得和真裁决一模一样 ——「node.md 上读得出哪一轮不算数」这个承诺只活到下一次
   * `--resume`。step / strictness 各自死在这里过一次,这条是替第三个字段站岗的。
   */
  it('voided 也活过一次落盘+读回,非法值照旧丢掉', () => {
    const why = '测试验证环节改动了工作区,该轮裁决作废'
    const n = mk({ acceptLog: [rec({ step: 'verify', voided: why })] })
    const disk = JSON.parse(JSON.stringify(n)) as TaskNode
    expect(serializeNode(disk)).toContain('已作废')
    expect(validateLoadedNodes([disk], OPTS).nodes[0]!.acceptLog[0]!.voided).toBe(why)
    // 空串和非字符串都不算「作废」—— 否则渲染出一个空的 [已作废:]
    for (const bad of ['', 42, {}] as never[]) {
      const got = validateLoadedNodes([mk({ acceptLog: [rec({ voided: bad })] })], OPTS).nodes[0]!
      expect(got.acceptLog[0]!.voided).toBeUndefined()
    }
  })
})

describe('run.md 里的档位读得回来', () => {
  it('合法值往返', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': manifest(['  strictness: 高级']) }), '/r')
    expect(config.caps.strictness).toBe('高级')
  })
  it('老 run.md 没有这个字段时是 undefined —— 绝不给具名默认档', async () => {
    /**
     * 默认成「高级」会让一个原本全票跑的旧 run 恢复之后变成 quorum 80(5 席下 4/5),
     * 也就是**恢复之后变松了**,而屏幕上没有任何东西会说这件事。
     */
    const { config } = await readRunManifest(fsWith({ '/r/run.md': manifest(['  maxDepth: 4']) }), '/r')
    expect(config.caps.strictness).toBeUndefined()
  })
  it('手改成非法值时退回不设档,而不是穿过去', async () => {
    const { config } = await readRunManifest(fsWith({ '/r/run.md': manifest(['  strictness: 随便']) }), '/r')
    expect(config.caps.strictness).toBeUndefined()
  })
})

describe('提示词抽取', () => {
  const run = (o: unknown): ReturnType<typeof parseDirectives> =>
    parseDirectives('x', { modelJson: async () => JSON.stringify(o), knownRoles: [] })

  it('合法档位落进 caps', async () => {
    expect((await run({ caps: { strictness: '初级' } })).caps.strictness).toBe('初级')
  })
  it('非法档位回落不设档,并且**说出来**', async () => {
    // 静默回落在这里格外坏:用户说了「按最高标准做」,系统按现状跑,而他会以为生效了。
    const r = await run({ caps: { strictness: '超严' } })
    expect(r.caps.strictness).toBeUndefined()
    expect(r.notices.join(' ')).toContain('超严')
  })
  it('没提就没有,不注入默认', async () => {
    expect((await run({ caps: { maxDepth: 3 } })).caps.strictness).toBeUndefined()
  })
})

describe('seatPreamble:档位独立成段,不碰 JUDGE_NOTE 的闸门', () => {
  const cfgWith = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, ...over,
  })
  const JUDGE = '用户补充的约束'

  it('没有任何定向注入时:档位在,JUDGE_NOTE 不在', () => {
    /**
     * 这是**两个 bug 的交叉点**。档位文本若 push 进 `out`,`targeted.length` 恒 > 0 →
     * JUDGE_NOTE 对每个裁决席位无条件生效,而那句话此时是假的(没有任何用户补充),
     * 却是全提示词里最强的一句放行指令。反过来若拼在 return 那一行,没有定向注入时会
     * 走提前返回 → 档位整个丢掉,而那是绝大多数运行的常态。
     */
    const out = seatPreamble({ config: cfgWith({ caps: { ...DEFAULT_CAPS, strictness: '初级' } }) }, null, 'accept')
    expect(out).toContain('严格度:**初级**')
    expect(out).not.toContain(JUDGE)
  })
  it('有定向注入时:JUDGE_NOTE 照旧,而且档位排在注入之前', () => {
    const cfg = cfgWith({
      caps: { ...DEFAULT_CAPS, strictness: '专家' },
      phaseGuidance: { accept: '逐条核对验收点' },
    })
    const out = seatPreamble({ config: cfg }, null, 'accept')
    expect(out).toContain(JUDGE)
    // 档位是默认判据、用户点名的是特例 —— 顺序反了的话谁赢由模型掷骰子。
    expect(out.indexOf('严格度:**专家**')).toBeLessThan(out.indexOf('逐条核对验收点'))
    expect(out).toContain('用户点名补充的约束优先于它')
  })
  it('不设档时输出与引入本特性之前逐字相同(无注入 → 空)', () => {
    expect(seatPreamble({ config: cfgWith() }, null, 'accept')).toBe('')
  })
  it('control 里调过的档位盖过 config —— 关口批准的那份只是起点', () => {
    const control = createRunControl()
    control.setStrictness('初级')
    const out = seatPreamble({ config: cfgWith({ caps: { ...DEFAULT_CAPS, strictness: '专家' } }), control }, null, 'accept')
    expect(out).toContain('严格度:**初级**')
    expect(out).not.toContain('专家')
  })
})

describe('端到端:档位真的到达模型调用,并盖在记录上', () => {
  const vtag = (req: { prompt: string }): string => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
  const ctxFor = (nodes: TaskNode[], runAgent: RunAgentFn, config: EffTaskConfig, control?: ReturnType<typeof createRunControl>): PipelineCtx => ({
    config, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
    ...(control ? { control } : {}),
  })
  const cfg = (over: Partial<EffTaskConfig['caps']> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM,
    phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: '' }] },
    caps: { ...DEFAULT_CAPS, ...over },
  })

  it('评审提示词按档取值,而 reviewLog 上盖着同一档', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg({ strictness: '专家' })))
    const review = seen.find(p => p.includes('请评审'))!
    expect(review).toContain('本次严格度:专家')
    expect(review).toContain('将来会咬人')
    // 现状那三条**不该**同时在场 —— 那正是「四档坍缩成一档」的形态。
    expect(review).not.toContain('能达到这条就判通过')
    expect(n.reviewLog[0]!.strictness).toBe('专家')
  })

  it('不设档时:提示词回到现状那三条,记录上不多任何键', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const review = seen.find(p => p.includes('请评审'))!
    expect(review).toContain('能达到这条就判通过')
    expect(review).not.toContain('严格度')
    expect(Object.keys(n.reviewLog[0]!)).not.toContain('strictness')
  })

  /**
   * 门槛这一维必须**两个方向都钉**。只断言「初级档下通过了」的话,一个把 quorum 整个
   * 忽略掉的实现照样绿 —— 那正是这个仓库反复在修的「探针坏了而不是覆盖不够」。
   */
  const threeSeatsOneReject = async (strictness?: '初级'): Promise<TaskNode> => {
    let i = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      const reject = i++ === 0
      return vtag(req) + `\n{"pass":${!reject},"blocking":${reject ? '["小问题"]' : '[]'},"comments":""}\n` + '```'
    }
    const roster = [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }]
    const config = cfg(strictness ? { strictness } : {})
    config.phaseRoles.review = roster
    const n = mk({ kind: 'executable', status: 'PLANNING', phaseRoles: { ...emptyPhaseRoles(), review: roster } })
    await stepStart(n, ctxFor([n], runAgent, config))
    return n
  }
  it('初级档:3 席里 1 席反对仍然通过(2/3 过半),一轮就出门', async () => {
    const n = await threeSeatsOneReject('初级')
    expect(n.reviewLog[0]!.synthesized.pass).toBe(true)
    expect(n.reviewLog).toHaveLength(1)
    expect(n.status).toBe('READY')
  })
  /**
   * infra 重试的**合并分支**。变异测试实测:把重新合成那一行改回现读 `ctx.config.caps`、
   * 或者把合并分支的 `stamp(...)` 去掉,**整套测试全绿** —— 因为此前每一条档位用例走的
   * 都是首桌那条路。这是我自己写的接缝上的一个洞。
   *
   * 两条断言各杀一个变异:
   *  - `synthesized.pass` —— 现读的话 `caps.quorum` 是 undefined(档位派生值不回写),
   *    `synthesizeVerdicts` 退回**全票**,于是一个初级档的运行只要撞上一次 429 就被按
   *    专家的门槛重算。这正是设计文档里说的这个旋钮最不能有的失败形态。
   *  - `rec.strictness` —— 不盖戳的话,凡是发生过 infra 重试的那几轮在盘上**没有档位**,
   *    而跨档注记恰好对这几轮静默失效。
   */
  it('infra 重派后合并的那一桌:仍按档位门槛合成,并盖着档位戳', async () => {
    const roster = [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }]
    /**
     * **三席全部**第一次打不通,第二桌 b 投反对、a/c 赞成。
     *
     * 这个形状是被实测逼出来的,前两版都到不了合并分支:
     *  - 「只有 b 打不通」——`synthesizeVerdicts` 把 infra 排除在**分母**外,于是首桌
     *    judged=2、赞成 2,初级档(51)当场就过了,重试根本不发生。
     *  - 「a 真的反对 + b 打不通」——首桌有真反对,`isInfraOnlyFailure` 为假,同样不重试。
     * 三席全 infra 才让首桌 judged=0 → 不通过且是 infra-only → 重派全部三席 →
     * `fresh.verdicts.length === only.length` → 走合并分支。合并后 2/3 赞成:
     * 初级档(51)通过,全票不通过 —— 两个变异各自被这一点分开。
     */
    const failedOnce = new Set<string>()
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      const who = req.role?.roleName ?? 'main'
      if (!failedOnce.has(who)) { failedOnce.add(who); throw new Error('provider unreachable') }
      return who === 'b'
        ? vtag(req) + '\n{"pass":false,"blocking":["小问题"],"comments":""}\n```'
        : vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const config = cfg({ strictness: '初级' })
    config.phaseRoles.review = roster
    const n = mk({ kind: 'executable', status: 'PLANNING', phaseRoles: { ...emptyPhaseRoles(), review: roster } })
    await stepStart(n, ctxFor([n], runAgent, config))
    const last = n.reviewLog[0]!
    expect(last.verdicts.map(v => v.role)).toEqual(['a', 'b', 'c'])
    expect(last.synthesized.pass).toBe(true)
    expect(last.strictness).toBe('初级')
  })

  /**
   * 运行中改档 —— `roundtableWithInfraRetry` 的 `strictness` 参数整段注释讲的就是这件事,
   * 而在这条用例之前**没有任何东西钉住它**(验收阶段是人工跑了一次确认的)。
   *
   * 两个方向都要断言,而且要落在同一个节点的两条相邻记录上:
   *  - 在飞那一轮认**旧档**(判据文本 + 门槛 + 戳三处同源);
   *  - 下一轮认**新档**。
   * 只断言后者的话,一个「一改档就把在飞那桌也按新门槛重算」的实现照样绿 —— 而那正是
   * 那段注释推演出来的、结论会从不通过翻成通过的那条路。
   */
  it('运行中改档:在飞那一轮认旧档,下一轮认新档', async () => {
    const seen: { phase: string; prompt: string }[] = []
    const control = createRunControl()
    let reviewRound = 0
    const runAgent: RunAgentFn = async req => {
      seen.push({ phase: req.phase, prompt: req.prompt })
      if (req.phase === 'plan') return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      reviewRound++
      // 第一轮:两席赞成一席反对 → 专家(全票)不通过。此刻用户降档。
      if (reviewRound <= 3) {
        if (reviewRound === 3) control.setStrictness('初级')
        return vtag(req) + `\n{"pass":${reviewRound !== 1},"blocking":${reviewRound === 1 ? '["小问题"]' : '[]'},"comments":""}\n` + '```'
      }
      // 第二轮:同样两席赞成一席反对 —— 初级(34)通过。
      return vtag(req) + `\n{"pass":${reviewRound !== 4},"blocking":${reviewRound === 4 ? '["小问题"]' : '[]'},"comments":""}\n` + '```'
    }
    const roster = [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }]
    const config = cfg({ strictness: '专家' })
    config.phaseRoles.review = roster
    const n = mk({ kind: 'executable', status: 'PLANNING', phaseRoles: { ...emptyPhaseRoles(), review: roster } })
    await stepStart(n, ctxFor([n], runAgent, config, control))

    expect(n.reviewLog).toHaveLength(2)
    // 在飞那一轮:戳 = 专家,而且是按全票合成的(2/3 赞成仍然不通过)。
    expect(n.reviewLog[0]!.strictness).toBe('专家')
    expect(n.reviewLog[0]!.synthesized.pass).toBe(false)
    // 下一轮:戳 = 初级,同样的 2/3 赞成通过了。
    expect(n.reviewLog[1]!.strictness).toBe('初级')
    expect(n.reviewLog[1]!.synthesized.pass).toBe(true)
    // 提示词也跟着换了 —— 门槛换了而判据文本没换的话,两者会打架。
    const reviews = seen.filter(s => s.phase === 'review').map(s => s.prompt)
    expect(reviews[0]).toContain('严格度:**专家**')
    expect(reviews[reviews.length - 1]).toContain('严格度:**初级**')
  })

  it('不设档:同一批裁决第一轮**不通过**(全票),要多烧一轮 —— 反向探针', async () => {
    // 「多跑一轮」正是用户报的那个症状,而这两条用例合起来就是它的因果:
    // 同一批席位、同一批意见,唯一的变量是门槛。
    const n = await threeSeatsOneReject()
    expect(n.reviewLog[0]!.synthesized.pass).toBe(false)
    expect(n.reviewLog.length).toBeGreaterThan(1)
  })
})

describe('control:档位是持续状态,不进 clearAll* 那一批', () => {
  /**
   * redo 走 `applyRedo → startRun → runOrchestrator`,用的是同一个 RunControl,而那条路上
   * 就有这两个 clear。顺手把档位也清掉的话:用户降到初级、看着半成品被放行、按 r 重做,
   * 拿到的是又一次不设档的结果。这个仓库为「一次性标记忘了清」付过三次学费;这条是它的镜像。
   */
  it('clearAllForcePasses / clearAllCancels 之后档位还在', () => {
    const c = createRunControl()
    c.setStrictness('中级')
    c.forcePass('n1', 'accept')
    c.cancelNode('n1')
    c.clearAllForcePasses()
    c.clearAllCancels()
    expect(c.strictness()).toBe('中级')
  })
  it('没调过时是 undefined —— 由调用方回落到 config', () => {
    expect(createRunControl().strictness()).toBeUndefined()
  })
})

describe('按键', () => {
  it('< > 与 , . 都认(不同终端对 Shift 组合上报不一致)', () => {
    for (const k of ['>', '.']) expect(runControlAction(k, {})).toBe('raiseStrictness')
    for (const k of ['<', ',']) expect(runControlAction(k, {})).toBe('lowerStrictness')
  })
  it('合批的连按只算一步 —— 每跳一级都会改变接下来每一场圆桌的判据', () => {
    expect(runControlAction('>>>>>', {})).toBe('raiseStrictness')
  })
  it('组合键不抢', () => {
    expect(runControlAction('>', { ctrl: true })).toBeNull()
    expect(runControlAction('>', { meta: true })).toBeNull()
  })
})

describe('关口印的是绝对门槛,不是百分比', () => {
  const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
    goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS }, ...over,
  })
  it('席位数下与全票等价时,必须自己说出来', () => {
    // 80% 在 3 席上是 3/3。印「需 80% 席位赞成」而实际要全票 = 骗人。
    const line = capsLine(cfg({
      caps: { ...DEFAULT_CAPS, strictness: '高级' },
      phaseRoles: { ...emptyPhaseRoles(), accept: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] },
    }))
    expect(line).toContain('与全票同义')
    expect(line).not.toContain('80%')
  })
  it('各关席位数不同时按关分组印 —— 取 Math.max 等于把骗人换个形式', () => {
    /**
     * review 5 席 / accept 2 席、高级档:review 真实门槛 4/5,accept 是 2/2 全票。
     * 上一版取最大值印「4/5」,而用户读到的是「一票反对也能过」—— 对 accept 关是假的。
     */
    const line = capsLine(cfg({
      caps: { ...DEFAULT_CAPS, strictness: '高级' },
      phaseRoles: {
        ...emptyPhaseRoles(),
        review: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }, { roleName: 'd' }, { roleName: 'e' }],
        accept: [{ roleName: 'x' }, { roleName: 'y' }],
      },
    }))
    expect(line).toContain('质疑讨论 4/5')
    expect(line).toContain('其余各关仍需全票')
  })
  it('真的放宽时印 N/M 席', () => {
    const line = capsLine(cfg({
      caps: { ...DEFAULT_CAPS, strictness: '初级' },
      phaseRoles: { ...emptyPhaseRoles(), accept: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] },
    }))
    expect(line).toContain('2/3 席赞成')
  })
  it('用户自己写过门槛时,照实说档位不改它', () => {
    const line = capsLine(cfg({ caps: { ...DEFAULT_CAPS, strictness: '初级', quorumSeats: 2 } }))
    expect(line).toContain('档位不改它')
  })
  it('不设档时这一段一个字都不印', () => {
    expect(capsLine(cfg())).not.toContain('严格度')
  })
})

describe('跨档历史:降档之后不能被上一档的账追着走', () => {
  /**
   * `reviewRepeatNotice` 末尾那句「若仍未回应,请指出缺了什么」是**无条件**的追责指令。
   * 降档之后它会逼着中级档的评审员把一条只在专家档下才算阻断的意见重新提成 blocking ——
   * 降档等于没降,而且是静默的。
   */
  const log = [
    rec({ round: 1, strictness: '专家', verdicts: [{ role: 'a', pass: false, blocking: ['并发路径下 cache 失效未处理'], comments: '' }] }),
  ]
  it('条目带上它当初那一档,并在与本轮不同时标出来', () => {
    const items = feedbackItems(log)
    expect(items[0]!.strictness).toBe('专家')
    const n = reviewRepeatNotice(items, 2, '验收', '这一版产出', '中级')
    expect(n).toContain('/专家档')
    expect(n).toContain('本轮是**中级**档')
    expect(n).toContain('按本轮档位不阻断')
  })
  it('同一档时不标 —— 相同就是噪声,而这段是 per-seat 计费的', () => {
    const n = reviewRepeatNotice(feedbackItems(log), 2, '验收', '这一版产出', '专家')
    expect(n).not.toContain('/专家档')
    expect(n).not.toContain('按本轮档位不阻断')
  })
  it('不设档时输出与引入本特性之前逐字相同', () => {
    const plain = [rec({ round: 1, verdicts: [{ role: 'a', pass: false, blocking: ['缺回滚'], comments: '' }] })]
    const n = reviewRepeatNotice(feedbackItems(plain), 2)
    expect(n).not.toContain('档')
    expect(n).toContain('前几轮已经提出过下面这些意见')
  })
  it('同一条跨两档时取更严的那一档', () => {
    const two = [
      rec({ round: 1, strictness: '中级', verdicts: [{ role: 'a', pass: false, blocking: ['缺回滚方案'], comments: '' }] }),
      rec({ round: 2, strictness: '专家', verdicts: [{ role: 'a', pass: false, blocking: ['缺回滚方案'], comments: '' }] }),
    ]
    expect(feedbackItems(two)[0]!.strictness).toBe('专家')
  })
})
