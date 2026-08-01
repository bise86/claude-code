/**
 * 「子 agent 输出有没有调用 tools、mcp 这些」—— 把答案钉成一个可证伪的实验。
 *
 * 这条链有五段,每一段都被单独测过,而**整条**从来没有:
 *   工具池 → runAgent 的分档 → tool_use 消息 → eventsFromMessage → renderStreamLines
 * 中间任何一段退化,单测都还是绿的,而用户看到的是一片空白 —— 他报的正是这个。
 *
 * 这里用真的池子函数、真的 MCP `userFacingName` 形状、真的事件抽取、真的渲染,
 * 把最终打到终端上的那几行字**逐字**钉住。
 */
import { describe, expect, it } from 'bun:test'

import { subAgentToolPool } from '../../commands/efftask/efftask.js'
import { renderStreamLines } from '../../commands/efftask/logView.js'
import { eventsFromMessage } from './agentEvents.js'
import { createStreamStore } from './agentStream.js'
import type { Message } from '../../types/message.js'

/**
 * MCP 工具的 `userFacingName` —— 和 services/mcp/client.ts 里那一句逐字同构:
 * `` `${client.name} - ${displayName} (MCP)` ``。
 * 抄形状而不是 import 真的:真的那个要一个连上的 MCP 客户端。
 */
const mcpTool = (server: string, tool: string, title?: string) => ({
  name: `mcp__${server}__${tool}`,
  userFacingName: () => `${server} - ${title ?? tool} (MCP)`,
})

const TOOLS = [
  { name: 'Read', userFacingName: () => 'Read' },
  { name: 'Bash', userFacingName: () => 'Bash' },
  { name: 'Edit', userFacingName: () => 'Edit' },
  { name: 'Write', userFacingName: () => 'Write' },
  { name: 'NotebookEdit', userFacingName: () => 'NotebookEdit' },
  { name: 'Skill', userFacingName: () => 'Skill' },
  { name: 'TaskOutput', userFacingName: () => 'TaskOutput' },
  mcpTool('gitlab', 'list_issues', 'List Issues'),
  mcpTool('ctx7', 'resolve-library-id'),
]

/** 和 efftask.tsx:295 的 briefResolver 逐字同构。 */
const resolver = (name: string, input: unknown): string | undefined => {
  const t = TOOLS.find(x => x.name === name)
  try {
    return t?.userFacingName?.()
  } catch {
    return undefined
  }
}

describe('MCP 工具进不进得了子 agent 的工具池', () => {
  /**
   * 池子是**黑名单**,所以 `mcp__*` 今天全在。
   *
   * 这条断言的价值不在「现在是对的」,在于**以后**:黑名单意味着有人往里加一条
   * `mcp__` 前缀就能把所有环节的 MCP 静默拿掉,而现有测试一条都不会红。
   *
   * 曾经这里按环节分三档,现在只有一个 —— 七个环节共用。
   */
  const names = (ts: { name: string }[]) => ts.map(t => t.name)
  it('MCP 全在,写工具也全在(分档取消之后各环节同一份)', () => {
    const pool = names(subAgentToolPool(TOOLS))
    expect(pool).toContain('mcp__gitlab__list_issues')
    expect(pool).toContain('mcp__ctx7__resolve-library-id')
    // 顺带钉住写工具 —— 它们现在也在,而且这就是取消分档的那个代价本身。
    expect(pool).toContain('Edit')
    expect(pool).toContain('Bash')
  })
  it('不给 Skill —— 它要主循环塞进消息里的技能清单', () => {
    expect(names(subAgentToolPool(TOOLS))).not.toContain('Skill')
  })
})

const assistantToolUse = (calls: { id: string; name: string; input: unknown }[]): Message =>
  ({
    type: 'assistant',
    message: { content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) },
  }) as unknown as Message

const userToolResult = (rs: { id: string; content: unknown; isError?: boolean }[]): Message =>
  ({
    type: 'user',
    message: {
      content: rs.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError === true })),
    },
  }) as unknown as Message

describe('一次 MCP 调用在窗口里长什么样', () => {
  it('server、工具名、(MCP) 标记、参数、返回、耗时,一样都不能少', () => {
    let t = 1000
    const store = createStreamStore({ now: () => t })
    const h = store.open({ nodeId: 'n', phaseLabel: '方案', label: '架构师', model: 'deepseek-reasoner' })
    for (const e of eventsFromMessage(
      assistantToolUse([{ id: 'u1', name: 'mcp__gitlab__list_issues', input: { project: 'acme/web' } }]),
      resolver,
    )) h.push(e)
    t += 1800
    for (const e of eventsFromMessage(
      userToolResult([{ id: 'u1', content: '#412 登录页 500' }]),
      resolver,
    )) h.push(e)

    const lines = renderStreamLines({
      streams: store.streams('n'),
      folded: new Set(),
      selected: 0,
      nowMs: t,
      width: 200,
    }).map(l => l.text)

    // 调用行:server + 工具标题 + (MCP) 标记 + 真实参数。
    const call = lines.find(l => l.includes('list') || l.includes('List'))
    expect(call).toBeDefined()
    expect(call).toContain('gitlab - List Issues (MCP)(acme/web)')
    // 返回行:⎿ + 耗时 + 返回首行。
    const ret = lines.find(l => l.includes('#412'))
    expect(ret).toBeDefined()
    expect(ret).toContain('⎿ 1.8s · #412 登录页 500')
  })

  it('MCP 报错要标红,而且报错原文要在', () => {
    const store = createStreamStore({ now: () => 1000 })
    const h = store.open({ nodeId: 'n', phaseLabel: '验收', label: '验收员' })
    for (const e of eventsFromMessage(
      assistantToolUse([{ id: 'u1', name: 'mcp__ctx7__resolve-library-id', input: { libraryName: 'react-router' } }]),
      resolver,
    )) h.push(e)
    for (const e of eventsFromMessage(
      userToolResult([{ id: 'u1', content: 'MCP error -32001: Request timed out after 30000ms', isError: true }]),
      resolver,
    )) h.push(e)

    const lines = renderStreamLines({
      streams: store.streams('n'), folded: new Set(), selected: 0, nowMs: 1000, width: 200,
    })
    const ret = lines.find(l => l.text.includes('-32001'))!
    expect(ret.text).toContain('MCP error -32001')
    // 颜色是主题键,不是裸色名 —— 写错的话 vendored ink 会解析成 undefined,
    // 「标红了」和「没标」在屏幕上一模一样。
    expect(ret.color).toBe('error')
  })

  it('两个 MCP 调用并行、返回错序时,每条返回都说清自己属于谁', () => {
    let t = 1000
    const store = createStreamStore({ now: () => t })
    const h = store.open({ nodeId: 'n', phaseLabel: '方案', label: '架构师' })
    for (const e of eventsFromMessage(
      assistantToolUse([
        { id: 'u1', name: 'mcp__gitlab__list_issues', input: { project: 'acme/web' } },
        { id: 'u2', name: 'mcp__ctx7__resolve-library-id', input: { libraryName: 'react-router' } },
      ]),
      resolver,
    )) h.push(e)
    t += 900
    // 两条返回一起到,顺序和调用顺序相同 —— 但中间隔着另一次调用行,
    // 所以第一条 `⎿` 在屏幕上紧跟的是 **ctx7** 那一行。
    for (const e of eventsFromMessage(
      userToolResult([
        { id: 'u1', content: '#412 登录页 500' },
        { id: 'u2', content: '/remix-run/react-router' },
      ]),
      resolver,
    )) h.push(e)

    const lines = renderStreamLines({
      streams: store.streams('n'), folded: new Set(), selected: 0, nowMs: t, width: 200,
    }).map(l => l.text)
    const first = lines.find(l => l.includes('#412'))!
    expect(first).toContain('gitlab - List Issues (MCP)(acme/web)')
    // 第二条的上一行是第一条返回(不是它自己的调用行),同样要报归属。
    const second = lines.find(l => l.includes('/remix-run/'))!
    expect(second).toContain('ctx7 - resolve-library-id (MCP)(react-router)')
  })
})
