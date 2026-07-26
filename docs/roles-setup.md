# 多角色子 Agent 配置指南

本项目支持在 `settings.json` 中配置多个自定义角色（roles），每个角色可作为一个独立的可派遣子 Agent。主会话可根据任务需要，按角色的 `whenToUse` 能力描述选择合适的角色来处理特定工作。

---

## 快速概览

`roles` 是 `settings.json` 中的一个**数组配置**，支持三个层级：
- **用户设置**：`~/.claude/settings.json`
- **项目设置**：`<repo>/.claude/settings.json`
- **本地设置**：`<repo>/.claude/settings.local.json`

配置的角色会自动注册为可派遣的子 Agent 类型。主会话在分派时会检查角色名称是否与内置 Agent 类型冲突；**冲突的角色会被忽略并输出警告**。

---

## 核心概念

### 角色字段说明

每个角色是一个 JSON 对象，包含以下字段：

| 字段 | 必填 | 类型 | 说明 |
|-----|------|------|------|
| `name` | 是 | `string` | 角色的唯一标识符。用于主会话派遣时调用此角色。**不得与内置 Agent 类型重名**（如 `general-purpose`、`Explore`、`Plan` 等），否则会被丢弃并输出警告 |
| `whenToUse` | 是 | `string` | 角色的能力描述。主会话根据此描述判断何时使用该角色。例如：`"用于图像分析和 OCR 任务"` 或 `"后端 API 测试和集成"` |
| `execMode` | 是 | `string` | 执行模式，可选值：`'api'` \| `'cli'`。决定角色如何运行 |
| `tools` | 否 | `string[]` | 该角色可用的工具列表。如果未指定，则继承主会话的工具列表 |
| `prompt` | 否 | `string` | 该角色的系统 prompt。如果未指定，则为空字符串 |
| `efftaskRoles` | 否 | `string[]` | 该角色在 `/et`（高效任务模式）里担任哪些**任务角色**。见下文「用于 /et 的任务角色」 |

> **注意**：角色对象是**严格校验**的——写入任何上表之外的字段，会导致**整条角色被跳过**（表现为「这个角色不存在」），而不只是该字段失效。填错时终端会输出一行 `[roles] "<名字>" from <来源> skipped: <原因>`。

### 用于 /et 的任务角色（efftaskRoles）

`/et`（高效任务模式）把一次需求拆成任务树，每个节点走**方案 → 评审 → 执行 → 验收 → 观察**五个阶段。在那里要区分两个概念：

- **员工** = 上面配的这些角色（一个可派遣的身份，自带模型和工具）。
- **任务角色** = 任务里的一个职能，比如「架构师」「安全」。它说明：在哪个阶段用、产出什么、起什么作用、由哪些员工担当。

两者是**多对多**：一个员工可以担任多个任务角色，一个任务角色可以由多个员工担任（他们进同一场圆桌评审，收敛成**一个**结论）。

任务角色配在 `settings.json` **顶层**的 `efftaskRoles` 里。前四个字段缺一不可，缺任何一项该角色**不生效**，并在 `/et` 的启动关口上说明原因：

| 字段 | 必填 | 说明 |
|-----|------|------|
| `name` | 是 | 任务角色名，任意取（「架构师」「安全」「前端」） |
| `stage` | 是 | 在哪个阶段用。**只能是** `plan` / `review` / `execute` / `accept` / `observer` 之一 |
| `output` | 是 | 产出什么 |
| `purpose` | 是 | 起什么作用 |
| `staff` | 否 | 由哪些员工担当（员工名数组）。**省略 = 由当前主模型兼任** |

```jsonc
{
  "roles": [
    { "name": "opus-架构", "whenToUse": "架构评审", "execMode": "api",
      "apiUrl": "https://api.anthropic.com", "apiToken": "sk-ant-xxx", "model": "claude-opus-4-8",
      "efftaskRoles": ["架构师"] }        // 员工侧：我能当「架构师」
  ],
  "efftaskRoles": [                        // 任务角色侧
    { "name": "架构师", "stage": "review",
      "output": "通过/阻断裁决与具体阻断项", "purpose": "把关可维护性与回滚路径",
      "staff": ["opus-架构", "ds-架构"] }, // 一个角色两个员工 → 两席，同一场圆桌
    { "name": "验收官", "stage": "accept",
      "output": "验收裁决", "purpose": "逐条核对验收点" }   // 无 staff → 主模型兼任
  ]
}
```

两侧都写同一个角色时员工取**并集**，并在关口上说明。

**几条容易踩的**：

- `stage` 只能是那五个之一。写 `"评审"` 或 `"reviews"` 都不生效——流水线的状态机是围绕那五个阶段建的，自由阶段名没有任何地方会去跑它。
- `plan` / `execute` / `observer` 每个阶段**只跑一个** agent。在这些阶段配多个员工或多个角色，只有第一个生效，关口会点名被忽略的是谁。只有 `review` / `accept` 会开圆桌。
- `staff` 里写了找不到的员工名 → 该角色改由主模型兼任，关口会说明。这和「没写 staff」是两回事：前者是你的意图没被满足。
- `execMode: 'cli'` 的员工目前 `/et` 派发不了，会被剔除并说明。
- 任务提示词里也可以定义或覆盖任务角色（「评审加一个安全角色，由 ds-安全 担当，负责找注入和越权」）：产出/作用以提示词为准，员工取并集。

### 执行模式（execMode）

#### `api` 模式

角色通过 HTTP API 调用第三方 LLM 服务进行推理。需要配置 API 连接参数。

**额外必需字段：**
- `apiProtocol`：API 协议类型（`'anthropic'` \| `'openai'`）
- `apiUrl`：API 端点 URL
- `apiToken`：API 认证令牌（明文存储；生产环境建议使用环境变量）
- `model`：使用的模型标识符

**可选字段：**
- `thinkingDepth`：思考深度（仅 Anthropic 协议支持）。可选值：`'low'` \| `'medium'` \| `'high'` \| `'max'` 或一个数字。无效值会被忽略

#### `cli` 模式

角色通过执行本地命令行工具运行。支持两个执行档次。

**必需字段：**
- `command`：要执行的命令路径或名称

**可选字段：**
- `args`：传递给命令的参数列表
- `interactive`：是否使用交互模式（`true` \| `false`，默认 `false`）
- `cwd`：命令的工作目录

---

## API 模式（execMode: 'api'）

### 协议类型

#### Anthropic 协议

用于接入 Anthropic 官方 API 或兼容的第三方服务（如 MiniMax、OpenRouter 等）。

**配置示例：**

```json
{
  "roles": [
    {
      "name": "image-analyzer",
      "whenToUse": "图像识别与 OCR 分析",
      "execMode": "api",
      "apiProtocol": "anthropic",
      "apiUrl": "https://api.minimaxi.com/anthropic",
      "apiToken": "sk-minimax-your-api-key-here",
      "model": "gpt-4o",
      "thinkingDepth": "high",
      "tools": ["screenshot", "file_read"],
      "prompt": "你是一个专业的图像分析助手，擅长 OCR 和视觉理解。"
    }
  ]
}
```

**说明：**
- `apiUrl` 可以是 Anthropic 官方地址（`https://api.anthropic.com`）或任何兼容的第三方服务
- `model` 由服务提供商指定；MiniMax 使用 `gpt-4o`，Anthropic 官方使用 `claude-3-5-sonnet-20241022` 等
- `thinkingDepth` 值（如 `'high'` 或 `'max'`）会映射到 Anthropic API 的 `output_config.effort` 参数
- 无效的 `thinkingDepth` 值（如 `'deep'`、大小写错误等）会被忽略，不会发送到 API

#### OpenAI 协议

用于接入 OpenAI 官方 API 或兼容的第三方 OpenAI 格式服务。

**配置示例：**

```json
{
  "roles": [
    {
      "name": "code-reviewer",
      "whenToUse": "代码审查与质量分析",
      "execMode": "api",
      "apiProtocol": "openai",
      "apiUrl": "https://api.openai.com/v1",
      "apiToken": "sk-proj-your-openai-key-here",
      "model": "gpt-4o",
      "tools": ["bash", "grep"]
    }
  ]
}
```

**说明：**
- `apiUrl` 通常以 `/v1` 结尾（即 OpenAI 的 `/v1/chat/completions` 端点基础 URL）
- `model` 对应 OpenAI 模型如 `gpt-4o`、`gpt-4-turbo` 等
- **协议翻译**：子 Agent 发出的请求会自动从 Anthropic 格式转译为 OpenAI 格式，响应也会自动转译回来，所以主会话的 Message 流透明一致

### 工具确认与权限流

当 API 模式的角色请求使用工具时：

1. 子 Agent（via OpenAI 协议）的工具调用请求被 shim 层翻译成标准消息格式
2. 主会话的权限确认系统（`canUseTool` 钩子）捕获该请求
3. 确认对话同时发送到：
   - **终端**：标准权限提示（需用户键入确认）
   - **飞书**（如已配置 Plan A）：交互卡片（用户点击确认）
4. 先响应者的结果生效，后响应者的响应被忽略
5. 权限决策（允许/拒绝）返回给子 Agent，由子 Agent 继续执行或停止

---

## CLI 模式（execMode: 'cli'）

CLI 模式支持两个执行档次，适应不同的集成需求。

### 非交互档（Interactive: false 或省略）

**用于单次任务执行**。主会话将任务 prompt 通过 stdin 传给命令，命令的整个 stdout 输出作为执行结果返回给主会话。

**特点：**
- 不需要实现协议；任何现有 CLI 工具都可直接包装
- 任务 prompt 通过 stdin 传入，工具可读取并处理
- 全部 stdout 被采集作为结果，stderr 被视为诊断日志
- 简单、轻量，适合脚本、单次分析等

**配置示例：**

```json
{
  "roles": [
    {
      "name": "markdown-formatter",
      "whenToUse": "Markdown 文档格式化与美化",
      "execMode": "cli",
      "command": "npx",
      "args": ["prettier", "--parser", "markdown"],
      "cwd": "/path/to/project"
    }
  ]
}
```

**使用流程：**
1. 主会话准备 prompt（如 `"请格式化这个 Markdown：..."`）
2. 主会话将 prompt 通过 stdin 写入子命令
3. 子命令处理并输出结果到 stdout
4. 主会话读取 stdout，作为 CLI 子 Agent 的执行结果

### 交互档（Interactive: true）

**用于需要权限确认的 CLI 工具**。子命令实现 JSON-lines 控制协议，可以在执行中请求权限确认，并根据主会话的响应继续执行。

#### JSON-lines 协议规范

协议基于行分隔的 JSON 对象，严格区分 stdout（协议）和 stderr（日志）：

##### 从主→子（stdin，一行一个 JSON 对象）

**`task` 消息（启动任务）：**
```json
{"type":"task","prompt":"用户的任务提示文本"}
```
- 在任务开始时由主会话发送一次，告知子命令要执行的任务

**`permission_response` 消息（权限决策）：**
```json
{"type":"permission_response","id":"tool-use-id-123","behavior":"allow","updatedInput":{"param":"value"},"feedback":"optional explanation"}
```
- `id`：必需，对应权限请求的 ID
- `behavior`：必需，`"allow"` 或 `"deny"`
- `updatedInput`：可选，当 `behavior` 为 `"allow"` 时可包含用户审定后的输入参数
- `feedback`：可选，当 `behavior` 为 `"deny"` 或其他情况时，解释决策原因

##### 从子→主（stdout，一行一个 JSON 对象；stderr 用于日志）

**`permission_request` 消息（请求权限）：**
```json
{"type":"permission_request","id":"tool-use-id-123","tool":"tool_name","input":{"param1":"value1"}}
```
- `id`：必需，此请求的唯一标识（UUID 推荐），用于匹配后续的 `permission_response`
- `tool`：必需，工具名称
- `input`：必需或可为空对象，工具的输入参数

主会话接收此消息后，会：
1. 弹出权限确认对话（终端 + 飞书 竞速）
2. 获得用户的允许/拒绝决策
3. 构造 `permission_response` 写回子命令的 stdin

**`result` 消息（任务完成）：**
```json
{"type":"result","content":"这是最终的任务结果文本"}
```
- 在任务完成时由子命令发送，将最终结果返回给主会话
- `content` 必需，可以是字符串或其他 JSON 类型（会被转换为字符串）
- 该消息标志任务结束，主会话会关闭此子 Agent 会话

**`error` 消息（任务出错）：**
```json
{"type":"error","message":"详细的错误信息"}
```
- 可选，用于报告子命令执行中的错误
- `message` 必需
- 不会立即终止任务，子命令仍可继续执行或最后发送 `result`

##### 日志与输出隔离

- **stdout**：仅用于协议消息（JSON 对象，一行一个）
- **stderr**：用于诊断日志、调试信息等。这些内容会被采集并通过主会话的日志系统输出
- 子命令**不应将 JSON 对象以外的内容写入 stdout**，以免破坏协议

#### 配置示例

```json
{
  "roles": [
    {
      "name": "secure-data-processor",
      "whenToUse": "处理敏感数据，需要权限确认",
      "execMode": "cli",
      "command": "/usr/local/bin/secure-processor",
      "args": ["--mode", "interactive"],
      "interactive": true,
      "cwd": "/data/secure"
    }
  ]
}
```

#### 实现适配器的最小例子

以下是一个最小的 Node.js 适配器脚本示例，演示如何实现交互协议：

```javascript
// adapter.js
import { randomUUID } from 'crypto'

async function main() {
  const readline = require('readline')
  const rl = readline.createInterface({ input: process.stdin })

  let prompt = ''
  let taskStarted = false

  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line)
      
      if (msg.type === 'task') {
        prompt = msg.prompt
        taskStarted = true
        
        // 示例：立即请求权限使用一个工具
        const reqId = randomUUID()
        console.log(JSON.stringify({
          type: 'permission_request',
          id: reqId,
          tool: 'read_file',
          input: { path: '/etc/passwd' }
        }))
        
        // 等待权限响应（继续通过 rl.on('line') 接收）
        return
      }
      
      if (msg.type === 'permission_response') {
        if (msg.behavior === 'allow') {
          // 模拟工具执行结果
          const result = `File content: ${JSON.stringify(msg.updatedInput)}`
          console.log(JSON.stringify({
            type: 'result',
            content: `Successfully processed: ${result}`
          }))
        } else {
          console.log(JSON.stringify({
            type: 'result',
            content: `Permission denied: ${msg.feedback || 'no reason given'}`
          }))
        }
        
        rl.close()
      }
    } catch (e) {
      console.error(`[adapter] error: ${e.message}`)
      process.stderr.write(`Adapter error: ${e}\n`)
    }
  })
}

main()
```

**关键点：**
- 协议对象必须输出到 stdout，每行一个完整的 JSON 对象
- 日志、诊断信息必须输出到 stderr
- 子命令应使用 UUID 或其他唯一 ID 标识每个权限请求
- 接收 `permission_response` 后，子命令根据 `behavior` 字段决定继续还是中止
- 最后发送 `result` 或 `error` 消息，标志任务结束

#### 权限确认流程

当交互 CLI 角色发送 `permission_request` 时：

1. 主会话解析 JSON 对象
2. 构造权限确认对话，同时发送到：
   - **终端**：`"允许工具 read_file 读取 /etc/passwd？(yes/no)"`
   - **飞书**：交互卡片，显示相同的确认
3. 用户在终端或飞书卡片上响应（哪个先响应即采用）
4. 主会话构造 `permission_response` 写回子命令 stdin
5. 子命令根据 `behavior` 继续处理

---

## 配置示例：完整场景

### 场景 1：混合角色配置

```json
{
  "roles": [
    {
      "name": "anthropic-researcher",
      "whenToUse": "深度研究与分析，使用 Anthropic 强大的 reasoning 能力",
      "execMode": "api",
      "apiProtocol": "anthropic",
      "apiUrl": "https://api.anthropic.com",
      "apiToken": "sk-ant-your-key-here",
      "model": "claude-3-5-sonnet-20241022",
      "thinkingDepth": "max",
      "tools": ["web_search", "file_read", "bash"],
      "prompt": "你是一个专业的研究分析师，需要深入思考并给出准确结论。"
    },
    {
      "name": "openai-fast",
      "whenToUse": "快速任务和日常问答，低成本模型",
      "execMode": "api",
      "apiProtocol": "openai",
      "apiUrl": "https://api.openai.com/v1",
      "apiToken": "sk-proj-your-openai-key",
      "model": "gpt-4o-mini",
      "tools": ["bash"]
    },
    {
      "name": "local-formatter",
      "whenToUse": "本地代码格式化和 linting",
      "execMode": "cli",
      "command": "npx",
      "args": ["prettier", "--stdin-filepath", "code.js"],
      "cwd": "/home/user/project"
    },
    {
      "name": "security-auditor",
      "whenToUse": "安全审计，需要权限确认敏感操作",
      "execMode": "cli",
      "command": "/opt/bin/audit-tool",
      "interactive": true,
      "args": ["--strict"],
      "cwd": "/secure/audit"
    }
  ]
}
```

### 场景 2：环境变量保护 API Token

对于生产环境，建议将敏感信息（如 API Key）存储在环境变量中，而不是明文放在配置文件里。

```json
{
  "roles": [
    {
      "name": "gpt4-api",
      "whenToUse": "使用 GPT-4 进行复杂推理",
      "execMode": "api",
      "apiProtocol": "openai",
      "apiUrl": "https://api.openai.com/v1",
      "apiToken": "${OPENAI_API_KEY}",
      "model": "gpt-4o"
    }
  ]
}
```

> **注意**：当前版本中 `${OPENAI_API_KEY}` 形式的占位符需要在加载前手动替换，或者在代码层支持环境变量展开。建议在项目的启动脚本中处理这个替换。

---

## 角色名称冲突处理

如果 `roles` 配置中的某个 `name` 与内置 Agent 类型名称冲突（如 `general-purpose`、`Explore`、`Plan` 等），该角色会被**忽略**，并直接在终端输出一行警告（无需 `--debug`）：

```
[roles] "general-purpose" collides with built-in agent; ignored
```

**避免冲突的方式：**
- 使用描述性的角色名，如 `gpt4-researcher`、`local-script-runner` 等
- 启动时留意终端输出的 `[roles] ...` 警告行

---

## 已知限制与后续计划

### 当前限制

1. **CLI 角色的进程生命周期**：
   - 中止（ESC / abort）已实现：主会话中止任务时，会通过 `toolUseContext.abortController.signal` 对 CLI 子进程做 tree-kill（整个进程树），不会留下孤儿进程
   - 尚未实现的是**配置化的空闲/结果超时**：如果子进程既不中止也不产出 `result`/`error` 消息，目前没有固定超时会主动杀掉它（有意如此，避免误杀长时间运行的合法任务）；这是后续计划中的增强项
   - 前台转后台（`ctrl+b` 等）会重新派发 CLI 角色的会话，而不是接续原会话——即前台运行中的 CLI 子进程会被结束，重新转入后台时是**重启**而非**恢复**（无会话续接）

2. **API Token 明文存储**：
   - 配置文件中的 `apiToken` 目前以明文存储
   - 生产环境建议使用操作系统密钥管理或环境变量

3. **错误恢复**：
   - CLI 子进程 stdout 解析失败时，协议会记录错误但继续处理后续消息
   - 格式严重破坏的协议消息可能导致子进程挂起

### 规划中的增强

- [ ] 配置化的空闲/结果超时（abort 时的 tree-kill 已实现，见上）
- [ ] 环境变量展开（`${VAR_NAME}` 形式）
- [ ] 角色热重载（无需重启主会话）
- [ ] 角色预制模板库
- [ ] 更详细的权限审计日志

---

## 快速排查

### 角色未被识别

**症状**：派遣一个角色时提示角色不存在或被忽略。

**检查清单：**
1. 确认 `settings.json` 的 `roles` 数组格式正确（检查 JSON 语法）
2. 确认角色 `name` 字段存在且不为空
3. 检查角色名是否与内置 Agent 类型冲突（终端启动时会直接打印 `[roles] ...` 警告，无需 `--debug`）
4. 对于 API 角色，确认 `apiProtocol`、`apiUrl`、`apiToken`、`model` 都已配置
5. 对于 CLI 角色，确认 `command` 字段已配置且可执行

### API 模式连接失败

**症状**：派遣 API 角色后收到网络错误或认证错误。

**检查清单：**
1. 确认 `apiUrl` 正确且服务在线
2. 确认 `apiToken` 有效且未过期
3. 检查网络连接和代理设置
4. 查看主会话日志中的详细错误信息

### CLI 模式无响应

**症状**：派遣 CLI 角色后子进程执行但无法返回结果。

**检查清单：**
1. 非交互模式：确认命令的 stdout 输出正确，stderr 无误
2. 交互模式：
   - 确认子命令实现了 JSON-lines 协议
   - 检查 stdout 是否混入了非协议输出（如普通日志）
   - 在 stderr 中查找诊断信息
   - 确认子命令正确接收和解析 stdin 的 JSON 消息
3. 检查 `cwd` 目录是否存在且路径正确

### 权限确认未收到

**症状**：CLI 交互角色发送 `permission_request` 后，未收到终端或飞书的确认提示。

**检查清单：**
1. 终端模式：确认终端窗口处于活跃状态，未被其他输出阻挡
2. 飞书模式（如已配置）：
   - 确认飞书配置启用且完整（见 [飞书卡片确认集成指南](./feishu-setup.md)）
   - 检查机器人是否已添加到接收方群组或 open_id 配置正确
   - 查看飞书应用日志是否有权限错误

---

## 参考资源

- 源码实现：
  - 角色配置解析：`src/tools/AgentTool/roles/rolesFromSettings.ts`
  - API 模式执行：`src/tools/AgentTool/AgentTool.call` → `runAgent`
  - CLI 模式执行：`src/tools/AgentTool/cliAgentRunner.ts`
  - 协议定义：参见本文档中的"JSON-lines 协议规范"一节
- 配置指南：
  - [飞书卡片确认集成指南](./feishu-setup.md)
  - [主项目 README](../README.md)
