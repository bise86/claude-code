import chalk from 'chalk'
import { Marked, type Token } from 'marked'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '../../ink/stringWidth.js'
import { formatToken } from '../../utils/markdown.js'
import type { ThemeName } from '../../utils/theme.js'
import { wrapAnsi } from './ansiText.js'

/**
 * `/et` 两个页卡的 **markdown 上色**(用户原话:「任务详情和子 agent 输出时,用 markdown,
 * 更加好看美观」)。
 *
 * ## 为什么复用主 REPL 的 `formatToken`,而不是自己写一个
 *
 * 那边已经把「模型写的 markdown 在终端里长什么样」定死了:标题加粗、行内代码换色、
 * 列表项、引用条、表格按列对齐。自己再写一套的后果不是多几十行代码,是**同一段文字在
 * 主对话流里和在 `/et` 详情页里长得不一样** —— 而这两块屏幕上跑的是同一批模型的同一种
 * 输出。
 *
 * ## 这一层自己负责的三件事
 *
 * 1. **按显示宽度折行**,而且是用这个仓库自己的 `stringWidth`。「一条 ViewLine = 一个
 *    终端行」是日志窗和详情页共同的硬不变量,高度、切片、滚动条位置全押在它上面。
 * 2. **压掉多余空行**。`formatToken` 在段落/标题后面慷慨地补 EOL,而详情页默认只给
 *    每段 3 行 —— 一个开头就是空行的预览等于白给。
 * 3. **缓存**。日志窗每秒重画一次,可视区之外的行也要参与行数计算;一次 `marked.lexer`
 *    大约 3ms,几千行就是几秒。所以有一层「没有 markdown 记号就原样返回」的快路径,
 *    外加一个按行的 LRU。
 */

/**
 * **我们自己的 marked 实例** —— 不是共享的那个单例。
 *
 * 为什么必须自己一份:`formatToken` 对 html token 是 `case 'html': return ''`(源码原话
 * 「These token types are not rendered」)。而 marked 把 `<Text …>`、`<Box … />`、
 * `Array<Uint8Array>` 一律认成 HTML —— 于是这些内容在屏幕上**一个字都不剩**,而且没有
 * 任何提示。评审用真渲染量到的原样:
 *
 *     节点里写的:把 ScrollPane 的 <Text> 换成 <Ansi dimColor>,保留 Map<string, TaskNode>。
 *     屏幕上是:  把 ScrollPane 的 换成 ,保留 Map。
 *
 * 这不是「记号被吃掉」,是**正文被删掉**。而这是个 TSX 仓库:方案里写 `<Box>`、评审员
 * 写「缺 `<Suspense>` 边界」、类型签名写 `Map<K,V>` 是常态。用户读方案是为了决定批不批,
 * 而屏幕上看不出这句话被删过。
 *
 * 关掉 `html`(块级)和 `tag`(行内)两个 tokenizer 之后,这些片段退化成普通文本,
 * 原样上屏;其余记号(加粗、行内代码、标题、列表)照常上色 —— 实测过。
 *
 * **不能改共享的那个 `marked` 单例**:`configureMarked()` 动的是全局,主对话流的
 * `Markdown.tsx` 用的是同一个。那边渲染真 HTML 是它自己的选择,不该被这里的需求改掉。
 */
const md = new Marked()
md.use({
  tokenizer: {
    // 和 configureMarked() 一致:模型常拿 `~` 表示「约等于」(`~100`),几乎不是删除线。
    del() { return undefined },
    // 块级 HTML。
    html() { return undefined },
    // 行内 HTML(`<Text>` 这一类)。marked 里它叫 tag,不叫 html。
    tag() { return undefined },
  },
})

/**
 * 有没有 markdown 记号。抄 `components/Markdown.tsx` 的同名快路径,理由也一样:
 * 绝大多数行是普通句子,为它们跑一次完整的 GFM 词法分析纯属浪费。
 */
const MD_SYNTAX_RE = /[#*`|[>\-_~]|^\d+\. /

export function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s)
}

/**
 * 一段 markdown 源码 → 一串带 ANSI 的**逻辑行**(还没按宽度折)。
 *
 * `highlight` 传 null:代码块的语法高亮要 `getCliHighlightPromise()`(异步、要动态
 * import highlight.js),而这一层跑在同步渲染路径上。代码块因此是原样文本 —— 比一个
 * 会让整屏闪一下的异步高亮划算。
 */
export function markdownToAnsi(body: string, theme: ThemeName, width = Infinity): string[] {
  // 分隔符写成转义形式,不写裸字节:裸 NUL 会让 rg 把整个文件判成二进制、
  // 从此在所有 grep 结果里消失 —— 和裸 ESC 是同一类「肉眼看不见的字节」问题。
  const key = `${theme}\u0000${width}\u0000${body}`
  const hit = blockCache.get(key)
  if (hit !== undefined) {
    blockCache.delete(key)
    blockCache.set(key, hit)
    return hit
  }
  const out = renderBlocks(body, theme, width)
  // 超长正文不进缓存:`execStatus` 是**逐轮追加**的,一个返工过几轮的节点能到几万字,
  // 缓存它等于把同一份内容在内存里多留一整份,而它恰恰是最不可能被反复命中的那种
  // (每追加一轮 key 就变了)。
  if (body.length <= MAX_CACHED_BODY) {
    if (blockCache.size >= BLOCK_CACHE_MAX) {
      const oldest = blockCache.keys().next().value
      if (oldest !== undefined) blockCache.delete(oldest)
    }
    blockCache.set(key, out)
  }
  return out
}

/**
 * 段落级缓存。
 *
 * **不是可有可无的优化。** 详情页每秒重画一次,而且**每一次按键也重画一次**(滚动、
 * 展开、换页卡)。实测 8 个 markdown 段落、每段 3000 字:一帧 39.7ms,不上 markdown
 * 是 5.9ms —— 按住 j 滚动时那 40ms 是看得见的迟滞。
 *
 * 命中率天然接近 100%:正文来自节点对象,两帧之间不变。
 */
const BLOCK_CACHE_MAX = 200
/** 超过这个长度的正文不进缓存 —— 见 markdownToAnsi 里那段。 */
const MAX_CACHED_BODY = 40_000
const blockCache = new Map<string, string[]>()

/**
 * 一个顶层 token → 文本。**在 `formatToken` 外面加两道,都是为了「不许把模型写的东西弄丢」。**
 *
 * ### 一、代码块要保住围栏
 *
 * `formatToken` 的 `code` 分支在没有 highlight 实例时返回的是**裸的** `token.text` ——
 * 围栏没了、也没有任何样式。于是一段代码和一段散文在屏幕上长得一模一样,而这个功能
 * 的名字叫「更加好看美观」。这里把围栏补回来并压暗,代码正文保持原样(压暗代码正文
 * 会真的变难读)。
 *
 * 原文没有收尾围栏(模型截断了)时**不补一个** —— 补了就是替它宣称代码块到此为止。
 *
 * ### 二、`formatToken` 认不出来的 token 一律退回原文
 *
 * 它对 `def` / `del` / `html` 和一切未知类型**返回空串**(源码原话:「These token types
 * are not rendered」)。在主对话流里这无所谓,在这里不行:实测
 * `<div class="warn">这段话在 div 里</div>` 和 `<!-- 注释 -->` 会**整行凭空消失**,
 * 而模型确实会写这些。一个残缺的视图看起来完完整整,正是这个仓库反复付学费的形状。
 *
 * 判据是「渲染结果没有可见内容,而原文有」——**通用**,不是逐个 token 类型去补。
 * 未来 marked 加一种新 token,这条一样接得住。
 */
function renderToken(t: Token, theme: ThemeName, width: number): string {
  const raw0 = String((t as { raw?: unknown }).raw ?? '')
  if (t.type === 'table') {
    /**
     * 表格:**排得下才用对齐版,排不下退回原文。**
     *
     * `formatToken` 的表格分支把每一列补齐到「该列最宽的那格」的自然宽度,**完全不看
     * 窗口有多宽**。验收实测:一张源文 46 列的表被撑到 115 列,100 列的终端上 5 行变成
     * 8 行,而续行的行首没有 `|` —— 列全乱,比不上 markdown 的时候更难看。
     *
     * 主 REPL 没这个问题是因为它把表格交给 `MarkdownTable` 这个 React 组件(按终端宽度
     * 分列宽、格内折行、太高转竖排)。那是个组件,这一层是按行出字符串的,用不上。
     *
     * 退回原文不是认输:模型写的那份 `| a | b |` 本来就是对齐的,而且**一定不比对齐版宽**。
     */
    const aligned = formatToken(t, theme, 0, null, null, null)
    /**
     * **不用 `Math.max(...)`** —— 展开的是**渲染行数**,而这一层渲染的是 node.md 的正文
     * (执行状态里贴一段十万行的日志就够了)。V8 在 ~12 万个实参上抛 RangeError,
     * 而这里抛出去等于详情页整个白屏。reduce 没有这个上限。
     */
    const widest = aligned.split('\n').reduce((m, l) => {
      const w = stringWidth(stripAnsi(l))
      return w > m ? w : m
    }, 0)
    return widest <= width ? aligned : raw0
  }
  if (t.type === 'list' && hasTaskItem(t)) {
    /**
     * 任务清单(`- [ ]` / `- [x]`)退回原文。
     *
     * `formatToken` 不看 `list_item.task` / `.checked`,勾选标记被整个剥掉 —— 验收实测
     * 「已完成」和「未完成」渲染出来一模一样,而且那一档一个转义都没发:**纯损失**。
     * 一份方案里的验收清单勾没勾上,恰恰是读的人最想知道的一件事。
     */
    return raw0
  }
  if (t.type === 'code') {
    const raw = String((t as { raw?: unknown }).raw ?? '')
    const lang = String((t as { lang?: unknown }).lang ?? '')
    const text = String((t as { text?: unknown }).text ?? '')
    // 缩进式代码块(四个空格)没有围栏可保 —— 原样交给 formatToken。
    if (!/^\s*(```|~~~)/.test(raw)) return formatToken(t, theme, 0, null, null, null)
    const closed = /(```|~~~)\s*$/.test(raw.trimEnd())
    return [chalk.dim(`\`\`\`${lang}`), text, ...(closed ? [chalk.dim('```')] : [])].join('\n') + '\n'
  }
  const rendered = formatToken(t, theme, 0, null, null, null)
  if (stripAnsi(rendered).trim().length === 0 && raw0.trim().length > 0) return raw0
  return rendered
}

function renderBlocks(body: string, theme: ThemeName, width: number): string[] {
  /**
   * 终端不支持颜色时**原样返回**。
   *
   * `formatToken` 靠 chalk 上色,而 chalk 在 level 0 下什么都不发 —— 于是它做的唯一一件
   * 事就是把 `## `、`**`、`` ` `` 这些记号**剥掉**。没有颜色顶上的话,剥掉是纯粹的信息
   * 损失:用户拿到一份比原文更难读的正文,而这个功能的名字叫「更加好看美观」。
   */
  if (chalk.level === 0) return body.split('\n')
  let tokens: Token[]
  try {
    tokens = md.lexer(body)
  } catch {
    // 词法分析对畸形输入不该抛,但它是外部库,而这一层跑在渲染路径上 ——
    // 一个抛异常的排版函数会把整屏带走,而它只负责好看。
    return body.split('\n')
  }
  let out: string
  try {
    out = tokens.map(t => renderToken(t, theme, width)).join('')
  } catch {
    return body.split('\n')
  }
  return squashBlankLines(out)
}

/**
 * 掐掉首尾空行、把连续空行压成一行。
 *
 * 不是全删:段落之间留一行是「好看」的主要来源。但 `formatToken` 给标题补的是**两个**
 * EOL,而详情页每段默认只有 3 行预览 —— 两个空行就吃掉三分之二。
 */
export function squashBlankLines(s: string): string[] {
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const l of lines) {
    const blank = l.trim().length === 0
    if (blank && (out.length === 0 || out[out.length - 1]!.trim().length === 0)) continue
    out.push(l)
  }
  while (out.length > 0 && out[out.length - 1]!.trim().length === 0) out.pop()
  return out
}

/**
 * 一段正文 → 若干**终端行**。详情页段落用的就是这个。
 *
 * 折行走 `wrapAnsi`,因为正文里已经有转义序列了 —— 用逐码点的那个折,
 * `\x1b[1m` 会被算成三列、还可能被从中间劈开。
 */
export function markdownLines(body: string, width: number, theme: ThemeName): string[] {
  const w = Math.max(1, Math.floor(width))
  return markdownToAnsi(body, theme, w).flatMap(l => wrapAnsi(l, w))
}

/**
 * **单行**的 markdown 上色 —— 子 agent 输出用的那一个。
 *
 * 为什么是单行:事件流在 `agentEvents` 那一层就已经按 `\n` 拆成一条条事件了(每行还各自
 * 夹到 300 码点),渲染时手上根本没有完整的段落。跨行的块结构里只有代码围栏是要紧的,
 * 而它由调用方跟踪(见 `renderStreamLines` 的 fence 状态)。
 *
 * 拿到的可能是一行被夹断的长行,marked 对它的解析仍然是安全的:最差退化成一个段落。
 * 但**尾随的 EOL 要去掉** —— 这一层的契约是「一行进,一行出」,多一个换行会让上游
 * 按行算的高度当场对不上。
 */
export function inlineMarkdown(line: string, theme: ThemeName): string {
  if (line.length === 0 || !hasMarkdownSyntax(line)) return line
  const key = `${theme}\u0000${line}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    // LRU:命中要提到最新,否则淘汰是 FIFO —— 而日志窗每秒重画同一批行,
    // FIFO 会把正在看的那几行反复挤掉。
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const rendered = markdownToAnsi(line, theme)
  // 一行进一行出:多行结果(marked 把一行拆成了块 + 空行)时退回原文,不猜。
  const value = rendered.length === 1 ? rendered[0]! : line
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

const CACHE_MAX = 4000
const cache = new Map<string, string>()

/** 只给测试用:两个用例之间把缓存清干净,免得互相看见对方的结果。 */
export function clearMarkdownCache(): void {
  cache.clear()
  blockCache.clear()
}

/** 这个列表里有没有勾选项(`- [ ]` / `- [x]`)。marked 把它标在 item 上,而 formatToken 不看。 */
function hasTaskItem(t: Token): boolean {
  const items = (t as { items?: { task?: unknown }[] }).items
  return Array.isArray(items) && items.some(i => i?.task === true)
}
