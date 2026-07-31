/**
 * 有全局代理时,**内网地址自动直连**。
 *
 * ## 病是什么
 *
 * 一台开着 `HTTPS_PROXY` 的机器上,所有 fetch 都走代理 —— 包括指向 `192.168.1.7:8000`
 * 的员工端点。代理在公司/机场网络那一侧,它连不到用户自己的局域网,于是这条请求以
 * 「Unable to connect」收场,而那台机器上 `curl` 一下就通。用户看到的是「配了 roles 就
 * 用不了」,而真凶是一条他早就忘了的环境变量。
 *
 * 实测(Bun 1.3):
 *  - Bun 的 fetch **自己**读 `$HTTP_PROXY/$HTTPS_PROXY`,连 `127.0.0.1` 也照走代理;
 *  - `fetch(url, { proxy: undefined })` 和 `{ proxy: '' }` **都不能**绕开它;
 *  - 但 `NO_PROXY` 是**每次请求现读**的,而且**压得过显式的 `proxy` 选项** ——
 *    这是唯一一条对所有出网路径(SDK 的 fetchOptions、翻译层、MCP、飞书)同时生效的开关;
 *  - 匹配规则:精确主机名、`host:port`、逗号/空格分隔的列表、`*`;**不支持 CIDR**
 *    (`192.168.0.0/16` 一个都拦不住)。所以不能写网段,只能把**具体的主机名**加进去。
 *
 * 于是这个模块干的事就一句话:把配置里出现过的**内网端点主机名**登记进 `NO_PROXY`。
 *
 * ## 一条实测出来的地雷:**永远不要 `delete process.env.NO_PROXY`**
 *
 * Bun 1.3.14 上,`delete process.env.NO_PROXY` 之后再赋值,`process.env.NO_PROXY` 和
 * `Bun.env.NO_PROXY` 都能读回新值,但 **fetch 的代理判定再也看不到它** —— 那之后每一次
 * 请求都照走代理。从没删过的时候则是每次请求现读(改一次生效一次,实测三个来回)。
 *
 * 所以这里只做**赋值**,一次都不删;而 `lanDirect.test.ts` 里立基线用的是「设成一个
 * 匹配不上的值」而不是删掉它 —— 删了的话这个功能在测试里必然失效,而线上完全正常,
 * 那种假红比假绿更能骗人。
 *
 * 同一族的第二颗地雷:**`HTTP_PROXY` 一旦在一个进程里被设过就再也拿不掉**(delete 和
 * 赋空串都不管用,之后每次 fetch 照走那个代理)。所以任何「设一个假代理」的测试都必须
 * 另起进程 —— 在 `bun test` 的同一个进程里设一次,后面每一个用真 socket 的测试都会
 * 跟着连不上(实测一次打红 9 条)。
 *
 * ## 为什么是「登记主机名」而不是「失败后重试直连」
 *
 * 重试要先付一次超时(代理卡死时那是几十秒),而且第二次请求对一个**带写工具**的执行者
 * 来说不是幂等的 —— 上游可能已经收到了第一次。登记是在发出去之前就选对路,零代价。
 *
 * 反过来,**非内网地址一律不碰**:一个 `api.openai.com` 在公司网里本来就只能走代理,
 * 悄悄给它直连只会把「连不上」换成另一种「连不上」,还绕过了公司的出网审计。
 */

import { logForDebugging } from './debug.js'
import { getProxyUrl, shouldBypassProxy } from './proxy.js'

type EnvLike = Record<string, string | undefined>

/**
 * 一眼就是内网的域名后缀。
 *
 * `.local` 是 mDNS(打印机、NAS、`raspberrypi.local`),其余三个是 RFC 8375 /
 * 各家路由器出厂默认给的内网域。公网上不存在这些顶级域,所以判错的方向只有一个:
 * 一个**故意**要走代理的内网地址被直连了 —— 而那正是用户按下这个功能时要的。
 */
const LAN_SUFFIXES = ['.local', '.lan', '.internal', '.intranet', '.home', '.localdomain', '.home.arpa']

/** 十进制点分四段 → 四个数;不是这个形状就返回 undefined(域名走别的分支)。 */
function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const out: number[] = []
  for (const p of parts) {
    // `01` / `1e2` / `` 都不是合法的十进制段。严格判,免得把 `1.2.3.04` 之类的
    // 畸形串当成 IP 又算错网段。
    if (!/^\d{1,3}$/.test(p)) return undefined
    const n = Number(p)
    if (n > 255) return undefined
    out.push(n)
  }
  return out
}

/**
 * 这个主机名是不是**本机/局域网**。
 *
 * 覆盖的范围和它们各自的理由:
 *  - `localhost` / `127.0.0.0/8` / `::1` —— 本机跑的推理服务(ollama、vllm、各种网关);
 *  - `10/8`、`172.16/12`、`192.168/16`(RFC 1918)—— 家里和公司的局域网;
 *  - `100.64/10`(RFC 6598)—— 运营商级 NAT,**也是 Tailscale 的地址段**,而
 *    「另一台机器上的模型服务」这个场景里 Tailscale 极常见;
 *  - `169.254/16` / `fe80::/10` —— 链路本地(直连网线、没有 DHCP 的现场);
 *  - `fc00::/7` —— IPv6 唯一本地地址,RFC 1918 的对应物;
 *  - 上面那几个内网域名后缀;
 *  - **不带点的裸主机名**(`nas`、`gpu-box`)—— 它只可能由本地 DNS / hosts /
 *    mDNS 解析,而代理是解析不了的。这一条是判得最松的一条,写在这里是因为
 *    「把 apiUrl 写成一台内网机器的主机名」是这个功能最常见的用法之一。
 */
export function isLanHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host.length === 0) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  /**
   * **IPv6 字面量在这里就判完,绝不许落到下面那条裸主机名兜底上。**
   *
   * 评审实测出来的 P0:兜底是「不含点就算内网」,而 IPv6 地址恰恰不含点 ——
   * `2001:4860:4860::8888`(Google 公共 DNS)、`2606:4700:4700::1111`(Cloudflare)
   * 全被判成内网,于是它们会被写进 `NO_PROXY` 并随 `process.env` 传给每个子进程。
   * curl 系认这种裸形式,所以 Bash 工具 / MCP / hook 里对这些地址的出网**真的**绕过了
   * 公司代理 —— 正是这个文件开头承诺「非内网地址一律不碰」要防的那件事。
   *
   * 判据:含 `:` 即 IPv6 字面量(主机名里不可能有冒号,端口在 URL 解析时就分掉了)。
   * 只放行回环、ULA(fc00::/7)、链路本地(fe80::/10),以及 `::ffff:` 映射进来的
   * 内网 IPv4;其余一律公网。
   */
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true
    // fc00::/7 = fc / fd 开头;fe80::/10 = fe8 / fe9 / fea / feb 开头。
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true
    // IPv4 映射地址(`::ffff:192.168.1.7`,WHATWG 会归一成 `::ffff:c0a8:107`)。
    // 拆出低 32 位再按 IPv4 判 —— 映射地址的语义就是「这是一个 IPv4 地址」。
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (mapped) {
      const hi = Number.parseInt(mapped[1]!, 16)
      const lo = Number.parseInt(mapped[2]!, 16)
      return isLanHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
    }
    if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isLanHost(host.slice('::ffff:'.length))
    return false
  }
  const v4 = ipv4Octets(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // 0.0.0.0 是「本机所有接口」,连出去时等价于本机。
    if (a === 0 && b === 0 && v4[2] === 0 && v4[3] === 0) return true
    return false
  }
  if (LAN_SUFFIXES.some(s => host.endsWith(s))) return true
  // 裸主机名(没有点)。IP 形状的串已经在上面判完了,走到这里的一定是名字。
  return !host.includes('.')
}

/** URL 串 → 主机名;`about:blank`、空串、手打错的地址一律返回 undefined。 */
export function hostOf(url: string | undefined): string | undefined {
  if (!url || url.trim().length === 0) return undefined
  try {
    const h = new URL(url).hostname.toLowerCase()
    // WHATWG 的 IPv6 hostname 带方括号(`[::1]`),而 NO_PROXY 那侧比的是裸地址。
    return h.replace(/^\[|\]$/g, '') || undefined
  } catch {
    return undefined
  }
}

/**
 * 一个主机要往 `NO_PROXY` 里写**几种写法**。
 *
 * IPv4 一种就够。**IPv6 必须两种都写**,这条是评审用真 socket 量出来的:
 *  - Bun 的 fetch 只认**带方括号**的(`NO_PROXY=[::1]` → 直连;`NO_PROXY=::1` → 照走代理);
 *  - curl 恰好相反,只认裸的(`no_proxy=::1` → 直连;`[::1]` → 走代理)。
 *
 * 而这一个环境变量同时要服务两边:本进程的 fetch,以及继承 env 的每一个子进程
 * (Bash 工具、MCP server、hook)。只写一种的话,IPv6 内网端点这个功能在其中一侧
 * **完全不成立** —— 而它看起来是配好了的。
 */
function noProxyForms(host: string): string[] {
  return host.includes(':') ? [host, `[${host}]`] : [host]
}

/**
 * 已经在 NO_PROXY 里的条目(小写、去空)。`*` 单独判 —— 那是「全部直连」。
 *
 * **取 `NO_PROXY` 和 `no_proxy` 的并集**,不是 `getNoProxy` 的「小写优先」。
 * 两者取值不同是真实存在的(一个来自 shell 的 profile、一个来自 settings.json),而
 * 只读其中一份、再把结果**同时写回两份**,等于把用户写在另一份里的条目静默删掉 ——
 * 评审实测:`NO_PROXY=corp-a` + `no_proxy=corp-b` 登记一次之后,corp-a 消失。
 */
function noProxyEntries(env: EnvLike): { all: boolean; set: Set<string> } {
  const raw = [env.no_proxy, env.NO_PROXY].filter(v => typeof v === 'string' && v.length > 0).join(',')
  const list = raw.split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  return { all: list.includes('*'), set: new Set(list) }
}

/**
 * 这个进程里已经登记过的内网主机。
 *
 * 存在的理由是 `NO_PROXY` **会被别人整个盖掉**:`applyConfigEnvironmentVariables()` 用
 * `Object.assign(process.env, settings.env)` 应用 settings 里的 env,而它在远端托管设置
 * 载入之后还会**再跑一次**(init.ts 的 telemetry 那一段)—— 一个在 settings.json 里写了
 * `NO_PROXY` 的用户,会让我们启动时登记的那几条在几百毫秒后无声消失。
 *
 * 所以每一次调用都顺手把记过的补回去。只对 `process.env` 记账 —— 注入自己 env 的调用方
 * (测试)拿到的是纯函数行为,否则一条测试登记的主机会漏进另一条。
 */
const REGISTERED = new Set<string>()

/**
 * 把这些 URL 里的内网主机登记进 `NO_PROXY`,返回**这次新加的**主机名。
 *
 * 幂等:已经在里面的不重复加。`NO_PROXY=*` 时一个都不加(已经全直连了)。
 *
 * **没有配代理时照样登记。** 理由是代价为零而收益不是:`NO_PROXY` 会跟着
 * `process.env` 传给子进程(MCP server、hook、`claude` 自己起的子 agent),而那些进程
 * 里完全可能有自己的代理配置;等到"发现有代理"才登记,就要求登记发生在每一次请求之前,
 * 那是一个多余的时序约束。
 *
 * 写 `process.env` 是**故意**的:这是唯一一个对 Bun 原生 fetch、undici、axios 三条
 * 出网路径同时生效的开关(见文件头)。
 */
export function registerDirectHosts(
  urls: Iterable<string | undefined>,
  env: EnvLike = process.env,
): string[] {
  const { all, set } = noProxyEntries(env)
  if (all) return []
  const remembered = env === (process.env as EnvLike)
  const wanted: string[] = []
  for (const u of urls) {
    const host = hostOf(u)
    if (!host || !isLanHost(host)) continue
    if (remembered) REGISTERED.add(host)
    wanted.push(host)
  }
  // 记过的一并补回去 —— 见 REGISTERED 的注释:这一行是「被 settings 盖掉之后自愈」的全部。
  if (remembered) for (const h of REGISTERED) wanted.push(h)
  const added: string[] = []
  /** 真正写进环境变量的串(IPv6 要两种写法,见 noProxyForms)。 */
  const entries: string[] = []
  for (const host of wanted) {
    if (added.includes(host)) continue
    const forms = noProxyForms(host).filter(f => !set.has(f))
    // 两种写法都已经在里面了才算「不用加」—— 只有一种在的话,另一侧(fetch 或 curl)
    // 仍然会走代理,而那正是这个功能要解决的事。
    if (forms.length === 0) continue
    added.push(host)
    entries.push(...forms)
  }
  if (added.length === 0) return []
  // 并集里两份可能不一样,写回去的那一份必须**包含两份的全部条目**,否则这次登记
  // 顺手删掉用户写在另一份里的东西(见 noProxyEntries)。
  const prev = [...set].join(',')
  const next = [prev, ...entries].filter(v => v !== undefined && v.length > 0).join(',')
  /**
   * **两个大小写都写。**
   *
   * `getNoProxy` 读的是 `no_proxy || NO_PROXY`,而 undici 的 `EnvHttpProxyAgent`
   * 只认构造时传进去的那一份、Bun 两个都认、别的库各认各的。只写一个的另一个会留着
   * 旧值,而「哪一个生效」在不同库里答案不同 —— 那种不一致查起来要人命。
   */
  env.NO_PROXY = next
  env.no_proxy = next
  logForDebugging(
    `[lan-direct] 内网端点将绕过代理直连: ${added.join(', ')}` +
    (getProxyUrl(env) ? ` (当前代理 ${getProxyUrl(env)})` : ' (当前未配置代理)'),
  )
  return added
}

/**
 * 这次请求**走的是代理还是直连** —— 只给报错信息用。
 *
 * 连不上的时候,「经由代理 http://x」和「已直连」是两条完全不同的排查路径,而用户手上
 * 唯一的线索就是那句报错。此前它一个字都没提代理,于是最常见的真因(代理连不到内网)
 * 恰好是最难想到的那一个。
 */
export function proxyRouteNote(url: string, env: EnvLike = process.env): string {
  const proxy = getProxyUrl(env)
  if (!proxy) return ''
  /**
   * 判「这次走不走代理」用 `shouldBypassProxy`,**不是**自己比一遍精确相等。
   *
   * 那个函数是仓库里既有的那份真相:它认后缀写法(`.corp.example.com`)、`host:port`、
   * 通配 `*`。自己写一份精确匹配的后果是**印反**:用户写了 `.corp.example.com`,
   * `gw.corp.example.com` 实际直连,而报错里说「本次请求经由代理 …」—— 一条把人往
   * 错方向带的诊断,比不写更糟。
   *
   * 传的是**并集**而不是 `getNoProxy()` 的默认值:两份大小写可能不一致(见 noProxyEntries)。
   */
  const both = [env.no_proxy, env.NO_PROXY].filter(v => typeof v === 'string' && v.length > 0).join(',')
  if (shouldBypassProxy(url, both || undefined)) return `(该地址已按内网直连处理,未经代理)`
  return `(本次请求经由代理 ${proxy};若该地址在内网,代理很可能到不了它)`
}

/** 仅供测试:忘掉登记过的主机。见 REGISTERED —— 它对 `process.env` 有持久副作用。 */
export function _resetRegisteredForTesting(): void {
  REGISTERED.clear()
}
