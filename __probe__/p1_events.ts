// PROBE 1: eventsFromMessage on REAL-shaped messages built by the repo's own factories.
import { createUserMessage, createAssistantMessage } from '../src/utils/messages.js'
import { eventsFromMessage, briefOfToolUse, briefOfToolResult } from '../src/tools/efftask/agentEvents.js'

const show = (label: string, v: unknown) => console.log(label, JSON.stringify(v))

// --- A. assistant with text + thinking + tool_use, all in ONE message (real shape) ---
const a = createAssistantMessage({
  content: [
    { type: 'thinking', thinking: '我先读一下这个文件\n然后再决定', signature: 'sig' } as never,
    { type: 'text', text: '好的,我来看看。' } as never,
    { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/home/hezx/tb/claude-code/src/a.ts' } } as never,
    { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'bun test\n# 第二行' } } as never,
  ],
})
show('A assistant  =', eventsFromMessage(a))

// --- B. user tool_result (real shape from the repo's own factory) ---
const u = createUserMessage({
  content: [
    { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: '1\tconst x = 1\n2\tconst y = 2' }] },
  ],
})
show('B user ok    =', eventsFromMessage(u))

const uerr = createUserMessage({
  content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'command not found: bunx', is_error: true }],
})
show('C user err   =', eventsFromMessage(uerr))

// --- D. assistant with string content (createAssistantMessage normalizes to array) ---
const s = createAssistantMessage({ content: '一行\n二行\n三行' })
show('D str->arr   =', eventsFromMessage(s))
console.log('   D raw content =', JSON.stringify((s as never as { message: { content: unknown } }).message.content))

// --- E. redacted_thinking ---
show('E redacted   =', eventsFromMessage(createAssistantMessage({ content: [{ type: 'redacted_thinking', data: 'xx' } as never] })))

// --- F. empty content '' -> NO_CONTENT_MESSAGE substitution ---
show('F empty      =', eventsFromMessage(createAssistantMessage({ content: '' })))

// --- G. content is a raw string on message.content (the variant the comment claims exists) ---
const g = { type: 'assistant', message: { content: 'raw string content' } }
show('G raw string =', eventsFromMessage(g as never))

// --- H. brief resolver injection ---
show('H resolver   =', eventsFromMessage(a, (n, i) => (n === 'Read' ? 'src/a.ts (1-40)' : undefined)))

// --- I. resolver that THROWS ---
show('I res throws =', eventsFromMessage(a, () => { throw new Error('boom') }))

// --- J. briefOfToolUse direct, malformed inputs that normalizeContentFromAPI can produce ---
for (const input of [null, undefined, [1, 2], 5, '"x"', {}, { file_path: 123 }, { command: '' }]) {
  console.log('J briefOfToolUse Read', JSON.stringify(input), '=>', JSON.stringify(briefOfToolUse('Read', input)))
}
for (const c of [null, undefined, '', [], [{ type: 'image' }], [{ type: 'text', text: '  ' }], 42]) {
  console.log('J briefOfToolResult', JSON.stringify(c), '=>', JSON.stringify(briefOfToolResult(c)))
}

// --- K. mcp tool fallback ---
show('K mcp        =', eventsFromMessage(createAssistantMessage({
  content: [{ type: 'tool_use', id: 'x', name: 'mcp__feishu__send', input: { chat_id: 'oc_123', text: '发一条' } } as never],
})))

// --- L. tool_use with NO id and NO name ---
show('L noid       =', eventsFromMessage(createAssistantMessage({
  content: [{ type: 'tool_use', input: { a: 'b' } } as never],
})))
