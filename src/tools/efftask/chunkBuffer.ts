/**
 * 每节点的子 agent 输出缓冲 (spec §10.2):
 *   "若该节点正在执行/评审,详情视图下半区实时滚动显示该节点子 agent 的输出流
 *    (与单个子 agent 终端观感一致),完成后保留最终输出。"
 *
 * A ring buffer per node, because the alternative is unbounded: the execute phase streams
 * every assistant message of a write-capable agent, a run can hold 100 nodes, and the panel
 * only ever shows the last screenful anyway. Keeping everything would grow without limit for
 * the whole life of a run that nobody is watching.
 *
 * Pure and injectable: `onChunk` reaches this from the pipeline through the SAME wire that
 * carried onEscalate and onBlocked — the wire this project has now cut twice — so the store
 * is testable on its own and the wiring gets its own test at the orchestrator seam.
 */

/** Lines kept per node. Roughly a screenful; the detail view clips again on render. */
export const MAX_CHUNK_LINES = 200

export interface ChunkStore {
  /** Append one streamed message for a node. */
  push(nodeId: string, text: string): void
  /** Everything kept for a node, oldest first. */
  lines(nodeId: string): string[]
  /** How many lines were dropped for this node — the panel must not imply it shows all of it. */
  dropped(nodeId: string): number
  /** Node ids that have any output. */
  nodes(): string[]
}

export function createChunkStore(maxLines = MAX_CHUNK_LINES): ChunkStore {
  const buf = new Map<string, string[]>()
  const lost = new Map<string, number>()
  return {
    push(nodeId, text) {
      // An empty or whitespace-only message is not output. The adapter emits one per
      // assistant message, and a tool-only turn produces exactly that.
      const incoming = text.split('\n').filter(l => l.trim().length > 0)
      if (incoming.length === 0) return
      const cur = buf.get(nodeId) ?? []
      const next = [...cur, ...incoming]
      if (next.length > maxLines) {
        // Count what we drop. A view that silently starts in the middle looks like a view of
        // the whole thing — the same clipping lie NodeDetail's block() already had to fix.
        lost.set(nodeId, (lost.get(nodeId) ?? 0) + (next.length - maxLines))
        buf.set(nodeId, next.slice(next.length - maxLines))
        return
      }
      buf.set(nodeId, next)
    },
    lines: nodeId => buf.get(nodeId) ?? [],
    dropped: nodeId => lost.get(nodeId) ?? 0,
    nodes: () => [...buf.keys()],
  }
}
