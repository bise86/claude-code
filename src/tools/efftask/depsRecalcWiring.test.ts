/**
 * 依赖重算的**行为**覆盖:编排器那一跳,和落盘/读回那一半。
 *
 * 这两块此前只有「源码里有没有那个字面量」级别的覆盖 —— 验收席实测:把 `depsRecalcBody`
 * 变成一个定义了但没人调的死函数、把 `nudge()` 从 `depsChanged` 里拿掉、把恢复边界的
 * 逐字段重建整段删掉,**3655 条测试一条都不红**。而 `nudge()` 正是这个功能全部收益
 * (提前起跑)的兑现点。
 */
import { describe, expect, it } from 'bun:test'
import { EffTaskOrchestrator } from './orchestrator.js'
import { createRunControl } from './control.js'
import { serializeNode, parseNodeFile, renderTreeSnapshot } from './persistence.js'
import { validateLoadedNodes } from './resumeCore.js'
import { createNode, emptyPhaseRoles, emptyPhaseRoles as roles, MAX_DEPS_RECALC_RECORDS, type EffTaskConfig, type TaskNode } from './types.js'
import { DEFAULT_CAPS } from './types.js'

const NOW = '2026-08-09T00:00:00.000Z'
const mk = (id: string, over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({
    id, title: id.split('/').pop() ?? id, parentId: null, deps: [], depth: id.split('/').length - 1,
    phaseRoles: emptyPhaseRoles(), now: NOW,
  }),
  ...over,
})

const cfg = (): EffTaskConfig => ({
  goalPrompt: 'g', parallelism: 2, phaseRoles: roles(), caps: { ...DEFAULT_CAPS },
})

// ════════════════════════════════════════════════ 编排器那一跳

describe('orchestrator.depsChanged', () => {
  const seed = (): TaskNode[] => [
    mk('root', { kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['root/00-a'] }),
    mk('root/00-a', { parentId: 'root', status: 'CREATED', deps: [] }),
  ]
  const deps = (over: Record<string, unknown> = {}) => ({
    runAgent: async () => '',
    persist: async () => {},
    now: () => NOW,
    onUpdate: () => {},
    ...over,
  })

  it('**上屏**:它是 run.md 唯一写入点的入口(safeUpdate → onUpdate → queueManifest)', () => {
    let updates = 0
    const o = new EffTaskOrchestrator(cfg(), deps({ onUpdate: () => { updates++ } }) as never, new AbortController().signal, seed())
    const before = updates
    expect(o.depsChanged('root/00-a')).toEqual({ ok: true })
    // 少了这一下,run.md 上的 ⟲ 标记要等别的节点下一次 commit 才出现;
    // 若这次重算是本趟运行的最后一个动作,它永远不出现。
    expect(updates).toBe(before + 1)
  })

  it('**叫醒调度** —— 这是整个功能收益的兑现点', async () => {
    const o = new EffTaskOrchestrator(cfg(), deps() as never, new AbortController().signal, seed())
    // 编排器在「等某个节点跑完」时睡在 wakeup 上。depsChanged 必须把它叫醒,否则新满足的
    // 依赖要等**另一个**节点跑完才被看见 —— 而「别的任务正在跑一个二十分钟的执行环节」
    // 恰恰是用户按下 d 的那一刻。
    const w = (o as unknown as { wakeup: { promise: Promise<void> } }).wakeup.promise
    let woke = false
    void w.then(() => { woke = true })
    o.depsChanged('root/00-a')
    await Promise.resolve(); await Promise.resolve()
    expect(woke).toBe(true)
  })

  it('**不碰取消标记** —— 这是它不复用 applyLive 的全部理由', () => {
    const control = createRunControl()
    const o = new EffTaskOrchestrator(cfg(), deps({ control }) as never, new AbortController().signal, seed())
    control.cancelNode('root/00-a')
    o.depsChanged('root/00-a')
    /**
     * 一个被 x 取消过的 CREATED 节点永远不会被 pickBatch 选中(依赖没满足),标记就一直
     * 挂着;`applyLive` 顺手 `clearCancel` 会让它起跑、跑完、把产出合进集成分支,
     * `intoTrunk` 再合进用户当前分支 —— 用户明确拒绝过的任务,产出落进了他自己的分支,
     * 而屏幕上只说「依赖已重算」。
     */
    expect(control.wasCancelled('root/00-a')).toBe(true)
  })

  it('正在跑的节点回 running,编排器结束后回 finished / aborted', async () => {
    const o = new EffTaskOrchestrator(cfg(), deps() as never, new AbortController().signal, seed())
    ;(o as unknown as { inFlightIds: Set<string> }).inFlightIds.add('root/00-a')
    expect(o.depsChanged('root/00-a')).toEqual({ ok: false, reason: 'running' })
    ;(o as unknown as { inFlightIds: Set<string> }).inFlightIds.delete('root/00-a')
    ;(o as unknown as { finished: boolean }).finished = true
    expect(o.depsChanged('root/00-a')).toEqual({ ok: false, reason: 'finished' })
    const ac = new AbortController()
    const o2 = new EffTaskOrchestrator(cfg(), deps() as never, ac.signal, seed())
    ;(o2 as unknown as { finished: boolean }).finished = true
    ac.abort()
    expect(o2.depsChanged('root/00-a')).toEqual({ ok: false, reason: 'aborted' })
  })
})

// ════════════════════════════════════════════════ 落盘 / 读回(行为,不是字面量)

const REC = { at: NOW, from: ['root/01-b'], to: ['root/01-b/00-b1'] }

describe('node.md 的「依赖重算」一节', () => {
  it('真的被渲染出来 —— 把 depsRecalcBody 变成死函数时这条要红', () => {
    const n = mk('root/00-a', { depsRecalc: [REC] })
    const md = serializeNode(n)
    expect(md).toContain('## 依赖重算')
    expect(md).toContain('root/01-b → root/01-b/00-b1')
  })

  it('被夹掉的条数也印出来,否则界面和 run.md 的数对不上而读的人无从判断', () => {
    const n = mk('root/00-a', { depsRecalc: [REC], depsRecalcDropped: 4 })
    expect(serializeNode(n)).toContain('另有 4 次重算在恢复时未逐条保留')
  })

  it('没重算过的节点版面**逐字节不变**', () => {
    const a = serializeNode(mk('root/00-a'))
    expect(a).not.toContain('## 依赖重算')
  })

  it('手改成垃圾时不抛(这段跑在每一次 commit 上,抛一次就是永久死节点)', () => {
    for (const bad of ['boom', null, [null], [{ from: 'x' }], [{ from: [], to: [], at: 1 }]]) {
      const n = mk('root/00-a', { depsRecalc: bad as never })
      expect(() => serializeNode(n)).not.toThrow()
    }
  })
})

describe('run.md 的 ⟲ 标记', () => {
  it('计数用 length + dropped —— 只用 length 会让一个重算过 12 次的节点恢复后永远显示 ×5', () => {
    const n = mk('root', { depsRecalc: [REC, REC], depsRecalcDropped: 3 })
    expect(renderTreeSnapshot([n])).toContain('⟲ 依赖重算 ×5')
  })

  it('没重算过的 run 逐字节不变', () => {
    expect(renderTreeSnapshot([mk('root')])).not.toContain('⟲')
  })

  it('手改的 `depsRecalc: boom` 不许印出一个凭空的 ×4', () => {
    const n = mk('root', { depsRecalc: 'boom' as never })
    expect(renderTreeSnapshot([n])).not.toContain('⟲')
  })
})

describe('恢复边界', () => {
  const load = (n: TaskNode) =>
    validateLoadedNodes([parseNodeFile(serializeNode(n))], { goal: 'g', phaseRoles: roles(), now: NOW })

  it('round-trip:字段活过一次 --resume', () => {
    const out = load(mk('root', { depsRecalc: [REC] }))
    expect(out.nodes[0].depsRecalc).toEqual([REC])
  })

  it('超过上限时保留**最老 1 条 + 最新 N-1 条**,并把丢弃条数落进节点', () => {
    const many = Array.from({ length: MAX_DEPS_RECALC_RECORDS + 5 }, (_, i) => ({
      at: NOW, from: [`f${i}`], to: [`t${i}`],
    }))
    const out = load(mk('root', { depsRecalc: many }))
    const kept = out.nodes[0].depsRecalc!
    expect(kept.length).toBe(MAX_DEPS_RECALC_RECORDS)
    // 最老那一条的 from 是这条链的起点,丢了它剩下的读起来像从半空中开始
    expect(kept[0].from).toEqual(['f0'])
    expect(kept.at(-1)!.to).toEqual([`t${many.length - 1}`])
    expect(out.nodes[0].depsRecalcDropped).toBe(5)
    expect(out.repairs.join('')).toContain('依赖重算记录超过')
  })

  it('丢弃计数**累加**,不是覆盖', () => {
    const many = Array.from({ length: MAX_DEPS_RECALC_RECORDS + 3 }, (_, i) => ({ at: NOW, from: [`f${i}`], to: [`t${i}`] }))
    const out = load(mk('root', { depsRecalc: many, depsRecalcDropped: 7 }))
    // 覆盖写出来的是一个「描述本趟而非真实损失」的数字
    expect(out.nodes[0].depsRecalcDropped).toBe(10)
  })

  it('夹取**幂等**:已经夹过的再恢复一次不再变', () => {
    const many = Array.from({ length: MAX_DEPS_RECALC_RECORDS + 5 }, (_, i) => ({ at: NOW, from: [`f${i}`], to: [`t${i}`] }))
    const once = load(mk('root', { depsRecalc: many }))
    const twice = validateLoadedNodes(
      [parseNodeFile(serializeNode(once.nodes[0]))], { goal: 'g', phaseRoles: roles(), now: NOW },
    )
    expect(twice.nodes[0].depsRecalc!.length).toBe(MAX_DEPS_RECALC_RECORDS)
    expect(twice.nodes[0].depsRecalcDropped).toBe(5)
  })

  it('YAML 的空值(null)不许让整个恢复抛出去 —— confirmedDraft 为同一行栽过', () => {
    const n = mk('root')
    ;(n as { depsRecalc?: unknown }).depsRecalc = null
    expect(() => validateLoadedNodes([n], { goal: 'g', phaseRoles: roles(), now: NOW })).not.toThrow()
  })

  it('坏形状整条丢掉并记 repair', () => {
    const out = load(mk('root', { depsRecalc: [REC, { at: NOW } as never, 'boom' as never] }))
    expect(out.nodes[0].depsRecalc!.length).toBe(1)
    expect(out.repairs.join('')).toContain('依赖重算记录已损坏')
  })

  it('垃圾值的 dropped 计数被清掉(合法正数留着 —— 见 recalcFollowup 那条)', () => {
    const n = mk('root')
    ;(n as { depsRecalcDropped?: unknown }).depsRecalcDropped = '七'
    const out = validateLoadedNodes([n], { goal: 'g', phaseRoles: roles(), now: NOW })
    expect(out.nodes[0].depsRecalcDropped).toBeUndefined()
  })

  it('超长字段在恢复边界被夹 —— 盘上 5000 条 × 500 字会让每次状态迁移全量重写 MB 级 node.md', () => {
    const huge = { at: NOW, from: [`x`.repeat(50_000)], to: ['y'], note: 'n'.repeat(50_000) }
    const out = load(mk('root', { depsRecalc: [huge] }))
    const r = out.nodes[0].depsRecalc![0]
    expect(r.from[0].length).toBeLessThan(50_000)
    expect((r.note ?? '').length).toBeLessThan(50_000)
  })
})

// ════════════════════════════════════════════════ 与重做的交互

describe('redoCommit 的悬空依赖诊断', () => {
  /**
   * 这段话点名的是一条**不可恢复**的路:子树已从盘上删掉、而依赖方的 node.md 没写回去 →
   * 下次 `--resume` 走 `block(A, '依赖节点缺失')`,而 `block()` 把 interrupted /
   * capBlocked / mergeConflict 三个复活开关**全部清零** —— `--retry-blocked` 和重做都
   * 救不回来,只能手改 node.md。所以这句话必须**点名到 id**,而且自带修法。
   *
   * 它此前零覆盖:提交信息里强调过,而剪掉整段没有任何测试会红。
   */
  it('写失败 + 盘上还指着被删节点 → 点名到 id,并给出改成什么', async () => {
    const { commitRedo } = await import('./redoCommit.js')
    const before = [
      mk('root', { kind: 'decompose', childIds: ['root/00-a', 'root/01-b'] }),
      mk('root/00-a', { parentId: 'root', deps: ['root/01-b/00-x'] }),
      mk('root/01-b', { parentId: 'root', childIds: ['root/01-b/00-x'] }),
      mk('root/01-b/00-x', { parentId: 'root/01-b' }),
    ]
    const after = before.filter(n => n.id !== 'root/01-b/00-x').map(n => ({ ...n }))
    after.find(n => n.id === 'root/00-a')!.deps = ['root/01-b']
    const problems = await commitRedo(
      {
        fs: {
          writeFile: async () => { throw new Error('磁盘满') },
          mkdir: async () => {}, readFile: async () => '', readdir: async () => [],
          exists: async () => true, mkdirExclusive: async () => true,
          unlink: async () => {}, rmdir: async () => {},
        } as never,
        runDir: '/run/001', config: cfg(), before,
      },
      {
        nodes: after, deleted: ['root/01-b/00-x'],
        dependencyRewrites: [{ nodeId: 'root/00-a', from: 'root/01-b/00-x', to: 'root/01-b' }],
        worktreesToRelease: [], seatedAt: 'CREATED', reopenedAncestors: [], warnings: [],
      },
    )
    const text = problems.problems.join('\n')
    expect(text).toContain('root/00-a')
    expect(text).toContain('root/01-b/00-x')      // 指着哪个被删的节点
    expect(text).toContain('依赖节点缺失')          // 下次 resume 会怎么死
    expect(text).toContain('--retry-blocked')      // 而且救不回来
    expect(text).toContain('root/01-b')            // 该改成什么
  })
})
