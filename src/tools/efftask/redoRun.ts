import { attachGuidance, planForcePass, planRedo, planSkip, type RedoContext, type RedoEntry, type RedoPlan } from './redo.js'
import { affectedByRedo } from './liveRedo.js'
import type { PhaseName, TaskNode } from './types.js'

/**
 * 一次重做从「用户按下确认」到「编排器重新跑起来」之间的全部动作。
 *
 * 这段本来长在 `efftask.tsx` 的 useCallback 里。搬出来的理由和 `redoCommit.ts` 一样,
 * 但这次是被验收**量出来的**:那个文件挂不起来,于是唯一的防线是 wiringCoverage 里
 * 六条 `SRC.toContain(...)` 源码文本断言 —— 而验收把每一个被断言的字符串**原样留着**,
 * 造出了 14 条变异,全部存活:
 *
 *  - problems 算出来了但不上屏;
 *  - 新树算出来了但不进 state(界面还显示旧树);
 *  - `startRun(cfg, computed.nodes)` 这行字留着,外面套一层 `if (false)`;
 *  - 落盘和重启的顺序对调;
 *  - commitRedo 整个不可达;
 *  - 交给 commitRedo 的 `before` 传成**重做后**的节点(于是 release 拿不到被删节点);
 *  - 取消之后不回 done(界面卡在关口)。
 *
 * 每一条的用户可见后果都是「按下确认之后界面纹丝不动 / 树没落盘 / 工作区一个不放」,
 * 而全套测试绿。所以这里的每一步都做成**可注入的回调**,由 redoRun.test.ts 真的调用一次
 * 并断言顺序与参数。
 */
export interface RedoRunDeps {
  /** 落盘。返回这次重做**没做成**的事。 */
  commit: (plan: RedoPlan, before: readonly TaskNode[]) => Promise<{ problems: string[] }>
  /** 把没做成的事交给界面。空数组也要交 —— 否则上一次的警告会一直挂着。 */
  onProblems: (problems: string[]) => void
  /** 新树进 state。不做这一步,界面显示的还是重做前那棵。 */
  onNodes: (nodes: TaskNode[]) => void
  /**
   * 被删掉的那些节点的**历史运行记录**也一并扔掉。
   *
   * 用户报的现象:「重做其父任务,但是其子任务的历史运行记录还有,未完全删除掉。」
   * 子树从内存和磁盘上都删干净了,而实时输出是按 nodeId 存在另一个活存储里的 ——
   * 没有任何东西通知它。更要命的是 `childId` 由「父id + 序号 + 标题 slug」算出:
   * 同一个父节点重新拆一次,新子节点的 id 常常和被删的那个**逐字相同**,于是上一轮的
   * 输出会挂到新节点的详情页上。
   *
   * 做成 deps 上的一个回调,和这里的其他五步同因:它长在 efftask.tsx 里的话,唯一的
   * 防线又会变成源码文本断言,而那种断言证明不了「这一步真的被调用过、而且带着对的参数」。
   */
  onDropStreams?: (nodeIds: readonly string[]) => void
  /**
   * 让新树真的跑起来。**这是整个功能的目的**,少了它重做只是改了改树。
   *
   * 两条路共用这一个口子(见 liveRedo.ts):结束屏那条起一个新编排器;运行中那条把新树
   * 并进正在跑的那一棵,而它需要 `affected` —— 所以这个参数在这里,不在调用方各自重算。
   */
  start: (nodes: TaskNode[], affected: readonly string[]) => void
  /**
   * 落盘**之前**问一次「这次重做现在能不能做」,并且**把它要动的节点扣下来**。
   *
   * 运行中重做专用。为什么必须在落盘之前:算新树和落盘之间隔着一次 await,调度循环完全
   * 可能在那期间把其中一个节点派出去(最真实的是被放回的祖先——别的子任务恰好这时跑完)。
   * 等到换树那一刻才发现就晚了:盘上已经写完,磁盘是新树、内存是旧树,而屏幕说重做成功。
   *
   * 返回一句话 = 不能做,这次重做**什么都不会发生**(planXxx 是纯函数,到这里盘上一个
   * 字节都没动过)。返回 undefined = 扣住了,由调用方在 `start` 之后释放。
   */
  canApply?: (affected: readonly string[]) => string | undefined
  /** 关掉关口、回到 done 视图。 */
  onDone: () => void
}

export async function runRedo(
  nodes: readonly TaskNode[],
  targetId: string,
  entry: RedoEntry,
  now: string,
  deps: RedoRunDeps,
  // 关口预演用的是同一份 ctx。不传下来的话「屏幕上算给你看的」和「真的执行的」会是
  // 两次不同的计算 —— 而用户是照着屏幕做的决定。
  ctx?: RedoContext,
  /**
   * 用户在关口上补的那句提示词,以及它给谁(`'all'` = 给整个节点)。
   *
   * 写在 `planRedo` **之后**、落盘**之前**:planRedo 会克隆整棵树,补充指引写在克隆出来的
   * 那个目标节点上,于是它和这次重做在同一次 `commit` 里一起落盘。写在 planRedo 之前
   * (改传进来的 nodes)就是改调用方手里那份 state —— 而它是 React state。
   */
  guidance?: { scope: PhaseName | 'all'; text: string },
): Promise<void> {
  const computed = planRedo(nodes, targetId, entry, now, ctx)
  if ('error' in computed) {
    // 算不出来就**什么都不做**:planRedo 是纯函数,到这里盘上一个字节都没动过。
    // 关口关掉、把原因显示出来,用户可以换一个环节再试。
    deps.onProblems([`重做未执行: ${computed.error}`])
    deps.onDone()
    return
  }
  const affected = affectedByRedo(computed, targetId)
  const blocked = deps.canApply?.(affected)
  if (blocked) {
    // 和 planRedo 出错那一支同一个立场:盘上一个字节都没动过,所以说清原因、关掉关口,
    // 用户可以先去处理那个正在跑的节点再回来。
    deps.onProblems([`重做未执行: ${blocked}`])
    deps.onDone()
    return
  }
  if (guidance && guidance.text.trim().length > 0) {
    const target = computed.nodes.find(n => n.id === targetId)
    // 找不到目标节点在这条路上不可达(planRedo 成功就意味着它在),但静默丢掉用户亲手写的
    // 那句话是这个仓库反复付过代价的那一类,所以宁可说出来。
    if (target) attachGuidance(target, guidance.scope, guidance.text)
    else deps.onProblems([`补充指引没能写上:重做后的树里找不到节点 ${targetId}`])
  }
  // `before` 必须是**重做前**的节点:commitRedo 要拿它们算隔离工作区的路径和分支,
  // 而 computed.nodes 里被删的那些已经不在了 —— 传错的话工作区一个都放不掉,而且
  // 不会有任何报错。
  const { problems } = await deps.commit(computed, nodes)
  deps.onProblems(problems)
  /**
   * 历史运行记录跟着节点一起走。**排在 `onNodes` 之前** —— 那一句会让界面立刻用新树重画,
   * 而重画时详情页要按 nodeId 去取流:先换树后删流,中间那一帧里,一个刚建出来的新节点
   * 会显示上一轮同名节点的输出。差一帧也是说假话。
   */
  if (computed.deleted.length > 0) deps.onDropStreams?.(computed.deleted)
  deps.onNodes(computed.nodes)
  // 落盘在前、重启在后。反过来的话编排器会在一棵还没写下去的树上开跑,
  // 中途崩溃就什么都恢复不了。
  deps.start(computed.nodes, affected)
}

/**
 * 一次「跳过失败的环节」从确认到重新跑起来之间的全部动作。
 *
 * 和 `runRedo` 共用同一套 deps,而且**刻意**共用:两者在这一段上做的事逐字相同
 * (落盘 → 上屏 → 进 state → 重启编排),而那六步里漏掉任何一步的后果都是
 * 「按下确认之后界面纹丝不动」—— 那正是 runRedo 的注释里记着的、验收造出 14 条存活变异的
 * 那一组。第二份实现意味着第二次踩同一组坑。
 *
 * 唯一的区别是怎么算出新树:`planSkip` 而不是 `planRedo`。
 */
export async function runSkip(
  nodes: readonly TaskNode[],
  targetId: string,
  now: string,
  deps: RedoRunDeps,
  ctx?: RedoContext,
  guidance?: { scope: PhaseName | 'all'; text: string },
): Promise<void> {
  return runPastFailedPhase(nodes, targetId, now, 'skip', deps, ctx, guidance)
}

/**
 * 一次「强制通过失败的环节」从确认到重新跑起来之间的全部动作。
 *
 * 和 `runSkip` 共用实现,理由和它自己的注释逐字相同:那六步(落盘 → 上屏 → 进 state →
 * 重启编排)漏掉任何一步的后果都是「按下确认之后界面纹丝不动」,而第二份实现意味着
 * 第二次踩同一组坑。唯一的区别是算新树用 `planForcePass`,以及出错时那句话叫什么。
 */
export async function runForcePass(
  nodes: readonly TaskNode[],
  targetId: string,
  now: string,
  deps: RedoRunDeps,
  ctx?: RedoContext,
  guidance?: { scope: PhaseName | 'all'; text: string },
): Promise<void> {
  return runPastFailedPhase(nodes, targetId, now, 'forcePass', deps, ctx, guidance)
}

async function runPastFailedPhase(
  nodes: readonly TaskNode[],
  targetId: string,
  now: string,
  mode: 'skip' | 'forcePass',
  deps: RedoRunDeps,
  ctx?: RedoContext,
  guidance?: { scope: PhaseName | 'all'; text: string },
): Promise<void> {
  const what = mode === 'forcePass' ? '强制通过' : '跳过'
  const computed = mode === 'forcePass'
    ? planForcePass(nodes, targetId, now, ctx)
    : planSkip(nodes, targetId, now, ctx)
  if ('error' in computed) {
    deps.onProblems([`${what}未执行: ${computed.error}`])
    deps.onDone()
    return
  }
  const affected = affectedByRedo(computed, targetId)
  const blocked = deps.canApply?.(affected)
  if (blocked) {
    deps.onProblems([`${what}未执行: ${blocked}`])
    deps.onDone()
    return
  }
  if (guidance && guidance.text.trim().length > 0) {
    const target = computed.nodes.find(n => n.id === targetId)
    if (target) attachGuidance(target, guidance.scope, guidance.text)
    else deps.onProblems([`补充指引没能写上:${what}后的树里找不到节点 ${targetId}`])
  }
  // `before` 同样是**跳过前**的节点 —— commitRedo 拿它算隔离工作区的路径和分支。
  // 跳过通常一个工作区都不放(deleted 恒为空),但「从质疑讨论跳过」那一条在执行型节点上
  // 会走 resetForExecute,那时是有工作区要放的。
  const { problems } = await deps.commit(computed, nodes)
  deps.onProblems(problems)
  // 跳过/强制通过通常一个节点都不删(deleted 恒为空),但走的是同一套 deps ——
  // 判据放在 `deleted` 上而不是入口上,以后哪条路开始删节点都不会漏。
  if (computed.deleted.length > 0) deps.onDropStreams?.(computed.deleted)
  deps.onNodes(computed.nodes)
  deps.start(computed.nodes, affected)
}
