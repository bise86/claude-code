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
   * Whether an automatic resolution was attempted IN THIS RUN.
   *
   * Not derivable from the node: `iteration.mergeResolve` is persisted, so a resumed node
   * whose one attempt was spent in an earlier session carries `mergeResolve === 1` while
   * making no attempt at all. A card claiming 已自动尝试解决一次 there would be describing a
   * previous session — or, after an interrupt, an attempt that never finished.
   */
  attempted: boolean
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
    e.attempted
      ? '该节点已自动尝试解决一次未成功,现已暂停等待人工。'
      : '该节点的自动解决机会已在此前用完,本次未再尝试,现已暂停等待人工。',
    // The conflict is LEFT IN PLACE in that worktree (markers and MERGE_HEAD), which is the
    // only reason this instruction is actionable. An earlier version pointed here while the
    // conflict lived — and was then reset away — in the SHARED integration worktree, so a user
    // who followed it found a clean directory with nothing in it to fix.
    `处理方式: cd 到上面的工作区,那里就是冲突现场(带 <<<<<<< 标记),解决后 git add 并 git commit;` +
      `然后用 /et --resume ${runId ?? '<运行 ID>'} 继续,恢复后会重跑验收再合并。`,
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
