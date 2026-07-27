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

/**
 * caps.nodeTimeoutMs tripped (spec §11 的第四个阀).
 *
 * A CLASS, not a message match: the pipeline escalates a timeout differently from every other
 * phase failure (提高 nodeTimeoutMs / 拆小节点, rather than "read the reviewer's blockers"),
 * and this reason's text is user-facing Chinese prose that will be reworded.
 */
export class PhaseTimeoutError extends Error {
  constructor(public readonly limitMs: number) {
    super(`阶段调用超时(${limitMs} ms),已中止`)
    this.name = 'PhaseTimeoutError'
  }
}

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
  /**
   * 测试验证档:只读 + 能跑命令。
   *
   * 明确记下它挡不住什么:Bash 本身就能写(echo >、sed -i、git apply),所以这一档
   * 相对 execute 减掉的是**便利**,不是能力。真正证明「它没改代码」的是流水线在这一场
   * 前后比对 worktree 的 git status —— 工具清单只是第一道,不是那道。
   */
  verifyTools?: Tools
  activeAgents: AgentDefinition[]
  mainModelDefault: AgentDefinition
  /**
   * Wall-clock deadline for ONE phase call. Every other axis of this system is bounded —
   * depth, node count, three iteration counters, infra retries — but a provider that hangs
   * without ever rejecting has no bound at all: the pipeline parks in `await`, the tree
   * shows 运行中 forever, and even an abort cannot unstick it because nothing is polling.
   * 0 disables it.
   *
   * A FUNCTION is allowed because this seam is built in call(), before the run's config
   * exists: on resume the caps come back off run.md, which is hand-editable. Reading a fixed
   * DEFAULT_CAPS here would let the manifest declare one deadline while the run enforced
   * another — config saying one thing and behaviour doing another.
   */
  timeoutMs?: number | (() => number)
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
    // 三档:执行拿全部;测试验证拿只读 + 跑命令;其余只读。
    const tools: Tools =
      req.phase === 'execute' ? deps.availableTools
      : req.phase === 'verify' ? (deps.verifyTools ?? deps.readOnlyTools)
      : deps.readOnlyTools
    /**
     * 角色自带的 mcpServers **不再被剥掉**(此前非执行环节一律 `mcpServers: undefined`)。
     *
     * 改动理由是用户的明确要求:各环节的子 agent 都要能用工具和 MCP。此前评审员/验收员
     * 连**只读**的 MCP 都拿不到 —— 查不了文档、查不了数据库,只能凭 Read/Glob/Grep 猜,
     * 而关口对此一个字都没说。
     *
     * 被放弃的那条保护要写清楚:runAgent 在工具分档**之后**才把 `agentMcpTools` 合并
     * 回来(runAgent.ts 的 `uniqBy([...resolvedTools, ...agentMcpTools])`),所以一个声明了
     * 写能力 MCP 的角色被挂在评审席位上时,**能自己把问题改了再判通过** —— 执行者与
     * 评审者分离在这种配置下失效。
     *
     * 剩下的防线有三道,都不依赖这次剥离:
     *  1. 内建写工具(Edit/Write/NotebookEdit/Bash)仍然只有执行环节拿得到
     *     —— 见 WRITE_CAPABLE_TOOL_NAMES;
     *  2. canUseTool 仍然会对 MCP 调用询问,除非用户自己 allowlist 或开了 bypassPermissions;
     *  3. 测试验证环节有工作区前后比对(git status --porcelain 指纹),动了就判该轮作废。
     *
     * 关口会把「MCP 在所有环节可用、且挡不住会写的 MCP」说给用户听,让他自己决定给
     * 评审席位配什么角色。`disallowedTools` 不是替代方案:它只在 resolveAgentTools 内部
     * 生效,而那一步跑在 MCP 合并**之前**,filterToolsForAgent 对任何 `mcp__*` 都无条件返回 true。
     */
    const agentDefinition: AgentDefinition = picked
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
    const limitMs = typeof deps.timeoutMs === 'function' ? deps.timeoutMs() : deps.timeoutMs
    const timer = limitMs && limitMs > 0
      ? setTimeout(() => { timedOut = true; inner.abort() }, limitMs)
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
    if (timedOut) throw new PhaseTimeoutError(limitMs ?? 0)
    return collectText(collected)
  }
}
