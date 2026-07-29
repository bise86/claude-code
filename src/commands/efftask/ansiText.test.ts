import { describe, expect, it } from 'bun:test'
import { ansiAtoms, clipAnsi, hasAnsi, stripAnsiAtoms, wrapAnsi } from './ansiText.js'
import { clipToWidth, wrapDisplayWidth } from './logView.js'
import { stringWidth } from '../../ink/stringWidth.js'

// 转义序列的字面量一律写成 \u001b / \u0007,**不写裸字节**。
// 裸 ESC 在编辑器、剪贴板和 grep 输出里全都不可见,而这个文件专门为转义序列而写 ——
// 它自己的源码不能靠肉眼看不见的字节。
const ESC = '\u001b'
const BOLD = `${ESC}[1m`
const OFF = `${ESC}[22m`
const RESET = `${ESC}[0m`
const RED = `${ESC}[31m`

/** 每一行的**可见**宽度。整个模块的价值全在这个数上。 */
const widths = (lines: string[]): number[] => lines.map(l => stringWidth(l))

describe('ansiAtoms', () => {
  it('转义序列是一个原子,而且宽度 0', () => {
    const atoms = ansiAtoms(`${BOLD}ab${OFF}`)
    expect(atoms.map(a => (a.esc ? `<${a.text.slice(1)}>` : a.text)).join('')).toBe('<[1m>ab<[22m>')
    expect(stripAnsiAtoms(`${BOLD}ab${OFF}`)).toBe('ab')
  })

  it('OSC 8 超链接整段吞掉 —— 从中间劈开会把 URL 当正文打出来', () => {
    const link = `${ESC}]8;;https://x/y\u0007文字${ESC}]8;;\u0007`
    expect(stripAnsiAtoms(link)).toBe('文字')
    // 两个 OSC 序列 + 两个可见汉字。
    expect(ansiAtoms(link).filter(a => a.esc)).toHaveLength(2)
  })

  it('残缺序列(字符串在转义中间被截断)当整体吞掉,不当正文', () => {
    // 当正文的话它会被算进宽度、还可能被再切一次。
    expect(stripAnsiAtoms(`ab${ESC}[1`)).toBe('ab')
    expect(stripAnsiAtoms(`ab${ESC}`)).toBe('ab')
  })

  it('`\\x1b[m` 和 `\\x1b[0m` 都算全量重置', () => {
    expect(ansiAtoms(`${ESC}[0m`)[0]!.reset).toBe(true)
    expect(ansiAtoms(`${ESC}[m`)[0]!.reset).toBe(true)
    expect(ansiAtoms(`${ESC}[1m`)[0]!.reset).toBe(false)
    // 非 SGR 的 CSI(光标前移)不参与重放。
    expect(ansiAtoms(`${ESC}[3C`)[0]!.sgr).toBe(false)
  })
})

describe('wrapAnsi', () => {
  it('转义序列不吃宽度预算 —— 这正是逐码点那个折行函数错的地方', () => {
    /**
     * `wrapDisplayWidth` 是 `for (const ch of s)` 的:`\x1b[1m` 在它眼里是四个字符,
     * ESC 宽 0、`[`/`1`/`m` 各宽 1 —— 三列预算凭空没了,而且随时会被从中间劈开。
     */
    const s = `${BOLD}abcdefghij${OFF}`
    const out = wrapAnsi(s, 10)
    // 一行,可见宽度正好 10。
    expect(widths(out)).toEqual([10])
    expect(out.map(stripAnsiAtoms)).toEqual(['abcdefghij'])
    // 而且**一个转义序列都没被切开**:拆回原子之后,每一个 esc 原子都是完整的一段。
    for (const a of ansiAtoms(out[0]!).filter(x => x.esc)) {
      expect(/^\u001b\[[0-9;]*[a-zA-Z]$/.test(a.text)).toBe(true)
    }
  })

  it('中文按显示宽度折,不劈半个字', () => {
    const s = `${BOLD}一二三四五${OFF}`
    const out = wrapAnsi(s, 6)
    expect(out.map(stripAnsiAtoms)).toEqual(['一二三', '四五'])
    expect(widths(out)).toEqual([6, 4])
  })

  it('样式跨行接得上 —— 第二行开头把本行出现过的 SGR 原样重放', () => {
    const out = wrapAnsi(`${BOLD}aaaa${OFF}`, 2)
    expect(out.map(stripAnsiAtoms)).toEqual(['aa', 'aa'])
    // 每一段续行都以重放开头,否则加粗断在第一行。
    expect(out[1]!.startsWith(BOLD)).toBe(true)
    // 行尾补重置,免得样式漏给右边的滚动条那一列。
    expect(out[0]!.endsWith(RESET)).toBe(true)
  })

  it('重置之后不再重放 —— 否则 `\\x1b[0m` 之后的行会莫名其妙又变粗', () => {
    const out = wrapAnsi(`${BOLD}aa${RESET}bbbb`, 2)
    expect(out.map(stripAnsiAtoms)).toEqual(['aa', 'bb', 'bb'])
    expect(out[2]!.includes(BOLD)).toBe(false)
  })

  it('多个 SGR 按**顺序**重放 —— 顺序错了颜色和粗细就对调了', () => {
    const out = wrapAnsi(`${BOLD}${RED}aaaa`, 2)
    expect(out[1]!.indexOf(BOLD)).toBeLessThan(out[1]!.indexOf(RED))
  })

  it('纯文本走这条路径结果也对(它是个全函数,不是只给 ANSI 用的)', () => {
    expect(wrapAnsi('abcdef', 2)).toEqual(['ab', 'cd', 'ef'])
    expect(wrapAnsi('', 5)).toEqual([''])
    expect(wrapAnsi('abc', 0)).toEqual(['abc'])
  })

  it('单个宽字符比整行还宽时不死循环', () => {
    // width=1 而汉字宽 2:每行放一个字,而不是无限断空行。
    expect(wrapAnsi('一二', 1).map(stripAnsiAtoms)).toEqual(['一', '二'])
  })
})

describe('clipAnsi', () => {
  it('按可见宽度截,尾部补省略号和重置', () => {
    const out = clipAnsi(`${BOLD}一二三四五${OFF}`, 6)
    expect(stripAnsiAtoms(out)).toBe('一二…')
    expect(stringWidth(out)).toBeLessThanOrEqual(6)
    // 被砍掉的那一半里可能有 chalk 的收尾码,不补重置样式会一直漏到行尾。
    expect(out.endsWith(RESET)).toBe(true)
  })

  it('放得下就原样返回(连同样式)', () => {
    const s = `${BOLD}abc${OFF}`
    expect(clipAnsi(s, 10)).toBe(s)
  })

  it('width <= 0 返回空串,和 clipToWidth 一致', () => {
    expect(clipAnsi(`${BOLD}abc`, 0)).toBe('')
  })
})

describe('logView 的两个入口会把带 ANSI 的交给这一层', () => {
  it('wrapDisplayWidth 带 ANSI 时不再逐码点数', () => {
    /**
     * 宽度要**小于**可见宽度,真的把折行逼出来。取等号的话
     * `stringWidth(s) <= width` 那句提前返回会先接住,删掉整条 ANSI 分支照样绿。
     */
    const s = `${BOLD}abcdefghij${OFF}`
    const out = wrapDisplayWidth(s, 6)
    expect(out.map(stripAnsiAtoms)).toEqual(['abcdef', 'ghij'])
    expect(widths(out)).toEqual([6, 4])
  })

  it('clipToWidth 带 ANSI 时按可见宽度截', () => {
    expect(stripAnsiAtoms(clipToWidth(`${BOLD}一二三四五${OFF}`, 6))).toBe('一二…')
  })

  it('不带 ANSI 时行为逐字不变 —— 老路径一个字节都不许动', () => {
    expect(hasAnsi('普通文本')).toBe(false)
    expect(wrapDisplayWidth('一二三四五', 6)).toEqual(['一二三', '四五'])
    expect(clipToWidth('一二三四五', 6)).toBe('一二…')
  })
})
