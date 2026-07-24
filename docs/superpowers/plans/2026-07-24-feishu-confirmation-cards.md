# 飞书确认卡片 Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有走 `ToolUseConfirm` 的用户确认，除终端弹窗外并行推送一张飞书交互式卡片，用户在卡片上确认；飞书与终端竞速，谁先响应谁生效，另一面状态同步为终结态。

**Architecture:** 复刻现有 Channel 确认面模式，在 `interactiveHandler.ts` 新增一个**不带 `feature()` 门控**的飞书竞速面（fire-and-forget 发卡 + 先注册回调）。飞书回调经 `@larksuiteoapi/node-sdk` 的 **WSClient 长连接**（`card.action.trigger`）到达，调用 `createFeishuPermissionCallbacks().resolve(...)` 解决权限 Promise。双向一致性用"每胜出点手工同步"（新增飞书面 unsubscribe + 卡片 patch）。

**Tech Stack:** TypeScript / Bun / React+Ink / `@larksuiteoapi/node-sdk`（新增）/ zod（已有）/ `bun test`（本仓库首次引入测试）。

## Global Constraints

- 运行时：Bun（`bin/claude-haha` → `bun ./src/entrypoints/cli.tsx`）。测试命令一律 `bun test <file>`。
- **飞书面不得带 `feature()` 门控**（`feature('KAIROS')`/`BRIDGE_MODE` 在本 fork 运行时为 false，Channel/Bridge 面是死的）。
- **仅 TUI 模式**：不改无头 `--print` 权限路径。
- 明文配置：`appSecret` 直接写 settings.json，不做脱敏、不做 `env:` 间接。
- 密钥/失败一律 `logError` best-effort，不得使终端确认或主流程崩溃。
- `requestId` 一律用 `toolUseID`。飞书回调解决用闭包 `pending` Map，删除即幂等。
- 依赖版本 pin：`bun add @larksuiteoapi/node-sdk@<锁定版本>`，提交更新后的 lockfile。
- 源码锚点以规格 `docs/superpowers/specs/2026-07-24-feishu-and-multi-role-agents-design.md` 第 4 节为准。

---

## File Structure

- Create `src/services/feishu/types.ts` — `FeishuConfig`、`FeishuPermissionResponse`、卡片/回调共享类型。
- Create `src/services/feishu/config.ts` — 从 settings 读取并校验 `feishu` 块，`getFeishuConfig()`。
- Create `src/services/feishu/feishuPermissions.ts` — `FeishuPermissionCallbacks` + `createFeishuPermissionCallbacks()`。
- Create `src/services/feishu/cards.ts` — `buildPermissionCard`、`buildResolvedCard`、AskUserQuestion 表单构造 + `formValueToAnswers`。
- Create `src/services/feishu/FeishuClient.ts` — SDK 封装（`Client`+`WSClient`），依赖注入以便测试。
- Create `src/hooks/useFeishuBridge.tsx` — 构造 client+callbacks、接线 `card.action.trigger`、写入 AppState。
- Modify `src/utils/settings/types.ts` — `SettingsSchema` 增加 `feishu` 可选块。
- Modify `src/state/AppStateStore.ts` — 增加 `feishuPermissionCallbacks?`、`feishuClient?` 槽位。
- Modify `src/hooks/toolPermission/handlers/interactiveHandler.ts` — 飞书竞速面 + 每胜出点同步。
- Modify `src/hooks/useCanUseTool.tsx` — 注入 `feishuCallbacks`/`feishuClient`（无门控）。
- Modify `src/screens/REPL.tsx` — 挂载 `useFeishuBridge`。
- Create `docs/feishu-setup.md` — 飞书应用配置说明。
- Tests colocated: `src/services/feishu/*.test.ts`。

---

## Task 0: 依赖与 Bun 连通性 spike（非 TDD，先行）

**Files:**
- Modify: `package.json`（+ `@larksuiteoapi/node-sdk`）
- Create: `scratch/feishu-spike.ts`（验证后删除，不提交）

**Interfaces:**
- Produces: 确认 SDK 在 Bun 下可 `WSClient.connect()` 并收到 `card.action.trigger`；确认发卡/更新卡 API 的确切签名，供后续任务采用。

- [ ] **Step 1: 安装依赖**

Run: `bun add @larksuiteoapi/node-sdk` （记录被 pin 的版本）
Expected: `package.json` 出现该依赖，lockfile 更新。

- [ ] **Step 2: 写 spike 脚本**

```ts
// scratch/feishu-spike.ts
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
const appId = process.env.FEISHU_APP_ID!, appSecret = process.env.FEISHU_APP_SECRET!
const client = new Client({ appId, appSecret })
const wsClient = new WSClient({ appId, appSecret })
const dispatcher = new EventDispatcher({}).register({
  'card.action.trigger': async (data) => {
    console.log('CARD ACTION:', JSON.stringify(data.action))
    return { toast: { type: 'success', content: 'received' } }
  },
})
await wsClient.start({ eventDispatcher: dispatcher })
// 发一张带按钮的测试卡片
const card = { config: {}, elements: [{ tag: 'button', text: { tag: 'plain_text', content: '允许一次' },
  behaviors: [{ type: 'callback', value: { requestId: 'spike', behavior: 'allow' } }] }] }
const res = await client.im.message.create({
  params: { receive_id_type: process.env.FEISHU_RECEIVE_ID_TYPE as any },
  data: { receive_id: process.env.FEISHU_RECEIVE_ID!, msg_type: 'interactive', content: JSON.stringify(card) },
})
console.log('SEND RESULT messageId =', res.data?.message_id)
```

- [ ] **Step 3: 运行并观察**

Run: `FEISHU_APP_ID=… FEISHU_APP_SECRET=… FEISHU_RECEIVE_ID=… FEISHU_RECEIVE_ID_TYPE=open_id bun scratch/feishu-spike.ts`
Expected: 手机飞书收到卡片；点击按钮后终端打印 `CARD ACTION: {...requestId:"spike",behavior:"allow"...}`；`SEND RESULT messageId = om_xxx`。

- [ ] **Step 4: 记录确切 API 形状**

在本文件 Task 4 的注释里落实：`client.im.message.create` 的 `params.receive_id_type` / `data` 结构、`res.data.message_id` 路径、`client.im.message.patch` 更新卡片的签名、`card.action.trigger` 回调里 `data.action.value` 与（表单）`data.action.form_value` 的确切路径。若与本计划假设不符，据实更新后续任务代码。

- [ ] **Step 5: 清理**

删除 `scratch/feishu-spike.ts`（不提交）。提交依赖变更：

```bash
git add package.json bun.lock
git commit -m "chore: add @larksuiteoapi/node-sdk (feishu confirmation cards)"
```

---

## Task 1: 配置 schema 与读取

**Files:**
- Modify: `src/utils/settings/types.ts`（`SettingsSchema` 内 `.passthrough()` 之前加 `feishu` 字段）
- Create: `src/services/feishu/types.ts`
- Create: `src/services/feishu/config.ts`
- Test: `src/services/feishu/config.test.ts`

**Interfaces:**
- Produces:
  - `type FeishuConfig = { enabled: boolean; appId: string; appSecret: string; receiveIdType: 'open_id'|'chat_id'|'user_id'|'union_id'|'email'; receiveId: string; cardLanguage: string }`
  - `function getFeishuConfig(settings: SettingsJson): FeishuConfig | null` — 未启用或字段不全返回 `null`。
  - `FeishuConfigSchema`（zod）。

- [ ] **Step 1: 写失败测试**

```ts
// src/services/feishu/config.test.ts
import { describe, it, expect } from 'bun:test'
import { getFeishuConfig } from './config.js'

describe('getFeishuConfig', () => {
  it('returns null when feishu block absent', () => {
    expect(getFeishuConfig({} as any)).toBeNull()
  })
  it('returns null when enabled but missing receiveId', () => {
    expect(getFeishuConfig({ feishu: { enabled: true, appId: 'a', appSecret: 's' } } as any)).toBeNull()
  })
  it('parses a complete config with defaults', () => {
    const c = getFeishuConfig({ feishu: { enabled: true, appId: 'a', appSecret: 's', receiveId: 'ou_1' } } as any)
    expect(c).toEqual({ enabled: true, appId: 'a', appSecret: 's', receiveIdType: 'open_id', receiveId: 'ou_1', cardLanguage: 'zh' })
  })
  it('returns null when enabled is false', () => {
    expect(getFeishuConfig({ feishu: { enabled: false, appId: 'a', appSecret: 's', receiveId: 'ou_1' } } as any)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/feishu/config.test.ts`
Expected: FAIL（`Cannot find module './config.js'`）。

- [ ] **Step 3: 写类型与实现**

```ts
// src/services/feishu/types.ts
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
export type FeishuReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'
export type FeishuConfig = {
  enabled: boolean; appId: string; appSecret: string
  receiveIdType: FeishuReceiveIdType; receiveId: string; cardLanguage: string
}
export type FeishuPermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
  feedback?: string
}
```

```ts
// src/services/feishu/config.ts
import { z } from 'zod'
import type { FeishuConfig } from './types.js'

export const FeishuConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  receiveIdType: z.enum(['open_id','chat_id','user_id','union_id','email']).default('open_id'),
  receiveId: z.string().min(1),
  cardLanguage: z.string().default('zh'),
})

export function getFeishuConfig(settings: { feishu?: unknown }): FeishuConfig | null {
  const raw = settings?.feishu
  if (!raw || typeof raw !== 'object') return null
  const parsed = FeishuConfigSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.enabled) return null
  return parsed.data
}
```

在 `src/utils/settings/types.ts` 的 `SettingsSchema`（`z.object({...})`）里、`.passthrough()` 之前加一行：
```ts
  feishu: z.object({
    enabled: z.boolean().optional(), appId: z.string().optional(), appSecret: z.string().optional(),
    receiveIdType: z.enum(['open_id','chat_id','user_id','union_id','email']).optional(),
    receiveId: z.string().optional(), cardLanguage: z.string().optional(),
  }).optional(),
```
（顶层宽松，严格校验在 `getFeishuConfig` 做，避免坏配置阻断启动。）

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/feishu/config.test.ts`
Expected: PASS（4 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/feishu/types.ts src/services/feishu/config.ts src/services/feishu/config.test.ts src/utils/settings/types.ts
git commit -m "feat(feishu): config schema and getFeishuConfig"
```

---

## Task 2: FeishuPermissionCallbacks（竞速解决器）

**Files:**
- Create: `src/services/feishu/feishuPermissions.ts`
- Test: `src/services/feishu/feishuPermissions.test.ts`

**Interfaces:**
- Consumes: `FeishuPermissionResponse`（Task 1）。
- Produces:
  - `type FeishuPermissionCallbacks = { onResponse(requestId: string, handler: (r: FeishuPermissionResponse) => void): () => void; resolve(requestId: string, r: FeishuPermissionResponse): boolean }`
  - `function createFeishuPermissionCallbacks(): FeishuPermissionCallbacks`

- [ ] **Step 1: 写失败测试**

```ts
// src/services/feishu/feishuPermissions.test.ts
import { describe, it, expect } from 'bun:test'
import { createFeishuPermissionCallbacks } from './feishuPermissions.js'

describe('createFeishuPermissionCallbacks', () => {
  it('routes resolve to the registered handler once', () => {
    const cb = createFeishuPermissionCallbacks()
    let got: any = null
    cb.onResponse('id1', r => { got = r })
    expect(cb.resolve('id1', { behavior: 'allow' })).toBe(true)
    expect(got).toEqual({ behavior: 'allow' })
  })
  it('is idempotent: second resolve for same id returns false', () => {
    const cb = createFeishuPermissionCallbacks()
    let calls = 0
    cb.onResponse('id1', () => { calls++ })
    cb.resolve('id1', { behavior: 'allow' })
    expect(cb.resolve('id1', { behavior: 'deny' })).toBe(false)
    expect(calls).toBe(1)
  })
  it('resolve for unknown id returns false', () => {
    const cb = createFeishuPermissionCallbacks()
    expect(cb.resolve('nope', { behavior: 'allow' })).toBe(false)
  })
  it('unsubscribe removes the handler', () => {
    const cb = createFeishuPermissionCallbacks()
    const unsub = cb.onResponse('id1', () => {})
    unsub()
    expect(cb.resolve('id1', { behavior: 'allow' })).toBe(false)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/feishu/feishuPermissions.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现（镜像 channelPermissions.ts:209）**

```ts
// src/services/feishu/feishuPermissions.ts
import type { FeishuPermissionResponse } from './types.js'
export type FeishuPermissionCallbacks = {
  onResponse(requestId: string, handler: (r: FeishuPermissionResponse) => void): () => void
  resolve(requestId: string, r: FeishuPermissionResponse): boolean
}
export function createFeishuPermissionCallbacks(): FeishuPermissionCallbacks {
  const pending = new Map<string, (r: FeishuPermissionResponse) => void>()
  return {
    onResponse(requestId, handler) {
      pending.set(requestId, handler)
      return () => { pending.delete(requestId) }
    },
    resolve(requestId, r) {
      const h = pending.get(requestId)
      if (!h) return false
      pending.delete(requestId) // 删除在前，幂等
      h(r)
      return true
    },
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/feishu/feishuPermissions.test.ts`
Expected: PASS（4 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/feishu/feishuPermissions.ts src/services/feishu/feishuPermissions.test.ts
git commit -m "feat(feishu): permission callbacks (idempotent resolve race)"
```

---

## Task 3: 卡片构造与表单结果映射

**Files:**
- Create: `src/services/feishu/cards.ts`
- Test: `src/services/feishu/cards.test.ts`

**Interfaces:**
- Consumes: `FeishuPermissionResponse`。
- Produces:
  - `type PermissionCardData = { requestId: string; toolName: string; summary: string; kind: 'buttons' | 'plan' | 'question'; questions?: QuestionSpec[]; suggestion?: unknown }`
  - `function buildPermissionCard(data: PermissionCardData): object`（返回飞书卡片 JSON 对象）
  - `function buildResolvedCard(data: PermissionCardData, winner: string, behavior: 'allow'|'deny'|'cancelled'): object`
  - `function formValueToAnswers(questions: QuestionSpec[], formValue: Record<string, unknown>): { answers: Answer[] }`
  - `type QuestionSpec = { header: string; question: string; multiSelect: boolean; options: { label: string }[] }`
  - `type Answer = { header: string; question: string; answers: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
// src/services/feishu/cards.test.ts
import { describe, it, expect } from 'bun:test'
import { buildPermissionCard, buildResolvedCard, formValueToAnswers } from './cards.js'

describe('buildPermissionCard', () => {
  it('normal tool → three button actions carrying requestId+behavior', () => {
    const card: any = buildPermissionCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls -la', kind: 'buttons' })
    const flat = JSON.stringify(card)
    expect(flat).toContain('允许一次'); expect(flat).toContain('总是允许'); expect(flat).toContain('拒绝')
    expect(flat).toContain('"requestId":"r1"'); expect(flat).toContain('"behavior":"allow"'); expect(flat).toContain('"behavior":"deny"')
  })
  it('plan kind → approve/keep-refining buttons', () => {
    const flat = JSON.stringify(buildPermissionCard({ requestId: 'r1', toolName: 'ExitPlanMode', summary: 'plan', kind: 'plan' }))
    expect(flat).toContain('批准计划'); expect(flat).toContain('继续完善')
  })
  it('question kind → form with select per question, not bare buttons', () => {
    const card: any = buildPermissionCard({ requestId: 'r1', toolName: 'AskUserQuestion', summary: '', kind: 'question',
      questions: [{ header: 'DB', question: 'which?', multiSelect: false, options: [{ label: 'pg' }, { label: 'mysql' }] }] })
    const flat = JSON.stringify(card)
    expect(flat).toContain('form'); expect(flat).toContain('pg'); expect(flat).toContain('mysql')
  })
})

describe('buildResolvedCard', () => {
  it('renders terminal state and disables interaction', () => {
    const flat = JSON.stringify(buildResolvedCard({ requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' }, 'terminal', 'allow'))
    expect(flat).toContain('已允许'); expect(flat).toContain('终端')
    expect(flat).not.toContain('"behavior":"allow"') // 无可点回传按钮
  })
})

describe('formValueToAnswers', () => {
  const qs = [
    { header: 'DB', question: 'which db?', multiSelect: false, options: [{ label: 'pg' }, { label: 'mysql' }] },
    { header: 'Feat', question: 'features?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
  ]
  it('maps single-select to a one-element answer and multi-select to array', () => {
    const out = formValueToAnswers(qs, { q0: 'pg', q1: ['a', 'b'] })
    expect(out).toEqual({ answers: [
      { header: 'DB', question: 'which db?', answers: ['pg'] },
      { header: 'Feat', question: 'features?', answers: ['a', 'b'] },
    ]})
  })
  it('uses Other free-text when provided', () => {
    const out = formValueToAnswers(qs, { q0: '__other__', q0_other: 'sqlite', q1: [] })
    expect(out.answers[0].answers).toEqual(['sqlite'])
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/feishu/cards.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/services/feishu/cards.ts
export type QuestionSpec = { header: string; question: string; multiSelect: boolean; options: { label: string }[] }
export type Answer = { header: string; question: string; answers: string[] }
export type PermissionCardData = {
  requestId: string; toolName: string; summary: string
  kind: 'buttons' | 'plan' | 'question'; questions?: QuestionSpec[]; suggestion?: unknown
}
const txt = (content: string) => ({ tag: 'plain_text', content })
function button(content: string, value: Record<string, unknown>) {
  return { tag: 'button', text: txt(content), behaviors: [{ type: 'callback', value }] }
}
export function buildPermissionCard(d: PermissionCardData): object {
  const header = { title: txt(`确认：${d.toolName}`) }
  const body: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: '```\n' + d.summary + '\n```' } }]
  if (d.kind === 'plan') {
    body.push({ tag: 'action', actions: [
      button('批准计划', { requestId: d.requestId, behavior: 'allow' }),
      button('继续完善', { requestId: d.requestId, behavior: 'deny' }),
    ]})
  } else if (d.kind === 'question' && d.questions) {
    const elements = d.questions.flatMap((q, i) => {
      const opts = q.options.map(o => ({ text: txt(o.label), value: o.label }))
      opts.push({ text: txt('其它(填写)'), value: '__other__' })
      const selector = q.multiSelect
        ? { tag: 'multi_select_static', name: `q${i}`, placeholder: txt(q.question), options: opts }
        : { tag: 'select_static', name: `q${i}`, placeholder: txt(q.question), options: opts }
      return [{ tag: 'div', text: txt(q.question) }, selector,
        { tag: 'input', name: `q${i}_other`, placeholder: txt('如选其它，请在此填写') }]
    })
    body.push({ tag: 'form', name: 'form', elements: [
      ...elements,
      { tag: 'button', text: txt('提交'), action_type: 'form_submit',
        behaviors: [{ type: 'callback', value: { requestId: d.requestId, behavior: 'allow', form: true } }] },
    ]})
  } else {
    body.push({ tag: 'action', actions: [
      button('允许一次', { requestId: d.requestId, behavior: 'allow' }),
      button('总是允许', { requestId: d.requestId, behavior: 'allow', always: true, suggestion: d.suggestion ?? null }),
      button('拒绝', { requestId: d.requestId, behavior: 'deny' }),
    ]})
  }
  return { config: { wide_screen_mode: true }, header, elements: body }
}
export function buildResolvedCard(d: PermissionCardData, winner: string, behavior: 'allow'|'deny'|'cancelled'): object {
  const label = behavior === 'allow' ? '✅ 已允许' : behavior === 'deny' ? '❌ 已拒绝' : '⏹ 已取消'
  const via = winner === 'terminal' ? '终端' : winner === 'feishu' ? '飞书' : winner
  return { config: { wide_screen_mode: true }, header: { title: txt(`确认：${d.toolName}`) },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: '```\n' + d.summary + '\n```' } },
      { tag: 'div', text: txt(`${label}（${via}）`) }] }
}
export function formValueToAnswers(questions: QuestionSpec[], formValue: Record<string, unknown>): { answers: Answer[] } {
  const answers = questions.map((q, i) => {
    const raw = formValue[`q${i}`]
    let picked = Array.isArray(raw) ? raw.slice() : raw != null ? [raw as string] : []
    if (picked.includes('__other__')) {
      const other = formValue[`q${i}_other`]
      picked = picked.filter(v => v !== '__other__')
      if (typeof other === 'string' && other.trim()) picked.push(other.trim())
    }
    return { header: q.header, question: q.question, answers: picked }
  })
  return { answers }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/feishu/cards.test.ts`
Expected: PASS。

> 注：飞书 form / select_static / multi_select_static / input 的确切 tag 名与 `form_value` 字段名，以 Task 0 spike 实测为准；若 SDK/卡片版本要求不同 tag（如 `column_set`/`select`），据实调整并保持测试的行为断言（有单选/多选/Other、提交回传 requestId）。

- [ ] **Step 5: 提交**

```bash
git add src/services/feishu/cards.ts src/services/feishu/cards.test.ts
git commit -m "feat(feishu): permission/resolved cards + form→answers mapping"
```

---

## Task 4: FeishuClient（SDK 封装，依赖注入）

**Files:**
- Create: `src/services/feishu/FeishuClient.ts`
- Test: `src/services/feishu/FeishuClient.test.ts`

**Interfaces:**
- Consumes: `FeishuConfig`（Task 1）。
- Produces:
  - `type CardActionEvent = { action: { value?: Record<string, unknown>; form_value?: Record<string, unknown> } }`
  - `type FeishuDeps = { makeClient(cfg): { sendCard(card): Promise<string>; updateCard(messageId, card): Promise<void> }; makeWs(cfg, onAction): { start(): Promise<void>; close(): Promise<void> } }`
  - `class FeishuClient { constructor(cfg: FeishuConfig, deps?: FeishuDeps); connect(): Promise<void>; close(): Promise<void>; sendCard(card): Promise<string /*messageId*/>; updateCard(messageId, card): Promise<void>; onCardAction(h: (e: CardActionEvent) => void): void }`

**理由：** 真实 SDK 无法在无网/无 Bun 的单测里跑；用 `FeishuDeps` 注入，默认实现用真 SDK，测试注入 mock。

- [ ] **Step 1: 写失败测试（注入 mock deps）**

```ts
// src/services/feishu/FeishuClient.test.ts
import { describe, it, expect } from 'bun:test'
import { FeishuClient } from './FeishuClient.js'

const cfg = { enabled: true, appId: 'a', appSecret: 's', receiveIdType: 'open_id' as const, receiveId: 'ou_1', cardLanguage: 'zh' }

function mockDeps() {
  const sent: any[] = []; let actionHandler: any
  const deps = {
    makeClient: () => ({
      sendCard: async (card: any) => { sent.push(card); return 'om_' + sent.length },
      updateCard: async () => {},
    }),
    makeWs: (_cfg: any, onAction: any) => { actionHandler = onAction; return { start: async () => {}, close: async () => {} } },
  }
  return { deps, sent, fire: (e: any) => actionHandler(e) }
}

describe('FeishuClient', () => {
  it('sendCard returns messageId and forwards card actions to onCardAction', async () => {
    const m = mockDeps()
    const c = new FeishuClient(cfg, m.deps)
    let received: any = null
    c.onCardAction(e => { received = e })
    await c.connect()
    const id = await c.sendCard({ any: 'card' })
    expect(id).toBe('om_1')
    m.fire({ action: { value: { requestId: 'r1', behavior: 'allow' } } })
    expect(received.action.value.requestId).toBe('r1')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/services/feishu/FeishuClient.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现（默认 deps 用真 SDK；具体调用以 Task 0 实测校正）**

```ts
// src/services/feishu/FeishuClient.ts
import { logError } from '../../utils/log.js'
import type { FeishuConfig } from './types.js'
export type CardActionEvent = { action: { value?: Record<string, unknown>; form_value?: Record<string, unknown> } }
type ClientImpl = { sendCard(card: object): Promise<string>; updateCard(messageId: string, card: object): Promise<void> }
type WsImpl = { start(): Promise<void>; close(): Promise<void> }
export type FeishuDeps = {
  makeClient(cfg: FeishuConfig): ClientImpl
  makeWs(cfg: FeishuConfig, onAction: (e: CardActionEvent) => void): WsImpl
}

function defaultDeps(): FeishuDeps {
  return {
    makeClient(cfg) {
      // 延迟 import，避免无头/未启用时加载 SDK
      const { Client } = require('@larksuiteoapi/node-sdk')
      const client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret })
      return {
        async sendCard(card) {
          const res = await client.im.message.create({
            params: { receive_id_type: cfg.receiveIdType },
            data: { receive_id: cfg.receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
          })
          return res.data?.message_id as string
        },
        async updateCard(messageId, card) {
          await client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } })
        },
      }
    },
    makeWs(cfg, onAction) {
      const { WSClient, EventDispatcher } = require('@larksuiteoapi/node-sdk')
      const ws = new WSClient({ appId: cfg.appId, appSecret: cfg.appSecret })
      const dispatcher = new EventDispatcher({}).register({
        'card.action.trigger': async (data: any) => {
          try { onAction({ action: data.action }) } catch (e) { logError(e) }  // ack 立即返回，业务异步
          return {}
        },
      })
      return { start: () => ws.start({ eventDispatcher: dispatcher }), close: async () => { /* ws.close?.() */ } }
    },
  }
}

export class FeishuClient {
  private client: ClientImpl; private ws: WsImpl; private handler: (e: CardActionEvent) => void = () => {}
  constructor(private cfg: FeishuConfig, deps: FeishuDeps = defaultDeps()) {
    this.client = deps.makeClient(cfg)
    this.ws = deps.makeWs(cfg, e => this.handler(e))
  }
  onCardAction(h: (e: CardActionEvent) => void) { this.handler = h }
  async connect() { await this.ws.start() }
  async close() { try { await this.ws.close() } catch (e) { logError(e) } }
  async sendCard(card: object): Promise<string> { return this.client.sendCard(card) }
  async updateCard(messageId: string, card: object): Promise<void> {
    try { await this.client.updateCard(messageId, card) } catch (e) { logError(e) }
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/services/feishu/FeishuClient.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/services/feishu/FeishuClient.ts src/services/feishu/FeishuClient.test.ts
git commit -m "feat(feishu): FeishuClient SDK wrapper with injectable deps"
```

---

## Task 5: AppState 槽位 + useFeishuBridge 接线

**Files:**
- Modify: `src/state/AppStateStore.ts`（在 channel 槽位附近加两个可选字段）
- Create: `src/hooks/useFeishuBridge.tsx`
- Test: `src/hooks/useFeishuBridge.test.ts`（测纯逻辑部分）

**Interfaces:**
- Consumes: `FeishuClient`、`createFeishuPermissionCallbacks`、`getFeishuConfig`、`cards`。
- Produces:
  - AppState 增加 `feishuPermissionCallbacks?: FeishuPermissionCallbacks`、`feishuClient?: FeishuClient`。
  - `function wireCardAction(callbacks, questionsById): (e: CardActionEvent) => void` — 纯函数，把卡片事件翻成 `resolve(requestId, FeishuPermissionResponse)`（便于单测）。
  - `function useFeishuBridge(): void`（hook，挂到 REPL）。

- [ ] **Step 1: 写失败测试（针对 wireCardAction 纯逻辑）**

```ts
// src/hooks/useFeishuBridge.test.ts
import { describe, it, expect } from 'bun:test'
import { wireCardAction } from './useFeishuBridge.js'
import { createFeishuPermissionCallbacks } from '../services/feishu/feishuPermissions.js'

describe('wireCardAction', () => {
  it('button click → allow with permissionUpdates from embedded suggestion when always', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    const handler = wireCardAction(cb, new Map())
    handler({ action: { value: { requestId: 'r1', behavior: 'allow', always: true, suggestion: { rule: 'x' } } } })
    expect(got.behavior).toBe('allow')
    expect(got.permissionUpdates).toEqual([{ rule: 'x' }])
  })
  it('form submit → allow with answers built from form_value', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    const qById = new Map([['r1', [{ header: 'DB', question: 'which?', multiSelect: false, options: [{ label: 'pg' }] }]]])
    const handler = wireCardAction(cb, qById)
    handler({ action: { value: { requestId: 'r1', behavior: 'allow', form: true }, form_value: { q0: 'pg' } } })
    expect(got.updatedInput).toEqual({ answers: [{ header: 'DB', question: 'which?', answers: ['pg'] }] })
  })
  it('deny → behavior deny', () => {
    const cb = createFeishuPermissionCallbacks(); let got: any = null
    cb.onResponse('r1', r => { got = r })
    wireCardAction(cb, new Map())({ action: { value: { requestId: 'r1', behavior: 'deny' } } })
    expect(got.behavior).toBe('deny')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/hooks/useFeishuBridge.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 wireCardAction + hook + AppState 槽位**

在 `src/state/AppStateStore.ts` 的 AppState 类型/初始化里（channel 槽位附近）加：
```ts
  feishuPermissionCallbacks?: import('../services/feishu/feishuPermissions.js').FeishuPermissionCallbacks
  feishuClient?: import('../services/feishu/FeishuClient.js').FeishuClient
```

```tsx
// src/hooks/useFeishuBridge.tsx
import { useEffect } from 'react'
import { getFeishuConfig } from '../services/feishu/config.js'
import { FeishuClient, type CardActionEvent } from '../services/feishu/FeishuClient.js'
import { createFeishuPermissionCallbacks, type FeishuPermissionCallbacks } from '../services/feishu/feishuPermissions.js'
import { formValueToAnswers, type QuestionSpec } from '../services/feishu/cards.js'
import { logError } from '../utils/log.js'
import { getGlobalConfig } from '../utils/config.js'

export function wireCardAction(
  callbacks: FeishuPermissionCallbacks,
  questionsById: Map<string, QuestionSpec[]>,
): (e: CardActionEvent) => void {
  return (e) => {
    const v = e.action.value ?? {}
    const requestId = v.requestId as string
    if (!requestId) return
    if (v.behavior === 'deny') { callbacks.resolve(requestId, { behavior: 'deny' }); return }
    if (v.form && e.action.form_value) {
      const qs = questionsById.get(requestId) ?? []
      callbacks.resolve(requestId, { behavior: 'allow', updatedInput: formValueToAnswers(qs, e.action.form_value) })
      return
    }
    callbacks.resolve(requestId, {
      behavior: 'allow',
      ...(v.always && v.suggestion ? { permissionUpdates: [v.suggestion as any] } : {}),
    })
  }
}

export function useFeishuBridge(setAppState: (fn: (s: any) => any) => void): void {
  useEffect(() => {
    const cfg = getFeishuConfig(getGlobalConfig() as any)
    if (!cfg) return
    const callbacks = createFeishuPermissionCallbacks()
    const questionsById = new Map<string, QuestionSpec[]>()  // interactiveHandler 发 question 卡时登记
    const client = new FeishuClient(cfg)
    client.onCardAction(wireCardAction(callbacks, questionsById))
    setAppState(s => ({ ...s, feishuPermissionCallbacks: callbacks, feishuClient: client, feishuQuestionsById: questionsById }))
    // fire-and-forget，不阻塞首屏
    void client.connect().catch(logError)
    return () => { void client.close().catch(logError) }
  }, [])
}
```

> `getGlobalConfig()`/`setAppState` 的确切获取方式按 REPL 现有约定接（见 Task 7）；`feishuQuestionsById` 也存入 AppState 供 interactiveHandler 登记 question 规格。

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/hooks/useFeishuBridge.test.ts`
Expected: PASS（3 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/state/AppStateStore.ts src/hooks/useFeishuBridge.tsx src/hooks/useFeishuBridge.test.ts
git commit -m "feat(feishu): AppState slots + useFeishuBridge card-action wiring"
```

---

## Task 6: interactiveHandler 竞速面 + 每胜出点同步

**Files:**
- Modify: `src/hooks/toolPermission/handlers/interactiveHandler.ts`
- Test: `src/hooks/toolPermission/handlers/interactiveHandler.feishu.test.ts`

**Interfaces:**
- Consumes: `feishuCallbacks`、`feishuClient`、`feishuQuestionsById`（经 params 传入）；`buildPermissionCard`/`buildResolvedCard`；`ctx.buildAllow`/`ctx.cancelAndAbort`/`ctx.removeFromQueue`。
- Produces: `handleInteractivePermission` 内新增飞书面（无 feature 门控），并在**每个胜出点**追加 `feishuUnsubscribe?.()` + 卡片 patch；导出一个可测纯函数 `makeFeishuRacer(...)` 以隔离测试竞速/同步/补偿逻辑。

**说明：** `interactiveHandler.ts` 很大且强依赖 React/上下文。为可测，把飞书面的**竞速 + 同步 + messageId 补偿**核心逻辑抽成纯函数 `makeFeishuRacer`，在 handler 内调用；测试只测该纯函数。

- [ ] **Step 1: 写失败测试**

```ts
// src/hooks/toolPermission/handlers/interactiveHandler.feishu.test.ts
import { describe, it, expect } from 'bun:test'
import { makeFeishuRacer } from './interactiveHandler.js'

function harness() {
  const patched: any[] = []
  const client = {
    sendCard: async () => 'om_1',
    updateCard: async (id: string, card: any) => { patched.push({ id, card }) },
  }
  const onResp: Record<string, (r: any) => void> = {}
  const callbacks = {
    onResponse: (id: string, h: any) => { onResp[id] = h; return () => { delete onResp[id] } },
    resolve: (id: string, r: any) => { onResp[id]?.(r); return true },
  }
  return { patched, client, callbacks, fire: (id: string, r: any) => callbacks.resolve(id, r) }
}

describe('makeFeishuRacer', () => {
  it('feishu wins → resolveOnce called, terminal/others cleaned via provided teardown', async () => {
    const h = harness(); const cleaned: string[] = []; let resolved: any = null
    const racer = makeFeishuRacer({
      requestId: 'r1', cardData: { requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' },
      client: h.client as any, callbacks: h.callbacks as any, questionsById: new Map(),
      claim: () => true, resolveOnce: (d: any) => { resolved = d },
      buildAllow: (i: any) => ({ behavior: 'allow', input: i }), cancelAndAbort: () => ({ behavior: 'deny' }),
      teardownOthers: () => { cleaned.push('others') },
    })
    await racer.start()
    h.fire('r1', { behavior: 'allow', updatedInput: { x: 1 } })
    expect(resolved).toEqual({ behavior: 'allow', input: { x: 1 } })
    expect(cleaned).toContain('others')
  })

  it('terminal wins before messageId arrives → compensation patch after sendCard resolves', async () => {
    const h = harness()
    let resolveSend: (id: string) => void = () => {}
    h.client.sendCard = () => new Promise<string>(res => { resolveSend = res })  // 卡片发送悬挂
    const racer = makeFeishuRacer({
      requestId: 'r1', cardData: { requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' },
      client: h.client as any, callbacks: h.callbacks as any, questionsById: new Map(),
      claim: () => true, resolveOnce: () => {}, buildAllow: (i: any) => i, cancelAndAbort: () => ({}), teardownOthers: () => {},
    })
    await racer.start()
    racer.syncOnResolved('terminal', 'allow')  // 终端先胜，messageId 尚未到
    expect(h.patched.length).toBe(0)           // 还没 patch（无 messageId）
    resolveSend('om_1'); await Promise.resolve(); await Promise.resolve()
    expect(h.patched.length).toBe(1)           // messageId 到手后补偿 patch
    expect(JSON.stringify(h.patched[0].card)).toContain('已允许')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `bun test src/hooks/toolPermission/handlers/interactiveHandler.feishu.test.ts`
Expected: FAIL（`makeFeishuRacer` 未导出）。

- [ ] **Step 3: 实现 makeFeishuRacer 并接入 handler**

在 `interactiveHandler.ts` 顶部新增导出（纯逻辑）：
```ts
import { buildPermissionCard, buildResolvedCard, type PermissionCardData, type QuestionSpec } from '../../../services/feishu/cards.js'
type FeishuRacerArgs = {
  requestId: string; cardData: PermissionCardData
  client: { sendCard(c: object): Promise<string>; updateCard(id: string, c: object): Promise<void> }
  callbacks: { onResponse(id: string, h: (r: any) => void): () => void; resolve(id: string, r: any): boolean }
  questionsById: Map<string, QuestionSpec[]>
  claim: () => boolean; resolveOnce: (d: unknown) => void
  buildAllow: (input: Record<string, unknown>, opts?: unknown) => unknown
  cancelAndAbort: (feedback?: string) => unknown
  teardownOthers: () => void
}
export function makeFeishuRacer(a: FeishuRacerArgs) {
  let messageId: string | undefined
  let resolvedState: { winner: string; behavior: 'allow'|'deny'|'cancelled' } | undefined
  let unsub: (() => void) | undefined
  if (a.cardData.kind === 'question' && a.cardData.questions) a.questionsById.set(a.requestId, a.cardData.questions)

  function patchResolved() {
    if (messageId && resolvedState) void a.client.updateCard(messageId, buildResolvedCard(a.cardData, resolvedState.winner, resolvedState.behavior))
  }
  return {
    async start() {
      unsub = a.callbacks.onResponse(a.requestId, (r) => {   // 先注册
        if (!a.claim()) return
        a.teardownOthers()                                   // 飞书胜出：清理其它面
        a.resolveOnce(r.behavior === 'allow'
          ? a.buildAllow(r.updatedInput ?? {}, { permissionUpdates: r.permissionUpdates })
          : a.cancelAndAbort(r.feedback))
        resolvedState = { winner: 'feishu', behavior: r.behavior }
        patchResolved()
        a.questionsById.delete(a.requestId)
      })
      // fire-and-forget 发卡，messageId 后填
      void (async () => {
        try { messageId = await a.client.sendCard(buildPermissionCard(a.cardData)); patchResolved() }
        catch { /* logError by caller */ }
      })()
    },
    // 其它面胜出时由 handler 调用
    syncOnResolved(winner: string, behavior: 'allow'|'deny'|'cancelled') {
      unsub?.()
      resolvedState = { winner, behavior }
      a.questionsById.delete(a.requestId)
      patchResolved()
    },
  }
}
```

在 `handleInteractivePermission` 内（`ctx.pushToQueue` 之后、其它面之旁），若 `feishuCallbacks && feishuClient`：构造 `racer = makeFeishuRacer({... claim, resolveOnce, buildAllow: ctx.buildAllow, cancelAndAbort: ctx.cancelAndAbort, teardownOthers: () => { ctx.removeFromQueue(); bridgeCallbacks?.cancelRequest?.(...); channelUnsubscribe?.() } })`，`await racer.start()` 前先 `void`（不阻塞）。在**每个非飞书胜出点**（`onAllow`/`onReject`/`onAbort`/recheck/bridge/channel/hook/classifier）追加：`racer.syncOnResolved(winner, behavior)`（winner 为该点身份，behavior 从 decision 推断；abort→'cancelled'）。

`cardData` 由 tool 决定 kind：`ExitPlanMode`→'plan'；`AskUserQuestion`→'question'（`questions` 来自 `input.questions`）；否则 'buttons'（`summary = tool.renderToolUseMessage(input)`，`suggestion = result.suggestions?.[0]`）。

- [ ] **Step 4: 运行验证通过**

Run: `bun test src/hooks/toolPermission/handlers/interactiveHandler.feishu.test.ts`
Expected: PASS（2 通过）。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/toolPermission/handlers/interactiveHandler.ts src/hooks/toolPermission/handlers/interactiveHandler.feishu.test.ts
git commit -m "feat(feishu): racer + per-win-point sync with messageId compensation"
```

---

## Task 7: 注入 + 挂载（去门控）

**Files:**
- Modify: `src/hooks/useCanUseTool.tsx`（仿 `:160-167` 注入，**无 feature 门控**）
- Modify: `src/screens/REPL.tsx`（挂载 `useFeishuBridge`）
- Test: 手动 smoke（见 Step 4）

**Interfaces:**
- Consumes: `appState.feishuPermissionCallbacks`、`appState.feishuClient`、`appState.feishuQuestionsById`。
- Produces: `handleInteractivePermission` 收到飞书面参数并激活。

- [ ] **Step 1: 注入**

在 `useCanUseTool.tsx` 调 `handleInteractivePermission(params, resolve)` 处，`params` 追加（对照现有 `bridgeCallbacks`/`channelCallbacks` 行，但**不包 feature()**）：
```ts
        feishuCallbacks: appState.feishuPermissionCallbacks,
        feishuClient: appState.feishuClient,
        feishuQuestionsById: appState.feishuQuestionsById,
```
并在 `handleInteractivePermission` 的参数类型里加这三项（可选）。

- [ ] **Step 2: 挂载 hook**

在 `REPL.tsx` 组件体内（其它 hook 附近）加：`useFeishuBridge(setAppState)`（`setAppState` 用 REPL 现有的 app-state 更新函数；若 REPL 用 store 而非 setState，则用对应写入方式把三个字段写入 AppState）。

- [ ] **Step 3: 类型检查**

Run: `bun x tsc --noEmit`（或项目既有类型检查方式）
Expected: 无新增类型错误。

- [ ] **Step 4: 手动 smoke（需 Bun + 飞书应用）**

Run: 配好 `settings.json` 的 `feishu` 块后启动 `bin/claude-haha`，触发一次需确认的 Bash。
Expected: 终端弹确认的**同时**飞书收到卡片；在飞书点"允许一次"→ 工具执行、终端确认消失、卡片变"✅ 已允许（飞书）"。反向：在终端确认 → 飞书卡片变"✅ 已允许（终端）"。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/useCanUseTool.tsx src/screens/REPL.tsx src/hooks/toolPermission/handlers/interactiveHandler.ts
git commit -m "feat(feishu): inject feishu surface into canUseTool + mount bridge (no feature gate)"
```

---

## Task 8: 文档

**Files:**
- Create: `docs/feishu-setup.md`

- [ ] **Step 1: 写飞书应用配置说明**

内容涵盖：创建自建应用、开通机器人能力与 `im:message` 权限、事件与**回调**订阅切"长连接"模式、订阅 `card.action.trigger`、开通"卡片回传交互"、把机器人拉进目标群或获取个人 `open_id`、把 `appId/appSecret/receiveId/receiveIdType` 填入 `settings.json` 的 `feishu` 块（示例）。

- [ ] **Step 2: 提交**

```bash
git add docs/feishu-setup.md
git commit -m "docs(feishu): app setup guide"
```

---

## Self-Review 结果（已核对规格）

- 规格 5.1 配置 → Task 1 ✅；5.2 组件 → Task 2/3/4/5 ✅；5.3 竞速注入去门控 → Task 6/7 ✅；5.4 原语与表单 → Task 3 ✅；5.5 每胜出点同步 + messageId 补偿 → Task 6 ✅；5.6 生命周期 → Task 5（fire-and-forget connect / close）✅；应用能力 → Task 8 ✅；spike → Task 0 ✅。
- 类型一致：`FeishuPermissionResponse`（含 `feedback?`）、`FeishuPermissionCallbacks`、`PermissionCardData`、`makeFeishuRacer` 参数在各任务间一致。
- 无占位符：每步含实测测试代码与命令。飞书卡片 tag 名以 Task 0 实测校正（已在 Task 3/4 显式标注）。
- 已知执行前提：本沙箱无 Bun，TDD 循环需在装有 Bun 的环境执行；手动 smoke 需真实飞书应用。
