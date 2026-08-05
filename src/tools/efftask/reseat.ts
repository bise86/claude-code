import type { Caps, NodeStatus, TaskNode } from './types.js'
import { reopenPropagatedBlocks } from './redo.js'

/**
 * Statuses that mean "a phase was in flight". A process kill leaves these on disk while
 * nothing is actually running any more.
 *
 * `SCORING` and `MERGE` ARE now committed (spec §4's state machine lists them, and the panel
 * showed both as ACCEPTANCE until they were). They belong here for the same reason as the
 * rest: a process killed while scoring or merging leaves that status on disk, and a status
 * this set does not know is a status `advanceableKind` also refuses — the node would sit
 * grey forever and every later resume would reproduce it.
 *
 * `EXECUTED` is included even though no pipeline path commits it, and the argument that it was
 * "logic for a dead state" was wrong about where the state comes from. It is a legal
 * `NodeStatus` that `validateLoadedNodes` ACCEPTS off disk, and node.md is hand-editable by
 * design — the escalation cards tell users to edit these files. A node.md carrying
 * `status: EXECUTED` therefore passes validation, is skipped here, and is refused by
 * `advanceableKind` as well: it sits grey forever and every later resume reproduces it
 * exactly. That is the identical failure this comment already describes for SCORING/MERGE,
 * reached through the door that made all of them reachable in the first place. spec §17.2
 * lists it explicitly: `EXECUTING`/`EXECUTED`/`ACCEPTANCE`/`REWORK`/`SCORING`/`MERGE` → READY.
 * The real transition it is driven through is a load from disk (see reseat.test.ts).
 */
const ACTIVE: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'PLANNING', 'PLAN_REVIEW', 'EXECUTING', 'EXECUTED', 'VERIFYING', 'ACCEPTANCE', 'REWORK',
  'INTEGRATION_ACCEPT', 'SCORING', 'MERGE',
])

/**
 * spec §17.2:「每个被归位的节点在 `execStatus` 追加一行"上次运行在 **<阶段>** 中断,
 * 已重新排队"」。
 *
 * 阶段名此前被丢掉了 —— 注记是一个固定串,而节点原来的 status(唯一知道它停在哪的东西)
 * 就在手上,归位时被覆盖掉。差别是实打实的:被杀在 `EXECUTING` 的节点会重跑一次带写工具的
 * 执行调用,被杀在 `MERGE` 的节点只会重试一次合并。用户在详情页看到的两句话原本一模一样。
 */
const PHASE_OF: Partial<Record<NodeStatus, string>> = {
  PLANNING: '方案制定', PLAN_REVIEW: '方案评审', EXECUTING: '执行', EXECUTED: '执行完成待验收',
  VERIFYING: '测试验证',
  ACCEPTANCE: '验收', REWORK: '返工', INTEGRATION_ACCEPT: '集成验收', SCORING: '观察评分',
  MERGE: '合并回集成分支',
}
/** Stable prefix for the once-only check — the rest of the line now varies by phase. */
const ANNOTATION_PREFIX = '(注:上次运行在'
const annotationFor = (was: NodeStatus): string =>
  // An interrupted node was already swept to BLOCKED, which erased where it had been; say
  // that honestly rather than naming a phase we no longer know.
  `${ANNOTATION_PREFIX}${PHASE_OF[was] ?? '某个阶段'}中断,已重新排队)`
const RETRY_NOTE = '(注:本节点被 --retry-blocked 重开,隔离工作区已重置为集成分支最新状态;上面描述的产出已移到 salvage 分支,当前工作区里不存在)'

export interface ReseatResult {
  nodes: TaskNode[]
  /** Ids returned to a runnable state. */
  reseated: string[]
  /** Ids blocked because the phase they would re-enter has no budget left. */
  exhausted: string[]
  /**
   * Ids reopened by `--retry-blocked` — nodes a safety valve had stopped.
   *
   * Reported separately because the resume gate must SAY it: re-arming a valve is the one
   * thing on this path that spends budget the run had already refused to spend, and a user
   * who typed the flag from a card needs to see how many nodes it actually reached.
   */
  retried: string[]
}

/**
 * Return nodes that were mid-phase when the process died to a state the orchestrator can
 * safely re-enter.
 *
 * Two inputs qualify: the active statuses above, and `BLOCKED` nodes carrying
 * `interrupted === true`. The second set is the one that actually dominates in practice —
 * `propagateBlocked(aborted)` sweeps EVERY non-terminal node to BLOCKED, and Esc, Ctrl+C and
 * view teardown all go through it. Skipping them makes resume a no-op: verified against P1,
 * an interrupted-then-resumed run issues zero model calls.
 *
 * The target is chosen by three rules, in this order — the order is load-bearing:
 *
 *  1. **Already has children → `WAITING_CHILDREN`.** `createChildren` persists the children
 *     BEFORE committing the parent, so a kill in that window leaves a parent still claiming
 *     PLAN_REVIEW next to children that exist. Sending it to CREATED would replan and build a
 *     SECOND set: identical titles yield identical ids and overwrite the recovered (possibly
 *     ACCEPTED) children; different titles leave ghost siblings that `childrenAllAccepted`
 *     then waits on forever.
 *  2. **`kind === 'executable'` → `READY`.** That is the state before the interrupted
 *     execute/accept phase.
 *  3. **Otherwise → `CREATED`,** so `stepStart` re-derives the kind. This is why the rule
 *     cannot be a flat status→status map: `advanceableKind` only advances READY when the
 *     kind is executable, so READY on an `unknown` node is neither advanceable nor terminal —
 *     the run dies with no reason attached and every later `--resume` reproduces it exactly.
 *
 * Re-entry means the interrupted step runs again, possibly repeating a model call. That is
 * the deliberate trade: redo work rather than let half-finished work pass as finished.
 */
export function reseatTransientNodes(
  nodes: TaskNode[], now: string, caps: Caps,
  /**
   * `--retry-blocked` (spec §9/§11): ALSO reopen nodes a safety valve stopped, and give each
   * a fresh budget for the phase it re-enters.
   *
   * Opt-in, and gated on the structural `capBlocked` flag rather than on reason text, so it
   * can never resurrect a node blocked by 依赖节点缺失 / 子节点缺失 / 依赖成环 — those are
   * unusable disk states, and re-running them would execute work whose upstream cannot be
   * verified while the run reported success.
   *
   * The budget RESET is the point: without it the node is reseated and instantly re-exhausted
   * by the check below, so the flag would be inert and the escalation card that names it
   * would be describing a command that does nothing.
   */
  opts: { retryBlocked?: boolean } = {},
): ReseatResult {
  // A node blocked ONLY because something below it failed. propagateBlocked writes this
  // reason on the way up and — unlike the abort path — never sets `interrupted`, so the
  // ancestors of a reopened node stayed BLOCKED. The scheduler then refuses to pick any node
  // with a blocked ancestor, so the reopened child was unreachable and the run immediately
  // re-blocked it as 上级任务阻断: measured, a resume that reopened the right node still made
  // ZERO model calls and the human's merge fix never landed.
  // All three are written BY propagateBlocked about someone else's failure — none is a
  // verdict on the node itself, and nothing anywhere else ever clears a blockedReason. Leaving
  // 依赖阻断 out meant a sibling stayed BLOCKED forever after the node it waited on reached
  // ACCEPTED, still rendering "✗ 依赖阻断" in the tree.
  const PROPAGATED = new Set(['子节点阻断', '上级任务阻断', '依赖阻断'])
  const byId = new Map(nodes.map(n => [n.id, n]))
  const reopenAncestors = (n: TaskNode): void => {
    let p = n.parentId === null ? undefined : byId.get(n.parentId)
    while (p && p.status === 'BLOCKED' && PROPAGATED.has(p.blockedReason)) {
      p.status = p.childIds.length > 0 ? 'WAITING_CHILDREN' : 'READY'
      p.blockedReason = ''
      p.updatedAt = now
      p = p.parentId === null ? undefined : byId.get(p.parentId)
    }
  }

  const reseated: string[] = []
  const exhausted: string[] = []
  const retried: string[] = []
  for (const n of nodes) {
    // Captured BEFORE anything below overwrites it: this is the only record of which phase
    // the process was killed in, and spec §17.2 wants that phase named in the note.
    const wasStatus = n.status
    const wasInterrupted = n.status === 'BLOCKED' && n.interrupted === true
    // 触阀后的人工重试. Only with the explicit flag, and only for nodes a VALVE stopped.
    const retryValve = opts.retryBlocked === true && n.status === 'BLOCKED' && n.capBlocked === true
    // A conflict block is a VERDICT, so interrupted is false — yet it is the one blocked
    // state the user is explicitly invited to resume, because the card tells them to fix the
    // conflict and re-run. Without this the invitation was false: reseat skipped it and the
    // resumed run reported the identical block having made zero model calls.
    const awaitingHumanMerge = n.status === 'BLOCKED' && n.mergeConflict === true
    if (!ACTIVE.has(n.status) && !wasInterrupted && !awaitingHumanMerge && !retryValve) continue
    // Re-entry for this node is the ACCEPTANCE+merge path in stepExecute, which the flag
    // itself selects; the READY seat below is only how the scheduler picks it up again.

    /**
     * A valve retry must re-enter the phase that FAILED, not the phase the node's shape
     * suggests.
     *
     * `stepStart` writes `node.kind` from the plan output BEFORE the review roundtable runs,
     * so a plan that called itself `executable` and was then rejected three times sits at
     * BLOCKED with kind === 'executable'. The structural rule below would seat it at READY —
     * and `--retry-blocked` would hand a plan the reviewers unanimously refused straight to a
     * write-capable executor, with zero plan calls and zero reviews. Measured: phases called
     * were ["execute", "accept"] and the node reached ACCEPTED with planReview still at 3.
     *
     * If the exhausted budget was planReview, the node goes back to CREATED and re-plans.
     */
    // Rule 1 still wins. A node that ALREADY has children must never go to CREATED — that is
    // what builds a SECOND set (see the rules above), and no amount of "the review failed"
    // justifies duplicating a subtree. Believed unreachable today (a node that passed review
    // has planReview < cap, and growTree refuses PLAN_REVIEW targets), but the ordering is
    // what makes that a guarantee rather than an observation.
    //
    // Keyed on the RECORDED category, not on a fresh comparison against caps: the escalation
    // card tells the user to raise caps.maxIterations, run.md is where that lands, and reseat
    // reads run.md — so a derived check evaluated false exactly for the user who followed the
    // advice, and handed a thrice-rejected plan to a write-capable executor.
    const reviewExhausted =
      retryValve && n.childIds.length === 0 && (
        n.capCategory === 'cap-iteration' ||
        // FALLBACK for a node.md written before capCategory existed: that build already wrote
        // capBlocked, so those nodes are retryable but carry no category — and without this
        // they took the READY seat and handed a thrice-rejected plan to a write-capable
        // executor. Measured end to end: phases ["execute","accept"], 0 plan calls, 0 reviews,
        // ACCEPTED. The trigger is exactly what the escalation card tells users to do:
        // upgrade, then `/et --resume NNN --retry-blocked`.
        (n.capCategory === undefined && n.iteration.planReview >= caps.maxIterations)
      )
    const target: NodeStatus =
      // A node awaiting a human merge must go back to READY even when it has children: the
      // ONLY code that clears mergeConflict, re-runs acceptance and retries the merge lives in
      // stepExecute, and WAITING_CHILDREN routes to stepIntegrate instead. Measured: a node
      // that grew children and then hit a conflict came back from every later --resume having
      // made zero model calls and zero git operations, forever; and when its children happened
      // to be runnable, the run reported COMPLETED with that node ACCEPTED and its own commits
      // never merged into the integration branch.
      awaitingHumanMerge ? 'READY'
      : n.childIds.length > 0 ? 'WAITING_CHILDREN'
      : reviewExhausted ? 'CREATED'
      /**
       * A plan that was never APPROVED must re-enter planning, whatever `kind` says.
       *
       * `stepStart` writes `node.kind` from the plan output BEFORE the review roundtable runs.
       * So a process killed between those two points leaves `kind: 'executable'` on disk with
       * an EMPTY reviewLog — and the structural rule below then seats it at READY, where
       * `advanceableKind` answers 'execute' and a write-capable executor runs a plan no
       * reviewer ever saw. Measured: status READY, advanceableKind 'execute', reviewLog 0.
       *
       * This is the same hole `reviewExhausted` closes one line up, through the other door:
       * that one guards `--retry-blocked` (capBlocked), and a node killed mid-review carries
       * `interrupted` instead, so it matched neither. Being INTERRUPTED is not evidence about
       * the plan; only a passing review is, and these two statuses mean it has not happened.
       */
      : wasStatus === 'PLANNING' || wasStatus === 'PLAN_REVIEW' ? 'CREATED'
      : n.kind === 'executable' ? 'READY'
      : 'CREATED'

    // Charge the budget of the phase this node will ACTUALLY re-enter, not a fixed one:
    // a node going back to CREATED re-enters plan→review, so planReview is what binds.
    // Without this the resume spends a real write-capable execute call and a full acceptance
    // roundtable before discovering the cap — paying for a repo mutation nothing will consume.
    // The retry the human explicitly asked for BUYS a fresh budget for the phase this node
    // re-enters. Reseating without the reset would trip the exhausted check one line below —
    // the flag would be inert and the card naming it would describe a no-op.
    if (retryValve) {
      if (target === 'READY') n.iteration.acceptance = 0
      else if (target === 'CREATED') {
        // ALL of them. A node sent back to CREATED replays plan → review → execute → accept,
        // so leaving `acceptance` at the cap made the resume spend a real write-capable
        // execute call and a full acceptance roundtable and THEN discover it had no budget —
        // paying for a repo mutation nothing would consume. That is the exact waste the
        // budget check below was written to prevent.
        n.iteration.planReview = 0
        n.iteration.acceptance = 0
      } else n.iteration.integration = 0
      // Cleared so the NEXT valve trip is a fresh decision, and so a later plain `--resume`
      // does not silently keep offering a retry the user did not ask for again.
      n.capBlocked = false
      // The re-acquire that follows does `checkout -B <branch> <integration>`, parking the
      // previous round's output on a salvage ref — so the worktree the executor re-enters is a
      // clean integration baseline. Without this note the REWORK prompt still said
      // "上一轮执行状态: 我实现了 feature.ts", and the executor went looking for a file that is
      // no longer there. Only reachable since --retry-blocked made these nodes resumable.
      if (n.execStatus.length > 0 && !n.execStatus.includes(RETRY_NOTE)) {
        n.execStatus = `${n.execStatus}\n${RETRY_NOTE}`
      }
      retried.push(n.id)
    }
    const spent =
      target === 'READY' ? n.iteration.acceptance
      : target === 'CREATED' ? n.iteration.planReview
      : n.iteration.integration
    /**
     * **降级放行过的那一关不算「预算耗尽」——它算「这一关已经不再开会了」。**
     *
     * 少了这一句是一个 P0,而且是静默的:降级放行的节点**本来就**带着一个停在上限上的
     * 计数器继续跑(那正是「触顶」的定义)。于是它下一次被中断 + `--resume` 时,
     * 这条早退分支会把一个正在正常推进的节点直接判死 —— 而它既没有 `capBlocked`
     * (没走过 `blockWithReason`),就**也不被 `--retry-blocked` 认领**。
     * 结果是永久死节点,而且降级带下去的那些意见跟着一起没了。
     *
     * 判据用 `degraded`(结构化记录)而不是「计数器到顶了」:计数器到顶的节点可能是
     * 刚被阀门停掉的真失败,也可能是降级放行继续在跑的,两者的下一步相反。
     * 同一个坑 `reviseDecomposition` 踩过一次(它的解法是把 `iteration.integration`
     * 清零),这里不清零 —— 清零等于把刚刚宣布用尽的预算又发一次。
     */
    const degradedHere =
      target === 'READY' ? (n.degraded ?? []).some(d => d.phase === 'accept' || d.phase === 'verify')
      : target === 'CREATED' ? (n.degraded ?? []).some(d => d.phase === 'review')
      : (n.degraded ?? []).some(d => d.phase === 'integrate')
    if (spent >= caps.maxIterations && !degradedHere) {
      n.status = 'BLOCKED'
      n.blockedReason = `恢复时该阶段预算已耗尽(${spent}/${caps.maxIterations}),不再重试`
      n.interrupted = false // a later resume must not reopen it again
      /**
       * 这条**早退**分支同样要清那三个字段 —— 它绕过了下面那一整段归位清理。
       *
       * 评审实测:被这条分支阻断的节点留着上一次的 `startedAt`/`finishedAt`,于是详情页
       * 一边写着「已终止」,一边把耗时算成跨过整个关机时间的 72 小时;而留着的 `cancelled`
       * 是一个**跨 run 存活的摁住位**,而这条分支恰好是「活干完了、判的人没预算了」那一类
       * —— 最可能被后续一次重做碰到的节点。
       *
       * `startedAt` 清掉的语义和下面那段逐字相同:这个节点会从下一个活动阶段重新计时。
       */
      n.cancelled = false
      n.startedAt = undefined
      n.finishedAt = now
      /**
       * 失败点。`wasStatus` 早就在手上(上面 target 的判定和下面那条注记都在用它),
       * 唯独这里没记 —— 而这恰恰是**最需要「跳过失败环节」的那一类节点**:活干完了,
       * 判的人没预算了。评审实跑:`ACCEPTANCE` + acceptance=3 的节点在这里阻断之后,
       * `R` 回「这条记录来自更早的版本,或者被手工改过」,`s` 回「看不出…无法跳过」——
       * 两个新键在它身上全废。
       */
      /**
       * **`BLOCKED` 不是一个环节**,记上去等于把失败点抹成一个没有含义的值。
       *
       * `commit()` 对同一个坑有防线(`if (prev !== 'BLOCKED')`,注释写明了理由),
       * 而这一处缺了它 —— 复验实测:Esc 中止那条主流路径上,`propagateBlocked` 已经把
       * 节点扫成 BLOCKED,于是下一次 `--resume` 看到的 `wasStatus` 就是 `'BLOCKED'`,
       * `failedPhaseOf` 查不到这个键、返回 undefined,`R`/`s` 两个快捷键在它身上全废。
       * 硬杀那条路(status 还停在 ACCEPTANCE)不受影响,那正是这一行原本要救的场景。
       */
      if (wasStatus !== 'BLOCKED') n.failedAt = wasStatus
      n.updatedAt = now
      exhausted.push(n.id)
      continue
    }

    n.status = target
    n.interrupted = false
    // 归位 = 重新起跑。取消标记也到此为止 —— `/et --resume` 明确承诺会重新排队被取消的
    // 节点(阻断原因里就是这么写的),而留着它会让**重做**在之后把它当成「用户不想跑」。
    n.cancelled = false
    // 归位 = 重新起跑,上一次的失败点作废(和 redo 的 reseatForRerun 逐字同因:留着它,
    // R/s 会照一个属于上辈子的失败点给出动作)。手工跳过的一次性标记同理。
    n.failedAt = undefined
    n.skipPhase = undefined
    /**
     * 耗时重新计时 (spec §10.1: 「自进入**活动态**起的累计耗时」).
     *
     * `startedAt` round-trips through node.md, and nothing here used to clear it — so after a
     * resume `elapsed` computed `now - startedAt` across the entire time the terminal was
     * CLOSED. Measured on a run killed two days earlier: a grey ○ 排队中 node rendered
     * `172800s` beside it, against a true runtime of a few tens of seconds, and because the
     * panel treats any non-terminal node as live the number ticked upward once a second while
     * nothing was running at all.
     *
     * That mattered little while the tree only appeared during a live run; it became the first
     * number on screen when the resume gate started rendering the recovered tree, i.e. exactly
     * where a user decides whether to spend more money. It is also the SAME defect `elapsed`'s
     * own comment records having fixed once before ("a node that never ran … rendered 3600s an
     * hour after the tree was built").
     *
     * Cleared rather than adjusted: this node is going back to a resting state and will be
     * re-stamped by commit() on its next ACTIVE phase, which is what the field means.
     * `resumeCore` already tells the user this in so many words when it drops a malformed one
     * — 「耗时将从恢复后的首个活动阶段重新计时」.
     */
    n.startedAt = undefined
    // 结束时刻同理:这个节点正被放回队列,它已经**没有**结论了。留着的话详情页会
    // 一边显示「进行中」一边显示一个两天前的结束时刻。
    n.finishedAt = undefined
    // NOTE the matching cost, recorded rather than glossed: the time this node spent in the
    // phase it was killed in is DISCARDED, not banked. `phaseMs` accumulates inside commit()
    // on the way out of a status, and a killed node never takes that exit — reseat writes
    // `status` directly. So a node that ran 15 minutes before the crash comes back with those
    // 15 minutes missing from 各阶段耗时. That is the deliberate side of the same trade as
    // startedAt above: banking it would need a timestamp that survives the crash, and such a
    // timestamp is exactly what would let downtime be counted as work.
    // Reopen the chain above too, or this seat is unreachable.
    reopenAncestors(n)
    /**
     * …以及所有**被牵连**的节点,不只是「直接依赖它的那一层」。
     *
     * 这里原来是一句 `other.deps.includes(n.id)` 的一级循环,而阻断是不动点扫出来的
     * (父→子 / 子→父 / 依赖→依赖方,反复扫到稳定)。验收实测:A←B←C 的链上人工解完
     * 合并冲突再 `--resume`,B 被放开而 **C 和 B 的子树留在 BLOCKED** —— 而 B 的子树红着
     * 会让 `propagateBlocked` 立刻把刚放开的 B 再阻断一次(childBlocked),也就是
     * 「resume 之后一次模型调用都不会发生」的那个老失败,只是从另一扇门进。
     *
     * 用重做那边同一个不动点(`reopenPropagatedBlocks`),顺带把那一级循环漏掉的三件事
     * 一起补上:清 `startedAt`(否则树上显示 `172800s` 并每秒往上跳)、清过期的 `failedAt`
     * (否则 `R`/`s` 会在一个「其实是别人挂了」的节点上放行)、以及**方案没被放行过的
     * executable 不许坐 READY**(否则带写工具的执行者会跑一份没人看过的方案)。
     * 一份实现,两个入口 —— 各写一份的话最松的那一份就是实际生效的那一份。
     */
    reopenPropagatedBlocks(byId, now)
    // It is no longer blocked, so the reason must not linger — it would render in the tree
    // and be read as a live failure.
    n.blockedReason = ''
    // Annotate only where there IS execution evidence, and only once: repeated crash/resume
    // cycles would otherwise stack these lines into the text acceptPrompt shows the reviewer,
    // and a decompose node that never executed would gain an execStatus out of nowhere.
    // NOTE this is a breadcrumb, not evidence preservation — stepExecute overwrites
    // execStatus wholesale on the next run.
    // Matched on the PREFIX, not the whole line: the note now names the phase, so two
    // successive crashes in different phases produce two different strings and a whole-line
    // check would stack both.
    if (n.execStatus.length > 0 && !n.execStatus.includes(ANNOTATION_PREFIX)) {
      n.execStatus = `${n.execStatus}\n${annotationFor(wasStatus)}`
    }
    n.updatedAt = now
    // Counted ONCE. A valve retry already has its own (louder) section at the resume gate;
    // pushing it here as well made "重开 1 个节点" render alongside "重新排队 1 个节点" with
    // the same id in both lists, reading as two nodes.
    if (!retryValve) reseated.push(n.id)
  }
  return { nodes, reseated, exhausted, retried }
}
