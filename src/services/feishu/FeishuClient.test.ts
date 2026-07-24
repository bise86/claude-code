import { describe, it, expect } from 'bun:test'
import { FeishuClient } from './FeishuClient.js'

const cfg = { enabled: true, appId: 'a', appSecret: 's', receiveIdType: 'open_id' as const, receiveId: 'ou_1' }

function mockDeps() {
  const sent: any[] = []; let actionHandler: any
  const deps = {
    makeClient: () => ({
      sendCard: async (card: any) => { sent.push(card); return 'om_' + sent.length },
      updateCard: async () => {},
    }),
    makeWs: (_cfg: any, onAction: any) => { actionHandler = onAction; return { start: async () => {}, close: async () => {} } },
  }
  return { deps, sent, fire: (e: any) => actionHandler(e) }
}

describe('FeishuClient', () => {
  it('sendCard returns messageId and forwards card actions to onCardAction', async () => {
    const m = mockDeps()
    const c = new FeishuClient(cfg, m.deps)
    let received: any = null
    c.onCardAction(e => { received = e })
    await c.connect()
    const id = await c.sendCard({ any: 'card' })
    expect(id).toBe('om_1')
    m.fire({ action: { value: { requestId: 'r1', behavior: 'allow' } } })
    expect(received.action.value.requestId).toBe('r1')
  })
})
