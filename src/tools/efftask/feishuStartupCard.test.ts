import { describe, expect, it } from 'bun:test'
import { buildStartupCard, buildHandoffCard } from './feishuStartupCard.js'
import { capsLine, costLine } from './startupConfirm.js'

describe('启动卡不能邀请一件它自己会丢掉的事', () => {
  it('不再说"如需调整请在终端修改" —— 在此批准正是丢弃终端修改的那条路径', () => {
    // The card claims with {parallelism, approved} snapshotted at gate-open and carries no
    // roster at all; applyStartupDecision reads an absent roster as "unchanged". So approving
    // from here uses the values on THIS card, and any terminal edit is discarded.
    const cfg = {
      goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
      caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
      phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
    }
    const card = buildStartupCard(cfg as never, 'req-1') as { elements: { text?: { content: string } }[] }
    const text = card.elements.map(e => e.text?.content ?? '').join('\n')
    expect(text).not.toContain('如需调整请在终端确认界面修改')
    expect(text).toContain('在此批准 = 就用本卡片显示的并行数与名册')
  })
})

describe('两个界面必须说同一件事', () => {
  const cfg = (over: object = {}) => ({
    goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
    phaseRoles: { plan: [], review: [{ roleName: 'a' }, { roleName: 'b' }], execute: [], accept: [], observer: [] },
    ...over,
  })
  const text = (c: object) => {
    const card = buildStartupCard(c as never, 'req-1') as { elements: { text?: { content: string } }[] }
    return card.elements.map(e => e.text?.content ?? '').join('\n')
  }

  it('卡片带上和终端同一行的成本预估', () => {
    // 竞速器的前提是两端显示同一份配置 —— 谁先点谁算数。终端说了代价而卡片没说,
    // 从飞书批准的人批准的就是一份他没看全的配置。
    expect(text(cfg())).toContain(costLine(cfg() as never))
    /**
     * capsLine **整行**也要钉,而不是逐条钉它里面的字段。
     *
     * 验收造的变异:卡片侧把 capsLine 的输出正则剥掉「· 静默超时 …」那一段 —— 433 tests
     * 全绿。逐条钉的写法对**下一个**新增字段同样无效,而这一行的字段还会长。
     */
    expect(text(cfg())).toContain(capsLine(cfg() as never))
    /**
     * capsLine **整行**也要钉,而不是逐条钉它里面的字段。
     *
     * 验收造的变异:卡片侧把 capsLine 的输出正则剥掉「· 静默超时 …」那一段 —— 433 tests
     * 全绿。逐条钉的写法对**下一个**新增字段同样无效,而这一行的字段还会长。
     */
    expect(text(cfg())).toContain(capsLine(cfg() as never))
    expect(text(cfg())).toContain('次模型调用')
  })

  it('不是全票时卡片也要说', () => {
    const c = cfg({ caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1, quorum: 60 } })
    expect(text(c)).toContain('需 60% 席位赞成')
  })
})

describe('收口卡片:不可逆动作不上卡', () => {
  const H = {
    branch: 'efftask/001/integration', commits: 3,
    integrationPath: '/repo/.wt/int', kept: [], salvage: [], outcome: 'completed' as const,
  }
  const card = (h = H) => buildHandoffCard(h, '001', 'req-1') as {
    elements: { text?: { content: string }; actions?: { text: { content: string } }[] }[]
  }
  const buttons = (h = H) => card(h).elements.flatMap(e => e.actions ?? []).map(a => a.text.content)
  const text = (h = H) => card(h).elements.map(e => e.text?.content ?? '').join('\n')

  it('三个按钮,没有「丢弃」', () => {
    // 丢弃不可逆,而这条通道没有过期机制、点击失效卡完全静默、updateCard 吞掉所有错误。
    // 不可逆动作配上一条「点了没反应也不知道」的通道,是最坏的组合。
    expect(buttons()).toEqual(['合并回当前分支', '推送分支', '保留分支'])
    expect(buttons().join('')).not.toContain('丢弃')
  })

  it('但要说清这个选项存在、去哪儿做 —— 不是假装它不存在', () => {
    expect(text()).toContain('丢弃')
    expect(text()).toContain('终端')
  })

  it('「推送」不叫「建 PR」,和终端一致', () => {
    expect(buttons().join('')).not.toContain('PR')
  })

  it('每个按钮带上自己的 choice,否则三个按钮点下去是同一件事', () => {
    const acts = card().elements.flatMap(e => e.actions ?? []) as unknown as
      { behaviors: { value: { choice?: string } }[] }[]
    expect(acts.map(a => a.behaviors[0].value.choice)).toEqual(['merge', 'push', 'keep'])
  })

  it('run 没跑完时卡片顶部就说清楚', () => {
    const t = text({ ...H, outcome: 'blocked', reason: '连续返工超限' })
    expect(t).toContain('没有正常跑完')
    expect(t).toContain('连续返工超限')
  })

  it('分支与提交数如实显示', () => {
    expect(text()).toContain('efftask/001/integration')
    expect(text()).toContain('3 个提交')
    expect(text()).toContain('你的工作区未被改动')
  })

  /**
   * 逐任务合并之后,「你的工作区未被改动」在中途合成功过的运行上逐字为假 —— 那些提交
   * 早就在用户的目录里了。三处渲染器都印过这句话,这里是飞书那一处。
   */
  it('中途合过就不许说「你的工作区未被改动」', () => {
    const t = text({ ...H, trunkLanded: 5 })
    expect(t).not.toContain('你的工作区未被改动')
    expect(t).toContain('5 个提交已在跑的过程中合进了你当前的分支')
    expect(t).toContain('还有 3 个提交没合进来')
  })
})

describe('组合警告两端都要有', () => {
  it('飞书卡带上和终端同一批组合警告', () => {
    // 竞速器的前提是两端说同一件事:终端拦住的组合,从飞书批准的人也必须看到。
    const cfg = {
      goalPrompt: 'g', parallelism: 5, notices: [], mainModel: 'm',
      caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
      phaseRoles: { plan: [], review: [], execute: [], verify: [], accept: [], integrate: [], observer: [] },
      skipSteps: ['execute'],
    }
    const card = buildStartupCard(cfg as never, 'req-1') as { elements: { text?: { content: string } }[] }
    const text = card.elements.map(e => e.text?.content ?? '').join('\n')
    expect(text).toContain('跑不完')
    expect(text).toContain("跳过了执行但没跳验收:本次不会有任何代码改动,验收席位仍会照常开会,去核对一个空产出。判通过 = 给一个什么都没做的节点盖章并合进集成分支;判不通过 = 烧完验收迭代后阻断。要么一并跳过验收,要么别跳执行。")
  })
})

/**
 * **飞书卡必须知道第三档 —— 竞速器的前提是两端说同一件事。**
 *
 * 卡上的 `isolation` 参数是「池子建起来了没有」,不是「这一趟选了哪一档」。上一版把它
 * 直接喂给 `parallelismLine`,于是 shared-parallel 在卡上被印成「在各自的 git worktree
 * 中隔离、每个子任务完成时自动合并回当前分支」(有池子)或「执行与叶子验收串行」
 * (没池子)—— 两句对它都是假话,而 `--resume` 一个 shared-parallel 的 run 时必然触发。
 */
describe('启动卡 · 隔离方式', () => {
  const base = {
    goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  }
  const text = (isolation: 'worktree' | 'none' | undefined, iso?: string): string => {
    const card = buildStartupCard(
      { ...base, ...(iso ? { isolation: iso } : {}) } as never, 'req-1', undefined, isolation,
    ) as { elements: { text?: { content: string } }[] }
    return card.elements.map(e => e.text?.content ?? '').join('\n')
  }

  it('第三档:池子在也好不在也好,都不许印成隔离或串行', () => {
    for (const pool of ['worktree', 'none', undefined] as const) {
      const t = text(pool, 'shared-parallel')
      expect(t).toContain('执行任务**同时**在你当前的目录里跑')
      expect(t).not.toContain('自动合并回当前分支')
      expect(t).not.toContain('执行与叶子验收串行')
    }
  })

  it('第三档的代价也要上卡 —— 批准的人看不到就等于没说', () => {
    const t = text('none', 'shared-parallel')
    expect(t).toContain('后写的直接盖掉先写的')
    expect(t).toContain('本趟不产生任何提交')
  })

  /** 卡上按不了 `w`,印键位提示等于指一条这里不存在的路。 */
  it('卡上不印键位提示', () => {
    expect(text('none', 'shared-parallel')).not.toContain('(w 切换)')
  })

  it('默认那一档照旧:worktree + 有池子 → 说清自动合并', () => {
    const t = text('worktree')
    expect(t).toContain('自动合并回当前分支')
  })
})

/**
 * **卡上也要说「隔离用不了」—— 否则批准的人批的是一个不存在的跑法。**
 *
 * 实测过池子建不起来的那一趟:卡上同屏印着「隔离方式: worktree 隔离,可并行执行」
 * 「收口方式: 主干开发 —— 每个子任务完成时就把产出合回你当前的分支」「完成即回收: 开」,
 * 而上面那行并行数写的是「未启用隔离」。两个终端关口都传了原因,唯独卡没传。
 */
describe('启动卡 · 隔离不可用', () => {
  const base = {
    goalPrompt: '打通登录', parallelism: 5, notices: [], mainModel: 'm',
    caps: { maxDepth: 5, maxNodes: 100, maxIterations: 3, nodeTimeoutMs: 1 },
    phaseRoles: { plan: [], review: [], execute: [], accept: [], observer: [] },
  }
  const text = (cfg: object, isolation?: 'worktree' | 'none', reason?: string): string => {
    const card = buildStartupCard(cfg as never, 'req-1', undefined, isolation, reason) as { elements: { text?: { content: string } }[] }
    return card.elements.map(e => e.text?.content ?? '').join('\n')
  }

  it('池子没建起来 → 不许再印 worktree 隔离和自动合并', () => {
    const t = text(base, 'none', '当前目录不是 git 仓库')
    expect(t).toContain('不是你选的')
    expect(t).toContain('当前目录不是 git 仓库')
    expect(t).not.toContain('worktree 隔离,可并行执行')
    expect(t).not.toContain('每个子任务完成时就把产出合回你当前的分支')
  })

  /** `g` 和 `w` 在卡上都按不出来 —— 印键位提示等于指一条这里不存在的路。 */
  it('卡上不指终端才有的键', () => {
    const t = text(base, 'none', '当前目录不是 git 仓库')
    expect(t).not.toContain('按 g')
    expect(t).not.toContain('(w 切换)')
  })

  it('池子好好的时候一个字都不多说', () => {
    expect(text(base, 'worktree')).not.toContain('隔离不可用')
  })

  /**
   * 记录不是「你的请求没生效」。终端把它拆成「本次的执行方式」,卡上此前印在
   * 「以下请求不会生效」下面 —— 两端对同一件事说反话。
   */
  it('记录和没生效的请求在卡上也分两块', () => {
    const t = text({
      ...base,
      isolation: 'shared-parallel',
      notices: ['角色 xxx 未配置', '本次隔离方式: 共享目录 + 并发(关口显式选的)—— 多个执行任务同时改你当前的工作目录'],
    }, 'none')
    expect(t).toContain('**本次的执行方式**')
    expect(t).toContain('多个执行任务同时改你当前的工作目录')
    expect(t).toContain('**以下请求不会生效**')
    expect(t).toContain('角色 xxx 未配置')
    expect(t.indexOf('本次的执行方式')).toBeLessThan(t.indexOf('以下请求不会生效'))
  })
})
