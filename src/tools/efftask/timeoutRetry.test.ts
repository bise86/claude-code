/**
 * 静默超时**自动重跑一次**(见 pipeline.ts 的 TIMEOUT_RETRIES)。
 *
 * 在此之前,走单次调用的九个环节里任何一次静默超时都是节点的死刑:`runPhase` 的重试循环
 * 只认 `res.rateLimited`,超时原样返回 → `blockWithReason('timeout')` → BLOCKED,要人回到
 * 终端敲 `/et --resume <id> --retry-blocked` 才动得了。而超时是 `infra` ——
 * **没有任何人对这份工作做出过判断**,和「评审员否掉了」完全是两回事。
 *
 * 这一档钉的是四条界线,少一条都会变成另一个病:
 *  1. 静默/总时长超时 → 自动再跑一次(**包括执行、解冲突这些会写盘的环节**,用户定的);
 *  2. 等人超时 → **不**重跑(那是「没人来点确认」,再跑只会再挂一个 humanTimeoutMs);
 *  3. 中止 / 用户取消该节点 → **不**重跑(那是决定,不是故障);
 *  4. 只多试一次,而且两次都没成的话,这件事要写进 blockedReason —— 否则用户看到的
 *     只有一句「静默超时」,第一反应是手动再跑一遍,而那一遍刚刚已经替他跑过了。
 */
import { describe, expect, it } from 'bun:test'

import { createRunControl } from './control.js'
import { PipelineCtx, stepExecute, stepStart } from './pipeline.js'
import type { RunAgentFn } from './roundtable.js'
import { PhaseTimeoutError } from './runAgentAdapter.js'
import { byIdMap } from './stateMachine.js'
import {
  createNode, emptyPhaseRoles, DEFAULT_CAPS, DEFAULT_PARALLELISM,
  type EffTaskConfig, type TaskNode,
} from './types.js'

const NOW = '2026-07-25T00:00:00Z'
const cfg: EffTaskConfig = {
  goalPrompt: 'g', parallelism: DEFAULT_PARALLELISM, phaseRoles: emptyPhaseRoles(), caps: { ...DEFAULT_CAPS },
}
const root = () => createNode({ id: 'root', title: 'r', parentId: null, deps: [], depth: 0, phaseRoles: emptyPhaseRoles(), now: NOW })

// 裁决要答在**本次调用**那个随机标记下 —— 和 pipeline.test.ts 同一条规矩。
const vtag = (req: { prompt: string }) => '```' + (req.prompt.match(/语言标记\(fence info string\)写成 (verdict[a-z]+)/)?.[1] ?? 'verdict')
const PLAN_OK = '```json\n{"kind":"executable","solution":"第二次答的","keyPoints":"k","risks":"r","acceptance":"跑 bun test 全绿"}\n```'
const EXEC_OK = '```json\n{"execStatus":"第二次改的 foo.ts"}\n```'
/** 重跑旁白的特征词 —— 提示词末尾那段只有重跑那一次才有。 */
const RETRY_NOTE = '这一次是重跑'
/** 静默那一版建议的特征词(和 humanTimeoutAdvice.test.ts 用的是同一个)。 */
const STALL_ADVICE = '把该节点拆小'

function ctxFor(nodes: TaskNode[], runAgent: RunAgentFn, over: Partial<PipelineCtx> = {}): PipelineCtx {
  const byId = byIdMap(nodes)
  return {
    config: cfg, byId, runAgent, persist: async () => {}, now: () => NOW,
    signal: new AbortController().signal, onUpdate: () => {},
    reserveNodes: () => ({ release: () => {} }),
    ...over,
  }
}

/** 每次都以静默超时失败。 */
const stall = () => new PhaseTimeoutError(600_000, 'stall')

describe('静默超时自动重跑', () => {
  it('分析:第一次静默超时,自动重跑一次就活了 —— 而不是把节点判死', async () => {
    const n = root()
    let plans = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'plan') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      plans++
      if (plans === 1) throw stall()
      return PLAN_OK
    }
    await stepStart(n, ctxFor([n], runAgent))
    expect(plans).toBe(2)
    expect(n.status).toBe('READY')
    expect(n.blockedReason).toBe('')
    expect(n.plan.solution).toBe('第二次答的')
  })

  it('执行:会写盘的环节同样重跑,第二次的产出就是节点的产出', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      if (execs === 1) throw stall()
      return EXEC_OK
    }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(execs).toBe(2)
    expect(n.status).toBe('ACCEPTED')
    expect(n.execStatus).toBe('第二次改的 foo.ts')
  })

  it('重跑那一次的提示词带「上一次被中止」的旁白,第一次不带', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      prompts.push(req.prompt)
      if (prompts.length === 1) throw stall()
      return EXEC_OK
    }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain(RETRY_NOTE)
    expect(prompts[1]).toContain(RETRY_NOTE)
    // 这三句各修一个具体的病,见 timeoutRetryNote:
    // 「不是被否掉的」→ 否则它去改一个没人反对过的答案;
    // 「先看一眼现在的实际状态」→ 否则第二个执行者对着改了一半的树从头再写一遍;
    // 「输出格式不变」→ 这段旁白追加在提示词最后,而输出格式要求恰好也在最后。
    expect(prompts[1]).toContain('不是有人否掉了你的答案')
    expect(prompts[1]).toContain('现在的实际状态')
    expect(prompts[1]).toContain('输出格式')
    // 静默那一版的措辞。总时长超时是另一句(见下一条)。
    expect(prompts[1]).toContain('一个字都没有输出')
  })

  it('总时长超时:也重跑,但旁白换成「攒不出一条完整消息」那一版', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const prompts: string[] = []
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      prompts.push(req.prompt)
      if (prompts.length === 1) throw new PhaseTimeoutError(3_600_000, 'total')
      return EXEC_OK
    }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('完成一条完整消息')
    expect(prompts[1]).not.toContain('一个字都没有输出')
  })

  it('重跑开的是另一条流,表头上看得出这是重跑那一次', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const labels: string[] = []
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      if (execs === 1) throw stall()
      return EXEC_OK
    }
    await stepExecute(n, ctxFor([n], runAgent, {
      openStream: meta => { labels.push(meta.phaseLabel); return { push: () => {}, end: () => {} } },
    }))
    const exec = labels.filter(l => l.startsWith('执行'))
    expect(exec).toHaveLength(2)
    // 一模一样的表头 = 节点详情里两条同名同轮次的记录,前一条停在「静默超时」,
    // 用户分不出哪条是后来的那次。
    expect(exec[0]).not.toContain('超时重跑')
    expect(exec[1]).toContain('超时重跑')
  })

  it('两次都超时:恰好两次调用(不是三次),BLOCKED,而且阻断理由说明已经替他重跑过', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      throw stall()
    }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(execs).toBe(2)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).toContain('已自动重跑')
    // 锚点不能被这句追加挤掉:`超时(N ms)` 是用户和测试都在读的形状。
    expect(n.blockedReason).toContain('超时(600000 ms)')
    // 补救建议照旧是静默那一版 —— 重跑不改变病因。
    expect(n.blockedReason).toContain(STALL_ADVICE)
  })

  it('等人超时:一次都不重跑 —— 再跑只会再挂一个 humanTimeoutMs,而确认还是没人点', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      throw new PhaseTimeoutError(7 * 24 * 60 * 60 * 1000, 'human')
    }
    await stepExecute(n, ctxFor([n], runAgent))
    expect(execs).toBe(1)
    expect(n.status).toBe('BLOCKED')
    expect(n.blockedReason).not.toContain('已自动重跑')
    expect(n.blockedReason).toContain('把那个确认点掉')
  })

  it('用户在调用途中取消了这个节点:不重跑', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    const control = createRunControl()
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      // 调用在飞的时候用户按了 x —— 之后这次调用以超时结束(两件事可以同时发生)。
      control.cancelNode(n.id)
      throw stall()
    }
    await stepExecute(n, ctxFor([n], runAgent, { control }))
    expect(execs).toBe(1)
  })

  it('不是超时的失败不走这条路 —— 这是超时重跑,不是一层通用重试', async () => {
    const n = root(); n.kind = 'executable'; n.status = 'READY'
    let execs = 0
    const runAgent: RunAgentFn = async req => {
      if (req.phase !== 'execute') return vtag(req) + '\n{"pass":true,"blocking":[],"comments":""}\n```'
      execs++
      throw new Error('API Error: 500 upstream boom')
    }
    await stepExecute(n, ctxFor([n], runAgent))
    // 上游错误的退避重试住在 SDK 那一层(withRetry,默认 10 次),到这里已经试过了。
    expect(execs).toBe(1)
    expect(n.status).toBe('BLOCKED')
  })
})
