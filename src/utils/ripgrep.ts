import type { ChildProcess, ExecFileException } from 'child_process'
import { execFile, spawn } from 'child_process'
import memoize from 'lodash-es/memoize.js'
import { existsSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { fileURLToPath } from 'url'
import { isInBundledMode, isSingleFileExecutable } from './bundledMode.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { findExecutable } from './findExecutable.js'
import { logError } from './log.js'
import { getPlatform } from './platform.js'
import { countCharInString } from './stringUtils.js'

const __filename = fileURLToPath(import.meta.url)
// we use node:path.join instead of node:url.resolve because the former doesn't encode spaces
const __dirname = path.join(
  __filename,
  process.env.NODE_ENV === 'test' ? '../../../' : '../',
)

type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
}

/** `vendor/ripgrep/<arch>-<platform>/rg` under a given root. */
function vendoredRgUnder(root: string): string {
  const rgRoot = path.resolve(root, 'vendor', 'ripgrep')
  return process.platform === 'win32'
    ? path.resolve(rgRoot, `${process.arch}-win32`, 'rg.exe')
    : path.resolve(rgRoot, `${process.arch}-${process.platform}`, 'rg')
}

/**
 * 决定 rg 从哪来。**纯函数 + 注入依赖**,因为下面那个 memoize 让分支在测试里够不着 ——
 * 而这次的 bug(`ENOENT: posix_spawn '/$bunfs/root/vendor/ripgrep/x64-linux/rg'`)
 * 恰恰是一条只在打包态才走到的分支。够不着 = 测不到 = 只能等用户来报。
 */
/**
 * 「搜索用不了」这件事该说的话。
 *
 * 一句话为什么要出现在**两个**地方:
 *
 *  - `onMissing` 那次是**解析时**说的,而它只走 logError —— 进内部缓冲和遥测,
 *    终端上一个字都不打(实测 stderr 完全为空)。用户和模型都看不见。
 *  - 真正致命的是模型看不见:Grep/Glob 的 spawn 失败之后,工具结果里是一句裸的
 *    `spawn rg ENOENT`。模型不知道这意味着「这台机器上搜索整个不可用」,于是它
 *    **开始猜文件名** —— 用户看到的就是一连串
 *    「File does not exist. Note: your current working directory is …」。
 *
 * 这条链是实测走通过的,而且用户报了两次。所以同一句话必须接到工具结果上。
 */
export const RIPGREP_MISSING_MESSAGE =
  '找不到 ripgrep:本地没有内置的 vendor/ripgrep,系统 PATH 上也没有 rg。' +
  'Grep / Glob / 全局搜索都会失败,子 agent 会因此列不出文件。' +
  '装一个 ripgrep(apt install ripgrep / brew install ripgrep),或把 vendor/ripgrep 放到可执行文件旁边。'

/**
 * 把一次 spawn 失败翻译成模型能照做的话。
 *
 * 只管 ENOENT/EACCES/EPERM —— 那三种是「rg 这个程序有问题」,不是「这次搜索没匹配」。
 * 其余错误原样透传:替一个不认识的错误编故事,比原样交出去更糟。
 */
export function describeRipgrepFailure(err: { code?: unknown; message?: string }): string {
  const code = typeof err.code === 'string' ? err.code : ''
  if (code === 'ENOENT') {
    return `${RIPGREP_MISSING_MESSAGE}(原始错误: ${err.message ?? 'ENOENT'})`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `ripgrep 存在但没有执行权限(${code})。搜索不可用,子 agent 会因此列不出文件。` +
      `给它加上可执行位,或装一个系统的 ripgrep。(原始错误: ${err.message ?? code})`
  }
  return err.message ?? String(code || '未知错误')
}

export function resolveRipgrepConfig(deps: {
  wantsSystem: boolean
  isOfficialNativeBuild: boolean
  isSingleFile: boolean
  /** PATH 上有没有 rg。findExecutable 找不到时会原样返回 'rg'。 */
  systemRg: () => string
  fileExists: (p: string) => boolean
  execPath: string
  moduleDir: string
  onMissing?: (msg: string) => void
}): RipgrepConfig {
  if (deps.wantsSystem && deps.systemRg() !== 'rg') {
    // SECURITY: Use command name 'rg' instead of the resolved path to prevent PATH hijacking.
    return { mode: 'system', command: 'rg', args: [] }
  }
  if (deps.isOfficialNativeBuild) {
    return { mode: 'embedded', command: deps.execPath, args: ['--no-config'], argv0: 'rg' }
  }

  /**
   * 内置的那份**必须先确认它真的在盘上**。
   *
   * 原来这里是无条件拼一条路径就返回,踩出两个真实故障:
   *
   *  1. 打包态:`moduleDir` 是 bunfs 虚拟根,拼出 `/$bunfs/root/vendor/ripgrep/x64-linux/rg`。
   *     嵌进单文件产物的东西**只能读、不能 spawn** → 用户报的
   *     `ENOENT: posix_spawn '/$bunfs/root/…/rg'`。
   *  2. **开发态也一样坏**:这个 fork 的 `vendor/` 里只有 zod-v4.js,**从来没有过
   *     vendor/ripgrep/**。所以从源码跑时拼出来的那条路径同样不存在,每一次
   *     Grep/Glob 都 ENOENT —— 只是错误信息没有 `$bunfs` 那么显眼,一直被当成别的问题。
   *
   * 后果远不止「搜索失败」:Glob 是 ripgrep 驱动的,子 agent 因此**列不出文件**,
   * 只能猜文件名,于是 Read 报 "File does not exist",而方案环节则产出
   * 「由于文件系统工具无法正常访问…」这种一句话方案。
   *
   * 所以顺序改成:候选路径逐个**查存在性** → 系统 rg → 报一句能照做的话。
   */
  const candidates = deps.isSingleFile
    // 单文件产物:只有「挨着可执行文件」这一种放法有意义,moduleDir 是虚拟根。
    ? [vendoredRgUnder(path.dirname(deps.execPath))]
    : [vendoredRgUnder(deps.moduleDir), vendoredRgUnder(path.dirname(deps.execPath))]
  for (const c of candidates) {
    if (deps.fileExists(c)) return { mode: 'builtin', command: c, args: [] }
  }

  if (deps.systemRg() !== 'rg') return { mode: 'system', command: 'rg', args: [] }

  /**
   * 哪儿都没有。仍然返回 `'rg'` —— 让失败发生在一个用户认得、能自己装的名字上,
   * 而不是一条他从没见过的 `/$bunfs/` 或 `src/utils/vendor/…` 路径。
   *
   * 也**不能**退到上面那条 argv0 分发:那依赖官方构建把 ripgrep 静态链进 bun-internal。
   * 实测 `spawn(本 fork 的二进制, ['--version'], { argv0: 'rg' })` 返回的是 Claude Code
   * 自己的版本号,不是 ripgrep 的 —— 把搜索结果换成一行版本号,比 ENOENT 更难发现。
   */
  deps.onMissing?.(RIPGREP_MISSING_MESSAGE)
  return { mode: 'system', command: 'rg', args: [] }
}

const getRipgrepConfig = memoize((): RipgrepConfig => {
  const userWantsSystemRipgrep = isEnvDefinedFalsy(
    process.env.USE_BUILTIN_RIPGREP,
  )

  return resolveRipgrepConfig({
    wantsSystem: userWantsSystemRipgrep,
    isOfficialNativeBuild: isInBundledMode(),
    isSingleFile: isSingleFileExecutable(),
    systemRg: () => findExecutable('rg', []).cmd,
    fileExists: existsSync,
    execPath: process.execPath,
    moduleDir: __dirname,
    onMissing: msg => logError(new Error(msg)),
  })
})

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

const MAX_BUFFER_SIZE = 20_000_000 // 20MB; large monorepos can have 200k+ files

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  )
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
): ChildProcess {
  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided

  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : []
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target]
  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
  const parsedSeconds =
    parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || '', 10) || 0
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    // Set up timeout with SIGKILL escalation.
    // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
    // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
    // escalate to SIGKILL which cannot be caught or ignored.
    // On Windows, child.kill('SIGTERM') throws; use default signal.
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(c => c.kill('SIGKILL'), 5_000, child)
      }
    }, timeout)

    // On Windows, both 'close' and 'error' can fire for the same process
    // (e.g. when AbortSignal kills the child). Guard against double-callback.
    let settled = false
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      if (code === 0 || code === 1) {
        // 0 = matches found, 1 = no matches (both are success)
        callback(null, stdout, stderr)
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        )
        error.code = code ?? undefined
        error.signal = signal ?? undefined
        callback(error, stdout, stderr)
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      const error: ExecFileException = err
      callback(error, stdout, stderr)
    })

    return child
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  return execFile(
    rgPath,
    fullArgs,
    {
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
    },
    callback,
  )
}

/**
 * Stream-count lines from `rg --files` without buffering stdout.
 *
 * On large repos (e.g. 247k files, 16MB of paths), calling `ripGrep()` just
 * to read `.length` materializes the full stdout string plus a 247k-element
 * array. This counts newline bytes per chunk instead; peak memory is one
 * stream chunk (~64KB).
 *
 * Intentionally minimal: the only caller is telemetry (countFilesRoundedRg),
 * which swallows all errors. No EAGAIN retry, no stderr capture, no internal
 * timeout (callers pass AbortSignal.timeout; spawn's signal option kills rg).
 */
async function ripGrepFileCount(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<number> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<number>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let lines = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      lines += countCharInString(chunk, '\n')
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      settled = true
      if (code === 0 || code === 1) resolve(lines)
      else reject(new Error(`rg --files exited ${code}`))
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      // 和 ripGrep 同因:裸的 spawn 错误对模型没有信息量,它会转而猜文件名。
      // 这两条是 Glob(--files)和流式搜索走的路,一样要说人话。
      const wrapped = new Error(describeRipgrepFailure(err as { code?: unknown; message?: string }))
      ;(wrapped as { code?: unknown }).code = (err as { code?: unknown }).code
      reject(wrapped)
    })
  })
}

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout, stderr is ignored; interactive callers own recovery.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary()
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l)
    let remainder = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString()
      const lines = data.split('\n')
      remainder = lines.pop() ?? ''
      if (lines.length) onLines(lines.map(stripCR))
    })

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false
    child.on('close', code => {
      if (settled) return
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return
      settled = true
      if (code === 0 || code === 1) {
        if (remainder) onLines([stripCR(remainder)])
        resolve()
      } else {
        reject(new Error(`ripgrep exited with code ${code}`))
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      // 和 ripGrep 同因:裸的 spawn 错误对模型没有信息量,它会转而猜文件名。
      // 这两条是 Glob(--files)和流式搜索走的路,一样要说人话。
      const wrapped = new Error(describeRipgrepFailure(err as { code?: unknown; message?: string }))
      ;(wrapped as { code?: unknown }).code = (err as { code?: unknown }).code
      reject(wrapped)
    })
  })
}

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch(error => {
    logError(error)
  })

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
        return
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([])
        return
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM']
      if (CRITICAL_ERROR_CODES.includes(error.code as string)) {
        // 裸的 `spawn rg ENOENT` 对模型是没有信息量的:它不知道这意味着「这台机器上
        // 搜索整个不可用」,于是**开始猜文件名**,用户看到一连串 "File does not exist"。
        // 换成一句能照做的话。
        const wrapped = new Error(describeRipgrepFailure(error))
        ;(wrapped as { code?: unknown }).code = error.code
        reject(wrapped)
        return
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        logForDebugging(
          `rg EAGAIN error detected, retrying with single-threaded mode (-j 1)`,
        )
        logEvent('tengu_ripgrep_eagain_retry', {})
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true)
          },
          true, // Force single-threaded mode for this retry only
        )
        return
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR'
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

      let lines: string[] = []
      if (hasOutput) {
        lines = stdout
          .trim()
          .split('\n')
          .map(line => line.replace(/\r$/, ''))
          .filter(Boolean)
        // Drop last line for timeouts and buffer overflow - it may be incomplete
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }
      }

      logForDebugging(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      )

      // code 2 = ripgrep usage error (already handled); ABORT_ERR = caller
      // explicitly aborted (not an error, just a cancellation — interactive
      // callers may abort on every keystroke-after-debounce).
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        logError(error)
      }

      // If we timed out with no results, throw an error so Claude knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        )
        return
      }

      resolve(lines)
    }

    ripGrepRaw(args, target, abortSignal, (error, stdout, stderr) => {
      handleResult(error, stdout, stderr, false)
    })
  })
}

/**
 * Count files in a directory recursively using ripgrep and round to the nearest power of 10 for privacy
 *
 * This is much more efficient than using native Node.js methods for counting files
 * in large directories since it uses ripgrep's highly optimized file traversal.
 *
 * @param path Directory path to count files in
 * @param abortSignal AbortSignal to cancel the operation
 * @param ignorePatterns Optional additional patterns to ignore (beyond .gitignore)
 * @returns Approximate file count rounded to the nearest power of 10
 */
export const countFilesRoundedRg = memoize(
  async (
    dirPath: string,
    abortSignal: AbortSignal,
    ignorePatterns: string[] = [],
  ): Promise<number | undefined> => {
    // Skip file counting if we're in the home directory to avoid triggering
    // macOS TCC permission dialogs for Desktop, Downloads, Documents, etc.
    if (path.resolve(dirPath) === path.resolve(homedir())) {
      return undefined
    }

    try {
      // Build ripgrep arguments:
      // --files: List files that would be searched (rather than searching them)
      // --count: Only print a count of matching lines for each file
      // --no-ignore-parent: Don't respect ignore files in parent directories
      // --hidden: Search hidden files and directories
      const args = ['--files', '--hidden']

      // Add ignore patterns if provided
      ignorePatterns.forEach(pattern => {
        args.push('--glob', `!${pattern}`)
      })

      const count = await ripGrepFileCount(args, dirPath, abortSignal)

      // Round to nearest power of 10 for privacy
      if (count === 0) return 0

      const magnitude = Math.floor(Math.log10(count))
      const power = Math.pow(10, magnitude)

      // Round to nearest power of 10
      // e.g., 8 -> 10, 42 -> 100, 350 -> 100, 750 -> 1000
      return Math.round(count / power) * power
    } catch (error) {
      // AbortSignal.timeout firing is expected on large/slow repos, not an error.
      if ((error as Error)?.name !== 'AbortError') logError(error)
    }
  },
  // lodash memoize's default resolver only uses the first argument.
  // ignorePatterns affect the result, so include them in the cache key.
  // abortSignal is intentionally excluded — it doesn't affect the count.
  (dirPath, _abortSignal, ignorePatterns = []) =>
    `${dirPath}|${ignorePatterns.join(',')}`,
)

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}

/**
 * 「这次运行里搜索能不能用」。
 *
 * 给 /et 的启动关口用。搜索用不了是**比隔离降级更严重**的降质:子 agent 列不出文件,
 * 于是猜文件名,于是 Read 一路报 "File does not exist",而方案环节产出的是
 * 「由于文件系统工具无法正常访问…」这种一句话方案 —— 用户为此付了一整轮的钱。
 * 用户报过两次,两次都是先烧掉一次运行才发现。所以要在**开跑之前**说。
 *
 * 判据是 `mode === 'system' && command === 'rg'`:resolveRipgrepConfig 在哪儿都找不到时
 * 就返回这个形状(故意让失败发生在一个用户认得的名字上)。这里把它翻译回「找不到」。
 */
export function searchUnavailableReason(
  status: { mode: string; path: string } = getRipgrepStatus(),
): string | undefined {
  if (status.mode === 'system' && status.path === 'rg') return RIPGREP_MISSING_MESSAGE
  return undefined
}
