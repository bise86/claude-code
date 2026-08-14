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
import { subAgentToolPool } from './efftask.js'

const SRC = readFileSync(new URL('./efftask.tsx', import.meta.url), 'utf8')
/** 详情页的按需读回住在树面板里 —— 这一跳断了,盘上的历史永远没人去读。 */
const TREE = readFileSync(new URL('./TaskTreePanel.tsx', import.meta.url), 'utf8')
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
    // 现在两种情况都给 g,但**补救动作不同**:notARepo 在 cwd 上 git init;
    // 「是仓库但没提交」只在**仓库根**上补空提交,绝不 init —— 用户可能站在子目录里,
    // 在那儿 init 会造出遮蔽父仓库的嵌套仓库(一次按键、无确认、无撤销)。
    expect(occurrences('setCanInitGit(iso.pool ? false : (iso.notARepo === true || iso.needsFirstCommit === true))')).toBe(2)
    expect(occurrences('firstCommitRoot.current = iso.needsFirstCommit === true ? (iso.gitRoot ?? null) : null')).toBe(2)
    // 跳过 init 的那道守卫是这条不变量的**唯一**执行点。
    expect(SRC).toContain('if (firstCommitRoot.current === null) {')
    expect(SRC).toContain("const cwd = firstCommitRoot.current ?? getCwd()")
    expect(SRC).toContain('onInitGit={canInitGit ?')
  })

  it('未隔离这件事也要写进 run.md(新建和恢复两条路径都要)', () => {
    // 剪断它:新建 run 的 run.md 不再记录"本次未隔离",而恢复路径还在记 —— 同一件事在
    // 两条路径上的持久化记录不一致。同样必须计数:两条路径的这行字是逐字相同的。
    // 措辞住在 `ISOLATION_DEGRADE_PREFIX` 里(startupConfirm.ts),两侧共用一份:
    // `applyStartupDecision` 关口之后要按前缀认出这两句并改写成真正选中的那一档 ——
    // 命令层这里自己拼一份字符串的话,认不出来,run.md 里就会留下一句和 `isolation:`
    // 字段矛盾的话(实测:一句说串行、字段写 shared-parallel,而真相是后者)。
    expect(occurrences('notices.push(`${ISOLATION_DEGRADE_PREFIX}${')).toBe(2)
  })

  /**
   * **池子放不放下,走的是 `poolDisposition` 那一份判据,不是命令层自己写的比较。**
   *
   * 这三行出过一次真回归:裸写 `effectiveConfig.isolation !== 'worktree'` 把 `undefined`
   * (默认档)判成了「放下池子」,于是每一次 --resume 和每一次飞书批准都静默丢掉隔离 ——
   * 而那两条路送来的决策本来就不带这个字段。这个文件挂不起组件,所以钉源码。
   */
  it('关口批准之后的池子处置走的是那一份判据 (需求1)', () => {
    expect(SRC).toContain('const disposition = poolDisposition(effectiveConfig)')
    expect(SRC).toContain('if (!disposition.keepPool) {')
    expect(SRC).toContain('sharedParallelRef.current = disposition.sharedParallel')
    // 反向:任何一处再拿 config.isolation 裸比较,就是那次回归本身。
    // 这条断言自己被验过一次:`\\s` 的反斜杠丢掉的话,它只拦得住不写空格的写法,
    // 而回归本身写的是 `effectiveConfig.isolation !== 'worktree'`(带空格)—— 照样放行。
    expect(SRC).not.toMatch(/effectiveConfig\.isolation\s*[!=]==\s*'/)
  })

  it('启动关口拿到了隔离不可用的原因和 git init 入口 (spec §8)', () => {
    // 剪断它:降级回到"自动发生 + 一行埋在解析提醒里",§8 的「允许选择」又变成
    // 接受或取消两条路。
    expect(element('ConfirmStartup')).toContain('isolationReason={')
    expect(element('ConfirmStartup')).toContain('onInitGit={')
  })
  /**
   * **「这一趟是串行的」必须从池子这一个真相流到每一处口径。**
   *
   * 剪断任何一处的后果都是同一种谎:关口对着一个排在单线队列后面的节点说
   * 「本任务的依赖现在全部满足,马上就会被调度」。跑机(qianbase-xtp run 001)上
   * `parallelism: 20`、44 个 READY、恒 1 席在飞,用户报的就是这一句。
   *
   * 判据一律用 `poolRef.current === undefined`,和 orchestrator 的
   * `serialiseExecute = kind === 'execute' && this.deps.worktrees === undefined` 同源 ——
   * **不用配置里的 isolation**:配置可以写着「隔离」而每一次 acquire 都失败。
   */
  it('执行串行这件事流到了重算关口和「马上就会被调度」那一句', () => {
    // 三个 recalcScope 入口(关口自己的 scopeOpts、树上的 recalcAvailable、按 d 那一下)
    // 加上 schedulableNow —— 少一个都会让屏幕上写着的和按下去发生的分叉。
    expect(occurrences('serialExecute: poolRef.current === undefined && !sharedParallelRef.current')).toBe(4)
    // 表头那一行是同一个真相的另一个出口(它早就在了,一起钉住:两处说法必须同源)。
    expect(SRC).toContain('serialExecute={poolRef.current === undefined && !sharedParallelRef.current}')
    // 第三档在表头上的那个标记同样要接到运行视图 —— 它和上面那个是两件事(一个说慢,
    // 一个说没安全网),而这一档整趟跑下来此前一个字都没有。
    expect(element('RunningView')).toContain('sharedParallel={sharedParallelRef.current}')
    expect(SRC).toContain('sharedParallel={props.sharedParallel}')
    /**
     * **第三档必须出现在这五处的每一处。**
     *
     * 「没有池子」曾经等价于「必须串行」—— 第三档(共享目录 + 用户显式按 w 选并发)
     * 把这个等价拆开了。漏掉任何一处,屏幕上写着「执行阶段串行」而 orchestrator 正在
     * 并发跑,或者关口把一堆 READY 说成「排队等前一个」而它们其实马上一起飞。
     * 判据一律读 `sharedParallelRef`(同步写下的 ref),不读 config —— 和
     * orchestrator 的 `deps.sharedParallel` 同源。
     */
    // 6 = 四处重算/调度 + 运行视图表头 + 结束屏表头。结束屏是用户看得最久的一屏
    // (跑完停在这儿翻树),而「刚才那一趟到底有没有隔离」正是他在这儿决定要不要按
    // `m` / `c` 时要知道的事。
    expect(occurrences('poolRef.current === undefined && !sharedParallelRef.current')).toBe(6)
    expect(element('DoneView')).toContain('sharedParallel={sharedParallelRef.current}')
    // 两处转发:运行视图的包装层、结束屏里的那棵树。少一处 = 标记在那一屏上没了,
    // 而两屏的 props 都收到了值 —— 这种断线在类型上完全合法。
    expect(occurrences('sharedParallel={props.sharedParallel}')).toBe(2)
    // 反向:任何一处只写「没有池子」就算漏(第三档会被它当成串行)。
    expect(SRC).not.toMatch(/poolRef\.current === undefined(?!\s*&&\s*!sharedParallelRef)/)
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
    expect(occurrences('baseRoleDefs, baseCaps, modelJson:')).toBe(1)
    expect(occurrences('unsupportedRoles, baseRoleDefs, baseCaps }')).toBe(1)
  })

  it('baseRoleDefs 在 effect 依赖里 —— 否则它变了也不会重新解析', () => {
    // 钉整串依赖的字面量会让「往数组里再加一项」变成一次假红。改成逐项断言:
    // 每个进解析的 prop 都必须在依赖里,加新 prop 时这条会诚实地要求你也加进去。
    const deps = SRC.match(/\}, \[args, knownRoles[^\]]*\]\)/)?.[0] ?? ''
    for (const d of ['baseRoleDefs', 'baseCaps', 'baseRoleNotices', 'baseSkipSteps', 'extractJson', 'agentModels', 'mainModel']) {
      expect(`${d} 在依赖里: ${deps.includes(d)}`).toBe(`${d} 在依赖里: true`)
    }
  })

  it('配置文件那条录入口的诊断被接住并并进 notices', () => {
    // 剪断它:员工名打错一个字 → 关口显示「架构师←主模型」,看起来像「我配的就是主模型
    // 兼任」,而解释这件事的那句话被丢了。同样的错写在提示词里则会正常显示 —— 两条录入口
    // 不对称,而这一条是静默的那一条。
    // 两条录入口的诊断都要接住:角色定义的,和跳过环节的。
    const el = element('EffTaskRunner')
    // 四条录入口的诊断都要接住:角色定义的、跳过环节的、**安全阀**的,和员工载入失败的。
    // 员工载入那条另有一条挂载级的真探针(runnerMount.test.tsx),这里只守接线不掉。
    expect(el).toContain('baseRoleNotices={[...roleLoadNotices(), ...collectedRoles.notices, ...collectedSkip.notices, ...collectedCaps.notices]}')
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
    expect(SRC).toContain('runHandoffChoice(\n        choice, h, gitRunner, getCwd(),')
  })

  it('成功之后把待收口从 run.md 划掉,失败则留着', () => {
    // 不划掉:下次 --resume 会为一条已经合并/推送/删掉的分支再弹一次四选一,
    // 而「丢弃」会对着一条不存在的分支报错。
    // 失败还划掉:用户就再也回不到这个关口了,而他刚被告知失败了什么。
    // **`keep` 也算处置完了**,尽管它什么都没做:恢复路径在任何节点检查之前就判
    // pendingHandoff 并 return,而关口每个出口都走 done —— 不划掉的话一个「被安全阀挡住
    // + 有待收口」的 run 会永久卡在收口关口,--retry-blocked 永远到不了 reseat。
    expect(SRC).toContain('if (result.ok) await clearPendingHandoff()')
    // 划掉这件事**只有一份实现**(详情页手动合并那条路也用它)。两份实现里迟早有一份
    // 忘了划,而后果是下次 --resume 为一条已经合完的分支再弹一次四选一。
    expect(SRC).toContain('pendingHandoff: undefined')
    expect(occurrences('pendingHandoff: undefined')).toBe(1)
  })

  it('静默超时真的换到了那口时钟上(新建和恢复两条路都要)', () => {
    /**
     * 剪断它的后果:抽出来的数**显示**对了(关口那一行)、**落盘**对了(run.md),而真正
     * 会中止调用的 `timeoutMs: () => capsRef.nodeTimeoutMs` 还读着旧值 —— 用户说「阶段
     * 超时 20 分钟」,关口回答「静默超时 20 分钟」,而 10 分钟到了照样被杀。
     *
     * 必须计数:新建和恢复两条路径的这行字是逐字相同的,`toContain` 会被另一处满足。
     */
    expect(occurrences('capsRef.nodeTimeoutMs = ')).toBe(2)
    expect(occurrences('timeoutMs: () => capsRef.nodeTimeoutMs')).toBe(2)
  })

  it('自动收口真的接上了 git,而且结果回到了 done 视图', () => {
    /**
     * 剪断这两根线的后果各自完整:
     *  - 不传 `git`:`finishHandoff` 走「没注入」那条路,一次 merge 都不跑 —— 产出永远
     *    只在集成分支上,而这正是用户报的那件事(「要在当前目录下有对应的存在」);
     *  - 不接 `onHandoffResult`:合并成功/失败在屏幕上一个字都没有,done 视图照旧印
     *    「你的工作区未被改动」,而它已经被改动了。
     * 判据是**顺序 + 落点**那一层由 runOrchestrator.test.ts 真跑一遍;这里只钉「线接着」。
     */
    /**
     * **带上下文**,不能只查 `git: gitRunner` 这七个字:`createWorktreePool({… git: gitRunner …})`
     * 在同一个文件里也有一处,于是把传给 runOrchestrator 的那根线整条剪掉,断言照样绿
     * —— 验收预言过、变异测试实测存活。锚在它自己那一段(收口回调紧跟其后)。
     */
    expect(SRC).toContain('        git: gitRunner,\n        onHandoffResult: out => {')
    expect(SRC).toContain('onHandoffResult: out => {')
    expect(SRC).toContain('setHandoffState(st)')
    expect(element('DoneView')).toContain('handoffState={handoffState}')
  })

  it('收口结果显示在 done 视图上', () => {
    // 合并冲突之后安静地回到 done,用户会以为成功了 —— 而代码根本不在他的分支上。
    expect(element('DoneView')).toContain('handoffResult={handoffResult}')
    expect(SRC).toContain('props.handoffResult')
  })
})

describe('上游限流闸门的接线', () => {
  it('**三个** makeRunAgentFn 实例都拿到了同一个闸门', () => {
    /**
     * 剪断任意一处的后果都完整:
     *  - 主 runAgent 少了它 → 整个退避功能在生产里彻底不接线(七个环节、圆桌每一席),
     *    而全套测试一条都不红(验收实测:2481 pass 0 fail);
     *  - extractAgent(一次性配置抽取)少了它 → 那一次调用绕过冷却,而它恰好是用户敲完
     *    /et 之后的第一次调用;
     *  - recalcAgent(依赖重算)少了它 → 用户在上游正限流时按下 d,会另开一条打穿冷却的
     *    通道,而这个键在一棵大树上是可以被连按很多次的。
     *
     * **必须计数**:这行字在这个文件里有多处,`toContain` 会被别处满足 —— 这个文件
     * 顶部记的就是这类假绿(occurrences 这个辅助函数正是为它写的)。
     */
    expect(occurrences('rateGate,')).toBe(3)
    // 闸门本身建在 call() 作用域,和 control 同处 —— 建在组件里的话同一次会话按 r 重做
    // 会把退避级数清零,而两个实例也不再共享「上游在限流」这条状态。
    expect(SRC).toContain('const rateGate = createRateLimitGate()')
  })
})

describe('子 agent 的工具池接线', () => {
  it('七个环节共用的那一份真的传给了 runAgent 适配器', () => {
    // 分档取消之后只剩这**一个**入口。剪断它,所有环节一起失去工具 —— 而窗口里的表现
    // 只是「模型好像不太爱调工具」,没有任何一处报错。
    expect(SRC).toContain('const subAgentTools: Tools = subAgentToolPool(context.options.tools)')
    expect(SRC).toContain('availableTools: subAgentTools,')
  })

  it('适配器上不再有分档字段 —— 有的话就是分档在偷偷复活', () => {
    // 三个字段意味着三条能各自悄悄退化的路。合成一个之后,这条守着它不再分叉。
    expect(SRC).not.toContain('readOnlyTools')
    expect(SRC).not.toContain('verifyTools')
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

describe('工具池:七个环节一律拿全部工具和全部 MCP', () => {
  // 更早的实现是白名单 `{Read, Glob, Grep}`,于是**所有 mcp__* 连带被滤掉** —— 用户配了
  // 查文档/查数据库的 MCP,以为评审员能用,实际只有执行者能用。后来改成黑名单分三档,
  // 现在分档也取消了:用户明确要求各环节一律继承全部工具和全部 MCP。
  const pool = [
    { name: 'Read' }, { name: 'Glob' }, { name: 'Grep' },
    { name: 'Edit' }, { name: 'Write' }, { name: 'NotebookEdit' }, { name: 'Bash' },
    { name: 'mcp__docs__search' }, { name: 'mcp__db__query' }, { name: 'TodoWrite' },
  ]

  it('写工具、读工具、MCP 一个不减', () => {
    const names = subAgentToolPool(pool).map(t => t.name)
    expect(names).toEqual(pool.map(t => t.name))
  })

  it('不是白名单 —— 没见过的工具默认留下', () => {
    // 这条区分「减去 Skill」和「只放行一张枚举表」两种实现:后者会把任何新工具静默丢掉,
    // 而 MCP 工具的名字是用户装什么就叫什么,枚举不完。
    const names = subAgentToolPool([{ name: '某个以后才有的工具' }]).map(t => t.name)
    expect(names).toEqual(['某个以后才有的工具'])
  })

  it('唯一的例外是 Skill —— 那不是限制能力,是它在子 agent 里必然失败', () => {
    // 用户实测过:Skill(Skill) → Unknown skill: bash。技能清单由主循环塞进消息里,
    // 子 agent 没有那份清单。
    expect(subAgentToolPool([...pool, { name: 'Skill' }]).map(t => t.name)).not.toContain('Skill')
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
    expect(SRC).toContain('createStreamStore({')
    // 事件流落盘的两个口子必须真的接上去 —— 少了 sink 就一个字节都不写,
    // 少了 load 详情页永远读不回历史,而两种情况屏幕上都只是「暂无输出」。
    expect(`sink 接了: ${SRC.includes('sink: {')}`).toBe('sink 接了: true')
    expect(`load 接了: ${SRC.includes('load: async nodeId =>')}`).toBe('load 接了: true')
    expect(`详情页触发读回: ${TREE.includes('props.streams?.hydrate(detailId)')}`).toBe('详情页触发读回: true')
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
    // 9 处:分析圆桌 / 方案融合 / 方案精化 / 方案补验收点 / 质疑修复 / 执行 /
    // 测试修复 / 观察评分 / 解决合并冲突。质疑修复和测试修复是这一轮新进来的两个 ——
    // 它们从圆桌搬到了顺序接力,于是也走这条路。
    const calls = PIPE.split('runPhase(ctx,').length - 1
    expect(`runPhase 调用点: ${calls}`).toBe('runPhase 调用点: 9')
    // 每一处都得带 phaseLabel;数量对不上说明有人加了调用点却没给窗口。
    const labeled = PIPE.split('phaseLabel:').length - 1
    expect(`带 phaseLabel 的位置: ${labeled >= 8}`).toBe('带 phaseLabel 的位置: true')
    for (const one of ['解决合并冲突', '方案融合', '方案精化', '方案补验收点']) {
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
    expect(element('ConfirmRedo')).toContain('onConfirm={(entry, guidance) => applyRedo(redoTarget, entry, guidance)}')
    /**
     * 补充指引这一路必须**一路接到底**。
     *
     * 关口收下那句话、算出它给谁,然后 applyRedo 要把它交给 runRedo —— 而 runRedo 才是把它
     * 写到节点上的那一步。中间任何一跳丢了它,用户会看到确认屏上印着自己写的那句话
     * (关口自己就能印),而模型一个字都收不到。这是「配得进去、永远到不了」的形状。
     */
    expect(element('ConfirmRedo')).toContain('initialEntry={redoEntry ?? undefined}')
  })

  it('跳过关口也挂在渲染树上,而且和重做走同一套落盘', () => {
    // 和上面那条逐字同因:setPhase 到 confirmSkip 之后能不能渲染出关口,取决于 JSX 里
    // 有没有这个分支,而这个组件挂不起来。剪断它 = 按 s 之后界面纹丝不动,全套照绿。
    expect(SRC).toContain("phase === 'confirmSkip' && skipTarget")
    expect(element('ConfirmSkip')).toContain('onConfirm={guidance => applySkip(skipTarget, guidance)}')
    // 两个关口必须用**同一份**环节实况:各算一份的话,屏幕上算出来的后果和实际发生的
    // 可以不一样,而用户是照着屏幕按的确认。
    expect(element('ConfirmRedo')).toContain('phases={phaseCtxOf(redoTarget, config)}')
    expect(element('ConfirmSkip')).toContain('phases={phaseCtxOf(skipTarget, config)}')
    // 隔离与否只有这一层看得见,而「跳过验收」能不能安全放行全靠它(见 RedoContext.isolated)。
    // 写死 false 的话,一个丢了工作区引用的节点会被允许跳过验收 —— 把一个空工作区合进
    // 集成分支并判「已验收」。
    // 不含外层花括号:`redoContextOf` 的第三个参数后来多了 `strictness`,于是这个对象
    // 字面量变成了多行。钉整个字面量会让「往里加一个字段」变成一次假失败,而这条断言
    // 真正要守的是**这个表达式**没有被写死成 false。
    expect(SRC).toContain('isolated: poolRef.current !== undefined')
    /**
     * 重做关口要说出这一趟按哪一档跑。
     *
     * 少了它的场景很具体:用户降到初级 → 半成品被放行 → 在结束屏上按 r 重做 → 拿到的
     * 是**又一次初级**,而屏幕上从头到尾没提过档位(它是 run 级持续状态,重做不清它)。
     */
    expect(SRC).toContain('strictness: control.strictness() ?? cfg.caps.strictness')
  })

  it('R / s / f 三个键真的接到了失败判据上,而且拿不到时**说原因**', () => {
    /**
     * 这几个键的价值全在「拿不到的时候告诉你为什么」:一个节点不是自己失败的(是它孩子挂了)、
     * 失败在一个不能单独重入的环节、或者这次 run 被中断过 —— 三种情况要做的事完全不同。
     * 剪断任何一条 setRedoProblems,用户按下去得到的是**一屏什么都没有**。
     */
    const done = SRC.slice(SRC.indexOf('<DoneView'))
    expect(done).toContain('failedRedoTarget(node, byId,')
    expect(done).toContain('skipFailedPhaseReason(node,')
    // 强制通过用的是它自己那个判据函数,不是跳过那个。两者共用实现但**文案不同**
    // (「跳过它」vs「强制通过它」),接错了屏幕上会对着一个强制通过的动作说「无法跳过」。
    expect(done).toContain('forcePassFailedPhaseReason(node,')
    // 中断标记那道闸门在**四个**入口上都要有(r / R / s / f):少了它,按下去会立刻再次阻断,
    // 而屏幕上只会闪一下(redoUnavailableReason 的注释记着这条实测)。
    expect(done.split('redoUnavailableReason({ aborted: props.signal.aborted').length - 1).toBe(4)
  })

  it('运行中的 f 走的是预先批准,不是重开编排', () => {
    /**
     * 这两条路**必须分开**,而接线是唯一能把它们接反的地方:
     *  - 从 running 进来 → `control.forcePass` + 回 running。节点一个字不动,编排器继续跑。
     *  - 从 done 进来 → `runForcePass` 重算树 + 重开编排。
     *
     * 接反的后果不对称:把 done 那条接成预先批准 = 按下去什么都不发生(节点已经停了,
     * 没有人会再走到那个环节);把 running 那条接成 runForcePass = **在编排器正握着这些
     * 节点的时候把树换掉**。
     */
    const gate = SRC.slice(SRC.indexOf("phase === 'confirmForcePass'"))
    expect(gate).toContain("forcePassFrom === 'running'")
    expect(gate).toContain('control.forcePass(forcePassTarget.id, p)')
    // 取消要回到**来的那一屏**,不是无条件回 done —— 运行中按 f 又按 Esc 会让一个还在跑的
    // run 变成结束屏:树不再更新,p / i / x 一起消失,而什么都没有出错。
    expect(gate).toContain('setPhase(forcePassFrom)')
    expect(gate).not.toContain("onCancel={() => { setForcePassTarget(null); setPhase('done') }}")
    // 运行视图那一侧真的把键给出去了(给了才有 f)。
    expect(SRC).toContain("onForcePass={node => { setForcePassTarget(node); setForcePassFrom('running')")
  })

  it('重做的四条出口全都接上了 —— 行为归 redoRun.test.ts,这里只守接线', () => {
    /**
     * 「按下确认之后发生什么」现在住在 redoRun.ts,由 redoRun.test.ts 真的调一次并断言
     * 顺序与参数。这里剩下的只是**把真东西接上去**这一跳 —— 而这一跳恰恰是这个文件
     * 反复剪断的地方。
     *
     * 之所以曾经需要一整组源码文本断言:同样的逻辑长在这个文件里时,验收把每一个被
     * 断言的字符串原样留着,造出 14 条变异全部存活。搬走之后这里只需要守四条线。
     */
    // 四条出口现在住在 redoDeps 里 —— 重做和跳过共用一份(见 redoRun.ts 的注释:
    // 两份实现意味着第二次踩同一组坑)。
    const body = SRC.slice(SRC.indexOf('const redoDeps = React.useCallback'))
    // 窗口按**下一个声明**切,不按字符数:redoDeps 的注释会随功能变长,而一个按 1200 字符
    // 切出来的窗口迟早把 `start:` 挤到外面 —— 那时这条闸门会因为「找不到」而变红,
    // 读起来像接线断了,实际上只是注释多写了几行。
    const head = body.slice(0, body.indexOf('const phaseCtxOf'))
    // 落盘:少了它,树只在内存里改过,下次 --resume 全丢。
    expect(head).toMatch(/commit:\s*\(plan: RedoPlan, before: readonly TaskNode\[\]\) => commitRedo\(/)
    // 重启:startRun 是这个文件里 runOrchestrator 的**唯一**调用点。少了它,用户按完
    // 确认会看到树变了、节点退回排队中,然后永远停在那儿。
    // 重启 / 就地换树:两条路共用这一个出口(见 redoDeps 的 `from`)。少了它,用户按完
    // 确认会看到树变了、节点退回排队中,然后永远停在那儿。
    expect(head).toMatch(/start:\s*\(n: TaskNode\[\], affected: readonly string\[\]\) => \{/)
    expect(head).toContain('if (!startRun(cfg, n)) {')
    expect(head).toContain('orch.applyLive(n, affected)')
    // 两个入口都真的用了这份 deps。少了任何一个,那条路的六件事一件都不会发生。
    expect(SRC).toMatch(/runRedo\([\s\S]{0,220}redoDeps\(cfg, runDir, /)
    expect(SRC).toMatch(/runSkip\([\s\S]{0,220}redoDeps\(cfg, runDir, /)
    // 补充指引一路交到底 —— 见上面那条注释。
    expect(SRC).toMatch(/runRedo\([\s\S]{0,260}guidance,/)
    expect(SRC).toMatch(/runSkip\([\s\S]{0,260}guidance,/)
    // 没做成的事上屏:一个删不掉的 node.md 会在下次 --resume 时自己长回来。
    expect(head).toContain('onProblems: setRedoProblems')
    // 新树进 state:少了它界面显示的还是重做前那棵。
    expect(head).toContain('onNodes: setNodes')
    /**
     * 被删子树的实时输出跟着走。少了这一跳,用户报的那条就会回来:重做父任务之后,
     * 新拆出来的子节点顶着**上一轮同名节点**的运行记录(childId 由「父id + 序号 +
     * 标题 slug」算出,重拆一次常常逐字相同)。顺序与参数由 redoRun.test.ts 钉住,
     * 这里守的是「真存储被接上了」——store 那侧的行为由 agentStream.test.ts 钉。
     */
    expect(head).toMatch(/onDropStreams:[\s\S]{0,80}streams\.current\.dropNodes\(ids\)/)
  })

  it('同一个 run 上不许起第二个编排器 —— 而且清点覆盖异常路径', () => {
    /**
     * 用户报的两件事的同一个病根:「重做时并行任务数超过设置的数」+「最上面几个数字
     * 一会儿高一会儿低」。两个编排器 = 两个并发池(各自守着用户设的上限)+ 两棵树轮流
     * 推进同一个 `setNodes`。
     *
     * 关口那道闩(useSettleOnce)由真组件用例守着;这里守的是**最后一道**,因为
     * `startRun` 住在这个挂不起来的文件里,而它的调用点已经有四个(第三关、跳过分析、
     * 重做/跳过/强制通过共用的 redoDeps)。
     *
     * `orchRef` 单独用不住:它是 runOrchestrator 跑到一半才回填的,而同一个 stdin 块里
     * 连着来的两下回车之间一次 await 都没有 —— 两次调用都会看到它是 null。所以闩必须是
     * 同步置位的 `runLive`,而清点必须挂在 promise 的 finally 上(漏掉异常路径 = 以后
     * r 键永远没反应)。
     */
    const start = SRC.slice(SRC.indexOf('const startRun = React.useCallback'))
    const head = start.slice(0, start.indexOf('const redoDeps'))
    expect(head).toContain('if (runLive.current || orchRef.current) return false')
    expect(head).toMatch(/runLive\.current = true[\s\S]{0,80}setPhase\('running'\)/)
    expect(head).toContain(".finally(() => { runLive.current = false })")
    // 拒绝要**答复**,不许静默:这次重做已经落盘了。
    expect(SRC).toContain('if (!startRun(cfg, n)) {')
  })

  it('交给 commitRedo 的 before 是 runRedo 给的那份,不是组件手上的', () => {
    // 组件手上的 `nodes` 和 runRedo 传出来的 `before` 在正常路径上相同,但把参数
    // 换成前者就等于**假装**这条线接对了 —— 而 redoRun.test.ts 断言的正是 before 的
    // 内容。两边指向同一个东西,这条线才是活的。
    const body = SRC.slice(SRC.indexOf('const redoDeps = React.useCallback'), SRC.indexOf('const redoDeps = React.useCallback') + 1200)
    expect(body).toMatch(/before,\s*onError:/)
  })

  it('警告行真的接上了分色判定', () => {
    // 这一条**只能**这么测:假 TTY 下 vendored ink 一个 SGR 都不发(实测 FORCE_COLOR
    // 未设时 0 个色码),所以「渲染出来是不是黄的」从测试接缝里看不见。判定本身由
    // redoGate.test.ts 的 isWarningLine 用例守着,这里守的是它**被用上了**。
    const gate = readFileSync(new URL('./ConfirmRedo.tsx', import.meta.url), 'utf8')
    expect(gate).toMatch(/color=\{isWarningLine\(l\) \? 'warning' : undefined\}/)
  })
  it('等人批准时面板真的会收到 suspended', () => {
    // 三跳都在这个挂不起来的文件里:makeRunAgentFn 拿到 onHumanWait、组件把通知口填进
    // humanWaitOut、RunningView 把 waiting 传给面板。任何一跳断掉,用户按回车批准工具的
    // 同一下就又会打开节点详情 —— 而组件档和计数器档都照样绿。
    expect(SRC).toContain('onHumanWait: w => { humanWaitOut.current?.(w) }')
    expect(SRC).toMatch(/props\.humanWaitOut\.current = \(w: boolean\) =>/)
    expect(element('RunningView')).toContain('suspended={humanWait.waiting}')
    // 串行提示要真的按**池子在不在**来,写死 false 的话它永远不出现,
    // 而顶上那个「并行 1/5」会一直误导用户。
    expect(element('RunningView')).toContain('serialExecute={poolRef.current === undefined && !sharedParallelRef.current}')
  })
  it('调并发度接的是 control,而且基准取它现在的值', () => {
    /**
     * 两条线,都只在这个挂不起来的文件里:
     *
     *  1. 面板的 `+`/`-` 要接到 `control.setParallelism` 上。接到别处(或者只改 config)的话,
     *     编排器读的是 `control.parallelism() ?? cfg.parallelism` —— 数字在屏幕上动了,
     *     而调度器一无所知。
     *  2. **基准必须取 control 现在的值**,没调过才回落到关口批准的那个。一直拿 config 当
     *     基准的话,连按两次 `+` 会得到 6、6 而不是 6、7 —— 用户会以为这个键坏了。
     */
    expect(element('RunningView')).toContain('runControl={{')
    expect(SRC).toContain('onAdjustParallelism: d => {')
    expect(SRC).toContain('const cur = control.parallelism() ?? config.parallelism')
    expect(SRC).toContain('control.setParallelism(cur + d)')
    /**
     * 按下之后**当场重绘**那一句。
     *
     * 验收量过删掉它的真实后果:树还活着时靠 TaskTreePanel 那个 1s tick 兜底(≤1s 延迟),
     * 而那个 tick 的条件是「还有非终态节点」—— **全终态时它 clearInterval,表头就永久不动**,
     * 按了完全没反应。而删掉这一行全套 2600+ 条测试照绿(验收造的变异存活了),
     * 所以这一跳只能在这里钉。
     */
    expect(SRC).toContain('setParallelismTick(t => t + 1)')
  })

  it('运行中的树上**有** r / R / s 三个键,而且走的是就地换树那条路', () => {
    /**
     * 用户原话:「任务失败了,不需要整体返回失败才能重做任务或阶段,在其它任务还在运行时
     * 就可以重做。」在这之前这三个键只挂在结束屏上 —— 一个节点在第三分钟失败,他要等
     * 整棵树跑完、拿到一个 blocked,才能去动它。
     *
     * **接上去本身不是安全的**,而这条闸门守的正是那个差别:此前不接的理由是「编排器正
     * 握着这些节点」,那个理由今天由两道真闸门顶着,而不是由「键不存在」顶着 ——
     *  1. `liveRedoUnavailableReason`:目标节点自己正在跑就不许重做(让用户先按 x);
     *  2. `orchestrator.hold`:落盘**之前**把要动的节点从调度里扣下来,换完树再放。
     * 少了任何一道,重做就会在编排器正在改这些节点的时候动它们。
     *
     * 断言落在**渲染 RunningView 的那一处 JSX** 上:它是这个挂不起来的文件里唯一的接线点。
     */
    const running = element('RunningView')
    expect(running).toContain('runControl={{')
    for (const wire of ['onRedo=', 'onRedoFailed=', 'onSkipFailed=']) {
      expect(`RunningView 上有 ${wire}: ${running.includes(wire)}`).toBe(`RunningView 上有 ${wire}: true`)
    }
    // DoneView 上三个也都在 —— 否则这条断言用「两边都有」也能被一个把结束屏拆了的改动满足。
    const done = SRC.slice(SRC.indexOf('<DoneView'))
    for (const wire of ['onRedo=', 'onRedoFailed=', 'onSkipFailed=']) {
      expect(`DoneView 上有 ${wire}: ${done.includes(wire)}`).toBe(`DoneView 上有 ${wire}: true`)
    }
    // 两道闸门都真的接在运行中那三个回调里。少了第一道,按 r 会去动一个正在跑的节点;
    // 少了 `setRedoFrom('running')`,这次重做会在别的节点还跑着的时候另起一个编排器。
    expect(occurrences('liveRedoUnavailableReason({')).toBe(3)
    expect(occurrences("setRedoFrom('running')")).toBe(3)
    expect(SRC).toContain('const held = orch.hold(affected)')
    // 夹取只有一份(control 里),这里不许再算一遍 —— 两份夹取会在边界上分叉,
    // 而表头和页脚会各说一个数。
    expect(SRC).not.toContain('Math.min(MAX_PARALLELISM')
  })

  it('人工干预面是**同一个实例**,三跳都接上了', () => {
    // 取消要靠面板、适配器、编排器共用同一个 RunControl 才生效:在组件里再 new 一个的话,
    // 已经登记的在飞调用永远取消不掉,而按 x 之后屏幕上什么都不会变。
    // 而且它必须在 call() 里建 —— 组件会重挂,call() 不会。
    expect(SRC).toContain('const control = createRunControl()')
    // 交给 runAgent(适配器靠它登记在飞调用)
    expect(SRC).toMatch(/onHumanWait: w => \{ humanWaitOut\.current\?\.\(w\) \},\s*\n\s*control,/)
    // 交给组件(面板按键用它)
    expect(element('EffTaskRunner')).toContain('control={control}')
    // 交给编排器(暂停在调度循环里生效)
    expect(SRC).toContain('control: props.control,')
  })

  it('全文件只许 new 一个 RunControl —— 组件里再建一个,三个键就全废了', () => {
    /**
     * 回归验收造的那条变异:把组件里的 `const control = props.control` 换成
     * `createRunControl()`。上面那四条文本断言**全都还在**(它们查的是「有没有把
     * control 交出去」,不是「交出去的是不是同一个」),而后果是 p / i / x 三个键
     * 全部作用在一个孤立实例上:暂停不停、指令进不了提示词、按 x 那个节点继续改代码,
     * 而提示行照画「⏸ 已暂停」。
     *
     * 这条闸门是**结构性**的,不是行为性的:它证明的是「这个文件里只 new 了一次」。
     * 真正的行为断言要在 runnerMount 里走完三道关口、真按键、数模型调用次数 —— 那是
     * 更贵也更好的一条,还没做。在那之前,这一条至少让上面那个变异变红。
     */
    expect(occurrences('createRunControl()')).toBe(1)
    // 而且必须在 call() 里、在 makeRunAgentFn **之前** —— 组件会重挂,call() 不会;
    // 排在后面就是 TDZ(runnerMount 抓到过一次)。
    const iNew = SRC.indexOf('const control = createRunControl()')
    const iUse = SRC.indexOf('const runAgent: RunAgentFn = makeRunAgentFn(')
    expect(iNew).toBeGreaterThanOrEqual(0)
    expect(iNew).toBeLessThan(iUse)
  })
  it('三个干预键各自接到不同的动作上', () => {
    // 接错一个的后果都很实:x 接到暂停上 = 用户以为取消了那个节点而它还在改代码。
    const body = SRC.slice(SRC.indexOf('runControl={{'))
    const head = body.slice(0, 900)
    expect(head).toContain('onTogglePause')
    expect(head).toContain('onAddDirective: () => setDirectiveOpen(true)')
    expect(head).toContain('onCancelNode: n => control.cancelNode(n.id)')
    // 暂停的真相在 control 里,state 只是让提示行重绘 —— 两边分开迟早不一致。
    expect(head).toContain('setPaused(control.isPaused())')
  })

  it('追加指令输入框排在运行视图**之前** —— 否则它永远画不出来', () => {
    const iBox = SRC.indexOf("phase === 'running' && directiveOpen")
    const iRun = SRC.indexOf("if (phase === 'running') {")
    expect(iBox).toBeGreaterThanOrEqual(0)
    expect(iBox).toBeLessThan(iRun)
  })
  it('先看树那条路**照给**四个动作键 —— 没有只读模式', () => {
    /**
     * 曾经是 `onRedo={viewOnly ? undefined : …}` 四个全摘,理由是「他刚刚明确选了不跑」。
     * 而恢复关口自己印着「树太长……**按 v 查看完整任务树**」—— 于是想看整棵树的人被指进
     * 一条死胡同:看得见、动不了,屏幕上还一个字都不解释。用户报的原话:
     * 「是先按了 v,不然树出不来」。
     *
     * 「只看」的本意是**不要自动把这个 run 跑起来**,不是「永远不许我动手」;而重做本来
     * 就要过确认屏,那是第二次明确决定。所以键照给 —— 但那句「按了会开跑」必须同屏。
     */
    // 四个动作键**无条件**给 —— 一个 viewOnly 三元都不许再有。
    for (const k of ['onRedo', 'onRedoFailed', 'onSkipFailed', 'onForcePass']) {
      expect(SRC).not.toContain(`${k}={viewOnly ? undefined :`)
    }
    // 也不许再有任何「只看模式」的说辞挂在键旁边 —— 那个模式不存在。
    expect(SRC).not.toContain('只看模式')
  })

  it('树外那几条流是钉住的 —— 否则它们是第一批被淘汰的', () => {
    // 它们挂在 root 上,而且是 root 上最老的三条;淘汰按插入顺序压最旧的已收口流。
    // 把它们挂到 root 的理由正是「事后最想回看」。
    expect((SRC.match(/pinned: true/g) ?? []).length).toBe(3)
  })
})

describe('靠主循环上下文的工具不能进子 agent', () => {
  it('池子滤掉 Skill', () => {
    // 用户实测:Skill(Skill) ⎿ Unknown skill: bash。
    // 技能清单是主循环消息管线的 attachment,efftask 的子 agent 消息是自己拼的 ——
    // 工具在、清单不在,模型只能猜,每猜一次白烧一轮调用。
    const all = [{ name: 'Skill' }, { name: 'Read' }, { name: 'Bash' }]
    expect(subAgentToolPool(all).map(t => t.name)).toEqual(['Read', 'Bash'])
  })

  it('别的工具一个都不许多滤 —— MCP 的名字是用户装什么就叫什么', () => {
    const all = [{ name: 'mcp__x__y' }, { name: 'Glob' }, { name: 'TodoWrite' }]
    expect(subAgentToolPool(all)).toHaveLength(3)
  })

  it('池子里只有这一条 filter —— 多一条就是分档在偷偷复活', () => {
    /**
     * 分档取消之后,退化方向变了:不再是「某一档少给了工具」,而是「有人往这个唯一的
     * 池子里再加一条 filter」。那种改法在窗口里完全无声 —— 某个环节静默少拿工具,
     * 表现只是「这个角色好像没查代码」。所以这里数 filter 的条数。
     */
    const src = readFileSync(new URL('./efftask.tsx', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('export function subAgentToolPool'))
    const fn = body.slice(0, body.indexOf('\n}') + 2)
    expect((fn.match(/\.filter\(/g) ?? []).length).toBe(1)
    expect(fn).toContain('!CONTEXT_DEPENDENT_TOOL_NAMES.has(t.name)')
  })
})

/**
 * 出网路线那一块要**真的拿到员工端点**。
 *
 * `proxyNoticeLines` 自己有单测(startupConfirm.test.ts),但那证明不了它拿到了东西:
 * 把 `apiUrls` 这个 prop 剪掉,函数照样返回一个只有「检测到全局代理」的列表 —— 关口
 * 上少的正是「哪几个端点会绕过它直连、哪几个仍走代理」,而那才是用户配了内网员工之后
 * 唯一能提前发现问题的地方。这个文件挂不起来,所以只能守这一跳的文本。
 */
describe('启动关口拿得到员工端点', () => {
  it('ConfirmStartup 收到 apiUrls,而且取的是 roleClientConfig.apiUrl', () => {
    const el = element('ConfirmStartup')
    expect(el.startsWith('<ConfirmStartup')).toBe(true)
    expect(el).toMatch(/apiUrls=\{props\.agentModels\.map\(a => a\.roleClientConfig\?\.apiUrl\)\}/)
  })
})

/**
 * 收口关口那一次合并也要能让模型解冲突。
 *
 * 自动收口那条路(runOrchestrator)有行为用例钉着,这一条没有:`settleHandoff` 在
 * `EffTaskRunner` 里,而那个组件挂不起来(见文件头)。剪断它的后果不是报错,是**两条路
 * 给出两种结果** —— 同一条分支、同一个检出,「跑完直接合」会自动解冲突,「resume 进关口
 * 再合」把冲突现场丢给用户,而用户根本不知道自己走的是哪条。
 */
describe('收口关口的合并也带着解冲突的人', () => {
  it('settleHandoff 把解决者传给了 runHandoffChoice', () => {
    /**
     * **两处**:收口关口这一处,和详情页 `m` 键那一处(手动合并子树时同样要有人解冲突)。
     * 数目仍然钉住 —— 只查存在会被另一处满足,而这个文件为那个陷阱写过两次注释;
     * 各自到底接对没有,由下面那条正则和「手动合并」那一节分别判。
     */
    expect(occurrences('makeHandoffConflictResolver({ runAgent: props.runAgent')).toBe(2)
    // 第五个参数的位置就是解决者 —— 传成 undefined 或者干脆不传都会让关口退回老行为。
    expect(SRC).toMatch(/runHandoffChoice\(\s*\n?\s*choice, h, gitRunner, getCwd\(\), resolver,/)
    /**
     * **第六个参数是「先同步主干」那条路。**
     *
     * 收口和 `m` 键面对的是同一件事(集成分支 → 用户当前分支),而在这之前只有 `m` 走了
     * 新机制:收口仍在用户自己的检出里 `git merge`,撞冲突只能 abort —— 于是
     * 「跑完把产出送回你的目录」在最容易撞冲突的那一次上失效,而那正是一整趟运行的结尾。
     * 剪断它不会有任何测试红,除了这一条。
     */
    expect(SRC).toContain('poolNow')
    expect(SRC).toMatch(/syncTrunk\(\{[\s\S]*?trackedDirty:/)
  })
})

/**
 * 一键回收已完成工作区的三跳接线。
 *
 * 这个功能有两处组件级用例(cleanupView.test.tsx 钉住键和关口,cleanupWorktrees.test.ts
 * 对着真 git 钉住判据),而中间这一跳 —— 「运行视图/结束屏把回调交出去、关口拿到真的
 * 池子和 run 目录」 —— 只住在 `EffTaskRunner` 的 JSX 里,挂不起来。剪断任意一处的后果都是
 * 用户按 `c` 什么都不会发生,或者更糟:关口开了、清单是空的,而它读的是一个空池子 ——
 * 屏幕会把「这一趟没隔离」说成「已经没有可清的了」。
 */
describe('清理已完成工作区的接线不能被静默剪断', () => {
  it('两条路径都把回调交给了树面板,并且都只在有池子时才给', () => {
    // 计数:running 和 done 各一处,逐字相同 —— 只查存在会被另一处满足(这个文件为
    // 同一个陷阱写过两次注释)。
    expect(occurrences('onCleanupWorktrees={poolRef.current ? node => {')).toBe(2)
    expect(occurrences("setCleanupTarget(node); setCleanupFrom('running'); setPhase('confirmCleanup')")).toBe(1)
    expect(occurrences("setCleanupTarget(node); setCleanupFrom('done'); setPhase('confirmCleanup')")).toBe(1)
    // 两个视图组件也要真的把它往下传,否则上面两处赋值只是喂给了一个没人读的 prop。
    expect(SRC).toContain('onCleanupWorktrees={props.onCleanupWorktrees}')
    expect(occurrences('onCleanupWorktrees={props.onCleanupWorktrees}')).toBe(2)
  })

  it('关口拿到的是真的池子路径、真的集成分支、以及要写回的 run 目录', () => {
    // 路径必须问池子要:它是 hash(nodeId) 算出来的,在这里重算一份的话,slug 规则改动的
    // 那一天这个键会开始删另一个目录 —— 而它不可逆。
    expect(SRC).toContain('pathFor: n => pool.worktreePathOf(n)')
    expect(SRC).toContain('branchFor: n => pool.worktreeBranchOf(n)')
    expect(SRC).toContain('integrationBranch: pool.integrationBranchName')
    // 少了 persist,目录删了而 node.md 还指着它 —— 下次 --resume 读回一条指向空气的记录。
    expect(SRC).toContain('persist: { fs: props.fs, runDir }')
    /**
     * 磁盘被撑爆的那两个大头也归这个键管(跑机 qianbase-xtp run 001:盘 100% 满、
     * 84 次 ENOSPC)。它们是**纯接线** —— 判据全在 cleanupWorktrees.ts 里被真 git 测过,
     * 而这两行剪断之后那些用例照样全绿,屏幕上却再也不会出现这两段:
     *  - 集成工作区的 target/(那一趟 22 GB):它永远不被 worktree remove,只能从这里清;
     *  - 系统临时目录里按 slug 认出来的残留(那一趟 141 个条目、23 GB)。
     */
    expect(SRC).toContain('scratch: tmpScratch')
    expect(SRC).toContain('integrationPath: pool.integrationPath')
    /**
     * 「只清产物」那一桶的硬闸(用户第 5 条的另一半)。剪断它,`c` 会对一个**正在跑**的
     * 节点的工作区跑 `git clean` —— 一次跑到一半的增量编译被抽掉产物,而用户会以为是
     * 模型写坏了代码。判据在 cleanupWorktrees.ts 里被真 git 测过,这一行是它的电源。
     */
    expect(SRC).toContain('inFlight: orchRef.current?.runningNodeIds() ?? []')
  })

  it('确认之后真的会去扫、去删,并把结果推回界面', () => {
    /**
     * **扫描和真删各取一次 deps。**
     *
     * 两次之间隔着一整屏确认(用户可能看很久),而 `inFlight` 是这期间唯一会变的东西。
     * 共用渲染那一刻的快照 = 拿一个过期的答案去对一个此刻正在跑的工作区动手。
     */
    expect(element('ConfirmCleanup')).toContain('scanCleanup(cleanupDeps()!, nodes, cleanupTarget.id)')
    expect(element('ConfirmCleanup')).toContain('runCleanup(cleanupDeps()!, plan, nodes)')
    // 剪断这一句:工作区没了,而详情页的「隔离工作区」那一段还画着那条路径。
    expect(element('ConfirmCleanup')).toContain('setNodes([...nodes])')
  })
})

/**
 * 手动合并未合入主干的工作区(详情页 `m`)的三跳接线。
 *
 * 和上面那一节同因,而且后果更重:剪断任意一处,用户按 `m` 要么什么都不发生,要么关口开了
 * 却对着一个空池子扫出「没有需要合并的工作区」—— 而真相是他的产出全锁在几条分支上,
 * 一个字节都没到他的目录里。这一跳住在 `EffTaskRunner` 的 JSX 里,组件级用例挂不起来。
 */
describe('手动合并子树的接线不能被静默剪断', () => {
  it('两条路径都把回调交给了树面板,并且都只在有池子时才给', () => {
    // 计数:running 和 done 各一处,逐字相同 —— 只查存在会被另一处满足。
    expect(occurrences('onMergeWorktrees={poolRef.current ? node => {')).toBe(2)
    expect(occurrences("setMergeTarget(node); setMergeFrom('running'); setPhase('confirmMerge')")).toBe(1)
    expect(occurrences("setMergeTarget(node); setMergeFrom('done'); setPhase('confirmMerge')")).toBe(1)
    // 两个视图组件也要真的把它往下传,否则上面两处赋值只是喂给了一个没人读的 prop。
    expect(occurrences('onMergeWorktrees={props.onMergeWorktrees}')).toBe(2)
  })

  it('关口拿到的是真的池子、解冲突的主模型、要写回的 run 目录,以及一条可中断的 signal', () => {
    const deps = SRC.slice(SRC.indexOf('const mergeDeps ='), SRC.indexOf('const applyRedo ='))
    // 池子是判据和动作的全部来源;换成自己拼一份 git 调用就会和自动路径分叉。
    expect(deps).toContain('pool,')
    // 用户原话里「用主模型解决」那一半 —— 剪掉它,撞冲突只会停下来报告。
    expect(deps).toContain('resolve: makeHandoffConflictResolver({ runAgent: props.runAgent, node: root, signal })')
    // 少了 persist,盘上就没有「这次合并是人手动触发的」这笔账。
    expect(deps).toContain('persist: { fs: props.fs, runDir }')
    // 中断要能到得了执行体:没有它,关口上的「合完当前这个就停」是一个假按钮。
    expect(deps).toContain('signal,')
    expect(element('ConfirmMergeSubtree')).toContain('onInterrupt={() => mergeAbort.current?.abort()}')
  })

  /**
   * **「捞」那一整条链的六条缝,一条都不许断。**
   *
   * 它们全是**可选字段**,而 `...(cond ? {x} : {})` 这种条件展开 TypeScript **不做多余属性
   * 检查** —— 删掉任何一行都不会有类型错误,也不会有任何一条既有测试变红,只会让对应的
   * 那一格静默退回「只列不捞 / 这一格没查」。这个仓库的招牌缺陷,而上一轮有三个注入点
   * 正是评审当场点出来才补上的:补上了,但没上锁。
   *
   * 每一行后面写清楚**剪掉它会静默失去什么**,而不是只写「必须有」。
   */
  it('捞回那条链的六条缝都真的注入了', () => {
    const deps = SRC.slice(SRC.indexOf('const mergeDeps ='), SRC.indexOf('const applyRedo ='))
    // 缺任意一样 → `scanRescue` 直接返回 `{}`,四类没有工作区目录的产出一格都不扫。
    expect(deps).toContain('...(runId ? { runId } : {})')
    expect(deps).toContain('worktreeRoot: `${pool.gitRoot}/.efftask-worktrees`')
    // 孤儿目录那一格靠它探;缺了它那一格恒为空,而空白和「没有孤儿目录」长得一样。
    expect(deps).toContain('exists: p => access(p).then(() => true, () => false)')
    // 缺了它,孤儿目录里有什么根本不比对。
    expect(deps).toContain('listFiles: listFilesUnder')
    // 缺了它,四类里此前唯一 0% 捞回的那一格**静默**退回「只列不捞」。
    expect(deps).toContain('copyInto: async (from, to) =>')
    // 缺了它,每一条孤立 ref 都落「拿不准」——第 1 级(整条合并)整个消失。
    expect(deps).toContain('triage: makeRescueTriage({ runAgent: props.runAgent, node: root, signal })')
  })

  it('确认之后真的会去扫、去合,并把结果推回界面', () => {
    expect(element('ConfirmMergeSubtree')).toContain('scanSubtreeMerge(deps, nodes, mergeTarget.id)')
    // `stash` 也要流进去 —— 用户在这一屏按的那一下 s,是它唯一的来源。
    expect(element('ConfirmMergeSubtree')).toContain('runSubtreeMerge({ ...deps, onProgress, stash }, plan, nodes)')
    // 剪断这一句:注记写进了 node.md,而详情页上一个字都不变。
    expect(element('ConfirmMergeSubtree')).toContain('setNodes([...nodes])')
  })

  it('手动合成功之后,「投递了没有」这件事的三份记录一起改口', () => {
    const el = element('ConfirmMergeSubtree')
    // 剪断任意一条,同一个事实就会在三个地方说三种话:结束屏继续写「产出还没到你的分支」、
    // 退出报告跟着错、下次 --resume 为一条已经合完的分支再弹一次四选一。
    /**
     * **判据不能只看第 2 跳。** 验收实测:`planRescue` 把若干 ref 判进 `hold` 时
     * (生产上最常见的是模型回 unsure,而没被模型提到的也算 unsure),`trunk.ok` 照样
     * 为真 —— 记录被抹掉,而那几条 ref 确实没被合回来,下一次 --resume 不再弹关口。
     */
    /**
     * **回收要在 `m` 跑完那一刻做,不是等收口。** 唯一会造出备份 ref 的就是这个键,
     * 而它最典型的按法是跑完之后在结束屏上按 —— 那时 `reclaim` 早跑完了(整趟一次性),
     * 收口那次 sweep 永远看不到这批 ref。
     */
    expect(el).toContain('const swept = await sweepStashBackups({ git: gitRunner, cwd: poolRef.current.gitRoot, runId })')
    expect(SRC).toContain("import { sweepStashBackups } from '../../tools/efftask/stashGuard.js'")
    /**
     * **判据已经提成纯函数 `mergeHeldBack`** —— 它此前住在这个回调里,而那里断言不到:
     * 变异测试实测「把收尾复核结果从判据里拿掉」全套照绿。这里断言的是**接线还在**
     * (函数被 import、被调用),判据本身的四项由 `mergeSubtree.test.ts` 逐项打中。
     */
    expect(SRC).toContain("import { mergeHeldBack, runSubtreeMerge, scanSubtreeMerge")
    expect(el).toContain('const heldBack = mergeHeldBack(out)')
    expect(el).toContain('if (out.trunk?.ok === true && heldBack === 0)')
    expect(el).toContain("setHandoffState('merged')")
    expect(el).toContain("props.handoffStateOut.current = 'merged'")
    expect(el).toContain('await clearPendingHandoff()')
  })
})

/**
 * 依赖重算的那几根线。
 *
 * 验收席拿 100 条变异跑过一遍:下面每一根**剪断之后 3655 条测试一条都不红** ——
 * 而这个仓库为同一个形状栽过三次(collectSkipSteps 缺过整整一版、onEscalate/onBlocked
 * 在 ctx() 里漏过、finishHandoff 的早退返回没有 result 让 UI 那条分支变成死代码)。
 */
describe('依赖重算的接线不能被静默剪断', () => {
  it('运行视图把 `d` 键的回调真的传给了任务树面板', () => {
    // 剪断这一跳:`d` 键在生产里彻底消失,而按键测试挂的是 TaskTreePanel、照样全绿。
    expect(element('TaskTreePanel')).toContain('onRecalcDeps={props.onRecalcDeps}')
    // 提示写不写走的是**真正的准入**,不是 status === 'CREATED'(抄一份必然分叉,
    // 而分叉的方向恰好是「屏幕上写着、按下去被拒」)。
    expect(element('TaskTreePanel')).toContain('recalcAvailable={props.recalcAvailable}')
  })

  it('准入过了才切屏,而且只有运行视图接线', () => {
    // 剪断 setPhase:关口永远打不开,按 d 变成一个安静的空操作。
    expect(occurrences("setPhase('confirmRecalc')")).toBe(1)
    expect(occurrences("phase === 'confirmRecalc' && recalcTarget")).toBe(1)
    // 结束屏没有编排器可以 hold 住节点、也没人会去调度它 —— 那里一个字都不该有。
    expect(SRC.slice(SRC.indexOf('export function DoneView'))).not.toContain('onRecalcDeps')
  })

  it('关口拿到了实时输出流', () => {
    // 剪断它:那几分钟里「模型卡住了」和「正常在读」在屏幕上长得一模一样,
    // 用户唯一的信息是一个在跳的秒数。而 open() 收的是**一个对象** —— 传两个位置参数
    // 会让流挂在 undefined 的 nodeId 上,详情页永远取不到它(实测过)。
    expect(element('ConfirmRecalcDeps')).toContain('streams={streams.current.streams(target.id)}')
    expect(SRC).toContain("nodeId: target.id, phaseLabel: '依赖重算'")
  })

  it('应用走的是编排器那一份树,不是 React 快照', () => {
    // 「应用那一刻再量一遍假 ACCEPTED」防的正是 growTree 的 await 交错,而新挂上的
    // 子节点要等下一次 onUpdate 才进 React state —— 拿快照去量会 fail-open。
    expect(SRC).toContain('orchRef.current?.nodes() ?? nodes')
  })

  it('专用缝:零工具 + 120s,而且共享同一个限流闸门', () => {
    expect(SRC).toContain('const recalcAgent: RunAgentFn = makeRunAgentFn({')
    // 带写工具的席位不该出现在一个「用户按了个键」的路径上。
    expect(SRC).toContain('    availableTools: [],\n    activeAgents,\n    mainModelDefault,\n    timeoutMs: () => 120_000,')
  })
})

/**
 * 退出时「盘上和屏幕上一致」这件事的接线。
 *
 * 用户报:「退出时有些任务状态还在内存里没有及时存储到文件。」两条路各自都能单独造成它。
 */
describe('落盘的两条尾巴不能被剪断', () => {
  it('运行中改并发 / 改严格度之后立刻同步到盘上', () => {
    /**
     * 那两个键改的是 `RunControl`(纯内存),而它们进 run.md 的唯一通道是 `queueManifest`
     * 里的两句同步 —— 只在**某个节点提交状态**时才被调用。一个执行环节可以跑几分钟不提交,
     * 这期间调过的设置退出时就只在内存里,而 `--resume` 正是从 run.md 读回它们的。
     */
    expect(occurrences('orchRef.current?.syncToDisk()')).toBe(2)
  })
})

/**
 * 详情页 `g`:修复损毁的任务。**五跳,断一跳这个键就是死键。**
 *
 * 这一档的存在理由和上面那几个逐字相同:这个仓库反复出现「声明了却没接上」——
 * 组件写好、判据写好、测试全绿,而产品里那个键按下去什么都不会发生。
 */
describe('修复损毁的任务:g 键五跳都要接上', () => {
  const PANEL = readFileSync(new URL('./TaskTreePanel.tsx', import.meta.url), 'utf8')
  const DETAIL = readFileSync(new URL('./NodeDetail.tsx', import.meta.url), 'utf8')
  const RUNNER = readFileSync(new URL('./runOrchestrator.ts', import.meta.url), 'utf8')

  it('面板认这个键,并把节点交出去', () => {
    expect(`按键接了: ${PANEL.includes("k === 'g' && props.onRepairNode")}`).toBe('按键接了: true')
    expect(`prop 声明了: ${PANEL.includes('onRepairNode?: (node: TaskNode) => void')}`).toBe('prop 声明了: true')
  })

  it('页脚要宣告它 —— 一个没被宣告过的键等于不存在', () => {
    expect(`详情页收了: ${DETAIL.includes('canRepairNode')}`).toBe('详情页收了: true')
    expect(DETAIL).toContain('g 修复损毁的任务')
    expect(`面板传了: ${PANEL.includes('canRepairNode={props.onRepairNode !== undefined}')}`).toBe('面板传了: true')
  })

  it('phase 注册了,关口渲染得出来', () => {
    expect(`phase 声明了: ${RUNNER.includes("| 'confirmRepair'")}`).toBe('phase 声明了: true')
    expect(`关口渲染了: ${SRC.includes("phase === 'confirmRepair' && repairTarget")}`).toBe('关口渲染了: true')
  })

  it('运行视图和结束视图**都**接上 —— 只接一边的话另一边是死键', () => {
    expect(`running 接了: ${SRC.includes("setRepairFrom('running'); setPhase('confirmRepair')")}`)
      .toBe('running 接了: true')
    expect(`done 接了: ${SRC.includes("setRepairFrom('done'); setPhase('confirmRepair')")}`)
      .toBe('done 接了: true')
  })

  it('关口真的会去调 repairNode,而且带着实时输出窗', () => {
    expect(`调了: ${SRC.includes('repairNode(target, repairDeps(ac.signal), ac.signal, { skipModel })')}`)
      .toBe('调了: true')
    // 少了输出窗,那几分钟里「卡住了」和「正常跑」在屏幕上长得一模一样。
    expect(`输出窗接了: ${SRC.includes("phaseLabel: '修复任务'")}`).toBe('输出窗接了: true')
  })

  it('状态账接在生产落盘路径上 —— 少了它,阶段结果在磁盘满时就没了', () => {
    expect(`账建了: ${RUNNER.includes('createNodeJournal({ fs: args.fs, runDir: args.runDir })')}`)
      .toBe('账建了: true')
    expect(`persist 带上了: ${RUNNER.includes('writeNode(args.fs, args.runDir, n, journal)')}`)
      .toBe('persist 带上了: true')
  })
})

/**
 * **回溯(`b`)的接线不能被静默剪断。**
 *
 * 这一节存在的直接理由是一次现成的事故:写这个功能时 `runBacktrack` 在 `efftask.tsx` 里
 * **用了但没导入**,而全套 3635 条测试照绿 —— 那个文件挂不起来,没有任何东西会加载它。
 * 键位那一层有真按键探针(detailCtrlKeys),这里守的是它下游那几跳。
 */
describe('回溯键的接线', () => {
  it('两个视图都接了 —— 只接一处等于功能一半不存在', () => {
    // 主用例是「验收失败」,那通常发生在**结束屏**。
    expect(SRC).toContain(`setBacktrackFrom('running'); setPhase('confirmBacktrack')`)
    expect(SRC).toContain(`setBacktrackFrom('done'); setPhase('confirmBacktrack')`)
  })

  it('关口真的会去跑回溯,而且带着主模型那一步', () => {
    expect(SRC).toContain('await runBacktrack(')
    // 用了就必须导入 —— 那次事故的形状。
    expect(SRC).toContain(`from '../../tools/efftask/backtrackRun.js'`)
    expect(SRC).toContain('makeBacktrackMapper(')
    expect(SRC).toContain(`from '../../tools/efftask/handoffResolve.js'`)
  })

  /**
   * 主模型那一步是分钟级的。中止句柄要 chain 到 run 级 signal —— 少了它,Esc 关屏之后
   * 那次调用还在烧钱(`d` 键为同一件事接过一次)。
   */
  it('主模型那一步可以被中止', () => {
    expect(SRC).toContain('backtrackAbort')
    expect(SRC).toContain(`props.signal.addEventListener('abort', onRunAbort, { once: true })`)
  })
})
