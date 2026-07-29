import { stringWidth } from '../../ink/stringWidth.js'

/**
 * 带 ANSI 转义的文本的**按显示宽度**折行 / 截断。
 *
 * ## 为什么不能直接用 logView 里那两个
 *
 * 它们是 `for (const ch of s)` 逐码点走的。一段 `\x1b[1m` 在那个循环里是**四个字符**:
 * `\x1b` 宽 0(控制字符),`[`、`1`、`m` 各宽 1 —— 于是转义序列自己占掉三列预算,
 * 而且随时可能被从中间劈开,劈开之后终端会把 `1m` 当正文打出来。
 *
 * ## 为什么不用 wrap-ansi(仓库里就有这个依赖)
 *
 * 它的宽度算的是 `string-width`,而这个仓库**专门写了自己的** `stringWidth`,因为
 * string-width 把 `⚠` 报成宽 2(注释原话)。两套宽度一旦不一致,「一条 ViewLine =
 * 一个终端行」这条硬不变量就没了 —— 而整个日志窗的高度、切片、滚动条位置全押在它上面。
 * 这一层的全部意义就是把折行算准,那就不能把宽度这件事外包给另一套实现。
 *
 * ## SGR 状态怎么跨行接上
 *
 * 折行会把 `\x1b[1m粗体的一长段\x1b[22m` 从中间切开:第二行开头没有 `\x1b[1m`,粗体
 * 就断了。做法是**按顺序重放**:记下本行内出现过的所有 SGR 序列,断行时行尾补一个
 * `\x1b[0m`、下一行行首把它们原样重放一遍。重放全序列而不是「解析出有哪些属性」是
 * 因为前者天然正确 —— 从干净状态按原顺序重放同一串 SGR,得到的就是同一个状态。
 *
 * 列表只在**一个源行内**增长(调用方按 `\n` 拆过了,而 chalk 对多行字符串本来就会
 * 逐行重开样式),所以不存在无限增长。
 */

/** 全量重置。断行时补在行尾,免得样式漏给右边的滚动条那一列。 */
const RESET = '\x1b[0m'

export function hasAnsi(s: string): boolean {
  return s.includes('\x1b')
}

/**
 * 一个转义序列 / 一个可见码点。
 *
 * `esc` 为真表示这一段是转义序列:**宽度 0,而且永远不许被切开**。
 */
export interface AnsiAtom {
  text: string
  esc: boolean
  /** 这个转义序列是不是 SGR(`\x1b[…m`)—— 只有它需要跨行重放。 */
  sgr?: boolean
  /** 是不是全量重置(`\x1b[0m` / `\x1b[m`)—— 重放列表在这里清空。 */
  reset?: boolean
}

/**
 * 把一段文本拆成「转义序列 + 可见码点」的序列。
 *
 * 认三种转义:
 *  - CSI `\x1b[ … <终止字节>`(0x40–0x7E),SGR 是其中终止于 `m` 的那一类;
 *  - OSC `\x1b] … (BEL | ST)` —— 超链接就是这一类(`\x1b]8;;URL\x07文字\x1b]8;;\x07`),
 *    从中间劈开会把 URL 当正文打出来;
 *  - 其余 `\x1b` + 一个字节。
 *
 * 认不出来的残缺序列(字符串在转义中间被截断)当**一个整体**吞掉,不当正文 ——
 * 当正文的话它会被算进宽度、还可能被再切一次。
 */
export function ansiAtoms(s: string): AnsiAtom[] {
  const out: AnsiAtom[] = []
  const chars = Array.from(s)
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\x1b') {
      out.push({ text: chars[i]!, esc: false })
      continue
    }
    const next = chars[i + 1]
    if (next === '[') {
      let j = i + 2
      while (j < chars.length && !/[\x40-\x7e]/.test(chars[j]!)) j++
      const text = chars.slice(i, Math.min(j + 1, chars.length)).join('')
      const isSgr = text.endsWith('m')
      out.push({
        text, esc: true, sgr: isSgr,
        // `\x1b[0m` 和 `\x1b[m` 都是全量重置(省略参数等价于 0)。
        reset: isSgr && /^\x1b\[(0?)m$/.test(text),
      })
      i = j
      continue
    }
    if (next === ']') {
      let j = i + 2
      while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j++
      const end = chars[j] === '\x1b' ? j + 1 : j
      out.push({ text: chars.slice(i, Math.min(end + 1, chars.length)).join(''), esc: true })
      i = end
      continue
    }
    out.push({ text: chars.slice(i, i + 2).join(''), esc: true })
    i += 1
  }
  return out
}

/** 去掉所有转义序列,只留可见部分。用来算宽度、也用来给测试断言。 */
export function stripAnsiAtoms(s: string): string {
  return hasAnsi(s) ? ansiAtoms(s).filter(a => !a.esc).map(a => a.text).join('') : s
}

/**
 * 按显示宽度折行,**转义序列不占宽度、不被切开、跨行接得上**。
 *
 * 语义和 `wrapDisplayWidth` 逐字对齐(宽字符放不下就先断行,绝不劈半个),
 * 只是多了 ANSI 这一维。
 */
export function wrapAnsi(s: string, width: number): string[] {
  if (width <= 0) return [s]
  const atoms = ansiAtoms(s)
  const out: string[] = []
  /** 本行内出现过的 SGR,按顺序。断行时原样重放到下一行开头。 */
  let sgr: string[] = []
  let cur = ''
  let curW = 0
  let visible = false
  const flush = (): void => {
    // 行尾补重置:不补的话样式会漏给右边的滚动条那一列(它是同一个 Box 里的兄弟节点)。
    out.push(sgr.length > 0 ? cur + RESET : cur)
    cur = sgr.join('')
    curW = 0
    visible = false
  }
  for (const a of atoms) {
    if (a.esc) {
      if (a.sgr === true) {
        if (a.reset === true) sgr = []
        else sgr.push(a.text)
      }
      cur += a.text
      continue
    }
    const w = stringWidth(a.text)
    // `visible` 而不是 `curW > 0`:一个零宽字符(组合记号)之后仍然算「这行已经有东西了」,
    // 而 `curW > 0` 会在只有零宽内容时反复断出空行。
    if (curW + w > width && visible) flush()
    cur += a.text
    curW += w
    visible = true
  }
  out.push(sgr.length > 0 ? cur + RESET : cur)
  return out.length > 0 ? out : ['']
}

/**
 * 按显示宽度截断,超出补省略号。语义和 `clipToWidth` 对齐。
 *
 * 截断之后**一定补一个重置** —— 被砍掉的那一半里可能有 chalk 的收尾码,不补的话样式
 * 会一直漏到行尾。
 */
export function clipAnsi(s: string, width: number): string {
  if (width <= 0) return ''
  const atoms = ansiAtoms(s)
  const plainWidth = atoms.filter(a => !a.esc).reduce((n, a) => n + stringWidth(a.text), 0)
  if (plainWidth <= width) return s
  let out = ''
  let w = 0
  let styled = false
  for (const a of atoms) {
    if (a.esc) {
      out += a.text
      if (a.sgr === true) styled = true
      continue
    }
    const cw = stringWidth(a.text)
    if (w + cw > width - 1) break
    out += a.text
    w += cw
  }
  return out + '…' + (styled ? RESET : '')
}
