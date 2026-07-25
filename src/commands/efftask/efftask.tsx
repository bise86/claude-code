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
import { annotateRoleModels, type AgentModelInfo } from '../../tools/efftask/roleModels.js'
import { allocateRunId, loadRun, type FsLike } from '../../tools/efftask/persistence.js'
import { parseResumeArgs, type ResumeArgs } from '../../tools/efftask/parseResumeArgs.js'
import { readRunManifest, validateLoadedNodes } from '../../tools/efftask/resumeCore.js'
import { reseatTransientNodes } from '../../tools/efftask/reseat.js'
import { acquireRunLock, listRuns, releaseRunLock, type RunSummary } from '../../tools/efftask/runRegistry.js'
import { ConfirmResume } from './ConfirmResume.js'
import { ResumePicker } from './ResumePicker.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, MAX_RECORDED_REPAIRS } from '../../tools/efftask/types.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import {
  raceConfirm,
  type ConfirmSurface,
  type ConfirmWinner,
  type StartupDecision,
  type ResumeSummary,
} from '../../tools/efftask/startupConfirm.js'
import { buildStartupCard, sendFeishuStartupCard } from '../../tools/efftask/feishuStartupCard.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { useAppStateStore } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'


// Read-only tool pool for plan/review/accept/observer: they must be able to READ the repo
// to judge anything, they just must not be able to WRITE it.
export const READ_ONLY_TOOL_NAMES = new Set(['Read', 'Glob', 'Grep'])

const CANCELLED: StartupDecision = { parallelism: 0, approved: false }

// 集成接线,无单测;手动跑 /et 验证。
// 构造顺序:fs → runId → runAgent 接缝 → 立刻返回 JSX(解析在组件内 parsing 态跑)。
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // Empty prompt: there is nothing to plan. The hint must travel through onDone — JSX
  // painted for a single frame before exiting never reaches the transcript, so the user
  // would be left with a bare '已取消' and no idea what the command wanted.
  if (!args.trim()) {
    onDone('用法: /et <任务提示词>', { display: 'system' })
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
      abort={() => runController.abort()}
      detach={detachAbortRelay}
      // The REPL moves this JSX between four mutually-exclusive tree positions, so Ctrl+O
      // (toggle transcript) or Ctrl+Z→fg unmounts and remounts it. That stops the run —
      // which is right, an orphaned orchestrator would keep burning tokens into a tree
      // nobody is watching — but the user never asked to stop, so the message must not
      // claim they cancelled. It points at the run dir, which is exactly what resume reads.
      onTornDown={() => { tornDown = true }}
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
        // Never picked a run (cancelled at the picker, or resume failed before it resolved).
        if (!runId || !runDir) {
          onDone(`高效任务 ${how}`, { display: 'system' })
          return
        }
        const report = (withPath: boolean): void => {
          const verb = resumed ? '续跑' : ''
          onDone(
            `高效任务 ${runId} ${verb}${how}${withPath ? ` · .claude/efftask/${runId}/run.md` : ''}`,
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

function countStatuses(nodes: TaskNode[]): { accepted: number; blocked: number; pending: number; total: number } {
  let accepted = 0, blocked = 0
  for (const n of nodes) {
    if (n.status === 'ACCEPTED') accepted++
    else if (n.status === 'BLOCKED') blocked++
  }
  return { accepted, blocked, pending: nodes.length - accepted - blocked, total: nodes.length }
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
  abort: () => void
  detach: () => void
  onTornDown: () => void
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
  const [summary, setSummary] = React.useState<ResumeSummary | null>(null)
  const [fatal, setFatal] = React.useState<string | null>(null)
  const [runId, setRunId] = React.useState<string | null>(props.active.runId)
  const runDir = runId ? `${props.effRoot}/${runId}` : null
  const store = useAppStateStore()
  // The terminal surface stashes raceConfirm's `claim` here so the rendered ConfirmStartup
  // (and the unmount path) can settle the race.
  const terminalClaim = React.useRef<((w: ConfirmWinner, d: StartupDecision) => void) | null>(null)

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
      const reseated = reseatTransientNodes(validated.nodes, now, recovered.caps)
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
          { at: now, reseated: reseated.reseated.length, exhausted: reseated.exhausted.length, repairs: validated.repairs.slice(0, MAX_RECORDED_REPAIRS) },
        ],
      }
      // Re-resolve the roster against THIS session: a role recorded on disk may no longer
      // exist, and pickAgentDefinition would silently fall back to the main model while the
      // gate still displayed the old name — the exact dishonesty fixed for new runs.
      // The recovered caps are the run's caps — run.md is hand-editable, so a manifest that
      // declares a different nodeTimeoutMs must actually get it.
      props.capsRef.nodeTimeoutMs = withGuidance.caps.nodeTimeoutMs
      setConfig(annotateRoleModels(withGuidance, props.agentModels, props.mainModel))
      setSeed(reseated.nodes)
      setSummary({
        runId,
        counts: countStatuses(reseated.nodes),
        repairs: validated.repairs,
        reseated: reseated.reseated,
        exhausted: reseated.exhausted,
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
      .then(cfg => {
        if (cancelled) return
        // parseDirectives only ever sees role NAMES, so the roster it produces cannot say
        // which model each one runs on. Resolve that here — this is the only layer that can
        // see the agent definitions and the session model.
        props.capsRef.nodeTimeoutMs = cfg.caps.nodeTimeoutMs
        setConfig(annotateRoleModels(cfg, agentModels, mainModel))
        setPhase('confirm')
      })
      .catch(logError)
    return () => {
      cancelled = true
    }
  }, [args, knownRoles, unsupportedRoles, extractJson, agentModels, mainModel])

  React.useEffect(() => {
    if ((phase !== 'confirm' && phase !== 'confirmResume') || !config) return
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
      const cardContent = buildStartupCard(config, requestId, summary ?? undefined)
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
      .then(({ decision }) => {
        settled = true
        if (cancelled) return
        if (!decision.approved) {
          props.onExit(null) // cancelled at the gate: no run outcome to report
          return
        }
        // Apply the confirmed parallelism — the pool reads it straight off the config.
        // KNOWN GAP: this snapshots config at gate-open, so a value the terminal user dialled
        // but had not yet committed is discarded if the FEISHU surface wins the race. There
        // is no channel from the gate's React state to the Feishu surface.
        const effectiveConfig: EffTaskConfig = { ...config, parallelism: decision.parallelism }
        setPhase('running')
        void runOrchestrator(
          { config: effectiveConfig, runDir: runDir!, fs: props.fs, runAgent: props.runAgent, signal: props.signal, seed: seed ?? undefined },
          setNodes,
          recordOutcome,
          setPhase,
        )
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
    return <MessageView title="高效任务无法继续" body={fatal ?? '未知错误'} tone="red" onDismiss={bail} />
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
    return <ConfirmResume config={config} summary={summary} onDecision={d => terminalClaim.current?.('terminal', d)} />
  }
  if (phase === 'confirm') {
    return <ConfirmStartup config={config} onDecision={d => terminalClaim.current?.('terminal', d)} />
  }
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={runId ?? ''} onAbort={props.abort} />
  }
  return <DoneView nodes={nodes} runId={runId ?? ''} outcome={outcome} onExit={props.onExit} />
}

/** A one-line status/error screen that can always be dismissed. */
function MessageView(props: {
  title: string; body: string; tone: 'red' | 'dim'; onDismiss: () => void
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return || key.escape || input.toLowerCase() === 'q') props.onDismiss()
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{props.title}</Text>
      <Text color={props.tone === 'red' ? 'red' : undefined} dimColor={props.tone === 'dim'}>{props.body}</Text>
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
function RunningView(props: { nodes: TaskNode[]; runId: string; onAbort: () => void }): React.ReactElement {
  // NO useInput here. TaskTreePanel is interactive and installs its own handler; a second one
  // would ALSO receive every key, so ↑↓ would scroll the tree *and* Esc would mean two
  // different things at once (abort the run vs leave the detail view). The panel owns the
  // keyboard and calls back for exit.
  return <TaskTreePanel nodes={props.nodes} runId={props.runId} interactive onExitKey={props.onAbort} />
}

// 'done' phase: read-only tree + terminal summary (completed/blocked + reason) + exit key.
function DoneView(props: {
  nodes: TaskNode[]
  runId: string
  outcome: Outcome | null
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
        onExitKey={() => props.onExit(props.outcome)}
      />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={ok ? 'green' : 'red'}>
          {ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}
        </Text>
        {props.outcome?.reason ? <Text dimColor>原因: {props.outcome.reason}</Text> : null}
        <Text dimColor>q / Esc 退出 · 回车看节点详情</Text>
      </Box>
    </Box>
  )
}

