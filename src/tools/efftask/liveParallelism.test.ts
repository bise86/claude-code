/**
 * 运行中调并发度。
 *
 * 用户的原话:「在运行的整体任务可以随意调整并发度,在跑的任务不受影响,会影响将要跑的
 * 任务是否启动」。三句话是三条独立的断言,这个文件逐条钉:
 *
 *  1. **调得动** —— 编排器每一轮现读上限,不是启动时缓存一次;
 *  2. **调高立刻生效** —— 不能等到某个在飞的节点跑完(而用户去调它的时刻,恰恰是所有
 *     节点都卡在一个二十分钟的执行环节里);
 *  3. **在跑的不受影响** —— 调低不打断、不取消、不丢任何一次已经起跑的调用。
 *
 * 前两条只有**量时间**才看得见:最终状态在 parallelism 1 和 8 下逐字相同。
 */
import { describe, expect, it } from 'bun:test'
import { createRunControl } from './control.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import { createSlotPool } from './slotPool.js'
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, MAX_PARALLELISM, clampParallelism, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const tick = (ms = 5): Promise<void> => new Promise(r => setTimeout(r, ms))

const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '目标', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})

const reply = (req: { prompt: string }, body: string): string => {
  const tag = req.prompt.match(/语言标记\(fence info string\)写成 ([a-zA-Z]+)/)?.[1] ?? ''
  return '```' + tag + '\n' + body + '\n```'
}
const THREE_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]},{"title":"丙","deps":[]}]}'
const FIVE_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]},{"title":"丙","deps":[]},' +
  '{"title":"丁","deps":[]},{"title":"戊","deps":[]}]}'
const LEAF = '{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}'

describe('RunControl 的并发度旋钮', () => {
  it('没调过时是 undefined —— 那是「按关口批准的那个数走」,不是 0', () => {
    // undefined 和一个具体数字必须分得开:编排器写的是 `control.parallelism() ?? cfg.parallelism`,
    // 这里回一个 0 或者 DEFAULT_PARALLELISM 都会悄悄顶掉用户在关口上批准的值。
    const c = createRunControl()
    expect(c.parallelism()).toBeUndefined()
    expect(c.parallelismGeneration()).toBe(0)
  })

  it('夹进 [1, MAX_PARALLELISM],而且 0 会被夹成 1', () => {
    // 0 的语义是「一个都不许跑」,而调度器对 <=0 的预算返回空批次 —— 树会当场被判成
    // 「走不动」并以 blocked 收尾。想暂停请按 p,那条路是可逆的。
    const c = createRunControl()
    c.setParallelism(0)
    expect(c.parallelism()).toBe(1)
    c.setParallelism(-7)
    expect(c.parallelism()).toBe(1)
    c.setParallelism(MAX_PARALLELISM + 100)
    expect(c.parallelism()).toBe(MAX_PARALLELISM)
    c.setParallelism(Number.NaN)
    // NaN 回落到**当前值**,不是默认值:在 64 上按一下坏键不该把它掉回 5。
    expect(c.parallelism()).toBe(MAX_PARALLELISM)
  })

  it('夹取和 parseDirectives 用同一份 —— 关口拒绝的数字不许从运行中调进来', () => {
    // 两处各写一个 64 的字面量时,它们迟早不一致,而不一致的那一次用户会发现自己在关口上
    // 被拒绝的数字在运行中调得进去。
    expect(clampParallelism(999)).toBe(MAX_PARALLELISM)
    expect(clampParallelism(0)).toBe(1)
    expect(clampParallelism('x')).toBe(DEFAULT_PARALLELISM)
    expect(clampParallelism(undefined, 9)).toBe(9)
  })

  it('代数只在**真的变了**时前进 —— 到顶了还按 + 不该白唤醒调度循环一次', () => {
    const c = createRunControl()
    c.setParallelism(3)
    expect(c.parallelismGeneration()).toBe(1)
    c.setParallelism(3)
    expect(c.parallelismGeneration()).toBe(1)
    c.setParallelism(MAX_PARALLELISM)
    c.setParallelism(MAX_PARALLELISM + 5) // 夹完还是同一个数
    expect(c.parallelismGeneration()).toBe(2)
  })

  it('落后的代数**立刻**兑现 —— 否则「扫描之后、睡下之前」那一下调整会被睡过去', async () => {
    const c = createRunControl()
    const seen = c.parallelismGeneration()
    c.setParallelism(9) // 变化发生在等待**之前**
    let done = false
    void c.waitForParallelism(seen).then(() => { done = true })
    await tick(1)
    expect(done).toBe(true)
  })

  it('代数没落后时挂着等,直到下一次调整', async () => {
    const c = createRunControl()
    let done = false
    void c.waitForParallelism(c.parallelismGeneration()).then(() => { done = true })
    await tick(3)
    expect(done).toBe(false)
    c.setParallelism(2)
    await tick(3)
    expect(done).toBe(true)
  })

  it('等待者一次性放行并清空 —— 一次长跑里不许随调整次数无界增长', async () => {
    const c = createRunControl()
    const seen = c.parallelismGeneration()
    let woke = 0
    for (let i = 0; i < 3; i++) void c.waitForParallelism(seen + i).then(() => { woke++ })
    await tick(2)
    // 三个等待者:seen(当前,挂着)、seen+1、seen+2(都不等于当前代数 → 立刻兑现)。
    expect(woke).toBe(2)
    c.setParallelism(4)
    await tick(2)
    expect(woke).toBe(3)
    // 再调一次不该把上一批已经兑现的等待者再唤醒一遍(表只涨不落就是泄漏)。
    c.setParallelism(5)
    await tick(2)
    expect(woke).toBe(3)
  })

  /**
   * `setParallelism` 里放行等待者那一圈套着 try/catch,和 `resume()` 里那一圈逐字同因。
   * **两处都不可达**:等待者永远是 promise 的 resolve,它不抛。如实记在这里,而不是写一条
   * 假装测过它的用例 —— 从公开接口塞一个会抛的等待者进去做不到。
   */
})

describe('池子的上限是**现读**的', () => {
  it('limit 是个函数,调完立刻按新数放行/拒绝', () => {
    // createSlotPool 一直收的是 `() => number`,但编排器原来给的闭包读的是
    // `this.cfg.parallelism` —— 一个永远不变的数。这条钉住「现读」这件事本身。
    let limit = 1
    const pool = createSlotPool(() => limit)
    const a = pool.take()
    expect(pool.tryTake()).toBeNull()
    limit = 3
    const b = pool.tryTake()
    expect(b).not.toBeNull()
    expect(pool.inUse()).toBe(2)
    // 调低不收回已经发出去的槽位 —— 「在跑的任务不受影响」在池子这一层就成立。
    limit = 1
    expect(pool.inUse()).toBe(2)
    expect(pool.tryTake()).toBeNull()
    a.release(); b!.release()
  })
})

describe('编排器每一轮现读上限', () => {
  it('调高之后,还没起跑的节点**立刻**起跑 —— 不等在飞的那个跑完', async () => {
    /**
     * 这是这个功能的全部意义。没有唤醒信号时,调度循环停在
     * `await Promise.race([...inFlight.values()])` 上,新额度要等到某个节点结束才被看见 ——
     * 而那可能是二十分钟后。
     *
     * 判据必须是「**第一个叶子的分析还在飞的时候**,第二个叶子的分析就开始了」。
     * 第一版量的是「分析环节的峰值同时数 > 1」,而那**摘掉唤醒信号照样绿**(变异验证过):
     * 第一个叶子的 stepStart 一结束,新上限就在下一轮扫描里被读到,乙和丙于是同时起跑 ——
     * 峰值一样是 2,只不过晚了整整一个环节。峰值分不出「立刻」和「下一轮」。
     */
    const control = createRunControl()
    let leafPlans = 0
    let firstLeafPlanInFlight = false
    let overlappedWithFirstLeaf = false
    const runAgent = (async (req: { phase: string; prompt: string; node: { id: string } }) => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return reply(req, THREE_LEAVES)
        leafPlans++
        if (leafPlans === 1) {
          control.setParallelism(3)
          firstLeafPlanInFlight = true
          // 够长,好让被唤醒的循环有时间把另外两个叶子派出去。
          await tick(40)
          firstLeafPlanInFlight = false
          return reply(req, LEAF)
        }
        if (firstLeafPlanInFlight) overlappedWithFirstLeaf = true
        await tick(2)
        return reply(req, LEAF)
      }
      await tick(2)
      if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
      return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
    }) as unknown as RunAgentFn

    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1 }),
      { runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {}, control },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    expect(leafPlans).toBe(3)
    expect(overlappedWithFirstLeaf).toBe(true)
  })

  it('圆桌的席位也跟着新上限走 —— 池子是同一个,不能只有调度器听话', async () => {
    // 席位换成**验收**圆桌:质疑修复现在是顺序接力(见 concurrency.test 那条),
    // 它的峰值恒为 1,拿它量池子等于量了个常数。
    /**
     * 「受同一全局池约束,避免总并发爆炸」那一条的另一半。评审席位不走调度器,它们走
     * `mapWithinPool` → `pool.tryTake()`,而池子的上限是一个闭包 —— 那个闭包读的是
     * `cfg.parallelism` 的话,调高之后**只有调度器**变宽,评审团仍然一个一个来。
     *
     * 反过来更要紧:调低之后席位仍按旧上限并发,用户为了压成本按下的那个键对
     * 「一个 5 席评审团」完全无效 —— 而那正是把并发乘起来的地方。
     *
     * 量法:上限 1 起跑(此时三席评审只能串行),分析环节里把它调到 5,然后数评审调用的
     * 峰值同时数。池子现读的话是 3,读旧值的话恒为 1。
     */
    const control = createRunControl()
    let curJudge = 0
    let peakJudge = 0
    const runAgent = (async (req: { phase: string; prompt: string }) => {
      if (req.phase === 'plan') {
        control.setParallelism(5)
        return reply(req, LEAF)
      }
      if (req.phase === 'accept') {
        curJudge++
        peakJudge = Math.max(peakJudge, curJudge)
        try { await tick(20) } finally { curJudge-- }
        return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
      }
      if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
      return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
    }) as unknown as RunAgentFn

    const roles = emptyPhaseRoles()
    roles.accept = [{ roleName: '甲' }, { roleName: '乙' }, { roleName: '丙' }]
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 1, phaseRoles: roles }),
      { runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {}, control },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    expect(peakJudge).toBeGreaterThan(1)
  })

  it('表头那个上限跟着走 —— 屏幕上的数字不许和调度器用的那个不是一个', async () => {
    const control = createRunControl()
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 5 }),
      { runAgent: (async () => '') as unknown as RunAgentFn, persist: async () => {}, now: () => '', onUpdate: () => {}, control },
      new AbortController().signal,
    )
    expect(orch.slotUsage().limit).toBe(5)
    control.setParallelism(2)
    expect(orch.slotUsage().limit).toBe(2)
    control.setParallelism(MAX_PARALLELISM)
    expect(orch.slotUsage().limit).toBe(MAX_PARALLELISM)
  })

  it('调低不打断在飞的调用,一次都不丢;之后新派的节点才受新上限约束', async () => {
    /**
     * 「在跑的任务不受影响,会影响将要跑的任务是否启动」——**一句话两半,分别断言**:
     *
     *  - 收紧那一刻已经在飞的三个节点全部跑完(没有被 abort、没有被丢弃);
     *  - 收紧**之后**才被派出去的节点,同时最多 1 个。
     *
     * 数的是**节点**而不是调用:一个已经拿到槽位的节点会在这个槽位里依次跑完
     * 分析 → 质疑修复 → 执行 → 验收,那些调用当然会和别的节点的调用重叠 —— 那正是
     * 「在跑的不受影响」的表现,不是超额。第一版按调用数,量到 2 就红了,而 2 是对的。
     *
     * 五个叶子而不是三个:只有三个的话,收紧之后**没有任何**节点还需要派发,那条断言
     * 就是恒真的。
     */
    const control = createRunControl()
    let lowered = false
    const plansDone: string[] = []
    let leafPlans = 0
    /** 每个节点第一次露面的时刻在收紧之后吗 —— 那才叫「收紧之后才起跑的节点」。 */
    const firstSeen = new Map<string, boolean>()
    const liveNew = new Set<string>()
    let peakNewNodes = 0
    const runAgent = (async (req: { phase: string; prompt: string; node: { id: string } }) => {
      const id = req.node.id
      if (!firstSeen.has(id)) firstSeen.set(id, lowered)
      const isNew = firstSeen.get(id) === true
      if (isNew) { liveNew.add(id); peakNewNodes = Math.max(peakNewNodes, liveNew.size) }
      try {
        if (req.phase === 'plan') {
          const root = leafPlans === 0 && id === 'root'
          if (!root) leafPlans++
          // 三个叶子的分析同时在飞时收紧 —— 正是要保护的那一刻。
          if (leafPlans === 3 && !lowered) { control.setParallelism(1); lowered = true }
          await tick(20)
          plansDone.push(id)
          return reply(req, root ? FIVE_LEAVES : LEAF)
        }
        await tick(2)
        if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
        return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
      } finally {
        if (isNew) liveNew.delete(id)
      }
    }) as unknown as RunAgentFn

    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 3 }),
      { runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {}, control },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    // 六次分析(根 + 五个叶子)全部完成 —— 收紧没有吃掉任何一次在飞的调用。
    expect(plansDone).toHaveLength(6)
    // 收紧之后才起跑的那两个叶子,一次一个。
    expect(lowered).toBe(true)
    expect([...firstSeen.values()].filter(Boolean).length).toBeGreaterThan(0)
    expect(peakNewNodes).toBe(1)
  })

  it('调低到 1 之后 run 仍然跑完 —— 不许把「用户调小了」误判成「树走不动了」', async () => {
    // `pickBatch` 对 limit <= 0 返回空批次,而 `inFlight.size === 0` 那一支会把空批次读成
    // 「存在无法推进的阻断节点」并以 blocked 收尾。下限 1 就是为了让这条路不可达。
    const control = createRunControl()
    control.setParallelism(1)
    let planned = false
    const runAgent = (async (req: { phase: string; prompt: string }) => {
      if (req.phase === 'plan') {
        const first = !planned
        planned = true
        return reply(req, first ? THREE_LEAVES : LEAF)
      }
      if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
      return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
    }) as unknown as RunAgentFn
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 8 }),
      { runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {}, control },
      new AbortController().signal,
    )
    const out = await orch.run()
    expect(out.status).toBe('completed')
  })

  it('没有 control 时行为不变 —— 这个旋钮是加上去的,不是必须的', async () => {
    let planned = false
    const runAgent = (async (req: { phase: string; prompt: string }) => {
      if (req.phase === 'plan') {
        const first = !planned
        planned = true
        return reply(req, first ? THREE_LEAVES : LEAF)
      }
      if (req.phase === 'execute') return reply(req, '{"execStatus":"done"}')
      return reply(req, '{"pass":true,"blocking":[],"comments":"ok"}')
    }) as unknown as RunAgentFn
    const orch = new EffTaskOrchestrator(
      cfg({ parallelism: 2 }),
      { runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {} },
      new AbortController().signal,
    )
    expect((await orch.run()).status).toBe('completed')
    expect(orch.slotUsage().limit).toBe(2)
  })
})

describe('等待者不许随调度循环无界增长', () => {
  it('N 轮循环等的是**同一个** promise —— 表长恒为 1', async () => {
    /**
     * 评审量出来的:调度循环每转一圈注册一个等待者,而只有 setParallelism 会清表 ——
     * 用户不碰并发度就永远不清。实跑一棵 11 节点的树跑完积压 22 个 resolver
     * (随后一次 setParallelism 一起兑现 22/22,证明全程被持有)。
     *
     * 探针:同一代数下反复要 promise,拿到的必须是同一个对象。这条断言直接说出「共享」
     * 这件事,而数「积压了几个」要伸手进私有状态。
     */
    const c = createRunControl()
    const seen = c.parallelismGeneration()
    const first = c.waitForParallelism(seen)
    for (let i = 0; i < 50; i++) {
      expect(c.waitForParallelism(seen)).toBe(first)
    }
    // 变更之后是**新的**那一个(旧的已经兑现,再等它会立刻返回 → 循环空转)。
    c.setParallelism(3)
    await first
    const after = c.waitForParallelism(c.parallelismGeneration())
    expect(after).not.toBe(first)
  })

  it('一次变更把之前所有在等的人一起放行', async () => {
    const c = createRunControl()
    const seen = c.parallelismGeneration()
    let woke = 0
    for (let i = 0; i < 5; i++) void c.waitForParallelism(seen).then(() => { woke++ })
    await tick(2)
    expect(woke).toBe(0)
    c.setParallelism(4)
    await tick(2)
    expect(woke).toBe(5)
    // 再变一次不许把已经兑现的那批再唤醒一遍(那是「表只涨不落」的另一面)。
    c.setParallelism(5)
    await tick(2)
    expect(woke).toBe(5)
  })
})
