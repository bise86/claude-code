import { describe, expect, it } from 'bun:test'

import { DEFAULT_CAPS } from './types.js'
import { humanTimeoutRemedy } from './escalation.js'
import { blockEscalationLines, blockReasonWithRemedy, buildBlockCard, createEscalationLimiter, MAX_ESCALATION_CARDS, stopsTheNode, type BlockCategory} from './escalation.js'
import { createNode, emptyPhaseRoles, type TaskNode } from './types.js'

const NOW = '2026-07-26T00:00:00.000Z'
const node = (over: Partial<TaskNode> = {}): TaskNode => ({
  ...createNode({ id: 'root/02-支付', title: '接入支付回调', parentId: 'root', deps: [], depth: 1, phaseRoles: emptyPhaseRoles(), now: NOW }),
  kind: 'executable',
  ...over,
})
const lines = (category: BlockCategory, reason = '验收迭代超限(3): [qa] 缺测试', over: Partial<TaskNode> = {}) =>
  blockEscalationLines({ node: node(over), reason, category, runDir: '.claude/efftask/007' }, '007').join('\n')

describe('触阀升级卡 (spec §9/§11)', () => {
  it('carries the node, the verbatim reason and where the record is', () => {
    const t = lines('rework')
    expect(t).toContain('接入支付回调')
    expect(t).toContain('root/02-支付')
    // VERBATIM. node.md already records this sentence with its counts; paraphrasing would
    // give the card and the file two different accounts of the same event.
    expect(t).toContain('验收迭代超限(3): [qa] 缺测试')
    expect(t).toContain('.claude/efftask/007/root/02-支付/node.md')
  })

  it('says the node is NOT going to retry itself', () => {
    // "已暂停" alone reads as "it will pick up later". It will not: reseatTransientNodes
    // skips a cap-blocked node on every plain resume.
    const t = lines('rework')
    expect(t).toContain('不会自动重试')
    // What is ACTUALLY true, and was checked against propagateBlocked: every node that can
    // reach onBlocked either has no children or has children that are all ACCEPTED, so
    // "这一支下面的任务也不会继续" was a claim about a subtree that does not exist. What does
    // happen is upward: the ancestor chain is marked 子节点阻断 and the run ends 被阻断.
    expect(t).toContain('上级会被标记为阻断')
    expect(t).toContain('以「被阻断」收场')
    expect(t).not.toContain('下面的任务也不会继续')
  })

  it('warns that the RUN has not stopped, because a second /et would corrupt it', () => {
    // The card is sent mid-run: other branches are still executing. And the FIRST run never
    // takes the run lock (acquireRunLock is only called on the --resume path), so a second
    // /et started now acquires it successfully and two orchestrators write the same node.md
    // files concurrently — each silently overwriting the other while both report success.
    const t = lines('rework')
    // Hedged, because the payload carries no in-flight count: the old unconditional
    // "其它分支此刻仍在跑" is false at parallelism 1 and false when this was the last step.
    expect(t).toContain('可能还有其它分支在跑')
    expect(t).toContain('两个进程写同一批 node.md')
  })

  it('does NOT call a plain --resume a read-only way to look at results', () => {
    // /et --resume takes the run lock, reseats every interrupted node and issues real
    // write-capable model calls. Offering it as "只看结果" invited a full re-run.
    const t = lines('rework')
    expect(t).not.toMatch(/只看结果[^\n]*--resume/)
    // The PATH, not a relative direction. node.md is at <runDir>/<node.id>/node.md and node.id
    // contains slashes, so "上一级目录" was wrong for every node in the tree — root included.
    expect(t).toContain('只看结果、不重跑: 直接读 .claude/efftask/007/run.md')
  })

  it('cap-nodes 从动态生长撞上来时,不能说节点已经停了', () => {
    // growTree only refuses the graft and the node carries on to ACCEPTED. Measured: the card
    // said 该节点已停…以「被阻断」收场 for a node whose real state was ACCEPTED with an empty
    // blockedReason, and offered --retry-blocked, which matched nothing at all.
    const t = blockEscalationLines(
      { node: node(), reason: '向 root 加子节点失败: 节点数超过上限', category: 'cap-nodes', stopped: false },
      '007',
    ).join('\n')
    expect(t).toContain('该节点本身没有停')
    expect(t).not.toContain('不会自动重试')
    expect(t).not.toContain('--retry-blocked')
    expect(t).toContain('caps.maxNodes') // the remedy still applies
  })

  it('同一个类别,停了和没停用不同颜色', () => {
    const stopped = buildBlockCard({ node: node(), reason: 'r', category: 'cap-nodes' }, '1') as { header: { template: string } }
    const running = buildBlockCard({ node: node(), reason: 'r', category: 'cap-nodes', stopped: false }, '1') as { header: { template: string } }
    expect(stopped.header.template).toBe('orange')
    expect(running.header.template).toBe('blue')
  })

  it('says the retry is RUN-scoped, because that is what --retry-blocked does', () => {
    // reseat walks the whole tree and reopens EVERY capBlocked node. Up to 8 cards can each
    // point at this one flag; "重试该节点" made each of them look independent.
    expect(lines('rework')).toContain('会重开本次运行中所有被安全阀停下的节点')
  })

  it('names the ONE command that actually reopens it', () => {
    // A bare `/et --resume 007` reproduces the identical block having made zero model calls.
    // This flag is what makes the instruction true; without naming it the card would be
    // prescribing a no-op.
    const t = lines('rework')
    expect(t).toContain('/et --resume 007 --retry-blocked')
  })

  it('says WHICH phase a retry re-runs, so the cost is visible before spending it', () => {
    expect(lines('rework', 'r', { kind: 'executable' })).toContain('执行 → 验收')
    expect(lines('cap-iteration', 'r', { kind: 'unknown' })).toContain('分析 → 质疑修复')
    expect(lines('rework', 'r', { childIds: ['a'] })).toContain('集成验收')
  })

  it('评审超限的可执行节点,说的是"方案会重新生成" —— 不能说反', () => {
    // THE case a cap-iteration card is most often sent about: a plan that called itself
    // executable and was then rejected three times. reseat sends it back to CREATED to
    // re-plan (see its reviewExhausted branch), but retryTarget only looked at kind and said
    // 「执行 → 验收」 — a card headed 安全阀 · 方案评审迭代超限 telling the user the retry
    // would KEEP the plan and only re-run execution. Exactly backwards.
    const t = lines('cap-iteration', '评审迭代超限(3)', { kind: 'executable' })
    expect(t).toContain('分析 → 质疑修复(方案会重新生成)')
    expect(t).not.toContain('本节点将重跑「执行 → 验收」')
  })

  it('但有子节点时仍然是集成验收 —— reseat 的规则 1 优先', () => {
    expect(lines('cap-iteration', 'r', { childIds: ['a'] })).toContain('集成验收')
  })

  it('prescribes a DIFFERENT fix per valve — "just try again" is useless for all of them', () => {
    // Retrying unchanged trips the same cap at the same place. Each valve has its own knob.
    expect(lines('cap-iteration')).toContain('caps.maxIterations')
    expect(lines('cap-nodes')).toContain('caps.maxNodes')
    expect(lines('timeout')).toContain('caps.nodeTimeoutMs')
    expect(lines('rework')).toContain('验收记录')
    expect(lines('infra')).toContain('roles')
  })

  it('titles each category as itself', () => {
    expect(lines('rework')).toContain('连续返工超限')       // spec §9 uses exactly this name
    expect(lines('cap-nodes')).toContain('节点数超上限')
    // 「执行超时」教的是「跑太久了 → 把节点拆小」,而这条阀量的是**静默**(一直在吐字
    // 就永远不算,流式增量也算)。标题是用户最先读的一行,它必须和正文、和运行期抛出的
    // 那句「静默超时(没有任何输出)」说同一件事。
    expect(lines('timeout')).toContain('静默超时')
    expect(lines('timeout')).not.toContain('执行超时')
    expect(lines('infra')).toContain('角色调用连续失败')
  })

  it('degrades to a placeholder rather than dropping the resume step', () => {
    const t = blockEscalationLines({ node: node(), reason: 'r', category: 'rework' }).join('\n')
    expect(t).toContain('<运行 ID>')
    // The record path is DERIVED from the run id, not passed in on the payload. It used to be
    // a `runDir` field that no production caller ever set — PipelineCtx.onBlocked carries
    // only {node, reason, category} — so every real card printed a pathless fallback while
    // this test set the field by hand and asserted a full path. One fewer wire to cut.
    expect(t).toContain('/root/02-支付/node.md')
  })

  it('derives the record path from the run id, with no field for production to forget', () => {
    const t = lines('rework')
    expect(t).toContain('记录: .claude/efftask/007/root/02-支付/node.md')
  })

  it('深度阀 does not claim anything stopped, because nothing did', () => {
    // spec §11 lets maxDepth take the 强制 executable branch, which this implementation does:
    // the planner's children are folded into the node's own solution and it keeps running.
    // Reusing the 已暂停 wording would send the user to fix a run that is still working, and
    // --retry-blocked does not match this node at all.
    const t = lines('cap-depth', '已达最大深度,不得再拆分')
    expect(t).toContain('本次运行没有停')
    expect(t).not.toContain('不会自动重试')
    expect(t).not.toContain('--retry-blocked')
    expect(t).toContain('caps.maxDepth')
  })

  it('深度阀 does not look like a stop in the chat window either', () => {
    const card = buildBlockCard({ node: node(), reason: 'r', category: 'cap-depth' }, '007') as { header: { template: string } }
    expect(card.header.template).toBe('blue')
    expect(stopsTheNode('cap-depth')).toBe(false)
    expect(stopsTheNode('rework')).toBe(true)
  })

  it('does NOT look like the merge-conflict card — the two ask for different things', () => {
    // Red is the conflict card: a stop only the user can clear. This is a valve asking
    // whether to spend more. Identical-looking cards in a chat window train people to skim.
    const card = buildBlockCard({ node: node(), reason: 'r', category: 'rework' }, '007') as {
      header: { template: string; title: { content: string } }
      elements: { text: { content: string } }[]
    }
    expect(card.header.template).toBe('orange')
    expect(card.header.title.content).toContain('连续返工超限')
    for (const l of blockEscalationLines({ node: node(), reason: 'r', category: 'rework' }, '007')) {
      expect(card.elements[0].text.content).toContain(l)
    }
  })
})

describe('升级卡限流', () => {
  it('lets the first cards through', () => {
    const l = createEscalationLimiter(3)
    expect(l.admit().send).toBe(true)
    expect(l.admit().send).toBe(true)
  })

  it('ANNOUNCES the cut-off on the last card rather than going quiet', () => {
    // A provider outage blocks every node in flight. Silently dropping the rest is the same
    // failure as never notifying at all — the user cannot tell "8 problems" from "80".
    const l = createEscalationLimiter(3)
    l.admit(); l.admit()
    const third = l.admit()
    expect(third.send).toBe(true)
    expect(third.note).toContain('已达 3 条上限')
    // Points at BOTH files: renderTreeSnapshot only prints a reason for BLOCKED nodes, so a
    // suppressed non-stopping valve (cap-depth, cap-nodes-on-growth) appears nowhere in run.md.
    expect(third.note).toContain('run.md')
    expect(third.note).toContain('node.md')
  })

  it('suppresses beyond the cap and keeps count', () => {
    const l = createEscalationLimiter(2)
    l.admit(); l.admit()
    expect(l.admit()).toEqual({ send: false })
    expect(l.admit()).toEqual({ send: false })
    expect(l.suppressed()).toBe(2)
  })

  it('defaults to a cap that is small enough to read', () => {
    expect(MAX_ESCALATION_CARDS).toBeLessThanOrEqual(10)
    const l = createEscalationLimiter()
    let sent = 0
    for (let i = 0; i < 50; i++) if (l.admit().send) sent++
    expect(sent).toBe(MAX_ESCALATION_CARDS)
  })
})

describe('run.md 也得带着处置办法', () => {
  it('blockedReason carries the remedy AND the retry command', () => {
    // The limiter drops cards past its cap while telling the user to read run.md. If the
    // remedy lives only on the card, the suppressed escalations are unactionable — the user
    // sees 「— 验收迭代超限(3): …」 in the tree and nothing else. The merge-conflict path
    // already writes its 处理方式 into blockedReason for exactly this reason.
    const r = blockReasonWithRemedy('验收迭代超限(3): 缺测试', 'rework', '007')
    expect(r).toContain('验收迭代超限(3): 缺测试')
    expect(r).toContain('caps.maxIterations')
    expect(r).toContain('/et --resume 007 --retry-blocked')
  })

  it('degrades to a placeholder run id rather than printing a broken command', () => {
    expect(blockReasonWithRemedy('r', 'timeout')).toContain('/et --resume <运行 ID> --retry-blocked')
  })
})


describe('限流:信息类通知不能吃掉决策类的额度', () => {
  it('折树的蓝卡发满一半之后,真正停机的橙卡仍然发得出去', () => {
    // Measured: a deep tree folding eight branches spent the whole quota on blue
    // "nothing stopped" notices and the ONE orange card asking a human whether to spend more
    // came back {send:false}. That card is the only one that needs an answer.
    const l = createEscalationLimiter(8)
    for (let i = 0; i < 8; i++) l.admit(false)   // information-only
    const stopped = l.admit(true)
    expect(stopped.send).toBe(true)
  })

  it('信息类只拿到一半额度', () => {
    const l = createEscalationLimiter(8)
    let sent = 0
    for (let i = 0; i < 20; i++) if (l.admit(false).send) sent++
    expect(sent).toBe(4)
  })

  it('决策类仍然用满整个额度', () => {
    const l = createEscalationLimiter(8)
    let sent = 0
    for (let i = 0; i < 20; i++) if (l.admit(true).send) sent++
    expect(sent).toBe(8)
  })
})

describe('补救拆分的卡片不能自相矛盾(spec §4.1 / §9)', () => {
  const node = (): TaskNode => ({
    ...createNode({ id: 'root', title: '根任务', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: '2026-07-26T00:00:00Z' }),
    kind: 'decompose', childIds: ['root/01-a'],
  })
  const lines = () => blockEscalationLines(
    { node: node(), reason: '集成验收未通过,已追加 2 个补救子任务并重新等待子任务完成', category: 'revise', stopped: false },
    '003',
  ).join('\n')

  it('不说"已暂停",因为节点没有停', () => {
    const t = lines()
    expect(t).not.toContain('已停')
    expect(t).toContain('没有停')
  })

  it('不复用 growTree 那句"加子节点的请求被拒绝了"', () => {
    // 复用 'rework' 类别时,非停机分支对除 cap-depth 外的一切都硬编码了那句话,于是同一
    // 张卡上一行说"已追加 2 个补救子任务"、下一行说"这次加子节点的请求被拒绝了"。
    expect(lines()).not.toContain('被拒绝')
  })

  it('标题不带"安全阀",也不叫"连续返工超限"', () => {
    // 什么阀都没触,节点也没停 —— 它刚刚自我恢复。而 'rework' 的定义是"连续返工超限",
    // 在 §9 里是一个**停机**升级理由。
    const card = buildBlockCard(
      { node: node(), reason: 'r', category: 'revise', stopped: false }, '003',
    ) as { header: { title: { content: string }; template: string } }
    expect(card.header.title.content).not.toContain('安全阀')
    expect(card.header.title.content).not.toContain('超限')
    expect(card.header.title.content).toContain('补救')
  })

  it('处理方式是"暂时无需处理",不是叫用户去改代码', () => {
    // 'rework' 的处理方式是"按阻断意见改代码或改验收点;必要时提高 caps.maxIterations" ——
    // 而节点正在自己修。
    const t = lines()
    expect(t).toContain('无需处理')
    expect(t).not.toContain('提高 caps.maxIterations')
  })

  it('revise 不是停机类别', () => {
    expect(stopsTheNode('revise')).toBe(false)
    expect(stopsTheNode('rework')).toBe(true)
  })
})

describe('重试提示要说全会重跑哪几个环节', () => {
  // 卡片上少一步,用户就会以为重试比实际便宜。
  const seats = (verify: { roleName: string }[]) =>
    ({ phaseRoles: { ...emptyPhaseRoles(), verify } })

  it('配了测试修复 → 三步都列出来', () => {
    expect(lines('rework', 'r', seats([{ roleName: 'tester' }]))).toContain('执行 → 测试修复 → 验收')
  })

  it('没配 → 不多报一步(那一步整个不发生)', () => {
    const t = lines('rework', 'r', seats([]))
    expect(t).toContain('执行 → 验收')
    expect(t).not.toContain('测试修复')
  })
})

describe('两个时钟的默认预算和那句人工建议', () => {
  it('默认值被钉住 —— 它们可以被改成任意值而全套照绿', () => {
    // 把 humanTimeoutMs 改回 10 分钟 = 静默退回「合成一个时钟」之前的行为:
    // 用户去倒杯水回来节点已经阻断。这两个数是这次改动的**全部意义**所在。
    expect(DEFAULT_CAPS.humanTimeoutMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(DEFAULT_CAPS.nodeTimeoutMs).toBe(600_000)
  })

  it('人工超时那句建议必须真的说清三件事', () => {
    // 全仓原来**没有任何测试碰过这个函数的返回值** —— 它可以返回空串而全绿。
    const s = humanTimeoutRemedy()
    // 1) 病因
    expect(s).toContain('没有人回答工具权限确认')
    // 2) 现在就能做的动作
    expect(s).toContain('把那个确认点掉')
    // 3) 不想守着时的长期办法
    expect(s).toContain('allowlist')
    // 4) 最关键的一句:别去调那个不相干的旋钮。这正是两种超时被合成一句话时的病根。
    expect(s).toContain('都没有关系')
    expect(s).toContain('nodeTimeoutMs')
  })
})


/**
 * 降级那一档的卡片。四条各自对应一个实测过的自相矛盾:复用 `cap-iteration` 会让标题写
 * 「安全阀 · 方案评审迭代超限」、建议写「提高 caps.maxIterations 后再重试」,而节点根本没停;
 * 落进兜底那一支则会告诉用户「这次加子节点的请求被拒绝了」—— 和事实毫无关系。
 * `revise` 当初被单独立档,治的就是同一个毛病。
 */
describe('降级放行的升级卡不许自相矛盾', () => {
  const card = (): string[] => blockEscalationLines({
    node: node(), reason: '评审迭代超限(3): 还差得远', category: 'degrade', stopped: false,
  }, '001')

  it('标题不说「安全阀」,也不说节点停了', () => {
    const t = card().join('\n')
    expect(t).not.toContain('安全阀')
    expect(t).toContain('降级放行')
    expect(t).toContain('没有停')
  })

  it('处理方式里不出现「重试」—— 节点没停,没有什么可重试的', () => {
    expect(card().join('\n')).not.toContain('重试')
  })

  it('正文不会冒出「加子节点的请求被拒绝了」', () => {
    expect(card().join('\n')).not.toContain('加子节点的请求被拒绝')
  })

  it('stopsTheNode 对 degrade 返回 false', () => {
    expect(stopsTheNode('degrade')).toBe(false)
  })
})

/**
 * **零贡献那一档不许提验收和 maxIterations。**
 *
 * 用户报的原话:「普通任务怎么会去验收呢,前面已经将验收阶段跳过了。应该执行阶段完成后
 * 就去合并提交了。」—— 上一版这条走的是 `rework`,而那一档的建议是「先看该节点的验收
 * 记录,按阻断意见改代码;必要时提高 caps.maxIterations」。跳过验收的运行根本没有验收
 * 记录,阻断意见也不存在,而迭代上限和「什么都没产出」毫无关系:三句话没有一句对得上。
 */
describe('零贡献的阻断卡', () => {
  const t = (): string => blockReasonWithRemedy('该节点没有向集成分支贡献任何改动', 'no-output', '001')

  it('一个字都不提验收记录 / maxIterations', () => {
    expect(t()).not.toContain('验收记录')
    expect(t()).not.toContain('maxIterations')
  })

  it('说的是「去哪儿找那批产出」', () => {
    expect(t()).toContain('工作区之外')
    expect(t()).toContain('.gitignore')
    expect(t()).toContain('按 r 重做')
  })

  /** 对照:`rework` 那一档仍然该提那两样 —— 它本来就是「验收打回来了」。 */
  it('rework 那一档照旧', () => {
    const r = blockReasonWithRemedy('验收迭代超限', 'rework', '001')
    expect(r).toContain('验收记录')
    expect(r).toContain('maxIterations')
  })

  /** 标题不许写成安全阀 —— 没有任何上限被触到。 */
  it('标题不是安全阀', () => {
    const n = createNode({
      id: 'root/01', title: '写 a.ts', parentId: 'root', deps: [], depth: 1,
      phaseRoles: emptyPhaseRoles(), now: '2026-08-13T00:00:00Z',
    })
    const text = blockEscalationLines({
      category: 'no-output', node: n,
      reason: '该节点没有向集成分支贡献任何改动',
    } as never).join('\n')
    // 只看**类别**那一行 —— 底下那句通用的重试说明里本来就有「安全阀」三个字。
    const kind = text.split('\n').find(l => l.startsWith('类别:')) ?? ''
    expect(kind).not.toContain('安全阀')
    expect(kind).toContain('产出没有落到集成分支上')
  })
})
