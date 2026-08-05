import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parallelismLine, rosterLines, skipConflictLines, skipConsequenceLines } from './startupConfirm'
import { clampParallelism, createNode, DEFAULT_CAPS, emptyPhaseRoles, MAX_GUIDANCE_CHARS, MAX_PARALLELISM, MANUAL_PASS_ROLE, MAX_ROLE_GUIDANCE, MIN_PARALLELISM, PHASE_LABEL, PHASE_NAMES, SKIPPABLE_PHASES, type EffTaskConfig, type PhaseName, type TaskNode } from './types'
import { forcePassFailedPhaseReason, planForcePass, planSkip, redoOptions, redoUnavailableReason, skipFailedPhaseReason } from './redo'
import { planFinish } from './finishHandoff'
import { createRateLimitGate } from './rateLimitGate'
import { TOTAL_LIMIT_FACTOR } from './runAgentAdapter'
import type { PendingHandoff } from './types'

/** 一条跑完了、有提交的待收口记录。 */
const handoffFixture = (over: Partial<PendingHandoff> = {}): PendingHandoff => ({
  branch: 'efftask/001/integration', commits: 3, kept: [], salvage: [], outcome: 'completed', ...over,
})
import { ROLE_API_PROTOCOLS, TRANSLATING_PROTOCOLS } from '../../services/api/openaiCompat/protocols'
import { toResponsesRequest } from '../../services/api/openaiCompat/toResponsesRequest'
import { toOpenAIRequest } from '../../services/api/openaiCompat/toOpenAIRequest'
import { parseRoleThinking, resolveRoleThinking, ROLE_THINKING_LEVELS } from '../AgentTool/roles/roleThinking'
import { modelSupportsEffort } from '../../utils/effort'
import { REASONING_FIELDS } from '../../services/api/openaiCompat/fromOpenAIStream'
import { logPaneAction, logPaneMode, runControlAction, sectionPaneAction, sectionPaneMode, detailEntryHint, collapsedLinesFor } from '../../commands/efftask/logView'
import { detailSections, usageBody } from '../../commands/efftask/NodeDetail'
import { createRunControl } from './control'
import { serializeNode } from './persistence'
import { stepExecute } from './pipeline'
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

  it('说 n 换一项且两种模式下都认,那两个页卡都得真的认它', () => {
    expect(README).toContain(norm('| `n` | 下一项：任务页卡换一段，输出页卡换一条流。**两种模式下都认**'))
    expect(logPaneAction('n', key())?.t).toBe('nextStream')
    expect(logPaneAction('n', key(), 'select')?.t).toBe('nextStream')
    // 段落区的 n 此前是死键。read 模式下它是唯一不用先收起就能换段落的键。
    expect(sectionPaneAction('n', key())?.t).toBe('nextSection')
    expect(sectionPaneAction('n', key(), 'read')?.t).toBe('nextSection')
  })

  it('说两个页卡的 ↑↓ 是同一条规矩,那段落区就得真的分模式', () => {
    /**
     * 这张表原来写的是「任务页卡:选段落」—— 而用户的要求正是把它改成和输出页卡一样。
     * 少了这一条断言,把 `sectionPaneAction` 的 mode 分支删掉之后全套测试照样绿,而
     * README 会继续描述一个不存在的行为(这个文件顶部记的就是这类谎)。
     */
    expect(README).toContain(norm('**两个页卡同一条规矩**：折叠着的那一项选段落 / 选阶段，展开着的滚它的内容'))
    expect(sectionPaneAction('', key({ downArrow: true }), 'select')?.t).toBe('move')
    expect(sectionPaneAction('', key({ downArrow: true }), 'read')?.t).toBe('line')
    expect(sectionPaneAction('j', key(), 'read')?.t).toBe('line')
    // 派生自展开状态,不是另一个开关 —— 和输出页卡同一个判据。
    expect(sectionPaneMode(new Set(['目标']), [{ title: '目标' }], 0, true)).toBe('read')
    expect(sectionPaneMode(new Set(), [{ title: '目标' }], 0, true)).toBe('select')
  })

  it('说空格展开之后 ↑↓ 归内容,那滚不动的那一段就不能进 read', () => {
    expect(README).toContain(norm('展开之后 `↑↓` 就归内容'))
    // 一段只有一行时 maxFrom 是 0:判成滚动 = 按下去屏幕一个字不动。
    expect(sectionPaneMode(new Set(['目标']), [{ title: '目标' }], 0, false)).toBe('select')
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
    expect(README).toContain(norm('折叠着的那一项选段落 / 选阶段，展开着的滚它的内容'))
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

  it('说第 2 轮起不许换一批新理由,那四关就得**都**接上那条护栏', () => {
    expect(README).toContain(norm('四个裁决环节（质疑讨论／测试验证／验收／集成验收）从第 2 轮开始都会收到同一条护栏'))
    // README 说的是「都」。护栏原来只挂在质疑讨论上,而执行侧那三关一条都没有 ——
    // 只 grep 一处的话,这条断言在退化回去之后照样绿。
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 三关都接上了,而且**都**走 notice 门控 —— 「有账才立规矩」。少一处门控就是把护栏
    // 接到一个没有旧账的关口上,那是验收查出来的反向失败(护栏变封嘴),见 verifyPrompt
    // 里那一大段。所以这里数的是带门控的那个形状,不是裸的 repeatRule。
    expect(src.split('notice ? repeatRule(strict, round').length - 1).toBe(3) // verify / accept / integrate
    expect(src).not.toContain('\n    repeatRule(strict, round)')
    const strict = readFileSync(new URL('src/tools/efftask/strictness.ts', ROOT), 'utf8')
    expect(strict).toContain('export function repeatRule')          // 质疑讨论走 reviewRubric
    expect(strict).toContain('reviewRubric(s: Strictness | undefined, round: number)')
    // 专家档是举证责任,不是豁免 —— README 明说了这一条
    expect(README).toContain(norm('专家档拿到的不是豁免而是**举证责任**'))
    expect(strict).toContain('每提一条都要写明为什么上一轮没提')
  })

  it('README 说「答卷只在有问卷时才出现、护栏只在有旧账时才生效」,代码里就得有那两道门', () => {
    expect(README).toContain(norm('**答卷只在有问卷时才出现，护栏只在有旧账时才生效。**'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 门一:护栏跟着本关自己的旧账走。三关都要,少一处就是把护栏接到没有旧账的关口上
    // —— 那是护栏变封嘴的那个反向失败。
    expect(src.split('notice ? repeatRule(strict, round').length - 1).toBe(3)
    expect(src).not.toContain('\n    repeatRule(strict, round)')
    // 门二:答卷跟着旧账走 + 轮次各关自己数
    expect(src).toContain('!hasReworkHistory(node)')
    expect(src).toContain('function gateRound')
    expect(src).toContain("gateRound(node, 'verify')")
    expect(src).toContain("gateRound(node, 'accept')")
    // 门三:第 1 轮不收(两侧各一处)
    expect(src).toContain('feedback && out.responses.length > 0')
    expect(src).toContain('if (!feedback) delete node.plan.responses')
    // 预算和轮次是两个数,README 说了会分开讲
    expect(README).toContain(norm('返工预算也各记各的'))
    expect(src).toContain('测试验证与验收各记各的')
  })

  it('README 说集成验收是例外,那 repeatRule 就得真的收得下这个例外', () => {
    expect(README).toContain(norm('它两轮之间证据一个字都不会变'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    expect(src).toContain('repeatRule(strict, round, false)')
    const strict = readFileSync(new URL('src/tools/efftask/strictness.ts', ROOT), 'utf8')
    expect(strict).toContain('evidenceChanged = true')
    expect(strict).toContain('if (!evidenceChanged) {')
    // 例外那一支**不许**含「改了就该判通过」—— 那正是它存在的理由
    const branch = strict.slice(strict.indexOf('if (!evidenceChanged) {'), strict.indexOf('return `- **不要提出上一轮没有提过的新要求**,除非那是这一版新引入的缺陷。'))
    expect(branch).not.toContain('就该判通过')
    expect(branch).toContain('与上一轮**完全相同**')
  })

  it('说返工时要逐条回应,那两侧就得**各有一个字段**接得住这份答卷', () => {
    expect(README).toContain(norm('方案作者和执行者都会被要求逐条回应上一轮的每一条阻断意见'))
    const types = readFileSync(new URL('src/tools/efftask/types.ts', ROOT), 'utf8')
    expect(types).toContain('responses?: string[]')
    expect(types).toContain('execResponses?: string[]')
    // 「会落进 node.md」这句话:body 里得真有这两节,否则人打开文件什么都看不到
    const pers = readFileSync(new URL('src/tools/efftask/persistence.ts', ROOT), 'utf8')
    expect(pers).toContain('## 方案:对上一轮质疑讨论意见的逐条处置')
    expect(pers).toContain('## 执行:对上一轮测试验证/验收意见的逐条处置')
    // 「核对是否属实」而不是「他说改了就算改了」—— 这半句是 load-bearing 的
    expect(README).toContain(norm('核对是否属实'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    expect(src).toContain('作者说了不等于做了')
    expect(src).toContain('要核对是否属实,不是通过的依据')
  })

  it('说跳过验收/测试验证时执行不重跑,那 pipeline 里就得有那条豁免', () => {
    expect(README).toContain(norm('**跳过测试验证 / 验收时执行环节不重跑**'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    expect(src).toContain('if (!enterAtJudge) {')
    // 只作用于第一轮:返工轮必须真的从执行者开始。
    expect(src).toContain('enterAtJudge = false')
  })

  it('说「流式增量算有输出」,那 /et 就得真的把 delta 接进静默时钟', () => {
    /**
     * 用户报的原话:「用 API 调用一个模型老是报错,是不是超时时间太短了。这个模型用做
     * 主模型是正常的。」根因不是那个数太小,是这条时钟量错了东西 —— `runAgent` 只 yield
     * 完整消息,思考期间的 `stream_event` 增量它自己丢掉,而它的 `onQueryProgress` 钩子
     * (存在理由就是这个)此前全仓库零消费者。
     *
     * 钉三样:README 说了这件事、适配层真的传了那个钩子、以及它接的是重置时钟的那个函数。
     * 只钉前两样的话,把 `markProgress` 换成一个空函数照样绿。
     */
    expect(README).toContain(norm('**流式增量算「有输出」。**'))
    const src = readFileSync(new URL('src/tools/efftask/runAgentAdapter.ts', ROOT), 'utf8')
    expect(src).toContain('onQueryProgress: markProgress,')
    expect(src).toContain('const markProgress = (): void => { lastProgressAt = Date.now() }')
    /**
     * 而 runAgent 那一侧必须真的转发 delta —— 这一跳属于别的模块,剪断它这里就该红。
     *
     * 钉的是**位置**,不只是「这行字还在」:验收造出的变异是
     * `if (message.type !== 'stream_event') onQueryProgress?.()` —— 修复被精确地剪断,
     * 而 `toContain('onQueryProgress?.()')` 被它逐字满足(实测 447 tests 全绿)。
     * 它必须是消息循环的**第一句**,排在任何按类型过滤之前。
     *
     * 说清这条断言证明什么、不证明什么:它证明「那一句在正确的位置上」,不证明
     * 「delta 真的到得了它」—— 后者要驱动真 `query()`,而它要一整个 toolUseContext。
     * /et 那一侧的行为由 runAgentAdapter.test.ts 用替身钉住(替身自己调这个钩子),
     * 两条合起来覆盖这一跳的两端。
     */
    const agent = readFileSync(new URL('src/tools/AgentTool/runAgent.ts', ROOT), 'utf8')
    expect(agent).toContain('})) {\n      onQueryProgress?.()')
  })

  it('说有两条时钟(静默 + 总时长 ×6),那两条就都得真的在', () => {
    /**
     * 总时长那条是「增量算进展」之后**新开的洞**的补丁:滴水式上游(每分钟一个 token)
     * 永远不触发静默阀,而它和挂死是同一类故障。文档承诺了倍数和「设 0 一起关掉」,
     * 两条都要能在代码里对上 —— 一个只写在 README 里的阀等于没有阀。
     */
    expect(README).toContain(norm('| 总时长 | 这一次调用**总共**跑了多久（× 6） | 1 小时 |'))
    expect(README).toContain(norm('把 `caps.nodeTimeoutMs` 设成 0 会把两条一起关掉'))
    expect(TOTAL_LIMIT_FACTOR).toBe(6)
    const src = readFileSync(new URL('src/tools/efftask/runAgentAdapter.ts', ROOT), 'utf8')
    // 设 0 时总上限也是 0(禁用)—— 这一句就是「一起关掉」的全部实现。
    expect(src).toContain('const totalLimitMs = limitMs && limitMs > 0 ? limitMs * TOTAL_LIMIT_FACTOR : 0')
    // 而两条都不含等人的那段时间。
    expect(src).toContain('humanSpentMs += Date.now() - humanWaitFrom')
    expect(README).toContain(norm('两条都**不含等你批工具权限的时间**'))
  })

  it('说静默超时能用一句话调,那抽取和夹取两侧就都得有它', () => {
    // 阻断卡点名让用户去调的就是这个旋钮;只能手改 run.md 的旋钮等于没有旋钮。
    expect(README).toContain(norm('直接说「阶段超时 20 分钟」就能调'))
    const src = readFileSync(new URL('src/tools/efftask/parseDirectives.ts', ROOT), 'utf8')
    expect(src).toContain('"nodeTimeoutMs"?: number')
    expect(src).toContain('c.nodeTimeoutMs = clampInt(caps.nodeTimeoutMs, 1000, 7_200_000, DEFAULT_CAPS.nodeTimeoutMs)')
  })

  it('说员工端点的首字节等待落在 API_TIMEOUT_MS 上,那阻断建议就得点名它', () => {
    // 「caps.nodeTimeoutMs 调多大都动不了它」—— 这句话必须同时出现在文档和阻断建议里,
    // 否则用户会一直去调那个不管用的旋钮(而阻断卡此前只提它)。
    expect(README).toContain(norm('只认环境变量 `API_TIMEOUT_MS`'))
    const esc = readFileSync(new URL('src/tools/efftask/escalation.ts', ROOT), 'utf8')
    expect(esc).toContain('API_TIMEOUT_MS')
    // 而 SDK 的那个超时确实是从这个环境变量读的(默认 600s)。
    const client = readFileSync(new URL('src/services/api/client.ts', ROOT), 'utf8')
    expect(client).toContain("parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10)")
    /**
     * **卡片告诉用户的那个默认值,必须和代码里的那个是同一个数。**
     *
     * 一条建议里印错默认值,用户会照着一个不存在的基线去判断「要不要调、调多少」。
     * 和 `COST_RATE_LIMIT_ATTEMPTS` 那条断言同一个形状 —— 两份数字必须锚在一起。
     */
    const clientDefaultMs = 600 * 1000
    expect(esc).toContain(`API_TIMEOUT_MS(默认 ${clientDefaultMs})`)
    // 那个字面量本身也要还在 client.ts 里(上面那条 toContain 已经锁住表达式形状)。
    expect(clientDefaultMs).toBe(600_000)
    /**
     * 而且这条建议**只对翻译协议成立**:`apiProtocol: 'anthropic'` 的员工那条路
     * `return inner(...)` 直接返回,不嗅探 —— 首字节等待和主模型一样落在响应体上,
     * `API_TIMEOUT_MS` 管不到。不限定协议就是给一半的员工指了一条无效的路。
     */
    expect(esc).toContain('apiProtocol: openai / openai-responses')
    const rf = readFileSync(new URL('src/services/api/openaiCompat/roleFetch.ts', ROOT), 'utf8')
    expect(rf).toContain("if (cfg.apiProtocol === 'anthropic') {")
    expect(rf).toContain('const sniff = await sniffSSE(res.body)')
  })

  it('说限流会「整趟 run 一起退避」,那退避的数就得对得上', () => {
    /**
     * 这一段写的是用户唯一能读到的口径(2s → 4s → …上限 60s、成功归零、只重派打不通的
     * 那几席、执行环节不重试)。四条里任何一条对不上,用户就会照着一份错的模型去调
     * 并行数和席位数 —— 而那正是他手上唯一的两个旋钮。
     */
    expect(README).toContain(norm('2s → 4s → 8s …上限 60s，成功一次就归零'))
    // 逐级验:每次都把时钟推过上一个窗口,否则窗口内的重复上报**刻意**不抬级。
    let t = 0
    const gate = createRateLimitGate({ now: () => t, random: () => 0, sleep: async () => {} })
    const seq: number[] = []
    for (let i = 0; i < 6; i++) { const ms = gate.noteRateLimit(); seq.push(ms); t += ms + 1 }
    expect(seq).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
    // 「成功一次就归零」。
    gate.noteSuccess()
    expect(gate.noteRateLimit()).toBe(2_000)
    // 执行环节不重试这一条在 rateLimitPipeline.test.ts 里真跑;这里只钉文档口径的存在。
    expect(README).toContain(norm('执行环节**不重试**'))
    expect(README).toContain(norm('重试只重发那 1 席'))
  })

  it('说跑完会自动合并回当前分支,那三件事就都得是真的', () => {
    /**
     * README 这一段原来写的是「跑完再弹一个**收口关口**」—— 而那句话**当时就是假的**:
     * 关口只在 `--resume` 那条路上出现,同一次会话里跑完是直接进 done 视图,于是合并
     * 永远不会发生。用户报的正是这个(「要在当前目录下有对应的存在」)。
     * 所以这一条钉三样:判据在、脏树/未跑完不合、以及启动关口**事先说过**这件事。
     */
    expect(README).toContain(norm('跑完之后**自动把集成分支合并回你当前的分支**'))
    expect(README).toContain(norm('工作区不干净、或者这一趟没正常跑完时不会自动合'))
    expect(planFinish(handoffFixture(), { dirty: false })).toEqual({ action: 'merge' })
    expect(planFinish(handoffFixture(), { dirty: true }).action).toBe('skip')
    expect(planFinish(handoffFixture({ outcome: 'blocked' }), { dirty: false }).action).toBe('skip')
    // 关口必须先说 —— 用户批准的是他看到的东西,而这一趟结束时我们会动他的工作区。
    expect(parallelismLine(
      { goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS, notices: [] },
      { editable: false, isolation: 'worktree' },
    )).toContain('跑完自动合并回当前分支')
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

/**
 * README 的「子 agent 继承什么」一节必须说真话。
 *
 * 这一节和别处不一样:它给的是**用户会直接粘进 settings.json 的东西** —— 五个旗标名、
 * 一个预批键名、一条「别写 env」的禁令、一句「-p 是必须的」。一个字错的代价不是读者
 * 困惑,是他粘完之后员工整条不生效,而错在文档里。
 *
 * 所以这里尽量用**行为探针**而不是文本比对:`resolveAgentTools` / `toOpenAIRequest`
 * 直接调,拿真的返回值对。只有那些够不到的(子进程怎么 spawn、schema 有没有某个键)
 * 才退回读源码,而且都钉在**会随改动一起变**的那一句上。
 */
describe('README 的子 agent 继承一节说的和代码干的是同一件事', () => {
  const src = (p: string) => readFileSync(new URL(p, ROOT), 'utf8')
  const MCP_TOOL = 'mcp__gitlab__list_issues'

  it('显式 tools 白名单管不到 MCP —— 两段各自补一遍,漏一段就漏掉一半', () => {
    /**
     * README 说「显式 `tools` 白名单**管不到 MCP**,`mcp__*` 无条件继承」。
     *
     * 本来想用行为探针(直接调 resolveAgentTools 走三种写法),但那个模块 import 进来会
     * 触发 AgentTool.tsx 的循环初始化(`Cannot access 'agentToolResultSchema' before
     * initialization`),测试根本起不来 —— 记在这里,免得下一个人再试一遍。
     *
     * 退回结构探针。这里要盯的是**两段**,而它们各自能独立退化:
     *  - filterToolsForAgent 那条 `startsWith('mcp__') → true`(池子对 MCP 免检);
     *  - 白名单解析末尾那个补回循环(白名单本身管不到 MCP)。
     * 早先只有前一段,而后一段不存在 —— README 当时说的正是「白名单会静默吃掉 MCP」。
     * 删掉补回循环、只留免检,这条就红,提醒的是「去改文档」。
     */
    const utils = src('src/tools/AgentTool/agentToolUtils.ts')
    const poolFilter = utils.slice(0, utils.indexOf('export function resolveAgentTools'))
    const whitelist = utils.slice(utils.indexOf('export function resolveAgentTools'))
    expect(whitelist.length).toBeGreaterThan(500) // 切歪了就别往下断言了

    // 白名单本体仍然是逐个键查表(所以内建工具确实要写全名)……
    expect(whitelist).toContain('availableToolMap.get(toolName)')
    // ……但末尾把 mcp__* 无条件补回来,于是 MCP 不受白名单约束。
    expect(whitelist).toContain("if (!tool.name.startsWith('mcp__') || resolvedToolsSet.has(tool)) continue")
    // 而「不写 tools 或写 ["*"] 才是全给」也在这一段里,是同一个判据。
    expect(whitelist).toContain("agentTools.length === 1 && agentTools[0] === '*'")

    // 池子那一半:MCP 对黑名单也免检。两段是同一个立场的两处落点。
    expect(poolFilter).toContain("if (tool.name.startsWith('mcp__')) {")

    expect(README).toContain(norm('`mcp__*` 无条件继承'))
    expect(README).toContain(norm('| 普通子 agent，写了显式 `tools` 白名单 | 继承 | 继承 |'))
    expect(README).toContain(norm('不写 `tools` 或写 `["*"]` 才是全给'))
    // 唯一的摘除口径也要在文档里 —— 否则用户没有任何办法收回某个 MCP 工具。
    expect(README).toContain(norm('用 `disallowedTools`'))
  })

  it('换协议丢不掉 CLAUDE.md,因为它走的是 user 消息而不是 system', () => {
    /**
     * README 敢说「协议那一轴整个不影响」,全部依据是两件事:
     *   1. CLAUDE.md 被拼成一条 user 消息(prependUserContext),不在 system 里;
     *   2. 三种协议都把 user 消息原样带过去。
     * 任一条变了,那句话就是假的。第 2 条这里用真的转换函数验。
     */
    const api = src('src/utils/api.ts')
    // 1. 它造的是 user 消息,而且带着 `# claudeMd` 这个小标题。
    expect(api).toContain('createUserMessage({')
    expect(api).toContain('`# ${key}\\n${value}`')
    expect(src('src/query.ts')).toContain('prependUserContext(messagesForQuery, userContext)')
    // CLAUDE.md 是 userContext 的一个键,而 userContext 整个走上面那条路。
    expect(src('src/context.ts')).toContain('...(claudeMd && { claudeMd })')

    // 2. chat/completions:user 消息原样过桥。
    const chat = toOpenAIRequest({
      system: [{ type: 'text', text: 'SYS' }],
      messages: [{ role: 'user', content: '<system-reminder># claudeMd\n用 bun 不用 npm' }],
    }, 'gpt-4o')
    expect(chat.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '<system-reminder># claudeMd\n用 bun 不用 npm' },
    ])
    // 2. responses:system 走 instructions —— README 括号里那句话就是这个。
    const resp = toResponsesRequest({
      system: [{ type: 'text', text: 'SYS' }],
      messages: [{ role: 'user', content: '# claudeMd' }],
    }, 'gpt-5.1')
    expect(resp.instructions).toBe('SYS')
    expect(JSON.stringify(resp.input)).toContain('# claudeMd')

    expect(README).toContain(norm('**一条领头的 user 消息**'))
    expect(README).toContain(norm('`instructions` 只接 system，而它本来就不在那儿'))
  })

  it('MCP 工具过得了 openai 那条桥,没有 input_schema 的过不了', () => {
    // README 的表里「execMode api + openai 协议 → MCP 继承」这一格靠的就是这条。
    const out = toOpenAIRequest({
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: MCP_TOOL, description: 'd', input_schema: { type: 'object', properties: {} } },
        { name: 'web_search' }, // anthropic 服务端工具:没有 input_schema
      ],
    }, 'gpt-4o')
    expect(out.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([MCP_TOOL])
  })

  it('cli 档只递提示词:prompt 进 stdin、stdout 整个当结果、spawn 不传 env', () => {
    const runner = src('src/tools/AgentTool/cliAgentRunner.ts')
    // README 表格第二行:「整段写进 stdin 然后关闭 stdin,stdout 整个当结果」。
    expect(runner).toContain('proc.stdin.write(task.prompt)')
    expect(runner).toContain('proc.stdin.end()')
    expect(runner).toContain('readAll(proc.stdout)')
    // README 表格第一行:环境变量是继承的 —— 因为 spawn 压根没传 env。
    // 哪天传了(比如加了个 env 白名单),「继承环境变量」这句就得改。
    const spawnBody = runner.slice(runner.indexOf('function defaultSpawn'), runner.indexOf('return {', runner.indexOf('function defaultSpawn')))
    expect(spawnBody).toContain('cwd: opts?.cwd')
    expect(spawnBody).not.toContain('env')
    // cwd 不填就是父进程的 —— Bun.spawn 收到 undefined 就继承,所以传的是可选值本身。
    expect(runner).toContain("spawn(agentDef.command, agentDef.args ?? [], { cwd: agentDef.roleCwd })")

    expect(README).toContain(norm('整段写进 stdin 然后关闭 stdin，**stdout 整个当结果**'))
    expect(README).toContain(norm('工作目录（`cwd` 不填就是父进程的）'))
  })

  it('cli 档收不到系统提示 —— 它的入参里没有任何一个提示词字段', () => {
    /**
     * README 把这条标成「最容易踩」。它成立的原因是结构性的:runCliAgent 的 `agentDef`
     * 入参里**没有**任何提示词字段,系统提示没有地方进去。哪天有人把它加进这个类型,
     * 文档那一行就得跟着改。
     *
     * 断言的是**字段名**,不是那一行的原文。原来这里对着整行签名做逐字比对,于是给这个类型
     * 加一个与提示词无关的字段(`contextWindow`)、或者把它换行排版,都会让这条测试失败 ——
     * 而它要守的东西一个字都没变。逐字比对在这里守错了对象。
     */
    const runnerSrc = src('src/tools/AgentTool/cliAgentRunner.ts')
    const start = runnerSrc.indexOf('export function runCliAgent(')
    expect(start).toBeGreaterThan(0)
    const paramBlock = runnerSrc.slice(start, runnerSrc.indexOf('task: CliAgentTask,', start))
    for (const field of ['command', 'args', 'roleCwd', 'interactive']) {
      expect(paramBlock).toContain(field)
    }
    // 提示词类字段一个都不许有(注释里出现「prompt」这个词不算 —— 判的是字段声明)。
    expect(paramBlock).not.toMatch(/^\s*(system)?[Pp]rompt\??:/m)
    // 而 api 档的系统提示是另一条路:算好之后只喂给 runAgent 的 override。
    expect(src('src/tools/AgentTool/AgentTool.tsx')).toContain('systemPrompt: asSystemPrompt(enhancedSystemPrompt)')
    expect(README).toContain(norm('**员工自己配的 `prompt`（系统提示）**'))
  })

  it('roles[] 是 strict 且没有 env 字段 —— 所以文档敢说「别写 env」', () => {
    const schema = src('src/tools/AgentTool/roles/rolesFromSettings.ts')
    const block = schema.slice(schema.indexOf('const RoleSchema = z.object({'), schema.indexOf('}).strict()'))
    expect(block.length).toBeGreaterThan(100) // 切歪了就别往下断言了
    // 没有 env 键。加了的话 README 那条禁令就成了假话(而且是「照着文档反而配不对」)。
    expect(block).not.toMatch(/\benv\b/)
    // strict:未声明的键让整条员工失败,而不是该字段失效。这是禁令的**后果**那一半。
    expect(schema).toContain('}).strict()')
    // cli 档要求 command,api 档要求那三个 —— 表格和示例都建立在这上面。
    expect(schema).toContain("execMode 'cli' requires 'command'")
    expect(README).toContain(norm('**而且没有 `env` 字段**'))
    expect(README).toContain(norm('会让**整条员工被跳过**'))
  })

  it('interactive 那套报文名,README 抄的就是代码收发的', () => {
    const runner = src('src/tools/AgentTool/cliAgentRunner.ts')
    // 父 → 子
    expect(runner).toContain("JSON.stringify({ type: 'task', prompt: task.prompt })")
    expect(runner).toContain("type: 'permission_response'")
    // 子 → 父
    expect(runner).toContain("'permission_request'")
    expect(runner).toContain("'result'")
    for (const wire of ['"type"："task"', '"type"："permission_request"', '"type"："result"']) {
      expect(`README 写了 ${wire}：${README.includes(wire)}`).toBe(`README 写了 ${wire}：true`)
    }
    expect(README).toContain(norm('普通 `claude -p` **不说这套协议**'))
  })

  it('项目级 MCP 默认不连,预批的两个键名文档没写错', () => {
    const mcpUtils = src('src/services/mcp/utils.ts')
    expect(mcpUtils).toContain('enabledMcpjsonServers')
    expect(mcpUtils).toContain('enableAllProjectMcpServers')
    // 默认档是 'pending' —— 「默认不通」这三个字就是它。
    expect(mcpUtils).toContain("): 'approved' | 'rejected' | 'pending'")
    expect(README).toContain(norm('{ "enabledMcpjsonServers"： ["gitlab"， "ctx7"] }'))
    expect(README).toContain(norm('enableAllProjectMcpServers'))
  })

  it('README 那段 args 示例里的每个旗标,CLI 里都真的存在', () => {
    /**
     * 这条挡的是最贵的一种文档错误:用户把 args 数组整段粘走,旗标名错一个字,子进程
     * 直接起不来,而他会以为是自己配错了。
     *
     * 必须在**示例那个代码块里面**找,不能在整份 README 里找 —— 后者是个破探针:
     * 旗标名在正文里也提了一遍,所以把示例里的名字改错,「README 里有这个词」照样成立。
     */
    const at = README.indexOf(norm('"name"： "cli-评审"'))
    expect(at).toBeGreaterThan(0)
    const argsBlock = README.slice(at, README.indexOf('```', at))
    expect(argsBlock.length).toBeGreaterThan(100)

    const main = src('src/main.tsx')
    // print 模式:示例里是数组第一个元素,CLI 里是 `-p, --print`。
    expect(argsBlock).toContain('"-p"')
    expect(main).toContain('-p, --print')
    for (const flag of ['--add-dir', '--mcp-config', '--settings', '--append-system-prompt-file']) {
      expect(`示例里用了 ${flag}：${argsBlock.includes(flag)}`).toBe(`示例里用了 ${flag}：true`)
      expect(`CLI 里有 ${flag}：${main.includes(`'${flag}`)}`).toBe(`CLI 里有 ${flag}：true`)
    }
  })

  it('只有 Explore 和 Plan 不给 CLAUDE.md', () => {
    // README 的例外第一条点了名。多一个少一个都得改文档。
    expect(src('src/tools/AgentTool/built-in/exploreAgent.ts')).toContain('omitClaudeMd: true')
    expect(src('src/tools/AgentTool/built-in/planAgent.ts')).toContain('omitClaudeMd: true')
    // 它们摘工具用的是**黑名单**(disallowedTools),所以 MCP 还在 —— 表里那一格写的是「继承」。
    expect(src('src/tools/AgentTool/built-in/exploreAgent.ts')).toContain('disallowedTools: [')
    expect(README).toContain(norm('| 内建 `Explore` / `Plan` | 继承 | **不给** |'))
    expect(README).toContain(norm('只有这两个内建员工带 `omitClaudeMd`'))
  })

  it('改完 CLAUDE.md 要重启,以及子目录那份是每个子 agent 独立的', () => {
    // 「只读一次并缓存」= memoize。
    expect(src('src/context.ts')).toContain('export const getUserContext = memoize(')
    // 「每个子 agent 有自己独立的去重表」= 建子上下文时发的是新 Set,不是父的引用。
    expect(src('src/utils/forkedAgent.ts')).toContain('loadedNestedMemoryPaths: new Set<string>()')
    expect(README).toContain(norm('它在进程里只读一次并缓存'))
    expect(README).toContain(norm('每个子 agent 有自己独立的去重表'))
  })

  it('AGENTS.md 不在自动加载的清单里', () => {
    // README 说它「只被 /init 读一次」。依据:装载器压根不认识这个名字。
    const loader = src('src/utils/claudemd.ts')
    expect(loader).not.toContain('AGENTS')
    expect(src('src/context.ts')).not.toContain('AGENTS')
    // 而装载器认的就是 README 列的那几个。
    expect(loader).toContain("name === 'CLAUDE.md' || name === 'CLAUDE.local.md'")
    expect(README).toContain(norm('**`AGENTS.md` 不是自动加载的指令文件**'))
    expect(README).toContain(norm('它们只被 `/init` 读一次'))
  })
})

/**
 * README 的「`f` 强制通过」一节必须说真话。
 *
 * 这一节的风险形状和别处不同:它讲的是**两个动作的区别**,而那两个动作在实现上共用了
 * 大半代码。一句「和跳过的区别只有记录」如果哪天不成立了(比如有人给强制通过单开一条
 * 路由),文档不会自己变红 —— 除非探针盯的是**行为的等价性**本身。
 *
 * 所以这里尽量跑真东西:planSkip / planForcePass 各算一次拿返回值对,pipeline 真跑一遍
 * 数圆桌派了几次。文本比对只用在那些「用户会照着做」的具体承诺上。
 */
describe('README 的强制通过一节说的和代码干的是同一件事', () => {
  const blocked = (): TaskNode => {
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-30T00:00:00Z' })
    n.kind = 'executable'; n.status = 'BLOCKED'; n.failedAt = 'ACCEPTANCE'; n.execStatus = '交过了'
    return n
  }

  it('「路由上逐字相同」是真的 —— 两条路算出来的树只差那两个标记', () => {
    const a = planSkip([blocked()], 'root', '2026-07-30T00:00:00Z') as { nodes: TaskNode[] }
    const b = planForcePass([blocked()], 'root', '2026-07-30T00:00:00Z') as { nodes: TaskNode[] }
    expect(a).not.toHaveProperty('error')
    expect(b).not.toHaveProperty('error')
    // 把两个互斥的标记抹掉之后,**整棵树必须一模一样**。这是那句话唯一诚实的探针:
    // 逐字段列举会漏掉将来新增的字段,而漏掉的那个正好可能是分叉的地方。
    const strip = (n: TaskNode) => ({ ...n, skipPhase: undefined, forcePass: undefined })
    expect(a.nodes.map(strip)).toEqual(b.nodes.map(strip))
    // 而那两个标记确实是反过来的。
    expect(a.nodes[0].skipPhase).toBe('accept')
    expect(a.nodes[0].forcePass).toBeUndefined()
    expect(b.nodes[0].forcePass).toBe('accept')
    expect(b.nodes[0].skipPhase).toBeUndefined()
    expect(README).toContain(norm('在**路由上逐字相同**'))
  })

  it('「四个环节」这句话和 SKIPPABLE_PHASES 是同一份名单', () => {
    // README 把能强制通过的和能跳过的说成同样那四个。它们共用一个常量 —— 但共用这件事
    // 本身要被钉住,否则哪天分开了,文档那句「同样那四个」就是假的。
    for (const p of ['review', 'verify', 'accept', 'integrate']) expect(SKIPPABLE_PHASES.has(p)).toBe(true)
    expect(SKIPPABLE_PHASES.size).toBe(4)
    expect(README).toContain(norm('能强制通过的和能跳过的是同样那四个环节'))
  })

  it('隔离运行 + 工作区丢失时**两条路都**被拒,而且各说各的动作', () => {
    const n = blocked()
    n.worktree = undefined
    const s = skipFailedPhaseReason(n, { isolated: true })
    const f = forcePassFailedPhaseReason(n, { isolated: true })
    expect(s).toContain('跳过')
    expect(f).toContain('强制通过')
    // 同一道闸,同一句理由 —— 只有动作名不同。
    expect(s!.replace(/跳过/g, 'X')).toBe(f!.replace(/强制通过/g, 'X'))
    // 只钉不跨行的那一截:README 在这句中间折了行,把换行写进针里等于把排版也钉死了。
    expect(README).toContain(norm('**隔离运行 + 工作区引用已丢时不许强制'))
    expect(README).toContain(norm('强制通过在此之上还要记一条'))
  })

  it('那条记录的记号是 MANUAL-PASS 而不是 pass —— README 拿它当卖点', () => {
    const n = createNode({ id: 'x', title: 'x', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-30T00:00:00Z' })
    n.acceptLog = [{
      round: 1,
      verdicts: [{ role: MANUAL_PASS_ROLE, pass: true, blocking: [], comments: '覆盖了: [qa] 不行', manual: true }],
      synthesized: { pass: true, blockingSummary: '' },
    }]
    const md = serializeNode(n)
    expect(md).toContain('MANUAL-PASS')
    expect(README).toContain(norm('`MANUAL-PASS`，**不是** `pass`'))
    expect(README).toContain(norm('署名 `人工强制通过`'))
  })

  it('运行中预先批准:不打断在飞、一次性、不落盘 —— 三条都是代码里查得到的', () => {
    const c = createRunControl()
    // 「不打断在飞的调用」:这条门根本不碰 registerCall 登记的那些 controller ——
    // 拿一个真的 AbortController 登记进去,批准之后它必须没被 abort。
    const ac = new AbortController()
    c.registerCall('n1', ac)
    c.forcePass('n1', 'accept')
    expect(ac.signal.aborted).toBe(false)
    // 对照:取消是会 abort 的。两者的区别正是 README 那一条在讲的事。
    c.cancelNode('n1')
    expect(ac.signal.aborted).toBe(true)
    // 「一次性」:清掉之后就不在了。
    c.clearForcePass('n1', 'accept')
    expect(c.wasForcePassed('n1', 'accept')).toBe(false)
    // 「只活在这次进程里」:它不是 TaskNode 的字段,落盘那一侧根本没有它的位置。
    // (节点上那个 forcePass 是**阻断后**那条路的,两回事。)
    expect(Object.keys(createRunControl())).toContain('forcePass')
    expect(README).toContain(norm('**不打断此刻在飞的调用。**'))
    expect(README).toContain(norm('**只活在这次进程里。**'))
  })

  it('预先批准不让节点跳过执行 —— README 最后那段是真跑出来的', async () => {
    const n = createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-30T00:00:00Z' })
    n.kind = 'executable'; n.status = 'READY'
    const c = createRunControl()
    c.forcePass('root', 'accept')
    const phases: string[] = []
    const ctx = {
      config: { goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS } } as EffTaskConfig,
      byId: new Map([['root', n]]), persist: async () => {}, now: () => '2026-07-30T00:00:00Z',
      signal: new AbortController().signal, onUpdate: () => {}, reserveNodes: () => ({ release: () => {} }),
      control: c,
      runAgent: async (req: { phase: string; prompt: string }) => {
        phases.push(req.phase)
        return req.phase === 'execute'
          ? '```json\n{"execStatus":"改了 foo.ts"}\n```'
          : '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict') + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      },
    }
    await stepExecute(n, ctx as never)
    expect(phases).toEqual(['execute'])   // 活照干,会不开
    expect(n.status).toBe('ACCEPTED')
    expect(README).toContain(norm('预先批准**不会**让节点跳过执行环节'))
  })
})

/**
 * 用量那一节说的和代码干的是同一件事 —— 这一组是新加的三条来源各自的锚。
 *
 * 这个文件存在的理由就是「文档承诺了、代码没做」这一类,而用量这一节刚刚把
 * 「自动压缩漏算」从**已知缺陷**改写成**已修复**。那句话如果哪天变回假的,得有东西变红。
 */
describe('README 的用量口径和代码对得上', () => {
  it('说「自动压缩已经算进来了」,那 claude.ts 就得真的在结算成本处上报', () => {
    const claude = readFileSync(new URL('../../services/api/claude.ts', import.meta.url), 'utf8')
    // 两处结算点(流式的 message_delta、非流式兜底)各自都要报 —— 只报一处的话,
    // 走另一条路的调用在用量表上是免费的。
    expect(claude.split('reportApiUsage(').length - 1).toBeGreaterThanOrEqual(2)
    // 而且必须带 requestId:那是和消息那侧去重的唯一键,不带就会让每次调用翻倍。
    expect(claude).toContain('requestId: streamRequestId ?? undefined')
  })

  it('说「翻译层给每次响应签一个 request-id」,那响应头里就得真有', () => {
    const src = readFileSync(new URL('../../services/api/openaiCompat/roleFetch.ts', import.meta.url), 'utf8')
    expect(src).toContain("'request-id': requestId")
  })

  it('说「≈ 表示估出来的」,那三处显示就都得读这个字段', () => {
    const detail = readFileSync(new URL('../../commands/efftask/NodeDetail.tsx', import.meta.url), 'utf8')
    const panel = readFileSync(new URL('../../commands/efftask/TaskTreePanel.tsx', import.meta.url), 'utf8')
    expect(detail).toContain('u.estimated')
    // 树行标记和表头合计
    expect(panel.split('estimated').length - 1).toBeGreaterThanOrEqual(2)
    expect(README).toContain(norm('`≈` 表示这个数是估出来的'))
  })
})

describe('README 说评审员看得见版本差异,代码里就得真的有那一段', () => {
  it('版本对照这一段接上了,而且门是「方案变没变」不是「有没有旧账」', () => {
    expect(README).toContain(norm('**三、评审员看得见「这一版和上一版差在哪」。**'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 段落本体存在,并且真的被 reviewPrompt 调用 —— 只声明不接线是这个仓库的老毛病。
    expect(src).toContain('function prevPlanSection')
    expect(src).toContain('prevPlanSection(node, round, notice)')
    // 写入点钉在**两道守卫之下**,且判据是「这一桌真有一席做出过判断」。
    // 锚在 `node.plan = parsed.plan` 之前的话,一次 Esc→resume 就能让一版没人看过的方案被
    // 下一轮标成「上一轮评审看到的就是它」;只挪到 `push(rec)` 之后仍然漏掉「圆桌开完了但
    // 一个裁决都没有」(infra 耗尽 / Esc 打在飞行中)—— 那两支的守卫在 push 下面。
    const iGuard = src.indexOf('if (infraExhausted)')
    const iWrite = src.indexOf('node.prevPlan = { ...node.plan')
    const iJudged = src.indexOf('rec.verdicts.some(v => v.infra !== true)')
    expect(iGuard).toBeGreaterThan(0)
    expect(iWrite).toBeGreaterThan(iGuard)   // 守卫在前,写入在后
    expect(iJudged).toBeGreaterThan(iGuard)
    expect(iJudged).toBeLessThan(iWrite)     // 判据管着这次写入
    // 方案和轮次戳是一对,缺一不可 —— 见 TaskNode.prevPlanRound。
    expect(src).toContain('node.prevPlanRound = node.iteration.planReview + 1')
    expect(src).toContain('node.prevPlanRound !== round - 1')
    // 展开而不是同引用:同引用会写出 yaml 别名,delete node.plan.responses 会连带删掉上一版。
    expect(src).not.toContain('node.prevPlan = node.plan\n')
    // README 说差异是代码算的、未变字段不重复渲染。
    expect(README).toContain(norm('差异是**代码算出来的**，不是让模型去推断'))
    expect(src).toContain('const changed = PLAN_FIELDS.filter')
    expect(src).toContain('逐字未变的字段')
    // README 说方案没重出时整段不出现 —— 结构门,不借 notice。
    expect(README).toContain(norm('**没有真正被评审员判过的那一版，绝不会被拿来当对照物。**'))
    expect(src).toContain('if (changed.length === 0) return ')
  })

  it('措辞是加法+举证责任,不是排他+豁免', () => {
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    // 排他句式会压掉排在提示词第一段的 REVIEW_FLOOR(「P 和 ¬P 同在且 ¬P 在后」,已踩过两次),
    // 而紧跟地板的 YIELD_NOTE 还说「以上是**默认**判据」,等于给覆盖发许可证。
    expect(src).toContain('本轮**务必判到**')
    expect(src).not.toContain('本轮只判这两件事')
    // 「提示词里不出现豁免/越权举证责任」这几条否定断言钉在**构建出来的提示词**上
    // (见 pipeline.test.ts「不排他、不发免死金牌、也不越过 repeatRule 发举证责任」),
    // 不在这里扫源码 —— 那样会扫到解释为什么不这么写的注释本身。
    // 这里只钉第二条 bullet 挂在本轮判据上,而不是无限定的「有没有引入新的问题」。
    expect(src).toContain('按本轮判据够不够 blocking')
    expect(README).toContain(norm('够不够 blocking 由本轮档位说了算'))
  })

  it('作者那一侧的「原样保留」在,而融合席不收到它', () => {
    expect(README).toContain(norm('返工时会要求**未被质疑到的部分原样保留**'))
    const src = readFileSync(new URL('src/tools/efftask/pipeline.ts', ROOT), 'utf8')
    expect(src).toContain('没有被质疑到的部分尽量原样保留')
    // 逃生条款:第 1 轮的意见可能正是「这个不该拆」,那时必要的动作就是整段重写。
    expect(src).toContain('改变做法本身')
    expect(README).toContain(norm('若某条意见要求的是改变做法本身'))
    // fusePrompt 追加整份 planPrompt,而它上面写着「不是选一份,是取各稿之长合成一份」。
    // 两条互斥,所以融合那一路必须显式关掉。
    expect(src).toContain('planPrompt(node, ctx, tag, feedback, \'\', false)')
    expect(src).toContain('keepUnchallenged = true')
  })
})
