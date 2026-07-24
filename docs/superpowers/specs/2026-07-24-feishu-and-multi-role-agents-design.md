# 设计规格：飞书确认卡片 + 多角色子 Agent

- 日期：2026-07-24
- 状态：待评审（brainstorming → 多人评审 → writing-plans）
- 项目：claude-code 本地 fork（TypeScript / Bun / Ink TUI / React / Anthropic SDK / MCP）

## 1. 背景与目标

新增两个大功能：

1. **飞书确认卡片**：所有需要用户确认的场景，都以飞书交互式卡片形式推送；用户在卡片上点击按钮完成确认。使用飞书官方 SDK 的**长连接（WebSocket）**接收卡片回调，**不采用 webhook** 形式。
2. **多角色子 Agent**：可在配置中定义多个"角色"（子 Agent），每个角色声明自己的能力（`whenToUse`）与模型/执行配置（API URL、API Token、API 协议、模型名、思考深度），支持 **API 模式** 与 **CLI 模式** 两种。主会话根据角色能力派遣任务。CLI 与 API 模式下，子 Agent 自身产生的确认也必须是交互式的（并按功能一走飞书）。

两个功能共享一处配置扩展。

### 设计取向（重要）

- 本项目为本地单用户 fork。**功能实现优先于安全加固**，安全约束不得成为实现阻碍。
- API Token / 飞书 appSecret 等**直接明文写入配置文件**（settings.json），不做 `env:` 间接引用，不做密钥脱敏机制。与现有 `.env` 明文存 `ANTHROPIC_AUTH_TOKEN` 一致。
- 评审阶段的"安全视角"只审"会不会跑挂 / 协议是否正确 / 逻辑是否自洽"，不提加固类约束。

## 2. 范围

### 首版 In-scope

- 功能一：覆盖所有走 `ToolUseConfirm` 通道的确认（Bash / 文件编辑 / 文件写入 / WebFetch / 计划模式 ExitPlanMode / 多选提问 AskUserQuestion）。
- 功能一：飞书与终端**并存竞速**，谁先响应谁生效，且**双向状态同步**。
- 功能二：`settings.json` 新增 `roles` 数组；API 模式（Anthropic 兼容 + OpenAI 兼容）与 CLI 模式（非交互档 + 交互档）。

### 非目标（首版不做，列为后续增量）

- 启动期独立对话框（信任目录 TrustDialog、MCP 服务器审批、YOLO/Bypass 模式、API key 审批等，走另一套 `showDialog`/`dialogLaunchers` 通道）暂不接入飞书。
- CLI 交互档暂不支持复用 Claude Code SDK 的 stream-json 控制协议（只做自定义 JSON-lines 协议）。
- 每角色的 Bedrock / Vertex / Foundry 云厂商协议（首版只做 anthropic / openai 两种 apiProtocol）。

## 3. 术语

- **确认面 / racer**：能够解决同一个权限 Promise 的一个来源。现有有：本地终端弹窗、Bridge（claude.ai）、Channel 中继（MCP）。本设计新增**飞书**面。
- **竞速器**：`interactiveHandler.ts` 中多个确认面通过 `claim()` + `resolveOnce()` 竞争解决同一个权限请求的机制，第一个响应者胜出。
- **角色 / role**：配置定义的子 Agent，映射到一个 `AgentDefinition`（`agentType`）。

## 4. 现状架构事实（已核实）

功能落点均已在源码中核实：

### 权限/确认（功能一相关）

- 权限入口：`src/hooks/useCanUseTool.tsx` 的 `useCanUseTool(...)` 返回 `CanUseToolFn`；在 `src/screens/REPL.tsx:2382` 装配。外层 `new Promise(resolve => ...)`（`useCanUseTool.tsx:32`）即"等待用户决定"的 Promise。
- 决策：`hasPermissionsToUseTool(...)`（`src/utils/permissions/permissions.ts`）返回 `behavior: 'allow' | 'deny' | 'ask'`。`'ask'` 进入交互流。
- `'ask'` 分支（`useCanUseTool.tsx:93`）依次尝试 `handleCoordinatorPermission` → `handleSwarmWorkerPermission` → 落到 `handleInteractivePermission`。
  - `handleSwarmWorkerPermission` 仅在 `isAgentSwarmsEnabled() && isSwarmWorker()` 时拦截（`swarmWorkerHandler.ts:44`），普通派遣的角色会落到 interactive 面。**据此，子 Agent 的工具确认天然走竞速器。**
- 竞速器：`src/hooks/toolPermission/handlers/interactiveHandler.ts`。已有面：本地终端队列、Bridge（244-298）、Channel 中继（316-408）。每面用 `createResolveOnce`（`src/hooks/toolPermission/PermissionContext.ts:75`）的 `claim()` 原子占用后 `resolveOnce(...)`。
- Channel 面模板：`src/services/mcp/channelPermissions.ts` 的 `ChannelPermissionCallbacks` + `createChannelPermissionCallbacks()`（闭包 `pending` Map + `onResponse(requestId, handler)` + `resolve(requestId, behavior, fromServer)`）。
- 请求/响应类型：`ToolUseConfirm`（`src/components/permissions/PermissionRequest.tsx:103`），含 `onAllow(updatedInput, permissionUpdates, feedback?, contentBlocks?)` / `onReject(feedback?)` / `onAbort()`。决策构造器 `ctx.buildAllow(...)` / `ctx.cancelAndAbort(...)` 在 `PermissionContext.ts`。
- 合成确认请求的现成工具：`src/remote/remotePermissionBridge.ts` 的 `createSyntheticAssistantMessage(request, requestId)` 与 `createToolStub(toolName)`——用于把外部（非本地）工具的权限请求包装成本地 `ToolUseConfirm`。CLI 交互档复用之。
- AppState 面回调槽位模式：`src/state/AppStateStore.ts`（`replBridgePermissionCallbacks?` ~447、`channelPermissionCallbacks?` ~451）；构造点在 `src/services/mcp/useManageMCPConnections.ts:175`，入站解决在 `:544`（`setNotificationHandler(...) => channelPermCallbacksRef.current?.resolve(...)`）。
- 通知通道分发：`src/services/notifier.ts`（`preferredNotifChannel` switch）——一次性通知可扩展，但**确认闭环不走这里**。

### 子 Agent / 派遣（功能二相关）

- 派遣工具：`Agent`（旧名 `Task`），`src/tools/AgentTool/AgentTool.tsx`；输入 schema（`:82`：`description/prompt/subagent_type/model/run_in_background/...`）；`call()`（`:239`）按 `subagent_type` 在 `toolUseContext.options.agentDefinitions.activeAgents` 里查（`:286,338`）。
- Agent 定义 schema：`BaseAgentDefinition`（`src/tools/AgentTool/loadAgentsDir.ts:106`），含 `agentType / whenToUse / tools / disallowedTools / model / effort / permissionMode / maxTurns / background / isolation / getSystemPrompt` 等。JSON 解析：`parseAgentsFromJson`（`loadAgentsDir.ts:521`）、`AgentJsonSchema`（`:73`）。
- 注册表组装：`getAgentDefinitionsWithOverrides(cwd)`（`loadAgentsDir.ts:296`）合并 built-in + plugin + custom，`getActiveAgentsFromList(allAgentsList)`（`:365`）去重得 `activeAgents`。**settings 的 roles 在此并入 `allAgentsList`。**
- 运行循环：`runAgent()`（`src/tools/AgentTool/runAgent.ts:248`）复用共享 `query()`（`src/query.ts` / `src/QueryEngine.ts`）。它把父级 `canUseTool` 透传进 `query()`（`runAgent.ts:252/274/753`）——即子 Agent 确认走父级竞速器。
- 模型解析：`getAgentModel(agentModel, parentModel, toolModel, permissionMode)`（`src/utils/model/agent.ts:37`）→ `agentOptions.mainLoopModel`（`runAgent.ts:678`）。思考深度：`effort?: EffortValue`（`src/utils/effort.ts`），在 `runAgent.ts:481` 覆盖 `state.effortValue`。
- API 客户端：`getAnthropicClient({ apiKey?, maxRetries, model?, fetchOverride?, source? })`（`src/services/api/client.ts:88`，`fetchOverride` 经 `buildFetch(...)` 于 `:139` 接入）。请求处：`src/services/api/claude.ts:546/845/1780`（`withRetry` 内）。**已核实 `fetchOverride` 接缝存在。**
- CLI/无头构建块：`spawnShellTask(...)`（`src/tasks/LocalShellTask/LocalShellTask.tsx:180`，Bash 工具用之，输出流式落文件并捕获）；`src/localRecoveryCli.ts`（自足 headless 客户端）；`src/cli/print.ts`（`--print` SDK 路径，`parseAgentsFromJson(request.agents, ...)` @ `:4382`）。
- 配置：`SettingsSchema`（`src/utils/settings/types.ts:255`，`.passthrough()` @ `:1072`）；源与优先级 `SETTING_SOURCES`（`src/utils/settings/constants.ts`）。

## 5. 功能一详细设计：飞书确认卡片

### 5.1 配置

`settings.json` 新增顶层 `feishu` 块（写显式 zod schema，明文）：

```jsonc
{
  "feishu": {
    "enabled": true,
    "appId": "cli_xxx",
    "appSecret": "xxx",            // 明文
    "receiveIdType": "open_id",    // open_id | chat_id | user_id | union_id | email
    "receiveId": "ou_xxx",         // 接收者（个人或群）
    "cardLanguage": "zh"           // 卡片文案语言，可选，默认 zh
  }
}
```

启用条件：`feishu.enabled === true` 且 appId/appSecret/receiveId 齐全。缺失或连接失败 → 静默禁用飞书面，终端照常（并存的天然降级）。

### 5.2 新增组件与文件

- `src/services/feishu/FeishuClient.ts`
  - 封装 `@larksuiteoapi/node-sdk`：`Client`（发/更新卡片：`im.message.create` / `im.message.patch`）+ `WSClient`（长连接，`eventDispatcher` 注册 `card.action.trigger`）。
  - 方法：`connect()` / `close()`；`sendCard(card): Promise<{ messageId }>`；`updateCard(messageId, card): Promise<void>`；`onCardAction(handler)`（把长连接回调交给上层）。
  - 断线重连（SDK 内建 + 兜底）、退出优雅关闭。
- `src/services/feishu/feishuPermissions.ts`
  - 镜像 `channelPermissions.ts`：`FeishuPermissionCallbacks = { onResponse(requestId, handler): ()=>unsub; resolve(requestId, behavior): boolean }`；`createFeishuPermissionCallbacks()`（闭包 `pending` Map）。
  - `requestId` 直接用 `toolUseID`（飞书无手机端字符限制，不需 `shortRequestId`）。
- `src/services/feishu/cards.ts`
  - 卡片构造：`buildPermissionCard(confirm)` / `buildResolvedCard(confirm, winner, behavior)`（终结态、禁用按钮）；按工具类型映射按钮（见 5.4）。
- AppState 槽位：`feishuPermissionCallbacks?`、`feishuClient?`（`src/state/AppStateStore.ts`，仿 channel）。
- 构造 hook：`src/hooks/useFeishuBridge.tsx`（仿 `useReplBridge` / `useManageMCPConnections`）——会话启动时若启用则构造 client + callbacks，`WSClient` 的 `card.action.trigger` → 解析 `event.action.value.{requestId,behavior/choice}` → `feishuPermissionCallbacks.resolve(...)`；把回调对象与 client 存入 AppState。

### 5.3 竞速注入

在 `interactiveHandler.ts` 复制 Channel 竞速块，新增飞书面：

```
// 伪代码，位于 handleInteractivePermission 内
if (feishuCallbacks && feishuClient) {
  const requestId = params.toolUseID
  const { messageId } = await feishuClient.sendCard(buildPermissionCard(confirm))   // 失败则跳过飞书面
  const unsub = feishuCallbacks.onResponse(requestId, ({ behavior, choice }) => {
    if (!claim()) return
    resolveOnce(behavior === 'allow'
      ? ctx.buildAllow(updatedInputForChoice(choice), { ... })
      : ctx.cancelAndAbort(...))
  })
  registerCleanup(() => unsub())                 // 竞速结束统一清理
  registerResolutionSync((winner, behavior) =>   // 见 5.5
    feishuClient.updateCard(messageId, buildResolvedCard(confirm, winner, behavior)))
}
```

飞书面**不**照搬 Channel 的 `requiresUserInteraction` 短路（`interactiveHandler.ts:319`）——计划模式、多选提问也由飞书接管。

`useCanUseTool.tsx` 注入：仿 `:165-166`，`feishuCallbacks: appState.feishuPermissionCallbacks`、`feishuClient: appState.feishuClient` 传入 `handleInteractivePermission`。

### 5.4 卡片内容与按钮映射

- 展示：工具用户名（`tool.userFacingName`）、`tool.renderToolUseMessage(input)` 摘要、关键目标（命令 / 文件路径 / URL）、会话标识、时间。
- 按钮 → `behavior`（按钮 `value` 内嵌 `{ requestId, behavior, choice? }`）：
  - 普通工具：`允许一次`(allow) / `总是允许`(allow + permissionUpdates) / `拒绝`(deny)。
  - 计划模式（ExitPlanMode）：`批准计划`(allow) / `继续完善`(deny)。
  - 多选提问（AskUserQuestion）：每个选项一个按钮，`value.choice` 标识所选；多选题渲染多个可选按钮 + 一个提交。→ 映射回该工具期望的 `updatedInput`。
- 卡片语言按 `feishu.cardLanguage`。

### 5.5 双向状态一致性（头等约束）

无论哪一面先生效，**都要同步另一面**，保持状态一致：

- 机制：在竞速器唯一胜出点（`resolveOnce` 实际触发时）广播一次 `syncResolution(winner, behavior)`；每个面注册一个"自我更新"回调（`registerResolutionSync`）与一个"清理"回调（`registerCleanup`）。胜出后：先 `claim()` 定胜负 → `resolveOnce()` → 触发所有 `resolutionSync` + `cleanup`（幂等）。
- 具体：
  - **终端先生效** → patch 飞书卡片为终结态：禁用全部按钮 + 显示 `✅ 已允许（终端）` / `❌ 已拒绝（终端）`。
  - **飞书先生效** → 终端出队该确认项（现有 `onDone` → `setToolUseConfirmQueue` tail）+ 提示 `已由飞书确认（@接收者）`。
  - **中止 / 会话结束 / 超时** → 卡片 patch 为 `⏹ 已取消 / 已过期`，终端同样清理。
- 健壮性：卡片 patch 为 best-effort，网络失败只 `logError` 不影响主流程；`updateCard` 需要 5.2 中 `sendCard` 返回的 `messageId`。重复事件（用户重复点/网络重发）由 `pending` Map 删除即幂等（仿 `channelPermissions.ts:resolve`）。

### 5.6 生命周期

- 连接：会话启动、`feishu.enabled` 时 `FeishuClient.connect()`；失败重试并降级（终端仍可用）。
- 运行：长连接常驻，`card.action.trigger` 事件驱动 `resolve`。
- 关闭：进程退出 / 会话结束时 `close()`；未决卡片按 5.5 标记过期。

## 6. 功能二详细设计：多角色子 Agent

### 6.1 配置

`settings.json` 新增顶层 `roles` 数组（显式 zod schema）：

```jsonc
{
  "roles": [
    {
      "name": "reviewer",                 // → agentType（派遣键，唯一）
      "whenToUse": "需要独立代码安全审查时派遣",   // 主会话据此按能力派遣
      "mode": "api",                       // "api" | "cli"
      "tools": ["Read", "Grep"],          // 能力边界，可选；缺省继承默认
      "prompt": "你是资深安全审查员……",     // 系统提示（可选）

      // —— mode: "api" ——
      "apiProtocol": "openai",             // "anthropic" | "openai"
      "apiUrl": "https://api.example.com/v1",
      "apiToken": "sk-xxx",                // 明文
      "model": "gpt-4o",
      "thinkingDepth": "high",             // → EffortValue：low|medium|high|... （可选）

      // —— mode: "cli" ——
      "command": "codex",
      "args": ["exec", "--json"],          // 静态参数
      "interactive": true,                 // true=JSON-lines 交互档；false=单次 stdin→stdout
      "cwd": "."                            // 可选
    }
  ]
}
```

### 6.2 注册与派遣

- 新增 `src/tools/AgentTool/rolesFromSettings.ts`：读取 `settings.roles`，用 `parseAgentsFromJson` 变体解析为 `AgentDefinition[]`（source 用对应 settings 源），CLI/API 专属字段挂到扩展后的 `BaseAgentDefinition`。
- 在 `getAgentDefinitionsWithOverrides`（`loadAgentsDir.ts:296`）把 roles 并入 `allAgentsList`（在 `getActiveAgentsFromList` 之前），沿用去重与优先级。
- 主会话派遣：无需改 `AgentTool.call` 的选择逻辑——`whenToUse` 注入工具 prompt，模型按 `subagent_type` 匹配到角色即可。
- `BaseAgentDefinition` 扩展字段：`mode?: 'api'|'cli'`、`apiProtocol?`、`apiUrl?`、`apiToken?`、`command?`、`args?`、`interactive?`、`roleCwd?`（`thinkingDepth`→复用已有 `effort`；`model` 已有）。

### 6.3 API 模式

- 复用 `query()` 引擎，仅替换每角色的客户端配置。**每角色 `fetchOverride` 翻译垫片**（复用 `getAnthropicClient({ fetchOverride, apiKey })`）：
  - `apiProtocol: 'anthropic'`：垫片把出站请求重定向到 `apiUrl` 并注入 `apiToken`（覆盖全局 env 的 base URL/token，实现每角色隔离）。
  - `apiProtocol: 'openai'`：垫片拦截引擎产出的 Anthropic 格式请求体 → 翻译为 `/v1/chat/completions`（含 system/messages/tools/tool_choice 映射）→ 调用 `apiUrl` → 把响应（**含 SSE 流式增量、工具调用 tool_calls**）**翻译回 Anthropic messages 流格式**。查询循环、工具执行、权限流零改动。
  - 翻译实现放在 `src/services/api/openaiCompat/`（`toOpenAIRequest.ts` 请求映射 / `fromOpenAIStream.ts` 响应流翻译）。
- 模型/思考深度：`model`→`getAgentModel`→`mainLoopModel`；`thinkingDepth`→`effort` 覆盖（`runAgent.ts:481`）。
- 客户端配置下传：把"每角色 client 配置"（apiUrl/apiToken/apiProtocol）从 `runAgent` 的 `agentOptions`（`runAgent.ts:667`）经 `toolUseContext.options` 新增字段串到 `claude.ts` 的 `getAnthropicClient(...)` 调用处，构造带垫片的角色专属 client。**这是 API 模式的主要实现风险点**（触及请求路径），由 TDD 覆盖。
- 子 Agent 内部工具确认：天然走父级 `canUseTool` → 竞速器 → 终端 + 飞书（已核实）。

### 6.4 CLI 模式

两档，由角色 `interactive` 字段区分：

- **非交互档（`interactive: false`）**：`command args...`，task prompt 经 **stdin** 传入，进程 **stdout** 整体作为该子 Agent 的执行结果（单次非交互）。用 `spawnShellTask` 捕获输出、纳入任务体系。
- **交互档（`interactive: true`）**：**自定义 JSON-lines 控制协议**（见 6.5）。收到 `permission_request` → 复用 `createSyntheticAssistantMessage`/`createToolStub`（`remotePermissionBridge.ts`）合成 `ToolUseConfirm` → 跑同一竞速器（终端 + 飞书）→ 决定写回子进程 stdin。本质是给子进程做一个"本地权限桥"，与远程权限桥同构。
- 新增 `src/tools/AgentTool/cliAgentRunner.ts`：spawn 子进程、按档位处理 IO、把结果/进度作为 agent 消息 yield 回主会话（对齐 `runAgent` 的产出契约，以便 `AgentTool.call` 取最终文本作为 tool_result）。

### 6.5 CLI 交互档：JSON-lines 控制协议

- 主 → 子（写入子进程 stdin，每行一个 JSON）：
  - `{"type":"task","prompt":"...","context":{...}}`（任务下发）
  - `{"type":"permission_response","id":"...","behavior":"allow"|"deny","updatedInput":{...}?}`
- 子 → 主（子进程 stdout，每行一个 JSON）：
  - `{"type":"log","message":"..."}` → 进度（并入 transcript）
  - `{"type":"permission_request","id":"...","tool":"...","input":{...},"description":"..."}` → 请求确认
  - `{"type":"result","content":"..."}` → 最终结果（终止）
  - `{"type":"error","message":"..."}`
- 约定：行分隔、UTF-8；未识别类型忽略并告警；子进程退出而未发 `result` 视为错误。
- 与竞速器对接：`permission_request` → 合成 `ToolUseConfirm`（`tool` 用 `createToolStub`，`input` 原样）→ interactive 竞速 → 决定回 `permission_response`。该确认同样受 5.5 双向同步覆盖（飞书 + 终端）。

## 7. 横切关注

- 配置加载/校验：为 `feishu` 与 `roles` 写显式 zod schema（叠在 `.passthrough()` 之上），启动时校验，错误信息清晰（指出哪个角色/字段）。
- 错误处理：飞书发送/patch、CLI spawn、OpenAI 翻译均 best-effort + `logError`，不使主流程崩溃；飞书面失败不影响终端确认。
- 日志：按项目取向不做 token 脱敏；正常调试日志即可。
- 依赖：新增 `@larksuiteoapi/node-sdk`。OpenAI 翻译用现有 `undici`/`fetch`，不引 openai SDK（保持轻量、可控）。

## 8. 测试策略

- 单元测试：
  - `feishuPermissions`：`onResponse`/`resolve`/幂等/未知 id。
  - `cards`：各工具类型按钮映射、terminal 态卡片。
  - OpenAI 翻译：请求映射（system/messages/tools）、SSE 流→Anthropic 流、tool_calls 往返。
  - JSON-lines 协议：解析、分帧、错误分支。
  - 竞速 + 双向同步：终端先胜/飞书先胜/中止 三条路径，断言另一面被同步且仅一次生效。
- 集成测试：mock 飞书 `WSClient`（注入 `card.action.trigger`）、mock 子进程 CLI（脚本按协议吐 JSON）、mock OpenAI 端点。
- 端到端手测：真实飞书应用（长连接）+ 一个 API 角色（OpenAI 兼容）+ 一个 CLI 交互角色，跑通"派遣→子 Agent 请求确认→飞书点按→结果回主会话"，并验证终端/飞书先胜两种同步。

## 9. 未决 / 风险

- API 模式每角色 client 下传触及 `claude.ts` 请求路径，为最大实现风险；优先用 TDD 锁定行为。
- OpenAI ↔ Anthropic 流式 + 工具调用翻译细节较多（stop_reason、增量拼接、并发 tool_use），需专项测试。
- 飞书应用需开通"卡片回传交互"能力并配置长连接事件订阅（`card.action.trigger`）——属应用侧配置，文档说明。
- 计划模式/多选提问的卡片交互语义需与终端组件行为对齐（`updatedInput` 构造）。

## 10. 评审与验收计划

1. 落规格（本文）并提交 git。
2. **多人对抗式设计评审**：派遣多个独立 agent（架构自洽 / 协议正确性（飞书长连接、OpenAI 翻译、JSON-lines）/ 可行性与落点准确性 三视角；安全视角仅看"跑挂/协议错"，不提加固）。汇总问题 → 迭代规格。
3. 用户终审规格。
4. `writing-plans` 出实现计划 → TDD 实现。
5. 充分测试后，**派遣多个验收 agent** 逐条对照本规格与原始需求验收；有问题持续迭代直到满足。
