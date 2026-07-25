/**
 * 全局并发池 (spec §6):
 *   "并发池:自持 activeCount,上限 = config.parallelism(默认 5)。…评审/验收的多角色调用
 *    在单节点内并行,但**受同一全局池约束,避免总并发爆炸**。"
 *
 * The second half was not implemented. `running` counted STEPS, and one step's roundtable
 * then fanned out to every bound role at once through `Promise.allSettled` — uncounted.
 * Measured: parallelism 2 with 3 reviewers per roundtable produced a peak of 6 concurrent
 * `runAgent` calls; the shipped default of 5 with a 3-role panel is 15. A user who lowers the
 * number to control spend gets |roles|× whatever they asked for, and the confirmation gate is
 * the only place that number is ever explained to them.
 *
 * DEADLOCK is the reason this is a try-lease and not a blocking semaphore. A step already
 * holds a slot while its roundtable runs; at parallelism 1 a reviewer that BLOCKS waiting for
 * a slot waits for the step that is waiting for it. So extra reviewers take a slot only if one
 * is free right now, and otherwise run after the ones that got one. Concurrency stays inside
 * the cap; nothing ever waits on a slot it could be holding.
 */
export interface Slot {
  release(): void
}

export interface SlotPool {
  /** Take a slot unconditionally — used by the scheduler, which has already budgeted for it. */
  take(): Slot
  /** Take a slot ONLY if one is free. Returns null otherwise; never waits. */
  tryTake(): Slot | null
  /** Slots currently held, by steps and reviewers alike. */
  inUse(): number
}

export function createSlotPool(limit: () => number): SlotPool {
  let inUse = 0
  const slot = (): Slot => {
    // Single-shot: a double release would let the pool hand out more than `limit`, and
    // clamping at zero would hide that rather than surface it.
    let released = false
    return { release() { if (released) return; released = true; inUse-- } }
  }
  return {
    take() { inUse++; return slot() },
    tryTake() {
      if (inUse >= Math.max(1, limit())) return null
      inUse++
      return slot()
    },
    inUse: () => inUse,
  }
}

/**
 * Run `items` concurrently, but only as widely as the pool can afford.
 *
 * The FIRST item always runs immediately and takes no slot: its caller (a pipeline step) is
 * already holding one, and that is what makes this deadlock-free at parallelism 1. Every other
 * item runs in parallel if it can lease a slot, and otherwise waits for that first wave and
 * then tries again — so a full pool degrades a roundtable to serial rather than blocking it.
 *
 * Order is preserved in the result, because `synthesizeVerdicts` and the acceptance record
 * both read role-by-role.
 */
export async function mapWithinPool<T, R>(
  items: T[],
  run: (item: T, index: number) => Promise<R>,
  pool?: SlotPool,
): Promise<PromiseSettledResult<R>[]> {
  if (!pool || items.length <= 1) {
    return Promise.allSettled(items.map((it, i) => run(it, i)))
  }
  const out = new Array<PromiseSettledResult<R>>(items.length)
  const settle = async (it: T, i: number, slot: Slot | null): Promise<void> => {
    try {
      out[i] = { status: 'fulfilled', value: await run(it, i) }
    } catch (reason) {
      out[i] = { status: 'rejected', reason }
    } finally {
      slot?.release()
    }
  }
  let pending = items.map((it, i) => ({ it, i }))
  let first = true
  while (pending.length > 0) {
    const wave: Promise<void>[] = []
    const deferred: typeof pending = []
    for (const entry of pending) {
      // The free ride, exactly once per call: the caller's own slot covers it.
      if (first) { first = false; wave.push(settle(entry.it, entry.i, null)); continue }
      const slot = pool.tryTake()
      if (slot) wave.push(settle(entry.it, entry.i, slot))
      else deferred.push(entry)
    }
    // A wave always contains at least one entry — the free ride on the first pass, and on
    // later passes at least one slot must have been freed by the wave that just finished.
    // Without that guarantee this would spin.
    if (wave.length === 0) {
      const entry = deferred.shift()!
      wave.push(settle(entry.it, entry.i, null))
    }
    await Promise.all(wave)
    pending = deferred
  }
  return out
}
