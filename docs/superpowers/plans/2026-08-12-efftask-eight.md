# /et 第十九轮:八件事的方案(v2 —— 四席圆桌之后)

> 基线:branch `feature/efficient-task-mode`,HEAD `6a3ffa7`,
> `bun test src/tools/efftask src/commands/efftask` = **3468 pass / 0 fail**(已实测)。
>
> v1 被四席**一致判不通过**。v2 是按四份评审重写的,不是打补丁。
> 被推翻的三个核心判断记在 §-1,免得下一个读的人再走一遍。

---

## -1. v1 被推翻的三件事(每一条都有实测)

1. **`intoTrunk` 里塞解冲突循环 —— 落点错。**
   它是工厂内私有函数(`worktreePool.ts:194`),而且**整个罩在 `mergeLock` 里**
   (`commitAndMerge` 的三处调用 `:749/:755/:833` 全在锁内)。把「模型 + git 复核 × N 轮」
   关进去,直接违反 `mergeSubtree.ts:44-45` 写死的规矩:「解冲突那次模型调用不在锁里……
   把一次几分钟的模型调用关进 mergeLock 会让整棵树的合并停摆」。
   而且 `WorktreePoolDeps`(`:68`)只有 `runId/gitRoot/git/worktreeRoot` —— 没有模型接缝、没有 caps。
   → **v2 改成一棵专用的临时工作树 + 独立模块,锁只用来做最后那一次毫秒级快进。见 §7。**

2. **「阶段重做」里 verify/accept/observer 三个入口是不可达的。**
   `entryBlockedReason`(`redo.ts:100-127`)每条分支都返回字符串,三个条目永远 disabled;
   `redo.ts:1330` 的注释自己写着「verify / accept / observer 到不了这里」;
   快速重做把它们映射成 `execute`(`entryForPhase`,`redo.ts:289`)。
   → **v1 表格的中间档位没有调用者。`wipeBuildOutputs` 整个挪到 `c` 键那边,那里才有真调用者。见 §2/§5。**

3. **「对名单里每个节点分别调 `planRedo`」照字面写出来是错的,而且不会报错。**
   `planRedo` 第一行是 `input.map(structuredClone)`(`redo.ts:1135`),返回**一整棵新树**。
   - 对同一份 `nodes` 调 N 次 → N 棵互不相干的树,只有一棵能交出去 → **只回溯了一个节点**;
   - 串起来喂 → 树对了,但 `resetForExecute`(`redo.ts:661`)把 worktree 推进的是**本次调用的**
     `worktreesToRelease`,而删目录的人照着的正是那张表 → **N-1 个工作区一个都不删**;
     `reopenAncestor`(`redo.ts:725`)对非 BLOCKED 非 ACCEPTED 早退 → 第 2..N 次的
     `reopenedAncestors` 恒空 → 共同祖先不在扣押集里,而它此刻是 `WAITING_CHILDREN`,
     调度循环当场可以把它派去集成验收。
   两种错法**全套测试都能绿**。
   → **v2 新增 §3.4「N 个节点如何合成一个 RedoPlan」,把并集规则、定序规则、`hold` 时机逐条写死。**

另外,四席各自核实为**属实、不必再争**的现状(下文不再举证):
`release()` 的判据、`commitRedo` 只调 `pool.release`、`serialiseExecute` 按池子不按配置、
`sharedTreeNote(false)` 返回空串、`intoTrunk` 撞冲突无条件 abort、`autoResolveMerge` 只解一次、
`scanSubtreeMerge` 看不见 salvage 分支、`!isTerminal → skip`、c 键硬闸区分 `code===1`、
`handoff().kept` 为「引用为空但目录有东西」单开过一支、`commitAndMerge` 第一句是 `add -A`、
`resetForExecute` 只在 plan/review/execute 三条路上跑、全仓 tsx 100% 走 `../../ink.js`。

---

## 0. 九条需求 → 六个阶段

| 需求 | 阶段 | 一句话 |
|---|---|---|
| **9 合并提交、任务标记完成后立即清掉构建产物** | **1** | `wipeBuildOutputs` 原语 + 挂在 ACCEPTED 那一刻 |
| 5 c 键 target 没清干净 / 6 未合并的绝对不能删 | **1** | 补 `kept` 与 **`unfinished`** 两桶(今天完全够不着) |
| 2 重做清构建产物 / 4 任务重做删工作区 | **2** | `discard`:先固化未提交 → 唯一名抢救 → 删目录 |
| 7 合并冲突先同步主干再迭代解决 | **3** | 冲突挪进专用临时工作树解,用户检出永不半合并 |
| 8 `m` 要能处理所有没合入的 | **4** | 补三个盲区 + 一个整桶(已合入但留着未提交内容) |
| 1 当前目录并发、不要 git | **5** | 第三档 `shared-parallel`,15 处判据 |
| 3 回溯子树从执行阶段重来 | **6** | 主模型定名单 + 合成一个 RedoPlan |

**阶段 1 排最前**:需求 9、5、6 共用同一个原语 `wipeBuildOutputs`,而它们正对着用户此刻
真实的那个问题(跑机 916G 用了 869G,`/` 只剩 1.7 MB)。阶段 2 是它的第三个调用者。
阶段 3 必须排在 4 之前(4 用它)。5 与 6 相互独立。

---

## H(§9). 合并提交、任务标记完成之后,**立即**清掉构建产物

### 用户原话(2026-08-12)
> 合并提交后,任务标记完成了,需要立马清理掉 worktree 下的 target 目录下的编译产物这些。

### 落点
`pipeline.mergeAndRelease`:`commitAndMerge` 成功之后、`release()` 之前。
那一刻的事实是**逐字确定**的:节点的交付物已经 `add -A` + commit + 合进集成分支,
之后还留在那棵树里的被忽略文件**按定义不是交付物**(`add -A` 从不暂存被忽略的文件,
所以它们**在任何路径上都到不了集成分支** —— `refreshFromIntegration` 的 KNOWN GAP 段落
已经把这条记死了)。

### 判据
1. **只清被忽略的**(`clean -X`),未跟踪但未被忽略的一个字节都不碰 —— 那可能是执行者
   生成了却没能提交的东西,而这一刻我们没有任何人可以问。
2. **排除 `.claude/efftask/` 和 `.efftask-worktrees/` 两个模式**:实测
   `$GIT_COMMON_DIR/info/exclude` 对 linked worktree 生效,而 `init()` 往里写了这两条
   (见 §D.3.3)。
3. **失败不影响节点的判决** —— 清不掉是磁盘的事,不是「这个任务没通过」。
4. **成功不写 `execStatus`**:每节点一句会把它撑成流水账,而它会被喂进之后每一次
   验收/集成验收的提示词(`worktreePool` 为同一件事定过这条规矩)。
   → 统计**汇总到 run 级**,印在运行视图表头旁和收口屏:「已回收构建产物 N 处,共 X GB」。
5. **`Skipping repository` 要如实报**(§D.3.2:嵌套仓库被静默跳过而 exit 仍是 0),
   释放量 `du -sk` 前后各量一次实测,不照抄预估。
6. **开关**:`caps.wipeOnAccept`,默认 **true**(用户明说「立马」),
   `settings.json` 的 `efftaskCaps` 可关。启动关口印一行:
   「任务合并完成后立即清掉它工作区里被 .gitignore 忽略的构建产物;重做那个任务会全量重编。」
   —— 这是一个**自动、不可逆**的删除,用户必须在开跑前看见它。
7. **不删目录**。用户要的是「清掉 target 这些编译产物」,不是回收工作区;
   而目录还留着是 `m` 键、重做、升级卡指路的前提。

### 与阶段 1 其余部分的关系
清完之后 `release()` 的判据(干净带 `--ignored` + 已合入)在很多节点上**当场变成成立** ——
于是收口时 `dispose()` 能真的回收它们,而不是像今天这样被 `target/` 一律拒绝。
这是需求 9 顺带买到的东西,不是它的目的,但要在探针里钉住。

---

## A(§7). 合并冲突:先同步主干,然后迭代解决

### A.1 现状三条路,各自缺什么

| 路径 | 现状 | 缺口 |
|---|---|---|
| 节点分支 → 集成分支(自动) | `stepExecute` 的解冲突循环:有迭代,`staged` 那一支会 `integrationAhead` 后同步 | 第一轮(`fresh`)不同步 |
| 集成分支 → 用户分支(`intoTrunk`) | 撞冲突 → 无条件 abort → 报一句原因 | **一次都不解** |
| `m` 键 / 收口 `merge` | `autoResolveMerge` 解**一次** | 不迭代;冲突解在**用户自己的检出**里 |

### A.2 判据:冲突不该在用户的检出里解,也不该在集成工作区里解

- **用户检出**:那是他正在用的目录。今天只能 abort,正是因为没有别的选择。
- **集成工作区** `.efftask-worktrees/integration`:它被 `commitAndMerge` 写、被集成验收读
  (`withIntegrationRead` = 同一把 `mergeLock`)。把一个分钟级的模型循环放进去 = 整棵树停摆。

→ **第三棵树**:`.efftask-worktrees/trunk-sync`,**撞冲突才懒建**,合完就删(删不掉就说出来)。
它不属于任何节点,没有第二个读者,所以循环可以在里面跑任意久。

### A.3 新模块 `src/tools/efftask/trunkSync.ts`

```
syncTrunkAndResolve(deps): Promise<TrunkSyncResult>
  deps: { git, gitRoot, worktreeRoot, intBranch, resolve?, rounds, signal?, onProgress?,
          withIntegrationLock: <T>(fn) => Promise<T> }   // = pool.withIntegrationRead
```

**步骤(每一步的判据都是评审实测出来的)**:

1. 量用户当前分支(`symbolic-ref --quiet --short HEAD`)。detached / 停在集成分支 / 已包含
   → 原样退回今天的四条早退(判据与 `intoTrunk` 逐字同源,屏幕上写着的 X 必须就是真的挡住它的 X)。
2. `merge-base --is-ancestor <用户分支> <intBranch>` 成立 = 主干已经在集成分支里,跳到第 6 步。
3. 懒建 `trunk-sync` 工作树:`worktree add --detach <path> <intBranch>`。
   **detach 而不是占分支** —— 集成分支被 `integration` 那棵占着,git 不许两棵树占同一条。
4. 在里面 `git merge --no-verify <用户分支>`:
   - 干净 → 第 5 步;
   - 撞冲突 → **迭代**(见 A.4);解不成 → `merge --abort` + **复核现场真的还原了**
     (判据是 `rev-parse -q --verify MERGE_HEAD`,**不是 abort 的退出码** —— 没有合并可中止时
     git 回 128 而树是干净的,`handoffActions.ts:76` 今天就会据此报一句假的「自动还原失败」)
     → 删掉 trunk-sync → 如实报告,产出留在集成分支上。
5. **进锁**:`withIntegrationLock(() => git(['merge','--ff-only','--no-verify', <trunk-sync 的 HEAD>], intPath))`。
   这一步是毫秒级的纯 git,**模型一次都不在锁里**。
   快进不成立(有人动过集成分支)→ 什么都不做,如实报告。
6. 回 `gitRoot`:`git merge --ff-only --no-verify <intBranch>`。
   - **成功** → 完成。
   - **`Not possible to fast-forward`** = 用户在这期间自己提交了(实测:`/tmp` 上
     `fatal: Not possible to fast-forward, aborting.` exit=128)。
     → **有界重试**:回第 1 步,最多 `TRUNK_SYNC_RACE_RETRIES = 3` 轮;耗尽就如实报告
     「你在同步期间提交了 N 次,已放弃自动合并」。
     **绝不退回普通 `merge`** —— 实测那条路会在用户检出里留下 `UU` + 活的 MERGE_HEAD。
   - **未跟踪文件冲突**(`The following untracked working tree files would be overwritten`)
     → 良性(实测:文件原样保留、树干净、没有半合并态),如实报告并列出文件名。

**措辞禁令**:不许写「此时是快进」。快进是**通常**成立(实测:哪怕手工混合解也成立,
因为快进只看祖先关系),但用户提交、未跟踪文件冲突两条都会让它不成立。

### A.4 `resolveMergeLoop` —— 一份实现,三条路共用

```
resolveMergeLoop({ git, cwd, branch, resolve, rounds, signal, onProgress })
```

每轮:量未合并路径 → 派一次模型 → **git 复核三道**(未合并路径、暂存区冲突标记、commit 成不成)
→ 成了返回。

- **commit 必须 `--no-verify`。** `handoffActions.ts:95` 是全仓唯一漏掉的一处,实测一个失败的
  `pre-commit` 钩子会让它 exit=1 并停在 mid-merge —— 而这个循环跑在**我们自己的**工作树里、
  用的是**用户的**钩子,不加它就是烧满 N 轮再报「提交失败」。
- **没有进展就停**:两轮之间未合并路径集合逐字相同 **且** `statusFingerprint` 没变 = 原地打转。
- **轮数**:`caps.mergeResolveAttempts` 的语义是「一个节点的合并冲突最多让模型自动解几次
  (**每次解完都会重跑验收**)」,而 `m` 键/收口今天**根本不受它管**。直接复用会让一个设了
  `mergeResolveAttempts=0`(「冲突别自动解、直接叫我」)的用户**静默失去 m 键现有的那一次能力**,
  正好顶掉需求 8。
  → 新增 `caps.trunkResolveRounds`(默认 3),**手动路径下限锁 1 轮**并在关口印出来。
- 抽走 `autoResolveMerge` 时把 `restored` 的判据一起改成看 MERGE_HEAD。

### A.5 三条路的接线

- **`intoTrunk`(自动、逐任务)**:**逐字不动**。它在锁里,必须保持毫秒级。撞冲突照旧
  abort + 记原因,由 `m` 键 / 收口那一次带着模型来收拾。这一条是**故意不做**,写在这里免得
  被当成漏项。
- **`m` 键第二跳**:`mergeSubtree.mergeToTrunk` 改调 `syncTrunkAndResolve`。
- **收口 `merge`**:`runHandoffChoice('merge')` 改调同一个。
- **节点 → 集成的第一跳**:`conflictScene` 的 `fresh` 那一支**补一次同步**
  (`integrationAhead` 为真才动手,理由与 `staged` 那一支逐字相同)。这是「先同步」在第一跳上的兑现。

---

## B(§8). `m` 键要能处理所有没合入的东西

### B.1 四个盲区(前三个是 v1 就有的,第四个是评审抓的)

1. **抢救分支** `efftask/<runId>/salvage/*` 完全不在视野里(它们没有工作区目录)。
2. **非终态节点**被整条跳过(`mergeSubtree.ts:224`)。判据该是「**此刻在不在飞**」而不是
   「状态是不是终态」—— `handoff().kept` 专门为「引用交回、目录留着」那一类单开过一支,
   它们不在飞,只是状态非终态。接缝是 `orchestrator.runningNodeIds()`(`orchestrator.ts:94`,
   `inFlightIds` 是 private)。拿不到(结束屏 / `--resume` 之后)退回 `isTerminal` 并说明。
3. **「所有未提交的都要提交」的后半句**:`add -A` 不暂存被忽略的文件,所以构建产物永远不会被提交。
   要说出口,并**列出**留下的是什么。
4. **整整一桶漏了:已合入、但目录里还留着未提交内容的节点。**
   `mergeSubtree.ts:205` 的 `if (merged.code === 0) { alreadyMerged++; continue }` 排在数 loose 之前
   —— 这类节点对 `m` **完全不可见**,而用户那句「要保证所有未提交的都要提交」正正落在它上面。
   → 新桶 `looseOnly[]`:提交并合入(走同一条 `commitAndMerge`)。

### B.2 抢救分支的三条硬约束(全部来自 git 席的实测)

1. **名字必须唯一。** 实测:同一节点第二次 discard,`branch -f` 之后上一版产出落在
   **0 个 ref**(`for-each-ref --contains` = 0),而 §B.1 的扫描走 `for-each-ref` —— 它永远看不见,
   gc 之后就真没了。`reclaimNodeBranch:435` 今天就是这个写法。
   → 统一改成 `efftask/<runId>/salvage/<slug>`、`…-2`、`…-3`(复用 `freeName` 那套判据:
   已存在且**不是**新分支的祖先才换名)。**这条要同时修 `acquire` / `reclaimNodeBranch` / 新 `discard`。**
2. **合它之前要知道它是什么。** 实测:一个被验收否决的产出留下的 salvage,在节点重做出正确产出
   之后再合,会撞 add/add 冲突,而 §A 的循环会派模型去「解决」——**它不知道右边那半是被否决的**。
   → salvage ref 旁边记来历(节点 id + 为什么 discard,写在 `refs/efftask/<runId>/salvagemeta/<name>`
   或 run.md 的一张表),确认屏**按「该节点后来是否被重做 / 是否已 ACCEPTED」分组,被重做过的默认不选中**。
3. **`unmapped` 桶。** slug 是 `sha256(nodeId)[:8]` 单向的(`worktreeId.ts:20`),节点从树上删掉后
   再也映射不回来 —— 而 salvage 恰恰产生在 discard/重做/回溯改写节点的时刻。
   → 映射不回去的照样列出来、照样可合,标注「对应的任务已不在树上」。**不许静默丢掉。**

---

## C(§2+§4). 重做:任务重做删工作区,而且不许丢东西

### C.1 「合并重做」是哪一条 —— 用户已回答(2026-08-12)

> 合并重做是指**执行阶段后,进行合并提交这个任务的重做**。

= 不重跑任何工作、只把合并提交再做一次。三个入口:`--resume --retry-blocked` 重开
`mergeConflict` 节点、`m` 键、拆分节点的 `integrate`。**三个都不碰工作区。**

### C.2 判据:这次重做会不会让执行者重新跑工作

`resetForExecute`(`redo.ts:651`)只在 `plan` / `review` / `execute` 三条路上跑(`:1313/:1319/:1446`)
—— 而**可达的重做入口只有四个**(plan/review/execute/integrate,见 §-1.2)。所以:

| 入口 | 处置 |
|---|---|
| `plan` / `review` / `execute` | **`discard`:整个删掉**(下次 `acquire` 从集成分支 tip 重建 = 重新同步 + 必然重编) |
| `integrate` | 一个字节都不碰 |

**中间档位不存在**,`wipeBuildOutputs` 挪去 §D。

### C.3 `pool.discard(node)` —— 建在 `createWorktreePool` 内部(`reclaimNodeBranch` 是私有的)

四步,顺序不可换:

1. **先固化未提交的东西。** 实测:节点分支上一笔提交都没有(执行产出在 `commitAndMerge`
   之前一直是未提交的)时,抢救闸 `merge-base --is-ancestor` 判「无需抢救」,`worktree remove
   --force` 之后 `git fsck --lost-found` **无输出,文件无从恢复**。这正面撞用户第 8 条。
   → 复用 `worktreePool.ts:602` 那句 `add -A` + `commit --no-verify -m 'efftask: 固化工作区残留'`。
   **固化不成就整条放弃**(宁可这个节点报错)。
   ⚠ `add -A` 不暂存被忽略的文件 —— 那部分**确实会随目录一起消失**,确认屏必须逐条说,
   而这正是需求 2 要的「删掉 target 重新编译」。
2. **抢救,用唯一名**(见 §B.2.1)。存不下来整条放弃。
3. `worktree remove --force`(**一次**。实测第二个 `--force` 是给**被锁**的树用的,
   多加一次会吞掉「有人锁住了它」这条该报的情况)。**不需要 `worktree prune`** ——
   实测 remove 会连登记项一起清掉,目录已被外部 `rm -rf` 时也照样 exit=0。
4. 目录删成了才 `branch -D`;没删成整条跳过。`node.worktree` **就地置 undefined**。

### C.4 取证位置(v1 说错了)

那句假话**不在确认屏上**(`redo.ts:1682-1685` 的措辞其实很诚实),在**执行者读到的注记**里:
`REDO_NOTE_LOST` / `REDO_NOTE_MERGED`(`redo.ts:492-493`)逐字写着「隔离工作区已重置为集成分支
最新状态」,而今天 `release()` 因为 `target/` 拒绝删除,那句话对执行者是假的。探针钉这里。

---

## D(§5+§6). `c` 键:补上今天完全够不着的两桶

### D.1 先承认一件事:需求 5 是在修复**之后**又问的

`7339528`(08-11 16:24)、`6a3ffa7`(08-11 17:32)都在这份八条清单之前,而 `6a3ffa7` 是
**test-only**,行为一个字节没改。所以 v1 那句「主体已落地」是**读代码读出来的,不是量出来的** ——
违反本仓库自己的「先量再看代码」。v2 撤回这个结论,改成:**把今天够不着的桶全部列出来,逐个处理。**

### D.2 四个桶

`cleanupScope`(`cleanupWorktrees.ts:209`)只收 `status === 'ACCEPTED'`,其余全进 `unfinished` 并**整个跳过**。

| 桶 | 今天 | v2 |
|---|---|---|
| `items`(已验收 + 已合入) | `worktree remove --force` 删整个目录 ✅ | 不变 |
| `kept`(已验收,**有未合入提交**) | 一个字节都不碰 | 目录/提交/未提交内容**照旧全保**,**只清被忽略的构建产物** |
| `kept`(**探测失败**,`code !== 0 && !== 1`) | 一个字节都不碰 | **保持一个字节都不碰** —— 在一个状态未知的仓库里跑 `git clean -f` 是这个功能最不该做的事 |
| **`unfinished`(非 ACCEPTED,含 BLOCKED)** | **整个跳过** | **只清被忽略的构建产物**,且**只对此刻不在飞的节点**。这很可能就是用户问题的真凶:跑机上「一个阻断、9 个兄弟依赖阻断」是常态,它们的 `target/` c 键从来碰不到 |

判据一句话:**清产物 ≠ 删目录。** 目录是现场,`target/` 不是。

### D.3 `git clean -X -d -f` 的三条实测边界,每一条都要上屏

1. **被忽略的目录会被整个删掉,连里面人手写的文件一起。** 实测 `target/NOTES.md` 随
   `Removing target/` 一起消失,`clean -Xdn` 只报顶层条目。
   → v1 那句「未跟踪的文件一个字节都不碰」**是假话**,改成:「`target/` 这类被 .gitignore
   忽略的目录会被**整个**删掉,包括你手工放在里面的东西」,并对每个待删顶层条目报出**内部条目数**。
2. **含嵌套 git 仓库的忽略目录会被静默跳过,而退出码仍是 0。** 实测
   `Skipping repository vendorbuild/subrepo` + exit=0 —— 屏幕会说「已清掉 8.2 GB」而盘上一个字节没少。
   → 解析 stdout 的 `Skipping repository` 如实报出;**释放量前后各 `du -sk` 一次实测**,不照抄预估。
   **绝不上 `-f -f`** —— 那会删掉嵌套仓库,和 §C.3.1 是同一类。
3. **`.git/info/exclude` 对 linked worktree 生效**(实测 `git check-ignore -v` 指到
   `$GIT_COMMON_DIR/info/exclude`),而 `init()` 往里写了 `.efftask-worktrees/` 和 `.claude/efftask/`。
   → 在节点工作区里跑 `clean -X` 会连这两个模式一起清。今天不构成误删(那两个目录只在用户检出里),
   但执行者的 cwd 就是节点工作区,它在自己目录里写任何 `.claude/efftask/` 下的东西都会被静默删掉。
   → **排除这两个模式**(`clean -X -d -f -e '!.claude/efftask' …` 做不到,改成先 `-n` 列出、
   逐条过滤掉这两个前缀,再逐条删)。

### D.4 未被忽略的构建目录(用户点名的 `.cargo-target-sql-restore`)

`clean -X` 清不掉它(它未跟踪但**未被忽略**)。对 `items` 桶无所谓(整个目录都删)。
对 `kept` / `unfinished` 两桶:**列出来 + 报大小 + 默认不删**,并在关口上给一个显式的
opt-in 键把它们一起删掉(逐条列名)。理由:未跟踪未忽略的文件**可能是执行者刚生成、还没提交的
交付物**,而这两桶恰恰是「工作还没合走」的桶。给用户看 + 让他自己按,比替他猜好。

### D.5 需求 6 的复核 + 探针

硬闸今天已经对。补三条反向探针(今天零覆盖):
- 已验收但 HEAD 未合入 → 目录、分支、未提交内容**逐一**还在;
- `merge-base` 探测失败 → 一个字节都不动,**且不进 `keptBuild`**;
- `runCleanup` **只对 `plan.items` 做 `worktree remove`** —— 这是不可逆动作,今天靠代码结构成立,没有断言。

### D.6 `c` 与 `m` 的正面冲突,必须写成一条规则

同一批未提交内容:`c` 会**连目录一起删**(items 桶),而 `m` 今天**拒绝提交**它们(§B.1.4)。
用户同一轮里既说「未合并的绝对不能删」又说「所有未提交的都要提交」。
→ **规则**:`c` 的确认屏在 items 桶里存在 `leftoverCount > 0` 时,**必须印一句**
「这些内容还没有被提交到任何分支上;想留就先按 `m` 合并一次再回来清」。§B 落地之后这句才成立。

---

## E(§1). 第三档 `shared-parallel`

### E.1 语义

不建 worktree、不产生任何 git 提交、执行阶段直接在**用户当前目录**里跑,**而且并发**。
适用前提由用户自己保证:任务按生成文件划分,彼此不碰同一个文件。

### E.2 判据的唯一真相 —— **两处,不是一处**

```ts
// orchestrator.ts:487
const serialiseExecute = kind === 'execute'
  && this.deps.worktrees === undefined && this.deps.sharedParallel !== true
```

```ts
// efftask.tsx:2051 —— 让新模式成为新模式的唯一一行
if (effectiveConfig.isolation !== 'worktree') { poolRef.current = undefined; setIsolation('none') }
```

第二条是评审抓到的 **P0**:今天判据是 `=== 'shared'`,漏掉它 → 池子留着 → 这一趟其实是
**worktree 隔离并发**,而关口逐字承诺了「不建 worktree、不产生任何 git 提交、直接在你当前目录」。
两种情况下 `serialiseExecute` 都是 false,**调度上完全看不出来** —— 用户只会发现产出不在自己目录里。

### E.3 要改的 15 处(评审全表,漏一处就是一句假话)

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `orchestrator.ts:487` | 功能不存在 |
| 2 | `efftask.tsx:2051` | 见 §E.2,**P0** |
| 3 | `efftask.tsx:2471/2553/2587/2679/2686` 五处 `serialExecute: poolRef.current === undefined` | `d` 键继续被拒;表头 `TaskTreePanel.tsx:799` 永久显示「执行串行(无隔离工作区)」而 20 个在跑 |
| 4 | `wiringCoverage.test.ts:139/141/698` 钉死 `occurrences(...) === 4` | 改 3 必然让它变红,同批改 |
| 5 | `depsRecalc.ts:201` | `d` 键在唯一买得到并发的模式里被拒,理由逐字为假 |
| 6 | `scheduler.ts:94-116` `notSchedulableReason` | 关口说「要排队」,实际立刻起跑 |
| 7 | `startupConfirm.ts:237` `isolationChoice(): 'worktree'\|'shared'` | 第三个值在运行时逃出返回类型,下游三处 `iso === …` 全落 else |
| 8 | `startupConfirm.ts:279` autoPush 那一行 | 在一个**零提交**的模式里承诺 `git push` |
| 9 | `startupConfirm.ts:788-814` `parallelismLine`(`opts.isolation: 'worktree'\|'none'`) | 同屏自相矛盾:「执行与叶子验收串行(未启用隔离)」;同一串还进 `feishuStartupCard.ts:35` |
| 10 | `ConfirmStartup.tsx:96/153/289` `forcedShared` | **隔离不可用时 `w` 键整个失效、页脚一个字不写、`iso` 钉死 'shared'** —— 而那正是第三档最该出现的一格。改成「排除 worktree 档,保留 shared ⇄ shared-parallel 的循环」 |
| 11 | `startupConfirm.ts:1072-1091` `isolationChoiceLines` | 逐字写着「并被强制串行」「不会出现两个执行 agent 同时改同一份文件」,选了第三档之后同一次运行里为假 |
| 12 | `efftask.tsx:1253/1329` `notices.push('隔离不可用,…并串行')` | 被 `writeRunManifest` 落进 run.md —— 一句假话留在盘上 |
| 13 | `resumeCore.ts:1239` 白名单 | **比 v1 描述的更糟**:不是降级到「共享串行」,而是跳到光谱另一端 —— `isolationChoice` 回 `'worktree'` → `efftask.tsx:2051` 不成立 → **第一次 `--resume` 之后变成完整的 worktree 隔离运行**,产出从用户目录搬进 `.efftask-worktrees/` 并开始产生提交。而 `ConfirmResume.tsx` 没有 `w` 键,用户无法纠正 |
| 14 | `pipeline.ts:820` `sharedTreeNote` + `rootPlan.ts:78-103` | **根方案起草者一个字的约束都收不到**,而「按文件划分」正是这个模式全部安全性的来源 |
| 15 | 穿线:`OrchestratorDeps` → `PipelineCtx` → `PlanPromptCtx`(`pipeline.ts:833`)→ `draftRootPlan.args` | 这条线上已经断过三次(`orchestrator.ts:22-47` 的注释是那三次的墓志铭) |

### E.4 提示词

- `shared-parallel`:「本次运行没有隔离,**多个任务正在同一个目录里同时工作**。你只能创建/修改
  属于本任务的文件(方案与验收点里点名的那些);不要改别的任务的文件,不要跑会全局改写的命令
  (整仓格式化、更新锁文件、`cargo fmt --all`、`git checkout .`)。」
- `shared`(串行)也要一句更弱的(今天一个字都没有)。
- **根方案起草提示词**要加一句:这一趟是共享并发,**请把子任务按产出文件划分,使任意两个
  子任务不写同一个文件**。

### E.5 明确不动的东西(评审逐条复核成立,写在这里免得来回)

`acquirePlanBase`/`releasePlanBase`、`mergeAndRelease` 早退、执行前 `acquire` 硬闸、
`refreshFromIntegration`、集成验收 cwd、`runOrchestrator.ts:243` 的 `if (ran || !args.worktrees) return`、
`c`/`m` 键无池时隐藏、`startupConfirm.ts:271` 收口方式那一行、`pipeline.ts:4323` 的 `enterAtJudge`。

**外加一条禁令**:`verifySnapshot`(`pipeline.ts:2147-2154`)两道门在共享并发下都关,
落到「(是否改动工作区:未知)」——**诚实降级,不许给它加 `?? ctx.cwd` 回落**。
加了会把**并发兄弟节点的产出**算成「本席改动了工作区」,而那条判据会进 `acceptLog` 成为验收员的证据。

### E.6 已知风险(写进关口,不在代码里假装能防)

两个执行者同时改同一个文件时**没有任何机制能挡住**(没有 git,连冲突都不会报)。
另外第三档下 `m` / `c` / 收口**整套失效**(没有池子、没有集成分支)—— 关口要说。

---

## F(§3). 详情页 `b` 键:回溯子树,从执行阶段重来

### F.1 键位

`b` 实测干净:`sectionPaneAction`(`logView.ts:1054`)、`logPaneAction`(`:827`)、
`runControlAction`(`:915-943`)都不认它,efftask 下 `grep -a` 零命中。
**只用小写 `b`**(Shift 双写法的坑记在 `TaskTreePanel.tsx:406-417`)。
先例引 `c`/`m`(`TaskTreePanel.tsx:479/482`),**不引 `g`** —— `g` 恰恰是详情页唯一真撞车的字母
(`:491` 与 `logView.ts:820` 会同时触发,今天靠 `setDetailId(null)` 卸载日志窗掩盖)。

**两处都要接**:RunningView(`efftask.tsx:2648-2681`)**和** FinishedView(`:2809-2818`)。
§F 的主用例是「验收失败」,那通常发生在结束屏 —— 只接一处 = 功能一半不存在。

### F.2 三步

**1. 扫描(纯读)**:血统走 `descendantsOf`。每个后代量:状态、`acceptLog` 最后一条否决理由、
工作区在不在、HEAD 有没有合入集成分支。

**2. 主模型判定(一次调用)**:
- **模型必须是主模型** —— `pickAgentDefinition(req.role, activeAgents, mainModelDefault)`
  (`runAgentAdapter.ts:440`),**`role` 传 `null` 才是主模型**。传个 RoleBinding 会静默用席位模型。
- `requireTag`(提示词里铺着大量原文,宽松 pick 会把原文当回答 —— `parseRepair` 的同一条规矩,
  它在 `parseOutput.ts:732`)。
- **必须有 AbortController 并 chain 到 run 级 signal**(照 `ConfirmRecalcDeps` 的
  `efftask.tsx:2488-2491`),否则 Esc 关屏之后调用还在烧钱。
- 输出:`redo[{nodeId, why, guidance}]` / `add[{parentId, title, goal, depsOn[]}]` / `keep[{nodeId, why}]`。
- **模型只圈范围,不改判决**:`nodeId`/`parentId` 不在血统里的**丢弃并报出来**(白名单不是黑名单);
  不给 `status`,不给 `acceptLog`。
- **调用失败 ≠ 什么都不做**:退回保守名单 = 血统里所有 `BLOCKED` 的节点。
  **不含「ACCEPTED 但工作区已不在」** —— 那正是按过 `c` 之后的**正常**状态,收进来会把一大片
  健康子树重执行。名单封顶并逐个列出来。

**3. 应用**:见 §F.3、§F.4。

### F.3 N 个节点如何合成**一个** `RedoPlan`(§-1.3 的正面回答)

```
1. 名单定序:按 nodeId 升序。  ——「同一份名单换个顺序得到不同的树」是不可测的,
   而顺序来自模型返回的数组。reopenPropagatedBlocks 是全树不动点,第 i 次跑时前 i-1 个
   目标已不是 BLOCKED,既不进候选也不当种子(redo.ts:946)。
2. affected 全集 = 每次 planRedo 的 {target ∪ deleted ∪ reopenedAncestors ∪ dependencyRewrites}
   的并集 ∪ 每个 add.parentId。
3. hold(affected 全集) —— 在**第一次 planRedo 之前**调一次(orchestrator.ts:122-133:
   hold 守的正是「算树和落盘之间那次 await」)。start 之后释放,清点挂在 promise 的 finally 上。
4. 串接:tree₀ = nodes;tree_i = planRedo(tree_{i-1}, id_i, 'execute', now, ctx).nodes
5. side-lists 逐项取并集:worktreesToRelease / deleted / dependencyRewrites /
   reopenedAncestors / warnings。  —— 串接会让第 2..N 次的这几张表恒空(§-1.3)。
6. 任何一次返回 { error } → 整条不做(盘上一个字节都没动过),把原因说出来。
7. commitRedo(mergedPlan, before) 的 before 必须是**回溯前的原始 nodes**
   —— 传错「工作区一个都放不掉,而且不会有任何报错」(redoRun.ts:109-111)。
```

### F.4 「添加新任务」那一半 —— 三个 P0

1. **`deps` 用 nodeId 会被静默丢掉。** `createChildren`(`pipeline.ts:3504-3519`)只按
   **同批兄弟标题**解析(`titleToIndex.get(t)`),nodeId 永远匹配不到 → 每条依赖被无声丢弃
   → 新任务立刻可调度,和它本该等的节点**并发跑**。共享并发下这正好是最危险的组合。
   → 新任务建好之后,由 backtrack **显式**把 `depsOn` 里通过校验的 nodeId 写进 `node.deps`
   (`depsRecalc` 的 `node.deps = after` 已有先例),并落盘。
2. **`add.parentId` 必须被重开。** `createChildren` 只是把孩子挂上去;父节点是 `ACCEPTED`(终态)
   时 `notSchedulableReason`(`scheduler.ts:86`)永远跳过它,孩子跑完没人裁决;父节点是 root 时
   `orchestrator.ts:496` 第一句直接 `return completed`,**模型调用 0 次**。
   → 父节点坐回 `WAITING_CHILDREN`,并走 `reseatForRerun` 那套祖先放开(复用,不新写)。
3. **`createChildren` 要 `PipelineCtx`**(`reserveNodes`/`byId`/`persist`),而 `orchestrator.ctx()`
   是 private,按键处理里够不着。**手搓一个 ctx 会绕开 `reserveNodes`,`maxNodes` 上限当场失效**。
   → 把 `createChildren` 里**纯**的那一段(id 派生 + goal 组合 + `createNode`)抽成导出的纯函数,
   两边共用一份;`maxNodes` 由 backtrack 对活树同步校验。
   **并且:「添加新任务」只在 run 不在跑的时候可用**(主用例就是结束屏),运行中回溯只重执行、不加任务,
   关口上说明。—— 这是为了不山寨 `reserveNodes` 的原子预留而付的诚实代价。
4. **不许把执行型节点变成拆分型**:`isDecomposed` 的判据是 `childIds.length > 0`,给一个正在
   「从执行重做」的执行型节点加子任务,它当场变成拆分型,链从 `EXECUTE_TAIL` 变成 `INTEGRATE_TAIL`。
   → `parentId` 必须是**已经有子任务的节点**,否则拒绝并报出来。

### F.5 关口

- **`useSettleOnce` 必须有**(`useLiveState.ts:48`)。出口是 `start(nodes, affected)`,和 `ConfirmRedo`
  (`:355`)同一形状,而第十三轮的实测是「三下快回车 = 三个编排器」。
  `ConfirmCleanup`/`ConfirmMergeSubtree` 用的是 `modeRef` 那套等价闩,但它**不覆盖 `onCancel`** ——
  以 `useSettleOnce` 为准。
- 文案**拆成短句**,不能靠 `truncate-end`:正文是 `wrap="truncate-end"`,80 列上一句 60 个全角字
  会被砍掉可操作的后半句。范式见 `cleanupWorktrees.ts:594-597`(一句陈述 + 一句 `⚠` 代价)。

### F.6 明确不做

- 「丢失原因另外的任务去追查」——**排除在本功能之外**(用户原话就是「另外的任务去追查」)。
  回溯不做根因诊断。写在这里,免得有人给它加一个诊断步骤。
- 「重新合并提交」不是单独一步:execute 链尾就是 `commitAndMerge`。但**要有一条探针**把它钉住
  (「回溯完成 = 这些节点的产出重新合入集成分支」),否则它只是隐含成立。

---

## G. 全局约定

1. **每阶段**:`bun test src/tools/efftask src/commands/efftask` 全绿(基线 3468)。
2. **每一处修复都要变异测试**:改回原样确认新探针变红。前十八轮里「幸存 = 探针坏了」应验过七次。
3. **git 判据一律在真仓库上验**(`worktreePool.test.ts` 已有 throwaway repo 骨架)。
   §A/§C/§D 的几乎每一条都是「代码看起来对、真 git 说不对」的形状,只读实现抓不住。
4. UI 一律 `../../ink.js`。全仓 `grep` 一律 `-a`(部分 .ts 被判 binary 静默跳过,已实测)。
5. **P2 顺手带**:`redoCommit.ts:126` 直接 `writeRunManifest` 是 run.md 的第二个写入点,
   与 `queueManifest` 并发;回溯一次动一整棵子树,窗口更宽 —— 改走 `orch.syncToDisk()`
   (`orchestrator.ts:234`,存在的理由逐字就是这个)。
