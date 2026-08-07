/**
 * Constants related to tool result size limits.
 *
 * **这个 fork 把它们全部去掉了(`Infinity`)。** 上游这三个数控制的是同一件事:工具产出
 * 超过阈值就**落盘换成一段预览 + 文件路径**(`persistToolResult`),模型要看全文得再
 * `Read` 一次。对一个本来就是拿来读产出的会话,这条路是净负:一次真实的 `git diff`、
 * 一份 800KB 的清单、一段长日志,都会变成「预览 + 再读一次」的两跳,而第二跳读回来的
 * 还是同一份内容,只是多花了一次往返和一次工具调用。
 *
 * 常量保留而不是删掉:落盘那套代码(`toolResultStorage.ts`)还在,把任何一个改回有限值
 * 就整套回来。
 */

/**
 * 单个工具产出落盘的阈值(字符)。`Infinity` = 从不落盘。
 *
 * 原值 50_000,并且是**系统级封顶** —— 工具自己声明的 `maxResultSizeChars` 会被
 * `Math.min` 夹到它以下。见 `getPersistenceThreshold`。
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = Number.POSITIVE_INFINITY

/**
 * 工具产出的 token 上限。`Infinity` = 不限。原值 100_000(约 400KB 文本)。
 */
export const MAX_TOOL_RESULT_TOKENS = Number.POSITIVE_INFINITY

/**
 * Bytes per token estimate for calculating token count from byte size.
 * This is a conservative estimate - actual token count may vary.
 */
export const BYTES_PER_TOKEN = 4

/**
 * 由 token 上限推出的字节上限。上面是 `Infinity`,这里也是。
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * 同**一条** user 消息里所有 tool_result 加起来的预算(字符)。`Infinity` = 不限。
 *
 * 原值 200_000,挡的是「一轮里 N 个并行工具各自贴着单个上限、合起来 10 × 40K」。
 * 单个上限已经没有了,这一条留着也没有意义 —— 而且它是**按消息**算的,一旦触发就会
 * 把那一轮里最大的几块落盘,恰恰是并行读得最多的那一轮。
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = Number.POSITIVE_INFINITY

/**
 * 一条 user 消息里所有 tool_result 加起来,最多占**这个员工自己窗口**的多少。
 *
 * 这是上面那个 `Infinity` 在**没有 GrowthBook 覆盖时**的唯一例外(`getPerMessageBudgetLimit`
 * 里 `tengu_hawthorn_window` 那条既有覆盖排在窗口分支**之前**,它不限定员工)。
 * 例外的范围要说清楚:它只在 `roleClientConfig.contextWindow` 存在时才参与运算,而那个
 * 字段只有 `execMode:'api'` 的员工才有 —— 也就是**只对 `/et` 的 api 员工生效**,
 * 而且是其中**声明了(或按协议推得出)窗口**的那些:`apiProtocol` 填 anthropic 又没写
 * `contextWindow` 的员工,`roleContextWindow` 返回 `{assumed:false}` 且无值,这条不生效。
 * 主循环拿不到这个数(`getPerMessageBudgetLimit()` 不传窗口 → 回落 `Infinity`),所以上面
 * 那段「拆掉上限」的理由在用户自己的会话里**一个字都没有被推翻** —— 一次真实的 `git diff`、
 * 一份 800KB 的清单,在主循环里仍然全文进上下文。
 *
 * 为什么员工那一侧要有:员工跑在一台 32k~128k 的网关模型上,而这个仓库把单条产出上限也
 * 拆了,于是**一次 Glob 就能顶穿整扇窗口**(实测:两条 Glob 分别 1.4MB 和 3.2MB,整段对话
 * 4.5MB)。上游拒收之后没有任何兜底(`feature('REACTIVE_COMPACT')` 在这个 fork 里是 false,
 * `reactiveCompact.ts` 根本不存在),那一席直接死掉。
 *
 * 取 0.5 而不是更小:触发它意味着**这一轮的产出真的装不下**,而不是「超过某个我们拍脑袋
 * 定的数」。留一半给系统提示词、工具 schema、席位提示词和历史 —— 那几样加起来正好是另一半。
 */
export const PER_MESSAGE_BUDGET_WINDOW_SHARE = 0.5

/**
 * Maximum character length for tool summary strings in compact views.
 * Used by getToolUseSummary() implementations to truncate long inputs
 * for display in grouped agent rendering.
 *
 * 这一条**不动**:它是终端上那一行摘要的宽度,不是喂给模型的内容。
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
