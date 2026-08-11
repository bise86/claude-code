/**
 * 每个节点一份**只增不改**的状态账 —— `state.jsonl`,和 node.md 同目录。
 *
 * ## 为什么 node.md 不够
 *
 * `node.md` 是**整份重写**的:每次落盘都把七十多 KB 从头写一遍。原子写(writeFileAtomic)
 * 解决了「写到一半留下半截文件」,但没解决另一半 ——
 *
 *   **原子写失败时,这一次的阶段结果整个没了。** 磁盘满的那一刻,rename 不会发生,
 *   盘上留着的是**上一次**的完整 node.md;节点带着「状态持久化失败」阻断,而刚跑完的
 *   那一关(一份方案、一轮验收记录、一段执行状态)从此不存在。用户的要求是
 *   「各阶段的运行结果和状态必须保存,不能丢」,而那正是它丢的地方。
 *
 * 这份账是**追加**的,而且只写**变化的字段**:一次阶段提交通常只有几百字节。
 * 七十 KB 写不下去的时候,几百字节往往还写得下去;就算这一条也没写成,**前面每一关
 * 的记录一条不少地留在文件里** —— 追加永远不会动到已经写下去的字节。
 *
 * ## 和 agent-log.jsonl 的分工
 *
 * `agent-log.jsonl` 存的是**过程**(模型说了什么、调了什么工具),丢了不影响恢复,
 * 用户明说过「日志这些可丢」。这份账存的是**结果与状态**(status / plan / execStatus /
 * 各关判决记录 / childIds / deps),它**不能丢** —— 恢复一棵树靠的就是它。
 *
 * ## 子任务信息(用户第 4 条)
 *
 * 每个子节点被创建时立刻 `persist` 一次,所以它自己的账第一条就带着
 * `id` / `title` / `parentId`。于是「父任务下有哪些子任务」有**两条独立的路**能重建:
 * 父节点账里的 `childIds`,以及每个子目录自己那份账里的 `parentId + title`。
 * 任何一条活着,子任务的名字和 id 就还在;详细信息本来就存在各自的目录里。
 */
import type { TaskNode } from './types.js'
import type { FsLike } from './persistence.js'

export const NODE_JOURNAL_NAME = 'state.jsonl'

export function nodeJournalPath(runDir: string, nodeId: string): string {
  return `${runDir}/${nodeId}/${NODE_JOURNAL_NAME}`
}

/**
 * 单节点这份账的字节上限。
 *
 * 超了**不是停笔** —— 停笔会把最新的状态丢掉,而这份账存在的全部理由就是别丢状态。
 * 超了走**压实**:把当前完整快照原子写成新的一份,旧的那些增量就此不需要了。
 * 所以这个数只影响「多久压实一次」,不影响任何一条记录的可恢复性。
 */
export const MAX_JOURNAL_BYTES_PER_NODE = 2 * 1024 * 1024

/**
 * 记录形态。`f` = 全量快照(一份就够重建),`d` = 增量(要按顺序合并)。
 *
 * 两种都留是必要的:全量让压实和「进程重启后重新锚定」有落点,增量让常态下的一次
 * 阶段提交只有几百字节。
 */
export type JournalRecord =
  | { t: 'f'; at: string; d: Partial<TaskNode> }
  | { t: 'd'; at: string; d: Partial<TaskNode> }

/**
 * 和上一份快照相比变了的**顶层字段**。
 *
 * 按 `JSON.stringify` 逐字段比。深比较在这里是对的取舍:字段本身不大(最大的是
 * reviewLog/acceptLog,而它们一变就是整轮追加),而漏判一次变化的代价是**这一关的
 * 结果永远不进账** —— 那正是这份账存在的理由。
 *
 * `undefined` 也要记:一次性标记(skipPhase / forcePass / redoFrom)被清掉是**状态变化**,
 * 只记「有值」的话,重放出来的节点会带着一个早就用掉的跳过标记再跳一关。
 * JSON 丢 undefined,所以这里写成 `null`,重放时再翻回来。
 */
export function nodeDelta(
  prev: Partial<TaskNode> | undefined, next: TaskNode,
): Partial<TaskNode> {
  const out: Record<string, unknown> = {}
  const keys = new Set<string>([...Object.keys(next), ...Object.keys(prev ?? {})])
  for (const k of keys) {
    const a = (prev as Record<string, unknown> | undefined)?.[k]
    const b = (next as unknown as Record<string, unknown>)[k]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    out[k] = b === undefined ? null : b
  }
  return out as Partial<TaskNode>
}

/** `null` 翻回 `undefined`(见 nodeDelta)。 */
function unnull(d: Partial<TaskNode>): Partial<TaskNode> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) out[k] = v === null ? undefined : v
  return out as Partial<TaskNode>
}

export interface NodeJournal {
  /**
   * 记一次落盘。**先于 node.md 写** —— 见 writeNode 里的注释。
   *
   * 失败**不抛**:这份账是 node.md 的第二道保险,不是它的前置条件。让一次追加失败
   * 阻断整个节点,等于用一个更宽的失败面换一个更窄的。失败进返回值。
   */
  record(node: TaskNode): Promise<{ error?: string }>
}

export function createNodeJournal(opts: {
  fs: FsLike
  runDir: string
  now?: () => string
  maxBytesPerNode?: number
}): NodeJournal {
  const { fs, runDir } = opts
  const now = opts.now ?? (() => new Date().toISOString())
  const cap = opts.maxBytesPerNode ?? MAX_JOURNAL_BYTES_PER_NODE
  /** 上一次写进账里的样子,按节点。冷启动(进程刚起)时没有 —— 那就写一条全量。 */
  const last = new Map<string, Partial<TaskNode>>()
  const bytes = new Map<string, number>()

  return {
    async record(node) {
      const prev = last.get(node.id)
      // 进程刚起来时 prev 是空的 → 写全量。这不是浪费:`--resume` 之后重新锚定一次,
      // 让这份账**自己**就能重建出当前状态,不必回头去和上一个进程的记录对齐。
      const rec: JournalRecord = prev === undefined
        ? { t: 'f', at: now(), d: { ...node } }
        : { t: 'd', at: now(), d: nodeDelta(prev, node) }
      // 什么都没变就不写。一次 commit 在新旧状态相同时会走到这里(pipeline 有这种路径),
      // 每次都追加一行空增量会把这份账撑成流水账。
      if (rec.t === 'd' && Object.keys(rec.d).length === 0) return {}
      let line: string
      try {
        line = `${JSON.stringify(rec)}\n`
      } catch (e) {
        return { error: `状态无法序列化: ${e instanceof Error ? e.message : String(e)}` }
      }
      const path = nodeJournalPath(runDir, node.id)
      const size = (bytes.get(node.id) ?? 0) + line.length
      try {
        await fs.mkdir(`${runDir}/${node.id}`)
        if (size > cap) {
          /**
           * 压实:整份换成一条全量快照。
           *
           * 走**原子写**(临时文件 + rename)而不是「先删再写」—— 这一步是这份账里
           * 唯一一次覆盖写,被打断在中间就会把整份账毁掉,而它恰恰是拿来防这个的。
           */
          const { writeFileAtomic } = await import('./persistence.js')
          const full: JournalRecord = { t: 'f', at: now(), d: { ...node } }
          const text = `${JSON.stringify(full)}\n`
          await writeFileAtomic(fs, path, text)
          bytes.set(node.id, text.length)
        } else {
          await fs.appendFile(path, line)
          bytes.set(node.id, size)
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
      last.set(node.id, { ...node })
      return {}
    },
  }
}

/**
 * 把一份账重放成节点状态。
 *
 * 坏行跳过 —— 追加被打断最坏是最后一行不完整,为它放弃前面几十关的记录,
 * 和「没有这份账」是同一个结果。
 */
export function replayNodeJournal(text: string): {
  node: Partial<TaskNode> | undefined
  records: number
  badLines: number
} {
  let node: Partial<TaskNode> | undefined
  let records = 0
  let badLines = 0
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    let rec: JournalRecord
    try {
      rec = JSON.parse(raw) as JournalRecord
    } catch {
      badLines++
      continue
    }
    if (!rec || typeof rec !== 'object' || (rec.t !== 'f' && rec.t !== 'd') || typeof rec.d !== 'object' || rec.d === null) {
      badLines++
      continue
    }
    records++
    // 全量**替换**,增量**合并**。全量走合并的话,一次压实之后被删掉的字段会从
    // 更早的增量里复活 —— 而压实的语义正是「这一条就是全部」。
    node = rec.t === 'f' ? unnull(rec.d) : { ...(node ?? {}), ...unnull(rec.d) }
  }
  return { node, records, badLines }
}

export async function readNodeJournal(
  fs: FsLike, runDir: string, nodeId: string,
): Promise<{ node: Partial<TaskNode> | undefined; records: number; badLines: number } | undefined> {
  let text: string
  try {
    text = await fs.readFile(nodeJournalPath(runDir, nodeId))
  } catch {
    return undefined // 没有这份账(老 run,或这个节点一次都没落过盘)—— 不是错误
  }
  return replayNodeJournal(text)
}
