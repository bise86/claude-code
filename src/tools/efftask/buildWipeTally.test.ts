import { describe, expect, it } from 'bun:test'
import { buildWipeLines, emptyBuildWipeTally, noteBuildWipe } from './buildWipeTally.js'
import type { BuildWipeOutcome } from './buildOutputs.js'

const out = (o: Partial<BuildWipeOutcome>): BuildWipeOutcome => ({
  removed: [], skippedRepos: [], excluded: [], freedKb: 0, sizeKnown: true, ...o,
})

describe('run 级构建产物账', () => {
  it('累加节点数、条目数与释放量', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, { title: 'A', outcome: out({ removed: ['target/'], freedKb: 1024 }) })
    noteBuildWipe(t, { title: 'B', outcome: out({ removed: ['target/', 'dist/'], freedKb: 2048 }) })
    expect(t.nodes).toBe(2)
    expect(t.entries).toBe(3)
    expect(t.freedKb).toBe(3072)
    expect(t.sizeKnown).toBe(true)
    expect(buildWipeLines(t)[0]).toContain('2 个任务')
    expect(buildWipeLines(t)[0]).toContain('3 项')
    expect(buildWipeLines(t)[0]).toContain('腾出 3.0 MB')
  })

  /**
   * **一个量不到就够了。** 反过来写(有一个量到了就算知道)会让屏幕上那个数字看起来是全量的,
   * 而它其实只是「我碰巧量到的那部分」。
   */
  it('一个条目量不到大小 → 总数只能说「至少」', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, { title: 'A', outcome: out({ removed: ['target/'], freedKb: 1024 }) })
    noteBuildWipe(t, { title: 'B', outcome: out({ removed: ['dist/'], freedKb: 0, sizeKnown: false }) })
    expect(t.sizeKnown).toBe(false)
    expect(buildWipeLines(t)[0]).toContain('至少腾出')
    expect(buildWipeLines(t)[0]).not.toContain(',腾出')
  })

  /** 清出来是空的不算一个节点 —— 否则「已清掉 20 个任务」里一大半什么都没发生。 */
  it('一条都没删掉的节点不计入', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, { title: 'A', outcome: out({ removed: [] }) })
    expect(t.nodes).toBe(0)
    expect(buildWipeLines(t)).toEqual([])
  })

  /**
   * **嵌套仓库那一条必须自己上屏,而且要指名道姓。**
   *
   * `git clean` 对它静默跳过而退出码仍是 0(真 git 实测,见 buildOutputs.test.ts)。
   * 不报的话屏幕会说「已回收 N GB」而那部分原地不动;不给路径的话用户没法去处置它。
   */
  it('被跳过的嵌套仓库单独成行,带节点标题和路径', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, {
      title: '翻译 sql 模块',
      outcome: out({ removed: ['target/'], freedKb: 8, skippedRepos: ['vendor/thirdparty'] }),
    })
    const lines = buildWipeLines(t)
    expect(lines.some(l => l.includes('翻译 sql 模块') && l.includes('vendor/thirdparty'))).toBe(true)
    expect(lines.some(l => l.startsWith('⚠'))).toBe(true)
  })

  it('同一个嵌套仓库只报一次', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, { title: 'A', outcome: out({ skippedRepos: ['vendor/x'] }) })
    noteBuildWipe(t, { title: 'B', outcome: out({ skippedRepos: ['vendor/x'] }) })
    expect(t.skippedRepos).toHaveLength(1)
  })

  /** 清理失败不影响节点的判决,但**必须说** —— 它是「你以为清了而其实没清」的第二个来源。 */
  it('失败要上屏,而且不吞掉同一次里已经删成功的那部分', () => {
    const t = emptyBuildWipeTally()
    noteBuildWipe(t, {
      title: 'A',
      outcome: out({ removed: ['target/'], freedKb: 4, error: 'git clean 退出码 128' }),
    })
    expect(t.failures).toEqual([{ title: 'A', why: 'git clean 退出码 128' }])
    expect(t.nodes).toBe(1)
    const lines = buildWipeLines(t)
    expect(lines.some(l => l.includes('git clean 退出码 128'))).toBe(true)
    expect(lines[0]).toContain('已清掉 1 个任务')
  })

  it('什么都没发生时一个字都不印', () => {
    expect(buildWipeLines(emptyBuildWipeTally())).toEqual([])
  })
})
