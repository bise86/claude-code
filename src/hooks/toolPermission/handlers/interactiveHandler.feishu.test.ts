import { describe, it, expect } from 'bun:test'
import { makeFeishuRacer } from './interactiveHandler.js'

function harness() {
  const patched: any[] = []
  const client = {
    sendCard: async () => 'om_1',
    updateCard: async (id: string, card: any) => { patched.push({ id, card }) },
  }
  const onResp: Record<string, (r: any) => void> = {}
  const callbacks = {
    onResponse: (id: string, h: any) => { onResp[id] = h; return () => { delete onResp[id] } },
    resolve: (id: string, r: any) => { onResp[id]?.(r); return true },
  }
  return { patched, client, callbacks, fire: (id: string, r: any) => callbacks.resolve(id, r) }
}

describe('makeFeishuRacer', () => {
  it('feishu wins → resolveOnce called, terminal/others cleaned via provided teardown', async () => {
    const h = harness(); const cleaned: string[] = []; let resolved: any = null
    const racer = makeFeishuRacer({
      requestId: 'r1', cardData: { requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' },
      client: h.client as any, callbacks: h.callbacks as any, questionsById: new Map(),
      claim: () => true, resolveOnce: (d: any) => { resolved = d },
      buildAllow: (i: any) => ({ behavior: 'allow', input: i }), cancelAndAbort: () => ({ behavior: 'deny' }),
      teardownOthers: () => { cleaned.push('others') },
    })
    await racer.start()
    h.fire('r1', { behavior: 'allow', updatedInput: { x: 1 } })
    expect(resolved).toEqual({ behavior: 'allow', input: { x: 1 } })
    expect(cleaned).toContain('others')
  })

  it('terminal wins before messageId arrives → compensation patch after sendCard resolves', async () => {
    const h = harness()
    let resolveSend: (id: string) => void = () => {}
    h.client.sendCard = () => new Promise<string>(res => { resolveSend = res })  // 卡片发送悬挂
    const racer = makeFeishuRacer({
      requestId: 'r1', cardData: { requestId: 'r1', toolName: 'Bash', summary: 'ls', kind: 'buttons' },
      client: h.client as any, callbacks: h.callbacks as any, questionsById: new Map(),
      claim: () => true, resolveOnce: () => {}, buildAllow: (i: any) => i, cancelAndAbort: () => ({}), teardownOthers: () => {},
    })
    await racer.start()
    racer.syncOnResolved('terminal', 'allow')  // 终端先胜，messageId 尚未到
    expect(h.patched.length).toBe(0)           // 还没 patch（无 messageId）
    resolveSend('om_1'); await Promise.resolve(); await Promise.resolve()
    expect(h.patched.length).toBe(1)           // messageId 到手后补偿 patch
    expect(JSON.stringify(h.patched[0].card)).toContain('已允许')
  })
})
