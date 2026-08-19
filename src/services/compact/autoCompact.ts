import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { effectiveRoleContextWindow } from './roleContextCeiling.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * 小窗口下,保留给摘要的额度最多占窗口的这么多。
 *
 * 固定的 20k 对 200k 窗口是 10%,对一个 32k 的网关模型是 62% —— 减完再减 13k 缓冲就是负数,
 * 而负阈值的语义是「每一轮都压」:压缩本身又是一次调用,那一席位会在压缩循环里烧钱直到
 * 熔断器跳闸。按比例夹住之后,200k/1M 这两档的算术**一个字节都没变**(20k 本来就更小)。
 */
const SUMMARY_RESERVE_FRACTION = 0.2
/** 同上,缓冲区在小窗口下按比例夹。200k 档不受影响(13k < 18k)。 */
const AUTOCOMPACT_BUFFER_FRACTION = 0.1

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(
  model: string,
  /**
   * 这一档**真正**的上下文窗口 —— 员工声明的那个数(见 roles/roleContextWindow.ts)。
   *
   * 翻译型协议的员工跑在别人的模型上,而 `model` 参数拿到的是父会话的 Claude 模型
   * (`runAgent.ts` 故意这么设,引擎要拿它做 Claude 的算术)。不接这个口子的话,一个 128k
   * 的员工在 opus[1m] 会话里的压缩阈值是 1M —— 永远不压,直接撞上游 400。
   */
  contextWindowOverride?: number,
): number {
  let contextWindow = contextWindowOverride ?? getContextWindowForModel(model, getSdkBetas())

  // 环境变量的夹取必须排在保留额度**之前**算。原来它在后面无所谓 —— 保留额度只看模型;
  // 现在它按比例跟着窗口走,排在后面就会用一个已经被夹掉的窗口去减一份按原窗口算的保留,
  // 而 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=30000` 正是拿来测小窗口的那个开关。
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    Math.floor(contextWindow * SUMMARY_RESERVE_FRACTION),
  )

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(
  model: string,
  contextWindowOverride?: number,
): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(
    model,
    contextWindowOverride,
  )

  const autocompactThreshold =
    effectiveContextWindow -
    Math.min(
      AUTOCOMPACT_BUFFER_TOKENS,
      Math.floor(effectiveContextWindow * AUTOCOMPACT_BUFFER_FRACTION),
    )

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
  contextWindowOverride?: number,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(
    model,
    contextWindowOverride,
  )
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model, contextWindowOverride)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(
    model,
    contextWindowOverride,
  )
  /**
   * 硬封顶闸**永远不许排在自动压缩前面**。
   *
   * 两条线各自减各自的:封顶闸减固定的 3000,自动压缩减 `min(13000, 窗口×10%)`。
   * 窗口大的时候后者是 13000 > 3000,压缩先开火,封顶闸只是它没救成时的兜底 —— 这正是
   * `query.ts` 那句「only applies when auto-compact is OFF」描述的世界。而窗口一小,
   * `窗口×10%` 掉到 3000 以下,两条线**换位**:封顶闸先开火,而它不压缩、不发请求,
   * 直接合成一条 `Prompt is too long` 就把这一轮判死。
   *
   * 实测(effective = 窗口 − 摘要保留):
   *   声明   8000 → 压缩 5760,闸门 3400 → 必杀区间 [3400, 5760)
   *   声明  32000 → 压缩 23040,闸门 22600 → 必杀区间 [22600, 23040)
   *   声明 ≥40000 → 顺序才正确
   * 而 `MIN_ROLE_CONTEXT_WINDOW = 8000` 是明确放行这些值的。
   *
   * 取 `max` 而不是把下限抬到 40000:后者只是把坑挪到另一个数上,而这里要的是一条
   * **与声明值无关**的不变量 —— 只要自动压缩是开的,它就必须有机会先跑。压缩关掉时
   * 封顶闸是唯一的保护,那时候原样保留它自己的位置。
   */
  const rawBlockingLimit = actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS
  const defaultBlockingLimit = isAutoCompactEnabled()
    ? Math.max(rawBlockingLimit, autoCompactThreshold)
    : rawBlockingLimit

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

/**
 * 硬封顶闸:**这一轮要不要在发请求之前就拦下来**。
 *
 * 抽成具名导出函数,而不是留在 `query.ts` 里内联,理由是这个仓库为「接线在生产上是死的」
 * 付过三次学费 —— 而这条判据最容易坏的地方恰恰是接线:少传一个 `roleClientConfig`,
 * 它就会按**父会话模型**的默认窗口算,和自动压缩用两个不同的数。
 *
 * 2026-08-19 跑机实测的后果:员工声明 233000 → 压缩阈值 200000,而这里漏传窗口 → 恒在
 * 177000 开火 → [177000, 200000) 是一段必杀区间,落进去的那一轮被合成一条
 * `Prompt is too long` 判死,**API 一次都没发出去,也没压缩**。全 run 10 个执行席位命中,
 * 6 个节点最终 BLOCKED;判据是这 10 席的那条报错 `errorDetails` **一条都没有**(真上游
 * 拒收必带,见 `errors.ts`)。而区间宽度随声明值放大:声明 1M 是 [177000, 967000)。
 *
 * 探针打在这个函数上,就能直接问「给了员工窗口之后它认不认」——内联表达式只能靠在测试里
 * 重抄一遍来验,而重抄出来的那份和真身漂移时测试仍然是绿的。
 */
export function shouldPreemptForContextLimit(
  tokenCount: number,
  model: string,
  roleClientConfig: { roleName?: string; contextWindow?: number } | undefined,
): boolean {
  return calculateTokenWarningState(
    tokenCount,
    model,
    effectiveRoleContextWindow(roleClientConfig),
  ).isAtBlockingLimit
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
  /** 员工自己的上下文窗口(见 getEffectiveContextWindowSize 的同名参数)。 */
  contextWindowOverride?: number,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model, contextWindowOverride)
  const effectiveWindow = getEffectiveContextWindowSize(
    model,
    contextWindowOverride,
  )

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${contextWindowOverride ? ` roleWindow=${contextWindowOverride}` : ''}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
    contextWindowOverride,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  /**
   * 翻译型协议的员工跑在别人的模型上,而 `mainLoopModel` 是父会话的 Claude 模型
   * (`runAgent.ts:352` 故意这么设)。这里是**唯一**同时看得见「这次查询属于哪个员工」和
   * 「压缩该不该发生」的地方 —— 见 getEffectiveContextWindowSize 的参数注释。
   */
  /**
   * **声明值和学到的上界取小** —— 见 roleContextCeiling 的文件头。
   *
   * 原来这里直接读 `contextWindow`,也就是完全相信用户在 settings 里写的那句话。
   * 写大了的后果是压缩阈值坐在对面真实上限的外面:压缩永远够不着,直接撞上游 400,
   * 而这个 fork 撞上去没有任何兜底。
   */
  const roleWindow = effectiveRoleContextWindow(
    toolUseContext.options.roleClientConfig,
  )
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
    roleWindow,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model, roleWindow),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
