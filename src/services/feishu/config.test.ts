import { describe, it, expect } from 'bun:test'
import { getFeishuConfig } from './config.js'

describe('getFeishuConfig', () => {
  it('returns null when feishu block absent', () => {
    expect(getFeishuConfig({} as any)).toBeNull()
  })
  it('returns null when enabled but missing receiveId', () => {
    expect(getFeishuConfig({ feishu: { enabled: true, appId: 'a', appSecret: 's' } } as any)).toBeNull()
  })
  it('parses a complete config with defaults', () => {
    const c = getFeishuConfig({ feishu: { enabled: true, appId: 'a', appSecret: 's', receiveId: 'ou_1' } } as any)
    expect(c).toEqual({ enabled: true, appId: 'a', appSecret: 's', receiveIdType: 'open_id', receiveId: 'ou_1' })
  })
  it('returns null when enabled is false', () => {
    expect(getFeishuConfig({ feishu: { enabled: false, appId: 'a', appSecret: 's', receiveId: 'ou_1' } } as any)).toBeNull()
  })
})
