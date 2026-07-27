/**
 * 每次模型调用一个窗口 —— 事件流的存储 (spec 2026-07-27 §5)。
 *
 * 取代 chunkBuffer.ts。那个模块把一个节点的全部输出并成一串字符串行:圆桌里三个评审员的
 * 话逐句交错、**没有任何署名**,读不出哪句是谁说的;而分析圆桌、方案精化、观察评分这三处
 * 多席位并发同样并在一起。这里改成「一次调用一条流」。
 *
 * ## 为什么是句柄,不是字符串 key
 *
 * 设计稿第一版用 `nodeId#phase#round#seat` 做 key,评审逐个验出四处真实碰撞:
 *  1. `pipeline.ts` 的 infra 重试,3 次 attempt **共用同一个 round** —— 第二次会往一条已经
 *     end() 的流里继续写;
 *  2. 执行返工的 `round++` 是 stepExecute 的局部变量,runPhase 看不见 —— 所有返工轮次同键;
 *  3. 合并冲突自动解决用的也是 `phase:'execute'` + 同一个 node,与主执行流同键;
 *  4. 集成验收用的是 `phase:'accept'`(只有 system 不同),与叶子验收同键。
 *
 * 句柄由调用点在**发起调用的那一刻**开出来,一次调用一个,**结构上不可能撞**。
 *
 * ## 为什么是「活存储」而不是 React state
 *
 * 沿用 TaskTreePanel 对 chunks 的既定做法:事件流对每个在飞的节点每条消息都要触发一次,
 * 镜像进 state 会让整棵树在每条消息上重绘。组件在 render 期直接读这里 —— JS 单线程,push
 * 是同步的,render 也是同步的,读不到半写状态。
 */
import type { AgentEvent } from './agentEvents.js'

/** 树还没建起来时的调用(需求解析、根方案)挂在这个伪节点下。 */
export const PRE_TREE_NODE = '__pre__'

/**
 * 单流保留的事件数。
 *
 * 事件是**按行**的(见 agentEvents 的 MAX_LINES_PER_BLOCK),所以 100 条约等于一屏多一点的
 * 终端输出 —— 窗口本来也只显示这么多。真正兜住总量的是下面的全局上限,不是这一条。
 */
export const MAX_EVENTS_PER_STREAM = 100

/**
 * 单节点保留的流数。
 *
 * 一个节点一生开的流比直觉多得多:分析(N 席 + 融合)、质疑讨论(N 席 × 最多 3 轮 × 每轮最多
 * 3 桌 infra 重试)、执行(最多 3 轮)、测试验证、验收、集成验收、观察评分 —— 5 席配置下
 * 五十条起。设计稿第一版写 24,评审算出 2 席就超,而超限先淘汰的正是**第 1 轮评审** ——
 * 那恰好是 §10 让用户回去对照的东西。两个功能在同一个方案里互相拆台。
 */
export const MAX_STREAMS_PER_NODE = 40

/**
 * 全局事件总数。**这一层才是真正的天花板。**
 *
 * 设计稿第一版只有每流/每节点两层,并按「100 节点」估算内存。但 `caps.maxNodes` 的真实上限
 * 是 **5000**(parseDirectives 的 clampInt(…, 1, 5000, 100)),而 chunkBuffer 的注释自己写着
 * 「cap-nodes 卡片会告诉用户把它调高」—— 产品会主动引导用户调上去。按两层上限算,5000 个
 * 节点是 GB 级。评审实测(含对象开销)也证明第一版的估算低了一倍以上。
 *
 * 全局上限把总量钉死在**与节点数无关**的地方:20000 条 × (平均 80 码点 × 2B + 对象开销)
 * ≈ 5 MB 量级,最坏(全部 300 码点)十几 MB。
 */
export const MAX_TOTAL_EVENTS = 20000

/** 墓碑保留的末尾事件数 —— 折叠态本来也只显示一行「最新: …」。 */
export const TOMBSTONE_KEEP = 3

export interface StreamMeta {
  /** 真实节点 id;树外调用用 PRE_TREE_NODE。 */
  nodeId: string
  /** 环节名。由**调用点**给,不从 req.phase 推 —— 集成验收走的是 phase:'accept'。 */
  phaseLabel: string
  /** 第几轮。0/省略 = 不分轮。 */
  round?: number
  /**
   * 署名。取值必须是 `roleName || roleTag || '主模型'`。
   *
   * `||` 不是 `??`:MAIN_STAFF(「主模型兼任」的员工名)是**空串**,而空串是 truthy 对象上的
   * 一个 falsy 字段。roundtable.ts 已经为这个坑留了注释 —— 当时 blockingSummary 变成了
   * `[] 缺回滚方案`,那对空方括号被原样送进了返工提示词。
   */
  label: string
  model?: string
}

export interface StreamHandle {
  push(e: AgentEvent): void
  /** 收口。err 非空 → 表头渲染成「调用失败」。幂等。 */
  end(err?: string): void
}

export interface StreamState {
  meta: StreamMeta
  events: AgentEvent[]
  /** 本流因环形缓冲丢掉的事件数。 */
  dropped: number
  toolCount: number
  startedAt: number
  endedAt?: number
  error?: string
  closed: boolean
  seq: number
  /** 被淘汰过:只剩表头和末尾几条。 */
  tombstone?: boolean
}

export interface StreamStore {
  open(meta: StreamMeta): StreamHandle
  /** 该节点的全部流,按开启顺序。 */
  streams(nodeId: string): StreamState[]
  /** 该节点一共有多少条输出没能留下来(环形缓冲 + 被压成墓碑的部分)。 */
  droppedEvents(nodeId: string): number
  /** 有流的节点 id。 */
  nodes(): string[]
  /** 变化通知。返回退订函数。 */
  subscribe(fn: () => void): () => void
  /** resume 带进来的节点:没有流 ≠ 什么都没干。 */
  markHistorical(nodeIds: readonly string[]): void
  isHistorical(nodeId: string): boolean
  /** 仅供测试与断言:当前保存的事件总数。 */
  totalEvents(): number
}

export function createStreamStore(opts?: { now?: () => number }): StreamStore {
  const now = opts?.now ?? (() => Date.now())
  const byNode = new Map<string, StreamState[]>()
  const droppedByNode = new Map<string, number>()
  const historical = new Set<string>()
  const listeners = new Set<() => void>()
  /**
   * 已收口、尚未被压成墓碑的流,按收口顺序。
   *
   * 有这条队列,全局淘汰才是 O(1) 摊还:否则每次超限都要扫全部流找最旧的已关闭流,而 push
   * 是**模型消息热路径**,并行度 5 × 每节点多席并发。
   */
  const closedQueue: StreamState[] = []
  let seqCounter = 0
  let total = 0

  const notify = (): void => {
    for (const fn of listeners) {
      // 一个崩掉的订阅者不能带走这条流(和 pipeline/orchestrator 同一条规矩)。
      try { fn() } catch { /* ignore */ }
    }
  }

  const addDropped = (nodeId: string, n: number): void => {
    if (n <= 0) return
    droppedByNode.set(nodeId, (droppedByNode.get(nodeId) ?? 0) + n)
  }

  /**
   * 压成墓碑:保留 meta 与最后几条,其余计入该节点的 droppedEvents。
   *
   * **不是删除。** §10 的整个卖点是让用户回去看前几轮说了什么,而淘汰规则「最旧的先走」
   * 正好淘汰第 1 轮。墓碑保住表头和结论,代价约 3 行。
   */
  const tombstone = (s: StreamState): void => {
    if (s.tombstone) return
    const keep = s.events.slice(-TOMBSTONE_KEEP)
    const removed = s.events.length - keep.length
    total -= removed
    addDropped(s.meta.nodeId, removed)
    s.events = keep
    s.tombstone = true
  }

  /** 全局超限 → 从最早收口的流开始压墓碑,直到回到上限之内。 */
  const enforceGlobal = (): void => {
    while (total > MAX_TOTAL_EVENTS && closedQueue.length > 0) {
      const victim = closedQueue.shift()!
      tombstone(victim)
    }
    // closedQueue 空了还超限 = 所有流都还活着。活着的流永不压缩:它正在被人看。
    // 这是明确的已知边界,不是遗漏 —— 每流上限仍然生效,所以它仍然是有界的。
  }

  /** 单节点流数超限 → 压掉该节点最旧的一条已收口的流。 */
  const enforcePerNode = (nodeId: string): void => {
    const list = byNode.get(nodeId)
    if (!list) return
    /**
     * 只数**还完整**的流。
     *
     * 用 `list.length`(含墓碑)算超量,等于每 open 一条就按全额超量重新收一次费:
     * 实测 41 条 → 压 1 条,42 → 3,45 → 15,50 → **49** —— T(k)=(k-40)(k-39)/2。
     * 上限承诺的是「留 40 条完整的」,实际到 50 条时第 1 轮到第 49 轮全成了墓碑,而
     * 评审收敛那一半正指望用户回去对照第 1 轮说了什么。
     */
    const intact = list.filter(s => s.tombstone !== true).length
    if (intact <= MAX_STREAMS_PER_NODE) return
    let over = intact - MAX_STREAMS_PER_NODE
    for (const s of list) {
      if (over <= 0) break
      if (!s.closed || s.tombstone) continue
      tombstone(s)
      over--
    }
  }

  return {
    open(meta) {
      const state: StreamState = {
        meta,
        events: [],
        dropped: 0,
        toolCount: 0,
        startedAt: now(),
        closed: false,
        seq: seqCounter++,
      }
      const list = byNode.get(meta.nodeId)
      if (list) list.push(state)
      else byNode.set(meta.nodeId, [state])
      enforcePerNode(meta.nodeId)
      notify()
      return {
        push(e) {
          // 收口之后到达的事件直接丢弃并计数。这不是理论:runAgentAdapter 的超时是
          // `Promise.race`,poll 赢了之后**并不停下 consume()** —— 生成器要等下一次 yield
          // 才会看到 abort,provider 缓冲里的消息会在 end() 之后继续到达。不挡的话,一个
          // 「已完成」的窗口会继续冒新的工具行,而 endedAt 停在十分钟前。
          if (state.closed) {
            state.dropped++
            addDropped(state.meta.nodeId, 1)
            return
          }
          // **换引用,不原地 push。** chunkBuffer 每次都造新数组,所以 React.memo /
          // useMemo([streams]) 能看见变化。原地追加的话数组引用永不变,一个 memo 过的窗口
          // 会永远停在第一帧。
          const next = [...state.events, e]
          if (next.length > MAX_EVENTS_PER_STREAM) {
            /**
             * 满了先丢**思考**,丢不够再从头丢。
             *
             * 一视同仁的先进先出会让这个功能的核心失效:thinking 每块最多产 60 条
             * (MAX_LINES_PER_BLOCK),而单流只有 100 条。实测「1 个工具 + 1 个返回 +
             * 120 条思考」之后,缓冲里**一条工具事件都不剩**,表头还写着「1 工具」——
             * 而屏幕上占满全部位置的思考默认还是折叠成一行计数的。用户要看的
             * 「在调用什么工具」就这样被「在思考啥」挤没了。
             *
             * 思考不是不重要,它只是**可以少留一点**:折叠态本来只显示段数,展开也只是
             * 回看几段。工具调用是这条流干了什么的唯一证据。
             */
            let quota = next.length - MAX_EVENTS_PER_STREAM
            const kept: AgentEvent[] = []
            for (const ev of next) {
              if (quota > 0 && ev.kind === 'thinking') { quota--; continue }
              kept.push(ev)
            }
            const overflow = kept.length - MAX_EVENTS_PER_STREAM
            const finalKept = overflow > 0 ? kept.slice(overflow) : kept
            const removed = next.length - finalKept.length
            state.dropped += removed
            addDropped(state.meta.nodeId, removed)
            state.events = finalKept
            // total 不变:丢几条补几条
          } else {
            state.events = next
            total++
          }
          if (e.kind === 'tool') state.toolCount++
          enforceGlobal()
          notify()
        },
        end(err) {
          if (state.closed) return
          state.closed = true
          state.endedAt = now()
          if (err) state.error = err
          closedQueue.push(state)
          enforceGlobal()
          notify()
        },
      }
    },
    streams: nodeId => byNode.get(nodeId) ?? [],
    droppedEvents: nodeId => droppedByNode.get(nodeId) ?? 0,
    nodes: () => [...byNode.keys()],
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    markHistorical(nodeIds) {
      for (const id of nodeIds) historical.add(id)
    },
    isHistorical: nodeId => historical.has(nodeId),
    totalEvents: () => total,
  }
}
