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
    expect(SRC).toMatch(/<RunningView[^>]*\bstreams=\{streams\.current\}/)
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
    // 锚点不再钉 `modelJson: extractJson` 的字面量:抽取那一次现在还要把自己的实时窗口
    // 递进去(那一屏是用户敲完 /et 看到的第一屏,背后跑着一次真实模型调用)。钉住的是
    // 「正常那条路径确实带了 baseRoleDefs 且确实传了 modelJson」。
    expect(occurrences('baseRoleDefs, modelJson:')).toBe(1)
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

/**
 * 实时窗口的每一跳 (spec 2026-07-27)。
 *
 * 这个特性的数据流有**五跳**:efftask.tsx → runOrchestrator → orchestrator → PipelineCtx →
 * 调用点。orchestrator.ts 自己的注释记着,前两个走这条路的回调(onEscalate、onBlocked)
 * 各自在 PipelineCtx 和 runOrchestrator 上都声明了、却漏在中间那一跳,于是在**每一次真实
 * 运行里都是死的**,而它们的单元测试全绿地跨过了那道断口。这个仓库没有 typecheck,漏一跳
 * 不会报错,只会全空。
 */
describe('子 agent 实时窗口:五跳都要接上', () => {
  const ORCH = readFileSync(new URL('../../tools/efftask/orchestrator.ts', import.meta.url), 'utf8')
  const RUNNER = readFileSync(new URL('./runOrchestrator.ts', import.meta.url), 'utf8')
  const PIPE = readFileSync(new URL('../../tools/efftask/pipeline.ts', import.meta.url), 'utf8')
  const ADAPTER = readFileSync(new URL('../../tools/efftask/runAgentAdapter.ts', import.meta.url), 'utf8')

  it('efftask.tsx 建了 store 并把 openStream 交给编排器', () => {
    expect(SRC).toContain('createStreamStore()')
    expect(SRC).toContain('openStream: meta => streams.current.open(meta)')
  })

  it('runOrchestrator 那一跳 —— 上两个特性就是漏在这一层的邻居', () => {
    expect(`runOrchestrator 声明了: ${RUNNER.includes("openStream?: PipelineCtx['openStream']")}`)
      .toBe('runOrchestrator 声明了: true')
    expect(`runOrchestrator 透传了: ${RUNNER.includes('openStream: args.openStream')}`)
      .toBe('runOrchestrator 透传了: true')
  })

  it('orchestrator 那一跳', () => {
    expect(`orchestrator 声明了: ${ORCH.includes("openStream?: PipelineCtx['openStream']")}`)
      .toBe('orchestrator 声明了: true')
    expect(`orchestrator 透传了: ${ORCH.includes('openStream: this.deps.openStream')}`)
      .toBe('orchestrator 透传了: true')
  })

  it('runPhase 的每一个调用点都自报环节名和署名', () => {
    // 分析圆桌 N 席、方案融合席、方案精化 N 席、观察评分 N 席全都走 runPhase,不走圆桌。
    // 少给一个署名,这些席位就退回「几个人的话并成一坨、看不出谁说的」——正是要治的病。
    const calls = PIPE.split('runPhase(ctx,').length - 1
    expect(`runPhase 调用点: ${calls}`).toBe('runPhase 调用点: 6')
    // 每一处都得带 phaseLabel;数量对不上说明有人加了调用点却没给窗口。
    const labeled = PIPE.split('phaseLabel:').length - 1
    expect(`带 phaseLabel 的位置: ${labeled >= 7}`).toBe('带 phaseLabel 的位置: true')
    for (const one of ['解决合并冲突', '方案融合', '方案精化']) {
      expect(`${one} 有自己的表头: ${PIPE.includes(`'${one}'`)}`).toBe(`${one} 有自己的表头: true`)
    }
  })

  it('集成验收不套用「验收」的表头', () => {
    // 它走的是 phase:'accept'(只有 system 是 'integrate')。按 phase 取名会把整个 run 的
    // 最终裁决标成「验收」,和 node.md 里分开记的两份记录对不上。
    expect(`集成验收显式给了表头: ${PIPE.includes('phaseLabel: PHASE_LABEL.integrate')}`)
      .toBe('集成验收显式给了表头: true')
  })

  it('收口在 adapter 的 finally —— 唯一一个所有模型调用必经的点', () => {
    // 放在圆桌里的话,走 runPhase 的六处加根方案全都不会收口:表头永远停在「运行中」,
    // 而且这些流永远不进可淘汰集合,内存上限对它们直接失效。
    const fin = ADAPTER.slice(ADAPTER.lastIndexOf('} finally {'))
    expect(`finally 里收口: ${fin.includes('req.stream?.end(')}`).toBe('finally 里收口: true')
    // 已中断的早退路径绕过 finally,它得自己收。
    expect(`早退路径也收口: ${ADAPTER.includes("req.stream?.end('已中断')")}`).toBe('早退路径也收口: true')
  })

  it('树外那两次模型调用也有窗口 —— 「每一次模型调用」不能少算它们', () => {
    // 「正在解析需求…」是用户敲完 /et 看到的第一屏;「正在起草根方案…」是整个运行里最长的
    // 单次调用之一。两者背后都是真实模型调用,此前都是纯黑屏。
    expect(SRC).toContain("phaseLabel: '需求解析'")
    expect(SRC).toContain("phaseLabel: '根方案'")
    expect(SRC).toContain('<ParsingView onCancel={bail} log={preStreams()}')
    expect(SRC).toContain('log={preStreams()}')
    // 宽度要用真实列宽,不是写死的 100:80 列终端上表头右半段(运行中/工具数/耗时)
    // 会被整段切掉,而 justify 放不下时退化成 left + ' ' + right、truncate-end 从右边吃。
    expect(SRC).not.toContain('width={100}')
    expect(SRC).toContain('columns={termColumns}')
  })

  it('resume 回来的节点被标成历史 —— 空窗口 ≠ 什么都没干', () => {
    expect(SRC).toContain('streams.current.markHistorical(')
  })

  it('工具摘要接到了工具自己的 userFacingName', () => {
    expect(SRC).toContain('briefResolver:')
    expect(SRC).toContain('userFacingName')
  })
})

describe('等待屏的窗口要真的会动', () => {
  it('parsing / drafting 两屏自己订阅事件流', () => {
    // store 是 useRef —— 没有订阅就没有重绘。而这两屏根本没有任务树,TaskTreePanel 里
    // 那个 useStreamTick 一次都不会跑:窗口渲染一次空白,然后到调用结束都不动。
    // 「挂上去了但它是死的」正是这个文件存在的理由。
    expect(SRC).toContain('useStreamTick(streams.current')
    expect(SRC).toMatch(/useStreamTick\(streams\.current,[^)]*'parsing'/)
    expect(SRC).toMatch(/useStreamTick\(streams\.current,[^)]*'drafting'/)
  })
})

describe('席位署名的取值必须短路(六个调用点)', () => {
  it('pipeline 里没有一处用 ?? 兜「主模型」', () => {
    // MAIN_STAFF 是空串,而空串是 truthy 对象上的 falsy 字段。`??` 只挡 null/undefined,
    // 于是表头渲染成 `▾ 分析 ·  (opus)` —— 「没有署名」正是这次要治的病。
    // 六个 runPhase 调用点各写了一遍,逐个测太笨;这条闸门盯的是「有没有人写错成 ??」。
    const PIPE = readFileSync(new URL('../../tools/efftask/pipeline.ts', import.meta.url), 'utf8')
    expect(`用了 ?? 的地方: ${PIPE.includes("?? '主模型'")}`).toBe('用了 ?? 的地方: false')
    // 而且六处都真的给了署名
    expect((PIPE.match(/\|\| '主模型'/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })
})

/**
 * 验收实测「改回去也全绿」的四处。
 *
 * 这四条都是**行为正确、但零防线** —— 变异测试把它们逐个改回旧行为,1667 条全绿。
 * 这个文件存在的理由就是这类:代码是活的,拦不住有人把它改死。
 */
describe('改回去要变红的四处', () => {
  it('等待屏的窗口是可交互的 —— 改回 isActive={false} 就是用户抱怨的「不能滚」', () => {
    // 两处:drafting 的 MessageView 和 ParsingView。
    const active = SRC.match(/<AgentLogPane[^>]*isActive(?!=\{false\})/g) ?? []
    expect(`可交互的等待屏窗口: ${active.length}`).toBe('可交互的等待屏窗口: 2')
    expect(SRC).not.toContain('isActive={false}')
  })

  it('「已等待」的心跳真的在改状态,不是一个空回调', () => {
    // 现有那条断言是 /已等待\s*\d+s/ —— 秒数冻死在 0 也照样匹配。
    expect(SRC).toContain('setInterval(() => setWaitNow(Date.now()), 1000)')
    expect(SRC).toContain('const waitedSec = Math.max(0, Math.round((waitNow - waitStart) / 1000))')
  })

  it('cwd 真的交给了 draftRootPlan —— 单测只测到 planPrompt 内部那一半', () => {
    // planPrompt 里去掉 cwd 会被单测杀掉,但**接线**没人守:这正是这个文件开篇
    // 列的「函数写好了但生产上零调用点」的形状。
    const draft = SRC.slice(SRC.indexOf('await draftRootPlan({'))
    expect(`draftRootPlan 拿到了 cwd: ${draft.slice(0, 400).includes('cwd: getCwd()')}`)
      .toBe('draftRootPlan 拿到了 cwd: true')
  })

  it('重做关口挂在渲染树上 —— 否则按 r 之后什么都不会发生', () => {
    // 这一跳没有运行时接缝:setPhase('confirmRedo') 之后能不能渲染出关口,取决于
    // EffTaskRunner 的 JSX 里有没有这个分支,而这个组件挂不起来。剪断它的形状是
    // 「按 r → 界面纹丝不动」,而全套测试照绿。
    expect(SRC).toContain("phase === 'confirmRedo' && redoTarget")
    expect(element('ConfirmRedo')).toContain('onConfirm={entry => applyRedo(redoTarget, entry)}')
  })

  it('重做真的会重新启动编排 —— 不然它只是改了改树', () => {
    // startRun 是这个文件里 runOrchestrator 的**唯一**调用点。applyRedo 里少了这一行,
    // 用户按完确认会看到树变了、节点退回排队中,然后永远停在那儿:
    // 「run 004 ✓0 ◐0 ○0 ✗0」不动、没有报错、也不退出 —— 这个文件已经栽过一次的形状。
    const body = SRC.slice(SRC.indexOf('const applyRedo = React.useCallback'))
    expect(body.slice(0, 3000)).toContain('startRun(cfg, computed.nodes)')
  })

  it('重做的落盘走 commitRedo —— 顺序由那个模块的真测试守', () => {
    // 顺序本身**不在这里**测:源码文本闸门证明不了可达性(实测把删子树那段停用,
    // 文本还在、顺序还对,闸门照绿)。这里只守这一跳没被剪断,顺序归 redoCommit.test.ts。
    const body = SRC.slice(SRC.indexOf('const applyRedo = React.useCallback'))
    expect(body.slice(0, 2000)).toContain('await commitRedo(')
  })

  it('中断过的 run 按 r 会被挡住并说明下一步', () => {
    // 中断标记对整个 /et 进程有效且无法撤销。不挡的话用户会看到同一屏「已中断」,
    // 一次模型调用都没发生,也没有任何东西解释为什么。
    expect(SRC).toContain('redoUnavailableReason({ aborted: props.signal.aborted')
  })

  it('只查看模式不给重做入口', () => {
    // 那个 run 的编排器根本没起来过。给了重做就是**替用户决定**把它跑起来,
    // 而他刚刚明确选了不跑。
    expect(SRC).toContain('onRedo={viewOnly ? undefined :')
  })

  it('树外那几条流是钉住的 —— 否则它们是第一批被淘汰的', () => {
    // 它们挂在 root 上,而且是 root 上最老的三条;淘汰按插入顺序压最旧的已收口流。
    // 把它们挂到 root 的理由正是「事后最想回看」。
    expect((SRC.match(/pinned: true/g) ?? []).length).toBe(3)
  })
})
