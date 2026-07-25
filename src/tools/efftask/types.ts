export type PhaseName = 'plan' | 'review' | 'execute' | 'accept' | 'observer'
export const PHASE_NAMES: PhaseName[] = ['plan', 'review', 'execute', 'accept', 'observer']

export type NodeKind = 'decompose' | 'executable' | 'unknown'

/**
 * Why a safety valve stopped a node. Declared HERE rather than imported from escalation.ts so
 * TaskNode can name it without a cycle (escalation.ts imports TaskNode).
 */
export type BlockCategory =
  | 'cap-iteration' | 'cap-nodes' | 'rework' | 'timeout' | 'infra' | 'cap-depth'
  // 补救拆分 (spec §4.1). The only member that is NOT a valve: nothing tripped and nothing
  // stopped — the node recovered and is waiting on new children. It has its own category
  // because reusing 'rework' produced a card headed 连续返工超限 (a STOPPING reason) over a
  // node that had just recovered, in the blue "nothing needs you" template, carrying the
  // generic non-stopping body text that says the grow request was refused. One card, three
  // contradictions.
  | 'revise'
export const BLOCK_CATEGORIES: ReadonlySet<string> =
  new Set(['cap-iteration', 'cap-nodes', 'rework', 'timeout', 'infra', 'cap-depth', 'revise'])

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
export interface Verdict {
  role: string; pass: boolean; blocking: string[]; comments: string; infra?: boolean
  /**
   * The reviewer's call hit caps.nodeTimeoutMs rather than failing to connect.
   *
   * Both are `infra` (nobody judged the work, so retrying the review is right), but they
   * escalate to DIFFERENT advice: a timeout says 提高 nodeTimeoutMs / 把节点拆小, an
   * unreachable provider says 检查角色模型和网络. Without this the roundtable phases
   * reported every deadline as 角色调用连续失败 and prescribed the wrong fix.
   */
  timeout?: boolean
  /**
   * 集成验收不通过时,这位角色提出的**补救子任务** —— spec §4.1 的
   * `INTEGRATION_ACCEPT ──fail──▶ (回到 decompose 修订)`。
   *
   * Carried on the VERDICT rather than fetched with a separate plan call, and that placement
   * IS the design. The obvious alternative — ask a plan role for a corrective decomposition
   * after the roundtable rejects — was reviewed and rejected on four counts, every one of
   * which this placement removes for free:
   *   - it costs no extra model call;
   *   - it inherits parseVerdict's tag-required pick, so a `newChildren` planted in a node's
   *     execStatus (authored by the only agent that holds write tools, and quoted into this
   *     very prompt as evidence) cannot graft nodes onto the tree;
   *   - the integration roundtable already runs with `cwd` = the integration worktree, so a
   *     proposal comes from a role that can actually READ the run's output — a fresh plan
   *     call would have run in the user's checkout, which under isolation contains none of it;
   *   - a protocol failure (no tagged block) or an unreachable provider yields no remedy at
   *     all, so a corrective decomposition can never be triggered by a malformed reply —
   *     and a malformed reply is precisely the case the plain re-review loop is the cure for.
   *
   * Only meaningful on a FAILING verdict: a reviewer that passed has nothing to remedy.
   */
  remedy?: { title: string; deps: string[] }[]
}
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
  /**
   * BLOCKED because its worktree would not merge, and a human was asked to fix it.
   *
   * Distinct from `interrupted`: a conflict block is a VERDICT, so interrupted is false and
   * reseat would skip it forever — the escalation card told the user to run `/et --resume`
   * and the node came back untouched, zero model calls. This flag is what makes that
   * instruction true. It also protects the worktree reference from resume's stale-path
   * sweep, because for THIS node the path is where the human's resolution lives.
   */
  mergeConflict?: boolean
  /**
   * BLOCKED because a SAFETY VALVE tripped (spec §11) — an iteration/rework limit, the node
   * cap, a phase timeout, or reviewers that could never be reached. Never because the tree
   * itself is damaged.
   *
   * WHY a field rather than matching blockedReason text: `/et --resume <id> --retry-blocked`
   * reopens exactly this set, and it must be impossible for it to resurrect a node blocked by
   * 依赖节点缺失 / 子节点缺失 / 依赖成环 — those are unrecoverable disk states that
   * validateLoadedNodes wrote, and re-running them would execute work whose upstream cannot
   * be verified. A shared string literal between two modules is not an interface.
   *
   * Assigned in BOTH directions, like `interrupted`: a node that later fails for a structural
   * reason must not keep a stale flag that makes a retry offer it.
   */
  capBlocked?: boolean
  /**
   * WHICH valve stopped it. Recorded at block time, never re-derived.
   *
   * `--retry-blocked` decides where the node re-enters from this. Deriving it instead — by
   * comparing `iteration.planReview >= caps.maxIterations` at resume time — was defeated by
   * the escalation card's OWN advice: the card says "提高 caps.maxIterations 后再重试", the
   * user does exactly that, run.md now carries the bigger cap, the comparison turns false,
   * and a plan the roundtable rejected three times goes straight to a write-capable executor
   * with zero plan calls and zero reviews. Measured.
   *
   * Persisted with the rest of the node (serializeNode spreads the whole object).
   */
  capCategory?: BlockCategory
  /**
   * 启动关口第三关(spec §2)确认过的首层拆分。
   *
   * Its PRESENCE means "the plan already in this node was put in front of a human and
   * approved", so stepStart must skip its first plan call and go straight to review.
   * Without that, the confirmed plan would be overwritten by a fresh draft on the run's very
   * first step — the gate would render, the user would edit, and none of it would reach the
   * run. Consumed exactly once, and cleared as part of the commit that enters PLAN_REVIEW so
   * a crash cannot make it apply twice.
   *
   * Children are carried as SPECS, not nodes: createChildren owns id allocation, sibling-dep
   * resolution and the node-count reservation, and duplicating any of that here would give
   * the gate's tree different ids from the run's.
   */
  confirmedDraft?: { children: { title: string; deps: string[] }[] }
  reviewLog: RoundtableRecord[]
  acceptLog: RoundtableRecord[]
  score: { plan?: ScoreRecord; exec?: ScoreRecord }
  worktree?: { branch: string; path: string }
  /**
   * 这个节点已经做过一次「集成验收失败 → 补救拆分」(spec §4.1),不会再做第二次。
   *
   * ONCE per node, and only at the moment it would otherwise BLOCK — not once per round.
   * The difference is the whole cost argument. Revising on every failed round lets each
   * corrective child bring its OWN fresh iteration budget and its own subtree, so
   * `maxIterations` stops bounding anything and the only remaining ceiling is `maxNodes`:
   * a single root-level integration failure was measured to reach ~2300 agent calls that
   * way, against 2–6 for the plain re-review loop. Bounded here at one revision per
   * decompose node, the whole feature costs at most one extra subtree per node, and it
   * converts a terminal state into a recovery rather than taxing every round.
   *
   * Persisted (serializeNode spreads the node), so a crash mid-revision cannot buy a second.
   *
   * MEASURED, tree-wide, because "one subtree per node" is a per-node statement and the
   * interesting number is what it compounds to. Adversarial worst case under DEFAULT_CAPS —
   * every node decomposing to maxDepth, every decompose node failing integration three times
   * and proposing three remedies each:
   *
   *     with the feature:     100 nodes (= maxNodes), 427 agent calls, 24 revised nodes
   *     with it switched off:   6 nodes,               17 agent calls
   *
   * So the ceiling still holds — `maxNodes` is the binding constraint and `reserveNodes` is
   * atomic — but on a pathological run this converts "block early" into "spend up to the node
   * cap", ~25×. That is the honest price, and it is bounded by a cap the user sees and can
   * lower at the confirmation gate.
   */
  revised?: boolean
  // Separate budgets. `acceptance` belongs to an executable node's accept loop and
  // `integration` to a decompose node's integrate loop; sharing one counter means a
  // resumed node could arrive at integration with its budget already spent elsewhere.
  iteration: { planReview: number; acceptance: number; integration: number; scoring: number; mergeResolve: number }
  depth: number
  createdAt: string
  updatedAt: string
  /**
   * When the node first entered an ACTIVE phase — spec §10.1's "自进入活动态起的累计耗时".
   *
   * The panel measured from `createdAt`, so a node that never ran because its dependencies
   * were unfinished rendered an hour of "耗时" an hour after the tree was built — and a user
   * hunting for the slow node was pointed at one that had not started.
   */
  startedAt?: string
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
  /**
   * How many nodes `--retry-blocked` re-armed.
   *
   * The one action on this path that spends budget the run had already refused to spend, and
   * it was visible only on the resume gate — someone reading run.md afterwards could not tell
   * a valve had ever been re-opened.
   */
  retried?: number
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
    iteration: { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 },
    depth: args.depth,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
