import { isProtocolBlocking } from './parseOutput.js'
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
 * | 1 | 被点到的节点按**形态**重入(执行型 `execute` / 拆分型 `integrate`,见 `entryFor`),把 blocking 意见**逐条注入它的提示词** | 默认 |
 * | 2 | 那个节点 `planRedo(entry='plan')`(重新分析并拆分) | 第 1 级已经试过、而集成验收仍然不通过 |
 *
 * **重新武装补救拆分不分级**:只要目标有子任务就解闩(见 `markBacktracked`)——
 * 「加新任务」是用户明确要的,而第 1 级本来就要重新走一次集成验收,那正是它该被允许
 * 长出补救子任务的时刻;绑在第 2 级上等于要按两次 `b` 才可能发生。
 *
 * 第 2 级为什么不自己去建子任务:`createChildren` 要一个 `PipelineCtx`(`reserveNodes` 的
 * **原子**预留),而按键处理里够不着 —— 手搓一个就等于把 `maxNodes` 上限静默关掉。
 * 所以改成把父节点的 `revised` 闩解开,让编排器自己那条**已经测过**的
 * `reviseDecomposition` 用真 ctx 把补救子任务长出来 —— 时机是**集成验收再次连续判不通过、
 * 到达迭代上限的那一轮**(不是「下一轮」:`planRedo`/`reopenAncestor` 刚把
 * `iteration.integration` 清零,默认档下还要再失败满 3 轮)。
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
/**
 * **`m` 键三级都试过、仍然没捞回来的产出。**
 *
 * 用户 2026-08-13:「按 m 键触发,没有捞回的数据任务……如果实在捞不回来,会在回溯里检查不。」
 * 此前这一段是**断的**:`m` 判 hold / 补录不全是**一条 ref** 的事,而回溯认的是
 * `lastIntegrateFailed` / `outputMissing` 两条**节点级**信号 —— 一条捞不回来的 ref
 * 在节点上不留任何痕迹,`b` 扫不到它,它只活在那一屏的文字里,用户看完就走了。
 *
 * **注记做判据,字段做载荷**(和 `outputMissing` 同一个形状):`execStatus` 上这句话决定
 * `b` 认不认领,`node.rescueStranded` 只带明细。反过来做的话,字段在任何一次序列化事故里
 * 丢掉,`b` 就静默地扫不到 —— 而这个仓库为「只写不读的字段第一次 `--resume` 时清零」
 * 付过三次账。
 */
export const RESCUE_STRANDED_NOTE = '有产出没能捞回集成分支'
export function rescueStranded(n: TaskNode): boolean {
  return n.execStatus.includes(RESCUE_STRANDED_NOTE) || n.blockedReason.includes(RESCUE_STRANDED_NOTE)
}

/**
 * **这个节点身上的痕迹,`b` 认不认领。**
 *
 * 判据和 `backtrackScope` 是**同一个**,而且必须是同一个:写痕迹的一侧
 * (`m`)和读痕迹的一侧(`b`)各自判一次的话,中间那道缝就是验收席实测到的形状 ——
 * 痕迹落在拆分型 / `kind: 'unknown'`(节点的出厂档)/ 有子任务的节点上,
 * `m` 的结果屏说「已经记在它们身上,按 b 回溯会把这些内容重新做出来」,而 `b` 那一屏说
 * 「这棵子树里没有需要回溯的任务……m 也没有留下捞不回来的东西」。两块屏说反话,
 * 而那条痕迹**永远清不掉**(`markBacktracked` 只走 targets)。
 *
 * 导出它是为了让 `m` 在落痕**之前**问一次:认不了的,老老实实说「这条没人接」,
 * 而不是写一句谁都不会读的话。
 */
export function backtrackCanClaim(n: TaskNode): boolean {
  return n.childIds.length === 0 && n.kind === 'executable'
}

/**
 * 载荷,**读出来一律校验**。
 *
 * `validateLoadedNodes` 不认识这个字段,一个手改坏的 node.md 上 `rescueStranded: boom`
 * 会让 `.map` 当场抛在恢复链路里。这个仓库为「读侧不校验」逐字写过判决:不抛、不修复、
 * 纯造谣 —— 所以这里只认数组里长得对的那些,别的当没有。
 */
export function strandedRefsOf(
  n: TaskNode,
): { ref: string; why: string; at: string; remaining: number; paths: string[] }[] {
  const raw: unknown = n.rescueStranded
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is { ref: string; why: string; at: string; remaining: number } =>
    typeof x === 'object' && x !== null && typeof (x as { ref?: unknown }).ref === 'string')
    .map(x => ({
      ref: x.ref,
      why: typeof x.why === 'string' ? x.why : '',
      at: typeof x.at === 'string' ? x.at : '',
      remaining: typeof x.remaining === 'number' ? x.remaining : 0,
      paths: Array.isArray((x as { paths?: unknown }).paths)
        ? ((x as { paths: unknown[] }).paths.filter(s => typeof s === 'string') as string[])
        : [],
    }))
}

/**
 * 这个节点**自己说**还欠哪几件(`TaskNode.undone`)。载荷,读出来一律校验 ——
 * 和 `strandedRefsOf` 同一条理由:`validateLoadedNodes` 不认识这个字段,一个手改坏的
 * node.md 上 `undone: boom` 会让 `.map` 当场抛在恢复链路里。
 */
export function undoneOf(n: TaskNode): string[] {
  const raw: unknown = n.undone
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

/** 执行者自陈还欠东西 —— 「有贡献」不等于「做完了」。 */
export function selfReportedUndone(n: TaskNode): boolean {
  return undoneOf(n).length > 0
}

/**
 * **这个节点的集成验收到底说了什么** —— 一段能直接注入执行提示词的整改要求。
 *
 * 判据从「最后一条记录的 `blockingSummary`」换成**跨轮汇总**,理由是跑机上量出来的:
 * 那 222 个节点的最后一条记录逐字是「未按要求输出本轮的裁决代码块」(一次协议失败),
 * 而真正的意见 —— 「datum.rs 不在集成工作区」「cargo check 126 errors」—— 躺在前几轮里,
 * 以及 `degraded[].advice` 里。照旧只读最后一条的话,回溯注入给执行者的第一句话是
 * 一句**关于回复格式的抱怨**,而他手上根本没有那份回复。
 *
 * 优先级(先具体、后概括;新的在前):
 *  1. 各轮 `verdicts[].blocking` —— 剔掉协议失败那两条(见 `isProtocolBlocking`);
 *  2. 各轮 `verdicts[].advice`(「接下来该怎么改」);
 *  3. `degraded[].advice`(降级放行时随节点带下去的那一份,phase = integrate);
 *  4. 一条都凑不出来时,才退回 `blockingSummary` —— 哪怕它是句格式抱怨,
 *     也好过给执行者一句空话。
 */
export function integrateFeedback(n: TaskNode): string {
  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (t.length === 0 || isProtocolBlocking(t) || out.includes(t)) return
    out.push(t)
  }
  const records = n.acceptLog.filter(r => r.step === 'integrate').slice().reverse()
  for (const rec of records) for (const v of rec.verdicts) for (const b of v.blocking) push(b)
  for (const rec of records) for (const v of rec.verdicts) for (const a of v.advice ?? []) push(a)
  for (const d of n.degraded ?? []) if (d.phase === 'integrate') for (const a of d.advice) push(a)
  if (out.length === 0) {
    /**
     * 各轮的 blocking/advice 都空(老记录常常只有一句合成摘要)—— 那句摘要仍然是真意见,
     * 照发。**只有它本身就是协议失败时才不发**:见下面那一段。
     */
    const summary = (lastIntegrateRecord(n)?.synthesized.blockingSummary ?? '').trim()
    if (summary.length > 0 && !isProtocolBlocking(summary)) return clipItem(summary)
    /**
     * **一条真意见都没凑出来。**
     *
     * 到这里只剩两种可能:记录里全是协议失败(那 222 个节点的形状),或者裁决根本没留下
     * 内容。两种都**不能**把 `blockingSummary` 原样发出去 —— 「未按要求输出本轮的裁决
     * 代码块」发给一个执行者,他手上根本没有那份回复,读到的是一句他无法照做的话
     * (探针第一版试过发空串,那更糟:屏幕承诺「把意见注入执行提示词」而注入的是空气)。
     *
     * 给一句**他能照做**的:回到父目标的验收点上逐条自查。
     */
    return '上一次集成验收没有留下可用的整改意见(那几轮的裁决没有按格式返回,内容没能保存下来)。'
      + '这一次请对照父任务的验收点逐条自查,把还没落到文件里的那几项做出来。'
  }
  // 有界:这一段会被逐字塞进执行提示词,而它的来源是 N 轮 × M 席的自由文本。
  return out.slice(0, MAX_FEEDBACK_ITEMS).map(s => clipItem(s)).join('\n')
}
/** 注入执行提示词的那一段,最多几条、每条多长。 */
const MAX_FEEDBACK_ITEMS = 12
const clipItem = (s: string): string => (s.length > 600 ? `${s.slice(0, 600)}…` : s)

export function outputMissing(n: TaskNode): boolean {
  if (!n.execStatus.includes(NO_CONTRIBUTION_NOTE) && !n.blockedReason.includes(NO_CONTRIBUTION_NOTE)) return false
  /**
   * **交付过的不算 —— 哪怕盘上留着那句注记。**
   *
   * `contributed` 是「这个节点真的往集成分支放过东西」的持久标记,而那句注记在旧版本里是
   * **无条件**追加的:一个交付过的节点重跑一轮没有新东西可合,照样会被写上这句话。
   * 跑机实测 14 个节点正是这形状(`contributed: true` 与注记同时在盘上)——
   * 少了这一句,`b` 会把它们一起点中重跑,而它们的产出早就在集成分支上了。
   *
   * 写 `=== true` 而不是 `!== false`:这个字段缺席(老 run、或者根本没走过合并)时是
   * `undefined`,而 `undefined` 在这里必须落到「没交付过」那一侧 —— 宁可多重跑一次,
   * 不可放过一个真的没交付的。这个仓库为「裸比较把默认判成反面」付过账,方向要写明。
   */
  if (n.contributed === true) return false
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
    /**
     * **第三条判据不和前两条同权。**
     *
     * 接缝席在真调用链上推过一条会把整次回溯变成空操作的路:一条没捞回的 ref 恰好挂在
     * **拆分型节点**上 → 它的子树全绿 → `suspects` 为空 → `runBacktrack` 退回「回溯它自己」
     * → `planRedo(entry:'execute')` 对拆分任务判 disabled → `composeRedos` 一错**整条不做**
     * → 连那些真正集成验收没通过的节点**一起,一个都不重跑**。
     *
     * 所以只对**真的有执行环节**的节点立 target。拆分型节点上的 ref 不是没人管:
     * 它的痕迹照样在 `execStatus` 上、照样在 `m` 的结果屏上,只是不由这个键动手 ——
     * 让 `b` 去重跑一个自己不干活的节点,除了删掉它健康的子树之外什么都不会发生。
     *
     * 判据是 `kind === 'executable'`,**不是** `!== 'decompose'`:第一版写成后者,
     * 而夹具当场把它顶红了 —— `unknown` 那一格 `planRedo` 同样判 disabled
     * (「本节点还没有方案,分析之后才知道它是拆分还是执行」),后果和拆分型一模一样。
     * 这个仓库两天前刚为「`!== 'worktree'` 把 `undefined` 判成反面」付过一次账。
     */
    const stranded = rescueStranded(n) && backtrackCanClaim(n)
    if (!failed && !missing && !stranded) continue
    const rec = failed ? lastIntegrateRecord(n) : undefined
    /**
     * **补救提案也跨轮取,和意见那一侧同一个口径。**
     *
     * 接缝席点名:同一次改动把 `reviseDecomposition` 改成跨轮并集,却把回溯这一侧留在
     * `lastIntegrateRecord` 上 —— 222 那种形状下(触顶那一轮是协议失败)`target.remedy`
     * 恒空,而第 1 轮明明提过。后果两处:确认屏第 2 级那行「集成验收此前提过的补救项」
     * 空着,以及喂给主模型映射的提示词里那一段整个消失。
     * 同一件事两处判据不一致,是这个仓库的固定病灶。
     */
    const remedy: string[] = []
    if (failed) {
      for (const r of n.acceptLog.filter(x => x.step === 'integrate').slice().reverse()) {
        for (const v of r.verdicts) {
          for (const c of v.remedy ?? []) if (!remedy.includes(c.title)) remedy.push(c.title)
        }
      }
    }
    targets.push({
      node: n,
      /**
       * **只因为「捞不回」进来的,恒走第 1 级。**
       *
       * `levelFor` 读的是这个节点的**终身**回溯计数 —— 一个此前因为别的原因被回溯过一次的
       * 节点,这次只是有条 ref 没捞回来,却会直接跳到第 2 级:重新分析并拆分 + **删掉整片
       * 子树**。用户定的阶梯是「优先重新执行……**如果不行**,才完全重做」,而「不行」的判据
       * 是这件事试过一遍,不是这个节点这辈子被回溯过几次。
       */
      level: !failed && !missing ? 1 : levelFor(n),
      /**
       * 意见走 `integrateFeedback` 的跨轮汇总,不再只取最后一条 `blockingSummary` ——
       * 那一条在跑机上 222 次是「未按要求输出本轮的裁决代码块」。
       */
      blocking: failed ? integrateFeedback(n) : whyWithoutVerdict(n, missing, stranded),
      remedy,
      /**
       * 保守名单:**没验收通过的** + **产出丢了的** + **自己说还没做完的**子任务。
       *
       * 第三条是这次补上的,而它正是 datum 那一格:子任务 `status: ACCEPTED`、
       * 改过一行 `Cargo.toml` 所以「有贡献」、`acceptLog` 空(这一趟按用户要求关掉了验收),
       * 而它自己的 execStatus 写着「本轮未做:创建 datum.rs」—— 任务的全部内容。
       * 前两条判据一条都认不出它,于是父任务的集成验收连着三轮点名 datum.rs 不在,
       * 而回溯的保守名单里**没有它**。
       *
       * 只在这里收(而不是把「自陈未做」升格成 target 判据):它的血统限定在
       * 「父任务的集成验收已经判过不通过」之内。全 run 有 610 个节点自陈未做、607 个
       * 已 ACCEPTED,升格的话按一次 `b` 会把它们连同健康的子树一起重执行一遍 ——
       * 而初级档**明确允许**「验收点之外的边界、额外测试、重构这一轮不做」。
       *
       * 刻意**不**收「已验收但工作区已不在」—— 那正是按过 `c` 键之后的**正常**状态。
       */
      suspects: n.childIds.filter(id => {
        const c = byId.get(id)
        return c !== undefined && (c.status !== 'ACCEPTED' || outputMissing(c) || selfReportedUndone(c))
      }),
    })
  }
  return { target, targets }
}

/** 回溯能派出去的三种重入点。 */
export type BacktrackEntry = 'execute' | 'plan' | 'integrate'

/**
 * **这个节点该从哪一关重来 —— 按它的形态定,不按位置定。**
 *
 * 这一段以前是一行 `level === 2 ? 'plan' : 'execute'`,而它在跑机上有 **34 个**节点会当场
 * 掀翻整次回溯:一个「集成验收没通过、子任务却全绿」的拆分节点,兜底名单里只剩它自己,
 * `planRedo(entry:'execute')` 对拆分任务判 disabled,`composeRedos` 一错**整条不做** ——
 * 屏幕上一行「回溯未执行:这是拆分任务,它自己没有执行环节」,同一批里那些真正该重跑的
 * 节点**一个都没动**。
 *
 * 三条对应关系,每一条都对着 `redoOptions` 的 disabled 判据:
 *  - **执行型** → `execute`:重跑执行环节并注入意见,这是阶梯第 1 级的本义;
 *  - **拆分型(有子任务)** → `integrate`:它自己不干活,能重来的只有那次裁决。
 *    单独重判一次并不会改变证据(`reviseDecomposition` 的注释里写着这件事),所以调用方
 *    **必须同时解开 `revised` 闩** —— 那才是这一格真正买到的东西:下一轮触顶时可以
 *    **长出补救子任务**,也就是用户要的「加新任务」;
 *  - **没有子任务的非执行型**(`kind: 'unknown'`,或子任务被删光的拆分节点)→ `plan`:
 *    它连方案都还没有,`execute`/`integrate` 两条都是 disabled 的。
 *
 * 第 2 级恒走 `plan`(完全重做并重新拆分)—— 那是阶梯的终点,再往上没有更贵的手段。
 */
export function entryFor(node: TaskNode, level: BacktrackLevel): BacktrackEntry {
  if (level === 2) return 'plan'
  if (node.kind === 'executable' && node.childIds.length === 0) return 'execute'
  if (node.childIds.length > 0) return 'integrate'
  return 'plan'
}

/**
 * **保守名单**:主模型缺席(或它一条有效的都没给)时,这一趟按谁来跑。
 *
 * 每个目标 = 它的 suspects;一个 suspect 都没有的目标(叶子,或者子任务全绿的父任务)
 * 就是它自己。重入点由 `entryFor` 按形态定。
 *
 * **导出它是为了让确认屏和执行侧共用同一份**。这个仓库为「两边各算一次」付过账:
 * 用户是照着屏幕按下的确认,而实际发生的可以是另一回事(`cleanupWorktrees`、
 * `backtrackCanClaim` 都为同一条规矩写过注释)。
 */
export function conservativeEntries(
  targets: readonly BacktrackTarget[], byId: ReadonlyMap<string, TaskNode>,
): { nodeId: string; entry: BacktrackEntry; level: BacktrackLevel }[] {
  const out: { nodeId: string; entry: BacktrackEntry; level: BacktrackLevel }[] = []
  const seen = new Set<string>()
  for (const t of targets) {
    for (const id of t.suspects.length > 0 ? t.suspects : [t.node.id]) {
      if (seen.has(id)) continue
      seen.add(id)
      const n = byId.get(id)
      if (!n) continue
      out.push({ nodeId: id, entry: entryFor(n, t.level), level: t.level })
    }
  }
  return out
}

/**
 * 没有集成验收记录时,这个节点为什么被点进来 —— **一句能直接注入执行提示词的话**。
 *
 * 这三格里只有第一格有「意见」可用,而屏幕和送给模型的提示词都无条件写着
 * 「集成验收没通过,它给的意见:」。对另外两格那是**假前提**(规范席点名:这件事今天
 * 对 `outputMissing` 那一格就已经在发生),所以这里给的是那一格自己的真实理由。
 */
function whyWithoutVerdict(n: TaskNode, missing: boolean, stranded: boolean): string {
  if (missing) return '这个任务判了通过,而集成分支上一个字节都没多 —— 产出不在任何地方,只能重新生成'
  if (!stranded) return ''
  const refs = strandedRefsOf(n).slice(0, 3)
  /**
   * **要说清是哪几个文件。**
   *
   * 上一版只带个数,执行者收到的是「还差 3 处」—— 他不知道是哪 3 个,据此动不了手。
   * 而那份清单在 `m` 那一刻就是量出来的,只是被 `.length` 扔掉了。
   */
  const detail = refs.length > 0
    ? refs.map(r => {
      const files = r.paths.length > 0 ? `:${r.paths.slice(0, 8).join('、')}${r.paths.length > 8 ? '…' : ''}` : ''
      return `${r.ref}(还差 ${r.remaining} 处${files};${r.why})`
    }).join(';')
    : '(明细已经不在节点上了)'
  /**
   * **抬头要跟着真实成因走。**
   *
   * 上一版无条件写「合并、加法补录**都试过了**」,而「被后来的版本取代」那一格两级都没试
   * (取代过的那一版里「集成分支上没有」的文件,很可能正是后继版本故意删掉的)。
   * 于是执行者拿到一句自相矛盾的话:「都试过了……(还差 N 处:**没有补录**)」。
   */
  const superseded = refs.some(r => r.why.includes('被后来的版本取代'))
  const lead = superseded
    ? '这个任务此前某一版的产出躺在孤立的分支上,而那一版已经被后来的版本取代,所以没有自动合、也没有补录'
    : '这个任务此前某一版的产出躺在孤立的分支上,合并、加法补录都试过了,仍然没能全部捞回集成分支'
  return `${lead}:${detail}。`
    + '这一次要把那些内容**重新做出来**。'
    /**
     * **不许让他去合那条分支。** 那条路已经被判过了(合不上、或者判定不该合),
     * 而一个执行者顺手 `git merge` 一条被取代的抢救分支,正是这条链最想避免的结局:
     * 一份废稿盖到已经修好的代码上,而解冲突的人不知道右边那半是废稿。
     */
    + '**不要去 git merge / cherry-pick 那条分支** —— 它已经被判过了;'
    + '要用的话只作为参考去读(git show),该怎么实现照这一次的方案来。'
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
 * 所以规矩逐条写死:**定序 → 串接 → side-lists 逐项取并集**。
 *
 * 「任何一次出错整条不做」那一条**已经被推翻**(见下面 `skip()` 那一段):它的理由
 * (不许让用户对着一份说全做了的清单)成立,但要的是**说出来**,不是全盘放弃 ——
 * 跑机上 34 个「集成验收没通过、子任务却全绿」的拆分节点里只要有一个落进这一批,
 * 同一批里真正该重跑的节点一个都不会动。现在改成:逐条跳过 + 逐条记进 `skipped`/`warnings`,
 * **一条都没成才是错误**。
 *
 * 定序按 id 升序:顺序来自模型返回的数组,而 `reopenPropagatedBlocks` 是全树不动点 ——
 * 同一份名单换个顺序会得到不同的树,那是不可测的。
 */
/**
 * 合成的结果 = 一份 `RedoPlan`,外加**这一趟哪几条没派出去**。
 *
 * 单独一个字段而不是让调用方去 `warnings` 里认字符串:`markBacktracked` 的 `reran` 闸
 * 要靠它 —— 给一个**没有被重跑**的节点清掉证据(`rescueStranded` 的注记和载荷),
 * 那条 ref 就此彻底失联,而这正是那个闸当初存在的理由。
 */
export interface ComposedRedo extends RedoPlan {
  skipped: { nodeId: string; reason: string }[]
}

export function composeRedos(
  nodes: readonly TaskNode[],
  entries: readonly { nodeId: string; entry: BacktrackEntry; guidance?: string }[],
  now: string,
  ctxFor?: (node: TaskNode) => RedoContext | undefined,
): ComposedRedo | { error: string } {
  const ordered = [...entries].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  let tree: TaskNode[] = [...nodes]
  /** 已经算成功过几条 —— 决定「一条都没成」时报错还是「部分成功」时带着警告继续。 */
  let applied = 0
  const skipped: { nodeId: string; reason: string }[] = []
  /** 跳过一条:警告给人看,结构化那份给 `markBacktracked` 的 `reran` 闸用。 */
  const skip = (nodeId: string, reason: string): void => {
    skipped.push({ nodeId, reason })
    merged.warnings.push(`跳过 ${nodeId}:${reason}`)
  }
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
    if (!node) {
      skip(e.nodeId, '这棵树里找不到这个节点')
      continue
    }
    /**
     * `preCloned`:第一条之外的每一条都跑在**上一条刚交出来的那棵新树**上,而那棵树是
     * 我们自己的。少了它,N 条 entry = N 次全树 `structuredClone`。
     *
     * **实测**(.13 qianbase-xtp run 001 的真实 2215 个 node.md,在 root 上按一次 `b`
     * = 823 条 entry):复用 **448 ms**,每条重新克隆 **70 987 ms**。后者同步跑在按键
     * 处理里 —— 用户按下 `b` 之后终端整整僵 71 秒,而这期间界面连一帧都不会重画。
     */
    const one = planRedo(tree, e.nodeId, e.entry, now, ctxFor?.(node), { preCloned: applied > 0 })
    /**
     * **算不出来的那一条跳过,不再整条不做。**
     *
     * 原来的规矩是「任何一次出错整条不做」,理由是「做半套 → 一棵部分回溯的树落了盘,
     * 而屏幕上那份清单说的是全部」。那个理由成立,但它要的是**说出来**,不是全盘放弃 ——
     * 而全盘放弃在跑机上是有代价的:34 个「集成验收没通过、子任务却全绿」的拆分节点里
     * 只要有一个落进这一批,同一批里所有真正该重跑的节点**一个都不会动**,
     * 用户看到的只有一行「回溯未执行」。
     *
     * 所以改成:**跳过这一条 + 逐条记进 warnings**(它会一路上到确认屏和问题列表),
     * 而「一条都没成功」仍然是错误 —— 那种情况下没有任何东西可以落盘。
     */
    if ('error' in one) {
      skip(e.nodeId, one.error)
      continue
    }
    applied++
    if (e.guidance && e.guidance.trim().length > 0) {
      const t = one.nodes.find(n => n.id === e.nodeId)
      // 找不到在这条路上不可达(planRedo 成功就意味着它在),但静默丢掉注入的那句话
      // 是这个仓库反复付过代价的那一类。
      //
      // **写到哪个键上跟着入口走**,判据和 `guidanceScopeFor` 逐字相同(任务重做是整节点、
      // 阶段重做是那个环节)。原来无条件写 `'execute'`,而这三条入口现在各不相同:
      // 一个走 `integrate` 的拆分节点自己**不跑执行环节**,那句意见就此谁也读不到 ——
      // 而它恰恰是要发给集成验收席位的整改要求。
      if (t) attachGuidance(t, e.entry === 'plan' ? 'all' : e.entry, e.guidance)
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
  /**
   * **一条都没算成 = 错误**,而不是「一次成功的空回溯」。
   *
   * 这一格不是理论上的:入口全被本次配置跳过(`runsNothing`)、名单里全是拆分节点、
   * 树对不上 —— 三条都会走到这里。返回一份空 plan 的话,调用方会照常落盘、上屏、重启,
   * 而屏幕上写着「已回溯 N 个」。第一条 warning 带着真原因交出去。
   */
  // 空名单**不是错误**:纯函数收到「没有要做的事」就原样交回去(老契约,别处也依赖它)。
  // 「给了名单、一条都没算成」才是错误 —— 那时没有任何东西可以落盘,而调用方会照常
  // 落盘、上屏、重启编排器,屏幕上写着「已重跑 N 个」。
  if (applied === 0 && entries.length > 0) {
    return { error: skipped[0] !== undefined ? `${skipped[0].nodeId}: ${skipped[0].reason}` : '没有一个任务能被重新派出去' }
  }
  return { ...merged, skipped }
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
 *  2. **解开 `revised` 闩**(任何一级,只要目标有子任务)—— 让编排器自己那条已经测过的
 *     `reviseDecomposition` 能在**集成验收再次连续判不通过、到达迭代上限的那一轮**用真 ctx
 *     把补救子任务长出来(它默认每个节点一辈子只补救一次)。
 *
 *  两件事都只落在**这一趟真的有东西被派出去**的目标身上 —— 见 `reran`。
 */
export function markBacktracked(
  plan: RedoPlan, targets: readonly BacktrackTarget[], now: string,
  /**
   * 这一趟**真的被送去重跑**的节点 id。**只管清证据那一步。**
   *
   * 轮次和补救拆分的重新武装照旧落在 target(父任务)身上 —— 阶梯本来就是记在
   * 「集成验收没通过的那个节点」身上的,而真正重跑的是它的子任务,两者本来就不是同一批。
   * 但**证据**不一样:验收席实测过,主模型只点了别的子任务时,那个「捞不回来」的叶子
   * 一次都没重跑,而它的注记被抹掉、载荷被 delete —— 下一次按 b 再也找不到它,
   * 那条 ref 就此彻底失联。清证据的前提只有一个:这一趟真的重跑了它。
   */
  reran?: ReadonlySet<string>,
): { rearmed: string[] } {
  const rearmed: string[] = []
  for (const t of targets) {
    const n = plan.nodes.find(x => x.id === t.node.id)
    if (!n) continue
    /**
     * **这个目标名下一条都没派出去,就不许推进阶梯。**
     *
     * 轮次决定下一次走第几级,而第 2 级是**不可逆**的(删整片子树、重新拆分)。
     * 「跳过算不出来的那一条」这个新行为造出了一条新路径:目标 A 的名单全被跳过、
     * 目标 B 成功,而 A 照样 +1 —— 用户下一次按 `b`,A 直接跳到第 2 级,
     * 而它第一次其实**什么都没发生**。(规范席实测)
     *
     * 判据是「它自己或它名下任意一个 suspect 真的被派出去了」。`reran` 不传时(老调用点)
     * 逐字保持旧行为。
     */
    const dispatched = reran === undefined
      || reran.has(n.id) || t.suspects.some(s => reran.has(s))
    if (!dispatched) continue
    n.backtrack = { rounds: (n.backtrack?.rounds ?? 0) + 1, at: now }
    /**
     * **痕迹在这里被消费掉。**
     *
     * `planRedo` 是 `structuredClone`,`resetForExecute` 只往 `execStatus` **追加**一句
     * REDO 注记、不清空 —— 不清的话这个节点从此每次按 `b` 都被判进来,永远重跑。
     * 清的是**判据**(注记)和载荷两样:载荷留着而判据没了,下一次 `m` 又捞不回来时
     * 会重新写一份完整的。
     */
    /**
     * **有子任务的目标一律重新武装补救拆分,不再只有第 2 级。**
     *
     * 用户要的是「优先触发相应任务重新执行阶段……如果不行,可以完全重做任务**和加新任务**」。
     * 而「加新任务」在这套东西里只有一条实现:`reviseDecomposition` 在集成验收触顶时追加
     * 补救子任务,**每个节点一辈子一次**。把重新武装绑在第 2 级上,等于「加新任务」要
     * 按两次 `b` 才可能发生 —— 而第 1 级(重跑子任务)本来就要重新走一次集成验收,
     * 那正是它该被允许长出补救子任务的时刻。
     *
     * 闸是 `childIds.length > 0`:`reviseDecomposition` 只在 `stepIntegrate` 里调用,
     * 而没有子任务的节点根本不走那一关,给它解闩是一次没有意义的字段写入。
     */
    if (n.revised === true && n.childIds.length > 0) {
      n.revised = false
      rearmed.push(n.id)
    }
    // 清证据排在最后,而且带 `reran` 的闸 —— 上面两件事落在父任务身上,这一件不是。
    if (reran !== undefined && !reran.has(n.id)) continue
    if (n.execStatus.includes(RESCUE_STRANDED_NOTE)) {
      n.execStatus = n.execStatus.split('\n').filter(l => !l.includes(RESCUE_STRANDED_NOTE)).join('\n')
    }
    delete n.rescueStranded
  }
  return { rearmed }
}

/** 确认屏那几行。**是数据,不是 JSX**。 */
export function backtrackLines(
  targets: readonly BacktrackTarget[], entries: readonly { nodeId: string; entry: BacktrackEntry | '' }[],
  /**
   * 这一趟**有没有隔离工作区**。缺省 true 是为了不动既有调用点的语义,但界面必须传。
   *
   * 不接这个参数的后果是实测出来的:共享目录那两档下,这一屏无条件承诺「它们的隔离
   * 工作区会被删掉并从集成分支最新状态重建」—— 而那里既没有工作区也没有集成分支,
   * 而且启动关口自己刚说过「b(回溯)的重新同步……不适用」,同一个产品对同一件事
   * 说两套话。更要紧的是它不只是文案:第 2 级「完全重做」在隔离档下靠 `discard()`
   * 换来干净重编,共享档下 `worktreesToRelease` 恒为空,上一轮写进用户目录的文件
   * **原样留着**,重跑的子任务面对的是脏现场 —— 而用户在按下这个不可逆动作之前
   * 读到的是相反的承诺。
   */
  isolated = true,
  /**
   * id → 标题。**只影响这一屏的可读性**,不给就退回印 id(而 id 是全路径,长得吓人)。
   * 做成回调而不是要一份 `byId`:这个函数的契约是「是数据,不是 JSX」,
   * 而调用方手上本来就有节点表。
   */
  titleOf?: (id: string) => string | undefined,
): string[] {
  const out: string[] = []
  if (targets.length === 0) {
    out.push('这棵子树里没有需要回溯的任务:集成验收都通过了,产出也都在集成分支上,`m` 也没有留下捞不回来的东西。')
    return out
  }
  /**
   * **「为什么重跑」这件事要分开说。** 三格的成因完全不同,而下游动作一样(重跑执行阶段),
   * 于是很容易混成一句「集成验收没通过」—— 那对另外两格是假话,而用户正是据此决定按不按。
   */
  const stranded = targets.filter(t => rescueStranded(t.node))
  if (stranded.length > 0) {
    out.push(`其中 ${stranded.length} 个是因为**产出没能捞回来**(m 键已经把合并和加法补录都试过了):`)
    for (const t of stranded) {
      const refs = strandedRefsOf(t.node).map(r => r.ref).slice(0, 2).join('、')
      out.push(`  · ${t.node.title}${refs ? `(${refs})` : ''} —— 这一次要把那些内容重新做出来`)
    }
    out.push('  它们原来的分支**照样留着**,一个字节都不会删;重跑不是去合那条分支,是重新生成。')
  }
  const lvl1 = targets.filter(t => t.level === 1)
  const lvl2 = targets.filter(t => t.level === 2)
  if (lvl1.length > 0) {
    /**
     * **抬头按 target 数、末尾那行按 entry 数 —— 同一屏两个数字打架。**
     *
     * 接缝席实测:一个「子任务全绿」的父任务在抬头里被算进「走重新执行」,而它买到的
     * 是「只重新裁决」,末尾那行说的是 1 个 —— 而抬头说 2 个。抬头改成**按这一趟真的
     * 会重跑执行的那些 target** 数,拆分型那几个由紧接着的「其中 N 个」那一行认领。
     */
    const rerunTargets = lvl1.filter(t => t.suspects.length > 0 || t.node.childIds.length === 0)
    if (rerunTargets.length > 0) {
      out.push(`${rerunTargets.length} 个任务走**重新执行**:把集成验收的意见注入执行提示词,重跑一遍。`)
    }
    /**
     * **点名的必须是真的会被重跑的那个节点。**
     *
     * 上一版按 `t.node.title` 渲染 —— 而第 1 级真正送去 `planRedo` 的是它的 **suspects**。
     * datum 那个场景下屏幕写的是「· P:datum.rs 不在集成工作区」,而 `P` 是拆分型节点、
     * 一个执行者都不会被派给它;真正要跑的 `P/02` 从头到尾一个字都没出现。
     * 这正是第 2 级分支已经修过、并在下面写了注释钉住的那个 bug ——**第 1 级没跟着改**,
     * 而第 1 级才是用户最常走的那条。(规范席实测)
     */
    for (const t of lvl1) {
      const kids = t.suspects.map(id => titleOf?.(id) ?? id)
      out.push(kids.length > 0
        ? `  · ${t.node.title} 下的 ${kids.length} 个子任务(${clipList(kids)}):${clip(t.blocking)}`
        : `  · ${t.node.title}:${clip(t.blocking)}`)
    }
    /**
     * **子任务全绿的那些父任务,买到的是另一样东西 —— 要在按下之前说清。**
     *
     * 它们没有可以重跑的子任务(保守名单为空),而它们自己是拆分型、没有执行环节。
     * 这一格发生的是「重新裁决一次 + 重新开放补救拆分」,也就是用户说的「加新任务」那条路。
     * 不说的话,屏幕承诺的是「重跑一遍执行」,而实际一个执行者都不会被派出去。
     */
    const judgeOnly = lvl1.filter(t => t.suspects.length === 0 && t.node.childIds.length > 0)
    if (judgeOnly.length > 0) {
      out.push(
        `  其中 ${judgeOnly.length} 个的子任务**全部已验收**:没有可重跑的子任务,` +
        '它们走的是「重新裁决一次集成验收」+ **重新开放补救拆分**(下一轮可以给它加新的子任务)。',
      )
    }
  }
  if (lvl2.length > 0) {
    /**
     * **第 2 级点的是子任务,不是这个父任务。**
     *
     * 验收实测:上一版按 `t.node` 渲染并印它的 `childIds.length` —— 而 `runBacktrack`
     * 真正送去 `planRedo(entry:'plan')` 的是它的 **suspects(子任务)**。屏幕说
     * 「删 root 的 3 个子任务」,实际删的是 **c1 的 2 个**,root 的 3 个一个没动。
     * 而这一段上面那句注释正写着「第 2 级会删子树,**数量必须写出来**」。
     */
    out.push(`${lvl2.length} 个任务下面的子任务走**完全重做**(此前已经重新执行过一轮,仍然没通过):`)
    for (const t of lvl2) {
      const kids = t.suspects.length > 0 ? t.suspects : [t.node.id]
      out.push(`  · ${t.node.title} 下的 ${kids.length} 个子任务:重新分析并拆分(会先删掉它们各自的子任务)`)
      /**
       * **「加新任务」到底是什么,必须在**按下之前**说清。**
       *
       * 验收(规范席)判它是一次曲解:用户说的是「完全重做任务**和**加新任务」,而落地的是
       * 「解开一次补救拆分的机会,由**之后那次集成验收**决定加不加、加什么」。回溯本身对此
       * 零控制。这个实现是有理由的(`createChildren` 要 `PipelineCtx` 的原子预留,
       * 按键处理里手搓一个等于把 `maxNodes` 静默关掉),但**理由不能替代告知** ——
       * 结果屏此前诚实地写了「下一轮集成验收**可以**给它们加新的子任务」,而那是按完之后。
       */
      out.push('    并重新开放一次「补救拆分」:之后集成验收**再次连续判不通过、到达迭代上限的那一轮**,'
        + '可以给它加新的子任务(加不加、加什么由那一轮决定)。')
      if (t.remedy.length > 0) {
        out.push(`    集成验收此前提过的补救项:${t.remedy.slice(0, 3).join('、')}${t.remedy.length > 3 ? '…' : ''}`)
      }
    }
  }
  /**
   * **这个数是估的,必须说出口。**
   *
   * 屏幕算的是保守名单,而执行时**主模型会重新圈一遍**(它读的是已经写下来的验收意见)。
   * 两边不一致不是缺陷 —— 缺陷是让用户以为它一致,而下游是 discard(删目录、删分支、
   * 全量重编)。
   */
  /**
   * 三类分开数。原来只有「重跑执行 / 完全重做」两个数,而它是按 `lvl2Ids` **反推**的 ——
   * 拆分型节点走的那条「只重新裁决」被算进了「重跑执行阶段」,屏幕上承诺的执行者
   * 一个都不会被派出去。现在的 `entry` 是 `entryFor` 给的真值(和执行侧同一份),直接数。
   */
  const execCount = entries.filter(e => e.entry === 'execute').length
  const planCount = entries.filter(e => e.entry === 'plan').length
  const judgeCount = entries.filter(e => e.entry === 'integrate').length
  out.push(
    `按现在的证据算:${execCount} 个任务重跑执行阶段、${planCount} 个完全重做` +
    (judgeCount > 0 ? `、${judgeCount} 个只重新裁决集成验收(并重新开放补救拆分)` : '') + ';' +
    (isolated
      ? '它们的隔离工作区会被删掉并从集成分支最新状态重建。'
      : '这一趟没有隔离工作区,所以**不会删任何目录、也没有重新同步这一步** —— 上一轮写进你工作目录的文件原样留着,重跑是在这些文件之上继续改。'),
  )
  out.push('确认之后会先派主模型读一遍集成验收的意见,**具体重跑哪几个可能和上面这份不同**(它拿不到模型时就照这份走)。')
  // 这一句是这个键和 `r` 最不一样的地方:它**不开圆桌**,判决仍然由之后的集成验收给出。
  out.push('不会开新的圆桌:用的是集成验收**已经写下来**的意见;最终结论仍由子任务修完后的集成验收给出。')
  return out
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s) || '(没有留下意见)'
/** 名单只印前几个 —— 而**印了几个、还剩几个**要说出来(不静默截断)。 */
const clipList = (xs: readonly string[], n = 3): string =>
  xs.length <= n ? xs.join('、') : `${xs.slice(0, n).join('、')}…另 ${xs.length - n} 个`
