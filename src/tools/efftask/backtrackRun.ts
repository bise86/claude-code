import { backtrackScope, composeRedos, conservativeEntries, entryFor, markBacktracked, type BacktrackEntry, type BacktrackTarget } from './backtrack.js'
import { affectedByRedo } from './liveRedo.js'
import { descendantsOf, type RedoContext, type RedoPlan } from './redo.js'
import type { TaskNode } from './types.js'

/**
 * 一次回溯从「用户按下确认」到「编排器重新跑起来」之间的全部动作。
 *
 * 做成**可注入的回调**,理由和 `redoRun.ts` 逐字相同,而且是被验收量出来的:那个文件挂不
 * 起来,于是唯一的防线是源码文本断言 —— 而验收把每一个被断言的字符串原样留着,造出了
 * **14 条存活变异**(算出来了但不上屏、新树不进 state、落盘和重启对调、commit 整个不可达、
 * 取消之后不回 done……),每一条的用户可见后果都是「按下确认之后界面纹丝不动」,而全套测试绿。
 *
 * 所以这里的每一步都由 `backtrackRun.test.ts` 真的调用一次并断言顺序与参数。
 */
export interface BacktrackRunDeps {
  /**
   * 派主模型读一遍**已经写下来**的集成验收意见,决定具体重跑哪几个子任务、各自补哪句话。
   *
   * **不带判决**:没有席位、没有 quorum、不产出 pass/fail —— 用户原话「而不是再去开圆桌」。
   * 不给,或者调用失败 → 退回每个目标自己的**保守名单**(`BacktrackTarget.suspects`),
   * 并把这件事说出来。**绝不静默变成空操作。**
   */
  map?: (targets: readonly BacktrackTarget[]) => Promise<
    { nodeId: string; guidance?: string }[]
  >
  /** 落盘。返回这次回溯**没做成**的事。 */
  commit: (plan: RedoPlan, before: readonly TaskNode[]) => Promise<{ problems: string[] }>
  /** 把没做成的事交给界面。空数组也要交 —— 否则上一次的警告会一直挂着。 */
  onProblems: (problems: string[]) => void
  /** 一条一条往界面上推的进度。主模型那一次是分钟级的。 */
  onProgress?: (line: string) => void
  /** 新树进 state。不做这一步,界面显示的还是回溯前那棵。 */
  onNodes: (nodes: TaskNode[]) => void
  /** 被删掉的那些节点的历史运行记录也一并扔掉(第 2 级会删子树)。 */
  onDropStreams?: (nodeIds: readonly string[]) => void
  /**
   * 落盘**之前**问一次「现在能不能做」,并把要动的节点**扣下来**。
   *
   * 运行中回溯专用。为什么必须在落盘之前:算新树和落盘之间隔着一次 await,调度循环完全
   * 可能在那期间把其中一个节点派出去(最真实的是被放回的祖先 —— 别的子任务恰好这时跑完)。
   *
   * **扣的是全集**:N 次 `planRedo` 各自的 `{target ∪ deleted ∪ reopenedAncestors ∪
   * dependencyRewrites}` 的并集 ∪ 每个目标节点自己。少了并集,共同祖先会漏出扣押集 ——
   * 而它此刻是 `WAITING_CHILDREN`,调度循环当场可以把它派去集成验收。
   */
  canApply?: (affected: readonly string[]) => string | undefined
  /** 让新树真的跑起来。**这是整个功能的目的**,少了它回溯只是改了改树。 */
  start: (nodes: TaskNode[], affected: readonly string[]) => void
  /** 关掉关口、回到来时那一屏。 */
  onDone: () => void
}

export interface BacktrackOutcome {
  /** 真的被重跑的节点。 */
  entries: { nodeId: string; entry: BacktrackEntry }[]
  /**
   * 算得出来、但**这一趟没能派出去**的那几条(`composeRedos` 跳过的)。
   *
   * 结果屏必须印它:一次「重跑了 5 个、跳过了 2 个」和一次「重跑了 5 个」对用户
   * 是两件事,而他点进这一屏往往正是为了那 2 个里的某一个。
   */
  skipped: string[]
  /** 重新武装了补救拆分的父节点(下一轮集成验收可以给它们加新的子任务)。 */
  rearmed: string[]
  /** 主模型那一步没用上(没给 / 调用失败),走的是保守名单。 */
  degraded?: string
}

/**
 * 跑一次回溯。
 *
 * 顺序和 `runRedo` 逐字相同 —— **算 → 扣 → 落盘 → 上屏 → 丢流 → 进 state → 重启**,
 * 每一步都能单独毁掉这次回溯,而且毁掉之后全套测试都能绿。
 */
export async function runBacktrack(
  nodes: readonly TaskNode[],
  targetId: string,
  now: string,
  deps: BacktrackRunDeps,
  ctxFor?: (node: TaskNode) => RedoContext | undefined,
): Promise<BacktrackOutcome | undefined> {
  const { targets } = backtrackScope(nodes, targetId)
  if (targets.length === 0) {
    deps.onProblems(['回溯未执行:这棵子树里没有集成验收未通过、也没有产出丢失的任务'])
    deps.onDone()
    return undefined
  }

  /**
   * 主模型那一步。**失败不等于什么都不做** —— 退回保守名单并把这件事说出来。
   * 静默变成空操作是这个仓库反复在修的那一类。
   */
  let degraded: string | undefined
  let mapped: { nodeId: string; guidance?: string }[] | undefined
  if (deps.map) {
    deps.onProgress?.('派主模型读一遍集成验收的意见,决定重跑哪几个子任务…')
    try {
      mapped = await deps.map(targets)
    } catch (e) {
      degraded = `主模型那一步没打通(${e instanceof Error ? e.message : String(e)}),改用保守名单`
    }
  } else {
    degraded = '这一趟没有可用的主模型,改用保守名单'
  }

  /**
   * 名单。模型给的**必须落在血统里**(白名单不是黑名单:一个编出来的 id 会被送去
   * `planRedo`,而那会改一整棵树);它一条都没给出有效项时,同样退回保守名单 ——
   * 「模型答了但全是无效的」和「没答」对用户是同一个结果,不该一个静默一个说话。
   *
   * ## 血统 = 目标的**整棵子树**,不是「目标 ∪ 保守名单」
   *
   * 这里原来收的是 `targets ∪ suspects`,而那两样是按**状态**算出来的(没验收通过的、
   * 产出丢了的)。于是白名单和证据用的是两条不同的判据,后果在跑机上量得到:
   * datum 那个父任务的集成验收白纸黑字点着 `datum.rs` 不在集成工作区,主模型也正确地
   * 点了写 datum 的那个子任务 —— 而它 `status: ACCEPTED`、改过一行 Cargo.toml 所以
   * 「有贡献」,不在 suspects 里,于是被当成**幻觉 id 丢掉**,屏幕上印的是
   * 「主模型点了 1 个不在这棵子树里的任务,已忽略」—— 一句假话:它就在这棵子树里。
   * 名单退回保守版,重跑了三个不相干的兄弟,真凶一次都没动。
   *
   * 防幻觉的目的由「必须是这棵子树里真实存在的节点」承担,这一条一个字没松。
   */
  const byId = new Map(nodes.map(n => [n.id, n]))
  const inScope = new Set<string>()
  for (const t of targets) {
    inScope.add(t.node.id)
    for (const s of t.suspects) inScope.add(s)
    for (const d of descendantsOf(t.node, byId)) inScope.add(d)
  }
  const guidanceOf = new Map<string, string>()
  let ids: string[] = []
  if (mapped) {
    const dropped: string[] = []
    for (const m of mapped) {
      if (!inScope.has(m.nodeId)) { dropped.push(m.nodeId); continue }
      if (!ids.includes(m.nodeId)) ids.push(m.nodeId)
      if (m.guidance) guidanceOf.set(m.nodeId, m.guidance)
    }
    if (dropped.length > 0) {
      deps.onProgress?.(`主模型点了 ${dropped.length} 个不在这棵子树里的任务,已忽略:${dropped.slice(0, 3).join('、')}`)
    }
    if (ids.length === 0) degraded = degraded ?? '主模型没有给出这棵子树里的任何任务,改用保守名单'
  }
  if (ids.length === 0) {
    /**
     * 保守名单 —— **和确认屏共用同一份实现**(`conservativeEntries`),否则用户是照着
     * 一份名单按的确认,而跑的是另一份。
     */
    for (const e of conservativeEntries(targets, byId)) if (!ids.includes(e.nodeId)) ids.push(e.nodeId)
  }

  /**
   * 每个目标走第几级由它自己的 `backtrack.rounds` 决定,而**被重跑的子任务跟着它的父目标**
   * —— 阶梯是记在「集成验收没通过的那个节点」身上的,不是记在子任务身上:同一个父任务
   * 第二次仍然不通过,该升级的是**这次干预的手段**,而不是某个碰巧被点两次的子任务。
   */
  const levelOfChild = new Map<string, 1 | 2>()
  for (const t of targets) {
    if (levelOfChild.get(t.node.id) === undefined) levelOfChild.set(t.node.id, t.level)
    for (const s of t.suspects) if (levelOfChild.get(s) === undefined) levelOfChild.set(s, t.level)
  }
  /**
   * **模型缺席时用已经写下来的意见兜底注入。**
   *
   * 规范席点名:`guidanceOf` **只**从模型的映射来,而屏幕上那句承诺是无条件的 ——
   * 「把集成验收的意见**注入执行提示词**,重跑一遍」。没有 `deps.map`(或它抛了)的那一趟,
   * `attachGuidance` 一次都不进,重跑就是**裸重跑**:同样的提示词、同样的模型,
   * 凭什么这次会不一样。而 `BacktrackTarget.blocking` 里那句话**本来就在盘上**,
   * 它此前只被拿去上屏和喂模型,从没送进过执行提示词。
   *
   * 兜底的话按目标归属:被点到的子任务拿它父目标的那句(阶梯本来就是记在父目标身上的)。
   */
  const fallbackOf = new Map<string, string>()
  for (const t of targets) {
    if (t.blocking.trim().length === 0) continue
    if (!fallbackOf.has(t.node.id)) fallbackOf.set(t.node.id, t.blocking)
    /**
     * **铺到整棵子树,和 `inScope` 同一个范围。**
     *
     * 两处范围必须一样,而放宽 `inScope` 的那一次没带上这里 —— 规范席实测出的后果:
     * 主模型点了一个**合法但不在保守名单里**的后代(那正是放宽 inScope 要救的那种节点),
     * 它被接受、被重跑,却**一句意见都拿不到** —— 同样的提示词、同样的模型,
     * 凭什么这次会不一样。而确认屏承诺的是「把集成验收的意见注入执行提示词」。
     */
    for (const s of [...t.suspects, ...descendantsOf(t.node, byId)]) {
      if (!fallbackOf.has(s)) fallbackOf.set(s, t.blocking)
    }
  }
  /**
   * 每个被点到的节点从哪一关重来,由 `entryFor` **按它自己的形态**决定 —— 见那个函数:
   * 写死 `execute` 会让拆分型节点上的这一条必然算不出来,而那一条以前会把整次回溯带走。
   *
   * 名单里可能有主模型点的、也可能有保守名单里的,两种都要过同一道 —— 所以这里
   * 现查 `byId`,拿不到节点的直接跳过(它在 `inScope` 里说明存在过,但树是可变的)。
   */
  const entries = ids.flatMap(id => {
    const node = byId.get(id)
    if (!node) return []
    const guidance = guidanceOf.get(id) ?? fallbackOf.get(id)
    return [{
      nodeId: id,
      entry: entryFor(node, levelOfChild.get(id) === 2 ? 2 : 1),
      ...(guidance !== undefined && guidance.trim().length > 0 ? { guidance } : {}),
    }]
  })

  /**
   * 名单空掉是**可达**的:targets 都在,而它们的 suspects 在树里一个都查不到(手改过的
   * childIds、或者刚被别的操作删掉)。`composeRedos` 对空名单原样返回一份没变的树 ——
   * 照常走下去会落盘、重启编排器,而结果屏说「没有重跑任何任务」。当场说清并停下。
   */
  if (entries.length === 0) {
    deps.onProblems(['回溯未执行:这棵子树里没有一个可以重新派出去的任务'])
    deps.onDone()
    return undefined
  }
  const computed = composeRedos(nodes, entries, now, n => ctxFor?.(n))
  if ('error' in computed) {
    // 纯函数,到这里盘上一个字节都没动过 —— 说清原因、关掉关口,用户可以换个节点再试。
    deps.onProblems([`回溯未执行: ${computed.error}`])
    deps.onDone()
    return undefined
  }

  /**
   * 这一趟**真的**被派出去的那些。被 `composeRedos` 跳过的一条都不算 —— 下面三件事
   * 全都挂在这份名单上:扣押集、痕迹/证据的清理、以及结果屏印的数字。
   */
  const skippedIds = new Set(computed.skipped.map(s => s.nodeId))
  const applied = entries.filter(e => !skippedIds.has(e.nodeId))
  /**
   * 扣押集取**全集**。`affectedByRedo` 是单 plan 单 target 的,所以逐个算再并 ——
   * 少了并集,共同祖先会漏出去,而它此刻是 `WAITING_CHILDREN`,调度循环当场可以把它
   * 派去集成验收。
   */
  const affected = [...new Set([
    ...applied.flatMap(e => affectedByRedo(computed, e.nodeId)),
    ...targets.map(t => t.node.id),
  ])]
  const blocked = deps.canApply?.(affected)
  if (blocked) {
    deps.onProblems([`回溯未执行: ${blocked}`])
    deps.onDone()
    return undefined
  }

  // 阶梯的痕迹要落在**合成之后的那棵树**上(它是马上要落盘的那一份)。
  // 只对**真的被送去重跑**的那些记轮次、清证据 —— 见 markBacktracked 的 `reran`。
  const { rearmed } = markBacktracked(computed, targets, now, new Set(applied.map(e => e.nodeId)))

  const { problems } = await deps.commit(computed, nodes)
  /**
   * **算不出来而被跳过的那几条,必须自己上屏。**
   *
   * `composeRedos` 现在跳过算不出来的那一条而不是整条不做,那条规矩的全部前提就是
   * 「跳过了什么要说出来」—— 而 `commitRedo` 只报落盘阶段的问题,`plan.warnings`
   * 一个字都不看。少了这一句,用户会拿着一份「已重跑 N 个」的结果屏,而他点的那个
   * 节点恰恰在被跳过的那几条里。
   */
  for (const w of computed.warnings) problems.push(`⚠ ${w}`)
  if (degraded) problems.unshift(`⚠ ${degraded}`)
  deps.onProblems(problems)
  // 历史运行记录跟着节点一起走,**排在 onNodes 之前** —— 那一句会让界面立刻用新树重画,
  // 而重画时详情页按 nodeId 取流:先换树后删流,中间那一帧里新节点会显示上一轮的输出。
  if (computed.deleted.length > 0) deps.onDropStreams?.(computed.deleted)
  deps.onNodes(computed.nodes)
  // 落盘在前、重启在后:反过来编排器会在一棵还没写下去的树上开跑。
  deps.start(computed.nodes, affected)
  return {
    // **只报真的派出去的那些。** 把跳过的也算进去,结果屏那句「已重跑 N 个」就是假的,
    // 而用户按下这个键往往正是为了其中某一个。
    entries: applied.map(e => ({ nodeId: e.nodeId, entry: e.entry })),
    skipped: computed.skipped.map(s => `${s.nodeId}:${s.reason}`),
    rearmed,
    ...(degraded ? { degraded } : {}),
  }
}
