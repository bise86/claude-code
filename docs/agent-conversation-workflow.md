# 单个阶段内的子 Agent 对话循环

本文只看一个分析阶段或执行阶段内部：一份任务提示词如何启动子 agent、为什么会产生多次模型 API 请求、每次请求携带什么，以及对话什么时候结束。不讨论 `/et` 的任务树、阶段切换、验收返工等外层编排，也不讨论网络重试策略。

代码核对基线：`c05959a`；官方文档核对日期：2026-09-07。

文中的“原生 Claude”指官方 Claude Code，不是网页版 Claude 聊天，也不是单独调用一次 Claude 模型 API。有关本项目的结论来自源码；有关官方产品的比较来自其公开文档，不能据此断言本仓库与某个官方发行版的所有实现细节完全相同。

## 1. 核心方法：工具调用式 Agent Loop

这套机制是“工具调用式 Agent Loop”：程序维护对话历史，模型决定下一步动作，程序执行工具，再把结果交给模型，反复进行直到本次对话结束。

一次对话中有三个分工：

- 任务提示词给出目标、约束和交付要求。
- 模型根据目标和已有结果，决定调用工具还是给出最终回答。
- 运行程序维护历史、调用模型 API、检查权限、执行工具，并控制继续或停止。

分析阶段和执行阶段使用同一种循环，区别主要在任务内容：

| 单次任务 | 可能的工具过程，不是固定脚本 | 期望返回 |
| --- | --- | --- |
| 分析 | 搜索位置 → 读取代码 → 查证假设 | 原因、代码位置、证据或方案 |
| 执行 | 读取代码 → 修改 → 测试 → 根据失败修正 | 修改内容、检查结果、未解决项 |

分析任务也可能多次调用 API；“分析”这个名称本身不会强制只读，实际能否修改文件取决于工具配置和权限。

因此，这不是预先写死的“API 1 做 A、API 2 做 B”工作流，而是由模型决策和工具反馈共同推进的循环。与官方 Claude Code 的核心机制是否一致，见第 8 节。

## 2. 本项目主 Agent 与子 Agent 共用什么

主会话、普通 API 子 agent、单个阶段的 API 子 agent 最终都调用同一个 `query()`。入口如下：

```text
主会话的用户输入
  └─ REPL / QueryEngine ───────────────────────┐
                                              │
主模型通过 Agent 工具委派任务                  │
  └─ AgentTool → runAgent ─────────────────────┤
                                              ├─ query → queryLoop
单个分析/执行阶段的一份任务提示词              │      └─ 模型请求、工具执行、结果回填、继续/结束
  └─ makeRunAgentFn → runAgent ────────────────┘
```

源码入口：

- [REPL.tsx](../src/screens/REPL.tsx)：主会话把现有历史和新用户消息交给 `query()`。
- [QueryEngine.ts](../src/QueryEngine.ts)：非交互/SDK 入口同样调用 `query()`。
- [AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx)：普通 API 子 agent 经 `runAgent()` 执行。
- [runAgent.ts](../src/tools/AgentTool/runAgent.ts)：构造子 agent 上下文，再调用 `query()`。
- [runAgentAdapter.ts](../src/tools/efftask/runAgentAdapter.ts)：把单个阶段的任务请求接入 `runAgent()`。

这里描述的是同进程 API 子 agent。另起 CLI 进程的子 agent 是另一条执行路径，不能直接套用上面的内部调用链。

## 3. 一次子 Agent 对话怎样启动

### 3.1 调用方先提供任务和运行配置

启动一次分析或执行对话，需要准备：

- 目标、已有背景、工作范围和其它约束；
- 可以检查的完成条件，以及最终需要返回的内容；
- 工作目录、agent 定义、模型、工具和权限等运行配置。

例如，一份任务可以是：

> 修复函数 A 的边界问题，补充测试并运行。只能修改指定目录，完成后报告修改位置、测试命令和结果。

这不是“第 1 次 API 必须读文件，第 2 次必须改文件”的脚本。具体工具调用顺序由模型根据已获得的信息决定。

### 3.2 初始任务和系统提示词是两部分

[runAgentAdapter.ts](../src/tools/efftask/runAgentAdapter.ts) 把 `${req.system}\n\n${req.prompt}` 包装成初始 **user 消息**。尽管字段名叫 `req.system`，在这一层它不是模型 API 的顶层 system prompt；执行路径传入的阶段标识是 `execute`。

真正的系统提示词由 `runAgent.ts` 中的 `getAgentSystemPrompt()` 从员工定义生成，并补充环境信息。实际请求还会合入相应的用户上下文和系统上下文。

因此，“界面上展示的执行提示词”不等于“这次请求的全部输入”。

### 3.3 程序创建本次任务的运行状态

`runAgent()` 创建或采用 agent ID，准备初始消息、工具、权限、模型配置、取消信号和记录位置，然后进入 `query()`。

阶段适配器的这条调用没有传入 `forkContextMessages`，所以本次任务不会自动接收父会话或其它任务的完整聊天记录。需要的信息由调用方显式放入任务输入；本次对话后续产生的历史则持续累积。

“使用同一个 agent 定义”不等于“自动接着它上次的聊天继续”。普通子 agent 另有 fork/resume 路径，应与这里启动新对话的方式区分。

独立对话历史也不等于独立文件系统。实际文件隔离取决于 worktree/工作目录安排；不同 agent 仍可能读写同一个目录。

## 4. 每次模型 API 请求携带什么

### 4.1 请求的四部分

概念上，每轮请求都是：

```text
模型及生成参数
+ 系统提示词、环境与规则
+ 当前可用工具的定义
+ 当前有效对话历史
```

其中：

- 工具定义包含名称、用途、参数结构，不是把工具源码发给模型。
- 对话历史包含初始任务、模型此前的回复、工具调用及其结果。
- 文件内容、命令输出等通常通过工具结果进入历史，并不是默认上传整个工作区。
- 系统提示词和工具定义仍随请求构造；工具发现、上下文注入、配置等也可能改变其内容。

本项目先在 [claude.ts](../src/services/api/claude.ts) 的 `paramsFromContext()` 中构造 `model`、`system`、`messages`、`tools` 及生成参数，再按员工协议决定是否转换请求。

### 4.2 连续四次调用的例子

假设 `U` 表示初始任务，`A1` 表示第一次模型回复，`T1` 表示该回复要求的工具所返回的结果。每行还会携带系统提示词、工具定义和模型参数，表中省略。

| 请求 | 传入的历史 | 模型本次提出的动作或答案 |
| --- | --- | --- |
| API 1 | `U` | `A1`：调用 `Read`，读取相关文件 |
| API 2 | `U + A1 + T1` | `A2`：根据文件内容调用 `Edit` |
| API 3 | `U + A1 + T1 + A2 + T2` | `A3`：调用 `Bash` 运行测试 |
| API 4 | `U + A1 + T1 + A2 + T2 + A3 + T3` | `A4`：汇总修改和测试结果，不再调用工具 |

如果 `T3` 是测试失败的输出，API 4 也可能要求继续读文件、修改、测试，而不是直接交最终报告。测试输出本身就给出了新的信息，程序不一定需要另外补一句“测试失败，请继续修”。

不能只保留工具结果、丢掉模型的工具调用。二者通过调用 ID 配对，模型需要知道哪个结果对应哪个动作。

### 4.3 历史由本地循环管理

`query.ts` 构造下一轮状态时，核心关系是：

```text
下一轮历史 = 当前有效历史 + 本轮 assistant 消息 + 本轮工具结果
```

源码变量对应 `messagesForQuery`、`assistantMessages`、`toolResults`。

这里的“有效历史”不意味着永远原样携带所有旧内容。每轮请求前可以进行消息规范化、过大工具结果处理、历史压缩等。压缩本身也可能需要额外的模型请求。

### 4.4 换成 Responses 模型，不等于换了 Agent 引擎

对于本项目的 OpenAI Responses 兼容员工，[toResponsesRequest.ts](../src/services/api/openaiCompat/toResponsesRequest.ts) 将本地历史转换为：

- 系统文本 → `instructions`；
- 对话正文 → `input` 中的消息；
- 工具调用 → `function_call`；
- 工具结果 → `function_call_output`，用 `call_id` 配对；
- 必要的推理密文 → `reasoning` 项。

这条转换路径设置 `store: false`，不使用 `previous_response_id` 续接服务端历史，而是每轮从本地历史重建输入。`prompt_cache_key` 用于缓存路由，不替代历史内容。

所以，经这条接口接入 Codex 类模型时，驱动读文件、改文件、跑测试的仍是本仓库的 `query()` 和工具执行器，不是自动切换成 Codex CLI 的内部工作流。

这里的“SDK 负责收发”指本项目使用的模型 API 客户端，不能泛化为“所有 Agent SDK 都不提供对话循环”。

## 5. 什么时间点发下一次 API 请求

正常的客户端工具路径是：

1. 程序消费本轮模型响应，收集正文及结构化工具调用。
2. 发现 `tool_use` 时，把 `needsFollowUp` 设为 `true`。
3. 执行本轮工具，收集返回结果。
4. 将模型回复和工具结果追加到历史。
5. 更新循环状态，发起下一次模型请求。

相关代码在 [query.ts](../src/query.ts) 的 `deps.callModel()`、`needsFollowUp`、`toolUpdates` 和 `state = next`。

这不是定时器驱动，也不是每收到几个 token 就发一次请求。正常路径里，下一轮由“本轮有工具调用，并且其结果已经收集”触发。

### 多个工具与流式输出

一次模型回复可以提出多个工具调用。可安全并发的工具可以并行执行；不可安全并发的调用按执行器规则串行处理。

如果启用了流式工具执行，完整的工具调用到达后，程序就可能开始执行该工具，而模型还在输出本轮后续内容。主对话的下一次模型请求仍在本轮响应处理完、这一批工具返回结果并完成上下文更新之后发出。

“工具返回结果”不一定表示它启动的所有后台工作都已经自然结束。例如后台命令可能先返回任务 ID，后续再通过工具读取结果。

实现分别见 [StreamingToolExecutor.ts](../src/services/tools/StreamingToolExecutor.ts) 和 [toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)。

### 不要混淆三种数量

- 一次模型 API 请求可以返回很多文本、思考和工具事件；这些流式片段不是很多次请求。
- 一次模型 API 请求可以提出多个工具调用；工具调用数不等于模型请求数。
- 普通 `Read`、`Edit`、`Bash` 操作本身不是模型推理请求。若某种工具又派发了 agent，则会产生另一段对话，应单独区分。

本文描述的是客户端执行的工具。不能把“每个工具动作都要客户端发下一次 API”推广到服务端工具：官方 API 的部分服务端工具可以在单次请求内完成多步操作。参见 [官方：客户端与服务端工具循环](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works#the-agentic-loop-client-tools)。

## 6. 子 Agent 对话什么时候结束

### 6.1 正常停止不是靠搜索“完成了”三个字

本项目正常路径的主要结束条件是：

> 本轮响应已经处理完，没有新的工具调用，也没有其它机制要求继续。

`query.ts` 主要通过实际收到的 `tool_use` 块设置 `needsFollowUp`，不是只依赖 `stop_reason === 'tool_use'`，也不是扫描自然语言中的完成声明。

因此：

- 回复“我先读取文件”，同时包含 `Read` 调用：执行工具并继续。
- 只回复“我先读取文件”，没有工具调用：如果没有其它继续条件，本次对话通常会结束。
- 回复最终执行报告，没有工具调用：通常结束。
- 正文看起来像最终报告，但还附带工具调用：先完成工具，再进入下一轮。

报告是否包含调用方要求的字段，不是 `query()` 内部的常规停止判据；调用方可以在 agent 返回后另外解析和检查。

### 6.2 没有工具调用，也可能继续

停止钩子可以要求补做工作，输出截断可以触发续写，启用的预算续跑机制也可能增加一条继续指令。这些条件会把相应信息加入上下文，再次请求模型。

因此不能把实现简化成“收到任何一段文字就结束”，也不能说“只要没有工具调用，任何情况都必然结束”。参见 [query.ts](../src/query.ts) 和 [stopHooks.ts](../src/query/stopHooks.ts)。

### 6.3 限制触发的停止不等于成功

取消、超时以及配置的 `maxTurns` 等限制也可以停止子 agent。它们表示运行停止，不能单凭这一点认定需求满足。

阶段适配器没有显式传入 `maxTurns`；`runAgent()` 使用 `maxTurns ?? agentDefinition.maxTurns` 传给循环。因此不能认为每次分析或执行对话都有固定的 API 调用次数；还要检查实际配置。工具循环轮数也不等于包含压缩等辅助请求在内的全部 API 请求数。

### 6.4 简化伪代码

下面用于解释控制流，省略流式细节、异常处理、上下文压缩及各种限制：

```text
历史 = [初始任务]

循环：
    回复 = 调用模型(系统提示词, 工具定义, 历史)
    历史追加(回复)

    如果回复包含工具调用：
        结果 = 执行工具并收集返回值
        历史追加(结果)
        继续循环

    如果停止检查要求补做：
        历史追加(补做要求)
        继续循环

    返回结果，结束本次对话
```

这段循环决定的是何时再次向模型询问下一步，不负责证明模型的最终报告一定正确。

## 7. 只看这一次对话，它怎样满足需求

### 7.1 工具反馈让模型逐步完成目标

执行任务里，测试失败的输出进入下一轮历史，模型可以据此修改并再次测试；分析任务里，搜索命中只提供线索，模型可以继续读取相关实现、验证假设，最后给出有依据的结论。

模型负责把任务目标与反馈联系起来，运行程序负责执行动作、将结果放回上下文。这就是单次对话内部的反馈循环，不需要每一步都由人再发送一份新提示词。

### 7.2 停止条件不等于完成条件

这段通用循环并没有一个默认检查器，能够自动证明所有自然语言需求都已满足。模型不再提出工具调用，只说明它选择交出回答；它也可能遗漏测试、误判结果或提前结束。

需要区分：

- **对话停止**：没有工具调用及其它继续条件，或者触发取消、超时等限制。
- **任务完成**：产出满足目标，有文件、测试结果或分析证据支撑结论。

如果要求“测试没通过就不允许正常结束”，需要明确实现相应的停止检查或调用方校验。这是增强完成约束的方法，不是说当前通用循环已默认强制检查每个任务的全部要求。

### 7.3 提示词怎样帮助它正确收尾

一份可执行的任务至少应交代：目标、工作范围、限制、可检查的完成条件、最终需要返回的证据。

例如“完成改造”不如“修改指定函数；现有测试保持通过；新增空输入测试；报告测试命令和结果；未完成时明确说明”具体。分析任务则可要求“定位调用路径、列出支持结论的代码位置、区分事实与推测”。但具体提示词仍不是结果正确性的程序保证。

### 7.4 对话的返回边界

对话结束后，阶段适配器收集本次运行的 assistant 正文，由 `collectText()` 返回调用方；它不等于原样返回整段工具历史，也不只是直接取最后一个流式片段。

本文在“这一次子 agent 对话返回”处结束，不展开调用方接下来如何安排其它任务。

## 8. 与原生 Claude Code 主／子 Agent 是否一致

### 8.1 本仓库内：共享循环，调用环境不同

| 维度 | 主 Agent | 普通 API 子 Agent | 单个阶段的 API 子 Agent |
| --- | --- | --- | --- |
| 谁启动 | 用户输入，经 REPL/QueryEngine | 主模型通过 Agent 工具等入口委派 | 调用方提交一份分析或执行任务 |
| 内层引擎 | `query()` | `runAgent()` → `query()` | `runAgent()` → `query()` |
| 初始历史 | 当前主会话及新输入 | 普通新任务独立；fork/resume 是不同路径 | 当前任务，不自动携带其它任务完整历史 |
| 系统提示词 | 主会话规则与上下文 | 员工定义与上下文；fork 可有不同继承方式 | 选定员工定义与上下文，阶段任务另外放入 user 消息 |
| 工具和权限 | 主会话配置 | 按员工配置、执行模式和权限解析 | 适配器提供共享候选工具池，仍经过工具解析和权限检查 |
| 本次循环结束后 | 把结果交给用户；交互会话可接收下一次输入 | 把结果交还父会话/调用方 | 将收集到的回答文本返回调用方 |

主 agent 的本次 `query()` 返回，不代表整个交互程序退出。子 agent 的任务返回，也不代表父 agent 必须结束；父 agent 可以把子任务结果作为新信息继续处理。

### 8.2 官方产品层面：核心机制一致，不保证实现逐项相同

官方 Claude Code 文档说明，主 agent 会根据任务和工具结果不断获取上下文、采取行动、检查结果。这与本项目内层循环的职责一致。参见 [官方：Agentic loop](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop)。

官方子 agent 也有独立的上下文、系统提示词、工具范围和权限，完成后将结果交回。普通新建子 agent 与继承父对话的 fork 需要区分，不能概括为“所有子 agent 都完全不继承历史”。参见 [官方：Subagents](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)。

官方模型 API 文档给出的客户端工具流程同样是：发送工具定义和消息，接收工具调用，由应用执行工具，再携带调用及结果发下一次请求。但示例级 API 循环不等于完整 Claude Code 的全部停止逻辑；本文有关 `needsFollowUp`、停止钩子和预算的精确描述，只对已检查的本仓库代码负责。参见 [官方：How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works#the-agentic-loop-client-tools)。

不能据此推断相同的提示词、权限默认值、模型选择、上下文压缩策略、前后台调度或每个停止边界。本项目的 Responses 转换层和 `roles` 配置也不是官方 Claude Code 的通用标准。

结论：**单次对话使用同一种核心循环，本仓库的这几个入口甚至共用同一段代码；但输入、工具权限和完成约束不同，不代表行为完全一样，也不保证每次都能满足需求。**

## 9. 查代码时看哪里

| 问题 | 文件与关键函数/变量 |
| --- | --- |
| 阶段提示词如何进入对话 | [runAgentAdapter.ts](../src/tools/efftask/runAgentAdapter.ts)：`promptMessages`、`invoke` |
| 子 agent 如何建立上下文并启动 | [runAgent.ts](../src/tools/AgentTool/runAgent.ts)：`initialMessages`、`getAgentSystemPrompt`、`query` 调用 |
| 为什么调用下一次 API | [query.ts](../src/query.ts)：`queryLoop`、`needsFollowUp`、`toolUpdates`、`state = next` |
| 每次 API 的请求体如何构造 | [claude.ts](../src/services/api/claude.ts)：`paramsFromContext`、`queryModel` |
| 工具如何并发或串行执行 | [toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)、[StreamingToolExecutor.ts](../src/services/tools/StreamingToolExecutor.ts) |
| 无工具调用后为什么仍可能继续 | [query.ts](../src/query.ts)、[stopHooks.ts](../src/query/stopHooks.ts) |
| Responses 如何重建历史和配对工具结果 | [toResponsesRequest.ts](../src/services/api/openaiCompat/toResponsesRequest.ts)：`toResponsesRequest` |
| 对话结束后怎样返回文本 | [runAgentAdapter.ts](../src/tools/efftask/runAgentAdapter.ts)：`consumeMessages`、`collectText` |
