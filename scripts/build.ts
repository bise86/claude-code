#!/usr/bin/env bun
/**
 * 打包 / 编译入口。
 *
 * **单文件编译是可用的**(四平台都产出可执行文件)。这一段记的是它曾经为什么不可用,
 * 以及现在靠什么撑着 —— 拆掉那根撑杆就会原样复发。
 *
 * bun 1.3.14 的打包器会打散 zod v4 的循环 re-export:实测编出来的二进制 `--version`
 * 正常,`--help` 直接 `ReferenceError: _uppercase2 is not defined`。把 zod 标成
 * external 能绕开,但 `--compile` 不会把 external 模块嵌进单文件,于是二进制在没有
 * node_modules 的目录里报 `Cannot find module zod/v4`——等于没解决。
 *
 * 现在的解法是**预先把 zod 压平成一个文件**(scripts/vendor-zod.ts → vendor/zod-v4.js,
 * 已提交进仓库),主构建用下面的 zodAlias 插件指向那一份,绕开出问题的那条 codegen 路径。
 *
 * 复现原问题:删掉 zodAlias,然后 bun run scripts/build.ts --compile && ./dist/claude-haha --help
 *
 * 两种产物:
 *   bun run scripts/build.ts            → dist/cli.js(需要目标机器有 bun/node)
 *   bun run scripts/build.ts --compile  → dist/claude-haha(单文件可执行,不需要运行时)
 *
 * 为什么需要这么长一张 external 清单:这个仓库里有大量**可选**导入 —— 云厂商 SDK 变体、
 * OpenTelemetry 的各种 exporter、sharp/fflate/turndown,以及一批只存在于上游、本 fork 里
 * 并没有的文件。它们在源码里都是动态 import / 受保护的 require,运行时缺了就走降级分支;
 * 但 bundler 会**静态**解析它们,于是不标 external 就编不过。
 *
 * 标成 external 之后,编译产物的行为与今天 `bun ./src/entrypoints/cli.tsx` 从源码跑
 * **完全一致** —— 那些模块今天也是缺的。
 */
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** 可选的第三方模块:装了就用,没装走降级。 */
const OPTIONAL_PACKAGES = [
  'sharp', 'fflate', 'turndown',
  '@anthropic-ai/bedrock-sdk', '@anthropic-ai/foundry-sdk',
  '@anthropic-ai/mcpb', '@anthropic-ai/vertex-sdk',
  '@aws-sdk/client-bedrock', '@aws-sdk/client-sts', '@azure/identity',
  '@opentelemetry/exporter-logs-otlp-grpc', '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc', '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto', '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
]

/**
 * 只存在于上游、本 fork 里没有的文件。
 *
 * 它们各自的调用点都在 try/catch 或 NODE_ENV 判断后面,今天从源码跑同样解析不到 ——
 * 所以这里不是「隐藏一个错误」,是让打包器接受一个源码本来就允许的缺失。
 */
const MISSING_UPSTREAM_MODULES = [
  './assistant/AssistantSessionChooser.js',
  './cachedMicrocompact.js',
  './commands/agents-platform/index.js',
  './commands/assistant/assistant.js',
  './components/agents/SnapshotUpdateDialog.js',
  './devtools.js',
  './protectedNamespace.js',
  '../services/compact/snipCompact.js',
  '../services/contextCollapse/index.js',
  './tools/REPLTool/REPLTool.js',
  './tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js',
  './tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js',
]

/**
 * `MACRO` 平时由 `preload.ts` 挂到 globalThis 上(bunfig.toml 的 preload)。
 *
 * 打包/编译产物**不会**跑 preload —— 实测编出来的二进制一跑 `--version` 就
 * `ReferenceError: MACRO is not defined`。所以这里把它做成编译期常量静态替换掉。
 *
 * 取值与 preload.ts 保持一致,并允许 CI 用同名环境变量注入真实版本号/构建时间。
 */
const MACRO_DEFINE = {
  VERSION: process.env.CLAUDE_CODE_LOCAL_VERSION ?? '999.0.0-local',
  PACKAGE_URL: process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local',
  NATIVE_PACKAGE_URL: process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local',
  BUILD_TIME: process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString(),
  FEEDBACK_CHANNEL: 'local',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '',
}

const argv = process.argv.slice(2)
const compile = argv.includes('--compile')
/** 读 `--flag value` 形式的参数。 */
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
/**
 * 交叉编译目标(bun-linux-x64 / bun-darwin-arm64 / bun-windows-x64 …)。
 * 省略 = 当前平台。CI 用它在一次 matrix 里出四个平台的二进制。
 */
const target = argOf('--target')
const outfile = argOf('--outfile')
/**
 * 换一个入口来编。
 *
 * 只服务于一件事:**在打包态验证行为**。这个仓库已经被同一类 bug 咬过两次 ——
 * Windows 的 `.pathname`、以及 ripgrep 的 `/$bunfs/root/…` —— 共同点是
 * 「从源码跑一切正常、编成单文件才错」,而单元测试全在源码态跑,一条都拦不住。
 * 有了它就能把探针也用**同一套插件和 define** 编出来,而不是另写一份必然漂移的配置。
 */
const entry = argOf('--entry')
// 写了 --entry 却取不到值时,argOf 返回 undefined,于是**静默**编了正式入口 ——
// 而调用方以为自己编的是探针。宁可硬失败。
if (process.argv.includes('--entry') && !entry) {
  console.error('--entry 需要一个入口文件路径')
  process.exit(1)
}
const outdir = 'dist'
// 只在**用默认产物目录**时清它。--outfile 指到别处还照删的话,
// scripts/verify-binary.ts 每跑一次就把正式产物抹掉一次(CI 里 build → verify → upload
// 就会上传一个空目录)。
if (!outfile) await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

/**
 * `external` 只认裸模块名,相对路径要靠 onResolve 拦。
 *
 * 返回 external 而不是替换成空模块:空模块会让 `await import(...)` 成功并返回一个空对象,
 * 于是调用方拿到 undefined 再在别处炸,堆栈指向一个和原因无关的地方。让它保持解析失败,
 * 源码里那些 try/catch 才会按设计接住。
 */
/**
 * 把裸 `zod` 收敛到 `zod/v4`。
 *
 * 本仓库源码全部用 `zod/v4`(131 处),但依赖树里有包 import 裸 `zod`。两条路径在 bun
 * 眼里是两个模块图,于是 zod 内部被**打包两份**,第二份的 __export 绑定指向从未定义的
 * 符号 —— 实测产物一跑就 `ReferenceError: _uppercase2 is not defined`。
 *
 * 两个入口最终都落到 v4 classic,所以收敛是安全的:根入口是
 * `export * from ./v4/classic/external.js` + 具名 z + default,`zod/v4` 是
 * `export * from ./classic/index.js` + default,具名 z 由那个 star 提供。
 */
const zodAlias = {
  name: 'zod-single-copy',
  setup(build: { onResolve: (o: { filter: RegExp }, cb: (a: { path: string }) => unknown) => void }) {
    // 指向**预先压平**的那一份,而不是 node_modules 里的原始入口。
    //
    // 原因:bun 1.3.14 给 zod 的 export * 链生成的懒导出表引用了不存在的符号
    // (实测产物一跑就 ReferenceError: _uppercase2 is not defined),而且不是重复打包 ——
    // 产物里只有一份 checks.js。单独打包 zod 却没事,所以先把它压平成一个文件,主构建
    // 再指向那一份,就绕开了出问题的那条 codegen 路径。
    //
    // vendor/zod-v4.js 由 scripts/vendor-zod.ts 生成,已提交进仓库。
    //
    // **必须 fileURLToPath,不能用 .pathname。** 在 Windows 上 file URL 的 pathname 是
    // `/D:/a/claude-code/vendor/zod-v4.js` —— 盘符前面多一个斜杠,bun 拿去读就是
    // `EINVAL reading file`,四平台里只有 windows-x64 那一条挂掉。POSIX 上两者恰好
    // 相同,所以本机怎么跑都发现不了。
    const flat = fileURLToPath(new URL('../vendor/zod-v4.js', import.meta.url))
    build.onResolve({ filter: /^zod(\/v4)?$/ }, () => ({ path: flat }))
  },
}

const externalRelative = {
  name: 'external-missing-upstream',
  setup(build: { onResolve: (o: { filter: RegExp }, cb: (a: { path: string }) => unknown) => void }) {
    const missing = new Set(MISSING_UPSTREAM_MODULES)
    build.onResolve({ filter: /^\.{1,2}\// }, args =>
      missing.has(args.path) ? { path: args.path, external: true } : undefined)
  },
}

const result = await Bun.build({
  entrypoints: [entry ?? './src/entrypoints/cli.tsx'],
  // compile 模式下 outdir 会和 compile.outfile **叠加**(实测产物落在 dist/dist/),
  // 所以只在打包模式给它。
  ...(compile ? {} : { outdir }),
  target: 'bun',
  // 不 minify:这是个 CLI,启动时间由 bun 的解析速度决定而不是字节数,而可读的堆栈
  // 在用户报 bug 时值钱得多。
  minify: false,
  external: OPTIONAL_PACKAGES,
  // 整体替换 `MACRO`,而不是逐个 `MACRO.VERSION` —— 源码里有 `MACRO.X` 也有对整个
  // 对象的引用,只替字段会漏掉后者。
  define: {
    MACRO: JSON.stringify(MACRO_DEFINE),
    /**
     * **必须显式定死。**
     *
     * bun 把 `process.env.NODE_ENV` 当编译期常量替换,构建机没设这个变量时固定内联成
     * `"development"` —— 而且**运行时再设也改不动**(实测 `NODE_ENV=production ./bin`
     * 里读到的仍是 development)。后果不是「少个优化」:
     *   - doctorDiagnostic 的 getCurrentInstallationType/getInstallPath 在判断
     *     isSelfContainedExecutable() **之前**就 `if (NODE_ENV === 'development') return`,
     *     于是每个二进制都自报「开发态」;
     *   - config.ts 的自动更新在每个二进制里恒被判为 disabled;
     *   - ink/reconciler 恒去 import devtools(已 external),编译态多一次 reject。
     */
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  // biome-ignore lint/suspicious/noExplicitAny: Bun 插件类型在此版本里不够精确
  // biome-ignore lint/suspicious/noExplicitAny: Bun 插件类型在此版本里不够精确
  plugins: [zodAlias as any, externalRelative as any],
  ...(compile
    ? { compile: { outfile: outfile ?? `${outdir}/claude-haha`, ...(target ? { target } : {}) } }
    : {}),
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(compile ? `已编译: ${outfile ?? `${outdir}/claude-haha`}${target ? ` (${target})` : ''}` : `已打包: ${outdir}/cli.js`)
