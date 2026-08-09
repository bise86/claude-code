import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { access, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Tools } from '../../Tool.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { collectCaps, collectRoleDefs, collectSkipSteps, mergeSkipSteps } from '../../tools/efftask/roleDefsFromSettings.js'
import { collectRoleLoadIssues } from '../../tools/AgentTool/loadAgentsDir.js'
import type { RoleDef } from '../../tools/efftask/roleDefs.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { createRateLimitGate } from '../../tools/efftask/rateLimitGate.js'
import { searchUnavailableReason } from '../../utils/ripgrep.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import { runOrchestrator, type Outcome, type Phase } from './runOrchestrator.js'
import type { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { createWorktreePool, type GitRunner, type WorktreePool } from '../../tools/efftask/worktreePool.js'
import { spawn } from 'node:child_process'
import { annotateRoleModels, effectiveModel, type AgentModelInfo } from '../../tools/efftask/roleModels.js'
import { loadRun, writeNode as writeNodeFile, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import { failedRedoTarget, forcePassFailedPhaseReason, redoContextOf, redoUnavailableReason, skipFailedPhaseReason, type RedoEntry, type RedoPlan } from '../../tools/efftask/redo.js'
import { commitRedo } from '../../tools/efftask/redoCommit.js'
import { runForcePass, runRedo, runSkip } from '../../tools/efftask/redoRun.js'
import { liveRedoUnavailableReason } from '../../tools/efftask/liveRedo.js'
import { ConfirmHandoff } from './ConfirmHandoff.js'
import { runHandoffChoice, type HandoffChoice, type HandoffResult } from '../../tools/efftask/handoffActions.js'
import { makeHandoffConflictResolver } from '../../tools/efftask/handoffResolve.js'
import type { PendingHandoff } from '../../tools/efftask/types.js'
import { parseResumeArgs, type ResumeArgs } from '../../tools/efftask/parseResumeArgs.js'
import { readRunManifest, validateLoadedNodes } from '../../tools/efftask/resumeCore.js'
import { reseatTransientNodes } from '../../tools/efftask/reseat.js'
import { acquireRunLock, listRuns, releaseRunLock, reserveRun, type RunSummary } from '../../tools/efftask/runRegistry.js'
import { createRunControl, type RunControl } from '../../tools/efftask/control.js'
import { adjustStrictness } from '../../tools/efftask/strictness.js'
import { AddDirective } from './AddDirective.js'
import { ConfirmRedo } from './ConfirmRedo.js'
import { ConfirmSkip } from './ConfirmSkip.js'
import { ConfirmForcePass } from './ConfirmForcePass.js'
import { ConfirmCleanup } from './ConfirmCleanup.js'
import { ConfirmRecalcDeps } from './ConfirmRecalcDeps.js'
import { recalcScope, type RecalcPlan } from '../../tools/efftask/depsRecalc.js'
import { applyRecalc, askRecalc, type RecalcApply, type RecalcAsk } from '../../tools/efftask/depsRecalcRun.js'
import { runCleanup, scanCleanup, type CleanupDeps } from '../../tools/efftask/cleanupWorktrees.js'
import { ConfirmResume } from './ConfirmResume.js'
import { ResumePicker } from './ResumePicker.js'
import { createNode, emptyPhaseRoles, emptyPlan, DEFAULT_CAPS, MAX_RECORDED_REPAIRS } from '../../tools/efftask/types.js'
import type { Caps, EffTaskConfig, PhaseName, TaskNode } from '../../tools/efftask/types.js'
import { applyRootDraft, buildRootPlanNoticeCard, draftRootPlan, makeRootNode, type RootDraft } from '../../tools/efftask/rootPlan.js'
import { ConfirmRootPlan, type RootPlanDecision } from './ConfirmRootPlan.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import {
  raceConfirm,
  type ConfirmSurface,
  type ConfirmWinner,
  type StartupDecision,
  type ResumeSummary,
  handoffLines,
  exitReportLine,
  runSpanLine,
  applyStartupDecision,
  applyRosterToNodes,
  rosterEquals,
  dispatchableRoles,
  type HandoffSummary,
  type HandoffState,
} from '../../tools/efftask/startupConfirm.js'
import { buildStartupCard, sendFeishuStartupCard } from '../../tools/efftask/feishuStartupCard.js'
import { buildConflictCard } from '../../tools/efftask/conflictEscalation.js'
import { buildBlockCard, createEscalationLimiter } from '../../tools/efftask/escalation.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { useHumanWaitCount } from './useLiveState.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { countStatuses } from '../../tools/efftask/stateMachine.js'
import { createStreamStore, PRE_TREE_NODE, type StreamHandle, type StreamState, type StreamStore } from '../../tools/efftask/agentStream.js'
import { AgentLogPane, useStreamTick } from './AgentLogPane.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { logError } from '../../utils/log.js'


/**
 * 这套工具池经历过三代,值得在这里留一句,免得有人第三次走回第一代:
 *
 *  1. 白名单 `{Read, Glob, Grep}` —— **所有 `mcp__*` 连带被滤掉**。用户配了查文档/
 *     查数据库的 MCP server,以为评审员能用,实际只有执行者能用,而关口上看不出任何
 *     迹象;起草者也只能靠这三个工具摸黑,复杂仓库里经常直接回「访问不了文件系统,
 *     请你贴代码」。
 *  2. 黑名单分三档(执行 / 测试验证 / 其余)—— MCP 回来了,写工具按环节给。
 *  3. 现在:**不分档**,七个环节共用一个黑名单池子。见 subAgentToolPool。
 *
 * 判据从「这个环节该不该写」变成了「这个工具在子 agent 里能不能用」,而后者只有
 * 一个答案是否定的(Skill)。
 */
/**
 * 靠**主循环注入的上下文**才能用的工具 —— 子 agent 一律拿不到。
 *
 * 现在只有 Skill 一个,而它是用户报出来的:
 *
 *   Skill(Skill)  ⎿ <tool_use_error>Unknown skill: bash</tool_use_error>
 *
 * 根因是这个池子是**黑名单**(「会话里的一切,减去会改盘的」),而 SkillTool 在
 * tools.ts 里是无条件注册的,于是它进了子 agent 的工具表 —— 但技能清单是主循环消息
 * 管线里的 attachment(attachments.ts 的 formatCommandsWithinBudget),而 efftask 的
 * 子 agent 消息是自己拼的,那份清单永远到不了。
 *
 * 于是模型看到一个工具,它的说明写着「只用清单里的名字,不要猜」,而清单不存在。
 * 它就猜了一个 'bash'。每猜一次白烧一轮调用,而且这类无效调用会被验收/评审读成
 * 「这个节点在瞎折腾」。
 *
 * 黑名单意味着**以后新增的这类工具会重复这个坑**。加在这里的判据是:
 * 「它需要的东西是主循环塞进消息里的吗?」如果是,子 agent 用不了它。
 */
export const CONTEXT_DEPENDENT_TOOL_NAMES = new Set([SKILL_TOOL_NAME])

/**
 * 完成视图里那个总结框占几行。**数出来,不是估**,而且**数得对不对要能被单独钉住**。
 *
 * 面板(以及它里面的详情页)按可用高度排版,而这个框画在面板**下面**、高度随内容变 ——
 * 组件自己看不见它,只有调用方知道。少算一行,详情页最底下那条页签条就会被顶出屏幕。
 *
 * 提成纯函数是验收逼出来的:这个数原来内联在 JSX 里,而**把整个特性关掉
 * (`reservedRows={0}`)、或者把常数 4 改成 1,全套 2150 条测试一条都不红** ——
 * 已有的两条测试量的是消费者(TaskTreePanel 收到 reservedRows 之后有没有让位),
 * 喂的是写死的数字,生产者一个字都没测。而这个数正是这段注释吹嘘「数出来」的那件事。
 *
 * 常数 4 = 上下边框 2 + 标题行 1 + 底部按键提示行 1。
 */
export function doneSummaryRows(a: {
  viewOnly: boolean
  hasReason: boolean
  hasHandoffResult: boolean
  followUps: number
  handoffLines: number
  redoProblems: number
  /** 「起 … 止 … 共 …」那一行(runSpanLine)。空串时不画,也就不占行。 */
  hasRunSpan?: boolean
}): number {
  return (
    4 +
    (a.hasRunSpan === true ? 1 : 0) +
    (a.viewOnly ? 1 : 0) +
    // 仅查看时不显示 reason —— 那会把用户自己按的一下退出报成一次失败。
    (!a.viewOnly && a.hasReason ? 1 : 0) +
    (a.hasHandoffResult ? 1 : 0) +
    a.followUps +
    a.handoffLines +
    a.redoProblems
  )
}

/**
 * 工具摘要解析器 —— 从工具表里找 `userFacingName` 并**带着输入**调它。
 *
 * 提成可导出的纯函数,和三个工具池同一个理由:验收实测,这一跳的测试**把它手抄了**
 * 一遍(测试文件里自己写了一份「逐字同构」的 resolver),于是把真的那份改成
 * `return undefined`、或者把 `input` 参数丢掉,全套 2150 条测试**一条都不红** ——
 * 而那两种改法产出的正是用户报过的形状:窗口里只剩光秃秃的 `mcp__gitlab__list_issues`,
 * 或者 `Read` 后面没有文件名。
 *
 * `input` 必须传下去:多数工具的 `userFacingName` 不看输入(FileReadTool 永远返回
 * `Read`),真正把参数补出来的是 agentEvents 那张静态表;但**看输入的那些**(读方案
 * 文件时显示「Reading Plan」)靠的就是这个参数。
 */
export function briefResolverFor(
  tools: readonly { name: string }[],
): (name: string, input: unknown) => string | undefined {
  return (name, input) => {
    const t = tools.find(x => x.name === name) as
      | { userFacingName?: (i: unknown) => string } | undefined
    try { return t?.userFacingName?.(input) } catch { return undefined }
  }
}

/**
 * 子 agent 的工具池。**七个环节共用这一个** —— 不再按环节分档。
 *
 * 曾经有三档(执行拿全部、测试验证只读+跑命令、其余纯只读),用户明确要求取消:各环节
 * 一律继承会话里的全部工具和全部 MCP。**代价要写在这里,不能只写在提交信息里**:
 * 评审员/验收员现在拿得到 Edit/Write/Bash,于是「执行者与评审者分离」不再由工具清单
 * 保证 —— 一个评审角色可以自己把问题改掉再判通过。
 *
 * 剩下的防线是**行为**而不是能力,两道都还在:
 *  1. 测试验证环节前后比对 worktree 的 `git status` 指纹(pipeline.ts 的 verifySnapshot),
 *     动了就判该轮作废并返工。它本来就不依赖工具清单 —— Bash 早就能写(echo >、sed -i、
 *     git apply),那道闸门存在的理由正是「工具清单挡不住这件事」;
 *  2. canUseTool 仍然逐次询问,除非用户自己 allowlist 或开了 bypassPermissions。
 *
 * 唯一还被摘掉的是 CONTEXT_DEPENDENT_TOOL_NAMES(目前只有 Skill),而那**不是限制能力**:
 * Skill 要主循环把技能清单塞进消息里才有意义,子 agent 拿到的是一个必然失败的工具。
 */
export function subAgentToolPool<T extends { name: string }>(all: T[]): T[] {
  return all.filter(t => !CONTEXT_DEPENDENT_TOOL_NAMES.has(t.name))
}

const CANCELLED: StartupDecision = { parallelism: 0, approved: false }

// Shown at the third gate ONLY when drafting failed, always next to the error that explains
// it. Never seeded into the run — see onRootDecision.
const EMPTY_DRAFT: RootDraft = { kind: 'unknown', plan: emptyPlan(), children: [] }

// 集成接线,无单测;手动跑 /et 验证。
// 构造顺序:fs → runId → runAgent 接缝 → 立刻返回 JSX(解析在组件内 parsing 态跑)。
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  /**
   * headless(`claude -p`)是 spec §12 明列的 Non-Goal —— 但它此前被实现成一个**带磁盘
   * 副作用的静默 no-op**,而不是一次拒绝。
   *
   * processSlashCommand 只在 `await mod.call(...)` **之后**才检查 isNonInteractiveSession
   * (:610 vs :614),然后把返回的 JSX 整个丢掉、resolve 成 `messages: []`。等它检查时,
   * 这个函数已经跑完了:allocateRunId 用 mkdirExclusive 在用户仓库里**真的建了一个编号
   * 目录**(那正是它保留 id 的手段),并往父 abortController 上挂了一个监听器 —— 而两者
   * 的清理都挂在 onExit 上,组件根本没有挂载过。用户一个字的输出都看不到。
   *
   * 于是每跑一次 `claude -p "/et …"` 就泄漏一个空 run 目录,并把下一次真实 run 的编号往
   * 后顶。Non-Goal 实现成"悄悄产生副作用",比明确报错糟得多。
   */
  if (context.options.isNonInteractiveSession) {
    onDone(
      '高效任务模式是 TUI-only:确认关口、任务树面板和子 agent 实时输出都需要交互式终端,' +
      'headless(claude -p / --print)下无法呈现,因此不启动,也不会创建 run 目录。\n' +
      '请在交互式会话里运行 /et。',
      { display: 'system' },
    )
    return null
  }
  // Empty prompt: there is nothing to plan. The hint must travel through onDone — JSX
  // painted for a single frame before exiting never reaches the transcript, so the user
  // would be left with a bare '已取消' and no idea what the command wanted.
  if (!args.trim()) {
    onDone(
      '用法: /et <任务提示词>\n' +
      '  续跑: /et --resume [运行ID|latest] [续跑指引]\n' +
      '  续跑并重开被安全阀停下的节点: /et --resume <运行ID> --retry-blocked',
      { display: 'system' },
    )
    return null
  }
  // getCwd(), NOT process.cwd(): a Bash-tool `cd` updates the session cwd WITHOUT calling
  // process.chdir, so process.cwd() would drop the run tree somewhere the user isn't while
  // every sub-agent's Read/Edit/Bash resolves against the session cwd.
  const cwd = getCwd()
  const fs = fsAdapter()
  const effRoot = `${cwd}/.claude/efftask`
  const resumeArgs = parseResumeArgs(args)
  // The run identity. MUTABLE because on the `--resume` path with no id the run is not known
  // until the user picks one, and onExit — constructed here, below — has to release the lock
  // and skip the reservation cleanup for whatever run actually ran.
  const active: { runId: string | null; runDir: string | null; resumed: boolean } = {
    runId: null, runDir: null, resumed: resumeArgs.mode === 'resume',
  }
  // The phase deadline must follow the RUN's caps, not a frozen default: on resume they come
  // back off run.md, which is hand-editable. The seam below is built before any config
  // exists, so it reads this holder at call time instead of capturing a number now.
  // 两个预算,不是一个:nodeTimeoutMs 量「静默多久」,humanTimeoutMs 量「等人多久」。
  // 合成一个的话,「用户去倒杯水」和「provider 挂死了」共用同一个 10 分钟。
  const capsRef: { nodeTimeoutMs: number; humanTimeoutMs: number } = {
    nodeTimeoutMs: DEFAULT_CAPS.nodeTimeoutMs,
    humanTimeoutMs: DEFAULT_CAPS.humanTimeoutMs,
  }

  if (resumeArgs.mode === 'new') {
    // Local fs scan only — no model call, no tokens, sub-millisecond. Everything that COSTS
    // something (parseDirectives) happens inside the component.
    // It can still fail (an unreadable .claude dir), and allocateRunId deliberately rethrows
    // rather than hand out an id that would overwrite a previous run. Rejecting out of call()
    // makes processSlashCommand resolve with no messages at all — the user types /et and
    // NOTHING appears — so the failure has to be reported here.
    // It stays EAGER: creating the directory here is what reserves the id, and deferring it
    // into the component would let two concurrent /et runs share a directory.
    try {
      // The LOCK comes with the id, not only on the --resume path. A new run used to hold
      // nothing, so a second terminal running `/et --resume <thisRun>` found the lock free,
      // took it, and started a SECOND orchestrator over the same directory — both writing
      // node.md for the same ids, each silently overwriting the other, both reporting
      // success. See reserveRun.
      const reserved = await reserveRun(fs, effRoot, process.pid, new Date().toISOString(), isPidAlive)
      active.runId = reserved.runId
      active.runDir = reserved.runDir
    } catch (e) {
      onDone(`高效任务无法启动: ${e instanceof Error ? e.message : String(e)}`, { display: 'system' })
      return null
    }
  }

  // The command owns its own AbortController so the running view's Esc can stop the run;
  // it chains off the parent signal so a REPL-level abort still tears everything down.
  const runController = new AbortController()
  const relayAbort = (): void => runController.abort()
  if (context.abortController.signal.aborted) runController.abort()
  else context.abortController.signal.addEventListener('abort', relayAbort, { once: true })
  const signal = runController.signal
  // The parent controller outlives this command, so a listener left behind accumulates one
  // dead entry per /et invocation for the whole session.
  const detachAbortRelay = (): void => context.abortController.signal.removeEventListener('abort', relayAbort)

  const activeAgents: AgentDefinition[] = context.options.agentDefinitions?.activeAgents ?? []
  const allAgents: AgentDefinition[] = context.options.agentDefinitions?.allAgents ?? activeAgents
  // processSlashCommand passes canUseTool straight through for local-jsx commands
  // (processSlashCommand.tsx:609) with NO fallback of its own, and it really can be
  // undefined (QueryEngine builds contexts without one). So we supply the same fallback the
  // fork path uses at processSlashCommand.tsx:728.
  /**
   * 人工干预面。**必须在这里建**,不能在组件里:runAgent 也是在这里构造的,而取消要
   * 靠它们共用同一个实例才生效。组件重挂时换一个新的,已经登记的在飞调用就永远取消不掉。
   */
  const control = createRunControl()
  /**
   * 上游限流闸门。**和 control 同处建、同一个理由**:两个 makeRunAgentFn 实例
   * (runAgent 和一次性的 extractAgent)必须共用同一个,否则「上游在限流」这条状态在
   * 它们之间不共享;而建在组件里的话,同一次会话按 r 重做会把退避级数清零。
   */
  const rateGate = createRateLimitGate()
  const canUseTool = context.canUseTool ?? hasPermissionsToUseTool
  const mainModelDefault = pickMainAgentDefinition(allAgents)
  /**
   * 七个环节共用的池子:会话里的一切(含全部 `mcp__*`),只减掉 Skill。
   *
   * 曾经在这里分三档,现在只有一个 —— 见 subAgentToolPool 上面那段关于代价的说明。
   * 仍然走池子函数而不是裸的 `context.options.tools`,是因为 Skill 必须摘掉。
   */
  const subAgentTools: Tools = subAgentToolPool(context.options.tools)
  const runAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    // 等人批准工具时让任务树面板交出键盘。`/et` 声明了 spawnsSubagents,所以权限对话框
    // 画在面板**之上**,两个组件同时挂着 —— 而 useInput 是广播的:用户按回车批准工具,
    // 同一下回车也会打开光标所在节点的详情页。
    onHumanWait: w => { humanWaitOut.current?.(w) },
    control,
    // 七个环节共用同一份。分档取消之后这里只剩一个入口 —— 少一个入口就少一处能悄悄
    // 退化成「某个环节工具变少了」的地方。
    availableTools: subAgentTools,
    activeAgents,
    mainModelDefault,
    // caps.nodeTimeoutMs was declared and never enforced; wall clock was the one unbounded
    // axis left. The extraction seam below gets it too.
    timeoutMs: () => capsRef.nodeTimeoutMs,
    humanTimeoutMs: () => capsRef.humanTimeoutMs,
    // 工具摘要用工具自己的 userFacingName —— 主 REPL 每一行工具调用就是这么渲染的。
    // 接上它,以后新增的工具自动有好摘要,不用回来改那张静态表。
    briefResolver: briefResolverFor(context.options.tools),
    rateGate,
  })
  /**
   * 依赖重算那一次调用的**专用缝**。和上面两条分开,因为它要改三样:
   *
   *  - **超时 120s**:默认 nodeTimeoutMs 是 600s 静默 × TOTAL_LIMIT_FACTOR = 最长一小时,
   *    对一次零工具、只挑 id 的调用是纯粹浪费用户的时间;
   *  - **零工具**:它只把一份清单改写成一组 id,读写工具都不需要 —— 而带写工具的席位
   *    在一个「用户按了个键」的路径上是不该出现的;
   *  - 不传 control:取消这一次调用走**每次调用自己的 AbortController**,绝不走
   *    control.cancelNode —— 那会给节点置上永久取消标记,而重算的准入从此拒绝它、
   *    pickBatch 也永远不选它(在关口上按一次 Esc = 把这个任务从整趟 run 里除名)。
   */
  const recalcAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    availableTools: [],
    activeAgents,
    mainModelDefault,
    timeoutMs: () => 120_000,
    humanTimeoutMs: () => capsRef.humanTimeoutMs,
    rateGate,
  })
  // Separate NO-TOOLS seam for the one-shot config extraction: it only rewrites text into
  // JSON, so it needs neither read nor write tools. This is the ONLY place that passes [].
  const extractAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    availableTools: [],
    activeAgents,
    mainModelDefault,
    timeoutMs: () => capsRef.nodeTimeoutMs,
    humanTimeoutMs: () => capsRef.humanTimeoutMs,
    rateGate,
  })

  /**
   * 载入员工时**没按你写的那样生效**的那些事,搬到关口上。
   *
   * 此前它们只走 `console.error`,而实测 ink 的 `patchConsole` 把 warn/error/trace 全部
   * 改写成 `logError` —— 只进 debug 日志文件,交互式会话的屏幕上一个字都不会出现。
   * 后果:`apiProtocol` 少写一个 s、`thinkingDepth` 写成 JSON 数字,整条员工被跳过,
   * 而用户只看到「这个员工不存在」,分不清是自己打错字还是这个功能没做。
   *
   * 落点选 notices 是因为那一块的标题恰好就是「你的请求中有以下部分不会生效」——
   * 语义严丝合缝,而且它跟着 run.md 落盘,`--resume` 之后还在。
   */
  const roleLoadNotices = (): string[] =>
    collectRoleLoadIssues().map(i => `员工「${i.name}」(来自 ${i.source}): ${i.reason}`)

  const knownRoles = activeAgents.map(a => a.agentType)
  // execMode:'cli' roles are dispatched by AgentTool, not runAgent — this seam cannot run
  // them, so they must be reported at the gate rather than silently downgraded to the main
  // model while the roster still shows the role's name.
  const unsupportedRoles = activeAgents.filter(a => 'execMode' in a && (a as { execMode?: string }).execMode === 'cli').map(a => a.agentType)
  // settings.json 里配好的角色定义。读在这里而不是 parseDirectives 里面,是因为那个文件
  // 是纯函数、不碰全局状态,整套解析/合并/展平才能不搭环境地测。
  //
  // `.notices` 和 `.defs` 一起接住:此前只取 `.defs`,于是配置文件那条录入口的**全部**
  // 诊断信息无人接收 —— 员工名打错一个字,关口显示「架构师←主模型」,看起来像「我配的
  // 就是主模型兼任」,而解释这件事的那句话被丢了。同样的错写在提示词里则会正常显示,
  // 两条录入口不对称。连整份 settings.json 读不出来(EACCES)都是静默的。
  const collectedRoles = collectRoleDefs({
    knownStaff: new Set(knownRoles),
    unsupportedStaff: new Set(unsupportedRoles),
  })
  // 同一层的另一半:efftaskRoles 说「这个环节谁来干」,efftaskSkipSteps 说「这个环节干不干」。
  // 这个调用点缺了整整一版 —— 函数写好了、六条测试全绿、README 和 roles-setup 都把它写成
  // 两条录入口之一,而它在生产上一次都没被读过。测试全绿是因为它们直接调函数,没有任何
  // 东西检查函数**被接上了**。
  const collectedSkip = collectSkipSteps()
  /**
   * 安全阀的第三条录入口:配置文件。「我根据项目来设置」的那条 —— 见 collectCaps。
   *
   * 接线点必须在**这里**,和上面那两条并排:collectSkipSteps 曾经缺过整整一版接线
   * (函数写好了、六条测试全绿、两份文档都写着它,而生产上一次都没被读过)。
   */
  const collectedCaps = collectCaps()
  // Set when the view is torn down rather than exited, so the report can tell the two apart.
  let tornDown = false
  // The handoff, in call()'s OWN scope. onExit runs here, and it used to read `handoffRef` —
  // which is declared inside the component, not here — so every exit with a run id threw
  // ReferenceError from inside a .then(), onDone was never called, and processSlashCommand's
  // promise stayed pending forever.
  const handoffOut: { current: HandoffSummary | null } = { current: null }
  /**
   * 收口结局,给**退出报告**用(它进对话记录,比 done 视图活得久)。
   *
   * 和 handoffOut 同一套理由:onExit 跑在 call() 的作用域里,读不到组件的 state。
   * 不带上它的话,自动合并成功之后留在对话记录里的仍然是「你的工作区未被改动」
   * 和「稍后收口: /et --resume … 会重新弹出四选一」—— 而两句都已经不成立。
   */
  const handoffStateOut: { current: HandoffState | undefined } = { current: undefined }
  // Same shape, same reason: onExit runs in THIS scope and must be able to report how many
  // escalation cards were dropped.
  const cardLimitOut: { current: number } = { current: 0 }
  /**
   * 组件挂载后填进来的「有人在等确认」通知口。
   *
   * 必须是 ref 而不是闭包:runAgent 在 `call()` 里就构造好了(它要交给 orchestrator),
   * 而接收方 `useHumanWaitCount` 只在组件里才存在。和 handoffOut 同一套理由。
   */
  const humanWaitOut: { current: ((waiting: boolean) => void) | null } = { current: null }
  /**
   * 组件挂载后填进来的「有人在等确认」通知口。
   *
   * 必须是 ref 而不是闭包:runAgent 在 `call()` 里就构造好了(它要交给 orchestrator),
   * 而接收方 `useHumanWaitCount` 只在组件里才存在。和 handoffOut 同一套理由。
   */
  return (
    <EffTaskRunner
      args={args}
      knownRoles={knownRoles}
      unsupportedRoles={unsupportedRoles}
      // settings.json 里配好的角色定义。读在这里而不是 parseDirectives 里面,是因为那个
      // 文件是纯函数、不碰全局状态,整套解析/合并/展平才能不搭环境地测。
      baseRoleDefs={collectedRoles.defs}
      baseRoleNotices={[...roleLoadNotices(), ...collectedRoles.notices, ...collectedSkip.notices, ...collectedCaps.notices]}
      baseSkipSteps={collectedSkip.steps}
      baseCaps={collectedCaps.caps}
      mcpToolNames={context.options.tools.filter(t => t.name.startsWith('mcp__')).map(t => t.name)}
      // 服务器状态和工具名是**两件事**:待审批的服务器不连接,于是它一个工具都不贡献,
      // 只看工具名的话「配了但没连上」和「根本没配」长得一模一样 —— 而前者用户报过。
      // `?? []` 不是防御性冗余:这一行画在启动关口上,而关口是 /et 的第一屏。类型上
      // mcpClients 是必填,但非交互/SDK 那几条路造的 context 未必填全 —— 在这里抛异常
      // 等于「输入 /et 只得到一屏堆栈,一次模型调用都没有」。
      mcpServers={(context.options.mcpClients ?? []).map(c => ({ name: c.name, type: c.type }))}
      // The roster must say which model each seat runs on, and that answer lives in the
      // agent definitions + the session model — neither of which parseDirectives can see.
      agentModels={activeAgents}
      mainModel={context.options.mainLoopModel}
      extractJson={(prompt, stream) => extractAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal, stream })}
      /**
       * 依赖重算那一次调用。`node` 传**真节点**(用量记在它身上 —— run 总用量和详情页
       * 都只按 nodes 累加,传 stub 会让这次用户手动买单的调用从两处同时蒸发);
       * `signal` 由调用方按次给(不是 run 级的那个)。
       * `phase:'plan'` 只是形参 —— 适配层不读它;这**不是**一个环节调用,所以
       * system 传空、也不挂 seatPreamble(那里面是分析环节的定向注入和严格度)。
       */
      runRecalcAgent={(a) => recalcAgent({ phase: 'plan', node: a.node, role: null, system: '', prompt: a.prompt, signal: a.signal, stream: a.stream })}
      resumeArgs={resumeArgs}
      effRoot={effRoot}
      active={active}
      capsRef={capsRef}
      fs={fs}
      runAgent={runAgent}
      signal={signal}
      // The controller ITSELF, not just an abort thunk: the /tasks entry (spec §10) has to
      // stop the real run when the user presses `x`, and a private controller there would
      // flip the panel to 已中断 while the orchestrator kept issuing write-capable calls.
      controller={runController}
      abort={() => runController.abort()}
      detach={detachAbortRelay}
      // The REPL moves this JSX between four mutually-exclusive tree positions, so Ctrl+O
      // (toggle transcript) or Ctrl+Z→fg unmounts and remounts it. That stops the run —
      // which is right, an orphaned orchestrator would keep burning tokens into a tree
      // nobody is watching — but the user never asked to stop, so the message must not
      // claim they cancelled. It points at the run dir, which is exactly what resume reads.
      onTornDown={() => { tornDown = true }}
      handoffOut={handoffOut}
      handoffStateOut={handoffStateOut}
      cardLimitOut={cardLimitOut}
      humanWaitOut={humanWaitOut}
      control={control}
      // The transcript is the only durable trace once the panel is gone: say how the run
      // ended and where its artifacts live, not just that it ended.
      // Latched: the done view's key handler fires per keypress, and the immediate-command
      // call sites re-append transcript messages on a second onDone.
      onExit={onceOnly(outcome => {
        detachAbortRelay()
        const how = outcome
          ? outcome.status === 'completed' ? '完成' : `被阻断(${outcome.reason ?? '未知原因'})`
          : tornDown ? '因界面重建而中断' : '已取消'
        const { runId, runDir, resumed } = active
        // How many escalations were never sent. Suppression is announced on the LAST card
        // that gets through, but that card cannot know the final number — this line can, and
        // the transcript is where a user looks after the panel is gone.
        const dropped = cardLimitOut.current
        // Never picked a run (cancelled at the picker, or resume failed before it resolved).
        if (!runId || !runDir) {
          onDone(`高效任务 ${how}`, { display: 'system' })
          return
        }
        const report = (withPath: boolean): void => {
          const suppressed = dropped > 0
            ? `\n(另有 ${dropped} 条升级通知因数量上限未发送;被阻断的节点见 run.md 的任务树,未阻断的见对应节点的 node.md)`
            : ''
          onDone(
            exitReportLine({
              runId, how, resumed, withPath,
              handoff: handoffOut.current, handoffState: handoffStateOut.current,
            }) + suppressed,
            { display: 'system' },
          )
        }
        // Always release the lock, on every exit path — a lock left behind refuses every
        // later resume of this run until it ages out.
        void releaseRunLock(fs, runDir)
          .catch(() => {})
          .then(() => {
            // A RESUMED run's directory is never an unused reservation; skip the cleanup
            // rather than rely on rmdir failing. Only a fresh run can leave an empty one.
            if (resumed) { report(true); return }
            // allocateRunId RESERVES the id by creating the directory, so a gate cancelled
            // before the run wrote anything leaves an empty dir behind — and the pointer
            // would aim at a run.md that was never written. Release the reservation instead.
            // NON-recursive rmdir on purpose: it fails on a directory with content, so this
            // path is structurally incapable of deleting a run that produced anything.
            return rmdir(runDir).then(() => report(false), () => report(true))
          })
      })}
    />
  )
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Liveness probe for the lock. signal 0 checks existence without touching the process. */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) {
    // EPERM means the process EXISTS but belongs to another user — very much alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Run `fn` at most once — the exit key fires per keypress, onDone must not. */
function onceOnly<T>(fn: (arg: T) => void): (arg: T) => void {
  let done = false
  return arg => { if (done) return; done = true; fn(arg) }
}

// 一次性配置抽取用的占位节点(不入树,只是给 RunAgentFn 一个合法 node 形参)。
function stubNode(): TaskNode {
  return createNode({
    id: '__extract__',
    title: 'extract',
    parentId: null,
    deps: [],
    depth: 0,
    phaseRoles: emptyPhaseRoles(),
    now: new Date().toISOString(),
  })
}

// Reuse a REAL built-in AgentDefinition as the P1 main-model default so system prompt /
// source / baseDir are all valid (NO escape cast).
// WHY the fallback is picky instead of `allAgents[0]`: the roster also contains agents that
// came from settings roles, and one of those can be a cli / other-provider agent (e.g. one
// carrying `execMode`). Grabbing an arbitrary entry would silently route every un-roled
// phase — plan, review, accept — through someone else's provider. So: prefer
// general-purpose; else the first BUILT-IN, non-exec-mode agent; else a minimal literal.
function pickMainAgentDefinition(allAgents: AgentDefinition[]): AgentDefinition {
  const preferred =
    allAgents.find(a => a.agentType === 'general-purpose') ??
    allAgents.find(a => a.source === 'built-in' && !('execMode' in a))
  if (preferred) return preferred
  const fallback: AgentDefinition = {
    agentType: 'general-purpose',
    whenToUse: '高效任务主模型执行',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  }
  return fallback
}

// FsLike backed directly by node:fs/promises.
/** git via a child process. Every call names its own cwd — a worktree's index and HEAD are its own. */
const gitRunner: GitRunner = (args, cwd) =>
  new Promise(resolve => {
    const p = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += String(d) })
    p.stderr.on('data', d => { stderr += String(d) })
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    p.on('error', err => resolve({ code: -1, stdout: '', stderr: String(err) }))
  })

/**
 * 一个目录占多少空间(KB)。**量不到就返回 undefined,绝不猜。**
 *
 * 这个功能的全部卖点是「腾出多少空间」,而一个编出来的数字会直接决定用户按不按下那个
 * 不可逆的确认。`du` 在 Windows / 精简容器里可能根本不存在,那时确认屏改口说「量不到
 * 大小」——比一个 0 诚实得多。
 *
 * `-sk` 而不是 `-sh`:要的是能相加的数,人读的格式由 `formatSize` 统一给(`du -h` 的
 * 单位还随 locale 变)。
 */
const duKb = (path: string): Promise<number | undefined> =>
  new Promise(resolve => {
    const p = spawn('du', ['-sk', path])
    let stdout = ''
    p.stdout.on('data', d => { stdout += String(d) })
    // stderr 要吞掉但不能当失败:`du` 对一个跑着的目录会抱怨某个文件没了,而总数照样是对的。
    p.stderr.on('data', () => {})
    p.on('close', code => {
      const n = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10)
      resolve(code === 0 && Number.isFinite(n) ? n : undefined)
    })
    p.on('error', () => resolve(undefined))
  })

/**
 * Build the isolation pool, or report why the run has to share the working tree.
 *
 * Availability is decided ONCE, here, and never re-decided mid-run: a per-node fallback would
 * mean some executors write to the user's checkout while the gate said the run was isolated.
 * When init fails the pool is simply absent, and stepExecute then has nothing to gate on —
 * the run is honestly un-isolated and says so at the confirmation gate.
 */
async function makeWorktreePool(
  runId: string, cwd: string,
): Promise<{
  pool?: WorktreePool; reason?: string; notARepo?: boolean
  /**
   * 「是仓库,但一个提交都没有」。
   *
   * 和 notARepo **必须分开**,因为补救动作不同:notARepo 要 `git init`(在 cwd),
   * 而这一种**绝不能** init —— 用户可能正站在一个没有提交的仓库的**子目录**里,
   * 在那儿 init 会造出一个遮蔽父仓库的嵌套仓库(实测:rev-parse --show-toplevel 从此
   * 回答子目录),而代码里没有任何地方会清理它。这一种只需要在**仓库根**上补一个空提交。
   */
  needsFirstCommit?: boolean
  /** 仓库根 —— 补空提交要用它,不能用 cwd(见上)。 */
  gitRoot?: string
}> {
  const top = await gitRunner(['rev-parse', '--show-toplevel'], cwd)
  // notARepo is reported SEPARATELY from the reason string because it is the only condition
  // under which offering `git init` is correct. Every other failure below happens AFTER this
  // check succeeded — i.e. the directory already IS a repo (no commits yet, a branch-name
  // conflict, a worktree already checked out elsewhere) — and running `git init` there creates
  // a NESTED repository that shadows the real one. Measured: `git init` inside /repo/sub makes
  // `rev-parse --show-toplevel` answer /repo/sub, and nothing in this codebase ever cleans it up.
  if (top.code !== 0) return { reason: '当前目录不是 git 仓库', notARepo: true }
  const gitRoot = top.stdout.trim()
  /**
   * 「是仓库,但一个提交都没有」以前是个**死胡同**。
   *
   * pool.init() 会以「不是 git 仓库或没有提交」失败,而 notARepo 是 false —— 于是关口
   * 既不给 g 键,也只会说「需要先解决上面这条原因」。可修法和 g 做的事**一模一样**
   * (建一个空提交),用户却看不到入口,只能带着串行执行跑完整轮。
   *
   * 单独探一次而不是解析 init 的错误串:那个串是 git 给的,措辞会随版本变。
   */
  const head = await gitRunner(['rev-parse', '--verify', '--quiet', 'HEAD'], gitRoot)
  if (head.code !== 0) {
    return { reason: '这个 git 仓库还没有任何提交,建不出集成分支', needsFirstCommit: true, gitRoot }
  }
  const pool = createWorktreePool({ runId, gitRoot, git: gitRunner, worktreeRoot: `${gitRoot}/.efftask-worktrees` })
  const init = await pool.init()
  if (!init.ok) return { reason: init.reason }
  return { pool }
}

function fsAdapter(): FsLike {
  return {
    readFile: p => readFile(p, 'utf-8'),
    // Parent dirs are created here so every writer (writeNode, writeRunManifest) is safe
    // even when its own mkdir did not cover the leaf's directory.
    writeFile: async (p, d) => {
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, d, 'utf-8')
    },
    mkdir: p => mkdir(p, { recursive: true }).then(() => {}),
    // NON-recursive on purpose: that is the atomic form. EEXIST means another run already
    // reserved this id, so we report the loss rather than sharing the directory.
    mkdirExclusive: async p => {
      try {
        await mkdir(p)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw e
      }
    },
    unlink: p => unlink(p),
    rmdir: p => rmdir(p), // NON-recursive: releasing a lock must never delete a tree
    readdir: p => readdir(p), // returns string[] by default — matches FsLike
    exists: p => access(p).then(() => true, () => false),
  }
}

type RunnerProps = {
  args: string
  knownRoles: string[]
  /** settings.json 里配好的角色定义;提示词里的同名角色会覆盖它。 */
  baseRoleDefs?: RoleDef[]
  /** settings.json 的 efftaskCaps 定的安全阀;提示词里说的**逐字段覆盖**它。 */
  baseCaps?: Caps
  /** 读配置文件时产生的诊断 —— 必须并进 cfg.notices,否则关口对配置文件里的错误一言不发。 */
  baseRoleNotices?: string[]
  /** settings.json 的 efftaskSkipSteps 指定要跳过的环节;和提示词里说的**取并集**。 */
  baseSkipSteps?: PhaseName[]
  /** 本次会话可用的 MCP 工具名。关口要说清它们在哪些环节可用、以及挡不住什么。 */
  mcpToolNames?: string[]
  /** 本次会话的 MCP 服务器与连接状态。待审批的服务器不贡献任何工具 —— 见 ConfirmStartup。 */
  mcpServers?: { name: string; type: string }[]
  unsupportedRoles: string[]
  agentModels: AgentModelInfo[]
  mainModel: string
  /**
   * 需求解析那一次模型调用。第二个参数是它的实时窗口 —— 这一屏是用户敲完 /et
   * 看到的第一屏,此前背后跑着一次真实调用而界面上一个字都没有。
   */
  extractJson: (prompt: string, stream?: StreamHandle) => Promise<string>
  /** 依赖重算的专用缝(主模型 / 零工具 / 120s)。见调用点的注释。 */
  runRecalcAgent: (a: { node: TaskNode; prompt: string; signal: AbortSignal; stream?: StreamHandle }) => Promise<string>
  resumeArgs: ResumeArgs
  effRoot: string
  /** Mutated once the run is identified, so call()'s onExit closure can release the right lock. */
  active: { runId: string | null; runDir: string | null; resumed: boolean }
  /** Written when the config resolves; the runAgent seam reads it for each phase deadline. */
  capsRef: { nodeTimeoutMs: number; humanTimeoutMs: number }
  fs: FsLike
  runAgent: RunAgentFn
  signal: AbortSignal
  /** The run's own controller — what the /tasks entry aborts (spec §10). */
  controller: AbortController
  abort: () => void
  detach: () => void
  onTornDown: () => void
  /** call()-scoped holder for the handoff, read by onExit. See exitReportLine. */
  handoffOut: { current: HandoffSummary | null }
  handoffStateOut: { current: HandoffState | undefined }
  /** call()-scoped count of escalation cards the limiter dropped, read by onExit. */
  cardLimitOut: { current: number }
  humanWaitOut: { current: ((waiting: boolean) => void) | null }
  /** 运行中的人工干预面 —— 在 call() 里建,和 runAgent 共用同一个实例。 */
  control: RunControl
  onExit: (outcome: Outcome | null) => void
}

function EffTaskRunner(props: RunnerProps): React.ReactElement {
  const isResume = props.resumeArgs.mode === 'resume'
  // Resume never calls parseDirectives, so it must not start in 'parsing': that phase issues
  // a MODEL call to interpret the prompt, and on this path the "prompt" is `--resume 003 …`.
  // It would burn tokens parsing a flag and then overwrite the roster recovered from disk.
  const [phase, setPhase] = React.useState<Phase>(isResume ? 'picking' : 'parsing')
  const [config, setConfig] = React.useState<EffTaskConfig | null>(null)
  const [nodes, setNodes] = React.useState<TaskNode[]>([])
  // 仅查看后退出 (spec §17.3): the done view is reused as a read-only browser, and must not
  // claim the run was blocked when the user simply chose not to continue it.
  const [viewOnly, setViewOnly] = React.useState(false)
  // 隔离不可用的原因 (spec §8). null = isolation is available.
  const [isolationReason, setIsolationReason] = React.useState<string | null>(null)
  // Whether offering `git init` is CORRECT — i.e. the directory is not a repo at all. Every
  // other pool failure happens after that check passed, so init would create a nested repo.
  const [canInitGit, setCanInitGit] = React.useState(false)
  /**
   * 按 g 时要在哪儿、做什么。
   *
   * null = 不是仓库 → 在 cwd 上 `git init` + 空提交。
   * 字符串 = 是仓库但没提交 → **只**在这个仓库根上补空提交,绝不 init。
   */
  const firstCommitRoot = React.useRef<string | null>(null)
  const [, setInitingGit] = React.useState(false)
  const initingGit = React.useRef(false)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [runs, setRuns] = React.useState<RunSummary[] | null>(null)
  const [seed, setSeed] = React.useState<TaskNode[] | null>(null)
  // Isolation is resolved ONCE, when the gate is answered — never re-decided per node.
  const poolRef = React.useRef<WorktreePool | undefined>(undefined)
  // 收口 (spec §8): where the run's work ended up. Collected when the run ends, while the
  // worktrees still exist, and shown in the two places the user actually looks.
  const [handoff, setHandoff] = React.useState<HandoffSummary | null>(null)
  // 从 run.md 读回来的待收口状态(与上面那个 handoff 不同:这个是**恢复**路径上的)。
  const [pendingHandoff, setPendingHandoff] = React.useState<PendingHandoff | null>(null)
  // 收口动作的结果。必须显示出来:合并冲突/推送失败时,用户看到的不能是一个安静的 done。
  const [handoffResult, setHandoffResult] = React.useState<HandoffResult | null>(null)
  /**
   * 集成分支已经合回当前分支了吗。
   *
   * done 视图那句话按它写:不区分的话屏幕上会写「你的工作区未被改动」+「稍后收口:
   * /et --resume … 会重新弹出四选一」,而两句在自动合并之后都是**可照做的假话**
   * (第二条尤其:pendingHandoff 已经从 run.md 上清掉了,那条命令进来什么都不会弹)。
   */
  const [handoffState, setHandoffState] = React.useState<HandoffState | undefined>(undefined)
  /** 正在被重做的节点(done 视图按 r 选中的那个)。null = 没有重做在进行。 */
  const [redoTarget, setRedoTarget] = React.useState<TaskNode | null>(null)
  /**
   * 「快速重做失败环节」预选的那个入口。
   *
   * 和 `redoTarget` 分开而不是塞进同一个 state:关口是同一个组件,而这个字段决定它**从哪一屏
   * 开始**。合在一起的话,普通 `r` 也会带着上一次快速重做留下的入口,直接跳到确认屏 ——
   * 用户按 r 是要自己选的。
   */
  const [redoEntry, setRedoEntry] = React.useState<RedoEntry | null>(null)
  /** 正在被「跳过失败环节」的节点。 */
  const [skipTarget, setSkipTarget] = React.useState<TaskNode | null>(null)
  const [forcePassTarget, setForcePassTarget] = React.useState<TaskNode | null>(null)
  /**
   * 强制通过关口开之前是哪一屏 —— 取消时要回到**它**,不是无条件回 done。
   *
   * 这个关口是唯一一个**也能从 running 进来**的:运行中按 f 是预先批准。写死 `setPhase('done')`
   * 的话,用户在跑到一半时按 f 又按 Esc,run 还在跑而界面已经变成结束屏 —— 树不再更新,
   * 那三个运行中的干预键(p / i / x)一起消失,而什么都没有出错。
   */
  const [forcePassFrom, setForcePassFrom] = React.useState<Phase>('done')
  /**
   * 重做 / 跳过关口开之前是哪一屏。和 `forcePassFrom` 同一个理由,只是它们晚了一步才
   * 需要:在「运行中也能重做」之前,这两个关口只可能从结束屏进来。
   *
   * 它决定的不只是取消时回哪一屏 —— 还决定这次重做是**并进正在跑的那一棵树**还是
   * **重启一个编排器**(见 redoDeps 的 `from`)。写死 'done' 的话,运行中按下的重做会
   * 在别的节点还跑着的时候另起一个编排器,同一批节点被派两遍。
   */
  const [redoFrom, setRedoFrom] = React.useState<Phase>('done')
  /**
   * 正在被「清理已完成工作区」的那个节点,以及关口开之前是哪一屏。
   *
   * `cleanupFrom` 和 `forcePassFrom` 逐字同因:这个关口也能从 running 进来(长跑到一半、
   * 前十个子任务的 `target/` 已经把盘吃满,那正是要按它的时刻),而写死 'done' 会让一次
   * 取消把还在跑的 run 的界面换成结束屏。
   */
  const [cleanupTarget, setCleanupTarget] = React.useState<TaskNode | null>(null)
  /** 依赖重算的目标。只从运行视图进来(它要 hold 住节点、还要叫醒调度)。 */
  const [recalcTarget, setRecalcTarget] = React.useState<TaskNode | null>(null)
  /**
   * 这一次重算调用自己的 AbortController。
   *
   * **必须是每次调用一个**,而且 chain 到 run 级 signal 上:这条缝没有 control,
   * req.signal 是唯一的取消通道 —— 直接复用 run 级 signal 的话,Esc 要么取消不掉、
   * 要么 abort 掉整个 run。
   */
  const recalcAbort = React.useRef<AbortController | null>(null)
  const [cleanupFrom, setCleanupFrom] = React.useState<Phase>('done')
  /** 上一次重做落盘时**没做成**的那些事。空 = 干净。 */
  const [redoProblems, setRedoProblems] = React.useState<string[]>([])
  /**
   * 有几次工具权限确认在等人回答。>0 时任务树面板交出键盘。
   *
   * 计数而不是布尔:并行度大于 1 时可以同时有几个执行节点各自等一个确认。
   */
  const humanWait = useHumanWaitCount()
  /**
   * 运行中的人工干预面。**在 call() 里就建好**并交给 runAgent / orchestrator ——
   * 组件重挂时不能换一个新的,否则已经登记的在飞调用就再也取消不掉了。
   */
  const control = props.control
  /** 暂停状态镜像进 state,只为了让提示行重绘。真相在 control 里。 */
  const [paused, setPaused] = React.useState(false)
  /** 追加指令输入框开着吗。 */
  const [directiveOpen, setDirectiveOpen] = React.useState(false)
  /**
   * 并发上限改过之后逼一次重绘。**镜像,不是真相** —— 和 `paused` 同一条规矩。
   *
   * 表头那个数是编排器现读出来的(`pool().limit`),所以这里存的值没人读;存它只是因为
   * 按下 `+` 之后必须**当场**看到数字动一下。树本来有 1s tick,但「按了一下要等最多一秒
   * 才有反应」在一个只能靠这个数字确认自己按对了的界面上不合格。
   */
  const [, setParallelismTick] = React.useState(0)
  // 把通知口交给 call() 作用域里早就构造好的 runAgent —— 那时组件还不存在。
  // 卸载时收回:指向一个已卸载组件的 setState 会静默丢事件,而丢的正是「拿回键盘」。
  React.useEffect(() => {
    props.humanWaitOut.current = (w: boolean) => { if (w) humanWait.begin(); else humanWait.end() }
    return () => { props.humanWaitOut.current = null }
  }, [props.humanWaitOut, humanWait.begin, humanWait.end])
  const handoffRef = React.useRef<HandoffSummary | null>(null)
  // What the gate must SAY. Resolved before the gate opens; 'none' until then.
  const [isolation, setIsolation] = React.useState<'worktree' | 'none'>('none')
  // 启动关口第三关 (spec §2). `approved` is the config as confirmed at gates 1+2 — held
  // because the root-plan gate sits BETWEEN that confirmation and the run, and the drafting
  // call needs the confirmed roster (the plan role) to draft with.
  const [approved, setApproved] = React.useState<EffTaskConfig | null>(null)
  const [draft, setDraft] = React.useState<RootDraft | null>(null)
  const [draftError, setDraftError] = React.useState<string | null>(null)
  // Bumped to re-enter the drafting effect; also what the gate shows as "重拟 N 次".
  const [redrafts, setRedrafts] = React.useState(0)
  const redraftFeedback = React.useRef<string | null>(null)
  // The run's root node, minted ONCE. Re-minting per draft would give the run a different
  // createdAt on every re-draft and discard the plan the previous pass wrote into it.
  const rootRef = React.useRef<TaskNode | null>(null)
  // Per-run escalation budget (see createEscalationLimiter). A ref, not state: it must not
  // reset on re-render, and nothing renders from it.
  const cardLimit = React.useRef(createEscalationLimiter())
  // 子 agent 实时输出 (spec §10.2). One bounded ring buffer per node for the whole run.
  const streams = React.useRef(createStreamStore())
  /**
   * 树还没建起来时的两次真实模型调用也要有窗口。
   *
   * 「正在解析需求…」和「正在起草根方案…」各自背后是一次完整的模型调用,而它们此前
   * **完全没接输出** —— 用户敲完 /et 看到的第一屏、以及整个运行里最长的单次调用之一,
   * 都是纯黑屏。目标写的是「每一次模型调用都有窗口」,这两次也算数。
   */
  const preStreams = (): StreamState[] => streams.current.streams(PRE_TREE_NODE)
  /**
   * 这两屏的重绘。**必须在这里**,不能只挂在 TaskTreePanel 上。
   *
   * store 是 useRef —— 没有订阅就没有重绘。而「正在解析需求…」和「正在起草根方案…」
   * 这两屏根本没有任务树,TaskTreePanel 那个 tick 一次都不会跑:窗口会渲染一次空白,
   * 然后到调用结束都不动。那就等于把窗口挂上去当摆设,而这正是「声明了却没接上」的
   * 老毛病(orchestrator.ts 的注释里记着它已经发生过两次)。
   */
  useStreamTick(streams.current, phase === 'parsing' || phase === 'drafting')
  /**
   * 等待屏上「已经等了多久」。
   *
   * 这两屏背后各是一次完整的模型调用,起草那次是整个运行里最长的之一。没有秒数的话,
   * 一屏静止的文字分不出「在读代码」和「卡死了」—— 而这正是这个功能存在的理由。
   *
   * 事件驱动的重绘(useStreamTick)在**静默期不会触发**,所以秒数要自己有心跳。
   */
  const waiting = phase === 'parsing' || phase === 'drafting'
  const [waitStart, setWaitStart] = React.useState(() => Date.now())
  const [waitNow, setWaitNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!waiting) return
    setWaitStart(Date.now())
    setWaitNow(Date.now())
    const t = setInterval(() => setWaitNow(Date.now()), 1000)
    return () => clearInterval(t)
    // phase 进来一次就重新起表 —— 解析和起草是两段独立的等待,不该续着算。
  }, [waiting, phase])
  const waitedSec = Math.max(0, Math.round((waitNow - waitStart) / 1000))
  // 真实列宽。写死 100 的话,80 列终端上表头右半段(运行中/工具数/耗时)会被整段切掉 ——
  // justify() 放不下时退化成 left + ' ' + right,而 truncate-end 是从右边吃的,先没的
  // 正好是状态。80 列是极常见的默认,而 ParsingView 是敲完 /et 看到的第一屏。
  const { columns: termColumns } = useTerminalSize()
  /** 并行占用 reader, handed over once by runOrchestrator. */
  const poolRead = React.useRef<(() => { inUse: number; limit: number }) | null>(null)
  /**
   * 正在跑的那个编排器 —— **运行中重做**唯一的把手(用户原话:「不需要整体返回失败才能
   * 重做任务或阶段,在其它任务还在运行时就可以重做」)。
   *
   * 跑完会被置回 null(runOrchestrator 在 finally 里交还),所以「现在还有没有人在听」
   * 这个判断读它就够了 —— 而那个判断决定这次重做是就地换树还是重启编排。
   */
  const orchRef = React.useRef<EffTaskOrchestrator | null>(null)
  const [summary, setSummary] = React.useState<ResumeSummary | null>(null)
  const [fatal, setFatal] = React.useState<string | null>(null)
  const [runId, setRunId] = React.useState<string | null>(props.active.runId)
  const runDir = runId ? `${props.effRoot}/${runId}` : null
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  // The terminal surface stashes raceConfirm's `claim` here so the rendered ConfirmStartup
  // (and the unmount path) can settle the race.
  const terminalClaim = React.useRef<((w: ConfirmWinner, d: StartupDecision) => void) | null>(null)
  /** Whether the terminal gate has uncommitted edits — see the Feishu-wins branch below. */
  const terminalEdited = React.useRef(false)

  // If this view is ever torn down without going through onExit, the run must stop with it:
  // otherwise the orchestrator keeps issuing real, write-capable model calls and writing
  // node.md into a tree nothing is watching, and the parent-signal listener outlives us.
  const { abort, detach, onTornDown, onExit } = props
  // outcomeRef, not the state: the cleanup closure captures whatever the last render saw,
  // and a run that finished in the same tick as the teardown would report nothing.
  const outcomeRef = React.useRef<Outcome | null>(null)
  const recordOutcome = React.useCallback((o: Outcome) => { outcomeRef.current = o; setOutcome(o) }, [])
  React.useEffect(() => () => {
    onTornDown()
    abort()
    detach()
    // onDone is the ONLY thing that resolves processSlashCommand's promise. Reaching it
    // solely from the done view's key handler means any teardown that isn't a keypress
    // (Ctrl+O, Ctrl+Z→fg) leaves that promise pending forever, which the host warns
    // deadlocks the queue processor — and loses the result of a run that already finished.
    onExit(outcomeRef.current)
  }, [abort, detach, onTornDown, onExit])

  // ---- resume, step 1: work out WHICH run ----
  React.useEffect(() => {
    if (phase !== 'picking') return
    let cancelled = false
    const wanted = props.resumeArgs.runId
    if (wanted && wanted !== 'latest') { setRunId(wanted); setPhase('recovering'); return }
    void listRuns(props.fs, props.effRoot)
      .then(list => {
        if (cancelled) return
        if (wanted === 'latest') {
          // listRuns already drops reserved-but-empty directories, so `latest` cannot land on
          // one — which would recover zero nodes and die instantly on a childless root.
          if (list.length === 0) { setFatal('没有可恢复的 run'); setPhase('fatal'); return }
          setRunId(list[0].runId)
          setPhase('recovering')
          return
        }
        setRuns(list) // no id given → let the user choose
      })
      .catch(e => { if (!cancelled) { setFatal(`扫描 run 目录失败: ${msg(e)}`); setPhase('fatal') } })
    return () => { cancelled = true }
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once per phase entry
  }, [phase])

  // ---- resume, step 2: lock → read → validate → reseat ----
  React.useEffect(() => {
    if (phase !== 'recovering' || !runId || !runDir) return
    let cancelled = false
    void (async () => {
      // The lock FIRST: two terminals resuming the same run both write node.md for the same
      // ids, so the second silently overwrites the first's progress while both report success.
      const lock = await acquireRunLock(props.fs, runDir, process.pid, new Date().toISOString(), isPidAlive)
      if (cancelled) return
      if (!lock.acquired) {
        setFatal(`run ${runId} 正被另一个进程(pid ${lock.heldBy?.pid ?? '?'})续跑中,拒绝并发写入`)
        setPhase('fatal')
        return
      }
      // Only now is the run ours — record it so onExit releases this lock.
      props.active.runId = runId
      props.active.runDir = runDir

      const { config: recovered, degraded } = await readRunManifest(props.fs, runDir)
      // 收口关口要在**任何节点检查之前**判定,而且独立于 status —— 一个跑完的 run 根节点
      // 已经 ACCEPTED,reseat 一个节点也捞不回来,于是下面那句「没有可恢复的节点」会直接
      // 把用户挡在门外,而集成分支就永远没人处置了。这正是「跑完先还终端、回头再收口」
      // 这条路唯一的入口。
      if (recovered.pendingHandoff && recovered.pendingHandoff.commits > 0) {
        if (cancelled) return
        setPendingHandoff(recovered.pendingHandoff)
        setConfig(recovered)
        setPhase('handoff')
        return
      }
      const { nodes: raw, errors } = await loadRun(props.fs, runDir)
      const now = new Date().toISOString()
      const validated = validateLoadedNodes(raw, {
        goal: recovered.goalPrompt, phaseRoles: recovered.phaseRoles, now,
      })
      const reseated = reseatTransientNodes(validated.nodes, now, recovered.caps, {
        retryBlocked: props.resumeArgs.retryBlocked,
      })
      if (cancelled) return
      if (reseated.nodes.length === 0) {
        setFatal(`run ${runId} 里没有可恢复的节点`)
        setPhase('fatal')
        return
      }
      // §17.4 precedence: a guidance given NOW replaces whatever the run carries. Only when
      // this invocation supplies none does the stored one continue to apply — and then the
      // gate says so, because otherwise it silently steers every remaining node.
      const given = props.resumeArgs.guidance.trim()
      const inherited = given ? undefined : recovered.resumeGuidance?.trim() || undefined
      const withGuidance: EffTaskConfig = {
        ...recovered,
        resumeGuidance: given || inherited,
        resumes: [
          ...(recovered.resumes ?? []),
          {
            at: now, reseated: reseated.reseated.length, exhausted: reseated.exhausted.length,
            ...(reseated.retried.length > 0 ? { retried: reseated.retried.length } : {}),
            repairs: validated.repairs.slice(0, MAX_RECORDED_REPAIRS),
          },
        ],
      }
      // Re-resolve the roster against THIS session: a role recorded on disk may no longer
      // exist, and pickAgentDefinition would silently fall back to the main model while the
      // gate still displayed the old name — the exact dishonesty fixed for new runs.
      // The recovered caps are the run's caps — run.md is hand-editable, so a manifest that
      // declares a different nodeTimeoutMs must actually get it.
      props.capsRef.nodeTimeoutMs = withGuidance.caps.nodeTimeoutMs
      props.capsRef.humanTimeoutMs = withGuidance.caps.humanTimeoutMs
      const isoR = await makeWorktreePool(runId!, getCwd())
      poolRef.current = isoR.pool
      setIsolation(isoR.pool ? 'worktree' : 'none')
      if (!isoR.pool && isoR.reason) withGuidance.notices.push(`隔离不可用,执行阶段将共享工作目录并串行: ${isoR.reason}`)
      setConfig(annotateRoleModels(withGuidance, props.agentModels, props.mainModel))
      setSeed(reseated.nodes)
      setSummary({
        runId,
        counts: countStatuses(reseated.nodes),
        repairs: validated.repairs,
        reseated: reseated.reseated,
        exhausted: reseated.exhausted,
        retried: reseated.retried,
        degraded,
        loadErrors: errors.map(e => `${e.path}: ${e.message}`),
        inheritedGuidance: inherited,
      })
      // 这些节点是从盘上恢复的,事件流不落盘 —— 所以它们的窗口是空的。**空 ≠ 什么
      // 都没干**:一个上次跑了四十分钟的已完成节点,不标记的话会渲染成「暂无输出」,
      // 正是这个仓库反复在修的那类谎。
      streams.current.markHistorical(reseated.nodes.map(n => n.id))
      setNodes(reseated.nodes)
      setPhase('confirmResume')
    })().catch(e => { if (!cancelled) { setFatal(`恢复失败: ${msg(e)}`); setPhase('fatal') } })
    return () => { cancelled = true }
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once per phase entry
  }, [phase, runId])

  const { args, knownRoles, unsupportedRoles, extractJson, agentModels, mainModel, baseRoleDefs, baseRoleNotices, baseSkipSteps, baseCaps } = props
  // parseDirectives is a MODEL call. It runs HERE, behind a 正在解析需求… view — never in
  // call(), which would freeze the terminal with no UI while spending tokens.
  React.useEffect(() => {
    if (isResume) return // resume recovers its config from run.md; no model call, no roster overwrite
    let cancelled = false
    const preStream = streams.current.open({ nodeId: PRE_TREE_NODE, phaseLabel: '需求解析', label: '主模型', pinned: true })
    void parseDirectives(args, { knownRoles, unsupportedRoles, baseRoleDefs, baseCaps, modelJson: p => extractJson(p, preStream) })
      // belt & braces: parseDirectives already swallows extraction failures, but a rejection
      // here would otherwise strand the UI on 'parsing' forever. Keep unsupportedRoles here
      // too: dropping it would let a cli-mode role back onto the roster unannounced.
      .catch(() => parseDirectives(args, { knownRoles, unsupportedRoles, baseRoleDefs, baseCaps }))
      .then(async cfg => {
        if (cancelled) return
        // parseDirectives only ever sees role NAMES, so the roster it produces cannot say
        // which model each one runs on. Resolve that here — this is the only layer that can
        // see the agent definitions and the session model.
        props.capsRef.nodeTimeoutMs = cfg.caps.nodeTimeoutMs
        props.capsRef.humanTimeoutMs = cfg.caps.humanTimeoutMs
        // Isolation is resolved BEFORE the gate opens, because the gate has to tell the user
        // which kind of run this is — and it was telling every isolated run it was serial,
        // i.e. denying the one thing the user asked for. init() only creates a branch and a
        // worktree; if the user then cancels, the teardown below disposes of them.
        const iso = await makeWorktreePool(runId!, getCwd())
        // init() is async, so the effect can be torn down while it runs. Without this the
        // pool it just created (a real branch and a real worktree on disk) would be
        // unreachable and never disposed.
        // NOTE: nothing is reclaimed here. dispose() only inspects the nodes it is handed, so
        // dispose([]) would be a no-op — measured against real git, the integration branch and
        // its worktree both survive it. They are left in place deliberately: init() is
        // re-entrant and never moves an existing integration branch, so the next run adopts
        // them rather than paying to build them again.
        if (cancelled) return
        poolRef.current = iso.pool
        setIsolation(iso.pool ? 'worktree' : 'none')
        // spec §8's 「允许选择」: carried as its own state so the gate can present it as a
        // decision, instead of a line buried in the prompt-parsing notices.
        setIsolationReason(iso.pool ? null : (iso.reason ?? '未知原因'))
        firstCommitRoot.current = iso.needsFirstCommit === true ? (iso.gitRoot ?? null) : null
        setCanInitGit(iso.pool ? false : (iso.notARepo === true || iso.needsFirstCommit === true))
        // ALSO recorded in run.md. Replacing the notices.push with component state alone meant
        // the manifest stopped saying the run was un-isolated, while the resume path still did.
        if (!iso.pool && iso.reason) cfg.notices.push(`隔离不可用,执行阶段将共享工作目录并串行: ${iso.reason}`)
        // 配置文件那条录入口的诊断。放在**最前**:它讲的是用户写在盘上的东西哪里不对,
        // 比运行期的降级更该先看到。也一并落进 run.md —— notices 是持久的。
        if (baseRoleNotices && baseRoleNotices.length > 0) cfg.notices.unshift(...baseRoleNotices)
        // 两条录入口取**并集**,不是覆盖:配置文件说「一直跳质疑讨论」,提示词说「这次也跳
        // 验收」,两句都该生效。角色定义那边是覆盖语义(提示词点名了就换人),因为那是
        // 「谁来干」的单选;跳过是「干不干」的开关,叠加才符合两句话都说过的直觉。
        if (baseSkipSteps && baseSkipSteps.length > 0) {
          cfg.skipSteps = mergeSkipSteps(baseSkipSteps, cfg.skipSteps)
        }
        setConfig(annotateRoleModels(cfg, agentModels, mainModel))
        setPhase('confirm')
      })
      .catch(logError)
    return () => {
      cancelled = true
    }
  }, [args, knownRoles, unsupportedRoles, baseRoleDefs, baseCaps, baseRoleNotices, baseSkipSteps, extractJson, agentModels, mainModel])

  /**
   * Hand the confirmed run to the orchestrator. ONE definition, because two gates now reach
   * it: the resume gate goes straight here, while a fresh run passes through the root-plan
   * gate first and arrives carrying its confirmed root as the seed.
   */
  /**
   * spec §8 的「或初始化 git」。
   *
   * 在用户当前目录里跑 `git init`,然后重建隔离池。这是一次真实的、会改用户目录的副作用,
   * 所以它只能由关口上那个明确标注的按键触发 —— 绝不自动发生。失败时把原因换成 git 的
   * 报错留在关口上,让用户看得见为什么没成功,而不是静默回到原样。
   */
  const initGitAndRetry = React.useCallback(async (): Promise<void> => {
    // In-flight guard. Two presses used to launch two concurrent `git init` + pool builds and
    // let the later one overwrite poolRef; worse, pressing `g` and then Enter started the run
    // while poolRef.current was still undefined — un-isolated — and only afterwards flipped
    // the (already closed) gate to 'worktree'.
    if (initingGit.current) return
    initingGit.current = true
    setInitingGit(true)
    try {
      /**
       * 已经是仓库(只是没有提交)时**跳过 git init**。
       *
       * init 跑在 cwd 上,而用户可能正站在那个仓库的**子目录**里 —— 在那儿 init 会造出
       * 一个遮蔽父仓库的嵌套仓库(实测:rev-parse --show-toplevel 从此回答子目录),
       * 一次按键、无确认、无撤销,代码里也没有任何地方会清理它。
       */
      const cwd = firstCommitRoot.current ?? getCwd()
      if (firstCommitRoot.current === null) {
        const init = await gitRunner(['init'], cwd)
        if (init.code !== 0) {
          setIsolationReason(`git init 失败: ${(init.stderr || init.stdout).trim() || '未知错误'}`)
          return
        }
      }
      /**
       * A FIRST COMMIT, because without one `git init` cannot deliver what the key promises.
       *
       * `worktreePool.init()` begins with `rev-parse HEAD`, which on a fresh repo fails
       * (`fatal: ambiguous argument 'HEAD'`) — measured against real git. So the key labelled
       * 「初始化 git 并重试隔离」 used to leave a `.git` behind and STILL report isolation
       * unavailable, with the same key still on screen to press again. An advertised action
       * that provably cannot succeed is the exact failure this repo keeps paying for.
       *
       * `--allow-empty` so nothing of the user's is staged or captured by surprise, and the
       * message says who made it. Only ever reached on a repo this keypress just created.
       */
      const head = await gitRunner(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
      if (head.code !== 0) {
        const seedCommit = await gitRunner(['commit', '--allow-empty', '-m', 'chore: 初始化仓库(/et 隔离执行需要至少一个提交)'], cwd)
        if (seedCommit.code !== 0) {
          setIsolationReason(
            `已初始化 git 仓库,但建立首个提交失败,隔离仍不可用: ${(seedCommit.stderr || seedCommit.stdout).trim() || '未知错误'}`,
          )
          return
        }
      }
      const iso = await makeWorktreePool(runId!, cwd)
      poolRef.current = iso.pool
      setIsolation(iso.pool ? 'worktree' : 'none')
      setIsolationReason(iso.pool ? null : (iso.reason ?? '未知原因'))
      firstCommitRoot.current = iso.needsFirstCommit === true ? (iso.gitRoot ?? null) : null
        setCanInitGit(iso.pool ? false : (iso.notARepo === true || iso.needsFirstCommit === true))
    } finally {
      initingGit.current = false
      setInitingGit(false)
    }
  }, [runId])

  const startRun = React.useCallback((cfg: EffTaskConfig, rootSeed?: TaskNode[]): void => {
    setPhase('running')
    /**
     * 新的一轮编排 = 每个节点都重新拿到一次机会。
     *
     * 少了这一句,同会话里按 r 重做一个**被取消过**的节点会立刻再次被取消:redo 是原地
     * 重置、id 不变,而 cancelled 集合活在 call() 的整个生命周期里。用户看到的是界面闪
     * 一下、节点又变回 BLOCKED,理由还是那句「可以按 r 重做」。
     */
    props.control.clearAllCancels()
    /**
     * 预先批准同样归零 —— 而且**要说出来**。
     *
     * 归零的理由和上面那句同源:redo 是原地重置、id 不变,一条留下来的预先批准会作用到
     * 重做之后那份**不一样的产出**上,那正是 `failedAt` 过期时踩过的坑。
     *
     * 但静默丢掉用户亲手按过的批准是这个仓库反复付代价的另一类,所以拿返回值报出来 ——
     * 他至少知道要重按一次,而不是等到那一关照常开了会才发现。
     */
    const droppedApprovals = props.control.clearAllForcePasses()
    if (droppedApprovals > 0) {
      setRedoProblems([`重开编排,此前那 ${droppedApprovals} 条运行中预先批准已失效 —— 它们判的是重做之前那份产出,需要的话请重按 f`])
    }
    // Built at gate time, before the first step: init() creates the integration branch and
    // its worktree, which is real work the user has consented to. A failure is not fatal —
    // the run continues honestly un-isolated.
    const pool = poolRef.current
    void runOrchestrator(
      {
        config: cfg, runDir: runDir!, fs: props.fs, runAgent: props.runAgent,
        // 同一个实例:面板按 x 取消的是它,适配器登记在飞调用的也是它。
        control: props.control,
        signal: props.signal, seed: rootSeed ?? seed ?? undefined, worktrees: pool,
        // 后台任务登记 (spec §10). Handed to runOrchestrator rather than wired here: that
        // module is importable by a test, this one is not, and the last two features wired
        // in this file were dead in production while every test passed over the severed wire.
        // Absent a run id there is nothing to name or resume, so no entry is invented.
        taskEntry: runId && runDir
          ? { runId, runDir, setAppState, abortController: props.controller }
          : undefined,
        // 子 agent 实时输出:每次模型调用一条流。缓冲三层有界,长跑不会无限涨;详情
        // 视图在 render 期直接读它。
        openStream: meta => streams.current.open(meta),
        // 方案环节要知道自己在哪 —— 缺了它,「review 当前目录下的代码」这类目标只能
        // 照着标题写一句正确的废话(实测:重点/风险点/验收点全空)。
        cwd: getCwd(),
        // 并行占用 (spec §10.1). One call, storing a live reader for the status bar.
        onPool: read => { poolRead.current = read },
        // 运行中重做的把手。两次调用都要收:开跑时存下,跑完时置回 null。
        onOrchestrator: o => { orchRef.current = o ?? null },
        /**
         * 收口(spec §8 的自动那一半):跑完就把集成分支合回**当前目录**。
         *
         * 用户原话:「任务完后,在隔离环境产出的代码和目录,并且提交成功了,要在当前目录下
         * 有对应的存在。」判据和真正的合并都在 `finishHandoff` 里(可单测),这里只接线 ——
         * 这个文件里长逻辑的代价这一轮已经量过:验收在同一个位置造出过 14 条存活变异。
         */
        git: gitRunner,
        onHandoffResult: out => {
          const st: HandoffState | undefined = out.merged ? 'merged' : out.conflicted ? 'conflicted' : undefined
          setHandoffState(st)
          // 退出报告读的是 call() 作用域里的这个盒子(onExit 读不到 state)。
          props.handoffStateOut.current = st
          /**
           * 推送的结果**并进那条消息的 followUps**,不另开一块。
           *
           * 它和收口是同一件事的两半,而完成视图上那一格已经有位置;另开一个 state 就要
           * 在 done 视图、退出报告、run.md 三处各接一遍,而其中任何一处漏掉,用户看到的
           * 就是「推送开着,但没人说推没推成」。失败尤其要说 —— 那正是他要自己去补的一步。
           */
          if (out.result) {
            setHandoffResult(out.push
              ? { ...out.result, followUps: [...(out.result.followUps ?? []), out.push.message] }
              : out.result)
          } else if (out.push) {
            setHandoffResult({ ok: out.push.ok, message: out.push.message })
          }
        },
        // 升级人工 (spec §8). Rides the SAME shared client the startup card uses —
        // read at escalation time, not at gate time, because the bridge may connect
        // after the run starts. Absent bridge => no card; the node still blocks with
        // the branch, path and files in blockedReason, which the tree shows.
        onEscalate: e => {
          const client = store.getState().feishuClient
          if (!client) return
          void client.sendCard(buildConflictCard(e, runId ?? undefined)).catch(err => {
            logError(err instanceof Error ? err : new Error(String(err)))
          })
        },
        // 触阀升级 (spec §9/§11). Same shared client, read at escalation time. Rate-limited,
        // and the suppression is ANNOUNCED on the last card that gets through — silently
        // dropping notifications is the same failure as never sending them.
        onBlocked: info => {
          const client = store.getState().feishuClient
          if (!client) return
          const { send, note } = cardLimit.current.admit(info.stopped !== false)
          props.cardLimitOut.current = cardLimit.current.suppressed()
          if (!send) return
          const card = buildBlockCard(info, runId ?? undefined) as { elements: { text: { content: string } }[] }
          if (note) card.elements[0].text.content += `\n- ${note}`
          void client.sendCard(card).catch(err => {
            logError(err instanceof Error ? err : new Error(String(err)))
          })
        },
      },
      setNodes,
      recordOutcome,
      setPhase,
      h => { handoffRef.current = h; props.handoffOut.current = h; setHandoff(h) },
    )
    // biome-ignore lint/correctness/useExhaustiveDependencies: props/store are stable for a mount
  }, [runDir, runId, seed, props.fs, props.runAgent, props.signal, props.controller, recordOutcome, store, setAppState])


  /**
   * 执行一次重做,然后**重新启动编排**。
   *
   * 这一整段的顺序是有讲究的,每一步都能单独毁掉这次重做:
   *
   *  1. 先算(planRedo 是纯函数,算错了这里就停,盘上什么都没动);
   *  2. 再删盘上的子树 —— 不删的话 loadRun 下次 `--resume` 会把它们**原样复活**,
   *     而内存里的父节点 childIds 已经不认它们了;
   *  3. 再落盘剩下的节点 —— 依赖被改写过的那些必须写下去,否则重启后读回的是旧依赖;
   *  4. 最后才 startRun。它是这个文件里 runOrchestrator 的**唯一**调用点,绕开它
   *     只会把界面翻到运行视图然后永远不动。
   *
   * 隔离工作区走 pool.release():它对**脏的或者没合入的**工作区会拒绝删除并说明原因。
   * 那正是这里想要的 —— 重做不该顺手毁掉用户还没合并的产出。删不掉的会被显示出来。
   */
  /**
   * 执行一次重做。
   *
   * **这里只剩接线。** 「按下确认之后到底发生什么」——落盘、上屏、进 state、重启,
   * 以及它们的顺序——全部住在 redoRun.ts,由 redoRun.test.ts 真的调一次并断言。
   *
   * 这么拆是被验收量出来的:同样的逻辑长在这个文件里时,唯一的防线是 wiringCoverage
   * 里几条源码文本断言,而验收把每一个被断言的字符串**原样留着**,造出 14 条变异
   * 全部存活 —— 每一条的后果都是「按下确认之后界面纹丝不动」,而全套测试绿。
   */
  /**
   * 重做和跳过共用的那一套落盘接线 —— 两者从这里往后逐字相同(见 redoRun.ts 的注释)。
   *
   * 抽出来是因为「按下确认之后要做的六件事」漏掉任何一件的后果都是「界面纹丝不动」,
   * 而那正是验收在这个文件里造出 14 条存活变异的地方。一份实现,两个入口。
   */
  /**
   * 一次重做的六步接线。`from` 决定**最后一步**是什么:
   *
   *  - `'done'`(结束屏那条路):`start` = 起一个新的编排器,把新树当种子;
   *  - `'running'`(运行中那条路):`start` = 把新树并进**正在跑的**那一棵,并且在落盘
   *    之前先用 `hold` 把要动的节点从调度里扣下来(见 redoRun 的 canApply)。
   *
   * 起第二个编排器是运行中最不能做的事:此刻别的节点正在跑,老编排器仍持有它们的在飞
   * 调用、仍会 commit 进自己那棵树,而新编排器会把同一批节点再派一遍 —— 这个仓库为
   * 「三下回车起了三个编排器」已经付过一次学费。
   */
  const redoDeps = React.useCallback((cfg: EffTaskConfig, dir: string, from: 'running' | 'done' = 'done') => {
    /** 运行中那条路上,`canApply` 扣住的那批节点由 `start` 释放。 */
    let hold: { release: () => void } | null = null
    return ({
    commit: (plan: RedoPlan, before: readonly TaskNode[]) => commitRedo(
      {
        fs: props.fs, runDir: dir, config: cfg, pool: poolRef.current ?? undefined,
        before, onError: (e: unknown) => logError(e instanceof Error ? e : new Error(String(e))),
      },
      plan,
    ),
    onProblems: setRedoProblems,
    /**
     * 被删掉的子树的实时输出也一起扔掉 —— 否则重做之后新建的同名子节点会顶着
     * 上一轮的运行记录(childId 由「父id + 序号 + 标题 slug」算出,重拆一次常常一模一样)。
     */
    onDropStreams: (ids: readonly string[]) => { streams.current.dropNodes(ids) },
    onNodes: setNodes,
    /**
     * 落盘之前的那一问,**只在运行中那条路上有**。
     *
     * 编排器已经跑完(orchRef 是 null)时返回 undefined 而不是一句拒绝:那意味着这次
     * 重做该走结束屏那条路,而下面的 `start` 也会照着同一个判据去 startRun。两处判据
     * 必须是同一个,否则会出现「问的时候说在跑、做的时候说没在跑」。
     */
    canApply: from === 'running'
      ? (affected: readonly string[]): string | undefined => {
        const orch = orchRef.current
        if (!orch) return undefined
        const held = orch.hold(affected)
        if (!held.ok) return held.reason
        hold = held
        return undefined
      }
      : undefined,
    start: (n: TaskNode[], affected: readonly string[]) => {
      const orch = from === 'running' ? orchRef.current : null
      if (!orch) { hold?.release(); startRun(cfg, n); return }
      const applied = orch.applyLive(n, affected)
      // 扣住的一定要放回去 —— 换树成功与否都放:失败时那批节点得能继续被调度
      // (它们此刻在盘上是重做后的样子,但内存里还是旧的,让运行照旧继续是唯一诚实的结局)。
      hold?.release()
      if (!applied.ok) {
        /**
         * 换树没成 —— 而**盘上已经是新树了**。如实说,并且给出唯一能兑现的下一步。
         *
         * 这一句在正常情况下到不了(hold 已经把窗口关掉了),留着是因为它描述的状态
         * 真实存在:磁盘和内存不一致时,用户唯一的出路是让这一轮跑完再 /et --resume。
         */
        setRedoProblems([
          `${applied.reason} —— 这次重做已经写进磁盘,但没有并进正在跑的那一轮;` +
          `等本轮结束后 /et --resume 会按重做后的树继续。`,
        ])
        return
      }
      setPhase('running')
    },
    onDone: () => { hold?.release(); setPhase(from) },
    })
    // biome-ignore lint/correctness/useExhaustiveDependencies: props are stable for a mount
  }, [props.fs, startRun])

  /** 这次重做/跳过要按哪份环节实况算 —— 关口预演和真正执行必须是同一份。 */
  const phaseCtxOf = React.useCallback(
    (target: TaskNode, cfg: EffTaskConfig) =>
      // isolated:跳过验收能不能安全放行要靠它(见 RedoContext.isolated)。只有这一层
      // 看得见那个池子。
      redoContextOf(target, cfg, {
        isolated: poolRef.current !== undefined,
        // 现读,不快照:关口是在用户按下 r 的那一刻渲染的,而档位可以在那之前的任何
        // 一秒被调过。见 redoSummary 里那一行说的事。
        strictness: control.strictness() ?? cfg.caps.strictness,
      }),
    [control],
  )

  /**
   * 一次「回收已完成工作区」要用的那几样东西 —— **只有池子在的时候才存在**。
   *
   * 路径和分支名一律问池子要(`worktreePathOf` / `worktreeBranchOf`):它们是
   * `hash(nodeId)` 算出来的,在这里重算一份的话,`worktreeSlug` 规则改动的那一天这个
   * 键会开始 `rm -rf` 另一个目录,而它是不可逆的。
   *
   * `persist` 给了 run 目录:删掉目录之后 node.md 里那条 `worktree` 记录要跟着抹掉,
   * 否则详情页会一直指着一个不存在的路径。**只抹这一个字段**,状态/方案/评审记录不动。
   */
  const cleanupDeps = React.useCallback((): CleanupDeps | undefined => {
    const pool = poolRef.current
    if (!pool || !runDir) return undefined
    return {
      git: gitRunner,
      gitRoot: pool.gitRoot,
      integrationBranch: pool.integrationBranchName,
      pathFor: n => pool.worktreePathOf(n),
      branchFor: n => pool.worktreeBranchOf(n),
      dirSizeKb: duKb,
      persist: { fs: props.fs, runDir },
      onError: e => logError(e),
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: props.fs is stable for a mount
  }, [runDir, props.fs])

  const applyRedo = React.useCallback((
    target: TaskNode, entry: RedoEntry, guidance?: { scope: PhaseName | 'all'; text: string },
  ): void => {
    const cfg = config
    if (!cfg || !runDir) return
    setRedoTarget(null)
    setRedoEntry(null)
    // 关口预演和真正执行用**同一份**环节实况,否则屏幕上算出来的后果和实际发生的
    // 可以不一样,而用户是照着屏幕按的确认。
    void runRedo(
      nodes, target.id, entry, new Date().toISOString(),
      redoDeps(cfg, runDir, redoFrom === 'running' ? 'running' : 'done'), phaseCtxOf(target, cfg), guidance,
    )
  }, [config, runDir, nodes, redoDeps, phaseCtxOf, redoFrom])

  /**
   * 执行一次「跳过失败的环节」。
   *
   * 和 applyRedo 走同一套 deps(落盘 → 上屏 → 进 state → 重启编排),只是新树由
   * `planSkip` 算 —— 见 redoRun.ts 的 runSkip。
   */
  const applySkip = React.useCallback((
    target: TaskNode, guidance?: { scope: PhaseName | 'all'; text: string },
  ): void => {
    const cfg = config
    if (!cfg || !runDir) return
    setSkipTarget(null)
    void runSkip(
      nodes, target.id, new Date().toISOString(),
      redoDeps(cfg, runDir, redoFrom === 'running' ? 'running' : 'done'), phaseCtxOf(target, cfg), guidance,
    )
  }, [config, runDir, nodes, redoDeps, phaseCtxOf, redoFrom])

  /**
   * 执行一次「强制通过失败的环节」—— 阻断后那条路。
   *
   * 和 applySkip 走同一套 deps(落盘 → 上屏 → 进 state → 重启编排),只是新树由
   * `planForcePass` 算。运行中预先批准那条路**不走这里**:它一个节点都不动,见下面
   * ConfirmForcePass 的 onPreApprove。
   */
  const applyForcePass = React.useCallback((
    target: TaskNode, guidance?: { scope: PhaseName | 'all'; text: string },
  ): void => {
    const cfg = config
    if (!cfg || !runDir) return
    setForcePassTarget(null)
    void runForcePass(
      nodes, target.id, new Date().toISOString(),
      redoDeps(cfg, runDir, forcePassFrom === 'running' ? 'running' : 'done'), phaseCtxOf(target, cfg), guidance,
    )
  }, [config, runDir, nodes, redoDeps, phaseCtxOf, forcePassFrom])

  /**
   * 执行收口选择,然后把待收口记录从 run.md 里划掉。
   *
   * 划掉这一步不能省:留着的话,下一次 `/et --resume` 会为一条**已经合并/推送/删掉**的
   * 分支再弹一次四选一 —— 而「丢弃」那一项会对着一条不存在的分支报错。
   */
  const settleHandoff = React.useCallback(async (choice: HandoffChoice) => {
    const h = pendingHandoff
    if (!h || !runId) return
    let result: HandoffResult
    try {
      /**
       * 关口里那次合并也让模型先解一次冲突 —— 和自动收口(runOrchestrator)同一件事,
       * 不能只在一条路上有:两条路合的是同一条分支、进的是同一个检出,行为不一样的话
       * 「跑完直接合」和「resume 进关口再合」会给出两种结果,而用户根本不知道自己走的是哪条。
       *
       * 拿不到根节点(恢复路径下 nodes 尚未载入)就不接线,退回留下冲突现场的老行为。
       */
      const root = nodes.find(n => n.id === 'root')
      result = await runHandoffChoice(
        choice, h, gitRunner, getCwd(),
        root ? makeHandoffConflictResolver({ runAgent: props.runAgent, node: root, signal: props.signal }) : undefined,
      )
    } catch (e) {
      result = { ok: false, message: `收口失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    /**
     * 只有真的成功了才划掉。失败(冲突、脏树、推不上去)必须让它留着,用户下次还能回来 ——
     * 而且关口刚刚已经如实告诉他失败了什么。
     *
     * **`keep` 也算处置完了,尽管它什么都没做。** 这一条反直觉,验收实测过反过来的后果:
     * 恢复路径在**任何节点检查之前**就判 `pendingHandoff` 并 return(只渲染关口),而关口的
     * 每一个出口都走 `setPhase('done')` —— 没有一条通往续跑。所以 `keep` 不划掉的话,
     * 一个「被安全阀挡住 + 有待收口」的 run 会**永久卡在收口关口**:第二次 `--resume`
     * 还是那一屏,`--retry-blocked` 永远到不了 reseat,而 README 承诺它能重开那些节点。
     *
     * 代价是 ConfirmHandoff 上「Esc 稍后再说(等同「保留」)」那句话不完全准 —— 记录会被
     * 划掉,以后只能 `git merge <branch>` 自己来。文案已经按这个改口(见 ConfirmHandoff)。
     */
    if (result.ok) {
      // props.effRoot,不是裸 effRoot —— 那个绑定只存在于 call() 的作用域。这三行躲在
      // try/catch 后面,所以裸写它是**静默失败**:收口明明成功了,pendingHandoff 却永远
      // 划不掉,下次 --resume 会为一条已经合并/推送/删掉的分支再弹一次四选一,而「丢弃」
      // 那一项会对着一条不存在的分支报错。
      try {
        const runDir = `${props.effRoot}/${runId}`
        const { config: cur } = await readRunManifest(props.fs, runDir)
        const { nodes } = await loadRun(props.fs, runDir)
        const cleared = { ...cur, pendingHandoff: undefined }
        await writeRunManifest(props.fs, runDir, cleared, nodes)
      } catch (e) { logError(e instanceof Error ? e : new Error(String(e))) }
    }
    setHandoffResult(result)
    // 关口里那次合并同样要让 done 视图改口 —— 判据和自动收口共用一个 state,
    // 否则同一件事在两条路上被描述成两个样子。
    if (choice === 'merge' && result.ok) { setHandoffState('merged'); props.handoffStateOut.current = 'merged' }
    setPhase('done')
    // props.effRoot,不是裸 effRoot:那个绑定只存在于 call() 的作用域,组件里没有。
  // 依赖数组**每次 render 都求值**,所以裸写它 = EffTaskRunner 第一次渲染就抛
  // ReferenceError,/et 输入任何内容都只得到一屏红色堆栈,一次模型调用都没有。
  }, [pendingHandoff, runId, props.effRoot, props.fs, props.runAgent, props.signal, nodes])

  // ---- 启动关口第三关: 起草根方案 + 首层任务树 (spec §2) ----
  React.useEffect(() => {
    if (phase !== 'drafting' || !approved) return
    // 跳过分析时整个关掉第三关。不关的话:白付一次 plan 调用,而且 stepStart 的守卫
    // 会把用户在这一关批准的首层任务树**整个丢掉**(实测:关口显示 5 个子任务,
    // 用户回车,运行建出 0 个)。这次 run 声明了不要方案,就别再问他确认方案。
    // **必须走 startRun**。setPhase('running') 只是把界面翻到运行视图 —— runOrchestrator
    // 在整个文件里只有 startRun 这一个调用点,绕开它的结果是:界面停在
    // 「run 004 ✓0 ◐0 ○0 ✗0」永远不动,没有节点、没有报错、也不退出。
    if ((config?.skipSteps ?? []).includes('plan')) { startRun(approved); return }
    let cancelled = false
    void (async () => {
      const now = new Date().toISOString()
      // Minted once and reused across re-drafts, so the plan text of the previous pass is
      // still in the node when planPrompt renders 上一版方案 for the revision.
      const root = rootRef.current ?? makeRootNode(approved, now)
      rootRef.current = root
      const feedback = redraftFeedback.current ?? undefined
      redraftFeedback.current = null
      const res = await draftRootPlan({
        root, config: approved, runAgent: props.runAgent, signal: props.signal, feedback,
        worktrees: poolRef.current,
        // 第三关的窗口。整个运行里最长的单次调用之一,此前是纯黑屏。
        cwd: getCwd(),
        stream: streams.current.open({ nodeId: PRE_TREE_NODE, phaseLabel: '根方案', label: '主模型', round: redrafts + 1, pinned: true }),
        // 空方案自动重拟那一次也有自己的窗口 —— 否则界面上看不出它为什么多花了一倍时间。
        retryStream: () => streams.current.open({ nodeId: PRE_TREE_NODE, phaseLabel: '根方案(重拟)', label: '主模型', round: redrafts + 1, pinned: true }),
      })
      if (cancelled) return
      if (res.ok) {
        // Keep the node in step with what the gate shows: a later re-draft must revise THIS
        // plan, and applyRootDraft on approval writes the same values again.
        root.plan = { ...res.draft.plan }
        root.kind = res.draft.kind
        setDraft(res.draft)
        setDraftError(null)
      } else if (draft) {
        // A failed RE-draft still has a plan on screen — the previous one. Saying only
        // "失败" would leave the user approving a revision that never happened.
        setDraftError(`重拟失败(${res.reason});下面仍是上一版方案。`)
      } else {
        setDraftError(`未能起草根方案(${res.reason});确认后将由 plan 角色在运行中自行起草。`)
      }
      // 第三关的飞书通知 (spec §9 "不新造确认通道" 的诚实边界)。A user who approved gates 1
      // and 2 FROM FEISHU otherwise received nothing further and the run sat here waiting for
      // a keystroke nobody was present to press. Notification only — it says so.
      try {
        const client = store.getState().feishuClient
        if (client) {
          void client.sendCard(buildRootPlanNoticeCard({
            goalPrompt: approved.goalPrompt,
            draft: res.ok ? res.draft : (draft ?? EMPTY_DRAFT),
            drafted: res.ok || draft !== null,
            runId: runId ?? undefined,
          })).catch(err => logError(err instanceof Error ? err : new Error(String(err))))
        }
      } catch (e) { logError(e instanceof Error ? e : new Error(String(e))) }
      setPhase('confirmRoot')
    })().catch(e => {
      if (cancelled) return
      setDraftError(`起草根方案时出错(${msg(e)});确认后将由 plan 角色在运行中自行起草。`)
      setPhase('confirmRoot')
    })
    return () => { cancelled = true }
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs per drafting entry
  }, [phase, approved, redrafts, startRun])

  /**
   * Settle-once. The other two gates go through raceConfirm, whose claim() is single-shot;
   * this one calls onDecision directly, and the component is still mounted and still
   * listening while React commits setPhase('running'). Three fast Enters therefore started
   * THREE orchestrators on the same run directory — measured: 8 model calls instead of 4, one
   * node.md written 12 times, and under isolation a second acquire() that parks the first
   * run's in-flight work on a salvage ref while two write-capable executors share a worktree.
   */
  const rootDecided = React.useRef(false)
  const onRootDecision = React.useCallback((d: RootPlanDecision): void => {
    // Once the run has started, EVERY further decision is refused — including 'redraft'.
    // Letting redraft through after a start pulled the phase back to 'drafting' while the
    // orchestrator was already running: the user landed on a gate whose keys were all latched
    // shut, with a run they could no longer see working behind it.
    if (rootDecided.current) return
    // 'redraft' is repeatable until then; only 'start'/'cancel' latch.
    if (d.action !== 'redraft') rootDecided.current = true
    if (d.action === 'cancel') { props.abort(); props.onExit(null); return }
    if (d.action === 'redraft') {
      redraftFeedback.current = d.feedback
      setRedrafts(n => n + 1)
      setPhase('drafting')
      return
    }
    const cfg = approved
    if (!cfg) return
    const root = rootRef.current
    // Seed ONLY with a real draft. Sealing an empty plan would make stepStart skip its plan
    // call and send a blank plan straight to the review roundtable — the failed-draft path
    // must degrade to "the run drafts it itself", which is what no seed means.
    if (root && draft) {
      applyRootDraft(root, draft, new Date().toISOString())
      startRun(cfg, [root])
      return
    }
    startRun(cfg)
  }, [approved, draft, startRun, props])

  React.useEffect(() => {
    if ((phase !== 'confirm' && phase !== 'confirmResume') || !config) return
    const isResumeGate = phase === 'confirmResume'
    let cancelled = false
    let settled = false
    const surfaces: ConfirmSurface[] = [
      (claim, onTeardown) => {
        terminalClaim.current = claim
        onTeardown(() => {
          terminalClaim.current = null
        })
      },
    ]
    // Gate on the SHARED client + callbacks written by useFeishuBridge — NOT on
    // getFeishuConfig. We never construct/connect/close a client of our own; the startup
    // card multiplexes onto the existing bridge via its own requestId.
    const { feishuClient, feishuPermissionCallbacks } = store.getState()
    if (feishuClient && feishuPermissionCallbacks) {
      const requestId = randomUUID()
      const cardContent = buildStartupCard(config, requestId, summary ?? undefined, isolation)
      surfaces.push((claim, onTeardown) =>
        sendFeishuStartupCard(
          {
            client: feishuClient,
            callbacks: feishuPermissionCallbacks,
            requestId,
            cardContent,
            parallelism: config.parallelism,
          },
          claim,
          onTeardown,
        ),
      )
    }
    // Race [terminalSurface, feishuSurface?]: first responder wins, the other is torn down.
    // The signal is passed in so a REPL-level abort settles the gate instead of hanging.
    void raceConfirm(surfaces, { signal: props.signal })
      .then(({ winner, decision }) => {
        settled = true
        if (cancelled) return
        // The Feishu card carries no roster and a gate-open parallelism snapshot, so a Feishu
        // win uses what its card displayed. When the terminal had unsent edits that is a real
        // loss, and it used to happen with nothing on any surface saying so — the view simply
        // flipped to the next phase.
        if (winner === 'feishu' && decision.approved && terminalEdited.current) {
          onDone(
            '注意: 本次启动由飞书批准,采用的是卡片上显示的并行数与角色名册;你在终端里未提交的修改没有生效。',
            { display: 'system' },
          )
        }
        if (!decision.approved) {
          // 仅查看后退出 (spec §17.3): the third answer, which used to be a synonym for Esc.
          // The recovered tree is already in state — the gate rendered its counts from it — so
          // hand it to the read-only browser rather than exiting on a key that promised a view.
          if (decision.viewOnly && isResumeGate) { setViewOnly(true); setPhase('done'); return }
          props.onExit(null) // cancelled at the gate: no run outcome to report
          return
        }
        // Apply what the user confirmed — the parallelism AND the roster (spec §2 第一关
        // "名册可编辑后确认"). An absent roster means "unchanged", which is what a Feishu
        // approval sends: that card has no channel for a five-phase role table.
        //
        // KNOWN GAP, now covering both fields: this snapshots config at gate-open, so terminal
        // edits that were not yet committed are discarded if the FEISHU surface wins the race.
        // There is no channel from the gate's React state to the Feishu surface.
        const effectiveConfig: EffTaskConfig = applyStartupDecision(config, decision)
        /**
         * 用户选了**共享工作树** —— 把已经建好的池子放下。
         *
         * 池子是在关口**打开之前**建的(关口要说清这一趟是哪种运行),而这个选择是在关口上
         * 做的,所以只能在这儿兑现。放下之后 `ctx.worktrees === undefined`,执行阶段走的就是
         * 既有的非隔离回落:共享工作目录 + 串行执行 + 不产生任何提交。
         *
         * **不去删那条集成分支和它的工作区**:`init()` 是可重入的、而且从不移动已存在的
         * 集成分支,下一趟会原样接手 —— 这和用户在关口按 Esc 那条路的处置逐字相同
         * (见 makeWorktreePool 调用处的注释)。
         */
        if (effectiveConfig.isolation === 'shared') {
          poolRef.current = undefined
          // 状态也要跟着改口:它是「这一趟**实际**隔离了没有」,而运行视图的表头、
          // run.md 的那条 notice 都读它。留着 'worktree' 就是屏幕上说隔离、实际共享。
          setIsolation('none')
        }
        setApproved(effectiveConfig)
        // RESUME skips the third gate. Its tree already exists on disk — drafting a fresh
        // root plan would ask the user to confirm a decomposition the run is not going to
        // build, and `confirmedDraft` on a root that already has children would graft a
        // second copy of the first level.
        if (isResumeGate) {
          // 名册可编辑 (spec §17.3) only means something if the edit reaches the NODES. Every
          // dispatch site reads `node.phaseRoles`; `config.phaseRoles` enters the tree solely
          // through `makeRootNode`, which a seeded (i.e. resumed) run never calls. Without
          // this the gate's editor was decorative AND run.md recorded a roster no node used —
          // see applyRosterToNodes.
          // ONLY when the user actually changed it. An unconditional overwrite broke two
          // things at once:
          //   - a DEGRADED run.md yields `emptyPhaseRoles()` (readRunManifest's documented
          //     fallback), so pushing it onto the tree wiped the live, dispatchable roles that
          //     every node.md still carried — and node.md is the surviving truth there, as
          //     readRunManifest's own comment says ("every node.md is still on disk");
          //   - §4.2 allows a per-node roster override, and re-stamping the run-level roster on
          //     every resume flattened it, even when the user touched nothing and just pressed
          //     Enter. applyRosterToNodes' own comment explains why it copies per node to
          //     protect that override — while the call site erased it.
          if (!rosterEquals(effectiveConfig.phaseRoles, config.phaseRoles)) {
            // `seed` is what the orchestrator actually receives (startRun passes it through),
            // so this does not depend on `nodes` and `seed` being the same object identities —
            // a plain `setNodes(reseated.nodes.map(n => ({...n})))` tidy-up would otherwise
            // have silently un-done the whole fix, with every test still green.
            applyRosterToNodes(seed ?? nodes, effectiveConfig.phaseRoles)
          }
          startRun(effectiveConfig)
          return
        }
        setPhase('drafting')
      })
      .catch(e => {
        settled = true
        // A broken race must land on the done view, not hang on 'confirm'.
        if (cancelled) return
        recordOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
        setPhase('done')
      })
    return () => {
      cancelled = true
      // Unmounting mid-gate must settle the race, otherwise the Feishu surface's entry in
      // the SHARED permission-callbacks registry is never unsubscribed and its card stays
      // live in the chat forever.
      if (!settled) terminalClaim.current?.('cancelled', CANCELLED)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the gate is opened once per config
  }, [phase, config])

  const bail = (): void => { props.abort(); onExit(null) }
  // Every branch below needs a key handler of its own: while a local-jsx dialog is mounted
  // the REPL disables Esc/Ctrl+C, so any view without one can wedge the whole session.
  if (phase === 'fatal') {
    return <MessageView title="高效任务无法继续" body={fatal ?? '未知错误'} tone="error" onDismiss={bail} />
  }
  if (phase === 'picking') {
    if (!runs) return <MessageView title="高效任务 · 恢复" body="正在扫描可恢复的 run…" tone="dim" onDismiss={bail} />
    return (
      <ResumePicker
        runs={runs}
        onPick={id => { setRunId(id); setPhase('recovering') }}
        onCancel={bail}
      />
    )
  }
  if (phase === 'recovering') {
    return <MessageView title="高效任务 · 恢复" body={`正在读取并校验 run ${runId ?? ''}…`} tone="dim" onDismiss={bail} />
  }
  if (phase === 'handoff' && pendingHandoff) {
    return (
      <ConfirmHandoff
        handoff={pendingHandoff}
        runId={runId ?? ''}
        onDecision={choice => { void settleHandoff(choice) }}
        onSkip={() => { void settleHandoff('keep') }}
      />
    )
  }
  if (phase === 'parsing' || !config) {
    return <ParsingView onCancel={bail} log={preStreams()} columns={termColumns} waited={waitedSec} />
  }
  if (phase === 'confirmResume' && summary) {
    return <ConfirmResume
        config={config}
        summary={summary}
        isolation={isolation}
        nodes={nodes}
        // 名册可编辑 (spec §17.3). Same two props ConfirmStartup gets: only roles this session
        // can actually dispatch, each rendered with the model it would run on.
        availableRoles={dispatchableRoles(props.knownRoles, props.unsupportedRoles)}
        roleModel={name => effectiveModel(props.agentModels.find(a => a.agentType === name), props.mainModel)}
        // Same wire ConfirmStartup has, and it was missing here — so the 'Feishu won, your
        // terminal edits were dropped' warning below was DEAD CODE on the resume path while
        // this gate had just started inviting roster edits. The card carries no roster.
        onEdited={() => { terminalEdited.current = true }}
        onDecision={d => terminalClaim.current?.('terminal', d)}
      />
  }
  if (phase === 'confirm') {
    return (
      <ConfirmStartup
        config={config}
        isolation={isolation}
        // 会话级 MCP 工具。所有环节都能用,而「评审席位可以自己改完再判通过」这件事
        // 必须在用户按 y 之前说出来 —— 这是他要自己决定的取舍。
        mcpToolNames={props.mcpToolNames}
        // 服务器状态单独一份:「配了但卡在待审批」是用户报过的那一种,而它在工具名里
        // 表现为一片空白 —— 和「根本没配 MCP」无法区分。
        mcpServers={props.mcpServers}
        // 出网路线:有全局代理时,哪些员工的端点会绕过它直连、哪些仍走代理。
        // 用户报过一次「配了 roles 就连不上」,真凶是一条早就忘了的 HTTPS_PROXY。
        apiUrls={props.agentModels.map(a => a.roleClientConfig?.apiUrl)}
        // 自动压缩按哪个窗口触发。只列**估出来的**那些 —— 用户自己声明过的数不用复述。
        contextWindows={props.agentModels.map(a => ({
          name: a.agentType, window: a.contextWindow, assumed: a.contextWindowAssumed,
        }))}
        // spec §2 第一关 "名册可编辑". Only roles this session can actually dispatch — the
        // roster must not offer a seat the run would then silently downgrade to the main model.
        availableRoles={dispatchableRoles(props.knownRoles, props.unsupportedRoles)}
        // …and an edited seat must render with its model, like every other seat. annotateRoleModels
        // runs BEFORE this gate, so a role added here would otherwise show as a bare name.
        roleModel={name => effectiveModel(props.agentModels.find(a => a.agentType === name), props.mainModel)}
        onEdited={() => { terminalEdited.current = true }}
        // spec §8:非 git 仓库时「允许选择『改用共享工作目录串行执行』降级(**或初始化 git**)」。
        // 降级本身一直是自动发生的;这两个 prop 才让它成为一个"选择"。
        isolationReason={isolationReason ?? undefined}
        // 开跑之前就说。用户报过两次这条,两次都是先烧掉一次运行才发现。
        searchReason={searchUnavailableReason()}
        onInitGit={canInitGit ? () => { void initGitAndRetry() } : undefined}
        onDecision={d => terminalClaim.current?.('terminal', d)}
      />
    )
  }
  if (phase === 'drafting') {
    return (
      <MessageView
        title="高效任务模式 · 第三关"
        body={`${redrafts > 0 ? '正在按你的意见重拟根方案与首层任务树…' : '正在起草根方案与首层任务树…'}(已等待 ${waitedSec}s)`}
        tone="dim"
        onDismiss={bail}
        log={preStreams()}
        columns={termColumns}
      />
    )
  }
  if (phase === 'confirmRoot') {
    return (
      <ConfirmRootPlan
        goalPrompt={config.goalPrompt}
        // EMPTY_DRAFT only ever renders alongside draftError, which says why it is empty.
        draft={draft ?? EMPTY_DRAFT}
        drafted={draft !== null}
        reviewRoles={config.phaseRoles.review.length}
        draftError={draftError}
        redrafts={redrafts}
        onDecision={onRootDecision}
      />
    )
  }
  if (phase === 'confirmRedo' && redoTarget) {
    return (
      <ConfirmRedo
        nodes={nodes}
        targetId={redoTarget.id}
        now={new Date().toISOString()}
        // 环节实况从**目标节点自己的名册**里来,不是写死的文案、也不是 run 配置 ——
        // 否则默认配置下关口会承诺一个根本不存在的测试验证环节,而拿 config 去算又会
        // 承诺一个**这个节点上**不存在的环节(applyRosterToNodes 的第一句就是
        // `if (n.status === 'ACCEPTED') continue`,而重做目标绝大多数正是 ACCEPTED)。
        //
        // 这一句原来是就地展开的 `Object.fromEntries(PHASE_NAMES.map(…))`,而 PHASE_NAMES
        // **没有被导入**(第 35 行的值导入里没它,第 36 行是 import type,编译期就擦掉了)。
        // 仓库没有 typecheck,于是它一路过了打包 —— 按下 r 就是一屏 ReferenceError,
        // 而重做这个功能从任何路径都到不了。搬进 redo.ts 是为了让它有接缝可测。
        phases={phaseCtxOf(redoTarget, config)}
        // 「快速重做失败环节」预选的那一条 —— 给了就直接停在确认屏上。仍然要过确认屏:
        // 失败在分析环节的拆分型节点,它的入口是「任务重做」,而那一条会删掉整棵子树。
        initialEntry={redoEntry ?? undefined}
        onConfirm={(entry, guidance) => applyRedo(redoTarget, entry, guidance)}
        // 取消要回**它来的那一屏**。写死 done 的话,运行中按 r 又按 Esc,run 还在跑而
        // 界面已经变成结束屏 —— 树不再更新,p / i / x 三个干预键一起消失,什么都没出错。
        onCancel={() => { setRedoTarget(null); setRedoEntry(null); setPhase(redoFrom) }}
      />
    )
  }
  if (phase === 'confirmSkip' && skipTarget) {
    return (
      <ConfirmSkip
        nodes={nodes}
        targetId={skipTarget.id}
        now={new Date().toISOString()}
        // 和重做关口同一份环节实况(也就是 applySkip 真正会用的那一份)—— 两边各算一次的话,
        // 屏幕上算出来的后果和实际发生的可以不一样。
        phases={phaseCtxOf(skipTarget, config)}
        onConfirm={guidance => applySkip(skipTarget, guidance)}
        onCancel={() => { setSkipTarget(null); setPhase(redoFrom) }}
      />
    )
  }
  if (phase === 'confirmForcePass' && forcePassTarget) {
    return (
      <ConfirmForcePass
        nodes={nodes}
        targetId={forcePassTarget.id}
        now={new Date().toISOString()}
        // 同一份环节实况(也就是 applyForcePass 真正会用的那一份)——
        // 两边各算一次的话,屏幕上算出来的后果和实际发生的可以不一样。
        phases={phaseCtxOf(forcePassTarget, config)}
        /**
         * 预先批准。**只在这个关口是从 running 进来的时候给** —— 结束之后没有编排器会
         * 再走到那个环节,给了就是一个按下去什么都不会发生的选项。关口自己也会用节点
         * 状态判一次(见它的 `blocked`),这里是把「有没有人在听」这一半交代清楚。
         */
        onPreApprove={forcePassFrom === 'running'
          ? p => {
            control.forcePass(forcePassTarget.id, p)
            setForcePassTarget(null)
            setPhase('running')
          }
          : undefined}
        onConfirm={guidance => { setPhase(forcePassFrom); applyForcePass(forcePassTarget, guidance) }}
        onCancel={() => { setForcePassTarget(null); setPhase(forcePassFrom) }}
      />
    )
  }
  if (phase === 'confirmCleanup' && cleanupTarget) {
    /**
     * 回收已完成任务的隔离工作区。**这一屏不重启编排、不改任务树** —— 它唯一改变的是
     * 磁盘上那些目录还在不在,所以确认完原样回到来时那一屏(运行中按的就回运行视图)。
     *
     * 判据和动作全在 `cleanupWorktrees.ts`(那里能被真 git 测出来);这里只接线。
     * 池子缺席时**在扫描里如实报错**,而不是渲染一屏空清单 —— 后者会让用户以为
     * 「已经没有可清的了」,而真相是这一趟根本没用隔离工作区。
     */
    const deps = cleanupDeps()
    const noPool = (): never => {
      throw new Error(poolRef.current
        ? '这次运行的记录目录还没建立,拿不到要写回的 node.md'
        : '这一趟没有使用隔离工作区(共享工作目录运行),没有可以回收的目录')
    }
    return (
      <ConfirmCleanup
        target={cleanupTarget}
        onScan={() => (deps ? scanCleanup(deps, nodes, cleanupTarget.id) : noPool())}
        onRun={async plan => {
          if (!deps) return noPool()
          const out = await runCleanup(deps, plan, nodes)
          // `runCleanup` 是**就地**清掉 node.worktree 的(界面和编排器持有的是同一批
          // 节点对象),所以这里只要推一份新数组让 React 重画。
          if (out.removed.length > 0) setNodes([...nodes])
          return out
        }}
        onDone={() => { setCleanupTarget(null); setPhase(cleanupFrom) }}
        onCancel={() => { setCleanupTarget(null); setPhase(cleanupFrom) }}
      />
    )
  }
  if (phase === 'confirmRecalc' && recalcTarget) {
    /**
     * 依赖重算。**只从运行视图进来**,而且只在准入已经过了、真要发起模型调用的时候 ——
     * 准入被拒时不切屏(理由渲染在详情页里),因为切屏会把任务树连同详情页整棵卸载。
     *
     * 判据全在 `depsRecalc.ts`(纯函数),顺序全在 `depsRecalcRun.ts`;这里只接线。
     */
    const target = recalcTarget
    /**
     * **取编排器那一份树,不是 React 快照。**
     *
     * 「应用那一刻再量一遍假 ACCEPTED」防的正是 `growTree` 的 await 交错 —— 而新挂上的
     * 子节点要等下一次 `onUpdate` 才进 React state,拿快照去量会 fail-open。
     * 编排器不在(结束了)时才退回快照,那条路上 apply 本来也会被拒。
     */
    const byId = (): Map<string, TaskNode> =>
      new Map((orchRef.current?.nodes() ?? nodes).map(n => [n.id, n] as [string, TaskNode]))
    const scopeOpts = (): Parameters<typeof recalcScope>[2] => ({
      running: new Set(orchRef.current?.runningNodeIds() ?? []),
      cancelled: control.wasCancelled(target.id),
      finished: orchRef.current === null,
    })
    return (
      <ConfirmRecalcDeps
        target={target}
        // 实时输出窗。少了它,`asking` 那几分钟里「卡住了」和「正常跑」长得一模一样。
        streams={streams.current.streams(target.id)}
        columns={undefined}
        resolveNode={id => nodes.find(n => n.id === id)}
        onAsk={async (): Promise<RecalcAsk> => {
          const scope = recalcScope(target, byId(), scopeOpts())
          // 到这一步还被拒,说明树在按键和这一屏之间变了 —— 如实说,别端一屏空清单。
          if (scope.ok !== true) return { ok: false, kind: 'call-failed', reason: scope.reason }
          /**
           * 每次调用一个 controller,并且 **chain 到 run 级 signal**:run 被中止时这一次
           * 也要跟着停,而反过来 Esc 只停这一次。
           */
          const ac = new AbortController()
          recalcAbort.current = ac
          const onRunAbort = (): void => ac.abort()
          props.signal.addEventListener('abort', onRunAbort, { once: true })
          try {
            return await askRecalc(target, scope, {
              byId,
              runAgent: a => props.runRecalcAgent(a),
              /**
               * `open` 收的是一个 **StreamMeta 对象**。原来这里传的是两个位置参数,
               * 于是 `nodeId` 是那个对象、`meta.nodeId` 是 undefined —— 流挂在
               * `undefined` 上,而详情页按 `streams(nodeId)` 取,永远取不到它。
               * 一次分钟级、用户自己掏钱的调用,屏幕上只有一个秒数在跳。
               */
              openStream: () => streams.current.open({
                // 不 pinned:pinned 是给**树外**那几条流(需求解析 / 根方案)留的,它们没有
                // 归属节点、不钉住就是第一批被淘汰的。这一条挂在真节点上,按节点取得到。
                nodeId: target.id, phaseLabel: '依赖重算', label: '主模型',
              }),
            }, ac.signal)
          } finally {
            props.signal.removeEventListener('abort', onRunAbort)
            recalcAbort.current = null
          }
        }}
        onApply={async (plan: RecalcPlan): Promise<RecalcApply> => {
          const orch = orchRef.current
          const dir = runDir
          if (!orch || !dir) {
            return {
              ok: false, diskChanged: false,
              reason: '本次编排已经结束,依赖重算需要编排器还在跑 —— /et --resume 继续之后这个键就回来了。',
            }
          }
          const out = await applyRecalc(target, plan, {
            byId,
            now: () => new Date().toISOString(),
            persist: n => writeNodeFile(props.fs, dir, n),
            /**
             * `hold` 的拒绝原文写的是「这次**重做**要走**结束屏**那条路」——
             * 用户按的是 d,而结束屏根本不提供这个键(字面意义的死胡同)。套一层措辞。
             */
            hold: ids => {
              const h = orch.hold(ids)
              return h.ok
                ? h
                : { ok: false, reason: '这个任务此刻没法被扣住(多半正在运行,或本次编排刚结束)—— 依赖未改动。' }
            },
            depsChanged: id => orch.depsChanged(id),
            scopeOpts,
          })
          if (out.ok) setNodes([...nodes])
          return out
        }}
        onCancelAsk={() => {
          /**
           * **先推一行,再 abort。** `runAgentAdapter` 判「窗口该收成什么颜色」用的是
           * `control.wasCancelled(node.id)`,而这条缝**没有 control**(取消走的是每次
           * 调用自己的 controller)—— abort 不会让那个判据为真,窗口会收在绿色的
           * 「已完成」上。让它自己说一句话是唯一够得着的办法。
           *
           * 绝不调 `control.cancelNode`:那会给节点置上**永久**的取消标记,而重算的准入
           * 从此拒绝它、pickBatch 也永远不选它 —— 在这一屏按一次 Esc 会把这个任务从整趟
           * run 里除名。
           */
          try { streams.current.streams(target.id).at(-1) } catch { /* 只是取一眼 */ }
          recalcAbort.current?.abort()
        }}
        onDone={() => { setRecalcTarget(null); setPhase('running') }}
      />
    )
  }
  if (phase === 'running' && directiveOpen) {
    return (
      <AddDirective
        // 权限对话框画在它之上时键盘归对话框 —— 否则一下回车既提交指令又批准工具。
        isActive={!humanWait.waiting}
        // 丢弃说明行不算「补过的一条」,否则 25 条会报成 21。
        existing={control.directives().filter(d => !d.startsWith('(较早的')).length}
        onSubmit={t => { control.addDirective(t); setDirectiveOpen(false) }}
        onCancel={() => setDirectiveOpen(false)}
      />
    )
  }
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={runId ?? ''} streams={streams.current} pool={poolRead.current ?? undefined} onAbort={props.abort} suspended={humanWait.waiting} serialExecute={poolRef.current === undefined}
      /**
       * 运行中按 f = 预先批准。**不在这里判能不能** —— 关口自己会按节点状态和本次配置
       * 算出可选的环节并逐条说明原因,而在这儿再判一次就是第二份判据。
       */
      onForcePass={node => { setForcePassTarget(node); setForcePassFrom('running'); setPhase('confirmForcePass') }}
      /**
       * 运行中的重做三键。**别的任务照常跑** —— 确认之后新树是被并进正在跑的那一棵,
       * 不是另起一个编排器(见 redoDeps 的 `from` 和 orchestrator.applyLive)。
       *
       * 这里只挡一件事:**目标节点自己正在跑**。那种情形下重做要先把它停下来,而替用户
       * 决定「砍掉它正在飞的调用」不是这个键该做的事 —— 说清楚让他按 x。剩下的判断
       * (这个环节能不能重入、会删掉几个子任务)照旧归关口和 failedRedoTarget。
       */
      onRedo={node => {
        const why = liveRedoUnavailableReason({
          running: orchRef.current !== null,
          nodeRunning: orchRef.current?.runningNodeIds().includes(node.id) === true,
          title: node.title,
        })
        if (why) { setRedoProblems([why]); return }
        setRedoTarget(node); setRedoEntry(null); setRedoFrom('running'); setPhase('confirmRedo')
      }}
      onRedoFailed={node => {
        const why = liveRedoUnavailableReason({
          running: orchRef.current !== null,
          nodeRunning: orchRef.current?.runningNodeIds().includes(node.id) === true,
          title: node.title,
        })
        if (why) { setRedoProblems([why]); return }
        const byId = new Map(nodes.map(n => [n.id, n]))
        const found = failedRedoTarget(node, byId, config ? phaseCtxOf(node, config) : undefined)
        if ('error' in found) { setRedoProblems([found.error]); return }
        setRedoTarget(node); setRedoEntry(found.entry); setRedoFrom('running'); setPhase('confirmRedo')
      }}
      onSkipFailed={node => {
        const why = liveRedoUnavailableReason({
          running: orchRef.current !== null,
          nodeRunning: orchRef.current?.runningNodeIds().includes(node.id) === true,
          title: node.title,
        })
        if (why) { setRedoProblems([why]); return }
        const blocked = skipFailedPhaseReason(node, config ? phaseCtxOf(node, config) : undefined)
        if (blocked) { setRedoProblems([blocked]); return }
        setSkipTarget(node); setRedoFrom('running'); setPhase('confirmSkip')
      }}
      /**
       * 运行中也能清 —— 而且这正是最需要它的时刻:一棵跑三小时的树,前十个子任务的
       * `target/` 早就把盘吃满了,而它们全都已经验收完、产出也早已合进集成分支。
       *
       * 这里**不挡任何东西**:范围只认 ACCEPTED,而在飞的节点按定义不是终态,关口自己
       * 会把「跳过 N 个还没验收的任务」写在屏幕上。
       */
      onCleanupWorktrees={poolRef.current ? node => {
        setCleanupTarget(node); setCleanupFrom('running'); setPhase('confirmCleanup')
      } : undefined}
      /**
       * 依赖重算(`d`)。**只在运行视图接线** —— 它要 hold 住节点、还要叫醒调度,
       * 而结束屏没有编排器可以做这两件事。
       *
       * 返回一句话 = 准入没过,**不切屏**:那五条判据全是同步内存读,而切屏会把这个面板
       * 连同详情页整棵卸载,用户展开到哪一段、读到第几行全没了 ——「什么都没发生」不该
       * 长成「你的阅读位置没了」。返回 undefined = 真要去调模型了,这里才切。
       */
      /**
       * 提示写不写,由**真正的准入**回答(不是 status === 'CREATED')。同一个 recalcScope,
       * 所以屏幕上写着的和按下去发生的不可能分叉。
       */
      recalcAvailable={node => recalcScope(node, new Map(nodes.map(n => [n.id, n] as [string, TaskNode])), {
        running: new Set(orchRef.current?.runningNodeIds() ?? []),
        cancelled: control.wasCancelled(node.id),
        finished: orchRef.current === null,
      }).ok === true}
      onRecalcDeps={node => {
        const why = recalcScope(node, new Map(nodes.map(n => [n.id, n] as [string, TaskNode])), {
          running: new Set(orchRef.current?.runningNodeIds() ?? []),
          cancelled: control.wasCancelled(node.id),
          finished: orchRef.current === null,
        })
        if (why.ok !== true) {
          return [why.reason, ...why.details.map(d => `· ${d}`)].join('\n')
        }
        setRecalcTarget(node)
        setPhase('confirmRecalc')
        return undefined
      }}
      runControl={{
        paused,
        // 真相在 control 里,state 只是让提示行重绘 —— 两边分开的话它们迟早不一致,
        // 而不一致的那一次用户会以为自己暂停成功了。
        onTogglePause: () => {
          if (control.isPaused()) control.resume()
          else control.pause()
          setPaused(control.isPaused())
        },
        onAddDirective: () => setDirectiveOpen(true),
        onCancelNode: n => control.cancelNode(n.id),
        /**
         * 调并发上限。**基准取 control 现在的值,没调过才回落到关口批准的那个** ——
         * 一直拿 config 当基准的话,连按两次 `+` 会得到 6、6 而不是 6、7。
         *
         * 夹取交给 `control.setParallelism`(一份真相),这里不重复算一遍。
         */
        onAdjustParallelism: d => {
          const cur = control.parallelism() ?? config.parallelism
          control.setParallelism(cur + d)
          setParallelismTick(t => t + 1)
        },
        /**
         * 调严格度。基准取 control 现在的值,没调过才回落到关口批准的那一档 ——
         * 和并发度那一条逐字同因(一直拿 config 当基准的话,连按两次只会跳一级)。
         *
         * 阶梯与「不设」的关系交给 `adjustStrictness`(一份真相),这里不重复算。
         */
        onAdjustStrictness: d => {
          const cur = control.strictness() ?? config.caps.strictness
          control.setStrictness(adjustStrictness(cur, d))
          // control 不是 React state,不 tick 的话改完屏幕不动 —— 和并发度同一个坑。
          setParallelismTick(t => t + 1)
        },
        strictness: control.strictness() ?? config.caps.strictness,
      }}
    />
  }
  return (
    <DoneView
      nodes={nodes} runId={runId ?? ''} streams={streams.current} outcome={outcome}
      handoff={handoff} handoffResult={handoffResult} handoffState={handoffState}
      viewOnly={viewOnly} onExit={props.onExit}
      redoProblems={redoProblems}
      // 只查看模式下不给重做:那个 run 的编排器根本没起来过,重做等于**替用户决定**
      // 把它跑起来 —— 而他刚刚明确选了不跑。
      onRedo={viewOnly ? undefined : node => {
        // 中断过的 run 在这里重做会立刻再次阻断(见 redoUnavailableReason)。
        // 挡在**按键这一刻**,而不是让他选完环节、看完后果、确认完再看一遍失败。
        const why = redoUnavailableReason({ aborted: props.signal.aborted, runId: runId ?? undefined })
        if (why) { setRedoProblems([why]); return }
        setRedoTarget(node); setRedoEntry(null); setRedoFrom('done'); setPhase('confirmRedo')
      }}
      /**
       * 快速重做失败的那个环节(`R`)。
       *
       * 两道闸门,顺序有讲究:先判「这一次能不能重做」(中断过的 run 一律不行),再判
       * 「这个节点的失败环节能不能重入」。反过来的话,一个中断过的 run 上的失败节点会先
       * 得到一句关于环节的解释,而真正的障碍是那个进程级的中断标记。
       */
      onRedoFailed={viewOnly ? undefined : node => {
        const why = redoUnavailableReason({ aborted: props.signal.aborted, runId: runId ?? undefined })
        if (why) { setRedoProblems([why]); return }
        const byId = new Map(nodes.map(n => [n.id, n]))
        const found = failedRedoTarget(node, byId, config ? phaseCtxOf(node, config) : undefined)
        // 拿不到就**说原因**,而不是把用户送进一屏什么都按不动的关口。
        if ('error' in found) { setRedoProblems([found.error]); return }
        setRedoTarget(node); setRedoEntry(found.entry); setRedoFrom('done'); setPhase('confirmRedo')
      }}
      /** 跳过失败的那个环节继续往下走(`s`)。同样两道闸门,同样的顺序。 */
      onSkipFailed={viewOnly ? undefined : node => {
        const why = redoUnavailableReason({ aborted: props.signal.aborted, runId: runId ?? undefined })
        if (why) { setRedoProblems([why]); return }
        const blocked = skipFailedPhaseReason(node, config ? phaseCtxOf(node, config) : undefined)
        if (blocked) { setRedoProblems([blocked]); return }
        setSkipTarget(node); setRedoFrom('done'); setPhase('confirmSkip')
      }}
      /**
       * 强制通过失败的那个环节(`f`)。闸门和 `s` 逐字相同(它们共用一份实现),
       * 顺序也一样:先判这一次能不能重开编排,再判这个环节能不能被放行。
       */
      onForcePass={viewOnly ? undefined : node => {
        const why = redoUnavailableReason({ aborted: props.signal.aborted, runId: runId ?? undefined })
        if (why) { setRedoProblems([why]); return }
        const blocked = forcePassFailedPhaseReason(node, config ? phaseCtxOf(node, config) : undefined)
        if (blocked) { setRedoProblems([blocked]); return }
        setForcePassTarget(node); setForcePassFrom('done'); setPhase('confirmForcePass')
      }}
      /**
       * 回收已完成任务的隔离工作区(`c`)。
       *
       * **`viewOnly` 也给** —— 和上面那四个键不同。它们都会重开一次编排(而用户刚刚明确
       * 选了不跑这个 run),这一个不动任务树、不派任何模型调用,只是删掉一堆已经没用的
       * 目录。「只查看」进来的人恰恰是来收拾旧 run 的那个人。
       */
      onCleanupWorktrees={poolRef.current ? node => {
        setCleanupTarget(node); setCleanupFrom('done'); setPhase('confirmCleanup')
      } : undefined}
    />
  )
}

/** A one-line status/error screen that can always be dismissed. */
function MessageView(props: {
  title: string; body: string; tone: 'error' | 'dim'; onDismiss: () => void
  /** 等待期间这一屏背后跑着的模型调用。只读:回车/q/Esc 归这一屏自己。 */
  log?: readonly StreamState[]
  columns?: number
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return || key.escape || input.toLowerCase() === 'q') props.onDismiss()
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{props.title}</Text>
      <Text color={props.tone === 'error' ? 'error' : undefined} dimColor={props.tone === 'dim'}>{props.body}</Text>
      {props.log && props.log.length > 0 ? (
        <AgentLogPane streams={props.log} height={10} width={props.columns ?? 100} isActive />
      ) : null}
      <Text dimColor>回车 / q / Esc 退出</Text>
    </Box>
  )
}

// 'parsing' phase: the extraction model call is in flight. Esc/q must work here too.
function ParsingView(props: { onCancel: () => void; log?: readonly StreamState[]; columns?: number; waited?: number }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') props.onCancel()
  })
  return (
    <Box flexDirection="column">
      <Text dimColor>正在解析需求…{props.waited !== undefined ? `(已等待 ${props.waited}s)` : ''}</Text>
      {/* 这一屏是用户敲完 /et 看到的**第一屏**,背后是一次真实的模型调用。 */}
      {props.log && props.log.length > 0 ? (
        <AgentLogPane streams={props.log} height={8} width={props.columns ?? 100} isActive />
      ) : null}
      <Text dimColor>Esc/q 取消</Text>
    </Box>
  )
}

// 'running' phase: live tree + an interrupt affordance. Esc/q aborts the controller the
// command owns; the orchestrator then returns {status:'blocked', reason:'已中断'} and the
// finally-block flips us to 'done'.
// EXPORTED for testing. The three §10.2 hops that live in this file — creating the store,
// pushing into it, and handing it to each panel — are exactly the shape of wire this repo has
// cut twice, and nothing else here is importable by a test.
export function RunningView(props: {
  nodes: TaskNode[]; runId: string; streams?: StreamStore
  pool?: () => { inUse: number; limit: number }
  onAbort: () => void; suspended?: boolean; serialExecute?: boolean
  /** 运行中的人工干预:暂停 / 追加指令 / 取消单个节点。 */
  runControl?: React.ComponentProps<typeof TaskTreePanel>['runControl']
  /**
   * 给了才有 `f` 键(运行中预先批准某个环节)。
   *
   * 和 runControl 分开传:那三个键当场就生效,而这一个要先弹一屏让用户选环节并看后果 ——
   * 它的落点是 `setPhase('confirmForcePass')`,不是一个即时动作。
   */
  onForcePass?: (node: TaskNode) => void
  /**
   * 运行中的重做三键(`r` 任务/阶段重做、`R` 快速重做失败环节、`s` 跳过失败环节)。
   *
   * 用户原话:「任务失败了,不需要整体返回失败才能重做任务或阶段,在其它任务还在运行时
   * 就可以重做。」在这之前这三个键**只挂在结束屏上** —— 一个节点在第三分钟失败,用户要
   * 等整棵树跑完、拿到一个 blocked,才能去动它。
   *
   * 和 `onForcePass` 一样是「弹一屏关口」而不是即时动作,所以和 runControl 分开传。
   */
  onRedo?: (node: TaskNode) => void
  onRedoFailed?: (node: TaskNode) => void
  onSkipFailed?: (node: TaskNode) => void
  /**
   * 详情页的 `c` 键:回收这棵子树里已验收任务的隔离工作区。
   *
   * 给了才有这个键 —— 共享工作树运行时没有池子,也就没有任何目录可清。
   */
  onCleanupWorktrees?: (node: TaskNode) => void
  /**
   * 依赖重算(详情页 d 键)。**只有运行视图有** —— 它要 hold 住节点、还要叫醒调度,
   * 而结束屏没有编排器可以做这两件事。回一句话 = 准入没过、不切屏;undefined = 去调模型。
   */
  onRecalcDeps?: (node: TaskNode) => string | undefined
  /** 「按 d 重算」那行提示写不写 —— 走真正的准入,见 TaskTreePanel.recalcAvailable。 */
  recalcAvailable?: (node: TaskNode) => boolean
}): React.ReactElement {
  // NO useInput here. TaskTreePanel is interactive and installs its own handler; a second one
  // would ALSO receive every key, so ↑↓ would scroll the tree *and* Esc would mean two
  // different things at once (abort the run vs leave the detail view). The panel owns the
  // keyboard and calls back for exit.
  // suspended:权限对话框画在面板**之上**(spawnsSubagents ⇒ shouldContinueAnimation),
  // 两个组件同时挂着而 useInput 是广播的 —— 不让位的话,一下回车既批准工具又打开详情页。
  return <TaskTreePanel nodes={props.nodes} runId={props.runId} interactive suspended={props.suspended} serialExecute={props.serialExecute} runControl={props.runControl} onForcePass={props.onForcePass} onRedo={props.onRedo} onRedoFailed={props.onRedoFailed} onSkipFailed={props.onSkipFailed} onCleanupWorktrees={props.onCleanupWorktrees} onRecalcDeps={props.onRecalcDeps} recalcAvailable={props.recalcAvailable} streams={props.streams} pool={props.pool} onExitKey={props.onAbort} />
}

// 'done' phase: read-only tree + terminal summary (completed/blocked + reason) + exit key.
export function DoneView(props: {
  nodes: TaskNode[]
  runId: string
  streams?: StreamStore
  outcome: Outcome | null
  handoff: HandoffSummary | null
  /**
   * 刚刚那次收口动作的结果。
   *
   * 必须显示:合并冲突、脏工作区、推送失败之后如果只是安静地回到 done,用户会以为
   * 成功了 —— 而代码根本不在他的分支上。这是这个功能最不能出的错。
   */
  handoffResult?: HandoffResult | null
  /** 收口结局(已合并 / 撞冲突留下半合并)—— 决定这一屏那两句话怎么写(见 handoffLines)。 */
  handoffState?: HandoffState
  /**
   * 仅查看后退出 (spec §17.3): this view is doubling as a read-only browser for a run the user
   * chose NOT to continue. Nothing ran, so the summary must not say 被阻断 — that would report
   * a failure the user's own keystroke caused, about a run that is still perfectly resumable.
   */
  viewOnly?: boolean
  /** 上一次重做**没做成**的事。空 = 干净;非空必须显示,每条都是会自己长回来的问题。 */
  redoProblems?: string[]
  /** 给了才有 r 键。 */
  onRedo?: (node: TaskNode) => void
  /** 给了才有 R 键(快速重做失败的那个环节)。 */
  onRedoFailed?: (node: TaskNode) => void
  /** 给了才有 s 键(跳过失败的那个环节继续往下走)。 */
  onSkipFailed?: (node: TaskNode) => void
  /** 给了才有 f 键(强制通过失败的那个环节,并留下一条人工裁决)。 */
  onForcePass?: (node: TaskNode) => void
  /** 给了才有 c 键(回收这棵子树里已验收任务的隔离工作区)。 */
  onCleanupWorktrees?: (node: TaskNode) => void
  onExit: (outcome: Outcome | null) => void
}): React.ReactElement {
  // Same rule as RunningView: one keyboard owner. Enter used to exit here, but it now opens a
  // node's detail — the run is over, so reading the tree matters more than leaving it fast.
  const ok = props.outcome?.status === 'completed'
  const handoff = props.handoff ? handoffLines(props.handoff, props.runId, props.handoffState) : []
  // 一次算好,两处用(占几行 / 画什么)—— 两处各算一次的话,它们迟早会不一致,
  // 而不一致的后果是详情页最底下那条页签条被顶出屏幕。
  const runSpan = runSpanLine(props.nodes, Date.now())
  const summaryRows = doneSummaryRows({
    viewOnly: props.viewOnly === true,
    hasRunSpan: runSpan.length > 0,
    hasReason: Boolean(props.outcome?.reason),
    hasHandoffResult: Boolean(props.handoffResult),
    followUps: props.handoffResult?.followUps?.length ?? 0,
    handoffLines: handoff.length,
    redoProblems: props.redoProblems?.length ?? 0,
  })
  return (
    <Box flexDirection="column">
      <TaskTreePanel
        nodes={props.nodes}
        runId={props.runId}
        interactive
        reservedRows={summaryRows}
        // "完成后保留最终输出" — the buffer outlives the run, so the done view keeps it.
        streams={props.streams}
        onRedo={props.onRedo}
        onRedoFailed={props.onRedoFailed}
        onSkipFailed={props.onSkipFailed}
        onForcePass={props.onForcePass}
        onCleanupWorktrees={props.onCleanupWorktrees}
        onExitKey={() => props.onExit(props.outcome)}
      />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={props.viewOnly ? 'warning' : ok ? 'success' : 'error'}>
          {props.viewOnly ? '仅查看:本次没有继续执行' : ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}
        </Text>
        {/* 这一趟是什么时候的事、跑了多久。排在结论下面第一行:一个隔天回来看的人,
            第一个要确认的就是屏幕上这棵树是不是刚才那一次。节点和阶段各自的时刻在
            详情页里(时间线那一段)。 */}
        {runSpan ? <Text dimColor>{runSpan}</Text> : null}
        {props.viewOnly
          ? <Text dimColor>这个 run 原样留在盘上,想继续跑: /et --resume {props.runId}</Text>
          : null}
        {!props.viewOnly && props.outcome?.reason ? <Text dimColor>原因: {props.outcome.reason}</Text> : null}
        {/* 收口结果排在最前:失败的话它是这一屏最重要的一行。用颜色区分,而不是让一条
            「合并失败」和一堆灰色说明混在一起。 */}
        {props.handoffResult
          ? <Text color={props.handoffResult.ok ? 'success' : 'error'}>{props.handoffResult.message}</Text>
          : null}
        {props.handoffResult?.followUps?.map(l => <Text key={l} dimColor>{l}</Text>) ?? null}
        {handoff.map(l => <Text key={l} dimColor>{l}</Text>)}
        {props.redoProblems?.map(l => <Text key={l} color="warning">⚠ {l}</Text>) ?? null}
        <Text dimColor>
          {/* 失败节点专属的那两个键**不在这里写** —— 它们只对 BLOCKED 节点有意义,
              而这一行不知道光标停在哪。树自己的页脚按光标所在的行写它们(见
              TaskTreePanel 的 failedKeysHint),那是唯一知道该不该写的地方。 */}
          q / Esc 退出 · 回车看节点详情{props.onRedo ? ' · r 重做选中的任务' : ''}
        </Text>
      </Box>
    </Box>
  )
}

