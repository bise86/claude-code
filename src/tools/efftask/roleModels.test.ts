import { describe, expect, it } from 'bun:test'
import { annotateRoleModels, effectiveModel, type AgentModelInfo } from './roleModels.js'
import { rosterLines } from './startupConfirm.js'
import { DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig } from './types.js'

const MAIN = 'claude-opus-4-8'

const cfg = (roles: Partial<EffTaskConfig['phaseRoles']> = {}): EffTaskConfig => ({
  goalPrompt: '打通登录接口',
  parallelism: 5,
  phaseRoles: { ...emptyPhaseRoles(), ...roles },
  caps: DEFAULT_CAPS,
  notices: [],
})

describe('effectiveModel mirrors runAgent instead of guessing', () => {
  it('an openai-protocol role reports its BACKEND model, not the Claude fallback', () => {
    // runAgent passes `undefined` for agentDefinition.model on openai roles (the engine does
    // Claude-model math) and the request-shim swaps in backendModel at the wire. Reporting
    // the Claude side here would name a model that never sees the work.
    const agent: AgentModelInfo = {
      agentType: 'gpt-reviewer',
      model: 'claude-sonnet-5', // present but NOT what answers
      roleClientConfig: { apiProtocol: 'openai', backendModel: 'gpt-4o' },
    }
    expect(effectiveModel(agent, MAIN)).toBe('gpt-4o')
  })

  it('an openai role with no backendModel falls back to the main model rather than empty', () => {
    const agent: AgentModelInfo = { agentType: 'x', roleClientConfig: { apiProtocol: 'openai' } }
    expect(effectiveModel(agent, MAIN)).toBe(MAIN)
  })

  it("'inherit', blank and absent all mean the session main model", () => {
    expect(effectiveModel({ agentType: 'a', model: 'inherit' }, MAIN)).toBe(MAIN)
    expect(effectiveModel({ agentType: 'a', model: 'Inherit' }, MAIN)).toBe(MAIN)
    expect(effectiveModel({ agentType: 'a', model: '  ' }, MAIN)).toBe(MAIN)
    expect(effectiveModel({ agentType: 'a' }, MAIN)).toBe(MAIN)
    expect(effectiveModel(undefined, MAIN)).toBe(MAIN)
  })

  it('an explicit model is reported verbatim', () => {
    expect(effectiveModel({ agentType: 'a', model: 'claude-haiku-4-5-20251001' }, MAIN))
      .toBe('claude-haiku-4-5-20251001')
  })
})

describe('annotateRoleModels feeds the roster the fourth thing the gate was asked for', () => {
  const agents: AgentModelInfo[] = [
    { agentType: 'arch', model: 'claude-opus-4-8' },
    { agentType: 'sec', roleClientConfig: { apiProtocol: 'openai', backendModel: 'gpt-4o' } },
    { agentType: 'coder' }, // no model → inherits
  ]

  it('names the model of every bound role AND of the un-roled phases', () => {
    const out = annotateRoleModels(cfg({ review: [{ roleName: 'arch' }, { roleName: 'sec' }] }), agents, MAIN)
    const lines = rosterLines(out)
    expect(lines).toContain(`评审: arch(${MAIN})、sec(gpt-4o)`)
    // 不指定就用主模型 — and the gate must say WHICH main model, not just "主模型".
    expect(lines).toContain(`执行: 主模型(${MAIN})`)
    expect(lines).toContain('观察: (评分本期未启用)') // P3 seat stays honest
  })

  it('resolves a duplicated agentType the same way pickAgentDefinition does (first wins)', () => {
    // If the roster named the second definition's model, the gate would advertise a model
    // that the run never dispatches to.
    const dup: AgentModelInfo[] = [
      { agentType: 'dup', model: 'first-model' },
      { agentType: 'dup', model: 'second-model' },
    ]
    const out = annotateRoleModels(cfg({ accept: [{ roleName: 'dup' }] }), dup, MAIN)
    expect(out.phaseRoles.accept[0].model).toBe('first-model')
  })

  it('does not mutate the config it was handed', () => {
    // The parsed config is React state; mutating it in place would edit a rendered value.
    const input = cfg({ plan: [{ roleName: 'arch' }] })
    const before = JSON.stringify(input)
    annotateRoleModels(input, agents, MAIN)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('keeps a model the directive already pinned', () => {
    const out = annotateRoleModels(cfg({ plan: [{ roleName: 'arch', model: 'pinned' }] }), agents, MAIN)
    expect(out.phaseRoles.plan[0].model).toBe('pinned')
  })

  it('a config with no mainModel still renders a roster (resume reads old run.md)', () => {
    expect(rosterLines(cfg())).toContain('执行: 主模型')
  })
})
