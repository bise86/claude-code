# 把「捞」从一条路上的特例,变成每一格都一样的通用机制

> 用户 2026-08-14:「继续完成,保证最好的效果,**是通用的**。」
> 上一轮(2026-08-13)落地了三级递降,验收席同时留下一份**没修的清单**。这一轮做那份清单,
> 而且要求换了:不是再打六个补丁,是让同一件事对**每一格**都成立。

## 0. 上一轮验收留下的账(逐条,不改写)

| # | 谁提的 | 事实 |
|---|---|---|
| 漏做 2 | 规范席 | `refs/et/stash-backup/*` 与 `git stash` 条目**不在** `STRANDED_KINDS` 里 —— 那是**用户自己**没提交的东西 |
| 漏做 3 | 数据安全席 | `integrationDirty` 的内容会被后续 `reset --hard` + `clean -fd` 抹掉,而它从来没被快照过 |
| 漏做 4 / 洞 4 | 数据安全席 | 孤儿目录**没有第 3 级**(不落痕);而且目录里有一个被 `.gitignore` 忽略的文件时,`git add` 整批失败,那一格 0 捞回 |
| 洞 7 | 数据安全席 | **全有或全无**:一条路径被判据挡下,同一条 ref 上无辜的文件跟着一起死;`why` 里写的是受害者的名字,不是肇事者 |
| 曲解 6 | 规范席 | `skip` 不落痕、也没说清它「下次还会不会被重新判」 |
| 低 | 规范席 | 截断没有提示;`noteMerged` 写 `contributed = true` 而屏幕说「不会改动任何判决」;机器写的指引被标成「**用户**补充的」 |

（曲解 7 的一半——`hintedId` 上屏——**已经做了**:`stranded.ts` 把它写进了 `why`。不重复劳动。)

## 1. 这一轮的判据:一件事只写一遍,对每一格都成立

上一轮的形状是「ref 那条路有三级,别的路各有各的半截」。所以同一个缺陷会以不同面目
出现四次(洞 4 和洞 7 就是同一件事在两条路上的两张脸)。这一轮的每一项都必须能回答:
**它对哪几格生效?** 只对一格生效的,不做。

---

## A. 逐条降级:批量是优化,逐条是判据(治 洞 7 + 洞 4)

**今天**:`commitAndFf` 的 `stage()` 回调里,任何一条命令非零就 `return { ok:false }` → 整笔作废。

**实测(git 2.54,真仓库)**:

- `git checkout <ref> -- <批>` 里混一条 ref 上没有的路径 → `error: pathspec … did not match`,
  退出码 1,**一个文件都没落地**(`git status` 空)。批量是原子的 —— 一条坏的杀掉整批。
- `git add -- <批>` 里混一条 `.gitignore` 忽略的路径 → 退出码 1,**而好的那条已经暂存了**
  (`git diff --cached --name-only` → `real.ts`)。git 部分成功,而我们的代码把它整笔回滚。

**做法**:在 `backfill.ts` 里加一个**两条路共用**的

```
stagePaths(paths, run: (batch: string[]) => Promise<GitResult>): Promise<BackfillSkip[]>
```

先整批跑(快);非零就**把这一批拆成逐条重跑**,只有真的失败的那一条进 `skipped`,
理由取 **git 自己的第一行**(不是我们编的一句)。被忽略的那些再补一句
`git check-ignore -q` 的确认,写成「`.gitignore` 说这个仓库不要它」。

判据不变:最后那道 `--diff-filter=DMR`(基准 `tip`)照样跑,逐条降级**只影响谁进得来**,
不影响「不许覆盖」。

> `check-ignore` 的 `-z` **只能配 `--stdin`**(实测 `fatal: -z only makes sense with --stdin`),
> 而 git 接缝是 `(args, cwd)`、**没有 stdin**。所以只用 `-q` 逐条问,不解析它的输出。

**为什么不 `git add -f`**:`.gitignore` 是这个仓库说的「我不要这个」。把构建产物补录进
集成分支不是捞回产出,是另一种污染。它进 `skipped` 并**上屏**,用户自己判。

---

## B. 第 3 级对孤儿目录也生效(治 漏做 4)

**今天**:`runRescue` 里 ref 那条路补录完会 `remainingPathsOf` 重新量,量出差额就落痕;
孤儿目录补录完**什么都不量**,`stranded` 里永远不会有它。

**做法**:补录之后**重跑一次 `orphanDirFindings`**(量出来的,不是打算做的),还剩
`absent` 的就产生一条 `stranded`。它没有 `nodeId` —— 而那条出口早就有了:
`noteRescueStranded` 把认不回主的那些写进 `out.problems` 并点名「这条没人接」。

这里刻意**不**让 `differs` 那一格落痕:两边都有而内容不同,补录按判据一个都不会碰,
它是「只能你自己判」的那一格,把它写成「按 b 会重做出来」是假承诺。

---

## C. 会被抹掉的东西,先钉一个耐久 ref(治 漏做 3)

**今天**:`integrationDirty` 只在屏幕上被念一句。而抹掉它的是 `worktreePool` 合并失败
那条路上的 `reset --hard` + `clean -fd`(`recordCleaned` 只留下**名字**,内容没了)。

**实测**:

- `git stash create` **不动工作区**(`git status` 前后逐字相同),给出一个 commit sha;
- 它在**链接工作树**里照样能用(集成工作区正是一棵链接工作树);
- **`-u` / `--include-untracked` 对 `create` 无效** —— 实测只有 2 个 parent,没有 `^3`,
  未跟踪文件一个都没进去。（这条反直觉,方案里写死它。)
- **冲突态下 `stash create` 失败**(`Cannot save the current index state`,退出码 1)。

**做法**:`m` 的执行阶段(**不是** `scanStranded` —— 那份是只读的)对集成工作区做一次
`stash create`,成功就 `git update-ref refs/et/rescued/<runId>/int-dirty-<sha12>` 钉住,
屏幕给出 `git stash apply <ref>`(实测 `apply` 接 ref 名)。

三件事必须**分开说**,因为它们的结局不同:

1. 已跟踪的改动 → 钉住了,`clean -fd` 拿不走;
2. **未跟踪**的 → `create` 拿不到,下一次合并失败的 `clean -fd` 会删掉它们 —— 点名列出;
3. 冲突态 → `create` 直接失败 —— 照实说,并给出「先把这次合并处理完」。

---

## D. 用户自己 stash 起来的东西,进穷举表(治 漏做 2)

`stashGuard` 的耐久备份 `refs/et/stash-backup/<runId>/*` 在**一种**情况下会留下来:
pop 撞了冲突。那时用户改了一天的东西同时在 stash 条目和这条 ref 上,而
`STRANDED_KINDS`——那份自称「不许漏项」的穷举表——里**没有这一格**。

新增 `stashBackup`,`action: 'report'`,扫 `for-each-ref refs/et/stash-backup/<runId>`,
每条给出 `git stash apply <ref>`。

**绝不自动合。** 这是用户自己的未提交改动,不是这一趟的产出;`action: 'report'` 那一档的
定义就是「该不该动是你的决定」。

---

## E. 新加的 ref 不许被自己的悬空扫描重复列出来

**实测**:`git fsck --unreachable --no-reflogs HEAD <集成分支>` 把 `refs/et/rescued/…`
的 tip **列成了 unreachable** —— 给了显式 head 之后,别的 ref 不再算根。

C 和 D 加进来的 ref 会当场被 `dangling` 那一格重复列一遍。判据加一条:先取
`for-each-ref --format=%(objectname) refs/et` 的 tip 集合,命中的跳过。
**tip 相等就够** —— 快照提交本来就是 ref 的 tip,不需要做可达性遍历。

---

## F. 截断、措辞(低,但都是「屏幕说的和代码做的不一样」)

1. `rescueLines` 孤儿目录 `slice(0, 5)`、`mergeSubtree` 的 `b.skipped.slice(0, 5)` ——
   **截断提示必须在被截断的那一段外面**(memory: `truncation-notice-must-outlive-the-truncation`)。
2. `noteMerged` 会写 `contributed = true`,而确认屏说「不会改动任何判决」——
   改成「不改动任何**验收判决**;只会记下『它的产出已经进了集成分支』」。
3. `handoffResolve` 把机器写的 guidance 标成「**用户**对本任务补充的指引」——
   来源改成中立。
4. `skip` 那一段加一句真话:**下次按 `m` 会重新分诊一遍**(`planRescue` 每次都重跑),
   所以「到此为止」说的是这一趟,不是永远。

---

## 不做的,以及为什么

- **`refs/et/stranded/*` 那种「跨 run 持久化分诊结论」**:无主的 ref 和孤儿目录**本来就是
  持久的**(一个是 ref,一个是盘上的目录),下一趟 `scanStranded` 会重新发现它们。
  再存一份「上次判过什么」只会引入一个会过期的第二真相。
- **`skip` 落痕**:让 `b` 去重做一个**有理由**被排除的废稿是纯破坏。上一轮的判据不变,
  这一轮只把「它是不是永久的」说清楚(F.4)。
- **用 `git add -f` 强行捞 `.gitignore` 的东西**:见 A。

## 验证

每一条判据配一个会红的探针(真 git,不用替身),并逐条做变异测试。重点三条:

- A:批里混一条坏的 → 好的那些**照样进集成分支**,坏的那条带着 git 的原话进 `skipped`;
- B:孤儿目录补录之后仍有 `absent` → 产生 `stranded` 且**没有 nodeId**,走无主出口;
- E:C/D 造出的 ref → `dangling` 那一格**不列**它。
