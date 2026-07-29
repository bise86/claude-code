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

  it('表格排得下才对齐,排不下退回原文 —— 而不是撑爆窗口', () => {
    /**
     * `formatToken` 的表格分支把每列补齐到自然宽度,**完全不看窗口**。验收实测:源文
     * 46 列的表被撑到 115 列,100 列终端上 5 行变 8 行,续行行首没有 `|`,列全乱 ——
     * 比不上 markdown 的时候更难看。
     */
    // 四行,而且列宽不齐 —— 对齐版一定比源文宽,这正是它排不下时的问题所在。
    const tbl = '| 环节 | 谁 | 何时 |\n| --- | --- | --- |\n| 分析 | 架构评审员 | 一开始 |\n| 执行 | 执行者 | 方案过了之后 |'
    const rawWidest = Math.max(...tbl.split('\n').map(l => stringWidth(l)))
    const wide = markdownToAnsi(tbl, THEME, 200).map(plain)
    const alignedWidest = Math.max(...wide.map(stringWidth))
    // 宽松时用对齐版(它比源文宽,这正是它排不下时的问题所在)。
    expect(alignedWidest).toBeGreaterThan(rawWidest)
    // 紧张时退回源文 —— 逐字节等于原文,而且一定不比对齐版宽。
    const narrow = markdownToAnsi(tbl, THEME, alignedWidest - 1).map(plain)
    expect(narrow).toEqual(tbl.split('\n'))
    expect(Math.max(...narrow.map(stringWidth))).toBeLessThan(alignedWidest)
  })

  it('任务清单的勾选标记不许被剥掉', () => {
    // formatToken 不看 `list_item.task` / `.checked`:「已完成」和「未完成」渲染出来
    // 一模一样,而且那一档一个转义都没发 —— 纯损失。而勾没勾上恰恰是读的人最想知道的。
    const out = markdownToAnsi('- [x] 建表\n- [ ] 写接口', THEME, 100).map(plain)
    expect(out).toEqual(['- [x] 建表', '- [ ] 写接口'])
    // 普通列表不受影响,照常上色。
    expect(markdownToAnsi('- 建表', THEME, 100).map(plain)).toEqual(['- 建表'])
  })

  it('`<...>` 里的内容一个字都不许被删掉 —— 这是个 TSX 仓库', () => {
    /**
     * `formatToken` 对 html token 是 `case 'html': return ''`。而 marked 把 `<Text …>`、
     * `<Box … />`、`Array<Uint8Array>` 一律认成 HTML —— 评审用真渲染量到的原样是:
     *
     *     写的:把 ScrollPane 的 <Text> 换成 <Ansi dimColor>,保留 Map<string, TaskNode>。
     *     屏幕:把 ScrollPane 的 换成 ,保留 Map。
     *
     * 这不是记号被吃掉,是**正文被删掉**,而且屏幕上看不出来。方案里写 `<Box>`、评审员
     * 写「缺 `<Suspense>` 边界」是这个仓库的常态。
     */
    const cases = [
      '把 ScrollPane 的 <Text> 换成 <Ansi dimColor>',
      '参数 Array<Uint8Array> 要显式写出来',
      '新增 <Box flexGrow={1} /> 占位',
      '<div class="warn">块级的也一样</div>',
    ]
    for (const src of cases) {
      expect(`${src} → ${markdownToAnsi(src, THEME, 200).map(plain).join('')}`).toBe(`${src} → ${src}`)
    }
    // 单行那条路径(子 agent 输出)同样。
    expect(inlineMarkdown('把 <Text> 换成 <Ansi>', THEME)).toBe('把 <Text> 换成 <Ansi>')
  })

  it('关掉 HTML 之后,其余记号照常上色 —— 不是把 markdown 整个关了', () => {
    const out = markdownToAnsi('## 标题\n\n**粗** 和 `码` 和 <Box>', THEME, 200)
    expect(out.map(plain)).toEqual(['标题', '', '粗 和 码 和 <Box>'])
    for (const l of out.filter(l => l.trim().length > 0)) expect(styled(l)).toBe(true)
  })

  it('终端不支持颜色时**原样返回** —— 剥掉记号又不上色是纯粹的信息损失', () => {
    chalk.level = 0
    try {
      expect(markdownToAnsi('## 标题\n\n**粗**', THEME)).toEqual(['## 标题', '', '**粗**'])
    } finally {
      chalk.level = 3
    }
  })

  it('模型写的东西一行都不许凭空消失', () => {
    /**
     * `formatToken` 对 `def` / `del` / `html` 和一切未知 token **返回空串**
     * (源码原话:「These token types are not rendered」)。在主对话流里无所谓,
     * 在详情页不行 —— 实测这两行会整行没了,而模型确实会写 HTML 和注释。
     * 一个残缺的视图看起来完完整整,正是这个仓库反复付学费的形状。
     */
    const body = '前面一句\n\n<div class="warn">这段话在 div 里</div>\n\n<!-- 这是注释 -->\n\n后面一句'
    const out = markdownToAnsi(body, THEME).map(plain)
    expect(out).toContain('<div class="warn">这段话在 div 里</div>')
    expect(out).toContain('<!-- 这是注释 -->')
    expect(out[0]).toBe('前面一句')
    expect(out[out.length - 1]).toBe('后面一句')
  })

  it('代码块保住围栏,而且围栏是暗的 —— 不然代码和散文长得一模一样', () => {
    // formatToken 的 code 分支在没有 highlight 实例时返回**裸的** token.text:
    // 围栏没了、也没有任何样式。而这个功能的名字叫「更加好看美观」。
    const out = markdownToAnsi('```ts\nconst a = 1\n```\n\n后面', THEME)
    expect(out.map(plain)).toEqual(['```ts', 'const a = 1', '```', '', '后面'])
    expect(styled(out[0]!)).toBe(true) // 围栏压暗
    expect(styled(out[2]!)).toBe(true)
    expect(styled(out[1]!)).toBe(false) // 代码正文原样 —— 压暗它会真的变难读
  })

  it('原文没有收尾围栏时**不补一个** —— 补了就是替模型宣称代码到此为止', () => {
    const out = markdownToAnsi('未闭合:\n```ts\nconst a = 1', THEME).map(plain)
    expect(out).toEqual(['未闭合:', '```ts', 'const a = 1'])
  })

  it('缩进式代码块(四个空格)没有围栏可保,原样交给 formatToken', () => {
    const out = markdownToAnsi('    const a = 1', THEME).map(plain)
    expect(out).toEqual(['const a = 1'])
  })

  it('同一段正文只解析一次 —— 详情页每一次按键都会重画', () => {
    /**
     * 实测:8 个 markdown 段落、每段 3000 字,一帧 39.7ms,不上 markdown 是 5.9ms。
     * 而详情页不只每秒重画一次,**每一次按键也重画一次**(滚动、展开、换页卡)——
     * 按住 j 滚动时那 40ms 是看得见的迟滞。加缓存之后是 5.0ms。
     *
     * 断言的是**同一个数组引用**:内容相等的断言在「每次都重新解析」的世界里照样绿。
     */
    const body = '## 标题\n\n正文 **粗**'
    const a = markdownToAnsi(body, THEME)
    expect(markdownToAnsi(body, THEME)).toBe(a)
    // 主题进 key —— 两套主题不该互相看见对方的结果。
    expect(markdownToAnsi(body, 'light')).not.toBe(a)
    clearMarkdownCache()
    expect(markdownToAnsi(body, THEME)).not.toBe(a)
  })

  it('超长正文不进缓存 —— execStatus 是逐轮追加的,每追加一轮 key 就变了', () => {
    // 缓存它等于把同一份内容在内存里多留一整份,而它恰恰最不可能被反复命中。
    const huge = '正文。'.repeat(20_000)
    expect(huge.length).toBeGreaterThan(40_000)
    expect(markdownToAnsi(huge, THEME)).not.toBe(markdownToAnsi(huge, THEME))
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

  it('渲染成 0 行或多行时都退回原文 —— 一行进必须一行出', () => {
    /**
     * 两类都真的存在,不是假想的防御:
     *  - `<div>x</div>` / `<!-- c -->` 这类被 formatToken 渲染成空串(现在由 renderToken
     *    的 raw 兜底接住,所以走的是「1 行」那条);
     *  - **一个孤零零的围栏行**(模型的输出被按行拆开时天天出现)会被 marked 解析成一个
     *    未闭合的代码块,展开成 3 行。不退回的话,日志窗里一行变三行,而上游按行算高度。
     */
    for (const src of ['```', '~~~', '<div>x</div>', '<!-- c -->', '[^1]: 脚注']) {
      expect(`${src} → ${inlineMarkdown(src, THEME)}`).toBe(`${src} → ${src}`)
    }
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

  it('整段的亮度**一致** —— 不许「这一行碰巧有转义就亮、没有就暗」', () => {
    /**
     * 逐行判是上一版的写法,验收在真帧里抓到了后果:同一个三项列表,带行内代码的那一行
     * 正常亮度,不带的两行是暗的 —— 一段花斑。改之前整段统一暗,难看但**一致**;
     * 逐行判之后变成花的,那比原来更糟。
     */
    const body = '先做 A\n带 `代码` 的一行\n再做 B'
    const { lines } = render([{ title: '完整方案', body, md: true }])
    const bodyLines = lines.filter(l => l.bold !== true)
    expect(bodyLines.length).toBeGreaterThan(2)
    // 全部同一档:要么整段 ansi、要么整段走旧渲染,不能一半一半。
    expect(new Set(bodyLines.map(l => l.ansi === true)).size).toBe(1)
    expect(new Set(bodyLines.map(l => l.dim === true)).size).toBe(1)
  })

  it('折叠预览里不留空行 —— 那几行是预览的一半篇幅', () => {
    /**
     * 验收实测:40 行终端上 6 行预览里 2 行是空的、1 行是「中间省略 N 行」,真有内容的
     * 只剩 3 行 —— 一段「更加好看美观」的排版把预览的信息量砍掉了一半。
     */
    const body = '## 标题\n\n第一段\n\n第二段\n\n第三段\n\n第四段'
    const collapsed = render([{ title: '完整方案', body, md: true }]).lines.filter(l => l.bold !== true)
    for (const l of collapsed) expect(l.text.trim().length).toBeGreaterThan(0)
    // 展开之后空行照留 —— 那时候有地方,而段落之间那一行正是「好看」的来源。
    const opened = sectionLines({
      sections: [{ title: '完整方案', body, md: true }],
      cursor: -1, expanded: new Set(['完整方案']), width: 60, collapsedLines: 6, theme: THEME,
    }).lines.filter(l => l.bold !== true)
    expect(opened.some(l => l.text.trim().length === 0)).toBe(true)
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
