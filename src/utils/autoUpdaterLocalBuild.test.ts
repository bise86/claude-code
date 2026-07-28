import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { getAutoUpdaterDisabledReason } from './config.js'

/**
 * 这一条守的是一颗拆下来的实弹。
 *
 * 把 NODE_ENV 钉成 production(单文件产物必须这么编,否则 doctor 那批修复是死代码)
 * 之后,getCurrentInstallationType() 把这个 fork 判成 'native',AutoUpdaterWrapper
 * 就会选 NativeAutoUpdater,进而 installLatest() 从 Anthropic 的发布桶下载**官方的
 * claude** 覆盖掉 ~/.local/bin/claude。也就是说:用户自己编的这份东西会把自己换成
 * 别的程序。
 *
 * 唯一的收口点是 getAutoUpdaterDisabledReason() —— NativeAutoUpdater 在真正安装前
 * 会先问它。所以这条用例直接盯着那个收口点。
 */
describe('自编单文件产物不许自动更新', () => {
  const argv1 = process.argv[1]
  const nodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // 不能是 development —— 否则会被前面那条更早的出口挡掉,这条用例就变成恒真的。
    process.env.NODE_ENV = 'production'
  })
  afterEach(() => {
    process.argv[1] = argv1
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
  })

  it('argv[1] 落在 bunfs 虚拟根上时,禁更并说明是本地构建', () => {
    process.argv[1] = '/$bunfs/root/cli.js'
    expect(getAutoUpdaterDisabledReason()).toEqual({ type: 'local-build' })
  })

  it('普通脚本路径不受影响 —— 这条阀只针对单文件产物', () => {
    process.argv[1] = '/home/me/repo/src/entrypoints/cli.tsx'
    /**
     * 这里断言的是「**走过去了**」,不是返回值。
     *
     * 往下第一件事就是 getGlobalConfig(),它在测试进程里必抛 "Config accessed
     * before allowed"。所以这个抛错恰好是一个精确的结构性探针:它证明 local-build
     * 那条分支**没有**命中。写成 `not.toEqual({type:'local-build'})` 反而是空的 ——
     * 抛错的用例根本走不到断言,红绿都由抛错决定,和分支无关。
     */
    expect(() => getAutoUpdaterDisabledReason()).toThrow(/Config accessed/)
  })
})
