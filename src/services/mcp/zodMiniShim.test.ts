/**
 * `vendor/zod-v4-mini.js` 这层 shim 必须**盖住 SDK 真正用到的每一个名字**。
 *
 * 这条闸门守的是一个只在**编译产物**里出现、而且看起来和 MCP 毫无关系的故障:
 *
 *   本仓库的连接路径: failed —— safeParse3 is not defined
 *
 * 每一台 MCP 服务器都这样 —— http / sse / stdio 一视同仁,因为坏的是所有连接都要过的那段
 * schema 校验。而 `bun run` 跑源码一切正常,所以在开发机上永远看不见。病根是构建脚本的
 * zod 别名只收了 `zod` 和 `zod/v4`,而 `@modelcontextprotocol/sdk` import 的是
 * `zod/v4-mini` —— 那条链照旧走 bun 1.3.14 那条坏掉的 `export *` codegen,编出来的
 * `safeParse3` 从未被定义。用户为此报了三轮「mcp 加载不了」。
 *
 * 现在 `zod/v4-mini` 被别名到一层只有四个名字的 shim。**四个是数出来的,不是估计的**,
 * 所以这里把那次清点变成一条会红的测试:SDK 哪天用了第五个名字,红在这儿,而不是红在
 * 某个用户的二进制里。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SDK_ESM = new URL('../../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).pathname
const SHIM = new URL('../../../vendor/zod-v4-mini.js', import.meta.url).pathname

/** 递归收集 .js —— SDK 的 zod 兼容层将来可能搬家,写死两个文件名会漏。 */
function jsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

/** SDK 里所有 `import * as X from 'zod/v4-mini'` 之后用到的 `X.<名字>`。 */
function namesUsedFromMini(): Set<string> {
  const used = new Set<string>()
  for (const file of jsFiles(SDK_ESM)) {
    const src = readFileSync(file, 'utf8')
    const imp = src.match(/import \* as (\w+) from ['"]zod\/v4-mini['"]/)
    if (!imp) continue
    for (const m of src.matchAll(new RegExp(`\\b${imp[1]!}\\.(\\w+)`, 'g'))) used.add(m[1]!)
  }
  return used
}

describe('zod/v4-mini 的 shim', () => {
  it('SDK 用到的每一个名字,shim 都有', () => {
    const used = namesUsedFromMini()
    // 一个都没数到 = 正则失效(SDK 改了 import 写法),那时这条测试会变成一句空话。
    expect(used.size).toBeGreaterThan(0)
    const shim = readFileSync(SHIM, 'utf8')
    const missing = [...used].filter(n => !new RegExp(`export const ${n}\\b`).test(shim))
    expect(`shim 缺的名字: ${missing.join(', ') || '(无)'}`).toBe('shim 缺的名字: (无)')
  })

  it('四个名字都真的能用,而且 safeParse 是**函数式**的那一种', async () => {
    // mini 是 safeParse(schema, data),classic 是 schema.safeParse(data)。接错方向的话
    // 这里立刻红 —— 而在产物里它会表现成一句和 zod 毫无关系的连接失败。
    const mini = (await import(SHIM)) as {
      object: (shape: Record<string, unknown>) => unknown
      safeParse: (schema: unknown, data: unknown) => { success: boolean; data?: unknown; error?: unknown }
      safeParseAsync: (schema: unknown, data: unknown) => Promise<{ success: boolean }>
      toJSONSchema: (schema: unknown) => unknown
    }
    const classic = await import(new URL('../../../vendor/zod-v4.js', import.meta.url).pathname) as {
      string: () => unknown
    }
    const schema = mini.object({ a: classic.string() })
    expect(mini.safeParse(schema, { a: 'x' })).toEqual({ success: true, data: { a: 'x' } })
    const bad = mini.safeParse(schema, { a: 1 })
    expect(`合法=${mini.safeParse(schema, { a: 'x' }).success} 非法=${bad.success} 带错误=${!!bad.error}`)
      .toBe('合法=true 非法=false 带错误=true')
    expect((await mini.safeParseAsync(schema, { a: 'x' })).success).toBe(true)
    expect(typeof mini.toJSONSchema(schema)).toBe('object')

    /**
     * **拿一个真的 ZodMini schema 再试一遍** —— 那才是 zod-compat 存在的理由(接住用户
     * 自己传进来的 v3 / v4-mini schema),而上面几条用的都是 shim 自己造的。
     *
     * **这里如实记一条测不到的东西:** `safeParse` 写成函数式
     * (`classic.core.safeParse(schema, data)`)还是方法式(`schema.safeParse(data)`),
     * 在**当前这个 zod 版本上行为完全一样** —— 实测 ZodMini 的 schema 身上也挂着
     * `.safeParse` 方法。变异测试把方向对调,这份测试全绿,而那不是漏测,是两者真的等价。
     *
     * 所以这条断言证明的是「真 mini schema 喂得进去、结果对」,不是「方向没写反」。
     * 方向哪天真的开始有区别(mini 去掉那个方法),红的会是这一条 —— 但那是运气,不是设计。
     */
    const realMini = await import(
      new URL('../../../node_modules/zod/v4-mini/index.js', import.meta.url).pathname
    ) as { object: (s: Record<string, unknown>) => unknown; string: () => unknown }
    const miniSchema = realMini.object({ a: realMini.string() })
    expect(mini.safeParse(miniSchema, { a: 'x' })).toEqual({ success: true, data: { a: 'x' } })
  })

  it('构建脚本真的把 zod/v4-mini 别名到了它 —— 少了这一跳,shim 写得再对也没人用', () => {
    // 这是整件事唯一的接线点,而它断掉的表现是「编得出来、跑起来每台 MCP 都连不上」。
    const build = readFileSync(new URL('../../../scripts/build.ts', import.meta.url).pathname, 'utf8')
    expect(build).toMatch(/onResolve\(\{\s*filter:\s*\/\^zod\\\/v4-mini\$\//)
    expect(build).toContain("new URL('../vendor/zod-v4-mini.js', import.meta.url)")
  })
})
