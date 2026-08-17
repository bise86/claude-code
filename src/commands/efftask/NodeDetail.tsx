import * as React from 'react'
import { Box, Text, useInput, useTheme } from '../../ink.js'
import { PHASE_LABEL, PHASE_NAMES, type TaskNode } from '../../tools/efftask/types.js'
import { isTerminal, uiStatus } from '../../tools/efftask/stateMachine.js'
import type { StreamState } from '../../tools/efftask/agentStream.js'
import { AgentLogPane } from './AgentLogPane.js'
import { ScrollPane } from './ScrollPane.js'
import {
  alignSectionCursor,
  anchoredFrom,
  clipToWidth,
  foldedStreams,
  initialSelectedStream,
  logPaneMode,
  scrollWindow,
  sectionLines,
  sectionPaneAction,
  sectionPaneMode,
  detailLayout,
  collapsedLinesFor,
  MIN_DETAIL_WIDTH,
  sectionCursor,
  tabFocused,
  mouseHint,
  paginateHints,
  type LogPaneMode,
  type SectionSpec,
} from './logView.js'
import { formatTokens, isEmptyUsage, subtreeUsage, totalTokens, type UsageTotals } from '../../tools/efftask/usage.js'
import { reworkReason } from '../../tools/efftask/reworkReason.js'
// node.md 那侧同名的函数用的就是它 —— 两处必须是同一份实现,否则「同一份数据两种处理」
// 会以另一种形式回来(见 responsesBody 的注释)。
import { stripControl } from '../../tools/efftask/persistence.js'
import { currentMouseAvailability } from './mouseEnv.js'
import { useLiveState } from './useLiveState.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js'

const COLOR = { done: 'success', running: 'warning', queued: 'inactive', failed: 'error' } as const

/**
 * 两个页卡。
 *
 * **是数据,不是两段写死的 JSX。** 这个文件已经为同一条论证改过一次(段落列表),
 * 原话是:「哪一段被选中、哪一段展开着」需要按下标寻址。页卡一模一样 —— 页签条要枚举它们、
 * 点击要知道自己是第几个、页脚要按当前页卡换文案。加第三个页卡的成本是这个数组里加一行。
 */
export const DETAIL_TABS = [
  { id: 'task', title: '任务' },
  { id: 'log', title: '子 agent 输出' },
] as const
export type DetailTabId = (typeof DETAIL_TABS)[number]['id']

/** 焦点在页签条上,还是在内容区里。 */
export type DetailZone = 'tabs' | 'content'

/**
 * 观察评分, with the reasons — spec §10.2 lists 评分 among the detail view's contents.
 *
 * It was computed, persisted to node.md's frontmatter and then shown NOWHERE: the tree row
 * omitted it and this view omitted it, so a user who configured an observer got a number
 * that only existed on disk.
 */
function scoreBody(n: TaskNode): string {
  const line = (label: string, s?: { score: number; rationale: string }): string =>
    s ? `${label}: ${s.score}${s.rationale ? ' — ' + s.rationale : ''}` : ''
  return [line('方案质量', n.score.plan), line('执行质量', n.score.exec)].filter(Boolean).join('\n')
}

/** 迭代次数 (spec §10.2). Only the counters that have actually been spent. */
function iterationBody(n: TaskNode): string {
  const it = n.iteration
  return [
    it.planReview > 0 ? `方案返工 ${it.planReview}` : '',
    it.acceptance > 0 ? `验收返工 ${it.acceptance}` : '',
    it.integration > 0 ? `集成验收返工 ${it.integration}` : '',
    it.scoring > 0 ? `评分触发返工 ${it.scoring}` : '',
    it.mergeResolve > 0 ? `自动解决合并冲突 ${it.mergeResolve}` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * 一个时刻 → 屏幕上那个短串。
 *
 * **今天的只给 `时:分:秒`,跨天的带上日期。** 一个 `/et` 通常在同一天里跑完,给每一行
 * 都戴上 `07-31` 是纯噪音;而一个跑了一整夜、或者昨天 `--resume` 回来的 run,不带日期的
 * `03:14:07` 会让人把两天前的事读成刚刚发生。判据是「和现在是不是同一天」,不是时长 ——
 * 凌晨 0:05 看一条 23:50 的记录,时长只差 15 分钟,但那是「昨天」。
 *
 * 解析不了就原样吐回去:node.md 可以手工编辑,而一个渲染函数不该因为一个坏字符串而
 * 让整屏消失。
 */
export function timePoint(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const d = new Date(ms)
  const p2 = (v: number): string => String(v).padStart(2, '0')
  const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  const now = new Date(nowMs)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hms : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}`
}

/** 毫秒 → 人读的时长。分钟以上给 `12m30s`,秒级给 `45s`,不足 1 秒给 `<1s`(不是 `0s`)。 */
export function durText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/**
 * 这个节点的**时间线** —— 创建、开始、结束、总跨度。
 *
 * 用户原话:「任务运行和阶段运行,都要有具体的运行时间点,现在只有一个运行了多长时间。」
 * 树上那个 `749s` 回答不了他真正在问的:**那是什么时候的事**。一个 12 分钟的执行是刚刚
 * 还在跑,还是两小时前就跑完了、之后一直卡在等验收 —— 两者在树上一模一样。
 *
 * 「结束」缺席时明说**进行中**,并按 `now` 算已经跑了多久;不拿 `now` 去冒充结束时刻。
 * 一个被杀在半路的节点也走这一支,而它显示的是「(进行中)」加上一个不再增长的开始时刻 ——
 * 那正是它的真实状态,而不是「刚刚还在跑」。
 */
export function timelineBody(n: TaskNode, nowMs = Date.now()): string {
  /**
   * **没跑过就整段不画。**
   *
   * 一个还在排队的节点只有「创建于」可说,而这一段的标题是「时间」—— 它承诺回答的是
   * 「这个任务什么时候跑的」。给一个从没跑过的节点画一段只写着创建时刻、后面跟着
   * 「开始 —」的框,是拿一段版面去说「无可奉告」。树上那一行的「排队中」已经把这件事
   * 说清楚了。
   */
  if (!n.startedAt && !n.finishedAt) return ''
  const rows: string[] = []
  if (n.createdAt) rows.push(`创建 ${timePoint(n.createdAt, nowMs)}`)
  if (n.startedAt) rows.push(`开始 ${timePoint(n.startedAt, nowMs)}`)
  // 措辞对两种情况都得成立:一种是真的没跑过,另一种是跑过但归位时把开始时刻清掉了
  // (reseat 的预算耗尽分支 —— 留着它会让耗时跨过整个关机时间)。「没有记录」两种都不撒谎。
  else rows.push('开始 —(没有记录)')
  const started = n.startedAt ? Date.parse(n.startedAt) : NaN
  const span = (end: number): string =>
    Number.isFinite(started) && Number.isFinite(end) && end >= started ? ` · 历时 ${durText(end - started)}` : ''
  /**
   * **「结束了没有」看状态,不看 `finishedAt` 在不在。**
   *
   * 评审实测出来的 P1:`finishedAt` 只有 `commit()` 一个写点,而节点进入终态的写点有
   * 六个 —— `propagateBlocked` 的两条(被牵连阻断、中止扫描)直接写 `status`,
   * `reseat` 的预算耗尽分支、`resumeCore` 的结构性阻断也是。于是一个两天前被牵连阻断的
   * 节点在这一段上写着「结束 —(进行中,至今 47h43m)」,而且**每秒往上跳**。
   *
   * 这是 `startedAt` 那条注释里记着的同一个缺陷第三次复发(「172800s 并每秒往上跳」),
   * 而它每次都是从「渲染层拿一个字段的缺席当状态」进来的。所以这次把判据换成状态本身:
   * 终态就一定要给一个结束的说法,拿不到精确时刻就退回 `updatedAt` 并**说明它是近似的**
   * —— 那个字段每一次落盘都会被重写,它至少不会比真结束时刻早。
   */
  const ended = isTerminal(n.status)
  if (n.finishedAt) {
    rows.push(`结束 ${timePoint(n.finishedAt, nowMs)}${span(Date.parse(n.finishedAt))}`)
  } else if (ended && n.updatedAt) {
    rows.push(`结束 ${timePoint(n.updatedAt, nowMs)}(近似:取最后一次落盘时刻)${span(Date.parse(n.updatedAt))}`)
  } else if (ended) {
    rows.push('结束 —(已终止,但盘上没有留下结束时刻)')
  } else if (Number.isFinite(started)) {
    // 「至今」而不是「历时」:它还没结束,这个数还在涨。
    rows.push(`结束 —(进行中,至今 ${durText(nowMs - started)})`)
  }
  return rows.join('\n')
}

/**
 * 各阶段耗时**与时间点** (spec §10.2)。
 *
 * 详情页原本只有一个总耗时,而它回答不了打开这个面板的人真正的问题:一个跑了 20 分钟
 * 是因为执行器慢,另一个跑了 20 分钟是因为被评审打回了四次 —— 两者长得一模一样。
 * 而只有时长仍然答不了第二个问题:**那是什么时候的事**(见 timelineBody)。
 */
export function phaseTimeBody(n: TaskNode, nowMs = Date.now()): string {
  const LABEL: Partial<Record<string, string>> = {
    PLANNING: '分析', PLAN_REVIEW: '质疑修复', EXECUTING: '执行',
    VERIFYING: '测试修复', ACCEPTANCE: '验收',
    // NOT 「返工」. The REWORK window holds exactly one thing — `refreshFromIntegration`,
    // pulling sibling merges into this node's worktree — and then commits EXECUTING; the
    // actual rework effort is charged to that next EXECUTING round. A row reading 返工 45s
    // directly beneath 迭代次数 · 验收返工 2 reads as "reworking took 45 seconds", and the
    // two mislead each other.
    REWORK: '返工前同步集成分支', INTEGRATION_ACCEPT: '集成验收', SCORING: '观察', MERGE: '合并',
  }
  /**
   * 一行一个阶段,**按发生顺序**排,每行带上它的时间窗口。
   *
   * 改了两件事,各有各的理由:
   *  - 原来按耗时倒序、挤在一行(`执行 749s · 验收 12s`)。加上时间点之后一行装不下,
   *    而一旦分行,**时间顺序**就是唯一读得懂的顺序 —— 那是一条时间线,不是排行榜。
   *    「时间花在哪」并没有丢:每行都带着时长,而且都对齐在同一列。
   *  - 一秒以内的阶段:**有时间点的留,没有的照旧丢掉**。判据是「这一行还有没有信息」——
   *    带时间点时,一个 0.2 秒的 MERGE 恰恰说明合并是干净的、而且说得出是什么时候;
   *    而一条光秃秃的 `方案评审 0s` 只会让人以为那里出了问题(这是原来那条过滤存在的
   *    全部理由,它对老数据仍然成立)。
   *
   * 没有时间点的老 node.md 退回原来的样子(只有时长),而不是印一行空白的箭头。
   */
  const entries = Object.entries(n.phaseMs ?? {})
    .filter(([status, ms]) =>
      Number.isFinite(ms) && ms >= 0 &&
      (ms >= 1000 || n.phaseAt?.[status as keyof typeof n.phaseAt] !== undefined))
  const at = (status: string): { first: string; last?: string } | undefined => n.phaseAt?.[status as keyof typeof n.phaseAt]
  // 进过但一毫秒都没记上的阶段(正在跑、或者进程被杀在这一步)也要出现 —— 那种时候
  // 「它是什么时候开始的」恰恰是唯一有用的信息。
  for (const status of Object.keys(n.phaseAt ?? {})) {
    if (!entries.some(([k]) => k === status)) entries.push([status, 0])
  }
  const orderOf = (status: string): number => {
    const t = at(status)?.first
    const ms = t ? Date.parse(t) : NaN
    // 没有时间点的排在最后,彼此之间保持耗时倒序 —— 老数据不至于被打散成随机顺序。
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER
  }
  return entries
    .sort((a, b) => (orderOf(a[0]) - orderOf(b[0])) || (b[1] - a[1]))
    .map(([status, ms]) => {
      const t = at(status)
      const label = LABEL[status] ?? status
      const dur = ms > 0 ? durText(ms) : '<1s'
      if (!t) return `${label} ${dur}`
      /**
       * `last` 缺席 = 进了还没出来。照实说,不拿 now 去填 —— 那会让一个被杀在半路的
       * 节点显示成「刚刚还在跑」。
       *
       * **但节点已经终态时不能写「进行中」**:那一档的真实情况是「这个阶段的离开时刻
       * 没被记下来」(崩溃在这一步、或者恢复之后再没回到过它),而屏幕上写「进行中」
       * 会让一个已验收的节点看起来还有活的阶段。评审实测过这条:一个崩在 EXECUTING、
       * 恢复后改走拆分路线的节点,详情页永远挂着「执行 18:08:20 → 进行中」。
       */
      const end = t.last ? timePoint(t.last, nowMs) : (isTerminal(n.status) ? '(未记录)' : '进行中')
      /**
       * 箭头两端是**窗口**(第一次进入 → 最后一次离开),后面那个数是**累计**停留时长。
       * 返工多轮时两者对不上(窗口 6m31s 而累计 12s),而屏幕上一个字都没解释 ——
       * 验收点名的就是这个。一个「累计」把两个数各自说清楚。
       */
      return `${label} ${timePoint(t.first, nowMs)} → ${end} · 累计 ${dur}`
    })
    .join('\n')
}

/**
 * 模型用量 (用户原话:「每个任务都要统计模型调用次数和消耗 token,有子任务的要计算所有
 * 子任务的总量」)。
 *
 * 两行,而且**只有真的分得开时才画第二行**:一个叶子节点的「本节点」和「含子任务」永远
 * 相等,画两行相同的数字只会让人怀疑自己看错了。
 *
 * 缓存读写单列:命中缓存的输入在计费上便宜一个数量级,把它并进 input 会让一个高度复用
 * 上下文的运行看起来贵得离谱。
 */
export function usageBody(n: TaskNode, resolveNode?: (id: string) => TaskNode | undefined): string {
  const own = n.usage
  const line = (label: string, u: UsageTotals): string => {
    const est = u.estimated ?? 0
    // 估算要**说清楚有几次**,不只是一个 ≈:「12 次调用,其中 3 次是估的」和
    // 「12 次全是估的」是两种完全不同的可信度,而用户拿这个数去判断花了多少钱。
    const parts = [`${u.calls} 次调用`, `${est > 0 ? '≈' : ''}${formatTokens(totalTokens(u))} tokens`]
    if (u.input > 0 || u.output > 0) parts.push(`输入 ${formatTokens(u.input)} / 输出 ${formatTokens(u.output)}`)
    if (u.cacheRead > 0 || u.cacheWrite > 0) parts.push(`缓存 读 ${formatTokens(u.cacheRead)} / 写 ${formatTokens(u.cacheWrite)}`)
    if (est > 0) parts.push(`其中 ${est} 次是估算(上游没报用量,或是 CLI 档员工)`)
    return `${label}: ${parts.join(' · ')}`
  }
  const rows: string[] = []
  if (!isEmptyUsage(own)) rows.push(line('本节点', own!))
  /**
   * 被任务重做删掉的那棵子树花了多少 —— **单独一行**。
   *
   * 并进「本节点」会答不了任何一个问题:「这个节点自己花了多少」和「我为一次推倒重来
   * 付了多少」是两件事。而不画的话,表头的总数里有一截无处解释。
   */
  if (!isEmptyUsage(n.discardedUsage)) rows.push(line('已废弃(重做删掉的子任务)', n.discardedUsage!))
  // `?? []`:`subtreeUsage` 早就这么写了(作者显然想过),这里漏了 —— node.md 是可
  // 手工编辑的,而一个渲染函数抛出去会把整屏带走。
  if ((n.childIds ?? []).length > 0) {
    // resolveNode 缺席时**不画这一行**,而不是画一个等于自己的合计 —— 后者是一句假话:
    // 这个节点明明有子任务,数字却把它们全漏了,而屏幕上看不出漏了。
    if (resolveNode) {
      const all = subtreeUsage(n, resolveNode)
      // N 是**直接**子节点数,而合计覆盖**整棵子树**(含孙节点)。不写清楚的话
      // 「含 3 个子任务合计 26 次」会被读成「这 3 个加起来 26 次」。
      if (!isEmptyUsage(all)) rows.push(line(`含 ${(n.childIds ?? []).length} 个子任务(整棵子树)合计`, all))
    } else if (rows.length > 0) {
      rows.push(`(子任务用量本屏取不到)`)
    }
  }
  return rows.join('\n')
}

/**
 * 用户补给这个节点的指引(重做 / 跳过时写的那句话)。
 *
 * **必须有地方看得见。** 它会被原样拼进提示词,而「同一处再写一次是替换」——
 * 不显示的话,用户没有任何办法知道这个节点上此刻挂着哪几句话、上一次写的那句还在不在。
 * 按环节列,`all` 那条写成「整个任务」。
 */
export function guidanceBody(n: TaskNode): string {
  const g = n.guidance
  if (!g) return ''
  const rows: string[] = []
  // 「整个任务」排最前:它作用于每一个环节,是这几条里覆盖面最大的那一条。
  if (g.all && g.all.trim().length > 0) rows.push(`整个任务: ${g.all.trim()}`)
  // 按 PHASE_NAMES 的顺序,和详情页里环节耗时、名册那几处保持一致。
  for (const p of PHASE_NAMES) {
    const t = g[p]
    if (t && t.trim().length > 0) rows.push(`${PHASE_LABEL[p]}: ${t.trim()}`)
  }
  return rows.join('\n')
}

/**
 * 「出身」那一段 —— 只有手工新增的任务才有内容(其余节点这一段整个不显示)。
 *
 * `detailSections` 末尾会把空 body 过滤掉,所以模型拆出来的节点版面**逐字不变**。
 */
export function manualAddBody(n: TaskNode): string {
  const m = n.manualAdd
  if (!m) return ''
  return (
    `用户在运行中手工新增(${m.at})\n` +
    `挂载点: ${m.anchorId}\n` +
    '下面「目标」一段是用户逐字给出的提示词,不是从上级方案派生的 —— 它也不在上级任务原来的拆分里。'
  )
}

/**
 * 「本轮返工原因」那一段。
 *
 * 比树行上那一句多两样东西:**不截断的原文**,和一句「下一轮会带着它跑」——后者不是废话,
 * 它回答的是用户真正在问的第二个问题(「这个原因和建议有没有传给下一轮」)。传是真的传了
 * (方案侧 planFeedbackPrompt、执行侧拿测试验证+验收的累积账),但屏幕上从来没说过。
 */
function reworkBody(n: TaskNode): string {
  const r = reworkReason(n)
  if (!r) return ''
  const carried = r.step === 'review'
    ? '下一轮重拟方案时,这条连同更早几轮的意见会一起交给方案作者(按轮次标注,不只带最后一轮)。'
    : '下一轮返工时,验收的累积意见会一起交给执行者。'
  return `第 ${r.rounds} 轮${PHASE_LABEL[r.step]}未通过:\n${r.why}\n\n${carried}`
}

/**
 * 「对上一轮意见的逐条处置」——一条一行,带编号。
 *
 * 编号是**重新数的**,不沿用条目正文里的「第 N 条」:那串数字是模型写的,它和上面
 * 「本轮返工原因」里的意见顺序对不对得上,这里没有任何办法核实。屏幕上自己数一遍,
 * 至少「一共回了几条」这个数是真的 —— 而这需要**续行缩进**才成立:条目正文是模型写的,
 * 它换一行就顶格,屏幕上两条含换行的回应看起来是四条、编号 1/2/2/3。验收实测过这一条,
 * 它恰好是上面那句话自称要消掉的东西。
 *
 * 非字符串项在恢复那一侧就被剔掉了(validateLoadedNodes),这里的 String() 是纵深防御:
 * 详情页在 render 里抛,整个 /et 界面就黑了。
 *
 * `stripControl` 同理,而它是验收查出来的一处不对称:`persistence.ts` 里同名的那个函数
 * 剥了,这里没剥 —— 同一份数据、同一个函数名、两种处理。一个 `[2J` 走到这里就是
 * 清屏 + 改标题。(旁边 `execStatus`/`plan.solution` 也没剥,那是既有面,不在这次范围内;
 * 但一段自称「纵深防御」的注释底下漏掉真正要防的那样,是这次的事。)
 */
function responsesBody(items: string[] | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  return items
    .map((s, i) => `${i + 1}. ${stripControl(typeof s === 'string' ? s : String(s)).split('\n').join('\n   ')}`)
    .join('\n')
}

/** 评审 / 验收记录:每轮一行。 */
function roundsBody(log: TaskNode['reviewLog']): string {
  return log
    .map(r => {
      /**
       * 人工强制通过要**在这一行上就看得出来**,不能只在展开的角色意见里。
       *
       * 详情页这一段是折叠的,用户扫的就是这些行。一条只写着「通过」的人工裁决和一桌
       * 真的通过在这里逐字相同 —— 而 node.md 那侧已经为同一件事把 mark 分开了
       * (见 persistence 的 roundtableBody),两边口径必须一致,否则同一条记录在
       * 界面上和文件里读起来是两回事。
       */
      const manual = r.verdicts.some(v => v.manual === true)
      /**
       * 修复类环节(质疑修复 / 测试修复)不写「通过」。
       *
       * 两边口径必须一致:node.md 那侧已经按同一条判据把它们和真裁决分开了
       * (见 persistence 的 roundtableBody)。这一关不做判决,而 `synthesized.pass` 恒为
       * true —— 照旧印「通过」会让界面上出现一次从没发生过的放行。
       * 判据是记录自带的 `step`,老记录(没有 step)照旧按裁决渲染,那对它们是对的。
       */
      const isFix = r.step === 'review' || r.step === 'verify'
      const head = manual ? '人工强制通过' : isFix ? '已修复' : r.synthesized.pass ? '通过' : '未通过'
      // 人工那条的 blockingSummary 是空的(它就是通过),被覆盖的意见在 comments 里 ——
      // 摊到这一行上,否则用户要展开才知道自己当初放行了什么。
      const detail = manual
        ? r.verdicts.find(v => v.manual === true)?.comments ?? ''
        : r.synthesized.blockingSummary
      /**
       * 「哪一关」和「按哪一档判的」这两件事,`persistence.ts` 的 `roundtableBody` 都写进了
       * node.md,而这里一个都没有 —— 上面那段注释自己定的规矩是「两边口径必须一致,否则
       * 同一条记录在界面上和文件里读起来是两回事」。
       *
       * `step` 尤其要紧:验收记录这一节是**三关共用**的(测试验证/验收/集成验收),没有
       * 标记时会出现两条「第 1 轮」而读不出哪条是谁。档位则是「第 1 轮按专家判不通过、
       * 第 2 轮降到中级判通过」在界面上唯一读得出来的地方。
       *
       * 两者省略时都不画,老记录逐字不变。
       */
      const step = r.step && PHASE_LABEL[r.step] ? `[${PHASE_LABEL[r.step]}] ` : ''
      const lv = r.strictness ? `(${r.strictness}档) ` : ''
      return `${step}${lv}第 ${r.round} 轮 ${head}${detail ? ': ' + detail : ''}`
    })
    .join('\n')
}

/**
 * 手工依赖重算的账 —— 一次一行。
 *
 * 和 node.md 那一节同一份口径(`persistence.ts` 的 `depsRecalcBody`),包括**把恢复边界
 * 夹掉的条数一起印出来**:不印的话界面上的条数和 run.md 上的 `⟲ ×N` 会对不上,而对不上时
 * 读的人无从知道是截断还是数据坏了。
 *
 * DEFENSIVE:详情页在 render 里抛,整个 `/et` 界面就黑了(这一段旁边的 `responsesBody`
 * 为同一件事写过注释)。
 */
function depsRecalcBody(n: TaskNode): string {
  const list = Array.isArray(n.depsRecalc) ? n.depsRecalc : []
  const dropped = Number.isFinite(n.depsRecalcDropped) ? Math.max(0, Math.trunc(n.depsRecalcDropped as number)) : 0
  if (list.length === 0 && dropped === 0) return ''
  const ids = (v: unknown): string =>
    Array.isArray(v) ? v.map(x => stripControl(String(x))).join('、') || '(空)' : '(格式不对)'
  const lines = list.map(r =>
    `${stripControl(String(r?.at ?? '?'))}: ${ids(r?.from)} → ${ids(r?.to)}` +
    (r?.note ? `(${stripControl(String(r.note))})` : ''))
  if (dropped > 0) lines.push(`(另有 ${dropped} 次未逐条保留 —— 恢复时只留了最早一条和最近几条)`)
  return lines.join('\n')
}

/**
 * 依赖 (spec §10.2). Missing deps are REPORTED, not hidden: a dangling id is why the node is
 * blocked, and silently shrinking the list would hide the cause.
 */
function depsBody(
  n: TaskNode,
  resolveNode?: (id: string) => TaskNode | undefined,
  /** 给了才写「按 d 重算」那一行 —— 一个按了必然被拒的提示比没有更糟。 */
  canRecalc?: boolean,
): string {
  const lines = n.deps
    .map(id => {
      // No resolver at all is NOT "the node is missing" — it is "the caller did not wire one".
      // Reporting the first as the second is precisely the class of lie this repo keeps paying
      // for, so an unwired pane degrades to bare ids and only a resolver that ANSWERS undefined
      // reports a missing node.
      if (!resolveNode) return id
      const d = resolveNode(id)
      if (!d) return `${id}(节点缺失)`
      /**
       * **真 id 也印出来。**
       *
       * 依赖重算之后 deps 可能指向别人子树深处的节点,而「父标题 / 本标题」在同名孙节点上
       * **仍然不唯一**;这一段本来就是机器生成段(`md: false`,里面是 id、路径、`[STATUS]`),
       * 多印一个 id 不破坏任何东西,却让「它到底依赖哪一个」变成可判定的。
       */
      const label = d.parentId !== null && d.parentId !== n.parentId
        ? `${resolveNode(d.parentId)?.title ?? d.parentId} / ${d.title}`
        : d.title
      return `${label}(${d.status}) — ${id}`
    })
  /**
   * 「按 d 重算」的提示放在**这一段的最后一行**,不进段落标题。
   *
   * 标题是身份:`expanded` / `secMode` / `anchor` / `selTitle` 四个状态全按标题寻址,
   * 而这个提示的显示条件是 `status === 'CREATED'` —— 节点离开 CREATED 是**编排器 tick 出来的,
   * 用户一个键都没按**,而重算成功之后他还停在详情页读结果的那几秒正是概率最高的时刻。
   * 标题一改:他展开着的那一段自己收起、↑↓ 的语义在他手底下翻面、视口跳回顶部 ——
   * 逐字就是这个文件为「按标题寻址」付过一次学费的那个事故。
   *
   * 放在**最后一行**还有一层:它消失时不会移动它上面任何一行(锚的 delta 是相对段标题算的)。
   */
  if (canRecalc === true && lines.length > 0) {
    lines.push('(依赖太粗?按 d 让主模型按已拆出的子任务重算一次)')
  }
  return lines.join('\n')
}

/**
 * 「任务」页卡的全部段落。**纯函数**,和渲染分开。
 *
 * 分开不是洁癖:详情页现在是一个会滚动的窗口,屏幕上任何时刻都只有其中一屏 ——
 * 「评审记录这一段在不在」这类断言如果只能从帧里找,就会变成「它有没有恰好滚到可视区」,
 * 而那和它存不存在是两件事。段落是数据,可视区是另一回事。
 *
 * 空 body 的段落**不进列表**:选中一个什么都没有的「风险点」是死格。
 */
export function detailSections(
  n: TaskNode,
  resolveNode?: (id: string) => TaskNode | undefined,
  /** 这一屏能不能按 d 重算依赖。只影响「依赖」段最后那一行提示。 */
  canRecalcDeps?: boolean,
  /** 上一次按 d 被拒绝的原因 —— 渲染在详情页里,**不切屏**(见下面那一段)。 */
  recalcNotice?: string,
): SectionSpec[] {
  const all: SectionSpec[] = [
    // 依赖排在最前,和改造之前的版面一致 —— 一个节点停在 READY 不动时,人是为这一段来的。
    // 机器生成的几段(依赖 / 评分 / 迭代 / 耗时 / 用量 / 工作区)**不上 markdown**:
    // 里面是 id、路径、`[STATUS]`、`--flag`,交给 markdown 解析器只会被吃掉记号。
    { title: '依赖', body: depsBody(n, resolveNode, canRecalcDeps) },
    /**
     * 「上一次按 d 为什么什么都没发生」。
     *
     * **准入拒绝不切屏**:那五条判据全是纯内存读、零 await,而关口是 phase 级整屏替换 ——
     * 切过去再回来会把 `TaskTreePanel` 连同 `NodeDetail` 整棵卸载,用户展开到哪一段、
     * 读到第几行(住在这两个组件自己的 state 里)全没了。「什么都没发生」不该长成
     * 「你的阅读位置没了」。所以拒绝走这一段,不走关口。
     *
     * 排在「依赖」之后:它回答的正是刚才在那一段上按下那个键的结果。
     */
    { title: '依赖重算', body: recalcNotice ?? '', color: 'warning' },
    { title: '依赖重算记录', body: depsRecalcBody(n) },
    /**
     * 「这个任务是哪来的」。
     *
     * 树上多出来一个任务时,「模型拆出来的」和「有人中途手工加的」在界面上此前**逐字相同**,
     * 而这两件事读方案、读验收记录的方式完全不同(手工加的那个不在父任务的方案里)。
     * 排在「目标」**之前**:它决定了下面那一段该怎么读 —— 手工新增时,「目标」就是用户
     * 逐字写下的提示词,不是从父目标派生的。
     */
    { title: '出身', body: manualAddBody(n) },
    // 以下都是模型写的散文,而且模型本来就在写 markdown。
    { title: '目标', body: n.goal, md: true },
    { title: '完整方案', body: n.plan.solution, md: true },
    { title: '重点', body: n.plan.keyPoints, md: true },
    { title: '风险点', body: n.plan.risks, md: true },
    { title: '验收点', body: n.plan.acceptance, md: true },
    { title: '执行状态', body: n.execStatus, md: true },
    // 用户亲手写的话,md 上色 —— 和「目标」「完整方案」同一档待遇。排在执行状态之后、
    // 阻断原因之前:它通常是**因为**上一次失败才写的,读的顺序就是这个。
    { title: '补充指引(你写的)', body: guidanceBody(n), md: true },
    // 红色是**语义**(这是把节点挡下来的那条),不能被 markdown 的行内颜色顶掉。
    { title: '阻断原因', body: n.blockedReason, color: 'error' },
    /**
     * 「这一轮为什么在重做」——**排在两段流水账之前**,因为它回答的是另一个问题。
     *
     * 「评审记录 / 验收记录」在下面,那是历史(每一轮一行);而用户报的是「重拟和重做时,
     * 其原因没有列清楚」—— 他要的是**此刻**这一轮被谁打回来的那一条。让他从一段十几行的
     * 流水账里自己找出最后一条未通过,就是把这个问题原样丢回去。
     *
     * 内容是从同两份记录派生的(reworkReason),所以不会和下面那两段对不上。
     */
    { title: '本轮返工原因', body: reworkBody(n), md: true },
    /**
     * 「它声称是怎么处置的」——紧跟在「为什么被打回来」后面,因为这两段是一问一答。
     *
     * 上面那段说的是**别人提了什么**,这两段说的是**它自己回了什么**。一个盯着第 3 轮还
     * 没过的节点看的人,要判断的正是「它到底改了没、还是每轮都在说同一句话」,而那个判断
     * 只有把问和答摆在一起才做得出来。空的自动不显示(见下面的 filter),所以第 1 轮和
     * 从没返工过的节点版面逐字不变。
     */
    { title: '方案:对上一轮意见的逐条处置', body: responsesBody(n.plan.responses), md: true },
    { title: '执行:对上一轮意见的逐条处置', body: responsesBody(n.execResponses), md: true },
    { title: '评分', body: scoreBody(n) },
    { title: '迭代次数', body: iterationBody(n) },
    // 时间线排在各阶段之前:先回答「这个任务是什么时候的事」,再回答「时间花在哪一步」。
    { title: '时间', body: timelineBody(n) },
    { title: '各阶段耗时与时间点', body: phaseTimeBody(n) },
    // 紧挨着耗时:两者回答的是同一个问题的两半 ——「这个节点贵在哪」。
    { title: '模型用量', body: usageBody(n, resolveNode) },
    // 每轮一行的骨架是我们拼的,但 blockingSummary 是评审员写的散文 —— 上色的收益
    // (「[架构] **缺回滚**」里的重点看得见)大于骨架被解析的风险(骨架里没有记号)。
    { title: '质疑修复记录', body: roundsBody(n.reviewLog), md: true },
    { title: '验收记录', body: roundsBody(n.acceptLog), md: true },
  ]
  if (n.worktree) all.push({ title: '隔离工作区', body: `${n.worktree.branch}\n${n.worktree.path}` })
  return all.filter(s => s.body.trim().length > 0)
}

/**
 * 一个节点,满屏,两个页卡 —— 「回车进入看更多任务细节」那一屏。
 *
 * ## 高度从哪来(这里错一个数就会静默丢内容)
 *
 * 全屏模式下 `/et` 是 local-jsx,渲染在 FullscreenLayout 的 **modal 槽**里,而那个槽给的是
 * `rows - 3` / `columns - 4`,外面还罩着 `overflow="hidden"`。所以尺寸走
 * `useModalOrTerminalSize`(仓库为这件事写的钩子),不是裸的 `useTerminalSize` ——
 * 后者会**恒定多算 3 行**,而多出来的部分是从**底部**剪掉的,第一个被剪掉的正是
 * 用户点名要的那条页签条。
 *
 * 非全屏时**不做满屏**:`/et` 渲染在对话流里,帧高一旦超过视口,任务树那个 1s tick
 * 每跳一次就逼出一次整屏重置(实测 29 行终端 + 长历史下 10 分钟 507 次),而且被切掉的
 * 是**顶部**(标题和目标)—— 和全屏正好相反。所以非全屏留 8 行余量,和任务树面板一致。
 *
 * ## 为什么自己切片,而不是给 Box 一个 height 就完事
 *
 * 实测:带 height 的 Box 里,超量子节点会被 yoga **按比例压缩**而不是裁掉 ——
 * 50 行塞进 10 行拿到的是 `L004,L009,L014,…`,而且标题行本身也一起消失。
 * 所以行数必须自己算准、自己切片,每一行 `flexShrink={0}`,`height` 只当最后一道保险。
 */
export function NodeDetail(props: {
  node: TaskNode
  elapsed: string
  /**
   * 这一屏能用多少个终端行。**由调用方声明**,不由本组件猜。
   *
   * 两个调用方的可用高度不一样:运行视图里面板独占屏幕,而完成视图在树的**下面**还画着
   * 一个总结框(收口结果 / 后续动作 / 重做遗留问题),行数运行时可变。组件看不见那个框。
   */
  maxRows?: number
  /** 子 agent 实时输出:每次模型调用一条流,带署名。 */
  streams?: readonly StreamState[]
  /** 这个节点一共有多少输出没能留下来(环形缓冲 + 被收起的窗口)。 */
  droppedEvents?: number
  /** 这个节点是 --resume 带进来的:没有流 ≠ 什么都没干。 */
  historical?: boolean
  /** 本屏是否接管键盘。 */
  logActive?: boolean
  /** 日志窗自己的状态 —— 用来断言「页卡焦点真的管住了它的键盘」。 */
  onLogState?: (s: { selected: number; mode: LogPaneMode }) => void
  /**
   * 焦点状态的观测口。
   *
   * 这个渲染器只写**增量**,一次光标移动在帧里是几个分散的片段,按子串断言既脆又容易恒真。
   * 测试要的是「焦点到底在哪」,那就把它直接交出来。
   *
   * `zone` 还有第二个用途,而且是**功能性**的:回车归 TaskTreePanel(返回任务树),
   * 只有焦点落在页签条上时才让路 —— 而那一让必须由 TaskTreePanel 自己做,
   * 因为 `useInput` 的 listener 槽位按 mount 时刻固定,它比本组件先挂、永远先跑。
   */
  onState?: (s: {
    zone: DetailZone
    tab: DetailTabId
    cursor: number
    expanded: string[]
    /**
     * 段落区**实际画出来的**光标下标;-1 = 没画(焦点不在它身上)。
     *
     * 和 `cursor` 是两件事:`cursor` 是「光标记在第几段」,这个是「屏幕上有没有画那个 ❯」。
     * 这三条接线(段落光标跟不跟焦点、页签反显、点页签换不换焦点)此前一条都没被钉住 ——
     * 把它们逐个改掉,全套 2150 条测试一条不红。而它们说的正是「别画一个『选中了、
     * 但按键不归它』的假象」,是这个仓库反复付学费的那类谎。
     */
    cursorShown: number
    /** 此刻反显的是哪几个页签(焦点真的落在页签条上时才有)。 */
    tabsInverse: string[]
    /**
     * 「任务」页卡此刻 ↑↓ 归谁 —— 选段落还是滚内容。
     *
     * 和 `AgentLogPane` 的 `onState.mode` 同一个理由,而且是同一个坑:模式在屏幕上
     * **根本观测不到**(渲染器只写增量,`lastFrame()` 又把转义换成空格),而这次改动的
     * 全部内容就是「同一个键在两种状态下做两件事」。按帧文本断言只能钉住页脚那半句,
     * 钉不住行为。
     */
    secMode: LogPaneMode
    /**
     * 「任务」页卡此刻从第几行开始画。
     *
     * 和 AgentLogPane 的 onState 交出 from 是同一个理由,而且是同一个坑:滚动位置在这个
     * 仓库的 TTY 夹具里**根本观测不到** —— 渲染器只写增量,累积缓冲又把展开前后的两份
     * 画面混在一起。「展开一段之后视口跳没跳走」只能靠这个数来判。
     */
    from: number
  }) => void
  /** 这一屏能不能按 r 重做。键是父面板处理的,这里只负责**说出来**。 */
  canRedo?: boolean
  /** 能不能按 R 快速重做失败的那个环节(只有失败节点才给)。同上,只负责说出来。 */
  canRedoFailed?: boolean
  /** 能不能按 s 跳过失败的那个环节。 */
  canSkipFailed?: boolean
  /**
   * 能不能按 c 一键回收这棵子树里已完成任务的隔离工作区。
   *
   * 只有这一趟真的在用隔离工作区时才给 —— 没有池子就没有目录可清,而一个按了什么都不会
   * 发生的键比没有这个键更糟(这一行上面那两个键为同一条规矩写过注释)。
   */
  canCleanup?: boolean
  /**
   * 能不能按 `m` 把这棵子树里还没合进主干的工作区合掉。
   *
   * 和 `canCleanup` 同一条规矩:只有这一趟真的在用隔离工作区时才给 —— 共享工作树运行时
   * 执行者直接写在同一棵树里,没有任何东西需要合,而一个按了什么都不会发生的键比没有
   * 这个键更糟。
   */
  canMergeWorktrees?: boolean
  canRepairNode?: boolean
  /** 回溯:集成验收没通过的、以及产出丢了的任务重新推一遍。 */
  canBacktrack?: boolean
  /**
   * 能不能按 d 重算依赖。只影响「依赖」段最后那一行提示 —— **不进段落标题**,
   * 理由见 depsBody 里那一段(标题是身份,而这个条件会被编排器自己 tick 掉)。
   */
  /**
   * 能不能按 `f` 强制通过一个环节。
   *
   * **这个键一直能按,却从来没被宣告过** —— `TaskTreePanel` 的详情分支接了 `k === 'f'`,
   * 而这一行的提示串里没有它,这个组件连这个 prop 都没有。审计出来的。
   */
  canForcePass?: boolean
  /**
   * 能不能按 `a` 用一段提示词新增一个任务。
   *
   * 由调用方走**真正的准入**回答(同一个 `addTaskScope`),不是「回调给了没有」——
   * 这个键的准入有七八条,而一个按了必然被拒的提示比没有这个提示更糟。
   */
  canAddTask?: boolean
  /** 页脚按键提示翻到第几页(取模,调用方一直加就行)。 */
  hintPage?: number
  /** 上一次动作键被拒的原因。给了就**盖住页脚那一行** —— 用户刚按了键,他只会看那儿。 */
  actionNotice?: string
  canRecalcDeps?: boolean
  /** 上一次按 d 被拒绝的原因。渲染在详情页里,不切屏。 */
  recalcNotice?: string
  /** 可用列宽。省略则跟着终端/模态槽走。 */
  columns?: number
  /** Resolves a dependency id to its node, so 依赖 renders as titles and statuses. */
  resolveNode?: (id: string) => TaskNode | undefined
  /** 打开时停在哪个页卡。默认「任务」—— 进来先看目标和方案。 */
  initialTab?: DetailTabId
}): React.ReactElement {
  const n = props.node
  const [theme] = useTheme()
  const term = useTerminalSize()
  const { rows: availRows, columns: availCols } = useModalOrTerminalSize(term)
  const inModal = useIsInsideModal()
  const ui = uiStatus(n.status)

  /**
   * 非全屏时**留 8 行余量**,不吃满 rows。
   *
   * `/et` 渲染在对话流里,帧高一旦超过视口,任务树那个 1s tick 每跳一次就逼出一次整屏
   * 重置(实测 29 行终端 + 长历史下 10 分钟 507 次),而且被切掉的是**顶部**(标题和
   * 目标)—— 和全屏正好相反。8 这个数和任务树面板用的是同一个。
   */
  const budget = Math.max(10, props.maxRows ?? (inModal ? availRows : availRows - 8))
  const { contentRows, paneRows, contentWidth } = detailLayout({
    budget,
    columns: props.columns ?? availCols,
    inModal,
  })

  const [zone, setZone, zoneRef] = useLiveState<DetailZone>('content')
  const [tab, setTab, tabRef] = useLiveState<DetailTabId>(props.initialTab ?? 'task')
  const [, setCursor, cursorRef] = useLiveState(0)
  /**
   * 选中的是**哪一段**(按标题),不是「第几段」。
   *
   * 下标不是身份:`detailSections` 过滤掉空 body,而节点跑起来会在**中间**插入
   * 「完整方案 / 重点 / 风险点 / 验收点 / 执行状态」。实测过的后果:光标停在下标 2
   * (「模型用量」)、按空格展开 → 方案跑出来了、列表从 3 段变成 7 段 → 下标 2 现在指着
   * 「重点」→ 展开状态还挂在「模型用量」上 → ↑↓ 的语义**在用户手底下自己从「滚动」翻回
   * 「选段落」**,页脚跟着变,而他一个键都没按。
   *
   * 所以身份是标题(和 `expanded` 同一个口径),下标只当回落(见 `alignSectionCursor`)。
   */
  const [, setSelTitle, selTitleRef] = useLiveState<string | undefined>(undefined)
  const [expanded, setExpanded, expandedRef] = useLiveState<ReadonlySet<string>>(new Set())
  /**
   * 视口锚。**按标题记**,和光标、展开状态同一个口径。
   *
   * 只把光标换成标题寻址是不够的 —— 验收实测过:段落列表在中间插入之后,光标跟着
   * 「阻断原因」走到了下标 6,而锚里那个 `stream: 1` 被 `headerAt(1)` 解成了
   * **「完整方案」**的标题行 → 用户正在读的那一行(46)已经在屏幕外,而 `from` 停在 16。
   * 比改动前更糟:改动前光标和锚都按下标、**互相一致**(一起指错段);两者分叉之后,
   * 空格/`n`/模式派生作用在第 6 段,视口显示的却是第 1 段附近,而页脚写着「↑↓ 滚内容」。
   *
   * `delta` 仍然是「相对那一段标题行的偏移」——它跟着内容走,不受插入影响。
   */
  const [, setAnchor, anchorRef] = useLiveState<{ title?: string; delta: number }>({ delta: 0 })
  /**
   * 输出页卡此刻 ↑↓ 归谁 —— 只用来写页脚。
   *
   * 真相在 `AgentLogPane` 里(它由那条流的折叠状态派生),这里是镜像。镜像方向必须是
   * **子 → 父**:折叠状态住在窗口自己的 useLiveState 里,父组件算不出来。写回时判一次
   * 相等,否则子组件的 effect 会和父组件的重渲染互相触发。
   */
  const [logMode, setLogMode, logModeRef] = useLiveState<LogPaneMode>(
    // 种子必须和窗口挂载那一刻算出来的**逐字相同**:不同的话第一帧的页脚是错的,而且
    // 那次纠正会多写一帧 —— 详情页的行数断言(按累积写入数行)会因此超预算 1 行。
    // 窗口挂载时 override 是空的、selected 是最后一条(initialSelectedStream),所以这里就是那一刻的状态。
    logPaneMode(
      foldedStreams(props.streams ?? [], new Map()),
      initialSelectedStream((props.streams ?? []).length),
      (props.streams ?? []).length,
    ),
  )

  const sections = detailSections(n, props.resolveNode, props.canRecalcDeps, props.recalcNotice)
  /**
   * 未展开的段落各留几行。
   *
   * 跟着内容区高度走,而不是写死:24 行的终端上每段 2 行(十几段刚好扫得完),
   * 大屏上每段能露出更多。下限 2 —— 一行标题一行正文,少于这个就不叫「摘要」了。
   */
  /**
   * 下限是 **3**,不是 2。
   *
   * 掐头留尾要占三行:头 1 + 「… 中间省略 N 行」1 + 尾 1。只给 2 行时头会被挤掉,
   * 24 行终端上每一段都长成「… 中间省略 59 行」+ 一条从中间切开的续行碎片 ——
   * 零信息量,而那正是用户第一次打开详情页看到的东西。
   */
  const collapsedLines = collapsedLinesFor(contentRows)
  /**
   * 版面的一次测量:总行数、每段标题在第几行、视口从第几行开始、最多能滚到哪。
   *
   * **是一个函数,不是几个 render 作用域的常量。** 一个 stdin chunk 会被拆成多个按键事件
   * **同步**派发(见 useLiveState 的文件头:按住 ↑ 拿到的是一个 chunk 多个事件),而
   * `useInput` 的 handler 只在 commit 之后才换。于是 handler 里读 render 作用域的
   * `secFrom` 时,一个 chunk 里第二下之后的每一下都基于**同一个陈旧值**、互相覆盖 ——
   * 实测 `AgentLogPane` 就有这个病:一个 chunk 里送 4 个 ↑,视口只动 1 行。
   * 而这次改动的卖点正是「一行一行读一段 60 行的方案」,按住 ↓ 只动 1 行等于没做。
   *
   * 展开状态和光标要从**外面传进来**:同一个 chunk 里「空格 + ↓」的第二下必须看见
   * 第一下的结果(ref),而 `expanded` 一变 `total` 就变。
   */
  const measure = (expandedNow: ReadonlySet<string>, cursorNow: number) => {
    // 滚动条占一列。
    const { lines, headerAt: hAt } = sectionLines({
      sections,
      cursor: sectionCursor(zoneRef.current, tabRef.current === 'task', cursorNow),
      expanded: expandedNow,
      width: contentWidth - 1,
      collapsedLines,
      theme,
    })
    const total = lines.length
    /**
     * 锚里的标题在**此刻**是第几段。
     *
     * 这一句就是「锚也按标题走」的落点:`anchoredFrom` 收的是下标(它和日志窗共用),
     * 而插入/删除之后同一个下标指的是**另一段**。解析放在这里,是因为这个函数是
     * 「从状态算出画面」的唯一入口 —— render 和 handler 都走它。
     */
    const anchorIdx = sections.findIndex(s => s.title === anchorRef.current.title)
    return {
      lines,
      headerAt: hAt,
      total,
      from: scrollWindow(total, paneRows, anchoredFrom(
        total, paneRows,
        // 那一段不在了(被清空/被过滤掉)→ 退回「按行号定位」,和这个功能之前一样。
        { stream: anchorIdx, delta: anchorRef.current.delta },
        hAt,
      )).from,
      maxFrom: Math.max(0, total - paneRows),
      canScroll: total > paneRows,
    }
  }
  const cursor = alignSectionCursor(sections, selTitleRef.current, cursorRef.current)
  const lay = measure(expanded, cursor)
  const secLines = lay.lines
  const secTotal = lay.total
  const secFrom = lay.from
  /**
   * 「任务」页卡此刻 ↑↓ 归谁。**派生的,不另存 state** —— 理由与输出页卡逐字相同
   * (见 `sectionPaneMode` 与 `LogPaneMode` 的注释)。这里只用来写页脚和交给测试;
   * 真正决定按键归属的那一份在 handler 里**现算**(合批)。
   */
  const secMode = sectionPaneMode(expanded, sections, cursor, lay.canScroll)

  React.useEffect(() => {
    props.onState?.({
      zone, tab, cursor, expanded: [...expanded].sort(), from: secFrom,
      // 交的是**画出来的样子**,不是 state 里的意图 —— 见上面 cursorShown 的注释。
      cursorShown: sectionCursor(zone, tab === 'task', cursor),
      tabsInverse: DETAIL_TABS.filter(t => tabFocused(zone, t.id === tab)).map(t => t.id),
      secMode,
    })
  })

  useInput((input, key) => {
    /**
     * 模式**在这里现算**,不用 render 作用域的 `secMode`。
     *
     * 同一个 chunk 里的「空格 ↓」是同步派发的:用上一帧的模式去解释那一下 ↓,拿到的是
     * 展开**之前**的语义(移光标而不是滚动)。而这两下正是这个功能最常见的用法。
     */
    const onTask = tabRef.current === 'task'
    const cursorNow = onTask ? alignSectionCursor(sections, selTitleRef.current, cursorRef.current) : 0
    const layNow = onTask ? measure(expandedRef.current, cursorNow) : undefined
    const mode = layNow
      ? sectionPaneMode(expandedRef.current, sections, cursorNow, layNow.canScroll)
      : 'select'
    const act = sectionPaneAction(input, key, mode)
    if (!act) return
    /**
     * 把「我想让视口停在第 n 行」翻译成锚 —— 相对**当前选中那一段的标题行**,
     * 而身份记的是它的**标题**(见 anchorRef 的注释)。
     */
    const anchorAt = (line: number): { title?: string; delta: number } => {
      const at = layNow ? layNow.headerAt(cursorNow) : -1
      return { title: sections[cursorNow]?.title, delta: at >= 0 ? line - at : line }
    }
    /** 选中第 i 段:光标、身份(标题)、锚三者必须一起动,否则视口会留在别处。 */
    const select = (i: number): void => {
      setCursor(i)
      setSelTitle(sections[i]?.title)
      // **切到哪,展示哪**:锚直接钉到那一段的标题行上。
      setAnchor({ title: sections[i]?.title, delta: 0 })
    }
    if (act.t === 'tab') {
      const i = DETAIL_TABS.findIndex(t => t.id === tabRef.current)
      const next = DETAIL_TABS[(i + act.d + DETAIL_TABS.length) % DETAIL_TABS.length]!
      setTab(next.id)
      return
    }
    if (act.t === 'switchZone') {
      setZone(zoneRef.current === 'tabs' ? 'content' : 'tabs')
      return
    }
    /**
     * 焦点在页签条上时,回车和空格都是「进入内容区」—— 用户原话「最下面点击或回车
     * 可选择不同的页卡内容展示」的那一半。
     *
     * **必须排在下面那条内容区闸门之前**:空格走到闸门那里会被当成「展开段落」挡掉,
     * 回车更是连闸门都到不了。这两个键此前只写在页脚上、按下去什么都不会发生,而
     * TaskTreePanel 已经为回车让了路(不再关详情页)—— 于是它彻底消失。
     */
    if (zoneRef.current === 'tabs') {
      if (act.t === 'enterContent' || act.t === 'toggle') setZone('content')
      return
    }
    // 内容区里的回车不归这里 —— 它是任务树面板的「返回任务树」。原样放过去。
    if (act.t === 'enterContent') return
    // 剩下的键归**内容区**,而且只归「任务」页卡 —— 「子 agent 输出」页卡的键盘是
    // AgentLogPane 自己的 useInput 在管。两个 handler 会同时收到每一个键,
    // 不冲突全靠这一句 + 键位不重叠(logPaneAction 里 Tab 和左右箭头都是不认的)。
    if (tabRef.current !== 'task') return
    if (!layNow) return
    // 半页(^u/^d、PgUp/PgDn)和逐行(read 模式的 ↑↓/jk)是**同一件事的两个步长**,
    // 所以共用一份夹取。起点用现算的 `layNow.from`,不是 render 作用域的 secFrom ——
    // 见 measure 的注释(合批的一个 chunk 里后面几下会互相覆盖)。
    if (act.t === 'scroll' || act.t === 'line') {
      const step = act.t === 'line' ? act.d : act.d * Math.max(1, Math.floor(paneRows / 2))
      setAnchor(anchorAt(Math.max(0, Math.min(layNow.maxFrom, layNow.from + step))))
      return
    }
    if (act.t === 'move') {
      if (sections.length === 0) return
      select(Math.max(0, Math.min(sections.length - 1, cursorNow + act.d)))
      return
    }
    /**
     * `n`:下一段,**循环**,两种模式下都认。
     *
     * 循环而不是撞到头就停:它和列表光标(↑↓)是两个不同的东西,和输出页卡的 `n`
     * (下一条流,循环)保持一致 —— 那边的注释把这条区别写清楚了。
     */
    if (act.t === 'nextSection') {
      if (sections.length === 0) return
      select((cursorNow + 1) % sections.length)
      return
    }
    const title = sections[cursorNow]?.title
    if (title === undefined) return
    const set = new Set(expandedRef.current)
    if (set.has(title)) set.delete(title)
    else set.add(title)
    setExpanded(set)
    // 展开/收起会让下面所有行整体位移,锚重新钉回这一段的标题 —— 否则视口当场跳走。
    setAnchor({ title, delta: 0 })
  }, { isActive: props.logActive === true })

  const hasLog = (props.streams?.length ?? 0) > 0
  /**
   * `--resume` 带进来、又没有任何新流的节点:输出页卡上**根本没有日志窗**,只有一行说明。
   *
   * 页脚必须跟着变 —— 不变的话它会列出「n 换流 · 空格 折叠 · t 思考」一整排,而那一排
   * 此刻全是死键。验收实测抓到的:这一屏此前零覆盖,连那句说明被整个删掉都没人红。
   */
  const logPaneMounted = !(props.historical === true && !hasLog)
  const mouse = currentMouseAvailability()
  /** 页签条自己占多宽(每个页签两侧各一个空格)。用来决定右边还放不放得下鼠标说明。 */
  const tabsWidth = DETAIL_TABS.reduce(
    (w, t) => w + stringWidth(` ${t.title}${t.id === 'log' && hasLog ? `(${props.streams!.length})` : ''} `),
    0,
  )
  const mouseText = mouse === 'on' ? '可点击页签' : mouseHint(mouse)
  /**
   * 页脚。**「怎么出去」排在最前面。**
   *
   * 这一行是 `wrap="truncate-end"`,而窄终端上它一定会被截 —— 实测 100 列时
   * 「Esc/q 返回任务树」正好是被吃掉的那一截。把出口放在末尾,等于用「还有哪些花活」
   * 换掉了「怎么退出去」。截断只许吃掉最不重要的那一头。
   */
  /**
   * 重做/跳过那几个键。**紧跟在出口后面**,排在导航说明之前。
   *
   * ## 这条次序被翻过来过一次,而翻回来的理由更硬
   *
   * 曾经的结论是「出口 → 导航 → 动作键」,依据是「`r · R · s` 会把新加的『↑↓ 两种含义』
   * 挤出屏幕」。**代价当时没量**:导航那一句自己就有 94 列,而非全屏可用宽是 `columns - 4`
   * —— 于是 **113 列以下 `r 重做本任务` 一个字都画不出来**,130 列以下没有 `R`,
   * 141 列以下没有 `s`。用户报的原话是「子任务重跑和阶段重跑功能没有了」:键一直是好的,
   * 而屏幕上从来没说过它们存在。
   *
   * 两者不对称,所以次序不该按「读起来顺」定:
   *  - ↑↓ **按下去就会有反应**,少一句说明只是少一句说明;
   *  - `r` / `R` / `s` 在没有提示时**完全不可发现** —— 那等于功能不存在。
   *
   * 任务树那一屏早就是这个次序(出口 → 干预/动作键 → 导航 → 图例),而且它的注释里
   * 记着同一次实测。同一个功能的两个页脚用两套优先级,本身就是这次事故的成因。
   *
   * 后三个只在这个节点真的能按时才写 —— 一个按了只会被拒绝的键和一个按了没反应的键一样糟。
   */
  /**
   * 每一个键**都要在**,一个都不许因为终端太窄而消失 —— 装不下的那些翻页给它。
   *
   * 段落数组而不是拼好的一整行:分页要按段切,切在段中间会造出一个读起来像另一个键的
   * 半截字符串。次序 = 被翻到后面去的先后:动作键在前(没有提示就完全不可发现),
   * 导航在后(↑↓ 按下去本来就有反应)。
   */
  const actionHints = [
    /**
     * **`a` 排在最前面。**
     *
     * 这个次序就是被翻页推后的次序(见上面那段实测:113 列以下 `r 重做本任务` 一个字都
     * 画不出来)。`a` 是全新的、没人猜得到的键 —— 排在 `b 回溯未通过的子任务` 后面就等于
     * 翻到第 2/3 页,而没有提示的键等于功能不存在。`r`/`R`/`s` 至少已经写在 README 和树的
     * 页脚上,它没有。
     */
    props.canAddTask ? 'a 新增任务' : '',
    props.canRedo ? 'r 重做本任务' : '',
    props.canRedoFailed ? 'R 重做失败环节' : '',
    props.canSkipFailed ? 's 跳过它' : '',
    // `f` 一直能按却从来没被宣告过 —— 审计出来的。
    props.canForcePass ? 'f 强制通过' : '',
    props.canRecalcDeps ? 'd 重算依赖' : '',
    props.canCleanup ? 'c 清理工作区' : '',
    // 「合并工作区」四个字不够:这个键会在**你自己的分支上**产生真实提交,而页脚是用户
    // 唯一读得到它的地方。写清目的地,别让人按完才知道东西落到哪儿了。
    props.canMergeWorktrees ? 'm 合并工作区到主干' : '',
    props.canRepairNode ? 'g 修复损毁的任务' : '',
    // 「回溯」两个字不够:这个键会重跑一批任务、删它们的工作区、可能还删子树。
    // 页脚是用户唯一读得到它的地方 —— 写清对象,别让人按完才知道动了什么。
    props.canBacktrack ? 'b 回溯未通过的子任务' : '',
  ].filter(s => s.length > 0)
  /** 页脚的段落清单。第一段是出口,分页会把它钉在每一页上。 */
  const footerSegments = ((): string[] => {
    if (zone === 'tabs') {
      return ['Esc/q 返回任务树', ...actionHints, '←→ 选页卡', '回车/空格 进入', 'Tab 回内容']
    }
    if (tab === 'log') {
      if (!logPaneMounted) return ['Esc/q 返回任务树', ...actionHints, '←→ 换页卡', 'Tab 到页签']
      /**
       * ↑↓ 在这一屏有**两个**含义,所以这一段必须跟着模式变。
       *
       * 写死一句「↑↓/jk 滚动」的后果不是少一条说明:选中一条折叠的流时按 ↑↓ 换的是流,
       * 而页脚说它在滚动 —— 用户会以为滚动坏了。这个仓库为「页脚上写着的键按了没反应」
       * 已经付过两次学费(Tab 切换环节、页签条上的回车),这次是同一类。
       */
      const nav = logMode === 'select'
        ? ['↑↓/jk 选阶段', '空格 展开(之后 ↑↓ 滚它的内容)']
        : ['↑↓/jk 滚动', '空格 收起(回到选阶段)']
      return [
        'Esc/q 返回任务树', ...actionHints, ...nav,
        '←→ 换页卡', 'Tab 到页签', 'n 下一条', 'g/G 顶部/底部', 't 思考', '耗时含等你批权限的时间',
      ]
    }
    /**
     * ↑↓ 在段落区也有**两个**含义了(用户原话:「和子 agent 上一样」),理由与上面
     * 输出页卡那一段逐字相同。
     *
     * `n 下一段` 只写在 read 模式里:select 模式下 ↑↓ 就是换段落,列一个同义键只会多占
     * 一段;而 read 模式下它是**唯一**不用先收起就能换段落的键(和输出页卡的 `n` 同位)。
     */
    const nav = secMode === 'select'
      ? ['↑↓/jk 选段落', '空格 展开(→ ↑↓ 滚内容)', '←→ 换页卡', 'Tab 到页签', '^u/^d 翻页']
      : ['↑↓/jk 滚内容', '空格 收起(→ ↑↓ 选段落)', 'n 下一段', '←→ 换页卡', 'Tab 到页签']
    return ['Esc/q 返回任务树', ...actionHints, ...nav]
  })()
  /**
   * 上一次动作键被拒的原因,**盖住这一行**。
   *
   * 它比键位提示当下重要得多:用户刚按了一个键、什么都没发生,而这一行是他唯一会看的
   * 地方。下一次按键就把它清掉(见 TaskTreePanel 的 actionNotice)。
   */
  const paged = paginateHints(footerSegments, contentWidth - 1, props.hintPage ?? 0)
  const footer = props.actionNotice ? `⚠ ${props.actionNotice}(按任意键继续)` : paged.text

  return (
    <Box
      flexDirection="column"
      // height 只是最后一道保险 —— 真正保证不溢出的是上面自己算出来的 contentRows。
      height={budget}
      borderStyle={inModal ? undefined : 'round'}
      paddingX={1}
    >
      <Box flexShrink={0}>
        <Text bold color={COLOR[ui]} wrap="truncate-end">{clipToWidth(n.title, contentWidth)}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {/* 树上用 ⊞ / ▪ 两个符号区分,这里有地方写字就直接写字。判据和树上那一处保持一致
              (见 TaskTreePanel.kindGlyph):同时看 childIds,因为动态生长会把子节点嫁接到
              一个已判 executable 的节点上。 */}
          {n.childIds.length > 0 || n.kind === 'decompose' ? '拆分任务' : n.kind === 'executable' ? '执行任务' : '待定'}
          {' · '}{n.id} · {n.status} · {props.elapsed}
          {n.childIds.length > 0 ? ` · 子任务 ${n.childIds.length} 个` : ''}
          {n.mergeConflict === true ? ' · 待人工解冲突' : ''}
        </Text>
      </Box>

      {/* 内容区。flexGrow 吃掉中间所有剩余高度,而它自己画的行数是上面算好的。 */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {contentWidth < MIN_DETAIL_WIDTH ? (
          /* 排不出可读的东西就明说,不要硬排 —— 硬排的结果是行回流、最后一行被静默剪掉,
             而帧的总行数一点没变(一个残缺的视图看起来完完整整)。 */
          <Box flexShrink={0}><Text color="warning" wrap="truncate-end">终端太窄</Text></Box>
        ) : tab === 'task'
          ? sections.length === 0
            ? <Text dimColor>这个节点还没有任何方案或执行记录。</Text>
            : (
              <ScrollPane
                slice={secLines.slice(secFrom, secFrom + paneRows)}
                total={secTotal}
                from={secFrom}
                height={paneRows}
                behind={Math.max(0, secTotal - paneRows - secFrom)}
                /* 提示要说**此刻**按 ↑↓ 会发生什么。select 模式下 ↑↓ 换的是段落、不是视口,
                   写「↑↓ 继续」就是那句「页脚上写着的键按了不是这个意思」的翻版。 */
                behindHint={secMode === 'read' ? '↑↓ 继续,^d 翻页' : '^d 翻页'}
              />
            )
          : null}
        {/**
          * 输出页卡**常挂**,不活跃时把高度压成 0,而不是卸载掉。
          *
          * 卸载的代价是实打实的:滚动位置、选中哪条流、哪些流被展开、思考展开了没有 ——
          * 全在 AgentLogPane 自己的 useLiveState 里。切去看一眼方案再切回来,用户会发现
          * 自己刚挑好的那条流回到了第一条,而他没按过任何键。
          *
          * `isActive` 必须**同时**判 tab:它现在一直挂着,不判的话在「任务」页卡上按 n
          * 会在背后偷偷换流 —— 两个 useInput 都收得到每一个键。
          */}
        <Box
          flexDirection="column"
          overflow="hidden"
          {...(tab === 'log' ? { flexGrow: 1 } : { height: 0, flexShrink: 0 })}
        >
          {props.historical === true && !hasLog ? (
            <Text dimColor>子 agent 输出:属于上一次运行,而盘上没有留下它的事件日志(在启用落盘之前跑的,或已被清理)。</Text>
          ) : (
            <AgentLogPane
              streams={props.streams ?? []}
              droppedEvents={props.droppedEvents}
              historical={props.historical}
              height={contentRows}
              width={contentWidth}
              isActive={props.logActive === true && zone === 'content' && tab === 'log'}
              onState={s => {
                props.onLogState?.({ selected: s.selected, mode: s.mode })
                if (s.mode !== logModeRef.current) setLogMode(s.mode)
              }}
            />
          )}
        </Box>
      </Box>

      {/* 页签条 + 页脚:同一个 flexShrink={0} 的底部块。
          **必须永远活过裁剪** —— 全屏下 modal 槽是从底部剪的,而用户点名要的就是
          「最下面点击或回车选页卡」。它一旦成为被剪掉的那一头,这个功能就等于不存在。 */}
      <Box flexShrink={0} flexDirection="row">
        {DETAIL_TABS.map(t => {
          const active = t.id === tab
          // 「(2)」会被读成「2 个子 agent」或「2 条输出」。它其实是**这个节点开过几次
          // 模型调用**(一次调用一条流,5 席圆桌下能到几十条,上限 40),所以把量纲写出来。
          const badge = t.id === 'log' && hasLog ? `(${props.streams!.length} 次调用)` : ''
          return (
            // 裸 Box + onClick,**不带 tabIndex**:带了的话 Tab 会同时轮转 DOM 焦点,
            // 而 Tab 在这一屏是「页签条 ⇄ 内容区」。写法抄 CoordinatorAgentStatus 的可点行。
            <Box key={t.id} flexShrink={0} onClick={() => { setTab(t.id); setZone('content') }}>
              <Text
                bold={active}
                inverse={tabFocused(zone, active)}
                color={active ? 'success' : undefined}
                dimColor={!active}
              >
                {` ${t.title}${badge} `}
              </Text>
            </Box>
          )
        })}
        <Box flexGrow={1} />
        {/* 鼠标说明。窄终端上**整个不画** —— 它会把这一行撑到回流成两行,而
            「一行 = 一个终端行」一旦破,下面的页脚就被顶出屏幕。宽度不够时宁可不解释。 */}
        {/* 放得下整句就说整句;放不下就退化成一个短标记 —— 但**不能什么都不说**。
            README 写着「具体原因写在页签条的右边」,而窄终端上那句话一度整个不画,
            于是「为什么点不动」在界面上哪儿都找不到。截断成半句更糟(会得到
            「鼠标需全屏模…」),所以是两级降级,不是 truncate。 */}
        {contentWidth - tabsWidth >= stringWidth(mouseText) + 1 ? (
          <Text dimColor wrap="truncate-end">{mouseText}</Text>
        ) : contentWidth - tabsWidth >= stringWidth(mouse === 'on' ? '可点' : '鼠标✗') + 1 ? (
          <Text dimColor wrap="truncate-end">{mouse === 'on' ? '可点' : '鼠标✗'}</Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">{footer}</Text>
      </Box>
    </Box>
  )
}
