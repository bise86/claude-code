import { describe, expect, test } from 'bun:test'
import {
  adjustStrictness, isStrictness, quorumSeatsNeeded, resolvedQuorum, reviewRubric,
  strictnessBlock, STRICTNESS_JUDGING, STRICTNESS_LEVELS, STRICTNESS_QUORUM, verifyRequirement,
} from './strictness.js'
import { synthesizeVerdicts } from './roundtable.js'
import { DEFAULT_CAPS, type Caps, type Verdict } from './types.js'

const caps = (over: Partial<Caps> = {}): Caps => ({ ...DEFAULT_CAPS, ...over })

describe('不设档 = 逐字节相同', () => {
  // 这是整个特性对老用户的**全部**承诺。三个判据类函数各有一条,因为它们各自有一份
  // 「缺省文本」常量,而缺省那份和中级档那份是**刻意分开写**的(见 strictness.ts):
  // 合并的话下一个人改中级档会静默改掉这条承诺。
  test('reviewRubric 缺省档含现状那三条判据,且不含任何档位字样', () => {
    const r = reviewRubric(undefined, 1)
    expect(r).toContain('blocking 只填**会让执行失败、或让产出没法验收**的问题')
    expect(r).toContain('方案不需要完美')
    expect(r).toContain('可以更好但不阻塞的,写进 comments')
    expect(r).not.toContain('严格度')
  })
  test('reviewRubric 缺省档第 2 轮起带原来那条「不要提新要求」', () => {
    expect(reviewRubric(undefined, 1)).not.toContain('不要提出上一轮没有提过的新要求')
    expect(reviewRubric(undefined, 2)).toContain('不要提出上一轮没有提过的新要求')
  })
  test('verifyRequirement 缺省档仍然是「没有可跑的验证手段就判不通过」', () => {
    expect(verifyRequirement(undefined)).toContain('没有可跑的验证手段,如实说明并判不通过')
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
   * 这两条断言就是防回归的探针:任何一天有人把 `reviewRubric` 改回「在原文后面追加」,
   * 缺省那三条就会重新出现在初级/专家档里。
   */
  test('初级档不含现状那句「blocking 只填会让执行失败…」', () => {
    expect(reviewRubric('初级', 1)).not.toContain('会让执行失败、或让产出没法验收')
  })
  test('专家档不含「方案不需要完美…能达到这条就判通过」', () => {
    // 这一句带着「blocking 等同于否决」的放行压力,和专家档正面冲突。
    expect(reviewRubric('专家', 1)).not.toContain('能达到这条就判通过')
    expect(reviewRubric('专家', 1)).toContain('「能开始干」不构成通过的理由')
  })
  test('初级/中级档不含「没有可跑的验证手段…判不通过」,而是给出带留痕的豁免', () => {
    for (const s of ['初级', '中级'] as const) {
      const v = verifyRequirement(s)
      expect(v).not.toContain('没有可跑的验证手段,如实说明并判不通过')
      expect(v).toContain('不因缺手段本身判不通过')
      // 豁免必须带留痕义务:降档可以降标准,不能降留痕。
      expect(v).toContain('本节点无可执行验证手段')
    }
  })
  test('高级/专家档保留「没有可跑的验证手段 = 不通过」并要求跑既有测试', () => {
    for (const s of ['高级', '专家'] as const) {
      expect(verifyRequirement(s)).toContain('没有可跑的验证手段,如实说明并判不通过')
      // 「跑既有测试证明没有回归」从专家下放到高级 —— 否则高级档下执行侧被要求做的事
      // 没有任何一关会去核(草案内部的一处不自洽,评审查出)。
      expect(verifyRequirement(s)).toContain('没有引入回归')
    }
  })
  test('专家档不含「跑起来但失败的判不通过」这种初级措辞', () => {
    expect(verifyRequirement('专家')).not.toContain('不因缺手段本身判不通过')
  })
})

describe('提新要求那条护栏:专家档是举证责任,不是「不限」', () => {
  test('初级/中级/高级第 2 轮起沿用原来那条禁止', () => {
    for (const s of ['初级', '中级', '高级'] as const) {
      expect(reviewRubric(s, 2)).toContain('不要提出上一轮没有提过的新要求')
    }
  })
  test('专家档允许提新的,但必须写明为什么上一轮没提', () => {
    const r = reviewRubric('专家', 2)
    expect(r).not.toContain('不要提出上一轮没有提过的新要求')
    expect(r).toContain('写明为什么上一轮没提')
  })
  test('无论哪一档,第 1 轮都不谈「上一轮」', () => {
    for (const s of [...STRICTNESS_LEVELS, undefined]) {
      expect(reviewRubric(s, 1)).not.toContain('上一轮')
    }
  })
})

describe('地板与档位无关', () => {
  test('产出侧三关每一档都带那三条不放行', () => {
    for (const s of STRICTNESS_LEVELS) {
      for (const p of ['verify', 'accept', 'integrate'] as const) {
        const b = strictnessBlock(s, p)
        expect(b).toContain('执行者没有报告任何产出')
        expect(b).toContain('找不到它做过的任何痕迹')
        expect(b).toContain('降档降的是「多好才算够」,不降「到底做没做」')
      }
    }
  })
  /**
   * review 用**自己那份**地板 —— 验收查出的 P0:产出侧那三条在评审时恒真(那时一行代码
   * 都没写),而结论是「pass 一律为 false」。后果的方向和这个特性的目的正好相反:
   * 只要设了任何一档,评审就比不设档更难过。
   */
  test('质疑讨论关拿到的是讲方案的地板,不是讲产出的那份', () => {
    for (const s of STRICTNESS_LEVELS) {
      const b = strictnessBlock(s, 'review')
      expect(b).not.toContain('执行者没有报告任何产出')
      expect(b).not.toContain('没有看过任何产出(代码、diff、命令输出)')
      expect(b).toContain('方案是空的、或与目标无关')
      expect(b).toContain('没有真的读过这份方案')
      expect(b).toContain('降档降的是「方案要写多细」,不降「到底有没有方案」')
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
  test('STRICTNESS_JUDGING 恰好是四个,不含 observer', () => {
    expect([...STRICTNESS_JUDGING].sort()).toEqual(['accept', 'integrate', 'review', 'verify'])
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
