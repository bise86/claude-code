/**
 * 事件流落盘 —— 用户报的那一句的对面。
 *
 * 详情页原来对着一个恢复回来的节点写着「事件流只在内存里、不落盘,看不到历史」。
 * 这个文件从三个层次钉它:写下去 → 读回来 → **真的接在 StreamStore 上**。
 * 最后一层是唯一能证明功能存在的那一层:前两层全绿而 store 没接线,是这个仓库反复付过
 * 学费的「配得进去、永远到不了」。
 */
import { describe, expect, it } from 'bun:test'
import {
  AGENT_LOG_NAME, agentLogPath, createAgentLogWriter, parseAgentLog, readAgentLog,
} from './agentLog.js'
import { createStreamStore, MAX_EVENTS_PER_STREAM } from './agentStream.js'
import type { FsLike } from './persistence.js'

function memFs(): FsLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async readFile(p) { const v = store.get(p); if (v === undefined) throw new Error('ENOENT ' + p); return v },
    async writeFile(p, d) { store.set(p, d) },
    async appendFile(p, d) { store.set(p, (store.get(p) ?? '') + d) },
    async mkdir() {},
    async mkdirExclusive() { return true },
    async unlink(p) { store.delete(p) },
    async rmdir() {},
    async rename(a, b) { const v = store.get(a)!; store.set(b, v); store.delete(a) },
    async readdir() { return [] },
    async exists(p) { return store.has(p) },
  }
}

const meta = (nodeId: string, label = '研发') => ({ nodeId, phaseLabel: '执行', label })

describe('写下去', () => {
  it('落在节点自己的目录里,文件名固定', () => {
    expect(agentLogPath('/eff/001', 'root/01-a')).toBe(`/eff/001/root/01-a/${AGENT_LOG_NAME}`)
  })

  it('record 是同步攒着的,flush 才真写盘 —— 热路径上不能每条一次 syscall', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    w.record('root', { t: 'open', s: 0, at: 1, meta: meta('root') })
    w.record('root', { t: 'ev', s: 0, e: { kind: 'text', text: '你好' } as never })
    expect(fs.store.size).toBe(0) // 还没 flush,一个字节都没写
    await w.flush()
    const text = fs.store.get(agentLogPath('/eff/001', 'root'))!
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('追加,不是覆盖 —— 第二次 flush 不能把第一次写的顶掉', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    w.record('root', { t: 'open', s: 0, at: 1, meta: meta('root') })
    await w.flush()
    w.record('root', { t: 'ev', s: 0, e: { kind: 'text', text: 'x' } as never })
    await w.flush()
    const parsed = parseAgentLog(fs.store.get(agentLogPath('/eff/001', 'root'))!)
    expect(parsed.streams).toHaveLength(1)
    expect(parsed.streams[0].events).toHaveLength(1)
  })

  it('写盘失败不抛,失败报上来 —— 这份日志不该让运行停下', async () => {
    const fs = memFs()
    const hostile: FsLike = { ...fs, async appendFile() { throw new Error('ENOSPC') } }
    const w = createAgentLogWriter({ fs: hostile, runDir: '/eff/001' })
    w.record('root', { t: 'open', s: 0, at: 1, meta: meta('root') })
    const r = await w.flush()
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].message).toContain('ENOSPC')
  })

  it('触到单节点上限就停笔,并在盘上留下一行说明', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001', maxBytesPerNode: 300 })
    w.record('root', { t: 'open', s: 0, at: 1, meta: meta('root') })
    for (let i = 0; i < 50; i++) w.record('root', { t: 'ev', s: 0, e: { kind: 'text', text: `第 ${i} 行` } as never })
    await w.flush()
    const parsed = parseAgentLog(fs.store.get(agentLogPath('/eff/001', 'root'))!)
    // 被截断的历史**必须自报家门**,否则它和一份完整的历史长得一模一样。
    expect(parsed.capped).toBe(true)
    expect(parsed.streams[0].events.length).toBeLessThan(50)
  })
})

describe('读回来', () => {
  it('一条流的表头、事件、收口时刻都回得来', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    w.record('root', { t: 'open', s: 7, at: 1000, meta: meta('root', '架构') })
    w.record('root', { t: 'ev', s: 7, e: { kind: 'tool', brief: 'Read a.ts', useId: 'u1' } as never })
    w.record('root', { t: 'end', s: 7, at: 5000 })
    await w.flush()
    const r = (await readAgentLog(fs, '/eff/001', 'root'))!
    expect(r.streams).toHaveLength(1)
    const s = r.streams[0]
    expect(s.meta.label).toBe('架构')
    expect(s.startedAt).toBe(1000)
    expect(s.endedAt).toBe(5000)
    expect(s.toolCount).toBe(1)
    // 读回来的一律是**收口态**:否则界面会把一次早就结束的调用画成「正在运行」,
    // 计时器还会从上次的 startedAt 一路往上跳。
    expect(s.closed).toBe(true)
  })

  it('坏行跳过,不放弃整份 —— 追加写被打断最坏就是最后一行不完整', () => {
    const good = JSON.stringify({ t: 'open', s: 0, at: 1, meta: meta('root') })
    const ev = JSON.stringify({ t: 'ev', s: 0, e: { kind: 'text', text: 'ok' } })
    const r = parseAgentLog(`${good}\n${ev}\n{"t":"ev","s":0,"e":{"kind`)
    expect(r.streams).toHaveLength(1)
    expect(r.streams[0].events).toHaveLength(1)
    expect(r.badLines).toBe(1)
  })

  it('没有这份文件 = 没有历史,不是读坏了', async () => {
    expect(await readAgentLog(memFs(), '/eff/001', 'root')).toBeUndefined()
  })
})

describe('真的接在 StreamStore 上', () => {
  it('store 把 open / 事件 / 收口三样都送进 sink', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    const store = createStreamStore({
      sink: {
        opened: (n, s, m, at) => w.record(n, { t: 'open', s, at, meta: m }),
        event: (n, s, e) => w.record(n, { t: 'ev', s, e }),
        closed: (n, s, at, err) => w.record(n, { t: 'end', s, at, ...(err === undefined ? {} : { err }) }),
      },
    })
    const h = store.open(meta('root/01-a'))
    h.push({ kind: 'text', text: '干活' } as never)
    h.end()
    await w.flush()
    const r = (await readAgentLog(fs, '/eff/001', 'root/01-a'))!
    expect(r.streams).toHaveLength(1)
    expect(r.streams[0].events).toHaveLength(1)
    expect(r.streams[0].endedAt).toBeGreaterThan(0)
  })

  it('**被环形缓冲挤掉的事件照样在盘上** —— 这才是落盘的意义', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    const store = createStreamStore({
      sink: {
        opened: (n, s, m, at) => w.record(n, { t: 'open', s, at, meta: m }),
        event: (n, s, e) => w.record(n, { t: 'ev', s, e }),
        closed: (n, s, at, err) => w.record(n, { t: 'end', s, at, ...(err === undefined ? {} : { err }) }),
      },
    })
    const h = store.open(meta('root'))
    const total = MAX_EVENTS_PER_STREAM + 30
    for (let i = 0; i < total; i++) h.push({ kind: 'text', text: `行 ${i}` } as never)
    h.end()
    await w.flush()
    // 内存里被上限压住了……
    expect(store.streams('root')[0].events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_STREAM)
    // ……而盘上一条不少。落盘挪到淘汰之后的话,这一条会当场变红。
    const r = (await readAgentLog(fs, '/eff/001', 'root'))!
    expect(r.streams[0].events).toHaveLength(total)
  })

  it('hydrate 把历史读回内存,而且**只读一次**', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    w.record('root/01-a', { t: 'open', s: 3, at: 1, meta: meta('root/01-a') })
    w.record('root/01-a', { t: 'ev', s: 3, e: { kind: 'text', text: '上一次跑的' } as never })
    w.record('root/01-a', { t: 'end', s: 3, at: 9 })
    await w.flush()

    let reads = 0
    const store = createStreamStore({
      load: async id => { reads++; return (await readAgentLog(fs, '/eff/001', id))?.streams },
    })
    store.markHistorical(['root/01-a'])
    expect(store.streams('root/01-a')).toHaveLength(0)
    expect(await store.hydrate('root/01-a')).toBe(1)
    expect(store.streams('root/01-a')[0].events).toHaveLength(1)
    // 读回来之后就不该再显示「上一次运行的输出看不到」——它现在看得到了。
    expect(store.isHistorical('root/01-a')).toBe(false)
    // 详情页的打开会连着触发两次;读第二遍会让同一条调用显示两遍。
    expect(await store.hydrate('root/01-a')).toBe(0)
    expect(reads).toBe(1)
    expect(store.streams('root/01-a')).toHaveLength(1)
  })

  it('节点已经重新跑起来时,hydrate 不把上一次的混进去', async () => {
    const fs = memFs()
    const w = createAgentLogWriter({ fs, runDir: '/eff/001' })
    w.record('root', { t: 'open', s: 1, at: 1, meta: meta('root') })
    await w.flush()
    const store = createStreamStore({ load: async id => (await readAgentLog(fs, '/eff/001', id))?.streams })
    store.open(meta('root')) // 正在跑
    expect(await store.hydrate('root')).toBe(0)
    expect(store.streams('root')).toHaveLength(1)
  })

  it('不给 sink 时一个字节都不写 —— 老行为逐字不变', async () => {
    const fs = memFs()
    const store = createStreamStore()
    const h = store.open(meta('root'))
    h.push({ kind: 'text', text: 'x' } as never)
    h.end()
    expect(fs.store.size).toBe(0)
    expect(await store.hydrate('root')).toBe(0)
  })
})

/**
 * `StreamLoader` 是个**注入进来的接缝**,不是只有 agentLog 一种实现。
 *
 * 上面那几条用例全走 `readAgentLog`,而它自己已经把流标成收口态了 —— 于是 hydrate 里
 * 那句 `closed: true` 怎么删都不会变红。变异测试抓到的正是这个:探针从没走过这条线。
 * 这里直接喂一个「还开着」的加载器,把那句防线钉住。
 */
describe('hydrate 对加载器的产物也要负责', () => {
  it('加载器给回一条没收口的流,hydrate 也必须把它按历史处理', async () => {
    const store = createStreamStore({
      load: async () => [{
        meta: meta('root'), events: [], dropped: 0, toolCount: 0,
        startedAt: 1, closed: false, seq: 0,
      }],
    })
    expect(await store.hydrate('root')).toBe(1)
    // 不标记的话,界面把一次早就结束的调用画成「正在运行」,计时器从上次的
    // startedAt 一路往上跳 —— 这个仓库为「渲染层拿字段缺席当状态」付过三次学费。
    expect(store.streams('root')[0].closed).toBe(true)
  })
})
