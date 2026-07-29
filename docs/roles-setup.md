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

> **注意**：角色对象是**严格校验**的——写入任何上表之外的字段，会导致**整条角色被跳过**（表现为「这个角色不存在」），而不只是该字段失效。填错时原因会显示在 `/et` 启动关口的「你的请求中有以下部分不会生效」那一块里（非交互 `--print` 模式下才走终端）。

### 用于 /et 的任务角色（efftaskRoles）

`/et`（高效任务模式）把一次需求拆成任务树。每个节点先被定为**拆分型**或**执行型**两种任务形态之一，再按形态走一串**环节**：

- **拆分型**：分析 → 质疑讨论 →（等全部子任务完成）→ **集成验收** → 观察
- **执行型**：分析 → 质疑讨论 → 执行 → 测试验证 → 验收 → 观察 →（自动合并进集成分支）

> 集成验收**不做合并**——合并早在每个执行型节点自己通过验收时就发生了。它判的是「子任务的结果合起来达没达成父目标」，所以必须等全部子任务完成。它只对拆分型节点生效。

环节的顺序是固定的。**没配角色的环节不是不发生**——分析／质疑讨论／执行／验收会照跑，只是由当前主模型一个人干；集成验收会回落到验收席位；只有测试验证和观察是 opt-in，不配就整个不发生。

要让某一步**真的不发生**，用下面的「跳过环节」。关口会把每个环节到底是谁在干、或者为什么不干，逐行写出来。

**自由的是角色，固定的是环节。** 你可以定义任意多个角色、任意取名、指定任意员工担当、写任意的产出与作用——一个环节里可以同时有多个角色开圆桌。不自由的只有一件事：这个角色挂在**哪个环节**上。环节是流水线状态机的骨架，它决定这一席什么时候被调用、能不能拿到写工具、`--resume` 之后还在不在。加一个新环节 = 改状态机，不是改配置。

这个环节列表**会随版本增长**——这一版就从 5 个长到了 7 个（新增「测试验证」「集成验收」）。在配置里写一个不存在的环节名会被明确拒绝并告诉你合法值，而不是静默丢弃。

还要区分两个概念：

- **员工** = 上面配的这些角色（一个可派遣的身份，自带模型和工具）。
- **任务角色** = 任务里的一个职能，比如「架构师」「安全」。它说明：在哪个阶段用、产出什么、起什么作用、由哪些员工担当。

两者是**多对多**：一个员工可以担任多个任务角色，一个任务角色可以由多个员工担任（他们进同一场圆桌评审，收敛成**一个**结论）。

任务角色配在 `settings.json` **顶层**的 `efftaskRoles` 里。前四个字段缺一不可，缺任何一项该角色**不生效**，并在 `/et` 的启动关口上说明原因：

| 字段 | 必填 | 说明 |
|-----|------|------|
| `name` | 是 | 任务角色名，任意取（「架构师」「安全」「前端」） |
| `step` | 是 | 在哪个**环节**用。只能是 `分析` / `质疑讨论` / `执行` / `测试验证` / `验收` / `集成验收` / `观察` 之一（也接受对应的英文内部名）。旧键名 `stage` 仍然读得进来 |
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
    { "name": "架构师", "step": "质疑讨论",
      "output": "通过/阻断裁决与具体阻断项", "purpose": "把关可维护性与回滚路径",
      "staff": ["opus-架构", "ds-架构"] }, // 一个角色两个员工 → 两席，同一场圆桌
    { "name": "验收官", "step": "验收",
      "output": "验收裁决", "purpose": "逐条核对验收点" }   // 无 staff → 主模型兼任
  ]
}
```

两侧都写同一个角色时员工取**并集**，并在关口上说明。

**几条容易踩的**：

- `step` 只能是那七个之一。**中文名就是合法写法**（`"质疑讨论"`）；写 `"reviews"` 这类不存在的名字不生效，关口会列出合法值并猜一个最接近的（写「测试」会提示「是不是想写『测试验证』」）。
- 每个环节怎么容纳多个员工，是不一样的：
  - **质疑讨论 / 测试验证 / 验收 / 集成验收** —— 圆桌：各自独立出裁决，再按通过门槛合成**一个**结论。
  - **分析** —— 两种收敛法，用 `caps.planConverge` 选：`"精化"`（默认，第一位起草、后面每一位在前一稿上改，全程一份稿子）或 `"圆桌"`（各自独立起草，再由**最后一席**融合成一份最优解，落选稿存进 node.md 的「备选方案」段不丢）。只有一个员工时两者完全相同。
  - **观察** —— 各自打分，取**最低分**作为结论，其余人的理由一条不丢地记在旁边。
  - **执行** —— 只能一个员工。这是物理约束不是策略：节点的工作区路径不含员工维度，两个员工会拿到同一个目录。配多了只有第一个生效，关口会点名被忽略的是谁。
- `staff` 里写了找不到的员工名 → 该角色改由主模型兼任，关口会说明。这和「没写 staff」是两回事：前者是你的意图没被满足。
- `execMode: 'cli'` 的员工目前 `/et` 派发不了，会被剔除并说明。
- 任务提示词里也可以定义或覆盖任务角色。产出/作用以提示词为准；提示词里**指名了员工**就按提示词**换人**（「架构师这次改由 ds-安全 担任」是真的换掉，不是再加一个），没指名就沿用配置文件里的人。换人时关口会说明换前换后。
- 配置文件**内部**（角色侧 `staff` 与员工侧 `efftaskRoles`）是同一层的两个方向，两边都写时取**并集**。

### /et 的三条护栏（成本与通过门槛）

一个角色配多个员工会把模型调用数**乘**起来，所以有三条护栏。它们**不在 `settings.json` 里**——那份文件的 `/et` 相关顶层键只有 `efftaskRoles`、`efftaskSkipSteps` 和 `roles`。设置方式是**在任务提示词里用自然语言说出来**，启动关口会把最终取值显示给你确认。

| 护栏 | 默认 | 怎么说 |
|-----|------|--------|
| 每阶段席位上限 | 5 | 「每阶段最多 3 席」 |
| 圆桌通过门槛（比例） | 100%（全票） | 「过半通过就行」「三分之二通过」「八成通过」 |
| 圆桌通过门槛（人数） | 无 | 「至少 2 个人通过」「要 3 票」 |

**为什么需要通过门槛这个旋钮**：默认是**全票**——任一席位提出阻断问题，整体就不通过。席位越多越难通过：每席独立 80% 通过率的话，3 席是 51%，9 席只有 13%，三轮迭代全部用尽的概率约 65%。所以配了多个员工之后，通常要同时放宽门槛，否则「人多」反而让任务跑不完。

比例和人数可以同时说，此时**两个都要满足**。只说人数时，比例这一维不设限（「至少 2 人通过」的意思是把门槛换成 2 席，不是「2 席并且全票」）。

**关口会显示预估调用数上限**，例如：

```
预估上限 2400 次模型调用(每节点最多 24 次 × 节点上限 100;实际通常远低于此);并发上限仍是 5
```

这是**上限口径**：它按节点数上限（默认 100）算，而实际任务通常只有几个节点，所以真实用量往往低两个数量级。它不是并发数——并发上限是另外那个「并行数」。

### 跳过环节

任何环节都可以整个跳过。两条入口：

```jsonc
// settings.json 顶层
{ "efftaskSkipSteps": ["质疑讨论", "验收"] }
```

```bash
/et 改个文案错别字。跳过质疑讨论和验收
```

两条入口**取并集**，不是覆盖：配置文件说「一直跳质疑讨论」、提示词说「这次也跳验收」，两句都生效。这和角色定义那边不一样——那边是覆盖（提示词点名了就换人），因为「谁来干」是单选；「干不干」是开关，叠加才符合两句话都说过的直觉。同理，三个配置来源（project／user／local）之间也是并集，local 取消不掉 project 里写的跳过。

中英文环节名都收。**跳过和「不配角色」是两回事**——不配角色是这一步照跑、只是由主模型一个人干；跳过是这一步整个不发生。测试验证和观察只是例外的一半：它们本来就是 opt-in，**没配席位时**写跳过确实是空操作；但**配了席位再跳**是真的把已配的调用砍掉（实测每节点 33 → 24）。所以「这次不想跑测试验证」要用跳过，不要去删自己的角色配置。

| 跳过 | 实际后果 |
|------|----------|
| 分析 | 不出方案、不主动拆子任务，节点直接照目标开工。任务树基本只有根节点 |
| 质疑讨论 | 方案没人质疑就进执行，漏项和隐藏依赖不会在这里被拦下 |
| 执行 | 没有人改代码，本次不会产生任何提交 |
| 测试验证 | 不实跑测试，验收只能读执行者的自述 |
| 验收 | 没人核对验收点，产出未经判断就合进集成分支 |
| 集成验收 | 子任务各自通过就算父任务达成，当初拆漏了不会再有人发现；而且所有**拆分型**节点（含根节点，如果它被拆了）不再评分。执行型节点的评分照常发生，所以单节点的 run 仍然有分 |
| 观察 | 不打分，低分触发的那一轮返工不会发生 |

被跳过的环节**不会**在 node.md 的 `reviewLog` / `acceptLog` 里留下 PASS 记录——一条假的通过记录会让你事后以为有人看过。

关口会当场拦下三个跑不完的组合：

- **跳过执行但不跳验收** → 不会有任何代码改动，而验收席位仍会照常开会去核对这个空产出；判通过等于给空节点盖章，判不通过则烧完验收迭代后阻断
- **跳过分析但不跳质疑讨论** → 评审席位去评一份空方案，烧完迭代后阻断
- **七个全跳** → 一次模型调用都没有，也不会有任何代码改动

### 各环节能用什么工具

按环节分三档，**不按角色**：

| 环节 | 拿得到的工具 |
|------|-------------|
| 执行 | 会话里的**全部**工具：读、写（Edit/Write/NotebookEdit）、Bash、全部 MCP |
| 测试验证 | 全部工具**减去** Edit/Write/NotebookEdit——保留 Bash（它得真的把测试跑起来）和全部 MCP |
| 其余（分析／质疑讨论／验收／集成验收／观察） | 全部工具**减去** Edit/Write/NotebookEdit/Bash，**保留全部 MCP** |

这是「减去写工具」而不是「只放行 Read/Glob/Grep」。区别很实在：白名单会把所有 `mcp__*` 连带滤掉，也会把以后新增的任何只读工具静默丢掉。

**MCP 在所有环节都可用**，包括角色自己在 agent 定义里声明的 `mcpServers`。

> **诚实的边界：会写的 MCP 挡不住。** 没有可靠办法从 `mcp__x__y` 这个名字判断它是否只读，所以给评审／验收席位配一个带写能力 MCP 的角色时，它**可以自己把问题改了再判通过**——执行者与评审者分离在这种配置下失效。启动关口会把这句话显示出来让你确认。剩下的防线是：内建写工具仍然只有执行环节有；`canUseTool` 仍然会询问（除非你 allowlist 或开了 bypassPermissions）；测试验证环节有工作区前后指纹比对，动了就判该轮作废。

另外，**任务的 `node.md` 不是子 agent 写的**——分析席位只返回一段 JSON，节点文件由编排器用 Node 的 `fs` 直接落盘。所以分析环节没有写工具也照样能拆分任务。

### 执行模式（execMode）

#### `api` 模式

角色通过 HTTP API 调用第三方 LLM 服务进行推理。需要配置 API 连接参数。

**额外必需字段：**
- `apiProtocol`：API 协议类型（`'anthropic'` \| `'openai'` \| `'openai-responses'`）
  - `'openai'` 走 `{apiUrl}/chat/completions`；`'openai-responses'` 走 `{apiUrl}/responses`（OpenAI Responses API）
  - 写错的协议名会让**整条员工不被载入**（不是「这个字段不生效」）。原因会显示在 `/et` 的启动关口上
- `apiUrl`：API 端点 URL
- `apiToken`：API 认证令牌（明文存储；生产环境建议使用环境变量）
- `model`：使用的模型标识符

**可选字段：**
- `thinkingDepth`：思考深度。可选值：`'low'` \| `'medium'` \| `'high'` \| `'xhigh'` \| `'max'`，或一个整数。大小写不敏感

  **三种协议收得下的档位不一样**，所以这个值会按「协议 + 模型」翻译一次，翻不过去的时候会在 `/et` 启动关口上说出来（而不是静默丢掉）：

  | 你写的 | anthropic | openai / openai-responses |
  |--------|-----------|---------------------------|
  | low / medium / high | 原样发 `output_config.effort` | 原样发 `reasoning_effort` / `reasoning.effort` |
  | `xhigh` | 原样发 | 原样发 |
  | `max` | 原样发（模型不支持 max 时 API 侧按 high 处理） | **译成 xhigh**（OpenAI 没有这一档） |
  | 整数 | ant-only 的 `effort_override` | **不发**（OpenAI 只收档位名） |

  还有一条和模型有关的：**Anthropic 协议下模型不支持 effort 参数时，这个值整段不发**。判据是 `modelSupportsEffort`，`claude-3-5-sonnet-20241022` 这类旧模型不在名单里。这种情况关口上会写明。

  认不出来的值（比如 `'deep'`）会被忽略，并在关口上列出可用值。

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

三选一,判据是**你的后端说哪种话**,以及**你要不要看到思考过程**:

| `apiProtocol` | 打到哪个路由 | 什么时候选它 | 看得到思考吗 |
|---|---|---|---|
| `anthropic` | `{apiUrl}/v1/messages` | 后端是 Anthropic 官方或兼容 Anthropic 协议的网关(MiniMax、部分中转) | 看得到(原生 thinking 块) |
| `openai` | `{apiUrl}/chat/completions` | 绝大多数「OpenAI 兼容」后端:DeepSeek、Kimi、GLM、通义、MiniMax、vLLM、SGLang、OpenRouter… | **看后端**:把推理放在 `reasoning_content` / `reasoning` 字段的能看到;OpenAI 官方的 chat/completions **不给**推理正文,所以真 OpenAI 走这条看不到 |
| `openai-responses` | `{apiUrl}/responses` | 你要用 **OpenAI 官方的推理模型**(gpt-5.x、o 系)并且想看到它的思考 | 看得到(推理摘要) |

一句话:**接第三方兼容后端用 `openai`;接 OpenAI 官方的推理模型用 `openai-responses`。**

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
- `thinkingDepth` 值（如 `'high'` 或 `'max'`）会映射到 Anthropic API 的 `output_config.effort` 参数——**前提是这个模型支持 effort**（见上面 `thinkingDepth` 那一节）
- 无效的 `thinkingDepth` 值（比如 `'deep'`）会被忽略。**大小写不算无效**：`'HIGH'` 和 `'high'` 一样有效

#### OpenAI 协议（chat/completions）

用于接入 OpenAI 官方 API 或兼容的第三方 OpenAI 格式服务（DeepSeek / Kimi / GLM / 通义 / MiniMax / vLLM / SGLang / OpenRouter 等）。请求发往 `{apiUrl}/chat/completions`。

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

#### OpenAI Responses 协议

用于接入 OpenAI 的 **Responses API**（`{apiUrl}/responses`）。和 chat/completions 的区别不只是路由：

- **思考过程能上屏**。请求里带 `reasoning.summary: 'auto'`，模型的推理摘要会作为思考内容显示在子 agent 输出里。
- **推理片段跨轮往返**。带工具调用的轮次必须把上一轮的 reasoning item 一起回传，否则上游直接 400（`function_call was provided without its required reasoning item`）。这条桥是无状态的，所以请求里带 `store: false` + `include: ['reasoning.encrypted_content']`，密文搭 Anthropic thinking 块的签名往返——**你不需要配置任何东西**，但这解释了为什么这个协议的请求体里有这两个字段。
- **对话不留在 OpenAI 侧**（`store: false`）。

**配置示例：**

```json
{
  "roles": [
    {
      "name": "gpt5-architect",
      "whenToUse": "复杂架构设计，需要深度推理",
      "execMode": "api",
      "apiProtocol": "openai-responses",
      "apiUrl": "https://api.openai.com/v1",
      "apiToken": "sk-proj-your-openai-key-here",
      "model": "gpt-5.1",
      "thinkingDepth": "xhigh",
      "tools": ["bash", "grep"]
    }
  ]
}
```

**说明：**
- `apiUrl` 填到 **`/v1` 为止**（比如 `https://api.openai.com/v1`）。路由 `/responses` 由这条桥自己接上去，你不要写进 `apiUrl`；`apiUrl` 自己带的路径前缀（网关常见的 `/openai/v1`）会被保留，不会被冲掉
- `model` 要填**推理模型**（`gpt-5.1`、`o4-mini` 之类）。填 `gpt-4o` 这类非推理模型也能跑，只是不会有推理摘要——那样的话用 `openai` 协议更直接
- `thinkingDepth` 在这条协议上落到 `reasoning.effort`。`xhigh` 和 `high` 两边协议都收得下；只有 `max` 是 Anthropic 独有的，在这条协议上会被译成 `xhigh`
- **协议翻译**：子 Agent 发出的请求会自动从 Anthropic 格式转译为 Responses 格式，事件流也会自动转译回 Anthropic 流，所以主会话的 Message 流透明一致

#### 从零配一个 openai-responses 员工

只写 `roles[]` 得到的是一个**没人派遣**的员工。要让它在 `/et` 里真的干活，还得把它绑到一个**任务角色**上——两步都做完才算配好。

**第 1 步：声明员工（`roles[]`）**

```jsonc
{
  "roles": [
    {
      "name": "gpt5-架构",              // 员工名，任意取；后面按这个名字引用
      "whenToUse": "复杂架构设计与拆分合理性评审",
      "execMode": "api",
      "apiProtocol": "openai-responses",
      "apiUrl": "https://api.openai.com/v1",
      "apiToken": "sk-proj-xxx",
      "model": "gpt-5.1",
      "thinkingDepth": "xhigh"          // 见下面「思考级别」一节
    }
  ]
}
```

**第 2 步：把它绑到一个环节上。** 两种写法,选一种即可(都写也行,会合并):

```jsonc
// 写法 A：在角色那侧点名员工（推荐，因为角色的产出/作用也在这儿写）
{
  "efftaskRoles": [
    {
      "name": "架构师",
      "step": "质疑讨论",
      "output": "通过/阻断裁决 + 每条阻断指向具体的边界问题",
      "purpose": "质疑这份拆分：有没有漏项、子任务间有没有隐藏依赖",
      "staff": ["gpt5-架构"]
    }
  ]
}
```

```jsonc
// 写法 B：在员工那侧声明「我能当哪些角色」（双向配置）
{
  "roles": [
    { "name": "gpt5-架构", "...": "同上", "efftaskRoles": ["架构师"] }
  ]
}
```

**第 3 步：确认它真的生效了。** 跑一次 `/et <任意目标>`，启动关口上会列出名册：

```
名册:
  架构师←gpt5-架构 (gpt-5.1)
```

括号里是**后端模型**（`gpt-5.1`），不是会话的 Claude 模型——看到这个就说明协议和模型都接上了。
如果这一行写着「架构师←主模型」，说明员工没被载入或者没绑上；关口上「你的请求中有以下部分不会生效」那一块会写明原因。看完按 Esc 取消即可，不会真的跑起来。

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
      "model": "claude-opus-4-6",
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
- 跑一次 `/et <任意目标>`，启动关口会把没载入成功的员工逐条列出来（看完按 Esc 取消即可，不会真的跑起来）

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
3. 检查角色名是否与内置 Agent 类型冲突（原因会显示在 `/et` 启动关口的「你的请求中有以下部分不会生效」那一块里（非交互 `--print` 模式下才走终端））
4. 对于 API 角色，确认 `apiProtocol`、`apiUrl`、`apiToken`、`model` 都已配置
5. 对于 CLI 角色，确认 `command` 字段已配置且可执行

### 思考级别配了没生效

**症状**：配了 `thinkingDepth`，但感觉模型没在深想；或者启动关口上出现一句「本次不会发送思考级别」。

这**不是**静默失败——关口一定会说原因。对着下面这张表看它说的是哪一种：

| 关口上写的 | 意思 | 怎么办 |
|---|---|---|
| `思考级别 max：OpenAI 系协议没有这一档，已按 xhigh 发送` | `max` 是 Anthropic 独有的档 | 直接写 `xhigh` 更准确 |
| `思考级别 max：模型 X 不支持 max，实际会按 high 发送` | 这个 Claude 模型不在 max 名单里 | 换成支持的模型，或者写 `high` |
| `思考级别 max：模型 X 不支持 effort 参数，本次不会发送思考级别` | 这个 Claude 模型不在 effort 支持名单里 | 换成支持的模型（如 `claude-opus-4-6`） |
| `思考级别 120：OpenAI 系协议只收档位名…数字无效` | 数字档只有 Anthropic 收 | 写档位名 |
| `thinkingDepth "deep" 无法识别，已忽略` | 拼错了 | 五个合法值：`low` / `medium` / `high` / `xhigh` / `max` |

模型名写**别名**（`opus`）也可以，判定前会先解析成全名。

### Responses 协议报错

**症状**：`apiProtocol: "openai-responses"` 的员工调用失败。

**检查清单：**
1. `apiUrl` 是不是多写了路由。要填到 `/v1` 为止，**不要**写成 `.../v1/responses`——那会拼成 `/v1/responses/responses`
2. `model` 是不是这个账号有权限的推理模型。Responses API 对模型的可用性和 chat/completions 不完全一样
3. 上游报 `function_call was provided without its required reasoning item`：这条桥已经在处理推理片段往返（`store: false` + `include: ['reasoning.encrypted_content']`，密文搭 thinking 块的签名回传），不需要你配置。真出现这个错说明中间有网关改写了请求体，或者对话历史被外部截断过
4. 协议名少写一个字母（`openai-response`）会让**整条员工不被载入**——不是「这个字段不生效」。原因会显示在 `/et` 启动关口上，并列出三个合法值

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
