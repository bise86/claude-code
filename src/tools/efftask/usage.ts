/**
 * 每个任务花了多少 —— **模型调用次数 + token**,自己的和整棵子树的。
 *
 * ## 为什么要有这个东西
 *
 * `/et` 是一个会自己长出几十个节点、每个节点开几十次模型调用的东西。跑之前用户能看到的
 * 只有 `caps.maxNodes`,跑完能看到的只有耗时 —— 而「这一趟花了多少」在整个界面上一个字
 * 都没有。耗时回答不了这个问题:一个 20 分钟的节点可能是一次慢调用,也可能是四轮评审
 * 各五席。
 *
 * ## 口径(先写死,免得这段自述自己变成一句假话)
 *
 * - **一次调用 = 上游的一条消息**(`message.id`)。不是「一个环节」,也不是「一个席位」:
 *   一席在工具循环里跑十轮就是十次调用,而那十轮的钱是真花了的。
 * - **token 按每个 message.id 取最大值**。流式下 claude.ts 为**每个内容块**都产一条
 *   AssistantMessage,它们共用一个 id,而最终 usage 只被写回**最后一条**(前面几条停在
 *   `message_start` 那一刻的值,output_tokens 是 0)。取最大而不是取最后一条,是因为
 *   适配层看到的顺序不由我们保证。
 * - **不算合成消息**:provider 报错、UI 占位那几条走的是 `SYNTHETIC_MODEL`,它们没有
 *   对应的上游请求。算进去的话「调用次数」会随着报错次数虚涨,而那正是用户想拿这个数
 *   去判断的东西。
 * - **只统计经过 `/et` 适配层的调用**,所以这个数是**下限**。漏在外面的:
 *   - **子 agent 里的自动压缩**(`autoCompactIfNeeded`)。它对子 agent 不设防,而一次
 *     压缩就是一次读满上下文窗口的完整调用;它的产出以 `UserMessage` 回到主循环,
 *     **不是 assistant 消息**,这一层一条都看不见。执行档最容易把窗口撑满。
 *   - 启动关口那次一次性的配置提取调用(1 次,量级可忽略)。
 *   - 根方案起草失败时,那一趟的账随被丢弃的 root 对象一起没了。
 *
 *   **误差不是一个常数,而是随「有没有压缩过」阶跃的**:没压缩过的运行在 1% 以内;
 *   压缩一次就多漏一个上下文窗口(200k 模型上约 150k~180k 输入),一趟总量 1~5M 的
 *   运行里每压缩一次约多漏 3%~10%。
 *
 *   子 agent 自己再开 Task 也不走这条路,不过默认配置下 `ALL_AGENT_DISALLOWED_TOOLS`
 *   把 Task 挡在子 agent 之外(只有 `USER_TYPE === 'ant'` 放行),所以它发生不了 ——
 *   上一版把这一条列成主要漏算来源,那是错的。
 */

/**
 * 合成消息的模型名。
 *
 * **本地常量,不 import `utils/messages.js`。** 那个模块拖着大半个仓库的依赖图,而这个
 * 文件是 `types.ts`(几乎所有 efftask 模块都 import 它)和 `redo.ts` 的下游 —— 引进来
 * 会给一批本来无关的模块造出一条真实的运行期边,实测把测试跑成了顺序相关的。
 *
 * 抄一份字面量的风险(对面改名后这里静默失效)由 `usage.test.ts` 里一条**直接比对源头**
 * 的断言接住 —— 那条断言只在测试里付出依赖代价,不在运行期。
 */
import { isEstimatedUsage } from '../../services/api/tokenEstimate.js'

const SYNTHETIC_MODEL = '<synthetic>'

export interface UsageTotals {
  /** 模型调用次数(不同的请求数)。 */
  calls: number
  input: number
  output: number
  /** 命中缓存的输入 token。计费上便宜得多,所以和 input 分开记。 */
  cacheRead: number
  /** 写入缓存的输入 token。 */
  cacheWrite: number
  /**
   * 其中有几次调用的 token 数是**估出来的**,不是上游报的。
   *
   * 来源两处,都不是我们能改的:
   *  - OpenAI 兼容网关忽略 `stream_options.include_usage`(实测存在)——那一次调用的
   *    真实用量我们永远拿不到;
   *  - CLI 档员工:它是另一个进程,除非它自己在协议里报,否则外面只看得见文本。
   *
   * 不估的话那些调用记成 0,而 0 会让整段用量在界面上消失 —— 用户看到的是「统计没了」,
   * 而那些 token 是真花掉的。估算 + 一个 `≈` 是实话;0 是假话。
   *
   * **必须能被读回**(见 sanitizeUsage):少了它,`--resume` 之后一份估算值会被显示成
   * 实测值,那比不显示更糟。
   */
  estimated?: number
}

export const EMPTY_USAGE: UsageTotals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: UsageTotals | undefined, b: UsageTotals | undefined): UsageTotals {
  const x = a ?? EMPTY_USAGE
  const y = b ?? EMPTY_USAGE
  const estimated = (x.estimated ?? 0) + (y.estimated ?? 0)
  return {
    calls: x.calls + y.calls,
    input: x.input + y.input,
    output: x.output + y.output,
    cacheRead: x.cacheRead + y.cacheRead,
    cacheWrite: x.cacheWrite + y.cacheWrite,
    // 一次都没估过就**不带这个字段**:带一个 0 会让每一个节点的 node.md 都多一行,
    // 而它想说的事(「这些数里有估算」)在 0 的时候根本不成立。
    ...(estimated > 0 ? { estimated } : {}),
  }
}

/** 总 token —— 界面上那个「一共多少」。缓存读写都是真花掉的输入,一并算进来。 */
export function totalTokens(u: UsageTotals | undefined): number {
  const x = u ?? EMPTY_USAGE
  return x.input + x.output + x.cacheRead + x.cacheWrite
}

export function isEmptyUsage(u: UsageTotals | undefined): boolean {
  return u === undefined || (u.calls === 0 && totalTokens(u) === 0)
}

/** 一个非负整数,拿不准就当 0。盘上的值是可以手工编辑的,NaN 会一路渲染成 `NaNk`。 */
const MAX_TOKENS = 1e15
function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  // 上界不是洁癖:`1e308` 通过了「有限且非负」,四项一相加就溢出成 Infinity,
  // 而 `formatTokens(Infinity)` 返回 '0' —— 详情页于是印出「1e+308 次调用 · 0 tokens」,
  // 两个数互相打脸。手工编辑 node.md 就能到这儿,而 sanitizeUsage 存在的理由正是这个。
  return Math.min(MAX_TOKENS, Math.trunc(v))
}

/** 读回校验:盘上/上游来的任意值 → 一个合法的 UsageTotals;拿不准就 undefined。 */
export function sanitizeUsage(raw: unknown): UsageTotals | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const est = num(r.estimated)
  const out: UsageTotals = {
    calls: num(r.calls), input: num(r.input), output: num(r.output),
    cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite),
    /**
     * **必须读回。** 少了这一句,一份带估算的用量在 `--resume` 之后会被显示成实测值 ——
     * 那个方向的错(把估算说成实测)比不显示更糟,而这个仓库为「只写不读的字段」
     * 已经付过一次学费(见 feishu/roleDefs 那一组)。
     *
     * 夹到 calls:估算次数不可能多于调用次数,一个手改出来的大数会让界面上出现
     * 「3 次调用,其中 99 次是估算」。
     */
    ...(est > 0 ? { estimated: Math.min(est, num(r.calls)) } : {}),
  }
  return isEmptyUsage(out) ? undefined : out
}

/**
 * 一条消息里的用量。**只认真实的上游回合。**
 *
 * 返回 undefined 表示「这条消息不是一次模型调用」——  合成消息、非 assistant 消息、
 * 没有 usage 字段的消息都归到这一档。
 */
function readMessage(m: unknown): { key: string; requestId?: string; estimated: boolean; usage: Omit<UsageTotals, 'calls' | 'estimated'> } | undefined {
  const msg = m as { type?: string; requestId?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } }
  if (msg?.type !== 'assistant') return undefined
  const inner = msg.message
  if (!inner || typeof inner !== 'object') return undefined
  if (inner.model === SYNTHETIC_MODEL) return undefined
  const u = inner.usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return undefined
  return {
    key: keyOf(msg.requestId, inner.id),
    requestId: typeof msg.requestId === 'string' && msg.requestId.length > 0 ? msg.requestId : undefined,
    // 这一次的数是不是估出来的。判据挂在 requestId 上,由发出估算的那一层登记
    // (见 services/api/tokenEstimate:塞进 usage 里的自定义字段会被 claude.ts 的
    // 白名单静默丢掉,所以只能走旁路)。
    estimated: isEstimatedUsage(msg.requestId),
    usage: {
      input: num(u.input_tokens), output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
    },
  }
}

/**
 * 一次调用的**去重键**。
 *
 * 优先用 `requestId`,因为同一次请求会从两条路各报一次:消息上的 `usage`,以及
 * `claude.ts` 结算成本时的旁路上报(那条路才看得见子 agent 内部的自动压缩)。
 * 两边带的是同一个 requestId —— 用它当键,两份自然合成一次;换成 message.id 的话,
 * 旁路那一份没有 message.id,会被记成**另一次调用**,调用次数和 token 双双翻倍。
 *
 * 退回 message.id 的场景:老的/不带 request-id 头的端点(翻译层已经给自己的响应签了
 * 一个,见 roleFetch)。两者都没有时给一个不会和别人相等的键 —— 合并成一个的后果是
 * 把 N 次调用记成 1 次,而少报比多报更糟:用户会照着一个偏小的数去放宽 caps。
 */
function keyOf(requestId: unknown, messageId: unknown): string {
  const rid = typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined
  const mid = typeof messageId === 'string' && messageId.length > 0 ? messageId : undefined
  /**
   * **两个都有时,键里两个都带上。**
   *
   * 只按 requestId 的话,一个**每次都回同一个 `request-id` 头**的网关(转发层写死、
   * 或者干脆回一个常量)会把整趟运行的几十次调用合成一次 —— 评审实测:三次调用记成
   * `{calls:1, input:3000}`,而真值是 `{calls:3, input:6000}`。方向正是这个函数自己
   * 的注释说「比多报更糟」的那个:用户照着一个偏小的数去放宽 caps。
   *
   * 加上 message.id 之后,同一次流式调用里那几条共用 id 的消息仍然合成一次(它们的
   * (rid, mid) 完全相同),而不同调用因为 message.id 不同而分开。旁路上报没有
   * message.id,它的归并见 observeApi —— 它会挂到同一个 rid 下**最后一条**消息上。
   */
  if (rid && mid) return `req:${rid}#msg:${mid}`
  if (rid) return `req:${rid}`
  if (mid) return `msg:${mid}`
  return `anon:${anonSeq++}`
}

let anonSeq = 0

/** 一次调用记下来的东西。`estimated` 只要有一条来源说是估的,就是估的。 */
interface CallUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  estimated: boolean
}

export interface UsageMeter {
  /** 喂一条子 agent 消息。**永不抛** —— 它跑在模型消息热路径上。 */
  observe(message: unknown): void
  /**
   * 喂一条**旁路上报**(services/api/usageSink)。
   *
   * 存在的理由是消息那条路看不见子 agent 内部的自动压缩 —— 一次压缩就是一次读满上下文
   * 窗口的完整调用,而它的产出以 UserMessage 回到主循环。去重和消息那侧共用 requestId。
   */
  observeApi(r: { requestId?: string; input: number; output: number; cacheRead: number; cacheWrite: number }): void
  /** 到此为止的合计。 */
  totals(): UsageTotals
  /** 上一次 `take()` 之后新增的部分,并把游标推到当前。 */
  take(): UsageTotals
}

export function createUsageMeter(): UsageMeter {
  /** 去重键 → 该次调用目前见过的最大用量。见文件头「取最大」那一条。 */
  const byId = new Map<string, CallUsage>()
  /** requestId → 该 id 下**最近一条消息**的键。旁路上报靠它找到自己该并到哪儿。 */
  const lastKeyByRid = new Map<string, string>()
  let taken: UsageTotals = EMPTY_USAGE
  const sum = (): UsageTotals => {
    let out: UsageTotals = { ...EMPTY_USAGE, calls: byId.size }
    let est = 0
    for (const u of byId.values()) {
      if (u.estimated) est++
      out = {
        calls: out.calls,
        input: out.input + u.input, output: out.output + u.output,
        cacheRead: out.cacheRead + u.cacheRead, cacheWrite: out.cacheWrite + u.cacheWrite,
      }
    }
    return est > 0 ? { ...out, estimated: est } : out
  }
  /** 逐字段取最大 —— 见 observe 里那段注释;两条来源共用这一条合并规则。 */
  const merge = (key: string, next: CallUsage): void => {
    const prev = byId.get(key)
    byId.set(key, prev === undefined ? next : {
      input: Math.max(prev.input, next.input),
      output: Math.max(prev.output, next.output),
      cacheRead: Math.max(prev.cacheRead, next.cacheRead),
      cacheWrite: Math.max(prev.cacheWrite, next.cacheWrite),
      // 「估算」是**粘性**的:两条来源里只要有一条是估出来的,这一次调用就该带着 ≈。
      estimated: prev.estimated || next.estimated,
    })
  }
  return {
    observe(message) {
      try {
        const r = readMessage(message)
        if (!r) return
        // 逐字段取最大。整条替换会在「后到的那条恰好是 message_start 那一份」时倒退,
        // 而那一份的 output_tokens 是 0。
        /**
         * **先把「先到的那条旁路上报」认领回来。**
         *
         * 两条来源没有固定的先后:`claude.ts` 在 message_delta 处上报,那通常在消息
         * 之后,但非流式兜底那条路是先 push 消息再上报,而任何一次重试/回落都可能换序。
         * 旁路那条没有 message.id,只能先落在 `req:<rid>` 这个裸键上;消息到达时如果
         * 发现它在,就把它并进这条消息的键里 —— 否则同一次请求会被记成两次调用,
         * 而那正是这个键设计要防的第一件事。
         */
        if (r.requestId !== undefined) {
          const bare = `req:${r.requestId}`
          if (bare !== r.key) {
            const pending = byId.get(bare)
            if (pending) { merge(r.key, pending); byId.delete(bare) }
          }
        }
        merge(r.key, { ...r.usage, estimated: r.estimated })
        if (r.requestId !== undefined) lastKeyByRid.set(r.requestId, r.key)
      } catch {
        /* 热路径,永不抛 —— 见文件头 */
      }
    },
    observeApi(r) {
      try {
        /**
         * 旁路上报没有 message.id,而键里现在带着它(见 keyOf)。所以归并到**这个
         * requestId 下最近见过的那条消息**的键上 —— 那正是它在说的那次调用。
         *
         * 一条消息都没见过就自己开一个 `req:` 键:那是这条旁路存在的理由 ——
         * 子 agent 内部的自动压缩根本不产生 assistant 消息。
         */
        const key = (r.requestId !== undefined ? lastKeyByRid.get(r.requestId) : undefined)
          ?? keyOf(r.requestId, undefined)
        merge(key, {
          input: num(r.input), output: num(r.output),
          cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite),
          estimated: isEstimatedUsage(r.requestId),
        })
      } catch {
        /* 同上 */
      }
    },
    totals: sum,
    take() {
      const now = sum()
      const est = (now.estimated ?? 0) - (taken.estimated ?? 0)
      const delta: UsageTotals = {
        calls: now.calls - taken.calls,
        input: now.input - taken.input,
        output: now.output - taken.output,
        cacheRead: now.cacheRead - taken.cacheRead,
        cacheWrite: now.cacheWrite - taken.cacheWrite,
        ...(est > 0 ? { estimated: est } : {}),
      }
      taken = now
      return delta
    },
  }
}

/** 算子树合计时只需要这三样。写成结构类型,好让测试不用造一整个 TaskNode。 */
export interface UsageNode {
  id: string
  childIds: readonly string[]
  usage?: UsageTotals
  discardedUsage?: UsageTotals
}

/**
 * 「含子任务」的合计 —— 自己 + 整棵子树,**现算**。
 *
 * 不存合计:存的话一个节点的用量变化要同时改它到根的每一个祖先,而这条链上任何一次
 * 崩溃、重做、`--resume` 都能让那些数字永久性地对不上,却没有任何东西会报错。
 *
 * `seen` 不是防御性编程的摆设:childIds 是从 node.md 读回来的,而 node.md 按设计
 * 可以手工编辑 —— 一条 `a → b → a` 会让这个函数**吃满栈**,而它跑在渲染路径上,
 * 每秒一次。成环时按「每个节点只算一次」收敛,数字偏小但界面还活着。
 *
 * 找不到的子节点**跳过**,不当 0 也不报错:那属于 validateLoadedNodes 的地盘,
 * 它会把「子节点缺失」阻断在前面,轮不到一个统计函数去发现。
 */
export function subtreeUsage(
  node: UsageNode | undefined,
  resolve: (id: string) => UsageNode | undefined,
): UsageTotals {
  const seen = new Set<string>()
  const walk = (n: UsageNode | undefined): UsageTotals => {
    if (!n || seen.has(n.id)) return EMPTY_USAGE
    seen.add(n.id)
    // 被重做删掉的那棵子树的账也算进来 —— 那些节点已经不在树上了,不认的话
    // 合计会随着一次重做当场倒退。
    let out = addUsage(n.usage, n.discardedUsage)
    for (const id of n.childIds ?? []) out = addUsage(out, walk(resolve(id)))
    return out
  }
  return walk(node)
}

/**
 * token 数 → 人读的短串。
 *
 * 三位数以内给原数(`847`),再大给一位小数的 k / M。界面上这个数和标题、状态、耗时挤在
 * 同一行,`1234567` 会把右边的东西整个挤出去。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  const v = Math.trunc(n)
  if (v < 1000) return String(v)
  // 判据是**四舍五入之后**的分档:`999_999 / 1000 = 999.999`,toFixed(1) 进位成
  // `1000.0k` —— 比 `1.0M` 还长一位,而这个函数存在的全部理由就是把串压短。
  if (v < 999_950) return `${(v / 1000).toFixed(1)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

