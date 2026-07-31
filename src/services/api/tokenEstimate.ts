/**
 * **上游不报用量时**的兜底估算,以及「这个数是估的」这件事本身。
 *
 * ## 为什么需要它
 *
 * `/et` 的用量统计读的是每次调用回来的 `usage`。走 anthropic 官方端点时它总是有的;
 * 而 OpenAI 兼容网关**不保证**:`stream_options: { include_usage: true }` 是我们发的,
 * 认不认在对面。实测有网关直接忽略它 —— 那一整趟运行的 token 数于是全是 0,而调用次数
 * 是对的。用户看到的就是「统计没了」:详情页那一段整段消失(空用量不渲染),表头也不画。
 *
 * 一个 0 比一个粗略的估算**更坏**:0 是一句假话(那些 token 真的花掉了),而估算只要
 * **标明是估算**就是一句真话。
 *
 * ## 口径(写死在这里,免得这段自述自己变成假话)
 *
 * - 拉丁文字约 4 个字符 1 个 token,CJK 约 1.5 个字符 1 个 token。两个数来自各家
 *   tokenizer 的公开经验值,**不是**精确换算 —— 这个模块的名字里就有 estimate。
 * - 只数字符,不做任何 BPE:真正的分词要拖一个 tokenizer 进来,而这条路径上我们要的
 *   只是「量级对不对」(是 3k 还是 300k)。
 * - 估算的**误差方向不保证**:它可能高也可能低。所以它绝不能被当成计费依据,而界面上
 *   必须带 `≈`(见 UsageTotals.estimated)。
 */

/** CJK(中日韩)统一表意文字、假名、谚文的粗略范围。够用就行 —— 这是估算。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u

/**
 * 一段文本大约多少 token。**永不抛**,非字符串一律 0。
 *
 * 逐码点扫一遍(不是逐 UTF-16 单元):表情和辅助平面的字符会被 `for...of` 正确当成一个,
 * 而按 `.length` 数会把它们算成两个 —— 那正是最容易让估算失真的一类输入。
 */
export function estimateTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/** 一个 JSON 请求体大约多少 token。序列化失败就当 0 —— 估算不该拖垮一次真实调用。 */
export function estimateBodyTokens(body: unknown): number {
  try {
    return estimateTokens(typeof body === 'string' ? body : JSON.stringify(body))
  } catch {
    return 0
  }
}

/**
 * 哪些请求的用量是**估出来的**。
 *
 * ## 为什么是一张表,而不是 usage 里的一个字段
 *
 * 这个标记要从翻译层一路走到 `/et` 的用量表。中间隔着 `claude.ts` 的 `updateUsage()`,
 * 而那个函数是**显式白名单**:它只把 input/output/cache/server_tool_use 那几个字段
 * 拷进新对象里。任何塞在 usage 里的自定义字段在那一步会被静默丢掉 —— 于是「这是估算」
 * 会变成「这是实测」,而那比不统计更糟。
 *
 * 键是 `request-id`。翻译层给自己的每一次响应都签一个(见 roleFetch),SDK 从响应头里
 * 读出来挂到消息上,所以两端拿到的是同一个字符串。
 *
 * 有界:只留最近 N 条。这张表活在整个进程里,而一次长跑有几千次调用。
 */
const MAX_REMEMBERED = 500
const estimated = new Set<string>()
const order: string[] = []

export function markEstimatedUsage(requestId: string | undefined): void {
  if (typeof requestId !== 'string' || requestId.length === 0) return
  if (estimated.has(requestId)) return
  estimated.add(requestId)
  order.push(requestId)
  while (order.length > MAX_REMEMBERED) {
    const drop = order.shift()
    if (drop !== undefined) estimated.delete(drop)
  }
}

export function isEstimatedUsage(requestId: unknown): boolean {
  return typeof requestId === 'string' && estimated.has(requestId)
}

/** 仅供测试:清空。 */
export function _resetEstimatedUsage(): void {
  estimated.clear()
  order.length = 0
}
