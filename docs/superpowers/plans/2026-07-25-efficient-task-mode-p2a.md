# 高效任务模式 — P2a 并发调度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务树的**方案与评审阶段**并行推进,把并行数交给用户在关口修改,并堵上评审员绕过只读闸门的口子。**`execute` 阶段严格串行**,直到 P2b 的 worktree 隔离落地。

**Architecture:** 串行 `run()` 换成并发池:扫描出所有可推进节点 → 取到并发预算 → 同时推进 → 任一完成即回扫补位。`stepExecute` 单独走一条串行链,**且不占用并发预算**。节点额度改为原子令牌预留。

> **并行的确切边界(实测,勿再写错):** `stepExecute` 是一个 `execute → accept → rework` 的
> `for(;;)` 循环,把它挂上串行链意味着**执行、叶子验收、以及每一轮返工**整体串行。因此:
>
> | 阶段 | 是否并行 |
> |---|---|
> | 方案(plan,在 stepStart 内) | ✅ |
> | 评审(review,在 stepStart 内) | ✅ |
> | 执行(execute) | ❌ 串行 |
> | **叶子节点的验收(accept)** | ❌ 串行 —— 它在 stepExecute 循环内 |
> | 分解节点的集成验收(integrate) | ✅ |
>
> 实测 parallelism=20、8 个独立叶子:`peak = {plan:8, review:8, execute:1, accept:1}`。
> 早期版本的 Goal、关口文案与提交信息都写成"plan / review / accept 圆桌并行",对叶子
> 验收而言是**假的**;已由 `concurrency.test.ts` 的 "what is and is not parallel" 固化。

**Tech Stack:** 与前期同。测试 `bun test`。

## 本文档的由来(勿删)

P2 v1(`…-p2.md`)经三方圆桌评审否决,32 条阻断。**本文档只承接其中被验证为可安全交付的部分**,并逐条修正了并发评审员用可运行骨架复现出的缺陷。worktree 隔离部分问题更深(slug 非法、合并丢工作、验收看不见工作、绝对路径穿透隔离),必须另立文档重新设计后方可实施。

**尤其记住这条:** 评审员把 v1 的代码逐字搭成骨架后,**16 条既有编排器测试在 parallelism=5 下全绿**,而实现同时具备"互斥失效""进程挂死""额度泄漏"三个缺陷。**"既有测试仍绿"不构成并发正确性的验证**;本文档每个并发断言都必须能观测到时序本身(峰值并发数、事件先后顺序),而不是只看最终状态。

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json`;不引入 `env:` 间接、不脱敏。
- 不 `feature()` 门控。
- **`execute` 在本期严格串行。** 它是唯一拿到可写工具池的阶段(`runAgentAdapter.ts:69`);两个执行者同时在同一个工作树上 `Edit` 同一文件是**互相覆盖**,且双方都会向各自的验收圆桌报成功。解除串行的前提是 P2b 的隔离,不是本期。
- **不得放宽任何安全阀**:深度、节点数、三个迭代计数、墙钟、无进展守卫在并发下必须同样有效。
- `parallelism = 1` 时的行为必须与今天的串行实现**逐字一致**。

## 关键事实(均已复现,实现者必读)

| 事实 | 为什么要命 |
|---|---|
| `const task = this.runStep(...)` 会**立刻开始执行**;`chain.then(() => task)` 只把等待排队,执行早已并发展开 | 这是 v1 "互斥锁"的实现方式,实测并发峰值 3。互斥必须把**启动**本身推迟到链上 |
| 排队中(未启动)的 execute 若也计入并发预算,会占满名额却不干活 | 实测:`budget = P - inFlight.size` 时,第一个 execute 持有树的整个窗口内**一次调用都不发**(正确实现同窗口发出 82 次)。分歧起点是 `inFlight.size > running`(P=3 时 inFlight=2 即分歧),最大差 3 个名额 |
| 一个被拒绝的任务会**永久污染** `executeChain`:此后每个 `.then` 立即拒绝,`Promise.race([...]).catch(()=>{})` 在微任务内返回 | 实测 20 万次循环内一个 30ms 定时器从未触发 —— 无 I/O、无定时器的纯微任务饥饿,进程挂死 |
| `createChildren` 在 `specs.map` 内调用**裸 `ctx.now()`**(非 `nowSafe`) | 这是额度释放未枚举到的第五条退出路径;时钟抛错即泄漏,之后一次本来放得下的拆分会被误判超限并阻断 |
| `propagateBlocked` 在 `for (const n of this.byId.values())` 这个**活迭代器**内 `await safePersist` | 目前安全,仅因为它只在 inFlight 为空时被调用。这条不变式是承重的且此前无人写下 |
| 无进展守卫触发时设 BLOCKED 但**不设 `interrupted`** | 若发生在中断期间,该节点在续跑时不会被重开 |
| 墙钟上限在 runAgent 接缝上(`timeoutMs: caps.nodeTimeoutMs`)按**每次调用**生效 | 挂起的步骤不会永久占名额,但一个节点的上限是 `maxIterations × 600s`,并发 5 时一个名额可被占约 10 分钟 |

**评审已验证为正确、不要改动的部分:** 同步的 check-then-claim 额度预留(JS 单线程下不可能交错);并发池的计数与去重(实测各上限下峰值不超限、零重复派发);`.finally` 删除 `inFlight` 条目;`await settleAll()` 再 `propagateBlocked(true)` 的中断时序(实测零"扫描后提交");`run.md` 全量重写已被 promise 队列串行化,并发只是浪费而非错误。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/tools/efftask/scheduler.ts`(新) | `pickBatch` + 每节点无进展计数 |
| `src/tools/efftask/scheduler.test.ts`(新) | 上述单测 |
| `src/tools/efftask/concurrency.test.ts`(新) | **观测时序本身**的并发断言(峰值、先后、饥饿) |
| `src/tools/efftask/orchestrator.ts`(改) | 并发池;execute 串行链;额度令牌 |
| `src/tools/efftask/pipeline.ts`(改) | `PipelineCtx.reserveNodes` 令牌式;`createChildren` 用 try/finally |
| `src/tools/efftask/pipeline.test.ts`(改) | `ctxFor` 与三处 ctx 字面量补新字段 |
| `src/tools/efftask/startupConfirm.ts`(改) | `parallelismLine(config, isolationAvailable)` 单一真相 |
| `src/commands/efftask/ConfirmStartup.tsx`、`ConfirmResume.tsx`(改) | 并行数可编辑;文案改用共享函数 |
| `src/tools/efftask/feishuStartupCard.ts`(改) | 文案改用共享函数 |
| `src/tools/efftask/runAgentAdapter.ts`(改) | 非 execute 阶段剥掉 agent 自带 MCP |

---

### Task 17: 并发调度池(execute 严格串行)

**Files:**
- Create: `src/tools/efftask/scheduler.ts`、`scheduler.test.ts`、`concurrency.test.ts`
- Modify: `orchestrator.ts`、`pipeline.ts`、`pipeline.test.ts`

**Interfaces:**
```ts
export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }
export function createStallTracker(): StallTracker
export type Advanceable = { node: TaskNode; kind: 'start' | 'execute' | 'integrate' }
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): Advanceable[]
// pipeline: 令牌式,结构上杜绝重复释放
export type NodeSlots = { release: () => void }
// PipelineCtx 新增: reserveNodes(count): NodeSlots | null
```

- [ ] **Step 1: 写失败测试 — `scheduler.test.ts`**

```ts
import { describe, expect, it } from 'bun:test'
import { createStallTracker, pickBatch } from './scheduler.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
const tree = (...nodes: TaskNode[]) => ({ nodes, byId: byIdMap(nodes) })

describe('pickBatch selects everything that can move, up to the limit', () => {
  it('returns independent siblings together', () => {
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/a', 'root/b'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
      mk({ id: 'root/b', parentId: 'root', status: 'READY', kind: 'executable' }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5).map(x => x.node.id)).toEqual(['root/a', 'root/b'])
  })

  it('never picks a node whose dependency has not been ACCEPTED', () => {
    // The dependency gate is the point of the tree; concurrency must not widen it.
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: ['root/a', 'root/b'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
      mk({ id: 'root/b', parentId: 'root', status: 'READY', kind: 'executable', deps: ['root/a'] }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5).map(x => x.node.id)).toEqual(['root/a'])
  })

  it('never re-picks a node that is already in flight', () => {
    // Two concurrent steps on ONE node would double its iteration spend and interleave two
    // writes to the same node.md.
    const a = mk({ id: 'a', status: 'READY', kind: 'executable' })
    expect(pickBatch([a], byIdMap([a]), new Set(['a']), 5)).toEqual([])
  })

  it('honours the limit and is deterministic about who goes first', () => {
    const kids = ['root/a', 'root/b', 'root/c'].map(id =>
      mk({ id, parentId: 'root', status: 'READY', kind: 'executable' }))
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'WAITING_CHILDREN', kind: 'decompose', childIds: kids.map(k => k.id) }), ...kids)
    expect(pickBatch(nodes, byId, new Set(), 2).map(x => x.node.id)).toEqual(['root/a', 'root/b'])
    expect(pickBatch(nodes, byId, new Set(), 0)).toEqual([])
  })

  it('skips a node under a BLOCKED ancestor', () => {
    // KNOWN LIMITATION, stated so the test does not imply more than it proves:
    // propagateBlocked only runs at deadlock/abort, so a failed sibling does NOT make the
    // parent BLOCKED mid-run — sibling nodes keep spending real model calls on a doomed
    // subtree. This test covers the post-propagation shape only.
    const { nodes, byId } = tree(
      mk({ id: 'root', status: 'BLOCKED', kind: 'decompose', childIds: ['root/a'] }),
      mk({ id: 'root/a', parentId: 'root', status: 'READY', kind: 'executable' }),
    )
    expect(pickBatch(nodes, byId, new Set(), 5)).toEqual([])
  })
})

describe('the no-progress guard must be PER NODE once work overlaps', () => {
  it('is not reset by another node making progress in between', () => {
    // The serial guard used ONE global "last picked" fingerprint. With N in flight, any
    // other node finishing resets it, so a genuinely stuck node spins forever issuing real
    // model calls — the guard becomes decorative exactly when it is needed.
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

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH"; bun test src/tools/efftask/scheduler.test.ts`
Expected: FAIL — `Cannot find module './scheduler.js'`

- [ ] **Step 3: 实现 `scheduler.ts`**

```ts
import { advanceableKind, isTerminal } from './stateMachine.js'
import type { TaskNode } from './types.js'

export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }

/**
 * Per-node no-progress counter.
 *
 * The serial orchestrator used ONE global fingerprint ("was the same node picked twice in a
 * row?"). That is meaningful only while exactly one node moves at a time: with N in flight,
 * any other node completing resets it, so a node that cannot progress spins forever issuing
 * real model calls. Keyed per node, the guard means the same thing under any concurrency.
 *
 * NOTE this is defence in depth: no current state machine path can actually trigger it
 * (every step leaves its node terminal, or at READY/WAITING_CHILDREN, neither re-pickable in
 * the same status). Don't over-invest — but DO keep it reachable on the rejection path,
 * which is the one way it could ever be needed.
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

export type Advanceable = { node: TaskNode; kind: 'start' | 'execute' | 'integrate' }

/**
 * Everything that can move right now, capped at `limit`.
 *
 * MUST be called and its results dispatched with NO await in between: JavaScript is
 * single-threaded, so an uninterrupted scan-then-dispatch makes the dependency check atomic
 * by construction. Put an await there and a sibling can BLOCK a dependency between the check
 * and the launch, and the node runs against a dead dependency.
 *
 * The return type deliberately excludes null so the caller's dispatch cannot fall through to
 * a runtime "unhandled kind" branch.
 */
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): Advanceable[] {
  if (limit <= 0) return []
  const out: Advanceable[] = []
  // Deterministic order by id — a plain codepoint compare, NOT localeCompare (locale/ICU
  // dependent). KNOWN LIMITATION: with real providers, which node finishes first is
  // latency-dependent, so the ORDER OF ADVANCEMENT (and hence which node loses a maxNodes
  // race) is not reproducible run to run even though this scan is.
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const n of ordered) {
    if (out.length >= limit) break
    if (inFlight.has(n.id)) continue // one step per node: two would double-spend its budget
    if (isTerminal(n.status)) continue
    if (hasBlockedAncestor(n, byId)) continue
    const kind = advanceableKind(n, byId)
    if (kind !== null) out.push({ node: n, kind })
  }
  return out
}
```
把 `orchestrator.ts` 里私有的 `hasBlockedAncestor` 删掉改用这里的,避免两份定义漂移。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/tools/efftask/scheduler.test.ts` — Expected: PASS

- [ ] **Step 5: 写失败测试 — 额度令牌(`pipeline.test.ts`)**

先把 `ctxFor` 补上新字段(否则所有走 decompose 的既有测试会以 `ctx.reserveNodes is not a function` 崩溃 —— 本仓库无类型检查,只会在跑测时才炸):

```ts
// pipeline.test.ts 的 ctxFor,以及 293/320/335 三处 ctx 字面量,都要加:
  reserveNodes: (count: number) => ({ release: () => {} }),
```

然后追加:

```ts
it('two concurrent decompositions cannot together exceed maxNodes', async () => {
  // check-then-act: createChildren compares byId.size against the cap, then awaits persist,
  // and only afterwards inserts. Two nodes decomposing at once both measure the same stale
  // size, both pass, and the tree ends over the cap — the safety valve silently off.
  // maxNodes = 5 (NOT 4): root+a+b already exist, so exactly ONE batch of 2 can fit.
  const ctx = ctxForConcurrent({ maxNodes: 5 })
  const results = await Promise.all([
    exportedCreateChildren(ctx.byId.get('a')!, [{ title: 'a1', deps: [] }, { title: 'a2', deps: [] }], ctx),
    exportedCreateChildren(ctx.byId.get('b')!, [{ title: 'b1', deps: [] }, { title: 'b2', deps: [] }], ctx),
  ])
  expect(results.filter(r => r.ok)).toHaveLength(1)
  expect(ctx.byId.size).toBeLessThanOrEqual(5)
})

it('a THROW inside createChildren does not leak reserved slots', async () => {
  // After the reserve, createChildren calls RAW ctx.now() (not nowSafe) inside the specs.map
  // that mints the children. That is a fifth exit path, and a leak permanently overstates
  // the tree — so a LATER decomposition that genuinely fits is refused and BLOCKED. The
  // safety valve corrupted in the other direction, silently.
  let calls = 0
  const ctx = ctxForConcurrent({ maxNodes: 50, now: () => { if (++calls >= 4) throw new Error('clock died'); return NOW } })
  await exportedCreateChildren(ctx.byId.get('a')!, [{ title: 'x', deps: [] }], ctx).catch(() => {})
  expect(ctx.reservedCount()).toBe(0)
})
```
(`createChildren` 需要导出;`ctxForConcurrent` 是本文件新增的辅助,构造 root+a+b 与真实的令牌实现,并暴露 `reservedCount()`。)

- [ ] **Step 6: 跑红 → 实现令牌式预留**

`PipelineCtx` 新增(orchestrator 提供):

```ts
  /**
   * Claim `count` node slots, or return null. SYNCHRONOUS: the cap check and the claim must
   * not be separated by an await, or two concurrent decompositions both measure the same
   * stale count and both pass.
   *
   * Returns a TOKEN rather than a boolean so release is structurally single-shot and pairs
   * with try/finally. A plain releaseNodes(count) invites double-release, and clamping that
   * at zero would silently UNDER-enforce maxNodes instead of failing loudly.
   */
  reserveNodes: (count: number) => { release: () => void } | null
```

orchestrator:

```ts
  private reserved = 0
  private reserveNodes = (count: number): { release: () => void } | null => {
    if (this.byId.size + this.reserved + count > this.cfg.caps.maxNodes) return null
    this.reserved += count
    let released = false
    return { release: () => { if (released) return; released = true; this.reserved -= count } }
  }
```

`createChildren` 改为:

```ts
  const slots = ctx.reserveNodes(specs.length)
  if (!slots) return { ok: false, reason: '节点数超过上限', retryable: false }
  try {
    … 原有全部逻辑,包括 duplicate-title / hasCycle / persist 失败的提前返回 …
  } finally {
    // Unconditional: once the children are in byId they are counted by byId.size, and every
    // other exit — including a THROW from the raw ctx.now() inside specs.map — must give the
    // slots back. Per-return-path release misses the throw.
    slots.release()
  }
```

- [ ] **Step 7: 跑绿(含全部既有 pipeline 测试)**

- [ ] **Step 8: 写失败测试 — `concurrency.test.ts`,断言时序本身**

> 这是本任务最重要的一步。v1 的教训:16 条既有测试对着同时具备"互斥失效/进程挂死/额度泄漏"的实现全绿。下面每条断言都必须观测**峰值并发**或**事件先后**,而不是最终状态。

```ts
import { describe, expect, it } from 'bun:test'
import { EffTaskOrchestrator } from './orchestrator.js'
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, type EffTaskConfig, type TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const tick = (ms = 5): Promise<void> => new Promise(r => setTimeout(r, ms))
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({
  goalPrompt: '目标', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(),
  caps: { ...DEFAULT_CAPS }, notices: [], ...over,
})
const deps = (runAgent: RunAgentFn) => ({
  runAgent, persist: async () => {}, now: () => new Date().toISOString(), onUpdate: () => {},
})
// Answers the per-call nonce tag; a reply that omits it is rejected fail-closed.
const reply = (req: { phase: string; prompt: string }, body: string): string => {
  const tag = req.prompt.match(/必须是一个 ```([a-zA-Z]+) 代码块/)?.[1] ?? ''
  return '```' + tag + '\n' + body + '\n```'
}
const THREE_LEAVES = '{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a",' +
  '"children":[{"title":"甲","deps":[]},{"title":"乙","deps":[]},{"title":"丙","deps":[]}]}'
const LEAF = '{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"a"}'

/** Records peak simultaneous calls per phase — the only thing that can see a broken mutex. */
function phaseMeter() {
  const cur: Record<string, number> = {}
  const peak: Record<string, number> = {}
  return {
    peak,
    async around<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      cur[phase] = (cur[phase] ?? 0) + 1
      peak[phase] = Math.max(peak[phase] ?? 0, cur[phase])
      try { return await fn() } finally { cur[phase]-- }
    },
  }
}

describe('the pool parallelises the read-only phases', () => {
  it('runs review roundtables for different nodes at the same time', async () => {
    const m = phaseMeter()
    let planned = false
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 5 }), deps(async (req: any) =>
      m.around(req.phase, async () => {
        await tick()
        if (req.phase === 'plan') { const first = !planned; planned = true; return reply(req, first ? THREE_LEAVES : LEAF) }
        return reply(req, req.phase === 'execute' ? '{"execStatus":"done"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
      })), new AbortController().signal)
    await orch.run()
    expect(m.peak.plan).toBeGreaterThan(1) // three leaves plan concurrently
  })

  it('NEVER runs two executors at once — that would overwrite work in one tree', async () => {
    // The single most important assertion in this phase. v1's mutex chained an
    // ALREADY-STARTED promise, so this measured 3. Both executors would report success.
    const m = phaseMeter()
    let planned = false
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 5 }), deps(async (req: any) =>
      m.around(req.phase, async () => {
        await tick(15)
        if (req.phase === 'plan') { const first = !planned; planned = true; return reply(req, first ? THREE_LEAVES : LEAF) }
        return reply(req, req.phase === 'execute' ? '{"execStatus":"done"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
      })), new AbortController().signal)
    await orch.run()
    expect(m.peak.execute).toBe(1)
  })

  it('a serialised execute queue does not starve the pool', async () => {
    // Queued-not-started executes must NOT be charged against the concurrency budget, or a
    // tree with more ready executables than `parallelism` never advances anything else.
    const m = phaseMeter()
    let planned = false
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 2 }), deps(async (req: any) =>
      m.around(req.phase, async () => {
        await tick(10)
        if (req.phase === 'plan') { const first = !planned; planned = true; return reply(req, first ? THREE_LEAVES : LEAF) }
        return reply(req, req.phase === 'execute' ? '{"execStatus":"done"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
      })), new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('completed')
    expect(m.peak.execute).toBe(1)
  })

  it('never exceeds the configured limit', async () => {
    const m = phaseMeter()
    let planned = false
    let peakAny = 0, curAny = 0
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 2 }), deps(async (req: any) => {
      curAny++; peakAny = Math.max(peakAny, curAny)
      try {
        return await m.around(req.phase, async () => {
          await tick()
          if (req.phase === 'plan') { const first = !planned; planned = true; return reply(req, first ? THREE_LEAVES : LEAF) }
          return reply(req, req.phase === 'execute' ? '{"execStatus":"done"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
        })
      } finally { curAny-- }
    }), new AbortController().signal)
    await orch.run()
    expect(peakAny).toBeLessThanOrEqual(2)
  })
})

describe('a failing step must not take the run down with it', () => {
  it('a rejecting step leaves its node terminal and the run still answers', async () => {
    // runStep must absorb its own errors: if it rejects, the serial loop's terminal-drive is
    // lost and run() returns a verdict that contradicts the persisted tree.
    let n = 0
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), deps(async (req: any) => {
      if (++n === 2) throw new Error('provider exploded')
      return reply(req, req.phase === 'plan' ? LEAF : req.phase === 'execute' ? '{"execStatus":"d"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
    }), new AbortController().signal)
    const res = await orch.run()
    expect(['completed', 'blocked']).toContain(res.status)
    for (const node of orch.nodes()) expect(['ACCEPTED', 'BLOCKED']).toContain(node.status)
  })

  it('a rejecting step does not poison the execute chain into a busy-loop', async () => {
    // A rejected task permanently poisons executeChain: every later .then rejects
    // immediately, so Promise.race returns within a microtask forever. Measured: 200,000
    // iterations while a pending 30 ms timer NEVER fired — no I/O, no timers, process hung.
    // The detector is a timer: if the loop starves the macrotask queue, it never fires.
    let timerFired = false
    setTimeout(() => { timerFired = true }, 30)
    let n = 0
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), deps(async (req: any) => {
      if (req.phase === 'execute' && ++n === 1) throw new Error('boom')
      await tick()
      return reply(req, req.phase === 'plan' ? LEAF : req.phase === 'execute' ? '{"execStatus":"d"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
    }), new AbortController().signal)
    await orch.run()
    expect(timerFired).toBe(true)
  })
})

describe('an interrupt must not declare a verdict while work is still landing', () => {
  it('no node is persisted after the interrupt sweep', async () => {
    // propagateBlocked(true) sweeps and returns. A step still running commits AFTER the
    // sweep, leaving a node that is neither terminal nor being advanced while run() has
    // already reported. Abort while a SLOW NON-ROOT step is in flight — aborting on the
    // first call (when root is the only node) exercises no concurrency at all.
    const ac = new AbortController()
    const order: string[] = []
    let planned = false
    let sweepSeen = false
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 3 }), {
      runAgent: (async (req: any) => {
        if (req.phase === 'plan' && planned) { ac.abort(); await tick(25) } // die mid-flight, not at t0
        if (req.phase === 'plan') planned = true
        return reply(req, planned ? LEAF : THREE_LEAVES)
      }) as any,
      persist: async (n: TaskNode) => {
        if (n.interrupted === true) sweepSeen = true
        else if (sweepSeen) order.push(`AFTER_SWEEP:${n.id}`)
      },
      now: () => new Date().toISOString(),
      onUpdate: () => {},
    }, ac.signal)
    const res = await orch.run()
    expect(res).toEqual({ status: 'blocked', reason: '已中断' })
    expect(order).toEqual([]) // nothing persisted after the sweep began
    for (const n of orch.nodes()) expect(n.status).toBe('BLOCKED')
  })
})

describe('parallelism = 1 reproduces the serial implementation exactly', () => {
  it('advances one node at a time', async () => {
    let peak = 0, cur = 0
    let planned = false
    const orch = new EffTaskOrchestrator(cfg({ parallelism: 1 }), deps(async (req: any) => {
      cur++; peak = Math.max(peak, cur)
      try {
        await tick()
        if (req.phase === 'plan') { const first = !planned; planned = true; return reply(req, first ? THREE_LEAVES : LEAF) }
        return reply(req, req.phase === 'execute' ? '{"execStatus":"d"}' : '{"pass":true,"blocking":[],"comments":"ok"}')
      } finally { cur-- }
    }), new AbortController().signal)
    expect((await orch.run()).status).toBe('completed')
    expect(peak).toBe(1)
  })
})
```

- [ ] **Step 9: 跑测试确认失败(此时 orchestrator 仍是串行,并行断言必红)**

- [ ] **Step 10: 实现并发池**

```ts
  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    const stalls = createStallTracker()
    /** node id → its pending task. Used ONLY for dedup: a queued execute is here but not yet running. */
    const inFlight = new Map<string, Promise<void>>()
    /** Steps that have actually STARTED. The pool budget is charged against this, not
     *  inFlight: a queued-not-started execute holds no resource, and charging it would let a
     *  tree with more ready executables than `parallelism` starve every other phase. */
    let running = 0
    // execute is STRICTLY serial in P2a: it is the only phase with write-capable tools, and
    // two executors in one working tree overwrite each other while both report success.
    // The start is deferred ONTO the chain — chaining an already-started promise serialises
    // only the waiting (measured peak 3 when done wrong).
    // `.catch` on the LINK, not the task: one rejection would otherwise poison every later
    // link, making Promise.race resolve in a microtask forever (measured: a 30 ms timer
    // never fired across 200k iterations).
    let executeChain: Promise<void> = Promise.resolve()

    const launch = (n: TaskNode, kind: Advanceable['kind']): Promise<void> => {
      const before = n.status
      const step = async (): Promise<void> => {
        running++
        try {
          await this.runStep(n, kind) // never rejects; see runStep
        } finally {
          running--
        }
        // Bookkeeping AFTER the step, on a path a failure also reaches (runStep absorbs its
        // own errors, so this always runs).
        if (n.status !== before) { stalls.clear(n.id); return }
        if (stalls.note(n.id, n.status) >= 2) {
          n.status = 'BLOCKED'
          n.blockedReason = n.blockedReason || '节点未能推进(状态未变化),已阻断以避免空转'
          // Mark it interrupted when the run is aborting, or resume will refuse to reopen it.
          n.interrupted = this.signal.aborted
          n.updatedAt = this.nowSafe()
          await this.safePersist(n)
          this.safeUpdate()
        }
      }
      const task = kind === 'execute'
        ? (executeChain = executeChain.then(step, step)) // absorb + serialise the START
        : step()
      return task.finally(() => { inFlight.delete(n.id) })
    }

    for (;;) {
      const root = this.byId.get('root')!
      if (root.status === 'ACCEPTED') { await this.settleAll(inFlight); return { status: 'completed' } }
      if (this.signal.aborted) {
        // Wait FIRST: a step committing after the sweep would leave a non-terminal node in a
        // tree we already declared finished.
        await this.settleAll(inFlight)
        // Completion wins over abort — re-check, the tree may have finished while we waited.
        if (this.byId.get('root')!.status === 'ACCEPTED') return { status: 'completed' }
        await this.propagateBlocked(true)
        return { status: 'blocked', reason: '已中断' }
      }

      const budget = Math.max(1, this.cfg.parallelism) - running
      // NO await between pickBatch and dispatch — that is what makes the dependency check
      // atomic (see pickBatch's contract).
      const batch = pickBatch(this.nodes(), this.byId, new Set(inFlight.keys()), budget)
      for (const { node, kind } of batch) inFlight.set(node.id, launch(node, kind))

      if (inFlight.size === 0) {
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      await Promise.race([...inFlight.values()]).catch(() => {})
    }
  }

  private async settleAll(inFlight: Map<string, Promise<void>>): Promise<void> {
    await Promise.allSettled([...inFlight.values()])
  }

  /**
   * One advancement step. NEVER REJECTS — it absorbs its own errors and drives the node to a
   * terminal state, exactly as the serial loop's try/catch did. A rejection here would lose
   * that terminal-drive AND poison the execute chain.
   */
  private async runStep(next: TaskNode, kind: Advanceable['kind']): Promise<void> {
    const ctx = this.ctx()
    try {
      if (kind === 'start') await stepStart(next, ctx)
      else if (kind === 'execute') await stepExecute(next, ctx)
      else await stepIntegrate(next, ctx)
    } catch (e) {
      // Reachable in practice via a transient deps.now() failure inside commit().
      const message = e instanceof Error ? e.message : String(e)
      const subtreeAlive =
        next.status === 'WAITING_CHILDREN' &&
        next.childIds.length > 0 &&
        next.childIds.some(id => { const c = this.byId.get(id); return c !== undefined && !isTerminal(c.status) })
      if (!subtreeAlive) {
        next.status = 'BLOCKED'
        next.blockedReason = message
        next.interrupted = this.signal.aborted
      }
      next.updatedAt = this.nowSafe()
      await this.safePersist(next)
      this.safeUpdate()
    }
  }
```

并在 `propagateBlocked` 上方补一条注释,把此前无人写下的承重不变式记下来:

```ts
  // INVARIANT: callers must have settled every in-flight step first. This awaits inside a
  // LIVE `for (const n of this.byId.values())` iterator, so a concurrent createChildren
  // inserting mid-sweep would be visited (or not) unpredictably.
```

- [ ] **Step 11: 跑绿 + 全量**

Run: `bun test`
Expected: 全绿。既有 16 条编排器测试必须仍绿——但**它们不是并发正确性的证据**,`concurrency.test.ts` 才是。

- [ ] **Step 12: 变异验证(必做,逐条)**

| 把实现改成 | 应当变红的断言 |
|---|---|
| `executeChain = executeChain.then(() => task)`(v1 写法,先启动再链) | `peak.execute` 为 1 那条 |
| 预算改为 `limit - inFlight.size` | 不饿死并发池那条 |
| `runStep` 去掉 try/catch | 拒绝步骤留下终态那条 |
| 链上 `.catch` 改为只在 task 上 | 30ms 定时器那条 |
| `slots.release()` 从 finally 移到各 return 分支 | 额度泄漏那条 |
| 中断分支去掉 `settleAll` | 扫描后提交那条 |

任何一条**没有**变红,说明该断言测不到它声称测的东西——按 v1 的教训,这正是最危险的情况。

- [ ] **Step 13: 提交**

```bash
git commit -m "feat(efftask): 并发调度池(execute 严格串行)、每节点无进展守卫、节点额度令牌"
```

---

### Task 18: 并行数可由用户在关口修改(用户第四句)

用户原话:"各任务执行可以并行,**默认5个**,需求提示词可指定,**可跟用户确认修改**。" 前三句 P1 已交付(`parseDirectives` 抽取 parallelism、`StartupDecision.parallelism` 是活接缝);第四句从未实现:`ConfirmStartup.tsx:8-9` 两个分支都原样回传 `props.config.parallelism`,飞书卡片注释直言 `the card has no inline editor in P1`。

**Files:** `startupConfirm.ts`、`ConfirmStartup.tsx`、`ConfirmResume.tsx`、`feishuStartupCard.ts` + 测试

- [ ] **Step 1-2:** 写失败测试(通过 **vendored 渲染器**挂载,理由见 `ConfirmStartup.test.tsx` 头部注释):按 `←/→` 或 `+/-` 调整并行数,回车后 `onDecision` 带出**修改后**的值;边界 1..64 不可越界;`Esc` 取消时不改。跑红。
- [ ] **Step 3-4:** 实现。`ConfirmStartup` 与 `ConfirmResume` 共用一个受控的数字选择器组件。
- [ ] **Step 5:** 文案统一。**三处**硬编码的"（P1 串行执行,此值 P2 生效）"必须一起改,且改用 `startupConfirm.ts` 里的单一函数生成——两个终端界面加飞书卡片:
  - `src/commands/efftask/ConfirmStartup.tsx:15`
  - `src/commands/efftask/ConfirmResume.tsx:33`
  - `src/tools/efftask/feishuStartupCard.ts:33`(措辞还与前两者不同)
  P2a 的真实状态是:`并行数: N（非写阶段并行;执行阶段串行,隔离能力见 P2b）`。
- [ ] **Step 6:** 飞书卡片本期**不做**内联编辑器(卡片交互只有按钮),但必须显示终端可改这件事,而不是让飞书审批者以为值不可变。
- [ ] **Step 7:** 提交。

---

### Task 19: 堵上 MCP 绕过只读闸门(P1 遗留项 1)

`runAgentAdapter` 按阶段限制工具池,但 `runAgent.ts:670-673` 在过滤之后又并入 `agentMcpTools`。把声明了 `mcpServers` 的自定义 agent 绑成 `review`/`accept`,这个"评审员"就拿到了自己的、可能可写的 MCP 工具,能自己改好再放行。

**评审已验证:方案 (a)「设 `disallowedTools`」是无效修法** —— `disallowedTools` 只在 `resolveAgentTools`(`agentToolUtils.ts:150-160`)内被消费,应用于 `runAgent.ts:509-511`,而 MCP 合并发生在其**之后**且从不经过它;`filterToolsForAgent` 对任何 `mcp__*` 名字还无条件返回 true。写出来会是一个亮绿灯的空修法。

**采用第三方案(评审建议,代价最小):** 在 `makeRunAgentFn` 里,非 execute 阶段传 `{...agentDefinition, mcpServers: undefined}`。
- 调用方一侧,对 AgentTool 的其他调用者**零影响**(不像方案 b 会改 `runAgent` 对所有人的契约);
- `initializeAgentMcpServers` 在 `mcpServers` 为空时提前返回 `tools: []`(`runAgent.ts:103-110`),口子被完全堵住;
- 额外收益:不再为一个只读评审员拉起任意 MCP 服务进程。

**必须在提交信息里如实写明的代价与边界**(不要夸大战果):
- 该修法同时也剥夺了评审员的**只读** MCP 工具;
- 今天的实际严重性被 `canUseTool`(`efftask.tsx:104`)的提示所缓和 —— 完全无声的自我放行要在 `bypassPermissions` 或该 MCP 工具已在允许列表中时才成立。

- [ ] **Step 1:** 写失败测试。**注意接缝**:MCP 合并在真 `runAgent` 内部,而 `makeRunAgentFn` 通过 `runAgentImpl` 注入假实现,假实现不执行那段合并 —— 断言"最终 availableTools 无可写工具"在**未修复的代码上就是绿的**。正确断言对象是**传给 `runAgentImpl` 的 `agentDefinition`**:非 execute 阶段其 `mcpServers` 必须为 undefined,execute 阶段必须原样保留。
- [ ] **Step 2-4:** 跑红 → 实现 → 跑绿。
- [ ] **Step 5:** 提交。

---

## Self-Review

- 用户第四句「可跟用户确认修改」→ Task 18。
- P1 遗留项 1(MCP 绕过)→ Task 19,且已排除被验证无效的修法。
- **本期明确不做,且不假装做了**:
  - worktree 隔离与 `execute` 并行 → P2b,需重新设计后单独成文(v1 在此处有 slug 非法、合并丢工作、验收看不见工作、绝对路径穿透隔离等 14 条阻断)。
  - spec §8 的集成分支、冲突自动解决、飞书升级卡、收口(finishing-a-development-branch)→ 同属 P2b。
  - P1 遗留项 4(确认竞速原语重复):Task 18 会新增关口交互,是抽取共用原语的合适时机,但本期不强制;若 P2b 再加关口则必须先抽。
  - P1 遗留项 5(`run.md` 全量重写):并发下写入更频繁,但已被 promise 队列串行化,是浪费不是错误 → P3。
  - P1 交接清单里仍未排期、登记在此以免再次遗失:
    - 「启动第 3 关(根方案预览/编辑)」
    - 「后台任务注册 + /tasks 可见性」
    - 「安全阀触发的飞书升级卡」
    - 「飞书推进 surface 完整接线」—— 已核实未实现:efftask 的飞书只有启动/恢复确认卡,
      运行期没有任何进度推送
    - 「跨分支依赖调度」
    (后两项此前只存活在被标 ⛔ 不可实施的 p2.md 里,那不算登记处。)
  - **确认关口的并行数编辑与飞书竞速之间没有通道**:终端用户调到 9 但未回车、飞书审批者
    先点「开始」,则那次编辑被静默丢弃(`efftask.tsx` 在开关口时快照 config)。已在代码
    注释中登记,修复留待抽取共用确认原语时一并处理。
- **已知局限(写进代码注释,不隐瞒)**:
  - 兄弟节点失败不会即时阻断同层其他节点(`propagateBlocked` 只在死锁/中断时跑),因此注定失败的子树仍会继续烧模型调用;并发放大了这个浪费。
  - 有真实延迟时,推进顺序与"谁输掉 maxNodes 竞争"都不可复现。
  - 墙钟上限按**每次调用**生效,而串行链锁住的是整个 `execute → accept → rework` 循环。
    所以一个卡住的节点阻塞的不是"池里的一个名额",而是**全树的执行与叶子验收**;最坏时长
    约 `maxIterations ×(execute + accept)× nodeTimeoutMs`,按默认值(3 轮、600s)量级在
    一小时以上。这是 P2b 隔离落地前的固有代价。
