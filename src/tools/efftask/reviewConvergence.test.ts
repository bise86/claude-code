import { describe, expect, it } from 'bun:test'
import type { RoundtableRecord, Verdict } from './types.js'
import { MAX_SUMMARY_CHARS } from './parseOutput.js'
import {
  exhaustionReason,
  exhaustionRemedy,
  feedbackItems,
  normalizeItem,
  planFeedbackPrompt,
  reviewRepeatNotice,
  similarItem,
  stuckItems,
  MAX_FEEDBACK_ITEMS,
  type FeedbackItem,
} from './reviewConvergence.js'

const v = (role: string, blocking: string[], over: Partial<Verdict> = {}): Verdict =>
  ({ role, pass: blocking.length === 0, blocking, comments: '', ...over }) as Verdict

const round = (n: number, verdicts: Verdict[]): RoundtableRecord =>
  ({ round: n, verdicts, synthesized: { pass: false, blockingSummary: '' } }) as RoundtableRecord

describe('normalizeItem', () => {
  it('去空白、去中英标点、小写、全角转半角', () => {
    expect(normalizeItem(' A/B ,测试。 ')).toBe(normalizeItem('ab测试'))
    expect(normalizeItem('ＡＢＣ')).toBe('abc')
  })
  it('纯标点和纯空白归一成空', () => {
    expect(normalizeItem('……')).toBe('')
    expect(normalizeItem('   ')).toBe('')
    expect(normalizeItem('')).toBe('')
  })
  it('非字符串不炸', () => {
    expect(normalizeItem(undefined as unknown as string)).toBe('')
    expect(normalizeItem(123 as unknown as string)).toBe('')
  })
})

describe('similarItem', () => {
  it('同一条换个说法算重复', () => {
    expect(similarItem('评分等级与分数的映射规则未定义', '评分等级到分数的映射规则没有定义')).toBe(true)
  })

  it('只差标点和空格算重复', () => {
    expect(similarItem('缺少回滚方案', '缺少回滚方案。')).toBe(true)
  })

  it('**已知的误判**:同一个模板里换了内容的两条会被判成重复', () => {
    // 这不是遗漏,是记录在案的边界。实测:该判重复的改写只有 0.526,而这两条不该判重复的
    // 反而是 0.786 / 0.733 —— 该判的分数**更低**,没有任何阈值能分开它们。
    //
    // 之所以能忍:下游措辞被写成「误判也无害」的形状。评审提示词不说「已提过,请判通过」,
    // 触顶话术两个分支给的都是「先确认」。所以一次误判最多多一句废话,不改变裁决。
    // 这条测试在这里是为了:有人调阈值时,它会诚实地变红,逼他重新读那段权衡。
    expect(similarItem('本方案未说明当上游服务返回超时时的重试策略与退避算法', '本方案未说明当上游服务返回错误时的重试策略与退避算法')).toBe(true)
    expect(similarItem('验收标准第 3 条未定义具体阈值', '验收标准第 4 条未定义具体阈值')).toBe(true)
  })

  it('两条明显不同的意见不算重复', () => {
    expect(similarItem('没有并发上限', '缺少回滚方案')).toBe(false)
    expect(
      similarItem('评分等级(A/B/C/D)与具体分数的映射规则未定义', '维度内多个检查点的分数汇总逻辑缺失'),
    ).toBe(false)
  })

  it('短串包含长串**不算**重复 —— 否则短意见会把长意见整条吞掉', () => {
    // 「缺少回滚方案」和「缺少回滚方案的验证步骤,且回滚脚本未提供」是两条。没有长度下限
    // 的「互相包含」规则会把它们合并,于是第二条永远不会被当成新意见。
    expect(similarItem('缺少回滚方案', '缺少回滚方案的验证步骤,且回滚脚本未提供,发布后无法回退')).toBe(false)
  })

  it('长度够但占比太小的包含也不算重复', () => {
    // 长度下限单独一条挡不住:一条 10 字的意见被一条 40 字的意见包含时,长度过了关,
    // 但那显然是「一条简短的」和「一条展开说的另一件事」。占比这一维才挡得住。
    const short = '缺少灰度发布方案'
    const long = '缺少灰度发布方案的具体步骤、回滚脚本、观测指标,以及失败时由谁决策的说明,整体需要重写'
    expect(long.includes(short)).toBe(true)
    expect(similarItem(short, long)).toBe(false)
  })

  it('归一后为空的条目不匹配任何东西', () => {
    // parseOutput 只滤空串,`"   "` 和 `"……"` 活得下来。而空串是任何字符串的子串 ——
    // 不挡的话,一条纯标点的阻断项会把全部意见合并成一组「连续 N 轮未解决」。
    for (const junk of ['', '   ', '……', '。。。']) {
      expect(`「${junk}」匹配了正常意见: ${similarItem(junk, '缺少回滚方案')}`).toBe(`「${junk}」匹配了正常意见: false`)
      expect(similarItem(junk, junk)).toBe(false)
    }
  })

  it('自反、对称', () => {
    const a = '评分等级与分数的映射规则未定义'
    const b = '评分等级到分数的映射规则没有定义'
    expect(similarItem(a, a)).toBe(true)
    expect(similarItem(a, b)).toBe(similarItem(b, a))
  })
})

describe('feedbackItems —— 从结构化 verdicts 取,不拆拼接串', () => {
  it('同一条意见跨轮出现只留一条,记下它出现在哪几轮', () => {
    const items = feedbackItems([
      round(1, [v('main', ['评分等级与分数的映射规则未定义'])]),
      round(2, [v('main', ['评分等级到分数的映射规则没有定义'])]),
      round(3, [v('main', ['评分等级与分数的映射规则未定义', '缺少回滚方案'])]),
    ])
    expect(items).toHaveLength(2)
    expect(items[0]!.rounds).toEqual([1, 2, 3])
    expect(items[1]!.rounds).toEqual([3])
  })

  it('同一轮里两位评审提同一条,只算这一轮一次', () => {
    // 不去重的话,rounds 会变成 [1,1],而 stuckItems 看的是 rounds.length —— 一轮之内
    // 就被判成「连续未解决」,那是谎话。
    const items = feedbackItems([round(1, [v('甲', ['缺少回滚方案']), v('乙', ['缺少回滚方案'])])])
    expect(items).toHaveLength(1)
    expect(items[0]!.rounds).toEqual([1])
    expect(stuckItems(items)).toHaveLength(0)
  })

  it('意见正文含分号也不会被切碎 —— 这正是不拆 blockingSummary 的理由', () => {
    // synthesizeVerdicts 用 '; ' 拼串;反过来切是有损的,用户实际撞到的那条就含冒号和引号。
    const text = "验收标准表述存在逻辑矛盾:'不低于 C 级(单项低于 3 分)'无法正确解释; 需要重写"
    const items = feedbackItems([round(1, [v('main', [text])])])
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe(text)
  })

  it('infra 失败不是意见 —— 别让方案作者去修网络', () => {
    const items = feedbackItems([
      round(1, [v('a', ['角色调用失败: ECONNRESET'], { infra: true }), v('b', ['缺少回滚方案'])]),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.role).toBe('b')
  })

  it('空白 / 纯标点的阻断项被丢掉', () => {
    const items = feedbackItems([round(1, [v('main', ['  ', '……', '真的意见'])])])
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('真的意见')
  })

  it('畸形记录不炸', () => {
    expect(feedbackItems([])).toEqual([])
    expect(feedbackItems(undefined as never)).toEqual([])
    expect(feedbackItems([{ round: 1 } as never])).toEqual([])
    expect(feedbackItems([round(1, [{ role: 'x' } as never])])).toEqual([])
    expect(feedbackItems([round(1, [v('x', [null as never, 1 as never])])])).toEqual([])
  })
})

describe('stuckItems', () => {
  it('只挑出现过两轮以上的', () => {
    const items = feedbackItems([
      round(1, [v('main', ['老账', '一次性的'])]),
      round(2, [v('main', ['老账'])]),
    ])
    const stuck = stuckItems(items)
    expect(stuck).toHaveLength(1)
    expect(stuck[0]!.text).toBe('老账')
  })
  it('minRounds 不能低于 2 —— 一轮就叫「连续未解决」是谎话', () => {
    const items = feedbackItems([round(1, [v('main', ['只提过一次'])])])
    expect(stuckItems(items, 1)).toHaveLength(0)
    expect(stuckItems(items, 0)).toHaveLength(0)
  })
})

describe('planFeedbackPrompt —— 方案作者要同时看到所有轮次', () => {
  const items = feedbackItems([
    round(1, [v('main', ['映射规则未定义'])]),
    round(2, [v('main', ['映射规则未定义'])]),
    round(3, [v('main', ['映射规则未定义', '验收标准自相矛盾'])]),
  ])

  it('老账和新账分开列', () => {
    const p = planFeedbackPrompt(items)
    expect(p).toContain('被提过不止一轮')
    expect(p).toContain('映射规则未定义')
    expect(p).toContain('只被提过一轮')
    expect(p).toContain('验收标准自相矛盾')
    // 分组标题要经得起核对:每条都带出现轮次,读的人能自己数。
    expect(p).toContain('(第 1、2、3 轮)')
  })

  it('要求逐条回应 —— 只列出来不说要干什么,作者还是会挑软的捏', () => {
    expect(planFeedbackPrompt(items)).toContain('逐条')
  })

  it('没有老账时不编一个「连续未解决」出来', () => {
    const p = planFeedbackPrompt(feedbackItems([round(1, [v('main', ['第一次提'])])]))
    expect(p).not.toContain('不止一轮')
    expect(p).toContain('只被提过一轮')
  })

  it('没有意见时是空串,不是一段空模板', () => {
    expect(planFeedbackPrompt([])).toBe('')
  })
})

describe('reviewRepeatNotice —— 评审员此前完全看不到历史', () => {
  const items = feedbackItems([
    round(1, [v('main', ['映射规则未定义'])]),
    round(2, [v('main', ['映射规则未定义'])]),
  ])

  it('带上轮次号和每条意见出现过的轮次', () => {
    const n = reviewRepeatNotice(items, 3)
    expect(n).toContain('第 3 轮')
    expect(n).toContain('映射规则未定义')
    expect(n).toContain('第 1、2 轮')
  })

  it('措辞不推着评审员放行 —— 相似度会误判,一句假话不能换一个通过', () => {
    // 写成「已经提过,若已回应请判通过」就是在用「这条是老账」的判断去换裁决,而那个
    // 判断本身可能是错的(字符 n-gram 分不开「换说法的同一条」和「同模板的另一条」)。
    const n = reviewRepeatNotice(items, 3)
    expect(n).not.toContain('请判通过')
    expect(n).toContain('哪一处')
    expect(n).toContain('不要仅因为措辞眼熟就放行')
  })

  it('第一轮没有历史可讲', () => {
    expect(reviewRepeatNotice(items, 1)).toBe('')
    expect(reviewRepeatNotice([], 3)).toBe('')
  })
})

describe('触顶时的话要说准', () => {
  const stuckCase = feedbackItems([
    round(1, [v('main', ['映射规则未定义'])]),
    round(2, [v('main', ['映射规则未定义'])]),
    round(3, [v('main', ['映射规则未定义', '新问题'])]),
  ])
  const movingCase = feedbackItems([
    round(1, [v('main', ['第一个问题'])]),
    round(2, [v('main', ['完全不同的第二个问题'])]),
    round(3, [v('main', ['再换一个第三个问题'])]),
  ])

  it('reason 点名哪几条是一直没解决的', () => {
    const r = exhaustionReason(stuckCase, 3)
    expect(r).toContain('评审迭代超限(3)')
    expect(r).toContain('被提过不止一轮')
    expect(r).toContain('映射规则未定义')
    expect(r).toContain('只被提过一轮')
  })

  it('每轮都换意见时不谎称有老账', () => {
    const r = exhaustionReason(movingCase, 3)
    expect(r).not.toContain('不止一轮')
    expect(r).toContain('只被提过一轮 3 条')
  })

  it('没有任何意见时只报超限,不拼一个空冒号', () => {
    expect(exhaustionReason([], 3)).toBe('评审迭代超限(3)')
  })

  it('remedy 按事实分叉', () => {
    expect(exhaustionRemedy(stuckCase)).toContain('被提过不止一轮')
    expect(exhaustionRemedy(stuckCase)).toContain('--retry-blocked')
    expect(exhaustionRemedy(movingCase)).toContain('扩大范围')
    expect(exhaustionRemedy(movingCase)).toContain('caps.maxIterations')
  })

  it('两个分支都是「先确认」而不是相反的指令 —— 误判时也不能把人指反', () => {
    // 相似度会误判。在运行刚被打死那一刻给出方向相反的行动建议,比不给建议更糟。
    expect(exhaustionRemedy(stuckCase)).toContain('先确认')
    // 有老账的分支也**不能**把「提高 maxIterations」这条路堵死:万一是误判呢。
    expect(exhaustionRemedy(stuckCase)).toContain('caps.maxIterations')
  })
})

describe('提示词有预算 —— 累积反馈不能绕过原来的上限', () => {
  // 单条阻断意见上限 2000 字、每席最多 20 条,5 席 × 3 轮 = 300 条。不设上限的话这一段
  // 能把方案提示词顶到 600 KB。原来的 blockingSummary 走的是 capText(…, MAX_SUMMARY_CHARS);
  // 换成累积反馈时如果不接上同一个预算,就是**绕过**了它。
  const huge = (): FeedbackItem[] =>
    [...Array(300)].map((_, i) => ({ text: `第${i}条意见`.padEnd(2000, '啊'), role: 'main', rounds: i < 40 ? [1, 2] : [3] }))

  it('planFeedbackPrompt 有字符预算,并说清丢了多少', () => {
    const p = planFeedbackPrompt(huge())
    // capText 截断时会补一句「…(已截断,原文 N 字)」,所以上限要留出它的长度。
    expect(Array.from(p).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
    expect(p).toContain('300 条')
  })

  it('条数也有上限,而且**老账优先**保留', () => {
    const p = planFeedbackPrompt(huge())
    const listed = (p.match(/^ {2}\d+\. /gm) ?? []).length
    expect(listed).toBeLessThanOrEqual(MAX_FEEDBACK_ITEMS)
    // 保下来的必须是连续多轮的那些 —— 新增的下一轮还会再提,老账才是作者一直没回应的。
    expect(p).toContain('不止一轮')
    // 「你看到的不是全部」这句话必须**在最前面**。放在列表末尾的话,它会被整段的
    // 字符预算连同后面的条目一起截掉 —— 于是用户看到一份看起来完整的短清单。
    expect(p).toContain('未列出')
    expect(p.indexOf('未列出')).toBeLessThan(p.indexOf('1. ['))
  })

  it('reviewRepeatNotice 同样有预算 —— 它进的是每一个席位的提示词,5 席就是 5 份', () => {
    const n = reviewRepeatNotice(huge(), 3)
    expect(Array.from(n).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
    expect(n).toContain('未列出')
  })

  it('exhaustionReason 同样有预算 —— 它原样进 node.blockedReason', () => {
    const r = exhaustionReason(huge(), 3)
    expect(Array.from(r).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
  })

  it('没超预算时不加任何「未列出」的噪音', () => {
    const few: FeedbackItem[] = [{ text: '就一条', role: 'main', rounds: [1] }]
    expect(planFeedbackPrompt(few)).not.toContain('未列出')
    expect(exhaustionReason(few, 3)).not.toContain('未列出')
  })
})

describe('预算是怎么花的', () => {
  const bigItems = (n: number, chars: number): FeedbackItem[] =>
    [...Array(n)].map((_, i) => ({ text: `第${i}条`.padEnd(chars, '啊'), role: 'main', rounds: [1, 2] }))

  it('单条先缩,20 条才都看得见 —— 否则第二条就把整段预算吃光', () => {
    // 单条阻断意见上限是 2000 字。只做整段截断的话,20 条里只有前两条露面,而用户看到的
    // 是一份**看起来完整**的两条清单。
    const p = planFeedbackPrompt(bigItems(20, 2000))
    const listed = (p.match(/^ {2}\d+\. /gm) ?? []).length
    expect(`列出的条数: ${listed >= 10}`).toBe('列出的条数: true')
  })

  it('整段仍有硬预算 —— role 之类的字段没有单独的上限', () => {
    // 条数上限 + 单条上限算出来是够的,但那是在「其余字段都很短」的前提下。role 是模型/
    // 配置来的,没人截过它。整段那道 capText 是兜住这类情况的最后一道。
    const nasty: FeedbackItem[] = [...Array(20)].map((_, i) => ({
      text: `第${i}条`, role: 'x'.repeat(5000), rounds: [1, 2],
    }))
    expect(Array.from(planFeedbackPrompt(nasty)).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
    expect(Array.from(exhaustionReason(nasty, 3)).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
    expect(Array.from(reviewRepeatNotice(nasty, 3)).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 40)
  })
})

/**
 * `label` / `subject` 两个参数 —— 评审点名的**存活变异**:把 `${subject}` 全换回硬编码
 * 「方案」,294 条测试全绿。而这两个参数正是「把方案圆桌那份药给另外三关」的全部内容:
 * 一个测试验证员读到「若新**方案**已经回应了它」时,手上根本没有方案要评。
 */
describe('换一关用时,措辞跟着换', () => {
  const items = feedbackItems([
    round(1, [v('tester', ['auth.test.ts:42 期望 200 实际 500'])]),
    round(2, [v('tester', ['auth.test.ts:42 期望 200 实际 500'])]),
  ])

  it('reviewRepeatNotice 的关名和判的东西都跟着参数走', () => {
    const n = reviewRepeatNotice(items, 3, '测试验证', '这一版产出')
    expect(n).toContain('第 3 轮测试验证')
    expect(n).toContain('若新这一版产出已经回应了它')
    // 默认那一份仍然说「评审 / 方案」——老调用点一个字都不变
    expect(n).not.toContain('轮评审')
    expect(n).not.toContain('若新方案')
  })

  it('planFeedbackPrompt 的关名跟着参数走', () => {
    expect(planFeedbackPrompt(items, '测试验证/验收')).toContain('轮测试验证/验收共提出')
    expect(planFeedbackPrompt(items)).toContain('轮评审共提出')
  })
})
