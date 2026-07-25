# 高效任务模式 (Efficient Task Mode) — P1 骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/et` 高效任务模式的可运行骨架:命令入口 + 启动确认(终端+飞书)+ 任务树/节点模型 + md 持久化 + **串行**执行 + **多角色圆桌**方案制定/评审/执行/验收(settings 里有角色时按阶段名册并行扇出;无角色则退化为主模型单角色)+ 基础只读实时树。

**Architecture:** 一个确定性 TS 编排引擎(`EffTaskOrchestrator`)拥有任务树、依赖门控、md 持久化;每个节点的阶段(plan/review/execute/accept)通过一个**注入的 `RunAgentFn` 接缝**调用模型(P1 用主模型),接缝背后是对现有 `runAgent()` 的适配器。引擎与所有纯逻辑用假 `RunAgentFn`/假 fs 单测,不打真模型。

**Tech Stack:** Bun + TypeScript,Ink TUI,`yaml`(^2.8.3,已在依赖),现有 `runAgent()` / `createUserMessage` / `hasPermissionsToUseTool`;飞书侧**复用 `useFeishuBridge` 已建好的共享 `FeishuClient` + `FeishuPermissionCallbacks`**(从 `AppState` 取,不自建连接);命令层的 `FsLike` 直连 `node:fs/promises`。测试 `bun test`,测试文件与源码同目录 `*.test.ts`。

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json` 的 `roles`;不引入 `env:` 间接、不脱敏。
- 不 `feature()` 门控:`/et` 及相关代码直接生效(本 fork 运行时 `feature()` 恒 false,门控=死代码)。
- 所有人工确认走同一路径:终端 + 飞书卡片竞速,首个响应者胜出并同步另一端;不新造确认通道。
- 确定性硬控制:依赖门控(节点仅当 `deps` 全 `ACCEPTED` 才可开始)由 TS 引擎保证,不交给模型。
- 圆桌合成 = 独立并行 + 全票通过:任一角色 `pass=false` 或 `blocking` 非空即不通过。阶段名册为空时退化为单个主模型角色说了算。
- 不静默截断:触发安全阀(深度/节点数/迭代上限;超时 tree-kill 属 P3,P1 定义 `nodeTimeoutMs` 但不强制)一律 `BLOCKED` + 记录 `blockedReason`,并在末态视图展示。**安全阀触发时的飞书升级卡片 DEFERRED→P2**(P1 只记录 + 终端展示,不主动推飞书)。
- TUI-only。
- 测试文件与源码同目录,命名 `*.test.ts`;`bun test` 运行;不打真模型、不动真 git、不写真磁盘(注入假 fs)。

**P1 范围边界(明确不在 P1):** 并行执行、git worktree 隔离、**每节点角色覆盖**(节点级 `phaseRoles` 改写)、观察评分(observer 阶段)、执行中动态加子节点(runtime `addChild`)、交互式展开/详情面板。这些在 P2/P3。P1 的"子节点"仅来自 **plan 阶段声明的 decompose 子节点**;P1 的实时树是**只读**的。
- **多角色圆桌在 P1 是真的**:`parseDirectives` 会把提示词里的角色名对照 settings 的 `roles` 解析成阶段名册,`runRoundtable` 对名册并行扇出、全票才通过。P1 缺的是**节点级角色覆盖**与**观察评分**,不是多角色本身。
- **DEFERRED→P2:启动第 3 关(执行前预览/编辑根方案 + 顶层拆分)。** P1 的启动确认只覆盖 **名册(roster)+ 并行数 + 目标回显**(approve=用建议值 / cancel=退出),不做根方案/顶层拆分的预览编辑。
- **DEFERRED→P2:后台任务注册(spec §10)。** P1 不调 `registerAsyncAgent`、`/tasks` 里看不到 `/et` 运行;整轮编排跑在 `/et` 命令组件自身的生命周期内(离开该视图即随 `AbortController` 中断)。
- **DEFERRED→P2:安全阀触发时的飞书升级卡片。** P1 只把原因写进 `node.blockedReason` + `run.md`,并在 `done` 视图展示,不向飞书推升级卡。
- **只读工具边界**:`plan`/`review`/`accept`/`observer` 阶段以**真只读工具池**(`Read`/`Glob`/`Grep`)运行——能读仓库但不能改;只有 `execute` 阶段拿到完整可写工具池。一次性的配置抽取调用不给任何工具。
- **非 git 仓库降级在 P1 为 N/A**:P1 串行、共享 `cwd`、无 worktree 隔离,不涉及 git 分支操作,故无需降级路径(该问题在 P2 引入 worktree 时才出现)。
- **`caps.nodeTimeoutMs` 在 P1 已定义但不强制执行**:节点级超时 tree-kill 属 P3(见交接)。P1 仅定义字段并落盘,不据此中断节点。

**运行时的 `bun` 路径:** `~/.bun/bin/bun`。所有测试命令前置 `export PATH="$HOME/.bun/bin:$PATH"`。

---

## File Structure (P1)

**纯逻辑(全 TDD 单测):**
- `src/tools/efftask/types.ts` — 类型 + `createNode`/`emptyPhaseRoles`/常量。
- `src/tools/efftask/stateMachine.ts` — 纯谓词:依赖门控、可推进态判定、UI 状态映射。
- `src/tools/efftask/parseOutput.ts` — 容错解析模型阶段输出(plan/verdict/exec)。
- `src/tools/efftask/parseDirectives.ts` — 提示词 → `EffTaskConfig`(注入 model 调用,失败回退默认)。
- `src/tools/efftask/persistence.ts` — 节点/清单序列化 + 读写(注入 fs)+ runId 分配 + 树快照。
- `src/tools/efftask/roundtable.ts` — 多裁决合成 + 单阶段圆桌执行(注入 `RunAgentFn`)。
- `src/tools/efftask/pipeline.ts` — 单节点宏步骤:start(plan+review)/execute(+accept)/integrate。
- `src/tools/efftask/orchestrator.ts` — 串行驱动循环(选可推进节点 → 推进 → 持久化 → 通知)。

**集成/UI(真实代码,手动/UAT 验证,无单测——沿用本仓 Ink 组件无单测的惯例):**
- `src/tools/efftask/runAgentAdapter.ts` — 用 `ToolUseContext` 构造真实 `RunAgentFn`(仿 `executeForkedSlashCommand`)。
- `src/tools/efftask/startupConfirm.ts`(纯竞速原语 + `rosterLines`,有单测)+ `src/tools/efftask/feishuStartupCard.ts`(飞书卡片 surface,集成;骑在共享 `FeishuClient`/callbacks 上)+ `src/commands/efftask/ConfirmStartup.tsx` — 启动确认(终端 Ink + 飞书卡片竞速;P1 呈现**真实名册**/并行数/安全阀/目标回显,启动第 3 关方案预览编辑 P2)。
- `src/commands/efftask/index.ts` — 命令元数据(local-jsx),注册进 `src/commands.ts`。
- `src/commands/efftask/efftask.tsx` — `call()`:解析→确认→起编排器(后台任务)→渲染只读树。
- `src/commands/efftask/TaskTreePanel.tsx` — 只读实时树(状态着色 + 耗时)。

---

## Task 1: 节点与配置类型

**Files:**
- Create: `src/tools/efftask/types.ts`
- Test: `src/tools/efftask/types.test.ts`

**Interfaces:**
- Produces: `PhaseName`, `PHASE_NAMES`, `NodeKind`, `NodeStatus`, `RoleBinding`, `NodePlan`, `Verdict`, `RoundtableRecord`, `ScoreRecord`, `TaskNode`, `Caps`, `DEFAULT_CAPS`, `EffTaskConfig`, `DEFAULT_PARALLELISM`, `emptyPhaseRoles()`, `emptyPlan()`, `createNode(args)`.

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/types.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, PHASE_NAMES } from './types.js'

describe('createNode', () => {
  it('creates a node with sane defaults', () => {
    const n = createNode({ id: 'root', title: '根目标', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-25T00:00:00Z' })
    expect(n.id).toBe('root')
    expect(n.goal).toBe(n.title) // goal defaults to title when not provided
    expect(n.status).toBe('CREATED')
    expect(n.kind).toBe('unknown')
    expect(n.childIds).toEqual([])
    expect(n.iteration).toEqual({ planReview: 0, acceptance: 0 })
    expect(n.plan.solution).toBe('')
    expect(n.blockedReason).toBe('') // blocking reason lives in its own field, not execStatus
    expect(n.createdAt).toBe('2026-07-25T00:00:00Z')
    expect(n.updatedAt).toBe('2026-07-25T00:00:00Z')
  })
  it('does not alias the phaseRoles object across nodes', () => {
    const roles = emptyPhaseRoles()
    const a = createNode({ id: 'a', title: 'a', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    const b = createNode({ id: 'b', title: 'b', parentId: null, deps: [], depth: 0, phaseRoles: roles, now: '2026-07-25T00:00:00Z' })
    a.phaseRoles.review = [{ roleName: 'arch' }]
    expect(b.phaseRoles.review).toEqual([]) // shallow copy: mutating one node never leaks to another
  })
  it('DEFAULT_CAPS and PHASE_NAMES are stable', () => {
    expect(DEFAULT_CAPS.maxDepth).toBe(5)
    expect(DEFAULT_CAPS.maxNodes).toBe(100)
    expect(DEFAULT_CAPS.maxIterations).toBe(3)
    expect(PHASE_NAMES).toEqual(['plan','review','execute','accept','observer'])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/types.test.ts`
Expected: FAIL(模块不存在 / `createNode` 未定义)。

- [ ] **Step 3: 实现**

```ts
export type PhaseName = 'plan' | 'review' | 'execute' | 'accept' | 'observer'
export const PHASE_NAMES: PhaseName[] = ['plan', 'review', 'execute', 'accept', 'observer']

export type NodeKind = 'decompose' | 'executable' | 'unknown'

export type NodeStatus =
  | 'CREATED' | 'PLANNING' | 'PLAN_REVIEW'
  | 'READY' | 'EXECUTING' | 'EXECUTED' | 'ACCEPTANCE' | 'REWORK'
  | 'WAITING_CHILDREN' | 'INTEGRATION_ACCEPT'
  | 'SCORING' | 'MERGE' | 'ACCEPTED' | 'BLOCKED'

export interface RoleBinding { roleName: string; model?: string }
export interface NodePlan { solution: string; keyPoints: string; risks: string; acceptance: string }
/**
 * `infra: true` marks a verdict the reviewer never actually rendered — the call itself
 * failed (network, provider error). It is NOT a judgement about the work, so a caller
 * must retry the review rather than treat it as a rejection and redo the executor's work.
 */
export interface Verdict { role: string; pass: boolean; blocking: string[]; comments: string; infra?: boolean }
export interface RoundtableRecord { round: number; verdicts: Verdict[]; synthesized: { pass: boolean; blockingSummary: string } }
export interface ScoreRecord { role: string; score: number; rationale: string }

export interface TaskNode {
  id: string
  title: string
  goal: string // immutable node goal; set once at creation, never overwritten by plan output
  parentId: string | null
  childIds: string[]
  deps: string[]
  kind: NodeKind
  status: NodeStatus
  phaseRoles: Record<PhaseName, RoleBinding[]>
  plan: NodePlan
  execStatus: string
  // Why a separate field: execStatus may hold real completed-work evidence that the
  // acceptance roundtable still needs to see. Blocking must never overwrite it.
  blockedReason: string
  reviewLog: RoundtableRecord[]
  acceptLog: RoundtableRecord[]
  score: { plan?: ScoreRecord; exec?: ScoreRecord }
  worktree?: { branch: string; path: string }
  // Separate budgets. `acceptance` belongs to an executable node's accept loop and
  // `integration` to a decompose node's integrate loop; sharing one counter means a
  // resumed node could arrive at integration with its budget already spent elsewhere.
  iteration: { planReview: number; acceptance: number; integration: number }
  depth: number
  createdAt: string
  updatedAt: string
}

export interface Caps { maxDepth: number; maxNodes: number; maxIterations: number; nodeTimeoutMs: number; scoreThreshold?: number }
export const DEFAULT_CAPS: Caps = { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600_000 }

export const DEFAULT_PARALLELISM = 5
export interface EffTaskConfig {
  goalPrompt: string
  parallelism: number
  phaseRoles: Record<PhaseName, RoleBinding[]>
  caps: Caps
}

export function emptyPhaseRoles(): Record<PhaseName, RoleBinding[]> {
  return { plan: [], review: [], execute: [], accept: [], observer: [] }
}
export function emptyPlan(): NodePlan {
  return { solution: '', keyPoints: '', risks: '', acceptance: '' }
}

export function createNode(args: {
  id: string
  title: string
  goal?: string
  parentId: string | null
  deps: string[]
  depth: number
  phaseRoles: Record<PhaseName, RoleBinding[]>
  now: string
}): TaskNode {
  return {
    id: args.id,
    title: args.title,
    goal: args.goal ?? args.title, // default goal to title so existing call-sites stay valid
    parentId: args.parentId,
    childIds: [],
    deps: [...args.deps],
    kind: 'unknown',
    status: 'CREATED',
    // Copy the per-phase ARRAYS too, not just the outer record. Every child is
    // created with `phaseRoles: parent.phaseRoles` (pipeline createChildren), so a
    // one-level spread would leave the whole tree — and the run config it came
    // from — sharing five array instances. P3's per-node role overrides edit a
    // node's roster in place; without this the edit would corrupt every sibling.
    phaseRoles: Object.fromEntries(
      PHASE_NAMES.map(p => [p, [...args.phaseRoles[p]]]),
    ) as Record<PhaseName, RoleBinding[]>,
    plan: emptyPlan(),
    execStatus: '',
    blockedReason: '',
    reviewLog: [],
    acceptLog: [],
    score: {},
    iteration: { planReview: 0, acceptance: 0, integration: 0 },
    depth: args.depth,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/types.test.ts`
Expected: PASS(3 条:默认值(含 `blockedReason:''`)/ 常量稳定 / `phaseRoles` 不共享)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/types.ts src/tools/efftask/types.test.ts
git commit -m "feat(efftask): task node & config types"
```

---

## Task 2: 状态机纯谓词(依赖门控)

**Files:**
- Create: `src/tools/efftask/stateMachine.ts`
- Test: `src/tools/efftask/stateMachine.test.ts`

**Interfaces:**
- Consumes: `TaskNode`, `NodeStatus`(Task 1)。
- Produces: `byIdMap(nodes)`, `depsSatisfied(node, byId)`, `childrenAllAccepted(node, byId)`, `advanceableKind(node, byId): 'start'|'execute'|'integrate'|null`, `isTerminal(status)`, `uiStatus(status): 'done'|'running'|'queued'|'failed'`, `hasCycle(nodes): boolean`（Kahn 拓扑,供 Task 7 兄弟依赖成环检测复用）。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/stateMachine.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { byIdMap, depsSatisfied, childrenAllAccepted, advanceableKind, isTerminal, uiStatus, hasCycle } from './stateMachine.js'

const NOW = '2026-07-25T00:00:00Z'
const mk = (id: string, over: Partial<ReturnType<typeof createNode>> = {}) =>
  ({ ...createNode({ id, title: id, parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }), ...over })

describe('stateMachine', () => {
  it('depsSatisfied requires all deps ACCEPTED', () => {
    const a = mk('a', { status: 'ACCEPTED' })
    const b = mk('b', { status: 'EXECUTING' })
    const c = mk('c', { deps: ['a', 'b'] })
    const byId = byIdMap([a, b, c])
    expect(depsSatisfied(c, byId)).toBe(false)
    b.status = 'ACCEPTED'
    expect(depsSatisfied(c, byId)).toBe(true)
  })
  it('advanceableKind: CREATED+deps satisfied => start; else null', () => {
    const a = mk('a', { status: 'ACCEPTED' })
    const c = mk('c', { deps: ['a'], status: 'CREATED' })
    const byId = byIdMap([a, c])
    expect(advanceableKind(c, byId)).toBe('start')
    const d = mk('d', { deps: ['x-missing-not-accepted'], status: 'CREATED' })
    expect(advanceableKind(d, byIdMap([d]))).toBe(null)
  })
  it('advanceableKind: READY executable => execute', () => {
    const n = mk('n', { status: 'READY', kind: 'executable' })
    expect(advanceableKind(n, byIdMap([n]))).toBe('execute')
  })
  it('advanceableKind: WAITING_CHILDREN with all children ACCEPTED => integrate', () => {
    const p = mk('p', { status: 'WAITING_CHILDREN', childIds: ['p/01-x'] })
    const child = mk('p/01-x', { status: 'ACCEPTED', parentId: 'p' })
    expect(advanceableKind(p, byIdMap([p, child]))).toBe('integrate')
    child.status = 'EXECUTING'
    expect(advanceableKind(p, byIdMap([p, child]))).toBe(null)
  })
  it('advanceableKind: WAITING_CHILDREN with ZERO children => null (nothing to integrate)', () => {
    const p = mk('p', { status: 'WAITING_CHILDREN', childIds: [] })
    expect(advanceableKind(p, byIdMap([p]))).toBe(null)
  })
  it('uiStatus maps statuses to 4 buckets', () => {
    expect(uiStatus('ACCEPTED')).toBe('done')
    expect(uiStatus('EXECUTING')).toBe('running')
    expect(uiStatus('CREATED')).toBe('queued')
    expect(uiStatus('READY')).toBe('queued')
    expect(uiStatus('BLOCKED')).toBe('failed')
  })
  it('isTerminal true only for ACCEPTED/BLOCKED', () => {
    expect(isTerminal('ACCEPTED')).toBe(true)
    expect(isTerminal('BLOCKED')).toBe(true)
    expect(isTerminal('EXECUTING')).toBe(false)
  })
  it('hasCycle detects sibling dependency cycles', () => {
    const a = mk('a', { deps: ['b'] })
    const b = mk('b', { deps: ['a'] })
    expect(hasCycle([a, b])).toBe(true)
    const c = mk('c', { deps: [] })
    const d = mk('d', { deps: ['c'] })
    expect(hasCycle([c, d])).toBe(false) // acyclic chain
    const e = mk('e', { deps: ['nonexistent'] })
    expect(hasCycle([e])).toBe(false) // edge to node outside the set is ignored
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/stateMachine.test.ts`
Expected: FAIL(未定义)。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/stateMachine.ts
import type { TaskNode, NodeStatus } from './types.js'

export function byIdMap(nodes: TaskNode[]): Map<string, TaskNode> {
  return new Map(nodes.map(n => [n.id, n]))
}

export function depsSatisfied(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  return node.deps.every(id => byId.get(id)?.status === 'ACCEPTED')
}

export function childrenAllAccepted(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  if (node.childIds.length === 0) return true
  return node.childIds.every(id => byId.get(id)?.status === 'ACCEPTED')
}

export function isTerminal(status: NodeStatus): boolean {
  return status === 'ACCEPTED' || status === 'BLOCKED'
}

export type AdvanceKind = 'start' | 'execute' | 'integrate' | null
export function advanceableKind(node: TaskNode, byId: Map<string, TaskNode>): AdvanceKind {
  if (node.status === 'CREATED' && depsSatisfied(node, byId)) return 'start'
  if (node.status === 'READY' && node.kind === 'executable' && depsSatisfied(node, byId)) return 'execute'
  // WAITING_CHILDREN with ZERO children has nothing to integrate — returning 'integrate'
  // would spin the orchestrator on an empty roundtable. Treat it as not advanceable.
  if (node.status === 'WAITING_CHILDREN' && node.childIds.length > 0 && childrenAllAccepted(node, byId)) return 'integrate'
  return null
}

export type UiStatus = 'done' | 'running' | 'queued' | 'failed'
export function uiStatus(status: NodeStatus): UiStatus {
  if (status === 'ACCEPTED') return 'done'
  if (status === 'BLOCKED') return 'failed'
  if (status === 'CREATED' || status === 'READY' || status === 'WAITING_CHILDREN') return 'queued'
  return 'running'
}

// Cycle detection over the given node set. Only edges whose dep target is also
// in the set count (used by pipeline to check a freshly-created sibling group).
// Kahn's algorithm: if not every node can be topologically removed, a cycle exists.
export function hasCycle(nodes: TaskNode[]): boolean {
  const ids = new Set(nodes.map(n => n.id))
  const indeg = new Map<string, number>()
  const dependents = new Map<string, string[]>() // dep id -> nodes that depend on it
  for (const n of nodes) { indeg.set(n.id, 0); dependents.set(n.id, []) }
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) continue // ignore edges to nodes outside the set
      dependents.get(d)!.push(n.id)
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
    }
  }
  const queue = [...ids].filter(id => (indeg.get(id) ?? 0) === 0)
  let removed = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    removed++
    for (const m of dependents.get(id) ?? []) {
      const next = (indeg.get(m) ?? 0) - 1
      indeg.set(m, next)
      if (next === 0) queue.push(m)
    }
  }
  return removed !== ids.size
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/stateMachine.test.ts`
Expected: PASS(8 条:含新增的"`WAITING_CHILDREN` 零子节点 ⇒ null")。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/stateMachine.ts src/tools/efftask/stateMachine.test.ts
git commit -m "feat(efftask): state-machine predicates & dependency gating"
```

---

## Task 3: 阶段输出容错解析

**Files:**
- Create: `src/tools/efftask/parseOutput.ts`
- Test: `src/tools/efftask/parseOutput.test.ts`

**Interfaces:**
- Consumes: `NodeKind`, `NodePlan`, `Verdict`(Task 1)。
- Produces: `extractJsonBlock(text): unknown | null`, `parsePlanOutput(text): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] }`, `parseVerdict(text, role): Verdict`, `parseExecOutput(text): { execStatus: string }`。
- 契约:阶段 agent 被要求返回一个 ```json ...``` 代码块(或裸 JSON 对象);解析器容错——找不到/字段缺失时给安全默认(plan→executable 空方案;verdict→pass:false 带一条"无法解析裁决"的 blocking;exec→用整段文本当 execStatus)。
- **LAST-FENCE 规则**:`extractJsonBlock` 扫描全部 ``` 围栏并**从后往前**尝试解析,取第一个能解析的;全部失败才回退"首个 `{` 到末个 `}`"的裸切片。理由:多轮转写里模型常先复述含 JSON 的提示词再作答,**本阶段的答案总在最后**;取第一个围栏会解析到被回显的旧方案。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/parseOutput.test.ts
import { describe, expect, it } from 'bun:test'
import { extractJsonBlock, parsePlanOutput, parseVerdict, parseExecOutput } from './parseOutput.js'

describe('parseOutput', () => {
  it('extractJsonBlock finds fenced json', () => {
    expect(extractJsonBlock('noise\n```json\n{"a":1}\n```\ntail')).toEqual({ a: 1 })
  })
  it('extractJsonBlock finds bare object', () => {
    expect(extractJsonBlock('prefix {"a":2} suffix')).toEqual({ a: 2 })
  })
  it('extractJsonBlock returns null when none', () => {
    expect(extractJsonBlock('no json here')).toBeNull()
  })
  it('extractJsonBlock prefers the LAST parseable fence when there are two', () => {
    const text = 'blah\n```json\n{"a":1}\n```\nmiddle\n```json\n{"a":2}\n```\ntail'
    expect(extractJsonBlock(text)).toEqual({ a: 2 })
  })
  it('extractJsonBlock: echoed plan fence then verdict fence => verdict wins', () => {
    const text =
      '我先回顾一下上一阶段的方案:\n```json\n{"kind":"executable","solution":"旧方案"}\n```\n' +
      '基于以上,我的裁决是:\n```json\n{"pass":false,"blocking":["缺验收点"],"comments":""}\n```'
    expect(extractJsonBlock(text)).toEqual({ pass: false, blocking: ['缺验收点'], comments: '' })
  })
  it('parsePlanOutput decompose with children', () => {
    const out = parsePlanOutput('```json\n{"kind":"decompose","solution":"s","keyPoints":"k","risks":"r","acceptance":"a","children":[{"title":"c1","deps":[]},{"title":"c2","deps":["c1"]}]}\n```')
    expect(out.kind).toBe('decompose')
    expect(out.plan.solution).toBe('s')
    expect(out.children).toEqual([{ title: 'c1', deps: [] }, { title: 'c2', deps: ['c1'] }])
  })
  it('parsePlanOutput defaults to executable on garbage', () => {
    const out = parsePlanOutput('the model rambled with no json')
    expect(out.kind).toBe('executable')
    expect(out.children).toEqual([])
  })
  it('parseVerdict pass', () => {
    const v = parseVerdict('```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```', 'main')
    expect(v).toEqual({ role: 'main', pass: true, blocking: [], comments: 'ok' })
  })
  it('parseVerdict unparseable => fail with blocking', () => {
    const v = parseVerdict('garbage', 'main')
    expect(v.pass).toBe(false)
    expect(v.blocking.length).toBeGreaterThan(0)
  })
  it('parseExecOutput falls back to raw text', () => {
    expect(parseExecOutput('did the thing').execStatus).toContain('did the thing')
    expect(parseExecOutput('```json\n{"execStatus":"done X"}\n```').execStatus).toBe('done X')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/parseOutput.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/parseOutput.ts
import type { NodeKind, NodePlan, Verdict } from './types.js'

/**
 * Fence tag each phase must wrap ITS ANSWER in. Generic ```json is reserved for
 * quoted context, so an answer is distinguishable from a recap of one.
 *
 * Selecting a block by "parses as JSON" or "is the newest" is not safe on its own.
 * Models echo the prompt before answering AND recap context after answering, and a
 * recap of a previous verdict has the same shape as this one's — so shape and
 * recency both mis-select it, silently turning a fail into a pass. The tag is what
 * actually separates answer from quotation.
 */
export const ANSWER_TAGS = { plan: 'plan', verdict: 'verdict', exec: 'exec' } as const
export type AnswerTag = (typeof ANSWER_TAGS)[keyof typeof ANSWER_TAGS]

type Candidate = { obj: Record<string, unknown>; tagged: boolean }

/** Every fenced block plus the bare-brace slice, parsed; unparseable ones dropped. */
const FENCE_RE = /```([A-Za-z]+)?[ \t]*\r?\n?([\s\S]*?)```/g

/**
 * First balanced `{...}` that is NOT nested inside an array, or null.
 *
 * Naive first-`{`..last-`}` slicing cannot see brackets, so on prose like
 * `这是配置: [{"pass":true}]` it happily lifts an element out of a JSON array and
 * hands it back as the model's answer — which is how a rejected verdict became an
 * accepted one. Tracking bracket depth (and string literals, so a brace inside a
 * quoted value doesn't confuse the scan) is what makes the repair safe.
 */
function sliceTopLevelObject(t: string): string | null {
  let inStr = false
  let esc = false
  let bracket = 0
  let brace = 0
  let start = -1
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    else if (ch === '[') bracket++
    else if (ch === ']') { if (bracket > 0) bracket-- }
    else if (ch === '{') {
      if (brace === 0 && bracket === 0) start = i
      brace++
    } else if (ch === '}') {
      if (brace > 0) brace--
      if (brace === 0 && start !== -1) return t.slice(start, i + 1)
    }
  }
  return null
}

function collectCandidates(text: string, preferTag?: AnswerTag): Candidate[] {
  const tagged: string[] = []
  const generic: string[] = []
  for (const m of text.matchAll(FENCE_RE)) {
    const tag = (m[1] ?? '').toLowerCase()
    if (preferTag && tag === preferTag) tagged.push(m[2])
    else generic.push(m[2])
  }
  const out: Candidate[] = []
  const seen = new Set<string>()
  const consider = (raw: string, isTagged: boolean): void => {
    const t = raw.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      // Unparseable: try to salvage an object out of surrounding prose. This is a
      // REPAIR for broken text, never a way to reach inside valid JSON — it only
      // runs when the source failed to parse at all, and it refuses objects that
      // sit inside an array.
      const slice = sliceTopLevelObject(t)
      if (slice === null) return
      try { parsed = JSON.parse(slice) } catch { return }
    }
    // Valid JSON that isn't a plain object (an array, a number, a string) is not
    // an answer. Disqualify the whole source rather than digging into it: an
    // object inside an array is an element, not the model's reply.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const key = `${isTagged}:${JSON.stringify(parsed)}`
    if (seen.has(key)) return // the whole-text pass often re-captures a fence
    seen.add(key)
    out.push({ obj: parsed as Record<string, unknown>, tagged: isTagged })
  }
  // Newest first within each group: a correction supersedes an earlier draft.
  for (let i = tagged.length - 1; i >= 0; i--) consider(tagged[i], true)
  for (let i = generic.length - 1; i >= 0; i--) consider(generic[i], false)
  // Finally, prose OUTSIDE every fence — a model that answered without any fence.
  // Fenced regions are stripped first: their contents were already judged above on
  // their own terms, and re-slicing across them would mine an object out of a fence
  // whose real content is an array (an element is not an answer).
  consider(text.replace(FENCE_RE, ' '), false)
  return out
}

/** Best-effort object extraction with no shape or tag requirement. */
export function extractJsonBlock(text: string): unknown | null {
  return collectCandidates(text)[0]?.obj ?? null
}

/**
 * Answer selection: prefer the properly tagged answer; fall back to any block of
 * the right shape. Returns `ambiguous` when the fallback cannot tell two same-shaped
 * blocks apart, so safety-critical callers can fail closed instead of guessing.
 */
function pickAnswer(
  text: string,
  tag: AnswerTag,
  matches: (o: Record<string, unknown>) => boolean,
): { obj: Record<string, unknown> | null; ambiguous: boolean } {
  const candidates = collectCandidates(text, tag).filter(c => matches(c.obj))
  const tagged = candidates.filter(c => c.tagged)
  // Duplicates are ambiguous in BOTH groups. The tag says "this is my answer", so
  // two of them is still two answers — a model that re-tags a recap of a stale
  // verdict would otherwise win on recency, which is the exact failure this tag
  // was introduced to stop. Never let "it's tagged" substitute for "it's the only one".
  if (tagged.length > 0) return { obj: tagged[0].obj, ambiguous: tagged.length > 1 }
  if (candidates.length === 0) return { obj: null, ambiguous: false }
  // Untagged: the model ignored the output contract. One block is unambiguous;
  // several of the same shape are not — we cannot tell the answer from a recap.
  // A malformed (unparseable) tagged block lands here too: it never became a
  // candidate, so an honest typo degrades to the same tolerance as no tag at all.
  return { obj: candidates[0].obj, ambiguous: candidates.length > 1 }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  // A plan carries at least one plan-ish key; a bare echo of the goal has none.
  // Ambiguity is tolerated here: a wrong plan is caught by the review roundtable.
  const { obj } = pickAnswer(text, ANSWER_TAGS.plan, o => 'solution' in o || 'kind' in o || 'children' in o)
  const plan: NodePlan = {
    solution: str(obj?.solution, text.trim()),
    keyPoints: str(obj?.keyPoints),
    risks: str(obj?.risks),
    acceptance: str(obj?.acceptance),
  }
  const rawChildren = Array.isArray(obj?.children) ? (obj!.children as unknown[]) : []
  const children = rawChildren
    .map(c => {
      const co = c as Record<string, unknown>
      return { title: str(co?.title).trim(), deps: Array.isArray(co?.deps) ? (co!.deps as unknown[]).map(d => str(d)).filter(Boolean) : [] }
    })
    .filter(c => c.title.length > 0)
  const kind: NodeKind = obj?.kind === 'decompose' && children.length > 0 ? 'decompose' : 'executable'
  return { kind, plan, children }
}

export function parseVerdict(text: string, role: string): Verdict {
  // FAIL CLOSED. A verdict is the one output where guessing wrong in the "pass"
  // direction lets unfinished work through, so anything short of one unmistakable
  // verdict — none found, or two same-shaped blocks we cannot rank — is a rejection.
  // Costing an iteration is recoverable; silently accepting a stale pass is not.
  const { obj, ambiguous } = pickAnswer(text, ANSWER_TAGS.verdict, o => typeof o.pass === 'boolean')
  if (!obj) {
    return { role, pass: false, blocking: ['无法解析该角色的裁决输出;按不通过处理'], comments: text.trim().slice(0, 2000) }
  }
  if (ambiguous) {
    return {
      role,
      pass: false,
      blocking: [`回复中有多个裁决块,无法判定哪个是本轮结论;请只输出一个 \`\`\`${ANSWER_TAGS.verdict} 块,且位于回复末尾`],
      comments: text.trim().slice(0, 2000),
    }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string): { execStatus: string } {
  const { obj } = pickAnswer(text, ANSWER_TAGS.exec, o => typeof o.execStatus === 'string')
  if (obj) return { execStatus: str(obj.execStatus) }
  return { execStatus: text.trim() }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/parseOutput.test.ts`
Expected: PASS(10 条:含新增的两条 LAST-FENCE 断言)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/parseOutput.ts src/tools/efftask/parseOutput.test.ts
git commit -m "feat(efftask): tolerant phase-output parsing"
```

---

## Task 4: 提示词 → 配置解析

**Files:**
- Create: `src/tools/efftask/parseDirectives.ts`
- Test: `src/tools/efftask/parseDirectives.test.ts`

**Interfaces:**
- Consumes: `EffTaskConfig`, `DEFAULT_CAPS`, `DEFAULT_PARALLELISM`, `emptyPhaseRoles`, `PhaseName`, `PHASE_NAMES`(Task 1)。
- Produces: `type ModelJsonFn = (prompt: string) => Promise<string>`;`parseDirectives(rawPrompt, opts: { modelJson?: ModelJsonFn; knownRoles: string[] }): Promise<EffTaskConfig>`。
- 契约:用 `modelJson` 让主模型把自然语言指令抽成 JSON 建议值;解析出的角色名对照 `knownRoles` 校验(不存在→丢弃并回退该阶段为主模型);`parallelism`/`caps` 越界或缺失→默认;`modelJson` 未提供或抛错或返回非法→**全回退默认**(并行 5,各阶段空绑定=主模型),`goalPrompt` 恒为去除首行指令后的原文(P1 简单起见 `goalPrompt = rawPrompt.trim()`)。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/parseDirectives.test.ts
import { describe, expect, it } from 'bun:test'
import { parseDirectives } from './parseDirectives.js'

describe('parseDirectives', () => {
  it('no modelJson => all defaults', async () => {
    const cfg = await parseDirectives('随便做点事', { knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(5)
    expect(cfg.goalPrompt).toBe('随便做点事')
  })
  it('applies parsed roles filtered by knownRoles', async () => {
    const modelJson = async () => JSON.stringify({
      parallelism: 3,
      phaseRoles: { review: ['architect', 'ghost'], execute: ['coder'] },
      caps: { maxDepth: 4 },
    })
    const cfg = await parseDirectives('做需求 X', { modelJson, knownRoles: ['architect', 'coder'] })
    expect(cfg.parallelism).toBe(3)
    expect(cfg.phaseRoles.review).toEqual([{ roleName: 'architect' }]) // ghost dropped
    expect(cfg.phaseRoles.execute).toEqual([{ roleName: 'coder' }])
    expect(cfg.phaseRoles.plan).toEqual([])
    expect(cfg.caps.maxDepth).toBe(4)
    expect(cfg.caps.maxNodes).toBe(100) // untouched default
  })
  it('modelJson throws => defaults', async () => {
    const modelJson = async () => { throw new Error('boom') }
    const cfg = await parseDirectives('x', { modelJson, knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('modelJson returns garbage => defaults', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => 'not json', knownRoles: [] })
    expect(cfg.parallelism).toBe(5)
  })
  it('clamps out-of-range parallelism', async () => {
    const cfg = await parseDirectives('x', { modelJson: async () => JSON.stringify({ parallelism: 0 }), knownRoles: [] })
    expect(cfg.parallelism).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/parseDirectives.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/parseDirectives.ts
import { DEFAULT_CAPS, DEFAULT_PARALLELISM, emptyPhaseRoles, PHASE_NAMES } from './types.js'
import type { Caps, EffTaskConfig, RoleBinding } from './types.js'
import { extractJsonBlock } from './parseOutput.js'

export type ModelJsonFn = (prompt: string) => Promise<string>

const EXTRACT_PROMPT = `你是配置解析器。把下面的"高效任务"指令抽成 JSON,只输出一个 json 代码块,字段:
{ "parallelism": number, "phaseRoles": { "plan"?: string[], "review"?: string[], "execute"?: string[], "accept"?: string[], "observer"?: string[] },
  "caps": { "maxDepth"?: number, "maxNodes"?: number, "maxIterations"?: number } }
phaseRoles 的值是角色名数组。未提及的字段省略。指令:\n`

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

export async function parseDirectives(
  rawPrompt: string,
  opts: { modelJson?: ModelJsonFn; knownRoles: string[] },
): Promise<EffTaskConfig> {
  const base: EffTaskConfig = {
    goalPrompt: rawPrompt.trim(),
    parallelism: DEFAULT_PARALLELISM,
    phaseRoles: emptyPhaseRoles(),
    caps: { ...DEFAULT_CAPS },
  }
  if (!opts.modelJson) return base
  let obj: Record<string, unknown> | null = null
  try {
    obj = extractJsonBlock(await opts.modelJson(EXTRACT_PROMPT + rawPrompt)) as Record<string, unknown> | null
  } catch {
    return base
  }
  if (!obj) return base

  if (obj.parallelism !== undefined) base.parallelism = clampInt(obj.parallelism, 1, 64, DEFAULT_PARALLELISM)

  const known = new Set(opts.knownRoles)
  const pr = (obj.phaseRoles ?? {}) as Record<string, unknown>
  for (const phase of PHASE_NAMES) {
    const raw = pr[phase]
    if (!Array.isArray(raw)) continue
    // Dedupe: each entry is one seat at the roundtable, so a repeated name (an easy
    // thing for an extraction model to emit) would run that role twice and give its
    // verdict double weight.
    const names = new Set(
      raw
        .map(r => (typeof r === 'string' ? r.trim() : ''))
        .filter(name => name.length > 0 && known.has(name)),
    )
    const bindings: RoleBinding[] = [...names].map(name => ({ roleName: name }))
    base.phaseRoles[phase] = bindings
  }

  const caps = (obj.caps ?? {}) as Record<string, unknown>
  const c: Caps = { ...base.caps }
  if (caps.maxDepth !== undefined) c.maxDepth = clampInt(caps.maxDepth, 1, 20, DEFAULT_CAPS.maxDepth)
  if (caps.maxNodes !== undefined) c.maxNodes = clampInt(caps.maxNodes, 1, 5000, DEFAULT_CAPS.maxNodes)
  if (caps.maxIterations !== undefined) c.maxIterations = clampInt(caps.maxIterations, 1, 20, DEFAULT_CAPS.maxIterations)
  base.caps = c
  return base
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/parseDirectives.test.ts`
Expected: PASS(5 条)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/parseDirectives.ts src/tools/efftask/parseDirectives.test.ts
git commit -m "feat(efftask): prompt→config directive parsing"
```

---

## Task 5: 持久化(节点/清单读写 + runId + 树快照)

**Files:**
- Create: `src/tools/efftask/persistence.ts`
- Test: `src/tools/efftask/persistence.test.ts`

**Interfaces:**
- Consumes: `TaskNode`, `EffTaskConfig`, `createNode`, `emptyPhaseRoles`(Task 1);`uiStatus`(Task 2)。
- Produces:
  - `interface FsLike { readFile(p): Promise<string>; writeFile(p, data): Promise<void>; mkdir(p): Promise<void>; readdir(p): Promise<string[]>; exists(p): Promise<boolean> }`
  - `slugify(title): string`
  - `childId(parentId, index, title): string`
  - `allocateRunId(fs, effRoot): Promise<string>`（扫描 `effRoot` 取最大数字目录 +1,零填充 3 位;空/不存在→`'001'`）
  - `serializeNode(node): string` / `parseNodeFile(text): TaskNode`（YAML frontmatter 往返)
  - `writeNode(fs, runDir, node): Promise<void>`（写 `runDir/<node.id>/node.md`)
  - `readNode(fs, runDir, nodeId): Promise<TaskNode>`
  - `loadRun(fs, runDir): Promise<{ nodes: TaskNode[]; errors: {path,message}[] }>`（递归遍历 run 目录、读每个 `node.md`(经 `parseNodeFile`),返回全部节点;供 resume/审计)
  - `writeRunManifest(fs, runDir, cfg, nodes, result?): Promise<void>`（写 `runDir/run.md`;frontmatter 存 run 级 `createdAt`(取 root 节点 createdAt)+ cfg;`result`(可选,`{status, reason}`)只在收尾那次调用时传,把最终结局记进清单)
  - `renderTreeSnapshot(nodes): string`
- 说明:`node.id` 即相对路径(root='root',子='root/01-slug')。fs 注入,测试用内存假实现。
- **交接:`loadRun` / `readNode` 在 P1 只被产出+单测覆盖,真正的消费方是 P2 的 resume(崩溃恢复)路径。**故意在 P1 就把它们写完并测好,免得崩溃恢复能力被悄悄丢掉;P2 接线时须先做 `parseNodeFile` 的字段校验(见实现内注释)。
- **并发写序:** `run.md` 会被每次 `onUpdate` 触发重写。Task 11 必须把这些写串成**单条 promise 队列**(见 Task 11),不得对同一路径并发 `writeFile`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/persistence.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS } from './types.js'
import type { EffTaskConfig } from './types.js'
import { FsLike, slugify, childId, allocateRunId, serializeNode, parseNodeFile, writeNode, readNode, loadRun, writeRunManifest, renderTreeSnapshot } from './persistence.js'

const NOW = '2026-07-25T00:00:00Z'
function memFs(seed: Record<string, string> = {}): FsLike & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    store,
    async readFile(p) { const v = store.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v },
    async writeFile(p, data) { store.set(p, data) },
    async mkdir(p) { dirs.add(p) },
    async exists(p) { return store.has(p) || dirs.has(p) },
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : p + '/'
      const names = new Set<string>()
      for (const k of [...store.keys(), ...dirs]) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
  }
}

describe('persistence', () => {
  it('slugify & childId', () => {
    expect(slugify('设计 API Layer!')).toMatch(/api-layer/)
    expect(childId('root', 1, 'Do Thing')).toBe('root/01-do-thing')
  })
  it('allocateRunId increments zero-padded', async () => {
    expect(await allocateRunId(memFs(), '/eff')).toBe('001')
    const fs = memFs()
    await fs.mkdir('/eff/001'); await fs.mkdir('/eff/007')
    expect(await allocateRunId(fs, '/eff')).toBe('008')
  })
  it('serialize/parse node round-trips machine state', () => {
    const n = createNode({ id: 'root/01-x', title: 'X', parentId: 'root', deps: ['root/02-y'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    n.status = 'ACCEPTED'; n.kind = 'executable'; n.plan.solution = '方案文本'; n.score = { exec: { role: 'main', score: 88, rationale: 'ok' } }
    n.blockedReason = '评审迭代超限(3): [main] 缺验收点'
    const text = serializeNode(n)
    expect(text).toContain('## 阻断原因') // rendered in the body only when non-empty
    const parsed = parseNodeFile(text)
    expect(parsed.blockedReason).toBe('评审迭代超限(3): [main] 缺验收点')
    expect(parsed.id).toBe('root/01-x')
    expect(parsed.goal).toBe('X') // immutable goal round-trips via frontmatter {...node}
    expect(parsed.deps).toEqual(['root/02-y'])
    expect(parsed.status).toBe('ACCEPTED')
    expect(parsed.plan.solution).toBe('方案文本')
    expect(parsed.score.exec?.score).toBe(88)
  })
  it('writeNode/readNode go through fs at node.id path', async () => {
    const fs = memFs()
    const n = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeNode(fs, '/eff/001', n)
    expect(fs.store.has('/eff/001/root/node.md')).toBe(true)
    const back = await readNode(fs, '/eff/001', 'root')
    expect(back.title).toBe('根')
  })
  it('renderTreeSnapshot lists nodes with ui status', () => {
    const a = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    a.status = 'EXECUTING'
    const snap = renderTreeSnapshot([a])
    expect(snap).toContain('根')
    expect(snap).toContain('running')
  })
  it('loadRun walks the run dir recursively and returns all nodes (round-trip)', async () => {
    const fs = memFs()
    const runDir = '/eff/001'
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const c1 = createNode({ id: 'root/01-a', title: 'A', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    const c2 = createNode({ id: 'root/02-b', title: 'B', parentId: 'root', deps: ['root/01-a'], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    root.childIds = ['root/01-a', 'root/02-b']; root.status = 'WAITING_CHILDREN'
    c1.status = 'ACCEPTED'; c2.status = 'CREATED'
    for (const n of [root, c1, c2]) await writeNode(fs, runDir, n)
    const { nodes } = await loadRun(fs, runDir)
    const byId = new Map(nodes.map(n => [n.id, n]))
    expect(nodes).toHaveLength(3)
    expect(byId.get('root')!.status).toBe('WAITING_CHILDREN')
    expect(byId.get('root/01-a')!.status).toBe('ACCEPTED') // status preserved
    expect(byId.get('root/02-b')!.deps).toEqual(['root/01-a']) // deps preserved
  })
  it('writeRunManifest writes run.md with createdAt + config in frontmatter', async () => {
    const fs = memFs()
    const cfg: EffTaskConfig = { goalPrompt: '目标 X', parallelism: 3, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
    const root = createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    await writeRunManifest(fs, '/eff/001', cfg, [root])
    const text = fs.store.get('/eff/001/run.md')!
    expect(text).toContain('createdAt')
    expect(text).toContain(NOW) // run-level createdAt taken from the root node
    expect(text).toContain('goalPrompt')
    expect(text).toContain('parallelism: 3')
    // final call carries the run outcome
    await writeRunManifest(fs, '/eff/001', cfg, [root], { status: 'blocked', reason: '评审迭代超限' })
    const final = fs.store.get('/eff/001/run.md')!
    expect(final).toContain('status: blocked')
    expect(final).toContain('评审迭代超限')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/persistence.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import type { EffTaskConfig, TaskNode } from './types.js'
import { uiStatus } from './stateMachine.js'

export interface FsLike {
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  mkdir(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
  exists(p: string): Promise<boolean>
}

/**
 * Title → a safe single path segment. Strips anything that could escape the run
 * directory (`/`, `..`) by construction, since the result is used as a directory name.
 * Note: Windows device names (`con`, `aux`, …) survive; that is safe only because the
 * sole caller, childId, always prefixes `NN-`. Don't use slugify standalone for a path.
 */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-')
  // Array.from + slice on CODE POINTS: a plain .slice(0,40) can cut a surrogate pair in
  // half and produce a lone surrogate in a filesystem path. Trim separators AFTER
  // truncating — cutting at 40 can land right on one and leave a trailing dash.
  const cut = Array.from(s).slice(0, 40).join('').replace(/^-+|-+$/g, '')
  return cut || 'node'
}

/**
 * Child node id = parent id + `NN-slug`. The two-digit index only orders siblings
 * for human readability; the authoritative structure is each node's `childIds`, so a
 * parent with ≥100 children (impossible under DEFAULT_CAPS.maxNodes) would look
 * mis-sorted in a directory listing but still load correctly.
 * Uniqueness comes from the caller assigning distinct indices — same (index, title)
 * twice yields the same id, and writeNode would overwrite.
 */
export function childId(parentId: string, index: number, title: string): string {
  const nn = String(index).padStart(2, '0')
  return `${parentId}/${nn}-${slugify(title)}`
}

export async function allocateRunId(fs: FsLike, effRoot: string): Promise<string> {
  let max = 0
  // Read directly rather than gating on fs.exists(effRoot): mkdir() implementations
  // (real recursive mkdir, and the in-memory test fake) don't necessarily register an
  // entry for every ancestor path, so an exists() pre-check can false-negative even
  // when effRoot has numbered children.
  let names: string[] = []
  try {
    names = await fs.readdir(effRoot)
  } catch (e) {
    // A missing root is the normal first-run case → start at 001. But if the directory
    // IS there and merely unreadable, treating it as empty would hand out an id that
    // already exists and overwrite a previous run's tree — fail loudly instead.
    if (await fs.exists(effRoot)) throw e
    names = []
  }
  for (const name of names) {
    const m = name.match(/^(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return String(max + 1).padStart(3, '0')
}

// machine-state frontmatter fields (everything except derived human body)
export function serializeNode(node: TaskNode): string {
  const fm = { ...node }
  const body =
    `# ${node.title}\n\n` +
    `## 完整方案\n${node.plan.solution}\n\n` +
    `## 重点\n${node.plan.keyPoints}\n\n` +
    `## 风险点\n${node.plan.risks}\n\n` +
    `## 验收点\n${node.plan.acceptance}\n\n` +
    `## 执行状态\n${node.execStatus}\n\n` +
    (node.blockedReason ? `## 阻断原因\n${node.blockedReason}\n\n` : '') +
    `## 评审记录\n${node.reviewLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 验收记录\n${node.acceptLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 评分\nplan: ${node.score.plan?.score ?? '-'} / exec: ${node.score.exec?.score ?? '-'}\n`
  return `---\n${yamlStringify(fm)}---\n\n${body}`
}

export function parseNodeFile(text: string): TaskNode {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error('efftask: node.md missing frontmatter')
  // MOSTLY-UNVALIDATED CAST: yamlParse returns `any`-shaped data straight off disk. The
  // resume path reads user-editable / possibly-stale files and must still validate the
  // rest (status is a legal NodeStatus, deps/childIds are string[]) before feeding the
  // state machine — a malformed status would silently deadlock or skip the dependency gate.
  const node = yamlParse(m[1]) as TaskNode
  // Counters are normalised HERE because they are the one field whose absence is actively
  // dangerous rather than merely wrong: a file written by an older build has no
  // `integration` counter, and `undefined + 1` is NaN, which never satisfies
  // `>= maxIterations` — turning a bounded retry loop into an unbounded one that keeps
  // issuing real model calls. Missing counters read as 0, not as "no limit".
  const it = (node.iteration ?? {}) as Partial<TaskNode['iteration']>
  node.iteration = {
    planReview: Number.isFinite(it.planReview) ? (it.planReview as number) : 0,
    acceptance: Number.isFinite(it.acceptance) ? (it.acceptance as number) : 0,
    integration: Number.isFinite(it.integration) ? (it.integration as number) : 0,
  }
  return node
}

function nodeMdPath(runDir: string, nodeId: string): string {
  return `${runDir}/${nodeId}/node.md`
}

export async function writeNode(fs: FsLike, runDir: string, node: TaskNode): Promise<void> {
  await fs.mkdir(`${runDir}/${node.id}`)
  await fs.writeFile(nodeMdPath(runDir, node.id), serializeNode(node))
}

export async function readNode(fs: FsLike, runDir: string, nodeId: string): Promise<TaskNode> {
  return parseNodeFile(await fs.readFile(nodeMdPath(runDir, nodeId)))
}

/**
 * Recursively walk the run dir; every `node.md` becomes a TaskNode. The physical layout
 * mirrors node.id (runDir/<id>/node.md), so a DFS over subdirs recovers all nodes.
 *
 * A corrupt file never aborts the walk. This runs after a crash — a half-written
 * `node.md` is exactly what a crash leaves behind — so losing every successfully
 * recovered node because one sibling is truncated would defeat the purpose. Failures
 * are returned in `errors` for the caller to surface; they are not swallowed silently.
 */
export async function loadRun(
  fs: FsLike,
  runDir: string,
): Promise<{ nodes: TaskNode[]; errors: { path: string; message: string }[] }> {
  const nodes: TaskNode[] = []
  const errors: { path: string; message: string }[] = []
  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try { entries = await fs.readdir(dir) } catch { return } // not a dir (e.g. a file) → skip
    for (const name of entries) {
      const path = `${dir}/${name}`
      if (name === 'node.md') {
        try {
          nodes.push(parseNodeFile(await fs.readFile(path)))
        } catch (e) {
          errors.push({ path, message: e instanceof Error ? e.message : String(e) })
        }
      } else {
        await walk(path) // recurse into child node dirs; non-dirs (run.md) readdir-throw and skip
      }
    }
  }
  await walk(runDir)
  return { nodes, errors }
}

/**
 * Indented tree text for run.md. Walks parent→children from the roots rather than
 * trusting array order: loadRun's order comes from readdir, which no filesystem
 * guarantees, and printing a child before its parent renders a structurally wrong tree.
 * Orphans (parent missing/corrupt) are printed last so nothing is silently dropped.
 */
export function renderTreeSnapshot(nodes: TaskNode[]): string {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const seen = new Set<string>()
  const lines: string[] = []
  const emit = (n: TaskNode, depth: number): void => {
    if (seen.has(n.id)) return // defensive: a cyclic parent/child link must not hang the render
    seen.add(n.id)
    lines.push(`${'  '.repeat(depth)}- [${uiStatus(n.status)}] ${n.title} (${n.status})`)
    for (const cid of n.childIds) {
      const child = byId.get(cid)
      if (child) emit(child, depth + 1)
    }
  }
  for (const n of nodes) if (n.parentId === null) emit(n, 0)
  for (const n of nodes) if (!seen.has(n.id)) emit(n, n.depth)
  return `# Efficient Task Run\n\n${lines.join('\n')}\n`
}

export async function writeRunManifest(
  fs: FsLike,
  runDir: string,
  cfg: EffTaskConfig,
  nodes: TaskNode[],
  // Final run outcome, written only on the last call so run.md records how the run ended.
  result?: { status: 'completed' | 'blocked'; reason?: string },
): Promise<void> {
  // run-level createdAt from the root node (fallback: first node) for a stable manifest timestamp.
  const createdAt = nodes.find(n => n.parentId === null)?.createdAt ?? nodes[0]?.createdAt ?? ''
  const header = `---\n${yamlStringify({
    createdAt,
    parallelism: cfg.parallelism,
    phaseRoles: cfg.phaseRoles,
    caps: cfg.caps,
    goalPrompt: cfg.goalPrompt,
    ...(result ? { status: result.status, reason: result.reason ?? '' } : {}),
  })}---\n\n`
  await fs.mkdir(runDir)
  await fs.writeFile(`${runDir}/run.md`, header + renderTreeSnapshot(nodes))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/persistence.test.ts`
Expected: PASS(7 条:含 `blockedReason` 往返 + `## 阻断原因` 正文 + `run.md` 最终 `{status,reason}`)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/persistence.ts src/tools/efftask/persistence.test.ts
git commit -m "feat(efftask): md persistence, runId, tree snapshot"
```

---

## Task 6: 圆桌合成 + 单阶段圆桌执行

**Files:**
- Create: `src/tools/efftask/roundtable.ts`
- Test: `src/tools/efftask/roundtable.test.ts`

**Interfaces:**
- Consumes: `TaskNode`, `Verdict`, `RoundtableRecord`, `RoleBinding`, `PhaseName`(Task 1);`parseVerdict`(Task 3)。
- Produces:
  - `type RunAgentFn = (req: { phase: PhaseName; node: TaskNode; role: RoleBinding | null; system: string; prompt: string; cwd?: string; signal: AbortSignal; onChunk?: (t: string) => void }) => Promise<string>`
  - `synthesizeVerdicts(verdicts): { pass: boolean; blockingSummary: string }`（全票通过才 pass;汇总所有 blocking)
  - `runRoundtable(args: { phase: 'review' | 'accept'; node: TaskNode; roles: RoleBinding[]; round: number; system: string; prompt: string; runAgent: RunAgentFn; signal: AbortSignal }): Promise<RoundtableRecord>`（对每个角色并行独立调用 `runAgent`→`parseVerdict`;`roles` 为空时退化为单个 `main` 角色 role=null)

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/roundtable.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { synthesizeVerdicts, runRoundtable, RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const node = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('roundtable', () => {
  it('synthesizeVerdicts unanimous pass', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: true, blocking: [], comments: '' }])
    expect(s.pass).toBe(true)
  })
  it('synthesizeVerdicts any fail => fail with summary', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: true, blocking: [], comments: '' }, { role: 'b', pass: false, blocking: ['X 缺失'], comments: '' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('X 缺失')
  })
  it('synthesizeVerdicts: fail with NO blocking items falls back to comments (never empty)', () => {
    const s = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '方案太粗,缺落地步骤' }])
    expect(s.pass).toBe(false)
    expect(s.blockingSummary).toContain('方案太粗') // empty feedback => identical re-prompt => burned iterations
    const s2 = synthesizeVerdicts([{ role: 'a', pass: false, blocking: [], comments: '   ' }])
    expect(s2.blockingSummary.length).toBeGreaterThan(0) // still non-empty even without comments
  })
  it('runRoundtable with empty roles uses a single main reviewer', async () => {
    const calls: (string | null)[] = []
    const runAgent: RunAgentFn = async req => { calls.push(req.role ? req.role.roleName : null); return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [], round: 1, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(calls).toEqual([null])
    expect(rec.verdicts).toHaveLength(1)
    expect(rec.synthesized.pass).toBe(true)
  })
  it('runRoundtable multiple roles: any blocking fails', async () => {
    const runAgent: RunAgentFn = async req =>
      req.role?.roleName === 'sec'
        ? '```json\n{"pass":false,"blocking":["注入风险"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'sec' }], round: 2, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(rec.round).toBe(2)
    expect(rec.verdicts).toHaveLength(2)
    expect(rec.synthesized.pass).toBe(false)
    expect(rec.synthesized.blockingSummary).toContain('注入风险')
  })
  it('runRoundtable: a rejected role becomes a synthesized failing verdict, does NOT throw', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.role?.roleName === 'boom') throw new Error('调用崩溃')
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const rec = await runRoundtable({ phase: 'review', node: node(), roles: [{ roleName: 'arch' }, { roleName: 'boom' }], round: 1, system: 's', prompt: 'p', runAgent, signal: new AbortController().signal })
    expect(rec.verdicts).toHaveLength(2)
    const boom = rec.verdicts.find(v => v.role === 'boom')!
    expect(boom.pass).toBe(false)
    expect(boom.blocking[0]).toContain('角色调用失败')
    expect(rec.synthesized.pass).toBe(false) // synthesized reflects the failing reviewer
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/roundtable.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/roundtable.ts
import type { PhaseName, RoleBinding, RoundtableRecord, TaskNode, Verdict } from './types.js'
import { parseVerdict } from './parseOutput.js'

export type RunAgentFn = (req: {
  phase: PhaseName
  node: TaskNode
  role: RoleBinding | null
  system: string
  prompt: string
  cwd?: string
  signal: AbortSignal
  onChunk?: (t: string) => void
}) => Promise<string>

export function synthesizeVerdicts(verdicts: Verdict[]): { pass: boolean; blockingSummary: string } {
  const failing = verdicts.filter(v => !v.pass || v.blocking.length > 0)
  const pass = verdicts.length > 0 && failing.length === 0
  const blockingSummary = failing
    .flatMap(v =>
      // A verdict can fail (pass:false) with an EMPTY blocking list. Falling back to its
      // comments keeps blockingSummary non-empty — otherwise the revision loop re-prompts
      // with identical text and deterministically burns every iteration for nothing.
      v.blocking.length > 0
        ? v.blocking.map(b => `[${v.role}] ${b}`)
        : v.comments.trim()
          ? [`[${v.role}] ${v.comments.trim()}`]
          : [`[${v.role}] 未通过但未给出具体阻断项`],
    )
    .join('; ')
  return { pass, blockingSummary }
}

export async function runRoundtable(args: {
  phase: 'review' | 'accept'
  node: TaskNode
  roles: RoleBinding[]
  round: number
  system: string
  prompt: string
  runAgent: RunAgentFn
  signal: AbortSignal
}): Promise<RoundtableRecord> {
  // Already aborted → don't burn a real model call; synthesize a failing record instead.
  if (args.signal.aborted) {
    const verdicts: Verdict[] = [{ role: 'main', pass: false, blocking: ['已中断'], comments: '' }]
    return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
  }
  // Empty roster => a single main-model reviewer (role=null). Independent & parallel.
  const roster: (RoleBinding | null)[] = args.roles.length > 0 ? args.roles : [null]
  // Promise.allSettled so a single reviewer's runAgent REJECTION does not throw out
  // of the whole roundtable. Fulfilled path is identical (parseVerdict); a rejected
  // reviewer is synthesized into a failing verdict instead.
  const settled = await Promise.allSettled(
    roster.map(role =>
      args.runAgent({ phase: args.phase, node: args.node, role, system: args.system, prompt: args.prompt, signal: args.signal }),
    ),
  )
  const verdicts: Verdict[] = settled.map((res, i) => {
    const role = roster[i]
    const roleName = role ? role.roleName : 'main'
    if (res.status === 'fulfilled') return parseVerdict(res.value, roleName)
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason)
    // infra: the reviewer never judged anything, the CALL failed. Flagged so the caller
    // retries the review instead of reading it as a rejection and redoing real work.
    return { role: roleName, pass: false, blocking: ['角色调用失败: ' + reason], comments: '', infra: true }
  })
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/roundtable.test.ts`
Expected: PASS(6 条:含新增的"失败但无 blocking ⇒ 回退 comments,摘要永不为空")。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/roundtable.ts src/tools/efftask/roundtable.test.ts
git commit -m "feat(efftask): roundtable synthesis (independent + unanimous)"
```

---

## Task 7: 单节点宏步骤(plan+review / execute+accept / integrate)

**Files:**
- Create: `src/tools/efftask/pipeline.ts`
- Test: `src/tools/efftask/pipeline.test.ts`

**Interfaces:**
- Consumes: 全部前序类型;`parsePlanOutput`/`parseExecOutput`(Task 3);`runRoundtable`/`RunAgentFn`(Task 6);`childId`(Task 5);**`hasCycle`(Task 2)**;`createNode`(Task 1)。
- Produces:
  - `interface PipelineCtx { config: EffTaskConfig; byId: Map<string, TaskNode>; runAgent: RunAgentFn; persist: (n: TaskNode) => Promise<void>; now: () => string; signal: AbortSignal; onUpdate: () => void }`
  - `stepStart(node, ctx): Promise<void>` — 主模型或 plan 角色出方案 → `parsePlanOutput` → 写 `plan/kind`;圆桌评审(review 角色);不通过且 `iteration.planReview < caps.maxIterations` → 回 PLANNING 带**上一版方案 + 阻断意见**重出方案;耗尽 → `blockWithReason(评审迭代超限(N): …)`。通过后:decompose→**若 `depth+1 > caps.maxDepth` 则把子标题折进 `plan.solution` 后强制 executable→READY(不建子节点)**,否则创建声明的子节点(`childId`,deps 映射到兄弟 id)、父置 WAITING_CHILDREN;executable→置 READY。**硬化:开头 abort 检查;`ctx.runAgent`(plan)包 try/catch,抛错或调用后 `signal.aborted` → `blockWithReason` 返回。**
  - `stepExecute(node, ctx): Promise<void>` — EXECUTING:execute 角色/主模型执行(P1 共享 cwd)→`parseExecOutput`→EXECUTED→圆桌验收(accept 角色);不通过且未耗尽迭代→REWORK 重执行(**把 `blockingSummary` + 上一轮 `execStatus` 喂回执行提示词**);耗尽→`blockWithReason(验收迭代超限(N): …)`;通过→(P1 跳过 observer 评分)→(P1 MERGE 为 noop)→ACCEPTED。**硬化:开头 abort 检查;`ctx.runAgent`(execute)包 try/catch,抛错或 abort → `blockWithReason`。**
  - `stepIntegrate(node, ctx): Promise<void>` — 开头 abort 检查;INTEGRATION_ACCEPT:用**专用的 `integratePrompt`**(父目标 + 父验收点 + 每个子节点的 `{title, status, execStatus, acceptance}` 证据块)做圆桌验收(accept 角色);通过→ACCEPTED;**不通过→与 `stepExecute` 同形的有界重试**(`iteration.acceptance++`,未耗尽则带失败反馈重跑集成圆桌),耗尽才 `blockWithReason(集成验收迭代超限(N): …)`。
  - 内部:`planPrompt(node, ctx, feedback?)` / `executePrompt(node, ctx, feedback?)` / `reviewPrompt(node)` / `acceptPrompt(node)` / `integratePrompt(node, ctx, feedback?)` / `depsSection(node, ctx)` / `blockWithReason(node, reason, ctx)` / `createChildren(node, specs, ctx): Promise<CreateResult>`。
- 说明:每步内部在关键状态转移后调用 `ctx.persist(node)` + `ctx.onUpdate()`。
- **`blockWithReason` 只写 `node.blockedReason`,绝不覆盖 `node.execStatus`**——execStatus 里可能存着已完成工作的证据,验收/审计都要用。
- **依赖可见性:** `planPrompt`/`executePrompt` 对有 `deps` 的节点追加一段依赖清单(经 `ctx.byId` 查出每个 dep 的 `{title, execStatus}`),让节点知道上游产出了什么;因此这两个提示词函数签名都带 `ctx`。
- **子节点继承目标:** `createChildren` 给子节点传**组合目标**(父目标 + 上级方案要点截断 500 字 + 本子任务标题),而不是光秃秃的 title。
- 子节点 deps 映射:plan 输出的 child.deps 是**兄弟标题**,创建时映射为对应兄弟的 id(找不到的标题丢弃;等于自身 id 的自引用也丢弃)。**重复子标题按 title 绑依赖时绑到最后一个同名子(minor,已接受)。**
- `createChildren` 返回 `{ok:true} | {ok:false, reason, retryable}`,**失败时一个子节点都不写进 `ctx.byId`/`node.childIds`**(先在本地数组建好、过闸后才落库,零残留):
  - `byId.size + specs.length > caps.maxNodes` → `{ok:false, reason:'节点数超过上限', retryable:false}` → 父节点直接 BLOCKED。
  - `hasCycle(created)`(Task 2)→ `{ok:false, reason:'子任务依赖成环,请重新给出无环的子任务依赖', retryable:true}` → **不杀 run**:按"评审失败"处理,`iteration.planReview++` 并把该 reason 当 feedback 回到 plan 循环重新拆分;只有迭代上限耗尽才把父节点 BLOCKED(reason 含 `依赖成环`)。
- `node.md` 的 Markdown 正文仅供展示,frontmatter 才是权威状态。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/pipeline.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap } from './stateMachine.js'
import { PipelineCtx, stepStart, stepExecute, stepIntegrate } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg: EffTaskConfig = { goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
function ctxFor(
  nodes: TaskNode[],
  runAgent: RunAgentFn,
  config: EffTaskConfig = cfg,
  signal: AbortSignal = new AbortController().signal,
): PipelineCtx {
  return { config, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW, signal, onUpdate: () => {} }
}
const root = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

describe('pipeline', () => {
  it('stepStart executable => plan passes review => READY', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"do it","keyPoints":"k","risks":"r","acceptance":"a"}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.kind).toBe('executable')
    expect(n.status).toBe('READY')
    expect(n.plan.solution).toBe('do it')
    expect(n.reviewLog).toHaveLength(1)
  })

  it('stepStart decompose => creates children with mapped deps => WAITING_CHILDREN', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","keyPoints":"","risks":"","acceptance":"","children":[{"title":"AA","deps":[]},{"title":"BB","deps":["AA"]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('WAITING_CHILDREN')
    expect(n.childIds).toEqual(['root/01-aa', 'root/02-bb'])
    const bb = ctx.byId.get('root/02-bb')!
    expect(bb.deps).toEqual(['root/01-aa']) // sibling title mapped to sibling id
    expect(bb.depth).toBe(1)
  })

  it('createChildren: child goal composes the PARENT goal, not just the child title', async () => {
    const n = createNode({ id: 'root', title: 'r', goal: '交付高效任务模式骨架', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","keyPoints":"要点K","risks":"","acceptance":"","children":[{"title":"AA","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    const aa = ctx.byId.get('root/01-aa')!
    expect(aa.goal).toContain('交付高效任务模式骨架') // parent goal inherited, not lost
    expect(aa.goal).toContain('要点K') // parent plan key points carried down
    expect(aa.goal).toContain('AA') // plus this child's own slice
  })

  it('stepStart review fails until iterations exhausted => BLOCKED with a reason', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"weak"}\n```'
        : '```json\n{"pass":false,"blocking":["缺验收点"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.planReview).toBe(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('评审迭代超限') // reason recorded, execStatus untouched
    expect(n.blockedReason).toContain('缺验收点')
    expect(n.execStatus).toBe('')
  })

  it('stepExecute executable => execute + accept pass => ACCEPTED', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const runAgent: RunAgentFn = async req =>
      req.phase === 'execute'
        ? '```json\n{"execStatus":"changed files"}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"good"}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.execStatus).toBe('changed files')
    expect(n.status).toBe('ACCEPTED')
    expect(n.acceptLog).toHaveLength(1)
  })

  it('stepExecute accept fails until exhausted => BLOCKED, execStatus evidence preserved', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const runAgent: RunAgentFn = async req =>
      req.phase === 'execute' ? '```json\n{"execStatus":"改了 foo.ts"}\n```' : '```json\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.acceptance).toBe(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('验收迭代超限')
    expect(n.execStatus).toBe('改了 foo.ts') // completed-work evidence NOT clobbered by the block
  })

  it('stepStart: runAgent throws in plan phase => node BLOCKED with recorded reason', async () => {
    const n = root()
    const runAgent: RunAgentFn = async () => { throw new Error('模型调用失败') }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('模型调用失败')
  })

  it('stepStart: pre-aborted signal => BLOCKED with the abort reason, no model call', async () => {
    const n = root()
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    const runAgent: RunAgentFn = async () => { calls++; return '' }
    const ctx = ctxFor([n], runAgent, cfg, ac.signal)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toBe('已中断')
    expect(calls).toBe(0) // aborted before spending a single token
  })

  it('stepStart: node-count cap => parent BLOCKED with 节点数超过上限, no children created', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const capped: EffTaskConfig = { ...cfg, caps: { ...DEFAULT_CAPS, maxNodes: 1 } } // 1 (root) + 1 child > 1
    const ctx = ctxFor([n], runAgent, capped)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('节点数超过上限')
    expect(n.childIds).toEqual([])
    expect(ctx.byId.size).toBe(1) // never silently truncate: zero partial children
  })

  it('stepStart: depth cap forces decompose→executable, child titles survive into plan.solution', async () => {
    const n = root() // depth 0
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":[]},{"title":"BB","deps":[]}]}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
    const capped: EffTaskConfig = { ...cfg, caps: { ...DEFAULT_CAPS, maxDepth: 0 } } // depth+1 (=1) > 0
    const ctx = ctxFor([n], runAgent, capped)
    await stepStart(n, ctx)
    expect(n.kind).toBe('executable')
    expect(n.status).toBe('READY')
    expect(n.childIds).toEqual([]) // no children created past the cap
    expect(n.plan.solution).toContain('已达最大深度') // work folded in, not silently dropped
    expect(n.plan.solution).toContain('AA')
    expect(n.plan.solution).toContain('BB')
  })

  it('stepStart: sibling dependency cycle replans (bounded), exhausted => parent BLOCKED, zero children', async () => {
    const n = root()
    const planPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'plan') return '```json\n{"pass":true,"blocking":[],"comments":""}\n```'
      planPrompts.push(req.prompt)
      return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"AA","deps":["BB"]},{"title":"BB","deps":["AA"]}]}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.planReview).toBe(DEFAULT_CAPS.maxIterations) // replanned until the cap
    expect(n.blockedReason).toContain('依赖成环')
    expect(n.childIds).toEqual([])
    expect(ctx.byId.size).toBe(1) // NO partial children left behind on a rejected group
    expect(planPrompts[1]).toContain('成环') // the cycle was fed back as revision feedback
  })

  it('stepStart: review fails once then passes => READY, revision prompt shows the previous plan', async () => {
    const n = root()
    let reviewCalls = 0
    const planPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { planPrompts.push(req.prompt); return '```json\n{"kind":"executable","solution":"写入 hello.txt","acceptance":"a"}\n```' }
      reviewCalls++
      return reviewCalls === 1
        ? '```json\n{"pass":false,"blocking":["补充验收点"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('READY')
    expect(n.iteration.planReview).toBe(1) // one failed round before passing
    expect(n.reviewLog).toHaveLength(2)
    expect(planPrompts[1]).toContain('补充验收点') // blocking feedback threaded in
    expect(planPrompts[1]).toContain('写入 hello.txt') // ...alongside the plan being revised
  })

  it('stepExecute: accept fails once (REWORK) then passes => ACCEPTED, rework prompt carries feedback + prior execStatus', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let acceptCalls = 0
    const execPrompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') { execPrompts.push(req.prompt); return '```json\n{"execStatus":"改了 foo.ts"}\n```' }
      acceptCalls++
      return acceptCalls === 1
        ? '```json\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
        : '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    expect(n.iteration.acceptance).toBe(1) // one REWORK round before acceptance
    expect(n.acceptLog).toHaveLength(2)
    expect(execPrompts[1]).toContain('回归失败') // rework knows WHAT to fix
    expect(execPrompts[1]).toContain('改了 foo.ts') // ...and what was already done
  })

  it('stepIntegrate: sees child evidence and passes => ACCEPTED', async () => {
    const n = root(); n.status = 'WAITING_CHILDREN'; n.childIds = ['root/01-aa']
    n.plan.acceptance = '父验收点X'
    const child = createNode({ id: 'root/01-aa', title: 'AA', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    child.status = 'ACCEPTED'; child.execStatus = '子任务产出Y'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' }
    const ctx = ctxFor([n, child], runAgent)
    await stepIntegrate(n, ctx)
    expect(n.status).toBe('ACCEPTED')
    expect(n.acceptLog).toHaveLength(1)
    expect(prompts[0]).toContain('AA') // integratePrompt renders each child…
    expect(prompts[0]).toContain('子任务产出Y') // …with its execStatus evidence
    expect(prompts[0]).toContain('父验收点X') // …against the parent's acceptance criteria
  })

  it('stepIntegrate: integration acceptance fails until iterations exhausted => BLOCKED', async () => {
    const n = root(); n.status = 'WAITING_CHILDREN'; n.childIds = ['root/01-aa']
    const child = createNode({ id: 'root/01-aa', title: 'AA', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW })
    child.status = 'ACCEPTED'; child.execStatus = '子任务产出Y'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => { prompts.push(req.prompt); return '```json\n{"pass":false,"blocking":["子结果未达成父目标"],"comments":""}\n```' }
    const ctx = ctxFor([n, child], runAgent)
    await stepIntegrate(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.acceptance).toBe(DEFAULT_CAPS.maxIterations) // retried, not one-shot
    expect(n.acceptLog).toHaveLength(DEFAULT_CAPS.maxIterations)
    expect(n.blockedReason).toContain('集成验收迭代超限')
    expect(prompts[1]).toContain('子结果未达成父目标') // failure feedback appended on retry
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/pipeline.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/pipeline.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode } from './types.js'
import { ANSWER_TAGS, parseExecOutput, parsePlanOutput, type AnswerTag } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'
import { hasCycle, isTerminal } from './stateMachine.js'

export interface PipelineCtx {
  config: EffTaskConfig
  byId: Map<string, TaskNode>
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  signal: AbortSignal
  onUpdate: () => void
}

/**
 * Advance the node and make it durable. Returns false when the write failed — the caller
 * must stop immediately.
 *
 * A persist failure cannot be ignored: the orchestrator schedules off in-memory state, so
 * continuing would run work whose progress can never be recovered, and on-disk the node
 * would keep a stale (often transient) status forever. We mark it BLOCKED in memory so the
 * scheduler treats it as terminal rather than re-entering it every tick.
 */
async function commit(node: TaskNode, status: TaskNode['status'], ctx: PipelineCtx): Promise<boolean> {
  node.status = status
  node.updatedAt = ctx.now()
  try {
    await ctx.persist(node)
  } catch (e) {
    node.status = 'BLOCKED'
    node.blockedReason = `状态持久化失败: ${e instanceof Error ? e.message : String(e)}`
    safeUpdate(ctx)
    return false
  }
  safeUpdate(ctx)
  return true
}

// A crashing renderer must never take the run down with it.
function safeUpdate(ctx: PipelineCtx): void {
  try { ctx.onUpdate() } catch { /* UI failure is not a run failure */ }
}

type PhaseResult = { ok: true; text: string } | { ok: false; reason: string }
// Wraps a direct runAgent phase call (plan/execute). A throw OR an abort observed
// after the call yields ok:false with a reason; the caller hands it to blockWithReason,
// which records it into node.blockedReason and BLOCKs the node.
async function runPhase(ctx: PipelineCtx, req: Parameters<RunAgentFn>[0]): Promise<PhaseResult> {
  try {
    const text = await ctx.runAgent(req)
    if (ctx.signal.aborted) return { ok: false, reason: '已中断' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// Records WHY the node died in its own field. It must NOT touch node.execStatus, which may
// hold real completed-work evidence that acceptance/audit still needs.
async function blockWithReason(node: TaskNode, reason: string, ctx: PipelineCtx): Promise<void> {
  node.blockedReason = reason
  await commit(node, 'BLOCKED', ctx)
}

// True when a round failed only because reviewer CALLS failed, not because anyone judged
// the work. Retrying the review is right; redoing the executor's work would be wrong.
function isInfraOnlyFailure(rec: { verdicts: { pass: boolean; blocking: string[]; infra?: boolean }[] }): boolean {
  const failing = rec.verdicts.filter(v => !v.pass || v.blocking.length > 0)
  return failing.length > 0 && failing.every(v => v.infra === true)
}

// A node with deps must SEE what its dependencies produced, otherwise it replans from
// scratch and redoes upstream work.
function depsSection(node: TaskNode, ctx: PipelineCtx): string {
  if (node.deps.length === 0) return ''
  const lines = node.deps.map(id => {
    const d = ctx.byId.get(id)
    return d ? `- ${d.title}(${d.status}): ${d.execStatus || '(尚无执行状态)'}` : `- ${id}: (依赖节点缺失)`
  })
  return `已完成的依赖任务及其产出(基于这些结果继续,不要重复它们的工作):\n${lines.join('\n')}\n`
}

// OUTPUT DISCIPLINE — every phase prompt must end with answerRule(tag). The answer
// goes in a fence tagged with ITS phase tag (```plan / ```verdict / ```exec); plain
// ```json stays reserved for quoted context. That tag is the only thing that tells
// parseOutput "this is my answer" apart from "this is something I'm quoting" —
// shape and recency both mis-rank a same-shaped recap of a previous verdict, which
// is how a fail silently became a pass. parseVerdict additionally FAILS CLOSED when
// it sees two untagged verdict blocks, so an uncooperative model costs an iteration
// rather than letting unfinished work through.
function answerRule(tag: AnswerTag): string {
  return (
    `\n\n严格要求:把本次回答放进一个 \`\`\`${tag} 代码块里,整条回复中只能有这一个 ` +
    `\`\`\`${tag} 块,且必须位于回复的最末尾。引用上下文请用普通的 \`\`\`json 块。`
  )
}

function planPrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  const caps = ctx.config.caps
  return (
    `任务:${node.title}\n目标:${ctxGoal(node)}\n` +
    depsSection(node, ctx) +
    // The depth budget lives IN THE PROMPT so the model self-limits, instead of us
    // silently discarding the children it asked for once it hits the cap.
    `当前深度 ${node.depth}/上限 ${caps.maxDepth};已达上限时必须返回 kind=executable,不得再拆分。\n` +
    (feedback
      ? `上一版方案(就是它需要被修订):\n${JSON.stringify(node.plan)}\n上一轮评审阻断意见,请针对性修订:\n${feedback}\n`
      : '') +
    `请输出一个 json 代码块:{ "kind":"decompose"|"executable", "solution", "keyPoints", "risks", "acceptance", "children":[{"title","deps":["兄弟标题"]}] }。` +
    `能直接完成就 executable(children 省略);需要拆分就 decompose 并给出子任务标题与兄弟间依赖。` +
    answerRule(ANSWER_TAGS.plan)
  )
}
// Reference the IMMUTABLE node goal (set at creation), not the mutable plan.solution —
// otherwise the goal drifts every time the plan is re-emitted during review iterations.
function ctxGoal(node: TaskNode): string { return node.goal }

function reviewPrompt(node: TaskNode): string {
  return `请评审以下方案是否可执行、完整、无重大风险。方案:\n${JSON.stringify(node.plan)}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。有任何阻断问题填入 blocking。` + answerRule(ANSWER_TAGS.verdict)
}
function executePrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  return (
    `按以下方案执行任务并完成实际改动。方案:\n${JSON.stringify(node.plan)}\n` +
    depsSection(node, ctx) +
    // REWORK path: show the acceptance blockers AND what the previous round already did,
    // so the rerun is a targeted fix rather than a blind repeat.
    (feedback
      ? `上一轮验收未通过,阻断意见:\n${feedback}\n上一轮执行状态:\n${node.execStatus}\n请针对性返工。\n`
      : '') +
    `完成后输出:{ "execStatus":"做了什么、结果如何" }。` + answerRule(ANSWER_TAGS.exec)
  )
}
// Blank fields must READ as blank. Interpolating an empty acceptance/execStatus renders
// "验收点:\n执行状态:" — two empty slots a reviewer can wave through as satisfied.
function acceptPrompt(node: TaskNode): string {
  return (
    `请验收执行结果是否达成验收点。\n` +
    `验收点:${node.plan.acceptance || '(本节点未定义验收点,请依据目标判断:' + ctxGoal(node) + ')'}\n` +
    `执行状态:${node.execStatus || '(执行阶段没有报告任何产出,视为未完成)'}\n` +
    `输出:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(ANSWER_TAGS.verdict)
  )
}
// Integration acceptance judges CHILD evidence against the parent goal. acceptPrompt would
// show only the parent's own execStatus — which for a decompose node is empty.
function integratePrompt(node: TaskNode, ctx: PipelineCtx, feedback = ''): string {
  // A child missing from the map is REPORTED, not filtered away: silently shrinking the
  // evidence list would let a parent be accepted on the strength of the children that
  // happen to still be there.
  const children = node.childIds
    .map(id => {
      const c = ctx.byId.get(id)
      return c
        ? `### ${c.title}\n- 状态: ${c.status}\n- 执行状态: ${c.execStatus || '(无)'}\n- 验收点: ${c.plan.acceptance || '(无)'}`
        : `### ${id}\n- 状态: (节点缺失,无法核实其结果)`
    })
    .join('\n')
  return (
    `请验收"全部子任务的结果合起来是否达成本节点目标"。\n` +
    `父目标:${ctxGoal(node)}\n父验收点:${node.plan.acceptance || '(无)'}\n\n` +
    `子任务结果:\n${children || '(无子任务)'}\n\n` +
    (feedback ? `上一轮集成验收阻断意见,请复核是否已解决:\n${feedback}\n\n` : '') +
    `输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。` +
    answerRule(ANSWER_TAGS.verdict)
  )
}

// P1 runs a single planner/executor even if several are configured; only review and
// accept fan out into a roundtable. Extra plan/execute roles are deliberately ignored.
function firstRole(node: TaskNode, phase: 'plan' | 'execute') {
  return node.phaseRoles[phase][0] ?? null
}

// Re-entering a finished node would append a second verdict log and could flip a BLOCKED
// node to ACCEPTED. Terminal means terminal. (isTerminal is the state machine's own rule —
// don't restate it here, or the two definitions will drift.)
function isFinished(node: TaskNode): boolean {
  return isTerminal(node.status)
}

export async function stepStart(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
  // plan → review loop. A rejected child GROUP (dependency cycle) re-enters this same
  // loop, so replanning is bounded by the SAME maxIterations budget — a cycle costs a
  // retry, it does not instantly kill the run.
  for (;;) {
    if (!(await commit(node, 'PLANNING', ctx))) return
    const res = await runPhase(ctx, { phase: 'plan', node, role: firstRole(node, 'plan'), system: 'plan', prompt: planPrompt(node, ctx, feedback), signal: ctx.signal })
    if (!res.ok) { await blockWithReason(node, res.reason, ctx); return }
    const parsed = parsePlanOutput(res.text)
    node.kind = parsed.kind
    node.plan = parsed.plan
    const lastChildren = parsed.children
    if (!(await commit(node, 'PLAN_REVIEW', ctx))) return
    const rec = await runRoundtable({ phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1, system: 'review', prompt: reviewPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
    node.reviewLog.push(rec)
    // runRoundtable resolves even when the run was cancelled mid-flight (it collects
    // whatever settled). Without this the node would go on to commit READY/WAITING_CHILDREN
    // after the user already cancelled.
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (!rec.synthesized.pass) {
      node.iteration.planReview++
      feedback = rec.synthesized.blockingSummary
      if (node.iteration.planReview >= caps.maxIterations) {
        await blockWithReason(node, `评审迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
        return
      }
      continue
    }

    if (node.kind !== 'decompose') { await commit(node, 'READY', ctx); return }

    // Depth cap: force this node executable rather than decomposing. Do NOT silently drop
    // the children the model asked for — fold their titles into the solution so the work
    // survives as an in-node checklist.
    if (node.depth + 1 > caps.maxDepth) {
      // parsePlanOutput only reports 'decompose' when it parsed at least one child, so
      // lastChildren is non-empty here.
      node.plan.solution += `\n\n已达最大深度,不得再拆分,请在本节点内依次完成:${lastChildren.map(c => c.title).join('、')}`
      node.kind = 'executable'
      await commit(node, 'READY', ctx)
      return
    }

    const created = await createChildren(node, lastChildren, ctx)
    if (created.ok) { await commit(node, 'WAITING_CHILDREN', ctx); return }
    // Node-count cap and persist failures are fatal (retrying can't make room or fix the
    // disk); a dependency cycle is a planning mistake the model can correct.
    if (!created.retryable) { await blockWithReason(node, created.reason, ctx); return }
    node.iteration.planReview++
    feedback = created.reason
    if (node.iteration.planReview >= caps.maxIterations) {
      await blockWithReason(node, `拆分迭代超限(${caps.maxIterations}): ${created.reason}`, ctx)
      return
    }
  }
}

type CreateResult = { ok: true } | { ok: false; reason: string; retryable: boolean }

async function createChildren(node: TaskNode, specs: { title: string; deps: string[] }[], ctx: PipelineCtx): Promise<CreateResult> {
  // Node-count cap: if creating these children would exceed maxNodes, create NONE
  // (never silently truncate). Not retryable — replanning can't create budget.
  if (ctx.byId.size + specs.length > ctx.config.caps.maxNodes) {
    return { ok: false, reason: '节点数超过上限', retryable: false }
  }
  // Sibling deps are written as TITLES, so duplicate titles make every reference to them
  // ambiguous — including "does this node depend on itself?". Don't guess: hand it back as
  // a planning error the model can fix, the same way a dependency cycle is handled.
  const titles = specs.map(c => c.title)
  if (new Set(titles).size !== titles.length) {
    return { ok: false, reason: '子任务标题重复,依赖只能按标题引用,请给出互不相同的子任务标题', retryable: true }
  }
  // Map each dep title to the sibling's INDEX; resolving by index (not id) makes the
  // self-reference check exact.
  const titleToIndex = new Map<string, number>()
  specs.forEach((c, i) => titleToIndex.set(c.title, i))
  // Build the group in a LOCAL array first. Nothing touches ctx.byId / node.childIds until
  // the cycle guard passes, so a rejected group leaves ZERO partial state behind.
  const created: TaskNode[] = specs.map((c, i) => {
    const id = childId(node.id, i + 1, c.title)
    const deps = c.deps
      .map(t => titleToIndex.get(t))
      .filter((di): di is number => di !== undefined && di !== i) // unknown title / self-reference
      .map(di => childId(node.id, di + 1, specs[di].title))
    return createNode({
      id,
      title: c.title,
      // Children inherit a COMPOSED goal. A bare title strips all parent context and the
      // child then replans the wrong thing from nothing.
      goal: `${node.goal}\n> 上级方案要点: ${(node.plan.keyPoints || node.plan.solution).slice(0, 500)}\n> 本子任务: ${c.title}`,
      parentId: node.id,
      deps,
      depth: node.depth + 1,
      phaseRoles: node.phaseRoles,
      now: ctx.now(),
    })
  })
  // Cycle guard: sibling deps only reference siblings. A cyclic group is a PLANNING error,
  // so hand it back as retryable feedback instead of killing the branch.
  if (hasCycle(created)) {
    return { ok: false, reason: '子任务依赖成环,请重新给出无环的子任务依赖', retryable: true }
  }
  // Persist the whole group BEFORE attaching any of it. Attaching first and writing inside
  // the loop meant a failure on child 2 of 3 left a half-attached subtree in ctx.byId and
  // node.childIds — the exact partial state the local-array staging above exists to prevent.
  for (const child of created) {
    try {
      await ctx.persist(child)
    } catch (e) {
      return { ok: false, reason: `子节点持久化失败: ${e instanceof Error ? e.message : String(e)}`, retryable: false }
    }
  }
  for (const child of created) {
    ctx.byId.set(child.id, child)
    node.childIds.push(child.id)
  }
  // The parent's own durable point is the commit(WAITING_CHILDREN) that follows.
  safeUpdate(ctx)
  return { ok: true }
}

export async function stepExecute(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = '' // previous round's acceptance blockingSummary; drives the REWORK prompt
  let emptyReports = 0
  for (;;) {
    if (!(await commit(node, 'EXECUTING', ctx))) return
    // node.execStatus still holds the PREVIOUS round's result here (it's overwritten below),
    // which is exactly what executePrompt renders on rework.
    const res = await runPhase(ctx, { phase: 'execute', node, role: firstRole(node, 'execute'), system: 'execute', prompt: executePrompt(node, ctx, feedback), cwd: node.worktree?.path, signal: ctx.signal })
    if (!res.ok) { await blockWithReason(node, res.reason, ctx); return }
    const reported = parseExecOutput(res.text).execStatus.trim()
    // An executor that reports NOTHING has evidenced nothing. Sending a blank execStatus
    // into acceptance asks the reviewers to bless an empty slot — the one way a node can
    // reach ACCEPTED without any work having happened. Treat it as a failed round.
    if (reported === '') {
      emptyReports++
      node.iteration.acceptance++
      if (node.iteration.acceptance >= caps.maxIterations) {
        await blockWithReason(node, `执行阶段未报告任何产出(第 ${emptyReports} 次),已达迭代上限 ${caps.maxIterations}`, ctx)
        return
      }
      feedback = '上一轮执行没有报告任何产出。请真正执行任务,并在 execStatus 里写明具体做了什么、结果如何。'
      if (!(await commit(node, 'REWORK', ctx))) return
      continue
    }
    node.execStatus = reported

    // Acceptance loop. An infra-only failure (the reviewer CALL failed) retries just the
    // roundtable — redoing the executor's real work over a flaky connection would be wrong.
    // Those retries get their OWN bound: charging them to the rework budget would let a
    // flaky connection consume every attempt the executor was owed, exactly the coupling
    // that made integration need its own counter.
    let infraRetries = 0
    for (;;) {
      if (!(await commit(node, 'ACCEPTANCE', ctx))) return
      const rec = await runRoundtable({ phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1, system: 'accept', prompt: acceptPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
      node.acceptLog.push(rec)
      if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
      if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
      if (isInfraOnlyFailure(rec)) {
        infraRetries++
        if (infraRetries >= caps.maxIterations) {
          // Nobody ever judged the work — say that, rather than blaming the work.
          await blockWithReason(node, `验收角色连续 ${infraRetries} 次调用失败,未能取得任何裁决: ${rec.synthesized.blockingSummary}`, ctx)
          return
        }
        continue // retry the review only; the rework budget is untouched
      }
      node.iteration.acceptance++
      if (node.iteration.acceptance >= caps.maxIterations) {
        await blockWithReason(node, `验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
        return
      }
      feedback = rec.synthesized.blockingSummary
      break // genuine rejection → rework the execution
    }
    if (!(await commit(node, 'REWORK', ctx))) return
  }
}

export async function stepIntegrate(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  if (isFinished(node)) return
  if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
  const caps = ctx.config.caps
  let feedback = ''
  // Same bounded-retry shape as stepExecute: a single failed integration verdict must not
  // be terminal (the roundtable may simply have misread the evidence). Uses its OWN budget
  // so a node that spent `acceptance` elsewhere still gets a full integration allowance.
  for (;;) {
    if (!(await commit(node, 'INTEGRATION_ACCEPT', ctx))) return
    const rec = await runRoundtable({
      phase: 'accept', node, roles: node.phaseRoles.accept,
      round: node.iteration.integration + 1, system: 'integrate',
      prompt: integratePrompt(node, ctx, feedback), // child evidence, NOT acceptPrompt
      runAgent: ctx.runAgent, signal: ctx.signal,
    })
    node.acceptLog.push(rec)
    if (ctx.signal.aborted) { await blockWithReason(node, '已中断', ctx); return }
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
    node.iteration.integration++
    if (node.iteration.integration >= caps.maxIterations) {
      await blockWithReason(node, `集成验收迭代超限(${caps.maxIterations}): ${rec.synthesized.blockingSummary}`, ctx)
      return
    }
    feedback = rec.synthesized.blockingSummary
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/pipeline.test.ts`
Expected: PASS(全部 **15** 条:executable→READY / decompose 建子 / **子目标继承父目标** / 评审耗尽→BLOCKED(带 reason)/ execute+accept→ACCEPTED / 验收耗尽→BLOCKED(execStatus 保留)/ plan 抛错→BLOCKED / **预置 abort→BLOCKED 且零调用** / **节点数上限→BLOCKED 且零残留子** / 深度上限→executable **且子标题进 solution** / **兄弟成环有界重拆→耗尽才 BLOCKED、零残留子** / 评审失败一次后通过(修订提示词带上一版方案)/ 验收 REWORK 后通过(返工提示词带反馈+上轮 execStatus)/ **集成验收看到子证据并通过** / **集成验收耗尽→BLOCKED**)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/pipeline.ts src/tools/efftask/pipeline.test.ts
git commit -m "feat(efftask): per-node pipeline (plan/review, execute/accept, integrate)"
```

---

## Task 8: 串行编排驱动

**Files:**
- Create: `src/tools/efftask/orchestrator.ts`
- Test: `src/tools/efftask/orchestrator.test.ts`

**Interfaces:**
- Consumes: 全部前序;`advanceableKind`/`byIdMap`/**`isTerminal`**(Task 2);`stepStart`/`stepExecute`/`stepIntegrate`/`PipelineCtx`(Task 7);`createNode`/`emptyPhaseRoles`(Task 1,**直接从 `./types.js` 导入**——`persistence.ts` 不再做 re-export)。
- Produces:
  - `interface OrchestratorDeps { runAgent: RunAgentFn; persist: (n: TaskNode) => Promise<void>; now: () => string; onUpdate: (nodes: TaskNode[]) => void }`
  - `class EffTaskOrchestrator { constructor(cfg: EffTaskConfig, deps: OrchestratorDeps, signal: AbortSignal); nodes(): TaskNode[]; run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> }`
  - 驱动:创建 root(id `'root'`,title 取 `cfg.goalPrompt` 首行/截断);循环 `advanceableKind` 选**第一个**可推进节点(串行,排序用**逐码点比较**而非 `localeCompare`,避免依赖 locale/ICU)→ 按 kind 调 step*(包 try/catch:step 抛错→记 `blockedReason`;**若该节点是 `WAITING_CHILDREN` 且尚有非终态子节点,则保留其状态、不置 BLOCKED**(否则会误杀仍在推进的子树);其余情况置 BLOCKED,均不崩整轮);无可推进且 root 未 ACCEPTED → 死锁 → **先把 BLOCKED 向上传播:WAITING_CHILDREN 祖先 / 依赖被阻断的节点 / 依赖 id 在 `byId` 中缺失的悬垂节点(让树面板红得准确)**→ 返回 `{ status:'blocked', reason }`(reason 取 `root.blockedReason`);root ACCEPTED → `{ status:'completed' }`;`signal.aborted` → 先把 `PLANNING`/`EXECUTING`/`READY`/`CREATED` 这些非终态节点扫成 BLOCKED(reason `已中断`,末态树不留幻影 running)→ `{ status:'blocked', reason:'已中断' }`。节点数上限在 pipeline `createChildren` 前由 `byId.size` 检查(Task 7),超限即把待展开节点置 BLOCKED。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/orchestrator.test.ts
import { describe, expect, it } from 'bun:test'
import { emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig } from './types.js'
import { EffTaskOrchestrator } from './orchestrator.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg = (over: Partial<EffTaskConfig> = {}): EffTaskConfig => ({ goalPrompt: '构建功能', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS }, ...over })
const deps = (runAgent: RunAgentFn) => ({ runAgent, persist: async () => {}, now: () => NOW, onUpdate: () => {} })

describe('EffTaskOrchestrator (serial)', () => {
  it('single executable root: plan->review->execute->accept => completed', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') return '```json\n{"kind":"executable","solution":"s","acceptance":"a"}\n```'
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('completed')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('ACCEPTED')
  })

  it('decompose root with two children (dep chain) all accepted => completed', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"first","deps":[]},{"title":"second","deps":["first"]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') return '```json\n{"execStatus":"done"}\n```'
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('completed')
    const ids = orch.nodes().map(n => n.id).sort()
    expect(ids).toContain('root/01-first')
    expect(ids).toContain('root/02-second')
    expect(orch.nodes().every(n => n.status === 'ACCEPTED')).toBe(true)
  })

  it('dependency gating: second child not executed before first accepted', async () => {
    const execOrder: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"first","deps":[]},{"title":"second","deps":["first"]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'execute') { execOrder.push(req.node.id); return '```json\n{"execStatus":"done"}\n```' }
      return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    await orch.run()
    expect(execOrder).toEqual(['root/01-first', 'root/02-second'])
  })

  it('blocked plan (review always fails) => run returns blocked', async () => {
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan' ? '```json\n{"kind":"executable","solution":"weak"}\n```' : '```json\n{"pass":false,"blocking":["no"],"comments":""}\n```'
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    expect((await orch.run()).status).toBe('blocked')
  })

  it('BLOCKED propagates: a child that always fails acceptance => root ends BLOCKED, run returns blocked', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        if (req.node.id === 'root') return '```json\n{"kind":"decompose","solution":"s","children":[{"title":"only","deps":[]}]}\n```'
        return '```json\n{"kind":"executable","solution":"leaf","acceptance":"a"}\n```'
      }
      if (req.phase === 'review') return '```json\n{"pass":true,"blocking":[],"comments":"ok"}\n```' // plans pass review
      if (req.phase === 'execute') return '```json\n{"execStatus":"did"}\n```'
      return '```json\n{"pass":false,"blocking":["永远不过"],"comments":""}\n```' // child acceptance always fails → BLOCKED after maxIterations
    }
    const orch = new EffTaskOrchestrator(cfg(), deps(runAgent), new AbortController().signal)
    const result = await orch.run()
    expect(result.status).toBe('blocked')
    const child = orch.nodes().find(n => n.id === 'root/01-only')!
    expect(child.status).toBe('BLOCKED')
    const root = orch.nodes().find(n => n.id === 'root')!
    expect(root.status).toBe('BLOCKED') // propagated up from the BLOCKED child
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/orchestrator.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/orchestrator.ts
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode } from './types.js'
import { advanceableKind, byIdMap, isTerminal } from './stateMachine.js'
import { stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

export interface OrchestratorDeps {
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  onUpdate: (nodes: TaskNode[]) => void
}

function rootTitle(goal: string): string {
  // First NON-EMPTY line: a goal that opens with a blank line still has a real title.
  const line = goal.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  // Slice CODE POINTS, matching persistence.slugify — a UTF-16 slice can strand a lone
  // surrogate, and this title is rendered into run.md and into prompts.
  return Array.from(line).slice(0, 80).join('') || '根任务'
}

export class EffTaskOrchestrator {
  private byId: Map<string, TaskNode>
  constructor(private cfg: EffTaskConfig, private deps: OrchestratorDeps, private signal: AbortSignal) {
    // root goal = the FULL goalPrompt (title is only a truncated display label); ctxGoal
    // reads node.goal, so the plan prompt must see the whole objective, not the truncation.
    const root = createNode({ id: 'root', title: rootTitle(cfg.goalPrompt), goal: cfg.goalPrompt, parentId: null, deps: [], depth: 0, phaseRoles: cfg.phaseRoles, now: this.nowSafe() })
    this.byId = byIdMap([root])
  }

  nodes(): TaskNode[] { return [...this.byId.values()] }

  // run() must always RESOLVE with an outcome. Its failure handlers do I/O of their own, so
  // an ordinary disk error or a crashing renderer would otherwise reject the whole run —
  // and worst of all on the abort path, exactly when the user is bailing out of a broken
  // run and most needs a clean answer. Mirrors pipeline.ts's safeUpdate discipline.
  private async safePersist(n: TaskNode): Promise<void> {
    try { await this.deps.persist(n) } catch { /* durability lost; the in-memory status still stands */ }
  }
  private safeUpdate(): void {
    try { this.deps.onUpdate(this.nodes()) } catch { /* a crashing renderer is not a run failure */ }
  }
  // Last timestamp the injected clock actually produced. A failing clock falls back to it
  // rather than to '', which would land NaN in updatedAt and break elapsed-time rendering.
  private lastNow = ''
  private nowSafe(): string {
    try {
      this.lastNow = this.deps.now()
    } catch { /* keep the previous good value */ }
    return this.lastNow
  }

  private ctx(): PipelineCtx {
    return {
      config: this.cfg,
      byId: this.byId,
      runAgent: this.deps.runAgent,
      persist: this.deps.persist,
      now: this.deps.now,
      signal: this.signal,
      onUpdate: () => this.deps.onUpdate(this.nodes()),
    }
  }

  // A node under a BLOCKED ancestor can no longer contribute: its parent will never be
  // accepted, so running it spends real model calls and mutates the repo for a result
  // nothing will consume.
  private hasBlockedAncestor(node: TaskNode): boolean {
    const seen = new Set<string>()
    let cur = node.parentId ? this.byId.get(node.parentId) : undefined
    while (cur && !seen.has(cur.id)) {
      if (cur.status === 'BLOCKED') return true
      seen.add(cur.id)
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined
    }
    return false
  }

  async run(): Promise<{ status: 'completed' | 'blocked'; reason?: string }> {
    // No-progress guard: if the same node is picked twice in a row in the same STATUS it
    // did not move, and re-picking it forever would be a hot loop issuing real model calls.
    // Deliberately excludes updatedAt: every commit refreshes it, so including it would make
    // the fingerprint differ on every re-pick under a real clock and the guard would only
    // ever fire under a frozen test clock — insurance that holds nowhere it matters.
    // A node is picked at most once per status, and the one status that can repeat
    // (WAITING_CHILDREN via the subtreeAlive path) always has another node picked in
    // between, which resets lastPick — so this cannot false-positive on a healthy run.
    let lastPick = ''
    let stalls = 0
    for (;;) {
      const root = this.byId.get('root')!
      // Completion wins over abort: a tree that finished before the signal fired IS done,
      // and reporting 'blocked' would contradict what was persisted.
      if (root.status === 'ACCEPTED') return { status: 'completed' }
      if (this.signal.aborted) { await this.propagateBlocked(true); return { status: 'blocked', reason: '已中断' } }
      // pick the first advanceable node (serial). Deterministic order by id — a plain
      // codepoint compare, NOT localeCompare (which is locale/ICU-dependent).
      const ordered = [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      let kind: ReturnType<typeof advanceableKind> = null
      const next = ordered.find(n => {
        if (this.hasBlockedAncestor(n)) return false
        kind = advanceableKind(n, this.byId)
        return kind !== null
      })
      if (!next) {
        // deadlock: nothing advanceable and root not accepted. Surface WHY the tree is
        // dead by propagating BLOCKED upward before returning.
        await this.propagateBlocked(false)
        const reason = root.status === 'BLOCKED' ? (root.blockedReason || '根任务被阻断') : '存在无法推进的阻断节点'
        return { status: 'blocked', reason }
      }
      const fingerprint = `${next.id}|${next.status}`
      stalls = fingerprint === lastPick ? stalls + 1 : 0
      lastPick = fingerprint
      if (stalls >= 2) {
        next.status = 'BLOCKED'
        next.blockedReason = next.blockedReason || '节点未能推进(状态未变化),已阻断以避免空转'
        next.updatedAt = this.nowSafe()
        await this.safePersist(next)
        this.safeUpdate()
        continue
      }
      const ctx = this.ctx()
      try {
        if (kind === 'start') await stepStart(next, ctx)
        else if (kind === 'execute') await stepExecute(next, ctx)
        else if (kind === 'integrate') await stepIntegrate(next, ctx)
        else throw new Error(`efftask: unhandled advance kind ${String(kind)}`)
      } catch (e) {
        // A step should not normally throw (pipeline catches runAgent and persist errors),
        // but if one does, keep the run alive and drive this node to a terminal state.
        // Reachable in practice only via a transient deps.now() failure inside commit().
        const message = e instanceof Error ? e.message : String(e)
        // Do NOT clobber a parent whose subtree is still alive — BLOCKing it would strand
        // children that are still advanceable. Keep WAITING_CHILDREN only while at least
        // one child is non-terminal; otherwise this node would be re-picked forever.
        const subtreeAlive =
          next.status === 'WAITING_CHILDREN' &&
          next.childIds.length > 0 &&
          next.childIds.some(id => { const c = this.byId.get(id); return c !== undefined && !isTerminal(c.status) })
        // Only record a reason when we actually block; otherwise a recovered node would
        // carry a stale blockedReason into an ACCEPTED state.
        if (!subtreeAlive) {
          next.status = 'BLOCKED'
          next.blockedReason = message
        }
        next.updatedAt = this.nowSafe()
        await this.safePersist(next)
        this.safeUpdate()
      }
    }
  }

  // Fixpoint BLOCKED propagation: a non-terminal node with any BLOCKED child, any MISSING
  // child, any BLOCKED dep, or any DANGLING dep becomes BLOCKED. Repeat until stable so
  // death propagates up the tree. `aborted` additionally sweeps every non-terminal node so
  // the final tree shows no phantom "running" rows after an interrupt.
  private async propagateBlocked(aborted: boolean): Promise<void> {
    if (aborted) {
      // Sweep on !isTerminal rather than a status whitelist: every non-terminal status
      // renders as running/queued, and a whitelist silently misses PLAN_REVIEW, ACCEPTANCE,
      // INTEGRATION_ACCEPT, REWORK… (and any status added later).
      for (const n of this.byId.values()) {
        if (isTerminal(n.status)) continue
        n.status = 'BLOCKED'
        if (!n.blockedReason) n.blockedReason = '已中断'
        n.updatedAt = this.nowSafe()
        await this.safePersist(n)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const n of this.byId.values()) {
        if (isTerminal(n.status)) continue
        // Downward too: once an ancestor is BLOCKED its descendants can never contribute,
        // and the scheduler already refuses to run them. Leaving them CREATED/READY would
        // render the dead subtree as grey "queued" forever — the same complaint that the
        // abort sweep and the missing-child rule exist to answer.
        const parentBlocked = n.parentId !== null && this.byId.get(n.parentId)?.status === 'BLOCKED'
        const childBlocked = n.childIds.some(id => this.byId.get(id)?.status === 'BLOCKED')
        // A child id MISSING from byId can never be accepted, so childrenAllAccepted will
        // never be true and the parent would sit WAITING_CHILDREN (rendered as grey/queued)
        // forever. loadRun deliberately returns partial trees, so resume produces this shape.
        const childMissing = n.childIds.some(id => !this.byId.has(id))
        // A dep id MISSING from byId is a dangling edge that can never resolve — treat it
        // like a blocked dep instead of leaving the node queued forever.
        const depDangling = n.deps.some(id => !this.byId.has(id))
        const depBlocked = n.deps.some(id => this.byId.get(id)?.status === 'BLOCKED')
        if (parentBlocked || childBlocked || childMissing || depBlocked || depDangling) {
          n.status = 'BLOCKED'
          if (!n.blockedReason) {
            n.blockedReason = childBlocked ? '子节点阻断'
              : childMissing ? '子节点缺失'
                : depDangling ? '依赖节点缺失'
                  : depBlocked ? '依赖阻断'
                    : '上级任务阻断'
          }
          n.updatedAt = this.nowSafe()
          await this.safePersist(n)
          changed = true
        }
      }
    }
    this.safeUpdate()
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/orchestrator.test.ts`
Expected: PASS(全部 5 条:原 4 条 + BLOCKED 向上传播)。

- [ ] **Step 5: 全量回归 + 提交**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/
git add src/tools/efftask/orchestrator.ts src/tools/efftask/orchestrator.test.ts
git commit -m "feat(efftask): serial orchestrator driver with dependency gating"
```
Expected: 前 8 个测试文件全绿。

---

## Task 9: RunAgentFn 真实适配器

**Files:**
- Create: `src/tools/efftask/runAgentAdapter.ts`
- Test: `src/tools/efftask/runAgentAdapter.test.ts`(测纯函数 `pickAgentDefinition`/`collectText`,以及用注入的假 `runAgentImpl` 契约测 `makeRunAgentFn`;真实 `runAgent` 全链路靠 §Task 11 手动/UAT)

**Interfaces:**
- Consumes: `RunAgentFn`(Task 6);`RoleBinding`, `PhaseName`;`AgentDefinition`(现有 `src/tools/AgentTool/*`);`runAgent`(`src/tools/AgentTool/runAgent.ts`);`ToolUseContext`。
- Produces:
  - `pickAgentDefinition(role, activeAgents, mainModelDefault): AgentDefinition` — role 为 null → 主模型默认 agent def;否则从 `activeAgents` 按 `agentType===role.roleName` 找,找不到回退主模型默认。
  - `collectText(messages): string` — 从 runAgent 产出的 assistant 文本拼接。
  - `makeRunAgentFn(deps): RunAgentFn` — 用 `ToolUseContext` + `canUseTool` 包装 `runAgent()`,把每次调用的 assistant 文本收集返回;`promptMessages` 用 `createUserMessage`(`src/utils/messages.ts`)构造(无 `as unknown as` cast);`onChunk` 在收到文本增量时回调(供 P3 实时视图);`role.model` 传给 `runAgent` 的 `model`。**deps 含 `availableTools` 与 `readOnlyTools`:按阶段选工具——`execute` 用 `availableTools`(可写全池),其余阶段(plan/review/accept/observer)用 `readOnlyTools`,即"能读仓库、不能改仓库"。`readOnlyTools` 由调用方(Task 11)从 `context.options.tools` 里按名字筛出真只读工具(`Read`/`Glob`/`Grep`),不是空数组**——评审/验收若连仓库都读不到,裁决就只能凭空猜。**唯一传 `[]`(完全无工具)的是一次性的 `parseDirectives` 配置抽取调用**,它由 Task 11 另建一个 no-tools 的 `RunAgentFn` 承担。 deps 还有可选 `runAgentImpl`(默认真实 `runAgent`),供测试注入假异步生成器。
  - `req.cwd` → `runAgent` 的 **`worktreePath`**:`runAgent()` 没有 `cwd` 形参,只有 `worktreePath`。P1 恒为 `undefined`(共享 cwd),但接缝必须映射到真实字段,否则 P2 接 worktree 时会发现这是个哑参。

- [ ] **Step 1: 写失败测试(纯函数)**

```ts
// src/tools/efftask/runAgentAdapter.test.ts
import { describe, expect, it } from 'bun:test'
import { collectText, pickAgentDefinition, makeRunAgentFn } from './runAgentAdapter.js'

describe('runAgentAdapter helpers', () => {
  it('collectText concatenates assistant text blocks', () => {
    const messages: any[] = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use', name: 'x', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } },
      { type: 'user', message: { content: [] } },
    ]
    expect(collectText(messages)).toBe('hello world')
  })
  it('pickAgentDefinition returns main default for null role', () => {
    const main = { agentType: 'main', whenToUse: '', tools: undefined } as any
    expect(pickAgentDefinition(null, [], main)).toBe(main)
  })
  it('pickAgentDefinition finds role by agentType, falls back to main', () => {
    const main = { agentType: 'main' } as any
    const coder = { agentType: 'coder' } as any
    expect(pickAgentDefinition({ roleName: 'coder' }, [coder], main)).toBe(coder)
    expect(pickAgentDefinition({ roleName: 'ghost' }, [coder], main)).toBe(main)
  })

  it('makeRunAgentFn concatenates assistant text from an injected runAgentImpl', async () => {
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'part1 ' }] } }
      yield { type: 'user', message: { content: [] } } // non-assistant ignored
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'part2' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any, // fixture only: the injected runAgentImpl ignores tools
      readOnlyTools: [] as any, // (real wiring passes Read/Glob/Grep — see Task 11)
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fakeRun as any,
    })
    const text = await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: new AbortController().signal })
    expect(text).toBe('part1 part2')
  })

  it('makeRunAgentFn stops consuming once req.signal is aborted', async () => {
    const ac = new AbortController()
    ac.abort() // already aborted before the run starts
    async function* fakeRun(): AsyncGenerator<any> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }
    }
    const fn = makeRunAgentFn({
      toolUseContext: {} as any,
      canUseTool: (async () => ({ behavior: 'allow' })) as any,
      availableTools: [] as any, // fixture only: the injected runAgentImpl ignores tools
      readOnlyTools: [] as any, // (real wiring passes Read/Glob/Grep — see Task 11)
      activeAgents: [],
      mainModelDefault: { agentType: 'main' } as any,
      runAgentImpl: fakeRun as any,
    })
    const text = await fn({ phase: 'plan', node: {} as any, role: null, system: 's', prompt: 'p', signal: ac.signal })
    expect(text).toBe('first') // breaks after the first message; 'second' never consumed
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/runAgentAdapter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/runAgentAdapter.ts
import { runAgent } from '../AgentTool/runAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { createUserMessage } from '../../utils/messages.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { RunAgentFn } from './roundtable.js'

export function collectText(messages: Message[]): string {
  let out = ''
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    for (const block of (m.message.content as { type: string; text?: string }[])) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return out
}

export function pickAgentDefinition(
  role: { roleName: string } | null,
  activeAgents: AgentDefinition[],
  mainModelDefault: AgentDefinition,
): AgentDefinition {
  if (!role) return mainModelDefault
  return activeAgents.find(a => a.agentType === role.roleName) ?? mainModelDefault
}

export function makeRunAgentFn(deps: {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  availableTools: Tools
  // REAL read-only tools (Read/Glob/Grep), filtered from the parent pool by the caller.
  // NOT [] — plan/review/accept/observer must be able to READ the repo to judge anything;
  // they just must not be able to WRITE it. (The one-shot config-extraction call is the
  // only no-tools caller, and it gets its own RunAgentFn.)
  readOnlyTools: Tools
  activeAgents: AgentDefinition[]
  mainModelDefault: AgentDefinition
  runAgentImpl?: typeof runAgent // injectable for tests; defaults to the real runAgent
}): RunAgentFn {
  const run = deps.runAgentImpl ?? runAgent
  return async req => {
    const agentDefinition = pickAgentDefinition(req.role, deps.activeAgents, deps.mainModelDefault)
    // Per-phase tool gating: only the execute phase gets the write-capable tool pool.
    const tools: Tools = req.phase === 'execute' ? deps.availableTools : deps.readOnlyTools
    const promptMessages: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: `${req.system}\n\n${req.prompt}` }] }),
    ]
    // Forward cancellation INTO the sub-agent instead of only polling between messages:
    // otherwise an abort is invisible until the next yield, so a stall before the first
    // message is never noticed and a cancelled run keeps a live agent working.
    const inner = new AbortController()
    const relay = (): void => inner.abort()
    if (req.signal.aborted) inner.abort()
    else req.signal.addEventListener('abort', relay, { once: true })

    const collected: Message[] = []
    const invoke = (): AsyncGenerator<Message, void> =>
      run({
        agentDefinition,
        promptMessages,
        toolUseContext: deps.toolUseContext,
        canUseTool: deps.canUseTool,
        isAsync: false,
        querySource: 'agent:custom',
        // NOT validated: an unrecognized alias simply falls through to runAgent's own model
        // resolution (which applies its default). We do not pre-check the string here.
        model: req.role?.model as ModelAlias | undefined,
        availableTools: tools,
        // runAgent's `worktreePath` is METADATA ONLY — it is recorded for resume and does
        // NOT change the sub-agent's cwd (AgentTool does that separately via
        // runWithCwdOverride). So we both record it AND actually switch the cwd below;
        // passing it alone would let P2's worktree executor write into the shared tree.
        worktreePath: req.cwd,
        override: { abortController: inner },
      })

    // The WHOLE consumption must run inside the cwd override, not just the call that
    // creates the generator: runWithCwdOverride is AsyncLocalStorage-based, and a generator
    // body does not execute until its first next() — by which time a wrapper around the
    // factory call has already exited and pwd() would resolve to the shared cwd again.
    const consume = async (): Promise<void> => {
      for await (const message of invoke()) {
        collected.push(message)
        if (req.onChunk && message.type === 'assistant') {
          // A crashing renderer must not take the run down (same rule as pipeline/orchestrator).
          try { req.onChunk(collectText([message])) } catch { /* ignore */ }
        }
        if (req.signal.aborted) break
      }
    }
    try {
      await (req.cwd ? runWithCwdOverride(req.cwd, consume) : consume())
    } finally {
      req.signal.removeEventListener('abort', relay)
    }
    return collectText(collected)
  }
}
```

> **类型对齐(已定稿,无逃逸 cast):** `promptMessages` 用 `createUserMessage({ content: [{ type:'text', text }] })`(`src/utils/messages.ts`,返回 `UserMessage`,是 `Message` 联合的成员),不再手搓字面量、无 `as unknown as Message`。type-only 导入路径:`Message`←`../../types/message.js`、`ToolUseContext`/`Tools`←`../../Tool.js`、`CanUseToolFn`←`../../hooks/useCanUseTool.js`、`ModelAlias`←`../../utils/model/aliases.js`;VALUE 导入 `runAgent`←`../AgentTool/runAgent.js`、`AgentDefinition`←`../AgentTool/loadAgentsDir.js`(bun 会擦除 type-only import,但路径须正确)。`makeRunAgentFn` 契约现由注入 `runAgentImpl` 的单测覆盖;真实模型链路仍在 Task 11 手动跑 `/et` 验证。

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/runAgentAdapter.test.ts`
Expected: PASS(**5** 条:`collectText` 1 条 + `pickAgentDefinition` 2 条 + `makeRunAgentFn` 2 条契约测)。
另:确保 `makeRunAgentFn` 通过 bun 运行(type-only import 被擦除;真实 `Message`/`AgentDefinition` 类型对齐见上)——源码内不得留 `as unknown as` / `as any` 掩盖(测试文件里给假 `deps`/messages 的 `as any` 属测试夹具,允许)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/runAgentAdapter.ts src/tools/efftask/runAgentAdapter.test.ts
git commit -m "feat(efftask): runAgent adapter (RunAgentFn seam)"
```

---

## Task 10: 启动确认(终端 + 飞书竞速)

**Files:**
- Create: `src/tools/efftask/startupConfirm.ts`(纯竞速/合成逻辑,单测)
- Create: `src/tools/efftask/feishuStartupCard.ts`(飞书启动卡片 surface,集成代码,**复用 `AppState` 里的共享 `FeishuClient` + callbacks,不自建连接**,无单测——沿用本仓集成代码惯例)
- Create: `src/commands/efftask/ConfirmStartup.tsx`(Ink UI,手动验证)
- Test: `src/tools/efftask/startupConfirm.test.ts`

**Interfaces:**
- Consumes: `EffTaskConfig`, `PhaseName`, `PHASE_NAMES`(Task 1);`FeishuClient`(`src/services/feishu/FeishuClient.ts`,**仅取类型 + `sendCard`/`updateCard`**);`FeishuPermissionCallbacks`(`src/services/feishu/feishuPermissions.ts`);`logError`(`src/utils/log.ts`)。(`requestId` 由调用方 Task 11 用 `randomUUID()` 铸造后传进来。)
- Produces:
  - `interface StartupDecision { parallelism: number; approved: boolean }`
  - `createResolveOnce<T>(): { claim(): boolean; resolve(v: T): void; promise: Promise<T> }` — 单次胜出竞速原语(镜像 interactiveHandler 的 racer 语义)。
  - `rosterLines(config): string[]` — 把 `config.phaseRoles` 渲染成"阶段: 角色名"逐行文本(该阶段无绑定则为 `主模型`);终端卡片与飞书卡片共用同一份,保证两端名册一致(**spec gate-1 角色名册**)。
  - `raceConfirm(surfaces: Array<(claimAndResolve: (d: StartupDecision) => void) => (() => void)>): Promise<StartupDecision>` — 启动各 surface(终端/飞书),首个 `claimAndResolve` 胜出,其余被要求 teardown(返回的清理函数被调用)。**每个 `surface(...)` 调用单独包 try/catch:某个 surface 构造时抛错不得掀翻整场竞速,成功的那些照常收集 teardown。** **在 Task 11 以 `[terminalSurface, feishuSurface?]` 接线**。
  - (in `feishuStartupCard.ts`) `buildStartupCard(config, requestId): object` — 可交互卡片(目标 + 并行数 + 安全阀 + **真实角色名册**),按钮**镜像 `src/services/feishu/cards.ts` 的形状**:`behaviors: [{ type:'callback', value: { requestId, behavior:'allow'|'deny' } }]`——这正是 `useFeishuBridge` 里 `wireCardAction` 认识并路由的 payload。
  - (in `feishuStartupCard.ts`) `sendFeishuStartupCard(deps: { client: FeishuClient; callbacks: FeishuPermissionCallbacks; requestId: string; cardContent: object; parallelism: number }, claimAndResolve): () => void` — (a) `callbacks.onResponse(requestId, r => claimAndResolve({ parallelism, approved: r.behavior === 'allow' }))` 注册响应;(b) 经**共享** `client.sendCard` 发卡;(c) 返回 teardown:`unsub()` + best-effort `updateCard` 成已解决态。
- **架构红线(必须遵守):** `useFeishuBridge` 已经拥有**唯一一个**常驻 `FeishuClient` 和**唯一一个** `onCardAction` 处理槽。因此 `feishuStartupCard.ts` **绝不允许** `new FeishuClient(...)`、`client.connect()`、`client.close()`、`client.onCardAction(...)`——第二条连接会让事件投递错乱,而抢占 `onCardAction` 会直接踩掉权限确认桥。**多路复用发生在 callbacks 注册表这一层**:`wireCardAction` 按 `value.requestId` 把事件分发给 `callbacks.resolve(requestId, ...)`,我们只需用一个新的 `requestId`(`randomUUID()`)去 `onResponse` 上挂一个处理器即可。
- **门控(Task 11):** 用 `AppState` 里的 `feishuClient` **和** `feishuPermissionCallbacks` 双双存在来门控(不是 `getFeishuConfig`)——两者由 `useFeishuBridge` 一并写入;缺任一就干脆不把飞书 surface 加进竞速。
- P1 说明:确认卡片呈现 **目标回显 + 并行数 + 安全阀 + 真实角色名册**,用户可 approve/取消(P1 不做行内编辑并行数的复杂交互,提供 approve=用建议值 / cancel=退出;并行数编辑放 P2)。**飞书确认在 P1 即交付(不再是"若时间不足可 P2 补")。**

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/startupConfirm.test.ts
import { describe, expect, it } from 'bun:test'
import { DEFAULT_CAPS, emptyPhaseRoles } from './types.js'
import type { EffTaskConfig } from './types.js'
import { createResolveOnce, raceConfirm, rosterLines } from './startupConfirm.js'

describe('startupConfirm racer', () => {
  it('createResolveOnce: only first claim wins', async () => {
    const r = createResolveOnce<number>()
    expect(r.claim()).toBe(true)
    expect(r.claim()).toBe(false)
    r.resolve(7)
    expect(await r.promise).toBe(7)
  })
  it('raceConfirm: first surface to resolve wins, others torn down', async () => {
    const torn: string[] = []
    const decision = await raceConfirm([
      (car) => { setTimeout(() => car({ parallelism: 5, approved: true }), 1); return () => torn.push('A') },
      (_car) => { return () => torn.push('B') },
    ])
    expect(decision.approved).toBe(true)
    expect(torn).toContain('B') // loser torn down
  })
  it('raceConfirm: a THROWING surface does not kill the race', async () => {
    const torn: string[] = []
    const decision = await raceConfirm([
      () => { throw new Error('飞书 surface 构造失败') },
      (car) => { setTimeout(() => car({ parallelism: 3, approved: true }), 1); return () => torn.push('B') },
    ])
    expect(decision.parallelism).toBe(3) // the surviving surface still wins
    expect(torn).toEqual(['B']) // only the surfaces that constructed successfully are torn down
  })
  it('rosterLines renders the REAL roster, 主模型 for phases with no bindings', () => {
    const cfg: EffTaskConfig = {
      goalPrompt: 'g', parallelism: 5, caps: { ...DEFAULT_CAPS },
      phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: 'arch' }, { roleName: 'sec' }] },
    }
    const lines = rosterLines(cfg)
    expect(lines).toHaveLength(5) // one line per PHASE_NAMES entry
    expect(lines).toContain('评审: arch、sec')
    expect(lines).toContain('方案: 主模型')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/startupConfirm.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现(纯逻辑)**

```ts
// src/tools/efftask/startupConfirm.ts
import { PHASE_NAMES } from './types.js'
import type { EffTaskConfig, PhaseName } from './types.js'

export interface StartupDecision { parallelism: number; approved: boolean }

const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '方案', review: '评审', execute: '执行', accept: '验收', observer: '观察',
}

// The ACTUAL roster (spec gate-1 角色名册): each phase → its bound role names, or 主模型
// when the phase has no bindings. Shared by the terminal card AND the Feishu card so the
// two surfaces can never disagree about who is on the panel.
export function rosterLines(config: EffTaskConfig): string[] {
  return PHASE_NAMES.map(p => {
    const names = config.phaseRoles[p].map(r => r.roleName)
    return `${PHASE_LABEL[p]}: ${names.length > 0 ? names.join('、') : '主模型'}`
  })
}

export function createResolveOnce<T>(): { claim(): boolean; resolve(v: T): void; promise: Promise<T> } {
  let claimed = false
  let resolveFn!: (v: T) => void
  const promise = new Promise<T>(res => { resolveFn = res })
  return {
    claim() { if (claimed) return false; claimed = true; return true },
    resolve(v) { resolveFn(v) },
    promise,
  }
}

export async function raceConfirm(
  surfaces: Array<(claimAndResolve: (d: StartupDecision) => void) => () => void>,
): Promise<StartupDecision> {
  const once = createResolveOnce<StartupDecision>()
  const teardowns: Array<() => void> = []
  const claimAndResolve = (d: StartupDecision) => { if (once.claim()) once.resolve(d) }
  for (const surface of surfaces) {
    // A surface that throws while constructing (e.g. Feishu send blows up) must NOT kill
    // the race — the other surfaces can still win. Only successful ones get a teardown.
    try { teardowns.push(surface(claimAndResolve)) } catch { /* skip this surface */ }
  }
  const decision = await once.promise
  for (const t of teardowns) { try { t() } catch { /* ignore */ } }
  return decision
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/startupConfirm.test.ts`
Expected: PASS(4 条:`createResolveOnce` / 竞速胜出+teardown / **抛错 surface 不掀翻竞速** / **`rosterLines` 渲染真实名册**)。

- [ ] **Step 5: 实现 Ink 确认组件(手动验证)**

```tsx
// src/commands/efftask/ConfirmStartup.tsx
import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import { rosterLines, type StartupDecision } from '../../tools/efftask/startupConfirm.js'

export function ConfirmStartup(props: { config: EffTaskConfig; onDecision: (d: StartupDecision) => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.return || input.toLowerCase() === 'y') props.onDecision({ parallelism: props.config.parallelism, approved: true })
    else if (key.escape || input.toLowerCase() === 'n') props.onDecision({ parallelism: props.config.parallelism, approved: false })
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务模式 · 启动确认</Text>
      <Text>目标: {props.config.goalPrompt.split('\n')[0].slice(0, 80)}</Text>
      <Text>并行数: {props.config.parallelism}（P1 串行执行,此值 P2 生效）</Text>
      {/* Real roster from config.phaseRoles — settings roles DO take effect in P1. */}
      <Text bold>角色名册:</Text>
      {rosterLines(props.config).map(line => <Text key={line}>  {line}</Text>)}
      <Text>安全阀: 深度{props.config.caps.maxDepth} / 节点{props.config.caps.maxNodes} / 迭代{props.config.caps.maxIterations}</Text>
      <Text dimColor>回车/y 开始 · Esc/n 取消</Text>
    </Box>
  )
}
```

- [ ] **Step 6: 实现飞书启动卡片 surface(集成代码,无单测)**

```ts
// src/tools/efftask/feishuStartupCard.ts
// Integration surface — rides the SHARED always-on FeishuClient + permission callbacks
// owned by useFeishuBridge, so no unit test (repo convention).
// The pure racer / roster primitives stay in startupConfirm.ts.
//
// HARD RULE: never `new FeishuClient`, never connect()/close(), never onCardAction().
// useFeishuBridge owns the single connection AND the single onCardAction handler slot
// (which routes permission prompts). A second connection mis-routes events; re-registering
// onCardAction would silently clobber the permission bridge. Multiplexing already exists
// one layer up: wireCardAction dispatches by value.requestId into
// FeishuPermissionCallbacks.resolve(...), so we just claim our own requestId.
import type { FeishuClient } from '../../services/feishu/FeishuClient.js'
import type { FeishuPermissionCallbacks } from '../../services/feishu/feishuPermissions.js'
import type { EffTaskConfig } from './types.js'
import { rosterLines, type StartupDecision } from './startupConfirm.js'
import { logError } from '../../utils/log.js'

// Button shape MIRRORS src/services/feishu/cards.ts: the callback payload is
// { requestId, behavior }, which is exactly what wireCardAction reads.
function button(content: string, type: string, value: Record<string, unknown>) {
  return { tag: 'button', text: { tag: 'plain_text', content }, type, behaviors: [{ type: 'callback', value }] }
}

export function buildStartupCard(config: EffTaskConfig, requestId: string): object {
  const goal = config.goalPrompt.split('\n')[0].slice(0, 80)
  const body =
    `**目标**: ${goal}\n` +
    `**并行数**: ${config.parallelism}（P1 串行,值 P2 生效）\n` +
    `**安全阀**: 深度${config.caps.maxDepth} / 节点${config.caps.maxNodes} / 迭代${config.caps.maxIterations}\n` +
    `**角色名册**:\n${rosterLines(config).map(l => `- ${l}`).join('\n')}`
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '高效任务模式 · 启动确认' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'action',
        actions: [
          button('开始', 'primary', { requestId, behavior: 'allow' }),
          button('取消', 'danger', { requestId, behavior: 'deny' }),
        ],
      },
    ],
  }
}

function resolvedCard(): object {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '高效任务模式 · 启动确认' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: '已在终端处理。' } }],
  }
}

export function sendFeishuStartupCard(
  deps: {
    client: FeishuClient // the SHARED, already-connected client from AppState
    callbacks: FeishuPermissionCallbacks // the SHARED registry from AppState
    requestId: string // randomUUID() minted by the caller; also embedded in cardContent
    cardContent: object
    parallelism: number // echoed back in the decision (the card has no inline editor in P1)
  },
  claimAndResolve: (d: StartupDecision) => void,
): () => void {
  let messageId: string | undefined
  // Register on the shared registry — NOT client.onCardAction (single slot, already taken).
  const unsub = deps.callbacks.onResponse(deps.requestId, r =>
    claimAndResolve({ parallelism: deps.parallelism, approved: r.behavior === 'allow' }),
  )
  // fire-and-forget send on the shared client; capture messageId for the teardown update
  void deps.client.sendCard(deps.cardContent).then(id => { messageId = id }).catch(logError)
  // teardown (loser cleanup): unsubscribe, then best-effort flip the card to a resolved state.
  return () => {
    unsub()
    // If the terminal wins BEFORE sendCard resolves, messageId is still undefined and the
    // card stays interactive. Harmless: unsub() already removed the handler, and any late
    // click is swallowed by once.claim() in raceConfirm.
    if (messageId) void deps.client.updateCard(messageId, resolvedCard()).catch(logError)
  }
}
```

- [ ] **Step 7: 提交**

```bash
git add src/tools/efftask/startupConfirm.ts src/tools/efftask/startupConfirm.test.ts src/tools/efftask/feishuStartupCard.ts src/commands/efftask/ConfirmStartup.tsx
git commit -m "feat(efftask): startup confirmation racer (terminal + feishu surface)"
```

---

## Task 11: `/et` 命令 + 只读实时树 + 接线

**Files:**
- Create: `src/commands/efftask/index.ts`
- Create: `src/commands/efftask/efftask.tsx`
- Create: `src/commands/efftask/TaskTreePanel.tsx`
- Modify: `src/commands.ts`（在 `COMMANDS()` 数组加入 `efftask`,顶部 import）
- 验证:手动跑 `/et`(无单测——Ink 命令沿用本仓惯例)。

**Interfaces:**
- Consumes: `EffTaskOrchestrator`/`OrchestratorDeps`(Task 8);`parseDirectives`(Task 4);`makeRunAgentFn`(Task 9);`ConfirmStartup`/`raceConfirm`/`rosterLines`(Task 10 纯逻辑)/`buildStartupCard`/`sendFeishuStartupCard`(Task 10 飞书 surface);持久化 `allocateRunId`/`writeNode`/`writeRunManifest`/`FsLike`(Task 5);`hasPermissionsToUseTool`(`src/utils/permissions/permissions.js`);`AgentDefinition`(`src/tools/AgentTool/loadAgentsDir.js`);命令类型 `LocalJSXCommandCall`(`src/types/command.ts`);`node:fs/promises` + `node:path`(fsAdapter 直连,**不再用 `getFsImplementation()`**);`randomUUID`(`node:crypto`);`logError`(`src/utils/log.js`);`useAppStateStore`(读 `feishuClient` / `feishuPermissionCallbacks` 做飞书门控)。**不再 import `getFeishuConfig` / `FeishuClient`。**
- Produces: 一个可 `/et <prompt>` 触发的 local-jsx 命令;`READ_ONLY_TOOL_NAMES`;`EffTaskRunner` 为 `parsing | confirm | running | done` 四态;`running` 态渲染实时树 + `Esc 中断`;`done` 态渲染只读树 + 完成/阻断摘要(含 reason)+ `useInput` 退出键。
- 关键约束:
  - `call()` **立即返回 JSX**;`parseDirectives`(一次模型调用)搬进组件的 `parsing` 态(渲染 `正在解析需求…`),不得在 `call()` 里 await——否则终端在花掉 token 期间毫无界面。`args` 为空则直接渲染用法提示 + `onDone`。
  - **工具池**:`readOnlyTools = context.options.tools.filter(t => READ_ONLY_TOOL_NAMES.has(t.name))`,`READ_ONLY_TOOL_NAMES = new Set(['Read','Glob','Grep'])`;只有一次性的配置抽取用**另建的 no-tools `RunAgentFn`**(`availableTools: []` + `readOnlyTools: []`)。
  - **飞书门控**:`feishuClient && feishuPermissionCallbacks` 双双存在才把飞书 surface 加入竞速(不是 `getFeishuConfig`)。
  - **中断**:命令自己持有一个 `AbortController`(并链到 `context.abortController.signal`),`running` 视图的 Esc/q 调它;编排器的 `{status:'blocked', reason:'已中断'}` 随后流到 `done` 视图。
  - **`run()` 绝不能把 UI 卡死**:`runOrchestrator` 全身包 `try/catch/finally`,`finally` 里必定 `setPhase('done')`。
  - **`run.md` 写入串行化**:所有 `writeRunManifest` 走单条 promise 队列;收尾那次带上 `{status, reason}`。
  - **`decision.parallelism` 必须落到 config**(P1 串行驱动里是惰性的,但不许被悄悄丢掉)。

- [ ] **Step 1: 命令元数据**

```ts
// src/commands/efftask/index.ts
import type { Command } from '../../types/command.js'

const efftask = {
  type: 'local-jsx',
  name: 'et',
  aliases: ['efftask'],
  description: '高效任务模式:把提示词拆成可并行、带依赖、多角色评审/验收的任务树',
  argumentHint: '<任务提示词>',
  userInvocable: true,
  disableModelInvocation: true,
  load: () => import('./efftask.js'),
} satisfies Command

export default efftask
```

- [ ] **Step 2: 注册进 commands.ts**

在 `src/commands.ts` 顶部 import 区加:
```ts
import efftask from './commands/efftask/index.js'
```
在 `COMMANDS()` 返回数组中加入 `efftask`(与其它静态命令并列,如放在 `tasks` 附近):
```ts
    efftask,
```

- [ ] **Step 3: 只读实时树面板**

```tsx
// src/commands/efftask/TaskTreePanel.tsx
import * as React from 'react'
import { Box, Text } from 'ink'
import type { TaskNode } from '../../tools/efftask/types.js'
import { uiStatus } from '../../tools/efftask/stateMachine.js'

const COLOR: Record<string, string> = { done: 'green', running: 'yellow', queued: 'gray', failed: 'red' }
const GLYPH: Record<string, string> = { done: '●', running: '◐', queued: '○', failed: '✗' }

function elapsed(node: TaskNode, nowMs: number): string {
  const start = Date.parse(node.createdAt)
  const end = node.status === 'ACCEPTED' || node.status === 'BLOCKED' ? Date.parse(node.updatedAt) : nowMs
  const secs = Math.max(0, Math.round((end - start) / 1000))
  return `${secs}s`
}

export function TaskTreePanel(props: { nodes: TaskNode[]; runId: string }): React.ReactElement {
  // Tick once a second so elapsed times keep moving even when no node transitions —
  // otherwise the panel only repaints on onUpdate and looks frozen during a long phase.
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const byDepth = [...props.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const counts = { done: 0, running: 0, queued: 0, failed: 0 as number }
  for (const n of props.nodes) counts[uiStatus(n.status)]++
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>高效任务 · run {props.runId}  <Text color="green">✓{counts.done}</Text> <Text color="yellow">◐{counts.running}</Text> <Text color="gray">○{counts.queued}</Text> <Text color="red">✗{counts.failed}</Text></Text>
      {byDepth.map(n => {
        const ui = uiStatus(n.status)
        return (
          <Text key={n.id} color={COLOR[ui]}>
            {'  '.repeat(n.depth)}{GLYPH[ui]} {n.title} <Text dimColor>[{n.status}] {elapsed(n, nowMs)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
```

- [ ] **Step 4: 命令实现(解析→确认→编排→渲染)**

```tsx
// src/commands/efftask/efftask.tsx
import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { allocateRunId, writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import { createNode, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { raceConfirm, type StartupDecision } from '../../tools/efftask/startupConfirm.js'
import { buildStartupCard, sendFeishuStartupCard } from '../../tools/efftask/feishuStartupCard.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { useAppStateStore } from '../../state/AppState.js'
import { randomUUID } from 'node:crypto'
import { logError } from '../../utils/log.js'

type Outcome = { status: 'completed' | 'blocked'; reason?: string }
type Phase = 'parsing' | 'confirm' | 'running' | 'done'

// Read-only tool pool for plan/review/accept/observer: they must be able to READ the repo
// to judge anything, they just must not be able to WRITE it.
const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Glob', 'Grep'])

// 集成接线,无单测;手动跑 /et 验证。
// 构造顺序:fs → runId → runAgent 接缝 → 立刻返回 JSX(解析在组件内 parsing 态跑)。
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // Empty prompt: there is nothing to plan. Show a hint instead of planning nothing.
  if (!args.trim()) {
    return <HintAndExit text="用法: /et <任务提示词>" onExit={() => onDone('已取消', { display: 'system' })} />
  }
  const cwd = process.cwd()
  const fs = fsAdapter()
  const effRoot = `${cwd}/.claude/efftask`
  // Local fs scan only — no model call, no tokens, sub-millisecond. Everything that COSTS
  // something (parseDirectives) happens inside the component.
  const runId = await allocateRunId(fs, effRoot)
  const runDir = `${effRoot}/${runId}`

  // The command owns its own AbortController so the running view's Esc can stop the run;
  // it chains off the parent signal so a REPL-level abort still tears everything down.
  const runController = new AbortController()
  if (context.abortController.signal.aborted) runController.abort()
  else context.abortController.signal.addEventListener('abort', () => runController.abort(), { once: true })
  const signal = runController.signal

  const activeAgents: AgentDefinition[] = context.options.agentDefinitions?.activeAgents ?? []
  const allAgents: AgentDefinition[] = context.options.agentDefinitions?.allAgents ?? activeAgents
  // canUseTool falls back to hasPermissionsToUseTool (same fallback processSlashCommand's
  // local-jsx branch uses for executeForkedSlashCommand).
  const canUseTool = context.canUseTool ?? hasPermissionsToUseTool
  const mainModelDefault = pickMainAgentDefinition(allAgents)
  // REAL read-only pool (NOT []): a reviewer that cannot read the repo can only guess.
  const readOnlyTools = context.options.tools.filter(t => READ_ONLY_TOOL_NAMES.has(t.name))
  const runAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context, canUseTool,
    availableTools: context.options.tools, // execute phase only
    readOnlyTools, // plan / review / accept / observer
    activeAgents, mainModelDefault,
  })
  // Separate NO-TOOLS seam for the one-shot config extraction: it only rewrites text into
  // JSON, so it needs neither read nor write tools. This is the ONLY place that passes [].
  const extractAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context, canUseTool,
    availableTools: [], readOnlyTools: [],
    activeAgents, mainModelDefault,
  })

  const knownRoles = activeAgents.map(a => a.agentType)
  return (
    <EffTaskRunner
      args={args}
      knownRoles={knownRoles}
      extractJson={prompt => extractAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal })}
      runId={runId}
      runDir={runDir}
      fs={fs}
      runAgent={runAgent}
      signal={signal}
      abort={() => runController.abort()}
      onExit={() => onDone('高效任务结束', { display: 'system' })}
    />
  )
}

function HintAndExit(props: { text: string; onExit: () => void }): React.ReactElement {
  React.useEffect(() => { props.onExit() }, [])
  return <Text dimColor>{props.text}</Text>
}

// 一次性配置抽取用的占位节点(不入树,只是给 RunAgentFn 一个合法 node 形参)。
function stubNode(): TaskNode {
  return createNode({ id: '__extract__', title: 'extract', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: new Date().toISOString() })
}

// Reuse a REAL built-in AgentDefinition as the P1 main-model default so system prompt /
// source / baseDir are all valid (NO `as unknown as` cast).
// WHY the fallback is picky instead of `allAgents[0]`: the roster also contains agents that
// came from settings roles, and one of those can be a cli / other-provider agent (e.g. one
// carrying `execMode`). Grabbing an arbitrary entry would silently route every un-roled
// phase — plan, review, accept — through someone else's provider. So: prefer
// general-purpose; else the first BUILT-IN, non-exec-mode agent; else a minimal literal.
function pickMainAgentDefinition(allAgents: AgentDefinition[]): AgentDefinition {
  const preferred =
    allAgents.find(a => a.agentType === 'general-purpose') ??
    allAgents.find(a => a.source === 'built-in' && !('execMode' in a))
  if (preferred) return preferred
  const fallback: AgentDefinition = {
    agentType: 'general-purpose',
    whenToUse: '高效任务主模型执行',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  }
  return fallback
}

// FsLike backed directly by node:fs/promises — removes the broken FsOperations usage.
function fsAdapter(): FsLike {
  return {
    readFile: p => readFile(p, 'utf-8'),
    writeFile: async (p, d) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, d, 'utf-8') },
    mkdir: p => mkdir(p, { recursive: true }).then(() => {}),
    readdir: p => readdir(p), // returns string[] by default — matches FsLike
    exists: p => access(p).then(() => true, () => false),
  }
}

function EffTaskRunner(props: {
  args: string
  knownRoles: string[]
  extractJson: (prompt: string) => Promise<string>
  runId: string; runDir: string; fs: FsLike; runAgent: RunAgentFn
  signal: AbortSignal; abort: () => void; onExit: () => void
}): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>('parsing')
  const [config, setConfig] = React.useState<EffTaskConfig | null>(null)
  const [nodes, setNodes] = React.useState<TaskNode[]>([])
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const store = useAppStateStore()
  // Terminal surface stashes its claimAndResolve here so the rendered ConfirmStartup can call it.
  const terminalResolve = React.useRef<(d: StartupDecision) => void>(() => {})

  // parseDirectives is a MODEL call. It runs HERE, behind a 正在解析需求… view — never in
  // call(), which would freeze the terminal with no UI while spending tokens.
  React.useEffect(() => {
    let cancelled = false
    void parseDirectives(props.args, { knownRoles: props.knownRoles, modelJson: props.extractJson })
      .catch(() => parseDirectives(props.args, { knownRoles: props.knownRoles })) // belt & braces: fall back to defaults
      .then(cfg => { if (!cancelled) { setConfig(cfg); setPhase('confirm') } })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    if (phase !== 'confirm' || !config) return
    let cancelled = false
    const surfaces: Array<(claimAndResolve: (d: StartupDecision) => void) => () => void> = [
      car => { terminalResolve.current = car; return () => {} }, // terminalSurface (ConfirmStartup render)
    ]
    // Gate on the SHARED client + callbacks written by useFeishuBridge — NOT on
    // getFeishuConfig. We never construct/connect/close a client of our own; the startup
    // card multiplexes onto the existing bridge via its own requestId.
    const { feishuClient, feishuPermissionCallbacks } = store.getState()
    if (feishuClient && feishuPermissionCallbacks) {
      const requestId = randomUUID()
      const cardContent = buildStartupCard(config, requestId)
      surfaces.push(car =>
        sendFeishuStartupCard(
          { client: feishuClient, callbacks: feishuPermissionCallbacks, requestId, cardContent, parallelism: config.parallelism },
          car,
        ),
      )
    }
    // Race [terminalSurface, feishuSurface?]: first responder wins, the other is torn down.
    void raceConfirm(surfaces)
      .then(decision => {
        if (cancelled) return
        if (!decision.approved) { props.onExit(); return }
        // Apply the confirmed parallelism. It is inert in P1's serial driver, but it must
        // NOT be silently discarded — P2's pool reads it straight off the config.
        const effectiveConfig: EffTaskConfig = { ...config, parallelism: decision.parallelism }
        setPhase('running')
        void runOrchestrator({ ...props, config: effectiveConfig }, setNodes, setOutcome, setPhase)
      })
      .catch(e => {
        // A broken race must land on the done view, not hang on 'confirm'.
        if (cancelled) return
        setOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
        setPhase('done')
      })
    return () => { cancelled = true }
  }, [phase, config])

  if (phase === 'parsing' || !config) {
    return <Text dimColor>正在解析需求…</Text>
  }
  if (phase === 'confirm') {
    return <ConfirmStartup config={config} onDecision={d => terminalResolve.current(d)} />
  }
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={props.runId} onAbort={props.abort} />
  }
  return <DoneView nodes={nodes} runId={props.runId} outcome={outcome} onExit={props.onExit} />
}

// 'running' phase: live tree + an interrupt affordance. Esc/q aborts the controller the
// command owns; the orchestrator then returns {status:'blocked', reason:'已中断'} and the
// finally-block flips us to 'done'.
function RunningView(props: { nodes: TaskNode[]; runId: string; onAbort: () => void }): React.ReactElement {
  useInput((input, key) => { if (key.escape || input.toLowerCase() === 'q') props.onAbort() })
  return (
    <Box flexDirection="column">
      <TaskTreePanel nodes={props.nodes} runId={props.runId} />
      <Text dimColor>Esc 中断</Text>
    </Box>
  )
}

// 'done' phase: read-only tree + terminal summary (completed/blocked + reason) + exit key.
function DoneView(props: { nodes: TaskNode[]; runId: string; outcome: Outcome | null; onExit: () => void }): React.ReactElement {
  useInput((input, key) => { if (key.return || key.escape || input.toLowerCase() === 'q') props.onExit() })
  const ok = props.outcome?.status === 'completed'
  return (
    <Box flexDirection="column">
      <TaskTreePanel nodes={props.nodes} runId={props.runId} />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={ok ? 'green' : 'red'}>{ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}</Text>
        {props.outcome?.reason ? <Text dimColor>原因: {props.outcome.reason}</Text> : null}
        <Text dimColor>回车 / q / Esc 退出</Text>
      </Box>
    </Box>
  )
}

async function runOrchestrator(
  props: { config: EffTaskConfig; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: Phase) => void,
): Promise<void> {
  // Serialize run.md writes. onUpdate fires on EVERY state transition; firing writeFile
  // unawaited each time lets concurrent writes to the same path interleave into a corrupt
  // manifest. One promise queue ⇒ strictly ordered, last-write-wins.
  let manifestQueue: Promise<void> = Promise.resolve()
  const queueManifest = (nodes: TaskNode[], result?: Outcome): Promise<void> => {
    manifestQueue = manifestQueue
      .then(() => writeRunManifest(props.fs, props.runDir, props.config, nodes, result))
      .catch(logError)
    return manifestQueue
  }
  try {
    const persist = (n: TaskNode) => writeNode(props.fs, props.runDir, n)
    const now = () => new Date().toISOString()
    const orch = new EffTaskOrchestrator(
      props.config,
      { runAgent: props.runAgent, persist, now, onUpdate: nodes => { setNodes([...nodes]); void queueManifest(nodes) } },
      props.signal,
    )
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    const result = await orch.run() // { status, reason }
    setNodes([...orch.nodes()])
    setOutcome(result)
    await queueManifest(orch.nodes(), result) // final manifest records {status, reason}
  } catch (e) {
    // run() is not supposed to reject (the orchestrator catches per-step), but if it ever
    // does, the UI must NOT wedge on 'running' with no way out.
    setOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
  } finally {
    setPhase('done') // the done view is ALWAYS reached
  }
}
```

> **Task 11 是集成任务(无单测,手动跑 `/et` 验证)。** 上面的代码已消除全部 `as unknown as` 逃逸口:(1) `pickMainAgentDefinition(allAgents)` 复用真实内置 `AgentDefinition`(优先 `general-purpose`,否则第一个 `source==='built-in'` 且不带 `execMode` 的 agent;仅在都找不到时用最小内置 fallback——**绝不取 `allAgents[0]`**,那可能是 settings 里配的 cli/他家 provider 角色),system prompt / source / baseDir 都合法;(2) `fsAdapter()` 直接用 `node:fs/promises`(`readFile/writeFile/mkdir/readdir/access` + `node:path` 的 `dirname`),不再经 `getFsImplementation()`;(3) `canUseTool = context.canUseTool ?? hasPermissionsToUseTool`(与 `processSlashCommand.tsx` 的 local-jsx 分支同一 fallback,导入自 `../../utils/permissions/permissions.js`)。`context` 的字段(`context.canUseTool`、`context.options.tools`、`context.options.agentDefinitions?.{activeAgents,allAgents}`、`context.abortController.signal`)以真实 `ToolUseContext & LocalJSXCommandContext` 类型为准——若字段名不符,按真实类型改,不得用 `any`/`as unknown as` 掩盖。`src/tools/efftask/` 与 `src/commands/efftask/` 落地后不得残留任何逃逸 cast(测试夹具里给假对象的 `as any` 除外)。

- [ ] **Step 5: 手动验证(冒烟)**

在一个玩具 git 仓库 `cwd` 里:
1. 配置一个最小 `.claude/settings.json`(可留空 roles)。
2. 启动本 CLI(`bun run ./bin/claude-haha`)。
3. 输入 `/et 写一个 hello.txt,内容为 hi`。
4. 期望:先看到 `正在解析需求…` → 启动确认卡片(**含真实角色名册**)→ 回车 → 出现任务树面板(**首帧就有 root 行,耗时每秒跳动,底部 `Esc 中断`**)→ root 走 plan→review→execute→accept → 变绿 ACCEPTED;末态显示"✓ 高效任务完成"摘要且可按回车/q/Esc 退出;`.claude/efftask/001/root/node.md` 存在且含方案与执行状态;`.claude/efftask/001/run.md` 的 frontmatter 含最终 `status`;`hello.txt` 被创建。
5. 空参数:直接输入 `/et`(无提示词)→ 只显示用法提示并退出,不发起任何模型调用。
6. 中断:在 running 态按 Esc → 立刻进 done 态,摘要为"✗ 高效任务被阻断 / 原因: 已中断",树里没有残留的黄色 running 行。
7. 若配置了飞书(`.claude/settings.json` 的 `feishu.enabled=true` + 凭据,且 `useFeishuBridge` 已挂载出 `feishuClient`/`feishuPermissionCallbacks`),确认卡片应同时出现在飞书,**任一端(终端或飞书卡片)点击都能推进**(经 `raceConfirm([terminalSurface, feishuSurface])` 竞速,首个响应者胜出、另一端 teardown 更新为"已在终端处理")。**同时验证权限确认桥未被踩坏**:`/et` 跑起来后再触发一次普通工具权限飞书卡片,应仍能正常允许/拒绝(证明我们没有抢占 `onCardAction`)。

- [ ] **Step 6: 全量回归 + 提交**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/
git add src/commands/efftask/ src/commands.ts
git commit -m "feat(efftask): /et command, read-only live tree, wiring"
```
Expected: efftask 逻辑测试全绿;`/et` 冒烟通过。

---

## P1 完成标准(Definition of Done)

1. **`bun test src/tools/efftask/` 全绿**,共 **10 个测试文件 / 合计 68 个 `it`**:types 3 / stateMachine 8 / parseOutput 10 / parseDirectives 5 / persistence 7 / roundtable 6 / pipeline 15 / orchestrator 5 / runAgentAdapter 5 / startupConfirm 4。(`feishuStartupCard.ts` 为集成 surface,复用共享 `FeishuClient`,无单测。)相对初版新增的断言:types 的 goal 默认 + `blockedReason` + `phaseRoles` 不共享、stateMachine 的 `hasCycle` + 零子节点不可集成、parseOutput 的 **LAST-FENCE** 规则、roundtable 的 allSettled 失败合成 + **空 blocking 回退 comments**、pipeline 15 条、orchestrator 5 条(BLOCKED 向上传播)、persistence 的 `loadRun` 往返 + `writeRunManifest`(含最终 `{status,reason}`)、runAgentAdapter 的 `makeRunAgentFn` 契约测、startupConfirm 的抛错 surface + `rosterLines`。
2. **零逃逸 cast**:`src/tools/efftask/` 与 `src/commands/efftask/` 的源码文件不含任何 `as unknown as` 逃逸 cast(已全部消除:adapter 用 `createUserMessage` + 正确 type-only import;Task 11 用真实 `AgentDefinition`、`node:fs/promises`、`hasPermissionsToUseTool` fallback)。测试夹具里给假对象的 `as any` 不算。**不要求全仓 `tsc` 通过**——本 fork 的 phantom `message.ts` / `querySource.ts` 让全量类型检查预先就是红的;以 `bun test` 通过为准。
3. **Task 11 冒烟验收**:`/et 写一个 hello.txt` → root 变 `ACCEPTED` + `hello.txt` 被创建 + `.claude/efftask/001/root/node.md` 落盘且含 **方案 + 执行状态** + `run.md` frontmatter 含最终 `status` + 末态显示完成/阻断 **terminal summary(带 reason)** 且可按键退出(`onDone`);`running` 态可按 Esc 中断并落到 done 态。
4. **确定性硬控制全覆盖(有测试)**:依赖门控(deps 未 ACCEPTED 不执行)+ 迭代上限→BLOCKED(评审/验收/集成验收超 `maxIterations`,reason 写进 `blockedReason`)+ 深度上限(decompose→executable,**子标题折进 `plan.solution` 不丢**)+ **节点数上限→BLOCKED(`节点数超过上限`,零残留子节点)** + 兄弟依赖成环→有界重拆、耗尽才 BLOCKED + **预置 `AbortSignal`→BLOCKED(`已中断`,零模型调用)** + runAgent 抛错→BLOCKED,均由单测覆盖;死锁时 BLOCKED 向上传播(含悬垂依赖)使树面板红得准确。
5. **多角色圆桌在 P1 生效**:settings 里配了角色时,`parseDirectives` 解析出阶段名册、`runRoundtable` 并行扇出、全票才通过;`ConfirmStartup` 与飞书启动卡片都**渲染真实名册**(spec gate-1 角色名册)。**只读边界**:plan/review/accept/observer 拿 `Read`/`Glob`/`Grep`(能读仓库、不能改),仅 execute 拿可写全池,仅配置抽取无工具。
6. **未触碰 P2/P3 范围**(无并行执行、无 worktree、无**节点级角色覆盖**、无观察评分、无 runtime 动态加节点、无交互展开/详情、无启动第 3 关方案编辑、无后台任务注册、无飞书升级卡片)。

## 交接到 P2/P3

P1 合并后,基于真实接口再写:
- **P2 计划**:并发池(`parallelism` 生效——P1 已把启动确认里的值落进 config,只是串行驱动不读它)+ 跨分支依赖调度 + git worktree 隔离(`src/tools/efftask/worktree.ts`;P1 已把 `RunAgentFn.cwd` 映射到 `runAgent` 的 `worktreePath`,接缝可直接用)+ 合并回集成分支 + finishing-a-development-branch 收口 + 启动确认支持并行数编辑 + 飞书推进 surface 完整接线。
- **P2 计划(补):崩溃恢复 resume**——`loadRun` / `readNode` 在 P1 已产出并单测覆盖,但**尚无消费方**;P2 接线时须先给 `parseNodeFile` 加字段校验(它现在是无校验的 `as TaskNode`),再把恢复出的节点喂进状态机。
- **P2 计划(补):后台任务注册(spec §10)**——`registerAsyncAgent` + `/tasks` 可见性;P1 的编排跑在 `/et` 命令组件内,离开视图即中断。
- **P2 计划(补):安全阀升级卡片**——安全阀触发时向飞书推升级卡;P1 只把原因写进 `blockedReason` + `run.md` 并在 done 视图展示。
- **P3 计划**:节点级角色覆盖 + 观察评分(observer 阶段)+ 执行中 runtime `addChild` 动态生长 + 剩余安全阀(节点超时 tree-kill)+ 交互式树面板(展开/折叠 + Enter 进 `NodeDetailView` + 子 agent 实时终端)。
