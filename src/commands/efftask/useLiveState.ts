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
