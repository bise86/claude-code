# 高效任务模式 — P2 并行执行与 worktree 隔离 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务树真正并行推进(默认 5),并让并行执行在各自的 git worktree 里进行、完成后合并回集成分支——用户原话:"各任务执行可以并行,默认5个"。

**Architecture:** 编排器的串行 `run()` 换成**并发池**:一次扫描出所有可推进节点,取到并发上限,同时推进,任一完成即回扫补位。写仓库的 `execute` 阶段绑定到**每节点一个 git worktree**,验收通过后合并回本 run 的集成分支;隔离不可用时降级为串行执行并在确认关口如实告知。

## 为什么并行与隔离必须同期交付(不可拆)

**没有隔离的并行是有害的,不是"功能少一点"。** `execute` 是唯一拿到可写工具池的阶段;两个执行者同时在同一个工作树上 `Edit` 同一个文件,结果不是"慢一点"而是**互相覆盖**——且双方都会向各自的验收圆桌报告成功。spec §8 把两者放在同一期正是这个原因。

因此本计划的顺序是:先让**非写阶段**并行(Task 17,execute 仍互斥),再落地隔离(Task 18),最后才解除 execute 的互斥锁(Task 19)。**每个 Task 结束时系统都是可用且安全的**,Task 17 单独交付就已经能并行 plan/review/accept 圆桌——那是调用量的大头。

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json`;不引入 `env:` 间接、不脱敏。
- 不 `feature()` 门控。
- **宁可慢,不可谎报**:任何并发化不得让一个失败被并发时序掩盖成成功。
- **不得放宽任何安全阀**:深度、节点数、三个迭代计数、墙钟、无进展守卫,在并发下必须同样有效——其中节点数上限在并发下会**失效**(见下),必须重做。
- 复用既有实现:`src/utils/worktree.ts` 的 `createAgentWorktree` / `removeAgentWorktree` / `hasWorktreeChanges` 已存在且被 AgentTool 使用,不另写一套。
- 断点续跑必须继续可用:P1.5 的校验/归位对 worktree 字段与并发中断产生的状态同样成立。

## 关键事实(均已对源码核实,实现者必读)

| 事实 | 位置 | 并发下为什么要命 |
|---|---|---|
| `createChildren` 先查上限再落子:`if (ctx.byId.size + specs.length > maxNodes)` 在 360 行,`ctx.byId.set` 在 411 行,**中间有 await** | `pipeline.ts:360` / `411` | 典型 check-then-act。两个节点同时拆分,各自对着同一个陈旧 size 判断,双双通过,节点数冲破上限——安全阀静默失效 |
| `run()` 的无进展守卫是**全局**的 `lastPick`/`stalls`,靠"同一个节点连续被选中两次"判定 | `orchestrator.ts:89-122` | 并发下"连续"没有意义:N 个节点交替完成会不断重置计数,守卫永不触发 |
| 中断时 `propagateBlocked(true)` 立即扫描并返回 | `orchestrator.ts:96` | 若此时仍有在飞步骤,它们会在扫描**之后**提交状态,盘上留下一个既非终态也无人推进的节点,而 run() 已经报了结论 |
| `commit()` 只写自己那个 `node.md`;`onUpdate` 触发的 `run.md` 全量重写已在 `runOrchestrator` 用 promise 队列串行化 | `pipeline.ts:28` / `runOrchestrator.ts:26` | 节点文件之间无冲突,清单写入已安全——这两处**不需要**改 |
| `runAgent` 在按阶段过滤工具**之后**又并入 `agentMcpTools` | `runAgent.ts:671` | 绑成 review/accept 的自定义 agent 会拿到自己的(可能可写的)MCP 工具,评审员可以自己改好再放行——执行者/评审者分离被绕过(P1 遗留项 1) |
| `createAgentWorktree(slug)` 返回 `{worktreePath, worktreeBranch?, headCommit?, gitRoot?, hookBased?}`;`removeAgentWorktree(path, branch?, gitRoot?, hookBased?)`;`hasWorktreeChanges(path, headCommit)` | `utils/worktree.ts:902/961/1144` | 现成可用,含 hook 分支;不要自己拼 `git worktree` 命令 |
| `runAgentAdapter` 已经把 `req.cwd` 同时传给 `worktreePath` 和 `runWithCwdOverride` | `runAgentAdapter.ts:105/126` | 隔离所需的执行侧接缝**已经就位**,Task 18 只需产出 cwd |
| `stepExecute` 已经在读 `node.worktree?.path` 作为 cwd | `pipeline.ts:391` | 字段与用法已定义,只是从没有人写入 |

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/tools/efftask/scheduler.ts`(新) | 纯逻辑:从树里挑出本轮可并发推进的节点集合;每节点无进展计数 |
| `src/tools/efftask/scheduler.test.ts`(新) | 上述的穷举单测 |
| `src/tools/efftask/orchestrator.ts`(改) | 串行循环 → 并发池;中断时先等在飞;节点额度原子预留 |
| `src/tools/efftask/pipeline.ts`(改) | `PipelineCtx` 增 `reserveNodes`/`releaseNodes`;`createChildren` 改用之 |
| `src/tools/efftask/worktreePool.ts`(新) | 每节点 worktree 的创建/合并/回收,冲突升级 |
| `src/tools/efftask/worktreePool.test.ts`(新) | 用注入的 git 执行器测,不碰真仓库 |
| `src/tools/efftask/types.ts`(改) | `EffTaskConfig.isolation?: 'worktree' \| 'none'` |
| `src/tools/AgentTool/runAgent.ts`(改) | 非 execute 阶段不得因 MCP 合并而重获写能力 |

---

### Task 17: 并发调度器(execute 仍互斥,零并发写风险)

**Files:**
- Create: `src/tools/efftask/scheduler.ts`、`scheduler.test.ts`
- Modify: `src/tools/efftask/orchestrator.ts`、`pipeline.ts`、`orchestrator.test.ts`

**Interfaces:**
```ts
export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }
export function createStallTracker(): StallTracker
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): { node: TaskNode; kind: AdvanceKind }[]
```

- [ ] **Step 1: 写失败测试 — 批量挑选**

```ts
// src/tools/efftask/scheduler.test.ts
import { describe, expect, it } from 'bun:test'
import { createStallTracker, pickBatch } from './scheduler.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('pickBatch selects everything that can move, up to the limit', () => {
  it('returns independent siblings together', () => {
    const root = mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['a', 'b'] })
    const a = mk({ id: 'a', parentId: 'root', status: 'READY', kind: 'executable' })
    const b = mk({ id: 'b', parentId: 'root', status: 'READY', kind: 'executable' })
    const all = [root, a, b]
    expect(pickBatch(all, byIdMap(all), new Set(), 5).map(x => x.node.id)).toEqual(['a', 'b'])
  })

  it('never picks a node whose dependency has not been ACCEPTED', () => {
    // The dependency gate is the whole point of the tree; concurrency must not widen it.
    const root = mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['a', 'b'] })
    const a = mk({ id: 'a', parentId: 'root', status: 'READY', kind: 'executable' })
    const b = mk({ id: 'b', parentId: 'root', status: 'READY', kind: 'executable', deps: ['a'] })
    const all = [root, a, b]
    expect(pickBatch(all, byIdMap(all), new Set(), 5).map(x => x.node.id)).toEqual(['a'])
  })

  it('never re-picks a node that is already running', () => {
    // Two concurrent steps on ONE node would double its iteration spend and interleave
    // two writes to the same node.md.
    const a = mk({ id: 'a', status: 'READY', kind: 'executable' })
    expect(pickBatch([a], byIdMap([a]), new Set(['a']), 5)).toEqual([])
  })

  it('honours the concurrency limit and is deterministic about who goes first', () => {
    const kids = ['a', 'b', 'c', 'd'].map(id => mk({ id, parentId: 'root', status: 'READY', kind: 'executable' }))
    const root = mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['a', 'b', 'c', 'd'] })
    const all = [root, ...kids]
    expect(pickBatch(all, byIdMap(all), new Set(), 2).map(x => x.node.id)).toEqual(['a', 'b'])
  })

  it('skips a node under a BLOCKED ancestor', () => {
    // Its parent can never be accepted, so running it spends real model calls and mutates
    // the repo for a result nothing will consume.
    const root = mk({ id: 'root', status: 'BLOCKED', kind: 'decompose', childIds: ['a'] })
    const a = mk({ id: 'a', parentId: 'root', status: 'READY', kind: 'executable' })
    const all = [root, a]
    expect(pickBatch(all, byIdMap(all), new Set(), 5)).toEqual([])
  })
})

describe('the no-progress guard must be PER NODE once work overlaps', () => {
  it('fires after two consecutive no-op steps on the same node', () => {
    const t = createStallTracker()
    expect(t.note('a', 'READY')).toBe(1)
    expect(t.note('a', 'READY')).toBe(2)
  })

  it('is not reset by another node making progress in between', () => {
    // The serial guard used ONE global "last picked" fingerprint. With N nodes in flight,
    // any other node finishing resets it, so a genuinely stuck node spins forever issuing
    // real model calls — the guard becomes decorative exactly when it is needed.
    const t = createStallTracker()
    expect(t.note('a', 'READY')).toBe(1)
    t.note('b', 'CREATED')
    expect(t.note('a', 'READY')).toBe(2)
  })

  it('resets when the node actually moves', () => {
    const t = createStallTracker()
    t.note('a', 'READY')
    expect(t.note('a', 'EXECUTING')).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `Cannot find module './scheduler.js'`

- [ ] **Step 3: 实现 `scheduler.ts`**

```ts
import { advanceableKind, isTerminal, type AdvanceKind } from './stateMachine.js'
import type { TaskNode } from './types.js'

/**
 * Per-node no-progress counter.
 *
 * The serial orchestrator used ONE global fingerprint ("was the same node picked twice in a
 * row?"). That works only while exactly one node moves at a time: with N in flight, any
 * other node completing resets it, so a node that cannot progress spins forever issuing real
 * model calls. Keyed per node, the guard means the same thing under any concurrency.
 */
export function createStallTracker(): StallTracker {
  const seen = new Map<string, { fingerprint: string; count: number }>()
  return {
    note(id, status) {
      const prev = seen.get(id)
      const next = prev && prev.fingerprint === status ? prev.count + 1 : 1
      seen.set(id, { fingerprint: status, count: next })
      return next
    },
    clear(id) { seen.delete(id) },
  }
}
export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }

function hasBlockedAncestor(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  const seen = new Set<string>()
  let cur = node.parentId ? byId.get(node.parentId) : undefined
  while (cur && !seen.has(cur.id)) {
    if (cur.status === 'BLOCKED') return true
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return false
}

/**
 * Everything that can move right now, capped at `limit`.
 *
 * MUST be called and its results dispatched with NO await in between: JavaScript is
 * single-threaded, so an uninterrupted scan-then-dispatch makes the dependency check atomic
 * by construction. Insert an await there and a sibling can BLOCK a dependency between the
 * check and the launch, and the node runs against a dead dependency.
 */
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): { node: TaskNode; kind: AdvanceKind }[] {
  const out: { node: TaskNode; kind: AdvanceKind }[] = []
  // Deterministic order by id — a plain codepoint compare, NOT localeCompare (locale/ICU
  // dependent). Determinism matters for reproducing a bad run.
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const n of ordered) {
    if (out.length >= limit) break
    if (inFlight.has(n.id)) continue // one step per node at a time: two would double-spend its budget
    if (isTerminal(n.status)) continue
    if (hasBlockedAncestor(n, byId)) continue
    const kind = advanceableKind(n, byId)
    if (kind !== null) out.push({ node: n, kind })
  }
  return out
}
```
(把 `orchestrator.ts` 里私有的 `hasBlockedAncestor` 删掉,改用这里的,避免两份定义漂移。)

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 写失败测试 — 节点额度必须原子预留**

追加到 `src/tools/efftask/pipeline.test.ts`:

```ts
it('two concurrent decompositions cannot together exceed maxNodes', async () => {
  // check-then-act: createChildren compares byId.size against the cap, then awaits persist,
  // and only afterwards inserts. Two nodes decomposing at once both measure the same stale
  // size, both pass, and the tree ends over the cap — the safety valve silently off.
  const ctx = ctxFor({ caps: { ...DEFAULT_CAPS, maxNodes: 4 } })
  // root + a + b already exist (3). Each of a and b wants 2 children → 7 > 4.
  const [a, b] = ['a', 'b'].map(id => ctx.byId.get(id)!)
  const results = await Promise.all([
    createChildrenForTest(a, [{ title: 'a1', deps: [] }, { title: 'a2', deps: [] }], ctx),
    createChildrenForTest(b, [{ title: 'b1', deps: [] }, { title: 'b2', deps: [] }], ctx),
  ])
  expect(results.filter(r => r.ok)).toHaveLength(1) // exactly one batch fits
  expect(ctx.byId.size).toBeLessThanOrEqual(4)
})
```

- [ ] **Step 6: 跑红 → 实现原子预留**

`PipelineCtx` 增两个同步方法(orchestrator 提供):

```ts
  /**
   * Claim `count` node slots, or refuse. SYNCHRONOUS on purpose: the cap check and the claim
   * must not be separated by an await, or two concurrent decompositions both measure the same
   * stale count and both pass. Released if the batch is later abandoned.
   */
  reserveNodes: (count: number) => boolean
  releaseNodes: (count: number) => void
```

orchestrator 实现:

```ts
  private reserved = 0
  private reserveNodes = (count: number): boolean => {
    if (this.byId.size + this.reserved + count > this.cfg.caps.maxNodes) return false
    this.reserved += count
    return true
  }
  private releaseNodes = (count: number): void => { this.reserved = Math.max(0, this.reserved - count) }
```

`createChildren` 里把 `if (ctx.byId.size + specs.length > ctx.config.caps.maxNodes)` 换成 `if (!ctx.reserveNodes(specs.length))`,并在**每条**提前返回路径与最终 `byId.set` 之后 `releaseNodes`(materialise 后额度由 `byId.size` 自己承担,所以插入完成即释放)。

- [ ] **Step 7: 跑绿**

- [ ] **Step 8: 写失败测试 — 中断必须先等在飞步骤结束**

```ts
it('an interrupt waits for in-flight steps before declaring the tree finished', async () => {
  // propagateBlocked(true) sweeps and returns. If a step is still running it commits AFTER
  // the sweep, leaving a node that is neither terminal nor being advanced while run() has
  // already reported its verdict — and the persisted tree contradicts the report.
  const ac = new AbortController()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let committedAfterSweep = false
  const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), deps(async () => {
    ac.abort()
    await gate
    return planAnswer
  }), ac.signal)
  const done = orch.run()
  await new Promise(r => setTimeout(r, 20))
  release()
  const res = await done
  expect(res).toEqual({ status: 'blocked', reason: '已中断' })
  for (const n of orch.nodes()) expect(isTerminal(n.status)).toBe(true)
  expect(committedAfterSweep).toBe(false)
})
```

- [ ] **Step 9: 跑红 → 改 `run()` 为并发池**

```ts
  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    const stalls = createStallTracker()
    const inFlight = new Map<string, Promise<void>>()
    // P2 note: execute is still serialised by this mutex. Two write-capable executors in ONE
    // working tree would overwrite each other's edits while both reported success. It is
    // lifted in Task 19, once every executable node has its own worktree.
    let executeChain: Promise<void> = Promise.resolve()

    const settleAll = async (): Promise<void> => { await Promise.allSettled([...inFlight.values()]) }

    for (;;) {
      const root = this.byId.get('root')!
      if (root.status === 'ACCEPTED') { await settleAll(); return { status: 'completed' } }
      if (this.signal.aborted) {
        // Wait FIRST: a step that commits after the sweep would leave a non-terminal node in
        // a tree we already declared finished.
        await settleAll()
        await this.propagateBlocked(true)
        return { status: 'blocked', reason: '已中断' }
      }

      const limit = Math.max(1, this.cfg.parallelism)
      // NO await between pickBatch and the dispatch loop — that is what makes the dependency
      // check atomic (see pickBatch's contract).
      const batch = pickBatch(this.nodes(), this.byId, new Set(inFlight.keys()), limit - inFlight.size)
      for (const { node, kind } of batch) {
        const before = node.status
        const task = this.runStep(node, kind)
          .then(() => {
            if (stalls.note(node.id, node.status) >= 2 && node.status === before) {
              node.status = 'BLOCKED'
              node.blockedReason = node.blockedReason || '节点未能推进(状态未变化),已阻断以避免空转'
              node.updatedAt = this.nowSafe()
              return this.safePersist(node).then(() => this.safeUpdate())
            }
            if (node.status !== before) stalls.clear(node.id)
          })
          .finally(() => { inFlight.delete(node.id) })
        inFlight.set(node.id, kind === 'execute'
          // serialise execute only
          ? (executeChain = executeChain.then(() => task))
          : task)
      }

      if (inFlight.size === 0) {
        // Nothing running and nothing pickable → the tree is stuck.
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      // Wait for the FIRST completion, then rescan and top the pool back up.
      await Promise.race([...inFlight.values()]).catch(() => {})
    }
  }
```
`runStep` 就是原来 try/catch 里那段(含 `subtreeAlive` 判定),抽成私有方法。

- [ ] **Step 10: 跑绿 + 全量;确认既有 orchestrator 测试全部仍绿(串行行为在 parallelism=1 下必须逐字保持)**

- [ ] **Step 11: 提交**

```bash
git commit -m "feat(efftask): 并发调度池(execute 暂仍互斥)、每节点无进展守卫、节点额度原子预留"
```

---

### Task 18: 每节点 git worktree 隔离

**Files:** `src/tools/efftask/worktreePool.ts` + 测试;`types.ts`(改)

**Interfaces:**
```ts
export interface GitRunner { (args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> }
export interface WorktreePool {
  acquire(node: TaskNode): Promise<{ path: string; branch?: string } | null> // null = 隔离不可用
  merge(node: TaskNode): Promise<{ ok: true } | { ok: false; conflict: string }>
  release(node: TaskNode): Promise<void>
  dispose(): Promise<void>
}
export function createWorktreePool(deps: {
  runId: string; git: GitRunner
  createWorktree: typeof createAgentWorktree
  removeWorktree: typeof removeAgentWorktree
  hasChanges: typeof hasWorktreeChanges
}): WorktreePool
```

要点(每条都要有测试):
- **acquire** 用 `createAgentWorktree(slug)`,slug 由 `runId + node.id` 派生并过 `validateWorktreeSlug`;结果写入 `node.worktree`,`stepExecute` 已经在读它当 cwd。
- **不是 git 仓库 / 创建失败 → 返回 `null`,不抛**。整个 run 降级为无隔离(见 Task 19),并在确认关口如实告知——不能假装隔离了。
- **merge** 在节点 ACCEPTED 之后:先 `hasWorktreeChanges`,无改动直接跳过合并(常见:纯分析型节点);有改动则合并回本 run 的集成分支 `efftask/<runId>`。
- **冲突 → 不自动解决,不重试,升级为人工**:节点标 BLOCKED,理由带上冲突文件列表;worktree **保留不删**,否则用户无从查看与手工挽救。spec §16 明确这是最大风险且不追求全自动。
- **release** 只在合并成功后删 worktree;合并失败保留。
- **dispose** 在 run 结束时回收所有仍存活的 worktree(除冲突保留的),并记录哪些被保留。

- [ ] Step 1-8:先写测试(注入假 `GitRunner` 与假 worktree 函数,不碰真仓库)→ 跑红 → 实现 → 跑绿 → 提交。
      必测:创建失败降级为 null;无改动跳过合并;冲突时节点 BLOCKED 且 worktree 保留;合并成功后才删除;dispose 报告保留清单;slug 含 `/` 的节点 id 不会逃逸(`root/01-x` → 合法 slug)。

---

### Task 19: 解除 execute 互斥,并行度真正生效

**Files:** `orchestrator.ts`、`efftask.tsx`、`ConfirmStartup.tsx`、`feishuStartupCard.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('runs independent executable siblings at the same time when isolated', async () => {
  // The user-facing requirement: 各任务执行可以并行,默认5个.
  let peak = 0, cur = 0
  const orch = new EffTaskOrchestrator(cfg({ parallelism: 3, isolation: 'worktree' }), deps(async req => {
    if (req.phase === 'execute') { cur++; peak = Math.max(peak, cur); await tick(); cur-- }
    return answerFor(req)
  }), signal, undefined, fakeWorktreePool())
  await orch.run()
  expect(peak).toBeGreaterThan(1)
})

it('does NOT run two executors at once when isolation is unavailable', async () => {
  // Two write-capable agents in one working tree overwrite each other's edits while both
  // report success. Serial is the correct degradation, not a missing feature.
  let peak = 0, cur = 0
  const orch = new EffTaskOrchestrator(cfg({ parallelism: 3, isolation: 'none' }), deps(async req => {
    if (req.phase === 'execute') { cur++; peak = Math.max(peak, cur); await tick(); cur-- }
    return answerFor(req)
  }), signal)
  await orch.run()
  expect(peak).toBe(1)
})
```

- [ ] **Step 2-4:** 跑红 → 让 `executeChain` 互斥只在 `isolation !== 'worktree'` 时生效 → 跑绿。

- [ ] **Step 5: 确认关口如实反映**

`ConfirmStartup` 与飞书卡片里那句写死的"（P1 串行执行,此值 P2 生效）"必须改成真实状态:
- 隔离可用 → `并行数: 5（每个执行任务在独立 worktree 中运行）`
- 隔离不可用 → `并行数: 5（当前目录不是 git 仓库,执行阶段将串行,其余阶段并行）`,并进 `notices`。
两个界面共用同一个函数生成这句话——`rosterLines` 的同款理由。

---

### Task 20: 堵上 MCP 绕过只读闸门(P1 遗留项 1)

**Files:** `src/tools/AgentTool/runAgent.ts` 或 `runAgentAdapter.ts` + 测试

`runAgentAdapter` 按阶段限制工具池,但 `runAgent.ts:671` 在过滤之后又把 `agentMcpTools` 并回来。把一个声明了 `mcpServers` 的自定义 agent 绑成 `review`/`accept` 角色,这个"评审员"就拿到了自己的、可能可写的 MCP 工具——它可以自己把问题改好再放行,而执行者/评审者分离正是为了防这件事。

- [ ] **Step 1: 写失败测试** — 构造一个带 MCP 工具的 agent 定义,以 `phase:'accept'` 走 `makeRunAgentFn`,断言最终 `availableTools` 里**没有**任何可写工具。
- [ ] **Step 2-4:** 跑红 → 修 → 跑绿。修法二选一,实现者按代价决定并在提交信息里说明理由:
  (a) 非 execute 阶段在传给 `runAgent` 的 agent 定义上设 `disallowedTools`;
  (b) 在 `runAgent` 合并之后再按调用方给的白名单过滤一次。
  **不要**直接删掉 MCP 合并——那会改变 AgentTool 既有行为,影响面远超本功能。

---

## Self-Review

- 用户原话"各任务执行可以并行,默认5个" → Task 17 + 19 共同交付;Task 17 单独交付即可并行非写阶段。
- spec §8 并行隔离与合并回收 → Task 18。
- spec §16 冲突升级人工、不追求全自动 → Task 18 的冲突处理,明确保留 worktree。
- P1 遗留项 1(MCP 绕过) → Task 20。
- P1 遗留项 5(`run.md` 每次全量重写)**本期不做**:并发下写入频率会上升,但清单写入已被 promise 队列串行化,是浪费而非错误。留在 P3,不在此假装解决。
- **已知不做**:节点级并行的 worktree 之间若改同一文件,后合并者冲突——这是设计接受的代价(spec §16),缓解手段是让 plan 阶段用依赖边串联可能冲突的节点。
