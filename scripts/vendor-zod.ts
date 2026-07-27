#!/usr/bin/env bun
/**
 * 把 zod 压平成 vendor/zod-v4.js。
 *
 * 为什么需要这一步:bun 1.3.14 给 zod 的 `export *` 链生成的懒导出表引用了不存在的符号,
 * 主构建产物一跑就 `ReferenceError: _uppercase2 is not defined`。这**不是**重复打包 ——
 * 产物里只有一份 checks.js;单独打包 zod 也完全正常。所以先把它压平成一个文件,主构建
 * 再指向那一份,就绕开了出问题的那条 codegen 路径。
 *
 * 产物已提交进仓库,所以正常构建不需要跑这个脚本。升级 zod 之后重跑一次:
 *   bun run scripts/vendor-zod.ts
 */
const out = await Bun.build({
  entrypoints: ['./node_modules/zod/v4/index.js'],
  outdir: 'vendor',
  format: 'esm',
  target: 'bun',
  naming: 'zod-v4.js',
})
if (!out.success) {
  for (const l of out.logs) console.error(l)
  process.exit(1)
}
console.log('已生成 vendor/zod-v4.js')
