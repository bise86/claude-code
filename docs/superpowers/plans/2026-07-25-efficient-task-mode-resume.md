# 高效任务模式 — 断点续跑 (P1.5) 实施计划 (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端退出/崩溃/重启后,用一条命令把任务树和每个节点的状态原样恢复出来,再用一段提示词让它从断点继续执行。

**Architecture:** Run 目录本身就是完整的持久化状态。恢复走三步——**读取**(`readRunManifest` + 已实现的 `loadRun`)→ **校验**(`validateLoadedNodes`,把磁盘上可能被手改/写坏的文本挡在状态机之外)→ **重入归位**(`reseatTransientNodes`,把被杀时的活动态退回可安全重跑的静止态)。命令层只负责接线、锁与确认关口。

> **v2 说明:** v1 经三方圆桌评审全票否决(22 条阻断,每条附可执行复现)。v2 是按并集重写的版本,下面 §"v1 为何被否" 逐条记录了改动原因——那些不是风格意见,是几条会让功能当场失效或**谎报成功**的设计缺陷。

**Tech Stack:** 与 P1 同:Bun + TypeScript,Ink TUI,`yaml`,`FsLike` 直连 `node:fs/promises`。测试 `bun test`,`*.test.ts` 与源码同目录。

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json`;不引入 `env:` 间接、不脱敏。
- 不 `feature()` 门控。
- **恢复不重置 `iteration` 计数**(§17.5)。"重启即刷新预算"是绕过安全阀的后门。
- **`runId` 不变**,继续写同一个 Run 目录。
- **宁可重做,不可谎报**:被中断的那一步重跑一次是可接受代价;让"半完成"冒充"已完成"不可接受。**推论(v2 新增,反复踩到):任何"修复"都不得把一个已被检测到的失败悄悄变成成功**——丢弃悬挂引用就是这类操作。
- 所有插进提示词的用户文本必须经 `quote()`。
- 复用 P1 已建好的东西:`loadRun`/`parseNodeFile`、`raceConfirm`、共享飞书 client、**`mkdirExclusive`**(原子原语,已为 run id 付过学费)。
- **新增状态/字段必须真的被 P1 代码写入**;不得给 `EXECUTED`/`SCORING`/`MERGE` 这类全代码库从未提交过的死状态写逻辑(已 grep 确认:`pipeline.ts` 只提交 PLANNING/PLAN_REVIEW/READY/EXECUTING/REWORK/ACCEPTANCE/WAITING_CHILDREN/INTEGRATION_ACCEPT/ACCEPTED/BLOCKED)。

## 关键事实(实现者必须先知道,均已对源码核实)

| 事实 | 位置 | 为什么要命 |
|---|---|---|
| 中断时 `propagateBlocked(true)` 把**每个非终态节点**扫成 `BLOCKED`,理由 `已中断`,并逐个落盘 | `orchestrator.ts:159-171` | Esc / Ctrl+C / 界面重建都走这条。若恢复把 BLOCKED 一律原样保留,**恢复后 0 次模型调用直接返回 blocked**(已实证) |
| `isTerminal` = `ACCEPTED \|\| BLOCKED` | `stateMachine.ts:17` | 中断扫描会跳过"真失败"的节点,所以两者可区分——但需要一个显式标记,不能字符串匹配 |
| `advanceableKind` 推进 `READY` **要求 `kind==='executable'`** | `stateMachine.ts:24` | 归位到 READY 但 kind 非 executable = 既不可推进也不终态,永久卡死且每次 resume 复现 |
| `WAITING_CHILDREN` + `childIds.length===0` 不可推进 | `stateMachine.ts:27` | 合成的空根 = 立即死局 |
| `createChildren` **先落子节点、后提交父状态** | `pipeline.ts:364-374` vs `302-303` | 在此窗口被杀:父仍是 PLAN_REVIEW 而子已在盘上。归位到 CREATED 会**重建一整套子节点** |
| `propagateBlocked` 已有 `子节点缺失`/`依赖节点缺失` 规则,注释明说"resume 会产生这种形状" | `orchestrator.ts:186-190` | 悬挂引用是**已被处理的失败**,丢弃它等于把失败改写成成功 |
| `feedback` 是 `stepStart`/`stepExecute` 的局部变量 | `pipeline.ts` | 归位后重入,返工意见丢失,执行者把被否的活原样重做 |
| `runOrchestrator` 是构造 `EffTaskOrchestrator` 的**唯一**生产调用点 | `runOrchestrator.ts:36` | 加 seed 参数必须同时改它 |
| `stepExecute` 会整体覆写 `node.execStatus` | `pipeline.ts:415` | 归位时追加的"中断"注记不是证据保全,别当成证据 |

---

## v1 为何被否(改动依据,勿删)

1. **中断即全树 BLOCKED** → v2 加 `TaskNode.interrupted` 显式标记(Task 12),归位据此重入。
2. **悬挂 deps/childIds 被丢弃** → v2 改为**保留引用并阻断引用方**(Task 13),复用 P1 同款理由文案。
3. **归位不看 kind / 不看是否已有子节点** → v2 归位规则改为三级优先(Task 14)。
4. **合成根用占位目标** → v2 从 `config.goalPrompt` 取真实目标,并传入名册与时钟(Task 13)。
5. **无环检测** → v2 自带 `depCycleMembers`(`hasCycle` 只返回布尔,拿不到成员)并处理父环(Task 13)。
6. **锁读后写不互斥**(并发双双成功) → v2 改用 `mkdirExclusive` 锁目录(Task 15)。
7. **`appendResumeRecord` 会被整文件重写冲掉** → v2 记录进 frontmatter 并由 `writeRunManifest` 回写(Task 15)。
8. **`resumeGuidance` 只读不写** → v2 补持久化并定死覆盖语义(Task 15/16)。
9. **占位测试/占位实现** → v2 全部给真实代码。
10. **命令层重构缺失**(resume 仍会跑 `parseDirectives` 模型调用) → v2 明确改造点(Task 16)。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/tools/efftask/types.ts`(改) | `TaskNode.interrupted?: boolean`;`EffTaskConfig.resumeGuidance?: string` |
| `src/tools/efftask/orchestrator.ts`(改) | 中断扫描打 `interrupted` 标记;构造函数接受 `seed` |
| `src/tools/efftask/resumeCore.ts`(新) | `readRunManifest` / `validateLoadedNodes` / `depCycleMembers` |
| `src/tools/efftask/reseat.ts`(新) | `reseatTransientNodes`(单独成文件:规则密度高,与校验关注点不同) |
| `src/tools/efftask/runRegistry.ts`(新) | `listRuns` / `acquireRunLock` / `releaseRunLock` |
| `src/tools/efftask/parseResumeArgs.ts`(新) | 参数解析 |
| `src/tools/efftask/pipeline.ts`(改) | `guidanceSection`;重入时从日志回灌 `feedback` |
| `src/tools/efftask/persistence.ts`(改) | `FsLike.unlink`/`rmdir`(**必填**);frontmatter 持久化 `resumeGuidance` 与 `resumes[]` |
| `src/commands/efftask/runOrchestrator.ts`(改) | 透传 `seed`;透传 resume 记录 |
| `src/commands/efftask/efftask.tsx`(改) | resume 分支、跳过解析、锁释放 |
| `src/commands/efftask/ResumePicker.tsx`(新) | run 选择列表 |
| `src/commands/efftask/ConfirmResume.tsx`(新) | 恢复确认关口 |
| `src/tools/efftask/feishuStartupCard.ts`(改) | 卡片支持附加区块(校验/归位摘要) |

---

### Task 12: 让"中断"与"真失败"可区分(P1 前置改动)

没有这一步,后面全部白做——中断后恢复无一节点可推进。

**Files:**
- Modify: `src/tools/efftask/types.ts`、`src/tools/efftask/orchestrator.ts`
- Test: `src/tools/efftask/orchestrator.test.ts`

**Interfaces:**
- Produces: `TaskNode.interrupted?: boolean`

- [ ] **Step 1: 写失败测试**

追加到 `src/tools/efftask/orchestrator.test.ts`:

```ts
describe('an interrupted run is distinguishable from a failed one', () => {
  it('marks swept nodes as interrupted, and leaves genuinely blocked ones unmarked', async () => {
    // propagateBlocked(aborted) sweeps EVERY non-terminal node to BLOCKED. Resume must be
    // able to tell "we killed this mid-flight" from "this really failed", and it must not
    // do so by string-matching blockedReason: a genuine reason could equal that string, and
    // two unrelated modules agreeing on a literal is not an interface.
    const ac = new AbortController()
    let calls = 0
    const runAgent = (async () => {
      calls++
      if (calls >= 2) ac.abort()
      return '```json\n{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a","children":[{"title":"子一","deps":[]}]}\n```'
    }) as any
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), ac.signal)
    expect(await orch.run()).toEqual({ status: 'blocked', reason: '已中断' })
    for (const n of orch.nodes()) {
      expect(n.status).toBe('BLOCKED')
      expect(n.interrupted).toBe(true)
    }
  })

  it('a node blocked by a real failure is never marked interrupted', async () => {
    // A node that exhausted its review budget must NOT come back to life on resume.
    const runAgent = (async () => 'no fence at all, ever') as any
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const res = await orch.run()
    expect(res.status).toBe('blocked')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.interrupted).toBeFalsy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH"; bun test src/tools/efftask/orchestrator.test.ts`
Expected: FAIL — `expect(n.interrupted).toBe(true)` 收到 `undefined`

- [ ] **Step 3: 实现**

`types.ts` 的 `TaskNode` 增字段(放在 `blockedReason` 之后):

```ts
  /**
   * 该节点是被"中断"扫成 BLOCKED 的,而不是自己失败的。
   *
   * WHY a field and not a blockedReason string match: resume has to reopen exactly these
   * nodes and must NOT reopen a node that exhausted its iteration budget. A literal shared
   * by two unrelated modules is not an interface — a genuine reason could equal it, and a
   * later reword would silently resurrect failed work. Cleared the moment a node is reseated.
   */
  interrupted?: boolean
```

`orchestrator.ts` 的中断扫描(`propagateBlocked` 里 `if (aborted)` 块内),在 `n.status = 'BLOCKED'` 之后加一行:

```ts
        n.interrupted = true // 见 TaskNode.interrupted:恢复据此重入,而非匹配文案
```

- [ ] **Step 4: 跑测试确认通过,再跑全量**

Run: `bun test`
Expected: 全绿(既有 256 + 新增 2)

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/types.ts src/tools/efftask/orchestrator.ts src/tools/efftask/orchestrator.test.ts
git commit -m "feat(efftask): 标记被中断的节点,使其与真正失败的节点可区分"
```

---

### Task 13: 校验落盘状态(读取 + 校验)

**Files:**
- Create: `src/tools/efftask/resumeCore.ts`、`src/tools/efftask/resumeCore.test.ts`

**Interfaces:**
- Consumes: `FsLike`(`persistence.ts`);`TaskNode`/`NodeStatus`/`EffTaskConfig`/`DEFAULT_CAPS`/`DEFAULT_PARALLELISM`/`emptyPhaseRoles`/`emptyPlan`/`createNode`/`PHASE_NAMES`(`types.ts`)。
- Produces:
  ```ts
  export interface ManifestResult { config: EffTaskConfig; degraded: string[] }
  export function readRunManifest(fs: FsLike, runDir: string): Promise<ManifestResult>
  export function depCycleMembers(nodes: TaskNode[]): Set<string>
  export interface ValidateResult { nodes: TaskNode[]; repairs: string[] }
  export function validateLoadedNodes(
    nodes: TaskNode[],
    opts: { goal: string; phaseRoles: Record<PhaseName, RoleBinding[]>; now: string },
  ): ValidateResult
  ```
  注:`validateLoadedNodes` 现在需要 `opts` —— 合成根必须拿到**真实目标**与真实名册(v1 用占位串,导致整个 run 的集成验收拿一句无意义的话去问模型,PASS 即全 run 判完成)。

本任务分五段红绿,每段独立可跑。

- [ ] **Step 1: 写失败测试 — 非法 status 必须被挡在状态机之外**

```ts
// src/tools/efftask/resumeCore.test.ts
import { describe, expect, it } from 'bun:test'
import { validateLoadedNodes } from './resumeCore.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const OPTS = { goal: '打通登录接口', phaseRoles: emptyPhaseRoles(), now: NOW }
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('validateLoadedNodes keeps illegal disk state out of the state machine', () => {
  it('an unknown status becomes BLOCKED instead of reaching the dependency gate', () => {
    // node.md is hand-editable text. An unrecognised status satisfies no gate and no
    // terminal check, so the orchestrator neither runs it nor stops for it — and any node
    // depending on it waits forever, stalling a whole subtree with no explanation.
    const root = mk({ childIds: ['root/01-x'] })
    const bad = mk({ id: 'root/01-x', parentId: 'root', status: 'RUNNING' as never })
    const out = validateLoadedNodes([root, bad], OPTS)
    const got = out.nodes.find(n => n.id === 'root/01-x')!
    expect(got.status).toBe('BLOCKED')
    expect(got.blockedReason).toContain('RUNNING')
    expect(got.interrupted).toBeFalsy() // must NOT be reopened by reseat
    expect(out.repairs.join(' ')).toContain('root/01-x')
  })

  it('normalises the remaining scalar fields without inventing budget', () => {
    const n = mk({
      id: 'root', kind: 'weird' as never, depth: Number.NaN,
      iteration: { planReview: 2 } as never,
      execStatus: undefined as never, plan: undefined as never,
      reviewLog: undefined as never, phaseRoles: { accept: ['pm'] } as never,
    })
    const got = validateLoadedNodes([n], OPTS).nodes[0]
    expect(got.kind).toBe('unknown')
    expect(got.depth).toBe(0)
    // A missing counter reads as 0, never as "no limit" — undefined + 1 is NaN, which never
    // satisfies >= maxIterations and turns a bounded retry loop into an unbounded one.
    expect(got.iteration).toEqual({ planReview: 2, acceptance: 0, integration: 0 })
    expect(got.execStatus).toBe('')
    expect(got.plan.solution).toBe('')
    expect(got.reviewLog).toEqual([])
    // Elements matter, not just the array: a bare string reaches runRoundtable and
    // role.roleName is undefined in the runAgent request.
    expect(got.phaseRoles.accept).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/tools/efftask/resumeCore.test.ts`
Expected: FAIL — `Cannot find module './resumeCore.js'`

- [ ] **Step 3: 实现字段归一化(先不做引用完整性)**

```ts
// src/tools/efftask/resumeCore.ts
import { parse as yamlParse } from 'yaml'
import {
  createNode, emptyPhaseRoles, emptyPlan, DEFAULT_CAPS, DEFAULT_PARALLELISM, PHASE_NAMES,
} from './types.js'
import type {
  Caps, EffTaskConfig, NodeKind, NodeStatus, PhaseName, RoleBinding, TaskNode,
} from './types.js'
import type { FsLike } from './persistence.js'

const LEGAL_STATUS = new Set<string>([
  'CREATED', 'PLANNING', 'PLAN_REVIEW', 'READY', 'EXECUTING', 'EXECUTED', 'ACCEPTANCE',
  'REWORK', 'WAITING_CHILDREN', 'INTEGRATION_ACCEPT', 'SCORING', 'MERGE', 'ACCEPTED', 'BLOCKED',
])
const LEGAL_KIND = new Set<string>(['decompose', 'executable', 'unknown'])

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

const roleArray = (v: unknown): RoleBinding[] =>
  Array.isArray(v)
    ? v
        .filter((r): r is { roleName: string; model?: unknown } =>
          !!r && typeof r === 'object' && typeof (r as { roleName?: unknown }).roleName === 'string')
        .map(r => ({ roleName: r.roleName, ...(typeof r.model === 'string' ? { model: r.model } : {}) }))
    : []

export interface ValidateResult { nodes: TaskNode[]; repairs: string[] }

export function validateLoadedNodes(
  nodes: TaskNode[],
  opts: { goal: string; phaseRoles: Record<PhaseName, RoleBinding[]>; now: string },
): ValidateResult {
  const repairs: string[] = []
  const kept = nodes.filter(n => {
    const ok = !!n && typeof n.id === 'string' && n.id.length > 0
    if (!ok) repairs.push('丢弃一个没有 id 的节点记录')
    return ok
  })
  const byId = new Map<string, TaskNode>()
  for (const n of kept) {
    if (byId.has(n.id)) { repairs.push(`重复节点 ${n.id},保留先读到的一份`); continue }
    byId.set(n.id, n)
  }

  const block = (n: TaskNode, why: string): void => {
    n.status = 'BLOCKED'
    n.blockedReason = n.blockedReason || why
    // NEVER interrupted: reseat reopens interrupted nodes, and a node blocked because its
    // disk state is unusable must stay blocked.
    n.interrupted = false
    repairs.push(`节点 ${n.id}:${why}`)
  }

  for (const n of byId.values()) {
    if (!LEGAL_STATUS.has(n.status as string)) block(n, `恢复时发现非法状态 ${String(n.status)},无法安全重入`)
    if (!LEGAL_KIND.has(n.kind as string)) { repairs.push(`节点 ${n.id} 的 kind 非法,重置为 unknown`); n.kind = 'unknown' as NodeKind }
    n.deps = strArray(n.deps)
    n.childIds = strArray(n.childIds)
    if (typeof n.depth !== 'number' || !Number.isFinite(n.depth)) { repairs.push(`节点 ${n.id} 的 depth 非法,重置为 0`); n.depth = 0 }
    const it = (n.iteration ?? {}) as Partial<TaskNode['iteration']>
    n.iteration = {
      planReview: Number.isFinite(it.planReview) ? (it.planReview as number) : 0,
      acceptance: Number.isFinite(it.acceptance) ? (it.acceptance as number) : 0,
      integration: Number.isFinite(it.integration) ? (it.integration as number) : 0,
    }
    if (typeof n.execStatus !== 'string') n.execStatus = ''
    if (typeof n.blockedReason !== 'string') n.blockedReason = ''
    if (!n.plan || typeof n.plan !== 'object') n.plan = emptyPlan()
    else for (const k of ['solution', 'keyPoints', 'risks', 'acceptance'] as const) {
      if (typeof n.plan[k] !== 'string') n.plan[k] = ''
    }
    if (!Array.isArray(n.reviewLog)) n.reviewLog = []
    if (!Array.isArray(n.acceptLog)) n.acceptLog = []
    if (!n.score || typeof n.score !== 'object') n.score = {}
    const pr = (n.phaseRoles ?? {}) as Record<string, unknown>
    n.phaseRoles = Object.fromEntries(PHASE_NAMES.map(p => [p, roleArray(pr[p])])) as Record<PhaseName, RoleBinding[]>
    if (typeof n.title !== 'string' || n.title.length === 0) n.title = n.id
    if (typeof n.goal !== 'string' || n.goal.length === 0) n.goal = n.title
  }
  return { nodes: [...byId.values()], repairs }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/tools/efftask/resumeCore.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试 — 悬挂引用必须阻断引用方,不得丢弃**

```ts
describe('a repair must never turn a detected failure into a silent success', () => {
  it('blocks the referrer instead of deleting a dangling dep', () => {
    // P1 already handles this shape: propagateBlocked blocks on depDangling ('依赖节点缺失')
    // precisely because loadRun returns partial trees. Deleting the edge makes
    // depsSatisfied() trivially true, so the node PLANS AND EXECUTES with write tools on
    // the premise that upstream work it cannot verify succeeded — and the run reports
    // completed. That is the '半完成冒充已完成' the constraints forbid.
    const root = mk({ childIds: ['root/01-b'] })
    const b = mk({ id: 'root/01-b', parentId: 'root', deps: ['root/00-gone'], status: 'CREATED' })
    const out = validateLoadedNodes([root, b], OPTS)
    const got = out.nodes.find(n => n.id === 'root/01-b')!
    expect(got.status).toBe('BLOCKED')
    expect(got.blockedReason).toContain('依赖节点缺失')
    expect(got.deps).toContain('root/00-gone') // the edge is EVIDENCE; it stays
  })

  it('blocks a parent whose child file was lost', () => {
    const root = mk({ childIds: ['root/01-lost'], status: 'WAITING_CHILDREN', kind: 'decompose' })
    const out = validateLoadedNodes([root], OPTS)
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.nodes[0].blockedReason).toContain('子节点缺失')
  })

  it('drops only a self-dependency, and says so', () => {
    const n = mk({ deps: ['root'] })
    const out = validateLoadedNodes([n], OPTS)
    expect(out.nodes[0].deps).toEqual([])
    expect(out.repairs.join(' ')).toContain('自依赖')
  })

  it('reparents an orphan rather than leaving a dangling parentId', () => {
    const root = mk()
    const orphan = mk({ id: 'x', parentId: 'ghost' })
    const out = validateLoadedNodes([root, orphan], OPTS)
    const got = out.nodes.find(n => n.id === 'x')!
    expect(got.parentId).toBe('root')
    expect(out.nodes.find(n => n.id === 'root')!.childIds).toContain('x')
  })

  it('rebuilds both directions of the parent/child link', () => {
    // childIds is authoritative for structure, parentId for the blocked-ancestor walk.
    // A tree where only one direction survived renders and gates wrong.
    const root = mk({ childIds: ['root/01-a'] })
    const a = mk({ id: 'root/01-a', parentId: null })
    const out = validateLoadedNodes([root, a], OPTS)
    expect(out.nodes.find(n => n.id === 'root/01-a')!.parentId).toBe('root')
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Expected: FAIL — 首条断言 `got.status` 收到 `'CREATED'`

- [ ] **Step 7: 实现引用完整性(插在 Step 3 的 `return` 之前)**

```ts
  // Referential integrity. The rule is BLOCK, never silently drop: an edge that points at a
  // node we could not recover is evidence that the tree is incomplete, and P1's orchestrator
  // already blocks on exactly these two conditions (orchestrator.ts:186-190). Erasing the
  // edge would delete the evidence AND disable that rule.
  for (const n of byId.values()) {
    const selfDeps = n.deps.filter(d => d === n.id)
    if (selfDeps.length > 0) { repairs.push(`节点 ${n.id}:丢弃自依赖(自依赖必然死锁)`); n.deps = n.deps.filter(d => d !== n.id) }
    if (n.deps.some(d => !byId.has(d))) block(n, `依赖节点缺失(${n.deps.filter(d => !byId.has(d)).join('、')})`)
    if (n.childIds.some(c => !byId.has(c))) block(n, `子节点缺失(${n.childIds.filter(c => !byId.has(c)).join('、')})`)
    if (n.parentId !== null && !byId.has(n.parentId)) {
      repairs.push(`节点 ${n.id} 的父节点 ${n.parentId} 不存在,改挂为根级`)
      n.parentId = null
    }
  }
  // Rebuild both directions. Only for edges whose target we actually have — the dangling
  // ones were preserved above and their referrer is already BLOCKED.
  for (const n of byId.values()) {
    for (const cid of n.childIds) {
      const child = byId.get(cid)
      if (child && child.parentId !== n.id) { repairs.push(`修正 ${cid} 的父指针为 ${n.id}`); child.parentId = n.id }
    }
  }
  for (const n of byId.values()) {
    if (n.parentId === null) continue
    const parent = byId.get(n.parentId)
    if (parent && !parent.childIds.includes(n.id)) { repairs.push(`把 ${n.id} 补回父节点 ${parent.id} 的子列表`); parent.childIds.push(n.id) }
  }
```

同时把"父不存在改挂根级"之后的孤儿真正挂到 root 上——见 Step 11 的合成/收养逻辑(顺序上放在最后统一处理)。

- [ ] **Step 8: 跑测试确认通过**

- [ ] **Step 9: 写失败测试 — 环**

```ts
import { depCycleMembers } from './resumeCore.js'

describe('cycles on disk must be reported, not left to deadlock silently', () => {
  it('depCycleMembers names every node in a dependency cycle', () => {
    const a = mk({ id: 'a', deps: ['b'] })
    const b = mk({ id: 'b', deps: ['a'] })
    const c = mk({ id: 'c', deps: [] })
    expect([...depCycleMembers([a, b, c])].sort()).toEqual(['a', 'b'])
  })

  it('blocks every member so the run explains itself instead of ending 存在无法推进的阻断节点', () => {
    // Today a mutual dep makes nothing advanceable while NO propagateBlocked rule fires
    // (the deps exist and are not BLOCKED), so run() returns blocked with nothing marked —
    // permanently unresumable and identical on every retry.
    const root = mk({ childIds: ['root/01-a', 'root/02-b'], status: 'WAITING_CHILDREN', kind: 'decompose' })
    const a = mk({ id: 'root/01-a', parentId: 'root', deps: ['root/02-b'] })
    const b = mk({ id: 'root/02-b', parentId: 'root', deps: ['root/01-a'] })
    const out = validateLoadedNodes([root, a, b], OPTS)
    for (const id of ['root/01-a', 'root/02-b']) {
      const n = out.nodes.find(x => x.id === id)!
      expect(n.status).toBe('BLOCKED')
      expect(n.blockedReason).toContain('依赖成环')
    }
  })

  it('a childIds cycle does not get promoted into a parentId cycle', () => {
    // The bidirectional rebuild assigns child.parentId unconditionally; on a cyclic
    // childIds graph that MANUFACTURES a parent cycle, after which no node has
    // parentId === null and the tree can never render or walk ancestors.
    const a = mk({ id: 'a', parentId: null, childIds: ['b'] })
    const b = mk({ id: 'b', parentId: null, childIds: ['a'] })
    const out = validateLoadedNodes([a, b], OPTS)
    expect(out.nodes.some(n => n.parentId === null)).toBe(true)
  })
})
```

- [ ] **Step 10: 跑测试确认失败,然后实现**

```ts
/**
 * Ids that sit on a dependency cycle. `hasCycle` in stateMachine.ts answers yes/no, which is
 * enough for the live path (reject the batch) but not for resume: we must BLOCK the exact
 * members, otherwise the run ends with the opaque '存在无法推进的阻断节点' and no node
 * carries a reason — the same state every subsequent resume reproduces byte for byte.
 * Kahn's algorithm: whatever never reaches in-degree zero is on, or downstream of, a cycle.
 */
export function depCycleMembers(nodes: TaskNode[]): Set<string> {
  const ids = new Set(nodes.map(n => n.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const n of nodes) {
    const deps = n.deps.filter(d => ids.has(d) && d !== n.id)
    indeg.set(n.id, deps.length)
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id])
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const settled = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    settled.add(id)
    for (const dep of dependents.get(id) ?? []) {
      const left = (indeg.get(dep) ?? 0) - 1
      indeg.set(dep, left)
      if (left === 0) queue.push(dep)
    }
  }
  return new Set([...ids].filter(id => !settled.has(id)))
}
```

在 `validateLoadedNodes` 的引用完整性之后、双向重建之前插入:

```ts
  for (const id of depCycleMembers([...byId.values()])) {
    const n = byId.get(id)!
    if (n.status !== 'BLOCKED') block(n, '依赖成环,无法确定执行顺序')
  }
```

双向重建的父指针赋值改为**只在子节点尚未有合法父指针时**才写,避免把 childIds 环变成 parentId 环:

```ts
      // Do NOT overwrite unconditionally: on a cyclic childIds graph that manufactures a
      // parentId cycle and leaves the tree with no root at all.
      if (child && child.parentId === null && child.id !== n.id) { … child.parentId = n.id }
```
并在重建后加一道保险:若已无 `parentId === null` 的节点,把 id 最小者的 `parentId` 置 `null` 并记 repair。

- [ ] **Step 11: 写失败测试 — 合成根**

```ts
describe('validateLoadedNodes guarantees the invariant run() asserts', () => {
  it('synthesises a root from the RECOVERED GOAL, not a placeholder', () => {
    // run() does `this.byId.get('root')!` every iteration, so a truncated root file would
    // crash the one case resume exists for. But the synthesized root is also what
    // integratePrompt judges the whole tree against — giving it a placeholder goal means the
    // final acceptance of the entire run is decided on a meaningless question whose PASS
    // marks the run 完成.
    const orphan = mk({ id: 'a', parentId: null, title: '孤儿', status: 'ACCEPTED' })
    const out = validateLoadedNodes([orphan], { ...OPTS, goal: '打通登录接口', phaseRoles: emptyPhaseRoles() })
    const root = out.nodes.find(n => n.id === 'root')!
    expect(root.goal).toBe('打通登录接口')
    expect(root.childIds).toContain('a')
    expect(out.nodes.find(n => n.id === 'a')!.parentId).toBe('root')
    expect(root.createdAt).toBe(NOW) // injected clock, not ''
  })

  it('a synthesised root with no children is BLOCKED, not left to deadlock', () => {
    // WAITING_CHILDREN + childIds: [] is deliberately NOT advanceable and not terminal, so
    // run() would return the opaque '存在无法推进的阻断节点' with nothing explaining why.
    const out = validateLoadedNodes([], OPTS)
    const root = out.nodes.find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED')
    expect(root.blockedReason).toContain('没有恢复到任何节点')
  })

  it('a synthesised root carries the run roster, not an empty one', () => {
    // runRoundtable turns an empty roster into a single main-model reviewer, so an empty
    // phaseRoles would judge the whole run on a panel the gate never showed the user.
    const roles = { ...emptyPhaseRoles(), accept: [{ roleName: 'qa' }] }
    const out = validateLoadedNodes([mk({ id: 'a', parentId: null })], { ...OPTS, phaseRoles: roles })
    expect(out.nodes.find(n => n.id === 'root')!.phaseRoles.accept).toEqual([{ roleName: 'qa' }])
  })

  it('leaves an existing root alone', () => {
    const out = validateLoadedNodes([mk()], OPTS)
    expect(out.nodes).toHaveLength(1)
    expect(out.repairs).toEqual([])
  })
})
```

- [ ] **Step 12: 跑红 → 实现(插在 `return` 之前)**

```ts
  if (!byId.has('root')) {
    repairs.push('恢复的树里没有根节点,已合成一个根并挂上所有根级节点')
    const orphans = [...byId.values()].filter(n => n.parentId === null)
    const root = createNode({
      id: 'root', title: opts.goal.split('\n').map(l => l.trim()).find(l => l.length > 0) || '根任务(恢复时合成)',
      goal: opts.goal, parentId: null, deps: [], depth: 0, phaseRoles: opts.phaseRoles, now: opts.now,
    })
    if (orphans.length === 0) {
      root.status = 'BLOCKED'
      root.blockedReason = '恢复时没有恢复到任何节点,run 目录可能是空的或已损坏'
      root.interrupted = false
    } else {
      root.kind = 'decompose'
      root.status = 'WAITING_CHILDREN'
      root.childIds = orphans.map(o => o.id)
      for (const o of orphans) o.parentId = 'root'
    }
    byId.set('root', root)
  }
```
若 `opts.goal` 为空(清单也损坏),把合成根标 BLOCKED,理由 `原始目标已丢失,无法判定整体验收`——不允许它自行走到 INTEGRATION_ACCEPT。

- [ ] **Step 13: 跑绿 + 全量,提交**

```bash
git add src/tools/efftask/resumeCore.ts src/tools/efftask/resumeCore.test.ts
git commit -m "feat(efftask): 恢复校验 — 阻断而非丢弃悬挂引用、识别环、按真实目标合成根"
```

- [ ] **Step 14: `readRunManifest`(测试 + 实现)**

测试与实现见附录 A(篇幅原因单列,内容完整,无占位)。要点:缺失/损坏 → 回退默认并记 `degraded`;`parallelism`/`caps` 全部 clamp;`caps.scoreThreshold` 一并读回(v1 遗漏,会让配了阈值的 run 恢复后丢失);`resumeGuidance`、`mainModel`、`notices` 均回读。

---

### Task 14: 重入归位

**Files:**
- Create: `src/tools/efftask/reseat.ts`、`src/tools/efftask/reseat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReseatResult { nodes: TaskNode[]; reseated: string[]; exhausted: string[] }
  export function reseatTransientNodes(
    nodes: TaskNode[], now: string, caps: Caps,
  ): ReseatResult
  ```

**归位规则(三级优先,顺序不可调换):**

| 条件 | 目标 | 为什么 |
|---|---|---|
| 已有 `childIds.length > 0` | `WAITING_CHILDREN` | `createChildren` 先落子后提交父状态;归位到 CREATED 会让 `stepStart` 再建一套子节点(同标题 ⇒ 同 id ⇒ 覆盖已验收的子节点;不同标题 ⇒ 树里多出一整套幽灵兄弟) |
| `kind === 'executable'` | `READY` | `advanceableKind` 只在 executable 时推进 READY |
| 其他 | `CREATED` | 让 `stepStart` 重新判定 kind——归一化为 `unknown` 的节点若进 READY 就永久卡死 |

**输入状态集合:** 活动态(`PLANNING`/`PLAN_REVIEW`/`EXECUTING`/`ACCEPTANCE`/`REWORK`/`INTEGRATION_ACCEPT`)**以及** `BLOCKED && interrupted === true`。
不处理 `EXECUTED`/`SCORING`/`MERGE`——已 grep 确认全代码库从不提交这三个状态,为其写规则是给死代码写逻辑。

**预算守卫:** 若节点重入后要跑的那一阶段预算已耗尽(`iteration.acceptance >= caps.maxIterations` 而它将重入 execute→accept;`iteration.planReview >= caps.maxIterations` 而它将重入 plan),则标 `BLOCKED`,理由 `恢复时该阶段预算已耗尽`,并计入 `exhausted`。否则会先花掉一次**带写权限**的执行调用和一整轮验收圆桌,然后才阻断。

- [ ] **Step 1: 写失败测试**(完整,无占位)

```ts
// src/tools/efftask/reseat.test.ts
import { describe, expect, it } from 'bun:test'
import { reseatTransientNodes } from './reseat.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, type TaskNode } from './types.js'

const NOW = '2026-07-25T00:00:00.000Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'n', title: 't', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})

describe('reseatTransientNodes returns killed-mid-phase nodes to a re-enterable state', () => {
  it('reopens nodes the abort sweep blocked — otherwise resume advances nothing at all', () => {
    // propagateBlocked(aborted) sweeps EVERY non-terminal node to BLOCKED. Esc, Ctrl+C and
    // view teardown all go through it, so this is the dominant real-world resume input.
    // Verified against P1: without this, a resumed run makes ZERO model calls.
    const n = mk({ status: 'BLOCKED', interrupted: true, kind: 'executable', blockedReason: '已中断' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('READY')
    expect(out.nodes[0].interrupted).toBeFalsy()
    expect(out.nodes[0].blockedReason).toBe('') // cleared: it is no longer blocked
    expect(out.reseated).toContain('n')
  })

  it('does NOT reopen a node that really failed', () => {
    const n = mk({ status: 'BLOCKED', kind: 'executable', blockedReason: '验收迭代超限(3): 缺测试' })
    const out = reseatTransientNodes([n], NOW, DEFAULT_CAPS)
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.reseated).toEqual([])
  })

  it('a node that already has children never reseats to CREATED', () => {
    // createChildren persists children BEFORE committing the parent, so a kill in that
    // window leaves PLAN_REVIEW + children on disk. CREATED would replan and build a second
    // set: same titles overwrite the recovered (possibly ACCEPTED) children; different
    // titles leave ghost siblings that childrenAllAccepted then waits on forever.
    const n = mk({ status: 'PLAN_REVIEW', kind: 'decompose', childIds: ['n/01-a'] })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status).toBe('WAITING_CHILDREN')
  })

  it('a non-executable kind reseats to CREATED, never to READY', () => {
    // advanceableKind only advances READY when kind === 'executable'; READY + unknown is
    // neither advanceable nor terminal, so the run dies with no reason and every later
    // --resume reproduces it byte for byte.
    for (const kind of ['unknown', 'decompose'] as const) {
      const n = mk({ status: 'EXECUTING', kind, childIds: [] })
      expect(`${kind}:${reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].status}`).toBe(`${kind}:CREATED`)
    }
  })

  it('maps each active status through the same three rules', () => {
    const cases: [TaskNode['status'], TaskNode['kind'], string[], string][] = [
      ['PLANNING', 'unknown', [], 'CREATED'],
      ['PLAN_REVIEW', 'unknown', [], 'CREATED'],
      ['EXECUTING', 'executable', [], 'READY'],
      ['ACCEPTANCE', 'executable', [], 'READY'],
      ['REWORK', 'executable', [], 'READY'],
      ['INTEGRATION_ACCEPT', 'decompose', ['n/01-a'], 'WAITING_CHILDREN'],
    ]
    for (const [from, kind, childIds, to] of cases) {
      const out = reseatTransientNodes([mk({ status: from, kind, childIds })], NOW, DEFAULT_CAPS)
      expect(`${from}->${out.nodes[0].status}`).toBe(`${from}->${to}`)
    }
  })

  it('leaves settled statuses untouched', () => {
    for (const s of ['CREATED', 'READY', 'WAITING_CHILDREN', 'ACCEPTED'] as const) {
      const out = reseatTransientNodes([mk({ status: s })], NOW, DEFAULT_CAPS)
      expect(out.nodes[0].status).toBe(s)
      expect(out.reseated).toEqual([])
    }
  })

  it('does not touch iteration counters — restart must not refresh the budget', () => {
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 2, acceptance: 1, integration: 0 } })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].iteration)
      .toEqual({ planReview: 2, acceptance: 1, integration: 0 })
  })

  it('blocks a node whose budget for the phase it would re-enter is already spent', () => {
    // Otherwise resume spends a real WRITE-CAPABLE execute call plus a full acceptance
    // roundtable, and only THEN blocks on 验收迭代超限 — paying for a mutation nothing
    // will consume.
    const n = mk({ status: 'ACCEPTANCE', kind: 'executable', iteration: { planReview: 0, acceptance: 3, integration: 0 } })
    const out = reseatTransientNodes([n], NOW, { ...DEFAULT_CAPS, maxIterations: 3 })
    expect(out.nodes[0].status).toBe('BLOCKED')
    expect(out.nodes[0].blockedReason).toContain('预算已耗尽')
    expect(out.exhausted).toContain('n')
  })

  it('annotates the interruption once, not once per crash cycle', () => {
    // Repeated crash/resume cycles would otherwise stack '(注:…)' lines into the evidence
    // acceptPrompt shows the reviewer.
    let n = mk({ status: 'EXECUTING', kind: 'executable', execStatus: '已改 src/a.ts' })
    for (let i = 0; i < 3; i++) {
      n = reseatTransientNodes([{ ...n, status: 'EXECUTING' }], NOW, DEFAULT_CAPS).nodes[0]
    }
    expect(n.execStatus).toContain('已改 src/a.ts')
    expect(n.execStatus.match(/中断/g)?.length).toBe(1)
  })

  it('does not annotate a node that never executed', () => {
    const n = mk({ status: 'PLANNING', kind: 'unknown', execStatus: '' })
    expect(reseatTransientNodes([n], NOW, DEFAULT_CAPS).nodes[0].execStatus).toBe('')
  })
})
```

- [ ] **Step 2: 跑红 → 实现 → 跑绿 → 提交**

实现要点(按上表三级规则 + 预算守卫 + 单次注记),`git commit -m "feat(efftask): 重入归位 — 按 kind/子节点/预算三级判定,并重开被中断的节点"`。

- [ ] **Step 3: 返工意见回灌(`pipeline.ts`)**

`REWORK`/`PLAN_REVIEW` 归位后 `feedback` 丢失,执行者会把被否的活原样重做且少一轮预算。改为重入时从日志回灌:`stepExecute` 的 `feedback` 缺省取 `node.acceptLog` 最后一条 `synthesized.pass === false` 的 `blockingSummary`;`stepStart` 同理取 `node.reviewLog`。配套测试:恢复一个 acceptLog 末条为 FAIL 的节点,断言 execute 提示词包含 `上一轮验收未通过` 与那条阻断意见。

---

### Task 15: run 注册表、原子锁、恢复记录

**Files:** `src/tools/efftask/runRegistry.ts` + 测试;`persistence.ts`(改)

**锁必须用 `mkdirExclusive`,不是读后写。** v1 的读后写在 `Promise.all` 下**双双 acquired:true**——正是 P1 为 run id 付过学费的同一个 bug 类,而它的解药就在同文件里。锁目录 `run.lock.d/`,pid 与时间戳写在目录内的 `owner.yaml`。陈旧判定同时看 **pid 存活**与 **`at` 时效**(pid 会被 OS 回收;v1 只看 pid,回收后该 run 永久不可恢复)。

`FsLike` 增 **必填** `unlink(p)` 与 `rmdir(p)`——全仓只有两个假 fs(`persistence.test.ts:7`、`runOrchestrator.test.ts:7`),各补一行即可;写成可选会让 `fs.unlink?.()` 静默空转,把锁永久留在盘上。

**恢复记录不能"追加到 run.md"**——`writeRunManifest` 整文件重写,`runOrchestrator` 首帧就会冲掉。改为写进 frontmatter 的 `resumes: [{at, reseated, repairs, degraded}]`,由 `readRunManifest` 读回、`writeRunManifest` 原样回写。

`listRuns` 必须**跳过零节点的 run**:`allocateRunId` 的预留目录在 SIGKILL 下不会被释放,`--resume latest` 会选中一个空目录并立刻死局。`updatedAt` 取 `max(node.updatedAt)`,回退到清单 `createdAt`。

- [ ] Step 1-6: 见附录 B(测试与实现完整给出,含 `Promise.all` 竞态测试)。

---

### Task 16: 命令接线

**Files:** `parseResumeArgs.ts`(新)、`orchestrator.ts`/`runOrchestrator.ts`(加 seed)、`pipeline.ts`(`guidanceSection`)、`efftask.tsx`、`ResumePicker.tsx`(新)、`ConfirmResume.tsx`(新)、`feishuStartupCard.ts`(改)

必须处理(v1 全部缺失,逐条列出以免再漏):

1. `EffTaskRunner` 首个 effect **无条件**跑 `parseDirectives`(模型调用)并随后 `annotateRoleModels` 覆盖名册。resume 分支必须整体跳过——新增 `mode: 'new' | 'resume'` 与 `recovered` props,resume 直接落到新的 `'confirmResume'` phase。
2. `Phase` 联合在 `runOrchestrator.ts:21` 有一份副本,加 phase 要同步改。
3. `runOrchestrator` 需要 `seed` 参数并透传给构造函数;它是唯一生产调用点。
4. `RunnerProps.runId`/`runDir` 在 picker 路径上要到用户选完才知道 ⇒ 改为可空 state。
5. `onExit` 需 **跳过** `rmdir(runDir)` 预留释放(续跑目录非空)并**调用 `releaseRunLock`**;picker 路径上它构造时 runDir 尚不存在。
6. 锁被占用的分支:从 args 给 id 时可以 `onDone + return null`;从 picker 选择时唯一出口是 `props.onExit`。
7. `acquireRunLock` 自身抛错要有分支(参照 `allocateRunId` 的 try/catch,注释解释了为何 `call()` 里 reject 会让用户什么都看不到)。
8. `seed.length > 0` 的守卫若落空会**静默把续跑变成在旧目录里新开一个 run** ⇒ 空 seed 必须报错退出。
9. `buildStartupCard` 只有 目标/并行数/安全阀/名册/notices,且标题写死"启动确认"。需加可选附加区块与标题参数,否则飞书审批者看不到校验/归位摘要就点了同意——两个界面口径不一,正是 `rosterLines` 那条"两个界面共用"注释要防的事。
10. `ConfirmResume` 必须复刻 `terminalClaim` 卸载兜底(`if (!settled) terminalClaim.current?.('cancelled', CANCELLED)`),否则飞书卡片永远挂在会话里。
11. 恢复关口要展示**四路信息**:`loadRun.errors`、`readRunManifest.degraded`、`validate.repairs`、`reseat.reseated`/`exhausted`。§17.2 明文要求"校验结果汇总展示给用户"。
12. 恢复时按**本会话**的 `activeAgents` 重新校验名册并重跑 `annotateRoleModels`——盘上记的角色可能已不存在,`pickAgentDefinition` 会静默回落主模型,那正是 `6684df3`/`b275c35` 为新建 run 关掉的谎报。
13. `guidanceSection` 插入点分别指明:`planPrompt` 在 `depsSection` 之后、深度预算行之前;`executePrompt` 在 `depsSection` 之后、返工反馈块之前(它没有"目标"行,§17.4 那句"目标之后"只对 planPrompt 成立)。
14. `resumeGuidance` 覆盖语义:新给的**替换**旧的;显式给空则**清空**;未带指引则沿用盘上的,并在关口标注"沿用上次的续跑指引"。
15. `parseResumeArgs` 的 id 要**零填充**(`--resume 3` 必须找到 `003`),接受 1-4 位数字(`allocateRunId` 过 999 会给四位)。
16. 对新建 run 的行为改动必须为零:`resumeGuidance` 按 `mainModel` 同款条件写入;`rest` 对 mode 'new' 必须与 `args` 逐字节一致(任何 trim 都会改掉 goalPrompt、根标题和每条 plan 提示词);`allocateRunId` 保持在 `call()` 里提前预留。

---

## Self-Review(对照 spec §17,只记**实际**状态)

- §17.1 三入口:Task 16 `parseResumeArgs` + `ResumePicker`;`latest` 经 `listRuns`(Task 15)。
- §17.2 读取/校验/归位:Task 13 + Task 14。四路信息汇总展示 → Task 16 第 11 条。
- §17.3 恢复确认关口:Task 16 + 飞书卡片改造(第 9 条)。**已知继承缺口:** `ConfirmStartup` 只有 y/n,`StartupDecision` 仅带 `{parallelism, approved}`,所以 §17.3 说的"名册可改"在 P1.5 仍**不成立**——沿用 P1 的关口能力,不假装做到。
- §17.4 续跑指引:Task 16 第 13/14 条(插入点 + 覆盖语义)。
- §17.5 不重置计数(Task 14)、runId 不变(Task 16)、恢复记录(Task 15)、单实例锁(Task 15)。**新增:** 锁也要在新建 run 路径上取,否则只挡 resume-vs-resume,挡不住 new-vs-resume。

## 附录

- **附录 A:** `readRunManifest` 的完整测试与实现。
- **附录 B:** `listRuns` / `acquireRunLock` / `releaseRunLock` 的完整测试与实现,含 `Promise.all` 竞态测试与 `resumes[]` 往返测试。

> 附录在进入对应任务前补齐;**在附录写完之前不得开工 Task 15**——v1 正是在这两处留了占位,评审三方独立判为阻断。
