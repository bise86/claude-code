/**
 * 「Prompt is too long」有**两个发信人**,而它们在消息层面曾经完全同形。
 *
 * ## 这一组守的是一次真实事故
 *
 * 2026-08-19 跑机(qianbase-xtp,run 001):10 个执行席位命中 `Prompt is too long`、6 个节点最终阻断。
 * 所有人 —— 包括四席评审里的三席 —— 都把它当成上游拒收查了大半天,直到有人注意到这些
 * 消息**没有 `errorDetails`**:
 *
 *  - `errors.ts` 的 400/413 分支(真上游拒收)**必带** `errorDetails: error.message`
 *    —— 那是给 `getPromptTooLongTokenGap` 解 `N tokens > M maximum` 用的;
 *  - `query.ts` 的硬封顶闸(**请求根本没发出去**)不带。
 *
 * 也就是说当年能翻案,靠的是一个**没人设计过的副产物**,没有任何测试或注释在守它,
 * 两边随便哪一处改一行就没了。这一组把它从副产物变成判据。
 *
 * ## 为什么必须分开
 *
 * 两者该给的建议正相反。当年阻断卡照「上游拒收」那套劝用户**调大** `contextWindow` ——
 * 而封顶闸当时漏传员工窗口、恒在 177000 开火,调大只会把压缩阈值抬到更高,把两者之间的
 * 必杀区间拉得更宽:声明 233000 是 [177000, 200000),声明 1M 是 [177000, 967000)。
 * **用户越听话,席位死得越干净。**
 */
import { describe, expect, it } from 'bun:test'

import { stepExecute, type PipelineCtx } from './pipeline.js'
import {
  ProviderApiError,
  isPromptTooLongError,
  providerErrorInfoOf,
} from './runAgentAdapter.js'
import {
  LOCAL_CONTEXT_LIMIT_DETAIL,
  isRecoverableUpstreamContextLimit,
} from '../../services/api/errors.js'
import type { RunAgentFn } from './roundtable.js'
import {
  createNode, DEFAULT_CAPS, emptyPhaseRoles, type EffTaskConfig, type TaskNode,
} from './types.js'

const NOW = '2026-08-19T00:00:00.000Z'
const cfg: EffTaskConfig = {
  goalPrompt: 'g', parallelism: 5, phaseRoles: emptyPhaseRoles(), caps: DEFAULT_CAPS, notices: [],
}
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

/** 上游那条的真实形状 —— **必带** errorDetails(见 errors.ts 的 400/413 分支)。 */
const upstreamPtl = (): unknown[] => [{
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'invalid_request',
  errorDetails: 'prompt is too long: 220000 tokens > 200000 maximum',
  message: { content: [{ type: 'text', text: 'Prompt is too long' }] },
}]

/** 本地封顶闸那条的真实形状 —— 正文和 error 字段与上面**逐字相同**,只有署名不同。 */
const localPtl = (): unknown[] => [{
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'invalid_request',
  errorDetails: LOCAL_CONTEXT_LIMIT_DETAIL,
  message: { content: [{ type: 'text', text: 'Prompt is too long' }] },
}]

describe('适配层认得出这两个发信人', () => {
  /**
   * 变异:把 `providerErrorInfoOf` 里那句 `m.errorDetails === LOCAL_CONTEXT_LIMIT_DETAIL`
   * 的三元删掉(一律返回 'prompt_too_long')→ 第二条红。
   */
  it('上游拒收 → prompt_too_long', () => {
    expect(providerErrorInfoOf(upstreamPtl())?.kind).toBe('prompt_too_long')
  })

  it('本地封顶闸 → local_context_limit', () => {
    expect(providerErrorInfoOf(localPtl())?.kind).toBe('local_context_limit')
  })

  /**
   * 正文分不开这两种 —— 这条钉的就是「别再想着靠正文区分」。两条消息的 text 完全一样。
   */
  it('两者正文逐字相同,所以判据只能是署名', () => {
    const a = providerErrorInfoOf(upstreamPtl())
    const b = providerErrorInfoOf(localPtl())
    expect(a?.text).toBe(b?.text as string)
    expect(a?.kind).not.toBe(b?.kind as string)
  })

  /**
   * 没有 errorDetails 的历史消息(以及别的 provider 直接回的 400)仍然算真上游拒收 ——
   * 只有**显式署名**才算本地闸。宁可把本地闸误判成上游,也不要反过来:反过来会让引擎
   * 拿自家闸去收员工窗口,那是一条自己咬自己的负反馈。
   */
  it('没有署名时按上游算', () => {
    const msgs = upstreamPtl() as { errorDetails?: string }[]
    delete msgs[0]!.errorDetails
    expect(providerErrorInfoOf(msgs)?.kind).toBe('prompt_too_long')
  })
})

describe('阻断卡给的是两句不同的话', () => {
  const runFailing = async (kind: 'prompt_too_long' | 'local_context_limit'): Promise<TaskNode> => {
    const runAgent: RunAgentFn = async () => {
      throw new ProviderApiError('Prompt is too long', kind)
    }
    const n = root()
    await stepExecute(n, ctxFor([n], runAgent))
    return n
  }

  /**
   * 这条钉的是 **`capBlocked === true`**,不是分类本身 —— 分类那一格近乎恒真
   * (`blockCategoryOf` 末尾兜底就是 'infra',验收席实测删掉那半句判据 11 条全绿)。
   * 而 `capBlocked` 是要紧的:它是 false 的话 `--retry-blocked` 三条恢复路全不认这个
   * 节点,盘上写死之后再也捞不回来(这条坑本仓库已经付过三次)。
   */
  it('两种都是可恢复的 infra 阻断', async () => {
    for (const kind of ['prompt_too_long', 'local_context_limit'] as const) {
      const n = await runFailing(kind)
      expect(n.status).toBe('BLOCKED')
      expect(n.capBlocked).toBe(true)
      expect(n.capCategory).toBe('infra')
    }
  })

  /**
   * 变异:把 `remedyOf` 里 `if (res.localContextLimit === true) return localContextLimitRemedy()`
   * 删掉 → 本地闸会拿到通用建议(「先确认角色模型/网络可用」),这条红。
   */
  it('本地闸那条说「请求没有发出去」,并且明说调大窗口没用', async () => {
    const n = await runFailing('local_context_limit')
    expect(n.blockedReason).toContain('没有发出去')
    expect(n.blockedReason).toContain('contextWindow 调大**没有用**')
    // 上游那套的措辞不许出现在这里
    expect(n.blockedReason).not.toContain('上游拒收的是**长度**')
  })

  it('上游那条说的是「往小里写」,并且说明引擎已经自动救过一次', async () => {
    const n = await runFailing('prompt_too_long')
    expect(n.blockedReason).toContain('上游拒收的是**长度**')
    expect(n.blockedReason).toContain('压缩一次并重发过了')
    expect(n.blockedReason).toContain('往**小**里写')
  })

  /**
   * **这条是整组的重点。** 事故当天阻断卡上那句建议是「给这个员工声明真实的上下文窗口」,
   * 而用户照做(233000)之后 25 分钟里死了 9 个席位。这句话在任何一条路上都不许再出现。
   *
   * 变异:把 `promptTooLongRemedy` 改回旧文案 → 这条红。
   */
  it('那句把用户推进必杀区间的旧建议,两条路上都不许再出现', async () => {
    for (const kind of ['prompt_too_long', 'local_context_limit'] as const) {
      const n = await runFailing(kind)
      expect(n.blockedReason).not.toContain('声明真实的上下文窗口')
      expect(n.blockedReason).not.toContain('换一个窗口更大的员工模型')
    }
  })
})

describe('引擎侧:哪一种值得「收窗口 + 压一次 + 重发」', () => {
  const asMsg = (raw: unknown[]): never => raw[0] as never

  /**
   * 这条是 `query.ts` 恢复分支的判据本体(它就调这个函数)。
   *
   * 变异:把 `!isLocalContextLimitMessage(msg)` 删掉 → 第二条红,而那正是最危险的
   * 一种回归:引擎会拿**自家闸**去收员工窗口,窗口收小 → 阈值降低 → 更早撞自己的闸
   * → 再收,几轮就把席位锁死在地板上。
   */
  it('上游拒收 → 救', () => {
    expect(isRecoverableUpstreamContextLimit(asMsg(upstreamPtl()))).toBe(true)
  })

  it('本地封顶闸 → 不救(否则是一条自己咬自己的负反馈)', () => {
    expect(isRecoverableUpstreamContextLimit(asMsg(localPtl()))).toBe(false)
  })

  it('没有消息 / 不是报错 / 不是 PTL 一律不救', () => {
    expect(isRecoverableUpstreamContextLimit(undefined)).toBe(false)
    expect(isRecoverableUpstreamContextLimit({
      type: 'assistant', isApiErrorMessage: false,
      message: { content: [{ type: 'text', text: 'Prompt is too long' }] },
    } as never)).toBe(false)
    expect(isRecoverableUpstreamContextLimit({
      type: 'assistant', isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: Request rejected (429)' }] },
    } as never)).toBe(false)
  })
})

describe('压缩重发这条路对两档都开着', () => {
  /**
   * `isPromptTooLongError` 是 `makeRunAgentFn` 那层压缩重发(PROMPT_SHRINK_RATIOS 三档)
   * 的闸。**两档都要认。**
   *
   * 第一版只认 `prompt_too_long`,于是新增的 `local_context_limit` 顺手把这条路对本地闸
   * 整条关掉了 —— 两席验收各自实测:重发次数 3 → 1,节点第一次就 BLOCKED。而本地闸量的是
   * **整段对话**,席位第一轮时那段对话**就是**我们发过去的提示词(方案正文 + 历次意见 +
   * 执行自述都在里面),压到 55%/30%/15% 是那一轮唯一真正能让它过闸的手段 ——
   * 摘要压缩在只有一条消息时救不了。
   *
   * 变异:把 `|| e.kind === 'local_context_limit'` 删掉 → 第二条红。
   */
  it.each([
    ['上游拒收', 'prompt_too_long'],
    ['本地封顶闸', 'local_context_limit'],
  ] as const)('%s 也走压缩重发', (_label, kind) => {
    expect(isPromptTooLongError(new ProviderApiError('Prompt is too long', kind))).toBe(true)
  })

  it('别的故障不走这条路', () => {
    for (const kind of ['rate_limit', 'quota'] as const) {
      expect(isPromptTooLongError(new ProviderApiError('x', kind))).toBe(false)
    }
    expect(isPromptTooLongError(new Error('Prompt is too long'))).toBe(false)
  })
})

describe('自动压缩被关掉时,两句建议都要换口径', () => {
  /**
   * 「闸门排在自动压缩之后」这条不变量由 `calculateTokenWarningState` 的 `Math.max` 保证,
   * 而那个 `Math.max` **带着 `isAutoCompactEnabled()` 前提**。关掉之后闸门回到
   * `effective − 3000` 并排在压缩之前(压缩根本不跑),这时候原来那两句
   * 「压缩跑了但没压下去」「调大 contextWindow 没有用」**都是反的** —— 调大窗口恰恰是
   * 那种情况下唯一有用的旋钮。
   *
   * 2026-08-19 那次事故就是建议把用户推向了错误的旋钮;这里不许用反方向再犯一次。
   *
   * 变异:把两个 remedy 里的 `isAutoCompactEnabled()` 分支删掉 → 这两条红。
   */
  const withCompactDisabled = async (
    kind: 'prompt_too_long' | 'local_context_limit',
  ): Promise<string> => {
    const prev = process.env.DISABLE_AUTO_COMPACT
    process.env.DISABLE_AUTO_COMPACT = '1'
    try {
      const runAgent: RunAgentFn = async () => {
        throw new ProviderApiError('Prompt is too long', kind)
      }
      const n = root()
      await stepExecute(n, ctxFor([n], runAgent))
      return n.blockedReason ?? ''
    } finally {
      if (prev === undefined) delete process.env.DISABLE_AUTO_COMPACT
      else process.env.DISABLE_AUTO_COMPACT = prev
    }
  }

  it('本地闸:不再说「压缩跑了但没压下去」,也不再说调大窗口没用', async () => {
    const reason = await withCompactDisabled('local_context_limit')
    expect(reason).toContain('自动压缩被关掉了')
    expect(reason).not.toContain('压缩跑了但没压下去')
    expect(reason).not.toContain('调大**没有用**')
  })

  it('上游拒收:不再声称引擎已经救过一次', async () => {
    const reason = await withCompactDisabled('prompt_too_long')
    expect(reason).toContain('自动压缩被关掉了')
    expect(reason).not.toContain('压缩一次并重发过了')
  })
})
