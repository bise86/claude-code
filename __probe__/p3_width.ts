// PROBE 3: the module's HARD invariant — "one LogLine = one terminal row".
// Measure every produced line with the repo's OWN stringWidth.
import { stringWidth } from '../src/ink/stringWidth.js'
import { renderStreamLines, wrapDisplayWidth, scrollbarColumn } from '../src/commands/efftask/logView.js'
import { createStreamStore } from '../src/tools/efftask/agentStream.js'
import type { AgentEvent } from '../src/tools/efftask/agentEvents.js'
import { eventsFromMessage } from '../src/tools/efftask/agentEvents.js'
import { createUserMessage } from '../src/utils/messages.js'

let bad = 0
const check = (where: string, s: string, w: number) => {
  const got = stringWidth(s)
  if (got > w) { bad++; console.log(`OVERFLOW ${where}: width=${got} > ${w}  ${JSON.stringify(s.slice(0, 70))}`) }
}

// --- A. wrapDisplayWidth direct ---
const samples: [string, string][] = [
  ['han', '这是一段中文说明文字'.repeat(20)],
  ['emoji', '🎉🔥✅🚀'.repeat(40)],
  ['zwj-family', '👨‍👩‍👧‍👦'.repeat(30)],
  ['flag', '🇨🇳🇺🇸'.repeat(30)],
  ['skin', '👍🏽👋🏿'.repeat(30)],
  ['mixed', 'abc中文🎉tab\there混合'.repeat(20)],
  ['tab-only', '\t'.repeat(30)],
  ['combining', 'é́à'.repeat(50)],
  ['cjk-punct', '、。「」『』()'.repeat(30)],
  ['halfwidth-kana', 'ｱｲｳｴｵ'.repeat(40)],
  ['fullwidth-latin', 'ＡＢＣＤＥ'.repeat(40)],
  ['long-nospace', 'x'.repeat(400)],
]
console.log('=== A. wrapDisplayWidth ===')
for (const [name, s] of samples) {
  for (const w of [1, 2, 3, 10, 40, 80]) {
    for (const line of wrapDisplayWidth(s, w)) check(`A ${name} w=${w}`, line, w)
  }
}
console.log(`A done, overflows=${bad}`)

// --- B. renderStreamLines end-to-end at many widths ---
console.log('\n=== B. renderStreamLines ===')
const before = bad
for (const w of [1, 2, 5, 10, 20, 40, 60, 100]) {
  const st = createStreamStore()
  const h = st.open({ nodeId: 'n', phaseLabel: '质疑讨论', label: '资深工程师-张三', round: 2, model: 'opus' })
  const evs: AgentEvent[] = [
    { kind: 'text', text: '这是一段很长的中文说明,'.repeat(10) },
    { kind: 'thinking', text: '思考'.repeat(80) },
    { kind: 'tool', useId: 't1', name: 'Bash', brief: 'Bash(' + 'bun test '.repeat(40) + ')' },
    { kind: 'result', useId: 't1', brief: '🎉🔥'.repeat(80), isError: false },
    { kind: 'result', useId: 't1', brief: 'エラー発生'.repeat(40), isError: true },
    { kind: 'text', text: '含制表符\tTAB\t在这里\t结束' },
  ]
  for (const e of evs) h.push(e)
  const lines = renderStreamLines({ streams: st.streams('n'), folded: new Set(), selected: 0, nowMs: Date.now(), width: w })
  const effective = Math.max(10, w)
  for (const l of lines) check(`B w=${w}(eff ${effective})`, l.text, effective)
}
console.log(`B done, new overflows=${bad - before}`)

// --- C. real tool_result text with TABs (Read output shape) ---
console.log('\n=== C. tab from a REAL Read tool_result ===')
const msg = createUserMessage({
  content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '     1\tconst x = 1' }] }],
})
const evsReal = eventsFromMessage(msg as never)
console.log('event =', JSON.stringify(evsReal))
const tabline = (evsReal[0] as { brief: string }).brief
console.log(`stringWidth("\\t") = ${stringWidth('\t')}`)
console.log(`stringWidth(brief) = ${stringWidth(tabline)}  chars=${tabline.length}  contains TAB=${tabline.includes('\t')}`)
const wrapped = wrapDisplayWidth(tabline, 20)
console.log('wrapped@20 =', JSON.stringify(wrapped), 'widths=', wrapped.map(stringWidth))
console.log('-> a terminal expands \\t to the next 8-col tab stop, so real columns =',
  tabline.split('\t').reduce((col, seg, i) => (i === 0 ? stringWidth(seg) : (Math.floor(col / 8) + 1) * 8 + stringWidth(seg)), 0))

// --- D. scrollbarColumn invariants ---
console.log('\n=== D. scrollbarColumn ===')
for (const [total, height, from] of [[0, 0, 0], [0, 5, 0], [1, 5, 0], [5, 5, 0], [6, 5, 0], [6, 5, 1], [1000, 3, 997], [1000, 3, 0], [3, 1, 2], [10, 1, 9]] as [number, number, number][]) {
  const col = scrollbarColumn(total, height, from)
  console.log(`total=${total} h=${height} from=${from} -> len=${col.length} ${JSON.stringify(col.join(''))} thumbs=${col.filter(c => c !== '│' && c !== ' ').length}`)
}
console.log(`\nTOTAL OVERFLOWS = ${bad}`)
