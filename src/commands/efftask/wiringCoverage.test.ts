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
import { nonExecuteToolPool, verifyToolPool } from './efftask.js'

const SRC = readFileSync(new URL('./efftask.tsx', import.meta.url), 'utf8')
/** 关口组件自己的源码 —— 编辑器接线在这里,不在 efftask.tsx。 */
const GATE_SRC = readFileSync(new URL('./ConfirmStartup.tsx', import.meta.url), 'utf8')

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

/** 出现次数。同一行字在这个文件里往往有两处(新建/恢复、初次/重试),只查存在会被
 * 另一处满足,剪断任意一处都不红 —— 实测过。 */
function occurrences(needle: string): number {
  return SRC.split(needle).length - 1
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
    expect(SRC).toMatch(/applyRosterToNodes\(seed \?\? nodes,\s*effectiveConfig\.phaseRoles\)/)
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

  it('名册只在真被改过时才写回节点', () => {
    // 剪断这个条件:run.md 损坏时 readRunManifest 回退成 emptyPhaseRoles(),无条件写回就会
    // 把每个 node.md 里还活着、还会被派发的角色全部清成主模型 —— 而 node.md 才是那时候
    // 幸存的真相。同时它还会抹掉 §4.2 的 per-node 名册覆写,哪怕用户什么都没改、直接回车。
    expect(SRC).toContain('if (!rosterEquals(effectiveConfig.phaseRoles, config.phaseRoles)) {')
  })

  it('git init 只在"根本不是 git 仓库"时才提供 (spec §8)', () => {
    // 剪断它:任何一种池初始化失败都会亮出 g 键,而除 notARepo 外的每一种失败都发生在
    // "目录确实是仓库"之后 —— 在子目录里 git init 会造出一个**遮蔽父仓库**的嵌套仓库,
    // 一次按键、无确认、无撤销,代码里也没有任何地方会清理它。真机验证过。
    // COUNTED, not merely present: the same line appears twice (the initial pool build and
    // initGitAndRetry's re-build), so `toContain` was satisfied by the other one and cutting
    // either left the gate green — measured. Same trap as three identically-worded filters in
    // one file earlier this session.
    expect(occurrences('setCanInitGit(iso.pool ? false : iso.notARepo === true)')).toBe(2)
    expect(SRC).toContain('onInitGit={canInitGit ?')
  })

  it('未隔离这件事也要写进 run.md(新建和恢复两条路径都要)', () => {
    // 剪断它:新建 run 的 run.md 不再记录"本次未隔离",而恢复路径还在记 —— 同一件事在
    // 两条路径上的持久化记录不一致。同样必须计数:两条路径的这行字是逐字相同的。
    expect(occurrences('notices.push(`隔离不可用,执行阶段将共享工作目录并串行')).toBe(2)
  })

  it('启动关口拿到了隔离不可用的原因和 git init 入口 (spec §8)', () => {
    // 剪断它:降级回到"自动发生 + 一行埋在解析提醒里",§8 的「允许选择」又变成
    // 接受或取消两条路。
    expect(element('ConfirmStartup')).toContain('isolationReason={')
    expect(element('ConfirmStartup')).toContain('onInitGit={')
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

describe('角色定义的接线', () => {
  it('settings.json 里的角色定义真的被读进来了', () => {
    // 剪断它:配置文件里配好的角色一条都到不了 —— 而「在配置文件里面可以配置指定」
    // 正是这个特性被要求的两条录入路径之一。没有运行时接缝能发现这一刀。
    expect(element('EffTaskRunner')).toContain('baseRoleDefs={')
    expect(SRC).toContain('collectRoleDefs({')
  })

  it('读进来的角色定义传给了 parseDirectives —— 两条调用路径都要传', () => {
    // parseDirectives 在这里被调两次:正常一次、抽取失败兜底一次。只在正常那次传,
    // 抽取失败(最常走到的退化路径)就会静默丢掉全部配置文件角色。
    expect(occurrences('baseRoleDefs, modelJson: extractJson')).toBe(1)
    expect(occurrences('unsupportedRoles, baseRoleDefs }')).toBe(1)
  })

  it('baseRoleDefs 在 effect 依赖里 —— 否则它变了也不会重新解析', () => {
    // 钉整串依赖的字面量会让「往数组里再加一项」变成一次假红。改成逐项断言:
    // 每个进解析的 prop 都必须在依赖里,加新 prop 时这条会诚实地要求你也加进去。
    const deps = SRC.match(/\}, \[args, knownRoles[^\]]*\]\)/)?.[0] ?? ''
    for (const d of ['baseRoleDefs', 'baseRoleNotices', 'baseSkipSteps', 'extractJson', 'agentModels', 'mainModel']) {
      expect(`${d} 在依赖里: ${deps.includes(d)}`).toBe(`${d} 在依赖里: true`)
    }
  })

  it('配置文件那条录入口的诊断被接住并并进 notices', () => {
    // 剪断它:员工名打错一个字 → 关口显示「架构师←主模型」,看起来像「我配的就是主模型
    // 兼任」,而解释这件事的那句话被丢了。同样的错写在提示词里则会正常显示 —— 两条录入口
    // 不对称,而这一条是静默的那一条。
    // 两条录入口的诊断都要接住:角色定义的,和跳过环节的。
    const el = element('EffTaskRunner')
    expect(el).toContain('baseRoleNotices={[...collectedRoles.notices, ...collectedSkip.notices]}')
    expect(SRC).toContain('cfg.notices.unshift(...baseRoleNotices)')
  })
})

describe('收口关口的接线(spec §8)', () => {
  it('恢复路径在「没有可恢复的节点」之前就检查待收口', () => {
    // 顺序是全部:一个跑完的 run 根节点已 ACCEPTED,reseat 一个节点也捞不回来,
    // 所以那句 fatal 会先触发,用户永远到不了收口关口,集成分支永远没人处置。
    const idxCheck = SRC.indexOf('recovered.pendingHandoff')
    const idxFatal = SRC.indexOf('里没有可恢复的节点')
    expect(idxCheck).toBeGreaterThan(0)
    expect(idxFatal).toBeGreaterThan(0)
    expect(idxCheck).toBeLessThan(idxFatal)
  })

  it('收口关口真的被渲染,而且不被 !config 吞掉', () => {
    // 剪断它:待收口状态读出来了、phase 也切了,而屏幕上什么都没有。
    expect(SRC).toContain("phase === 'handoff' && pendingHandoff")
    expect(element('ConfirmHandoff')).toContain('handoff={pendingHandoff}')
    // 收口不需要 config,而 `phase === 'parsing' || !config` 那条分支会拦住它。
    expect(SRC.indexOf("phase === 'handoff'")).toBeLessThan(SRC.indexOf("phase === 'parsing' || !config"))
  })

  it('选择真的会去跑 git,而不是只切个界面', () => {
    expect(SRC).toContain('runHandoffChoice(choice, h, gitRunner, getCwd())')
  })

  it('成功之后把待收口从 run.md 划掉,失败则留着', () => {
    // 不划掉:下次 --resume 会为一条已经合并/推送/删掉的分支再弹一次四选一,
    // 而「丢弃」会对着一条不存在的分支报错。
    // 失败还划掉:用户就再也回不到这个关口了,而他刚被告知失败了什么。
    expect(SRC).toContain('if (result.ok) {')
    expect(SRC).toContain('pendingHandoff: undefined')
  })

  it('收口结果显示在 done 视图上', () => {
    // 合并冲突之后安静地回到 done,用户会以为成功了 —— 而代码根本不在他的分支上。
    expect(element('DoneView')).toContain('handoffResult={handoffResult}')
    expect(SRC).toContain('props.handoffResult')
  })
})

describe('测试验证的工具池接线', () => {
  it('verifyTools 真的传给了 runAgent 适配器', () => {
    // 剪断它:验证者静默退回只读工具、跑不了任何命令,而这个环节的**全部存在理由**就是
    // 「能真的把测试跑起来」。实测过:删掉这一行,全套测试一条都不红。
    expect(SRC).toContain('verifyTools: verifyToolPool(context.options.tools)')
  })
})

describe('环节跳过的接线', () => {
  it('跳过分析时整个关掉第三关', () => {
    // 剪断它:白付一次 plan 调用,而且 stepStart 的守卫会把用户在这一关批准的首层任务树
    // 整个丢掉 —— 关口显示 5 个子任务,用户回车,运行建出 0 个。
    //
    // 这条断言原先钉的是 `setPhase('running')`,而那正是 bug 本身:runOrchestrator 在整个
    // 文件里只有 startRun 一个调用点,setPhase 只翻界面不启动编排器,run 永远停在
    // 「✓0 ◐0 ○0 ✗0」。把 bug 钉进闸门之后,改对反而变红。所以这里断的是**必须经过
    // startRun**,并显式挡住只翻界面的写法。
    const line = SRC.split('\n').find(l => l.includes("skipSteps ?? []).includes('plan')")) ?? ''
    expect(`跳过分析这一行: ${line.trim()}`).toBe("跳过分析这一行: if ((config?.skipSteps ?? []).includes('plan')) { startRun(approved); return }")
  })

  it('关口编辑器拿得到被跳过的环节', () => {
    // 拿不到的话,被跳过那一行照常显示复选框,用户勾了人什么都不会发生。
    // 注意读的是 ConfirmStartup.tsx —— 本文件顶部的 SRC 是 efftask.tsx。
    expect(GATE_SRC).toContain('rosterEditorLines(roster, available, phaseIdx, roleIdx, undefined, skipRef.current)')
  })

  it('给被跳过的环节勾人 = 取消跳过', () => {
    expect(GATE_SRC).toContain('if (skipRef.current.includes(ph)) setSkip(skipRef.current.filter(x => x !== ph))')
  })
})

describe('组件里不许出现只存在于 call() 作用域的绑定', () => {
  it('EffTaskRunner 内部的 effRoot 一律是 props.effRoot', () => {
    // `const effRoot` 声明在 call() 里(:134),组件里没有这个绑定。裸写它有两种死法:
    //  - 写在依赖数组里 → 依赖数组每次 render 都求值 → 第一次渲染就抛 ReferenceError,
    //    /et 输入任何内容都只得到一屏堆栈,一次模型调用都没有;
    //  - 写在 try/catch 里 → **静默失败**:收口明明成功了,pendingHandoff 却永远划不掉,
    //    下次 --resume 会为一条已经合并/推送/删掉的分支再弹一次四选一。
    // 两种都发生过,而且第二种在全量测试下完全无声。这条闸门查的是词法作用域本身,
    // 比逐个补行为测试更贴近真正的失败原因。
    const body = SRC.slice(SRC.indexOf('function EffTaskRunner(props: RunnerProps)'))
    const bare = body.split('\n')
      .map((l, i) => ({ n: i, l }))
      .filter(({ l }) => /(?<!props\.)(?<!\.)\beffRoot\b/.test(l) && !l.trimStart().startsWith('//'))
    expect(`组件里裸写 effRoot 的行: ${bare.map(b => b.l.trim()).join(' | ') || '无'}`)
      .toBe('组件里裸写 effRoot 的行: 无')
  })
})

describe('工具档位:非执行环节要拿得到 MCP,但拿不到写工具', () => {
  // 旧实现是白名单 `{Read, Glob, Grep}`,于是**所有 mcp__* 连带被滤掉** —— 用户配了
  // 查文档/查数据库的 MCP,以为评审员能用,实际只有执行者能用;起草者也只能靠三个
  // 工具摸黑,复杂仓库里经常直接回「访问不了文件系统,请你贴代码」。
  const pool = [
    { name: 'Read' }, { name: 'Glob' }, { name: 'Grep' },
    { name: 'Edit' }, { name: 'Write' }, { name: 'NotebookEdit' }, { name: 'Bash' },
    { name: 'mcp__docs__search' }, { name: 'mcp__db__query' }, { name: 'TodoWrite' },
  ]

  it('非执行档:MCP 留下,四个写工具全部拿掉', () => {
    const names = nonExecuteToolPool(pool).map(t => t.name)
    expect(names).toContain('mcp__docs__search')
    expect(names).toContain('mcp__db__query')
    expect(names).toContain('Read')
    for (const w of ['Edit', 'Write', 'NotebookEdit', 'Bash']) {
      expect(`${w} 漏进非执行档: ${names.includes(w)}`).toBe(`${w} 漏进非执行档: false`)
    }
  })

  it('测试验证档 = 非执行档 + 跑命令的能力', () => {
    const names = verifyToolPool(pool).map(t => t.name)
    expect(names).toContain('Bash')                 // 它得真的把测试跑起来
    expect(names).toContain('mcp__db__query')       // MCP 同样留着
    for (const w of ['Edit', 'Write', 'NotebookEdit']) {
      expect(`${w} 漏进测试验证档: ${names.includes(w)}`).toBe(`${w} 漏进测试验证档: false`)
    }
  })

  it('非执行档不是白名单 —— 没见过的工具默认留下', () => {
    // 这条区分「减去写工具」和「只放行三件套」两种实现:后者会把任何新工具静默丢掉,
    // 而 MCP 工具的名字是用户装什么就叫什么,枚举不完。
    const names = nonExecuteToolPool([{ name: '某个以后才有的只读工具' }]).map(t => t.name)
    expect(names).toEqual(['某个以后才有的只读工具'])
  })

  it('生产接线用的就是这个函数', () => {
    expect(SRC).toContain('const readOnlyTools: Tools = nonExecuteToolPool(context.options.tools)')
    expect(SRC).toContain('verifyTools: verifyToolPool(context.options.tools)')
    // 执行档必须还是全量 —— 少给了执行者就改不了代码。
    expect(SRC).toContain('availableTools: context.options.tools, // execute phase only')
  })
})
