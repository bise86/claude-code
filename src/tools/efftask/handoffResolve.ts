// src/tools/efftask/handoffResolve.ts
//
// 收口那一次合并撞上冲突时,**派谁去解**。
//
// 节点合并进集成分支的冲突走的是 pipeline 里的 §8 那条路(在节点自己的隔离工作区里解、
// 解完重跑验收、每次运行两次机会)。这里是另一条:集成分支合回**用户自己的分支**,发生在
// 所有节点都已验收通过之后,现场在用户的检出里。
//
// 两条路刻意不共用实现,因为环境不一样:
//  - 那边有节点、有角色名册、有实时窗口,解完之后还有一整席验收在等着复核;
//  - 这边只有一个目录和一条分支名。**复核由 git 做**,不由模型自称 —— 见
//    `autoResolveMerge`:未合并路径、暂存区里的冲突标记、commit 是否成功,一条不过就
//    `git merge --abort` 还原。
//
// 所以这个文件只负责一件事:把「有冲突要解」翻译成一次带写工具的模型调用。
import type { ConflictResolver } from './handoffActions.js'
import type { RescueTriage } from './rescue.js'
import type { RunAgentFn } from './roundtable.js'
import type { TaskNode } from './types.js'

/**
 * `RunAgentFn` 要一个节点,而收口时并没有「哪个节点」这回事 —— 合的是整条集成分支。
 *
 * 传根节点:它是这次运行的目标本身,提示词里的目标/方案就是用户最初要的那件事,这恰好
 * 是解冲突时最该知道的上下文。拿不到根节点(理论上不会,run 一定有 root)就不接线,
 * 让收口退回「留下冲突现场」的老行为 —— 宁可不自动,也不拿一个假节点去凑。
 */
export function makeHandoffConflictResolver(deps: {
  runAgent: RunAgentFn
  node: TaskNode
  signal: AbortSignal
}): ConflictResolver {
  return async ({ files, branch, cwd, note }) => {
    await deps.runAgent({
      // execute —— 这一趟要真的改文件,工具档由 phase 决定(见 makeRunAgentFn)。
      phase: 'execute',
      node: deps.node,
      // 不挂角色:收口不属于任何一个环节的席位,挂上去会让日志里出现一个从没被派过的员工。
      role: null,
      system: 'execute',
      prompt:
        `把分支 ${JSON.stringify(branch)} 合并进你所在的这个工作目录时产生了冲突。\n` +
        `当前目录里就是冲突现场(带 <<<<<<< / >>>>>>> 标记)。\n` +
        /**
         * **`note` 是调用方知道、而你无从得知的那个事实。**
         *
         * 捞回一条**被后来的版本取代**的抢救分支时,一个不知情的解决者会尽力
         * 「保留双方的意图」,于是把废稿的内容留了下来,盖在已经修好的代码上 ——
         * 真 git 上验过这个形状。所以它必须排在「保留双方意图」那句**之前**:
         * 后一句是通则,而 `note` 是这一次的例外,顺序反了通则会盖住例外。
         */
        (note ? `${note}\n` : '') +
        `请解决冲突,保留双方的意图,不要简单丢弃任何一边(除非上面有别的交代)。\n` +
        // 不许提交:提交由 autoResolveMerge 在**复核之后**做。模型自己 commit 的话,
        // 那道复核就永远晚了一步 —— 它要检查的东西已经进历史了。
        `解决后 git add 冲突文件即可,**不要 commit**,也不要 git merge --abort。\n` +
        `冲突文件:\n${files.map(f => '- ' + JSON.stringify(f)).join('\n')}\n` +
        /**
         * **不许说「这里是用户自己的工作目录」。**
         *
         * 这个解决者现在有两个落脚点:收口那条路跑在用户的检出里,而捞回/合回主干那两条
         * 跑在临时合并工作树 `merge-scratch` 里(模型调用一秒都不能待在 mergeLock 里,
         * 见 integrationMerge.ts)。写死其中一种,另一种上就是一句精确的假话 ——
         * 而它正好是最容易让模型「顺手清理一下」的那一句。
         */
        `只动与本次冲突相关的文件,不要动别的。`,
      cwd,
      signal: deps.signal,
    })
  }
}

/**
 * **分诊:一条孤立的 ref 该不该合进集成分支。**
 *
 * 用户原话:「用主模型辅助,在触发回溯时。」模型在这里**只圈范围,不下判决** ——
 * 它拿到的是证据(这条 ref 相对集成分支多了几个提交、动了哪些文件、对应任务后来怎么样了),
 * 输出的是三选一。判据与后果见 `rescue.ts` 的文件头。
 *
 * **解析失败一律回空数组**,而这在下游是安全方向:`planRescue` 把「模型没提到的」
 * 一律当「拿不准」,于是一次答坏了的分诊等于什么都不合 —— 不合只是没捞到,
 * 合错了是把废稿盖到已经修好的代码上。
 */
export function makeRescueTriage(deps: {
  runAgent: RunAgentFn
  node: TaskNode
  signal: AbortSignal
}): RescueTriage {
  return async evidence => {
    if (evidence.length === 0) return []
    const list = evidence.map((e, i) =>
      `${i + 1}. ref: ${JSON.stringify(e.ref)}\n` +
      `   任务: ${e.title ?? e.nodeId ?? '(已经不在树上了)'}\n` +
      `   相对集成分支多出 ${e.commits} 个提交,动了 ${e.fileCount} 个文件` +
      (e.files.length > 0 ? `:${e.files.slice(0, 10).join('、')}${e.fileCount > e.files.length ? '…' : ''}` : '') +
      `\n   这个任务后来:${e.fate === 'superseded' ? '被重做过 / 已经通过验收并合入了别的版本' : e.fate === 'unknown' ? '不清楚(它已经不在任务树上)' : '还没有别的版本合入'}`,
    ).join('\n')
    const out = await deps.runAgent({
      /**
       * `phase: 'plan'` —— 这是一次**只读的判断**,不该拿到写工具档。
       * 它要做的全部事情是读 git 历史然后给结论;给它写工具,一个「顺手帮你合一下」的
       * 模型就能绕开下面那整套 git 复核。
       */
      phase: 'plan',
      node: deps.node,
      role: null,
      system: 'plan',
      prompt:
        `本次运行里有几处**孤立的产出**:它们躺在自己的分支上,从来没有合进集成分支 ` +
        `${JSON.stringify('(下称集成分支)')}。请逐条判断该不该把它合回去。\n\n` +
        `${list}\n\n` +
        `判据:\n` +
        `- 这条 ref 里有集成分支**确实缺失**的产出 → merge\n` +
        `- 它已经被后来的版本取代(任务重做过、或者别的版本已经合入),合回去只会把旧实现` +
        `盖到新的上面 → skip\n` +
        `- 看不出来 → unsure。**拿不准就写 unsure,不要猜** —— 不合只是暂时没捞到,` +
        `合错了会把废稿盖到已经修好的代码上。\n\n` +
        `你可以用 git 命令去看(例如 git log / git diff 集成分支...<ref>)。\n` +
        `最后只输出一个 JSON 数组,放在 \`\`\`json 代码块里,每项:\n` +
        `{"ref":"...","verdict":"merge|skip|unsure","why":"一句话理由"}`,
      signal: deps.signal,
    })
    return parseTriage(out, new Set(evidence.map(e => e.ref)))
  }
}

/**
 * 从模型回复里抽出分诊结果。**任何看不懂的东西都当作没说** ——
 * 下游把「没说」一律算「拿不准」,所以这个方向是安全的。
 */
export function parseTriage(
  raw: string, known: ReadonlySet<string>,
): { ref: string; verdict: 'merge' | 'skip' | 'unsure'; why: string }[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  const blocks: string[] = []
  for (let m = fence.exec(raw); m !== null; m = fence.exec(raw)) if (m[1]) blocks.push(m[1])
  // 没有围栏就拿整段试一次 —— 但**不做任何宽松修补**。
  if (blocks.length === 0) blocks.push(raw)
  for (const b of blocks.reverse()) {
    try {
      const parsed: unknown = JSON.parse(b.trim())
      if (!Array.isArray(parsed)) continue
      const out: { ref: string; verdict: 'merge' | 'skip' | 'unsure'; why: string }[] = []
      for (const row of parsed) {
        if (typeof row !== 'object' || row === null) continue
        const r = row as { ref?: unknown; verdict?: unknown; why?: unknown }
        /**
         * **ref 必须是我们问过的那几条之一。**
         *
         * 白名单不是黑名单:模型编出来的 ref 会被原样送去 `git merge`,而那是一次
         * 会往集成分支上产生真实提交的动作(`nodeRepair` 的 REPAIRABLE_FIELDS 同一条规矩)。
         */
        if (typeof r.ref !== 'string' || !known.has(r.ref)) continue
        if (r.verdict !== 'merge' && r.verdict !== 'skip' && r.verdict !== 'unsure') continue
        out.push({ ref: r.ref, verdict: r.verdict, why: typeof r.why === 'string' ? r.why : '(模型没给理由)' })
      }
      if (out.length > 0) return out
    } catch { /* 下一个围栏 */ }
  }
  return []
}
