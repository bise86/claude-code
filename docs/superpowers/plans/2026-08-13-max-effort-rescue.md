# 尽最大努力去捞 + 捞不回的必须能被回溯认领

用户原话(2026-08-13):

> 按 m 键触发,没有捞回的数据任务,会尝试最大努力捞不。如果实在捞不回来,会在回溯里检查不。
> 如果确认丢了,是否要重做执行阶段或完全重做。
> **补充一点,必须尽最大努力去捞。**

## 今天这条链上真实的三段

| 段 | 现状 | 判定 |
|---|---|---|
| `m` 捞 | 分诊判 `merge` 的才合;`unsure`(含**模型没提到的**)一律 `hold` 不动;孤儿目录**从来只列不捞**;合失败的只报告 | **不是最大努力** —— 一次分诊、一种手段、失败即止 |
| 捞不回 → 回溯 | `backtrackScope` 只认 `lastIntegrateFailed` / `outputMissing` 两条**节点级**信号 | **断的** —— `hold` 是 ref 级的,节点上不留任何痕迹,`b` 扫不到 |
| 确认丢了 → 重做 | 两级阶梯:重新执行(注入意见)→ 完全重做 + 补救拆分 | 通的,不改 |

## 设计:三级递降,而不是一次判决

「最大努力」不等于「拿不准就硬合」。硬合的代价这个仓库在真 git 上验过:一份被验收否决的
废稿撞 add/add 冲突,解冲突的模型不知道右边那半是废稿,把已经修好的文件反向污染了。
所以最大努力要做的是**把「合不了」这件事拆细**,一级一级往下降,而不是在第一级失败时收手。

| 级 | 手段 | 什么时候 | 安全性 |
|---|---|---|---|
| 1 | 整条 `git merge`(解冲突模型) | 分诊判 `merge` | 今天就有 |
| 2 | **加法补录**:只取「这条 ref 上有、而集成分支上根本没有」的文件 | 分诊判 `unsure` 的;**以及第 1 级合失败(已还原)的** | **证明性安全** —— 覆盖不了任何东西,因为目标路径在集成分支上不存在 |
| 3 | 落痕 → `b` 认领 → 重执行 / 完全重做 | 第 2 级之后仍有内容没进来 | 不动 git,交给回溯 |

### 为什么 `skip` 不进第 2 级

`unsure` = 我们没把握;`skip` = 分诊**有理由地**排除(最典型:这一版被后来的版本取代)。
一个被取代的版本里「集成分支上没有」的文件,很可能正是后继版本**故意删掉**的那个 ——
补录回去是另一种污染。这条线 `rescue.ts` 自己已经写着(「拿不准和判定不合要分开数」),
第 2 级照它走。

### 加法补录怎么落到 git 上

复用 `mergeIntoIntegration` 已经验过的形状,一个字节都不新造:

1. `stageAt(merge-scratch, tip)`(现成的:reset --hard + clean -fd);
2. 算路径集合 —— 对 `git diff --name-only <集成分支>...<ref>` 的**全量**结果逐条判:
   `git cat-file -e <ref>:<path>` 成功 **且** `git cat-file -e <tip>:<path>` 失败 → 收;
3. `git checkout <ref> -- <paths…>`(写盘 + 入暂存区);
4. `git commit`,消息里写清 ref、来历(`fate`)、以及「**只补录集成分支缺失的文件,没有覆盖任何东西**」;
5. 锁内 `merge --ff-only <sha>` 进集成分支。

**不是 merge**,所以这条 ref 不会被记成「已合并」—— 我们只取了它的一部分,历史上必须仍然看得出它没合完。

`evidence.files` 是**截断到 20 条**给模型看的,第 2 步必须重新取全量,否则一条 21 个文件的
ref 会静默少捞一个文件。

### 孤儿目录

四类里今天**唯一 0% 捞回**的一格,而用户点名「这个必须要捞回」。它不是 git 工作树,
`git merge` 用不上,但加法补录用得上:`kind: 'absent'` 的文件按同样的流程拷进 scratch → commit → ff。
需要一条 `copyInto` 接缝(纯模块不许自己碰 fs);**不给就退回今天的「只列不捞」**,并说出来。
`kind: 'differs'` 的一律不动 —— 那正是会覆盖的那一类。

### 分诊的二次追问

今天:模型漏掉的 ref 永远落 `unsure`。一次沉默 = 永久放弃,这不是最大努力。
改成:首轮之后把**没被覆盖**的 ref 单独再问一轮(点名「上一轮你没有提到这几条」),
**最多一次**。仍然沉默 → `unsure` → 进第 2 级。

## 落痕:捞不回的怎么被 `b` 认领

新增顶层字段(和 `backtrack` 同形状,随 `{...node}` 落盘、随整体转换读回):

```ts
/** m 键捞过、而没能整条捞回来的 ref。回溯据它认领。 */
rescueStranded?: { ref: string; why: string; at: string; partial?: number }[]
```

- 写入点:`m` 跑完之后,按 `evidence.nodeId` 找节点,`writeNode` 落盘(复用 `noteMerged` 的形状);
- 判据:`backtrackScope` 加第三条 `rescueStranded(n)`,`blocking` 带上 ref 和原因;
- `backtrackLines` 要把它和另外两类分开说 —— 用户按 b 之前要知道这次是为「捞不回来的产出」而重跑;
- **无主的不许假装有主**:`salvageOrphan` 没有 `nodeId`,它落不到任何节点上。
  `m` 的结果屏必须单列一句「这 N 条没有对应任务,回溯认不了,只能自己处置」,并给出 ref。

## 顺带清掉的受众错配与空转探针(上一轮审计的余单)

| 编号 | 位置 | 问题 |
|---|---|---|
| P1-4 | `reviewConvergence.ts:456/484` | `planFeedbackPrompt` 写死「在方案里解决」,而它送给的是执行者 —— 加 `subject` 参数,照 `reviewRepeatNotice` 的形状 |
| P1-6 | `pipeline.ts:1256` | `planPrompt` 说「你有 Read / Glob / Grep」,而各环节共用一个工具池,这句是假的 |
| P2-7 | 解冲突调用 | 拿到 `EXEC_SIDE` 的严格度,却引用它没有的验收点/keyPoints,也没有「必须真的写文件」 |
| P2-8 | `verifyFixPrompt` | `EXEC_SIDE` 引用了这一屏根本没渲染的 keyPoints |
| P2-9 | `CROSS` | 对不判决的席位说「你按补充后的意图判」,而且「执行侧」指反了 |
| P3-10 | 观察席 | 收到了 `JUDGE_NOTE` |
| 探针 | 执行提示词 | 没有任何**禁语**断言 —— 杀死跑机那一趟的原话(「不要改动文件」)可以原样加回去而全绿 |
| 探针 | `fusePrompt` | `not.toContain('原样交出')` 是空转,真正冲突的措辞是「原样保留」 |
| 探针 | 判席 | 「不许自己动手」没有反向断言 |

## 圆桌评审推翻了什么(2026-08-13,数据安全席 / 规范席 / 接缝席)

上面「级 2 证明性安全」这句话**在评审的玩具仓库上被逐条证伪**。以下全部是修正后的判据,
方案正文里和它冲突的地方以这一节为准。

### 加法补录的真实判据(每一条都对应一次实测复现)

| # | 复现 | 判据 |
|---|---|---|
| 洞 1 | 候选集合为空时 `git checkout <ref> --` 是**切分支**,不是空操作 → 整条废稿被 ff 进集成分支,而且下一趟 `stageAt` 的 `reset --hard` 把那条抢救分支挪到了集成分支 tip(**那一版产出唯一的落脚点被销毁**) | 空集合**直接跳过,连 checkout 都不许发**;补录前断言 scratch 是 detached |
| 洞 2 | `checkout -- <path>` 的 path 是 **pathspec(通配符)**:`pages/[id].tsx` 把 `pages/d.tsx` 一起覆盖了 | 一律 `:(literal)` 前缀,并分批发(argv 长度) |
| 洞 3 | 集成分支上 `foo` 是文件、ref 上 `foo/` 是目录 → 补录 `foo/bar.txt` 时 git **删掉** `foo`(`D foo / A foo/bar.txt`) | 逐条检查**所有祖先前缀**在 tip 上是不是 blob;并且 commit 前 `git diff --cached --diff-filter=DMR` **必须为空**,非空就还原 —— 这条断言才是把「没有覆盖任何东西」从提交消息里的一句话变成会失败的判据的东西 |
| 洞 4 | 集成分支**故意删掉**的文件被复活(删除本身也是成果) | `git rev-list -1 <tip> -- <path>` 非空而 tip 上没有 ⇒ 删过 ⇒ 不收 |
| 洞 5 | `A...B` 是 merge-base 口径,判据是 tip 口径:同一件事,ref 碰过 → 复活,没碰过 → 漏掉 | 候选清单改用**两点** `git diff --name-only <tip> <ref>` |
| 洞 6 | `core.quotepath=false` 去不掉 `"` / `\` / tab 的 C 引号 → 那几条静默漏捞 | `--name-only -z`,按 NUL 切 |
| 洞 7 | `cat-file -e <tip>:<sub>` 对 gitlink 返回 128 → 「集成分支上没有」误判 | 存在性一律用 `rev-parse --verify -q`;`160000` 一律不补录 |
| 洞 8 | ff 不成立时补录的提交只挂在 detached HEAD 上,下一趟被 gc | 有界重试 3 次,**每次重算候选集合** |
| 链接 | 补录一个 `120000` 的新路径可能是 `escape -> ../../../../etc`,它随后会进用户的检出 | 目标是绝对路径或逃出仓库根的,不收 |

**唯一确认安全的一条(要写进代码注释)**:`git checkout <tree-ish> -- <path>` 把 ref 的 blob
**原样**装进 index,不重跑 clean filter;`commit`(无 `-a`)提交的就是 index。前提是
**不许 `commit -a`、不许在 checkout 之后 `git add`**。孤儿目录那条路(`copyInto` + `git add`)
**没有**这个保证 —— 那是从工作区文件正常入库,clean filter 该跑,但要在注释里写明区别。

### 规范席:`unsure` 进第 2 级是在翻一条付过账的不变量

`rescue.ts` 写死了「模型没提到的也是拿不准,不是合 —— 这个仓库为『沉默被读成同意』付过账」。
方案把整格 `unsure` 送进补录,**等于把默认方向从安全那一侧翻到了动手那一侧,而没有一句承认**。
修正:

- 补录**不是**合并,它只加集成分支从来没有过的路径,而且是**单独一笔可 revert 的提交** ——
  「拿不准一律不合」原样有效,新增的是一条**严格更弱**的动作。这句话要写进 `rescue.ts` 的规矩里,
  而不是留在文档里。
- `fate === 'superseded'` 的 `unsure` **不补录**:后继版本删掉的那个文件,正是补录会复活的那个
  (和洞 4 同一个形状)。
- `skip` 的归宿**写死**:不补录、**也不落痕**(不能让 `b` 去重做一个有理由被排除的废稿),
  但屏幕上必须和 `unsure` **分成两句话**说,并给出「要推翻这次分诊就自己 `git merge <ref>`」的命令 ——
  今天它们混在同一个 `hold` 桶、同一行渲染,用户读到的是「先放着」,实际是「永远放着」。

### 规范席:三处「今天做得到、而方案没做」

- **`salvageOrphan` 认得回主** —— `worktreePool` 打抢救提交时把**节点 id 明文写在提交信息里**
  (`efftask: 固化工作区残留 (<id>)`)。一条 `git log --format=%s` 就能认回,再用
  `worktreeSlug(runId, id)` 正向校验,零猜测。方案「无主的只能自己处置」建立在一个代码里就是假的前提上。
- **`git fsck --unreachable` / branch reflog** —— `worktreePool` 自己的注释里记着两处实测的
  「落在零个 ref 上、只剩 reflog」的丢失形态,而 `scanStranded` 的全部 ref 探测只有一句
  `for-each-ref .../salvage`。至少要扫出来列进 `problems`,而不是屏幕上一个字都没有。
- **自噬回路**:`b` 之后节点被打上 `backtrack` → `stranded.ts` 的 `fate` 判据把它全部抢救 ref
  变成 `superseded` → 下一次 `m` 大概率判 `skip` → 出局。而那条 ref 可能正是唯一的副本。
  修正:`fate` 的 `superseded` 只认 `contributed === true`;被回溯过单列成 `redone`,
  分诊提示词里说清「它被重做过,但**不知道新版本有没有产出**」。

### 接缝席:落痕的正确形状

- **注记做判据,字段做载荷**(`outputMissing` 已经是这个形状):`execStatus` 上一句常量决定 `b` 认不认领,
  `rescueStranded` 字段只带明细。字段丢了只是少了明细,不会让 `b` 静默扫不到。
- 写入点**只能在 `runSubtreeMerge` 里**(`rescue.ts` 拿不到 `persist`/节点),而且**必须覆盖
  `plan.rescue.merge.length === 0` 那一支** —— 那正是生产上最常见的一趟,只挂在 `runRescue` 之后
  等于最需要落痕的那次一个字都不写。
- **痕迹要被回溯消费掉**:`planRedo` 是 `structuredClone`、`resetForExecute` 只追加不清空,
  不清的话按完 `b` 之后这个节点**永远**被判进来。清除点是 `markBacktracked`。
- **`backtrackScope` 的第三条判据不能和另外两条同权**:一条 ref 挂在**拆分型节点**上时,
  `suspects` 为空 → 回溯它自己 → `planRedo(execute)` 对拆分任务判 disabled → `composeRedos`
  一错整条不做 → **连那些真正集成验收没通过的节点一起,一个都不重跑**。
  所以:只对 `childIds.length === 0 && kind !== 'decompose'` 的节点立 target,
  而且这一类**恒走第 1 级**(不吃 `levelFor` 的终身计数 —— 否则一条没捞回的 ref 会触发删子树)。
- **二次追问必须先看 `signal`**:`planRescue` 今天从头到尾没读过 `deps.signal`,Esc 之后照发;
  再加一轮就是照发两次。
- `copyInto` 有**三个**注入点(`efftask.tsx` 的真 fs、`scanRescue` 的字面量 deps、`runRescue` 的字面量 deps),
  少一处就静默退回「只列不捞」—— 那正是这个仓库的招牌断线。

### 会变假的屏幕文案(落地时逐条改)

`rescue.ts` 的「将把 N 处…**合进集成分支**」「合完这些分支照样保留」「**保留不合** N 处」
「想自己看 `git diff <集成分支>...<ref>`」「这个目录**没法合并**,请**手工取用**」;
`mergeSubtree.ts` 的「上面这 N 项**合并解决不了**(产出丢了 / 集成验收没通过)」
和确认屏那句「**任务状态不会被改动**」(`m` 从此会写 node.md);
`backtrack.ts` / `backtrackRun.ts` 的「没有需要回溯的任务:集成验收都通过了,**产出也都在集成分支上**」;
以及 `handoffResolve` 送给模型的那句假前提「下面这些任务的**集成验收没有通过**」——
它对 `outputMissing` 那一格**今天就已经是假的**。

### 规范席:第三段其实是断的(方案原文说「通的,不改」——错)

`backtrackRun` 的 `guidance` **只**从模型映射里来:`deps.map` 缺席或抛错 → 保守名单 → 一个
`guidance` 都没有 → `attachGuidance` 根本不进。而屏幕无条件承诺「把集成验收的意见**注入执行提示词**」。
`BacktrackTarget.blocking` 从来没有被送进 `attachGuidance`。修正:模型缺席时用 `blocking` 兜底注入,
并且屏幕上要说清这一趟注入的是什么。

## 不做

- 不删任何东西(捞是加法,这条铁律不动);
- 不改两级阶梯(用户已经定过);
- `differs` 的孤儿文件不自动取用 —— 那是唯一会覆盖的一格。
