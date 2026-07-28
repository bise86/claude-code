/**
 * 打包态自检探针。**不是产品代码的一部分**,只被 scripts/verify-binary.ts 编来跑一次。
 *
 * 它回答的是单元测试回答不了的那个问题:编成单文件之后,那些「我是谁、我在哪」的判据
 * 到底给出什么。这个仓库被同一类 bug 咬过两次,两次都是源码态全绿、打包态才错。
 */
import { isInBundledMode, isSelfContainedExecutable, isSingleFileExecutable } from '../../src/utils/bundledMode.js'
import { ripgrepCommand } from '../../src/utils/ripgrep.js'

const rg = ripgrepCommand()
process.stdout.write(
  JSON.stringify({
    official: isInBundledMode(),
    singleFile: isSingleFileExecutable(),
    selfContained: isSelfContainedExecutable(),
    rgPath: rg.rgPath,
    argv0: rg.argv0 ?? null,
    argv1: process.argv[1] ?? null,
  }) + '\n',
)
