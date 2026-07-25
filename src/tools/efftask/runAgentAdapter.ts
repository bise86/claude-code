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
  runAgentImpl?: typeof runAgent // injectable for tests; defaults to the real runAgent
}): RunAgentFn {
  const run = deps.runAgentImpl ?? runAgent
  return async req => {
    // Already cancelled → don't start a sub-agent at all. Without this an abort racing the
    // next phase call still launches a real, tool-bearing agent (write-capable in the
    // execute phase). runRoundtable guards the same way for the same reason.
    if (req.signal.aborted) return ''
    const agentDefinition = pickAgentDefinition(req.role, deps.activeAgents, deps.mainModelDefault)
    // Per-phase tool gating: only the execute phase gets the write-capable tool pool.
    const tools: Tools = req.phase === 'execute' ? deps.availableTools : deps.readOnlyTools
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
        if (req.signal.aborted) break
      }
    }
    try {
      await (req.cwd ? runWithCwdOverride(req.cwd, consume) : consume())
    } finally {
      req.signal.removeEventListener('abort', relay)
    }
    return collectText(collected)
  }
}
