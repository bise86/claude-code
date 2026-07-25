import { describe, expect, it } from 'bun:test'
import { createChunkStore, MAX_CHUNK_LINES, MAX_CHUNK_LINE_CHARS } from './chunkBuffer.js'

describe('子 agent 输出缓冲 (spec §10.2)', () => {
  it('keeps output per node, oldest first', () => {
    const s = createChunkStore()
    s.push('root/01-a', '第一行\n第二行')
    s.push('root/02-b', '别人的输出')
    s.push('root/01-a', '第三行')
    expect(s.lines('root/01-a')).toEqual(['第一行', '第二行', '第三行'])
    expect(s.lines('root/02-b')).toEqual(['别人的输出'])
    expect(s.nodes().sort()).toEqual(['root/01-a', 'root/02-b'])
  })

  it('a node with no output reads as empty, not undefined', () => {
    expect(createChunkStore().lines('nope')).toEqual([])
    expect(createChunkStore().dropped('nope')).toBe(0)
  })

  it('drops blank messages — a tool-only turn is not output', () => {
    // runAgentAdapter emits one chunk per assistant message; a turn that only called tools
    // produces exactly this, and a pane full of blank lines is worse than a short one.
    const s = createChunkStore()
    s.push('n', '')
    s.push('n', '   \n\n  ')
    expect(s.lines('n')).toEqual([])
  })

  it('is BOUNDED — a long run cannot grow it without limit', () => {
    // The execute phase streams every assistant message of a write-capable agent, a run can
    // hold 100 nodes, and the pane shows a screenful. Unbounded, this grows for the whole
    // life of a run nobody is watching.
    const s = createChunkStore(5)
    for (let i = 1; i <= 20; i++) s.push('n', `line ${i}`)
    expect(s.lines('n')).toEqual(['line 16', 'line 17', 'line 18', 'line 19', 'line 20'])
    expect(s.lines('n')).toHaveLength(5)
  })

  it('counts what it dropped, so the pane cannot imply it shows everything', () => {
    // A view that silently starts in the middle looks like a view of the whole thing — the
    // same clipping lie NodeDetail's block() already had to fix.
    const s = createChunkStore(3)
    for (let i = 1; i <= 10; i++) s.push('n', `line ${i}`)
    expect(s.dropped('n')).toBe(7)
    expect(s.lines('n')).toEqual(['line 8', 'line 9', 'line 10'])
  })

  it('drops correctly when one message overflows the buffer by itself', () => {
    const s = createChunkStore(3)
    s.push('n', ['a', 'b', 'c', 'd', 'e'].join('\n'))
    expect(s.lines('n')).toEqual(['c', 'd', 'e'])
    expect(s.dropped('n')).toBe(2)
  })

  it('the default cap is a screenful, not a transcript', () => {
    expect(MAX_CHUNK_LINES).toBeGreaterThan(50)
    expect(MAX_CHUNK_LINES).toBeLessThanOrEqual(500)
  })
})


describe('缓冲要挡住的不只是行数', () => {
  it('单行按码点截断 —— 否则一条没有换行的百万字消息会常驻整场运行', () => {
    // Measured: 250 single-line 1 MB messages kept 200 lines = 400 MB of UTF-16 the panel
    // never shows (it renders the first 100 code points). maxNodes clamps at 5000 and the
    // cap-nodes card tells users to raise it, and §10.2 says the buffer is never released.
    const s = createChunkStore()
    s.push('n', 'x'.repeat(1_000_000))
    const line = s.lines('n')[0]
    expect(Array.from(line).length).toBeLessThanOrEqual(MAX_CHUNK_LINE_CHARS + 1)
    expect(line.endsWith('…')).toBe(true)
  })

  it('不截断刚好合规的行', () => {
    const s = createChunkStore()
    s.push('n', 'a'.repeat(MAX_CHUNK_LINE_CHARS))
    expect(s.lines('n')[0]).not.toContain('…')
  })

  it('剥掉控制字节 —— 这条路径的文本从模型直达终端,从不落盘', () => {
    // Every other field is sanitised by persistence.stripControl on the way to disk. Chunk
    // text never goes to disk, so nothing sanitised it: measured, a chunk containing an ANSI
    // colour sequence reached the terminal byte stream intact.
    const s = createChunkStore()
    const esc = String.fromCharCode(27)
    s.push('n', esc + '[2J' + esc + '[31m我把屏幕清了')
    const line = s.lines('n')[0]
    expect(line).not.toContain(esc)
    expect(line).toContain('我把屏幕清了')
  })

  it('一条只有控制字节的消息不会留下一行空白', () => {
    const s = createChunkStore()
    s.push('n', String.fromCharCode(27) + String.fromCharCode(7))
    expect(s.lines('n')).toEqual([])
  })
})
