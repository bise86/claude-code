# 详情页 `a` 键:用一段提示词新增任务

用户原话:「在任务详情页,新增一个按钮,触发后可以输入提示词来新增任务。这个任务的提示词就是输入的。」

> **本文档经过两轮打回:四席圆桌评审(方案 / 质量 / 接缝 / 规范)全判不通过 → 重写 →
> 落地 → 多角色验收再次判不通过 → 按验收结果修。**
> 只留这一份,不留版本号。下面每一条判据后面带 `[评审]` / `[验收]` 的,都是被至少一席用
> file:line 或实跑输出打回来的;带 `[实测]` 的是自己跑出来的读数。

## 0. 一句话,以及那句硬约束的准确说法

详情页(和任务树上)按 `a` → 输入一段话 → 这段话成为一个新任务的 `goal`,挂进当前这棵树,
由编排器按正常的七个环节跑完。

「这个任务的提示词就是输入的」是硬约束,但它的准确说法是:

> `goal` = 输入框**收下的那段话**,一个字不拼接(不加父目标、不加「上级方案要点」、不加
> 「本子任务:」)。输入框自己有几条变形,**每一条都必须在关口上说出来并逐字回显**:
> 长度上限 4000、控制字符会被滤掉(两者合并计入 `dropped` 并上屏)、首尾空白会被去掉,
> 以及 `\r` 单独成块时会被终端解析成回车。
>
> **确认屏印的那一段就是最终落盘的 `goal`** —— 两者不是同一段字符串的话,「逐字」这句话
> 在用户唯一能核对的地方是假的(验收席实测:走 Esc 那条路回来时印的是未 trim 的原文)。

`createChildren` 给模型拆出来的子任务拼上下文是对的(`pipeline.ts:3824-3827`,它手上只有一个
≤200 字的标题);这里用户自己写了整段话,替他改写就是把他写的东西换掉。方案席核过
`ctxGoal(node)` 就是 `node.goal`(`pipeline.ts:1513`)、`planPrompt` 本来就只喂目标 + 工作目录,
**所以逐字不拼是对的,别改**。

### 0.1 `LineInput` 的三条实测,以及据此要做的三处改动

`[实测]`(真渲染 + 真按键,读数见下表):

| 输入形态 | 会不会提前提交 | 今天的结果 |
|---|---|---|
| `\n` 在块首 / 块中 / 块尾 / 裸块 | **不会** | 折成空格 |
| `\r`、`\r\n` 在块**中间** | **不会** | 折成空格 |
| 一次 read **恰好只拿到** `\r` 这一个字节 | **会**(`parse-keypress.ts:701` 是 `s === '\r'`) | 提交半截 |
| 以 `\r` **开头**但后面还有字的块 | **不会** `[验收推翻了上一版这一行]` | 折成空格 / 留成换行 |
| 4000 字一整块 | 不会 | 完整到达 |

所以:

1. **`LineInput` 加 `keepNewlines?: boolean`(默认 false,现有三个调用点逐字节不变)。**
   为真时 `\r\n`/`\r`/`\n` 统一成 `\n` 留在正文里 —— 换行在块内对解析器就是普通字符,
   实测证明这条路通。剩下那一种(块恰好以 `\r` 开头)是**既有**行为,今天同样会提交半截,
   不因这个开关变好也不变坏;**写进代码注释**,别让下一个人以为多行已经万无一失。
2. **超上限不再静默。** 今天 `LineInput.tsx:77` 是 `Array.from(...).slice(0, maxChars)`,
   实测 `maxChars=5` 喂 `abcdefghij` → 提交 `abcde`,而**整帧里没有任何一个字**提到丢弃
   `[评审:规范 P0-1 / 质量 P0-3]`。改成累计 `dropped` 计数并画进页脚。`control.ts:229-239`
   为**同一件事**写过 `dropped` 和那句「(较早的 N 条追加指令因数量上限已被丢弃)」。
3. **`LineInput` 要裁剪渲染** `[评审:接缝 P2-4]`。今天是裸 `<Text>{text}</Text>`,4000 码点
   在 100 列下是 40 个终端行;`/et` 非全屏渲染在对话流里,帧高超过视口会让任务树那个 1s tick
   每跳一次逼出一次整屏重置,而且**切掉的是顶部**(标题和 hint)。只画尾部若干行,
   并在**被裁掉的那一段之外**印「上面还有 M 行」(截断提示必须活过截断)。

## 1. 交互

- 动作键 **`a`**(add)。`[评审:规范席逐字母核过]` 三张动作表
  (`sectionPaneAction` / `logPaneAction` / `runControlAction`)和两支 `useInput` 里
  实际占用的是 `+ , - . < = > ? _ b c d f g G h i j k l m n N p q r R s t u x` —— 没有 `a`。
- **详情页和任务树两支都接** `[评审:规范 P1-9]`。`m`/`c`/`b` 已经因为「用户站在树上按不到」
  被提到树那一层(`TaskTreePanel.tsx:572-597`,跑机实测 + 用户原话);「站在树上看着一堆任务,
  想在旁边补一个」正是这个键最自然的触发姿势。`g` 之所以只留在详情页,理由是它是节点级抢修
  (`:584-586`)—— `a` 不属于那一类。
- **判据写 `input === 'a'`,不写 `k === 'a'`** `[评审:规范 P2-14]`。`k = input.toLowerCase()`
  会让 `A` 一起触发,而这一屏本来就在教用户按 Shift(`R 重做失败环节`),`a` 紧挨着 `s`(跳过)。
  `plain` 守卫挡 Ctrl/Alt,挡不住 Shift。附带:`input === 'a'` 天然不认长按合批的 `'aaa'`。
- 按下 `a`:
  - **准入不过 → 不切屏**,一句话画到页脚(走 `act()` + `notice{kind:'action'}`,
    `TaskTreePanel.tsx:491-499`)。切屏会把任务树连同详情页整棵卸载,用户展开到哪一段、
    读到第几行全没了。
  - 准入过 → `AddTask` 关口。**照 `ConfirmRedo` 的形状:确认屏在前,`e` 进输入框**
    `[评审:规范 P1-6]`。理由是「打完字连敲两下回车」是最常见的输入习惯,而
    「输入→确认」的排法会让第二下回车落在确认上,用户从没看见过后果。
    - 第一次进来 `prompt` 是空的 → 直接停在输入屏;写完回到确认屏。
    - 输入屏用 `initialText={prompt}` `[评审:规范 P1-7]` —— `LineInput.tsx:30-36` 的 prop 注释
      逐字记着:不给它,想改一个错字的人只补了半句,原句就被替换掉了。
    - 确认屏页脚照 `ConfirmRedo.tsx:460`:`回车/y 确认 · e 改提示词 · Esc 返回 · q 取消`。
      **返回和取消是两个键**,不能让唯一的出口把他刚写的整段话丢掉。
- **两态都传 `isActive`** `[评审:接缝 P1-8]`。`/et` 声明了 `spawnsSubagents`,权限对话框画在
  它之上而 `useInput` 是广播的 —— 一下回车既确认了新增**又批准了一个待确认的带写工具**。
  现存六个关口一个都没传(仓库现存的洞),新增面不继承。
- **`useSettleOnce`,确认和取消共用一把闩** `[评审:全四席]`。`useLiveState.ts:30-55` 记着
  「三下快回车在同一个 run 目录上起了三个编排器」;这条路的下游同样是 `startRun`。
- 页脚提示 `a 新增任务` **排在 `actionHints` 最前面** `[评审:接缝 P2-5]`,不排在
  `b 回溯未通过的子任务` 后面被翻到第 2/3 页 —— 它是全新的、没人猜得到的键。

## 2. 挂在哪儿(anchor)

详情页/光标那个节点记作 T。候选按顺序是 **[T, T 的父节点 P]**,取第一个「可挂」的;
两个都不可 → 拒,并把 T 的理由和 P 的理由**都**说出来。只上卷一层,不递归。

**「可挂」的判据(白名单,逐条与):**

| # | 条件 | 不满足时说什么 |
|---|---|---|
| 1 | 不在飞,**也没被别的操作扣住**(`runningNodeIds()` ∪ `heldNodeIds()`,由调用方并起来传)`[验收]` | 「它此刻正在运行(或被另一次操作扣住)」 |
| 2 | `cancelled !== true` 且 `control.wasCancelled(id) !== true` | 「你按 `x` 取消过它 —— 新增不会替你改主意,要跑它请先按 `r`」 |
| 3 | `depth + 1 <= caps.maxDepth` | 照抄 `pipeline.ts:4004` 的措辞 |
| 4 | 状态落在下面三种之一 | 印出状态名 + 那一档的理由 |

第 4 条的三种,**其余一律拒**(白名单,不是「非终态就行」)`[评审:方案 P2-9]`:

| 形态 | anchor 的状态怎么动 |
|---|---|
| `WAITING_CHILDREN` 且 `childIds.length > 0` | **不动**(它已经在等子任务) |
| `ACCEPTED` | 重开成 `WAITING_CHILDREN` + `kind='decompose'`(见 §3.1) |
| `BLOCKED`,非结构性,且 `childIds.length > 0` | 同上 |

三条各自的理由:

- **`CREATED` / `READY` / 其余非终态叶子一律不可挂,上卷到 P** `[评审:全四席,三席各自打回]`。
  这个仓库**已经有一份**「能不能往这个节点挂子任务」的判据,就是 `growTree`
  (`pipeline.ts:3986-4002`),注释里带 `(reproduced)`:
  > grafting onto a CREATED/READY node overwrote its status and kind, so its own plan and
  > execute phases were **deleted outright** … The safe set is: the executing node itself,
  > or a node that is already waiting on children.

  我上一版援引的「`stepStart` 末尾那条 graft 守卫」(`pipeline.ts:3726-3730`)**不是安全网,
  它就是丢失的机制**:它排在 `commit(READY)` 和 `createChildren` 之前,`childIds` 一非空就
  无条件把 `kind` 写成 `'decompose'`,于是 ① T 这一轮分析出来的整份拆分被丢掉、
  ② T 自己那份 executable 的活再也没有任何一条路会去干 —— 正是本节要防的「把 FAIL 变成 PASS」
  换了扇门。更硬的一条:`pipeline.ts:3544-3561` 会因 `childIds.length > 0` 把
  `confirmedDraft`(用户在根方案关口逐屏批准过的首层拆分)**整个作废**。
- **`BLOCKED` 叶子不可挂**:把它放成 `WAITING_CHILDREN` 会让它绕过自己失败的那个执行环节,
  之后靠集成验收就能 ACCEPTED。拆分节点没有这个问题 —— 它自己的「活」就是判决,重开之后
  集成验收会重跑。
- **`ACCEPTED` 叶子可挂**:它自己的活已经做完并合进集成分支了,重开只是让它重判一次
  「子任务合起来还算不算达成了父目标」。

`T` 是 root 且不可挂时没有 P → 拒,说清为什么(极少见:root 通常是拆分节点)。

关口上**必须逐字印出 anchor 是谁、以及为什么不是 T** —— 两种挂点是这个功能唯一会让人意外的
地方。

## 3. 祖先链

`runLoop` 的循环首句是 `if (root.status === 'ACCEPTED') { … return completed }`
(`orchestrator.ts:519-522`,**不是 `run()` 里**)。所以 anchor 到 root 这条链必须整条打通。

- **逐个调 `reopenAncestor`,由它自己判动不动** `[评审:方案 P1-5]`。它同时处理 ACCEPTED 和
  非结构性 BLOCKED(`redo.ts:725-755`);只写「凡是 ACCEPTED 的」会让最常见的那种树
  ——T 挂了、P 因 `childBlocked` 阻断、一路红到 root—— 落进「新任务永远不被调度而屏幕说加好了」。
- 链上出现**结构性** BLOCKED(`依赖节点缺失`/`子节点缺失`/`依赖成环`,`redo.ts:704`)→ **整个拒**。
  它返回 `false` 不动,而新节点挂上去会被 `propagateBlocked` 的 `parentBlocked` 当场扫成 BLOCKED。
- 链上任何一个 `cancelled === true` → **整个拒**,指向 `r` `[评审:方案 P1-4]`。
  不能让 `reopenAncestor` 的 `n.cancelled = false`(`redo.ts:734`)去抹它:那是 §6 亲手立的
  规矩(「用户明确拒绝过的任务把产出合进他的分支」),而控制侧的取消集合又**不清**,
  重开的节点一进圆桌就会被 `registerCall` abort,再把新任务一起摁死。
- 清哪几个字段**不复述**,见 `redo.ts:725-755` `[评审:规范 P2-13]` —— 我上一版列的清单
  数错了个数还漏了三样,而立场本来就是「复用,不写第二份」。

### 3.1 anchor 那一份不能用 `reopenAncestor` 当 drop-in

`redo.ts:730` 是 `n.status = n.childIds.length > 0 ? 'WAITING_CHILDREN' : n.kind === 'executable' ? 'READY' : 'CREATED'`
—— 状态是**从调用那一刻的 `childIds`/`kind` 现算的**,而它是给「祖先」写的(祖先按构造必然
有子节点)。anchor 是叶子时,三种调用顺序有三种结局 `[评审:质量 P0-1 / 方案 P0-1 / 接缝 P0-2,
质量席实跑出 `status=READY, advanceableKind=execute`]`:

| 顺序 | 结果 |
|---|---|
| 先 reopen 再 push childIds | `READY` + `executable` → `advanceableKind='execute'` → **带写工具的执行者把一份已验收、已合入的产出再跑一遍** |
| 先把 kind 改 decompose 再 reopen | `CREATED`(还能救,但不是表里承诺的状态) |
| 先 reopen 再改 kind | `READY + decompose` → `advanceableKind` 恒 `null` → 节点**永远推不动**,run 以「存在无法推进的阻断节点」收尾 |

**修法**:把 `reopenAncestor` 里那段字段清理抽成 `clearReopenMarks(n, now)` 并导出;
anchor 那一份**显式**写 `status='WAITING_CHILDREN'`、`kind='decompose'`,再调
`clearReopenMarks`。祖先仍走 `reopenAncestor` 原样(它们的 `childIds` 非空,算出来就是对的)。
探针:reopen 之后 anchor 的 `(status, kind)` 必须是 `('WAITING_CHILDREN','decompose')`,
且 `advanceableKind(anchor) !== 'execute'`。

## 4. 关口上要说的话(少一条就是一次静默)

1. 新任务标题(见 §5)+ **最终落盘的那段提示词逐字回显**;超过一屏时写
   「提示词(共 N 字,以下显示前 M 字)」`[评审:规范 P1-10]`,截断提示落在被裁范围之外;
2. **输入框做过什么**:折平了几处换行 / 因上限丢了 N 字(没发生就不印);
3. anchor 是谁;anchor ≠ T 时**为什么**;新节点的**最终 id**(slug 可能退化成 `node`,
   两个不同任务在目录里会长得一样,只印标题不够)`[评审:方案 P2-12]`;
4. 会被重新打开的上级任务清单(标题 + **原状态**,ACCEPTED / BLOCKED 两类都要),
   一句「它们会重跑集成验收」;
5. anchor 自己被重开时:**印出它原来的阻断理由**,以及「它的集成验收/评分预算会被重置」
   `[评审:方案 P1-7]`。(行为保留 —— 不重置的话它一重开就再次触顶,把新任务一起摁死;
   但 `reseat.ts:260-270` 为同一件事写着相反的政策,所以这里必须说出口。)
6. anchor ≠ T 且 T 仍是 BLOCKED 时:「T 仍然是失败的,新任务跑完也不会让它变绿 ——
   要让这棵树跑完还得对 T 按 `r`/`R`/`s`」`[评审:方案 P1-6 / 质量 P1-10]`。
   判据现成:`notSchedulableReason(T, byId)`。
7. 新任务什么时候开跑:`notSchedulableReason` 现算(和 `pickBatch` 同一份判据);
8. **结束屏那条路**额外两句:「确认后会重新起一轮编排来跑它」;以及
   `startRun` 会 `clearAllCancels()` + `clearAllForcePasses()`
   (`efftask.tsx:1774/1784`)—— 「此前按 `x` 取消过的 N 个任务会重新获得机会,
   M 条预先批准会失效」`[评审:接缝 P1-6]`。

## 5. 新节点长什么样

```ts
createNode({
  id,                              // 见下:落盘那一刻现算
  title,                           // 去控制字符后的第一条非空行,按码点截到 40
  goal: prompt,                    // 输入框收下的那段话,逐字
  parentId: anchor.id,
  deps: [],
  depth: anchor.depth + 1,
  phaseRoles: anchor.phaseRoles,   // 和 createChildren 一致
  now,
})
```
外加 `manualAdd?: { at: string; anchorId: string }`。

- **id 在 hold 之后现算,而且要防撞** `[评审:全四席]`。`childId` 自己的注释写着
  「same (index, title) twice yields the same id, and writeNode would **overwrite**」
  (`persistence.ts:117-118`),`createChildren` 记着实测后果:「reset an ACCEPTED sibling to
  CREATED, wiped its execStatus … irreversible loss of real work」。三条会撞的路都真实存在:
  关口开着时 `growTree` 从**别的节点的执行步**里往同一个 anchor 挂子节点(`hold` **挡不住它**
  —— `held` 不在 `ctx()` 里)、重做删过子树后序号回退、以及两个不同提示词派生出同一个 slug
  (`修 bug!` 和 `修 bug?` 都 → `03-修-bug`,规范席实跑)。
  **修法**:index 取 anchor 现有子 id 里 `NN-` 的最大值 +1(不是 `length`),然后
  `while (byId.has(id)) index++`;落盘**之前**再查一次。
- **标题**:`trim()` 只吃空白,首行是控制字符时 `stripControl` 之后是空串,树上会多一行没名字的
  任务 `[评审:方案 P2-12]`。所以取「去控制字符后的第一条非空行」,全空回落固定名。
  **不问模型要标题**:一次可以失败、要花钱、还会卡住按键路径的调用,换一个直接截得出来的字符串。
- **`manualAdd` 必须上屏,否则等于没加** `[评审:规范 P2-15]`。`persistence.ts:341-343/365-366`
  两处立过「只落 frontmatter 等于只做到机器可读那一半 —— body 才是人读的那一半」。
  所以:`serializeNode` 的 body 加一行 + `detailSections` 加一段(先例是
  `{ title: '补充指引(你写的)' }`)。round-trip 本身成立(`serializeNode` 走 `{...node}`、
  `parseNodeFile` 整份 yamlParse、`nodeDelta` 深比较搬整值、`resumeCore` 就地改字段),
  质量席已实跑验证;§9 那条探针仍要写 —— 它挡的是以后有人给 `serializeNode` 加白名单。
- **`manualAdd` 还要进 anchor 的集成验收证据** `[评审:方案 P1-8]`。`pipeline.ts:2276-2328`
  把每个子节点摆给集成验收圆桌,问「这些子任务合起来达成父目标了吗」。一个用户手写的、
  可能和 anchor 目标毫无关系的子任务原样混进去,双向都坏:要么 anchor 因为一个它方案里从没
  承诺过的子任务被判不通过,要么圆桌把它当成父目标的一部分从而放宽判据。加一行
  「(用户在运行中手工新增,不在本节点原方案里)」,和它旁边「降级放行必须自报家门」
  (`:2280-2290`)逐字同因。
  注意这和「不写 `execStatus`」不矛盾:对 N **自己**的验收,「谁加的」不是判据;
  对 anchor 的**集成**验收,它是前提。
- **4000 字会往下传** `[评审:方案 P2-14]`。`pipeline.ts:3826` 让子任务 goal 以父 goal 开头,
  所以 N 一旦被拆开,这段话原样进它每一个后代的 goal 和每一次提示词。数字不改,
  §1 的 hint 措辞要说「它和它所有后代的每一次提示词」。

## 6. 落盘与生效(运行中)

这是一个**就地改共享对象**的功能,顺序照 `applyRecalc`(`depsRecalcRun.ts:155-196`),
**不是** `runRedo`(后者 `structuredClone` 整棵树,2215 节点实测 71 秒,而它同步跑在按键处理里)。

```
1. hold([anchor, ...anchor 到 root 的整条祖先链])     ← 同步;失败 = 什么都没发生
2. reserveOne()                                        ← 原子,和 createChildren 共用 maxNodes 预算
3. revalidate:重跑 addTaskScope,与关口那一份比对
4. id 现算 + 防撞(§5)
5. 草稿:anchor / 各祖先各一份,childIds 显式换新数组
6. 落盘(全部带 journal):新节点 → anchor → 各祖先
7. 落盘全成功之后,才把字段就地写回活对象
8. publish:orch.taskAdded(newNode, affected) + 显式 onNodes(orch.nodes())
9. finally:hold.release() + reserve.release()
```

逐条为什么:

- **第 1 步扣整条链,不只扣「要重开的」** `[评审:质量 P0-4 / 方案 P0-2]`。`reopenAncestor` 对
  非 ACCEPTED 非 BLOCKED 的祖先早退返回 `false`,于是一个处在 `WAITING_CHILDREN + 子任务全
  ACCEPTED`(此刻就 integrate 可派)或已在 `INTEGRATION_ACCEPT` 的祖先**不在重开名单里、
  也就不被扣**。落盘那次 `await` 期间它被派出去、拿旧树判通过、一路 ACCEPTED 到 root →
  下一轮 `runLoop` 首句 `return completed`。屏幕说「确认后即可被调度」,而 run 已经收工。
  `orchestrator.ts:139-145` 逐字写着「最真实的是**被放回的祖先**」。
  拒绝时点名是哪个上级在跑。
- **`hold` 的拒绝措辞要改写** `[评审:规范 P2-16 / 接缝 P2-2 / 质量 P2]`:
  `orchestrator.ts:155/161` 说的是「这次**重做**要走结束屏那条路 / 请先按 x 取消,再**重做**」。
  recalc 已经为此套过一层(`efftask.tsx:3119-3127`),这里照做。
- **第 2/3 步的次序定死** `[评审:规范 P1-12 / 质量 P1-7 / 接缝 P2-1]`(上一版编号和 bullet
  自相矛盾)。hold 在前:它是同步的、失败最常见。
- **第 3 步是新加的** `[评审:规范 P0-4 / 质量 P1-5]`。关口开着时编排器**一秒都没停**
  (`ConfirmRecalcDeps.tsx:159` 屏幕上就写着这句)。用户读 §4 那八条要 30 秒,这期间
  T 可以从 CREATED 跑成 WAITING_CHILDREN 并长出子节点、祖先可以重新 ACCEPTED、
  链上可以冒出结构性 BLOCKED。`applyRecalc` 有 `revalidateRecalc`(`:161`)正是为此。
  不一致 → 整个拒,把差异说出来,盘上一个字节不动。
- **第 5 步必须换数组** `[评审:质量 P1-9]`。`{...anchor}` 与活对象**共享 `childIds` 数组**,
  `draft.childIds.push()` 直接改到活对象上,第 7 步「落盘失败 = 内存和盘上都还是旧的」当场作废。
  写成 `{...anchor, childIds: [...anchor.childIds, id], iteration: {...anchor.iteration}}`。
- **第 6 步走 `writeNode(fs, runDir, n, journal)`,journal 由 `createNodeJournal` 现建**
  `[评审:接缝 P1-1]`。`persistence.ts:486-491` 写着生产路径必须传;`redoCommit.ts:56/117` 是
  先例。这条路上最脆的一个字节正是 anchor 的 `childIds`。
- **第 6 步的顺序(新节点在前)不变**,但**失败要分档说** `[评审:质量 P1-6 / 方案 P2-10]`。
  上一版承诺「落盘失败 = 什么都没发生」,而那是假话:新节点写成功、anchor 写失败时,盘上留下
  一个孤儿 node.md,而 `resumeCore.ts:1041-1047` 会在下一次 `--resume` **主动把它补回父节点的
  childIds** 并开始跑。所以:
  - 新节点写失败 → 盘上什么都没有,如实说;
  - anchor 写失败 → 尽力 `removeNodeDirs(fs, runDir, [newId])`;删不掉就逐字说
    「新任务的文件已落在盘上但没挂进树 —— 下次 `--resume` 会自动把它挂回 anchor 下面并开始跑,
    不想要请删掉 `<path>`」;
  - 祖先写失败 → 说清哪几个没写回去,以及后果(下次 resume 读回旧状态,新任务不会跑)。
  顺序本身**不许反过来**:反过来是「子节点缺失」,而 `resumeCore` 的 `block()` 会把
  `interrupted`/`capBlocked`/`mergeConflict` 三个复活开关全部清零(`:360-382`),
  `--retry-blocked` 和重做都救不回来。
- **第 8 步显式 `onNodes`,不靠 `safeUpdate` 的副作用** `[评审:接缝 P1-2]`。
  `orchestrator.ts:337-339` 的 `safeUpdate` 是 `try{...}catch{}` —— 渲染器抛一次,新节点就在
  盘上、在编排器里、真的在跑,而**树上没有它**,一行日志都没有。`runRedo` 是显式
  `deps.onNodes(...)`(`redoRun.ts:120`)。
- **`taskAdded(node, affected: readonly string[])`,不是单个 anchorId** `[评审:接缝 P1-1]`。
  这次碰过的是 `[新节点, anchor, ...重开的祖先]`,而 `applyLive` 的 `clearStall` 是对
  `affected` 逐个清的(`orchestrator.ts:224`)。`taskAdded` 内部:先 `byId.set` + `safeUpdate`,
  再判 `finished` 决定 nudge 与返回哪一句 `[评审:质量 P1-11]` —— 反过来会让盘上有、内存有、
  屏幕上没有。
- **不复用 `applyLive`**:它顺手 `clearCancel(affected)`,而 anchor 可能正是被 `x` 过的节点。
- **不直调 `writeRunManifest`**:`queueManifest`(`safeUpdate → onUpdate`)是 run.md 的唯一写入点。
- **落盘期间 run 不会自己收尾**,靠的是 `orchestrator.ts:598` 那条「有 held 节点时不判走不动」
  `[评审:接缝 #15]`——写下来,免得以后有人把它当成多余的分支删掉。
- **`streams.dropNodes([newId])`** `[评审:接缝 P2-7]`:childId 由「父id + 序号 + slug」算出,
  重做删过子树之后新 id 可能和被删的逐字相同,`hydrate` 会把上一轮的输出挂到新节点详情页上。

## 7. 结束屏那条路(run 已经跑完 / 被中断)

- **第一句是 `redoUnavailableReason({ aborted: props.signal.aborted, runId })`**
  `[评审:接缝 P0-3]`,而且挡在**按键那一刻**,不是让用户写完 4000 字、看完后果、
  确认完再看一次失败。根因在 `orchestrator.ts:540`:中断过的 run 里 `runLoop` 第一圈就
  `return {status:'blocked'}` —— 界面闪一下回到同一屏,模型调用 0 次。四个 done 侧 handler
  每一个都先调它(`efftask.tsx:3379/3391/3401/3412`)。
- 没有编排器,所以 §6 的 1/2/3/8 不成立:capacity 用 `nodes.length + 1 > caps.maxNodes`
  (抽一个纯函数和 `reserveNodes` 共用判据 `[评审:规范 P2-17]`),树是静态的不必 revalidate。
- 落盘顺序、失败分档、journal、防撞 id **逐字不变**。
- 写回的是 React 那份 `nodes`(它们就是同一批对象),然后 `setNodes` + `startRun(cfg, nodes)`;
  `startRun` 返回 false 要**说出口**(`efftask.tsx:1981-1986` 的先例),而且那句话必须真的
  画在结束屏上。
- 需要一个 `addTaskFrom: Phase` state `[评审:接缝 P1-7]`,和 `redoFrom`/`forcePassFrom`/
  `cleanupFrom`/`mergeFrom`/`backtrackFrom`/`repairFrom` 同构:写死 `'done'` 的后果
  `efftask.tsx:1126-1131` 逐字记着(「run 还在跑而界面已经变成结束屏,而什么都没有出错」)。

两条路共用同一个 `runAddTask(deps)`,deps 的形状照 `RedoRunDeps`(每一步一个可注入回调)——
理由和 `redoRun.ts` 文件头那段逐字相同:这几步长在 `efftask.tsx` 里的话,唯一的防线是源码文本
断言,而验收实测过 **14 条存活变异**。

## 8. 模块划分

| 文件 | 内容 |
|---|---|
| `src/tools/efftask/addTask.ts` | 纯判据:`addTaskScope` / `deriveTitle` / `nextChildIndex` / `addTaskLines`(关口文案) / `capacityRefusal` |
| `src/tools/efftask/addTaskRun.ts` | 顺序与失败的说法:`runAddTask(deps)`,§6/§7 共用 |
| `src/tools/efftask/orchestrator.ts` | 新增 `taskAdded(node, affected)` 与 `reserveOne()` |
| `src/tools/efftask/redo.ts` | 抽出并导出 `clearReopenMarks`;导出 `reopenAncestor` |
| `src/tools/efftask/pipeline.ts` | 集成验收证据里给手工新增的子节点加一行 |
| `src/tools/efftask/persistence.ts` | `serializeNode` body 印 `manualAdd` |
| `src/tools/efftask/types.ts` | `TaskNode.manualAdd?`;`MAX_TASK_PROMPT_CHARS`(注释里写清为什么不是 2000) |
| `src/commands/efftask/LineInput.tsx` | `keepNewlines` / 非静默截断 / 裁剪渲染 |
| `src/commands/efftask/AddTask.tsx` | 确认屏 + 输入屏,`useSettleOnce`,两态都 `isActive` |
| `src/commands/efftask/NodeDetail.tsx` | `canAddTask` prop(**真准入**,不是「回调给了没有」`[评审:规范 P1-11]`)+ 页脚 + `manualAdd` 段 |
| `src/commands/efftask/TaskTreePanel.tsx` | 详情支与树支各接一次 `input === 'a'` |
| `src/commands/efftask/runOrchestrator.ts` | `Phase` 联合体加 `'confirmAddTask'` `[评审:接缝 P2-8]` |
| `src/commands/efftask/efftask.tsx` | 关口分支(插在 `phase==='running' && directiveOpen` **之前**)+ 运行/结束两条接线 + `addTaskFrom` |
| `README.md` | 详情页/任务树键位表各加一行 |

## 9. 测试(每一条都要**跑**)

1. `addTask.test.ts`:§2 白名单逐行 + **`NODE_STATUSES` 逐个状态跑一遍**(那个数组就是为这种事
   存在的);上卷一层;root 叶子拒;结构性阻断拒;`cancelled` 拒;深度阀拒;容量拒;
   标题派生(多行/纯控制字符/超长/纯符号 → slug 退化);`nextChildIndex` 防撞(已有 `03-` 时给 04)。
2. `addTaskRun.test.ts`:落盘顺序(新节点先、anchor 次、祖先末),用记录调用序的假 fs;
   **每次 `writeNode` 都带 journal**;anchor 写失败时**活对象一个字段都没变**(显式断言
   `anchor.childIds.length` 不变 —— 不点明数组共享,这条探针测不出来)且尝试删掉孤儿目录;
   删不掉时那句话逐字上屏;hold 失败 / reserve 失败 / revalidate 不一致时盘上零字节;
   成功路径 `taskAdded` 与 **`onNodes`** 都被调用且参数正确;四条出口上 hold 和 reserve 都被释放。
3. `orchestrator`:`taskAdded` 之后新节点在**别的节点还在跑**时被 `pickBatch` 选中(真跑一次
   `run()`,不是断言 nudge 被调过);在飞祖先上 `hold` 拒绝;`finished` 之后仍 `byId.set`+上屏
   但不 nudge。
4. UI 真渲染 + 真按键:`a` 在详情页**和树上**都开关口;`Ctrl+A` / `A` 都不触发;
   准入不过时**不切屏**且页脚有字;`isActive=false` 时回车不提交;
   **一个 chunk 里两个 `\r` 只执行一次**(`useSettleOnce`);确认屏 `e` 回输入屏且原文还在。
5. `LineInput`:`keepNewlines` 为真时多行粘贴保留换行、为假时逐字节维持现状;
   超上限时页脚说出丢了几个字;超高时只画尾部若干行且「上面还有 M 行」在被裁范围之外。
6. 端到端:**两棵树各跑一遍** —— 一棵全 ACCEPTED、一棵祖先链全 BLOCKED —— 新节点都真的跑到
   ACCEPTED,root 被重开,run 结束时它在树上。
7. round-trip:`manualAdd` 写下去、`parseNodeFile` 读回来、`resumeCore` 之后仍在;
   `serializeNode` 的 body 里看得见;`detailSections` 里有那一段。
8. **接线闸门(必须补,否则必然假绿)** `[评审:接缝 P0-4]`:`wiringCoverage.test.ts` 是逐特性
   手写枚举,没有「RunningView 声明的每个 prop 都出现在 `<TaskTreePanel>` 里」这类通用闸门;
   `docsAccuracy.test.ts` 是 README→代码单向断言,没有代码→README 的反向检查。所以要照
   `g` 键那一节(`:1173-1214`)的形状钉五跳,其中 **`occurrences('onAddTask={') === 2`**
   (两个视图各一次 —— 只查存在会被另一处满足),外加 README 一行 + 一条 `docsAccuracy` 断言。

## 9.1 验收打回的那一批(已落地,判据记在这里)

多角色验收(规范 / 质量 / 接缝三个镜头,每一席都真的跑了代码)判**不通过**,而且三席的
结论有一个共同形状:**工程层(落盘顺序、journal、孤儿分档、接线闸门)站得住,而问题
全在「屏幕上写着的和实际发生的不是一回事」,并且每一条都落在没有任何探针的位置。**

1. **复核漏比 `anchorSeat`(P0)**。anchor 在关口开着的几十秒里跑完(`WAITING_CHILDREN`
   → `ACCEPTED`),`anchor.id` 和 `reopen` 清单**都没变** → 旧判据放行 → 落盘却按旧的
   「不用改状态」走,新任务挂在一个**终态**父节点下面:它自己会被派出去跑,而 anchor 的
   `advanceableKind` 恒 null,永远不会再集成它;root 照样 ACCEPTED,run 报 completed,
   `--resume` 一句话都不说。修法:`scopeDiff`(纯函数)逐项比,任何一项变了整次放弃。
2. **`hold` 挡不住 `growTree`,而写回用的是旧快照(P1)**。落盘期间别的节点的执行步往同一个
   anchor 上挂子节点,拿两次 await 之前那份 `childIds` 整份写回去,会让它**从内存和盘上
   同时消失**,而它还在树里、还会被派出去跑。修法:落盘前重取、写回时合并(`mergeChildIds`)。
3. **「确认后跑不跑得起来」问的是重开**之前**的树(P1,两席各自复现)**。于是在这个键最典型的
   用法上(盯着一个挂掉的任务按 `a`)同一屏自相矛盾:上半屏「会从 BLOCKED 重新打开」,
   下半屏「还不会马上跑:上级仍是阻断的」。修法:`addedTaskBlockedBy` 收下这次操作自己
   要放开的那几个,只报**放不开**的阻断。
4. **关口按 `phase` 渲染,run 一跑完就被卸载(P1)**。`runOrchestrator` 收尾无条件
   `setPhase('done')` → 用户正在打的几千字一起没了,屏幕上零解释。同源的第二条:确认之后
   **任何**一条拒绝都会关掉关口,那几千字要重打。修法:渲染条件只看 `addTaskTarget`;
   提示词提到 `EffTaskRunner` 那一层,**只有真的加成功了才清空**。
5. **确认屏的两个数字都是假的(P1,两席各自量出读数)**。`<Text wrap="truncate-end">{整段}</Text>`
   让 ink 按框宽再截一次:号称「显示前 400 字」,120 列下实际画出 40~57 个;而 40 行的
   提示词会把标题和全部 ⚠ 后果行顶出屏幕。修法:按 `wrapAnsi` 真实折行、按行数裁、
   数字现算,截断提示落在被裁那段**之外**。
6. **`LineInput.maxBodyRows` 按逻辑行数,不算折行(P1)**。4000 字**单行**画出 49 个终端行、
   一句「上面还有」都没有 —— 而那恰恰是这个 prop 注释自己写的那个场景。修法同上。
7. **三处静默改写(P2)**:控制字符被滤掉却不计数(粘一段带 ANSI 的日志,字节直接消失)、
   `DEL(U+007F)` 反而留在正文里、Esc 那条路把「N 个字没有收进来」整条丢掉(而那条路正是文档
   承诺用来「把写的留住」的)。修法:全部并进 `dropped`,并随 `onCancel` 一起交出去。
8. **`deriveTitle` 只换掉 ESC 那一个字节**(P2):`ESC[2J` 剥完剩下可打印的 `[2J`,标题
   就是它。修法:先剥整条 CSI 序列。
9. **两处注释在说假话(P2)**:①「编排器把被扣住的也折在同一个集合里」—— 折的是
   `pickBatch` 的入参,而界面拿的是 `runningNodeIds()`,它**不含** `held`;于是
   「(或被另一次操作扣住)」那半句拒绝语永远不会成立。修法:开 `heldNodeIds()` 并集。
   ②「恰好以 `\r` 开头的块会被解析成回车」—— 真渲染真按键推翻了它,`parse-keypress.ts:701`
   的判据是 `s === '\r'`(**整块恰好等于** CR)。两处都按实测改写。
10. **`clearReopenMarks` 漏清一次性标记(P2)**:一个带着 `skipPhase='accept'` 被重开的节点
    会**跳过一关它自己都还没走到的判决**。`validateLoadedNodes.block()` 和
    `reopenPropagatedNode` 都清了,抽出来的这第三条路漏了。
11. **anchor 自己被重开、但它底下还有别的孩子阻断着(P2)**:关口只说「会重新打开」
    「即可被调度」,而重开之后 `advanceableKind(anchor)` 因为那个兄弟恒为 null。要说出来。

## 10. 明确不做,以及明确记下来的边界

- 不给新任务自动配依赖;不问模型要标题、要挂点 —— 整条路**零模型调用**,所以它同步完成、
  在按键处理里就能给出确定的答复。
- 不支持一次加多个任务。
- **`hold` 挡不住 `growTree`** —— 写下来,别让下一个人以为它挡了(防撞 id 是唯一的防线)。
- **深度阀不由「已有的阀」管** `[评审:规范 P1-8 / 方案 P2-13 / 接缝 P2-3]`:`maxDepth` 只在
  `pipeline.ts:3736`(节点自己要拆)和 `:4003`(growTree)**创建前**判,没有任何一处收拾
  已经建出来的超深节点。所以判据必须写进 `addTaskScope`。
- 多行提示词在「块恰好以 `\r` 开头」时仍会提交半截(§0.1),这是既有行为,不因这个功能变化。
