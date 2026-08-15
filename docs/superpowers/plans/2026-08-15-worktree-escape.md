# 席位用绝对路径写主检出,绕过隔离(2026-08-15)· v2

> v1 推荐「派发席位前后给主检出拍 `git status` 指纹」(方案 C)。**四席圆桌一致否掉。**
> v2 是按四席的实测结论重写的。v1 的错误保留在文末,因为它们本身是判据。

## 现象与病根(不变)

跑机 .30 run 001:集成分支每小时 18~38 个提交,**master 七小时没动**
(08-14 23:40 → 08-15 06:38 人工清障后一次性落地 184 个)。

堵点:主检出里一个未提交的 `pkg/sql/conn_executor.rs`。**席位用绝对路径写了主检出。**

| 证据 | 读数 |
|---|---|
| efftask 事件流里落在主检出的写 | `Update(<主检出>/pkg/sql/conn_executor.rs` ×4、`truncate.rs`、`replica_rangefeed.rs`、`rangefeed/task.rs` |
| 对照:落在工作区里的写 | 3483 条 |
| 子 agent 日志里 `file_path` 落在主检出的 | `sem/tree.rs` 16、`parser/mod.rs` 13、`Cargo.toml` 14 … |
| node.md 里指向主检出的绝对路径 | **2566 次**(是提示词自己教的) |

**观测到的越界 100% 是 Edit/Write 的 `file_path`,一条 Bash 写入都没有。** 这条读数后面要反复用到。

---

## 圆桌否掉了什么(四席各自的实测)

### C(前后拍主检出指纹)—— 否决,而且它会**自己造成**要修的那个故障

- **质量席(真 git,20 路并发)**:`git status --porcelain` **会写 `.git/index`**(刷 stat cache),
  因此抢 `index.lock`。20 席 × 每次派发两拍打在 `gitRoot` 上 →
  **merge 失败 38/40**,`main contains integration? NO`。
  对照组(只有 merger)0/40。**检测手段自己复现了「集成分支前进、master 不动」。**
- **质量席**:20 个诚实席位、零越界、500 对指纹 → **误报 52/500**(换探针只会更多:
  `--no-optional-locks` 98、`-uno` 136);归因实验:1 个作弊席位越界 5 次 →
  **15 个席位被点名,其中 14 个是冤枉的,而作弊者从第 2 次起隐身**。
- **对抗席(真 git)**:porcelain 是**电平**不是**边沿**。已经脏的文件再被改写,
  前后输出**逐字相同**;席位写完 `git commit` 则**完全隐身** —— 而那正是最致命的一条,
  它把下一次 `intoTrunk` 从快进变成真三方合并。
- **规范席**:C 正是 `verifySnapshot` 自己的注释(`pipeline.ts:2364-2374`)**明令禁止**的那一档:
  「N 个执行者同时在同一个目录里写,谁的指纹都是所有人的改动之和」。
  v1 写的「✅ 复用已有范式」是**把反例引成了依据**。

### 「不做 B」的论证 —— 不成立(规范席与对抗席各自独立推翻)

- v1 引的「分档从来没真正拦住过谁」(`runAgentAdapter.ts:452`)说的是**按环节分工具档**,
  不是路径闸;**同一段注释**把 `canUseTool` 列为剩下的两道防线之一。
- 观测到的越界 **100%** 落在 B 覆盖面上(全是 Edit/Write 的 `file_path`)。
  「不完整的闸」对本次事故的拦截率是 **100%**。
- 「不完整 ⇒ 不做」这条会**先把 C 毙掉**(C 更不完整),所以它不是原则,是偏好。
- **B 的位置是免费的完美归因源**:`canUseTool` 包装(`runAgentAdapter.ts:497`)闭包里有
  `req.node`/`role`/`phase`/`cwd`,而且排在 `deps.canUseTool` **之前**,
  bypassPermissions / allowlist 的短路发生在实现内部 —— 对**所有权限模式、所有工具**都在路径上。

### D(连续 N 次)—— 机制不成立

- `noteSkip` 按**整串消息**去重(`worktreePool.ts:169`),而消息里嵌着 git 的 `detail`
  (含随批次变化的文件名)→ **永远数不到 N**。
- 「上屏一次」对七小时静默是错的止血:第 5 分钟报一次,第 7 小时早被盖过。
- **run 级内存计数器 `--resume` 归零** —— 而这个坑 `trunkLanded` 的注释
  (`worktreePool.ts:1256-1264`)已经写过一遍:「现算而不是内存计数」。

### 最狠的一条(对抗席)

**C+D 按最好情况全部生效,输出与这次逐位相同。** 因为两条都只是**报告**,
而这次缺的从来不是信息 —— git 在第一次失败的那一秒就把文件名放进了 `detail` 里。
缺的是**让合并成功**,或者**让 run 停下来**。

---

## v2 方案:四条,按「先止血、再治本」排

### ① `intoTrunk` 永远走快进(结构性,消掉一整类)—— 对抗席 5.2

现在:在 `gitRoot` 里 `git merge <集成分支>`,是**真三方合并**。
改成:先在集成工作区里 `git merge <用户分支>`,再在 `gitRoot` 里 `git merge --ff-only`。

真 git 实测(对抗席 + 质量席各自复现):

| 场景 | 真三方 | 快进 |
|---|---|---|
| 索引里一个**无关**文件脏 | `exit=2` 整个拒绝,还点名无关文件 | **`exit=0` 合上,脏文件毫发无损** |
| 合并**要覆盖**那个脏文件 | 拒绝 | 拒绝(救不了) |

**诚实边界:它砍误伤,不砍正撞。** 本次事故属于「正撞」,①救不了它 —— 由②救。
但它消掉的是**最常见**的一类(用户自己有改动、或别的席位留了无关脏)。

`mergeSubtree` 的 `syncTrunk` 已经是这个形状,理由逐字写在那里;这里是把同一条纪律
搬到自动路径上。

### ② 撞上「会覆盖」时:先钉后合(park-then-merge)—— 规范席 + 质量席

`intoTrunk` 因 `Your local changes … would be overwritten` 失败时:

1. `pinAndClear`(`snapshot.ts:182`,已存在、已被 `worktreePool.ts:125` 调用)把主检出的
   改动钉成一条**耐久 ref** `refs/efftask/<runId>/escape/<时刻>`,并清干净工作区;
2. 重试合并(此时必然能过);
3. **把 ref 名字和取回命令报出来**(走 ④ 的通道)。

- **必须 `stash push -u`,不能用裸 `stash create`** —— 未跟踪的越界(席位新建文件)
  `stash create` 返回**空串**(`snapshot.ts:163` 记着这条,质量席复现)。
- 质量席对照实测:不钉的话 10 个节点完成 → 合上 0;20 个 → 合上 0,**永不自愈**。
- v1 的「不自动回滚,因为可能是真产出」**理由对、结论错**:它把「不删」和「不挪」
  混成了一件事。挪进具名 ref 一个字节都不丢。
- 落在主检出 = 不在任何节点分支上 = `add -A` 够不着 = **本来就永远进不了集成分支**。
  文案必须说这句,用户才判断得了要不要留。

### ③ B:路径闸 + 归因(治本,分两档)

- **B1 归因(默认开,不拦)**:主判据走**事件流** —— `agentEvents.ts:160` 已经逐条提
  `file_path`、`:164` 提 Bash `command`,而且**带席位身份**。输入里出现 `gitRoot` 前缀
  (**两条路径都要**:`/home/esgyn/tb/…` 与软链 `/home/esgyn/work/…`,用 realpath 归一)
  → 记一条带 节点/环节/员工 的告警。**边沿触发**:4 次越界记 4 条(指纹只看得见第 1 次)。
- **B2 硬闸(可配,默认开)**:`canUseTool` 包装里,Edit/Write/MultiEdit/NotebookEdit 的
  `file_path` 落在 `req.cwd` 之外就**拒**,而且**拒绝理由里直接告诉席位它的工作区在哪** ——
  它拿的是提示词里写死的绝对路径,它根本不知道自己有工作区。这一步是 C 永远拿不到的
  「带内纠正」。
- **覆盖面逐字写进关口与文档**:「Edit/Write 已拦;Bash 与 MCP 不在硬闸内,靠 B1 记录」。
  照 `runAgentAdapter.ts:441-456` 那段「放弃了什么要写清楚」的范式。
- `req.cwd === undefined`(共享工作树档、`recalcAgent`、`extractAgent`)**必须早退**,
  否则每次调用都误报。

### ④ 运行期通道(缺了它,①②③ 报出来的话没人看得见)

**`onProblems` 与 `notices` 都不是运行期通道**(接缝席、对抗席各自核对):
`onProblems` 只是 `redoRun.ts:29` / `backtrackRun.ts:30` 的入参,只有 `r/R/s/b` 够得到;
`notices` 是启动关口的解析期概念,跑起来之后不再渲染。

唯一常驻的是 `RunningView.problems`(`efftask.tsx:3266`,渲染 `:3278-3291`,自带「另有 N 条」)。

- 新增 `PipelineCtx.onNotice`(形状照 `onBuildWipe`/`onEscalate`)→ `runOrchestrator` 入参
  → `efftask.tsx` 回调 → **新 state**(**不要复用 `redoProblems`**:它的每个生产者都是
  整体替换,会和越界告警互相抹掉)→ 合并进 `RunningView.problems`。
- 内容按**现算**给,不用计数器(规范席):
  「集成分支上有 N 个提交已经 M 分钟没能送进 `<分支>`:`<原因类别>`」。
  `N` = `rev-list --count HEAD..<int>`;`M` 由 `lastTrunkAdvanceAt` 算。
  可证伪、单调、`--resume` 之后照样成立。
- 原因要按**类别**归一(detached / on-int-branch / userRewound / stagedBlocked /
  overwrite / conflict / other),不能按消息串 —— 消息里嵌着会变的文件名。

### ⑤ 顺手修一条已经在响、但指错方向的铃(规范席)

`pipeline.ts:5007-5012` 的 `no-output` 阻断文案说的是「去查这一轮派给执行者的工具清单」。
而越界席位的形态正是:主检出被改、**自己工作区的指纹前后一致** → `pipeline.ts:4995`
判「一个文件都没改」→ REWORK → 用尽 `maxIterations` → `no-output`。
**铃响了,指错了方向。** 文案要加:「或者这一席写到了工作区之外(方案里写死的绝对路径)」,
并给出主检出的 diff 入口。这条独立于 ①②③④,最便宜。

### 不做

- **C(前后拍指纹)整个不做。** 唯一保留形态:`intoTrunk` **已经失败之后**在 `gitRoot` 拍
  **一次** status,只为把 git 的原话补全 —— 那时没有并发窗口、不需要归因、不需要前后两张。
- **A 的「让分析席自觉写相对路径」不做**(约束在模型身上)。但 A 的**运行时那一半要做**,
  并进 ③:`seatPreamble` 加一句「方案里的 `<gitRoot>` 前缀请替换成你的工作区 `<path>`」,
  和 B2 的拒绝消息共用同一段话。

---

## 探针(缺一条就是没测)—— 接缝席给的三条 + 两条

1. **适配层单测**:`makeRunAgentFn` 有 `runAgentImpl` 注入口(`runAgentAdapter.ts:393`)。
   fake 席位写 `req.cwd` 之外 → B2 拒绝 + B1 记一条带节点/环节的告警;`req.cwd` 缺席 → 零告警。
2. **`runnerMount` 端到端**:`runnerMount.test.tsx` 已能挂真组件、批准关口、断言编排器真跑
   (`:203-224`),`getCwd` 已 mock 到 temp(`:46`)。改 fake 子 agent 去写 temp 主检出,
   **断言帧里出现那句 ⚠**。这条正是 `openStream`/`onBuildWipe`/`autoRescue` 三次都缺的。
3. **pipeline 单测**:`res.trunk.advanced === false` → `ctx.onNotice` 一次;`=== true` → 零次。
4. **真 git**:①的快进改造 —— 无关脏文件下真三方拒绝 / 快进成功,两条都要断。
5. **真 git**:②的 park-then-merge —— 未跟踪越界必须能被钉回来(裸 `stash create` 返回空串
   那条要有反证)。

变异测试**后台跑、串行跑**(仓库既有教训)。

---

## v1 错在哪(留档,它们本身是判据)

1. **把 `verifySnapshot` 的反例引成了依据。** 那段注释点名禁止的就是 v1 要做的事。
   「复用已有范式」这种话必须去读那个范式**成立的前提**(它是 1 树 : 1 写者)。
2. **「适配层拿不到是哪一关」是事实错误** —— `req` 带着 `phase`/`node`/`role`,缺的只有 `gitRoot`。
3. **把「并发归因」写成「最大未解问题」交给评审** —— 而答案在自己手里:那张证据表就是用
   事件流做出来的,在线同样做得到。**拿不能归因的东西去做归因,却把能归因的丢在一边。**
4. **「不完整的闸比没有更坏」单边使用** —— 用它否掉 B,却不用它否掉更不完整的 C。
5. **给了一条做不到的升级路径**(`onProblems`/`notices`)。这是 24 小时内**第二次**
   凭空引用一个不存在的通道(前一次是 `autoRescue`)。写「上屏」之前必须先找到那块屏。
6. **一条探针都没写。**
