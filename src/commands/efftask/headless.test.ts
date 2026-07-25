/**
 * `/et` 在 headless(`claude -p`)下必须**拒绝**,而不是悄悄产生副作用。
 *
 * spec §12 把 headless 列为 Non-Goal。但 processSlashCommand 只在 `await mod.call(...)`
 * 之后才检查 isNonInteractiveSession,所以"非目标"此前的实现方式是:call() 照常跑完、
 * allocateRunId 在用户仓库里真建一个编号目录、往父 abortController 挂一个监听器,然后
 * 返回的 JSX 被整个丢掉,用户什么都看不到。每跑一次泄漏一个空目录,并顶掉下一个编号。
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { call } from './efftask.js'

/**
 * 只带 isNonInteractiveSession 的最小 context。
 *
 * 缺 abortController / options.tools / canUseTool —— 这本身就是断言的一部分:守卫只要
 * 没在最前面拦住,后面几行就会去读 context.abortController.signal 而抛错。所以"干净地
 * 返回 null"本身证明了它是**在**分配 run id 之前返回的。
 */
const headlessCtx = { options: { isNonInteractiveSession: true } } as never

const runDirs = (): string[] => {
  try { return readdirSync(`${process.cwd()}/.claude/efftask`) } catch { return [] }
}

describe('spec §12:headless 下 /et 拒绝启动', () => {
  it('给出解释并返回 null,不渲染任何 JSX', async () => {
    const said: string[] = []
    const jsx = await call(msg => { said.push(msg ?? '') }, headlessCtx, '做个登录功能')
    expect(jsx).toBeNull()
    expect(said).toHaveLength(1)
    // 说清是什么、为什么、以及怎么办 —— 一个只说"不支持"的拒绝会让用户以为是坏了。
    expect(said[0]).toContain('headless')
    expect(said[0]).toContain('交互式')
    // 并且明说没有留下东西:用户不必自己去 .claude/efftask 里翻有没有半个目录。
    expect(said[0]).toContain('不会创建 run 目录')
  })

  it('确实没有在磁盘上留下 run 目录', async () => {
    // 真的去数目录,而不是相信守卫的位置。allocateRunId 用 mkdirExclusive 保留编号,
    // 那是一次真实的 mkdir;如果守卫挪到了它后面,这里就会多出一个。
    const before = runDirs()
    await call(() => {}, headlessCtx, '做个登录功能')
    expect(runDirs()).toEqual(before)
  })

  it('--resume 在 headless 下同样被拒绝', async () => {
    // resume 路径不分配新编号,但会挂监听器、并进入一个永远不会挂载的选择器。
    const said: string[] = []
    const jsx = await call(msg => { said.push(msg ?? '') }, headlessCtx, '--resume latest')
    expect(jsx).toBeNull()
    expect(said[0]).toContain('headless')
  })
})
