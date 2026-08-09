# 依赖重算(细粒度依赖)—— 方案 v3

> v1 → v2:四席圆桌(调度/落盘/提示词/界面)首轮评审。
> v2 → v3:同四席的收敛确认。**四席全部给出「改完即放行」**,v3 是那些遗留项的落地。
> `【v2】`= 首轮评审改的,`【v3】`= 收敛轮改的。每处都写清**原来错在哪** —— 不写的话下一个人会改回去。

用户原话:

> 当前任务运行的时候有依赖,需要依赖准备好才能跑。但最开始时,任务粒度比较大,依赖也比较粗。
> 当被依赖的任务被拆细后,其依赖其的任务可以通过手动确发重算其依赖任务,这样可以计算出更细粒度的
> 依赖,有效提高任务并发度。当任务还未开始分析执行时,进入任务详情可手动触发依赖任务重算。重算调用
> 主模型来完成。当无依赖或被依赖任务也未完成分析时,直接返回。记住不要等被依赖任务一定要完成,其完成了
> 下级子任务拆分就可以。如果被依赖任务被拆分成多层孙子任务,重算时要保证其依赖精准度。如依赖其二层
> 孙子任务一项,就得写准确只依赖其孙子任务。如依赖其子任务中某个的所有子任务,就可以写依赖其子任务中
> 一项,没有必要写出所有孙子任务。就是既要细粒度依赖,也不要导致依赖任务数过多。

---

## 0. 现状(读代码读出来的)

| 事实 | 位置 | 意义 |
|---|---|---|
| `depsSatisfied` = 每个 dep 都 `ACCEPTED` | `stateMachine.ts:8` | 粗依赖 = 等整棵子树 + 那一层集成验收 |
| 三道门里**两道**读 `depsSatisfied` | `stateMachine.ts:23/24/31` | 【v2】v1 说「过了 CREATED 就说明依赖已满足」是错的 |
| `integrate` 要 `childrenAllAccepted` **且**随后还有一整场集成验收圆桌 | `stateMachine.ts:31` + `pipeline.ts:4835-5001` | 【v3】所以「依赖一组孩子」解锁**必然不晚于**「依赖它们的父」→ 上卷是纯代价(§4.4) |
| **deps 目前恒为兄弟** | `pipeline.ts:3494-3511` | 本功能**第一次**产生跨层依赖 |
| Kahn 的集合含「环的**下游**」 | `resumeCore.ts:64-65` | 【v2】不能拿它直接判「这次是否成环」 |
| `applyLive` 会 `clearCancel(id)` | `orchestrator.ts:214` | 【v2】会静默复活用户 `x` 过的节点(实测:`onCancelNode` 只置标记不改状态,`efftask.tsx:2110`) |
| `planRedo(entry:'plan')` **不清 `target.plan`**,只把 `kind` 打回 `'unknown'` | `redo.ts:1235-1257`(实测 grep 确认) | 【v3】准入判据 3 要认 `kind`,见 §2 |
| **run.md 的唯一写入点**是 `queueManifest`(串行+合并) | `runOrchestrator.ts:139-178`,注释逐字 | 【v3】应用步**不许**直调 `writeRunManifest`,见 §5 |
| `onUpdate` → `setNodes` + `queueManifest` | `runOrchestrator.ts:348-352` | 【v3】`safeUpdate()` 白拿一次正确的 run.md 写入 |
| `prompt_too_long` 压缩**掐中间留两头**;低于 20000 时原样抛并印一句关于工具的假话 | `runAgentAdapter.ts:875-883/925/942-953` | 提示词必须自己夹(§3.1),`error` 态不许透传那段话(§7.3) |
| 界面与编排器持有**同一批节点对象** | `cleanupWorktrees.ts` 第 5 条 | 改 `deps` 必须原地改 —— v1 落盘顺序错的根源(§5) |
| 详情页页脚 100 列上**基础导航句就占 94/96** | `NodeDetail.tsx:894-896` | 【v2】页脚不能是唯一 affordance(§7.1) |
| `expanded`/`secMode`/`anchor`/`selTitle` **全以段落标题为身份** | `NodeDetail.tsx:613-657`、`logView.ts:605/885/1099` | 【v3】提示**不许**进段标题,见 §7.1 |
| `key.meta` 对 **Escape 恒为真** | `input-event.ts:50` | 【v3】`plain` 守卫只许逐条与,不许早退(§7.2) |

---

## 1. 范围与不做的事

**做**:把一个**被自己的依赖挡住、且还没写过(有效)方案**的任务的粗依赖,替换成被依赖任务
**子树里**更细的若干节点,让它提前起跑。

**不做**:

1. **不自动触发。** 只有用户按键。
2. **不删依赖。** 每个原依赖至少落到它自己子树里的一项。代码兜底,不靠提示词。
3. **不跨依赖挪。** 只能在**原依赖自己的子树内**细化。
4. **不改被依赖方。** 只改本节点的 `deps`。
5. **不在结束屏提供。** 【v2】v1 给的理由(「结束屏没有 CREATED 节点」)**是假的** ——
   `viewOnly`(`efftask.tsx:1744`)编排器从没起来过,盘上的 CREATED 节点原样进 `DoneView`。
   真理由:**结束屏没有编排器**,`hold`/`depsChanged` 都要求 `orch` 在跑。
   这句话要印在 README 键表里(§7.1),不是只写在方案里。

---

## 2. 准入(纯函数,**全部是同步内存读,零 await** —— §7.3 靠这一点)

【v2】v1 的判据 `status === 'CREATED'` 理由与 `stateMachine.ts:24/31` 逐字矛盾;而 `CREATED`
**不等于**「没写过方案」(`redo.ts:1258-1276` 的 `entry==='review'` 坐回 CREATED 却不重出方案)。

五条,全部要满足:

| # | 判据 | 拒绝时说什么 |
|---|---|---|
| 1 | `status === 'CREATED'` | 终态说「这个任务已经结束了(X)」;其余说「已经开始分析了(X),它的方案已经站在旧依赖上写出来了」。**分两句** —— 对 ACCEPTED 说「已经开始分析」是错的 |
| 2 | 此刻确实被挡着(见下 §2.1) | 「本任务此刻没有被依赖挡住,重算买不到并发」/ 或祖先阻断那一支的专属话 |
| 3 | `redoFrom === undefined` **且**(方案四字段全空 **或** `kind === 'unknown'`) | 【v3】`planRedo(entry:'plan')` **不清 `plan`**、只把 `kind` 打回 `'unknown'`(实测),而那恰恰是「马上要按新依赖重新分析」的最理想场景。只判「方案全空」会挡掉它,而拒绝文案「改依赖不会改方案」在那条路上**逐字为假**(下一秒 `stepStart` 就会重写它)。文案:「这个任务已经有一份方案(或正从质疑修复重入),那份方案是站在旧依赖上写的;改依赖不会改方案」 |
| 4 | `control.wasCancelled(id) !== true` | 【v2】「这个任务你按 x 取消过。重算不会把它放回队列 —— 要跑它请先重做」 |
| 5 | 不在 `orch.runningNodeIds()`,也不在 `held` | 「此刻正在被调度器执行,先按 x 取消再来」(**不要**复用第 1 条的文案:`nodeRunning && CREATED` 写成「已经开始分析(当前 CREATED)」是当场自相矛盾) |

### 2.1【v3】「被挡着」和「当场可起跑」必须共用 `pickBatch` 的那份判据

`pickBatch`(`scheduler.ts:69-76`)放行要**四条**:`!inFlight` ∧ `!isTerminal` ∧ `!hasBlockedAncestor`
∧ `advanceableKind !== null`。而 v2 只用了 `depsSatisfied`,于是:

* §2 判据 2 的文案「它马上就会被调度」对一个**祖先 BLOCKED** 的节点是假话(它永远不会被调度);
* §7.3 `done` 的「本任务是否当场可起跑」同一个毛病 —— 而那是这个功能唯一的成功指标。

`hasBlockedAncestor` 是 `scheduler.ts:33` 的模块私有函数。**导出一份共用谓词**
`notSchedulableReason(node, byId, {inFlight, held}): string | undefined`,`pickBatch` 自己改用它
(纯重构),§2 判据 2/5 和 §7.3 `done` 全部共用。不许抄第二份 —— 这个仓库为「同一条判据的第二份」
反复付过账。

### 2.2 逐个依赖的分类(每条都要带**后果**)

| 形态 | 文案 |
|---|---|
| `deps.length === 0` | 「本任务没有依赖,所以没有可细化的东西 —— 它不会因为重算更早起跑」 |
| `byId` 里没有 | 【v2】**这是真故障**:`propagateBlocked` 会以 `依赖节点缺失` 永久挡死它(`orchestrator.ts:627/639`)。「依赖 `<id>` 在这棵树里找不到 —— 这条依赖永远不会满足,本任务会一直被挡住(重算不碰它)。要动它得走重做或跳过」 |
| `childIds.length === 0` | 「还没拆分出子任务,无从细化」(用户点名的「直接返回」) |
| `status === 'ACCEPTED'` | 「已经完成,细化它不会让本任务更早起跑」 |
| 可细化组为空 | 整体拒绝 + 逐条印上面的理由 + 「这次一条都没动,任务树逐字未变」 |

**为什么不扩到 READY / WAITING_CHILDREN**(调度席建议扩,这里明确不扩,且他接受了这个取舍):
那两类都已有方案或子任务,而它们是站在旧依赖上产生的;改依赖不改方案,收益是「早起跑」,
代价是「按一份对不上的方案早起跑」。用户原话也把范围划在「还未开始分析执行时」。
**这个取舍要写进拒绝文案**,不是假装那两类不存在。

---

## 3. 一次主模型调用

* **单独一条 `makeRunAgentFn` 缝**(不复用 `extractAgent`):`role: null`(主模型)、`availableTools: []`、
  `system: ''`(传 `'plan'` 会被 `runAgentAdapter.ts:498` 拼在提示词最前面,给一次非环节调用错误的
  自我定位)、**不挂 `seatPreamble`**、`timeoutMs: () => 120_000`(默认是 600s 静默 × `TOTAL_LIMIT_FACTOR=6`
  = 最长 1 小时,对一次零工具挑 id 的调用是纯浪费)。
* **per-call `AbortController`**,chain 到 run signal:这条缝没有 `control`,`req.signal` 是**唯一**取消通道。
* `node` 传**真节点**:`runAgentAdapter.ts:664-669` 把 usage 记在传进去的 node 上,而 run 总用量和
  详情页只按 `nodes` 累加 —— 传 stub 会让这次用户买单的调用从两处同时蒸发。
* **返回后先判 `signal.aborted` 再解析**:`:421` 在已 abort 时返回 `''` **不抛**,而 `''` 和「模型没答」
  逐字相同 —— 会把一次用户取消报成「所有依赖保持原样」。`rootPlan.ts:133/179` 为同一件事判了两次。
* 窗口:`streams.open({ nodeId: 真节点 id, phaseLabel: '依赖重算' })`。
* 【v3】**Esc 只 abort per-call controller,禁止调 `control.cancelNode`。**
  那会给节点**永久**置上取消标记,而 §2 判据 4 从此拒绝对它重算、`pickBatch` 也永远不选它 ——
  **在重算关口按一次 Esc 会把这个任务从整趟 run 里除名**。代价是 `runAgentAdapter.ts:788-798`
  判窗口颜色用的是 `wasCancelled`,abort 不会让它为真,窗口会收成绿色的「已完成」;
  所以 abort 之前先 `stream.push({kind:'text', text:'\n[已取消]\n'})`,让窗口自己说话。

### 3.1【v3】提示词体积:**只留一个硬数**

v2 给了三个数(单节点字段 200/300/300、单依赖 40 节点、整段 12000),而它们**互相差 2~4 倍**:
一个节点典型 560、最坏 1050 码点,×40 = 22 400~42 000 ≫ 12 000。而且 v2 没说 12000 是每个依赖
还是全部合计 —— 一个节点有 3 个可细化依赖时前者直接把提示词推过 20000,§3.1 自己的立论作废。

**唯一的硬数:整份清单(全部依赖合计)≤ 12000 码点;清单之外(四条规则 + schema + `answerRule`)
≤ 3000。** 其余全部推导:

* **分两趟渲染**:第一趟只写 `id | 标题 | 状态 | 已拆 N 个`(~150~350 码点/节点);
  第二趟在预算有余时才补 `keyPoints`/`acceptance` 摘要(各 ≤300)。
* **节点条数算出来**,不写死:`maxDepth 20` 的树上 id 就有 884 码点,12000 只装得下 13 个。
* **「还有 N 个未列出」的 N 在裁剪之前算好,写在清单最前面** —— 掐中间留两头会先吃掉写在后面的
  那一行(见 [[truncation-notice-must-outlive-the-truncation]])。
* **id 不许按 200 夹**:合法 id 长度 = `4 + 44 × depth`,默认 `maxDepth 5` 就是 224。按深度算或 1000。
* **拒绝条件是可判定的**:连第一趟(id+标题)都超预算 → 在关口拒绝,不发一次注定被掐中间的调用。
* 每个模型自著字段插进提示词前过 `quote()`(`pipeline.ts:1047-1049`)。
* 20000 **不是安全线,是分支选择器**:低于它上游一旦拒收,`runAgentAdapter.ts:875-883` 会印
  「多半是某个工具一次返回了几 MB(例如 Glob 打全仓通配)」—— 这条缝**没有工具**,那句话 100% 是
  错的指路。§7.3 的 `error` 不许透传它。

### 3.2 规则(【v2】删掉「模型自己上卷」;【v3】改成逐项判定)

v1 让模型自己做「全部子任务都要 → 写父节点」的上卷。**那是有损且代码救不回来的**:多列叶子可以
无损压回去,模型自己上卷则把「到底哪几项」当场销毁,结果是一条合法、安全、但**买不到并发**的依赖。

【v3】但只删规则 3 还不够:在「没有工具 + 要求保守」的处境下,模型会倾向于**把该层能看到的都列上**,
而 v2 的无条件不动点上卷(§4.4)会把它们一路卷回 `{D}` —— **有损上卷没消失,只是搬进了我们自己的
代码,还从概率变成了必然。** 代码侧的修法见 §4.4;提示词侧三条,合起来才成立:

1. **逐项判定,不要选粒度**:「对下面清单里的每一项,只问一个问题:**本任务要用到它的产出吗?**
   要就写,不要就别写。」(选择集合会诱发粒度直觉,逐项过滤不会。)
2. **每一项要一句 `why`(≤40 字),说明本任务的哪一步要用它。** 这是最有效的反滥列装置:
   列 12 项就要写 12 条理由;而且它让 §7.4 第一次能逐项给人看。
3. **软上限带反合并条款**:「一个依赖通常 1~3 项就够,超过 8 项请回头确认是不是每一项都真用得上;
   **但确实需要更多就都写出来,不要为了少写几项而改写成它们的父任务。**」
   —— 少了后半句,软上限就是把规则 3 请回来。

另外两条:只能从这个依赖**自己的子树**里挑(含它本身);拿不准就写依赖任务自己的 id(=保持原样)。
**删掉 v2 那句「多写几项没关系(合并由我们来做)」** —— 在 v2 的 §4.4 下它是一句假的安慰,
在 v3 的按需上卷下它仍然在鼓励无理由的广度。**不要在提示词里讲上卷机制**:讲了模型会去迎合机制。

### 3.3 输出协议

* `requireTag: true`,和 `parseExecOutput` 的 `newChildren` 同级(`parseOutput.ts:588-600` 的理由逐字适用:
  改 `deps` 同样是结构性变更,而提示词里铺着别的 agent 写的文本)。
* 接住 `ambiguous`(两个 tagged 块 → 失败关闭)。明写**最外层是一个对象**(答成裸数组会被 `:202` 整个丢掉)。
* 形状:`{"deps":[{"dep":"<原依赖id>","needs":[{"id":"…","title":"…","why":"…"}]}]}`
  —— **同时要 id 和 title** 用于对账(§4.2),`why` 是 per-item(§3.2)。
* **schema 里一个具体 id 都不给**,用 `<从上面清单里逐字复制的节点 id>` 尖括号占位;
  **提示词里一个反引号都没有**。理由:仓库有过「提示词里的示范被模型照抄」的事故
  (`parseOutput.ts:57-76`、`pipeline.ts:1007-1018`),而这里照抄的最坏结果是**树里真有 `root/01-…`**
  —— 一条通过域约束的、真实的、错的依赖。归一化要**认出占位符本身**并单独报。

### 3.4 解析上限

不能照抄 `parseRemedy` 的 3 条 / 200 字(`parseOutput.ts:528/548/552`):`needs` 被截到 3 会让
§4.4 的判据恒不成立,200 字会截断合法 id。

* `needs` **50 条 —— 只做解析层防御**(模型侧软上限是 8,§3.2);截断要写进 `warnings`;
* `id` 按深度算(或 1000);`title` 夹 200(和渲染同一次变换,§4.2);`why` 夹 40;
* 【v3】**输出侧也会截断**:50 项 × (id 884 + 标题 200 + why) 可以是两三万码点的输出,撞上
  `max_tokens` 的后果不是少几项,是 **JSON 从中间断掉** → `sliceTopLevelObject` 返回 `null` →
  连 `fixEscapes` 都不会被调到(`parseOutput.ts:64-67`)→ `requireTag` 下直接全废。
  这正是软上限 8 的第二个理由。

### 3.5 重拟一次(【v3】判据加两种,且必须换新 tag)

照 `rootPlan.ts:143-176`,**一次就够**。触发条件三种:

1. 解析出了对象但 `needs` 全被丢掉;
2. `taggedBlockBroken`(围栏在场但 parse 不出)—— 那个函数存在的**全部理由**就是让重拟能诚实地说
   「你上一轮的 JSON 没解析成功」(`parseOutput.ts:365-374`);
3. `ambiguous`(两个 tagged 块)—— 重拟说「只输出一个块」属实且大概率一次就好。

**重拟必须换一个新 tag**:§3.5 要把被丢掉的 id 逐条回给模型,那等于把上一轮的回答引进新提示词,
模型很可能照抄;tag 不变的话那个被引用的旧块就是本轮 tagged 块,`requireTag` 会把它选成答案。
`roundtableWithInfraRetry`(`pipeline.ts:935-936`)和 `rootPlan.ts:145` 都为逐字相同的理由换过 tag。
回灌的 id 要过 `quote()`。

「模型明确说保持原样」**不重拟** —— 那是一个结论,不是一次失败。

---

## 4. 归一化(纯函数)—— 这个功能真正的心脏

### 4.1 域约束
只保留「存在 ∧ 是 `D` 或 `D` 的后代」的 id(顺 `parentId` 上溯,带 `seen` 环保护)。丢掉的逐条报出来。

### 4.2 id 归一化与救回(【v3】三处判据修正)

模型抄错的形态(按概率):**答标题而不是 id**(最可能 —— 整个系统对模型说的语言就是标题:
`depsSection:849`、`plannedChildren:1428`、`planPrompt` schema `:1278`、`createChildren` 按标题解析)、
只写最后一段、序号形态错(`1-` vs `01-`)、两侧反引号/引号/`- ` 前缀、全角标点。

域约束兜得住**安全性**(一条错依赖都建不出来),兜不住**产出**(全丢 → `{D}` →「没有变化」,
而用户看不出是抄错了还是真没得细)。按仓库的成文线(**唯一可确定的重建 = 接受;相似度 = 拒绝**):

1. 字符串归一化:trim、去两侧反引号/引号、去 `- ` 前缀、去尾斜杠、全角→半角;
2. **分别**解析 id 与 title:
   * id:精确命中,或**唯一后缀命中**。【v3】后缀必须**按 `/` 分段对齐**(命中位置是 `/` 之后,或整串相等)
     —— 裸 `endsWith` 下 `'root/12-y'.endsWith('2-y')` 为真,「序号形态错」会被匹配成**另一个真实节点**,
     那正是本节立意要挡的「相似度匹配」从后门进来;
   * title:【v3】比较双方走**同一次变换**(渲染时过了 `capText(…,200)` 和 `quote()`,模型只能照抄
     变换后那一份;拿它去 `=== 原始 title` 恒不相等)。标题在 `D` 子树内**很可能重复**
     (`createChildren` 只在同一批兄弟内查重,`pipeline.ts:3490-3492`),同名时**弃权**,
     且措辞要和「不在子树里」分开(「B 的子树里有 2 个同名节点,认不出是哪一个」);
3. 【v3】**对账在接受之前**(v2 把它写成第 4 步,于是后缀匹配已经把一个与 title 矛盾的 id 收下了):
   两边一致 → 收;只有一边解析得出 → 收那一边并记 warning;两边矛盾 → 丢并报出来;
4. **绝不做编辑距离/模糊匹配**(先例:`growTree` 认不出 parent 报错不猜 `pipeline.ts:3676`;
   `createChildren` 认不出 dep 标题直接丢 `:3508-3510`;`pickAnswer` 在两个同形块之间失败关闭)。

### 4.3 祖先吃后代(**急切**,因为无损)
同时选了 `X` 和 `X` 的后代 → 只留 `X`。模型明确要了 `X`,所以等 `X` 本来就要发生,丢掉后代不改变
解锁时刻,是纯去冗余。

### 4.4【v3】上卷改成**按需**,不再是无条件不动点

v2 写的是「某节点全部 `childIds` 都在集合里 → 换成它,不动点」。**那是反向优化**:
`advanceableKind` 的 integrate 分支要 `childrenAllAccepted`,**之后还要过一整场集成验收圆桌**才
`ACCEPTED`(`pipeline.ts:4835-5001`)。所以「依赖 `{c1,c2,c3}`」解锁**必然不晚于**「依赖 `X`」,
通常严格更早 —— 上卷是**纯代价**,买到的唯一东西是「条数不膨胀」,而那是 §4.6 数量闸的职责。
配上 §3.2 之后模型倾向于列全,无条件上卷会让输出**恒等于**「没有变化」。

用户原话是「**可以**写依赖其子任务中一项」「**没有必要**写出所有孙子任务」—— 允许减少条数,不是
要求合并。所以:**只在 §4.6 的闸门真的超了才卷,卷到刚好装下就停。**

上卷的三条前提**一条不能少**(它们对按需上卷同样必需):

1. `X.childIds.length > 0` —— 否则对叶子**恒为真**(`every` 对空数组恒真),会把 `D` 子树里每一个
   叶子吸进来再一路卷回 `{D}`。`childrenAllAccepted`(`stateMachine.ts:12-15`)为**完全相同**的
   陷阱写过守卫,照抄;
2. 每个 `childId` 都 `byId.has(...)`(`orchestrator.ts:626` 的 `childMissing` 就是为这个存在的);
3. `X` 只能取 `D` 或 `D` 的后代 —— 否则会卷到 `D` 的父节点上,而那可能是本节点的祖先,
   于是 §4.7 把整次重算判废,用户只看到一句莫名其妙的「放弃」。

### 4.5 假 ACCEPTED 的防线(【v2】把公理换成测量)

v1 把「祖先 ACCEPTED ⇒ 全部后代 ACCEPTED」当不变式。它**只是调度纪律**:唯一支撑它的是
`advanceableKind:31` 的 `childrenAllAccepted`,而 `stepIntegrate` 从头到尾没有再核过一次。
真实交错:`growTree` 在 `pipeline.ts:3704` 的 `await createChildren` 期间,编排器可以把那个
`WAITING_CHILDREN` 的父节点挑去做集成验收(此刻它确实 `childrenAllAccepted`,新孩子还没挂上);
圆桌是分钟级的,回来后 `commit(ACCEPTED)` 会覆盖 `growTree` 写回的 `WAITING_CHILDREN`。

**测量,不假设**:`after` 里每个 `status === 'ACCEPTED'` 的候选 `X`,核一次「全部后代都 ACCEPTED」;
不成立 → **该依赖整条退回 `{D}`** 并写 warning。§5 应用那一刻**再量一遍**。

【v3】两条实现纪律:
* **递归复用 `childrenAllAccepted`**(`stateMachine.ts:12-15`)而不是写第四份遍历 ——
  它对缺失子节点自动 fail-closed,正是这里要的语义;**必须带 `seen`**(`childIds` 可手工编辑,
  一个自指条目会死循环,而这段跑在按键处理里 —— `descendantsOf` 为这件事留过注释);
* **写清覆盖边界**:它只关掉「**此刻**已经破」的那一半;「重算之后才被 `growTree` 那条交错弄成
  假 ACCEPTED」由 §8.1 的残余风险承担。不写清的话下一个人会认为 §4.3/§4.4 无条件安全。

### 4.6 数量闸(【v2】v1 的收敛证明是错的)

v1 说「上卷必然收敛到 `{D}`」—— 那是**单依赖**的下界。总数的下界是 `node.deps` 的**去重**条数,
而它可以大于任何合理的上限(`parsePlanOutput` 对 children 既不限个数也不限长度,`pipeline.ts:1409-1414`)。
照 v1 写成 `while (超限) 上卷()` 就是**死循环 —— 而这段跑在按键处理里,终端会整个卡死**。

* 单依赖闸 `MAX_DEPS_PER_DEP`;
* 总闸判据 = `after.length > Math.max(MAX_DEPS_TOTAL, new Set(before).size)`
  (【v3】用**去重后**的 `before`:`node.deps` 可以含重复,`redo.ts:1207` 为此去过重,
  拿没去重的当额度会凭空放大);
* 上卷循环必须有**显式出口**:本轮没有任何可卷的组 → 跳出 + warning「已卷到每个依赖一项,
  仍有 N 条 —— 这是原依赖条数决定的下界」;
* **两级定序都要确定**(【v3】v2 只留了 dep 级):先卷哪个 dep(成员最多者,同数按 dep id 升序)、
  组内先卷哪一组(同规则)。关口预演和真正执行必须逐字相同(`cleanupWorktrees.ts:114-116` 同规矩)。

### 4.7 最终安全闸(任何一条不过就**整次放弃**,不做部分应用)

* 不得包含本节点、本节点的祖先、本节点的后代;
* 环检测**比较 before/after 两个集合**:`depCycleMembers` 的集合含「环的**下游**」
  (`resumeCore.ts:64-65`),直接用会把「本节点本来就在某个既有环的下游」误报成「这次成了环」。
  只有 `after` 出现了 `before` 没有的成员(或本节点新进集合)才算失败;
* 结果与原 `deps` **集合相同** → 不算失败,如实报(措辞见 §4.8/§7.3);
* 结果**去重 + 按 id 升序**(不用 `localeCompare`,理由同 `scheduler.ts:64-67`)。

### 4.8 产出

```ts
export interface RecalcPlan {
  nodeId: string
  before: string[]
  after: string[]
  perDep: { dep: string; needs: { id: string; why: string }[]; dropped: string[]; rolledUp: string[]; keptCoarse?: string }[]
  warnings: string[]
  unchanged: boolean
  outcome: 'refined' | 'no-finer' | 'rolled-back' | 'all-dropped' | 'unparsed'
}
```

【v3】`outcome` 从三值加到五值。v2 的三值盖不住两种,而它们**下一步动作完全不同**:

* `rolled-back` —— 模型给了合法细项,被**我们自己的**上卷/数量闸卷回了 `{D}`。
  报 `no-finer`(「模型认为确实要等 B 整体完成」)是**假话**。文案要说清是哪一道闸,以及用户能做什么;
* `all-dropped` —— 模型给了项但全被 §4.2 丢掉(「id 对不上,可以再按一次」),
  和 `unparsed`(「模型没按格式答」)不是一回事。

---

## 5. 应用(【v2】v1 的顺序是错的;【v3】删掉直调 run.md)

v1 写「照搬重做,顺序一个字不改」。**那句话本身就是 bug**:重做手上是 `structuredClone` 出来的另一棵树
(`redo.ts:1135`),`applyLive` 之前活树一个字节没变;而本功能是**就地改共享对象**,`node.deps = after`
执行完的瞬间编排器已经在按新依赖调度了,而 `hold.release()` 自带 `nudge()`。落盘失败 =
**内存新、盘上旧,而节点已经按盘上没有的依赖起跑**。

```
1. hold = orch.hold([id])          // 失败:盘上零字节改动;文案不许透传(§5.2)
2. 重新校验(同一个同步回合,和扫描时逐字同一份判据):
     §2 五条 / deps 与扫描时逐字相同 / after 的 id 全部还在
     / §4.5 的假 ACCEPTED 再量一遍 / §4.7 的环检测再跑一遍
   任何一条不过 → release,报「树在这期间变了,请重新按 d」
3. const draft = { ...node, deps: after, depsRecalc: [...(node.depsRecalc ?? []), rec], updatedAt: now }
4. await writeNode(fs, runDir, draft)                 // 先落盘
5. 成功后才就地写回**字段**:node.deps / node.depsRecalc / node.updatedAt
6. orch.depsChanged(id)                               // 见 §5.1;它的 safeUpdate() 会把 run.md 也带出去
7. hold.release()                                     // finally,无条件
8. setNodes([...nodes])                               // depsChanged 返回 ok:false 时的 UI 兜底
```

**第 3~5 步是核心:先落盘、后就地改。** 浅拷贝不破坏「共享对象」那条规矩,因为写回活对象的是
**字段**,不是新对象。

【v2】`depsRecalc` 是可选字段(`createNode` 不初始化,`types.ts:1194-1233`)——
**裸 `.push` 在第一次重算时必抛 TypeError**,而那一刻 hold 已经拿到。用 `[...(x ?? []), rec]`。

【v3】**删掉 v2 的「第 6 步直调 `writeRunManifest`」。** `runOrchestrator.ts:159-160` 逐字写着
「这个函数是 run.md 的唯一写入点,按键那侧两处各写一份迟早不一致」;直调会与串行合并队列
并发写同一个文件(交错的半份 manifest)、绕过运行中调过的并发度/严格度同步、绕过 `stickyResult`。
而它**根本是多余的**:`depsChanged` 的 `safeUpdate()` → `onUpdate`(`runOrchestrator.ts:348-352`)
→ `queueManifest`,`⟲` 标记本来就会在同一次出现,还顺带走对了队列。
§9 那条探针要断言标记是**经 `onUpdate`** 出现的,否则直调也会被判绿。

【v3】**draft 的 stale-write 窗口:安全,而安全来自 `held`,这句话要写进注释。**
`writeNode` 内部有 await,期间若 `propagateBlocked` 改了活对象的 `status`,盘上会落一份旧状态。
实查:`propagateBlocked(false)` 走不到(`orchestrator.ts:494-499` 明写「扣住的时候不许判走不动」);
`propagateBlocked(true)` 只在中止路径,此时落 `status: CREATED` 反而是 reseat 想要的静息态
(CREATED 不在 `ACTIVE` 集合,`reseat.ts:150` 直接 `continue`)。少了这句注释,下一个人会「顺手」
把 draft 改回直接写活对象。

### 5.1 不用 `applyLive`,新开窄口子 `depsChanged`

`applyLive` 对本功能几乎是空操作(传的是同一批对象),真正起作用的只有 `clearStall` / `clearCancel` /
`safeUpdate` / `nudge` —— 而 **`clearCancel` 是有害的**:一个被 `x` 取消过的 CREATED 节点永远不会被
`pickBatch` 选中,标记就一直挂着;`applyLive` 顺手抹掉它,节点起跑、跑完、`commitAndMerge` 合进集成
分支、`intoTrunk` 再合进用户当前分支(`worktreePool.ts:242-264`)—— **用户明确拒绝过的任务,产出
落进了他自己的分支**,而屏幕只说「依赖已重算」。

```ts
/** 依赖被就地改过了:叫醒调度、上屏。不碰取消标记(那是重做的事)。 */
depsChanged(id: string): { ok: true } | { ok: false; reason: string }
// finished 检查 + 该节点是否在飞 + clearStall(id) + safeUpdate() + nudge()
```

§2 判据 4 是第二道闸,两道都要。
【v3】`depsChanged` 的 `finished` 分支**唯一可达的路是 `signal.aborted`**
(`orchestrator.ts:502-505` 保证有 held 节点时不判走不动,而 `root ACCEPTED` 与「本节点是它的后代
且为 CREATED」互斥)。所以 §7.3 `error` 的第二种措辞要说真话:「整个运行已被中止,依赖改动已落盘,
`/et --resume` 之后生效」,不是「没能叫醒调度」。

### 5.2 拒绝文案不许透传

`orch.hold` 的 reason 逐字写着「这次**重做**要走**结束屏**那条路」(`orchestrator.ts:141/146-149`)。
用户按的是 `d`,回他一句关于重做的话是「读起来像功能坏了」的典型;更糟的是它把人指向结束屏,
而 §1.5 明确规定结束屏**不提供这个键** —— 字面意义的死胡同。由本功能套一层措辞。

---

## 6. 落盘 / 恢复 / 渲染

### 6.1 `TaskNode.depsRecalc` + `depsRecalcDropped`

```ts
depsRecalc?: { at: string; from: string[]; to: string[]; note?: string }[]
depsRecalcDropped?: number      // 【v3】读侧夹掉的条数,累加
```

* 写侧白拿(`serializeNode` 是 `{...node}`),缺席时老 node.md 逐字节不变。**写侧不夹条数**
  (照 `resumes`,`resumeCore.ts:1224-1234`)。
* 读侧夹:**保留最老 1 条 + 最新 N-1 条**,上限用一个导出常量。
  【v3】v2 只把丢弃条数写进 `repairs`,**三个问题**:
  1. 写侧不夹 / 读侧夹 ⇒ **恢复后第一次 `commit()` 就把中间那些永久写回没了**
     (`scoreRecord.others` 的注释记的正是这个失败,`resumeCore.ts:112-115`);
  2. 非连续保留在盘上**不可分辨**(`[0].to ≠ [1].from`),而 §6.6 的 redo 退回会制造同款异常
     —— 两种成因在盘上长得一模一样;
  3. `repairs` 进 run.md 走 `slice(0, MAX_RECORDED_REPAIRS)`(`efftask.tsx:1043`,也是 5),
     一趟有 ≥5 条其它修复时**这行字整条不落盘** —— 截断提示又一次死在被截断的东西里面。
  所以丢弃计数**落进节点自己**(`depsRecalcDropped`),**累加不覆盖**(`capBlockingList` 的注释记过:
  重算计数会把「还有 30 条」改写成「还有 1 条」—— 一个描述本趟而非真实损失的数),
  **夹取幂等**(`length ≤ N` 原样返回),body 与 §6.3 的 `⟲ ×N` **都用 `length + dropped`**。
  「最老一条」是**位置意义上的 `[0]`**(插入序),**不要按 `at` 排序** —— `at` 只做 `typeof` 校验,
  拿一个手改过的时间串去排会把锚点排到别处。
* **读回校验照抄 `degraded`**(`resumeCore.ts:583-600`:可选字段、整条丢坏的、内层数组走
  `capBlockingList`、丢了记一条带条数的 repair、空了 `delete`)。**不要**抄 `roundArray`。
* 守卫必须是 `Array.isArray(n.depsRecalc)`,**不能**是 `!== undefined`:YAML 的 `depsRecalc:`(空)
  是 `null`,而 `confirmedDraft` 正是栽在这一行上(`resumeCore.ts:789-791`:一个畸形子节点让整个 run
  恢复失败)。`depsRecalcDropped` 走 `Number.isFinite` + `Math.max(0, Math.trunc())`(照 `:386` 的 `count()`)。
* 逐字段夹:`from`/`to` 走 `capBlockingList`,`why`/`note` 走 `capText`,`at` 走
  `typeof === 'string' ? … : ''`。理由见 `resumeCore.ts:527-538` 的实测(盘上 5000 条 × 508 字恢复后
  一条没夹,再落盘 9.5 MB,而 `commit()` 每次状态迁移全量重写)。

**敌意输入清单**:`depsRecalc: boom` / 空值(YAML `null`)/ `[null]` / `from` 是字符串 /
`at` 是数字 / `why` 是对象 / `to: [null,'x']`(不抛,但静默印出一条不存在的依赖)/ 超长 / 含 `ESC[2J`。

### 6.2 node.md body

加一节 `## 依赖重算`,**必须 defensive**(`Array.isArray` 兜底、每项 `?.`、`stripControl(String(...))`、
`clipBody` **逐条**夹)—— `persistence.ts:110-113` / `:216-219` 各写过一遍:这段跑在**每一次 commit** 上,
抛一次就是节点带着裸 TypeError 阻断并每次 resume 复演。

### 6.3 run.md

`writeRunManifest` 是 **config** 白名单,`depsRecalc` 不进去。但 `renderTreeSnapshot` 每行只印
状态/降级/阻断,**一次重算之后 run.md 逐字节不变**,而 `degradeMark` 那段注释(`persistence.ts:434-443`)
立的规矩正是「**终态相同不等于结论相同,渲染必须说得出差别**」。

照 `degradeMark` 的形状加**条件后缀** `⟲ 依赖重算 ×N`(N = `length + dropped`)。
【v3】取长度要用 `Array.isArray(n.depsRecalc) ? n.depsRecalc.length : 0` —— 同一行的 `degradeMark`
写的就是 `(n.degraded ?? [])`;一个手改的 `depsRecalc: boom` 上 `.length === 4` 会在 run.md 上
印出 `×4`,不抛、不修复、纯造谣。

### 6.4 `validateLoadedNodes` 补两条

1. **依赖指向自己的祖先/后代 → 阻断。** `depCycleMembers` 只走 `deps` 边,查不出这种**穿过父子边**的
   死锁(`P` 等 `childrenAllAccepted` 等 `X`,`X` 等 `depsSatisfied` 等 `P`),Kahn 一个都不报,
   运行以「存在无法推进的阻断节点」收场且**没有任何节点带着理由**,每次 resume 逐字复演。
   而本功能第一次让「手写一个跨层依赖」变成合理的事。
   【v3】**落点是最后一趟**(`validateLoadedNodes` 的 `return` 之前),**不是**和自依赖同一处:
   那个循环跑在父子指针修复之前(`:875-877` 改 `parentId`、`:887-897` 补 `parentId`、
   `:899-906` 补回 `childIds`、`:909-913` 提为根级、`:916-958` 合成 root 并把孤儿挂到 root 下),
   放在前面会按一张**还没修好的**血缘图算,答案取决于 Map 迭代序;更要命的是 `:953-957` 把孤儿挂到
   root 下,**如果它的 deps 里有 root,校验器自己制造出了这个死锁**而检查已经跑过去了。
   【v3】repair 消息**必须带修法**(「请在 `<runDir>/<id>/node.md` 里把 deps 中的 `<ancestorId>` 删掉
   或改成它的一个子任务」)—— `block()` 会清掉三个复活开关,这条新规则会造出一批只能手改救回的节点;
   先例 `redoCommit.ts:92-94`。
2. **`n.deps = strArray(n.deps)` 静默丢边要记 repair**(`resumeCore.ts:368`)。

### 6.5 跨层之后必须跟着改的三处渲染

| 位置 | 现在 | 改成 |
|---|---|---|
| `pipeline.ts:1428` `plannedChildren` | `byId.get(d)?.title` | 非兄弟时用 `父标题 / 本标题` |
| `pipeline.ts:845` `depsSection` | `d.title(status)` | 同上 |
| `NodeDetail.tsx:407` `depsBody` | `d.title(status)` | 同上,**并把真 id 一起印**(§7.5) |

共用一个 `depLabel(id, byId, fromParentId)`。

### 6.6 与重做的交互

`redo.dependencyRewrites`(`redo.ts:1202-1227`)今天在正常路径上**跑不到**(deps 恒为兄弟)。
**本功能一上它立刻变成主路径**。三件事:

1. **`redoCommit` 的失败话术要讲全。** 现在只教用户改 `childIds`(`redoCommit.ts:79-95`)。
   坏序列:子树已删、`writeNode(A)` 抛错 → 盘上 A 仍指着被删的 `B/02` → 下次 `--resume` 走
   `block(A,'依赖节点缺失')`,而 `block()` 把三个复活开关**全部清零**(`resumeCore.ts:339-361`)
   → **`--retry-blocked` 也救不回来,永久死节点**。触发条件扩到「写失败节点的 deps 与
   `dependencyRewrites` 相交」,并点名要改哪几个 id。
2. 【v3】**`planRedo` 改写时追加一条退回记录**(v2 只写 warnings,而 `RedoPlan.warnings` 只显示一帧、
   不落盘):`{ at, from: <上一条的 to>, to: [targetId], note: '因 <targetId> 重做,细化依赖已退回' }`。
   收益是它恢复了一条读的人一定会假设的不变式 —— **`node.deps` 等于 `depsRecalc` 最后一条的 `to`**
   —— 有了它 body 那一节就自解释了,§6.1 第 2 个问题的歧义也随之消失。
   只在「被改写的 dep 命中该节点 `depsRecalc` 最后一条的 `to`」时追加,不无差别地写。
3. §9 加端到端用例。

---

## 7. 界面

### 7.1 键与 affordance

【v2】页脚量过(仓库自己的 `stringWidth`,中文 2 列):基础导航句 94 列,加 `r` 109、加 `c` 130、
加 `d` **143**;而 100 列终端可用 96 列 —— **现有的 `r`/`c` 此刻已经在屏幕外**。所以页脚不能是唯一入口。

【v3】但 v2 的修法(把 `依赖(d 重算)` 写进 `detailSections` 的**段标题**)**是一个新 P0**:
`expanded` / `secMode` / `anchor` / `selTitle` 四个状态**全以标题为身份**
(`NodeDetail.tsx:613-657`、`logView.ts:605/885/1099`)。而 `canRecalcDeps` 的第二半是
`status === 'CREATED'`,节点离开 CREATED 是**编排器 tick 出来的,用户一个键都没按** ——
**重算成功之后用户还停在详情页读结果的那几秒,正是标题改名概率最高的时刻**。改名之后:
用户展开着的那一段自己收起、↑↓ 的语义在他手底下翻面、视口跳回顶部 —— 逐字就是
`NodeDetail.tsx:618-626` 那段注释记录的、这个文件已经付过一次学费的事故。

**修法:提示放进 `depsBody` 的最后一行**,不进 title。body 不是身份(它本来就每秒在变),
而放在**最后一行**意味着它消失时不移动它上面任何一行(锚的 `delta` 相对段标题算)。
页脚那一句仍然加(宽终端上有用),排最后一档。
`README.md:951-964` 的键表补一行,句式照 `c` 那行:`d 重算依赖(只在运行中、且任务还没开始分析时有)`
—— 这也是 §1.5 那句话唯一的成文出口。

**prop 接线**:`TaskTreePanel` 新增 `onRecalcDeps?: (node) => void`;
`canRecalcDeps={props.onRecalcDeps !== undefined && detail.status === 'CREATED'}`
(形状抄 `canRedoFailed` 的 `detail.status === 'BLOCKED'`,`TaskTreePanel.tsx:502-503`)。

### 7.2 顺手修掉整条 detail 分支的 ctrl 洞(已实测确认)

`internal_exitOnCtrlC` 是 false(`main.tsx:2225`),`use-input.ts:77` 于是把 `\x03` 原样派发成
`input='c', ctrl=true`。而 `TaskTreePanel.tsx:409-427` 每一条都**只判裸小写字符,不判修饰键**
(【v3】v2 这里写的是「只判 `k === 'x'`」—— detail 分支里根本没有 `x` 键,那句话会把实现者指去
找一个不存在的东西):

* **Ctrl+C = 打开「清理已完成工作区」关口**;Ctrl+R = 重做;Ctrl+F = 强制通过;Ctrl+S = 跳过;
* **Ctrl+Q = `onExitKey` → 运行视图里 abort 整个 run**。

修法一行:`const plain = key.ctrl !== true && key.meta !== true`,把 `R/s/f/r/c/d` 和 `k === 'q'`
全部 `&& plain`。

【v3】**`plain` 只许逐条与,绝不许写成分支开头的早退**:`key.meta` 对 **Escape 恒为真**
(`input-event.ts:50` 是 `meta: keypress.meta || keypress.name === 'escape' || keypress.option`),
`if (!plain) return` 会让 Escape 当场变死键 —— 而 `TaskTreePanel.tsx:423-424` 立的规矩是
「Esc / q 任何时候都是返回,返回这条路不许有死角」。§9 要加一条「Esc 在 detail 分支上仍然返回」。

**边界:不动 429-437 的树分支**(下面的 `runControlAction` 自己第一句就挡了 ctrl/meta)。
【v3】这一行**单独一个 commit 先落**,重算功能建在它上面 —— 它改的是运行中编排器的中止面,
和依赖重算没有因果关系,混在一起以后 bisect 会同时命中两件事。

### 7.3 拒绝**不切屏**;关口六态

【v3】v2 写「`d` 这一支不清 `detailId`」—— 但 `detailId` 不是被清掉的,是**跟着组件一起被卸载的**:
关口是 phase 级早退整屏替换(`efftask.tsx:1999-2014` 与 `:2043` 的 `running` 分支互斥),
`RunningView` → `TaskTreePanel` 整棵卸载,而 `detailId` 住在 `TaskTreePanel.tsx:356`、
`expanded`/`selTitle`/`anchor`/`tab` 住在 `NodeDetail.tsx:613-657`。药方拦不住那次卸载。

**修法**:§2 的五条准入**全是纯内存读、零 await**,所以:

* **准入拒绝根本不切 phase** —— 由 `TaskTreePanel` 的 `d` 分支拿到一句话,渲染在详情页里
  (`recalcNotice` prop → `detailSections` 的一段)。`detailId` 不动、组件不卸、用户读到哪一段都还在。
  这才是「什么都没发生」应有的样子;
* **只有真要发起模型调用时才切 phase**(那时用户本来就知道自己启动了一件长事),
  `done`/`error` 之后回到 `running`,详情页丢失可以接受,但要**写明**这条路会回到树上;
* 于是 `refused` 从「一整屏」降成「详情页里的一行」,`redoSummaryLines` 只需给 `ready` 用。

关口(只在真调用时开)**六态**(v2 漏了 `error`;`ConfirmCleanup` 实际是五态**含 error**,
`ConfirmCleanup.tsx:45/104-112`):

| 态 | 要点 |
|---|---|
| `asking` | 分钟级。实时输出窗 + 秒表(照 `efftask.tsx:2231`)。**必须写「别的任务仍在照常运行 —— 这一屏只挡住了树,没有暂停调度」**。取消**只收 `q`/`Esc`**(`logPaneAction` 里 `n` 是「下一条流」,叠在同一屏会歧义);【v3】并补一句「要中止整个运行,请先按 Esc 退出这一屏」—— 否则这几分钟里中止整个 run 的唯一通道是 Ctrl+C |
| `ready` | 见 §7.4 |
| `working` | 毫秒级(`hold`/`depsChanged` 都同步),不要照抄清理那屏「删除期间按键不响应」的措辞 |
| `done` | 依赖变了几条、**本任务是否当场可起跑**(走 §2.1 的共用谓词)、**这次调用花了多少 token** |
| `error` | 【v3】三种措辞分开:①盘上没动;②依赖已改并落盘、但**整个运行已被中止**(§5.1 证明这是 `finished` 唯一可达的路);③上游拒收 —— **不许透传**窗口里那句「多半是某个工具返回了几 MB」(这条缝没有工具,100% 是错的指路),自己说「上游拒收:这次提示词只有 N KB,不是我们发多了 —— 多半是这一席的模型窗口太小」 |

另外:**`alive` 闭包旗标**(`ConfirmCleanup.tsx:50-63`;这一屏更需要 —— 秒表 `setInterval` 和输出订阅
都要在 cleanup 里拆)、**空态**(`unchanged` / §4.7 整次放弃都走它,页脚不能写「回车确认应用」)。
【v3】`ready` 屏若也挂输出窗,取消键同样只收 `q`/`Esc`。

**usage 的取舍**(提示词席裁定,接受):拒绝路径**不**补一次 `writeNode` —— §5 整套顺序纪律建立在
「`hold` 失败 = 盘上零字节改动」这个可陈述的保证上,插一次写会新开一类没法说得不荒谬的故障;
损失是自愈的(usage 记在活对象上,下次 commit 带出去)。代价用「三屏都印出这次调用花了多少」补偿。

### 7.4 `ready` 屏

复用 `redoSummaryLines`(`ConfirmRedo.tsx:219-235`),三条配套:

1. **按行造,不要按段造** —— `wrapDisplayWidth` 会在 `root/01-x/02-y` 中间折断。
   每条依赖排成 `依赖:<标签>` / `→ <新 id>` / `因为:<why>` / `丢弃:…` 几条短行;
2. 警告行前缀 `⚠` 并用 `ConfirmRedo.tsx:48` 导出的 `isWarningLine` 上色,**不要**再手写
   `l.startsWith('⚠')`(`ConfirmCleanup.tsx:141` 已经是同一条判据的第二份);
3. **知情同意三句话排在最前面**(`redoSummaryLines` 从尾部夹),【v3】而且要排在 **per-item `why` 行**
   之前(per-item 之后行数随项数线性增长,第 9 项的理由会把第 1 项挤掉):
   * 「重算只看任务树上的标题/目标/方案,**不读代码**」;
   * 「上卷成父任务会**多等一次集成验收**(只在条数超闸时才发生)」;
   * 「细化之后,A 起跑时 `B` 的其它子任务可能还没合进来,A 的工作区里**看不到**它们的代码;
     A 的产出也会在它们完成之前就合进你当前的分支」。

### 7.5 详情页的两段

* 「依赖」段保持**一依赖一行**(它是第 0 段、光标默认停的那一段;未展开只有
  `collapsedLinesFor(contentRows)` ≥3 行且**掐头留尾**,写成 2N 行会让用户第一眼看到的那一段
  退化成一句省略号)。标签换成 `depLabel`,**并把真 id 一起印**(「父标题/本标题」在同名孙节点上
  仍不唯一,而这一段本来就是机器生成段 `md:false`)。**最后一行**放 `(d 重算)` 提示(§7.1)。
* 重算痕迹**单开一段「依赖重算」**(静态标题,不碰身份),排在「依赖」之后、「目标」之前。
  `detailSections` 尾部的 `filter(body 非空)` 天然让没重算过的节点版面逐字不变。
  **不要塞进「迭代次数」**(那是返工计数,重算不是返工)。

---

## 8. 风险

1. **细化过头 = 拿着半成品起跑。** 缓解:代码禁止删依赖、逐项 `why`、关口逐条给人看。
   **残余风险仍在**,是本功能的本质代价。§4.5 只关掉「此刻已经破」的那一半假 ACCEPTED,
   「重算之后才被 `growTree` 交错弄破」的那一半落在这里。
   【v3】同类:按需上卷保留细项时,若 `X` 之后**长出新孩子**(动态生长),依赖 `{c1,c2,c3}` 不覆盖 `c4`
   —— 而依赖 `X` 会覆盖。这是按需上卷相对急切上卷多出来的一份残余风险,接受并记在这里。
2. **细依赖拆掉的正是 spec §16 指定的冲突缓解手段。** `pipeline.ts:5078-5080` 逐字写着
   「spec §16 …… **names dependency edges as its mitigation**」。三条后果:
   * **A 的基线从确定变成不确定**:基线是 `acquire` 那一刻**集成分支的 tip**
     (`worktreePool.ts:434/439`),而集成分支是全 run 累积的 —— 别的子任务在不在里面取决于
     它们跑完没有,而完成顺序是延迟依赖、跑两次可以不一样的(`scheduler.ts:64-67`);
   * 冲突概率上升,而 `refreshFromIntegration` 只在返工轮兜底、撞冲突时**退回旧基线**;
   * **静默的正确性缺口在 `intoTrunk`**:建立在半成品依赖之上的代码,会在兄弟任务还没写完
     (甚至最终 BLOCKED)时就合进用户自己的分支,而 `intoTrunk` 对「这个节点的依赖完整吗」
     一无所知。**这一条必须印在 §7.4 的关口上。**
3. **上卷让门槛变晚**(多一次集成验收)—— 只在条数超闸时才发生,关口要说出口。
4. **模型答非所问**:域约束 + 救回 + 对账 + 兜底 + 假 ACCEPTED 防线 + 环检测,最坏是「保持原样」。
5. **细化过的依赖比粗依赖更容易把节点判成永久死亡**:`depDangling → '依赖节点缺失'` 在
   `redo.ts:704-705` 的 `STRUCTURAL` 里,`--retry-blocked` 和重做都拒绝复活。
6. **一次调用的钱**:无工具、单次、手动触发、120s 超时、三屏都印用量。

---

## 9. 测试(先写探针;变异测试**串行**跑 —— [[parallel-mutation-agents-corrupt-the-tree]])

* **准入**:§2 五条(含 `kind==='unknown'` 那一支)+ §2.2 四种依赖形态 + 可细化组为空;
  §2.1 共用谓词与 `pickBatch` 同源(祖先 BLOCKED 时不许说「马上就会被调度」);
* **解析**:tag 协议 / `requireTag` 失败关闭 / `ambiguous` / 裸数组 / 50 条截断进 warnings /
  id 不被 200 截断 / 占位符被认出 / 重拟三条触发 + **新 tag**;
* **归一化**:域约束、id 五步(**后缀按 `/` 对齐**、标题同变换、同名弃权、对账先于接受)、
  祖先吃后代、**上卷对叶子恒真的陷阱**、上卷三前提、**按需上卷(不超闸时保留细项)**、
  假 ACCEPTED 防线(含 `seen`)、**总闸不死循环**(构造 `before.length > MAX_DEPS_TOTAL`)、
  `before` 去重、两级定序、环检测 before/after 差集、`{D}` 兜底、五个 `outcome` 各自可达;
* **应用**:`hold` 失败零副作用、**落盘失败时活对象一个字段都没变**、`depsChanged` 不碰取消标记、
  陈旧扫描结果被拒、**run.md 标记经 `onUpdate` 出现**(直调要被判红)、拒绝文案不透传「重做/结束屏」;
* **持久化**:`depsRecalc` round-trip、敌意形状、读侧「最老1+最新N-1」+ `depsRecalcDropped` **累加且幂等**、
  `⟲ ×N` 用 `length+dropped` 且 `Array.isArray` 取长度、body 一节 defensive、没重算过的 run 逐字节不变;
* **恢复**:祖先/后代依赖在**最后一趟**被阻断且 repair 带修法、孤儿挂到 root 后不被自造死锁、
  `strArray` 丢边记 repair;
* **重做交互**:①A 依赖 `B/02` → 重做 `B` → A 的 deps 回到 `[B]` **且 `depsRecalc` 追加了退回记录**;
  ②A 依赖 `B/02/01` → 重做 `B/02` → deps 变成 `[B/02]`;③`redoCommit` 写失败时的话术点名 deps;
* **渲染**:`depLabel` 三处、详情页两段、`(d 重算)` 在 body 最后一行且只在 `canRecalcDeps` 时出现、
  **节点在详情页开着时离开 CREATED,`expanded`/`secMode`/`from` 三个数一个都不变**(变异探针)、页脚;
* **按键**:`d` 开关口、**`ctrl+d` 仍是半页滚动**、**`ctrl+c` 不再开清理关口**、**`ctrl+q` 不再 abort**、
  **`Esc` 仍然返回**、非运行视图没有这个键、**准入被拒时不切屏且详情页状态不丢**;
* **文档**:`docsAccuracy` 断言 README 键表那行 / node.md 的 `## 依赖重算` / run.md 的 `⟲` 后缀;
* **端到端(整个功能的验收点)**:B 拆成 B1/B2/B3、A 依赖 B → 重算成依赖 B2 →
  B2 验收后 A 当场被 `pickBatch` 选中。
