import { describe, expect, it } from 'bun:test'
import { makeHandoffConflictResolver, makeRescueTriage, parseTriage } from './handoffResolve.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'
import type { RunAgentFn } from './roundtable.js'

const node = (): TaskNode => createNode({
  id: 'root', title: 'r', parentId: null, deps: [], depth: 0,
  phaseRoles: emptyPhaseRoles(), now: '2026-08-13T00:00:00.000Z',
})

/**
 * **分诊解析:任何看不懂的东西都当作没说。**
 *
 * 下游(`planRescue`)把「模型没提到的」一律算「拿不准」,所以「解析不出来 = 空数组」
 * 在方向上是安全的:不合只是暂时没捞到,合错了是把废稿盖到已经修好的代码上。
 */
describe('parseTriage', () => {
  const known = new Set(['refs/a', 'refs/b'])

  it('认出围栏里的 JSON 数组', () => {
    const out = parseTriage('随便说两句\n```json\n[{"ref":"refs/a","verdict":"merge","why":"独有产出"}]\n```', known)
    expect(out).toEqual([{ ref: 'refs/a', verdict: 'merge', why: '独有产出' }])
  })

  /**
   * **ref 必须是我们问过的那几条之一 —— 白名单不是黑名单。**
   *
   * 模型编出来的 ref 会被原样送去 `git merge`,而那是一次会往集成分支上产生真实提交的
   * 动作(`nodeRepair.REPAIRABLE_FIELDS` 同一条规矩:黑名单下新增的东西默认可信)。
   */
  it('不在问过的名单里的 ref 一律丢掉', () => {
    const out = parseTriage('```json\n[{"ref":"refs/evil","verdict":"merge","why":"我编的"},{"ref":"refs/a","verdict":"skip","why":"旧版"}]\n```', known)
    expect(out).toEqual([{ ref: 'refs/a', verdict: 'skip', why: '旧版' }])
  })

  it('verdict 不是三选一的丢掉', () => {
    expect(parseTriage('```json\n[{"ref":"refs/a","verdict":"yes","why":"x"}]\n```', known)).toEqual([])
  })

  it('解析不出来回空数组 —— 下游会把它当成「全部拿不准」', () => {
    expect(parseTriage('我觉得都可以合', known)).toEqual([])
    expect(parseTriage('```json\n{不是数组}\n```', known)).toEqual([])
    expect(parseTriage('```json\n{"ref":"refs/a"}\n```', known)).toEqual([])
  })

  it('多个围栏时取最后一个能解析出来的', () => {
    const raw = '```json\n[{"ref":"refs/a","verdict":"skip","why":"初稿"}]\n```\n再想想\n'
      + '```json\n[{"ref":"refs/a","verdict":"merge","why":"定稿"}]\n```'
    expect(parseTriage(raw, known)[0]!.why).toBe('定稿')
  })

  it('没给理由时补一句,而不是留空', () => {
    const out = parseTriage('```json\n[{"ref":"refs/a","verdict":"merge"}]\n```', known)
    expect(out[0]!.why.length).toBeGreaterThan(0)
  })
})

describe('makeRescueTriage', () => {
  const agent = (reply: string, seen?: { prompt: string; phase: string }[]): RunAgentFn =>
    (async (req: { prompt: string; phase: string }) => { seen?.push({ prompt: req.prompt, phase: req.phase }); return reply }) as RunAgentFn

  it('一条证据都没有时**不发调用**', async () => {
    let calls = 0
    const t = makeRescueTriage({
      runAgent: (async () => { calls++; return '' }) as RunAgentFn,
      node: node(), signal: new AbortController().signal,
    })
    expect(await t([])).toEqual([])
    expect(calls).toBe(0)
  })

  /**
   * **分诊是只读判断,不该拿写工具档。**
   *
   * 工具档由 `phase` 决定(见 makeRunAgentFn)。给它 `execute`,一个「顺手帮你合一下」的
   * 模型就能绕开 `autoResolveMerge` 那整套 git 复核。
   */
  it('走只读那一档,不走 execute', async () => {
    const seen: { prompt: string; phase: string }[] = []
    const t = makeRescueTriage({ runAgent: agent('```json\n[]\n```', seen), node: node(), signal: new AbortController().signal })
    await t([{ ref: 'refs/a', commits: 1, files: ['a.ts'], fileCount: 1, fate: 'still-open' }])
    expect(seen[0]!.phase).toBe('plan')
    expect(seen[0]!.phase).not.toBe('execute')
  })

  /** 证据要进提示词 —— 模型无据可依时只能猜,而这条路上猜错的代价是覆盖已修好的代码。 */
  it('提示词里带着提交数、文件名,以及「这个任务后来怎么样了」', async () => {
    const seen: { prompt: string; phase: string }[] = []
    const t = makeRescueTriage({ runAgent: agent('```json\n[]\n```', seen), node: node(), signal: new AbortController().signal })
    await t([{ ref: 'refs/a', commits: 3, files: ['src/api.ts'], fileCount: 1, title: '翻译 sql', fate: 'superseded' }])
    expect(seen[0]!.prompt).toContain('src/api.ts')
    expect(seen[0]!.prompt).toContain('3 个提交')
    expect(seen[0]!.prompt).toContain('翻译 sql')
    expect(seen[0]!.prompt).toContain('被重做过')
    // 「拿不准就写 unsure」必须明说 —— 少了它模型会倾向于给一个确定答案。
    expect(seen[0]!.prompt).toContain('unsure')
  })

  it('模型答坏了 → 空数组(下游当成全部拿不准)', async () => {
    const t = makeRescueTriage({ runAgent: agent('我合不了'), node: node(), signal: new AbortController().signal })
    expect(await t([{ ref: 'refs/a', commits: 1, files: [], fileCount: 0 }])).toEqual([])
  })
})

/**
 * **解冲突的提示词里,`note` 要排在「保留双方意图」之前。**
 *
 * 后一句是通则,`note` 是这一次的例外(「这一半是被取代的废稿」)。顺序反了,通则会盖住
 * 例外 —— 这个仓库为「同一命题的 P 和 ¬P 同在而 ¬P 在后」付过一次账(严格度那一轮)。
 */
describe('makeHandoffConflictResolver', () => {
  const capture = (): { seen: string[]; agent: RunAgentFn } => {
    const seen: string[] = []
    return { seen, agent: (async (req: { prompt: string }) => { seen.push(req.prompt); return '' }) as RunAgentFn }
  }

  it('note 进提示词,而且排在「保留双方的意图」前面', async () => {
    const { seen, agent } = capture()
    const r = makeHandoffConflictResolver({ runAgent: agent, node: node(), signal: new AbortController().signal })
    await r({ files: ['a.ts'], branch: 'efftask/001/integration', cwd: '/tmp/x', note: '这一版已经被后来的版本取代' })
    const p = seen[0]!
    expect(p).toContain('这一版已经被后来的版本取代')
    expect(p.indexOf('已经被后来的版本取代')).toBeLessThan(p.indexOf('保留双方的意图'))
  })

  it('没有 note 时提示词照旧能用', async () => {
    const { seen, agent } = capture()
    const r = makeHandoffConflictResolver({ runAgent: agent, node: node(), signal: new AbortController().signal })
    await r({ files: ['a.ts'], branch: 'b', cwd: '/tmp/x' })
    expect(seen[0]).toContain('保留双方的意图')
  })

  /**
   * **不许说「这里是用户自己的工作目录」。**
   *
   * 这个解决者现在有两个落脚点:收口那条路跑在用户的检出里,而捞回/合回主干那两条跑在
   * 临时合并工作树里(模型调用一秒都不能待在 mergeLock 里)。写死其中一种,另一种上就是
   * 一句精确的假话 —— 而它正好是最容易让模型「顺手清理一下」的那一句。
   */
  it('不宣称当前目录是用户的检出', async () => {
    const { seen, agent } = capture()
    const r = makeHandoffConflictResolver({ runAgent: agent, node: node(), signal: new AbortController().signal })
    await r({ files: ['a.ts'], branch: 'b', cwd: '/tmp/x' })
    expect(seen[0]).not.toContain('用户自己的工作目录')
  })
})
