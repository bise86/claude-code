import { validateBoundedIntEnvVar } from '../envValidation.js'

/**
 * Bash 产出的截断长度。**这个 fork 里不截断。**
 *
 * 上游默认 30_000 字符、`BASH_MAX_OUTPUT_LENGTH` 最多抬到 150_000。超出的部分被换成
 * 一行 `... [N lines truncated] ...` —— 而被截掉的恰恰是尾部,一次失败的构建/测试里
 * 最有用的就是尾部那几十行。
 *
 * 上限也一起放开:留着 150_000 的话,想调大的人会在一个自己没设过的数上撞墙。
 */
export const BASH_MAX_OUTPUT_UPPER_LIMIT = Number.POSITIVE_INFINITY
export const BASH_MAX_OUTPUT_DEFAULT = Number.POSITIVE_INFINITY

export function getMaxOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}
