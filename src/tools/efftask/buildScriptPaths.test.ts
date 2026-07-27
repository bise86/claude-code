/**
 * 构建脚本里的路径必须能在 Windows 上用。
 *
 * 这道闸门是一次**只在 Windows 上炸**的发布失败逼出来的:
 *   error: EINVAL reading file: "/D:/a/claude-code/claude-code/vendor/zod-v4.js"
 *
 * 原因是 `new URL(..., import.meta.url).pathname`。在 POSIX 上它恰好等于文件路径,
 * 在 Windows 上却是 `/D:/...` —— 盘符前面多一个斜杠,谁拿去读都是 EINVAL。
 * 于是四平台矩阵里只有 windows-x64 那一条挂掉,而本机怎么跑都复现不了。
 *
 * 所以这里查的是**这一类写法**,不是那一行:file URL 要转路径只能走 fileURLToPath。
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SCRIPTS = fileURLToPath(new URL('../../../scripts/', import.meta.url))

describe('构建脚本不能用 .pathname 当文件路径', () => {
  const files = readdirSync(SCRIPTS).filter(f => f.endsWith('.ts'))

  it('scripts/ 下有脚本可查(排除「一个都没扫到」的空跑)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s 不含 URL(...).pathname', file => {
    const src = readFileSync(join(SCRIPTS, file), 'utf8')
    const bad = src.split('\n')
      .filter(l => /\.pathname\b/.test(l) && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    expect(`${file} 里的 .pathname 用法: ${bad.map(b => b.trim()).join(' | ') || '无'}`)
      .toBe(`${file} 里的 .pathname 用法: 无`)
  })

  it('vendor/zod-v4.js 的路径是用 fileURLToPath 解出来的', () => {
    const src = readFileSync(join(SCRIPTS, 'build.ts'), 'utf8')
    // 断布尔而不是 toContain(src, ...):失败时后者会把整个构建脚本打进输出。
    const ok = src.includes("fileURLToPath(new URL('../vendor/zod-v4.js', import.meta.url))")
    expect(`zod 路径用了 fileURLToPath: ${ok}`).toBe('zod 路径用了 fileURLToPath: true')
    // 那份压平产物必须真的在仓库里 —— 它是编译能过的前提,不是可选优化。
    const flat = fileURLToPath(new URL('../../../vendor/zod-v4.js', import.meta.url))
    expect(readFileSync(flat, 'utf8').length).toBeGreaterThan(1000)
  })
})
