import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { access, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Tools } from '../../Tool.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { collectRoleDefs, collectSkipSteps, mergeSkipSteps } from '../../tools/efftask/roleDefsFromSettings.js'
import type { RoleDef } from '../../tools/efftask/roleDefs.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { searchUnavailableReason } from '../../utils/ripgrep.js'
import { runOrchestrator, type Outcome, type Phase } from './runOrchestrator.js'
import { createWorktreePool, type GitRunner, type WorktreePool } from '../../tools/efftask/worktreePool.js'
import { spawn } from 'node:child_process'
import { annotateRoleModels, effectiveModel, type AgentModelInfo } from '../../tools/efftask/roleModels.js'
import { loadRun, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import { redoUnavailableReason, type RedoEntry } from '../../tools/efftask/redo.js'
import { commitRedo } from '../../tools/efftask/redoCommit.js'
import { runRedo } from '../../tools/efftask/redoRun.js'
import { ConfirmHandoff } from './ConfirmHandoff.js'
import { runHandoffChoice, type HandoffChoice, type HandoffResult } from '../../tools/efftask/handoffActions.js'
import type { PendingHandoff } from '../../tools/efftask/types.js'
import { parseResumeArgs, type ResumeArgs } from '../../tools/efftask/parseResumeArgs.js'
import { readRunManifest, validateLoadedNodes } from '../../tools/efftask/resumeCore.js'
import { reseatTransientNodes } from '../../tools/efftask/reseat.js'
import { acquireRunLock, listRuns, releaseRunLock, reserveRun, type RunSummary } from '../../tools/efftask/runRegistry.js'
import { ConfirmRedo } from './ConfirmRedo.js'
import { ConfirmResume } from './ConfirmResume.js'
import { ResumePicker } from './ResumePicker.js'
import { createNode, emptyPhaseRoles, emptyPlan, DEFAULT_CAPS, MAX_RECORDED_REPAIRS } from '../../tools/efftask/types.js'
import type { EffTaskConfig, PhaseName, TaskNode } from '../../tools/efftask/types.js'
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
  applyStartupDecision,
  applyRosterToNodes,
  rosterEquals,
  dispatchableRoles,
  type HandoffSummary,
} from '../../tools/efftask/startupConfirm.js'
import { buildStartupCard, sendFeishuStartupCard } from '../../tools/efftask/feishuStartupCard.js'
import { buildConflictCard } from '../../tools/efftask/conflictEscalation.js'
import { buildBlockCard, createEscalationLimiter } from '../../tools/efftask/escalation.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { countStatuses } from '../../tools/efftask/stateMachine.js'
import { createStreamStore, PRE_TREE_NODE, type StreamHandle, type StreamState, type StreamStore } from '../../tools/efftask/agentStream.js'
import { AgentLogPane, useStreamTick } from './AgentLogPane.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { logError } from '../../utils/log.js'


// Read-only tool pool for plan/review/accept/observer: they must be able to READ the repo
// to judge anything, they just must not be able to WRITE it.
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'

export const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Glob', 'Grep'])

/**
 * 会改盘的工具。非执行环节从会话工具池里**减掉这些**,而不是只放行三件套。
 *
 * 从白名单换成黑名单是有原因的:白名单是 `{Read, Glob, Grep}` 三个写死的名字,于是
 * **所有 `mcp__*` 工具连带被滤掉** —— 用户配了查文档/查数据库的 MCP server,以为
 * 评审员能用,实际只有执行者能用,而且关口上看不出任何迹象。起草者同样只能靠这三个
 * 工具摸黑,复杂仓库里它经常直接说「访问不了文件系统,请你贴代码」。
 *
 * Bash 在这一档里也要减掉:它能写(`echo >`、`sed -i`、`git apply`),测试验证档
 * 单独把它加回去,那一档另有工作区前后比对做闸门。
 *
 * 诚实的边界:**挡不住会写的 MCP 工具** —— 没有可靠办法从名字判断 `mcp__x__y` 是否
 * 只读。放开 MCP 就接受了这一点,所以关口要说出来,让用户自己决定给评审席位配什么。
 */
export const WRITE_CAPABLE_TOOL_NAMES = new Set([
  FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME, BASH_TOOL_NAME,
])

/**
 * 非执行环节的工具池:会话里的一切,减去会改盘的。
 *
 * 提成可导出的纯函数,和 verifyToolPool 同一个理由 —— 接线要能被单独钉住。
 */
export function nonExecuteToolPool<T extends { name: string }>(all: T[]): T[] {
  return all.filter(t => !WRITE_CAPABLE_TOOL_NAMES.has(t.name))
}
/**
 * 测试验证档在只读之上多这些 —— 它得能真的跑测试。
 *
 * 名字必须是本仓库的**规范工具名**:早先写的 'BashOutput' / 'KillShell' 在这里是死名
 * (它们只在 permissionRuleParser 里作为旧别名存在),后果是后台起的 shell 读不到输出、
 * 杀不掉 —— 而 filter 匹配不上不会报错,只会静默少给两个工具。
 */
export const RUN_COMMAND_TOOL_NAMES = new Set([BASH_TOOL_NAME, TASK_OUTPUT_TOOL_NAME, TASK_STOP_TOOL_NAME])

/**
 * 测试验证档的工具池。
 *
 * 提成可导出的纯函数,是因为它此前**整条接线零覆盖**:把它删掉、把 filter 条件删掉、
 * 把 RUN_COMMAND_TOOL_NAMES 清空 —— 三种改法各自都是全套测试全绿,而验证者会静默退回
 * 只读工具、跑不了任何命令,也就是这个环节的全部存在理由没了。
 */
export function verifyToolPool<T extends { name: string }>(all: T[]): T[] {
  return all.filter(t => !WRITE_CAPABLE_TOOL_NAMES.has(t.name) || RUN_COMMAND_TOOL_NAMES.has(t.name))
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
  const canUseTool = context.canUseTool ?? hasPermissionsToUseTool
  const mainModelDefault = pickMainAgentDefinition(allAgents)
  // 非执行环节的池子:会话里的一切,减去会改盘的(含 MCP —— 见 WRITE_CAPABLE_TOOL_NAMES)。
  // 此前是写死的 {Read, Glob, Grep} 白名单,连带把所有 mcp__* 滤掉了。
  const readOnlyTools: Tools = nonExecuteToolPool(context.options.tools)
  const runAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    availableTools: context.options.tools, // execute phase only
    readOnlyTools, // plan / review / accept / integrate / observer
    // 测试验证要真的把测试跑起来,所以在只读之上加执行命令的能力。
    verifyTools: verifyToolPool(context.options.tools),
    activeAgents,
    mainModelDefault,
    // caps.nodeTimeoutMs was declared and never enforced; wall clock was the one unbounded
    // axis left. The extraction seam below gets it too.
    timeoutMs: () => capsRef.nodeTimeoutMs,
    humanTimeoutMs: () => capsRef.humanTimeoutMs,
    // 工具摘要用工具自己的 userFacingName —— 主 REPL 每一行工具调用就是这么渲染的。
    // 接上它,以后新增的工具自动有好摘要,不用回来改那张静态表。
    briefResolver: (name, input) => {
      const t = context.options.tools.find(x => x.name === name) as
        | { userFacingName?: (i: unknown) => string } | undefined
      try { return t?.userFacingName?.(input) } catch { return undefined }
    },
  })
  // Separate NO-TOOLS seam for the one-shot config extraction: it only rewrites text into
  // JSON, so it needs neither read nor write tools. This is the ONLY place that passes [].
  const extractAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    availableTools: [],
    readOnlyTools: [],
    activeAgents,
    mainModelDefault,
    timeoutMs: () => capsRef.nodeTimeoutMs,
    humanTimeoutMs: () => capsRef.humanTimeoutMs,
  })

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
  // Set when the view is torn down rather than exited, so the report can tell the two apart.
  let tornDown = false
  // The handoff, in call()'s OWN scope. onExit runs here, and it used to read `handoffRef` —
  // which is declared inside the component, not here — so every exit with a run id threw
  // ReferenceError from inside a .then(), onDone was never called, and processSlashCommand's
  // promise stayed pending forever.
  const handoffOut: { current: HandoffSummary | null } = { current: null }
  // Same shape, same reason: onExit runs in THIS scope and must be able to report how many
  // escalation cards were dropped.
  const cardLimitOut: { current: number } = { current: 0 }
  return (
    <EffTaskRunner
      args={args}
      knownRoles={knownRoles}
      unsupportedRoles={unsupportedRoles}
      // settings.json 里配好的角色定义。读在这里而不是 parseDirectives 里面,是因为那个
      // 文件是纯函数、不碰全局状态,整套解析/合并/展平才能不搭环境地测。
      baseRoleDefs={collectedRoles.defs}
      baseRoleNotices={[...collectedRoles.notices, ...collectedSkip.notices]}
      baseSkipSteps={collectedSkip.steps}
      mcpToolNames={context.options.tools.filter(t => t.name.startsWith('mcp__')).map(t => t.name)}
      // The roster must say which model each seat runs on, and that answer lives in the
      // agent definitions + the session model — neither of which parseDirectives can see.
      agentModels={activeAgents}
      mainModel={context.options.mainLoopModel}
      extractJson={(prompt, stream) => extractAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal, stream })}
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
      cardLimitOut={cardLimitOut}
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
            exitReportLine({ runId, how, resumed, withPath, handoff: handoffOut.current }) + suppressed,
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
 * Build the isolation pool, or report why the run has to share the working tree.
 *
 * Availability is decided ONCE, here, and never re-decided mid-run: a per-node fallback would
 * mean some executors write to the user's checkout while the gate said the run was isolated.
 * When init fails the pool is simply absent, and stepExecute then has nothing to gate on —
 * the run is honestly un-isolated and says so at the confirmation gate.
 */
async function makeWorktreePool(
  runId: string, cwd: string,
): Promise<{ pool?: WorktreePool; reason?: string; notARepo?: boolean }> {
  const top = await gitRunner(['rev-parse', '--show-toplevel'], cwd)
  // notARepo is reported SEPARATELY from the reason string because it is the only condition
  // under which offering `git init` is correct. Every other failure below happens AFTER this
  // check succeeded — i.e. the directory already IS a repo (no commits yet, a branch-name
  // conflict, a worktree already checked out elsewhere) — and running `git init` there creates
  // a NESTED repository that shadows the real one. Measured: `git init` inside /repo/sub makes
  // `rev-parse --show-toplevel` answer /repo/sub, and nothing in this codebase ever cleans it up.
  if (top.code !== 0) return { reason: '当前目录不是 git 仓库', notARepo: true }
  const gitRoot = top.stdout.trim()
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
  /** 读配置文件时产生的诊断 —— 必须并进 cfg.notices,否则关口对配置文件里的错误一言不发。 */
  baseRoleNotices?: string[]
  /** settings.json 的 efftaskSkipSteps 指定要跳过的环节;和提示词里说的**取并集**。 */
  baseSkipSteps?: PhaseName[]
  /** 本次会话可用的 MCP 工具名。关口要说清它们在哪些环节可用、以及挡不住什么。 */
  mcpToolNames?: string[]
  unsupportedRoles: string[]
  agentModels: AgentModelInfo[]
  mainModel: string
  /**
   * 需求解析那一次模型调用。第二个参数是它的实时窗口 —— 这一屏是用户敲完 /et
   * 看到的第一屏,此前背后跑着一次真实调用而界面上一个字都没有。
   */
  extractJson: (prompt: string, stream?: StreamHandle) => Promise<string>
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
  /** call()-scoped count of escalation cards the limiter dropped, read by onExit. */
  cardLimitOut: { current: number }
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
  /** 正在被重做的节点(done 视图按 r 选中的那个)。null = 没有重做在进行。 */
  const [redoTarget, setRedoTarget] = React.useState<TaskNode | null>(null)
  /** 上一次重做落盘时**没做成**的那些事。空 = 干净。 */
  const [redoProblems, setRedoProblems] = React.useState<string[]>([])
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

  const { args, knownRoles, unsupportedRoles, extractJson, agentModels, mainModel, baseRoleDefs, baseRoleNotices, baseSkipSteps } = props
  // parseDirectives is a MODEL call. It runs HERE, behind a 正在解析需求… view — never in
  // call(), which would freeze the terminal with no UI while spending tokens.
  React.useEffect(() => {
    if (isResume) return // resume recovers its config from run.md; no model call, no roster overwrite
    let cancelled = false
    const preStream = streams.current.open({ nodeId: PRE_TREE_NODE, phaseLabel: '需求解析', label: '主模型', pinned: true })
    void parseDirectives(args, { knownRoles, unsupportedRoles, baseRoleDefs, modelJson: p => extractJson(p, preStream) })
      // belt & braces: parseDirectives already swallows extraction failures, but a rejection
      // here would otherwise strand the UI on 'parsing' forever. Keep unsupportedRoles here
      // too: dropping it would let a cli-mode role back onto the roster unannounced.
      .catch(() => parseDirectives(args, { knownRoles, unsupportedRoles, baseRoleDefs }))
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
        setCanInitGit(iso.pool ? false : iso.notARepo === true)
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
  }, [args, knownRoles, unsupportedRoles, baseRoleDefs, baseRoleNotices, baseSkipSteps, extractJson, agentModels, mainModel])

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
      const cwd = getCwd()
      const init = await gitRunner(['init'], cwd)
      if (init.code !== 0) {
        setIsolationReason(`git init 失败: ${(init.stderr || init.stdout).trim() || '未知错误'}`)
        return
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
      setCanInitGit(iso.pool ? false : iso.notARepo === true)
    } finally {
      initingGit.current = false
      setInitingGit(false)
    }
  }, [runId])

  const startRun = React.useCallback((cfg: EffTaskConfig, rootSeed?: TaskNode[]): void => {
    setPhase('running')
    // Built at gate time, before the first step: init() creates the integration branch and
    // its worktree, which is real work the user has consented to. A failure is not fatal —
    // the run continues honestly un-isolated.
    const pool = poolRef.current
    void runOrchestrator(
      {
        config: cfg, runDir: runDir!, fs: props.fs, runAgent: props.runAgent,
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
  const applyRedo = React.useCallback((target: TaskNode, entry: RedoEntry): void => {
    const cfg = config
    if (!cfg || !runDir) return
    setRedoTarget(null)
    void runRedo(nodes, target.id, entry, new Date().toISOString(), {
      commit: (plan, before) => commitRedo(
        {
          fs: props.fs, runDir, config: cfg, pool: poolRef.current ?? undefined,
          before, onError: e => logError(e),
        },
        plan,
      ),
      onProblems: setRedoProblems,
      onNodes: setNodes,
      start: n => startRun(cfg, n),
      onDone: () => setPhase('done'),
    })
    // biome-ignore lint/correctness/useExhaustiveDependencies: props/store are stable for a mount
  }, [config, runDir, nodes, props.fs, startRun])

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
      result = await runHandoffChoice(choice, h, gitRunner, getCwd())
    } catch (e) {
      result = { ok: false, message: `收口失败: ${e instanceof Error ? e.message : String(e)}` }
    }
    // 只有真的成功了才划掉。失败(冲突、脏树、推不上去)必须让它留着,用户下次还能回来 ——
    // 而且关口刚刚已经如实告诉他失败了什么。
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
    setPhase('done')
    // props.effRoot,不是裸 effRoot:那个绑定只存在于 call() 的作用域,组件里没有。
  // 依赖数组**每次 render 都求值**,所以裸写它 = EffTaskRunner 第一次渲染就抛
  // ReferenceError,/et 输入任何内容都只得到一屏红色堆栈,一次模型调用都没有。
  }, [pendingHandoff, runId, props.effRoot, props.fs])

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
        // 会话级 MCP 工具。放开之后所有环节都能用,而「挡不住会写的 MCP」这件事
        // 必须在用户按 y 之前说出来 —— 这是他要自己决定的取舍。
        mcpToolNames={props.mcpToolNames}
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
        // 环节实况从**本次 run 的真实配置**里来,不是写死的文案 —— 否则默认配置下
        // 关口会承诺一个根本不存在的测试验证环节。
        phases={{
          seatCount: Object.fromEntries(
            PHASE_NAMES.map(p => [p, config.phaseRoles[p]?.length ?? 0]),
          ),
          skipSteps: config.skipSteps,
        }}
        onConfirm={entry => applyRedo(redoTarget, entry)}
        onCancel={() => { setRedoTarget(null); setPhase('done') }}
      />
    )
  }
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={runId ?? ''} streams={streams.current} pool={poolRead.current ?? undefined} onAbort={props.abort} />
  }
  return (
    <DoneView
      nodes={nodes} runId={runId ?? ''} streams={streams.current} outcome={outcome}
      handoff={handoff} handoffResult={handoffResult} viewOnly={viewOnly} onExit={props.onExit}
      redoProblems={redoProblems}
      // 只查看模式下不给重做:那个 run 的编排器根本没起来过,重做等于**替用户决定**
      // 把它跑起来 —— 而他刚刚明确选了不跑。
      onRedo={viewOnly ? undefined : node => {
        // 中断过的 run 在这里重做会立刻再次阻断(见 redoUnavailableReason)。
        // 挡在**按键这一刻**,而不是让他选完环节、看完后果、确认完再看一遍失败。
        const why = redoUnavailableReason({ aborted: props.signal.aborted, runId: runId ?? undefined })
        if (why) { setRedoProblems([why]); return }
        setRedoTarget(node); setPhase('confirmRedo')
      }}
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
export function RunningView(props: { nodes: TaskNode[]; runId: string; streams?: StreamStore; pool?: () => { inUse: number; limit: number }; onAbort: () => void }): React.ReactElement {
  // NO useInput here. TaskTreePanel is interactive and installs its own handler; a second one
  // would ALSO receive every key, so ↑↓ would scroll the tree *and* Esc would mean two
  // different things at once (abort the run vs leave the detail view). The panel owns the
  // keyboard and calls back for exit.
  return <TaskTreePanel nodes={props.nodes} runId={props.runId} interactive streams={props.streams} pool={props.pool} onExitKey={props.onAbort} />
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
  onExit: (outcome: Outcome | null) => void
}): React.ReactElement {
  // Same rule as RunningView: one keyboard owner. Enter used to exit here, but it now opens a
  // node's detail — the run is over, so reading the tree matters more than leaving it fast.
  const ok = props.outcome?.status === 'completed'
  return (
    <Box flexDirection="column">
      <TaskTreePanel
        nodes={props.nodes}
        runId={props.runId}
        interactive
        // "完成后保留最终输出" — the buffer outlives the run, so the done view keeps it.
        streams={props.streams}
        onRedo={props.onRedo}
        onExitKey={() => props.onExit(props.outcome)}
      />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={props.viewOnly ? 'warning' : ok ? 'success' : 'error'}>
          {props.viewOnly ? '仅查看:本次没有继续执行' : ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}
        </Text>
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
        {props.handoff
          ? handoffLines(props.handoff, props.runId).map(l => <Text key={l} dimColor>{l}</Text>)
          : null}
        {props.redoProblems?.map(l => <Text key={l} color="warning">⚠ {l}</Text>) ?? null}
        <Text dimColor>
          q / Esc 退出 · 回车看节点详情{props.onRedo ? ' · r 重做选中的任务' : ''}
        </Text>
      </Box>
    </Box>
  )
}

