/**
 * `escapedPaths` 的探针。
 *
 * 这个模块的下游会**动用户的工作区**(park-then-merge),所以每一条判据都要能单独打中:
 * 归因错一次 = 把用户正在写的东西 stash 走。
 */
import { describe, expect, it } from 'bun:test'
import { escapedPathsIn, normalisePath, under , relativisePaths } from './escapedPaths.js'

describe('under —— 按路径段比,不按 startsWith', () => {
  /**
   * `startsWith` 会把 `/repo-backup/x` 判成在 `/repo` 下面。这个仓库为同一类前缀误判
   * 付过账(`buildOutputs` 的 proven 归属,变异测试抓出来的)。
   */
  it('同前缀的兄弟目录不算在里面', () => {
    expect(under('/repo', '/repo/pkg/a.rs')).toBe(true)
    expect(under('/repo', '/repo')).toBe(true)
    expect(under('/repo', '/repo-backup/pkg/a.rs')).toBe(false)
    expect(under('/repo', '/repository/a.rs')).toBe(false)
  })

  it('结尾斜杠与重复斜杠不影响判断', () => {
    expect(under('/repo/', '/repo//pkg/a.rs')).toBe(true)
    expect(normalisePath('/a//b/')).toBe('/a/b')
  })
})

describe('escapedPathsIn —— 摘出「落在主检出、不在自己工作区」的路径', () => {
  const G = '/repo'
  const W = '/repo/.efftask-worktrees/efftask-001-aa'

  it('席位写自己的工作区 → 不算越界', () => {
    expect(escapedPathsIn({ file_path: `${W}/pkg/a.rs` }, { gitRoot: G, cwd: W })).toEqual([])
  })

  it('席位写主检出 → 算', () => {
    expect(escapedPathsIn({ file_path: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W }))
      .toEqual([`${G}/pkg/a.rs`])
  })

  /**
   * **`cwd` 缺席一条都不算。** 共享工作树档下席位本来就在主检出干活;
   * 不早退的话每次调用都误报(接缝席点名的那条)。
   */
  it('席位没有自己的工作区(共享档)→ 一条都不算', () => {
    expect(escapedPathsIn({ file_path: `${G}/pkg/a.rs` }, { gitRoot: G })).toEqual([])
    expect(escapedPathsIn({ file_path: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: '' })).toEqual([])
  })

  it('写主检出之外(/tmp、只读源码目录)→ 不关这件事', () => {
    expect(escapedPathsIn({ file_path: '/tmp/x.rs' }, { gitRoot: G, cwd: W })).toEqual([])
    expect(escapedPathsIn({ file_path: '/src/qianbase/x.go' }, { gitRoot: G, cwd: W })).toEqual([])
  })

  /**
   * **软链要由调用方解开,但两条根都传进来时都要认。**
   * 跑机上 `/home/esgyn/work/tools/…` 是 `/home/esgyn/tb/tools/…` 的软链,
   * node.md 里两条各出现 1170 / 1396 次。
   */
  it('额外的根(软链那一份)也要认', () => {
    const alt = '/alt/repo'
    expect(escapedPathsIn({ file_path: `${alt}/pkg/a.rs` }, { gitRoot: G, cwd: W, roots: [alt] }))
      .toEqual([`${alt}/pkg/a.rs`])
  })

  /**
   * 只认 `file_path`/`notebook_path`;别的字段**故意不参与**(会归因错)。
   *
   * ⚠ 第一版这条探针用的是 `sed -i s/a/b/ /repo/pkg/a.rs` —— 整串不以 `/` 开头,
   * 于是被后面那道 `startsWith('/')` 先挡住了,**拿掉 file_path 守卫结果照样是 []**。
   * 变异测试实测它存活。要打中就得给一个**本身就是绝对路径**的非 file_path 字段。
   */
  it('非 file_path 字段不参与归因,哪怕它的值就是一条主检出绝对路径', () => {
    // 这三个如果被认了,下游会去动用户的工作区 —— 而它们都不是「席位写了这个文件」的证据
    expect(escapedPathsIn({ command: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W })).toEqual([])
    expect(escapedPathsIn({ path: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W })).toEqual([])
    expect(escapedPathsIn({ pattern: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W })).toEqual([])
    // 反证:同一个值挂在 file_path 上就要认 —— 证明挡住它的是**字段名**,不是别的
    expect(escapedPathsIn({ file_path: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W }))
      .toEqual([`${G}/pkg/a.rs`])
  })

  /** Bash 那一类归因不到 —— 覆盖面缺口,要在屏幕上说出来,不是假装挡住了。 */
  it('Bash 的整条命令行不解析(宁可归因不到,不可归因错)', () => {
    expect(escapedPathsIn(
      { command: `sed -i s/a/b/ ${G}/pkg/a.rs` }, { gitRoot: G, cwd: W },
    )).toEqual([])
  })

  it('嵌套结构里的 file_path 也摘得到,而且去重', () => {
    const input = { edits: [{ file_path: `${G}/a.rs` }, { file_path: `${G}/a.rs` }, { file_path: `${W}/b.rs` }] }
    expect(escapedPathsIn(input, { gitRoot: G, cwd: W })).toEqual([`${G}/a.rs`])
  })

  it('相对路径不算(它是相对 cwd 的,天然在工作区里)', () => {
    expect(escapedPathsIn({ file_path: 'pkg/a.rs' }, { gitRoot: G, cwd: W })).toEqual([])
  })
})

describe('normalisePath —— `.` 与 `..` 要消掉', () => {
  /**
   * 登记簿是**按字符串做键**的,而 `intoTrunk` 查的是 `${gitRoot}/${git 报的相对路径}`。
   * `.` 不消的话 `/repo/./pkg/a.rs` 这条键永远对不上,记了等于没记(对抗席实测)。
   */
  it('`.` 段不改变含义', () => {
    expect(normalisePath('/repo/./pkg/a.rs')).toBe('/repo/pkg/a.rs')
  })

  /**
   * `NotebookEdit` 尤其要紧:Edit/Write 在 `canUseTool` 之前有 `backfillObservableInput`
   * → `expandPath` 帮忙 normalize 过,notebook 那条**没有** —— 于是
   * `<自己的工作区>/../../notebooks/x.ipynb` 会被判成「在工作区里」而放行且不记录。
   */
  it('`..` 段真的往上走一层,而不是被当成普通目录名', () => {
    expect(normalisePath('/repo/wt/../pkg/a.rs')).toBe('/repo/pkg/a.rs')
    expect(under('/repo/wt', '/repo/wt/../pkg/a.rs')).toBe(false)
    expect(under('/repo', '/repo/wt/../pkg/a.rs')).toBe(true)
  })

  it('绝对路径在根上再往上还是根', () => {
    expect(normalisePath('/../../etc/x')).toBe('/etc/x')
  })
})

describe('escapedPathsIn —— 软链由调用方注入的 realpath 解开', () => {
  const G = '/repo'
  const W = '/repo/.efftask-worktrees/w'
  /** 跑机上 `/home/esgyn/work/tools/…` 是 `/home/esgyn/tb/tools/…` 的软链。 */
  const rp = (p: string): string => p.replace(/^\/alias\b/, G)

  it('席位照别名写主检出 → 认得出,而且摘出来的是**解开之后**那条', () => {
    expect(escapedPathsIn({ file_path: '/alias/pkg/a.rs' }, { gitRoot: G, cwd: W, realpath: rp }))
      .toEqual([`${G}/pkg/a.rs`])
  })

  it('席位照别名写**自己的工作区** → 解开之后落在 cwd 里,不算越界', () => {
    expect(escapedPathsIn(
      { file_path: '/alias/.efftask-worktrees/w/a.rs' }, { gitRoot: G, cwd: W, realpath: rp },
    )).toEqual([])
  })

  it('解不开(realpath 返回 undefined)→ 退回按字面比,不崩', () => {
    expect(escapedPathsIn(
      { file_path: `${G}/pkg/a.rs` }, { gitRoot: G, cwd: W, realpath: () => undefined },
    )).toEqual([`${G}/pkg/a.rs`])
  })
})

/**
 * **把方案里指向仓库内的绝对路径削成相对。**
 *
 * 病根:根方案作者收到的「工作目录」逐字是主检出绝对路径,它写进方案正文之后被
 * 子节点 goal 继承和 plan JSON 回灌复制到全树(跑机 node.md 里 2566 处)。
 * 而那一席**不在越界闸内**(没有 `req.cwd`),只能在它的输出上削。
 */
describe('relativisePaths', () => {
  const R = ['/home/e/tb/proj']

  it('仓库内的削成相对', () => {
    expect(relativisePaths('改 /home/e/tb/proj/pkg/sql/a.rs', R)).toBe('改 pkg/sql/a.rs')
  })

  /** **仓库外的一个字不动** —— 那些可能是用户故意写的(参考仓库、日志目录),相对化毫无意义。 */
  it('仓库外的绝对路径原样保留', () => {
    expect(relativisePaths('看 /etc/hosts 和 ~/.config/x', R)).toBe('看 /etc/hosts 和 ~/.config/x')
  })

  /**
   * **段边界,不是 `startsWith`。** 后者会把 `/repo-backup/x` 削成 `-backup/x` ——
   * 这个仓库为同一类前缀误判付过账(`buildOutputs` 的 proven 归属,变异测试抓出来的)。
   */
  it('同前缀的兄弟目录不许被削', () => {
    expect(relativisePaths('别碰 /home/e/tb/proj-backup/x', R)).toBe('别碰 /home/e/tb/proj-backup/x')
    expect(relativisePaths('也别碰 /home/e/tb/projx/y', R)).toBe('也别碰 /home/e/tb/projx/y')
  })

  /** 光秃秃的根本身 → `.`,别削成空串让句子塌掉(「在  里跑」)。 */
  it('根本身削成 .', () => {
    expect(relativisePaths('在 /home/e/tb/proj 里跑', R)).toBe('在 . 里跑')
  })

  /** 多个根时**长的先削** —— 否则 `/a` 会先命中 `/a/b` 里的前缀,把它削成 `/b`。 */
  it('嵌套的根:长的先削', () => {
    expect(relativisePaths('/a/b/x.rs', ['/a', '/a/b'])).toBe('x.rs')
  })

  it('没有根 / 空文本 → 原样返回', () => {
    expect(relativisePaths('/a/b', [])).toBe('/a/b')
    expect(relativisePaths('', R)).toBe('')
    // `/` 单独一个不算根 —— 削它会把每一条绝对路径都变成相对
    expect(relativisePaths('/etc/x', ['/'])).toBe('/etc/x')
  })
})
