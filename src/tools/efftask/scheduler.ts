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
  opts?: { inFlight?: ReadonlySet<string>; held?: ReadonlySet<string> },
): string | undefined {
  if (opts?.inFlight?.has(node.id) === true) return '此刻正在运行'
  if (opts?.held?.has(node.id) === true) return '此刻被另一次操作扣住'
  if (isTerminal(node.status)) return `已经是终态(${node.status})`
  if (hasBlockedAncestor(node, byId)) return '上级任务已阻断 —— 它的整棵子树都不会再被调度'
  if (advanceableKind(node, byId) === null) {
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
