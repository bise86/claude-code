/**
 * 打包态自检 —— 编一个探针,跑起来,断言那些**只在单文件产物里才会变的**判据。
 *
 * 为什么要有这个脚本:这个仓库被同一类 bug 咬过两次,两次都是**源码态全绿、编成
 * 二进制才错**,而 `bun test` 全在源码态跑,一条都拦不住:
 *
 *  1. Windows 发布挂在 `new URL(...).pathname` 上 —— 盘符前多一个斜杠,四平台里
 *     只有 windows-x64 那条腿断,本机怎么跑都发现不了。
 *  2. `ENOENT: posix_spawn '/$bunfs/root/vendor/ripgrep/x64-linux/rg'` —— 单文件产物里
 *     `import.meta.url` 指向 bunfs 虚拟根,嵌进去的东西只能读、不能 spawn。
 *
 * 用法:`bun run scripts/verify-binary.ts`(编译 + 断言,约 10 秒)。
 * 探针用的是**同一套构建插件和 define**(走 scripts/build.ts 的 --entry),
 * 不是另写一份必然漂移的配置。
 */
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(tmpdir(), `claude-shape-probe-${process.pid}`)

type Shape = {
  official: boolean
  singleFile: boolean
  selfContained: boolean
  rgPath: string
  argv0: string | null
  argv1: string | null
}

const fail: string[] = []
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`)
  if (!ok) fail.push(msg)
}

const build = Bun.spawnSync([
  'bun', 'run', 'scripts/build.ts', '--compile',
  '--entry', './scripts/probes/runtimeShape.ts', '--outfile', OUT,
])
if (build.exitCode !== 0) {
  console.error(new TextDecoder().decode(build.stderr))
  process.exit(1)
}

const run = Bun.spawnSync([OUT])
const raw = new TextDecoder().decode(run.stdout).trim()
if (run.exitCode !== 0 || raw.length === 0) {
  console.error('探针没跑起来:', new TextDecoder().decode(run.stderr))
  process.exit(1)
}
const shape = JSON.parse(raw) as Shape
console.log(raw)

// 单文件产物必须认得出自己。认不出的话,下面每一条都会走开发态分支。
check(shape.singleFile === true, 'isSingleFileExecutable() 在单文件产物里为 true')
check(shape.selfContained === true, 'isSelfContainedExecutable() 为 true(spawn 自己,而不是找脚本路径)')
// 我们不是官方 native 构建:ripgrep 没有静态链进来,argv0 分发不成立。
// 实测过 `spawn(ourBinary, ['--version'], { argv0: 'rg' })` → 返回的是 Claude 的版本号。
check(shape.official === false, 'isInBundledMode() 为 false(本 fork 不嵌资源,argv0 分发不可用)')
check(shape.argv0 === null, 'ripgrep 不走 argv0 分发')

// **这条是本次 bug 的原点。**
check(!shape.rgPath.includes('$bunfs'), `rg 路径不指向 bunfs 虚拟根(实际: ${shape.rgPath})`)
check(!shape.rgPath.includes('~BUN'), 'rg 路径不指向 Windows 的 bunfs 虚拟根')

// argv[1] 在单文件产物里就是虚拟路径 —— 这条不是缺陷,是**前提**:它解释了为什么
// 所有 `? execPath : argv[1]` 的分支都必须按 selfContained 判,而不是按有没有嵌入资源。
check(
  shape.argv1 === null || shape.argv1.includes('$bunfs') || shape.argv1.includes('~BUN'),
  'argv[1] 在单文件产物里是虚拟路径(所以不能拿它当脚本路径)',
)

await rm(OUT, { force: true })
if (fail.length > 0) {
  console.error(`\n${fail.length} 条不通过`)
  process.exit(1)
}
console.log('\n打包态自检通过')
