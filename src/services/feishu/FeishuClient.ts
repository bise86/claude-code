import { logError } from '../../utils/log.js'
import type { FeishuConfig } from './types.js'

export type CardActionEvent = { action: { value?: Record<string, unknown>; form_value?: Record<string, unknown> } }
type ClientImpl = { sendCard(card: object): Promise<string>; updateCard(messageId: string, card: object): Promise<void> }
type WsImpl = { start(): Promise<void>; close(): Promise<void> }
export type FeishuDeps = {
  makeClient(cfg: FeishuConfig): ClientImpl
  makeWs(cfg: FeishuConfig, onAction: (e: CardActionEvent) => void): WsImpl
}

function defaultDeps(): FeishuDeps {
  return {
    makeClient(cfg) {
      // 延迟 import，避免无头/未启用时加载 SDK
      const { Client } = require('@larksuiteoapi/node-sdk')
      const client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret })
      return {
        async sendCard(card) {
          const res = await client.im.message.create({
            params: { receive_id_type: cfg.receiveIdType },
            data: { receive_id: cfg.receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
          })
          return res.data?.message_id as string
        },
        async updateCard(messageId, card) {
          await client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } })
        },
      }
    },
    makeWs(cfg, onAction) {
      const { WSClient, EventDispatcher } = require('@larksuiteoapi/node-sdk')
      const ws = new WSClient({ appId: cfg.appId, appSecret: cfg.appSecret })
      const dispatcher = new EventDispatcher({}).register({
        'card.action.trigger': async (data: any) => {
          try { onAction({ action: data.action }) } catch (e) { logError(e) }  // ack 立即返回，业务异步
          return {}
        },
      })
      return { start: () => ws.start({ eventDispatcher: dispatcher }), close: async () => { /* ws.close?.() */ } }
    },
  }
}

export class FeishuClient {
  private client: ClientImpl; private ws: WsImpl; private handler: (e: CardActionEvent) => void = () => {}
  constructor(private cfg: FeishuConfig, deps: FeishuDeps = defaultDeps()) {
    this.client = deps.makeClient(cfg)
    this.ws = deps.makeWs(cfg, e => this.handler(e))
  }
  onCardAction(h: (e: CardActionEvent) => void) { this.handler = h }
  async connect() { await this.ws.start() }
  async close() { try { await this.ws.close() } catch (e) { logError(e) } }
  async sendCard(card: object): Promise<string> { return this.client.sendCard(card) }
  async updateCard(messageId: string, card: object): Promise<void> {
    try { await this.client.updateCard(messageId, card) } catch (e) { logError(e) }
  }
}
