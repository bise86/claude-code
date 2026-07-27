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
- **Step(环节)**:节点生命周期里的一步,也是一个**真实的派发点**。七个:`分析(plan)` / `质疑讨论(review)` / `执行(execute)` / `测试验证(verify)` / `验收(accept)` / `集成验收(integrate)` / `观察(observer)`。
  - **自由的是角色,固定的是环节。** 角色名、由谁担当、产出与作用都可以任意写;唯独「挂在哪个环节上」不自由 —— 环节是状态机的骨架,决定这一席何时被调用、能不能拿到写工具、`--resume` 之后还在不在。加环节 = 改状态机,不是改配置。
  - 这个列表**会随版本增长**(本版从 5 个长到 7 个)。承认这点比假装它固定诚实。
  - 中文名是合法输入(`STEP_ALIASES`),**落盘一律归一到内部 phase 名** —— 两边都当 canonical 会让 run.md 出现两种写法,而读回那侧只认一种。
- **Staff(员工)**:一个**可派发的身份** —— settings 里 `roles[]` 的一项(api/cli 两种 execMode)、`.claude/agents/*.md`、插件 agent、内置 agent,任何 agentType 都算。它自带模型、apiUrl、工具集。**旧称「角色模型」**,改名是因为它和下面的「角色」撞名。
- **Role(角色)**:任务里的一个**职能** —— 「架构师」「安全」「前端」。角色必须说明:在哪个阶段用、产出什么、起什么作用、由哪些员工担当。见 §7.1。
- **Seat(席位)**:(角色 × 员工) 的一个具体组合,也就是一次真实的 `runAgent` 调用。`node.phaseRoles[phase]` 存的就是席位列表。多对多:一个员工可担任多个角色,一个角色可由多个员工担任。
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
  // 一个席位。roleName 永远是**员工**名;'' (MAIN_STAFF) = 主模型兼任。
  // roleTag = 这一席在演哪个任务角色,见 §7.1。
  type RoleBinding = { roleName: string; model?: string; roleTag?: string }
  interface EffTaskConfig {
    goalPrompt: string                       // 去掉指令后的核心需求
    parallelism: number                      // 默认 5
    phaseRoles: Record<PhaseName, RoleBinding[]>  // 空数组 = 用主模型
    caps: { maxDepth: number; maxNodes: number; maxIterations: number; nodeTimeoutMs: number; scoreThreshold?: number /* 默认 undefined=评分不触发返工 */ }
    roleDefs?: RoleDef[]                     // 角色定义(§7.1),配置文件 + 提示词合并后的快照
  }
  ```
- 解析策略:用一次**主模型**调用把自然语言指令(如"评审用 architect+security,执行用 coder,并行3,深度4")抽取成 `EffTaskConfig` 的**建议值**;解析出的员工名对照 settings `roles` 校验,不存在的名字回退主模型并在确认表里标注。核心需求文本原样作为 `goalPrompt`。
- 同一次调用还抽取**角色定义**(§7.1 的 `roles`),与配置文件里的 `efftaskRoles` 合并 —— 提示词可以覆盖配置文件里同名角色的产出/作用,员工取并集。配置文件里的角色在**抽取失败或没有抽取模型时同样生效**:抽取失败是最常走到的退化路径,「配置文件里配好角色」不该只在抽取成功时才通。
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

### 7.1 角色定义(员工 / 角色 分离)

模块:`src/tools/efftask/roleDefs.ts`(纯函数)、`roleDefsFromSettings.ts`(读配置)。

一个角色**必须**说清四件事,缺任何一项该角色**不生效**并在关口 notices 里说明原因:

| 字段 | 含义 | 必填 |
|---|---|---|
| `name` | 角色名,任意取(「架构师」「安全」「前端」) | 是 |
| `stage` | 在哪个阶段用。**只能是** `plan`/`review`/`execute`/`accept`/`observer` | 是 |
| `output` | 产出什么 | 是 |
| `purpose` | 起什么作用 | 是 |
| `staff` | 由哪些员工担当(员工名数组)。**省略 = 主模型兼任** | 否 |

`stage` 不能自由取名,原因比「配置得进去、永远不执行」更硬:`resumeCore` 和 `startupConfirm` 都用 `Object.fromEntries(PHASE_NAMES.map(…))` 重建 `phaseRoles`,未知阶段键第一次 `--resume` 就被删掉;而 `makeRunAgentFn` 按 `phase === 'execute'` 决定给不给写工具,自由阶段名永远只拿到只读工具集。

**两条录入路径**,提示词覆盖配置文件。同名角色:产出/作用后写的赢;员工在**配置文件内部**(角色侧 `staff` 与员工侧 `efftaskRoles`,同一层的两个方向)取**并集**,而**提示词指名员工时是替换** —— 「架构师这次改由 ds-安全 担任」必须真的是「改」,取并集会让它变成「再加一个」,用户就换不掉人。提示词没指名员工则沿用配置文件里的人。

1. **配置文件** —— `settings.json` 顶层 `efftaskRoles`(角色侧),以及 `roles[].efftaskRoles`(员工侧,声明「我能担任哪些角色」)。两侧都受同样的校验,员工侧不是绕过校验的后门。
2. **任务提示词** —— 凡是描述了「某角色在哪个阶段、产出什么、起什么作用、由谁担当」的,由 `parseDirectives` 抽出来。

```jsonc
// .claude/settings.json
{
  "roles": [
    { "name": "opus-架构", "whenToUse": "架构评审", "execMode": "api",
      "apiUrl": "https://…", "apiToken": "sk-…", "model": "claude-opus-4-8",
      "efftaskRoles": ["架构师"] }          // 员工侧:我能当架构师
  ],
  "efftaskRoles": [                          // 角色侧
    { "name": "架构师", "stage": "review",
      "output": "通过/阻断裁决与具体阻断项", "purpose": "把关可维护性与回滚路径",
      "staff": ["opus-架构", "ds-架构"] },   // 一个角色多个员工 → 两席,同一场圆桌
    { "name": "验收官", "stage": "accept",
      "output": "验收裁决", "purpose": "逐条核对验收点" }  // 无 staff → 主模型兼任
  ]
}
```

**展平成席位,不做两层圆桌。** `synthesizeVerdicts` 是全体 AND,而 AND 满足结合律,所以 `AND_over_roles(AND_over_staff(v)) ≡ AND_over_all_pairs(v)`。展平之后零新增聚合、零嵌套、infra 重试语义不变、并发溢出回到今天的水平(嵌套会让 `slotPool` 的防自旋兜底按 `1+角色数` 相乘)。去重键是 **(角色名, 员工名)** 而不是员工名 —— 同一员工在两个角色里拿到两份不同的职责简报,应当分别作答。

**两条不变式:**

- `phaseRoles[].roleName` **永远是员工名**,绝不是角色名。找不到的名字在全链路都静默回落主模型(`pickAgentDefinition → mainModelDefault`、`effectiveModel → mainModel`),所以写角色名会让关口渲染出「架构师(claude-opus-4)」——看起来绑好了,实际是主模型披了个名字。「主模型兼任」在磁盘上表达为 `roleName: ""`(`MAIN_STAFF`)。
- 席位的角色归属存在 `RoleBinding.roleTag`,不靠数组下标反推 —— 同一员工可兼两角,按 (阶段, 员工名) 反查是二义的。`roleDefs` 和 `roleTag` 都必须被 `readRunManifest`/`roleArray` **读回**:`writeRunManifest` 整文件重写 run.md,只写不读的字段第一次 `--resume` 就清零,而且清得毫无声响 —— 席位数量、员工名、模型全对,只有职责简报没了。

角色的 `output`/`purpose` 经 `roleBriefFor` → `seatBrief` 拼进该席位的提示词,这是它到达模型的**唯一**通道。没有 `roleTag` 的席位(关口上手勾的员工、老 run.md)拿到空串,提示词退回原样。

### 7.1.1 一个角色多个员工:各阶段怎么收敛成一个产出

用户的要求是「一个角色有多个员工其必须过圆桌评审达成一致,**只有一个结论方案或产出**」。

> **现行形态见 §7.3。** 本节保留的是决策史 —— 这里最初否掉了「各自出稿再投票」,后来又把它做了出来,
> 中间的理由变化本身是要记的。

当初否掉的理由是:两份方案没法机械合并,「各自出稿再投票」要新 schema、新 answerTag、新解析器、新聚合(argmax 而非 AND),
还要给落选稿在 node 上找地方放 —— **放不下就是静默丢弃**。顺序精化全程只有一份稿子在走,「只有一个产出」是结构保证的。

后来还是做了,因为顺序精化有个当时没算进去的代价:**锚定效应**。第一稿的框架基本就是最终框架,后面的人在修订而不是重想。
方向已定时这是优点,方向未定时这是把所有人锁死在第一个人的思路上。

当初那条否决理由被**逐条解掉**,而不是绕过去:

- 不投票,不做 argmax —— **一次融合调用**,由最后一席读完所有稿子写出一份最优解。没有新 schema、新 answerTag、新聚合;融合席位走的是和起草席位一模一样的那条路,只是提示词不同
- 落选稿有地方放了 —— `NodePlan.alternatives` + `node.md` 的「备选方案」段落,单份截断到 `ALT_SOLUTION_CHARS`(1500)并标注截断。**不是静默丢弃**
- 稿子在融合提示词里**匿名化**成「稿 A / 稿 B / 稿 C」,融合者看不到谁写的 —— 否则会按人取舍而不是按内容

两种方式由 `caps.planConverge`(`圆桌` / `精化`,默认精化)选择,提示词里一句话可改。只有一个员工时两者等价:不多那次融合调用。
plan 的顺序精化里,后面某一位调用失败时**用前一稿继续**并在 `execStatus` 留痕 —— 静默降级成「少一位修订者」正是不静默截断要防的。第一位就失败则照旧阻断(手上没有任何稿子)。

### 7.2 护栏

多对多会把调用数**乘**起来,所以三条护栏和它一起交付:

1. **`caps.maxSeatsPerPhase`(默认 5)** —— 一个阶段最多几席,超出的**剔除并点名**。这是唯一能同时按住成本乘子和阻断率的旋钮。
2. **关口显示预估调用数上限** —— 终端与飞书卡片**都**显示。刻意**不叫「并发」**:并发上限是 `parallelism`,把排队总量说成在飞数会让用户去调一个不解决问题的旋钮。公式(`It`=maxIterations,`P/R/A`=方案/评审/验收席位数,至少 1,`O`=观察席):

   ```
   每节点 = It × (P + It × R)          // stepStart:顺序精化 P 次 + 评审圆桌
          + It × (1 + It × A + O)      // stepExecute/stepIntegrate:执行 + 验收圆桌 + 打分
   ```

   三个容易漏的都在里面:圆桌**自己**还有一层 infra 重试循环(`roundtableWithInfraRetry` 最多 `It` 桌),所以是 `It` 的**平方**;方案阶段的顺序精化每一席都是一次串行调用;打分在每一次验收通过后都跑。漏掉它们会低估约 2.5 倍 —— 实测 1 评审席 + 2 验收席、`It=3` 时真实 23 次而旧公式承诺 15 次。**低估比高估糟**:用户按一个偏小的数批准。措辞是「预估上限…实际通常远低于此」,因为 `maxNodes` 默认 100 是硬上限而非预期值。
3. **`caps.quorum`(默认 100 = 全票)/ `caps.quorumSeats`** —— 圆桌通过门槛,分别是赞成**百分比**和赞成**席位数**。两个字段而不是一个:用户会说「至少 2 个人通过」,那句话抽成 `quorum=2` 会落在合法区间里、夹取不报警,而 2% 的含义是「1 席赞成就放行」—— 用户想收紧,实得几乎没有门槛,而且错在**放宽**方向。只写 `quorumSeats` 时比例维不设限(那句话是把门槛换成 2 席,不是「2 席**并且**全票」);两个都写则取更严的。抽取提示词里的映射必须算对:「过半」= 51(50 在 `>=` 下让平票也通过)、「三分之二」= 66(67 会让 2/3 = 66.67 恰好不通过),比较用整数乘法而非浮点。纯 AND 下加席位只能把「通过」变成「不通过」:每席独立 80% 的话,9 席全票只有 13% 通过率,三轮用尽约 65%。不给这个旋钮,「一个角色多个员工」就是自我拆台。
   - 分母**不含 infra 失败**:调用没打通不是一票反对。这修掉的是混合失败的浪费 —— `isInfraOnlyFailure` 要求**所有** failing 都是 infra,所以「1 个真阻断 + N 个调用失败」会被当成真阻断,烧掉一整轮真返工。
   - 默认档(全票)行为与引入本旋钮前**逐字节相同**,包括「有 infra 就不通过 → 重试」。
   - 放宽档下面板不完整(有席位没打通)时**照样放行**,这要求 `roundtableWithInfraRetry` 先看 `synthesized.pass` 再看 `isInfraOnlyFailure` —— 否则「2 席赞成 + 1 席打不通」会被继续重试,烧完 `maxIterations` 桌后以「未能取得任何裁决」阻断,而那句话是假的(两席都判决了且都通过),前几轮通过的裁决还会被丢掉。
   - 达到法定人数时,少数派的阻断项**照样全部汇总**进 blockingSummary。

三条都在 `readRunManifest` 里重做同样的夹取 —— 手改 run.md 是一条绕开 `parseDirectives` 全部校验的路。

### 7.3 一个角色多个员工:每个环节怎么收敛成一个产出

| 环节 | 多员工形态 | 为什么 |
|---|---|---|
| 质疑讨论 / 测试验证 / 验收 / 集成验收 | **圆桌**:并行独立裁决 + 全票/法定人数合成 | 裁决类天然可合成,`synthesizeVerdicts` 就是合成规则 |
| 分析 | **两种,`caps.planConverge` 选**:顺序精化(默认,第一位起草→后面每一位在前一稿上修订)或融合圆桌(各自独立起草→最后一席融合成一份) | 精化是结构保证「只有一个产出」,代价是锚定效应;融合拿掉锚,代价是多一次调用。落选稿进 `NodePlan.alternatives` 不丢。见 §7.1.1 |
| 观察 | **各自打分,取最低分**;其余理由挂在 `ScoreRecord.others` | 显示宽容的那个数会掩盖阈值要抓的情况;但只留最低分就丢了其余理由,那是静默截断 |
| 执行 | **只能一个员工(物理约束)** | `pathFor(node)` = `hash(nodeId)`,不含员工维度,两个员工会拿到同一个 worktree 路径 |

### 7.4 测试验证环节

**只在配了角色时存在**,没配就整步不发生,行为与引入它之前逐字节相同。

它不能塞进执行或验收:执行者有动机说「做完了」;验收判「达没达成验收点」读的是产出描述,测试验证判「跑起来对不对」要**真的执行命令**。提示词把执行者的自述明确标注为「不能作为通过依据」。

**工具档位挡不住写入,所以真正的闸门是前后比对工作区。** Bash 本身就能写(`echo >`、`sed -i`、`git apply`),给它「只读 + Bash」减掉的是便利不是能力 —— 断言它的工具集里没有 Edit/Write 与「它会不会改代码」毫无关系。实现是:这一场前后各取一次 `git status --porcelain` 指纹,变了就判该轮裁决作废并返工(用 porcelain 而非 diff:只看 diff 会漏掉「新建一个文件让测试通过」)。没有隔离池时返回 `undefined` —— **不假装比对过**。

失败走已有的返工路径、共用 `iteration.acceptance`,不新增预算维度;但阻断文案必须说清是**哪一关**没过 —— 报成「验收迭代超限」会让升级卡片与 `--retry-blocked` 拿到错误诊断。

`VERIFYING` 必须同时进 `pipeline.ACTIVE_STATUSES`、`reseat.ACTIVE`、`reseat.PHASE_OF`,以及 —— **最要命的** —— `resumeCore.LEGAL_STATUS`。那份集合已改为由 `NODE_STATUSES` 派生:它此前是和 `NodeStatus` 类型完全脱钩的字面量,而本仓库没有 typecheck,漏掉一个新状态不会有任何东西报错,后果是节点在恢复时被 `block()` 清掉三个复活开关、**永久死亡,连 `--retry-blocked` 都救不回**。

### 7.5 环节跳过

任何环节都可以整个跳过。两条入口:`settings.json` 顶层 `efftaskSkipSteps`,以及提示词(「跳过质疑讨论和验收」)。中英文环节名都收,落盘统一成英文。

**跳过 ≠ 没配角色。** 这是整个特性最容易搞错的一点,也是文档里那句错话的来源:

| | 分析 / 质疑讨论 / 执行 / 验收 | 集成验收 | 测试验证 / 观察 |
|---|---|---|---|
| **没配角色** | 照跑,主模型一个人干 | 回落到验收席位 | 整步不发生(本来就是 opt-in) |
| **跳过** | 整步不发生 | 整步不发生 | 整步不发生(空操作) |

所以「不配角色」省不掉调用,只有跳过能。

实现上有三处不能想当然:

1. **跳过执行不能只是「不调模型」。** 空产出闸门在验收之前触发,让节点空转 `maxIterations` 圈再阻断 —— 一次模型调用都没有,而阻断信息还在指责执行者没干活。必须整块跳过,并在 `execStatus` 留一条带编排器前缀的注记,否则验收/集成验收会把它渲染成空槽。
2. **跳过分析要顺带定 `kind`。** 不出方案就没有拆分决策,节点直接判 `executable`;`kind` 留空会让下游路由拿不到形态。同时第三道关口(子树确认)必须跳过 —— 它会丢弃已批准的子树,导致关口显示 5 个节点、实跑 0 个。
3. **跳过的环节不留 PASS 记录。** `reviewLog` / `acceptLog` 里写一条假的通过,会让用户事后以为有人看过。记「已跳过」。

关口对跳过的呈现有两条硬要求:

- **说后果,不说「已跳过」。** 跳过是降低质量保证的动作,关口存在的意义就是让用户在批准前知道自己批准了什么。每个环节一句后果(「没人核对验收点,产出未经判断就合进集成分支」)。
- **预估调用数要归零。** `Math.max(1, seats)` 的语义是「没配角色也跑一次主模型」,跳过时必须绕过它,否则关口高估,用户会去调一个根本不需要调的旋钮。

关口要当场拦下跑不完的组合:跳过执行但不跳验收(不会有任何改动,而验收仍会去核对这个空产出)、跳过分析但不跳质疑讨论(评审去评空方案)、七个全跳(空跑)。

这一条的措辞本身踩过坑:第一版写的是「节点会在执行环节连报 3 轮空产出后阻断,验收根本跑不到。请一并跳过验收」——三句全错。跳过执行是在空产出闸门**之前**整块早退的,闸门不触发,验收照跑(实测一次调用就把一个什么都没做的节点判成 ACCEPTED)。而最后那句建议最糟:它让用户去掉唯一还在跑的那道检查。**关口上的每一句话都要实跑验证过**,尤其是带祈使的那种。

还要分成两个块:「会让任务跑不完」和「跑得完但有连带后果」(跳过分析 = 不主动拆子任务;跳过集成验收 = 所有拆分型节点不再评分)。把后者挂在前者标题下,就是 notices 块「标题说 A 内容说 B」的同一个错,只是换了个块。两个块都**不能塞进 notices** —— 那个块的标题是「你的请求中有以下部分不会生效」,而跳过是生效了的。

## 8. 并行隔离与合并回收(git worktree)

### 8.1 收口(run 结束后处置集成分支)

模块:`handoffActions.ts`(四个动作,纯函数 + 注入 git)、`ConfirmHandoff.tsx`(终端关口)、`feishuStartupCard.buildHandoffCard`(飞书卡)。

run 跑完 → `reclaim()` 照常 → `pendingHandoff` 写进 run.md → **立刻放锁、立刻还终端**。用户随后用 `/et --resume <id>` 回来做选择。

- **`pendingHandoff` 独立于 `status`。** run.md 的 `status` 只在最后一次写入时带上,盘上会先出现 `status: completed` 而集成分支还没处置。用户此时**直接关终端**(不是按 Esc)→ reseat 只捞活动态节点、根节点已 ACCEPTED → 什么都不会重开。所以恢复路径必须在**任何节点检查之前**判定它 —— 「run 里没有可恢复的节点」那句 fatal 会先触发,把用户挡在门外。
- **四个选项,标签等于行为**:合并回当前分支 / 推送分支(**不叫**「建 PR」,它只跑 `git push`)/ 保留 / 丢弃。合并失败、脏工作区、推送失败一律**如实报告**,绝不显示「已合并」—— 用户会据此做下一步,而代码根本不在他的分支上。
- **丢弃需二次确认**,文案如实列出会删什么(集成分支 + 集成工作区)、**不会**删什么(抢救分支、未回收的节点工作区、run 目录)。先删工作区再删分支:被 worktree 占着的分支 git 直接拒绝。
- **飞书卡只有三个按钮,没有「丢弃」**。它不可逆,而这条通道没有过期机制、点击失效卡完全静默、`updateCard` 吞掉所有错误。卡片仍**显示**该选项存在并写明去终端确认。
- **不设默认、不自动选、无限期等**:飞书 7 天过期就是过期,终端一直等,两边一致。Esc = 稍后再说(等同「保留」),不丢任何东西。
- `commits === 0` 不弹四选一;run 结局是被阻断/取消时,关口顶部就说清楚 —— 别邀请用户合并一棵半成品。
- **成功才**把待收口从 run.md 划掉。失败也划掉,用户就再回不到这个关口,而他刚被告知失败了什么。
- `/tasks` **不**做成非终态:进程真的结束了,显示成运行中会多出一条杀不掉的活任务(`x` 去 abort 一个没人监听的 controller)。改为终态 + 描述里带上「待收口(/et --resume NNN)」。


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
- 组件:`src/commands/efftask/TaskTreePanel.tsx`(树面板)+ `NodeDetailView.tsx`(节点详情)。数据来自 orchestrator 的内存树 + 变更订阅(类似 `onTasksUpdated`),以及每节点子 agent 的输出缓冲(捕获自 agent 流,类似异步 agent 进度)。

### 10.1 交互式任务树面板(TaskTreePanel)

- **树形 + 可展开/折叠**:每个有子节点的节点前显示展开标记(`▸` 折叠 / `▾` 展开)。键盘:↑/↓ 移动焦点,→/Enter 或空格展开、←折叠子树;支持鼠标点击标记展开/折叠(终端支持鼠标时)。默认展开根 + 第一层。
- **每行内容**:`<状态徽标> <标题>  <当前阶段>  <耗时>  <评分>`。
- **状态着色**(徽标 + 颜色):
  - 🟢 绿色 = `ACCEPTED`(已完成)
  - 🟡 运行中(动画/高亮)= `PLANNING`/`PLAN_REVIEW`/`EXECUTING`/`ACCEPTANCE`/`INTEGRATION_ACCEPT`/`SCORING`/`MERGE`/`REWORK`,并显示当前阶段名
  - ⚪ 灰色 = 排队/等待 = `CREATED`/`READY`(等依赖)/`WAITING_CHILDREN`
  - 🔴 红色 = `BLOCKED`(失败 / 触阀 / 升级人工)
- **耗时(elapsed)**:每节点显示自进入活动态起的累计耗时;完成后显示总耗时。
- **顶部状态条**:并行占用 `n/N`、Run 状态、计数(完成/运行中/排队/失败)。
- **中断**:面板级快捷键可中断整个 Run(升级为 finishing-a-development-branch 收口)。

### 10.2 节点详情视图(NodeDetailView)

- 在树面板对某节点按 **Enter** → 进入该节点详情(Esc/← 返回树)。
- 展示该节点 `node.md` 的完整内容:`完整方案 / 重点 / 风险点 / 验收点 / 执行状态 / 评审记录 / 验收记录 / 评分`,以及依赖、worktree 分支/路径、迭代次数、各阶段耗时。
- **子 agent 实时终端**:若该节点正在执行/评审,详情视图下半区实时滚动显示该节点子 agent 的输出流(与单个子 agent 终端观感一致),完成后保留最终输出。

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

- **P1 骨架**:`/et` 命令 + 启动确认(终端+飞书竞速,展示真实角色名册)+ 树/节点内存模型 + md 持久化 + **串行**执行 + plan/execute 单角色、review/accept **多角色圆桌**(settings 里配了角色即生效)+ **基础只读实时树**(状态着色 + 耗时,不含展开/详情)。
  - **断点续跑(§17)不在 P1**:P1 只把恢复所需的全部状态写到盘上(`loadRun`/`readNode` 已实现并测试,但无消费者),读回并续跑由 **P1.5 的 Task 12/13** 实现。
- **P2 并行 + 隔离**:并发池(默认 5)+ 依赖门控 + git worktree 隔离 + 合并回集成分支 + 收口(finishing-a-development-branch)。
- **P3 多角色 + 动态生长 + 评分 + 完整交互视图**:多角色圆桌评审/验收(独立并行+全票)+ 观察评分 + 执行中动态加子节点 + 全部安全阀 + 交互式树面板(展开/折叠 + Enter 进节点详情 + 子 agent 实时终端,见 §10)。

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
- **恢复**:Run 状态全落盘 `.claude/efftask/<run-id>/`;`loadRun` 可从磁盘恢复(崩溃/重启后可续)。完整续跑设计见 §17。

## 17. 断点续跑(终端重启后恢复并继续)

**目标:** 终端退出/崩溃/重启后,用一条命令把任务树和每个节点的状态原样恢复出来,再用一段提示词让它从断点继续执行。Run 目录本身就是完整的持久化状态,不依赖任何内存或会话残留。

### 17.1 入口

- `/et --resume` — 扫描 `.claude/efftask/`,列出全部 run(编号、目标首行、状态计数、最后更新时间),让用户选一个。
- `/et --resume <runId>` — 直接恢复指定 run(如 `/et --resume 003`)。
- `/et --resume <runId> <继续提示词>` — 恢复并附带一段**续跑指引**(见 17.4)。`--resume latest` 取最新一个。

### 17.2 恢复三步:读取 → 校验 → 重入归位

1. **读取**:`loadRun(fs, runDir)` 取回全部 `node.md`(已实现,崩溃容错:坏文件进 `errors` 不影响其余节点);`readRunManifest(fs, runDir)` 从 `run.md` frontmatter 取回 `EffTaskConfig`(并行数/角色名册/安全阀/原始目标)。清单缺失或损坏 → 回退默认配置并在确认界面标注。
2. **校验(必须,不可跳过)**:`node.md` 是磁盘上的文本,可能被手工编辑或写坏。`validateLoadedNodes(nodes)` 逐节点检查 `status` 是合法 `NodeStatus`、`kind` 合法、`deps`/`childIds` 为字符串数组、`iteration` 计数为数字、`depth` 为数字;并做**引用完整性**修复:丢弃指向不存在节点的 `deps`/`childIds`,重建 `parentId` 与 `childIds` 的双向一致性。校验失败且无法修复的节点 → 标 `BLOCKED` 并记 `blockedReason`,**不得**把非法状态喂进状态机(非法 `status` 会让依赖门控静默失效)。校验结果汇总展示给用户。
3. **重入归位(reseat)**:进程被杀时正处于活动态的节点,实际上并没有在跑。`reseatTransientNodes(nodes)` 把它们退回可安全重入的静止态:`PLANNING`/`PLAN_REVIEW` → `CREATED`;`EXECUTING`/`EXECUTED`/`ACCEPTANCE`/`REWORK`/`SCORING`/`MERGE` → `READY`;`INTEGRATION_ACCEPT` → `WAITING_CHILDREN`。`CREATED`/`READY`/`WAITING_CHILDREN`/`ACCEPTED`/`BLOCKED` 原样保留。每个被归位的节点在 `execStatus` 追加一行"上次运行在 <阶段> 中断,已重新排队",**不清空已有的执行证据**。
   - 重入代价:被中断的那一步会重跑一次(可能重复一次模型调用),但绝不会让"半完成"冒充"已完成"。这是刻意的取舍——宁可重做,不可谎报。

### 17.3 恢复后的确认关口

恢复后进入与新建 run 相同的确认界面,但内容为:恢复出的任务树(状态着色)、节点计数(已完成/排队/失败)、校验与归位摘要(哪些节点被修复、哪些被重新排队)、恢复出的角色名册与并行数(可改),以及是否继续。同样走终端 + 飞书竞速。用户可选择"继续执行"或"仅查看后退出"。

### 17.4 续跑提示词

`/et --resume <runId> <继续提示词>` 里的提示词作为 `resumeGuidance` 存入 Run,并追加进后续所有 `plan`/`execute` 阶段的提示词(位于目标之后、答案纪律之前),例如"跳过压测部分,先把 API 打通"或"之前的方案太复杂,后面从简"。它**不修改已 ACCEPTED 的节点**,只影响尚未完成的部分。为空则纯粹按原计划继续。

### 17.5 与安全阀/幂等的关系

- 恢复不重置 `iteration` 计数:一个已经烧掉 2 轮评审预算的节点,续跑后只剩 1 轮,防止"重启即刷新预算"绕过上限。
- 恢复后 `runId` 不变,继续写同一个 Run 目录;`run.md` 追加一条恢复记录(时间、归位节点数)。
- 同一个 Run 不允许并发续跑(两个终端同时 resume 会互相覆盖 `node.md`)。P1 用一个轻量锁文件 `run.lock` 记录 pid + 时间戳,发现活跃锁则提示用户;锁陈旧(进程已不存在)则接管。
