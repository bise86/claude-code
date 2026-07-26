import { PHASE_NAMES } from './types.js'
import type { EffTaskConfig, PhaseName, RoleBinding } from './types.js'

/**
 * The subset of an AgentDefinition that decides which model actually answers.
 * Kept structural (not the real AgentDefinition) so this module stays testable without
 * constructing a whole agent.
 */
export interface AgentModelInfo {
  agentType: string
  model?: string
  roleClientConfig?: { apiProtocol?: string; backendModel?: string }
}

/**
 * Which model will REALLY answer for this role — mirroring runAgent.ts's resolution rather
 * than guessing from the settings file.
 *
 * Three cases, in the order runAgent applies them:
 * 1. An openai-protocol role does NOT run on `agentDefinition.model`. runAgent deliberately
 *    passes `undefined` there (the engine does Claude-model math and needs a Claude alias),
 *    and the request-shim swaps in `roleClientConfig.backendModel` at the wire. So the model
 *    the user's work is actually handed to is the backend one — naming the Claude fallback
 *    here would be precisely backwards.
 * 2. `inherit`, or no model at all, means the session's main model.
 * 3. Otherwise the role's own model.
 */
export function effectiveModel(agent: AgentModelInfo | undefined, mainModel: string): string {
  if (!agent) return mainModel // no such role → pickAgentDefinition falls back to the main default
  if (agent.roleClientConfig?.apiProtocol === 'openai') {
    return agent.roleClientConfig.backendModel || mainModel
  }
  const m = agent.model?.trim()
  if (!m || m.toLowerCase() === 'inherit') return mainModel
  return m
}

/**
 * Fill in `RoleBinding.model` for every bound role and record the session's main model.
 *
 * WHY this exists as a separate pass: parseDirectives reads the user's prompt and only ever
 * sees role NAMES (`knownRoles: string[]`), so it cannot know what any of them runs on. The
 * confirmation gate, however, was asked for four things — 确认…有多少角色、承担什么、
 * 指定什么角色模型、不指定就用主模型 — and the third and fourth are model disclosure.
 * Without this pass `rosterLines`'s `r.model ? …` branch is dead code and the gate shows a
 * bare role name, which answers only the first two.
 *
 * Returns a NEW config; the input is not mutated (the parsed config is React state).
 */
export function annotateRoleModels(
  config: EffTaskConfig,
  agents: AgentModelInfo[],
  mainModel: string,
): EffTaskConfig {
  // First match wins, exactly as pickAgentDefinition resolves a duplicated agentType — the
  // roster must name the model of the agent that will actually be picked, not another one
  // with the same name.
  const byType = new Map<string, AgentModelInfo>()
  for (const a of agents) if (!byType.has(a.agentType)) byType.set(a.agentType, a)

  const phaseRoles = Object.fromEntries(
    PHASE_NAMES.map(p => [
      p,
      (config.phaseRoles[p] ?? []).map(
        (r): RoleBinding => ({ ...r, model: r.model ?? effectiveModel(byType.get(r.roleName), mainModel) }),
      ),
    ]),
  ) as Record<PhaseName, RoleBinding[]>

  return { ...config, phaseRoles, mainModel }
}
