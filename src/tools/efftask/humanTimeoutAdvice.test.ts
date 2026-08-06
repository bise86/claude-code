/**
 * 等人超时的**补救建议**,在每一个环节上都必须是等人那一版。
 *
 * 这一档是测试修复员逼出来的,而它逼出来的东西正是 371fd01 那个提交自己承诺修掉的:
 * 「两种超时给相反的补救建议 —— 合成一句话的话,一半用户会被指去调一个和病因无关的
 * 旋钮」。实测下来四个环节里**三个**给反了:
 *
 *  - 分析 plan:`runPlanPhase` 的返回类型里根本没有 timeoutKind,调用方那句
 *    `res.timeoutKind === 'human'` 是永远取不到值的死分支(没有 typecheck 会说);
 *  - 评审/验收/集成的圆桌:`roundtable` 只记 `timeout: true` 不记 kind。
 *
 * 屏幕上于是出现一句自相矛盾的话:诊断写着「没有人回答工具权限确认」,建议写着
 * 「提高 caps.nodeTimeoutMs 后再重试,或把该节点拆小」。用户照着后半句去做。
 *
 * 所以这里对**每一个环节**各驱一次真的 human 超时,读 blockedReason 那句话。
 */
import { describe, expect, it } from 'bun:test'

import { stepExecute, stepIntegrate, stepStart } from './pipeline.js'
import { PhaseTimeoutError } from './runAgentAdapter.js'
import type { RunAgentFn } from './roundtable.js'
import {
  createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM,
  type EffTaskConfig, type PipelineCtxLike, type TaskNode,
} from './types.js'

const NOW = '2026-07-25T00:00:00Z'

/**
 * 静默超时那一版的特征词。
 *
 * **不能**用 'nodeTimeoutMs' —— 等人那一版建议里也有这五个字(「这条和节点大小、和
 * caps.nodeTimeoutMs 都没有关系」)。用它当反向探针的话,四条断言全部恒假,
 * 整档测试只会红,和被测行为无关。挑静默那版独有的祈使句。
 */
const STALL_ADVICE = '把该节点拆小'
/** 等人那一版的特征词。 */
const HUMAN_ADVICE = '把那个确认点掉'

const cfg: EffTaskConfig = {
  goalPrompt: '目标', parallelism: DEFAULT_PARALLELISM,
  phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
}

function node(over: Partial<TaskNode> = {}): TaskNode {
  return {
    ...createNode({
      id: 'root', title: '根任务', parentId: null, deps: [], depth: 0,
      phaseRoles: emptyPhaseRoles(), now: NOW,
    }),
    ...over,
  }
}

function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn): PipelineCtxLike {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return {
    config: cfg, byId, runAgent,
    persist: async () => {}, now: () => NOW, onUpdate: () => {},
    signal: new AbortController().signal,
  } as unknown as PipelineCtxLike
}

/** 每次调用都以「等人超时」失败。 */
const alwaysHumanTimeout: RunAgentFn = async () => {
  throw new PhaseTimeoutError(7 * 24 * 60 * 60 * 1000, 'human')
}
/** 每次调用都以「静默超时」失败 —— 对照组。 */
const alwaysStallTimeout: RunAgentFn = async () => {
  throw new PhaseTimeoutError(600_000, 'stall')
}

describe('等人超时:每个环节给的都必须是等人那一版建议', () => {
  it('分析环节', async () => {
    const n = node({ kind: 'unknown' })
    await stepStart(n, ctxFor([n], alwaysHumanTimeout))
    expect(n.status).toBe('BLOCKED')
    // 诊断那半句对、建议那半句错,是最坏的一种:用户信了前半句,照做了后半句。
    expect(n.blockedReason).toContain(HUMAN_ADVICE)
    expect(n.blockedReason).not.toContain(STALL_ADVICE)
  })

  it('执行环节', async () => {
    const n = node({ kind: 'executable', status: 'READY' })
    await stepExecute(n, ctxFor([n], alwaysHumanTimeout))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain(HUMAN_ADVICE)
    expect(n.blockedReason).not.toContain(STALL_ADVICE)
  })

  it('验收圆桌(执行完之后那一场)', async () => {
    // 执行调用成功、验收席位全部等人超时 —— 这条路走的是 exhaustionCategory 那一支,
    // 和单点调用的死分支是**两个不同的根因**。
    //
    // 探针从评审关挪到验收关:质疑修复不开圆桌,它那一席超时时也不阻断(手上已经有方案)。
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') return '```json\n{"execStatus":"改了 foo.ts"}\n```'
      throw new PhaseTimeoutError(7 * 24 * 60 * 60 * 1000, 'human')
    }
    const n = node({ kind: 'executable', status: 'READY', phaseRoles: { ...emptyPhaseRoles(), accept: [{ roleName: '验收甲' }] } as TaskNode['phaseRoles'] })
    await stepExecute(n, ctxFor([n], runAgent))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain(HUMAN_ADVICE)
  })

  it('集成验收', async () => {
    const parent = node({ kind: 'decompose', status: 'WAITING_CHILDREN', childIds: ['root/00-a'] })
    const child = node({
      id: 'root/00-a', title: '甲', parentId: 'root', depth: 1,
      kind: 'executable', status: 'ACCEPTED',
    })
    await stepIntegrate(parent, ctxFor([parent, child], alwaysHumanTimeout))
    expect(parent.status).toBe('BLOCKED')
    expect(parent.blockedReason).toContain(HUMAN_ADVICE)
  })

  it('对照组二:圆桌里的静默超时仍然给静默那一版', async () => {
    // 上面那条对照组走的是**直接调用**那条路(stepExecute 自己判 kind),碰不到
    // exhaustionRemedyFor。少了这条,把圆桌那支改成「恒给等人建议」全套照绿 ——
    // 那不是修好,是把错误方向倒了个个儿。
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') return '\u0060\u0060\u0060json\n{"execStatus":"改了 foo.ts"}\n\u0060\u0060\u0060'
      throw new PhaseTimeoutError(600_000, 'stall')
    }
    const n = node({ kind: 'executable', status: 'READY', phaseRoles: { ...emptyPhaseRoles(), accept: [{ roleName: '验收甲' }] } as TaskNode['phaseRoles'] })
    await stepExecute(n, ctxFor([n], runAgent))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain(STALL_ADVICE)
    expect(n.blockedReason).not.toContain(HUMAN_ADVICE)
  })
  it('对照组:静默超时给的仍然是调 nodeTimeoutMs 那一版', async () => {
    // 没有这条,上面四条即使因为「所有超时都给等人建议」而通过也看不出来 —— 那是
    // 把错误方向倒了个个儿,而不是修好。
    const n = node({ kind: 'executable', status: 'READY' })
    await stepExecute(n, ctxFor([n], alwaysStallTimeout))
    expect(n.blockedReason).toContain(STALL_ADVICE)
    expect(n.blockedReason).not.toContain(HUMAN_ADVICE)
  })
})
