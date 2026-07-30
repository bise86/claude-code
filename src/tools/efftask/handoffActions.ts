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
    const res = await git(['merge', '--no-edit', h.branch], cwd)
    if (res.code !== 0) {
      // **如实报告失败**。这里显示「已合并」是这个功能最不能出的错 —— 用户会据此
      // 去做下一步,而代码根本不在他的分支上。
      //
      // 而且要说清**工作区现在是什么状态**:内容冲突时 git 不回滚,冲突标记留在文件里、
      // `MERGE_HEAD` 还在。此前这一路只说「分支原样保留,没有任何东西丢失」+
      // 「冲突需要你手工解决: git merge <branch>」—— 第一句漏掉了工作区,第二句照做会
      // 得到 `error: Merging is not possible because you have unmerged files.`。
      const conflicted = await mergeLeftovers(git, cwd)
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
