import { z } from 'zod/v4'
import { logError } from '../../../utils/log.js'
import type { EffortValue } from '../../../utils/effort.js'
import { ROLE_API_PROTOCOLS } from '../../../services/api/openaiCompat/protocols.js'
import { parseRoleThinking, resolveRoleThinking, ROLE_THINKING_LEVELS } from './roleThinking.js'
import type { RoleClientConfig } from './roleTypes.js'

/**
 * 载入员工时**没能按你写的那样生效**的一条。
 *
 * 为什么要做成数据而不是继续 `console.error`:实测 ink 的 `patchConsole` 把
 * `console.warn/error/trace` 全部改写成 `logError`,只进 debug 日志文件 ——
 * 交互式会话里屏幕上**一个字都不会出现**。所以下面那几处
 * `// biome-ignore …: must be visible without --debug` 的注释本身就是假话。
 *
 * 后果是用户把 `apiProtocol` 少写一个 s、或者 thinkingDepth 写成 JSON 数字时,
 * 整条员工被跳过,而他只会看到「这个员工不存在」,分不清是自己打错字还是这个功能没做。
 * 交出去之后 `/et` 会把它渲进启动关口的 notices(那一块的标题恰好就是
 * 「你的请求中有以下部分不会生效」)。
 */
export interface RoleLoadIssue {
  /** 员工名;取不到名字时是 `index N`。 */
  name: string
  source: string
  reason: string
}

/** 按来源存,重解析同一个来源时覆盖而不是叠加。 */
const ISSUES = new Map<string, RoleLoadIssue[]>()

/**
 * 把 zod 的第一条 issue 翻成一句**可照做**的中文,合法取值排在最前面。
 *
 * 排序不是审美:关口把整条诊断夹到 100 字,而这条信息的**全部价值**就是让用户知道
 * 该写成什么。英文原文里合法取值排在末尾,实测正好被切掉。
 */
function zhIssue(issues: readonly { code?: string; message: string; path?: (string | number | symbol)[] }[]): string | undefined {
  const first = issues[0]
  if (!first) return undefined
  const field = (first.path ?? []).join('.')
  const opts = /expected one of (.+)$/.exec(first.message)?.[1]?.replace(/"/g, '').replace(/\|/g, ' / ')
  if (opts) return `${field || '某个字段'} 不是合法取值,可用:${opts}`
  if (/expected string, received number/.test(first.message)) return `${field} 要写成字符串(加引号)`
  return field ? `${field}: ${first.message}` : first.message
}

/** 载入员工时所有「没按你写的生效」的条目。给 `/et` 关口和任何想显示它的界面用。 */
export function roleLoadIssues(): RoleLoadIssue[] {
  return [...ISSUES.values(), EXTRA].flat()
}

/**
 * 不在 parseRoles 里发生的那些诊断(比如名字撞上内置 agent —— 那要等全部来源汇总之后
 * 才判得出来)。单独一格,免得被某个来源的重解析覆盖掉。
 */
const EXTRA: RoleLoadIssue[] = []
export function addRoleLoadIssue(issue: RoleLoadIssue): void {
  if (EXTRA.some(e => e.name === issue.name && e.source === issue.source && e.reason === issue.reason)) return
  EXTRA.push(issue)
}

const RoleSchema = z.object({
  name: z.string().min(1),
  whenToUse: z.string().min(1),
  execMode: z.enum(['api', 'cli']),
  tools: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  // 取值从协议注册表派生,不写字面量 —— 加一种协议时这里忘了改,表现是「配了但整条
  // 员工被跳过」,而用户看到的是「这个员工不存在」。
  apiProtocol: z.enum(ROLE_API_PROTOCOLS).optional(),
  apiUrl: z.string().optional(),
  apiToken: z.string().optional(),
  model: z.string().optional(),
  // 数字也收。原来是 `z.string()` + `.strict()`,于是 `"thinkingDepth": 80`(JSON 数字)
  // 会让**整条员工**校验失败被跳过 —— 而 docs/roles-setup.md 明写着可以填一个数字。
  // 用户读到的是「无效值会被忽略」,以为最坏是这个字段不生效。
  thinkingDepth: z.union([z.string(), z.number()]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  cwd: z.string().optional(),
  /**
   * 这个员工能担任哪些 /et 任务角色(双向配置的员工侧)。
   *
   * 必须声明在这里,不能靠 .passthrough:RoleSchema 是 .strict(),用户在员工上写一个
   * 未声明的键会让**整条员工**校验失败并被跳过 —— 表现是「这个员工不存在」,而不是
   * 「这个字段没生效」。角色的阶段/产出/作用只有角色侧有,所以这里只收角色名。
   */
  efftaskRoles: z.array(z.string()).optional(),
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
  const skipped: RoleLoadIssue[] = []
  if (rawRoles != null) {
    if (!Array.isArray(rawRoles)) {
      logError(new Error('invalid roles config: expected an array'))
      // biome-ignore lint/suspicious/noConsole: 非交互模式下这是唯一的出口
      console.error(`[roles] invalid roles config from ${source}: expected an array`)
      skipped.push({ name: 'roles', source, reason: 'roles 不是一个数组,整份员工配置都没有被载入' })
    } else {
      rawRoles.forEach((raw, i) => {
        const parsed = RoleSchema.safeParse(raw)
        if (parsed.success) {
          items.push(parsed.data)
        } else {
          const label = raw && typeof raw === 'object' && typeof (raw as any).name === 'string'
            ? (raw as any).name
            : `index ${i}`
          const reason = parsed.error.issues.map(iss => iss.message).join('; ')
          logError(new Error(`invalid role config (${label}): ${parsed.error.message}`))
          // 关口那侧的 noticeLines 会把整条夹到 100 字。zod 的英文原文里,**可照做的那半句**
          // (合法取值)排在最后 —— 实测 apiProtocol 写错时正好被切在
          // `"anthropic"|"openai"|"open…`,用户看得见自己错了,看不见该写成什么。
          // 所以自己组一句中文,把字段名和合法值放最前面。
          const zh = zhIssue(parsed.error.issues)
          // console.error 在交互式会话里被 ink 的 patchConsole 吞掉(只进 debug 日志),
          // 所以真正让用户看得见的是下面这条 issue。两条都留:非交互(--print)那侧
          // console 还是有用的。
          // biome-ignore lint/suspicious/noConsole: 非交互模式下这是唯一的出口
          console.error(`[roles] "${label}" from ${source} skipped: ${reason}`)
          skipped.push({ name: label, source, reason: `${zh ?? `配置有误:${reason}`}(整条员工未载入)` })
        }
      })
    }
  }
  const issues: RoleLoadIssue[] = []
  const out: { role: any; agentDef: RoleAgentDefinition }[] = []
  for (const r of items) {
    try {
      const protocol = r.apiProtocol ?? 'anthropic'
      /**
       * 思考级别。settings 里是自由文本,必须先归一才能当参数用。
       *
       * **两个字段都从同一个 `resolveRoleThinking` 取值**,不是各 clamp 一次:
       * 一份判据两个调用点,没有第二处可以漂移。而且翻译型协议下
       * `agentDef.effort` 直接置 undefined —— 那条路上它是**死代码**
       * (它进 claude.ts 的 output_config,而 toOpenAIRequest / toResponsesRequest
       * 都是显式白名单,output_config 从来没被拷进出网请求),留一个值只会坑下一个人。
       *
       * 认不出来的值不再静默丢弃:记一条 issue 交给界面。
       */
      const level = parseRoleThinking(r.thinkingDepth)
      if (r.thinkingDepth !== undefined && r.thinkingDepth !== '' && level === undefined) {
        issues.push({ name: r.name, source, reason: `thinkingDepth "${String(r.thinkingDepth)}" 无法识别,已忽略;可用值:${ROLE_THINKING_LEVELS.join(' / ')} 或一个整数` })
      }
      const translating = protocol !== 'anthropic'
      const wire = r.execMode === 'api'
        ? resolveRoleThinking({ level, protocol, model: r.model ?? '' })
        : resolveRoleThinking({ level, protocol: 'anthropic', model: r.model ?? '' })
      if (wire.note) issues.push({ name: r.name, source, reason: wire.note })
      const parsedEffort = translating ? undefined : (wire.value as EffortValue | undefined)
      const roleClientConfig: RoleClientConfig | undefined = r.execMode === 'api'
        ? { apiProtocol: protocol, apiUrl: r.apiUrl!, apiToken: r.apiToken!, backendModel: r.model!, thinkingDepth: wire.value === undefined ? undefined : String(wire.value) }
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
      const reason = e instanceof Error ? e.message : String(e)
      // biome-ignore lint/suspicious/noConsole: 非交互模式下这是唯一的出口
      console.error(`[roles] "${r.name}" from ${source} skipped: ${reason}`)
      issues.push({ name: r.name, source, reason: `载入失败,这条员工没有生效:${reason}` })
    }
  }
  // 覆盖而不是叠加 —— 同一个来源被重新解析时,旧的诊断不该留着。
  ISSUES.set(source, [...skipped, ...issues])
  return out
}
