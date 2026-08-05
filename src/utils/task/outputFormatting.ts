import { validateBoundedIntEnvVar } from '../envValidation.js'
import { getTaskOutputPath } from './diskOutput.js'

/**
 * 子 agent(Task)回传产出的截断长度。**这个 fork 里不截断。**
 *
 * 上游默认 32_000 字符,超了只保留**末尾**那一段并在开头贴一行文件路径。子 agent 的
 * 产出正是最不该截的一类:它已经是一份压缩过的结论,截掉开头就是截掉结论本身。
 */
export const TASK_MAX_OUTPUT_UPPER_LIMIT = Number.POSITIVE_INFINITY
export const TASK_MAX_OUTPUT_DEFAULT = Number.POSITIVE_INFINITY

export function getMaxTaskOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}

/**
 * Format task output for API consumption, truncating if too large.
 * When truncated, includes a header with the file path and returns
 * the last N characters that fit within the limit.
 */
export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength()

  if (output.length <= maxLen) {
    return { content: output, wasTruncated: false }
  }

  const filePath = getTaskOutputPath(taskId)
  const header = `[Truncated. Full output: ${filePath}]\n\n`
  const availableSpace = maxLen - header.length
  const truncated = output.slice(-availableSpace)

  return { content: header + truncated, wasTruncated: true }
}
