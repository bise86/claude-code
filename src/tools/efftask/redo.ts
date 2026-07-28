import type { NodeStatus, TaskNode } from './types.js'

/**
 * 重做 —— 把某个节点退回到某个环节重新跑一遍。
 *
 * 在这之前,恢复面只有一条:`/et --resume <id> --retry-blocked`。它的粒度是**整个运行**
 * (所有被安全阀挡住的节点一起重开),而且只对「被阀门挡住」的节点有效 —— 一个已经
 * ACCEPTED 但结果不对的节点、一个方案就跑偏了的父任务,都没有任何入口。用户的原话是
 * 「降低恢复成本」:出了问题不该只能整轮重来。
 *
 * ## 为什么只有三个入口,而环节有七个
 *
 * 七个环节里能**单独重入**的只有三处,这是状态机的形状决定的,不是偷懒:
 *
 *  - `stepStart` 跑 plan → review,是一个整体;
 *  - `stepExecute` 跑 execute → verify → accept → observer → merge,**也是一个整体** ——
 *    它只有一个入口(READY),中途没有第二个可进入的点(唯一的例外是人工解决冲突后从
 *    ACCEPTANCE 续跑,而那条路要求 mergeConflict 为真,是给冲突用的,不是给重做用的);
 *  - `stepIntegrate` 跑 integrate → observer,是拆分任务在子任务全绿后的那一场裁决。
 *
 * 所以菜单里给「验收重做」这样一个条目会是**假的**:它做不到只重跑验收,实际会连执行
 * 一起重跑,而用户是按字面意思选的。宁可给三个真的,并在每条上写清连带跑什么。
 *
 * ## 父任务重做为什么必须先删子树
 *
 * 用户明确要求「如果父任务重做,就先将下面子任务全部删除掉,重做完再加新的子任务,
 * 包括依赖关系也要重新修订」。这条要求和 reseat 里那条规则 1 是同一件事的两面:
 * `createChildren` 的子 id 由「父 id + 序号 + 标题」推导,所以留着旧子树重新拆分时,
 * 标题相同的会**覆盖**旧节点(可能覆盖掉已经 ACCEPTED 的),标题不同的会留下一批
 * 永远等不到的幽灵兄弟,`childrenAllAccepted` 于是永久卡住。删干净是唯一自洽的做法。
 */
export type RedoEntry = 'plan' | 'execute' | 'integrate'

export interface RedoOption {
  entry: RedoEntry
  /** 菜单里那一行。 */
  label: string
  /** 这一条**连带**会跑什么、会毁掉什么 —— 用户按下去之前就该看见。 */
  detail: string
  /** 不为空表示这一条在当前节点上不可用,内容就是原因。 */
  disabled?: string
}

export interface RedoPlan {
  nodes: TaskNode[]
  /** 被删掉的后代 id(仅 entry === 'plan' 且原来有子任务时非空)。 */
  deleted: string[]
  /** 被改写的依赖:某个**子树外**的节点原本依赖一个将被删除的节点。 */
  dependencyRewrites: { nodeId: string; from: string; to: string }[]
  /** 需要调用方去释放的隔离工作区(纯函数碰不了 git)。 */
  worktreesToRelease: { nodeId: string; branch: string; path: string }[]
  /** 目标节点被重置成了什么状态。 */
  seatedAt: NodeStatus
  /** 必须说给用户听的话 —— 每一条都是这次重做**做不到**的事。 */
  warnings: string[]
}

const REDO_NOTE = '(注:本节点被手工重做,隔离工作区已重置为集成分支最新状态;上面描述的产出在当前工作区里不存在)'

/**
 * 「这个节点是拆分型的吗」。
 *
 * 有子任务就是 —— 这条比 `kind` 可靠:`stepStart` 在评审之前就把 kind 写进节点,
 * 一个自称 executable 却被评审打回的节点,盘上留着的 kind 是 executable。
 */
function isDecomposed(n: TaskNode): boolean {
  return n.childIds.length > 0 || n.kind === 'decompose'
}

/** 给一个节点,列出它能从哪些环节重做。**永远返回全部三条**,不可用的带原因。 */
export function redoOptions(node: TaskNode, byId: ReadonlyMap<string, TaskNode>): RedoOption[] {
  const kids = descendantsOf(node, byId)
  const acceptedKids = kids.filter(id => byId.get(id)?.status === 'ACCEPTED').length
  return [
    {
      entry: 'plan',
      label: '从「方案」重做',
      detail: node.childIds.length > 0
        // 数量必须写出来。这是整个功能里唯一一个不可逆的动作,而「重做」两个字听起来像
        // 是可逆的。
        ? `重新分析并拆分;先删除 ${kids.length} 个子任务(其中 ${acceptedKids} 个已验收)`
        : '重新分析,重新走一遍质疑讨论',
    },
    {
      entry: 'execute',
      label: '从「执行」重做',
      detail: '方案保留;重跑 执行 → 测试验证 → 验收(这三步是一个整体,分不开)',
      disabled: isDecomposed(node)
        ? '这是拆分任务,它自己没有执行环节 —— 真正干活的是它的子任务'
        : undefined,
    },
    {
      entry: 'integrate',
      label: '从「集成验收」重做',
      detail: '子任务全部保留,只重新裁决一次「合起来达没达成父目标」',
      disabled: node.childIds.length === 0
        ? '没有子任务,不存在集成验收'
        : undefined,
    },
  ]
}

/** 目标节点的全部后代,深度优先。 */
export function descendantsOf(node: TaskNode, byId: ReadonlyMap<string, TaskNode>): string[] {
  const out: string[] = []
  const stack = [...node.childIds]
  // 环保护:盘上的 childIds 是可手工编辑的,一个自指的 childIds 会让这里死循环 ——
  // 而这个函数跑在按键处理里,死循环 = 终端整个卡死。
  const seen = new Set<string>([node.id])
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    const child = byId.get(id)
    if (child) stack.push(...child.childIds)
  }
  return out
}

/**
 * propagateBlocked 写在**别人**身上的三种阻断理由。
 *
 * 和 reseat 里那份是同一份,原因也一样:它们都不是对该节点自身的判决,而是「你上面/
 * 下面/依赖的东西挂了」。不清掉的话,被重做的节点上面那条链仍然是 BLOCKED,而调度器
 * 拒绝挑选任何祖先被阻断的节点 —— 重做完全无效,一次模型调用都不会发生。
 * 这在 reseat 里是实测过的失败,不是推理。
 */
const PROPAGATED: ReadonlySet<string> = new Set(['子节点阻断', '上级任务阻断', '依赖阻断'])

function reopenIfPropagated(n: TaskNode, now: string): void {
  if (n.status !== 'BLOCKED' || !PROPAGATED.has(n.blockedReason)) return
  n.status = n.childIds.length > 0 ? 'WAITING_CHILDREN' : n.kind === 'executable' ? 'READY' : 'CREATED'
  n.blockedReason = ''
  n.updatedAt = now
}

/**
 * 计算一次重做。**纯函数**:不碰盘、不碰 git、不改传进来的数组。
 *
 * 返回的 `nodes` 是一份新数组,里面的节点对象也是新的 —— 调用方拿到的是「重做之后的树
 * 应该长什么样」,由它决定落盘、删文件、放工作区。这样做的直接好处是关口可以先把
 * `deleted` / `dependencyRewrites` / `warnings` 渲染给用户看,再决定要不要真的执行。
 */
export function planRedo(
  input: readonly TaskNode[],
  targetId: string,
  entry: RedoEntry,
  now: string,
): RedoPlan | { error: string } {
  const nodes = input.map(n => structuredClone(n) as TaskNode)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { error: `节点不存在: ${targetId}` }

  const opt = redoOptions(target, byId).find(o => o.entry === entry)
  if (!opt) return { error: `未知的重做入口: ${entry}` }
  if (opt.disabled) return { error: opt.disabled }

  const warnings: string[] = []
  const worktreesToRelease: { nodeId: string; branch: string; path: string }[] = []
  const dependencyRewrites: { nodeId: string; from: string; to: string }[] = []
  let deleted: string[] = []

  // ---- 三个入口各自的重置 ----
  let seatedAt: NodeStatus
  if (entry === 'plan') {
    deleted = descendantsOf(target, byId)
    const deletedSet = new Set(deleted)
    const mergedAway = deleted.filter(id => {
      const d = byId.get(id)
      return d?.status === 'ACCEPTED' && d.worktree !== undefined
    })
    for (const id of deleted) {
      const d = byId.get(id)
      if (d?.worktree) worktreesToRelease.push({ nodeId: id, branch: d.worktree.branch, path: d.worktree.path })
      byId.delete(id)
    }
    if (mergedAway.length > 0) {
      // 说清楚,因为它听起来应该被撤销而实际不会:每个执行型子节点是在**自己通过验收时**
      // 就合进集成分支的(stepExecute 里的 mergeAndRelease),删节点删的是任务记录,
      // 不是已经落进 git 的提交。
      warnings.push(
        `${mergedAway.length} 个已验收子任务的代码**已经合进集成分支**,删除任务不会回滚这些提交;` +
        `新方案要么在它们之上继续,要么你先自己 revert`,
      )
    }
    // 依赖修订。子树外面还指着被删节点的,改指到目标节点本身 —— 那才是接下来会产出
    // 等价成果的东西。直接删掉依赖会让下游提前起跑,拿到一棵还没建起来的子树。
    for (const n of byId.values()) {
      if (n.deps.length === 0) continue
      const next: string[] = []
      for (const d of n.deps) {
        if (!deletedSet.has(d)) { if (!next.includes(d)) next.push(d); continue }
        // 自依赖是死锁,不是依赖 —— 目标节点自己曾经依赖过某个后代时会撞上。
        if (n.id === targetId) { dependencyRewrites.push({ nodeId: n.id, from: d, to: '(已移除)' }); continue }
        dependencyRewrites.push({ nodeId: n.id, from: d, to: targetId })
        if (!next.includes(targetId)) next.push(targetId)
      }
      if (next.length !== n.deps.length || next.some((d, i) => d !== n.deps[i])) {
        n.deps = next
        n.updatedAt = now
      }
    }

    target.childIds = []
    // 回到 unknown,让 stepStart 重新判定拆分还是执行 —— 保留旧 kind 的话,一个原本
    // 拆分型的节点会被 advanceableKind 当成执行型直接交给带写工具的执行者。
    target.kind = 'unknown'
    // 上一轮**确认过的**子任务清单。不清的话重新拆分会照抄它,重做就成了空转。
    target.confirmedDraft = undefined
    // 补救拆分的一次性额度,重做后应该重新给。
    target.revised = undefined
    target.iteration = { planReview: 0, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 }
    if (target.worktree) {
      worktreesToRelease.push({ nodeId: target.id, branch: target.worktree.branch, path: target.worktree.path })
      target.worktree = undefined
    }
    seatedAt = 'CREATED'
  } else if (entry === 'execute') {
    // acceptLog **保留**。它是上一轮验收说了什么的唯一记录,而返工提示词正是拿它当
    // 反馈的 —— 清掉等于让执行者从零开始猜,那是提高恢复成本,不是降低。
    target.iteration = { ...target.iteration, acceptance: 0, scoring: 0, mergeResolve: 0 }
    if (target.execStatus.length > 0 && !target.execStatus.includes(REDO_NOTE)) {
      // 和 reseat 的 RETRY_NOTE 同因:工作区会被重置回集成分支基线,而 execStatus 里
      // 写着「我实现了 feature.ts」。不加这句,执行者会去找一个已经不在那儿的文件。
      target.execStatus = `${target.execStatus}\n${REDO_NOTE}`
    }
    if (target.worktree) {
      worktreesToRelease.push({ nodeId: target.id, branch: target.worktree.branch, path: target.worktree.path })
      target.worktree = undefined
    }
    seatedAt = 'READY'
  } else {
    // integrate:子任务一个不动,只把父节点退回等子任务的位置重新裁决。
    target.iteration = { ...target.iteration, integration: 0, scoring: 0 }
    const unfinished = target.childIds.filter(id => byId.get(id)?.status !== 'ACCEPTED')
    if (unfinished.length > 0) {
      // 不是错误:退回 WAITING_CHILDREN 之后调度器会先把这些子任务推完,再做集成验收。
      // 但用户按的是「重新裁决一次」,得知道它不会立刻发生。
      warnings.push(`还有 ${unfinished.length} 个子任务没有验收通过,集成验收会等它们完成后才发生`)
    }
    seatedAt = 'WAITING_CHILDREN'
  }

  // ---- 三条入口共通的清理 ----
  target.status = seatedAt
  target.blockedReason = ''
  target.interrupted = false
  target.capBlocked = false
  target.capCategory = undefined
  target.mergeConflict = false
  // 和 reseat 同因:startedAt 会跨越终端关闭的整段时间,面板照着它算出「172800 秒」。
  // 重做就是重新开始,下一个活动阶段由 commit() 重新盖章。
  target.startedAt = undefined
  target.updatedAt = now

  // 上面那条链,和任何在等它的兄弟。不做这一步,重做出来的座位是**够不到**的。
  let p = target.parentId === null ? undefined : byId.get(target.parentId)
  const guard = new Set<string>([target.id])
  while (p && !guard.has(p.id)) {
    guard.add(p.id)
    reopenIfPropagated(p, now)
    p = p.parentId === null ? undefined : byId.get(p.parentId)
  }
  for (const n of byId.values()) {
    if (n.id !== target.id && n.deps.includes(target.id)) reopenIfPropagated(n, now)
  }

  return {
    nodes: [...byId.values()],
    deleted,
    dependencyRewrites,
    worktreesToRelease,
    seatedAt,
    warnings,
  }
}

/** 关口上那段摘要 —— 按下确认之前,把这次重做**做了什么、做不到什么**摊开。 */
export function redoSummary(plan: RedoPlan, target: TaskNode, entry: RedoEntry): string[] {
  const lines: string[] = []
  const what: Record<RedoEntry, string> = {
    plan: '重新分析 → 质疑讨论',
    execute: '重新执行 → 测试验证 → 验收',
    integrate: '重新集成验收',
  }
  lines.push(`「${target.title}」将 ${what[entry]}`)
  if (plan.deleted.length > 0) lines.push(`删除 ${plan.deleted.length} 个子任务,重做后按新方案重建`)
  if (plan.dependencyRewrites.length > 0) {
    lines.push(`${plan.dependencyRewrites.length} 条依赖被改写为指向本节点`)
  }
  if (plan.worktreesToRelease.length > 0) lines.push(`释放 ${plan.worktreesToRelease.length} 个隔离工作区`)
  for (const w of plan.warnings) lines.push(`⚠ ${w}`)
  return lines
}
