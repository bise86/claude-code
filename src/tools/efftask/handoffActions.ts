// src/tools/efftask/handoffActions.ts
//
// 收口的四个动作(spec §8)。此前这里只有「打印三条要用户自己敲的命令」。
//
// 为什么不转交给 superpowers 的 finishing-a-development-branch:两次验收实测证明它会在
// **用户的 checkout** 里跑测试,而那里一行 run 的产出都没有,于是它会自信地报「测试通过」;
// 它的 worktree 归属判断也认不出 `.efftask-worktrees/`。把四个动作直接实现,比转交给一个
// 环境模型对不上的 skill 更诚实。
import type { PendingHandoff } from './types.js'

export type HandoffChoice = 'merge' | 'push' | 'keep' | 'discard'

/** 与 worktreePool 里的 git 执行器同形状,注入以便测试。 */
export type GitFn = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>

export interface HandoffResult {
  ok: boolean
  /** 给用户看的一句话。失败时必须说清失败了什么,不能显示「已合并」。 */
  message: string
  /** 后续还需要用户自己做的事(例如冲突要手工解决)。 */
  followUps?: string[]
}

/**
 * 派一次模型去解冲突。**在用户自己的检出里**。
 *
 * 注入而不是直接调 runAgent:这个模块是纯的(见文件头),而 `RunAgentFn` 要节点、要角色、
 * 要窗口 —— 那些东西住在命令层。这里只声明「有人能去解」,谁去、带什么工具由接线方决定。
 *
 * 返回值**不是判据**。模型说自己解完了不算数,`autoResolveMerge` 一律拿 git 复核:
 * 还有未合并路径、暂存区里还留着冲突标记、commit 不成 —— 任何一条都算没解成,然后
 * `git merge --abort` 把用户的工作区还原。这是「宁可重做,不可谎报」在这条路上的样子。
 */
export type ConflictResolver = (info: {
  files: string[]
  /** 合进来的那条分支(集成分支)。不给的话模型不知道自己在解谁和谁的冲突。 */
  branch: string
  cwd: string
  /**
   * **这次合并的另一半是什么来历。**
   *
   * 可选,而且只有捞回孤立产出那条路会给。理由是那条路上有一种输入会让「按常理解冲突」
   * 得到反向的结果:`discard` 抢救下来的分支里有一类是**被验收否决过的产出**,而对应的
   * 任务后来重做出了正确版本。两边在同一个文件上都有内容 → add/add 冲突 → 一个不知情的
   * 解决者会尽力「保留双方的意图」,于是把废稿的内容留了下来,盖在已经修好的代码上。
   * 真 git 上验过这个形状。
   *
   * 所以「哪一半可信」不能让模型猜,它是调用方**知道**而模型无从得知的事实。
   */
  note?: string
}) => Promise<void>

/** 暂存区里还留着冲突标记的文件。空 = 干净。 */
async function stagedMarkers(git: GitFn, cwd: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return []
  const diff = await git(['diff', '--cached', '-U0', '--', ...files], cwd)
  if (diff.code !== 0) return []
  const out: string[] = []
  let current = ''
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ b/')) { current = line.slice('+++ b/'.length).trim(); continue }
    // 只认带尾随空格的 `<<<<<<< ` / `>>>>>>> `,**不认光杆 `=======`**:后者是 Markdown 的
    // setext 下划线,一个讲合并冲突的文档、一条分隔线都会命中,而那会让一份好的解决被
    // 判定成没解干净、然后被 abort 掉 —— 代价比漏判大得多。真的残留三种标记都会在。
    if (current && /^\+(<{7} |>{7} )/.test(line) && !out.includes(current)) out.push(current)
  }
  return out
}

/**
 * 冲突 → 派模型解 → **用 git 复核** → 提交;任何一步不成就 `git merge --abort` 还原。
 *
 * 导出是为了能单独测:这条路会在用户自己的检出里写文件并产生一个真的 merge commit,
 * 而它是**自动**发生的 —— 判据必须是可以逐条钉住的,不能埋在一个只能端到端跑的分支里。
 */
export async function autoResolveMerge(deps: {
  git: GitFn
  cwd: string
  branch: string
  files: string[]
  resolve: ConflictResolver
  /** 「另一半是什么来历」——原样交给解决者,见 `ConflictResolver.note`。 */
  note?: string
}): Promise<{ ok: true } | { ok: false; why: string; restored: boolean }> {
  const { git, cwd, branch, files, resolve, note } = deps
  const fail = async (why: string): Promise<{ ok: false; why: string; restored: boolean }> => {
    // 还原到合并前。git 在内容冲突时不回滚,不 abort 的话用户的工作区就停在半合并状态 ——
    // 而他没按过任何键,屏幕上一句「你的工作区未被改动」当场变成假话。
    /**
     * **判据看现场,不看 abort 的退出码。**
     *
     * 没有合并可中止时 `git merge --abort` 回 128 而树是干净的 —— 按退出码判会报一句
     * 假的「自动还原失败」。而这个值有真实后果:`rescue.runRescue` 拿它决定要不要
     * **break 掉整批捞回**,一次假的「还原失败」会让剩下的孤立产出一条都捞不了,
     * 直接顶掉「必须保证全部捞回」。
     */
    await git(['merge', '--abort'], cwd)
    const still = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)
    const left = await mergeLeftovers(git, cwd)
    return { ok: false, why, restored: still.code !== 0 && left.length === 0 }
  }
  try {
    // `note` 只在给了的时候才带上 —— 老调用方一个字都不变。
    await resolve({ files, branch, cwd, ...(note ? { note } : {}) })
  } catch (e) {
    return fail(`自动解决调用失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  // 模型被要求 git add,但**不能假设它做了**。只 add 冲突的那几个文件:`add -A` 会把用户
  // 检出里本来就有的未跟踪文件一起卷进这次合并提交。
  //
  // 真 git 实测过一件要紧的事:这一句 add **本身就会消掉未合并状态** —— 模型一个字节都没改
  // 时,带着 <<<<<<< 的文件照样被暂存,`git status` 从此干净。所以下面那道「未合并路径」
  // 的检查抓不住「什么都没干」,真正抓住它的是**冲突标记**那一道。两道都要留。
  const add = await git(['add', '--', ...files], cwd)
  if (add.code !== 0) return fail(`git add 失败: ${oneLine(add.stderr) || '未知原因'}`)
  const left = await mergeLeftovers(git, cwd)
  if (left.length > 0) return fail(`仍有未解决的冲突文件:${left.slice(0, 5).join('、')}`)
  const markers = await stagedMarkers(git, cwd, files)
  if (markers.length > 0) return fail(`解决结果里还留着冲突标记:${markers.slice(0, 5).join('、')}`)
  /**
   * **`--no-verify`。** 这是全仓最后一处漏掉它的 commit,而现在它的处境最糟:
   * 迭代解冲突每一轮都调这里,跑在**我们自己的** `merge-scratch` 里、用的却是**用户的**
   * 钩子(`core.hooksPath` 在共享 config 里)。一个失败的 pre-commit 会把
   * `caps.trunkResolveRounds` 轮全部烧完,最后报「提交失败」—— 而重试永远不会收敛。
   * `commitAndMerge` / `acquire` / `refreshFromIntegration` 早就为同一个理由带着它。
   */
  const commit = await git(['commit', '--no-edit', '--no-verify'], cwd)
  if (commit.code !== 0) return fail(`提交失败: ${oneLine(commit.stderr || commit.stdout) || '未知原因'}`)
  return { ok: true }
}

const oneLine = (s: string): string => s.trim().split('\n').filter(Boolean).slice(0, 3).join('; ')

/**
 * 合并前的「树干净吗」。**只看被跟踪的改动**,不看未跟踪文件。
 *
 * 这条判据原来是 `git status --porcelain` 非空,而那个命令**把未跟踪文件也算进去**。
 * 实测出来的后果是这个功能在正常仓库里一次也不会发生:`/et` 自己就在用户的检出里写
 * `.claude/efftask/<runId>/`(run 目录),`.efftask-worktrees/` 有 `.git/info/exclude` 兜着,
 * 而 run 目录**没有** —— 于是每一趟运行结束时 `status` 里都躺着一条 `?? .claude/`,
 * 自动合并永远被自己挡住。而给出的补救照做也没用:`git stash` 对未跟踪目录回答
 * 「No local changes to save」。
 *
 * 换成 `git diff --quiet`(工作区)+ `git diff --cached --quiet`(暂存区)之后,判据说的
 * 正是「用户有没有会被合并搅进去的改动」。未跟踪文件真的会被覆盖时 **git 自己会拒绝**
 * 并且**不动工作树**(实测:`error: The following untracked working tree files would be
 * overwritten by merge`,文件原样在原处),那条路比我们自己猜更准。
 *
 * 探不出来(git 报错)时按**脏**算:状态未知的检出里跑 merge 是最坏的选择。
 */
export async function trackedChanges(
  git: GitFn, cwd: string,
): Promise<{ dirty: boolean; detail?: string }> {
  const worktree = await git(['diff', '--quiet'], cwd)
  const staged = await git(['diff', '--cached', '--quiet'], cwd)
  // `git diff --quiet` 的约定:0 = 没差异,1 = 有差异,>1 = 命令自己出错。
  if (worktree.code > 1 || staged.code > 1) {
    return { dirty: true, detail: `git diff 失败: ${oneLine(worktree.stderr || staged.stderr) || '未知原因'}` }
  }
  if (worktree.code === 0 && staged.code === 0) return { dirty: false }
  // 有改动才去问一次「改了哪些」—— 只为了把话说清楚,用的是 `-uno`(同样不看未跟踪)。
  const st = await git(['status', '--porcelain', '-uno'], cwd)
  return { dirty: true, detail: st.code === 0 ? oneLine(st.stdout) || undefined : undefined }
}

/**
 * 一次失败的 merge 之后,工作区**被留在半合并状态**了吗。
 *
 * git 在内容冲突时不回滚:冲突标记留在文件里,`MERGE_HEAD` 还在。而这一路是**自动**
 * 发生的(用户没按任何键),所以屏幕上那句「你的工作区未被改动」会当场变成假话,
 * 而「冲突需要你手工解决: git merge <branch>」照做会得到
 * `error: Merging is not possible because you have unmerged files.`。
 *
 * 判据用 `git status --porcelain` 的**冲突码**(UU/AA/DU/UD/AU/UA/DD),而不是去 stat
 * `.git/MERGE_HEAD`:后者在 linked worktree 里不在同一个路径上(`.git` 是文件)。
 */
export async function mergeLeftovers(git: GitFn, cwd: string): Promise<string[]> {
  const st = await git(['status', '--porcelain'], cwd)
  if (st.code !== 0) return []
  return st.stdout.split('\n')
    .filter(l => /^(UU|AA|DU|UD|AU|UA|DD) /.test(l))
    .map(l => l.slice(3).trim())
    .filter(Boolean)
}

/**
 * 选项标签**必须等于行为**。
 *
 * 「推送分支」不叫「建 PR」,因为它只跑 `git push` —— 叫成建 PR 就是承诺一件不会发生的事,
 * 除非真去跑 `gh pr create` 并处理 gh 不存在的情况。
 */
export function choiceLabels(h: PendingHandoff): { key: HandoffChoice; label: string; hint: string }[] {
  return [
    { key: 'merge', label: '合并回当前分支', hint: `git merge ${h.branch}(在你的工作区执行)` },
    { key: 'push', label: '推送分支', hint: `git push -u origin ${h.branch}` },
    { key: 'keep', label: '保留分支', hint: '什么都不做,分支和工作区都留着' },
    { key: 'discard', label: '丢弃', hint: '删除集成分支与集成工作区(需二次确认)' },
  ]
}

/**
 * 「丢弃」到底会删什么、**不会**删什么。
 *
 * 用 pendingHandoff 里记下的精确内容,而不是事后重新推导 —— 二次确认的文案如果列不全,
 * 用户就是在对一件他没看全的事按下确认。这是四个动作里唯一不可逆的一个。
 */
export function discardConfirmLines(h: PendingHandoff): string[] {
  const out = [
    `将删除集成分支 ${h.branch}(${h.commits} 个提交)`,
  ]
  if (h.integrationPath) out.push(`将删除集成工作区 ${h.integrationPath}`)
  const keeps: string[] = []
  if (h.salvage.length > 0) keeps.push(`抢救分支 ${h.salvage.join('、')}`)
  if (h.kept.length > 0) keeps.push(`${h.kept.length} 个未回收的节点工作区`)
  keeps.push('run 目录(.claude/efftask/ 下的记录)')
  out.push(`**不会**删除:${keeps.join('、')}`)
  return out
}

export async function runHandoffChoice(
  choice: HandoffChoice,
  h: PendingHandoff,
  git: GitFn,
  cwd: string,
  /**
   * 给了就先让模型试着解冲突,不给就是原来的行为(留下冲突现场让用户自己解)。
   *
   * 可选而不是必需:这个函数被四个动作共用,而 `push`/`keep`/`discard` 与它无关;测试也
   * 大多不需要它。真正的接线在 runOrchestrator(自动收口)和 efftask.tsx(收口关口)。
   */
  resolve?: ConflictResolver,
): Promise<HandoffResult> {
  if (choice === 'keep') {
    return { ok: true, message: `已保留分支 ${h.branch}` }
  }

  if (choice === 'merge') {
    // 脏树先挡住:git 会拒绝合并,但报错文字是英文的 git 内部消息,而且用户会以为是 bug。
    // **只看被跟踪的改动** —— 未跟踪文件不该挡住合并,见 trackedChanges 那一段。
    const dirty = await trackedChanges(git, cwd)
    if (dirty.dirty) {
      return {
        ok: false,
        message: `合并未执行:你的工作区还有未提交的改动`,
        followUps: [`先提交或 stash,再重新收口`, ...(dirty.detail ? [`改动:${dirty.detail}`] : [])],
      }
    }
    // 合并前的 HEAD —— 只用来在自动解决成功后给出一条**可以照做的**撤销命令。拿不到就
    // 不承诺(下面那句 followUp 是有条件的):给一条错的 reset 目标比不给危险得多。
    const before = await git(['rev-parse', 'HEAD'], cwd)
    const undoAt = before.code === 0 ? before.stdout.trim() : ''
    const res = await git(['merge', '--no-edit', h.branch], cwd)
    if (res.code !== 0) {
      /**
       * 冲突 → 先让模型解一次(spec §8 的立场在收口这一段同样适用:能自动解决的不该叫醒人)。
       *
       * 解成了就是一次真的 merge commit;解不成 `autoResolveMerge` 会 `git merge --abort`
       * 还原,然后照原来的路如实报告 —— 用户拿到的信息只多不少。
       */
      const toResolve = await mergeLeftovers(git, cwd)
      if (resolve && toResolve.length > 0) {
        const auto = await autoResolveMerge({ git, cwd, branch: h.branch, files: toResolve, resolve })
        if (auto.ok) {
          return {
            ok: true,
            message: `已合并 ${h.branch}(${h.commits} 个提交)到当前分支 —— 有 ${toResolve.length} 个文件冲突,已自动解决`,
            followUps: [
              `自动解决的冲突文件:${toResolve.slice(0, 5).join('、')}${toResolve.length > 5 ? ` 等 ${toResolve.length} 个` : ''}`,
              // 这一条不是客套:自动解冲突挑的是「每个 hunk 留哪一边」,而这次没有任何人复核过。
              '解决结果没有经过评审,建议 git show 过一眼',
              ...(undoAt ? [`想撤销这次合并:git reset --hard ${undoAt}`] : []),
            ],
          }
        }
        // 没解成 —— 把「试过了、为什么没成、工作区现在在哪」一起交出去,而不是退回一句
        // 泛泛的「合并失败」。下面那段照旧跑,这里只补一条前情。
        const restored = auto.restored
        return {
          ok: false,
          message: `合并失败:冲突自动解决未成功(${auto.why})`,
          followUps: restored
            ? [
              `你的工作区已还原到合并前,分支 ${h.branch} 原样保留`,
              `想自己来:git merge ${h.branch},解完冲突后 git commit`,
            ]
            : [
              `分支 ${h.branch} 原样保留,但**你的工作区里留着一次未完成的合并**(自动还原也失败了)`,
              `冲突文件:${toResolve.slice(0, 5).join('、')}${toResolve.length > 5 ? ` 等 ${toResolve.length} 个` : ''}`,
              `解完冲突后 git commit;不想要这次合并就 git merge --abort 回到合并前`,
            ],
        }
      }
      // **如实报告失败**。这里显示「已合并」是这个功能最不能出的错 —— 用户会据此
      // 去做下一步,而代码根本不在他的分支上。
      //
      // 而且要说清**工作区现在是什么状态**:内容冲突时 git 不回滚,冲突标记留在文件里、
      // `MERGE_HEAD` 还在。此前这一路只说「分支原样保留,没有任何东西丢失」+
      // 「冲突需要你手工解决: git merge <branch>」—— 第一句漏掉了工作区,第二句照做会
      // 得到 `error: Merging is not possible because you have unmerged files.`。
      // 上面那次测量,不再问一遍:两次 `git status` 之间隔着一次可能失败的自动解决,
      // 而两个答案里不管哪个更旧,写进屏幕的都是它。
      const conflicted = toResolve
      return {
        ok: false,
        message: `合并失败:${oneLine(res.stderr || res.stdout) || '未知原因'}`,
        followUps: conflicted.length > 0
          ? [
            `分支 ${h.branch} 原样保留,但**你的工作区里留着一次未完成的合并**`,
            `冲突文件:${conflicted.slice(0, 5).join('、')}${conflicted.length > 5 ? ` 等 ${conflicted.length} 个` : ''}`,
            `解完冲突后 git commit;不想要这次合并就 git merge --abort 回到合并前`,
          ]
          : [
            `分支 ${h.branch} 原样保留,没有任何东西丢失`,
            `可以自己来:git merge ${h.branch}`,
          ],
      }
    }
    return { ok: true, message: `已合并 ${h.branch}(${h.commits} 个提交)到当前分支` }
  }

  if (choice === 'push') {
    const res = await git(['push', '-u', 'origin', h.branch], cwd)
    if (res.code !== 0) {
      return {
        ok: false,
        message: `推送失败:${oneLine(res.stderr || res.stdout) || '未知原因'}`,
        followUps: [`分支 ${h.branch} 仍在本地,没有任何东西丢失`],
      }
    }
    return { ok: true, message: `已推送 ${h.branch} 到 origin` }
  }

  // discard —— 唯一不可逆的一个。工作区必须先删:一条被 worktree 占着的分支删不掉,
  // git 会直接拒绝(cannot delete branch … used by worktree at …)。
  const failures: string[] = []
  if (h.integrationPath) {
    const rm = await git(['worktree', 'remove', '--force', h.integrationPath], cwd)
    if (rm.code !== 0) failures.push(`删除集成工作区失败:${oneLine(rm.stderr || rm.stdout)}`)
  }
  const del = await git(['branch', '-D', h.branch], cwd)
  if (del.code !== 0) {
    failures.push(`删除分支失败:${oneLine(del.stderr || del.stdout)}`)
  }
  if (failures.length > 0) {
    return {
      ok: false,
      message: `丢弃未完成`,
      // 说清**还剩什么**,否则用户以为已经删干净了。
      followUps: [...failures, `分支 ${h.branch} 可能仍然存在,请自行确认`],
    }
  }
  return { ok: true, message: `已删除集成分支 ${h.branch} 与集成工作区` }
}
