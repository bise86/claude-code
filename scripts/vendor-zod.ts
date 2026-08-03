#!/usr/bin/env bun
/**
 * 把 zod 压平成 vendor/zod-v4.js **和 vendor/zod-v4-mini.js**。
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

/**
 * `zod/v4-mini` **不压平,写一层 shim**。
 *
 * 压平它试过,不行:bun 1.3.14 编出来的 `vendor/zod-v4-mini.js` 末尾那张导出表里有 24 个
 * **从未被定义**的名字(`toJSONSchema`、`coerce`、`iso`、`registry`、`$brand` …),主构建
 * 当场报 `"$brand2" is not declared in this file`,整包一个字节都编不出来。那是它压不平
 * `export *` 链的同一族毛病 —— 而 mini 的 external.js 恰好整个建立在 `export *` 上。
 *
 * 但**真正被用到的只有四个名字**,而且只有 @modelcontextprotocol/sdk 在用(全依赖树 grep
 * 确认:zod-compat 用 object / safeParse / safeParseAsync,zod-json-schema-compat 用
 * toJSONSchema)。所以这里不复刻整个 mini,只把这四个接到已经压平好、而且工作正常的
 * classic 那一份上:
 *
 *  - `object` / `toJSONSchema`:classic 顶层同名导出,同一个实现;
 *  - `safeParse` / `safeParseAsync`:mini 是**函数式**(`safeParse(schema, data)`),classic
 *    是方法式(`schema.safeParse(data)`)。两者底下是同一个 `core`,而 core 导出的正是函数式
 *    的那一份 —— 实测对照过,合法输入都是 `{success:true,data}`,非法输入都是
 *    `{success:false,error}`。
 *
 * 代价写清楚:`z4mini.object()` 造出来的是 classic 的 ZodObject 而不是 ZodMiniObject。
 * SDK 只拿它做两件事 —— `isZ4Schema`(看 `._zod`,两者都有)和喂给 `safeParse` —— 所以
 * 行为一致;但如果哪天 SDK 开始依赖 mini 专有的东西,这里会**静默**地不一样。
 * 那一天的信号是:这个文件里的名单和 SDK 实际用到的名字对不上了。
 */
const MINI_SHIM = `// 由 scripts/vendor-zod.ts 生成,勿手改。理由见那个脚本里的长注释。
import * as classic from './zod-v4.js'

export const object = classic.object
export const toJSONSchema = classic.toJSONSchema
export const safeParse = (schema, data) => classic.core.safeParse(schema, data)
export const safeParseAsync = (schema, data) => classic.core.safeParseAsync(schema, data)
`
await Bun.write('vendor/zod-v4-mini.js', MINI_SHIM)
console.log('已生成 vendor/zod-v4-mini.js(shim,不是压平产物)')
