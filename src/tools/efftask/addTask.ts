// src/tools/efftask/addTask.ts
//
// 「用一段提示词新增一个任务」的**纯判据那一半**。全部是同步内存读、零 await ——
// 关口正是靠这一点做到「准入被拒时根本不切屏」:切屏会把任务树连同详情页整棵卸载,
// 而用户展开到哪一段、读到第几行都住在那两个组件自己的 state 里。
// 「什么都没发生」不该长成「你的阅读位置没了」。
//
// 顺序和落盘住在 `addTaskRun.ts`;这里只回答三个问题:
//   1. 这个节点上能不能加(不能的话,挂到它父节点上行不行);
//   2. 为了让新任务真的跑起来,还要把哪些上级放回可推进状态;
//   3. 关口上要对用户说什么。
import { isStructural } from './redo.js'
import { hasBlockedAncestor } from './scheduler.js'
import { childId, slugify } from './persistence.js'
import { MAX_TASK_PROMPT_CHARS, type Caps, type NodeStatus, type TaskNode } from './types.js'

/** 标题最多几个码点。和 `slugify` 的截断长度一致,免得标题和 id 各截各的。 */
export const MAX_TASK_TITLE_CHARS = 40

/** 一条都读不出来时的兜底标题。空标题会在树上画出一行没有名字的任务。 */
export const FALLBACK_TASK_TITLE = '新增任务'

export interface AddTaskScope {
  ok: true
  /** 新任务挂在谁下面。 */
  anchor: TaskNode
  /**
   * anchor 不是详情页那个节点时,**为什么**。关口逐字印它 ——
   * 两种挂点是这个功能唯一会让人意外的地方,而屏幕是他唯一的信息来源。
   */
  anchorNote?: string
  /** anchor 自己要不要换状态(`undefined` = 不动,它已经在等子任务了)。 */
  anchorSeat?: NodeStatus
  /** anchor 被重开时它原来的阻断理由 —— 会被 `clearReopenMarks` 抹掉,所以先留一份给关口。 */
  anchorWas?: { status: NodeStatus; blockedReason: string }
  /** 要重新打开的**祖先**(自 anchor 的父起,向上到 root),按从近到远。 */
  reopen: { id: string; title: string; from: NodeStatus }[]
  /**
   * 这次操作会碰到的全部 id —— anchor + **整条祖先链**(不管要不要重开)。
   *
   * `hold` 收的就是它。只扣「要重开的」是不够的:一个处在
   * `WAITING_CHILDREN + 子任务全 ACCEPTED` 的祖先此刻**就是 integrate 可派的**,而
   * `reopenAncestor` 对它早退返回 false → 不在重开名单里 → 不被扣 → 落盘那次 await 期间
   * 它被派出去、拿旧树判通过、一路 ACCEPTED 到 root → 下一轮 `runLoop` 首句 return completed。
   * 屏幕说「确认后即可被调度」,而 run 已经收工。
   *
   * ⚠ **`hold` 挡不住 `growTree`**,而且它自己也不是互斥的(同一批 id 可以被扣两次,
   * 先释放的那次把后一次也解了)。所以这条链只保证「调度循环不会派它们」,
   * 不保证「没有别人在改它们」—— 落盘那一步因此要重取 `childIds`(见 addTaskRun)。
   */
  chain: string[]
  /** 目标节点自己仍然是 BLOCKED(anchor 上卷时才可能为真)—— 关口要说出来。 */
  targetStillBlocked?: { title: string; why: string }
}

export interface AddTaskRefusal {
  ok: false
  reason: string
  /** 逐条细说(候选节点各自为什么不行)。 */
  details: string[]
}

/**
 * 一个候选节点能不能当 anchor。
 *
 * ## 白名单,不是「非终态就行」
 *
 * 状态一共 15 个(`NODE_STATUSES`),而这里只放行三种形态。理由是这个仓库**已经有一份**
 * 「能不能往这个节点挂子任务」的判据 —— `growTree`(pipeline.ts),它的注释带着 `(reproduced)`:
 *
 *   grafting onto a CREATED/READY node overwrote its status and kind, so its own plan and
 *   execute phases were deleted outright … The safe set is: the executing node itself,
 *   or a node that is already waiting on children.
 *
 * 挂子节点意味着这个节点变成拆分节点(`kind='decompose'` + `WAITING_CHILDREN`),而
 * `advanceableKind` 的 `READY → execute` 那一支要求 `kind === 'executable'` —— 于是它**自己
 * 那份还没干完的活从此没有任何一条路会去干**。这就是「把 FAIL 变成 PASS」。
 *
 * 三种放行形态各自的理由:
 *  - `WAITING_CHILDREN` + 有子节点:它本来就在等子任务,多等一个不改变任何判决;
 *  - `ACCEPTED`:它自己的活已经做完并合进集成分支了,重开只是让它重判一次
 *    「子任务合起来还算不算达成了父目标」;
 *  - 非结构性 `BLOCKED` + **有子节点**:拆分节点自己的「活」就是判决,重开之后集成验收会重跑。
 *    **叶子不在此列** —— 把一个执行失败的叶子放成 `WAITING_CHILDREN`,它会绕过自己失败的
 *    那个执行环节,靠集成验收就能 ACCEPTED。
 */
function anchorRefusal(
  n: TaskNode,
  opts: { inFlight: ReadonlySet<string>; cancelled: (id: string) => boolean; maxDepth: number },
): string | undefined {
  if (opts.inFlight.has(n.id)) {
    return `「${n.title}」此刻正在运行(或被另一次操作扣住)`
  }
  if (n.cancelled === true || opts.cancelled(n.id)) {
    return `「${n.title}」你按 x 取消过 —— 新增不会替你改主意(那等于把你明确拒绝过的任务放回队列)。要跑它请先按 r 重做。`
  }
  if (n.depth + 1 > opts.maxDepth) {
    return `「${n.title}」已达深度上限 ${opts.maxDepth},不能再往它下面加一层`
  }
  const decomposed = n.childIds.length > 0
  if (n.status === 'WAITING_CHILDREN' && decomposed) return undefined
  if (n.status === 'ACCEPTED') return undefined
  if (n.status === 'BLOCKED') {
    if (isStructural(n.blockedReason)) {
      return `「${n.title}」是结构性阻断(${n.blockedReason})—— 这棵树自己对不上,重开它只会让一批没法核实的工作跑起来`
    }
    if (!decomposed) {
      return `「${n.title}」是一个失败的执行任务 —— 给它挂子任务会让它绕过自己失败的那个环节,` +
        `靠集成验收就判通过。请先按 r / R / s 处理它,或者把新任务加到它的上级上。`
    }
    return undefined
  }
  if (n.status === 'CREATED') {
    return `「${n.title}」还没出方案(${n.status})—— 现在给它挂子任务,会把它这一轮分析出来的整份拆分丢掉,` +
      `它自己那份活也不会再被执行`
  }
  if (n.status === 'READY') {
    return `「${n.title}」方案写好了还没执行(${n.status})—— 现在给它挂子任务会顶掉它自己的执行环节`
  }
  return `「${n.title}」当前是 ${n.status},还没走完自己的方案/执行阶段 —— 向它插子节点会顶掉那些阶段`
}

/**
 * 这一刻能不能在 `target` 上新增任务,以及新任务最终会挂在哪。
 *
 * 候选顺序是 `[target, target 的父节点]`,取第一个可挂的。**只上卷一层,不递归** ——
 * 递归会把任务挂到用户完全预期不到的地方,而卷一层的落点(target 的兄弟)仍然在他正看着的
 * 那一屏上。
 */
export function addTaskScope(
  target: TaskNode,
  byId: Map<string, TaskNode>,
  opts: {
    /**
     * 此刻**不该被碰**的节点:在飞的 + 被别的操作扣住的(`runningNodeIds` ∪ `heldNodeIds`)。
     *
     * ⚠ 上一版这里写的是「编排器把被扣住的也折在这一个集合里」——**那是假话**,
     * 验收席实跑推翻的:折进同一个集合的是 `pickBatch` 的入参,而界面传进来的是
     * `runningNodeIds()`,它**不含** `held`。所以两份都要由调用方并起来传。
     */
    inFlight?: ReadonlySet<string>
    /** `control.wasCancelled` —— 内存里那一份,和节点上的 `cancelled` 是两处。 */
    wasCancelled?: (id: string) => boolean
    caps: Caps
    /** 树上一共几个节点(容量判据)。 */
    nodeCount: number
    /** 编排器额外预留了几个名额(`reservedCount()`)。 */
    reserved?: number
  },
): AddTaskScope | AddTaskRefusal {
  const inFlight = opts.inFlight ?? new Set<string>()
  const cancelled = opts.wasCancelled ?? ((): boolean => false)
  const no = (reason: string, details: string[] = []): AddTaskRefusal => ({ ok: false, reason, details })

  // 容量排在最前:它讲的是「这一趟装不下了」,而下面每一条讲的都是「这个节点不合适」。
  // 两句话用户的下一步完全不同。
  const cap = capacityRefusal(opts.nodeCount, opts.reserved ?? 0, opts.caps)
  if (cap !== undefined) return no(cap)

  const parent = target.parentId === null ? undefined : byId.get(target.parentId)
  const check = { inFlight, cancelled, maxDepth: opts.caps.maxDepth }
  const targetWhy = anchorRefusal(target, check)
  let anchor = target
  let anchorNote: string | undefined
  if (targetWhy !== undefined) {
    if (!parent) {
      return no(
        '这个任务上加不了新任务,而它没有上级可以退而求其次。',
        [targetWhy, '根任务通常是拆分任务;它是一个还没跑完的执行任务时,请等它跑完,或者按 r 重做并在提示词里说清要多做什么。'],
      )
    }
    const parentWhy = anchorRefusal(parent, check)
    if (parentWhy !== undefined) {
      return no('这个任务和它的上级现在都挂不上新任务。', [targetWhy, parentWhy])
    }
    anchor = parent
    anchorNote = `${targetWhy};所以新任务挂到它的上级「${parent.title}」下面,成为它的兄弟任务。`
  }

  /**
   * 祖先链。**anchor 自己不在里面** —— 它由 `anchorSeat` 单独管(见 `clearReopenMarks` 的
   * 注释:`reopenAncestor` 的状态是现算的,对叶子 anchor 会算出 `READY`)。
   */
  const chain: string[] = [anchor.id]
  const reopen: AddTaskScope['reopen'] = []
  const seen = new Set<string>([anchor.id])
  let cur = anchor.parentId === null ? undefined : byId.get(anchor.parentId)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur.id)
    if (cur.cancelled === true || cancelled(cur.id)) {
      return no(
        `上级任务「${cur.title}」你按 x 取消过 —— 放开它等于替你改主意。`,
        ['要在这棵子树里加任务,请先对它按 r 重做。'],
      )
    }
    if (cur.status === 'BLOCKED' && isStructural(cur.blockedReason)) {
      return no(
        `上级任务「${cur.title}」是结构性阻断(${cur.blockedReason})。`,
        ['新任务挂上去也不会被调度 —— 它的整棵子树都不会再被调度。'],
      )
    }
    if (cur.status === 'ACCEPTED' || cur.status === 'BLOCKED') {
      reopen.push({ id: cur.id, title: cur.title, from: cur.status })
    }
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
  }

  const decomposed = anchor.childIds.length > 0
  // `WAITING_CHILDREN` 且已有子节点 = 它已经在等了,状态不动。其余两种(ACCEPTED /
  // 非结构性 BLOCKED)都要显式坐到 WAITING_CHILDREN —— **不走 `reopenAncestor`**,
  // 它对叶子会算出 READY,而那意味着执行者把一份已验收的产出再跑一遍。
  const anchorSeat: NodeStatus | undefined =
    anchor.status === 'WAITING_CHILDREN' && decomposed ? undefined : 'WAITING_CHILDREN'

  const out: AddTaskScope = {
    ok: true,
    anchor,
    ...(anchorNote === undefined ? {} : { anchorNote }),
    ...(anchorSeat === undefined ? {} : { anchorSeat }),
    ...(anchorSeat === undefined
      ? {}
      : { anchorWas: { status: anchor.status, blockedReason: anchor.blockedReason } }),
    reopen,
    chain,
  }
  /**
   * 目标自己仍然阻断时要说出来。
   *
   * 用户按 `a` 最典型的时刻就是盯着一个失败任务想补一个救它的任务。上卷之后新任务确实会跑、
   * 产出也确实会合进去,但目标仍是 BLOCKED,`propagateBlocked` 迟早会因 `childBlocked` 把
   * anchor 连同整条链重新摁成 BLOCKED —— 这一趟最后仍以阻断收尾。不说 = 让他以为救活了。
   */
  if (anchor.id !== target.id && target.status === 'BLOCKED') {
    out.targetStillBlocked = {
      title: target.title,
      why: target.blockedReason || '(没有记下原因)',
    }
  } else {
    /**
     * anchor **自己**被重开、但它底下还有别的孩子仍然阻断时,同样要说。
     *
     * 上一版只在「anchor ≠ target」时提示,于是最常见的另一半漏了:用户在一个
     * `BLOCKED/子节点阻断` 的拆分节点上按 `a`,关口只说「会重新打开」「即可被调度」——
     * 而重开之后 `advanceableKind(anchor)` 因为那个仍然 BLOCKED 的兄弟恒为 null,
     * 这一轮照样以阻断收尾。验收席实跑出来的。
     */
    const stuck = anchor.childIds
      .map(id => byId.get(id))
      .filter((c): c is TaskNode => c !== undefined && c.status === 'BLOCKED')
    if (anchorSeat !== undefined && stuck.length > 0) {
      out.targetStillBlocked = {
        title: stuck.map(c => c.title).slice(0, 3).join('、') + (stuck.length > 3 ? ` 等 ${stuck.length} 个` : ''),
        why: stuck[0].blockedReason || '(没有记下原因)',
      }
    }
  }
  return out
}

/**
 * 节点数上限。**和 `orchestrator.reserveNodes` 同一条算式**,抽出来是因为结束屏那条路
 * 没有编排器,只能自己算 —— 而两份判据迟早会分叉。
 */
export function capacityRefusal(nodeCount: number, reserved: number, caps: Caps): string | undefined {
  if (nodeCount + reserved + 1 <= caps.maxNodes) return undefined
  return `这一趟的任务数已经到上限(${caps.maxNodes})—— 再加一个会超出启动关口批准的规模。`
}

/**
 * 从提示词里截一个标题。
 *
 * **不问模型要。** 一次可以失败、要花钱、还会卡住按键处理的调用,换一个直接截得出来的字符串;
 * 而这个功能整条路上零模型调用正是它能同步给出确定答复的全部原因。
 *
 * 判据是「**去掉控制字符之后的第一条非空行**」,不是裸 `split('\n')[0]`:粘贴进来的文本
 * 首行完全可能是 ANSI/BEL 之类的控制字节,`trim()` 只吃空白,于是标题成了空串 ——
 * 树上多一行没有名字的任务,`slugify('')` 还会被喂进 `childId`。
 */
export function deriveTitle(prompt: string): string {
  const lines = prompt
    /**
     * **先剥 CSI 序列,再处理单个控制字节。**
     *
     * 只换掉 ESC 那一个字节是不够的:`ESC[2J`(清屏)剥完剩下可打印的 `[2J`,于是标题
     * 变成 `"[2J"` —— 验收席粘一段带 ANSI 的日志实测出来的。序列的尾巴是普通字符,
     * 逐字节过滤永远看不见它们属于一个转义序列。
     */
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    /**
     * 控制字符换成空格,不是删掉:`a<BEL>b` 删掉之后是 `ab`(两个词粘成一个),
     * 换成空格才是原意。**换行不在这个字符类里** —— 下一行要按行切。
     *
     * **写成转义序列,不写字面控制字节。** 这个仓库的 grep 会把带字面控制字节的 .ts
     * 判成 binary 并**静默跳过**(为此漏掉过三处假实现),而那些字节在编辑器里看不见。
     */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
  const first = lines[0]
  if (first === undefined) return FALLBACK_TASK_TITLE
  const cut = Array.from(first).slice(0, MAX_TASK_TITLE_CHARS).join('').trim()
  return cut.length > 0 ? cut : FALLBACK_TASK_TITLE
}

/**
 * 新子节点用哪个序号。
 *
 * **不是 `childIds.length + 1`。** `childId` 自己的注释写着「same (index, title) twice yields
 * the same id, and writeNode would **overwrite**」,而 `createChildren` 记着实测后果:
 * 「reset an ACCEPTED sibling to CREATED, wiped its execStatus … irreversible loss of real work」。
 * 用 `length` 会在两条真实的路上撞上:
 *
 *  1. **重做删过子树**之后 `childIds` 变短,新序号回退到一个盘上还留着记录的号;
 *  2. **`growTree` 从别的节点的执行步里往同一个 anchor 挂子节点** —— 而 `hold` 挡不住它
 *     (`held` 集合根本不在 `ctx()` 里,`pickBatch` 之外的路径看不见它)。
 *
 * 所以取现有子 id 里 `NN-` 的**最大值** +1。这只是把撞的概率降下来,不是保证 ——
 * 真正的保证是调用方在落盘之前 `while (byId.has(id)) index++` 再查一次。
 */
export function nextChildIndex(anchor: TaskNode): number {
  let max = anchor.childIds.length
  for (const id of anchor.childIds) {
    const tail = id.slice(anchor.id.length + 1)
    const m = /^(\d+)-/.exec(tail)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max + 1
}

/**
 * 最终落盘的那个 id —— **在 hold 之后现算**,并且躲开所有已存在的 id。
 *
 * 两个不同的提示词完全可能派生出同一个 slug(实测:`修 bug!` 和 `修 bug?` 都是 `修-bug`),
 * 而 slug 还会整体退化成 `node`(`slugify` 的兜底)。
 */
export function allocateChildId(anchor: TaskNode, title: string, byId: ReadonlyMap<string, TaskNode>): string {
  let index = nextChildIndex(anchor)
  let id = childId(anchor.id, index, title)
  // 有界:100 个同名兄弟已经远超 maxNodes 的默认值,而无界循环比撞 id 更糟。
  for (let guard = 0; byId.has(id) && guard < 200; guard++) {
    index++
    id = childId(anchor.id, index, title)
  }
  return id
}

/** slug 退化成兜底名了吗 —— 关口要据此决定印不印那句「目录名会是 …」。 */
export function slugDegraded(title: string): boolean {
  return slugify(title) === 'node'
}

/**
 * 关口上要说的话。
 *
 * 一次算全,由组件渲染 —— 这样「屏幕上写着的」和「按下去发生的」出自同一份计算。
 */
export function addTaskLines(
  scope: AddTaskScope,
  input: {
    title: string
    id: string
    prompt: string
    /**
     * 输入框因为长度上限丢掉了几个字。没有就不印。
     *
     * **不收「折平了几处换行」** —— 这一屏的输入框开了 `keepNewlines`,换行原样留着,
     * 所以那个数恒为 0。收一个恒为 0 的参数就是一条永远不会执行的分支,而这个仓库刚为
     * 不可达分支付过一轮验收。
     */
    droppedChars?: number
    /** 新任务此刻跑得起来吗(`notSchedulableReason` 的结果)。 */
    notSchedulable?: string
    /** 结束屏那条路:确认后会重启一轮编排。 */
    willRestart?: boolean
    /** 结束屏那条路会清掉的一次性标记。 */
    clearsCancels?: number
    clearsForcePasses?: number
  },
): string[] {
  const out: string[] = []
  out.push(`新任务: ${input.title}`)
  out.push(`任务 id: ${input.id}`)
  if (slugDegraded(input.title)) {
    out.push('⚠ 这个标题里没有可用作目录名的字符,目录名会退化成 node —— 同类任务在盘上会长得很像。')
  }
  if ((input.droppedChars ?? 0) > 0) {
    out.push(`⚠ 超出长度上限 ${MAX_TASK_PROMPT_CHARS},末尾 ${input.droppedChars} 个字没有收进来。`)
  }
  out.push(`挂在: ${scope.anchor.title}(${scope.anchor.id})`)
  if (scope.anchorNote) out.push(`为什么不是你正看着的那个: ${scope.anchorNote}`)
  if (scope.anchorSeat !== undefined && scope.anchorWas) {
    const was = scope.anchorWas
    out.push(
      `「${scope.anchor.title}」会从 ${was.status} 重新打开成 ${scope.anchorSeat},` +
      `等这个新任务完成后重跑一次集成验收;它的集成验收/评分预算会被重置。`,
    )
    if (was.blockedReason) out.push(`它原来的阻断原因(会被清掉,先记在这里): ${was.blockedReason}`)
  }
  if (scope.reopen.length > 0) {
    out.push(
      `会一并重新打开 ${scope.reopen.length} 个上级任务(它们会重跑集成验收): ` +
      scope.reopen.map(r => `${r.title}[${r.from}]`).join('、'),
    )
  }
  if (scope.targetStillBlocked) {
    out.push(
      `⚠「${scope.targetStillBlocked.title}」仍然是阻断的,这次新增不会让它变绿 —— ` +
      `本轮最后仍会以阻断收尾。要救它请按 r / R / s。`,
    )
  }
  out.push(
    input.notSchedulable === undefined
      ? '确认后这个任务即可被调度。'
      : `确认后它还不会马上跑: ${input.notSchedulable}`,
  )
  if (input.willRestart === true) {
    out.push('本次编排已经结束 —— 确认后会重新起一轮编排来跑它。')
    if ((input.clearsCancels ?? 0) > 0) {
      out.push(`⚠ 重开编排会清掉全部取消标记:此前按 x 取消过的 ${input.clearsCancels} 个任务会重新获得机会。`)
    }
    if ((input.clearsForcePasses ?? 0) > 0) {
      out.push(`⚠ 你按下过的 ${input.clearsForcePasses} 条预先批准会因为重开编排而失效。`)
    }
  }
  return out
}

/**
 * 新任务挂上去之后**当场跑得起来吗** —— 走 `notSchedulableReason`,和 `pickBatch` 同一份判据。
 *
 * 只判「依赖满足没有」会在祖先阻断上说谎:那种节点依赖全满足也永远不会被调度。
 * 这里问的是 anchor 的可调度性的镜像 —— 新节点是 CREATED、零依赖,所以唯一会挡住它的是
 * 「上级已阻断」,而祖先链刚刚被放开过。
 */
export function addedTaskBlockedBy(
  anchor: TaskNode,
  byId: Map<string, TaskNode>,
  /**
   * **这次操作自己要放开的那些。**
   *
   * 少了它,这一行会在这个键**最典型**的用法上说反话:用户盯着一个挂掉的任务按 `a`,
   * 而 anchor 或它的祖先正是这次操作要重开的那几个 —— 屏幕上一半写着「会从 BLOCKED
   * 重新打开成 WAITING_CHILDREN」,另一半写着「确认后它还不会马上跑:上级仍是阻断的」。
   * 一屏之内自相矛盾,而后一句在确认之后当场变成假话(两位验收员各自复现)。
   *
   * 所以判据是「**这次操作放不开**的阻断」,不是「此刻有没有阻断」。
   */
  plan?: { anchorReopened?: boolean; willReopen?: ReadonlySet<string> },
  inFlight?: ReadonlySet<string>,
): string | undefined {
  const willReopen = plan?.willReopen ?? new Set<string>()
  if (anchor.status === 'BLOCKED' && plan?.anchorReopened !== true) {
    return '它的上级此刻是阻断的,而这次新增放不开它'
  }
  // 祖先链:只报**不在重开名单里**的那些。`seen` 防父子成环(盘上真的会回来这种树)。
  const seen = new Set<string>([anchor.id])
  let cur = anchor.parentId === null ? undefined : byId.get(anchor.parentId)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.status === 'BLOCKED' && !willReopen.has(cur.id)) {
      return `上级任务「${cur.title}」是阻断的,而这次新增放不开它`
    }
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId)
  }
  // anchor 自己此刻能不能推进不影响新节点(新节点是 CREATED、零依赖),但 anchor 在飞时
  // 这次新增本来就被拒了。留一句兜底,免得以后判据变了这里恒返回 undefined。
  return inFlight?.has(anchor.id) === true ? '它的上级此刻正在运行' : undefined
}

/**
 * 关口上那一屏算出来的 scope,和**按下确认那一刻**重算的那一份,差在哪。
 *
 * 返回一句话 = 差了,这次新增整个放弃(盘上一个字节都没动)。
 *
 * ## 为什么不是「用新算的那份接着做」
 *
 * 用户是**照着屏幕**按下确认的:那一屏逐条列了会重开哪几个上级、预算会被重置、
 * 目标仍然是阻断的。树在他读那几十秒里变了,就意味着他批准的后果和将要发生的后果
 * 不是同一件事 —— 那时候正确的做法是让他重新看一眼,不是替他决定。
 *
 * **`anchorSeat` 必须比**,而它是验收席实跑出来的一条 P0:anchor 在关口期间跑完
 * (`WAITING_CHILDREN` → `ACCEPTED`),`anchor.id` 和 `reopen` 清单**都没变**,于是旧判据
 * 放行,而落盘按旧的 `anchorSeat === undefined` 走 ——「不用改状态」——
 * 新任务就挂在了一个**终态**父节点下面:它自己会被派出去跑,而 anchor 的
 * `advanceableKind` 恒为 null,永远不会再集成它;兄弟跑完之后 root 照样 ACCEPTED,
 * run 报 completed,`--resume` 的 `validateLoadedNodes` 一句话都不说。
 */
export function scopeDiff(before: AddTaskScope, after: AddTaskScope): string | undefined {
  if (before.anchor.id !== after.anchor.id) {
    return `新任务的挂载点从「${before.anchor.title}」变成了「${after.anchor.title}」`
  }
  if (before.anchorSeat !== after.anchorSeat) {
    return `「${after.anchor.title}」的状态在你确认之前变了(${before.anchorWas?.status ?? before.anchor.status} → ${after.anchorWas?.status ?? after.anchor.status})`
  }
  const ids = (s: AddTaskScope): string => s.reopen.map(r => r.id).join(',')
  if (ids(before) !== ids(after)) return '要重新打开的上级任务清单和你看到的那一份已经不一样'
  if (before.chain.join(',') !== after.chain.join(',')) return '这个任务到根任务之间的那条链变了'
  return undefined
}

/** 关口/接线共用:这次操作会碰到的节点(`taskAdded` 的 `affected`)。 */
export function affectedByAddTask(scope: AddTaskScope, newId: string): string[] {
  return [newId, ...scope.chain]
}
