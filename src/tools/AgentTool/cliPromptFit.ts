/**
 * cli 档员工的**单发提示词封顶**。
 *
 * ## 为什么 cli 档和 api 档不是同一套
 *
 * api 档的上下文管理器是我们自己(查询循环里的 `autoCompactIfNeeded`),所以那边的做法是
 * 「按员工真正的窗口提前压缩」。cli 档没有循环也没有历史 —— `runCliAgent` 把
 * `task.prompt` 写进 stdin 就完事了,外部 CLI(claude / codex / gemini)自己带上下文管理。
 * 所以这里唯一能做、也唯一该做的事是:**当用户声明了这台 CLI 的窗口、而这一发提示词
 * 明显超出时,在送出去之前把中间挖掉,并且把这件事写在提示词的最前面。**
 *
 * 没声明窗口就**什么都不做** —— 替一台自己会压缩的 CLI 猜一个窗口然后动手截,是在一件
 * 本来不会出错的事上造出一次信息丢失。
 *
 * ## 为什么挖中间、通知放最前面
 *
 * 一段 `/et` 的席位提示词,开头是任务和角色简报,结尾是「上一轮为什么没通过」和产出要求 ——
 * 两头都是指令,中间那一大块是历史。掐尾会让模型看不见要它干什么,掐头会让它不知道自己是谁。
 *
 * 通知放最前面是[被截断的东西不能自己声明自己被截断]那条规矩:放在中间的省略标记,正是
 * 被挖掉的那一段;而放末尾的通知,会在下一次「按窗口再截一刀」时第一个消失。
 */
import { estimateTokens } from '../../services/api/tokenEstimate.js'

/**
 * 留给回答的比例。CLI 那侧的窗口是**进出共用**的,把整扇窗口塞满提示词等于让它无话可说。
 */
const REPLY_RESERVE_FRACTION = 0.25

export type PromptFit = {
  prompt: string
  /** 真的截了吗。调用方要拿它记一条可见的提醒 —— 静默截断是这个仓库反复付代价的那一类。 */
  truncated: boolean
  /** 估算的原始 token 数(只在截断时有意义,给提醒文案用)。 */
  originalTokens?: number
  /** 截掉了多少个字符。 */
  droppedChars?: number
}

/**
 * 把提示词裁进 `contextWindow`。窗口未声明(undefined)时原样返回。
 *
 * @param contextWindow 这台 CLI 的上下文窗口(token),由员工配置声明。
 */
export function fitPromptToWindow(
  prompt: string,
  contextWindow: number | undefined,
): PromptFit {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { prompt, truncated: false }
  }
  const budgetTokens = Math.floor(contextWindow * (1 - REPLY_RESERVE_FRACTION))
  const originalTokens = estimateTokens(prompt)
  if (originalTokens <= budgetTokens) return { prompt, truncated: false }

  /**
   * token → 字符的换算按**这一段自己的实测密度**走,不用一个写死的 4。
   *
   * `estimateTokens` 对中文是 1.5 字/token、对英文是 4 字/token,而 `/et` 的提示词是
   * 中英混排。写死一个比例会让中文提示词被截得远远超出必要(或者不够)。
   */
  const charsPerToken = prompt.length / Math.max(1, originalTokens)
  const budgetChars = Math.max(2_000, Math.floor(budgetTokens * charsPerToken))

  // 通知本身也要占预算 —— 先按最终长度扣掉,免得「加完通知又超了」。
  const notice = truncationNotice(originalTokens, budgetTokens)
  const body = Math.max(1_000, budgetChars - notice.length)
  // 头 60% 尾 40%:开头是任务和角色简报,结尾是上一轮的意见和产出要求 —— 结尾那一段更短
  // 但更不能丢,所以按比例分而不是对半分。
  const headChars = Math.floor(body * 0.6)
  const tailChars = body - headChars
  const head = prompt.slice(0, headChars)
  const tail = prompt.slice(prompt.length - tailChars)
  const dropped = prompt.length - head.length - tail.length
  return {
    prompt: `${notice}${head}\n\n〔……中间约 ${dropped} 个字符因超出上下文窗口被省略……〕\n\n${tail}`,
    truncated: true,
    originalTokens,
    droppedChars: dropped,
  }
}

/** 顶部那句话。它必须能被模型**当指令读**,而不只是一句歉意。 */
export function truncationNotice(originalTokens: number, budgetTokens: number): string {
  return [
    '〔提示词过长已被截断〕',
    `本次任务说明估算约 ${originalTokens} token,超出为你配置的上下文窗口(可用约 ${budgetTokens} token),`,
    '中间一段历史已被省略。若关键信息缺失,请在回答里明确说出你缺什么,不要凭空补齐。',
    '',
    '',
  ].join('\n')
}
