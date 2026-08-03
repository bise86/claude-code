/**
 * 「认证失败」这一屏必须说实话。
 *
 * 两条真实错误(用户报的原话,来自两台真实的内网服务器):
 *
 *   SDK auth failed: HTTP 404: Invalid OAuth error response: […]. Raw body: {"detail":"Not Found"}
 *   SDK auth failed: Failed to parse JSON
 *
 * 而实测证明那两台服务器**根本不需要认证** —— 直接 POST 一次 initialize(甚至带一个瞎编的
 * Bearer)都返回 200 并正常握手。屏幕上那两句话把人送去查 token 和 OAuth,而真正的失败
 * 发生在**认证之前**那次连接,一个字都没印出来。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { describeOAuthFailure } from './auth.js'

/** FastAPI 对 /.well-known/oauth-authorization-server 的 404(用户那台 Rules 服务器)。 */
const FASTAPI_404 =
  'HTTP 404: Invalid OAuth error response: [{"expected":"string","code":"invalid_type",' +
  '"path":["error"],"message":"Invalid input: expected string, received undefined"}]. ' +
  'Raw body: {"detail":"Not Found"}'

/** 同一个路径被前端 SPA 接管,回了一坨 HTML(用户那台 Gitnexus 服务器)。 */
const SPA_HTML = 'Failed to parse JSON'

describe('没有 OAuth 元数据的服务器,不许报成「认证失败」', () => {
  it('FastAPI 的 404 → 说清「这台服务器没有 OAuth,多半不需要认证」', () => {
    const out = describeOAuthFailure(FASTAPI_404, 'http://10.10.20.13:8888/mcp/Go2Rust/')
    expect(out).toContain('没有 OAuth 元数据')
    expect(out).toContain('多半根本不需要认证')
    // 指向**真正的现场**:认证之前那次连接,以及它被记在哪。
    expect(out).toContain('在认证之前')
    expect(out).toContain('mcp-logs-')
    // 服务器的 origin 要点名 —— 否则用户不知道该去哪台机器上找。
    expect(out).toContain('http://10.10.20.13:8888')
    // 原文一并留着:诊断信息只能加,不能换掉。
    expect(out).toContain('Raw body: {"detail":"Not Found"}')
  })

  it('SPA 的 HTML → 同一句话(同一个现象,不同服务端框架的另一种长相)', () => {
    const out = describeOAuthFailure(SPA_HTML, 'http://10.10.20.13:4747/api/mcp/')
    expect(out).toContain('没有 OAuth 元数据')
    expect(out).toContain('http://10.10.20.13:4747')
    expect(out).toContain('Failed to parse JSON')
  })

  it('拿不到 URL 时也能说,只是不点名是哪台机器', () => {
    const out = describeOAuthFailure(SPA_HTML)
    expect(out).toContain('没有 OAuth 元数据')
    expect(out).toContain('/.well-known/oauth-*')
  })

  it('**真的**认证失败一个字都不改', () => {
    /**
     * 这一条是这个函数的安全边界:把一次真实的凭据错误改写成「这台服务器不需要认证」,
     * 比原来那句误导性的话更糟 —— 用户会停止排查一个真实存在的问题。
     */
    for (const real of [
      'OAuth error: invalid_grant - refresh token expired',
      'Authentication timeout',
      'OAuth state mismatch - possible CSRF attack',
      'HTTP 401: {"error":"invalid_token","error_description":"expired"}',
    ]) {
      expect(describeOAuthFailure(real, 'https://example.com/mcp')).toBe(real)
    }
  })

  it('404 之外的 HTTP 状态不算「没有元数据」', () => {
    // 500 是「有这个端点但它炸了」,和「压根没有这个端点」要给出不同的下一步。
    const raw = 'HTTP 500: internal error'
    expect(describeOAuthFailure(raw, 'https://example.com/mcp')).toBe(raw)
  })
})

/**
 * 结构闸门:这个函数**真的接在**那句话上。
 *
 * 变异测试实测存活过一次:把调用点换回 `errorMessage(error)`,上面五条全绿 —— 它们证明的是
 * 「这个函数算得对」,证明不了「屏幕上那句话是它算的」。而这条路要跑起来需要一台真的 OAuth
 * 服务器、一个真的浏览器回调和一个占住的端口,挂不起来,所以这一跳只能守文本。
 */
describe('接线不能被静默剪断', () => {
  it('SDK auth failed 那句话是 describeOAuthFailure 写的,而且带上了服务器 URL', () => {
    const src = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')
    expect(src).toContain('`SDK auth failed: ${describeOAuthFailure(errorMessage(error), serverConfig.url)}`')
    // 只此一处 —— 多一处裸的 errorMessage 拼进同一句话,就有一半的失败仍然说着假话。
    expect(src.split('`SDK auth failed: ').length - 1).toBe(1)
  })
})

/**
 * 结构闸门:**没有任何一条「不连就报需要认证」的判据**,除了真 401 留下的那条缓存。
 *
 * 守的是一个已经发生过的死锁:`hasMcpDiscoveryButNoToken`(「存过 OAuth 记录但手上没
 * token」→ 跳过连接)没有 TTL,而它的前提「这种状态下连过去必然 401」对一台**根本不需要
 * 认证**的服务器是假的。一次失败的认证写下一条没有 token 的记录,从此连接再也不会被发起 ——
 * 面板永远「需要认证」,而每次认证都失败成同样的样子。用户实测撞的就是这条:三台服务器
 * 在无 / 瞎编 / 空 Bearer 三种情况下全部 200 并正常握手,而客户端一次连接都没发过。
 *
 * 只能守文本:这一跳要真跑起来需要污染凭据存储 + 一台真服务器 + 一整轮 /mcp 连接批次。
 */
describe('不许有第二条「不连就报需要认证」的路', () => {
  it('跳过连接的判据只剩「真的收到过 401」那一条缓存', () => {
    const src = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
    // 那个函数彻底没了 —— 留着不用是更坏的一种:下一个人会把它接回去。
    expect(src).not.toContain('hasMcpDiscoveryButNoToken(name, config)')
    const skip = src.slice(src.indexOf('Skipping connection (cached needs-auth)') - 700, src.indexOf('Skipping connection (cached needs-auth)'))
    expect(skip).toContain('await isMcpAuthCached(name)')
  })

  it('auth.ts 里也不再导出它', () => {
    const src = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('export function hasMcpDiscoveryButNoToken')
  })
})
