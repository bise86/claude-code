/**
 * **退出时,盘上的东西必须和屏幕上的一致。**
 *
 * 用户报:「退出时有些任务状态还在内存里没有及时存储到文件。」
 *
 * run.md 的写入是一条**串行 + 合并**的队列(见 runOrchestrator 的 queueManifest),而
 * `onUpdate` 那一路是 `void queueManifest(...)` —— 不等。所以「最后一次状态到底写没写出去」
 * 完全取决于收尾那几句有没有把队列**排干**。这一档就守这件事。
 */
import { describe, expect, it } from 'bun:test'
import { runOrchestrator, type Outcome } from './runOrchestrator.js'
import type { FsLike } from '../../tools/efftask/persistence.js'
import { DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig } from '../../tools/efftask/types.js'
import type { RunAgentFn } from '../../tools/efftask/roundtable.js'

function memFs(): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readFile: async p => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
    writeFile: async (p, d) => { files.set(p, d) },
    mkdir: async () => {},
    readdir: async () => [],
    exists: async p => files.has(p),
    mkdirExclusive: async () => true,
    unlink: async p => { files.delete(p) },
    rmdir: async () => {},
    appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d) },
    rename: async (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.set(to, v)
      files.delete(from)
    },
  }
}

const cfg = (): EffTaskConfig => ({
  goalPrompt: '打通登录', parallelism: 2, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
})

describe('收尾时 run.md 必须把最终状态写出去', () => {
  it('正常跑完:status / reason 都在盘上', async () => {
    const fs = memFs()
    const runAgent: RunAgentFn = async () => ''
    await runOrchestrator(
      { config: cfg(), runDir: '/run/001', fs, runAgent, signal: new AbortController().signal },
      () => {}, () => {}, () => {},
    )
    const md = fs.files.get('/run/001/run.md') ?? ''
    expect(md).toContain('status:')
  })

  /**
   * **异常路径**:`orch.run()` 抛出来的那一条。
   *
   * 收尾那句原来写的是 `if (args.config.pendingHandoff) await queueManifest(...)` ——
   * 没有待收口时**一次最终 manifest 都不写**。于是盘上留下的是最后一次普通更新的快照:
   * 没有 `status`、没有 `reason`。而 `--resume` 的关口和事后追责第一眼看的就是它:
   * 一个已经炸掉的 run 在盘上读起来像「还在跑」。
   */
  it('run() 抛了也要写 status —— 否则盘上那个 run 读起来像还在跑', async () => {
    const fs = memFs()
    const runAgent: RunAgentFn = async () => { throw new Error('上游 500') }
    const outcomes: Outcome[] = []
    await runOrchestrator(
      {
        config: cfg(), runDir: '/run/002', fs, runAgent,
        signal: new AbortController().signal,
        // 让 orch.run() 真的抛:onUpdate 里扔一个,它会穿过 safeUpdate 之外的那条路
        onEscalate: () => { throw new Error('渲染崩溃') },
      },
      () => {}, o => outcomes.push(o), () => {},
    )
    expect(outcomes).toHaveLength(1)
    const md = fs.files.get('/run/002/run.md') ?? ''
    // 状态必须在盘上,而且要和交给界面的那一份一致
    expect(md).toContain('status:')
    expect(md).toContain(outcomes[0].status)
  })

  it('中止:被扫成阻断的那批节点和最终状态都要落盘', async () => {
    const fs = memFs()
    const ac = new AbortController()
    const runAgent: RunAgentFn = async () => { ac.abort(); return '' }
    await runOrchestrator(
      { config: cfg(), runDir: '/run/003', fs, runAgent, signal: ac.signal },
      () => {}, () => {}, () => {},
    )
    const md = fs.files.get('/run/003/run.md') ?? ''
    expect(md).toContain('status:')
    // 根节点的 node.md 也要在 —— 屏幕上看到的那棵树必须能从盘上重建出来
    expect([...fs.files.keys()].some(k => k.endsWith('/root/node.md'))).toBe(true)
  })

  it('落盘队列被排干:收尾之后不再有待写的快照', async () => {
    /**
     * 判据是**写入次数不再增长**。合并队列只保留最新一份,所以「还有没有欠着的」
     * 唯一可观测的方式是:收尾返回之后再等几个宏任务,run.md 的内容不该再变。
     * 变了就说明收尾那一刻它还欠着一次写 —— 而进程此刻完全可能已经没了。
     */
    const fs = memFs()
    const runAgent: RunAgentFn = async () => ''
    await runOrchestrator(
      { config: cfg(), runDir: '/run/004', fs, runAgent, signal: new AbortController().signal },
      () => {}, () => {}, () => {},
    )
    const at = fs.files.get('/run/004/run.md')
    await new Promise(r => setTimeout(r, 50))
    expect(fs.files.get('/run/004/run.md')).toBe(at)
  })
})

/**
 * **运行中改过的设置必须立刻落盘。**
 *
 * `+/-` 并发、`<>` 严格度改的是 `RunControl`(纯内存),而它们进 run.md 的唯一通道是
 * `queueManifest` 里那两句同步 —— 而 `queueManifest` 只在 `onUpdate` 时被调用,也就是
 * **某个节点提交状态**的时候。一个执行环节可以跑几分钟不提交:这期间调过的设置,
 * 退出时就只在内存里,而 `--resume` 正是从 run.md 读回它们的。
 */
describe('运行中改过的设置要立刻进 run.md', () => {
  it('调并发之后 syncToDisk,盘上那个数当场就变', async () => {
    const { EffTaskOrchestrator } = await import('../../tools/efftask/orchestrator.js')
    const { createRunControl } = await import('../../tools/efftask/control.js')
    const { writeRunManifest } = await import('../../tools/efftask/persistence.js')
    const fs = memFs()
    const control = createRunControl()
    const config = cfg()
    // 逐字照搬 runOrchestrator 的同步语义(那两句就住在 queueManifest 里)
    const write = async (nodes: never): Promise<void> => {
      const live = control.parallelism()
      if (live !== undefined) config.parallelism = live
      await writeRunManifest(fs, '/run/005', config, nodes)
    }
    const orch = new EffTaskOrchestrator(
      config,
      {
        runAgent: async () => '', persist: async () => {}, now: () => new Date().toISOString(),
        control, onUpdate: n => { void write(n as never) },
      } as never,
      new AbortController().signal,
    )
    await write(orch.nodes() as never)
    expect(fs.files.get('/run/005/run.md')).toContain('parallelism: 2')

    // 用户按了两下 `+`,而**没有任何节点提交状态**
    control.setParallelism(4)
    orch.syncToDisk()
    await new Promise(r => setTimeout(r, 20))
    // 少了 syncToDisk 这一句,盘上还是 2 —— 而 --resume 会按 2 跑
    expect(fs.files.get('/run/005/run.md')).toContain('parallelism: 4')
  })
})
