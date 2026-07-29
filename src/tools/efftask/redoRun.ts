import { planRedo, type RedoContext, type RedoEntry, type RedoPlan } from './redo.js'
import type { TaskNode } from './types.js'

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
  /** 重新启动编排。**这是整个功能的目的**,少了它重做只是改了改树。 */
  start: (nodes: TaskNode[]) => void
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
): Promise<void> {
  const computed = planRedo(nodes, targetId, entry, now, ctx)
  if ('error' in computed) {
    // 算不出来就**什么都不做**:planRedo 是纯函数,到这里盘上一个字节都没动过。
    // 关口关掉、把原因显示出来,用户可以换一个环节再试。
    deps.onProblems([`重做未执行: ${computed.error}`])
    deps.onDone()
    return
  }
  // `before` 必须是**重做前**的节点:commitRedo 要拿它们算隔离工作区的路径和分支,
  // 而 computed.nodes 里被删的那些已经不在了 —— 传错的话工作区一个都放不掉,而且
  // 不会有任何报错。
  const { problems } = await deps.commit(computed, nodes)
  deps.onProblems(problems)
  deps.onNodes(computed.nodes)
  // 落盘在前、重启在后。反过来的话编排器会在一棵还没写下去的树上开跑,
  // 中途崩溃就什么都恢复不了。
  deps.start(computed.nodes)
}
