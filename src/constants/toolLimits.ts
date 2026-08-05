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
 * Maximum character length for tool summary strings in compact views.
 * Used by getToolUseSummary() implementations to truncate long inputs
 * for display in grouped agent rendering.
 *
 * 这一条**不动**:它是终端上那一行摘要的宽度,不是喂给模型的内容。
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
