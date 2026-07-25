import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Tools } from '../../Tool.js'
import { parseDirectives } from '../../tools/efftask/parseDirectives.js'
import { EffTaskOrchestrator } from '../../tools/efftask/orchestrator.js'
import { makeRunAgentFn } from '../../tools/efftask/runAgentAdapter.js'
import { allocateRunId, writeNode, writeRunManifest, type FsLike } from '../../tools/efftask/persistence.js'
import { createNode, emptyPhaseRoles } from '../../tools/efftask/types.js'
import type { EffTaskConfig, TaskNode } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'
import {
  raceConfirm,
  type ConfirmSurface,
  type ConfirmWinner,
  type StartupDecision,
} from '../../tools/efftask/startupConfirm.js'
import { buildStartupCard, sendFeishuStartupCard } from '../../tools/efftask/feishuStartupCard.js'
import { ConfirmStartup } from './ConfirmStartup.js'
import { TaskTreePanel } from './TaskTreePanel.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { useAppStateStore } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'

type Outcome = { status: 'completed' | 'blocked'; reason?: string }
type Phase = 'parsing' | 'confirm' | 'running' | 'done'

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
  // Local fs scan only — no model call, no tokens, sub-millisecond. Everything that COSTS
  // something (parseDirectives) happens inside the component.
  // It can still fail (an unreadable .claude dir), and allocateRunId deliberately rethrows
  // rather than hand out an id that would overwrite a previous run. Rejecting out of call()
  // makes processSlashCommand resolve with no messages at all — the user types /et and
  // NOTHING appears — so the failure has to be reported here.
  let runId: string
  try {
    runId = await allocateRunId(fs, effRoot)
  } catch (e) {
    onDone(`高效任务无法启动: ${e instanceof Error ? e.message : String(e)}`, { display: 'system' })
    return null
  }
  const runDir = `${effRoot}/${runId}`

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
  })

  const knownRoles = activeAgents.map(a => a.agentType)
  // Set when the view is torn down rather than exited, so the report can tell the two apart.
  let tornDown = false
  return (
    <EffTaskRunner
      args={args}
      knownRoles={knownRoles}
      extractJson={prompt => extractAgent({ phase: 'plan', node: stubNode(), role: null, system: '', prompt, signal })}
      runId={runId}
      runDir={runDir}
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
        onDone(`高效任务 ${runId} ${how} · .claude/efftask/${runId}/run.md`, { display: 'system' })
      })}
    />
  )
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
    readdir: p => readdir(p), // returns string[] by default — matches FsLike
    exists: p => access(p).then(() => true, () => false),
  }
}

type RunnerProps = {
  args: string
  knownRoles: string[]
  extractJson: (prompt: string) => Promise<string>
  runId: string
  runDir: string
  fs: FsLike
  runAgent: RunAgentFn
  signal: AbortSignal
  abort: () => void
  detach: () => void
  onTornDown: () => void
  onExit: (outcome: Outcome | null) => void
}

function EffTaskRunner(props: RunnerProps): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>('parsing')
  const [config, setConfig] = React.useState<EffTaskConfig | null>(null)
  const [nodes, setNodes] = React.useState<TaskNode[]>([])
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const store = useAppStateStore()
  // The terminal surface stashes raceConfirm's `claim` here so the rendered ConfirmStartup
  // (and the unmount path) can settle the race.
  const terminalClaim = React.useRef<((w: ConfirmWinner, d: StartupDecision) => void) | null>(null)

  // If this view is ever torn down without going through onExit, the run must stop with it:
  // otherwise the orchestrator keeps issuing real, write-capable model calls and writing
  // node.md into a tree nothing is watching, and the parent-signal listener outlives us.
  const { abort, detach, onTornDown } = props
  React.useEffect(() => () => { onTornDown(); abort(); detach() }, [abort, detach, onTornDown])

  const { args, knownRoles, extractJson } = props
  // parseDirectives is a MODEL call. It runs HERE, behind a 正在解析需求… view — never in
  // call(), which would freeze the terminal with no UI while spending tokens.
  React.useEffect(() => {
    let cancelled = false
    void parseDirectives(args, { knownRoles, modelJson: extractJson })
      // belt & braces: parseDirectives already swallows extraction failures, but a rejection
      // here would otherwise strand the UI on 'parsing' forever.
      .catch(() => parseDirectives(args, { knownRoles }))
      .then(cfg => {
        if (cancelled) return
        setConfig(cfg)
        setPhase('confirm')
      })
      .catch(logError)
    return () => {
      cancelled = true
    }
  }, [args, knownRoles, extractJson])

  React.useEffect(() => {
    if (phase !== 'confirm' || !config) return
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
      const cardContent = buildStartupCard(config, requestId)
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
        // Apply the confirmed parallelism. It is inert in P1's serial driver, but it must
        // NOT be silently discarded — P2's pool reads it straight off the config.
        const effectiveConfig: EffTaskConfig = { ...config, parallelism: decision.parallelism }
        setPhase('running')
        void runOrchestrator(
          { config: effectiveConfig, runDir: props.runDir, fs: props.fs, runAgent: props.runAgent, signal: props.signal },
          setNodes,
          setOutcome,
          setPhase,
        )
      })
      .catch(e => {
        settled = true
        // A broken race must land on the done view, not hang on 'confirm'.
        if (cancelled) return
        setOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
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

  if (phase === 'parsing' || !config) {
    return <Text dimColor>正在解析需求…</Text>
  }
  if (phase === 'confirm') {
    return <ConfirmStartup config={config} onDecision={d => terminalClaim.current?.('terminal', d)} />
  }
  if (phase === 'running') {
    return <RunningView nodes={nodes} runId={props.runId} onAbort={props.abort} />
  }
  return <DoneView nodes={nodes} runId={props.runId} outcome={outcome} onExit={props.onExit} />
}

// 'running' phase: live tree + an interrupt affordance. Esc/q aborts the controller the
// command owns; the orchestrator then returns {status:'blocked', reason:'已中断'} and the
// finally-block flips us to 'done'.
function RunningView(props: { nodes: TaskNode[]; runId: string; onAbort: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'q') props.onAbort()
  })
  return (
    <Box flexDirection="column">
      <TaskTreePanel nodes={props.nodes} runId={props.runId} />
      <Text dimColor>Esc 中断</Text>
    </Box>
  )
}

// 'done' phase: read-only tree + terminal summary (completed/blocked + reason) + exit key.
function DoneView(props: {
  nodes: TaskNode[]
  runId: string
  outcome: Outcome | null
  onExit: (outcome: Outcome | null) => void
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return || key.escape || input.toLowerCase() === "q") props.onExit(props.outcome)
  })
  const ok = props.outcome?.status === 'completed'
  return (
    <Box flexDirection="column">
      <TaskTreePanel nodes={props.nodes} runId={props.runId} />
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color={ok ? 'green' : 'red'}>
          {ok ? '✓ 高效任务完成' : '✗ 高效任务被阻断'}
        </Text>
        {props.outcome?.reason ? <Text dimColor>原因: {props.outcome.reason}</Text> : null}
        <Text dimColor>回车 / q / Esc 退出</Text>
      </Box>
    </Box>
  )
}

async function runOrchestrator(
  args: { config: EffTaskConfig; runDir: string; fs: FsLike; runAgent: RunAgentFn; signal: AbortSignal },
  setNodes: (n: TaskNode[]) => void,
  setOutcome: (o: Outcome) => void,
  setPhase: (p: Phase) => void,
): Promise<void> {
  // Serialize run.md writes. onUpdate fires on EVERY state transition; firing writeFile
  // unawaited each time lets concurrent writes to the same path interleave into a corrupt
  // manifest. One promise queue ⇒ strictly ordered, last-write-wins.
  let manifestQueue: Promise<void> = Promise.resolve()
  const queueManifest = (nodes: TaskNode[], result?: Outcome): Promise<void> => {
    manifestQueue = manifestQueue
      .then(() => writeRunManifest(args.fs, args.runDir, args.config, nodes, result))
      .catch(logError)
    return manifestQueue
  }
  try {
    const persist = (n: TaskNode) => writeNode(args.fs, args.runDir, n)
    const now = () => new Date().toISOString()
    const orch = new EffTaskOrchestrator(
      args.config,
      {
        runAgent: args.runAgent,
        persist,
        now,
        onUpdate: nodes => {
          setNodes([...nodes])
          void queueManifest(nodes)
        },
      },
      args.signal,
    )
    setNodes(orch.nodes()) // seed with the root so the tree isn't blank on first paint
    void queueManifest(orch.nodes()) // run.md exists from the first frame, not just at the end
    const result = await orch.run() // { status, reason }
    setNodes([...orch.nodes()])
    setOutcome(result)
    await queueManifest(orch.nodes(), result) // final manifest records {status, reason}
  } catch (e) {
    // run() is not supposed to reject (the orchestrator catches per-step), but if it ever
    // does, the UI must NOT wedge on 'running' with no way out.
    setOutcome({ status: 'blocked', reason: e instanceof Error ? e.message : String(e) })
  } finally {
    setPhase('done') // the done view is ALWAYS reached
  }
}
