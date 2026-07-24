# 设计规格：飞书确认卡片 + 多角色子 Agent（v2 · 已过多人评审）

- 日期：2026-07-24
- 状态：v2，已纳入 3 份对抗式评审（架构落点 / 协议正确性 / 可行性）的全部确认项，待用户终审 → writing-plans
- 项目：claude-code 本地 fork（TypeScript / Bun / Ink TUI / React / Anthropic SDK / MCP）

## 1. 背景与目标

新增两个大功能：

1. **飞书确认卡片**：所有需要用户确认的场景，都以飞书交互式卡片形式推送；用户在卡片上操作完成确认。使用飞书官方 SDK 的**长连接（WebSocket / WSClient）**接收卡片回调，**不采用 webhook**。
2. **多角色子 Agent**：配置中定义多个"角色"（子 Agent），每个声明能力（`whenToUse`）与模型/执行配置（API URL、API Token、API 协议、模型名、思考深度），支持 **API 模式** 与 **CLI 模式**。主会话按能力派遣。CLI 与 API 模式下子 Agent 自身产生的确认也必须交互式（并按功能一走飞书）。

### 设计取向（重要）

- 本项目为本地单用户 fork。**功能实现优先于安全加固**，安全约束不得成为实现阻碍。
- API Token / 飞书 appSecret 等**直接明文写入配置文件**（settings.json），不做 `env:` 间接引用、不做密钥脱敏。与现有 `.env` 明文存 `ANTHROPIC_AUTH_TOKEN` 一致。

## 2. 范围

### 首版 In-scope

- 功能一：覆盖所有走 `ToolUseConfirm` 的确认（Bash / 文件编辑 / 文件写入 / WebFetch / 计划模式 ExitPlanMode / 多选提问 AskUserQuestion），飞书与终端**并存竞速**，谁先响应谁生效，**双向状态一致**。
- 功能二：`settings.json` 新增 `roles` 数组；API 模式（Anthropic 兼容 + OpenAI 兼容）与 CLI 模式（非交互档 + 交互档）。

### 非目标（首版不做）

- **无头模式（`--print`）**：飞书确认与子 Agent 交互式确认**仅在 TUI 模式**生效。无头模式的权限入口是 `getCanUseToolFn`（`src/cli/print.ts:4267`），**不经过竞速器**，且无 React 树（飞书桥 `useFeishuBridge` 不会构造）。无头保持现有权限行为。（评审 feasibility-B1，用户已确认仅 TUI。）
- 启动期独立对话框（TrustDialog、MCP 审批、YOLO、API key 审批等，走 `showDialog`/`dialogLaunchers`）暂不接入飞书。
- CLI 交互档暂不复用 Claude Code SDK 的 stream-json 协议（只做自定义 JSON-lines）。
- 每角色 Bedrock / Vertex / Foundry 协议（首版只做 `anthropic` / `openai` 两种 `apiProtocol`）。

## 3. 术语

- **确认面 / racer**：能解决同一个权限 Promise 的一个来源。现有：本地终端队列、Bridge（claude.ai）、Channel（MCP）。本设计新增**飞书**面。
- **竞速器**：`interactiveHandler.ts` 中多个面通过 `createResolveOnce` 的 `claim()` 竞争解决，第一个响应者胜出，**每个胜出点各自手工清理其它面**（非集中式广播，见 5.5）。

## 4. 现状架构事实（已逐条核实）

### 关键前提修正（评审新增）

- **`feature()` 门控**：`useCanUseTool.tsx:165-166` 的 `bridgeCallbacks`/`channelCallbacks` 与 `interactiveHandler.ts:316-320` 的 Channel 竞速块，均包在 `feature("BRIDGE_MODE")` / `feature("KAIROS")||feature("KAIROS_CHANNELS")` 里。`feature()` 来自 `bun:bundle`（编译期旗标），本 fork 解释运行（`bin/claude-haha` → `bun ./src/entrypoints/cli.tsx`）、`bunfig.toml` 未定义 features → 运行时为 **false**。**结论：Channel/Bridge 面在本 fork 从未激活，本地唯一活着的面是终端队列。飞书面的注入与竞速块一律不得带 `feature()` 门控。**（评审 feasibility-B2）
- **每角色 client 的真实接缝在 `src/query.ts:665-707`**（`deps.callModel({options:{… fetchOverride …}})`，此处 `toolUseContext` 在作用域内），并非 `claude.ts` 的 `getAnthropicClient`。`Options.fetchOverride`（`claude.ts:689`）是贯穿到底的一等参数，plumbing 近乎零风险；真正难点是翻译层（见 6.3）。（评审 arch-m1）

### 权限/确认（功能一相关）

- 权限入口 `useCanUseTool.tsx`：外层 `new Promise(resolve=>…)`（`:32`）；`case "ask"`（`:93`）依次 `handleCoordinatorPermission` → `handleSwarmWorkerPermission`（仅 `isAgentSwarmsEnabled()&&isSwarmWorker()` 拦截，`swarmWorkerHandler.ts:44`）→ 落 `handleInteractivePermission`。REPL 装配 `:2382`。
- 竞速器 `interactiveHandler.ts`：**一个** `createResolveOnce(resolve)`（`:70`，`{resolve,isResolved,claim}`，`claim()` 原子占用，`PermissionContext.ts:75`）。清理是**散落式**：终端胜出（`onAllow:154`/`onReject:183`/`onAbort:137`）、Bridge 胜出（`:256-295`）、Channel 胜出（`:363-397`）、hook（`:423-429`）、classifier（`:455-520`）、recheck（`:222-229`）各自调用对方 teardown（如 `channelUnsubscribe?.()`、`bridgeCallbacks.cancelRequest`、`ctx.removeFromQueue()`）。`resolveOnce` 只收 `PermissionDecision`，**不带 winner 身份**，且被 `swarmWorkerHandler.ts:68` 共享。
- Channel 模板 `channelPermissions.ts:209` `createChannelPermissionCallbacks`（闭包 `pending` Map + `onResponse` + `resolve`）；`ChannelPermissionResponse` 仅 `{behavior, fromServer}`（`:40`）。
- AppState 槽 `AppStateStore.ts:447/451`；构造 `useManageMCPConnections.ts:175`；入站 resolve `:544`。
- 合成器 `remotePermissionBridge.ts`：`createSyntheticAssistantMessage(req: SDKControlPermissionRequest, id)` 产 **AssistantMessage**（`:12`）、`createToolStub(name)` 产 **Tool**（`:53`）。二者是 `createPermissionContext(tool, input, ctx, assistantMessage, …)` 的**输入**，**不是** `ToolUseConfirm`。现有手搓用法（`useDirectConnect.ts:92-149`）**绕过竞速器**，不可照抄。
- ExitPlanMode / AskUserQuestion 在终端模式经 `pushToQueue` 到达本 handler（未被 `requiresUserInteraction` 短路挡在 handler 之外，`interactiveHandler.ts:319` 的短路只作用于 channel 中继）；飞书可接管。AskUserQuestion 输入 schema：1–4 个 question、每题 2–4 option、可 `multiSelect`、自动提供 Other 自由文本（`AskUserQuestionTool.tsx:20-63`）；结果通过 `updatedInput` 注入结构化 **`answers`** 数组。

### 子 Agent / 派遣（功能二相关）

- 派遣工具 `Agent`（旧名 `Task`）`AgentTool.tsx`：`call(...)` 内 `canUseTool` 可用（`:250`）；按 `subagent_type` 在 `toolUseContext.options.agentDefinitions.activeAgents` 查（`:286`）；**`runAgent(...)` 硬编码**（`:736/846/925`），无 `execMode` 分支。`AgentToolInput` 已有 `mode`（spawn 档，`:247`）。
- 定义 schema `BaseAgentDefinition`（`loadAgentsDir.ts:106`）；注册 `getAgentDefinitionsWithOverrides = memoize(async(cwd)=>…)`（`:296`，按 cwd 记忆化，`clearAgentDefinitionsCache()` @ `:395` 刷新）；去重 `getActiveAgentsFromList`（`:193`，**只分 built-in/plugin/userSettings/projectSettings/policySettings/flagSettings 六桶，漏了 `localSettings`**，后写覆盖先写）。
- JSON 解析 `parseAgentsFromJson`（`:521`）→ `AgentsJsonSchema=z.record(string, AgentJsonSchema())`（`:101`，**record 非数组**）；`AgentJsonSchema`（`:73`，非 strict → **strip 未知键**，`prompt` 为 `min(1)` 必填，用 `description` 而非 `whenToUse`）。**不可复用于 roles。**
- 运行 `runAgent()`（`runAgent.ts:248`）复用 `query()`；透传父级 `canUseTool`（`:748`）；`agentOptions`（`:667`）；effort 覆盖（`:481`；非 fork 子 agent thinking 默认 disabled，`:684`）；模型 `getAgentModel`（`agent.ts:37`，未知串原样透传）→ `mainLoopModel`。
- API client `getAnthropicClient({apiKey?,maxRetries,model?,fetchOverride?,source?})`（`client.ts:88`，**无 baseURL 参数**；`buildFetch(fetchOverride)` @ `:139`）；env/auth 分支（`:135-316`）：`isClaudeAISubscriber()` 会置 `apiKey=null` 改用 OAuth token（`:302-305`）；`configureApiKeyHeaders` 读全局 `ANTHROPIC_AUTH_TOKEN`（`:318-328`）；`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` 返回不同 client 类（`:153/191/221`）；注入 `getCustomHeaders()`/session-id/`getAPIMetadata()` 等。引擎流式消费 `claude.ts:1822`（原始 Stream，`for await` @ `:1940`；`message_start` 依赖 `:1980`，缺失触发 `:2341` 非流式回退）；stop_reason 塞 `message_delta`（`:2213`）；effort 门控 `modelSupportsEffort`（`:440`）。
- CLI 构建块 `spawnShellTask`（`LocalShellTask.tsx:180`，Bash 工具专用，围绕 `ShellCommand`；**stdin 注入/自定义 argv 未必开箱可用**）；`tree-kill` 依赖可用于 kill 进程树。
- 配置 `SettingsSchema`（`types.ts:255`，`.passthrough()` @ `:1072`）；源 `SETTING_SOURCES`（`constants.ts`，含 `localSettings`）；按源读取 `getSettingsForSource(source)`（`settings.ts:309`）。

## 5. 功能一详细设计：飞书确认卡片

### 5.1 配置

`settings.json` 顶层 `feishu` 块（显式 zod schema，明文）：
```jsonc
{
  "feishu": {
    "enabled": true,
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "receiveIdType": "open_id",   // open_id | chat_id | user_id | union_id | email
    "receiveId": "ou_xxx",
    "cardLanguage": "zh"          // 可选
  }
}
```
启用：`enabled===true` 且 appId/appSecret/receiveId 齐全。缺失/连不上 → 静默禁用飞书面，终端照常。

飞书应用侧需开通（文档说明）：机器人能力 + `im:message`（发消息）权限；事件与**回调**订阅切"长连接"模式；`card.action.trigger` 属"回调"；机器人对 `receiveId` 可达（个人能收 bot 消息 / 群内有 bot）；开通"卡片回传交互"。`tenant_access_token` 由 SDK（`Client(appId,appSecret,AppType.SelfBuild)`）自动获取/缓存刷新，无需自管；发卡 `content` 必须是**字符串化**卡片 JSON。（评审 protocol-N3）

### 5.2 新增组件与文件

- `src/services/feishu/FeishuClient.ts`：封装 `@larksuiteoapi/node-sdk`。`Client`（发卡 `im.message.create`，`msg_type='interactive'`、`receive_id_type` 走 query；更新卡片 `im.message.patch`）+ `WSClient`（长连接，`EventDispatcher.register({'card.action.trigger': handler})`）。方法 `connect()`/`close()`/`sendCard(card):Promise<{messageId}>`/`updateCard(messageId,card)`/`onCardAction(handler)`。断线重连、优雅关闭。**WSClient 的 ack 与业务 resolve 解耦**（ack 立即返回，避免久等触发飞书重发风暴；评审 protocol-N2）。
- `src/services/feishu/feishuPermissions.ts`：`FeishuPermissionCallbacks = { onResponse(requestId, handler: (r: FeishuPermissionResponse)=>void): ()=>unsub; resolve(requestId, r: FeishuPermissionResponse): boolean }`；`FeishuPermissionResponse = { behavior: 'allow'|'deny'; updatedInput?: Record<string,unknown>; permissionUpdates?: PermissionUpdate[]; feedback?: string }`（**比 channel 富**，需承载 AskUserQuestion 的 `answers`/ExitPlanMode/总是允许的规则；评审 arch-m3）。`createFeishuPermissionCallbacks()` 闭包 `pending` Map，`resolve` 删除即幂等（仿 `channelPermissions.ts`）。`requestId` 直接用 `toolUseID`。
- `src/services/feishu/cards.ts`：`buildPermissionCard(confirmData, suggestions)` / `buildResolvedCard(confirmData, winner, behavior)`（终结态、禁用交互）。按工具类型选原语（见 5.4）。**"总是允许"按钮的 `value` 在建卡时嵌入该工具的持久化规则**（来自 `result.suggestions`，评审 protocol-M6）。
- AppState 槽 `feishuPermissionCallbacks?`、`feishuClient?`（`AppStateStore.ts`，仿 channel）。
- `src/hooks/useFeishuBridge.tsx`（仿 `useManageMCPConnections`）：会话启动且启用时构造 client + callbacks；连接 **fire-and-forget，不阻塞 REPL 首屏**（评审遗漏点 2）。`WSClient` 的 `card.action.trigger` → 解析 `event.action`（按钮取 `action.value`，表单取 `action.form_value`）→ 组装 `FeishuPermissionResponse` → `feishuPermissionCallbacks.resolve(requestId, r)`；同时可**直接返回一张新卡片**给飞书（即时禁用，见 5.5）。存入 AppState。

### 5.3 竞速注入（不带 feature 门控）

在 `interactiveHandler.ts` 新增飞书竞速块，**镜像 Channel 块的 fire-and-forget + 先注册后发**顺序（评审 protocol-M1 / arch-m2）：
```
// 位于 handleInteractivePermission，无 feature() 门控
let feishuMessageIdP        // Promise<messageId>，惰性
let feishuUnsubscribe
if (feishuCallbacks && feishuClient) {
  const requestId = toolUseID
  feishuUnsubscribe = feishuCallbacks.onResponse(requestId, (r) => {   // 先同步注册
    if (!claim()) return
    // 飞书胜出：手工清理其它面
    ctx.removeFromQueue()
    bridgeCallbacks?.cancelRequest?.(...)
    channelUnsubscribe?.()
    resolveOnce(r.behavior === 'allow'
      ? ctx.buildAllow(r.updatedInput ?? input, { permissionUpdates: r.permissionUpdates })
      : ctx.cancelAndAbort(r.feedback))
    // 飞书自身胜出：优先用 card.action.trigger 回调"返回新卡片"即时禁用（原子、无需 messageId）
  })
  feishuMessageIdP = void-async: feishuClient.sendCard(buildPermissionCard(confirmData, suggestions)) // fire-and-forget，失败 logError 跳过
}
```
注入：`useCanUseTool.tsx` 仿 `:160-167` 追加 `feishuCallbacks: appState.feishuPermissionCallbacks`、`feishuClient: appState.feishuClient`（**无 feature 门控**）传入 `handleInteractivePermission`。飞书面**不**照搬 `requiresUserInteraction` 短路。

### 5.4 卡片原语与结果构造

- 展示：工具用户名（`tool.userFacingName`）、`renderToolUseMessage(input)` 摘要、关键目标、会话标识、时间。
- **普通工具 / ExitPlanMode**：**按钮**。普通工具 `允许一次`(allow) / `总是允许`(allow + 内嵌规则) / `拒绝`(deny)；ExitPlanMode `批准计划`(allow) / `继续完善`(deny)。回调取 `action.value.{requestId,behavior}`。
- **AskUserQuestion**：**必须用飞书表单容器 form**（不能用无状态按钮）——每题一组 `select_static`（单选）或 `multi_select_static`（多选），Other 用 `input` 文本框，末尾一个 submit；提交时从 `event.action.form_value` 读回，按 `input.questions` **逐题构造与本地富选择器一致的 `answers` 结构**（单选→label；多选→label 数组；Other→文本）→ `ctx.buildAllow(updatedInput={answers})`。（评审 protocol-B3 / arch-m3）
- 语言按 `feishu.cardLanguage`。

### 5.5 双向状态一致性（头等约束 · 每胜出点手工同步模型）

**放弃"单点广播 `syncResolution`"**（现有 `resolveOnce` 不带 winner、无回调注册表、被 swarm 共享，挂不上；评审 arch-B1）。改为与现有 `channelUnsubscribe` 同构的**每胜出点手工同步**：

- **飞书胜出**：在 5.3 的 `onResponse` 回调里，除 `resolveOnce` 外，手工 `ctx.removeFromQueue()`（终端出队）+ `bridgeCallbacks.cancelRequest` + `channelUnsubscribe?.()`；卡片本身用 **`card.action.trigger` 回调返回新卡片**即时变终结态（原子，约 3 秒确认窗内完成，无需 messageId；评审 protocol-N1）。
- **终端 / bridge / channel / hook / classifier / abort 胜出**：在**每一个**现有胜出点（`onAllow/onReject/onAbort/recheck/bridge/channel/hook/classifier`）追加 `feishuUnsubscribe?.()` + `patchFeishuCard(终结态)`。
- **messageId 未到手的补偿**（评审 protocol-M1 / arch-m2）：若在 `sendCard` 尚未返回 messageId 时其它面已胜出，则记一个 `feishuResolvedState`（终结态 + behavior）；`sendCard` 的 Promise resolve 后立即用该 state `updateCard` 补 patch。即 `feishuMessageIdP.then(id => patchIfResolved(id))`。
- **中止 / 会话结束 / 超时**：卡片 patch 为 `⏹ 已取消 / 已过期`，终端清理。`FeishuClient.close()` 时批量标记未决卡片过期。
- 健壮性：所有 patch/return-card 为 best-effort，`logError` 不影响主流程；重复回调由 `pending` Map 删除即幂等。

### 5.6 生命周期

启动（TUI、`feishu.enabled`）→ fire-and-forget `connect()`；失败重试并降级（终端仍可用）。运行：长连接常驻，事件驱动 `resolve`。关闭：进程退出/会话结束 `close()`，未决卡片标记过期。**config 中途改动不重连**（需重启，5.6 显式声明；评审遗漏点）。

## 6. 功能二详细设计：多角色子 Agent

### 6.1 配置

`settings.json` 顶层 `roles` 数组（显式 zod schema）：
```jsonc
{
  "roles": [
    {
      "name": "reviewer",                 // → agentType（唯一；不得与内置 agentType 撞名，见 6.2）
      "whenToUse": "需要独立代码安全审查时派遣",
      "execMode": "api",                   // "api" | "cli"（改名，避开 AgentToolInput.mode 语义撞车）
      "tools": ["Read", "Grep"],          // 能力边界（api 模式有效；cli 模式见 6.5）
      "prompt": "你是资深安全审查员……",     // 可选，包装成 getSystemPrompt

      // execMode:"api"
      "apiProtocol": "openai",             // "anthropic" | "openai"
      "apiUrl": "https://api.example.com/v1",
      "apiToken": "sk-xxx",                // 明文
      "model": "gpt-4o",                   // 后端目标模型（见 6.3 模型身份处理）
      "thinkingDepth": "high",             // → effort；openai 下由 shim 译成 reasoning_effort

      // execMode:"cli"
      "command": "my-agent-adapter",
      "args": ["--json"],
      "interactive": true,                 // true=JSON-lines 交互档；false=单次 stdin→stdout
      "cwd": "."
    }
  ]
}
```

### 6.2 解析、注册与派遣（独立 schema，勿复用 parseAgentsFromJson）

- `src/tools/AgentTool/rolesFromSettings.ts`：**独立 zod schema + 独立映射**（数组、`whenToUse`、可选 `prompt`、显式拷贝 `execMode/apiProtocol/apiUrl/apiToken/command/args/interactive/cwd/model/thinkingDepth` 到扩展后的 `BaseAgentDefinition`；`prompt` 字符串包装成 `getSystemPrompt`）。**不复用** `AgentJsonSchema`/`parseAgentFromJson`（会 strip 全部执行字段、形状/必填不符；评审 arch-B2）。
- **按源读取**：用 `getSettingsForSource(source)`（`settings.ts:309`）分别读 `userSettings`/`projectSettings`/`localSettings` 的 `roles`（读合并结果无法区分来源）。
- **source 归属修复**：`getActiveAgentsFromList`（`loadAgentsDir.ts:193`）**漏 `localSettings` 桶** → 给角色赋被处理的 source，或扩展该函数补 `localSettings` 桶，否则 `settings.local.json` 的角色（用户放明文 token 的自然位置）被静默丢弃（评审 arch-M1）。
- 并入 `getAgentDefinitionsWithOverrides`（`:296`）的 `allAgentsList`（`getActiveAgentsFromList` 前）。
- **撞名校验**：拒绝/告警与 `getBuiltInAgents()` 的 agentType 同名的 role（否则静默覆盖内置 agent；评审 feasibility-M3）。
- 记忆化：roles 变更需重启或 `clearAgentDefinitionsCache()`（与自定义 agent 一致）。
- `BaseAgentDefinition` 扩展字段（复用已有 `model`/`effort`）：`execMode?/apiProtocol?/apiUrl?/apiToken?/command?/args?/interactive?/roleCwd?`。**SDK `AgentDefinitionSchema`（coreSchemas.ts）无需同步改**（roles 不走 SDK 通道）。
- 派遣：`whenToUse` 注入工具 prompt，`AgentTool.call` 按 `subagent_type` 匹配即可（选择逻辑不改；执行分派要改，见 6.4）。

### 6.3 API 模式（每角色 fetchOverride 垫片）

真实接缝 `src/query.ts:665-707`（`toolUseContext` 在作用域内，把每角色 client 配置从 `agentOptions` 组装成 `fetchOverride` 注入；`roleShim ?? dumpPromptsFetch` 组合）。plumbing 低风险，重心在翻译层。

- **模型身份分离**（评审 arch-M3）：引擎用 `mainLoopModel` 做 Claude 特有决策（`getModelBetas`/`normalizeModelStringForAPI`/`max_tokens` 预算/`cache_control`/effort 门控）。故 openai 角色的 `mainLoopModel` **保持一个 Claude 别名**（保证引擎数学/门控正常），真正的 `gpt-4o` 放进 shim 读取的每角色 client 配置，在 fetch 边界重建请求体时替换 `body.model`。anthropic 同族协议无此问题。
- **`apiProtocol:'anthropic'`**：shim **完全接管** URL 与鉴权（重写 Request host → `apiUrl`；删除全局 `Authorization`、`x-api-key`，注入角色 `apiToken`；覆盖/剥离 env 派生头）。不能依赖 `getAnthropicClient` 默认 auth（订阅登录吞 token、全局 AUTH_TOKEN 污染、Bedrock/Vertex 换 client 类；评审 protocol-B2）。
- **`apiProtocol:'openai'`**：shim 拦截引擎产出的 Anthropic 请求 → 译为 `/v1/chat/completions` → 调 `apiUrl` → 把响应译回 **Anthropic SSE 流**。翻译契约（每条转 TDD 断言；评审 protocol-M2/M3/M5）：
  - **请求映射**：顶层 `system`（可能块数组）→ 起始 `role:'system'`；user 消息里多个 `tool_result`（`tool_use_id`）→ 各拆成一条 `role:'tool'`（`tool_call_id`），紧跟含 `tool_calls` 的 assistant；assistant 多个 `tool_use` → `tool_calls` 数组 + `content:null`；`max_tokens`→（o 系列）`max_completion_tokens`；**丢弃** anthropic-only 字段（betas/output_config/context_management/metadata/thinking/cache_control/container）；`body.model` 用角色原始 model（勿信被 normalize 的值）；注入 `stream_options:{include_usage:true}`；`thinkingDepth`→`reasoning_effort`（o 系列）。
  - **响应流翻译**：必发带完整骨架的 `message_start`（`id/role/model/usage`，否则触发 `:2341` 回退）；文本→`content_block_start/delta(text)/stop`；tool_calls 增量按 **OpenAI 的 tool_calls[].index 映射到 Anthropic 全局 content_block.index**（文本块占 0 时工具块从 1 起，id/name 首帧缓存，`input_json_delta.partial_json` 累积）；`stop_reason` 映射（stop→end_turn / length→max_tokens / tool_calls→tool_use / content_filter→end_turn）塞 `message_delta`；末尾 `usage`（prompt→input/completion→output，cache 字段缺省）；必发 `message_stop`；错误整成 Anthropic 形状错误响应（正确 HTTP status + `{type:'error',error:{...}}`，否则 `withRetry`/回退错乱）；`reasoning_content` 丢弃或降级为 text（勿合成 thinking 块）。
- 模型/思考深度：`model`→`getAgentModel`；`thinkingDepth`→`effort`（anthropic 有效；openai 由 shim 译 reasoning_effort，否则静默失效，评审 protocol-M5）。
- 子 Agent 内部工具确认：天然走父级 `canUseTool` → 竞速器 → 终端 + 飞书（TUI）。
- 翻译实现 `src/services/api/openaiCompat/`（`toOpenAIRequest.ts` / `fromOpenAIStream.ts` / `anthropicPassthrough.ts`）。

### 6.4 CLI 模式（新增执行分派 + 两档）

- **执行分派**（评审 feasibility-M2 / arch-M2）：在 `AgentTool.call` 内 `selectedAgent` resolved 之后、构建 `runAgentParams` 之前，按 `selectedAgent.execMode==='cli'` **分叉**到 `cliAgentRunner`（否则 CLI 角色会被丢进 `runAgent` 跑 API 请求）。**同步与 async（`run_in_background`）两条路径都要覆盖**：`cliAgentRunner` 须产出与 `runAgent` 同形状的 `AsyncGenerator<Message>`（带 uuid/type/message.content），把 `{"type":"result",content}` 转成合规 assistant `Message`，以便 `call()` 抽取 tool_result、对齐 `finalizeAgentTool`/进度/任务注册/后台化契约。
- `src/tools/AgentTool/cliAgentRunner.ts`：spawn 子进程、按档处理 IO、yield Message 流。
- **非交互档（`interactive:false`）**：`command args…`，task prompt 经 **stdin** 传入，**stdout** 整段为结果。`spawnShellTask` 可能不适配（Bash 专用、stdin/argv 未必支持）→ 允许**另起 `Bun.spawn`/child_process** 直接 spawn（评审 arch-m5）。
- **交互档（`interactive:true`）**：自定义 JSON-lines 协议（6.5）。
- **进程管理**（评审遗漏点）：结果超时（进程存活但久不返回 → 超时 kill）；主会话 ESC/abortController 传播到子进程（`tree-kill` 杀进程树）；stdin 背压：**边写 stdin 边持续读 stdout**，避免管道写满双向死锁。

### 6.5 CLI 交互档：JSON-lines 控制协议 + 确认落点

- **通道分离**（评审 protocol-B1）：**协议 JSON 只走 stdout（每行一个 JSON），子进程的普通日志/自然输出强制走 stderr**；或协议走 fd3。规格明确：**交互档面向"实现了本协议的适配器进程"，不适用任意现成第三方 CLI**（第三方 CLI 的 stdout 是散文，会持续 parse 失败）。
- **确认落点修正**（评审 arch-B3）：收到 `permission_request` → 适配成 `SDKControlPermissionRequest` 形状（`tool_name/input/tool_use_id`）→ 调 **`AgentTool.call` 作用域内的父级 `canUseTool`**：
  ```
  const decision = await canUseTool(
    createToolStub(tool_name), input, toolUseContext,
    createSyntheticAssistantMessage(req, requestId), tool_use_id)
  ```
  这才天然经 `useCanUseTool → 'ask' → handleInteractivePermission → 终端 + 飞书竞速`（**不要**手搓 `ToolUseConfirm` 塞队列，那会绕过竞速器/飞书）。把 `decision` 译回 `permission_response`。
- **协议**：
  - 主→子（stdin，逐行）：`{"type":"task","prompt","context?"}`；`{"type":"permission_response","id","behavior":"allow"|"deny"|"allow_always","updatedInput?","permissionUpdates?","feedback?"}`。
  - 子→主（stdout，逐行）：`{"type":"permission_request","id","tool","input","description?"}`；`{"type":"result","content"}`（终止）；`{"type":"error","message"}`。日志走 stderr。
  - 补齐语义（评审 protocol-M4）：`allow_always`/`permissionUpdates`（把父侧持久化规则回写子进程，使其此后不再问该类）；deny 携带 `feedback`（拒绝理由回灌）；`updatedInput` 契约：子进程**必须**用它替换自身缓存 input。
- **CLI 角色的工具权限语义**（评审遗漏点 6）：CLI 子进程自管工具，`resolveAgentTools` 对它无意义；合成的 `createToolStub` 工具不在注册表，`hasPermissionsToUseTool` 对它的决策语义需明确——首版约定：stub 工具默认 `behavior:'ask'`（总是弹确认），不参与本地规则匹配。
- 分帧：面向行的读取器处理跨 chunk 部分行/超长行（大 `result.content`），勿 `split('\n')` 丢尾。单任务（`task`→`result` 无 task id，首版限制，写明）。

## 7. 横切关注

- 配置加载/校验：`feishu`/`roles` 写显式 zod（叠在 `.passthrough()` 上），启动校验，错误指明角色/字段。
- 错误处理：飞书发送/patch、CLI spawn、OpenAI 翻译均 best-effort + `logError`，不崩主流程；飞书面失败不影响终端。
- 依赖：新增 `@larksuiteoapi/node-sdk`（**pin 版本 + `bun add` 更新 lockfile**；`ws` 已在 Bun 下可用，见 `voiceStreamSTT.ts`）。OpenAI 翻译用现有 `undici`/`fetch`，不引 openai SDK。
- 日志：不做 token 脱敏。

## 8. 测试策略

- **实现第 0 步（spike）**：Bun 下最小连通性验证 `@larksuiteoapi/node-sdk`——`WSClient.connect()` + 收一个 `card.action.trigger`（验证 SDK 的 token 管理/卡片签名/长连接帧在 Bun 兼容），通过再继续（评审 feasibility-M1）。
- 单元：`feishuPermissions`（onResponse/resolve/幂等/未知 id）；`cards`（按钮 vs form 原语、终结态卡片、总是允许规则内嵌）；form_value→`answers` 逐题构造（单选/多选/Other）；OpenAI 翻译（请求映射：system/tool_result 重排/max_completion_tokens/丢字段/model 覆盖；响应流：message_start 骨架/tool_call index→全局块/stop_reason/usage/message_stop/错误形状/reasoning 丢弃）；JSON-lines 解析/分帧/allow_always/feedback；竞速+每胜出点同步（终端先胜/飞书先胜/messageId 未到补偿/abort 三路径，断言另一面被同步且仅一次生效）。
- 集成：mock 飞书 `WSClient`（注入 card.action.trigger 按钮与表单两类）、mock 子进程适配器（按协议吐 JSON + 走 stderr 日志）、mock OpenAI 端点（含流式/工具调用/错误）。
- 端到端手测（需 Bun 环境）：真实飞书应用长连接 + 1 个 OpenAI 兼容 API 角色 + 1 个 CLI 交互角色，跑通"派遣→子 Agent 请求确认→飞书点按/表单提交→结果回主会话"，并验证终端/飞书先胜两种同步一致。

## 9. 风险（已按评审重排）

1. **OpenAI ↔ Anthropic 流式+请求翻译完备性**（原最大风险从 plumbing 移到此）：message_start 骨架、tool_call 全局块下标、stop_reason、usage 注入、错误形状、请求字段裁剪、effort→reasoning_effort。逐条 TDD 锁定。
2. **AskUserQuestion 的 form→answers 构造**须与本地富选择器逐题一致（bridge 面仅优雅降级，飞书要真正构造正确 `updatedInput`）。
3. **`@larksuiteoapi/node-sdk` 在 Bun 下未验证**（token 管理/AES 卡片签名/长连接私有帧）→ spike 先行。
4. **每胜出点手工同步**改动面散落约 8 处，易漏一处导致卡片不同步 → 测试覆盖三路径。
5. CLI 交互档的进程 IO（死锁/分帧/kill 传播）与"仅适配器进程可用"的边界。
6. 每角色 client plumbing（低风险，`fetchOverride` 已贯穿）；`localSettings` 桶/撞名/记忆化等小坑已在 6.2 列明。

## 10. 评审与验收计划

1. ✅ v1 规格 → 3 份对抗式评审（架构/协议/可行性）→ 本 v2 已纳入全部确认项。
2. 用户终审本 v2 规格。
3. `writing-plans` 出实现计划 → TDD 实现（spike 第 0 步先行）。
4. 充分测试后，派遣多个验收 agent 逐条对照本规格与原始需求验收；有问题持续迭代直到满足。

## 附录 A：v1 → v2 评审修订摘要

- 【功能一·机制纠错】删除不存在的"单点广播 `syncResolution`"，改为每胜出点手工同步（arch-B1）。
- 【功能一·原语纠错】AskUserQuestion 用飞书 form + 单选/多选/输入，结果构造 `answers`（protocol-B3）。
- 【功能一·时序】竞速块 fire-and-forget + 先注册后发 + messageId 未到补偿 patch；飞书胜出用回调返回新卡片即时禁用（protocol-M1）。
- 【功能一·门控】飞书面不带 `feature()` 门控（feasibility-B2）。
- 【功能一·总是允许】规则建卡时内嵌按钮 value（protocol-M6）。
- 【功能二·解析纠错】独立 schema/映射，不复用 `parseAgentsFromJson`（arch-B2）。
- 【功能二·确认落点纠错】CLI 交互档调父级 `canUseTool`，非手搓 ToolUseConfirm（arch-B3）。
- 【功能二·API 隔离】anthropic/openai 均在 shim 完全接管 URL+鉴权；openai 模型身份分离（protocol-B2 / arch-M3）。
- 【功能二·执行分派】`AgentTool.call` 新增 `execMode` 分支，cliAgentRunner 产 Message 流（feasibility-M2）。
- 【功能二·配置坑】`localSettings` 桶、撞名校验、`mode`→`execMode` 改名、记忆化重启（arch-M1 / feasibility-M3 / arch-m4）。
- 【范围】无头模式列为明确非目标（feasibility-B1，用户确认仅 TUI）。
- 【依赖】lark SDK pin 版本 + Bun 连通性 spike 作为实现第 0 步（feasibility-M1）。
