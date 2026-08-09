// src/tools/efftask/depsRecalcRun.ts
//
// 依赖重算的**不纯那一半**:发那一次主模型调用、解析、(必要时)重拟一次,以及把结果落到
// 盘上和内存里。判据全在 `depsRecalc.ts`(纯函数,可测);这里只负责顺序和失败的说法。
import { ANSWER_TAGS, answerTag, parseDepsRecalc } from './parseOutput.js'
import {
  buildRecalcListing, normalizeRecalc, recalcPrompt, revalidateRecalc,
  type RecalcPlan, type RecalcScope,
} from './depsRecalc.js'
import type { StreamHandle } from './agentStream.js'
import type { DepsRecalcRecord, TaskNode } from './types.js'

/**
 * 围栏中和 —— 和 `pipeline.ts` 的 `quote()` 同因。
 *
 * 回灌给模型的那些 id 是**模型自己写的文本**,而重拟提示词会把它们原样铺进去。一个
 * 三反引号能当场把我们自己的代码块劈开(这个仓库为逐字相同的事故烧穿过一整棵树的迭代预算)。
 */
function neutralize(s: string): string {
  return s.replace(/`/g, "'")
}

export interface RecalcAskDeps {
  /** 主模型、零工具那条缝。`node` 传**真节点**(用量要记在它身上)。 */
  runAgent: (args: { node: TaskNode; prompt: string; signal: AbortSignal; stream?: StreamHandle }) => Promise<string>
  byId: () => Map<string, TaskNode>
  /** 一次调用一个窗口句柄(工厂:重拟那次要另开一个)。 */
  openStream?: () => StreamHandle
}

export type RecalcAsk =
  | { ok: true; plan: RecalcPlan }
  | { ok: false; kind: 'aborted' | 'too-big' | 'call-failed'; reason: string; tooBig?: string[] }

/**
 * 问一次主模型,把回答归一化成一份计划。
 *
 * ## 三件必须按这个顺序做的事
 *
 * 1. **清单先夹再发**:连身份行都装不下的依赖当场拒绝,而不是发一次注定被
 *    `shrinkPrompt` 掐掉中段的调用 —— 它掐的正好是这次调用唯一的信息,而它塞进去的
 *    那句「省掉的部分你自己去读文件」在零工具的缝上物理不可能。
 * 2. **调用回来先判 `signal.aborted` 再解析**:适配层在已 abort 时**返回空串、不抛**,
 *    而空串解析出来和「模型没答」逐字相同 —— 会把一次用户取消报成「所有依赖保持原样」。
 * 3. **重拟换新 tag**:重拟提示词要把上一轮被丢掉的 id 逐条回给模型,那等于把上一轮的
 *    回答引进新提示词,模型很可能照抄;tag 不变的话那个被引用的旧块就是本轮的 tagged 块,
 *    而 `requireTag` 会把它选成答案。
 */
export async function askRecalc(
  node: TaskNode, scope: RecalcScope, deps: RecalcAskDeps, signal: AbortSignal,
): Promise<RecalcAsk> {
  const byId = deps.byId()
  const listing = buildRecalcListing(scope.groups, byId)
  if (listing.tooBig.length > 0 && listing.tooBig.length === scope.groups.length) {
    return {
      ok: false, kind: 'too-big', tooBig: listing.tooBig,
      reason: '这些依赖的子树太大,连一份节点清单都放不进一次调用 —— 没有发起这次调用。',
    }
  }
  const parent = node.parentId ? byId.get(node.parentId) : undefined
  const parentPlan = parent ? (parent.plan.keyPoints || parent.plan.solution) : undefined

  const once = async (feedback?: string): Promise<{
    plan?: RecalcPlan; retry?: string; aborted?: boolean; failed?: string
  }> => {
    // 一次调用一个 tag。重拟必须换 —— 见函数头第 3 条。
    const tag = answerTag(ANSWER_TAGS.deps)
    let text: string
    try {
      text = await deps.runAgent({
        node,
        prompt: recalcPrompt({ node, byId, listing: listing.text, tag, parentPlan, feedback }),
        signal,
        stream: deps.openStream?.(),
      })
    } catch (e) {
      return { failed: e instanceof Error ? e.message : String(e) }
    }
    if (signal.aborted) return { aborted: true }
    const parsed = parseDepsRecalc(text, tag)
    // 部分依赖装不下时**照样发这次调用**(其余的仍然值得细化),但要把「没问过」这件事
    // 带进计划里 —— 不带的话它们会被报成「模型没有给出这一条依赖」,一句假话。
    const plan = normalizeRecalc(node, deps.byId(), scope, parsed.answer, { notAsked: listing.tooBig })
    if (parsed.truncated > 0) {
      plan.warnings.push(`⚠ 模型给的项超过解析上限,有 ${parsed.truncated} 项没被读进来。`)
    }
    /**
     * 重拟的三个触发条件。**只重拟一次**(照根方案关口那条先例:再空就如实端出去,
     * 免得无限重试烧钱),而且「模型明确说保持原样」**不重拟** —— 那是一个结论,不是失败。
     */
    if (parsed.ambiguous) return { plan, retry: '你上一轮输出了不止一个带标记的代码块,我无法判断哪个是答案。这一次只输出一个。' }
    if (parsed.broken) return { plan, retry: '你上一轮那个代码块里的 JSON 没能解析成功。这一次请输出合法 JSON。' }
    if (parsed.answer !== null && plan.outcome === 'all-dropped') {
      const bad = plan.perDep.flatMap(p => p.dropped).slice(0, 10).map(neutralize)
      return { plan, retry: `你上一轮给的这些节点我一个都没对上:\n${bad.join('\n')}\n请从清单里**逐字复制** id。` }
    }
    return { plan }
  }

  const first = await once()
  if (first.aborted) return { ok: false, kind: 'aborted', reason: '已取消' }
  if (first.failed !== undefined) return { ok: false, kind: 'call-failed', reason: first.failed }
  if (first.retry === undefined) return { ok: true, plan: first.plan! }

  const again = await once(first.retry)
  if (again.aborted) return { ok: false, kind: 'aborted', reason: '已取消' }
  // 重拟失败/更差就用第一版 —— 关口会如实印出它的 outcome 和被丢掉的那些 id。
  if (again.failed !== undefined || !again.plan) return { ok: true, plan: first.plan! }
  const better = again.plan.outcome === 'refined' || first.plan!.outcome === 'unparsed'
  return { ok: true, plan: better ? again.plan : first.plan! }
}

export interface RecalcApplyDeps {
  byId: () => Map<string, TaskNode>
  now: () => string
  /** `writeNode(fs, runDir, n)`。 */
  persist: (n: TaskNode) => Promise<void>
  hold: (ids: readonly string[]) => { ok: true; release: () => void } | { ok: false; reason: string }
  depsChanged: (id: string) => { ok: true } | { ok: false; reason: string }
  scopeOpts?: () => Parameters<typeof revalidateRecalc>[3]
}

export type RecalcApply =
  | { ok: true }
  /** `diskChanged` 决定关口上该说「盘上没动」还是「已经改了、只是没叫醒调度」。 */
  | { ok: false; reason: string; diskChanged: boolean }

/**
 * 把一份计划落下去。
 *
 * ## 顺序为什么和重做**不一样**
 *
 * 重做手上是 `structuredClone` 出来的**另一棵树**,`applyLive` 之前活树一个字节都没变。
 * 本功能是**就地改共享对象**(界面和编排器持有同一批节点对象),`node.deps = after` 执行完
 * 的那一瞬间编排器已经在按新依赖调度了,而 `hold.release()` 自带 `nudge()`。所以落盘失败
 * 会造成**内存新、盘上旧,而节点已经按盘上没有的依赖起跑** —— 崩一次之后 `--resume` 读回
 * 粗依赖,却读到一个带着执行痕迹的节点,而 node.md 上没有任何一处说得出为什么。
 *
 * 所以:**先在一份浅拷贝上写、落盘成功之后才把字段就地写回活对象**。浅拷贝不破坏「共享
 * 对象」那条规矩 —— 写回去的是字段,不是新对象。
 *
 * ## `writeNode` 内部那次 await 的安全性来自 `held`,不来自浅拷贝
 *
 * 落盘期间若有人改了活对象的 `status`,盘上会落一份旧状态。走不到:`propagateBlocked(false)`
 * 在有 held 节点时不判「走不动」;`propagateBlocked(true)` 只在中止路径,而那时落一个
 * `CREATED` 恰恰是 reseat 想要的静息态。**这段话必须留着** —— 少了它,下一个人会「顺手」
 * 把浅拷贝改回直接写活对象。
 *
 * ## 不写 run.md
 *
 * `depsChanged` 的 `safeUpdate()` 会走 `onUpdate` → `queueManifest`,而那是 run.md 的
 * **唯一写入点**(一条串行 + 合并的队列)。从按键这一侧直调 `writeRunManifest` 会和它并发写
 * 同一个文件,还会绕过运行中调过的并发度/严格度同步。
 */
export async function applyRecalc(
  node: TaskNode, plan: RecalcPlan, deps: RecalcApplyDeps,
): Promise<RecalcApply> {
  const held = deps.hold([node.id])
  if (held.ok !== true) return { ok: false, reason: held.reason, diskChanged: false }
  try {
    const stale = revalidateRecalc(node, deps.byId(), plan, deps.scopeOpts?.() ?? {})
    if (stale !== undefined) return { ok: false, reason: stale, diskChanged: false }

    const now = deps.now()
    const rec: DepsRecalcRecord = { at: now, from: [...plan.before], to: [...plan.after] }
    // `depsRecalc` 是可选字段,`createNode` 不初始化它 —— 裸 `.push` 在**第一次**重算时
    // 必抛 TypeError,而那一刻 hold 已经拿到、用户已经点过确认。
    const nextRecords = [...(node.depsRecalc ?? []), rec]
    const draft: TaskNode = { ...node, deps: [...plan.after], depsRecalc: nextRecords, updatedAt: now }
    try {
      await deps.persist(draft)
    } catch (e) {
      return { ok: false, reason: `落盘失败,这次重算没有发生: ${e instanceof Error ? e.message : String(e)}`, diskChanged: false }
    }
    // 落盘成功之后才动活对象,而且只写**字段**。
    node.deps = [...plan.after]
    node.depsRecalc = nextRecords
    node.updatedAt = now

    const woke = deps.depsChanged(node.id)
    if (woke.ok !== true) {
      return {
        ok: false, diskChanged: true,
        reason: woke.reason === 'aborted'
          ? '依赖已经改好并落盘,但整个运行已被中止 —— /et --resume 继续之后它就生效了。'
          : woke.reason === 'finished'
            ? '依赖已经改好并落盘,但本次编排刚刚结束 —— /et --resume 继续之后它就生效了。'
            : '依赖已经改好并落盘,但这个任务此刻正在运行,没能叫醒调度。',
      }
    }
    return { ok: true }
  } finally {
    // 无条件。扣住不放的话这个节点再也不会被调度,而屏幕上什么都不会说。
    held.release()
  }
}
