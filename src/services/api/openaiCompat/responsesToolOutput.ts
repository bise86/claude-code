import { createHash } from 'node:crypto'
import { reportContextNotice } from '../contextNoticeSink.js'

// Observed Responses validation limit for input[].output, measured in characters,
// independent of the model's token window and server-side compaction threshold.
const MAX_OUTPUT_CHARS = 10_485_760

/**
 * Apply the field limit to the final outgoing input, after checkpoint pruning.
 * This also repairs resumed history and tools exempt from local output budgets.
 * Only the request copy changes; the full result remains in the transcript and
 * in a file that the model can search/read in bounded portions.
 */
export async function prepareResponsesToolOutputs(body: any): Promise<void> {
  if (!Array.isArray(body?.input)) return
  let persisted = 0
  for (const [index, item] of body.input.entries()) {
    if (item?.type !== 'function_call_output' || typeof item.output !== 'string' || item.output.length <= MAX_OUTPUT_CHARS) continue

    // Load disk/session helpers only when a result actually exceeds the limit.
    const { persistToolResult, isPersistError, buildLargeToolResultMessage } = await import('../../../utils/toolResultStorage.js')
    // Upstream call IDs are untrusted filenames and may be reused on replay.
    // Content-addressing is path-safe and keeps retries/resumes byte-identical
    // without retaining multi-megabyte strings in a process-wide cache.
    const id = `responses-output-${createHash('sha256').update(item.output).digest('hex')}`
    const saved = await persistToolResult(item.output, id)
    if (isPersistError(saved)) {
      // Sending the original would just repeat string_above_max_length. Never
      // discard the full result when disk persistence fails.
      throw new Error(
        `Responses input[${index}].output 长度 ${item.output.length} 超过 ${MAX_OUTPUT_CHARS} 字符，` +
        `且无法保存完整工具结果：${saved.error}。请检查会话目录权限和磁盘空间后重试。`,
      )
    }
    item.output = buildLargeToolResultMessage(saved) +
      '\nUse Read with offset and limit, or Grep, to retrieve only the relevant sections of this file.'
    persisted++
  }
  if (persisted > 0) {
    reportContextNotice({
      kind: 'tool-result-persisted',
      text: `Responses 单条工具结果上限为 ${MAX_OUTPUT_CHARS} 字符；已将 ${persisted} 条超限结果完整保存到文件，请求中改用预览和文件路径。`,
    })
  }
}
