/**
 * `escapeRegistry` 的探针。
 *
 * 这个模块的下游会**动用户的工作区**(park-then-merge),所以每一条判据都要能单独打中:
 * 归因错一次 = 把用户正在写的东西 stash 走。
 */
import { describe, expect, it } from 'bun:test'
import { createEscapeRegistry, escapedPathsIn, normalisePath, under } from './escapeRegistry.js'

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

describe('createEscapeRegistry', () => {
  const c = (path: string, nodeId = 'n1') => ({ nodeId, phase: 'execute', tool: 'Edit', path })

  it('点名过的路径 owns 为真,没点名的为假', () => {
    const r = createEscapeRegistry()
    r.note(c('/repo/pkg/a.rs'))
    expect(r.owns('/repo/pkg/a.rs')).toBe(true)
    expect(r.owns('/repo/pkg/b.rs')).toBe(false)
  })

  /** **边沿触发**:越界 4 次记 4 条。指纹方案只看得见第 1 次,这正是它被否掉的理由之一。 */
  it('同一条路径被点名多次 → claims 记多条,size 只算一条', () => {
    const r = createEscapeRegistry()
    for (let i = 0; i < 4; i++) r.note(c('/repo/pkg/a.rs'))
    expect(r.claims()).toHaveLength(4)
    expect(r.size()).toBe(1)
  })

  it('结尾斜杠/重复斜杠归一之后仍然认得出', () => {
    const r = createEscapeRegistry()
    r.note(c('/repo//pkg/a.rs'))
    expect(r.owns('/repo/pkg/a.rs')).toBe(true)
  })

  it('空登记簿:owns 恒假(默认不动用户的工作区)', () => {
    expect(createEscapeRegistry().owns('/repo/pkg/a.rs')).toBe(false)
  })
})
