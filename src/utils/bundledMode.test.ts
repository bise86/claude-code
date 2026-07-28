import { afterEach, describe, expect, it } from 'bun:test'
import { isInBundledMode, isSelfContainedExecutable, isSingleFileExecutable,
  isLocallyBuiltExecutable,
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
