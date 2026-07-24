import { randomUUID } from 'crypto'
import type { Readable, Writable } from 'stream'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../../remote/remotePermissionBridge.js'
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
 * Accumulates `chunk` into `buffer.rest` and extracts every complete
 * `\n`-terminated line as a parsed JSON object. A trailing partial line
 * (no terminating newline yet) is left in `buffer.rest` for the next call,
 * so this tolerates the protocol stream being split across chunk
 * boundaries (e.g. a child stdout write lands mid-line across two `read()`
 * calls). Malformed lines are logged via `logError` and skipped rather than
 * thrown, so one bad line from the child process doesn't take down the
 * whole interactive session.
 *
 * `buffer` is caller-owned (one `{ rest: '' }` per proc's stdout stream) so
 * this stays a pure, independently-unit-testable function with no hidden
 * module-level state.
 */
export function parseJsonLines(chunk: string, buffer: { rest: string }): any[] {
  buffer.rest += chunk
  const out: any[] = []
  let newlineIndex: number
  while ((newlineIndex = buffer.rest.indexOf('\n')) >= 0) {
    const line = buffer.rest.slice(0, newlineIndex).trim()
    buffer.rest = buffer.rest.slice(newlineIndex + 1)
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      logError(new Error(`cliAgentRunner: skipping malformed protocol line: ${line}`))
    }
  }
  return out
}

/**
 * Adapts a single `permission_request` protocol line into a call against the
 * PARENT's `canUseTool` — the same function `AgentTool.call` hands to
 * `runAgent` for in-process subagents — rather than hand-rolling a
 * confirmation path here. This is what routes a CLI subagent's tool-use
 * request through the same terminal confirmation (and Feishu racer, see
 * useFeishuBridge) as any other tool use.
 *
 * The protocol's `{id, tool, input}` shape doesn't carry a local `Tool`
 * instance or a real `AssistantMessage`, both of which `canUseTool`
 * requires, so it's adapted the same way remote/SSH sessions adapt an
 * `SDKControlPermissionRequest` they don't have a local tool for: a
 * `createToolStub(toolName)` stand-in `Tool` and a
 * `createSyntheticAssistantMessage(request, requestId)` synthetic message
 * embedding the tool_use block (see remotePermissionBridge.ts,
 * useSSHSession.ts for the same pattern).
 *
 * The resulting `PermissionDecision` is mapped back into a
 * `permission_response` line written to the child's stdin: `allow` carries
 * `updatedInput` through; `deny` (and, defensively, `ask` — canUseTool's
 * contract is to only resolve once a terminal decision is reached, so an
 * `ask` reaching here would indicate an upstream bug) carries the
 * decision's `message` as `feedback` rather than blocking the child
 * indefinitely.
 */
async function handlePermissionRequest(
  msg: { id: string; tool: string; input?: Record<string, unknown> },
  proc: CliProcessHandle,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<void> {
  const input = msg.input ?? {}
  const tool = createToolStub(msg.tool)
  const assistantMessage = createSyntheticAssistantMessage(
    {
      subtype: 'can_use_tool',
      tool_name: msg.tool,
      input,
      tool_use_id: msg.id,
    } as Parameters<typeof createSyntheticAssistantMessage>[0],
    msg.id,
  )

  const decision = await canUseTool(tool, input, toolUseContext, assistantMessage, msg.id)

  if (decision.behavior === 'allow') {
    proc.stdin.write(
      JSON.stringify({
        type: 'permission_response',
        id: msg.id,
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      }) + '\n',
    )
    return
  }

  proc.stdin.write(
    JSON.stringify({
      type: 'permission_response',
      id: msg.id,
      behavior: 'deny',
      feedback: 'message' in decision ? decision.message : undefined,
    }) + '\n',
  )
}

/**
 * Interactive tier — implements the bidirectional JSON-lines protocol for
 * agents where `agentDef.interactive` is truthy:
 *
 *  - parent -> child (stdin, one JSON object per line): `{"type":"task",
 *    "prompt":...}` kicks off the run; `{"type":"permission_response", id,
 *    behavior, ...}` answers a pending permission request.
 *  - child -> parent (stdout, one JSON object per line, via
 *    `parseJsonLines`): `{"type":"permission_request", id, tool, input}`
 *    asks for a tool permission (handled by `handlePermissionRequest`
 *    above); `{"type":"result", content}` carries the final answer;
 *    anything else (e.g. a future "log" type) is ignored — the child's own
 *    diagnostics belong on stderr, not the stdout protocol stream.
 *
 * stderr is drained concurrently (fire-and-forget, not awaited) and any
 * output surfaced via `logError`, mirroring the non-interactive tier's
 * treatment of stderr as diagnostics rather than protocol, and avoiding the
 * same stdout/stderr pipe-buffer deadlock `runCliAgent`'s non-interactive
 * branch guards against.
 *
 * Only ever yields one final `Message` (via `makeResultMessage`), once the
 * child's stdout stream ends and the process has exited — matching the
 * non-interactive tier so `finalizeAgentTool`/`getLastAssistantMessage`
 * (agentToolUtils.ts) can treat any `runCliAgent` output uniformly.
 *
 * Process lifecycle (timeout / kill on abort) is NOT handled here — see the
 * brief's note on wiring `toolUseContext.abortController.signal` to
 * `proc.kill()`; deferred as a follow-up increment.
 */
export async function* runInteractive(
  proc: CliProcessHandle,
  agentDef: unknown,
  task: CliAgentTask,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
): AsyncGenerator<Message> {
  proc.stdin.write(JSON.stringify({ type: 'task', prompt: task.prompt }) + '\n')

  void (async () => {
    for await (const chunk of proc.stderr) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (text) logError(new Error(text))
    }
  })()

  const buffer = { rest: '' }
  let result = ''

  for await (const chunk of proc.stdout) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const msg of parseJsonLines(text, buffer)) {
      if (!msg || typeof msg !== 'object') continue
      switch (msg.type) {
        case 'permission_request':
          await handlePermissionRequest(msg, proc, toolUseContext, canUseTool)
          break
        case 'result':
          result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
          break
        case 'error':
          logError(new Error(`cli agent error: ${msg.message ?? 'unknown error'}`))
          if (!result) result = `[cli error] ${msg.message ?? 'unknown error'}`
          break
        default:
          break
      }
    }
  }

  await proc.exited
  yield makeResultMessage(result)
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
 * The interactive tier (`agentDef.interactive` truthy) delegates to
 * `runInteractive` above.
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
