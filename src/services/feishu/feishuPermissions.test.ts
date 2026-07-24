import { describe, it, expect } from 'bun:test'
import { createFeishuPermissionCallbacks } from './feishuPermissions.js'

describe('createFeishuPermissionCallbacks', () => {
  it('routes resolve to the registered handler once', () => {
    const cb = createFeishuPermissionCallbacks()
    let got: any = null
    cb.onResponse('id1', r => { got = r })
    expect(cb.resolve('id1', { behavior: 'allow' })).toBe(true)
    expect(got).toEqual({ behavior: 'allow' })
  })
  it('is idempotent: second resolve for same id returns false', () => {
    const cb = createFeishuPermissionCallbacks()
    let calls = 0
    cb.onResponse('id1', () => { calls++ })
    cb.resolve('id1', { behavior: 'allow' })
    expect(cb.resolve('id1', { behavior: 'deny' })).toBe(false)
    expect(calls).toBe(1)
  })
  it('resolve for unknown id returns false', () => {
    const cb = createFeishuPermissionCallbacks()
    expect(cb.resolve('nope', { behavior: 'allow' })).toBe(false)
  })
  it('unsubscribe removes the handler', () => {
    const cb = createFeishuPermissionCallbacks()
    const unsub = cb.onResponse('id1', () => {})
    unsub()
    expect(cb.resolve('id1', { behavior: 'allow' })).toBe(false)
  })
})
