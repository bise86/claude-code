/**
 * 结构闸门:那条「别人机器上的路径」提示真的接到了两个报错点上。
 *
 * **这条闸门证明的是「那行字还在」,不是「行为正确」。** 行为由
 * foreignHomePath.test.ts 钉住(判据的正反两面 + 不该误报的六种)。这里补的是中间那一跳。
 *
 * 为什么只能这么测:FileReadTool / FileEditTool **一个测试文件都没有**(实测
 * `ls src/tools/FileReadTool/*.test.*` 为空),它们的 call 是异步生成器,要跑起来得造
 * ToolUseContext、权限上下文、readFileState、消息 id 一整套。而这一跳恰恰是最容易被
 * 剪断的:纯函数写好了、单测全绿、生产上零调用点 —— 这个仓库反复付过这个代价。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const READ = readFileSync(
  new URL('../tools/FileReadTool/FileReadTool.ts', import.meta.url), 'utf8',
)
const EDIT = readFileSync(
  new URL('../tools/FileEditTool/FileEditTool.ts', import.meta.url), 'utf8',
)

describe('foreignHomePathHint 的接线', () => {
  for (const [name, src] of [['FileReadTool', READ], ['FileEditTool', EDIT]] as const) {
    it(`${name} 在「文件不存在」时调用它,并把结果拼进去`, () => {
      // 拆成两条断言:只查函数名的话,一个「算了但没用上」的调用照样满足。
      expect(src).toContain('foreignHomePathHint(fullFilePath, getCwd())')
      expect(src).toMatch(/if \(foreign\) message \+= ` \$\{foreign\}`/)
    })

    it(`${name} 的提示排在 cwd 那句之后 —— 顺序反了读起来是两句不相干的话`, () => {
      const iMsg = src.indexOf('let message = `File does not exist.')
      const iForeign = src.indexOf('foreignHomePathHint(fullFilePath, getCwd())')
      expect(iMsg).toBeGreaterThanOrEqual(0)
      expect(iForeign).toBeGreaterThan(iMsg)
    })
  }
})
