/**
 * 内网直连的判据与登记。
 *
 * 这份里有一条**真 socket** 测试(最后一个 describe),而它才是这个功能的存在证明:
 * 前面所有的断言都只证明「我们往一个字符串里塞了几个主机名」,证明不了「Bun 的 fetch
 * 真的会因此绕过代理」。而后者恰恰是整件事唯一的赌注 —— 假如 Bun 哪天不再每次请求
 * 现读 NO_PROXY,前面的测试会全绿,功能会全废。
 */
import { describe, expect, it } from 'bun:test'
import { hostOf, isLanHost, proxyRouteNote, registerDirectHosts } from './lanDirect.js'
import { buildRoleFetch } from '../services/api/openaiCompat/roleFetch.js'

describe('isLanHost', () => {
  it('认本机', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0']) {
      expect(isLanHost(h)).toBe(true)
    }
  })

  it('认 RFC1918 三段私网', () => {
    for (const h of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.9.9', '192.168.1.7']) {
      expect(isLanHost(h)).toBe(true)
    }
  })

  it('172.x 只在 16~31 段内算私网', () => {
    expect(isLanHost('172.15.0.1')).toBe(false)
    expect(isLanHost('172.32.0.1')).toBe(false)
  })

  it('认 Tailscale/CGNAT 的 100.64/10 —— 「另一台机器上的模型服务」最常见的地址', () => {
    expect(isLanHost('100.64.0.1')).toBe(true)
    expect(isLanHost('100.127.255.1')).toBe(true)
    expect(isLanHost('100.63.0.1')).toBe(false)
    expect(isLanHost('100.128.0.1')).toBe(false)
  })

  it('认链路本地与 IPv6 ULA', () => {
    expect(isLanHost('169.254.1.1')).toBe(true)
    expect(isLanHost('fd12:3456::1')).toBe(true)
    expect(isLanHost('fc00::1')).toBe(true)
    expect(isLanHost('fe80::1')).toBe(true)
    expect(isLanHost('::1')).toBe(true)
  })

  /**
   * **公网 IPv6 不许被当成内网。**
   *
   * 评审实测出来的 P0:裸主机名兜底是「不含点就算内网」,而 IPv6 地址恰恰不含点 ——
   * 于是 Google/Cloudflare 的公共 DNS 会被写进 NO_PROXY 并随 process.env 传给每个
   * 子进程(curl 认这种裸写法),对这些地址的出网**真的**绕过了公司代理。
   */
  it('公网 IPv6 一律不碰', () => {
    for (const h of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', 'ff02::1']) {
      expect(`${h} 被判成内网: ${isLanHost(h)}`).toBe(`${h} 被判成内网: false`)
    }
  })

  it('IPv4 映射地址按它映射的那个 IPv4 判', () => {
    // WHATWG 会把 ::ffff:192.168.1.7 归一成 ::ffff:c0a8:107,两种写法都要认。
    expect(isLanHost('::ffff:c0a8:107')).toBe(true)     // 192.168.1.7
    expect(isLanHost('::ffff:192.168.1.7')).toBe(true)
    expect(isLanHost('::ffff:808:808')).toBe(false)     // 8.8.8.8
    expect(isLanHost('::ffff:8.8.8.8')).toBe(false)
  })

  it('认内网域名后缀和裸主机名', () => {
    expect(isLanHost('nas.local')).toBe(true)
    expect(isLanHost('gpu.lan')).toBe(true)
    expect(isLanHost('llm.internal')).toBe(true)
    expect(isLanHost('gpu-box')).toBe(true)
  })

  it('公网地址一律不碰 —— 悄悄给它直连只会绕过公司的出网审计', () => {
    for (const h of ['api.openai.com', 'api.anthropic.com', '8.8.8.8', '1.1.1.1', '203.0.113.7']) {
      expect(isLanHost(h)).toBe(false)
    }
  })
})

describe('hostOf', () => {
  it('取主机名,IPv6 去掉方括号 —— NO_PROXY 那侧比的是裸地址', () => {
    expect(hostOf('http://192.168.1.7:8000/v1')).toBe('192.168.1.7')
    expect(hostOf('http://[::1]:8000/v1')).toBe('::1')
    expect(hostOf('https://API.Example.COM/v1')).toBe('api.example.com')
  })

  it('不是 URL 就返回 undefined,而不是抛', () => {
    expect(hostOf(undefined)).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
    expect(hostOf('不是地址')).toBeUndefined()
  })
})

describe('registerDirectHosts', () => {
  it('把内网主机加进 NO_PROXY,两个大小写都写', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://proxy:8080' }
    expect(registerDirectHosts(['http://192.168.1.7:8000/v1'], env)).toEqual(['192.168.1.7'])
    expect(env.NO_PROXY).toBe('192.168.1.7')
    expect(env.no_proxy).toBe('192.168.1.7')
  })

  it('保留已有条目,追加而不是覆盖', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: 'example.com', HTTPS_PROXY: 'http://p:1' }
    registerDirectHosts(['http://10.0.0.5:11434'], env)
    expect(env.NO_PROXY).toBe('example.com,10.0.0.5')
  })

  it('幂等:同一个主机登记两次只出现一次', () => {
    const env: Record<string, string | undefined> = {}
    registerDirectHosts(['http://10.0.0.5:11434'], env)
    registerDirectHosts(['http://10.0.0.5:9999/other'], env)
    expect(env.NO_PROXY).toBe('10.0.0.5')
  })

  it('一次调用里的重复也只加一条', () => {
    const env: Record<string, string | undefined> = {}
    registerDirectHosts(['http://10.0.0.5:1', 'http://10.0.0.5:2'], env)
    expect(env.NO_PROXY).toBe('10.0.0.5')
  })

  it('公网地址不加 —— 这是这个功能的边界', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://p:1' }
    expect(registerDirectHosts(['https://api.openai.com/v1'], env)).toEqual([])
    expect(env.NO_PROXY).toBeUndefined()
  })

  it('NO_PROXY=* 时什么都不加(已经全直连了)', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: '*' }
    expect(registerDirectHosts(['http://192.168.1.7:8000'], env)).toEqual([])
    expect(env.NO_PROXY).toBe('*')
  })

  it('没配代理也照样登记 —— NO_PROXY 要跟着环境传给子进程', () => {
    const env: Record<string, string | undefined> = {}
    expect(registerDirectHosts(['http://192.168.1.7:8000'], env)).toEqual(['192.168.1.7'])
  })

  it('读回时小写比较,大小写不同的同一个主机不重复加', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: 'NAS.LOCAL' }
    expect(registerDirectHosts(['http://nas.local:8000'], env)).toEqual([])
  })

  it('IPv6 两种写法都写进去 —— 一种给 fetch,一种给 curl 系', () => {
    // 实测:Bun 的 fetch 只认带方括号的,curl 只认裸的。而这一个环境变量同时要服务
    // 本进程和继承它的每一个子进程 —— 只写一种,功能在其中一侧完全不成立。
    const env: Record<string, string | undefined> = {}
    expect(registerDirectHosts(['http://[fd00::1]:8000/v1'], env)).toEqual(['fd00::1'])
    expect(env.NO_PROXY).toContain('fd00::1')
    expect(env.NO_PROXY).toContain('[fd00::1]')
  })

  it('只写了一种写法时,另一种要补上', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: 'fd00::1' }
    expect(registerDirectHosts(['http://[fd00::1]:8000/v1'], env)).toEqual(['fd00::1'])
    expect(env.NO_PROXY).toContain('[fd00::1]')
  })

  it('两份大小写取值不同时取并集 —— 不能把用户写在另一份里的条目删掉', () => {
    // 一份来自 shell 的 profile、一份来自 settings.json,取值不同是真实存在的。
    const env: Record<string, string | undefined> = { NO_PROXY: 'corp-a.example.com', no_proxy: 'corp-b.example.com' }
    registerDirectHosts(['http://10.0.0.5:11434'], env)
    expect(env.NO_PROXY).toContain('corp-a.example.com')
    expect(env.NO_PROXY).toContain('corp-b.example.com')
    expect(env.NO_PROXY).toContain('10.0.0.5')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })
})

describe('proxyRouteNote', () => {
  it('没配代理时一个字都不说', () => {
    expect(proxyRouteNote('http://192.168.1.7:8000', {})).toBe('')
  })

  it('走代理时点名代理地址 —— 连不上时这是第一手线索', () => {
    const note = proxyRouteNote('https://api.example.com/v1', { HTTPS_PROXY: 'http://proxy:8080' })
    expect(note).toContain('proxy:8080')
  })

  it('已登记直连时明说没经过代理', () => {
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '192.168.1.7' }
    expect(proxyRouteNote('http://192.168.1.7:8000/v1', env)).toContain('直连')
  })

  it('认后缀写法 —— 自己写一份精确匹配会把诊断印反', () => {
    // 用户写 .corp.example.com 时 gw.corp.example.com 实际直连,而一份精确匹配的判据
    // 会说「本次请求经由代理 …」—— 一条把人往错方向带的诊断,比不写更糟。
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '.corp.example.com' }
    expect(proxyRouteNote('https://gw.corp.example.com/v1', env)).toContain('直连')
  })

  it('两份大小写只有一份命中也算直连', () => {
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: '10.0.0.5', no_proxy: 'other.example.com' }
    expect(proxyRouteNote('http://10.0.0.5:1/v1', env)).toContain('直连')
  })
})

/**
 * 真 socket:代理指向一个**死端口**,目标是本机的一个真服务。
 *
 * 不登记直连 → Bun 把请求塞给死代理 → 连不上;登记之后 → 直连拿到 200。
 * 两条断言缺一不可:只测后者的话,一个「NO_PROXY 根本没被读」的世界里它照样绿
 * (因为那时候代理压根没生效)。
 *
 * ## 为什么要**另起一个进程**
 *
 * 实测(Bun 1.3.14):`HTTP_PROXY` 一旦在这个进程里被设过,就**再也拿不掉** ——
 * `delete process.env.HTTP_PROXY` 和赋空串都不管用,之后每一次 fetch 照样走那个代理。
 * 而 `bun test` 把所有测试文件跑在同一个进程里:在本进程里设代理,等于把后面每一个
 * 用真 socket 的测试(roleFetchSocket 那一整份)一起打死 —— 实测正是 9 条红。
 *
 * 所以这条探针在子进程里跑。代价是一次 bun 启动(~100ms),换来的是「测的是真的
 * 环境变量行为」而不是「测一个我们自己造的替身」。
 */
describe('真 socket:有代理时内网直连', () => {
  /** 在一个干净的子进程里跑一段脚本,拿回它打印的那行 JSON。 */
  const probe = async (body: string): Promise<Record<string, unknown>> => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/lanDirect-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const file = `${dir}/probe.ts`
    await Bun.write(file, body)
    const proc = Bun.spawn([process.execPath, 'run', file], {
      env: {
        ...process.env,
        // 9 号端口(discard)在本机上不会有人监听 —— 一个必然连不上的代理。
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        // 基线是「匹配不上的值」,不是删掉:删过之后 fetch 的代理判定就再也读不到
        // 后续赋值了(同一族的坑,见 lanDirect.ts 文件头)。
        NO_PROXY: 'no-such-host.invalid',
        no_proxy: 'no-such-host.invalid',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    const line = out.trim().split('\n').filter(Boolean).pop()
    if (!line) throw new Error(`子进程没有输出。stderr: ${err}`)
    return JSON.parse(line) as Record<string, unknown>
  }

  const SRC = new URL('./lanDirect.ts', import.meta.url).pathname
  const ROLE_FETCH = new URL('../services/api/openaiCompat/roleFetch.ts', import.meta.url).pathname
  const MCP_CLIENT = new URL('../services/mcp/client.ts', import.meta.url).pathname
  const CONFIG = new URL('./config.ts', import.meta.url).pathname
  // 探针跑在 /tmp 里,裸包名解析不到 —— 走绝对路径。
  const SDK = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm', import.meta.url).pathname

  it('登记之前打不通、登记之后打得通', async () => {
    const r = await probe(`
      import { registerDirectHosts } from '${SRC}'
      const srv = Bun.serve({ port: 0, fetch: () => new Response('ok') })
      const url = \`http://127.0.0.1:\${srv.port}/ping\`
      let before = 'connected'
      try { await fetch(url) } catch (e) { before = 'failed' }
      const added = registerDirectHosts([url])
      let after = 'failed', body = ''
      try { const res = await fetch(url); after = String(res.status); body = await res.text() } catch {}
      srv.stop(true)
      console.log(JSON.stringify({ before, added, after, body }))
    `)
    // 这一条是整个功能的前提:Bun 确实会把 127.0.0.1 也塞给代理。
    expect(r.before).toBe('failed')
    expect(r.added).toEqual(['127.0.0.1'])
    expect(r.after).toBe('200')
    expect(r.body).toBe('ok')
  })

  /**
   * IPv6 内网端点。**必须单独测**,因为它和 IPv4 走的不是同一条判据:
   * Bun 的 fetch 只认 `NO_PROXY` 里**带方括号**的写法,而 `hostOf` 交出来的是裸地址 ——
   * 只登记裸的话,这个功能对 IPv6 完全不成立,而它看起来是配好了的(评审实测)。
   */
  it('IPv6 内网端点同样能从代理后面直连出去', async () => {
    const r = await probe(`
      import { registerDirectHosts } from '${SRC}'
      const srv = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('ok-v6') })
      const url = \`http://[::1]:\${srv.port}/x\`
      let before = 'connected'
      try { await fetch(url) } catch { before = 'failed' }
      const added = registerDirectHosts([url])
      let after = 'failed', body = ''
      try { const res = await fetch(url); after = String(res.status); body = await res.text() } catch {}
      srv.stop(true)
      console.log(JSON.stringify({ before, added, after, body, noProxy: process.env.NO_PROXY }))
    `)
    expect(r.before).toBe('failed')
    expect(r.added).toEqual(['::1'])
    expect(r.after).toBe('200')
    expect(r.body).toBe('ok-v6')
    // 两种写法都在:一种给本进程的 fetch,一种给继承 env 的子进程(curl 系只认裸的)。
    expect(String(r.noProxy)).toContain('[::1]')
    expect(String(r.noProxy)).toContain(',::1')
  })

  it('翻译层(buildRoleFetch)对内网端点在构造时就登记好', async () => {
    const r = await probe(`
      import { buildRoleFetch } from '${ROLE_FETCH}'
      const sse = 'data: ' + JSON.stringify({ id: 'x', choices: [{ delta: { role: 'assistant', content: 'hi' } }] }) + '\\n\\n'
        + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n' + 'data: [DONE]\\n\\n'
      const srv = Bun.serve({ port: 0, fetch: () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) })
      const f = buildRoleFetch({
        apiProtocol: 'openai', apiUrl: \`http://127.0.0.1:\${srv.port}/v1\`,
        apiToken: 'sk', backendModel: 'gpt-4o', roleName: '员工甲',
      })
      // 构造时就该把这台主机登记进去 —— 请求还没发出去。
      const registeredAtBuild = String(process.env.NO_PROXY ?? '').includes('127.0.0.1')
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: new Headers({ 'anthropic-version': '2023-06-01' }),
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 8 }),
      })
      srv.stop(true)
      console.log(JSON.stringify({ registeredAtBuild, status: res.status }))
    `)
    expect(r.registeredAtBuild).toBe(true)
    expect(r.status).toBe(200)
  })

  /**
   * **MCP 的 http/sse 端点走同一条规矩。**
   *
   * 这条是用户报的原话「mcp 加载失败……两个 http、一个 stdio,都是失败」查出来的:一台
   * 开着 `HTTPS_PROXY` 的机器上,Bun 的 fetch 连 127.0.0.1 都塞给代理,于是本机 / 内网的
   * MCP 服务器一律 ✗ Failed to connect,而 stdio 那个照常连上(它不走 fetch)。
   *
   * 断在 `connectToServer` 这一层,不是断 registerDirectHosts:后者早就是对的,坏的是
   * **没有人为 MCP 调它** —— 角色端点(roleFetch)、init 都调了,唯独 MCP 这条路没有。
   * 这正是这个仓库反复出现的那种「实现了、测试了、就是没接线」。
   */
  it('MCP 的 http 端点在有代理时也能直连出去', async () => {
    const r = await probe(`
      import { connectToServer } from '${MCP_CLIENT}'
      import { enableConfigs } from '${CONFIG}'
      import { Server } from '${SDK}/server/index.js'
      import { StreamableHTTPServerTransport } from '${SDK}/server/streamableHttp.js'
      import { ListToolsRequestSchema } from '${SDK}/types.js'
      import http from 'node:http'
      enableConfigs()
      const transports = {}
      const srv = http.createServer(async (req, res) => {
        const sid = req.headers['mcp-session-id']
        let t = sid ? transports[sid] : undefined
        if (!t) {
          t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => 's1',
            onsessioninitialized: id => { transports[id] = t },
          })
          const s = new Server({ name: 'probe', version: '1' }, { capabilities: { tools: {} } })
          s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
          await s.connect(t)
        }
        let body
        if (req.method === 'POST') {
          const chunks = []
          for await (const c of req) chunks.push(c)
          try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch {}
        }
        await t.handleRequest(req, res, body)
      })
      await new Promise(r => srv.listen(0, '127.0.0.1', () => r()))
      const url = \`http://127.0.0.1:\${srv.address().port}/mcp\`
      const res = await connectToServer('probe', { type: 'http', url, scope: 'project' })
      console.log(JSON.stringify({ type: res.type, noProxy: process.env.NO_PROXY }))
      srv.close()
    `)
    // 接线断掉时这里是 'failed' —— 实测验证过(把那一句 registerDirectHosts 删掉再跑)。
    expect(r.type).toBe('connected')
    expect(String(r.noProxy)).toContain('127.0.0.1')
  })
})

/**
 * `NO_PROXY` 被 settings.env 整个盖掉之后要能自愈 —— 见 lanDirect.ts 的 REGISTERED。
 *
 * 用真的 `process.env`,因为记账只对它发生(注入 env 的调用方拿到的是纯函数行为,
 * 否则一条测试登记的主机会漏进另一条)。
 */
describe('被 settings.env 盖掉之后自愈', () => {
  it('下一次登记会把记过的主机补回去', () => {
    const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
    try {
      process.env.NO_PROXY = 'keep.example.com'
      process.env.no_proxy = 'keep.example.com'
      registerDirectHosts(['http://10.1.2.3:8000/v1'])
      expect(process.env.NO_PROXY).toContain('10.1.2.3')
      // settings.env 用 Object.assign 把它整个换掉(init.ts 会这么做两次)
      process.env.NO_PROXY = 'keep.example.com'
      process.env.no_proxy = 'keep.example.com'
      // 之后任何一次登记(哪怕是另一个员工的地址)都要把 10.1.2.3 补回来
      registerDirectHosts(['https://api.openai.com/v1'])
      expect(process.env.NO_PROXY).toContain('10.1.2.3')
    } finally {
      // 恢复:**赋值,不删** —— 删了之后 fetch 的代理判定就再也读不到后续的赋值了。
      process.env.NO_PROXY = saved.NO_PROXY ?? ''
      process.env.no_proxy = saved.no_proxy ?? ''
    }
  })
})

/**
 * IPv6 端点的**诊断**不能和关口自相矛盾。
 *
 * 复验实测出来的:内网 IPv6 真的直连了(真 socket 证过),而报错里印的是「本次请求
 * 经由代理 …」—— 两块屏幕对同一个端点给出相反的答案,而那句报错会把人往「查代理」的
 * 错方向带。病根在 `shouldBypassProxy`:它把**每一个**含 `:` 的条目都当成 host:port,
 * 而 IPv6 字面量必然含 `:`。
 */
describe('IPv6 的直连判定', () => {
  const env = (noProxy: string) => ({ HTTPS_PROXY: 'http://corp-proxy:3128', NO_PROXY: noProxy, no_proxy: noProxy })

  it('裸写法、方括号写法、带端口三种都认', () => {
    for (const np of ['fd00::5', '[fd00::5]', '[fd00::5]:8000', 'x,fd00::5,[fd00::5]']) {
      expect(`${np}: ${proxyRouteNote('http://[fd00::5]:8000/v1', env(np))}`).toContain('直连')
    }
  })

  it('端口对不上时不算直连 —— host:port 那条规矩对 IPv6 同样成立', () => {
    expect(proxyRouteNote('http://[fd00::5]:8000/v1', env('[fd00::5]:9999'))).toContain('经由代理')
  })

  it('别的 IPv6 地址不会被误判成同一个', () => {
    expect(proxyRouteNote('http://[2606:4700:4700::1111]/v1', env('fd00::5,[fd00::5]'))).toContain('经由代理')
  })
})
