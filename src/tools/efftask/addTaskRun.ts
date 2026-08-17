// src/tools/efftask/addTaskRun.ts
//
// 「新增任务」的**不纯那一半**:扣住 → 预留名额 → 复核 → 落盘 → 写回活对象 → 叫醒调度。
// 判据全在 `addTask.ts`(纯函数,可测);这里只负责**顺序**和**失败的说法**。
//
// ## 顺序为什么照 `applyRecalc`,不照 `runRedo`
//
// 重做手上是 `structuredClone` 出来的另一棵树(2215 节点实测 71 秒,而它同步跑在按键处理里);
// 这个功能是**就地改共享对象** —— 界面和编排器持有同一批节点对象。所以:
// **先在浅拷贝上写、落盘成功之后才把字段就地写回活对象**。反过来的话,`node.deps` 那一类
// 字段一改,编排器当场就按新树调度,而盘上没有它 —— 崩一次就是一个凭空消失的任务。
//
// ## 这个文件为什么不长在 efftask.tsx 里
//
// 和 `redoRun.ts` 逐字同因:那个组件挂不起来,于是唯一的防线是源码文本断言,而验收实测过
// **14 条存活变异**(算出来了不上屏 / 不进 state / `if (false)` 包住 start / 顺序对调 / …)。
// 所以每一步都是一个**可注入的回调**,由 `addTaskRun.test.ts` 真的调一次并断言顺序与参数。
import { affectedByAddTask, allocateChildId, type AddTaskScope } from './addTask.js'
import { clearReopenMarks, reopenAncestor } from './redo.js'
import { createNode, type TaskNode } from './types.js'

export interface AddTaskRunDeps {
  /** 活树。**每次现取** —— 关口开着的这几十秒里编排器一秒都没停。 */
  byId: () => Map<string, TaskNode>
  now: () => string
  /**
   * 扣住这次要动的节点。返回 `release`,**任何出口都要调**。
   *
   * 结束屏那条路没有编排器,这里缺席 —— 那时树是静态的,没有东西要扣。
   */
  hold?: (ids: readonly string[]) => { ok: true; release: () => void } | { ok: false; reason: string }
  /**
   * 预留一个节点名额(和 `createChildren` 共用 `maxNodes` 预算,原子)。
   * 返回 null = 装不下。同样**任何出口都要 release**:泄漏一个额度会让以后一次真的放得下的
   * 拆分被拒并阻断 —— 安全阀朝反方向坏掉,而且是静默的。
   */
  reserve?: () => { release: () => void } | null
  /**
   * 落盘一个节点。**必须是带 journal 的那条路**(`writeNode(fs, runDir, n, journal)`):
   * node.md 是整份覆盖写,磁盘满那一刻盘上留着的是**上一次**的完整文件,而这条路上最脆的
   * 一个字节正是 anchor 的 `childIds`。
   */
  persist: (n: TaskNode) => Promise<void>
  /**
   * 把一个刚落盘失败的孤儿节点从盘上抹掉。
   *
   * 少了它,「这次新增没有发生」就是假话:`resumeCore` 的链路修复会在下一次 `--resume`
   * **主动把孤儿挂回父节点的 childIds** 并开始跑它。
   */
  removeNode?: (id: string) => Promise<void>
  /** 新节点进树、叫醒调度。结束屏那条路缺席(那时要重启编排器)。 */
  taskAdded?: (node: TaskNode, affected: readonly string[]) => { ok: true } | { ok: false; reason: string }
  /**
   * 新树进 React state。**显式调,不靠 `taskAdded` 里那次 `safeUpdate` 的副作用** ——
   * `safeUpdate` 是 `try{…}catch{}`,渲染器抛一次,新节点就在盘上、在编排器里、真的在跑,
   * 而树上没有它,一行日志都没有。
   */
  onNodes: (nodes: TaskNode[]) => void
  /** 没做成的事 —— 空数组也要交,否则上一次的警告会一直挂着。 */
  onProblems: (problems: string[]) => void
  /** 这个 id 上的历史输出流要扔掉(重做删过子树时新 id 可能和被删的逐字相同)。 */
  onDropStreams?: (ids: readonly string[]) => void
  /** 结束屏那条路:把新树跑起来。 */
  start?: (nodes: TaskNode[]) => void
  /** 关掉关口。 */
  onDone: () => void
}

export type AddTaskOutcome =
  | { ok: true; node: TaskNode }
  | { ok: false; reason: string }

/**
 * 关口按下确认之后的全部动作。
 *
 * `scope` 是**关口渲染那一刻**算出来的那一份;这里会拿现在的树**重新算一次**并比对
 * (见 `revalidate`)。两者不一致 = 树在用户读那一屏的几十秒里变了,整个拒绝,盘上零字节。
 */
export async function runAddTask(
  scope: AddTaskScope,
  input: { title: string; prompt: string },
  deps: AddTaskRunDeps,
  /**
   * 复核:拿**现在**的树再算一遍 scope,和关口上那一份逐项比(`scopeDiff`)。
   * 返回一句话 = 差了,这次新增整个放弃。
   */
  revalidate: () => string | undefined,
): Promise<AddTaskOutcome> {
  const fail = (reason: string): AddTaskOutcome => {
    deps.onProblems([`新增任务未执行: ${reason}`])
    deps.onDone()
    return { ok: false, reason }
  }

  /**
   * 扣住 **anchor + 整条祖先链**,不只是「要重开的那几个」。
   *
   * 一个处在 `WAITING_CHILDREN + 子任务全 ACCEPTED` 的祖先此刻就是 integrate 可派的,而
   * `reopenAncestor` 对它早退返回 false → 不在重开名单里。不扣的话,落盘那次 await 期间它
   * 被派出去、拿**旧树**判通过、一路 ACCEPTED 到 root,下一轮 `runLoop` 首句直接
   * `return completed` —— 屏幕说「确认后即可被调度」,而 run 已经收工。
   */
  const held = deps.hold?.(scope.chain)
  if (held && held.ok !== true) return fail(held.reason)

  // 名额排在 hold 之后:hold 是同步的、失败最常见,而且失败时什么都没发生。
  const slot = deps.reserve?.()
  if (deps.reserve && !slot) {
    held?.release()
    return fail('这一趟的任务数已经到上限,再加一个会超出启动关口批准的规模。')
  }

  try {
    const stale = revalidate()
    if (stale !== undefined) return fail(stale)

    const byId = deps.byId()
    const anchor = byId.get(scope.anchor.id)
    if (!anchor) return fail(`挂载点「${scope.anchor.title}」已经不在树里了 —— 这次新增没有发生。`)

    const now = deps.now()
    // id 在**这一刻**现算并躲开所有已存在的 id:关口开着期间 `growTree` 可以从别的节点的
    // 执行步里往同一个 anchor 挂子节点,而 `hold` 挡不住它(`held` 集合不在 `ctx()` 里)。
    const id = allocateChildId(anchor, input.title, byId)
    const node = createNode({
      id,
      title: input.title,
      // 逐字。用户的原话就是这个任务的提示词 —— 不拼父目标、不加「本子任务:」。
      goal: input.prompt,
      parentId: anchor.id,
      deps: [],
      depth: anchor.depth + 1,
      phaseRoles: anchor.phaseRoles,
      now,
    })
    node.manualAdd = { at: now, anchorId: anchor.id }

    /**
     * 草稿。**`childIds` 必须换成新数组** —— `{...anchor}` 与活对象共享那个数组,
     * 在草稿上 `push` 就是直接改活对象,而下面「落盘失败 = 内存里还是旧的」当场作废。
     * `iteration` 同理(`clearReopenMarks` 会整份换掉它,但别指望调用顺序)。
     */
    const anchorDraft: TaskNode = {
      ...anchor,
      childIds: [...anchor.childIds, id],
      iteration: { ...anchor.iteration },
      kind: 'decompose',
      updatedAt: now,
    }
    /**
     * anchor 的状态**显式写**,不借 `reopenAncestor` 算 —— 它是给祖先写的,状态从
     * `childIds.length`/`kind` 现算,对一个叶子 anchor 会算出 `READY`,而那意味着
     * 带写工具的执行者把一份已验收、已合进主干的产出再跑一遍(三席各自打回,一席实跑出读数)。
     */
    if (scope.anchorSeat !== undefined) {
      anchorDraft.status = scope.anchorSeat
      clearReopenMarks(anchorDraft, now)
    }

    const ancestorDrafts: TaskNode[] = []
    for (const r of scope.reopen) {
      const live = byId.get(r.id)
      if (!live) continue
      const draft: TaskNode = { ...live, childIds: [...live.childIds], iteration: { ...live.iteration } }
      // 祖先按构造必然有子节点,所以 `reopenAncestor` 算出来的就是 WAITING_CHILDREN。
      // 它自己判动不动(结构性阻断返回 false 且一个字段都不碰)。
      if (reopenAncestor(draft, now)) ancestorDrafts.push(draft)
    }

    /**
     * 落盘。**新节点在前,anchor 在后。**
     *
     * 反过来的话 anchor 的 `childIds` 会指向一个盘上不存在的节点 → 下一次 `--resume` 判
     * 「子节点缺失」→ `validateLoadedNodes` 的 `block()` 把 `interrupted`/`capBlocked`/
     * `mergeConflict` 三个复活开关**全部清零**,`--retry-blocked` 和重做都救不回来。
     */
    try {
      await deps.persist(node)
    } catch (e) {
      return fail(`落盘失败,这次新增没有发生: ${msg(e)}`)
    }
    /**
     * **`childIds` 在这里重新取一次,不用上面那份快照。**
     *
     * 上面那一行是**两次 await 之前**的样子,而 `hold` 挡不住 `growTree`(`held` 集合根本
     * 不在 `ctx()` 里)—— 别的节点的执行步完全可以在这期间往同一个 anchor 上挂子节点,
     * 而 `createChildren` 是 `node.childIds.push(...)` 就地改活对象。
     *
     * 拿旧快照写下去的后果是验收席实跑出来的:那个新挂上的子节点**从 anchor 的 childIds
     * 里整份消失**(内存和盘上都是),而它自己还在 `byId` 里、还会被派出去跑 ——
     * 于是 anchor 的 `childrenAllAccepted` 不等它就能提前集成通过,盘上它是个孤儿。
     */
    anchorDraft.childIds = mergeChildIds(byId.get(scope.anchor.id)?.childIds ?? anchor.childIds, id)
    try {
      await deps.persist(anchorDraft)
    } catch (e) {
      /**
       * 新节点已经在盘上、而 anchor 没挂上它 = 一个孤儿。
       *
       * 「什么都没发生」在这里是**假话**:`resumeCore` 的链路修复会在下一次 `--resume`
       * 主动把孤儿补回父节点的 childIds 并开始跑它。所以先尽力删掉;删不掉就把真相和
       * 唯一能兑现的下一步一起说出来。
       */
      let cleaned = false
      try {
        await deps.removeNode?.(id)
        cleaned = deps.removeNode !== undefined
      } catch { /* 下面那句话会把它说出来 */ }
      return fail(
        cleaned
          ? `挂载点落盘失败,这次新增没有发生(新任务的文件已经清掉): ${msg(e)}`
          : `挂载点落盘失败: ${msg(e)}。新任务的文件已经落在盘上但没挂进树 —— ` +
            `下次 /et --resume 会自动把它挂回「${anchor.title}」下面并开始跑;不想要它请手工删掉 ${id} 那个目录。`,
      )
    }
    const ancestorProblems: string[] = []
    for (const d of ancestorDrafts) {
      try {
        await deps.persist(d)
      } catch (e) {
        // 不中断:新任务已经挂进树了,这一条只影响「上级会不会重判」。但必须说 ——
        // 盘上那个祖先还是 ACCEPTED,下次 --resume 之后新任务不会被调度。
        ancestorProblems.push(
          `上级任务 ${d.id} 没能写回盘上(下次 --resume 会读到它重开之前的状态,` +
          `那时这个新任务不会被调度): ${msg(e)}`,
        )
      }
    }

    /**
     * 落盘成功之后才动活对象,而且**只写字段**(不换对象)——
     * `orchestrator.nodes()` 只复制数组,界面和编排器持有的是同一批节点对象。
     */
    // 同上:写回也**合并**,不是覆盖 —— 落盘那次 await 期间 growTree 还可以再挂一个。
    anchor.childIds = mergeChildIds(anchor.childIds, id)
    anchor.kind = anchorDraft.kind
    if (scope.anchorSeat !== undefined) copyReopened(anchor, anchorDraft)
    anchor.updatedAt = anchorDraft.updatedAt
    for (const d of ancestorDrafts) {
      const live = byId.get(d.id)
      if (!live) continue
      copyReopened(live, d)
    }

    /**
     * 历史输出流:childId 由「父 id + 序号 + 标题 slug」算出,重做删过子树之后新 id 可能和
     * 被删的那个逐字相同 —— 不扔的话,新任务的详情页会顶着上一轮的运行记录。
     * **排在 `onNodes` 之前**:先换树后删流,中间那一帧里新节点会显示别人的输出。
     */
    deps.onDropStreams?.([id])

    const problems = [...ancestorProblems]
    const added = deps.taskAdded?.(node, affectedByAddTask(scope, id))
    if (added && added.ok !== true) {
      problems.push(
        `新任务已经写进磁盘,但没能并进正在跑的这一轮(${added.reason})—— ` +
        `等本轮结束后 /et --resume 会按新树继续。`,
      )
    }
    /**
     * 交出去的那棵树**自己保证新节点在里面**,不靠 `taskAdded` 的副作用。
     *
     * 运行中那条路上 `taskAdded` 确实会先 `byId.set`,但**结束屏那条路根本没有它** ——
     * 那时 `byId()` 是从 React 的 `nodes` 数组建的,没有任何东西会把新节点放进去。
     * 照 `[...byId().values()]` 直接交,结果是:节点在盘上、`startRun` 拿到的 seed 里
     * 没有它 —— 这个功能在结束屏上整个失效,而屏幕说加好了。(探针实测。)
     */
    const publish = (): TaskNode[] => {
      const m = deps.byId()
      return m.has(node.id) ? [...m.values()] : [...m.values(), node]
    }
    // 显式上屏。`taskAdded` 里那次 safeUpdate 是 try/catch 吞异常的,不能当唯一通道。
    deps.onNodes(publish())
    deps.onProblems(problems)
    /**
     * **`onDone` 必须排在 `start` 之前。**
     *
     * 反过来的实测读数(验收席):结束屏那条路上 `start` → `startRun` 已经把界面切成
     * `'running'`,紧接着 `onDone` 的关屏逻辑又把它盖回 `'done'` —— 于是**整轮编排在一屏
     * 「已结束」下面跑完**:`p`/`i`/`x` 三个干预键不存在、没有中止入口、`Esc`/`q` 直接退出
     * 而 run 还在飞;再按一次 `a` 会被 `runLive` 挡下,任务写进盘却不跑。
     *
     * 这个顺序两条路都对:运行中 `onDone` 直接切回运行视图;结束屏 `onDone` 先落回结束屏,
     * 再由 `startRun` 切成运行视图,而 `startRun` 起不来时就留在结束屏 —— 正好是
     * 「起不来要说出口」那句话想要的语义。
     *
     * (`runRedo` 在成功路径上干脆不调 `onDone`,只调 `start`;这里两条路共用一份 deps,
     * 所以取「先关屏再起跑」这个等价形状。)
     */
    deps.onDone()
    deps.start?.(publish())
    return { ok: true, node }
  } finally {
    // 无条件,而且两个都要放。扣住不放 = 这几个节点再也不会被调度,而屏幕上什么都不会说;
    // 名额不放 = 以后一次真的放得下的拆分被拒并阻断。
    slot?.release()
    held?.release()
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 把新 id 并进一份**当下**的子列表,而不是拿旧快照整份覆盖。
 *
 * 幂等(已经在里面就原样返回),因为落盘那条路上这个函数会被调用两次:
 * 一次给草稿、一次写回活对象,中间还隔着几次 await。
 */
function mergeChildIds(current: readonly string[], id: string): string[] {
  return current.includes(id) ? [...current] : [...current, id]
}

/**
 * 把草稿上「重新开工」那一组字段搬回活对象。
 *
 * **逐字段搬,不是 `Object.assign(live, draft)`** —— 后者会把 `childIds`/`plan`/`reviewLog`
 * 这些引用一起换掉,而此刻可能有别的路径正拿着活对象上那几个数组。清单和
 * `clearReopenMarks` 动的那几个一一对应:漏一个,重开就是半次(这个仓库为
 * `startedAt` 漏清付过两次账 —— 一个两天前被牵连阻断的节点重开后会当场显示 `172800s`
 * 并每秒往上跳)。
 */
function copyReopened(live: TaskNode, draft: TaskNode): void {
  live.status = draft.status
  live.blockedReason = draft.blockedReason
  live.interrupted = draft.interrupted
  live.cancelled = draft.cancelled
  live.capBlocked = draft.capBlocked
  live.capCategory = draft.capCategory
  live.failedAt = draft.failedAt
  live.iteration = { ...draft.iteration }
  live.startedAt = draft.startedAt
  live.finishedAt = draft.finishedAt
  live.updatedAt = draft.updatedAt
}
