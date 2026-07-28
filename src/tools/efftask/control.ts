/**
 * 运行中的人工干预面:**暂停**、**追加指令**、**取消单个节点**。
 *
 * 在这之前,运行中唯一能做的事是 Esc —— 而它的粒度是整个 run。用户的原话是
 * 「任务正在运行怎么取消,可以用提示词修正这个任务怎么做不」:两件事都要,而且都不该
 * 是「把整轮炸掉重来」。
 *
 * 三件事放在一个对象里,因为它们共享同一个生命周期(一次 run),而且 UI 那侧是同一批
 * 按键。但**内部互不耦合**:暂停不影响在飞的调用,取消不影响别的节点,追加指令只作用于
 * 之后派发的提示词。
 */

/** 一次 run 的人工干预面。 */
export interface RunControl {
  // ---- 暂停 ----
  isPaused(): boolean
  pause(): void
  resume(): void
  /**
   * 等到被恢复为止。
   *
   * 已经不是暂停态时**立刻**返回 —— 否则调度循环会在一次「暂停又马上恢复」的竞态里
   * 永远等下去(恢复的通知在它开始等之前就发完了)。
   */
  waitForResume(): Promise<void>

  // ---- 追加指令 ----
  /** 用户在运行中补的一句话。作用于**之后**派发的提示词,不打断在飞的调用。 */
  addDirective(text: string): void
  /** 当前累积的全部追加指令,按加入顺序。 */
  directives(): readonly string[]

  // ---- 取消单个节点 ----
  /**
   * 登记一次在飞的调用,好让 cancelNode 能中止它。返回注销函数。
   *
   * 必须在 finally 里注销:留着的话,一个早就结束的 controller 会一直挂在表里,
   * 而后来对同一节点的取消会去 abort 它 —— 无害但会掩盖「这个节点此刻根本没在跑」。
   */
  registerCall(nodeId: string, controller: AbortController): () => void
  /** 中止该节点此刻在飞的全部调用,并记下它被取消过。 */
  cancelNode(nodeId: string): void
  /** 这个节点被用户取消过吗 —— 用来把它和超时/provider 故障区分开。 */
  wasCancelled(nodeId: string): boolean
  /** 节点重新开跑时清掉标记。 */
  clearCancel(nodeId: string): void
  /**
   * 清掉**全部**取消标记 —— 一次新的编排开始时调。
   *
   * 必须有:同会话里按 r 重做走的是 applyRedo → startRun → runOrchestrator,用的是
   * **同一个** RunControl,而 redo 是原地重置节点、**id 不变**。不清的话 registerCall
   * 一登记就发现该 id 在 cancelled 里,立刻 abort → 又抛 NodeCancelledError:
   * 用户按 r 之后界面闪一下,节点又变回 BLOCKED,理由还是那句「可以在结束屏上按 r 重做」
   * —— 阻断信息本身在推荐一条已经死掉的路。评审实测复现过。
   */
  clearAllCancels(): void
}

/** 一条追加指令的长度上限。整段提示词是要付钱的,而用户可能粘一整个文件进来。 */
export const MAX_DIRECTIVE_CHARS = 2000
/** 最多累积多少条。再多就把最早的挤掉 —— 但**不静默**,见 directives 的注释。 */
export const MAX_DIRECTIVES = 20

export function createRunControl(): RunControl {
  let paused = false
  /** 等着被恢复的那些人。恢复时一次性全部放行。 */
  let waiters: (() => void)[] = []
  const directives: string[] = []
  let dropped = 0
  /** nodeId → 此刻在飞的 controller。一个节点可能同时有多个(圆桌的多席位)。 */
  const calls = new Map<string, Set<AbortController>>()
  const cancelled = new Set<string>()

  return {
    isPaused: () => paused,
    pause() { paused = true },
    resume() {
      paused = false
      const w = waiters
      waiters = []
      for (const fn of w) {
        // 一个抛异常的等待者不能把别的等待者一起卡住 —— 它们各自是独立的调度循环。
        try { fn() } catch { /* 调用方自己的问题 */ }
      }
    },
    waitForResume() {
      // 已经恢复了就立刻返回。少了这一句,「暂停 → 立刻恢复 → 循环才开始等」会永久挂起:
      // 恢复的通知在它注册之前就发完了。
      if (!paused) return Promise.resolve()
      return new Promise<void>(res => { waiters.push(res) })
    },

    addDirective(text) {
      const t = text.trim().slice(0, MAX_DIRECTIVE_CHARS)
      if (t.length === 0) return
      directives.push(t)
      // 挤掉最早的,并记下挤掉了几条 —— 静默丢弃用户亲手写的话是这个仓库反复付过代价的
      // 那一类:他会以为它生效了。
      while (directives.length > MAX_DIRECTIVES) {
        directives.shift()
        dropped++
      }
    },
    directives() {
      if (dropped === 0) return directives
      // 说出来。用户加过 25 条时,前 5 条不在提示词里,而他没有任何办法知道。
      return [`(较早的 ${dropped} 条追加指令因数量上限已被丢弃)`, ...directives]
    },

    registerCall(nodeId, controller) {
      const set = calls.get(nodeId) ?? new Set()
      set.add(controller)
      calls.set(nodeId, set)
      // 登记的**当下**就已经被取消过的话,立刻中止:取消请求和新一轮派发可能撞在一起,
      // 而那一轮本来就不该跑。
      if (cancelled.has(nodeId)) {
        try { controller.abort() } catch { /* 已经 abort 过 */ }
      }
      let off = false
      return () => {
        if (off) return
        off = true
        const s = calls.get(nodeId)
        if (!s) return
        s.delete(controller)
        if (s.size === 0) calls.delete(nodeId)
      }
    },
    cancelNode(nodeId) {
      cancelled.add(nodeId)
      for (const c of calls.get(nodeId) ?? []) {
        try { c.abort() } catch { /* 已经 abort 过 */ }
      }
    },
    wasCancelled: nodeId => cancelled.has(nodeId),
    clearCancel(nodeId) { cancelled.delete(nodeId) },
    clearAllCancels() { cancelled.clear() },
  }
}
