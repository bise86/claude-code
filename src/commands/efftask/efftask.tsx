import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { access, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Tools } from '../../Tool.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { runOrchestrator, type Outcome, type Phase } from './runOrchestrator.js'
import { createWorktreePool, type GitRunner, type WorktreePool } from '../../tools/efftask/worktreePool.js'
import { spawn } from 'node:child_process'
import { annotateRoleModels, effectiveModel, type AgentModelInfo } from '../../tools/efftask/roleModels.js'
import { allocateRunId, loadRun, type FsLike } from '../../tools/efftask/persistence.js'
import { parseResumeArgs, type ResumeArgs } from '../../tools/efftask/parseResumeArgs.js'
import { readRunManifest, validateLoadedNodes } from '../../tools/efftask/resumeCore.js'
import { reseatTransientNodes } from '../../tools/efftask/reseat.js'
import { acquireRunLock, listRuns, releaseRunLock, type RunSummary } from '../../tools/efftask/runRegistry.js'
import { ConfirmResume } from './ConfirmResume.js'
import { ResumePicker } from './ResumePicker.js'
import { createNode, emptyPhaseRoles, emptyPlan, DEFAULT_CAPS, MAX_RECORDED_REPAIRS } from '../../tools/efftask/types.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
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
import { createChunkStore, type ChunkStore } from '../../tools/efftask/chunkBuffer.js'
import { logError } from '../../utils/log.js'


// Read-only tool pool for plan/review/accept/observer: they must be able to READ the repo
// to judge anything, they just must not be able to WRITE it.
export const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Glob', 'Grep'])

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
  const capsRef: { nodeTimeoutMs: number } = { nodeTimeoutMs: DEFAULT_CAPS.nodeTimeoutMs }

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
      active.runId = await allocateRunId(fs, effRoot)
    } catch (e) {
      onDone(`高效任务无法启动: ${e instanceof Error ? e.message : String(e)}`, { display: 'system' })
      return null
    }
    active.runDir = `${effRoot}/${active.runId}`
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
  // REAL read-only pool (NOT []): a reviewer that cannot read the repo can only guess.
  const readOnlyTools: Tools = context.options.tools.filter(t => READ_ONLY_TOOL_NAMES.has(t.name))
  const runAgent: RunAgentFn = makeRunAgentFn({
    toolUseContext: context,
    canUseTool,
    availableTools: context.options.tools, // execute phase only
    readOnlyTools, // plan / review / accept / observer
    activeAgents,
    mainModelDefault,
    // caps.nodeTimeoutMs was declared and never enforced; wall clock was the one unbounded
    // axis left. The extraction seam below gets it too.
    timeoutMs: () => capsRef.nodeTimeoutMs,
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
  })

  const knownRoles = activeAgents.map(a => a.agentType)
  // execMode:'cli' roles are dispatched by AgentTool, not runAgent — this seam cannot run
  // them, so they must be reported at the gate rather than silently downgraded to the main
  // model while the roster still shows the role's name.
  const unsupportedRoles = activeAgents.filter(a => 'execMode' in a && (a as { execMode?: string }).execMode === 'cli').map(a => a.agentType)
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
      // The roster must say which model each seat runs on, and that answer lives in the
      // agent definitions + the session model — neither of which parseDirectives can see.
      agentModels={activeAgents}
      mainModel={context.options.mainLoopModel}
      extractJson={prompt => extractAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal })}
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
): Promise<{ pool?: WorktreePool; reason?: string }> {
  const top = await gitRunner(['rev-parse', '--show-toplevel'], cwd)
  if (top.code !== 0) return { reason: '当前目录不是 git 仓库' }
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
  unsupportedRoles: string[]
  agentModels: AgentModelInfo[]
  mainModel: string
  extractJson: (prompt: string) => Promise<string>
  resumeArgs: ResumeArgs
  effRoot: string
  /** Mutated once the run is identified, so call()'s onExit closure can release the right lock. */
  active: { runId: string | null; runDir: string | null; resumed: boolean }
  /** Written when the config resolves; the runAgent seam reads it for each phase deadline. */
  capsRef: { nodeTimeoutMs: number }
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
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [runs, setRuns] = React.useState<RunSummary[] | null>(null)
  const [seed, setSeed] = React.useState<TaskNode[] | null>(null)
  // Isolation is resolved ONCE, when the gate is answered — never re-decided per node.
  const poolRef = React.useRef<WorktreePool | undefined>(undefined)
  // 收口 (spec §8): where the run's work ended up. Collected when the run ends, while the
  // worktrees still exist, and shown in the two places the user actually looks.
  const [handoff, setHandoff] = React.useState<HandoffSummary | null>(null)
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
  const chunks = React.useRef(createChunkStore())
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
      setNodes(reseated.nodes)
      setPhase('confirmResume')
    })().catch(e => { if (!cancelled) { setFatal(`恢复失败: ${msg(e)}`); setPhase('fatal') } })
    return () => { cancelled = true }
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once per phase entry
  }, [phase, runId])

  const { args, knownRoles, unsupportedRoles, extractJson, agentModels, mainModel } = props
  // parseDirectives is a MODEL call. It runs HERE, behind a 正在解析需求… view — never in
  // call(), which would freeze the terminal with no UI while spending tokens.
  React.useEffect(() => {
    if (isResume) return // resume recovers its config from run.md; no model call, no roster overwrite
    let cancelled = false
    void parseDirectives(args, { knownRoles, unsupportedRoles, modelJson: extractJson })
      // belt & braces: parseDirectives already swallows extraction failures, but a rejection
      // here would otherwise strand the UI on 'parsing' forever. Keep unsupportedRoles here
      // too: dropping it would let a cli-mode role back onto the roster unannounced.
      .catch(() => parseDirectives(args, { knownRoles, unsupportedRoles }))
      .then(async cfg => {
        if (cancelled) return
        // parseDirectives only ever sees role NAMES, so the roster it produces cannot say
        // which model each one runs on. Resolve that here — this is the only layer that can
        // see the agent definitions and the session model.
        props.capsRef.nodeTimeoutMs = cfg.caps.nodeTimeoutMs
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
        if (!iso.pool && iso.reason) cfg.notices.push(`隔离不可用,执行阶段将共享工作目录并串行: ${iso.reason}`)
        setConfig(annotateRoleModels(cfg, agentModels, mainModel))
        setPhase('confirm')
      })
      .catch(logError)
    return () => {
      cancelled = true
    }
  }, [args, knownRoles, unsupportedRoles, extractJson, agentModels, mainModel])

  /**
   * Hand the confirmed run to the orchestrator. ONE definition, because two gates now reach
   * it: the resume gate goes straight here, while a fresh run passes through the root-plan
   * gate first and arrives carrying its confirmed root as the seed.
   */
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
        // 子 agent 实时输出 (spec §10.2). The buffer is bounded, so a long run cannot grow it
        // without limit; the detail view reads it directly at render time.
        onChunk: (nodeId, text) => chunks.current.push(nodeId, text),
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

  // ---- 启动关口第三关: 起草根方案 + 首层任务树 (spec §2) ----
  React.useEffect(() => {
    if (phase !== 'drafting' || !approved) return
    let cancelled = false
    void (async () => {
      const now = new Date().toISOString()
      // Minted once and reused across re-drafts, so the plan text of the previous pass is
      // still in the node when planPrompt renders 上一版方案 for the revision.
      const root = rootRef.current ?? makeRootNode(approved, now)
      rootRef.current = root
      const feedback = redraftFeedback.current ?? undefined
      redraftFeedback.current = null
      const res = await draftRootPlan({ root, config: approved, runAgent: props.runAgent, signal: props.signal, feedback })
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
  }, [phase, approved, redrafts])

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
        if (isResumeGate) { startRun(effectiveConfig); return }
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
  if (phase === 'parsing' || !config) {
    return <ParsingView onCancel={bail} />
  }
  if (phase === 'confirmResume' && summary) {
    return <ConfirmResume config={config} summary={summary} isolation={isolation} onDecision={d => terminalClaim.current?.('terminal', d)} />
  }
  if (phase === 'confirm') {
    return (
      <ConfirmStartup
        config={config}
        isolation={isolation}
        // spec §2 第一关 "名册可编辑". Only roles this session can actually dispatch — the
        // roster must not offer a seat the run would then silently downgrade to the main model.
        availableRoles={dispatchableRoles(props.knownRoles, props.unsupportedRoles)}
        // …and an edited seat must render with its model, like every other seat. annotateRoleModels
        // runs BEFORE this gate, so a role added here would otherwise show as a bare name.
        roleModel={name => effectiveModel(props.agentModels.find(a => a.agentType === name), props.mainModel)}
        onEdited={() => { terminalEdited.current = true }}
        onDecision={d => terminalClaim.current?.('terminal', d)}
      />
    )
  }
  if (phase === 'drafting') {
    return (
      <MessageView
        title="高效任务模式 · 第三关"
        body={redrafts > 0 ? '正在按你的意见重拟根方案与首层任务树…' : '正在起草根方案与首层任务树…'}
        tone="dim"
        onDismiss={bail}
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
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={runId ?? ''} chunks={chunks.current} pool={poolRead.current ?? undefined} onAbort={props.abort} />
  }
  return <DoneView nodes={nodes} runId={runId ?? ''} chunks={chunks.current} outcome={outcome} handoff={handoff} onExit={props.onExit} />
}

/** A one-line status/error screen that can always be dismissed. */
function MessageView(props: {
  title: string; body: string; tone: 'error' | 'dim'; onDismiss: () => void
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return || key.escape || input.toLowerCase() === 'q') props.onDismiss()
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{props.title}</Text>
      <Text color={props.tone === 'error' ? 'error' : undefined} dimColor={props.tone === 'dim'}>{props.body}</Text>
      <Text dimColor>回车 / q / Esc 退出</Text>
    </Box>
  )
}

// 'parsing' phase: the extraction model call is in flight. Esc/q must work here too.
function ParsingView(props: { onCancel: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') props.onCancel()
  })
  return (
    <Box flexDirection="column">
      <Text dimColor>正在解析需求…</Text>
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
export function RunningView(props: { nodes: TaskNode[]; runId: string; chunks?: ChunkStore; pool?: () => { inUse: number; limit: number }; onAbort: () => void }): React.ReactElement {
  // NO useInput here. TaskTreePanel is interactive and installs its own handler; a second one
  // would ALSO receive every key, so ↑↓ would scroll the tree *and* Esc would mean two
  // different things at once (abort the run vs leave the detail view). The panel owns the
  // keyboard and calls back for exit.
  return <TaskTreePanel nodes={props.nodes} runId={props.runId} interactive chunks={props.chunks} pool={props.pool} onExitKey={props.onAbort} />
}

// 'done' phase: read-only tree + terminal summary (completed/blocked + reason) + exit key.
export function DoneView(props: {
  nodes: TaskNode[]
  runId: string
  chunks?: ChunkStore
  outcome: Outcome | null
  handoff: HandoffSummary | null
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
        chunks={props.chunks}
        onExitKey={() => props.onExit(props.outcome)}
      />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={ok ? 'success' : 'error'}>
          {ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}
        </Text>
        {props.outcome?.reason ? <Text dimColor>原因: {props.outcome.reason}</Text> : null}
        {props.handoff
          ? handoffLines(props.handoff).map(l => <Text key={l} dimColor>{l}</Text>)
          : null}
        <Text dimColor>q / Esc 退出 · 回车看节点详情</Text>
      </Box>
    </Box>
  )
}

