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
const SYNTHETIC_MODEL = '<synthetic>'

export interface UsageTotals {
  /** 模型调用次数(不同的 message.id 数)。 */
  calls: number
  input: number
  output: number
  /** 命中缓存的输入 token。计费上便宜得多,所以和 input 分开记。 */
  cacheRead: number
  /** 写入缓存的输入 token。 */
  cacheWrite: number
}

export const EMPTY_USAGE: UsageTotals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function addUsage(a: UsageTotals | undefined, b: UsageTotals | undefined): UsageTotals {
  const x = a ?? EMPTY_USAGE
  const y = b ?? EMPTY_USAGE
  return {
    calls: x.calls + y.calls,
    input: x.input + y.input,
    output: x.output + y.output,
    cacheRead: x.cacheRead + y.cacheRead,
    cacheWrite: x.cacheWrite + y.cacheWrite,
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
  const out: UsageTotals = {
    calls: num(r.calls), input: num(r.input), output: num(r.output),
    cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite),
  }
  return isEmptyUsage(out) ? undefined : out
}

/**
 * 一条消息里的用量。**只认真实的上游回合。**
 *
 * 返回 undefined 表示「这条消息不是一次模型调用」——  合成消息、非 assistant 消息、
 * 没有 usage 字段的消息都归到这一档。
 */
function readMessage(m: unknown): { id: string; usage: Omit<UsageTotals, 'calls'> } | undefined {
  const msg = m as { type?: string; message?: { id?: unknown; model?: unknown; usage?: unknown } }
  if (msg?.type !== 'assistant') return undefined
  const inner = msg.message
  if (!inner || typeof inner !== 'object') return undefined
  if (inner.model === SYNTHETIC_MODEL) return undefined
  const u = inner.usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return undefined
  // id 缺席时退回一个**不会和别人相等**的键。合并成一个 id 会把 N 次调用记成 1 次,
  // 而那个方向的错(少报)比多报更糟:用户会照着一个偏小的数去放宽 caps。
  const id = typeof inner.id === 'string' && inner.id.length > 0 ? inner.id : `anon-${anonSeq++}`
  return {
    id,
    usage: {
      input: num(u.input_tokens), output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
    },
  }
}

let anonSeq = 0

export interface UsageMeter {
  /** 喂一条子 agent 消息。**永不抛** —— 它跑在模型消息热路径上。 */
  observe(message: unknown): void
  /** 到此为止的合计。 */
  totals(): UsageTotals
  /** 上一次 `take()` 之后新增的部分,并把游标推到当前。 */
  take(): UsageTotals
}

export function createUsageMeter(): UsageMeter {
  /** message.id → 该次调用目前见过的最大用量。见文件头「取最大」那一条。 */
  const byId = new Map<string, Omit<UsageTotals, 'calls'>>()
  let taken: UsageTotals = EMPTY_USAGE
  const sum = (): UsageTotals => {
    let out: UsageTotals = { ...EMPTY_USAGE, calls: byId.size }
    for (const u of byId.values()) {
      out = {
        calls: out.calls,
        input: out.input + u.input, output: out.output + u.output,
        cacheRead: out.cacheRead + u.cacheRead, cacheWrite: out.cacheWrite + u.cacheWrite,
      }
    }
    return out
  }
  return {
    observe(message) {
      try {
        const r = readMessage(message)
        if (!r) return
        const prev = byId.get(r.id)
        byId.set(r.id, prev === undefined ? r.usage : {
          // 逐字段取最大。整条替换会在「后到的那条恰好是 message_start 那一份」时倒退,
          // 而那一份的 output_tokens 是 0。
          input: Math.max(prev.input, r.usage.input),
          output: Math.max(prev.output, r.usage.output),
          cacheRead: Math.max(prev.cacheRead, r.usage.cacheRead),
          cacheWrite: Math.max(prev.cacheWrite, r.usage.cacheWrite),
        })
      } catch {
        /* 热路径,永不抛 —— 见文件头 */
      }
    },
    totals: sum,
    take() {
      const now = sum()
      const delta: UsageTotals = {
        calls: now.calls - taken.calls,
        input: now.input - taken.input,
        output: now.output - taken.output,
        cacheRead: now.cacheRead - taken.cacheRead,
        cacheWrite: now.cacheWrite - taken.cacheWrite,
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

