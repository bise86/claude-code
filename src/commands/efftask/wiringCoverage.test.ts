/**
 * 结构闸门:efftask.tsx 里那些没有运行时接缝的接线。
 *
 * 这个文件本身的注释写着:「the last two features wired in this file were dead in production
 * while every test passed over the severed wire」。验收评审证明它又发生了一次 —— 删掉
 * `nodes={nodes}` 或 `worktrees: poolRef.current`,两个特性在生产里彻底死掉,而全套测试
 * 一条都不红。
 *
 * 为什么只能这么测:这两处赋值在 `EffTaskRunner` 的 JSX 里,而它没有导出,也无法在测试里
 * 挂载 —— 它要 app state store、真实 fs、runAgent 接缝、AbortController 中继,并且在
 * useEffect 链里驱动整个 run。测试能拿到的只有 `call`、`RunningView`、`DoneView`。
 *
 * **这条闸门证明的是"那行字还在",不是"它行为正确"。** 组件级的行为由
 * resumeView.test.tsx / rootPlan.test.ts 各自钉住(关口拿到 nodes 会渲染树、起草拿到
 * worktrees 会带上 §16 的告知);这里补的是中间那一跳 —— 而那一跳恰恰是这个文件反复
 * 剪断的地方。同样的手法在 backgroundTaskCoverage.test.tsx 里已经用过一次,理由相同。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./efftask.tsx', import.meta.url), 'utf8')

/**
 * The text of ONE JSX element, start tag to its own `/>`.
 *
 * Not a regex over the whole file. A first version used
 * `/<ConfirmResume[\s\S]*?availableRoles=…/` and it was a FALSE PASS: the lazy match walks
 * straight past ConfirmResume's own `/>` and finds ConfirmStartup's `availableRoles` further
 * down, so deleting the prop from ConfirmResume left the gate green. (A fixed-width window
 * avoided that but broke the other way — measured 381 chars against a 400 budget, so one added
 * comment line would have made a healthy wire fail.) Slicing the element is exact.
 */
function element(name: string): string {
  const from = SRC.indexOf(`<${name}`)
  if (from < 0) return ''
  const to = SRC.indexOf('/>', from)
  return to < 0 ? '' : SRC.slice(from, to + 2)
}

describe('efftask.tsx 的接线不能被静默剪断', () => {
  it('恢复关口拿到了恢复出来的任务树 (spec §17.3)', () => {
    // 剪断它:关口退回"只有计数",用户批准的是一个自己看不见形状的 run。
    expect(element('ConfirmResume')).toContain('nodes={nodes}')
  })

  it('恢复关口拿到了可编辑的角色名册 (spec §17.3)', () => {
    // 剪断它:关口的 `r` 键进得去编辑器,但里面一个候选角色都没有 —— §17.3 的"名册可改"
    // 退回成一句空话,而它要解决的正是"盘上记的角色本会话已不存在、会被静默降级"。
    expect(element('ConfirmResume')).toContain('availableRoles={dispatchableRoles(')
    expect(element('ConfirmResume')).toContain('roleModel={')
  })

  it('关口改出来的名册被写回了节点 (spec §17.3)', () => {
    // 剪断它:编辑器可以按、可以看、可以确认,还会被写进 run.md —— 然后被整条执行管道
    // 完全无视,因为派发只读 node.phaseRoles。而 run.md 会开始说谎:它记着一份没有任何
    // 节点在用的名册,下一次 --resume 又把它读回来展示给用户。
    expect(SRC).toMatch(/applyRosterToNodes\(nodes,\s*effectiveConfig\.phaseRoles\)/)
  })

  it('恢复关口的编辑会通知调用方 (飞书竞速的丢弃提示)', () => {
    // 剪断它:飞书赢了竞速时终端的编辑被静默丢弃,而那条"你的修改没有生效"的提示
    // 在恢复路径上变回死代码。
    expect(element('ConfirmResume')).toContain('onEdited={')
  })

  it('切片函数确实只切到本元素为止', () => {
    // 这条守的是上面几条断言的**匹配器本身**。ConfirmStartup 也有 availableRoles /
    // roleModel / onEdited,所以一个越界的匹配器会让"剪断 ConfirmResume 的那三个 prop"
    // 照样全绿 —— 第一版正是这样,验收之后才发现。
    const el = element('ConfirmResume')
    expect(el.startsWith('<ConfirmResume')).toBe(true)
    expect(el.endsWith('/>')).toBe(true)
    expect(el).not.toContain('<ConfirmStartup')
  })

  it('第三关起草拿到了隔离池 (spec §16)', () => {
    // 剪断它:关口上给用户看的那棵树是在**没有**冲突约束的情况下拆出来的,而 run 随后按
    // 有约束的规则跑 —— 用户批准的拆分和实际执行的规则不是一回事。
    expect(SRC).toMatch(/draftRootPlan\(\{[^}]*worktrees:\s*poolRef\.current/)
  })

  it('运行中的面板拿到了输出缓冲和并行占用 (spec §10.1 / §10.2)', () => {
    // 这两条是 efftask.tsx 历史上真的被剪断过的线,注释里点名的"上两个特性"。
    expect(SRC).toMatch(/<RunningView[^>]*\bchunks=\{chunks\.current\}/)
    expect(SRC).toMatch(/<RunningView[^>]*\bpool=\{/)
  })

})
