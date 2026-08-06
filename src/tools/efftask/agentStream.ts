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

/**
 * 按**码点**夹取。不用 logView 的 clipToWidth:那是按显示宽度算的渲染件,而这里只是给
 * 一个内存里的字段封顶,不该把存储层拖去依赖渲染层。
 */
function clipCodePoints(s: string, max: number): string {
  const cps = Array.from(s)
  return cps.length <= max ? s : cps.slice(0, max).join('') + '…'
}

/**
 * 树还没建起来时的调用(需求解析、根方案)挂在哪个节点下。
 *
 * **就是根节点的 id,不是一个伪节点。** 用 '__pre__' 的话,这两条流在树出来之后
 * 永远打不开:TaskTreePanel 只渲染 props.nodes,伪节点不在其中 —— 窗口的寿命只到
 * 第三关为止,而「整个运行里最长的单次调用之一」的记录恰恰是事后最想回看的。
 * 根节点 id 是确定的(rootPlan.makeRootNode 写死 'root'),所以这里可以先用。
 */
export const PRE_TREE_NODE = 'root'

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
 * 是 **`MAX_NODES_CEILING`(今天是 20000,曾经是 5000)**,而 chunkBuffer 的注释自己写着
 * 「cap-nodes 卡片会告诉用户把它调高」—— 产品会主动引导用户调上去。按两层上限算,那么多
 * 节点是 GB 级。评审实测(含对象开销)也证明第一版的估算低了一倍以上。
 *
 * 这也是为什么上限抬到 20000 时**这里一个字都不用改**:它按事件总数封顶,与节点数无关。
 *
 * 全局上限把总量钉死在**与节点数无关**的地方:20000 条 × (平均 80 码点 × 2B + 对象开销)
 * ≈ 5 MB 量级,最坏(全部 300 码点)十几 MB。
 */
export const MAX_TOTAL_EVENTS = 20000

/** 墓碑保留的末尾事件数 —— 折叠态本来也只显示一行「最新: …」。 */
export const TOMBSTONE_KEEP = 3

/**
 * 「已经发出、还没等到返回」的调用最多记几条。
 *
 * 有上限是因为这张表**活在 events 数组之外**(那正是它的价值,见下),所以环形缓冲管不到
 * 它。一个只调工具、永远收不到返回的病态流不该把它撑成无界项。256 条远大于任何一次真实
 * 的并行工具调用数。
 */
export const MAX_PENDING_CALLS = 256

/** 归属摘要在 result 事件里留多长。整条 brief 最长 300 码点,乘以事件数就太贵了。 */
const OF_BRIEF_MAX = 60

/**
 * 工具摘要 → 存进 `result.ofBrief` 的那个形态。**唯一的口径出处。**
 *
 * 导出是因为渲染层要拿它反着比:「这条返回的主人是不是上一行那个工具」在 provider 没给
 * id 时只能比 brief,而两边夹取长度只要差一个字,长摘要就永远比不上 —— 于是并排的调用
 * 会一直显示成「错位」。同一个函数用两次,两边就不可能对不上。
 */
export function ofBriefOf(brief: string): string {
  return clipCodePoints(brief, OF_BRIEF_MAX)
}

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
  /**
   * 永不淘汰。
   *
   * 树外那几条(需求解析、根方案、根方案重拟)挂在 root 上,而它们恰好是 root 上**最老**的
   * 三条 —— 淘汰按插入顺序压最旧的已收口流,于是它们成了第一批被扔的。而把它们挂到
   * root 的理由正是「事后最想回看」。5 席名册下 root 自己就有五十条流,这不是边角情况。
   */
  pinned?: boolean
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
  /**
   * 这条流的节点**已经不存在了**(被一次重做删掉,见 dropNodes)。
   *
   * 存在的理由是**迟到的消息**:`runAgentAdapter` 的超时是 `Promise.race`,poll 赢了
   * 之后并不停下 consume(),provider 缓冲里的消息会在 end() 之后继续到达。评审实测:
   * drop 完之后一条迟到消息就能把 `droppedEvents` 的记账重新建出来 —— 而重做之后
   * **新建的同 id 节点**会顶着那句「有 N 条输出没能留下来」,那 N 条属于另一次运行;
   * `total` 也会被这些幽灵事件顶高,而虚高的 total 会让全局上限去压真正在被看的流。
   */
  orphan?: boolean
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
  /**
   * 这些节点**已经不存在了** —— 把它们的历史运行记录一并扔掉。返回扔掉的流数。
   *
   * ## 为什么必须有这个口子
   *
   * 用户报的现象:「之前任务在运行,取消掉后,重做其父任务,但是其子任务的历史运行记录
   * 还有,未完全删除掉。」
   *
   * 一次任务重做会把整棵子树从内存和磁盘上删干净(`planRedo.deleted` + `removeNodeDirs`),
   * 唯独这里不知道 —— 流是按 nodeId 存的活存储,没有任何东西通知它。而 `childId` 是
   * `父id + 序号 + 标题 slug` 算出来的:同一个父节点重新拆一次,标题往往一模一样,
   * **新子节点的 id 和被删的那个逐字相同**。于是上一轮的输出会原样挂到新节点的详情页上,
   * 表头写着「已完成」,内容是上一次跑的东西 —— 用户看到的正是这个。
   *
   * 顺带把 `droppedEvents` 和 `markHistorical` 的记账一起清掉:留着的话,新节点一开张
   * 就顶着一句「有 N 条输出没能留下来」,而那 N 条属于另一次运行。
   */
  dropNodes(nodeIds: readonly string[]): number
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
    // 被删掉的流不参与淘汰:它的事件在 dropNodes 里已经从 total 里减过一次,
    // 再压一次会**重复减账**,total 一路飘负,全局上限从此形同虚设。
    if (s.orphan === true || s.tombstone) return
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
      // 钉住的流跳过 —— 出了队就不再回来,所以全局上限对它们无效。数量是常数级
      // (一次运行最多三条),不构成新的无界项。
      if (victim.meta.pinned === true) continue
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
      if (!s.closed || s.tombstone || s.meta.pinned === true) continue
      tombstone(s)
      over--
    }
  }

  return {
    open(meta) {
      /**
       * 「这次调用是什么时候发出的」。**活在 events 数组之外**,这是关键。
       *
       * 配对如果放在渲染期(按 useId 在 `s.events` 里找对手),会在两种常见情况下失败,
       * 而且都是静默的:
       *  - 环形缓冲把 tool 事件挤掉了、result 还在(实测:灌 100+ 条文本之后
       *    「events 里还有 tool 事件吗? false / 还有 result 事件吗? true」);
       *  - 墓碑只留最后 3 条,配对几乎必然断。
       * 放在这里就都不受影响 —— 淘汰规则动的是 events,动不到这张表。
       */
      const pending = new Map<string, { at: number; brief: string }>()
      /**
       * provider 没给 id 的调用(`agentEvents.asId` 在畸形输入上返回空串,而 openai 兼容
       * 后端恰恰是最容易缺 id 的那一档)按**先进先出**配对。
       * 全塞进 Map 的话它们会共用 `''` 这一个键,后一次调用直接盖掉前一次。
       */
      const pendingAnon: { at: number; brief: string }[] = []
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
          // 节点已经被删掉了:这条流不再属于任何人,连「丢了几条」都不该记 —— 那个数
          // 会挂到重做之后新建的同 id 节点头上(见 StreamState.orphan)。
          if (state.orphan === true) return
          // 收口之后到达的事件直接丢弃并计数。这不是理论:runAgentAdapter 的超时是
          // `Promise.race`,poll 赢了之后**并不停下 consume()** —— 生成器要等下一次 yield
          // 才会看到 abort,provider 缓冲里的消息会在 end() 之后继续到达。不挡的话,一个
          // 「已完成」的窗口会继续冒新的工具行,而 endedAt 停在十分钟前。
          if (state.closed) {
            state.dropped++
            addDropped(state.meta.nodeId, 1)
            return
          }
          /**
           * 盖时间戳并配对。**在这里做,不在渲染期做** —— 见 pending 的注释。
           *
           * 配不上就只盖 `atMs`,**不填 durMs** —— 一个猜出来的耗时比没有耗时更坏。
           */
          const ev = ((): AgentEvent => {
            if (e.kind === 'tool') {
              const at = now()
              const entry = { at, brief: ofBriefOf(e.brief) }
              if (e.useId.length > 0) {
                if (pending.size < MAX_PENDING_CALLS) pending.set(e.useId, entry)
              } else if (pendingAnon.length < MAX_PENDING_CALLS) {
                pendingAnon.push(entry)
              }
              return { ...e, atMs: at }
            }
            if (e.kind === 'result') {
              const at = now()
              let started: { at: number; brief: string } | undefined
              if (e.useId.length > 0) {
                started = pending.get(e.useId)
                if (started) pending.delete(e.useId)
              } else {
                started = pendingAnon.shift()
              }
              return started
                ? { ...e, atMs: at, durMs: Math.max(0, at - started.at), ofBrief: started.brief }
                : { ...e, atMs: at }
            }
            return e
          })()
          // **换引用,不原地 push。** chunkBuffer 每次都造新数组,所以 React.memo /
          // useMemo([streams]) 能看见变化。原地追加的话数组引用永不变,一个 memo 过的窗口
          // 会永远停在第一帧。
          const next = [...state.events, ev]
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
          if (ev.kind === 'tool') state.toolCount++
          enforceGlobal()
          notify()
        },
        end(err) {
          // 同 push:被删掉的流不进 closedQueue —— 进去的话下一次全局淘汰会去压一条
          // 早就没人能打开的流,而真正该被压的还在队列后面,上限于是形同虚设。
          if (state.orphan === true) return
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
    dropNodes(nodeIds) {
      let dropped = 0
      for (const id of nodeIds) {
        const list = byNode.get(id)
        droppedByNode.delete(id)
        historical.delete(id)
        if (!list) continue
        for (const s of list) {
          // 标记在**减账之前**:标记之后到达的事件一律直接丢弃,不会再动 total,
          // 也不会重新建出 droppedEvents 的记账(见 StreamState.orphan)。
          s.orphan = true
          /**
           * **总量要减回去**,否则全局上限会被一批已经不存在的事件长期占着 ——
           * 那个上限一旦被虚高的 total 顶满,`enforceGlobal` 会开始压真正在看的流的墓碑。
           */
          total -= s.events.length
          // 已收口队列里的引用也要摘掉:留着的话,下一次超限会去压一条早就没人能打开的流,
          // 而真正该被压的那条还在队列后面 —— 上限于是形同虚设。
          const at = closedQueue.indexOf(s)
          if (at >= 0) closedQueue.splice(at, 1)
          /**
           * 事件本体也放掉。两个作用:一棵被删的子树可能挂着几千条事件(纯垃圾,
           * 没有任何界面能再打开它们);而且万一有别的路径拿到这条流去压墓碑,
           * 空数组让那次减账为 0 —— 减两次账是 total 飘负的唯一来源。
           */
          s.events = []
        }
        dropped += list.length
        byNode.delete(id)
      }
      // 有变化才通知:重做之后界面本来就要整个重画,而空通知会让每个订阅者白跑一次。
      if (dropped > 0) notify()
      return dropped
    },
    totalEvents: () => total,
  }
}
