// src/tools/efftask/forcePass.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM, MANUAL_PASS_ROLE } from './types.js'
import type { EffTaskConfig, PhaseName, TaskNode } from './types.js'
import { byIdMap } from './stateMachine.js'
import { PipelineCtx, stepStart, stepExecute, stepIntegrate } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'
import { createRunControl } from './control.js'
import { planForcePass, planRedo, forcePassFailedPhaseReason, forcePassOptions, forcePassSummary } from './redo.js'
import { validateLoadedNodes } from './resumeCore.js'
import { serializeNode } from './persistence.js'

/**
 * 强制通过 —— 用户的原话:「圆桌没有过导致任务失败了…那就是加一个强制通过」。
 *
 * 这一组全部走**真接缝**:`stepStart` / `stepExecute` / `stepIntegrate` 真的跑一遍,
 * runAgent 是一个会记账的假模型。判据是「圆桌那一桌到底派没派出去」和「log 里多出来的
 * 那条记录长什么样」,不是源码文本 —— 后者在这个功能上是个特别坏的探针:强制通过和跳过
 * 共用了大半实现,文本断言会同时被两条路满足。
 */

const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const NOW = '2026-07-30T00:00:00Z'
const cfg: EffTaskConfig = { goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }

function ctxFor(
  nodes: TaskNode[],
  runAgent: RunAgentFn,
  extra?: Partial<PipelineCtx>,
): PipelineCtx {
  const byId = byIdMap(nodes)
  return {
    config: cfg, byId, runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
    ...extra,
  }
}

const root = (): TaskNode =>
  createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

/** 记下每个环节被派出去几次 —— 「圆桌没开」这件事只有数它才证得了。 */
function counting(reply: (req: { phase: string; prompt: string }) => string) {
  const calls: string[] = []
  const runAgent: RunAgentFn = async req => {
    calls.push(req.phase)
    return reply(req)
  }
  return { calls, runAgent }
}

const PASS = (req: { prompt: string }) => vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
const FAIL = (req: { prompt: string }) => vtag(req) + '\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
const EXEC = '```json\n{"execStatus":"改了 foo.ts"}\n```'
const PLAN = '```json\n{"kind":"executable","solution":"做它","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'

/** log 里那条人工裁决。找不到时返回 undefined —— 断言方自己说该不该有。 */
const manualOf = (log: TaskNode['reviewLog']) => log.find(r => r.verdicts.some(v => v.manual === true))

describe('强制通过:四个环节都不开会,但都留下一条署名的人工裁决', () => {
  it('质疑讨论 —— 评审一次都不派,reviewLog 里多一条 MANUAL', async () => {
    const n = root()
    n.forcePass = 'review'
    const { calls, runAgent } = counting(req => (req.phase === 'plan' ? PLAN : PASS(req)))
    await stepStart(n, ctxFor([n], runAgent))

    // 这一条是整个功能的判据:评审那一桌**一次都没派出去**。
    expect(calls.filter(p => p === 'review')).toHaveLength(0)
    // 而分析照常跑 —— 强制通过的是判决,不是工作。
    expect(calls.filter(p => p === 'plan')).toHaveLength(1)
    expect(n.status).toBe('READY')

    const rec = manualOf(n.reviewLog)
    expect(rec).toBeDefined()
    expect(rec!.synthesized.pass).toBe(true)
    expect(rec!.verdicts[0].role).toBe(MANUAL_PASS_ROLE)
    expect(rec!.step).toBe('review')
    // 一次性:用掉就没了。留着的话下一次返工进来会再放行一次,而屏幕上没说过还有第二次。
    expect(n.forcePass).toBeUndefined()
  })

  it('验收 —— 圆桌不开、执行者也不重跑,acceptLog 里多一条 MANUAL', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '上一轮改的 foo.ts'
    n.forcePass = 'accept'
    const { calls, runAgent } = counting(req => (req.phase === 'execute' ? EXEC : PASS(req)))
    await stepExecute(n, ctxFor([n], runAgent))

    expect(calls.filter(p => p === 'accept')).toHaveLength(0)
    /**
     * **执行环节也不重跑** —— 这一条和跳过逐字同因(见 stepExecute 的 judgePhase):
     * 用户放行的是他刚看过的那份产出,重跑执行者会把它换成另一份没人看过的。
     * 少了它,这里会是 1 次 execute,而 execStatus 会被覆盖成「改了 foo.ts」。
     */
    expect(calls.filter(p => p === 'execute')).toHaveLength(0)
    expect(n.execStatus).toContain('上一轮改的 foo.ts')
    expect(n.status).toBe('ACCEPTED')
    expect(manualOf(n.acceptLog)?.step).toBe('accept')
    expect(n.forcePass).toBeUndefined()
  })

  it('测试验证 —— 一个测试都不实跑,而验收照常开', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '上一轮改的 foo.ts'
    n.phaseRoles = { ...emptyPhaseRoles(), verify: [{ roleName: 'tester', model: 'm' }] }
    n.forcePass = 'verify'
    const { calls, runAgent } = counting(req => (req.phase === 'execute' ? EXEC : PASS(req)))
    await stepExecute(n, ctxFor([n], runAgent))

    expect(calls.filter(p => p === 'verify')).toHaveLength(0)
    // 验收**照常开** —— 强制通过的粒度是一个环节,不是「后面都别判了」。
    expect(calls.filter(p => p === 'accept')).toHaveLength(1)
    expect(n.status).toBe('ACCEPTED')
    const rec = manualOf(n.acceptLog)
    expect(rec?.step).toBe('verify')
  })

  it('集成验收 —— 根节点的最终裁决由人给出,子任务一个不动', async () => {
    const parent = root()
    parent.kind = 'decompose'; parent.status = 'WAITING_CHILDREN'
    parent.childIds = ['root/01-a']
    parent.forcePass = 'integrate'
    const child = createNode({ id: 'root/01-a', title: 'a', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    child.status = 'ACCEPTED'
    const { calls, runAgent } = counting(req => PASS(req))
    await stepIntegrate(parent, ctxFor([parent, child], runAgent))

    expect(calls).toHaveLength(0)
    expect(parent.status).toBe('ACCEPTED')
    expect(manualOf(parent.acceptLog)?.step).toBe('integrate')
    expect(child.status).toBe('ACCEPTED') // 子任务一个字没动
  })
})

describe('那条记录必须一眼看出是人写的', () => {
  it('被覆盖掉的阻断意见抄进 comments —— 否则事后没人知道放行了什么', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '交过了'
    // 上一轮验收判的不通过,原样躺在 log 里。
    n.acceptLog = [{
      round: 1,
      verdicts: [{ role: 'qa', pass: false, blocking: ['并发下会丢单'], comments: '' }],
      synthesized: { pass: false, blockingSummary: '[qa] 并发下会丢单' },
    }]
    n.forcePass = 'accept'
    await stepExecute(n, ctxFor([n], async req => PASS(req)))

    const rec = manualOf(n.acceptLog)!
    expect(rec.verdicts[0].comments).toContain('并发下会丢单')
    // 原来那条**不许被改写**:强制通过是在它之上再记一笔,不是把历史抹掉。
    expect(n.acceptLog[0].synthesized.pass).toBe(false)
    expect(n.acceptLog[0].verdicts[0].blocking).toEqual(['并发下会丢单'])
  })

  it('node.md 上它的记号是 MANUAL-PASS,不是 pass', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '交过了'
    n.forcePass = 'accept'
    await stepExecute(n, ctxFor([n], async req => PASS(req)))

    const md = serializeNode(n)
    /**
     * 渲染成 `pass` 的话,它和一位真评审员点头**逐字相同** —— 而那正是这条记录存在的
     * 全部理由。这一行是事后追责唯一读得到的东西。
     */
    expect(md).toContain('MANUAL-PASS')
    expect(md).toContain(MANUAL_PASS_ROLE)
  })

  it('判据是 manual 那个布尔,不是 role 里那四个字', async () => {
    /**
     * role 是显示用的字符串,而 node.md 可手工编辑。拿它当判据等于让「把角色名改成
     * 这四个字」成为一条伪造人工放行的路 —— 一个叫这个名字的真评审员会被标成 MANUAL。
     */
    const n = root()
    n.acceptLog = [{
      round: 1,
      // 名字一模一样,但没有 manual —— 它是一位(名字起得很怪的)真评审员。
      verdicts: [{ role: MANUAL_PASS_ROLE, pass: true, blocking: [], comments: '看过了' }],
      synthesized: { pass: true, blockingSummary: '' },
    }]
    expect(serializeNode(n)).not.toContain('MANUAL-PASS')
  })
})

describe('运行中预先批准:另一条来路,同一个出口', () => {
  it('control 上记一笔就够了,节点上一个字都不用写', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '交过了'
    const control = createRunControl()
    control.forcePass('root', 'accept')
    const { calls, runAgent } = counting(req => (req.phase === 'execute' ? EXEC : PASS(req)))
    await stepExecute(n, ctxFor([n], runAgent, { control }))

    expect(calls.filter(p => p === 'accept')).toHaveLength(0)
    expect(n.status).toBe('ACCEPTED')
    expect(manualOf(n.acceptLog)).toBeDefined()
    // 一次性,而且清的是 **control** 那一侧 —— 节点上本来就没写过。
    expect(control.wasForcePassed('root', 'accept')).toBe(false)
  })

  it('预先批准**不让节点跳过执行** —— 这是它和阻断后那条路唯一的行为差别', async () => {
    /**
     * 阻断后按的那次(`node.forcePass`)只可能落在一个**已经交过东西**的节点上,所以它
     * 从判决段进来。预先批准可以按在一个还没开始执行的节点上 —— 那时候从判决段进来
     * 等于让它一行代码不写就去验收,正是 SKIPPABLE_PHASES 那条界线要挡的事。
     */
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.execStatus = '' // 还没干活
    const control = createRunControl()
    control.forcePass('root', 'accept')
    const { calls, runAgent } = counting(req => (req.phase === 'execute' ? EXEC : PASS(req)))
    await stepExecute(n, ctxFor([n], runAgent, { control }))

    expect(calls.filter(p => p === 'execute')).toHaveLength(1) // 活照干
    expect(n.execStatus).toContain('改了 foo.ts')
    expect(calls.filter(p => p === 'accept')).toHaveLength(0)  // 只是不开会
    // 留痕照旧:名册挂着验收席位、记录里却只有一条人工裁决,不写这一行就读不出为什么。
    expect(n.execStatus).toContain('人工强制通过')
    expect(n.status).toBe('ACCEPTED')
  })

  it('用掉之后的返工轮照常开会 —— 一次性不是「这个环节从此不判了」', async () => {
    const n = root()
    n.kind = 'executable'; n.status = 'READY'
    n.phaseRoles = { ...emptyPhaseRoles(), verify: [{ roleName: 'tester', model: 'm' }] }
    const control = createRunControl()
    control.forcePass('root', 'verify')
    // 验收第一轮判不通过 → 返工 → 第二轮 verify 必须真的开。
    let acceptRounds = 0
    const { calls, runAgent } = counting(req => {
      if (req.phase === 'execute') return EXEC
      if (req.phase === 'accept') return ++acceptRounds === 1 ? FAIL(req) : PASS(req)
      return PASS(req)
    })
    await stepExecute(n, ctxFor([n], runAgent, { control }))

    expect(n.status).toBe('ACCEPTED')
    // 第一轮被放行、第二轮真开 —— 恰好一次。
    expect(calls.filter(p => p === 'verify')).toHaveLength(1)
  })

  it('clearAllForcePasses 报出被清掉的条数 —— 静默丢掉用户按过的批准不行', () => {
    const control = createRunControl()
    control.forcePass('a', 'accept')
    control.forcePass('a', 'review')
    control.forcePass('b', 'integrate')
    expect(control.forcePassesOf('a').sort()).toEqual(['accept', 'review'])
    expect(control.clearAllForcePasses()).toBe(3)
    expect(control.clearAllForcePasses()).toBe(0)
    expect(control.wasForcePassed('a', 'accept')).toBe(false)
  })

  it('分析和执行进不了这条门 —— 它们没有「通过」可言', () => {
    const control = createRunControl()
    control.forcePass('a', 'plan' as PhaseName)
    control.forcePass('a', 'execute' as PhaseName)
    expect(control.forcePassesOf('a')).toEqual([])
  })
})

describe('闸门:和跳过一字不差,而这条尤其不能漏', () => {
  const blockedAt = (status: TaskNode['failedAt']): TaskNode => {
    const n = root()
    n.kind = 'executable'; n.status = 'BLOCKED'; n.failedAt = status
    n.execStatus = '交过了'
    n.plan = { ...n.plan, solution: '做它' }
    return n
  }

  it('隔离运行 + 工作区引用已丢 → 不许强制通过验收', () => {
    const n = blockedAt('ACCEPTANCE')
    n.worktree = undefined
    const why = forcePassFailedPhaseReason(n, { isolated: true })
    /**
     * 跳过它会把一个空工作区合进集成分支并判「已验收」;强制通过在此之上**还要**记一条
     * 「有人放行过」—— 严格更坏。这一条漏掉的代价是产出一行都没进集成分支,而记录说通过了。
     */
    expect(why).toContain('空工作区')
    expect(why).toContain('强制通过')
    expect(planForcePass([n], 'root', NOW, { isolated: true })).toHaveProperty('error')
  })

  it('没失败的节点、失败在分析/执行的节点,都给出原因而不是默默不动', () => {
    const running = root(); running.status = 'EXECUTING'
    expect(forcePassFailedPhaseReason(running)).toContain('没有失败')

    const atPlan = blockedAt('PLANNING')
    expect(forcePassFailedPhaseReason(atPlan)).toContain('分析')
    const atExec = blockedAt('EXECUTING')
    expect(forcePassFailedPhaseReason(atExec)).toContain('执行')
    // 措辞跟着动作走 —— 接错成跳过那份的话这里会写「跳过它等于…」。
    expect(forcePassFailedPhaseReason(atExec)).toContain('强制通过')
  })

  it('planForcePass 写的是 forcePass,而 skipPhase 被显式清空', () => {
    const n = blockedAt('ACCEPTANCE')
    n.skipPhase = 'review' // 上一次跳过留下的
    const plan = planForcePass([n], 'root', NOW)
    expect(plan).not.toHaveProperty('error')
    const out = (plan as { nodes: TaskNode[] }).nodes[0]
    expect(out.forcePass).toBe('accept')
    /**
     * 两个字段**互斥**。留着旧的 skipPhase 的话,它的第二个作用(让 stepExecute 从判决段
     * 进来)会在下一轮再次生效 —— 执行环节从此不再跑,而屏幕上什么都没说。
     */
    expect(out.skipPhase).toBeUndefined()
    expect(out.status).toBe('READY')
    expect(out.failedAt).toBeUndefined()
  })

  it('普通重做把旧的 forcePass 清掉 —— 「重做一遍看看」不许变成「重做一遍再放行一次」', () => {
    /**
     * `reseatForRerun` 是所有重入路径的必经点,它对 forcePass 是**无条件写**(包括写
     * undefined),和它对 failedAt / capBlocked / blockedReason 的处理同因。
     *
     * 条件写(`if (opts.forcePass)`)的话:一个被强制通过过、后来又走普通重做的节点会
     * 带着旧标记回来 —— 用户按 r 想让验收重新判一次,拿到的却是又一次零调用放行,
     * 而屏幕上那三屏菜单一个字都没提过它。
     */
    const n = blockedAt('ACCEPTANCE')
    n.forcePass = 'accept' // 上一次强制通过留下的
    const plan = planRedo([n], 'root', 'execute', NOW)
    expect(plan).not.toHaveProperty('error')
    expect((plan as { nodes: TaskNode[] }).nodes[0].forcePass).toBeUndefined()
  })

  it('确认屏上那段话说的是「会留一条通过」,而不是跳过那句「不留」', () => {
    const n = blockedAt('ACCEPTANCE')
    const plan = planForcePass([n], 'root', NOW) as { warnings: string[] }
    const lines = forcePassSummary(plan as never, n, 'accept')
    expect(lines.join('\n')).toContain(MANUAL_PASS_ROLE)
    expect(lines.join('\n')).not.toContain('也不会在记录里留一条通过')
    // 执行不重跑那一条要照旧在 —— 它是这一下最容易被误解的地方。
    expect(lines.join('\n')).toContain('执行环节不重跑')
  })

  it('运行中能选哪几个环节:不存在的和结构上不适用的都列出来并说原因', () => {
    const leaf = root(); leaf.kind = 'executable'; leaf.status = 'EXECUTING'
    const opts = forcePassOptions(leaf, { seatCount: { review: 1, accept: 1 } })
    const by = new Map(opts.map(o => [o.phase, o]))
    expect(by.get('accept')?.disabled).toBeUndefined()
    expect(by.get('review')?.disabled).toBeUndefined()
    // 没配席位的测试验证整个不存在 —— 摆一个按下去什么都不变的选项比没有更糟。
    expect(by.get('verify')?.disabled).toContain('没有配置')
    // 叶子节点不走集成验收。
    expect(by.get('integrate')?.disabled).toContain('没有子任务')

    const parent = root(); parent.kind = 'decompose'; parent.childIds = ['root/01-a']
    const pby = new Map(forcePassOptions(parent, { seatCount: { integrate: 1 } }).map(o => [o.phase, o]))
    expect(pby.get('integrate')?.disabled).toBeUndefined()
    expect(pby.get('accept')?.disabled).toContain('拆分型')
  })
})

describe('读回:手写的 forcePass 比手写的 skipPhase 更危险', () => {
  const load = (n: Partial<TaskNode>) =>
    validateLoadedNodes([{ ...root(), ...n }], { goal: 'g', phaseRoles: emptyPhaseRoles(), now: NOW })

  it('不在四个之列的值被清掉', () => {
    const { nodes, repairs } = load({ forcePass: 'execute' as PhaseName, execStatus: '交过了' })
    expect(nodes[0].forcePass).toBeUndefined()
    expect(repairs.join('\n')).toContain('不在可强制通过之列')
  })

  it('没有可被放行的产出时被清掉 —— 否则是零调用 ACCEPTED **加**一条假的通过记录', () => {
    const { nodes, repairs } = load({
      status: 'READY', kind: 'executable', forcePass: 'accept', execStatus: '',
    })
    expect(nodes[0].forcePass).toBeUndefined()
    expect(repairs.join('\n')).toContain('假的通过记录')
  })

  it('有产出时原样留着 —— 用户真按过的那一次不许在恢复时被静默撤销', () => {
    const { nodes, repairs } = load({
      status: 'READY', kind: 'executable', forcePass: 'accept', execStatus: '改了 foo.ts',
    })
    expect(nodes[0].forcePass).toBe('accept')
    expect(repairs.filter(r => r.includes('强制通过'))).toEqual([])
  })

  it('盘上两个都写着:强制通过赢,而跳过那个标记**也被消费掉**,不留残留', async () => {
    /**
     * 这条组合只可能来自手工编辑。`resumeCore` 刻意不判它(见那里的注释:别造第二份
     * 判据),所以兜底必须在消费点 —— 而质疑讨论那一支是四个里唯一需要自己补
     * consumeSkip 的:另外三个的 consumeSkip 本来就在分支外面无条件跑。
     */
    const n = root()
    n.forcePass = 'review'
    n.skipPhase = 'review'
    const { calls, runAgent } = counting(req => (req.phase === 'plan' ? PLAN : PASS(req)))
    await stepStart(n, ctxFor([n], runAgent))

    expect(calls.filter(p => p === 'review')).toHaveLength(0)
    expect(manualOf(n.reviewLog)).toBeDefined()  // 强制通过赢:记录留下了
    expect(n.forcePass).toBeUndefined()
    expect(n.skipPhase).toBeUndefined()          // 残留会让下一轮静默不开会
  })
})
