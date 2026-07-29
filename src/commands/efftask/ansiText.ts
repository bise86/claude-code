import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'

/**
 * 按**字素簇**切,不是按码点。
 *
 * `stringWidth`(ink 布局用的同一个)量的是字素簇:`⚠️` 是「符号 + 变体选择符」两个码点、
 * 宽度 1;`👨‍👩‍👧` 是五个码点、宽度 2。按码点走的循环会把它们**拆开**逐个量宽,于是
 *  - 宽度算错 → 行按 N 列排版、实际渲染成 N+k 列 → ink 把它回流成两个终端行 →
 *    「一条 ViewLine = 一个终端行」当场破:切片少画一行、滚动条指错位置,而**帧的总行数
 *    一点没变**。评审用真渲染量到过:整整一段被挤出屏幕、「↓ 下面还有 13 行」那句话
 *    被静默剪掉,而画面看起来完完整整 —— 正是 `detailLayout` 注释里记着的那次学费。
 *  - 还会把 ZWJ 家族 emoji 从中间劈成两半。
 *
 * 用的是仓库自己那个 segmenter —— `stringWidth` 内部用的就是它。同源才不会再分叉。
 */
export function graphemes(s: string): string[] {
  const out: string[] = []
  for (const { segment } of getGraphemeSegmenter().segment(s)) out.push(segment)
  return out
}

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
 * 列表装的是**此刻还开着的**属性 —— 收尾码会把对应的开启码摘掉(见 applySgr),
 * 所以它的长度只跟「同时开着几个属性」有关,和行有多长无关。
 *
 * 上一版是只进不出的,注释里写着「所以不存在无限增长」—— 那句话技术上成立(有界),
 * 但界是 O(源行样式段数),总量 O(n²):评审实测 6720 字符的行折完之后是源文的 46 倍。
 */

/**
 * SGR 收尾码 → 它关掉的那些开启码。
 *
 * 重放列表原来是**只进不出**的:`\x1b[39m`(关前景色)、`\x1b[22m`(关粗体)这些
 * chalk 的收尾码不是全量重置,于是被一路 push 进去、永不出栈。评审量到的后果:
 * 一个 6720 字符的多样式长行折成 58 行,总字节 313KB(源文的 46 倍),第 13 行开头就
 * 挂着 1221 字节的重放串 —— 而那一行可见内容只有 40 列。总量是 O(n²)。
 *
 * 做法:收尾码把它对应的开启码从列表里**摘掉**,然后连自己也不入列 —— 从行首的干净
 * 状态重放时,一个没被开启的属性本来就是关着的,再补一句「关掉它」纯属冗余。
 *
 * 只认标准的那几组。认不出来的参数(比如某些终端的私有扩展)照旧入列,宁可长一点
 * 也不要把样式弄丢。
 */
const SGR_CLOSERS: Record<number, (code: number) => boolean> = {
  22: c => c === 1 || c === 2,
  23: c => c === 3,
  24: c => c === 4,
  25: c => c === 5 || c === 6,
  27: c => c === 7,
  28: c => c === 8,
  29: c => c === 9,
  // 前景色:30-37 / 90-97 / 38(扩展色)。
  39: c => (c >= 30 && c <= 38) || (c >= 90 && c <= 97),
  // 背景色:40-47 / 100-107 / 48。
  49: c => (c >= 40 && c <= 48) || (c >= 100 && c <= 107),
}

/** 一段 SGR 的首个数字参数。`\x1b[m` 省略参数,等价于 0。 */
function sgrCode(seq: string): number {
  const m = /^\x1b\[([0-9;]*)m$/.exec(seq)
  if (!m) return Number.NaN
  const first = (m[1] ?? '').split(';')[0] ?? ''
  return first.length === 0 ? 0 : Number(first)
}

/**
 * 把一段 SGR 并进重放列表。
 *
 * 返回新列表 —— 纯函数,好让它自己被单独测。
 */
export function applySgr(open: readonly { code: number; raw: string }[], seq: string): { code: number; raw: string }[] {
  const code = sgrCode(seq)
  if (!Number.isFinite(code)) return [...open, { code, raw: seq }]
  if (code === 0) return []
  const closes = SGR_CLOSERS[code]
  if (closes) return open.filter(o => !closes(o.code))
  return [...open, { code, raw: seq }]
}

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
  const chars = graphemes(s)
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
  /**
   * 此刻**还开着**的 SGR,按开启顺序。断行时原样重放到下一行开头。
   *
   * 是「还开着的」,不是「出现过的」—— 见 applySgr:收尾码会把对应的开启码摘掉,
   * 否则列表只进不出,长行上的重放串会涨到源文的几十倍(实测 6720 字符 → 313KB)。
   */
  let sgr: { code: number; raw: string }[] = []
  let cur = ''
  let curW = 0
  let visible = false
  const flush = (): void => {
    // 行尾补重置:不补的话样式会漏给右边的滚动条那一列(它是同一个 Box 里的兄弟节点)。
    out.push(sgr.length > 0 ? cur + RESET : cur)
    cur = sgr.map(x => x.raw).join('')
    curW = 0
    visible = false
  }
  for (const a of atoms) {
    if (a.esc) {
      if (a.sgr === true) sgr = applySgr(sgr, a.text)
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
