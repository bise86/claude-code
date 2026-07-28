/**
 * 打包态自检探针。**不是产品代码的一部分**,只被 scripts/verify-binary.ts 编来跑一次。
 *
 * 它回答的是单元测试回答不了的那个问题:编成单文件之后,那些「我是谁、我在哪」的判据
 * 到底给出什么,以及**真的去搜一次文件**会不会成功。这个仓库被同一类 bug 咬过三次,
 * 每次都是源码态看着没事、打包态才炸。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInBundledMode, isSelfContainedExecutable, isSingleFileExecutable } from '../../src/utils/bundledMode.js'
import { ripGrep, ripgrepCommand } from '../../src/utils/ripgrep.js'
import { getCurrentInstallationType } from '../../src/utils/doctorDiagnostic.js'

const rg = ripgrepCommand()

// 真的搜一次。判据全对但搜不出东西,等于没修 —— 上一版就差点停在这一步。
const dir = mkdtempSync(join(tmpdir(), 'rgprobe-'))
writeFileSync(join(dir, 'hello.ts'), 'export const marker = 1\n')
let globOk = false
let globErr: string | null = null
try {
  const hits = await ripGrep(['--files'], dir, new AbortController().signal)
  globOk = hits.some(h => h.endsWith('hello.ts'))
} catch (e) {
  globErr = e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}`.trim() : String(e)
}

process.stdout.write(
  JSON.stringify({
    official: isInBundledMode(),
    singleFile: isSingleFileExecutable(),
    selfContained: isSelfContainedExecutable(),
    rgPath: rg.rgPath,
    argv0: rg.argv0 ?? null,
    argv1: process.argv[1] ?? null,
    globOk,
    globErr,
    // NODE_ENV 被 bun **编译期内联**:构建机没设它时固定成 'development',而且运行时
    // 改不动。doctor 的两处判断在 isSelfContainedExecutable() **之前**就按它短路,于是
    // 每个二进制都自报「开发态」——本轮那两处修改在产物里根本执行不到。
    nodeEnv: process.env.NODE_ENV ?? null,
    installationType: await getCurrentInstallationType(),
  }) + '\n',
)
