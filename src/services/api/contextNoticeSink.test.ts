/**
 * 上下文改写事件的旁路上报。
 *
 * 这条通道存在的全部理由:第一版把落盘/抢救的可见出口接在
 * `toolUseContext.addNotification` 上,而 `createSubagentContext` 对子 agent **写死**
 * `addNotification: undefined` —— 于是「预算生效的上下文」和「通知可用的上下文」
 * 是两个不相交的集合,那个出口在唯一会触发它的路径上是一次完整的空操作。
 * 验收席跑真接缝证出来的,所以这里的探针要钉的是「没人听时诚实地说没人听」。
 */
import { describe, expect, test } from 'bun:test'
import {
  reportContextNotice,
  withContextNoticeSink,
  type ContextNotice,
} from './contextNoticeSink.js'

describe('contextNoticeSink', () => {
  /**
   * 返回值就是调用点用来决定「要不要退回 addNotification」的那个布尔。
   * 变异:让 `reportContextNotice` 恒返回 true → 这条会红,而且那是最坏的形态
   * (调用点以为报出去了,于是连退路也不走,两条通道同时静默)。
   */
  test('没人听的时候返回 false', () => {
    expect(
      reportContextNotice({ kind: 'tool-result-persisted', text: '无人接收' }),
    ).toBe(false)
  })

  // 变异:`store.run(sink, fn)` 改成直接 `fn()` → 这条会红。
  test('有人听的时候收得到,并返回 true', () => {
    const got: ContextNotice[] = []
    const ok = withContextNoticeSink(
      n => got.push(n),
      () => reportContextNotice({ kind: 'ptl-volume-shrink', text: '换了 3 条' }),
    )
    expect(ok).toBe(true)
    expect(got).toEqual([{ kind: 'ptl-volume-shrink', text: '换了 3 条' }])
  })

  /**
   * **跨异步边界要跟得住** —— 这是选 ALS 而不是全局回调的全部理由:落盘发生在
   * `query.ts` 深处,和装 sink 的那一层隔着好几个 await。
   * 变异:把 AsyncLocalStorage 换成模块级变量 → 并发两席时会串台(下一条钉它)。
   */
  test('跨 await 仍然归属正确', async () => {
    const got: string[] = []
    await withContextNoticeSink(
      n => got.push(n.text),
      async () => {
        await Promise.resolve()
        await new Promise(r => setTimeout(r, 1))
        reportContextNotice({ kind: 'tool-result-persisted', text: '深处报的' })
      },
    )
    expect(got).toEqual(['深处报的'])
  })

  /**
   * 一次 `/et` 里几十个节点并行,两席各自的事件不能串台。
   * 变异:模块级单变量实现 → 两个数组都会收到对方的那条,这条会红。
   */
  test('并发两席各归各的', async () => {
    const a: string[] = []
    const b: string[] = []
    const seat = (bucket: string[], tag: string) =>
      withContextNoticeSink(
        n => bucket.push(n.text),
        async () => {
          await new Promise(r => setTimeout(r, tag === 'a' ? 5 : 1))
          reportContextNotice({ kind: 'tool-result-persisted', text: tag })
        },
      )
    await Promise.all([seat(a, 'a'), seat(b, 'b')])
    expect([a, b]).toEqual([['a'], ['b']])
  })

  /**
   * sink 自己抛也不能让那次真实调用失败 —— 它跑在热路径上,一个可见性功能
   * 没有资格让一次真实的模型调用炸掉(和 `usageSink.reportApiUsage` 同一条理由)。
   * 变异:去掉 try/catch → 这条会红。
   */
  test('sink 抛异常时吞掉并返回 false', () => {
    const ok = withContextNoticeSink(
      () => {
        throw new Error('UI 挂了')
      },
      () => reportContextNotice({ kind: 'ptl-volume-shrink', text: 'x' }),
    )
    expect(ok).toBe(false)
  })
})
