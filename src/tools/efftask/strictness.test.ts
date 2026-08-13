import { describe, expect, test } from 'bun:test'
import {
  adjustStrictness, isStrictness, quorumSeatsNeeded, resolvedQuorum, reviewFixRubric,
  strictnessBlock, STRICTNESS_JUDGING, STRICTNESS_LEVELS, STRICTNESS_QUORUM, verifyFixRequirement,
} from './strictness.js'
import { synthesizeVerdicts } from './roundtable.js'
import { DEFAULT_CAPS, type Caps, type Verdict } from './types.js'

const caps = (over: Partial<Caps> = {}): Caps => ({ ...DEFAULT_CAPS, ...over })

describe('不设档 = 缺省那一份', () => {
  /**
   * 「不设档 = 逐字节相同」这条承诺**对两个修复关口已经不成立了** —— 它们的职责整个换了
   * (不再判决,直接改),缺省文本也就跟着换了。承诺仍然对**验收 / 集成验收**成立,
   * 那两关由下面「地板与档位无关」和 strictnessWiring 的端到端用例守着。
   *
   * 这里守的是另一件事:缺省档的文本是**它自己那一份**,不带任何档位字样 ——
   * 合并成一份的话,下一个人改中级档会静默改掉缺省行为。
   */
  test('reviewFixRubric 缺省档讲「该改什么」,且不含任何档位字样', () => {
    const r = reviewFixRubric(undefined)
    expect(r).toContain('一定要改')
    expect(r).toContain('会让执行失败、或让产出没法验收')
    expect(r).toContain('别动')
    expect(r).not.toContain('本次严格度')
  })
  test('reviewFixRubric 不再谈轮次 —— 这一关没有「上一轮」', () => {
    for (const s of [...STRICTNESS_LEVELS, undefined]) {
      expect(reviewFixRubric(s)).not.toContain('上一轮')
      expect(reviewFixRubric(s)).not.toContain('不要提出上一轮没有提过的新要求')
    }
  })
  test('verifyFixRequirement 缺省档要求实跑 + 自己改到对', () => {
    const v = verifyFixRequirement(undefined)
    expect(v).toContain('实际执行的命令与原始输出')
    expect(v).toContain('自己改到对')
    // 而且**不再**有那句「判不通过」—— 它没有票可以投。
    expect(v).not.toContain('判不通过')
  })
  test('strictnessBlock 不设档时对每个环节都是空串', () => {
    for (const p of ['plan', 'review', 'execute', 'verify', 'accept', 'integrate', 'observer'] as const) {
      expect(strictnessBlock(undefined, p)).toBe('')
    }
  })
  test('resolvedQuorum 不设档时返回 undefined(= synthesizeVerdicts 的全票)', () => {
    expect(resolvedQuorum(caps())).toBeUndefined()
  })
})

describe('判据是替换不是叠加', () => {
  /**
   * 三份独立评审都指出的那条 P0:`brief` 在提示词最前、写死的判据在最后,追加注入会让
   * 同一命题的 P 和 ¬P 同时在场而 ¬P 在后。所以档位文本必须**替换**那几行。
   *
   * 这两条断言就是防回归的探针:任何一天有人把它改回「在原文后面追加」,缺省那几条就会
   * 重新出现在初级/专家档里。
   */
  test('初级档不含缺省那句「会让执行失败…」', () => {
    expect(reviewFixRubric('初级')).not.toContain('会让执行失败、或让产出没法验收的地方')
  })
  test('专家档不含「已经达到这条的,原样交回去」那种放行压力', () => {
    expect(reviewFixRubric('专家')).not.toContain('已经达到这条的,原样交回去')
    expect(reviewFixRubric('专家')).toContain('「能开始干」不构成不改的理由')
  })
  test('初级/中级档只要求「能跑的跑起来」,不要求既有测试不回归', () => {
    for (const s of ['初级', '中级'] as const) {
      const v = verifyFixRequirement(s)
      expect(v).not.toContain('没有引入回归')
      // 豁免必须带留痕义务:降档可以降标准,不能降留痕。
      expect(v).toContain('本节点无可执行验证手段')
    }
  })
  test('高级/专家档要求跑既有测试确认没有回归', () => {
    for (const s of ['高级', '专家'] as const) {
      expect(verifyFixRequirement(s)).toContain('没有引入回归')
    }
    // 那句「回归是你这一关的责任」只在高级档说 —— 专家档紧接着还要核对断言本身,
    // 两句叠在一起会把重点冲掉。
    expect(verifyFixRequirement('高级')).toContain('回归是你这一关的责任')
  })
  test('专家档还要核对验证手段本身证明了什么', () => {
    expect(verifyFixRequirement('专家')).toContain('把断言补上')
  })
})

describe('修复类两关的地板:讲职责,不讲通过', () => {
  test('质疑修复的地板三条,每一档都在', () => {
    for (const s of [...STRICTNESS_LEVELS, undefined]) {
      const r = reviewFixRubric(s)
      expect(r).toContain('交回一份空的、或与目标无关的方案')
      expect(r).toContain('动它之前先去看一眼')
      expect(r).toContain('只写「建议怎么改」而不改方案本身')
      // 它不出裁决,所以一个字都不许提 pass。
      expect(r).not.toContain('pass')
    }
  })
  test('测试修复的地板挡住「把测试改绿」,并给出「修不动」这条出路', () => {
    for (const s of [...STRICTNESS_LEVELS, undefined]) {
      const v = verifyFixRequirement(s)
      expect(v).toContain('删测试、放宽断言、加 skip/xfail')
      expect(v).toContain('没有第二次实跑的输出作证')
      // 不给出路的禁令等于逼它去绕。
      expect(v).toContain('修不动是允许的')
    }
  })
})

describe('地板与档位无关', () => {
  test('产出侧两关每一档都带那三条不放行', () => {
    for (const s of STRICTNESS_LEVELS) {
      for (const p of ['accept', 'integrate'] as const) {
        const b = strictnessBlock(s, p)
        expect(b).toContain('执行者没有报告任何产出')
        expect(b).toContain('找不到它做过的任何痕迹')
        expect(b).toContain('降档降的是「多好才算够」,不降「到底做没做」')
      }
    }
  })
  /**
   * 修复类两关**一条裁决地板都不收**。
   *
   * 上一版 review 有自己那份地板(产出侧那三条在评审时恒真,结论会是「pass 一律为
   * false」——设了档反而更难过)。现在它连裁决都不做了:讲「什么情况不放行」的地板对它
   * 完全不适用,而它自己的地板(不许交空方案 / 不许不核实 / 不许只提建议)在
   * `reviewFixRubric` 里,由上面那组守。
   */
  test('质疑修复 / 测试修复拿的是干活侧的档位文本,不带裁决地板', () => {
    for (const s of STRICTNESS_LEVELS) {
      for (const p of ['review', 'verify'] as const) {
        const b = strictnessBlock(s, p)
        expect(b).not.toContain('pass 一律为 false')
        expect(b).not.toContain('执行者没有报告任何产出')
      }
      // 质疑修复跟着**方案侧**走(它的产物是一份方案),测试修复跟着**执行侧**走。
      expect(strictnessBlock(s, 'review')).toBe(strictnessBlock(s, 'plan'))
      /**
       * **测试修复那一席看不到 keyPoints,所以那三个字不许出现在它眼前。**
       *
       * 两关共用执行侧文本是对的(都要动手改代码),但初级那一段点名了「方案的验收点
       * **与重点(keyPoints)**」,而 `verifyFixPrompt` 只渲染 `plan.acceptance` ——
       * 指着一份收信人手上没有的清单说「一件都不能少」,他只能猜。
       * 除了这一处,两边必须仍然逐字相同(整段分家会立刻漂移)。
       */
      expect(strictnessBlock(s, 'verify')).not.toContain('keyPoints')
      expect(strictnessBlock(s, 'verify'))
        .toBe(strictnessBlock(s, 'execute').replace('与重点(keyPoints)', ''))
    }
  })
  test('地板不出现在执行侧 —— 那是给裁决者的判据,不是给执行者的', () => {
    for (const s of STRICTNESS_LEVELS) {
      for (const p of ['plan', 'execute'] as const) {
        expect(strictnessBlock(s, p)).not.toContain('pass 一律为 false')
      }
    }
  })
})

describe('observer 不收档位文本', () => {
  /**
   * `pipeline.ts` 的 `JUDGING_PHASES` 有**五**个成员(多一个 observer),照抄它会把一段
   * 讲 blocking 的判据送进 `scorePrompt` —— 而那个提示词根本没有 blocking 字段,输出是
   * 0-100 的分数,而 `caps.scoreThreshold` 一旦设了,低分能换一轮真实的返工。
   */
  test('STRICTNESS_JUDGING 恰好是两个,不含 observer,也不含两个修复关口', () => {
    expect([...STRICTNESS_JUDGING].sort()).toEqual(['accept', 'integrate'])
    expect(STRICTNESS_JUDGING.has('observer')).toBe(false)
  })
  test('每一档下 observer 都拿到空串', () => {
    for (const s of STRICTNESS_LEVELS) expect(strictnessBlock(s, 'observer')).toBe('')
  })
})

describe('分析侧与执行侧是两份文本', () => {
  /**
   * 原来两个环节共用一份,于是分析席位收到的是「先把主路径做通」(它不写代码)、
   * 「验收点里点名的事项一件都不能少」(循环 —— 验收点正是它要写的)、「不做的写进
   * execStatus」(**它的输出 schema 里没有这个字段**)。三句全部落空。
   */
  test('分析侧不谈 execStatus、不谈「这一轮可以不做」', () => {
    for (const s of STRICTNESS_LEVELS) {
      const b = strictnessBlock(s, 'plan')
      expect(b).not.toContain('execStatus')
      expect(b).not.toContain('本轮未做')
      expect(b).not.toContain('一件都不能少')
    }
  })
  test('分析侧调的是**验收点定到多高** —— 那是这一关唯一的产物', () => {
    expect(strictnessBlock('初级', 'plan')).toContain('不必覆盖边界与错误路径')
    expect(strictnessBlock('中级', 'plan')).toContain('可执行、可观察')
    expect(strictnessBlock('专家', 'plan')).toContain('能证明目标达成')
  })
  test('两侧文本确实不同', () => {
    for (const s of STRICTNESS_LEVELS) {
      expect(strictnessBlock(s, 'plan')).not.toBe(strictnessBlock(s, 'execute'))
    }
  })
})

describe('YIELD_NOTE 只在真有定向注入时才说', () => {
  // 和 JUDGE_NOTE 被 seatPreamble 的提前返回挡掉是同一条理由:没有任何用户补充时,
  // 「用户点名补充的约束优先于它」说的是一件不存在的事。
  test('没有定向注入时不出现', () => {
    for (const p of ['review', 'accept', 'plan', 'execute'] as const) {
      expect(strictnessBlock('中级', p, false)).not.toContain('用户点名补充的约束优先于它')
    }
  })
  test('有定向注入时出现', () => {
    for (const p of ['review', 'accept', 'plan', 'execute'] as const) {
      expect(strictnessBlock('中级', p, true)).toContain('用户点名补充的约束优先于它')
    }
  })
})

describe('执行侧文本', () => {
  test('每一档都把「方案点名的事项」钉在档位之上,并强制留痕', () => {
    // 初级那句原来是「测试写进说明即可,不必现在做」,而 executePrompt 紧接着就渲染
    // plan 全文(acceptance 被 planPrompt 逼成「跑什么命令、看到什么结果」)—— 两条
    // 方向相反的指令。留痕那句同样是拿后果换来的:执行者往 execStatus 写「边界未处理」,
    // 而那段文字会被 acceptPrompt 原样渲染给一个被告知「验收点没写的不要求」的验收员。
    expect(strictnessBlock('初级', 'execute')).toContain('一件都不能少')
    for (const s of ['初级', '中级'] as const) {
      expect(strictnessBlock(s, 'execute')).toContain('本轮未做')
      expect(strictnessBlock(s, 'execute')).toContain('不要写成已完成')
    }
  })
  test('执行侧也声明档位 —— 只给裁决侧降档会让执行者按最高标准白干', () => {
    for (const s of STRICTNESS_LEVELS) {
      expect(strictnessBlock(s, 'execute')).toContain(`**${s}**`)
    }
  })
})

describe('quorum 的算术事实', () => {
  /**
   * `quorumSeatsNeeded` 必须和 `synthesizeVerdicts` 同构。两处各写一份近似的话,关口印 2
   * 而圆桌要 3 —— 而用户只会在节点被打回时才发现。这条用**真的 synthesizeVerdicts**
   * 交叉验证,不是重算一遍公式。
   */
  const verdicts = (approving: number, total: number): Verdict[] =>
    Array.from({ length: total }, (_, i) => ({
      role: `r${i}`, pass: i < approving, blocking: i < approving ? [] : ['x'], comments: '',
    }))

  test('关口印的门槛与圆桌真实判据逐席对齐', () => {
    for (const q of [51, 66, 80, 100]) {
      for (let seats = 1; seats <= 6; seats++) {
        const need = quorumSeatsNeeded(q, seats)
        expect(synthesizeVerdicts(verdicts(need, seats), q).pass).toBe(true)
        if (need > 1) expect(synthesizeVerdicts(verdicts(need - 1, seats), q).pass).toBe(false)
      }
    }
  })
  test('51% 在 1~2 席、80% 在 1~4 席上与全票等价 —— 关口必须说出来', () => {
    expect(quorumSeatsNeeded(51, 1)).toBe(1)
    expect(quorumSeatsNeeded(51, 2)).toBe(2)
    expect(quorumSeatsNeeded(51, 3)).toBe(2)
    for (let seats = 1; seats <= 4; seats++) expect(quorumSeatsNeeded(80, seats)).toBe(seats)
    expect(quorumSeatsNeeded(80, 5)).toBe(4)
  })
  test('四档的门槛单调不降', () => {
    for (let seats = 1; seats <= 8; seats++) {
      const need = STRICTNESS_LEVELS.map(s => quorumSeatsNeeded(STRICTNESS_QUORUM[s], seats))
      for (let i = 1; i < need.length; i++) expect(need[i]!).toBeGreaterThanOrEqual(need[i - 1]!)
    }
  })
  /**
   * **每一档都要能被按出来。** 第一版初级和中级都是 51 —— 两位评审员和一位验收员各自
   * 指出「按一下 `>` 什么都不会发生」,而一个按了没反应的旋钮比没有更糟。
   * 1 席时四档必然相同(算术),所以从 2 席起要求每一步都真的动。
   */
  test('2 席起,相邻两档的门槛在某个席位数上必须真的不同', () => {
    for (let i = 1; i < STRICTNESS_LEVELS.length; i++) {
      const lo = STRICTNESS_QUORUM[STRICTNESS_LEVELS[i - 1]!]
      const hi = STRICTNESS_QUORUM[STRICTNESS_LEVELS[i]!]
      const differs = [2, 3, 4, 5, 6].some(m => quorumSeatsNeeded(lo, m) !== quorumSeatsNeeded(hi, m))
      expect(differs).toBe(true)
    }
  })
  /**
   * **能分开几档受席位数的算术约束**,这条用例的存在就是为了不让人误读上面那条:
   * M 席只有 M 个可能的门槛,所以 2~3 席下四档最多落成 2 个值,那不是设计缺陷。
   * 真正该钉的是「5 席起四档必须两两不同」—— 那是这个旋钮能被完整按出来的地方。
   *
   *      席位   2    3    4    5    6
   *      初级   1    2    2    2    3
   *      中级   2    2    3    3    4
   *      高级   2    3    4    4    5
   *      专家   2    3    4    5    6
   */
  test('5 席起四档两两不同;2~3 席下落成两个值是算术约束,不是缺陷', () => {
    for (const seats of [5, 6]) {
      const need = STRICTNESS_LEVELS.map(s => quorumSeatsNeeded(STRICTNESS_QUORUM[s], seats))
      expect(new Set(need).size).toBe(4)
    }
    expect(STRICTNESS_LEVELS.map(s => quorumSeatsNeeded(STRICTNESS_QUORUM[s], 2))).toEqual([1, 2, 2, 2])
    expect(STRICTNESS_LEVELS.map(s => quorumSeatsNeeded(STRICTNESS_QUORUM[s], 3))).toEqual([2, 2, 3, 3])
    expect(STRICTNESS_LEVELS.map(s => quorumSeatsNeeded(STRICTNESS_QUORUM[s], 4))).toEqual([2, 3, 4, 4])
  })
})

describe('resolvedQuorum:显式写过就整个不参与', () => {
  /**
   * 「降档反而变严」的那条路:`synthesizeVerdicts` 的 `seatsOnly` 分支让一个只写了
   * `quorumSeats=2` 的用户在比例维度上**不设限**。档位一旦给 quorum 填上任何值,那个
   * 分支当场失效 —— 5 席下门槛从 2 席涨到 3 席,而用户刚刚选的是最松的那一档。
   */
  test('用户写过 quorumSeats 时,档位不填 quorum', () => {
    expect(resolvedQuorum(caps({ strictness: '初级', quorumSeats: 2 }))).toBeUndefined()
  })
  test('用户写过 quorum 时,用用户那个', () => {
    expect(resolvedQuorum(caps({ strictness: '初级', quorum: 90 }))).toBe(90)
  })
  test('都没写过时才用档位派生值', () => {
    expect(resolvedQuorum(caps({ strictness: '初级' }))).toBe(34)
    expect(resolvedQuorum(caps({ strictness: '专家' }))).toBe(100)
  })
  test('端到端:只写 quorumSeats=2 的 5 席圆桌,选初级档之后门槛不变', () => {
    const v: Verdict[] = Array.from({ length: 5 }, (_, i) => ({
      role: `r${i}`, pass: i < 2, blocking: i < 2 ? [] : ['x'], comments: '',
    }))
    const c = caps({ quorumSeats: 2 })
    expect(synthesizeVerdicts(v, resolvedQuorum(c), c.quorumSeats).pass).toBe(true)
    const lowered = caps({ quorumSeats: 2, strictness: '初级' })
    expect(synthesizeVerdicts(v, resolvedQuorum(lowered), lowered.quorumSeats).pass).toBe(true)
  })
})

describe('档位不动 maxIterations', () => {
  // `pipeline.ts` 的 roundtableWithInfraRetry 拿同一个数当「infra 失败最多重派几桌」。
  // 抬高它 = 上游 429 时每场圆桌多烧两轮,和「多好才算够」毫无关系。
  test('STRICTNESS_QUORUM 是档位唯一的数值维度', () => {
    expect(Object.keys(STRICTNESS_QUORUM).sort()).toEqual([...STRICTNESS_LEVELS].sort())
  })
})

describe('adjustStrictness 阶梯', () => {
  test('「不设」从任一方向都落到专家', () => {
    expect(adjustStrictness(undefined, 1)).toBe('专家')
    expect(adjustStrictness(undefined, -1)).toBe('专家')
  })
  test('两端夹住,不回绕', () => {
    expect(adjustStrictness('专家', 1)).toBe('专家')
    expect(adjustStrictness('初级', -1)).toBe('初级')
  })
  test('一次一级', () => {
    expect(adjustStrictness('专家', -1)).toBe('高级')
    expect(adjustStrictness('高级', -1)).toBe('中级')
    expect(adjustStrictness('中级', -1)).toBe('初级')
    expect(adjustStrictness('初级', 1)).toBe('中级')
  })
})

describe('isStrictness 只认那四个字面量', () => {
  test.each([...STRICTNESS_LEVELS])('%s 合法', s => expect(isStrictness(s)).toBe(true))
  test.each([['专家 '], ['expert'], [''], ['中'], [3], [null], [undefined], [{}]])(
    '%p 不合法', v => expect(isStrictness(v)).toBe(false),
  )
})
