/**
 * 用**真工具的 userFacingName** 跑一遍工具摘要。
 *
 * 用户报的:「子 agent 输出里,有 READ 但是没有具体的文件或目录路径,有 BASH 但是没有
 * 具体的命令。这是一类的问题,要通用的去解决。」
 *
 * 之前这条链只被假 resolver 测过(`() => '注入的摘要'`),而假的那个**恰好**返回了带内容
 * 的字符串——真的那些返回的是工具显示名。所以那一档全绿,而生产上一个参数都没有。
 * 这一档接的是 efftask.tsx 里那个 briefResolver 的**同一份实现**:从工具表里找 userFacingName
 * 并调用它。
 */
import { describe, expect, it } from 'bun:test'

import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { briefOfToolUse } from './agentEvents.js'

/** 和 efftask.tsx 里那个 briefResolver 逐字同构 —— 换掉它就等于换掉生产行为。 */
const TOOLS = [BashTool, FileReadTool, FileEditTool, GlobTool, GrepTool] as unknown as {
  name: string
  userFacingName?: (i: unknown) => string
}[]
const resolver = (name: string, input: unknown): string | undefined => {
  const t = TOOLS.find(x => x.name === name)
  try {
    return t?.userFacingName?.(input)
  } catch {
    return undefined
  }
}

const brief = (name: string, input: unknown): string => briefOfToolUse(name, input, resolver)

describe('真工具的摘要里必须有参数', () => {
  it('Read 带上文件路径', () => {
    // FileReadTool 的 userFacingName 返回 'Read' —— 不看输入。这就是那个 bug 的形状。
    expect(brief('Read', { file_path: '/repo/src/app.tsx' })).toContain('/repo/src/app.tsx')
  })

  it('Bash 带上命令', () => {
    expect(brief('Bash', { command: 'bun test src/a.test.ts' })).toContain('bun test src/a.test.ts')
  })

  it('Edit 带上文件路径', () => {
    expect(brief('Edit', { file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' }))
      .toContain('/repo/src/b.ts')
  })

  it('Glob 带上匹配式', () => {
    expect(brief('Glob', { pattern: '**/*.tsx' })).toContain('**/*.tsx')
  })

  it('Grep 带上匹配式和路径', () => {
    const b = brief('Grep', { pattern: 'useEffect', path: 'src' })
    expect(b).toContain('useEffect')
    expect(b).toContain('src')
  })

  it('Edit 的输入里 old_string 排在前面时,取的仍然是路径', () => {
    // 兜底那条是「第一个非空字符串属性」。模型吐的 JSON 字段顺序不由我们决定,
    // old_string 排在前面时兜底会把**被替换的代码片段**当成摘要 ——
    // 一行 'const a = 1' 出现在 Edit 后面,读起来像它在编辑一个叫这个名字的文件。
    expect(brief('Edit', { old_string: 'const a = 1', new_string: 'const a = 2', file_path: '/repo/x.ts' }))
      .toContain('/repo/x.ts')
  })

  it('Bash 的输入里 description 排在前面时,取的仍然是命令', () => {
    // 同上:用户要看的是**跑了什么命令**,不是模型给自己写的说明。
    const b = brief('Bash', { description: '跑一遍测试', command: 'bun test src/a.ts' })
    expect(b).toContain('bun test src/a.ts')
    expect(b).not.toContain('跑一遍测试')
  })
  it('没进过静态表的工具(含 mcp__*)靠兜底也拿得到参数', () => {
    // 兜底是「第一个非空的字符串型属性」。工具表里根本没有它,resolver 返回 undefined。
    expect(brief('mcp__db__query', { sql: 'select 1' })).toBe('mcp__db__query(select 1)')
  })

  it('输入为空时不硬凑,只给工具名', () => {
    // 凑一个假参数比没有更糟。
    expect(brief('Read', {})).toBe('Read')
    expect(brief('Bash', undefined)).toBe('Bash')
  })
})

describe('每一个真工具都不能只剩一个名字', () => {
  // 逐个跑一遍,而不是挑几个:这条 bug 的性质是「凡是 userFacingName 不看输入的工具都中招」,
  // 而那是多数。挑几个测就会漏掉下一个。
  const cases: [string, Record<string, unknown>][] = [
    ['Bash', { command: 'ls -la' }],
    ['Read', { file_path: '/x/y.ts' }],
    ['Edit', { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' }],
    ['Glob', { pattern: '*.ts' }],
    ['Grep', { pattern: 'foo' }],
  ]
  for (const [name, input] of cases) {
    it(`${name} 的摘要不等于光秃秃的工具名`, () => {
      const b = brief(name, input)
      expect(`${name} 的摘要: ${b}`).not.toBe(`${name} 的摘要: ${name}`)
      expect(b).toContain('(')
    })
  }
})
