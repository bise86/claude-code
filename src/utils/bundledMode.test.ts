import { afterEach, describe, expect, it } from 'bun:test'
import {
  isInBundledMode,
  isLocallyBuiltExecutable,
  isSelfContainedExecutable,
  isSingleFileExecutable,
  selfInvocationPath,
} from './bundledMode.js'

/**
 * 这三个判据决定了「我从哪儿被调起来、能不能 spawn 自己、内置的东西在不在」。
 * 混用其中两个的代价是实测过的:
 * `ENOENT: posix_spawn '/$bunfs/root/vendor/ripgrep/x64-linux/rg'`。
 *
 * 单元测试只能覆盖到 argv[1] 这一路(Bun.main 和 import.meta.url 在测试里是真值,
 * 改不了)。**打包态的那一半由 scripts/verify-binary.ts 守**,那才是这类 bug 的现场。
 */
const realArgv1 = process.argv[1]
afterEach(() => { process.argv[1] = realArgv1 })

describe('isSingleFileExecutable', () => {
  it('源码态是 false —— 测试自己就跑在源码态', () => {
    expect(isSingleFileExecutable()).toBe(false)
  })

  it('argv[1] 落在 bunfs 虚拟根上就是单文件产物', () => {
    process.argv[1] = '/$bunfs/root/cli'
    expect(isSingleFileExecutable()).toBe(true)
  })

  it('Windows 的虚拟根也要认 —— 只认 POSIX 那个的话,Windows 产物会静默走回开发态分支', () => {
    // 而那条分支拿到的同样是一条不存在的路径,和这次 Linux 上的 bug 一模一样,
    // 只是换个平台才发现。这个仓库的 Windows 发布已经因为同类问题挂过一次。
    process.argv[1] = 'B:\\~BUN\\root\\cli'
    expect(isSingleFileExecutable()).toBe(true)
    // **正斜杠那一种才是 import.meta.url 的形态。** 验收从 bun 二进制里提取到两种都在:
    // `B:\\~BUN\\` 和 `B:/~BUN/`。只写反斜杠的话,删掉 '/~BUN/' 这个 marker
    // 全套测试照样绿 —— 而 Windows 产物会因此静默走回开发态分支,拿到一条不存在的路径。
    process.argv[1] = 'B:/~BUN/root/cli'
    expect(isSingleFileExecutable()).toBe(true)
  })

  it('长得像但不是的路径不算', () => {
    for (const p of ['/home/me/bunfs/cli', '/opt/BUN/cli', '/usr/bin/claude', '']) {
      process.argv[1] = p
      expect(`${p} 被误判: ${isSingleFileExecutable()}`).toBe(`${p} 被误判: false`)
    }
  })
})

describe('isSelfContainedExecutable', () => {
  it('单文件产物也算 —— 它没有可用的脚本路径', () => {
    // 这是所有 `? process.execPath : process.argv[1]` 分支的判据。用「有没有嵌入资源」
    // 判的话,单文件产物会拿到 /$bunfs/root/… 去 spawn,必然 ENOENT。
    process.argv[1] = '/$bunfs/root/cli'
    expect(isSelfContainedExecutable()).toBe(true)
  })

  it('源码态是 false', () => {
    expect(isSelfContainedExecutable()).toBe(false)
  })

  it('和 isInBundledMode 不是同一件事', () => {
    // 实测:stock bun 的 --compile 产物 Bun.embeddedFiles.length === 0。
    // 两者混用正是这次 bug 的根。
    process.argv[1] = '/$bunfs/root/cli'
    expect(`单文件=${isSingleFileExecutable()} 官方构建=${isInBundledMode()}`)
      .toBe('单文件=true 官方构建=false')
  })
})

describe('isLocallyBuiltExecutable', () => {
  // 四个组合都要在,因为两个信号各自都能被误删。
  const cases: Array<[boolean, boolean, boolean, string]> = [
    [true, false, true, '自己 bun build --compile 编的 —— 就是要禁更的那一种'],
    [true, true, false, '官方 native 构建:单文件 + 带嵌入资源,照常更新'],
    [false, false, false, '从源码跑,根本不是单文件'],
    [false, true, false, '带嵌入资源但不是单文件(理论组合),也不算本地构建'],
  ]
  for (const [isSingleFile, isOfficial, want, why] of cases) {
    it(`single=${isSingleFile} official=${isOfficial} → ${want}(${why})`, () => {
      expect(
        isLocallyBuiltExecutable({
          isSingleFile: () => isSingleFile,
          isOfficial: () => isOfficial,
        }),
      ).toBe(want)
    })
  }

  it('默认参数接的是真谓词 —— 测试进程里不是单文件,所以是 false', () => {
    // 这条守的是「接线」:纯函数写对了但没接上去,是这个仓库里反复出现的一类。
    expect(isLocallyBuiltExecutable()).toBe(false)
  })
})

describe('selfInvocationPath', () => {
  // 「要再启动一次自己,该执行哪个文件」—— 十三个消费点里有四处逐字相同,而且**零覆盖**:
  // 把任意一处改回旧判据全套照绿(验收实测 9/9 存活)。抽出来之后两条分支都测得到。
  const deps = (over: Partial<Parameters<typeof selfInvocationPath>[1]> = {}) => ({
    selfContained: () => false,
    execPath: () => '/opt/claude/bin/claude',
    argv1: () => '/repo/src/entrypoints/cli.tsx',
    ...over,
  })

  it('单文件产物:走 execPath', () => {
    // argv[1] 在单文件产物里是 `/$bunfs/root/cli.js` —— **读得到但 spawn 不了**。
    expect(selfInvocationPath(undefined, deps({
      selfContained: () => true,
      argv1: () => '/$bunfs/root/cli.js',
    }))).toBe('/opt/claude/bin/claude')
  })

  it('从源码跑:走 argv[1]', () => {
    expect(selfInvocationPath(undefined, deps())).toBe('/repo/src/entrypoints/cli.tsx')
  })

  it('argv[1] 缺失时用兜底', () => {
    expect(selfInvocationPath('claude', deps({ argv1: () => undefined }))).toBe('claude')
  })

  it('argv[1] 是**空串**时也走兜底', () => {
    // 这正是四份拷贝里那个 `process.argv[1] || 'claude'` 想做的事 —— 而它在单文件产物里
    // 永远短路不到(argv[1] 非空),所以「兜底成 claude」在最需要它的形态下从未生效。
    expect(selfInvocationPath('claude', deps({ argv1: () => '' }))).toBe('claude')
  })

  it('没给兜底又没有 argv[1] 时给空串,不是 undefined', () => {
    // 调用方拿它去 spawn。返回 undefined 会变成字面量 "undefined" 那条路径。
    expect(selfInvocationPath(undefined, deps({ argv1: () => undefined }))).toBe('')
  })

  it('默认参数接的是真谓词 —— 测试进程里不是单文件,所以拿到 argv[1]', () => {
    // 守「接线」:纯函数写对了但没接上去,是这个仓库反复出现的一类。
    expect(selfInvocationPath('claude')).toBe(process.argv[1])
  })
})
