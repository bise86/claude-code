import { z } from 'zod'
import { logError } from '../../../utils/log.js'
import { parseEffortValue, type EffortValue } from '../../../utils/effort.js'
import type { RoleClientConfig } from './roleTypes.js'

const RoleSchema = z.object({
  name: z.string().min(1),
  whenToUse: z.string().min(1),
  execMode: z.enum(['api', 'cli']),
  tools: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  apiProtocol: z.enum(['anthropic', 'openai']).optional(),
  apiUrl: z.string().optional(),
  apiToken: z.string().optional(),
  model: z.string().optional(),
  thinkingDepth: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  cwd: z.string().optional(),
}).strict().superRefine((r, ctx) => {
  // execMode-conditional requireds. Without this, a role missing these
  // fields would still parse (they're all individually optional above)
  // and only blow up later at dispatch time: Bun.spawn(undefined) for a
  // cli role with no command, or `new URL(undefined)` inside
  // buildRoleFetch for an api role missing apiUrl/apiToken/model. Catching
  // it here means the role is skipped up front with a clear message
  // instead of crashing mid-dispatch.
  if (r.execMode === 'cli' && !r.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `role "${r.name}": execMode 'cli' requires 'command'`,
      path: ['command'],
    })
  }
  if (r.execMode === 'api') {
    const missing = (['apiUrl', 'apiToken', 'model'] as const).filter(k => !r[k])
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `role "${r.name}": execMode 'api' requires ${missing.join(', ')}`,
        path: missing,
      })
    }
  }
})

export const RolesSchema = z.array(RoleSchema)

export type RoleAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  source: string
  baseDir: string
  getSystemPrompt: (p: unknown) => Promise<string> | string
  execMode: 'api' | 'cli'
  roleClientConfig?: RoleClientConfig
  command?: string
  args?: string[]
  interactive?: boolean
  roleCwd?: string
  model?: string
  effort?: EffortValue
}

export function parseRoles(rawRoles: unknown, source: string): { role: any; agentDef: RoleAgentDefinition }[] {
  // Validate each role independently rather than z.array(RoleSchema).safeParse(rawRoles)
  // as a whole: zod array validation is atomic, so a single malformed role
  // (e.g. an 'api' role missing apiToken) would fail the entire array and
  // silently drop every OTHER valid role from this source too. Iterating and
  // safeParse-ing element-by-element means one bad role only costs itself.
  const items: z.infer<typeof RoleSchema>[] = []
  if (rawRoles != null) {
    if (!Array.isArray(rawRoles)) {
      logError(new Error('invalid roles config: expected an array'))
    } else {
      rawRoles.forEach((raw, i) => {
        const parsed = RoleSchema.safeParse(raw)
        if (parsed.success) {
          items.push(parsed.data)
        } else {
          const label = raw && typeof raw === 'object' && typeof (raw as any).name === 'string'
            ? (raw as any).name
            : `index ${i}`
          logError(new Error(`invalid role config (${label}): ${parsed.error.message}`))
        }
      })
    }
  }
  const out: { role: any; agentDef: RoleAgentDefinition }[] = []
  for (const r of items) {
    try {
      // thinkingDepth is free-text in settings (z.string().optional()), so it
      // must be validated/normalized before it can be trusted as an
      // EffortValue. An unrecognized value (e.g. 'deep', a typo, wrong case)
      // is dropped to undefined rather than forwarded — sending an invalid
      // value to the Anthropic API's output_config.effort would build a bad
      // request. We normalize the SAME parsed value into both `effort` (used
      // by runAgent.ts) and `roleClientConfig.thinkingDepth` (used by the
      // future openai shim) so the two never disagree about validity.
      const parsedEffort = parseEffortValue(r.thinkingDepth)
      const normalizedThinkingDepth = parsedEffort !== undefined ? String(parsedEffort) : undefined
      const roleClientConfig: RoleClientConfig | undefined = r.execMode === 'api'
        ? { apiProtocol: r.apiProtocol ?? 'anthropic', apiUrl: r.apiUrl!, apiToken: r.apiToken!, backendModel: r.model!, thinkingDepth: normalizedThinkingDepth }
        : undefined
      const promptStr = r.prompt
      out.push({ role: r, agentDef: {
        agentType: r.name,
        whenToUse: r.whenToUse,
        tools: r.tools,
        source,
        baseDir: 'role',
        getSystemPrompt: promptStr ? () => promptStr : () => '',
        execMode: r.execMode,
        roleClientConfig,
        command: r.command,
        args: r.args,
        interactive: r.interactive,
        roleCwd: r.cwd,
        model: r.model,
        effort: parsedEffort,
      }})
    } catch (e) {
      logError(e)
    }
  }
  return out
}
