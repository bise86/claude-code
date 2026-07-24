# 高效任务模式 (Efficient Task Mode) 设计方案

> Status: **Approved for planning** (2026-07-25). Source of truth for the implementation plan.

## Goal

新增一个 slash 命令 `/et`,进入"高效任务模式":把用户提示词整理成一个**方案任务树的根节点**,由一个确定性编排引擎递归拆分/执行,节点间有依赖门控,可并行执行(默认 5),每个方案经多角色圆桌评审、每个执行经多角色验收,可选观察角色打分。任务树以镜像目录/`.md` 文件形式持久化在当前目录。全部人工确认(启动关口 + 工具权限)复用已完成的**飞书确认卡片 + 终端竞速器**。

## Architecture (2-3 句)

一个确定性 TypeScript 编排引擎(orchestrator)拥有任务树、依赖调度、并发池(默认 5)、md 持久化;每个节点的"方案制定 / 评审 / 执行 / 验收 / 评分"阶段是对模型或 settings 里 `roles` 的一次 `runAgent()` 调用。任务树不是一次规划完成,而是在执行过程中由节点动态生长(节点可向树的任一位置加子节点)。并行执行的节点各自在独立 git worktree 中作业,验收通过后合并回一条集成分支。

## Tech Stack

- Bun + TypeScript,Ink TUI(现有栈)。
- 复用:`src/commands/*`(local-jsx 命令)、`src/tools/AgentTool/runAgent.ts`(直接派子 agent)、`src/tools/AgentTool/roles/`(角色系统)、`src/hooks/toolPermission/handlers/interactiveHandler.ts` + `src/services/feishu/*`(确认竞速器 + 飞书)、`.claude/` 项目本地约定、`git worktree`(isolation)。
- 测试:`bun test`(注入假 `runAgent` / 假 fs / 假 git,不打真模型)。

## Global Constraints (每个任务隐含包含)

- **不做安全约束阻碍**:API Token 等直接明文写在 `.claude/settings.json` 的 `roles` 里(复用现有 roles 系统);不引入 `env:` 间接、不做密钥脱敏。安全要求不得成为功能实现的阻碍。
- **不 `feature()` 门控**:本 fork 运行时 `feature(...)` 恒为 false,门控会让代码变死代码。`/et` 命令与相关代码路径**直接生效**,不加 `feature()` 包裹(镜像飞书功能的做法)。
- **确认统一走竞速器**:所有需要人确认的关口(启动三关 + 中途升级 + 工具权限)都通过现有 `interactiveHandler.ts` 竞速器,同时发飞书卡片,首个响应者胜出并同步另一端状态。不得新造一套确认通道。
- **确定性硬控制**:并行数(默认 5)与依赖门控由 TS 引擎硬保证,不交给模型自由裁量。
- **圆桌合成 = 独立并行 + 全票通过**:评审/验收多角色并行独立出意见,任一角色提阻断问题即不通过。
- **并行隔离 = 每执行节点独立 git worktree**,验收通过后合并回集成分支。
- **不静默截断**:触发任何安全阀(深度/节点数/迭代/超时上限)一律暂停并升级人工(飞书),不得悄悄丢弃工作或谎报完成。
- **TUI-only**:该模式只在交互式 TUI 下工作;`--print` headless 非目标(与飞书功能一致)。

---

## Terminology

- **Run**:一次 `/et` 触发产生的整棵任务树 + 配置 + 集成分支,有唯一 `run-id`。
- **Node(节点)**:树的一个单元,有状态机、`kind`、依赖、方案内容,持久化为一个目录含 `node.md`。
- **Phase(阶段)**:节点生命周期里的一步——`方案制定(plan)` / `方案评审(review)` / `任务执行(execute)` / `任务验收(accept)` / `观察评分(observer)`。
- **Role(角色)**:settings 里 `roles` 的一项(api/cli 两种 execMode),或"主模型"。每个阶段绑定一个或多个角色。
- **Orchestrator(编排器)**:驱动一个 Run 的确定性 TS 引擎实例。

---

## 1. 命令与入口

- 新命令:`src/commands/efftask/index.ts`,`type: 'local-jsx'`,`name: 'et'`,`aliases: ['efftask']`,注册进 `src/commands.ts` 的 `COMMANDS()` 数组。
- 实现:`src/commands/efftask/efftask.tsx`,`load()` 返回 `{ call }`;`call(onDone, context, args)` 里:
  1. 解析 `args`(用户提示词)→ 建议配置(见 §3)。
  2. 渲染启动确认 UI(见 §2),并发飞书卡片。
  3. 确认后创建 Orchestrator 实例,注册为后台任务(`src/tasks/` 的 LocalAgent 风格,见 §10),渲染实时树面板。
- 该命令**同时对模型可发现**是非目标(不需要模型来触发);仅供人用 `/et` 触发。因此不需要 `whenToUse`/prompt 变体。

## 2. 启动确认关口(仅此三关 + 工具权限)

运行前,把提示词解析出的建议配置向用户确认。三关一次性呈现在一个确认流里(终端 Ink + 飞书卡片竞速):

1. **角色名册(role roster)**:一张表,每行 = `{ 角色名, 背后模型, 承担阶段[] }`。阶段取值:`plan|review|execute|accept|observer`。`review`/`accept` 可绑定多个角色(圆桌);`plan`/`execute` 通常单角色但允许多个(取第一个为主)。未在名册出现的阶段 → 用**主模型**(当前会话模型)。名册可编辑后确认。
2. **并行数**:默认 5,可改(正整数,1..N)。
3. **根方案 + 初始任务树**:编排器先用 `plan` 阶段角色起草根节点的完整方案 + 顶层子节点拆分(仅第一层),渲染出来给用户确认/修改,再开始自主执行。

确认之后进入**自主执行**:多角色评审/验收由角色 agent 自动完成;人只在(a)工具权限请求、(b)安全阀升级、(c)无法自动解决的合并冲突时再被打扰。用户可随时中断整个 Run。

## 3. 提示词 → 建议配置(解析)

- 模块:`src/tools/efftask/parseDirectives.ts`。输入:原始提示词字符串。输出:`EffTaskConfig`:
  ```ts
  type PhaseName = 'plan' | 'review' | 'execute' | 'accept' | 'observer'
  type RoleBinding = { roleName: string /* settings role 名 或 'main' */; model?: string }
  interface EffTaskConfig {
    goalPrompt: string                       // 去掉指令后的核心需求
    parallelism: number                      // 默认 5
    phaseRoles: Record<PhaseName, RoleBinding[]>  // 空数组 = 用主模型
    caps: { maxDepth: number; maxNodes: number; maxIterations: number; nodeTimeoutMs: number; scoreThreshold?: number /* 默认 undefined=评分不触发返工 */ }
  }
  ```
- 解析策略:用一次**主模型**调用把自然语言指令(如"评审用 architect+security,执行用 coder,并行3,深度4")抽取成 `EffTaskConfig` 的**建议值**;解析出的角色名对照 settings `roles` 校验,不存在的角色名回退主模型并在确认表里标注。核心需求文本原样作为 `goalPrompt`。
- 解析只产生"建议",最终以 §2 用户确认为准。解析失败(模型没返回合法结构)→ 全部回退默认(并行 5、各阶段主模型)并照常进入确认。

## 4. 任务树与节点模型

### 4.1 节点状态机

```
CREATED → PLANNING → PLAN_REVIEW ──fail──▶ PLANNING(修订, 计入 iteration)
                         │pass
         ┌───────────────┴────────────────┐
     kind=decompose                    kind=executable
    生成子节点(deps)                  READY(等 deps 全 ACCEPTED)
   WAITING_CHILDREN                        │
         │(全子 ACCEPTED)              EXECUTING(独立 worktree)
   INTEGRATION_ACCEPT ──fail──▶ (回到 decompose 修订)   ├─运行中可加子节点 → WAITING_CHILDREN → 恢复
         │pass                                          EXECUTED → ACCEPTANCE ──fail──▶ REWORK(回 EXECUTING, 计 iteration)
         ▼                                                   │pass
      ACCEPTED ◀─────── MERGE(worktree→集成分支) ◀──── SCORING(observer, 可选) ◀──┘
   任意态 → BLOCKED(deps 失败 / 触阀 / 人工中止) → 升级人工
```

- `kind` 由该节点 `plan` 阶段产出决定:方案里声明"本节点拆为子节点 X/Y/Z(含依赖)"→ `decompose`;声明"本节点可直接执行,方案如下"→ `executable`。
- **依赖门控**:节点进入 READY/EXECUTING 的充要条件是其 `deps[]` 中所有节点状态为 `ACCEPTED`。根节点无依赖。
- **动态生长**:`executable` 节点在 EXECUTING 中可通过引擎 API `addChild(parentId, spec)` 向任意节点加子节点;父节点转 WAITING_CHILDREN,待新子节点 ACCEPTED 后恢复。`decompose` 节点在 PLAN 阶段一次性声明其直接子节点。二者都可在后续再追加(树"逐渐丰富")。
- **父完成条件**:`decompose`/有子节点的节点,在其所有子节点 ACCEPTED 后走一次 `INTEGRATION_ACCEPT`(对"子结果整体是否达成父目标"的圆桌验收),通过才 ACCEPTED。

### 4.2 节点数据结构(内存)

```ts
type NodeStatus =
  | 'CREATED' | 'PLANNING' | 'PLAN_REVIEW'
  | 'READY' | 'EXECUTING' | 'EXECUTED' | 'ACCEPTANCE' | 'REWORK'
  | 'WAITING_CHILDREN' | 'INTEGRATION_ACCEPT'
  | 'SCORING' | 'MERGE' | 'ACCEPTED' | 'BLOCKED'

interface TaskNode {
  id: string                 // 路径式,如 'root/01-design-api/02-routes'
  title: string
  parentId: string | null
  childIds: string[]
  deps: string[]             // 依赖的 node id(可跨分支)
  kind: 'decompose' | 'executable' | 'unknown'  // plan 前为 unknown
  status: NodeStatus
  phaseRoles: Record<PhaseName, RoleBinding[]>   // 继承自 Run 配置,可被本节点覆写
  plan: { solution: string; keyPoints: string; risks: string; acceptance: string }
  execStatus: string         // 执行状态记录
  reviewLog: RoundtableRecord[]
  acceptLog: RoundtableRecord[]
  score?: { plan?: ScoreRecord; exec?: ScoreRecord }
  worktree?: { branch: string; path: string }
  iteration: { planReview: number; acceptance: number }
  depth: number
  createdAt: string; updatedAt: string
}

interface RoundtableRecord {
  round: number
  verdicts: { role: string; pass: boolean; blocking: string[]; comments: string }[]
  synthesized: { pass: boolean; blockingSummary: string }
}
interface ScoreRecord { role: string; score: number; rationale: string }
```

## 5. 文件持久化(镜像任务树)

Run 目录:`.claude/efftask/<run-id>/`(`run-id` = 扫描 `.claude/efftask/` 下已有目录取最大序号 +1,零填充如 `001`/`002`;避免用时间戳做 id 以便测试确定性,创建时间单独存 frontmatter 字段)。目录树 = 任务树:

```
.claude/efftask/<run-id>/
  run.md                    # 名册/并行数/caps/原始提示词/状态 + 实时树快照(自动重写)
  root/
    node.md                 # 根方案节点
    01-design-api/
      node.md
      01-schema/  node.md
      02-routes/  node.md
    02-implement/
      node.md
```

- **节点 = 目录** `NN-<slug>/`,内含 `node.md` + 子节点目录。`NN` 为该父下的两位序号(保证顺序 & 唯一)。根节点目录名固定 `root/`。
- **`node.md` 格式**:YAML frontmatter + Markdown 正文。
  ```markdown
  ---
  id: root/01-design-api
  title: 设计 API
  parentId: root
  deps: []
  kind: decompose
  status: ACCEPTED
  phaseRoles:
    plan: [architect]
    review: [architect, security]
    execute: [coder]
    accept: [architect, security]
    observer: [scorer]
  score: { plan: 88, exec: 91 }
  worktree: { branch: efftask/<run-id>/root-01-design-api, path: .git/../.worktrees/... }
  iteration: { planReview: 1, acceptance: 0 }
  depth: 1
  createdAt: "..."
  updatedAt: "..."
  ---

  ## 完整方案
  ## 重点
  ## 风险点
  ## 验收点
  ## 执行状态
  ## 评审记录
  ## 验收记录
  ## 评分
  ```
- **读写模块**:`src/tools/efftask/persistence.ts`。函数:`writeNode(runDir, node)`、`readNode(path)`、`writeRunManifest(runDir, run)`、`loadRun(runDir)`(可从磁盘恢复整棵树)、`renderTreeSnapshot(run)`(写入 `run.md`)。经 `getFsImplementation()`(`src/utils/fsOperations.ts`)完成,便于测试注入假 fs。
- **id/deps 一致性**:`deps` 用节点 id 引用;`node.md` frontmatter 的 `id` 与其磁盘路径一致(路径即 id)。恢复时以磁盘为准重建内存树。

## 6. 编排引擎(确定性 TS)

模块:`src/tools/efftask/orchestrator.ts`。核心:`class EffTaskOrchestrator`。

- **依赖注入**(为可测):构造时注入 `{ runAgentFn, fs, git, now, canUseTool, toolUseContext }`。`runAgentFn` 封装 `runAgent()`;`git` 封装 worktree 操作;`now` 提供时间戳。
- **调度循环** `tick()`:找出所有 `READY` 且 `deps` 全 `ACCEPTED` 的可执行节点、所有待推进阶段的节点,在**不超过并发上限**的前提下发起下一步;每步完成后持久化并重渲染快照,再 `tick()`。空闲且无可推进节点且根 ACCEPTED → Run 完成。
- **并发池**:自持 `activeCount`,上限 = `config.parallelism`(默认 5)。占用发生在会真正并行的重活上——即 `EXECUTING`(worktree 内跑执行 agent)。评审/验收的多角色调用在单节点内并行,但受同一全局池约束,避免总并发爆炸。
- **每阶段 = 一次 `runAgent()`**:引擎直接调 `runAgentFn`(如 `executeForkedSlashCommand` 那样),而非依赖主模型发 AgentTool,以获得对并发/门控的硬控制。阶段角色按 `node.phaseRoles[phase]` 选择:
  - 有绑定 role → 用该 role 的 `agentDefinition`(execMode api/cli 均支持,复用现有派发)。
  - 空绑定 → 用主模型(会话模型)。
- **阶段产出解析**:每个阶段 agent 被要求以结构化片段返回(方案/裁决/评分),引擎解析写回节点;解析失败按该阶段失败处理(评审不通过 / 执行返工),计入 iteration。
- **动态加子节点 API**:`orchestrator.addChild(parentId, { title, kind?, deps?, phaseRolesOverride? })`——执行 agent 通过一个内部工具(仅在 `/et` 执行子 agent 上下文注入)调用,把新节点挂到树上并落盘。

## 7. 多角色圆桌评审 / 验收(独立并行 + 全票通过)

模块:`src/tools/efftask/roundtable.ts`。

- **评审(PLAN_REVIEW)**:对 `node.phaseRoles.review` 里每个角色**并行独立**发起一次评审 `runAgent`,各自返回 `{ pass, blocking[], comments }`。合成裁决:**任一角色 `pass=false` 或 `blocking` 非空 → 整体不通过**;把所有 blocking 汇总回节点,状态回 `PLANNING` 让 plan 角色按意见修订,`iteration.planReview++`,再评。全部 `pass` 且无 blocking → 通过。
- **验收(ACCEPTANCE / INTEGRATION_ACCEPT)**:同上,对 `node.phaseRoles.accept` 并行独立验收执行结果;不通过 → `REWORK`(回 EXECUTING 按意见返工),`iteration.acceptance++`。
- **观察评分(SCORING,可选)**:若 `node.phaseRoles.observer` 非空,验收通过后由观察角色对"方案质量""执行质量"打分(0-100)+ 理由,写入 `score`。**默认仅记录,不触发返工**;可在 caps 配 `scoreThreshold` 使低于阈值触发一次返工(默认关闭)。
- 每一轮的角色意见与合成结果都追加进 `reviewLog`/`acceptLog` 并落盘到 `node.md` 的 `## 评审记录`/`## 验收记录`。

## 8. 并行隔离与合并回收(git worktree)

模块:`src/tools/efftask/worktree.ts`(封装 `git worktree add/remove`、`merge`)。

- Run 启动时创建一条**集成分支** `efftask/<run-id>/integration`(从当前 HEAD 拉)。
- 每个 `executable` 节点进入 EXECUTING 前:从集成分支当前状态 `git worktree add` 一个分支 `efftask/<run-id>/<node-id>`,执行 agent 的 `cwd` 指向该 worktree(复用 AgentTool 的 `cwd`/`isolation` 能力)。
- 验收 + 评分通过后进入 MERGE:把节点分支合并回集成分支。
  - 无冲突 → 合并,移除该 worktree,节点 ACCEPTED。
  - 冲突 → 触发一次"合并解决"(默认由该节点 execute 角色在 worktree 内解决并重跑验收);仍失败 → **升级人工**(飞书卡片),暂停该节点为 BLOCKED,等人工处理。
- Run 全部 ACCEPTED 后,集成分支交给用户:复用 `superpowers:finishing-a-development-branch` 让用户选择合回当前分支 / 保留 / 丢弃。**默认不直接改用户当前工作区**。
- 非 git 仓库场景:启动时检测,若当前目录非 git 仓库 → 提示用户("需要 git 仓库以隔离并行执行")并允许选择"改用共享工作目录串行执行"降级(或初始化 git)。

## 9. 确认与飞书集成

- **启动三关**(名册/并行数/根方案)与**中途升级**(触阀、合并冲突升级、连续返工超限)→ 复用 `interactiveHandler.ts` 的确认竞速器 + `src/services/feishu/*` 卡片。呈现为一次 `ToolUseConfirm` 风格的确认,首个响应端(终端或飞书)胜出并同步另一端。
- **执行子 agent 的工具权限**:各执行 agent 拿到的 `canUseTool` 复用父 `toolUseContext`,权限请求流经同一竞速器/飞书,与主会话一致(参考 `coordinatorHandler.ts`/`swarmWorkerHandler.ts` 作为非主 agent 路由样板)。
- 不新造确认 UI/通道;所有确认统一经此。

## 10. 实时视图与后台任务

- Orchestrator 注册为后台任务(`src/tasks/` LocalAgent 风格:`registerAsyncAgent` 生命周期),在 `/tasks` 可见,`AppState.tasks` 里有条目。
- `/et` 的 local-jsx 渲染一个**实时任务树面板**(Ink):树形展开各节点,着色显示 `status`/当前阶段/评分/是否在 worktree;顶部显示并行占用 n/N、Run 状态;支持中断整个 Run。
- 面板数据来自 orchestrator 的内存树 + 变更订阅(类似 `onTasksUpdated`)。

## 11. 安全阀(防失控)

默认值(解析/确认时可调),写在 `EffTaskConfig.caps`:

- `maxDepth = 5`:节点 depth 超限 → 该分支不再拆,强制 `executable` 或 BLOCKED 升级。
- `maxNodes = 100`:整棵树节点数超限 → 暂停新增,升级人工。
- `maxIterations = 3`:单节点 `planReview` 或 `acceptance` 迭代超限 → BLOCKED,升级人工。
- `nodeTimeoutMs`:单节点执行超时 → 中止该节点 agent(tree-kill,复用 CLI runner 能力),升级人工。
- 触任何阀:**暂停 + 飞书升级**,不静默截断、不谎报完成。

## 12. Non-Goals(明确不做)

- headless `--print` 模式支持(TUI-only)。
- 让主模型自由裁量并行数/依赖(必须引擎硬控)。
- 跨 Run 的全局任务调度/持久化队列(一次 `/et` = 一个独立 Run)。
- 安全加固/密钥脱敏/权限最小化(见 Global Constraints:不做安全阻碍)。
- 分布式/远程执行(本地 worktree + 本地 agent)。

## 13. 测试策略

全部为**纯逻辑单测**,`bun test`,注入假依赖,不打真模型 / 不动真 git 仓库(git 封装可注入假实现):

- `parseDirectives`:各种自然语言指令 → `EffTaskConfig`;非法/缺角色回退;解析失败全回退默认。
- 状态机:每个转移合法性;依赖门控(deps 未全 ACCEPTED 不得进入 EXECUTING);动态加子节点使父转 WAITING_CHILDREN 并正确恢复。
- 调度器:并发上限严格不超(默认 5);ready 集合计算正确;全 ACCEPTED 判定 Run 完成。
- 圆桌合成:全票通过才 pass;任一 blocking → fail + 汇总 + 回修订;iteration 计数与超限升级。
- 观察评分:记录不触发返工(默认);配阈值时低分触发一次返工。
- 持久化:`writeNode/readNode` 往返一致;`loadRun` 从磁盘重建树与内存树等价;`renderTreeSnapshot` 输出稳定。
- worktree 生命周期(假 git):每执行节点 add/remove 配对;合并冲突 → 解决 → 再验收;不可解决 → BLOCKED 升级。
- 安全阀:depth/nodes/iteration/timeout 各自触发即升级,不静默。

## 14. 分期实施(保证"功能完整",增量可测)

每期结束都能独立 `bun test` 通过并可跑:

- **P1 骨架**:`/et` 命令 + 启动确认三关(终端+飞书)+ 树/节点内存模型 + md 持久化 + **串行**执行 + **单角色** plan/review/execute/accept(角色=主模型)。
- **P2 并行 + 隔离**:并发池(默认 5)+ 依赖门控 + git worktree 隔离 + 合并回集成分支 + 收口(finishing-a-development-branch)。
- **P3 多角色 + 动态生长 + 评分**:多角色圆桌评审/验收(独立并行+全票)+ 观察评分 + 执行中动态加子节点 + 全部安全阀 + 实时树面板。

## 15. 关键集成点(来自代码勘察)

- 命令注册:`src/commands.ts` `COMMANDS()`;命令类型见 `src/types/command.ts`(local-jsx + `onDone({shouldQuery, metaMessages})`)。
- 派子 agent:`src/tools/AgentTool/runAgent.ts` `runAgent(...)`;forked 命令派 agent 样板 `processSlashCommand.tsx` `executeForkedSlashCommand`。
- 角色系统:`src/tools/AgentTool/roles/`(`rolesFromSettings.ts` / `roleTypes.ts`),经 `loadAgentsDir.ts` `collectRoleAgents()` 并入 `activeAgents`;按 `subagent_type`/`whenToUse` 选择。
- 并发原语:`src/services/tools/toolOrchestration.ts`(参考,不直接依赖;引擎自持池)。
- 确认竞速器 + 飞书:`src/hooks/toolPermission/handlers/interactiveHandler.ts`(`makeFeishuRacer`)、`src/services/feishu/{feishuPermissions,FeishuClient,cards,config}.ts`。
- 后台任务:`src/tasks/LocalAgentTask/`(`registerAsyncAgent` 等);`AppState.tasks`(`src/state/AppStateStore.ts`)。
- 本地状态/设置:`.claude/` 约定;`src/utils/settings/`;fs 抽象 `src/utils/fsOperations.ts` `getFsImplementation()`。
- worktree/isolation:AgentTool `cwd`/`isolation: 'worktree'`;`git worktree` CLI。

## 16. 已知风险与缓解

- **worktree 合并冲突**(最大风险):真正独立的兄弟节点若改同一文件,后合并者冲突。缓解:鼓励 plan 阶段以依赖边串联可能冲突的节点;冲突→自动解决→失败升级人工。不追求全自动无冲突。
- **OpenAI↔Anthropic 角色协议**:执行/评审用 openai 协议 role 时复用已完成的 `openaiCompat` 转换层(已测)。
- **阶段产出结构化解析**:模型不总返回规整结构。缓解:每阶段用明确 schema 提示 + 解析失败按阶段失败(可迭代),不崩溃。
- **长时 Run 的上下文/成本**:安全阀 + 实时可中断 + 每节点独立子 agent(不污染主上下文)。
- **恢复**:Run 状态全落盘 `.claude/efftask/<run-id>/`;`loadRun` 可从磁盘恢复(崩溃/重启后可续)。
