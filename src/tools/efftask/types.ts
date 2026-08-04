// 纯类型导入,编译期擦除 —— roleDefs.ts 对本文件是值依赖(PHASE_NAMES/MAIN_STAFF),
// 所以这条反向依赖必须是 `import type`,否则就成了真实的运行期循环。
import type { RoleDef } from './roleDefs.js'
import type { Strictness } from './strictness.js'
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

/**
 * 节点**正在干活**的那几个状态(相对于「在排队」「在等子任务」「已终结」)。
 *
 * 三个消费者共用一份:`pipeline.commit` 拿它决定给哪些状态记耗时与时间点、
 * `startedAt` 拿它认「首个活动阶段」、`resumeCore` 拿它校验盘上 `phaseMs`/`phaseAt`
 * 的键。各写一份的后果是**最松的那一份说了算**:评审实测,一个手改的
 * `phaseAt: { ACCEPTED: … }` 通过了只按 NODE_STATUSES 判的校验,详情页于是印出一行
 * 没有中文标签的 `ACCEPTED 18:07:00 → 进行中` —— 内部枚举名直接摆到用户面前。
 */
export const ACTIVE_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'VERIFYING', 'ACCEPTANCE', 'REWORK',
  'INTEGRATION_ACCEPT', 'SCORING', 'MERGE',
])

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
   * 方案作者对**上一轮**质疑讨论每一条阻断意见的逐条处置。一条意见一项。
   *
   * 为什么必须是一个字段,而不是让作者把话写进 `solution` 里:
   *
   * `planFeedbackPrompt` 早就在要求作者「必须逐条明确回应:要么在方案里解决,要么写明
   * 为什么不适用」,而 `reviewRepeatNotice` 也早就在要求评审员「指出是方案的哪一处回应
   * 了它」。两句话都在,**中间那个存放答案的地方不在** —— 作者的回应无处可写,评审员
   * 只能拿着新旧两版方案自己去反推「这一条到底算不算被回应了」。反推是要靠猜的,而
   * 猜出来的结论每一席、每一轮都不一样。用户量到的就是这个:「第一轮未过,有了修改意见
   * 第二轮必定要过 —— 感觉现在全靠随机。」
   *
   * 空 / 缺席 = 这一轮没有上一轮(第 1 轮),或者作者一条都没回应 —— 后者本身就是评审员
   * 该看见的事实,所以**不补默认值**。
   */
  responses?: string[]
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
/**
 * 人工强制通过那条裁决的 `role`。
 *
 * **不是角色名,而且刻意不像角色名。** 它会和真正的评审员并排渲染在 node.md 的
 * `## 评审记录` 里(`- [人工强制通过] MANUAL: …`),而那一节是用户事后追责的依据 ——
 * 唯一不能发生的事是它被读成「有一位叫这个名字的评审员通过了」。
 *
 * 用户配的角色名撞上它也无所谓:`manual` 那个布尔才是判据,这个字符串只管显示。
 */
export const MANUAL_PASS_ROLE = '人工强制通过'

export interface Verdict {
  role: string; pass: boolean; blocking: string[]; comments: string; infra?: boolean
  /**
   * 这一条不是模型给的,是**人**按下强制通过按出来的。
   *
   * 判据只能是这个布尔,不能是 `role === MANUAL_PASS_ROLE`:role 是显示用的字符串,
   * 而 node.md 可以手工编辑 —— 拿它当判据等于让「把角色名改成这四个字」成为一条伪造
   * 人工放行的路。反过来这个字段被手改成 true 也只是让一条真实裁决**被标成人工**,
   * 那个方向是保守的(读记录的人会去核对),而另一个方向是把人工放行伪装成评审通过。
   *
   * 消费者只有渲染层(persistence 的 roundtableBody、详情页):它不参与任何判定 ——
   * `synthesized.pass` 已经是 true,路由早就走完了。
   */
  manual?: boolean
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
  timeoutKind?: 'stall' | 'human' | 'total'
  /**
   * 这一席是被**上游限流**挡回来的(429/529),不是打不通。
   *
   * 和 `timeout` 逐字同因:两者都是 `infra`(没人对工作做出判断,重试是对的),但
   * **补救建议不同** —— 限流要等一会儿、或者把并行数/席位数调小,而默认那版
   * 「先确认角色模型/网络可用」在上游明明是通的时候会让用户去查一个不存在的问题。
   *
   * 少了这个字段的后果实测过:`runRoundtable` 把 rejection 合成 infra 裁决时只带
   * `timeout`,于是圆桌耗尽走的 `exhaustionCategory`/`exhaustionRemedyFor` 拿不到任何
   * 能分辨限流的信息 —— 而**多角色圆桌正是用户报 429 的那个场景**。
   */
  rateLimited?: boolean
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
   * 这一桌是按**哪一档严格度**判的。
   *
   * 必须记,而且必须**读得回来**:档位可以在运行中调,于是「第 1 轮按专家判不通过、
   * 第 2 轮降到中级判通过」这件事在盘上必须读得出来。少了它,`reviewRepeatNotice` 会把
   * 专家档提的意见原样铺进中级档那一轮的提示词,而那段话里「若仍未回应,请指出缺了
   * 什么」是一条**无条件的追责指令** —— 降档等于没降,而且是静默的。
   *
   * 省略 = 没设档位(现状:全票 + 判据空白)。老 node.md 里全是这个形状。
   */
  strictness?: Strictness
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
  /**
   * 执行者对**上一轮**测试验证 / 验收每一条阻断意见的逐条处置。一条意见一项。
   *
   * 和 `NodePlan.responses` 是同一件事的执行侧那一半,理由逐字相同(见那里)—— 只是这
   * 一侧更贵:每一轮返工都要多付一次带写工具的执行调用。
   *
   * **不并进 `execStatus`。** execStatus 是「这一轮做了什么」的自述,而这里是「上一轮那
   * 几条各自怎么处置的」;混在一段自由文本里,裁决员就得先把它俩拆开才能逐条核对,而
   * 那正是这个字段要消掉的那次反推。分开还有一个硬理由:`integratePrompt` 会把 execStatus
   * 原样铺给集成验收席位,而那一关判的是另一件事,不该收到叶子层的返工问答。
   *
   * **每一轮无条件覆写**(包括覆写成 undefined):留着上一轮的回应,裁决员会拿着一份
   * 描述两轮之前的答卷去核对这一轮的产出。
   */
  execResponses?: string[]
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
   * 这个节点是**被用户点名取消**的(面板上按 x),不是整个 run 被中断扫到的。
   *
   * 两者都会置 `interrupted`(取消不是判决,`--resume` 要能重新排队它),但**在重做那条
   * 路上它们的语义相反**:
   *  - 整个 run 被 Esc 扫成 BLOCKED 的那一批,是意外,重做时要连带放开
   *    (见 `reopenPropagatedBlocks` 的 includeInterrupted);
   *  - 而这一个是用户看着它、按下了 x —— 那是一个决定。别人重做一个不相干的节点时
   *    把它悄悄复活,等于替他改主意。
   *
   * **必须是字段,不能拿理由文本判。** 两者的 `blockedReason` 都是我们自己写的中文串,
   * 而 node.md 按设计可以手工编辑;一个共享的字面量不是接口(这条规矩在 `interrupted`
   * 和 `capBlocked` 上各付过一次学费)。
   *
   * 两个方向都写:一个曾经被取消、后来重跑并因别的原因失败的节点,不能带着旧标记 ——
   * 那会让它在下一次重做里被永久摁住。
   */
  cancelled?: boolean
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
  /**
   * 被阻断的那一刻,节点**正处在哪个状态** —— 也就是「是哪个环节失败的」。
   *
   * 用户的原话:「对于失败的任务,有键可以快速重做失败的阶段或跳过失败的阶段」。这两个键
   * 都必须先回答「哪个阶段失败了」,而 `status` 那一刻已经被改写成 `BLOCKED`,那个信息就
   * 没了。
   *
   * **记下来,不反推。** 和 `capCategory` 逐字同因(见它的注释:反推被卡片自己的建议打败了)。
   * 从 `iteration` 和日志反推同样站不住:验收和测试验证共用 `iteration.acceptance`、
   * 共用 `acceptLog`,而「评审三轮没过」和「评审员一直打不通」在计数上一模一样。
   *
   * **只在节点自己失败时记**,`propagateBlocked` 那条路(子节点阻断 / 上级任务阻断 /
   * 依赖阻断)一个字都不写:那不是这个节点的失败,而记上去的后果是快捷键在一个「其实是
   * 它孩子挂了」的父节点上提供「重做集成验收」。留空时界面会照实说「这个节点不是自己
   * 失败的」并指向真正失败的那个。
   *
   * 由 `commit()` 维护 —— 每一次 BLOCKED 都必经它,而它是唯一还看得见上一个状态的地方;
   * 同时**任何非阻断的推进都会把它清掉**,所以一个被重做过的节点不会带着旧失败点。
   */
  failedAt?: NodeStatus
  /**
   * 手工**跳过**的那一个环节。一次性,由用到它的那个 step 消费后立刻清掉。
   *
   * 用户的原话是「跳过失败的阶段,继续往下走」。和 `config.skipSteps`(整个 run 都跳)
   * 的区别是它只作用于这一个节点、这一次:一个反复被验收挡下的节点,用户自己看过产出之后
   * 说「就这样吧」,不该因此让**后面每一个**节点都不再验收。
   *
   * 只可能是 review / verify / accept / integrate 四个之一 —— 那是「活干完了、判的人不放行」
   * 的四个环节。跳过分析或执行的语义是「这个节点什么都没做」,那不是跳过,是放弃,
   * 而放弃有它自己的入口(见 redo.ts 的 skipFailedPhaseReason)。
   *
   * 落盘是白拿的(serializeNode 整节点倾倒),所以真正要补的是**读回**校验 —— 见 resumeCore。
   */
  skipPhase?: PhaseName
  /**
   * 手工**强制通过**的那一个环节。一次性,和 `skipPhase` 同寿、同白名单、同消费方式。
   *
   * **和跳过的区别只有一个,但那一个是全部理由:留不留下一条裁决。**
   * 跳过说的是「这个环节这次不发生」,`pipeline` 那四处刻意不写 log(见 review 分支上
   * 「一条 PASS 记录 = 谎报有人评审过」那条注释);强制通过说的是「圆桌没通过,我看过了,
   * 我放行」——那是一个**人做出的判断**,它必须在 node.md 上留痕,否则事后翻记录的人
   * 看到的是一片空白,分不清「没人看过」和「有人看过并拍板」。
   *
   * 所以写进 log 的那条记录必须**一眼看出是人写的**:`role` 是 MANUAL_PASS_ROLE 而不是
   * 任何角色名,`Verdict.manual` 为真,而被它覆盖掉的那一轮的阻断项原样留在 comments 里。
   * 伪装成一席角色的 pass 是这个字段唯一不能犯的错 —— 那等于给事后追责的人下毒。
   *
   * 路由上和跳过**逐字相同**(planForcePass 直接复用 planSkip 的重入座位计算):环节照样
   * 不发生,执行者照样不重跑。省下的钱、走过的路都一样,差的只是那条记录。
   *
   * 只可能是 SKIPPABLE_PHASES 那四个。落盘白拿,读回要校验 —— 而这一条比 skipPhase
   * **更要紧**:一个手写的 forcePass 不只是零调用判 ACCEPTED,还会在 log 里留下一条
   * 「有人放行过」的假记录。见 resumeCore。
   */
  forcePass?: PhaseName
  /**
   * 重做 / 跳过时,用户**补给这个节点**的提示词。
   *
   * 用户的原话有两句:「重做失败的阶段,可以塞新的提示词给这个阶段」和「重做整个子任务时,
   * 可以塞新的提示词给这个子任务」。所以键是**环节**,`'all'` 那一条是「给整个节点」——
   * 任务重做走的就是它。
   *
   * **同一个键再写一次是替换,不是追加。** 用户的说法是「塞新的提示词」:第二次重做执行
   * 环节时补的那句话就是现在的指令,把上一次的也一起发过去会让两条互相打架,而模型看不出
   * 哪句更新。代价是旧那句话没了 —— 所以它同时会显示在详情页的「补充指引」段落里,
   * 用户按下确认之前和之后都看得到自己写的是什么。
   *
   * **裁决类环节看得到全部**(不只是给它自己那一条),这一条是拿实测换来的:用户补
   * 「别动 src/legacy」→ 执行者照做 → 验收员拿着补话之前定下的验收点对照产出 → 判不通过
   * → 返工 → 撞满迭代上限阻断。用户自己那句纠正成了这个节点失败的直接原因。
   * 见 pipeline.ts 的 JUDGE_NOTE,那是同一个坑的第一次。
   */
  guidance?: Partial<Record<PhaseName | 'all', string>>
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
   * 每个阶段的**时间点**:第一次进入、最后一次离开。
   *
   * 用户原话:「任务运行和阶段运行,都要有具体的运行时间点,现在只有一个运行了多长时间。」
   * 一个「执行 749s」回答不了他真正在问的问题 —— **那是什么时候发生的**:一段 12 分钟的
   * 执行是刚刚在跑,还是两小时前就跑完了、之后一直卡在等验收?两者在屏幕上一模一样,
   * 而它们要做的事完全相反。
   *
   * `first` 只写一次,`last` 每次离开都覆盖 —— 一个返工三轮的节点在 EXECUTING 上的
   * 「第一次开始」和「最后一次结束」正好圈出它的全部执行窗口,而中间那几轮的分段
   * 由 `phaseMs`(累计)和输出页卡里那几条流(每轮一条)各自回答。
   *
   * `last` 缺席 = **进了但还没出来**(正在跑,或者进程被杀在这一步)。渲染时照实说,
   * 不要拿 `now` 填 —— 那会让一个两天前被杀掉的节点显示成「刚刚还在跑」。
   *
   * 和 `phaseMs` 分开存而不是塞进同一个对象:那个字段是数字映射,读回校验按数字写的,
   * 混进一个对象会让手工编辑过的 node.md 在渲染层炸开。
   */
  phaseAt?: Partial<Record<NodeStatus, { first: string; last?: string }>>
  /**
   * 进入**终态**(已验收 / 阻断)的时刻。
   *
   * 和 `startedAt` 成对:一个是「什么时候开始跑的」,一个是「什么时候有结论的」。少了它,
   * 一个已经结束的节点在界面上只能显示「跑了多久」,而那个时长是从 `updatedAt` 反推的 ——
   * 任何一次 `--resume` 的重新落盘都会把它改掉。
   *
   * 两个方向都写:重做/归位把节点放回队列时清掉,否则一个正在重跑的节点会顶着上一次的
   * 结束时刻,而界面拿它当「已经结束」的证据。
   */
  finishedAt?: string
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
  /**
   * 被**任务重做**删掉的那棵子树一共花了多少 —— 记在重做目标身上。
   *
   * 不记的话表头那个总数会当着用户的面倒退(验收实测一次重做掉了 83%),而少报的正好是
   * 被丢弃的那部分工作 —— 也正是他按下 `r` 的那一刻最想知道的数。节点跟着 commit()
   * 落盘,`--resume` 白拿。
   *
   * 和 `usage` 分开而不是并进去:「这个节点自己花了多少」和「我为一次推倒重来付了多少」
   * 是两个问题,合成一个数之后哪个都答不了。
   */
  discardedUsage?: UsageTotals
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
  /**
   * 一次运行里,同一个节点最多**自动解几次合并冲突**。默认 6。
   *
   * 为什么这么多:每一次解决之后都要重跑一次验收,而**被验收否决**是这条路上最常见的
   * 结局 —— 而否决理由恰恰是解决者最需要、上一次调用时还不存在的信息。给的次数就是
   * 「带着新意见再改一版」的次数;给 1 次等于「第一版就得对」,而叫醒一个人的代价比
   * 多打几次模型调用高得多。
   *
   * **按运行计,不是终身计**(见 PipelineCtx.mergeResolveThisRun):`--resume` 回来重新
   * 给满。所以这个数是「一口气自己试几次」,不是「这个节点这辈子的额度」。
   *
   * 0 是合法值,含义是**关掉自动解决**:冲突直接升级人工。想要旧那种「只试一次」的
   * 行为写 1。
   */
  mergeResolveAttempts?: number
  /**
   * 严格度档位 —— 四个裁决环节「多好才算够」的那把尺子。见 `strictness.ts` 的文件头。
   *
   * **它是一个独立的枚举字段,数值在使用点派生,永不回写 `quorum` / `maxIterations`。**
   * 这一条是评审拿两条真实后果换来的:
   *
   *  1. 回写之后,run.md 落的是数字,`--resume` 读回时「档位派生的 51」和「用户亲手写的
   *     51」在盘上**逐字相同** —— 关口承诺的两行显示(`严格度 中级` + `你指定:quorum 80`)
   *     在第一次恢复之后当场变成假的。
   *  2. `maxIterations` 在 `Caps` 里是**必填**字段、`DEFAULT_CAPS` 恒给 3,所以「用户显式
   *     写了 3」和「默认就是 3」根本区分不出来,「显式覆盖档位」这条规则在那一维上不可判定。
   *
   * 缺省 `undefined` = 现状 = 全票 + 判据空白。**不要给它一个具名默认档**:默认成高级会让
   * 一个原本全票跑的旧 run 在恢复后变成 quorum 80(5 席下 4/5),也就是**恢复之后变松了**。
   */
  strictness?: Strictness
}
/** `caps.mergeResolveAttempts` 的合法区间。一份真相,parseDirectives / resumeCore 共用。 */
export const MIN_MERGE_RESOLVE = 0
/**
 * 上限 20。再往上不是给用户更多能力,而是让一个**解不动**的冲突把整轮预算烧在同一棵
 * 越改越脏的树上 —— 每一次都从上一次改过的状态开始,而且每一次都要再开一场验收圆桌。
 */
export const MAX_MERGE_RESOLVE = 20
export const DEFAULT_CAPS: Caps = {
  maxDepth: 5, maxNodes: 100, maxIterations: 3,
  // 6 次自动解冲突。理由见 Caps.mergeResolveAttempts —— 关键是「叫醒人」的代价。
  mergeResolveAttempts: 6,
  // 静默 10 分钟 = 挂死。作为「一条消息都不吐」的判据,这个数已经很宽松了。
  nodeTimeoutMs: 600_000,
  // 7 天。人不在键盘前是常态。
  humanTimeoutMs: 7 * 24 * 60 * 60 * 1000,
}
/**
 * **可以手工跳过**的环节 —— 「活干完了、判的人不放行」的那四个。
 *
 * 三个消费者共用一份:`redo.ts` 决定屏幕上给不给这个动作、`pipeline.ts` 决定跑的时候认不认、
 * `resumeCore.ts` 决定盘上读回来的值合不合法。各写一份的话,最松的那一份就是实际生效的那一份。
 *
 * **plan 和 execute 不在其中,而这是一条语义界线,不是保守。** 跳过分析 = 带着空方案进评审;
 * 跳过执行 = 一行代码都不写就去验收。这两件事的名字叫「放弃这个节点」,不叫「跳过一个环节」,
 * 而放弃有它自己的入口(整个 run 的 `skipSteps`,在启动关口上摆明后果让用户批准)。
 * observer(观察评分)也不在其中:它不会挡住任何节点 —— 低分只触发一轮返工,而返工额度
 * 用尽本来就会往下走。给它一个「跳过」按钮是在解决一个不存在的阻塞。
 */
export const SKIPPABLE_PHASES: ReadonlySet<string> = new Set<PhaseName>(['review', 'verify', 'accept', 'integrate'])

/**
 * 一条补充指引的长度上限(按码点)。
 *
 * 和 `MAX_DIRECTIVE_CHARS` 同一个数、同一个理由:整段提示词是要付钱的,而用户可能粘一整个
 * 文件进来。两处都是「用户在运行中/重做时补的一句话」,给不同的上限只会让人困惑。
 */
export const MAX_GUIDANCE_CHARS = 2000

/**
 * 点名给角色/员工的额外要求最多几条。
 *
 * 和 `MAX_DIRECTIVES` 同一个数、同一个理由,而这里的乘子更大:每一条都要和**每一个**
 * 名字对得上的席位见面,而席位本身已经是 (角色 × 员工) 展平的。评审实测 40 条合计
 * 80190 码点,让评审那一席单次前言到 181446 码点。
 */
export const MAX_ROLE_GUIDANCE = 20

/** 一个阶段的席位上限默认值。 */
export const DEFAULT_MAX_SEATS_PER_PHASE = 5

export const DEFAULT_PARALLELISM = 5
/**
 * 并发上限的**合法区间**。
 *
 * 一份真相,三个消费者:`parseDirectives` 的夹取、运行中调整并发度的夹取、以及关口上
 * 那句「最多能调到多少」。原来 64 这个数只写在 parseDirectives 的一句 `clampInt(…, 1, 64, …)`
 * 里 —— 而运行中调整并发度是**第二条**写入路径,两边各写一个字面量的话,它们迟早会不一致,
 * 而不一致的那一次用户会发现自己在关口上被拒绝的数字,在运行中调得进去。
 *
 * 下限是 1 而不是 0:0 的语义是「一个都不许跑」,而调度器对 `<=0` 的预算返回空批次 ——
 * 树会当场被判成「走不动」并以 blocked 收尾。想暂停请按 p,那条路是可逆的。
 */
export const MIN_PARALLELISM = 1
export const MAX_PARALLELISM = 64
/** 把任意输入夹进合法区间。非有限值(NaN/Infinity/手改的 run.md)回落到 fallback。 */
export function clampParallelism(v: unknown, fallback = DEFAULT_PARALLELISM): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(MAX_PARALLELISM, Math.max(MIN_PARALLELISM, n))
}
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
   * 提示词里**点名给某个环节**的那几句话(§定向注入)。
   *
   * 用户的原话:「/et 写提示词时,有些内容是关注某些阶段或者角色的,会将其提示词内容扩展
   * 给注入到对应阶段或角色」。在这之前整段提示词只有一个去处 —— `goalPrompt`,它进的是
   * **根节点的目标**。于是「评审时重点看并发安全」这句话的实际去处是:根方案作者读到它,
   * 然后它被 plan 的产出覆盖掉,评审员一个字都看不到(评审提示词只吃 `node.plan`)。
   *
   * 键是内部 phase 名(中文别名在解析时就归一了,和 skipSteps 同一条规矩)。
   *
   * 必须被 `readRunManifest` 读回 —— `writeRunManifest` 整文件重写 run.md,一个只写不读的
   * 字段会在第一次 `--resume` 时清零:恢复后的名册一模一样,而模型收到的东西变了。
   * `resumes` 和 `roleDefs` 都踩过这个坑。
   */
  phaseGuidance?: Partial<Record<PhaseName, string>>
  /**
   * 提示词里**点名给某个角色/员工**的那几句话(§定向注入)。
   *
   * `name` 可以是任务角色名(「架构师」)也可以是员工名(「opus-架构」)—— 用户两种说法都用,
   * 而席位上同时有 `roleTag`(角色)和 `roleName`(员工),两边都比一次。
   *
   * 数组而不是 map:同一个名字被点两次是用户的自由(「架构师注意 A」「架构师还要注意 B」),
   * 而 map 会静默丢掉第一条。
   */
  roleGuidance?: { name: string; text: string }[]
  /**
   * 用户在关口上选的**隔离方式**。`undefined` = 没选过,按默认(worktree)走。
   *
   * **这是「他要什么」,不是「实际是什么」。** 两者必须分开:一个 `worktree` 的选择在
   * 非 git 目录里根本兑现不了,而命令层那个 `isolation: 'worktree' | 'none'` 状态说的是
   * **这一趟真的隔离了没有**(池子建起来了没有)。把两件事塞进一个字段的下场是关口显示
   * 「worktree 隔离」而执行者在用户的检出里改代码 —— 这个关口存在的全部意义就是别说这种话。
   *
   * 选 `shared` 的代价在关口上写明:执行阶段共享当前工作目录、并被强制串行。
   */
  isolation?: 'worktree' | 'shared'
  /**
   * 跑完之后怎么**收口**。`undefined` = 没选过,按默认(merge)走。
   *
   * - `merge`(主干开发):跑完就把集成分支合回你**当前的分支**。三个前提仍然照查
   *   (run 正常完成、工作区没有已跟踪改动、不是 detached HEAD),见 finishHandoff。
   * - `keep`(分支开发):不自动合,产出留在 `efftask/<runId>` 分支上,由你自己 PR/合并。
   *
   * 非隔离运行下这个字段没有意义(产出本来就在当前目录里,压根没有集成分支)。
   */
  finish?: 'merge' | 'keep'
  /**
   * 跑完之后自动 `git push`。默认 **false**。
   *
   * 推送是对外动作、不可撤销,而且我们不知道用户的远程分支策略 —— 所以它是一个必须由人
   * 打开的开关,不是默认行为。推哪一条跟着 `finish` 走:合回当前分支就推当前分支,
   * 保留分支就推那条集成分支。
   *
   * 失败**不回滚已经完成的合并**:合并已经发生了,把它说成没发生才是假话。
   */
  autoPush?: boolean
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
