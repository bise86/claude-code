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
}

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
