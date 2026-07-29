import { PHASE_LABEL, PHASE_NAMES, type NodeStatus, type PhaseName, type TaskNode } from './types.js'

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
export function redoContextOf(node: TaskNode, cfg?: { skipSteps?: readonly PhaseName[] }): RedoContext {
  return {
    seatCount: Object.fromEntries(
      PHASE_NAMES.map(p => [p, (node.phaseRoles?.[p] ?? []).length]),
    ) as Record<PhaseName, number>,
    skipSteps: cfg?.skipSteps,
  }
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
  n.capBlocked = false
  n.capCategory = undefined
  // 这一轮它要重判的是集成验收,所以给回集成和评分的预算;方案/验收预算不动 ——
  // 这次重做没打算让祖先重新分析。
  n.iteration = { ...n.iteration, integration: 0, scoring: 0 }
  n.startedAt = undefined
  n.updatedAt = now
  return true
}

/** 兄弟/下游那一侧:只解开**被牵连**的阻断,不碰人家自己的判决,也不碰已验收的。 */
function reopenIfPropagated(n: TaskNode, now: string): void {
  if (n.status !== 'BLOCKED' || !PROPAGATED.has(n.blockedReason)) return
  n.status = n.childIds.length > 0 ? 'WAITING_CHILDREN' : n.kind === 'executable' ? 'READY' : 'CREATED'
  n.blockedReason = ''
  n.updatedAt = now
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
  /**
   * 一次性的重入点标记,由 stepStart 在**第一轮**消费后立刻清掉。
   *
   * 只有质疑讨论用得上它 —— 其余入口靠 `status` 就能被 `advanceableKind` 分派到正确的
   * step,而 CREATED 有两个可能的起点(分析 / 质疑讨论),必须多一个字才分得开。
   *
   * **每条入口都要写**,包括写成 undefined 的那几条:上一次质疑讨论重做留下的标记
   * 不清掉的话,这次「任务重做」会跳过分析 —— 那正是它唯一要做的事。
   */
  target.redoFrom = entry === 'review' ? 'review' : undefined
  target.status = seatedAt
  target.blockedReason = ''
  target.interrupted = false
  target.capBlocked = false
  target.capCategory = undefined
  target.mergeConflict = false
  // 和 reseat 同因:startedAt 会跨越终端关闭的整段时间,面板照着它算出「172800 秒」。
  // 重做就是重新开始,下一个活动阶段由 commit() 重新盖章。
  target.startedAt = undefined
  target.updatedAt = now

  // 上面那条链,和任何在等它的兄弟。不做这一步,重做出来的座位是**够不到**的。
  let p = target.parentId === null ? undefined : byId.get(target.parentId)
  const guard = new Set<string>([target.id])
  while (p && !guard.has(p.id)) {
    guard.add(p.id)
    if (reopenAncestor(p, now)) reopenedAncestors.push(p.id)
    p = p.parentId === null ? undefined : byId.get(p.parentId)
  }
  if (reopenedAncestors.length > 0) {
    warnings.push(
      `上级的 ${reopenedAncestors.length} 个任务会重新做一次集成验收 —— ` +
      `它们原来那句「子任务合起来达成了父目标」判的是旧产出`,
    )
  }
  for (const n of byId.values()) {
    if (n.id !== target.id && n.deps.includes(target.id)) reopenIfPropagated(n, now)
  }

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

/** 关口上那段摘要 —— 按下确认之前,把这次重做**做了什么、做不到什么**摊开。 */
export function redoSummary(
  plan: RedoPlan, target: TaskNode, entry: RedoEntry, ctx?: RedoContext,
): string[] {
  const lines: string[] = []
  // 照实说这次会跑哪些环节 —— 写死一句话的版本在默认配置下就是假的(测试验证是
  // opt-in,没配角色时根本不存在),而用户是按字面意思选的。
  lines.push(`「${target.title}」将重新走: ${phaseChainText(entry, ctx, target)}`)
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
