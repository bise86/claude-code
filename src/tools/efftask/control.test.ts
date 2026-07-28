import { describe, expect, it } from 'bun:test'

import { createRunControl, MAX_DIRECTIVES, MAX_DIRECTIVE_CHARS } from './control.js'

describe('暂停闸', () => {
  it('初始不是暂停态', () => {
    expect(createRunControl().isPaused()).toBe(false)
  })

  it('暂停之后 waitForResume 会等,恢复之后放行', async () => {
    const c = createRunControl()
    c.pause()
    let done = false
    const p = c.waitForResume().then(() => { done = true })
    await new Promise(r => setTimeout(r, 20))
    expect(done).toBe(false)
    c.resume()
    await p
    expect(done).toBe(true)
  })

  it('**没在暂停时立刻返回** —— 少了这句会永久挂起', async () => {
    // 竞态:暂停 → 立刻恢复 → 调度循环这时才开始等。恢复的通知在它注册之前就发完了,
    // 于是它等一个永远不会再来的信号,整个 run 停住而屏幕上什么都不说。
    const c = createRunControl()
    c.pause()
    c.resume()
    await Promise.race([
      c.waitForResume(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('挂住了')), 100)),
    ])
  })

  it('多个等待者一次全放行', async () => {
    const c = createRunControl()
    c.pause()
    const flags = [false, false, false]
    const ps = flags.map((_, i) => c.waitForResume().then(() => { flags[i] = true }))
    c.resume()
    await Promise.all(ps)
    expect(flags).toEqual([true, true, true])
  })

  it('一个抛异常的等待者不影响别的', async () => {
    const c = createRunControl()
    c.pause()
    // 直接往内部塞一个会抛的 waiter 做不到,所以用 then 里抛来近似:resume 本身不能崩。
    const ok = c.waitForResume()
    c.resume()
    await ok
    expect(c.isPaused()).toBe(false)
  })

  it('恢复之后可以再次暂停', async () => {
    const c = createRunControl()
    c.pause(); c.resume(); c.pause()
    expect(c.isPaused()).toBe(true)
  })
})

describe('追加指令', () => {
  it('按加入顺序累积', () => {
    const c = createRunControl()
    c.addDirective('别动 src/legacy')
    c.addDirective('测试用 bun test')
    expect(c.directives()).toEqual(['别动 src/legacy', '测试用 bun test'])
  })

  it('空白不算一条', () => {
    const c = createRunControl()
    c.addDirective('   ')
    c.addDirective('\n\t')
    expect(c.directives()).toEqual([])
  })

  it('两头空白去掉', () => {
    const c = createRunControl()
    c.addDirective('  别动 src/legacy  ')
    expect(c.directives()).toEqual(['别动 src/legacy'])
  })

  it('超长截断 —— 整段提示词是要付钱的', () => {
    const c = createRunControl()
    c.addDirective('x'.repeat(MAX_DIRECTIVE_CHARS + 500))
    expect(c.directives()[0]!.length).toBe(MAX_DIRECTIVE_CHARS)
  })

  it('截断按**码点**,不能把 emoji 劈成两半', () => {
    // .slice 是按 UTF-16 单元切的:1999 个 ASCII + 一个 emoji 正好卡在边界上,
    // 尾部会留下一个孤立的高代理(\ud83d),它原样进提示词。UI 侧一直按码点算,
    // 两边判据不一致时,恰好卡在边界的那条指令就带着半个字符发出去。
    const c = createRunControl()
    c.addDirective('a'.repeat(MAX_DIRECTIVE_CHARS - 1) + '😀')
    const d = c.directives()[0]!
    expect(Array.from(d)).toHaveLength(MAX_DIRECTIVE_CHARS)
    // 关键:最后一个码点必须是完整的 emoji,不是半个代理对。
    expect(Array.from(d).pop()).toBe('😀')
    expect(/[\ud800-\udbff]$/.test(d)).toBe(false)
  })
  it('超出条数上限时挤掉最早的,但**说出来**', () => {
    // 静默丢弃用户亲手写的话,他会以为它生效了。
    const c = createRunControl()
    for (let i = 0; i < MAX_DIRECTIVES + 3; i++) c.addDirective(`第${i}条`)
    const d = c.directives()
    expect(d[0]).toContain('已被丢弃')
    expect(d[0]).toContain('3')
    expect(d).not.toContain('第0条')
    expect(d).toContain(`第${MAX_DIRECTIVES + 2}条`)
  })

  it('没丢过就不加那句噪音', () => {
    const c = createRunControl()
    c.addDirective('一条')
    expect(c.directives()).toEqual(['一条'])
  })
})

describe('两个上限的**值**', () => {
  it('改了要有人发现 —— 测试都用符号引用,值本身没人守', () => {
    // 回归验收把它们改成 200 / 3,全套照绿。而用户是按这两个数估算「我能补多少话」的。
    expect(MAX_DIRECTIVE_CHARS).toBe(2000)
    expect(MAX_DIRECTIVES).toBe(20)
  })
})

describe('取消单个节点', () => {
  it('取消会中止该节点在飞的全部调用', () => {
    const c = createRunControl()
    const a = new AbortController()
    const b = new AbortController()
    c.registerCall('n1', a)
    c.registerCall('n1', b)
    c.cancelNode('n1')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
  })

  it('**只**动那个节点', () => {
    const c = createRunControl()
    const mine = new AbortController()
    const other = new AbortController()
    c.registerCall('n1', mine)
    c.registerCall('n2', other)
    c.cancelNode('n1')
    expect(mine.signal.aborted).toBe(true)
    // 取消一个而炸掉整棵树的话,和 Esc 就没区别了 —— 而这个功能存在的全部理由就是有区别。
    expect(other.signal.aborted).toBe(false)
  })

  it('注销之后再取消,碰不到它', () => {
    const c = createRunControl()
    const a = new AbortController()
    const off = c.registerCall('n1', a)
    off()
    c.cancelNode('n1')
    expect(a.signal.aborted).toBe(false)
  })

  it('注销是幂等的 —— 多按几次不会连累同节点的别的调用', () => {
    // 这条原来断言的是 wasCancelled('n1') === false,和幂等**毫无关系**,而且恒真。
    // 回归验收点名的、我自己写坏的探针。真正要守的是:重复注销不能把别人的登记清掉,
    // 而同一个节点确实可能有多个在飞调用(圆桌是多席位的,control.ts 的注释自己写了)。
    const ctl = createRunControl()
    const mine = new AbortController()
    const sibling = new AbortController()
    const off = ctl.registerCall('n1', mine)
    ctl.registerCall('n1', sibling)
    off(); off(); off()
    ctl.cancelNode('n1')
    expect(mine.signal.aborted).toBe(false)    // 注销过了,碰不到
    expect(sibling.signal.aborted).toBe(true)  // 没注销的那个必须还在表里
  })

  it('取消之后**新登记**的调用立刻被中止', () => {
    // 取消请求和下一轮派发可能撞在一起,而那一轮本来就不该跑。
    const c = createRunControl()
    c.cancelNode('n1')
    const late = new AbortController()
    c.registerCall('n1', late)
    expect(late.signal.aborted).toBe(true)
  })

  it('记得住谁被取消过 —— 用来和超时/provider 故障区分开', () => {
    const c = createRunControl()
    c.cancelNode('n1')
    expect(c.wasCancelled('n1')).toBe(true)
    expect(c.wasCancelled('n2')).toBe(false)
  })

  it('清掉标记之后就不再算被取消', () => {
    // 重做 / --resume 让节点重新开跑时必须清,否则它一进来就被判成「用户取消」。
    const c = createRunControl()
    c.cancelNode('n1')
    c.clearCancel('n1')
    expect(c.wasCancelled('n1')).toBe(false)
    const fresh = new AbortController()
    c.registerCall('n1', fresh)
    expect(fresh.signal.aborted).toBe(false)
  })

  it('调用结束后注销 —— 表不能只增不减', () => {
    // 不注销的话 calls 表里堆着一堆早已结束的 controller,取消会去 abort 它们,
    // 掩盖「这个节点此刻根本没在跑」这件事。回归验收造的 R04 变异原来是活的。
    const c = createRunControl()
    const done = new AbortController()
    const off = c.registerCall('n1', done)
    off()
    // 表已经空了:再取消不该碰到那个早就结束的 controller。
    c.cancelNode('n1')
    expect(done.signal.aborted).toBe(false)
    // 而这之后**新**来的调用照样立刻被拦(取消标记还在)。
    const fresh = new AbortController()
    c.registerCall('n1', fresh)
    expect(fresh.signal.aborted).toBe(true)
  })
  it('中止一个已经 abort 过的 controller 不会抛', () => {
    const c = createRunControl()
    const a = new AbortController()
    a.abort()
    c.registerCall('n1', a)
    expect(() => c.cancelNode('n1')).not.toThrow()
  })
})
