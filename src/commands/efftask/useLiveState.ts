import * as React from 'react'

/**
 * State that a key handler both READS and WRITES.
 *
 * A plain `useState` value is not enough here. The vendored renderer splits one stdin chunk
 * into several InputEvents and dispatches them SYNCHRONOUSLY, while `useInput`'s handler is
 * only swapped in a post-commit `useLayoutEffect` — so the second key of a chunk still runs
 * the PREVIOUS render's closure. Measured on the startup gate: `↓` and `空格` arriving
 * together bound the role to 方案 while the cursor was rendered on 评审, and `→` + `回车`
 * confirmed a parallelism one lower than the screen showed.
 *
 * The ref is the source of truth for the handler; the state exists only to trigger a repaint.
 *
 * Shared rather than copied: both confirmation gates edit a roster from inside a `useInput`
 * handler, and the renderer behaviour that makes this necessary is a property of the renderer,
 * not of either gate. A second copy would be a second thing to forget.
 */
export function useLiveState<T>(initial: T): [T, (next: T | ((cur: T) => T)) => void, React.RefObject<T>] {
  const [value, setValue] = React.useState(initial)
  const ref = React.useRef(initial)
  const set = React.useCallback((next: T | ((cur: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (c: T) => T)(ref.current) : next
    ref.current = resolved
    setValue(resolved)
  }, [])
  return [value, set, ref as React.RefObject<T>]
}

/**
 * 关口的「只结算一次」闩 —— 一个关口一辈子只许把决定发出去**一次**。
 *
 * 和 `useLiveState` 同一个渲染器事实,后果重得多:一次按键**不会**在处理器返回时就把组件
 * 卸载掉。卸载要等 React 提交下一帧,而在那之前到来的每一下回车都会再跑一遍同一个
 * 处理器、再发一次同一个回调。用户侧的样子就是「连按了两下确认」。
 *
 * 这不是假想。根方案关口为它单独立过一个 `rootDecided` ref,注释里记着实测:三下快回车
 * **在同一个 run 目录上起了三个编排器**——8 次模型调用而不是 4 次、一份 node.md 被写 12 遍,
 * 隔离运行下第二次 acquire() 还会把第一轮在飞的产出停到一条 salvage 引用上。重做/跳过/
 * 强制通过/收口这四个关口是一样的形状,却各自都没有这道闩:重做那条走的是
 * `applyRedo → runRedo → startRun`,于是**同一次重做起两个编排器**,两个池子各自守着
 * 用户设的并发上限(于是实际并发翻倍),两边又各自把自己那棵树推给同一个 `setNodes`
 * ——「最上面那几个数字一会儿高一会儿低」正是这么来的。
 *
 * 所以这道闩是共享的:关口会继续增加,而「决定只发一次」是它们共同的性质,不是某一屏的。
 * 确认和取消**共用同一个闩** —— 它们都是这一屏的出口,发过一个就不该再发另一个。
 */
export function useSettleOnce(): (decide: () => void) => void {
  const settled = React.useRef(false)
  return React.useCallback((decide: () => void) => {
    if (settled.current) return
    settled.current = true
    decide()
  }, [])
}

/**
 * 「此刻有几次工具权限确认在等人回答」。
 *
 * **计数,不是布尔。** 并行度大于 1 时可以同时有几个执行节点各自等一个确认;用布尔的话,
 * 其中一个被回答完就会把面板的键盘放回来,而屏幕上还有下一个对话框 —— 回车照样会同时
 * 批准工具**和**打开节点详情,也就是这个函数要修的那个 bug 只修好了一半。
 *
 * 返回的 `begin` / `end` 是给 runAgentAdapter 的 canUseTool 包装用的边沿;`waiting`
 * 供渲染。ref 那一路是因为边沿可能在一次 render 提交之前连着来两下。
 */
export function useHumanWaitCount(): {
  waiting: boolean
  begin: () => void
  end: () => void
} {
  const [count, setCount, ref] = useLiveState(0)
  const begin = React.useCallback(() => { setCount(ref.current + 1) }, [setCount, ref])
  // 夹在 0:一次多余的 end(重复回调、或者将来某处补发)不能让计数变成负数 ——
  // 那会让**后面所有**的确认都不再挂起面板,而且没有任何迹象。
  const end = React.useCallback(() => { setCount(Math.max(0, ref.current - 1)) }, [setCount, ref])
  return { waiting: count > 0, begin, end }
}
