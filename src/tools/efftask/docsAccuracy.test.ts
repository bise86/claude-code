import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rosterLines, skipConflictLines, skipConsequenceLines } from './startupConfirm'
import { clampParallelism, createNode, DEFAULT_CAPS, emptyPhaseRoles, MAX_GUIDANCE_CHARS, MAX_PARALLELISM, MAX_ROLE_GUIDANCE, MIN_PARALLELISM, PHASE_LABEL, PHASE_NAMES, SKIPPABLE_PHASES, type EffTaskConfig, type PhaseName, type TaskNode } from './types'
import { redoOptions, redoUnavailableReason } from './redo'
import { ROLE_API_PROTOCOLS, TRANSLATING_PROTOCOLS } from '../../services/api/openaiCompat/protocols'
import { toResponsesRequest } from '../../services/api/openaiCompat/toResponsesRequest'
import { parseRoleThinking, resolveRoleThinking, ROLE_THINKING_LEVELS } from '../AgentTool/roles/roleThinking'
import { modelSupportsEffort } from '../../utils/effort'
import { REASONING_FIELDS } from '../../services/api/openaiCompat/fromOpenAIStream'
import { logPaneAction, logPaneMode, runControlAction, sectionPaneAction, detailEntryHint, collapsedLinesFor } from '../../commands/efftask/logView'
import { detailSections, usageBody } from '../../commands/efftask/NodeDetail'
import { upstreamAdvice } from '../../services/api/openaiCompat/upstreamError'
import type { Key } from '../../ink/events/input-event'

/**
 * 文档必须说真话。
 *
 * 这道闸门是被一句**上线了的错话**逼出来的:roles-setup.md 第 44 行写着
 * 「没配角色的环节整个不发生」,而实际上七个环节里有五个会照跑(主模型顶上)。
 * 那句话在仓库里活了很久,因为**没有任何东西检查文档**——测试全绿,文档全错。
 *
 * 所以这里不做「文档里有没有这个词」的检查(那种断言删掉代码照样绿),而是把
 * 文档的说法**钉在代码的取值上**:改了代码里的后果描述、加了新的冲突提示、
 * 换了融合席位的挑法,文档不跟着改就红。
 */

const ROOT = new URL('../../../', import.meta.url)
const README = norm(readFileSync(new URL('README.md', ROOT), 'utf8'))
const ROLES_DOC = norm(readFileSync(new URL('docs/roles-setup.md', ROOT), 'utf8'))
const DOCS: [string, string][] = [
  ['README.md', README],
  ['docs/roles-setup.md', ROLES_DOC],
]

/** 代码里的注释用半角标点,文档用全角。比对前抹平,否则闸门只在跟标点较劲。 */
function norm(s: string): string {
  return s.replace(/,/g, '，').replace(/:/g, '：').replace(/;/g, '；').replace(/\(/g, '（').replace(/\)/g, '）')
}

const cfg = (skip: PhaseName[]): EffTaskConfig => ({
  goalPrompt: 'g', parallelism: 5, notices: [], skipSteps: skip,
  caps: { ...DEFAULT_CAPS },
  phaseRoles: emptyPhaseRoles(),
}) as unknown as EffTaskConfig

describe('文档说的和代码干的是同一件事', () => {
  it('每个环节被跳过的后果,两份文档都逐条写出来了', () => {
    // 关口把后果说给用户听,文档也必须说 —— 用户是先读文档再决定跳不跳的。
    for (const p of PHASE_NAMES) {
      // **真的调 rosterLines**,拿它渲染给用户的那一行。上一版是拿正则从源码里刮
      // SKIP_CONSEQUENCE 的字面量,于是把 rosterLines 里的跳过分支整行删掉 —— 关口对被
      // 跳过的环节什么都不说了 —— 这道闸门照样全绿。读源码的闸门证明不了接线。
      const line = norm(rosterLineFor(p))
      const core = line.replace(/^[^（]*（已跳过 —— /, '').replace(/）$/, '')
      expect(core.length).toBeGreaterThan(8)
      for (const [name, doc] of DOCS) {
        expect(`${name} 缺 ${PHASE_LABEL[p]}: ${doc.includes(core)}`).toBe(`${name} 缺 ${PHASE_LABEL[p]}: true`)
      }
    }
  })

  it('关口能弹出来的每一条冲突提示,文档里都有对应说法', () => {
    // 手写的映射:代码里的提示 → 文档里必须出现的那句话的核心。
    // 加了新的冲突规则却没登记在这里,下面那条穷举断言会红。
    // 片段太短会被**反话**满足:实测把第一条整句换成「这个组合完全没问题…验收根本
    // 跑不到也不影响结果,无需处理」,四个文件的断言全绿,因为反话里保留了那几个碎片。
    // 所以登记的是**判别句**——一句话里最不可能在改写后还留下的那部分。
    const REQUIRED: [RegExp, string][] = [
      [/验收席位仍会照常开会/, '验收席位仍会照常开会去核对这个空产出'],
      [/评审席位.*空方案/, '评审席位去评一份空方案'],
      [/不会有任何代码改动/, '不会有任何代码改动'],
      [/任务树基本只有根节点/, '任务树基本只有根节点'],
      [/不再评分/, '不再评分'],
    ]
    // 穷举 2^7 种跳过组合,收集关口所有可能说出口的话(两个块都算)。
    const produced = new Set<string>()
    for (let mask = 0; mask < 1 << PHASE_NAMES.length; mask++) {
      const skip = PHASE_NAMES.filter((_, i) => mask & (1 << i))
      for (const l of skipConflictLines(cfg(skip))) produced.add(norm(l))
      for (const l of skipConsequenceLines(cfg(skip))) produced.add(norm(l))
    }
    expect(produced.size).toBeGreaterThan(0)
    for (const msg of produced) {
      const hit = REQUIRED.find(([re]) => re.test(msg))
      // 未登记 = 代码新增了一条提示但没写进文档。
      expect(`未登记的关口提示: ${hit ? '无' : msg}`).toBe('未登记的关口提示: 无')
      for (const [name, doc] of DOCS) {
        expect(`${name} 缺「${hit![1]}」: ${doc.includes(hit![1])}`).toBe(`${name} 缺「${hit![1]}」: true`)
      }
    }
    // 反向:登记了却没有任何组合能触发 = 文档在描述一个不存在的提示。
    for (const [re, frag] of REQUIRED) {
      expect(`死规则「${frag}」: ${[...produced].some(m => re.test(m))}`).toBe(`死规则「${frag}」: true`)
    }
  })

  it('两份文档都讲清了「跳过」和「没配角色」不是一回事', () => {
    // 这正是上一版那句错话的内容。少了这层区分,用户会用「不配角色」去省调用,
    // 结果那一步照跑,只是换成主模型一个人干。
    for (const [name, doc] of DOCS) {
      expect(`${name}: ${/跳过\s*[≠!=]=?\s*没配角色|跳过和「?没配角色」?是两回事|没配角色的环节不是不发生/.test(doc)}`)
        .toBe(`${name}: true`)
      expect(`${name} 主模型顶上: ${doc.includes('主模型')}`).toBe(`${name} 主模型顶上: true`)
    }
    // 那句错话本身不许回来。
    expect(ROLES_DOC).not.toContain('没配角色的环节**整个不发生**')
    expect(ROLES_DOC).not.toContain('没配角色的环节就整个不发生')
  })

  it('文档写的配置键名就是代码真正读的那个', () => {
    const reader = readFileSync(new URL('src/tools/efftask/roleDefsFromSettings.ts', ROOT), 'utf8')
    expect(reader).toContain('efftaskSkipSteps')
    for (const [name, doc] of DOCS) {
      expect(`${name}: ${doc.includes('efftaskSkipSteps')}`).toBe(`${name}: true`)
    }
  })

  it('文档说的融合席位就是代码挑的那一席', () => {
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 文档承诺「融合席位是最后一席」。代码换成 seats[0] 而文档不改,用户就会
    // 把最强的员工排在末位,以为那个人在做融合。
    expect(src).toContain('seats[seats.length - 1]')
    expect(src).toContain("ctx.config.caps.planConverge === '圆桌'")
    for (const [name, doc] of DOCS) {
      expect(`${name} 最后一席: ${doc.includes('最后一席')}`).toBe(`${name} 最后一席: true`)
      expect(`${name} 落选稿: ${doc.includes('备选方案')}`).toBe(`${name} 落选稿: true`)
    }
  })
})

/** 关口名册里这一环节被跳过时的那一行 —— 真调 rosterLines 取。 */
function rosterLineFor(p: PhaseName): string {
  const line = rosterLines(cfg([p])).find(l => l.startsWith(`${PHASE_LABEL[p]}: `))
  if (!line) throw new Error(`关口名册里没有 ${PHASE_LABEL[p]} 这一行`)
  if (!line.includes('已跳过')) {
    throw new Error(`关口对被跳过的 ${PHASE_LABEL[p]} 说的是「${line}」—— 跳过分支没接上`)
  }
  return line
}

/**
 * README 的重做一节必须说真话。
 *
 * 和上面那些断言同一个理由:不查「文档里有没有这个词」(那种断言删掉代码照样绿),
 * 而是把文档的说法**钉在代码的取值上** —— 三个入口的名字、两条不可用原因、返工上限、
 * 中断后的那句话。改了代码,文档不跟着改就红。
 */
describe('README 的重做一节说的和代码干的是同一件事', () => {
  // 重做说明写在 README 里,不是单独一份文档 —— 用户要求的。
  const DOC = README
  const leaf = (over: Partial<TaskNode> = {}): TaskNode => ({
    ...createNode({
      id: 'root', title: 't', parentId: null, deps: [], depth: 0,
      phaseRoles: emptyPhaseRoles(), now: '2026-07-28T00:00:00Z',
    }),
    kind: 'executable',
    ...over,
  })

  it('三个入口的名字逐字对得上', () => {
    // 文档里写错一个名字,用户就会在屏幕上找一个不存在的条目。
    const n = leaf()
    for (const o of redoOptions(n, new Map([[n.id, n]]))) {
      expect(DOC).toContain(norm(o.label))
    }
  })

  it('两条「不可用」的原因逐字对得上', () => {
    const dec = leaf({ kind: 'decompose', childIds: ['root/00-a'] })
    const exec = redoOptions(dec, new Map([[dec.id, dec]])).find(o => o.entry === 'execute')!
    expect(DOC).toContain(norm(exec.disabled!))

    const lf = leaf()
    const integ = redoOptions(lf, new Map([[lf.id, lf]])).find(o => o.entry === 'integrate')!
    expect(DOC).toContain(norm(integ.disabled!))
  })

  it('返工上限写的是代码里的那个数', () => {
    // 「默认 3」改成别的值而文档不动,用户会按一个错的数去估算成本。
    expect(DOC).toContain(`默认 ${DEFAULT_CAPS.maxIterations}`)
  })

  it('中断后那句挡话,文档和代码是同一句', () => {
    const why = redoUnavailableReason({ aborted: true, runId: '<run id>' })!
    // 挑那半句可照做的命令 —— 它是用户真正会照抄的东西。
    expect(DOC).toContain(norm('/et --resume <run id>'))
    expect(why).toContain('/et --resume <run id>')
  })

  it('结构性损坏那三种理由,文档一个都不少', () => {
    // 少写一种,用户就会以为自己那种情况也能被重开。
    for (const r of ['依赖节点缺失', '子节点缺失', '依赖成环']) {
      expect(DOC).toContain(r)
    }
  })

  it('落盘三步的顺序,文档和代码一致', () => {
    expect(DOC).toContain('放隔离工作区 → 删子树 → 写节点')
  })
})

/**
 * 界面那一节写的键位,必须和真的按键处理函数是同一套。
 *
 * 键位说明在这个仓库里已经撒过一次谎:日志窗页脚写着「Tab 切换环节」,而 `logPaneAction`
 * 第三行就是 `if (key.tab) return null` —— Tab 早就让给区切换了,切流改成了 `n`,
 * 而页脚从没提过 `n`。那句话活了很久,因为没有任何东西核对过它。
 */
describe('README 的键位表和按键处理函数说的是同一件事', () => {
  const key = (over: Partial<Key> = {}): Key => ({
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
    home: false, end: false, return: false, escape: false, ctrl: false,
    shift: false, fn: false, tab: false, backspace: false, delete: false,
    meta: false, super: false, ...over,
  })

  it('说 ←→ 换页卡,那 ←→ 就得真的产出换页卡的动作', () => {
    expect(README).toContain(norm('| `←` / `→` | 换页卡 |'))
    expect(sectionPaneAction('', key({ leftArrow: true }))?.t).toBe('tab')
    expect(sectionPaneAction('', key({ rightArrow: true }))?.t).toBe('tab')
  })

  it('说 Tab 切焦点区,那 Tab 就不能同时还归日志窗', () => {
    expect(README).toContain(norm('焦点在「页签条」和「内容区」之间切'))
    expect(sectionPaneAction('', key({ tab: true }))?.t).toBe('switchZone')
    // 日志窗必须放手,否则一个 Tab 会同时干两件事(两个 useInput 都收得到每个键)。
    expect(logPaneAction('', key({ tab: true }))).toBeNull()
  })

  it('说 n 换流,那 n 就得真的换流 —— 而且页脚以前从没提过它', () => {
    expect(README).toContain(norm('| `n` | 输出页卡换一条流 |'))
    expect(logPaneAction('n', key())?.t).toBe('nextStream')
  })

  it('说 ^u/^d 翻页,那它们就得归段落区,而不是被日志窗吃掉', () => {
    expect(README).toContain(norm('| `^u` / `^d` | 任务页卡翻页 |'))
    expect(sectionPaneAction('u', key({ ctrl: true }))?.t).toBe('scroll')
    expect(sectionPaneAction('d', key({ ctrl: true }))?.t).toBe('scroll')
  })

  it('说「焦点在页签条上时回车/空格进入内容」,那这两个键就不能是死键', () => {
    /**
     * 这一行一度**只写在 README 和页脚上**:`sectionPaneAction` 不认回车,
     * `NodeDetail` 的内容区闸门又把空格挡了,而 `TaskTreePanel` 已经为这一下回车让了路 ——
     * 于是它既不进内容、也不返回,彻底消失。两份验收各自独立报了同一条。
     * 这条闸门当时逐条钉了 ←→/Tab/n/^u^d/Esc/鼠标,**唯独漏掉了这一行**。
     */
    expect(README).toContain(norm('焦点在「页签条」和「内容区」之间切；焦点在页签条上时回车/空格进入内容'))
    expect(sectionPaneAction('', key({ return: true }))?.t).toBe('enterContent')
    expect(sectionPaneAction(' ', key())?.t).toBe('toggle')
    // 日志窗必须对回车放手,否则两个 handler 会为它打架。
    expect(logPaneAction('', key({ return: true }))).toBeNull()
  })

  it('说折叠预览是「掐头留尾」,那预算就得留得下三行', () => {
    // 只给 2 行时 head=0,每段都长成「… 中间省略 N 行」+ 一条从中间切开的碎片。
    expect(README).toContain(norm('跑完的流默认是折叠的'))
    expect(collapsedLinesFor(6)).toBeGreaterThanOrEqual(3)
  })

  it('说「窄终端会退化成 鼠标✗」,那就得真的有这个降级', () => {
    expect(README).toContain(norm('窄终端上那里也放不下整句时会退化成 `鼠标✗`'))
    expect(readFileSync(new URL('src/commands/efftask/NodeDetail.tsx', ROOT), 'utf8')).toContain('鼠标✗')
  })

  it('说「任何时候都能返回」,那 Esc 就不能被这两个处理函数截走', () => {
    expect(README).toContain(norm('**任何时候都能返回**'))
    // Esc 归任务树面板(它负责关掉详情页)。这两个都必须放手。
    expect(logPaneAction('', key({ escape: true }))).toBeNull()
    expect(sectionPaneAction('', key({ escape: true }))).toBeNull()
  })

  it('说 ↑↓ 在输出页卡分两种含义,那 logPaneAction 就得真的分模式', () => {
    /**
     * 这一条守的是同一类谎的第三次(前两次:日志窗页脚写「Tab 切换环节」而 Tab 早就让给了
     * 区切换;页签条写着回车进入而代码里没有分支接住)。README 现在写着「折叠着的那条流
     * 选阶段,展开着的滚内容」,那两种模式就必须真的存在。
     */
    expect(README).toContain(norm('输出页卡：**折叠着的那条流选阶段，展开着的滚内容**'))
    expect(logPaneAction('', key({ downArrow: true }), 'select')?.t).toBe('selectStream')
    expect(logPaneAction('', key({ downArrow: true }), 'read')?.t).toBe('line')
    expect(logPaneAction('j', key(), 'select')?.t).toBe('selectStream')
  })

  it('说滚轮和 g/G 两种模式下一样,那它们就不能跟着模式变', () => {
    // 一格滚轮是 3 行,当成「往下跳 3 条流」的话轻轻一拨就飞过整个列表。
    expect(README).toContain(norm('一格滚轮是 3 行，当成「往下跳 3 条流」的话轻轻一拨就飞过整个列表'))
    expect(logPaneAction('', key({ wheelDown: true }), 'select')).toEqual({ t: 'line', d: 3 })
    expect(logPaneAction('G', key(), 'select')?.t).toBe('bottom')
    expect(logPaneAction('u', key({ ctrl: true }), 'select')?.t).toBe('halfPage')
  })

  it('说折叠状态决定 ↑↓ 归谁,那判据就得是折叠状态本身', () => {
    // 另存一个模式变量的话,一条跑完自动折起来的流会让 ↑↓ 变成死键(它停在「滚内容」,
    // 而屏幕上只剩一行表头)。
    expect(logPaneMode(new Set([0]), 0, 2)).toBe('select')
    expect(logPaneMode(new Set([1]), 0, 2)).toBe('read')
  })

  it('说 +/- 调并发、一次一步、= 和 _ 也认,那按键处理就得照办', () => {
    expect(README).toContain(norm('| **调并发上限**'))
    expect(README).toContain(norm('也认，因为'))
    for (const k of ['+', '=']) expect(runControlAction(k, {})).toBe('raiseParallelism')
    for (const k of ['-', '_']) expect(runControlAction(k, {})).toBe('lowerParallelism')
    // 一次一步:终端把按住 300ms 合批成一个五连加是常事,而每一步都会真的多派一个
    // 带写工具的执行者出去。
    expect(README).toContain(norm('时**只走一步**'))
    expect(runControlAction('+++++', {})).toBe('raiseParallelism')
  })

  it('说并发范围 1–64,那夹取就得是同一个区间', () => {
    // 这个数在 README、parseDirectives、启动关口编辑器、运行中调整四处出现过,而
    // 「1–64」这句话是用户唯一读得到的那一份。
    expect(README).toContain(norm('一次一步，范围 1–64'))
    expect(MIN_PARALLELISM).toBe(1)
    expect(MAX_PARALLELISM).toBe(64)
    expect(clampParallelism(0)).toBe(MIN_PARALLELISM)
    expect(clampParallelism(999)).toBe(MAX_PARALLELISM)
  })

  it('说「下限是 1,不是 0」,那 0 就得被夹成 1', () => {
    expect(README).toContain(norm('**下限是 1**，不是 0'))
    expect(clampParallelism(0)).toBe(1)
  })

  it('说 R/s 只对失败节点,而且四个环节能跳,那判据就得是同一份', () => {
    expect(README).toContain(norm('直接重做**失败的那个环节**'))
    expect(README).toContain(norm('**跳过**失败的那个环节，继续往下走'))
    // 能跳的只有那四个 —— README 的表格里,分析/执行/观察三行都写着「不可用」。
    expect([...SKIPPABLE_PHASES].sort()).toEqual(['accept', 'integrate', 'review', 'verify'])
    for (const p of ['plan', 'execute', 'observer']) {
      expect(SKIPPABLE_PHASES.has(p)).toBe(false)
    }
  })

  it('说失败点是「记下来,不反推」,那 TaskNode 上就得真有这个字段', () => {
    expect(README).toContain(norm('它正处在哪个状态就记在'))
    const types = readFileSync(new URL('src/tools/efftask/types.ts', ROOT), 'utf8')
    expect(types).toContain('failedAt?: NodeStatus')
    /**
     * 「它只在节点自己失败时记」这半句**不在这里测**。
     *
     * 原来这里 grep 的是 orchestrator.ts 里的一句注释,而验收一针见血:grep 注释证明不了
     * 接线 —— 把那一行清理代码删掉、注释留着,这条断言照样绿(实测存活)。行为归
     * failedPhase.test.ts 里那几条「被牵连的阻断要清掉过期的失败点」,它们真的跑
     * propagateBlocked / planRedo / reseat。这里只留字段声明这一条源码断言。
     */
  })

  it('说跳过验收/测试验证时执行不重跑,那 pipeline 里就得有那条豁免', () => {
    expect(README).toContain(norm('**跳过测试验证 / 验收时执行环节不重跑**'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    expect(src).toContain('if (!enterAtJudge) {')
    // 只作用于第一轮:返工轮必须真的从执行者开始。
    expect(src).toContain('enterAtJudge = false')
  })

  it('说定向注入的两个字段会写进 run.md 并读回,那两侧就都得有它们', () => {
    expect(README).toContain(norm('会写进'))
    expect(README).toContain(norm('时读回来'))
    const write = readFileSync(new URL('src/tools/efftask/persistence.ts', ROOT), 'utf8')
    const read = readFileSync(new URL('src/tools/efftask/resumeCore.ts', ROOT), 'utf8')
    for (const f of ['phaseGuidance', 'roleGuidance']) {
      expect(write).toContain(f)
      expect(read).toContain(f)
    }
  })

  it('说裁决席位额外读哪一条,那分流表就得逐字对得上', () => {
    /**
     * README 那张表说的是「质疑讨论读分析那条,验收/测试验证/集成验收/观察读执行那条」。
     * 原来两边写的都是「看得到**全部**」,而成本评审量出来那是 18× 放大 —— 一半用不上
     * (评审判方案时一行代码都还没写)。所以文档和代码都收窄了,这条闸门跟着改。
     */
    expect(README).toContain(norm('**裁决类环节会额外读到「它判的那件事」对应的那条指引**'))
    expect(README).toContain(norm('| 质疑讨论 | **方案**（那时一行代码都还没写） | 给「分析」的那条 |'))
    expect(README).toContain(norm('| 测试验证 / 验收 / 集成验收 / 观察 | **产出** | 给「执行」的那条 |'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 哪些环节算「裁决」(决定要不要加那句「按补充后的意图判」)。
    expect(src).toContain("new Set<PhaseName>(['review', 'verify', 'accept', 'integrate', 'observer'])")
    // 而**读哪一条**是另一张表 —— 两张表分开,因为「是不是裁决」和「判的是什么」是两件事。
    expect(src).toContain("    review: 'plan',")
    expect(src).toContain("    verify: 'execute', accept: 'execute', integrate: 'execute', observer: 'execute',")
  })

  it('说每条指引 2000 字上限、角色指引最多 20 条,那代码里就得是这两个数', () => {
    // 这两个数是用户唯一读得到的那一份,而它们在 parseDirectives、resumeCore 两处夹取。
    expect(README).toContain(norm('每条指引上限 2000 字、点名给角色的最多 20 条'))
    expect(MAX_GUIDANCE_CHARS).toBe(2000)
    expect(MAX_ROLE_GUIDANCE).toBe(20)
  })

  it('说「只在真的能点时才写回车/点击」,那文案就得跟着可用性变', () => {
    expect(README).toContain(norm('只在真的能点时才写「回车/点击看详情」'))
    expect(detailEntryHint('on')).toContain('点击')
    expect(detailEntryHint('needs-fullscreen')).not.toContain('点击')
  })
})

describe('README 列的推理字段名,和协议转换层认的是同一份', () => {
  it('每一个列出来的字段名都真的被认', () => {
    // 少认一个方言 = 那一批后端的思考整段丢失,而且是**静默**的 —— 用户只会看到
    // 「这个员工不会思考」。所以文档和名单必须锁在一起。
    for (const f of ['reasoning_content', 'reasoning']) {
      expect(`README 提到 ${f}: ${README.includes(f)}`).toBe(`README 提到 ${f}: true`)
      expect(`名单里有 ${f}: ${(REASONING_FIELDS as readonly string[]).includes(f)}`).toBe(`名单里有 ${f}: true`)
    }
  })

  it('说了「不需要配 thinkingDepth」,那就不能反过来在别处要求配', () => {
    expect(README).toContain(norm('不需要配 `thinkingDepth`'))
    for (const [name, doc] of DOCS) {
      expect(`${name} 有没有说「想看到思考就得配 thinkingDepth」: ${doc.includes(norm('想看到思考就得配'))}`)
        .toBe(`${name} 有没有说「想看到思考就得配 thinkingDepth」: false`)
    }
  })
})

/**
 * 员工协议与思考级别:文档说的和代码干的是同一件事。
 *
 * 这一节是被两句**已经上线的错话**逼出来的,而且它们互相矛盾:
 * `roles-setup.md` 写着「thinkingDepth 仅 Anthropic 协议支持」,README 同时写着它在
 * openai 上译成 `reasoning_effort` —— 两份已发布文档在同一件事上说反话,而闸门只钉住了
 * README 那一半。
 */
describe('员工协议与思考级别', () => {
  it('三种协议名两份文档都列全 —— 少写一个,用户就配不出来', () => {
    for (const [name, doc] of DOCS) {
      for (const p of ROLE_API_PROTOCOLS) {
        expect(`${name} 列了 ${p}: ${doc.includes(p)}`).toBe(`${name} 列了 ${p}: true`)
      }
    }
  })

  it('「仅 Anthropic 协议支持」这句已经作废,不许留在任何一份文档里', () => {
    for (const [name, doc] of DOCS) {
      expect(`${name} 还留着那句话: ${doc.includes(norm('思考深度（仅 Anthropic 协议支持）'))}`)
        .toBe(`${name} 还留着那句话: false`)
    }
  })

  it('五个档位逐字对得上代码里的那个列表', () => {
    // 文档少写一档,用户就不会去用它;多写一档,他配了会被静默忽略。
    for (const l of ROLE_THINKING_LEVELS) {
      expect(`roles-setup 列了 ${l}: ${ROLES_DOC.includes(l)}`).toBe(`roles-setup 列了 ${l}: true`)
    }
  })

  it('翻译规则,文档写的方向和代码一致', () => {
    // xhigh 两边都收;只有 max 是 Anthropic 独有的,OpenAI 侧译成 xhigh。
    const a = resolveRoleThinking({ level: 'xhigh', protocol: 'anthropic', model: 'claude-opus-4-6-x' })
    expect(a.value).toBe('xhigh')
    expect(ROLES_DOC).toContain(norm('| `xhigh` | 原样发 | 原样发 |'))

    const o = resolveRoleThinking({ level: 'max', protocol: 'openai-responses', model: 'gpt-5.1' })
    expect(o.value).toBe('xhigh')
    expect(ROLES_DOC).toContain(norm('**译成 xhigh**'))
  })

  it('「数字只有 anthropic 收」这句是真的', () => {
    expect(resolveRoleThinking({ level: 120, protocol: 'openai', model: 'gpt-5.1' }).value).toBeUndefined()
    expect(resolveRoleThinking({ level: 120, protocol: 'anthropic', model: 'claude-opus-4-6-x' }).value).toBe(120)
    expect(ROLES_DOC).toContain(norm('**不发**（OpenAI 只收档位名）'))
  })

  it('文档不能再说「大小写错误会被忽略」—— 解析是大小写不敏感的', () => {
    expect(parseRoleThinking('HIGH')).toBe('high')
    for (const [name, doc] of DOCS) {
      expect(`${name} 还说大小写会被忽略: ${doc.includes(norm('`\'deep\'`、大小写错误等'))}`)
        .toBe(`${name} 还说大小写会被忽略: false`)
    }
  })

  it('文档里那个「配 thinkingDepth」的 anthropic 示例,模型必须真的支持 effort', () => {
    /**
     * 原来配的是 claude-3-5-sonnet-20241022 + thinkingDepth:"max" —— 而
     * configureEffortParams 的第一句就是 `if (!modelSupportsEffort(model)) return`,
     * 那份示例做不到它自己写的事,而屏幕上一句提示都没有。
     */
    // norm() 把 ASCII 冒号换成了全角,所以这里按全角匹配 —— 按 ASCII 写的话正则永远
    // 不命中,而「找不到示例」会被当成通过,这条断言就成了一句永远为真的话。
    const m = ROLES_DOC.match(/"model"：\s*"(claude[^"]+)"，\s*"thinkingDepth"/)
    expect(`找到了那个示例: ${m !== null}`).toBe('找到了那个示例: true')
    expect(`${m![1]} 支持 effort: ${modelSupportsEffort(m![1])}`).toBe(`${m![1]} 支持 effort: true`)
  })

  it('Responses 那三个请求字段,文档说的和代码发的一致', () => {
    const body = toResponsesRequest({ messages: [] }, { backendModel: 'gpt-5.1', effort: 'high' }) as any
    expect(body.store).toBe(false)
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.reasoning.summary).toBe('auto')
    for (const s of ['store: false', 'reasoning.encrypted_content', "summary: 'auto'"]) {
      expect(`README 或 roles-setup 提到 ${s}: ${README.includes(norm(s)) || ROLES_DOC.includes(norm(s))}`)
        .toBe(`README 或 roles-setup 提到 ${s}: true`)
    }
  })
})

/**
 * 排查表里引用的那几句关口提示,必须**逐字**是代码会说的话。
 *
 * 这一节守的是一种很具体的假文档:排查指引让用户「对着关口上写的那句话查表」,
 * 而表里的句子和代码里的字符串对不上 —— 于是他在表里找不到自己看到的那句,
 * 而这张表存在的全部理由就是让他查得到。
 */
describe('思考级别排查表和代码说同一句话', () => {
  it('xhigh 在 anthropic 上不该有话说 —— 它是原样发的', () => {
    // 排查表里如果还留着一句「已按 high 发送」,用户会照着它去换协议,而根本不用换。
    expect(resolveRoleThinking({ level: 'xhigh', protocol: 'anthropic', model: 'claude-opus-4-6' }).note).toBeUndefined()
    expect(ROLES_DOC).not.toContain(norm('思考级别 xhigh：Anthropic 协议没有这一档'))
  })

  it('max 在 OpenAI 系上被译成 xhigh 那句', () => {
    const note = resolveRoleThinking({ level: 'max', protocol: 'openai-responses', model: 'gpt-5.1' }).note!
    expect(ROLES_DOC).toContain(norm(note))
  })

  it('数字档那句(表里夹了省略号,所以对头一截)', () => {
    const note = resolveRoleThinking({ level: 120, protocol: 'openai', model: 'gpt-5.1' }).note!
    expect(ROLES_DOC).toContain(norm(note.slice(0, note.indexOf('('))))
  })

  it('模型不支持 effort 那句(模型名是变量,所以对稳定的那一截)', () => {
    const note = resolveRoleThinking({ level: 'max', protocol: 'anthropic', model: 'claude-3-5-sonnet-20241022' }).note!
    expect(note).toContain('不支持 effort 参数')
    expect(ROLES_DOC).toContain(norm('不支持 effort 参数，本次不会发送思考级别'))
  })

  it('别名会先解析成全名再判能力 —— 文档承诺了这件事', () => {
    // 不解析的话 `model: "opus"` 会得到一句「模型 opus 不支持 effort 参数」的假话,
    // 同时把用户配的档位静默丢掉。
    expect(resolveRoleThinking({ level: 'high', protocol: 'anthropic', model: 'opus' }).value).toBe('high')
    expect(ROLES_DOC).toContain(norm('模型名写**别名**（`opus`）也可以，判定前会先解析成全名'))
  })

  it('三条协议的路由,文档写的和注册表一致', () => {
    for (const [name, proto] of Object.entries(TRANSLATING_PROTOCOLS)) {
      expect(`${name} 的路由 ${proto.route} 在文档里: ${ROLES_DOC.includes(norm(`{apiUrl}/${proto.route}`))}`)
        .toBe(`${name} 的路由 ${proto.route} 在文档里: true`)
    }
  })
})

describe('README 的 markdown 与用量两节说的和代码干的是同一件事', () => {
  /** 一个每一段都非空的节点 —— detailSections 会滤掉空段落。 */
  const rich = (): TaskNode => {
    const n = createNode({ id: 'root', title: 't', goal: 'g', parentId: null, deps: ['x'], depth: 0, phaseRoles: emptyPhaseRoles(), now: new Date().toISOString() })
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    n.execStatus = 'e'
    n.blockedReason = 'b'
    n.score = { plan: { role: 'x', score: 80, rationale: 'y' } }
    n.iteration = { planReview: 1, acceptance: 0, integration: 0, scoring: 0, mergeResolve: 0 }
    n.phaseMs = { EXECUTING: 42_000 }
    n.usage = { calls: 3, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }
    n.worktree = { branch: 'b', path: '/p' }
    n.reviewLog = [{ round: 1, verdicts: [], synthesized: { pass: true, blockingSummary: '' } }]
    n.acceptLog = [...n.reviewLog]
    n.childIds = ['root/01-a']
    return n
  }

  it('哪几段上 markdown、哪几段不上,文档列的就是代码标的', () => {
    /**
     * 这条闸门要挡的是**两句都可能变成假话**的承诺:一句「这几段上色」,一句
     * 「这几段一个记号都不动」。后者尤其要紧 —— 它是 `--flag` 和 `[STATUS]` 不被
     * markdown 吃掉的全部保证,而给某一段顺手加个 `md: true` 是零反馈的。
     */
    const secs = detailSections(rich(), () => undefined)
    expect(secs.length).toBeGreaterThan(10)
    const md = secs.filter(x => x.md === true).map(x => x.title)
    const plain = secs.filter(x => x.md !== true).map(x => x.title)
    expect(md.length).toBeGreaterThan(0)
    expect(plain.length).toBeGreaterThan(0)
    // 文档里那两行列表,逐个段落名对。
    const mdLine = README.split('\n').find(l => l.includes('按 markdown 上色'))!
    for (const t of md) expect(`上色段落 ${t} 在文档那一行里：${mdLine.includes(t)}`).toBe(`上色段落 ${t} 在文档那一行里：true`)
    const plainLine = README.split('\n').find(l => l.includes('一个记号都不动'))!
    for (const t of plain) expect(`原样段落 ${t} 在文档那一行里：${plainLine.includes(t)}`).toBe(`原样段落 ${t} 在文档那一行里：true`)
    // 反向:上色的那几段不许出现在「原样」那一行里,否则两行互相打脸而测试照样绿。
    for (const t of md) expect(`${t} 不在原样那一行：${!plainLine.includes(t)}`).toBe(`${t} 不在原样那一行：true`)
  })

  it('用量那两行的标签,文档抄的就是代码产的', () => {
    const kid = { ...rich(), id: 'root/01-a', childIds: [] as string[] }
    const body = usageBody(rich(), (id: string) => (id === kid.id ? kid as TaskNode : undefined))
    for (const label of ['本节点', '含 1 个子任务(整棵子树)合计']) {
      expect(body).toContain(label)
    }
    // README 用的是「含 3 个子任务合计」的示例,数字是变量,所以对稳定的两截。
    expect(README).toContain(norm('本节点：'))
    expect(README).toContain(norm('个子任务（整棵子树）合计：'))
  })

  it('上游报错的排查表,每一行都对得上 upstreamAdvice 真正会说的话', () => {
    // 这张表是用户拿着一个 502 来查的第一个地方。它和代码分家的话,人会照着一条
    // 不存在的建议去改配置。
    const cases: [number, string][] = [
      [401, 'apiToken'], [403, 'apiToken'],
      [404, 'apiUrl'], [405, 'apiUrl'],
      [400, 'model'], [422, 'model'],
      [429, 'caps.maxSeatsPerPhase'],
      // 502 不再指向路由 —— 网关缺路由回的是 404,那句断言是编的(评审用真 socket 戳穿)。
      [502, '重试'],
    ]
    for (const [status, key] of cases) {
      const advice = upstreamAdvice({ status, protocol: 'openai-responses' })
      expect(`${status} 的建议提到 ${key}：${advice.includes(key)}`).toBe(`${status} 的建议提到 ${key}：true`)
      expect(`${status} 这一档在文档表里：${ROLES_DOC.includes(norm(key))}`).toBe(`${status} 这一档在文档表里：true`)
    }
    // 「200 但不是 SSE」那一档:文档写的和代码里的措辞是同一个。
    expect(ROLES_DOC).toContain(norm('200 但不是 SSE'))
    expect(upstreamAdvice({ status: 200, protocol: 'openai', notStreamed: true })).toContain('流式')
    // 空体 5xx 和带内容的 5xx 在文档里是**两行**,因为代码给的是两句话。
    expect(upstreamAdvice({ status: 502, protocol: 'openai', emptyBody: true }))
      .not.toBe(upstreamAdvice({ status: 502, protocol: 'openai' }))
    expect(ROLES_DOC).toContain(norm('`5xx` **带内容**'))
    expect(ROLES_DOC).toContain(norm('`5xx` **空体**'))
    // 连不上是单独一档,而且以前压根走不到。
    expect(upstreamAdvice({ status: 0, protocol: 'openai', connectFailed: true })).toContain('代理')
    expect(ROLES_DOC).toContain(norm('| **连不上** |'))
    // 「一个字节都没返回」和「不是 SSE」给的是两句不同的话。
    expect(upstreamAdvice({ status: 200, protocol: 'openai', emptyStream: true }))
      .not.toBe(upstreamAdvice({ status: 200, protocol: 'openai', notStreamed: true }))
    expect(ROLES_DOC).toContain(norm('200 但一个字节都没返回'))
  })
})
