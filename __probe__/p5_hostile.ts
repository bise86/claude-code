// PROBE 5: hostile inputs. Nothing here may throw — these all sit on the model hot path,
// and a throw here is misdiagnosed as an infra failure (see runAgentAdapter's comment).
import { eventsFromMessage, briefOfToolUse, briefOfToolResult, sanitizeLine } from '../src/tools/efftask/agentEvents.js'
import { feedbackItems, similarItem, planFeedbackPrompt, exhaustionReason, exhaustionRemedy, reviewRepeatNotice, stuckItems } from '../src/tools/efftask/reviewConvergence.js'
import { renderStreamLines, wrapDisplayWidth, logPaneAction, budgetRows, scrollWindow, scrollbarColumn, lastActivity, droppedNotice } from '../src/commands/efftask/logView.js'
import { createStreamStore } from '../src/tools/efftask/agentStream.js'

let throws = 0
let slow = 0
function attempt(label: string, fn: () => unknown): void {
  const t0 = performance.now()
  try {
    const v = fn()
    const dt = performance.now() - t0
    if (dt > 200) { slow++; console.log(`SLOW  ${label}: ${dt.toFixed(0)}ms`) }
    const s = JSON.stringify(v)
    console.log(`ok    ${label} -> ${s === undefined ? String(v) : s.length > 110 ? s.slice(0, 110) + '…' : s}`)
  } catch (e) {
    throws++
    console.log(`THROW ${label}: ${(e as Error).name}: ${(e as Error).message}`)
  }
}

// --- circular ---
const circ: Record<string, unknown> = { file_path: 'a.ts' }
circ.self = circ
const circArr: unknown[] = [{ type: 'text', text: 'hi' }]
circArr.push(circArr)

// --- proxies ---
const throwingProxy = new Proxy({}, {
  get() { throw new Error('proxy get exploded') },
  has() { throw new Error('proxy has exploded') },
  ownKeys() { throw new Error('proxy ownKeys exploded') },
  getOwnPropertyDescriptor() { throw new Error('proxy gopd exploded') },
})
const lyingProxy = new Proxy({ type: 'tool_use' } as Record<string, unknown>, {
  get(t, p) { if (p === 'name') return { toString() { throw new Error('name.toString exploded') } }; return t[p as string] },
})
// getter that throws
const getterBomb = { get type() { throw new Error('type getter exploded') } }
// toString bomb
const toStringBomb = { file_path: { toString() { throw new Error('toString exploded') } } }

// --- deep nesting ---
let deep: unknown = 'bottom'
for (let i = 0; i < 200000; i++) deep = { inner: deep }
const deepArr: unknown = Array.from({ length: 50000 }, () => ({ type: 'text', text: 'x' }))

// --- giant ---
const giant = 'あ'.repeat(2_000_000)
const giantObj: Record<string, string> = {}
for (let i = 0; i < 50000; i++) giantObj[`k${i}`] = `v${i}`

console.log('=== eventsFromMessage ===')
for (const [label, m] of [
  ['null', null], ['undefined', undefined], ['number', 42], ['string', 'x'], ['[]', []],
  ['{}', {}], ['{type:assistant}', { type: 'assistant' }],
  ['content=null', { type: 'assistant', message: { content: null } }],
  ['content=[null,undefined,0]', { type: 'assistant', message: { content: [null, undefined, 0, false, ''] } }],
  ['content=circular arr', { type: 'assistant', message: { content: circArr } }],
  ['message=circular', { type: 'assistant', message: circ }],
  ['throwingProxy as msg', throwingProxy],
  ['content=[throwingProxy]', { type: 'assistant', message: { content: [throwingProxy] } }],
  ['content=[lyingProxy]', { type: 'assistant', message: { content: [lyingProxy] } }],
  ['content=[getterBomb]', { type: 'assistant', message: { content: [getterBomb] } }],
  ['tool_use input=toStringBomb', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: 'Read', input: toStringBomb }] } }],
  ['tool_use input=circular', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: 'Read', input: circ }] } }],
  ['tool_use input=throwingProxy', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: 'X', input: throwingProxy }] } }],
  ['tool_use input=giantObj', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: 'X', input: giantObj }] } }],
  ['text=giant 2M', { type: 'assistant', message: { content: [{ type: 'text', text: giant }] } }],
  ['text=1M newlines', { type: 'assistant', message: { content: [{ type: 'text', text: '\n'.repeat(1_000_000) }] } }],
  ['deep nested content', { type: 'assistant', message: { content: [deep] } }],
  ['50k blocks', { type: 'assistant', message: { content: deepArr } }],
  ['user result=circular', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'i', content: circArr }] } }],
  ['user result=proxy', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'i', content: throwingProxy }] } }],
  ['user tool_use_id=object', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: { a: 1 }, content: 'x' }] } }],
  ['proto pollution key', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'i', name: '__proto__', input: { __proto__: { x: 1 } } }] } }],
  ['ANSI clear screen', { type: 'assistant', message: { content: [{ type: 'text', text: '[2J[H BOOM  \r覆盖' }] } }],
] as [string, unknown][]) {
  attempt(`eventsFromMessage(${label})`, () => eventsFromMessage(m as never))
}

console.log('\n=== briefOfToolUse / briefOfToolResult / sanitizeLine ===')
attempt('briefOfToolUse(proxy name)', () => briefOfToolUse(throwingProxy as never, throwingProxy))
attempt('briefOfToolUse(circ)', () => briefOfToolUse('Read', circ))
attempt('briefOfToolUse(resolver throws)', () => briefOfToolUse('Read', { file_path: 'a' }, () => { throw new Error('x') }))
attempt('briefOfToolUse(resolver returns obj)', () => briefOfToolUse('Read', {}, () => ({}) as never))
attempt('briefOfToolUse(giant str input)', () => briefOfToolUse('Bash', { command: giant }))
attempt('briefOfToolResult(circular)', () => briefOfToolResult(circArr))
attempt('briefOfToolResult(proxy)', () => briefOfToolResult(throwingProxy))
attempt('briefOfToolResult(50k blocks)', () => briefOfToolResult(deepArr))
attempt('briefOfToolResult(giant str)', () => briefOfToolResult(giant))
attempt('sanitizeLine(null)', () => sanitizeLine(null as never))
attempt('sanitizeLine(giant)', () => sanitizeLine(giant))
attempt('sanitizeLine(lone surrogate)', () => sanitizeLine('\uD800abc'))

console.log('\n=== feedbackItems / reviewConvergence ===')
for (const [label, log] of [
  ['null', null], ['undefined', undefined], ['[]', []], ['[null]', [null]],
  ['[{}]', [{}]], ['verdicts=null', [{ round: 1, verdicts: null }]],
  ['verdicts=[null]', [{ round: 1, verdicts: [null] }]],
  ['blocking=null', [{ round: 1, verdicts: [{ role: 'r', blocking: null }] }]],
  ['blocking=[null,1,{}]', [{ round: 1, verdicts: [{ role: 'r', blocking: [null, 1, {}, 'ok 意见一条'] }] }]],
  ['blocking=[circObj]', [{ round: 1, verdicts: [{ role: 'r', blocking: [circ] }] }]],
  ['round=NaN', [{ round: NaN, verdicts: [{ role: 'r', blocking: ['某条意见内容'] }] }]],
  ['round=undefined', [{ verdicts: [{ role: 'r', blocking: ['某条意见内容'] }] }]],
  ['proxy verdicts', [{ round: 1, verdicts: throwingProxy }]],
  ['500 items x 3 rounds', Array.from({ length: 3 }, (_, r) => ({ round: r + 1, verdicts: [{ role: 'r', blocking: Array.from({ length: 500 }, (_, i) => `第 ${i} 条互不相同的阻断意见内容 ${i}`) }] }))],
  ['giant blocking str', [{ round: 1, verdicts: [{ role: 'r', blocking: [giant.slice(0, 200000)] }] }]],
] as [string, unknown][]) {
  attempt(`feedbackItems(${label})`, () => feedbackItems(log as never).length)
}
attempt('planFeedbackPrompt([])', () => planFeedbackPrompt([]))
attempt('planFeedbackPrompt(rounds=[])', () => planFeedbackPrompt([{ text: 't', role: 'r', rounds: [] }]))
attempt('exhaustionReason(rounds=[])', () => exhaustionReason([{ text: 't', role: 'r', rounds: [] }], 3))
attempt('exhaustionRemedy([])', () => exhaustionRemedy([]))
attempt('reviewRepeatNotice(NaN round)', () => reviewRepeatNotice([{ text: 't', role: 'r', rounds: [1] }], NaN))
attempt('stuckItems(null)', () => stuckItems(null as never))

console.log('\n=== logView ===')
attempt('wrapDisplayWidth(null,10)', () => wrapDisplayWidth(null as never, 10))
attempt('wrapDisplayWidth(s,-5)', () => wrapDisplayWidth('中文abc', -5))
attempt('wrapDisplayWidth(s,NaN)', () => wrapDisplayWidth('中文abc', NaN))
attempt('wrapDisplayWidth(s,0.5)', () => wrapDisplayWidth('中文abc', 0.5))
attempt('wrapDisplayWidth(giant,10) len', () => wrapDisplayWidth(giant.slice(0, 50000), 10).length)
attempt('renderStreamLines(streams=[])', () => renderStreamLines({ streams: [], folded: new Set(), selected: 0, nowMs: 0, width: 40 }).length)
attempt('renderStreamLines(width=NaN)', () => renderStreamLines({ streams: [], folded: new Set(), selected: 0, nowMs: 0, width: NaN }).length)
{
  const st = createStreamStore({ now: () => 5000 })
  const h = st.open({ nodeId: 'n', phaseLabel: 'p', label: 'l' })
  h.push({ kind: 'text', text: 'x' })
  h.end()
  const s = st.streams('n')[0]!
  // clock skew: endedAt < startedAt
  ;(s as { startedAt: number }).startedAt = 9_000_000
  attempt('renderStreamLines(endedAt<startedAt)', () => renderStreamLines({ streams: [s], folded: new Set(), selected: 0, nowMs: 0, width: 60 }).map(l => l.text))
  ;(s as { endedAt?: number }).endedAt = undefined
  ;(s as { closed: boolean }).closed = false
  attempt('renderStreamLines(now<startedAt, running)', () => renderStreamLines({ streams: [s], folded: new Set(), selected: 0, nowMs: 0, width: 60 }).map(l => l.text))
  attempt('renderStreamLines(meta undefined)', () => renderStreamLines({ streams: [{ } as never], folded: new Set(), selected: 0, nowMs: 0, width: 40 }).length)
  attempt('lastActivity(events undefined)', () => lastActivity({ events: undefined } as never))
}
attempt('logPaneAction(undefined,{})', () => logPaneAction(undefined as never, {} as never))
attempt('logPaneAction(giant repeat j)', () => logPaneAction('j'.repeat(100000), {} as never))
attempt('budgetRows([],-1,-1)', () => budgetRows([], -1, -1))
attempt('budgetRows([NaN],0,5)', () => budgetRows([NaN], 0, 5))
attempt('scrollWindow(NaN,NaN,NaN)', () => scrollWindow(NaN, NaN, NaN))
attempt('scrollWindow(10,3,Infinity)', () => scrollWindow(10, 3, Infinity))
attempt('scrollbarColumn(NaN,5,0)', () => scrollbarColumn(NaN, 5, 0))
attempt('scrollbarColumn(10,-1,0)', () => scrollbarColumn(10, -1, 0))
attempt('scrollbarColumn(1e9,3,0) len', () => scrollbarColumn(1e9, 3, 0).length)
attempt('droppedNotice(NaN)', () => droppedNotice(NaN))

console.log('\n=== stream store hostile ===')
attempt('store: push after end', () => {
  const st = createStreamStore()
  const h = st.open({ nodeId: 'n', phaseLabel: 'p', label: 'l' })
  h.end(); h.push({ kind: 'text', text: 'late' }); h.end('again')
  return { events: st.streams('n')[0]!.events.length, dropped: st.streams('n')[0]!.dropped, err: st.streams('n')[0]!.error }
})
attempt('store: subscriber throws', () => {
  const st = createStreamStore()
  st.subscribe(() => { throw new Error('sub boom') })
  const h = st.open({ nodeId: 'n', phaseLabel: 'p', label: 'l' })
  h.push({ kind: 'text', text: 'x' }); h.end()
  return st.totalEvents()
})
attempt('store: meta with proxy nodeId', () => {
  const st = createStreamStore()
  const h = st.open({ nodeId: '__proto__', phaseLabel: 'p', label: 'l' })
  h.push({ kind: 'text', text: 'x' })
  return { nodes: st.nodes(), n: st.streams('__proto__').length }
})
attempt('store: push null event', () => {
  const st = createStreamStore()
  const h = st.open({ nodeId: 'n', phaseLabel: 'p', label: 'l' })
  h.push(null as never)
  return renderStreamLines({ streams: st.streams('n'), folded: new Set(), selected: 0, nowMs: 0, width: 40 }).length
})

console.log(`\n==== THREW: ${throws}  SLOW(>200ms): ${slow} ====`)
