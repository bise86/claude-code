/**
 * 加法补录 —— **只对着真 git 测**。
 *
 * 这个文件里每一条 `it` 都对应圆桌数据安全席在玩具仓库上跑出来的一次复现。方案第一版把
 * 「只取集成分支没有的路径 ⇒ 覆盖不了任何东西」当成自明之理,而那句话在真 git 上是假的:
 * 空 pathspec 会切分支、`[id].tsx` 是通配符、`foo/bar.txt` 会删掉叫 `foo` 的文件。
 * 假 GitRunner 对这些**全部点头** —— 它只会答「命令发出去了」。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { backfillFromDir, backfillFromRef, candidatePaths, type BackfillDeps } from './backfill.js'

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
let gitRoot = ''
let worktreeRoot = ''
let intPath = ''
const INT = 'efftask/int'

async function freshRepo(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-backfill-'))
  roots.push(base)
  gitRoot = join(base, 'repo')
  worktreeRoot = join(base, 'wt')
  intPath = join(worktreeRoot, 'integration')
  await mkdir(gitRoot, { recursive: true })
  await mkdir(worktreeRoot, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], gitRoot)
  await git(['config', 'user.email', 's@s'], gitRoot)
  await git(['config', 'user.name', 's'], gitRoot)
  await writeFile(join(gitRoot, 'base.txt'), 'base\n')
  await git(['add', '-A'], gitRoot)
  await git(['commit', '-qm', 'base'], gitRoot)
  await git(['branch', INT], gitRoot)
  await git(['worktree', 'add', '-q', intPath, INT], gitRoot)
}

const deps = (): BackfillDeps => ({
  git, gitRoot, integrationBranch: INT, integrationPath: intPath, worktreeRoot,
  withIntegrationLock: fn => fn(),
})

/**
 * 往**集成分支**上提交 —— 必须在它自己的工作树里做。
 *
 * 夹具第一版在 gitRoot 里 `git checkout <集成分支>` / `git branch -f`,而那条分支正被
 * `intPath` 这棵工作树占着,git 当场拒绝 —— 于是五条用例的「集成分支上已经有 X」
 * 这个前提**根本没成立**,它们测的是另一个形状。
 */
async function commitOnInt(files: Record<string, string>, removes: string[] = []): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(intPath, rel)), { recursive: true })
    await writeFile(join(intPath, rel), body)
  }
  for (const rel of removes) await git(['rm', '-q', '-r', '--', rel], intPath)
  await git(['add', '-A'], intPath)
  await git(['commit', '-qm', 'int'], intPath)
}

/** 在一条分支上写几个文件并提交,回到原来的分支。 */
async function onBranch(name: string, files: Record<string, string>, from = INT): Promise<void> {
  const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot)).stdout.trim()
  await git(['checkout', '-q', '-b', name, from], gitRoot)
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(gitRoot, rel)), { recursive: true })
    await writeFile(join(gitRoot, rel), body)
  }
  await git(['add', '-A'], gitRoot)
  await git(['commit', '-qm', `work ${name}`], gitRoot)
  await git(['checkout', '-q', cur], gitRoot)
}

const intFile = async (rel: string): Promise<string | null> => {
  const r = await git(['show', `${INT}:${rel}`], gitRoot)
  return r.code === 0 ? r.stdout : null
}

beforeEach(freshRepo)
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

describe('加法补录:真的把集成分支缺的文件捞回来', () => {
  it('ref 上独有的文件被补录,而且是单独一笔提交(不是合并)', async () => {
    await onBranch('lost', { 'src/new.ts': 'NEW\n' })
    const before = (await git(['rev-parse', INT], gitRoot)).stdout.trim()
    const res = await backfillFromRef(deps(), 'lost', '来历')
    expect(res.ok).toBe(true)
    expect(res.added).toEqual(['src/new.ts'])
    expect(await intFile('src/new.ts')).toBe('NEW\n')
    /**
     * **不是合并** —— 那条 ref 只被取了一部分,历史上必须仍然看得出它没合完。
     * 判据用 git 自己的祖先关系,不看提交消息。
     */
    const merged = await git(['merge-base', '--is-ancestor', 'lost', INT], gitRoot)
    expect(merged.code).not.toBe(0)
    expect((await git(['rev-list', '--count', `${before}..${INT}`], gitRoot)).stdout.trim()).toBe('1')
  })

  /**
   * **这是这个文件里最危险的一格。**
   *
   * 一条只改已有文件、不新增任何文件的 ref(被验收否决的废稿最典型的形状)候选集合为空。
   * `git checkout <ref> --` 在 pathspec 为空时**不是空操作,是切分支** —— 实测后果:
   * 整条废稿被 ff 进集成分支,而且下一趟 `stageAt` 的 `reset --hard` 把那条抢救分支
   * 挪到了集成分支 tip,那一版产出唯一的落脚点变成悬垂对象。
   */
  it('候选为空时:一个字节都不动,分支不许被切、不许被挪', async () => {
    await commitOnInt({ 'fixed.ts': 'GOOD\n' })
    // 废稿:同一个文件的旧版本,没有任何新增文件。
    await git(['checkout', '-q', '-b', 'draft', INT], gitRoot)
    await writeFile(join(gitRoot, 'fixed.ts'), 'DRAFT\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'draft'], gitRoot)
    await git(['checkout', '-q', 'main'], gitRoot)
    const draftBefore = (await git(['rev-parse', 'draft'], gitRoot)).stdout.trim()
    const intBefore = (await git(['rev-parse', INT], gitRoot)).stdout.trim()

    const res = await backfillFromRef(deps(), 'draft', '来历')
    expect(res.ok).toBe(true)
    expect(res.added).toEqual([])
    // 集成分支一步没动,已经修好的实现还在。
    expect((await git(['rev-parse', INT], gitRoot)).stdout.trim()).toBe(intBefore)
    expect(await intFile('fixed.ts')).toBe('GOOD\n')
    // 那条抢救分支自己也一步没动 —— 它是那一版产出唯一的落脚点。
    expect((await git(['rev-parse', 'draft'], gitRoot)).stdout.trim()).toBe(draftBefore)
  })

  /**
   * `checkout -- <path>` 的 path 是 **pathspec(通配符)**。判据按字面收了
   * `pages/[id].tsx`,而 git 会把 `[id]` 当字符类,顺手覆盖 `pages/d.tsx` ——
   * 那个文件判据刚刚才说过「不收」。
   */
  it('文件名里的通配符不许波及别的文件', async () => {
    await commitOnInt({ 'pages/d.tsx': 'INTEGRATION\n' })
    await onBranch('glob', { 'pages/[id].tsx': 'REF\n', 'pages/d.tsx': 'REF-OVERWRITE\n' })

    const res = await backfillFromRef(deps(), 'glob', '来历')
    expect(res.ok).toBe(true)
    expect(res.added).toEqual(['pages/[id].tsx'])
    expect(await intFile('pages/[id].tsx')).toBe('REF\n')
    // 判据说了「不收」的那个,一个字节都不许变。
    expect(await intFile('pages/d.tsx')).toBe('INTEGRATION\n')
  })

  /**
   * 集成分支上 `foo` 是文件、ref 上 `foo/` 是目录:补录 `foo/bar.txt` 会让 git
   * **删掉** `foo`(实测 `D foo / A foo/bar.txt`)。这直接推翻「捞是加法,不删任何东西」。
   */
  it('D/F 冲突:不许为了补录一个新路径而删掉集成分支上的文件', async () => {
    await commitOnInt({ foo: 'IMPORTANT\n' })
    // ref 上 foo/ 是目录 —— 集成分支上它是文件。
    await git(['checkout', '-q', '-b', 'df', INT], gitRoot)
    await git(['rm', '-q', 'foo'], gitRoot)
    await mkdir(join(gitRoot, 'foo'), { recursive: true })
    await writeFile(join(gitRoot, 'foo/bar.txt'), 'inner\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'foo is a dir'], gitRoot)
    await git(['checkout', '-q', 'main'], gitRoot)

    const res = await backfillFromRef(deps(), 'df', '来历')
    expect(res.added).toEqual([])
    expect(res.skipped.some(s => s.path === 'foo/bar.txt' && s.why.includes('会把那个文件删掉'))).toBe(true)
    // 集成分支上那个文件必须原样还在。
    expect(await intFile('foo')).toBe('IMPORTANT\n')
  })

  /** 删除本身也是成果:把集成分支**故意删掉**的文件复活,和覆盖一个文件是同一类事故。 */
  it('集成分支删过的路径不许被复活', async () => {
    await commitOnInt({ 'legacy.ts': 'buggy\n' })
    await git(['checkout', '-q', '-b', 'keeps', INT], gitRoot)
    await writeFile(join(gitRoot, 'legacy.ts'), 'buggy v2\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'still has it'], gitRoot)
    await git(['checkout', '-q', 'main'], gitRoot)
    // 集成分支上把它删掉 —— 删除本身也是成果。
    await commitOnInt({}, ['legacy.ts'])

    const res = await backfillFromRef(deps(), 'keeps', '来历')
    expect(res.added).toEqual([])
    expect(res.skipped.some(s => s.path === 'legacy.ts' && s.why.includes('被删掉'))).toBe(true)
    expect(await intFile('legacy.ts')).toBeNull()
  })

  /**
   * `A...B` 是 merge-base 口径,判据是 tip 口径。用三点的话,同一件事
   * (集成分支删了、ref 上还有)会因为「ref 有没有**恰好**碰过那个文件」而
   * 时而复活、时而漏掉 —— 结果由一件和意图无关的偶然决定。
   */
  it('候选清单按 tip 口径算,不受 merge-base 影响', async () => {
    await commitOnInt({ 'shared.ts': 'shared\n' })
    // ref 只加了自己的文件,**没碰** shared.ts。
    await onBranch('untouched', { 'refonly.ts': 'R\n' })
    // 集成分支之后把 shared.ts 删了(而且是一次真删除,不是从来没有过)。
    await commitOnInt({}, ['shared.ts'])

    const tip = (await git(['rev-parse', INT], gitRoot)).stdout.trim()
    const cand = await candidatePaths(deps(), 'untouched', tip)
    // 两点口径能看见 shared.ts(三点看不见),而删除判据把它挡下来 —— 两条一起才是对的。
    expect(cand.take).toEqual(['refonly.ts'])
    expect(cand.skipped.some(s => s.path === 'shared.ts')).toBe(true)
  })

  /** 指向仓库外的符号链接会随第 2 跳进用户的检出,之后任何非 git 工具顺着它走就写到仓库外。 */
  it('指向仓库外的符号链接不补录', async () => {
    await git(['checkout', '-q', '-b', 'links', INT], gitRoot)
    await symlink('../../../../etc', join(gitRoot, 'escape'))
    await symlink('base.txt', join(gitRoot, 'inside'))
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'links'], gitRoot)
    await git(['checkout', '-q', 'main'], gitRoot)

    const res = await backfillFromRef(deps(), 'links', '来历')
    expect(res.added).toEqual(['inside'])
    expect(res.skipped.some(s => s.path === 'escape' && s.why.includes('仓库外'))).toBe(true)
  })

  /**
   * `git checkout <tree-ish> -- <path>` 把 ref 的 blob **原样**装进 index(不重跑 clean
   * filter),`commit`(无 `-a`)提交的就是 index。所以两边 `.gitattributes` 不一样时
   * 补录进去的字节仍然逐字相同 —— 这是这条路唯一确认安全的性质,值得钉住。
   */
  it('字节保真:集成分支的 .gitattributes 不改写补录进来的内容', async () => {
    await commitOnInt({ '.gitattributes': '* text=auto\n' })
    await git(['checkout', '-q', '-b', 'crlf', 'main'], gitRoot)
    await writeFile(join(gitRoot, '.gitattributes'), '* -text\n')
    await writeFile(join(gitRoot, 'payload.txt'), 'x\r\ny\r\n')
    await git(['add', '-A'], gitRoot)
    await git(['commit', '-qm', 'crlf'], gitRoot)
    const refBlob = (await git(['rev-parse', 'crlf:payload.txt'], gitRoot)).stdout.trim()
    await git(['checkout', '-q', 'main'], gitRoot)

    const res = await backfillFromRef(deps(), 'crlf', '来历')
    expect(res.added).toContain('payload.txt')
    expect((await git(['rev-parse', `${INT}:payload.txt`], gitRoot)).stdout.trim()).toBe(refBlob)
  })

  it('中断之后一个字节都不写', async () => {
    await onBranch('lost2', { 'a.ts': 'A\n' })
    const ctl = new AbortController()
    ctl.abort()
    const before = (await git(['rev-parse', INT], gitRoot)).stdout.trim()
    const res = await backfillFromRef({ ...deps(), signal: ctl.signal }, 'lost2', '来历')
    expect(res.ok).toBe(false)
    expect((await git(['rev-parse', INT], gitRoot)).stdout.trim()).toBe(before)
  })
})

/**
 * 这两条钉的是**我们发出了哪条命令**,所以用替身 git —— 真 git 在这里回答不了
 * 「你有没有问过这一句」。上一轮的真 git 用例证明了行为对,而它们对下面这两件事
 * **恒绿**:批量循环恰好在候选为空时一条都不发(于是空 pathspec 那道闸被架空而不自知),
 * 以及最后那道 `--diff-filter=DMR` 复核在前面的判据都挡住时**永远不触发**。
 */
describe('两道兜底闸:必须能被单独证明', () => {
  const spyDeps = (
    answer: (args: string[]) => { code?: number; stdout?: string } | undefined,
    seen: string[][],
  ): BackfillDeps => ({
    git: async (args, _cwd) => {
      seen.push(args)
      const a = answer(args)
      return { code: a?.code ?? 0, stdout: a?.stdout ?? '', stderr: '' }
    },
    gitRoot: '/r', integrationBranch: INT, integrationPath: '/r/int', worktreeRoot: '/r/wt',
    withIntegrationLock: fn => fn(),
  })

  /**
   * **空 pathspec 的 `git checkout <ref> --` 是切分支,不是空操作。**
   *
   * 真 git 用例证不了这一条:候选为空时批量循环一条命令都不发,所以行为已经是对的。
   * 但那是**巧合**性质的正确 —— 有人把批量循环换回一句 `checkout ref -- ...paths`,
   * 行为就变成了「整条废稿被快进进集成分支 + 抢救分支被挪走」,而全部真 git 用例照样绿。
   * 所以这里直接断言:**没有任何一条 checkout 命令的 pathspec 是空的**。
   */
  it('候选为空时不许发出任何 checkout', async () => {
    const seen: string[][] = []
    const res = await backfillFromRef(spyDeps(args => {
      if (args[0] === 'rev-parse' && args[1] === INT) return { stdout: 'tip1\n' }
      // diff 回一个文件,而它在 ref 上不存在 → 候选为空。
      if (args[0] === 'diff') return { stdout: 'gone.txt\0' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: 1 }
      return undefined
    }, seen), 'draft', '来历')
    expect(res.added).toEqual([])
    const checkouts = seen.filter(a => a[0] === 'checkout')
    expect(checkouts.filter(a => a[a.length - 1] === '--')).toEqual([])
    expect(seen.some(a => a[0] === 'commit')).toBe(false)
  })

  /**
   * **最后那道复核必须真的能拦住一次提交。**
   *
   * 它问的是 git 自己:相对 HEAD,这次暂存区里有没有删除/修改/改名。上面每一条判据都
   * 可能有没想到的绕法(gitlink 当前缀就是一例:`cat-file -t` 对它回的是 `commit`,
   * 不是 `blob`,前缀判据看不见它)。少了这一句,「没有覆盖任何东西」就只是提交消息里的
   * 一句自述。
   */
  it('暂存区里出现删除/修改时,整笔作废、不提交', async () => {
    const seen: string[][] = []
    const res = await backfillFromRef(spyDeps(args => {
      if (args[0] === 'rev-parse' && args[1] === INT) return { stdout: 'tip1\n' }
      if (args[0] === 'diff' && args.includes('--diff-filter=DMR')) return { stdout: 'victim.txt\0' }
      if (args[0] === 'diff') return { stdout: 'new.txt\0' }
      // 两边的存在性:ref 上有、tip 上没有 → 收。
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: args[3]?.startsWith('tip1:') ? 1 : 0 }
      if (args[0] === 'rev-list') return { stdout: '' }
      if (args[0] === 'cat-file') return { code: 1 }
      if (args[0] === 'ls-tree') return { stdout: '100644 blob abc\tnew.txt\n' }
      return undefined
    }, seen), 'ref', '来历')
    expect(res.ok).toBe(false)
    expect(res.why).toContain('已还原,一个字节都没提交')
    expect(seen.some(a => a[0] === 'commit')).toBe(false)
    // 还原是真的做了,不是嘴上说说。
    expect(seen.some(a => a[0] === 'reset' && a[1] === '--hard')).toBe(true)
  })
})

describe('孤儿目录:此前唯一 0% 捞回的一格', () => {
  const copyInto = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }

  it('集成分支上没有的文件被真的补录进去', async () => {
    const orphan = join(worktreeRoot, 'integration.orphan')
    await mkdir(join(orphan, 'src'), { recursive: true })
    await writeFile(join(orphan, 'src/lost.ts'), 'ONLY HERE\n')
    const res = await backfillFromDir(deps(), orphan, ['src/lost.ts'], copyInto, '来历')
    expect(res.ok).toBe(true)
    expect(res.added).toEqual(['src/lost.ts'])
    expect(await intFile('src/lost.ts')).toBe('ONLY HERE\n')
    // 目录本身一个字节都不动 —— 捞是加法,不是搬家。
    expect(await readFile(join(orphan, 'src/lost.ts'), 'utf8')).toBe('ONLY HERE\n')
  })

  it('集成分支上已经有的路径不许被盖', async () => {
    const orphan = join(worktreeRoot, 'integration.orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'base.txt'), 'OVERWRITE\n')
    const res = await backfillFromDir(deps(), orphan, ['base.txt'], copyInto, '来历')
    expect(res.added).toEqual([])
    expect(await intFile('base.txt')).toBe('base\n')
  })
})

/**
 * 验收席在真 git 上推翻的那几条 —— 每一条都配一条钉子。
 */
describe('验收推翻过的形状', () => {
  it('文件名首尾带空格照样捞回来 —— -z 切完不许再 trim', async () => {
    await onBranch('spacey', { ' lead.txt': 'L\n', 'trail.txt ': 'T\n', 'normal.txt': 'N\n' })
    const res = await backfillFromRef(deps(), 'spacey', '来历')
    expect(res.added.sort()).toEqual([' lead.txt', 'normal.txt', 'trail.txt '])
    expect(await intFile(' lead.txt')).toBe('L\n')
  })

  /**
   * **`merge-scratch` 是共享的,而这一段不在锁里。**
   *
   * 另一条流(第 1 级合并 / syncTrunk)在我们两批 checkout 之间做一次 stageAt + merge,
   * 我们的补录提交就长在**它的合并提交**上,ff 会把整条废稿一起快进进集成分支。
   * 上一版的复核基准是 scratch 的 HEAD,所以它一次都不响 —— 验收席实测到已经修好的
   * 文件被废稿盖掉。判据换成 tip 之后,别人那次合并带进来的每一处都显形成 M/D。
   */
  it('临时工作区被别的流程挪走时:整笔作废,不提交', async () => {
    const seen: string[][] = []
    let head = 'tip1'
    const res = await backfillFromRef({
      git: async (args, _cwd) => {
        seen.push(args)
        if (args[0] === 'rev-parse' && args[1] === INT) return { code: 0, stdout: 'tip1\n', stderr: '' }
        if (args[0] === 'diff' && args.includes('-z') && args[1] === '--name-only') return { code: 0, stdout: 'new.txt\0', stderr: '' }
        if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: args[3]?.startsWith('tip1:') ? 1 : 0, stdout: '', stderr: '' }
        if (args[0] === 'rev-list') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'cat-file') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'ls-tree') return { code: 0, stdout: '100644 blob abc\tnew.txt\n', stderr: '' }
        // checkout 之后,别人把这棵树挪到了自己的合并提交上。
        if (args[0] === 'checkout') { head = 'someone-elses-merge'; return { code: 0, stdout: '', stderr: '' } }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: `${head}\n`, stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
      gitRoot: '/r', integrationBranch: INT, integrationPath: '/r/int', worktreeRoot: '/r/wt',
      withIntegrationLock: fn => fn(),
    }, 'draft', '来历')
    expect(res.ok).toBe(false)
    expect(res.why).toContain('被别的流程挪走')
    expect(seen.some(a => a[0] === 'commit')).toBe(false)
    // 而且**不许**去 ff:那一步会把别人那条合并一起快进进集成分支。
    expect(seen.some(a => a[0] === 'merge' && a.includes('--ff-only'))).toBe(false)
  })

  /**
   * **暂存区空了 ≠ 成功。** 上一版在这里 `return { ok: true }`,于是屏幕逐字说
   * 「补录了 1 个集成分支缺失的文件」而集成分支一个字节都没动 —— 验收席实测到的假成功。
   */
  it('要补录的内容在提交前消失时,报失败而不是成功', async () => {
    const res = await backfillFromRef({
      git: async (args, _cwd) => {
        if (args[0] === 'rev-parse' && args[1] === INT) return { code: 0, stdout: 'tip1\n', stderr: '' }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: 'tip1\n', stderr: '' }
        if (args[0] === 'diff' && args[1] === '--name-only') return { code: 0, stdout: 'new.txt\0', stderr: '' }
        // 暂存区两次询问都回空 —— 别人 reset --hard 过。
        if (args[0] === 'diff' && args[1] === '--cached') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: args[3]?.startsWith('tip1:') ? 1 : 0, stdout: '', stderr: '' }
        if (args[0] === 'rev-list') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'cat-file') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === 'ls-tree') return { code: 0, stdout: '100644 blob abc\tnew.txt\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
      gitRoot: '/r', integrationBranch: INT, integrationPath: '/r/int', worktreeRoot: '/r/wt',
      withIntegrationLock: fn => fn(),
    }, 'ref', '来历')
    expect(res.ok).toBe(false)
    expect(res.why).toContain('一个字节都没提交')
  })
})
