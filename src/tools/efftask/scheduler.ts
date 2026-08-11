import { advanceableKind, isTerminal } from './stateMachine.js'
import type { TaskNode } from './types.js'

export interface StallTracker { note(id: string, status: string): number; clear(id: string): void }

/**
 * Per-node no-progress counter.
 *
 * The serial orchestrator used ONE global fingerprint ("was the same node picked twice in a
 * row?"). That is meaningful only while exactly one node moves at a time: with N steps in
 * flight, any other node completing resets it, so a node that cannot progress spins forever
 * issuing real model calls — the guard becomes decorative exactly when it is needed. Keyed
 * per node, it means the same thing under any concurrency.
 *
 * NOTE this is defence in depth: no current state-machine path can actually trigger it
 * (every step leaves its node terminal, or at READY/WAITING_CHILDREN, neither re-pickable in
 * the same status). Don't over-invest — but DO keep it reachable on the failure path, which
 * is the one way it could ever be needed.
 */
export function createStallTracker(): StallTracker {
  const seen = new Map<string, { fingerprint: string; count: number }>()
  return {
    note(id, status) {
      const prev = seen.get(id)
      const next = prev && prev.fingerprint === status ? prev.count + 1 : 1
      seen.set(id, { fingerprint: status, count: next })
      return next
    },
    clear(id) { seen.delete(id) },
  }
}

/**
 * 祖先里有没有 BLOCKED 的。
 *
 * **导出**是因为依赖重算的关口要分辨两件长得很像的事:「它在等依赖」和「它上面已经死了」。
 * 前者重算有用,后者按多少次 `d` 都不会发生任何事 —— 而屏幕必须说得出差别。
 */
export function hasBlockedAncestor(node: TaskNode, byId: Map<string, TaskNode>): boolean {
  // `seen` is not defensive dressing: a parent/child cycle really can come back from disk,
  // and without it this walk never terminates.
  const seen = new Set<string>()
  let cur = node.parentId ? byId.get(node.parentId) : undefined
  while (cur && !seen.has(cur.id)) {
    if (cur.status === 'BLOCKED') return true
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return false
}

export type Advanceable = { node: TaskNode; kind: 'start' | 'execute' | 'integrate' }

/**
 * **这个节点此刻为什么推进不了** —— 一句话,或 `undefined`(= 推得动)。
 *
 * 存在的理由是「别造第二份判据」。依赖重算的关口要回答两个问题:「它此刻真的被挡着吗」
 * (不被挡就没有并发可买)和「改完之后它当场跑得起来吗」(那是这个功能唯一的成功指标)。
 * 拿 `depsSatisfied` 单独去答,两句话都会在**祖先阻断**上说谎:一个祖先 BLOCKED 的节点
 * 依赖全满足也永远不会被 `pickBatch` 选中,而屏幕会写着「它马上就会被调度」。
 * `hasBlockedAncestor` 原本是本模块私有的,于是外面只有「抄一份」这一条路 ——
 * 而这个仓库为「同一条判据的第二份」反复付过账。
 *
 * `pickBatch` 自己也走它,所以两边不可能分叉。
 */
export function notSchedulableReason(
  node: TaskNode,
  byId: Map<string, TaskNode>,
  // `held` 不单独收:编排器把被扣住的节点**折进了同一个集合**
  // (`pickBatch(…, new Set([...inFlight.keys(), ...this.held]), …)`),再开一个形参
  // 只会得到一个永远没有实参的分支 —— 而这个仓库刚为「不可达分支」付过一轮验收。
  opts?: {
    inFlight?: ReadonlySet<string>
    /**
     * 这一趟有没有隔离工作区。**没有 = 执行环节被强制串行**,而 `pickBatch` 看不见这件事:
     * 互斥住在编排器的 `launch()` 里(`executeChain`),被挑中的节点照样进队列,只是**排队**。
     *
     * 所以「推得动」这个判断在共享工作树下必须多问一句 —— 否则关口会对着一个排在
     * 单线队列后面的节点说「马上就会被调度」,而那正是用户报的那一句
     * (跑机 qianbase-xtp run 001:44 个 READY、恒 1 席在飞)。
     */
    serialExecute?: boolean
  },
): string | undefined {
  if (opts?.inFlight?.has(node.id) === true) return '此刻正在运行(或被另一次操作扣住)'
  if (isTerminal(node.status)) return `已经是终态(${node.status})`
  if (hasBlockedAncestor(node, byId)) return '上级任务已阻断 —— 它的整棵子树都不会再被调度'
  /**
   * 执行互斥。**排在 `advanceableKind` 之后**判(下面那个 if 里),不能提到这儿:
   * 一个还在等依赖的节点,拒绝理由该是「等依赖」而不是「排队」—— 那两件事用户的下一步
   * 完全不同。所以这一条只在「其它条件都满足、就差一个执行位」时才说话。
   */
  const kind = advanceableKind(node, byId)
  if (kind === 'execute' && opts?.serialExecute === true) {
    /**
     * 队首**不撒谎**:共享工作树下没有别人占着互斥时,它确实马上就跑。
     *
     * 「谁占着互斥」= 在飞的节点里还有别的执行型任务。用 `kind === 'executable'` +
     * 非终态判,不能用 `advanceableKind` —— 在飞的那个状态已经是 EXECUTING,
     * `advanceableKind` 对它返回 null,拿它做判据的话这一条恒不触发。
     */
    /**
     * 不用再排除 node 自己:它在 inFlight 里的话,上面第一条早就返回「正在运行」了。
     * 多写一个 `n.id !== node.id` 是一个永远为真的条件 —— 这个仓库为不可达分支付过账。
     *
     * **也不判终态。** 第一版写了 `!isTerminal(n.status)`,而互斥链上的一节要等 `step`
     * **返回**才释放,`commit(ACCEPTED)` 发生在 step 里面 —— 于是「已经 ACCEPTED、
     * 但还在 inFlight」的节点**仍然占着执行位**。排除它会让这里在那个窗口里说
     * 「马上就会被调度」,正是这次要修的那句谎换个地方再犯一遍。
     * (代价:被 `hold` 扣住的终态执行节点会被算进来 —— 那个方向只会多说一句「要排队」,
     * 而这一条存在的全部理由就是别把排队说成马上。)
     */
    const ahead = [...(opts.inFlight ?? [])].filter(id => byId.get(id)?.kind === 'executable')
    if (ahead.length > 0) {
      return `共享工作树:执行环节串行,前面还有 ${ahead.length} 个执行任务 —— 它得排队(和依赖无关)`
    }
  }
  if (kind === null) {
    // 依赖没满足是最常见的那一种,单独说;其余(等子任务、状态本身不可推进)合成一句。
    const unmet = node.deps.filter(id => byId.get(id)?.status !== 'ACCEPTED')
    if (unmet.length > 0) return `还在等 ${unmet.length} 个依赖任务完成`
    return `当前状态(${node.status})还不能推进`
  }
  return undefined
}

/**
 * Everything that can move right now, capped at `limit`.
 *
 * MUST be called and its results dispatched with NO await in between: JavaScript is
 * single-threaded, so an uninterrupted scan-then-dispatch makes the dependency check atomic
 * by construction. Put an await there and a sibling can BLOCK a dependency between the check
 * and the launch, and the node would run against a dead dependency.
 *
 * The return type deliberately excludes `null` so the caller's dispatch cannot fall through
 * to a runtime "unhandled kind" branch.
 */
export function pickBatch(
  nodes: TaskNode[], byId: Map<string, TaskNode>, inFlight: ReadonlySet<string>, limit: number,
): Advanceable[] {
  if (limit <= 0) return []
  const out: Advanceable[] = []
  // Deterministic order by id — a plain codepoint compare, NOT localeCompare (locale/ICU
  // dependent). KNOWN LIMITATION: with real providers, which node FINISHES first is
  // latency-dependent, so the order of advancement — and hence which node loses a maxNodes
  // race — is not reproducible run to run even though this scan is.
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const n of ordered) {
    if (out.length >= limit) break
    // 判据走 `notSchedulableReason`(同一份,见那里):one step per node、终态、祖先阻断、
    // 状态不可推进,四条一字不差,只是把「为什么不行」也算了出来给关口用。
    if (notSchedulableReason(n, byId, { inFlight }) !== undefined) continue
    const kind = advanceableKind(n, byId)
    if (kind !== null) out.push({ node: n, kind })
  }
  return out
}
