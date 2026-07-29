// 纯类型导入,编译期擦除 —— roleDefs.ts 对本文件是值依赖(PHASE_NAMES/MAIN_STAFF),
// 所以这条反向依赖必须是 `import type`,否则就成了真实的运行期循环。
import type { RoleDef } from './roleDefs.js'
import type { UsageTotals } from './usage.js'

/**
 * 一个**环节**(用户词汇里的「过程」)—— 流水线上一个真实的派发点。
 *
 * 自由的是角色,固定的是环节:角色名、由谁担当、产出与作用都可以任意写,唯独「这个角色
 * 挂在哪个环节上」不自由。环节是状态机的骨架,它决定这一席什么时候被调用、能不能拿到
 * 写工具、恢复之后还在不在。自由的环节名会被 Object.fromEntries(PHASE_NAMES.map(…))
 * 直接删掉,而 makeRunAgentFn 按 phase === 'execute' 发写工具 —— 那就是「配得进去、
 * 永远不跑」。
 *
 * 这个列表**会随版本增长**(这一版就从 5 个长到了 7 个)。承认这点比假装它固定要诚实。
 */
export type PhaseName =
  | 'plan' | 'review' | 'execute'
  // 测试验证:真的把测试跑起来,而不是读执行者的自述。
  | 'verify'
  | 'accept'
  // 集成提交:拆分型节点在子任务全部完成后的那一场裁决(INTEGRATION_ACCEPT)。
  // 此前它和叶子验收共用 phaseRoles.accept —— 用户只配「验收」,他的验收角色会被
  // 悄悄拿去跑集成验收,而规范刚告诉他这是两个不同的环节。
  | 'integrate'
  | 'observer'
export const PHASE_NAMES: PhaseName[] =
  ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer']

/** 环节的中文名 —— 用户文档、关口、错误信息都用它。内部 phase 名不对用户暴露。 */
export const PHASE_LABEL: Record<PhaseName, string> = {
  plan: '分析', review: '质疑讨论', execute: '执行',
  verify: '测试验证', accept: '验收', integrate: '集成验收', observer: '观察',
}

/**
 * 用户可以写的环节名 → 内部 phase 名。
 *
 * 落盘的永远是内部 phase 名(见 resumeCore 的读回校验),中文只是**输入别名**,解析时
 * 立刻归一。两边都当 canonical 会让 run.md 里出现两种写法,而读回那侧只认一种。
 */
export const STEP_ALIASES: Record<string, PhaseName> = {
  ...Object.fromEntries(PHASE_NAMES.map(p => [p, p])),
  ...Object.fromEntries(PHASE_NAMES.map(p => [PHASE_LABEL[p], p])),
  // 常见的另一种说法,收下比让用户猜要好。
  方案: 'plan', 评审: 'review', 打分: 'observer', 评分: 'observer',
  // 「集成提交」是这个环节的**旧名**。它不做任何合并 —— 合并早在每个执行型子节点
  // 自己通过验收时就发生了(stepExecute 里的 mergeAndRelease);这一关判的是
  // 「子任务的结果合起来达没达成父目标」。名字改成集成验收,旧名继续收,
  // 已经按旧名写过配置的人不会一夜作废。
  集成提交: 'integrate',
}

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
  // VERIFYING:测试验证环节。只在配了该环节角色时出现,否则这一步整个不存在。
  | 'VERIFYING'
  | 'SCORING' | 'MERGE' | 'ACCEPTED' | 'BLOCKED'

/**
 * 全部合法状态的**运行期**清单。
 *
 * resumeCore 的 LEGAL_STATUS 从它派生,不再手写一份字面量 —— 那份和 NodeStatus 类型脱钩,
 * 而这个仓库没有 typecheck:漏掉一个新状态不会有任何东西报错,后果是节点在恢复时被
 * 永久判死。同一处真相,两个消费者。
 */
export const NODE_STATUSES: NodeStatus[] = [
  'CREATED', 'PLANNING', 'PLAN_REVIEW', 'READY', 'EXECUTING', 'EXECUTED', 'ACCEPTANCE',
  'REWORK', 'WAITING_CHILDREN', 'INTEGRATION_ACCEPT', 'VERIFYING', 'SCORING', 'MERGE',
  'ACCEPTED', 'BLOCKED',
]

export interface RoleBinding {
  /**
   * 员工名 —— 一个可派发的 agentType,**永远不是角色名**。
   *
   * 找不到的名字在全链路都静默回落主模型(pickAgentDefinition → mainModelDefault、
   * effectiveModel → mainModel),所以往这里写角色名会让关口渲染出「架构师(claude-opus-4)」
   * ——看起来是绑好的员工,实际是主模型披了个名字。
   *
   * `MAIN_STAFF`(空串)是「主模型兼任」:它没有对应的 agentType,于是上面那两条回落链
   * 正好把这一席交给主模型 —— 这是想要的行为,不是漏网。
   */
  roleName: string
  model?: string
  /**
   * 这一席在演哪个任务角色(roleDefs 里的 name)。
   *
   * 席位归属存在这里而不是靠数组下标反推,是因为同一个员工可以同时担任两个角色 —— 名册
   * 里会出现两个 roleName 相同的席位,按 (阶段, 员工名) 反查是二义的。
   */
  roleTag?: string
}
/** 「主模型兼任」的员工名。见 RoleBinding.roleName。 */
export const MAIN_STAFF = ''
export interface NodePlan {
  solution: string; keyPoints: string; risks: string; acceptance: string
  /**
   * 圆桌模式下**落选的那几份稿**(见 caps.planConverge)。
   *
   * 只留 solution 一段并单独夹取到 ALT_SOLUTION_CHARS —— plan 的四个字段各自已经是
   * 8000 上限,再挂 4 份完整稿会让 plan 从 32KB 翻到 64KB,而 node.md 每次 commit 全量重写。
   *
   * 存它的理由是不静默截断:三份稿只产出一份,另外两份不能凭空消失。
   */
  alternatives?: { staff: string; solution: string }[]
}
/** 落选稿单条的字符上限。远小于 MAX_FIELD_CHARS,理由见 NodePlan.alternatives。 */
export const ALT_SOLUTION_CHARS = 1500
/**
 * `infra: true` marks a verdict the reviewer never actually rendered — the call itself
 * failed (network, provider error). It is NOT a judgement about the work, so a caller
 * must retry the review rather than treat it as a rejection and redo the executor's work.
 */
export interface Verdict {
  role: string; pass: boolean; blocking: string[]; comments: string; infra?: boolean
  /**
   * 这一席在演哪个任务角色(见 RoleBinding.roleTag)。
   *
   * 必须落在裁决上而不是只存在于 runRoundtable 内存里的 roster[i]:node.md 存的是
   * verdicts[],一次 --resume 之后「这几条裁决属于同一个角色的几个员工」就无从恢复,
   * 而按角色分组正是「一个角色多员工要收敛成一个结论」的前提。
   */
  roleTag?: string
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
   * 哪一种超时。**两种的补救办法相反**,所以只记一个 boolean 是不够的:
   * 静默超时要去提高 caps.nodeTimeoutMs 或把节点拆小,等人超时要去把那个权限确认点掉,
   * 和节点大小、和 nodeTimeoutMs 都没有关系。
   *
   * 只记 boolean 的代价实测过:分析、评审、验收、集成四个环节里三个把「没人来点确认」
   * 诊断对了,建议却给成了「提高 nodeTimeoutMs 后再重试,或把该节点拆小」—— 一句话的
   * 前后两半自相矛盾,而用户是照着后半句去做的。
   */
  timeoutKind?: 'stall' | 'human'
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
export interface RoundtableRecord {
  round: number; verdicts: Verdict[]; synthesized: { pass: boolean; blockingSummary: string }
  /**
   * 这一轮是**哪一关**开的。
   *
   * 测试验证和验收共用 acceptLog、也共用 iteration.acceptance 计数,于是 node.md 的
   * 「## 验收记录」里会出现两条 `round 1`,没有任何标记说明哪条是测试验证 —— 而升级
   * 卡片写的正是「先看该节点的验收记录」。省略 = 验收(老 node.md 的形状不变)。
   */
  step?: PhaseName
}
export interface ScoreRecord {
  role: string; score: number; rationale: string
  /**
   * 多员工评分时,**其余席位**的记录。主记录取最低分。
   *
   * 取最低分是对的(显示宽容的那个数会掩盖阈值要抓的情况),但只留最低分就把其余人的
   * 理由丢了 —— 那是静默截断。它们挂在这里:阈值判定、显示、持久化的既有消费者读主
   * 记录不受影响,而没有一条理由消失。
   */
  others?: { role: string; score: number; rationale: string }[]
}

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
  /**
   * 手工重做指定的**重入环节**。一次性,由 step* 在第一轮消费后立刻清掉。
   *
   * 为什么需要多这一个字:`advanceableKind` 只认三个座位(CREATED / READY / WAITING_CHILDREN),
   * 而 CREATED 这一个座位对应 `stepStart` 里的**两个**起点 —— 分析和质疑讨论。
   * 「从质疑讨论重做」要保留现有方案只重判一次,光靠 status 分不出来。
   *
   * 形状照 `confirmedDraft` / `mergeConflict`:一个持久化的标志选 step **内部**的入口,
   * 座位只负责让调度器把节点捡起来。这不是新发明,是这个文件里已经用了两次的模式。
   *
   * 落盘是白拿的(serializeNode 整节点倾倒),所以真正要补的是**读回**校验 ——
   * node.md 按设计可以手工编辑,而这个字段决定节点从哪个环节重入。见 resumeCore。
   */
  redoFrom?: PhaseName
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
  /**
   * 各阶段耗时 (spec §10.2) — accumulated milliseconds per ACTIVE status.
   *
   * The detail pane showed one aggregate number, which cannot answer the question someone
   * opens it with: a node that took 20 minutes because its executor is slow and one that took
   * 20 minutes because it was reviewed four times look identical.
   *
   * Keyed by NodeStatus rather than PhaseName because that is what `commit` actually observes,
   * and the two do not map one-to-one — REWORK and EXECUTING are both the execute phase but
   * mean very different things to someone reading the number.
   */
  phaseMs?: Partial<Record<NodeStatus, number>>
  /**
   * 这个节点**自己**花掉的模型调用次数与 token(不含子节点)。口径见 `usage.ts`。
   *
   * 只记自己那一份,子树合计在**读的时候**沿 childIds 现算 —— 存合计的话,一个节点的
   * 用量变化要同时改它到根的每一个祖先,而这条链上任何一次崩溃/重做都会让那些数字
   * 永久性地对不上,却没有任何东西会报错。现算是 O(子树),而树的上限是 maxNodes。
   *
   * 由 `runAgentAdapter` 在每条模型消息到达时累加,`commit()` 顺手落盘(serializeNode
   * 整节点倾倒)。**重做不清零** —— 钱是真花掉了的。
   */
  usage?: UsageTotals
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

export interface Caps {
  maxDepth: number; maxNodes: number; maxIterations: number
  /**
   * 一次子 agent 调用**没有任何进展**多久算挂死(毫秒)。
   *
   * 量的是「静默时长」,不是「总时长」。只要还在往外吐消息(模型说话、调工具、工具
   * 返回)就一直不算超时 —— 一个读二十个文件、跑一遍测试、改几处代码的执行环节,
   * 正常就要十几分钟,而它一秒都没卡住。原来量总时长,这类节点会被当成挂死杀掉,
   * 阻断信息还教用户「把节点拆小」。
   *
   * **等人回答的时间不算在这里**,它有自己的预算(见 humanTimeoutMs)。
   */
  nodeTimeoutMs: number
  /**
   * 等**人**回答一次工具权限确认最多等多久(毫秒)。
   *
   * 和 nodeTimeoutMs 是两件完全不同的事,混成一个是实测出来的坑:权限确认
   * (canUseTool)就发生在阶段调用的窗口里,于是「用户去泡了杯咖啡」和「provider
   * 挂死了」共用一个 10 分钟的预算 —— 回来一看节点已经阻断,而给的建议是
   * 「提高超时或把节点拆小」,两条都不对症。
   *
   * 默认给得很大(7 天):人不在键盘前是常态,而这条阀要挡的只是「永远没人回答」。
   */
  humanTimeoutMs: number
  scoreThreshold?: number
  /**
   * 一个阶段最多几席。超出的席位被剔除并点名。
   *
   * 多对多会把调用数乘起来:一个阶段 R 个角色、每个角色 S 个员工 = R×S 次调用,每轮
   * 评审都要付一遍。这是唯一能同时按住成本乘子和阻断率的旋钮。
   */
  maxSeatsPerPhase?: number
  /**
   * 圆桌通过所需的**赞成比例**(1-100),默认 100 = 全票。
   *
   * 为什么需要这个旋钮:纯 AND 下加席位只能把「通过」变成「不通过」。每席独立 80% 通过
   * 率的话,9 席全票通过的概率是 0.8^9 ≈ 13%,三轮都用尽的概率约 65% —— 不给这个旋钮,
   * 「一个角色多个员工」就是自我拆台:配的人越多,越跑不完。
   *
   * 分母**不含 infra 失败**:调用没打通不是一票反对,那种情形由 isInfraOnlyFailure 走重试。
   */
  quorum?: number
  /**
   * 通过所需的**赞成席位数**(绝对数),和 quorum 二选一或并用(并用时取更严的那个)。
   *
   * 为什么百分比不够:用户会说「至少 2 个人通过」。那句话抽成 quorum=2 会落在合法区间
   * 里、夹取不报警,而 2% 的含义是「1 席赞成就放行」—— 用户想收紧,实得几乎没有门槛,
   * 而且错在**放宽**方向。人数说法必须有自己的字段。
   */
  quorumSeats?: number
  /**
   * 分析环节多员工时怎么收敛成一份方案。默认 `'精化'`。
   *
   * - `'精化'` —— 顺序:第一位起草,后面每一位在**前一稿**上修订。全程一份稿子。
   * - `'圆桌'` —— 并行:N 位各自从零起草,再由**最后一席**融合成一份最优解。
   *
   * 为什么在 caps 而不是角色上:席位是 (角色 × 员工) 展平成的一个扁平列表,两个分析
   * 角色时「谁的模式说了算」无定义;而最常见的配置路径(按名字直接指定员工)根本没有
   * 角色定义,字段无处可挂。caps 这一层已经有读回 + 夹取 + 关口展示的现成范式。
   *
   * 默认保持精化:改默认会让已经配了多席的用户什么都没动,而成本和形态都变了。
   */
  planConverge?: '圆桌' | '精化'
}
export const DEFAULT_CAPS: Caps = {
  maxDepth: 5, maxNodes: 100, maxIterations: 3,
  // 静默 10 分钟 = 挂死。作为「一条消息都不吐」的判据,这个数已经很宽松了。
  nodeTimeoutMs: 600_000,
  // 7 天。人不在键盘前是常态。
  humanTimeoutMs: 7 * 24 * 60 * 60 * 1000,
}
/** 一个阶段的席位上限默认值。 */
export const DEFAULT_MAX_SEATS_PER_PHASE = 5

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
  /**
   * 角色定义(§员工/角色)。配置文件 + 提示词合并后的结果,该 run 的快照。
   *
   * 必须被 `readRunManifest` 读回:`writeRunManifest` 整文件重写 run.md,一个只写不读的
   * 字段会在第一次 --resume 时清零 —— 于是恢复后的评审席位还在,而它们的职责简报没了,
   * 名册看起来一模一样,模型收到的东西却变了。`resumes` 已经踩过这个坑。
   */
  roleDefs?: RoleDef[]
  /**
   * 跑完了、但用户还没决定怎么处置集成分支(§8 收口)。
   *
   * 为什么必须是**持久**状态而不是内存里的一个关口:run.md 的 `status` 只在最后一次写入
   * 时带上,所以盘上会先出现 `status: completed`,而集成分支还没人处置。用户此时**直接
   * 关终端**(不是按 Esc)→ 关口消失 → `--resume` 的 reseat 只捞活动态节点,根节点已经
   * ACCEPTED → **什么都不会重开**,那条分支永远留在那没人管。
   *
   * 所以恢复路径必须**独立于 status 和节点状态**检查这个字段。
   */
  pendingHandoff?: PendingHandoff
  /**
   * 被整个跳过的环节。
   *
   * **跳过 ≠ 不配角色。** 0 席在七个环节里有五个的语义是「主模型顶上跑一次」
   * (plan/review/execute/accept 各跑一次主模型,integrate 回落到 accept 席位),只有
   * verify 和 observer 是真的不发生。所以跳过**绝不能**实现成「清空席位」—— 那是把用户
   * 配的三席评审团换成主模型独审,比不跳过更糟,而关口会显示「验收: 主模型(…)」,
   * 看起来像正常配置。跳过只能是各 step 里的显式早退分支。
   */
  skipSteps?: PhaseName[]
}

/** 待收口的集成分支快照(§8)。字段与 worktreePool.handoff() 的返回一致。 */
export interface PendingHandoff {
  branch: string
  commits: number
  integrationPath?: string
  kept: { path: string; why: string }[]
  salvage: string[]
  /** run 是正常跑完还是被阻断/取消 —— 别邀请用户合并一棵没做完的树。 */
  outcome: 'completed' | 'blocked'
  reason?: string
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
  // 从 PHASE_NAMES 派生,不写字面量:少一个键,下游那一串无保护的 phaseRoles[p]
  // 会直接抛 TypeError(实测 createNode 的展开就先炸了)。
  return Object.fromEntries(PHASE_NAMES.map(p => [p, [] as RoleBinding[]])) as Record<PhaseName, RoleBinding[]>
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
      // ?? []:老 run.md / 手写双件可能缺新增的环节键,少一个就在这里抛 TypeError。
      PHASE_NAMES.map(p => [p, [...(args.phaseRoles[p] ?? [])]]),
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
