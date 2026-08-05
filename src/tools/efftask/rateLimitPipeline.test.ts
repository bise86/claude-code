/**
 * 限流在**单点调用**(分析 / 执行)上的行为。
 *
 * 圆桌那三条路一直有 `roundtableWithInfraRetry`,而 `runPhase` 的六个调用点**一条重试都
 * 没有**:分析拿到 429 就直接 `blockWithReason`,理由是一句英文的
 * `API Error: Request rejected (429)`,`capCategory` 是 undefined —— 阻断卡连一条对症的
 * 建议都给不出,`--retry-blocked` 也捞不回这个节点。而在订阅账号上 SDK 那一层对 429
 * **一次都不重试**(`withRetry.shouldRetry`),所以这里就是全部的重试。
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

  it('一直限流 → 三次之后阻断,而且**带着对症的分类和建议**', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { calls++; rateLimit() }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    expect(calls).toBe(3)
    expect(n.status).toBe('BLOCKED')
    // 分类必须有:不带的话 capBlocked 是 false、capCategory 是 undefined,
    // 阻断卡给不出建议,`--retry-blocked` 也捞不回它。
    expect(n.capBlocked).toBe(true)
    expect(n.capCategory).toBe('infra')
    // 建议必须是限流那一版,而不是默认的「先确认角色模型/网络可用」—— 上游是**通的**。
    expect(n.blockedReason).toContain('上游在限流')
    expect(n.blockedReason).not.toContain('网络可用')
  })

  it('别的 provider 报错**不重试** —— 那不是「慢一点」,是「这条路不通」', async () => {
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
    expect(calls).toBe(1)
    expect(n.status).toBe('BLOCKED')
    expect(n.capCategory).toBeUndefined()
  })
})

describe('额度用尽:不重试,而且给的是另一句话', () => {
  /**
   * 变异测试实测存活:把 quota 那一版建议去掉(和限流共用一句)之后全套照绿。而两者
   * 的差别正是这次拆开它们的全部理由 —— 上游自己说 `resets 3pm`,而限流那一版写着
   * 「等几分钟再 /et --resume 继续」,照它做的人几分钟后会再撞一次。
   */
  const quota = (): never => {
    throw new ProviderApiError("Claude AI usage limit reached · resets 3pm", 'quota')
  }

  it('只调一次,阻断建议是「等没有用」那一版', async () => {
    let calls = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') { calls++; quota() }
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    await stepStart(n, ctxFor([n], runAgent))
    // 不重试:等没有用。
    expect(calls).toBe(1)
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
    const roster = { ...emptyPhaseRoles(), review: [{ roleName: 'a' }, { roleName: 'b' }] }
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return ptag(req) + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      }
      totalTimeout()
    }
    const n = root()
    n.phaseRoles = roster as never
    await stepStart(n, ctxFor([n], runAgent, { config: { ...cfg, phaseRoles: roster as never } }))
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
    const roster = { ...emptyPhaseRoles(), review: [{ roleName: 'a' }, { roleName: 'b' }, { roleName: 'c' }] }
    const runAgent: RunAgentFn = async req => {
      if (req.phase === 'plan') {
        return ptag(req) + '\n{"kind":"executable","solution":"s","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
      }
      if (req.role?.roleName === 'b') rateLimit()
      return vtag(req) + '\n{"pass":true,"blocking":[],"comments":"ok"}\n```'
    }
    const n = root()
    n.phaseRoles = roster as never
    await stepStart(n, ctxFor([n], runAgent, { config: { ...cfg, phaseRoles: roster as never } }))
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('上游在限流')
    expect(n.blockedReason).not.toContain('网络可用')
  })
})

describe('执行环节吃到 429', () => {
  /**
   * **执行环节刻意不重试。** 执行者带写工具,一次 429 可能发生在它已经改过几个文件之后
   * (provider 的错误消息是在工具循环中间到达的)。再跑一遍等于让第二个执行者对着一个
   * 半改过的工作区从头开始 —— 那是返工循环该做的决定(它会先让验收员看过),不该由一条
   * 网络错误在这里替它做。所以这里换成**带分类地阻断**。
   */
  it('只调一次,阻断时带 infra 分类和限流建议', async () => {
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
    expect(execCalls).toBe(1)
    expect(n.status).toBe('BLOCKED')
    expect(n.capCategory).toBe('infra')
    expect(n.blockedReason).toContain('上游在限流')
  })

  it('观察评分也不重试 —— 一个不影响任何判决的数字不值 3 次调用', async () => {
    /**
     * 观察是**咨询性**的:调用失败只记一行「评分调用失败」,而默认(`scoreThreshold`
     * 未设)连一轮返工都不触发。为它付 3 次调用 + 两次冷却是纯浪费。
     */
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
    expect(scoreCalls).toBe(1)
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
