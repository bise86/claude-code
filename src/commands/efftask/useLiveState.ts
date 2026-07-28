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
