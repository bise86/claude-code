import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from './agentEvents.js'
import {
  createStreamStore,
  MAX_EVENTS_PER_STREAM,
  MAX_STREAMS_PER_NODE,
  MAX_TOTAL_EVENTS,
  MAX_PENDING_CALLS,
  TOMBSTONE_KEEP,
  PRE_TREE_NODE,
  type StreamMeta,
} from './agentStream.js'
import { makeRootNode } from './rootPlan.js'
import { DEFAULT_CAPS, emptyPhaseRoles } from './types.js'

const meta = (over: Partial<StreamMeta> = {}): StreamMeta => ({
  nodeId: 'root/01-a',
  phaseLabel: '执行',
  label: '甲员工',
  ...over,
})

const text = (t: string): AgentEvent => ({ kind: 'text', text: t })
const tool = (n: string): AgentEvent => ({ kind: 'tool', useId: n, name: n, brief: n })
const toolAs = (useId: string, brief: string): AgentEvent => ({ kind: 'tool', useId, name: 'T', brief })
const resultAs = (useId: string, brief = 'ok'): AgentEvent => ({ kind: 'result', useId, brief, isError: false })
/** 事件数组里第 i 条 result。断言耗时时用 —— 事件是 push 的时候被换掉的,不是原对象。 */
const results = (s: { events: AgentEvent[] }) => s.events.filter(e => e.kind === 'result') as Extract<AgentEvent, { kind: 'result' }>[]

/** 可注入的假时钟 —— 这个仓库的测试不许摸真实时钟。 */
function clock(start = 1000): { now: () => number; tick: (ms: number) => void } {
  let t = start
  return { now: () => t, tick: ms => { t += ms } }
}

/**
 * 单次工具调用的耗时与归属 —— 用户的原话:「各种工具调用,耗时多少…都要有」。
 *
 * 配对**必须在 push 里**做,不能在渲染期做:渲染期是从 events 数组里找对手,而环形
 * 缓冲和墓碑都会把 tool 事件淘汰掉、只留下 result。
 */
describe('工具调用的耗时与归属', () => {
  it('按 useId 配对,算出这次调用的墙钟耗时,并记下它属于谁', () => {
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    h.push(toolAs('T1', 'Bash(bun test)'))
    c.tick(1800)
    h.push(resultAs('T1', '2043 pass'))
    const [r] = results(s.streams('root/01-a')[0]!)
    expect(`${r!.durMs} / ${r!.ofBrief}`).toBe('1800 / Bash(bun test)')
  })

  it('工具事件被环形缓冲挤掉之后,耗时仍然算得出来', () => {
    // 这一条就是「配对放在渲染期」会死的地方 —— 那时 events 里已经没有 tool 事件了。
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    h.push(toolAs('T1', 'Read(a.ts)'))
    for (let i = 0; i < MAX_EVENTS_PER_STREAM + 5; i++) h.push(text(`第${i}行`))
    c.tick(2500)
    h.push(resultAs('T1', '读到了'))
    const st = s.streams('root/01-a')[0]!
    expect(`还有 tool 事件吗: ${st.events.some(e => e.kind === 'tool')}`).toBe('还有 tool 事件吗: false')
    expect(results(st)[0]!.durMs).toBe(2500)
  })

  it('provider 没给 id 时按先进先出配对,两次调用不许配到同一个上面', () => {
    // asId 在畸形输入上返回空串,而 openai 兼容后端正是最容易缺 id 的那一档。
    // 全塞进 Map 的话它们共用 '' 这一个键,后一次直接盖掉前一次。
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    h.push(toolAs('', '甲'))
    c.tick(100)
    h.push(toolAs('', '乙'))
    c.tick(900)
    h.push(resultAs('', 'r1'))
    c.tick(100)
    h.push(resultAs('', 'r2'))
    const rs = results(s.streams('root/01-a')[0]!)
    expect(rs.map(r => `${r.ofBrief}:${r.durMs}`)).toEqual(['甲:1000', '乙:1000'])
  })

  it('配不上就不填耗时 —— 不猜', () => {
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    c.tick(5000)
    h.push(resultAs('没人调过它'))
    const [r] = results(s.streams('root/01-a')[0]!)
    expect(`durMs=${r!.durMs} ofBrief=${r!.ofBrief} atMs=${r!.atMs}`).toBe('durMs=undefined ofBrief=undefined atMs=6000')
  })

  it('归属摘要有长度上限', () => {
    const s = createStreamStore({ now: clock().now })
    const h = s.open(meta())
    h.push(toolAs('T1', '甲'.repeat(400)))
    h.push(resultAs('T1'))
    const [r] = results(s.streams('root/01-a')[0]!)
    expect(Array.from(r!.ofBrief!).length).toBeLessThanOrEqual(61) // 60 + 省略号
  })

  it('一直不返回的调用不会把配对表撑成无界项', () => {
    const s = createStreamStore({ now: clock().now })
    const h = s.open(meta())
    for (let i = 0; i < MAX_PENDING_CALLS + 50; i++) h.push(toolAs(`T${i}`, `调用${i}`))
    // 超出上限的那些不再登记,所以它们的 result 配不上 —— 这是**明确的**取舍:
    // 上限之内的照常算,上限之外的宁可没有耗时,也不要一张无界的表。
    h.push(resultAs(`T${MAX_PENDING_CALLS + 10}`))
    const [r] = results(s.streams('root/01-a')[0]!)
    expect(r!.durMs).toBeUndefined()
  })
})

describe('一次调用一条流', () => {
  it('按开启顺序保存,不同节点互不相干', () => {
    const s = createStreamStore()
    const a = s.open(meta({ phaseLabel: '分析' }))
    const b = s.open(meta({ nodeId: 'root/02-b' }))
    const c = s.open(meta({ phaseLabel: '执行' }))
    a.push(text('甲说的'))
    b.push(text('别人的'))
    c.push(text('丙说的'))
    expect(s.streams('root/01-a').map(x => x.meta.phaseLabel)).toEqual(['分析', '执行'])
    expect(s.streams('root/02-b')).toHaveLength(1)
    expect(s.nodes().sort()).toEqual(['root/01-a', 'root/02-b'])
  })

  it('圆桌的每个席位各自成流,署名分得开 —— 这是取代 chunkBuffer 的全部理由', () => {
    // chunkBuffer 把 N 个评审员并进一个桶,三段话逐句交错且没有署名,读不出哪句是谁说的。
    const s = createStreamStore()
    const jia = s.open(meta({ phaseLabel: '质疑讨论', label: '甲员工', round: 1 }))
    const yi = s.open(meta({ phaseLabel: '质疑讨论', label: '乙员工', round: 1 }))
    jia.push(text('我反对'))
    yi.push(text('我赞成'))
    jia.push(text('理由是'))
    const rows = s.streams('root/01-a')
    expect(rows.map(r => r.meta.label)).toEqual(['甲员工', '乙员工'])
    expect(rows[0]!.events.map(e => (e.kind === 'text' ? e.text : ''))).toEqual(['我反对', '理由是'])
    expect(rows[1]!.events.map(e => (e.kind === 'text' ? e.text : ''))).toEqual(['我赞成'])
  })

  it('同一个节点、同一环节、同一轮开两次也是两条流 —— infra 重试就是这样', () => {
    // 设计稿第一版用 nodeId#phase#round#seat 做 key,而 roundtableWithInfraRetry 的三次
    // attempt 共用同一个 round:第二次会往一条已经收口的流里继续写。句柄从结构上排除这件事。
    const s = createStreamStore()
    const first = s.open(meta({ phaseLabel: '质疑讨论', round: 1 }))
    first.push(text('第一桌'))
    first.end('角色调用失败')
    const second = s.open(meta({ phaseLabel: '质疑讨论', round: 1 }))
    second.push(text('第二桌'))
    expect(s.streams('root/01-a')).toHaveLength(2)
    expect(s.streams('root/01-a')[0]!.closed).toBe(true)
    expect(s.streams('root/01-a')[1]!.closed).toBe(false)
  })

  it('没有流的节点读作空数组,不是 undefined', () => {
    const s = createStreamStore()
    expect(s.streams('nope')).toEqual([])
    expect(s.droppedEvents('nope')).toBe(0)
  })

  it('统计工具调用次数', () => {
    const s = createStreamStore()
    const h = s.open(meta())
    h.push(tool('Read'))
    h.push(text('说点什么'))
    h.push(tool('Bash'))
    expect(s.streams('root/01-a')[0]!.toolCount).toBe(2)
  })

  it('events 每次都换引用 —— 否则 memo 过的窗口永远停在第一帧', () => {
    // chunkBuffer 每次 push 都造新数组。原地 push 的话数组引用永不变,任何
    // React.memo / useMemo([streams]) 都看不见变化。
    const s = createStreamStore()
    const h = s.open(meta())
    h.push(text('一'))
    const before = s.streams('root/01-a')[0]!.events
    h.push(text('二'))
    const after = s.streams('root/01-a')[0]!.events
    expect(before).not.toBe(after)
    expect(before).toHaveLength(1)
  })
})

describe('收口', () => {
  it('记录耗时,用注入的时钟', () => {
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    c.tick(4200)
    h.end()
    const st = s.streams('root/01-a')[0]!
    expect(st.startedAt).toBe(1000)
    expect(st.endedAt).toBe(5200)
  })

  it('收口之后到达的事件被丢弃并计数,不会让「已完成」的窗口继续长', () => {
    // runAgentAdapter 的超时是 Promise.race,poll 赢了之后并不停下 consume():生成器要等
    // 下一次 yield 才看得到 abort,provider 缓冲里的消息会在 end() 之后继续到达。
    const s = createStreamStore()
    const h = s.open(meta())
    h.push(text('正常的一行'))
    h.end()
    h.push(text('超时之后才吐出来的'))
    const st = s.streams('root/01-a')[0]!
    expect(st.events).toHaveLength(1)
    expect(st.dropped).toBe(1)
    expect(s.droppedEvents('root/01-a')).toBe(1)
  })

  it('一条事件都没产出过的席位也要看得见 —— 失败恰恰是最需要看见的', () => {
    // provider 401、或者已中断早退,席位一条事件都没有。若 end() 是 no-op,3 席面板只画
    // 出 2 个窗口,第三席连它失败了都看不见。
    const s = createStreamStore()
    const h = s.open(meta({ label: '丙员工' }))
    h.end('角色调用失败: 401')
    const st = s.streams('root/01-a')[0]!
    expect(st.closed).toBe(true)
    expect(st.error).toBe('角色调用失败: 401')
    expect(st.events).toEqual([])
  })

  it('end 幂等', () => {
    const c = clock()
    const s = createStreamStore({ now: c.now })
    const h = s.open(meta())
    h.end()
    c.tick(9999)
    h.end('后来的错')
    const st = s.streams('root/01-a')[0]!
    expect(st.endedAt).toBe(1000)
    expect(st.error).toBeUndefined()
  })
})

describe('有界 —— 一场没人看的长跑不能把内存吃光', () => {
  it('单流是环形缓冲,并记录丢了多少', () => {
    const s = createStreamStore()
    const h = s.open(meta())
    for (let i = 1; i <= MAX_EVENTS_PER_STREAM + 7; i++) h.push(text(`行 ${i}`))
    const st = s.streams('root/01-a')[0]!
    expect(st.events).toHaveLength(MAX_EVENTS_PER_STREAM)
    expect(st.dropped).toBe(7)
    expect((st.events[0] as { text: string }).text).toBe('行 8')
    expect(s.droppedEvents('root/01-a')).toBe(7)
  })

  it('单节点流数超限 → 最旧的已收口流压成墓碑,不是删除', () => {
    // 淘汰规则「最旧的先走」正好淘汰第 1 轮评审 —— 而那恰好是评审收敛那一半让用户回去
    // 对照的东西。墓碑保住表头和结论。
    const s = createStreamStore()
    for (let i = 0; i < MAX_STREAMS_PER_NODE + 3; i++) {
      const h = s.open(meta({ phaseLabel: `第${i}场` }))
      for (let k = 0; k < 10; k++) h.push(text(`${i}-${k}`))
      h.end()
    }
    const rows = s.streams('root/01-a')
    // 一条都没少 —— 表头还在
    expect(rows).toHaveLength(MAX_STREAMS_PER_NODE + 3)
    expect(rows[0]!.meta.phaseLabel).toBe('第0场')
    expect(rows[0]!.tombstone).toBe(true)
    expect(rows[0]!.events).toHaveLength(TOMBSTONE_KEEP)
    // 留的必须是**最后**几条,不是最前几条:折叠态显示的是「最新: …」,而一条流最后
    // 说的话通常就是它的结论。留开头等于把结论换成开场白。
    expect(rows[0]!.events.map(e => (e.kind === 'text' ? e.text : ''))).toEqual(['0-7', '0-8', '0-9'])
    expect(rows[rows.length - 1]!.tombstone).toBeUndefined()
    expect(s.droppedEvents('root/01-a')).toBeGreaterThan(0)
  })

  it('还活着的流永远不会被压掉 —— 它正在被人看', () => {
    const s = createStreamStore()
    const live: { push: (e: AgentEvent) => void }[] = []
    for (let i = 0; i < MAX_STREAMS_PER_NODE + 5; i++) {
      const h = s.open(meta({ phaseLabel: `第${i}场` }))
      for (let k = 0; k < 10; k++) h.push(text(`${i}-${k}`))
      live.push(h) // 一个都不收口
    }
    expect(s.streams('root/01-a').every(r => r.tombstone === undefined)).toBe(true)
  })

  it('全局上限盖住总量,与节点数无关', () => {
    // caps.maxNodes 的真实上限是 5000,而 cap-nodes 卡片会主动引导用户调高它。只靠
    // 每流/每节点两层上限,总量随节点数线性涨,GB 级是算得出来的。
    const s = createStreamStore()
    for (let n = 0; n < 400; n++) {
      const h = s.open(meta({ nodeId: `node-${n}` }))
      for (let k = 0; k < MAX_EVENTS_PER_STREAM; k++) h.push(text(`${n}-${k}`))
      h.end()
    }
    expect(s.totalEvents()).toBeLessThanOrEqual(MAX_TOTAL_EVENTS)
    // 而且不是靠删光:最早那些节点还留着表头
    expect(s.streams('node-0')).toHaveLength(1)
    expect(s.streams('node-0')[0]!.tombstone).toBe(true)
    expect(s.droppedEvents('node-0')).toBeGreaterThan(0)
  })

  it('全局上限在 push 时就生效,不能只等到收口才算账', () => {
    // 只在 end() 里做全局淘汰是不够的:一个**还在跑**的执行席位可以一直 push,而它永远
    // 不会收口。先用已收口的流把额度填满,再让一条活流继续写 —— 只有 push 时的那道
    // 检查能把总量按回去。
    const s = createStreamStore()
    const perStream = MAX_EVENTS_PER_STREAM
    const closedCount = Math.ceil(MAX_TOTAL_EVENTS / perStream)
    for (let n = 0; n < closedCount; n++) {
      const h = s.open(meta({ nodeId: `filler-${n}` }))
      for (let k = 0; k < perStream; k++) h.push(text(`${n}-${k}`))
      h.end() // 收口时刚好不超,所以这里不会触发淘汰
    }
    const beforeLive = s.totalEvents()
    const live = s.open(meta({ nodeId: 'still-running' }))
    live.push(text('活流的第一行'))
    live.push(text('活流的第二行'))
    expect(`收口后未超限: ${beforeLive <= MAX_TOTAL_EVENTS}`).toBe('收口后未超限: true')
    expect(s.totalEvents()).toBeLessThanOrEqual(MAX_TOTAL_EVENTS)
    expect(s.streams('still-running')[0]!.events).toHaveLength(2)
  })

  it('全局淘汰不碰活流', () => {
    const s = createStreamStore()
    const alive = s.open(meta({ nodeId: 'watched' }))
    for (let k = 0; k < MAX_EVENTS_PER_STREAM; k++) alive.push(text(`看着的 ${k}`))
    for (let n = 0; n < 400; n++) {
      const h = s.open(meta({ nodeId: `node-${n}` }))
      for (let k = 0; k < MAX_EVENTS_PER_STREAM; k++) h.push(text(`${n}-${k}`))
      h.end()
    }
    const st = s.streams('watched')[0]!
    expect(st.tombstone).toBeUndefined()
    expect(st.events).toHaveLength(MAX_EVENTS_PER_STREAM)
  })

  it('三层上限的关系要说得出口,不是随手填的数', () => {
    // 单流 × 单节点 = 单节点理论峰值;它必须**大于**全局上限,否则全局那一层就是摆设
    // (一个节点自己都撑不满,那层永远不会触发)。同时全局上限要能装下若干个满节点。
    expect(MAX_EVENTS_PER_STREAM * MAX_STREAMS_PER_NODE).toBeLessThan(MAX_TOTAL_EVENTS)
    expect(MAX_TOTAL_EVENTS / (MAX_EVENTS_PER_STREAM * MAX_STREAMS_PER_NODE)).toBeGreaterThanOrEqual(2)
    // 一屏多一点,不是一整份 transcript
    expect(MAX_EVENTS_PER_STREAM).toBeGreaterThan(50)
    expect(MAX_EVENTS_PER_STREAM).toBeLessThanOrEqual(500)
  })
})

describe('订阅', () => {
  it('push / end / open 都会通知', () => {
    const s = createStreamStore()
    let n = 0
    const off = s.subscribe(() => { n++ })
    const h = s.open(meta())
    h.push(text('x'))
    h.end()
    expect(n).toBe(3)
    off()
    s.open(meta()).push(text('y'))
    expect(n).toBe(3)
  })

  it('一个崩掉的订阅者不能带走这条流', () => {
    const s = createStreamStore()
    let ok = 0
    s.subscribe(() => { throw new Error('渲染崩了') })
    s.subscribe(() => { ok++ })
    const h = s.open(meta())
    expect(() => h.push(text('x'))).not.toThrow()
    expect(ok).toBeGreaterThan(0)
  })
})

describe('resume:没有流 ≠ 什么都没干', () => {
  it('标记过的历史节点认得出来', () => {
    // store 每次挂载都是新的,--resume 拿到的是磁盘上的节点树 + 空 store。不区分的话,
    // 一个上次跑了 40 分钟的已完成节点会渲染成「这个节点什么都没干」。
    const s = createStreamStore()
    s.markHistorical(['root/01-a', 'root/02-b'])
    expect(s.isHistorical('root/01-a')).toBe(true)
    expect(s.isHistorical('root/03-c')).toBe(false)
  })

  it('历史节点后来被 reseat 重开、产生新流时,两件事都成立', () => {
    const s = createStreamStore()
    s.markHistorical(['root/01-a'])
    s.open(meta()).push(text('这一轮新跑的'))
    expect(s.isHistorical('root/01-a')).toBe(true)
    expect(s.streams('root/01-a')).toHaveLength(1)
  })
})

describe('思考不许把工具调用挤出缓冲', () => {
  const think = (t: string): AgentEvent => ({ kind: 'thinking', text: t })

  it('缓冲满了先丢思考,工具与返回值留下', () => {
    // 一视同仁的先进先出会让这个功能的核心失效:thinking 每块最多产 60 条,而单流只有
    // 100 条。实测「1 工具 + 1 返回 + 120 条思考」之后缓冲里一条工具事件都不剩,而表头
    // 还写着「1 工具」—— 用户要看的「在调用什么工具」被「在思考啥」挤没了。
    const s = createStreamStore()
    const h = s.open(meta())
    h.push(tool('Read'))
    h.push({ kind: 'result', useId: 'Read', brief: '读到了', isError: false })
    for (let i = 0; i < MAX_EVENTS_PER_STREAM + 20; i++) h.push(think(`想法 ${i}`))
    const st = s.streams('root/01-a')[0]!
    const kinds = st.events.map(e => e.kind)
    expect(`还有工具事件: ${kinds.includes('tool')}`).toBe('还有工具事件: true')
    expect(`还有返回值: ${kinds.includes('result')}`).toBe('还有返回值: true')
    expect(st.events).toHaveLength(MAX_EVENTS_PER_STREAM)
    expect(st.dropped).toBeGreaterThan(0)
  })

  it('思考丢光了还超,才从头丢别的', () => {
    const s = createStreamStore()
    const h = s.open(meta())
    for (let i = 0; i < MAX_EVENTS_PER_STREAM + 5; i++) h.push(tool(`T${i}`))
    const st = s.streams('root/01-a')[0]!
    expect(st.events).toHaveLength(MAX_EVENTS_PER_STREAM)
    // 丢的是最老的那几个
    expect((st.events[0] as { name: string }).name).toBe('T5')
  })
})

describe('验收实测出来的两条', () => {
  it('抛出去的调用要标成失败,不是绿色的「已完成」', () => {
    // 实测:provider 抛 ECONNRESET / 529 之后表头是 `● 已完成`,而中断那条路径反而是对的
    // —— 同一块屏上两种失败长得不一样。而这块屏正是用户打开去查「这一席为什么失败」的。
    const s = createStreamStore()
    const h = s.open(meta())
    h.end('provider exploded')
    expect(s.streams('root/01-a')[0]!.error).toBe('provider exploded')
  })

  it('每节点淘汰不是二次方的 —— 50 条流要留 40 条完整的', () => {
    // 用 list.length(含墓碑)算超量,等于每 open 一条就按全额超量重新收一次费:
    // 实测 41 条 → 压 1,42 → 3,45 → 15,50 → **49**。上限承诺的是「留 40 条完整」,
    // 而实际到 50 条时第 1 轮到第 49 轮全成了墓碑。
    const s = createStreamStore()
    for (let i = 0; i < MAX_STREAMS_PER_NODE + 10; i++) {
      const h = s.open(meta({ phaseLabel: `第${i}场` }))
      for (let k = 0; k < 5; k++) h.push(text(`${i}-${k}`))
      h.end()
    }
    const rows = s.streams('root/01-a')
    const intact = rows.filter(r => r.tombstone !== true).length
    expect(`完整的流: ${intact}`).toBe(`完整的流: ${MAX_STREAMS_PER_NODE}`)
    expect(rows.filter(r => r.tombstone === true)).toHaveLength(10)
  })
})

describe('树外那两条流要能在树出来之后打开', () => {
  it('PRE_TREE_NODE 就是根节点 id —— 伪节点在树里永远打不开', () => {
    // TaskTreePanel 只渲染 props.nodes,一个 '__pre__' 伪节点不在其中:需求解析和根方案
    // 的窗口寿命只到第三关为止,而「整个运行里最长的单次调用之一」的记录恰恰是事后
    // 最想回看的。根节点 id 由 rootPlan.makeRootNode 写死。
    expect(PRE_TREE_NODE).toBe(makeRootNode(
      { goalPrompt: 'g', parallelism: 1, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS } as never,
      '2026-07-27T00:00:00Z',
    ).id)
  })
})

/**
 * 节点被重做删掉之后,它的流也要没。
 *
 * 不清的话有两个后果,后一个才是用户报的那个:
 *  1. 全局上限被一批已经不存在的事件长期占着;
 *  2. `childId` 是「父id + 序号 + 标题 slug」算出来的 —— 重拆一次同一个父节点,新子节点
 *     的 id 和被删的那个逐字相同,于是**上一轮的输出挂到了新节点头上**。
 */
describe('重做删掉节点时一并扔掉它的历史记录', () => {
  it('流没了,总量减回去,dropped/historical 的记账也一起清', () => {
    const s = createStreamStore()
    const h = s.open({ nodeId: 'root/00-a', phaseLabel: '执行', label: '主模型' })
    h.push({ kind: 'text', text: '第一轮的产出' })
    h.push({ kind: 'text', text: '还有一行' })
    h.end()
    s.markHistorical(['root/00-a'])
    const keep = s.open({ nodeId: 'root/00-b', phaseLabel: '执行', label: '主模型' })
    keep.push({ kind: 'text', text: '别人的' })
    const before = s.totalEvents()

    expect(s.dropNodes(['root/00-a'])).toBe(1)
    expect(s.streams('root/00-a')).toEqual([])
    expect(s.nodes()).toEqual(['root/00-b'])
    expect(s.isHistorical('root/00-a')).toBe(false)
    expect(s.droppedEvents('root/00-a')).toBe(0)
    // 总量要真的减回去:虚高的 total 会让全局上限去压**还在被看**的流的墓碑。
    expect(s.totalEvents()).toBe(before - 2)
    // 别人的流一根汗毛都不能少
    expect(s.streams('root/00-b')).toHaveLength(1)
  })

  it('删过之后同 id 的新节点从零开始 —— 这就是用户报的那一条', () => {
    const s = createStreamStore()
    s.open({ nodeId: 'root/00-a', phaseLabel: '执行', label: '主模型' }).push({ kind: 'text', text: '上一轮' })
    s.dropNodes(['root/00-a'])
    // 重做之后重新拆出来的同名子节点
    s.open({ nodeId: 'root/00-a', phaseLabel: '分析', label: '主模型' })
    expect(s.streams('root/00-a')).toHaveLength(1)
    expect(s.streams('root/00-a')[0]!.meta.phaseLabel).toBe('分析')
  })

  /**
   * **迟到的消息不许把记账重新建出来。**
   *
   * 评审实测(P2):drop 完之后一条迟到消息就让 `droppedEvents` 回到 1 —— 而重做之后
   * 新建的**同 id** 节点会顶着那句「有 1 条输出没能留下来」,那 1 条属于上一次运行。
   * `total` 同理:幽灵事件顶高的 total 会让全局上限去压真正在被看的流。
   *
   * 这不是理论:runAgentAdapter 的超时是 Promise.race,poll 赢了之后并不停下 consume(),
   * provider 缓冲里的消息会在 end() 之后继续到达 —— 那个文件自己的注释就是这么写的。
   */
  it('删掉之后迟到的消息一律丢弃,不记账、不占总量', () => {
    const s = createStreamStore()
    const h = s.open({ nodeId: 'gone', phaseLabel: '执行', label: '主模型' })
    // 先灌满单流上限,让 droppedEvents 真的有值 —— 否则这条断言无论删不删都过
    for (let i = 0; i < MAX_EVENTS_PER_STREAM + 5; i++) h.push({ kind: 'text', text: 'x' + i })
    expect(s.droppedEvents('gone')).toBeGreaterThan(0)
    s.dropNodes(['gone'])
    expect(s.droppedEvents('gone')).toBe(0)
    const before = s.totalEvents()
    for (let i = 0; i < 5; i++) h.push({ kind: 'text', text: '迟到的' })
    h.end('晚到的收口')
    expect(s.droppedEvents('gone')).toBe(0)
    expect(s.totalEvents()).toBe(before)
    expect(s.nodes()).toEqual([])
  })

  it('被删掉的流不进已收口队列 —— 否则全局淘汰会去压一条没人能打开的流', () => {
    const s = createStreamStore()
    const doomed = s.open({ nodeId: 'gone', phaseLabel: '执行', label: '主模型' })
    doomed.push({ kind: 'text', text: 'x' })
    doomed.end()
    const alive = s.open({ nodeId: 'keep', phaseLabel: '执行', label: '主模型' })
    alive.push({ kind: 'text', text: 'y' })
    alive.end()
    s.dropNodes(['gone'])
    /**
     * 灌满**全局**上限,逼 enforceGlobal 去已收口队列里找受害者。
     *
     * 必须用很多条流:单条流有自己的环形缓冲(MAX_EVENTS_PER_STREAM),满了之后
     * 丢一条补一条,`total` 根本不涨 —— 拿一条流灌两万次是灌不到全局上限的。
     * 每个节点最多 40 条完整的流,所以还要分几个节点。
     */
    const perStream = MAX_EVENTS_PER_STREAM
    const need = Math.ceil((MAX_TOTAL_EVENTS + perStream) / perStream)
    for (let i = 0; i < need; i++) {
      const f = s.open({ nodeId: `filler-${Math.floor(i / 30)}`, phaseLabel: '执行', label: '主模型' })
      for (let j = 0; j < perStream; j++) f.push({ kind: 'text', text: 'z' })
      f.end()
    }
    // 队列里如果还留着被删的那条,它会先被压成墓碑,而真正该让位的是 keep 那条
    expect(s.streams('keep')[0]!.tombstone).toBe(true)
    /**
     * 记账不许飘负。被删的流已经在 dropNodes 里减过一次账,如果它还能被 enforceGlobal
     * 压第二次,total 会一路减到负数 —— 那时候全局上限**永远**不触发,而这个上限是
     * 「一场没人看的长跑不能把内存吃光」的唯一防线。
     */
    expect(s.totalEvents()).toBeGreaterThanOrEqual(0)
    // 注:「被删的流有没有从已收口队列里摘掉」本身没有观测点(队列不外露)。
    // 它防的是队列里堆积死条目,而 orphan 标记 + 清空事件已经让一次误压变成无害的空操作。
  })

  it('通知订阅者 —— 界面要重画;没删到东西时不空叫', () => {
    const s = createStreamStore()
    s.open({ nodeId: 'x', phaseLabel: '执行', label: '主模型' })
    let ticks = 0
    s.subscribe(() => { ticks++ })
    s.dropNodes(['不存在的节点'])
    expect(ticks).toBe(0)
    s.dropNodes(['x'])
    expect(ticks).toBe(1)
  })
})
