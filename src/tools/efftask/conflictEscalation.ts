// 升级人工 (spec §8): the node's execute role already had its one attempt at resolving the
// merge conflict and failed. What is left is a human decision, so the card's job is to carry
// every fact needed to act — WITHOUT the user first having to find the run.
//
// Pure on purpose: the send path rides the SHARED FeishuClient owned by useFeishuBridge
// (never `new FeishuClient`, never connect/close/onCardAction — see feishuStartupCard.ts),
// and that surface is untestable by repo convention. Keeping the card CONTENT pure means the
// part that can be wrong — what the user is told — is the part under test.
import type { TaskNode } from './types.js'

export type ConflictEscalation = {
  node: TaskNode
  branch: string
  path: string
  files: string[]
  /**
   * How many automatic resolutions were attempted IN THIS RUN.
   *
   * Not derivable from the node: `iteration.mergeResolve` is a persisted CUMULATIVE record, so
   * a resumed node carries the attempts of every earlier session too. A card counting those
   * would be describing a previous session — or, after an interrupt, an attempt that never
   * finished. It is a number rather than a boolean because the budget is no longer one:
   * 「已自动尝试解决一次」was a fixed sentence that went false the moment a second attempt
   * became possible, and the count is exactly what tells the user whether the model gave up
   * after one bad call or after two reviewed tries.
   */
  attempts: number
  /**
   * MEASURED state of that worktree at escalation time — not assumed.
   *
   * The card's whole value is that the user can act on it without investigating first, so a
   * wrong description costs more than no description. Three states reach here and each needs
   * a different instruction; a single sentence about <<<<<<< markers was false in two of them.
   */
  state: { markers: boolean; staged: boolean; stale?: boolean }
  /** The other side of the merge. Without it the user cannot reproduce the conflict at all. */
  integrationBranch?: string
  /**
   * 停下来的原因是**链路**,不是内容:连续几次自动解决的调用根本没打通。
   *
   * 只有这一种情形才带这个字段。它换掉的是「已自动尝试解决 N 次仍未成功」那一句 ——
   * 那句话把人往代码里带,而这条路上那份冲突可能一次都还没被真正尝试过(实测:一个网关
   * 400 让 6 次预算一次都没用上)。处置也不同:去看模型/网关/额度,不是去看解决方案。
   */
  infra?: { streak: number; reason: string }
}

/**
 * The instructions a human needs, in the order they will do them.
 *
 * Deliberately concrete: a card that says "合并冲突,请处理" makes the user hunt for the
 * worktree, guess the branch, and re-derive the resume command. Every one of those is
 * knowledge this process already has.
 */
export function escalationLines(e: ConflictEscalation, runId?: string): string[] {
  return [
    `节点: ${e.node.title}（${e.node.id}）`,
    `分支: ${e.branch}`,
    `工作区: ${e.path}`,
    // The file list is what turns "there is a conflict" into "open these".
    e.files.length > 0 ? `冲突文件: ${e.files.join('、')}` : '冲突文件: (未能读出文件列表)',
    e.infra
      ? `该节点本次自动尝试解决 ${e.attempts} 次,其中最后 ${e.infra.streak} 次**调用根本没打通**` +
        `(${e.infra.reason})—— 不是解决方案被否决,那份冲突可能一次都还没被真正尝试过。` +
        '先确认员工模型/网关/额度可用,再恢复。'
      : e.attempts > 0
        ? `该节点本次已自动尝试解决 ${e.attempts} 次仍未成功,现已暂停等待人工。`
        : '本次运行没有再尝试自动解决(该节点在本次运行里的额度已用完),现已暂停等待人工。',
    // Written from the measurement. `staged` in particular must not say "git add 并 commit":
    // what is staged there is the resolution acceptance JUST REJECTED, so that instruction
    // would have the user commit verbatim the code the reviewers refused.
    e.state.stale
      ? '处理方式: cd 到上面的工作区。冲突标记(<<<<<<< / >>>>>>>)已经被提交进这个分支的文件里 —— ' +
        '请清理掉残留标记并提交。注意直接 git merge 会回答 Already up to date,合并本身已经做过了。'
      : e.state.staged
        // Says only what is MEASURABLE. The earlier wording hard-coded 自动解决…验收未通过, but
        // this state is also reached by a human who ran git merge and git add and forgot to
        // commit — for whom every clause was false, including one that contradicted the line
        // directly above it.
        ? '处理方式: cd 到上面的工作区。那里有一个未提交完成的合并(改动已 git add,尚未 commit)。' +
          '请核对内容确实保留了双方意图,再 git commit;若不确定,先看 node.md 的验收记录。'
        : e.state.markers
          ? '处理方式: cd 到上面的工作区,那里就是冲突现场(带 <<<<<<< 标记),解决后 git add 并 git commit。'
          : '处理方式: cd 到上面的工作区。那里目前没有冲突现场 —— 请自行把集成分支合并进来' +
            '(git merge <上面的集成分支>),解决冲突后提交。',
    `集成分支: ${e.integrationBranch ?? '(未知)'}`,
    // 自动解决的额度是**按次运行**算的,恢复即回满 —— 这句话必须说出来,否则用户会以为
    // 「机会已经用完了,我不解就没人解」,而实际上他把冲突留在原地再 resume 一次,模型
    // 还会带着这一轮的验收意见再试。
    `恢复: /et --resume ${runId ?? '<运行 ID>'};恢复后会重跑验收再合并,若仍有冲突会重新给两次自动解决。`,
  ]
}

export function buildConflictCard(e: ConflictEscalation, runId?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      // Red, because unlike the startup card this one is not a request — it is a stop.
      template: 'red',
      title: { tag: 'plain_text', content: '高效任务模式 · 合并冲突需人工处理' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: escalationLines(e, runId).map(l => `- ${l}`).join('\n') },
      },
    ],
  }
}
