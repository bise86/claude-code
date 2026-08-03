/**
 * 员工的**上下文窗口** —— 自动压缩到底该按哪个数触发。
 *
 * ## 为什么需要这个模块
 *
 * 引擎的自动压缩阈值走的是 `getContextWindowForModel(mainLoopModel)`,而对翻译型协议
 * (openai / openai-responses)的员工,`runAgent.ts` **故意**把 `mainLoopModel` 设成父会话
 * 的 Claude 模型 —— 引擎要拿它做 Claude 模型的算术(别名解析、token 预算),塞一个
 * `gpt-5.1` 进去会当场坏掉。那个决定本身是对的,代价是:**压缩阈值算的是 Claude 的窗口,
 * 不是这个员工真正的窗口**。
 *
 * 后果是可测的:会话开着 `opus[1m]` 时,一个挂在 128k 网关模型上的员工,阈值是 1M ——
 * 自动压缩**一次都不会触发**,直到上游回一个 400。而这个 fork 里
 * `feature('REACTIVE_COMPACT')` 是 false、`services/compact/reactiveCompact.ts` **根本不存在**,
 * 也就是说撞上去之后没有任何兜底:那一席直接失败。
 *
 * ## 默认值为什么按协议分档
 *
 * - **翻译型协议(openai / openai-responses)**:我们自己就是这个员工的上下文管理器 ——
 *   窗口猜大了 = 硬失败(上游 400,而且报错文案会把人引到 model 名上去)。所以未声明时
 *   按 {@link DEFAULT_TRANSLATED_CONTEXT_WINDOW} 估,并在启动关口**说出来**。猜小的代价是
 *   提早压一次(花钱、丢粒度),猜大的代价是整席位死掉 —— 两者不对称,所以往小了猜。
 * - **anthropic 协议**:模型名就是 Claude 的名字,引擎自己的那套算术是准的,不要插手。
 * - **cli 档**:外部 CLI(claude / codex / gemini)**自己带上下文管理**,它自己会压。
 *   我们手上只有一次单发的 prompt,替它猜一个窗口然后动手截 = 在一件本来不会出错的事上
 *   造出一次信息丢失。所以 cli 档**只在用户显式声明时**才封顶。
 */

/** 翻译型协议未声明窗口时按这个数估。2026 年网关模型的众数,而且往小了猜(见文件头)。 */
export const DEFAULT_TRANSLATED_CONTEXT_WINDOW = 128_000

/**
 * 声明值的合法区间。
 *
 * 下限不是审美:阈值 = 窗口 - 保留 - 缓冲,窗口太小时三者一减就是负数,而负阈值的语义是
 * 「每一轮都压」—— 压缩本身又是一次调用,于是这一席位会在压缩循环里烧钱直到熔断器跳闸。
 * 上限挡的是手滑多打几个 0(`1280000000`),那种值等于没设。
 */
export const MIN_ROLE_CONTEXT_WINDOW = 8_000
export const MAX_ROLE_CONTEXT_WINDOW = 10_000_000

/**
 * 把 settings 里写的东西解析成一个 token 数。
 *
 * 三种写法都收:`128000`、`"128000"`、`"128k"`。收 `k` 后缀不是花哨 —— 用户手写的是
 * 「128k」,而 `thinkingDepth` 已经为「只收一种写法」付过一次学费:整条员工校验失败被跳过,
 * 而屏幕上说的是「这个员工不存在」。
 *
 * 认不出来返回 `undefined`,由调用方记一条诊断 —— **不要**回落到某个默认值再装作解析成功:
 * 用户写错一个字,却看到运行照常跑完,是这个仓库反复付代价的那一类。
 */
export function parseContextWindow(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === 'number') {
    n = v
  } else if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/[_,\s]/g, '')
    if (s.length === 0) return undefined
    const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s)
    if (!m) return undefined
    const base = Number(m[1])
    n = m[2] === 'k' ? base * 1_000 : m[2] === 'm' ? base * 1_000_000 : base
  }
  if (n === undefined || !Number.isFinite(n)) return undefined
  const r = Math.round(n)
  if (r < MIN_ROLE_CONTEXT_WINDOW || r > MAX_ROLE_CONTEXT_WINDOW) return undefined
  return r
}

/** 这一档的窗口是用户声明的,还是我们估的。关口那行按它写措辞。 */
export type RoleContextWindow = {
  /** `undefined` = 不干预,按引擎自己那套算(anthropic 协议、以及没声明窗口的 cli 档)。 */
  value?: number
  /** 我们估的(不是用户声明的)。关口要说出来 —— 一个估出来的数悄悄决定压缩时机是不行的。 */
  assumed: boolean
}

/**
 * 这个员工该按哪个窗口压缩。
 *
 * @param declared 已经过 {@link parseContextWindow} 的值(解析失败的应当在上游记诊断并丢弃)。
 */
export function roleContextWindow(r: {
  execMode: 'api' | 'cli'
  apiProtocol?: string
  declared?: number
}): RoleContextWindow {
  // 声明了就一律听用户的 —— 包括 anthropic 协议:那个协议后面也可能挂着一台第三方网关,
  // 而模型名对不上时引擎那套算术给的是 200k 兜底,同样是猜。
  if (r.declared !== undefined) return { value: r.declared, assumed: false }
  if (r.execMode === 'cli') return { assumed: false }
  if (r.apiProtocol === undefined || r.apiProtocol === 'anthropic') return { assumed: false }
  return { value: DEFAULT_TRANSLATED_CONTEXT_WINDOW, assumed: true }
}

/** `128000` → `128k`。给关口和诊断用,不参与任何算术。 */
export function formatContextWindow(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000 && n % 100 === 0) return `${Math.round(n / 100) / 10}k`.replace('.0k', 'k')
  return String(n)
}
