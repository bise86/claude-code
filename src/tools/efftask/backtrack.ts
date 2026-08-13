import { attachGuidance, descendantsOf, planRedo, type RedoContext, type RedoPlan } from './redo.js'
import type { TaskNode } from './types.js'

/**
 * **回溯:把集成验收没通过、以及产出根本不在了的那些任务重新推一遍。**
 *
 * 用户原话:
 *  - 「b 键只去检查那些集成验收不过的,让集成验收在这个任务下加任务或重新触发执行阶段等。
 *    而不是再去开圆桌。」
 *  - 「对于集成验收未通过,**优先触发相应任务重新执行阶段,补进解决对应问题提示词**。
 *    **如果不行,可以完全重做任务和加新任务。**」
 *  - 「回溯解决哪些捞不出的问题,还有集成验收未通过的问题。」
 *
 * ## 和「捞」的分工
 *
 * `m` 键管**东西还在、只是没送到**(未提交、未合并、抢救分支、只剩分支)。
 * 回溯管另外两类,它们**合并解决不了**:
 *
 *  - **产出根本不在了** —— 判据是 `mergeAndRelease` 在 `merged === false` 时自己写下的
 *    那句「该节点没有向集成分支贡献任何改动」:通过了验收,而集成分支一个字节都没多。
 *    这是用户说的「生成不知道什么原因丢失」在盘上唯一的硬证据,捞无可捞,只能重新生成。
 *  - **功能没达标** —— 集成验收判了不通过。
 *
 * ## 两级阶梯,不越级
 *
 * | 级 | 做什么 | 什么时候 |
 * |---|---|---|
 * | 1 | 被点到的子任务 `planRedo(entry='execute')`,把 blocking 意见**逐条注入它的执行提示词** | 默认 |
 * | 2 | 那个子任务 `planRedo(entry='plan')`(重新分析并拆分)+ **重新武装补救拆分** | 第 1 级已经试过、而集成验收仍然不通过 |
 *
 * 第 2 级为什么不自己去建子任务:`createChildren` 要一个 `PipelineCtx`(`reserveNodes` 的
 * **原子**预留),而按键处理里够不着 —— 手搓一个就等于把 `maxNodes` 上限静默关掉。
 * 所以改成把父节点的 `revised` 闩解开,让编排器自己那条**已经测过**的
 * `reviseDecomposition` 在下一轮集成验收里用真 ctx 把补救子任务长出来。
 * (它默认**每个节点一辈子只补救一次**,而这个闩正是这次人工干预要解开的东西。)
 *
 * ## 不开圆桌
 *
 * 这条路**不派任何裁决**。它读的是集成验收**已经写下来**的 blocking 意见和 `remedy` 提案;
 * 主模型在这里只做一次**不带判决**的映射(哪几个子任务要重跑、各自补哪句话),
 * 没有席位、没有 quorum。最终那次「合起来达没达成父目标」的结论仍然由子任务修完之后的
 * 集成验收给出 —— 否则没有任何东西把父任务标成完成。
 */

/** 这个节点被回溯过几次、最后一次是什么时候。**必须能被 `--resume` 读回**(见 `BACKTRACK_LEVELS`)。 */
export interface BacktrackMark {
  rounds: number
  at: string
}

/**
 * 阶梯只有两级,而且**第 2 级是终点**:再往上没有更贵的手段了(整棵子树重做已经包含在
 * 「重新分析并拆分」里),而无限升级只会把同一个解决不了的问题反复重跑。
 */
export const BACKTRACK_LEVELS = [1, 2] as const
export type BacktrackLevel = (typeof BACKTRACK_LEVELS)[number]

/** 下一次回溯这个节点该走第几级。 */
export function levelFor(node: TaskNode): BacktrackLevel {
  return (node.backtrack?.rounds ?? 0) >= 1 ? 2 : 1
}

/** 上一条集成验收记录判的是不是不通过。 */
export function lastIntegrateFailed(n: TaskNode): boolean {
  for (let i = n.acceptLog.length - 1; i >= 0; i--) {
    const rec = n.acceptLog[i]
    // `step` 缺席的老记录**谁的历史都不算**:acceptLog 是测试修复/验收/集成验收共用的,
    // 一条没有 step 的记录可能是叶子验收,把它当成集成验收会把回溯指到错的节点上。
    if (!rec || rec.step !== 'integrate') continue
    return rec.synthesized.pass === false
  }
  return false
}

/**
 * 这个节点的产出**根本不在了** —— `mergeAndRelease` 自己写下的那句注记。
 *
 * 两种形态都要认,而它们来自同一件事的两个时代:
 *
 *  - **BLOCKED**:现在的行为。用户说「任务没有被合并提交,就不算完成吧」之后,
 *    贡献为零的执行型节点**不再判通过**,而是带着这句话阻断 —— 这是主路径。
 *  - **ACCEPTED**:老 run 的形态(以及那条闸放行的两种例外)。那时它照样判了通过,
 *    只在 execStatus 上留一句注记。恢复一个旧 run 时这一格必须仍然认得出来,
 *    否则「回溯」对着历史上最需要它的那批节点一条都扫不到。
 */
export const NO_CONTRIBUTION_NOTE = '没有向集成分支贡献任何改动'
/** 阻断原因里那句话的抬头 —— 让阻断和 execStatus 上的注记能被同一条判据认出来。 */
export const NO_CONTRIBUTION_LEAD = '该节点'
export function outputMissing(n: TaskNode): boolean {
  if (!n.execStatus.includes(NO_CONTRIBUTION_NOTE) && !n.blockedReason.includes(NO_CONTRIBUTION_NOTE)) return false
  // 还在跑的不算 —— 它本来就还没轮到贡献。
  return n.status === 'ACCEPTED' || n.status === 'BLOCKED'
}

/** 一个要被回溯的父任务,以及它身上已经记下来的证据。 */
export interface BacktrackTarget {
  node: TaskNode
  /** 这一次对它走第几级。 */
  level: BacktrackLevel
  /** 集成验收上一次判不通过时给的意见 —— **已经在盘上**,不重新问。 */
  blocking: string
  /** 集成验收顺手提过的补救子任务(`Verdict.remedy`),去重后的标题。 */
  remedy: string[]
  /** 它的子任务里,此刻看起来最该重跑的那些(模型缺席时的保守名单)。 */
  suspects: string[]
}

/**
 * 血统里该被回溯的那些。
 *
 * **只收两类**(用户:「b 键只去检查那些集成验收不过的」+「回溯解决哪些捞不出的问题」):
 * 集成验收判过不通过的,以及产出根本不在了的。别的失败(方案评审、叶子验收)有 `r`/`R`,
 * 不归这个键 —— 一个什么都管的键等于没有判据。
 */
export function backtrackScope(
  nodes: readonly TaskNode[], targetId: string,
): { target?: TaskNode; targets: BacktrackTarget[] } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { targets: [] }
  // 血统走 childIds(自带环保护),不走 deps —— 依赖是横向引用,顺着走会漫到全树。
  const scope = [target, ...descendantsOf(target, byId).map(id => byId.get(id)).filter((n): n is TaskNode => !!n)]
  const targets: BacktrackTarget[] = []
  for (const n of scope) {
    const failed = lastIntegrateFailed(n)
    const missing = outputMissing(n)
    if (!failed && !missing) continue
    const rec = failed ? lastIntegrateRecord(n) : undefined
    const remedy: string[] = []
    for (const v of rec?.verdicts ?? []) {
      for (const c of v.remedy ?? []) if (!remedy.includes(c.title)) remedy.push(c.title)
    }
    targets.push({
      node: n,
      level: levelFor(n),
      blocking: rec?.synthesized.blockingSummary ?? (missing ? '这个任务判了通过,而集成分支上一个字节都没多 —— 产出不在任何地方' : ''),
      remedy,
      /**
       * 保守名单:**没验收通过的子任务** + **产出丢了的子任务**。
       *
       * 刻意**不**收「已验收但工作区已不在」—— 那正是按过 `c` 键之后的**正常**状态,
       * 收进来会把一大片健康的子树重执行一遍。
       */
      suspects: n.childIds.filter(id => {
        const c = byId.get(id)
        return c !== undefined && (c.status !== 'ACCEPTED' || outputMissing(c))
      }),
    })
  }
  return { target, targets }
}

function lastIntegrateRecord(n: TaskNode): TaskNode['acceptLog'][number] | undefined {
  for (let i = n.acceptLog.length - 1; i >= 0; i--) {
    const rec = n.acceptLog[i]
    if (rec?.step === 'integrate') return rec
  }
  return undefined
}

/**
 * **N 个节点合成一个 `RedoPlan`。**
 *
 * 这一段是整个功能里最容易写错的地方,而且**两种错法全套测试都能绿**:
 *
 *  - `planRedo` 第一行是 `input.map(structuredClone)`,返回一整棵**新树**。对同一份 `nodes`
 *    调 N 次 → N 棵互不相干的树,只有一棵能交出去 → **只回溯了一个节点**;
 *  - 串起来喂 → 树对了,但 `resetForExecute` 把 worktree 推进的是**本次调用的**
 *    `worktreesToRelease`,而真正删目录的人照着的正是那张表 → **N-1 个工作区一个都不删**
 *    (用户第 2、4 条要的「删 target、重新同步」对它们静默不发生);
 *    `reopenAncestor` 对非 BLOCKED 非 ACCEPTED 早退 → 第 2..N 次的 `reopenedAncestors`
 *    **恒空** → 共同祖先不在扣押集里,而它此刻是 `WAITING_CHILDREN`,调度循环当场可以
 *    把它派去集成验收。
 *
 * 所以规矩逐条写死:**定序 → 串接 → side-lists 逐项取并集 → 任何一次出错整条不做**。
 *
 * 定序按 id 升序:顺序来自模型返回的数组,而 `reopenPropagatedBlocks` 是全树不动点 ——
 * 同一份名单换个顺序会得到不同的树,那是不可测的。
 */
export function composeRedos(
  nodes: readonly TaskNode[],
  entries: readonly { nodeId: string; entry: 'execute' | 'plan'; guidance?: string }[],
  now: string,
  ctxFor?: (node: TaskNode) => RedoContext | undefined,
): RedoPlan | { error: string } {
  const ordered = [...entries].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  let tree: TaskNode[] = [...nodes]
  const merged: RedoPlan = {
    nodes: tree,
    deleted: [],
    dependencyRewrites: [],
    worktreesToRelease: [],
    // 单值字段:合成之后没有「一个」座位状态可言,取最后一次的(调用方不读它,
    // 而留一个假的确定值比留一个说不清的更糟)。
    seatedAt: 'READY',
    reopenedAncestors: [],
    warnings: [],
  }
  for (const e of ordered) {
    const node = tree.find(n => n.id === e.nodeId)
    if (!node) return { error: `节点不存在: ${e.nodeId}` }
    const one = planRedo(tree, e.nodeId, e.entry, now, ctxFor?.(node))
    /**
     * **任何一次算不出来,整条不做。**
     *
     * `planRedo` 是纯函数,到这里盘上一个字节都没动过。做半套的后果是一棵**部分回溯**的树
     * 落了盘,而屏幕上那份清单说的是全部 —— 用户没有任何办法知道少了哪几个。
     */
    if ('error' in one) return { error: `${e.nodeId}: ${one.error}` }
    if (e.guidance && e.guidance.trim().length > 0) {
      const t = one.nodes.find(n => n.id === e.nodeId)
      // 找不到在这条路上不可达(planRedo 成功就意味着它在),但静默丢掉注入的那句话
      // 是这个仓库反复付过代价的那一类。
      if (t) attachGuidance(t, 'execute', e.guidance)
      else merged.warnings.push(`${e.nodeId} 的补充提示词没能写上:回溯后的树里找不到它`)
    }
    tree = one.nodes
    merged.nodes = tree
    merged.seatedAt = one.seatedAt
    // ── side-lists 逐项取并集 ──
    for (const d of one.deleted) if (!merged.deleted.includes(d)) merged.deleted.push(d)
    for (const w of one.worktreesToRelease) {
      if (!merged.worktreesToRelease.some(x => x.nodeId === w.nodeId)) merged.worktreesToRelease.push(w)
    }
    for (const r of one.dependencyRewrites) {
      if (!merged.dependencyRewrites.some(x => x.nodeId === r.nodeId && x.from === r.from)) {
        merged.dependencyRewrites.push(r)
      }
    }
    for (const a of one.reopenedAncestors) if (!merged.reopenedAncestors.includes(a)) merged.reopenedAncestors.push(a)
    for (const w of one.warnings) if (!merged.warnings.includes(w)) merged.warnings.push(w)
  }
  return merged
}

/**
 * 在合成好的树上落下这一轮回溯的痕迹。
 *
 * 两件事:
 *  1. **轮次计数** —— 阶梯靠它决定下一次走第几级。它是顶层字段,`serializeNode` 的
 *     `{ ...node }` 会写出去、`parseNodeFile` 的整体转换会读回来,而 `nodeJournal` 走
 *     `Object.keys` 的增量,三条路都不需要额外登记。**但这件事必须有探针钉住**:
 *     这个仓库为「只写不读的字段在第一次 `--resume` 时清零」付过三次账,而这里清零的后果
 *     是阶梯**悄悄退回第 1 级**,屏幕上却写着第 2 级。
 *  2. **第 2 级解开 `revised` 闩** —— 让编排器自己那条已经测过的 `reviseDecomposition`
 *     能在下一轮集成验收里用真 ctx 把补救子任务长出来(它默认每个节点一辈子只补救一次)。
 */
export function markBacktracked(
  plan: RedoPlan, targets: readonly BacktrackTarget[], now: string,
): { rearmed: string[] } {
  const rearmed: string[] = []
  for (const t of targets) {
    const n = plan.nodes.find(x => x.id === t.node.id)
    if (!n) continue
    n.backtrack = { rounds: (n.backtrack?.rounds ?? 0) + 1, at: now }
    if (t.level === 2 && n.revised === true) {
      n.revised = false
      rearmed.push(n.id)
    }
  }
  return { rearmed }
}

/** 确认屏那几行。**是数据,不是 JSX**。 */
export function backtrackLines(
  targets: readonly BacktrackTarget[], entries: readonly { nodeId: string; entry: string }[],
): string[] {
  const out: string[] = []
  if (targets.length === 0) {
    out.push('这棵子树里没有需要回溯的任务:集成验收都通过了,产出也都在集成分支上。')
    return out
  }
  const lvl1 = targets.filter(t => t.level === 1)
  const lvl2 = targets.filter(t => t.level === 2)
  if (lvl1.length > 0) {
    out.push(`${lvl1.length} 个任务走**重新执行**:把集成验收的意见注入执行提示词,重跑一遍。`)
    for (const t of lvl1) out.push(`  · ${t.node.title}:${clip(t.blocking)}`)
  }
  if (lvl2.length > 0) {
    // 第 2 级会删子树,数量必须写出来 —— 「重做」两个字听起来像是可逆的。
    out.push(`${lvl2.length} 个任务走**完全重做**(此前已经重新执行过一轮,仍然没通过):`)
    for (const t of lvl2) {
      out.push(`  · ${t.node.title}:重新分析并拆分,先删除 ${t.node.childIds.length} 个子任务`)
      if (t.remedy.length > 0) {
        out.push(`    并重新武装补救拆分,集成验收提过的补救项:${t.remedy.slice(0, 3).join('、')}${t.remedy.length > 3 ? '…' : ''}`)
      }
    }
  }
  out.push(`共重跑 ${entries.length} 个任务的执行阶段;它们的隔离工作区会被删掉并从集成分支最新状态重建。`)
  // 这一句是这个键和 `r` 最不一样的地方:它**不开圆桌**,判决仍然由之后的集成验收给出。
  out.push('不会开新的圆桌:用的是集成验收**已经写下来**的意见;最终结论仍由子任务修完后的集成验收给出。')
  return out
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s) || '(没有留下意见)'
