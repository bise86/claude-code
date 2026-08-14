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
import type { BacktrackTarget } from './backtrack.js'
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
        /**
         * **「两半可能都是对的」要说出来 —— 这不是通则的重复,是一个具体形状。**
         *
         * 用户 2026-08-14 点名:两个任务分别翻译了同一个源文件的**不同区间**,各自落到
         * 同一个路径上,于是整文件 add/add 冲突。手工收口那次实测:
         * `pkg/sql/sem/tree/eval.rs` 一侧是「eval.go 前段」、另一侧是「eval.go 第
         * 3669–6516 行」,各自 100 / 105 个顶层定义 —— **取任一边就丢掉另一半**。
         * 而上面那句「保留双方的意图」在这种形状上是不够的:一个尽责的解决者仍然会去
         * 「融合」两份看起来在写同一件事的代码,而正解是**两段都留着**。
         *
         * 后半句同样是实测出来的:那次并集里有 11 个顶层符号撞名,而两个同名定义放进
         * 同一个文件是编译错误。撞名时**必须停下来说**,不许自己挑一个 —— 「自动挑一个」
         * 正是会悄悄丢掉一半的那种做法,而它在屏幕上和成功长得一模一样。
         */
        `注意一种形状:两边可能是**同一个源文件不同区间**的两份翻译/实现(文件头的注释\n` +
        `常常会写明各自覆盖哪一段)。那时两半都是对的,正解是**并集** —— 两段都留下,\n` +
        `而不是二选一、也不是把它们揉成一份。\n` +
        `如果并集会让两个顶层定义**同名**,不要自己挑一个:优先保留有真实实现的那个、\n` +
        `丢弃自我标注为占位/TODO 的那个;两边都像真的就**停下来**,在回答里说清是哪几个名字。\n` +
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
        `盖到新的上面 → skip。**skip 是终局**:这条 ref 不会被补录、也不会进回溯,` +
        `自动的路从此不再碰它。\n` +
        /**
         * **两个出口的代价不一样,必须说清。**
         *
         * 上一版对 skip 和 unsure 都说「不合只是暂时没捞到」。那句话对 unsure 现在是真的
         * (它会被加法补录,捞不动还会落痕交给回溯),对 skip 是**假的** —— 而模型正是
         * 拿这句话在两者之间做选择,于是系统性地低估了 skip 的代价。
         */
        `- 看不出来 → unsure。**拿不准就写 unsure,不要猜** —— unsure 不会整条合并,` +
        `但它「集成分支上根本没有」的文件会被补录,捞不动还会记在任务上交给回溯;` +
        `而合错了会把废稿盖到已经修好的代码上。\n\n` +
        `你可以用 git 命令去看(例如 git log / git diff 集成分支...<ref>)。\n` +
        `最后只输出一个 JSON 数组,放在 \`\`\`json 代码块里,每项:\n` +
        `{"ref":"...","verdict":"merge|skip|unsure","why":"一句话理由"}`,
      signal: deps.signal,
    })
    return parseTriage(out, new Set(evidence.map(e => e.ref)))
  }
}

/**
 * **回溯的映射调用:哪几个子任务要重跑、各自补哪句话。**
 *
 * 用户原话:「优先触发相应任务重新执行阶段,**补进解决对应问题提示词**。」
 * 「而不是再去开圆桌。」
 *
 * 所以这一次调用**不带判决**:没有席位、没有 quorum、不产出 pass/fail。它读的是集成验收
 * **已经写下来**的 blocking 意见,做的只是「把意见对上具体的子任务」这一件事。最终那次
 * 「合起来达没达成父目标」的结论仍由子任务修完之后的集成验收给出。
 *
 * 走**只读那一档**(`phase: 'plan'`):它要做的全部事情是读记录然后给名单;给它写工具,
 * 一个「顺手帮你改一下」的模型就能绕开整条返工链。
 *
 * 解析失败回空数组,而**下游把空数组当降级**(退回保守名单并说出来)—— 所以这个方向是安全的。
 */
export function makeBacktrackMapper(deps: {
  runAgent: RunAgentFn
  node: TaskNode
  signal: AbortSignal
}): (targets: readonly BacktrackTarget[]) => Promise<{ nodeId: string; guidance?: string }[]> {
  return async targets => {
    if (targets.length === 0) return []
    /**
     * **抬头要说这一条**为什么**进来,不能一律写「集成验收没通过」。**
     *
     * 三格的成因完全不同:集成验收判了不通过 / 产出根本不在了 / 三级都捞不回来。
     * 后两格从来没有过集成验收意见,而上一版对它们照样印「集成验收没通过,它给的意见:」——
     * 那是把一句**假前提**交给模型,而这个仓库为「送达 ≠ 说得通」付过账。
     * 判据现成:`blocking` 那句话本身就是各格自己写的理由。
     */
    const lead = (t: BacktrackTarget): string =>
      t.blocking.includes('捞回集成分支')
        ? '它的产出没能捞回集成分支(合并和加法补录都试过了),要重新做出来:'
        : t.blocking.includes('一个字节都没多')
          ? '它判了通过,而集成分支上一个字节都没多 —— 产出不在任何地方:'
          : '集成验收没通过,它给的意见:'
    const list = targets.map(t =>
      `## 任务 ${JSON.stringify(t.node.id)} —— ${t.node.title}\n` +
      `${lead(t)}\n${t.blocking || '(没有留下意见)'}\n` +
      (t.remedy.length > 0 ? `它还提过这些补救项:${t.remedy.join('、')}\n` : '') +
      `它的子任务:\n${t.node.childIds.map(id => `- ${JSON.stringify(id)}`).join('\n') || '(没有子任务)'}\n` +
      (t.suspects.length > 0 ? `其中看起来有问题的:${t.suspects.map(s => JSON.stringify(s)).join('、')}\n` : ''),
    ).join('\n')
    const out = await deps.runAgent({
      phase: 'plan',
      node: deps.node,
      role: null,
      system: 'plan',
      prompt:
        `下面这些任务**要返工**(各自的原因写在它自己那一段里:集成验收没通过 / 产出根本不在了 / ` +
        `产出没能捞回集成分支)。请把每一条对上**具体该重跑哪个子任务**,` +
        `并给它一句针对性的修正要求。\n\n${list}\n\n` +
        `规则:\n` +
        `- 只能点上面列出来的任务 id(父任务自己或它的子任务),**不要编新的 id**;\n` +
        `- 一个子任务只点一次;拿不准就点上面「看起来有问题的」那几个;\n` +
        `- \`guidance\` 是要注入它**执行阶段**提示词的话 —— 写清「这次要补上什么」,` +
        `不要写成对它的评价;\n` +
        /**
         * **不许让执行者去合那条抢救分支。**
         *
         * 「产出没能捞回来」那一格的抬头会把 ref 的名字讲清楚,而这里此前没有任何一条规则
         * 拦着模型写出「把 `<ref>` 合回来」。那条路已经被判过了(合不上、或判定不该合),
         * 让执行者顺手 merge 一条被取代的抢救分支,正是这条链最想避免的结局。
         * 兜底那条(`whyWithoutVerdict`)自己带着同样的话,而**模型给了 guidance 就会整句
         * 覆盖它** —— 所以这句必须也在这里说一遍。
         */
        `- 「产出没能捞回来」的那几条:要求它**重新做出来**,` +
        `**不要**让它去 git merge / cherry-pick 那条分支(那条路已经判过了,只能当参考读)。\n\n` +
        `只输出一个 JSON 数组,放在 \`\`\`json 代码块里,每项:\n` +
        `{"nodeId":"...","guidance":"这次要补上什么"}`,
      signal: deps.signal,
    })
    return parseBacktrackMap(out)
  }
}

/**
 * 从模型回复里抽出回溯名单。**看不懂的一律当作没说** —— 下游会退回保守名单并说出来,
 * 所以这个方向是安全的(而「猜一个」会让一批不该重跑的任务被重跑)。
 *
 * 这里**不校验 id 落不落在血统里** —— 那道白名单在 `runBacktrack` 里,靠它自己算出来的
 * 范围判。分两处的理由是这个函数拿不到那棵树,而把范围传进来只会造出第二个真相源。
 */
export function parseBacktrackMap(raw: string): { nodeId: string; guidance?: string }[] {
  for (const b of fencedBlocks(raw).reverse()) {
    try {
      const parsed: unknown = JSON.parse(b.trim())
      if (!Array.isArray(parsed)) continue
      const out: { nodeId: string; guidance?: string }[] = []
      for (const row of parsed) {
        if (typeof row !== 'object' || row === null) continue
        const r = row as { nodeId?: unknown; guidance?: unknown }
        if (typeof r.nodeId !== 'string' || r.nodeId.length === 0) continue
        out.push({ nodeId: r.nodeId, ...(typeof r.guidance === 'string' && r.guidance ? { guidance: r.guidance } : {}) })
      }
      if (out.length > 0) return out
    } catch { /* 下一个围栏 */ }
  }
  return []
}

/** 回复里的围栏内容;一个都没有就把整段当一块试一次(**不做任何宽松修补**)。 */
function fencedBlocks(raw: string): string[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  const blocks: string[] = []
  for (let m = fence.exec(raw); m !== null; m = fence.exec(raw)) if (m[1]) blocks.push(m[1])
  return blocks.length > 0 ? blocks : [raw]
}

/**
 * 从模型回复里抽出分诊结果。**任何看不懂的东西都当作没说** ——
 * 下游把「没说」一律算「拿不准」,所以这个方向是安全的。
 */
export function parseTriage(
  raw: string, known: ReadonlySet<string>,
): { ref: string; verdict: 'merge' | 'skip' | 'unsure'; why: string }[] {
  // 围栏抽取和 `parseBacktrackMap` **共用一份**:两份实现会在「多个围栏取哪个」
  // 这种细节上悄悄分叉,而那正好是模型改口时唯一起作用的地方。
  for (const b of fencedBlocks(raw).reverse()) {
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
