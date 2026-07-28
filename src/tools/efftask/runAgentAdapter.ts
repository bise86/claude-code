import { runAgent } from '../AgentTool/runAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { RunControl } from './control.js'
import { eventsFromMessage, type BriefResolver } from './agentEvents.js'
import type { RunAgentFn } from './roundtable.js'
import type { RoleBinding } from './types.js'

/**
 * caps.nodeTimeoutMs tripped (spec §11 的第四个阀).
 *
 * A CLASS, not a message match: the pipeline escalates a timeout differently from every other
 * phase failure (提高 nodeTimeoutMs / 拆小节点, rather than "read the reviewer's blockers"),
 * and this reason's text is user-facing Chinese prose that will be reworded.
 */
export type TimeoutKind = 'stall' | 'human'

/**
 * 用户点名取消了这一个节点。
 *
 * 和超时、provider 故障必须**分得开**:那两种是「出了问题」,要给补救建议、要计入
 * 返工预算;这一种是用户的决定,节点该干净地停下并保持可恢复(重做 / --resume)。
 * 合成一句「调用失败」的话,阻断卡会去劝用户提高超时——而他刚刚亲手按了取消。
 */
export class NodeCancelledError extends Error {
  constructor(
    public readonly nodeId: string,
    /**
     * 取消发生之前,子 agent **已经吐出来的**那部分文本。
     *
     * 必须带上:执行环节是带写工具的,取消的那一刻工作区里很可能已经有改动了,而
     * 执行者对这些改动的自述就在这段文本里。丢掉它 = 仓库变了而没有任何记录 ——
     * pipeline 那句「以上为中断时已报告的产出」本来就是给用户看这个的,只是它此前
     * 拿不到:runPhase 的 `text` 只在「调用成功之后才发现 abort」那条路上才有,
     * 而取消是**抛**出来的。
     */
    public readonly partialText = '',
  ) {
    super('该节点已被用户取消')
    this.name = 'NodeCancelledError'
  }
}

/**
 * 两个时钟的轮询周期。
 *
 * 用轮询而不是重排 setTimeout:deadline 会被「有进展」和「在等人」两件事不断推后,
 * 重排的边界条件比一个便宜的轮询更容易写错。
 *
 * 三个数各有各的理由,而且**都不是随便取的**:
 *  - `/20`:超时最多晚一个周期被发现,取预算的 5% 是可以接受的延迟;
 *  - 下限 50ms:再密就是纯烧 CPU,而超时本身是个稀有事件;
 *  - **上限 1000ms**:预算很大时(默认 600s → 30s)不能让发现延迟也跟着长到 30 秒。
 *
 * 抽出来是因为内联表达式**整个零覆盖**:改成 `Math.min(60000, …)` 后默认预算下轮询
 * 周期变成 30 秒,而全套测试用的都是几十毫秒的小预算 —— 那里三个数取值相同,看不出来。
 */
export function pollIntervalMs(limitMs: number | undefined): number {
  return Math.min(1000, Math.max(50, Math.floor((limitMs && limitMs > 0 ? limitMs : 1000) / 20)))
}

export class PhaseTimeoutError extends Error {
  constructor(
    public readonly limitMs: number,
    /**
     * 哪一种超时。**两者的处理方式相反**,所以不能合并:
     *  - stall:模型/工具一条消息都不吐了 → 提高 nodeTimeoutMs 或把节点拆小
     *  - human:没人来批工具权限 → 去终端或飞书上把那个确认点掉,和节点大小无关
     * 合成一句话的时候,一半的用户会被指去调一个和原因无关的旋钮。
     */
    public readonly kind: TimeoutKind = 'stall',
  ) {
    // 保留 `超时(N ms)` 这个形状:blockedReason 里的这串是用户和测试都在读的锚点,
    // 而 kind 的区别靠冒号后面那半句说清 —— 两者的处理方式相反,不能只留一句通用的。
    super(
      kind === 'human'
        ? `等待人工确认超时(${limitMs} ms):没有人回答工具权限确认,已中止`
        : `阶段调用超时(${limitMs} ms):静默超过该时长没有任何输出,已中止`,
    )
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

/**
 * 这一席**不从外面指定模型** —— 见派发处 `model` 那一段。
 *
 * 这个位置以前住着一个 `modelForRole()`,两版都是错的,记在这里免得再长回来:
 *
 * 第一版无条件传 `role.model`;第二版改成「员工解析到了才传」。用户实测两版都炸,
 * 报的是同一句:
 *   「There's an issue with the selected model (K3). It may not exist or you may not have
 *    access to it.」
 * 而重点/风险点/验收点全空 —— 关口上三行 ⚠,一次真正的分析都没发生。
 *
 * 真正的根因不在「传不传」,在**这个字段根本不是执行参数**:
 *
 * 1. `RoleBinding.model` 是 `annotateRoleModels()` 填的**显示值**,7 个读者里 6 个是
 *    渲染(关口名册、日志流的「(模型)」标注)。而 `effectiveModel()` 对 openai 员工
 *    **故意**返回 `roleClientConfig.backendModel`(比如 'K3')—— 那是给人看的后端名,
 *    不是引擎认得的别名。它的注释原话:「naming the Claude fallback here would be
 *    precisely backwards」。
 *
 * 2. runAgent 对 openai 员工**故意**传 `undefined`(runAgent.ts 的 `isOpenAIRole`):
 *    引擎要拿 mainLoopModel 做 Claude 模型的数学运算(token 预算、getRuntimeMainLoopModel),
 *    真正的后端模型由 buildRoleFetch 的 request-shim 在网线上换。
 *
 * 3. 而 `getAgentModel()` 第一句就是 `// Prioritize tool-specified model if provided`
 *    —— 外面传进来的 model **压倒**第 2 条那道保护。于是 'K3' 成了这个 subagent 的
 *    mainLoopModel,任何**不经过** buildRoleFetch 的调用就拿着它去问会话自己的
 *    provider,回 404,再被 errors.ts 统一翻译成上面那句「模型有问题」。
 *
 * 也就是说:一个为**显示**算出来的值被喂回**执行**,还正好优先于那道专门拦它的保护。
 *
 * 员工要跑在自己的模型和端点上,靠的是 agentDefinition 自己带的 `model` +
 * `roleClientConfig`,runAgent 已经按协议分好了支。从这里再传一次,只能盖错。
 */

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
  /**
   * 等**人**回答一次工具权限确认的预算。默认极大(见 DEFAULT_CAPS.humanTimeoutMs)。
   *
   * 和 timeoutMs 分开是实测出来的:canUseTool 就在阶段调用的窗口里被 await,
   * 合成一个预算时「用户去泡了杯咖啡」和「provider 挂死了」共用同一个 10 分钟。
   */
  humanTimeoutMs?: number | (() => number)
  /** 运行中的人工干预面。给了才有「取消单个节点」。 */
  control?: RunControl
  /**
   * 「有一次工具权限确认正在等人回答」的开关。
   *
   * 存在的理由是一个真实的按键冲突:`/et` 声明了 spawnsSubagents,于是权限对话框会画在
   * 任务树面板**之上**(processSlashCommand 的 shouldContinueAnimation)。两个组件同时
   * 挂着,而 useInput 是广播的 —— 用户按回车批准工具,**同一下回车也会打开光标所在
   * 节点的详情页**。用户报的就是这个。
   *
   * 引出来的是这一次 canUseTool 的边沿,由调用方自己去数并发数(见 efftask.tsx)。
   */
  onHumanWait?: (waiting: boolean) => void
  /**
   * 工具摘要解析器。适配层手上有 `availableTools`,每个 Tool 自带 `userFacingName(input)`,
   * 主 REPL 就是用它渲染每一行工具调用的。接上它,新工具进来自动有好摘要;缺席则落到
   * agentEvents 里那张静态表。
   */
  briefResolver?: BriefResolver
  runAgentImpl?: typeof runAgent // injectable for tests; defaults to the real runAgent
}): RunAgentFn {
  const run = deps.runAgentImpl ?? runAgent
  return async req => {
    // Already cancelled → don't start a sub-agent at all. Without this an abort racing the
    // next phase call still launches a real, tool-bearing agent (write-capable in the
    // execute phase). runRoundtable guards the same way for the same reason.
    // 这条早退路径**绕过下面的 finally**,所以它得自己收口:调用点已经把窗口开出来了,
    // 不收的话它会永远停在「运行中」,而且永远不进可淘汰集合。
    if (req.signal.aborted) { req.stream?.end('已中断'); return '' }
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
    /**
     * 把「等人」这段时间从 stall 时钟里摘出去。
     *
     * 包在这里而不是在调用方:canUseTool 从这里一路传进 runAgent 的工具循环,
     * 这是唯一一个既知道「阶段预算」又知道「哪一次 await 是在等人」的地方。
     */
    const canUseTool: CanUseToolFn = (async (...args: Parameters<CanUseToolFn>) => {
      humanWaitFrom = Date.now()
      // 通知**必须**用 try/catch 包住:一个抛异常的 UI 回调不能把这次工具调用带走,
      // 而它就在带写工具的执行环节的关键路径上。
      try { deps.onHumanWait?.(true) } catch { /* UI only */ }
      try {
        return await deps.canUseTool(...args)
      } finally {
        humanWaitFrom = undefined
        markProgress()
        // finally 里发,所以用户拒绝、超时中止、provider 抛错,面板都会拿回键盘。
        // 少了这一半,一次拒绝之后面板就永久不响应了 —— 比原来的 bug 更糟。
        try { deps.onHumanWait?.(false) } catch { /* UI only */ }
      }
    }) as CanUseToolFn
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
    /**
     * 两个时钟,不是一个。
     *
     * 原来是一个 setTimeout 罩住整次调用,于是量的是**总时长**,而且把**等人回答**
     * 也算了进去。两个后果都实测过:
     *
     *  - 一个正常干活、一直在流式输出的执行环节(读二十个文件、跑测试、改代码)
     *    十几分钟很正常,会被当成挂死杀掉 —— 而它一秒都没卡住;
     *  - 工具权限确认(canUseTool)就在这个窗口里 await。用户去倒杯水回来,节点已经
     *    以「阶段调用超时」阻断,而给的建议是「提高超时或把节点拆小」,两条都不对症。
     *
     * 现在:
     *  - stall 时钟量的是**静默时长** —— 每来一条消息就重置。只要还在吐东西就不算超时。
     *  - human 时钟只在**等人**的那段时间走,预算大得多(默认 7 天)。
     */
    let timedOut = false
    let timeoutKind: TimeoutKind = 'stall'
    /**
     * 登记这次调用,好让 control.cancelNode 中止它。
     *
     * 放在**这里**而不是调用方:inner 这个 controller 只在这一层存在,而它正是取消
     * 唯一能作用的东西。注销放在最外层 finally —— 留着的话,一个早就结束的 controller
     * 会一直挂在表里。
     */
    const unregister = deps.control?.registerCall(req.node.id, inner)
    const limitMs = typeof deps.timeoutMs === 'function' ? deps.timeoutMs() : deps.timeoutMs
    const humanLimitMs = typeof deps.humanTimeoutMs === 'function' ? deps.humanTimeoutMs() : deps.humanTimeoutMs
    let lastProgressAt = Date.now()
    /** 正在等人回答的那一刻;不在等人时是 undefined。 */
    let humanWaitFrom: number | undefined
    const markProgress = (): void => { lastProgressAt = Date.now() }
    const fire = (kind: TimeoutKind): void => { timedOut = true; timeoutKind = kind; inner.abort() }
    // 轮询而不是 setTimeout:deadline 会被「有进展」和「在等人」两件事不断推后,
    // 用 setTimeout 就得每次重排,而重排的边界条件比一个便宜的轮询更容易写错。
    const tickMs = pollIntervalMs(limitMs)
    const timer = (limitMs && limitMs > 0) || (humanLimitMs && humanLimitMs > 0)
      ? setInterval(() => {
          const now = Date.now()
          if (humanWaitFrom !== undefined) {
            // 在等人:只查人工预算,stall 时钟这段时间不走。
            if (humanLimitMs && humanLimitMs > 0 && now - humanWaitFrom >= humanLimitMs) fire('human')
            return
          }
          if (limitMs && limitMs > 0 && now - lastProgressAt >= limitMs) fire('stall')
        }, tickMs)
      : undefined

    /**
     * 这次调用是不是抛出去了。
     *
     * 没有它的话,`end()` 只在超时那一支传了理由,**抛出那一支传的是 undefined** ——
     * 于是 provider 抛 ECONNRESET / 529 之后,窗口表头是绿色的「● 已完成」。而这块屏
     * 正是用户打开去查「这一席为什么失败、节点为什么阻断」的地方。中断那一支反而是对的,
     * 所以同一个屏幕上两种失败长得不一样。
     */
    let failure: string | undefined
    const collected: Message[] = []
    /**
     * 每条消息拆成事件推给窗口。
     *
     * **try/catch 必须包住 `eventsFromMessage` 本身,不能只包 push。** 裹错层的代价不是
     * 「窗口空了」:异常会从 `for await` 逃出 → `consume()` reject → 下面的
     * `collectText(collected)` **永不执行**,模型已经答完的内容全丢 → 席位被判 infra →
     * roundtableWithInfraRetry 重试三桌(十几次真实模型调用)→ 节点 BLOCKED,而理由写的是
     * 「角色调用失败」,指向完全错误的方向。一个只负责画字符串的函数不该有这种权力。
     */
    const emit = (message: Message): void => {
      if (!req.stream) return
      try {
        for (const e of eventsFromMessage(message, deps.briefResolver)) req.stream.push(e)
      } catch {
        /* ignore */
      }
    }
    const invoke = (): AsyncGenerator<Message, void> =>
      run({
        agentDefinition,
        promptMessages,
        toolUseContext: deps.toolUseContext,
        canUseTool,
        isAsync: false,
        querySource: 'agent:custom',
        // model 是**故意不传**的 —— 传了会盖掉 runAgent 按协议分好的那套解析,
        // 而且 getAgentModel 让外部值优先于专门拦它的保护。上面那段长注释是全部原委。
        // 员工的模型和端点跟着 agentDefinition 走(pickAgentDefinition 已经选好了)。
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
        // 有输出 = 没卡住。stall 时钟从这里重置 —— 这就是「静默时长」和「总时长」的区别。
        markProgress()
        collected.push(message)
        // 每一条消息都要看,不只是 assistant —— 工具返回值走的是 user 消息,而它此前整条
        // 被跳过,所以「工具返回了什么、报没报错」在界面上一个字都没有。
        emit(message)
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
      const work = (req.cwd ? runWithCwdOverride(req.cwd, consume) : consume())
        .catch((e: unknown) => {
          failure = e instanceof Error ? e.message : String(e)
          throw e
        })
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
    } catch (e) {
      /**
       * 子 agent 在 abort 上**抛**出来时,下面那句 wasCancelled 走不到。
       *
       * 那一句写在 try/finally **之后**,而抛出路径直接跳过它:拿到的是子 agent 自己的
       * Error('aborted'),runPhase 的 cancelled 于是为 false,走通用阻断、
       * interrupted=false —— --resume 救不回来。本仓库主路径不抛(claude.ts 把
       * APIUserAbortError 吞掉后干净返回),所以触发面窄 —— 但那是别人的实现细节,
       * 不该是这条语义成立的前提。
       */
      if (deps.control?.wasCancelled(req.node.id) === true) {
        throw new NodeCancelledError(req.node.id, partialTextOf(collected))
      }
      throw e
    } finally {
      if (poll) clearInterval(poll)
      if (timer) clearInterval(timer)
      unregister?.()
      req.signal.removeEventListener('abort', relay)
      /**
       * 窗口的收口点。**只能在这里**,不能放在圆桌里。
       *
       * 这是唯一一个所有模型调用必经的地方:正常返回、抛出、超时、中断四条路径全覆盖。
       * 放在 runRoundtable 里的话,走 runPhase 的六处(分析圆桌、方案融合、方案精化、
       * 观察评分、冲突自动解决、执行)加根方案全都不会收口 —— 表头会永远停在「运行中」,
       * 一个两小时前就跑完的分析环节还在转圈;更要命的是这些流永远不进可淘汰集合,
       * 内存上限对超过三分之一的流直接失效。
       */
      req.stream?.end(
        // 取消排在最前:被取消时 failure 可能是 undefined(生成器干净返回),窗口就会
        // 收在绿色的「已完成」—— 而用户刚按了取消。这正是这段代码上方修过一次的那个病。
        deps.control?.wasCancelled(req.node.id) === true
          ? '已被用户取消'
          : timedOut
            ? (timeoutKind === 'human' ? '等待人工确认超时' : '静默超时(没有任何输出)')
            : failure,
      )
    }
    // Report the deadline rather than returning a truncated answer that the phase would
    // parse as a real (empty) reply.
    // 取消要排在超时**之前**判:被取消的调用同样是 abort,而它此刻可能恰好也超时了。
    // 判成超时的话,用户会拿到一句「提高 nodeTimeoutMs」——而他刚刚亲手按了取消。
    if (deps.control?.wasCancelled(req.node.id) === true) {
      throw new NodeCancelledError(req.node.id, partialTextOf(collected))
    }
    if (timedOut) {
      throw new PhaseTimeoutError(
        (timeoutKind === 'human' ? humanLimitMs : limitMs) ?? 0,
        timeoutKind,
      )
    }
    return collectText(collected)
  }
}

/**
 * 取消时把已收到的文本抠出来,**永不抛**。
 *
 * collectText 会读 `m.type`,而 collected 里可能有一条畸形消息(provider 给的、
 * 或者测试里的桩)。这一步的全部目的是「报告这次取消」,一条坏消息把它变成 TypeError
 * 的话,用户拿到的是一个和取消毫无关系的错 —— 实测踩到过。
 */
function partialTextOf(collected: readonly unknown[]): string {
  try {
    return collectText(collected as never)
  } catch {
    return ''
  }
}
