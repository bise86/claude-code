/**
 * 「这台机器上没有 ripgrep」这条路,**真的跑一遍**。
 *
 * 为什么必须是子进程:`describeRipgrepFailure` 的单测只证明那句话写对了,证明不了它被
 * 接到 `ripGrep` 的致命错误分支上 —— 那个分支要真的 spawn 一次才走得到,而
 * `getRipgrepConfig` 是 memoize 过的进程级全局,同一个测试进程里改不动。
 * 变异验证过:把包装那行改回 `reject(error)`,纯函数那批用例一条都不红。
 *
 * 这条链是用户报过**两次**的:没有 rg → Grep/Glob 失败 → 子 agent 列不出文件 →
 * 猜文件名 → 一连串「File does not exist. Note: your current working directory is …」。
 */
import { describe, expect, it } from 'bun:test'

const PROBE = new URL('../../scripts/probes/noRipgrep.ts', import.meta.url).pathname
const REPO = new URL('../..', import.meta.url).pathname

/** 用给定的 PATH 跑一次探针,拿它那行 JSON。 */
function runProbe(path: string): { ok: boolean; message?: string; code?: string; hits?: number } {
  const bun = process.execPath
  const r = Bun.spawnSync([bun, 'run', PROBE], {
    cwd: REPO,
    // env -i 等价物:只留 PATH 和 HOME,把系统 rg 挡在外面。
    env: { PATH: path, HOME: process.env.HOME ?? '/tmp' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = new TextDecoder().decode(r.stdout).trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(out) as ReturnType<typeof runProbe>
  } catch {
    throw new Error(`探针没有输出 JSON。stdout=${out} stderr=${new TextDecoder().decode(r.stderr).slice(0, 400)}`)
  }
}

describe('机器上没有 ripgrep 时', () => {
  it('先自检:PATH 正常时搜索是能用的', () => {
    // 没有这条,下面那条即使因为**别的原因**失败也看不出来 —— 那正是「探针坏了被
    // 记成覆盖」的形状。
    const r = runProbe(process.env.PATH ?? '')
    expect(`搜索可用: ${r.ok}`).toBe('搜索可用: true')
    expect(r.hits ?? 0).toBeGreaterThan(0)
  })

  it('模型收到的是一句能照做的话,不是裸的 spawn ENOENT', () => {
    // 只留 bun 自己的目录,系统 rg 够不着。
    const r = runProbe(`${process.env.HOME}/.bun/bin`)
    expect(r.ok).toBe(false)
    // 裸错误是 `spawn rg ENOENT` —— 模型不知道这意味着「搜索整个不可用」,于是猜文件名。
    expect(r.message ?? '').toContain('装一个 ripgrep')
    expect(r.message ?? '').toContain('列不出文件')
    // 原始错误也要留着,排查的人需要它。
    expect(r.message ?? '').toContain('rg')
    expect(r.code).toBe('ENOENT')
  })
})
