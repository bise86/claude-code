// 全部跑**真 git** —— 这条路上每一种失手方式都会真的弄丢用户的工作,桩 git 证明不了
// 任何一条(圆桌评审就是靠真 git 打掉了方案里两条看起来很合理的机制)。
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { stashAvailability, sweepStashBackups, withStash, type StashGit } from './stashGuard.js'

const git: StashGit = (args, cwd) =>
  new Promise(resolve => {
    const p = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => { stdout += String(d) })
    p.stderr.on('data', d => { stderr += String(d) })
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    p.on('error', e => resolve({ code: -1, stdout: '', stderr: String(e) }))
  })

const roots: string[] = []
let repo = ''
const deps = () => ({ git, cwd: repo, runId: '001' })
const file = (n: string) => join(repo, n)
const read = (n: string) => readFile(file(n), 'utf-8')
const status = async () => (await git(['status', '--porcelain'], repo)).stdout.trim()
const stashCount = async () =>
  (await git(['stash', 'list'], repo)).stdout.split('\n').filter(l => l.trim().length > 0).length

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'efftask-stash-'))
  roots.push(base)
  repo = base
  await git(['init', '-q', '-b', 'main', '.'], repo)
  await git(['config', 'user.email', 's@s'], repo)
  await git(['config', 'user.name', 's'], repo)
  await writeFile(file('a.txt'), '基线\n')
  await writeFile(file('b.txt'), '别的\n')
  await git(['add', '-A'], repo)
  await git(['commit', '-qm', 'base'], repo)
})
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('前置:什么时候不许提供这一档', () => {
  it('干净仓库 → 可用', async () => {
    expect(await stashAvailability(deps())).toEqual({ available: true })
  })

  /**
   * **冲突态下 `stash push` 本身就失败**(could not write index / needs merge,退出码 1,
   * 一条都没建),而那时脏判据照样为真 —— 屏幕会把这一档递到用户面前,按下去必挂。
   */
  it('卡在一次没做完的合并里 → 不可用,而且说得出怎么脱身', async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '来自 main\n')
    await git(['commit', '-qam', 'main'], repo)
    const m = await git(['merge', 'other'], repo)
    expect(m.code).not.toBe(0)

    const a = await stashAvailability(deps())
    expect(a.available).toBe(false)
    expect(a.why ?? '').toContain('没做完的合并')
    expect(a.hint ?? '').toContain('--abort')
  })

  it('不可用时 withStash 一步都不做', async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '来自 main\n')
    await git(['commit', '-qam', 'main'], repo)
    await git(['merge', 'other'], repo)

    let ran = false
    const out = await withStash(deps(), async () => { ran = true })
    expect(ran).toBe(false)
    expect(out.restored).toBe(true)
    expect(await stashCount()).toBe(0)
  })
})

describe('正常一趟', () => {
  it('脏 → 收起来、做事、原样放回去', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    let sawClean = false
    const out = await withStash(deps(), async () => {
      sawClean = (await status()).length === 0
      return '做完了'
    })
    expect(sawClean).toBe(true)
    expect(out.result).toBe('做完了')
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    // 条目和备份 ref 都不该留下。
    expect(await stashCount()).toBe(0)
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup/001'], repo)).stdout.trim()).toBe('')
  })

  it('staged 的改动也一起来回', async () => {
    await writeFile(file('a.txt'), '暂存了的\n')
    await git(['add', 'a.txt'], repo)
    const out = await withStash(deps(), async () => 'ok')
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('暂存了的\n')
  })

  /**
   * **未跟踪文件不进 stash。** `/et` 自己就往用户检出里写 `.claude/efftask/`,加 `-u`
   * 会把它卷走;而 `utils/git.ts` 的 `stashToCleanState` 比 `-u` 还糟(先 add 再 stash)。
   */
  it('未跟踪文件原地不动', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    await writeFile(file('scratch.txt'), '随手留下的\n')
    let seenInside = ''
    await withStash(deps(), async () => { seenInside = await status() })
    // 事情做的时候它还在(说明没被 stash 走)。
    expect(seenInside).toContain('scratch.txt')
    expect(await read('scratch.txt')).toBe('随手留下的\n')
  })
})

describe('那些看起来很合理、而真 git 上不成立的', () => {
  /**
   * **判据必须是「多了一条」,不是「退出码为 0」。** 无事可做时 push 也返回 0,而
   * `refs/stash` 这时指向的是**用户自己那条 stash** —— 判据与按键之间隔着一屏确认,
   * 用户完全可能在这期间把改动提交或撤销了。
   */
  it('按下去时树已经干净了(用户中途自己提交了)→ 一条都不许碰,尤其不许弹他自己的 stash', async () => {
    await writeFile(file('b.txt'), '用户珍贵的东西\n')
    await git(['stash', 'push', '-qm', '用户自己的'], repo)
    expect(await stashCount()).toBe(1)
    const mine = (await git(['rev-parse', 'refs/stash'], repo)).stdout.trim()

    let ran = false
    const out = await withStash(deps(), async () => { ran = true })
    expect(ran).toBe(false)
    expect(out.lines.join('\n')).toContain('没有创建任何 stash')
    // 他那条原封不动。
    expect(await stashCount()).toBe(1)
    expect((await git(['rev-parse', 'refs/stash'], repo)).stdout.trim()).toBe(mine)
  })

  /**
   * **`stash@{n}` 必须在 pop 的那一刻算。** 中途有别的东西 stash 的话下标会漂移,
   * 而裸 `git stash pop` 会弹掉别人那条。
   */
  it('事情做到一半有人又 stash 了一条 → 我们仍然弹回自己那条', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    const out = await withStash(deps(), async () => {
      await writeFile(file('b.txt'), '半路冒出来的\n')
      await git(['stash', 'push', '-qm', '半路的'], repo)
    })
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    // 半路那条还在,没有被我们弹掉。
    expect((await git(['stash', 'list'], repo)).stdout).toContain('半路的')
  })

  /** 用户本来就有几条 stash —— 我们只动自己那条。 */
  it('已有别的 stash 时不误伤', async () => {
    await writeFile(file('b.txt'), '第一条\n')
    await git(['stash', 'push', '-qm', '用户 1'], repo)
    await writeFile(file('b.txt'), '第二条\n')
    await git(['stash', 'push', '-qm', '用户 2'], repo)
    await writeFile(file('a.txt'), '我正在改\n')

    const out = await withStash(deps(), async () => 'ok')
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    const list = (await git(['stash', 'list'], repo)).stdout
    expect(list).toContain('用户 1')
    expect(list).toContain('用户 2')
    expect(await stashCount()).toBe(2)
  })
})

describe('事情失败 / 现场没收拾干净', () => {
  /** 合并失败**也要**放回去 —— 否则改动停在一个他没主动创建的 stash 里。 */
  it('fn 失败 → 照样原样放回去', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    const out = await withStash(deps(), async () => ({ ok: false }))
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    expect(await stashCount()).toBe(0)
  })

  /** fn 抛异常也要先放回去,再把异常继续往外扔(不许吞)。 */
  it('fn 抛异常 → 先放回去,异常照抛', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    let caught = ''
    try {
      await withStash(deps(), async () => { throw new Error('炸了') })
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e)
    }
    expect(caught).toBe('炸了')
    expect(await read('a.txt')).toBe('我正在改\n')
    expect(await stashCount()).toBe(0)
  })

  /**
   * **半合并态下 pop 必然失败**,所以 pop 之前要无条件收拾现场。
   * 这一条造的正是那个形态:fn 自己留下一个没做完的合并。
   */
  it('fn 留下半合并态 → 先 abort 再 pop,改动照样回来', async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('b.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('b.txt'), '来自 main\n')
    await git(['commit', '-qam', 'main'], repo)
    await writeFile(file('a.txt'), '我正在改\n')

    const out = await withStash(deps(), async () => {
      await git(['merge', 'other'], repo) // 必然冲突,留下 MERGE_HEAD
    })
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo)).code).not.toBe(0)
  })

  /**
   * pop 撞冲突:改动**一个字节都没丢**,而且同时在两处;但工作区带着冲突标记,
   * 再 pop 一次会失败 —— 三句都要说全,而且给的命令要能照敲。
   */
  it('pop 撞冲突 → 不吞,两处都还在,而且说清再 pop 会失败', async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    // 我手上改的正是 a.txt,而 fn 会把 other 合进来(同样改 a.txt)。
    await writeFile(file('a.txt'), '我正在改\n')

    const out = await withStash(deps(), async () => {
      const r = await git(['merge', '--no-edit', 'other'], repo)
      expect(r.code).toBe(0) // 树是干净的(已 stash),所以这次合并会成功
    })
    expect(out.restored).toBe(false)
    const t = out.lines.join('\n')
    expect(t).toContain('一个字节都没丢')
    expect(t).toContain('再 pop 一次会失败')
    expect(t).toContain('git stash drop')
    expect(t).toContain('git stash apply refs/et/stash-backup/001/')
    // 两处都真的还在。
    expect(await stashCount()).toBe(1)
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup/001'], repo)).stdout.trim().length).toBeGreaterThan(0)
  })

  /**
   * **备份 ref 是最后一道**:条目被谁 drop 掉了也还能恢复。
   * 这一条把最坏情况造出来:fn 把我们那条 stash 直接 drop 了。
   */
  it('我们那条 stash 被别人 drop 了 → 从备份 ref 恢复', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    const out = await withStash(deps(), async () => {
      await git(['stash', 'drop', '-q', 'stash@{0}'], repo)
    })
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('我正在改\n')
    expect(out.lines.join('\n')).toContain('从备份恢复')
  })
})


/**
 * **验收席在真 git 上复现的 P0:第二次按键会静默删掉上一次留下的唯一一份备份。**
 *
 * 上一版 ref 名只有 runId,同一趟 run 里每次按键都是同一个名字,`update-ref` 覆盖时退出码
 * 0、一个字都不说。而这一档最典型的用法恰恰会连按两次:第一次 pop 撞冲突 → 屏幕告诉用户
 * 「解完冲突后 git stash drop,备份仍在」→ 他照做,此时**全世界只剩那一份备份** → 他继续
 * 改、再按一次 → 覆盖 + 成功路径上的 `update-ref -d` → 一整天的工作变成不可达对象,
 * 然后被 gc 掉。
 */
describe('备份 ref 不许被下一次按键覆盖', () => {
  const refs = async (): Promise<string[]> =>
    (await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup'], repo))
      .stdout.split('\n').map(l => l.trim()).filter(Boolean)

  it('第一次 pop 撞冲突留下备份,第二次按键不动它', async () => {
    // 第一趟:造一次 pop 冲突(fn 里合进一个改了同一文件的分支)。
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '一整天的工作\n')

    const first = await withStash(deps(), async () => {
      await git(['merge', '--no-edit', 'other'], repo)
    })
    expect(first.restored).toBe(false)
    const kept = await refs()
    expect(kept).toHaveLength(1)
    const keptSha = (await git(['rev-parse', kept[0] as string], repo)).stdout.trim()

    // 用户照屏幕说的做:解冲突、丢掉那条 stash。现在全世界只剩这个备份。
    await writeFile(file('a.txt'), '解完冲突\n')
    await git(['add', 'a.txt'], repo)
    await git(['stash', 'drop', '-q'], repo)
    expect((await git(['stash', 'list'], repo)).stdout.trim()).toBe('')

    // 他继续改,再按一次。
    await writeFile(file('b.txt'), '第二天的工作\n')
    const second = await withStash(deps(), async () => 'ok')
    expect(second.restored).toBe(true)

    // **第一份备份必须还在,而且内容没变。**
    const now = await refs()
    expect(now).toContain(kept[0] as string)
    expect((await git(['rev-parse', kept[0] as string], repo)).stdout.trim()).toBe(keptSha)
    expect((await git(['show', `${keptSha}:a.txt`], repo)).stdout).toContain('一整天的工作')
  })
})

/**
 * **失败和「没什么可 stash」是两件事。** 上一版把 `stash create` 的每一种失败都说成
 * 「你的工作区已经不脏了」,把 git 的真实原因吞掉 —— 而调用方随后会在**没有任何保护**的
 * 情况下把事情跑掉。
 */
describe('stash create 失败要如实说,并且标记 failed', () => {
  it('UU 态(刚被自己 pop 冲突留下的)→ 说 git 的原话,并标 failed', async () => {
    // 造一个没有 MERGE_HEAD 的 UU 态:stash pop 冲突之后就是这个形状。
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '我的\n')
    await withStash(deps(), async () => { await git(['merge', '--no-edit', 'other'], repo) })
    expect((await git(['status', '--porcelain'], repo)).stdout).toContain('UU')
    expect((await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo)).code).not.toBe(0)

    let ran = false
    const out = await withStash(deps(), async () => { ran = true })
    expect(ran).toBe(false)
    expect(out.failed).toBe(true)
    expect(out.lines.join('\n')).not.toContain('已经不脏了')
    expect(out.lines.join('\n')).toContain('git 拒绝了')
  })

  it('前置不可用(卡在一次没做完的合并里)也标 failed', async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '来自 main\n')
    await git(['commit', '-qam', 'main'], repo)
    await git(['merge', 'other'], repo)
    const out = await withStash(deps(), async () => 'x')
    expect(out.failed).toBe(true)
  })

  it('树本来就干净 → 不是失败(调用方该照常做事)', async () => {
    const out = await withStash(deps(), async () => 'x')
    expect(out.failed).toBeUndefined()
  })
})

/** 暂存 / 未暂存的划分要尽量保住 —— 用户可能是 `git add -p` 一块一块挑出来的。 */
describe('索引划分', () => {
  it('一个文件暂存、另一个没暂存 → 划分原样回来', async () => {
    await writeFile(file('a.txt'), '暂存的\n')
    await git(['add', 'a.txt'], repo)
    await writeFile(file('b.txt'), '没暂存的\n')
    const before = (await git(['status', '--porcelain'], repo)).stdout.trim()
    expect(before).toContain('M  a.txt')
    expect(before).toContain(' M b.txt')

    const out = await withStash(deps(), async () => 'x')
    expect(out.restored).toBe(true)
    expect((await git(['status', '--porcelain'], repo)).stdout.trim()).toBe(before)
  })

  /**
   * 同一个文件既暂存又有工作区改动 —— 实测 `pop --index` **也还原得了**,划分完整保住。
   * (方案里担心的「`--index` 在这种情况下会失败」在这一格上不成立;裸 pop 那条退路
   * 仍然留着,它在别的形态下才会被用到,而那时会明说划分被拍平。)
   */
  it('同一个文件既暂存又有工作区改动 → 内容和划分都完整', async () => {
    await writeFile(file('a.txt'), '第一版\n')
    await git(['add', 'a.txt'], repo)
    await writeFile(file('a.txt'), '第二版\n')
    const before = (await git(['status', '--porcelain'], repo)).stdout.trim()
    const out = await withStash(deps(), async () => 'x')
    expect(out.restored).toBe(true)
    expect(await read('a.txt')).toBe('第二版\n')
    expect((await git(['status', '--porcelain'], repo)).stdout.trim()).toBe(before)
  })
})

/**
 * **备份 ref 必须有人回收。** 用户原话:「没有用就及时清理,有用就在任务完成后清理掉」。
 *
 * 成功路径上 `withStash` 当场就删了;留下来的只有「pop 撞冲突」那一次 —— 而取完之后
 * 此前没人清,每一次失败的按键永久留下一个 ref + 一个 commit 对象,还把那批对象一直
 * 挡在 gc 之外。
 */
describe('备份 ref 的回收', () => {
  const refs = async (): Promise<string[]> =>
    (await git(['for-each-ref', '--format=%(refname)', 'refs/et/stash-backup'], repo))
      .stdout.split('\n').map(l => l.trim()).filter(Boolean)

  /** 造一次 pop 撞冲突:条目和备份 ref 都会留下。 */
  const conflicted = async () => {
    await git(['checkout', '-qb', 'other'], repo)
    await writeFile(file('a.txt'), '来自 other\n')
    await git(['commit', '-qam', 'other'], repo)
    await git(['checkout', '-q', 'main'], repo)
    await writeFile(file('a.txt'), '我的一天\n')
    const out = await withStash(deps(), async () => { await git(['merge', '--no-edit', 'other'], repo) })
    expect(out.restored).toBe(false)
    expect(await refs()).toHaveLength(1)
    return out
  }

  it('条目还在(他还没处理完)→ 留着,并说清为什么', async () => {
    await conflicted()
    const swept = await sweepStashBackups(deps())
    expect(swept.removed).toEqual([])
    expect(swept.kept).toHaveLength(1)
    expect(swept.kept[0]?.why ?? '').toContain('还没处理完')
    expect(await refs()).toHaveLength(1)
  })

  it('他解完冲突、drop 掉条目之后 → 这一份使命结束,回收掉', async () => {
    await conflicted()
    // 用户照屏幕说的做:解冲突、丢掉那条 stash。
    await writeFile(file('a.txt'), '解完了\n')
    await git(['add', 'a.txt'], repo)
    await git(['stash', 'drop', '-q'], repo)
    const swept = await sweepStashBackups(deps())
    expect(swept.removed).toHaveLength(1)
    expect(await refs()).toEqual([])
  })

  it('成功那一趟本来就不留 —— 回收时无事可做', async () => {
    await writeFile(file('a.txt'), '我正在改\n')
    await withStash(deps(), async () => 'ok')
    expect(await refs()).toEqual([])
    expect(await sweepStashBackups(deps())).toEqual({ removed: [], kept: [] })
  })

  /** 只管本 run 的:别的 run 可能还开着,替它做决定不是这里的事。 */
  it('别的 run 的备份一个都不碰', async () => {
    await conflicted()
    await git(['update-ref', 'refs/et/stash-backup/999/abcdef', 'HEAD'], repo)
    await writeFile(file('a.txt'), '解完了\n')
    await git(['add', 'a.txt'], repo)
    await git(['stash', 'drop', '-q'], repo)
    await sweepStashBackups(deps())
    expect(await refs()).toEqual(['refs/et/stash-backup/999/abcdef'])
  })
})

/**
 * **回收要有生产调用者。**
 *
 * 这个仓库的招牌缺陷是断线:声明了、实现了、探针也全绿,而生产里没人调它。上面那四条
 * 只证明 `sweepStashBackups` 自己是对的 —— 这一条钉的是「收口那一刻真的会调它」,
 * 以及留下来的那几条真的会被念出来(否则它就是一个没人知道的 ref,而那正是要修的毛病)。
 */
describe('回收接进了收口', () => {
  const SRC = readFileSync(new URL('../../commands/efftask/runOrchestrator.ts', import.meta.url), 'utf8')

  it('reclaim 里调了 sweepStashBackups', () => {
    expect(SRC).toContain("import { sweepStashBackups } from '../../tools/efftask/stashGuard.js'")
    expect(SRC).toContain('const swept = await sweepStashBackups({')
    // 只管本 run 的:别的 run 可能还开着。
    expect(SRC).toContain('runId: args.taskEntry.runId')
  })

  it('留下来的那几条并进 trunkSkips(结束屏 / 退出报告 / 收口关口读的都是它)', () => {
    expect(SRC).toContain('keptBackups.length > 0')
    expect(SRC).toContain("trunkSkips: [...(h0.trunkSkips ?? []), ...keptBackups]")
  })

  /** 回收失败不该把收口本身带倒 —— 它只是省空间。 */
  it('回收裹在 try 里', () => {
    const i = SRC.indexOf('sweepStashBackups({')
    expect(SRC.slice(Math.max(0, i - 200), i)).toContain('try {')
  })
})
