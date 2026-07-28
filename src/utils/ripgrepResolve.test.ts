import { describe, expect, it } from 'bun:test'
import { resolveRipgrepConfig } from './ripgrep.js'

/**
 * rg 从哪来 —— 四条分支。
 *
 * 这些分支此前**够不着**:`getRipgrepConfig` 是 memoize 过的,而判据全是进程级全局。
 * 于是「单文件产物」那条分支从来没有被任何测试走过一次,直到用户报
 * `ENOENT: posix_spawn '/$bunfs/root/vendor/ripgrep/x64-linux/rg'`。
 */
const base = {
  wantsSystem: false,
  isOfficialNativeBuild: false,
  isSingleFile: false,
  systemRg: () => 'rg', // 'rg' = PATH 上没找到(findExecutable 找不到时原样返回)
  fileExists: () => false,
  execPath: '/usr/local/bin/claude',
  moduleDir: '/repo/src/utils',
}

describe('resolveRipgrepConfig', () => {
  it('用户点名要系统 rg,且 PATH 上有 → system', () => {
    const c = resolveRipgrepConfig({ ...base, wantsSystem: true, systemRg: () => '/usr/bin/rg' })
    // 传的是命令名而不是解析出来的绝对路径:防 PATH 劫持(当前目录里的 ./rg)。
    expect(c).toEqual({ mode: 'system', command: 'rg', args: [] })
  })

  it('用户要系统 rg 但 PATH 上没有 → 继续往下走,不是硬失败', () => {
    const c = resolveRipgrepConfig({ ...base, wantsSystem: true, fileExists: () => true })
    expect(c.mode).toBe('builtin')
    expect(c.command).toContain('/repo/src/utils')
  })

  it('官方 native 构建 → 用 argv0 分发,spawn 自己', () => {
    const c = resolveRipgrepConfig({ ...base, isOfficialNativeBuild: true })
    expect(c).toEqual({ mode: 'embedded', command: '/usr/local/bin/claude', args: ['--no-config'], argv0: 'rg' })
  })

  it('单文件产物:**绝不**拼 moduleDir —— 那是 bunfs 虚拟根', () => {
    // 这就是用户报的那条。moduleDir 在单文件产物里是 /$bunfs/root/,拼出来的
    // /$bunfs/root/vendor/ripgrep/x64-linux/rg 只能读、不能 spawn。
    const seen: string[] = []
    const c = resolveRipgrepConfig({
      ...base, isSingleFile: true, moduleDir: '/$bunfs/root',
      fileExists: p => { seen.push(p); return false },
    })
    expect(c.command).not.toContain('$bunfs')
    // 连**查**都不该去查那条虚拟路径
    expect(seen.some(p => p.includes('$bunfs'))).toBe(false)
    expect(c).toEqual({ mode: 'system', command: 'rg', args: [] })
  })

  it('单文件产物:可执行文件旁边有 vendor/ripgrep 就用那一份', () => {
    const seen: string[] = []
    const c = resolveRipgrepConfig({
      ...base, isSingleFile: true, moduleDir: '/$bunfs/root',
      fileExists: p => { seen.push(p); return true },
    })
    expect(c.mode).toBe('builtin')
    expect(c.command).toContain('/usr/local/bin/vendor/ripgrep')
    expect(seen[0]).toContain('/usr/local/bin/vendor/ripgrep')
  })

  it('单文件产物:PATH 上有 rg 就用它,而且**不**报警', () => {
    let warned = ''
    const c = resolveRipgrepConfig({
      ...base, isSingleFile: true, systemRg: () => '/usr/bin/rg', onMissing: m => { warned = m },
    })
    expect(c).toEqual({ mode: 'system', command: 'rg', args: [] })
    expect(warned).toBe('')
  })

  it('单文件产物且哪儿都没有 rg → 报一句能照做的话', () => {
    // 仍然返回 'rg':让失败发生在一个用户认得、能自己装的名字上,而不是一条
    // 他从没见过的 /$bunfs/ 路径。
    let warned = ''
    const c = resolveRipgrepConfig({ ...base, isSingleFile: true, onMissing: m => { warned = m } })
    expect(c.command).toBe('rg')
    expect(warned).toContain('ripgrep')
    expect(warned).toContain('装一个')
  })

  it('单文件产物**不能**退到 argv0 分发', () => {
    // 实测:spawn(我们的二进制, ['--version'], { argv0: 'rg' }) 返回的是 Claude Code
    // 自己的版本号,不是 ripgrep 的 —— 把搜索结果换成一行版本号,比 ENOENT 更难发现。
    const c = resolveRipgrepConfig({ ...base, isSingleFile: true })
    expect(c.argv0).toBeUndefined()
  })

  it('开发态:内置的那份**在盘上**才用它', () => {
    const c = resolveRipgrepConfig({ ...base, fileExists: () => true })
    expect(c.mode).toBe('builtin')
    expect(c.command).toContain('/repo/src/utils/vendor/ripgrep')
  })

  it('开发态但根本没有 vendor/ripgrep → 退到系统 rg,不是拼一条不存在的路径', () => {
    // 这个 fork 的 vendor/ 里只有 zod-v4.js,**从来没有过 vendor/ripgrep/** ——
    // 也就是说从源码跑时每一次 Grep/Glob 都在 ENOENT,只是错误信息没有 $bunfs
    // 那么显眼,一直被当成别的问题。原来这里是无条件返回那条路径。
    const c = resolveRipgrepConfig({ ...base, systemRg: () => '/usr/bin/rg' })
    expect(c).toEqual({ mode: 'system', command: 'rg', args: [] })
  })

  it('哪儿都没有(开发态)→ 也要报那句能照做的话', () => {
    let warned = ''
    const c = resolveRipgrepConfig({ ...base, onMissing: m => { warned = m } })
    expect(c.command).toBe('rg')
    expect(warned).toContain('装一个 ripgrep')
  })

  it('候选顺序:模块目录优先于可执行文件旁边', () => {
    const seen: string[] = []
    resolveRipgrepConfig({ ...base, fileExists: p => { seen.push(p); return false } })
    expect(seen[0]).toContain('/repo/src/utils/vendor/ripgrep')
    expect(seen[1]).toContain('/usr/local/bin/vendor/ripgrep')
  })

  it('USE_BUILTIN_RIPGREP 时 PATH 上有 rg 也不许改用系统的', () => {
    // 重构把原来的嵌套 if 压成了 `wantsSystem && systemRg() !== 'rg'`,而没有一条
    // 用例是「不想要系统的 + PATH 上恰好有」。漏掉半个条件的后果是:凡是装了 rg 的
    // 机器都会静默改用系统那份,USE_BUILTIN_RIPGREP 这个 opt-in 完全失效 —— 而全套
    // 测试照绿。这条用例就是为了让那半个条件死不掉。
    const cfg = resolveRipgrepConfig({
      wantsSystem: false,
      isOfficialNativeBuild: false,
      isSingleFile: false,
      systemRg: () => '/usr/bin/rg',
      fileExists: (p: string) => p.includes('vendor/ripgrep'),
      execPath: '/opt/claude/bin/claude',
      moduleDir: '/opt/claude/lib',
    })
    expect(cfg.mode).toBe('builtin')
    expect(cfg.command).toContain('vendor/ripgrep')
  })
})
