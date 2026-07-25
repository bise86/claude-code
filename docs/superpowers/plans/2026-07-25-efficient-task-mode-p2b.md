# 高效任务模式 — P2b worktree 隔离 (v2 亦被否)

> ## ⛔ v2 经圆桌评审否决,10 条阻断。**不可实施。**
>
> 三轮累计 36 条阻断(v1-14 / P2b-v1-12 / P2b-v2-10),绝大多数在一次性 git 仓库里实测复现。
>
> **评审确认修对了的**(不必再动):B1 的 `merge-base --is-ancestor` 判据(五种并发失败模式零误判)、
> B3 的 release 双条件、失败清理用 `reset --hard && clean -fd`(实测能解开 `merge --abort` 解不开的卡死)、
> Task 21 的 slug 设计、以及"`add -A` 不触发钩子"这半条。
>
> **v2 错在另一类地方:git 原语选对了,却搞错了它作用的状态。**
>
> | # | 实测失败 |
> |---|---|
> | B2-a | 执行者**自己在 worktree 里提交**时(我们的工作流要求频繁提交),`add -A` 无暂存 → 判空 → **合并从不执行**,集成分支静默缺失该节点全部工作,而节点 ACCEPTED。判空必须是"无暂存 **且** `is-ancestor` 为真" |
> | B2-b | `performPostCreationSetup` 把 `core.hooksPath` 指向主仓 hooks 并写进**共享的 .git/config**,用户的 pre-commit 钩子会在每个 agent worktree 里触发。钩子拒绝是确定性的,而 v2 把非零一律当 infra 重试 → 永远重试、永不合并 |
> | B2-c | 同一函数把 `.claude/settings.local.json` 复制进每个 worktree。本仓它只被用户**全局** gitignore 忽略;在没有该全局忽略的机器/CI 上,`add -A` 会把明文 token 合并进那条要交给用户 push 的分支。这是交付物正确性问题,不是被豁免的"安全摩擦" |
> | B4 | 复用的 worktree **本来就在** `worktreeBranchName(slug)` 上,"先提交再 `checkout -B` 同一分支"把该分支重置掉:抢救提交 `for-each-ref --contains` = **0 个 ref**,可被 gc,而 `release` 还会 `branch -D`。违反"宁可保留垃圾,不可删掉工作" |
> | B5 | acquire **永久失败**的节点会在用户真实工作树里执行(`pipeline.ts` 传 `cwd: node.worktree?.path`,未设即回落);而锁按 init 结果解除,于是多个这样的节点**并发写用户的树** —— 比 P2a 更危险的新回归 |
> | 6-a | `stepIntegrate` 在共享集成 worktree 里做验收,与合并**无锁竞争**:实测验收者读到 `v0`、并发合并落地、重读变成 `v-X CHANGED`;失败清理的 `clean -fd` 还删掉了它的临时文件与 coverage 目录 |
> | 6-b | 动态生长的提前返回让节点经 `stepIntegrate` 走到 ACCEPTED,**那条路径上没有任何合并步骤**,其 worktree 里的真实改动从不进集成分支。`blockWithReason` 的各个出口同样未定义何时 merge/release |
> | 8 | `GitRunner` —— 整个测试策略赖以成立的注入接缝 —— **全仓零命中且无任务定义它**;`<wtBranch>` 用了 4 次却从未定义(而它恰好决定 B4 会不会孤儿化抢救提交);Task 22 是全部风险所在却**零可执行步骤**;Task 21 让人"照抄已作废文档";24-27 是一句 TBD |
>
> ## 结论:换做法
>
> 三轮都是"先写方案 → 送评审 → 被实测推翻",每轮推翻的都是**我对既有 git 助手行为的假设**,而不是设计思路。继续这个循环只会有第四轮。
>
> **应当先做实验再写方案**:在一次性仓库里把 `worktreePool` 对着**真 git** 实现出来,把
> `createAgentWorktree` / `performPostCreationSetup` / 钩子 / 复用路径 / 并发合并的真实行为全部
> 测出来,然后**从实测结果反写方案**。前三轮已经积累了大量这类事实(见上表与前两版文档),
> 它们本该是实验的产出,而不是评审的产出。

---

## 以下为 v2 原文(留档)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让每个可执行节点在自己的 git worktree 里执行,验收通过后合并回本 run 的集成分支,全部完成后把集成分支交给用户处置。隔离到位后解除 `execute` 的串行锁,兑现"各任务执行可以并行,默认5个"的后半句。

**Tech Stack:** 与前期同 —— Bun + TypeScript,`bun test`,`*.test.ts` 与源码同目录。git 操作全部经**注入的 `GitRunner`**,单测不碰真仓库;真 git 行为由一次性仓库的集成测试覆盖。

## 本文档的由来(v1 与 v2 都被否,勿删)

- **P2 v1**(`…-p2.md` 的隔离部分):三方圆桌 14 条阻断,多数在一次性 git 仓库里实测复现。
- **P2b v1**:再评审 **12 条阻断**,同样多数实测复现。下面 §"v1 为何被否" 逐条记录。

两次被否的共同点:**每一次"修法"都在真 git 的语义上撞墙**。所以 v2 的规则不再从"应该怎样"推导,而是从"实测会怎样"倒推。

---

## v1 为何被否(实测证据,勿删)

| # | 实测失败 | v2 的应对 |
|---|---|---|
| B1 | **并发合并把失败判成成功并删掉工作。** 共享集成 worktree 里同时 merge:A rc=0 合入;B rc=128 `cannot lock ref 'HEAD'`,文件没进集成分支。但集成分支 HEAD 因 A 而前进 → v1 的"HEAD 前进即成功"对 B **判 PASS** → B 走 ACCEPTED → `release()` 的 `git branch -D` 把 B 的提交彻底删掉 | 合并**全局互斥**(Task 22.3);成功判据改为 `git merge-base --is-ancestor <wtBranch> <integrationBranch>` —— 问"本节点的提交是否已被集成分支包含",而不是"sha 变没变" |
| B2 | **"无改动"与"钩子拒绝"退出码相同。** 空提交 rc=1;pre-commit 拒绝 rc=1;身份缺失 rc=128。按 v1 字面实现会把正常路径误判成 infra 无限重试;按 stderr 猜则会把钩子拒绝当成"该节点没有产出"→ ACCEPTED → 改动从不进集成分支 | 先 `git add -A` 再 `git diff --cached --quiet` 判空(退出码 0=空/1=有),**不靠 commit 的退出码区分**;commit 的任何非零一律 infra |
| B3 | **`release()` 永不删除,100% 泄漏。** `hasWorktreeChanges(path, headCommit)` 是"工作树脏 **或** `headCommit..HEAD` 有提交";而规则要求合并前必然 commit,所以合并成功后恒为真。且 `lease.headCommit` 来自 `createAgentWorktree`,是 **origin/默认分支** 的 sha,`checkout -B` 之后 HEAD 已换基线 —— 全新未动过的 worktree 上 `rev-list --count` 就已经是 1 | acquire 在 `checkout -B` **之后重读 HEAD** 写进 lease;release 的判据改为"工作树脏 **或** 有未被集成分支包含的提交" |
| B4 | **续跑复用脏 worktree 必然失败。** `getOrCreateWorktree` 会复用已存在的 worktree,而执行者从不提交,中断时它必然是脏的 → `checkout -B` rc=1 `local changes would be overwritten` → 按 v1 返回 null → 按"首个 null 即全局降级" → **每次 Ctrl+C 后的续跑都整体丢掉隔离**。另一半更糟:脏文件不冲突时 rc=0,未提交改动被**静默带到新基线上** | 复用路径先 `git add -A && git commit`(把中断时的产出固化成提交)再 `checkout -B`;**区分"本节点 worktree 复用失败"(节点级 infra)与"隔离不可用"(run 级降级)** |
| B5 | **"首个 acquire 返回 null 前不得有第二个执行者启动"不可实现。** 调度器 `for (const {node,kind} of batch) inFlight.set(...)` 同一 tick 同步启动整批;拆掉 `executeChain` 后首批 N 个 acquire 同时在飞,没有承载点。且 hook 型探测与 init 能否建立在 init() 时已知,与"运行时降级"构成双真相 | **隔离可用性只在 `init()` 判定一次**(hook 探测、git 仓库探测、集成分支创建全在 init);init 之后 acquire 的失败一律按**节点级基础设施失败**处理并重试,不再触发 run 级降级 |
| B6 | **acquire 并发争用。** 5 个并发 `git worktree add`:一个 rc=255 `could not lock config file .git/config`,worktree 根本没建出来 | acquire **全局串行**(与合并同一把锁的不同实例),并对可重试的 git 锁错误重试 |
| B7 | **F3(验收看不见工作)只改一个 cwd 不够。** 链路要动四处:`runRoundtable` 参数、`roundtableWithInfraRetry`(三个圆桌唯一入口)、accept 调用点、`acceptPrompt`。且 `stepIntegrate`/`integratePrompt` 完全不在 v1 覆盖内:**分解节点的集成验收在子节点 worktree 已被删之后运行**,产出只在集成分支上,验收者无处可看。`scoreNode` 的 runPhase 也没有 cwd,是第五个站点 | Task 23.2 列全五个站点;集成验收在**集成 worktree** 内进行 |
| B8 | **关口会开始撒谎。** `startupConfirm.parallelismLine` 硬编码"执行与叶子验收串行";`concurrency.test.ts` 用 `peak.execute===1`/`peak.accept===1` 把串行钉死。解除串行后一个变谎报、一个变红,而 v1 的 Files 清单没列它们 | Files 列入这三个界面 + `concurrency.test.ts`,并要求新增"隔离可用时 `peak.execute>1`、降级时 `==1`"的**时序**断言 |
| B9 | **`node.worktree` 类型装不下租约。** 它是 `{branch, path}`,而 `removeAgentWorktree` 缺 `gitRoot` 会**静默返回 false 并泄漏**;hook 型无分支 | 扩成 `{branch?, path, headCommit, gitRoot, hookBased}` 并测往返 |
| B10 | **Task 22-27 无可执行步骤**,违反本项目计划规则;而上面 6 条阻断恰好全落在被省略的步骤里 | Task 21/22/23 给真实测试与实现骨架;24-27 给 Files + Interfaces + 分步 |
| B11 | **F4 只修一半。** 集成分支"从 HEAD"建,HEAD 不含用户**未提交**的修改与未跟踪文件,执行者依旧看不到 | 明确写进方案**并在关口告知用户**:执行基线是 HEAD,不含你未提交的改动 |
| B12 | **保留的 worktree 永不清理。** `EPHEMERAL_WORKTREE_PATTERNS` 对新 slug 一条都不匹配;进程内清单随 kill 消失 | 加 pattern(`cleanupStaleAgentWorktrees` 对脏工作树 fail-closed,加了也不会删有工作的),或写明已知泄漏 |

**另外两条(评审附注,同样实测):**
- **幂等重合并假阴性**:续跑重合并一个已合入的节点 → rc=0 `Already up to date.` 且 HEAD 不前进 → 会被判失败。先用 `merge-base --is-ancestor` 判"已合入"。
- **失败会把集成 worktree 弄瘫**:竞态失败留下常驻暂存区,`git merge --abort` 报 `no merge to abort` 清不掉,之后正确串行重试直接 rc=2 `local changes would be overwritten`,集成 worktree 从此卡死。清理必须用 `git reset --hard` + `git clean -fd`,不能只 `merge --abort`。

---

## 与已交付功能的冲突(必须先解决,评审指出)

**评分会把已合并的节点打回返工。** `scoreNode`(已交付)在验收通过与 ACCEPTED 之间运行,并可返回"需返工"把节点打回 REWORK。而 v1 把合并挂在"验收通过之后",于是可能出现**已合并的节点又被打回返工,而它的 worktree 可能已被 release 掉**。

**v2 的顺序固定为:** `执行 → 验收 → 评分 →(若返工则回执行,worktree 保留不动)→ 合并 → release → ACCEPTED`。
即**合并是 ACCEPTED 前的最后一步**,评分返工发生在合并之前,worktree 在整个 execute→accept→score 循环期间**始终保留**。

---

## Global Constraints

- 不做安全约束阻碍:token 明文写 `.claude/settings.json`,不引入 `env:` 间接、不脱敏。
- **宁可不隔离,不可假隔离。** init 判定隔离不可用 → 整个 run 串行执行并在关口如实告知;**绝不允许**"配置说隔离了、实际在用户工作树上并发写"。
- **宁可保留垃圾,不可删掉工作。** 任何删除前必须确认该 worktree 既不脏、其提交也已被集成分支包含。
- **合并成功必须有正面证据**:`merge-base --is-ancestor <wtBranch> <integrationBranch>`。退出码 0 不是证据(实测 "Already up to date" 也是 0)。
- 验收与集成验收必须能**读到**它要验收的东西。
- 断点续跑必须继续可用:`node.worktree` 是可能失效的磁盘引用,恢复路径必须校验。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/tools/efftask/worktreeId.ts`(新) | slug/分支名派生 |
| `src/tools/efftask/worktreePool.ts`(新) | init/acquire/commitAndMerge/release/dispose;内含 acquire 与 merge 的全局互斥 |
| `src/tools/efftask/types.ts`(改) | `node.worktree` 扩成完整租约;`EffTaskConfig.isolation` |
| `src/tools/efftask/pipeline.ts`(改) | 合并挂在评分之后;accept/score/integrate 三处传 cwd |
| `src/tools/efftask/roundtable.ts`(改) | `runRoundtable` 增 `cwd` |
| `src/tools/efftask/orchestrator.ts`(改) | 按隔离可用性决定是否解除 execute 串行 |
| `src/tools/efftask/resumeCore.ts`(改) | 校验 `node.worktree` 路径存活 |
| `src/tools/efftask/startupConfirm.ts`(改) | 并行/隔离文案单一真相;告知执行基线是 HEAD |
| `src/commands/efftask/{ConfirmStartup,ConfirmResume}.tsx`、`feishuStartupCard.ts`(改) | 同上 |
| `src/tools/efftask/concurrency.test.ts`(改) | 隔离可用时 `peak.execute>1`、降级时 `==1` |

---

### Task 21: worktree 身份(纯逻辑)

**Files:** `src/tools/efftask/worktreeId.ts` + 测试

```ts
export function worktreeSlug(runId: string, nodeId: string): string  // efftask-<runId>-<sha256(nodeId) 前 8 位>
export function integrationBranch(runId: string): string             // efftask/<runId>/integration
```

评审已实测确认这条修法成立(`efftask-001-4813494d` 长 20,对中文/深层/超长 id 全部合法且稳定)。

- [ ] **Step 1: 写失败测试**(完整代码见 v1 文档 Task 21 Step 1,原样沿用 —— 它是唯一被评审判为"修对了、不必再动"的部分)
- [ ] **Step 2-4:** 跑红 → 用 `node:crypto` 的 `createHash('sha256')` 实现 → 跑绿 → 提交

### Task 22: worktreePool(注入 GitRunner)

**Interfaces:**
```ts
export interface Lease {
  path: string; branch?: string; headCommit: string; gitRoot: string; hookBased: boolean
}
export type MergeResult =
  | { ok: true; merged: boolean }
  | { ok: false; kind: 'conflict'; files: string[] }
  | { ok: false; kind: 'infra'; message: string }
export interface WorktreePool {
  init(): Promise<{ ok: true } | { ok: false; reason: string }>
  acquire(node: TaskNode): Promise<Lease | { error: string }>   // 节点级失败,不是 run 级降级
  commitAndMerge(node: TaskNode): Promise<MergeResult>
  release(node: TaskNode): Promise<{ removed: boolean; keptBecause?: string }>
  dispose(): Promise<{ kept: { path: string; why: string }[] }>
}
```

**22.1 init()** —— 隔离可用性**在此一次判定**(B5):探测 git 仓库、探测 hook 型(hook 型无分支 → 判定隔离不可用)、从 HEAD 建 `efftask/<runId>/integration`、为它开**专用集成 worktree**。任一失败 → `{ok:false, reason}`,整个 run 降级串行并在关口如实告知。

**22.2 acquire()** —— 全局串行 + 锁错误重试(B6)。`createAgentWorktree(slug)` → 在 worktree 内 `git checkout -B <wtBranch> <integrationBranch>`(B4:若复用的 worktree 是脏的,**先 `git add -A && git commit` 固化**再 checkout)→ **重读 HEAD** 写进 `lease.headCommit`(B3)。失败返回 `{error}`,由调用方按节点级 infra 重试。

**22.3 commitAndMerge()** —— 全局互斥(B1)。
1. `git add -A`;`git diff --cached --quiet` 判空(B2)。空 → `{ok:true, merged:false}`,**不合并**。
2. 非空 → `git commit`;任何非零退出一律 `{kind:'infra'}`,**不猜 stderr**。
3. 已合入判定:`git merge-base --is-ancestor <wtBranch> <integrationBranch>` 为真 → `{ok:true, merged:true}`(幂等重合并)。
4. 在集成 worktree 内 `git merge <wtBranch>`。
5. **成功判据**:再次 `merge-base --is-ancestor`。为真才成功;为假则按退出码分档 conflict/infra。
6. 失败清理必须 `git reset --hard && git clean -fd`,不能只 `merge --abort`(实测 abort 清不掉常驻暂存区,集成 worktree 会从此卡死)。

**22.4 release()** —— 删除前必须**双条件**:工作树不脏 **且** 其提交已被集成分支包含(B3)。否则保留并说明原因。

**22.5 dispose()** —— 逐个查后再删,保留清单返回给调用方展示(B12:同时把新 slug 加进 `EPHEMERAL_WORKTREE_PATTERNS`,或在文档中写明已知泄漏)。

- [ ] Step 1-12:测试先行,注入假 `GitRunner`。**必测**:B1(并发合并,断言失败节点的 worktree 未被删)、B2(空提交/钩子拒绝/身份缺失三种 rc 的分档)、B3(纯净 worktree 不被误判为脏)、B4(脏 worktree 复用)、B6(锁错误重试)、幂等重合并、失败后集成 worktree 仍可用。

### Task 23: 接线(隔离真正生效)

1. 执行前 acquire,租约完整写入 `node.worktree`(B9)。
2. **五个 cwd 站点**(B7):`stepExecute`(已有)、`runRoundtable` 参数、`roundtableWithInfraRetry` 透传、accept 调用点、`scoreNode`。集成验收在**集成 worktree** 内跑。
3. 提示词注入 worktree 告示(照 `forkSubagent.ts` 的 `buildWorktreeNotice`),并在文档与注释中写明:**MCP 工具是进程外的,不受 cwd 覆盖 —— 这是隔离的已知漏洞**。
4. 顺序固定:执行 → 验收 → 评分 → 合并 → release → ACCEPTED(见上文冲突章节)。
5. execute 串行锁的解除**只看 `init()` 的结果**(B5)。
6. 三个界面文案 + `concurrency.test.ts` 的时序断言(B8)。

### Task 24-27

冲突自动解决一次 + 飞书升级卡(spec §8)、收口(finishing-a-development-branch)、非 git 让用户选择、续跑校验 `node.worktree`。**各自的 Files/Interfaces/分步在进入该任务前补齐 —— 上一版正是在这里留白,而 6 条阻断全落在留白处。**

## Self-Review

- spec §8 五条逐条对应 Task 22-26。
- **已知且不解决的漏洞(写进文档与代码注释,不假装隔离完备)**:MCP 工具进程外执行,不受 cwd 覆盖;执行阶段工具池含父级 MCP 工具。
- **已知取舍(要告知用户)**:执行基线是 HEAD,不含用户未提交的改动(B11)。
- 本期不做:P1 交接清单的启动第 3 关、后台任务注册、飞书推进 surface、跨分支依赖调度。
