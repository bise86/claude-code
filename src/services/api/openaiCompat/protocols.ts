import type { RoleClientConfig } from '../../../tools/AgentTool/roles/roleTypes.js'
import type { Evt } from './blocks.js'
import { openaiChunksToAnthropicEvents } from './fromOpenAIStream.js'
import { responsesEventsToAnthropicEvents } from './fromResponsesStream.js'
import { toOpenAIRequest } from './toOpenAIRequest.js'
import { toResponsesRequest } from './toResponsesRequest.js'

/**
 * 一种**要翻译**的员工协议。
 *
 * `anthropic` 不在这张表里 —— 它不翻译,只改 URL 和鉴权头,请求体原样出网。
 *
 * ## 这张表覆盖到哪儿为止(先说清楚,免得它自己变成一句假话)
 *
 * 对 **OpenAI 家族**的方言,新增一种确实只要往这张表里加一项 + 两个纯函数。
 * 但换一个家族(比如 gemini)时这三个成员**不够**:那边的鉴权是 `x-goog-api-key`
 * 或者 query 上的 `?key=`(不是 `Authorization: Bearer`),流是 JSON 数组片段
 * 而不是 SSE 帧,路由还依赖 model 和 method(`/v1beta/models/{model}:streamGenerateContent`),
 * 一个静态字符串装不下。到那时这个接口要再长出 `applyAuth` 和 `parseFrames` 两个钩子。
 *
 * 现在不加是 YAGNI,不是因为它已经够通用了。
 *
 * **还有一处不在这张表里,加协议时必须手动同步**:`roleTypes.ts` 的 `apiProtocol` 是手写的
 * 字面量联合(那个模块 import 本文件,从表派生会成环)。仓库没有 typecheck,所以漏掉它
 * 不会有任何东西报错 —— 而这段自述如果不提它,它自己就是它想防的那种假话。
 */
export interface TranslatingProtocol {
  /** 接在 apiUrl 后面的路由段。 */
  route: string
  /** anthropic 请求体 → 该协议请求体。纯函数。 */
  buildBody(anthropicBody: any, cfg: RoleClientConfig): unknown
  /** 该协议的帧流 → anthropic 事件流。纯函数(生成器)。 */
  toAnthropicEvents(frames: AsyncIterable<any>, ctx: { anthropicModel: string }): AsyncGenerator<Evt>
}

export const TRANSLATING_PROTOCOLS: Record<string, TranslatingProtocol> = {
  openai: {
    route: 'chat/completions',
    buildBody: (body, cfg) => toOpenAIRequest(body, cfg.backendModel, cfg.thinkingDepth),
    toAnthropicEvents: openaiChunksToAnthropicEvents,
  },
  'openai-responses': {
    route: 'responses',
    buildBody: (body, cfg) => toResponsesRequest(body, { backendModel: cfg.backendModel, effort: cfg.thinkingDepth }),
    toAnthropicEvents: responsesEventsToAnthropicEvents,
  },
}

/**
 * 这个协议要不要走翻译层。
 *
 * **判据是「不是 anthropic」,不是「等于 openai」。** 这条区别是整张表最值钱的部分:
 * 仓库里有三处写着 `apiProtocol === 'openai'`,只加 enum 不改它们的后果分别是 ——
 *  - `runAgent.ts`:responses 员工的 `gpt-5.1` 会被当成引擎的 mainLoopModel 传下去,
 *    而引擎要拿它做 Claude 模型的算术(token 预算、别名解析);
 *  - `roleModels.ts`:`/et` 启动关口会**把员工的模型显示错**(回落成 Claude 兜底模型);
 *  - `AgentTool.tsx`:遥测记错模型。
 */
export function isTranslatingProtocol(protocol: string | undefined): boolean {
  return protocol !== undefined && protocol in TRANSLATING_PROTOCOLS
}

/** 配置里能写哪些协议名。zod enum 和文档都从这里取,免得三处各写一份。 */
export const ROLE_API_PROTOCOLS = ['anthropic', ...Object.keys(TRANSLATING_PROTOCOLS)] as const
