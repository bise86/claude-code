# 子 agent 实时终端窗口 + 评审收敛 设计方案 (v2)

日期: 2026-07-27
状态: 已过一轮四角色评审(接线 / TUI / 健壮性 / 需求符合度),本版是评审后的修订版
涉及: `/et` 高效任务模式(`src/tools/efftask/`, `src/commands/efftask/`)

> **v2 相对 v1 的实质改动**(评审驳回的部分,列在这里免得后来人把它们改回去):
> 1. 流的身份从「字符串 key」改为**调用点开出来的句柄**(v1 的 `nodeId#phase#round#seat` 有 4 处真实碰撞)。
> 2. `end()` 从圆桌一处移到 `makeRunAgentFn` 的 `finally` —— 唯一一个所有模型调用必经的点。
> 3. text/thinking **按行拆事件**(v1 一条事件截 300 码点,比现状**倒退**)。
> 4. 折行按**显示宽度**,不是码点(中文一律撑破边框)。
> 5. 加**全局事件上限**(v1 只有每流/每节点两层,`maxNodes` 实际能到 5000,算下来 6.4 GB)。
> 6. 等待画面接的是 `phase === 'drafting'` 分支,不是 `ConfirmRootPlan`(v1 接在「等完之后」那一屏)。
> 7. 数据流补 `runOrchestrator` 这一跳(v1 漏了,而这正是本仓库剪断过两次的那根线)。
> 8. **评审触顶改为开一次关口问用户**,不再直接打死整个运行 —— spec 2026-07-25 §9 本来就是这么写的,机器也现成。
> 9. 相似度阈值与规则重定(v1 的 0.75 实测两头都错)。
> 10. 删掉 `t` / `a` 两个键;折叠默认值定死。

---

## 一、要解决的两件事

### 1. 子 agent 的输出现在几乎看不出模型在干什么

现状逐条核对过代码:

- `runAgentAdapter.ts:171` —— 只有 `message.type === 'assistant'` 触发 `onChunk`,且只取 `collectText()`(**只取 text 块**)。thinking 块、tool_use 块全丢;`m.type === 'user'` 整条跳过,所以**工具返回值一个字看不到**。一个纯工具轮次(读了 12 个文件)在界面上完全空白 —— 用户看到「运行中 · 47s」加一片空白,分不清在干活还是卡死。
- `pipeline.ts:368` —— 圆桌里 N 个席位**共用一个 `onChunk`**,并到 `nodeId` 一个桶,三段话逐句交错且**无署名**。
- `pipeline.ts:227` 的 `runPhase` 同样没有席位维度,而它下面挂着**分析圆桌 N 席**(`:713`)、**融合席**(`:741`)、**分析精化 N 席**(`:810`)、**观察评分 N 席**(`:1172`)—— 这些也全部无署名地并在一起。
- `chunkBuffer.ts` —— 只存字符串行:没有事件类型、没有归属、没有时间。
- `NodeDetail.tsx:198-214` —— 固定尾窗 `slice(-outputRows)`:**不能滚动**,滚出去的永远看不回来;无折叠、无滚动条、无颜色区分。
- `rootPlan.ts:94`(第三关根方案)与 `efftask.tsx:722`(需求解析 `parseDirectives`)**两次真实模型调用完全没接输出**。这两处分别是「敲完 `/et` 看到的第一屏」和「整个运行里最长的单次调用之一」,现在都是纯黑屏。

用户原话:「需要TUI那种输出,带滚动条,看到模型在干啥,在思考啥,在调用什么工具,和真实终端一样。所有模型的输出最好都带这样一个折叠的TUI窗口。」

### 2. 评审循环不收敛就把整个运行打死

用户实际撞到的:

```
评审迭代超限(3): [main] 评分等级(A/B/C/D)与具体分数的映射规则未定义…;
                 [main] 维度内多个检查点的分数汇总逻辑缺失…;
                 [main] 验收标准表述存在逻辑矛盾…
· 若方案本身没问题,可提高 run.md 里 caps.maxIterations 后再重试;否则先按评审意见改需求或补充信息。
· 重试: /et --resume 001 --retry-blocked
```

代码层面四个成因:

1. **反馈只带最后一轮**:`pipeline.ts:981` `feedback = rec.synthesized.blockingSummary`,每轮覆盖。方案作者从来没同时看到过三轮意见,它每次都在打地鼠。
2. **评审员单边失明**:`reviewPrompt`(`pipeline.ts:490-492`)只吃 `node.plan` —— **没有 reviewLog、没有轮次号、没有上一版方案**,而 `node.reviewLog` 就挂在同一个对象上。方案作者那边反而有历史(`planPrompt:432-434` 带上一版方案 + feedback)。所以评审员**不可能知道自己在重复**。
3. **静态话术**:`escalation.ts:81` 的 `REMEDY['cap-iteration']` 是一句放之四海皆准的话,没法按「这几条连提三轮」还是「每轮都换新意见」分叉 —— 而这两种情况的正确动作**相反**。
4. **触顶即死**:`orchestrator.ts:264-267` 根节点 BLOCKED → 整个 run 结束;`:347` 父节点 BLOCKED 向下传播,中间节点触顶等于打死整棵子树。用户这次是在**第一道关口、一行代码都没写**的时候,把 3 轮 × N 席评审 + N 次方案调用全烧光后收到一句「重试」。

**第 4 条是用户真正的痛点**,而 spec 早就规定了正确做法 —— `docs/superpowers/specs/2026-07-25-efficient-task-mode-design.md:394`:

> 启动三关与**中途升级(触阀**、合并冲突升级、连续返工超限)→ 复用 `interactiveHandler.ts` 的确认竞速器 + 卡片。呈现为一次确认,**首个响应端胜出**。

现在只实现了「发卡片」那一半(`escalation.ts:197` 的 `buildBlockCard` 是纯展示,没有回执通道)。竞速器本身是现成的:`startupConfirm.ts:392 raceConfirm` / `:382 createResolveOnce` / `:375 ConfirmSurface`;「中途问用户 + 收自由文本 + 重来一轮」的先例也是现成的:`ConfirmRootPlan.tsx:15-19` 的 `redraft{feedback}`,且 `efftask.tsx` 的 `onRootDecision` 对它不 latch,可反复重拟。

---

## 二、目标与非目标

### 目标

1. `/et` 里**每一次模型调用**都有一个可折叠、可滚动、带滚动条的实时窗口:模型说的话、思考、调用了什么工具(带参数摘要)、工具返回了什么(带报错标记)。包括:7 个环节的全部席位、分析圆桌的每一席与融合席、观察评分每一席、根方案、需求解析。
2. 每个席位**独立成窗**,带署名(员工名/角色名)、模型名、状态、工具计数、耗时。
3. 任务树上一眼看到运行中节点**此刻在调什么工具**。
4. 评审触顶时**开一次关口问用户**,而不是打死整个运行;并且累积反馈、检测重复、按事实给建议。

### 非目标(写清楚,免得评审按别的标准打分)

- **不改 Claude Code 主 REPL 的消息渲染。** 理由不是「无关」,是**它已经有了**:`src/tools/AgentTool/UI.tsx:510` 的 `processedMessages.slice(-3)` 就是运行中子 agent 的实时工具滚动,`:757` 的 `AgentProgressLine` 带 `lastToolInfo/toolUseCount/tokens`,`:407/566/755` 的 `CtrlOToExpand` 就是「折叠」。重复造一套只会分叉。
- **`cliAgentRunner`(CLI 模式角色)确实没有流式输出**(`cliAgentRunner.ts:422/496` 只在最后 yield 一次结果)。它被 `dispatchableRoles`(`startupConfirm.ts:223`)挡在 `/et` 之外,所以不在本次范围;**作为已知缺口记在这里**,不假装它不存在。
- **不引入鼠标交互。** 沿用 `TaskTreePanel.tsx:79-83` 已记的理由:鼠标追踪只在 fullscreen 下开,在 REPL 里开会夺走用户选中复制终端文本的能力。
- **不做日志落盘。** 代价是:`--resume` 之后历史节点的窗口是**空的**。这句代价必须以**用户可见的文案**兑现,见 §5「resume 语义」。
- **不改评审判定规则(quorum / 通过条件)。** 本次改的是反馈怎么传、触顶后问谁,不改谁说了算。
- **触顶关口不做「系统自动采纳方案」。** 只做「**问用户**」。用户选择越过评审时,必须在 `node.md` 留痕。

---

## 三、架构总览

```
runAgent(真实子 agent)
   │ yield Message (assistant: text/thinking/tool_use | user: tool_result)
   ▼
runAgentAdapter.makeRunAgentFn
   │ 每条消息: try { eventsFromMessage(m).forEach(req.stream.push) } catch {}
   │ finally  { req.stream?.end(err?) }        ← 唯一一个所有调用必经的收口点
   ▼
roundtable.runRoundtable  /  pipeline.runPhase  /  rootPlan.draftRootPlan  /  extractJson
   │ 每个调用点自己 ctx.openStream(meta) 拿一个句柄,放进 req.stream
   ▼
pipeline.PipelineCtx.openStream(meta) → StreamHandle
   ▼
orchestrator.ts:46/146  →  runOrchestrator.ts:50/175  →  efftask.tsx:853
   │                        ^^^^^^^^^^^^^^^^^^^^^^^ v1 漏了这一跳
   ▼
streamStore (src/tools/efftask/agentStream.ts)
   ▼
AgentLogPane ← renderStreamLines() / logPaneAction() (纯函数, logView.ts)
   挂载点: NodeDetail(可交互) · TaskTreePanel 活动行 · drafting 屏 · parsing 屏
```

**为什么是句柄而不是字符串 key。** v1 用 `nodeId#phase#round#seat`,评审找出四处真实碰撞:

1. `pipeline.ts:357-370` 的 infra 重试,3 次 attempt **共用同一个 `args.round`** → 第二次 attempt 往一条已 `end()` 的流里继续 push;
2. `pipeline.ts:1581` 执行返工的 `round++` 是 `stepExecute` 的局部变量,`runPhase` 看不见 → 所有返工轮次挤进同一 key;
3. `pipeline.ts:1369` 合并冲突自动解决用的也是 `phase:'execute'` + 同一 node,与主执行流同键;
4. `pipeline.ts:1879` 集成验收用的是 `phase:'accept'`(只有 `system:'integrate'` 区分),与叶子验收同键。

句柄由调用点在**发起调用的那一刻**开出来,一次调用一个句柄,**结构上不可能撞**。

`runOrchestrator.ts:50/175` 这一跳必须写进来:`orchestrator.ts:39-46` 的注释已经记着 ——

> THIRD callback to travel this exact path. The first two (onEscalate, onBlocked) were each declared on PipelineCtx and on runOrchestrator but missed HERE and in ctx() below, and were therefore **dead in every real run while their unit tests passed over the cut wire**.

本仓库**没有 typecheck**,漏这一跳不会报错,只会全空。

---

## 四、事件模型 —— `src/tools/efftask/agentEvents.ts`(新)

```ts
export type AgentEvent =
  | { kind: 'text';     text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool';     useId: string; name: string; brief: string }
  | { kind: 'result';   useId: string; brief: string; isError: boolean }
```

### `eventsFromMessage(m, brief?): AgentEvent[]`

纯函数。`brief` 是可选的工具摘要解析器(见下)。

- `m.type === 'assistant'`:内容路径是 **`m.message.content`**(不是 `m.content` —— `runAgentAdapter.ts:30` 与 `utils/messages.ts:849` 是仓库里仅有的两处真实证据;`src/types/message.ts` 在本 fork 里**不存在**,全是 type-only 导入、构建期擦除,写错路径**零反馈**)。
  - `content` 是字符串(合法变体,`runAgentAdapter.ts:31-36` 已记)→ 按行拆成 text 事件。
  - 是数组 → 逐块。**每块先 `block && typeof block === 'object'` 判空**,内容数组含 `null` 时 `block.type` 会抛。
    - `text` + `typeof block.text === 'string'` → **按 `\n` 拆成多条 text 事件**;
    - `thinking` + `typeof block.thinking === 'string'` → 同样按行拆;
    - `redacted_thinking` → 一条 `{kind:'thinking', text:'(思考内容已由服务端隐去)'}`;
    - `tool_use` → `{kind:'tool', useId: String(block.id ?? ''), name: String(block.name ?? '?'), brief: briefOfToolUse(...)}`。
- `m.type === 'user'`:`m.message.content` 数组里的 `tool_result` → `{kind:'result', useId, brief: briefOfToolResult(block.content), isError: block.is_error === true}`。
- 其他类型(progress / attachment / 未知)→ `[]`。**未知类型必须返回空数组而不是抛异常**。

**按行拆是硬要求,不是风格。** v1 把一个 text block 做成一条事件再截 300 码点,等于把现状(`chunkBuffer.ts:52-70` 先按 `\n` 拆行、每行截 300、保 200 行)**倒退**成「一条消息只剩 300 字」。而模型说的话正是用户第一位要看的东西。

### `sanitizeLine(s): string | null`

三步,顺序**不能换**(评审实测:先全串正则替换再截断,会在 0.25 MB 的 minified 行上跑一遍全串正则并造一个 0.25 MB 的新串,而最终只留 300 码点):

1. 粗切 `s.slice(0, MAX_EVENT_CHARS * 4)`;
2. 剥控制字节 `/[ --]/g`;
3. 按**码点**精切到 `MAX_EVENT_CHARS = 300`,超出补 `…`;
4. **结果 `trim()` 为空 → 返回 `null`,调用方丢弃这条事件。**

第 4 步是 `chunkBuffer.test.ts:20-27`(丢空白消息)与 `:92-96`(纯控制字节不留空行)两条测试的存续条件,少了它这两条测试直接红。

**四类事件的每一个字符串字段都要过 `sanitizeLine`** —— v1 只承诺了 `briefOfToolUse` 一条路径,而 text/thinking 恰恰是**从模型直达终端**的那部分(`chunkBuffer.ts:52-57` 实测 `ESC[2J` 清屏序列能整条打到终端)。

### `briefOfToolUse(name, input, resolve?): string`

优先走注入的 `resolve(name, input)`(由 `/et` 适配层用手上的 `availableTools` 包 `Tool.userFacingName`,`src/Tool.ts:529`),这样新工具进来自动有好摘要。解析器缺席或返回空 → 落到静态表:

| 工具 | 取值 |
|---|---|
| Read / Edit / Write / NotebookEdit | `file_path` |
| Bash / PowerShell | `command` 首行 |
| Grep | `pattern`(有 `path` 补 ` in <path>`) |
| Glob | `pattern` |
| Task / Agent | `description` |
| 其他(含 `mcp__*`) | 第一个字符串型**自有**属性值 |

**畸形输入是生产可达的,不是理论**:`utils/messages.ts:2661-2700` 的 `normalizeContentFromAPI` 对流式返回的 `input` 走 `safeParseJSON(...) ?? {}`,而 `JSON.parse('[1,2]')`→数组、`JSON.parse('5')`→数字、`JSON.parse('"x"')`→字符串,三者都不是 `null`,`?? {}` 拦不住。所以硬约束:

- 第一行 `if (typeof input !== 'object' || input === null || Array.isArray(input)) return name`;
- 每个字段取出后 `typeof x === 'string'` 才用;
- 兜底用 `Object.entries(input).find(([,v]) => typeof v === 'string')`,**不得用 `JSON.stringify`**(循环引用直接抛)。

### `briefOfToolResult(content): string`

- 字符串 → 首行。
- 数组 → **只取第一个 `type === 'text'` 的块**,不拼接(拼接是为了取首行而复制全部文本,10 个 25 KB 块 = 一次 250 KB 临时分配,而只需要前 300 码点)。
- 其他/空 → `'(无输出)'`。
- 有更多内容时补 `…` —— **不给精确行数**。数行数要么 `split`(0.25 MB 上分配约 5000 个字符串对象)要么全串扫描,而窗口里那个数没人核对。这是热路径,`parallelism` 默认 5 × 每节点多席并发。

---

## 五、流存储 —— `src/tools/efftask/agentStream.ts`(新,取代 `chunkBuffer.ts`)

```ts
export interface StreamMeta {
  nodeId: string        // 真实节点 id;树外调用用 PRE_TREE_NODE = '__pre__'
  phaseLabel: string    // '分析' | '质疑讨论' | '执行' | '测试验证' | '验收' | '集成验收' | '观察'
                        // | '方案融合' | '根方案' | '需求解析'  —— 由调用点给,不从 req.phase 推
  round?: number        // 第几轮(调用点给;infra 重试也换新句柄,所以不需要 attempt 维度)
  label: string         // 署名。取值必须是 roleName || roleTag || '主模型'
  model?: string
}

export interface StreamHandle {
  push(e: AgentEvent): void
  /** 收口。err 非空 → 表头渲染 ✗ 调用失败。重复调用是 no-op。 */
  end(err?: string): void
}

export interface StreamState {
  meta: StreamMeta
  events: AgentEvent[]
  dropped: number          // 本流因环形缓冲丢弃的事件数
  toolCount: number
  startedAt: number
  endedAt?: number
  error?: string
  closed: boolean
  seq: number
  tombstone?: boolean      // 被淘汰,只留表头 + 最后几条
}

export interface StreamStore {
  open(meta: StreamMeta): StreamHandle
  streams(nodeId: string): StreamState[]          // 按 seq 升序
  droppedEvents(nodeId: string): number           // 含被淘汰流带走的事件数
  subscribe(fn: () => void): () => void
  /** resume 带进来的节点:没有任何流,且不是「什么都没干」。 */
  markHistorical(nodeIds: string[]): void
  isHistorical(nodeId: string): boolean
}
export function createStreamStore(opts?: { now?: () => number }): StreamStore
```

### `label` 必须短路取值,不能用 `??`

`types.ts:113-114` `export const MAIN_STAFF = ''`。`roundtable.ts:141-146` 的注释记着这个坑:`role ? role.roleName : 'main'` 在「主模型兼任」席位上产出**空串**,于是 `blockingSummary` 变成 `[] 缺回滚方案`。所以是 `roleName || roleTag || '主模型'`(`||`,不是 `??`),并且有一条空串正例测试。

### 三层上限

| 常量 | 值 | 作用 |
|---|---|---|
| `MAX_EVENT_CHARS` | 300 | 单**行**码点(按行拆之后,语义与今天 `MAX_CHUNK_LINE_CHARS` 完全一致) |
| `MAX_EVENTS_PER_STREAM` | 100 | 单流保留的事件数,超出丢最旧并 `dropped++` |
| `MAX_STREAMS_PER_NODE` | 40 | 单节点保留的流数 |
| **`MAX_TOTAL_EVENTS`** | **20000** | **全局**事件总数(v1 没有这一层) |

**为什么必须有全局这一层。** v1 的测算是「100 节点 × 24 流 × 300 事件 × 40 码点 ≈ 58 MB」,评审实测(node --expose-gc,四类事件 1:1:1:1、CJK 40 码点)是 **127.5 MB / rss 319.8 MB** —— v1 只算了字符串字节,没算每个 `AgentEvent` 对象约 90~100 B 的开销。更要命的是 `caps.maxNodes` 的真实上限是 **5000 不是 100**(`parseDirectives.ts:146` `clampInt(caps.maxNodes, 1, 5000, 100)`,`resumeCore.ts:598` 同),而 `chunkBuffer.ts:24-27` 自己写着「the cap-nodes card **tells users to raise it**」—— 产品会主动引导用户调高。按 v1 的两层上限,5000 节点是 **6.4 GB**。

全局上限把总量钉死在与节点数无关的地方:20000 事件 × (平均 80 码点 × 2B + 100B 对象) ≈ **5.2 MB**,最坏(全 300 码点)≈ 14 MB。这是真正的天花板。

### 淘汰 = 墓碑,不是删除

超限时(先看全局,再看单节点)按 `seq` 升序找**已 `closed` 的流**,把它压成墓碑:保留 `meta` + 最后 3 条事件,其余计入该节点的 `droppedEvents`。**活着的流永不淘汰、永不压缩。**

- 为什么是墓碑不是删除:§10 的整个卖点是「让用户和模型同时看到前几轮说了什么」,而淘汰规则「最旧的先走」正好淘汰第 1 轮评审。用户按提示去详情窗对照「第 1 轮到底提了什么」,窗口没了 —— 两个功能在同一个方案里互相拆台。墓碑保住表头和结论,成本约 4 行。
- **被淘汰流带走的事件数必须累进 `droppedEvents(nodeId)` 并在界面上报出来。** `NodeDetail.tsx:203-206` 那条「两个数都要显示」的教训,本质是「不许让残缺的视图看起来完整」。
- 极端情况:40 个席位同时活着(理论上 `maxSeatsPerPhase` 默认 5,达不到)→ 上限对活流失效。这是明确的已知边界,写进 §13。

### `push` / `end` 的语义(v1 全部未定义)

- **`push` 到已 `closed` 的流:丢弃并 `dropped++`。** 场景真实:`runAgentAdapter.ts:189-199` 的 `Promise.race` 里 poll 赢了之后**不停 `work`**,`consume()` 要等生成器下一次 yield 才 break,provider 吐出的缓冲消息会在 `end()` 之后继续到达。不挡的话,一个「已完成」的窗口会继续冒新工具行,`toolCount` 还在涨而 `endedAt` 停在十分钟前。
- **`end()` 一条从未 push 过的流:照样创建。** 席位秒失败(provider 401,或 `runAgentAdapter.ts:94` 的已中断早退)时一条事件都没有,若 `end` 是 no-op,3 席面板只画 2 个窗口 —— **失败恰恰是最需要看见的**。这种流渲染成 `✗ 调用失败`。
- `end()` 幂等。

### resume 语义

`efftask.tsx:567` 每次挂载新建 store,`/et --resume` 拿到的是磁盘上的节点树 + **空 store**。若不特殊处理,一个上次跑了 40 分钟的 ACCEPTED 节点会渲染成 `emptyHint`,也就是「这个节点什么都没干」—— 和 §7 自己立的规矩(不许让残缺的视图看起来完整)正面冲突,而且是极端版:全部缺失,报成「没有」。

处理:resume 时调 `markHistorical(已有节点 id)`。这些节点的窗口区渲染固定文案:

```
本节点的输出属于上一次运行。事件流只存在内存中,不落盘,所以看不到历史。
```

reseat 重开的活动态节点会从**当前环节**开始产生新流(于是「分析、评审空,执行有窗口」),文案同样成立。

### `events` 数组必须换引用

`chunkBuffer.ts:66,74` 每次 push 都 `buf.set(nodeId, [...cur, ...incoming])` —— **新数组**。若新模块写成 `state.events.push(e)` 原地追加,数组引用永不变,任何 `React.memo` / `useMemo([streams])` 会**永远显示第一帧**。契约写死:`push` 替换数组引用(或维护 `version` 并让 `streams()` 返回浅拷贝)。

### `chunkBuffer.ts` 删除的爆炸半径(v1 的 grep 声明是错的)

| 文件 | 处理 |
|---|---|
| `src/tools/efftask/chunkBuffer.ts` | 删除 |
| `src/tools/efftask/chunkBuffer.test.ts` | 迁移(见 §11) |
| `src/commands/efftask/efftask.tsx:55, 567, 853, 1278, 1290` | import / `useRef` / push / `RunningView` prop / `DoneView` prop |
| `src/commands/efftask/TaskTreePanel.tsx:6, 119, 195-196` | import / prop / `lines()` `dropped()` |
| `src/commands/efftask/NodeDetail.tsx:112-115, 136-139, 195-214` | 两个 prop + 整个尾窗块 |
| `src/commands/efftask/effTaskViews.test.tsx:21, 66, 76` | 三条接线测试 |
| `src/commands/efftask/TaskTreePanel.test.tsx:430, 460, 552, 564` | 四条 |
| **`src/commands/efftask/wiringCoverage.test.ts:125`** | **源码文本闸门** `expect(SRC).toMatch(/<RunningView[^>]*\bchunks=\{chunks\.current\}/)` —— 改名即红,且红得毫无提示性 |

---

## 六、接线改造(逐点,每点都有独立接线测试)

1. **`RunAgentFn`(`roundtable.ts:7`)**:`onChunk?: (t: string) => void` → `stream?: StreamHandle`。
2. **`runAgentAdapter.ts`**:消息循环里对**每一条**消息提取事件。try/catch 的层次是硬要求:

```ts
for await (const message of invoke()) {
  collected.push(message)
  if (req.stream) {
    // 必须包住 eventsFromMessage 本身,不能只包 push。
    try { for (const e of eventsFromMessage(message, briefResolver)) req.stream.push(e) }
    catch { /* 渲染层的错不能带走这次调用 */ }
  }
  if (req.signal.aborted || timedOut) break
}
```

裹错层的后果不是「窗口空了」:异常从 `for await` 逃出 → `consume()` reject → **`collectText(collected)` 永不执行**,模型已经答完的内容全丢 → 席位判 infra(`roundtable.ts:151-158`)→ `roundtableWithInfraRetry` 重试 3 桌(15 次真实调用)→ 节点 BLOCKED,理由写「角色调用失败」。**一个只负责画字符串的函数把评审关口打死了,而且原因指向完全错误的方向。**

3. **`end()` 挂在 `makeRunAgentFn` 的 `finally`**(`runAgentAdapter.ts:200-204`)。这是**唯一**所有模型调用必经的点,正常返回 / 抛出 / 超时 / 中断四条路径全覆盖。v1 只挂在 `runRoundtable`,而走 `runPhase` 的 6 处(分析圆桌 `:715`、融合 `:741`、精化 `:810`、观察评分 `:1174`、冲突解决 `:1369`、执行 `:1614`)加 `rootPlan.ts:94` 全都不会收口 —— 表头永远 `◐ 运行中`,而且这些流永远不可淘汰,§5 的上限对超过三分之一的流失效。
4. **`runRoundtable`(`roundtable.ts:130-137`)**:`mapWithinPool` 的回调签名是 `(item, index)`(`slotPool.ts:62-66`,两条路径都传了 `i`),现在只用了 `role =>` 一个形参。改为按 `index` 开句柄。`round` 已经是入参(`roundtable.ts:78`)。`model` 也拿得到:`roleModels.ts:63-70` 的 `annotateRoleModels` 已把 `RoleBinding.model` 填成**实际生效**的模型。
5. **`runPhase`(`pipeline.ts:227`)增加第三个参数 `meta: StreamMeta`**,6 个调用点各自显式传 —— 尤其**分析不是单席位**:`:713` 圆桌 N 席并行、`:741` 融合席、`:810` 精化 N 席、`:1174` 评分 N 席。v1 写「单席位调用(分析/执行)`seat: 0`」会让 5~6 个员工的输出挤进一条无署名的流,**原样复刻 §1 抱怨的那个缺陷**。
6. **`PipelineCtx`(`pipeline.ts:86`)**:`onChunk` → `openStream?: (meta: StreamMeta) => StreamHandle`。
7. **`orchestrator.ts:46/146`** 与 **`runOrchestrator.ts:50/175`** 两跳都要改。后者 v1 漏了。
8. **`efftask.tsx:853`**:`chunks.current.push(...)` → `streams.current.open(meta)`。
9. **`rootPlan.draftRootPlan`** 增加可选 `stream`,`efftask.tsx` 起草时接上(`phaseLabel: '根方案'`, `nodeId: '__pre__'`)。
10. **`extractJson`(`efftask.tsx:294`)** 已经是 `RunAgentFn` 形状,同一个 seam 接上(`phaseLabel: '需求解析'`)。
11. **等待屏挂载点**:
    - `phase === 'drafting'`(`efftask.tsx:1213-1221`,现在渲染 `MessageView`)—— **不是 `ConfirmRootPlan`**,后者在 `:1223` 的 `confirmRoot` 分支,只在起草**结束之后**才挂载,把窗口挂那里等于「等完了才给你看等待过程」。
    - `phase === 'parsing'`(`efftask.tsx:1170/1260` 的 `ParsingView`)。
    - 两屏的窗口都是 `isActive={false}`(只读):`MessageView`(`efftask.tsx:1244-1257`)自己有 `useInput` 吃回车/q/Esc。等待屏只需要能看,不需要能滚 —— 这是明确的取舍,写在这里。

---

## 七、渲染层

### `src/commands/efftask/logView.ts`(新,全纯函数)

```ts
export type LogColor = 'success' | 'warning' | 'error' | 'inactive' | undefined
export interface LogLine { text: string; color?: LogColor; dim?: boolean; bold?: boolean; streamIndex: number; isHeader?: boolean }

export function renderStreamLines(args: {
  streams: StreamState[]; folded: ReadonlySet<number>; selected: number
  nowMs: number; width: number; droppedEvents: number; historical: boolean
}): LogLine[]

export function scrollWindow(total: number, height: number, offset: number): { from: number }
export function scrollbarColumn(total: number, height: number, from: number): string[]
export function wrapDisplayWidth(s: string, width: number): string[]
export function logPaneAction(input: string, key: Key): PaneAction | null
```

**颜色只用主题键。** vendored Ink 里裸色名解析成 `undefined`,所以 `LogColor` 是封闭联合,类型卡住。

### 折行按显示宽度,不是码点

仓库有现成的:`src/ink/stringWidth.ts`(基于 `get-east-asian-width`,15+ 个组件在用),以及 **已从 `src/ink.ts:85` 导出的 `wrapText`**(`src/ink/wrap-text.ts:9-13` 专门处理了宽字符跨界)。

按码点折行的后果是叠加的:本功能内容 99% 是中文,100 个汉字按码点算「宽度 100」实际占 200 列;而 `src/ink/components/Text.tsx:132` 默认 `wrap` → 这一行被 Ink 回流成 2 个终端行 → (a) `scrollWindow` 算出的 height 行实际打印 2×height 行,把 `NodeDetail` 的边框和下面的 Section 挤出屏幕;(b) 滚动条的 thumb/start 按 `total`/`height` 算,而真实可见行数不是 `height`,**滚动条位置是错的**,且它是窗口唯一的位置指示。

硬不变量:**一条 `LogLine` = 一个终端行**。实现上 `wrapDisplayWidth` 用 `stringWidth` 折,渲染时每行 `<Text wrap="truncate-end">` 兜底。折行的**续行前缀**对齐到内容列(真实终端就是这么做的)。

### 每个流长什么样

展开:

```
▾ 执行 · 甲员工 (opus)                    ◐ 运行中 · 12 工具 · 42s
│ 我先读一下现有实现,确认接口形状。
│ ✻ 思考 3 段
│ ⏺ Read(src/tools/efftask/pipeline.ts)
│   ⎿ 2076 行…
│ ⏺ Bash(bun test src/tools/efftask)
│   ⎿ 1461 pass, 0 fail
│ ⏺ Edit(src/tools/efftask/agentStream.ts)
│   ⎿ 报错: 找不到文件                        ← error 色
```

折叠:

```
▸ 质疑讨论 · 乙员工 (sonnet)              ● 已完成 · 7 工具 · 31s
│ 最新: ⏺ Grep(onChunk)
```

- 表头 `bold`;状态色:运行中 `warning`、已完成 `success`、失败 `error`;选中行 `inverse`。
- `text` → 原样;`thinking` → `✻` + dim;`tool` → `⏺` + warning;`result` → `  ⎿ ` + dim,`isError` 时 error。
- **连续 thinking 合并成 `✻ 思考 N 段`**(实测思考流会淹没工具调用,而用户第一位要看工具)。这是定论,**不给切换键**。
- 流内 `dropped > 0` → 该流首行 `… 更早的 N 条已滚出缓冲`。
- 节点级 `droppedEvents > 0` → 全局首行 `… 更早的 N 条输出已释放(含 M 个已收起的环节窗口)`。
- `historical` → 只渲染 §5 那句 resume 文案。

### 字形走仓库的降级常量

`src/constants/figures.ts:4-6`:

```ts
// The former is better vertically aligned, but isn't usually supported on Windows/Linux
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
export const TEARDROP_ASTERISK = '✻'
```

全仓 12 处消费 `BLACK_CIRCLE`,**没有一处裸写 `⏺`**;`figures` 包基于 `is-unicode-supported` 自动退 ASCII。所以:`⏺`→`BLACK_CIRCLE`,`✻`→`TEARDROP_ASTERISK`,`▾/▸`→`figures.triangleDownSmall/triangleRightSmall`,滚动条滑块→`figures.square`(`█` 全仓无先例,且可能被终端按宽度 2 渲染,与折行问题叠加会整列错位)。`⎿`(`MessageResponse.tsx:22`)和 `│` 有裸用先例,保留。

### 滚动条

右侧一列,轨道 `│`(dim),滑块 `figures.square`:

```
thumb = max(1, round(height * height / total))
start = total <= height ? 0 : round(from * (height - thumb) / (total - height))
```

`total <= height` 时整列渲染空格(**不画轨道**)—— 有滚动条却滚不动会让人以为界面卡了。

---

## 八、`AgentLogPane` 与按键

```tsx
export function AgentLogPane(props: {
  streams: StreamState[]; droppedEvents?: number; historical?: boolean
  height: number; width: number
  isActive?: boolean
  emptyHint?: string
  onState?: (s: { offset: number; folded: number[]; selected: number }) => void  // 仅供测试观测
}): React.ReactElement
```

状态:`folded`、`offset`、`follow`(默认 true)、`selected`。全部走 `useLiveState`(`src/commands/efftask/useLiveState.ts`)—— 那个文件里写清了原因:vendored 渲染器把一个 stdin chunk 拆成多个 InputEvent **同步**派发,而 `useInput` 的 handler 只在 commit 后的 `useLayoutEffect` 里换,一次按下两个键时第二个键跑的是上一帧的闭包。这个窗口的按键密度比启动关口高得多。

### 折叠的默认值(v1 没定义)

**默认只展开「运行中」的流(`endedAt` 为空),其余折叠。** 定死这条之后:

- 一打开详情不会是几千行,也不用按 24 次空格;
- v1 的 `a`(全折叠/全展开)是这个默认值没想清楚的补丁,**删掉**;
- v1 的 `t`(思考显示切换)为一个已经定论的问题造键位,**删掉**。

### 按键必须是纯函数,且要处理连击合批

`src/ink/parse-keypress.ts:281` 对 `text` token 直接 `keys.push(parseKeypress(token.value))`,**一个 token 可以是多字符**。仓库两处明确记过:`REPL.tsx:4235-4237`「Held-key batching: tokenizer coalesces to 'nnn'」;`ScrollKeybindingHandler.tsx:889-892` 的既定写法是

```ts
// Bare letters. Key-repeat batches: only act on uniform runs.
const c = input[0]; if (!c || input !== c.repeat(input.length)) return null
```

`TaskTreePanel.tsx:158-159` 今天就有这个 bug(按住 j 得到 `'jjj'` → 什么都不发生)。而「按住 ↓ 翻到底」是日志窗的主用法。

所以抽出纯函数:

```ts
export type PaneAction =
  | { t: 'line'; d: number } | { t: 'halfPage'; d: number }
  | { t: 'top' } | { t: 'bottom' } | { t: 'nextStream' } | { t: 'toggleFold' }
export function logPaneAction(input: string, key: Key): PaneAction | null
```

- `j`/`k` 按 uniform-run 判定,步进 = `input.length`(非幂等);
- `g`/`G` 幂等,只走一次;**`G` 要双写** —— kitty 协议终端给的是 `input='g', shift=true`,legacy 终端给 `input='G', shift=false`(`ScrollKeybindingHandler.tsx:938-940`);
- 其余键返回 `null`。

| 键 | 行为 |
|---|---|
| `↑` / `k` | 上滚(关 follow) |
| `↓` / `j` | 下滚;到底恢复 follow |
| `PgUp` / `ctrl+u` | 上滚半屏 |
| `PgDn` / `ctrl+d` | 下滚半屏 |
| `g` / `G` | 顶部(follow off)/ 底部(follow on) |
| `Tab` | 选中下一个流并滚进视野 |
| `空格` | 折叠/展开选中的流 |

**刻意不占用 `Esc` / `q` / `回车`** —— 归 `TaskTreePanel` 详情视图(返回任务树)。`use-input.ts:83-89` 把 listener 注册在 mount,`isActive` 在 handler 内部判(`:70-72`),**不做 stopPropagation**,所以两个 handler 都会收到每个键;`TaskTreePanel.tsx:148-156` 的详情分支对其余键早退且不消费。不冲突靠**键位不重叠**保证。

### 上层抢键:一个真实缺口

逐个键 grep 过 REPL 的绑定,`/et` 挂载时它们**都不活跃**,因为 `PromptInput.tsx:244` 的 `isModalOverlayActive` 含 `isLocalJSXCommandActive` → prompt 失焦,而 `ScrollKeybindingHandler`(`REPL.tsx:4569`)的 `isActive` 要求 `isFullscreenEnvEnabled()`,`fullscreen.ts:128` 默认 false。

**但 `CLAUDE_CODE_NO_FLICKER=1` 是文档化的开关**(`fullscreen.ts:115-116`)。打开后 `REPL.tsx:4541-4549` 把所有 local-jsx 搬进 modal slot,`:4569` 的 `ScrollKeybindingHandler` 变 active → **PgUp/PgDn 会同时滚外层 ScrollBox 和本窗口**,视觉上跳两下。处理:`isFullscreenEnvEnabled()` 为真时本窗口不绑 PgUp/PgDn,只留 `ctrl+u`/`ctrl+d` 与 `j/k`。

### 为什么不用 `ScrollBox`(v1 完全没评估)

答案是二分的:

- **非全屏(本 fork 默认,`fullscreen.ts:128` `USER_TYPE === 'ant'`)**:`src/ink/components/ScrollBox.tsx:79-80` 自己写着 "Works best inside a **fullscreen** (constrained-height root) Ink tree",且它**不从 `src/ink.ts` 导出**,消费者只有 `FullscreenLayout.tsx` 和 `design-system/Tabs.tsx`。**自绘切片是对的。**
- **全屏**:仓库既有模式是 `design-system/Tabs.tsx:210` —— 有 `modalScrollRef` 就用 `ScrollBox`,没有就退化成定高 + overflow。`/et` 在全屏下确实落在那个 slot 里。

本次**只做自绘**,全屏下复用外层滚动的可能性写进 §13 已知缺口,不在本次实现。

### 刷新:订阅 + 合批,不是盲轮询

v1 说「400ms tick,Ink 会 diff,相同帧不写终端所以不闪」——**结论不成立**。`src/components/OffscreenFreeze.tsx:12-14` 写着:

> Any content change above the viewport forces log-update.ts into a full terminal reset (it cannot partially update rows that have scrolled out). **For content that updates on a timer — spinners, elapsed counters — this produces a reset per tick.**

`ShellProgressMessage.tsx:65/138` 正因此把整个进度块裹进 `<OffscreenFreeze>`,源码注释记的实测是 **1s tick 在 29 行终端 + 4000 行历史下 10 分钟产生 507 次整屏重置**。而表头带 `· 42s`,帧根本不相同。

所以:

1. `AgentLogPane` 与 `TaskTreePanel` 都裹 `<OffscreenFreeze>`;
2. **不引入 400ms 轮询**。改成 `store.subscribe()` + 250ms 合批:静默期**零重绘**(比今天的 1s 轮询更省),有事件时 ≤250ms 上屏;
3. 表头的秒数另有 1s 心跳,且**仅当该节点有活流时**;
4. 树视图的活动行留在现有 1s tick —— 那里是**采样**不是逐条,写进 §9。

---

## 九、任务树上的活动行

运行中的行下面加一条 dim 行:

```
❯ ▾ ◐ 实现事件模型 [EXECUTING] 42s
      ⎿ 执行·甲 ⏺ Bash(bun test src/tools/efftask)
```

**行预算按行结算,不用 v1 的公式。** v1 的

```ts
rowBudget = Math.max(3, height - Math.min(runningRows, Math.floor(height / 3)))
```

两头都错:`height=20`、100 个节点全在跑 → `rowBudget=14`,而这 14 行**全是运行中的** → 实打印 28 行,超 8 行;反方向,切片里一个运行中都没有时照样白扣 6 行,树永久少显示 6 个节点。

正确做法:从 `viewport()` 的 `from` 开始逐行累加(运行中记 2,其余记 1),累计到 `height` 为止。这是一个纯函数 `budgetRows(rows, from, height)`,单测直接钉。

活动行的内容取该节点**最近一条**流的最后一个 `tool` 事件;没有则不画。1s 采样会跳过短工具调用,这一点在界面上不承诺「逐条」。

---

## 十、评审收敛

### 10.1 触顶时开一次关口,而不是打死运行

这是本次对 (B) 的**主要**修复。spec `2026-07-25-…-design.md:394` 规定的就是这个,机器是现成的(`startupConfirm.ts:392 raceConfirm` / `:382 createResolveOnce` / `:375 ConfirmSurface`),先例是现成的(`ConfirmRootPlan.tsx:15-19` 的 `redraft{feedback}`,且不 latch,可反复)。

`pipeline.ts:982-985` 现在是:

```ts
if (node.iteration.planReview >= caps.maxIterations) {
  await blockWithReason(node, `评审迭代超限(${caps.maxIterations}): …`, ctx, 'cap-iteration'); return
}
```

改成:先问,再决定。

```ts
export type ExhaustedDecision =
  | { kind: 'more'; feedback?: string }   // 补充说明后再评一轮(重置 1 轮预算)
  | { kind: 'accept' }                    // 越过评审,采纳当前方案继续
  | { kind: 'stop' }                       // 今天的行为
// PipelineCtx:
onReviewExhausted?: (info: { node: TaskNode; items: FeedbackItem[]; max: number }) => Promise<ExhaustedDecision>
```

- **未接 handler(headless / 非交互 / 测试)→ 默认 `stop`,与今天逐字节相同。** 这条保证现有全部测试与 headless 路径行为不变。
- `more`:`node.iteration.planReview` 减 1(只买一轮,不是清零),`feedback` 并入下一轮的方案提示词。用户的自由文本走 `guidanceSection` 同一条路(`parseResumeArgs.ts:48` 已经证明 `--retry-blocked <补充说明>` 这条链是通的)。
- `accept`:`node.kind` 按当前方案定,走正常路由继续。**必须留痕** —— `noteOnNode(node, '用户越过方案评审(第 N 轮)。当时未解决的阻断意见: …')`,并且 `notifyValve` 发一张说明这件事的卡片。这不是可选项:整个 `/et` 的价值就在于那几道关卡是真的,越过了就必须写在 `node.md` 上让事后追责看得见。
- `stop`:原样 `blockWithReason(..., 'cap-iteration')`。

TUI 侧新增 `ConfirmReviewExhausted`(形状抄 `ConfirmRootPlan`):运行中的树上方浮出一屏,三选一 + 自由文本输入。其他节点**继续跑**,不阻塞。

飞书侧:若 `store.getState().feishuClient` 存在,发一张**告知**卡片说「终端里有一个待确认的关口」。**不做飞书端回执** —— `escalation.ts:197` 的 `buildBlockCard` 现在没有回执通道,补一条完整的双端竞速是另一件事的体量。这是明确的取舍,不假装做了。

### 10.2 `src/tools/efftask/reviewConvergence.ts`(新,全纯函数)

```ts
export interface FeedbackItem { text: string; role: string; rounds: number[] }
export function feedbackItems(log: RoundtableRecord[]): FeedbackItem[]
export function stuckItems(items: FeedbackItem[], minRounds = 2): FeedbackItem[]
export function planFeedbackPrompt(items: FeedbackItem[]): string
export function reviewRepeatNotice(items: FeedbackItem[], round: number): string
export function exhaustionReason(items: FeedbackItem[], max: number): string
export function exhaustionRemedy(items: FeedbackItem[]): string
export function similarItem(a: string, b: string): boolean
```

**从结构化 `verdicts` 取,不拆 `blockingSummary`。** `synthesizeVerdicts` 用 `'; '` 拼串,反过来切是有损的(用户这次撞到的第三条本身就含冒号和引号)。`node.reviewLog[].verdicts[].blocking[]` 是已落盘的结构化数据。

### 10.3 相似度:v1 的阈值实测两头都错

评审按 v1 算法(归一 + 字符二元组 Jaccard,阈值 0.75,外加「互相包含」)实跑:

| a | b | Jaccard | v1 判定 | 真相 |
|---|---|---|---|---|
| 评分等级与分数的映射规则未定义 | 评分等级到分数的映射规则没有定义 | 0.526 | 不重复 | **同一条,漏判** |
| 评分等级(A/B/C/D)与具体分数的映射规则未定义 | 方案没有说明 A/B/C/D 四个等级各自对应多少分 | 0.111 | 不重复 | **同一条,漏判** |
| …返回**超时**时的重试策略与退避算法 | …返回**错误**时的重试策略与退避算法 | 0.786 | 重复 | **两条,误判** |
| 缺少回滚方案 | 缺少回滚方案的验证步骤,且回滚脚本未提供 | 0.294(互相包含) | 重复 | **两条,误判** |

定稿规则:

1. 归一:去空白、去中英标点、小写、全角转半角。
2. **归一后为空的条目直接排除出比较**(不参与、也不被匹配)。`parseOutput.ts:284-287` 只滤空串,`"   "` 和 `"……"` 活得下来;而 `''` 是任何字符串的子串,v1 规则下**一条纯标点的阻断项会把全部意见合并成一组「连续 3 轮未解决」**。
3. 包含判定加长度下限:`min(len) >= 8 且 min/max >= 0.6` 才允许。
4. 二元组 Jaccard 阈值 **0.50**,**并且**要求差异集小:`symmetricDiff.size <= 6`。两个条件同时满足才判重复 —— 前者接住同义改写(0.526 / 0.11 那两行里第一行会被接住),后者挡住长模板句里 2 个字的语义翻转(0.786 那行会被挡掉)。
5. 阈值与差异上限都导出为常量。

### 10.4 §12 关于「误判无害」的说法是错的,这里改正

v1 写「误判方向是少提示一次,不改判定」。核对 §10 的使用点,两处不成立:

1. `exhaustionRemedy` 按 `stuckItems` 是否为空**分叉**。误判(把两条不同意见合并)→ 告诉用户「提高 `maxIterations` 大概率还是同样结论,先改需求」,而事实是「每轮意见都不同」,正确建议恰恰**相反**。在运行刚被打死那一刻给出反向建议,比不给建议更糟。
2. `reviewRepeatNotice` 会对评审员说「以下意见前几轮已提过……若新方案已回应请判通过」。把一条**第一次提出**的意见谎报成「已提过」,是在直接推动评审员放行 —— 它走的是提示词,但改的是**裁决**。

所以规则要往「宁可漏判」一侧偏(漏判只是少一句提示),并且 `stuckItems` 要求 `rounds.length >= 2` 才进 stuck 组。这条写进 §13 风险表的正确版本。

### 10.5 提示词三处

1. **方案提示词**:`planFeedbackPrompt(items)` 取代「最后一轮的拼接串」:

```
前 3 轮评审共提出 5 条阻断意见,按轮次汇总:
【连续 3 轮未解决】(必须逐条明确回应:要么在方案里解决,要么写明为什么不适用)
  1. [main] 评分等级(A/B/C/D)与具体分数的映射规则未定义
【本轮新增】
  2. [main] 验收标准表述存在逻辑矛盾:…
```

2. **评审提示词**:`reviewPrompt` 现在**完全看不到历史**(`pipeline.ts:490-492` 只吃 `node.plan`),这是单边失明。附上 `reviewRepeatNotice(items, round)`。
3. **触顶话术**:`exhaustionReason` / `exhaustionRemedy`;`escalation.ts` 的 `BlockEscalation` 加可选 `remedy?: string`,卡片与 `blockReasonWithRemedy` 用 `e.remedy ?? REMEDY[category]`,静态表保留兜底,其他类别不受影响。

注:现有那句 `escalation.ts:81` 并不「错」,它是**不完整** —— 后半截「否则先按评审意见改需求或补充信息」一直都在。要改的是「静态一句话没法按事实分叉」。

---

## 十一、测试策略

三条硬规矩(仓库既定):

1. **`bun test` 是唯一门禁**(没有 typecheck)。
2. **每个修复都要变异测试**。存活的变异**通常是探针坏了**而不是覆盖率缺口 —— 先查:变异是否根本没编译(比对 pass 数 / SyntaxError)、是否语义 no-op、`grep -c` 是否命中了错误的出现位置、断言是否被别的词满足。
3. **接线单独测**(本项目已两次「函数写对、单测全绿、生产里线是断的」)。

### 夹具选择(v1 只挡了一半)

- `runnerMount.test.tsx:64-71` / `effTaskViews.test.tsx:33-40` 的 `write(s){out+=s}` **只累积不 reset** → `not.toContain` 几乎恒真。
- `TaskTreePanel.test.tsx:42` 有 `reset()`,但 `src/ink/ink.tsx:586` 走 `this.log.render(prevFrame, frame)` **只写 diff** → reset 之后的正向 `toContain` 只在那行恰好被重绘时成立。

结论:**滚动位置在 `frames()` 里不可观测**。所以:

- 按键语义靠纯函数 `logPaneAction` 钉死;
- 组件测试用 `reset()` 夹具,断言必须是「按键后**新出现**的那一行文本」(diff 一定会写它),不是「某行消失」;
- 「不吃 Esc/q/回车」改成正向测:父级挂一个 `useInput` 计数器,断言按 Esc 后父级 +1 且 `onState` 报回的 `offset` 未变。

### 新增/修改的测试

| 文件 | 覆盖 |
|---|---|
| `agentEvents.test.ts` | 四类事件;`m.message.content` 路径(**夹具必须用 `createUserMessage()` 与真实 assistant 形状,禁止手搓 `{type:'user',content:[…]}` 字面量** —— 手搓会让实现和测试一起错、一起绿);按行拆;空/纯控制字节丢弃;ESC 剥离;码点截断;各工具摘要;**生成式敌意输入**(仿 `hostileDisk.test.ts`:`[null,123,-1,0,'s',true,'',[],[null],['x'],{},循环引用,Object.create(null),深嵌套]` 轮流塞进 `input`/`thinking`/`content`,断言一次都不抛) |
| `agentStream.test.ts` | 三层上限;墓碑保留表头+末 3 条;活流不淘汰;`droppedEvents` 累计被淘汰流带走的量;push-after-close 丢弃并计数;`end()` 建空流;`end()` 幂等;引用换新;`label` 空串;注入时钟 |
| `logView.test.ts` | 折叠/展开;思考合并;`scrollWindow` 钳位;滚动条数学(含 `total<=height` 不画轨道);**`wrapDisplayWidth` 喂 15 个汉字 width=20 必须产出 2 行**(换成 `Array.from().length` 要变红);`budgetRows`(全部运行中时总行数 ≤ height);`logPaneAction` 的 uniform-run 与 `G` 双写 |
| `AgentLogPane.test.tsx` | follow 语义;`Tab`/空格;不吃 Esc/q/回车(正向测) |
| `reviewConvergence.test.ts` | §10.3 那张表逐行;归一为空不匹配一切;包含规则的长度下限;两种 remedy 分叉;`rounds.length>=2` 才进 stuck |
| `reviewExhausted.test.ts` | 未接 handler → 与今天逐字节相同;`more` 只买一轮;`accept` 在 `node.execStatus` 留痕且卡片说了;`stop` 走原路 |
| 扩充 `runnerMount.test.tsx` | 需 `mock.module('../../tools/AgentTool/runAgent.js')`(`call()` 内部造 `runAgent`,`efftask.tsx:223`,无注入口)。断言:store 收到事件、`NodeDetail` 渲染出工具行 |
| 扩充 `wiringCoverage.test.ts` | 改 `:125` 的源码闸门;新增 `runOrchestrator.ts` 透传、6 个 `runPhase` 调用点各自传了不同 `phaseLabel`/`label`、`drafting` 与 `parsing` 两屏挂了窗口 |
| 迁移 `chunkBuffer.test.ts` | 5 条直迁(环形有界 / dropped / 空节点读作 `[]` / 码点截断 / 剥控制字节);2 条改写后必须仍绿(丢空白、纯控制字节不留空行);1 条改成节点级预算断言(`MAX_EVENTS_PER_STREAM * MAX_STREAMS_PER_NODE` 与 `MAX_TOTAL_EVENTS` 的关系);新增「一条消息产生的事件数 > 单流上限」 |

### 只能靠人眼的(写出来,合入前必须真跑一次 `/et`)

滚动条与内容的列对齐;`inverse` 选中行在真终端的观感;整屏重置的实际闪烁;字形在 Windows Terminal 的样子。

---

## 十二、`NodeDetail` 的高度预算(v1 没定义)

`NodeDetail.tsx:127-136` 现在 13 个 Section 共享一个 `budget`,日志区是 `max(6, budget/2)`。换成 N 个可折叠流之后必须重新分配,否则重演 `:127-131` 注释里记的那次(标题和目标被挤出屏幕):

- 日志窗打开时,其余 Section 各收缩到 2 行(`目标`/`完整方案` 保 3 行);
- 日志窗高度 = `max(8, budget - 已分配)`;
- 依赖区保留现有的 `budget/3` 特权(它回答的是「我在等谁」)。

---

## 十三、风险与已知边界

| 项 | 状态 |
|---|---|
| 内存 | 三层上限 + **全局 20000 事件**钉死总量(≈5~14 MB),与节点数无关;墓碑保证淘汰不撒谎 |
| 40 个席位同时活着 | 上限对活流失效。默认 `maxSeatsPerPhase=5`,达不到;**已知边界,不设兜底** |
| `CLAUDE_CODE_NO_FLICKER=1` | 全屏下 PgUp/PgDn 会与外层 ScrollBox 双滚 → 该模式下本窗口不绑这两个键 |
| 全屏下复用 `modalScrollRef` + `ScrollBox` | **本次不做**,记为缺口 |
| `cliAgentRunner` 无流式输出 | 不在 `/et` 可派发范围内,**已知缺口** |
| `--resume` 后历史窗口为空 | 以固定文案兑现,不伪装成「什么都没干」 |
| 相似度误判 | 规则偏向**漏判**;误判会让 `exhaustionRemedy` 给反向建议、让 `reviewRepeatNotice` 谎称已提过(v1 说「不改判定」是错的,已改正) |
| 触顶关口的飞书端 | 只发告知卡片,**不做回执竞速**;终端是唯一决策端 |
| 树上活动行 | 1s 采样,不承诺逐条 |

## 十四、安全约束(项目既定)

按用户既定要求:**不做安全性约束加固,API Token 明文写在 `.claude/settings.json` 即可**。评审时不得提「明文密钥」类问题。本方案不新增任何密钥读写路径。
