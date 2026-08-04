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
import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROBE = new URL('../../scripts/probes/noRipgrep.ts', import.meta.url).pathname
const REPO = new URL('../..', import.meta.url).pathname

/**
 * 一个**自带的** `rg` 桩子,以及一个空目录。
 *
 * 为什么不用这台机器上真的 rg:那样这两条用例的前提就变成「跑机装了 ripgrep」,而
 * `vendor/ripgrep` 不在 git 里、裸的 CI 跑机也没有 rg —— 于是「PATH 正常时搜索能用」那条
 * 在 CI 上必红,而它红的原因和被测代码毫无关系。给 CI 装 rg 只治得了这一个 workflow,
 * 治不了别人的 fork、也治不了 apt 抽风。桩子让这两条用例**在任何机器上结论都一样**。
 *
 * 桩子仿真的是 `mode: 'system'` 那一支:`resolveRipgrepConfig` 在找不到 vendor 目录时会
 * 走 `systemRg()`(即 `findExecutable('rg')`,查 PATH),拿到的命令就是裸的 `rg`。
 * 所以只要 PATH 上有一个可执行的 `rg`,链路就完整跑通;它输出几行文件名,`ripGrep` 就
 * 解析出几个 hit。这条链上真正被测的是**失败翻译**,不是 ripgrep 自己的搜索能力。
 */
const TMP = mkdtempSync(path.join(tmpdir(), 'rg-probe-'))
const WITH_RG = path.join(TMP, 'with-rg')
const WITHOUT_RG = path.join(TMP, 'without-rg')
mkdirSync(WITH_RG, { recursive: true })
mkdirSync(WITHOUT_RG, { recursive: true })
{
  const stub = path.join(WITH_RG, 'rg')
  // 输出两行「文件名」。真 rg 在 -l 模式下就是一行一个路径。
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' stub-hit-a.ts stub-hit-b.ts\n')
  chmodSync(stub, 0o755)
}
afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

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
  it('先自检:PATH 上有 rg 时搜索是能用的', () => {
    // 没有这条,下面那条即使因为**别的原因**失败也看不出来 —— 那正是「探针坏了被
    // 记成覆盖」的形状:机器上压根没有 rg 时,下面那条期望的失败会因为错误的原因发生。
    //
    // 用自带的桩子,不用这台机器上的 rg —— 见文件头。这条用例因此在任何机器上结论都一样,
    // 它证明的是「rg 找得到时这条链是通的」,而那正是下面那条用例需要的前提。
    const r = runProbe(WITH_RG)
    expect(`搜索可用: ${r.ok}(${r.message ?? '无错误'})`).toBe('搜索可用: true(无错误)')
    expect(r.hits ?? 0).toBeGreaterThan(0)
  })

  it('模型收到的是一句能照做的话,不是裸的 spawn ENOENT', () => {
    // 空目录:PATH 上没有任何东西,rg 够不着。
    const r = runProbe(WITHOUT_RG)
    expect(r.ok).toBe(false)
    // 裸错误是 `spawn rg ENOENT` —— 模型不知道这意味着「搜索整个不可用」,于是猜文件名。
    expect(r.message ?? '').toContain('装一个 ripgrep')
    expect(r.message ?? '').toContain('列不出文件')
    // 原始错误也要留着,排查的人需要它。
    expect(r.message ?? '').toContain('rg')
    expect(r.code).toBe('ENOENT')
  })
})
