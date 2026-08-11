/**
 * 子 agent 事件流的**落盘**与**读回** —— 每个节点一份 `agent-log.jsonl`。
 *
 * ## 为什么要有它
 *
 * 在这之前详情页的输出页卡对着一个恢复回来的节点写着:
 *
 *     子 agent 输出:属于上一次运行,事件流只在内存里、不落盘,看不到历史。
 *
 * 用户报的正是这句话。一个跑了四十分钟、调了三十次工具的节点,`--resume` 之后
 * 它干过什么**一个字都不剩** —— 而 node.md 里存的是解析并截断之后的结论,
 * 「模型当时到底在读哪个文件、卡在哪一步」只有事件流答得出来。
 *
 * ## 落在哪
 *
 * `<runDir>/<nodeId>/agent-log.jsonl`,和这个节点的 `node.md` 同一个目录。
 * `.claude/efftask/` 已经被 `worktreePool.init()` 写进了 `.git/info/exclude`,
 * 所以它天然不进用户的 `git status`(那条排除本来就是为 run 目录加的)。
 *
 * ## 为什么是 jsonl,为什么**追加**
 *
 * 事件是一条一条来的,而且量大(单节点上千条很常见)。整文件重写会把一个 O(N) 的
 * 记录变成 O(N²) 的写盘,而且每一次重写都是一次可以被打断的覆盖写 —— 那正是
 * `writeFileAtomic` 那一整段注释在讲的事故。追加写只往文件尾巴加字节:被打断最坏
 * 是**最后一行不完整**,而读回那一侧按行解析,坏行直接跳过,前面的记录一条不少。
 *
 * 所以这里**故意不走** `writeFileAtomic`:原子写保护的是「整份文档要么旧要么新」,
 * 而追加日志根本没有「旧版本」需要保护,套上去只会把每次追加变成一次全文件重写。
 *
 * ## 批量,不是每条一次 syscall
 *
 * `push` 是模型消息的热路径(并行 5 个节点 × 每节点多席并发)。每条事件一次
 * `appendFile` 会把落盘变成瓶颈。写入按节点攒在内存里,由 `flush()` 成批落盘。
 */
import type { AgentEvent } from './agentEvents.js'
import type { StreamMeta, StreamState } from './agentStream.js'
import type { FsLike } from './persistence.js'

export const AGENT_LOG_NAME = 'agent-log.jsonl'

export function agentLogPath(runDir: string, nodeId: string): string {
  return `${runDir}/${nodeId}/${AGENT_LOG_NAME}`
}

/**
 * 单节点日志的字节上限。
 *
 * 这个数**必须存在**:一个跑了几小时、反复返工的节点能产出几十万条事件,而这份文件
 * 就写在用户的检出里。上限之外的处理是「停止追加并记一条说明」,不是静默丢弃 ——
 * 读回那一侧会把这条说明渲染出来,否则一份被截断的历史和一份完整的历史长得一样。
 *
 * 8 MB ≈ 单节点几万条事件,远超任何一次真实回看的需要,而 900 个节点全部写满也只是
 * 一个可以随时删掉的目录(见 pruneAgentLogs)。
 */
export const MAX_LOG_BYTES_PER_NODE = 8 * 1024 * 1024

/** 一条日志记录。`s` 是流的 seq —— 同一个节点上区分不同调用的唯一键。 */
export type LogRecord =
  | { t: 'open'; s: number; at: number; meta: StreamMeta }
  | { t: 'ev'; s: number; e: AgentEvent }
  | { t: 'end'; s: number; at: number; err?: string }
  /** 触到字节上限,后面的都没写。**自己占一行**,读回时要能说出来。 */
  | { t: 'cap'; s: number; at: number }

export interface AgentLogWriter {
  record(nodeId: string, rec: LogRecord): void
  /** 把攒着的都写下去。落盘失败**返回**而不是抛 —— 见实现。 */
  flush(): Promise<{ failures: { nodeId: string; message: string }[] }>
}

/**
 * 追加写入器。`record` 是同步的(热路径上不能 await),真正的写盘由 `flush` 做。
 */
export function createAgentLogWriter(opts: {
  fs: FsLike
  runDir: string
  maxBytesPerNode?: number
}): AgentLogWriter {
  const { fs, runDir } = opts
  const cap = opts.maxBytesPerNode ?? MAX_LOG_BYTES_PER_NODE
  /** 攒着还没落盘的行,按节点。 */
  const pending = new Map<string, string[]>()
  /** 这个节点已经写下去多少字节(含攒着的)。 */
  const written = new Map<string, number>()
  /** 已经写过「触顶」那一行的节点 —— 只写一次,否则上限之后每条事件都变成一行 cap。 */
  const capped = new Set<string>()

  return {
    record(nodeId, rec) {
      if (capped.has(nodeId)) return
      let line: string
      try {
        line = `${JSON.stringify(rec)}\n`
      } catch {
        // 事件文本来自模型,可能带上代理对(lone surrogate)之类 JSON 序列化不了的东西。
        // 丢这一条,不丢整条流 —— 而且**不能抛**:调用点是 StreamStore.push,
        // 一个异常会把这次模型调用的输出整段带走。
        return
      }
      const now = (written.get(nodeId) ?? 0) + line.length
      if (now > cap) {
        capped.add(nodeId)
        const note: LogRecord = { t: 'cap', s: rec.s, at: Date.now() }
        const list = pending.get(nodeId)
        const capLine = `${JSON.stringify(note)}\n`
        if (list) list.push(capLine)
        else pending.set(nodeId, [capLine])
        return
      }
      written.set(nodeId, now)
      const list = pending.get(nodeId)
      if (list) list.push(line)
      else pending.set(nodeId, [line])
    },
    async flush() {
      const failures: { nodeId: string; message: string }[] = []
      for (const [nodeId, lines] of [...pending]) {
        pending.delete(nodeId)
        if (lines.length === 0) continue
        try {
          await fs.mkdir(`${runDir}/${nodeId}`)
          await fs.appendFile(agentLogPath(runDir, nodeId), lines.join(''))
        } catch (e) {
          /**
           * 写不下去**不阻断运行**,也不重排回队列。
           *
           * 这份日志是**给人事后看的**,不是恢复用的真相(那是 node.md)。磁盘满时
           * 把攒着的行重新排队,只会让内存里的队列一路涨到把进程撑爆 —— 而代价是
           * 一份本来就只是「锦上添花」的记录。所以丢掉,并把失败报上去让它上屏。
           */
          failures.push({ nodeId, message: e instanceof Error ? e.message : String(e) })
        }
      }
      return { failures }
    },
  }
}

/**
 * 读回一个节点的历史事件流。
 *
 * **坏行跳过,不整份放弃。** 追加写被打断最坏是最后一行不完整;为一行 JSON 解析失败
 * 就把前面几千条全扔掉,和「不落盘」是同一个结果。
 *
 * 返回的 `StreamState` 带 `closed: true` —— 它们全都属于**过去**。一条上次运行时
 * 没收口的流(进程被杀在半途)读回来如果是 `closed: false`,界面会把它渲染成
 * 「正在运行」,而那次调用早就没了,计时器还会从上次的 startedAt 一路往上跳。
 */
export function parseAgentLog(text: string): { streams: StreamState[]; badLines: number; capped: boolean } {
  const bySeq = new Map<number, StreamState>()
  const order: number[] = []
  let badLines = 0
  let capped = false
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    let rec: LogRecord
    try {
      rec = JSON.parse(raw) as LogRecord
    } catch {
      badLines++
      continue
    }
    if (!rec || typeof rec !== 'object' || typeof rec.s !== 'number') { badLines++; continue }
    if (rec.t === 'open') {
      if (bySeq.has(rec.s)) continue
      bySeq.set(rec.s, {
        meta: rec.meta,
        events: [],
        dropped: 0,
        toolCount: 0,
        startedAt: rec.at,
        // 见函数头:读回来的一律是收口态。真正的收口时刻由下面的 end 记录覆盖。
        closed: true,
        seq: rec.s,
      })
      order.push(rec.s)
      continue
    }
    const s = bySeq.get(rec.s)
    // open 那一行没写成(上限、坏行、或者上一次运行崩在两次 flush 之间)—— 没有表头就
    // 没有署名和环节名,渲染出来是一条「不知道是谁、哪一关」的流。跳过并计数。
    if (!s) { badLines++; continue }
    if (rec.t === 'ev') {
      s.events.push(rec.e)
      if (rec.e.kind === 'tool') s.toolCount++
    } else if (rec.t === 'end') {
      s.endedAt = rec.at
      if (rec.err !== undefined) s.error = rec.err
    } else if (rec.t === 'cap') {
      capped = true
    }
  }
  return { streams: order.map(n => bySeq.get(n)!).filter(Boolean), badLines, capped }
}

export async function readAgentLog(
  fs: FsLike, runDir: string, nodeId: string,
): Promise<{ streams: StreamState[]; badLines: number; capped: boolean } | undefined> {
  let text: string
  try {
    text = await fs.readFile(agentLogPath(runDir, nodeId))
  } catch {
    return undefined // 没有这份文件 = 这个节点没留下历史,和「读坏了」是两回事
  }
  return parseAgentLog(text)
}
