/**
 * `buildOutputs` 的探针 —— **全部打在真 git 上**。
 *
 * 这个模块的每一条判据都是「代码看起来对、真 git 说不对」的形状(嵌套仓库静默跳过而
 * 退出码是 0、`info/exclude` 对 linked worktree 生效、`:(exclude)` pathspec 对整目录忽略项
 * 不生效、git 把父目录折叠上来)。假 GitRunner 会对这四条**全部点头**。
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  CARGO_CACHEDIR_SIGNATURE, EFFTASK_INTERNAL_PATHS, isInternalPath, mixedTops, scanBuildOutputs,
  scanTrackedBuildOutputs, untrackBuildOutputs, wipeBuildOutputs, wipeBuildOutputsAt,
  type BuildWipeGit,
} from './buildOutputs.js'

const git: BuildWipeGit = (args, cwd) =>
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

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

async function freshRepo(ignore = 'target/\n'): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'efftask-bo-'))
  roots.push(base)
  repo = join(base, 'repo')
  await mkdir(repo, { recursive: true })
  await git(['init', '-q', '-b', 'main', '.'], repo)
  await git(['config', 'user.email', 's@s'], repo)
  await git(['config', 'user.name', 's'], repo)
  await writeFile(join(repo, '.gitignore'), ignore)
  await writeFile(join(repo, 'keep.txt'), 'keep\n')
  await git(['add', '-A'], repo)
  await git(['commit', '-qm', 'base'], repo)
}

beforeEach(() => freshRepo())
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

/** 每个条目 1 KB,好让释放量是可断言的确定值。 */
const oneKb = async (): Promise<number | undefined> => 1
const deps = (dirSizeKb?: (p: string) => Promise<number | undefined>): Parameters<typeof scanBuildOutputs>[0] =>
  (dirSizeKb ? { git, dirSizeKb } : { git })

describe('构建产物:清被忽略的,不碰别的', () => {
  it('清掉 target/,而未跟踪但未被忽略的文件原样留着', async () => {
    await mkdir(join(repo, 'target', 'debug'), { recursive: true })
    await writeFile(join(repo, 'target', 'debug', 'big.o'), 'x'.repeat(4096))
    // 执行者刚生成、还没提交的交付物。`-x` 会把它一起删掉,而这正是这个模块用 `-X` 的理由。
    await writeFile(join(repo, 'draft.ts'), 'export const a = 1\n')
    // 已跟踪文件的未提交改动 —— clean 从不碰已跟踪文件,但要有一条钉住它。
    await writeFile(join(repo, 'keep.txt'), 'edited\n')

    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.entries.map(e => e.rel)).toEqual(['target/'])
    expect(plan.totalKb).toBe(1)
    expect(plan.sizeKnown).toBe(true)

    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.error).toBeUndefined()
    expect(out.removed).toEqual(['target/'])
    expect(out.freedKb).toBe(1)
    expect(await exists(join(repo, 'target'))).toBe(false)
    expect(await exists(join(repo, 'draft.ts'))).toBe(true)
    expect((await git(['status', '--porcelain'], repo)).stdout).toContain('keep.txt')
  })

  it('没有东西可清时不报「共 0 KB」—— sizeKnown 为 false', async () => {
    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.entries).toEqual([])
    expect(plan.sizeKnown).toBe(false)
    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.removed).toEqual([])
    expect(out.freedKb).toBe(0)
  })

  it('量不到大小就说不知道,不编 0', async () => {
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')
    const plan = await scanBuildOutputs(deps(async () => undefined), repo)
    expect(plan.entries).toEqual([{ rel: 'target/' }])
    expect(plan.sizeKnown).toBe(false)
    expect(plan.totalKb).toBe(0)
  })
})

/**
 * **嵌套 git 仓库:git 静默跳过,退出码仍是 0。**
 *
 * 不报出来的话,屏幕会说「已清掉 N GB」而盘上一个字节没少 —— Rust/Go/node 的忽略目录里
 * 躺个 vendored checkout 是常事。**绝不能改用 `-f -f` 越过它**:那会连同它没推走的提交
 * 一起删掉。
 */
describe('嵌套仓库', () => {
  it('被跳过要如实报出来,而且释放量不算它', async () => {
    await freshRepo('target/\nvendorbuild/\n')
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')
    const sub = join(repo, 'vendorbuild', 'subrepo')
    await mkdir(sub, { recursive: true })
    await git(['init', '-q', '-b', 'main', '.'], sub)
    await git(['config', 'user.email', 's@s'], sub)
    await git(['config', 'user.name', 's'], sub)
    await writeFile(join(sub, 'v.txt'), 'v\n')
    await git(['add', '-A'], sub)
    await git(['commit', '-qm', 'v'], sub)

    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.skippedRepos).toEqual(['vendorbuild/subrepo'])
    const out = await wipeBuildOutputs(deps(oneKb), plan)
    // 退出码是 0,所以「成功」这个词必须由别的东西承载 —— 这里就是 skippedRepos。
    expect(out.error).toBeUndefined()
    expect(out.skippedRepos).toEqual(['vendorbuild/subrepo'])
    // 嵌套仓库原样还在。
    expect(await exists(join(sub, 'v.txt'))).toBe(true)
    // 而释放量只算真的删掉的那一条。
    expect(out.removed).toEqual(['target/'])
    expect(out.freedKb).toBe(1)
  })
})

/**
 * **`/et` 自己的记录不许被清。**
 *
 * `worktreePool.init()` 把 `.efftask-worktrees/` 和 `.claude/efftask/` 写进
 * `$GIT_COMMON_DIR/info/exclude`,而它对 linked worktree **生效**(实测 check-ignore 指到它)。
 * 于是一句裸的 `clean -X` 会把任务记录一起清掉 —— 而执行者的 cwd 正是节点工作区。
 */
describe('/et 自己的记录', () => {
  it('.claude/efftask 与 .efftask-worktrees 一个字节都不碰,而且要报出被排除了什么', async () => {
    await writeFile(join(repo, '.git', 'info', 'exclude'), '.claude/efftask/\n.efftask-worktrees/\n')
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')
    await mkdir(join(repo, '.claude', 'efftask', 'run1'), { recursive: true })
    await writeFile(join(repo, '.claude', 'efftask', 'run1', 'node.md'), 'id: root\n')
    await mkdir(join(repo, '.efftask-worktrees', 'x'), { recursive: true })
    await writeFile(join(repo, '.efftask-worktrees', 'x', 'f'), 'w')

    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.entries.map(e => e.rel)).toEqual(['target/'])
    // 排除也是一次处置,要说得出口。
    expect(plan.excluded.sort()).toEqual(['.claude/', '.efftask-worktrees/'])

    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.excluded.sort()).toEqual(['.claude/', '.efftask-worktrees/'])
    expect(await exists(join(repo, '.claude', 'efftask', 'run1', 'node.md'))).toBe(true)
    expect(await exists(join(repo, '.efftask-worktrees', 'x', 'f'))).toBe(true)
    expect(await exists(join(repo, 'target'))).toBe(false)
  })

  /**
   * **折叠上来的父目录。** git 对「父目录未被跟踪、里面全是忽略项」报的是**父目录**:
   * exclude 里写的是 `.claude/efftask/`,而 `clean -Xdn` 说的是 `Would remove .claude/`。
   * 按「以受保护路径为前缀」单向过滤会漏掉它 —— 删掉 `.claude/` 就是删掉 `.claude/efftask/`。
   */
  it('git 把 .claude/efftask/ 折叠报成 .claude/ 时同样要挡住', async () => {
    await writeFile(join(repo, '.git', 'info', 'exclude'), '.claude/efftask/\n')
    await mkdir(join(repo, '.claude', 'efftask', 'run1'), { recursive: true })
    await writeFile(join(repo, '.claude', 'efftask', 'run1', 'node.md'), 'id: root\n')

    const plan = await scanBuildOutputs(deps(oneKb), repo)
    // 这一条就是实测出来的形状:git 报的是父目录。
    expect(plan.excluded).toEqual(['.claude/'])
    expect(plan.entries).toEqual([])
    await wipeBuildOutputs(deps(oneKb), plan)
    expect(await exists(join(repo, '.claude', 'efftask', 'run1', 'node.md'))).toBe(true)
  })

  it('isInternalPath 双向判:落在里面、以及是它的祖先', () => {
    expect(isInternalPath('.claude/efftask/')).toBe(true)
    expect(isInternalPath('.claude/efftask/run1/node.md')).toBe(true)
    expect(isInternalPath('.claude/')).toBe(true)          // 祖先
    expect(isInternalPath('.efftask-worktrees')).toBe(true)
    // 长得像但不是 —— 一个叫 .claude-backup 的目录不该被保护。
    expect(isInternalPath('.claude-backup/')).toBe(false)
    expect(isInternalPath('target/')).toBe(false)
    expect(EFFTASK_INTERNAL_PATHS).toContain('.claude/efftask')
  })
})

/**
 * **路径里有空格、有中文时照样命中。**
 *
 * `core.quotepath=false` 让枚举出来的是原文而不是 `"\344\270\255…"`,而把原文按 argv
 * 数组传回去删是有效的(不过 shell)。少了这个开关,中文目录会因为路径对不上而**清不掉**,
 * 同时那串转义会原样摆到用户面前。
 */
describe('非 ASCII 与空格路径', () => {
  it('中文目录名和带空格的目录名都清得掉', async () => {
    await freshRepo('target/\n中文产物/\ndir with space/\n')
    for (const d of ['target', '中文产物', 'dir with space']) {
      await mkdir(join(repo, d), { recursive: true })
      await writeFile(join(repo, d, 'a.o'), 'x')
    }
    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.entries.map(e => e.rel).sort()).toEqual(['dir with space/', 'target/', '中文产物/'])
    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.removed.sort()).toEqual(['dir with space/', 'target/', '中文产物/'])
    expect(out.freedKb).toBe(3)
    for (const d of ['target', '中文产物', 'dir with space']) {
      expect(await exists(join(repo, d))).toBe(false)
    }
  })
})

/**
 * **用户点名的那个目录:点开头、而且没被 .gitignore 忽略。**
 *
 * 跑机上真实存在的 `.cargo-target-sql-restore`。它清不掉 —— 这是 `-X` 的直接后果,
 * 而这件事必须能被断言,因为屏幕上要照着它说话(「未被忽略的构建目录不会被清掉」)。
 */
describe('未被忽略的构建目录', () => {
  it('.cargo-target-sql-restore 不在清理范围里 —— 这是要说出口的边界,不是 bug', async () => {
    await mkdir(join(repo, '.cargo-target-sql-restore', 'debug'), { recursive: true })
    await writeFile(join(repo, '.cargo-target-sql-restore', 'debug', 'big.bin'), 'x'.repeat(4096))
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')

    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.entries.map(e => e.rel)).toEqual(['target/'])
    await wipeBuildOutputs(deps(oneKb), plan)
    expect(await exists(join(repo, '.cargo-target-sql-restore', 'debug', 'big.bin'))).toBe(true)
  })
})

/**
 * **释放量必须是测量,不是承诺。**
 *
 * 扫描和真删之间隔着一屏确认(用户可能看很久),那期间盘上完全可能变化。拿 `plan.totalKb`
 * 顶替 `freedKb`,屏幕就会把一句**已经在确认屏上承诺过的**数字当成一次测量报出来。
 */
describe('释放量', () => {
  it('扫描之后条目自己没了 —— 报腾出 0,不报计划里的那个数', async () => {
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')
    const plan = await scanBuildOutputs(deps(oneKb), repo)
    expect(plan.totalKb).toBe(1)
    // 别的东西(用户自己、另一个构建)把它清掉了。
    await rm(join(repo, 'target'), { recursive: true, force: true })
    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.removed).toEqual([])
    expect(out.freedKb).toBe(0)
    expect(out.sizeKnown).toBe(false)
  })
})

describe('探不动的时候', () => {
  it('不是 git 仓库 → 报 error,而且一条都不删', async () => {
    const base = await mkdtemp(join(tmpdir(), 'efftask-bo-nonrepo-'))
    roots.push(base)
    const plan = await scanBuildOutputs(deps(oneKb), base)
    expect(plan.error).toBeDefined()
    expect(plan.entries).toEqual([])
    const out = await wipeBuildOutputs(deps(oneKb), plan)
    expect(out.error).toBe(plan.error!)
    expect(out.removed).toEqual([])
  })
})

describe('wipeBuildOutputsAt', () => {
  it('扫 + 删一次做完,结果和分两步逐字相同', async () => {
    await mkdir(join(repo, 'target'), { recursive: true })
    await writeFile(join(repo, 'target', 'a.o'), 'x')
    const out = await wipeBuildOutputsAt(deps(oneKb), repo)
    expect(out.removed).toEqual(['target/'])
    expect(out.freedKb).toBe(1)
    expect(await exists(join(repo, 'target'))).toBe(false)
  })
})

/**
 * **已经被提交进版本库的构建产物 —— `clean -X` 那一半碰不到的那一类。**
 *
 * 跑机 .30 实测:master 上 2 608 个文件 / 52.86 GiB 被跟踪,而项目 `.gitignore` 里
 * 一条相关规则都没有。判据按 cargo 的 `CACHEDIR.TAG` 签名,不按名字 —— 那 135 个目录
 * 叫 `.cargo-target-opt-skeleton` / `.cargo-task-verify` / `.opt-memo-integration-cargo-target`,
 * 没有一条命名规律覆盖得全。
 */
describe('scanTrackedBuildOutputs(按签名判定)', () => {
  const lsTree = (files: string[]) => files.join('\n')
  const mk = (files: string[], blobs: Record<string, string>): BuildWipeGit =>
    (async args => {
      if (args.includes('ls-tree')) return { code: 0, stdout: lsTree(files), stderr: '' }
      if (args.includes('show')) {
        const spec = args[args.length - 1] ?? ''
        const p = spec.slice(spec.indexOf(':') + 1)
        return blobs[p] === undefined
          ? { code: 1, stdout: '', stderr: 'no such path' }
          : { code: 0, stdout: blobs[p], stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })

  const SIG = `${CARGO_CACHEDIR_SIGNATURE}\n# created by cargo\n`

  it('签名对得上的目录 → 它下面的全部被跟踪文件进「可证明」桶', async () => {
    const git = mk(
      ['src/main.rs', '.cargo-target-x/CACHEDIR.TAG', '.cargo-target-x/debug/a.bin', '.cargo-target-x/debug/b.bin'],
      { '.cargo-target-x/CACHEDIR.TAG': SIG },
    )
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.provenDirs).toEqual(['.cargo-target-x/'])
    expect(p.proven).toHaveLength(3)
    expect(p.proven).not.toContain('src/main.rs')
    expect(p.danger).toEqual([])
  })

  /**
   * **归属判据是「前缀」,不是「包含」。**
   *
   * 变异测试抓到的真覆盖缺口:`f.includes(dir)` 会把 `y/x/t/data.bin` 也算进
   * `x/t/` 这个已证明目录 —— 而它是**另一棵目录树**里的文件。这条路会 `git rm` 真文件,
   * 归属判错一次就是删掉一个和产物毫无关系的东西。
   */
  it('同名目录出现在别的路径下时不算(前缀,不是包含)', async () => {
    const git = mk(
      ['x/t/CACHEDIR.TAG', 'x/t/a.bin', 'y/x/t/data.bin'],
      { 'x/t/CACHEDIR.TAG': SIG },
    )
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.provenDirs).toEqual(['x/t/'])
    expect(p.proven.sort()).toEqual(['x/t/CACHEDIR.TAG', 'x/t/a.bin'])
    expect(p.proven).not.toContain('y/x/t/data.bin')
  })

  /** **签名不对就不算证明** —— 一个同名文件不足以让整个目录被删。 */
  it('CACHEDIR.TAG 在、签名不对 → 不进「可证明」桶', async () => {
    const git = mk(
      ['weird/CACHEDIR.TAG', 'weird/data.txt'],
      { 'weird/CACHEDIR.TAG': 'Signature: 别的东西\n' },
    )
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.provenDirs).toEqual([])
    expect(p.proven).toEqual([])
  })

  it('名字像、拿不出签名 → 进「疑似」桶(默认不选)', async () => {
    const git = mk(['.cargo-target-y/debug/a.bin', 'libx.rlib', 'src/main.rs'], {})
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.proven).toEqual([])
    expect(p.suspected.sort()).toEqual(['.cargo-target-y/debug/a.bin', 'libx.rlib'])
  })

  /** **`.cargo/config.toml` 不许被卷进去** —— 它是真会被提交的配置文件。 */
  it('.cargo/ 下的配置不算产物(判据写的是 .cargo-target-*,不是 .cargo-*)', async () => {
    const git = mk(['.cargo/config.toml'], {})
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.proven).toEqual([])
    expect(p.suspected).toEqual([])
  })

  /** 硬闸:源码混进来就整个不做。跑机上两桶都是干净的,但这条闸挡的是不可逆的那一步。 */
  it('桶里混进源码 → danger 非空(调用方据此整个不做)', async () => {
    const git = mk(
      ['.cargo-target-z/CACHEDIR.TAG', '.cargo-target-z/src/real.rs'],
      { '.cargo-target-z/CACHEDIR.TAG': SIG },
    )
    const p = await scanTrackedBuildOutputs({ git }, '/repo')
    expect(p.danger).toEqual(['.cargo-target-z/src/real.rs'])
  })

  /** …但 target 目录里那些**长得像**源码的不算(fingerprint / incremental / rustc_info)。 */
  it('fingerprint 与 incremental 下的 .json/.rs 不算源码', async () => {
    const git = mk(
      ['.cargo-target-w/CACHEDIR.TAG', '.cargo-target-w/.rustc_info.json',
        '.cargo-target-w/debug/.fingerprint/x/lib.json', '.cargo-target-w/debug/incremental/y/dep.rs'],
      { '.cargo-target-w/CACHEDIR.TAG': SIG },
    )
    expect((await scanTrackedBuildOutputs({ git }, '/repo')).danger).toEqual([])
  })
})

describe('mixedTops', () => {
  /**
   * 手工收口那次它真的拦下过一次:`.opt-memo-integration-cargo-target/` 两个桶都漏了,
   * 自检报出来之后才发现是**清单不全**,不是规则误伤。
   */
  it('顶层条目底下混着非产物时报出来(整目录删之前的自检)', () => {
    const all = ['.cargo-target-x/a.bin', '.cargo-target-x/NOTES.md', 'src/main.rs']
    expect(mixedTops(all, ['.cargo-target-x/a.bin'])).toEqual([
      { top: '.cargo-target-x', strays: ['.cargo-target-x/NOTES.md'] },
    ])
  })

  it('底下全是产物时为空', () => {
    const all = ['.cargo-target-x/a.bin', '.cargo-target-x/b.bin', 'src/main.rs']
    expect(mixedTops(all, ['.cargo-target-x/a.bin', '.cargo-target-x/b.bin'])).toEqual([])
  })
})

describe('untrackBuildOutputs', () => {
  it('按顶层条目删(2681 个路径逐条会把命令行撑爆)', async () => {
    const seen: string[][] = []
    const git: BuildWipeGit = (async args => { seen.push(args); return { code: 0, stdout: '', stderr: '' } })
    const out = await untrackBuildOutputs({ git }, '/repo', ['a/1', 'a/2', 'b/3'])
    expect(out).toEqual({ removed: 3 })
    expect(seen[0]?.slice(-2)).toEqual(['a', 'b'])
  })

  it('git rm 失败 → 如实报,不谎报删了多少', async () => {
    const git: BuildWipeGit = (async () => ({ code: 128, stdout: '', stderr: 'fatal: nope' }))
    const out = await untrackBuildOutputs({ git }, '/repo', ['a/1'])
    expect(out.removed).toBe(0)
    expect(out.error).toContain('fatal: nope')
  })

  it('空清单是空操作(不发 git rm)', async () => {
    let calls = 0
    const git: BuildWipeGit = (async () => { calls++; return { code: 0, stdout: '', stderr: '' } })
    expect(await untrackBuildOutputs({ git }, '/repo', [])).toEqual({ removed: 0 })
    expect(calls).toBe(0)
  })
})
