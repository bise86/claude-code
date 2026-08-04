import { MANUAL_PASS_ROLE, MAX_GUIDANCE_CHARS, PHASE_LABEL, PHASE_NAMES, SKIPPABLE_PHASES, type NodeStatus, type PhaseName, type TaskNode } from './types.js'
import type { Strictness } from './strictness.js'
import { addUsage } from './usage.js'

/**
 * 重做 —— 把某个节点退回到某个环节重新跑一遍。
 *
 * 在这之前,恢复面只有一条:`/et --resume <id> --retry-blocked`。它的粒度是**整个运行**
 * (所有被安全阀挡住的节点一起重开),而且只对「被阀门挡住」的节点有效 —— 一个已经
 * ACCEPTED 但结果不对的节点、一个方案就跑偏了的父任务,都没有任何入口。用户的原话是
 * 「降低恢复成本」:出了问题不该只能整轮重来。
 *
 * ## 两级:任务重做 / 阶段重做
 *
 * 第一级只有两条:**任务重做**(整任务重来,会删子树)和**阶段重做**(从某个环节重新开始)。
 * 分开是因为它们的代价差着数量级,而「重做」两个字对两者听起来一样。
 *
 * ## 为什么阶段重做里有一半是禁用的
 *
 * 能**单独重入**的点由状态机的形状决定,不是偷懒 —— `advanceableKind` 只认三个:
 * `CREATED→stepStart`、`READY && executable→stepExecute`、`WAITING_CHILDREN && 子全绿→stepIntegrate`。
 * 其余环节全都跑在这三个之内:
 *
 *  - `stepStart` 跑 plan → review。两个环节各自可以是第一轮的入口(见 `redoFrom`),
 *    所以**分析和质疑讨论都是真入口**;
 *  - `stepExecute` 跑 execute → verify → accept → observer → merge,是**一个整体** ——
 *    它只有一个入口(READY),中途没有第二个可进入的点(唯一的例外是人工解决冲突后从
 *    ACCEPTANCE 续跑,而那条路要求 mergeConflict 为真,是给冲突用的,不是给重做用的);
 *  - `stepIntegrate` 跑 integrate → observer,是拆分任务在子任务全绿后的那一场裁决。
 *
 * 所以菜单里给「验收重做」这样一个**能按下去**的条目会是假的:它做不到只重跑验收。
 * 三份验收各自量过它要付的代价 —— 已验收节点的隔离工作区早被 `mergeAndRelease` 放掉了,
 * 重新 acquire 拿到的是集成分支 tip(含此后所有兄弟合入的改动);通过之后那次空合并会往
 * `execStatus` 里**永久追加**一句「该节点没有向集成分支贡献任何改动」,而它对一个确实
 * 贡献过的节点是假的,并且会被喂进之后每一次验收提示词;验收不通过还会 `continue` 回到
 * 执行者。三条假话换一个条目,不值。
 *
 * **禁用的条目留在屏幕上并写明原因**,不是不渲染:菜单随节点类型忽隐忽现时用户记不住
 * 「第三项」是哪一项,而且看不见「为什么这里不能这么做」。
 *
 * ## 父任务重做为什么必须先删子树
 *
 * 用户明确要求「如果父任务重做,就先将下面子任务全部删除掉,重做完再加新的子任务,
 * 包括依赖关系也要重新修订」。这条要求和 reseat 里那条规则 1 是同一件事的两面:
 * `createChildren` 的子 id 由「父 id + 序号 + 标题」推导,所以留着旧子树重新拆分时,
 * 标题相同的会**覆盖**旧节点(可能覆盖掉已经 ACCEPTED 的),标题不同的会留下一批
 * 永远等不到的幽灵兄弟,`childrenAllAccepted` 于是永久卡住。删干净是唯一自洽的做法。
 */
/**
 * 一次重做从**哪个环节**重新进入。
 *
 * 就是 `PhaseName` 本身,不再是自成一套的三值枚举 —— 菜单要按环节列,而两套词汇
 * (`'plan'|'execute'|'integrate'` 和七个环节名)之间的翻译层是纯粹的漂移源。
 * 哪几个真能按下去由 `redoOptions()` 判定,不由类型判定。
 */
export type RedoEntry = PhaseName

/** 菜单第一级:整任务重来,还是从某个环节重来。 */
export type RedoScope = 'task' | 'phase'

/** 执行型节点从 READY 往下会跑过去的那一整段。stepExecute 只有一个入口,中途分不开。 */
const EXECUTE_TAIL: PhaseName[] = ['execute', 'verify', 'accept', 'observer']
/** 拆分型节点在子任务全绿之后的那一场裁决。 */
const INTEGRATE_TAIL: PhaseName[] = ['integrate', 'observer']

/**
 * 从某个环节重做时,**会跑过去的环节链**(还没按本次配置过滤)。
 *
 * 一张表,不是散在 `phasesOf` 和 `phaseChainText` 里的两份 —— 原来那两份各写了一遍
 * `chain` 和 `all`,两边都得记得改;这次要从 3 条长到 7 条,漂移是必然的而不是可能的。
 *
 * **必须看节点形态。** 第一版把 review 写成 `['review']`,而那是一句**假话**:
 * stepStart 里 reviewOnly 那一支通过之后走的是普通路由 —— 执行型节点 `commit(READY)`,
 * 调度器接着就分派 stepExecute。实测「从质疑讨论重做」一个执行型节点,真实跑过去的是
 * 质疑讨论 → 执行 → 测试验证 → 验收 → 观察 → 合并,而屏幕上写着「只重跑一次质疑讨论」——
 * 代价少报一个数量级。
 *
 * 空数组 = 这个环节不能单独重入(原因见 `PHASE_ENTRY_BLOCKED`)。
 */
function redoChain(entry: RedoEntry, node?: TaskNode): PhaseName[] {
  // 判据和 isDecomposed 一致:有子任务、或者自称拆分型。
  const decomposed = node ? node.childIds.length > 0 || node.kind === 'decompose' : false
  const tail = decomposed ? INTEGRATE_TAIL : EXECUTE_TAIL
  switch (entry) {
    // 任务重做把 kind 重置成 unknown,重新分析之后是拆是干**现在不可知**。按节点当前的
    // 形态给一条最可能的链,并在 detail 里点明它可能变 —— 印一条确定的链是假确定。
    case 'plan': return ['plan', 'review', ...tail]
    case 'review': return ['review', ...tail]
    case 'execute': return EXECUTE_TAIL
    case 'integrate': return INTEGRATE_TAIL
    default: return []
  }
}

/**
 * 不能单独重入的环节,以及**能照做的下一步**。
 *
 * 只说「不可用」是半句话:用户想重跑的那件事通常还是做得到的,只是入口在别处。
 */
function entryBlockedReason(phase: PhaseName, decomposed: boolean, ctx?: RedoContext): string | undefined {
  if (phase !== 'verify' && phase !== 'accept' && phase !== 'observer') return undefined
  /**
   * **这个环节这次压根不发生**时,别谈「去哪儿重跑」。
   *
   * 默认配置下 verify 和 observer 都是 0 席,而原来无条件写「要重跑它请选『从执行重做』」——
   * 同一屏上「从执行重做」那一条的说明里明写着「不跑:测试验证、观察(未配置角色,
   * 这些环节不存在)」。两行同框,后一行叫他去按前一行,前一行说这次不跑它。
   */
  if (!phaseRuns(phase, ctx)) {
    return ctx?.skipSteps?.includes(phase)
      ? `本次运行跳过了${PHASE_LABEL[phase]},重做也不会跑它 —— 要启用请去掉 skipSteps 里的这一项`
      : `本次运行没有${PHASE_LABEL[phase]}环节(没给它配角色),重做也不会跑它 —— 要启用请先在 roles 里配席位`
  }
  // 拆分任务自己不跑执行那一段,所以「从执行重做」在它上面也是灰的 —— 不能指过去。
  if (decomposed) {
    return phase === 'verify'
      ? '这是拆分任务,测试验证由子任务各自完成 —— 要重跑某一个,请到那个子任务上重做'
      : phase === 'accept'
        ? '拆分任务自己的裁决是集成验收 —— 请选「从集成验收重做」'
        : '观察评分跟在集成验收通过之后跑,没有自己的入口 —— 要重新评分请选「从集成验收重做」'
  }
  return phase === 'verify'
    ? '测试验证跑在执行环节内部,没有自己的入口 —— 要重跑它请选「从执行重做」'
    : phase === 'accept'
      ? '验收跑在执行环节内部,没有自己的入口 —— 要重跑它请选「从执行重做」'
      : '观察评分跟在验收通过之后跑,没有自己的入口 —— 要重新评分请选「从执行重做」'
}

/**
 * 这次重做**实际会跑哪些环节**。
 *
 * 为什么要算而不是写死一句话:菜单原来无条件写着「重跑 执行 → 测试验证 → 验收」,
 * 而这在**默认配置下就是假的** —— 测试验证是 opt-in(`phaseRoles.verify.length > 0`),
 * 而 emptyPhaseRoles() 给的默认就是 0 席。大多数用户不配角色,所以大多数用户看到的
 * 那句话是假的。`skipSteps` 还能再关掉执行或验收。
 *
 * 同一份代码在别处非常在意这个歧义(执行被跳过时会往节点里写一行「执行环节已跳过」),
 * 唯独这个关口没跟上。这是本项目反复出的同一种错:**界面告诉用户一件不真的事**。
 */
export interface RedoContext {
  /** 每个环节配了几席。0 席的环节要么不存在(verify),要么回落到别的席位。 */
  seatCount?: Partial<Record<PhaseName, number>>
  /** 用户明确要求跳过的环节。 */
  skipSteps?: readonly PhaseName[]
  /**
   * 这次运行是不是每个节点一个 git worktree。
   *
   * 「跳过验收」要靠它判断能不能安全放行:隔离运行里,节点的产出在**它自己那个工作区**里,
   * 而跳过验收会直接走合并 → 已验收。工作区引用丢了(`--resume` 会清掉失效路径)的时候
   * 那次合并合的是一个刚从集成分支切出来的空工作区 —— 节点被判「已验收」而它的产出
   * 一行都没进去。`mergeAndRelease` 的 `!node.worktree → return true` 正是这条路。
   *
   * 非隔离运行不存在这个问题:执行者直接写在用户的检出里,产出已经在那儿了。
   */
  isolated?: boolean
  /**
   * 这一刻生效的严格度档位(`control.strictness() ?? config.caps.strictness`)。
   *
   * 只用于关口上那一行 —— 重做**不改**档位,而这正是要说出来的那件事。
   * 清理那一侧见 `reopenPropagatedNode`:档位是 run 级持续状态,**不在**一次性标记之列。
   */
  strictness?: Strictness
}

/**
 * 某个环节这次会不会真的发生。
 *
 * verify 和 observer 是**仅有的两个**「没配角色就整个不存在」的环节 —— `scoreNode` 的
 * 第一句判据就是 `seats.length === 0 → return false`。其余环节没配席位时会回落
 * (0 席在 plan/review/execute/accept 上是「主模型顶上跑一次」,在 integrate 上是
 * 「回落到 accept 席位」),照样发生。口径与 pipeline.ts 里 isSkipped 那段注释逐字对齐
 * (「只有 verify/observer 真的不发生」)。
 *
 * 把这条写成通用规则的话,没配 accept 角色的 run 会被告知不做验收,而它其实是做的。
 *
 * 导出是因为菜单的 disabled 判据要用同一份 —— 屏幕上禁用而 planRedo 放行,就是两个真相源。
 */
export function phaseRuns(phase: PhaseName, ctx?: RedoContext): boolean {
  if (ctx?.skipSteps?.includes(phase)) return false
  if (phase === 'verify' || phase === 'observer') return (ctx?.seatCount?.[phase] ?? 0) > 0
  return true
}

/**
 * 一次重做实际会跑过去的环节链,按顺序。不能单独重入的环节返回空数组。
 *
 * `node` 不是可选的装饰:review / plan 两条链的尾巴由节点形态决定(拆分型接集成验收,
 * 执行型接整条执行链)。不传的话按执行型算 —— 那是**更贵**的那一条,宁可高报不可低报。
 */
export function phasesOf(entry: RedoEntry, ctx?: RedoContext, node?: TaskNode): PhaseName[] {
  return redoChain(entry, node).filter(p => phaseRuns(p, ctx))
}

/** 「执行 → 测试验证 → 验收」这样一句**照实**的描述,以及被跳过的部分。 */
export function phaseChainText(entry: RedoEntry, ctx?: RedoContext, node?: TaskNode): string {
  const runs = phasesOf(entry, ctx, node)
  const missing = redoChain(entry, node).filter(p => !runs.includes(p))
  const body = runs.length > 0 ? runs.map(p => PHASE_LABEL[p]).join(' → ') : '(没有任何环节会跑)'
  if (missing.length === 0) return body
  // 说清**为什么**不跑,而不是只说不跑:两种原因的补救办法完全不同 ——
  // 一个是去配角色,一个是去掉 skipSteps。
  //
  // **按原因归并**,不是一个环节一个括号。链从 3 条长到 6 条之后,默认配置(verify 和
  // observer 都没席位)下逐条写出来是「测试验证(未配置角色,该环节不存在)、观察(未配置
  // 角色,该环节不存在)」—— 同一句理由印两遍,而这一行本来就已经在 80 列上折行了。
  const skipped = missing.filter(p => ctx?.skipSteps?.includes(p))
  const unconfigured = missing.filter(p => !ctx?.skipSteps?.includes(p))
  const why: string[] = []
  if (skipped.length > 0) why.push(`${skipped.map(p => PHASE_LABEL[p]).join('、')}(本次配置跳过)`)
  if (unconfigured.length > 0) {
    why.push(`${unconfigured.map(p => PHASE_LABEL[p]).join('、')}(未配置角色,${unconfigured.length > 1 ? '这些环节' : '该环节'}不存在)`)
  }
  return `${body};不跑:${why.join(';')}`
}

/**
 * 这次重做的**环节实况** —— 席位从**目标节点**上取,不是从 run 配置上取。
 *
 * 席位来源搞错会让关口承诺一个这个节点上根本不存在的环节:`applyRosterToNodes` 的第一句
 * 是 `if (n.status === 'ACCEPTED') continue`,而重做目标**绝大多数就是 ACCEPTED 节点** ——
 * resume 时新加一个测试验证席位,run 配置上有了,那个节点上没有;而真正决定环节跑不跑的
 * 是 pipeline 里读的 `node.phaseRoles.verify`,不是 config。
 *
 * 这个函数原来长在 efftask.tsx 的 JSX 里,而那一句用了一个**没有导入**的 `PHASE_NAMES` ——
 * 仓库没有 typecheck,于是它一路过了打包,按下 r 就是一屏 ReferenceError。搬进来是为了
 * 让它有接缝可测,不只是为了修那一行。
 */
export function redoContextOf(
  node: TaskNode,
  cfg?: { skipSteps?: readonly PhaseName[] },
  opts?: { isolated?: boolean; strictness?: Strictness },
): RedoContext {
  return {
    // 只有命令层看得到 `control`,所以和 isolated 一样由调用方传。
    ...(opts?.strictness !== undefined ? { strictness: opts.strictness } : {}),
    seatCount: Object.fromEntries(
      PHASE_NAMES.map(p => [p, (node.phaseRoles?.[p] ?? []).length]),
    ) as Record<PhaseName, number>,
    skipSteps: cfg?.skipSteps,
    /**
     * 隔离与否只有命令层知道(它手里才有那个池子),所以由调用方传。
     *
     * **缺省(undefined/false)是宽松的那一侧,不是保守的那一侧** —— 第一版的注释把方向
     * 说反了,评审点了出来:`skipFailedPhaseReason` 的闸门是
     * `ctx?.isolated === true && !node.worktree`,所以缺省时它**不触发**,也就是放行。
     *
     * 真正兜住这条的是 `pipeline.stepExecute` 里的 `node.worktree !== undefined`:
     * 拿不到工作区就退化成正常跑一轮,并在节点上留一行说明。命令层(efftask.tsx)确实
     * 一直传值,所以今天不成灾;写清方向是为了下一个人不会以为「不传也安全」而删掉
     * 那道纵深防御。
     */
    ...(opts?.isolated === undefined ? {} : { isolated: opts.isolated }),
  }
}

/**
 * 阻断那一刻它在跑哪个环节 —— `failedAt`(一个 NodeStatus)翻成环节名。
 *
 * 一张表,不是一串 if:七个环节、十五个状态,而这个映射是「哪个环节失败了」这件事的
 * **唯一**判据(见 TaskNode.failedAt 为什么不反推)。
 *
 * `READY` / `WAITING_CHILDREN` 也算:节点坐在座位上却没能被派出去(依赖成环、拿不到隔离
 * 工作区、调度器判它走不动),失败的就是那个座位后面的环节。
 */
const STATUS_PHASE: Partial<Record<NodeStatus, PhaseName>> = {
  CREATED: 'plan', PLANNING: 'plan',
  PLAN_REVIEW: 'review',
  // stepExecute 是一个整体:READY 进,中途 EXECUTED/REWORK/MERGE 都在它里面。
  READY: 'execute', EXECUTING: 'execute', EXECUTED: 'execute', REWORK: 'execute', MERGE: 'execute',
  VERIFYING: 'verify',
  ACCEPTANCE: 'accept',
  WAITING_CHILDREN: 'integrate', INTEGRATION_ACCEPT: 'integrate',
  SCORING: 'observer',
}

/** 失败的是哪个环节。`undefined` = 这个节点没有失败,或者看不出来(见 failedRedoTarget)。 */
export function failedPhaseOf(node: TaskNode): PhaseName | undefined {
  if (node.status !== 'BLOCKED') return undefined
  return node.failedAt === undefined ? undefined : STATUS_PHASE[node.failedAt]
}

/**
 * 这个失败环节要从哪个**可重入**的入口重来。
 *
 * 七个环节只有四个能单独重入(见文件头),所以这里是「失败在 X → 从 Y 进」的映射,
 * 而不是恒等。测试验证 / 验收 / 观察都跑在 `stepExecute` 内部,唯一入口是执行;
 * 拆分型节点没有执行环节,它的裁决是集成验收。
 */
function entryForPhase(phase: PhaseName, node: TaskNode): RedoEntry {
  if (phase === 'plan') return 'plan'
  if (phase === 'review') return 'review'
  if (phase === 'integrate') return 'integrate'
  return isDecomposed(node) ? 'integrate' : 'execute'
}

/** `propagateBlocked` 写在别人身上的三种理由,以及它们各自该去动谁。 */
const PROPAGATED_ADVICE: Record<string, string> = {
  子节点阻断: '这个节点是因为**它的子任务**失败才停的 —— 请到那个子任务上重做',
  上级任务阻断: '这个节点是因为**上级任务**被阻断才停的 —— 请先处理上级那个',
  依赖阻断: '这个节点是因为**它依赖的任务**失败才停的 —— 请到那个依赖上重做',
  子节点缺失: '这棵树自己对不上(子节点缺失),不是某个环节失败 —— 见 README 的手工修复',
  依赖节点缺失: '这棵树自己对不上(依赖节点缺失),不是某个环节失败 —— 见 README 的手工修复',
  依赖成环: '这棵树自己对不上(依赖成环),不是某个环节失败 —— 见 README 的手工修复',
}

/**
 * 「快速重做失败的那个环节」要重做的是哪一条。
 *
 * 用户的原话:「对于失败的任务,有键可以快速重做失败的阶段」。所谓「快速」是**省掉两屏
 * 菜单**,不是省掉确认屏 —— 失败在分析环节的拆分型节点,它的入口就是「任务重做」,
 * 而那一条会删掉整棵子树。一个按下去就删的快捷键不该存在。
 *
 * 拿不到时返回**原因**,而且原因分得很细:一个「这个节点不是自己失败的」和一个
 * 「看不出是哪个环节」需要用户做的事完全不同。
 */
export function failedRedoTarget(
  node: TaskNode, byId: ReadonlyMap<string, TaskNode>, ctx?: RedoContext,
): { entry: RedoEntry; phase: PhaseName } | { error: string } {
  if (node.status !== 'BLOCKED') {
    return { error: `「${node.title}」没有失败(当前 ${node.status})—— 快速重做只对失败的任务有意义,要重做它请按 r 自己选环节` }
  }
  const phase = failedPhaseOf(node)
  if (phase === undefined) {
    const advice = PROPAGATED_ADVICE[node.blockedReason.trim()]
    if (advice) return { error: advice }
    return { error: `看不出「${node.title}」是哪个环节失败的(这条记录来自更早的版本,或者被手工改过)—— 请按 r 自己选环节` }
  }
  const entry = entryForPhase(phase, node)
  const opt = redoOptions(node, byId, ctx).find(o => o.entry === entry)
  // 授权判据仍然是菜单那一份 —— 快捷键不许从旁门进去。
  if (!opt) return { error: `未知的重做入口: ${entry}` }
  if (opt.disabled) return { error: `失败在「${PHASE_LABEL[phase]}」,而${opt.label}此刻不可用:${opt.disabled}` }
  return { entry, phase }
}

/**
 * 「跳过失败的那个环节,继续往下走」能不能做 —— 不能时返回**原因**。
 *
 * 用户的原话:「或跳过失败的阶段,继续往下走」。能跳的只有四个环节(见 SKIPPABLE_PHASES):
 * 那是「活已经干完了、判的人不放行」的四个。
 */
export function skipFailedPhaseReason(
  node: TaskNode, ctx?: RedoContext,
): string | undefined {
  return failedPhaseActionReason(node, '跳过', ctx)
}

/**
 * 「强制通过失败的那个环节」能不能做 —— 不能时返回**原因**。
 *
 * **闸门和跳过一字不差**,所以它们共用一个实现:两者路由完全相同(见
 * `TaskNode.forcePass`),差别只在留不留记录,而一条记录改变不了任何一条闸门的理由。
 * 各写一份的话,最松的那一份就是实际生效的那一份 —— `SKIPPABLE_PHASES` 的注释
 * 已经为同一件事写过一次。
 *
 * 尤其是隔离运行 + 工作区引用丢失那一条:跳过它会把空工作区合进集成分支并判「已验收」,
 * 而强制通过在此之上**还要**记一条「有人放行过」—— 严格更坏,更不能漏。
 */
export function forcePassFailedPhaseReason(
  node: TaskNode, ctx?: RedoContext,
): string | undefined {
  return failedPhaseActionReason(node, '强制通过', ctx)
}

/** 跳过 / 强制通过共用的那套闸门。`what` 只进文案,不进任何判据。 */
function failedPhaseActionReason(
  node: TaskNode, what: '跳过' | '强制通过', ctx?: RedoContext,
): string | undefined {
  if (node.status !== 'BLOCKED') return `「${node.title}」没有失败(当前 ${node.status}),没有环节可${what}`
  const phase = failedPhaseOf(node)
  if (phase === undefined) {
    const advice = PROPAGATED_ADVICE[node.blockedReason.trim()]
    return advice ?? `看不出「${node.title}」是哪个环节失败的,无法${what}它 —— 请按 r 重做`
  }
  if (!SKIPPABLE_PHASES.has(phase)) {
    /**
     * 分析 / 执行不能「跳过」。
     *
     * 跳过分析 = 带着空方案进评审;跳过执行 = 一行代码都不写就去验收。这两件事的名字叫
     * **放弃这个节点**,而不是「跳过一个环节」—— 说清区别,并给出能照做的下一步。
     */
    return phase === 'plan'
      ? `失败在「分析」:${what}它等于让这个节点带着空方案往下走,评审员会对着空白发表意见 —— 请用 r 重做分析,或在启动关口用 skipSteps 整个跳过分析`
      : phase === 'execute'
        ? `失败在「执行」:${what}它等于承认这个节点什么都没做,而验收员会照常开会核对这个空产出 —— 请用 r 从执行重做`
        : `失败在「${PHASE_LABEL[phase]}」,这个环节不能单独${what} —— 请用 r 重做`
  }
  /**
   * 隔离运行 + 工作区引用已丢 → **不许跳过验收/测试验证**。
   *
   * 这两条跳过之后都会走到合并:`mergeAndRelease` 在 `!node.worktree` 时直接
   * `return true`,于是节点被判「已验收」,而它的产出一行都没进集成分支。
   * 而重新 acquire 更糟 —— 它 `checkout -B` 回集成分支,把节点自己那些还没合并的提交
   * 挪到一条 salvage 分支上,工作区当场变空。
   */
  if ((phase === 'accept' || phase === 'verify') && ctx?.isolated === true && !node.worktree) {
    return `这次运行是隔离的,而本节点的工作区引用已经不在了(--resume 会清掉失效路径)—— ` +
      `此时${what}${PHASE_LABEL[phase]}会把一个空工作区合进集成分支并判「已验收」。请用 r 选「从执行重做」`
  }
  if (phase === 'accept' || phase === 'verify') {
    // 这两条要坐 READY,而 advanceableKind 对 READY + unknown 返回 null —— 节点会既不可推进
    // 也不是终态,run 以「存在无法推进的阻断节点」结束,而节点上没有任何理由。
    if (node.kind !== 'executable') {
      return `本节点还不是执行型(kind=${node.kind}),坐不回执行环节的座位 —— 请用 r 重做`
    }
  }
  if (phase === 'integrate' && node.childIds.length === 0) {
    return '没有子任务,不存在集成验收'
  }
  return undefined
}

/**
 * 运行中**预先批准**能选哪几个环节 —— 不能选的也列出来,并说原因。
 *
 * 和阻断后那条路不同:那时候「哪个环节」由 `failedAt` 说了算,没得选;运行中节点还没
 * 倒下,用户要自己指一个「等会儿走到那儿别开会了」。
 *
 * 两道过滤,都不是洁癖:
 *  - `phaseRuns`:本次运行里根本不存在的环节(没配席位的测试验证)选了也不会发生,
 *    而屏幕上摆着一个按下去什么都不变的选项,比没有这个选项糟。
 *  - 结构:验收/测试验证只属于执行型叶子,集成验收只属于有子任务的节点。给一个拆分型
 *    节点提供「强制通过验收」是在承诺一件它这辈子都不会走到的事。
 *
 * **不判「这个环节是不是已经过去了」**。那要从 status 反推节点在循环里的位置,而返工会
 * 让它一轮轮回头 —— 反推出来的答案在最常见的那种节点上就是错的。屏幕上照实说「下一次
 * 走到这个环节时生效」,让用户自己看着树决定,比一个猜出来的禁用状态诚实。
 */
export function forcePassOptions(
  node: TaskNode, ctx?: RedoContext,
): { phase: PhaseName; label: string; disabled?: string }[] {
  const decomposed = isDecomposed(node)
  return [...SKIPPABLE_PHASES].map(p => p as PhaseName).map(phase => {
    const label = PHASE_LABEL[phase]
    if (!phaseRuns(phase, ctx)) {
      return { phase, label, disabled: ctx?.skipSteps?.includes(phase) ? '本次运行整个跳过了它' : '本次没有配置这个环节' }
    }
    if ((phase === 'accept' || phase === 'verify') && decomposed) {
      return { phase, label, disabled: '本节点是拆分型,不走这个环节(它走集成验收)' }
    }
    if (phase === 'integrate' && !decomposed) {
      return { phase, label, disabled: '本节点没有子任务,不存在集成验收' }
    }
    return { phase, label }
  })
}

export interface RedoOption {
  entry: RedoEntry
  /** 归第一级的哪一条:整任务重来,还是从某个环节重来。 */
  scope: RedoScope
  /** 菜单里那一行。 */
  label: string
  /** 这一条**连带**会跑什么、会毁掉什么 —— 用户按下去之前就该看见。 */
  detail: string
  /** 不为空表示这一条在当前节点上不可用,内容就是原因。 */
  disabled?: string
}

export interface RedoPlan {
  nodes: TaskNode[]
  /** 被删掉的后代 id(仅 entry === 'plan' 且原来有子任务时非空)。 */
  deleted: string[]
  /** 被改写的依赖:某个**子树外**的节点原本依赖一个将被删除的节点。 */
  dependencyRewrites: { nodeId: string; from: string; to: string }[]
  /** 需要调用方去释放的隔离工作区(纯函数碰不了 git)。 */
  worktreesToRelease: { nodeId: string; branch: string; path: string }[]
  /** 目标节点被重置成了什么状态。 */
  seatedAt: NodeStatus
  /**
   * 被一并放回可推进状态的**祖先**。
   *
   * 不带出来的话确认屏没法说这件事,而它是这次重做真实成本的一部分:每个祖先都会
   * 再花一次集成验收的模型调用。
   */
  reopenedAncestors: string[]
  /** 必须说给用户听的话 —— 每一条都是这次重做**做不到**的事。 */
  warnings: string[]
}

/**
 * 重做后写进 execStatus 的注记 —— **按产出去哪儿了分两种**。
 *
 * 原来只有一句「上面描述的产出在当前工作区里不存在」,而它对 ACCEPTED 节点是**假的**:
 * 通过验收的那一刻 `mergeAndRelease` 已经把产出合进集成分支了,而重做后重新 acquire 的
 * 工作区正是基于集成分支 tip 建的 —— 文件就在那儿。执行者被告知要从零开始,却在树里
 * 找到自己上一轮的产出,要么重做一遍造成冲突,要么报告困惑。
 *
 * 而「已验收但你看了不满意」正是 README 把重做宣传出去的主用例。
 */
const REDO_NOTE_PREFIX = '(注:本节点被手工重做'
const REDO_NOTE_LOST = `${REDO_NOTE_PREFIX},隔离工作区已重置为集成分支最新状态;上面描述的产出**不在**当前工作区里)`
const REDO_NOTE_MERGED = `${REDO_NOTE_PREFIX},隔离工作区已重置为集成分支最新状态;上面描述的产出此前已通过验收并合入集成分支,所以在当前工作区里**能看到**它 —— 请在它之上继续改,不要从零重做)`

/**
 * 「这个节点是拆分型的吗」。
 *
 * 有子任务就是 —— 这条比 `kind` 可靠:`stepStart` 在评审之前就把 kind 写进节点,
 * 一个自称 executable 却被评审打回的节点,盘上留着的 kind 是 executable。
 */
function isDecomposed(n: TaskNode): boolean {
  return n.childIds.length > 0 || n.kind === 'decompose'
}

/** 这个节点有没有可评审的方案。空方案上重跑质疑讨论 = 让评审员对着空白发表意见。 */
function hasPlan(n: TaskNode): boolean {
  return `${n.plan?.solution ?? ''}${n.plan?.keyPoints ?? ''}${n.plan?.acceptance ?? ''}`.trim().length > 0
}

/**
 * 给一个节点,列出**全部七个环节**,不可用的带原因。
 *
 * 七条永远都在(菜单忽隐忽现时用户记不住「第三项」是哪一项),`scope` 决定它出现在哪一级:
 * `plan` 是第一级的「任务重做」,其余六条在第二级的「阶段重做」里。
 *
 * 这是**唯一**的授权判据 —— `planRedo` 也照它拒绝,所以屏幕上按不动的东西不可能从别的
 * 门进去。原来 planRedo 调它时不传 ctx,一旦 disabled 依赖席位数就会出现「屏幕禁用而
 * planRedo 放行」的两个真相源。
 */
export function redoOptions(
  node: TaskNode, byId: ReadonlyMap<string, TaskNode>, ctx?: RedoContext,
): RedoOption[] {
  const kids = descendantsOf(node, byId)
  const acceptedKids = kids.filter(id => byId.get(id)?.status === 'ACCEPTED').length
  const decomposed = isDecomposed(node)
  /** 这一条在本次配置下一个环节都不跑 —— 按下去什么都不会发生,那就不该能按下去。 */
  const runsNothing = (entry: RedoEntry): string | undefined => {
    if (redoChain(entry, node).length === 0) return undefined
    /**
     * **入口环节自己必须真的会跑。**
     *
     * 只看「整条链是不是空的」不够:跳过质疑讨论之后,「从质疑讨论重做」的链上还剩
     * 执行那一段 —— 链非空,条目可用,而用户按下去得到的是一次执行重做。
     * 条目叫什么名字,那个环节就必须发生。
     */
    if (!phaseRuns(entry, ctx)) return `本次配置跳过了${PHASE_LABEL[entry]},从这里重做不会发生它`
    if (phasesOf(entry, ctx, node).length === 0) return '本次配置下这一条不会跑任何环节'
    return undefined
  }

  const opts: RedoOption[] = [
    {
      entry: 'plan',
      scope: 'task',
      label: '任务重做',
      detail: node.childIds.length > 0
        // 数量必须写出来。这是整个功能里唯一一个不可逆的动作,而「重做」两个字听起来像
        // 是可逆的。
        ? `重新分析并拆分;先删除 ${kids.length} 个子任务(其中 ${acceptedKids} 个已验收)`
        // 「按现在的形态算」不是废话:重新分析之后这个节点可能改成拆分型,那时候跑的是
        // 集成验收而不是执行 —— 印一条确定的链是假确定。
        : `重新分析并拆分。按现在的形态算会跑:${phaseChainText('plan', ctx, node)}`,
      disabled: runsNothing('plan'),
    },
    {
      entry: 'review',
      scope: 'phase',
      label: '从「质疑讨论」重做',
      /**
       * **通过之后会继续往下跑**,这一条必须写在最前面。
       *
       * 第一版写的是「只重跑一次质疑讨论」,而 stepStart 的 reviewOnly 分支通过之后走的是
       * 普通路由:执行型节点 commit(READY) → 调度器分派 stepExecute。实测真实链条是
       * 质疑讨论 → 执行 → 测试验证 → 验收 → 观察 → 合并,而用户按的是菜单上最便宜那一条。
       */
      detail: `保留现有方案,先重跑一次质疑讨论;通过后继续跑:${phaseChainText('review', ctx, node)}。不通过则本节点阻断并附评审意见 —— 要按意见重出方案请用「任务重做」`,
      disabled: runsNothing('review')
        ?? (hasPlan(node) ? undefined : '本节点还没有方案,没有可评审的东西 —— 请用「任务重做」'),
    },
    {
      entry: 'execute',
      scope: 'phase',
      // 「它们是一个整体,分不开」原来挂在整句最后,排在「不跑:…」子句**后面**,
      // 读起来像在修饰测试验证;而且整句 91 列,80 列终端上折成两行。
      // 这个事实现在由测试验证/验收那两条的**不可用原因**说(「跑在执行环节内部」)——
      // 那正是用户会去找它的地方,而这一行因此短得下。
      detail: `方案保留;本次实际跑:${phaseChainText('execute', ctx, node)}`,
      label: '从「执行」重做',
      disabled: decomposed
        ? '这是拆分任务,它自己没有执行环节 —— 真正干活的是它的子任务'
        // kind 还是 unknown 时**不能**坐到 READY 上:advanceableKind 对 READY+unknown
        // 返回 null —— 节点既不可推进也不是终态,run 以「存在无法推进的阻断节点」结束,
        // 而节点上没有任何理由,--resume 每次原样复现。reseat.ts 逐字记过这个失败。
        // 可达路径不止一条:方案环节被阻断的节点,以及**刚做完任务重做**的节点
        // (那一条把 kind 重置成 unknown)。
        : node.kind === 'unknown'
          ? '本节点还没有方案,分析之后才知道它是拆分还是执行 —— 请用「任务重做」'
          : runsNothing('execute'),
    },
    {
      entry: 'integrate',
      scope: 'phase',
      label: '从「集成验收」重做',
      detail: '子任务全部保留,只重新裁决一次「合起来达没达成父目标」',
      disabled: node.childIds.length === 0
        ? '没有子任务,不存在集成验收'
        : runsNothing('integrate'),
    },
  ]
  /**
   * 不能单独重入的三个。留在屏幕上、按不动、并给出**能照做的下一步** —— 用户想重跑的
   * 那件事通常还是做得到的,只是入口在别处。
   *
   * 去处**必须看节点形态**:第一版无条件写「请选『从执行重做』」,而拆分任务上那一条
   * 本身就是禁用的 —— 用户被指到一行按不动的字上。拆分任务自己不跑测试验证/验收,
   * 它的裁决是集成验收。
   */
  for (const p of ['verify', 'accept', 'observer'] as const) {
    opts.push({
      entry: p, scope: 'phase', label: `从「${PHASE_LABEL[p]}」重做`,
      detail: '', disabled: entryBlockedReason(p, decomposed, ctx),
    })
  }
  // 按环节顺序排,和 PHASE_NAMES 一致 —— 屏幕上的次序和用户在别处(名册、跳过设置、
  // 节点详情的环节耗时)看到的次序必须是同一个。
  return opts.sort((a, b) => PHASE_NAMES.indexOf(a.entry) - PHASE_NAMES.indexOf(b.entry))
}

/**
 * `from` 是不是(传递地)依赖 `to`。
 *
 * 用来挡住一种**重做才会造出来的**死锁:依赖改写把「指向被删子节点」的边一律改指到
 * 目标节点,而如果目标节点本身(传递地)依赖那个下游节点,改写后两边互指,pickBatch
 * 从此返回空 —— 重做**之前**那个下游节点是能跑的。屏幕上只会说「1 条依赖被改写为
 * 指向本节点」,不会说这一改把树锁死了。
 */
function dependsOn(from: string, to: string, byId: ReadonlyMap<string, TaskNode>): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = byId.get(id)
    if (!n) continue
    for (const d of n.deps) {
      if (d === to) return true
      stack.push(d)
    }
  }
  return false
}

/**
 * 「这一次重做会让执行者重跑」时要做的重置:留下注记、放掉工作区。
 *
 * 两条入口共用 —— `execute` 显然要,`review` 在**执行型**节点上也要(评审通过之后
 * stepStart 就把它交给 stepExecute 了)。各写一份的话,少写的那一条就是「执行者在一棵
 * 已经有产出的树上从零重做」。
 */
function resetForExecute(
  target: TaskNode, worktreesToRelease: { nodeId: string; branch: string; path: string }[],
): void {
  if (target.execStatus.length > 0 && !target.execStatus.includes(REDO_NOTE_PREFIX)) {
    // 和 reseat 的 RETRY_NOTE 同因:工作区会被重置回集成分支基线,而 execStatus 里
    // 写着「我实现了 feature.ts」。不加这句,执行者要么去找一个已经不在那儿的文件,
    // 要么把一份已经在那儿的产出从零再做一遍。**判据是重做前的 status** ——
    // 这一段跑在 `target.status = seatedAt` 之前。
    target.execStatus = `${target.execStatus}\n${target.status === 'ACCEPTED' ? REDO_NOTE_MERGED : REDO_NOTE_LOST}`
  }
  if (target.worktree) {
    worktreesToRelease.push({ nodeId: target.id, branch: target.worktree.branch, path: target.worktree.path })
    target.worktree = undefined
  }
}

/** 目标节点的全部后代,深度优先。 */
export function descendantsOf(node: TaskNode, byId: ReadonlyMap<string, TaskNode>): string[] {
  // 只收**真实存在**的后代。childIds 是可手工编辑的,指向不存在节点的条目原来也被计进
  // `deleted`,于是第一屏那句「删除 N 个子任务」比实际大 —— 而这个数字正是用户判断
  // 这次不可逆操作值不值得的依据。
  const out: string[] = []
  const stack = [...node.childIds]
  // 环保护:盘上的 childIds 是可手工编辑的,一个自指的 childIds 会让这里死循环 ——
  // 而这个函数跑在按键处理里,死循环 = 终端整个卡死。
  const seen = new Set<string>([node.id])
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const child = byId.get(id)
    if (!child) continue
    out.push(id)
    stack.push(...child.childIds)
  }
  return out
}

/**
 * propagateBlocked 写在**别人**身上的三种阻断理由。
 *
 * 和 reseat 里那份是同一份,原因也一样:它们都不是对该节点自身的判决,而是「你上面/
 * 下面/依赖的东西挂了」。不清掉的话,被重做的节点上面那条链仍然是 BLOCKED,而调度器
 * 拒绝挑选任何祖先被阻断的节点 —— 重做完全无效,一次模型调用都不会发生。
 * 这在 reseat 里是实测过的失败,不是推理。
 */
const PROPAGATED: ReadonlySet<string> = new Set(['子节点阻断', '上级任务阻断', '依赖阻断'])

/**
 * 盘上结构本身坏了的那几种阻断。**这几种不能重开** —— 它们不是「某个环节失败了」,
 * 是「这棵树自己对不上」。重开只会让一批上游无法核实的工作跑起来,而运行报告成功。
 * `--retry-blocked` 出于同样的理由拒绝复活它们。
 */
const STRUCTURAL = ['依赖节点缺失', '子节点缺失', '依赖成环'] as const
const isStructural = (reason: string): boolean => STRUCTURAL.some(k => reason.includes(k))

/**
 * 把一个**祖先**放回可推进的状态。
 *
 * 原来这里只解开「被牵连」的三种阻断(PROPAGATED)。那漏掉了最常见的一种祖先:
 * **ACCEPTED**。而漏掉它的后果是这个功能在最常见的场景下整个失效 ——
 *
 * `orchestrator.run()` 的**第一句**是 `if (root.status === 'ACCEPTED') return completed`。
 * 一个跑成功的 run,root 必然是 ACCEPTED。于是用户在「✓ 高效任务完成」那一屏上重做
 * 任何非 root 节点:commitRedo 已经把子树从盘上删了,而重启的编排器在第一个循环里
 * 直接返回,**模型调用 0 次**,界面闪一下回到同一屏。他什么都没得到,还少了一批记录,
 * 而且 --resume / --retry-blocked 都救不回来(它们只碰 BLOCKED 节点)。实测过。
 *
 * 退回 WAITING_CHILDREN 同时**是语义上对的**:祖先那句「子任务合起来达没达成父目标」
 * 的裁决是对**旧产出**下的。子任务重做之后它不再成立,本来就该重判一次 —— 不重判的话
 * 树上写着已验收,而验收的是别的东西。
 *
 * 预算也要给回去:集成预算已经花完的祖先一被重开就会立刻再耗尽,那等于没重开。
 */
function reopenAncestor(n: TaskNode, now: string): boolean {
  const wasBlocked = n.status === 'BLOCKED'
  if (wasBlocked && isStructural(n.blockedReason)) return false
  // 已经在可推进状态上就别动它 —— 尤其别把预算清了。
  if (!wasBlocked && n.status !== 'ACCEPTED') return false
  n.status = n.childIds.length > 0 ? 'WAITING_CHILDREN' : n.kind === 'executable' ? 'READY' : 'CREATED'
  n.blockedReason = ''
  n.interrupted = false
  // 同 reopenPropagatedNode:祖先重开了,「被点名取消过」的标记不该跨过这一次重开。
  n.cancelled = false
  n.capBlocked = false
  n.capCategory = undefined
  /**
   * 失败点跟着清 —— 和上面那三个开关**逐字同因**,而它原来漏了。
   *
   * 评审实跑出来的 P0:root 真在集成验收超限 → 用户在某个子任务上按 R(完全合理)→
   * root 被重开而 `failedAt='INTEGRATION_ACCEPT'` 留着 → 那个子任务又挂 →
   * `propagateBlocked` 写「子节点阻断」而失败点仍是旧的 → **`s` 在 root 上放行**
   * (本该说「这个节点是因为它的子任务失败才停的」)→ 落下 `skipPhase='integrate'` →
   * 用户后来修好子任务 → 整棵树的最终裁决**一次都没发生**,acceptLog 空,run 报 completed。
   */
  n.failedAt = undefined
  // 这一轮它要重判的是集成验收,所以给回集成和评分的预算;方案/验收预算不动 ——
  // 这次重做没打算让祖先重新分析。
  n.iteration = { ...n.iteration, integration: 0, scoring: 0 }
  n.startedAt = undefined
  // 和 startedAt 成对:重开 = 还没有结论。
  n.finishedAt = undefined
  n.updatedAt = now
  return true
}

/**
 * 一个被牵连的节点该回到哪个状态。
 *
 * **`READY` 有一道额外的闸门:方案得真的被放行过。** `stepStart` 在评审圆桌**之前**就把
 * `node.kind` 写成 `'executable'`(评审是为了打回它),所以一个「方案三次被否」或者
 * 「跳过质疑讨论后坐回 CREATED」的节点身上,kind 已经是 executable 了。把它放到 READY,
 * `advanceableKind` 直接判 `'execute'` —— 带写工具的执行者去跑一份**没有任何评审员看过**
 * 的方案,`reviewLog` 为 0。这条是 `reseat.ts` 实测记下来的失败(它在那边有自己的写法),
 * 而不动点把作用面从「直接依赖重做目标的节点」扩到了**全树每一个被牵连的 BLOCKED 节点**,
 * 所以这里必须一起判。
 *
 * 判据是**结构性**的,而且要**三条一起看** —— 只看 `reviewLog` 会把一类正常节点也打回去:
 *  - `reviewLog` 有一轮真的通过过(`pipeline` 里那是唯一写入点);
 *  - 或者它已经**执行过**(`execStatus` 非空)—— 那说明它当时就是从这道门里出来的。
 *    质疑讨论可以被整个 run 跳过(`skipSteps`)或被 `s` 跳过一次,那种节点的 `reviewLog`
 *    是空的,而它确确实实干过一轮活;
 *  - 或者验收开过会(`acceptLog` 非空),同理。
 *
 * 三条都不成立就回 `CREATED` 重新分析 —— 多花一次分析调用,换掉「一份没人看过的方案
 * 被带写工具的执行者跑掉」。
 */
function seatForPropagated(n: TaskNode): NodeStatus {
  if (n.childIds.length > 0) return 'WAITING_CHILDREN'
  const pastPlanGate = n.reviewLog.some(r => r.synthesized?.pass === true)
    || n.execStatus.trim() !== ''
    || n.acceptLog.length > 0
  return n.kind === 'executable' && pastPlanGate ? 'READY' : 'CREATED'
}

/**
 * 把一个**被牵连**的节点放回可推进状态。不碰人家自己的判决,也不碰已验收的。
 *
 * 清哪几个字段和 `reopenAncestor` 逐字对齐,因为漏掉任何一个都实测过后果:
 *  - `failedAt`:过期的失败点会让 `R`/`s` 在一个「其实是别人挂了」的节点上放行,
 *    而落下的一次性标记很久以后才生效;
 *  - `interrupted`:`propagateBlocked` 的非中止那条路**不清**它,所以一个上一轮被 Esc
 *    扫过、这一轮被牵连的节点会带着它回来;
 *  - `capBlocked`/`capCategory`:带着它们的节点会让阻断卡给出一条不对症的补救建议;
 *  - `startedAt`:它只在首个活动阶段盖一次、之后永不重盖,而面板对非终态节点用**现在**
 *    收尾。一个两天前被牵连阻断的节点重开之后,树上那一行会当场显示 `172800s` 并每秒往上跳
 *    (这条 bug 仓库已经付过两次学费)。
 *
 * **不动 `iteration` 预算**,和 `reopenAncestor` 不同 —— 那一处退的是「目标自己那条链」,
 * 用户按下重做就意味着要重判它们;而这里是全树被牵连的节点,预算真的花完的那个会带着
 * 自己的 `cap-iteration` 理由再阻断一次,那是诚实的,而且 `--retry-blocked` 认它。
 * `mergeConflict` 同理不动:那是一条还等着人去解的冲突,清掉它等于谎报冲突没了。
 */
function reopenPropagatedNode(n: TaskNode, now: string): void {
  /**
   * 一次性的手工标记**不许跨过一次阻断活下来**。
   *
   * 这条规矩不是新的:`blockWithReason` 对**节点自己的**每一次失败都清 `skipPhase`,
   * 理由记在那里(评审实跑出来的 P0:按 s 跳过验收 → 打回 → 中断 → 恢复后
   * `enterAtJudge` 再一次为真 → 执行环节一次都不跑,半成品被判「已验收」)。
   * 而被牵连的阻断走的是 `propagateBlocked`,**不经过** blockWithReason —— 于是这三个
   * 标记会原样活到下一次重开:一个带着 `redoFrom='review'` 被恢复到 CREATED 的节点会
   * 跳过分析,而屏幕上什么都没说。
   *
   * **严格度档位刻意不在此列** —— 这是上面那条规矩的**镜像**,值得单写一句给下一个照着
   * 这三行改代码的人:档位是 run 级的**持续**状态(存在 `RunControl` 上,不是节点上),
   * 顺手清掉它会让「用户降到初级 → 看着半成品被放行 → 按 r 重做」拿到又一次不设档的
   * 结果。`control.clearAllForcePasses` 旁边有对称的一句。
   */
  n.skipPhase = undefined
  n.forcePass = undefined
  n.redoFrom = undefined
  n.status = seatForPropagated(n)
  n.blockedReason = ''
  n.failedAt = undefined
  n.interrupted = false
  // 它是被连带放开的,那个「被点名取消过」的标记到此为止 —— 留着的话,它下一次
  // 因为别的原因阻断时会被误当成「用户不想跑它」。
  n.cancelled = false
  n.capBlocked = false
  n.capCategory = undefined
  n.startedAt = undefined
  n.finishedAt = undefined
  n.updatedAt = now
}

/**
 * 把**所有**被牵连的阻断一次解开 —— 多级依赖、被牵连节点的子树、以及在等它们的那些。
 *
 * 用户报的现象:「某个任务失败掉,其依赖任务变成失败,包括多级依赖。但是将这个任务恢复
 * 重做,其多级依赖任务还是失败状态。」
 *
 * ## 为什么必须换算法,而不是把那个一级循环改成 while
 *
 * 阻断是**不动点**扫出来的(`orchestrator.propagateBlocked`:父阻断 / 子阻断 / 依赖阻断
 * 三个方向反复扫到稳定),而恢复原来只有一句「谁的 deps 里有 target 就解开谁」——
 * 于是 A←B←C 里的 C、以及 B 的子树和 B 的父节点全部留在 BLOCKED,而调度器拒绝挑选任何
 * 祖先被阻断的节点。重做完之后一次模型调用都不会发生。
 *
 * 而**「把现有阻断集合往回侵蚀」是错的**,这条评审用脚本跑过:`parentBlocked` 和
 * `childBlocked` 是互为逆命题的一对,只要链上出现任何一组父子,两者互相支撑 —— 第一轮
 * 就没有任何节点满足释放条件,`reopened` 是空的。一棵「依赖任务被拆过子任务」的树
 * (这个功能的常态)因此完全恢复不了。
 *
 * ## 正确的判据:从**真失败**的种子重算一遍死亡集合
 *
 *  1. 种子 = 还 BLOCKED 且理由**不是**被牵连的那三种(它自己的判决 / 结构性 / 已中断),
 *     以及依赖或子节点已经不在盘上的(那种永远推不动);
 *  2. 沿三条边扩散,**但只标记此刻仍然 BLOCKED 的节点**:父→子、依赖→依赖方、子→父。
 *     「只标 BLOCKED」这一条是关键 —— 重做目标和它的祖先链在这之前已经被
 *     `reseatForRerun`/`reopenAncestor` 放开了,扩散到那里就停住,不会顺着 root 淹掉全树;
 *  3. 剩下的「BLOCKED + 被牵连 + 不在死亡集合里」全部放开。
 *
 * 于是:上游还真的挂着的那些**继续挡住**下游(评审最容易写错的另一半),而一个孩子真死了
 * 的父节点、以及它下面被牵连的兄弟仍然留红 —— 它们此刻确实推不动,把它们放开只会白烧调用。
 *
 * @returns 被放开的节点 id(按 byId 的顺序)
 */
export function reopenPropagatedBlocks(
  byId: ReadonlyMap<string, TaskNode>,
  now: string,
  /**
   * 把**被中断**的节点也算成「被牵连」(默认不算)。
   *
   * ## 为什么这是重做必须打开、恢复必须关掉的一个开关
   *
   * 用户报的现象:「之前任务在运行,取消掉后,重做其父任务,依赖任务的状态没有更新过来」。
   * 病根是 `propagateBlocked(aborted)` —— 一次 Esc / Ctrl+C / 关掉视图,会把**每一个**
   * 非终态节点扫成 `BLOCKED` + `interrupted: true` + 理由「已中断」。而「已中断」不在
   * `PROPAGATED` 那三个理由里,于是重做时它们被当成**真失败的种子**:不但自己不放开,
   * 还会顺着父/子/依赖三条边把死亡集合扩散出去,把本来该放开的下游一起摁住。
   * 结果就是他看到的那句:重做完了,依赖它的那些任务还红着,一次模型调用都不会发生。
   *
   * 中断**不是对任何节点的判决**,这一点 `reseat.ts` 早就承认了(`--resume` 重开的正是
   * 这一批)。差别只在于:`--resume` 有一套自己的、更细的归位规则(按被杀时的阶段选座位、
   * 预算耗尽的先挡下来、补一行「上次运行在 X 中断」的注记),所以那条路**不能**从这里
   * 顺手把它们放开 —— 那会让节点跳过它自己的归位逻辑(实测:被放开之后 `ACTIVE.has(status)`
   * 和 `wasInterrupted` 双双为假,reseat 的循环直接 `continue` 跳过它)。
   *
   * 而重做没有那套规则,也不需要:它要的就是「把这棵树重新变得能跑」。
   *
   * **用户点名取消的那一个不在此列**(`cancelled`),那是一个决定,不是一次意外 ——
   * 见 TaskNode.cancelled。
   */
  opts: { includeInterrupted?: boolean } = {},
): string[] {
  const blocked = [...byId.values()].filter(n => n.status === 'BLOCKED')
  /**
   * 这一条阻断是**别人的失败**溅到它身上的吗。
   *
   * 两个来源:`propagateBlocked` 写的那三种理由,以及(只在重做那条路上)整个 run 被中断
   * 时的那一扫。结构性损坏永远不算 —— 那是盘上的树自己对不上,重开只会让一批上游无法
   * 核实的工作跑起来。
   */
  const isCollateral = (n: TaskNode): boolean => {
    if (isStructural(n.blockedReason)) return false
    if (PROPAGATED.has(n.blockedReason)) return true
    if (opts.includeInterrupted !== true || n.interrupted !== true || n.cancelled === true) return false
    /**
     * **`interrupted` 不等于「被中止扫到」。**
     *
     * 评审实测出来的 P1:`blockWithReason` 写的是 `interrupted = keepInterrupted ||
     * ctx.signal.aborted` —— 也就是说,中止那一刻**自己真失败**的节点(编译不过、预算
     * 耗尽)同样带着 `interrupted: true`。只看这个布尔的话,用户重做 B,系统会顺手把
     * 一个「执行失败: 编译不过」的 A 也放回队列,并把它的 `blockedReason` / `failedAt` /
     * `capBlocked` 一起抹掉 —— 证据没了,钱照烧,屏幕上只有一句「连带恢复了 N 个」。
     *
     * 判据用 `failedAt` 和 `capBlocked`,**不是理由文本**:
     *  - `commit()` 对**节点自己的**每一次失败都记 `failedAt`(它是唯一还看得见上一个
     *    状态的地方);
     *  - 而 `propagateBlocked` 的中止扫描**显式**把 `failedAt` 清成 undefined
     *    (那条路上还写着「这不是这个节点的失败」);
     *  - `capBlocked` 则是安全阀停下的那一类,同样是一次判决。
     *
     * 所以「被中止扫到」= 中断标记在、而它自己没有失败点、也没有触阀。两个字段都是
     * 结构化的、两个方向都写、都有读回校验 —— 比一个共享的中文串可靠得多。
     */
    return n.failedAt === undefined && n.capBlocked !== true
  }
  /** 盘上引用不全的节点永远推不动 —— 当种子,不当候选。 */
  const dangling = (n: TaskNode): boolean =>
    n.deps.some(id => !byId.has(id)) || n.childIds.some(id => !byId.has(id))
  const dead = new Set<string>()
  const stack: TaskNode[] = []
  const kill = (m: TaskNode | undefined): void => {
    // **只吃 BLOCKED**。见上面第 2 条:这一句就是「不淹掉全树」的全部理由。
    if (!m || m.status !== 'BLOCKED' || dead.has(m.id)) return
    dead.add(m.id)
    stack.push(m)
  }
  /** 谁在依赖它。只在 BLOCKED 里建索引 —— 别的节点不参与扩散。 */
  const dependents = new Map<string, TaskNode[]>()
  for (const n of blocked) {
    for (const d of n.deps) {
      const arr = dependents.get(d)
      if (arr) arr.push(n)
      else dependents.set(d, [n])
    }
  }
  for (const n of blocked) {
    if (!isCollateral(n) || dangling(n)) kill(n)
  }
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const id of cur.childIds) kill(byId.get(id))
    for (const m of dependents.get(cur.id) ?? []) kill(m)
    if (cur.parentId !== null) kill(byId.get(cur.parentId))
  }
  const reopened: string[] = []
  for (const n of blocked) {
    if (dead.has(n.id) || !isCollateral(n)) continue
    reopenPropagatedNode(n, now)
    reopened.push(n.id)
  }
  return reopened
}

/**
 * 还有几个节点是**被一个「用户点名取消」的上游摁住**的。
 *
 * 验收报的:P1 被取消之后重做另一个节点 T,`P` 的父节点、以及依赖 P 的 Q 仍然留红,
 * 而它们的阻断原因写的是「已中断」—— 语义上说得通(Q 本来也推不动),但屏幕上没有
 * 任何东西把这件事和「你取消过 P1」联系起来,用户很可能照着同一个现象再报一次。
 *
 * 所以数出来、在重做摘要里说一句。**只数,不改任何节点**:改写它们的阻断原因会让
 * 那条理由离开 `PROPAGATED` 那个集合,而下一次重做会把它们当成真失败的种子 ——
 * 一个显示问题换来一个状态问题,不划算。
 */
export function heldByCancelledCount(byId: ReadonlyMap<string, TaskNode>): number {
  const cancelled = [...byId.values()].filter(n => n.status === 'BLOCKED' && n.cancelled === true)
  if (cancelled.length === 0) return 0
  /** 谁在依赖它 —— 和不动点那边同一个方向。 */
  const dependents = new Map<string, TaskNode[]>()
  for (const n of byId.values()) {
    for (const d of n.deps) {
      const arr = dependents.get(d)
      if (arr) arr.push(n)
      else dependents.set(d, [n])
    }
  }
  const seen = new Set(cancelled.map(n => n.id))
  const stack = [...cancelled]
  let held = 0
  while (stack.length > 0) {
    const cur = stack.pop()!
    // 沿三条边扩散,和 propagateBlocked 的方向一致:父←子、子←父、依赖方←依赖。
    const next = [
      ...(cur.parentId !== null ? [byId.get(cur.parentId)] : []),
      ...cur.childIds.map(id => byId.get(id)),
      ...(dependents.get(cur.id) ?? []),
    ]
    for (const m of next) {
      if (!m || seen.has(m.id) || m.status !== 'BLOCKED') continue
      seen.add(m.id)
      held++
      stack.push(m)
    }
  }
  return held
}

/**
 * 把目标节点放回座位上,并把它**上面那条链**和在等它的兄弟一起解开。
 *
 * 重做和跳过共用 —— 两者在这一段上逐字相同,而漏掉其中任何一行的后果都是「操作完了
 * 一次模型调用都不会发生」:
 *  - 不清 `blockedReason` / `capBlocked`:`--retry-blocked` 之后的语义全错;
 *  - 不清 `startedAt`:面板照着它算出「172800 秒」(跨过了终端关闭的那整段时间);
 *  - 不解开祖先:调度器拒绝挑选任何祖先被阻断/已终结的节点(reseat.ts 实测过),
 *    而一个跑成功的 run 里 root 必然是 ACCEPTED —— `orchestrator.run()` 的第一句就返回。
 *
 * @returns 被一并放回可推进状态的祖先 id
 */
function reseatForRerun(
  target: TaskNode,
  byId: ReadonlyMap<string, TaskNode>,
  opts: {
    seatedAt: NodeStatus
    now: string
    warnings: string[]
    redoFrom: PhaseName | undefined
    skipPhase: PhaseName | undefined
    /** 强制通过的那个环节。和 `skipPhase` 互斥 —— 见 planPastFailedPhase 的调用点。 */
    forcePass?: PhaseName | undefined
  },
): string[] {
  target.redoFrom = opts.redoFrom
  target.skipPhase = opts.skipPhase
  /**
   * **无条件写**(包括写 undefined),不是 `if (opts.forcePass)`。
   *
   * 这个函数是所有重入路径的必经点,而它的职责之一就是把上一次的痕迹清干净 ——
   * `failedAt` / `capBlocked` / `blockedReason` 都在下面几行被无条件清掉,同因。
   * 条件写的话,一个被强制通过过、后来又走普通重做的节点会带着旧的 forcePass 回来,
   * 于是「重做一遍看看」变成「重做一遍然后再放行一次」,而屏幕上什么都没说。
   */
  target.forcePass = opts.forcePass
  target.status = opts.seatedAt
  target.blockedReason = ''
  target.interrupted = false
  target.capBlocked = false
  target.capCategory = undefined
  target.mergeConflict = false
  // 取消标记跟着清:用户按 r 就是改主意了,而留着它会让这个节点在**下一次**重做时
  // 被当成「他决定不跑的那一个」而摁住。和 failedAt / capBlocked 同规矩,无条件写。
  target.cancelled = false
  // 失败点跟着清:它说的是「上一次是在哪一步倒下的」,而这个节点此刻正要重新起跑。
  // 留着的话,一个重跑后因为**别的**原因(比如子节点阻断)停下的节点会带着旧失败点,
  // 而快捷键会照它提供一个错的动作。commit() 也会清,这里是让纯函数的返回值就已经是对的。
  target.failedAt = undefined
  target.startedAt = undefined
  target.finishedAt = undefined
  target.updatedAt = opts.now
  const reopened: string[] = []
  let p = target.parentId === null ? undefined : byId.get(target.parentId)
  const guard = new Set<string>([target.id])
  while (p && !guard.has(p.id)) {
    guard.add(p.id)
    if (reopenAncestor(p, opts.now)) reopened.push(p.id)
    p = p.parentId === null ? undefined : byId.get(p.parentId)
  }
  if (reopened.length > 0) {
    opts.warnings.push(
      `上级的 ${reopened.length} 个任务会重新做一次集成验收 —— ` +
      `它们原来那句「子任务合起来达成了父目标」判的是旧产出`,
    )
  }
  /**
   * **排在祖先之后**。不动点只扩散「此刻仍然 BLOCKED」的节点,而 target 和它的祖先链
   * 刚刚在上面被放开 —— 顺序反过来的话,第一轮扫描时 target 还是 BLOCKED,依赖它的
   * 那一批会被「上游还挂着」挡住,而这正是用户报的那个现象。
   */
  /**
   * `includeInterrupted: true` —— 重做要连带放开**被中断**的那一批。
   *
   * 用户报的场景就是这个:任务在跑、他取消掉(或者按 Esc 中止整个 run)、再重做父任务。
   * 一次中止会把每一个非活动节点扫成 `BLOCKED + interrupted + 理由「已中断」`,而那个
   * 理由不在 PROPAGATED 里 —— 于是它们被当成真失败的种子,连带把下游一起摁死:
   * 重做完成之后,依赖任务还红着,一次模型调用都不会发生。见那个参数自己的注释。
   */
  const cascaded = reopenPropagatedBlocks(byId, opts.now, { includeInterrupted: true })
  if (cascaded.length > 0) {
    // 说出来:多级恢复是用户看不见的连带效果。一句话,而且**不带 id 清单** ——
    // 这一屏本来就在跟高度打架(见 redoSummary 的注释),一行 12 个 id 会把别的警告挤掉。
    opts.warnings.push(`连带恢复了 ${cascaded.length} 个被牵连阻断/被中断的任务(依赖链上的下游及其子树)`)
  }
  /**
   * 还留红的那些里,有多少是被一个**你自己取消过**的节点摁着的。
   *
   * 不说的话,用户看到的是「重做完了,还有一批任务红着」—— 而那正是他上一次报障的
   * 那句话。说清楚之后他知道下一步该按在哪个节点上(见 heldByCancelledCount)。
   */
  const held = heldByCancelledCount(byId)
  if (held > 0) {
    opts.warnings.push(`另有 ${held} 个任务仍被阻断:它们的上游有你**取消过**的任务 —— 想让它们跑起来,要先重做那个被取消的节点`)
  }
  return reopened
}

/**
 * 计算一次重做。**纯函数**:不碰盘、不碰 git、不改传进来的数组。
 *
 * 返回的 `nodes` 是一份新数组,里面的节点对象也是新的 —— 调用方拿到的是「重做之后的树
 * 应该长什么样」,由它决定落盘、删文件、放工作区。这样做的直接好处是关口可以先把
 * `deleted` / `dependencyRewrites` / `warnings` 渲染给用户看,再决定要不要真的执行。
 */
export function planRedo(
  input: readonly TaskNode[],
  targetId: string,
  entry: RedoEntry,
  now: string,
  // 和菜单**同一份** ctx。不传的话「屏幕上禁用、planRedo 放行」就成立了 ——
  // 一旦 disabled 依赖席位数(测试验证/观察就是这么判的),两条路会给出不同的答案。
  ctx?: RedoContext,
): RedoPlan | { error: string } {
  const nodes = input.map(n => structuredClone(n) as TaskNode)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { error: `节点不存在: ${targetId}` }

  const opt = redoOptions(target, byId, ctx).find(o => o.entry === entry)
  if (!opt) return { error: `未知的重做入口: ${entry}` }
  if (opt.disabled) return { error: opt.disabled }

  const warnings: string[] = []
  const worktreesToRelease: { nodeId: string; branch: string; path: string }[] = []
  const dependencyRewrites: { nodeId: string; from: string; to: string }[] = []
  const reopenedAncestors: string[] = []
  const cycleAvoided: string[] = []
  let deleted: string[] = []

  // ---- 三个入口各自的重置 ----
  let seatedAt: NodeStatus
  if (entry === 'plan') {
    // 排序过再用。descendantsOf 是深度优先 + 栈,吐出来是 LIFO —— 8 个子任务时
    // 确认屏上印的是 07..02,而用户最先认得的 00/01 恰好被截掉了。清单只印前 6 个,
    // 所以**印哪 6 个**必须是可预测的。id 本身就带序号(NN-slug),字典序即建立顺序。
    deleted = descendantsOf(target, byId).sort()
    const deletedSet = new Set(deleted)
    /**
     * 判据是 **ACCEPTED 本身**,不是「还挂着 worktree」。
     *
     * 原来写的是 `status === 'ACCEPTED' && d.worktree !== undefined`,方向是**反的**:
     * 干净合并之后 stepExecute 会把 node.worktree 置回 undefined,而 --resume 每次也清它。
     * 于是这条警告只在「release 拒绝删的脏工作区」时出现 —— 那恰恰是**没有**干净合并
     * 的那一类;真正已经落进代码的那些反而一句提示都没有。再走一次 resume 连仅有的
     * 那条也没了。实测过。
     *
     * ACCEPTED 就意味着产出已经落进代码:有隔离时是 mergeAndRelease 合进集成分支,
     * 没隔离时是直接写在用户的工作区里。两种都不会因为删掉一条任务记录而回滚。
     */
    const mergedAway = deleted.filter(id => byId.get(id)?.status === 'ACCEPTED')
    for (const id of deleted) {
      const d = byId.get(id)
      if (d?.worktree) worktreesToRelease.push({ nodeId: id, branch: d.worktree.branch, path: d.worktree.path })
      /**
       * **被删子树的账要认。**
       *
       * 节点从内存和磁盘上一起消失,而 `runUsage` 是逐个累加还活着的节点 —— 验收实测
       * 一次任务重做让表头那个总数当场掉了 83%,而 README 承诺的是「重做不清零,
       * 钱花掉了就是花掉了」。数字当着用户的面倒退,而少报的**正好是被丢弃的那部分工作**
       * —— 也正是他按下 `r` 的那一刻最想知道的数。
       *
       * 记在**重做目标**身上,而不是 run 级别的某个桶:节点跟着 `commit()` 一起落盘,
       * `--resume` 白拿;而 run.md 那边要新开一个字段、一条读回校验、一条迁移。
       */
      if (d?.usage) target.discardedUsage = addUsage(target.discardedUsage, d.usage)
      if (d?.discardedUsage) target.discardedUsage = addUsage(target.discardedUsage, d.discardedUsage)
      byId.delete(id)
    }
    if (mergedAway.length > 0) {
      // 说清楚,因为它听起来应该被撤销而实际不会:每个执行型子节点是在**自己通过验收时**
      // 就合进集成分支的(stepExecute 里的 mergeAndRelease),删节点删的是任务记录,
      // 不是已经落进 git 的提交。
      warnings.push(
        `${mergedAway.length} 个已验收子任务的代码**已经落进代码**(有隔离时已合进集成分支,` +
        `没隔离时就在你的工作区里),删除任务不会回滚这些改动;新方案要么在它们之上继续,` +
        `要么你先自己 revert`,
      )
    }
    // 依赖修订。子树外面还指着被删节点的,改指到目标节点本身 —— 那才是接下来会产出
    // 等价成果的东西。直接删掉依赖会让下游提前起跑,拿到一棵还没建起来的子树。
    for (const n of byId.values()) {
      if (n.deps.length === 0) continue
      const next: string[] = []
      // 去重后再逐条处理。`deps: [a, a]` 原来会记成两条改写,屏幕上说「2 条依赖被改写」
      // 而实际只有一条 —— 计数是用户唯一能核对这次操作规模的东西。
      const uniqueDeps = [...new Set(n.deps)]
      for (const d of uniqueDeps) {
        if (!deletedSet.has(d)) { if (!next.includes(d)) next.push(d); continue }
        // 自依赖是死锁,不是依赖 —— 目标节点自己曾经依赖过某个后代时会撞上。
        if (n.id === targetId) { dependencyRewrites.push({ nodeId: n.id, from: d, to: '(已移除)' }); continue }
        // 改指之前先问:目标节点会不会反过来(传递地)依赖 n?会的话这一改就是
        // 一个重做前不存在的环。宁可丢掉这条依赖 —— 下游可能提前起跑,但整棵树
        // 至少还在动;成环的话 pickBatch 直接返回空,运行就死在那儿。
        if (dependsOn(targetId, n.id, byId)) {
          dependencyRewrites.push({ nodeId: n.id, from: d, to: '(已移除:改指会成环)' })
          cycleAvoided.push(n.id)
          continue
        }
        dependencyRewrites.push({ nodeId: n.id, from: d, to: targetId })
        if (!next.includes(targetId)) next.push(targetId)
      }
      if (next.length !== n.deps.length || next.some((d, i) => d !== n.deps[i])) {
        n.deps = next
        n.updatedAt = now
      }
    }

    if (cycleAvoided.length > 0) {
      warnings.push(
        `${cycleAvoided.length} 条依赖被**删掉**而不是改指:改指会和本节点自己的依赖成环。` +
        `这些节点可能比预期更早起跑`,
      )
    }
    target.childIds = []
    // 回到 unknown,让 stepStart 重新判定拆分还是执行 —— 保留旧 kind 的话,一个原本
    // 拆分型的节点会被 advanceableKind 当成执行型直接交给带写工具的执行者。
    target.kind = 'unknown'
    // 上一轮**确认过的**子任务清单。不清的话重新拆分会照抄它,重做就成了空转。
    target.confirmedDraft = undefined
    // 补救拆分的一次性额度,重做后应该重新给。
    target.revised = undefined
    target.iteration = { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 }
    if (target.worktree) {
      worktreesToRelease.push({ nodeId: target.id, branch: target.worktree.branch, path: target.worktree.path })
      target.worktree = undefined
    }
    seatedAt = 'CREATED'
  } else if (entry === 'review') {
    /**
     * 先重跑一次质疑讨论。方案和子任务一律不动。
     *
     * 座位是 CREATED(`advanceableKind` 只在 CREATED 上返回 'start'),真正让它跳过分析的
     * 是 `redoFrom`,由 stepStart 在第一轮消费掉。
     *
     * **执行型节点要连带做执行重做的那套重置。** stepStart 的 reviewOnly 分支通过之后走的
     * 是普通路由:`commit(READY)` → 调度器分派 stepExecute → 工作区被重新 acquire、
     * 执行者重跑。不做这一步的话 execStatus 里还写着「我实现了 feature.ts」而没有任何
     * 重做注记,执行者会在一棵已经有产出的树上从零重做 —— 那正是 REDO_NOTE 存在的理由。
     * 拆分型节点通过后是 WAITING_CHILDREN → 集成验收,不碰代码,所以不做。
     */
    target.iteration = { ...target.iteration, planReview: 0 }
    // 上一轮启动关口批准过的首层拆分。留着它 stepStart 会拿它当「已确认方案」再走一遍,
    // 而用户这次要的是重新评审**现在这份**方案。
    target.confirmedDraft = undefined
    if (!isDecomposed(target)) resetForExecute(target, worktreesToRelease)
    seatedAt = 'CREATED'
  } else if (entry === 'execute') {
    // acceptLog **保留**。它是上一轮验收说了什么的唯一记录,而返工提示词正是拿它当
    // 反馈的 —— 清掉等于让执行者从零开始猜,那是提高恢复成本,不是降低。
    target.iteration = { ...target.iteration, acceptance: 0, scoring: 0, mergeResolve: 0 }
    resetForExecute(target, worktreesToRelease)
    /**
     * `kind === 'unknown'` 时**不能**坐 READY:advanceableKind 对 READY+unknown 返回 null,
     * 节点既不可推进也不是终态。菜单已经把这一档禁掉了,这里是第二道 —— 同一个文件里
     * reopenAncestor / reopenIfPropagated 和 reseat.ts 写的都是这条判据,只有重做目标
     * 自己曾经跳过它。
     */
    seatedAt = target.kind === 'executable' ? 'READY' : 'CREATED'
  } else {
    // integrate:子任务一个不动,只把父节点退回等子任务的位置重新裁决。
    //
    // verify / accept / observer **到不了这里** —— PHASE_ENTRY_BLOCKED 无条件禁用它们,
    // 上面 `opt.disabled` 那一句就返回了。写成 else 而不是 `else if (entry === 'integrate')`
    // 是为了 seatedAt 必然被赋值;真正的守门人是 disabled,不是这个分支形状。
    target.iteration = { ...target.iteration, integration: 0, scoring: 0 }
    const unfinished = target.childIds.filter(id => byId.get(id)?.status !== 'ACCEPTED')
    if (unfinished.length > 0) {
      // 不是错误:退回 WAITING_CHILDREN 之后调度器会先把这些子任务推完,再做集成验收。
      // 但用户按的是「重新裁决一次」,得知道它不会立刻发生。
      warnings.push(`还有 ${unfinished.length} 个子任务没有验收通过,集成验收会等它们完成后才发生`)
    }
    seatedAt = 'WAITING_CHILDREN'
  }

  // ---- 各入口共通的清理 ----
  reopenedAncestors.push(...reseatForRerun(target, byId, {
    seatedAt, now, warnings,
    /**
     * 一次性的重入点标记,由 stepStart 在**第一轮**消费后立刻清掉。
     *
     * 只有质疑讨论用得上它 —— 其余入口靠 `status` 就能被 `advanceableKind` 分派到正确的
     * step,而 CREATED 有两个可能的起点(分析 / 质疑讨论),必须多一个字才分得开。
     *
     * **每条入口都要写**,包括写成 undefined 的那几条:上一次质疑讨论重做留下的标记
     * 不清掉的话,这次「任务重做」会跳过分析 —— 那正是它唯一要做的事。
     */
    redoFrom: entry === 'review' ? 'review' : undefined,
    // 手工跳过是一次性的,而这次重做是用户重新做的选择:上一次「跳过验收」的标记留着的话,
    // 他按 r 重跑执行环节,产出会**再一次**不经验收就合进集成分支,而屏幕上什么都没说。
    skipPhase: undefined,
  }))

  return {
    nodes: [...byId.values()],
    deleted,
    dependencyRewrites,
    worktreesToRelease,
    seatedAt,
    reopenedAncestors,
    warnings,
  }
}

/**
 * 计算一次「跳过失败的环节,继续往下走」。**纯函数**,返回值形状和 `planRedo` 一样,
 * 所以落盘那一侧(redoRun / commitRedo)一行都不用改。
 *
 * ## 跳过之后到底会跑什么
 *
 * | 失败环节 | 座位 | 跳过之后 | 模型调用 |
 * |---|---|---|---|
 * | 质疑讨论 | CREATED + redoFrom=review | 方案照用,直接往下走(执行型接执行,拆分型接集成验收) | 0 次评审 |
 * | 测试验证 | READY(从执行循环**尾部**进) | 不再实跑测试,直接进验收 | 只有验收那一桌 |
 * | 验收 | READY(同上) | 不再核对验收点,直接评分 → 合并 → 已验收 | 只有评分(配了才有) |
 * | 集成验收 | WAITING_CHILDREN | 不再裁决「合起来达没达成父目标」,直接已验收 | 0 次 |
 *
 * 「从执行循环尾部进」是这里唯一一处需要 pipeline 配合的地方(`node.skipPhase` 为
 * verify/accept 时跳过循环前半段)。少了它,跳过验收会**先重跑一次执行者** —— 而用户想跳过的
 * 是判决,不是重做工作;那一轮还会改动代码,把他刚刚亲自看过的产出换成另一份。
 */
export function planSkip(
  input: readonly TaskNode[],
  targetId: string,
  now: string,
  ctx?: RedoContext,
): RedoPlan | { error: string } {
  return planPastFailedPhase(input, targetId, now, 'skip', ctx)
}

/**
 * 「强制通过失败的那个环节」算出来的新树。
 *
 * **和 `planSkip` 共用一个实现,而这是这个功能能小到值得做的全部原因**:两者的重入座位、
 * 返工计数清零、祖先重开、工作区处置逐字相同 —— 强制通过唯一多做的事发生在 `pipeline`
 * 那一侧(往 log 里写一条人工裁决),这里只负责把 `forcePass` 而不是 `skipPhase` 写到
 * 节点上。
 *
 * 那些 ⚠ 警告文案是分开的:它们讲的是「这一下换掉了什么质量保证」,而
 * 「没有任何人质疑过」和「圆桌否了、你放行了」不是同一件事,对着同一个用户也不该说同一句话。
 */
export function planForcePass(
  input: readonly TaskNode[],
  targetId: string,
  now: string,
  ctx?: RedoContext,
): RedoPlan | { error: string } {
  return planPastFailedPhase(input, targetId, now, 'forcePass', ctx)
}

function planPastFailedPhase(
  input: readonly TaskNode[],
  targetId: string,
  now: string,
  mode: 'skip' | 'forcePass',
  ctx?: RedoContext,
): RedoPlan | { error: string } {
  const forced = mode === 'forcePass'
  const nodes = input.map(n => structuredClone(n) as TaskNode)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { error: `节点不存在: ${targetId}` }
  // 授权判据只有这一份 —— 屏幕上按不动的东西不可能从别的门进去。
  const why = forced ? forcePassFailedPhaseReason(target, ctx) : skipFailedPhaseReason(target, ctx)
  if (why) return { error: why }
  const phase = failedPhaseOf(target)!

  const warnings: string[] = []
  const worktreesToRelease: { nodeId: string; branch: string; path: string }[] = []
  let seatedAt: NodeStatus
  if (phase === 'review') {
    // 方案一个字不动 —— 跳过的是「有没有人质疑它」。
    target.confirmedDraft = undefined
    /**
     * 执行型节点要连带做执行重做的那套重置,和 `planRedo` 的 review 入口逐字同因:
     * 跳过评审之后走的是普通路由(`commit(READY)` → stepExecute),工作区会被重新 acquire、
     * 执行者重跑。不做的话 execStatus 里还写着「我实现了 feature.ts」而没有任何重做注记。
     */
    if (!isDecomposed(target)) resetForExecute(target, worktreesToRelease)
    /**
     * ⚠ **这四跳都要有**,而这一跳原来是空的。
     *
     * 关口用 `⚠` 标「这一跳换掉了什么质量保证」,而那些 ⚠ 全部来自 `plan.warnings` ——
     * 只有 accept / integrate 往里 push 过。验收实测:跳过质疑讨论和跳过测试验证的 ⚠ 条数
     * **都是 0**,而这两个恰恰是「换掉了质量保证」最明显的两个(方案没人质疑就往下走、
     * 一个测试都不实跑)。README 承诺这一屏会用 ⚠ 标出来,那就得真的标。
     */
    warnings.push(forced
      ? '评审员提出的意见**一条都没有被处理**,由你放行 —— 它们原样留在评审记录里,而方案一个字没改'
      : '这份方案**没有任何人质疑过**就进入下一步 —— 漏项和隐藏依赖不会在这里被拦下')
    seatedAt = 'CREATED'
  } else if (phase === 'verify' || phase === 'accept') {
    /**
     * 返工计数清零。
     *
     * 测试验证失败是**记在 `iteration.acceptance` 上**的(它和验收共用一份预算),所以一个
     * 「测试验证迭代超限」的节点带着已经用尽的验收预算 —— 跳过测试验证之后那一桌验收
     * 只要不通过就当场再次阻断,一次返工机会都没有。清零并在摘要里说出来。
     */
    target.iteration = { ...target.iteration, acceptance: 0, scoring: 0, mergeResolve: 0 }
    if (phase === 'accept') {
      warnings.push(forced
        ? '验收员判**不通过**的那份产出会原样合进集成分支 —— 这正是你按下这个键要的效果,但它没有回头路'
        : '本节点的产出**不会有任何人核对**就合进集成分支 —— 这正是你按下这个键要的效果,但它没有回头路')
    } else {
      // 同上:这一跳的 ⚠ 原来也是空的。
      warnings.push(forced
        ? '**一个测试都不会被实跑**,而此前那一轮是判过不通过的 —— 之后的验收只能读执行者的自述'
        : '**一个测试都不会被实跑** —— 之后的验收只能读执行者的自述')
    }
    seatedAt = 'READY'
  } else {
    // integrate:子任务一个不动,直接判这个父节点通过。
    target.iteration = { ...target.iteration, integration: 0, scoring: 0 }
    const unfinished = target.childIds.filter(id => byId.get(id)?.status !== 'ACCEPTED')
    if (unfinished.length > 0) {
      // 不是错误:退回 WAITING_CHILDREN 之后调度器会先把这些子任务推完,再走到集成验收
      // 那一步 —— 而那一步这次会被跳过。
      warnings.push(`还有 ${unfinished.length} 个子任务没有验收通过,本节点会先等它们完成`)
    }
    warnings.push(forced
      ? '「这些子任务合起来达成父目标了吗」这一问**由你自己回答了是** —— 圆桌给的是否,当初拆漏了什么就随之定案'
      : '「这些子任务合起来达成父目标了吗」这一问**这次不会有人回答** —— 当初拆漏了也不会在这里被发现')
    seatedAt = 'WAITING_CHILDREN'
  }

  const reopenedAncestors = reseatForRerun(target, byId, {
    seatedAt, now, warnings,
    redoFrom: phase === 'review' ? 'review' : undefined,
    // 两个字段**互斥**地写:同时挂着的话 pipeline 里那个「强制通过赢」的判据会让跳过
    // 那一支永远走不到,而节点上留着一个永远不被消费的 skipPhase —— 它的第二个作用
    // (让 stepExecute 从判决段进来)会在**下一轮**再次生效,执行环节从此不再跑。
    skipPhase: forced ? undefined : phase,
    forcePass: forced ? phase : undefined,
  })

  return {
    nodes: [...byId.values()],
    deleted: [],
    dependencyRewrites: [],
    worktreesToRelease,
    seatedAt,
    reopenedAncestors,
    warnings,
  }
}

/** 跳过关口上那段摘要 —— 按下确认之前,把「这一跳换掉了什么」摊开。 */
export function skipSummary(
  plan: RedoPlan, target: TaskNode, phase: PhaseName, ctx?: RedoContext,
): string[] {
  return pastPhaseSummary(plan, target, phase, 'skip', ctx)
}

/**
 * 强制通过关口上那段摘要。
 *
 * 和跳过共用主体(之后跑什么、执行重不重跑、计数清不清零 —— 那些是路由的事实,两条路
 * 逐字相同),只有**头一行和尾巴上那条**不同,而那正是这个功能的全部:一条会留在记录里的
 * 人工裁决。
 */
export function forcePassSummary(
  plan: RedoPlan, target: TaskNode, phase: PhaseName, ctx?: RedoContext,
): string[] {
  return pastPhaseSummary(plan, target, phase, 'forcePass', ctx)
}

function pastPhaseSummary(
  plan: RedoPlan, target: TaskNode, phase: PhaseName, mode: 'skip' | 'forcePass', ctx?: RedoContext,
): string[] {
  const forced = mode === 'forcePass'
  const lines: string[] = []
  lines.push(forced
    ? `强制通过「${PHASE_LABEL[phase]}」—— 这个环节这次**不会开会**,但会在记录里留下一条**署名「${MANUAL_PASS_ROLE}」的通过**`
    : `跳过「${PHASE_LABEL[phase]}」—— 这个环节这次**不会发生**,也不会在记录里留一条通过`)
  /**
   * 跳过之后还会跑什么,**照实算**。
   *
   * 复用 `phaseChainText` 那份口径(它已经按本次配置过滤过:没配角色的测试验证/观察本来
   * 就不存在),再把被跳掉的这一个从里面拿掉 —— 印一条包含它的链就是当场自相矛盾。
   */
  const entry: RedoEntry = phase === 'review' ? 'review' : phase === 'integrate' ? 'integrate' : 'execute'
  /**
   * **这一轮真的不跑的那几个,一个都不许出现在这一行里。**
   *
   * 评审实测到两行同屏自相矛盾:「之后会跑: 执行」紧跟着「执行环节不重跑」——
   * 而默认配置(测试验证/观察都 0 席)下 `rest` **只有** execute,所以那一行 100% 是假的。
   * 除了被跳掉的那一个,还要滤掉:
   *  - `execute`:verify/accept 这两跳从执行循环的**尾部**进来,执行者不会被派;
   *  - `verify`:跳过验收时它在上一轮已经过了,这一轮也不重跑(见 stepExecute 的
   *    `skipVerifyThisRound`)。
   */
  const notThisRound = new Set<PhaseName>([phase])
  if (phase === 'verify' || phase === 'accept') notThisRound.add('execute')
  if (phase === 'accept') notThisRound.add('verify')
  const rest = phasesOf(entry, ctx, target).filter(p => !notThisRound.has(p))
  lines.push(rest.length > 0
    ? `之后会跑: ${rest.map(p => PHASE_LABEL[p]).join(' → ')}`
    : '之后没有别的环节了,本节点会直接判为已验收')
  if (phase === 'verify' || phase === 'accept') {
    // 这一条是这次跳过最容易被误解的地方:它**不重跑执行者**。
    lines.push('执行环节不重跑 —— 你刚看过的那份产出原样往下走(执行者不会再改一遍代码)')
  }
  if (phase === 'accept') {
    lines.push('本轮测试验证也不重跑 —— 它在上一轮(节点走到验收之前)已经通过了')
  }
  if (phase === 'review') {
    lines.push(forced
      // 「没有任何人质疑它」在强制通过这条路上是**假话** —— 有人质疑了,而且判了不通过。
      ? '现有方案原样保留(一个字都不会改),评审员提的那些意见留在记录里但没人去处理'
      : '现有方案原样保留,没有任何人质疑它就进入下一步')
  }
  if (forced) {
    lines.push(`记录里会多一条 round 的 PASS,署名「${MANUAL_PASS_ROLE}」,并附上被你覆盖掉的那些阻断意见`)
  }
  if (target.status === 'BLOCKED') lines.push('本节点从「已阻断」回到可推进状态')
  /**
   * 返工计数**只在真的清了的时候**才说。
   *
   * 评审实测:跳过质疑讨论时这句话照样印,而 `planSkip` 那一支一个计数都没重置
   * (planReview 3→3, acceptance 3→3)。关口上一句无条件的承诺,就是一句一半的时候
   * 为假的话。
   */
  if (phase !== 'review') lines.push('相关环节的返工计数清零 —— 后面的环节会重新占满一轮返工额度')
  for (const w of plan.warnings) lines.push(`⚠ ${w}`)
  return lines
}

/**
 * 把用户补的那句提示词写到节点上。**纯函数式**:改的是传进来的那个节点对象(调用方给的
 * 已经是 `planRedo` / `planSkip` 克隆出来的那份)。
 *
 * `scope` 是环节名,或者 `'all'`(给整个节点 —— 任务重做走的就是它)。空串 = 清掉这一条。
 *
 * **同一个键再写一次是替换。** 见 TaskNode.guidance:用户的说法是「塞新的提示词」,
 * 追加会让两条互相打架,而模型看不出哪句更新。
 */
export function attachGuidance(
  node: TaskNode, scope: PhaseName | 'all', text: string,
): void {
  // 按**码点**截,不是按 UTF-16 单元:`.slice` 会把一个 emoji 劈成两半,尾部留下一个孤立的
  // 高代理,而它会原样进提示词(control.addDirective 踩过同一个坑)。
  const t = Array.from(text.trim()).slice(0, MAX_GUIDANCE_CHARS).join('')
  const next = { ...(node.guidance ?? {}) }
  if (t.length === 0) delete next[scope]
  else next[scope] = t
  node.guidance = Object.keys(next).length > 0 ? next : undefined
}

/** 一次重做/跳过要把补充指引写到哪个键上。任务重做是整节点,阶段重做/跳过是那个环节。 */
export function guidanceScopeFor(entry: RedoEntry, scope: RedoScope): PhaseName | 'all' {
  return scope === 'task' ? 'all' : entry
}

/** 关口上那段摘要 —— 按下确认之前,把这次重做**做了什么、做不到什么**摊开。 */
export function redoSummary(
  plan: RedoPlan, target: TaskNode, entry: RedoEntry, ctx?: RedoContext,
): string[] {
  const lines: string[] = []
  // 照实说这次会跑哪些环节 —— 写死一句话的版本在默认配置下就是假的(测试验证是
  // opt-in,没配角色时根本不存在),而用户是按字面意思选的。
  lines.push(`「${target.title}」将重新走: ${phaseChainText(entry, ctx, target)}`)
  /**
   * 重做**按哪一档跑**。
   *
   * 少了这一行的场景是具体的:用户降到初级 → 半成品被放行 → 他在结束屏上按 `r` 重做 →
   * 拿到的是**又一次初级**的结果,而屏幕上从头到尾没提过档位。档位是 run 级持续状态
   * (`control` 不清它,`reopenPropagatedNode` 也不清),所以「重做会换个标准」是一个
   * 完全错误但很自然的预期 —— 必须在按下确认之前说破。
   */
  if (ctx?.strictness !== undefined) {
    lines.push(`按当前严格度「${ctx.strictness}」重跑(重做不改档位;要换标准先用 < > 调,再重做)`)
  }
  /**
   * 节点自己会**退出终态**。
   *
   * `plan.seatedAt` 一直是算出来的、也一直在返回值里,但一行都没渲染过 —— 于是屏幕上
   * 那份「代价清单」漏掉了最直接的一项:一个已验收的节点重做之后,本次运行立刻不再算完成。
   * 用户是在「✓ 高效任务完成」那一屏上按的 r,他有理由以为这只是加跑一轮。
   */
  if (target.status === 'ACCEPTED') {
    lines.push('本节点从「已验收」退回重跑 —— 在它重新通过之前,本次运行不再算完成')
  }
  if (plan.deleted.length > 0) lines.push(`删除 ${plan.deleted.length} 个子任务,重做后按新方案重建`)
  // 「改写」和「移除」分开说。合成一句「N 条依赖被改写为指向本节点」时,那些其实被
  // **删掉**的(目标自己依赖被删后代 / 改指会成环)也被算进去,而它们的后果完全不同:
  // 改写是下游继续等,移除是下游可能提前起跑。
  const removed = plan.dependencyRewrites.filter(r => r.to.startsWith('(已移除'))
  const rewritten = plan.dependencyRewrites.length - removed.length
  if (rewritten > 0) lines.push(`${rewritten} 条依赖被改写为指向本节点`)
  if (removed.length > 0) lines.push(`${removed.length} 条依赖被移除(下游可能比预期更早起跑)`)
  if (plan.worktreesToRelease.length > 0) {
    /**
     * 「释放」读起来像清理,而对一个**脏的**工作区它不是。
     *
     * release 在工作区仍有未提交/被忽略的文件时会拒删(keptBecause),目录留在原地;
     * 下一次 acquire 走复用分支:`git add -A` → `commit --no-verify` →
     * `branch -f efftask/<run>/salvage/<节点>` → `checkout -B <分支> <集成分支>`。
     * 也就是说用户手改的东西被提交进一条他从没听说过的分支,目录被重置 —— 不会丢,
     * 但也不在原处了。屏幕只写「释放 N 个」的话,这件事按下去之前完全看不见。
     */
    lines.push(
      `释放 ${plan.worktreesToRelease.length} 个隔离工作区;里面**未提交**的改动会先被固化到 ` +
      `efftask/<run>/salvage/… 分支再重置目录 —— 不会丢,但不在原处了`,
    )
  }
  /**
   * 执行者会读到哪一句重做注记。
   *
   * README 把它列进「确认屏会摊开的后果」,而确认屏从来没印过它 —— 文档说得到、
   * 屏幕做不到。它是用户判断「执行者会不会把我的产出从零重做一遍」的唯一依据,
   * 所以补上屏,而不是从文档里删掉。
   */
  const note = plan.nodes.find(n => n.id === target.id)?.execStatus ?? ''
  if (note.includes(REDO_NOTE_MERGED)) lines.push('执行者会被告知:上一轮产出已合入集成分支,在新工作区里看得到,请在它之上继续改')
  else if (note.includes(REDO_NOTE_LOST)) lines.push('执行者会被告知:上一轮产出不在新工作区里')
  // 返工额度会重新给。这是这次重做的直接成本(每一轮都是真实的模型调用),
  // 而它此前只体现在代码里。
  lines.push('相关环节的返工计数清零 —— 会重新占满一轮返工额度')
  // 「上级 N 个任务重新做集成验收」这一行**不在这里印** —— planRedo 已经把同一件事
  // 写成一条 ⚠ 警告(还多说了为什么),两条同框占 3 行,而这一屏本来就在跟高度打架。
  for (const w of plan.warnings) lines.push(`⚠ ${w}`)
  return lines
}

/**
 * 「这次能不能重做」—— 不看树,看**进程状态**。
 *
 * 中断标记(runController.signal)一旦置上,对整个 `/et` 进程都有效,而且没有办法撤销。
 * 于是「Esc 中断 → 落到 done 视图 → 按 r 重做」这条完全自然的路径,会让编排器在
 * run() 的第一个循环里就走 `if (this.signal.aborted)` 那一支:扫一遍 propagateBlocked,
 * 返回「已中断」。用户看到的是同一屏、同一句话,而他刚刚明明操作了一次 —— 一次模型
 * 调用都没有发生,也没有任何东西告诉他为什么。
 *
 * 所以这里**提前挡住并且给出能照做的下一步**,而不是让他按下去再看一遍失败。
 */
export function redoUnavailableReason(opts: { aborted: boolean; runId?: string }): string | undefined {
  if (!opts.aborted) return undefined
  return `本次运行已被中断,中断标记对整个 /et 进程有效 —— 在这里重做会立刻再次阻断。` +
    `请退出后执行: /et --resume ${opts.runId && opts.runId.length > 0 ? opts.runId : '<run id>'}`
}
