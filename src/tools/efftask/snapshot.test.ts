/**
 * 「抹掉之前先钉一个 ref」—— **只对着真 git 测**。
 *
 * 这条路的全部价值在于三件事只有真 git 答得对:`stash create` 到底动没动那棵树、
 * `-u` 到底管不管用、冲突态下它到底成不成。假 GitRunner 对这三样全部点头 ——
 * 而其中两样的正确答案是「不管用」和「不成」。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pinSnapshot, snapshotLines, type SnapshotDeps } from './snapshot.js'

const git = (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
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
let root = ''
const deps = (): SnapshotDeps => ({ git, gitRoot: root, runId: '001' })

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-snap-'))
  roots.push(base)
  root = join(base, 'repo')
  await mkdir(root, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], root)
  await git(['config', 'user.email', 's@s'], root)
  await git(['config', 'user.name', 's'], root)
  await writeFile(join(root, 'a.txt'), 'base\n')
  await git(['add', '-A'], root)
  await git(['commit', '-qm', 'base'], root)
}

const status = async (): Promise<string> => (await git(['status', '--porcelain'], root)).stdout
const index = async (): Promise<string> => (await git(['ls-files', '-s'], root)).stdout

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('钉一个耐久快照', () => {
  it('干净的树:没什么可钉,而且不算失败', async () => {
    const res = await pinSnapshot(deps(), root)
    expect(res.ok).toBe(true)
    expect(res.ref).toBeUndefined()
  })

  /** 它会被放在**别人正在用的树**上,所以「不动那棵树」是它能存在的全部前提。 */
  it('一个字节都不改那棵工作树,也不动 index', async () => {
    await writeFile(join(root, 'a.txt'), 'base\ndirty\n')
    await writeFile(join(root, 'staged.txt'), 'S\n')
    await git(['add', 'staged.txt'], root)
    await writeFile(join(root, 'untracked.txt'), 'U\n')
    const before = { st: await status(), idx: await index() }
    const res = await pinSnapshot(deps(), root)
    expect(res.ok).toBe(true)
    expect(await status()).toBe(before.st)
    expect(await index()).toBe(before.idx)
  })

  it('钉住之后,reset --hard + clean -fd 拿不走它', async () => {
    await writeFile(join(root, 'a.txt'), 'base\n一小时的活\n')
    const res = await pinSnapshot(deps(), root)
    expect(res.ref).toBeDefined()
    await git(['reset', '--hard'], root)
    await git(['clean', '-fd'], root)
    // 树上没了 —— 而 ref 上还在。
    expect((await git(['show', 'HEAD:a.txt'], root)).stdout).toBe('base\n')
    expect((await git(['show', `${res.ref}:a.txt`], root)).stdout).toBe('base\n一小时的活\n')
    // gc 也拿不走(这是「耐久」两个字的意思)。
    expect((await git(['gc', '--prune=now', '-q'], root)).code).toBe(0)
    expect((await git(['show', `${res.ref}:a.txt`], root)).stdout).toBe('base\n一小时的活\n')
  })

  /**
   * **按 tree 命名,不按 commit。**
   *
   * 同一份内容连着 `stash create` 两次,commit sha 不同(带 committer 时间戳)而 tree 相同。
   * 按 commit 命名的话,用户按十次 `m` 就留下十条指着同一棵树的 ref,而没有任何东西回收
   * 它们 —— 那是无限增长,和这个仓库修过的「同名 ref 互相覆盖」正好是一对反面。
   */
  it('反复钉同样的内容不会长出第二条 ref', async () => {
    await writeFile(join(root, 'a.txt'), 'base\ndirty\n')
    const one = await pinSnapshot(deps(), root)
    const two = await pinSnapshot(deps(), root)
    expect(two.ref).toBe(one.ref!)
    /**
     * **命名口径要直接钉。**
     *
     * 只断言「两次同名」是不够的:同一秒内两次 `stash create` 的 committer 时间戳相同,
     * commit sha 也就相同 —— 于是按 commit 命名的实现在这条用例里照样是绿的
     * (变异测试当场证明了这一点)。所以直接问:名字末尾是不是那棵 **tree** 的前 12 位。
     */
    const tree = (await git(['rev-parse', `${one.ref!}^{tree}`], root)).stdout.trim()
    expect(one.ref!.endsWith(tree.slice(0, 12))).toBe(true)
    const listed = (await git(['for-each-ref', '--format=%(refname)', 'refs/et/rescued'], root)).stdout
    expect(listed.trim().split('\n').filter(Boolean)).toHaveLength(1)
  })

  /**
   * **未跟踪文件钉不住 —— 而且要点名说出来。**
   *
   * 实测:`git stash create -u` / `--include-untracked` 退出码 0、sha 也给,但只有 2 个
   * parent、没有 `^3`,未跟踪文件一个都没进去。**静默无效**是这条路唯一的漏洞,
   * 含糊成一句「已备份」就是把它藏起来。
   */
  it('未跟踪的文件没能钉住,要点名', async () => {
    await writeFile(join(root, 'a.txt'), 'base\ndirty\n')
    await writeFile(join(root, 'notes.md'), '一小时的笔记\n')
    const res = await pinSnapshot(deps(), root)
    expect(res.ok).toBe(true)
    expect(res.untracked).toEqual(['notes.md'])
    expect((await git(['show', `${res.ref}:notes.md`], root)).code).not.toBe(0)
    const text = snapshotLines('集成工作区', res).join('\n')
    expect(text).toContain('未跟踪')
    expect(text).toContain('notes.md')
    expect(text).toContain('clean -fd')
  })

  /**
   * **被 `.gitignore` 忽略的不算「会被删掉」。**
   *
   * `clean -fd` 不带 `-x`,它本来就不碰忽略的东西。把构建产物点名成「会没」是假警报,
   * 而假警报读多了会把真的那几行盖掉。
   */
  it('被忽略的构建产物不进「没能钉住」的名单', async () => {
    await writeFile(join(root, '.gitignore'), 'dist/\n')
    await git(['add', '-A'], root)
    await git(['commit', '-qm', 'ignore'], root)
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'out.js'), 'built\n')
    await writeFile(join(root, 'a.txt'), 'base\ndirty\n')
    const res = await pinSnapshot(deps(), root)
    expect(res.untracked).toBeUndefined()
  })

  /**
   * **空 sha ≠ 「没什么可钉」。**
   *
   * 验收席在真 git 上复现:别的流程在 `status` 和 `stash create` 之间把那棵共享的树收拾了
   * → `stash create` 什么都不给 → 上一版返回 `ok: true`、`snapshotLines` **一行都不输出**。
   * 用户一整天的未提交内容没了,屏幕上一个字都没有。
   */
  it('看见了改动却一处都没钉住:报失败,而且屏幕上必须有话', async () => {
    await writeFile(join(root, 'a.txt'), 'base\n一整天的活\n')
    const meddling: SnapshotDeps['git'] = async (args, cwd) => {
      if (args[0] === 'stash' && args[1] === 'create') {
        // 另一条流在这两句之间收拾了这棵共享的树。
        await git(['reset', '--hard'], root)
        return git(args, cwd)
      }
      return git(args, cwd)
    }
    const res = await pinSnapshot({ ...deps(), git: meddling }, root)
    expect(res.ok).toBe(false)
    expect(res.ref).toBeUndefined()
    expect(snapshotLines('集成工作区', res).join('\n')).toContain('没能钉住')
  })

  /**
   * **只创建,不覆盖。** ref 名只编码 tree、不编码基准:两棵不同基准的树上有同一份内容时,
   * 上一版第二次 `update-ref` 会把第一条直接抹掉,那份快照落到零个 ref 上等 gc。
   */
  it('同名而内容基准不同时,不许把上一条抹掉', async () => {
    await writeFile(join(root, 'a.txt'), 'base\nX\n')
    const one = await pinSnapshot(deps(), root)
    expect(one.ref).toBeDefined()
    const treeSha = (await git(['rev-parse', `${one.ref!}^{tree}`], root)).stdout.trim()
    // 手工造一个「同 tree、不同 commit」的对象,占住同一个名字会用的位置。
    const other = (await git(['commit-tree', treeSha, '-m', 'another base'], root)).stdout.trim()
    const forced = await pinSnapshot({
      ...deps(),
      git: async (args, cwd) => args[0] === 'stash' && args[1] === 'create'
        ? { code: 0, stdout: `${other}\n`, stderr: '' }
        : git(args, cwd),
    }, root)
    expect(forced.ref).not.toBe(one.ref!)
    // 第一条还在 —— 这才是「耐久」。
    expect((await git(['rev-parse', '--verify', '-q', one.ref!], root)).code).toBe(0)
  })

  /**
   * **最该保护的那一格恰好是钉不住的那一格 —— 所以更要如实说。**
   *
   * 冲突态下 `stash create` 直接失败(`Cannot save the current index state`)。
   * 吞掉它的后果是:屏幕一片安静,而随后的 `reset --hard` + `clean -fd` 把手工解出来的
   * 内容和旁边的笔记一起带走。
   */
  it('留着没解完的合并时:如实报失败,并给出下一步', async () => {
    await git(['checkout', '-qb', 'side'], root)
    await writeFile(join(root, 'a.txt'), 'side\n')
    await git(['commit', '-qam', 'side'], root)
    await git(['checkout', '-q', 'main'], root)
    await writeFile(join(root, 'a.txt'), 'main\n')
    await git(['commit', '-qam', 'main'], root)
    await git(['merge', 'side'], root)
    expect((await status()).trim()).toContain('UU')

    const res = await pinSnapshot(deps(), root)
    expect(res.ok).toBe(false)
    expect(res.why ?? '').toContain('钉不住')
    const text = snapshotLines('集成工作区', res).join('\n')
    expect(text).toContain('没能钉住')
    // 唯一能让它重新可钉的那一步要写出来,不能只报一句错。
    expect(text).toContain('merge --abort')
  })
})
