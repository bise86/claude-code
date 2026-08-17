/**
 * 新增任务的**顺序**。
 *
 * 每一条都钉在一个具体的坏结局上,而不是「函数返回了 ok」:
 *  - 落盘顺序反了 → anchor 的 childIds 指向一个盘上不存在的节点 → 下次 --resume 判
 *    「子节点缺失」→ `block()` 把三个复活开关全清零,重做和 --retry-blocked 都救不回来;
 *  - 落盘失败却先改了活对象 → 编排器按一棵盘上没有的树在跑;
 *  - 半途失败不收拾 → `resumeCore` 会把孤儿**主动挂回父节点**并开始跑它,而屏幕说没发生;
 *  - hold / reserve 漏放 → 这几个节点再也不会被调度 / 以后一次真放得下的拆分被拒。
 */
import { describe, expect, it } from 'bun:test'

import { addTaskScope } from './addTask.js'
import { runAddTask } from './addTaskRun.js'
import { advanceableKind } from './stateMachine.js'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-08-17T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

/** root(ACCEPTED)→ 甲(ACCEPTED 执行叶子)。在甲身上新增 = 甲和 root 都要重开。 */
function tree(): { nodes: TaskNode[]; byId: () => Map<string, TaskNode> } {
  const root = mk('root', { title: '根任务', status: 'ACCEPTED', kind: 'decompose', childIds: ['root/01-a'] })
  const a = mk('root/01-a', {
    title: '甲', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable',
    execStatus: '改了 src/a.ts',
  })
  const nodes = [root, a]
  return { nodes, byId: () => new Map(nodes.map(n => [n.id, n])) }
}

function scopeFor(target: TaskNode, byId: () => Map<string, TaskNode>) {
  const s = addTaskScope(target, byId(), { caps: DEFAULT_CAPS, nodeCount: byId().size })
  if (s.ok !== true) throw new Error(`夹具本身就不该被拒: ${s.reason}`)
  return s
}

interface Harness {
  writes: string[]
  removed: string[]
  problems: string[][]
  nodesOut: TaskNode[][]
  added: { id: string; affected: readonly string[] }[]
  started: number
  done: number
  holdReleased: number
  reserveReleased: number
}

function deps(
  byId: () => Map<string, TaskNode>,
  over: Partial<Parameters<typeof runAddTask>[2]> = {},
): { deps: Parameters<typeof runAddTask>[2]; h: Harness } {
  const h: Harness = {
    writes: [], removed: [], problems: [], nodesOut: [], added: [],
    started: 0, done: 0, holdReleased: 0, reserveReleased: 0,
  }
  const base: Parameters<typeof runAddTask>[2] = {
    byId,
    now: () => NOW,
    hold: () => ({ ok: true, release: () => { h.holdReleased++ } }),
    reserve: () => ({ release: () => { h.reserveReleased++ } }),
    persist: async n => { h.writes.push(n.id) },
    removeNode: async id => { h.removed.push(id) },
    taskAdded: (n, affected) => { h.added.push({ id: n.id, affected }); return { ok: true } },
    onNodes: ns => { h.nodesOut.push(ns) },
    onProblems: p => { h.problems.push(p) },
    onDone: () => { h.done++ },
    ...over,
  }
  return { deps: base, h }
}

describe('落盘顺序', () => {
  it('新节点先写、anchor 后写、祖先最后 —— 反过来会造出「子节点缺失」', async () => {
    const t = tree()
    const target = t.byId().get('root/01-a')!
    const { deps: d, h } = deps(t.byId)
    const out = await runAddTask(scopeFor(target, t.byId), { title: '新活', prompt: '干这个' }, d, () => undefined)
    expect(out.ok).toBe(true)
    expect(h.writes.length).toBe(3)
    // 第一个必须是新节点(它的 id 在 anchor 下面)
    expect(h.writes[0].startsWith('root/01-a/')).toBe(true)
    expect(h.writes[1]).toBe('root/01-a')
    expect(h.writes[2]).toBe('root')
  })

  it('三次写全部走同一个 persist 接缝(生产上那条带 journal)', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId)
    await runAddTask(scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    expect(h.writes.length).toBe(3)
  })
})

describe('anchor 的状态', () => {
  /**
   * 这一条是三席评审各自打回的那一条:`reopenAncestor` 的状态从 `childIds`/`kind` 现算,
   * 而新子节点要等落盘之后才挂上去 —— 拿它当 drop-in 会算出 `READY`,而
   * `READY + executable` 会被 `advanceableKind` 判成 `execute`:
   * **带写工具的执行者把一份已验收、已合进主干的产出再跑一遍。**
   */
  it('已验收的执行叶子重开之后是 WAITING_CHILDREN + decompose,绝不是 READY', async () => {
    const t = tree()
    const target = t.byId().get('root/01-a')!
    const { deps: d } = deps(t.byId)
    await runAddTask(scopeFor(target, t.byId), { title: '新活', prompt: 'p' }, d, () => undefined)
    expect(target.status).toBe('WAITING_CHILDREN')
    expect(target.kind).toBe('decompose')
    expect(advanceableKind(target, t.byId())).not.toBe('execute')
  })

  it('祖先也被放回可推进状态(否则 root 是 ACCEPTED,编排器第一句就 return completed)', async () => {
    const t = tree()
    const root = t.byId().get('root')!
    const { deps: d } = deps(t.byId)
    await runAddTask(scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    expect(root.status).toBe('WAITING_CHILDREN')
    // 预算要给回去,否则一重开就再次触顶
    expect(root.iteration.integration).toBe(0)
  })

  it('新节点的 goal 是用户那段话,一个字不拼', async () => {
    const t = tree()
    const { deps: d } = deps(t.byId)
    const prompt = '把 login 的超时从 3s 改成 10s\n并补一条超时的测试'
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: '改超时', prompt }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(out.node.goal).toBe(prompt)
    expect(out.node.manualAdd?.anchorId).toBe('root/01-a')
  })
})

describe('失败路径', () => {
  it('hold 失败:盘上一个字节都没动,活对象一个字段都没变', async () => {
    const t = tree()
    const target = t.byId().get('root/01-a')!
    const before = { status: target.status, kids: target.childIds.length }
    const { deps: d, h } = deps(t.byId, { hold: () => ({ ok: false, reason: '正在运行' }) })
    const out = await runAddTask(scopeFor(target, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    expect(out.ok).toBe(false)
    expect(h.writes).toEqual([])
    expect(target.status).toBe(before.status)
    expect(target.childIds.length).toBe(before.kids)
    expect(h.problems.flat().join('')).toContain('正在运行')
    expect(h.done).toBe(1)
  })

  it('名额满了:同样什么都没发生,而且 hold 被放回去了', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId, { reserve: () => null })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(false)
    expect(h.writes).toEqual([])
    expect(h.holdReleased).toBe(1)
  })

  it('复核不通过(树在关口开着时变了):盘上零字节', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId)
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d,
      () => '树在你确认之前变了',
    )
    expect(out.ok).toBe(false)
    expect(h.writes).toEqual([])
    expect(h.problems.flat().join('')).toContain('变了')
  })

  /**
   * **活对象一个字段都不许变** —— 而这一条必须显式断言 `childIds.length`:
   * `{...anchor}` 与活对象**共享 childIds 数组**,在草稿上 push 就是直接改活对象,
   * 而那种写法下这条用例是唯一能红的地方。
   */
  it('anchor 落盘失败:活对象没被改,而且孤儿被清掉了', async () => {
    const t = tree()
    const target = t.byId().get('root/01-a')!
    const { deps: d, h } = deps(t.byId, {
      persist: async n => {
        h.writes.push(n.id)
        if (n.id === 'root/01-a') throw new Error('磁盘满了')
      },
    })
    const out = await runAddTask(scopeFor(target, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    expect(out.ok).toBe(false)
    expect(target.childIds.length).toBe(0)
    expect(target.status).toBe('ACCEPTED')
    expect(h.removed.length).toBe(1)
    expect(h.problems.flat().join('')).toContain('没有发生')
  })

  it('孤儿删不掉:必须说出「下次 --resume 会自己把它挂回去并开始跑」', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId, {
      persist: async n => { h.writes.push(n.id); if (n.id === 'root/01-a') throw new Error('满了') },
      removeNode: async () => { throw new Error('也删不掉') },
    })
    await runAddTask(scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    const said = h.problems.flat().join('')
    expect(said).toContain('--resume')
    expect(said).toContain('手工删掉')
  })

  it('新节点自己就写不下去:如实说「这次新增没有发生」,不去删任何东西', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId, { persist: async () => { throw new Error('满了') } })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(false)
    expect(h.removed).toEqual([])
    expect(h.problems.flat().join('')).toContain('没有发生')
  })

  it('祖先写失败不中断,但要说清后果(下次 resume 那个祖先还是 ACCEPTED)', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId, {
      persist: async n => { h.writes.push(n.id); if (n.id === 'root') throw new Error('满了') },
    })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    expect(h.problems.flat().join('')).toContain('不会被调度')
  })

  it('四条出口上 hold 和 reserve 都被放回去', async () => {
    for (const over of [
      {},
      { hold: () => ({ ok: false as const, reason: 'x' }) },
      { persist: async () => { throw new Error('满了') } },
      { taskAdded: () => ({ ok: false as const, reason: '编排已结束' }) },
    ]) {
      const t = tree()
      const { deps: d, h } = deps(t.byId, over)
      await runAddTask(scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
      // hold 失败那一条没拿到 reserve,其余三条都要各放一次
      expect(h.holdReleased + (over.hold ? 1 : 0)).toBe(1)
      expect(h.reserveReleased).toBe(over.hold ? 0 : 1)
    }
  })
})

describe('生效', () => {
  it('taskAdded 拿到的是**整份** affected(新节点 + anchor + 整条祖先链)', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId)
    await runAddTask(scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined)
    expect(h.added.length).toBe(1)
    expect([...h.added[0].affected].sort()).toEqual([h.added[0].id, 'root', 'root/01-a'].sort())
  })

  /**
   * `taskAdded` 内部那次 `safeUpdate` 是 `try{…}catch{}` 的 —— 渲染器抛一次,新节点就在
   * 盘上、在编排器里、真的在跑,而树上没有它。所以上屏必须是**显式**的一步。
   */
  it('显式上屏,而且新节点在里面', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId)
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(h.nodesOut.length).toBe(1)
    expect(h.nodesOut[0].some(n => n.id === out.node.id)).toBe(true)
  })

  it('并不进正在跑的那一轮时,要说出「等本轮结束后 --resume 会带着它继续」', async () => {
    const t = tree()
    const { deps: d, h } = deps(t.byId, { taskAdded: () => ({ ok: false, reason: '本次编排刚刚结束' }) })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    // 盘上已经落了,所以这不是失败 —— 但必须说出来。
    expect(out.ok).toBe(true)
    expect(h.problems.flat().join('')).toContain('--resume')
  })

  it('结束屏那条路:没有 taskAdded,改走 start(新树里带着新节点)', async () => {
    const t = tree()
    let startedWith: TaskNode[] | null = null
    const { deps: d } = deps(t.byId, {
      hold: undefined, reserve: undefined, taskAdded: undefined,
      start: ns => { startedWith = ns },
    })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(startedWith).not.toBeNull()
    expect(startedWith!.some(n => n.id === out.node.id)).toBe(true)
  })

  it('历史输出流按新 id 扔掉一次(重做删过子树时新 id 可能和被删的逐字相同)', async () => {
    const t = tree()
    const dropped: string[] = []
    const { deps: d } = deps(t.byId, { onDropStreams: ids => { dropped.push(...ids) } })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(dropped).toEqual([out.node.id])
  })
})

/**
 * 并发下的 `childIds`。
 *
 * `hold` **挡不住 `growTree`** —— 那个集合根本不在 `ctx()` 里,而 `createChildren` 是
 * `node.childIds.push(...)` 就地改活对象。拿落盘之前那份快照整份写回去,会让别人刚挂上的
 * 子节点从 anchor 的 childIds 里**整份消失**(内存和盘上都是),而它自己还在树里、还会被
 * 派出去跑 —— anchor 的 `childrenAllAccepted` 于是不等它就能提前集成通过。验收席实跑出来的。
 */
describe('落盘期间别人也在往同一个 anchor 上挂子节点', () => {
  /**
   * **两个窗口各测一次,而且要同时看「盘上那份」和「内存那份」。**
   *
   * 上一版只在第一个窗口注入、而且只断言活对象 —— 于是两条修复**互相掩护**:
   * 去掉「落盘前重取」时,写回那一步仍然从活对象合并,活对象照样对;
   * 去掉「写回时合并」时,草稿已经被重取过,写下去的也照样对。
   * 变异测试两条都判存活,而它们各自都是真的洞(第二轮抓出来的)。
   */
  const grownDuring = (
    when: (id: string) => boolean,
  ): { anchor: TaskNode; deps: Parameters<typeof runAddTask>[2]; written: Map<string, string[]> } => {
    const t = tree()
    const anchor = t.byId().get('root/01-a')!
    const written = new Map<string, string[]>()
    const { deps: d } = deps(t.byId, {
      persist: async n => {
        // 盘上那份长什么样 —— 活对象对不代表写下去的对。
        written.set(n.id, [...n.childIds])
        if (when(n.id) && !anchor.childIds.includes('root/01-a/09-grown')) {
          anchor.childIds.push('root/01-a/09-grown')
        }
      },
    })
    return { anchor, deps: d, written }
  }

  it('写新节点期间挂上来的:**盘上那份**也要有它', async () => {
    const t = tree()
    const anchor = t.byId().get('root/01-a')!
    const g = grownDuring(id => id.startsWith('root/01-a/'))
    const out = await runAddTask(
      scopeFor(g.anchor, () => new Map([[t.byId().get('root')!.id, t.byId().get('root')!], [g.anchor.id, g.anchor]])),
      { title: 'x', prompt: 'p' }, g.deps, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(g.anchor.childIds).toContain('root/01-a/09-grown')
    // **盘上那份**:草稿必须在落盘之前重取,否则写下去的 childIds 里没有它。
    expect(g.written.get('root/01-a')).toContain('root/01-a/09-grown')
    expect(g.written.get('root/01-a')).toContain(out.node.id)
    void anchor
  })

  it('写 anchor **之后**才挂上来的:活对象不许被草稿盖回去', async () => {
    const g = grownDuring(id => id === 'root/01-a')
    const out = await runAddTask(
      scopeFor(g.anchor, () => new Map([[g.anchor.id, g.anchor]])),
      { title: 'x', prompt: 'p' }, g.deps, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    // 这一格只有「写回时合并」守得住 —— 草稿是在这次 push 之前算的。
    expect(g.anchor.childIds).toContain('root/01-a/09-grown')
    expect(g.anchor.childIds).toContain(out.node.id)
  })

  it('同一个 id 不会被加两次', async () => {
    const t = tree()
    const anchor = t.byId().get('root/01-a')!
    const { deps: d } = deps(t.byId)
    const out = await runAddTask(
      scopeFor(anchor, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    if (out.ok !== true) return
    expect(anchor.childIds.filter(x => x === out.node.id).length).toBe(1)
  })
})

/**
 * 结束屏那条路的**收尾顺序**。
 *
 * 验收席实跑出的读数:`start` 排在 `onDone` 之前时,`startRun` 已经把界面切成运行视图,
 * 紧接着 `onDone` 的关屏逻辑又把它盖回结束屏 —— **整轮编排在一屏「已结束」下面跑完**:
 * 三个干预键不存在、没有中止入口、Esc/q 直接退出而 run 还在飞。
 */
describe('收尾顺序', () => {
  it('onDone 在 start 之前 —— 否则关屏会把 startRun 刚切的那一屏盖回去', async () => {
    const t = tree()
    const order: string[] = []
    const { deps: d } = deps(t.byId, {
      hold: undefined, reserve: undefined, taskAdded: undefined,
      onDone: () => { order.push('onDone') },
      start: () => { order.push('start') },
    })
    const out = await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(out.ok).toBe(true)
    expect(order).toEqual(['onDone', 'start'])
  })

  it('失败路径上只关屏、绝不起跑', async () => {
    const t = tree()
    const order: string[] = []
    const { deps: d } = deps(t.byId, {
      hold: () => ({ ok: false, reason: '正在运行' }),
      onDone: () => { order.push('onDone') },
      start: () => { order.push('start') },
    })
    await runAddTask(
      scopeFor(t.byId().get('root/01-a')!, t.byId), { title: 'x', prompt: 'p' }, d, () => undefined,
    )
    expect(order).toEqual(['onDone'])
  })
})
