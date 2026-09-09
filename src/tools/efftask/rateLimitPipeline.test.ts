/**
 * 限流在**单点调用**(分析 / 执行)上的行为。
 *
 * 底层 API 重试结束后,所有单点阶段都额外重跑一次;耗尽后保留对症的分类和建议。
 */
import { describe, expect, it } from 'bun:test'

import { stepStart, stepExecute, type PipelineCtx } from './pipeline.js'
import { PhaseTimeoutError, ProviderApiError } from './runAgentAdapter.js'
import type { RunAgentFn } from './roundtable.js'
import {
  createNode, DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig, type TaskNode,
} from './types.js'

const NOW = '2026-07-30T00:00:00.000Z'
const cfg: EffTaskConfig = {
  goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS, notices: [],
}
const vtag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z0-9]+)/)?.[1] ?? 'verdict')
const ptag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (plan[a-z0-9]+)/)?.[1] ?? 'plan')
const etag = (req: { prompt: string }): string =>
  '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (exec[a-z0-9]+)/)?.[1] ?? 'exec')

const ctxFor = (nodes: TaskNode[], runAgent: RunAgentFn, over: Partial<PipelineCtx> = {}): PipelineCtx => ({
  config: cfg,
  byId: new Map(nodes.map(n => [n.id, n])),
  runAgent,
  persist: async () => {},
  now: () => NOW,
  signal: new AbortController().signal,
  onUpdate: () => {},
  reserveNodes: () => ({ release: () => {} }),
  ...over,
})
const root = (): TaskNode =>
  createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

const rateLimit = (): never => { throw new ProviderApiError('API Error: Request rejected (429)', 'rate_limit') }

describe('分析环节吃到 429', () => {
  it('重试,而且第二次成功就照常往下走', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        calls++
        if (calls === 1) rateLimit()
        return ptag(req) + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(calls).toBe(2)
    expect(n.status).toBe('READY')
    expect(n.blockedReason).toBe('')
  })

  it('一直限流 → 两次之后阻断,而且带着对症的分类和建议', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { calls++; rateLimit() }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(calls).toBe(2)
    expect(n.status).toBe('BLOCKED')
    // 分类必须有:不带的话 capBlocked 是 false、capCategory 是 undefined,
    // 阻断卡给不出建议,`--retry-blocked` 也捞不回它。
    expect(n.capBlocked).toBe(true)
    expect(n.capCategory).toBe('infra')
    // 建议必须是限流那一版,而不是默认的「先确认角色模型/网络可用」—— 上游是**通的**。
    expect(n.blockedReason).toContain('上游在限流')
    expect(n.blockedReason).not.toContain('网络可用')
  })

  it('其它 provider 错误同样额外重跑一次', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        calls++
        throw new ProviderApiError("There's an issue with the selected model (K3).")
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(calls).toBe(2)
    expect(n.status).toBe('BLOCKED')
    /**
     * **带分类,而且必须带。** 上一版这里断言 `undefined`,那不是判据、是当时的缺陷:
     * 没有分类 → `capBlocked: false` → `--resume` 不认(非 interrupted)、
     * `--retry-blocked` 不认(reseat 要 `capBlocked === true`)、`reopenPropagatedBlocks`
     * 把它当真失败的种子。跑机 .30 run 001 上有一个这样的节点(上游按内容策略拒绝),
     * 只要它不动,root 的 `childrenAllAccepted` 永远为假 —— 那趟 run 无论 resume 多少次
     * 都不可能 COMPLETED。
     *
     * 阶段重跑耗尽后仍要保留分类,让 --retry-blocked 能恢复。
     */
    expect(n.capCategory).toBe('infra')
  })
})

describe('额度用尽:额外重跑后仍保留原来的建议', () => {
  /**
   * 变异测试实测存活:把 quota 那一版建议去掉(和限流共用一句)之后全套照绿。而两者
   * 的差别正是这次拆开它们的全部理由 —— 上游自己说 `resets 3pm`,而限流那一版写着
   * 「等几分钟再 /et --resume 继续」,照它做的人几分钟后会再撞一次。
   */
  const quota = (): never => {
    throw new ProviderApiError("Claude AI usage limit reached · resets 3pm", 'quota')
  }

  it('共调两次,阻断建议是「等没有用」那一版', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { calls++; quota() }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(calls).toBe(2)
    expect(n.status).toBe('BLOCKED')
    // 带分类(否则 --retry-blocked 捞不回它、阻断卡也给不出建议)。
    expect(n.capCategory).toBe('infra')
    expect(n.blockedReason).toContain('额度/权限用尽')
    // 指的是**上游给的恢复时间**,不是「等几分钟」。
    expect(n.blockedReason).toContain('恢复时间')
    // **不能**是限流那一版 —— 那句话在这里是错的指路(它自己的措辞是「等几分钟再…继续」)。
    expect(n.blockedReason).not.toContain('等几分钟再 /et --resume 继续')
    expect(n.blockedReason).not.toContain('上游在限流')
  })
})

describe('总时长超限:一直有输出但太慢', () => {
  /**
   * 这三条是变异测试实测出来的缺口:总时长这个阀本身有用例(runAgentAdapter.test.ts),
   * 但它**下游的三跳**当时一条都没钉 —— 删掉补救建议、删掉圆桌那一侧的分叉、删掉读回
   * 白名单里的 `'total'`,全套照绿。而这三跳决定的正是「用户看到的那句话对不对」。
   */
  const totalTimeout = (): never => { throw new PhaseTimeoutError(60_000, 'total') }

  it('单点调用:阻断建议是「太慢」那一版,不是「没反应」那一版', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') totalTimeout()
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(n.status).toBe('BLOCKED')
    expect(n.capCategory).toBe('timeout')
    // 「一直有输出」是这一版的核心 —— 叫用户去查网络或调静默预算都不对症。
    expect(n.blockedReason).toContain('一直有输出')
    expect(n.blockedReason).not.toContain('没有人回答工具权限确认')
  })

  it('多角色圆桌:同一句建议,不能退回「先确认角色模型/网络可用」', async () => {
    // 圆桌只剩验收 / 集成验收了(质疑修复不开圆桌,它那一席超时也不阻断),所以探针在验收关。
    const roster = { ...emptyPhaseRoles(), accept: [{ roleName: 'a' }, { roleName: 'b' }] }
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') return '```json\n{"execStatus":"改了 foo.ts"}\n```'
      totalTimeout()
    }
    const n = root()
    n.kind = 'executable'
    n.status = 'READY'
    n.phaseRoles = roster as never
    await stepExecute(n, ctxFor([n], runAgent, { config: { ...cfg, phaseRoles: roster as never } }))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('一直有输出')
    expect(n.blockedReason).not.toContain('网络可用')
  })
})

describe('多角色圆桌耗尽在限流上 —— 用户报的正是这个场景', () => {
  it('阻断理由给的是限流那一版建议,而不是「去查角色模型和网络」', async () => {
    /**
     * 验收实测过的原状:3 席评审、一席持续 429、全票档 → 圆桌三桌用尽 → 阻断理由末尾
     * 贴的是「先确认角色模型/网络可用(角色配置在 .claude/settings.json 的 roles 里),
     * 再重试」。而上游是**通的**,照那句去查什么都查不出来,真正该做的两件事
     * (等一会儿、把并行数或席位数调小)一个字都没说。
     *
     * 根因在更下面一层:`runRoundtable` 把 rejection 合成 infra 裁决时只带 `timeout`,
     * `ProviderApiError.kind` 被丢掉 —— 所以下游没有任何字段能知道这一席是被限流的。
     */
    const roster = { ...emptyPhaseRoles(), accept: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] }
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') return '```json\n{"execStatus":"改了 foo.ts"}\n```'
      if (req.role?.roleName === 'b') rateLimit()
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    n.kind = 'executable'
    n.status = 'READY'
    n.phaseRoles = roster as never
    await stepExecute(n, ctxFor([n], runAgent, { config: { ...cfg, phaseRoles: roster as never } }))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('上游在限流')
    expect(n.blockedReason).not.toContain('网络可用')
  })
})

describe('执行环节吃到 429', () => {
  it('额外重跑一次,阻断时带 infra 分类和限流建议', async () => {
    let execCalls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') { execCalls++; rateLimit() }
      if (req.phase === 'plan') {
        return ptag(req) + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    n.kind = 'executable'
    n.status = 'READY'
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(execCalls).toBe(2)
    expect(n.status).toBe('BLOCKED')
    expect(n.capCategory).toBe('infra')
    expect(n.blockedReason).toContain('上游在限流')
  })

  it('观察评分同样额外重跑一次,仍失败时只记录原因', async () => {
    let scoreCalls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'observer') { scoreCalls++; rateLimit() }
      if (req.phase === 'execute') return etag(req) + '\n{"execStatus":"改完了"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    n.kind = 'executable'
    n.status = 'READY'
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    n.phaseRoles = { ...emptyPhaseRoles(), observer: [{ roleName: 'w' }] } as never
    await stepExecute(n, ctxFor([n], runAgent))
    expect(scoreCalls).toBe(2)
    // 而且节点照样验收通过 —— 评分失败不该让已经完成的工作失败。
    expect(n.status).toBe('ACCEPTED')
  })

  it('执行成功的那条路一个字都没变', async () => {
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'execute') return etag(req) + '\n{"execStatus":"改完了 src/a.ts"}\n```'
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    n.kind = 'executable'
    n.status = 'READY'
    n.plan = { solution: 's', keyPoints: 'k', risks: 'r', acceptance: 'a' }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(n.status).toBe('ACCEPTED')
    expect(n.execStatus).toContain('改完了')
  })
})
