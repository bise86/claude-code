// 中途升级 (spec §9): "触阀、合并冲突升级、连续返工超限 → 复用确认竞速器 + 飞书卡片",
// and §11: "触任何阀:暂停 + 飞书升级,不静默截断、不谎报完成。"
//
// The merge-conflict half of that shipped first and lives in conflictEscalation.ts. This is
// the other half — the safety valves. Same rules as that module and for the same reasons:
//
//  - PURE. The send path rides the SHARED FeishuClient owned by useFeishuBridge, which is
//    untestable by repo convention. Keeping the CONTENT pure keeps the part that can be wrong
//    — what the user is told — under test.
//  - The card must carry a 处理方式 that is TRUE. A cap-blocked node is not reopened by a
//    plain `/et --resume`: `reseatTransientNodes` only reopens interrupted and merge-conflict
//    nodes, so an instruction to "just resume" would send the user to a run that reproduces
//    the identical block having made zero model calls. `--retry-blocked` is the flag that
//    makes the instruction true, and it exists because this card needed to be honest.
import type { BlockCategory, TaskNode } from './types.js'
import { PHASE_LABEL } from './types.js'
export type { BlockCategory }

/**
 * Why the node stopped. Structural, because the card's whole content is chosen from it and
 * because `--retry-blocked` must never resurrect a node blocked by disk damage.
 *
 * The union itself lives in types.ts so TaskNode can name it without an import cycle; the
 * per-member documentation stays here, next to the cards that render each one.
 */
type BlockCategoryDoc =
  /** 方案评审 / 拆分 迭代超限 (caps.maxIterations). */
  | 'cap-iteration'
  /** 整棵树的节点数超过 caps.maxNodes,拆分被拒。 */
  | 'cap-nodes'
  /** 连续返工超限 —— 执行结果反复未通过验收 (spec §9 名字就是这个)。 */
  | 'rework'
  /** 单节点阶段调用超过 caps.nodeTimeoutMs,已被中止。 */
  | 'timeout'
  /** 角色调用连续失败,没有任何人真正裁决过这份工作。 */
  | 'infra'
  /**
   * 深度上限 (caps.maxDepth)。The ONLY valve that does not stop its node: spec §11 says
   * "该分支不再拆,强制 `executable` 或 BLOCKED 升级", and this implementation takes the
   * first branch — the children the planner asked for are folded into the node's own
   * solution and it keeps going. Still announced, because "触任何阀:…不静默截断" means the
   * user gets to know the tree was flattened, not just that it succeeded.
   */
  | 'cap-depth'

export interface BlockEscalation {
  node: TaskNode
  /** The reason as recorded on the node — quoted, never paraphrased. */
  reason: string
  category: BlockCategory
  /**
   * Did this trip actually STOP the node?
   *
   * Not derivable from the category alone. `cap-nodes` stops a node when it trips during
   * decomposition (stepStart blocks) but NOT when it trips during dynamic growth (growTree
   * refuses the graft and the node carries on to ACCEPTED). Measured: the growth path sent a
   * card reading 该节点已停…以「被阻断」收场 for a node whose real state was ACCEPTED with an
   * empty blockedReason, and told the user to run `--retry-blocked`, which matched nothing.
   *
   * Defaults from the category when the caller does not say.
   */
  stopped?: boolean
  /** 按事实定的 处理方式;省略则用静态表。见 blockReasonWithRemedy。 */
  remedy?: string
}

const TITLE: Record<BlockCategory, string> = {
  'cap-iteration': '安全阀 · 方案拆分迭代超限',
  'cap-nodes': '安全阀 · 任务树节点数超上限',
  rework: '连续返工超限',
  // 「执行超时」教的是「跑太久了 → 把节点拆小」,而这条阀量的是**静默**:一直在吐字就
  // 永远不算。标题是用户最先读的一行,它必须和正文、和运行期抛出的那句话说同一件事。
  timeout: '安全阀 · 静默超时(久到一个字都没有)',
  infra: '角色调用连续失败',
  'cap-depth': '安全阀 · 已达最大拆分深度',
  // NOT an 安全阀 heading: nothing tripped and nothing stopped. The node just recovered.
  revise: '集成验收未通过 · 已自动追加补救子任务',
  // 同样不是 安全阀 抬头,理由和 revise 逐字相同:轮数到顶了,但节点**没有停** ——
  // 它带着这一关提的意见继续往下跑。写成「安全阀 · 方案评审迭代超限」会让用户去
  // 抢救一个正在正常工作的运行。
  degrade: '判决未通过 · 已带着意见降级放行',
}

/**
 * What to change BEFORE retrying. Category-specific, because "retry it again unchanged" is
 * useless advice for most of these: the same cap trips at the same place.
 */
const REMEDY: Record<BlockCategory, string> = {
  'cap-iteration': '方案反复拆不成立(通常是子任务依赖成环)。可提高 run.md 里 caps.maxIterations 后再重试;或者把目标写得更能切分,再重做这个节点。',
  'cap-nodes': '提高 run.md 里 caps.maxNodes 后再重试,或缩小需求范围。',
  rework: '先看该节点的验收记录,按阻断意见改代码或改验收点;必要时提高 caps.maxIterations。',
  /**
   * 降级放行。**不许出现「重试」二字** —— 节点没停,没有什么可重试的;
   * 而「提高 caps.maxIterations」对一个已经往下跑了的节点也没有意义(除非他想重跑整个节点)。
   *
   * 用户此刻真正要做的判断只有一个:这一关没解决的那些问题,他接不接受。
   */
  degrade: '节点没有停,已带着这一关的意见继续往下跑。看 node.md 的「降级放行」一节:那几条是判决当时提出、没人落实的问题;不接受就对该节点做一次重做,或收紧验收点后重跑。',
  /**
   * 静默超时。**两个旋钮都要说**,而且第二个此前一个字都没有。
   *
   * 这条时钟量的是「多久没有任何输出」(流式增量也算 —— 见 runAgentAdapter 的
   * onQueryProgress)。真的开火时有两种可能,各自对应不同的旋钮:
   *  - 模型/工具确实卡住了 → `caps.nodeTimeoutMs`(现在可以直接说「阶段超时 20 分钟」);
   *  - 员工走的是自己的端点(`roles[]` + `execMode: 'api'`),而那个端点**迟迟不发第一个
   *    字节**:翻译层要先嗅一口才知道是不是 SSE(否则一次「成功但完全空白」的回答会被
   *    当成真产出),所以这段等待落在 **SDK 自己的请求超时**里,而它的默认值是 10 分钟、
   *    只认环境变量 `API_TIMEOUT_MS`。`caps.nodeTimeoutMs` 调多大都动不了它。
   */
  timeout: '改 run.md 里的 caps.nodeTimeoutMs 再 --resume(下次新建运行时可以直接说「阶段超时 20 分钟」),或把该节点拆小;'
    + '如果这一席是**翻译协议**的员工(roles[] 里 apiProtocol: openai / openai-responses),'
    + '「上游迟迟不发第一个字节」这段等待落在 SDK 请求超时里,那个只认环境变量 API_TIMEOUT_MS(默认 600000)。',
  // 注:等人工确认超时走的是同一个 category,但**处理方式相反** —— 见
  // humanTimeoutRemedy,由 pipeline 以 remedy 覆盖传进来。
  infra: '先确认角色模型/网络可用(角色配置在 .claude/settings.json 的 roles 里),再重试。',
  'cap-depth': '若这些子任务确实该独立成节点,提高 run.md 里 caps.maxDepth 后重跑该节点;否则无需处理。',
  // The only category whose honest advice is 'do nothing'. Saying so beats inventing a knob.
  revise: '暂时无需处理:补救子任务会照常评审/执行/验收,完成后该节点会重新做一次集成验收。若这一轮仍不通过,该节点才会真正阻断并再次通知你。',
}

/** The one valve that lets its node continue. Everything the card says branches on this. */
/**
 * 等人工确认超时的处理方式。
 *
 * 和「静默超时」写在一起是错的:一个要你调大超时/把节点拆小,另一个和节点大小
 * 毫无关系 —— 是那条工具权限确认没人点。给通用的一句话,一半的用户会被指去调一个
 * 和原因无关的旋钮。
 */
/**
 * 总时长超限的处理方式 —— 和静默**正好相反**:它一直在吐字。
 *
 * 量的是「自上一条完整消息以来」(见 runAgentAdapter 的 TimeoutKind.total),所以开火时
 * 说的不再是「这个节点太大」——**节点大小和它无关了**:一个跑一小时、完成上百次调用的
 * 执行节点不会碰到这条线,碰到的是一个吐得出 token、却攒不满一条消息的端点。
 * 叫用户去调静默预算或者查网络也不对症:上游是通的,只是慢到不像话。
 */
export function totalTimeoutRemedy(): string {
  return '这一席一直有输出,但连着 caps.nodeTimeoutMs × 6 那么久都没能完成一条完整消息 —— '
    + '典型是端点吞吐低到滴水(每分钟几个 token),或者它卡在一段永远结束不了的输出里。'
    + '先换一个更快的端点/模型试一次;确认这个端点就是这么慢的话,改 run.md 里的 '
    + 'caps.nodeTimeoutMs 再 --resume(它同时抬高静默和总时长两个上限)。'
    + '这条和「节点太大」「网络不通」「没人批权限」都无关 —— 一次正常的长调用只要在'
    + '不断产出消息,跑多久都不会撞到它。'
}

export function humanTimeoutRemedy(): string {
  return '没有人回答工具权限确认。去终端(或飞书卡片)上把那个确认点掉再重试;' +
    '如果你不打算守着它,可以把要用的工具加进 allowlist,或者用 bypassPermissions 模式。' +
    '这条和节点大小、和 caps.nodeTimeoutMs 都没有关系。'
}

export function stopsTheNode(category: BlockCategory): boolean {
  // 'degrade' 和 'cap-depth'/'revise' 同类:阀跳了,但节点继续跑。
  return category !== 'cap-depth' && category !== 'revise' && category !== 'degrade'
}

/**
 * The phase a retried node re-enters, and therefore what the user is buying.
 *
 * MUST mirror reseat.ts's seat rules, including its cap-iteration branch. It did not: for the
 * typical cap-iteration node — a plan that called itself executable and was then rejected
 * three times — reseat sends it back to CREATED to re-plan, while this said 「执行 → 验收」.
 * A card headed 安全阀 · 方案评审迭代超限 told the user the retry would keep the plan and
 * only re-run execution. Exactly backwards.
 */
/**
 * 重跑时这个节点会经过哪些环节。
 *
 * 措辞必须跟着环节表走(MUST mirror reseat.ts's seat rules):环节改名之后这里还写着
 * 「方案制定 → 评审」,而且配了测试验证的节点实际是「执行 → 测试验证 → 验收」——
 * 卡片上少一步,用户就会以为重试比实际便宜。
 */
function retryTarget(node: TaskNode, category: BlockCategory): string {
  if (node.childIds.length > 0) return PHASE_LABEL.integrate
  // reseat's `reviewExhausted`: a childless node whose REVIEW budget was the one that ran out
  // goes back to CREATED, whatever `kind` happens to say.
  const plan = `${PHASE_LABEL.plan} → ${PHASE_LABEL.review}`
  if (category === 'cap-iteration') return `${plan}(方案会重新生成)`
  if (node.kind !== 'executable') return plan
  // 只有真的配了测试修复席位才写它 —— 否则那一步整个不发生,写上去就是多报一步。
  const steps = [PHASE_LABEL.execute,
    ...((node.phaseRoles.verify ?? []).length > 0 ? [PHASE_LABEL.verify] : []),
    PHASE_LABEL.accept]
  return steps.join(' → ')
}

/**
 * Where the node's own record lives.
 *
 * Derived from the run id rather than passed in. It WAS a `runDir` field on the payload, and
 * in production it was never populated — `PipelineCtx.onBlocked` carries only
 * {node, reason, category}, so every real card printed the fallback "该节点目录下的 node.md"
 * with no path in it, while the tests set the field by hand and asserted the full path. One
 * fewer wire is one fewer wire that can be cut.
 */
function recordPath(node: TaskNode, runId?: string): string {
  return runId ? `.claude/efftask/${runId}/${node.id}/node.md` : `.claude/efftask/<运行 ID>/${node.id}/node.md`
}

export function blockEscalationLines(e: BlockEscalation, runId?: string): string[] {
  const id = runId ?? '<运行 ID>'
  const head = [
    `节点: ${e.node.title}(${e.node.id})`,
    `类别: ${TITLE[e.category]}`,
    // Verbatim. The reason already names the counts ("验收迭代超限(3): …") and paraphrasing
    // it here would give the card and node.md two different accounts of the same event.
    `原因: ${e.reason}`,
  ]
  if (!(e.stopped ?? stopsTheNode(e.category))) {
    // This trip did NOT stop the node. Saying 已暂停 here would send the user to fix a run
    // that is still working, and `--retry-blocked` would not match this node at all.
    return [
      ...head,
      // Per-category, because "the node kept going" is true for all of these and WHY differs
      // completely. The two-way version fell through to growTree's sentence for every category
      // except cap-depth, so the 补救拆分 card announced 已追加 N 个补救子任务 on one line and
      // 这次加子节点的请求被拒绝了 on the next.
      e.category === 'cap-depth'
        ? '状态: 该节点不再拆分,planner 要的子任务已折进它自己的方案里,继续执行。本次运行没有停。'
        : e.category === 'revise'
          ? '状态: 该节点没有停,已转为等待这些补救子任务;它们全部验收通过后,该节点会重新做一次集成验收。'
          : e.category === 'degrade'
            // 必须自己一支。落进下面那句兜底的话,一张标题写着「判决未通过 · 已降级放行」的卡
            // 正文会告诉用户「这次加子节点的请求被拒绝了」—— 和事实毫无关系。
            // (revise 当初被单独立档,治的就是同一个毛病。)
            ? '状态: 该节点没有停。这一关的轮数用尽而判决没通过,它带着累积的修改建议继续往下跑;建议已交给后续环节和执行者。'
            : '状态: 这次加子节点的请求被拒绝了,但该节点本身没有停,会带着这条拒绝记录继续执行和验收。',
      `记录: ${recordPath(e.node, runId)}`,
      `处理方式: ${e.remedy ?? REMEDY[e.category]}`,
    ]
  }
  return [
    ...head,
    // Say the ABSENCE out loud. This node is not queued, not retrying, not waiting on
    // anything — and a card that only says "已暂停" reads as "it will pick up later".
    '状态: 该节点已停,不会自动重试。它的上级会被标记为阻断,本次运行最终会以「被阻断」收场。',
    // …but the RUN has not stopped yet, and that distinction is load-bearing: a second `/et`
    // started now would acquire the run lock (the FIRST run never takes one — only --resume
    // does) and a second orchestrator would write the same node.md files concurrently, each
    // silently overwriting the other while both reported success.
    // Says only what is KNOWN. The payload carries no in-flight count, so "其它分支此刻仍在跑"
    // was an unconditional assertion that is false at parallelism 1, and false whenever this
    // was the last step running. The ADVICE is sound either way — verified: a new run never
    // takes the run lock (acquireRunLock is only called on the --resume path), so a second
    // /et really would have two orchestrators writing the same node.md files.
    '注意: 本次运行可能还有其它分支在跑。请等它结束后再执行下面的命令 —— 运行期间另开一个 /et 会有两个进程写同一批 node.md。',
    `记录: ${recordPath(e.node, runId)}`,
    `处理方式: ${e.remedy ?? REMEDY[e.category]}`,
    // The ONLY command that actually reopens this node. A bare `--resume` reproduces the
    // block having made zero model calls — measured behaviour of reseatTransientNodes.
    // Run-scoped, and says so: the flag reopens EVERY valve-stopped node in the run, not just
    // this one, and up to 8 cards can each be pointing at it.
    `重试(会重开本次运行中所有被安全阀停下的节点,本节点将重跑「${retryTarget(e.node, e.category)}」): /et --resume ${id} --retry-blocked`,
    // NOT `/et --resume` — that is not a read-only operation. It takes the run lock, reseats
    // every interrupted node and issues real write-capable model calls.
    // The PATH, not a relative direction. node.md lives at <runDir>/<node.id>/node.md and
    // node.id contains slashes, so run.md is two or three levels up depending on depth —
    // "上一级目录" was wrong for every node in the tree, including root.
    `只看结果、不重跑: 直接读 ${runId ? `.claude/efftask/${runId}/run.md` : '该 run 目录下的 run.md'}。`,
  ]
}

export function buildBlockCard(e: BlockEscalation, runId?: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      // Orange, not red: red is the merge-conflict card, which is a stop the user must
      // personally unblock. This is a valve — the run protected itself and is asking whether
      // to spend more. Two different asks should not look identical in a chat window.
      // The depth valve is blue: nothing is wrong and nothing is waiting on anyone.
      template: (e.stopped ?? stopsTheNode(e.category)) ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `高效任务模式 · ${TITLE[e.category]}` },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: blockEscalationLines(e, runId).map(l => `- ${l}`).join('\n') },
      },
    ],
  }
}

/**
 * The same 处理方式 the card carries, for `node.blockedReason`.
 *
 * run.md is the only durable surface a run has, and the escalation limiter drops cards past
 * the cap while telling the user to "看 run.md" — so the remedy has to actually be there.
 * The merge-conflict path already does exactly this (its detail string carries the 处理方式
 * and the resume command); the valve path recorded a bare reason.
 */
/**
 * @param remedy 覆盖静态的那一句。
 *
 * 静态表只能给一句放之四海皆准的话,而有些类别需要**按事实分叉**:方案评审触顶时,
 * 「同一条意见连提三轮」和「每轮意见都不一样」的正确动作是相反的 —— 前者再加轮次大概率
 * 还是同样的结论,后者恰恰就该加轮次。给一句通用的话,总有一半的人被指反方向。
 * 其余类别不传这个参数,行为逐字节不变。
 */
export function blockReasonWithRemedy(reason: string, category: BlockCategory, runId?: string, remedy?: string): string {
  const id = runId ?? '<运行 ID>'
  return `${reason} · ${remedy ?? REMEDY[category]} · 重试: /et --resume ${id} --retry-blocked`
}

/** Default cards per run before the limiter starts suppressing. */
export const MAX_ESCALATION_CARDS = 8

/**
 * Rate-limit escalations for one run.
 *
 * A provider outage blocks every node in flight, and a 100-node tree would then send 100
 * cards — which is not "being told", it is being buried, and the ONE card that mattered is
 * unfindable. Suppression is ANNOUNCED on the last card that gets through: silently dropping
 * notifications is the same failure as never sending them.
 */
export function createEscalationLimiter(max = MAX_ESCALATION_CARDS): {
  admit: (stopped?: boolean) => { send: boolean; note?: string }
  suppressed: () => number
} {
  let sent = 0
  let dropped = 0
  return {
    /**
     * `stopped` splits the budget. A deep tree that folds eight branches would otherwise spend
     * the whole quota on blue "nothing stopped" cards and suppress the ONE orange card asking a
     * human whether to spend more — measured: the node that actually stopped got {send:false}.
     * Information-only notices get half; a card that needs a decision always gets through
     * until the full cap.
     */
    admit(stopped = true) {
      const ceiling = stopped ? max : Math.floor(max / 2)
      if (sent >= ceiling) { dropped++; return { send: false } }
      if (sent < max - 1) { sent++; return { send: true } }
      if (sent === max - 1) {
        sent++
        // NOT "详见 run.md" flat: renderTreeSnapshot only prints a reason for BLOCKED nodes,
        // and the non-stopping valves (cap-depth flattening a branch, cap-nodes refusing a
        // graft) leave their node running with an empty blockedReason — those land in the
        // node's own node.md and appear nowhere in run.md. Point at both, accurately.
        return { send: true, note: `本次运行的升级通知已达 ${max} 条上限,后续升级不再单独发卡。被阻断的节点在 run.md 的任务树里带着原因和处理方式;未阻断的(如深度上限、加子节点被拒)只记在该节点的 node.md 里。` }
      }
      dropped++
      return { send: false }
    },
    suppressed: () => dropped,
  }
}
