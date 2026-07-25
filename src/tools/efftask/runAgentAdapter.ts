import { runAgent } from '../AgentTool/runAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { createUserMessage } from '../../utils/messages.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { RunAgentFn } from './roundtable.js'
import type { RoleBinding } from './types.js'

export function collectText(messages: Message[]): string {
  let out = ''
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = m.message.content
    // `content` is a plain string in one legitimate variant (see utils/messages.ts and
    // services/api/claude.ts). Falling through to the block loop would iterate CHARACTERS,
    // every `.type` would be undefined, and the whole answer would vanish silently — the
    // exact "dropped content corrupts every downstream decision" failure this seam exists
    // to avoid.
    if (typeof content === 'string') { out += content; continue }
    for (const block of (content as { type: string; text?: string }[])) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return out
}

export function pickAgentDefinition(
  role: RoleBinding | null,
  activeAgents: AgentDefinition[],
  mainModelDefault: AgentDefinition,
): AgentDefinition {
  if (!role) return mainModelDefault
  // First match wins on a duplicated agentType — deterministic, and the roster order is
  // itself deterministic (settings order), so the same role always resolves the same way.
  return activeAgents.find(a => a.agentType === role.roleName) ?? mainModelDefault
}

export function makeRunAgentFn(deps: {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  availableTools: Tools
  // REAL read-only tools (Read/Glob/Grep), filtered from the parent pool by the caller.
  // NOT [] — plan/review/accept/observer must be able to READ the repo to judge anything;
  // they just must not be able to WRITE it. (The one-shot config-extraction call is the
  // only no-tools caller, and it gets its own RunAgentFn.)
  readOnlyTools: Tools
  activeAgents: AgentDefinition[]
  mainModelDefault: AgentDefinition
  /**
   * Wall-clock deadline for ONE phase call. Every other axis of this system is bounded —
   * depth, node count, three iteration counters, infra retries — but a provider that hangs
   * without ever rejecting has no bound at all: the pipeline parks in `await`, the tree
   * shows 运行中 forever, and even an abort cannot unstick it because nothing is polling.
   * 0 disables it.
   */
  timeoutMs?: number
  runAgentImpl?: typeof runAgent // injectable for tests; defaults to the real runAgent
}): RunAgentFn {
  const run = deps.runAgentImpl ?? runAgent
  return async req => {
    // Already cancelled → don't start a sub-agent at all. Without this an abort racing the
    // next phase call still launches a real, tool-bearing agent (write-capable in the
    // execute phase). runRoundtable guards the same way for the same reason.
    if (req.signal.aborted) return ''
    const picked = pickAgentDefinition(req.role, deps.activeAgents, deps.mainModelDefault)
    // Per-phase tool gating: only the execute phase gets the write-capable tool pool.
    const tools: Tools = req.phase === 'execute' ? deps.availableTools : deps.readOnlyTools
    /**
     * Strip the role's OWN MCP servers outside the execute phase.
     *
     * The tool gating above is applied by runAgent via resolveAgentTools — and then runAgent
     * merges `agentMcpTools` back in AFTERWARDS (runAgent.ts, `uniqBy([...resolvedTools,
     * ...agentMcpTools])`). So a custom agent that declares `mcpServers` and is bound as a
     * review/accept role gets its own, possibly write-capable, MCP tools back: that
     * "reviewer" can fix the problem itself and then pass the work — exactly what separating
     * executor from reviewer exists to prevent.
     *
     * Done HERE, caller-side, rather than by changing runAgent: `initializeAgentMcpServers`
     * early-returns `tools: []` when `mcpServers` is empty, so the hole closes completely
     * while every other AgentTool caller keeps its current contract. It also avoids spawning
     * arbitrary MCP server processes for a read-only reviewer.
     *
     * Honest cost: this also denies reviewers any READ-ONLY MCP tools. And the practical
     * severity today is moderated by canUseTool still prompting — fully silent self-approval
     * needs bypassPermissions or an already-allowlisted MCP tool.
     *
     * `disallowedTools` was the obvious alternative and does NOT work: it is consumed only
     * inside resolveAgentTools, which runs BEFORE the MCP merge, and filterToolsForAgent
     * returns true unconditionally for any `mcp__*` name.
     */
    const agentDefinition: AgentDefinition =
      req.phase === 'execute' ? picked : { ...picked, mcpServers: undefined }
    const promptMessages: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: `${req.system}\n\n${req.prompt}` }] }),
    ]
    // Forward cancellation INTO the sub-agent instead of only polling between messages:
    // otherwise an abort is invisible until the next yield, so a stall before the first
    // message is never noticed and a cancelled run keeps a live agent working.
    // (An already-aborted signal returned above, so the listener is always the live path.)
    const inner = new AbortController()
    const relay = (): void => inner.abort()
    req.signal.addEventListener('abort', relay, { once: true })
    // The deadline aborts the sub-agent the same way a user Esc does, so a hung provider
    // ends the phase instead of parking the pipeline forever.
    let timedOut = false
    const timer = deps.timeoutMs && deps.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; inner.abort() }, deps.timeoutMs)
      : undefined

    const collected: Message[] = []
    const invoke = (): AsyncGenerator<Message, void> =>
      run({
        agentDefinition,
        promptMessages,
        toolUseContext: deps.toolUseContext,
        canUseTool: deps.canUseTool,
        isAsync: false,
        querySource: 'agent:custom',
        // NOT validated: an unrecognized alias simply falls through to runAgent's own model
        // resolution (which applies its default). We do not pre-check the string here.
        model: req.role?.model as ModelAlias | undefined,
        availableTools: tools,
        // runAgent's `worktreePath` is METADATA ONLY — it is recorded for resume and does
        // NOT change the sub-agent's cwd (AgentTool does that separately via
        // runWithCwdOverride). So we both record it AND actually switch the cwd below;
        // passing it alone would let P2's worktree executor write into the shared tree.
        worktreePath: req.cwd,
        override: { abortController: inner },
      })

    // The WHOLE consumption must run inside the cwd override, not just the call that
    // creates the generator: runWithCwdOverride is AsyncLocalStorage-based, and a generator
    // body does not execute until its first next() — by which time a wrapper around the
    // factory call has already exited and pwd() would resolve to the shared cwd again.
    const consume = async (): Promise<void> => {
      for await (const message of invoke()) {
        collected.push(message)
        if (req.onChunk && message.type === 'assistant') {
          // A crashing renderer must not take the run down (same rule as pipeline/orchestrator).
          try { req.onChunk(collectText([message])) } catch { /* ignore */ }
        }
        if (req.signal.aborted || timedOut) break
      }
    }
    // Hoisted so the outer finally can clear it on EVERY exit path. It used to be cleared by
    // `void work.finally(...)`, but `.finally()` returns a DERIVED promise: when `work`
    // rejected, that derived promise rejected with nothing attached to it. The caller still
    // saw the real error (Promise.race observes `work` itself), so nothing looked wrong —
    // meanwhile every provider 5xx raised a process-level unhandled rejection and was filed
    // as crash telemetry. Awaiting the derived promise instead would be worse: it would make
    // the poller outlive the race it exists to serve.
    let poll: ReturnType<typeof setInterval> | undefined
    try {
      // Race the consumption against the deadline: a generator that never yields would
      // otherwise never observe the abort, which is exactly the hang this bounds.
      const work = req.cwd ? runWithCwdOverride(req.cwd, consume) : consume()
      if (timer) {
        await Promise.race([
          work,
          new Promise<void>(resolve => {
            poll = setInterval(() => { if (timedOut) resolve() }, 50)
          }),
        ])
      } else {
        await work
      }
    } finally {
      if (poll) clearInterval(poll)
      if (timer) clearTimeout(timer)
      req.signal.removeEventListener('abort', relay)
    }
    // Report the deadline rather than returning a truncated answer that the phase would
    // parse as a real (empty) reply.
    if (timedOut) throw new Error(`阶段调用超时(${deps.timeoutMs} ms),已中止`)
    return collectText(collected)
  }
}
