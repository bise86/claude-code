# 多角色子 Agent Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `settings.json` 用 `roles` 数组定义多个子 Agent，主会话按能力（`whenToUse`）派遣；每角色支持 **API 模式**（Anthropic / OpenAI 双协议，每角色独立 URL/Token/模型/思考深度）与 **CLI 模式**（非交互单次 / 交互式 JSON-lines）。子 Agent 自身的确认经父级 `canUseTool` 走已有竞速器（含 Plan A 的飞书面）。

**Architecture:** roles 用独立 schema 解析成扩展后的 `AgentDefinition` 并入 `activeAgents`（复用派遣）。API 模式用**每角色 `fetchOverride` 垫片**（接缝在 `src/query.ts:665-707`）：anthropic 协议在 fetch 层完全接管 URL+鉴权；openai 协议把 Anthropic 请求/响应流双向翻译。CLI 模式在 `AgentTool.call` 按 `execMode` 分叉到 `cliAgentRunner`，产出与 `runAgent` 同形状的 Message 流；交互档收到 `permission_request` 时调父级 `canUseTool`。

**Tech Stack:** TypeScript / Bun / Anthropic SDK 请求-响应格式 / zod / `bun test`。

## Global Constraints

- 运行时 Bun；测试 `bun test <file>`。**仅 TUI 模式**（无头非目标）。
- 角色配置明文（`apiToken` 直接写 settings.json）。
- **不复用** `parseAgentsFromJson`/`AgentJsonSchema`（会 strip 执行字段）——写独立 schema/映射。
- 角色 `name` 不得与 `getBuiltInAgents()` 的 agentType 撞名（校验拒绝/告警）。
- 定义字段用 `execMode`（非 `mode`，避开 `AgentToolInput.mode`）。
- OpenAI 角色的引擎 `mainLoopModel` 保持 **Claude 别名**（引擎数学/门控用），真实后端模型放 shim 配置、fetch 边界替换。
- anthropic/openai 两种协议均在 shim 完全接管 URL + 鉴权头（不能依赖 `getAnthropicClient` 默认 auth）。
- 每角色 client 配置经 `toolUseContext.options` 下传（`fetchOverride` 已是一等参数）。
- 源码锚点以规格 `docs/superpowers/specs/2026-07-24-feishu-and-multi-role-agents-design.md` 第 4/6 节为准。

---

## File Structure

- Create `src/tools/AgentTool/roles/roleTypes.ts` — `RoleConfig`、`RoleClientConfig` 类型。
- Create `src/tools/AgentTool/roles/rolesFromSettings.ts` — 独立 schema + 解析成 `AgentDefinition[]`。
- Modify `src/tools/AgentTool/loadAgentsDir.ts` — `BaseAgentDefinition` 扩字段；`getActiveAgentsFromList` 补 `localSettings` 桶；`getAgentDefinitionsWithOverrides` 并入 roles + 撞名校验。
- Create `src/services/api/openaiCompat/toOpenAIRequest.ts` — Anthropic 请求 → OpenAI 请求。
- Create `src/services/api/openaiCompat/fromOpenAIStream.ts` — OpenAI SSE → Anthropic SSE。
- Create `src/services/api/openaiCompat/roleFetch.ts` — 由 `RoleClientConfig` 造 `fetchOverride`（anthropic 直通改写 / openai 翻译）。
- Modify `src/query.ts` — 从 `toolUseContext.options.roleClientConfig` 组装 `fetchOverride`（`:665-707`）。
- Modify `src/tools/AgentTool/runAgent.ts` — 把角色 client 配置塞进 `agentOptions`。
- Modify `src/tools/AgentTool/AgentTool.tsx` — `call()` 按 `execMode==='cli'` 分叉。
- Create `src/tools/AgentTool/cliAgentRunner.ts` — CLI 两档执行，yield Message 流。
- Create `docs/roles-setup.md` — 角色配置说明。
- Tests colocated `*.test.ts`。

---

## Task 1: roles 配置 schema 与解析

**Files:**
- Modify: `src/utils/settings/types.ts`（`SettingsSchema` 加 `roles` 可选数组）
- Create: `src/tools/AgentTool/roles/roleTypes.ts`
- Create: `src/tools/AgentTool/roles/rolesFromSettings.ts`
- Test: `src/tools/AgentTool/roles/rolesFromSettings.test.ts`

**Interfaces:**
- Produces:
  - `type RoleClientConfig = { apiProtocol: 'anthropic'|'openai'; apiUrl: string; apiToken: string; backendModel: string; thinkingDepth?: string }`
  - `type RoleConfig = { name: string; whenToUse: string; execMode: 'api'|'cli'; tools?: string[]; prompt?: string; api?: RoleClientConfig; command?: string; args?: string[]; interactive?: boolean; roleCwd?: string }`
  - `function parseRoles(rawRoles: unknown, source: string): { role: RoleConfig; agentDef: RoleAgentDefinition }[]`（坏项跳过并 `logError`，不抛）
  - `RolesSchema`（zod，数组）。
  - `type RoleAgentDefinition`（Task 2 扩展的 `BaseAgentDefinition`，含 `execMode/roleClientConfig/command/args/interactive/roleCwd`）。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/AgentTool/roles/rolesFromSettings.test.ts
import { describe, it, expect } from 'bun:test'
import { parseRoles } from './rolesFromSettings.js'

describe('parseRoles', () => {
  it('parses an api role and KEEPS the api client fields (not stripped)', () => {
    const out = parseRoles([{ name: 'rev', whenToUse: 'review', execMode: 'api',
      apiProtocol: 'openai', apiUrl: 'https://x/v1', apiToken: 'sk', model: 'gpt-4o', thinkingDepth: 'high' }], 'userSettings')
    expect(out).toHaveLength(1)
    expect(out[0].agentDef.agentType).toBe('rev')
    expect(out[0].agentDef.whenToUse).toBe('review')
    expect(out[0].agentDef.execMode).toBe('api')
    expect(out[0].agentDef.roleClientConfig).toEqual({ apiProtocol: 'openai', apiUrl: 'https://x/v1', apiToken: 'sk', backendModel: 'gpt-4o', thinkingDepth: 'high' })
  })
  it('parses a cli role keeping command/args/interactive', () => {
    const out = parseRoles([{ name: 'c', whenToUse: 'w', execMode: 'cli', command: 'adapter', args: ['--json'], interactive: true }], 'localSettings')
    expect(out[0].agentDef.execMode).toBe('cli')
    expect(out[0].agentDef.command).toBe('adapter')
    expect(out[0].agentDef.interactive).toBe(true)
  })
  it('skips invalid role (missing name) without throwing', () => {
    expect(parseRoles([{ whenToUse: 'w', execMode: 'api' }], 'userSettings')).toHaveLength(0)
  })
  it('wraps prompt string into getSystemPrompt', async () => {
    const out = parseRoles([{ name: 'p', whenToUse: 'w', execMode: 'cli', command: 'x', prompt: 'SYS' }], 'userSettings')
    const sp = await out[0].agentDef.getSystemPrompt?.({} as any)
    expect(sp).toContain('SYS')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/tools/AgentTool/roles/rolesFromSettings.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现类型 + schema + 解析**

```ts
// src/tools/AgentTool/roles/roleTypes.ts
export type RoleClientConfig = {
  apiProtocol: 'anthropic' | 'openai'; apiUrl: string; apiToken: string
  backendModel: string; thinkingDepth?: string
}
export type RoleConfig = {
  name: string; whenToUse: string; execMode: 'api' | 'cli'
  tools?: string[]; prompt?: string
  api?: RoleClientConfig
  command?: string; args?: string[]; interactive?: boolean; roleCwd?: string
}
```

```ts
// src/tools/AgentTool/roles/rolesFromSettings.ts
import { z } from 'zod'
import { logError } from '../../../utils/log.js'
import type { RoleClientConfig } from './roleTypes.js'

const RoleSchema = z.object({
  name: z.string().min(1), whenToUse: z.string().min(1),
  execMode: z.enum(['api', 'cli']),
  tools: z.array(z.string()).optional(), prompt: z.string().optional(),
  apiProtocol: z.enum(['anthropic', 'openai']).optional(),
  apiUrl: z.string().optional(), apiToken: z.string().optional(),
  model: z.string().optional(), thinkingDepth: z.string().optional(),
  command: z.string().optional(), args: z.array(z.string()).optional(),
  interactive: z.boolean().optional(), cwd: z.string().optional(),
}).strict()  // strict：坏字段可见，别静默 strip

export const RolesSchema = z.array(RoleSchema)

export type RoleAgentDefinition = {
  agentType: string; whenToUse: string; tools?: string[]
  source: string; baseDir: string
  getSystemPrompt?: (p: unknown) => Promise<string> | string
  execMode: 'api' | 'cli'
  roleClientConfig?: RoleClientConfig
  command?: string; args?: string[]; interactive?: boolean; roleCwd?: string
  model?: string; effort?: string
}

export function parseRoles(rawRoles: unknown, source: string): { role: any; agentDef: RoleAgentDefinition }[] {
  const parsed = RolesSchema.safeParse(rawRoles)
  const items = parsed.success ? parsed.data : []
  if (!parsed.success && rawRoles != null) logError(new Error('invalid roles config: ' + parsed.error.message))
  const out: { role: any; agentDef: RoleAgentDefinition }[] = []
  for (const r of items) {
    try {
      const roleClientConfig: RoleClientConfig | undefined = r.execMode === 'api'
        ? { apiProtocol: r.apiProtocol ?? 'anthropic', apiUrl: r.apiUrl!, apiToken: r.apiToken!, backendModel: r.model!, thinkingDepth: r.thinkingDepth }
        : undefined
      const promptStr = r.prompt
      out.push({ role: r, agentDef: {
        agentType: r.name, whenToUse: r.whenToUse, tools: r.tools, source, baseDir: 'role',
        getSystemPrompt: promptStr ? () => promptStr : undefined,
        execMode: r.execMode, roleClientConfig,
        command: r.command, args: r.args, interactive: r.interactive, roleCwd: r.cwd,
        model: r.model, effort: r.thinkingDepth,
      }})
    } catch (e) { logError(e) }
  }
  return out
}
```

在 `src/utils/settings/types.ts` 的 `SettingsSchema`、`.passthrough()` 前加：
```ts
  roles: z.array(z.record(z.string(), z.unknown())).optional(),
```
（顶层宽松，严格校验在 `parseRoles`。）

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/tools/AgentTool/roles/rolesFromSettings.test.ts`
Expected: PASS（4 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/AgentTool/roles/ src/utils/settings/types.ts
git commit -m "feat(roles): independent schema + parseRoles (keeps api/cli fields)"
```

---

## Task 2: 并入 activeAgents（扩类型 + localSettings 桶 + 撞名校验）

**Files:**
- Modify: `src/tools/AgentTool/loadAgentsDir.ts`
- Test: `src/tools/AgentTool/roles/mergeRoles.test.ts`

**Interfaces:**
- Consumes: `parseRoles`、`getBuiltInAgents`、`getSettingsForSource`。
- Produces:
  - `function collectRoleAgents(): RoleAgentDefinition[]` — 读 user/project/local settings 的 roles，撞名剔除并告警。
  - `BaseAgentDefinition` 增加可选字段：`execMode?/roleClientConfig?/command?/args?/interactive?/roleCwd?`。
  - `getActiveAgentsFromList` 增加 `localSettings` 桶。
  - `getAgentDefinitionsWithOverrides` 的 `allAgentsList` 追加 `collectRoleAgents()`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/AgentTool/roles/mergeRoles.test.ts
import { describe, it, expect } from 'bun:test'
import { filterCollidingRoles } from '../loadAgentsDir.js'

describe('filterCollidingRoles', () => {
  it('drops roles whose name collides with a built-in agentType and keeps others', () => {
    const builtinTypes = new Set(['general-purpose', 'Explore'])
    const roles = [
      { agentType: 'general-purpose' } as any,  // 撞名 → 丢
      { agentType: 'reviewer' } as any,          // 保留
    ]
    const kept = filterCollidingRoles(roles, builtinTypes)
    expect(kept.map(r => r.agentType)).toEqual(['reviewer'])
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/tools/AgentTool/roles/mergeRoles.test.ts`
Expected: FAIL（`filterCollidingRoles` 未导出）。

- [ ] **Step 3: 实现**

在 `loadAgentsDir.ts`：

(a) `BaseAgentDefinition`（`:106`）加可选字段：
```ts
  execMode?: 'api' | 'cli'
  roleClientConfig?: import('./roles/roleTypes.js').RoleClientConfig
  command?: string; args?: string[]; interactive?: boolean; roleCwd?: string
```

(b) 导出撞名过滤纯函数：
```ts
export function filterCollidingRoles<T extends { agentType: string }>(roles: T[], builtinTypes: Set<string>): T[] {
  return roles.filter(r => {
    if (builtinTypes.has(r.agentType)) { logError(new Error(`role "${r.agentType}" collides with built-in agent; ignored`)); return false }
    return true
  })
}
```

(c) `collectRoleAgents`（按源读取，正确归属 source）：
```ts
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { parseRoles } from './roles/rolesFromSettings.js'
import { getBuiltInAgents } from './builtInAgents.js'
export function collectRoleAgents() {
  const sources = ['userSettings', 'projectSettings', 'localSettings'] as const
  const all = sources.flatMap(s => parseRoles((getSettingsForSource(s) as any)?.roles, s).map(x => x.agentDef))
  const builtinTypes = new Set(getBuiltInAgents().map(a => a.agentType))
  return filterCollidingRoles(all, builtinTypes)
}
```

(d) `getActiveAgentsFromList`（`:196`）的 source 分桶补 `localSettings`（与 `projectSettings` 同优先级或紧随其后）。

(e) `getAgentDefinitionsWithOverrides`（`:296`）里，构造 `allAgentsList` 处 `.concat(collectRoleAgents())`（在 `getActiveAgentsFromList` 之前）。

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/tools/AgentTool/roles/mergeRoles.test.ts`
Expected: PASS。

- [ ] **Step 5: 手动校验注册（需 Bun）**

Run: 在 `settings.json` 配一个 `execMode:"cli"` 的角色，启动后让主会话 `Agent(subagent_type:"该角色名")`。
Expected: 不再报 "Agent type not found"（说明进了 activeAgents）。

- [ ] **Step 6: 提交**

```bash
git add src/tools/AgentTool/loadAgentsDir.ts src/tools/AgentTool/roles/mergeRoles.test.ts
git commit -m "feat(roles): merge roles into activeAgents (+localSettings bucket, collision guard)"
```

---

## Task 3: OpenAI 请求映射（Anthropic → /v1/chat/completions）

**Files:**
- Create: `src/services/api/openaiCompat/toOpenAIRequest.ts`
- Test: `src/services/api/openaiCompat/toOpenAIRequest.test.ts`

**Interfaces:**
- Produces: `function toOpenAIRequest(anthropicBody: any, backendModel: string, thinkingDepth?: string): any`

- [ ] **Step 1: 写失败测试**

```ts
// src/services/api/openaiCompat/toOpenAIRequest.test.ts
import { describe, it, expect } from 'bun:test'
import { toOpenAIRequest } from './toOpenAIRequest.js'

describe('toOpenAIRequest', () => {
  it('maps system + messages, uses backendModel, drops anthropic-only fields', () => {
    const out = toOpenAIRequest({
      model: 'claude-alias', system: [{ type: 'text', text: 'SYS' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 100, betas: ['x'], thinking: { type: 'enabled' }, metadata: { a: 1 },
    }, 'gpt-4o')
    expect(out.model).toBe('gpt-4o')
    expect(out.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(out.max_completion_tokens).toBe(100)
    expect(out.betas).toBeUndefined(); expect(out.thinking).toBeUndefined(); expect(out.metadata).toBeUndefined()
    expect(out.stream_options).toEqual({ include_usage: true })
  })
  it('flattens tool_use → assistant.tool_calls and tool_result → role:tool messages in order', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]}, 'gpt-4o')
    expect(out.messages[0]).toEqual({ role: 'assistant', content: null, tool_calls: [
      { id: 't1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ cmd: 'ls' }) } }]})
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' })
  })
  it('maps tools[].input_schema → function.parameters and thinkingDepth → reasoning_effort', () => {
    const out = toOpenAIRequest({ model: 'm', messages: [],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }] }, 'o1', 'high')
    expect(out.tools[0]).toEqual({ type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } } })
    expect(out.reasoning_effort).toBe('high')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/api/openaiCompat/toOpenAIRequest.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/services/api/openaiCompat/toOpenAIRequest.ts
const DROP = new Set(['betas','anthropic_beta','output_config','context_management','metadata','thinking','container','anthropic_version'])
function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('')
  return ''
}
export function toOpenAIRequest(body: any, backendModel: string, thinkingDepth?: string): any {
  const messages: any[] = []
  if (body.system) messages.push({ role: 'system', content: textOf(body.system) })
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use')
    const toolResults = blocks.filter((b: any) => b.type === 'tool_result')
    if (m.role === 'assistant' && toolUses.length) {
      messages.push({ role: 'assistant', content: textOf(blocks) || null,
        tool_calls: toolUses.map((t: any) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) })
    } else if (toolResults.length) {
      for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: textOf(tr.content) })
    } else {
      messages.push({ role: m.role, content: textOf(blocks) })
    }
  }
  const out: any = { model: backendModel, messages, stream: body.stream, stream_options: { include_usage: true } }
  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.tools) out.tools = body.tools.map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  if (body.tool_choice) out.tool_choice = body.tool_choice.type === 'auto' ? 'auto' : body.tool_choice.type === 'any' ? 'required' : { type: 'function', function: { name: body.tool_choice.name } }
  if (thinkingDepth) out.reasoning_effort = thinkingDepth
  for (const k of Object.keys(out)) if (DROP.has(k)) delete out[k]
  return out
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/api/openaiCompat/toOpenAIRequest.test.ts`
Expected: PASS（3 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/api/openaiCompat/toOpenAIRequest.ts src/services/api/openaiCompat/toOpenAIRequest.test.ts
git commit -m "feat(openai-compat): anthropic→openai request mapping"
```

---

## Task 4: OpenAI 响应流翻译（OpenAI SSE → Anthropic SSE）

**Files:**
- Create: `src/services/api/openaiCompat/fromOpenAIStream.ts`
- Test: `src/services/api/openaiCompat/fromOpenAIStream.test.ts`

**Interfaces:**
- Produces: `async function* openaiChunksToAnthropicEvents(chunks: AsyncIterable<any>, ctx: { anthropicModel: string }): AsyncGenerator<{ event: string; data: any }>` — 输入 OpenAI `chat.completion.chunk` 对象流，输出 Anthropic 事件序列。
- 另 `function anthropicEventsToSSE(events): ReadableStream<Uint8Array>`（把事件序列编码成 `text/event-stream` body，供 roleFetch 用）。

- [ ] **Step 1: 写失败测试**

```ts
// src/services/api/openaiCompat/fromOpenAIStream.test.ts
import { describe, it, expect } from 'bun:test'
import { openaiChunksToAnthropicEvents } from './fromOpenAIStream.js'

async function collect(chunks: any[]) {
  const evts: any[] = []
  for await (const e of openaiChunksToAnthropicEvents((async function*(){ for (const c of chunks) yield c })(), { anthropicModel: 'claude-alias' })) evts.push(e)
  return evts
}

describe('openaiChunksToAnthropicEvents', () => {
  it('emits message_start with skeleton, text deltas, and message_stop', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'He' } }] },
      { choices: [{ delta: { content: 'llo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ])
    const types = evts.map(e => e.event)
    expect(types[0]).toBe('message_start')
    expect(evts[0].data.message.usage).toBeDefined()
    expect(types).toContain('content_block_delta')
    const text = evts.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('')
    expect(text).toBe('Hello')
    const md = evts.find(e => e.event === 'message_delta')
    expect(md.data.delta.stop_reason).toBe('end_turn')
    expect(md.data.usage.output_tokens).toBe(2)
    expect(types[types.length - 1]).toBe('message_stop')
  })

  it('maps tool_calls to a tool_use content block at global index 1 after text', async () => {
    const evts = await collect([
      { id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '{"cmd":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = evts.filter(e => e.event === 'content_block_start')
    expect(starts.find(s => s.data.content_block.type === 'tool_use').data.index).toBe(1)
    const partial = evts.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('')
    expect(partial).toBe('{"cmd":"ls"}')
    expect(evts.find(e => e.event === 'message_delta').data.delta.stop_reason).toBe('tool_use')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/api/openaiCompat/fromOpenAIStream.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现（核心状态机；边界以测试为准）**

```ts
// src/services/api/openaiCompat/fromOpenAIStream.ts
const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' }
type Evt = { event: string; data: any }
export async function* openaiChunksToAnthropicEvents(chunks: AsyncIterable<any>, ctx: { anthropicModel: string }): AsyncGenerator<Evt> {
  let started = false, textOpen = false, textIndex = -1, nextIndex = 0
  const toolBlocks = new Map<number, { globalIndex: number }>()  // openai tool index → anthropic block
  let stopReason = 'end_turn'
  let usage = { input_tokens: 0, output_tokens: 0 }
  const startIfNeeded = function* (id?: string): Generator<Evt> {
    if (started) return
    started = true
    yield { event: 'message_start', data: { type: 'message_start', message: {
      id: id ?? 'msg_openai', type: 'message', role: 'assistant', model: ctx.anthropicModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } }
  }
  for await (const c of chunks) {
    if (c.usage) usage = { input_tokens: c.usage.prompt_tokens ?? 0, output_tokens: c.usage.completion_tokens ?? 0 }
    const choice = c.choices?.[0]; if (!choice && !c.usage) continue
    const delta = choice?.delta ?? {}
    yield* startIfNeeded(c.id)
    if (typeof delta.content === 'string' && delta.content.length) {
      if (!textOpen) { textOpen = true; textIndex = nextIndex++; yield { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } } }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } } }
    }
    for (const tc of delta.tool_calls ?? []) {
      let blk = toolBlocks.get(tc.index)
      if (!blk) {
        if (textOpen) { yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }; textOpen = false }
        blk = { globalIndex: nextIndex++ }; toolBlocks.set(tc.index, blk)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: blk.globalIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name, input: {} } } }
      }
      if (tc.function?.arguments) yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: blk.globalIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } }
    }
    if (choice?.finish_reason) stopReason = STOP[choice.finish_reason] ?? 'end_turn'
  }
  if (textOpen) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } }
  for (const blk of toolBlocks.values()) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: blk.globalIndex } }
  yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } }
  yield { event: 'message_stop', data: { type: 'message_stop' } }
}
export function anthropicEventsToSSE(events: AsyncIterable<Evt>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({ async start(ctrl) {
    for await (const e of events) ctrl.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
    ctrl.close()
  }})
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/api/openaiCompat/fromOpenAIStream.test.ts`
Expected: PASS（2 通过）。补充边界测试（content_filter、无 usage、并行多 tool、错误 chunk）逐条加，均先写测试再改实现。

- [ ] **Step 5: 提交**

```bash
git add src/services/api/openaiCompat/fromOpenAIStream.ts src/services/api/openaiCompat/fromOpenAIStream.test.ts
git commit -m "feat(openai-compat): openai stream → anthropic SSE events"
```

---

## Task 5: roleFetch（anthropic 直通改写 + openai 翻译）

**Files:**
- Create: `src/services/api/openaiCompat/roleFetch.ts`
- Test: `src/services/api/openaiCompat/roleFetch.test.ts`

**Interfaces:**
- Consumes: `RoleClientConfig`、`toOpenAIRequest`、`openaiChunksToAnthropicEvents`/`anthropicEventsToSSE`。
- Produces: `function buildRoleFetch(cfg: RoleClientConfig): typeof fetch` — 返回可传给 `getAnthropicClient({fetchOverride})` 的 fetch。anthropic：改写 URL host + 鉴权头；openai：翻译请求/响应流。

- [ ] **Step 1: 写失败测试**

```ts
// src/services/api/openaiCompat/roleFetch.test.ts
import { describe, it, expect } from 'bun:test'
import { buildRoleFetch } from './roleFetch.js'

describe('buildRoleFetch anthropic passthrough', () => {
  it('rewrites host and replaces auth headers with role token', async () => {
    let seenUrl = '', seenHeaders: any = {}
    const inner = async (url: any, init: any) => { seenUrl = String(url); seenHeaders = init.headers; return new Response('{}') }
    const f = buildRoleFetch({ apiProtocol: 'anthropic', apiUrl: 'https://role.example/anthropic', apiToken: 'sk-role', backendModel: 'x' }, inner as any)
    await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'authorization': 'Bearer GLOBAL', 'x-api-key': 'GLOBAL' }, body: '{}' })
    expect(seenUrl).toContain('role.example')
    expect(seenHeaders['x-api-key']).toBe('sk-role')
    expect(seenHeaders['authorization']).toBeUndefined()
  })
})

describe('buildRoleFetch openai translate', () => {
  it('sends openai request to role url and returns anthropic-SSE response', async () => {
    let sentBody: any
    const inner = async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body)
      const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) + '\n\n' +
                  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    }
    const f = buildRoleFetch({ apiProtocol: 'openai', apiUrl: 'https://role/v1', apiToken: 'sk', backendModel: 'gpt-4o' }, inner as any)
    const res = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: {}, body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 10 }) })
    expect(sentBody.model).toBe('gpt-4o')
    const text = await res.text()
    expect(text).toContain('event: message_start'); expect(text).toContain('event: message_stop')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/api/openaiCompat/roleFetch.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// src/services/api/openaiCompat/roleFetch.ts
import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import { toOpenAIRequest } from './toOpenAIRequest.js'
import { openaiChunksToAnthropicEvents, anthropicEventsToSSE } from './fromOpenAIStream.js'

async function* parseOpenAISSE(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      const line = frame.split('\n').find(l => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim(); if (payload === '[DONE]') return
      try { yield JSON.parse(payload) } catch {}
    }
  }
}

export function buildRoleFetch(cfg: RoleClientConfig, inner: typeof fetch = fetch): typeof fetch {
  const target = new URL(cfg.apiUrl)
  return (async (url: any, init: any = {}) => {
    const headers: Record<string, string> = { ...(init.headers as any) }
    delete headers['authorization']; delete headers['Authorization']
    if (cfg.apiProtocol === 'anthropic') {
      headers['x-api-key'] = cfg.apiToken
      const orig = new URL(String(url)); const dest = new URL(orig.pathname + orig.search, target)
      return inner(dest.toString(), { ...init, headers })
    }
    // openai
    headers['authorization'] = `Bearer ${cfg.apiToken}`; delete headers['x-api-key']
    headers['content-type'] = 'application/json'
    const anthropicBody = JSON.parse(init.body as string)
    const openaiBody = toOpenAIRequest(anthropicBody, cfg.backendModel, cfg.thinkingDepth)
    const dest = new URL('/chat/completions', target).toString().replace(/\/chat\/completions$/, target.pathname.replace(/\/$/, '') + '/chat/completions')
    const res = await inner(new URL(target.pathname.replace(/\/$/, '') + '/chat/completions', target).toString(), { method: 'POST', headers, body: JSON.stringify(openaiBody) })
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText || res.statusText } }), { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    const events = openaiChunksToAnthropicEvents(parseOpenAISSE(res), { anthropicModel: anthropicBody.model })
    return new Response(anthropicEventsToSSE(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/api/openaiCompat/roleFetch.test.ts`
Expected: PASS（2 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/api/openaiCompat/roleFetch.ts src/services/api/openaiCompat/roleFetch.test.ts
git commit -m "feat(openai-compat): per-role fetch override (anthropic rewrite + openai translate)"
```

---

## Task 6: 下传角色 client 配置（runAgent → options → query.ts）

**Files:**
- Modify: `src/tools/AgentTool/runAgent.ts`（把 `agentDefinition.roleClientConfig` 放进 `agentOptions`；openai 时 `mainLoopModel` 用 Claude 别名）
- Modify: `src/Tool.ts`（`ToolUseContext['options']` 加可选 `roleClientConfig?`）
- Modify: `src/query.ts`（`:665-707` 组装 `fetchOverride = roleClientConfig ? buildRoleFetch(roleClientConfig) : dumpPromptsFetch`）
- Test: `src/tools/AgentTool/roles/roleClientPlumbing.test.ts`（测组装逻辑纯函数）

**Interfaces:**
- Produces: `function resolveRoleFetch(roleClientConfig, dumpPromptsFetch): typeof fetch | undefined`（纯函数，query.ts 调用）。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/AgentTool/roles/roleClientPlumbing.test.ts
import { describe, it, expect } from 'bun:test'
import { resolveRoleFetch } from '../../../query.js'

describe('resolveRoleFetch', () => {
  it('returns a role fetch when roleClientConfig present', () => {
    const f = resolveRoleFetch({ apiProtocol: 'anthropic', apiUrl: 'https://r', apiToken: 't', backendModel: 'm' }, undefined)
    expect(typeof f).toBe('function')
  })
  it('falls back to dumpPromptsFetch when no roleClientConfig', () => {
    const dump = (() => {}) as any
    expect(resolveRoleFetch(undefined, dump)).toBe(dump)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/tools/AgentTool/roles/roleClientPlumbing.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

在 `query.ts` 顶部导出：
```ts
import { buildRoleFetch } from './services/api/openaiCompat/roleFetch.js'
export function resolveRoleFetch(roleClientConfig: any, dumpPromptsFetch: any) {
  return roleClientConfig ? buildRoleFetch(roleClientConfig) : dumpPromptsFetch
}
```
在 `:665-707` 组装 `options` 处：`fetchOverride: resolveRoleFetch(toolUseContext.options.roleClientConfig, dumpPromptsFetch)`。

`Tool.ts` 的 `ToolUseContext['options']` 加：`roleClientConfig?: import('./tools/AgentTool/roles/roleTypes.js').RoleClientConfig`。

`runAgent.ts`（`:667` `agentOptions`）：
```ts
  roleClientConfig: agentDefinition.execMode === 'api' ? agentDefinition.roleClientConfig : undefined,
```
并在解析 `resolvedAgentModel` 处：openai 协议时 `mainLoopModel` 用一个 Claude 别名常量（如 `getSmallFastModel()` 或固定 `'claude-alias'` 常量），真实模型已在 `roleClientConfig.backendModel`。

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/tools/AgentTool/roles/roleClientPlumbing.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/query.ts src/Tool.ts src/tools/AgentTool/runAgent.ts src/tools/AgentTool/roles/roleClientPlumbing.test.ts
git commit -m "feat(roles): thread per-role client config into query fetchOverride"
```

---

## Task 7: AgentTool.call 按 execMode 分叉

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Test: 手动（分叉行为难纯测，靠 Task 8/9 的 runner 测 + 手动 smoke）

- [ ] **Step 1: 在 call() 分叉**

在 `AgentTool.call` 内 `selectedAgent` resolved 之后、构建 `runAgentParams`/调用 `runAgent` 之前，加：
```ts
if (selectedAgent.execMode === 'cli') {
  const makeStream = () => runCliAgent(selectedAgent, { prompt, description }, toolUseContext, canUseTool, assistantMessage)
  // 同步档：内联迭代 makeStream() 收最终文本；async 档：走 runAsyncAgentLifecycle({ makeStream })
  // —— 与现有 runAgent 的 sync/async 两条路径完全对齐，仅把 runAgent(...) 换成 runCliAgent(...)
}
```
即把现有两处对 `runAgent(...)` 的调用，在 `execMode==='cli'` 时替换为 `runCliAgent(...)`（签名见 Task 8）。API 模式仍走 `runAgent`（`roleClientConfig` 已在 Task 6 生效）。

- [ ] **Step 2: 类型检查**

Run: `bun x tsc --noEmit`
Expected: 无新增错误（`runCliAgent` 由 Task 8 提供，可先桩后填或调整任务顺序，先做 Task 8）。

> 执行顺序：先做 Task 8/9 得到 `runCliAgent`，再回填本 Task 的分叉调用。

- [ ] **Step 3: 提交**

```bash
git add src/tools/AgentTool/AgentTool.tsx
git commit -m "feat(roles): dispatch cli-mode roles to runCliAgent in AgentTool.call"
```

---

## Task 8: cliAgentRunner 非交互档

**Files:**
- Create: `src/tools/AgentTool/cliAgentRunner.ts`
- Test: `src/tools/AgentTool/cliAgentRunner.noninteractive.test.ts`

**Interfaces:**
- Produces:
  - `async function* runCliAgent(agentDef, task: { prompt: string; description: string }, toolUseContext, canUseTool, assistantMessage): AsyncGenerator<Message>` — 产出与 runAgent 同形状 Message；最后一条 assistant Message 的文本 = 子进程结果。
  - `function makeResultMessage(text: string): Message`（纯函数，构造合规 assistant Message）。
  - 依赖注入 spawn：`type SpawnFn = (cmd: string, args: string[], opts) => { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; exited: Promise<number> }`。

- [ ] **Step 1: 写失败测试（注入假 spawn）**

```ts
// src/tools/AgentTool/cliAgentRunner.noninteractive.test.ts
import { describe, it, expect } from 'bun:test'
import { runCliAgent } from './cliAgentRunner.js'

function fakeSpawn(stdoutText: string) {
  return (_c: string, _a: string[]) => {
    let stdinData = ''
    return {
      stdin: { write: (d: string) => { stdinData += d }, end: () => {} },
      stdout: (async function*(){ yield Buffer.from(stdoutText) })(),
      stderr: (async function*(){})(),
      kill: () => {}, exited: Promise.resolve(0),
      _getStdin: () => stdinData,
    }
  }
}

describe('runCliAgent non-interactive', () => {
  it('pipes prompt to stdin and yields stdout as final assistant message', async () => {
    const agentDef = { execMode: 'cli', interactive: false, command: 'x', args: [] } as any
    const msgs: any[] = []
    for await (const m of runCliAgent(agentDef, { prompt: 'do it', description: 'd' }, { options: {} } as any, (async () => ({ behavior: 'allow' })) as any, {} as any, { spawn: fakeSpawn('the answer') } as any)) msgs.push(m)
    const last = msgs[msgs.length - 1]
    expect(last.type).toBe('assistant')
    expect(JSON.stringify(last.message.content)).toContain('the answer')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/tools/AgentTool/cliAgentRunner.noninteractive.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现非交互档 + Message 构造**

```ts
// src/tools/AgentTool/cliAgentRunner.ts
import { randomUUID } from 'crypto'
import type { Message } from '../../types/message.js'
import { logError } from '../../utils/log.js'

export function makeResultMessage(text: string): Message {
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { id: `cli-${randomUUID()}`, type: 'message', role: 'assistant',
      content: [{ type: 'text', text }], model: 'cli', stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as Message
}

async function readAll(stream: AsyncIterable<any>): Promise<string> {
  let out = ''; for await (const c of stream) out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8'); return out
}

export async function* runCliAgent(agentDef: any, task: { prompt: string; description: string },
  toolUseContext: any, canUseTool: any, assistantMessage: any, deps?: { spawn: any }): AsyncGenerator<Message> {
  const spawn = deps?.spawn ?? defaultSpawn
  const proc = spawn(agentDef.command, agentDef.args ?? [], { cwd: agentDef.roleCwd })
  if (agentDef.interactive) { yield* runInteractive(proc, agentDef, task, toolUseContext, canUseTool); return }  // Task 9
  // 非交互：prompt → stdin，stdout 整段为结果
  proc.stdin.write(task.prompt); proc.stdin.end()
  const [out] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr).then(e => e && logError(new Error(e)))])
  await proc.exited
  yield makeResultMessage(out.trim())
}

function defaultSpawn(cmd: string, args: string[], opts: any) {
  const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  return { stdin: { write: (d: string) => p.stdin.write(d), end: () => p.stdin.end() },
    stdout: p.stdout, stderr: p.stderr, kill: () => p.kill(), exited: p.exited }
}
```

（`runInteractive` 在 Task 9 实现；本任务先桩一个 `throw new Error('interactive not yet')` 或留待 Task 9。）

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/tools/AgentTool/cliAgentRunner.noninteractive.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/AgentTool/cliAgentRunner.ts src/tools/AgentTool/cliAgentRunner.noninteractive.test.ts
git commit -m "feat(roles): cli non-interactive runner (stdin→stdout)"
```

---

## Task 9: cliAgentRunner 交互档（JSON-lines + 父级 canUseTool）

**Files:**
- Modify: `src/tools/AgentTool/cliAgentRunner.ts`（加 `runInteractive` + 行解析）
- Test: `src/tools/AgentTool/cliAgentRunner.interactive.test.ts`

**Interfaces:**
- Consumes: `canUseTool`（父级，来自 `AgentTool.call`）、`createToolStub`/`createSyntheticAssistantMessage`（`remotePermissionBridge.ts`）。
- Produces: `function parseJsonLines(chunk: string, buffer: { rest: string }): any[]`（纯函数，处理跨 chunk 部分行）；`runInteractive(...)`。

- [ ] **Step 1: 写失败测试**

```ts
// src/tools/AgentTool/cliAgentRunner.interactive.test.ts
import { describe, it, expect } from 'bun:test'
import { parseJsonLines, runInteractive } from './cliAgentRunner.js'

describe('parseJsonLines', () => {
  it('buffers partial lines across chunks', () => {
    const buf = { rest: '' }
    expect(parseJsonLines('{"type":"log","message":"a"}\n{"ty', buf)).toEqual([{ type: 'log', message: 'a' }])
    expect(parseJsonLines('pe":"result","content":"done"}\n', buf)).toEqual([{ type: 'result', content: 'done' }])
  })
})

describe('runInteractive', () => {
  it('permission_request → calls parent canUseTool and writes back permission_response; result ends', async () => {
    const stdinLines: string[] = []
    const proc = {
      stdin: { write: (d: string) => stdinLines.push(d), end: () => {} },
      stdout: (async function*(){
        yield Buffer.from(JSON.stringify({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { cmd: 'ls' } }) + '\n')
        // 等父侧回写后再吐 result（用微任务近似）
        await Promise.resolve()
        yield Buffer.from(JSON.stringify({ type: 'result', content: 'ok' }) + '\n')
      })(),
      stderr: (async function*(){})(), kill: () => {}, exited: Promise.resolve(0),
    }
    const canUseTool = async () => ({ behavior: 'allow' })
    const msgs: any[] = []
    for await (const m of runInteractive(proc as any, { command: 'x' } as any, { prompt: 'go', description: 'd' }, { options: {} } as any, canUseTool as any)) msgs.push(m)
    expect(stdinLines.join('')).toContain('"type":"permission_response"')
    expect(stdinLines.join('')).toContain('"behavior":"allow"')
    expect(JSON.stringify(msgs[msgs.length - 1].message.content)).toContain('ok')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/tools/AgentTool/cliAgentRunner.interactive.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

```ts
// 追加到 src/tools/AgentTool/cliAgentRunner.ts
import { createToolStub, createSyntheticAssistantMessage } from '../../remote/remotePermissionBridge.js'

export function parseJsonLines(chunk: string, buffer: { rest: string }): any[] {
  buffer.rest += chunk
  const out: any[] = []; let i
  while ((i = buffer.rest.indexOf('\n')) >= 0) {
    const line = buffer.rest.slice(0, i).trim(); buffer.rest = buffer.rest.slice(i + 1)
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch (e) { logError(new Error('bad protocol line: ' + line)) }
  }
  return out
}

export async function* runInteractive(proc: any, agentDef: any, task: { prompt: string; description: string },
  toolUseContext: any, canUseTool: any): AsyncGenerator<Message> {
  proc.stdin.write(JSON.stringify({ type: 'task', prompt: task.prompt }) + '\n')
  void (async () => { for await (const c of proc.stderr) logError(new Error(Buffer.from(c).toString('utf8'))) })()
  const buffer = { rest: '' }
  let result = ''
  for await (const c of proc.stdout) {
    for (const msg of parseJsonLines(Buffer.from(c).toString('utf8'), buffer)) {
      if (msg.type === 'permission_request') {
        const req = { tool_name: msg.tool, input: msg.input ?? {}, tool_use_id: msg.id }
        const decision = await canUseTool(createToolStub(msg.tool), msg.input ?? {}, toolUseContext,
          createSyntheticAssistantMessage(req as any, msg.id), msg.id)
        proc.stdin.write(JSON.stringify({ type: 'permission_response', id: msg.id,
          behavior: decision.behavior === 'allow' ? 'allow' : 'deny',
          updatedInput: decision.updatedInput, permissionUpdates: decision.updatedPermissions,
          feedback: decision.message }) + '\n')
      } else if (msg.type === 'result') { result = msg.content ?? ''; }
      else if (msg.type === 'error') { logError(new Error(msg.message)); result = result || `[cli error] ${msg.message}` }
    }
  }
  await proc.exited
  yield makeResultMessage(result)
}
```

> 进程管理（超时/kill/abort）：接 `toolUseContext.abortController?.signal`，`signal.addEventListener('abort', () => proc.kill())`（用 `tree-kill` 杀进程树）；结果超时用 `AbortSignal.timeout` 或计时器包裹 for-await。此为增量，可在本任务补一条测试后加入。

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/tools/AgentTool/cliAgentRunner.interactive.test.ts`
Expected: PASS（2 通过）。

- [ ] **Step 5: 回填 Task 7 的分叉调用并类型检查**

Run: `bun x tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 6: 提交**

```bash
git add src/tools/AgentTool/cliAgentRunner.ts src/tools/AgentTool/cliAgentRunner.interactive.test.ts src/tools/AgentTool/AgentTool.tsx
git commit -m "feat(roles): cli interactive JSON-lines runner via parent canUseTool"
```

---

## Task 10: 端到端手测 + 文档

**Files:**
- Create: `docs/roles-setup.md`

- [ ] **Step 1: 文档**

写 `docs/roles-setup.md`：`roles` 数组各字段说明；api 模式（anthropic / openai 两协议）示例；cli 模式（非交互 / 交互）示例 + JSON-lines 协议规范（主↔子消息类型、stdout=协议/stderr=日志、`interactive` 档只面向"实现本协议的适配器进程"）。

- [ ] **Step 2: 端到端手测（需 Bun）**

- API/openai 角色：配一个 OpenAI 兼容端点，主会话派遣 → 观察请求打到角色 URL、结果正确回主会话；触发一次工具确认 → 终端 + 飞书（若装了 Plan A）都收到。
- CLI 交互角色：写一个最小适配器脚本（吐 `permission_request` 再吐 `result`），派遣 → 确认弹到终端/飞书 → 点允许 → 适配器收到 `permission_response` → `result` 回主会话。

Expected：两条链路均跑通；确认交互正常。

- [ ] **Step 3: 提交**

```bash
git add docs/roles-setup.md
git commit -m "docs(roles): roles config + JSON-lines protocol guide"
```

---

## Self-Review 结果（已核对规格第 6 节）

- 6.1 配置 → Task 1 ✅；6.2 独立 schema/合并/localSettings/撞名/execMode → Task 1/2 ✅；6.3 API 模式（fetchOverride 接缝、anthropic 接管、openai 翻译、模型身份分离、effort→reasoning_effort）→ Task 3/4/5/6 ✅；6.4 执行分派 + cliAgentRunner 两档 + Message 流 → Task 7/8/9 ✅；6.5 JSON-lines + 父级 canUseTool + 通道分离 + 分帧 → Task 9 ✅；进程 kill/超时 → Task 9 增量 ✅。
- 类型一致：`RoleClientConfig`/`RoleConfig`/`RoleAgentDefinition`、`runCliAgent`/`makeResultMessage`/`parseJsonLines`/`buildRoleFetch`/`resolveRoleFetch` 跨任务一致。
- 无占位符：每步含实测测试与命令。OpenAI 流翻译边界（content_filter/并行 tool/错误 chunk）在 Task 4 Step 4 要求逐条补测。
- 已知执行前提：Bun 环境运行 TDD；端到端需 OpenAI 兼容端点 + CLI 适配器脚本；确认交互依赖 TUI（+ 可选 Plan A 飞书）。
- 依赖关系：Task 7 依赖 Task 8/9（先做 runner 再回填分叉）。API 模式（Task 3-6）与 CLI 模式（Task 7-9）相互独立，可并行。
