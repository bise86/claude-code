// PROBE 4: similarItem on 10 hand-built pairs of realistic Chinese review opinions.
import { similarItem, normalizeItem, feedbackItems, stuckItems, planFeedbackPrompt, exhaustionReason } from '../src/tools/efftask/reviewConvergence.js'

type Case = { a: string; b: string; want: boolean; why: string }
const cases: Case[] = [
  { want: true,  why: '同一条换说法(设计文档承认应判重)', a: '评分等级(A/B/C/D)与具体分数的映射规则未定义', b: '评分等级到分数的映射规则没有定义' },
  { want: false, why: '同模板换语义:超时 vs 错误 是两条', a: '未定义接口返回超时时的重试策略与退避算法', b: '未定义接口返回错误时的重试策略与退避算法' },
  { want: false, why: '同模板换序号:第一步 vs 第三步', a: '验收标准第一步缺少可观测的判定依据', b: '验收标准第三步缺少可观测的判定依据' },
  { want: false, why: '完全不同的两条意见', a: '缺少数据库迁移的回滚方案', b: '前端组件没有覆盖暗色主题' },
  { want: true,  why: '加了标点和空格,正文一样', a: '缺少回滚方案', b: '缺少 回滚方案。' },
  { want: false, why: '包含关系但确实是两条(短的被长的吞)', a: '缺少回滚方案', b: '缺少回滚方案的验证步骤,且回滚脚本未提供' },
  { want: true,  why: '语序倒装,同一件事', a: '并发写入时的锁粒度没有说明', b: '没有说明并发写入时的锁粒度' },
  { want: false, why: '同名模块不同问题', a: '登录模块缺少限流', b: '登录模块缺少审计日志' },
  { want: false, why: '否定/肯定相反', a: '方案已覆盖超时重试', b: '方案未覆盖超时重试' },
  { want: true,  why: '中英混写同一条', a: 'API 的 timeout 未定义', b: 'api的timeout没有定义' },
]

let wrong = 0
console.log('want  got   verdict  why')
for (const c of cases) {
  const got = similarItem(c.a, c.b)
  const ok = got === c.want
  if (!ok) wrong++
  console.log(`${String(c.want).padEnd(5)} ${String(got).padEnd(5)} ${ok ? 'OK  ' : 'MISS'}     ${c.why}\n      a=${c.a}\n      b=${c.b}`)
}
console.log(`\n${wrong}/${cases.length} disagree with my expectation\n`)

// --- degenerate / adversarial inputs ---
console.log('=== degenerate ===')
const deg: [unknown, unknown][] = [
  ['', ''], ['   ', '   '], ['……', '。。。'], ['a', 'a'], ['ab', 'ba'],
  [null, 'x'], [undefined, undefined], [123, 123], [{}, {}], [[], []],
  ['缺少回滚方案', '缺少回滚方案'.repeat(50)],
  ['x'.repeat(100000), 'x'.repeat(100000)],
]
for (const [a, b] of deg) {
  let r: unknown
  try { r = similarItem(a as string, b as string) } catch (e) { r = `THREW ${(e as Error).message}` }
  const pv = (v: unknown) => (typeof v === 'string' && v.length > 30 ? `${v.slice(0, 20)}…(${v.length})` : JSON.stringify(v))
  console.log(`similarItem(${pv(a)}, ${pv(b)}) = ${r}`)
}
console.log('normalizeItem(全角) =', JSON.stringify(normalizeItem('ＡＢＣ　１２３!!')))
console.log('normalizeItem(non-string) =', JSON.stringify(normalizeItem(null as never)))

// --- the "本轮新增" claim: an item that ONLY appeared in round 1, rendered at round 3 ---
console.log('\n=== 【本轮新增】accuracy ===')
const log = [
  { round: 1, verdicts: [{ role: 'main', blocking: ['第一轮独有的意见:缺少灰度开关'], infra: false }] },
  { round: 2, verdicts: [{ role: 'main', blocking: ['第二轮独有的意见:缺少压测数据'], infra: false }] },
  { round: 3, verdicts: [{ role: 'main', blocking: ['第三轮才提的意见:缺少监控告警'], infra: false }] },
] as never
const items = feedbackItems(log)
console.log('items =', JSON.stringify(items))
console.log('stuck =', JSON.stringify(stuckItems(items)))
console.log('--- planFeedbackPrompt (shown to the PLAN AUTHOR when starting round 4) ---')
console.log(planFeedbackPrompt(items))
console.log('--- exhaustionReason ---')
console.log(exhaustionReason(items, 3))

// --- 「连续 N 轮」 with a GAP: rounds [1,3] is not consecutive ---
console.log('\n=== 「连续」 with a gap ===')
const gap = [
  { round: 1, verdicts: [{ role: 'main', blocking: ['缺少灰度开关的具体配置项'], infra: false }] },
  { round: 2, verdicts: [{ role: 'main', blocking: ['压测数据缺失需要补充'], infra: false }] },
  { round: 3, verdicts: [{ role: 'main', blocking: ['缺少灰度开关的具体配置项'], infra: false }] },
] as never
const gi = feedbackItems(gap)
console.log('items =', JSON.stringify(gi))
console.log(exhaustionReason(gi, 3))
