import { randomUUID } from 'crypto'
import type { Readable, Writable } from 'stream'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logError } from '../../utils/log.js'

/**
 * Minimal process handle abstraction so `runCliAgent` can be driven by a
 * fake in tests without touching a real OS process. The default
 * implementation (`defaultSpawn`) wraps `Bun.spawn`.
 */
export type CliProcessHandle = {
  stdin: Pick<Writable, 'write'> & { end: () => void }
  stdout: AsyncIterable<Uint8Array | string>
  stderr: AsyncIterable<Uint8Array | string>
  kill: () => void
  exited: Promise<number>
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => CliProcessHandle

export type CliAgentTask = {
  prompt: string
  description: string
}

export type CliAgentDeps = {
  spawn?: SpawnFn
}

/**
 * Builds a spec-compliant assistant `Message` (matching the shape actually
 * produced by the real query loop — see
 * src/services/api/claude.ts (`const m: AssistantMessage = { message: {
 * ...result, content }, requestId, type: 'assistant', uuid, timestamp }`)
 * and the synthetic-message constructor `baseCreateAssistantMessage` in
 * src/utils/messages.ts — so that any consumer reading a `Message[]`
 * (e.g. `getLastAssistantMessage` / `finalizeAgentTool` in
 * src/tools/AgentTool/agentToolUtils.ts) can extract the final text and a
 * valid token usage from it without special-casing CLI-originated results.
 *
 * `model: 'cli'` is a sentinel (analogous to `SYNTHETIC_MODEL` used
 * elsewhere for non-API-driven assistant messages) marking this message as
 * having come from an external CLI process rather than a real model API
 * call.
 */
export function makeResultMessage(text: string): Message {
  const message: AssistantMessage = {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: {
      id: `cli-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'cli',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as AssistantMessage
  return message
}

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  return out
}

function defaultSpawn(cmd: string, args: string[], opts?: { cwd?: string }): CliProcessHandle {
  const p = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdin: {
      write: (d: string) => {
        p.stdin.write(d)
      },
      end: () => {
        p.stdin.end()
      },
    },
    stdout: p.stdout,
    stderr: p.stderr,
    kill: () => p.kill(),
    exited: p.exited,
  }
}

/**
 * Interactive tier — implements the (future) bidirectional CLI protocol for
 * agents where `agentDef.interactive` is truthy. NOT implemented here; this
 * is Task 9's responsibility. The non-interactive path in `runCliAgent`
 * never calls this.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function* runInteractive(
  proc: CliProcessHandle,
  agentDef: unknown,
  task: CliAgentTask,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
): AsyncGenerator<Message> {
  throw new Error('interactive tier not implemented yet (Task 9)')
  // eslint-disable-next-line no-unreachable
  yield undefined as never
}

/**
 * Runs a CLI-backed subagent and yields `Message`s in the same shape
 * `runAgent` yields, so `AgentTool.call`'s message consumer
 * (`finalizeAgentTool` / `getLastAssistantMessage`) can extract the final
 * assistant text as the tool_result.
 *
 * Non-interactive tier (`agentDef.interactive` falsy): the entire
 * `task.prompt` is written to the child process's stdin and stdin is
 * closed; stdout is read to completion while the process runs (avoiding a
 * stdout/stderr pipe-buffer deadlock) and the trimmed result is yielded as
 * a single final assistant `Message`. stderr is drained and, if non-empty,
 * surfaced via `logError` rather than mixed into the result text.
 *
 * The interactive tier (`agentDef.interactive` truthy) is out of scope for
 * this task — see `runInteractive` above (Task 9).
 */
export async function* runCliAgent(
  agentDef: { command: string; args?: string[]; roleCwd?: string; interactive?: boolean },
  task: CliAgentTask,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: unknown,
  deps?: CliAgentDeps,
): AsyncGenerator<Message> {
  const spawn = deps?.spawn ?? defaultSpawn
  const proc = spawn(agentDef.command, agentDef.args ?? [], { cwd: agentDef.roleCwd })

  if (agentDef.interactive) {
    yield* runInteractive(proc, agentDef, task, toolUseContext, canUseTool)
    return
  }

  // Non-interactive: prompt -> stdin, full stdout -> result (single-shot).
  // Read stdout/stderr concurrently with the process running so a large
  // stdout write doesn't block on a full pipe buffer while nothing drains
  // it (classic spawn deadlock).
  proc.stdin.write(task.prompt)
  proc.stdin.end()
  const [out] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr).then(stderrText => {
      if (stderrText) logError(new Error(stderrText))
    }),
  ])
  await proc.exited

  yield makeResultMessage(out.trim())
}
