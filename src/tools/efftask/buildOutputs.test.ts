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
  EFFTASK_INTERNAL_PATHS, isInternalPath, scanBuildOutputs, wipeBuildOutputs, wipeBuildOutputsAt,
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
