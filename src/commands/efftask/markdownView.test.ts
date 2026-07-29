import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import chalk from 'chalk'
import { clearMarkdownCache, hasMarkdownSyntax, inlineMarkdown, markdownLines, markdownToAnsi, squashBlankLines } from './markdownView.js'
import { stripAnsiAtoms } from './ansiText.js'
import { sectionLines, renderStreamLines, type SectionSpec } from './logView.js'
import { stringWidth } from '../../ink/stringWidth.js'

/**
 * **测试进程默认没有颜色**(不是 TTY),而没有颜色时这一层是**整个短路**的
 * (见 markdownToAnsi 第一句)。不强开的话,下面每一条断言测的都是那条短路,
 * 而 markdown 渲染本身零覆盖 —— 正是「测试全绿而功能不存在」的那种形状。
 */
const saved = chalk.level
beforeAll(() => { chalk.level = 3 })
afterAll(() => { chalk.level = saved })
beforeEach(() => { clearMarkdownCache() })

const THEME = 'dark'
/** 可见文本 —— 断言内容时用它,断言「上没上色」时用原串。 */
const plain = (s: string): string => stripAnsiAtoms(s)
const styled = (s: string): boolean => s.includes('\u001b')

describe('markdownToAnsi', () => {
  it('标题、加粗、行内代码、引用都上色,而记号本身被吃掉', () => {
    const out = markdownToAnsi('## 方案\n\n先做 **A**,再调 `b()`。\n\n> 注意', THEME)
    expect(out.map(plain)).toEqual(['方案', '', '先做 A,再调 b()。', '', '▎ 注意'])
    for (const l of out.filter(l => l.trim().length > 0)) expect(styled(l)).toBe(true)
  })

  it('列表和表格保留结构 —— 这两样是「好看」的主要来源', () => {
    const list = markdownToAnsi('- 甲\n- 乙\n\n1. 一\n2. 二', THEME).map(plain)
    expect(list).toEqual(['- 甲', '- 乙', '', '1. 一', '2. 二'])
    const table = markdownToAnsi('| 列一 | 二 |\n| --- | --- |\n| a | bbbb |', THEME).map(plain)
    // 按列宽对齐,不是原样吐出来 —— 断言的是「每一行等宽」这个性质,不是某个空格数:
    // 后者会被列宽算法的任何一次微调打红,而它根本不是这条用例要守的东西。
    expect(table).toHaveLength(3)
    expect(new Set(table.map(l => stringWidth(l))).size).toBe(1)
    // 中文列头也参与列宽计算(按显示宽度,不是按码点)。
    expect(table[0]).toContain('列一')
    expect(table[2]).toContain('bbbb')
  })

  it('终端不支持颜色时**原样返回** —— 剥掉记号又不上色是纯粹的信息损失', () => {
    chalk.level = 0
    try {
      expect(markdownToAnsi('## 标题\n\n**粗**', THEME)).toEqual(['## 标题', '', '**粗**'])
    } finally {
      chalk.level = 3
    }
  })

  it('marked 抛了也不许把整屏带走 —— 它只负责好看', () => {
    // 畸形输入不该抛,但 marked 是外部库,而这一层跑在渲染路径上。
    const weird = '|'.repeat(500) + '\n' + '['.repeat(500)
    expect(() => markdownToAnsi(weird, THEME)).not.toThrow()
    expect(markdownToAnsi('', THEME)).toEqual([])
  })
})

describe('squashBlankLines', () => {
  it('掐掉首尾空行、连续空行压成一行', () => {
    // formatToken 给标题补的是**两个** EOL,而详情页每段默认只有 3 行预览。
    expect(squashBlankLines('\n\na\n\n\n\nb\n\n')).toEqual(['a', '', 'b'])
  })
  it('单个空行留着 —— 段落之间那一行正是「好看」的来源', () => {
    expect(squashBlankLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})

describe('markdownLines 折行', () => {
  it('每一行的**可见**宽度都不超过给定列宽', () => {
    // 「一条 ViewLine = 一个终端行」是详情页和日志窗共同的硬不变量。转义序列一旦被算进
    // 宽度,行就会回流成两行,而滚动条的位置是按 total/height 算的 —— 它当场指错。
    const body = '## 一个很长的中文标题会被折行\n\n**加粗的一大段**中文正文' + '啊'.repeat(60)
    for (const w of [20, 33, 40]) {
      for (const l of markdownLines(body, w, THEME)) {
        expect(`${w}: ${stringWidth(l)} <= ${w}`).toBe(`${w}: ${stringWidth(l)} <= ${w}`)
        expect(stringWidth(l)).toBeLessThanOrEqual(w)
      }
    }
  })

  it('折行之后样式接得上', () => {
    const out = markdownLines('**' + '粗'.repeat(20) + '**', 10, THEME)
    expect(out.length).toBeGreaterThan(1)
    for (const l of out) expect(styled(l)).toBe(true)
  })
})

describe('inlineMarkdown(单行)', () => {
  it('一行进一行出 —— 上游按行算高度,多一行当场对不上', () => {
    for (const src of ['## 标题', '- 项 **粗**', '1. 有序', 'x `code` y', '> 引用', '普通一句话']) {
      expect(`${src} → ${inlineMarkdown(src, THEME).includes('\n')}`).toBe(`${src} → false`)
    }
  })

  it('没有 markdown 记号的行原样返回 —— 绝大多数行走这条快路径', () => {
    // 日志窗每秒重画,一次 marked.lexer 约 3ms,几千行就是几秒。
    const s = '模型说了一句普通的话'
    expect(hasMarkdownSyntax(s)).toBe(false)
    expect(inlineMarkdown(s, THEME)).toBe(s)
  })

  it('缓存命中给同一个结果,而且不串主题', () => {
    const a = inlineMarkdown('**粗**', 'dark')
    expect(inlineMarkdown('**粗**', 'dark')).toBe(a)
    // 主题进了 key:行内代码那一档是主题色,两套主题不该互相看见对方的结果。
    expect(inlineMarkdown('`c`', 'dark')).not.toBe(inlineMarkdown('`c`', 'light'))
  })

  it('空行不动', () => {
    expect(inlineMarkdown('', THEME)).toBe('')
  })
})

describe('详情页段落', () => {
  /** 默认**带**主题 —— 忘了传的话每一条断言都在测「没主题」那条回退路径。 */
  const render = (sections: SectionSpec[], theme: 'dark' | undefined = THEME): ReturnType<typeof sectionLines> =>
    sectionLines({ sections, cursor: -1, expanded: new Set(), width: 60, collapsedLines: 20, theme })

  it('md 段落上色并标 ansi;机器生成的那几段一个字节都不动', () => {
    const { lines } = render([
      { title: '完整方案', body: '先做 **A**', md: true },
      { title: '依赖', body: 'root/01-a(DONE)' },
    ])
    const body = lines.filter(l => !l.bold)
    const prose = body.find(l => plain(l.text).includes('先做'))!
    expect(prose.ansi).toBe(true)
    expect(plain(prose.text).trim()).toBe('先做 A')
    const dep = body.find(l => l.text.includes('root/01-a'))!
    // 机器生成的段落:不上色、保留原来的 dim,`(DONE)` 那种括号也没被解析器碰过。
    expect(dep.ansi).toBeUndefined()
    expect(dep.dim).toBe(true)
    expect(dep.text.trim()).toBe('root/01-a(DONE)')
  })

  it('带语义颜色的段落不上 markdown —— 那层红色是「这条把节点挡下来了」', () => {
    const { lines } = render([{ title: '阻断原因', body: '验收迭代超限(3):缺 **测试**', color: 'error', md: true }])
    const body = lines.find(l => l.text.includes('验收迭代超限'))!
    expect(body.ansi).toBeUndefined()
    expect(body.color).toBe('error')
    // 记号原样留着 —— 这一条才是「真的没上 markdown」的证据:上了的话 `**` 会被吃掉。
    expect(body.text).toContain('缺 **测试**')
  })

  it('没传主题就完全走老路径 —— 一堆纯算术的调用点不该为了算行数去造一个主题', () => {
    // 直接调 sectionLines,不走上面那个 helper —— 它的默认值就是 THEME,
    // 传一个显式的 undefined 照样会被默认值顶掉(上一版就是这么绿的)。
    const { lines } = sectionLines({
      sections: [{ title: '完整方案', body: '先做 **A**', md: true }],
      cursor: -1, expanded: new Set(), width: 60, collapsedLines: 20,
    })
    const body = lines.find(l => l.text.includes('先做'))!
    expect(body.ansi).toBeUndefined()
    expect(body.text).toContain('**A**')
  })

  it('上色之后每一行仍然只占一个终端行', () => {
    const long = '**' + '重点'.repeat(40) + '**'
    const { lines } = sectionLines({
      sections: [{ title: '重点', body: long, md: true }],
      cursor: -1, expanded: new Set(['重点']), width: 41, collapsedLines: 20, theme: THEME,
    })
    // 段落正文缩进 4 列,宽度按 width-4 算,所以整行不超过 width。
    for (const l of lines) expect(stringWidth(l.text)).toBeLessThanOrEqual(41)
  })
})

describe('子 agent 输出', () => {
  const stream = (texts: string[]): never => ({
    meta: { phaseLabel: '执行', label: '员工甲' },
    events: texts.map(text => ({ kind: 'text', text })),
    startedAt: 0, endedAt: 1, closed: true, toolCount: 0, dropped: 0,
  }) as never

  const body = (texts: string[], theme?: 'dark'): { text: string; ansi?: boolean }[] =>
    renderStreamLines({ streams: [stream(texts)], folded: new Set(), selected: 0, nowMs: 1, width: 60, theme })
      .filter(l => l.isHeader !== true)

  it('模型说的话按 markdown 上色', () => {
    const out = body(['先做 **A**'], THEME)
    expect(out[0]!.ansi).toBe(true)
    expect(plain(out[0]!.text)).toContain('先做 A')
  })

  it('代码围栏里**不上色** —— 里面的 `#`、`*ptr`、`__init__` 都不是 markdown', () => {
    const out = body(['说明:', '```py', '# 这是注释,不是标题', 'a = b * c', '```', '**说明结束**'], THEME)
    const at = (i: number): { text: string; ansi?: boolean } => out[i]!
    // 围栏行本身照原样画出来 —— 删掉它人就分不清代码从哪开始。
    expect(at(1).text).toContain('```py')
    expect(at(1).ansi).toBeUndefined()
    expect(at(2).ansi).toBeUndefined()
    expect(at(2).text).toContain('# 这是注释,不是标题')
    expect(at(3).ansi).toBeUndefined()
    expect(at(3).text).toContain('a = b * c')
    // 围栏合上之后恢复上色。
    expect(at(5).ansi).toBe(true)
  })

  it('工具调用和工具返回**不上色** —— 里面全是路径、--flag、[TAG]', () => {
    const s = {
      meta: { phaseLabel: '执行', label: '员工甲' },
      events: [
        { kind: 'tool', useId: 'u1', name: 'Bash', brief: 'bun test --coverage src/a_b.ts **全量**' },
        { kind: 'result', useId: 'u1', brief: '[PASS] 2 files,`login.test.ts` 通过', isError: false },
      ],
      startedAt: 0, endedAt: 1, closed: true, toolCount: 1, dropped: 0,
    } as never
    const out = renderStreamLines({ streams: [s], folded: new Set(), selected: 0, nowMs: 1, width: 60, theme: THEME })
      .filter(l => l.isHeader !== true)
    for (const l of out) expect(l.ansi).toBeUndefined()
    const all = out.map(l => l.text).join('\n')
    expect(all).toContain('--coverage src/a_b.ts')
    // 记号原样留着。marked 会把这两处分别加粗、上行内代码色 —— 它们还在,就说明没走那条路。
    expect(all).toContain('**全量**')
    expect(all).toContain('`login.test.ts`')
  })

  it('思考行上了色也还是暗的 —— 少了 dim 就分不清哪句是想的、哪句是说的', () => {
    const s = {
      meta: { phaseLabel: '执行', label: '员工甲' },
      events: [{ kind: 'thinking', text: '思考:**关键**在这里' }],
      startedAt: 0, endedAt: 1, closed: true, toolCount: 0, dropped: 0,
    } as never
    const out = renderStreamLines({
      streams: [s], folded: new Set(), selected: 0, nowMs: 1, width: 60,
      theme: THEME, expandedThinking: new Set([0]),
    }).filter(l => l.isHeader !== true && plain(l.text).includes('关键'))
    expect(out).toHaveLength(1)
    // 两个都要,不是二选一:<Ansi dimColor> 压暗整行的同时保住行内的加粗。
    expect(out[0]!.ansi).toBe(true)
    expect(out[0]!.dim).toBe(true)
  })

  it('没传主题时逐字回到老行为', () => {
    const out = body(['先做 **A**'])
    expect(out[0]!.ansi).toBeUndefined()
    expect(out[0]!.text).toContain('**A**')
  })
})
