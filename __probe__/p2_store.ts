// PROBE 2: createStreamStore under 50k events. Caps + wall-clock (it is on the model hot path).
import { createStreamStore, MAX_TOTAL_EVENTS, MAX_EVENTS_PER_STREAM, MAX_STREAMS_PER_NODE } from '../src/tools/efftask/agentStream.js'
import type { AgentEvent } from '../src/tools/efftask/agentEvents.js'

const ev = (i: number): AgentEvent => ({ kind: 'text', text: `行 ${i} ${'字'.repeat(60)}` })

function scenario(name: string, fn: () => { total: number; n: number }) {
  const t0 = performance.now()
  const { total, n } = fn()
  const dt = performance.now() - t0
  console.log(`${name.padEnd(46)} total=${String(total).padStart(7)} pushes=${n} time=${dt.toFixed(0)}ms  us/push=${((dt * 1000) / n).toFixed(2)}`)
  return { total, dt }
}

const N = 50_000

// S1: one stream, 50k pushes. Ring buffer should hold at 100.
scenario('S1 one open stream, 50k pushes', () => {
  const st = createStreamStore()
  const h = st.open({ nodeId: 'n1', phaseLabel: '执行', label: '主模型' })
  for (let i = 0; i < N; i++) h.push(ev(i))
  return { total: st.totalEvents(), n: N }
})

// S2: many streams, each CLOSED after filling. This is the realistic run shape.
scenario('S2 500 streams x100, closed each', () => {
  const st = createStreamStore()
  for (let s = 0; s < 500; s++) {
    const h = st.open({ nodeId: `n${s % 50}`, phaseLabel: '评审', label: `员工${s}` })
    for (let i = 0; i < 100; i++) h.push(ev(i))
    h.end()
  }
  return { total: st.totalEvents(), n: 50_000 }
})

// S3: ALL streams left OPEN (the documented "known boundary"). Does the global cap hold?
const s3 = scenario('S3 500 OPEN streams x100 (never end())', () => {
  const st = createStreamStore()
  for (let s = 0; s < 500; s++) {
    const h = st.open({ nodeId: `n${s % 50}`, phaseLabel: '评审', label: `员工${s}` })
    for (let i = 0; i < 100; i++) h.push(ev(i))
  }
  return { total: st.totalEvents(), n: 50_000 }
})
console.log(`   -> MAX_TOTAL_EVENTS=${MAX_TOTAL_EVENTS}; S3 held=${s3.total <= MAX_TOTAL_EVENTS}`)

// S4: interleaved pushes across many open streams (真实并发形状: 5 nodes x N seats)
scenario('S4 interleaved 200 open streams round-robin', () => {
  const st = createStreamStore()
  const hs = Array.from({ length: 200 }, (_, s) => st.open({ nodeId: `n${s % 20}`, phaseLabel: 'p', label: `s${s}` }))
  for (let i = 0; i < 250; i++) for (const h of hs) h.push(ev(i))
  return { total: st.totalEvents(), n: 50_000 }
})

// S5: with a subscriber attached (the component does subscribe) — notify() is per-push.
scenario('S5 50k pushes with 1 subscriber', () => {
  const st = createStreamStore()
  let hits = 0
  st.subscribe(() => { hits++ })
  const h = st.open({ nodeId: 'n1', phaseLabel: 'p', label: 'l' })
  for (let i = 0; i < N; i++) h.push(ev(i))
  console.log(`   -> subscriber invoked ${hits} times for ${N} pushes`)
  return { total: st.totalEvents(), n: N }
})

// S6: the WORST case for closedQueue.shift() — huge closed queue then overflow.
scenario('S6 3000 closed streams x100 (global evict path)', () => {
  const st = createStreamStore()
  for (let s = 0; s < 3000; s++) {
    const h = st.open({ nodeId: `n${s % 100}`, phaseLabel: 'p', label: `s${s}` })
    for (let i = 0; i < 100; i++) h.push(ev(i))
    h.end()
  }
  return { total: st.totalEvents(), n: 300_000 }
})

// --- cap invariants ---
{
  const st = createStreamStore()
  const h = st.open({ nodeId: 'z', phaseLabel: 'p', label: 'l' })
  for (let i = 0; i < 500; i++) h.push(ev(i))
  const s = st.streams('z')[0]!
  console.log(`\nper-stream cap: events=${s.events.length} (max ${MAX_EVENTS_PER_STREAM}) dropped=${s.dropped} nodeDropped=${st.droppedEvents('z')} total=${st.totalEvents()}`)
}
{
  const st = createStreamStore()
  for (let i = 0; i < 100; i++) { const h = st.open({ nodeId: 'z', phaseLabel: 'p', label: `l${i}` }); h.push(ev(i)); h.end() }
  console.log(`per-node streams: ${st.streams('z').length} (MAX_STREAMS_PER_NODE=${MAX_STREAMS_PER_NODE}) tombstoned=${st.streams('z').filter(s => s.tombstone).length}`)
}
