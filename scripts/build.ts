#!/usr/bin/env bun
/**
 * 打包 / 编译入口。
 *
 * **单文件编译目前是坏的,原因不在本仓库。** bun 1.3.14 的打包器会打散 zod v4 的循环
 * re-export —— 实测编出来的二进制 `--version` 正常,`--help` 直接
 * `ReferenceError: _uppercase2 is not defined`。把 zod 标成 external 打包就好了,但
 * `--compile` 不会把 external 模块嵌进单文件,于是二进制在没有 node_modules 的目录里
 * 报 `Cannot find module zod/v4`。1.3.14 已是当时最新版,没有升级可绕;换 zod 大版本
 * 的爆炸半径覆盖全仓库。所以发布走「打包产物 + 外部 zod」,不是单文件。
 *
 * 复现:bun run scripts/build.ts --compile && ./dist/claude-haha --help
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

/** 可选的第三方模块:装了就用,没装走降级。 */
const OPTIONAL_PACKAGES = [
  'sharp', 'fflate', 'turndown',
  // zod 不是可选的 —— 它是被迫外置的。见文件顶部那段。
  'zod',
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

const compile = process.argv.includes('--compile')
const outdir = 'dist'
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

/**
 * `external` 只认裸模块名,相对路径要靠 onResolve 拦。
 *
 * 返回 external 而不是替换成空模块:空模块会让 `await import(...)` 成功并返回一个空对象,
 * 于是调用方拿到 undefined 再在别处炸,堆栈指向一个和原因无关的地方。让它保持解析失败,
 * 源码里那些 try/catch 才会按设计接住。
 */
const externalRelative = {
  name: 'external-missing-upstream',
  setup(build: { onResolve: (o: { filter: RegExp }, cb: (a: { path: string }) => unknown) => void }) {
    const missing = new Set(MISSING_UPSTREAM_MODULES)
    build.onResolve({ filter: /^\.{1,2}\// }, args =>
      missing.has(args.path) ? { path: args.path, external: true } : undefined)
  },
}

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  // compile 模式下 outdir 会和 compile.outfile **叠加**(实测产物落在 dist/dist/),
  // 所以只在打包模式给它。
  ...(compile ? {} : { outdir }),
  target: 'bun',
  // 不 minify:这是个 CLI,启动时间由 bun 的解析速度决定而不是字节数,而可读的堆栈
  // 在用户报 bug 时值钱得多。
  minify: false,
  external: OPTIONAL_PACKAGES,
  // biome-ignore lint/suspicious/noExplicitAny: Bun 插件类型在此版本里不够精确
  plugins: [externalRelative as any],
  ...(compile ? { compile: { outfile: `${outdir}/claude-haha` } } : {}),
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(compile ? `已编译: ${outdir}/claude-haha` : `已打包: ${outdir}/cli.js`)
