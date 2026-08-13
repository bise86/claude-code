# 方案(第 2 版):让产出自己送到,以及报告问题的那一屏要提供解决它的键

跑机实测(qianbase-xtp run 001)。用户原话两句:「这些老是提示这些进不去执行 m 键,应该
怎么办,这个不能自动解决吗」「这个不应该自动合进来吗」。

第 1 版经三席圆桌评审(交互可达性 / git 数据安全 / 捞回完整性)**全部判不通过**。本版把
三席的 P0/P1 全部并入,并**重排优先级** —— 新增的 E 节是 607 个提交堆起来的直接原因,
排在原来三节之上。

---

## E. 让 git 去判,别在前面猜(**最高优先**)

`worktreePool.ts:245-255`:每个子任务合入集成分支之后,要往用户分支送那一跳之前,先跑
`git diff --quiet` / `--cached --quiet`,**只要用户目录里有任何一个已跟踪文件是脏的就整个
跳过**,理由写的是「你的改动不该被一次合并卷进来」。

真 git 实测(席位二):

- 合并碰不到那几个脏文件 → 直接成功,用户的改动**毫发无损**(merge 提交只含已提交的
  内容,不会卷进未提交的东西);
- 真要覆盖 → git 当场拒绝(`error: Your local changes to the following files would be
  overwritten by merge:` + 文件名),**一个字节不动**。

**git 的保护是逐文件的、原子的;我们这道闸是「一处脏就全不合」。** 跑机上的后果:607 个
提交全堵在集成分支上,而那 3 个脏文件跟绝大多数任务八竿子打不着。

而且**这条路的失败分支本来就已经安全**(`worktreePool.ts:278-315`):判据用「有没有
`MERGE_HEAD`」而不是「有没有 UU 行」,无条件 abort,再复核现场(`restored`);git 被拒
那一类根本不留 `MERGE_HEAD`,`restored` 直接为真;git 的原话会被带出来,而且特意不只取
第一行(「would be overwritten」那句没有宾语,文件名在后面几行)。

**改法**:去掉 `intoTrunk` 的前置脏闸,直接 `git merge`,按 git 的三种回答分流:

1. 成功 → 完事(脏文件原样在);
2. `Your local changes to the following files would be overwritten` → **如实说是哪几个
   文件撞了**,并且只在这里提供 C 节那一档;
3. `The following untracked working tree files would be overwritten` → 列出撞名的未跟踪
   文件,让用户挪走(**绝不能用 `-u` 把它们卷进 stash**)。

**前置修复(必须先做)**:`integrationMerge.ts:373-380` 现在只分支了 untracked 那一串;
tracked 撞上时会掉进底下的 3 次重试循环,最后报「你在同步期间反复提交,重试 3 次仍未合
上」——**一条假原因**。

同一条闸的另外三处副本一并处理:`integrationMerge.ts:322`(收口跳)、`finishHandoff.ts:108`、
`mergeSubtree.ts:477`(`m` 键的第 2 跳)。

**探针**:真 git 仓库四格 —— 干净 / 脏但不相交 / 脏且相交 / 未跟踪重名;每格断言「用户
那几个脏文件在合并前后逐字节相同」。

---

## F. 按 `q` 退出之后,salvage 和保留工作区永久失联(**P0,席位三**)

`runOrchestrator.ts:286` `if (h.commits > 0)` 才落 `pendingHandoff`,而 `h.kept` 和
`h.salvage` 就在同一个对象里(`:293`),一起被丢掉;`efftask.tsx:1256` 再判一次同样的门。
而 `scanStranded` 全仓库**只有一个消费者**(`mergeSubtree.ts:382`),只能从 `m` 键那一屏
进入。于是:一个逐任务合并跑完(`commits === 0`)、留下 7 条 salvage 和 3 个保留工作区的
run,按 `q` 之后 `--resume` 什么都不弹,再也没有任何一条路径提到它们。

**改法**:落盘判据改成 `h.commits > 0 || h.kept.length > 0 || h.salvage.length > 0`;
`efftask.tsx:1256` 同步放宽;收口关口在 `commits === 0` 但有 salvage/kept 时退化成一屏
「这一趟没有待合的提交,但还有 N 处产出没送到 —— 按 m 捞回 / Esc 跳过」。

配套(P1-6,席位三):`efftask.tsx:2579-2583` 只要 `out.trunk?.ok === true` 就
`clearPendingHandoff()`,而 `planRescue` 完全可能把若干 ref 判进 `hold`(`rescue.ts:224-236`;
`triage` 缺席时**全部**落 hold)。清记录的判据要加 `hold.length === 0 && merge 全部成功`,
有 hold 时保留记录并把 salvage 列表更新成剩下那几条。

---

## G. 「功能没达标」那两格被算出来之后静默丢弃(**P0,席位三**)

用户原话第三段(「功能没有达标的」)对应 `stranded.ts:86-97` 的 `missing`(产出丢了)和
`integrateFail`(集成验收没过),`action: 'backtrack'`。而 `scanRescue` 里 `refOnly`
(`mergeSubtree.ts:398-400`)只收 merge 那四格,`notices`(`:409-411`)只收
`action === 'report'` —— **backtrack 那两格两边都不进**,被唯一的消费者扔掉。
`stranded.ts:23-24` 自己写着「漏一格就是『全部捞出来』这句话变成假的」。

**改法**:`notices` 判据从 `=== 'report'` 改成 `!== 'merge'`,并在 `subtreeMergeLines` 里
单开一句:「这 N 项合并解决不了(产出丢了 / 集成验收没通过)—— 按 `b` 回溯」。加兄弟常量
`MERGE_KEY_REPORTS`,探针断言**分类表里每一格都被某个键认领或某一屏念到**(现有探针
`mergeSubtree.test.ts:407` 只断言 `action:'merge'`,恰好照不到)。

---

## A. 把 `m`/`c`/`b` 提到树这一层

### A.0 先补 `plain` 守卫(**阻断项,席位一**)

树这一支(`TaskTreePanel.tsx:548-551`)**没有 `plain` 守卫**,而详情页那一支有
(`:457`)。照第 1 版原样加键的后果,真渲染实测:

- **Ctrl+C → 打开「清理已完成工作区」关口**(这一屏唯一删目录的键;本 fork 的
  `internal_exitOnCtrlC` 是 false,`main.tsx:2225`,Ctrl+C 原样派发);
- **Ctrl+B → 打开回溯关口**(会重推一批子任务);
- **Ctrl+M → 打开合并关口**(kitty 键盘协议无条件开启,`ink.tsx:418`;iTerm/kitty/
  WezTerm/ghostty/tmux/Windows Terminal 都走这条,而不少人拿 Ctrl+M 当回车)。

既有的 `R`/`s`/`f`/`r`/`q` 同样没守卫(实测 Ctrl+S/Ctrl+F/Ctrl+R/Ctrl+Q 全部触发动作),
**这是本来就在的洞,顺手一起补**。`TaskTreePanel.tsx:454-455` 那段声称「树那一支不需要
这一层」的注释是错的,一并改掉 —— 它现在在教下一个人犯这个错。

**不许写成分支开头的早退**:`key.meta` 对 Escape 恒为真(`input-event.ts` 那条
`meta: … || keypress.name === 'escape'`),`if (!plain) return` 会让 `:533` 的 Esc 当场
变死键。逐条与上。

### A.1 键与作用域

- 树层加 `m`/`c`/`b`,判据 `plain && props.onX !== undefined`;调用照 `:493/:496` 那样
  直接调 + `setDetailId(null)`,**不要走 `actHere`**(签名是 `(n) => string | undefined`,
  而 `onMergeWorktrees` 是 `(n) => void`)。
- `g` 不提上来(实测多 3 项会把 100 列 + runControl 的页数从 3 推到 4)。方案明写
  **「`g` 的可见性由详情页页脚承担」**(`TaskTreePanel.tsx:654` `canRepairNode`),别让它
  变成下一个「从不被宣告的键」。
- **作用域措辞按代码写,不按直觉写**(席位一逐桶核过):
  - 逐节点工作区(`plan.items`)= **光标所在子树**(`mergeSubtree.ts:204-212`);
  - 第 2 跳 集成分支→你的分支(`plan.trunk`)= **全局**(`:450-480`);
  - 抢救分支 / 只剩分支 / 孤儿目录(`plan.rescue`)= **全局**(`:377-429` 吃整份 nodes)。

  落到 run-001:607 个提交和 7 条 salvage **光标停在哪都捞得到**,只有 3 个保留工作区按
  子树走。所以危险不是「用户以为是合并全部」,而是措辞会让他以为按在叶子上只捞一个、
  **于是不按**。结束屏光标默认停在 root(cursor 初值 0),默认按下去本来就是全量 ——
  这条写进方案,作为「不必再加一个『合并全部』键」的理由。

### A.2 页脚

- 措辞:树层 `m 合并/捞回未合入的产出`(**别写「工作区」**,它只覆盖三桶里的一桶);
  详情页保持 `m 合并工作区到主干`。`c 清理工作区` / `b 回溯未通过的子任务` 沿用。
- **`m` 排在 `Esc/q 退出` 紧后面**(次序规矩见 `:936-948`)。实测:这样排之后 80/100/113/160
  × runControl 有无共 8 格,`m` **一律在第 1 页**,而且总页数与原序完全相同。
- **验收判据换掉**:第 1 版写的「出口不会被挤出第一页」是**空判据**(`logView.ts:1219/1250`
  把 head 无条件拼进每一页,永远不会红);「`r` 不被挤出第一页」在 80 列 + runControl 下
  **改动前就已经不成立**。新判据:**8 格里 `m` 都在第 1 页,且总页数 ≤ 6**。

---

## B. 结束屏直接指路

- `efftask.tsx:3309` 那个 `<Text dimColor>` **没有 `wrap="truncate-end"`**,而
  `doneSummaryRows`(`:157-168`)按常数 1 行计它;加字后 72 列以下会回流成两行,把树的
  最后一行静默挤掉 —— 逐字是 `:3280` 为结论行写过的教训。**加 `wrap`,并且 `m` 排在
  `回车看节点详情` / `r 重做选中的任务` 之前**,否则截断先吃掉的正是新加那项。
- 判据(席位一给的,直接用):
  ```ts
  const hasUnmerged = undelivered > 0            // 复用 :3234,别再算一次
    || (props.handoff?.kept.length ?? 0) > 0
    || (props.handoff?.salvage.length ?? 0) > 0
    || (props.handoff?.trunkSkips?.length ?? 0) > 0
  ```
  两条必须写明:**不能只看 `undelivered`**(`undeliveredCommits` 在 `state === 'merged'`
  时恒返回 0,而 kept/salvage 与收口结局无关,run-001 的 3+7 正是这一桶);**这是下界不是
  全集**(`orphanDir`/`branchOnly` 不在 `HandoffSummary` 里),判据为假**只等于「我们没
  看见」**,不许拿它去印「没有遗留」。
- **结论行本身要改口(P1-4,席位三)**:`undeliveredCommits` 只看 commits,于是
  `commits === 0` + 7 条 salvage 时印的是绿色 `✓ 高效任务完成`。改成
  `⚠ 跑完了,但还有 N 处产出没送到(按 m 捞回)`。用户读的是第一行,这条比下面那行命令重要。
- **`handoffLines` 那行限定语要能照做**(P1-5,席位一):它同时被 `exitReportLine`
  (`startupConfirm.ts:1483`)用,而那是 `/et` **退出后写进对话记录**的一行,那时面板已经
  关了,写「按 m」等于给一条按不到的指令。措辞:「`git merge <branch>` 只覆盖集成分支;
  保留工作区与抢救分支要么 `/et --resume <runId>` 后在树上按 m,要么逐条 `git merge <ref>`」
  (`:1613` 已经把 ref 名字全印出来了,逐条那条路是真能执行的)。
- **P2-8**:那行「合并: git merge …」被 `:1586 if (h.commits > 0)` 包着,而 kept/salvage
  行在外面。所以 B 节要落在「**有 kept 或 salvage 就无条件追加一行**」,不是改现有那行。
- **P3-10**:`efftask.tsx:3307` 用行文本当 key,改 index key(这一屏的职责恰恰是列全)。

---

## C. stash 那一档(用户决定:给选项,要按一下)

第 1 版写的两条核心机制**在真 git 上都不成立**(席位二逐条跑过):

- **`git stash pop <sha>` 不存在** —— `error: '95976a4b…' is not a stash reference`,
  `drop <sha>` 同样被拒。写进结果屏让用户照敲的那条命令也是错的。
- **「记下 `refs/stash` 的 sha」在最该管用的场景失效** —— `stash push` 无事可做时退出码
  是 **0**,而 `refs/stash` 这时指向的是**用户自己那条 stash**;闸与按键之间隔着一屏确认
  (分钟级窗口),用户在这期间提交或撤销了改动,按下去就会把他不相干的 stash 应用进工作区
  并从列表里删掉。

**范围先缩小**(席位一):这一档只需要包住**第 2 跳**(`intoTrunk` / `scanTrunk` 那一跳),
不是整趟合并 —— 窗口从「几十次 merge + 派模型解冲突」缩到一次 merge。

**正确序列**(全部真跑验证过):

```bash
# 前置:MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD 任一存在 → 这一档不许出现
#       (冲突态下 stash push 本身就失败:could not write index,EXIT=1,一条都没建)
#       文案换成「你正卡在一次没做完的合并里,先解决或 git merge --abort」

BAK=$(git stash create); [ -n "$BAK" ] || abort      # 干净树时输出空 → 整档取消,如实说
git update-ref refs/et/stash-backup/$RUNID "$BAK"    # 耐久备份:条目被误 drop / gc 也还在

BEFORE=$(git rev-parse --verify --quiet refs/stash)  # 没有 stash 时:空 + EXIT=1,不吐 stderr
git stash push -m "et: 自动 stash($RUNID)"           # 不加 -u
AFTER=$(git rev-parse --verify --quiet refs/stash)
# 判据:AFTER 非空且 != BEFORE。否则 = 我们没存下任何东西,立刻停,绝不 pop。

… 合并 …

git rev-parse --verify --quiet MERGE_HEAD && git merge --abort   # 半合并态下 pop 必失败
N=$(git stash list --format='%H %gd' | awk -v s="$AFTER" '$1==s{print $2; exit}')
# 必须在 pop 的那一刻解析:中途有别的 stash 会让下标漂移。N 为空 → 走备份 ref。
git stash pop "$N"
git update-ref -d refs/et/stash-backup/$RUNID        # 只有 pop 成功才删
```

**失败时屏幕上必须逐字有的东西**(席位二给的四条,照抄进实现):push 判据不成立 /
合并失败已还原 / pop 撞冲突(说清工作区现在有冲突标记、再 pop 一次会失败、两处都还在)/
未跟踪重名挡住。

**不要复用 `src/utils/git.ts:429` 的 `stashToCleanState`** —— 它先 `git add <untracked>`
再 stash,等于把用户的未跟踪文件塞进索引带走,比 `-u` 还糟。

**配套(P1-8)**:`handoffActions.ts` 自动解冲突成功那一支的 followUp 是
`想撤销这次合并:git reset --hard <undoAt>`;这一档启用后照做会把刚 pop 回来的未提交改动
全部抹掉。必须补上警告或换成 `git reset --merge`。

**探针八格**(不是四格):干净 / 脏 / 已有别的 stash / pop 撞冲突 / 冲突态下 push /
半合并态下 pop / 未跟踪重名 / **按键前树变干净的竞态**。

---

## D. 明确不做

- 不做「检测到脏就自动 stash」的全自动档(用户已否决)。
- 不动 `-u`(`/et` 自己往用户检出里写 `.claude/efftask/`)。

---

## 附:只含 ignored 内容的保留工作区(P2,席位三)

`m` 用 `status --porcelain`(`mergeSubtree.ts:260/338`),`handoff().kept` 用
`--ignored`(`worktreePool.ts:1195`)。于是「只剩 build/ 的保留工作区」会被结束屏印成
「未回收」,而按 `m` 得到一屏「没有需要合并的工作区」—— 那句 ⚠ 又被
`items.some(loose>0)` 门控住(`:842`),一个字都不印。改法:⚠ 的门控改成「扫描期间见过
任何被忽略内容」,并对 `alreadyMerged` 的节点补一次 `--ignored`,明说「这个目录只剩构建
产物,`m` 合不了,要腾空间按 `c`」。

## 落地顺序

E → F → G → A → B → C → 附。每步真跑 + 变异复验;完了拉多角色验收(验收席必须真按键、
真跑 git)。
