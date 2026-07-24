# 高效任务模式 (Efficient Task Mode) — P1 骨架 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/et` 高效任务模式的可运行骨架:命令入口 + 启动确认(终端+飞书)+ 任务树/节点模型 + md 持久化 + **串行**执行 + **单角色**(主模型)方案制定/评审/执行/验收 + 基础只读实时树。

**Architecture:** 一个确定性 TS 编排引擎(`EffTaskOrchestrator`)拥有任务树、依赖门控、md 持久化;每个节点的阶段(plan/review/execute/accept)通过一个**注入的 `RunAgentFn` 接缝**调用模型(P1 用主模型),接缝背后是对现有 `runAgent()` 的适配器。引擎与所有纯逻辑用假 `RunAgentFn`/假 fs 单测,不打真模型。

**Tech Stack:** Bun + TypeScript,Ink TUI,`yaml`(^2.8.3,已在依赖),现有 `runAgent()` / `FeishuClient` / `getFeishuConfig` / `getFsImplementation()`。测试 `bun test`,测试文件与源码同目录 `*.test.ts`。

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json` 的 `roles`;不引入 `env:` 间接、不脱敏。
- 不 `feature()` 门控:`/et` 及相关代码直接生效(本 fork 运行时 `feature()` 恒 false,门控=死代码)。
- 所有人工确认走同一路径:终端 + 飞书卡片竞速,首个响应者胜出并同步另一端;不新造确认通道。
- 确定性硬控制:依赖门控(节点仅当 `deps` 全 `ACCEPTED` 才可开始)由 TS 引擎保证,不交给模型。
- 圆桌合成 = 独立并行 + 全票通过:任一角色 `pass=false` 或 `blocking` 非空即不通过。P1 单角色即退化为该角色说了算。
- 不静默截断:触发安全阀(深度/节点数/迭代/超时上限)一律 `BLOCKED` + 升级(P1 至少记录并停,飞书升级在 §Task 10 之后可用)。
- TUI-only。
- 测试文件与源码同目录,命名 `*.test.ts`;`bun test` 运行;不打真模型、不动真 git、不写真磁盘(注入假 fs)。

**P1 范围边界(明确不在 P1):** 并行执行、git worktree 隔离、多角色(>1)、观察评分、执行中动态加子节点(runtime `addChild`)、交互式展开/详情面板。这些在 P2/P3。P1 的"子节点"仅来自 **plan 阶段声明的 decompose 子节点**;P1 的实时树是**只读**的。

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
- `src/tools/efftask/startupConfirm.ts` + `src/commands/efftask/ConfirmStartup.tsx` — 三关启动确认(终端 Ink + 飞书卡片竞速)。
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
    expect(n.status).toBe('CREATED')
    expect(n.kind).toBe('unknown')
    expect(n.childIds).toEqual([])
    expect(n.iteration).toEqual({ planReview: 0, acceptance: 0 })
    expect(n.plan.solution).toBe('')
    expect(n.createdAt).toBe('2026-07-25T00:00:00Z')
    expect(n.updatedAt).toBe('2026-07-25T00:00:00Z')
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
// src/tools/efftask/types.ts
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
export interface Verdict { role: string; pass: boolean; blocking: string[]; comments: string }
export interface RoundtableRecord { round: number; verdicts: Verdict[]; synthesized: { pass: boolean; blockingSummary: string } }
export interface ScoreRecord { role: string; score: number; rationale: string }

export interface TaskNode {
  id: string
  title: string
  parentId: string | null
  childIds: string[]
  deps: string[]
  kind: NodeKind
  status: NodeStatus
  phaseRoles: Record<PhaseName, RoleBinding[]>
  plan: NodePlan
  execStatus: string
  reviewLog: RoundtableRecord[]
  acceptLog: RoundtableRecord[]
  score: { plan?: ScoreRecord; exec?: ScoreRecord }
  worktree?: { branch: string; path: string }
  iteration: { planReview: number; acceptance: number }
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
  parentId: string | null
  deps: string[]
  depth: number
  phaseRoles: Record<PhaseName, RoleBinding[]>
  now: string
}): TaskNode {
  return {
    id: args.id,
    title: args.title,
    parentId: args.parentId,
    childIds: [],
    deps: args.deps,
    kind: 'unknown',
    status: 'CREATED',
    phaseRoles: args.phaseRoles,
    plan: emptyPlan(),
    execStatus: '',
    reviewLog: [],
    acceptLog: [],
    score: {},
    iteration: { planReview: 0, acceptance: 0 },
    depth: args.depth,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/types.test.ts`
Expected: PASS。

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
- Produces: `byIdMap(nodes)`, `depsSatisfied(node, byId)`, `childrenAllAccepted(node, byId)`, `advanceableKind(node, byId): 'start'|'execute'|'integrate'|null`, `isTerminal(status)`, `uiStatus(status): 'done'|'running'|'queued'|'failed'`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/stateMachine.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { byIdMap, depsSatisfied, childrenAllAccepted, advanceableKind, isTerminal, uiStatus } from './stateMachine.js'

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
  if (node.status === 'WAITING_CHILDREN' && childrenAllAccepted(node, byId)) return 'integrate'
  return null
}

export type UiStatus = 'done' | 'running' | 'queued' | 'failed'
export function uiStatus(status: NodeStatus): UiStatus {
  if (status === 'ACCEPTED') return 'done'
  if (status === 'BLOCKED') return 'failed'
  if (status === 'CREATED' || status === 'READY' || status === 'WAITING_CHILDREN') return 'queued'
  return 'running'
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/stateMachine.test.ts`
Expected: PASS。

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

export function extractJsonBlock(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try { return JSON.parse(c.trim()) } catch { /* try next */ }
  }
  return null
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function parsePlanOutput(text: string): { kind: NodeKind; plan: NodePlan; children: { title: string; deps: string[] }[] } {
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
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
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
  if (!obj || typeof obj.pass !== 'boolean') {
    return { role, pass: false, blocking: ['无法解析该角色的裁决输出;按不通过处理'], comments: text.trim().slice(0, 2000) }
  }
  const blocking = Array.isArray(obj.blocking) ? (obj.blocking as unknown[]).map(b => str(b)).filter(Boolean) : []
  return { role, pass: obj.pass === true && blocking.length === 0, blocking, comments: str(obj.comments) }
}

export function parseExecOutput(text: string): { execStatus: string } {
  const obj = extractJsonBlock(text) as Record<string, unknown> | null
  if (obj && typeof obj.execStatus === 'string') return { execStatus: obj.execStatus }
  return { execStatus: text.trim() }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/parseOutput.test.ts`
Expected: PASS。

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
import type { Caps, EffTaskConfig, PhaseName, RoleBinding } from './types.js'
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
  for (const phase of PHASE_NAMES as PhaseName[]) {
    const raw = pr[phase]
    if (!Array.isArray(raw)) continue
    const bindings: RoleBinding[] = raw
      .map(r => (typeof r === 'string' ? r.trim() : ''))
      .filter(name => name.length > 0 && known.has(name))
      .map(name => ({ roleName: name }))
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
Expected: PASS。

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
  - `writeRunManifest(fs, runDir, cfg, nodes): Promise<void>`（写 `runDir/run.md`)
  - `renderTreeSnapshot(nodes): string`
- 说明:`node.id` 即相对路径(root='root',子='root/01-slug')。fs 注入,测试用内存假实现。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/persistence.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles } from './types.js'
import { FsLike, slugify, childId, allocateRunId, serializeNode, parseNodeFile, writeNode, readNode, renderTreeSnapshot } from './persistence.js'

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
    const parsed = parseNodeFile(serializeNode(n))
    expect(parsed.id).toBe('root/01-x')
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
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/persistence.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/tools/efftask/persistence.ts
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import type { EffTaskConfig, TaskNode } from './types.js'
import { createNode, emptyPhaseRoles } from './types.js'
import { uiStatus } from './stateMachine.js'

export interface FsLike {
  readFile(p: string): Promise<string>
  writeFile(p: string, data: string): Promise<void>
  mkdir(p: string): Promise<void>
  readdir(p: string): Promise<string[]>
  exists(p: string): Promise<boolean>
}

export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || 'node').slice(0, 40)
}

export function childId(parentId: string, index: number, title: string): string {
  const nn = String(index).padStart(2, '0')
  return `${parentId}/${nn}-${slugify(title)}`
}

export async function allocateRunId(fs: FsLike, effRoot: string): Promise<string> {
  let max = 0
  if (await fs.exists(effRoot)) {
    for (const name of await fs.readdir(effRoot)) {
      const m = name.match(/^(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
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
    `## 评审记录\n${node.reviewLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 验收记录\n${node.acceptLog.map(r => `- round ${r.round}: ${r.synthesized.pass ? 'PASS' : 'FAIL'} ${r.synthesized.blockingSummary}`).join('\n')}\n\n` +
    `## 评分\nplan: ${node.score.plan?.score ?? '-'} / exec: ${node.score.exec?.score ?? '-'}\n`
  return `---\n${yamlStringify(fm)}---\n\n${body}`
}

export function parseNodeFile(text: string): TaskNode {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error('efftask: node.md missing frontmatter')
  return yamlParse(m[1]) as TaskNode
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

export function renderTreeSnapshot(nodes: TaskNode[]): string {
  const lines = nodes.map(n => `${'  '.repeat(n.depth)}- [${uiStatus(n.status)}] ${n.title} (${n.status})`)
  return `# Efficient Task Run\n\n${lines.join('\n')}\n`
}

export async function writeRunManifest(fs: FsLike, runDir: string, cfg: EffTaskConfig, nodes: TaskNode[]): Promise<void> {
  const header = `---\n${yamlStringify({ parallelism: cfg.parallelism, phaseRoles: cfg.phaseRoles, caps: cfg.caps, goalPrompt: cfg.goalPrompt })}---\n\n`
  await fs.mkdir(runDir)
  await fs.writeFile(`${runDir}/run.md`, header + renderTreeSnapshot(nodes))
}

// re-export helpers used by orchestrator
export { createNode, emptyPhaseRoles }
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/persistence.test.ts`
Expected: PASS。

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
    .flatMap(v => v.blocking.map(b => `[${v.role}] ${b}`))
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
  // Empty roster => a single main-model reviewer (role=null). Independent & parallel.
  const roster: (RoleBinding | null)[] = args.roles.length > 0 ? args.roles : [null]
  const verdicts: Verdict[] = await Promise.all(
    roster.map(async role => {
      const text = await args.runAgent({ phase: args.phase, node: args.node, role, system: args.system, prompt: args.prompt, signal: args.signal })
      return parseVerdict(text, role ? role.roleName : 'main')
    }),
  )
  return { round: args.round, verdicts, synthesized: synthesizeVerdicts(verdicts) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/roundtable.test.ts`
Expected: PASS。

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
- Consumes: 全部前序类型;`parsePlanOutput`/`parseExecOutput`(Task 3);`runRoundtable`/`RunAgentFn`(Task 6);`childId`(Task 5)。
- Produces:
  - `interface PipelineCtx { config: EffTaskConfig; byId: Map<string, TaskNode>; runAgent: RunAgentFn; persist: (n: TaskNode) => Promise<void>; now: () => string; signal: AbortSignal; onUpdate: () => void }`
  - `stepStart(node, ctx): Promise<void>` — 主模型或 plan 角色出方案 → `parsePlanOutput` → 写 `plan/kind`;圆桌评审(review 角色);不通过且 `iteration.planReview < caps.maxIterations` → 回 PLANNING 记录反馈重出方案;耗尽 → BLOCKED。通过后:decompose→创建声明的子节点(`childId`,deps 映射到兄弟 id)、父置 WAITING_CHILDREN;executable→置 READY。
  - `stepExecute(node, ctx): Promise<void>` — EXECUTING:execute 角色/主模型执行(P1 共享 cwd)→`parseExecOutput`→EXECUTED→圆桌验收(accept 角色);不通过且未耗尽迭代→REWORK 重执行;耗尽→BLOCKED;通过→(P1 跳过 observer 评分)→(P1 MERGE 为 noop)→ACCEPTED。
  - `stepIntegrate(node, ctx): Promise<void>` — INTEGRATION_ACCEPT:对"子结果整体达成父目标"圆桌验收(accept 角色);通过→ACCEPTED;不通过→BLOCKED(P1;P2 再引入重分解)。
- 说明:每步内部在关键状态转移后调用 `ctx.persist(node)` + `ctx.onUpdate()`。子节点 deps 映射:plan 输出的 child.deps 是**兄弟标题**,创建时映射为对应兄弟的 id(找不到的标题丢弃)。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/pipeline.test.ts
import { describe, expect, it } from 'bun:test'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, TaskNode } from './types.js'
import { byIdMap } from './stateMachine.js'
import { PipelineCtx, stepStart, stepExecute } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg: EffTaskConfig = { goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } }
function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn): PipelineCtx {
  return { config: cfg, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW, signal: new AbortController().signal, onUpdate: () => {} }
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

  it('stepStart review fails until iterations exhausted => BLOCKED', async () => {
    const n = root()
    const runAgent: RunAgentFn = async req =>
      req.phase === 'plan'
        ? '```json\n{"kind":"executable","solution":"weak"}\n```'
        : '```json\n{"pass":false,"blocking":["缺验收点"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepStart(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.planReview).toBe(DEFAULT_CAPS.maxIterations)
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

  it('stepExecute accept fails until exhausted => BLOCKED', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const runAgent: RunAgentFn = async req =>
      req.phase === 'execute' ? '```json\n{"execStatus":"x"}\n```' : '```json\n{"pass":false,"blocking":["回归失败"],"comments":""}\n```'
    const ctx = ctxFor([n], runAgent)
    await stepExecute(n, ctx)
    expect(n.status).toBe('BLOCKED')
    expect(n.iteration.acceptance).toBe(DEFAULT_CAPS.maxIterations)
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
import { parseExecOutput, parsePlanOutput } from './parseOutput.js'
import { runRoundtable, type RunAgentFn } from './roundtable.js'
import { childId } from './persistence.js'

export interface PipelineCtx {
  config: EffTaskConfig
  byId: Map<string, TaskNode>
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  signal: AbortSignal
  onUpdate: () => void
}

async function commit(node: TaskNode, status: TaskNode['status'], ctx: PipelineCtx): Promise<void> {
  node.status = status
  node.updatedAt = ctx.now()
  await ctx.persist(node)
  ctx.onUpdate()
}

function planPrompt(node: TaskNode, feedback: string): string {
  return (
    `任务:${node.title}\n目标:${ctxGoal(node)}\n` +
    (feedback ? `上一轮评审阻断意见,请针对性修订:\n${feedback}\n` : '') +
    `请输出一个 json 代码块:{ "kind":"decompose"|"executable", "solution", "keyPoints", "risks", "acceptance", "children":[{"title","deps":["兄弟标题"]}] }。` +
    `能直接完成就 executable(children 省略);需要拆分就 decompose 并给出子任务标题与兄弟间依赖。`
  )
}
function ctxGoal(node: TaskNode): string { return node.plan.solution || node.title }

function reviewPrompt(node: TaskNode): string {
  return `请评审以下方案是否可执行、完整、无重大风险。方案:\n${JSON.stringify(node.plan)}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。有任何阻断问题填入 blocking。`
}
function executePrompt(node: TaskNode): string {
  return `按以下方案执行任务并完成实际改动。方案:\n${JSON.stringify(node.plan)}\n完成后输出 json:{ "execStatus":"做了什么、结果如何" }。`
}
function acceptPrompt(node: TaskNode): string {
  return `请验收执行结果是否达成验收点。验收点:${node.plan.acceptance}\n执行状态:${node.execStatus}\n输出 json:{ "pass":boolean, "blocking":string[], "comments":string }。`
}

function firstRole(node: TaskNode, phase: 'plan' | 'execute') {
  return node.phaseRoles[phase][0] ?? null
}

export async function stepStart(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  const caps = ctx.config.caps
  let feedback = ''
  let lastChildren: { title: string; deps: string[] }[] = []
  // plan → review loop
  for (;;) {
    await commit(node, 'PLANNING', ctx)
    const planText = await ctx.runAgent({ phase: 'plan', node, role: firstRole(node, 'plan'), system: 'plan', prompt: planPrompt(node, feedback), signal: ctx.signal })
    const parsed = parsePlanOutput(planText)
    node.kind = parsed.kind
    node.plan = parsed.plan
    lastChildren = parsed.children
    await commit(node, 'PLAN_REVIEW', ctx)
    const rec = await runRoundtable({ phase: 'review', node, roles: node.phaseRoles.review, round: node.iteration.planReview + 1, system: 'review', prompt: reviewPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
    node.reviewLog.push(rec)
    if (rec.synthesized.pass) break
    node.iteration.planReview++
    feedback = rec.synthesized.blockingSummary
    if (node.iteration.planReview >= caps.maxIterations) { await commit(node, 'BLOCKED', ctx); return }
  }
  if (node.kind === 'decompose') {
    await createChildren(node, lastChildren, ctx)
    await commit(node, 'WAITING_CHILDREN', ctx)
  } else {
    await commit(node, 'READY', ctx)
  }
}

async function createChildren(node: TaskNode, specs: { title: string; deps: string[] }[], ctx: PipelineCtx): Promise<void> {
  // child.deps reference SIBLING TITLES; map each to the sibling's id (drop unknown titles).
  const titleToId = new Map<string, string>()
  specs.forEach((c, i) => titleToId.set(c.title, childId(node.id, i + 1, c.title)))
  specs.forEach((c, i) => {
    const id = childId(node.id, i + 1, c.title)
    const deps = c.deps.map(t => titleToId.get(t)).filter((x): x is string => !!x)
    const child = createNode({ id, title: c.title, parentId: node.id, deps, depth: node.depth + 1, phaseRoles: node.phaseRoles, now: ctx.now() })
    ctx.byId.set(id, child)
    node.childIds.push(id)
  })
  await ctx.persist(node)
}

export async function stepExecute(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  const caps = ctx.config.caps
  for (;;) {
    await commit(node, 'EXECUTING', ctx)
    const execText = await ctx.runAgent({ phase: 'execute', node, role: firstRole(node, 'execute'), system: 'execute', prompt: executePrompt(node), cwd: node.worktree?.path, signal: ctx.signal })
    node.execStatus = parseExecOutput(execText).execStatus
    await commit(node, 'ACCEPTANCE', ctx)
    const rec = await runRoundtable({ phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1, system: 'accept', prompt: acceptPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
    node.acceptLog.push(rec)
    if (rec.synthesized.pass) { await commit(node, 'ACCEPTED', ctx); return }
    node.iteration.acceptance++
    if (node.iteration.acceptance >= caps.maxIterations) { await commit(node, 'BLOCKED', ctx); return }
    await commit(node, 'REWORK', ctx)
  }
}

export async function stepIntegrate(node: TaskNode, ctx: PipelineCtx): Promise<void> {
  await commit(node, 'INTEGRATION_ACCEPT', ctx)
  const rec = await runRoundtable({ phase: 'accept', node, roles: node.phaseRoles.accept, round: node.iteration.acceptance + 1, system: 'integrate', prompt: acceptPrompt(node), runAgent: ctx.runAgent, signal: ctx.signal })
  node.acceptLog.push(rec)
  await commit(node, rec.synthesized.pass ? 'ACCEPTED' : 'BLOCKED', ctx)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/pipeline.test.ts`
Expected: PASS(全部 5 条)。

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
- Consumes: 全部前序;`advanceableKind`(Task 2);`stepStart`/`stepExecute`/`stepIntegrate`/`PipelineCtx`(Task 7)。
- Produces:
  - `interface OrchestratorDeps { runAgent: RunAgentFn; persist: (n: TaskNode) => Promise<void>; now: () => string; onUpdate: (nodes: TaskNode[]) => void }`
  - `class EffTaskOrchestrator { constructor(cfg: EffTaskConfig, deps: OrchestratorDeps, signal: AbortSignal); nodes(): TaskNode[]; run(): Promise<'completed' | 'blocked'> }`
  - 驱动:创建 root(id `'root'`,title 取 `cfg.goalPrompt` 首行/截断);循环 `advanceableKind` 选**第一个**可推进节点(串行)→ 按 kind 调 step*;无可推进且 root 未 ACCEPTED → 死锁 → 返回 `'blocked'`;root ACCEPTED → `'completed'`。安全阀:节点数超 `caps.maxNodes` 时不再创建(在 pipeline createChildren 前由 orchestrator 传入 `byId.size` 检查——本任务在 run() 里超限即把待展开节点置 BLOCKED)。

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
    expect(result).toBe('completed')
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
    expect(result).toBe('completed')
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
    expect(await orch.run()).toBe('blocked')
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
import { createNode, emptyPhaseRoles } from './types.js'
import { advanceableKind, byIdMap } from './stateMachine.js'
import { stepExecute, stepIntegrate, stepStart, type PipelineCtx } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'

export interface OrchestratorDeps {
  runAgent: RunAgentFn
  persist: (n: TaskNode) => Promise<void>
  now: () => string
  onUpdate: (nodes: TaskNode[]) => void
}

function rootTitle(goal: string): string {
  const firstLine = goal.split('\n')[0].trim()
  return firstLine.slice(0, 80) || '根任务'
}

export class EffTaskOrchestrator {
  private byId: Map<string, TaskNode>
  constructor(private cfg: EffTaskConfig, private deps: OrchestratorDeps, private signal: AbortSignal) {
    const root = createNode({ id: 'root', title: rootTitle(cfg.goalPrompt), parentId: null, deps: [], depth: 0, phaseRoles: cfg.phaseRoles ?? emptyPhaseRoles(), now: deps.now() })
    root.plan.solution = cfg.goalPrompt
    this.byId = byIdMap([root])
  }

  nodes(): TaskNode[] { return [...this.byId.values()] }

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

  async run(): Promise<'completed' | 'blocked'> {
    for (;;) {
      if (this.signal.aborted) return 'blocked'
      const root = this.byId.get('root')!
      if (root.status === 'ACCEPTED') return 'completed'
      // pick the first advanceable node (serial). Deterministic order by id.
      const ordered = [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id))
      const next = ordered.find(n => advanceableKind(n, this.byId) !== null)
      if (!next) return 'blocked' // deadlock: nothing advanceable and root not accepted
      const kind = advanceableKind(next, this.byId)
      const ctx = this.ctx()
      if (kind === 'start') await stepStart(next, ctx)
      else if (kind === 'execute') await stepExecute(next, ctx)
      else if (kind === 'integrate') await stepIntegrate(next, ctx)
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/orchestrator.test.ts`
Expected: PASS(全部 4 条)。

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
- Test: `src/tools/efftask/runAgentAdapter.test.ts`(仅测纯函数 `pickAgentDefinition`/`collectText`;真实 `runAgent` 调用不单测,靠 §Task 11 手动/UAT)

**Interfaces:**
- Consumes: `RunAgentFn`(Task 6);`RoleBinding`, `PhaseName`;`AgentDefinition`(现有 `src/tools/AgentTool/*`);`runAgent`(`src/tools/AgentTool/runAgent.ts`);`ToolUseContext`。
- Produces:
  - `pickAgentDefinition(role, activeAgents, mainModelDefault): AgentDefinition` — role 为 null → 主模型默认 agent def;否则从 `activeAgents` 按 `agentType===role.roleName` 找,找不到回退主模型默认。
  - `collectText(messages): string` — 从 runAgent 产出的 assistant 文本拼接。
  - `makeRunAgentFn(deps): RunAgentFn` — 用 `ToolUseContext` + `canUseTool` + `availableTools` 包装 `runAgent()`,把每次调用的 assistant 文本收集返回;`onChunk` 在收到文本增量时回调(供 P3 实时视图);`role.model` 传给 `runAgent` 的 `model`。

- [ ] **Step 1: 写失败测试(纯函数)**

```ts
// src/tools/efftask/runAgentAdapter.test.ts
import { describe, expect, it } from 'bun:test'
import { collectText, pickAgentDefinition } from './runAgentAdapter.js'

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
import type { ToolUseContext } from '../../types/tool.js'
import type { CanUseToolFn } from '../../services/tools/canUseTool.js'
import type { Message } from '../../query.js'
import type { ModelAlias } from '../../utils/model.js'
import type { Tools } from '../../tools.js'
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
  activeAgents: AgentDefinition[]
  mainModelDefault: AgentDefinition
}): RunAgentFn {
  return async req => {
    const agentDefinition = pickAgentDefinition(req.role, deps.activeAgents, deps.mainModelDefault)
    const promptMessages: Message[] = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `${req.system}\n\n${req.prompt}` }] }, uuid: undefined as never } as unknown as Message,
    ]
    const collected: Message[] = []
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: deps.toolUseContext,
      canUseTool: deps.canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: (req.role?.model as ModelAlias | undefined) ?? undefined,
      availableTools: deps.availableTools,
    })) {
      collected.push(message)
      if (req.onChunk && message.type === 'assistant') req.onChunk(collectText([message]))
      if (req.signal.aborted) break
    }
    return collectText(collected)
  }
}
```

> **集成校验(手动,§Task 11 一并做):** `promptMessages` 的 `Message` 具体构造以本仓 `runAgent`/`query` 里 user 消息的真实结构为准(参考 `executeForkedSlashCommand` 的 `prepareForkedCommandContext` 产出的 `promptMessages`)。实现者对齐真实类型:优先复用现有构造 user 文本消息的工具函数而非手搓字面量。`AgentDefinition` 的导入路径以真实导出为准(`loadAgentsDir.ts` / `AgentTool` 类型)。此任务的单测只覆盖 `collectText`/`pickAgentDefinition` 两个纯函数;`makeRunAgentFn` 的真实链路在 Task 11 手动跑 `/et` 验证。

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/runAgentAdapter.test.ts`
Expected: PASS(两个纯函数)。
另:确保 `makeRunAgentFn` 通过 TS 编译(`bun build` 或 IDE 无红)——如类型不符,按上面的校验说明对齐真实 `Message`/`AgentDefinition` 类型,不得用 `as any` 掩盖(仅 `promptMessages` 构造可临时按现有 helper 对齐)。

- [ ] **Step 5: 提交**

```bash
git add src/tools/efftask/runAgentAdapter.ts src/tools/efftask/runAgentAdapter.test.ts
git commit -m "feat(efftask): runAgent adapter (RunAgentFn seam)"
```

---

## Task 10: 启动确认(终端 + 飞书竞速)

**Files:**
- Create: `src/tools/efftask/startupConfirm.ts`(纯竞速/合成逻辑,单测)
- Create: `src/commands/efftask/ConfirmStartup.tsx`(Ink UI,手动验证)
- Test: `src/tools/efftask/startupConfirm.test.ts`

**Interfaces:**
- Consumes: `EffTaskConfig`(Task 1);`FeishuClient`/`getFeishuConfig`(`src/services/feishu/*`)。
- Produces:
  - `interface StartupDecision { parallelism: number; approved: boolean }`
  - `createResolveOnce<T>(): { claim(): boolean; resolve(v: T): void; promise: Promise<T> }` — 单次胜出竞速原语(镜像 interactiveHandler 的 racer 语义)。
  - `raceConfirm(surfaces: Array<(claimAndResolve: (d: StartupDecision) => void) => (() => void)>): Promise<StartupDecision>` — 启动各 surface(终端/飞书),首个 `claimAndResolve` 胜出,其余被要求 teardown(返回的清理函数被调用)。
- P1 说明:角色名册在 P1 恒为"全主模型"(无 role 绑定),确认卡片主要呈现 **并行数 + 根方案摘要**,用户可 approve/取消(P1 不做行内编辑并行数的复杂交互,提供 approve=用建议值 / cancel=退出;并行数编辑放 P2)。飞书卡片复用 `FeishuClient.sendCard`,动作回传经 `onCardAction` 触发 `claimAndResolve`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/efftask/startupConfirm.test.ts
import { describe, expect, it } from 'bun:test'
import { createResolveOnce, raceConfirm } from './startupConfirm.js'

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
})
```

- [ ] **Step 2: 运行确认失败**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/startupConfirm.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现(纯逻辑)**

```ts
// src/tools/efftask/startupConfirm.ts
export interface StartupDecision { parallelism: number; approved: boolean }

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
  for (const surface of surfaces) teardowns.push(surface(claimAndResolve))
  const decision = await once.promise
  for (const t of teardowns) { try { t() } catch { /* ignore */ } }
  return decision
}
```

- [ ] **Step 4: 运行确认通过**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/startupConfirm.test.ts`
Expected: PASS。

- [ ] **Step 5: 实现 Ink 确认组件(手动验证)**

```tsx
// src/commands/efftask/ConfirmStartup.tsx
import * as React from 'react'
import { Box, Text, useInput } from 'ink'
import type { EffTaskConfig } from '../../tools/efftask/types.js'
import type { StartupDecision } from '../../tools/efftask/startupConfirm.js'

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
      <Text>角色: 全部使用主模型（P1）</Text>
      <Text>安全阀: 深度{props.config.caps.maxDepth} / 节点{props.config.caps.maxNodes} / 迭代{props.config.caps.maxIterations}</Text>
      <Text dimColor>回车/y 开始 · Esc/n 取消</Text>
    </Box>
  )
}
```

- [ ] **Step 6: 提交**

```bash
git add src/tools/efftask/startupConfirm.ts src/tools/efftask/startupConfirm.test.ts src/commands/efftask/ConfirmStartup.tsx
git commit -m "feat(efftask): startup confirmation racer (terminal + feishu seam)"
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
- Consumes: `EffTaskOrchestrator`/`OrchestratorDeps`(Task 8);`parseDirectives`(Task 4);`makeRunAgentFn`(Task 9);`ConfirmStartup`/`raceConfirm`/`sendFeishuStartupCard`(Task 10);持久化(Task 5);`getFeishuConfig`/`FeishuClient`;命令类型 `LocalJSXCommandCall`(`src/types/command.ts`);`getFsImplementation()`。
- Produces: 一个可 `/et <prompt>` 触发的 local-jsx 命令。

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
  const nowMs = Date.now()
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
import type { LocalJSXCommandCall } from '../../types/command.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { allocateRunId, writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import { createNode, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { getFsImplementation } from '../../utils/fsOperations.js'

// 集成接线,无单测;手动跑 /et 验证。
// 构造顺序很重要:fs → runId → runAgent(RunAgentFn) → 用 runAgent 解析配置 → 渲染。
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const cwd = process.cwd()
  const fs = fsAdapter()
  const effRoot = `${cwd}/.claude/efftask`
  const runId = await allocateRunId(fs, effRoot)
  const runDir = `${effRoot}/${runId}`
  const signal = context.abortController.signal

  // 1) 先构造真实 RunAgentFn(Task 9)。实现者据真实 context 字段补全:
  //    availableTools = context.options.tools;activeAgents = context.options.agentDefinitions?.activeAgents ?? []
  const activeAgents = context.options.agentDefinitions?.activeAgents ?? []
  const runAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool: context.canUseTool,
    availableTools: context.options.tools,
    activeAgents,
    mainModelDefault: mainAgentDefinition(),
  })

  // 2) 用 runAgent 抽取配置;parseDirectives 内部已对 modelJson 抛错/非法做默认回退。
  const knownRoles = activeAgents.map(a => a.agentType)
  const config: EffTaskConfig = await parseDirectives(args, {
    knownRoles,
    modelJson: prompt => runAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal }),
  })

  return (
    <EffTaskRunner
      config={config}
      runId={runId}
      runDir={runDir}
      fs={fs}
      runAgent={runAgent}
      signal={signal}
      onExit={() => onDone('高效任务结束', { display: 'system' })}
    />
  )
}

// 一次性配置抽取用的占位节点(不入树,只是给 RunAgentFn 一个合法 node 形参)。
function stubNode(): TaskNode {
  return createNode({ id: '__extract__', title: 'extract', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: new Date().toISOString() })
}

// TODO(实现者): 返回满足 AgentDefinition 必填字段的"主模型默认"定义。字段以
// src/tools/AgentTool/loadAgentsDir.ts 的 AgentDefinition 为准(agentType/whenToUse/tools/source/baseDir/getSystemPrompt 等),
// 可参考 activeAgents 里的通用项结构。此处的 cast 是给实现者对齐真实类型用的唯一逃逸口。
function mainAgentDefinition(): Parameters<typeof makeRunAgentFn>[0]['mainModelDefault'] {
  return { agentType: 'et-main', whenToUse: '高效任务主模型执行', tools: undefined, source: 'efftask', baseDir: 'efftask', getSystemPrompt: () => '' } as unknown as Parameters<typeof makeRunAgentFn>[0]['mainModelDefault']
}

// 方法名/签名以真实 FsOperations 为准(src/utils/fsOperations.ts):readFile/writeFile/mkdir/readdir/existsSync。
function fsAdapter(): FsLike {
  const impl = getFsImplementation()
  return {
    readFile: p => impl.readFile(p, 'utf-8') as unknown as Promise<string>,
    writeFile: async (p, d) => { await impl.mkdir(dirOf(p), { recursive: true } as never); await impl.writeFile(p, d) },
    mkdir: async p => { await impl.mkdir(p, { recursive: true } as never) },
    readdir: p => impl.readdir(p) as unknown as Promise<string[]>,
    exists: async p => impl.existsSync(p),
  }
}
function dirOf(p: string): string { return p.slice(0, p.lastIndexOf('/')) }

function EffTaskRunner(props: {
  config: EffTaskConfig; runId: string; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal; onExit: () => void
}): React.ReactElement {
  const [phase, setPhase] = React.useState<'confirm' | 'running'>('confirm')
  const [nodes, setNodes] = React.useState<TaskNode[]>([])

  if (phase === 'confirm') {
    return (
      <ConfirmStartup
        config={props.config}
        onDecision={d => {
          if (!d.approved) { props.onExit(); return }
          setPhase('running')
          void runOrchestrator(props, setNodes)
        }}
      />
    )
  }
  return <TaskTreePanel nodes={nodes} runId={props.runId} />
}

async function runOrchestrator(
  props: { config: EffTaskConfig; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal },
  setNodes: (n: TaskNode[]) => void,
): Promise<void> {
  const persist = (n: TaskNode) => writeNode(props.fs, props.runDir, n)
  const now = () => new Date().toISOString()
  const orch = new EffTaskOrchestrator(
    props.config,
    { runAgent: props.runAgent, persist, now, onUpdate: nodes => { setNodes([...nodes]); void writeRunManifest(props.fs, props.runDir, props.config, nodes) } },
    props.signal,
  )
  await orch.run()
  await writeRunManifest(props.fs, props.runDir, props.config, orch.nodes())
}
```

> **Task 11 是集成任务(无单测,手动跑 `/et` 验证)。** 上面的代码结构是完整的,只有两处保留 `as unknown as` 逃逸口需要实现者对齐真实类型:(1) `mainAgentDefinition()` 必须满足 `src/tools/AgentTool/loadAgentsDir.ts` 的 `AgentDefinition` 必填字段;(2) `fsAdapter()` 的方法签名以真实 `FsOperations`(`src/utils/fsOperations.ts`:`readFile/writeFile/mkdir/readdir/existsSync`)为准。`context` 的字段(`context.canUseTool`、`context.options.tools`、`context.options.agentDefinitions?.activeAgents`、`context.abortController.signal`)以真实 `ToolUseContext & LocalJSXCommandContext` 类型为准——若字段名不符,按真实类型改,不得用 `any` 掩盖。删除逃逸 cast 后代码须通过 TS 编译。

- [ ] **Step 5: 手动验证(冒烟)**

在一个玩具 git 仓库 `cwd` 里:
1. 配置一个最小 `.claude/settings.json`(可留空 roles)。
2. 启动本 CLI(`bun run ./bin/claude-haha`)。
3. 输入 `/et 写一个 hello.txt,内容为 hi`。
4. 期望:出现启动确认卡片 → 回车 → 出现任务树面板 → root 走 plan→review→execute→accept → 变绿 ACCEPTED;`.claude/efftask/001/root/node.md` 存在且含方案与执行状态;`hello.txt` 被创建。
5. 若配置了飞书(`.claude/settings.json` 的 `feishu.enabled=true` + 凭据),确认卡片应同时出现在飞书,任一端点击都能推进(P1 至少终端可推进;飞书推进依赖 §Task 10 飞书 surface 接线,若时间不足可 P2 补,但终端与飞书**卡片展示**须都在)。

- [ ] **Step 6: 全量回归 + 提交**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/efftask/
git add src/commands/efftask/ src/commands.ts
git commit -m "feat(efftask): /et command, read-only live tree, wiring"
```
Expected: efftask 逻辑测试全绿;`/et` 冒烟通过。

---

## P1 完成标准(Definition of Done)

- `bun test src/tools/efftask/` 全绿(types/stateMachine/parseOutput/parseDirectives/persistence/roundtable/pipeline/orchestrator/runAgentAdapter/startupConfirm 共 10 个测试文件)。
- `/et <prompt>` 可触发:启动确认(终端 + 飞书卡片展示)→ 串行跑通单/多节点(decompose)任务树 → 节点落盘 `.claude/efftask/<runId>/` 镜像目录 → 只读实时树显示状态着色 + 耗时。
- 依赖门控生效(依赖未 ACCEPTED 的节点不执行)。
- 安全阀:评审/验收迭代超 `maxIterations` → 节点 BLOCKED(不静默)。
- 未触碰 P2/P3 范围(无并行、无 worktree、无多角色>1、无评分、无 runtime 动态加节点、无交互展开/详情)。

## 交接到 P2/P3

P1 合并后,基于真实接口再写:
- **P2 计划**:并发池(`parallelism` 生效)+ 跨分支依赖调度 + git worktree 隔离(`src/tools/efftask/worktree.ts`)+ 合并回集成分支 + finishing-a-development-branch 收口 + 启动确认支持并行数编辑 + 飞书推进 surface 完整接线。
- **P3 计划**:多角色(>1)圆桌全链路 + 观察评分 + 执行中 runtime `addChild` 动态生长 + 全部安全阀(节点数/超时 tree-kill)+ 交互式树面板(展开/折叠 + Enter 进 `NodeDetailView` + 子 agent 实时终端)。
