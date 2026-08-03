import { describe, expect, it } from 'bun:test'
import { looksLikeContextOverflow, MAX_UPSTREAM_BODY, upstreamAdvice, upstreamBodyText, upstreamFailureMessage } from './upstreamError.js'

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

describe('上下文超了要单独说', () => {
  const bodies = [
    '{"error":{"message":"This model\'s maximum context length is 32768 tokens, however you requested 41000 tokens","code":"context_length_exceeded"}}',
    '{"error":{"message":"prompt is too long: 137500 tokens > 135000 maximum"}}',
    '{"error":{"message":"Please reduce the length of the messages."}}',
    '{"error":{"message":"输入超出模型上下文长度限制"}}',
    '{"error":{"message":"input tokens exceed the configured limit"}}',
  ]

  it('认得各家的写法', () => {
    for (const b of bodies) expect(looksLikeContextOverflow(b)).toBe(true)
  })

  it('不把普通的请求体错误当成上下文超限', () => {
    for (const b of [
      '{"error":{"message":"model `gpt-5.9` does not exist"}}',
      '{"error":{"message":"unsupported parameter: temperature"}}',
      '',
    ]) {
      expect(looksLikeContextOverflow(b)).toBe(false)
    }
  })

  it('400 那一档换一条建议 —— 不能再让人去查 model 名', () => {
    for (const body of bodies) {
      const a = upstreamAdvice({ status: 400, protocol: 'openai', body })
      expect(a).toContain('contextWindow')
      // 「先查 model 写得对不对」正是这条分支要顶掉的那句话
      expect(a).not.toContain('先查 model')
    }
  })

  it('没有上下文字样时 400 的建议逐字不变', () => {
    const plain = upstreamAdvice({ status: 400, protocol: 'openai', body: '{"error":"bad request"}' })
    expect(plain).toBe(upstreamAdvice({ status: 400, protocol: 'openai' }))
  })

  it('整句话里带得上这条建议', () => {
    const msg = upstreamFailureMessage({
      roleName: 'K3', protocol: 'openai', url: 'https://gw/v1/chat/completions',
      status: 400, statusText: 'Bad Request', body: bodies[0]!,
    })
    expect(msg).toContain('contextWindow')
    expect(msg).toContain('员工「K3」')
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

  it('空体 5xx 和带内容的 5xx 给的是**不同**的建议', () => {
    /**
     * 上一版这里断言的是「502 的建议要点名『这个网关没有这条路由』—— 那才是空体 502 的
     * 头号原因」。**那句话是我编的**,评审用真 socket 戳穿了三处:
     *  - 网关缺路由的标准返回是 **404**,而代码里就有 404 那一支 —— 两档讲同一个原因;
     *  - 空体 502 在中转链路上真正常见的是「源站被 reset」和「首字节太慢被 CDN/LB 掐断」;
     *  - 那句话还是**无条件印**的:上游明明回了一段 nginx 的 502 页面,我们还在讲空体。
     */
    const empty = upstreamAdvice({ status: 502, protocol: 'openai-responses', emptyBody: true })
    const withBody = upstreamAdvice({ status: 502, protocol: 'openai-responses' })
    expect(empty).not.toBe(withBody)
    // 空体那一档:先说两个真常见的成因,并明说「没有这条路由通常回 404」而不是 502。
    expect(empty).toContain('重试')
    expect(empty).toContain('超时')
    expect(empty).toContain('404')
    // 有内容那一档:第一句就是「照上游自己的说法排查」——它比我们的猜测靠谱。
    expect(withBody).toContain('它自己的说法')
    // 两档都不许再断言「最常见的原因是没有这条路由」。
    for (const a of [empty, withBody]) expect(a).not.toContain('最常见的原因是这个网关没有')
  })

  it('404 不再叫用户去做 joinRoute 已经自动做了的事', () => {
    /**
     * 老建议:「apiUrl 只写到 /v1 为止(别把 /responses 也写进去)」。而 `joinRoute` 现在
     * 会自动剥 —— 用户照做改完再试,发出去的地址一个字符都不变、症状分毫不差,
     * 然后他会认定这套建议不可信,后面几条也不再看。
     */
    const a = upstreamAdvice({ status: 404, protocol: 'openai-responses' })
    expect(a).not.toContain('别把')
    expect(a).toContain('自动归一')
    // 404 真正的成因是**路径前缀**,而各家差得远。
    expect(a).toContain('路径前缀')
    expect(a).toContain('/openai/v1')
  })

  it('连不上是单独一档 —— 它以前压根走不到', () => {
    // 异常直接穿过整个翻译层,用户拿到引擎的通用兜底「检查你的网络连接」,
    // 而他的网络是好的。
    const a = upstreamAdvice({ status: 0, protocol: 'openai', connectFailed: true })
    expect(a).toContain('域名')
    expect(a).toContain('代理')
    // 不能退化成那条 `status >= 500` 的话 —— 请求根本没发出去,谈不上「上游出错了」。
    expect(a).not.toContain('上游或它前面的网关自己出错')
  })

  it('两条协议各自建议**对方**,不是各自建议自己', () => {
    expect(upstreamAdvice({ status: 404, protocol: 'openai-responses' })).toContain('openai')
    const chat = upstreamAdvice({ status: 404, protocol: 'openai' })
    expect(chat).toContain('/chat/completions')
    expect(chat).toContain('openai-responses')
  })

  it('每一档都给得出一句非空的话 —— 包括没列进表里的状态码', () => {
    for (const status of [0, 200, 301, 418, 599]) {
      expect(upstreamAdvice({ status, protocol: 'openai' }).length).toBeGreaterThan(10)
    }
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
