// src/tools/efftask/factEvidence.test.ts
//
// 「评审员自己造错事实,烧掉两轮」那一组修复的探针。
//
// 事故(用户实测,root 节点,中级档,maxIterations=3):方案第 0 版说「api/…/v3rpc 下 14 个
// .proto」—— 全仓总数 14 是**对的**,错的是归属。第 1 轮两席都判不通过,而两条修法**互斥
// 且都错**:一位要求「统一修正为实际值 7」(它只跑了 `find …/api`),另一位要求「改为 13 个」
// (枚举漏了三个)。没有一席说 14。作者照着其中一条改成 13 —— 在系统看来它完全响应了阻断
// 意见 —— 于是第 2 轮整轮拿去把 13 改回 14。两次返工里有一次是在修评审员造的数字。
//
// 四条接缝,每一条都对应事故里的一个环节:
//   1. `EVIDENCE_RULE`      —— 结论不能超出你核过的范围(那位评审的错法)
//   2. `REBUTTAL_RULE` + 第三出口 —— 作者能说「你这条错了」,而裁决侧按**结论**核它
//   3. `Verdict.retracted` —— 让「作废」落到数据上,否则下一轮它照样复活
//   4. `crossSeatNotice`   —— 告诉作者「这几席没经过统一,可能互相矛盾」
import { describe, expect, it } from 'bun:test'
import {
  crossSeatNotice, exhaustionReason, feedbackItems, itemBudget, planFeedbackPrompt,
  retractedCount, reviewRepeatNotice, MAX_FEEDBACK_ITEMS, MAX_ITEM_CHARS,
} from './reviewConvergence.js'
import { parseVerdict, MAX_SUMMARY_CHARS } from './parseOutput.js'
import { stepStart, stepExecute, stepIntegrate, type PipelineCtx } from './pipeline.js'
import { serializeNode } from './persistence.js'
import { validateLoadedNodes } from './resumeCore.js'
import { byIdMap } from './stateMachine.js'
import { createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM } from './types.js'
import type { EffTaskConfig, RoundtableRecord, TaskNode, Verdict } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const NOW = '2026-08-04T00:00:00Z'
const mk = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root', title: '根', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW }),
  ...over,
})
const v = (over: Partial<Verdict> = {}): Verdict =>
  ({ role: 'main', pass: false, blocking: ['缺回滚方案'], comments: '', ...over })
const rec = (over: Partial<RoundtableRecord> = {}): RoundtableRecord => ({
  round: 1, verdicts: [v()], synthesized: { pass: false, blockingSummary: 'x' }, ...over,
})

// 事故原文(node.md 的 reviewLog round 1 两条 blocking,摘首句)。
const 总监原文 = 'proto 归属与计数矛盾:api/ 下实际只有 7 个 .proto(方案步骤 2 声称 14 个);rpcpb 要么显式排除并将 E 改为 13 个'
const 架构原文 = 'proto 数量事实错误且与验收E冲突。但实测 /home/esgyn/work/source/etcd/api 下 .proto 只有 7 个,需将方案与验收E中的「14」统一修正为实际值 7'

describe('crossSeatNotice —— 「这几席没经过统一」', () => {
  it('同一 (step,round) 里两席各自提了阻断意见 → 报出席位数', () => {
    const n = crossSeatNotice([rec({
      round: 1,
      verdicts: [v({ role: '总监', blocking: [总监原文] }), v({ role: '架构', blocking: [架构原文] })],
    })])
    expect(n).toContain('2 个席位')
    expect(n).toContain('不要挑一条照做')
  })

  it('**同一个席位**提了两条 → 不报。互斥说的是席位之间,不是条目之间', () => {
    expect(crossSeatNotice([rec({ verdicts: [v({ role: '总监', blocking: ['a', 'b'] })] })])).toBe('')
  })

  /**
   * 这一条是回归探针,钉的是评审查出来的那个假冲突。
   *
   * 测试验证与验收**共用 `acceptLog`**,而两关各自计数(`gateRound` 按 step 过滤后 +1),
   * 所以同一个 round 数会同时出现在两关的记录上。只按 `round` 分组的话,verify 第 2 轮和
   * accept 第 2 轮会被当成同一场圆桌 —— 而它们是两个关口、两批席位,两边的要求本来就都该做。
   * 那会凭空对执行者说一句「本轮有 2 个席位各自提了意见,它们没有经过统一」,而这句话是假的。
   */
  it('跨 step 同 round(verify#2 + accept#2)→ 不报', () => {
    const log = [
      rec({ round: 2, step: 'verify', verdicts: [v({ role: '测试', blocking: ['超时改为 30 秒'] })] }),
      rec({ round: 2, step: 'accept', verdicts: [v({ role: '验收', blocking: ['重试改为 3 次'] })] }),
    ]
    expect(crossSeatNotice(log)).toBe('')
  })

  it('同一 step 同 round 的两席仍然报 —— 上一条不能是靠「永远返空」通过的', () => {
    const log = [rec({
      round: 2, step: 'accept',
      verdicts: [v({ role: '验收甲', blocking: ['a'] }), v({ role: '验收乙', blocking: ['b'] })],
    })]
    expect(crossSeatNotice(log)).toContain('2 个席位')
  })

  it('infra 席位不算 —— 它的调用没打通,没有对工作做出任何判断', () => {
    const log = [rec({
      verdicts: [v({ role: '总监', blocking: ['a'] }), v({ role: '架构', blocking: ['角色调用失败'], infra: true })],
    })]
    expect(crossSeatNotice(log)).toBe('')
  })

  it('只看**最后一条记录**所属的那一组 —— 第 1 轮两席、第 2 轮一席 → 不报', () => {
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: ['a'] }), v({ role: '架构', blocking: ['b'] })] }),
      rec({ round: 2, verdicts: [v({ role: '总监', blocking: ['c'] })] }),
    ]
    expect(crossSeatNotice(log)).toBe('')
  })

  it('没有 blocking 的席位不算 —— pass 的那一席没提要求', () => {
    const log = [rec({
      verdicts: [v({ role: '总监', blocking: ['a'] }), v({ role: '架构', pass: true, blocking: [] })],
    })]
    expect(crossSeatNotice(log)).toBe('')
  })

  it('空日志安全', () => {
    expect(crossSeatNotice([])).toBe('')
  })
})

describe('Verdict.retracted —— 让「作废」落到数据上', () => {
  it('parseVerdict 解析 retracted,并且与 blocking 独立(不影响 pass)', () => {
    const out = parseVerdict(
      '```verdict\n{"pass":true,"blocking":[],"comments":"c","retracted":["proto 总数应改为 13"]}\n```',
      '总监',
    )
    expect(out.retracted).toEqual(['proto 总数应改为 13'])
    expect(out.pass).toBe(true)
  })

  it('没写 retracted 时**不落这个键** —— 老 node.md 的形状不变', () => {
    const out = parseVerdict('```verdict\n{"pass":true,"blocking":[],"comments":"c"}\n```', '总监')
    expect(Object.keys(out)).not.toContain('retracted')
    const empty = parseVerdict('```verdict\n{"pass":true,"blocking":[],"comments":"c","retracted":[]}\n```', '总监')
    expect(Object.keys(empty)).not.toContain('retracted')
  })

  it('feedbackItems 丢掉后来被撤回的那一条', () => {
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: ['proto 总数应当改为 13 个'] })] }),
      rec({ round: 2, verdicts: [v({ role: '总监', pass: true, blocking: [], retracted: ['proto 总数应当改为 13 个'] })] }),
    ]
    expect(feedbackItems(log)).toHaveLength(0)
  })

  /**
   * 撤回只对**撤回之前**提出的那些成立。
   *
   * 一条在第 2 轮被撤回、第 3 轮由另一位席位重新提出的意见,是一条**新的**意见 —— 它带着
   * 新的证据。不比轮次的话,那次撤回会把它永久压掉,而「永久」正是撤回不该有的力度:
   * 那等于给了任何一席一票否决全部后续同类意见的权力。
   */
  it('撤回之**后**重新提出的同一条,不被压掉', () => {
    const 意见 = 'proto 总数应当改为 13 个'
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: [意见] })] }),
      rec({ round: 2, verdicts: [v({ role: '总监', pass: true, blocking: [], retracted: [意见] })] }),
      rec({ round: 3, verdicts: [v({ role: '架构', blocking: [意见] })] }),
    ]
    const items = feedbackItems(log)
    expect(items).toHaveLength(1)
    expect(items[0]!.rounds).toEqual([3])
  })

  it('infra 席位的 retracted 不生效 —— 它什么都没核过', () => {
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: ['缺回滚方案'] })] }),
      rec({ round: 2, verdicts: [v({ role: '架构', blocking: ['角色调用失败'], infra: true, retracted: ['缺回滚方案'] })] }),
    ]
    expect(feedbackItems(log)).toHaveLength(1)
  })

  /**
   * **写得出去、读不回来** —— 这个仓库为 `step` 字段付过一次学费,三份独立验收各自实跑到
   * `retracted` 死在同一行上:`resumeCore.verdictArray` 是逐字段重建的,字段清单里没有它,
   * 于是每次 `--resume` 都把撤回记录抹掉,下一次 persist 再把抹掉的结果写回盘。
   * 后果是被撤回的意见**复活**,重新被追着要回应、重新被报成「至今未解决」。
   */
  it('落盘 → 读回:retracted 活得下来,撤回在 --resume 之后仍然生效', () => {
    const 意见 = 'proto 总数应当改为 13 个'
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: [意见] })] }),
      rec({ round: 2, verdicts: [v({ role: '总监', pass: true, blocking: [], retracted: [意见] })] }),
    ]
    const n = mk({ reviewLog: log })
    expect(feedbackItems(n.reviewLog)).toHaveLength(0)
    // 真的走一遍序列化 —— 落盘那一侧漏写同样会让这条断言失去意义。
    expect(serializeNode(n)).toContain('retracted')
    const disk = JSON.parse(JSON.stringify(n)) as TaskNode
    const got = validateLoadedNodes([disk], { goal: '目标', phaseRoles: emptyPhaseRoles(), now: NOW }).nodes[0]!
    expect(got.reviewLog[1]!.verdicts[0]!.retracted).toEqual([意见])
    expect(feedbackItems(got.reviewLog), '--resume 之后撤回失效,被撤的意见复活了').toHaveLength(0)
  })

  /**
   * 撤回的轮次比较必须按 **(step, round)** 分组,理由与 `crossSeatNotice` 逐字相同:
   * verify 与 accept 共用 `acceptLog` 而各自计数。只比 round 时,一个测试验证席位能撤掉
   * 验收关的账,而它从来没看过那一关的判据。
   */
  it('撤回不跨关口:verify 第 2 轮撤不掉 accept 第 1 轮的意见', () => {
    const 意见 = '验收关提的那条:缺回滚方案的验证步骤'
    const log = [
      rec({ round: 1, step: 'verify', verdicts: [v({ role: '测试', blocking: ['测试关自己的意见'] })] }),
      rec({ round: 1, step: 'accept', verdicts: [v({ role: '验收', blocking: [意见] })] }),
      rec({ round: 2, step: 'verify', verdicts: [v({ role: '测试', pass: true, blocking: [], retracted: [意见] })] }),
    ]
    expect(feedbackItems(log).map(i => i.text)).toContain(意见)
  })

  it('同一关口内照样撤得掉 —— 上一条不能是靠「撤回整个失效」通过的', () => {
    const 意见 = '验收关提的那条:缺回滚方案的验证步骤'
    const log = [
      rec({ round: 1, step: 'accept', verdicts: [v({ role: '验收', blocking: [意见] })] }),
      rec({ round: 2, step: 'accept', verdicts: [v({ role: '验收', pass: true, blocking: [], retracted: [意见] })] }),
    ]
    expect(feedbackItems(log)).toHaveLength(0)
  })

  /**
   * 撤回是这套里**唯一**能让一条真实提出过的意见在下游全线消失的机制,而代码侧没有任何闸门
   * 校验撤回者是不是提出者、撤得对不对(那需要语义)。唯一诚实的做法是让它在**人读的那一半**
   * 留痕 —— 少了这一行,一次误撤或滥撤在 node.md 上和「这条从没被提过」长得一模一样。
   */
  it('node.md 的评审记录里读得出「撤回」这件事', () => {
    const n = mk({
      reviewLog: [rec({
        round: 2,
        verdicts: [v({ role: '架构', pass: true, blocking: [], retracted: ['proto 总数应改为 13'] })],
      })],
    })
    const md = serializeNode(n)
    expect(md).toContain('↩ 本轮撤回 1 条历史意见')
    expect(md).toContain('proto 总数应改为 13')
  })

  it('撤回按相似度匹配,不要求逐字相同', () => {
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: ['proto 总数应当改为 13 个'] })] }),
      rec({ round: 2, verdicts: [v({ role: '总监', pass: true, blocking: [], retracted: ['proto总数应当改为13个。'] })] }),
    ]
    expect(feedbackItems(log)).toHaveLength(0)
  })
})

describe('第三个出口 —— 作者能说「你这一条错了」', () => {
  const items = [{ text: '把 14 改成 7', role: '架构', rounds: [1, 2] }]

  it('老账那段给的是**三**选一,而且要范围', () => {
    const s = planFeedbackPrompt(items)
    expect(s).toContain('要么在方案里解决')
    expect(s).toContain('为什么不适用')
    expect(s).toContain('事实前提有误')
    // 范围是判据的那一维:只跑 `find api/` 的作者,命令和输出都属实而结论仍然是错的。
    expect(s).toContain('覆盖的范围')
  })

  it('只被提过一轮的那一组也说得出三选一 —— 两组口径要对齐', () => {
    const s = planFeedbackPrompt([{ text: '新意见', role: '总监', rounds: [1] }])
    expect(s).toContain('【只被提过一轮】')
    // 事故里那两条互斥的错误意见**都是第 1 轮提出的**,走的正是这一组 —— 所以它的措辞要和
    // 老账那组一样硬:同样要命令、要输出、要范围。
    expect(s).toContain('举证指出这一条的事实前提有误')
    expect(s).toContain('命令覆盖的范围')
  })
})

describe('planFeedbackPrompt 的预算 —— 新增文字不许挤掉真实意见', () => {
  /**
   * 满载实测:这个函数**原本**就输出 4016 字,而 `MAX_SUMMARY_CHARS` 是 4000 —— 余量是负的。
   * 把提醒拼进条目再一起截,截掉的就是清单末尾的真实意见,而抬头那句「只列其中 20 条」是在
   * 裁剪之前算的,于是它会谎报仍列着 20 条。所以提醒在 capText **之外**,并且从条目的额度里
   * 扣掉自己的长度。
   */
  const 满载 = Array.from({ length: 24 }, (_, i) => ({
    text: `意见${i}:` + '方案里这一处没有交代清楚具体的落点与验证方式'.repeat(20),
    role: i % 2 ? '总监' : '架构',
    rounds: i < 12 ? [1, 2] : [2],
  }))

  it('提醒完整存活,不被截断', () => {
    const notice = crossSeatNotice([rec({
      verdicts: [v({ role: '总监', blocking: ['a'] }), v({ role: '架构', blocking: ['b'] })],
    })])
    expect(notice).not.toBe('')
    const s = planFeedbackPrompt(满载, '评审', notice)
    expect(s.startsWith(notice)).toBe(true)
    expect(s).toContain('不要挑一条照做')
  })

  it('条目正文仍然守着 MAX_SUMMARY_CHARS —— 提醒的长度从额度里扣掉了', () => {
    const notice = 'N'.repeat(300)
    const s = planFeedbackPrompt(满载, '评审', notice)
    expect(s.startsWith(notice + '\n')).toBe(true)
    const body = s.slice(notice.length + 1)
    /**
     * **变异探针**:把 `MAX_SUMMARY_CHARS - head.length` 改回 `MAX_SUMMARY_CHARS`,正文就会
     * 照旧占满 4000(加上 capText 的截断标记还要更长),这一条当场红。
     * (`capText` 的输出长度是 `max + 标记`,所以不能拿 `<= 3700` 去卡 —— 那是在卡标记的长度。)
     */
    expect(body.length).toBeLessThan(MAX_SUMMARY_CHARS)
  })

  // 名字要说准:比的是**改动后的函数自己**传空串与走默认值两条路,不是「与改动前逐字相同」
  // ——后者是假的(老账段加了第三出口,fresh 段整句重写了)。这个仓库里「逐字相同」几乎处处
  // 指兼容性承诺,用例名不能借那个词。
  it('不传提醒时与走默认参数逐字相同', () => {
    expect(planFeedbackPrompt(满载, '评审', '')).toBe(planFeedbackPrompt(满载))
  })

  it('抬头仍然说得出「另有 N 条未列出」', () => {
    expect(planFeedbackPrompt(满载)).toContain(`另有 ${满载.length - MAX_FEEDBACK_ITEMS} 条未列出`)
  })
})

describe('条目预算 —— 互斥的落点不许被截掉', () => {
  /**
   * 验收拿事故原文实证过一条**修复自己的漏洞**:事故那两条阻断意见是 406 字和 276 字,
   * 而互斥的落点(「改为 13 个」「修正为实际值 7」)都在尾部。按写死的 160 字砍完,作者拿到的
   * 正文里两个数字一个都没有 —— 于是 `crossSeatNotice` 那句「两条要求把同一处改成不同的
   * 样子」指着一份看不出矛盾的清单说话。提醒在场、依据被截掉,病只是换了个位置。
   */
  const 长总监 = 'proto 归属与计数矛盾:api/ 下实际只有 7 个 .proto。' + '相关背景与逐条核对过程'.repeat(20) +
    '修正方式:rpcpb 要么显式排除并将验收 E 改为 13 个,要么新增 tests/ 映射任务。'
  const 长架构 = 'proto 数量事实错误且与验收E冲突。' + '相关背景与逐条核对过程'.repeat(20) +
    '需将方案与验收E中的「14」统一修正为实际值 7。'

  it('两条长意见时,两边的数字诉求都进得来', () => {
    const items = [
      { text: 长总监, role: '总监', rounds: [1] },
      { text: 长架构, role: '架构', rounds: [1] },
    ]
    const s = planFeedbackPrompt(items)
    expect(长总监.length).toBeGreaterThan(MAX_ITEM_CHARS)
    expect(长架构.length).toBeGreaterThan(MAX_ITEM_CHARS)
    // 变异探针:把 itemBudget 换回写死的 MAX_ITEM_CHARS,这两条当场红。
    expect(s, '总监那条的「改为 13 个」被截掉了').toContain('改为 13 个')
    expect(s, '架构那条的「修正为实际值 7」被截掉了').toContain('修正为实际值 7')
  })

  it('裁决员那一侧同样看得见 —— 3c 要求它比对的正是这两个值', () => {
    const s = reviewRepeatNotice([
      { text: 长总监, role: '总监', rounds: [1] },
      { text: 长架构, role: '架构', rounds: [1] },
    ], 2)
    expect(s).toContain('改为 13 个')
    expect(s).toContain('修正为实际值 7')
  })

  it('满载 20 条时预算退回下界,整段仍守着 MAX_SUMMARY_CHARS', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: 'x'.repeat(3000), role: `r${i}`, rounds: [1] }))
    expect(itemBudget(20)).toBeGreaterThanOrEqual(MAX_ITEM_CHARS)
    expect(planFeedbackPrompt(many).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
  })

  it('单条时也不会超过单条阻断意见本身的上限', () => {
    expect(itemBudget(1)).toBeLessThanOrEqual(2000)
  })
})

describe('exhaustionReason —— 撤回过的账不许静默消失', () => {
  it('触顶时说得出「另有 N 条被撤回」并指路 node.md', () => {
    const log = [
      rec({ round: 1, verdicts: [v({ role: '总监', blocking: ['一条老意见'] })] }),
      rec({ round: 2, verdicts: [v({ role: '架构', pass: true, blocking: [], retracted: ['一条老意见'] })] }),
    ]
    expect(retractedCount(log)).toBe(1)
    const why = exhaustionReason(feedbackItems(log), 3, retractedCount(log))
    expect(why).toContain('另有 1 条意见在过程中被撤回')
    expect(why).toContain('node.md')
  })

  it('没有撤回时一个字都不多说', () => {
    expect(exhaustionReason([{ text: 'a', role: 'r', rounds: [1] }], 3, 0)).not.toContain('被撤回')
  })

  it('infra 席位的 retracted 不计数', () => {
    expect(retractedCount([rec({ verdicts: [v({ infra: true, retracted: ['x'] })] })])).toBe(0)
  })
})

describe('reviewRepeatNotice —— 两条限定语与跨席位提醒的顺序', () => {
  const 两席 = [
    { text: '把 14 改成 7', role: '架构', rounds: [1] },
    { text: '把 E 改成 13', role: '总监', rounds: [1] },
  ]
  const 单席 = [{ text: '把 14 改成 7', role: '架构', rounds: [1] }]

  it('跨席位提醒只在条目跨 ≥2 个席位时出现', () => {
    expect(reviewRepeatNotice(两席, 2)).toContain('来自**不同席位**')
    expect(reviewRepeatNotice(单席, 2)).not.toContain('来自**不同席位**')
  })

  /**
   * 落点必须是 blocking / retracted,**不能是 comments**。
   *
   * `synthesizeVerdicts` 只在「pass 为 false 且 blocking 为空」时才回落到 comments,而
   * `feedbackItems` 只读 `v.blocking` —— 一个判 pass 的裁决员把核出来的正确值写进 comments,
   * 作者永远看不到。事故里这一幕真的发生过:第 2 轮架构席 pass、blocking 空,而「上一版的
   * 14 恰好是正确的全仓总数」就躺在它的 comments 里。
   */
  it('跨席位提醒把落点指向 blocking / retracted,而不是 comments', () => {
    const s = reviewRepeatNotice(两席, 2)
    expect(s).toContain('写进你自己的 blocking')
    expect(s).toContain('"retracted"')
    expect(s).toContain('只写进 comments 的话它到不了')
  })

  it('第 1 轮什么都不说 —— 那时还没有历史', () => {
    expect(reviewRepeatNotice(两席, 1)).toBe('')
  })

  /**
   * 位置是这两条限定语的**全部意义**。
   *
   * 「若仍未回应,请指出缺了什么」是一条**无条件**的追责指令,而这两段都是对它的限定 ——
   * 排在它前面的话,它们会被读成并列的前置规则,随后被那句无条件句覆盖。跨档限定语当初
   * 就是为这件事写的(见 reviewConvergence.ts 里那段注释),举证限定语同理。
   */
  it('举证限定语排在那句无条件追责**之后**', () => {
    const s = reviewRepeatNotice(单席, 2)
    expect(s.indexOf('事实前提有误')).toBeGreaterThan(s.indexOf('若仍未回应'))
  })

  it('跨档限定语仍然排在那句无条件追责之后', () => {
    const s = reviewRepeatNotice([{ text: 'x', role: 'a', rounds: [1], strictness: '专家' as const }], 2, '评审', '方案', '初级')
    expect(s).toContain('先按**本轮**判据重新掂量')
    expect(s.indexOf('先按**本轮**判据重新掂量')).toBeGreaterThan(s.indexOf('若仍未回应'))
  })

  it('跨席位提醒排在最后,不打断上面那两条限定语与无条件句的相邻关系', () => {
    const s = reviewRepeatNotice(
      [{ text: 'x', role: 'a', rounds: [1], strictness: '专家' as const }, { text: 'y', role: 'b', rounds: [1] }],
      2, '评审', '方案', '初级',
    )
    expect(s.indexOf('来自**不同席位**')).toBeGreaterThan(s.indexOf('先按**本轮**判据重新掂量'))
  })

  it('执行侧的主语跟着 subject 换 —— 测试验证员手上没有「作者」', () => {
    expect(reviewRepeatNotice(单席, 2, '验收', '这一版产出')).toContain('执行者举证说')
    expect(reviewRepeatNotice(单席, 2)).toContain('作者举证说')
  })
})

// ── 端到端:提示词真的到达模型调用 ───────────────────────────────────────────
const ctxFor = (nodes: TaskNode[], runAgent: RunAgentFn, config: EffTaskConfig): PipelineCtx => ({
  config, byId: byIdMap(nodes), runAgent, persist: async () => {}, now: () => NOW,
  signal: new AbortController().signal, onUpdate: () => {},
  reserveNodes: () => ({ release: () => {} }),
})
const cfg = (over: Partial<EffTaskConfig['caps']> = {}): EffTaskConfig => ({
  goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: '' }] },
  caps: { ...DEFAULT_CAPS, ...over },
})
const vtag = (req: { prompt: string }): string => '```' + (req.prompt.match(/```(verdict[a-z]+)/)?.[1] ?? 'verdict')
const PASS = '\n{"pass":true,"blocking":[],"comments":""}\n```'

/**
 * 把**四个**裁决关口的提示词都真的跑出来。
 *
 * 验收查出 `integratePrompt` 一个用例都没有 —— 删掉它那一处 `EVIDENCE_RULE` 或 retracted
 * 字段,全仓 2171 条测试一条都不红。四关共用的规则要有四关的探针,否则「四个关口」这句话
 * 只有三个关口在担保。
 */
async function promptsFromRun(): Promise<{ review: string; judged: string[] }> {
  const seen: { phase: string; prompt: string }[] = []
  const runAgent: RunAgentFn = async req => {
    seen.push({ phase: req.phase, prompt: req.prompt })
    if (req.phase === 'plan') return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
    if (req.phase === 'execute') return '```exec\n{"execStatus":"做完了"}\n```'
    return vtag(req) + PASS
  }
  const judging = { verify: [{ roleName: '' }], accept: [{ roleName: '' }], integrate: [{ roleName: '' }] }
  // 叶子:走 review(stepStart)与 verify/accept(stepExecute)。
  const leaf = mk({
    kind: 'executable', status: 'PLANNING',
    phaseRoles: { ...emptyPhaseRoles(), review: [{ roleName: '' }], ...judging },
  } as Partial<TaskNode>)
  await stepStart(leaf, ctxFor([leaf], runAgent, cfg()))
  leaf.status = 'READY'
  await stepExecute(leaf, ctxFor([leaf], runAgent, cfg()))
  // 父节点:走 integrate(stepIntegrate)。子任务必须是已验收的,否则那一关不开。
  const child = mk({
    id: 'c1', title: '子', parentId: 'root', status: 'ACCEPTED', kind: 'executable',
    execStatus: '子任务做完了', plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' },
  } as Partial<TaskNode>)
  const parent = mk({
    kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['c1'],
    phaseRoles: { ...emptyPhaseRoles(), ...judging },
    plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: '父验收点' },
  } as Partial<TaskNode>)
  await stepIntegrate(parent, ctxFor([parent, child], runAgent, cfg()))
  const review = seen.find(s => s.phase === 'review')!
  expect(review, 'review 没被派出去').toBeDefined()
  const judged = seen.filter(s => s.phase !== 'plan' && s.phase !== 'execute').map(s => s.prompt)
  return { review: review.prompt, judged }
}

describe('端到端:取证责任进了四个裁决关口', () => {
  const 取证句 = '结论不能超出你核过的范围'

  it('质疑讨论:取证段在场,且 schema 里有 retracted', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
        : vtag(req) + PASS
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const review = seen.find(p => p.includes('请评审'))!
    expect(review).toContain(取证句)
    expect(review).toContain('"retracted"')
    // 取证段必须**排在判据之后**(紧挨 schema),不能落在提示词第一段 —— 一条不该被覆盖的
    // 规则待在开头,就会被后面那些「能达到这条就判通过」压掉。
    expect(review.indexOf(取证句)).toBeGreaterThan(review.indexOf('判据:'))
    expect(review.indexOf(取证句)).toBeLessThan(review.indexOf('输出 json'))
  })

  /**
   * 事故里那位评审的 blocking 逐字就是 `REVIEW_FLOOR` 第 2 条(方案说 `api/v3rpc` 下有
   * .proto,而那里确实没有)。所以取证段**绝不能**写成「取不到证的就别放进 blocking」——
   * 那会把 floor 第 2 条(一条拿 P0 换来的闸门)拆掉。这条用例钉的就是两者并存。
   */
  it('取证段与 REVIEW_FLOOR 第 2 条并存,没有把 floor 拆掉', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
        : vtag(req) + PASS
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg({ strictness: '中级' })))
    const review = seen.find(p => p.includes('请评审'))!
    expect(review).toContain('你在它给出的落点(文件/函数/命令)上找不到对应的东西')
    expect(review).toContain('pass 一律为 false')
    expect(review).toContain(取证句)
    // 而且取证段自己保住了那条:「找不到某个东西」照样能提,只是要说清找过哪里。
    expect(review).toContain('这不是要你放过它,是要你说准')
  })

  /**
   * **四关都要有探针。** 验收实测:删掉 `integratePrompt` 里的 `EVIDENCE_RULE` 或它的
   * retracted 字段,全仓 2171 条测试一条都不红 —— 那一关此前是零覆盖的。
   */
  it('四个裁决关口(含集成验收)都拿到取证段与 retracted,且都排在 schema 之前', async () => {
    const { review, judged } = await promptsFromRun()
    expect(judged.length, '裁决关口一个都没跑起来').toBeGreaterThanOrEqual(3)
    for (const p of [review, ...judged]) {
      expect(p).toContain(取证句)
      expect(p).toContain('"retracted"')
      expect(p.indexOf(取证句)).toBeLessThan(p.indexOf('"retracted"'))
    }
    // 集成验收那一关**确实**在这批里 —— 否则上面的循环可能只覆盖了三关。
    expect(judged.some(p => p.includes('父目标')), '集成验收没被派出去,四关只测到三关').toBe(true)
  })

  it('测试验证 / 验收:取证段与 retracted 都在场', async () => {
    const seen: { phase: string; prompt: string }[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push({ phase: req.phase, prompt: req.prompt })
      if (req.phase === 'execute') return '```exec\n{"execStatus":"做完了"}\n```'
      return vtag(req) + PASS
    }
    // 席位要同时挂在**节点**上 —— 派谁读的是 node.phaseRoles,config 那份只是名册来源。
    const roles = { ...emptyPhaseRoles(), verify: [{ roleName: '' }], accept: [{ roleName: '' }] }
    const n = mk({
      kind: 'executable', status: 'READY', phaseRoles: roles,
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: '跑 x 看到 y' },
    } as Partial<TaskNode>)
    const config = cfg()
    config.phaseRoles.verify = [{ roleName: '' }]
    config.phaseRoles.accept = [{ roleName: '' }]
    await stepExecute(n, ctxFor([n], runAgent, config))
    for (const phase of ['verify', 'accept']) {
      const p = seen.find(s => s.phase === phase)
      expect(p, `${phase} 这一关没有被派出去,断言落空了`).toBeDefined()
      expect(p!.prompt).toContain(取证句)
      expect(p!.prompt).toContain('"retracted"')
    }
  })
})

describe('端到端:「前提有误」的接盘规则', () => {
  const 判据句 = '判据是**它的结论成不成立**,不是它给的命令能不能重现'

  it('执行侧的答卷带着接盘规则 —— 它进的是 verify/accept,不是评审', async () => {
    const seen: { phase: string; prompt: string }[] = []
    let round = 0
    const runAgent: RunAgentFn = async req => {
      seen.push({ phase: req.phase, prompt: req.prompt })
      if (req.phase === 'execute') return '```exec\n{"execStatus":"做完了","responses":["第 1 条 → 前提有误:我跑了 X"]}\n```'
      round++
      // 第一轮验收挡一次,好让第二轮的提示词里出现「上一轮的答卷」。
      return round === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["缺回滚方案"],"comments":""}\n```'
        : vtag(req) + PASS
    }
    // 席位要同时挂在**节点**上 —— 派谁读的是 node.phaseRoles,config 那份只是名册来源。
    const roles = { ...emptyPhaseRoles(), verify: [{ roleName: '' }], accept: [{ roleName: '' }] }
    const n = mk({
      kind: 'executable', status: 'READY', phaseRoles: roles,
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: '跑 x 看到 y' },
    } as Partial<TaskNode>)
    const config = cfg()
    config.phaseRoles.verify = [{ roleName: '' }]
    await stepExecute(n, ctxFor([n], runAgent, config))
    const withAnswers = seen.filter(s => s.prompt.includes('执行者对上一轮阻断意见的逐条处置'))
    expect(withAnswers.length, '没有任何一关拿到执行者的答卷').toBeGreaterThan(0)
    for (const p of withAnswers) expect(p.prompt).toContain(判据句)
  })

  it('执行侧的 responses 格式给了三种写法,第三种要范围', async () => {
    const seen: string[] = []
    let round = 0
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      if (req.phase === 'execute') return '```exec\n{"execStatus":"做完了"}\n```'
      round++
      return round === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["缺回滚方案"],"comments":""}\n```'
        : vtag(req) + PASS
    }
    // 席位要同时挂在**节点**上 —— 派谁读的是 node.phaseRoles,config 那份只是名册来源。
    const roles = { ...emptyPhaseRoles(), verify: [{ roleName: '' }], accept: [{ roleName: '' }] }
    const n = mk({
      kind: 'executable', status: 'READY', phaseRoles: roles,
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: '跑 x 看到 y' },
    } as Partial<TaskNode>)
    const config = cfg()
    config.phaseRoles.verify = [{ roleName: '' }]
    await stepExecute(n, ctxFor([n], runAgent, config))
    const rework = seen.filter(p => p.includes('请针对性返工'))
    expect(rework.length, '没有发生返工,断言落空了').toBeGreaterThan(0)
    expect(rework[0]).toContain('前提有误')
    expect(rework[0]).toContain('它覆盖的范围是')
  })

  it('评审侧:没有答卷时接盘规则不在场 —— 对着一份不存在的答卷立规矩是这道门要挡的事', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
        : vtag(req) + PASS
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const review = seen.find(p => p.includes('请评审'))!
    expect(review).not.toContain(判据句)
  })

  /**
   * **这条用例被重写过一次,原因值得记住。**
   *
   * 第一版写的是 `expect(判据句).not.toContain('不要再提')` —— 而 `判据句` 是这个文件自己
   * 定义的字符串字面量,和生产代码没有任何数据依赖。也就是**恒真**。验收实跑证明了这件事:
   * 把封口令原样写回 `REBUTTAL_RULE`,33 条用例一条都不红。
   *
   * 一条假探针比没有探针更糟:它让「这里有防线」这句话看起来是被验证过的。现在断言打在
   * **实跑出来的提示词**上。
   */
  it('封口令没有回来 —— 「不要再提」叠上 repeatRule 等于永久移出可提范围', async () => {
    const { review, judged } = await promptsFromRun()
    for (const p of [review, ...judged]) {
      expect(p).not.toContain('不要再提')
      expect(p).not.toContain('就此作废')
    }
    // 正向:接盘规则真的出现的那条路径上(有返工、有答卷),给的是「不再计入未回应」,
    // 并明说不妨碍就同一处提新意见。一次顺利跑完的运行里它**不该**在场,所以要单独驱动。
    const seen: string[] = []
    let round = 0
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      if (req.phase === 'execute') return '```exec\n{"execStatus":"做完了","responses":["第 1 条 → 前提有误:我跑了 X"]}\n```'
      round++
      return round === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["缺回滚方案"],"comments":""}\n```'
        : vtag(req) + PASS
    }
    const roles = { ...emptyPhaseRoles(), verify: [{ roleName: '' }] }
    const n = mk({
      kind: 'executable', status: 'READY', phaseRoles: roles,
      plan: { solution: 's', keyPoints: 'k', risks: 'r', acceptance: '跑 x 看到 y' },
    } as Partial<TaskNode>)
    const config = cfg()
    config.phaseRoles.verify = [{ roleName: '' }]
    await stepExecute(n, ctxFor([n], runAgent, config))
    const withRule = seen.find(p => p.includes(判据句))
    expect(withRule, '返工路径上没有任何一关拿到接盘规则').toBeDefined()
    expect(withRule!).toContain('不再把它计入')
    expect(withRule!).toContain('**你自己核过的**新意见')
    expect(withRule!).not.toContain('不要再提')
  })

  it('评审侧:有答卷时接盘规则在场(正向探针 —— 反向那条在规则整段删掉时反而更容易过)', async () => {
    const seen: string[] = []
    let round = 0
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      if (req.phase === 'plan') {
        return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿",' +
          '"responses":["第 1 条 → 前提有误:我跑了 find api/"]}\n```'
      }
      round++
      return round === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["proto 总数应改为 13"],"comments":""}\n```'
        : vtag(req) + PASS
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const withAnswers = seen.filter(p => p.includes('方案里的 responses 是作者对上一轮意见的逐条处置'))
    expect(withAnswers.length, '第 2 轮评审没拿到作者的答卷').toBeGreaterThan(0)
    for (const p of withAnswers) expect(p).toContain(判据句)
  })

  /**
   * `--resume` 之后的**第一轮**也要拿到累积反馈与跨席位提醒。
   *
   * `stepStart` 里那行播种原来是 `lastFailureFeedback(node.reviewLog)`,直接取
   * `synthesized.blockingSummary` —— 绕过 `feedbackItems` / `planFeedbackPrompt` /
   * `crossSeatNotice` 全部三样。而一个跑到会被 resume 的运行,恰恰是轮次已经烧掉一些、
   * 最需要这三样的那种。
   */
  it('--resume 播种:第一份方案提示词就带着分组与跨席位提醒', async () => {
    const seen: string[] = []
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      return req.phase === 'plan'
        ? '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿","responses":["第 1 条 → …"]}\n```'
        : vtag(req) + PASS
    }
    // 盘上已经有一轮两席都不通过的记录 —— 这正是 --resume 回来时的形状。
    const n = mk({
      kind: 'executable', status: 'PLANNING',
      reviewLog: [rec({
        round: 1,
        verdicts: [v({ role: '总监', blocking: [总监原文] }), v({ role: '架构', blocking: [架构原文] })],
        synthesized: { pass: false, blockingSummary: `[总监] ${总监原文}; [架构] ${架构原文}` },
      })],
    })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const first = seen.find(p => p.includes('上一版方案(就是它需要被修订)'))
    expect(first, '第一份方案提示词没带上历史意见').toBeDefined()
    expect(first!, '跨席位提醒没进播种路径').toContain('2 个席位')
    expect(first!, '累积反馈的分组没进播种路径').toContain('【只被提过一轮】')
  })

  it('作者侧(planPrompt)的 responses 格式给了三种写法,第三种要范围', async () => {
    const seen: string[] = []
    let round = 0
    const runAgent: RunAgentFn = async req => {
      seen.push(req.prompt)
      if (req.phase === 'plan') return '```json\n{"solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      round++
      return round === 1
        ? vtag(req) + '\n{"pass":false,"blocking":["proto 总数应改为 13"],"comments":""}\n```'
        : vtag(req) + PASS
    }
    const n = mk({ kind: 'executable', status: 'PLANNING' })
    await stepStart(n, ctxFor([n], runAgent, cfg()))
    const revise = seen.filter(p => p.includes('上一版方案(就是它需要被修订)'))
    expect(revise.length, '没有发生方案返工,断言落空了').toBeGreaterThan(0)
    expect(revise[0]).toContain('前提有误')
    expect(revise[0]).toContain('它覆盖的范围是')
  })
})
