export type PhaseName = 'plan' | 'review' | 'execute' | 'accept' | 'observer'
export const PHASE_NAMES: PhaseName[] = ['plan', 'review', 'execute', 'accept', 'observer']

export type NodeKind = 'decompose' | 'executable' | 'unknown'

export type NodeStatus =
  | 'CREATED' | 'PLANNING' | 'PLAN_REVIEW'
  | 'READY' | 'EXECUTING' | 'EXECUTED' | 'ACCEPTANCE' | 'REWORK'
  | 'WAITING_CHILDREN' | 'INTEGRATION_ACCEPT'
  | 'SCORING' | 'MERGE' | 'ACCEPTED' | 'BLOCKED'

export interface RoleBinding { roleName: string; model?: string }
export interface NodePlan { solution: string; keyPoints: string; risks: string; acceptance: string }
/**
 * `infra: true` marks a verdict the reviewer never actually rendered — the call itself
 * failed (network, provider error). It is NOT a judgement about the work, so a caller
 * must retry the review rather than treat it as a rejection and redo the executor's work.
 */
export interface Verdict { role: string; pass: boolean; blocking: string[]; comments: string; infra?: boolean }
export interface RoundtableRecord { round: number; verdicts: Verdict[]; synthesized: { pass: boolean; blockingSummary: string } }
export interface ScoreRecord { role: string; score: number; rationale: string }

export interface TaskNode {
  id: string
  title: string
  goal: string // immutable node goal; set once at creation, never overwritten by plan output
  parentId: string | null
  childIds: string[]
  deps: string[]
  kind: NodeKind
  status: NodeStatus
  phaseRoles: Record<PhaseName, RoleBinding[]>
  plan: NodePlan
  execStatus: string
  // Why a separate field: execStatus may hold real completed-work evidence that the
  // acceptance roundtable still needs to see. Blocking must never overwrite it.
  blockedReason: string
  /**
   * 该节点是被"中断"扫成 BLOCKED 的,而不是它自己失败了。
   *
   * WHY a field rather than matching blockedReason against '已中断': resume must reopen
   * exactly these nodes and must NOT reopen one that exhausted its iteration budget. A
   * literal shared by two unrelated modules is not an interface — a genuine failure reason
   * could equal it, and a later reword would silently resurrect failed work as if it were
   * merely interrupted. Cleared the moment the node is reseated.
   */
  interrupted?: boolean
  reviewLog: RoundtableRecord[]
  acceptLog: RoundtableRecord[]
  score: { plan?: ScoreRecord; exec?: ScoreRecord }
  worktree?: { branch: string; path: string }
  // Separate budgets. `acceptance` belongs to an executable node's accept loop and
  // `integration` to a decompose node's integrate loop; sharing one counter means a
  // resumed node could arrive at integration with its budget already spent elsewhere.
  iteration: { planReview: number; acceptance: number; integration: number }
  depth: number
  createdAt: string
  updatedAt: string
}

export interface Caps { maxDepth: number; maxNodes: number; maxIterations: number; nodeTimeoutMs: number; scoreThreshold?: number }
export const DEFAULT_CAPS: Caps = { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 600_000 }

export const DEFAULT_PARALLELISM = 5
export interface EffTaskConfig {
  goalPrompt: string
  parallelism: number
  phaseRoles: Record<PhaseName, RoleBinding[]>
  caps: Caps
  /**
   * What was asked for but will NOT happen, in the user's terms — an unknown role name, a
   * role this phase can't run, a seat P1 never consults.
   *
   * `phaseRoles` is what the run will actually do; the confirmation gate renders it as the
   * roster. Anything quietly removed on the way in would leave that gate telling the user
   * something untrue about who is on the panel, which is the one thing this gate exists to
   * get right. So the removals travel WITH the config and are shown alongside it.
   */
  notices: string[]
  /**
   * The session's main model — what every un-roled phase runs on ("不指定就用主模型").
   *
   * Filled in by annotateRoleModels at the command seam, because that is the only place
   * that can see `options.mainLoopModel`. Optional so a run.md written before this field
   * existed still parses on the resume path; the roster then degrades to a bare 主模型.
   */
  mainModel?: string
  /**
   * 续跑指引(§17.4):恢复时用户补充的一段话,追加进后续 plan/execute 阶段的提示词。
   *
   * Only affects work that has NOT finished — an ACCEPTED node is never re-entered, so it is
   * untouched by construction. Declared here (rather than alongside the command wiring that
   * populates it) because `readRunManifest` reads it back off disk, and a field that one
   * layer writes and another reads must exist before either is written.
   */
  resumeGuidance?: string
  /**
   * 每次恢复留下的一条记录(§17.5)。
   *
   * Carried ON THE CONFIG rather than appended to run.md, because `writeRunManifest`
   * rewrites that file whole and `runOrchestrator` queues a write on the very first frame —
   * anything merely appended beforehand is erased before the user can read it. Travelling
   * with the config means every manifest write re-emits the history.
   */
  resumes?: ResumeRecord[]
}

export interface ResumeRecord {
  at: string
  /** How many nodes were returned to a runnable state. */
  reseated: number
  /** How many were blocked because the phase they would re-enter has no budget left. */
  exhausted: number
  /** Repair lines, capped — the full list is shown at the gate; this is the durable trace. */
  repairs: string[]
}
export const MAX_RECORDED_REPAIRS = 5

export function emptyPhaseRoles(): Record<PhaseName, RoleBinding[]> {
  return { plan: [], review: [], execute: [], accept: [], observer: [] }
}
export function emptyPlan(): NodePlan {
  return { solution: '', keyPoints: '', risks: '', acceptance: '' }
}

export function createNode(args: {
  id: string
  title: string
  goal?: string
  parentId: string | null
  deps: string[]
  depth: number
  phaseRoles: Record<PhaseName, RoleBinding[]>
  now: string
}): TaskNode {
  return {
    id: args.id,
    title: args.title,
    goal: args.goal ?? args.title, // default goal to title so existing call-sites stay valid
    parentId: args.parentId,
    childIds: [],
    deps: [...args.deps],
    kind: 'unknown',
    status: 'CREATED',
    // Copy the per-phase ARRAYS too, not just the outer record. Every child is
    // created with `phaseRoles: parent.phaseRoles` (pipeline createChildren), so a
    // one-level spread would leave the whole tree — and the run config it came
    // from — sharing five array instances. P3's per-node role overrides edit a
    // node's roster in place; without this the edit would corrupt every sibling.
    phaseRoles: Object.fromEntries(
      PHASE_NAMES.map(p => [p, [...args.phaseRoles[p]]]),
    ) as Record<PhaseName, RoleBinding[]>,
    plan: emptyPlan(),
    execStatus: '',
    blockedReason: '',
    reviewLog: [],
    acceptLog: [],
    score: {},
    iteration: { planReview: 0, acceptance: 0, integration: 0 },
    depth: args.depth,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
