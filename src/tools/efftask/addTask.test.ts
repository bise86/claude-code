/**
 * 「用一段提示词新增任务」的准入判据。
 *
 * 这一份的全部意义是**别让一个任务在树上凭空多出来却跑不了 / 跑了却把别人的活跳过去**。
 * 所以每一条用例都钉在一个具体的坏结局上,而不是「函数返回了 ok」。
 */
import { describe, expect, it } from 'bun:test'

import {
  addTaskLines, addTaskScope, addedTaskBlockedBy, allocateChildId, capacityRefusal,
  deriveTitle, nextChildIndex, scopeDiff, slugDegraded, FALLBACK_TASK_TITLE,
} from './addTask.js'
import { advanceableKind } from './stateMachine.js'
import { clearReopenMarks } from './redo.js'
import { validateLoadedNodes } from './resumeCore.js'
import { parseNodeFile, serializeNode } from './persistence.js'
import { detailSections } from '../../commands/efftask/NodeDetail.js'
import { createNode, DEFAULT_CAPS, emptyPhaseRoles, NODE_STATUSES, type NodeStatus, type TaskNode } from './types.js'

const NOW = '2026-08-17T00:00:00.000Z'

const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id, parentId: null, deps: [], depth: 0,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const mapOf = (ns: TaskNode[]): Map<string, TaskNode> => new Map(ns.map(n => [n.id, n]))

const scopeOf = (
  target: TaskNode, ns: TaskNode[], over: Partial<Parameters<typeof addTaskScope>[2]> = {},
) => addTaskScope(target, mapOf(ns), {
  caps: DEFAULT_CAPS, nodeCount: ns.length, ...over,
})

describe('挂在谁下面', () => {
  it('已经在等子任务的拆分节点:就地挂,状态一个字都不动', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = scopeOf(root, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root')
    expect(s.anchorSeat).toBeUndefined()
    expect(s.anchorNote).toBeUndefined()
  })

  it('已验收的执行叶子:挂上去并重开成 WAITING_CHILDREN(它自己的活已经合入了)', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable' })
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root/01-a')
    expect(s.anchorSeat).toBe('WAITING_CHILDREN')
    // 原状态要留一份给关口 —— clearReopenMarks 会把阻断理由抹掉。
    expect(s.anchorWas?.status).toBe('ACCEPTED')
  })

  /**
   * 这一条是这个功能最贵的一条判据。`growTree` 的安全集(带 `(reproduced)` 注释)是
   * 「正在执行的那个节点自己,或已经在等子任务的节点」——往 CREATED/READY 节点上挂子节点
   * 会**把它自己的方案/执行阶段整个删掉**。
   */
  it('还没出方案的叶子:不挂在它身上,上卷到父节点', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'CREATED' })
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root')
    // 为什么不是你正看着的那个 —— 必须说出口。
    expect(s.anchorNote).toContain('还没出方案')
  })

  it('方案写好还没执行的叶子(READY):同样上卷 —— 挂上去会顶掉它自己的执行', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'READY', kind: 'executable' })
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root')
    expect(s.anchorNote).toContain('还没执行')
  })

  /**
   * 把一个执行失败的叶子放成 WAITING_CHILDREN,它就绕过了自己失败的那个执行环节 ——
   * 之后靠集成验收就能判 ACCEPTED。这正是这个项目声明的最坏结局。
   */
  it('失败的执行叶子:不挂在它身上(否则它的失败会被跳过),上卷到父', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'executable',
      blockedReason: '编译不过', failedAt: 'EXECUTING',
    })
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root')
    expect(s.anchorNote).toContain('失败的执行任务')
    // 而且要告诉用户:新任务跑完也不会把它变绿。
    expect(s.targetStillBlocked?.title).toBe('root/01-a')
  })

  it('失败的拆分节点可以挂 —— 它自己的活就是判决,重开之后集成验收会重跑', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'decompose',
      childIds: ['root/01-a/01-x'], blockedReason: '集成验收迭代超限(3)',
    })
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    const s = scopeOf(a, [root, a, x])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root/01-a')
    expect(s.anchorSeat).toBe('WAITING_CHILDREN')
    expect(s.anchorWas?.blockedReason).toBe('集成验收迭代超限(3)')
  })

  it('结构性阻断一律拒 —— 重开它只会让一批没法核实的工作跑起来', () => {
    const root = mk('root', {
      status: 'BLOCKED', kind: 'decompose', childIds: ['root/01-a'], blockedReason: '子节点缺失',
    })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = scopeOf(root, [root, a])
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason + s.details.join('')).toContain('结构性')
  })

  it('在飞的节点不能当挂载点', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = scopeOf(root, [root, a], { inFlight: new Set(['root']) })
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason + s.details.join('')).toContain('正在运行')
  })

  it('被 x 取消过的节点拒绝 —— 放开它等于替用户改主意', () => {
    const root = mk('root', {
      status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'], cancelled: true,
    })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = scopeOf(root, [root, a])
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason + s.details.join('')).toContain('取消')
  })

  it('control 里那份取消标记也算(它和节点上那个是两处)', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = scopeOf(root, [root, a], { wasCancelled: id => id === 'root' })
    expect(s.ok).toBe(false)
  })

  it('祖先链上有取消过的节点也拒', () => {
    const root = mk('root', {
      status: 'ACCEPTED', kind: 'decompose', childIds: ['root/01-a'], cancelled: true,
    })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a/01-x'],
    })
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    const s = scopeOf(a, [root, a, x])
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason).toContain('取消')
  })

  it('深度上限:不许比启动关口批准的规模再深一层', () => {
    const caps = { ...DEFAULT_CAPS, maxDepth: 2 }
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 2, status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a/01-x'],
    })
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 3, status: 'ACCEPTED' })
    const s = addTaskScope(a, mapOf([root, a, x]), { caps, nodeCount: 3 })
    // a 满了 → 上卷到 root(depth 0),那一层还放得下
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root')
    expect(s.anchorNote).toContain('深度上限')
  })

  it('root 是不可挂的叶子时:没有上级可退,如实拒', () => {
    const root = mk('root', { status: 'READY', kind: 'executable' })
    const s = scopeOf(root, [root])
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason).toContain('没有上级')
  })

  it('容量满了:排在所有节点级判据之前(两句话用户的下一步不一样)', () => {
    const caps = { ...DEFAULT_CAPS, maxNodes: 2 }
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    const s = addTaskScope(root, mapOf([root, a]), { caps, nodeCount: 2 })
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason).toContain('上限')
  })

  it('编排器预留掉的名额也算进容量(growTree 可能正在用最后几个)', () => {
    const caps = { ...DEFAULT_CAPS, maxNodes: 3 }
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    expect(addTaskScope(root, mapOf([root, a]), { caps, nodeCount: 2 }).ok).toBe(true)
    expect(addTaskScope(root, mapOf([root, a]), { caps, nodeCount: 2, reserved: 1 }).ok).toBe(false)
  })

  /**
   * 状态一共 15 个,而白名单只放行三种形态。逐个跑一遍 —— `NODE_STATUSES` 就是为这种事
   * 存在的(它自己的注释:漏掉一个新状态不会有任何东西报错)。
   */
  it('15 个状态逐个过:只有三种形态能当挂载点', () => {
    const allowed: NodeStatus[] = ['WAITING_CHILDREN', 'ACCEPTED', 'BLOCKED']
    const got: NodeStatus[] = []
    for (const st of NODE_STATUSES) {
      const root = mk('root', {
        status: st, kind: 'decompose', childIds: ['root/01-a'],
        // BLOCKED 用一条**非结构性**的理由,否则这一档会因为另一条判据被拒。
        blockedReason: st === 'BLOCKED' ? '验收迭代超限(3)' : '',
      })
      const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
      const s = addTaskScope(root, mapOf([root, a]), { caps: DEFAULT_CAPS, nodeCount: 2 })
      if (s.ok === true) got.push(st)
    }
    expect(got.sort()).toEqual([...allowed].sort())
  })

  it('WAITING_CHILDREN 但一个子节点都没有:不是「已经在等」,要走重开那一档', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: [] })
    const s = scopeOf(root, [root])
    // 它不在白名单里(childIds 为空),而 root 没有父 → 拒。
    expect(s.ok).toBe(false)
  })
})

describe('祖先链', () => {
  it('ACCEPTED 和非结构性 BLOCKED 的祖先都要进重开名单', () => {
    const root = mk('root', { status: 'ACCEPTED', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'decompose',
      childIds: ['root/01-a/01-x'], blockedReason: '子节点阻断',
    })
    const x = mk('root/01-a/01-x', {
      parentId: 'root/01-a', depth: 2, status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-a/01-x/01-y'],
    })
    const y = mk('root/01-a/01-x/01-y', { parentId: 'root/01-a/01-x', depth: 3, status: 'ACCEPTED' })
    const s = scopeOf(x, [root, a, x, y])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.reopen.map(r => r.id)).toEqual(['root/01-a', 'root'])
    // 扣的是**整条链**,不是只有要重开的那几个。
    expect(s.chain).toEqual(['root/01-a/01-x', 'root/01-a', 'root'])
  })

  /**
   * 这一条钉的是 hold 的范围。一个 `WAITING_CHILDREN + 子任务全 ACCEPTED` 的祖先此刻就是
   * integrate 可派的,而它既不 ACCEPTED 也不 BLOCKED → 不进重开名单。不扣住它,落盘那次
   * await 期间它会拿**旧树**判通过,一路 ACCEPTED 到 root,run 直接收工。
   */
  it('此刻就能集成的祖先不进重开名单,但**必须在 chain 里**', () => {
    const root = mk('root', {
      status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'],
    })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-a/01-x'],
    })
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    // root 的孩子全 ACCEPTED 吗?a 不是。换个形状:让 a 成为「孩子全 ACCEPTED」的那个。
    const s = scopeOf(x, [root, a, x])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.reopen.map(r => r.id)).toEqual([])
    expect(s.chain).toEqual(['root/01-a/01-x', 'root/01-a', 'root'])
    // advanceableKind 证明 a 此刻真的是 integrate 可派的 —— 这条用例的前提不是编的。
    expect(advanceableKind(a, mapOf([root, a, x]))).toBe('integrate')
  })

  it('祖先链上有结构性阻断:整个拒(新节点挂上去会被当场扫成 BLOCKED)', () => {
    const root = mk('root', {
      status: 'BLOCKED', kind: 'decompose', childIds: ['root/01-a'], blockedReason: '依赖成环',
    })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose',
      childIds: ['root/01-a/01-x'],
    })
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    const s = scopeOf(a, [root, a, x])
    expect(s.ok).toBe(false)
    if (s.ok !== false) return
    expect(s.reason).toContain('结构性')
  })

  it('父子成环的树不会把链走成死循环', () => {
    const a = mk('a', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['b'], parentId: 'b' })
    const b = mk('b', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['a'], parentId: 'a' })
    const s = scopeOf(a, [a, b])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.chain).toEqual(['a', 'b'])
  })
})

describe('标题和 id', () => {
  it('取去掉控制字符之后的第一条非空行', () => {
    expect(deriveTitle('修一下登录\n还有注册')).toBe('修一下登录')
  })

  it('首行全是控制字符时不会给出空标题(树上会多一行没名字的任务)', () => {
    const bell = String.fromCharCode(7)
    expect(deriveTitle(`${bell}${bell}\n真正的标题`)).toBe('真正的标题')
  })

  it('整段都读不出东西:回落到固定名,不返回空串', () => {
    expect(deriveTitle('   \n\n  ')).toBe(FALLBACK_TASK_TITLE)
    expect(deriveTitle('')).toBe(FALLBACK_TASK_TITLE)
  })

  it('控制字符换成空格而不是删掉(两个词不许粘成一个)', () => {
    expect(deriveTitle(`甲${String.fromCharCode(7)}乙`)).toBe('甲 乙')
  })

  it('按码点截,不切碎 emoji', () => {
    const t = deriveTitle('🎉'.repeat(60))
    expect(Array.from(t).length).toBe(40)
    expect(t.includes('�')).toBe(false)
  })

  it('slug 退化成 node 时说得出来(两个不同任务在盘上会长得一样)', () => {
    expect(slugDegraded('!!!')).toBe(true)
    expect(slugDegraded('修一下登录')).toBe(false)
  })

  /**
   * `childIds.length + 1` 会在两条真实的路上撞:重做删过子树之后序号回退,以及
   * `growTree` 从别的节点的执行步里往同一个 anchor 挂子节点。撞了的后果是
   * `writeNode` **覆盖掉一个已验收的兄弟**。
   */
  it('序号取现有子 id 里的最大值 +1,不是 length', () => {
    const anchor = mk('root', { childIds: ['root/01-a', 'root/05-b'] })
    expect(nextChildIndex(anchor)).toBe(6)
  })

  it('算出来的 id 会躲开所有已存在的 id', () => {
    const anchor = mk('root', { childIds: ['root/01-x'] })
    const clash = mk('root/02-x', { parentId: 'root' })
    // 同一个标题、序号 2 已经被别人占着 → 必须换一个
    const id = allocateChildId(anchor, 'x', mapOf([anchor, clash]))
    expect(id).not.toBe('root/02-x')
    expect(id.startsWith('root/')).toBe(true)
  })
})

describe('关口文案', () => {
  const base = (): { root: TaskNode; a: TaskNode } => ({
    root: mk('root', { title: '根任务', status: 'ACCEPTED', kind: 'decompose', childIds: ['root/01-a'] }),
    a: mk('root/01-a', { title: '子任务甲', parentId: 'root', depth: 1, status: 'ACCEPTED', kind: 'executable' }),
  })

  it('把会被重开的上级、预算重置、以及原阻断理由都说出来', () => {
    const { root, a } = base()
    a.status = 'BLOCKED'
    a.kind = 'decompose'
    a.childIds = ['root/01-a/01-x']
    a.blockedReason = '集成验收迭代超限(3)'
    const x = mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    const s = scopeOf(a, [root, a, x])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    const lines = addTaskLines(s, { title: '新活', id: 'root/01-a/02-新活', prompt: '干这个' }).join('\n')
    expect(lines).toContain('重新打开')
    expect(lines).toContain('预算会被重置')
    expect(lines).toContain('集成验收迭代超限(3)')
    expect(lines).toContain('根任务')
  })

  it('被丢掉的字必须上屏', () => {
    const { root, a } = base()
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    const lines = addTaskLines(s, {
      title: 't', id: 'i', prompt: 'p', droppedChars: 12,
    }).join('\n')
    expect(lines).toContain('12')
    expect(lines).toContain('上限')
  })

  it('结束屏那条路要说清会重启编排、以及会清掉哪些一次性标记', () => {
    const { root, a } = base()
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    const lines = addTaskLines(s, {
      title: 't', id: 'i', prompt: 'p', willRestart: true, clearsCancels: 2, clearsForcePasses: 1,
    }).join('\n')
    expect(lines).toContain('重新起一轮编排')
    expect(lines).toContain('取消标记')
    expect(lines).toContain('预先批准')
  })

  it('目标仍然阻断时要明说「新任务不会让它变绿」', () => {
    const root = mk('root', { title: '根任务', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      title: '挂了的甲', parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'executable',
      blockedReason: '编译不过',
    })
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    const lines = addTaskLines(s, { title: 't', id: 'i', prompt: 'p' }).join('\n')
    expect(lines).toContain('仍然是阻断的')
    expect(lines).toContain('r / R / s')
  })

  it('slug 退化时关口要提一句(只印标题不够)', () => {
    const { root, a } = base()
    const s = scopeOf(a, [root, a])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(addTaskLines(s, { title: '!!!', id: 'root/01-a/01-node', prompt: 'p' }).join('\n'))
      .toContain('node')
  })
})

describe('容量与可调度性', () => {
  it('capacityRefusal 和 reserveNodes 是同一条算式', () => {
    const caps = { ...DEFAULT_CAPS, maxNodes: 5 }
    expect(capacityRefusal(4, 0, caps)).toBeUndefined()
    expect(capacityRefusal(4, 1, caps)).toBeDefined()
    expect(capacityRefusal(5, 0, caps)).toBeDefined()
  })

  /**
   * ⚠ **这一条以前钉的是错的方向。**
   *
   * 上一版拿一个「BLOCKED + 有子节点」的 root 去断言「不许说即可被调度」—— 而那种 root
   * **必然进 `reopen` 名单**,也就是这次操作自己马上就要把它放开。两位验收员各自复现:
   * 关口上半屏写着「会从 BLOCKED 重新打开成 WAITING_CHILDREN」,下半屏写着「还不会马上跑:
   * 上级仍是阻断的」,而确认之后后一句当场变成假话。判据要问的是
   * 「**这次操作放不开**的阻断」,不是「此刻有没有阻断」。
   */
  it('这次操作自己要放开的阻断,不算「跑不起来」', () => {
    const root = mk('root', { status: 'BLOCKED', kind: 'decompose', childIds: ['root/01-a'], blockedReason: '子节点阻断' })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose' })
    const m = mapOf([root, a])
    // 不告诉它这次会重开 root → 报「跑不起来」(那是旧行为)
    expect(addedTaskBlockedBy(a, m)).toBeDefined()
    // 告诉它 root 会被重开 → 就该说能跑
    expect(addedTaskBlockedBy(a, m, { willReopen: new Set(['root']) })).toBeUndefined()
  })

  it('anchor 自己是 BLOCKED、而这次正要重开它:同样不算「跑不起来」', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'decompose',
      childIds: ['root/01-a/01-x'], blockedReason: '集成验收迭代超限(3)',
    })
    const m = mapOf([root, a])
    expect(addedTaskBlockedBy(a, m)).toBeDefined()
    expect(addedTaskBlockedBy(a, m, { anchorReopened: true })).toBeUndefined()
  })

  it('放不开的那种阻断照样要报,并且点名是谁', () => {
    // 结构性阻断的祖先不会进 reopen 名单 —— 那才是真的「放不开」。
    const root = mk('root', { status: 'BLOCKED', kind: 'decompose', childIds: ['root/01-a'], blockedReason: '依赖成环' })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose' })
    const why = addedTaskBlockedBy(a, mapOf([root, a]), { willReopen: new Set() })
    expect(why).toContain('root')
  })

  it('链干净时就是能跑', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'WAITING_CHILDREN', kind: 'decompose' })
    expect(addedTaskBlockedBy(a, mapOf([root, a]))).toBeUndefined()
  })

  it('父子成环的树上不会死循环', () => {
    const a = mk('a', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['b'], parentId: 'b' })
    const b = mk('b', { status: 'BLOCKED', kind: 'decompose', childIds: ['a'], parentId: 'a', blockedReason: 'x' })
    expect(addedTaskBlockedBy(a, mapOf([a, b]))).toBeDefined()
  })
})

/**
 * 关口那一屏算出来的 scope,和按下确认那一刻的树,差在哪。
 *
 * 这一组是验收席那条 P0 的探针:漏比 `anchorSeat` 时,anchor 在关口期间跑完
 * (`WAITING_CHILDREN` → `ACCEPTED`)会一路放行,而落盘按旧的「不用改状态」走 ——
 * 新任务挂在一个**终态**父节点下面,永远不会被集成,run 却报 completed。
 */
describe('确认前的复核', () => {
  const treeOf = (anchorStatus: NodeStatus): TaskNode[] => [
    mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] }),
    mk('root/01-a', {
      parentId: 'root', depth: 1, status: anchorStatus, kind: 'decompose',
      childIds: ['root/01-a/01-x'],
    }),
    mk('root/01-a/01-x', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' }),
  ]
  const scopeAt = (st: NodeStatus) => {
    const ns = treeOf(st)
    const s = addTaskScope(ns[1], mapOf(ns), { caps: DEFAULT_CAPS, nodeCount: ns.length })
    if (s.ok !== true) throw new Error('夹具不该被拒')
    return s
  }

  it('没变就是没变', () => {
    expect(scopeDiff(scopeAt('WAITING_CHILDREN'), scopeAt('WAITING_CHILDREN'))).toBeUndefined()
  })

  it('**anchor 在关口期间跑完了** —— anchor.id 和重开清单都没变,但必须拦下来', () => {
    const before = scopeAt('WAITING_CHILDREN')
    const after = scopeAt('ACCEPTED')
    // 这两项都没变 —— 上一版只比这两项,所以放行了
    expect(after.anchor.id).toBe(before.anchor.id)
    expect(after.reopen.map(r => r.id)).toEqual(before.reopen.map(r => r.id))
    // 而 anchorSeat 变了:从「不用动」变成「要重开」
    expect(before.anchorSeat).toBeUndefined()
    expect(after.anchorSeat).toBe('WAITING_CHILDREN')
    expect(scopeDiff(before, after)).toContain('状态在你确认之前变了')
  })

  it('挂载点换了人要拦', () => {
    const before = scopeAt('WAITING_CHILDREN')
    const other = { ...before, anchor: mk('root', { title: '根任务' }) }
    expect(scopeDiff(before, other)).toContain('挂载点')
  })

  it('重开清单变了要拦', () => {
    const before = scopeAt('WAITING_CHILDREN')
    const after = { ...before, reopen: [{ id: 'root', title: '根任务', from: 'ACCEPTED' as NodeStatus }] }
    expect(scopeDiff(before, after)).toContain('上级任务清单')
  })

  it('祖先链变了要拦', () => {
    const before = scopeAt('WAITING_CHILDREN')
    expect(scopeDiff(before, { ...before, chain: ['root/01-a'] })).toContain('链变了')
  })
})

/**
 * `manualAdd` 的 round-trip 与可见性。
 *
 * 「写得出去读不回来」是这个仓库付过**四次**账的形状(`roleDefs` / `Verdict.manual` /
 * `RoundtableRecord.step` / `Verdict.remedy`),所以新字段一律要有这一条。
 * 而「只落 frontmatter 等于只做到机器可读那一半」是 `serializeNode` 自己立的规矩,
 * 所以 body 和详情页那一段也要一起钉。
 */
describe('manualAdd 落盘、读回、上屏', () => {
  const withMark = (): TaskNode => mk('root/01-x', {
    parentId: 'root', depth: 1, title: '人加的活', goal: '把超时改成 10s',
    manualAdd: { at: '2026-08-17T01:02:03.000Z', anchorId: 'root' },
  })

  it('serializeNode → parseNodeFile 之后还在', () => {
    const back = parseNodeFile(serializeNode(withMark()))
    expect(back.manualAdd).toEqual({ at: '2026-08-17T01:02:03.000Z', anchorId: 'root' })
  })

  it('body 里看得见 —— 只落 frontmatter 等于只做到机器可读那一半', () => {
    const text = serializeNode(withMark())
    const body = text.slice(text.indexOf('\n---', 4))
    expect(body).toContain('手工新增')
    expect(body).toContain('root')
  })

  it('详情页有「出身」那一段,而普通节点没有(版面逐字不变)', () => {
    expect(detailSections(withMark()).map(s => s.title)).toContain('出身')
    expect(detailSections(mk('root/01-y', { parentId: 'root' })).map(s => s.title)).not.toContain('出身')
  })

  it('盘上写坏了不许让 serializeNode 抛 —— 它每次 commit 都跑', () => {
    const bad = withMark()
    ;(bad as unknown as { manualAdd: unknown }).manualAdd = 123
    expect(() => serializeNode(bad)).not.toThrow()
  })
})

describe('验收打回的那几条静默改写', () => {
  /** ESC 用 fromCharCode 造 —— 源文件里不留字面控制字节(grep 会把它判成 binary)。 */
  const ESC = String.fromCharCode(27)

  it('CSI 序列不许留在标题里(只换掉 ESC 那一个字节是不够的)', () => {
    // 粘一段带 ANSI 的日志:上一版剥完剩下可打印的尾巴,标题成了 "[2J"。
    expect(deriveTitle(`${ESC}[2J${ESC}[H真正的第一行`)).toBe('真正的第一行')
    expect(deriveTitle(`${ESC}[31m红色标题${ESC}[0m`)).toBe('红色标题')
  })

  it('anchor 自己被重开、但它底下还有别的孩子阻断着 —— 要说出来', () => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', {
      title: '甲', parentId: 'root', depth: 1, status: 'BLOCKED', kind: 'decompose',
      childIds: ['root/01-a/01-x', 'root/01-a/02-y'], blockedReason: '子节点阻断',
    })
    const x = mk('root/01-a/01-x', {
      title: '挂了的 x', parentId: 'root/01-a', depth: 2, status: 'BLOCKED', blockedReason: '编译不过',
    })
    const y = mk('root/01-a/02-y', { parentId: 'root/01-a', depth: 2, status: 'ACCEPTED' })
    const s = scopeOf(a, [root, a, x, y])
    expect(s.ok).toBe(true)
    if (s.ok !== true) return
    expect(s.anchor.id).toBe('root/01-a')
    expect(s.targetStillBlocked?.title).toContain('挂了的 x')
    expect(addTaskLines(s, { title: 't', id: 'i', prompt: 'p' }).join('\n')).toContain('仍然是阻断的')
  })
})

describe('重开时的一次性标记', () => {
  it('clearReopenMarks 要把 skipPhase / forcePass 一起清掉', () => {
    const n = mk('root/01-a', {
      status: 'BLOCKED', blockedReason: 'x', skipPhase: 'accept', forcePass: 'verify',
      failedAt: 'EXECUTING', startedAt: NOW, finishedAt: NOW,
      iteration: { planReview: 1, acceptance: 2, integration: 3, scoring: 1, mergeResolve: 0 },
    })
    clearReopenMarks(n, '2026-08-18T00:00:00.000Z')
    // 一个带着 skipPhase='accept' 被重开的节点会**跳过一关它自己都还没走到的判决**。
    expect(n.skipPhase).toBeUndefined()
    expect(n.forcePass).toBeUndefined()
    expect(n.failedAt).toBeUndefined()
    expect(n.blockedReason).toBe('')
    expect(n.iteration.integration).toBe(0)
  })
})

/**
 * 盘上那份 `manualAdd` 被写坏时,**校验必须自己站得住**。
 *
 * ⚠ 这一条是接缝席点名补的:`serializeNode` 自己那道 `typeof` 守卫会把坏值挡住,
 * 于是 hostileDisk 那条扫描线抓不到 `resumeCore` 里的校验 —— 那个文件开头写着的
 * 「a defensive WRITER can mask a missing VALIDATOR entirely」原样重演。
 * 所以直接打 `validateLoadedNodes` 的真身。
 */
describe('manualAdd 从盘上读回来', () => {
  const load = (bad: unknown): { node: TaskNode; repairs: string[] } => {
    const root = mk('root', { status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/01-a'] })
    const a = mk('root/01-a', { parentId: 'root', depth: 1, status: 'ACCEPTED' })
    ;(a as unknown as { manualAdd: unknown }).manualAdd = bad
    const r = validateLoadedNodes([root, a])
    return { node: r.nodes.find(n => n.id === 'root/01-a')!, repairs: r.repairs }
  }

  it('好的那份原样留着', () => {
    const { node, repairs } = load({ at: '2026-08-17T00:00:00Z', anchorId: 'root' })
    expect(node.manualAdd).toEqual({ at: '2026-08-17T00:00:00Z', anchorId: 'root' })
    expect(repairs.join('')).not.toContain('手工新增记录')
  })

  it('坏的那份整条丢掉,并且说出来(留着会让每次 commit 都抛)', () => {
    for (const bad of [123, 'boom', [], { at: 1 }, { anchorId: 'root' }, null]) {
      const { node, repairs } = load(bad)
      expect(node.manualAdd).toBeUndefined()
      if (bad !== null && bad !== undefined) {
        expect(repairs.join('')).toContain('手工新增记录')
      }
    }
  })
})
