/**
 * **自动压缩的绝对阈值** —— 对齐 codex 的 `model_auto_compact_token_limit`。
 *
 * codex 那边是两个独立的旋钮:`model_context_window` 说这台模型能装多少,
 * `model_auto_compact_token_limit` 说涨到哪个数就压。我们这边原来只有前者,后者是从
 * 前者推出来的(窗口 − 摘要保留 − 缓冲),1M 的窗口推出来是 967000 —— 用户想要的
 * 900000 无处可写。这一组钉的就是「第二个旋钮真的存在、真的被接上、而且没有把
 * 原来那条安全线拆掉」。
 *
 * 三层,缺一层这个功能就是「配了但没生效」:
 *  1. 算术:声明值就是阈值(而没声明时**逐字**还是原来那个数);
 *  2. 接缝:`shouldAutoCompact` / `autoCompactIfNeeded` 真的按它开火;
 *  3. 不变量:硬封顶闸仍排在压缩之后,学到的上界仍咬得动。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  autoCompactIfNeeded,
  calculateTokenWarningState,
  getAutoCompactThreshold,
  shouldAutoCompact,
  shouldPreemptForContextLimit,
} from './autoCompact.js'
import {
  effectiveRoleCompactLimits,
  noteUpstreamContextLimit,
  resetLearnedContextWindows,
} from './roleContextCeiling.js'
import { maxUsefulAutoCompactLimit } from '../../tools/AgentTool/roles/roleContextWindow.js'

const MODEL = 'claude-opus-4-5'
/** 1M 窗口下**推**出来的阈值 —— 没声明绝对阈值时的那个数,不许变。 */
const DERIVED_AT_1M = 967_000

// 模块级账本,测试文件之间共用一份。
beforeEach(() => resetLearnedContextWindows())

describe('两个旋钮,不是一个', () => {
  test('声明 900k:阈值就是 900000,不是推出来的 967000', () => {
    expect(getAutoCompactThreshold(MODEL, { window: 1_000_000, autoCompactAt: 900_000 })).toBe(900_000)
  })

  test('不声明时逐字不变', () => {
    expect(getAutoCompactThreshold(MODEL, { window: 1_000_000 })).toBe(DERIVED_AT_1M)
    expect(getAutoCompactThreshold(MODEL)).toBe(167_000)
  })

  test('老的「传一个数」写法仍然只表示窗口', () => {
    // 仓库没有 typecheck:改成只收对象的话,漏改的调用点会在运行期悄悄变成
    // 「什么都没传」,而那正是这三个函数各自咬过一次的那个坑。
    expect(getAutoCompactThreshold(MODEL, 1_000_000)).toBe(DERIVED_AT_1M)
    expect(getAutoCompactThreshold(MODEL, 32_000)).toBe(getAutoCompactThreshold(MODEL, { window: 32_000 }))
  })

  test('声明值高过安全上限时被夹回来(压缩自己那次请求要发得出去)', () => {
    expect(getAutoCompactThreshold(MODEL, { window: 1_000_000, autoCompactAt: 995_000 })).toBe(DERIVED_AT_1M)
  })
})

/**
 * 载入时挡「写太大」用的是 `maxUsefulAutoCompactLimit`,它**故意**少 min 一项
 * (模型侧的输出上限),因为那一项算不到。这条钉的是「少的那一项只会让它更保守」——
 * 它放行的值,运行期一定原样兑现,不会被 Math.min 悄悄夹一次。
 */
describe('载入时那条上限是运行期的下界', () => {
  const WINDOWS = [8_000, 32_000, 128_000, 200_000, 933_000, 1_000_000, 10_000_000]

  test('对每一档窗口:载入上限 ≤ 运行期推出来的阈值', () => {
    for (const w of WINDOWS) {
      expect(maxUsefulAutoCompactLimit(w)).toBeLessThanOrEqual(getAutoCompactThreshold(MODEL, { window: w }))
    }
  })

  test('正好写到上限的值原样生效', () => {
    for (const w of WINDOWS) {
      const cap = maxUsefulAutoCompactLimit(w)
      expect(getAutoCompactThreshold(MODEL, { window: w, autoCompactAt: cap })).toBe(cap)
    }
  })

  test('933000 就是「窗口 1M、压缩在 900k」的那个反解值', () => {
    expect(maxUsefulAutoCompactLimit(933_000)).toBe(900_000)
  })
})

/** 一条带 usage 的 assistant 消息 —— token 计数就是从这里读的。 */
const withUsage = (inputTokens: number): any => [{
  type: 'assistant', uuid: 'u1', timestamp: new Date(0).toISOString(), requestId: 'r1',
  message: {
    id: 'msg_1', role: 'assistant', type: 'message', model: MODEL,
    content: [{ type: 'text', text: 'x' }], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}]

describe('接缝:真的有人按这个数开火', () => {
  test('920k 上下文:1M 窗口不压;同一份 + 声明 900k 就压', async () => {
    const msgs = withUsage(920_000)
    expect(await shouldAutoCompact(msgs, MODEL, undefined, 0, { window: 1_000_000 })).toBe(false)
    expect(await shouldAutoCompact(msgs, MODEL, undefined, 0, { window: 1_000_000, autoCompactAt: 900_000 })).toBe(true)
  })

  /**
   * 判据是「它有没有动手压」:测试环境里没有 API,压缩必然失败,而「试过并失败」
   * (consecutiveFailures: 1)和「压根没试」在返回值上是分得开的两件事。
   */
  test('autoCompactIfNeeded 从 roleClientConfig 上读到它', async () => {
    const ctx = (autoCompactTokenLimit?: number): any => ({
      options: {
        mainLoopModel: MODEL, tools: [],
        roleClientConfig: {
          apiProtocol: 'openai-responses', apiUrl: 'u', apiToken: 't', backendModel: 'gpt-5.1',
          roleName: 'seat', contextWindow: 1_000_000, autoCompactTokenLimit,
        },
      },
      abortController: new AbortController(), agentId: 'a1',
      getAppState: () => ({}), setAppState: () => {},
    })
    const idle = await autoCompactIfNeeded(withUsage(920_000), ctx(), {} as any, undefined, undefined, 0)
    expect(idle.wasCompacted).toBe(false)
    expect(idle.consecutiveFailures).toBeUndefined()

    const fired = await autoCompactIfNeeded(withUsage(920_000), ctx(900_000), {} as any, undefined, undefined, 0)
    expect(fired.consecutiveFailures).toBe(1)
  })
})

describe('原来那两条线一条都没被拆掉', () => {
  test('硬封顶闸不跟着往下走 —— 压缩先开火,闸门还在 997000', () => {
    const cfg = { roleName: 'seat', contextWindow: 1_000_000, autoCompactTokenLimit: 900_000 }
    expect(shouldPreemptForContextLimit(920_000, MODEL, cfg)).toBe(false)
    // 不变量:阈值那一刻,闸门必须还没开火(开了就永远轮不到压缩)。
    expect(calculateTokenWarningState(900_000, MODEL, effectiveRoleCompactLimits(cfg)).isAtBlockingLimit).toBe(false)
    expect(calculateTokenWarningState(900_000, MODEL, effectiveRoleCompactLimits(cfg)).isAboveAutoCompactThreshold).toBe(true)
  })

  test('学到的上界照样咬得动:上游只吃 500k 时,900k 这句话作废', () => {
    const cfg = { roleName: 'seat', contextWindow: 1_000_000, autoCompactTokenLimit: 900_000 }
    expect(getAutoCompactThreshold(MODEL, effectiveRoleCompactLimits(cfg))).toBe(900_000)
    noteUpstreamContextLimit('seat', 500_000)
    // 窗口被学成 500k → 推出来 467000,和声明的 900000 取小。
    expect(getAutoCompactThreshold(MODEL, effectiveRoleCompactLimits(cfg))).toBe(467_000)
  })
})

/**
 * **`transport: 'sdk'` = 这一席的上下文归上游管。**
 *
 * 约定有两半,必须**同时**成立:出网请求带 `truncation: 'auto'`(那一半由
 * openaiCompat/transportParity.test.ts 钉),以及我们这边**整套**让开 —— 自动压缩不动手,
 * 硬封顶闸也不开火。
 *
 * 第二条是最容易漏的:只关压缩而留着封顶闸,这一席会在请求发出去**之前**被我们自己
 * 合成的一条 `Prompt is too long` 判死,而那正是本该交给上游去截断的那一次请求 ——
 * 结果比改动前更糟(改动前至少还会先压一次)。所以两道闸各钉一条。
 */
describe('谁管这一席的上下文', () => {
  /**
   * 判据不是「transport 是不是 sdk」,而是「**这条协议接不接得住**」:
   * `truncation: 'auto'` 只有 Responses 有,chat/completions 没有。
   * 对 chat 也让开本地压缩的话,那一席就是「我们不压、上游也不截」—— 撞满直接 400,
   * 而用户以为自己已经把这件事交出去了。
   */
  const seat = (protocol: string, transport?: 'raw' | 'sdk') => ({
    roleName: 'seat', contextWindow: 1_000_000, autoCompactTokenLimit: 900_000,
    apiProtocol: protocol, transport,
  })
  const ctx = (protocol: string, transport?: 'raw' | 'sdk'): any => ({
    options: {
      mainLoopModel: MODEL, tools: [],
      roleClientConfig: { apiUrl: 'u', apiToken: 't', backendModel: 'm', ...seat(protocol, transport) },
    },
    abortController: new AbortController(), agentId: 'a1',
    getAppState: () => ({}), setAppState: () => {},
  })

  /** 判据是「它有没有动手压」:测试环境里压不成,但**试过**这件事本身分得开。 */
  const compacted = async (protocol: string, transport?: 'raw' | 'sdk'): Promise<boolean> => {
    const r = await autoCompactIfNeeded(withUsage(920_000), ctx(protocol, transport), {} as any, undefined, undefined, 0)
    return r.consecutiveFailures === 1
  }

  test('openai-responses + sdk:交给上游,我们不压', async () => {
    expect(await compacted('openai-responses', 'sdk')).toBe(false)
  })

  test('openai(chat)+ sdk:上游没有 truncation,所以**照样由我们压**', async () => {
    expect(await compacted('openai', 'sdk')).toBe(true)
  })

  test('raw 档一律由我们压', async () => {
    expect(await compacted('openai-responses', 'raw')).toBe(true)
    expect(await compacted('openai', undefined)).toBe(true)
  })

  test('硬封顶闸和压缩同进同退 —— 只有归上游的那一档放行', () => {
    // 1M 窗口下封顶线是 997000,取 999000 让每一档都毫无疑义地越过它。
    expect(shouldPreemptForContextLimit(999_000, MODEL, seat('openai-responses', 'sdk'))).toBe(false)
    expect(shouldPreemptForContextLimit(999_000, MODEL, seat('openai', 'sdk'))).toBe(true)
    expect(shouldPreemptForContextLimit(999_000, MODEL, seat('openai-responses', 'raw'))).toBe(true)
  })
})
