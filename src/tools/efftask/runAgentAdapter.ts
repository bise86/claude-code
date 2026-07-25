import { runAgent } from '../AgentTool/runAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { createUserMessage } from '../../utils/messages.js'
import type { RunAgentFn } from './roundtable.js'

export function collectText(messages: Message[]): string {
  let out = ''
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    for (const block of (m.message.content as { type: string; text?: string }[])) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return out
}

export function pickAgentDefinition(
  role: { roleName: string } | null,
  activeAgents: AgentDefinition[],
  mainModelDefault: AgentDefinition,
): AgentDefinition {
  if (!role) return mainModelDefault
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
    const agentDefinition = pickAgentDefinition(req.role, deps.activeAgents, deps.mainModelDefault)
    // Per-phase tool gating: only the execute phase gets the write-capable tool pool.
    const tools: Tools = req.phase === 'execute' ? deps.availableTools : deps.readOnlyTools
    const promptMessages: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: `${req.system}\n\n${req.prompt}` }] }),
    ]
    const collected: Message[] = []
    for await (const message of run({
      agentDefinition,
      promptMessages,
      toolUseContext: deps.toolUseContext,
      canUseTool: deps.canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      // NOT validated: an unrecognized alias simply falls through to runAgent's own model
      // resolution (which applies its default). We do not pre-check the string here.
      model: (req.role?.model as ModelAlias | undefined) ?? undefined,
      availableTools: tools,
      // runAgent has NO `cwd` param — the real field is `worktreePath`. P1 always passes
      // undefined (shared cwd); mapping it keeps the seam honest for P2's worktrees.
      worktreePath: req.cwd,
    })) {
      collected.push(message)
      if (req.onChunk && message.type === 'assistant') req.onChunk(collectText([message]))
      if (req.signal.aborted) break
    }
    return collectText(collected)
  }
}
