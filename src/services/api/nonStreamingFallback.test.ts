/**
 * 流式失败之后的**非流式回退**,在「只走流式」的员工链路上必须自己关掉。
 *
 * 这一档钉的是一条真实跑机上的事故:一个 `openai-responses` 员工已经连续跑通了几十上百次
 * 调用,某一轮突然死在
 *
 *   `API Error: 400 员工「架构」(openai-responses 协议)调用失败 · POST …/v1/responses
 *    → 400 · 上游原文:{"error":{"message":"Stream must be set to true", …}}`
 *
 * 上。那个 400 不是配置错 —— 它是引擎在一次流式失败后**静默地**把同一轮改成非流式重发
 * 的产物,而翻译层的请求体在 `body.stream` 缺席时确实不发这个字段。400 不可重试,于是
 * 一次本可重试的流中断变成必死:那一席当场死掉,上百条消息的对话作废。
 *
 * 之前这条只写在 README 里(让用户自己 `export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`),
 * 用户又撞了一次 —— 所以现在由代码自己判。探针因此要从**两侧**看:
 * 真的 `buildRoleFetch` 产物 → 真的判据函数,中间不放替身。
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { shouldDisableNonStreamingFallback } from './claude.js'
import { buildRoleFetch, isStreamOnlyFetch } from './openaiCompat/roleFetch.js'

const role = (apiProtocol: 'anthropic' | 'openai' | 'openai-responses') =>
  buildRoleFetch({
    apiProtocol,
    apiUrl: 'http://10.10.20.21:3000/v1',
    apiToken: 'sk-role',
    backendModel: 'gpt-5.6-terra',
    roleName: '架构',
  })

describe('只走流式的链路自己关掉非流式回退', () => {
  const saved = process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
  beforeEach(() => {
    // 判据是三条 OR,环境变量那一条会盖住我们要测的那一条。
    delete process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
  })
  afterEach(() => {
    if (saved === undefined)
      delete process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
    else process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = saved
  })

  /**
   * 这一条今天就是红的:回退照发,网关回 400。
   * 变异:把 `isStreamOnlyFetch(fetchOverride)` 从判据里去掉 → 这条会红。
   */
  it('openai-responses 员工:不再改成非流式重发', () => {
    expect(shouldDisableNonStreamingFallback(role('openai-responses'))).toBe(
      true,
    )
  })

  it('openai(chat/completions)员工:同样只走流式', () => {
    expect(shouldDisableNonStreamingFallback(role('openai'))).toBe(true)
  })

  /**
   * `anthropic` 协议是**原样转发**(只改 URL 和鉴权头,连 body 都不看),非流式请求在
   * 那条路上一切正常 —— 关掉回退会白白掐掉一条真能救场的路。
   * 变异:把 roleFetch 里的 `cfg.apiProtocol !== 'anthropic'` 判断去掉 → 这条会红。
   */
  it('anthropic 协议的员工不受影响 —— 那条路非流式是通的', () => {
    expect(shouldDisableNonStreamingFallback(role('anthropic'))).toBe(false)
  })

  it('没有员工(会话自己的端点)时判据不动', () => {
    expect(shouldDisableNonStreamingFallback(undefined)).toBe(false)
    expect(shouldDisableNonStreamingFallback(globalThis.fetch)).toBe(false)
    // 非函数不许把判据带崩 —— 这个参数一路来自 options,类型是 unknown。
    expect(shouldDisableNonStreamingFallback({ stream: 'only' })).toBe(false)
  })

  it('环境变量那条老开关仍然管用', () => {
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    expect(shouldDisableNonStreamingFallback(undefined)).toBe(true)
  })
})

/**
 * 判据写对了、调用点没接上 —— 这个仓库反复出的就是这一种错(roleWiring.test.ts 的
 * 开头那段说的正是它)。而 `queryModel` 那两个回退点埋在一个要真 client、真流、真重试
 * 的生成器深处,在单测里驱动不动。所以这一档退而求其次:钉**源码上的调用点**,
 * 并且明说它是源码级的 —— 它挡不住实现改错,但挡得住「这个函数没人调」。
 */
describe('两个回退点都接上了', () => {
  const src = readFileSync(
    new URL('./claude.ts', import.meta.url).pathname,
    'utf8',
  )

  it('流式失败后的回退走 shouldDisableNonStreamingFallback', () => {
    expect(src).toContain(
      'const disableFallback = shouldDisableNonStreamingFallback(\n' +
        '        options.fetchOverride,\n' +
        '      )',
    )
  })

  /**
   * 404 那条回退是另一个判据(它假定「换成非流式说不定就通了」)。翻译层不区分流式/
   * 非流式路由 —— 两者 POST 的是同一个 URL,同一个 404 会原样再来一次,而真正被替掉的
   * 是那句带员工名/协议/URL 的诊断。
   */
  it('404 那条回退也被同一个事实挡住', () => {
    const at = src.indexOf('const is404StreamCreationError =')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, at + 600)).toContain(
      '!isStreamOnlyFetch(options.fetchOverride)',
    )
  })
})

describe('标记打在真正出网的那个函数上', () => {
  /**
   * 标记必须活过一次「当普通 fetch 传来传去」—— 它一路从 query.ts 的 resolveRoleFetch
   * 传到 claude.ts 的 options.fetchOverride,中间没人知道它有这个属性。
   */
  it('翻译型协议的 fetch 带标记,anthropic 的不带', () => {
    expect(isStreamOnlyFetch(role('openai-responses'))).toBe(true)
    expect(isStreamOnlyFetch(role('anthropic'))).toBe(false)
  })

  /** 不可枚举:任何 `{...fn}` / 日志打点都不该把这个内部标记抖出去。 */
  it('标记不可枚举', () => {
    const f = role('openai-responses')
    expect(Object.getOwnPropertySymbols({ ...f })).toHaveLength(0)
    expect(isStreamOnlyFetch(f)).toBe(true)
  })
})
