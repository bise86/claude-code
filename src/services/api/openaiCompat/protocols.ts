import type OpenAI from 'openai'
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
/**
 * 翻译一条流时,除了帧本身还需要知道的东西。
 *
 * `requestId` 和 `estimatedInput` 都只为**上游不报用量**那条路服务:那时候整趟运行的
 * token 会全是 0(实测有网关直接忽略 `stream_options.include_usage`),而 0 是一句假话。
 * 兜底估算需要输入侧的量级(`estimatedInput`,由发请求的那一层算,只有它看得见请求体),
 * 而「这个数是估的」这件事要靠 `requestId` 传到用量表那一侧(见 tokenEstimate 的注释:
 * 塞进 usage 里的自定义字段会被 claude.ts 的白名单静默丢掉)。
 */
export interface StreamCtx {
  anthropicModel: string
  /** 这次响应的 request-id(由翻译层自己签发)。缺席则「是估算」这件事无处可记。 */
  requestId?: string
  /**
   * 请求体的估算 token 数,**惰性**。
   *
   * 写成函数而不是数:绝大多数请求上游会给真 usage,这个数直接扔掉;而算它要把整个
   * 请求体再 `JSON.stringify` 一遍并逐码点扫 —— 评审实测 703KB 的请求体上 20.8ms 的
   * **同步**阻塞(那期间整个界面不刷新,包括别的节点正在跑的日志窗)。
   */
  estimatedInput?: () => number
}

export interface TranslatingProtocol {
  /** 接在 apiUrl 后面的路由段。 */
  route: string
  /** anthropic 请求体 → 该协议请求体。纯函数。 */
  buildBody(anthropicBody: any, cfg: RoleClientConfig): unknown
  /** 该协议的帧流 → anthropic 事件流。纯函数(生成器)。 */
  toAnthropicEvents(frames: AsyncIterable<any>, ctx: StreamCtx): AsyncGenerator<Evt>
  /**
   * **sdk 档**:同一个请求体,改用官方 `openai` 客户端发出去,产出的帧和 raw 档同形。
   *
   * 收 `body` 而不是自己再构造一遍 —— 两条传输**共用** `buildBody` 的产物,这是
   * 「换传输不改变语义」这条不变量的落点,也是对拍测试能做成严格相等的原因。
   *
   * `import type` 引 SDK:类型在构建期被完全擦掉,员工载入路径上不会因此多拖一个包。
   */
  sdkStream(client: OpenAI, body: any, signal?: AbortSignal): Promise<AsyncIterable<any>>
  /**
   * 这条协议**能不能把上下文交给上游** —— 也就是线格式里有没有「超了自己丢」这个字段。
   *
   * Responses 有 `truncation: 'auto'`;chat/completions **没有**。差别不是细节:
   * `transport: 'sdk'` 那一档的约定是「这一席的上下文归上游管」,而这个约定只有在上游
   * 真的接得住的时候才成立。接不住却照样让开本地压缩,就是一个两边都不管的裸奔组合 ——
   * 撞满直接 400,而用户以为自己已经把这件事交出去了。
   *
   * 所以这个事实必须留在**注册表**里,和 route / buildBody 放在一起:加一条新方言时,
   * 「它管不管上下文」是和「它的路由是什么」同等必答的问题。写在别处就会漏。
   */
  upstreamTruncation: boolean
}

export const TRANSLATING_PROTOCOLS: Record<string, TranslatingProtocol> = {
  openai: {
    route: 'chat/completions',
    buildBody: (body, cfg) => toOpenAIRequest(body, cfg.backendModel, cfg.thinkingDepth),
    toAnthropicEvents: openaiChunksToAnthropicEvents,
    sdkStream: (client, body, signal) => client.chat.completions.create(body, { signal }) as any,
    // chat/completions 没有 truncation —— 这一档的上下文**由我们压**,和 raw 一样。
    upstreamTruncation: false,
  },
  'openai-responses': {
    route: 'responses',
    buildBody: (body, cfg) => toResponsesRequest(body, {
      backendModel: cfg.backendModel,
      effort: cfg.thinkingDepth,
      // sdk 档 = 上下文归上游管。这是那个约定的**出网**那一半。
      truncation: cfg.transport === 'sdk',
    }),
    toAnthropicEvents: responsesEventsToAnthropicEvents,
    sdkStream: (client, body, signal) => client.responses.create(body, { signal }) as any,
    upstreamTruncation: true,
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

/**
 * 所有翻译协议的路由段。
 *
 * `joinRoute` 拿它去**剥掉 apiUrl 自己带的路由**:厂商文档印的是完整端点
 * (`https://host/v1/chat/completions`),复制粘贴进 apiUrl 天经地义 —— 不剥就拼成
 * `/v1/chat/completions/responses`,而网关对这种路径回的常常是一个**空体 502**。
 *
 * 是全表而不是「本次这一条」:换协议时 apiUrl 常常还停在上一条协议的路由上。
 */
export const PROTOCOL_ROUTES = Object.values(TRANSLATING_PROTOCOLS).map(p => p.route)

/**
 * 哪些协议能把上下文交给上游(见 `upstreamTruncation`)。
 *
 * 从表派生,不写死名字:压缩那一侧要问的是「这一席的上下文归谁管」,而答案的来源必须
 * 只有一处 —— 否则加一条新方言时,漏改的表现是**静默**的(那一席既没人压、上游也不截,
 * 撞满才炸,而那时已经跑了几十轮)。
 */
export const UPSTREAM_TRUNCATION_PROTOCOLS: ReadonlySet<string> = new Set(
  Object.entries(TRANSLATING_PROTOCOLS).filter(([, p]) => p.upstreamTruncation).map(([name]) => name),
)
