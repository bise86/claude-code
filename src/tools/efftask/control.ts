import { clampParallelism, DEFAULT_PARALLELISM, SKIPPABLE_PHASES } from './types.js'
import type { PhaseName } from './types.js'
import type { Strictness } from './strictness.js'

/**
 * 运行中的人工干预面:**暂停**、**追加指令**、**取消单个节点**、**调并发度**、**预先批准**。
 *
 * 在这之前,运行中唯一能做的事是 Esc —— 而它的粒度是整个 run。用户的原话是
 * 「任务正在运行怎么取消,可以用提示词修正这个任务怎么做不」:两件事都要,而且都不该
 * 是「把整轮炸掉重来」。
 *
 * 四件事放在一个对象里,因为它们共享同一个生命周期(一次 run),而且 UI 那侧是同一批
 * 按键。但**内部互不耦合**:暂停不影响在飞的调用,取消不影响别的节点,追加指令只作用于
 * 之后派发的提示词,并发度只影响**还没起跑**的那些。
 */

/** 一次 run 的人工干预面。 */
export interface RunControl {
  // ---- 暂停 ----
  isPaused(): boolean
  pause(): void
  resume(): void
  /**
   * 等到被恢复为止。
   *
   * 已经不是暂停态时**立刻**返回 —— 否则调度循环会在一次「暂停又马上恢复」的竞态里
   * 永远等下去(恢复的通知在它开始等之前就发完了)。
   */
  waitForResume(): Promise<void>

  // ---- 追加指令 ----
  /** 用户在运行中补的一句话。作用于**之后**派发的提示词,不打断在飞的调用。 */
  addDirective(text: string): void
  /** 当前累积的全部追加指令,按加入顺序。 */
  directives(): readonly string[]

  // ---- 取消单个节点 ----
  /**
   * 登记一次在飞的调用,好让 cancelNode 能中止它。返回注销函数。
   *
   * 必须在 finally 里注销:留着的话,一个早就结束的 controller 会一直挂在表里,
   * 而后来对同一节点的取消会去 abort 它 —— 无害但会掩盖「这个节点此刻根本没在跑」。
   */
  registerCall(nodeId: string, controller: AbortController): () => void
  /** 中止该节点此刻在飞的全部调用,并记下它被取消过。 */
  cancelNode(nodeId: string): void
  /** 这个节点被用户取消过吗 —— 用来把它和超时/provider 故障区分开。 */
  wasCancelled(nodeId: string): boolean
  /** 节点重新开跑时清掉标记。 */
  clearCancel(nodeId: string): void
  /**
   * 清掉**全部**取消标记 —— 一次新的编排开始时调。
   *
   * 必须有:同会话里按 r 重做走的是 applyRedo → startRun → runOrchestrator,用的是
   * **同一个** RunControl,而 redo 是原地重置节点、**id 不变**。不清的话 registerCall
   * 一登记就发现该 id 在 cancelled 里,立刻 abort → 又抛 NodeCancelledError:
   * 用户按 r 之后界面闪一下,节点又变回 BLOCKED,理由还是那句「可以在结束屏上按 r 重做」
   * —— 阻断信息本身在推荐一条已经死掉的路。评审实测复现过。
   */
  clearAllCancels(): void

  // ---- 运行中预先批准(强制通过) ----
  /**
   * 预先批准某个节点的某个环节 —— 它到达那一步时不派圆桌,直接记一条人工通过。
   *
   * **不打断在飞的调用**,和 `addDirective` 逐字同规矩,和 `cancelNode` 正相反。
   * 理由:预先批准说的是「接下来那一关不用开了」,不是「把正在开的这一关砍掉」。
   * 砍掉在飞的圆桌会让已经判完的席位的裁决变成 infra 失败(runRoundtable 把任何
   * rejection 一律合成 infra),那些钱已经花了,而结果被丢掉。所以它在**下一次进入
   * 该环节时**生效 —— 对返工循环里的节点就是下一轮,对还没走到那一步的就是走到时。
   *
   * 只收 SKIPPABLE_PHASES 那四个,别的一律忽略:分析和执行没有「通过」可言。
   */
  forcePass(nodeId: string, phase: PhaseName): void
  /** 这个节点的这个环节被预先批准过吗。 */
  wasForcePassed(nodeId: string, phase: PhaseName): boolean
  /** 消费掉一次预先批准 —— 一次性,和 `TaskNode.forcePass` 同规矩。 */
  clearForcePass(nodeId: string, phase: PhaseName): void
  /** 这个节点此刻挂着哪些预先批准。给界面用(页脚要显示,否则用户不知道自己按过)。 */
  forcePassesOf(nodeId: string): readonly PhaseName[]
  /**
   * 清掉**全部**预先批准,返回被清掉的条数 —— 一次新的编排开始时调。
   *
   * 和 `clearAllCancels` 同一个位置、同一个理由的反面:redo 是原地重置、id 不变,
   * 一条留下来的预先批准会作用到**重做之后那份不一样的产出**上 —— 那正是
   * `failedAt` 过期时踩过的坑(见 TaskNode.failedAt 的注释和 reopenAncestor 那几处清理)。
   *
   * **返回条数是要用的**:静默丢掉用户亲手按过的批准是这个仓库反复付代价的那一类,
   * 调用方拿这个数去告诉他「你那 N 条预先批准因为重开编排已经失效」。
   */
  clearAllForcePasses(): number

  // ---- 并发度 ----
  /**
   * 用户在运行中调过的并发上限;`undefined` = 没调过,按 `config.parallelism` 走。
   *
   * 为什么不直接改 `config.parallelism`:那个对象同时是 React state、是关口批准过的那份
   * 快照、也是 `writeRunManifest` 每一帧要写的东西。原地改它既不会触发重绘,也让「用户
   * 批准的是 5」和「现在跑的是 10」这两件事再也分不开。这里存**改动**,由编排器每一轮
   * 现读(`control.parallelism() ?? cfg.parallelism`),而落盘那一侧在写 run.md 之前
   * 同步一次 —— `--resume` 的并发上限是从 run.md 读回来的。
   */
  parallelism(): number | undefined
  /**
   * 调整并发上限。夹进 [MIN_PARALLELISM, MAX_PARALLELISM]。
   *
   * **在飞的调用一律不受影响** —— 池子是 try-lease,已经拿到手的槽位不会被收回;调低只是
   * 让接下来的 `tryTake` 拿不到。所以调低之后表头会短暂显示 `并行 5/2`(5 个在跑、上限 2),
   * 那是**实话**:它们真的还在跑。
   */
  setParallelism(n: number): void
  /**
   * 并发上限改过几次。调度器用它判断「我睡这一觉期间它有没有变过」。
   *
   * 必须是**代数**而不是一个裸的 promise:调度器的循环是「扫一遍 → 派完 → 睡到有节点
   * 结束」,而用户按下 `+` 完全可能正好落在扫描之后、睡下之前。那一下没有代数的话,
   * 新的并发额度要等到**下一个节点跑完**才生效 —— 而「所有节点都在跑一个 20 分钟的执行
   * 环节」正是他去调它的时刻。
   */
  parallelismGeneration(): number
  /**
   * 等到并发上限**再**变一次。`seen` 已经落后于当前代数时**立刻**兑现。
   *
   * 立刻兑现这一条和 `waitForResume` 是同一个坑:通知在注册之前就发完了的话,等待方会
   * 睡到下一次变更 —— 而下一次可能永远不来。
   */
  waitForParallelism(seen: number): Promise<void>

  // ---- 严格度档位 ----
  /**
   * 用户在运行中调过的严格度;`undefined` = 没调过,按 `config.caps.strictness` 走。
   *
   * 和 `parallelism()` 逐字同理由:`config` 同时是 React state、是关口批准过的那份快照、
   * 也是 `writeRunManifest` 每一帧要写的东西。原地改它既不触发重绘,也让「用户批准的是
   * 专家」和「现在跑的是初级」这两件事再也分不开。
   *
   * **刻意没有代数,也没有 waitFor**,与 `setParallelism` 不同 —— 那套机制的用途是在调度
   * 循环**睡眠中途**把它叫醒去多派几个节点。档位不改变任何节点的可派发性,它只改变下一次
   * 构造提示词时读到的值,而提示词是在派发那一刻现算的。加代数只会每次改档白白唤醒调度
   * 循环去重扫一棵没有变化的树。它的形状属于 `addDirective` / `forcePass` 那一类。
   */
  strictness(): Strictness | undefined
  /**
   * 调整严格度。**不打断在飞的调用**,生效单位是「下一场圆桌之前」。
   *
   * 不退还已经烧掉的迭代额度:退了就等于开一条绕过 `cap-iteration` 的路。已经因迭代
   * 超限阻断的节点要按 `r` 重做才会按新档位重跑(`planRedo` 会重置对应的计数)。
   */
  setStrictness(s: Strictness | undefined): void
}

/** 一条追加指令的长度上限。整段提示词是要付钱的,而用户可能粘一整个文件进来。 */
export const MAX_DIRECTIVE_CHARS = 2000
/** 最多累积多少条。再多就把最早的挤掉 —— 但**不静默**,见 directives 的注释。 */
export const MAX_DIRECTIVES = 20

/** 一个可以从外面兑现的 promise。见 `limitChanged` —— 一个共享事件,不是一张等待者表。 */
function deferred(): { promise: Promise<void>; wake: () => void } {
  let wake = (): void => {}
  const promise = new Promise<void>(res => { wake = res })
  return { promise, wake }
}

export function createRunControl(): RunControl {
  let paused = false
  /** 等着被恢复的那些人。恢复时一次性全部放行。 */
  let waiters: (() => void)[] = []
  /** 用户调过的并发上限,以及它改过几次。 */
  let parallelism: number | undefined
  let parallelismGen = 0
  /**
   * 运行中调过的严格度。
   *
   * **不进 `clearAllCancels` / `clearAllForcePasses` 那一批。** 那两个清的是**一次性标记**
   * (取消、预先批准),而档位是 run 级的**持续状态**。redo 走 `applyRedo → startRun →
   * runOrchestrator`,用的是同一个 RunControl,那两个 clear 就在那条路上 —— 顺手把档位
   * 也清掉的话,用户降到初级、看着半成品被放行、按 `r` 重做,拿到的是又一次不设档的结果。
   * 这个仓库为「一次性标记忘了清」付过三次学费;这一条是它的**镜像**,同样值得一行注释。
   */
  let strictness: Strictness | undefined
  /**
   * 「并发上限变了」这一个事件 —— **一个共享的 promise,不是一张等待者表**。
   *
   * 评审量出来的:调度循环每转一圈就注册一个等待者,而只有 `setParallelism` 会清表 ——
   * 用户不碰并发度就永远不清。实跑一棵 11 节点的树跑完积压 22 个 resolver(随后一次
   * `setParallelism` 一起兑现 22/22,证明全程被持有)。`control.ts` 自己给暂停那张表写过
   * 同一条注释:「表只涨不落就是泄漏」。
   *
   * 换成一个共享 promise 之后,N 轮循环等的是**同一个**对象:表长恒为 1,而唤醒语义
   * 一个字没变(任何一次变更放行所有等待者)。
   */
  let limitChanged: { promise: Promise<void>; wake: () => void } = deferred()
  const directives: string[] = []
  let dropped = 0
  /** nodeId → 此刻在飞的 controller。一个节点可能同时有多个(圆桌的多席位)。 */
  const calls = new Map<string, Set<AbortController>>()
  const cancelled = new Set<string>()
  /** nodeId → 已预先批准的环节。空集合随手删掉,免得表只涨不落。 */
  const forcePassed = new Map<string, Set<PhaseName>>()

  return {
    isPaused: () => paused,
    pause() { paused = true },
    resume() {
      paused = false
      // 换出来再清空:不清的话 waiters 随暂停次数无界增长(每次 resume 都会把历史上
      // 所有等待者再唤醒一遍 —— 对已 resolve 的 promise 无害,但那是个只涨不落的表)。
      const w = waiters
      waiters = []
      for (const fn of w) {
        // 一个抛异常的等待者不能把别的等待者一起卡住 —— 它们各自是独立的调度循环。
        try { fn() } catch { /* 调用方自己的问题 */ }
      }
    },
    waitForResume() {
      // 已经恢复了就立刻返回。少了这一句,「暂停 → 立刻恢复 → 循环才开始等」会永久挂起:
      // 恢复的通知在它注册之前就发完了。
      if (!paused) return Promise.resolve()
      return new Promise<void>(res => { waiters.push(res) })
    },

    addDirective(text) {
      // 按**码点**截,不是按 UTF-16 单元:`.slice` 会把一个 emoji 劈成两半,尾部留下
      // 一个孤立的高代理(实测 \ud83d),它会原样进提示词。UI 侧一直是按码点算的,
      // 两边判据不一致时,恰好卡在边界的那条指令就会带着半个字符发出去。
      const t = Array.from(text.trim()).slice(0, MAX_DIRECTIVE_CHARS).join('')
      if (t.length === 0) return
      directives.push(t)
      // 挤掉最早的,并记下挤掉了几条 —— 静默丢弃用户亲手写的话是这个仓库反复付过代价的
      // 那一类:他会以为它生效了。
      while (directives.length > MAX_DIRECTIVES) {
        directives.shift()
        dropped++
      }
    },
    directives() {
      if (dropped === 0) return directives
      // 说出来。用户加过 25 条时,前 5 条不在提示词里,而他没有任何办法知道。
      return [`(较早的 ${dropped} 条追加指令因数量上限已被丢弃)`, ...directives]
    },

    registerCall(nodeId, controller) {
      const set = calls.get(nodeId) ?? new Set()
      set.add(controller)
      calls.set(nodeId, set)
      // 登记的**当下**就已经被取消过的话,立刻中止:取消请求和新一轮派发可能撞在一起,
      // 而那一轮本来就不该跑。
      if (cancelled.has(nodeId)) {
        try { controller.abort() } catch { /* 已经 abort 过 */ }
      }
      let off = false
      return () => {
        if (off) return
        off = true
        const s = calls.get(nodeId)
        if (!s) return
        s.delete(controller)
        if (s.size === 0) calls.delete(nodeId)
      }
    },
    cancelNode(nodeId) {
      cancelled.add(nodeId)
      for (const c of calls.get(nodeId) ?? []) {
        try { c.abort() } catch { /* 已经 abort 过 */ }
      }
    },
    wasCancelled: nodeId => cancelled.has(nodeId),
    clearCancel(nodeId) { cancelled.delete(nodeId) },
    clearAllCancels() { cancelled.clear() },

    forcePass(nodeId, phase) {
      // 白名单挡在**入口**,不是在消费点:进不来的东西不需要在四个环节里各挡一遍,
      // 而 UI 那侧的选项本来就只列这四个 —— 这一句挡的是接线错误,不是用户。
      if (!SKIPPABLE_PHASES.has(phase)) return
      const set = forcePassed.get(nodeId) ?? new Set<PhaseName>()
      set.add(phase)
      forcePassed.set(nodeId, set)
    },
    wasForcePassed: (nodeId, phase) => forcePassed.get(nodeId)?.has(phase) === true,
    clearForcePass(nodeId, phase) {
      const set = forcePassed.get(nodeId)
      if (!set) return
      set.delete(phase)
      // 空了就删掉整条:留着一个空 Set 会让 forcePassed 随节点数只涨不落,而
      // `control.ts` 已经为「表只涨不落就是泄漏」写过两次注释(waiters、limitChanged)。
      if (set.size === 0) forcePassed.delete(nodeId)
    },
    forcePassesOf: nodeId => [...(forcePassed.get(nodeId) ?? [])],
    clearAllForcePasses() {
      let n = 0
      for (const set of forcePassed.values()) n += set.size
      forcePassed.clear()
      return n
    },

    parallelism: () => parallelism,
    setParallelism(n) {
      const next = clampParallelism(n, parallelism ?? DEFAULT_PARALLELISM)
      // 没变就别动代数:否则一次「已经到上限了还按 +」会白白唤醒调度循环一次。
      if (next === parallelism) return
      parallelism = next
      parallelismGen++
      // 换出来再兑现:先把新的那一个装上,再唤醒旧的那些人 —— 反过来的话,一个被唤醒的
      // 等待者在同一个微任务里重新来等,可能等到的还是这个已经兑现的 promise。
      const prev = limitChanged
      limitChanged = deferred()
      prev.wake()
    },
    strictness: () => strictness,
    setStrictness(s) { strictness = s },
    parallelismGeneration: () => parallelismGen,
    waitForParallelism(seen) {
      // 已经变过了就立刻返回 —— 少了这一句,发生在「扫描之后、睡下之前」的那一次调整
      // 会被睡过去,而那正是用户最想它立刻生效的时刻。
      if (seen !== parallelismGen) return Promise.resolve()
      return limitChanged.promise
    },
  }
}
