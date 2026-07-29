import { describe, expect, it } from 'bun:test'
import { MAX_UPSTREAM_BODY, upstreamAdvice, upstreamBodyText, upstreamFailureMessage } from './upstreamError.js'

const base = { protocol: 'openai-responses', url: 'https://gw/v1/responses', status: 502, statusText: 'Bad Gateway', body: '' }

describe('upstreamBodyText', () => {
  it('空体明说是空的 —— 留白会让人以为上游说了什么而我们没转达', () => {
    expect(upstreamBodyText('')).toBe('(空)')
    expect(upstreamBodyText('   \n\t ')).toBe('(空)')
  })

  it('压掉换行 —— 这句话最终躺在一个 JSON 字符串字段里被原样打印', () => {
    expect(upstreamBodyText('a\nb\r\n  c')).toBe('a b c')
  })

  it('超长夹取,按码点不按 UTF-16 —— 半个代理对会变成一个乱码字符', () => {
    const long = '一'.repeat(MAX_UPSTREAM_BODY + 50)
    const out = upstreamBodyText(long)
    expect(Array.from(out).length).toBe(MAX_UPSTREAM_BODY + 1) // +1 = 省略号
    expect(out.endsWith('…')).toBe(true)
    const emoji = '👍'.repeat(MAX_UPSTREAM_BODY + 10)
    expect(upstreamBodyText(emoji)).not.toContain('�')
  })
})

describe('upstreamAdvice', () => {
  it('每一条都指向一个用户真能改的配置键', () => {
    // 这一层唯一能被用户修的东西就是 settings.json 里那几行,所以建议必须落在键名上。
    const keys = ['apiUrl', 'apiToken', 'apiProtocol', 'model']
    for (const status of [400, 401, 403, 404, 405, 422, 429, 500, 502, 503, 504]) {
      const a = upstreamAdvice({ status, protocol: 'openai-responses' })
      expect(`${status}: ${keys.some(k => a.includes(k))}`).toBe(`${status}: true`)
    }
  })

  it('502 的建议要点名「这个网关可能没有这条路由」—— 那才是空体 502 的头号原因', () => {
    const a = upstreamAdvice({ status: 502, protocol: 'openai-responses' })
    expect(a).toContain('/responses')
    // 而且要给出退路:多数第三方网关只实现了 chat/completions。
    expect(a).toContain('openai')
  })

  it('两条协议各自建议**对方**,不是各自建议自己', () => {
    expect(upstreamAdvice({ status: 404, protocol: 'openai-responses' })).toContain('openai')
    const chat = upstreamAdvice({ status: 404, protocol: 'openai' })
    expect(chat).toContain('/chat/completions')
    expect(chat).toContain('openai-responses')
  })

  it('notStreamed 压过状态码 —— 200 却不是流,和 200 成功是两件完全不同的事', () => {
    const a = upstreamAdvice({ status: 200, protocol: 'openai', notStreamed: true })
    expect(a).toContain('流式')
    // 走的不是 `status >= 500` 那一支,也不是兜底那一支。
    expect(a).not.toContain('网关自己出错')
  })
})

describe('upstreamFailureMessage', () => {
  it('谁、哪条协议、发到哪、上游说了什么、怎么办 —— 五样齐全', () => {
    const m = upstreamFailureMessage({ ...base, roleName: '评审员甲' })
    expect(m).toContain('评审员甲')
    expect(m).toContain('openai-responses')
    expect(m).toContain('https://gw/v1/responses')
    expect(m).toContain('502')
    expect(m).toContain('(空)')
    expect(m).toContain('可能原因')
  })

  it('没有员工名时不编一个 —— 「未知员工」比不写更让人迷惑', () => {
    const m = upstreamFailureMessage(base)
    expect(m).not.toContain('undefined')
    expect(m).not.toContain('「')
    expect(m.startsWith('员工(openai-responses 协议)')).toBe(true)
  })

  it('单行。这段字符串会被塞进 JSON 的字符串字段,换行在那里是两个转义字符', () => {
    const m = upstreamFailureMessage({ ...base, body: 'line1\nline2', roleName: 'x' })
    expect(m).not.toContain('\n')
  })

  it('notStreamed 时印的是**上游自己的**状态码,不是我们返回的 502', () => {
    // 用户会拿着这个码去查网关日志。写 502 而网关记的是 200,他就找不到那条记录。
    const m = upstreamFailureMessage({ ...base, status: 200, statusText: 'OK', notStreamed: true, body: '{"error":"no stream"}' })
    expect(m).toContain('200 OK 但不是 SSE')
    expect(m).not.toContain('502')
  })

  it('不带任何请求头 —— token 就在 authorization 里,而这句话会上屏、进 node.md', () => {
    const m = upstreamFailureMessage({ ...base, roleName: 'x' })
    expect(m.toLowerCase()).not.toContain('authorization')
    expect(m.toLowerCase()).not.toContain('bearer')
  })
})
