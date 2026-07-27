// PROBE 2b: MAX_STREAMS_PER_NODE says "keep 40, tombstone the OLDEST ONE when over".
// Measure how many are actually tombstoned as streams accumulate on ONE node.
import { createStreamStore, MAX_STREAMS_PER_NODE, TOMBSTONE_KEEP } from '../src/tools/efftask/agentStream.js'

const st = createStreamStore()
console.log(`MAX_STREAMS_PER_NODE=${MAX_STREAMS_PER_NODE} TOMBSTONE_KEEP=${TOMBSTONE_KEEP}`)
console.log('opened  listLen  tombstoned  intact(full-history)  expectedIntact')
for (let i = 1; i <= 60; i++) {
  const h = st.open({ nodeId: 'z', phaseLabel: 'p', label: `l${i}` })
  for (let k = 0; k < 20; k++) h.push({ kind: 'text', text: `e${k}` })
  h.end()
  const list = st.streams('z')
  const tomb = list.filter(s => s.tombstone).length
  const intact = list.length - tomb
  const expected = Math.min(i, MAX_STREAMS_PER_NODE)
  if (i <= 42 || i % 5 === 0 || i === 60) {
    console.log(
      String(i).padStart(6),
      String(list.length).padStart(8),
      String(tomb).padStart(11),
      String(intact).padStart(21),
      String(expected).padStart(15),
      intact < expected ? '  <-- LESS HISTORY THAN THE CAP PROMISES' : '',
    )
  }
}
const list = st.streams('z')
console.log(`\nfinal: ${list.length} streams on the node, ${list.filter(s => s.tombstone).length} tombstoned`)
console.log(`events left per stream:`, list.slice(0, 6).map(s => s.events.length), '...', list.slice(-3).map(s => s.events.length))
console.log(`node droppedEvents = ${st.droppedEvents('z')}, totalEvents = ${st.totalEvents()}`)
